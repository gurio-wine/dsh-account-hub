/**
 * Qoder **浏览器设备流登录**（两个 region 共用一份实现）。
 *
 * ## 与 PAT 粘贴的关系：**并存**，不是替换
 *
 * Qoder 此前只有 PAT 粘贴一种登录形态（见 `src/qoder-auth.ts` 的模块头）。
 * 本文件补上官方 CLI / 桌面端同款的**设备流**，两者并存：
 *
 * | 形态 | 入口 | 凭据 |
 * |---|---|---|
 * | 设备流 | `login()` 无参 | `token` + `refresh_token`（长期） |
 * | PAT 粘贴 | `login({ pat })` | `pt-…` 作为 `access_token` |
 *
 * 两条路径**写同一种凭据形态**（`QoderCredential`）：它们在上游是同一种身份
 * （`access_token` 都是可换 `jt-` 的长期令牌），故 `refresh` / 额度 / 目录
 * 三条下游链路一行都不用改。**绝不把两条路径揉成一条** —— PAT 是即时请求
 * （同步完成、无占位中间态），设备流是「等用户在浏览器点授权」（两段式），
 * 时序契约完全不同。
 *
 * ## 协议三步（全部照抄官方源码取证，未做任何发明）
 *
 * 1. **PKCE**：`verifier` 64 字符随机、`challenge = base64url(sha256(verifier))`、
 *    `challenge_method: "S256"`；`nonce = randomUUID()`。
 * 2. **登录 URL**：`{authBaseUrl}/device/selectAccounts?challenge&challenge_method
 *    &nonce&machine_id&client_id`。⚠️ **CN 的 `redirect_uri` 是 null ⇒ 不带该参数**。
 *    参数顺序不做要求，但**字段名逐字符照抄**。
 * 3. **轮询**：`GET {openapiBase}/api/v1/deviceToken/poll?nonce&verifier
 *    &challenge_method&machine_id`。**404 → 等 1 秒重试**，总超时 **5 分钟**；
 *    成功判据是「`token` 与 `refresh_token` **都是 string**」。
 *
 * ⚠️ **桌面端另有一套 `client_id`（`732aef47-…`），不要用** —— 我们复刻的是
 * **CLI** 设备流，两区共用同一个 CLI `client_id`（见 {@link QODER_CLI_CLIENT_ID}）。
 *
 * ## 本文件与 `qoder-auth.ts` 的分工
 *
 * 这里只有**协议与流程**（纯函数 + 一次会话的生命周期），不碰 `ctx.credentials`
 * 与账号池 —— 落盘是 `QoderAuth.persistLoginResult` 的事，与另外几个 provider
 * 的两段式分工完全一致。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { QODER_CLI_CLIENT_ID, parseQoderDeviceTokenPayload, type QoderDeviceTokenPayload, type QoderProduct } from './qoder-product.js'

/**
 * 转出 CLI 的 `client_id`（**唯一取值来源在 `qoder-product.ts`**）。
 *
 * 它是产品配置字段 `QoderProduct.clientId` 的取值来源，故常量本体住在产品
 * 配置文件里；这里转出只是为了「设备流相关的常量都在一处」这条可读性，
 * **不重新声明值**（两处各写一份字面量必然分叉）。
 */
export { QODER_CLI_CLIENT_ID }

// ── 常量（照抄官方取证值，不要「顺手改」） ──────────────────────────────────

/** 设备流总超时：官方 5 分钟。到点是**终态**，不再继续轮询。 */
export const QODER_DEVICE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 轮询间隔：官方在 404（尚未授权）后等 1 秒再试。 */
export const QODER_DEVICE_POLL_INTERVAL_MS = 1000

/** 登录 URL 路径（两个 region 相同）。 */
export const QODER_DEVICE_LOGIN_PATH = '/device/selectAccounts'

/** 轮询路径（打在 `product.openapiBase` 上）。 */
export const QODER_DEVICE_POLL_PATH = '/api/v1/deviceToken/poll'

/** machine_id 相对 home 的落盘位置（与官方 CLI **逐字符一致**）。 */
export const QODER_MACHINE_ID_DIR = '.auth'
export const QODER_MACHINE_ID_FILE = 'machine_id'

/** 单次轮询请求的超时（毫秒）；避免一次挂死的连接吃掉整个 5 分钟预算。 */
export const QODER_DEVICE_REQUEST_TIMEOUT_MS = 30_000

// ── PKCE 与 nonce ───────────────────────────────────────────────────────────

/** 一次登录用的 PKCE 配对（S256）。 */
export interface QoderPkce {
  /** 明文 verifier，只在轮询时回传，**绝不进登录 URL**。 */
  codeVerifier: string
  /** `base64url(sha256(verifier))`。 */
  codeChallenge: string
  /** 恒为 `'S256'`（官方只发这一种）。 */
  codeChallengeMethod: string
}

/**
 * 生成 PKCE 配对。
 *
 * `verifier` 是 **48 字节随机 → base64url**：恰好 64 字符（48 % 3 === 0，
 * 无填充），与官方实现一致。base64url 的字符集（`A-Za-z0-9-_`）是 PKCE 规范
 * 允许集（`A-Za-z0-9-._~`）的子集，故无需再做替换。
 *
 * `challenge` 是 `base64url(sha256(verifier))` —— 43 字符（32 字节摘要的
 * base64url 无填充长度）。**不要用 hex**：官方是 base64url，hex 会让服务端
 * 校验失败，而失败形态只是「授权页一直转圈」。
 */
export function generateQoderPkce(): QoderPkce {
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' }
}

/**
 * 生成 nonce（UUID）。
 *
 * nonce 是**这次登录的一次性标识**：它同时进登录 URL 与轮询请求，是服务端
 * 把「浏览器里那次授权」与「这个进程的这次轮询」对上的唯一凭据。
 */
export function generateQoderNonce(): string {
  return randomUUID()
}

// ── 登录 URL ────────────────────────────────────────────────────────────────

/** {@link buildQoderDeviceLoginUrl} 的入参。 */
export interface QoderDeviceLoginUrlInput {
  codeChallenge: string
  nonce: string
  machineId: string
}

/**
 * 构造设备流登录 URL。
 *
 * 字段名逐字符照抄官方：`challenge` / `challenge_method` / `nonce` /
 * `machine_id` / `client_id`。**参数顺序不做要求**（`URLSearchParams` 的
 * 序列化顺序即可），但**不得增删字段**。
 *
 * ⚠️ **不带 `redirect_uri`**：官方 CN 的该值是 `null`，国际版设备流同样不带
 * —— 带上会让授权页走「回调」分支而不是「设备码」分支。
 */
export function buildQoderDeviceLoginUrl(
  product: QoderProduct,
  input: QoderDeviceLoginUrlInput,
): string {
  const url = new URL(QODER_DEVICE_LOGIN_PATH, product.authBaseUrl)
  url.searchParams.set('challenge', input.codeChallenge)
  url.searchParams.set('challenge_method', 'S256')
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('machine_id', input.machineId)
  url.searchParams.set('client_id', product.clientId)
  return url.toString()
}

// ── machine_id ──────────────────────────────────────────────────────────────

/** 文件系统注入面（测试用；生产走 `node:fs/promises`）。 */
export interface QoderMachineIdIo {
  readFile(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
}

/** 生产用 IO：UTF-8 文本读写 + 递归建目录。 */
const defaultMachineIdIo: QoderMachineIdIo = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
}

/** {@link readOrCreateQoderMachineId} 的选项。 */
export interface QoderMachineIdOptions {
  /** home 目录覆盖（测试用；默认 `os.homedir()`）。 */
  homeDir?: string
  /** 文件系统注入面（测试用）。 */
  io?: QoderMachineIdIo
}

/**
 * machine_id 的落盘绝对路径。
 *
 * 两区**路径隔离**：国际版 `~/.qoder/.auth/machine_id`、CN
 * `~/.qoder-cn/.auth/machine_id` —— 与官方 CLI **同路径同格式**。共用同一个
 * 文件会让「装了 CN CLI 又装国际版 CLI」的用户两边机器码互相覆盖。
 */
export function qoderMachineIdPath(product: QoderProduct, homeDir: string = homedir()): string {
  return join(homeDir, product.machineIdDir, QODER_MACHINE_ID_DIR, QODER_MACHINE_ID_FILE)
}

/**
 * 读取或生成该产品的 machine_id（36 字符 UUID 文本）。
 *
 * 行为契约（三条，都有单测钉死）：
 *
 * 1. **已存在则读用** —— 绝不覆盖。与官方 CLI 共用同一个文件是**刻意的**：
 *    用户混用官方 CLI 时两边读同一个机器身份，wasm 签名链才不会因机器码漂移
 *    而失效。
 * 2. **不存在则生成并落盘**（目录递归创建）。
 * 3. **落盘 / 读取失败不挡登录** —— 退回一个内存态 UUID 继续用。
 *    磁盘不可写是环境问题，不是「用户没资格登录」；把它变成登录失败，
 *    用户除了换台机器别无他法。
 *
 * 读取时 `trim()`：官方 CLI 可能写成「一行 + `\n`」，把换行当令牌正文的一部分
 * 会让 `machine_id` 参数多一个 `%0A`。
 */
export async function readOrCreateQoderMachineId(
  product: QoderProduct,
  options: QoderMachineIdOptions = {},
): Promise<string> {
  const io = options.io ?? defaultMachineIdIo
  const path = qoderMachineIdPath(product, options.homeDir)

  try {
    const existing = (await io.readFile(path)).trim()
    if (existing.length > 0) return existing
  } catch {
    // 不存在 / 不可读：落到下面的生成路径。**不区分**错误码 —— 无论是
    // ENOENT 还是 EACCES，下一步都是「生成一个新的」。
  }

  const generated = randomUUID()
  try {
    await io.mkdir(join(options.homeDir ?? homedir(), product.machineIdDir, QODER_MACHINE_ID_DIR))
    await io.writeFile(path, generated)
  } catch {
    // 落盘失败：内存态照用。**不抛**（见上面的契约 3）。
  }
  return generated
}

// ── 轮询 ────────────────────────────────────────────────────────────────────

/**
 * 设备流成功返回的令牌载荷（**类型与解析都在 `qoder-product.ts`**）。
 *
 * 转出而不在本文件重新声明：poll 与 `deviceToken/refresh` 两个端点回的是
 * **同一种载荷**，两处各写一份类型与解析必然分叉（典型后果：「续期成功但
 * 令牌没变」这类静默失败）。协议纯函数统一住在产品层，本文件只负责流程。
 */
export {
  parseQoderDeviceTokenPayload,
  type QoderDeviceTokenPayload,
} from './qoder-product.js'

/** {@link pollQoderDeviceToken} 的选项。 */
export interface QoderDevicePollOptions {
  nonce: string
  codeVerifier: string
  machineId: string
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 注入的等待函数（测试用）；默认 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
  /** 取消信号：登出 / 删除账号时终止轮询。 */
  signal?: AbortSignal
  /** 轮询间隔覆盖（默认 {@link QODER_DEVICE_POLL_INTERVAL_MS}）。 */
  intervalMs?: number
  /** 总超时覆盖（默认 {@link QODER_DEVICE_LOGIN_TIMEOUT_MS}）。 */
  timeoutMs?: number
}

/** 默认等待实现。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // 不阻止进程退出：设备流最多 5 分钟，不该把宿主钉在事件循环里。
    timer.unref?.()
  })
}

/**
 * 轮询直到拿到令牌 / 超时 / 被取消 / 出错。
 *
 * ## 三类「不成功」的区分（这是本函数的核心语义）
 *
 * | 情况 | 动作 |
 * |---|---|
 * | **404** | 尚未授权 ⇒ 等 `intervalMs` 重试（官方节奏） |
 * | **200 但判据不满足** | 同上（授权页尚未点击时上游回 200 + 空对象） |
 * | **其它非 2xx** | **直报**，不当作「还在等授权」空转 |
 * | **传输层失败** | **直报**（断网不是「继续等」） |
 *
 * 把非 404 的失败也当成「重试」会让一个必然失败的请求空转到 5 分钟，
 * 而用户看到的只是「登录一直不完成」。
 *
 * ## 超时与取消都是**终态**
 *
 * 到点或被 abort 后**必须真的停下来** —— 否则删除账号后轮询仍在后台打请求，
 * 且每次都要等满 5 分钟才释放。
 *
 * @throws 超时 / 取消 / 非 404 失败 / 传输层失败 / 响应非 JSON。
 */
export async function pollQoderDeviceToken(
  product: QoderProduct,
  options: QoderDevicePollOptions,
): Promise<QoderDeviceTokenPayload> {
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const intervalMs = options.intervalMs ?? QODER_DEVICE_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? QODER_DEVICE_LOGIN_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  const url = new URL(QODER_DEVICE_POLL_PATH, product.openapiBase)
  url.searchParams.set('nonce', options.nonce)
  url.searchParams.set('verifier', options.codeVerifier)
  url.searchParams.set('challenge_method', 'S256')
  // machine_id 与登录请求**必须同一个**：wasm 签名链按机器身份校验，
  // 两处漂移会让轮询永远拿不到令牌（而授权页显示「已授权」）。
  url.searchParams.set('machine_id', options.machineId)

  for (;;) {
    if (options.signal?.aborted) throw new Error('Qoder 设备流登录已取消')
    if (Date.now() >= deadline) {
      throw new Error(
        `Qoder 设备流登录超时（${Math.round(timeoutMs / 1000)} 秒内未在浏览器完成授权）`,
      )
    }

    let response: Response
    try {
      response = await fetcher(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      // 被 abort 触发的 fetch 拒绝也走这里：先判取消，再报网络失败。
      if (options.signal?.aborted) throw new Error('Qoder 设备流登录已取消')
      throw new Error(
        `Qoder 设备流轮询网络失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status === 404) {
      // 官方语义：404 = 用户还没在授权页完成选择，1 秒后再问。
      await sleep(intervalMs)
      continue
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Qoder 设备流轮询失败：HTTP ${response.status} ${body.slice(0, 200)}`)
    }

    const raw = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new Error(`Qoder 设备流轮询响应不是 JSON：${raw.slice(0, 200)}`)
    }
    const payload = parseQoderDeviceTokenPayload(parsed)
    if (payload !== undefined) return payload

    // 200 但还没令牌 = 仍在等授权，按同一节奏继续问。
    await sleep(intervalMs)
  }
}

// ── 两段式会话 ──────────────────────────────────────────────────────────────

/**
 * 一次进行中的设备流登录。
 *
 * 与 `TraeCnPendingLogin` / `LobsteraiPendingLogin` 同构：`account.create` 拿到
 * `loginUrl` 就返回，后台 `awaitToken()` 结算。
 */
export interface QoderDevicePendingLogin {
  /** 本次登录所属的 provider id（互斥按它分槽）。 */
  productId: string
  /** 展示给用户的授权页 URL（含本次 PKCE / nonce / machine_id）。 */
  loginUrl: string
  /** 本次登录的一次性 nonce。 */
  nonce: string
  /** 明文 PKCE verifier（只在轮询时回传）。 */
  codeVerifier: string
  /** 本次登录使用的 machine_id（已落盘，供签名链复用）。 */
  machineId: string
  /**
   * 等待用户在浏览器完成授权并拿到令牌。
   *
   * **首次调用才发起轮询**（prepare 阶段一次网都不出）：这样「打开授权页」
   * 与「开始轮询」的先后由调用方掌握，也避免用户在弹窗被拦截时白白轮询
   * 5 分钟。重复调用返回同一个 Promise（幂等消费）。
   */
  awaitToken(): Promise<QoderDeviceTokenPayload>
  /** 主动放弃本次登录：终止轮询并释放互斥槽位。幂等。 */
  cancel(reason?: string): void
}

/** {@link prepareQoderDeviceLogin} 的结果（判别联合，与另外几个 provider 同构）。 */
export type QoderDeviceLoginPrepareOutcome =
  | { ok: true; session: QoderDevicePendingLogin }
  | { ok: false; error: 'login-in-progress'; message: string }

/** {@link prepareQoderDeviceLogin} 的选项。 */
export interface QoderDevicePrepareOptions {
  product: QoderProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 注入的等待函数（测试用）。 */
  sleep?: (ms: number) => Promise<void>
  /** home 目录覆盖（测试用）。 */
  homeDir?: string
  /** 文件系统注入面（测试用）。 */
  io?: QoderMachineIdIo
  /** 轮询间隔覆盖。 */
  intervalMs?: number
  /** 总超时覆盖。 */
  timeoutMs?: number
}

/**
 * 进行中的登录槽位（**按 provider 分槽**，模块级单例）。
 *
 * ## 为什么必须互斥
 *
 * 客户端的「+ 新建账号」按钮可以被反复点击。没有互斥时每次点击都会新建一个
 * 轮询循环 —— 点 N 次就有 N 个循环各自打到 5 分钟超时，而其中只有一个的
 * nonce 会真的被用户授权。
 *
 * ## 为什么按 provider 分槽（而不是全局一个）
 *
 * 两区是**两批账号、两套令牌**：国际版的登录窗口不该挡住 CN 的登录。
 * 这与 `trae-cn` / `trae-cn-work` 那种「同一批账号」的情形方向相反。
 *
 * ## 为什么 `'preparing'` 也要占位
 *
 * 从进入临界区到 `machine_id` 落盘（一次真实文件 IO）之间存在 await。
 * 若只在全部就绪后才登记，并发的两次调用会双双通过判空检查、各自建一个会话。
 * 故必须在**第一个 await 之前**同步占位。
 */
type QoderLoginSlot = QoderDevicePendingLogin | 'preparing'

const activeLoginSlots = new Map<string, QoderLoginSlot>()

/** 该 provider 当前是否有未结算的登录会话（含正在准备中的）。 */
export function hasActiveQoderDeviceLogin(productId: string): boolean {
  return activeLoginSlots.has(productId)
}

/**
 * 取消该 provider 进行中的设备流登录（幂等；无会话时 no-op）。
 *
 * 供 `account.delete` 使用 —— 它只知道 accountId / provider id，拿不到会话
 * 句柄，故由模块级槽位表提供按 provider 的取消入口。
 *
 * ⚠️ **`'preparing'` 阶段也一并释放**：那个阶段没有可 abort 的轮询，但槽位
 * 必须还回去，否则「建会话途中用户删了账号」会让该 provider 此后所有登录
 * 都被 `login-in-progress` 永久挡住。
 */
export function cancelQoderDeviceLogin(productId: string, reason?: string): void {
  const slot = activeLoginSlots.get(productId)
  if (slot === undefined) return
  if (slot === 'preparing') {
    activeLoginSlots.delete(productId)
    return
  }
  slot.cancel(reason)
}

/** 释放指定 provider 的槽位（幂等；只释放仍是自己的那个）。 */
function releaseQoderLoginSlot(productId: string, slot: QoderLoginSlot): void {
  if (activeLoginSlots.get(productId) === slot) activeLoginSlots.delete(productId)
}

/**
 * **第一段**：建立一次设备流会话，返回 `loginUrl`（**不等待用户操作**）。
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享；
 * - **不静默新建**：每次点击都堆一个轮询循环到超时。
 *
 * 本函数**不发任何请求**（PKCE 是本地生成、machine_id 是本地读写）——
 * 轮询由 {@link QoderDevicePendingLogin.awaitToken} 在第二段发起。
 */
export async function prepareQoderDeviceLogin(
  options: QoderDevicePrepareOptions,
): Promise<QoderDeviceLoginPrepareOutcome> {
  const productId = options.product.id
  if (activeLoginSlots.has(productId)) {
    return {
      ok: false,
      error: 'login-in-progress',
      message: `已有 ${options.product.displayName} 登录进行中，请先在浏览器完成或关闭该登录窗口`,
    }
  }
  // 同步占位：下面还有 await（machine_id 的文件 IO）。
  activeLoginSlots.set(productId, 'preparing')

  let session: QoderDevicePendingLogin
  try {
    const machineId = await readOrCreateQoderMachineId(options.product, {
      ...options.homeDir === undefined ? {} : { homeDir: options.homeDir },
      ...options.io === undefined ? {} : { io: options.io },
    })
    const pkce = generateQoderPkce()
    const nonce = generateQoderNonce()
    const loginUrl = buildQoderDeviceLoginUrl(options.product, {
      codeChallenge: pkce.codeChallenge,
      nonce,
      machineId,
    })

    const controller = new AbortController()
    let cancelledReason: string | undefined
    let pending: Promise<QoderDeviceTokenPayload> | undefined

    session = {
      productId,
      loginUrl,
      nonce,
      codeVerifier: pkce.codeVerifier,
      machineId,
      awaitToken: () => {
        if (pending !== undefined) return pending
        if (cancelledReason !== undefined) {
          return Promise.reject(new Error(cancelledReason))
        }
        // 轮询**懒启动**：第一次 awaitToken 才真正出网（见接口说明）。
        pending = pollQoderDeviceToken(options.product, {
          nonce,
          codeVerifier: pkce.codeVerifier,
          machineId,
          signal: controller.signal,
          ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
          ...options.sleep === undefined ? {} : { sleep: options.sleep },
          ...options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs },
          ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        })
        // 这个 Promise 要过一会儿才被消费者 await，而它可能在「构造完成」与
        // 「被 await」之间就 reject（典型：立即取消、网络立刻失败）。先挂一个
        // 空处理器打上「已处理」标记，避免 Node 报未处理的拒绝。
        pending.catch(() => {})
        // **结算即释放槽位**：成功、超时、取消、网络失败四条路径都汇聚到
        // 这一处。漏了它，此后所有登录都会被 `login-in-progress` 永久挡住
        // （而表面上「什么都没发生」）。
        void pending.then(
          () => releaseQoderLoginSlot(productId, session),
          () => releaseQoderLoginSlot(productId, session),
        )
        return pending
      },
      cancel: (reason = `${options.product.displayName} 登录已取消`) => {
        if (cancelledReason !== undefined) return
        cancelledReason = reason
        // 先 abort 再释放槽位：abort 让在途 fetch / 下一轮循环立刻退出。
        controller.abort()
        releaseQoderLoginSlot(productId, session)
        // 轮询尚未启动时不会有 pending；已启动的由 abort 在下一轮抛错结算。
        // 这里**不主动 reject** —— pending 的拒绝路径只有一条（轮询循环），
        // 两条拒绝路径会让「已结算」与「已取消」的时序变得不可判定。
      },
    }
  } catch (error) {
    // 建会话失败：必须把同步占下的槽位还回去，否则此后所有登录都会被
    // login-in-progress 永久挡住。
    if (activeLoginSlots.get(productId) === 'preparing') activeLoginSlots.delete(productId)
    throw error
  }

  activeLoginSlots.set(productId, session)
  return { ok: true, session }
}
