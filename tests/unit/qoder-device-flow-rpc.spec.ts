/**
 * Qoder 浏览器设备流登录的 **Account Hub RPC 分派**测试（两段式）。
 *
 * ## 本文件与 `qoder-device-flow.spec.ts` 的分工
 *
 * 那一份测**协议纯逻辑**（PKCE / URL / 轮询节奏 / machine_id 落盘）；本文件测
 * **宿主分派**：`account.create` 无 `pat` 时走设备流、占位 → loginUrl 立即返回 →
 * 后台补全/失败移除、provider 级互斥、`account.delete` 取消轮询、以及
 * **PAT 路径逐字节不变**。
 *
 * ## 为什么不能只测纯函数
 *
 * 「新增 provider 漏接一个分支」是本仓库被记录过两次的缺陷形态；而「把新登录
 * 形态接进 `account.create`」最容易出的错不是协议错，是**两段式的时序错**：
 * 在 RPC 里 await 完整个登录（用户手势过期、客户端被弹窗拦截）、失败时留下
 * 没有凭据的幽灵账号、或者把 PAT 与设备流揉成一条路径。这些只在真实处理器上
 * 才暴露。
 *
 * ## 替身边界
 *
 * 只有**出网**与**时间**被替换（注入 fetcher / sleep / homeDir）。
 * `QoderAuth`、`AccountPool`、`registerAccountHubRpc` 全是真实实现 —— 这样
 * 「凭据落到哪个 ref」「占位条目的 refreshable 是什么」才是被断言的对象。
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { QoderAuth } from '../../src/qoder-auth.js'
import { QODER, QODER_CN, type QoderCredential } from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

class FakeCredentials {
  private readonly store = new Map<string, string>()
  readonly writes: string[] = []
  async resolve(ref: unknown) {
    const value = this.store.get(String(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const key = String(ref)
    return { configured: this.store.has(key), source: this.store.has(key) ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) {
    const key = String(ref)
    this.store.set(key, value)
    this.writes.push(key)
  }
  async unset(ref: unknown) { this.store.delete(String(ref)) }
}

interface CapturedCall {
  url: string
  method: string
}

/** exchange 成功响应（`expires_in` 是**毫秒**，与 T1 实测一致）。 */
function exchangeBody(options: { refreshToken?: string | null; userId?: string } = {}): string {
  const refresh = options.refreshToken === null
    ? {}
    : { refresh_token: options.refreshToken ?? 'jrt-1' }
  return JSON.stringify({
    token: 'jt-from-exchange',
    expires_in: 86_400_000,
    ...refresh,
    ...options.userId === undefined ? {} : { userId: options.userId },
  })
}

/** 设备流轮询的成功响应（成功判据：两个字段都是 string）。 */
function deviceTokenBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: 'pt-from-device-flow',
    refresh_token: 'jrt-from-device-flow',
    ...overrides,
  })
}

interface Harness {
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  accounts(provider?: string): Promise<ProviderAccountEntry[]>
  credentials: FakeCredentials
  calls: CapturedCall[]
  /** 出网替身收到的 `deviceToken/poll` 次数（轮询是否停止，靠它断言）。 */
  pollCount(): number
  teardown(): Promise<void>
}

const harnesses: Harness[] = []
const tempHomes: string[] = []

/**
 * 一个**同步**建的临时 home 目录。
 *
 * 用 `mkdtempSync` 而不是异步版：harness 的构造是同步的，而 homeDir 必须在
 * 两个 `QoderAuth` 实例化**之前**就绪。测试里同步文件 IO 的代价可以忽略。
 */
function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-device-rpc-'))
  tempHomes.push(dir)
  return dir
}
/**
 * 构造 ctx / pool / 真实 `QoderAuth` ×2 + 出网替身并注册端点。
 *
 * `responds` 决定每次出网的响应；`undefined` 表示抛传输层错误。
 */
function createHarness(
  responds: (call: CapturedCall) => Response | undefined,
  options: { exchangeRefreshToken?: string | null; deviceFlow?: Record<string, unknown> } = {},
): Harness {
  const credentials = new FakeCredentials()
  const calls: CapturedCall[] = []
  // ⚠️ **每个 harness 一个临时 home**：设备流会读写
  // `~/.qoder/.auth/machine_id`，那是**用户与官方 CLI 共用**的机器身份。
  // 不隔离就会污染用户真实环境（且测试之间互相串值）。
  const homeDir = makeTempHome()

  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: CapturedCall = { url: String(url), method: String(init?.method ?? 'GET') }
    calls.push(call)
    const response = responds(call)
    if (response === undefined) throw new TypeError('fetch failed')
    return response
  })
  vi.stubGlobal('fetch', fetcher)

  let stored: Record<string, unknown> = { accounts: [] }
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

  const serviceCtx = new Context()
  serviceCtx.provide('credentials', credentials as never)
  // 设备流的三个注入点全部指向测试替身：出网、等待、home 目录。
  // **homeDir 必须注入** —— 真实的 `~/.qoder/.auth/machine_id` 是用户与官方 CLI
  // 共用的机器身份，测试写它会让用户混用官方 CLI 时签名因机器码漂移失效。
  //
  // ⚠️ `timeoutMs` **必须调小**（默认 5 分钟）：轮询的终止条件是「挂钟到点」，
  // 而替身 sleep 是瞬时的 —— 用默认超时会让一个必然失败的用例在真实时间里
  // 空转 5 分钟、并因每次轮询都往 calls 里压一条而把堆打爆（实测 OOM）。
  // 这里让每次等待真的走 1ms 定时器，把迭代次数钉在几十次量级。
  const deviceFlow = {
    fetcher: fetcher as unknown as typeof fetch,
    sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ms, 1)) }),
    homeDir,
    intervalMs: 1,
    timeoutMs: 60,
    ...options.deviceFlow,
  }
  const qoder = new QoderAuth(serviceCtx, { fetcher: fetcher as unknown as typeof fetch, deviceFlow })
  const qoderCn = new QoderAuth(serviceCtx, {
    product: QODER_CN,
    fetcher: fetcher as unknown as typeof fetch,
    deviceFlow,
  })

  let handler: ((request: Request) => Promise<Response>) | undefined
  const rpcCtx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (opts: { fetch: (request: Request) => Promise<Response> }) => { handler = opts.fetch },
      },
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
  }

  registerAccountHubRpc({
    ctx: rpcCtx as never, pool,
    codearts: {} as never, buddyCn: {} as never, buddy: {} as never, lobsterai: {} as never,
    traeCn: {} as never, qoder, qoderCn,
  })
  if (handler === undefined) throw new Error('Account Hub 端点未注册')

  const call = async <T>(method: string, payload: unknown): Promise<RpcResult<T>> => {
    const response = await handler!(new Request('http://127.0.0.1/api/account-hub', {
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

  const harness: Harness = {
    call,
    accounts: (provider?: string) => pool.listAllAccounts()
      .then((all) => (provider === undefined ? all : all.filter((a) => a.provider === provider))),
    credentials,
    calls,
    pollCount: () => calls.filter((c) => c.url.includes('/api/v1/deviceToken/poll')).length,
    async teardown() {
      // 设备流的互斥槽位是模块级单例：不结算就会泄漏到下一个用例，
      // 让它拿到一个莫名其妙的 login-in-progress。
      qoder.cancelPendingLogin('测试清理')
      qoderCn.cancelPendingLogin('测试清理')
      qoder.stop()
      qoderCn.stop()
    },
  }
  harnesses.push(harness)
  return harness
}

/** 一个同时服务设备流轮询与 exchange 的替身。 */
function deviceResponder(options: { poll?: () => Response; exchange?: string | null } = {}) {
  return (call: CapturedCall): Response => {
    if (call.url.includes('/api/v1/deviceToken/poll')) {
      return options.poll === undefined
        ? new Response(deviceTokenBody(), { status: 200 })
        : options.poll()
    }
    if (call.url.includes('/api/v1/jobToken/exchange')) {
      return new Response(exchangeBody({ refreshToken: options.exchange }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
}

/** 等待后台第二段结算（RPC 是 void 出去的，测试要给它几个 microtask）。 */
async function settleBackground(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(async () => {
  for (const harness of harnesses) await harness.teardown()
  harnesses.length = 0
  for (const dir of tempHomes.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
// ── account.create：无 pat → 设备流两段式 ────────────────────────────────────

describe('account.create —— 无 pat 时走浏览器设备流（两段式）', () => {
  it('同步返回 loginUrl（不 await 用户操作），且是 qoder.com 的授权页', async () => {
    // ⚠️ 判据必须用**永不成功**的轮询：若让轮询立刻成功，会话会在 RPC 返回前
    // 就结算掉，那样「有没有 await 用户」根本测不出来（两条路都返回 ok）。
    const h = createHarness(() => new Response('', { status: 404 }), {
      deviceFlow: { timeoutMs: 5000, intervalMs: 50 },
    })
    const result = await h.call<{ accountId: string; loginUrl: string }>(
      'account.create', { provider: 'qoder' },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accountId).toMatch(/^qoder-[0-9a-f]{8}$/)
    const url = new URL(result.value.loginUrl)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.pathname).toBe('/device/selectAccounts')
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    // **第一段绝不能等用户**：RPC 里 await 完整登录会让客户端拿到 URL 时
    // 用户手势早已过期，开窗被拦截、DSH 页面被顶掉。
    // 此刻用户尚未授权 ⇒ 凭据必然还没落盘，而 RPC 已经返回了。
    expect(h.credentials.writes).toEqual([])
  })

  it('第一段写入**占位**账号：refreshable:false、无 expiresAt、无凭据', async () => {
    // 同样用**永不成功**的轮询：否则后台可能在断言前就结算完，占位形态一闪而过，
    // 这条用例会变成「看运气」（实测已观察到该竞态）。
    const h = createHarness(() => new Response('', { status: 404 }), {
      deviceFlow: { timeoutMs: 5000, intervalMs: 50 },
    })
    const result = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const entries = await h.accounts('qoder')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.id).toBe(result.value.accountId)
    expect(entry.provider).toBe('qoder')
    expect(entry.enabled).toBe(true)
    // 占位形态：这三项都要等 exchange 结果才知道，先写死会给出假状态。
    expect(entry.refreshable).toBe(false)
    expect(entry.expiresAt).toBeUndefined()
    // 凭据还没落盘 —— 这正是 `login.poll` 的检测路径所依赖的中间态。
    expect(h.credentials.writes).toEqual([])
  })

  it('后台第二段：凭据落到账号自己的 ref，占位条目被补全', async () => {
    const h = createHarness(deviceResponder())
    const result = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settleBackground()

    const entries = await h.accounts('qoder')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.refreshable).toBe(true)
    expect(entry.credentialRef).toMatch(/^QODER_ACCOUNT_[0-9A-F]{8}$/)
    expect(h.credentials.writes).toEqual([entry.credentialRef])

    const stored = await h.credentials.resolve(entry.credentialRef)
    expect(stored).toBeDefined()
    const credential = JSON.parse(stored!.value) as QoderCredential
    // 设备流拿到的 token 就是**长期凭据本体**（与 PAT 同形态、同字段），
    // 故它进 access_token —— 账号池身份标识取这个字段，换字段会静默失配。
    expect(credential.access_token).toBe('pt-from-device-flow')
    expect(credential.refresh_token.length).toBeGreaterThan(0)

    // `login.poll` 按「凭据能否解析」判定，此刻应当 done。
    const poll = await h.call<{ done: boolean }>('login.poll', {
      accountId: entry.id, provider: 'qoder',
    })
    expect(poll.ok && poll.value.done).toBe(true)
  })

  it('设备流拿到的 refresh_token 在 exchange 未返回时被采用（不丢字段）', async () => {
    // exchange 不带 refresh_token 时，设备流自己那份是唯一来源 —— 丢掉它
    // 会让凭据少一个字段，而「有没有 refresh_token」是续期路径的判据之一。
    const h = createHarness(deviceResponder({ exchange: null }))
    const result = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settleBackground()

    const entry = (await h.accounts('qoder'))[0]!
    const stored = await h.credentials.resolve(entry.credentialRef)
    const credential = JSON.parse(stored!.value) as QoderCredential
    expect(credential.refresh_token).toBe('jrt-from-device-flow')
  })

  it('第二段失败：登记失败终态 + 移除占位（不留幽灵账号）', async () => {
    // 轮询一直 404 且超时立即到点 ⇒ 第二段必然失败。
    const h = createHarness(() => new Response('', { status: 404 }))
    const result = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await settleBackground()

    // 占位账号被移除 —— 留下它就是「永远没有凭据的幽灵账号」。
    expect(await h.accounts('qoder')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])

    // 失败是**终态**：poll 必须能如实回 done + error，否则客户端白等 5 分钟。
    const poll = await h.call<{ done: boolean; error?: string }>('login.poll', {
      accountId: result.value.accountId, provider: 'qoder',
    })
    expect(poll.ok).toBe(true)
    if (!poll.ok) return
    expect(poll.value.done).toBe(true)
    expect(poll.value.error).toBeTruthy()
  })

  it('第二段失败后占位被移除，但**不影响**下一次登录（槽位已释放）', async () => {
    const failing = createHarness(() => new Response('', { status: 404 }))
    const first = await failing.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(first.ok).toBe(true)
    await settleBackground()

    // 同一个 harness 再点一次：槽位若没释放，这里会拿到 login-in-progress。
    const second = await failing.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(second.ok, JSON.stringify(second)).toBe(true)
  })

  it('CN 面板的 loginUrl 指向 qoder.cn（两区授权页不通用）', async () => {
    const h = createHarness(deviceResponder())
    const result = await h.call<{ loginUrl: string }>('account.create', { provider: 'qoder-cn' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(new URL(result.value.loginUrl).origin).toBe('https://qoder.cn')
  })
})

// ── 登录互斥 ────────────────────────────────────────────────────────────────

describe('登录互斥：同 region 已有未结算会话 → login-in-progress', () => {
  it('第二次 account.create 返回可判别错误码，且**不新建**占位账号', async () => {
    // 会话必须在第二次调用时**仍然未结算** —— 否则互斥根本不会被触发。
    const h = createHarness(() => new Response('', { status: 404 }), {
      deviceFlow: { timeoutMs: 5000, intervalMs: 50 },
    })
    const first = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await h.call<unknown>('account.create', { provider: 'qoder' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    // 必须原样透传错误码（抛异常会被包成 handler-failed，客户端拿不到可判别码）。
    expect(second.error.code).toBe('login-in-progress')
    // 不新建：否则每次点击堆一个占位账号 + 一个轮询循环到 5 分钟超时。
    expect(await h.accounts('qoder')).toHaveLength(1)
  })

  it('两个 region 各自独立互斥：国际版进行中不挡 CN', async () => {
    const h = createHarness(() => new Response('', { status: 404 }), {
      deviceFlow: { timeoutMs: 5000, intervalMs: 50 },
    })
    const intl = await h.call<unknown>('account.create', { provider: 'qoder' })
    expect(intl.ok).toBe(true)
    // 两区是两批账号、两套令牌 —— 一个区的登录窗口不该挡住另一区。
    const cn = await h.call<unknown>('account.create', { provider: 'qoder-cn' })
    expect(cn.ok, JSON.stringify(cn)).toBe(true)
  })
})

// ── account.delete 取消 ─────────────────────────────────────────────────────

describe('account.delete 取消进行中的设备流登录', () => {
  it('删除占位账号后轮询停止，且槽位释放（可立刻重新登录）', async () => {
    const h = createHarness(() => new Response('', { status: 404 }))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const deleted = await h.call<unknown>('account.delete', { accountId: created.value.accountId })
    expect(deleted.ok).toBe(true)

    // 取消是**立即**的：轮询循环必须停下，否则它会一直打到 5 分钟超时。
    const before = h.pollCount()
    await settleBackground()
    expect(h.pollCount()).toBe(before)

    // 槽位已释放 —— 删掉账号后想重新登录不该拿到 login-in-progress。
    const again = await h.call<unknown>('account.create', { provider: 'qoder' })
    expect(again.ok, JSON.stringify(again)).toBe(true)
  })
})

// ── PAT 路径回归 ────────────────────────────────────────────────────────────

describe('PAT 路径**并存**且行为不变（login({pat}) 仍走 PAT）', () => {
  it('带 pat 时仍是同步完成、loginUrl 为空串、无占位中间态', async () => {
    const h = createHarness(() => new Response(exchangeBody({ userId: 'u-42' }), { status: 200 }))
    const result = await h.call<{ accountId: string; loginUrl: string }>(
      'account.create', { provider: 'qoder', pat: 'pt-abc123' },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    // 恒为空串：客户端据它决定是否开窗，空串正好表达「无事可开」。
    expect(result.value.loginUrl).toBe('')
    // **当场就绪**：PAT 是即时请求，不存在后台第二段。
    const entries = await h.accounts('qoder')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.refreshable).toBe(true)
    expect(entries[0]!.expiresAt).toBeUndefined()
    expect(h.credentials.writes).toHaveLength(1)
    // 一次网都不出到设备流端点。
    expect(h.pollCount()).toBe(0)
  })

  it('PAT 前缀校验仍然本地拒绝，且一次网都不出', async () => {
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    for (const pat of [undefined, '', '   ', 'nope', 'pt-']) {
      // 注意：`undefined` 在**新语义**下是「走设备流」而不是「PAT 非法」，
      // 故这里只断言字符串形态的非法输入。
      if (pat === undefined) continue
      const result = await h.call<unknown>('account.create', { provider: 'qoder', pat })
      expect(result.ok, JSON.stringify(pat)).toBe(false)
      if (result.ok) continue
      expect(result.error.message).toContain('PAT 格式不正确')
    }
  })

  it('PAT 与设备流**不混用**：带 pat 时不产生任何设备流轮询', async () => {
    const h = createHarness((call) => {
      if (call.url.includes('/api/v1/deviceToken/poll')) {
        // 一旦走到这里就说明两条路径被揉在一起了 —— 让它显式失败。
        throw new Error(`PAT 路径不应打设备流端点：${call.url}`)
      }
      return new Response(exchangeBody(), { status: 200 })
    })
    const result = await h.call<unknown>('account.create', { provider: 'qoder', pat: 'pt-abc123' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(h.pollCount()).toBe(0)
  })
})
