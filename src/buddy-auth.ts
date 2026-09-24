/**
 * Buddy (腾讯 Buddy CN / Buddy) 认证服务
 *
 * 管理 external-link-v2 轮询式登录、凭据存储与 RefreshScheduler 静默续期，
 * 结构与 CodeArtsAuth 保持一致（同样的调度语义、同样的登出竞态保护）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  credentialExpiresAtMs,
  isExpired,
  isRefreshable,
} from './buddy.js'
import {
  RefreshTokenExpiredError,
  fetchModels,
  refreshToken,
  runBuddyLoginFlow,
  type BuddyLoginFlowOptions,
} from './buddy-oauth.js'
import { RefreshScheduler } from './refresh.js'
import type { BuddyCredential, BuddyRemoteModel } from './buddy.js'
import { AccountPool } from './account-pool.js'
import { assertCredentialOwnership } from './credential-ownership.js'
import { BUDDY_CN, type BuddyProduct } from './product.js'

/**
 * Buddy CN 的登录结果存储所用的凭据引用。
 *
 * 直接取自 `BUDDY_CN.defaultCredentialRef`（产品配置是唯一真相源），保留此
 * 导出仅为兼容既有导入方；新代码请改用 `BuddyAuth` 实例的 `credentialRefName`
 * 字段（随产品变化）。
 */
export const BUDDY_CREDENTIAL_REF = BUDDY_CN.defaultCredentialRef

/** 一次成功登录的结果。 */
export interface BuddyLoginResult {
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
export interface BuddyLoginStatus {
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
    buddyCnAuth: BuddyAuth
    /**
     * Buddy（国际版）的认证服务实例。
     *
     * 与 `buddyCnAuth`（Buddy CN）并列存在：cordis 的 `Service` 构造时按名称
     * 注册，同名第二次注册会抛 `service "buddyCnAuth" has been registered`，
     * 故两个产品必须各占一个服务名。
     */
    buddyAuth: BuddyAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(value) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** Buddy 登录服务：轮询式登录 + refresh_token 静默续期。 */
export class BuddyAuth extends Service {
  /** 本实例所属的产品配置（Buddy CN 或 Buddy）。 */
  readonly product: BuddyProduct

  /**
   * 本实例默认读写的凭据 ref 名称。
   * Buddy CN 为 `BUDDY_CN_ACCESS_TOKEN`，Buddy 为 `BUDDY_ACCESS_TOKEN`；
   * 两个产品各自读写自己的 ref，凭据互不可见。
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

  constructor(
    ctx: Context,
    private readonly options: { fetcher?: typeof fetch; product?: BuddyProduct; serviceName?: string } = {},
  ) {
    // 默认 Buddy CN，保证既有行为完全不变。
    const product = options.product ?? BUDDY_CN
    // 服务名必须随产品区分：cordis 的 Service 在构造时按名称注册，同名第二次
    // 注册会抛 `service "buddyCnAuth" has been registered at <root>`，而
    // Buddy CN 与 Buddy 需要同时存在两个实例。服务名由产品配置的 serviceName
    // **显式给出**（`buddy-cn` 机械派生会得到非标识符风格的 `buddy-cnAuth`，
    // 与 TraeCnAuth 是同一先例）；显式传入 serviceName 可覆盖。
    super(ctx, options.serviceName ?? product.serviceName)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /** 运行登录流程并持久化凭据。 */
  async login(flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & BuddyLoginFlowOptions = {}): Promise<BuddyLoginResult> {
    this.active = true
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName)
    const flow = await runBuddyLoginFlow({
      ...this.options.fetcher !== undefined ? { fetcher: this.options.fetcher } : {},
      ...flowOptions,
      // 产品配置决定 auth/state 的 platform 与登录 URL 附加参数：调用方显式传入优先，
      // 否则用本实例的产品（Buddy 实例不会退回 Buddy CN）。
      product: flowOptions.product ?? this.product,
    })
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时自动注册到 pool
    if (flowOptions.accountId && flowOptions.pool) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        nickname: flowOptions.accountId,
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
        refreshable: Boolean(credential) && isRefreshable(credential!),
      })
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential) && isRefreshable(credential!),
    }
  }

  /**
   * 保存凭据并注册到账号池（供后台登录流程使用）。
   * 账号池已预先创建占位条目时，只做凭据写入和更新。
   *
   * ## 归属闸门在这里同样必须过（本方法是 buddy 系的**第二条**写凭据入口）
   *
   * `runBuddyLoginFlow` 是正常登录链的产出点（闸门已在它返回处），但本方法
   * 接受**任意** `credentialJson` 直接落盘 —— 它是一条独立入口，不经过那条链。
   * 不设闸门就等于留了一条「绕过校验写凭据」的路：将来任何调用方（或误用）
   * 都能把国际版凭据写进 CN 的 ref，正是本次要堵的缺口形态。
   *
   * 判定放在 `ctx.credentials.set` **之前** —— 这就是「错配时凭据不落盘」的
   * 实现方式。与登录链共用同一份判据（`credential-ownership.ts`），不存在
   * 两处标准不一致的可能。
   *
   * @throws {CredentialProductMismatchError} 凭据被确凿判定属于另一个产品。
   */
  async saveCredential(credentialJson: string, refName: string, accountId: string, pool: AccountPool): Promise<void> {
    this.active = true
    const ref = credentialRef(refName)
    // 判不出归属（无 iss、domain 也不认识）时放行：同登录链的失败开放语义。
    assertCredentialOwnership(this.product, parseCredential(credentialJson) ?? {})
    await this.ctx.credentials.set(ref, credentialJson)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseCredential(credentialJson)
    if (accountId && pool) {
      await pool.updateAccount(accountId, {
        nickname: credential?.nickname ?? accountId,
        expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
        refreshable: Boolean(credential) && isRefreshable(credential!),
      })
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<BuddyLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = credentialExpiresAtMs(credential)
        refreshable = isRefreshable(credential) && !this.refreshTokenInvalid
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
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      // 第 4 个参数是本实例的产品：Buddy 续期时必须带自己的 UA，
      // 否则会以 Buddy CN 的身份标识请求刷新接口。
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      // 手动 refresh()（或 llm-adapter 触发）遇 refresh_token 失效同样更新状态，
      // 供 /buddy-status 展示 refreshable: false 与重新登录提示。
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 用给定凭据换新令牌并合并字段（不触碰存储、调度器与错误状态）。
   *
   * 抽出来供 {@link refresh} 与 {@link refreshAccountCredential} 共用，
   * 避免两处各写一遍「换 token → 合并字段」而逐渐分叉。
   */
  private async refreshCredential(credential: BuddyCredential): Promise<BuddyCredential> {
    const token = await refreshToken(credential, this.fetchImpl, undefined, this.product)
    return {
      ...credential,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: token.expiresAt,
      refresh_expires_at: token.refreshExpiresAt,
      token_type: token.tokenType,
      scope: token.scope,
      // 后端未返回 domain 时保留原值。
      ...token.domain.length > 0 ? { domain: token.domain } : {},
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（这是修复既有缺陷的关键）：
   * - `refresh()` 读写的是本实例的**默认单凭据 ref**（如 `BUDDY_CN_ACCESS_TOKEN`），
   *   而 Account Hub 的账号卡片对应的是 `BUDDY_CN_ACCOUNT_XXX` ——
   *   用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据；
   * - 本方法也**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   *   那些状态属于「单凭据路径」，被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
   * **自动选号**，不该让凭据烂掉。早期实现是 `if (!entry.enabled || !entry.refreshable)`，
   * 停用账号被跳过续期，refresh_token 一路放到失效 —— 用户重新启用后拿到的是
   * 一个死凭据，**无法自动恢复**，只能重新登录（真实缺陷）。
   *
   * 单账号失败不影响其他账号。
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
        const credential = parseCredential(resolved.value)
        if (!credential || !isRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const refreshed = await this.refreshCredential(credential)
        await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
        const expiresAt = credentialExpiresAtMs(refreshed)
        await pool.updateAccount(entry.id, {
          expiresAt: expiresAt ?? undefined,
          refreshable: isRefreshable(refreshed),
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
      const credential = parseCredential(resolved.value)
      if (!credential || !isRefreshable(credential)) return
      const expiresAt = credentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isExpired(credential)
  }

  /**
   * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
   * 失败或未登录时返回空数组（调用方回退到内置列表）。
   *
   * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
   *
   * **关键**：两处调用都必须把 `this.product` 传给 `fetchModels`，否则
   * Buddy 实例（Task 7 的 `fetchRemoteModels: () => buddy.fetchModels(pool)`）
   * 会以 `X-Product-Code: codebuddy` + Buddy CN 的 UA 请求 /v3/config，
   * 即携带另一个产品的身份标识。
   */
  async fetchModels(pool?: AccountPool): Promise<BuddyRemoteModel[]> {
    // 优先账号池
    if (pool) {
      const available = await pool.getAvailableAccount(this.product.id, '')
      if (available) return fetchModels(available.credential as BuddyCredential, this.fetchImpl, undefined, this.product)
    }
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return []
    const credential = parseCredential(resolved.value)
    if (!credential) return []
    return fetchModels(credential, this.fetchImpl, undefined, this.product)
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }
}
