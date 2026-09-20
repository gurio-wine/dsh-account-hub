/**
 * `account.create` RPC 的回归测试（此前**零覆盖** —— grep 全仓库无命中）。
 *
 * ## 为什么单独一个文件
 *
 * 这条 RPC 是「两段式登录」的**第一段**，也是客户端「+ 新建账号」按钮的唯一
 * 后端入口。它同时承担四件容易各自出错、又必须一起成立的事：
 *
 * 1. **立即返回 `loginUrl`**（不阻塞在浏览器登录上）—— 宿主侧刚为此改造过
 *    （commit 00eef2e / be796bb）。若哪天有人把 `await login(...)` 加回来，
 *    用户手势会在 RPC 返回前过期，客户端只能自行兜底开窗。
 * 2. **先落占位条目**（`refreshable: false`、无 `expiresAt`）—— 这是
 *    `login.poll` 的检测对象，也是「登录失败时不留幽灵账号」的前提。
 * 3. **后台第二段补全同一条账号**（写凭据 → 补 `nickname`/`expiresAt`/
 *    `refreshable`），时序必须「先凭据、后账号」，否则轮询会在凭据就绪前报成功。
 * 4. **provider 级互斥**（lobsterai / codearts）：已有未结算会话时返回
 *    `{ok:false, error:'login-in-progress'}`，**不新建监听也不复用旧会话**。
 *
 * 这四条都不在 `collect*` 那类纯函数上，只能通过驱动真实注册的 HTTP 处理器
 * 才能验证 —— 因此本文件用「真实 AccountPool + 真实 Auth 服务 + 真实回调
 * 服务器」的组合，只把**出网**与**浏览器打开**换成替身。
 *
 * ## 替身边界的说明
 *
 * - `buddy-oauth` 的 `fetchAuthState` / `runBuddyLoginFlow` 被打桩：前者打真网
 *   取 state，后者会真的开浏览器并轮询 5 分钟。
 * - `oauth` 的 `exchangeAuthorizationCode` 被打桩：CodeArts 的回调服务器是
 *   **真的**（真起监听、真收 HTTP 请求），只有最后那步换 token 会打真网。
 *   这与 `tests/unit/service.spec.ts` 的做法一致。
 * - LobsterAI 不需要打桩模块：它的 fetcher 可从构造函数注入
 *   （`LobsteraiAuthOptions.fetcher`），因此 `prepareLogin` 与 exchange 都走
 *   真实代码路径、只把出网换成替身 —— 覆盖度比打桩模块更高。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { BUDDY_CN, BUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { LOBSTERAI_CALLBACK_PATH } from '../../src/lobsterai.js'
import {
  fetchAuthState,
  runBuddyLoginFlow,
  type BuddyLoginFlowResult,
} from '../../src/buddy-oauth.js'
import { REDIRECT_PATH, exchangeAuthorizationCode } from '../../src/oauth.js'
import { hasActiveCodeartsLogin } from '../../src/login.js'
import { hasActiveLobsteraiLogin } from '../../src/lobsterai-oauth.js'
import { accountCredentialRefName } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

vi.mock('../../src/buddy-oauth.js', async (importOriginal) => ({
  // 只替换两个「会打真网 / 会开浏览器」的入口；`decorateLoginUrl` 等纯函数
  // 保持真实实现 —— 被测代码正是靠它给 WorkBuddy 追加 version/loginSessionId。
  ...await importOriginal<typeof import('../../src/buddy-oauth.js')>(),
  fetchAuthState: vi.fn(),
  runBuddyLoginFlow: vi.fn(),
}))

vi.mock('../../src/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/oauth.js')>()
  return {
    ...actual,
    // CodeArts 的回调服务器是真的，只有「拿 code 换 token」这一步需要出网。
    exchangeAuthorizationCode: vi.fn(),
  }
})

const mockedFetchAuthState = vi.mocked(fetchAuthState)
const mockedRunBuddyLoginFlow = vi.mocked(runBuddyLoginFlow)
const mockedExchangeAuthorizationCode = vi.mocked(exchangeAuthorizationCode)

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** RPC 响应的判别联合（`reply()` 会给 error 补一个 `details`）。 */
type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

interface CreatedAccount {
  accountId: string
  loginUrl: string
}

/** 最小化的内存凭据提供者，形状与 `ctx.credentials` 一致。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  /** 写入顺序（用于断言「先写凭据、再补全账号」的时序与失败不落盘）。 */
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

/** 一个可手动结算的 Promise（用于让「后台第二段」停在指定时刻）。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // 先挂一个空处理器：失败用例里 reject 发生在消费者的 `.catch` 挂上之前，
  // 那段窗口 Node 会把它当成**未处理的拒绝**并让 vitest 报 unhandled error
  // （用例仍全绿，但退出码非 0）。
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** 永不打真实网络的 stub fetch（CodeArts 的模型刷新与兜底路径会用到）。 */
const offlineFetcher = (async () => new Response('', { status: 503 })) as unknown as typeof fetch

/** 一次典型的 LobsterAI exchange 成功响应。 */
function lobsteraiSuccessBody(): string {
  return JSON.stringify({
    code: 0,
    msg: 'OK',
    data: {
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresIn: 3600,
      user: { id: 'uid-1', yid: 'yid-1', userId: 'acc-1', nickname: '龙虾号' },
    },
  })
}

/** 一次典型的 Buddy 登录流程结果（凭据字段齐备，便于断言补全结果）。 */
function buddyFlowResult(nickname: string): BuddyLoginFlowResult {
  const expiresAt = Date.now() + 7_200_000
  return {
    access: JSON.stringify({
      access_token: 'AT-1',
      refresh_token: 'RT-1',
      expires_at: String(expiresAt),
      token_type: 'Bearer',
      domain: 'copilot.tencent.com',
      user_id: 'u1',
      nickname,
      enterprise_id: '',
      account_type: 'personal',
    }),
    expires: expiresAt,
    loginUrl: '',
    refreshable: true,
  }
}

/** 测试用的 CodeArts token 响应。 */
function codeartsTokenResponse() {
  return {
    credentials: {
      access_key_id: 'AK-1',
      secret_access_key: 'SK-1',
      security_token: 'ST-1',
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    },
    refresh_token: 'RT-1',
  }
}

/** 一次浏览器登录的「结算句柄」（buddy 系用；另两个 provider 走真实 HTTP 回调）。 */
type FlowHandle = ReturnType<typeof deferred<BuddyLoginFlowResult>>

interface Harness {
  /** 调用一个端点方法，返回解包后的 result。 */
  call<T = unknown>(method: string, payload: unknown): Promise<RpcResult<T>>
  /** 直接读账号池的权威条目（含 provider / expiresAt 等 UI 可见字段）。 */
  accounts(provider?: string): Promise<ProviderAccountEntry[]>
  /**
   * 直接往账号池写一条**任意形态**的条目（绕过 account.create）。
   *
   * 只给「非法 credentialRef」用例用：`account.create` 产出的 ref 一定合法
   * （见 {@link accountCredentialRefName}），要复现历史遗留 / 未来拼写错误的
   * 非法 ref，只能绕过它写池。
   */
  addRawAccount(entry: ProviderAccountEntry): Promise<void>
  credentials: FakeCredentials
  /** 切换 LobsterAI 的出网响应（默认成功）。 */
  setLobsteraiResponder(responder: () => Response): void
  /** 本用例创建过的账号 id（teardown 会逐个删除以释放 provider 级互斥）。 */
  created: string[]
  teardown(): Promise<void>
}

const harnesses: Harness[] = []

function createHarness(): Harness {
  const credentials = new FakeCredentials()
  let stored: Record<string, unknown> = { accounts: [] }
  let lobsteraiResponder: () => Response = () => new Response(lobsteraiSuccessBody(), { status: 200 })

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

  // 真实 Auth 服务实例：四个服务名互不冲突（buddyCnAuth / buddyAuth /
  // codeartsAuth / lobsteraiAuth），可在同一个 cordis Context 上共存。
  const serviceCtx = new Context()
  serviceCtx.provide('credentials', credentials as never)
  const codearts = new CodeArtsAuth(serviceCtx, { fetcher: offlineFetcher })
  const buddy = new BuddyAuth(serviceCtx, { product: BUDDY_CN })
  const workbuddy = new BuddyAuth(serviceCtx, { product: BUDDY })
  const lobsterai = new LobsteraiAuth(serviceCtx, {
    // 注入 fetcher 而非打桩模块：这样 prepareLogin / exchange 走真实代码路径。
    fetcher: (async () => lobsteraiResponder()) as unknown as typeof fetch,
    // 版本号是 exchange 的必填字段；打桩掉它以免依赖真实更新接口。
    versionResolver: {
      resolve: async () => ({ version: LOBSTERAI.fallbackClientVersion, source: 'fallback' }),
    } as unknown as ConstructorParameters<typeof LobsteraiAuth>[1]['versionResolver'],
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
    // 生产代码用**惰性注入**（`ctx.inject(['connection'], …)`）挂载端点。
    // 替身必须复刻这一机制，否则 registerJetHubRpc 会以
    // `ctx.inject is not a function` 直接抛错。语义对齐真实 cordis：
    // 回调以**同一 ctx** 立即调用。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
  }

  // 后三个实参（traeCn / qoder / qoderCn）本文件都不涉及：本文件只驱动
  // `account.create`，而它按 provider 精确分派，这些服务不会被碰到。传空对象是
  // **刻意的**——若哪天有人让某个分支默认落到某一区，这里会立刻以
  // `Cannot read properties of undefined` 暴露，而不是静默走错实现。
  registerJetHubRpc(
    rpcCtx as never, pool, codearts, buddy, workbuddy, lobsterai,
    {} as never, {} as never, {} as never,
  )
  if (handler === undefined) throw new Error('account.create 端点未注册')

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

  const created: string[] = []

  const harness: Harness = {
    call,
    accounts: (provider?: string) => pool.listAllAccounts()
      .then((all) => (provider === undefined ? all : all.filter((a) => a.provider === provider))),
    addRawAccount: (entry) => pool.addAccount(entry),
    credentials,
    setLobsteraiResponder: (responder) => { lobsteraiResponder = responder },
    created,
    async teardown() {
      // 逐个删除本用例创建的账号：`account.delete` 会 cancel 进行中的
      // lobsterai / codearts 会话。**必须做**——两者的互斥是**模块级**的，
      // 留下未结算会话会让同文件后续用例全部拿到 login-in-progress。
      for (const id of [...created]) {
        try { await call('account.delete', { accountId: id }) } catch { /* 已不存在 */ }
      }
      created.length = 0
      codearts.stop()
      buddy.stop()
      workbuddy.stop()
      lobsterai.stop()
      await vi.waitFor(() => {
        expect(hasActiveCodeartsLogin()).toBe(false)
        expect(hasActiveLobsteraiLogin()).toBe(false)
      })
    },
  }
  harnesses.push(harness)
  return harness
}

/** 发起一次 `account.create` 并登记返回的 accountId（供 teardown 清理）。 */
async function createAccount(harness: Harness, provider: string): Promise<RpcResult<CreatedAccount>> {
  const result = await harness.call<CreatedAccount>('account.create', { provider })
  if (result.ok) harness.created.push(result.value.accountId)
  return result
}

/**
 * 模拟「用户在浏览器里完成了这次登录」。
 *
 * 三个 provider 的完成方式各不相同，但都走**真实的第二段代码路径**：
 * - buddy 系：结算后台登录流程的 Promise（真网与开窗已被打桩）；
 * - codearts / lobsterai：向**真实监听中**的本地回调服务器发一次 HTTP 请求。
 *
 * ⚠️ CodeArts 回调无论成功失败都回 307 重定向到 portal 结果页，必须用
 * `redirect: 'manual'` —— 否则 Node 的 fetch 会跟着跳到真实门户站点上。
 */
async function completeLogin(
  provider: string,
  loginUrl: string,
  flow?: FlowHandle,
): Promise<void> {
  if (provider === 'buddy-cn' || provider === 'buddy') {
    if (flow === undefined) throw new Error('buddy 系用例必须先创建 flow deferred')
    flow.resolve(buddyFlowResult(provider === 'buddy-cn' ? '腾讯号' : '国际号'))
    return
  }
  if (provider === 'codearts') {
    // loginUrl 里的 port 就是回调服务器**真实监听**的端口（portal 要求 ≥10000）。
    const port = new URL(loginUrl).searchParams.get('port')
    await fetch(`http://127.0.0.1:${port}${REDIRECT_PATH}?code=code-1`, { redirect: 'manual' })
    return
  }
  // lobsterai：从 redirect_uri 参数里取回真实回调地址（登录页就是这么用的）。
  const params = new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1))
  const callback = new URL(params.get('redirect_uri')!)
  await fetch(
    `http://127.0.0.1:${callback.port}${callback.pathname}`
    + `?code=code-1&state=${params.get('state')}`,
  )
}

afterEach(async () => {
  for (const harness of harnesses) await harness.teardown()
  harnesses.length = 0
  // reset（而非 clear）：清掉实现，避免上一条用例的 mockReturnValue 泄漏到
  // 下一条 —— 各用例都在使用前重新设置，泄漏会让「忘了设置」变成静默通过。
  vi.resetAllMocks()
})

// ── 四个 provider 的公共契约 ─────────────────────────────────────────────────

const ALL_PROVIDERS = ['codearts', 'buddy-cn', 'buddy', 'lobsterai'] as const

describe.each(ALL_PROVIDERS)('account.create —— %s 两段式契约', (provider) => {
  /**
   * 发起一次 create，并让后台停在「用户还没在浏览器里操作完」的时刻。
   *
   * `options.exchangeFails` 必须在这里传入（而不是调用前自行设置 mock）：
   * 本函数会为 codearts 设置 exchange 的成功桩，调用前设的会被覆盖掉。
   */
  async function startCreate(harness: Harness, options: { exchangeFails?: boolean } = {}) {
    let flow: FlowHandle | undefined
    if (provider === 'buddy-cn' || provider === 'buddy') {
      flow = deferred<BuddyLoginFlowResult>()
      mockedRunBuddyLoginFlow.mockReturnValue(flow.promise)
      mockedFetchAuthState.mockResolvedValue({
        state: 'state-1',
        authUrl: provider === 'buddy-cn'
          ? 'https://copilot.tencent.com/login?platform=ide'
          : 'https://www.workbuddy.ai/login?platform=workbuddy-ai',
      })
    } else if (provider === 'codearts') {
      if (options.exchangeFails === true) {
        mockedExchangeAuthorizationCode.mockRejectedValue(new Error('令牌换取失败'))
      } else {
        mockedExchangeAuthorizationCode.mockResolvedValue(codeartsTokenResponse())
      }
    }
    const result = await createAccount(harness, provider)
    return { result, flow }
  }

  it('第一段立即返回 loginUrl，并已写入 pending 形态的占位条目', async () => {
    const harness = createHarness()
    const { result } = await startCreate(harness)

    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.accountId).toMatch(new RegExp(`^${provider}-[0-9a-f]{8}$`))
    expect(result.value.loginUrl.length).toBeGreaterThan(0)

    // 占位条目：**pending 形态**。expiresAt / refreshable 都依赖第二段的结果，
    // 此时一律不该有值（refreshable 必须是 false，否则 UI 会给一个还没有凭据
    // 的账号渲染「刷新」按钮）。
    const entries = await harness.accounts(provider)
    expect(entries).toHaveLength(1)
    const placeholder = entries[0]!
    expect(placeholder.id).toBe(result.value.accountId)
    expect(placeholder.provider).toBe(provider)
    expect(placeholder.enabled).toBe(true)
    expect(placeholder.refreshable).toBe(false)
    expect(placeholder.expiresAt).toBeUndefined()
    // refName 由 provider 名 + 短 id 派生。**注意**：它用的是**另一个**短 id，
    // 与 accountId 的后缀并不相同（`shortId()` 被调用了两次）—— 这是有意的：
    // 凭据名不该能从账号 id 反推出来。此处只锁形状。
    //
    // 前缀的连字符要折成下划线（`buddy-cn` → `BUDDY_CN`），故直接用生产函数
    // `accountCredentialRefName` 的前缀口径，而不是 `toUpperCase()` —— 后者对
    // 带连字符的 provider 会得出非法 ref 形状（`BUDDY-CN_ACCOUNT_*`），
    // 而 ref 名不允许含连字符（`/^[A-Za-z_][A-Za-z0-9_]*$/`）。
    const refPrefix = accountCredentialRefName(provider, '')
    expect(placeholder.credentialRef).toMatch(new RegExp(`^${refPrefix}[0-9A-F]{8}$`))

    // 此刻凭据还不存在 —— 这正是不阻塞在登录上的证据：若 RPC 内 `await login(...)`，
    // 这个断言根本执行不到（用例会挂在 create 上直到超时）。
    expect(await harness.credentials.resolve(placeholder.credentialRef)).toBeUndefined()
    // 而客户端 `login.poll` 必须如实报「未完成」。
    const poll = await harness.call<{ done: boolean }>('login.poll', {
      accountId: result.value.accountId,
      provider,
    })
    expect(poll.ok && poll.value.done).toBe(false)
  })

  it('后台完成后补全**同一条**账号：nickname / expiresAt / refreshable', async () => {
    const harness = createHarness()
    const { result, flow } = await startCreate(harness)
    if (!result.ok) throw new Error(`create 失败：${JSON.stringify(result)}`)

    await completeLogin(provider, result.value.loginUrl, flow)

    await vi.waitFor(async () => {
      const entries = await harness.accounts(provider)
      expect(entries.some((e) => e.refreshable === true)).toBe(true)
    })

    const entries = await harness.accounts(provider)
    // 无论哪个 provider，**同一个 accountId 只允许一条记录**：占位与补全
    // 是同一条的两个阶段，不是两条各自存在的记录。后者会让用户在账号列表里
    // 看到两张同 id 卡片，且 `account.delete` 只删得掉一条。
    // （lobsterai 曾经正是如此：第二段调 addAccount 而非 updateAccount。）
    expect(entries.map((e) => e.id)).toEqual([result.value.accountId])

    const completed = entries[0]!
    expect(completed.refreshable).toBe(true)
    expect(completed.expiresAt).toBeGreaterThan(Date.now())
    // nickname 来自凭据：buddy 系取凭据里的 nickname，lobsterai 取自 exchange
    // 的 user.nickname，codearts 用 accountId（其凭据没有昵称字段）。
    if (provider === 'buddy-cn') expect(completed.nickname).toBe('腾讯号')
    if (provider === 'buddy') expect(completed.nickname).toBe('国际号')
    if (provider === 'lobsterai') expect(completed.nickname).toBe('龙虾号')
    if (provider === 'codearts') expect(completed.nickname).toBe(result.value.accountId)

    // 凭据确实落盘了，且 `login.poll` 现在报完成。
    expect(await harness.credentials.resolve(completed.credentialRef)).toBeDefined()
    const poll = await harness.call<{ done: boolean; success?: boolean; error?: string }>('login.poll', {
      accountId: result.value.accountId,
      provider,
    })
    expect(poll.ok && poll.value.done).toBe(true)
    // 成功路径**逐字节兼容**：仍是 `{done:true, success:true}`，**不带** error。
    // 新增的失败终态只占 `error` 字段，成功语义一个字都没动。
    if (poll.ok) {
      expect(poll.value.success).toBe(true)
      expect(poll.value.error).toBeUndefined()
    }
  })

  it('后台失败时移除占位条目，不留幽灵账号、不落半成品凭据', async () => {
    const harness = createHarness()
    if (provider === 'lobsterai') {
      // exchange 被服务端拒绝：回调返回 500，awaitCredential 以错误结算。
      harness.setLobsteraiResponder(() => new Response(
        JSON.stringify({ code: 40100, msg: 'token rejected' }), { status: 200 },
      ))
    }
    const { result, flow } = await startCreate(harness, { exchangeFails: provider === 'codearts' })
    if (!result.ok) throw new Error(`create 失败：${JSON.stringify(result)}`)

    if (provider === 'buddy-cn' || provider === 'buddy') {
      // 用户在浏览器里点了取消 / 轮询超时。
      flow!.reject(new Error('登录窗口已关闭'))
    } else {
      await completeLogin(provider, result.value.loginUrl, flow)
    }

    await vi.waitFor(async () => {
      expect(await harness.accounts(provider)).toHaveLength(0)
    })
    // 凭据也不该留下半成品。
    expect(harness.credentials.writes).toHaveLength(0)
  })

  /**
   * 缺陷 2 的回归：**登录失败必须是终态**。
   *
   * 旧行为：第二段 catch 只 `removeAccount`，poll 随后查不到账号条目 →
   * 永远回 `{done:false}` → 客户端白等 5 分钟且窗口不收（用户报障的
   * 「登录后多出残留标签页」）。
   */
  it('后台失败后 login.poll 回报失败终态（done:true + error），而非永远 done:false', async () => {
    const harness = createHarness()
    if (provider === 'lobsterai') {
      harness.setLobsteraiResponder(() => new Response(
        JSON.stringify({ code: 40100, msg: 'token rejected' }), { status: 200 },
      ))
    }
    const { result, flow } = await startCreate(harness, { exchangeFails: provider === 'codearts' })
    if (!result.ok) throw new Error(`create 失败：${JSON.stringify(result)}`)
    const accountId = result.value.accountId

    if (provider === 'buddy-cn' || provider === 'buddy') {
      flow!.reject(new Error('登录窗口已关闭'))
    } else {
      await completeLogin(provider, result.value.loginUrl, flow)
    }
    // 等第二段失败路径跑完（登记失败 + 删占位）。
    await vi.waitFor(async () => {
      expect(await harness.accounts(provider)).toHaveLength(0)
    })

    const poll = await harness.call<{ done: boolean; success?: boolean; error?: string }>(
      'login.poll', { accountId, provider },
    )
    expect(poll.ok, JSON.stringify(poll)).toBe(true)
    if (!poll.ok) return
    expect(poll.value.done).toBe(true)
    expect(poll.value.error, '失败终态必须带可展示的原因').toBeTruthy()
    // 失败**不是**成功：不得带 success。
    expect(poll.value.success).toBeUndefined()

    // 一次性语义：登记读到即清，第二次 poll 回到「未完成」而不是重复报同一个失败。
    const again = await harness.call<{ done: boolean; error?: string }>(
      'login.poll', { accountId, provider },
    )
    expect(again.ok && again.value.done).toBe(false)
  })
})

// ── provider 特化契约 ───────────────────────────────────────────────────────

describe('account.create —— 各 provider 的登录地址来源', () => {
  it('buddy 原样使用 auth/state 下发的 authUrl', async () => {
    const harness = createHarness()
    const flow = deferred<BuddyLoginFlowResult>()
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?platform=ide',
    })
    mockedRunBuddyLoginFlow.mockReturnValue(flow.promise)

    const result = await createAccount(harness, 'buddy-cn')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.loginUrl).toBe('https://copilot.tencent.com/login?platform=ide')
    flow.resolve(buddyFlowResult('腾讯号'))
  })

  it('workbuddy 的 authUrl 追加 version 与 loginSessionId（只追加、不重建 URL）', async () => {
    const harness = createHarness()
    const flow = deferred<BuddyLoginFlowResult>()
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://www.workbuddy.ai/login?platform=workbuddy-ai',
    })
    mockedRunBuddyLoginFlow.mockReturnValue(flow.promise)

    const result = await createAccount(harness, 'buddy')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.value.loginUrl)
    // platform 等原始参数必须保留 —— decorateLoginUrl 只追加、不重建。
    expect(url.searchParams.get('platform')).toBe('workbuddy-ai')
    expect(url.searchParams.get('version')).toBe(BUDDY.pluginVersion)
    expect(url.searchParams.get('loginSessionId')).toMatch(/^[0-9a-f-]{36}$/)
    flow.resolve(buddyFlowResult('国际号'))
  })

  it('codearts 返回 portal 授权 URL，回调端口 ≥10000', async () => {
    const harness = createHarness()
    mockedExchangeAuthorizationCode.mockResolvedValue(codeartsTokenResponse())

    const result = await createAccount(harness, 'codearts')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.loginUrl).toContain('codearts.huaweicloud.com/portal/authorize')
    // 低端口会被 portal 拒绝（真实插件的要求），故必须是 ≥10000。
    expect(Number(new URL(result.value.loginUrl).searchParams.get('port')))
      .toBeGreaterThanOrEqual(10_000)
  })

  it('lobsterai 返回 portal 的 #/login 地址，redirect_uri 指向本地回调', async () => {
    const harness = createHarness()
    const result = await createAccount(harness, 'lobsterai')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.loginUrl).toContain('/portal#/login?')
    expect(result.value.loginUrl).toContain('source=electron')
    const params = new URLSearchParams(result.value.loginUrl.slice(result.value.loginUrl.indexOf('?') + 1))
    const callback = new URL(params.get('redirect_uri')!)
    expect(callback.pathname).toBe(LOBSTERAI_CALLBACK_PATH)
    expect(callback.hostname).toBe('127.0.0.1')
    expect(callback.port.length).toBeGreaterThan(0)
  })

  it('未知 provider 返回 bad-request（不静默成功）', async () => {
    const harness = createHarness()
    const result = await createAccount(harness, 'mystery')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('bad-request')
    expect(result.error.message).toMatch(/unknown provider/)
  })
})

describe('account.create —— login.poll 的完成判据是「凭据可解析」', () => {
  /**
   * 时序回归：**先写凭据、再补全账号**。
   *
   * `login.poll` 只看「该 credentialRef 能否解析到凭据」，不看账号条目字段。
   * 若第二段反过来（先 `updateAccount` 补全昵称/过期时间，再写凭据），轮询会在
   * **凭据尚不存在**时就报 `done: true`，客户端随即关闭登录窗口并刷新账号列表
   * —— 用户看到一个有名字有有效期的账号，实际却没有凭据可用。
   *
   * 因此这里要求：`poll.done` 为真的**同一刻**，凭据可解析 **且** 账号已补全。
   */
  it('buddy：poll 报 done 时凭据与补全后的账号同时就绪', async () => {
    const harness = createHarness()
    const flow = deferred<BuddyLoginFlowResult>()
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?platform=ide',
    })
    mockedRunBuddyLoginFlow.mockReturnValue(flow.promise)

    const result = await createAccount(harness, 'buddy-cn')
    if (!result.ok) throw new Error('create 失败')
    const accountId = result.value.accountId

    flow.resolve(buddyFlowResult('腾讯号'))
    await vi.waitFor(async () => {
      const poll = await harness.call<{ done: boolean }>('login.poll', { accountId, provider: 'buddy-cn' })
      expect(poll.ok && poll.value.done).toBe(true)
    })

    // 到此为止没有任何额外等待：状态必须**已经是**一致的。
    const entry = (await harness.accounts('buddy-cn')).find((e) => e.id === accountId)
    expect(entry).toBeDefined()
    expect(entry!.refreshable).toBe(true)
    expect(entry!.nickname).toBe('腾讯号')
    expect(await harness.credentials.resolve(entry!.credentialRef)).toBeDefined()
  })

  it('第一段绝不写凭据；第二段写入的正是该账号的 ref', async () => {
    const harness = createHarness()
    const flow = deferred<BuddyLoginFlowResult>()
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?platform=ide',
    })
    mockedRunBuddyLoginFlow.mockReturnValue(flow.promise)

    const result = await createAccount(harness, 'buddy-cn')
    if (!result.ok) throw new Error('create 失败')

    // 第一段绝不写凭据（此刻账号还只是占位）。
    expect(harness.credentials.writes).toEqual([])
    // ref 名与 accountId 的后缀**不同**（`shortId()` 调了两次），
    // 因此从池里的占位条目取权威值，而不是从 accountId 反推。
    const placeholderRef = (await harness.accounts('buddy-cn'))[0]!.credentialRef

    flow.resolve(buddyFlowResult('腾讯号'))
    await vi.waitFor(() => {
      expect(harness.credentials.writes).toEqual([placeholderRef])
    })
  })
})

describe('login.poll —— 非法 credentialRef 的预检（不抛 TypeError）', () => {
  /**
   * 缺陷 1 的回归：`credentialRef()` 对不合规名称抛 TypeError
   * （`REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`，连字符**不在**字符集内）。
   *
   * 旧行为：poll 裸用 `credentialRef(entry.credentialRef)` → 抛错 → 被 RPC 层
   * 包成 `jet-hub/handler-failed` → 客户端把它当网络抖动吞掉继续轮询 →
   * 又是一种「静默空等 5 分钟」。这正是 `1e8e285` 修掉的 ref 拼写错误的
   * **表现形态**，本层防御覆盖「未来同类拼写错误」。
   *
   * 非法 ref 只能绕过 `account.create` 写进池（它产出的 ref 一定合法），
   * 故用 `addRawAccount` 直接落一条历史遗留形态的条目。
   */
  it('带连字符的 ref 回失败终态而不是抛 handler-failed', async () => {
    const harness = createHarness()
    // `1e8e285` 之前的形态：provider id 原样拼进 ref（`TRAE-CN_ACCOUNT_XXX`）。
    await harness.addRawAccount({
      id: 'trae-cn-legacy1',
      provider: 'trae-cn',
      nickname: 'trae-cn-legacy1',
      enabled: true,
      credentialRef: 'TRAE-CN_ACCOUNT_DEADBEEF',
      refreshable: false,
      createdAt: Date.now(),
    })

    const poll = await harness.call<{ done: boolean; error?: string }>(
      'login.poll', { accountId: 'trae-cn-legacy1', provider: 'trae-cn' },
    )
    // 关键：**不是** ok:false / handler-failed，而是可判别的失败终态。
    expect(poll.ok, JSON.stringify(poll)).toBe(true)
    if (!poll.ok) return
    expect(poll.value).toEqual({ done: true, error: 'invalid-credential-ref' })
  })

  it('合法 ref 的既有语义不变：无凭据仍报未完成', async () => {
    const harness = createHarness()
    // buddy 的第一段要取 auth/state（真网已被打桩），后台流程挂住不结算 ——
    // 于是账号停在占位形态、凭据未写，正是「未完成」的样本。
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?platform=ide',
    })
    mockedRunBuddyLoginFlow.mockReturnValue(deferred<BuddyLoginFlowResult>().promise)
    const created = await createAccount(harness, 'buddy-cn')
    if (!created.ok) throw new Error(`create 失败：${JSON.stringify(created)}`)

    const poll = await harness.call<{ done: boolean; success?: boolean; error?: string }>(
      'login.poll', { accountId: created.value.accountId, provider: 'buddy-cn' },
    )
    expect(poll.ok).toBe(true)
    if (!poll.ok) return
    // 占位条目：凭据还没写 → 未完成，且**不带** error（不是失败）。
    expect(poll.value.done).toBe(false)
    expect(poll.value.error).toBeUndefined()
    expect(poll.value.success).toBeUndefined()
  })

  it('未知 accountId 仍报未完成（不因失败登记表的存在而变语义）', async () => {
    const harness = createHarness()
    const poll = await harness.call<{ done: boolean; error?: string }>(
      'login.poll', { accountId: 'nobody-00000000', provider: 'buddy-cn' },
    )
    expect(poll.ok && poll.value.done).toBe(false)
  })
})

describe('account.create —— provider 级互斥（login-in-progress）', () => {
  /**
   * 为什么需要互斥（而不是「复用旧会话」或「静默新建」）：
   * - 复用会让一份凭据结果被多个占位 accountId 共享，账号池出现重复候选；
   * - 静默新建则每次点击都起一个 loopback 监听，点到第 N 次就挂 N 个端口
   *   直到超时（LobsterAI 10 分钟 / CodeArts 180 秒）。
   */
  it('lobsterai：进行中会话时二次 create 返回 login-in-progress，且不新建监听', async () => {
    const harness = createHarness()
    const first = await createAccount(harness, 'lobsterai')
    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) return
    expect(hasActiveLobsteraiLogin()).toBe(true)

    const second = await createAccount(harness, 'lobsterai')
    expect(second.ok).toBe(false)
    if (second.ok) return
    // 判别联合：客户端据 error.code 分支，据 message 直接展示。
    expect(second.error.code).toBe('login-in-progress')
    expect(second.error.message).toMatch(/已有 LobsterAI 登录进行中/)

    // 不新建监听 = 不新建占位账号；池里仍只有第一次那一条。
    expect(await harness.accounts('lobsterai')).toHaveLength(1)
  })

  it('codearts：进行中会话时二次 create 返回 login-in-progress，且不新建监听', async () => {
    const harness = createHarness()
    mockedExchangeAuthorizationCode.mockResolvedValue(codeartsTokenResponse())
    const first = await createAccount(harness, 'codearts')
    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) return
    expect(hasActiveCodeartsLogin()).toBe(true)

    const second = await createAccount(harness, 'codearts')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('login-in-progress')
    expect(second.error.message).toMatch(/已有 CodeArts 登录进行中/)

    expect(await harness.accounts('codearts')).toHaveLength(1)
  })

  it('buddy 系**不受**该互斥限制（互斥在服务端 state 上，且允许多账号并存）', async () => {
    const harness = createHarness()
    mockedFetchAuthState.mockResolvedValue({
      state: 'state-1',
      authUrl: 'https://copilot.tencent.com/login?platform=ide',
    })
    const firstFlow = deferred<BuddyLoginFlowResult>()
    mockedRunBuddyLoginFlow.mockReturnValue(firstFlow.promise)
    const first = await createAccount(harness, 'buddy-cn')
    expect(first.ok).toBe(true)

    const secondFlow = deferred<BuddyLoginFlowResult>()
    mockedRunBuddyLoginFlow.mockReturnValue(secondFlow.promise)
    const second = await createAccount(harness, 'buddy-cn')
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.accountId).not.toBe(first.value.accountId)
    expect(await harness.accounts('buddy-cn')).toHaveLength(2)

    firstFlow.resolve(buddyFlowResult('一号'))
    secondFlow.resolve(buddyFlowResult('二号'))
  })

  it('互斥在会话结算后释放：删掉占位账号即可重新开始', async () => {
    const harness = createHarness()
    const first = await createAccount(harness, 'lobsterai')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // 用户删掉占位账号 → 会话被 cancel → 互斥释放。
    await harness.call('account.delete', { accountId: first.value.accountId })
    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })

    harness.created.length = 0
    const second = await createAccount(harness, 'lobsterai')
    expect(second.ok, JSON.stringify(second)).toBe(true)
  })
})

describe('account.delete —— 对进行中会话的 cancel 释放', () => {
  /**
   * `account.delete` 必须 cancel 对应会话，否则：
   * 1. 占位账号删掉了，但 loopback 端口要一直占到超时；
   * 2. 更糟的是互斥锁是 **provider 级**的 —— 旧会话不释放，用户删掉占位后
   *    想重新登录会一直拿到 `login-in-progress`，直到旧会话超时。
   */
  it('lobsterai：删除占位账号同时释放模块级登录槽位', async () => {
    const harness = createHarness()
    const created = await createAccount(harness, 'lobsterai')
    if (!created.ok) throw new Error('create 失败')
    expect(hasActiveLobsteraiLogin()).toBe(true)

    await harness.call('account.delete', { accountId: created.value.accountId })

    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })
    expect(await harness.accounts('lobsterai')).toHaveLength(0)
  })

  it('codearts：删除占位账号同时释放模块级登录槽位', async () => {
    const harness = createHarness()
    const created = await createAccount(harness, 'codearts')
    if (!created.ok) throw new Error('create 失败')
    expect(hasActiveCodeartsLogin()).toBe(true)

    await harness.call('account.delete', { accountId: created.value.accountId })

    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
    expect(await harness.accounts('codearts')).toHaveLength(0)
  })

  it('删除后后台的失败路径不会把已删账号复活、也不会落凭据', async () => {
    const harness = createHarness()
    const created = await createAccount(harness, 'lobsterai')
    if (!created.ok) throw new Error('create 失败')

    await harness.call('account.delete', { accountId: created.value.accountId })
    // 让会话取消后触发的后台 catch（`pool.removeAccount`）跑完。
    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })
    await new Promise((done) => setTimeout(done, 20))

    expect(await harness.accounts('lobsterai')).toHaveLength(0)
    expect(harness.credentials.writes).toEqual([])
  })
})

// ── 客户端弹窗形态（源码级回归） ─────────────────────────────────────────────

describe('客户端 createAccount 的弹窗形态（源码级回归）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  /**
   * 源码在 Windows 上是 CRLF、在 CI 上是 LF。统一归一化后再做切片与
   * 「相邻行」断言，否则同一份代码在不同平台上结论不同。
   */
  const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    .replace(/\r\n/g, '\n')

  /** 去掉注释行，避免「注释里叙述 location.href 缺陷」被误判成代码。 */
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  /** `createAccount` 的函数体（供「先开窗、后 await」的顺序断言）。 */
  const body = (() => {
    const start = code.indexOf('const createAccount = async () => {')
    expect(start).toBeGreaterThan(-1)
    return code.slice(start, code.indexOf('\n  };', start))
  })()

  it('window.open 发生在任何 await 之前（手势内先开空窗）', () => {
    const openAt = body.indexOf('window.open(')
    const awaitAt = body.indexOf('await rpcCall(')
    expect(openAt).toBeGreaterThan(-1)
    expect(awaitAt).toBeGreaterThan(-1)
    // 本次改造的核心：先开窗、后请求。顺序反了用户手势就过期了，
    // 弹窗被拦截后客户端只能兜底 —— 那正是要根除的行为。
    expect(openAt).toBeLessThan(awaitAt)
  })

  it('绝不使用 location.href 兜底（会把 DSH 页面顶掉）', () => {
    expect(code).not.toContain('location.href')
    // 用的是 location.replace：空窗的 about:blank 不留在历史里。
    expect(code).toContain('location.replace(loginUrl)')
  })

  it('登录窗口用固定窗口名（重复点击复用同一窗口，不开新标签页）', () => {
    expect(code).toContain('dsh-account-hub-login')
    // 旧的 `window.open(loginUrl, '_blank', ...)` 形态必须消失。
    expect(code).not.toContain("'_blank', 'width=800,height=600'")
  })

  it('弹窗被拦截时在面板内渲染手动登录链接，而不是脚本再开一次窗', () => {
    expect(code).toContain('setManualLogin')
    expect(code).toContain('dim-jh-manualLogin')
    // 手动链接必须是原生 <a href>（浏览器自行导航，不受脚本开窗策略限制）。
    const manualAt = code.indexOf('manualLogin\n      ? React.createElement')
    expect(manualAt, '未找到手动链接的渲染块').toBeGreaterThan(-1)
    const manualBlock = code.slice(manualAt, code.indexOf("phase === 'loading'", manualAt))
    expect(manualBlock, '手动链接必须是 <a href>').toContain('href: manualLogin.url')
    // 兜底路径里不得再出现脚本开窗 —— 那正是「再失败一次就彻底没入口」的成因。
    expect(manualBlock).not.toContain('window.open')
  })

  it('login-in-progress 单独分支直接展示后端 message', () => {
    expect(code).toContain("caught?.code === 'login-in-progress'")
    // 不得被拼成「新建账号失败：已有登录进行中」。
    expect(body).toContain('caught.message')
  })

  it('空窗在所有错误路径都被关闭（不留白屏孤儿窗）', () => {
    // 收窗调用点：accountId 缺失 / loginUrl 为空 / 轮询成功收尾 / catch 兜底。
    // 断言这四条都在，防止将来新增分支时漏掉收窗、留下一张白屏孤儿窗。
    const closeCalls = body.match(/closeLoginWindow\(\);/g) ?? []
    expect(closeCalls.length).toBeGreaterThanOrEqual(4)
    // 轮询成功后必须先收窗、再刷新账号列表。
    expect(body).toMatch(/closeLoginWindow\(\);\s*\n\s*await loadAccounts\(\);/)
  })

  /**
   * 缺陷 3 的回归（源码级）：**失败与超时也必须收窗**。
   *
   * 旧行为：轮询只在 `pollRes.done` 时 `clearInterval` + `closeLoginWindow()`；
   * 超时分支只 `clearInterval(pollTimer)` 不收窗 → poll 全程异常时窗口残留
   * 5 分钟后仍留着；宿主回失败终态时窗口也留着（用户报障的残留标签页）。
   */
  it('轮询收尾走同一个 finishPolling（停表 + 收窗 + 刷新账号列表）', () => {
    expect(body).toContain('const finishPolling = async () => {')
    const finishAt = body.indexOf('const finishPolling = async () => {')
    const finishBlock = body.slice(finishAt, body.indexOf('\n      };', finishAt))
    // 三件事都在同一个收尾函数里，三条终态路径才可能都做全。
    expect(finishBlock).toContain('clearInterval(pollTimer)')
    expect(finishBlock).toContain('closeLoginWindow()')
    expect(finishBlock).toContain('await loadAccounts()')
    // 幂等闸：成功收尾后那个 5 分钟定时器仍在，重复调用必须是 no-op。
    expect(finishBlock).toContain('if (pollSettled) return;')
    expect(finishBlock).toContain('pollSettled = true;')
  })

  it('失败终态（done + error）收窗并把原因显示给用户', () => {
    // 宿主 `login.poll` 的失败终态：`done:true` 且带 `error`。
    expect(body).toContain('pollRes.error')
    // 复用面板既有的通知行，而不是新造 UI 组件。
    expect(body).toMatch(/setProbeNotice\(\{ tone: 'error'[^}]*登录失败/)
    // 失败分支与成功分支一样走 finishPolling（收窗 + 刷新）。
    const errorAt = body.indexOf('pollRes.error')
    expect(body.slice(errorAt)).toContain('await finishPolling()')
  })

  it('5 分钟超时也收窗（只清定时器会留下一张永远挂着的窗口）', () => {
    const timeoutAt = body.indexOf('}, 300000);')
    expect(timeoutAt, '未找到 5 分钟超时分支').toBeGreaterThan(-1)
    // 超时分支所在的那一行必须是 finishPolling，而不是裸的 clearInterval。
    const timeoutLine = body.slice(body.lastIndexOf('\n', timeoutAt) + 1, timeoutAt + 10)
    expect(timeoutLine).toContain('finishPolling')
    expect(timeoutLine).not.toMatch(/setTimeout\(\(\) => \{ clearInterval\(pollTimer\); \}/)
  })
})
