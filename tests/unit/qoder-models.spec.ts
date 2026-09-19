/**
 * Qoder 模型目录单测（**全 mock，零网络**）。
 *
 * ## fixture 的来源：T1 真机实测 17 项快照
 *
 * {@link T1_SNAPSHOT} 是 T1 轮真机 `GET https://api.qoder.com/api/v1/cloud/models`
 * 的**逐字节原文**（脱敏：只去掉 PAT 相关上下文，目录体本身无凭据字段）。
 * 不凭记忆编造、不「顺手补全」字段 —— 目录字段的缺失本身就是要被测的语义
 * （如 `auto` / `efficient` / `qmodel_latest` / `qmodel` / `mmodel` **没有
 * `efforts`**；`auto` / `efficient` **没有 `default_context_window`**）。
 *
 * ## 本快照钉死的四条事实（每条都有对应用例）
 *
 * 1. **全表返回 + `is_enabled` 标记**：17 项里**仅 2 项** true
 *    （`qmodel_38max` / `qfmodel`）—— 原调研报告说的「只返回 enabled 模型」
 *    **不成立**，这是本模块最核心的过滤依据。
 * 2. **`id` 是短 key，不是 tier 名**：`qmodel_38max` / `qfmodel` / `gmodel` /
 *    `dmodel` / `mmodel`…（`auto` / `efficient` 虽是目录里的合法 id，但作为
 *    `model` 值下发时回 402）。
 * 3. **没有 `lite`**，也没有 `Kimi-K2.7-Code` / `Qwen3.6-Flash` / `MiniMax-M2.7`
 *    —— 与官方 CLI 表、国内版表三者都不一致（roster 浮动）。
 * 4. **`default_context_window` 有 272000 这种非整值**（`performance`）——
 *    解析不得当常量、不得规整化。
 */

import { describe, expect, it, vi } from 'vitest'
import type { AccountPool } from '../../src/account-pool.js'
import type { QoderCredential } from '../../src/qoder-product.js'
import {
  QODER_FALLBACK_MODELS,
  QODER_MODELS_TTL_MS,
  QODER_OFF_CATALOG_HINT,
  QoderCatalogStore,
  effectiveQoderCatalog,
  fallbackQoderCatalog,
  fetchQoderDirectory,
  parseQoderDirectory,
} from '../../src/qoder-models.js'
import type { QoderModelEntry } from '../../src/qoder-models.js'
import { QODER, QODER_MODELS_PATH } from '../../src/qoder-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import type { QoderAdapterOptions } from '../../src/qoder-adapter.js'

// ── T1 真机快照（17 项，逐字节照抄） ──

/**
 * T1 实测原文的 17 项（`has_more:false`）。
 *
 * ⚠️ **不要「整理」这个数组**：字段顺序、缺失字段、`efforts` 的顺序（`ultimate`
 * 是 `["xhigh","high","low","max","medium"]` 而 `qmodel_38max` 是
 * `["xhigh","low","medium"]`）都是实测值。`efforts` 的顺序会原样进
 * `resolveModel().reasoning.efforts`（DSH 按数组顺序渲染选择器），规整化会
 * 让选择器的档位顺序与官方 CLI 的显示不一致。
 */
const T1_SNAPSHOT = {
  data: [
    { id: 'auto', display_name: 'Auto', is_enabled: false, is_new: false, is_vl: true, support_disable_reasoning: false, price_factor: 1, max_input_tokens: 200000 },
    { id: 'ultimate', display_name: 'Ultimate', is_enabled: false, is_new: false, is_vl: true, support_disable_reasoning: true, price_factor: 1.6, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], default_effort: 'high', max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'performance', display_name: 'Performance', is_enabled: false, is_new: false, is_vl: true, support_disable_reasoning: true, price_factor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], default_effort: 'medium', max_input_tokens: 1000000, default_context_window: 272000, available_context_windows: [272000, 400000, 1000000] },
    { id: 'efficient', display_name: 'Efficient', is_enabled: false, is_new: false, is_vl: true, support_disable_reasoning: false, price_factor: 0.3, max_input_tokens: 200000 },
    { id: 'smodel', display_name: 'Sonus', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 3.2, efforts: ['max', 'medium', 'xhigh', 'high', 'low'], default_effort: 'high', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'cmodel', display_name: 'Cantus', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 3.2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], default_effort: 'high', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.2, efforts: ['xhigh', 'low', 'medium'], default_effort: 'medium', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qfmodel', display_name: 'Qwen3.8-Flash', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0, efforts: ['xhigh', 'low', 'medium'], default_effort: 'medium', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qmodel_latest', display_name: 'Qwen3.7-Max', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.1, max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qmodel', display_name: 'Qwen3.7-Plus', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.04, max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'kmodel_latest', display_name: 'Kimi-K3', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 1.2, efforts: ['max', 'high', 'low'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'kmodel', display_name: 'Kimi-K2.8-Preview', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.3, efforts: ['high', 'low', 'max'], default_effort: 'max', default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'gmodel', display_name: 'GLM-5.3', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.5, efforts: ['high', 'low', 'max'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'gfmodel', display_name: 'GLM-5.3-Flash', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.1, efforts: ['high', 'max'], default_effort: 'max', max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'dmodel', display_name: 'DeepSeek-V4-Pro', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.8, efforts: ['max', 'high'], default_effort: 'max', max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'dfmodel', display_name: 'DeepSeek-Flash', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.2, efforts: ['high', 'max', 'low'], default_effort: 'max', max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'mmodel', display_name: 'MiniMax-M3', is_enabled: false, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.2, max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
  ],
  has_more: false,
}

/** T1 快照的项数（原报告记的就是 17）。 */
const T1_ITEM_COUNT = 17

// ── 夹具与工具 ──

/** 一个形态完整的凭据（PAT 本体在 `access_token`）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-test-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/** 构造一个 JSON 响应。 */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 组装适配器选项（默认注入可用的目录拉取）。 */
function adapterOptions(overrides: Partial<QoderAdapterOptions> = {}): QoderAdapterOptions {
  return {
    credentialRef: 'QODER_PERSONAL_TOKEN' as QoderAdapterOptions['credentialRef'],
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    getJobToken: async () => 'jt-test',
    invalidateJobToken: () => {},
    // 默认喂 T1 快照（经真实解析器，不手搓条目）—— 让「解析 → 播报」整条链
    // 一起被测，而不是只测后半截。
    fetchRemoteModels: async () => parseQoderDirectory(T1_SNAPSHOT),
    ...overrides,
  }
}

/** 造一个只提供 `disabledModelsFor` 的账号池 stub。 */
function poolWithDisabled(disabled: readonly string[]): AccountPool {
  return {
    disabledModelsFor: () => new Set(disabled),
  } as unknown as AccountPool
}

// ── 1. 动态目录解析（T1 快照） ──

describe('parseQoderDirectory：T1 快照（17 项）', () => {
  it('全表 17 项都能解析出来（includeDisabled 诊断路径）', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
    expect(entries).toHaveLength(T1_ITEM_COUNT)
    expect(entries.map((entry) => entry.id)).toEqual([
      'auto', 'ultimate', 'performance', 'efficient', 'smodel', 'cmodel',
      'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel', 'kmodel_latest',
      'kmodel', 'gmodel', 'gfmodel', 'dmodel', 'dfmodel', 'mmodel',
    ])
  })

  it('默认只留 is_enabled === true 的项 —— 本账号恰好 2 项', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT)
    expect(entries.map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel'])
    // 全部条目的 enabled 都是 true（过滤后不该留下 false 的）
    expect(entries.every((entry) => entry.enabled)).toBe(true)
  })

  it('id 是**短 key**，不是 tier 名（钉死 T4 定案）', () => {
    const ids = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true }).map((entry) => entry.id)
    expect(ids).toContain('qmodel_38max')
    expect(ids).toContain('qfmodel')
    expect(ids).toContain('gmodel')
    expect(ids).toContain('dmodel')
    expect(ids).toContain('mmodel')
    // tier 名 `auto` / `efficient` 虽然是目录里的合法 id，但它们 is_enabled:false，
    // 故**不在播报集**里（选中即 402）。
    const enabled = parseQoderDirectory(T1_SNAPSHOT).map((entry) => entry.id)
    expect(enabled).not.toContain('auto')
    expect(enabled).not.toContain('efficient')
  })

  it('lite 不在目录里（它是静态兜底项，不是官方项）', () => {
    const ids = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true }).map((entry) => entry.id)
    expect(ids).not.toContain('lite')
  })

  it('display_name / efforts / default_effort 逐字段照抄，顺序不变', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT)
    const max = entries.find((entry) => entry.id === 'qmodel_38max')
    expect(max?.name).toBe('Qwen3.8-Max')
    // 顺序**逐字符照抄**：目录给的是 xhigh/low/medium，不是 low/medium/high。
    expect(max?.reasoningEfforts).toEqual(['xhigh', 'low', 'medium'])
    expect(max?.defaultReasoningEffort).toBe('medium')
  })

  it('default_context_window 的 272000 非整值照收（不当常量、不规整化）', () => {
    const performance = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
      .find((entry) => entry.id === 'performance')
    expect(performance?.contextWindow).toBe(272000)
    expect(performance?.availableContextWindows).toEqual([272000, 400000, 1000000])
  })

  it('is_vl 记进 supportsImages（17 项实测全为 true）', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
    expect(entries.every((entry) => entry.supportsImages === true)).toBe(true)
  })

  it('max_input_tokens 只记录（kmodel 缺该字段时留空，不补默认值）', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
    expect(entries.find((entry) => entry.id === 'qmodel_38max')?.maxInputTokens).toBe(180000)
    expect(entries.find((entry) => entry.id === 'kmodel')?.maxInputTokens).toBeUndefined()
  })

  it('没有 default_context_window 的项回退 available_context_windows 首项', () => {
    // `auto` / `efficient` 两项目录里两个窗口字段都没有 → contextWindow 留空。
    const entries = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
    expect(entries.find((entry) => entry.id === 'auto')?.contextWindow).toBeUndefined()
    expect(entries.find((entry) => entry.id === 'efficient')?.contextWindow).toBeUndefined()
  })

  it('没有 efforts 的项不声明档位（auto / efficient / qmodel_latest / qmodel / mmodel）', () => {
    const entries = parseQoderDirectory(T1_SNAPSHOT, { includeDisabled: true })
    for (const id of ['auto', 'efficient', 'qmodel_latest', 'qmodel', 'mmodel']) {
      expect(entries.find((entry) => entry.id === id)?.reasoningEfforts).toBeUndefined()
    }
  })

  it('响应形态不符时返回空数组（不猜信封、不抛错）', () => {
    expect(parseQoderDirectory(undefined)).toEqual([])
    expect(parseQoderDirectory(null)).toEqual([])
    expect(parseQoderDirectory([])).toEqual([])
    expect(parseQoderDirectory({ has_more: false })).toEqual([])
    expect(parseQoderDirectory({ data: 'nope' })).toEqual([])
    // 候选键名（models / list / result）**刻意不认** —— 猜错形状比空目录更难诊断。
    expect(parseQoderDirectory({ models: T1_SNAPSHOT.data })).toEqual([])
  })

  it('id 为空/非字符串的项被跳过，不让它污染目录', () => {
    const entries = parseQoderDirectory({
      data: [
        { id: '  ', display_name: 'Blank', is_enabled: true },
        { id: 42, display_name: 'Numeric', is_enabled: true },
        { display_name: 'NoId', is_enabled: true },
        { id: 'good', display_name: 'Good', is_enabled: true },
      ],
    })
    expect(entries.map((entry) => entry.id)).toEqual(['good'])
  })

  it('is_enabled 只认严格 true（缺失 / 字符串 "true" 都不算）', () => {
    expect(parseQoderDirectory({ data: [{ id: 'a', display_name: 'A' }] })).toEqual([])
    expect(parseQoderDirectory({ data: [{ id: 'a', display_name: 'A', is_enabled: 'true' }] })).toEqual([])
    expect(parseQoderDirectory({ data: [{ id: 'a', display_name: 'A', is_enabled: 1 }] })).toEqual([])
    expect(parseQoderDirectory({ data: [{ id: 'a', display_name: 'A', is_enabled: true }] }))
      .toHaveLength(1)
  })

  it('default_effort 不在 efforts 内时只丢默认档，保留档位列表', () => {
    const entries = parseQoderDirectory({
      data: [{ id: 'x', display_name: 'X', is_enabled: true, efforts: ['low', 'high'], default_effort: 'max' }],
    })
    expect(entries[0].reasoningEfforts).toEqual(['low', 'high'])
    expect(entries[0].defaultReasoningEffort).toBeUndefined()
  })

  it('display_name 缺失时回退 id', () => {
    const entries = parseQoderDirectory({ data: [{ id: 'onlyid', is_enabled: true }] })
    expect(entries[0].name).toBe('onlyid')
  })
})

// ── 2. 静态兜底表与两条路径的不对称 ──

describe('静态兜底表与 lite 的不对称', () => {
  it('兜底表恰好 3 项，且含 lite', () => {
    expect(QODER_FALLBACK_MODELS.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
  })

  it('lite 不声明任何档位（目录没给、也没有别的实测来源）', () => {
    const lite = fallbackQoderCatalog().find((entry) => entry.id === 'lite')
    expect(lite?.reasoningEfforts).toBeUndefined()
    expect(lite?.defaultReasoningEffort).toBeUndefined()
  })

  it('**动态目录成功时不并入 lite**（并入等于伪造官方认可）', () => {
    const remote = parseQoderDirectory(T1_SNAPSHOT)
    const effective = effectiveQoderCatalog(remote)
    expect(effective.map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel'])
    expect(effective.map((entry) => entry.id)).not.toContain('lite')
  })

  it('目录为空（失败）时回退静态表 —— 此时 lite 自然在列', () => {
    expect(effectiveQoderCatalog([]).map((entry) => entry.id))
      .toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    expect(effectiveQoderCatalog(undefined).map((entry) => entry.id))
      .toEqual(['qmodel_38max', 'qfmodel', 'lite'])
  })

  it('回退时返回的是新数组（调用方改它不会污染常量表）', () => {
    const first = fallbackQoderCatalog()
    first.pop()
    expect(fallbackQoderCatalog()).toHaveLength(3)
    expect(QODER_FALLBACK_MODELS).toHaveLength(3)
  })
})

// ── 3. 目录拉取（网络全 mock） ──

describe('fetchQoderDirectory', () => {
  it('用 PAT 打目录端点，且带 Bearer 头', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse(JSON.stringify(T1_SNAPSHOT))
    }) as unknown as typeof fetch

    const entries = await fetchQoderDirectory(CREDENTIAL, { fetchImpl: fetcher })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${QODER.modelsBase}${QODER_MODELS_PATH}`)
    expect(calls[0].url).toBe('https://api.qoder.com/api/v1/cloud/models')
    expect(calls[0].init?.method).toBe('GET')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer pt-test-token')
    // 返回值已是过滤后的（只 2 项），调用方无需再过滤。
    expect(entries.map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel'])
  })

  it('非 2xx 一律返回空数组（401 PAT 失效也走这条，绝不抛错）', async () => {
    for (const status of [400, 401, 403, 500, 503]) {
      const fetcher = (async () => jsonResponse('{"error":"unauthorized"}', status)) as unknown as typeof fetch
      await expect(fetchQoderDirectory(CREDENTIAL, { fetchImpl: fetcher })).resolves.toEqual([])
    }
  })

  it('网络异常 / 响应不是 JSON 都返回空数组', async () => {
    const boom = (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    await expect(fetchQoderDirectory(CREDENTIAL, { fetchImpl: boom })).resolves.toEqual([])

    const notJson = (async () => new Response('<html>gateway</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch
    await expect(fetchQoderDirectory(CREDENTIAL, { fetchImpl: notJson })).resolves.toEqual([])
  })

  it('目录体是合法 JSON 但结构不符时返回空数组', async () => {
    const fetcher = (async () => jsonResponse('{"unexpected":true}')) as unknown as typeof fetch
    await expect(fetchQoderDirectory(CREDENTIAL, { fetchImpl: fetcher })).resolves.toEqual([])
  })
})

// ── 4. 缓存 TTL 与「失败不写缓存」 ──

describe('QoderCatalogStore：TTL 与失败不写缓存', () => {
  const sample: readonly QoderModelEntry[] = [{ id: 'm1', name: 'M1', enabled: true }]

  it('写入后 TTL 内 fresh() 有值，超过 TTL 后为 undefined', () => {
    let now = 1_000_000
    const store = new QoderCatalogStore(QODER_MODELS_TTL_MS, () => now)
    store.store(sample)
    expect(store.fresh()).toEqual(sample)

    // TTL 边界前一毫秒仍新鲜
    now += QODER_MODELS_TTL_MS - 1
    expect(store.fresh()).toEqual(sample)

    // 到点即过期
    now += 1
    expect(store.fresh()).toBeUndefined()
  })

  it('**失败（空数组）不写缓存** —— 也绝不清掉已有缓存', () => {
    let now = 0
    const store = new QoderCatalogStore(QODER_MODELS_TTL_MS, () => now)
    store.store(sample)

    // 过期后刷新失败：fresh() 为 undefined（触发重拉），但 entries() 仍给旧目录
    now += QODER_MODELS_TTL_MS
    store.store([]) // 失败
    expect(store.fresh()).toBeUndefined()
    expect(store.entries()).toEqual(sample)

    // 从未成功过的 store 遇到失败：仍然什么都没有
    const cold = new QoderCatalogStore(QODER_MODELS_TTL_MS, () => now)
    cold.store([])
    expect(cold.entries()).toBeUndefined()
    expect(cold.fresh()).toBeUndefined()
  })

  it('clear() 丢弃缓存', () => {
    const store = new QoderCatalogStore(QODER_MODELS_TTL_MS, () => 0)
    store.store(sample)
    store.clear()
    expect(store.entries()).toBeUndefined()
  })

  it('写入的是副本（外部改原数组不影响缓存）', () => {
    const store = new QoderCatalogStore(QODER_MODELS_TTL_MS, () => 0)
    const mutable: QoderModelEntry[] = [{ id: 'm1', name: 'M1', enabled: true }]
    store.store(mutable)
    mutable.push({ id: 'm2', name: 'M2', enabled: true })
    expect(store.entries()).toHaveLength(1)
  })
})

// ── 5. 适配器接线：listModels ──

describe('QoderAdapter.listModels', () => {
  it('播报动态目录（只含 is_enabled 的 2 项），名字取自 display_name', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const models = await adapter.listModels('qoder')
    expect(models).toEqual([
      { provider: 'qoder', id: 'qmodel_38max', name: 'Qwen3.8-Max', inputModalities: ['text'] },
      { provider: 'qoder', id: 'qfmodel', name: 'Qwen3.8-Flash', inputModalities: ['text'] },
    ])
  })

  it('目录失败回退静态表（含 lite）', async () => {
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels: async () => [] }))
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    expect(models.find((model) => model.id === 'lite')?.name).toBe('Lite')
  })

  it('目录拉取抛错时同样回退静态表（不让一次抖动炸掉选择器）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchRemoteModels: async () => { throw new Error('boom') },
    }))
    await expect(adapter.listModels('qoder')).resolves.toHaveLength(3)
  })

  it('无凭据时回退静态表，且不发请求', async () => {
    const fetchRemoteModels = vi.fn(async () => parseQoderDirectory(T1_SNAPSHOT))
    const adapter = new QoderAdapter(adapterOptions({
      resolveCredential: async () => undefined,
      fetchRemoteModels,
    }))
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    expect(fetchRemoteModels).not.toHaveBeenCalled()
  })

  it('黑名单过滤：被关掉的模型不播报（黑名单制，未记录默认打开）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      accountPool: poolWithDisabled(['qmodel_38max']),
    }))
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qfmodel'])
  })

  it('黑名单里含目录中没有的 id 时不影响其余项', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      accountPool: poolWithDisabled(['lite', 'nonexistent']),
    }))
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel'])
  })

  it('黑名单每次调用实时读（改开关后无需重建适配器）', async () => {
    let disabled = new Set<string>()
    const pool = { disabledModelsFor: () => disabled } as unknown as AccountPool
    const adapter = new QoderAdapter(adapterOptions({ accountPool: pool }))

    expect(await adapter.listModels('qoder')).toHaveLength(2)
    disabled = new Set(['qmodel_38max'])
    expect((await adapter.listModels('qoder')).map((model) => model.id)).toEqual(['qfmodel'])
  })

  it('黑名单只影响播报，不影响 resolveModel 路由（DSH 约定）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      accountPool: poolWithDisabled(['qmodel_38max']),
    }))
    const resolved = await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(resolved.id).toBe('qmodel_38max')
    expect(resolved.name).toBe('Qwen3.8-Max')
  })

  it('模态恒声明纯文本（目录的 is_vl=true 不照抄 —— 本适配器送不到图片）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const models = await adapter.listModels('qoder')
    // T1 快照 17 项 is_vl 全为 true，若照抄就会全报 ['text','image']。
    expect(models.every((model) => JSON.stringify(model.inputModalities) === '["text"]')).toBe(true)
  })
})

// ── 6. 适配器接线：resolveModel ──

describe('QoderAdapter.resolveModel', () => {
  it('上下文窗口取目录的 default_context_window', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
  })

  it('efforts 档位映射到 DSH 的 reasoning 声明（id 照抄 + 展示名）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(resolved.reasoning).toEqual({
      efforts: [
        { id: 'xhigh', name: 'XHigh' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
      ],
      defaultEffort: 'medium',
    })
  })

  it('未登记档位 id 的展示名回退成 id 本身', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchRemoteModels: async () => parseQoderDirectory({
        data: [{
          id: 'future', display_name: 'Future', is_enabled: true,
          efforts: ['ultra'], default_effort: 'ultra',
        }],
      }),
    }))
    const resolved = await adapter.resolveModel('qoder', 'future')
    expect(resolved.reasoning?.efforts).toEqual([{ id: 'ultra', name: 'ultra' }])
    expect(resolved.reasoning?.defaultEffort).toBe('ultra')
  })

  it('lite 被认可：有展示名、**不声明档位**、无窗口', async () => {
    // 目录成功（不含 lite）时也必须认它 —— 静态表是第二级查找。
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel('qoder', 'lite')
    expect(resolved).toEqual({
      provider: 'qoder',
      id: 'lite',
      name: 'Lite',
      inputModalities: ['text'],
    })
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.context).toBeUndefined()
  })

  it('lite 在目录失败时同样被认可', async () => {
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels: async () => [] }))
    const lite = await adapter.resolveModel('qoder', 'lite')
    expect(lite.name).toBe('Lite')
    expect(lite.reasoning).toBeUndefined()
  })

  it('表外模型**原样路由、不抛错**（DSH 约定：目录不构成路由白名单）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel('qoder', 'gmodel')
    expect(resolved).toEqual({
      provider: 'qoder',
      id: 'gmodel',
      name: 'gmodel',
      inputModalities: ['text'],
    })
    // 表外模型不声明档位/窗口 —— 那是诚实的，而不是给一个猜的值。
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.context).toBeUndefined()
  })

  it('目录里 is_enabled:false 的项在目录成功时也按表外处理（不报它的名字）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    // `gmodel` 在 17 项快照里存在但 is_enabled:false，故不在生效目录里。
    const resolved = await adapter.resolveModel('qoder', 'gmodel')
    expect(resolved.name).toBe('gmodel')
  })

  it('目录已成功时 is_enabled 项用目录给的展示名', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    expect((await adapter.resolveModel('qoder', 'qfmodel')).name).toBe('Qwen3.8-Flash')
  })

  it('目录失败时静态表的展示名仍可用（qmodel_38max → Qwen3.8-Max）', async () => {
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels: async () => [] }))
    expect((await adapter.resolveModel('qoder', 'qmodel_38max')).name).toBe('Qwen3.8-Max')
  })

  it('resolveModel 与 listModels 的模态同源同口径', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const listed = await adapter.listModels('qoder')
    for (const info of listed) {
      const resolved = await adapter.resolveModel('qoder', info.id)
      expect(resolved.inputModalities).toEqual(info.inputModalities)
    }
  })
})

// ── 7. TTL 生效：不重复拉取 ──

describe('目录缓存的 TTL 行为', () => {
  it('多次 listModels 只拉一次目录（TTL 内复用）', async () => {
    const fetchRemoteModels = vi.fn(async () => parseQoderDirectory(T1_SNAPSHOT))
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels }))

    await adapter.listModels('qoder')
    await adapter.listModels('qoder')
    await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
  })

  it('listModels 与 resolveModel 共用同一个缓存实例', async () => {
    const fetchRemoteModels = vi.fn(async () => parseQoderDirectory(T1_SNAPSHOT))
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels }))

    await adapter.resolveModel('qoder', 'qmodel_38max')
    await adapter.listModels('qoder')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
  })

  it('失败后**不写缓存** —— 下一次调用会重试拉取', async () => {
    let fail = true
    const fetchRemoteModels = vi.fn(async () => {
      if (fail) return []
      return parseQoderDirectory(T1_SNAPSHOT)
    })
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels }))

    await adapter.listModels('qoder')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)

    // 目录失败没有写缓存 → 第二次仍会重试
    fail = false
    const models = await adapter.listModels('qoder')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(2)
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel'])
  })
})

// ── 8. 表外模型的失败提示 ──

describe('表外模型的失败提示（trae-cn 4001 提示的同一惯例）', () => {
  /** 让 stream() 收到一个流内 invalid_model_error 帧。 */
  const INVALID_MODEL_STREAM = 'event: error\ndata: {"error":{"code":"invalid_model_error","message":"model not found"}}\n\n\n'

  /** 一个永远回固定响应的 fetch。 */
  function stubFetch(body: string, status = 200, contentType = 'text/event-stream'): typeof fetch {
    return (async () => new Response(body, {
      status, headers: { 'content-type': contentType },
    })) as unknown as typeof fetch
  }

  /**
   * 先 `listModels()` 把目录**预热**，再返回适配器。
   *
   * ⚠️ 这一步不是测试脚手架的花招，而是**真实调用序列**：DSH 进对话前一定先经
   * `prepareCall` → `resolveModel`（以及模型选择器的 `listModels`）。而 `stream()`
   * **刻意不拉目录**（见 `src/qoder-adapter.ts` 里的说明：那会把一个与本次请求
   * 无关的网络往返塞进热路径）。故要测「确知表外」这条提示，就必须先把缓存填上。
   */
  async function primedAdapter(overrides: Partial<QoderAdapterOptions> = {}): Promise<QoderAdapter> {
    const adapter = new QoderAdapter(adapterOptions(overrides))
    await adapter.listModels('qoder')
    return adapter
  }

  /** collect 一个 async iterable（期望抛错）。 */
  async function expectThrow(iterable: AsyncIterable<unknown>): Promise<Error> {
    try {
      for await (const _chunk of iterable) { /* 消费到抛错 */ }
    } catch (error) {
      return error as Error
    }
    throw new Error('expected stream to throw')
  }

  it('确知表外 + invalid_model_error → 追加可读提示', async () => {
    const adapter = await primedAdapter({ fetchImpl: stubFetch(INVALID_MODEL_STREAM) })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'gmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).toContain(QODER_OFF_CATALOG_HINT)
  })

  it('目录里 is_enabled 的项不加提示（它在可用目录里）', async () => {
    const adapter = await primedAdapter({ fetchImpl: stubFetch(INVALID_MODEL_STREAM) })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'qmodel_38max',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })

  it('表内模型（lite）不加提示 —— 它在静态表里，劝用户重选是有害的', async () => {
    const adapter = await primedAdapter({ fetchImpl: stubFetch(INVALID_MODEL_STREAM) })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })

  it('目录未预热（缓存冷）时不加提示 —— 那时我们并不知道模型真的不在目录里', async () => {
    // **不调 primedAdapter**：直接构造 + 直接 stream（绕过 prepareCall 的极端路径）。
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: stubFetch(INVALID_MODEL_STREAM) }))
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'gmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })

  it('目录失败（只有静态表）时不加提示 —— 那时我们并不知道模型真的不在目录里', async () => {
    const adapter = await primedAdapter({
      fetchRemoteModels: async () => [],
      fetchImpl: stubFetch(INVALID_MODEL_STREAM),
    })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'gmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })

  it('402 额度类失败不加提示（402 的语义是额度，不是模型名）', async () => {
    const adapter = await primedAdapter({
      fetchImpl: stubFetch('{"code":116,"error":"quota exceeded"}', 402, 'application/json'),
    })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'gmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })

  it('其它失败（401）不加提示 —— 判据只认 invalid_model_error', async () => {
    const adapter = await primedAdapter({
      fetchImpl: stubFetch('{"error":"unauthorized"}', 401, 'application/json'),
    })
    const error = await expectThrow(adapter.stream({
      provider: 'qoder',
      model: 'gmodel',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never))
    expect(error.message).not.toContain(QODER_OFF_CATALOG_HINT)
  })
})
