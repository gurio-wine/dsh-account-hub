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
 * ## 本文件钉死的六条硬约束（每条都对应真机事实，见模块头注释）
 *
 * 1. **幂等判据是响应体的 `replayed`，不是 HTTP 状态码** —— 重复领取同样回 200；
 * 2. **请求体必须是空串**（抓包实测 `content-length: 0`）；
 * 3. **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`**
 *    （`VIEW_DETAILS` 型活动不可发 claim）；
 * 4. **活动端点必须带 `Cosy-ClientType: 10`**（2026-09-24 真机定案）：缺头时服务端
 *    恒回**空列表假象**（`campaigns: []` 是缺头的产物，不是服务端事实）。
 *    作用域**只限 `/sash/` 活动请求** —— quota / chat 继续用不带 Cosy 头的
 *    `qoderJobTokenHeaders`（未验证过加头的影响，属出站协议值红线）；
 * 5. **三态判读**：`CLAIM_BENEFIT + CLAIMED` ⇒ **已领**（今天已签）、有
 *    `CLAIMABLE` ⇒ 未签（走领取）、空或仅 `VIEW_DETAILS` ⇒ **判不了**
 *    （`undetermined`，**不写签到状态**，下轮 sweep 重试）。`CheckinStatus.active`
 *    恒为 true；`todayCheckedIn` 只在服务端明说 `CLAIMED` 时为 true；
 * 6. **claim 与 status 共用同一个判读函数**（`readQoderCampaignDayState`）——
 *    两处各写一份必然漂移，而漂移的后果是「签到成功后被判 undetermined，
 *    宿主不写状态 ⇒ sweep 永久重试」（真机确认的缺陷形态）。
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
  fetchQoderQuotaUsage,
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
  /** 全部请求头（小写键）—— 用来钉「活动请求带 Cosy-ClientType、quota 请求不带」。 */
  headers: Record<string, string>
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
    const raw = new Headers(init?.headers)
    const headers: Record<string, string> = {}
    raw.forEach((value, key) => { headers[key.toLowerCase()] = value })
    const call: Call = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
      headers,
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

// ── 活动端点的请求头（2026-09-24 真机定案） ──────────────────────────────────

describe('活动端点必须带 `Cosy-ClientType: 10`（缺头 ⇒ 空列表假象）', () => {
  it('GET 活动列表带 `Cosy-ClientType: 10`（两区同值）', async () => {
    // 真机 A/B：插件现状头 ⇒ `campaigns: []`；**仅加**这一个头 ⇒ 列表非空
    //（含 `CLAIM_BENEFIT`）。取值空间扫描证明只有 8 与 10 有效，10 是官方值
    //（官方桌面端 `yc = {clientType: 10, businessProduct:"app"}`）。
    for (const product of [QODER, QODER_CN]) {
      const { fetcher, calls } = withFetcher(() => campaignsBody([campaign()]))
      await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product })
      expect(calls[0]!.headers['cosy-clienttype'], product.id).toBe('10')
    }
  })

  it('POST claim 同样带 `Cosy-ClientType: 10`', async () => {
    const { fetcher, calls } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
      : campaignsBody([campaign()]))

    await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.headers['cosy-clienttype']).toBe('10')
  })

  it('⚠️ 作用域只限 `/sash/` 活动请求：quota 请求**不带**该头', async () => {
    // 出站协议值红线：`qoderJobTokenHeaders` 被 quota / chat / userinfo 共用，
    // 加头对它们的影响**未经验证**，故绝不能污染。本用例是那条边界的唯一守卫：
    // 一旦有人图省事把 `Cosy-ClientType` 塞进 `qoderJobTokenHeaders`，这里立刻红。
    const { fetcher, calls } = withFetcher(() => new Response(JSON.stringify({
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
    }), { status: 200 }))

    await fetchQoderQuotaUsage(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/api/v2/quota/usage')
    expect(Object.keys(calls[0]!.headers).some((key) => key.startsWith('cosy-'))).toBe(false)
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

  it('**带头仍为空** ⇒ active:true，但 todayCheckedIn 报 **false（不猜）**', async () => {
    // ⚠️ 三条判据各管一件事，别把它们混起来：
    //
    // 1. `active` 恒为 true —— 若按列表是否为空判，调用方（`collectClaimResults`
    //    的预检）会先命中「活动未开启」分支，把情况误报成「签到活动未开启」。
    // 2. `todayCheckedIn` 为 **false** —— 空列表有两种相反含义（今天已领 /
    //    暂无活动），响应上无法区分。旧实现报 `true`（「保守判已领」）在第二种
    //    情形下**伪造了一次签到**：宿主据此写下状态、整个周期不再重试，而该账号
    //    可能一分没领。现在不猜：界面显示未签，真伪由 claim 的 `undetermined`
    //    与下一轮 sweep 收敛（详见 `src/qoder-credits.ts` 的说明）。
    // 3. ⚠️ **「带头仍空」是这里的限定语**（2026-09-24 真机定案）：缺
    //    `Cosy-ClientType: 10` 时空列表是**缺头假象**，那种情况已经由请求头修掉；
    //    现在能走到空列表，说明头齐了、服务端真的没给条目 —— 才是真「判不了」。
    const { fetcher } = withFetcher(() => campaignsBody([], { showCampaign: false, claimable: false }))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(status).toMatchObject({ active: true, todayCheckedIn: false })
  })

  it('`CLAIM_BENEFIT + CLAIMED` ⇒ todayCheckedIn **true**（服务端明说今天已领）', async () => {
    // 缺陷 3：旧实现 `todayCheckedIn` **恒为 false**（注释自己写着），于是签到
    // 成功后界面仍显示未签。真机 47 条官方响应里 `CLAIM_BENEFIT/CLAIMED` 出现
    // 27 次、横跨 5 个账号 —— 这是协议里**唯一明确的「已领」证据**。
    const { fetcher } = withFetcher(() => campaignsBody(
      [campaign({ claimStatus: 'CLAIMED' })], { showCampaign: true, claimable: false },
    ))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(status).toMatchObject({ active: true, todayCheckedIn: true })
    // 已领时 `dailyCredit` 仍取该活动的声明额度（UI 要显示「每日 100」）。
    expect(status?.dailyCredit).toBe(100)
  })

  it('`CLAIMED` 与 `CLAIMABLE` 同时存在 ⇒ 按**未签**处理（还有可领的就必须去领）', async () => {
    // 多活动账号：一个已领、一个可领 ⇒ 今天显然还没领完，必须走领取。
    const { fetcher } = withFetcher(() => campaignsBody([
      campaign({ campaignId: 'done', claimStatus: 'CLAIMED' }),
      campaign({ campaignId: 'todo', claimStatus: 'CLAIMABLE' }),
    ]))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(status).toMatchObject({ todayCheckedIn: false, dailyCredit: 100 })
  })

  it('只有 `VIEW_DETAILS`（无论 CLAIMED 与否）⇒ 判不了，`todayCheckedIn` false', async () => {
    for (const claimStatus of ['CLAIMED', 'CLAIMABLE']) {
      const { fetcher } = withFetcher(() => campaignsBody([
        campaign({ actionType: 'VIEW_DETAILS', claimStatus }),
      ]))
      const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
      expect(status, claimStatus).toMatchObject({ todayCheckedIn: false })
    }
  })

  it('无任何 CLAIM_BENEFIT 活动时 dailyCredit 为 0（不编造额度）', async () => {
    const { fetcher } = withFetcher(() => campaignsBody([campaign({ actionType: 'VIEW_DETAILS' })]))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    // 没有可领项 ⇒ 判不了（不再是「已签」）；额度仍如实回 0 而不是编一个数字。
    expect(status).toMatchObject({ todayCheckedIn: false, dailyCredit: 0 })
  })

  it('有可领项时才可能未签，且 dailyCredit 用活动声明的额度', async () => {
    const { fetcher } = withFetcher(() => campaignsBody([campaign({ benefit: { amount: 100 } })]))
    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })
    expect(status).toMatchObject({ todayCheckedIn: false, dailyCredit: 100 })
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

  it('**带头仍为空** ⇒ **undetermined**（不是 already-claimed），且**一次 claim 都不发**', async () => {
    // ⚠️ 2026-09-24 修正的核心：空列表既可能是「今天已领」（服务端清空了列表），
    // 也可能是「活动还没开始 / 本账号暂无活动」。旧实现一律归一 `already-claimed`
    // => 宿主写下签到状态 => 该账号整个周期不再被尝试，而它可能一分没领
    //（真机调查确认的「qoder 假签到」）。
    // 现在报 `undetermined`：**不写状态**，下一轮 sweep 自然重试去把不确定变成确定。
    //
    // ⚠️ 限定语「**带头仍空**」：缺 `Cosy-ClientType: 10` 时也会看到空列表，那是
    // 缺头假象（已由请求头修掉）。走到这里的空列表说明头齐了、服务端真没给条目。
    const { fetcher, calls } = withFetcher(() => campaignsBody([], { showCampaign: false, claimable: false }))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome.kind).toBe('undetermined')
    expect((outcome as { message: string }).message).toContain('无法判定')
    // 没有任何写入型请求（否则就不叫「无法判定」了）。
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('`CLAIM_BENEFIT + CLAIMED` ⇒ **already-claimed**（今天已领），且一次 claim 都不发', async () => {
    // ⚠️ 缺陷 2 的正面用例：签到成功后活动变 `CLAIMED`，旧实现把它压进空目标分支
    // ⇒ `undetermined` ⇒ 宿主白名单（只认 claimed / already-claimed）不写状态
    // ⇒ sweep 永久重试 ⇒ 用户永远看到「无法判定」，尽管积分已到账。
    // 真机复现：`qoder-minimal-fix-e2e.mjs` 两区都报 MISJUDGED。
    const { fetcher, calls } = withFetcher(() => campaignsBody(
      [campaign({ claimStatus: 'CLAIMED' })], { showCampaign: true, claimable: false },
    ))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome).toMatchObject({ kind: 'already-claimed' })
    expect(outcome.kind === 'already-claimed' && outcome.message).toContain('已领')
    // 已领 ⇒ 不发 claim（否则服务端回 `replayed:true`，白打一发）。
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('`CLAIMED` 与 `CLAIMABLE` 同时存在 ⇒ 仍去领 `CLAIMABLE` 那条（不能因为有一条已领就跳过）', async () => {
    const { fetcher, calls } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 50 } }), { status: 200 })
      : campaignsBody([
          campaign({ campaignId: 'done', claimStatus: 'CLAIMED' }),
          campaign({ campaignId: 'todo', benefit: { amount: 50 } }),
        ]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome).toMatchObject({ kind: 'claimed', credit: 50 })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toContain('/todo/claim')
  })

  it('`VIEW_DETAILS` 型活动不被领取（零 POST），且归 undetermined 而不是已领', async () => {
    const { fetcher, calls } = withFetcher(() => campaignsBody([campaign({ actionType: 'VIEW_DETAILS' })]))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    // 无可领的 CLAIM_BENEFIT 项 ⇒ 与空列表同一处境（判不了），不能报「已领」。
    expect(outcome.kind).toBe('undetermined')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('`VIEW_DETAILS + CLAIMED` **不**算今天已领（只有 `CLAIM_BENEFIT` 才是积分活动）', async () => {
    // 判读必须同时看 actionType：官方 47 条里 `VIEW_DETAILS` 型（如「Pro 首月
    // 翻倍」）的 `CLAIMED` 与积分签到无关，据此写「已签」会伪造一次签到。
    const { fetcher, calls } = withFetcher(() => campaignsBody([
      campaign({ actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }),
    ]))
    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), { fetcher, product: QODER_CN })

    expect(outcome.kind).toBe('undetermined')
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

  it('`status` **缺失** ⇒ 仍按成功，但留下「未经确认」的调试行（不静默替服务端宣布成功）', async () => {
    // 2026-09-24 补齐的缺口：旧实现把「响应里没有 status」与「status === 'CLAIMED'」
    // 走同一条成功路径，等于**替服务端宣布成功** —— 响应形态一变更（网关改字段名、
    // 错误信封、中间层吞 body）就会把一次未生效的领取报成 claimed。
    //
    // 现在的处置是**如实记录而非改判**：没有证据说它失败，故 kind 仍是 claimed；
    // 但 `credit` 的来源必须是服务端下发的**声明值**（`benefit.amount`），且这一点
    // 要留在调试行里，便于真机核对「这个数字到底是谁说的」。
    const debug: string[] = []
    const { fetcher } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ benefit: { amount: 100 } }), { status: 200 })
      : campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER_CN, onDebug: (message) => debug.push(message),
    })

    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    const joined = debug.join('\n')
    expect(joined).toContain('没有 status 字段')
    // 说清那个数字是「声明值」而非服务端确认值。
    expect(joined).toContain('声明值')
  })

  it('`status` 缺失且**没有 benefit.amount** ⇒ credit 为 0（不编数字），调试行照旧', async () => {
    const debug: string[] = []
    const { fetcher } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({}), { status: 200 })
      : campaignsBody([campaign()]))

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER_CN, onDebug: (message) => debug.push(message),
    })

    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
    expect(debug.join('\n')).toContain('没有 status 字段')
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
