/**
 * Qoder（国际版）认证服务：**PAT 粘贴式登录** + job token（`jt-`）运行时缓存。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/trae-cn-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期、同样的 `RefreshTokenExpiredError` 终态约定。
 * 这是本插件已被五个 provider 验证过的模式，复用它可以减少一类
 * 「某个 provider 的续期行为与众不同」的意外。
 *
 * ## 与其它五条协议线的实质差异（三处，都不可照抄）
 *
 * 1. **没有浏览器登录**。其余五条线全是 OAuth / 本地回调，本 provider 的
 *    登录入口是**用户粘贴 PAT**（官方明示「SDK 不会自动刷新 PAT」，
 *    但换 job token 不需要 PAT 变化）。因此**没有** `prepareLogin` /
 *    `persistLoginResult` 的两段式 —— PAT 验证是一次即时请求，不是
 *    「等用户操作 10 分钟」，没有需要拆分的用户手势窗口。
 * 2. **凭据是长期的，过期的是运行时令牌**。`QoderCredential.access_token`
 *    存 PAT，`jt-` **不落盘**（运行时缓存，见 {@link QoderAuth.getJobToken}）。
 *    这直接决定了 `status().expiresAt` 与 `checkExpired()` 的口径 ——
 *    见那两个方法的说明。
 * 3. **续期 = 重打 exchange**，不是「refresh_token 换新」。`jrt-` 那条
 *    （`jobToken/refresh`）**未实测**（计划文档 §3 风险登记），故本实现
 *    只登记常量、不启用；PAT 不变、exchange 随时可重打，主路径够用。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'
import {
  QODER,
  QODER_JOB_TOKEN_EXCHANGE_PATH,
  QODER_JOB_TOKEN_REFRESH_LEAD_MS,
  QODER_REQUEST_TIMEOUT_MS,
  applyQoderRefresh,
  buildQoderCredential,
  isQoderPersonalToken,
  isQoderRefreshable,
  parseQoderCredential,
  parseQoderJobTokenPayload,
  qoderAnonymousHeaders,
  qoderCredentialExpiresAtMs,
  serializeQoderCredential,
  type QoderCredential,
  type QoderJobTokenPayload,
  type QoderProduct,
} from './qoder-product.js'

/**
 * 凭据已失效（需重新粘贴 PAT）时抛出的错误。
 *
 * ⚠️ **类名是历史惯例，不是字面语义**：本插件五个 provider 各导出一个同名类，
 * 因为 `src/refresh.ts` 的 `isRefreshTokenExpired` 用 **`error.name`**（而非
 * `instanceof`）作判据 —— 跨模块 identity 不同，用 instanceof 会让某个
 * provider 的失效信号穿透为「可重试」而无限重试。
 *
 * 故这里必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 * Qoder 没有 refresh_token 可失效（PAT 是长期凭据），这个类的实际语义是
 * **「PAT 已失效 / 不被接受，请重新粘贴」** —— 消息文案按该语义写，
 * 类名保持与另外四个 provider 一致以便复用调度器逻辑。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果（与另外四个 auth 服务同构）。 */
export interface QoderLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /**
   * 凭据过期的毫秒时间戳。
   *
   * **对 Qoder 恒为 0**：PAT 的过期时间由签发时选择、**本地无从得知**
   * （官方文档未给出可解析的过期声明）。这里保留字段是为了让
   * `account.create` 的返回值与另外四个 provider 同构，**不是**「过期时间未知
   * 就当 0 处理」那种兜底 —— 语义就是「没有可报告的过期时间」。
   */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /**
   * 登录 URL。
   *
   * **对 Qoder 恒为空串**：没有浏览器登录流程。保留字段同样是结构同构；
   * 用户真正需要的是 {@link QoderAuth.patUrl}（PAT 签发页）。
   */
  loginUrl: string
  /** 凭据是否可续期（见 {@link isQoderRefreshable}；PAT 在即 true）。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface QoderLoginStatus {
  configured: boolean
  source?: string
  /**
   * 凭据过期时间。
   *
   * **对 Qoder 恒不返回**（`undefined`）：PAT 无本地可知的过期时间，
   * 而 `jt-` 的 24h 是**运行时缓存**的有效期 —— 把它塞进这里会让账号卡片在
   * 闲置 24h 后显示「已过期」，而实际上 `getJobToken()` 会按需重换、
   * 一切正常。宁可少显示一行，也不报一个假的过期。
   */
  expiresAt?: number
  /** 存储的凭据是否可续期（PAT 在即 true）。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Qoder 的认证服务实例。
     *
     * 服务名由产品 id **机械派生**（`qoder` 无连字符 → `qoderAuth` 合法），
     * 与 `buddyCnAuth` / `buddyAuth` / `lobsteraiAuth` / `codeartsAuth` /
     * `traeCnAuth` 并列。cordis 的 `Service` 按名称注册，同名第二次注册会抛
     * `service "..." has been registered`，故每个 provider 各占一个服务名。
     */
    qoderAuth: QoderAuth
  }
}

/** 响应体摘要的截断上限（字符）。 */
const BODY_SUMMARY_LIMIT = 200

/**
 * 把响应体压成一行可读摘要（供错误信息使用）。
 *
 * 三条约束：
 * 1. **压平空白**（含换行）：错误信息会进日志与 UI，多行 body 会把格式冲乱；
 * 2. **截断**：HTML 错误页可以有几万字符；
 * 3. **不做敏感信息过滤**：这是**服务端返回的错误体**，不含我们发出去的 PAT；
 *    真正要守的边界是「绝不把 PAT 回显进任何错误信息」，由调用方保证
 *    （见 {@link QoderAuth.loginWithPat} —— 那里连 PAT 的长度都不提）。
 */
export function summarizeQoderErrorBody(text: string, limit: number = BODY_SUMMARY_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return '(空响应体)'
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…(共 ${compact.length} 字符)`
}

/**
 * 判定一次 exchange 失败是否属于**凭据失效**（终态：请重新粘贴 PAT）。
 *
 * 判据来自 T1 实测：
 * - **HTTP 401/403** —— 端点对「PAT 不对」的统一答复；
 * - 响应体里的 `TOKEN_EXPIRE` / `TOKEN_INVALID` / `token is not active` /
 *   `personal token is invalid` —— 实测 PAT 打 quota 端点回
 *   `401 TOKEN_EXPIRE`（真失效）、伪令牌回 `401 TOKEN_INVALID`（类型错）。
 *   两种都归「这张 PAT 现在不被接受」，用户动作相同（重新粘贴）。
 *
 * ⚠️ **400 刻意不算终态**：实测 camelCase body 回 400 BadRequest，那是
 * **我们的请求构造错了**（协议漂移），不是用户的 PAT 有问题。判成终态会让
 * 用户白白重新签发一张 PAT 却依然失败，而真因（字段名变更）被掩盖。
 */
function isCredentialInvalidExchangeFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  return /TOKEN_EXPIRE|TOKEN_INVALID|token is not active|personal token is invalid/i.test(body)
}

/**
 * 用 PAT 换 job token（`POST {openapiBase}/api/v1/jobToken/exchange`）。
 *
 * 请求体是 `{"personal_token": "<PAT>"}` —— ⚠️ **键名必须 snake_case**
 * （camelCase `personalToken` 实测回 400 `{"errorCode":"BadRequest",…}`）。
 *
 * @throws {RefreshTokenExpiredError} 凭据失效（HTTP 401/403、或响应命中
 *         {@link isCredentialInvalidExchangeFailure} 的标记、或 200 却拿不到
 *         `token`）—— 三种都重试无意义，需用户重新粘贴 PAT。
 * @throws {Error} 其余情况（网络失败、5xx/429、其它非 200、响应非 JSON）——
 *         **普通 Error**，交给 `RefreshScheduler` 走可重试路径。把网络抖动
 *         判成「PAT 失效」会让用户为一次断网重新签发凭据。
 */
export async function exchangeQoderJobToken(
  pat: string,
  product: QoderProduct = QODER,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<QoderJobTokenPayload> {
  if (pat.length === 0) {
    throw new Error('Qoder 换令牌缺少 PAT，请先粘贴个人访问令牌')
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.openapiBase}${QODER_JOB_TOKEN_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: qoderAnonymousHeaders(product),
      // PAT 是服务端生成的 ASCII 令牌，JSON.stringify + fetch 默认按 UTF-8
      // 编码字节 —— 与实测请求一致（计划文档 §0 特别标注「UTF-8 字节」，
      // 因为参考实现里出现过把 body 当 latin1 发的坑）。
      body: JSON.stringify({ personal_token: pat }),
      signal: signalToUse,
    })
  } catch (error) {
    // 传输层失败：**绝不**判为终态（鉴权结论只能由服务端给出）。
    throw new Error(`Qoder 换令牌网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let rawText: string
  try {
    rawText = await response.text()
  } catch (error) {
    throw new Error(
      `Qoder 换令牌响应读取失败（HTTP ${response.status}）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const summary = summarizeQoderErrorBody(rawText)
    if (isCredentialInvalidExchangeFailure(response.status, rawText)) {
      throw new RefreshTokenExpiredError(
        `PAT 已失效或不被接受，请重新粘贴（HTTP ${response.status}：${summary}）`,
      )
    }
    throw new Error(`Qoder 换令牌失败：HTTP ${response.status} ${summary}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    throw new Error(`Qoder 换令牌响应不是 JSON（HTTP ${response.status}）：${summarizeQoderErrorBody(rawText)}`)
  }

  const payload = parseQoderJobTokenPayload(parsed)
  if (payload === undefined) {
    throw new Error(`Qoder 换令牌响应结构异常：${summarizeQoderErrorBody(rawText)}`)
  }
  if (payload.token.length === 0) {
    // 拿到 200 却没有 token：重试同样拿不到（与 LobsterAI 的
    // `refresh_failed: no accessToken` 同判），视为需重新粘贴。
    throw new RefreshTokenExpiredError(`Qoder 换令牌响应缺少 token，请重新粘贴 PAT：${summarizeQoderErrorBody(rawText)}`)
  }
  return payload
}

/** jt 运行时缓存条目。 */
interface QoderJobTokenCacheEntry {
  /** `jt-…` job token 本体。 */
  token: string
  /** 过期时刻（毫秒时间戳，由 exchange 响应的 `expires_in`/`expires_at` 解析）。 */
  expiresAtMs: number
}

/** `QoderAuth` 的构造选项。 */
export interface QoderAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 服务名覆盖（默认取 `product.serviceName`，产品未声明时按 `${id}Auth` 派生）。 */
  serviceName?: string
}

/** {@link QoderAuth.login} / {@link QoderAuth.loginWithPat} 的公共选项。 */
export interface QoderLoginOptions {
  /** 存储用的凭据 ref 覆盖（默认 {@link QoderProduct.defaultCredentialRef}）。 */
  refName?: string
  /** 账号池条目 id；与 `pool` 同时提供时登录成功后登记/补全账号。 */
  accountId?: string
  /** 账号池；与 `accountId` 同时提供时生效。 */
  pool?: AccountPool
}

/** `QoderAuth` 的登录选项（`pat` 必填，其余同上）。 */
export type QoderLoginWithPatOptions = QoderLoginOptions & { pat: string }

/**
 * Qoder 认证服务：PAT 粘贴登录 + job token 运行时缓存。
 *
 * ## 三件东西的生命周期（理解本类的关键）
 *
 * | 东西 | 存放位置 | 生命周期 | 谁刷新 |
 * |---|---|---|---|
 * | PAT `pt-…` | `ctx.credentials` | 长期（用户吊销前一直有效） | **不刷新**，失效只能重贴 |
 * | `jrt-…` | `ctx.credentials`（`refresh_token`） | 48h | 随 exchange 更新（未单独使用） |
 * | `jt-…` | **本类进程内缓存** | 24h | {@link getJobToken} 在剩余 <1h 时静默重换 |
 *
 * 因此「续期」在本 provider 的含义是**重打 exchange 换一张 jt**，
 * 而不是「用 refresh_token 换 access_token」。
 */
export class QoderAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: QoderProduct

  /**
   * 本实例默认读写的凭据 ref 名称（`QODER_PERSONAL_TOKEN`）。
   *
   * 由产品配置派生，与另外五个 provider 的 ref 完全隔离。
   */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新粘贴提示。
        this.markCredentialInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** 凭据已被服务端判定失效；登录/刷新成功时重置。 */
  private credentialInvalid = false
  private lastRefreshError: string | undefined
  /** 会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true

  /**
   * job token 运行时缓存：**PAT → jt**。
   *
   * 为什么**按 PAT 分键**而不是单槽位：同一个 `QoderAuth` 实例既服务默认单凭据
   * ref，也服务账号池里的多个账号（适配器拿到哪个账号的凭据就传哪个 PAT 进来，
   * 见 {@link getJobToken}）。单槽位缓存会让多账号并发请求互相踩踏 ——
   * 每次换号都要重打一次 exchange，而换号是失败路径上的高频动作。
   *
   * ⚠️ **jt 刻意不落盘**（计划 §2 决策 2）：它是运行时产物，进程重启即冷，
   * 下次 `getJobToken()` 重打一次即可。落盘反而会引入「磁盘上的 jt 是不是
   * 还有效」这类无法离线判定的状态。
   */
  private readonly jobTokens = new Map<string, QoderJobTokenCacheEntry>()

  /**
   * 在途 exchange（PAT → Promise）。
   *
   * 并发去重：两个请求同时发现缓存过期时会各自打一次 exchange，白白多一次
   * 往返（且 Qoder 的 exchange 是否对频次敏感未知）。这里让第二个调用者
   * 搭第一个的便车。
   *
   * 去重**按 PAT 分键**（与 {@link jobTokens} 同理）：不同账号的 exchange
   * 是两件互不相干的事，合并会让 B 拿到 A 的令牌。
   */
  private readonly inFlight = new Map<string, Promise<QoderJobTokenPayload>>()

  constructor(ctx: Context, private readonly options: QoderAuthOptions = {}) {
    const product = options.product ?? QODER
    // 服务名：产品配置显式给出（带连字符的 id，如 `qoder-cn` → `qoderCnAuth`），
    // 无该字段时按 `${id}Auth` 机械派生（`qoder` 无连字符，派生结果
    // `qoderAuth` 本身就是合法标识符风格 —— 这是 `QoderProduct.serviceName`
    // 那条判据的两面）。构造选项里的 `serviceName` 仍可整体覆盖（多实例测试用）。
    super(ctx, options.serviceName ?? product.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * PAT 签发页 URL（供 Account Hub 的 Qoder 面板展示）。
   *
   * 本 provider 没有浏览器登录流程，用户必须先去这个页面拿到 PAT ——
   * 面板上的「粘贴 PAT」表单需要它作为引导链接，所以由服务暴露，
   * 避免客户端再抄一份字面量。
   */
  get patUrl(): string {
    return this.product.patUrl
  }

  /** 控制面请求超时（毫秒）；供适配器复用，避免各自写一份常量。 */
  get requestTimeoutMs(): number {
    return QODER_REQUEST_TIMEOUT_MS
  }

  /** 标记凭据已失效：停止重试，并向 status() 暴露 refreshable: false 与重新粘贴提示。 */
  private markCredentialInvalid(): void {
    this.credentialInvalid = true
    this.lastRefreshError = 'PAT 已失效，请重新粘贴'
  }

  /**
   * 统一登录入口。
   *
   * **Qoder 没有浏览器登录**：`login()` 只是 {@link loginWithPat} 的入口别名，
   * 用来满足「所有 `ctx.xxxAuth` 都有 login(options?)」的统一接口约定
   * （见 AGENTS.md「工作方式」）。
   *
   * `options.pat` 缺失时**抛明确错误**而不是静默开一个不存在的浏览器流程：
   * 调用方（RPC / 命令）拿到的是「该走 PAT 粘贴入口」的可读原因，
   * 而不是一个更难归因的失败。
   */
  async login(options: QoderLoginOptions & { pat?: string } = {}): Promise<QoderLoginResult> {
    const pat = options.pat?.trim() ?? ''
    if (pat.length === 0) {
      throw new Error(
        `Qoder 不支持浏览器登录：请粘贴个人访问令牌（PAT），签发页 ${this.product.patUrl}`,
      )
    }
    return this.loginWithPat(pat, options)
  }

  /**
   * 用 PAT 完成登录并持久化凭据。
   *
   * 三步（顺序不可调换）：
   * 1. **本地前缀校验**（`pt-`）—— 在发请求之前挡住「粘错东西」
   *    （粘了别家 token、粘了 `dt-` 设备令牌、粘了半截），把一次必然失败的
   *    网络往返换成一条可读提示；
   * 2. **exchange 验证** —— 只有 200 且响应带 `token` 才继续；
   * 3. **落凭据 + （可选）落账号**。
   *
   * 与另外四个 provider 的登录相比**没有两段式**：PAT 验证是即时请求，
   * 不存在「等用户操作 10 分钟」的用户手势窗口，因此不需要
   * `prepareLogin` / `persistLoginResult` 那一套（计划 §2 决策 1）。
   *
   * ⚠️ **PAT 绝不回显**：错误信息里不含 PAT 本体、长度或任何片段。
   * 凭据是长期有效的秘密，一旦进了日志/UI 就等于泄露。
   *
   * @param pat - 用户粘贴的 PAT；前后空白（剪贴板常见的换行）会被裁掉。
   */
  async loginWithPat(pat: string, options: QoderLoginOptions = {}): Promise<QoderLoginResult> {
    this.active = true
    const token = pat.trim()
    // 前缀由**当前产品**给出（默认参数只是国际版取值）：校验用一个前缀、
    // 下面提示语里报另一个前缀，会让用户照着错的前缀去重新签发 —— 而两个
    // region 的 PAT 并不通用（见 `docs/qoder-integration-research.md` §8）。
    if (!isQoderPersonalToken(token, this.product.patPrefix)) {
      throw new Error(
        `PAT 格式不正确：应以 "${this.product.patPrefix}" 开头。`
        + `请在 ${this.product.patUrl} 重新签发后粘贴（页面关闭后不再显示，需当场复制）`,
      )
    }

    const ref = options.refName ? credentialRef(options.refName) : credentialRef(this.credentialRefName)
    const payload = await this.exchange(token)
    const credential = buildQoderCredential(token, payload)
    await this.ctx.credentials.set(ref, serializeQoderCredential(credential))
    // 缓存刚换到的 jt：登录本身已经付过一次 exchange 的钱，
    // 立刻丢掉会让登录后的第一个请求再换一次。
    this.jobTokens.set(token, { token: payload.token, expiresAtMs: payload.expiresAtMs })
    this.credentialInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()

    if (options.accountId !== undefined && options.pool !== undefined) {
      await options.pool.addAccount({
        id: options.accountId,
        provider: this.product.id,
        nickname: credential.user_id ?? options.accountId,
        enabled: true,
        credentialRef: options.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        // **不写 expiresAt**：PAT 的过期时间本地无从得知，而 jt 的 24h 是
        // 运行时缓存的有效期。把后者写进账号卡片会让它在闲置 24h 后显示
        // 「已过期」，而实际上 getJobToken() 会按需重换、一切正常。
        refreshable: isQoderRefreshable(credential),
      })
    }

    return {
      access: serializeQoderCredential(credential),
      expires: 0,
      ref,
      loginUrl: '',
      refreshable: isQoderRefreshable(credential),
    }
  }

  /**
   * 取一个可用的 job token（`jt-…`），必要时静默重打 exchange。
   *
   * 这是**适配器（chat）与额度端点唯一该用的取令牌入口**：
   *
   * - 缓存命中且剩余有效期 > {@link QODER_JOB_TOKEN_REFRESH_LEAD_MS}（1h）→
   *   直接返回，**不发任何网络请求**；
   * - 剩余不足 1h、或缓存为空 → 重打 exchange 并回填缓存。
   *
   * 提前 1h 的窗口与 `src/refresh.ts` 的 `REFRESH_LEAD_MS` 同口径：卡在
   * 「名义未过期、发请求时已过期」的窗口里会让用户看到一次莫名其妙的 401。
   *
   * @param pat - PAT 本体（`QoderCredential.access_token`，**不是** jt）。
   * @throws {RefreshTokenExpiredError} PAT 已失效（exchange 401 / `TOKEN_EXPIRE`
   *         类）—— 适配器应把它当凭据失效处理，提示用户重新粘贴。
   */
  async getJobToken(pat: string): Promise<string> {
    const cached = this.jobTokens.get(pat)
    if (cached !== undefined && cached.expiresAtMs - Date.now() > QODER_JOB_TOKEN_REFRESH_LEAD_MS) {
      return cached.token
    }
    const payload = await this.exchange(pat)
    return payload.token
  }

  /**
   * 丢弃某个 PAT 的 jt 缓存（下次 {@link getJobToken} 必然重换）。
   *
   * 供适配器在收到「jt 过期类 401」时强制重试一次：实测 chat 端点的 401 是
   * 裸 `{"error":"unauthorized"}`、**不带可分型的业务码**，无法与「PAT 类型错」
   * 区分，所以正确动作是「先当过期处理，重换一次再试；仍失败才判凭据失效」
   * （计划 §2 决策 3）。没有这个入口，适配器只能靠等价手段（如自建时间判断）
   * 绕过缓存，那会让缓存的一致性失去单一真相源。
   */
  invalidateJobToken(pat: string): void {
    this.jobTokens.delete(pat)
  }

  /**
   * 执行一次 exchange，带**在途去重**。
   *
   * 抽出来供 `getJobToken` / `loginWithPat` / `refreshCredential` 共用，
   * 避免三处各写一遍「打请求 → 判终态 → 回填缓存」而逐渐分叉。
   */
  private async exchange(pat: string): Promise<QoderJobTokenPayload> {
    const existing = this.inFlight.get(pat)
    if (existing !== undefined) return existing
    const promise = exchangeQoderJobToken(pat, this.product, this.fetchImpl)
    this.inFlight.set(pat, promise)
    try {
      const payload = await promise
      this.jobTokens.set(pat, { token: payload.token, expiresAtMs: payload.expiresAtMs })
      return payload
    } finally {
      this.inFlight.delete(pat)
    }
  }

  /** 报告凭据是否已配置、是否可续期以及最近刷新错误。 */
  async status(): Promise<QoderLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseQoderCredential(resolved.value)
      if (credential) refreshable = isQoderRefreshable(credential) && !this.credentialInvalid
    }
    return {
      configured: true,
      source: info.source,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 静默续期：用存储的 PAT **重打 exchange**，更新 jt 缓存与凭据元数据。
   *
   * 与另外四个 provider 的语义差异：这里没有「refresh_token 换新」这回事。
   * PAT 不变 ⇒ 只要 PAT 本身没被吊销，`refresh()` **永远可以成功**。
   * 唯一会失败的情形是 PAT 已失效 —— 那时 exchange 回 401 / `TOKEN_EXPIRE`，
   * 本方法抛 {@link RefreshTokenExpiredError}，调度器停止重试并向 UI 暴露
   * 「请重新粘贴」。
   *
   * 终态判定边界：
   * - 网络失败、5xx、429 → 普通 Error，走调度器可重试路径（断网不等于 PAT 失效）；
   * - HTTP 401/403、响应命中失效标记、200 却缺 token → 终态。
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseQoderCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isQoderRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 PAT，请重新粘贴')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      await this.ctx.credentials.set(ref, serializeQoderCredential(refreshed))
      this.credentialInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markCredentialInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（与另外四个 provider 同因）：
   * `refresh()` 读写本实例的默认单凭据 ref（`QODER_PERSONAL_TOKEN`），
   * 而 Account Hub 账号卡片对应的是 `QODER_ACCOUNT_XXX` ——
   * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
   *
   * 同样**不触碰** `credentialInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseQoderCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isQoderRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 PAT，请重新粘贴')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, serializeQoderCredential(refreshed))
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰凭据存储）。
   *
   * exchange 成功时顺带回填 jt 缓存（{@link exchange} 内完成），
   * 因此 `refreshAll` 的每一趟都是「换一张能用的 jt」。
   */
  private async refreshCredential(credential: QoderCredential): Promise<QoderCredential> {
    const payload = await this.exchange(credential.access_token)
    return applyQoderRefresh(credential, payload)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * 遍历 pool 中 `enabled && refreshable` 的 Qoder 账号，逐一确保 jt 可用；
   * 单账号失败不影响其他账号（与另外四个 provider 同语义）。
   *
   * ⚠️ **本 provider 刻意走 `getJobToken` 而不是无条件 exchange**：
   * jt 有效 24h，而 `src/index.ts` 的批量续期**每 30 分钟**跑一趟 ——
   * 无脑重换会让每个账号每天多打约 48 次 exchange，而其中绝大多数纯属浪费。
   * `getJobToken` 自带「剩余 >1h 即命中缓存」的判据，于是每账号每进程
   * 最多每 23 小时换一次，语义与其它 provider 的 `refreshAll` 一致
   * （都保证「下一次请求拿到的令牌是有效的」），只是不再做无用功。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.enabled || !entry.refreshable) continue
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseQoderCredential(resolved.value)
        if (!credential || !isQoderRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await this.getJobToken(credential.access_token)
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[qoder] 账号 ${entry.id} 的 PAT 已失效，已标记为不可续期（需重新粘贴）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
          // 静默会让账号在 UI 上仍显示「可续期」而续期永远失败，用户拿不到任何线索。
          this.ctx.logger?.warn?.(
            `[qoder] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /**
   * 移除已存储的凭据、清空 jt 缓存并停止任何待处理的刷新。
   *
   * **清空整个 jt 缓存**（而不是只删本条 PAT 的）：登出的语义是「这个实例不再
   * 持有任何可用令牌」。多账号场景下，登出默认单凭据 ref 并不意味着别的账号
   * 也该被清 —— 但那些账号的 jt 会在下一次 `getJobToken` 时按需重新换取，
   * 代价是一次 exchange，换来的是「登出后内存里不残留任何 jt」这条清晰不变量。
   */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    this.jobTokens.clear()
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /**
   * 启动时若已有凭据则安排续期（由 `apply` / 登录路径调用）。
   *
   * 武装依据是凭据里记录的 **jt 过期时刻**（`token_expires_at`）：到点前 1h
   * 触发一次 `refresh()`（重打 exchange），既保持 jt 常热，也让
   * `status().refreshError` 能及时反映 PAT 是否已被吊销。
   *
   * 这**不是**把 jt 的 24h 当成凭据有效期 —— `checkExpired()` 与
   * `status().expiresAt` 都不看它（见那两处的说明）。
   */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseQoderCredential(resolved.value)
      if (!credential || !isQoderRefreshable(credential)) return
      const expiresAt = qoderCredentialTokenExpiresAtMs(credential, this.jobTokens)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /**
   * 从存储重载凭据，返回是否**需要用户重新粘贴**（供 UI 判断）。
   *
   * ⚠️ **与另外四个 provider 口径不同，这是有意的**：那边判的是「access token
   * 是否过期」，而 Qoder 的 `access_token` 是 PAT —— **无本地可知的过期时间**
   * （官方不提供、凭据里也没有），`token_expires_at` 记的是 jt（运行时缓存）。
   * 拿 jt 的过期时刻判「凭据过期」会让账号在闲置 24h 后提示重新粘贴，
   * 而实际上一次 `getJobToken()` 就能自愈 —— 那是个纯粹的假警报。
   *
   * 故本方法只回答「有没有一份**看起来能用**的 PAT」：没有（未配置 / 解析失败 /
   * 空串）才返回 true。真正的失效信号只能来自服务端，由 `refresh()` /
   * `getJobToken()` 抛出的 {@link RefreshTokenExpiredError} 表达。
   */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseQoderCredential(resolved.value)
    return credential === undefined || !isQoderRefreshable(credential)
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供审计 / e2e 探针使用（`account-probe` 走的是
   * `resolveCredentialForAccount`，按账号 id 解析，不受 `enabled` 限制）。
   */
  async resolveStoredCredential(): Promise<QoderCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseQoderCredential(resolved.value)
  }
}

/**
 * 取「该凭据对应的 jt 过期时刻」用于调度武装。
 *
 * 优先用**缓存里的真值**（那才是服务端给的权威时刻），缓存没有时退回凭据里
 * 记录的 `token_expires_at`（上一次写入的元数据）。两者都没有就不武装 ——
 * 下一次 `getJobToken()` 会自然换一张并回填。
 *
 * 抽成独立函数的理由：`scheduleRefresh` 是唯一同时读「凭据」与「运行时缓存」
 * 两处状态的地方，把这段判断显式写出来比埋进 Promise 回调里更容易复核。
 */
function qoderCredentialTokenExpiresAtMs(
  credential: QoderCredential,
  cache: ReadonlyMap<string, QoderJobTokenCacheEntry>,
): number | undefined {
  const cached = cache.get(credential.access_token)
  if (cached !== undefined) return cached.expiresAtMs
  // 回退走纯函数（不在这里再写一份数字解析：`token_expires_at` 同时接受
  // 毫秒 / 秒级 / ISO 三种形态，两处各写一份必然分叉）。
  return qoderCredentialExpiresAtMs(credential)
}
