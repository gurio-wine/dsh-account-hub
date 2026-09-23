/**
 * Qoder **CN（国内版）** 的 Account Hub RPC 分派回归测试（接入第二 region B 段）。
 *
 * ## 为什么单独一个文件（而不是并进 `qoder-rpc-dispatch.spec.ts`）
 *
 * 那个文件锁的是「Qoder 非浏览器登录形态」那组契约（非两段式、PAT 不回显…），
 * 本文件锁的是**另一件事**：**两个 region 的接线必须各走各的**。
 * 两者的断言有重叠但失效形态不同 —— 前者坏掉是「登录方式变了」，后者坏掉是
 * 「CN 的凭据/请求打到了国际版」，而后者**两个方向都不报错**（失败只表现为
 * 假的「PAT 失效」），正是最需要真实分派测试的那类缺陷。
 *
 * ## 三个 region 隔离点（每个都有用例钉死）
 *
 * | 隔离点 | 配错的后果 |
 * |---|---|
 * | `account.create` 选哪个 auth 实例 | 用国际版实例验 CN 的 PAT → 打到 `openapi.qoder.sh` |
 * | `credits.balances` 传哪份 product | 额度端点打到国际版 host → 401 → 「凭据失效」 |
 * | `account.refresh` 落到哪个分支 | 拿 CN 的 PAT 重打国际版 exchange |
 *
 * 第四点是**账号池本身**：两区的账号条目 `provider` 不同，故
 * `account.list` 天然不串 —— 但「天然」不等于「被验证过」，故也有用例。
 *
 * ## 替身边界
 *
 * 只有**出网**被替换（两个 `QoderAuth` 各注入同一个 fetcher 替身，按 host 分流）。
 * `QoderAuth`、`AccountPool`、RPC 处理器全部是真实实现 —— 这样「凭据落到哪个
 * ref」「账号条目的 provider 字段是什么」「请求打在哪个 host」这类**真实副作用**
 * 才是被断言的对象。
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

/** RPC 响应的判别联合（`reply()` 会给 error 补一个 `details`）。 */
type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

/** 最小化的内存凭据提供者，形状与 `ctx.credentials` 一致。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  /** 写入顺序（断言「凭据确实落到了本 region 的 ref 上」）。 */
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
  authorization: string
  /** 请求体原文（字符串 body 原样记录，其它形态记空串）。 */
  body: string
}

/** 判定一个 URL 是否属于 CN 的某个端点（host 含 `.com.cn`）。 */
function isCnHost(url: string): boolean {
  return url.includes('.qoder.com.cn')
}

/** 一次典型的 exchange 成功响应（`expires_in` 是**毫秒**）。 */
function exchangeBody(userId: string): string {
  return JSON.stringify({
    token: `jt-for-${userId}`,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    expires_in: 86_400_000,
    refresh_token: 'jrt-1',
    refresh_token_expires_in: 172_800_000,
    // `userId` 会被 `buildQoderCredential` 收进凭据的 `user_id`，再由
    // `loginWithPat` 拿去当账号昵称（有则用，否则回落到 accountId）。
    userId,
  })
}

/**
 * CN 的 quota 响应 fixture。
 *
 * ⚠️ **这是本文件的核心 fixture，形态按实测事实构造**：CN 只有
 * `userQuota` + `addOnQuota` 两池，**`orgResourcePackage` 键整个不存在**
 * （国际版那台账号同样缺席它，但两区缺席的原因不同 —— CN 是响应里根本没有
 * 这个键）。三池解析对缺席是容缺的（每个池独立解析），故这里断言的是
 * 「无需 CN 专属分支就能正确相加」。
 */
function cnQuotaBody(options: { user?: number; addOn?: number } = {}): string {
  const pool = (remaining: number) => ({
    total: 1000, used: 1000 - remaining, remaining, percentage: 50, unit: 'credits',
  })
  return JSON.stringify({
    userId: 'cn-user-1',
    userType: 'personal_standard',
    usageType: 'credits',
    totalUsagePercentage: 50,
    isQuotaExceeded: false,
    expiresAt: 253402214400000,
    upgradeUrl: 'https://qoder.cn/pricing?client=qodercn',
    userQuota: pool(options.user ?? 0),
    ...options.addOn === undefined ? {} : { addOnQuota: pool(options.addOn) },
    // ⚠️ 刻意**不给** orgResourcePackage：CN 响应里它整个不存在。
    isPlanQuotaProrated: false,
  })
}

interface Harness {
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  accounts(provider?: string): Promise<ProviderAccountEntry[]>
  credentials: FakeCredentials
  calls: CapturedCall[]
  teardown(): Promise<void>
}

const harnesses: Harness[] = []

/** 设备流用例建的临时 home 目录；afterEach 统一删除。 */
const tempHomes: string[] = []

/**
 * 构造 ctx / pool / **两个真实的 `QoderAuth` 实例** + 全局 fetch 替身并注册端点。
 *
 * 两个实例共用同一个 fetcher 替身，按 URL 的 host 分流 —— 这正是让
 * 「请求打到了哪个 region」成为**可断言事实**的手段：若 CN 分支误用了国际版
 * 实例，响应仍会 200（替身两个 host 都认），但 `calls` 里的 URL 会指向 `.sh`
 * 域名，下面的断言立刻揭穿它。
 */
function createHarness(responds: (call: CapturedCall) => Response | undefined): Harness {
  const credentials = new FakeCredentials()
  const calls: CapturedCall[] = []
  // ⚠️ **临时 home**：设备流会读写 `~/.qoder-cn/.auth/machine_id`，那是用户与
  // 官方 CN CLI **共用**的机器身份。不隔离就会污染用户真实环境。
  const homeDir = mkdtempSync(join(tmpdir(), 'qoder-cn-rpc-'))
  tempHomes.push(homeDir)

  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
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

  // 两个 region 各一个实例，服务名 `qoderAuth` / `qoderCnAuth` 互不冲突
  // （同一 Context 上可以共存 —— 这正是 `serviceName` 字段存在的意义）。
  const serviceCtx = new Context()
  serviceCtx.provide('credentials', credentials as never)
  // 设备流注入：临时 home（**绝不碰用户真实的 `~/.qoder-cn`**）+ 快速超时
  // （默认 5 分钟会让「等授权」的用例在真实时间里空转）。
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
    // 生产代码用**惰性注入**挂载端点（`connection` 只存在于 Web bundle）。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
  }

  registerAccountHubRpc(
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

// ── account.create 的 qoder-cn 分支 ──────────────────────────────────────────

describe('account.create —— qoder-cn 的 PAT 粘贴式登录', () => {
  it('同步完成：凭据落到 QODER_CN_ACCOUNT_*，账号 provider 为 qoder-cn', async () => {
    const h = createHarness(() => new Response(exchangeBody('cn-user-1'), { status: 200 }))
    const result = await h.call<{ accountId: string; loginUrl: string }>(
      'account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accountId).toMatch(/^qoder-cn-[0-9a-f]{8}$/)
    // 与另外七个 provider 同款：没有浏览器登录流程 ⇒ loginUrl 恒为空串。
    expect(result.value.loginUrl).toBe('')

    const entries = await h.accounts('qoder-cn')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.provider).toBe('qoder-cn')
    expect(entry.refreshable).toBe(true)
    // PAT 无本地可知的过期时间（jt 的 24h 只是运行时缓存），故**不写** expiresAt。
    expect(entry.expiresAt).toBeUndefined()
    expect(entry.nickname).toBe('cn-user-1')
    // ⚠️ 连字符转下划线的既有机制产出 `QODER_CN_ACCOUNT_*` —— 与产品配置的
    // `accountCredentialRefPrefix` 逐字符一致（那边有 `qoder-cn.spec.ts` 钉死）。
    expect(entry.credentialRef).toMatch(/^QODER_CN_ACCOUNT_[0-9A-F]{8}$/)

    // 凭据确实落在**账号自己的** ref 上，且是 CN 前缀（不是国际版的 QODER_ACCOUNT_*）。
    expect(h.credentials.writes).toEqual([entry.credentialRef])
    const stored = await h.credentials.resolve(entry.credentialRef)
    const credential = JSON.parse(stored!.value) as QoderCredential
    expect(credential.access_token).toBe('pt-cn-token')
  })

  /**
   * ⚠️ **本文件最重要的一条**：CN 的建号必须打在 **CN 的 exchange host** 上。
   *
   * 两个 region 是**两批互不相通的账号**，故 host 配错不会得到任何显式错误 ——
   * CN 的 PAT 打国际版端点回 401，而文案是「PAT 已失效或不被接受，请重新粘贴」。
   * 用户会去重签一张本来完全好用的凭据，而真因（打错了 host）彻底不可见。
   */
  it('exchange 打在 **CN 的 openapi host** 上（不是国际版的）', async () => {
    const h = createHarness(() => new Response(exchangeBody('cn-user-1'), { status: 200 }))
    const created = await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(created.ok).toBe(true)

    // 按 endpoint 过滤而不是按下标取：改号期新增的 userinfo 请求（取真实昵称）
    // 也在 CN 的 openapi host 上，按下标会让本用例断言到别的那一次。
    const exchanges = h.calls.filter((c) => c.url.includes('/api/v1/jobToken/exchange'))
    expect(exchanges).toHaveLength(1)
    const exchange = exchanges[0]!
    expect(exchange.url).toBe(`${QODER_CN.openapiBase}/api/v1/jobToken/exchange`)
    expect(exchange.url).toContain('openapi.qoder.com.cn')
    // 反向锚点：绝不能是国际版那个 host。
    expect(exchange.url).not.toContain('openapi.qoder.sh')
    expect(exchange.url).not.toBe(`${QODER.openapiBase}/api/v1/jobToken/exchange`)
    // 同理：userinfo（KYC 资料）也必须打 CN —— 两区令牌互不承认，
    // 打错 host 的失败形态是「昵称静默退回 UUID」，不报任何错。
    for (const call of h.calls) {
      expect(new URL(call.url).hostname, call.url).toMatch(/\.qoder\.com\.cn$/)
    }
  })

  it('载荷缺 pat 时按「PAT 格式不正确」拒绝，且一次网都不出', async () => {
    const h = createHarness(() => new Response(exchangeBody('x'), { status: 200 }))
    // ⚠️ `undefined`（键缺失）已**不属于**这一组：那是「走浏览器设备流」。
    // 这里只列**显式提交了非法 PAT 值**的形态，含空串与纯空白。
    for (const pat of ['', '   ', 'nope', 'dt-device-token']) {
      const result = await h.call<unknown>('account.create', { provider: 'qoder-cn', pat })
      expect(result.ok, JSON.stringify(pat)).toBe(false)
      if (result.ok) continue
      // 前缀校验是**本地**的 ⇒ 必须发生在 exchange 之前。
      expect(result.error.message).toContain('Qoder CN 登录失败')
      expect(result.error.message).toContain('PAT 格式不正确')
    }
    expect(h.calls).toHaveLength(0)
    // 失败是**终态**：没有占位账号、没有半成品凭据（与两段式那三个 provider
    // 不同 —— 这里没有「后台第二段」会去清理）。
    expect(await h.accounts('qoder-cn')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])
  })

  it('PAT 被服务端拒绝（401）时给出「重新粘贴」的可读原因', async () => {
    const h = createHarness(() => new Response(
      JSON.stringify({ errorCode: 'Unauthorized', message: 'TOKEN_INVALID' }), { status: 401 },
    ))
    const result = await h.call<unknown>('account.create', { provider: 'qoder-cn', pat: 'pt-revoked' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(h.calls).toHaveLength(1)
    expect(result.error.message).toContain('Qoder CN 登录失败')
    expect(result.error.message).toContain('重新粘贴')
    expect(await h.accounts('qoder-cn')).toHaveLength(0)
    expect(h.credentials.writes).toEqual([])
  })

  it('网络失败不判成「PAT 失效」—— 断网不该让用户重签凭据', async () => {
    const h = createHarness(() => undefined)
    const result = await h.call<unknown>('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Qoder CN 登录失败')
    // 判据是**不能出现**终态指引：那会让用户为一次断网白跑一趟签发页。
    expect(result.error.message).not.toContain('重新粘贴')
    expect(result.error.message).toContain('网络失败')
  })

  it('错误文案里绝不出现 PAT 本体', async () => {
    const secret = 'pt-cn-super-secret-never-echoed'
    const h = createHarness(() => new Response('{"error":"unauthorized"}', { status: 401 }))
    const result = await h.call<unknown>('account.create', { provider: 'qoder-cn', pat: secret })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).not.toContain(secret)
    expect(result.error.message).not.toContain('super-secret')
  })

  it('**国际版分支不受影响**：qoder 仍打国际版 host（反向锚点）', async () => {
    const h = createHarness(() => new Response(exchangeBody('intl-user'), { status: 200 }))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-intl' })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) return
    expect(created.value.accountId).toMatch(/^qoder-[0-9a-f]{8}$/)
    expect(h.calls[0]!.url).toBe(`${QODER.openapiBase}/api/v1/jobToken/exchange`)
    expect(h.calls[0]!.url).not.toContain('.com.cn')
    expect((await h.accounts('qoder'))[0]!.credentialRef).toMatch(/^QODER_ACCOUNT_[0-9A-F]{8}$/)
  })
})

// ── 账号池隔离（两批账号，不是同一批） ───────────────────────────────────────

describe('两个 region 的账号池**互相看不见**（两批账号，不是同一批）', () => {
  it('国际版账号不出现在 qoder-cn 列表里，反之亦然', async () => {
    const h = createHarness((call) => new Response(
      exchangeBody(isCnHost(call.url) ? 'cn-user' : 'intl-user'), { status: 200 },
    ))
    const intl = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-intl' })
    const cn = await h.call<{ accountId: string }>('account.create', { provider: 'qoder-cn', pat: 'pt-cn' })
    expect(intl.ok && cn.ok).toBe(true)
    if (!intl.ok || !cn.ok) return

    // 池里确实有两条账号条目，分属两个 provider。
    const all = await h.accounts()
    expect(all).toHaveLength(2)
    expect(all.map((a) => a.provider).sort()).toEqual(['qoder', 'qoder-cn'])
    // 凭据 ref 前缀也不同 —— 这是「删掉一个账号不会清掉另一个的凭据」的保证。
    expect(new Set(all.map((a) => a.credentialRef)).size).toBe(2)

    // `account.list` 按 provider 过滤：两个 region 各只见自己那一条。
    const intlList = await h.call<{ accounts: ProviderAccountEntry[] }>('account.list', { provider: 'qoder' })
    const cnList = await h.call<{ accounts: ProviderAccountEntry[] }>('account.list', { provider: 'qoder-cn' })
    expect(intlList.ok && cnList.ok).toBe(true)
    if (!intlList.ok || !cnList.ok) return
    expect(intlList.value.accounts.map((a) => a.id)).toEqual([intl.value.accountId])
    expect(cnList.value.accounts.map((a) => a.id)).toEqual([cn.value.accountId])
    expect(cnList.value.accounts[0]!.provider).toBe('qoder-cn')
  })

  it('`poolProviderFor` 对两个 region 都是恒等映射（CN **不**映射到 qoder）', async () => {
    // 两个 region 是**两批账号**，故必须**不**映射。若有人照抄「共享账号池」的
    // 写法把 qoder-cn 映射过去，CN 面板会列出国际版的账号，而适配器会拿 CN 的
    // 池键去查 —— 两个方向都不报错。
    const { poolProviderFor } = await import('../../src/account-hub-rpc.js')
    expect(poolProviderFor('qoder-cn')).toBe('qoder-cn')
    expect(poolProviderFor('qoder')).toBe('qoder')
  })
})

// ── credits.balances 的 qoder-cn 分支 ────────────────────────────────────────

describe('credits.balances —— qoder-cn 用 CN 的额度端点与两池 fixture', () => {
  /** 出网替身：exchange 与 quota 都认两个 host，便于暴露「打错 host」。 */
  function responder(options: { quota?: () => Response } = {}) {
    return (call: CapturedCall): Response => {
      if (call.url.includes('/api/v1/jobToken/exchange')) {
        return new Response(exchangeBody(isCnHost(call.url) ? 'cn-user' : 'intl-user'), { status: 200 })
      }
      if (call.url.includes('/api/v2/quota/usage')) {
        return options.quota === undefined ? new Response(cnQuotaBody(), { status: 200 }) : options.quota()
      }
      return new Response('not found', { status: 404 })
    }
  }

  it('CN 两池相加（userQuota 300 + addOnQuota 100 = 400），包名取池类型', async () => {
    const h = createHarness(responder({
      quota: () => new Response(cnQuotaBody({ user: 300, addOn: 100 }), { status: 200 }),
    }))
    const created = await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(created.ok).toBe(true)
    h.calls.length = 0  // 专注余额这一次的出网

    const result = await h.call<{
      accounts: Array<{
        balance: { total: number; packages: Array<{ name: string; remaining: number }>; expiredTotal: number } | null
        error?: string
      }>
    }>('credits.balances', { provider: 'qoder-cn' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts).toHaveLength(1)
    const account = result.value.accounts[0]!
    expect(account.error).toBeUndefined()
    expect(account.balance).not.toBeNull()
    // ⚠️ **缺席的 orgResourcePackage 按 0 计**：三池解析对「键不存在」是容缺的，
    // 故不需要任何 CN 专属分支 —— 这条断言就是那个结论的可执行证据。
    expect(account.balance!.total).toBe(400)
    expect(account.balance!.packages.map((pkg) => pkg.name)).toEqual(['主额度', '加量包'])
    expect(account.balance!.packages.map((pkg) => pkg.remaining)).toEqual([300, 100])
    expect(account.balance!.expiredTotal).toBe(0)
  })

  /**
   * ⚠️ **额度端点必须打 CN 的 openapi host，且用 CN 实例换来的 jt**。
   *
   * 两个 region 的 jt 互不承认（实测 CN 的 `jt-` 打国际版端点 401）。若这里
   * 误传国际版的 product 或 auth 实例，用户看到的是一张查不出余额的卡片，
   * 而真因是「打错了 region」。
   */
  it('额度端点打在 CN 的 openapi host 上，且 Bearer 是 CN 实例换来的 jt', async () => {
    const h = createHarness(responder({ quota: () => new Response(cnQuotaBody({ user: 300 }), { status: 200 }) }))
    await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    h.calls.length = 0
    await h.call('credits.balances', { provider: 'qoder-cn' })

    const quota = h.calls.find((c) => c.url.includes('/api/v2/quota/usage'))
    expect(quota).toBeDefined()
    expect(quota!.url).toBe(`${QODER_CN.openapiBase}/api/v2/quota/usage`)
    expect(quota!.url).toContain('openapi.qoder.com.cn')
    expect(quota!.url).not.toContain('openapi.qoder.sh')
    // 只认 jt（PAT 打它回 401 TOKEN_EXPIRE）。
    expect(quota!.authorization).toMatch(/^Bearer jt-/)
  })

  it('主池耗尽但加量包有余 ⇒ 报真实余额（「主池耗尽 ≠ 额度耗尽」对 CN 同样成立）', async () => {
    const h = createHarness(responder({
      quota: () => new Response(JSON.stringify({
        userId: 'cn-user', isQuotaExceeded: true, usageType: 'credits',
        userQuota: { total: 100, used: 100, remaining: 0, percentage: 100, unit: 'credits' },
        addOnQuota: { total: 50, used: 0, remaining: 50, percentage: 0, unit: 'credits' },
      }), { status: 200 }),
    }))
    await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })

    const result = await h.call<{ accounts: Array<{ balance: { total: number } | null }> }>(
      'credits.balances', { provider: 'qoder-cn' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts[0]!.balance!.total).toBe(50)
  })

  it('查不到余额时 balance 为 null + error，**不是** 0 积分', async () => {
    const h = createHarness(responder({
      quota: () => new Response(JSON.stringify({ unrelated: true }), { status: 200 }),
    }))
    await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })

    const result = await h.call<{ accounts: Array<{ balance: unknown; error?: string }> }>(
      'credits.balances', { provider: 'qoder-cn' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts[0]!.balance).toBeNull()
    expect(result.value.accounts[0]!.error).toBe('余额查询失败')
  })

  it('**只查本 region 的账号**：两区各建一个号，各自只拿到自己那一条', async () => {
    const h = createHarness(responder({
      quota: () => new Response(cnQuotaBody({ user: 300, addOn: 100 }), { status: 200 }),
    }))
    await h.call('account.create', { provider: 'qoder', pat: 'pt-intl' })
    await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn' })

    const cn = await h.call<{ accounts: Array<{ accountId: string; balance: unknown }> }>(
      'credits.balances', { provider: 'qoder-cn' },
    )
    const intl = await h.call<{ accounts: Array<{ accountId: string; balance: unknown }> }>(
      'credits.balances', { provider: 'qoder' },
    )
    expect(cn.ok && intl.ok).toBe(true)
    if (!cn.ok || !intl.ok) return
    // 各一条 —— 若哪天有人把两个 region 合成一个池，这里会变成 2。
    expect(cn.value.accounts).toHaveLength(1)
    expect(intl.value.accounts).toHaveLength(1)
    expect(cn.value.accounts[0]!.accountId).toMatch(/^qoder-cn-/)
    expect(intl.value.accounts[0]!.accountId).toMatch(/^qoder-/)
    expect(cn.value.accounts[0]!.accountId).not.toBe(intl.value.accounts[0]!.accountId)
  })

  it('qoder-cn 不被判为不支持的 provider；未知 provider 仍拒绝', async () => {
    const h = createHarness(responder())
    const known = await h.call('credits.balances', { provider: 'qoder-cn' })
    expect(known.ok, JSON.stringify(known)).toBe(true)
    const unknown = await h.call('credits.balances', { provider: 'mystery' })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.error.message).toBe('unsupported provider: mystery')
  })
})

// ── credits.status / credits.claimAll 的 qoder-cn 分支 ───────────────────────

/**
 * 签到对 `qoder-cn` 与 `qoder` 两个 region **都**接线（共用
 * `src/qoder-credits.ts` 一份实现、按传入的 product 现算 host）。CN 端点由
 * keylog 解密抓包解出并真机验收（2026-09-21），国际版同端点已真机探测
 * （2026-09-23）200、响应与 CN 逐字节同构。
 *
 * ⚠️ 本组用例的前身断言的是「**只有 CN 加分支、国际版刻意拒绝**」——
 * 那条契约已随国际版真机探测推翻（见 `credits-capabilities.spec.ts`）。
 * 现在守的是**替换后的契约**：
 *
 * 1. `qoder-cn` 被接受，且出网全部落在 **CN 的 host** 上（`/sash/…/campaigns`）；
 * 2. **国际版 `qoder` 在 `qoder-rpc-dispatch.spec.ts` 单独测**（走 `.qoder.sh`），
 *    本文件只锁 CN 侧的 host 不串；
 * 3. 幂等判据是响应体的 `replayed`，**不是** HTTP 200（重复领取同样回 200）。
 */
describe('credits.status / credits.claimAll —— qoder-cn 走 CN host 正常分派', () => {
  /** 一条真机形状的可领活动（`CLAIM_BENEFIT` + `CLAIMABLE`）。 */
  function claimableCampaign(): Record<string, unknown> {
    return {
      campaignId: '01a0bf8d-cn-1',
      campaignKey: 'act-20260921-308',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { amount: 100 },
    }
  }

  /**
   * 出网替身：exchange / 活动列表 / 领取三个端点，两区 host 都认。
   *
   * 「两个 host 都认」是刻意的 —— 若 CN 分支误用了国际版实例或 product，响应
   * 仍会 200，只有 `calls` 里的 URL 会揭穿它（下面每条用例都断言 host）。
   */
  function responder(options: { claim?: () => Response; campaigns?: () => Response } = {}) {
    return (call: CapturedCall): Response => {
      if (call.url.includes('/api/v1/jobToken/exchange')) {
        return new Response(exchangeBody(isCnHost(call.url) ? 'cn-user' : 'intl-user'), { status: 200 })
      }
      if (call.url.includes('/sash/api/v1/me/campaigns')) {
        // 领取是 POST（路径以 `/{campaignId}/claim` 结尾），列表是 GET。
        if (call.method === 'POST') {
          return options.claim?.() ?? new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
        }
        return options.campaigns?.() ?? new Response(JSON.stringify({
          showCampaign: true, claimable: true, campaigns: [claimableCampaign()],
        }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
  }

  /** 建一个 CN 账号（PAT 粘贴，即时完成），并清空出网记录。 */
  async function withCnAccount(h: Harness): Promise<void> {
    const created = await h.call('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    h.calls.length = 0
  }

  it('credits.status 对 qoder-cn 走 CN 的 sash 活动端点，并报「可领 100」', async () => {
    const h = createHarness(responder())
    await withCnAccount(h)

    const result = await h.call<{
      accounts: Array<{ accountId: string; status: { active: boolean; todayCheckedIn: boolean; dailyCredit: number } | null }>
    }>('credits.status', { provider: 'qoder-cn' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accounts).toHaveLength(1)
    expect(result.value.accounts[0]!.accountId).toMatch(/^qoder-cn-/)
    // ⚠️ `active` **恒为 true**：服务端在「今天已领」时会清空 campaigns，
    // 据此判 active:false 会把「今天已领」误报成「活动未开启」。
    expect(result.value.accounts[0]!.status).toMatchObject({
      active: true, todayCheckedIn: false, dailyCredit: 100,
    })

    const campaigns = h.calls.find((c) => c.url.includes('/sash/api/v1/me/campaigns'))
    expect(campaigns, `未打到活动端点：${JSON.stringify(h.calls)}`).toBeDefined()
    expect(campaigns!.url).toBe(`${QODER_CN.openapiBase}/sash/api/v1/me/campaigns`)
    expect(campaigns!.url).toContain('.qoder.com.cn')
    // 只认 jt（PAT 打它回 401 TOKEN_EXPIRE）。
    expect(campaigns!.authorization).toMatch(/^Bearer jt-/)
    // 整条链路（含 exchange）不得出现国际版 host。
    expect(h.calls.every((c) => !c.url.includes('.qoder.sh'))).toBe(true)
  })

  it('credits.claimAll 对 qoder-cn 领到 100 积分，且 claim 是**空 body 的 POST**', async () => {
    const h = createHarness(responder())
    await withCnAccount(h)

    const result = await h.call<{
      results: Array<{ accountId: string; outcome: { kind: string; credit?: number } }>
      summary: {
        claimed: number; totalCredit: number; alreadyClaimed: number; inactive: number
        unavailable: number; abnormal: number; undetermined: number; failed: number
      }
    }>('credits.claimAll', { provider: 'qoder-cn' })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.results[0]!.outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 七栏齐全（含 2026-09-24 新增的 abnormal / undetermined）。
    expect(result.value.summary).toEqual({
      claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 0,
    })

    const claim = h.calls.find((c) => c.method === 'POST' && c.url.includes('/claim'))
    expect(claim, `未发出 claim：${JSON.stringify(h.calls)}`).toBeDefined()
    expect(claim!.url).toBe(`${QODER_CN.openapiBase}/sash/api/v1/me/campaigns/01a0bf8d-cn-1/claim`)
    // ⚠️ 抓包实测 `content-length: 0` —— 发 `{}` 属未经验证的形态。
    expect(claim!.body).toBe('')
    // `precheckStatus: false`：claim 自带活动列表查询 ⇒ 只应有一次 GET。
    expect(h.calls.filter((c) => c.url.includes('/sash/api/v1/me/campaigns') && c.method === 'GET')).toHaveLength(1)
  })

  it('幂等判据是响应体的 `replayed`，不是 HTTP 200（重复领取归一为已领取）', async () => {
    // 实测：重复领取**同样回 200**，但 `replayed:true`、不含 `benefit`，
    // 且 `claimedAt` 是上一次领取的旧时间。只看状态码会误报「领取成功 +100」。
    const h = createHarness(responder({
      claim: () => new Response(JSON.stringify({ replayed: true, claimedAt: '2026-09-18T02:00:00Z' }), { status: 200 }),
    }))
    await withCnAccount(h)

    const result = await h.call<{ summary: Record<string, number> }>(
      'credits.claimAll', { provider: 'qoder-cn' },
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.summary).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 0,
    })
  })

  it('活动列表清空 ⇒ **undetermined**（不是 already-claimed、也不是 failed）', async () => {
    // ⚠️ 2026-09-24 修正：空列表既可能是「今天已领」（服务端清空了列表），也可能是
    // 「活动还没开始」。旧实现归一 `already-claimed` ⇒ 宿主写下签到状态 ⇒ 该账号
    // 整个周期不再被尝试，而它可能一分没领（真机调查确认的「qoder 假签到」）。
    // 现在报 `undetermined`：**不写状态** ⇒ 下一轮 sweep 自然重试。
    const h = createHarness(responder({
      campaigns: () => new Response(JSON.stringify({ showCampaign: false, claimable: false, campaigns: [] }), { status: 200 }),
    }))
    await withCnAccount(h)

    const result = await h.call<{
      results: Array<{ outcome: { kind: string; message: string } }>
      summary: Record<string, number>
    }>('credits.claimAll', { provider: 'qoder-cn' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.results[0]!.outcome.kind).toBe('undetermined')
    // 三栏都不能收留它：既不是已领（会伪造签到），也不是失败（用户无事可做）。
    expect(result.value.summary).toMatchObject({
      alreadyClaimed: 0, failed: 0, undetermined: 1, claimed: 0,
    })
    // 无可领活动 ⇒ 一次 claim 都不发。
    expect(h.calls.some((c) => c.method === 'POST' && c.url.includes('/claim'))).toBe(false)
  })

  const METHODS = ['credits.status', 'credits.claimAll'] as const

  it.each(METHODS)('%s 对未知 provider 的拒绝形态一致', async (method) => {
    // 未知 provider（不是 qoder / qoder-cn）才回 unsupported provider。
    const h = createHarness(() => new Response('{}', { status: 200 }))
    const result = await h.call(method, { provider: 'mystery' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('unsupported provider: mystery')
  })
})

// ── account.refresh 的 qoder-cn 分支 ─────────────────────────────────────────

describe('account.refresh —— qoder-cn 账号刷新自己的 ref，且打 CN 的 exchange', () => {
  it('刷新的是**该账号的** CN credentialRef，且 exchange 打在 CN host', async () => {
    // 失效形态（本仓库记录过的缺陷 2 的 region 版本）：落到国际版分支会让
    // 「刷新」拿 CN 的 PAT 重打 `openapi.qoder.sh`，回报「PAT 已失效」——
    // 而那张 PAT 完全好用。
    const h = createHarness((call) => new Response(
      exchangeBody(isCnHost(call.url) ? 'cn-user' : 'intl-user'), { status: 200 },
    ))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const entry = (await h.accounts('qoder-cn'))[0]!
    const writesBefore = h.credentials.writes.length
    h.calls.length = 0

    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: created.value.accountId },
    )

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.success).toBe(true)
    expect(result.value.error).toBeUndefined()
    // 凭据被**重写回同一个 ref**（不是默认 ref，也不是另一区的 ref）。
    expect(h.credentials.writes.slice(writesBefore)).toEqual([entry.credentialRef])
    // PAT 原样保留（续期 = 重打 exchange 换新 jt，不是换凭据本体）。
    const stored = await h.credentials.resolve(entry.credentialRef)
    expect((JSON.parse(stored!.value) as QoderCredential).access_token).toBe('pt-cn-token')
    // ⚠️ 刷新打的是 **CN** 的 exchange host。
    const refresh = h.calls.find((c) => c.url.includes('/api/v1/jobToken/exchange'))
    expect(refresh).toBeDefined()
    expect(refresh!.url).toBe(`${QODER_CN.openapiBase}/api/v1/jobToken/exchange`)
    expect(refresh!.url).not.toContain('openapi.qoder.sh')
  })

  it('PAT 已失效时报失败（不抛 handler-failed，客户端能拿到原因）', async () => {
    let patRejected = false
    const h = createHarness((call) => {
      if (!call.url.includes('/api/v1/jobToken/exchange')) return new Response('{}', { status: 200 })
      return patRejected
        ? new Response('{"error":"TOKEN_INVALID"}', { status: 401 })
        : new Response(exchangeBody('cn-user'), { status: 200 })
    })
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder-cn', pat: 'pt-cn-token' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    patRejected = true

    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: created.value.accountId },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.success).toBe(false)
    expect(result.value.error).toBeTruthy()
    expect(result.value.error).toContain('重新粘贴')
  })

  it('国际版账号仍走国际版分支（反向锚点：两个 region 各刷各的）', async () => {
    const h = createHarness((call) => new Response(
      exchangeBody(isCnHost(call.url) ? 'cn-user' : 'intl-user'), { status: 200 },
    ))
    const created = await h.call<{ accountId: string }>('account.create', { provider: 'qoder', pat: 'pt-intl' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    h.calls.length = 0

    const result = await h.call<{ success: boolean }>('account.refresh', { accountId: created.value.accountId })
    expect(result.ok && result.value.success).toBe(true)
    const refresh = h.calls.find((c) => c.url.includes('/api/v1/jobToken/exchange'))
    expect(refresh!.url).toBe(`${QODER.openapiBase}/api/v1/jobToken/exchange`)
    expect(refresh!.url).not.toContain('.com.cn')
  })

  it('不存在的 accountId 走既有「账号不存在」路径（CN 分支不是通配的）', async () => {
    const h = createHarness(() => new Response(exchangeBody('x'), { status: 200 }))
    const result = await h.call<{ success: boolean; error?: string }>(
      'account.refresh', { accountId: 'nobody-00000000' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.success).toBe(false)
    expect(result.value.error).toMatch(/not found/)
  })
})

// ── 模型黑名单与重测/重置的池键 ──────────────────────────────────────────────

describe('model.list / model.setDisabled / retestAll / resetAll 用 qoder-cn 键', () => {
  /**
   * 黑名单按 provider id 存，**两个 region 必须是两个键**：两池模型不重合
   * （CN 目录 14 项里没有 `ultimate` / `performance` / `lite`，却有
   * `q37fmodel` / `gm51model`），合用一个键会让在 CN 关掉的模型在国际版也消失。
   */
  function modelHarness() {
    const listModelsCalls: string[] = []
    const listDisabledCalls: string[] = []
    const listByProviderCalls: string[] = []
    const setModelDisabledCalls: Array<{ provider: string; modelId: string; disabled: boolean }> = []
    let handler: ((request: Request) => Promise<Response>) | undefined
    const ctx: Record<string, unknown> = {
      connection: { fetch: { register: (c: { fetch: (r: Request) => Promise<Response> }) => { handler = c.fetch } } },
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: (name: string) => name === 'llm'
        ? {
            listModels: async (provider: string) => {
              listModelsCalls.push(provider)
              return [{ id: 'qmodel_38max', name: 'Qwen3.8-Max' }]
            },
          }
        : undefined,
    }
    const pool = {
      listAccounts: async () => [],
      listAllAccounts: async () => [],
      // `account.retestAll` / `account.resetAll` 走的是 `account-probe` 的
      // `pool.listAccountsByProvider`（**同步**返回，不是 async）—— 替身漏了它
      // 会以 `is not a function` 被包成 handler-failed，看起来像是「池键传错了」。
      listAccountsByProvider: (provider: string) => { listByProviderCalls.push(provider); return [] },
      listDisabledModels: (provider: string) => { listDisabledCalls.push(provider); return {} },
      setModelDisabled: async (provider: string, modelId: string, disabled: boolean) => {
        setModelDisabledCalls.push({ provider, modelId, disabled })
      },
    }
    registerAccountHubRpc(
      ctx as never, pool as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')
    return {
      listModelsCalls,
      listDisabledCalls,
      listByProviderCalls,
      setModelDisabledCalls,
      call: async (method: string, payload: unknown) => {
        const response = await handler!(new Request('http://127.0.0.1/api/account-hub', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId: 'r1', method: 'account-hub', payload: { method, payload },
          }),
        }))
        const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
        return body.result
      },
    }
  }

  it('model.list 把 `qoder-cn` 原样透传给 ctx.llm，黑名单也读同一个键', async () => {
    const h = modelHarness()
    const result = await h.call('model.list', { provider: 'qoder-cn' })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.listModelsCalls).toEqual(['qoder-cn'])
    expect(h.listDisabledCalls).toEqual(['qoder-cn'])
  })

  it('model.setDisabled 写入 `qoder-cn` 键（不写进国际版的黑名单）', async () => {
    const h = modelHarness()
    const result = await h.call('model.setDisabled', {
      provider: 'qoder-cn', modelId: 'qmodel_38max', disabled: true,
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.setModelDisabledCalls).toEqual([
      { provider: 'qoder-cn', modelId: 'qmodel_38max', disabled: true },
    ])
  })

  it('account.retestAll / account.resetAll 对 qoder-cn 是恒等（不落到空集或别区）', async () => {
    const h = modelHarness()
    for (const method of ['account.resetAll', 'account.retestAll']) {
      const result = await h.call<{ accounts?: unknown[] }>(method, { provider: 'qoder-cn' })
      expect(result.ok, `${method}: ${JSON.stringify(result)}`).toBe(true)
    }
    // ⚠️ 这条才是本用例的**判据**：`ok: true` 对空集也成立（端点只是回一个空
    // 结果），故必须断言池**按 `qoder-cn` 查** —— 若有人把它映射到 `qoder`，
    // CN 面板的重测/重置会作用到国际版账号上，
    // 而端点仍回 ok: true，界面看不出任何异常。
    expect(h.listByProviderCalls).toEqual(['qoder-cn', 'qoder-cn'])
  })
})

// ── 跨侧常量锚点 ─────────────────────────────────────────────────────────────

describe('CN 的产品常量与账号 ref 前缀', () => {
  it('账号凭据 ref 前缀与 accountCredentialRefName 的机械派生一致', async () => {
    const { accountCredentialRefName } = await import('../../src/account-hub-rpc.js')
    // 带连字符的 provider id 会被 `toUpperCase().replace(/-/g,'_')` 归一化 ——
    // 两处漂移的后果是「凭据写到一个名字、读的时候找另一个名字」：账号建得出来，
    // 但下一次请求就报「请先登录」。
    expect(accountCredentialRefName(QODER_CN.id, 'A1B2C3D4')).toBe('QODER_CN_ACCOUNT_A1B2C3D4')
    expect(accountCredentialRefName(QODER_CN.id, 'A1B2C3D4'))
      .toBe(`${QODER_CN.accountCredentialRefPrefix}_A1B2C3D4`)
  })

  it('默认凭据 ref 是 CN 专属（不与国际版共用）', () => {
    expect(QODER_CN.defaultCredentialRef).toBe('QODER_CN_PERSONAL_TOKEN')
    expect(QODER_CN.defaultCredentialRef).not.toBe(QODER.defaultCredentialRef)
  })
})
