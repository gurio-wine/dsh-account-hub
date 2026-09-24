import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RefreshTokenExpiredError,
  decorateLoginUrl,
  fetchAuthState,
  fetchModels,
  getAccount,
  loopGetToken,
  refreshToken,
  runBuddyLoginFlow,
} from '../../src/buddy-oauth.js'
import { BUDDY_CN, BUDDY, type BuddyProduct } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

const STATE = 'state-abc'
const AUTH_URL = 'https://www.codebuddy.cn/login/?platform=ide&state=state-abc'

/** 构造凭据（默认 2 小时后过期）。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** 把若干个 [matcher, response] 规则组装为 stub fetch。 */
function routeFetch(routes: Array<{ when: (url: string) => boolean; respond: () => Response }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const route of routes) {
      if (route.when(url)) return route.respond()
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('buddy fetchAuthState', () => {
  it('returns state and authUrl', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/state'),
      respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
    }])
    const result = await fetchAuthState(fetcher)
    expect(result).toEqual({ state: STATE, authUrl: AUTH_URL })
    // 必须带 platform=ide 查询参数与免鉴权头。
    const [url, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(url).toContain('platform=ide')
    expect((init.headers as Record<string, string>)['X-No-Authorization']).toBe('true')
  })

  it('throws when the response is missing state or authUrl', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }),
    }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('state')
  })

  it('throws on a non-200 response', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(fetchAuthState(fetcher)).rejects.toThrow('auth/state HTTP 500')
  })
})

describe('buddy loopGetToken', () => {
  it('polls until the token is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        // 前两次返回 11217（token 未就绪），第三次成功。
        return attempts < 3
          ? new Response(JSON.stringify({ code: 11217, message: 'not ready' }), { status: 400 })
          : new Response(JSON.stringify({
            code: 0,
            data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
          }), { status: 200 })
      },
    }])
    const token = await loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })
    expect(token.accessToken).toBe('AT')
    expect(attempts).toBe(3)
  })

  it('aborts other errors immediately', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 99999, message: 'fatal' }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0 })).rejects.toThrow('fatal')
  })

  it('times out when the token never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 11217 }), { status: 400 }),
    }])
    await expect(loopGetToken(STATE, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })
})

describe('buddy getAccount', () => {
  it('polls until the account is ready', async () => {
    let attempts = 0
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => {
        attempts++
        return attempts < 2
          ? new Response(JSON.stringify({ code: 12151 }), { status: 400 })
          : new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 })
      },
    }])
    const account = await getAccount(STATE, {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }, { fetcher, pollIntervalMs: 0 })
    expect(account).toEqual({ uid: 'u1', nickname: 'nick', enterpriseId: '', accountType: 'personal' })
  })

  it('times out when the account never becomes ready', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 12151 }), { status: 400 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await expect(getAccount(STATE, token, { fetcher, pollIntervalMs: 0, timeoutMs: 5 })).rejects.toThrow('超时')
  })
})

describe('buddy refreshToken', () => {
  it('submits X-Refresh-Token and returns the new token', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v2/plugin/auth/token/refresh'),
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '2026-09-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
      }), { status: 200 }),
    }])
    const token = await refreshToken(makeCredential(), fetcher)
    expect(token.accessToken).toBe('AT2')
    expect(token.refreshToken).toBe('RT2')
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Refresh-Token']).toBe('RT')
  })

  it('throws RefreshTokenExpiredError on HTTP 401', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 401, message: 'refresh token expired' }), { status: 401 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when the message says expired', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 5000, message: 'token expired' }), { status: 400 }),
    }])
    await expect(refreshToken(makeCredential(), fetcher)).rejects.toThrow('expired')
  })

  it('treats other failures as retryable (plain Error)', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ code: 500, message: 'upstream down' }), { status: 502 }),
    }])
    const error = await refreshToken(makeCredential(), fetcher).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefreshTokenExpiredError)
  })

  it('throws RefreshTokenExpiredError when there is no refresh_token', async () => {
    const fetcher = routeFetch([])
    await expect(refreshToken(makeCredential({ refresh_token: '' }), fetcher)).rejects.toBeInstanceOf(RefreshTokenExpiredError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  // 回归（Task 3 审查遗留）：refresh 请求此前硬编码 CodeBuddy 的 UA。
  // 两个内置产品的 userAgent 字面量暂时相同，无法观测该行为，故注入自定义 UA。
  it('续期请求使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await refreshToken(makeCredential(), fetcher, undefined, custom)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/7.7.7')
    expect(headers['X-Refresh-Token']).toBe('RT')
  })

  it('默认续期请求仍使用 CodeBuddy 的 User-Agent', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT2', refreshToken: 'RT2', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await refreshToken(makeCredential(), fetcher)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(BUDDY_CN.userAgent)
  })
})

describe('登录轮询的产品身份标识', () => {
  it('loopGetToken 使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: '' },
      }), { status: 200 }),
    }])
    await loopGetToken(STATE, { fetcher, pollIntervalMs: 0, product: custom })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })

  it('getAccount 使用传入 product 的 User-Agent', async () => {
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({
        code: 0, data: { uid: 'u1', nickname: 'n', enterpriseId: '', type: 'personal' },
      }), { status: 200 }),
    }])
    const token = {
      accessToken: 'AT', refreshToken: 'RT', expiresAt: '', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    await getAccount(STATE, token, { fetcher, pollIntervalMs: 0, product: custom })
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })

  it('runBuddyLoginFlow 把产品传给 token 与 account 两步轮询', async () => {
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/7.7.7' }
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: '' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({ fetcher, pollIntervalMs: 0, product: custom, openBrowser: () => {} })
    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    const tokenCall = calls.find(([url]) => url.includes('/auth/token'))!
    const accountCall = calls.find(([url]) => url.includes('/login/account'))!
    expect((tokenCall[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
    expect((accountCall[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddy/7.7.7')
  })
})

describe('buddy fetchModels', () => {
  it('parses the craft agent models from /v3/config', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/v3/config'),
      respond: () => new Response(JSON.stringify({
        data: { agents: [{ name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] }] },
      }), { status: 200 }),
    }])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([
      { id: 'hy4-preview', name: 'Hy4 Preview' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ])
  })

  it('returns an empty list without a token or on failure', async () => {
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('nope', { status: 500 }) }])
    expect(await fetchModels(makeCredential({ access_token: '' }), fetcher)).toEqual([])
    expect(await fetchModels(makeCredential(), fetcher)).toEqual([])
  })

  // 回归（Task 3 审查遗留）：默认仍发 codebuddy 身份，传 WorkBuddy 时必须
  // 换成 workbuddy —— 否则 WorkBuddy 会拿 CodeBuddy 的产品码请求 /v3/config。
  it('默认以 codebuddy 身份请求 /v3/config', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: [] }] } }), { status: 200 }),
    }])
    await fetchModels(makeCredential(), fetcher)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Product-Code']).toBe('codebuddy')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
    // X-Product 是部署类型，两个产品共用 SaaS。
    expect(headers['X-Product']).toBe('SaaS')
  })

  it('传入 WorkBuddy 时请求带 X-Product-Code: workbuddy', async () => {
    const fetcher = routeFetch([
      {
        // 企业端点返回空 → 触发回退，从而两个端点都会被请求到
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ data: { agents: [], models: [] } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, BUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
    const calls = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
    expect(calls[0]![0]).toContain('/console/enterprises/personal/models')
    expect(calls.at(-1)![0]).toContain('/v3/config')
    for (const [url, init] of calls) {
      const headers = init.headers as Record<string, string>
      // ⚠️ 协议值：provider id 已改名为 `buddy`，但出站 X-Product-Code 仍是
      // `workbuddy`（腾讯后台按它归因用量）。
      expect(headers['X-Product-Code'], `URL=${url}`).toBe('workbuddy')
      expect(headers['User-Agent']).toBe(BUDDY.userAgent)
      expect(headers['X-Product']).toBe('SaaS')
    }
  })

  it('优先使用企业模型端点并解析其 cli agent', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/console/enterprises/personal/models'),
      respond: () => new Response(JSON.stringify({
        data: {
          agents: [{ name: 'cli', models: ['gpt-5.6-sol', 'glm-5.2'] }],
          models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', maxInputTokens: 1000000 },
            { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000 },
          ],
        },
      }), { status: 200 }),
    }])
    const models = await fetchModels(makeCredential(), fetcher, undefined, BUDDY)
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'glm-5.2'])
    // 命中企业端点后不应再请求 /v3/config
    const urls = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0])
    expect(urls.some((u) => u.includes('/v3/config'))).toBe(false)
  })

  it('企业模型端点返回非 200 时回退到 /v3/config', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response('<html>500</html>', { status: 500 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, BUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('企业模型端点返回空列表时回退到 /v3/config', async () => {
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ data: { agents: [], models: [] } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    const models = await fetchModels(makeCredential(), fetcher, undefined, BUDDY)
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('两个端点都失败时返回空列表（交由调用方回退静态目录）', async () => {
    const fetcher = routeFetch([{
      when: () => true,
      respond: () => new Response('boom', { status: 500 }),
    }])
    expect(await fetchModels(makeCredential(), fetcher, undefined, BUDDY)).toEqual([])
  })

  it('企业模型端点用不带尾斜杠的路径（带斜杠会 403）', async () => {
    const seen: string[] = []
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/console/enterprises/personal/models'),
        respond: () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }),
      },
      {
        when: (url) => url.includes('/v3/config'),
        respond: () => new Response(JSON.stringify({ data: { agents: [{ name: 'craft', models: ['glm-5.3'] }] } }), { status: 200 }),
      },
    ])
    // 记录实际请求 URL（routeFetch 的 respond 不接收参数，故从 mock.calls 取）
    const models = await fetchModels(makeCredential(), fetcher, undefined, BUDDY)
    seen.push(...(fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => c[0]))
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
    const scopedUrl = seen.find((u) => u.includes('/console/enterprises/personal/models'))
    expect(scopedUrl).toBeDefined()
    expect(scopedUrl!.endsWith('/models')).toBe(true)
  })
})

describe('buddy runBuddyLoginFlow', () => {
  it('runs state → browser → token → account and returns the serialized credential', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { state: STATE, authUrl: AUTH_URL } }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0,
          data: { accessToken: 'AT', refreshToken: 'RT', expiresAt: '2026-08-30T00:00:00Z', refreshExpiresAt: '', tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u1', nickname: 'nick', enterpriseId: '', type: 'personal' } }), { status: 200 }),
      },
    ])

    const result = await runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })

    expect(opened).toEqual([AUTH_URL])
    expect(result.loginUrl).toBe(AUTH_URL)
    expect(result.refreshable).toBe(true)
    expect(result.expires).toBe(Date.parse('2026-08-30T00:00:00Z'))
    const credential = JSON.parse(result.access) as BuddyCredential
    expect(credential).toMatchObject({
      access_token: 'AT', refresh_token: 'RT', user_id: 'u1', nickname: 'nick', account_type: 'personal',
    })
  })

  it('propagates auth/state failures and never opens the browser', async () => {
    const opened: string[] = []
    const fetcher = routeFetch([{ when: () => true, respond: () => new Response('boom', { status: 500 }) }])
    await expect(runBuddyLoginFlow({
      fetcher,
      pollIntervalMs: 0,
      openBrowser: (url) => { opened.push(url) },
    })).rejects.toThrow('auth/state HTTP 500')
    expect(opened).toEqual([])
  })
})

describe('产品参数化', () => {
  it('fetchAuthState 默认使用 CodeBuddy 的 platform=ide', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher)
    const [url] = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]
    expect(url).toContain('platform=ide')
  })

  it('fetchAuthState 传入 WorkBuddy 配置时使用 platform=workbuddy', async () => {
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher, undefined, BUDDY)
    const [url] = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]
    expect(url).toContain('platform=workbuddy')
  })

  it('runBuddyLoginFlow 在 CodeBuddy 下不追加 version/loginSessionId', async () => {
    let openedUrl = ''
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'copilot.tencent.com' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({
      fetcher, pollIntervalMs: 0, product: BUDDY_CN,
      openBrowser: (url) => { openedUrl = url },
    })
    expect(openedUrl).not.toContain('loginSessionId')
    expect(openedUrl).not.toContain('version=')
  })

  it('runBuddyLoginFlow 在 WorkBuddy 下追加 version 与 loginSessionId', async () => {
    let openedUrl = ''
    // ⚠️ 凭据 domain 必须与 product 的归属一致（这里是国际版）：`accessToken: 'AT'`
    // 不是 JWT、没有 `iss`，故归属只能按 domain 判 —— 写成 CN 的
    // `copilot.tencent.com` 会被登录链的归属闸门判成「凭据属于另一个产品」并拒绝。
    // 本用例测的是 URL 装饰，凭据内容只是流程的过路数据，故按产品写对即可。
    const fetcher = routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'www.workbuddy.ai' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    await runBuddyLoginFlow({
      fetcher, pollIntervalMs: 0, product: BUDDY,
      openBrowser: (url) => { openedUrl = url },
    })
    expect(openedUrl).toContain(`version=${BUDDY.pluginVersion as string}`)
    expect(openedUrl).toMatch(/loginSessionId=[0-9a-f-]{36}/)
    // 服务端下发的 platform 与 state 必须保留
    expect(openedUrl).toContain('platform=workbuddy')
    expect(openedUrl).toContain('state=S')
  })

  it('WorkBuddy 的 loginSessionId 每次登录都不同', async () => {
    // 同上一用例：`AT` 不是 JWT（无 `iss`），归属只能按 domain 判 ——
    // 国际版产品必须配国际版 domain，否则会被归属闸门拒绝。
    const mk = () => routeFetch([
      {
        when: (url) => url.includes('/auth/state'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?platform=workbuddy&state=S' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/auth/token'),
        respond: () => new Response(JSON.stringify({
          code: 0, data: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, tokenType: 'Bearer', scope: '', domain: 'www.workbuddy.ai' },
        }), { status: 200 }),
      },
      {
        when: (url) => url.includes('/login/account'),
        respond: () => new Response(JSON.stringify({ code: 0, data: { uid: 'u', nickname: 'n', type: 'personal' } }), { status: 200 }),
      },
    ])
    const urls: string[] = []
    for (let i = 0; i < 2; i++) {
      await runBuddyLoginFlow({
        fetcher: mk(), pollIntervalMs: 0, product: BUDDY,
        openBrowser: (url) => { urls.push(url) },
      })
    }
    const id1 = new URL(urls[0]).searchParams.get('loginSessionId')
    const id2 = new URL(urls[1]).searchParams.get('loginSessionId')
    expect(id1).not.toBe(id2)
  })
})

describe('decorateLoginUrl', () => {
  it('只追加参数，不重建 URL（保留服务端独有参数）', () => {
    // serverOnly 不在任何 product 配置里：只有「在服务端 authUrl 上追加」的实现
    // 才能保留它；若实现改为「按 product 配置重建 URL」，platform/state 会被
    // 硬编码值覆盖（或整体丢失），认证随即失败。
    const authUrl = 'https://copilot.tencent.com/login?platform=workbuddy&state=S&serverOnly=keep-me'
    const result = decorateLoginUrl(authUrl, BUDDY)
    const url = new URL(result)
    expect(url.searchParams.get('serverOnly')).toBe('keep-me')
    expect(url.searchParams.get('platform')).toBe('workbuddy')
    expect(url.searchParams.get('state')).toBe('S')
    expect(url.searchParams.get('version')).toBe(BUDDY.pluginVersion)
    expect(url.searchParams.get('loginSessionId')).toBeTruthy()
    // 路径与 origin 也必须原样保留
    expect(url.origin).toBe('https://copilot.tencent.com')
    expect(url.pathname).toBe('/login')
  })

  it('appendSessionParams 为 false 时原样返回同一个字符串', () => {
    const authUrl = 'https://copilot.tencent.com/login?platform=ide&state=S'
    expect(decorateLoginUrl(authUrl, BUDDY_CN)).toBe(authUrl)
  })

  it('URL 非法时原样返回', () => {
    expect(decorateLoginUrl('not a url', BUDDY)).toBe('not a url')
    expect(decorateLoginUrl('', BUDDY)).toBe('')
  })

  it('pluginVersion 缺失时不追加 version 参数', () => {
    const noVersion: BuddyProduct = { ...BUDDY, pluginVersion: undefined }
    const url = new URL(decorateLoginUrl('https://copilot.tencent.com/login?state=S', noVersion))
    expect(url.searchParams.has('version')).toBe(false)
    expect(url.searchParams.has('loginSessionId')).toBe(true)
  })

  it('fetchAuthState 使用 product.userAgent 作为请求头', async () => {
    // 两个内置产品的 userAgent 字面量相同，无法观测该行为；注入自定义 UA 以锁定它。
    const custom: BuddyProduct = { ...BUDDY_CN, userAgent: 'CustomAgent/9.9.9' }
    const fetcher = routeFetch([{
      when: (url) => url.includes('/auth/state'),
      respond: () => new Response(JSON.stringify({
        code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/login?state=S' },
      }), { status: 200 }),
    }])
    await fetchAuthState(fetcher, undefined, custom)
    const [, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('CustomAgent/9.9.9')
  })
})
