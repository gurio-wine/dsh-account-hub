/**
 * 自动签到「宿主触发层」的单元测试。
 *
 * ## 覆盖什么
 *
 * `src/index.ts` 的 `apply()` 末尾做的两件事（设计文档 §4「宿主触发」）：
 *   1. **启动 sweep**：挂在 `pool.openStorage().then()` 之后 fire-and-forget，
 *      保证 storage 就绪后才读 `checkinDay`；不 await、不阻塞 apply 返回；
 *   2. **每 4h 定时 sweep**：`setInterval`，且 `ctx.effect` 登记 `clearInterval`
 *      （dispose 时清理）。
 *
 * 这里把 `performCheckinSweep`（account-hub-rpc 导出）mock 成 spy，只验证
 * 触发层本身的**时机与生命周期**，不重复测 sweep 内部的执行逻辑
 * （那是 `checkin-rpc.spec.ts` 的职责）。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../../src/index.js'
import { performCheckinSweep } from '../../src/account-hub-rpc.js'

// 只 mock 触发层的入口函数，保留 registerAccountHubRpc 等其余导出真实实现。
vi.mock('../../src/account-hub-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/account-hub-rpc.js')>()
  return { ...actual, performCheckinSweep: vi.fn() }
})

const mockedSweep = vi.mocked(performCheckinSweep)

const AUTO_CHECKIN_INTERVAL_MS = 4 * 60 * 60 * 1000

// ── 测试基建（与 plugin.spec.ts 同款替身，apply 才能真实跑通）──────────────

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
  readonly adapters: string[] = []
  readonly configurableProviders: Array<{ provider: string; displayName?: string; settingsNs?: string }> = []
  readonly registeredProviders: string[] = []
  registerConfigurableProviders(
    entries: Array<{ provider: string; displayName?: string; settingsNs?: string }>,
  ): { replace: () => void } {
    for (const entry of entries) {
      this.providers.push(entry.provider)
      this.configurableProviders.push(entry)
    }
    return { replace: () => {} }
  }
  registerAdapter(providers: string[], _adapter: unknown): { replace: () => void } {
    this.adapters.push(...providers)
    this.registeredProviders.push(...providers)
    return { replace: () => {} }
  }
}

class FakeSettings {
  readonly registeredNamespaces: string[] = []
  register(ns: string): void {
    if (!this.registeredNamespaces.includes(ns)) this.registeredNamespaces.push(ns)
  }
  describe(): Array<{ ns: string }> {
    return this.registeredNamespaces.map((ns) => ({ ns }))
  }
}

/** 与 plugin.spec.ts 一致的最小上下文：无 storageDomain（池仅内存）、无 connection。 */
function makeContext(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  return ctx
}

/** 排空 `openStorage().then(...)` 链与 `queueMicrotask`。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

// ── 启动 sweep ──────────────────────────────────────────────────────────────

describe('自动签到宿主触发层：启动 sweep', () => {
  it('apply 同步返回，启动 sweep 挂在 openStorage 之后异步跑、不阻塞 apply', async () => {
    const ctx = makeContext()
    apply(ctx)
    // apply() 是同步签名，此处已返回；sweep 仍在 openStorage 的 then 链里（异步）。
    expect(mockedSweep).not.toHaveBeenCalled()
    await flushMicrotasks()
    // storage（这里降级内存）就绪后启动 sweep 恰好一次。
    expect(mockedSweep).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })
})

// ── 4h 定时器 ───────────────────────────────────────────────────────────────

describe('自动签到宿主触发层：4h 定时器', () => {
  it('启动一次 + 4h 后再触发一次 → sweep 共被调两次', async () => {
    vi.useFakeTimers()
    const ctx = makeContext()
    apply(ctx)
    await flushMicrotasks()
    // 启动 sweep 先跑一次。
    expect(mockedSweep).toHaveBeenCalledTimes(1)
    mockedSweep.mockClear()

    // 推进一个完整周期 → 定时器触发第二次。
    vi.advanceTimersByTime(AUTO_CHECKIN_INTERVAL_MS)
    await flushMicrotasks()
    expect(mockedSweep).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('dispose 时清理 4h 定时器（此后推进时间不再触发）', async () => {
    vi.useFakeTimers()
    const ctx = makeContext()
    apply(ctx)
    await flushMicrotasks()
    expect(mockedSweep).toHaveBeenCalledTimes(1)
    mockedSweep.mockClear()

    // 插件停用：ctx.effect 登记的 clearInterval 应清理定时器。
    await ctx.fiber.dispose()
    vi.advanceTimersByTime(AUTO_CHECKIN_INTERVAL_MS)
    await flushMicrotasks()
    // 已清理 → 不再触发。
    expect(mockedSweep).not.toHaveBeenCalled()
  })

  it('多个周期持续触发（定时器未被提前清掉）', async () => {
    vi.useFakeTimers()
    const ctx = makeContext()
    apply(ctx)
    await flushMicrotasks()
    mockedSweep.mockClear()

    // 连续推进三餐四周期，每次都应触发。
    vi.advanceTimersByTime(AUTO_CHECKIN_INTERVAL_MS)
    vi.advanceTimersByTime(AUTO_CHECKIN_INTERVAL_MS)
    await flushMicrotasks()
    expect(mockedSweep).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })
})