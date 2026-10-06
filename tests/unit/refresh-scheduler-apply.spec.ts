import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'

class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: 'fake', writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; infos: string[]; warns: string[] } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace: () => {} }),
    registerAdapter: () => ({ replace: () => {} }),
  } as never)
  let stored: unknown = { accounts: [], disabledModels: {}, contextBudgets: {}, checkins: {}, consumption: {}, consumptionCursors: {}, autoRoute: {}, schemaVersion: 6, providerAuditVersion: 1 }
  ctx.provide('settings', {
    register: () => ({
      get: () => stored,
      replace: async (value: unknown) => { stored = value },
    }),
    describe: () => [],
  } as never)
  const infos: string[] = []
  const warns: string[] = []
  const logger = ctx.logger as unknown as Record<string, unknown>
  logger.info = (...args: unknown[]) => { infos.push(args.map(String).join(' ')) }
  logger.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
  return { ctx, infos, warns }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0)
}

describe('续期调度器真实 apply() 接线（issue IKJOZB）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('冷启动空池也武装，并记录空池日志与首轮续期', async () => {
    const { ctx, infos } = makeContext()
    apply(ctx)
    await settle()
    expect(infos.some((message) => message.includes('多账号续期调度器已武装'))).toBe(true)
    expect(infos.some((message) => message.includes('账号池为空'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('空池入库后调度器保持工作，周期续期可见新账号', async () => {
    const { ctx, infos } = makeContext()
    apply(ctx)
    await settle()
    const pool = (ctx as unknown as { accountPool: { addAccount: (entry: unknown) => Promise<void> } }).accountPool
    await pool.addAccount({
      id: 'probe-login-1', provider: 'codearts', nickname: 'probe', enabled: true,
      credentialRef: 'CODEARTS_PROBE', createdAt: Date.now(), expiresAt: Date.now() + 7_200_000,
      refreshable: true,
    })
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(infos.some((message) => message.includes('正在补武装'))).toBe(false)
    await ctx.fiber.dispose()
  })

  it('空池下连续多个周期不会自毁定时器', async () => {
    const { ctx, infos } = makeContext()
    apply(ctx)
    await settle()
    const armedCount = infos.filter((message) => message.includes('多账号续期调度器已武装')).length
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(infos.filter((message) => message.includes('账号池仍为空')).length).toBeGreaterThanOrEqual(2)
    expect(infos.filter((message) => message.includes('多账号续期调度器已武装')).length).toBe(armedCount)
    await ctx.fiber.dispose()
  })
})
