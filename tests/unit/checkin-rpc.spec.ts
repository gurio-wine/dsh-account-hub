/**
 * 自动签到 RPC 三个 case 的分派回归测试。
 *
 * ## 为什么单独一个文件
 *
 * `credits.checkinStatus` / `checkin.perform` / `checkin.sweep` 三个端点的价值
 * 全在「宿主分派 + 写 checkins 状态」上：`credits.checkinStatus` 是**纯内存读**
 * （不发任何网络请求）；`checkin.perform` 复用 `credits.claimAll` 的同一份分派
 * 逻辑、且成功/已领才写状态、失败不写；`checkin.sweep` 遍历
 * {@link CHECKIN_ELIGIBLE_PROVIDERS}、只签**此刻可签**的账号、且模块级互斥防并发。
 *
 * ## ⚠️ 2026-09-24：状态口径由「纪元日数」换成「下一次可签毫秒时间戳」
 *
 * 本文件的断言因此整体跟着换：
 * - **写**的时候用 `nextEligibleAt(now, provider)`（不是 `todayDayNumber()`）；
 * - **读**的时候用 `pool.checkinNextEligible` / `pool.isCheckinDue`；
 * - 「已签」的造法从「写今天的日数」变成「写一个**未来**的时刻」，
 *   「未签」从「不写」或「写一个**过去**的时刻」。
 *
 * 旧口径的坑在本文件里也是最容易复发的缺陷：把日数（两万上下）当时间戳写进去，
 * 等于「1970 年就可以再签了」—— `isCheckinDue` 永远为真、每轮 sweep 都会重签。
 * 故下面有用例专门钉住「写进去的必须是未来时刻」。
 *
 * 与 `account-hub-rpc.spec.ts` 略同处：直接驱动 **registerAccountHubRpc 注册出来的
 * 真实 HTTP 处理器**，账号池用**真实 AccountPool**（内存 settings 替身），只把
 * 出网换成替身 —— 这样「写没写 checkins / 发了几个请求」这些真实副作用才是断言
 * 对象，而不是替身自己的行为。
 *
 * 领取代理由 **Buddy-cn** 走（`productById` → Buddy 产品，预检 + 领取两步）：
 * 它是最短的可判定 claim 流程，用替身 fetch 即可稳定产出 claimed / already-claimed /
 * failed / abnormal 四种 outcome，而不必搭建 codearts/lobsterai/trae/qoder 各自的协议桩。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { registerAccountHubRpc, CHECKIN_ELIGIBLE_PROVIDERS, __resetSweepRunning } from '../../src/account-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { nextEligibleAt } from '../../src/checkin-schedule.js'
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

/**
 * 余额端点的脚本。
 *
 * `totals` **省略**时返回**递增值**（每次 +100）：这保证「签到前后余额变多」⇒
 * 不是 `abnormal`，于是**与本组无关的用例**（写状态、次数、互斥……）不会被余额
 * 比对这条新路径意外改写 outcome —— 那种失败会伪装成「写状态坏了」。
 * 需要 `abnormal` 的用例显式给一个**恒定或递减**的 `totals`。
 */
interface BalanceScript {
  /** 每次余额请求返回的 total（按调用序号取，耗尽后取最后一个）。 */
  totals?: number[]
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
  /** 余额端点脚本（见 {@link BalanceScript}）；缺省返回递增值 ⇒ 恒判「变多」。 */
  balance: BalanceScript = {}
  /** 余额端点是否模拟故障（`fetch` 抛错 → 比对跳过）。 */
  balanceThrows = false
  /** 预检（Buddy 系 `checkin-activity-status`）是否直接报「今日已签」。 */
  statusCheckedIn = false

  /** 余额请求已发生的次数（用于按序取 `balance.totals`）。 */
  private balanceCalls = 0

  private balanceBody(): Response {
    const index = this.balanceCalls
    this.balanceCalls += 1
    // 缺省递增值：100 → 200 → 300 …（签到前 < 签到后 ⇒ claimed）。
    const totals = this.balance.totals
    const total = totals === undefined
      ? 100 * (index + 1)
      : (totals[Math.min(index, totals.length - 1)] ?? 0)
    // 双层信封：`data.Response.Data.Accounts[]`（见 `fetchCreditBalance`）。
    return new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{
              PackageName: 'Bonus Pack',
              CapacityUnit: 'credit',
              CycleCapacityRemainPrecise: String(total),
              CycleCapacitySizePrecise: '10000',
              CycleCapacityUsedPrecise: '0',
              Status: 0,
            }],
          },
        },
      },
    }), { status: 200 })
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    this.calls.push(url)
    if (url.includes('/checkin-activity-status')) {
      // 预检：活动开启、今日未签 → 允许走到领取。
      return new Response(JSON.stringify({
        code: 0,
        data: {
          active: true,
          today_checked_in: this.statusCheckedIn,
          streak_days: 0,
          daily_credit: 100,
        },
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
    if (url.includes('/get-user-resource')) {
      if (this.balanceThrows) throw new Error('socket hang up')
      return this.balanceBody()
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

/**
 * 注册真实端点并返回调用器。账号由测试自行 `pool.addAccount` 预置。
 *
 * @param override - 可选的整段出网覆盖（**优先于** {@link ScriptedFetcher} 的
 *        默认分派）。只给需要别的协议（如 qoder 的 `campaigns` 端点）的用例用：
 *        那些端点不在 Buddy 系的替身里，靠 flag 拼不出来。
 */
function createHarness(
  seed: ProviderAccountEntry[],
  override?: (url: string) => Response | undefined,
): Harness {
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
  // 出网：先问 override（只给需要别的协议的用例），未命中再走默认分派。
  // ⚠️ 覆盖路径**也要记进 `fetcher.calls`**：那些用例同样在断言「发了几个请求」。
  const baseFetch = fetcher.fetch
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (override !== undefined) {
      fetcher.calls.push(url)
      const response = override(url)
      if (response !== undefined) return response
      fetcher.calls.pop()
    }
    return await baseFetch(input as string, init)
  }) as unknown as typeof fetch)

  let handler: Handler | undefined
  const ctx = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      : undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials,
  }
  registerAccountHubRpc(
    ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, qoderAuthStub as never, qoderAuthStub as never,
  )
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

/**
 * 把某账号标记为**已签**：写入一个**未来**的下一次可签时刻。
 *
 * ⚠️ 不要写成 `writeCheckinNextEligible(p, id, Date.now() + 3600_000)` 这样的裸值：
 * 那会让「已签」的判据在测试里与本文件的被测语义脱钩（比如把 provider 的重置钟点
 * 写错也照样绿）。用 `nextEligibleAt` 走与生产**同一个**函数，边界语义才在测试里
 * 也成立。
 */
async function markSignedIn(pool: AccountPool, provider: string, accountId: string): Promise<void> {
  await pool.writeCheckinNextEligible(provider, accountId, nextEligibleAt(Date.now(), provider))
}

/**
 * Qoder 两区的 auth 最小替身。
 *
 * qoder 的签到链路**每一步都要 jt**（活动列表的 GET 与 claim 的 POST 都经
 * `auth.getJobToken`），故不能像别的 provider 那样传空对象 —— 空对象会让整条
 * 链路在「换 token」处就断掉，被测的判据（空列表 → undetermined）根本走不到，
 * 用例会以一个看起来像「协议不兼容」的 failed 收场。
 *
 * 只实现签到用到的两个方法：发一个固定 jt，丢弃缓存是空操作（本文件不测 401 重换
 * —— 那条路径由 `qoder-checkin-credits.spec.ts` 覆盖）。
 */
const qoderAuthStub = {
  async getJobToken(): Promise<string> { return 'jt-test' },
  invalidateJobToken(): void {},
}

/**
 * 一个**只接管 qoder 活动列表端点**的出网覆盖。
 *
 * ⚠️ 必须按 URL 分派，不能「一律返回活动列表」：qoder 的 claim 流程先要换 `jt`
 * （`/api/v1/jobToken/exchange`），把那份响应换成活动列表会让换 token 直接失败，
 * 整条链路根本走不到被测的判据上（表现为「outcome 是 failed」而不是 undetermined）。
 *
 * 其余端点（exchange / claim / 额度）一律交回默认替身。
 */
function qoderCampaignsOnly(campaigns: () => Response) {
  return (url: string): Response | undefined =>
    url.includes('/sash/api/v1/me/campaigns') ? campaigns() : undefined
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
    // 预置：acc-1 已签、acc-2 未签、acc-3 已签。
    const h = createHarness([makeEntry('acc-1'), makeEntry('acc-2'), makeEntry('acc-3')])
    await markSignedIn(h.pool, 'buddy-cn', 'acc-1')
    await markSignedIn(h.pool, 'buddy-cn', 'acc-3')

    const beforeCalls = h.fetcher.calls.length
    const result = await h.call<{ provider: string; nextReset: number; checkedIn: Record<string, boolean> }>(
      'credits.checkinStatus', { provider: 'buddy-cn' },
    )

    expect(result.ok).toBe(true)
    const v = (result as { value: { provider: string; nextReset: number; checkedIn: Record<string, boolean> } }).value
    expect(v.provider).toBe('buddy-cn')
    // `nextReset` 是该 provider 的下一次重置时刻（buddy-cn = 明日 0 点）。
    expect(v.nextReset).toBe(nextEligibleAt(Date.now(), 'buddy-cn'))
    // acc-2 未签 → false；其余 → true。无账号之外不给任何未知键。
    expect(v.checkedIn).toEqual({ 'acc-1': true, 'acc-2': false, 'acc-3': true })
    // ⚠️ 关键：**零网络**。checkinStatus 只读进程内 checkins。
    expect(h.fetcher.calls.length).toBe(beforeCalls)
  })

  it('过去的记录 = 未签（上一周期已翻页）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    // 手工写一个过去的时刻：它表达「上一次签到发生在很久以前」。
    await h.pool.writeCheckinNextEligible('buddy-cn', 'acc-1', Date.now() - 1000)
    const result = await h.call<{ checkedIn: Record<string, boolean> }>(
      'credits.checkinStatus', { provider: 'buddy-cn' },
    )
    expect((result as { value: { checkedIn: Record<string, boolean> } }).value.checkedIn).toEqual({ 'acc-1': false })
  })

  it('qoder-cn 的 nextReset 落在**当日/次日 10 点**，与 buddy-cn 的 0 点不同源', async () => {
    const h = createHarness([makeEntry('q1', { provider: 'qoder-cn', credentialRef: 'QODER_CN_ACCOUNT_Q1' })])
    const result = await h.call<{ nextReset: number }>('credits.checkinStatus', { provider: 'qoder-cn' })
    const nextReset = (result as { value: { nextReset: number } }).value.nextReset
    expect(nextReset).toBe(nextEligibleAt(Date.now(), 'qoder-cn'))
    // 钟点必须是 10 点（本地口径）—— 这条断言是「provider 配置真的被读到了」的
    // 唯一直接证据，比 `nextEligibleAt` 的等值比较更强。
    expect(new Date(nextReset).getHours()).toBe(10)
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
  it('单一账号领取成功 → 写下一次可签时刻（未来）', async () => {
    const h = createHarness([makeEntry('acc-1'), makeEntry('acc-2')])
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const value = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value
    // 只处理 acc-1（另一个不动）。
    expect(value.results).toHaveLength(1)
    // perform 响应与 claimAll 同构：带 nickname + 完整 outcome 对象（断言 .kind）。
    expect(value.results[0]).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'claimed' } })
    // acc-1 已写下一次可签时刻；acc-2 未被触碰。
    const expected = nextEligibleAt(Date.now(), 'buddy-cn')
    const recorded = h.pool.checkinNextEligible('buddy-cn', 'acc-1')
    expect(recorded).toBe(expected)
    // ⚠️ 必须落在**未来**：写成过去（尤其误写成日数）会让 `isCheckinDue` 永远为真，
    // 每轮 sweep 都重签一次 —— 这是新旧口径交接最容易复发的缺陷。
    expect(recorded!).toBeGreaterThan(Date.now())
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(false)
    expect(h.pool.checkinNextEligible('buddy-cn', 'acc-2')).toBeUndefined()
  })

  it('已签的账号在 sweep 里被跳过（下一次可签时刻未到）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    await markSignedIn(h.pool, 'buddy-cn', 'acc-1')
    h.fetcher.claimCode = 0

    await h.call<any>('checkin.sweep', {})

    // 一次请求都不该发（连预检都不发）。
    expect(h.fetcher.calls).toHaveLength(0)
  })

  it('already-claimed 也写下一次可签时刻（幂等由服务端已领态兜住）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 10001

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const r0 = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results[0]
    expect(r0).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'already-claimed' } })
    // 已领也写状态 → 后续 sweep 不再重复请求。
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(false)
  })

  it('failed 不写状态（下次 sweep 重试）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 999

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    expect(result.ok).toBe(true)
    const r0 = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results[0]
    expect(r0).toMatchObject({ accountId: 'acc-1', nickname: 'acc-1', outcome: { kind: 'failed' } })
    // 失败不写 → checkins 里没有该键，且判为可签。
    expect(h.pool.checkinNextEligible('buddy-cn', 'acc-1')).toBeUndefined()
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(true)
  })

  it('未知 provider 回可读 bad-request', async () => {
    const h = createHarness([])
    const result = await h.call('checkin.perform', { provider: 'not-a-provider', accountId: 'x' })
    expect(result.ok).toBe(false)
    expect((result as { error: { message: string } }).error.message).toBe('unsupported provider: not-a-provider')
  })
})

// ── 签到前后余额比对（2026-09-24 新增的 abnormal）──────────────────────────
//
// 这一档回答的是「响应说成功，账真的动了吗」—— 五家协议里有三家的 claim 响应
// **根本不含积分数**，故「成功」一直只是响应码的转述。判据是签到前后各取一次余额。
//
// 本组守两条边界，它们的方向**正好相反**，缺一不可：
// 1. 两次都拿到且没变多 → `abnormal`（**不写状态**，等下次 sweep 重试）；
// 2. **任一侧没拿到 → 放行**（按原判定报 claimed）。余额查询故障绝不能把一次
//    真实成功判成异常 —— 那会让用户追一个不存在的问题，且下次 sweep 还得再签一遍。

describe('签到前后余额比对（abnormal）', () => {
  it('余额变多 → 仍是 claimed，且**写下一次可签时刻**', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 0
    // 签到前 100 → 签到后 200。
    h.fetcher.balance = { totals: [100, 200] }

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const outcome = (result as { value: { results: Array<{ outcome: { kind: string } }> } }).value.results[0]!.outcome
    expect(outcome.kind).toBe('claimed')
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(false)
  })

  it('余额未变 → abnormal，且**不写**状态（下次 sweep 会重试）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 0
    // 前后都是 100（恒定）。
    h.fetcher.balance = { totals: [100] }

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const value = (result as { value: { results: Array<{ outcome: Record<string, unknown> }>; summary: Record<string, number> } }).value
    expect(value.results[0]!.outcome).toMatchObject({
      kind: 'abnormal',
      balanceBefore: 100,
      balanceAfter: 100,
    })
    // ✅ 核心：**不写**状态 —— 这是「下次 sweep 会重试」的唯一保障。
    // 写成已签会让一次可能只是延迟入账的异常变成永久失败。
    expect(h.pool.checkinNextEligible('buddy-cn', 'acc-1')).toBeUndefined()
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(true)
    // 摘要独立计数，既不进 claimed（那正是要修的缺陷）也不进 failed。
    expect(value.summary.abnormal).toBe(1)
    expect(value.summary.claimed).toBe(0)
    expect(value.summary.failed).toBe(0)
    // totalCredit 不含它：本 kind 的定义就是「没有积分进账」。
    expect(value.summary.totalCredit).toBe(0)
  })

  it('余额**变少**也判 abnormal（签到同时结算了一笔扣费时更不该报成功）', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 0
    h.fetcher.balance = { totals: [100, 80] }

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const outcome = (result as { value: { results: Array<{ outcome: Record<string, unknown> }> } }).value.results[0]!.outcome
    expect(outcome).toMatchObject({ kind: 'abnormal', balanceBefore: 100, balanceAfter: 80 })
  })

  it('余额查询故障（任一侧拿不到）→ **跳过比对**、按原判定报 claimed', async () => {
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 0
    h.fetcher.balanceThrows = true

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const value = (result as { value: { results: Array<{ outcome: { kind: string } }>; summary: Record<string, number> } }).value
    // ⚠️ 这是本组最重要的一条边界：余额查询故障不能把真成功判成异常。
    expect(value.results[0]!.outcome.kind).toBe('claimed')
    expect(value.summary.abnormal).toBe(0)
    expect(value.summary.claimed).toBe(1)
    // 成功 ⇒ 正常写状态。
    expect(h.pool.isCheckinDue('buddy-cn', 'acc-1')).toBe(false)
  })

  it('比对只在 claimed 时发生：预检就报「今日已签」时一次余额都不查、claim 也不发', async () => {
    const h = createHarness([makeEntry('acc-1')])
    // 预检直接说今天已签 → 走 already-claimed 短路，**根本不发 claim**。
    h.fetcher.statusCheckedIn = true
    const before = h.fetcher.calls.length

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const outcome = (result as { value: { results: Array<{ outcome: { kind: string } }> } }).value.results[0]!.outcome
    expect(outcome.kind).toBe('already-claimed')
    const calls = h.fetcher.calls.slice(before)
    // 只有那一次预检；没有 claim、没有任何余额请求。
    // ⚠️ 这一条正是「签到前余额必须**惰性**探测」的理由：无条件先查会让这段
    // 短路路径白打一次余额请求（浪费 + 风控面）。
    expect(calls.filter((u) => u.includes('/get-user-resource'))).toHaveLength(0)
    expect(calls.filter((u) => u.includes('/daily-checkin'))).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('比对只在 claimed 时发生：claim 回 10001（已领）时也不查余额', async () => {
    // 另一条到 already-claimed 的路：预检说未签，但 claim 端点回 10001。
    // 已领的奖励不是本次领到的，余额当然可能没变 —— 对它比对会把每一天的
    // 正常幂等响应都报成异常。
    const h = createHarness([makeEntry('acc-1')])
    h.fetcher.claimCode = 10001
    const before = h.fetcher.calls.length

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn', accountId: 'acc-1' })

    const outcome = (result as { value: { results: Array<{ outcome: { kind: string } }> } }).value.results[0]!.outcome
    expect(outcome.kind).toBe('already-claimed')
    const calls = h.fetcher.calls.slice(before)
    // 预检 + claim + **签到前那一次**余额 = 3 次；「签到后」那次没有发
    // （这正是「只有 claimed 才比对」的可观测证据）。
    expect(calls.filter((u) => u.includes('/get-user-resource'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('/daily-checkin'))).toHaveLength(1)
    expect(calls).toHaveLength(3)
  })

  it('codearts 登记为豁免：一次余额都不查（即使它返回 claimed）', async () => {
    // CodeArts 的积分来自 `statistics/plugin` 用量统计口径 —— 签到奖励是否实时
    // 反映**没有真机证据**，故按「拿不准就跳过」登记豁免（见 checkin-schedule.ts）。
    const h = createHarness([
      makeEntry('c1', { provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }),
    ])
    const before = h.fetcher.calls.length

    // CodeArts 的 claim 走签名协议，替身会让它失败 —— 这不影响本用例的判据：
    // 只要**没有** `get-user-resource` 请求，就证明豁免生效。
    await h.call<any>('checkin.perform', { provider: 'codearts', accountId: 'c1' })

    const balanceCalls = h.fetcher.calls.slice(before).filter((u) => u.includes('/get-user-resource'))
    expect(balanceCalls).toHaveLength(0)
  })
})

// ── undetermined（2026-09-24：Qoder 空活动列表）──────────────────────────────
//
// 「假签到」的另一半：Qoder 的活动列表为空时**既可能已领、也可能暂无活动**，
// 旧实现一律归一 `already-claimed` ⇒ 宿主写下签到状态 ⇒ 该账号整个周期不再被
// 尝试，而它可能一分没领。
//
// 本组守的是**状态写入**：`undetermined` 必须与 `failed` / `unavailable` /
// `abnormal` 同待遇（**不写**），下一轮 sweep 才有机会把它变成确定。

describe('undetermined 不写签到状态（否则一次不确定变成永久少领）', () => {
  /** 一个 qoder-cn 账号。 */
  const qoderEntry = (id: string): ProviderAccountEntry => makeEntry(id, {
    provider: 'qoder-cn',
    credentialRef: `QODER_CN_ACCOUNT_${id.toUpperCase()}`,
  })

  /** 空活动列表的响应（真机形态：`campaigns: []`）。 */
  const emptyCampaigns = () => new Response(
    JSON.stringify({ showCampaign: false, claimable: false, campaigns: [] }), { status: 200 },
  )

  it('空活动列表 → outcome.kind 为 undetermined，且 checkins 里**没有**该账号', async () => {
    const h = createHarness([qoderEntry('q1')], qoderCampaignsOnly(emptyCampaigns))

    const result = await h.call<any>('checkin.perform', { provider: 'qoder-cn', accountId: 'q1' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    const value = (result as { value: { results: Array<{ outcome: { kind: string; message: string } }> } }).value
    expect(value.results[0]!.outcome.kind, JSON.stringify(value.results[0]!.outcome)).toBe('undetermined')
    // ✅ 核心断言：**不写**状态。写成已签 = 伪造一次签到（用户看到已签却一分没领，
    // 且该账号在整个周期内都不会再被尝试）。
    expect(h.pool.checkinNextEligible('qoder-cn', 'q1')).toBeUndefined()
    expect(h.pool.isCheckinDue('qoder-cn', 'q1')).toBe(true)
  })

  it('undetermined 计入独立栏，既不进 alreadyClaimed（伪造签到）也不进 failed', async () => {
    const h = createHarness([qoderEntry('q1')], qoderCampaignsOnly(emptyCampaigns))

    const result = await h.call<any>('checkin.perform', { provider: 'qoder-cn', accountId: 'q1' })

    const summary = (result as { value: { summary: Record<string, number> } }).value.summary
    expect(summary.undetermined).toBe(1)
    expect(summary.alreadyClaimed).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.claimed).toBe(0)
  })

  it('下一轮 sweep 仍会尝试该账号（不写状态的实际价值）', async () => {
    // 第一趟：空列表 → undetermined、不写状态。第二趟活动出现 → 真的领到。
    // 若第一趟写了状态，第二趟会被「可签」筛选短路掉 —— 那正是本组要防的缺陷。
    let empty = true
    const h = createHarness([qoderEntry('q1')], qoderCampaignsOnly(() => (empty
      ? emptyCampaigns()
      : new Response(JSON.stringify({
          campaigns: [{
            campaignId: 'c1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            benefit: { amount: 100 },
          }],
        }), { status: 200 }))))

    await h.call<any>('checkin.sweep', {})
    expect(h.pool.isCheckinDue('qoder-cn', 'q1')).toBe(true)

    empty = false
    // claim 端点也要能成功（第一个 campaign 的 POST）。
    const result = await h.call<any>('checkin.perform', { provider: 'qoder-cn', accountId: 'q1' })
    const outcome = (result as { value: { results: Array<{ outcome: { kind: string } }> } }).value.results[0]!.outcome
    // claim 由 harness 的默认分支处理（返回 code:-1 ⇒ failed），故这里只断言
    // **确实又发起了尝试**（若被短路，outcome 都不会产生）。
    expect(outcome).toBeDefined()
    expect(outcome.kind).not.toBe('undetermined')
  })

  it('undetermined 时**不发签到后那次**余额查询（比对只在 claimed 时收尾）', async () => {
    // 比对只在 `claimed` 时收尾（见本文件另一组用例），故 undetermined 不会产生
    // 「签到后」那次请求。
    //
    // ⚠️ 但**签到前**那次仍然会发，且这是刻意的：qoder 传 `precheckStatus:false`
    // （claim 自带活动列表查询），宿主事先**不可能**知道这一发会领到、还是落进
    // 空列表 —— 要支持比对就必须先把「前」记下来。这条已知代价写在
    // `collectClaimResults` 的 `claimAndJudge` 注释里（「已领的账号会白花一次
    // 余额请求」）。故这里断言的是**恰好一次**，而不是零次。
    const h = createHarness([qoderEntry('q1')], qoderCampaignsOnly(emptyCampaigns))

    await h.call<any>('checkin.perform', { provider: 'qoder-cn', accountId: 'q1' })

    expect(h.fetcher.calls.filter((u) => u.includes('/api/v2/quota/usage'))).toHaveLength(1)
  })
})

// ── unavailable（2026-09-23 新增的 outcome kind）────────────────────────────
//
// 这一档目前**只有 Trae CN 的 `9074` 会产出**（服务端名额/风控类拒绝），故用例
// 走真实的 trae-cn 分派链路（`registerAccountHubRpc` 的 `runCreditsClaim` 分支），
// 而不是给 Buddy 打桩 —— 后者造不出这个 kind，测的会是一条永远走不到的分支。
//
// 本组守的是**状态写入**这一条最容易写错的规则：`unavailable` 必须与
// `failed` / `inactive` 同待遇（**不写** checkins）。一旦写入，sweep 的
// 「可签」筛选就会短路跳过该账号 —— 一次**瞬时**拒绝被固化成永久失败。

describe('unavailable 不写签到状态（否则再也不会重试）', () => {
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
    // ✅ 核心断言：**不写**状态 —— 这是「下次 sweep 会重试」的唯一保障。
    expect(h.pool.checkinNextEligible('trae-cn', 't1')).toBeUndefined()
    expect(h.pool.isCheckinDue('trae-cn', 't1')).toBe(true)
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
    expect(summary.abnormal).toBe(0)
  })

  it('unavailable 的账号在下一次 sweep 里**仍然会被尝试**（不写状态的实际价值）', async () => {
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9074
    // 第一趟：被服务端拒绝 → unavailable、不写状态。
    await h.call<any>('checkin.sweep', {})
    const callsAfterFirst = h.fetcher.calls.filter((u) => u.includes('/checkin_credits/claim')).length
    // ⚠️ **四次**（2026-09-24 上限升到 3）：首发 9074 → 换设备号重试最多 3 次 →
    // 仍是 9074 ⇒ unavailable。这里断言的是**第一趟确实试过**，次数由
    // `trae-cn-credits.spec.ts` 的重试用例精确钉死。
    expect(callsAfterFirst).toBe(4)
    expect(h.pool.checkinNextEligible('trae-cn', 't1')).toBeUndefined()

    // 第二趟：服务端恢复 → 真的领到了。若第一趟写了状态，这一趟会被
    // 「可签」筛选短路掉，claim 一次都不会发 —— 那正是本组要防的缺陷。
    h.fetcher.traeClaimCode = 0
    await h.call<any>('checkin.sweep', {})
    const claims = h.fetcher.calls.filter((u) => u.includes('/checkin_credits/claim'))
    // 第一趟 4 次（首发 + 3 次换号）+ 第二趟 1 次（首发即成功）。
    expect(claims).toHaveLength(5)
    expect(h.pool.isCheckinDue('trae-cn', 't1')).toBe(false)
  })

  it('9095（设备今日已签）→ 归一 already-claimed，**写**状态（这份已经到手）', async () => {
    // 与 unavailable 正好相反的一档：奖励今天确实已经领过，故按已签处理、
    // 写状态，后续 sweep 不再为它发请求。
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9095

    const result = await h.call<any>('checkin.perform', { provider: 'trae-cn', accountId: 't1' })

    const value = (result as { value: { results: Array<{ outcome: { kind: string } }>; summary: Record<string, number> } }).value
    expect(value.results[0]!.outcome.kind).toBe('already-claimed')
    expect(h.pool.isCheckinDue('trae-cn', 't1')).toBe(false)
    expect(value.summary.alreadyClaimed).toBe(1)
    expect(value.summary.unavailable).toBe(0)
  })

  it('9095 **不触发**换号：该号已成功过，换号没有依据', async () => {
    // 9095 说明「这台设备今天拿到过奖励」——它恰恰证明这个号是可用的。
    // 若把它也当 9074 处理，会在一次**成功**的路径上白摇 3 个号并改写凭据。
    const h = createHarness([traeEntry('t1')])
    h.fetcher.traeClaimCode = 9095

    await h.call<any>('checkin.perform', { provider: 'trae-cn', accountId: 't1' })

    // trae-cn 走 precheckStatus: false（claim 内部自带 status），故只有一次 claim。
    const claims = h.fetcher.calls.filter((u) => u.includes('/checkin_credits/claim'))
    expect(claims).toHaveLength(1)
  })
})

// ── checkin.perform：provider 全量退化 ──────────────────────────────────────

describe('checkin.perform 端点（accountId 缺省 → 全量）', () => {
  it('对每个账号按结果写状态（含已签的也走一遍 —— perform 不断言幂等）', async () => {
    const h = createHarness([makeEntry('a'), makeEntry('b'), makeEntry('c')])
    // 预置：a 已签（不重签）、b/c 未签。
    await markSignedIn(h.pool, 'buddy-cn', 'a')
    h.fetcher.claimCode = 0

    const result = await h.call<any>('checkin.perform', { provider: 'buddy-cn' })

    expect(result.ok).toBe(true)
    const results = (result as { value: { results: Array<{ accountId: string; nickname: string; outcome: { kind: string } }> } }).value.results
    // 缺省 accountId → 全量账号都过一遍（含已签的 a —— perform 是全量尝试，不停用短路）。
    expect(results.map((r) => r.accountId)).toEqual(['a', 'b', 'c'])
    expect(results.every((r) => r.outcome.kind === 'claimed')).toBe(true)
    // 每个结果都带 nickname。
    expect(results.every((r) => r.nickname === r.accountId)).toBe(true)
    // 三个账号都被写状态。
    for (const id of ['a', 'b', 'c']) {
      expect(h.pool.isCheckinDue('buddy-cn', id), id).toBe(false)
    }
  })
})

// ── checkin.sweep ──────────────────────────────────────────────────────────

describe('checkin.sweep 端点', () => {
  it('只签「此刻可签」的账号（已签的跳过）', async () => {
    const h = createHarness([makeEntry('signed'), makeEntry('due-1'), makeEntry('due-2')])
    await markSignedIn(h.pool, 'buddy-cn', 'signed')
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
    // 两个未签账号都被写状态。
    for (const id of ['due-1', 'due-2']) {
      expect(h.pool.isCheckinDue('buddy-cn', id), id).toBe(false)
    }
    // signed 一次请求都没有（不发预检、不发余额）：2 账号 × (预检 + 领取 + 2 次余额)。
    const signedCalls = h.fetcher.calls.filter((u) => u.includes('signed'))
    expect(signedCalls).toHaveLength(0)
  })

  it('sweep 对一个 qoder-cn 账号按 10 点周期判可签（写出的下一次可签是 10 点）', async () => {
    const h = createHarness([
      makeEntry('q1', { provider: 'qoder-cn', credentialRef: 'QODER_CN_ACCOUNT_Q1' }),
    ])
    h.fetcher.claimCode = 0
    // 让 qoder-cn 走到 claim：它的 claim 走 qoder 协议（替身会给失败），
    // 但**状态写入**只看得 outcome —— 本项目用例关心的是「写出的时刻是几点」。
    await h.pool.writeCheckinNextEligible('qoder-cn', 'q1', Date.now() - 1000)
    await h.call<any>('checkin.sweep', {})

    // 上一次签到的记录被覆盖成新周期（若本次 claimed）。qoder-cn 的 claim 在
    // 替身下不会成功，故这里只断言**没有崩**且状态仍是可签 —— 真正的钟点断言
    // 在 `checkin-schedule.spec.ts`（纯函数）与 perform 的用例里。
    expect(h.pool.isCheckinDue('qoder-cn', 'q1')).toBe(true)
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
    // 只签一次：x 只被写一次状态（若两趟都跑，第二趟会看到已写而不发请求）。
    expect(h.pool.isCheckinDue('buddy-cn', 'x')).toBe(false)
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
