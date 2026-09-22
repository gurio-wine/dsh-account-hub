/**
 * LobsterAI（有道龙虾）登录：本地回调服务器 + `authCode` 换 token。
 *
 * ## 与 `lobsterai2api` 的实现差异（有意为之）
 *
 * Go 侧是**两个进程 + 一个 `/tmp` 状态文件**：
 * `login.exe url` 起回调服务器后把 `{port,state,uuid,firstKeyfrom}` 落盘到
 * `/tmp/lb2api-login-state.json`，阻塞等待 `.result` 文件出现；
 * `login.exe poll` 再读那个文件取结果（由 `login.sh` 顺序驱动，
 * 中间还夹一个 `read -rp "按 y 继续"` 的人在环确认）。
 *
 * 本模块把这套编排**收进单个进程内的 Promise**：
 * 回调服务器收到 `code` 后**立即在本进程完成 exchange**，
 * 直接 `resolve` 结果。这样就没有跨进程状态文件、没有残留文件误判、
 * 没有 shell 与 python3 依赖 —— 而这三样正是 Go 侧最脆弱的环节
 * （`main.go:162-164` 专门写了清理上一轮残留的代码，就说明它踩过坑）。
 *
 * 骨架取自 `src/login.ts` 的 CodeArts OAuth 回调服务器（本插件已验证的模式），
 * 但没有 PKCE / DPoP —— LobsterAI 的 exchange 不要求它们。
 */

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_LOGIN_TIMEOUT_MS,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiAnonymousHeaders,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
  buildLobsteraiCredential,
  type LobsteraiCredential,
} from './lobsterai.js'
import type { LobsteraiProduct } from './lobsterai-product.js'

/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 一次登录流程的结果。 */
export interface LobsteraiLoginFlowResult {
  /** 已序列化的 `LobsteraiCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** `runLobsteraiLoginFlow` 接受的选项。 */
export interface LobsteraiLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 回调等待总超时（毫秒）；默认 10 分钟。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置；默认 LOBSTERAI。 */
  product?: LobsteraiProduct
}

/**
 * 登录会话状态。
 *
 * `uuid` / `firstKeyfrom` 由**客户端**生成并贯穿整个账号生命周期：
 * 它们不在服务端响应里，而是要在 exchange 时提交、并在之后**每次续期**时
 * 原样回传（见 `lobsteraiRefreshBody`）。因此必须随凭据持久化。
 */
export interface LobsteraiLoginSession {
  /** 安装 UUID（对齐 `main.go:166` `newUuid()`）。 */
  uuid: string
  /** 首次登录时间戳（毫秒字符串，对齐 `nowMillis()`）。 */
  firstKeyfrom: string
}

/** 生成一次性登录会话（uuid + firstKeyfrom）。 */
export function createLobsteraiLoginSession(nowMs: number = Date.now()): LobsteraiLoginSession {
  return { uuid: randomUUID(), firstKeyfrom: String(nowMs) }
}

/**
 * 构造 portal 登录 URL。
 *
 * 形态照抄 `main.go:225-228`：
 * `{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
 *
 * 三个 query 参数的语义：
 * - `source=electron` —— 声明登录来源是桌面客户端（portal 据此选择交互流程）；
 * - `redirect_uri` —— **必须**是 `http://127.0.0.1:{port}/auth/callback` 形态，
 *   登录页会校验（`main.go:223-225` 的注释明确记录了这一约束）；
 * - `state` —— 防 CSRF 的一次性随机串，回调时原样带回并比对。
 *
 * ⚠️ 用 `URL` + `searchParams` 而非手工拼字符串：`redirect_uri` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 * 但 hash 段（`#/login`）不能用 `URL.searchParams` 构造 —— 它属于 fragment，
 * 故这里显式拼装：路径 + hash + `?` + 编码后的 query。
 */
export function buildLobsteraiLoginUrl(
  port: number,
  state: string,
  product: LobsteraiProduct,
): string {
  const redirectUri = `http://127.0.0.1:${port}${LOBSTERAI_CALLBACK_PATH}`
  const query = new URLSearchParams({
    source: 'electron',
    redirect_uri: redirectUri,
    state,
  })
  return `${product.portalBase}/portal#/login?${query.toString()}`
}

/**
 * 用授权码换取凭据。
 *
 * 请求体**必须**含 5 个字段（对齐 `main.go:264-270`）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 * 其中 `uuid` 与 `firstKeyfrom` 来自 {@link LobsteraiLoginSession}，
 * `latestKeyfrom` 取当前时刻，`version` 用动态拉取的真值。
 *
 * 该端点**不需要** `Authorization` 头（换 token 时还没有 token）。
 *
 * @throws 当网络失败、信封 code 非 0、或响应缺 accessToken 时。
 */
export async function exchangeLobsteraiAuthCode(
  code: string,
  session: LobsteraiLoginSession,
  clientVersion: string,
  product: LobsteraiProduct,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LobsteraiCredential> {
  const body = {
    authCode: code,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: String(Date.now()),
    uuid: session.uuid,
    version: clientVersion,
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: lobsteraiAnonymousHeaders(product),
      body: JSON.stringify(body),
      signal: signalToUse,
    })
  } catch (error) {
    throw new Error(`LobsterAI exchange 网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`LobsterAI exchange 响应不是 JSON（HTTP ${response.status}）`)
  }

  const envelope = parseLobsteraiEnvelope(parsed)
  if (!envelope.ok) {
    throw new Error(`LobsterAI exchange 失败：${envelope.message}`)
  }

  const payload = parseLobsteraiTokenPayload(envelope.data)
  if (payload.accessToken.length === 0) {
    // 与 Go 的 `refresh_failed: no accessToken` 同理：没有令牌就没有可用的凭据，
    // 不能把半成品存进凭据库。
    throw new Error('LobsterAI exchange 响应缺少 accessToken')
  }

  return buildLobsteraiCredential(payload, {
    uuid: session.uuid,
    firstKeyfrom: session.firstKeyfrom,
    latestKeyfrom: body.latestKeyfrom,
  })
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(
  credential: LobsteraiCredential,
  loginUrl: string,
): LobsteraiLoginFlowResult {
  return {
    access: JSON.stringify(credential),
    // 与 Buddy 侧一致：无法解析过期时间时报告 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
    expires: lobsteraiCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isLobsteraiRefreshable(credential),
  }
}

/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的既有实现）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 一次「已准备、待完成」的登录会话（两段式的第一段产物）。
 *
 * 与 {@link runLobsteraiLoginFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 10 分钟」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface LobsteraiPendingLogin {
  /** 本地回调服务器实际监听的端口。 */
  port: number
  /** 展示给用户的 portal 登录 URL（含一次性 state）。 */
  loginUrl: string
  /** 等待用户在浏览器完成登录并换回凭据。 */
  awaitCredential(): Promise<LobsteraiLoginFlowResult>
  /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
  cancel(reason?: string): void
}

/**
 * {@link prepareLobsteraiLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type LobsteraiLoginPrepareOutcome =
  | { ok: true; session: LobsteraiPendingLogin }
  | { ok: false; error: 'login-in-progress'; message: string }

/** {@link prepareLobsteraiLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type LobsteraiLoginPrepareOptions =
  Omit<LobsteraiLoginFlowOptions, 'openBrowser'> & { product: LobsteraiProduct; clientVersion: string }

/**
 * 进行中的登录槽位（模块级，同一时间最多一个）。
 *
 * prepare 阶段会**占用一个本地监听端口**，而客户端的「新建账号」按钮可以被
 * 反复点击。没有互斥时每次点击都会起一个新的 loopback 服务器，
 * 点 N 次就有 N 个端口一直挂到 10 分钟超时。
 *
 * `'preparing'` 是**同步占位**：从进入临界区到回调服务器真正 listen 成功之间
 * 存在多个 await，若只在 listen 完成后才登记，并发的两次调用会双双通过判空
 * 检查、各自起一个监听（实测：3 次并发 prepare 全部成功、3 个端口）。
 * 故必须在**第一个 await 之前**同步占位。
 */
type LobsteraiLoginSlot = LobsteraiPendingLogin | 'preparing'

let activeLoginSlot: LobsteraiLoginSlot | undefined

/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export function hasActiveLobsteraiLogin(): boolean {
  return activeLoginSlot !== undefined
}

/**
 * 准备一次登录（两段式的第一段）：起本地回调服务器，返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link LobsteraiPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 重复点击由调用方把该错误提示给用户（「已有登录进行中」）。
 * 超时、成功、失败、{@link LobsteraiPendingLogin.cancel} 都会释放会话。
 *
 * 其余语义（`state` 校验、回调页 HTML、exchange 五字段、10 分钟超时）
 * 与原 `runLobsteraiLoginFlow` 完全一致。
 */
export async function prepareLobsteraiLogin(
  options: LobsteraiLoginPrepareOptions,
): Promise<LobsteraiLoginPrepareOutcome> {
  if (activeLoginSlot !== undefined) {
    return {
      ok: false,
      error: 'login-in-progress',
      message: '已有 LobsterAI 登录进行中，请先在浏览器完成或关闭该登录窗口',
    }
  }
  // 同步占位：本函数后面还有若干 await（listen、以及调用方的 await），
  // 不在此刻占住的话并发调用会同时通过上面的判空。
  activeLoginSlot = 'preparing'

  const fetcher = options.fetcher ?? fetch
  const { product, clientVersion } = options
  const session = createLobsteraiLoginSession()
  const state = randomUUID()

  let resolveResult!: (value: LobsteraiLoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const credential = new Promise<LobsteraiLoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 这个 Promise 是手工创建的、要过一会儿才被消费者 await，而回调处理器可能在
  // 「构造完成」与「被 await」之间就把它 reject 掉（典型：用户浏览器回调极快，
  // 或 exchange 立刻失败）。那一段窗口里 Node 会把它视为**未处理的拒绝**并打印
  // `PromiseRejectionHandledWarning` / 触发 vitest 的 unhandled error。
  //
  // 先挂一个空处理器把「已处理」标记打上，可消除该告警；这不影响后续消费者 ——
  // 它们仍能拿到同一个拒绝原因。
  credential.catch(() => {})

  let serverClosed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  /** 关闭回调服务器并停掉超时计时器（幂等）。 */
  const closeServer = async (): Promise<void> => {
    if (serverClosed) return
    serverClosed = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (!url.pathname.startsWith(LOBSTERAI_CALLBACK_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    if (code === null || code.length === 0 || gotState !== state) {
      // state 不匹配说明回调不是本次登录发起的（或为伪造），按 Go 的做法直接拒绝。
      // 这里用 400 而不是静默忽略：让用户在浏览器里看到明确的失败反馈。
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调参数无效')
      return
    }
    // 立即在本进程完成 exchange，成功/失败都先把浏览器页面对付了，
    // 否则用户会看到一个一直转圈的页面。
    //
    // 结果里的 loginUrl 用**回调请求实际落到的端口**（`socket.localPort`）
    // 现算，而不是捕获外层变量：回调服务器端口是在 `listen` 之后才知道的，
    // 先声明后赋值会让这个闭包引用一个尚未初始化的 const。
    void exchangeLobsteraiAuthCode(code, session, clientVersion, product, fetcher, options.signal)
      .then((credentialValue) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
        const port = request.socket.localPort ?? 0
        resolveResult(toLoginFlowResult(credentialValue, buildLobsteraiLoginUrl(port, state, product)))
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
        rejectResult(error)
      })
  })

  let port: number
  try {
    port = await listenOnRandomPort(server)
  } catch (error) {
    // 起监听失败：必须把同步占下的槽位还回去，否则此后所有登录都会被
    // `login-in-progress` 永久挡住。
    if (activeLoginSlot === 'preparing') activeLoginSlot = undefined
    throw error
  }
  const loginUrl = buildLobsteraiLoginUrl(port, state, product)

  // 超时覆盖「用户操作 + exchange」整个窗口。原实现从「浏览器已打开」起算，
  // 这里从「会话建立」起算 —— prepare 不再打开浏览器，两者实际只差毫秒级。
  const timeoutMs = options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS
  timeoutTimer = setTimeout(() => {
    rejectResult(new Error(`LobsterAI 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timeoutTimer.unref?.()

  const loginSession: LobsteraiPendingLogin = {
    port,
    loginUrl,
    awaitCredential: () => credential,
    cancel: (reason = 'LobsterAI 登录已取消') => {
      rejectResult(new Error(reason))
    },
  }
  // 用真实句柄替换占位，保持互斥连续（中间没有释放窗口）。
  activeLoginSlot = loginSession
  // 结算即释放会话：成功、失败、超时、取消都汇聚到这一条路径上。
  void credential.then(releaseSession, releaseSession)

  function releaseSession(): void {
    if (activeLoginSlot === loginSession) activeLoginSlot = undefined
    void closeServer()
  }

  return { ok: true, session: loginSession }
}

/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等 `code` → exchange。
 *
 * 单进程内闭环，不落状态文件（见模块头注释）。现已成为
 * {@link prepareLobsteraiLogin} 的便捷封装，供「阻塞式」调用方使用
 * （`LobsteraiAuth.login()`、e2e 探针）；Account Hub 走的是两段式
 * （prepare → 客户端弹窗 → awaitCredential），不经过这里。
 *
 * `timeoutMs` 覆盖「浏览器打开 + 用户操作」整个窗口，超时抛错；
 * 无论成功失败都关闭本地服务器。
 */
export async function runLobsteraiLoginFlow(
  options: LobsteraiLoginFlowOptions & { product: LobsteraiProduct; clientVersion: string },
): Promise<LobsteraiLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const outcome = await prepareLobsteraiLogin(options)
  if (!outcome.ok) throw new Error(outcome.message)
  const loginSession = outcome.session
  try {
    await open(loginSession.loginUrl)
  } catch (error) {
    // 打开失败时不能把会话留在原地（会一直占用端口到超时）。
    loginSession.cancel(`打开 LobsterAI 登录页失败：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  return loginSession.awaitCredential()
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器，返回实际端口。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，
 * 不对外暴露监听面。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('LobsterAI 登录回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}
