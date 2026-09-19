/**
 * Qoder 额度余额单测（**全 mock，零网络**）。
 *
 * ## fixture 的来源：T1 真机实测的 quota 原文
 *
 * {@link T1_QUOTA_RESPONSE} 是 T1 轮真机
 * `GET https://openapi.qoder.sh/api/v2/quota/usage` + `Bearer jt-…` 的
 * **逐字节原文**（脱敏：只去掉令牌本身）。不凭记忆编造、不「顺手补全」字段 ——
 * **缺席的字段本身就是要被测的语义**：`addOnQuota` / `orgResourcePackage`
 * 在本账号上根本不存在，解析必须容缺（CLI2API 的 `quota.go` 用指针类型正是
 * 这个原因）。
 *
 * ## 本快照钉死的事实（每条都有对应用例）
 *
 * 1. **三池结构，后两池可缺席** → 容缺解析；
 * 2. **`isQuotaExceeded: true` 但主池全 0** → 判定为「确证耗尽」；
 * 3. **`expiresAt: 253402214400000` 是毫秒**（9999 年 = 不过期），当成秒会
 *    算出公元 800 万年 → 有专门的用例；
 * 4. **响应里没有包名字段**（只有池**类型**）→ 包名取池类型的中文名；
 * 5. **`userId` / `userType` 在这里**（exchange 响应里没有）→ 身份回写缺口
 *    由本模块补上。
 */

import { describe, expect, it, vi } from 'vitest'
import type { QoderCredential } from '../../src/qoder-product.js'
import { QODER, QODER_QUOTA_USAGE_PATH } from '../../src/qoder-product.js'
import {
  applyQoderUserIdentity,
  checkQoderQuotaExhausted,
  fetchQoderCreditBalance,
  fetchQoderQuotaUsage,
  isQoderQuotaExhausted,
  parseQoderQuotaExpiresAtMs,
  parseQoderQuotaUsage,
  qoderQuotaRemainingTotal,
  type QoderJobTokenProvider,
} from '../../src/qoder-credits.js'

// ── T1 真机快照（逐字节） ──

/**
 * T1 实测原文。
 *
 * ⚠️ **不要「整理」这个对象**：字段顺序、`0.0` 这种浮点写法、`expiresAt` 的
 * 十三位毫秒值、缺席的 `addOnQuota` / `orgResourcePackage` 全是实测形态。
 * 尤其是 `expiresAt`：`253402214400000` 当秒算就是公元 800 万年。
 */
const T1_QUOTA_RESPONSE = {
  userId: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
  userType: 'personal_standard',
  usageType: 'credits',
  totalUsagePercentage: 0.0,
  isQuotaExceeded: true,
  expiresAt: 253402214400000,
  upgradeUrl: 'https://qoder.com/pricing?client=qoder',
  outerProviders: [],
  userQuota: { total: 0.0, used: 0.0, remaining: 0.0, percentage: 0.0, unit: 'credits' },
  isPlanQuotaProrated: false,
}

/** T1 响应体序列化后的文本（模拟真实响应字节）。 */
const T1_QUOTA_TEXT = JSON.stringify(T1_QUOTA_RESPONSE)

/** 形态完整的凭据（PAT 本体在 `access_token`）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-test-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/** 一次被捕获的请求。 */
interface CapturedRequest {
  url: string
  init: RequestInit | undefined
}

/**
 * 造一个可控的 job token 提供者。
 *
 * `getJobToken` 每次返回**新**令牌（`jt-1` / `jt-2`…），使「401 后是否重换」
 * 可以从请求头上一眼看出来；`invalidateJobToken` 被调用时会记账。
 */
function jobTokenProvider(): QoderJobTokenProvider & {
  invalidated: string[]
  issued: number
} {
  let issued = 0
  const invalidated: string[] = []
  return {
    invalidated,
    get issued() { return issued },
    async getJobToken() {
      issued += 1
      return `jt-${issued}`
    },
    invalidateJobToken(pat: string) {
      invalidated.push(pat)
    },
  }
}

/** 造一个记录请求的 fetch，按序返回给定响应。 */
function sequencedFetch(responses: readonly Response[]): {
  fetcher: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  let index = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response
  }) as unknown as typeof fetch
  return { fetcher, requests }
}

/** 构造一个 JSON 响应。 */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 只提供 userQuota 的响应（容缺样本）。 */
function withPools(pools: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    userId: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
    userType: 'personal_standard',
    usageType: 'credits',
    isQuotaExceeded: false,
    expiresAt: 253402214400000,
    ...pools,
    ...overrides,
  })
}

// ── 1. 解析：T1 原文 + 三池容缺 ──

describe('parseQoderQuotaUsage：T1 原文与三池容缺', () => {
  it('解析 T1 原文的每一个字段', () => {
    const usage = parseQoderQuotaUsage(T1_QUOTA_RESPONSE)
    expect(usage).toBeDefined()
    expect(usage?.userId).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(usage?.userType).toBe('personal_standard')
    expect(usage?.usageType).toBe('credits')
    expect(usage?.totalUsagePercentage).toBe(0)
    expect(usage?.isQuotaExceeded).toBe(true)
    expect(usage?.upgradeUrl).toBe('https://qoder.com/pricing?client=qoder')
    expect(usage?.isPlanQuotaProrated).toBe(false)
    expect(usage?.pools).toHaveLength(1)
  })

  it('缺席的 addOnQuota / orgResourcePackage 是「池不存在」，不是「余额为 0」', () => {
    const usage = parseQoderQuotaUsage(T1_QUOTA_RESPONSE)
    // 池列表里只有实测存在的 userQuota —— 不能凭空补出两个 0 值池。
    expect(usage?.pools.map((pool) => pool.key)).toEqual(['userQuota'])
  })

  it('三池齐全时按声明顺序解析，且每池字段逐项对齐', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 100, used: 100, remaining: 0, percentage: 100, unit: 'credits', available: false },
      addOnQuota: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits', available: true },
      orgResourcePackage: { total: 200, used: 0, remaining: 200, percentage: 0, unit: 'credits' },
    })))
    expect(usage?.pools.map((pool) => pool.key))
      .toEqual(['userQuota', 'addOnQuota', 'orgResourcePackage'])
    expect(usage?.pools.map((pool) => pool.name)).toEqual(['主额度', '加量包', '资源包'])
    expect(usage?.pools[1]).toMatchObject({
      total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits', available: true,
    })
    // available 只记录、不参与过滤：第三个池没有该字段，仍然在列。
    expect(usage?.pools[2]).not.toHaveProperty('available')
  })

  it('池缺 unit 时回退到实测单位（不把 undefined 渲染上去）', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 10, used: 0, remaining: 10, percentage: 0 },
    })))
    expect(usage?.pools[0].unit).toBe('credits')
  })

  it('一个池都没有 ⇒ undefined（查不到），不是「余额 0」', () => {
    expect(parseQoderQuotaUsage(JSON.parse(withPools({})))).toBeUndefined()
    expect(parseQoderQuotaUsage({ userId: 'x', isQuotaExceeded: false })).toBeUndefined()
  })

  it('非对象输入一律 undefined', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(parseQoderQuotaUsage(value)).toBeUndefined()
    }
  })

  it('snake_case 的 userId / user_type 也收（两种命名都出现在上游）', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools(
      { userQuota: { total: 1, used: 0, remaining: 1, percentage: 0, unit: 'credits' } },
      { userId: undefined, user_id: 'snake-id', userType: undefined, user_type: 'snake-type' },
    )))
    expect(usage?.userId).toBe('snake-id')
    expect(usage?.userType).toBe('snake-type')
  })

  it('缺 isQuotaExceeded / isPlanQuotaProrated 时按 false 归一，不报 undefined', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools(
      { userQuota: { total: 1, used: 0, remaining: 1, percentage: 0, unit: 'credits' } },
      { isQuotaExceeded: undefined, isPlanQuotaProrated: undefined },
    )))
    expect(usage?.isQuotaExceeded).toBe(false)
    expect(usage?.isPlanQuotaProrated).toBe(false)
  })
})

// ── 2. expiresAt 是毫秒，不是秒 ──

describe('parseQoderQuotaExpiresAtMs：毫秒不当秒算', () => {
  it('T1 的 253402214400000 原样是毫秒（9999 年，永不过期）', () => {
    const parsed = parseQoderQuotaExpiresAtMs(253402214400000)
    expect(parsed).toBe(253402214400000)
    // 当成秒会得到 2.534e17 —— 断言它**没有**被乘 1000。
    expect(parsed).not.toBe(253402214400000 * 1000)
    expect(new Date(parsed as number).getUTCFullYear()).toBe(9999)
  })

  it('字符串形态的毫秒值同样不乘 1000', () => {
    expect(parseQoderQuotaExpiresAtMs('253402214400000')).toBe(253402214400000)
  })

  it('真正的秒级时间戳（10 位）才乘 1000', () => {
    expect(parseQoderQuotaExpiresAtMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(parseQoderQuotaExpiresAtMs('1700000000')).toBe(1_700_000_000_000)
  })

  it('ISO 8601 与非法值', () => {
    expect(parseQoderQuotaExpiresAtMs('2026-09-19T00:00:00Z')).toBe(Date.parse('2026-09-19T00:00:00Z'))
    for (const value of [undefined, null, '', '  ', 'not-a-date', Number.NaN, {}]) {
      expect(parseQoderQuotaExpiresAtMs(value)).toBeUndefined()
    }
  })
})

// ── 3. 余额口径 ──

describe('fetchQoderCreditBalance：余额口径', () => {
  it('T1 账号：三池全 0 ⇒ total 0、包列表为空（余额 0 ≠ 查不到）', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })

    expect(balance).toEqual({ total: 0, packages: [], expiredTotal: 0 })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`${QODER.openapiBase}${QODER_QUOTA_USAGE_PATH}`)
  })

  it('用 jt 作 Bearer（不是 PAT）—— 端点只认 job token', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jt-1')
    expect(headers.Authorization).not.toContain('pt-test-token')
    expect(headers['User-Agent']).toBe(QODER.userAgent)
    expect(requests[0].init?.method).toBe('GET')
  })

  it('三池齐全：total = 三池 remaining 之和，包名取池类型的中文名', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 100, used: 100, remaining: 0, percentage: 100, unit: 'credits' },
      addOnQuota: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits' },
      orgResourcePackage: { total: 200, used: 100, remaining: 100, percentage: 50, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })

    expect(balance?.total).toBe(140)
    expect(balance?.expiredTotal).toBe(0)
    // 主池 remaining 为 0 但 total 为 100 ⇒ 仍在列（有余额**或**有总量）。
    expect(balance?.packages.map((pkg) => pkg.name)).toEqual(['主额度', '加量包', '资源包'])
    expect(balance?.packages.map((pkg) => pkg.remaining)).toEqual([0, 40, 100])
    expect(balance?.packages[1]).toMatchObject({ total: 50, used: 10, unit: 'credits', active: true })
  })

  it('有余额或有总量的池才进包列表；全零池不占一行', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      addOnQuota: { total: 0, used: 0, remaining: 5, percentage: 0, unit: 'credits' },
      orgResourcePackage: { total: 80, used: 80, remaining: 0, percentage: 100, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    // 主池三值全 0 → 不列；加量包有余额 → 列；资源包有总量 → 列。
    expect(balance?.packages.map((pkg) => pkg.name)).toEqual(['加量包', '资源包'])
  })

  it('负数 clamp 到 0（超额扣费 / 计量回滚），total 不会变负', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: -10, used: 120, remaining: -20, percentage: 120, unit: 'credits' },
      addOnQuota: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    expect(balance?.total).toBe(40)
    // 负数池 clamp 后三值全 0 ⇒ 无实质内容，不占一行（判据用的是**原始值**，
    // 所以它不会被「clamp 之后恰好是 0」混进列表）。
    expect(balance?.packages.map((pkg) => pkg.name)).toEqual(['加量包'])
    expect(balance?.packages[0].remaining).toBe(40)
  })

  it('池内既有负值又有正值时，透出的字段已 clamp（不会显示 -30）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 100, used: 130, remaining: -30, percentage: 130, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    expect(balance?.total).toBe(0)
    // 该池有 total ⇒ 仍在列，但 remaining 是 0 而不是 -30。
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]).toMatchObject({ name: '主额度', remaining: 0, total: 100, used: 130 })
  })

  it('包对象与 CreditPackage 逐字段同构（前端不做 provider 分支）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 10, used: 2, remaining: 8, percentage: 20, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    expect(Object.keys(balance?.packages[0] ?? {}).sort()).toEqual([
      'active', 'cycleEndTime', 'cycleStartTime', 'expiredTime',
      'name', 'remaining', 'total', 'unit', 'used',
    ])
    expect(Object.keys(balance ?? {}).sort()).toEqual(['expiredTotal', 'packages', 'total'])
  })
})

// ── 4. roundCredits：多池浮点噪声 ──

describe('roundCredits：多池浮点噪声规整', () => {
  it('0.1 + 0.2 + 0.3 规整为 0.6（原始浮点是 0.6000000000000001）', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 1, used: 0, remaining: 0.1, percentage: 0, unit: 'credits' },
      addOnQuota: { total: 1, used: 0, remaining: 0.2, percentage: 0, unit: 'credits' },
      orgResourcePackage: { total: 1, used: 0, remaining: 0.3, percentage: 0, unit: 'credits' },
    })))
    expect(usage).toBeDefined()
    // 先证明这个样本真的会产生浮点噪声（否则本用例是空转的）。
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6)
    expect(qoderQuotaRemainingTotal(usage!)).toBe(0.6)
  })

  it('服务端下发的 55.67000031 规整为 55.67', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 100, used: 44.33, remaining: 55.67000031, percentage: 44.33, unit: 'credits' },
    }))])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    expect(balance?.total).toBe(55.67)
  })
})

// ── 5. 查不到 vs 余额 0 ──

describe('fetchQoderCreditBalance：「查不到」与「余额为 0」严格区分', () => {
  it('网络失败 ⇒ null（不是 0 余额）', async () => {
    const auth = jobTokenProvider()
    const fetcher = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    expect(await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })).toBeNull()
  })

  it('响应不是 JSON ⇒ null', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse('<html>502</html>')])
    expect(await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })).toBeNull()
  })

  it('三池全缺 ⇒ null（形态不认识，不当成 0）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(JSON.stringify({ code: 0, data: null }))])
    expect(await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })).toBeNull()
  })

  it('PAT 为空 ⇒ null，且一次网络请求都不发', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const balance = await fetchQoderCreditBalance({ ...CREDENTIAL, access_token: '' }, auth, { fetcher })
    expect(balance).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('余额为 0 的 T1 账号返回对象（对照上面的 null 分支）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher })
    expect(balance).not.toBeNull()
    expect(balance?.total).toBe(0)
  })

  it('调试出口能报出「三池缺失」时的顶层字段名（真机校准用）', async () => {
    const auth = jobTokenProvider()
    const onDebug = vi.fn()
    const { fetcher } = sequencedFetch([jsonResponse(JSON.stringify({ foo: 1, bar: 2 }))])
    await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher, onDebug })
    expect(onDebug.mock.calls.map((call) => String(call[0])).join('\n')).toContain('foo,bar')
  })
})

// ── 6. 401 的两类分型 ──

describe('401 的两类分型：TOKEN_EXPIRE 重换一次 vs TOKEN_INVALID 直报', () => {
  it('TOKEN_EXPIRE ⇒ 丢弃 jt 缓存、重换一次并成功', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([
      jsonResponse(JSON.stringify({ error: 'TOKEN_EXPIRE' }), 401),
      jsonResponse(T1_QUOTA_TEXT),
    ])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })

    expect(result.ok).toBe(true)
    expect(requests).toHaveLength(2)
    // 第一次用 jt-1，重换之后用 jt-2 —— 证明真的走了 invalidate + 重取。
    expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer jt-1')
    expect((requests[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer jt-2')
    expect(auth.invalidated).toEqual(['pt-test-token'])
  })

  it('TOKEN_INVALID ⇒ 直接报「重新粘贴 PAT」，不重换（重换救不了类型错）', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([
      jsonResponse(JSON.stringify({ error: 'TOKEN_INVALID', message: 'invalid token type' }), 401),
    ])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })

    expect(result.ok).toBe(false)
    // 只打一次：类型错是确定性失败，重换 jt 只会再撞一次同一堵墙。
    expect(requests).toHaveLength(1)
    expect(auth.invalidated).toEqual([])
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.credentialInvalid).toBe(true)
    expect(result.classification?.jobTokenExpired).toBe(false)
    expect(result.message).toContain('重新粘贴')
  })

  it('TOKEN_EXPIRE 重换后仍然 401 ⇒ 上报失败，且不再重试第三次', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([
      jsonResponse(JSON.stringify({ error: 'TOKEN_EXPIRE' }), 401),
      jsonResponse(JSON.stringify({ error: 'TOKEN_EXPIRE' }), 401),
    ])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    expect(result.ok).toBe(false)
    expect(requests).toHaveLength(2)
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.jobTokenExpired).toBe(true)
  })

  it('401 无法分型时保守判凭据失效（额度端点的 401 重换救不回来）', async () => {
    const auth = jobTokenProvider()
    const { fetcher, requests } = sequencedFetch([
      jsonResponse(JSON.stringify({ error: 'unauthorized' }), 401),
    ])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    expect(requests).toHaveLength(1)
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.credentialInvalid).toBe(true)
  })

  it('403 ⇒ 凭据被拒绝（重新粘贴）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(JSON.stringify({ error: 'forbidden' }), 403)])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.credentialInvalid).toBe(true)
  })

  it('5xx ⇒ 不是凭据问题，也不判额度耗尽', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(JSON.stringify({ error: 'boom' }), 503)])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.credentialInvalid).toBe(false)
    expect(result.classification?.action).toBe('backoff')
  })

  it('换 jt 抛 RefreshTokenExpiredError ⇒ 判凭据失效（按 error.name，不靠 instanceof）', async () => {
    const expired = new Error('PAT 已失效或不被接受，请重新粘贴')
    expired.name = 'RefreshTokenExpiredError'
    const auth: QoderJobTokenProvider = {
      getJobToken: async () => { throw expired },
      invalidateJobToken: () => {},
    }
    const { fetcher, requests } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher })
    expect(requests).toHaveLength(0)
    if (result.ok) throw new Error('unreachable')
    expect(result.classification?.credentialInvalid).toBe(true)
    expect(result.message).toContain('重新粘贴')
  })

  it('换 jt 抛普通 Error（断网）⇒ 不判凭据失效', async () => {
    const auth: QoderJobTokenProvider = {
      getJobToken: async () => { throw new Error('ECONNRESET') },
      invalidateJobToken: () => {},
    }
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const result = await fetchQoderQuotaUsage(CREDENTIAL, auth, { fetcher, product: QODER })
    if (result.ok) throw new Error('unreachable')
    expect(result.classification).toBeUndefined()
    expect(result.message).toContain('ECONNRESET')
  })
})

// ── 7. 额度耗尽判别（402 二次判别的数据源） ──

describe('checkQoderQuotaExhausted：主池尽但加量包有余 = 未耗尽', () => {
  it('T1 账号（isQuotaExceeded true + 主池全 0）⇒ exhausted true', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    expect(await checkQoderQuotaExhausted(CREDENTIAL, auth, { fetcher })).toEqual({ exhausted: true })
  })

  it('主池耗尽但加量包有余 ⇒ exhausted false（判 true 会白白废掉可用账号）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(withPools({
      userQuota: { total: 100, used: 100, remaining: 0, percentage: 100, unit: 'credits' },
      addOnQuota: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits' },
    }, { isQuotaExceeded: true }))])
    expect(await checkQoderQuotaExhausted(CREDENTIAL, auth, { fetcher })).toEqual({ exhausted: false })
  })

  it('主池耗尽但资源包有余 ⇒ exhausted false', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 10, used: 10, remaining: 0, percentage: 100, unit: 'credits' },
      orgResourcePackage: { total: 500, used: 0, remaining: 500, percentage: 0, unit: 'credits' },
    }, { isQuotaExceeded: true })))
    expect(isQoderQuotaExhausted(usage!)).toBe(false)
  })

  it('三池全 0 但服务端没自报超额 ⇒ exhausted false（两条判据缺一不可）', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
    }, { isQuotaExceeded: false })))
    expect(isQoderQuotaExhausted(usage!)).toBe(false)
  })

  it('池 remaining 为负（异常值）同样算「无余额」', () => {
    const usage = parseQoderQuotaUsage(JSON.parse(withPools({
      userQuota: { total: 10, used: 30, remaining: -20, percentage: 300, unit: 'credits' },
    }, { isQuotaExceeded: true })))
    expect(isQoderQuotaExhausted(usage!)).toBe(true)
  })

  it('查询失败 ⇒ undefined（未确证），不是 { exhausted: false }', async () => {
    const auth = jobTokenProvider()
    const fetcher = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkQoderQuotaExhausted(CREDENTIAL, auth, { fetcher })).toBeUndefined()

    const { fetcher: badBody } = sequencedFetch([jsonResponse(JSON.stringify({ foo: 1 }))])
    expect(await checkQoderQuotaExhausted(CREDENTIAL, jobTokenProvider(), { fetcher: badBody })).toBeUndefined()
  })

  it('返回值形态恰好是 QoderQuotaVerdict（可直接喂 applyQoderQuotaVerdict）', async () => {
    const auth = jobTokenProvider()
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const verdict = await checkQoderQuotaExhausted(CREDENTIAL, auth, { fetcher })
    expect(verdict).toBeDefined()
    expect(Object.keys(verdict as object)).toEqual(['exhausted'])
  })
})

// ── 8. userId / userType 回写 ──

describe('身份回写：exchange 缺的 userId / userType 由 quota 响应补上', () => {
  it('applyQoderUserIdentity 把新字段合并进凭据，并保留 PAT / jrt', () => {
    const updated = applyQoderUserIdentity(CREDENTIAL, {
      userId: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
      userType: 'personal_standard',
    })
    expect(updated.user_id).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(updated.user_type).toBe('personal_standard')
    expect(updated.access_token).toBe('pt-test-token')
    expect(updated.refresh_token).toBe('jrt-test')
    expect(updated.token_expires_at).toBe('0')
  })

  it('响应没带身份字段时沿用旧值（不把已有身份抹掉）', () => {
    const previous: QoderCredential = { ...CREDENTIAL, user_id: 'old-id', user_type: 'old-type' }
    const updated = applyQoderUserIdentity(previous, {})
    expect(updated.user_id).toBe('old-id')
    expect(updated.user_type).toBe('old-type')
  })

  it('无变化时返回同一个对象引用（调用方据此免去一次落盘）', () => {
    const previous: QoderCredential = { ...CREDENTIAL, user_id: 'same', user_type: 'same-type' }
    const updated = applyQoderUserIdentity(previous, { userId: 'same', userType: 'same-type' })
    expect(updated).toBe(previous)
  })

  it('空串身份不覆盖旧值', () => {
    const previous: QoderCredential = { ...CREDENTIAL, user_id: 'keep-me' }
    expect(applyQoderUserIdentity(previous, { userId: '' }).user_id).toBe('keep-me')
  })

  it('查询余额时身份有变化 ⇒ 调一次 persistIdentity，入参是合并后的凭据', async () => {
    const auth = jobTokenProvider()
    const persistIdentity = vi.fn(async () => {})
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher, persistIdentity })

    expect(persistIdentity).toHaveBeenCalledTimes(1)
    const passed = persistIdentity.mock.calls[0][0] as QoderCredential
    expect(passed.user_id).toBe('01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e')
    expect(passed.access_token).toBe('pt-test-token')
  })

  it('身份无变化 ⇒ 一次都不写（刷新积分不该抖动磁盘）', async () => {
    const auth = jobTokenProvider()
    const persistIdentity = vi.fn(async () => {})
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const credential: QoderCredential = {
      ...CREDENTIAL,
      user_id: '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e',
      user_type: 'personal_standard',
    }
    await fetchQoderCreditBalance(credential, auth, { fetcher, persistIdentity })
    expect(persistIdentity).not.toHaveBeenCalled()
  })

  it('回写出口抛错不影响余额结果（身份只影响昵称显示）', async () => {
    const auth = jobTokenProvider()
    const onDebug = vi.fn()
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    const balance = await fetchQoderCreditBalance(CREDENTIAL, auth, {
      fetcher,
      persistIdentity: async () => { throw new Error('credentials locked') },
      onDebug,
    })
    expect(balance).toEqual({ total: 0, packages: [], expiredTotal: 0 })
    expect(onDebug.mock.calls.map((call) => String(call[0])).join('\n')).toContain('身份回写失败')
  })

  it('额度耗尽判别同样会回写身份', async () => {
    const auth = jobTokenProvider()
    const persistIdentity = vi.fn(async () => {})
    const { fetcher } = sequencedFetch([jsonResponse(T1_QUOTA_TEXT)])
    await checkQoderQuotaExhausted(CREDENTIAL, auth, { fetcher, persistIdentity })
    expect(persistIdentity).toHaveBeenCalledTimes(1)
  })

  it('查询失败时**不**回写身份（响应里根本没有身份字段）', async () => {
    const auth = jobTokenProvider()
    const persistIdentity = vi.fn(async () => {})
    const fetcher = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    await fetchQoderCreditBalance(CREDENTIAL, auth, { fetcher, persistIdentity })
    expect(persistIdentity).not.toHaveBeenCalled()
  })
})
