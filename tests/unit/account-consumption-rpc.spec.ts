/**
 * 「消耗顺序 / 切换粒度」的 **RPC 面 + 宿主接线**测试。
 *
 * 纯逻辑（`account-consumption.spec.ts`）与池行为（`account-consumption-pool.spec.ts`）
 * 已各自守住；本文件补的是**两端之间的那一段**，也正是最容易静默断掉的地方：
 *
 * 1. **RPC 读写**：`consumption.get` / `consumption.set` 的端点注册、响应形状、
 *    非法档位拒绝（错误原文带回可选值），以及**部分更新**语义。
 * 2. **余额缓存刷新的按档过滤**：只为「最高优先」档的 provider 发请求 —— 七个
 *    provider 全刷是几十个网络往返，而只有开了那一档的才真的会读这些数字。
 * 3. **`options.signal` 必须被适配器透传**（静态断言）：DSH 的 `GenerateOptions`
 *    里没有 turn 级字段，signal 是**唯一**的轮次标识；任何一处漏传都让「按轮次」
 *    档静默失效，而那种失效完全没有报错。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectProviderBalances,
  refreshConsumptionBalances,
  registerAccountHubRpc,
} from '../../src/account-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 读宿主源文件（归一化 CRLF），供源码级接线断言使用。 */
function readSource(relative: string): string {
  return readFileSync(resolve(here, relative), 'utf8').replace(/\r\n/g, '\n')
}

const ACCOUNT: ProviderAccountEntry = {
  id: 'buddy-cn-001',
  provider: 'buddy-cn',
  nickname: '测试',
  enabled: true,
  credentialRef: 'BUDDY_CN_ACCOUNT_A1',
  createdAt: 1_789_000_000_000,
  refreshable: true,
}

/** 构造一个能调 RPC 端点的替身环境。 */
function makeEndpointHarness(options: { consumption?: Record<string, unknown> } = {}) {
  let stored: Record<string, unknown> = {
    accounts: [ACCOUNT],
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    consumption: options.consumption ?? {},
    consumptionCursors: {},
    schemaVersion: 3,
  }
  type Handler = (request: Request) => Promise<Response>
  let handler: Handler | undefined
  const writes: Array<Record<string, unknown>> = []

  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => {
              stored = value
              writes.push(value)
            },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      resolve: async () => ({ value: JSON.stringify({ access_token: 't' }), source: 'test' as const }),
      set: async () => {},
      unset: async () => {},
    },
  } as never)

  const ctx = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      : undefined,
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  registerAccountHubRpc(
    ctx as never, pool, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'account-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
    return body.result
  }

  return { call, pool, storedValue: () => stored, writes }
}

describe('consumption.get / consumption.set 端点', () => {
  it('未配置过时 get 返回默认值（遍历 + 按轮次），而不是 undefined', async () => {
    const h = makeEndpointHarness()
    const result = await h.call('consumption.get', { provider: 'buddy-cn' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      provider: 'buddy-cn',
      consumption: { order: 'round-robin', switch: 'per-turn' },
    })
  })

  it('set 写入后 get 读回同一个值（往返一致）', async () => {
    const h = makeEndpointHarness()
    // 用**非默认档**（顺序）：写默认档等于删键，验不出往返。
    const written = await h.call('consumption.set', { provider: 'buddy-cn', order: 'sequential' })
    expect(written.ok).toBe(true)
    // 响应里回传**写入后的权威配置**，客户端据此对齐选中态（不做乐观更新）。
    expect(written.value).toEqual({
      provider: 'buddy-cn',
      consumption: { order: 'sequential', switch: 'per-turn' },
    })
    const read = await h.call('consumption.get', { provider: 'buddy-cn' })
    expect((read.value as { consumption: unknown }).consumption)
      .toEqual({ order: 'sequential', switch: 'per-turn' })
  })

  it('把档位改回默认（遍历）时读到默认值 —— 与「从没配过」表现一致但却是真实写入', async () => {
    const h = makeEndpointHarness()
    const written = await h.call('consumption.set', { provider: 'buddy-cn', order: 'round-robin' })
    expect(written.value).toEqual({
      provider: 'buddy-cn',
      consumption: { order: 'round-robin', switch: 'per-turn' },
    })
  })

  it('**部分更新**：只传 switch 不会把 order 重置回默认', async () => {
    const h = makeEndpointHarness()
    await h.call('consumption.set', { provider: 'buddy-cn', order: 'highest-balance' })
    // 第二个选择器（切换粒度）只发自己那一个字段。
    const second = await h.call('consumption.set', { provider: 'buddy-cn', switch: 'per-request' })
    expect(second.value).toEqual({
      provider: 'buddy-cn',
      consumption: { order: 'highest-balance', switch: 'per-request' },
    })
  })

  it('非法档位被拒绝，且错误原文里**带着可选值**（用户唯一能据以改正的信息）', async () => {
    const h = makeEndpointHarness()
    const bad = await h.call('consumption.set', { provider: 'buddy-cn', order: 'bogus' })
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toContain('消耗顺序')
    expect(bad.error?.message).toContain('sequential')
    expect(bad.error?.message).toContain('round-robin')
    // 拒绝之后存储保持干净：不能留下半截写入。
    expect(h.pool.allConsumption()).toEqual({})
  })

  it('非法切换粒度同样被拒绝并列出可选值', async () => {
    const h = makeEndpointHarness()
    const bad = await h.call('consumption.set', { provider: 'buddy-cn', switch: 'sometimes' })
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toContain('切换粒度')
    expect(bad.error?.message).toContain('per-turn')
  })

  it('provider 缺失 / 空串一律拒绝（而不是写进一个空键）', async () => {
    const h = makeEndpointHarness()
    expect((await h.call('consumption.get', {})).ok).toBe(false)
    expect((await h.call('consumption.set', { provider: '', order: 'round-robin' })).ok).toBe(false)
    expect((await h.call('consumption.get', { provider: 7 })).ok).toBe(false)
  })

  it('两个新字段随任意一次写入一起落盘（不被别的写路径清空）', async () => {
    const h = makeEndpointHarness()
    // 写**非默认档**（顺序）才落键；默认档会被剔除（等于「没配过」）。
    await h.call('consumption.set', { provider: 'buddy-cn', order: 'sequential' })
    const last = h.storedValue()
    // 八件套齐全（含 provider 体检闸门 —— 漏带会让体检每次启动重跑）。
    expect(Object.keys(last).sort()).toEqual([
      'accounts', 'checkins', 'consumption', 'consumptionCursors',
      'contextBudgets', 'disabledModels', 'providerAuditVersion', 'schemaVersion',
    ])
    expect(last.consumption).toEqual({ 'buddy-cn': { order: 'sequential', switch: 'per-turn' } })
  })

  it('未知方法仍然报 bad-request（default 分支未被新 case 破坏）', async () => {
    const h = makeEndpointHarness()
    const result = await h.call('consumption.nope', { provider: 'buddy-cn' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('unknown method')
  })
})

describe('余额缓存刷新：只为「最高优先」档的 provider 发请求', () => {
  /** 构造 `refreshConsumptionBalances` 的依赖替身；记录被查过余额的 provider。 */
  function makeBalanceHarness(consumption: Record<string, { order: string; switch: string }>) {
    const queried: string[] = []
    const recorded: Array<{ provider: string; entries: Array<{ accountId: string; total: number }> }> = []
    const pool = {
      allConsumption: () => consumption,
      listAccounts: async (provider: string) => {
        queried.push(provider)
        return [{ ...ACCOUNT, provider, id: `${provider}-1`, credentialRef: 'BUDDY_CN_ACCOUNT_A1' }]
      },
      recordBalances: (provider: string, entries: Array<{ accountId: string; total: number }>) => {
        recorded.push({ provider, entries })
      },
    }
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      credentials: {
        // 交回一份「余额查询成功」的最小形状：`collectCreditBalances` 走注入的
        // fetchBalance，这里只提供可解析的凭据。
        resolve: async () => ({ value: JSON.stringify({ access_token: 't' }), source: 'test' as const }),
      },
    }
    return { pool, ctx, queried, recorded }
  }

  it('只有开了 highest-balance 的 provider 被查询（顺序 / 遍历档一个都不碰）', async () => {
    const h = makeBalanceHarness({
      'buddy-cn': { order: 'highest-balance', switch: 'per-turn' },
      qoder: { order: 'round-robin', switch: 'per-turn' },
      'trae-cn': { order: 'sequential', switch: 'per-request' },
    })
    // 用 buddy 系（默认 productById 分支）的收集器：它的 fetchBalance 会真发请求，
    // 故注入一个 fetcher 替身，让整条链在不触网的情况下跑完。
    const deps = {
      pool: h.pool as never,
      ctx: {
        ...h.ctx,
        get: () => undefined,
      } as never,
      qoder: {} as never,
      qoderCn: {} as never,
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { Accounts: [{ Status: 1, Dosage: { TotalDosage: 500, RemainDosage: 300 } }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    // `collectProviderBalances` 走的是模块内默认实现（fetcher 取全局 fetch），
    // 因此这里替换全局 fetch。
    const original = globalThis.fetch
    globalThis.fetch = fetcher as unknown as typeof fetch
    try {
      const refreshed = await refreshConsumptionBalances(deps)
      expect(refreshed).toEqual(['buddy-cn'])
      expect(h.queried).toEqual(['buddy-cn'])
      expect(h.recorded.map(r => r.provider)).toEqual(['buddy-cn'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('没有 provider 开最高优先档时一次请求都不发', async () => {
    const h = makeBalanceHarness({ 'buddy-cn': { order: 'sequential', switch: 'per-turn' } })
    const fetcher = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetcher as unknown as typeof fetch
    try {
      const refreshed = await refreshConsumptionBalances({
        pool: h.pool as never, ctx: { ...h.ctx, get: () => undefined } as never,
        qoder: {} as never, qoderCn: {} as never,
      })
      expect(refreshed).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
      expect(h.queried).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it('单个 provider 查询失败不中断其余（逐个 try，且不抛给调用方）', async () => {
    const broken = new Error('boom')
    const pool = {
      allConsumption: () => ({
        'buddy-cn': { order: 'highest-balance', switch: 'per-turn' },
        'trae-cn': { order: 'highest-balance', switch: 'per-turn' },
      }),
      listAccounts: async (provider: string) => {
        if (provider === 'buddy-cn') throw broken
        return []
      },
      recordBalances: () => {},
    }
    const refreshed = await refreshConsumptionBalances({
      pool: pool as never,
      ctx: { logger: { warn: () => {}, info: () => {} }, credentials: { resolve: async () => undefined } } as never,
      qoder: {} as never, qoderCn: {} as never,
    })
    // buddy-cn 失败被吞掉（只记 warn），trae-cn 仍被处理到（它的账号列表为空，
    // 因此不产生任何记录，但仍算「刷过」）。
    expect(refreshed).toEqual(['trae-cn'])
  })

  it('collectProviderBalances 对未知 provider 回 undefined（调用方据此报错）', async () => {
    const pool = { listAccounts: async () => [], allConsumption: () => ({}), recordBalances: () => {} }
    const values = await collectProviderBalances({
      pool: pool as never,
      ctx: { logger: { warn: () => {} }, credentials: { resolve: async () => undefined } } as never,
      qoder: {} as never, qoderCn: {} as never,
    }, 'no-such-provider')
    expect(values).toBeUndefined()
  })
})

describe('轮次标识（options.signal）必须被适配器透传 —— 唯一轮次标识', () => {
  /**
   * ⚠️ 这是**静态断言**，不是渲染测试：DSH 的 `GenerateOptions` 里没有 turn 级
   * 字段（`sessionId` 是会话级、跨轮稳定），`options.signal` 是 adapter 唯一能拿到的
   * 轮次标识（agent-loop 每个 turn 换一次 AbortController）。
   *
   * 漏传的失效形态完全没有报错：用户配了「按轮次」，实际每个 step 都换号。
   * 因此把「每个适配器的每一处 resolveCredential / refresh 都带第二个实参」
   * 变成可执行的断言。
   */
  const ADAPTERS = [
    'src/llm-adapter.ts',
    'src/buddy-adapter.ts',
    'src/lobsterai-adapter.ts',
    'src/trae-cn-adapter.ts',
    'src/qoder-adapter.ts',
  ] as const

  it.each(ADAPTERS)('%s 的每个 options.resolveCredential/refresh 调用都传了轮次标识', (file) => {
    const source = readSource(`../../${file}`)
    // 匹配 `this.options.resolveCredential(` / `this.options.refresh(` 后面的实参列表。
    const calls = [...source.matchAll(/this\.options\.(resolveCredential|refresh)\(([^)]*)\)/g)]
    expect(calls.length, `${file} 里没有找到任何 resolveCredential/refresh 调用`).toBeGreaterThan(0)
    for (const call of calls) {
      const args = call[2]!
      // 「拉目录」路径刻意不传 model（目录对所有模型一致），此时也不该传轮次标识
      // —— 它不是一次对话请求。故只要求：**只要传了 model，就必须一起传轮次标识**。
      if (!args.includes('options.model')) continue
      expect(
        args.includes('options.signal'),
        `${file} 的 this.options.${call[1]}(${args}) 漏传了轮次标识（options.signal）`
        + '：那会让「按轮次」档在这条路径上静默失效',
      ).toBe(true)
    }
  })

  it.each(ADAPTERS)('%s 的 options 类型声明了第二个（轮次标识）参数', (file) => {
    const source = readSource(`../../${file}`)
    expect(source).toMatch(/resolveCredential: \(model\?: string, turnIdentity\?: unknown\)/)
    expect(source).toMatch(/refresh: \(model\?: string, turnIdentity\?: unknown\)/)
  })

  it('宿主侧把 signal 换算成轮次键，且 resolver / refresher 共用同一个换算器', () => {
    const source = readSource('../../src/index.ts')
    // 换算器必须是**模块级单例**：两处各持一个会让同一个 signal 得到两个键，
    // 于是续期挑到另一个账号（S1 缺陷在「按轮次」档下复现）。
    expect(source).toMatch(/^const turnKeys = new TurnKeyTracker\(\)$/m)
    expect([...source.matchAll(/turnKeys\.keyFor\(/g)]).toHaveLength(1)
    // resolver 与 refresher 都必须把第二参原样透传给 pick。
    expect(source).toMatch(/makeCredentialResolver<T>\([\s\S]*?const available = await pick\(model, turnIdentity\)/)
    expect(source).toMatch(/makeAccountRefresher\([\s\S]*?const available = await pick\(model, turnIdentity\)/)
  })

  it('余额缓存刷新挂在 storage 就绪之后，并登记了定时器清理', () => {
    const source = readSource('../../src/index.ts')
    // 时序：storage 接管前读到的是旧快照 / 空表 ⇒ 一个 provider 都筛不出来。
    expect(source).toMatch(/void pool\.openStorage\(\)\.then\(\(\) => queueMicrotask\(runBalanceRefresh\)\)/)
    // 定时器必须 unref + effect 清理（与签到 sweep、续期调度同款形态）。
    expect(source).toMatch(/const balanceTimer = setInterval\(runBalanceRefresh, REFRESH_BALANCES_INTERVAL_MS\)/)
    expect(source).toMatch(/balanceTimer\.unref\?\.\(\)/)
    expect(source).toMatch(/clearInterval\(balanceTimer\)/)
  })
})
