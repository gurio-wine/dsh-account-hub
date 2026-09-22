/**
 * Qoder **每日领取（签到）** 的协议级单元测试。
 *
 * 被测对象是 `src/qoder-credits.ts` 的四个导出：
 * {@link parseQoderCampaigns} / {@link claimableQoderCampaigns} /
 * {@link fetchQoderCheckinStatus} / {@link claimQoderDailyCheckin}。
 *
 * ## 为什么单独一个文件
 *
 * `qoder-credits.spec.ts` 锁的是**余额面**（三池容缺、jt 自愈、分类器）；签到面
 * 是同一模块里新增的**第二条协议**（`/sash/api/v1/me/campaigns`），它的失效形态
 * 与余额**完全不同**：余额错了会显示一个错的数字，签到错了会**多发一次真领取**或
 * 把「今天已领」报成「领取成功 +100」。两者的断言没有交集，混在一起会互相稀释。
 *
 * ## 本文件钉死的四条硬约束（每条都对应真机事实，见模块头注释）
 *
 * 1. **幂等判据是响应体的 `replayed`，不是 HTTP 状态码** —— 重复领取同样回 200；
 * 2. **请求体必须是空串**（抓包实测 `content-length: 0`）；
 * 3. **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`**
 *    （`VIEW_DETAILS` 型活动不可发 claim）；
 * 4. **`campaigns` 为空不是「没有活动」**（服务端在「今天已领」时清空它）⇒
 *    `CheckinStatus.active` 恒为 true，无目标归一为 `already-claimed`。
 *
 * ## 替身边界
 *
 * 只有 **fetch** 与 **jt 提供者** 被替换（`QoderJobTokenProvider` 是刻意抽出的
 * 窄接口，见其注释）。被测代码本身全是真实实现 —— 因此「URL 打在哪个 host」
 * 「body 是不是空串」「有没有重换 jt」这类**真实副作用**才是被断言的对象。
 */

import { describe, expect, it } from 'vitest'
import {
  QODER_CAMPAIGNS_PATH,
  claimQoderDailyCheckin,
  claimableQoderCampaigns,
  fetchQoderCheckinStatus,
  parseQoderCampaigns,
} from '../../src/qoder-credits.js'
import { QODER, QODER_CN, type QoderCredential } from '../../src/qoder-product.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** 一份可用的 CN 凭据（签到只用 `access_token` 去换 jt）。 */
const CREDENTIAL: QoderCredential = { access_token: 'pt-cn-token', refresh_token: 'jrt-1' }

/** 一次被捕获的出网请求。 */
interface Call {
  url: string
  method: string
  authorization: string
  body: string
}

/**
 * jt 提供者替身。
 *
 * `tokens` 按**调用序**发放（第 N 次调用拿第 N 个，用尽后重复最后一个），
 * 这样「401 后是否真的重换了 jt」才是可断言的：重换会消耗下一个 token。
 */
function fakeAuth(options: { tokens?: string[]; failWith?: unknown } = {}) {
  const tokens = options.tokens ?? ['jt-1']
  let issued = 0
  return {
    calls: 0,
    invalidated: [] as string[],
    async getJobToken(_pat: string): Promise<string> {
      this.calls += 1
      if (options.failWith !== undefined) throw options.failWith
      const token = tokens[Math.min(issued, tokens.length - 1)]!
      issued += 1
      return token
    },
    invalidateJobToken(pat: string) { this.invalidated.push(pat) },
  }
}

/** 用一次出网替身包住 `respond`，并记录每次请求。 */
function withFetcher(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

/** 一条真机形状的可领活动。 */
function campaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: '01a0bf8d-cn-1',
    campaignKey: 'act-20260921-308',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { amount: 100 },
    ...overrides,
  }
}

/** 活动列表响应体。 */
function campaignsBody(items: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    showCampaign: true, claimable: true, campaigns: items, ...extra,
  }), { status: 200 })
}

// ── 解析层 ──────────────────────────────────────────────────────────────────

describe('parseQoderCampaigns —— 容缺规则', () => {
  it('顶层不是对象 ⇒ undefined（形态不认识 = 查不到，不是「无活动」）', () => {
    for (const value of [null, undefined, 42, 'x', []]) {
      expect(parseQoderCampaigns(value)).toBeUndefined()
    }
  })

  it('`campaigns` 缺失 / null / 非数组 ⇒ 按空列表归一（不是形态错误）', () => {
    // 「今天已领」时服务端确实回空数组，而字段整个缺失与空数组语义同向
    //（都没有可领项），故不把它当形态错误 —— 否则查得到响应却判成「查不到」。
    for (const value of [
      { showCampaign: false },
      { showCampaign: false, campaigns: null },
      { showCampaign: false, campaigns: 'nope' },
    ]) {
      expect(parseQoderCampaigns(value)?.campaigns).toEqual([])
    }
  })

  it('单条缺 campaignId ⇒ 跳过该条（拿不到 id 就发不出 claim）', () => {
    const parsed = parseQoderCampaigns({
      campaigns: [campaign(), { actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }, campaign({ campaignId: 'two' })],
    })
    expect(parsed?.campaigns.map((c) => c.campaignId)).toEqual(['01a0bf8d-cn-1', 'two'])
  })

  it('`showCampaign` / `claimable` 只认显式 true（但它们不参与任何判定）', () => {
    const parsed = parseQoderCampaigns({ campaigns: [], showCampaign: 'true', claimable: 1 })
    expect(parsed).toEqual({ showCampaign: false, claimable: false, campaigns: [] })
  })

  it('可领积分读 `benefit.amount`（嵌套一层），数字字符串也接受', () => {
    const parsed = parseQoderCampaigns({
      campaigns: [campaign({ benefit: { amount: '150' } }), campaign({ campaignId: 'b', benefit: {} })],
    })
    expect(parsed?.campaigns.map((c) => c.amount)).toEqual([150, undefined])
  })
})

describe('claimableQoderCampaigns —— 两个条件缺一不可', () => {
  const items = [
    campaign(),
    // `VIEW_DETAILS` 型（如「Pro 首月翻倍」）：对它发 claim 是错的。
    campaign({ campaignId: 'view', actionType: 'VIEW_DETAILS' }),
    // 已领过的：只判 actionType 会再领一次。
    campaign({ campaignId: 'done', claimStatus: 'CLAIMED' }),
    // 两个字段都缺：什么都不满足。
    campaign({ campaignId: 'bare', actionType: undefined, claimStatus: undefined }),
  ]

  it('只留 CLAIM_BENEFIT + CLAIMABLE 的那一条', () => {
    const parsed = parseQoderCampaigns({ campaigns: items })!
    expect(claimableQoderCampaigns(parsed).map((c) => c.campaignId)).toEqual(['01a0bf8d-cn-1'])
  })

  it('只判 actionType 会漏掉已领（反证：把 claimStatus 放宽后集合变大）', () => {
    // 这条是上面那条的**反向证据**：证明过滤确实同时用了两个条件，
    // 而不是恰好只命中一条。
    const parsed = parseQoderCampaigns({ campaigns: items })!
    const byAction = parsed.campaigns.filter((c) => c.actionType === 'CLAIM_BENEFIT')
    expect(byAction.length).toBeGreaterThan(claimableQoderCampaigns(parsed).length)
  })
})

// ── 状态查询 ────────────────────────────────────────────────────────────────

describe('fetchQoderCheckinStatus —— active 恒为 true', () => {
  it('有可领活动 ⇒ todayCheckedIn 为 false、dailyCredit 取活动声明的额度', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([campaign()]))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(status).toMatchObject({ active: true, todayCheckedIn: false, dailyCredit: 100 })
    expect(calls[0]!.url).toBe(`${QODER_CN.openapiBase}${QODER_CAMPAIGNS_PATH}`)
    expect(calls[0]!.url).toContain('.qoder.com.cn')
  })

  it('**列表为空也 active:true**，且 todayCheckedIn 为 true（今天已领）', async () => {
    // ⚠️ 本文件最重要的一条：`active` 若按列表是否为空判，调用方
    //（`collectClaimResults` 的预检）会先命中「活动未开启」分支，把
    //「今天已领」误报成「签到活动未开启」。
    const { fetcher } = withFetcher(() => campaignsBody([], { showCampaign: false, claimable: false }))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(status).toMatchObject({ active: true, todayCheckedIn: true })
  })

  it('无任何 CLAIM_BENEFIT 活动时 dailyCredit 为 0（不编造额度）', async () => {
    const { fetcher } = withFetcher(() => campaignsBody([campaign({ actionType: 'VIEW_DETAILS' })]))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(status).toMatchObject({ todayCheckedIn: true, dailyCredit: 0 })
  })

  it('查询失败（非 2xx / 非 JSON / 网络抛错）一律回 null —— 「查不到」≠「无活动」', async () => {
    const cases: Array<(call: Call) => Response> = [
      () => new Response('boom', { status: 500 }),
      () => new Response('<html>', { status: 200 }),
      () => { throw new TypeError('fetch failed') },
    ]
    for (const respond of cases) {
      const { fetcher } = withFetcher(respond)
      expect(await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })).toBeNull()
    }
  })
})

// ── 领取 ────────────────────────────────────────────────────────────────────

describe('claimQoderDailyCheckin —— 领取与幂等', () => {
  it('领到 100：POST 打 `{campaigns}/{id}/claim`，body 是**空串**', async () => {
    const { fetcher, calls } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
      : campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome).toEqual({ kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe(`${QODER_CN.openapiBase}${QODER_CAMPAIGNS_PATH}/01a0bf8d-cn-1/claim`)
    // ⚠️ 抓包实测 `content-length: 0`；发 `{}` 属未经验证的形态。
    expect(post.body).toBe('')
    // 只读一次列表（claim 自带预检 ⇒ 宿主传 precheckStatus:false 才不会重复 GET）。
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('幂等：HTTP 200 + `replayed:true` 归一为 already-claimed（**不是** claimed +100）', async () => {
    // 实测重复领取同样回 200，但 `replayed:true`、不含 `benefit`，
    // 且 `claimedAt` 是上一次领取的旧时间。只看状态码就会虚报一笔积分。
    const { fetcher } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ replayed: true, claimedAt: '2026-09-18T02:00:00Z' }), { status: 200 })
      : campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(outcome.kind).toBe('already-claimed')
  })

  it('列表为空 ⇒ already-claimed，且**一次 claim 都不发**', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([], { showCampaign: false, claimable: false }))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome.kind).toBe('already-claimed')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('`VIEW_DETAILS` 型活动不被领取（零 POST）', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([campaign({ actionType: 'VIEW_DETAILS' })]))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome.kind).toBe('already-claimed')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('多个可领活动逐个领取并**累加**积分', async () => {
    let postCount = 0
    const { fetcher, calls } = withFetcher((call) => {
      if (call.method !== 'POST') {
        return campaignsBody([campaign(), campaign({ campaignId: 'second', benefit: { amount: 50 } })])
      }
      postCount += 1
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: postCount === 1 ? 100 : 50 } }), { status: 200 })
    })

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(outcome).toEqual({ kind: 'claimed', credit: 150, streakDays: 0, isStreakDay: false })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('活动列表查不到 ⇒ failed（**不是** already-claimed：查不到 ≠ 已领），且带精确原因', async () => {
    const { fetcher } = withFetcher(() => new Response('nope', { status: 503 }))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome.kind).toBe('failed')
    // ⚠️ 原因必须带出去：把 503 压成一句「活动列表查询失败」会让用户
    // 在一个自己修不了的方向上排查。
    expect(outcome.kind === 'failed' && outcome.message).toContain('活动列表查询失败：')
    expect(outcome.kind === 'failed' && outcome.message).toContain('503')
  })

  it('claim 非 2xx / 非 JSON ⇒ failed 且带状态码', async () => {
    for (const respond of [
      () => new Response('{"error":"boom"}', { status: 500 }),
      () => new Response('<html>gateway</html>', { status: 502 }),
    ]) {
      const { fetcher } = withFetcher((call) => call.method === 'POST' ? respond() : campaignsBody([campaign()]))
      const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
      expect(outcome.kind).toBe('failed')
    }
  })

  it('`status` 存在但不是 CLAIMED ⇒ failed（不把未知状态当成功）', async () => {
    const { fetcher } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ status: 'PENDING', benefit: { amount: 100 } }), { status: 200 })
      : campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.message).toContain('PENDING')
  })

  it('空 PAT 在**本地**就判终态，一次网都不出', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([campaign()]))
    const outcome = await claimQoderDailyCheckin(
      { ...CREDENTIAL, access_token: '' }, fakeAuth(), { fetcher, product: QODER_CN },
    )

    expect(outcome.kind).toBe('failed')
    expect(calls).toHaveLength(0)
  })

  it('401 带 `TOKEN_EXPIRE` ⇒ 丢弃 jt 缓存后**重试一次**并成功', async () => {
    const auth = fakeAuth({ tokens: ['jt-stale', 'jt-fresh'] })
    let attempts = 0
    const { fetcher, calls } = withFetcher(() => {
      attempts += 1
      // 第一次 401 TOKEN_EXPIRE，重换 jt 后成功。
      if (attempts === 1) return new Response('{"code":"TOKEN_EXPIRE"}', { status: 401 })
      return campaignsBody([campaign()])
    })

    const status = await fetchQoderCheckinStatus(CREDENTIAL, auth, { fetcher, product: QODER_CN })
    expect(status).not.toBeNull()
    expect(auth.invalidated).toEqual(['pt-cn-token'])
    expect(auth.calls).toBe(2)
    // 重试用的是重换后的那个 jt（不是拿旧的重打一遍）。
    expect(calls[0]!.authorization).toBe('Bearer jt-stale')
    expect(calls[1]!.authorization).toBe('Bearer jt-fresh')
  })

  it('401 但**不是** TOKEN_EXPIRE（PAT 类型错）⇒ 不重换、不重试', async () => {
    const auth = fakeAuth()
    const { fetcher, calls } = withFetcher(() => new Response('{"error":"TOKEN_INVALID"}', { status: 401 }))

    expect(await fetchQoderCheckinStatus(CREDENTIAL, auth, { fetcher, product: QODER_CN })).toBeNull()
    expect(auth.invalidated).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('PAT 已失效（RefreshTokenExpiredError）⇒ failed 且提示重新粘贴', async () => {
    const failure = Object.assign(new Error('expired'), { name: 'RefreshTokenExpiredError' })
    const { fetcher, calls } = withFetcher(() => campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth({ failWith: failure }), {
      fetcher, product: QODER_CN,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.message).toContain('重新粘贴')
    expect(calls).toHaveLength(0)
  })

  it('协议按传入的 product 现算 host（同一份代码服务两个 region）', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([]))
    await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER })
    expect(calls[0]!.url).toBe(`${QODER.openapiBase}${QODER_CAMPAIGNS_PATH}`)
    expect(calls[0]!.url).not.toContain('.com.cn')
  })
})
