import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  prepareCodeartsLogin,
  runLoginFlow,
  runOAuthFlow,
  type CodeartsLoginPrepareOptions,
  type CodeartsLoginPrepareOutcome,
} from './login.js'
import {
  RefreshTokenExpiredError,
  RefreshTokenReusedError,
  credentialFromTokenResponse,
  exchangeRefreshToken,
  keyPairFromStoredJwk,
  type TokenResponse,
} from './oauth.js'
import { RefreshScheduler } from './refresh.js'
import type { CodeArtsCredential, LoginFlowOptions, LoginFlowResult, ProviderAccountEntry } from './types.js'
import { AccountPool } from './account-pool.js'
import {
  fetchCodeArtsRemoteModels,
  MODEL_REFRESH_INTERVAL_MS,
  saveModelsCache,
  setMemoryCache,
} from './models.js'

/** CodeArts 登录结果存储所用的凭据引用。 */
export const CODEARTS_CREDENTIAL_REF = 'CODEARTS_ACCESS_TOKEN'

/** 一次成功登录的结果。 */
export interface LoginResult {
  /** 已存储的凭据值（原始令牌或 JSON 凭据字符串）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token（新式 OAuth 流程为 true）。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface LoginStatus {
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
    codeartsAuth: CodeArtsAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): CodeArtsCredential | undefined {
  try {
    return JSON.parse(value) as CodeArtsCredential
  } catch {
    return undefined
  }
}

/**
 * 用一份凭据去换令牌；若后端回「refresh_token 已被使用」（`STS5.1806`），
 * **重读存储再试一次**。
 *
 * ## 为什么「已被使用」值得重试
 *
 * 刷新令牌是**一次性轮换**的：每次成功续期都会作废旧令牌、下发新令牌。当两条
 * 路径并发续期同一份凭据时（例如 30 分钟批量续期与适配器的鉴权失败兜底同时
 * 触发），先到的那条会消费掉令牌并写回新凭据，后到的那条必然拿到「已被使用」。
 * 此时存储里躺着一份**完全可用**的新凭据 —— 直接判失败（更别说判终态、要求
 * 重新登录）是错的。
 *
 * ## 判据是「令牌真的变了吗」
 *
 * 只有重读到的 `refresh_token` **与本次使用的那份不同**才值得再试：相同就说明
 * 没有并发消费者，这个「已被使用」是该令牌自身的历史问题，重试只会再撞一次墙。
 * 因此**最多重试一次**，且重试前必须比对令牌。
 *
 * @param credential - 本次要用的凭据（调用方已确保三个字段齐全）。
 * @param resolveAgain - 重新解析同一 ref 的最新值（账号路径与单凭据路径共用本函数）。
 * @param fetcher - 注入的 fetch（测试可替换）。
 * @returns 令牌响应，以及**实际生效的那份凭据**（重试时是重读所得的新凭据）。
 *   调用方必须用返回的 `used` 去组装落盘凭据：它携带与本次兑换配对的
 *   `code_verifier` 与 DPoP 私钥，用旧那份组装会在二者被轮换时写出坏凭据。
 */
async function exchangeWithReuseRetry(
  credential: CodeArtsCredential,
  resolveAgain: () => Promise<CodeArtsCredential | undefined>,
  fetcher: typeof fetch,
): Promise<{ token: TokenResponse; used: CodeArtsCredential }> {
  const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk!)
  try {
    const token = await exchangeRefreshToken(credential.refresh_token!, credential.code_verifier!, keyPair, fetcher)
    return { token, used: credential }
  } catch (error) {
    if (!(error instanceof RefreshTokenReusedError)) throw error
    const latest = await resolveAgain()
    // 没有并发消费者（令牌没变）、或新值不完整 ⇒ 原样抛出，交由失败分类处理。
    if (latest?.refresh_token === undefined || latest.refresh_token === credential.refresh_token) throw error
    if (latest.code_verifier === undefined || latest.dpop_private_key_jwk === undefined) throw error
    // 用别人写回的新令牌重试**一次**（不再递归：一次性轮换下二次撞车没有意义）。
    const retryKeyPair = keyPairFromStoredJwk(latest.dpop_private_key_jwk)
    const token = await exchangeRefreshToken(latest.refresh_token, latest.code_verifier, retryKeyPair, fetcher)
    return { token, used: latest }
  }
}

/** CodeArts 登录服务：默认新式 IAM OAuth，ticket 流程回退，refresh_token 静默续期。 */
export class CodeArtsAuth extends Service {
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
  /** refresh_token 已被后端判定失效（InvalidGrant）；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true
  /** 远端模型列表定时刷新定时器。 */
  private modelRefreshTimer: ReturnType<typeof setInterval> | undefined
  /** 用于测试的可注入 fetch；默认为全局 fetch。 */
  private fetchImpl: typeof fetch = fetch

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  constructor(ctx: Context, options: { fetcher?: typeof fetch } = {}) {
    super(ctx, 'codeartsAuth')
    if (options.fetcher) this.fetchImpl = options.fetcher
  }

  /**
   * 运行登录流程（默认新式 OAuth；flow: 'ticket' 走旧流程回退）并持久化凭据。
   *
   * **阻塞式**：会一直等到用户在浏览器完成授权（最长 180 秒）。
   * Account Hub 用的是两段式 {@link prepareLogin} + {@link persistLoginResult}，
   * 以便 RPC 立即返回登录 URL、不阻塞客户端；`/codearts-login` 命令与 e2e
   * 探针等同步调用方继续用这里。
   *
   * 第一段（跑流程拿到 `LoginFlowResult`）与第二段（落盘）已拆开，
   * 本方法只是二者的串联 —— 两段式的后台路径复用同一个第二段。
   */
  async login(options: { flow?: 'oauth' | 'ticket'; refName?: string; accountId?: string; pool?: AccountPool } & LoginFlowOptions = {}): Promise<LoginResult> {
    this.active = true
    const flow: LoginFlowResult = options.flow === 'ticket'
      ? await runLoginFlow(options)
      : await runOAuthFlow(options)
    return this.persistLoginResult(flow, options)
  }

  /**
   * 两段式的**第一段**：准备一次新式 IAM OAuth 登录，返回登录 URL 与会话句柄。
   *
   * 只做「生成 PKCE/DPoP + 起本地回调服务器」，**不打开浏览器、不等待用户**。
   * 调用方应立即把 `session.loginUrl` 交给客户端弹窗（用户手势必须发生在
   * 同一轮交互里），随后用 {@link persistLoginResult} 在后台消费
   * `session.awaitCredential()` 的结果。
   *
   * 这里**不写凭据、不动账号池** —— 凭据落盘与占位账号的补全由
   * {@link persistLoginResult} 负责。
   *
   * 已有进行中的会话时返回 `login-in-progress`（provider 级互斥：
   * 不新建监听、不复用旧会话）；调用方应把该错误原样透传给客户端提示用户。
   */
  async prepareLogin(options: CodeartsLoginPrepareOptions = {}): Promise<CodeartsLoginPrepareOutcome> {
    // 会话出现即视为「本次登录有效」：清掉上一次的失效标记，
    // 否则 status() 会一直显示旧的 refresh_token 失效提示。
    this.active = true
    return prepareCodeartsLogin(options)
  }

  /**
   * 两段式的**第二段**：把一个已完成的登录结果落盘（凭据 + 账号池）。
   *
   * 时序约束（不可调换）：
   * 1. `expiresAt` / `refreshable` 都来自换取的凭据，流程返回前无法得知，
   *    因此占位账号只能以「pending 形态」存在（无 `expiresAt`、
   *    `refreshable: false`）；
   * 2. 先把凭据写入 `ctx.credentials`，**再**补全账号条目 —— 客户端轮询的
   *    `login.poll` 以「该 ref 能否解析到凭据」为完成判据，反过来（先补全
   *    账号字段再写凭据）会让轮询在凭据就绪前就报成功。
   *
   * `accountId` + `pool` 提供时**按 id 落位**：账号已存在（两段式的占位条目）
   * 就补全，不存在（直接调用 `login()` 的注册路径）就新建 —— 用一次查找
   * 决定走哪条，避免「先 addAccount 占位、第二段再 addAccount 补全」把
   * 同一个 id 写成账号池里的两条记录。
   *
   * 不触碰 `active`：那是「登出竞态」的开关（见 {@link refresh}），
   * 由 {@link login} / {@link prepareLogin} 在会话开始时置位。
   */
  async persistLoginResult(
    flow: LoginFlowResult,
    options: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<LoginResult> {
    const ref = options.refName ? credentialRef(options.refName) : credentialRef(CODEARTS_CREDENTIAL_REF)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    // ⚠️ **只在单凭据登录时武装调度器**（判据见 {@link scheduleRefresh}）：
    // 池内账号写的是 `CODEARTS_ACCOUNT_XXX`，而调度器的回调 `refresh()` 读写
    // `CODEARTS_ACCESS_TOKEN` —— 对它武装等于「按一个与本次登录无关的凭据
    // 安排续期」。池内账号由 `refreshAll(pool)` 的 30 分钟定时器兜住。
    if (options.refName === undefined) this.scheduleRefresh()
    void this.refreshModels()
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时落位到账号池的一条记录（占位则补全，否则新建）。
    if (options.accountId && options.pool) {
      const expiresAt = credential?.expires_at ? Date.parse(credential.expires_at) : undefined
      const existing = (await options.pool.listAllAccounts()).find((a) => a.id === options.accountId)
      if (existing) {
        await options.pool.updateAccount(options.accountId, {
          nickname: options.accountId,
          expiresAt: expiresAt !== undefined && !Number.isNaN(expiresAt) ? expiresAt : undefined,
          refreshable: Boolean(credential?.refresh_token),
        })
      } else {
        await options.pool.addAccount({
          id: options.accountId,
          provider: 'codearts',
          nickname: options.accountId,
          enabled: true,
          credentialRef: options.refName ?? CODEARTS_CREDENTIAL_REF,
          createdAt: Date.now(),
          expiresAt: Number.isNaN(expiresAt) ? undefined : expiresAt,
          refreshable: Boolean(credential?.refresh_token),
        })
      }
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential?.refresh_token),
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<LoginStatus> {
    const ref = credentialRef(CODEARTS_CREDENTIAL_REF)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        if (credential.expires_at) {
          const parsedDate = Date.parse(credential.expires_at)
          if (!Number.isNaN(parsedDate)) expiresAt = parsedDate
        }
        refreshable = Boolean(credential.refresh_token) && !this.refreshTokenInvalid
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

  /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
  async refresh(): Promise<void> {
    const ref = credentialRef(CODEARTS_CREDENTIAL_REF)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential?.refresh_token || !credential.code_verifier || !credential.dpop_private_key_jwk) {
      throw new Error('无 refresh_token，请重新登录')
    }
    const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk)
    try {
      const { token, used } = await exchangeWithReuseRetry(
        credential,
        async () => {
          const again = await this.ctx.credentials.resolve(ref)
          return again === undefined ? undefined : parseCredential(again.value)
        },
        this.fetchImpl,
      )
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      // ⚠️ 用 `used`（而非开头的 `credential`）组装：重试路径上真正生效的是
      // 重读所得的那份，它的 code_verifier 与 DPoP 私钥才是与本次令牌配对的。
      const usedKeyPair = used.dpop_private_key_jwk === undefined
        ? keyPair
        : keyPairFromStoredJwk(used.dpop_private_key_jwk)
      const refreshed = credentialFromTokenResponse(token, { codeVerifier: used.code_verifier ?? credential.code_verifier, codeChallenge: '' }, usedKeyPair)
      // 保留无变化字段（domain_id/user_id/user_name 等）。
      refreshed.domain_id = credential.domain_id
      refreshed.user_id = credential.user_id
      refreshed.user_name = credential.user_name
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      // 手动 refresh()（或 llm-adapter 触发）遇 refresh_token 失效同样更新状态，
      // 供 /codearts-status 展示 refreshable: false 与重新登录提示。
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
   * `refresh()` 读写的是 `CODEARTS_ACCESS_TOKEN` 这个**默认单凭据 ref**，
   * 而 Account Hub 账号卡片对应的是 `CODEARTS_ACCOUNT_XXX` ——
   * 用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseCredential(resolved.value)
    if (!credential?.refresh_token || !credential.code_verifier || !credential.dpop_private_key_jwk) {
      throw new Error('无 refresh_token，请重新登录')
    }
    const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk)
    // 同一 ref 上仍可能与本服务的批量续期并发：走同一个「已被使用 → 重读再试」。
    const { token, used } = await exchangeWithReuseRetry(
      credential,
      async () => {
        const again = await this.ctx.credentials.resolve(ref)
        return again === undefined ? undefined : parseCredential(again.value)
      },
      this.fetchImpl,
    )
    const usedKeyPair = used.dpop_private_key_jwk === undefined
      ? keyPair
      : keyPairFromStoredJwk(used.dpop_private_key_jwk)
    const refreshed = credentialFromTokenResponse(token, { codeVerifier: used.code_verifier ?? credential.code_verifier, codeChallenge: '' }, usedKeyPair)
    // 保留无变化字段（domain_id/user_id/user_name 等）。
    refreshed.domain_id = credential.domain_id
    refreshed.user_id = credential.user_id
    refreshed.user_name = credential.user_name
    if (credential.model_rate_limits) refreshed.model_rate_limits = credential.model_rate_limits
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
  }

  /**
   * 批量续期所有 codearts 账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
   * **自动选号**，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
   * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
   *
   * 单账号失败不影响其他账号。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts('codearts')
    for (const entry of accounts) {
      // 只跳过「不可续期」的账号；enabled 与续期无关（见方法注释）。
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          // 凭据缺失：标记不可续期
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseCredential(resolved.value)
        if (!credential?.refresh_token || !credential.code_verifier || !credential.dpop_private_key_jwk) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const keyPair = keyPairFromStoredJwk(credential.dpop_private_key_jwk)
        // **本函数正是「并发消费 refresh_token」的主要来源**（30 分钟一轮，
        // 可能与适配器的鉴权失败兜底、或用户手点账号卡片的「刷新」同时发生）。
        // 撞上「已被使用」时重读存储：多半是另一条路径刚写回了新凭据。
        const { token, used } = await exchangeWithReuseRetry(
          credential,
          async () => {
            const again = await this.ctx.credentials.resolve(ref)
            return again === undefined ? undefined : parseCredential(again.value)
          },
          this.fetchImpl,
        )
        const usedKeyPair = used.dpop_private_key_jwk === undefined
          ? keyPair
          : keyPairFromStoredJwk(used.dpop_private_key_jwk)
        const refreshed = credentialFromTokenResponse(token, { codeVerifier: used.code_verifier ?? credential.code_verifier, codeChallenge: '' }, usedKeyPair)
        // 保留无变化字段
        refreshed.domain_id = credential.domain_id
        refreshed.user_id = credential.user_id
        refreshed.user_name = credential.user_name
        // 保留模型重置时间
        if (credential.model_rate_limits) {
          refreshed.model_rate_limits = credential.model_rate_limits
        }
        await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
        // 更新 account entry 的过期时间与 refreshable
        const expiresAt = refreshed.expires_at ? Date.parse(refreshed.expires_at) : undefined
        await pool.updateAccount(entry.id, {
          expiresAt: expiresAt !== undefined && !Number.isNaN(expiresAt) ? expiresAt : undefined,
          refreshable: Boolean(refreshed.refresh_token),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
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
    this.stopModelRefresh()
    await this.ctx.credentials.unset(credentialRef(CODEARTS_CREDENTIAL_REF))
  }

  /** 停止刷新调度与模型刷新定时器（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
    this.stopModelRefresh()
  }

  /**
   * 按**默认单凭据 ref**（`CODEARTS_ACCESS_TOKEN`）武装续期调度器。
   *
   * ⚠️ **只能用于单凭据路径**：调度器的回调是 {@link refresh}，而它读写的正是
   * `CODEARTS_ACCESS_TOKEN`。若在**池内账号**登录后调用它，读到的会是另一个
   * ref（该默认 ref 对纯池内账号用户**根本不存在**）⇒ 要么不武装、要么按一个
   * 与本次登录无关的过期时间武装。池内账号（`CODEARTS_ACCOUNT_XXX`）的续期
   * 由 `refreshAll(pool)` 的 30 分钟定时器负责（见 `src/index.ts` 的多账号
   * 静默续期调度），**不是**这里。
   *
   * 调用点只有两处，都在本类内（不存在「由 apply 调用」——`apply()` 走的是
   * 上面那条按池遍历的批量路径）：
   * 1. {@link persistLoginResult}（**且仅当**未传 `refName`，即单凭据登录）；
   * 2. {@link refresh} 成功之后（它刚刷新了默认 ref，按新过期时间重新武装）。
   */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential?.expires_at || !credential.refresh_token) return
      const expiresAt = Date.parse(credential.expires_at)
      if (!Number.isNaN(expiresAt)) this.scheduler.arm(expiresAt)
    })
  }

  /** 启动时若已有可解析凭据则安排模型刷新（由 apply 调用）。 */
  scheduleModelRefresh(): void {
    this.stopModelRefresh()
    void this.resolveModelsCredential().then((credential) => {
      if (credential === undefined) return
      void this.refreshModels()
      this.modelRefreshTimer = setInterval(() => void this.refreshModels(), MODEL_REFRESH_INTERVAL_MS)
      if (this.modelRefreshTimer?.unref) this.modelRefreshTimer.unref()
    })
  }

  /** 停止模型刷新定时器。 */
  stopModelRefresh(): void {
    if (this.modelRefreshTimer !== undefined) {
      clearInterval(this.modelRefreshTimer)
      this.modelRefreshTimer = undefined
    }
  }

  /**
   * 解析一个可用于拉取远端模型目录、且不含 refresh_token 流出到模型的凭据。
   *
   * 凭据来源**回退链**（账号池用户走 `CODEARTS_ACCOUNT_*`，单凭据用户走
   * `CODEARTS_ACCESS_TOKEN`）：
   * 1. 默认单凭据 ref（`CODEARTS_ACCESS_TOKEN`）可解析且含 AK/SK → 用之；
   * 2. 否则从账号池的 codearts 条目里找**第一条可解析且含 AK/SK** 的凭据；
   * 3. 仍找不到 → 返回 undefined（调用方不刷新、不写缓存）。
   *
   * 刻意不走 `AccountPool.getAvailableAccount`（它只选 **enabled** 账号、还可能被
   * 限流过滤）：模型目录拉取只需**任意一条有效凭据**，与「发请求选号」语义不同；
   * 也刻意不放宽到已停用账号 —— 停用账号的凭据可能已烂，用它拉目录纯属浪费网络。
   *
   * ⚠️ 依赖账号池仅在 `ctx.accountPool` 已注入（`src/index.ts` 在 `apply()` 里
   * `ctx.provide('accountPool', pool)`）之后才可用 —— 本方法的调用点（启动定时
   * 刷新、适配器懒加载）都发生在 `apply()` 完成后，故取不到时安全降级为 undefined。
   */
  private async resolveModelsCredential(): Promise<CodeArtsCredential | undefined> {
    // 默认单凭据 ref — 单凭据登录（/codearts-login）的用户走这条路。
    const resolved = await this.ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF))
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential?.access_key_id && credential?.secret_access_key) return credential
    }
    // 账号池回退 — 多账号登录（Account Hub）的用户走这条路。
    const pool = this.ctx.accountPool
    const accounts = pool?.listAccountsByProvider('codearts') ?? []
    for (const entry of accounts) {
      if (!entry.enabled) continue
      const entryResolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      if (!entryResolved) continue
      const credential = parseCredential(entryResolved.value)
      if (credential?.access_key_id && credential?.secret_access_key) return credential
    }
    return undefined
  }

  /** 用当前凭据从远端拉取模型列表，非空时更新内存缓存与磁盘。返回模型列表（可能为空）。 */
  async refreshModels(): Promise<Array<{ id: string; name: string }>> {
    if (!this.active) return []
    const credential = await this.resolveModelsCredential()
    if (credential === undefined) return []
    const models = await fetchCodeArtsRemoteModels(credential, this.fetchImpl)
    if (models.length > 0) {
      setMemoryCache(models)
      saveModelsCache(models)
    }
    return models
  }

}
