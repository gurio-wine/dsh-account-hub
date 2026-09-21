/**
 * Qoder 的 Account Hub RPC 分派回归测试（接入步骤 6）。
 *
 * ## 为什么单独一个文件
 *
 * `account.create` / `credits.balances` / `account.refresh` 三处**宿主分发分支**
 * 不在任何纯函数上：`collect*` 那类测试走的是注入替身路径，覆盖不到
 * `registerJetHubRpc` 里的 provider 分发。而「新增 provider 漏接一个分支」
 * 正是本仓库被记录过两次的缺陷形态（LobsterAI 漏了 `account.refresh` 的
 * workbuddy 分支；Trae CN 漏了整条积分线，见 `47f253f`）。故这里直接驱动注册
 * 出来的**真实 HTTP 处理器**，只把出网换成替身。
 *
 * ## 与其它 provider 那一份的差异（本文件的重点）
 *
 * Qoder 是**唯一的非浏览器登录形态**：
 *
 * 1. **没有两段式**。`account.create` 收 `{ provider:'qoder', pat }`，同步完成
 *    exchange 验证并落凭据、落账号，**当场**返回。没有 `loginUrl` 要开窗、
 *    没有后台第二段、失败时也没有需要清理的占位账号 —— 这条差异必须被钉死，
 *    否则将来有人「照 buddy 的样子」补一个占位条目，就会在 PAT 被拒时留下
 *    一个永远没有凭据的幽灵账号。
 * 2. **失败即拒绝，且不复述 PAT**：前缀不对 / exchange 401 / 网络失败三条路
 *    都必须以可展示原因拒绝，且错误文案里**不得出现 PAT 本体**。
 * 3. **积分只有余额一项**：`credits.status` / `credits.claimAll` **刻意不加**
 *    qoder 分支（官方每日 100 Credits 只能在桌面 App 手动领，无公开 API），
 *    落到 `unsupported provider: qoder` 是**正确契约** —— 客户端靠能力矩阵
 *    （`dailyCheckin: false`）在**发请求之前**就不发，与 CodeArts 的既有约定同源。
 *
 * ## 替身边界
 *
 * 只有**出网**被替换（注入 `QoderAuthOptions.fetcher` + 全局 fetch 替身）。
 * `QoderAuth`、`AccountPool`、RPC 处理器全部是真实实现 —— 这样
 * 「凭据落到哪个 ref」「账号池条目的 provider 字段是什么」这类**真实副作用**
 * 才是被断言的对象，而不是断言的替身自己的行为。
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { QoderAuth } from '../../src/qoder-auth.js'
import { QODER, QODER_CN, QODER_PAT_URL, type QoderCredential } from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** RPC 响应的判别联合（`reply()` 会给 error 补一个 `details`）。 */
type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

/** 最小化的内存凭据提供者，形状与 `ctx.credentials` 一致。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  /** 写入顺序（用于断言「凭据确实落到了派生的那个 ref 上」）。 */
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

/** 一次被捕获的出网请求。 */
interface CapturedCall {
  url: string
  method: string
  /** `Authorization` 头（用于区分「用了 PAT」与「用了 jt」）。 */
  authorization: string
}

/** 一次典型的 exchange 成功响应（T1 实测形态：`expires_in` 是**毫秒**）。 */
function exchangeBody(options: { userId?: string } = {}): string {
  return JSON.stringify({
    token: 'jt-from-exchange',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    expires_in: 86_400_000,
    refresh_token: 'jrt-1',
    refresh_token_expires_at: new Date(Date.now() + 172_800_000).toISOString(),
    refresh_token_expires_in: 172_800_000,
    ...options.userId === undefined ? {} : { userId: options.userId },
  })
}

/**
 * 一次典型的 quota 响应（T1 实测原文形态）。
 *
 * 三池结构：`userQuota` 必有，后两个**本账号缺席** —— 这里刻意给出
 * `addOnQuota`，用来验证「三池相加」与「主池耗尽 ≠ 额度耗尽」的口径。
 */
function quotaBody(pools: { user?: number; addOn?: number } = {}): string {
  const pool = (remaining: number) => ({
    total: 1000, used: 1000 - remaining, remaining, percentage: 50, unit: 'credits',
  })
  return JSON.stringify({
    userId: 'u-1',
    userType: 'personal_standard',
    usageType: 'credits',
    totalUsagePercentage: 50,
    isQuotaExceeded: false,
    expiresAt: 253402214400000,
    upgradeUrl: 'https://qoder.com/pricing?client=qoder',
    userQuota: pool(pools.user ?? 0),
    ...pools.addOn === undefined ? {} : { addOnQuota: pool(pools.addOn) },
    isPlanQuotaProrated: false,
  })
}

interface Harness {
  /** 调用一个端点方法，返回解包后的 result。 */
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  /** 直接读账号池的权威条目（含 provider / credentialRef / expiresAt 等字段）。 */
  accounts(provider?: string): Promise<ProviderAccountEntry[]>
  credentials: FakeCredentials
  /** 本用例期间的全部出网请求。 */
  calls: CapturedCall[]
  teardown(): Promise<void>
}

const harnesses: Harness[] = []

/** 设备流用例建的临时 home 目录；afterEach 统一删除。 */
const tempHomes: string[] = []

/**
 * 构造 ctx / pool / 真实 `QoderAuth` + 全局 fetch 替身并注册端点。
 *
 * `responds` 决定每次出网的响应；返回 `undefined` 表示「抛一个传输层错误」，
 * 用来覆盖「断网不等于 PAT 失效」那条判据。
 */
function createHarness(responds: (call: CapturedCall) => Response | undefined): Harness {
  const credentials = new FakeCredentials()
  const calls: CapturedCall[] = []
  // ⚠️ **临时 home**：设备流会读写 `~/.qoder/.auth/machine_id`，那是用户与
  // 官方 CLI **共用**的机器身份。不隔离就会污染用户真实环境。
  const homeDir = mkdtempSync(join(tmpdir(), 'qoder-rpc-'))
  tempHomes.push(homeDir)

  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    }
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

  // 真实的 QoderAuth：fetcher 注入而非打桩模块，这样 exchange / jt 缓存 /
  // 凭据写入全走真实代码路径。每个 harness 一个独立 Context —— cordis 的
  // Service 按名称注册，同一个 Context 上第二次 `new QoderAuth` 会抛
  // `service "qoderAuth" has been registered`。
  //
  // **两个 region 各一个实例**（服务名 `qoderAuth` / `qoderCnAuth` 互不冲突）：
  // 生产接线就是这样，而分派必须按 provider 选对实例 —— jt 缓存与 exchange
  // host 都按实例/产品取值，用错实例的失败形态是假的「PAT 失效」。
  const serviceCtx = new Context()
  serviceCtx.provide('credentials', credentials as never)
  // 设备流注入：临时 home + 快速超时（默认 5 分钟会让「等授权」的用例空转）。
  const deviceFlow = {
    homeDir,
    sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ms, 1)) }),
    intervalMs: 1,
    timeoutMs: 60,
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
        register: (options: { fetch: (request: Request) => Promise<Response> }) => {
          handler = options.fetch
        },
      },
    },
    // 生产代码用**惰性注入**（`ctx.inject(['connection'], …)`）挂载端点，而非
    // 插件级静态 `inject`：`connection` 只存在于 Web bundle，静态声明会让
    // headless/CLI profile 永久 pending 而启动失败。替身必须复刻这一机制。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
  }

  registerJetHubRpc(
    rpcCtx as never,
    pool,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    qoder,
    qoderCn,
  )
  if (handler === undefined) throw new Error('Account Hub 端点未注册')

  const call = async <T>(method: string, payload: unknown): Promise<RpcResult<T>> => {
    const response = await handler!(new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'jet-hub',
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
    async teardown() {
      // 设备流的互斥槽位是模块级单例：不结算会泄漏到下一个用例。
      qoder.cancelPendingLogin('测试清理')
      qoderCn.cancelPendingLogin('测试清理')
      qoder.stop()
      qoderCn.stop()
    },
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of harnesses) await harness.teardown()
  harnesses.length = 0
  for (const dir of tempHomes.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── account.create 的 qoder 分支 ─────────────────────────────────────────────

describe('account.create —— qoder 的 PAT 粘贴式登录（非两段式）', () => {
  /** 成功路径：exchange 回一张 jt，配额与目录都不参与。 */
  const successResponder = () => new Response(exchangeBody({ userId: 'u-42' }), { status: 200 })

  it('同步完成：凭据落到派生的 QODER_ACCOUNT_* ref，账号进池，loginUrl 为空', async () => {
    const h = createHarness(successResponder)
    const result = await h.call<{ accountId: string; loginUrl: string }>(
      'account.create', { provider: 'qoder', pat: 'pt-abc123' },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accountId).toMatch(/^qoder-[0-9a-f]{8}$/)
    // **没有浏览器登录流程**：loginUrl 恒为空串（客户端据它决定是否开窗，
    // 空串正好表达「无事可开」）。非空会让客户端多开一张白页。
    expect(result.value.loginUrl).toBe('')

    // 账号**当场**就绪 —— 没有任何「后台第二段」需要等待。这正是与另外六个
    // provider 的分界：若哪天有人给它补上占位条目 + 后台补全，这里的
    // refreshable/expiresAt 断言会立刻变红。
    const entries = await h.accounts('qoder')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.id).toBe(result.value.accountId)
    expect(entry.provider).toBe('qoder')
    expect(entry.enabled).toBe(true)
    expect(entry.refreshable).toBe(true)
    // ⚠️ **不写 expiresAt**：PAT 的过期时间本地无从得知，而 jt 的 24h 只是
    // 运行时缓存有效期 —— 写进去会让账号卡片在闲置 24h 后显示「已过期」，
    // 而实际上一次 getJobToken() 就能自愈。
    expect(entry.expiresAt).toBeUndefined()
    // 昵称取 exchange 响应里的 userId（有则用），否则回落到 accountId。
    expect(entry.nickname).toBe('u-42')
    expect(entry.credentialRef).toMatch(/^QODER_ACCOUNT_[0-9A-F]{8}$/)

    // 凭据确实落在**账号自己的** ref 上（不是默认单凭据 ref）。
    expect(h.credentials.writes).toEqual([entry.credentialRef])
    const stored = await h.credentials.resolve(entry.credentialRef)
    expect(stored).toBeDefined()
    const credential = JSON.parse(stored!.value) as QoderCredential
    // PAT 存进 access_token：账号池的 findAccountIdByCredential 对非 codearts
    // 的 provider 统一取该字段作身份标识，换字段会让限流记账恒匹配不到账号。
    expect(credential.access_token).toBe('pt-abc123')
    expect(credential.refresh_token).toBe('jrt-1')
    // jt **不落盘**（运行时缓存），凭据里只有它的过期时刻元数据。
    expect(JSON.stringify(credential)).not.toContain('jt-from-exchange')

    // `login.poll` 按「凭据是否可解析」判定 —— 凭据已在盘上，故第一次即 done。
    const poll = await h.call<{ done: boolean; success?: boolean }>(
      'login.poll', { accountId: entry.id, provider: 'qoder' },
    )
    expect(poll.ok && poll.value.done).toBe(true)
  })

  it('载荷缺 pat 时按「PAT 格式不正确」拒绝，且**一次网都不出**', async () => {
    const h = createHarness(successResponder)
    // 前缀校验是**本地**的（`isQoderPersonalToken`），故它必须发生在 exchange 之前：
    // 把一次必然失败的往返换成一条可读提示。
    //
    // ⚠️ 2026-09-21 设备流落地后，**`pat: undefined`（键缺失）不再属于这一组**：
    // 那是「用户要浏览器登录」，走设备流。这里只列**显式提交了非法 PAT 值**的形态
    // —— 包括空串与纯空白（客户端 PAT 表单提交时总是带 `pat` 键，空值就是
    // 「用户提交了空 PAT」，必须回格式错误而不是静默开一个授权页）。
    for (const pat of ['', '   ', 'nope', 'dt-device-token', 'pt-']) {
      const result = await h.call<unknown>('account.create', { provider: 'qoder', pat })
      expect(result.ok, JSON.stringify(pat)).toBe(false)
      if (result.ok) continue
      expect(result.error.message).toContain('Qoder 登录失败')
      expect(result.error.message).toContain('PAT 格式不正确')
    }
    expect(h.calls).toHaveLength(0)
    // 失败是**终态**：没有占位账号、没有半成品凭据。
    expect(await h.accounts('qoder')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])
  })

  it('键缺失（`pat: undefined`）走**设备流**，不再回「PAT 格式不正确」', async () => {
    // 这是设备流落地带来的**有意**语义变更，单独一条钉死，免得将来有人
    // 「顺手」把它并回上面那组（那会让浏览器登录永远打不开）。
    const h = createHarness(() => new Response('', { status: 404 }))
    const result = await h.call<{ loginUrl: string }>('account.create', { provider: 'qoder' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    // 回的是授权页 URL，而不是一条「请粘贴 PAT」的指引。
    expect(new URL(result.value.loginUrl).pathname).toBe('/device/selectAccounts')
  })

  it('PAT 被服务端拒绝（exchange 401）时给出「重新粘贴」的可读原因', async () => {
    const h = createHarness(() => new Response(
      JSON.stringify({ errorCode: 'Unauthorized', message: 'TOKEN_INVALID' }), { status: 401 },
    ))
    const result = await h.call<unknown>('account.create', { provider: 'qoder', pat: 'pt-revoked' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 前缀校验通过 → 出了一次网 → 401 判「PAT 已失效或不被接受」。
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toContain('/api/v1/jobToken/exchange')
    expect(result.error.message).toContain('Qoder 登录失败')
    expect(result.error.message).toContain('重新粘贴')
    expect(await h.accounts('qoder')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])
  })

  it('网络失败（传输层）不判成「PAT 失效」—— 断网不该让用户重签凭据', async () => {
    const h = createHarness(() => undefined)
    const result = await h.call<unknown>('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Qoder 登录失败')
    // 判据是**不能出现**「重新粘贴」这类终态指引：那会让用户为一次断网白跑
    // 一趟 Integrations 页面，而真因（网络）被掩盖。
    expect(result.error.message).not.toContain('重新粘贴')
    expect(result.error.message).toContain('网络失败')
    expect(await h.accounts('qoder')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])
  })

  it('错误文案里绝不出现 PAT 本体（凭据是长期有效的秘密）', async () => {
    const secret = 'pt-super-secret-value-should-never-be-echoed'
    const h = createHarness(() => new Response('{"error":"unauthorized"}', { status: 401 }))
    const result = await h.call<unknown>('account.create', { provider: 'qoder', pat: secret })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).not.toContain(secret)
    // 连片段都不该出现（前缀 `pt-` 是格式说明，可以出现；正文不行）。
    expect(result.error.message).not.toContain('super-secret')
  })

  it('第二个 PAT 建出**第二个**账号（多 PAT = 多账号，互不覆盖）', async () => {
    const h = createHarness(successResponder)
    const first = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-one' })
    const second = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-two' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.accountId).not.toBe(first.value.accountId)

    const entries = await h.accounts('qoder')
    expect(entries).toHaveLength(2)
    // 两条账号各占一个 ref：共用一份凭据会让「删掉一个账号」把另一个的凭据也清掉。
    expect(new Set(entries.map((e) => e.credentialRef)).size).toBe(2)
    expect(h.credentials.writes).toHaveLength(2)
  })

  it('未知 provider 仍然拒绝（qoder 分支不改变既有兜底）', async () => {
    const h = createHarness(successResponder)
    const result = await h.call<unknown>('account.create', { provider: 'mystery' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/unknown provider/)
  })

  it('trae-cn-work 仍被拒绝（恒等映射不适用于它）', async () => {
    // 与 Qoder 无关的**反向**锚点：`poolProviderFor` 把 trae-cn-work 映射到
    // trae-cn，但 `account.create` **刻意不映射** —— 映射会让面板多出的二次
    // 点击给同一份凭据建出第二个占位账号。Qoder 是恒等映射，不该被误当成
    // 「所以所有 provider 都能建号」。
    const h = createHarness(successResponder)
    const result = await h.call<unknown>('account.create', { provider: 'trae-cn-work' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toMatch(/unknown provider/)
  })
})

// ── credits.balances 的 qoder 分支 ───────────────────────────────────────────

describe('credits.balances —— qoder 的余额查询（只认 jt）', () => {
  /**
   * 出网替身：exchange 回一张 jt，quota 回给定的响应。
   *
   * 两个端点由**同一次查询**先后打到（auth 先换 jt、再用它打额度），故这里按
   * URL 分流 —— 这同时让「额度端点用的是 jt 而不是 PAT」变成可断言的事实。
   */
  function responder(options: { quota?: () => Response } = {}) {
    return (call: CapturedCall): Response => {
      if (call.url.includes('/api/v1/jobToken/exchange')) {
        return new Response(exchangeBody(), { status: 200 })
      }
      if (call.url.includes('/api/v2/quota/usage')) {
        return options.quota === undefined ? new Response(quotaBody(), { status: 200 }) : options.quota()
      }
      return new Response('not found', { status: 404 })
    }
  }

  it('返回 CreditBalance 同构结构：三池 remaining 相加、包名取池类型', async () => {
    const h = createHarness(responder({
      quota: () => new Response(quotaBody({ user: 12.5, addOn: 7.5 }), { status: 200 }),
    }))
    // 用 account.create 建号（顺带再验一次它的产物能被余额查询消费）。
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-abc123' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // 清掉建号那一次的调用记录，专注余额这一次的出网。
    h.calls.length = 0

    const result = await h.call<{
      accounts: Array<{
        balance: { total: number; packages: Array<{ name: string; remaining: number }>; expiredTotal: number } | null
        error?: string
      }>
    }>('credits.balances', { provider: 'qoder' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts).toHaveLength(1)
    const account = result.value.accounts[0]!
    expect(account.error).toBeUndefined()
    expect(account.balance).not.toBeNull()
    // 三池相加：12.5 + 7.5（缺席的 orgResourcePackage 按 0 计）。
    expect(account.balance!.total).toBe(20)
    expect(account.balance!.packages.map((pkg) => pkg.name)).toEqual(['主额度', '加量包'])
    // quota 端点只在**账号级**给一个 expiresAt（9999 年 = 永不过期），池本身
    // 没有失效字段，故 expiredTotal 恒为 0（拿账号级时间戳当池失效判据会产出
    // 假的「另有 N 已失效」）。
    expect(account.balance!.expiredTotal).toBe(0)

    // ⚠️ 额度端点只认 jt：PAT 打它回 401 TOKEN_EXPIRE。
    const quotaCall = h.calls.find((c) => c.url.includes('/api/v2/quota/usage'))
    expect(quotaCall).toBeDefined()
    expect(quotaCall!.authorization).toBe('Bearer jt-from-exchange')
  })

  it('主池耗尽但加量包有余 ⇒ 报真实余额，不显示成 0（「主池耗尽 ≠ 额度耗尽」）', async () => {
    const h = createHarness(responder({
      quota: () => new Response(JSON.stringify({
        userId: 'u-1', isQuotaExceeded: true, usageType: 'credits',
        userQuota: { total: 100, used: 100, remaining: 0, percentage: 100, unit: 'credits' },
        addOnQuota: { total: 50, used: 0, remaining: 50, percentage: 0, unit: 'credits' },
      }), { status: 200 }),
    }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    const result = await h.call<{ accounts: Array<{ balance: { total: number } | null; error?: string }> }>(
      'credits.balances', { provider: 'qoder' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 服务端自报 isQuotaExceeded:true，但加量包还有 50 —— 判 0 会让用户
    // 白白废掉一个仍可用的账号。
    expect(result.value.accounts[0]!.balance!.total).toBe(50)
  })

  it('查不到（响应形态不认识）时 balance 为 null + error，**不是** 0 积分', async () => {
    const h = createHarness(responder({
      quota: () => new Response(JSON.stringify({ unrelated: true }), { status: 200 }),
    }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    const result = await h.call<{ accounts: Array<{ balance: unknown; error?: string }> }>(
      'credits.balances', { provider: 'qoder' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts[0]!.balance).toBeNull()
    expect(result.value.accounts[0]!.error).toBe('余额查询失败')
  })

  it('额度端点 401 时如实报失败（不当成 0 余额，也不静默成功）', async () => {
    const h = createHarness(responder({
      quota: () => new Response(JSON.stringify({ error: 'unauthorized', message: 'TOKEN_EXPIRE' }), { status: 401 }),
    }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    const result = await h.call<{ accounts: Array<{ balance: unknown; error?: string }> }>(
      'credits.balances', { provider: 'qoder' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts[0]!.balance).toBeNull()
    expect(result.value.accounts[0]!.error).toBe('余额查询失败')
  })

  it('账号凭据缺失时该账号记 error，不中断其它账号', async () => {
    const h = createHarness(responder())
    const first = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-one' })
    const second = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-two' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // 删掉其中一个账号的凭据，模拟「凭据被外部清理」。
    const entries = await h.accounts('qoder')
    await h.credentials.unset(entries[0]!.credentialRef)

    const result = await h.call<{ accounts: Array<{ accountId: string; balance: unknown; error?: string }> }>(
      'credits.balances', { provider: 'qoder' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts).toHaveLength(2)
    expect(result.value.accounts[0]!.error).toBe('凭据未配置')
    // 第二个账号照常查到余额（单账号失败不中断整批）。
    expect(result.value.accounts[1]!.balance).not.toBeNull()
  })

  it('qoder 不被误判为不支持的 provider（余额有分支）；未知 provider 仍拒绝', async () => {
    const h = createHarness(responder())
    const known = await h.call('credits.balances', { provider: 'qoder' })
    expect(known.ok, JSON.stringify(known)).toBe(true)
    const unknown = await h.call('credits.balances', { provider: 'mystery' })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.error.message).toBe('unsupported provider: mystery')
  })
})

// ── 刻意**不**加分支的两个积分端点 ───────────────────────────────────────────

describe('credits.status / credits.claimAll —— qoder 刻意不加分支', () => {
  /**
   * Qoder **没有公开的签到 API**：官方每日 100 Credits 只能在 Qoder 桌面 App
   * 里手动领取。故宿主侧两个签到端点对 qoder 一律落到「不支持的 provider」，
   * 这是**正确契约**（与 CodeArts 的拒绝同源），不是待修的缺陷：
   * 客户端靠 `credits-capabilities.js` 的 `dailyCheckin: false` 在**发请求之前**
   * 就不发（`loadCredits` / `claimCredits` 各有一道守卫）。
   *
   * ⚠️ 若哪天有人给它们补上 qoder 分支，本组会立刻变红 —— 那正是需要的提醒：
   * 补分支的前提是先有一个**真实存在**的签到端点。
   */
  const METHODS = ['credits.status', 'credits.claimAll'] as const

  it.each(METHODS)('%s 对 qoder 回 unsupported provider（不加分支是刻意的）', async (method) => {
    const h = createHarness(() => new Response('{}', { status: 200 }))
    const result = await h.call(method, { provider: 'qoder' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('unsupported provider: qoder')
    // 拒绝发生在**发请求之前**：没有任何出网。
    expect(h.calls).toHaveLength(0)
  })

  it.each(METHODS)('%s 对未知 provider 的拒绝形态一致', async (method) => {
    const h = createHarness(() => new Response('{}', { status: 200 }))
    const result = await h.call(method, { provider: 'mystery' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('unsupported provider: mystery')
  })
})

// ── account.refresh 的 qoder 分支 ────────────────────────────────────────────

describe('account.refresh —— qoder 账号刷新自己的凭据 ref', () => {
  it('刷新的是**该账号的** credentialRef，不是默认单凭据 ref', async () => {
    // 这是本仓库被记录过的缺陷 2 的形态：原实现调 `service.refresh()`，而它
    // 读写的是该 provider 的**默认单凭据 ref**（对 Qoder 是
    // `QODER_PERSONAL_TOKEN`），Account Hub 账号卡片对应的却是
    // `QODER_ACCOUNT_XXX` —— 于是「刷新这个账号」实际刷的是另一个凭据。
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-abc123' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const entry = (await h.accounts('qoder'))[0]!
    const writesBefore = h.credentials.writes.length

    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: created.value.accountId },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.success).toBe(true)
    expect(result.value.error).toBeUndefined()
    // 凭据被**重写回同一个 ref**（而不是默认 ref，也不是别的账号的 ref）。
    expect(h.credentials.writes.slice(writesBefore)).toEqual([entry.credentialRef])
    // PAT 原样保留：续期是「重打 exchange 换新 jt」，不是换掉凭据本体。
    const stored = await h.credentials.resolve(entry.credentialRef)
    expect((JSON.parse(stored!.value) as QoderCredential).access_token).toBe('pt-abc123')
    // 刷新的确走的是 exchange（对 Qoder 而言就是重打它）。
    expect(h.calls.some((c) => c.url.includes('/api/v1/jobToken/exchange'))).toBe(true)
  })

  it('PAT 已失效时报失败（不抛 handler-failed，客户端能拿到原因）', async () => {
    // 建号那次 exchange 成功；把凭据存盘后**翻一个开关**，让之后的 refresh
    // （重打 exchange）回 401。这样分流不依赖调用次数计数 —— 计数分流在
    // 「谁先跑」上很脆。
    let patRejected = false
    const h = createHarness((call) => {
      if (!call.url.includes('/api/v1/jobToken/exchange')) return new Response('{}', { status: 200 })
      return patRejected
        ? new Response('{"error":"TOKEN_INVALID"}', { status: 401 })
        : new Response(exchangeBody(), { status: 200 })
    })
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-abc123' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    patRejected = true

    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: created.value.accountId },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // `account.refresh` 的既有契约：失败以 `{success:false, error}` 回报，
    // **不是** handler-failed —— 后者会让客户端按网络抖动处理。
    expect(result.value.success).toBe(false)
    expect(result.value.error).toBeTruthy()
    // 终态可读：告诉用户去做「重新粘贴」，而不是一个含糊的失败。
    expect(result.value.error).toContain('重新粘贴')
  })

  it('不存在的 accountId 走既有「账号不存在」路径（分支不是通配的）', async () => {
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: 'nobody-00000000' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.success).toBe(false)
    expect(result.value.error).toMatch(/not found/)
  })
})

// ── 恒等映射（qoder 不参与任何 provider 映射） ───────────────────────────────

describe('qoder 与账号池键的恒等性（与 trae-cn-work 互为反例）', () => {
  it('account.list 按 `qoder` 查池：账号拿得到，且没有发生映射', async () => {
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    const result = await h.call<{ accounts: ProviderAccountEntry[] }>('account.list', { provider: 'qoder' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    // 恒等映射的**可观测后果**：账号确实列得出来（若被映射到别处，池里
    // `provider === 'qoder'` 的条目一个都匹配不到，面板只是「尚未配置账号」，
    // 端点的 ok 仍是 true —— 静默失效）。
    expect(result.value.accounts).toHaveLength(1)
    expect(result.value.accounts[0]!.provider).toBe(QODER.id)
  })

  it('account.retestAll / account.resetAll 按 `qoder` 找账号（不落到空集）', async () => {
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-abc123' })

    // 两个端点都按 `poolProviderFor(req.provider)` 过滤；对 qoder 是恒等，
    // 故它们看到的就是上面那个账号（而不是空集）。
    for (const method of ['account.resetAll', 'account.retestAll']) {
      const result = await h.call<{ accounts?: unknown[] }>(method, { provider: 'qoder' })
      expect(result.ok, `${method}: ${JSON.stringify(result)}`).toBe(true)
    }
  })
})

// ── 客户端契约锚点（跨侧常量） ───────────────────────────────────────────────

describe('客户端 PAT 表单与宿主常量同值', () => {
  it('宿主 QODER_PAT_URL 与产品配置里的签发页一致', () => {
    // 客户端 bundle 不能 import 宿主 TS，故那里存的是**副本**；两处漂移的
    // 表现只是面板上的链接指向旧地址（用户点过去 404），**不报任何错**。
    // 客户端那一侧的字面量由 `tests/unit/qoder-hub-panel.spec.ts` 钉死，
    // 这里锁宿主这一侧的真相源。
    expect(QODER.patUrl).toBe(QODER_PAT_URL)
    expect(QODER.patUrl).toBe('https://qoder.com/account/integrations')
  })

  it('账号凭据 ref 前缀与 accountCredentialRefName 的机械派生一致', async () => {
    const h = createHarness(() => new Response(exchangeBody(), { status: 200 }))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-abc123' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const entry = (await h.accounts('qoder'))[0]!
    // `accountCredentialRefName('qoder', suffix)` = `QODER_ACCOUNT_<suffix>`。
    // 两处漂移的后果是「凭据写到一个名字、读的时候找另一个名字」——
    // 账号建得出来，但下一次请求就报「请先登录」。
    expect(entry.credentialRef.startsWith(`${QODER.accountCredentialRefPrefix}_`)).toBe(true)
  })
})
