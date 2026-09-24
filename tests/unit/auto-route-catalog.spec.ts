/**
 * 「自动路由编辑器」的**数据通路**测试：RPC `autoroute.catalog` / `autoroute.model-info`。
 *
 * 编辑器要支持「任意供应商的任意模型」，故这两条端点是**只读的聚合查询**，与
 * `autoroute.get` / `autoroute.set`（配置读写）职责不同：
 *
 * 1. `autoroute.catalog` 把 `ctx.llm.listProviders()` 与逐个目录查询收成两级目录。
 *    **数据源是混合的**（2026-09-23 修复门控泄漏）：`modelAdapters` 里有条目的
 *    provider（本插件七个）走适配器实例的 `listAllModels()` —— 与 `model.list`
 *    同源、**不套目录门控也不套黑名单**；没有条目的（DSH 内置 / 其它插件）才回落
 *    `ctx.llm.listModels()`。理由：本插件适配器的 `listModels` 套
 *    `providerCatalogVisible`，用户一开自动路由开关，本插件七个 provider 全被
 *    隐藏 ⇒ 编辑器一个模型都选不出来（正是「开启后加不了候选」的根因）。
 *    四条判据在这里锁死：
 *    - **`auto-route` 自身必须被排除**（用户明令）：把虚拟 provider 列进自己的候选，
 *      等于让用户配出「自动路由委派给自动路由」，运行时无限递归；
 *    - **单个 provider 的目录失败不得炸掉整条端点**：一个远端目录超时不该让编辑器
 *      连别的供应商都看不到 —— 该组记空列表、其余照常返回；
 *    - **适配器条目存在时绝不回落到 `listModels`**：回落就把门控泄漏带回来了；
 *    - 模型条目**只透出 `{ id, name }`**：宿主 `LlmModelInfo` 还带 `provider` /
 *      `description` / `inputModalities`，编辑器用不到，照抄出去只是把宿主字段名
 *      变成客户端的隐性契约。
 * 2. `autoroute.model-info` 是**尽力而为**的档位查询：没有档位、provider 不认这个
 *    模型、适配器抛错 —— 三种都回 `{}` 而不是报错。报错会让编辑器显示「加载失败」，
 *    而真实语义是「该模型无档位可选」（如 codearts 全系）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { AUTO_ROUTE_PROVIDER_ID } from '../../src/auto-route.js'

/** `ctx.llm` 替身：三个方法都可由用例改写（`resolveModelInfo` 默认返回无档位）。 */
interface FakeLlm {
  listProviders: () => Array<{ id: string; name: string }>
  listModels: (provider: string) => Promise<Array<Record<string, unknown>>>
  resolveModelInfo: (provider: string, model: string) => Promise<Record<string, unknown>>
}

function makeHarness(llm: Partial<FakeLlm> | undefined) {
  const warn = vi.fn()
  let handler: ((request: Request) => Promise<Response>) | undefined

  let doc: Record<string, unknown> = {
    accounts: [],
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    consumption: {},
    consumptionCursors: {},
    schemaVersion: 0,
    providerAuditVersion: 0,
  }

  const ctx = {
    get: (key: string) => {
      if (key === 'llm') return llm
      if (key === 'storageDomain') {
        return {
          open: async () => ({
            global: { get: () => doc, set: async (next: Record<string, unknown>) => { doc = next } },
            close: async () => {},
          }),
        }
      }
      if (key === 'settings') {
        return {
          register: () => ({
            get: () => doc,
            replace: async (next: Record<string, unknown>) => { doc = next },
          }),
        }
      }
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { fetch: (request: Request) => Promise<Response> }) => {
              handler = config.fetch
            },
          },
        }
      }
      return undefined
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn, info: () => {}, error: () => {} },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      resolve: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
  }

  const call = async (method: string, payload: unknown) => {
    if (handler === undefined) throw new Error('endpoint handler was not registered')
    const response = await handler(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'account-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    }
    return body.result
  }

  return { ctx, call, warn }
}

/** `modelAdapters`（`registerAccountHubRpc` 的 `modelAdapters` 字段）的替身形状：只声明 `listAllModels`。 */
type FakeAdapters = Readonly<Record<string, { listAllModels: () => ReadonlyArray<{ id: string; name: string }> }>>

async function setup(llm: Partial<FakeLlm> | undefined, modelAdapters?: FakeAdapters) {
  const h = makeHarness(llm)
  const pool = new AccountPool(h.ctx as never)
  await pool.openStorage()
  registerAccountHubRpc({
    ctx: h.ctx as never,
    pool,
    codearts: {} as never,
    buddyCn: {} as never,
    buddy: {} as never,
    lobsterai: {} as never,
    traeCn: {} as never,
    qoder: {} as never,
    qoderCn: {} as never,
    modelAdapters,
  })
  return h
}

/** 三个 provider 的目录：`p-empty` 无模型、`p-multi` 两个模型、`auto-route` 自身。 */
function threeProviderLlm(overrides: Partial<FakeLlm> = {}): Partial<FakeLlm> {
  return {
    listProviders: () => [
      { id: 'p-empty', name: '空目录供应商' },
      { id: AUTO_ROUTE_PROVIDER_ID, name: '自动路由' },
      { id: 'p-multi', name: '多模型供应商' },
    ],
    listModels: async (provider: string) => {
      if (provider === 'p-multi') {
        return [
          { provider, id: 'm-1', name: '模型一', description: '说明', inputModalities: ['text'] },
          { provider, id: 'm-2', name: '模型二' },
        ]
      }
      return []
    },
    ...overrides,
  }
}

describe('autoroute.catalog：供应商 × 模型两级目录', () => {
  it('按 listProviders 顺序收组、模型只透出 { id, name }，且**排除 auto-route 自身**', async () => {
    const h = await setup(threeProviderLlm())
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    // 顺序 = listProviders 顺序（去掉 auto-route 后为 p-empty、p-multi）。
    expect(result.value).toEqual({
      providers: [
        { id: 'p-empty', name: '空目录供应商', models: [] },
        {
          id: 'p-multi',
          name: '多模型供应商',
          models: [{ id: 'm-1', name: '模型一' }, { id: 'm-2', name: '模型二' }],
        },
      ],
    })
    // 宿主字段（provider / description / inputModalities）不得漏进模型条目。
    const providers = (result.value as { providers: Array<{ models: unknown[] }> }).providers
    expect(Object.keys(providers[1]!.models[0] as object).sort()).toEqual(['id', 'name'])
    // 自引用判据：虚拟 provider 绝不能出现在候选里。
    expect(JSON.stringify(result.value)).not.toContain(AUTO_ROUTE_PROVIDER_ID)
  })

  it('某个 provider 的 listModels 抛错 → 该组空列表、其余完好、整条端点不抛', async () => {
    const h = await setup(threeProviderLlm({
      listModels: async (provider: string) => {
        if (provider === 'p-empty') throw new Error('远端目录超时')
        return [{ provider, id: 'm-1', name: '模型一' }]
      },
    }))
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      providers: [
        { id: 'p-empty', name: '空目录供应商', models: [] },
        { id: 'p-multi', name: '多模型供应商', models: [{ id: 'm-1', name: '模型一' }] },
      ],
    })
    // 失败必须留痕：静默吞掉会让「某供应商永远没有模型」无从排查。
    // 只看**目录相关**的那条 —— 建池本身也会 warn（缺 dshHomePath 跳过一次性迁移），
    // 与本次无关，不该被算进来。
    const catalogWarns = h.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('模型目录失败'))
    expect(catalogWarns).toHaveLength(1)
    expect(catalogWarns[0]).toContain('p-empty')
    // 失败的那一组**只影响自己**：p-multi 照常有模型。
    expect((result.value as { providers: Array<{ id: string; models: unknown[] }> }).providers[1]!.models)
      .toHaveLength(1)
  })

  it('llm 服务不可用 → bad-request（不是空目录，两者语义不同）', async () => {
    const h = await setup(undefined)
    const result = await h.call('autoroute.catalog', {})
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })
})

/**
 * 门控泄漏回归（本文件的核心新增）：`ctx.llm.listModels` 是**被门控的路径** ——
 * 本插件适配器套 `providerCatalogVisible`，用户一开自动路由总开关，七个 provider
 * 全部返回 `[]`（对话框里隐藏它们是需求本身）。但编辑器要「加候选」，必须看得见
 * 模型；若 catalog 照旧走 `listModels`，用户开启开关后一个模型都选不出来。
 */
describe('autoroute.catalog：本插件 provider 走适配器目录（不受自动路由门控影响）', () => {
  /** 门控生效的 `listModels`：本插件 provider 一律 `[]`，DSH 内置 provider 正常。 */
  function gatedLlm(): Partial<FakeLlm> {
    return {
      listProviders: () => [
        { id: 'buddy-cn', name: 'CodeBuddy 中国版' },
        { id: 'dsh-builtin', name: 'DSH 内置' },
      ],
      listModels: async (provider: string) => provider === 'dsh-builtin'
        ? [{ provider, id: 'builtin-1', name: '内置模型' }]
        : [],
    }
  }

  it('有适配器条目的 provider → 模型非空且来自 listAllModels（门控返回 [] 也不受影响）', async () => {
    const h = await setup(gatedLlm(), {
      'buddy-cn': {
        listAllModels: () => [
          { id: 'cb-1', name: 'CodeBuddy 模型一（倍率 1x）' },
          { id: 'cb-2', name: 'CodeBuddy 模型二' },
        ],
      },
    })
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      providers: [
        {
          id: 'buddy-cn',
          name: 'CodeBuddy 中国版',
          models: [
            { id: 'cb-1', name: 'CodeBuddy 模型一（倍率 1x）' },
            { id: 'cb-2', name: 'CodeBuddy 模型二' },
          ],
        },
        { id: 'dsh-builtin', name: 'DSH 内置', models: [{ id: 'builtin-1', name: '内置模型' }] },
      ],
    })
  })

  it('无适配器条目的 provider → 仍回落 ctx.llm.listModels（DSH 内置 / 其它插件不经过本插件门控）', async () => {
    const listModels = vi.fn(async (provider: string) => provider === 'dsh-builtin'
      ? [{ provider, id: 'builtin-1', name: '内置模型' }]
      : [])
    const h = await setup({ ...gatedLlm(), listModels }, {
      'buddy-cn': { listAllModels: () => [{ id: 'cb-1', name: '模型一' }] },
    })
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    // 只对**没有适配器条目**的那个 provider 发起宿主查询；有适配器的一个都不查。
    expect(listModels.mock.calls.map((call) => call[0])).toEqual(['dsh-builtin'])
    const providers = (result.value as { providers: Array<{ id: string; models: unknown[] }> }).providers
    expect(providers[0]!.models).toHaveLength(1)
    expect(providers[1]!.models).toHaveLength(1)
  })

  it('适配器的 listAllModels 抛错 → 该组空列表 + warn、其余完好（逐组收窄失败面）', async () => {
    const h = await setup(gatedLlm(), {
      'buddy-cn': {
        listAllModels: () => { throw new Error('适配器目录未就绪') },
      },
    })
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      providers: [
        { id: 'buddy-cn', name: 'CodeBuddy 中国版', models: [] },
        { id: 'dsh-builtin', name: 'DSH 内置', models: [{ id: 'builtin-1', name: '内置模型' }] },
      ],
    })
    const catalogWarns = h.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('模型目录失败'))
    expect(catalogWarns).toHaveLength(1)
    expect(catalogWarns[0]).toContain('buddy-cn')
  })

  it('省略 `modelAdapters` 字段（headless / 测试降级）→ 全部回落 ctx.llm.listModels（历史行为）', async () => {
    const listModels = vi.fn(async (provider: string) => [{ provider, id: 'm-1', name: '模型一' }])
    const h = await setup({ ...gatedLlm(), listModels })
    const result = await h.call('autoroute.catalog', {})

    expect(result.ok).toBe(true)
    expect(listModels.mock.calls.map((call) => call[0])).toEqual(['buddy-cn', 'dsh-builtin'])
  })
})

describe('autoroute.model-info：单模型档位（尽力而为）', () => {
  it('有 reasoning → efforts / defaultEffort 透传（只取档位 id）', async () => {
    const h = await setup({
      resolveModelInfo: async () => ({
        provider: 'p-a', id: 'm-1', name: '模型一',
        reasoning: {
          efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
          defaultEffort: 'high',
        },
      }),
    })
    const result = await h.call('autoroute.model-info', { provider: 'p-a', model: 'm-1' })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ efforts: ['low', 'high'], defaultEffort: 'high' })
  })

  it('无 reasoning（如 codearts 全系）→ {}，而不是报错', async () => {
    const h = await setup({
      resolveModelInfo: async () => ({ provider: 'codearts', id: 'm-1', name: '模型一' }),
    })
    const result = await h.call('autoroute.model-info', { provider: 'codearts', model: 'm-1' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({})
  })

  it('resolveModelInfo 抛错 → {}（编辑器据此显示「无档位可选」而非「加载失败」）', async () => {
    const h = await setup({
      resolveModelInfo: async () => { throw new Error('未知模型') },
    })
    const result = await h.call('autoroute.model-info', { provider: 'p-a', model: 'nope' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({})
  })

  it('provider = auto-route 自身 → {} 且**不查适配器**（防递归查询）', async () => {
    const resolveModelInfo = vi.fn(async () => ({
      reasoning: { efforts: [{ id: 'high', name: '高' }] },
    }))
    const h = await setup({ resolveModelInfo })
    const result = await h.call('autoroute.model-info', {
      provider: AUTO_ROUTE_PROVIDER_ID, model: 'auto-1',
    })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({})
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('provider / model 缺失或空串 → 按既有 handler-failed 模式包错（点名必填）', async () => {
    const resolveModelInfo = vi.fn(async () => ({}))
    const h = await setup({ resolveModelInfo })
    for (const payload of [{}, { provider: 'p-a' }, { provider: '', model: 'm' }, { provider: 'p-a', model: '' }, { provider: 42, model: 'm' }]) {
      const result = await h.call('autoroute.model-info', payload)
      expect(result.ok, `应拒绝：${JSON.stringify(payload)}`).toBe(false)
      expect(result.error?.code, `应走既有 handler-failed 包装：${JSON.stringify(payload)}`)
        .toBe('account-hub/handler-failed')
      expect(result.error?.message).toContain('必填')
    }
    // 非法输入必须在**触达适配器之前**被拦下。
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })
})
