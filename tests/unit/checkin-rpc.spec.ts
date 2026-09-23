/**
 * 自动签到 RPC 三个新 case 的分派回归测试。
 *
 * ## 为什么单独一个文件
 *
 * `credits.checkinStatus` / `checkin.perform` / `checkin.sweep` 三个端点的价值
 * 全在「宿主分派 + 写 checkins 状态」上：`credits.checkinStatus` 是**纯内存读**
 * （不发任何网络请求）；`checkin.perform` 复用 `credits.claimAll` 的同一份分派
 * 逻辑、且成功/已领写今日、失败不写；`checkin.sweep` 遍历
 * {@link CHECKIN_ELIGIBLE_PROVIDERS}、只签今日未签、且模块级互斥防并发。
 *
 * 与 `account-hub-rpc.spec.ts` 略同处：直接驱动 **registerAccountHubRpc 注册出来的
 * 真实 HTTP 处理器**，账号池用**真实 AccountPool**（内存 settings 替身），只把
 * 出网换成替身 —— 这样「写没写 checkins / 发了几个请求」这些真实副作用才是断言
 * 对象，而不是替身自己的行为。
 *
 * 领取代理由 **Buddy-cn** 走（`productById` → Buddy 产品，预检 + 领取两步）：
 * 它是最短的可判定 claim 流程，用替身 fetch 即可稳定产出 claimed / already-claimed /
 * failed 三种 outcome，而不必搭建 codearts/lobsterai/trae/qoder 各自的协议桩。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { registerAccountHubRpc, CHECKIN_ELIGIBLE_PROVIDERS, __resetSweepRunning } from '../../src/account-hub-rpc.js'
import { AccountPool, todayDayNumber } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** RPC 响应的判别联合（`reply()` 会给 error 补一个 `details`）。 */
type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

type Handler = (request: Request) => Promise<Response>

/** 最小凭据提供者（`ctx.credentials` 形状）。 */
class FakeCredentials {
  async resolve() {
    return { value: JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
    }) }
  }
  async describe() {
    return { configured: true, writable: true }
  }
  async set() {}
  async unset() {}
}

/** 账号条目构造器；默认是启用的合法 buddy-cn 账号。 */
function makeEntry(id: string, overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id,
    provider: 'buddy-cn',
    nickname: id,
    enabled: true,
    credentialRef: `BUDDY_CN_ACCOUNT_${id.toUpperCase().replace(/-/g, '_')}`,
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 记录出网请求、按端点返回可控响应的 fetch 替身。 */
class ScriptedFetcher {
  readonly calls: string[] = []
  /** `/daily-checkin` 返回的业务码；0=成功、10001=已领、999=失败。 */
  claimCode = 0
  /**
   * Trae CN 的 `checkin_credits/claim` 返回的业务码（本次新增）。
   *
   * 需要它是因为 `unavailable` 这个 kind 目前**只有 Trae CN 的 `9074` 会产出**，
   * 而 Buddy 那条最短路径造不出它 —— 用 Buddy 测「unavailable 不写状态」等于
   * 测一条永远走不到的分支。
   */
  traeClaimCode = 0

  readonly fetch: typeof fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    this.calls.push(url)
    if (url.includes('/checkin-activity-status')) {
      // 预检：活动开启、今日未签 → 允许走到领取。
      return new Response(JSON.stringify({
        code: 0,
        data: { active: true, today_checked_in: false, streak_days: 0, daily_credit: 100 },
      }), { status: 200 })
    }
    if (url.includes('/checkin_credits/status')) {
      // Trae CN 的预检：账号级未签 ⇒ 会走到 claim。
      return new Response(JSON.stringify({
        code: 0, data: { checked_in: false, enable: true },
      }), { status: 200 })
    }
    if (url.includes('/checkin_credits/claim')) {
      if (this.traeClaimCode !== 0) {
        return new Response(JSON.stringify({
          code: this.traeClaimCode,
          message: this.traeClaimCode === 9074 ? '当前参与用户太多，请稍后再试' : undefined,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, message: 'success' }), { status: 200 })
    }
    if (url.includes('/daily-checkin')) {
      if (this.claimCode === 10001) {
        return new Response(JSON.stringify({ code: 10001, msg: '今天已签到' }), { status: 200 })
      }
      if (this.claimCode !== 0) {
        return new Response(JSON.stringify({ code: this.claimCode, msg: 'boom' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { credit: 100, streak_days: 1, is_streak_day: false },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: -1 }), { status: 200 })
  }) as unknown as typeof fetch
}

interface Harness {
  /** 调用一个端点方法，返回解包后的 result。 */
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  pool: AccountPool
  fetcher: ScriptedFetcher
}

/** 注册真实端点并返回调用器。账号由测试自行 `pool.addAccount` 预置。 */
function createHarness(seed: ProviderAccountEntry[]): Harness {
  let stored: Record<string, unknown> = { accounts: seed }
  const credentials = new FakeCredentials()
  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials,
  } as never)

  const fetcher = new ScriptedFetcher()
  vi.stubGlobal('fetch', fetcher.fetch)

  let handler: Handler | undefined
  const ctx = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      : undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials,
  }
  registerAccountHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never)
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async <T>(method: string, payload: unknown): Promise<RpcResult<T>> => {
    const response = await handler!(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'account-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: RpcResult<T> }
    return body.result
  }

  return { call, pool, fetcher }
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetSweepRunning()
})

// ── CHECKIN_ELIGIBLE_PROVIDERS ──────────────────────────────────────────────

describe('CHECKIN_ELIGIBLE_PROVIDERS（宿主侧可签到集）', () => {
  it('恰好是六条，且含 qoder 两区', () => {
    expect([...CHECKIN_ELIGIBLE_PROVIDERS].sort()).toEqual(
      ['buddy-cn', 'codearts', 'lobsterai', 'qoder', 'qoder-cn', 'trae-cn'].sort(),
    )
    expect(CHECKIN_ELIGIBLE_PROVIDERS.size).toBe(6)
  })
})

// ── credits.checkinStatus：纯内存读 ─────────────────────────────────────────

describe('credits.checkinStatus 端点', () => {
  it('读内存池状态、不发任何网络请求', async () => {
    const today = todayDayNumber()
    // 预置：acc-1 已签、acc-2 未签、acc-3 已签 → 直接写 checkinCache（不落盘也无关）。
    const h = createHarness([makeEntry('acc-1'), makeEntry('acc-2'), makeEntry('acc-3')])
    await h.pool.writeCheckinDay('buddy-cn', 'acc-1', today)
    await h.pool.writeCheckinDay('buddy-cn', 'acc-3', today)

    const beforeCalls = h.fetcher.calls.length
    const result = await h.call<{ provider: string; today: number; checkedIn: Record<string, boolean> }>(
      'credits.checkinStatus', { provider: 'buddy-cn' },
    )

    expect(result.ok).toBe(true)
    const v = (result as { value: { provider: string; today: number; checkedIn: Record<string, boolean> } }).value
    expect(v.provider).toBe('buddy-cn')
    expect(v.today).toBe(today)
    // acc-2 未签 → false；其余 → true。无账号之外不给任何未知键。
    expect(v.checkedIn).toEqual({ 'acc-1': true, 'acc-2': false, 'acc-3': true })
    // ⚠️ 关键：**零网络**。checkinStatus 只读进程内 checkins。
    expect(h.fetcher.calls.length).toBe(beforeCalls)
  })

  it('无账号时返回空 checkedIn，不报错', async () => {
    const h = createHarness([])
    const result = await h.call<{ checkedIn: Record<string, boolean> }>(
      'credits.checkinStatus', { provider: 'buddy-cn' },
    )
    expect(result.ok).toBe(true)
    expect((result as { value: { checkedIn: Record<string, boolean> } }).value.checkedIn).toEqual({})
    expect(h.fetcher.calls).toHaveLength(0)
  })
})

// ── checkin.perform：单账号 ─────────────────────────────────────────────────

describe('checkin.perform 端点（单账号）', () => {
  it('单一账号领取成功 → 写今日', async () => {
    const h = createHarness([makeEntry('acc-1'), makeEntry('acc-2')])
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const results = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results
    // 只处理 acc-1（另一个不动）。
    expect(results).toHaveLength(1)
    // perform 响应与 claimAll 同构：带 nickname + 完整 outcome 对象（断言 .kind）。
    expect(results[0]).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'claimed' } })
    // acc-1 已写今日；acc-2 未被触碰。
    const today = todayDayNumber()
    expect(h.pool.checkinDay('buddy-cn', 'acc-1')).toBe(today)
    expect(h.pool.checkinDay('buddy-cn', 'acc-2')).toBeUndefined()
    // acc-1 一次：预检 + 领取 = 2 次请求。
    expect(h.fetcher.calls).toHaveLength(2)
  })

  it('already-claimed 也写今日（幂等由服务端已领态兜住）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 10001

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const r0 = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results[0]
    expect(r0).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'already-claimed' } })
    // 已领也写今日 → 后续 sweep 不再重复请求。
    expect(h.pool.checkinDay('buddy-cn', 'acc-1')).toBe(todayDayNumber())
  })

  it('failed 不写今日（下次 sweep 重试）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 999

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const r0 = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results[0]
    expect(r0).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'failed' } })
    // 失败不写 → checkins 里没有该键。
    expect(h.pool.checkinDay('buddy-cn', 'acc-1')).toBeUndefined()
  })

  it('未知 provider 回可读 bad-request', async () => {
    const h = createHarness([])
    const result = await h.call('checkin.perform', { provider: 'not-a-provider', accountId: 'x' })
    expect(result.ok).toBe(false)
    expect((result as { error: { message: string } }).error.message).toBe('unsupported provider: not-a-provider')
  })
})

// ── unavailable（2026-09-23 新增的第五个 outcome kind）──────────────────────
//
// 这一档目前**只有 Trae CN 的 `9074` 会产出**（服务端名额/风控类拒绝），故用例
// 走真实的 trae-cn 分派链路（`registerAccountHubRpc` 的 `runCreditsClaim` 分支），
// 而不是给 Buddy 打桩 —— 后者造不出这个 kind，测的会是一条永远走不到的分支。
//
// 本组守的是**状态写入**这一条最容易写错的规则：`unavailable` 必须与
// `failed` / `inactive` 同待遇（**不写** checkins）。一旦写入，4h sweep 的
// 「今日未签」筛选当天就会短路跳过该账号 —— 一次**瞬时**拒绝被固化成
// **当天永久**失败。

describe('unavailable 不写今日签到状态（否则当天再也不会重试）', () => {
  /** 一个 trae-cn 账号（凭据由 FakeCredentials 统一伪造，字段够用即可）。 */
  const traeEntry = (id: string): ProviderAccountEntry => makeEntry(id, {
    provider: 'trae-cn',
    credentialRef: `TRAE_CN_ACCOUNT_${id.toUpperCase()}`,
  })

  it('9074 → outcome.kind 为 unavailable，且 checkins 里**没有**该账号', async () => {
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9074

    const result = await h.call<any>('checkin.perform', { provider: 'trae-cn', accountId: 't1' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    const value = (result as { value: { results: Array<{ outcome: { kind: string; code: number; message: string } }> } }).value
    expect(value.results[0]!.outcome).toMatchObject({ kind: 'unavailable', code: 9074 })
    // ✅ 核心断言：**不写**今日 —— 这是「下次 sweep 会重试」的唯一保障。
    expect(h.pool.checkinDay('trae-cn', 't1')).toBeUndefined()
  })

  it('9074 → summary 计入独立的 unavailable 栏，**不**并入 failed', async () => {
    // 两者对用户的含义相反：failed 要用户行动，unavailable 什么都不用做。
    // 并进 failed 会让界面报出「1 个失败」，用户照着一个不需要行动的数字去排查。
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9074

    const result = await h.call<any>('checkin.perform', { provider: 'trae-cn', accountId: 't1' })

    const summary = (result as { value: { summary: Record<string, number> } }).value.summary
    expect(summary.unavailable).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.claimed).toBe(0)
  })

  it('unavailable 的账号在下一次 sweep 里**仍然会被尝试**（不写状态的实际价值）', async () => {
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9074
    // 第一趟：被服务端拒绝 → unavailable、不写状态。
    await h.call<any>('checkin.sweep', {})
    const callsAfterFirst = h.fetcher.calls.filter((u) => u.includes('/checkin_credits/claim')).length
    // ⚠️ **两次**（2026-09-23 第五次定性后）：首发 9074 → 换设备号重试一次 →
    // 仍是 9074 ⇒ unavailable。这里断言的是**第一趟确实试过**，次数由
    // `trae-cn-credits.spec.ts` 的重试用例精确钉死。
    expect(callsAfterFirst).toBe(2)
    expect(h.pool.checkinDay('trae-cn', 't1')).toBeUndefined()

    // 第二趟：服务端恢复 → 真的领到了。若第一趟写了今日，这一趟会被
    // 「今日未签」筛选短路掉，claim 一次都不会发 —— 那正是本组要防的缺陷。
    h.fetcher.traeClaimCode = 0
    await h.call<any>('checkin.sweep', {})
    const claims = h.fetcher.calls.filter((u) => u.includes('/checkin_credits/claim'))
    // 第一趟 2 次（首发 + 换号重试）+ 第二趟 1 次（首发即成功）。
    expect(claims).toHaveLength(3)
    expect(h.pool.checkinDay('trae-cn', 't1')).toBe(todayDayNumber())
  })

  it('9095（设备今日已签）→ 归一 already-claimed，**写**今日（这份已经到手）', async () => {
    // 与 unavailable 正好相反的一档：奖励今天确实已经领过，故按已签处理、
    // 写今日，后续 sweep 不再为它发请求。
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9095

    const result = await h.call<any>('checkin.perform', { provider: 'trae-cn', accountId: 't1' })

    const value = (result as { value: { results: Array<{ outcome: { kind: string } }>; summary: Record<string, number> } }).value
    expect(value.results[0]!.outcome.kind).toBe('already-claimed')
    expect(h.pool.checkinDay('trae-cn', 't1')).toBe(todayDayNumber())
    expect(value.summary.alreadyClaimed).toBe(1)
    expect(value.summary.unavailable).toBe(0)
  })
})

// ── checkin.perform：provider 全量退化 ──────────────────────────────────────

describe('checkin.perform 端点（accountId 缺省 → 全量）', () => {
  it('对每个账号按结果写状态', async () => {
    const h = createHarness([makeEntry('a'), makeEntry('b'), makeEntry('c')])
    // 预置：a 已签（不重签）、b/c 未签。
    const today = todayDayNumber()
    await h.pool.writeCheckinDay('buddy-cn', 'a', today)
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn' })

    expect(result.ok).toBe(true)
    const results = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results
    // 缺省 accountId → 全量账号都过一遍（含已签的 a —— perform 是全量尝试，不停用短路）。
    expect(results.map((r) => r.accountId)).toEqual(['a', 'b', 'c'])
    expect(results.every((r) => r.outcome.kind === 'claimed')).toBe(true)
    // 每个结果都带 nickname。
    expect(results.every((r) => r.nickname === r.accountId)).toBe(true)
    // 三个账号都被写今日。
    expect(h.pool.checkinDay('buddy-cn', 'a')).toBe(today)
    expect(h.pool.checkinDay('buddy-cn', 'b')).toBe(today)
    expect(h.pool.checkinDay('buddy-cn', 'c')).toBe(today)
    // 每个账号 预检+领取 = 2 请求 => 6。
    expect(h.fetcher.calls).toHaveLength(6)
  })
})

// ── checkin.sweep ──────────────────────────────────────────────────────────

describe('checkin.sweep 端点', () => {
  it('只签「今日未签」的账号（已签的跳过）', async () => {
    const h = createHarness([makeEntry('signed'), makeEntry('due-1'), makeEntry('due-2')])
    const today = todayDayNumber()
    await h.pool.writeCheckinDay('buddy-cn', 'signed', today)
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.sweep', {})

    expect(result.ok).toBe(true)
    const v = (result as {
      value: { running: boolean; providers: Array<{ provider: string; results: Array<{ accountId: string; outcome: string }> }> }
    }).value
    expect(v.running).toBe(true)
    // 只有 buddy-cn 有账号 → 只出现这一个 provider。
    expect(v.providers.map((p) => p.provider)).toEqual(['buddy-cn'])
    const buddy = v.providers[0]!
    // 只签 due-1 / due-2（signed 已签跳过）。
    expect(buddy.results.map((r) => r.accountId)).toEqual(['due-1', 'due-2'])
    // 两个未签账号都被写今日。
    expect(h.pool.checkinDay('buddy-cn', 'due-1')).toBe(today)
    expect(h.pool.checkinDay('buddy-cn', 'due-2')).toBe(today)
    // 只发 4 次（2 账号 × 预检+领取）；signed 没有任何请求。
    expect(h.fetcher.calls).toHaveLength(4)
  })

  it('遍历全部六 provider，无账号的跳过', async () => {
    // 只给 buddy-cn / qoder 各一个账号，其余四 provider 无账号 → 跳过不发请求。
    const h = createHarness([
      makeEntry('b1'),
      makeEntry('q1', { provider: 'qoder', credentialRef: 'QODER_ACCOUNT_Q1' }),
    ])
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.sweep', {})

    expect(result.ok).toBe(true)
    const providers = (result as { value: { providers: Array<{ provider: string }> } }).value.providers
    const names = providers.map((p) => p.provider)
    // 只有有账号的两个 provider 被真正执行。
    expect(names).toContain('buddy-cn')
    expect(names).toContain('qoder')
    expect(names).toHaveLength(2)
    // 全部六条都在遍历集合里（无账号的也被枚举、但跳过）。
    expect(CHECKIN_ELIGIBLE_PROVIDERS.size).toBe(6)
  })

  it('互斥：并发重入时不并发，返回 running=false', async () => {
    const h = createHarness([makeEntry('x')])
    h.fetcher.claimCode = 0
    // 同时发起两趟 sweep。第一趟进入后立即置 sweepRunning=true，
    // 第二趟（同 tick 内）看到忙就直接返回 running=false，不排队不重入。
    const [first, second] = await Promise.all([
      h.call<any>('checkin.sweep', {}),
      h.call<any>('checkin.sweep', {}),
    ])
    const v1 = (first as { value: { running: boolean } }).value
    const v2 = (second as { value: { running: boolean } }).value
    // 恰有一趟真正执行（另一趟被互斥挡回）。
    expect([v1.running, v2.running].filter(Boolean)).toHaveLength(1)
    // 只签一次：x 只有预检+领取 2 次请求。
    expect(h.fetcher.calls).toHaveLength(2)
  })

  it('互斥在 sweep 结束后复位，后续可再次执行', async () => {
    const h = createHarness([makeEntry('x')])
    h.fetcher.claimCode = 0
    const r1 = await h.call<any>('checkin.sweep', {})
    expect((r1 as { value: { running: boolean } }).value.running).toBe(true)
    // 第二趟（串行）应能再次真跑。
    const r2 = await h.call<any>('checkin.sweep', {})
    expect((r2 as { value: { running: boolean } }).value.running).toBe(true)
  })
})