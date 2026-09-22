/**
 * Trae CN（字节跳动 Trae 国内版）认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期、同样的两段式 `prepareLogin` /
 * `persistLoginResult`。这是本插件已被三个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与另外两条协议线的实质差异只有两处：
 *
 * 1. **续期端点是 `ExchangeToken`**（不是 `/refresh`）：body 四字段
 *    `{ClientID, ClientSecret, RefreshToken, UserID}`，且 `UserID` **必填** ——
 *    它来自凭据的五件套，故续期前必须先解析出 `user_id`，缺失时只能让用户重新登录。
 *    注意这与**登录**的 authCode 交换**不是同一个端点**：续期在
 *    `cloudide/api/v3/trae/oauth/ExchangeToken`，登录在
 *    `trae/api/v3/oauth/ExchangeToken`（见 `src/trae-cn-oauth.ts` 模块头）。
 * 2. **access token 用法是 `Authorization: Cloud-IDE-JWT`**（不是 `Bearer`），
 *    另带 `X-Ide-Token` / `X-Cloudide-Token` 两个同值头。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  TRAE_CN_REQUEST_TIMEOUT_MS,
  TRAE_CN,
  type TraeCnProduct,
} from './trae-cn-product.js'
import {
  applyTraeCnRefresh,
  buildTraeCnCredential,
  exchangeTraeCnToken,
  isTraeCnExpired,
  isTraeCnRefreshable,
  parseTraeCnCredential,
  prepareTraeCnLogin,
  runTraeCnLoginFlow,
  serializeTraeCnCredential,
  traeCnAccessHeaders,
  traeCnCredentialExpiresAtMs,
  type TraeCnCredential,
  type TraeCnLoginFlowOptions,
  type TraeCnLoginFlowResult,
  type TraeCnLoginPrepareOptions,
  type TraeCnLoginPrepareOutcome,
} from './trae-cn-oauth.js'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'

/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与 `buddy-oauth.ts` / `oauth.ts` / `lobsterai-auth.ts` 同名类**刻意是各自独立的类**：
 * `src/refresh.ts` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface TraeCnLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface TraeCnLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过刷新令牌静默续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Trae CN 的认证服务实例。
     *
     * 与 `buddyCnAuth` / `buddyAuth` / `codeartsAuth` / `lobsteraiAuth` 并列。
     * **服务名刻意不是 `${product.id}Auth`**：product.id 为 `trae-cn`，
     * 机械派生会得到 `trae-cnAuth`（带连字符，需用 `ctx['trae-cnAuth']` 访问）。
     * 服务名由产品配置的 `serviceName` 显式给出 `traeCnAuth`，
     * 详见 `src/trae-cn-product.ts` 的说明。
     */
    traeCnAuth: TraeCnAuth
  }
}

/** `TraeCnAuth` 的构造选项。 */
export interface TraeCnAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link TRAE_CN}。 */
  product?: TraeCnProduct
  /**
   * 服务名覆盖；默认取 `product.serviceName`（即 `traeCnAuth`）。
   *
   * 保留这个覆盖口是为了让「产品 id」与「服务名」彻底解耦：产品 id 可以
   * 任意更名而不牵动服务标识符，测试也能在同一 Context 上挂多个实例。
   */
  serviceName?: string
}

/**
 * Trae CN 认证服务：loopback 回调登录 + `ExchangeToken` 静默续期。
 */
export class TraeCnAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: TraeCnProduct

  /**
   * 本实例默认读写的凭据 ref 名称（`TRAE_CN_ACCESS_TOKEN`）。
   *
   * 由产品配置派生，与另外四个 provider 的 ref 完全隔离。
   */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true

  constructor(ctx: Context, private readonly options: TraeCnAuthOptions = {}) {
    const product = options.product ?? TRAE_CN
    // 服务名走 product.serviceName（而非 `${product.id}Auth`）：产品 id 带连字符。
    super(ctx, options.serviceName ?? product.serviceName)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /**
   * 运行完整登录流程并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
   * （Account Hub 的「+ 新建账号」路径）。
   *
   * **阻塞式**：会一直等到用户在浏览器完成登录（最长 10 分钟）。
   * Account Hub 用的是两段式 {@link prepareLogin} + {@link persistLoginResult}，
   * 以便 RPC 立即返回登录 URL、不阻塞客户端。
   */
  async login(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<TraeCnLoginFlowOptions> = {},
  ): Promise<TraeCnLoginResult> {
    this.active = true
    const flow = await runTraeCnLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      onCallbackDebug: (message) => this.logCallbackDebug(message),
      ...flowOptions,
    })
    return this.persistLoginResult(flow, flowOptions)
  }

  /** 把回调诊断写进宿主日志（T5 校准用；内容已脱敏，见 trae-cn-oauth.ts）。 */
  private logCallbackDebug(message: string): void {
    this.ctx.logger?.info?.(message)
  }

  /**
   * 两段式的**第一段**：准备一次登录，返回登录 URL 与会话句柄。
   *
   * 只做「起本地回调服务器」，**不打开浏览器、不等待用户**。
   * 调用方应立即把 `session.loginUrl` 交给客户端弹窗（用户手势必须发生在
   * 同一轮交互里），随后用 {@link persistLoginResult} 在后台消费
   * `session.awaitCredential()` 的结果。
   *
   * 这里**不写凭据、不动账号池** —— 凭据落盘与占位账号的补全由
   * {@link persistLoginResult} 负责，两者时序必须保持「先跑完流程、
   * 再写凭据、最后补全账号」。
   *
   * 已有进行中的会话时返回 `login-in-progress`（provider 级互斥：
   * 不新建监听、不复用旧会话）；调用方应把该错误原样透传给客户端提示用户。
   */
  async prepareLogin(
    options: Partial<Omit<TraeCnLoginPrepareOptions, 'product'>> = {},
  ): Promise<TraeCnLoginPrepareOutcome> {
    // 会话出现即视为「本次登录有效」：清掉上一次的失效标记，
    // 否则 status() 会一直显示旧的 refresh_token 失效提示。
    this.active = true
    return prepareTraeCnLogin({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      onCallbackDebug: (message) => this.logCallbackDebug(message),
      ...options,
    })
  }

  /**
   * 两段式的**第二段**：把一个已完成的登录结果落盘（凭据 + 账号池）。
   *
   * 时序约束（不可调换）：
   * 1. `expiresAt` / `refreshable` / `nickname` 都来自登录结果，
   *    流程返回前无法得知，因此占位账号只能以「pending 形态」存在
   *    （无 `expiresAt`、`refreshable: false`）；
   * 2. 先把凭据写入 `ctx.credentials`，**再**补全账号条目 —— 客户端轮询的
   *    `login.poll` 以「该 ref 能否解析到凭据」为完成判据，反过来（先补全
   *    账号字段再写凭据）会让轮询在凭据就绪前就报成功。
   *
   * `accountId` + `pool` 提供时按账号路径补全；否则落到默认单凭据 ref
   * （{@link login} 走的就是这条）。
   *
   * 不触碰 `active`：那是「登出竞态」的开关（见 {@link refresh}），
   * 由 {@link login} / {@link prepareLogin} 在会话开始时置位。
   */
  async persistLoginResult(
    flow: TraeCnLoginFlowResult,
    options: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<TraeCnLoginResult> {
    const ref = options.refName ? credentialRef(options.refName) : credentialRef(this.credentialRefName)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseTraeCnCredential(flow.access)
    // 多账号：accountId 提供时按 id 落位到账号池的一条记录（占位则补全，否则新建）。
    // 与 CodeArtsAuth.persistLoginResult 对称：AccountPool.addAccount 不按 id 去重，
    // 两段式的占位条目若在这里再 addAccount 一次，池里会出现同 id 的两条记录。
    if (options.accountId !== undefined && options.pool !== undefined) {
      const expiresAt = credential ? traeCnCredentialExpiresAtMs(credential) : undefined
      const refreshable = credential !== undefined && isTraeCnRefreshable(credential)
      const nickname = credential?.nickname !== undefined && credential.nickname.length > 0
        ? credential.nickname
        : options.accountId
      const existing = (await options.pool.listAllAccounts()).find((a) => a.id === options.accountId)
      if (existing) {
        await options.pool.updateAccount(options.accountId, {
          nickname,
          expiresAt,
          refreshable,
        })
      } else {
        await options.pool.addAccount({
          id: options.accountId,
          provider: this.product.id,
          nickname,
          enabled: true,
          credentialRef: options.refName ?? this.credentialRefName,
          createdAt: Date.now(),
          expiresAt,
          refreshable,
        })
      }
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable,
    }
  }

  /**
   * 用**已有的 refreshToken** 完成登录（供 e2e 探针与「粘贴凭据」场景使用）。
   *
   * 与 {@link login} 的区别：不起回调服务器，直接走**续期端点**
   * （`cloudide/api/v3/trae/oauth/ExchangeToken`）。保留这个入口是为了让 e2e
   * 探针能在不打开浏览器的情况下验证续期链路。
   *
   * ⚠️ 它**不是**登录协议的主路径：真机登录走的是 PKCE → `authCodeInfo` →
   * `trae/api/v3/oauth/ExchangeToken`（见 `src/trae-cn-oauth.ts` 模块头）。
   * 这里拿不到 exchange 响应的 `BoundDeviceID`，故凭据的 `device_id` 只能取
   * 续期响应里自带的设备字段（通常为空）。
   *
   * ⚠️ **本入口造的凭据也缺签到设备号**（`checkin_device_id` 为空）：签到用的
   * 16 位号只在登录 URL 里生成，本入口没有登录 URL。签到侧会**如实降级**为
   * `BoundDeviceID`（见 `traeCnCheckinDeviceId`），而该值不被活动系统认可 ——
   * 故**要签到就得走浏览器登录**，这一点在 2026-09-20 的 9074 定案后更明确了。
   */
  async loginWithRefreshToken(
    refreshToken: string,
    options: { userId?: string; machineId?: string; refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<TraeCnLoginResult> {
    this.active = true
    const ref = options.refName ? credentialRef(options.refName) : credentialRef(this.credentialRefName)
    const payload = await exchangeTraeCnToken(
      { refreshToken, userId: options.userId ?? '' },
      this.product,
      this.fetchImpl,
    )
    // 用与回调路径**同一个**构造函数组装凭据：五件套的默认值（设备号来源标记等）
    // 在两处必须一致，各写一份会逐渐分叉。
    const credential = applyTraeCnRefresh(
      buildTraeCnCredential({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken.length > 0 ? payload.refreshToken : refreshToken,
        userId: options.userId ?? '',
        clientId: this.product.clientId,
        deviceId: payload.deviceId,
        deviceIdSource: 'exchange-bound-device-id',
        machineId: options.machineId ?? '',
        // ⚠️ **本入口拿不到签到设备号**：它没有登录 URL，也就没有那个 16 位号
        // （见 `TraeCnCredential.checkin_device_id`）。故如实留空 ——
        // 签到侧会降级用 BoundDeviceID，**不伪造**。要修复签到请走浏览器登录。
      }),
      payload,
    )
    const access = serializeTraeCnCredential(credential)
    await this.ctx.credentials.set(ref, access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    if (options.accountId !== undefined && options.pool !== undefined) {
      await options.pool.addAccount({
        id: options.accountId,
        provider: this.product.id,
        nickname: credential.nickname !== undefined && credential.nickname.length > 0
          ? credential.nickname
          : options.accountId,
        enabled: true,
        credentialRef: options.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: traeCnCredentialExpiresAtMs(credential),
        refreshable: isTraeCnRefreshable(credential),
      })
    }
    return {
      access,
      expires: traeCnCredentialExpiresAtMs(credential) ?? 0,
      ref,
      loginUrl: '',
      refreshable: isTraeCnRefreshable(credential),
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<TraeCnLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseTraeCnCredential(resolved.value)
      if (credential) {
        expiresAt = traeCnCredentialExpiresAtMs(credential)
        refreshable = isTraeCnRefreshable(credential) && !this.refreshTokenInvalid
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 静默续期：`ExchangeToken` 用 refreshToken + userID 换新 access token。
   *
   * 终态判定：
   * - HTTP 401/403、或响应里找不到 access token → 抛
   *   {@link RefreshTokenExpiredError}，让调度器停止续期；
   * - 网络失败、5xx、429 → 抛普通 Error，走调度器的可重试路径。
   *   （`exchangeTraeCnToken` 已按这个口径分类：传输层失败与 HTTP 错误
   *   都是普通 Error，只有「调用方判定的终态」才升级成上面那个类。）
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseTraeCnCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isTraeCnRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      await this.ctx.credentials.set(ref, serializeTraeCnCredential(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（与另外三个 provider 同因）：
   * `refresh()` 读写本实例的默认单凭据 ref（`TRAE_CN_ACCESS_TOKEN`），
   * 而 Account Hub 账号卡片对应的是 `TRAE_CN_ACCOUNT_XXX` ——
   * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseTraeCnCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isTraeCnRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, serializeTraeCnCredential(refreshed))
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   *
   * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
   * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
   */
  private async refreshCredential(credential: TraeCnCredential): Promise<TraeCnCredential> {
    if (credential.user_id.length === 0) {
      // UserID 是 ExchangeToken 的必填字段。缺失说明凭据是半成品
      // （T5 校准前登录可能拿不到 user_id），重试也不会变好 —— 判终态。
      throw new RefreshTokenExpiredError('凭据缺少 user_id，无法续期，请重新登录')
    }
    const payload = await exchangeTraeCnToken(
      { refreshToken: credential.refresh_token, userId: credential.user_id },
      this.product,
      this.fetchImpl,
    ).catch((error: unknown) => {
      // 传输层/HTTP 失败：分类后决定终态还是可重试。
      if (isTraeCnTerminalFailure(error)) {
        throw new RefreshTokenExpiredError(error instanceof Error ? error.message : String(error))
      }
      throw error
    })
    return applyTraeCnRefresh(credential, payload)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
   * **自动选号**，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
   * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
   *
   * 单账号失败不影响其他账号（与另外几个 provider 同语义）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // 只跳过「不可续期」的账号；enabled 与续期无关（见方法注释）。
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseTraeCnCredential(resolved.value)
        if (!credential || !isTraeCnRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const refreshed = await this.refreshCredential(credential)
        await this.ctx.credentials.set(ref, serializeTraeCnCredential(refreshed))
        await pool.updateAccount(entry.id, {
          expiresAt: traeCnCredentialExpiresAtMs(refreshed) ?? undefined,
          refreshable: isTraeCnRefreshable(refreshed),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[trae-cn] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
          // 静默会让账号在 UI 上仍显示「可续期」而续期永远失败，用户拿不到任何线索。
          this.ctx.logger?.warn?.(
            `[trae-cn] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseTraeCnCredential(resolved.value)
      if (!credential || !isTraeCnRefreshable(credential)) return
      const expiresAt = traeCnCredentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseTraeCnCredential(resolved.value)
    return credential === undefined ? true : isTraeCnExpired(credential)
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供 e2e 探针与 `account-probe` 使用（后者实际走 `resolveCredentialForAccount`，
   * 按账号 id 解析，不受 `enabled` 限制）。
   */
  async resolveStoredCredential(): Promise<TraeCnCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseTraeCnCredential(resolved.value)
  }

  /**
   * 构造带 Trae 鉴权的请求头（供后续的 LLM 适配器 / 签到模块复用）。
   *
   * `Accept` 可切换成 `text/event-stream` 供流式对话使用；
   * 鉴权三头（`Authorization` / `X-Ide-Token` / `X-Cloudide-Token`）不变。
   */
  accessHeaders(credential: TraeCnCredential, accept?: string): Record<string, string> {
    return accept === undefined
      ? traeCnAccessHeaders(credential)
      : traeCnAccessHeaders(credential, accept)
  }

  /** 控制面请求超时（毫秒）；供后续模块复用，避免各自写一份常量。 */
  get requestTimeoutMs(): number {
    return TRAE_CN_REQUEST_TIMEOUT_MS
  }
}

/**
 * 判定 exchange 失败是否属于**终态**（refresh_token 失效，需重新登录）。
 *
 * 只认 HTTP 401/403 与明确的凭据缺失：
 * - 网络失败（`网络失败` 前缀）—— 不是终态，交给调度器重试；
 * - 5xx / 429 —— 不是终态；
 * - 响应里找不到 access token —— 终态：拿到成功码却没有令牌，
 *   重试同样拿不到（对齐 LobsterAI 的 `refresh_failed` 语义）。
 */
function isTraeCnTerminalFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (/网络失败/.test(error.message)) return false
  const status = /HTTP (\d{3})/.exec(error.message)
  if (status !== null) {
    const code = Number(status[1])
    return code === 401 || code === 403
  }
  return /找不到 access token/.test(error.message)
}
