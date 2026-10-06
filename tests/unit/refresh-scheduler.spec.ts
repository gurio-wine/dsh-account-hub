import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultiAccountRefreshScheduler } from '../../src/refresh-scheduler.js'

function makeRefreshLog(): { calls: number; refresh: () => Promise<void> } {
  const result = { calls: 0, refresh: async (): Promise<void> => { result.calls++ } }
  return result
}

describe('MultiAccountRefreshScheduler：无条件武装与首轮续期', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('空池时仍武装定时器并执行首轮与后续轮', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1_000,
      isPoolEmpty: async () => true,
    })
    await scheduler.start()
    expect(scheduler.isArmed()).toBe(true)
    expect(log.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log.calls).toBe(2)
    scheduler.stop()
  })

  it('start() 立即执行首轮，不等待完整周期', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 60_000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    expect(log.calls).toBe(1)
    scheduler.stop()
  })

  it('notifyAccountAdded 在未武装时补起调度器', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1_000,
      isPoolEmpty: async () => false,
    })
    scheduler.notifyAccountAdded()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isArmed()).toBe(true)
    expect(log.calls).toBe(1)
    scheduler.stop()
  })

  it('已武装时重复通知不会叠加定时器', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1_000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    scheduler.notifyAccountAdded()
    scheduler.notifyAccountAdded()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log.calls).toBe(2)
    scheduler.stop()
  })

  it('stop() 后不再续期且可重新 start()', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1_000,
      isPoolEmpty: async () => false,
    })
    await scheduler.start()
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(log.calls).toBe(1)
    await scheduler.start()
    expect(log.calls).toBe(2)
    scheduler.stop()
  })

  it('refresh 抛错不会打死后续周期', async () => {
    let calls = 0
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: async () => { calls++; throw new Error('boom') },
      intervalMs: 1_000,
      isPoolEmpty: async () => false,
      warn: () => {},
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toBe(3)
    expect(scheduler.isArmed()).toBe(true)
    scheduler.stop()
  })

  it('空池探测抛错时仍执行续期并保持调度器', async () => {
    const log = makeRefreshLog()
    const scheduler = new MultiAccountRefreshScheduler({
      refresh: log.refresh,
      intervalMs: 1_000,
      isPoolEmpty: async () => { throw new Error('storage down') },
      warn: () => {},
    })
    await scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(log.calls).toBe(2)
    expect(scheduler.isArmed()).toBe(true)
    scheduler.stop()
  })
})
