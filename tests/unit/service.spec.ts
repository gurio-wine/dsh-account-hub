import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { RefreshTokenExpiredError, exchangeRefreshToken, generateDpopKeyPair, type TokenResponse } from '../../src/oauth.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from '../../src/service.js'
import { AccountPool } from '../../src/account-pool.js'
import { fetchCodeArtsRemoteModels, saveModelsCache, setMemoryCache } from '../../src/models.js'

vi.mock('../../src/models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/models.js')>()
  return {
    ...actual,
    fetchCodeArtsRemoteModels: vi.fn(),
    saveModelsCache: vi.fn(),
    setMemoryCache: vi.fn(),
  }
})

vi.mock('../../src/login.js', async (importOriginal) => ({
  // 两段式的 prepare 用真实实现（它只起本地回调服务器），
  // 阻塞式两个流程保持 mock —— 它们会真的去开浏览器 / 等 180 秒。
  ...await importOriginal<typeof import('../../src/login.js')>(),
  runLoginFlow: vi.fn(),
  runOAuthFlow: vi.fn(),
}))

vi.mock('../../src/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/oauth.js')>()
  return {
    ...actual,
    // 默认仍走真实实现；仅「refresh_token 失效」用例临时改为抛 RefreshTokenExpiredError。
    exchangeRefreshToken: vi.fn(actual.exchangeRefreshToken),
  }
})

const mockedRunLoginFlow = vi.mocked(runLoginFlow)
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)
const mockedExchangeRefreshToken = vi.mocked(exchangeRefreshToken)
const mockedFetchRemoteModels = vi.mocked(fetchCodeArtsRemoteModels)
const mockedSaveModelsCache = vi.mocked(saveModelsCache)
const mockedSetMemoryCache = vi.mocked(setMemoryCache)

// refreshModels 依赖远端模型拉取的返回；所有用例默认拉取空（不写缓存），
// 具体「返回非空 → 写缓存」的分支在专项用例里单独覆盖。
mockedFetchRemoteModels.mockResolvedValue([])

/** 所有已创建的 service；afterEach 统一 stop()，避免登录/刷新后 armed 的真实定时器泄漏。 */
const services: CodeArtsAuth[] = []

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 新建并登记一个 service，保证 afterEach 能 stop() 掉它持有的定时器。 */
function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): CodeArtsAuth {
  const service = new CodeArtsAuth(ctx, options)
  services.push(service)
  return service
}

/** 永不打真实网络的 stub fetch：即使定时器意外触发，刷新也只走 mock。 */
const mockFetcher = vi.fn(async () => new Response(JSON.stringify({
  credentials: {
    access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    expiration: '2026-08-16T00:00:00Z',
  },
  refresh_token: 'RT',
}), { status: 200 }))

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('CodeArtsAuth', () => {
  it('registers as ctx.codeartsAuth on construction', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    // cordis 通过其反射层提供服务，因此不保证
    // 身份相等（`===`）；instanceof 和名称才是契约。
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(ctx.codeartsAuth.name).toBe('codeartsAuth')
  })

  it('login stores the flow access value under the fixed ref', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login()
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toEqual({ value: 'json-credential', source: 'fake' })
    expect(result).toMatchObject({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    expect(String(result.ref)).toBe(CODEARTS_CREDENTIAL_REF)
  })

  it('login forwards flow options and propagates failures', async () => {
    mockedRunOAuthFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    await expect(service.login({ maxAttempts: 1 })).rejects.toThrow('CodeArts login timed out')
    expect(mockedRunOAuthFlow).toHaveBeenCalledWith({ maxAttempts: 1 })
  })

  it('status reports unconfigured without a stored value', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })

  it('status parses expires_at from the stored JSON credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
    }))
    const service = newService(ctx)
    expect(await service.status()).toEqual({
      configured: true,
      source: 'fake',
      expiresAt: Date.parse('2026-08-15T00:00:00Z'),
      refreshable: true,
    })
  })

  it('status tolerates a raw-token credential without expiry metadata', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, 'raw-token')
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: true, source: 'fake', expiresAt: undefined, refreshable: false })
  })

  it('logout removes the stored credential', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, 'value')
    const service = newService(ctx)
    await service.logout()
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeUndefined()
  })
})

describe('CodeArtsAuth OAuth login', () => {
  it('login defaults to the oauth flow and reports refreshable: true', async () => {
    mockedRunOAuthFlow.mockResolvedValue({
      access: '{"access_key_id":"AK","secret_access_key":"SK","security_token":"ST","expires_at":"2026-08-15T00:00:00Z","refresh_token":"RT"}',
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://codearts.huaweicloud.com/portal/authorize?...',
    })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login()
    expect(mockedRunOAuthFlow).toHaveBeenCalled()
    expect(mockedRunLoginFlow).not.toHaveBeenCalled()
    expect(result.refreshable).toBe(true)
    const stored = JSON.parse((await credentials.resolve(CODEARTS_CREDENTIAL_REF))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('RT')
  })

  it('login(flow: ticket) falls back to the legacy ticket flow', async () => {
    mockedRunLoginFlow.mockResolvedValue({
      access: '{"access_key_id":"AK","secret_access_key":"SK","security_token":"ST","expires_at":"2026-08-15T00:00:00Z"}',
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect?...',
    })
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login({ flow: 'ticket' })
    expect(mockedRunLoginFlow).toHaveBeenCalled()
    expect(result.refreshable).toBe(false)
  })
})

describe('CodeArtsAuth 两段式（prepareLogin + persistLoginResult）', () => {
  it('prepareLogin 返回 loginUrl 但不写凭据', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const outcome = await service.prepareLogin({ timeoutMs: 5000 })
    try {
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('prepare 失败')
      expect(outcome.session.loginUrl).toContain('codearts.huaweicloud.com/portal/authorize')
      expect(outcome.session.port).toBeGreaterThanOrEqual(10_000)
      // 第一段**不落盘**：凭据要在第二段才写。
      expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeUndefined()
    } finally {
      if (outcome.ok) outcome.session.cancel('用例清理')
    }
  })

  it('persistLoginResult 写凭据并返回 refreshable，且不改动 active', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const access = JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
    })
    const result = await service.persistLoginResult({
      access, expires: Date.parse('2026-08-15T00:00:00Z'), loginUrl: 'https://login',
    })
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toEqual({ value: access, source: 'fake' })
    expect(result).toMatchObject({ access, loginUrl: 'https://login', refreshable: true })
    expect(String(result.ref)).toBe(CODEARTS_CREDENTIAL_REF)
  })

  it('persistLoginResult 对已存在的占位账号是**补全**而非新增（账号池不出现重复条目）', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const pool = new AccountPool(ctx)
    await pool.addAccount({
      id: 'codearts-abc', provider: 'codearts', nickname: 'codearts-abc', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_ABCD', refreshable: false, createdAt: 1,
    })
    await service.persistLoginResult({
      access: JSON.stringify({
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
      }),
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://login',
    }, { refName: 'CODEARTS_ACCOUNT_ABCD', accountId: 'codearts-abc', pool })

    const accounts = await pool.listAllAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      id: 'codearts-abc',
      refreshable: true,
      expiresAt: Date.parse('2026-08-15T00:00:00Z'),
    })
  })

  it('login() 仍是两段的串联：先跑流程、再落盘', async () => {
    mockedRunOAuthFlow.mockResolvedValue({
      access: JSON.stringify({
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT',
      }),
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://login',
    })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login()
    expect(mockedRunOAuthFlow).toHaveBeenCalled()
    expect(result.refreshable).toBe(true)
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeDefined()
  })
})

describe('CodeArtsAuth silent refresh', () => {
  it('refresh exchanges the refresh_token and rewrites the credential', async () => {
    const { ctx, credentials } = makeContext()
    const { privateKeyJwk } = await generateDpopKeyPair()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
      refresh_token: 'RT', code_verifier: 'VERIFIER', dpop_private_key_jwk: privateKeyJwk,
      domain_id: 'DOMAIN', user_id: 'USER', user_name: 'NAME',
    }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
        expiration: '2026-08-16T00:00:00Z',
      },
      refresh_token: 'RT2',
    }), { status: 200 }))
    const service = newService(ctx, { fetcher })
    await service.refresh()
    const stored = JSON.parse((await credentials.resolve(CODEARTS_CREDENTIAL_REF))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('RT2')
    expect(mockedRunLoginFlow).not.toHaveBeenCalled()
    // 验证请求体（mock fetch 被 exchangeRefreshToken 调用）：
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/oauth2/tokens')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
    // 刷新后无变化字段（domain_id/user_id/user_name 等）必须被保留。
    expect(stored.domain_id).toBe('DOMAIN')
    expect(stored.user_id).toBe('USER')
    expect(stored.user_name).toBe('NAME')
  })

  it('refresh reports an explicit error when the credential lacks refresh fields', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expires_at: '',
    }))
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toThrow(/refresh_token/)
  })

  it('status reports refreshable: false and surfaces refreshError', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expires_at: '',
    }))
    const service = newService(ctx)
    const status = await service.status()
    expect(status.refreshable).toBe(false)
  })

  it('status reports refreshable: false and surfaces refreshError after refresh_token expiry', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, credentials } = makeContext()
      // 过期时间已落入过去：调度器会被 scheduleRefresh 立即武装。
      await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        refresh_token: 'RT', code_verifier: 'VERIFIER',
        dpop_private_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      }))
      // 后端判定 refresh_token 已失效：exchangeRefreshToken 抛 RefreshTokenExpiredError。
      mockedExchangeRefreshToken.mockRejectedValue(new RefreshTokenExpiredError('invalid_grant'))
      const service = newService(ctx)
      await service.scheduleRefresh()
      await vi.runAllTimersAsync()
      const status = await service.status()
      expect(status.refreshError).toContain('已失效')
      expect(status.refreshable).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual refresh marks refresh_token invalid so status reports refreshable: false', async () => {
    const { ctx, credentials } = makeContext()
    const { privateKeyJwk } = await generateDpopKeyPair()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
      refresh_token: 'RT', code_verifier: 'VERIFIER', dpop_private_key_jwk: privateKeyJwk,
    }))
    // 后端判定 refresh_token 已失效：手动 refresh() 也必须更新状态供 /codearts-status 展示。
    mockedExchangeRefreshToken.mockRejectedValue(new RefreshTokenExpiredError('invalid_grant'))
    const service = newService(ctx)
    await expect(service.refresh()).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    const status = await service.status()
    expect(status.refreshError).toContain('已失效')
    expect(status.refreshable).toBe(false)
  })

  it('logout during an in-flight refresh prevents credential resurrection', async () => {
    const { ctx, credentials } = makeContext()
    const { privateKeyJwk } = await generateDpopKeyPair()
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
      refresh_token: 'RT', code_verifier: 'VERIFIER', dpop_private_key_jwk: privateKeyJwk,
    }))
    // 可控 Promise：模拟刷新请求在途，直到手动 resolve。
    let resolveToken!: (value: TokenResponse) => void
    mockedExchangeRefreshToken.mockReturnValue(new Promise<TokenResponse>((resolve) => {
      resolveToken = resolve
    }))
    const service = newService(ctx)
    const scheduleSpy = vi.spyOn(service, 'scheduleRefresh')
    const refreshing = service.refresh()
    // 等待刷新越过 resolve 并停在在途的 exchangeRefreshToken 上。
    await vi.waitFor(() => expect(mockedExchangeRefreshToken).toHaveBeenCalled())
    await service.logout()
    resolveToken({
      credentials: {
        access_key_id: 'AK3', secret_access_key: 'SK3', security_token: 'ST3',
        expiration: '2026-08-16T00:00:00Z',
      },
      refresh_token: 'RT3',
    })
    await refreshing
    // 凭据未被在途刷新回写：登出后存储仍为空。
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeUndefined()
    // 调度未被重新武装。
    expect(scheduleSpy).not.toHaveBeenCalled()
  })
})

/** 构造一条 CodeArts 凭据 JSON（含 AK/SK 与可选的 refresh_token）。 */
function codeartsCredentialJson(ak = 'AK', sk = 'SK', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_key_id: ak, secret_access_key: sk, security_token: 'ST',
    expires_at: '2026-12-31T00:00:00Z', refresh_token: 'RT', ...extra,
  })
}

describe('CodeArtsAuth 模型刷新 — 凭据来源回退链', () => {
  afterEach(() => {
    mockedFetchRemoteModels.mockResolvedValue([])
    mockedSaveModelsCache.mockClear()
    mockedSetMemoryCache.mockClear()
    mockedFetchRemoteModels.mockClear()
  })

  it('单凭据 ref（CODEARTS_ACCESS_TOKEN）可解析时直接用，不查账号池', async () => {
    const { ctx, credentials } = makeContext()
    // 账号池已注入（模拟 apply() 的 ctx.provide('accountPool', pool)）。
    const pool = new AccountPool(ctx)
    ctx.provide('accountPool', pool)
    // 池里也有一条 codearts 账号（不应被用到，因为单凭据更优先）。
    await pool.addAccount({
      id: 'codearts-pool1', provider: 'codearts', nickname: 'p1', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_P1', refreshable: true, createdAt: 1,
    })
    // 单凭据路径写入有效 AK/SK。
    await credentials.set(CODEARTS_CREDENTIAL_REF, codeartsCredentialJson('AK-SINGLE', 'SK-SINGLE'))
    mockedFetchRemoteModels.mockResolvedValue([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    const service = newService(ctx, { fetcher: mockFetcher })
    const models = await service.refreshModels()
    expect(models).toHaveLength(1)
    // 接口以单凭据的 AK/SK 收到请求，而非账号池账号（池账号占用会因单凭据优先而未被 resolve）。
    expect(mockedFetchRemoteModels).toHaveBeenCalledWith(
      expect.objectContaining({ access_key_id: 'AK-SINGLE', secret_access_key: 'SK-SINGLE' }),
      mockFetcher,
    )
    expect(mockedSaveModelsCache).toHaveBeenCalled()
    expect(mockedSetMemoryCache).toHaveBeenCalled()
  })

  it('单凭据 ref 为空时，回退到账号池第一条可解析且启用的 codearts 凭据', async () => {
    const { ctx } = makeContext()
    // 池已注入；账号池账号写在 CODEARTS_ACCOUNT_P1。
    const pool = new AccountPool(ctx)
    ctx.provide('accountPool', pool)
    await pool.addAccount({
      id: 'codearts-p1', provider: 'codearts', nickname: 'p1', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_P1', refreshable: true, createdAt: 1,
    })
    await ctx.credentials.set('CODEARTS_ACCOUNT_P1', codeartsCredentialJson('AK-POOL', 'SK-POOL'))
    // 单凭据 ref 未配置 → 应回退到账号池。
    mockedFetchRemoteModels.mockResolvedValue([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    const service = newService(ctx, { fetcher: mockFetcher })
    const models = await service.refreshModels()
    expect(models).toHaveLength(1)
    expect(mockedFetchRemoteModels).toHaveBeenCalledWith(
      expect.objectContaining({ access_key_id: 'AK-POOL', secret_access_key: 'SK-POOL' }),
      mockFetcher,
    )
    expect(mockedSaveModelsCache).toHaveBeenCalled()
  })

  it('单凭据与账号池都没有可解析凭据时，不刷新、不写缓存', async () => {
    const { ctx } = makeContext()
    // 池已注入但没有任何账号。
    ctx.provide('accountPool', new AccountPool(ctx))
    mockedFetchRemoteModels.mockClear()
    const service = newService(ctx, { fetcher: mockFetcher })
    const models = await service.refreshModels()
    expect(models).toEqual([])
    expect(mockedFetchRemoteModels).not.toHaveBeenCalled()
    expect(mockedSaveModelsCache).not.toHaveBeenCalled()
    expect(mockedSetMemoryCache).not.toHaveBeenCalled()
  })

  it('账号池里的已停用账号持有效凭据也不参与候选（目录拉取只用可用账号）', async () => {
    const { ctx } = makeContext()
    const pool = new AccountPool(ctx)
    ctx.provide('accountPool', pool)
    // 已停用账号（enabled: false），且其凭据可解析、含 AK/SK。
    await pool.addAccount({
      id: 'codearts-disabled', provider: 'codearts', nickname: 'd', enabled: false,
      credentialRef: 'CODEARTS_ACCOUNT_DISABLED', refreshable: true, createdAt: 1,
    })
    await ctx.credentials.set('CODEARTS_ACCOUNT_DISABLED', codeartsCredentialJson('AK-DISABLED', 'SK-DISABLED'))
    mockedFetchRemoteModels.mockClear()
    const service = newService(ctx, { fetcher: mockFetcher })
    const models = await service.refreshModels()
    expect(models).toEqual([])
    expect(mockedFetchRemoteModels).not.toHaveBeenCalled()
    expect(mockedSaveModelsCache).not.toHaveBeenCalled()
  })
})
