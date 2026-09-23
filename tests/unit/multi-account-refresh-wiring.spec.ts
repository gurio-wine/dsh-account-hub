/**
 * 多账号续期调度的**接线与时序**回归（本文件是本单 R1/R2 的证据）。
 *
 * ## R1：定时器注册判据曾在 storage 就绪前计算 → 定时器从未注册过
 *
 * `apply()` 是同步签名，而 `pool.openStorage()` 是异步的（storage 域的打开要
 * 走后端 IO）。历史接线在 `apply()` **同步执行期**就对 `pool.listAllAccounts()`
 * 求值，此时 storage 尚未接管、读到的只有 settings 回退路径（或空表）——
 * 于是 `hasRefreshable` 恒为 false，**30 分钟续期定时器从未注册过**，
 * 所有 refresh_token 一路放到过期。
 *
 * 本文件用**真实 `apply()`** + 可控放行的 storage 域复现完整时序：
 * - storage 未就绪时：不得注册定时器；
 * - storage 就绪后：**立即补跑一次** `refreshAllCredentials()`，再注册 30 分钟定时器。
 *
 * ⚠️ 为什么必须用真实 storage（而不是 settings 桩）：现网判据读的是 storage；
 * 用同步的 settings 桩喂账号会**绕过时序**，让上面那个缺陷完全不可见 ——
 * 这正是本缺陷此前没被任何用例挡住的原因。
 *
 * ## R2：适配器的 `refresh` 回调必须刷**解析凭据时所用的那个账号**
 *
 * 与 `lobsterai-wiring.spec.ts` 记录的 S1 同类：`refresh: () => service.refresh()`
 * 读写的是 provider 的**默认单凭据 ref**（`CODEARTS_ACCESS_TOKEN`），而
 * `resolveCredential` 优先从账号池取 `CODEARTS_ACCOUNT_XXX` —— 两者错配时
 * 池内账号用户走到 refresh 必抛「未配置凭据，请先登录」。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply, makeAccountRefresher } from '../../src/index.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// 触发层只关心「续期调度」，签到 sweep 会真发网络请求，故整个 mock 掉。
vi.mock('../../src/account-hub-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/account-hub-rpc.js')>()
  return { ...actual, performCheckinSweep: vi.fn() }
})

const REFRESH_INTERVAL_MS = 30 * 60 * 1000

// ── 测试基建（与 plugin.spec.ts / checkin-trigger.spec.ts 同款替身）──────────

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

class FakeCommands {
  readonly definitions: CommandDefinition[] = []
  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

class FakeLlm {
  readonly providers: string[] = []
  readonly adapters: Array<{ providers: string[]; adapter: unknown }> = []
  registerConfigurableProviders(entries: Array<{ provider: string }>): { replace: () => void } {
    for (const entry of entries) this.providers.push(entry.provider)
    return { replace: () => {} }
  }
  registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
    this.adapters.push({ providers, adapter })
    return { replace: () => {} }
  }
}

/**
 * 可控放行的 storage 域替身。
 *
 * `open()` 在 `release()` 之前一直挂起 —— 这是复现「apply 同步期 storage 未就绪」
 * 的唯一手段。返回的文档形状与 `openAccountHubStorage` 的读取口径一致。
 */
function createGatedStorage(accounts: ProviderAccountEntry[]) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let current: Record<string, unknown> = {
    accounts,
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    schemaVersion: 2,
  }
  const opened = vi.fn()
  return {
    release,
    /** `open()` 被调用的次数（用于断言 storage 真的走过主路径）。 */
    opened,
    facility: {
      open: async () => {
        opened()
        await gate
        return {
          global: {
            get: () => current,
            set: async (value: unknown) => { current = value as Record<string, unknown> },
          },
        }
      },
    },
  }
}

function makeContext(storage: unknown, settingsAccounts: unknown[] = []): Context & {
  credentials: FakeCredentials
  llm: FakeLlm
} {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', new FakeCommands() as never)
  const llm = new FakeLlm()
  ctx.provide('llm', llm as never)
  ctx.provide('settings', {
    register: () => ({
      get: () => ({ accounts: settingsAccounts, disabledModels: {}, contextBudgets: {}, schemaVersion: 2 }),
      replace: async () => {},
    }),
    describe: () => [],
  } as never)
  if (storage !== undefined) ctx.provide('storageDomain', storage as never)
  return ctx as Context & { credentials: FakeCredentials; llm: FakeLlm }
}

/** 排空 openStorage 的 then 链与所有待决微任务（多拍，链上有多段 await）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 该次 spy 记录里「30 分钟续期定时器」的注册次数。 */
function refreshTimerCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter((call) => call[1] === REFRESH_INTERVAL_MS).length
}

const refreshableCodeartsAccount = (): ProviderAccountEntry => ({
  id: 'codearts-a1',
  provider: 'codearts',
  nickname: 'codearts-a1',
  enabled: true,
  credentialRef: 'CODEARTS_ACCOUNT_A1',
  createdAt: 1_790_000_000_000,
  refreshable: true,
})

/** 装好各 auth 服务的 refreshAll / backfill spy，避免真实网络与真实定时器副作用。 */
function stubRefreshPipeline(ctx: Context & { credentials: FakeCredentials }): {
  codearts: ReturnType<typeof vi.fn>
  all: Array<ReturnType<typeof vi.fn>>
} {
  const holder = ctx as unknown as Record<string, { refreshAll?: unknown; backfillAccountProfiles?: unknown }>
  const spies: Array<ReturnType<typeof vi.fn>> = []
  for (const name of [
    'codeartsAuth', 'buddyCnAuth', 'buddyAuth', 'lobsteraiAuth', 'traeCnAuth', 'qoderAuth', 'qoderCnAuth',
  ]) {
    const service = holder[name]
    if (service === undefined) continue
    const spy = vi.fn(async () => {})
    ;(service as { refreshAll: unknown }).refreshAll = spy
    spies.push(spy)
    // Qoder 两个 region 的启动资料回填也挂在同一批量链上。
    if (typeof service.backfillAccountProfiles === 'function') {
      ;(service as { backfillAccountProfiles: unknown }).backfillAccountProfiles = vi.fn(async () => {})
    }
  }
  return { codearts: spies[0], all: spies }
}

const disposed: Array<Context> = []
afterEach(async () => {
  for (const ctx of disposed.splice(0)) await ctx.fiber.dispose().catch(() => {})
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// ── R1：定时器注册判据的时序 ────────────────────────────────────────────────

describe('R1：30 分钟续期定时器的注册判据必须等 storage 就绪', () => {
  it('storage 未就绪时不注册定时器；就绪后立即补跑一次续期并注册定时器', async () => {
    const storage = createGatedStorage([refreshableCodeartsAccount()])
    const ctx = makeContext(storage.facility)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    disposed.push(ctx)

    apply(ctx as never)
    const pipeline = stubRefreshPipeline(ctx as never)

    // ① storage 尚未放行：判据必须**未**成立，定时器一个都不该注册。
    await flush(4)
    expect(storage.opened).toHaveBeenCalled()
    expect(
      refreshTimerCount(setIntervalSpy),
      'storage 未就绪就注册了续期定时器：判据读到的不是 storage 里的账号',
    ).toBe(0)

    // ② 放行 storage：就绪后应**立即补跑一次**续期（消除 30 分钟空窗），再注册定时器。
    storage.release()
    await flush()

    expect(
      pipeline.codearts,
      'storage 就绪后没有立即补跑一次 refreshAllCredentials（30 分钟空窗）',
    ).toHaveBeenCalledTimes(1)
    expect(
      refreshTimerCount(setIntervalSpy),
      'storage 就绪后仍未注册 30 分钟续期定时器（判据在 apply 同步期算过 → 恒 false）',
    ).toBe(1)
  })

  it('storage 里全部账号都不可续期时：不补跑、也不注册定时器', async () => {
    const storage = createGatedStorage([{ ...refreshableCodeartsAccount(), refreshable: false }])
    const ctx = makeContext(storage.facility)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    disposed.push(ctx)

    apply(ctx as never)
    const pipeline = stubRefreshPipeline(ctx as never)
    storage.release()
    await flush()

    expect(refreshTimerCount(setIntervalSpy)).toBe(0)
    expect(pipeline.codearts).not.toHaveBeenCalled()
  })

  it('settings 回退路径里的账号不参与判据（判据只认 storage 主路径）', async () => {
    // storage 为空、settings 里有一条可续期账号：storage 已接管时，
    // 读路径走 storage（空表）⇒ 不注册。这条锁的是「判据与读路径同源」。
    const storage = createGatedStorage([])
    const ctx = makeContext(storage.facility, [refreshableCodeartsAccount()])
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    disposed.push(ctx)

    apply(ctx as never)
    const pipeline = stubRefreshPipeline(ctx as never)
    storage.release()
    await flush()

    expect(refreshTimerCount(setIntervalSpy)).toBe(0)
    expect(pipeline.codearts).not.toHaveBeenCalled()
  })

  it('补跑续期失败只记日志，不影响定时器注册（不炸启动）', async () => {
    const storage = createGatedStorage([refreshableCodeartsAccount()])
    const ctx = makeContext(storage.facility)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    disposed.push(ctx)

    apply(ctx as never)
    const pipeline = stubRefreshPipeline(ctx as never)
    pipeline.all.forEach((spy) => spy.mockRejectedValue(new Error('boom')))
    storage.release()
    await flush()

    // 补跑失败不阻断：定时器仍然注册，后续每 30 分钟还有机会。
    expect(refreshTimerCount(setIntervalSpy)).toBe(1)
  })
})

// ── R2：makeAccountRefresher 的选号一致性 ───────────────────────────────────

describe('R2：makeAccountRefresher 与 makeCredentialResolver 挑到同一个账号', () => {
  /** 记录 getAvailableAccount 收到的 (provider, model)，供一致性断言。 */
  function recordingPool(entry: { id: string; credentialRef: string; provider: string } | null) {
    const queries: Array<{ provider: string; model: string }> = []
    return {
      queries,
      pool: {
        getAvailableAccount: async (provider: string, model: string) => {
          queries.push({ provider, model })
          return entry === null ? null : { entry, credential: { access_key_id: 'AK' } }
        },
      },
    }
  }

  it('池内有账号时按其 credentialRef 调 refreshAccountCredential（不碰默认单凭据 ref）', async () => {
    const targets: string[] = []
    const { pool, queries } = recordingPool({
      id: 'codearts-a1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_A1',
    })
    const refresh = makeAccountRefresher(pool as never, 'codearts', {
      refresh: async () => { targets.push('(默认单凭据)') },
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
    })

    await refresh('glm-5.3-flash')

    expect(targets).toEqual(['CODEARTS_ACCOUNT_A1'])
    // model 必须透传：否则会挑回数组顺序最前的账号，重新引入错配。
    expect(queries).toEqual([{ provider: 'codearts', model: 'glm-5.3-flash' }])
  })

  it('池内无账号时回退到默认单凭据 refresh()', async () => {
    const targets: string[] = []
    const { pool } = recordingPool(null)
    const refresh = makeAccountRefresher(pool as never, 'codearts', {
      refresh: async () => { targets.push('(默认单凭据)') },
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
    })

    await refresh()

    expect(targets).toEqual(['(默认单凭据)'])
  })

  it('无账号池时只用默认单凭据 refresh()', async () => {
    const targets: string[] = []
    const refresh = makeAccountRefresher(undefined, 'codearts', {
      refresh: async () => { targets.push('(默认单凭据)') },
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
    })

    await refresh('GLM-5.2')

    expect(targets).toEqual(['(默认单凭据)'])
  })

  it('按 model 过滤后无候选时退回不过滤的查询，仍刷新池内账号（不误报未登录）', async () => {
    // 与 makeAccountPicker 的既定退化同款：全部账号在该模型冷却期内时，
    // 空 modelId 再查一次；拿到账号就刷它，而不是退化成「默认单凭据」——
    // 那会对池内账号用户抛出误导性的「未配置凭据，请先登录」。
    const targets: string[] = []
    const calls: string[] = []
    const pool = {
      getAvailableAccount: async (_provider: string, model: string) => {
        calls.push(model)
        if (model.length === 0) {
          return { entry: { id: 'a1', credentialRef: 'CODEARTS_ACCOUNT_A1' }, credential: {} }
        }
        return null
      },
    }
    const refresh = makeAccountRefresher(pool as never, 'codearts', {
      refresh: async () => { targets.push('(默认单凭据)') },
      refreshAccountCredential: async (ref: string) => { targets.push(ref) },
    })

    await refresh('GLM-5.2')

    expect(calls).toEqual(['GLM-5.2', ''])
    expect(targets).toEqual(['CODEARTS_ACCOUNT_A1'])
  })
})

// ── R2：经真实 apply() 的接线（防「注册处忘了接线」）─────────────────────────

describe('R2：经真实 apply() 接线，codearts 适配器的 refresh 刷的是池内那个账号', () => {
  it('池凭据过期触发续期时，调的是 refreshAccountCredential(池 ref)，不是 refresh()', async () => {
    const storage = createGatedStorage([])
    const ctx = makeContext(storage.facility)
    const credentials = ctx.credentials
    disposed.push(ctx)

    // 池账号的凭据：**已过期**（触发适配器入口的续期分支），但字段齐全。
    await credentials.set('CODEARTS_ACCOUNT_A1', JSON.stringify({
      access_key_id: 'AK-POOL', secret_access_key: 'SK-POOL', security_token: 'ST-POOL',
      expires_at: '2020-01-01T00:00:00Z',
      refresh_token: 'RT', code_verifier: 'CV',
      dpop_private_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    }))
    // 默认单凭据 ref **刻意留空**：若 refresh 走单凭据路径，会以「未配置凭据」失败 ——
    // 这正是 S1 记录的可观测症状。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))

    try {
      apply(ctx as never)
      const pool = (ctx as unknown as { accountPool: { addAccount: (e: unknown) => Promise<void> } }).accountPool
      await pool.addAccount(refreshableCodeartsAccount())

      const codearts = (ctx as unknown as { codeartsAuth: Record<string, unknown> }).codeartsAuth
      const targets: string[] = []
      codearts.refreshAccountCredential = (async (ref: string) => { targets.push(ref) }) as never
      codearts.refresh = (async () => { targets.push('(默认单凭据)') }) as never

      const registered = ctx.llm.adapters.find((item) => item.providers.includes('codearts'))
      expect(registered, 'codearts 适配器必须已注册').toBeDefined()
      const adapter = registered!.adapter as { stream: (o: unknown) => AsyncIterable<unknown> }

      // 只要触发到入口的续期分支即可；随后的出站请求 404，错误与断言无关。
      await (async () => {
        for await (const _ of adapter.stream({
          model: 'GLM-5.2', messages: [], signal: new AbortController().signal,
        })) { /* drain */ }
      })().catch(() => {})

      expect(targets).toEqual(['CODEARTS_ACCOUNT_A1'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
