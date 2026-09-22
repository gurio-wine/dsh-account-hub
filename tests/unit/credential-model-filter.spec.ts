/**
 * 场景 A：前几个账号已限额/积分耗尽时，每次请求都要串行试一遍失败账号。
 *
 * 根因：`src/index.ts` 的 `resolveCredential` 以前把 `getAvailableAccount` 的
 * modelId 写成**空串**，而空串按设计不参与限流过滤（见 `AccountPool` 的说明）。
 * 于是每次请求开头总是拿到「排序第一」的账号——即使它已被记了 24h 积分耗尽
 * 标记——失败后才靠换号循环逐个试。前 3 个账号都耗尽时，每次请求都要等 3 次
 * 「发请求 → 400 → 解析 → 记标记 → 换号」的完整往返。
 *
 * 本文件刻意走**真实接线**：`src/index.ts` 的 `makeCredentialResolver` +
 * **真实 `AccountPool`** + 真实适配器，只把最外层的凭据存储、settings 与
 * fetch 换成内存替身。理由与 `lobsterai-wiring.spec.ts` 相同 —— 接线层缺陷在
 * 「所有 adapter 测试都注入同一个固定 resolveCredential」的单测里天然看不见：
 * 这里要锁的是「**选号发生在发请求之前，且带上目标模型**」。
 */

import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountPool } from '../../src/account-pool.js'
import { makeAccountPicker, makeCredentialResolver } from '../../src/index.js'
import { accountCredentialRefName } from '../../src/account-hub-rpc.js'
import { BuddyAdapter, DEFAULT_MODEL } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'
import type { CodeArtsCredential, ProviderAccountEntry } from '../../src/types.js'

/** 目标模型：用产品默认模型，保证适配器不会因模型未知而走特殊分支。 */
const MODEL = DEFAULT_MODEL
const HOUR = 3_600_000
/** 积分耗尽的冷却时长（与 `parseQuotaExhausted` 的 24h 一致）。 */
const QUOTA_COOLDOWN_MS = 24 * HOUR

const OK_SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

/** 6004 频率限制报文（真实文案，可解析出服务端声明的重置时刻）。 */
const RATE_LIMIT_BODY = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置，您也可以切换其他模型继续使用。',
})

/**
 * 内存替身上下文：`settings`（账号索引）+ `credentials`（凭据本体）。
 *
 * 形状对齐 `account-pool.spec.ts` 的 `createMockContext`，但这里必须让
 * `AccountPool` 的写入真实生效（限流标记要能被后续的选号读到）。
 */
function createPoolContext() {
  const credentials = new Map<string, string>()
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: [] }
  const settings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => stored,
      replace: async (value: { accounts?: ProviderAccountEntry[] }) => { stored = value },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const refKey = (ref: unknown): string => (typeof ref === 'string' ? ref : String(ref))
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => (key === 'settings' ? settings : undefined),
    credentials: {
      describe: async (ref: unknown) => {
        const key = refKey(ref)
        return { configured: credentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: unknown) => {
        const value = credentials.get(refKey(ref))
        return value === undefined ? undefined : { value, source: 'test' as const }
      },
      set: async (ref: unknown, value: string) => { credentials.set(refKey(ref), value) },
      unset: async (ref: unknown) => { credentials.delete(refKey(ref)) },
    },
  }
  return { ctx, credentials }
}

/** 构造账号条目；`limits` 为「模型 → 重置时刻」的限流标记。 */
function makeAccount(
  id: string,
  provider: string,
  limits?: Record<string, number>,
): ProviderAccountEntry {
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    // 与生产代码同规矩：provider 名里的连字符要折成下划线才是指针合法的 ref
    // （`buddy-cn` → `BUDDY_CN_ACCOUNT_*`），否则 credentialRef() 直接抛
    // `must match /^[A-Za-z_][A-Za-z0-9_]*$/`。
    credentialRef: accountCredentialRefName(provider, id),
    createdAt: 1,
    expiresAt: Date.now() + HOUR,
    refreshable: true,
    ...limits === undefined ? {} : { modelRateLimits: limits },
  }
}

function buddyCredential(token: string): BuddyCredential {
  return {
    access_token: token,
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
  }
}

/** 建一个真 `AccountPool`，并把 buddy 账号写进 settings + credentials。 */
async function makeBuddyPool(
  specs: Array<{ id: string; token: string; limits?: Record<string, number> }>,
) {
  const { ctx, credentials } = createPoolContext()
  const pool = new AccountPool(ctx as never)
  for (const spec of specs) {
    const entry = makeAccount(spec.id, 'buddy-cn', spec.limits)
    credentials.set(credentialRef(entry.credentialRef), JSON.stringify(buddyCredential(spec.token)))
    await pool.addAccount(entry)
  }
  const resolveCredential = makeCredentialResolver<BuddyCredential>(
    ctx as never, pool, 'buddy-cn', 'BUDDY_CN_ACCESS_TOKEN',
  )
  return { ctx, pool, resolveCredential }
}

/** SSE 响应（流式 body，与既有 buddy 用例的替身风格一致）。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 收集适配器流；失败时把错误对象返回（便于断言 code）。 */
async function collect(adapter: { stream: (options: never) => AsyncIterable<unknown> }, options: object) {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as Record<string, any>)
  }
  return chunks
}

describe('凭据在发请求前按目标模型选择（场景 A 核心修复）', () => {
  it('A、B 对该模型有限流标记 → 一次请求只发给 C（不对 A、B 发任何请求）', async () => {
    const limited = { [MODEL]: Date.now() + HOUR }
    const { pool, resolveCredential } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: limited },
      { id: 'b', token: 'AT-B', limits: limited },
      { id: 'c', token: 'AT-C' },
    ])

    // 核心断言 1：经 index.ts 的实现路径拿到的就是 C —— 选号发生在发请求之前。
    expect((await resolveCredential(MODEL))?.access_token).toBe('AT-C')

    // 核心断言 2：整条请求链路上 A、B 一次都没被发过。
    const sent: string[] = []
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      sent.push(auth.replace('Bearer ', ''))
      return sseResponse(OK_SSE)
    }) as unknown as typeof fetch
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_CN_ACCESS_TOKEN'),
      resolveCredential,
      refresh: async () => {},
      fetchImpl: fetcher,
      accountPool: pool as never,
    })

    const chunks = await collect(adapter, {
      model: MODEL,
      messages: [],
      signal: new AbortController().signal,
    })

    expect(sent).toEqual(['AT-C'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  it('积分耗尽的 24h 冷却标记同样在发请求前被跳过', async () => {
    // 上一轮修复让「积分耗尽」也写 24h 冷却标记；本轮修复保证这个标记同样
    // 参与**请求前**的选号，而不是只在失败后的换号循环里起作用。
    const quota = { [MODEL]: Date.now() + QUOTA_COOLDOWN_MS }
    const { resolveCredential } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: quota },
      { id: 'b', token: 'AT-B', limits: quota },
      { id: 'c', token: 'AT-C' },
    ])

    expect((await resolveCredential(MODEL))?.access_token).toBe('AT-C')
  })

  it('全部账号都在冷却期 → 只发一次请求，并保持 QUOTA_EXCEEDED 语义', async () => {
    // 池里一个可用账号都没有时，不能静默退化成「单凭据 ref → MISSING_CREDENTIAL」
    // ——那会把「所有账号都在冷却」误报成「未登录」。这里锁住既有行为：
    // 仍拿到一个账号、只发一次请求，走完换号循环后抛 QUOTA_EXCEEDED。
    const limited = { [MODEL]: Date.now() + HOUR }
    const { pool, resolveCredential } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: limited },
      { id: 'b', token: 'AT-B', limits: limited },
      { id: 'c', token: 'AT-C', limits: limited },
    ])

    const fetcher = vi.fn(async () => new Response(RATE_LIMIT_BODY, { status: 400 })) as unknown as typeof fetch
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_CN_ACCESS_TOKEN'),
      resolveCredential,
      refresh: async () => {},
      fetchImpl: fetcher,
      accountPool: pool as never,
    })

    const error = await collect(adapter, {
      model: MODEL,
      messages: [],
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 其余账号都在冷却期内 → 换号循环拿不到候选，不该再发无谓请求。
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('无参调用（fetchModels 路径）行为不变：仍取排序第一，忽略限流标记', async () => {
    // 拉模型目录不需要按目标模型过滤（目录对所有模型都一样），因此空 modelId
    // 的退化路径必须原样保留 —— 否则模型列表会随某个模型的限流状态而缺号。
    const { resolveCredential } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: { [MODEL]: Date.now() + HOUR } },
      { id: 'b', token: 'AT-B' },
      { id: 'c', token: 'AT-C' },
    ])

    expect((await resolveCredential())?.access_token).toBe('AT-A')
    expect((await resolveCredential(MODEL))?.access_token).toBe('AT-B')
  })

  it('全部账号冷却时退回不过滤查询，而不是误报「未登录」', async () => {
    // 这是**刻意保留**的退化：若返回 undefined，适配器会抛 MISSING_CREDENTIAL
    // （提示「请先登录」），而真实原因是所有账号都在限流/积分耗尽冷却中 ——
    // 提示会完全指错方向。必须仍给出一个账号，由适配器实测后报 QUOTA_EXCEEDED。
    const limited = { [MODEL]: Date.now() + HOUR }
    const { resolveCredential } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: limited },
      { id: 'b', token: 'AT-B', limits: limited },
    ])

    expect((await resolveCredential(MODEL))?.access_token).toBe('AT-A')
  })

  it('选号器按同一 model 口径选号：refresh 与 resolve 不会挑到不同账号', async () => {
    // 历史缺陷 S1 的**同类再现路径**：LobsterAI 的 refresh 也是「先选号再刷新
    // 该账号」。若它与 resolve 的过滤口径不同（一边按模型、一边空 modelId），
    // 就会「解析到 B、却刷新了 A」，B 的过期 token 永不更新 → 一直认证失败。
    // 本用例锁住两者共用同一个 picker 时的口径一致性。
    const { pool } = await makeBuddyPool([
      { id: 'a', token: 'AT-A', limits: { [MODEL]: Date.now() + HOUR } },
      { id: 'b', token: 'AT-B' },
    ])
    const pick = makeAccountPicker(pool, 'buddy-cn')

    expect((await pick(MODEL))?.entry.id).toBe('b')
    // 空参路径（fetchModels / 默认单凭据场景）仍取排序第一，两者互不串味。
    expect((await pick())?.entry.id).toBe('a')
    // 退化路径：B 也被限流后，按模型查为空 → 退回不过滤，仍给出一个账号。
    await pool.updateModelRateLimit('b', MODEL, Date.now() + HOUR)
    expect((await pick(MODEL))?.entry.id).toBe('a')
  })

  it('未配置账号池时返回 null，由调用方回退单凭据 ref', async () => {
    const pick = makeAccountPicker(undefined, 'buddy-cn')
    expect(await pick(MODEL)).toBeNull()
    expect(await pick()).toBeNull()
  })
})

describe('经真实 apply() 接线：请求直接落在未被限流的账号上', () => {
  /**
   * 端到端锁：不复刻接线，而是真的调用 `apply()`，再从它注册的适配器实例
   * 发起一次 `stream()`。
   *
   * 为什么必须有这一层：`makeCredentialResolver` 自身的单测只能证明「这个
   * 辅助函数传对了 model」。真正要防的退化是**注册处忘了接线** —— 即四个
   * provider 里某一个仍写成不带 model 的调用。那种缺陷在所有「注入固定
   * resolveCredential」的适配器单测里恒不可见（与 `lobsterai-wiring.spec.ts`
   * 记录的 S1 同类教训）。
   */
  class FakeLlm {
    readonly providers: string[] = []
    /** 按注册顺序记录适配器实例，供测试直接驱动。 */
    readonly adapters: Array<{ providers: string[]; adapter: { stream: (o: never) => AsyncIterable<unknown> } }> = []
    registerConfigurableProviders(entries: Array<{ provider: string }>): { replace: () => void } {
      for (const entry of entries) this.providers.push(entry.provider)
      return { replace: () => {} }
    }
    registerAdapter(providers: string[], adapter: unknown) {
      this.adapters.push({ providers, adapter: adapter as never })
      return { replace: () => {} }
    }
  }

  class FakeSettings {
    register(_ns: string, _schema: unknown): undefined { return undefined }
    describe(): Array<{ ns: string }> { return [] }
  }

  class FakeCredentials {
    private store = new Map<string, string>()
    async resolve(ref: unknown) {
      const value = this.store.get(String(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    }
    async describe(ref: unknown) {
      return { configured: this.store.has(String(ref)), source: 'fake', writable: true }
    }
    async set(ref: unknown, value: string) { this.store.set(String(ref), value) }
    async unset(ref: unknown) { this.store.delete(String(ref)) }
  }

  it('账号 A 对目标模型已记录限流 → 首次请求直接发给 B，A 一个请求都没收到', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { apply } = await import('../../src/index.js')

    // 截获所有出站请求；只放行 chat 端点，其余（模型目录等）返回 404 让其静默回退。
    const sent: string[] = []
    const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/v2/chat/completions')) return new Response('not found', { status: 404 })
      sent.push((new Headers(init?.headers).get('Authorization') ?? '').replace('Bearer ', ''))
      return sseResponse(OK_SSE)
    })
    vi.stubGlobal('fetch', fetchStub)

    try {
      const ctx = new Context()
      const credentials = new FakeCredentials()
      ctx.provide('credentials', credentials as never)
      ctx.provide('commands', { register: () => () => {} } as never)
      const llm = new FakeLlm()
      ctx.provide('llm', llm as never)
      ctx.provide('settings', new FakeSettings() as never)

      apply(ctx as never)

      // 经插件自己暴露的账号池写入账号（与 Account Hub 登录后的写入路径一致）。
      const pool = (ctx as unknown as { accountPool: AccountPool }).accountPool
      for (const spec of [
        { id: 'a', token: 'AT-A', limits: { [MODEL]: Date.now() + HOUR } },
        { id: 'b', token: 'AT-B' },
      ]) {
        const entry = makeAccount(spec.id, 'buddy-cn', spec.limits)
        await credentials.set(entry.credentialRef, JSON.stringify(buddyCredential(spec.token)))
        // refreshable: false 避免 apply() 里的续期调度器在测试中留下定时器。
        await pool.addAccount({ ...entry, refreshable: false })
      }

      const registered = llm.adapters.find((item) => item.providers.includes('buddy-cn'))
      expect(registered, 'buddy 适配器必须已注册').toBeDefined()

      await collect(registered!.adapter, {
        model: MODEL,
        messages: [],
        signal: new AbortController().signal,
      })

      // 核心断言：A 已被记为限流 → 首次请求就必须落在 B 上。
      expect(sent).toEqual(['AT-B'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('适配器调用 resolveCredential 时必须带上目标模型', () => {
  const codeartsCredential = (): CodeArtsCredential => ({
    access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    expires_at: '2099-01-01T00:00:00Z',
  })

  const lobsteraiCredential = (): LobsteraiCredential => ({
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'u', user_id: 'y', uuid: 'uuid-1', first_keyfrom: '1', latest_keyfrom: '1',
  })

  it('BuddyAdapter：stream 入口与 401 重试都传 options.model', async () => {
    const calls: Array<string | undefined> = []
    let attempt = 0
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_CN_ACCESS_TOKEN'),
      resolveCredential: async (model?: string) => { calls.push(model); return buddyCredential('AT') },
      refresh: async () => {},
      fetchImpl: (async () => {
        attempt += 1
        return attempt === 1
          ? new Response('unauthorized', { status: 401 })
          : sseResponse(OK_SSE)
      }) as unknown as typeof fetch,
    })

    await collect(adapter, { model: MODEL, messages: [], signal: new AbortController().signal })

    expect(calls).toEqual([MODEL, MODEL])
  })

  it('CodeArtsAdapter：stream 入口与鉴权失败重试都传 options.model', async () => {
    const calls: Array<string | undefined> = []
    let attempt = 0
    const adapter = new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async (model?: string) => { calls.push(model); return codeartsCredential() },
      refresh: async () => {},
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        // 鉴权失败重试走 401；第二次成功。加一条断言：模型确实随请求发出。
        expect(JSON.parse(String(init?.body)).model).toBe(MODEL)
        attempt += 1
        return attempt === 1
          ? new Response('{"error_code":"APIG.0602"}', { status: 401 })
          : new Response(OK_SSE, { status: 200 })
      }) as unknown as typeof fetch,
    })

    await collect(adapter, { model: MODEL, messages: [], signal: new AbortController().signal })

    expect(calls).toEqual([MODEL, MODEL])
  })

  it('LobsteraiAdapter：stream 入口与 401 重试都传 options.model', async () => {
    const calls: Array<string | undefined> = []
    let attempt = 0
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCESS_TOKEN'),
      resolveCredential: async (model?: string) => { calls.push(model); return lobsteraiCredential() },
      refresh: async () => {},
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
      fetchImpl: (async () => {
        attempt += 1
        return attempt === 1
          ? new Response('unauthorized', { status: 401 })
          : new Response(OK_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }) as unknown as typeof fetch,
    })

    await collect(adapter, { model: MODEL, messages: [], signal: new AbortController().signal })

    expect(calls).toEqual([MODEL, MODEL])
  })
})
