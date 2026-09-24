/**
 * 登录链**凭据归属校验**的回归测试。
 *
 * ## 本文件守的是什么（本次要堵的缺口）
 *
 * 旧行为：`account.create` 的后台第二段拿到 `flow.access` 就无条件
 * `ctx.credentials.set(ref, …)`。当用户在 **CN 面板**发起登录、而浏览器里
 * 仍是**国际版**会话时，服务端返回的是国际版令牌 —— 它被原样写进
 * `BUDDY_CN_ACCOUNT_*`，池里随即多出一条「标签 buddy-cn、内容 buddy」的账号。
 *
 * 更早的历史事故链（见 `src/provider-audit-migration.ts` 模块头）已经证明这类
 * 错配会**长期存活**：清理逻辑直接删号 + 孤儿 ref 复用，最终让国际 token 静静
 * 躺在 CN 池里。本次的修法是在**凭据产出点**设闸门，而不是事后体检。
 *
 * 两组不变量：
 *
 * 1. **正常登录逐字节不受影响** —— 归属正确（`iss`/`domain` 都属于本产品）时
 *    `runBuddyLoginFlow` 的返回与今天完全一致，且 `account.create` 照常写凭据、
 *    照常补全占位条目。闸门不许对正常路径产生任何副作用。
 * 2. **错配被拒且不留痕** —— 占位条目被移除、凭据**一个字都不写**、
 *    `login.poll` 回报可展示的中文原因（说清「属于谁」与「该去哪儿登录」）。
 *
 * ## 为什么这里用「真流程 + 假网络」而不是打桩 `runBuddyLoginFlow`
 *
 * 闸门就在 `runBuddyLoginFlow` 内部（buddy 系唯一的凭据产出点）。若把它整个
 * 打桩掉，被测的恰好是**被替换掉的那一段** —— 用例会全绿而缺口仍在。
 * 故这里只把**出网**换成替身（stub 全局 `fetch`），登录流程本身是真实实现：
 * `account.create` → `runBuddyLoginFlow` → 归属闸门 → 调用方写凭据。
 *
 * ⚠️ `fetchAuthState` / `loopGetToken` / `getAccount` 的默认 fetcher 是
 * **调用时**读取的全局 `fetch`，故 `vi.stubGlobal('fetch', …)` 能覆盖它们 ——
 * 这也正是本文件不打桩任何模块的原因。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import {
  CredentialProductMismatchError,
  PROVIDER_ISSUER_PATTERNS,
  assertCredentialOwnership,
  issuerPatternsFor,
  judgeCredentialOwnership,
} from '../../src/credential-ownership.js'
import { BUDDY, BUDDY_CN } from '../../src/product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// ── 判据取材（真实取值，勿改成编造值） ──────────────────────────────────────
//
// 两个签发方取自现场铁证（与 `provider-audit-migration.spec.ts` 同一组常量）：
// 国际版令牌 `iss` 指 `www.workbuddy.ai`，中国版指 `www.codebuddy.cn`。
// 注意中国版的登录站与 API 端点**不是同一个域**（见 `src/buddy.ts` 的 WEBSITE_HOME）。
const INTL_ISSUER = 'https://www.workbuddy.ai/auth/realms/copilot'
const CN_ISSUER = 'https://www.codebuddy.cn/auth/realms/copilot'

/** 造一个「只用于本地归类」的 JWT：`header.payload.signature`，payload 带 iss。 */
function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature-not-verified`
}

/** 一份凭据 JSON（`access_token` 是真的 JWT，`iss` 可控）。 */
function makeCredential(options: { iss?: string; domain?: string } = {}): string {
  const claims: Record<string, unknown> = { exp: 1_900_000_000, nickname: '测试号' }
  if (options.iss !== undefined) claims.iss = options.iss
  return JSON.stringify({
    access_token: makeJwt(claims),
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    domain: options.domain ?? 'copilot.tencent.com',
  })
}

// ── 判据本体（纯函数） ──────────────────────────────────────────────────────

describe('judgeCredentialOwnership —— 两级判据（iss 优先、domain 回退）', () => {
  it('iss 命中即定归属，判据来源标为 iss', () => {
    expect(judgeCredentialOwnership({ access_token: makeJwt({ iss: INTL_ISSUER }) }))
      .toEqual({ productId: 'buddy', judgedBy: 'iss' })
    expect(judgeCredentialOwnership({ access_token: makeJwt({ iss: CN_ISSUER }) }))
      .toEqual({ productId: 'buddy-cn', judgedBy: 'iss' })
  })

  it('无 iss 时回退 domain，判据来源标为 domain', () => {
    // 老令牌没有 iss：只能按凭据记录的 domain 判。
    expect(judgeCredentialOwnership({ access_token: makeJwt({}), domain: 'www.workbuddy.ai' }))
      .toEqual({ productId: 'buddy', judgedBy: 'domain' })
    // `www.` 变体同样接受（两个方向的写法都要认）。
    expect(judgeCredentialOwnership({ access_token: makeJwt({}), domain: 'copilot.tencent.com' }))
      .toEqual({ productId: 'buddy-cn', judgedBy: 'domain' })
  })

  /**
   * 这条是本次修复的**核心判据**：`iss` 是签发方（写死在令牌里），`domain` 只是
   * 登录时的字段快照、历史迁移漏改过它。
   *
   * 危险场景正是「CN 面板登录、浏览器里是国际版会话」：服务端可能把 `domain`
   * 回成 CN 的样子（请求就是打到 CN 的），而令牌真正的签发方是国际版。
   * 若判据信 `domain`，这次修复就形同虚设 —— 故必须 `iss` 优先。
   */
  it('iss 与 domain 矛盾时以 iss 为准（domain 伪装成本产品也不放行）', () => {
    expect(judgeCredentialOwnership({
      access_token: makeJwt({ iss: INTL_ISSUER }),
      domain: 'copilot.tencent.com',
    })).toEqual({ productId: 'buddy', judgedBy: 'iss' })
  })

  it('已解码的 issuer 字段在没有 JWT 时也能作为判据', () => {
    // 凭据可能来自「已解出 iss」的调用方（体检迁移就是这条形态）。
    expect(judgeCredentialOwnership({ issuer: INTL_ISSUER }))
      .toEqual({ productId: 'buddy', judgedBy: 'iss' })
  })

  it('两级都说不清时返回 undefined（不猜）', () => {
    expect(judgeCredentialOwnership({ access_token: makeJwt({}), domain: '' })).toBeUndefined()
    expect(judgeCredentialOwnership({ access_token: 'not-a-jwt', domain: 'internal.corp.example' }))
      .toBeUndefined()
    expect(judgeCredentialOwnership({})).toBeUndefined()
  })
})

describe('assertCredentialOwnership —— 闸门的放行 / 拒绝面', () => {
  it('归属一致时返回结论、不抛（正常登录零副作用）', () => {
    expect(assertCredentialOwnership(BUDDY_CN, { access_token: makeJwt({ iss: CN_ISSUER }) }))
      .toEqual({ productId: 'buddy-cn', judgedBy: 'iss' })
    expect(assertCredentialOwnership(BUDDY, { access_token: makeJwt({ iss: INTL_ISSUER }) }))
      .toEqual({ productId: 'buddy', judgedBy: 'iss' })
  })

  it('中国版也认「API 端点域」的签发方（登录站 ≠ API 端点）', () => {
    // copilot.tencent.com 与 www.codebuddy.cn 都属于 buddy-cn，两个都不能误拒。
    expect(() => assertCredentialOwnership(BUDDY_CN, { access_token: makeJwt({ iss: 'https://copilot.tencent.com/auth/realms/copilot' }) }))
      .not.toThrow()
  })

  it('错配时抛 CredentialProductMismatchError，消息说清「属于谁」与「去哪儿登录」', () => {
    let caught: unknown
    try {
      assertCredentialOwnership(BUDDY_CN, { access_token: makeJwt({ iss: INTL_ISSUER }) })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CredentialProductMismatchError)
    const mismatch = caught as CredentialProductMismatchError
    expect(mismatch.expectedProductId).toBe('buddy-cn')
    expect(mismatch.actualProductId).toBe('buddy')
    expect(mismatch.judgedBy).toBe('iss')
    // 文案是**可直接展示**的中文（客户端把 login.poll 的 error 原样渲染）。
    expect(mismatch.message).toContain('属于另一个产品')
    expect(mismatch.message).toContain('Buddy')
    expect(mismatch.message).toContain('面板登录')
  })

  /**
   * 失败开放（fail-open）是**刻意**的，不是漏判。
   *
   * 判不了 = 证据缺失（老令牌、后端改响应、内网代理域……），不是「确凿属于别人」。
   * 此时拒写会把所有这类正常登录一并打死，代价远大于它要防的问题。
   */
  it('判不出归属时放行（证据缺失 ≠ 错配）', () => {
    expect(() => assertCredentialOwnership(BUDDY_CN, { access_token: makeJwt({}), domain: '' }))
      .not.toThrow()
    expect(() => assertCredentialOwnership(BUDDY, { access_token: 'opaque-token' }))
      .not.toThrow()
  })

  it('判据表只覆盖 buddy 系（其余 provider 无可靠判据，故不校验）', () => {
    expect(PROVIDER_ISSUER_PATTERNS.map((entry) => entry.productId).sort()).toEqual(['buddy', 'buddy-cn'])
    for (const provider of ['codearts', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn']) {
      expect(issuerPatternsFor(provider)).toBeUndefined()
    }
  })
})

// ── 真实登录流程里的闸门 ────────────────────────────────────────────────────

const STATE = 'state-abc'

/** 一次登录的三段响应；`iss` / `domain` 决定这份凭据会被判成谁。 */
function loginFetcher(options: { iss?: string; domain?: string } = {}): typeof fetch {
  const credential = JSON.parse(makeCredential(options)) as Record<string, unknown>
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/v2/plugin/auth/state')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { state: STATE, authUrl: 'https://example.test/login?state=S' },
      }), { status: 200 })
    }
    if (url.includes('/v2/plugin/auth/token')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          accessToken: credential.access_token,
          refreshToken: 'RT',
          expiresAt: String(Date.now() + 3_600_000),
          tokenType: 'Bearer',
          scope: '',
          domain: credential.domain,
        },
      }), { status: 200 })
    }
    if (url.includes('/v2/plugin/login/account')) {
      return new Response(JSON.stringify({
        code: 0, data: { uid: 'u1', nickname: '昵称', enterpriseId: '', type: 'personal' },
      }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

/** 驱动一次真实 `runBuddyLoginFlow`（出网换成替身、浏览器打开为空实现）。 */
function runFlow(product: typeof BUDDY_CN | typeof BUDDY, options: { iss?: string; domain?: string } = {}) {
  return runBuddyLoginFlow({
    fetcher: loginFetcher(options),
    pollIntervalMs: 0,
    openBrowser: () => {},
    product,
  })
}

describe('runBuddyLoginFlow —— 凭据产出点的归属闸门', () => {
  it('归属正确时正常返回（国际版与 CN 各一条，逐字段不因闸门改变）', async () => {
    const intl = await runFlow(BUDDY, { iss: INTL_ISSUER, domain: 'www.workbuddy.ai' })
    expect(intl.refreshable).toBe(true)
    expect((JSON.parse(intl.access) as { access_token: string }).access_token.length).toBeGreaterThan(0)

    const cn = await runFlow(BUDDY_CN, { iss: CN_ISSUER, domain: 'copilot.tencent.com' })
    expect(cn.refreshable).toBe(true)
    expect(cn.expires).toBeGreaterThan(Date.now())
  })

  it('CN 面板拿到国际版令牌 → 抛错（这正是被堵住的缺口）', async () => {
    await expect(runFlow(BUDDY_CN, { iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }))
      .rejects.toThrow(CredentialProductMismatchError)
  })

  it('国际版面板拿到 CN 令牌 → 反向同样被拒', async () => {
    await expect(runFlow(BUDDY, { iss: CN_ISSUER, domain: 'copilot.tencent.com' }))
      .rejects.toThrow(CredentialProductMismatchError)
  })

  it('判不出归属的凭据仍按旧行为放行（不新增拒绝路径）', async () => {
    // 无 iss、domain 也不认识：闸门必须放行，否则会误伤所有这类正常登录。
    const result = await runFlow(BUDDY_CN, { domain: 'internal.corp.example' })
    expect(result.loginUrl.length).toBeGreaterThan(0)
  })
})

// ── account.create 端到端：占位移除 + 凭据不写 + 错误回传 ────────────────────

/** RPC 响应的判别联合（`reply()` 会给 error 补一个 `details`）。 */
type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

/** 最小化的内存凭据提供者，形状与 `ctx.credentials` 一致。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  /** 写入过的 ref 序列（断言「错配时一个字都不写」）。 */
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

interface CreateHarness {
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  entries(): Promise<ProviderAccountEntry[]>
  credentials: FakeCredentials
  /** 清掉本用例创建的服务，避免续期定时器泄漏。 */
  teardown(): void
}

/**
 * 建一个**不打桩 buddy-oauth** 的 account.create 环境。
 *
 * 与 `account-hub-rpc-account-create.spec.ts` 的关键差异：那边把
 * `runBuddyLoginFlow` 整个打桩（它测的是两段式的编排），这边要测的是**闸门
 * 本体**，故登录流程必须是真实实现 —— 只把出网换成 `vi.stubGlobal('fetch', …)`。
 */
function createCreateHarness(): CreateHarness {
  const credentials = new FakeCredentials()
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
  const buddyCn = new BuddyAuth(serviceCtx, { product: BUDDY_CN })
  const buddy = new BuddyAuth(serviceCtx, { product: BUDDY })

  let handler: ((request: Request) => Promise<Response>) | undefined
  const rpcCtx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (options: { fetch: (request: Request) => Promise<Response> }) => {
          handler = options.fetch
        },
      },
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
  }

  // 只驱动 buddy 系分支，其余 provider 的服务传空对象：若哪天 buddy 分支默认
  // 落到别家实现，这里会立刻以 `Cannot read properties of undefined` 暴露。
  registerAccountHubRpc({
    ctx: rpcCtx as never,
    pool,
    codearts: {} as never,
    buddyCn,
    buddy,
    lobsterai: {} as never,
    traeCn: {} as never,
    qoder: {} as never,
    qoderCn: {} as never,
  })
  if (handler === undefined) throw new Error('account.create 端点未注册')

  return {
    async call<T>(method: string, payload: unknown): Promise<RpcResult<T>> {
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
    },
    entries: () => pool.listAllAccounts(),
    credentials,
    teardown() {
      buddyCn.stop()
      buddy.stop()
    },
  }
}

const harnesses: CreateHarness[] = []

function makeCreateHarness(): CreateHarness {
  const harness = createCreateHarness()
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses) harness.teardown()
  harnesses.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('account.create —— CN 面板 + 国际版会话（端到端）', () => {
  /**
   * 后台第二段会真实轮询（两次 `sleep(POLL_INTERVAL_MS)`），故等待窗口给足。
   * 这不是慢在断言上，而是慢在登录流程自带的 1s 轮询间隔 —— 为忠实覆盖真流程
   * 而付的代价。
   */
  const BACKGROUND_TIMEOUT_MS = 15_000

  it('国际版令牌不会落进 CN 池：占位移除 + 凭据零写入 + login.poll 回报原因', async () => {
    vi.stubGlobal('fetch', loginFetcher({ iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }))
    const harness = makeCreateHarness()

    const created = await harness.call<{ accountId: string; loginUrl: string }>(
      'account.create', { provider: 'buddy-cn' },
    )
    // 第一段照旧立即成功返回（闸门在后台第二段，不阻塞开窗）。
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) return
    const accountId = created.value.accountId

    // 等后台第二段跑完：占位条目被移除（登录失败是终态）。
    await vi.waitFor(async () => {
      expect(await harness.entries()).toHaveLength(0)
    }, { timeout: BACKGROUND_TIMEOUT_MS })

    // ① 凭据**一个字都没写** —— 这是本缺口最关键的断言。
    expect(harness.credentials.writes).toEqual([])

    // ② 客户端拿到可展示的中文原因（说清属于谁、该去哪儿登录）。
    const poll = await harness.call<{ done: boolean; success?: boolean; error?: string }>(
      'login.poll', { accountId, provider: 'buddy-cn' },
    )
    expect(poll.ok, JSON.stringify(poll)).toBe(true)
    if (!poll.ok) return
    expect(poll.value.done).toBe(true)
    expect(poll.value.success).toBeUndefined()
    expect(poll.value.error).toContain('属于另一个产品')
    expect(poll.value.error).toContain('Buddy')
    expect(poll.value.error).toContain('面板登录')
  })

  it('domain 伪装成本产品也拦得住（iss 才是签发方）', async () => {
    // 服务端把 domain 回成 CN 的样子，但令牌真正的签发方是国际版。
    vi.stubGlobal('fetch', loginFetcher({ iss: INTL_ISSUER, domain: 'copilot.tencent.com' }))
    const harness = makeCreateHarness()

    const created = await harness.call<{ accountId: string }>('account.create', { provider: 'buddy-cn' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await vi.waitFor(async () => {
      expect(await harness.entries()).toHaveLength(0)
    }, { timeout: BACKGROUND_TIMEOUT_MS })
    expect(harness.credentials.writes).toEqual([])
  })

  it('对照：归属正确时占位条目被正常补全、凭据落在自己的池里', async () => {
    vi.stubGlobal('fetch', loginFetcher({ iss: CN_ISSUER, domain: 'copilot.tencent.com' }))
    const harness = makeCreateHarness()

    const created = await harness.call<{ accountId: string }>('account.create', { provider: 'buddy-cn' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // ⚠️ 判据必须是 `refreshable === true`（第二段补全后的形态），**不能**只等
    // `length === 1` —— 占位条目在第一段就已落池，那条断言会在后台跑完之前
    // 立刻通过，随后读到的是还没有凭据的占位形态（本条用例初版正是这么挂的）。
    await vi.waitFor(async () => {
      const entries = await harness.entries()
      expect(entries.some((e) => e.refreshable === true)).toBe(true)
    }, { timeout: BACKGROUND_TIMEOUT_MS })

    const entry = (await harness.entries())[0]!
    expect(entry.provider).toBe('buddy-cn')
    expect(entry.refreshable).toBe(true)
    expect(entry.nickname).toBe('昵称')
    // 凭据写到了该账号自己的 ref 上（闸门对正常路径零副作用）。
    expect(harness.credentials.writes).toEqual([entry.credentialRef])
    await vi.waitFor(async () => {
      const poll = await harness.call<{ done: boolean; success?: boolean; error?: string }>(
        'login.poll', { accountId: created.value.accountId, provider: 'buddy-cn' },
      )
      expect(poll.ok && poll.value.done).toBe(true)
      if (poll.ok) {
        expect(poll.value.success).toBe(true)
        expect(poll.value.error).toBeUndefined()
      }
    }, { timeout: BACKGROUND_TIMEOUT_MS })
  })
})
