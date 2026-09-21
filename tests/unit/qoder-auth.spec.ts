import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QoderAuth,
  RefreshTokenExpiredError,
  exchangeQoderJobToken,
  summarizeQoderErrorBody,
  type QoderAuthOptions,
} from '../../src/qoder-auth.js'
import {
  QODER,
  QODER_CN,
  QODER_JOB_TOKEN_TTL_MS,
  isQoderPersonalToken,
  parseQoderJobTokenPayload,
  type QoderCredential,
} from '../../src/qoder-product.js'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: QoderAuth[] = []

/**
 * 设备流用例建的临时 home 目录；afterEach 统一删除。
 *
 * ⚠️ 设备流会读写 `~/.qoder/.auth/machine_id` —— 那是**用户与官方 CLI 共用**
 * 的机器身份。不隔离就会污染用户真实环境。
 */
const tempHomes: string[] = []

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
  options: {
    fetcher?: typeof fetch
    serviceName?: string
    deviceFlow?: QoderAuthOptions['deviceFlow']
    product?: QoderAuthOptions['product']
  } = {},
): QoderAuth {
  const service = new QoderAuth(ctx, options)
  services.push(service)
  return service
}

/** 测试用 PAT（形态与真实 PAT 一致：`pt-` + 正文）。 */
const PAT = 'pt-tZbovGIr8vR8ZvD4lFoPZnve_01a0bb8c'

/**
 * exchange 成功响应（**逐字段照抄 T1 实测原文**）。
 *
 * `expires_in` 单位是**毫秒**（`86400000` = 24h），这点单测要钉死 ——
 * 当成秒会把 24h 算成 1000 天。
 */
function exchangeSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    token: 'jt-vuFDqRTQFaIblIxdalT2v5aJ',
    created_at: '2026-09-19T21:25:25Z',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    expires_in: 86_400_000,
    refresh_token: 'jrt-aYmCaS1FRt1OTRcVKQvpj7ps',
    refresh_token_expires_at: '2026-09-21T21:25:25Z',
    refresh_token_expires_in: 172_800_000,
    userId: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
    userType: 'personal_standard',
    ...overrides,
  }), { status: 200 })
}

/** 记录每次请求的 fetch stub（数量断言要靠 calls）。 */
interface StubFetch {
  fetcher: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
}

function stubFetcher(
  handler: (url: string, init: RequestInit | undefined, index: number) => Response | Promise<Response>,
): StubFetch {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    calls.push({ url: target, init })
    return handler(target, init, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

afterEach(async () => {
  for (const service of services) {
    // 设备流用例可能留下未结算的会话（互斥槽位是模块级单例）：不取消会泄漏到
    // 下一个用例，让它拿到一个莫名其妙的 login-in-progress。
    service.cancelPendingLogin('测试清理')
    service.stop()
  }
  services.length = 0
  for (const dir of tempHomes.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('QoderAuth 注册与基本信息', () => {
  it('注册为 ctx.qoderAuth（产品 id 无连字符，机械派生即合法）', () => {
    const { ctx } = makeContext()
    newService(ctx)
    expect(ctx.qoderAuth).toBeInstanceOf(QoderAuth)
    expect(ctx.qoderAuth.name).toBe('qoderAuth')
  })

  it('服务名可覆盖（产品 id 与服务标识符彻底解耦）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx, { serviceName: 'customQoderAuth' })
    expect(service.name).toBe('customQoderAuth')
    expect((ctx as unknown as Record<string, unknown>).qoderAuth).toBeUndefined()
  })

  it('凭据 ref 为 QODER_PERSONAL_TOKEN（默认单凭据回退）', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.credentialRefName).toBe('QODER_PERSONAL_TOKEN')
    expect(QODER.defaultCredentialRef).toBe('QODER_PERSONAL_TOKEN')
  })

  it('账号池 ref 前缀为 QODER_ACCOUNT（与 jet-hub-rpc 的机械派生同值）', () => {
    // 无连字符的 provider：`provider.toUpperCase() + '_ACCOUNT_'` 与本前缀
    // 必须逐字符一致，否则账号卡片的凭据会落在另一个前缀下。
    expect(QODER.accountCredentialRefPrefix).toBe('QODER_ACCOUNT')
    expect(`qoder`.toUpperCase() + '_ACCOUNT').toBe('QODER_ACCOUNT')
  })

  it('绑定 QODER 产品配置，并暴露 PAT 签发页', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(service.product.id).toBe('qoder')
    expect(service.product).toBe(QODER)
    expect(service.patUrl).toBe('https://qoder.com/account/integrations')
  })

  it('未配置凭据时 status 报告 configured: false', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    expect(await service.status()).toEqual({ configured: false, refreshable: false })
  })
})

describe('QoderAuth 登录（PAT 粘贴）', () => {
  it('非 pt- 前缀被本地拒绝，且错误信息**不含** PAT 本体', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat('sk-super-secret-value').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/pt-/)
    // 关键：本地校验就不该发请求（前缀校验的存在意义就是省掉必然失败的一次往返）。
    expect(calls).toEqual([])
    // 凭据是长期秘密，绝不能进错误信息（连片段都不行）。
    expect((error as Error).message).not.toContain('sk-super-secret-value')
    expect((error as Error).message).not.toContain('super-secret')
  })

  it('裸前缀 "pt-" 也算非法（后面必须有正文）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })
    await expect(service.loginWithPat('pt-')).rejects.toThrow(/pt-/)
    expect(calls).toEqual([])
  })

  it('裁剪前后空白（剪贴板常见的换行/空格）', async () => {
    const { ctx, credentials } = makeContext()
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.loginWithPat(`  ${PAT}\n`)

    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    expect(stored.access_token).toBe(PAT)
  })

  it('exchange 成功 → 凭据落盘字段正确', async () => {
    const { ctx, credentials } = makeContext()
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    const before = Date.now()
    const result = await service.loginWithPat(PAT)

    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    // PAT 存进 access_token：账号池的身份标识字段就是它（见 qoder-product.ts 的说明）。
    expect(stored.access_token).toBe(PAT)
    expect(stored.refresh_token).toBe('jrt-aYmCaS1FRt1OTRcVKQvpj7ps')
    expect(stored.user_id).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(stored.user_type).toBe('personal_standard')
    // expires_in 是**毫秒**：24h，不是 1000 天。
    const expiresAt = Number(stored.token_expires_at)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86_400_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000)

    expect(result.ref).toBe('QODER_PERSONAL_TOKEN')
    expect(result.refreshable).toBe(true)
    // Qoder 没有浏览器登录：这两个字段对它是结构同构的占位，不是「未知」。
    expect(result.loginUrl).toBe('')
    expect(result.expires).toBe(0)
  })

  it('请求形态：POST 到 openapi 换令牌端点，body 是 snake_case，且**不带** Authorization', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.loginWithPat(PAT)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openapi.qoder.sh/api/v1/jobToken/exchange')
    expect(calls[0]!.init?.method).toBe('POST')
    // ⚠️ 键名必须 snake_case：camelCase 实测回 400。
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ personal_token: PAT })
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers['User-Agent']).toBe('qoder/1.1.16')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('login() 无 pat 时走**浏览器设备流**（不再是「不支持浏览器登录」）', async () => {
    // ⚠️ 语义已于 2026-09-21 反转：设备流落地前 `login()` 无参抛
    // 「Qoder 不支持浏览器登录」是正确的（那时确实只有 PAT 一种形态）；
    // 现在无参有了真实含义 —— 建一个设备流会话并返回授权页 URL。
    //
    // 本用例用**永不成功**的轮询（homeDir 指向临时目录，绝不碰用户真实
    // `~/.qoder`）：要断言的是「它开始走设备流了」，而不是「登录成功」。
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => new Response('', { status: 404 }))
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-auth-login-'))
    tempHomes.push(homeDir)
    const service = newService(ctx, {
      fetcher,
      deviceFlow: { homeDir, timeoutMs: 30, intervalMs: 5 },
    })

    const error = await service.login().catch((e: unknown) => e)
    // 用户没在浏览器里授权 ⇒ 5 分钟（此处 30ms）超时是**正确终态**，
    // 而不是「抛一条让你去粘贴 PAT」的指引。
    expect((error as Error).message).toMatch(/超时/)
    expect((error as Error).message).not.toMatch(/不支持浏览器登录/)
    // 它**确实出网了**（轮询），这正是设备流与「直接抛错」的分界。
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.url).toContain('/api/v1/deviceToken/poll')
  })

  it('设备流第一段返回授权页 URL（prepareLogin 不 await 用户）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => new Response('', { status: 404 }))
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-auth-prepare-'))
    tempHomes.push(homeDir)
    const service = newService(ctx, {
      fetcher,
      deviceFlow: { homeDir, timeoutMs: 30, intervalMs: 5 },
    })

    const outcome = await service.prepareLogin()
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    const url = new URL(outcome.session.loginUrl)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.pathname).toBe('/device/selectAccounts')
    // **一次网都不出**：第一段只做本地生成（PKCE / machine_id）。
    expect(calls).toEqual([])
    service.cancelPendingLogin('用例清理')
  })

  it('login({ pat }) 代理 loginWithPat（统一接口入口）', async () => {
    const { ctx, credentials } = makeContext()
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.login({ pat: PAT })

    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    expect(stored.access_token).toBe(PAT)
  })

  it('accountId + pool 同时提供时登记账号，且**不写** expiresAt', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })
    const added: Array<Record<string, unknown>> = []

    await service.loginWithPat(PAT, {
      accountId: 'qoder-a1b2c3d4',
      refName: 'QODER_ACCOUNT_A1B2C3D4',
      pool: {
        async addAccount(entry: Record<string, unknown>) { added.push(entry) },
      } as never,
    })

    expect(added).toHaveLength(1)
    expect(added[0]!.id).toBe('qoder-a1b2c3d4')
    expect(added[0]!.provider).toBe('qoder')
    expect(added[0]!.credentialRef).toBe('QODER_ACCOUNT_A1B2C3D4')
    expect(added[0]!.nickname).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(added[0]!.refreshable).toBe(true)
    // PAT 的过期时间本地无从得知；写 jt 的 24h 进去会让账号卡片刻假过期。
    expect(added[0]).not.toHaveProperty('expiresAt')
  })
})

describe('QoderAuth exchange 错误分类', () => {
  it('非 200（5xx）→ 错误信息带响应体摘要，且**不是**凭据失效', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response('upstream boom', { status: 500 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toContain('HTTP 500')
    expect((error as Error).message).toContain('upstream boom')
  })

  it('非 200 的 JSON 错误体被压成一行摘要（不换行、可读）', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({
      errorCode: 'BadRequest',
      errorMessage: 'Bad request',
    }, null, 2), { status: 502 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    const message = (error as Error).message
    expect(message).toContain('HTTP 502')
    expect(message).toContain('BadRequest')
    expect(message).not.toContain('\n')
  })

  it('400 刻意**不**判终态（请求构造错 ≠ 用户 PAT 失效）', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({
      errorCode: 'BadRequest',
      errorMessage: 'Bad request',
    }), { status: 400 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toContain('HTTP 400')
  })

  it('HTTP 401 → RefreshTokenExpiredError（提示重新粘贴）', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({
      code: 'TOKEN_EXPIRE',
      message: 'token is not active',
    }), { status: 401 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
    expect((error as Error).message).toMatch(/重新粘贴/)
    // 摘要要带出来源，便于排查是哪种 401。
    expect((error as Error).message).toContain('TOKEN_EXPIRE')
  })

  it('HTTP 403 也判终态', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response('forbidden', { status: 403 }))
    const service = newService(ctx, { fetcher })
    await expect(service.loginWithPat(PAT)).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('200 却没有 token（业务失效）→ 终态，不重试', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/缺少 token/)
  })

  it('响应不是 JSON → 普通 Error（可重试），且带响应体摘要', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response('<html>bad gateway</html>', { status: 200 }))
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/不是 JSON/)
    expect((error as Error).message).toContain('bad gateway')
  })

  it('网络失败 → 普通 Error（断网 ≠ PAT 失效），且错误信息不含 PAT', async () => {
    const { ctx } = makeContext()
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    const error = await service.loginWithPat(PAT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/网络失败/)
    expect((error as Error).message).not.toContain(PAT)
  })
})

describe('QoderAuth getJobToken（jt 运行时缓存）', () => {
  it('登录后缓存命中：再次取令牌**不打网络**', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.loginWithPat(PAT)
    expect(calls).toHaveLength(1)

    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(1)
  })

  it('缓存为空时打一次 exchange，并在后续调用中命中', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(1)
  })

  it('剩余有效期 < 1h 时自动重换（提前刷新的边界）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher((_url, _init, index) => exchangeSuccess({
      token: index === 0 ? 'jt-first' : 'jt-second',
      // 59 分钟 < 1h 提前窗口 → 下一次取用必须重换。
      expires_in: 59 * 60 * 1000,
    }))
    const service = newService(ctx, { fetcher })

    expect(await service.getJobToken(PAT)).toBe('jt-first')
    expect(await service.getJobToken(PAT)).toBe('jt-second')
    expect(calls).toHaveLength(2)
  })

  it('剩余有效期 > 1h 时命中缓存（不重换）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher((_url, _init, index) => exchangeSuccess({
      token: index === 0 ? 'jt-first' : 'jt-second',
      // 61 分钟 > 1h → 仍在缓存窗口内。
      expires_in: 61 * 60 * 1000,
    }))
    const service = newService(ctx, { fetcher })

    expect(await service.getJobToken(PAT)).toBe('jt-first')
    expect(await service.getJobToken(PAT)).toBe('jt-first')
    expect(calls).toHaveLength(1)
  })

  it('缓存**按 PAT 分键**：两个账号各缓存各的，互不覆盖', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { personal_token: string }
      return exchangeSuccess({ token: `jt-for-${body.personal_token.slice(-4)}` })
    })
    const service = newService(ctx, { fetcher })

    const patA = `${PAT}-A`
    const patB = `${PAT}-B`
    expect(await service.getJobToken(patA)).toBe('jt-for-8c-A')
    expect(await service.getJobToken(patB)).toBe('jt-for-8c-B')
    // 回到 A：仍应命中它自己的缓存。
    expect(await service.getJobToken(patA)).toBe('jt-for-8c-A')
    expect(calls).toHaveLength(2)
  })

  it('invalidateJobToken 强制下次重换（供 401 后重试一次用）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher((_url, _init, index) => exchangeSuccess({
      token: index === 0 ? 'jt-first' : 'jt-second',
    }))
    const service = newService(ctx, { fetcher })

    expect(await service.getJobToken(PAT)).toBe('jt-first')
    service.invalidateJobToken(PAT)
    expect(await service.getJobToken(PAT)).toBe('jt-second')
    expect(calls).toHaveLength(2)
  })

  it('exchange 401 时 getJobToken 抛 RefreshTokenExpiredError（映射为凭据失效）', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({
      code: 'TOKEN_INVALID',
      message: 'invalid apikey',
    }), { status: 401 }))
    const service = newService(ctx, { fetcher })

    await expect(service.getJobToken(PAT)).rejects.toThrow(RefreshTokenExpiredError)
  })

  it('exchange 5xx 时 getJobToken 抛普通 Error（可重试，不判失效）', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => new Response('boom', { status: 503 }))
    const service = newService(ctx, { fetcher })

    const error = await service.getJobToken(PAT).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('并发取同一 PAT 只打一次 exchange（在途去重）', async () => {
    const { ctx } = makeContext()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetcher, calls } = stubFetcher(async () => {
      await gate
      return exchangeSuccess()
    })
    const service = newService(ctx, { fetcher })

    const first = service.getJobToken(PAT)
    const second = service.getJobToken(PAT)
    release()
    expect(await first).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(await second).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(1)
  })

  it('在途 exchange 失败后不污染缓存（下一次可重试）', async () => {
    const { ctx } = makeContext()
    const { fetcher, calls } = stubFetcher((_url, _init, index) => (index === 0
      ? new Response('boom', { status: 503 })
      : exchangeSuccess()))
    const service = newService(ctx, { fetcher })

    await expect(service.getJobToken(PAT)).rejects.toThrow(/HTTP 503/)
    // 第二次重试应当真的再打一次，而不是命中被写入的失败态。
    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(2)
  })
})

describe('QoderAuth 设备流登录（2026-09-21 400 报障的回归锚点）', () => {
  /** 真机设备流 poll 成功响应（字段照抄 `docs/qoder-integration-research.md` L139-147）。 */
  function devicePollSuccess(overrides: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({
      id: '01a0bb78-844d-78e2-8efc-4b0e20fe9533',
      token: 'dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e',
      user_id: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
      code_challenge: 'CHALLENGE-43',
      challenge_method: 'S256',
      nonce: '11111111-2222-3333-4444-555555555555',
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      refresh_token_id: 'rt-1',
      refresh_token: 'drt-Ym3pQw8tZc5vNb2kLd7xRf4hJs9gTe6a',
      created_at: '2026-09-21T00:00:00Z',
      updated_at: '2026-09-21T00:00:00Z',
      expires_in: 2_591_999_994,
      refresh_token_expires_in: 31_103_999_996,
      refresh_token_expires_at: new Date(Date.now() + 360 * 86_400_000).toISOString(),
      ...overrides,
    }), { status: 200 })
  }

  /** 一次性完成「设备流授权 → 落凭据」的完整链路。 */
  async function completeDeviceLogin(
    options: { fetcher: typeof fetch; homeDir: string; accountId?: string; pool?: unknown },
  ) {
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, {
      fetcher: options.fetcher,
      deviceFlow: { homeDir: options.homeDir, intervalMs: 1 },
    })
    const outcome = await service.prepareLogin()
    if (!outcome.ok) throw new Error(`prepare 失败：${outcome.message}`)
    const result = await service.persistLoginResult(outcome.session, {
      ...options.accountId === undefined ? {} : { accountId: options.accountId },
      ...options.pool === undefined ? {} : { pool: options.pool as never },
      ...options.accountId === undefined ? {} : { refName: 'QODER_ACCOUNT_A1B2C3D4' },
    })
    return { ctx, credentials, service, result, session: outcome.session }
  }

  it('★ 设备流登录**绝不打** jobToken/exchange（400 报障的根因锚点）', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-login-'))
    tempHomes.push(homeDir)
    const { fetcher, calls } = stubFetcher(() => devicePollSuccess())

    const { credentials } = await completeDeviceLogin({ fetcher, homeDir })

    // 唯一该出网的是轮询。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/api/v1/deviceToken/poll')
    // ⚠️ 反向断言：exchange 端点是 **PAT 专用**。把设备令牌（`dt-…`）当
    // `personal_token` 提交过去，服务端回 HTTP 400 `{"errorCode":"BadRequest"}` ——
    // 那正是「浏览器授权成功、却卡在换令牌」的来路。
    expect(calls.map((c) => c.url).join(' ')).not.toContain('/api/v1/jobToken/exchange')
    // 凭据已落盘（登录成功），令牌本体是设备令牌、**原样**存进 access_token。
    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    expect(stored.access_token).toBe('dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e')
    expect(stored.refresh_token).toBe('drt-Ym3pQw8tZc5vNb2kLd7xRf4hJs9gTe6a')
    expect(Number(stored.token_expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(stored.user_id).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
  })

  it('设备令牌直接当 Bearer 取用：**零网络**（它自己就是可用令牌）', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-bearer-'))
    tempHomes.push(homeDir)
    const { fetcher, calls } = stubFetcher(() => devicePollSuccess())
    const { service } = await completeDeviceLogin({ fetcher, homeDir })
    const before = calls.length

    const token = await service.getJobToken('dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e')

    expect(token).toBe('dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e')
    // 官方 `Veo()` 把设备令牌直接写进 `security_oauth_token`，全程不调
    // `exchangePersonalToken` —— 我们同样一次网都不该出。
    expect(calls.length).toBe(before)
  })

  it('设备令牌续期打 deviceToken/refresh（**不是** PAT 的 exchange）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'dt-old-token', refresh_token: 'drt-old-refresh',
      token_expires_at: String(Date.now() + 1000),
    } satisfies QoderCredential))
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-refresh-'))
    tempHomes.push(homeDir)
    const { fetcher, calls } = stubFetcher(() => new Response(JSON.stringify({
      device_token: 'dt-new-token',
      refresh_token: 'drt-new-refresh',
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }), { status: 200 }))
    const service = newService(ctx, { fetcher, deviceFlow: { homeDir } })

    await service.refresh()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openapi.qoder.sh/api/v1/deviceToken/refresh')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.refresh_token).toBe('drt-old-refresh')
    // machine_id 一并回传（官方同款）：两处漂移会让服务端当成另一台机器。
    expect(typeof body.machine_id).toBe('string')
    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    expect(stored.access_token).toBe('dt-new-token')
    expect(stored.refresh_token).toBe('drt-new-refresh')
  })

  it('设备令牌续期 401 → 终态（重新登录），**不**落到 PAT 的 400', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'dt-old-token', refresh_token: 'drt-old-refresh',
    } satisfies QoderCredential))
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-refresh-401-'))
    tempHomes.push(homeDir)
    const { fetcher } = stubFetcher(() => new Response('unauthorized', { status: 401 }))
    const service = newService(ctx, { fetcher, deviceFlow: { homeDir } })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    expect((await service.status()).refreshable).toBe(false)
  })

  it('设备令牌缺 refresh_token → 终态（重试一万次也换不出令牌）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'dt-old-token', refresh_token: '',
    } satisfies QoderCredential))
    const { fetcher, calls } = stubFetcher(() => devicePollSuccess())
    const service = newService(ctx, { fetcher })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    // 本地就能判定，不该白打一次网络。
    expect(calls).toEqual([])
  })

  it('设备令牌续期按**产品配置**选 host（CN 打 CN，两区共用一份代码）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_CN_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'dt-cn-token', refresh_token: 'drt-cn-refresh',
    } satisfies QoderCredential))
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-cn-refresh-'))
    tempHomes.push(homeDir)
    const { fetcher, calls } = stubFetcher(() => new Response(JSON.stringify({
      device_token: 'dt-cn-new', refresh_token: 'drt-cn-new',
    }), { status: 200 }))
    const service = newService(ctx, { fetcher, product: QODER_CN, deviceFlow: { homeDir } })

    await service.refresh()

    // 端点路径两区相同、host 走产品配置 —— 拿国际版 host 打 CN 凭据会得到
    // 「凭据失效」的假象（两区令牌互不承认）。
    expect(calls[0]!.url).toBe('https://openapi.qoder.com.cn/api/v1/deviceToken/refresh')
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.refresh_token).toBe('drt-cn-refresh')
  })

  it('PAT 路径**逐字节未变**：仍打 exchange、body 仍是 personal_token', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refresh()

    // 分派是按令牌族（`dt-` vs `pt-`），PAT 分支一行未动 —— 这是红线。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openapi.qoder.sh/api/v1/jobToken/exchange')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ personal_token: PAT })
  })

  it('设备流账号登记：nickname 取 user_id，且**不写** expiresAt（与 PAT 路径同口径）', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-device-account-'))
    tempHomes.push(homeDir)
    const { fetcher } = stubFetcher(() => devicePollSuccess())
    const added: Array<Record<string, unknown>> = []
    const pool = {
      async listAllAccounts() { return [] },
      async addAccount(entry: Record<string, unknown>) { added.push(entry) },
      async updateAccount() { /* 占位不存在，走 addAccount 分支 */ },
    }

    await completeDeviceLogin({ fetcher, homeDir, accountId: 'qoder-a1b2c3d4', pool })

    expect(added).toHaveLength(1)
    expect(added[0]!.provider).toBe('qoder')
    expect(added[0]!.nickname).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(added[0]!.refreshable).toBe(true)
    expect(added[0]).not.toHaveProperty('expiresAt')
  })
})

describe('QoderAuth 续期', () => {
  it('refresh 用存储的 PAT 重打 exchange，更新 jt 元数据并保留 PAT', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT,
      refresh_token: 'jrt-old',
      token_expires_at: '1',
      user_id: 'u-1',
      user_type: 'personal_standard',
    } satisfies QoderCredential))
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refresh()

    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    // PAT 不变 —— 它就是续期的输入，覆盖掉等于把凭据废掉。
    expect(stored.access_token).toBe(PAT)
    expect(stored.refresh_token).toBe('jrt-aYmCaS1FRt1OTRcVKQvpj7ps')
    expect(Number(stored.token_expires_at)).toBeGreaterThan(Date.now())
    // 身份字段：响应带了新值就取新值（旧值只是回退）。
    expect(stored.user_id).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openapi.qoder.sh/api/v1/jobToken/exchange')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ personal_token: PAT })
  })

  it('refresh 响应不带身份字段时沿用旧值（不把 user_id 覆盖成 undefined）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT,
      refresh_token: 'jrt-old',
      user_id: 'u-keep',
      user_type: 'personal_standard',
    } satisfies QoderCredential))
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({
      token: 'jt-only',
      expires_in: 86_400_000,
    }), { status: 200 }))
    const service = newService(ctx, { fetcher })

    await service.refresh()

    const stored = JSON.parse(credentials.raw('QODER_PERSONAL_TOKEN')!) as QoderCredential
    expect(stored.user_id).toBe('u-keep')
    expect(stored.user_type).toBe('personal_standard')
    // 响应没带新 jrt 时沿用旧的，不能覆盖成空串。
    expect(stored.refresh_token).toBe('jrt-old')
  })

  it('refresh 顺带回填 jt 缓存（下一次取用不再打网络）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refresh()
    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(1)
  })

  it('refresh 收到 401 → 终态，status().refreshable 变 false 并带提示', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({ code: 'TOKEN_EXPIRE' }), { status: 401 }))
    const service = newService(ctx, { fetcher })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)

    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.refreshable).toBe(false)
    // ⚠️ 文案是**中性**的「凭据已失效，请重新登录」，**不是**「请重新粘贴 PAT」：
    // 面板现在只有浏览器设备流一个登录入口（PAT 粘贴 UI 已按用户要求移除），
    // 说「重新粘贴」会把用户指向一个界面上不存在的入口。
    expect(status.refreshError).toMatch(/凭据已失效/)
    expect(status.refreshError).not.toMatch(/重新粘贴/)
  })

  it('网络失败**不**判为终态（抛普通 Error，交给调度器重试）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    const error = await service.refresh().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
    expect((error as Error).message).toMatch(/网络失败/)
    // 非终态不得把凭据标成失效。
    expect((await service.status()).refreshable).toBe(true)
  })

  it('续期成功后清掉上一次的失效标记', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    const { fetcher } = stubFetcher((_url, _init, index) => (index === 0
      ? new Response(JSON.stringify({ code: 'TOKEN_EXPIRE' }), { status: 401 })
      : exchangeSuccess()))
    const service = newService(ctx, { fetcher })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    await service.refresh()

    const status = await service.status()
    expect(status.refreshable).toBe(true)
    expect(status.refreshError).toBeUndefined()
  })

  it('未配置凭据时抛错提示先登录', async () => {
    const { ctx } = makeContext()
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })
    await expect(service.refresh()).rejects.toThrow(/未配置凭据/)
  })

  it('凭据缺 PAT（空串）时直接抛终态错误', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: '', refresh_token: 'jrt-x',
    } satisfies QoderCredential))
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await expect(service.refresh()).rejects.toThrow(RefreshTokenExpiredError)
    expect(calls).toEqual([])
  })

  it('refreshAccountCredential 只动指定账号的 ref，不污染单凭据状态', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-acc',
    } satisfies QoderCredential))
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refreshAccountCredential('QODER_ACCOUNT_A1B2C3D4')

    const stored = JSON.parse(credentials.raw('QODER_ACCOUNT_A1B2C3D4')!) as QoderCredential
    expect(stored.refresh_token).toBe('jrt-aYmCaS1FRt1OTRcVKQvpj7ps')
    // 默认单凭据 ref 未被创建，且失效/错误状态未被账号操作写入。
    expect(credentials.raw('QODER_PERSONAL_TOKEN')).toBeUndefined()
    const status = await service.status()
    expect(status.configured).toBe(false)
    expect(status.refreshError).toBeUndefined()
  })

  it('refreshAccountCredential 遇到 401 抛终态，但不写单凭据的失效标记', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-acc',
    } satisfies QoderCredential))
    const { fetcher } = stubFetcher(() => new Response(JSON.stringify({ code: 'TOKEN_EXPIRE' }), { status: 401 }))
    const service = newService(ctx, { fetcher })

    await expect(service.refreshAccountCredential('QODER_ACCOUNT_A1B2C3D4'))
      .rejects.toThrow(RefreshTokenExpiredError)
    expect((await service.status()).refreshError).toBeUndefined()
  })

  it('登出竞态：在途刷新期间 logout 后不回写凭据', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT, refresh_token: 'jrt-old',
    } satisfies QoderCredential))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetcher } = stubFetcher(async () => {
      await gate
      return exchangeSuccess()
    })
    const service = newService(ctx, { fetcher })

    const refreshing = service.refresh()
    await service.logout()
    release()
    await refreshing

    expect(credentials.raw('QODER_PERSONAL_TOKEN')).toBeUndefined()
  })

  it('logout 清空 jt 缓存（登出后内存不残留任何 jt）', async () => {
    const { ctx, credentials } = makeContext()
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.loginWithPat(PAT)
    expect(calls).toHaveLength(1)
    await service.logout()
    // 缓存已清：必须重新 exchange 才能拿到 jt。
    expect(await service.getJobToken(PAT)).toBe('jt-vuFDqRTQFaIblIxdalT2v5aJ')
    expect(calls).toHaveLength(2)
    expect(credentials.raw('QODER_PERSONAL_TOKEN')).toBeUndefined()
  })
})

describe('QoderAuth checkExpired', () => {
  it('未配置时返回 true', async () => {
    const { ctx } = makeContext()
    expect(await newService(ctx).checkExpired()).toBe(true)
  })

  it('有 PAT 时返回 false —— **即使** jt 元数据早已过期（运行时令牌与凭据是两件事）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: PAT,
      refresh_token: 'jrt-old',
      // 24h 前的 jt 过期时刻：凭据本身仍然可用（getJobToken 会按需重换）。
      token_expires_at: String(Date.now() - 86_400_000),
    } satisfies QoderCredential))
    const service = newService(ctx)
    expect(await service.checkExpired()).toBe(false)
  })

  it('凭据损坏或 PAT 为空时返回 true', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_PERSONAL_TOKEN', 'not-json')
    const service = newService(ctx)
    expect(await service.checkExpired()).toBe(true)

    await credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({ access_token: '', refresh_token: '' }))
    expect(await service.checkExpired()).toBe(true)
  })
})

describe('QoderAuth 批量续期', () => {
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

  it('只续期 provider 匹配且 enabled + refreshable 的账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A', JSON.stringify({ access_token: `${PAT}-A`, refresh_token: 'r' }))
    await credentials.set('QODER_ACCOUNT_B', JSON.stringify({ access_token: `${PAT}-B`, refresh_token: 'r' }))
    await credentials.set('QODER_ACCOUNT_C', JSON.stringify({ access_token: `${PAT}-C`, refresh_token: 'r' }))
    const pool = makePool([
      { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', enabled: true, refreshable: true },
      // 停用：不续期
      { id: 'b', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_B', enabled: false, refreshable: true },
      // 其他 provider：绝不串用
      { id: 'c', provider: 'buddy', credentialRef: 'QODER_ACCOUNT_C', enabled: true, refreshable: true },
    ])
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)

    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ personal_token: `${PAT}-A` })
    // 没有终态失败 → 不该写任何 refreshable: false
    expect(pool.updates).toEqual([])
  })

  it('jt 有效时**不**重打 exchange（每 30 分钟的批量续期不该做无用功）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A', JSON.stringify({ access_token: `${PAT}-A`, refresh_token: 'r' }))
    const pool = makePool([
      { id: 'a', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_A', enabled: true, refreshable: true },
    ])
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)
    await service.refreshAll(pool as never)

    expect(calls).toHaveLength(1)
  })

  it('PAT 失效的账号被标记 refreshable: false，且不影响其他账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_DEAD', JSON.stringify({ access_token: `${PAT}-dead`, refresh_token: 'r' }))
    await credentials.set('QODER_ACCOUNT_OK', JSON.stringify({ access_token: `${PAT}-ok`, refresh_token: 'r' }))
    const pool = makePool([
      { id: 'dead', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_DEAD', enabled: true, refreshable: true },
      { id: 'ok', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_OK', enabled: true, refreshable: true },
    ])
    const { fetcher, calls } = stubFetcher((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { personal_token: string }
      return body.personal_token.endsWith('dead')
        ? new Response(JSON.stringify({ code: 'TOKEN_EXPIRE' }), { status: 401 })
        : exchangeSuccess()
    })
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)

    expect(calls).toHaveLength(2)
    expect(pool.updates).toEqual([{ id: 'dead', patch: { refreshable: false } }])
  })

  it('凭据缺失的账号被标记 refreshable: false（不发请求）', async () => {
    const { ctx } = makeContext()
    const pool = makePool([
      { id: 'ghost', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_GHOST', enabled: true, refreshable: true },
    ])
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)

    expect(calls).toEqual([])
    expect(pool.updates).toEqual([{ id: 'ghost', patch: { refreshable: false } }])
  })
})

describe('Qoder 协议纯函数', () => {
  it('isQoderPersonalToken 只认 pt- 前缀且要求有正文', () => {
    expect(isQoderPersonalToken('pt-abc')).toBe(true)
    expect(isQoderPersonalToken('pt-')).toBe(false)
    expect(isQoderPersonalToken('')).toBe(false)
    // `dt-` 是**另一套体系**的设备令牌，实测不能当 PAT 提交（401）。
    expect(isQoderPersonalToken('dt-abc')).toBe(false)
    expect(isQoderPersonalToken('PT-ABC')).toBe(false)
  })

  it('parseQoderJobTokenPayload：expires_in 按**毫秒**相对值计算', () => {
    const payload = parseQoderJobTokenPayload({ token: 'jt-1', expires_in: 86_400_000 }, 1_000_000)
    expect(payload?.token).toBe('jt-1')
    expect(payload?.expiresAtMs).toBe(1_000_000 + 86_400_000)
  })

  it('parseQoderJobTokenPayload：expires_in 缺失时回退 expires_at（ISO）', () => {
    const iso = new Date(1_800_000_000_000).toISOString()
    const payload = parseQoderJobTokenPayload({ token: 'jt-1', expires_at: iso }, 1_000_000)
    expect(payload?.expiresAtMs).toBe(1_800_000_000_000)
  })

  it('parseQoderJobTokenPayload：两者都缺时按 24h 兜底', () => {
    const payload = parseQoderJobTokenPayload({ token: 'jt-1' }, 1_000_000)
    expect(payload?.expiresAtMs).toBe(1_000_000 + QODER_JOB_TOKEN_TTL_MS)
  })

  it('parseQoderJobTokenPayload：非对象返回 undefined，缺字段降级为空串而非抛错', () => {
    expect(parseQoderJobTokenPayload(null)).toBeUndefined()
    expect(parseQoderJobTokenPayload([])).toBeUndefined()
    expect(parseQoderJobTokenPayload('nope')).toBeUndefined()
    const payload = parseQoderJobTokenPayload({ token: 'jt-1' })
    expect(payload?.refreshToken).toBe('')
    expect(payload?.userId).toBeUndefined()
    expect(payload?.userType).toBeUndefined()
  })

  it('summarizeQoderErrorBody 压平空白并截断', () => {
    expect(summarizeQoderErrorBody('  a\n\n b  ')).toBe('a b')
    expect(summarizeQoderErrorBody('')).toBe('(空响应体)')
    const long = summarizeQoderErrorBody('x'.repeat(500))
    expect(long).toContain('共 500 字符')
    expect(long.length).toBeLessThan(300)
  })

  it('exchangeQoderJobToken 对空 PAT 直接拒绝（不发请求）', async () => {
    const { fetcher, calls } = stubFetcher(() => exchangeSuccess())
    await expect(exchangeQoderJobToken('', QODER, fetcher)).rejects.toThrow(/缺少 PAT/)
    expect(calls).toEqual([])
  })
})
