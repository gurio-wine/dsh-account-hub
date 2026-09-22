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

/** 构造 ctx / pool / 全局 fetch 替身并注册端点，返回调用器。 */
function harness(options: {
  accounts: ProviderAccountEntry[]
  /** 按账号 id 给凭据；返回 undefined 表示该账号凭据缺失。 */
  credentials: Record<string, TraeCnCredential | undefined>
  responds: (url: string, call: CapturedCall) => Response
  /** 让某个账号的 credentials.resolve 抛错（验证异常隔离）。 */
  throwOnRef?: string
}) {
  const calls: CapturedCall[] = []
  let handler: ((request: Request) => Promise<Response>) | undefined

  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: CapturedCall = {
      url: String(url),
      deviceId: headers.get('x-device-id') ?? undefined,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    }
    calls.push(call)
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
    },
    get: () => undefined,
  }
  const pool = {
    listAllAccounts: async () => options.accounts,
    listAccounts: async (provider: string) => options.accounts.filter((a) => a.provider === provider),
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
    expect(h.calls.map((c) => (c.url.includes('/claim') ? 'claim' : 'status')))
      .toEqual(['status', 'claim', 'status', 'status'])
    expect(h.calls.map((c) => c.deviceId)).toEqual([DEVICE_A, DEVICE_A, DEVICE_A, DEVICE_B])
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
      responds: (url, call) => {
        expect(url).toContain('/trae/api/v2/pay/web_user_ent_usage')
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
      responds: () => new Response(JSON.stringify({ code: 0, data: { unrelated: true } }), { status: 200 }),
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
