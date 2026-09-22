import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RefreshTokenExpiredError,
  TraeCnAuth,
} from '../../src/trae-cn-auth.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: TraeCnAuth[] = []

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
  /** 测试辅助：直接读回存储内容。 */
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

function newService(
  ctx: Context,
  options: { fetcher?: typeof fetch; serviceName?: string } = {},
): TraeCnAuth {
  const service = new TraeCnAuth(ctx, options)
  services.push(service)
  return service
}

/** 造一个带 `exp`（秒）的假 JWT；只需 base64url 可解，不需要真签名。 */
function makeJwt(payload: Record<string, unknown>, expSeconds?: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    ...expSeconds === undefined ? {} : { exp: expSeconds },
    ...payload,
  })).toString('base64url')
  return `${header}.${body}.signature`
}

/** 构造一个可刷新的五件套凭据（默认 2 小时后过期）。 */
function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: makeJwt({ user_id: 'u-1' }, Math.floor(Date.now() / 1000) + 7200),
    refresh_token: 'RT-1',
    user_id: 'u-1',
    client_id: 'ono9krqynydwx5',
    device_id: 'wl2k1e2endpp32',
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    expires_at: String(Date.now() + 7_200_000),
    nickname: '测试账号',
    ...overrides,
  }
}

/** ExchangeToken 成功响应。 */
function refreshSuccess(): Response {
  const exp = Math.floor(Date.now() / 1000) + 3600
  return new Response(JSON.stringify({
    Code: 0,
    Result: { Token: makeJwt({ user_id: 'u-1' }, exp), RefreshToken: 'RT-2' },
  }), { status: 200 })
}

/** 按 URL 分派的 fetch stub（本 provider 只有一个端点，直接应答）。 */
function stubFetcher(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch
}

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('TraeCnAuth 注册与基本信息', () => {
  it('注册为 ctx.traeCnAuth（而非带连字符的 trae-cnAuth）', () => {
    const { ctx } = makeContext()
    newService(ctx)
    expect(ctx.traeCnAuth).toBeInstanceOf(TraeCnAuth)
    expect(ctx.traeCnAuth.name).toBe('traeCnAuth')
    // 带连字符的名字**不应**存在：它虽然语法合法，但要用 ctx['trae-cnAuth'] 访问。
    expect((ctx as unknown as Record<string, unknown>)['trae-cnAuth']).toBeUndefined()
  })

  it('服务名可覆盖（产品 id 与服务标识符彻底解耦）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { serviceName: 'customTraeAuth' })
    expect(service.name).toBe('customTraeAuth')
    // 覆盖后不再占用默认名 —— 解耦成立的判据。
    expect((ctx as unknown as Record<string, unknown>).traeCnAuth).toBeUndefined()
  })

  it('凭据 ref 为 TRAE_CN_ACCESS_TOKEN', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.credentialRefName).toBe('TRAE_CN_ACCESS_TOKEN')
  })

  it('绑定 Trae CN 产品配置', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.product.id).toBe('trae-cn')
    expect(service.product).toBe(TRAE_CN)
  })

  it('未配置凭据时 status 报告 configured: false', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })
})

describe('TraeCnAuth 续期', () => {
  it('成功时写回新令牌，且五件套身份字段保持不变', async () => {
    const { ctx, credentials } = makeContext()
    const credential = makeCredential()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(credential))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refresh()

    const stored = JSON.parse(credentials.raw('TRAE_CN_ACCESS_TOKEN')!) as TraeCnCredential
    expect(stored.refresh_token).toBe('RT-2')
    expect(stored.access_token).not.toBe(credential.access_token)
    // 身份字段必须保留 —— 丢了会让下一次续期失败。
    expect(stored.user_id).toBe('u-1')
    expect(stored.client_id).toBe('ono9krqynydwx5')
    expect(stored.device_id).toBe('wl2k1e2endpp32')
    expect(stored.machine_id).toBe('a'.repeat(32))
  })

  it('请求体带 refreshToken 与 UserID，且**不带** Authorization', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    let body: Record<string, unknown> = {}
    let headers: Record<string, string> = {}
    const service = newService(ctx, {
      fetcher: stubFetcher((_u, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        headers = (init?.headers ?? {}) as Record<string, string>
        return refreshSuccess()
      }),
    })

    await service.refresh()

    expect(body.RefreshToken).toBe('RT-1')
    expect(body.UserID).toBe('u-1')
    expect(body.ClientID).toBe('ono9krqynydwx5')
    // 续期时还没有新 token（服务端只认请求体里的 RefreshToken/UserID）。
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).not.toHaveProperty('X-Ide-Token')
  })

  it('POST 到 ExchangeToken 端点（不是 /refresh）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    let seenUrl = ''
    let seenMethod = ''
    const service = newService(ctx, {
      fetcher: stubFetcher((url, init) => {
        seenUrl = url
        seenMethod = init?.method ?? ''
        return refreshSuccess()
      }),
    })

    await service.refresh()

    expect(seenUrl).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(seenMethod).toBe('POST')
  })

  it('HTTP 401 抛 RefreshTokenExpiredError（终态）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 401 }), { status: 401 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('HTTP 403 抛 RefreshTokenExpiredError（终态）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 403 }), { status: 403 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('网络失败**不**判为终态（抛普通 Error，交给调度器重试）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch,
    })

    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/网络失败/)
  })

  it('5xx 不判为终态（可重试）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response('boom', { status: 500 })),
    })
    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('429 不判为终态（可重试）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response('slow down', { status: 429 })),
    })
    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('响应里找不到 access token 时判为终态（需重新登录）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 0, Result: {} }), { status: 200 })),
    })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('凭据缺 user_id 时判为终态（UserID 是 ExchangeToken 必填项）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential({ user_id: '' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refresh()).rejects.toThrow(/缺少 user_id/)
  })

  it('无 refresh_token 时直接抛终态错误', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('未配置凭据时抛错提示先登录', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('终态失败后 status().refreshable 变为 false 并带 refreshError', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 401 }), { status: 401 })),
    })
    await service.refresh().catch(() => {})
    const status = await service.status()
    expect(status.refreshable).toBe(false)
    expect(status.refreshError).toMatch(/refresh_token 已失效/)
  })

  it('登出竞态：在途刷新期间 logout 后不回写凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    let releaseRefresh!: () => void
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const service = newService(ctx, {
      fetcher: vi.fn(async () => {
        await gate
        return refreshSuccess()
      }) as unknown as typeof fetch,
    })

    const refreshing = service.refresh()
    await service.logout()
    releaseRefresh()
    await refreshing

    // 已登出：凭据不应被在途刷新复活。
    expect(credentials.raw('TRAE_CN_ACCESS_TOKEN')).toBeUndefined()
  })
})

describe('TraeCnAuth 按 ref 续期（账号卡片路径）', () => {
  it('续期指定账号的 ref，不触碰默认 ref', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential({ refresh_token: 'RT-DEFAULT' })))
    await credentials.set('TRAE_CN_ACCOUNT_AB12', JSON.stringify(makeCredential({ refresh_token: 'RT-ACCOUNT' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAccountCredential('TRAE_CN_ACCOUNT_AB12')

    const account = JSON.parse(credentials.raw('TRAE_CN_ACCOUNT_AB12')!) as TraeCnCredential
    const fallback = JSON.parse(credentials.raw('TRAE_CN_ACCESS_TOKEN')!) as TraeCnCredential
    expect(account.refresh_token).toBe('RT-2')
    // 默认 ref 必须原封不动 —— 用 refresh() 刷账号池会刷错凭据，这条锁住正确路径。
    expect(fallback.refresh_token).toBe('RT-DEFAULT')
  })

  it('凭据未配置时抛错', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    await expect(service.refreshAccountCredential('TRAE_CN_ACCOUNT_NONE')).rejects.toThrow(/凭据未配置/)
  })

  it('账号路径**不污染**单凭据路径的失效标记', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    await credentials.set('TRAE_CN_ACCOUNT_AB12', JSON.stringify(makeCredential({ refresh_token: '' })))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAccountCredential('TRAE_CN_ACCOUNT_AB12').catch(() => {})

    // 单凭据仍报告可刷新（账号池的失败不该让 UI 显示全局失效提示）。
    const status = await service.status()
    expect(status.refreshable).toBe(true)
    expect(status.refreshError).toBeUndefined()
  })
})

describe('TraeCnAuth 批量续期', () => {
  /** 最小账号池桩：只需 listAccounts / updateAccount。 */
  function makePool(accounts: Array<Record<string, unknown>>) {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    return {
      updates,
      async listAccounts(provider: string) {
        return accounts.filter((a) => a.provider === provider) as never
      },
      async updateAccount(id: string, patch: Record<string, unknown>) {
        updates.push({ id, patch })
      },
    }
  }

  /**
   * ⚠️ 本用例的语义已修正（原断言「停用账号不续期」是**缺陷**，不是规格）。
   *
   * 停用只应影响账号池的**自动选号**，与「凭据是否需要保持新鲜」无关；
   * 跳过停用账号的续期会让 refresh_token 一路放到失效，用户重新启用后
   * 只能重新登录。契约是**只按 `refreshable` 过滤**，而 **provider 必须匹配**。
   */
  it('续期 provider 匹配且 refreshable 的账号（含已停用）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCOUNT_A', JSON.stringify(makeCredential({ access_token: 'A' })))
    await credentials.set('TRAE_CN_ACCOUNT_B', JSON.stringify(makeCredential({ access_token: 'B' })))
    await credentials.set('TRAE_CN_ACCOUNT_C', JSON.stringify(makeCredential({ access_token: 'C' })))
    const pool = makePool([
      { id: 'a', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_A', enabled: true, refreshable: true },
      // 停用但可续期 → 必须同样续期（见上方说明）
      { id: 'b', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_B', enabled: false, refreshable: true },
      // 其他 provider：绝不串用
      { id: 'c', provider: 'lobsterai', credentialRef: 'TRAE_CN_ACCOUNT_C', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    const a = JSON.parse(credentials.raw('TRAE_CN_ACCOUNT_A')!) as TraeCnCredential
    expect(a.refresh_token).toBe('RT-2')
    const b = JSON.parse(credentials.raw('TRAE_CN_ACCOUNT_B')!) as TraeCnCredential
    const c = JSON.parse(credentials.raw('TRAE_CN_ACCOUNT_C')!) as TraeCnCredential
    // 停用的 B **也**应被续期；异 provider 的 C 不得被改动。
    expect(b.refresh_token, '停用账号未被续期：refreshAll 不该按 enabled 过滤').toBe('RT-2')
    expect(c.refresh_token).toBe('RT-1')
  })

  it('单账号失败不中断其他账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCOUNT_A', JSON.stringify(makeCredential()))
    await credentials.set('TRAE_CN_ACCOUNT_B', JSON.stringify(makeCredential()))
    const pool = makePool([
      { id: 'a', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_A', enabled: true, refreshable: true },
      { id: 'b', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_B', enabled: true, refreshable: true },
    ])
    let call = 0
    const service = newService(ctx, {
      fetcher: stubFetcher(() => {
        call += 1
        return call === 1 ? new Response('boom', { status: 500 }) : refreshSuccess()
      }),
    })

    await service.refreshAll(pool as never)

    const b = JSON.parse(credentials.raw('TRAE_CN_ACCOUNT_B')!) as TraeCnCredential
    expect(b.refresh_token).toBe('RT-2')
  })

  it('续期成功后回写账号的 expiresAt 与 refreshable', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCOUNT_A', JSON.stringify(makeCredential()))
    const pool = makePool([
      { id: 'a', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_A', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    expect(pool.updates).toHaveLength(1)
    expect(pool.updates[0]!.patch.refreshable).toBe(true)
    expect(typeof pool.updates[0]!.patch.expiresAt).toBe('number')
  })

  it('凭据缺失时把 refreshable 置 false', async () => {
    const { ctx } = makeContext()
    const pool = makePool([
      { id: 'a', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_MISSING', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.refreshAll(pool as never)

    expect(pool.updates).toEqual([{ id: 'a', patch: { refreshable: false } }])
  })

  it('终态失败时把该账号 refreshable 置 false', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCOUNT_A', JSON.stringify(makeCredential()))
    const pool = makePool([
      { id: 'a', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_A', enabled: true, refreshable: true },
    ])
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 401 }), { status: 401 })),
    })

    await service.refreshAll(pool as never)

    expect(pool.updates).toContainEqual({ id: 'a', patch: { refreshable: false } })
  })
})

describe('TraeCnAuth 登录与凭据管理', () => {
  it('loginWithRefreshToken 换 access 并写入五件套凭据', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    const result = await service.loginWithRefreshToken('RT-PASTED', { userId: 'u-9', machineId: 'b'.repeat(32) })

    expect(result.refreshable).toBe(true)
    expect(result.loginUrl).toBe('')
    const stored = JSON.parse(credentials.raw('TRAE_CN_ACCESS_TOKEN')!) as TraeCnCredential
    expect(stored.refresh_token).toBe('RT-2')
    expect(stored.user_id).toBe('u-9')
    expect(stored.client_id).toBe('ono9krqynydwx5')
    expect(stored.machine_id).toBe('b'.repeat(32))
    expect(stored.expires_at).toBeTruthy()
    // 续期端点不返回 BoundDeviceID，故 device_id 为空 —— **如实留空**，
    // 绝不拿 machine_id 折算一个假的 16 位设备号顶上（那是伪造设备身份）。
    expect(stored.device_id).toBe('')
  })

  it('loginWithRefreshToken 可登记进账号池', async () => {
    const { ctx } = makeContext()
    const added: Array<Record<string, unknown>> = []
    const pool = {
      async addAccount(entry: Record<string, unknown>) { added.push(entry) },
    }
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.loginWithRefreshToken('RT', {
      userId: 'u-1', refName: 'TRAE_CN_ACCOUNT_AB12', accountId: 'trae-cn-ab12', pool: pool as never,
    })

    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      id: 'trae-cn-ab12',
      provider: 'trae-cn',
      credentialRef: 'TRAE_CN_ACCOUNT_AB12',
      enabled: true,
      refreshable: true,
    })
  })

  it('status 报告 configured、过期时间与来源', async () => {
    const { ctx, credentials } = makeContext()
    const expiresAt = Date.now() + 7_200_000
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential({ expires_at: String(expiresAt) })))
    const service = newService(ctx)

    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.expiresAt).toBe(expiresAt)
    expect(status.refreshable).toBe(true)
    expect(status.source).toBe('fake')
  })

  it('logout 清除凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    await service.logout()

    expect(credentials.raw('TRAE_CN_ACCESS_TOKEN')).toBeUndefined()
    expect((await service.status()).configured).toBe(false)
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('logout 停止续期调度（在途刷新不再重新武装定时器）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    service.scheduleRefresh()
    await vi.waitFor(() => {
      expect((service as unknown as { scheduler: { timer?: unknown } }).scheduler.timer).toBeDefined()
    })

    await service.logout()

    expect((service as unknown as { scheduler: { timer?: unknown } }).scheduler.timer).toBeUndefined()
  })

  it('checkExpired 在三态下的判定', async () => {
    // 每条分支各用一个独立 Context：cordis 的服务名在同一 Context 上不可重复注册。
    // 未配置 → true
    {
      const { ctx } = makeContext()
      expect(await newService(ctx).checkExpired()).toBe(true)
    }
    // 已过期 → true
    {
      const { ctx, credentials } = makeContext()
      await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential({ expires_at: String(Date.now() - 1000) })))
      expect(await newService(ctx).checkExpired()).toBe(true)
    }
    // 有效 → false
    {
      const { ctx, credentials } = makeContext()
      await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
      expect(await newService(ctx).checkExpired()).toBe(false)
    }
  })

  it('resolveStoredCredential 解析已存五件套凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx)
    const credential = await service.resolveStoredCredential()
    expect(credential).toMatchObject({
      refresh_token: 'RT-1',
      user_id: 'u-1',
      client_id: 'ono9krqynydwx5',
      device_id: 'wl2k1e2endpp32',
    })
  })

  it('凭据 JSON 损坏时 status 不抛异常', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', '{ 损坏的 json')
    const service = newService(ctx)
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(false)
  })

  it('accessHeaders 用 Cloud-IDE-JWT（供后续适配器/签到复用）', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    const headers = service.accessHeaders(makeCredential({ access_token: 'AT-X' }))
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT-X')
    expect(headers['X-Ide-Token']).toBe('AT-X')
    expect(headers['X-Cloudide-Token']).toBe('AT-X')
    expect(service.accessHeaders(makeCredential({ access_token: 'AT-X' }), 'text/event-stream').Accept)
      .toBe('text/event-stream')
  })
})

describe('TraeCnAuth 两段式登录（prepareLogin + persistLoginResult）', () => {
  /** 最小账号池桩：persistLoginResult 走 listAllAccounts / updateAccount / addAccount。 */
  function makePersistPool(existing: Array<Record<string, unknown>> = []) {
    const added: Array<Record<string, unknown>> = []
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    return {
      added,
      updates,
      async listAllAccounts() { return existing as never },
      async addAccount(entry: Record<string, unknown>) { added.push(entry) },
      async updateAccount(id: string, patch: Record<string, unknown>) { updates.push({ id, patch }) },
    }
  }

  it('persistLoginResult 写凭据并**新建**账号（占位不存在时）', async () => {
    const { ctx, credentials } = makeContext()
    const pool = makePersistPool()
    const service = newService(ctx)
    const access = JSON.stringify(makeCredential({ nickname: '新账号' }))

    const result = await service.persistLoginResult(
      { access, expires: 123, loginUrl: 'https://login', refreshable: true },
      { refName: 'TRAE_CN_ACCOUNT_AB12', accountId: 'trae-cn-ab12', pool: pool as never },
    )

    expect(credentials.raw('TRAE_CN_ACCOUNT_AB12')).toBe(access)
    expect(result.ref).toBe('TRAE_CN_ACCOUNT_AB12')
    expect(pool.updates).toHaveLength(0)
    expect(pool.added).toHaveLength(1)
    expect(pool.added[0]).toMatchObject({
      id: 'trae-cn-ab12',
      provider: 'trae-cn',
      nickname: '新账号',
      credentialRef: 'TRAE_CN_ACCOUNT_AB12',
      enabled: true,
      refreshable: true,
    })
  })

  it('persistLoginResult **补全**已存在的占位（不重复 addAccount）', async () => {
    // 这是两段式的关键回归点：AccountPool.addAccount 不按 id 去重，
    // 占位条目若在这里再 addAccount 一次，池里会出现同 id 的两条记录。
    const { ctx, credentials } = makeContext()
    const pool = makePersistPool([
      {
        id: 'trae-cn-ab12', provider: 'trae-cn', nickname: 'trae-cn-ab12',
        enabled: true, credentialRef: 'TRAE_CN_ACCOUNT_AB12', refreshable: false,
      },
    ])
    const service = newService(ctx)
    const expiresAt = Date.now() + 7_200_000
    const access = JSON.stringify(makeCredential({
      nickname: '真实昵称', expires_at: String(expiresAt),
    }))

    await service.persistLoginResult(
      { access, expires: expiresAt, loginUrl: 'https://login', refreshable: true },
      { refName: 'TRAE_CN_ACCOUNT_AB12', accountId: 'trae-cn-ab12', pool: pool as never },
    )

    expect(pool.added).toHaveLength(0)
    expect(pool.updates).toEqual([{
      id: 'trae-cn-ab12',
      patch: { nickname: '真实昵称', expiresAt, refreshable: true },
    }])
  })

  it('persistLoginResult 在无 accountId 时落到默认单凭据 ref', async () => {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx)
    await service.persistLoginResult({
      access: JSON.stringify(makeCredential()), expires: 1, loginUrl: 'https://login', refreshable: true,
    })
    expect(credentials.raw('TRAE_CN_ACCESS_TOKEN')).toBeTruthy()
  })

  it('persistLoginResult 清掉上一次的失效标记（status 恢复可刷新）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify(makeCredential()))
    const service = newService(ctx, {
      fetcher: stubFetcher(() => new Response(JSON.stringify({ Code: 401 }), { status: 401 })),
    })
    await service.refresh().catch(() => {})
    expect((await service.status()).refreshable).toBe(false)

    await service.persistLoginResult({
      access: JSON.stringify(makeCredential()), expires: 1, loginUrl: 'https://login', refreshable: true,
    })

    const status = await service.status()
    expect(status.refreshable).toBe(true)
    expect(status.refreshError).toBeUndefined()
  })

  it('prepareLogin 返回 loginUrl（RPC 第一段只需它）并登记回调诊断', async () => {
    const { ctx } = makeContext()
    const logs: string[] = []
    // 用真实的 ctx.logger 替身收集回调诊断。
    ctx.provide('logger', {
      info: (message: string) => { logs.push(message) },
      warn: () => {},
      error: () => {},
    } as never)
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })

    const outcome = await service.prepareLogin({ timeoutMs: 5000 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('prepare 失败')
    try {
      expect(outcome.session.loginUrl).toContain('https://www.trae.cn/authorization?')
      expect(outcome.session.port).toBeGreaterThan(0)
    } finally {
      // 互斥是模块级的：本用例必须释放会话，否则污染同文件后续用例。
      outcome.session.cancel('用例清理')
    }
  })

  it('prepareLogin 在已有会话时透传 login-in-progress（不抛异常）', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: stubFetcher(() => refreshSuccess()) })
    const first = await service.prepareLogin({ timeoutMs: 5000 })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('prepare 失败')

    try {
      const second = await service.prepareLogin({ timeoutMs: 5000 })
      // 用判别联合而非异常：RPC 层要把该错误码原样透传给客户端提示用户。
      expect(second.ok).toBe(false)
      if (second.ok) throw new Error('不应成功')
      expect(second.error).toBe('login-in-progress')
    } finally {
      first.session.cancel('用例清理')
    }
  })
})
