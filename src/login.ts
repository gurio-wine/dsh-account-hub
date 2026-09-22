import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { getRandomValues, randomUUID, randomBytes } from 'node:crypto'
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js'
import {
  CLIENT_ID, REDIRECT_PATH, credentialFromTokenResponse, exchangeAuthorizationCode,
  generateDpopKeyPair, generatePkcePair,
} from './oauth.js'
import type { DpopKeyPair, PkcePair } from './oauth.js'

export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
export const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'

/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export function generateRandomSecret(): string {
  const bytes = getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export function buildLoginUrl(port: number, ticketId: string): { redirectUrl: string; loginUrl: string } {
  const callbackUrl = `http://127.0.0.1:${port}/authentication`
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
  return { redirectUrl, loginUrl }
}

/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null {
  if (data.credential) {
    const access = data.credential.access ?? ''
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  if (data.result) {
    const ak = data.result.accessKeyId ?? ''
    const st = data.result.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
      }
    }
  }
  return null
}

/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential: CodeArtsCredential): number {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}

/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export async function pollForCredential(
  ticketId: string,
  secret: string,
  options: { fetcher?: typeof fetch; maxAttempts?: number; pluginName?: string; pluginVersion?: string } = {},
): Promise<CodeArtsCredential> {
  const fetcher = options.fetcher ?? fetch
  const maxAttempts = options.maxAttempts ?? 120
  const pluginName = options.pluginName ?? PLUGIN_NAME
  const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': pluginName,
          'plugin-version': pluginVersion,
        },
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data: CodeArtsCredentialResponse | null
    try {
      data = (await response.json()) as CodeArtsCredentialResponse
    } catch {
      continue
    }
    const credential = data ? parseCredentialResponse(data) : null
    if (credential) return credential
  }
  throw new Error('CodeArts login timed out')
}

/** 使用平台默认打开器打开 URL；永不抛出异常。 */
export function openBrowser(url: string): void {
  const win = process.platform === 'win32'
  if (win) {
    // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
    // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
    // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
    // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
    const args = ['/c', 'start', '""', `"${url}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.unref()
      return
    } catch (error) {
      console.error('[codearts-auth] failed to open browser; open manually:', url, error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[codearts-auth] failed to open browser; open manually:', url, error)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

function pickToken(params: URLSearchParams): string {
  return params.get('token')
    ?? params.get('access_token')
    ?? params.get('accessToken')
    ?? params.get('authCode')
    ?? ''
}

/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export function startCallbackServer(
  ticketId: string,
  secret: string,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== '/authentication' && !url.pathname.startsWith('/authentication')) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    const params = url.searchParams
    const directToken = pickToken(params)
    if (directToken) {
      response.writeHead(200, CORS_HEADERS).end()
      resolveResult({ access: directToken, expires: Date.now() + 86_400_000, loginUrl: '' })
      return
    }
    const fingerprint = params.get('fingerprint')
    if (fingerprint) {
      try {
        const decoded = Buffer.from(fingerprint, 'base64').toString()
        const fpToken = pickToken(new URL(decoded).searchParams)
        if (fpToken) {
          response.writeHead(200, CORS_HEADERS).end()
          resolveResult({ access: fpToken, expires: Date.now() + 86_400_000, loginUrl: '' })
          return
        }
      } catch {
        /* fingerprint 格式错误：继续到 400 */
      }
    }
    const callbackSecret = params.get('secret')
    if (callbackSecret) {
      response.writeHead(200, CORS_HEADERS).end()
      void pollForCredential(ticketId, callbackSecret, options).then(
        (credential) => resolveResult({
          access: JSON.stringify(credential),
          expires: expiresFromCredential(credential),
          loginUrl: '',
        }),
        (error) => rejectResult(error),
      )
      return
    }
    response.writeHead(400).end('Missing token or secret')
  })

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (error) => rejectStart(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({ port, server, result })
    })
  })
}

/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const ticketId = randomUUID()
  const secret = generateRandomSecret()
  const { port, server, result } = await startCallbackServer(ticketId, secret, options)
  const { loginUrl } = buildLoginUrl(port, ticketId)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(loginUrl)
    const outcome = await result
    return { ...outcome, loginUrl }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login'

/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded: boolean): string {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
}
/** portal 期望的插件名（逆向常量，硬编码）。 */
export const LOGIN_PLUGIN_NAME = 'snap_AIIDE'
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_VERSION = '5.2.0'
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export const OAUTH_THEME = '2'
/** 界面语言（对齐 env.language）。 */
export const OAUTH_LOCALE = 'zh-cn'

/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}`
    + `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}`
    // code_challenge_method 对齐真实插件 PKCEGenerator.CODE_CHALLENGE_METHOD = "SHA-256"
    // （非 RFC 标准缩写 S256；portal 以此识别 OAuth 授权，错值会回退旧 ticket 流程）。
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    // 注意：真实插件 URL 不含 auth_callback_url——portal 仅凭 port 参数构造回调。
    // 多余的 auth_callback_url 会被 portal 视为异常并回退旧流程，切勿添加。
    + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
}

/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export function startOAuthCallbackServer(
  ticketId: string,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    // 旧流程回退：portal 判定 OAuth 授权不可用时以 secret+redirect 回调。
    // 对齐真实插件：立即 307 重定向到 redirect 参数，后台轮询 ticket 端点换取凭据。
    const callbackSecret = url.searchParams.get('secret')
    if (callbackSecret) {
      const redirectTo = url.searchParams.get('redirect') ?? buildPortalLoginResultUrl(true)
      response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end()
      void pollForCredential(ticketId, callbackSecret, {
        ...options,
        pluginName: LOGIN_PLUGIN_NAME,
        pluginVersion: LOGIN_PLUGIN_VERSION,
      }).then(
        (credential) => resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' }),
        (error) => rejectResult(error),
      )
      return
    }
    const code = url.searchParams.get('code')
    if (code) {
      // localPort 在监听中的服务器上必然存在；?? 0 仅用于类型收窄。
      void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, keyPair, options.fetcher).then(
        (token) => {
          const credential = credentialFromTokenResponse(token, pkce, keyPair)
          // 对齐真实插件：换取成功后 307 重定向浏览器到 portal 登录结果页。
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end()
          resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' })
        },
        (error) => {
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end()
          rejectResult(error)
        },
      )
      return
    }
    response.writeHead(400).end('Missing authorization code or secret')
  })

  return listenOnCallbackPort(server).then((port) => ({ port, server, result }))
}

/** 新式 OAuth 回调等待预算（浏览器打开 + 用户操作，180 秒）。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
export const MIN_CALLBACK_PORT = 10_000

/** 登录超时错误文案（阻塞式封装与两段式共用同一条消息）。 */
const OAUTH_TIMEOUT_MESSAGE = 'CodeArts OAuth login timed out'

/** 回调端口重试上限（见 {@link listenOnCallbackPort}）。 */
const CALLBACK_PORT_ATTEMPTS = 10

/** 从 [10000, 65535] 随机取一个候选端口。 */
function randomCallbackPort(): number {
  return Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT
}

/**
 * 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。
 *
 * `listen(0)` 由系统分配的端口可能低于 10000，此时关闭并用随机端口重试 ——
 * 该随机端口可能落在**系统保留段**（Windows 上 `netsh int ipv4 show
 * excludedportrange protocol=tcp` 常见成百上千个保留端口），`listen` 会以
 * `EACCES` 失败。这类失败与「端口被占用」一样属于**挑选失败**，不是登录本身
 * 失败，故同样换端口重试（带上限，避免极端情况下死循环）；只有连续
 * {@link CALLBACK_PORT_ATTEMPTS} 次都挑不到端口才认为真的起不来。
 *
 * `options` 仅供测试注入确定的端口序列：`initialPort` 覆盖首次尝试的端口
 * （默认 0 = 由系统分配），`pickPort` 覆盖重试时的随机取端口。
 */
export function listenOnCallbackPort(
  server: ReturnType<typeof createServer>,
  options: { initialPort?: number; pickPort?: () => number } = {},
): Promise<number> {
  const pickPort = options.pickPort ?? randomCallbackPort
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tryListen = (port: number) => {
      attempts += 1
      /**
       * 一次尝试的两个监听器必须成对摘除。
       *
       * `server.listen()` 会挂一个一次性的 `'listening'` 监听器；失败时该事件
       * 永不触发、监听器会**留在 server 上**。重试 N 次就累积 N 个，Node 在
       * 第 11 个时报 `MaxListenersExceededWarning`（把普通的重试涂成「疑似内存
       * 泄漏」），且每次重试都让旧监听器多留一份。故失败路径必须把
       * `'listening'` 也一并摘掉。
       */
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening)
        server.removeListener('error', onError)
        if (attempts >= CALLBACK_PORT_ATTEMPTS) {
          reject(error)
          return
        }
        tryListen(pickPort())
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned)
          return
        }
        // 端口 < 10000：关闭后用随机 [10000, 65535] 端口重试（对齐真实插件）。
        server.close(() => {
          if (attempts >= CALLBACK_PORT_ATTEMPTS) {
            reject(new Error(`CodeArts 登录回调服务器未能获得 ≥${MIN_CALLBACK_PORT} 的端口`))
            return
          }
          tryListen(pickPort())
        })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    tryListen(options.initialPort ?? 0)
  })
}

/**
 * 一次「已准备、待完成」的 OAuth 登录会话（两段式的第一段产物）。
 *
 * 与阻塞式 {@link runOAuthFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 180 秒」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface CodeartsPendingLogin {
  /** 本地回调服务器实际监听的端口（必然 ≥ {@link MIN_CALLBACK_PORT}）。 */
  port: number
  /** 展示给用户的 portal 授权 URL（含一次性 PKCE 挑战与 ticket_id）。 */
  loginUrl: string
  /** 等待用户在浏览器完成授权并换回凭据。 */
  awaitCredential(): Promise<LoginFlowResult>
  /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
  cancel(reason?: string): void
}

/**
 * {@link prepareCodeartsLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type CodeartsLoginPrepareOutcome =
  | { ok: true; session: CodeartsPendingLogin }
  | { ok: false; error: 'login-in-progress'; message: string }

/** {@link prepareCodeartsLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type CodeartsLoginPrepareOptions = Omit<LoginFlowOptions, 'openBrowser' | 'flow'> & {
  /** 回调等待总超时（毫秒）；默认 180 秒（{@link OAUTH_CALLBACK_TIMEOUT_MS}）。 */
  timeoutMs?: number
}

/**
 * 进行中的登录槽位（模块级，同一时间最多一个）。
 *
 * prepare 阶段会**占用一个本地监听端口**，而客户端的「新建账号」按钮可以被
 * 反复点击。没有互斥时每次点击都会起一个新的 loopback 服务器，
 * 点 N 次就有 N 个端口一直挂到 180 秒超时。
 *
 * `'preparing'` 是**同步占位**：从进入临界区到回调服务器真正 listen 成功之间
 * 存在多个 await（生成 DPoP 密钥对、listen），若只在 listen 完成后才登记，
 * 并发的两次调用会双双通过判空检查、各自起一个监听。
 * 故必须在**第一个 await 之前**同步占位。
 */
type CodeartsLoginSlot = CodeartsPendingLogin | 'preparing'

let activeLoginSlot: CodeartsLoginSlot | undefined

/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export function hasActiveCodeartsLogin(): boolean {
  return activeLoginSlot !== undefined
}

/**
 * 准备一次新式 IAM OAuth 登录（两段式的第一段）：起本地回调服务器，
 * 返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link CodeartsPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 超时、成功、失败、{@link CodeartsPendingLogin.cancel} 都会释放会话。
 *
 * 其余语义（180 秒等待预算、`code_challenge_method=SHA-256`、回调端口 ≥10000、
 * 成功/失败 307 重定向到 portal 结果页、旧 secret 回退轮询）与
 * {@link startOAuthCallbackServer} / 原 `runOAuthFlow` 完全一致。
 */
export async function prepareCodeartsLogin(
  options: CodeartsLoginPrepareOptions = {},
): Promise<CodeartsLoginPrepareOutcome> {
  if (activeLoginSlot !== undefined) {
    return {
      ok: false,
      error: 'login-in-progress',
      message: '已有 CodeArts 登录进行中，请先在浏览器完成或关闭该登录窗口',
    }
  }
  // 同步占位：本函数后面还有若干 await（生成密钥对、listen），
  // 不在此刻占住的话并发调用会同时通过上面的判空。
  activeLoginSlot = 'preparing'

  const ticketId = randomBytes(32).toString('hex')
  const pkce = generatePkcePair()

  let server: ReturnType<typeof createServer>
  let port: number
  let result: Promise<LoginFlowResult>
  try {
    // DPoP 密钥对生成与监听都是异步的：任一失败都必须归还槽位，
    // 否则此后所有登录都会被 `login-in-progress` 永久挡住。
    const keyPair = await generateDpopKeyPair()
    ;({ port, server, result } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options))
  } catch (error) {
    if (activeLoginSlot === 'preparing') activeLoginSlot = undefined
    throw error
  }
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId)

  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const credential = new Promise<LoginFlowResult>((resolve, reject) => {
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

  // 回调结果补上 loginUrl：`startOAuthCallbackServer` 的 result 里它是空串
  // （服务器不知道调用方最终展示的 URL），而流程结果需要它。
  result.then(
    (outcome) => resolveResult({ ...outcome, loginUrl }),
    (error) => rejectResult(error),
  )

  // 超时覆盖「用户操作 + exchange」整个窗口。原实现从「浏览器已打开」起算，
  // 这里从「会话建立」起算 —— prepare 不再打开浏览器，两者实际只差毫秒级。
  const timeoutMs = options.timeoutMs ?? OAUTH_CALLBACK_TIMEOUT_MS
  timeoutTimer = setTimeout(() => {
    rejectResult(new Error(OAUTH_TIMEOUT_MESSAGE))
  }, timeoutMs)
  timeoutTimer.unref?.()

  const loginSession: CodeartsPendingLogin = {
    port,
    loginUrl,
    awaitCredential: () => credential,
    cancel: (reason = 'CodeArts 登录已取消') => {
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
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 现已成为 {@link prepareCodeartsLogin} 的阻塞式便捷封装，供「同步」调用方使用
 * （`CodeArtsAuth.login()`、`/codearts-login` 命令、e2e 探针）；Account Hub
 * 走的是两段式（prepare → 客户端弹窗 → awaitCredential），不经过这里。
 */
export async function runOAuthFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const outcome = await prepareCodeartsLogin(options)
  if (!outcome.ok) throw new Error(outcome.message)
  const loginSession = outcome.session
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(loginSession.loginUrl)
  } catch (error) {
    // 打开失败时不能把会话留在原地（会一直占用端口到超时）。
    loginSession.cancel(`打开 CodeArts 登录页失败：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  return loginSession.awaitCredential()
}
