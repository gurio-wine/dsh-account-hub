/**
 * Trae CN 三个积分 RPC 分派的回归测试。
 *
 * `collect*` 那类纯函数的测试（`tests/unit/account-hub-rpc.spec.ts`）走的是**注入替身**
 * 的路径，**覆盖不到** `registerAccountHubRpc` 里的 provider 分发分支 —— 而那正是
 * 新增 provider 最容易漏的地方（LobsterAI 当初就漏了 `account.refresh` 的
 * workbuddy 分支）。因此这里直接驱动注册出来的 HTTP 处理器，并用**全局 fetch
 * 替身**接住真实下钻函数发出的请求，断言端到端的分派行为。
 *
 * 与 LobsterAI 的差异（本文件的重点）：
 * - Trae 的签到是**两步**（status → 未领则 claim），且 claim 必须带设备头；
 * - 余额**按 provider（面板 id）分池显示**：Trae CN 面板只见通用池、Trae CN
 *   Work 面板只见 Work 池，两者查的是同一批账号的同一个端点。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'
import { TRAE_CN_DEVICE_SOURCE_ROTATED } from '../../src/trae-cn-product.js'
import { TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT } from '../../src/trae-cn-credits.js'

/** 16 位十进制设备号（两个账号刻意不同，用于验证设备号取自各自的凭据）。 */
const DEVICE_A = '7212345678901234'
const DEVICE_B = '9900000000000042'

function credentialOf(deviceId: string, nickname: string): TraeCnCredential {
  return {
    access_token: `AT-${nickname}`,
    refresh_token: 'RT',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: deviceId,
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    nickname,
  }
}

function entry(id: string, enabled = true): ProviderAccountEntry {
  return {
    id,
    provider: 'trae-cn',
    nickname: id,
    enabled,
    credentialRef: `TRAE_CN_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 1,
    refreshable: true,
  }
}

/** 一次被捕获的请求。 */
interface CapturedCall {
  url: string
  deviceId: string | undefined
  body: unknown
}

/**
 * 余额端点路径（**与 `credits.balances` 的 trae-cn 分支打的是同一个端点**）。
 *
 * ⚠️ 夹具必须把它与 status 分开路由。签到前后余额比对（`compareBalanceAroundClaim`）
 * 会在每次 claim 前后各查一次余额，而本文件原先按「URL 不含 `/claim` ⇒ 就是
 * status」粗暴分流 —— 于是余额探测会**吃掉**夹具里按设备号计数的 status 序号，
 * 让「领取后的补查」提前发生：一次真实成功的领取被报成 `already-claimed`
 * （预检那次读到 `checked_in: true` ⇒ 连 claim 都不发）。
 *
 * 三个落点（status / claim / balance）必须逐个显式分流，不能靠「不是 A 就是 B」
 * —— 这正是新增端点时最容易复发的一类夹具缺陷。
 */
const TRAE_CN_BALANCE_PATH = '/trae/api/v2/pay/web_user_ent_usage'

/** 请求落点（断言顺序用）：**三种**，余额探测是比对新引入的第三种。 */
function kindOf(url: string): 'claim' | 'status' | 'balance' {
  if (url.includes('/claim')) return 'claim'
  return url.includes(TRAE_CN_BALANCE_PATH) ? 'balance' : 'status'
}

/**
 * 余额端点的**默认**脚本：第 n 次请求返回 `100 × n`。
 *
 * 递增是刻意的：签到前后各取一次 ⇒ 判「余额变多」⇒ outcome 与改动前**逐字段
 * 一致**，于是本文件里与比对无关的用例（顺序性、异常隔离、换号重试……）不会被
 * 这条新路径意外改写成 `abnormal`。需要「余额不变 / 查不到」形态的用例
 * （见 `credits.balances` 组）各自显式传 `balance` 脚本。
 *
 * 礼包形态与 `credits.balances` 组同一个：`available_endpoint: 0` = **通用池**
 * （签到发的就是通用积分，比对也必须走同一个池）。
 */
function defaultBalanceResponse(callIndex: number): Response {
  return new Response(JSON.stringify({
    code: 0,
    data: { packages: [{ available_endpoint: 0, name: '通用礼包', remain_amount: 100 * (callIndex + 1) }] },
  }), { status: 200 })
}

/** 构造 ctx / pool / 全局 fetch 替身并注册端点，返回调用器。 */
function harness(options: {
  accounts: ProviderAccountEntry[]
  /** 按账号 id 给凭据；返回 undefined 表示该账号凭据缺失。 */
  credentials: Record<string, TraeCnCredential | undefined>
  responds: (url: string, call: CapturedCall) => Response
  /**
   * 余额端点（{@link TRAE_CN_BALANCE_PATH}）的脚本；缺省 = 递增总额
   * （见 {@link defaultBalanceResponse}）。只有**以余额端点本身为被测对象**的
   * 用例才需要它。
   */
  balance?: (call: CapturedCall) => Response
  /** 让某个账号的 credentials.resolve 抛错（验证异常隔离）。 */
  throwOnRef?: string
}) {
  const calls: CapturedCall[] = []
  /**
   * 被写回的凭据（`ctx.credentials.set` 的调用记录）。
   *
   * 需要它是因为 9074 换号路径的**唯一持久化落点**就在这里：换号本身在
   * `trae-cn-credits.ts` 里，但「落到哪个 ref、序列化成什么」由 RPC 层的
   * `persistCredential` 回调决定 —— 只断言「发了两次 claim」会漏掉写回这一半。
   */
  const writes: Array<{ refName: string; credential: TraeCnCredential }> = []
  let handler: ((request: Request) => Promise<Response>) | undefined
  /** 余额端点被请求的次数（缺省脚本按它递增）。 */
  let balanceCalls = 0

  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: CapturedCall = {
      url: String(url),
      deviceId: headers.get('x-device-id') ?? undefined,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    }
    calls.push(call)
    // 余额端点**先**分流：`responds` 只负责 status / claim 两个落点。
    if (call.url.includes(TRAE_CN_BALANCE_PATH)) {
      const index = balanceCalls
      balanceCalls += 1
      return options.balance === undefined ? defaultBalanceResponse(index) : options.balance(call)
    }
    return options.responds(call.url, call)
  })
  vi.stubGlobal('fetch', fetcher)

  const ctx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (config: { fetch: (request: Request) => Promise<Response> }) => {
          handler = config.fetch
        },
      },
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async (ref: { name?: string } | string) => {
        const name = typeof ref === 'string' ? ref : String(ref.name ?? '')
        if (options.throwOnRef !== undefined && name === options.throwOnRef) {
          throw new Error('credential store unavailable')
        }
        const suffix = name.replace('TRAE_CN_ACCOUNT_', '')
        const credential = options.credentials[suffix]
        return credential === undefined ? undefined : { value: JSON.stringify(credential) }
      },
      describe: async () => ({ configured: true }),
      // 9074 换号后的写回落点（见 `writes` 的说明）。`refName` 由 RPC 层按
      // 当前账号闭包给出，故这里能断言「写的是不是这台账号」。
      set: async (ref: { name?: string } | string, value: string) => {
        const name = typeof ref === 'string' ? ref : String(ref.name ?? '')
        writes.push({ refName: name, credential: JSON.parse(value) as TraeCnCredential })
      },
      unset: async () => {},
    },
    get: () => undefined,
  }
  const pool = {
    listAllAccounts: async () => options.accounts,
    listAccounts: async (provider: string) => options.accounts.filter((a) => a.provider === provider),
    // `credits.balances` 会把查到的余额**回写**进余额缓存（面板与选号同一口径）：
    // 替身必须提供这个出口，否则会以 `pool.recordBalances is not a function`
    // 冒泡成 handler-failed，把被测的 provider 分派缺陷伪装成替身不完整。
    recordBalances: () => {},
  }
  registerAccountHubRpc(
    ctx as never,
    pool as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // qoder / qoderCn：本文件只驱动 trae 系的积分分支（两个 Qoder region 都
    // 走不到），传空对象以暴露任何误落到 Qoder 分支的改动。
    {} as never,
    {} as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  return {
    calls,
    writes,
    call: async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://127.0.0.1/api/account-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r1',
          method: 'account-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

/** 一个账号一条凭据的最小映射。 */
function creds(...entries: Array<[string, TraeCnCredential]>): Record<string, TraeCnCredential> {
  return Object.fromEntries(entries)
}

describe('credits.status 的 trae-cn 分派', () => {
  it('返回真实签到状态（用 checked_in，不是占位 null）', async () => {
    const h = harness({
      accounts: [entry('a'), entry('b')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')], ['B', credentialOf(DEVICE_B, 'B')]),
      responds: (url, call) => new Response(JSON.stringify({
        code: 0,
        // 按设备号区分两个账号：A 已签到、B 未签到。
        data: { checked_in: call.deviceId === DEVICE_A, enable: true },
      }), { status: 200 }),
    })
    const result = await h.call('credits.status', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as { accounts: Array<{ accountId: string; status: { todayCheckedIn: boolean } | null }> }
    expect(value.accounts).toHaveLength(2)
    expect(value.accounts[0]!.status!.todayCheckedIn).toBe(true)
    expect(value.accounts[1]!.status!.todayCheckedIn).toBe(false)
  })

  it('包含已停用账号（停用不影响「今天领了没」）', async () => {
    const h = harness({
      accounts: [entry('a', false)],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: () => new Response(JSON.stringify({ code: 0, data: { checked_in: true, enable: true } }), { status: 200 }),
    })
    const result = await h.call('credits.status', { provider: 'trae-cn' })
    const value = result.value as { accounts: Array<{ status: { todayCheckedIn: boolean } | null }> }
    expect(value.accounts).toHaveLength(1)
    expect(value.accounts[0]!.status!.todayCheckedIn).toBe(true)
  })

  it('单账号凭据异常不影响其余账号（status 记为 null）', async () => {
    const h = harness({
      accounts: [entry('a'), entry('b')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')], ['B', credentialOf(DEVICE_B, 'B')]),
      throwOnRef: 'TRAE_CN_ACCOUNT_A',
      responds: () => new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }),
    })
    const result = await h.call('credits.status', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as { accounts: Array<{ accountId: string; status: unknown }> }
    expect(value.accounts[0]!.status).toBeNull()
    expect(value.accounts[1]!.status).not.toBeNull()
  })
})

describe('credits.claimAll 的 trae-cn 分派', () => {
  /**
   * A 未签到、B 已签到的响应；两个账号的设备号各不相同。
   *
   * ⚠️ **积分只在 status 里**（T8 定案）：claim 的完整响应是
   * `{"code":0,"message":"success"}`，没有积分数，故领取成功后宿主会再查一次
   * status 取 `credits`。补查那一次要按**账号**分别计数（每个账号各有一次
   * 预检 + 一次补查），故 `statusCalls` 按 `deviceId` 计数 —— 用全局计数器会
   * 让 A 的补查把 B 的预检也算成「已签到」，静默改变被测行为。
   *
   * `checkedInDevice` **必须显式给**：它是「这个账号本来就已签到」这一业务
   * 状态，不同用例要的是不同状态（顺序性用例要 B 已签，凭据缺失用例要两个
   * 账号都未签）。写死一个默认值会让后者静默变成「已领」而不是「已领取」。
   *
   * ⚠️ 本脚本只需处理 status 与 claim 两个落点：**余额端点已在
   * {@link harness} 里提前分流**（见 `TRAE_CN_BALANCE_PATH`）。这一点不是可有可无
   * ——余额探测会按账号各发一次，混进下面的 `statusCalls` 计数就会把预检顶成
   * 「补查」、让真实领取被报成 `already-claimed`。
   */
  const claimFlow = (options: { credits?: number; checkedInDevice?: string } = {}) => {
    const statusCalls = new Map<string, number>()
    return (url: string, call: CapturedCall): Response => {
      if (url.includes('/claim')) {
        return new Response(JSON.stringify({ code: 0, message: 'success' }), { status: 200 })
      }
      const seen = statusCalls.get(call.deviceId ?? '') ?? 0
      statusCalls.set(call.deviceId ?? '', seen + 1)
      // 第 2 次起就是领取后的补查（与真机一致：补查时 checked_in 已翻转）。
      const isRecheck = seen > 0
      return new Response(JSON.stringify({
        code: 0,
        data: {
          checked_in: isRecheck || call.deviceId === options.checkedInDevice,
          enable: true,
          credits: options.credits ?? 150,
        },
      }), { status: 200 })
    }
  }

  it('逐账号顺序执行：未领的领取、已领的不发领取请求', async () => {
    const h = harness({
      accounts: [entry('a'), entry('b')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')], ['B', credentialOf(DEVICE_B, 'B')]),
      responds: claimFlow({ checkedInDevice: DEVICE_B }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as {
      results: Array<{ accountId: string; outcome: { kind: string; credit?: number } }>
      summary: { claimed: number; totalCredit: number; alreadyClaimed: number; failed: number }
    }
    expect(value.results[0]!.outcome).toMatchObject({ kind: 'claimed', credit: 150 })
    expect(value.results[1]!.outcome).toEqual({ kind: 'already-claimed', message: '今天已签到' })
    expect(value.summary).toMatchObject({ claimed: 1, totalCredit: 150, alreadyClaimed: 1, failed: 0 })
    // 顺序性 + 幂等短路：A 的 status（预检）/claim/status（补查）各一次，
    // B 只有 status 一次（已签到 ⇒ 既不发 claim、也不补查）。
    // ⚠️ 只看 status / claim 两个落点——本断言管的是「发了几发领取请求、按什么
    // 顺序」。trae-cn 已登记余额比对豁免（签到奖励结算延迟，见 checkin-schedule.ts
    // 的 BALANCE_COMPARISON_EXEMPT_PROVIDERS），故 balance 一发都不该有。
    const protocol = h.calls.filter((c) => kindOf(c.url) !== 'balance')
    expect(protocol.map((c) => kindOf(c.url)))
      .toEqual(['status', 'claim', 'status', 'status'])
    expect(protocol.map((c) => c.deviceId)).toEqual([DEVICE_A, DEVICE_A, DEVICE_A, DEVICE_B])
    expect(h.calls.filter((c) => kindOf(c.url) === 'balance')).toHaveLength(0)
  })

  it('包含已停用账号（签到与账号池自动选择无关）', async () => {
    const h = harness({
      accounts: [entry('a', false)],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: claimFlow({ credits: 10 }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    const value = result.value as { summary: { claimed: number; totalCredit: number } }
    expect(value.summary).toMatchObject({ claimed: 1, totalCredit: 10 })
  })

  it('单账号凭据缺失记为 failed，不中断整批', async () => {
    // 两个账号都**未**签到：缺凭据的 A 记 failed，有凭据的 B 正常领取。
    const h = harness({
      accounts: [entry('a'), entry('b')],
      credentials: creds(['B', credentialOf(DEVICE_B, 'B')]),
      responds: claimFlow({ credits: 10 }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as { results: Array<{ outcome: { kind: string; message: string } }>; summary: { claimed: number; failed: number } }
    expect(value.summary).toMatchObject({ claimed: 1, failed: 1 })
    expect(value.results[0]!.outcome).toMatchObject({ kind: 'failed' })
  })

  it('claim 返回 9004 时该账号记为 failed 并带上设备线索', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: (url) => url.includes('/claim')
        ? new Response(JSON.stringify({ code: 9004 }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    const value = result.value as { results: Array<{ outcome: { kind: string; code: number; message: string } }> }
    expect(value.results[0]!.outcome.kind).toBe('failed')
    expect(value.results[0]!.outcome.code).toBe(9004)
    expect(value.results[0]!.outcome.message).toContain('设备校验未通过')
  })

  /**
   * `9095`：账号未签 + **设备已签**（真机判定矩阵，2026-09-23）。
   *
   * 这是本次修复的缺口之一：此前 claim 的失败分支没有 9095 判据，它掉进
   * 默认的 `failed` —— 界面报「失败」，而实际上**今天这份奖励已经到手**。
   */
  it('claim 返回 9095 → already-claimed（设备今日已签，不是失败）', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: (url) => url.includes('/claim')
        ? new Response(JSON.stringify({ code: 9095, message: '当前设备今日已经签到' }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    const value = result.value as {
      results: Array<{ outcome: { kind: string } }>
      summary: { alreadyClaimed: number; failed: number; unavailable: number }
    }
    expect(value.results[0]!.outcome.kind).toBe('already-claimed')
    expect(value.summary).toMatchObject({ alreadyClaimed: 1, failed: 0, unavailable: 0 })
  })

  /**
   * `9074`：**设备号被服务端拉黑**（2026-09-23 第五次定性，旧「名额/风控」已作废）。
   *
   * 归一 `unavailable`（既不是 failed 也不是已领），且走**换设备号重试** ——
   * 真机矩阵：全新 16 位号首次 claim 即 `code:0`。次数上限由
   * `TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT` 定（2026-09-24 用户拍板提到 3），且**每次
   * 换一个全新生成的号**。本夹具恒定回 9074，故首发与每一次换号都失败 ⇒
   * `unavailable`，共 `1 + 上限` 次 claim。
   */
  it('claim 返回 9074 → 换号重试用尽（1 + 上限）仍拒 → unavailable', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: (url) => url.includes('/claim')
        ? new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多，请稍后再试' }), { status: 200 })
        : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }),
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    const value = result.value as {
      results: Array<{ outcome: { kind: string; code: number; message: string } }>
      summary: { unavailable: number; failed: number; claimed: number }
    }
    expect(value.results[0]!.outcome.kind).toBe('unavailable')
    expect(value.results[0]!.outcome.code).toBe(9074)
    // 新文案：说清「暂不可签 + 稍后自动重试」，且**不再**出现旧错误指引。
    expect(value.results[0]!.outcome.message).toContain('稍后自动重试')
    expect(value.results[0]!.outcome.message).not.toContain('重新登录')
    // 独立计数，不并入 failed。
    expect(value.summary).toMatchObject({ unavailable: 1, failed: 0, claimed: 0 })
    // ⚠️ 共 `1 + TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT` 次 claim（首发 + 每次换一个
    // **全新**号）；**首发之外的每一发都带全新设备号** —— 这正是本改动在 RPC
    // 分派层的落点（凭据由宿主写入）。次数不写死：上限是策略，改了它不该让这里
    // 变成一条需要跟着改的常量（`trae-cn-credits.spec.ts` 从同一常量取值）。
    const claims = h.calls.filter((c) => c.url.includes('/claim'))
    expect(claims).toHaveLength(1 + TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT)
    expect(claims[0]!.deviceId).toBe(DEVICE_A)
    for (const claim of claims.slice(1)) {
      expect(claim.deviceId).toMatch(/^\d{16}$/)
      expect(claim.deviceId).not.toBe(DEVICE_A)
    }
    // ⚠️ **每次换的是不同的新号**：服务端拉黑的是号，重发同一个新号必然得到同一个
    // 9074，那三次机会就退化成白烧两个往返。
    expect(new Set(claims.map((c) => c.deviceId)).size).toBe(claims.length)
  })

  /**
   * 换号重试**成功**：RPC 层必须看到 `claimed`，且新设备号已**写回凭据**
   * （`ctx.credentials.set` 落到该账号自己的 ref 上）。
   *
   * 这是「下一轮 sweep 用干净号起步」这条承诺的**唯一**落点：漏掉写回，
   * 每一轮都得先撞一次 9074 —— 功能上仍会成功，但每轮白烧一次往返。
   */
  it('9074 换号后重试成功 → claimed，且新号写回该账号的凭据 ref', async () => {
    let claimCount = 0
    let statusCount = 0
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: (url) => {
        if (!url.includes('/claim')) {
          // 第 1 次 status 是领取前的预检（未签），第 2 次是领取成功后的补查
          // （已签 —— 与真机一致，积分从这一次的 `credits` 取）。
          statusCount += 1
          return new Response(JSON.stringify({
            code: 0, data: { checked_in: statusCount > 1, enable: true, credits: 150 },
          }), { status: 200 })
        }
        claimCount += 1
        return claimCount === 1
          ? new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多，请稍后再试' }), { status: 200 })
          : new Response(JSON.stringify({ code: 0, message: 'success' }), { status: 200 })
      },
    })
    const result = await h.call('credits.claimAll', { provider: 'trae-cn' })
    const value = result.value as { results: Array<{ outcome: { kind: string; credit?: number } }> }
    expect(value.results[0]!.outcome).toMatchObject({ kind: 'claimed', credit: 150 })

    // 写回落到了**这台账号**的 ref（不是别的账号、也不是默认单凭据 ref）。
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]!.refName).toBe('TRAE_CN_ACCOUNT_A')
    const written = h.writes[0]!.credential
    const claims = h.calls.filter((c) => c.url.includes('/claim'))
    // 落盘的号**就是**重试实际用的那个 —— 否则下一轮起点与这一轮不一致。
    expect(written.checkin_device_id).toBe(claims[1]!.deviceId)
    expect(written.checkin_device_id).toMatch(/^\d{16}$/)
    expect(written.device_id_source).toBe(TRAE_CN_DEVICE_SOURCE_ROTATED)
    // 其余身份字段原样保留（换号只动签到设备号）。
    expect(written.device_id).toBe(DEVICE_A)
    expect(written.access_token).toBe('AT-A')
  })
})

describe('credits.balances 的 trae-cn 分派（按 provider 选池）', () => {
  /** 双池响应：通用 154.22 / Work 2000 —— 上游仍分池下发。 */
  const dualPoolResponse = (): Response => new Response(JSON.stringify({
    code: 0,
    data: {
      packages: [
        { available_endpoint: 0, name: '通用礼包', remain_amount: 154.22 },
        { available_endpoint: 1, name: 'Work礼包', remain_amount: 2000 },
      ],
    },
  }), { status: 200 })

  it('provider=trae-cn 时只显示**通用池**（154.22），Work 包不出现在 packages 里', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      // 余额端点是本用例的**被测对象**，故走它自己的 `balance` 脚本 —— 混在
      // `responds` 里会落进「不是 /claim 就是 status」那道分流而**静默不执行**。
      responds: () => new Response('{}', { status: 200 }),
      balance: (call) => {
        expect(call.url).toContain(TRAE_CN_BALANCE_PATH)
        expect(call.body).toEqual({ require_usage: true })
        return dualPoolResponse()
      },
    })
    const result = await h.call('credits.balances', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as {
      accounts: Array<{ balance: { total: number; packages: Array<{ name: string }> } | null; error?: string }>
    }
    expect(value.accounts[0]!.error).toBeUndefined()
    expect(value.accounts[0]!.balance!.total).toBe(154.22)
    // 资源包同样只含本池：Work 那 2000 不该出现在 Trae CN 面板上。
    expect(value.accounts[0]!.balance!.packages.map((pkg) => pkg.name)).toEqual(['通用礼包'])
  })

  it('选池由**面板分支**决定，不由账号池键顺带给出', async () => {
    // 两个问题必须分开答：「查谁的账号」走 `poolProviderFor`（今天恒等），
    // 「显示哪个池」由 `credits.balances` 里的 provider 分支决定。
    // 若有人把选池并进账号映射（或反过来），面板会显示它花不掉的池 —— 且不报错。
    const { poolProviderFor } = await import('../../src/account-hub-rpc.js')
    expect(poolProviderFor('trae-cn')).toBe('trae-cn')
  })

  it('查不到时 balance 为 null + error（不是 0 积分）', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: creds(['A', credentialOf(DEVICE_A, 'A')]),
      responds: () => new Response('{}', { status: 200 }),
      // 余额端点回了 200，但响应里**没有礼包数组** ⇒ 「查不到」，不是 0 积分。
      balance: () => new Response(JSON.stringify({ code: 0, data: { unrelated: true } }), { status: 200 }),
    })
    const result = await h.call('credits.balances', { provider: 'trae-cn' })
    expect(result.ok).toBe(true)
    const value = result.value as { accounts: Array<{ balance: unknown; error?: string }> }
    expect(value.accounts[0]!.balance).toBeNull()
    expect(value.accounts[0]!.error).toBe('余额查询失败')
  })

  it('单账号凭据缺失 → error 为「凭据未配置」', async () => {
    const h = harness({
      accounts: [entry('a')],
      credentials: {},
      responds: () => new Response('{}', { status: 200 }),
    })
    const result = await h.call('credits.balances', { provider: 'trae-cn' })
    const value = result.value as { accounts: Array<{ error?: string }> }
    expect(value.accounts[0]!.error).toBe('凭据未配置')
  })
})

describe('trae-cn 不被误判为不支持的 provider', () => {
  const METHODS = ['credits.status', 'credits.claimAll', 'credits.balances']

  it.each(METHODS)('%s 对 trae-cn 返回 ok（不落到 productById 的拒绝分支）', async (method) => {
    const h = harness({
      accounts: [],
      credentials: {},
      responds: () => new Response('{}', { status: 200 }),
    })
    const result = await h.call(method, { provider: 'trae-cn' })
    expect(result.ok, result.error?.message).toBe(true)
  })

  it.each(METHODS)('%s 对未知 provider 仍然拒绝', async (method) => {
    const h = harness({
      accounts: [],
      credentials: {},
      responds: () => new Response('{}', { status: 200 }),
    })
    const result = await h.call(method, { provider: 'mystery' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: mystery')
  })
})
