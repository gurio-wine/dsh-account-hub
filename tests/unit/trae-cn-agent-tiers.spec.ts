/**
 * Trae CN **agent 组档位数据源**测试（`GET /api/remote/v1/models?functions=solo_agent_remote`）。
 *
 * ## 为什么单独一个 spec（而不是并进 trae-cn-adapter.spec.ts）
 *
 * 本轮改动**只碰数据源**：IDE 目录端点（`get_detail_param`）自 2026-09-21 起对可调
 * 模型停发 `context_window_tokens.max`，档位列因此在真机上没有数据。新数据源是
 * **另一个端点、另一个池、另一套头**，它的解析 / 合并 / 降级三件事都有独立的
 * 判据要钉死，放进适配器那个 2600 行的 spec 里会被淹没。
 *
 * ## 三条主线
 *
 * 1. **解析**：只认 `solo_agent_remote` 组（不跨组拼接）、`max_mode === true` 是
 *    必要条件、`max` 走 readPositive 口径、`name` 才是 id；
 * 2. **合并**：只补现有条目的 `maxContextWindow`（**绝不新增条目** —— agent 组独有的
 *    `Doubao-Seed-Code` 必须被忽略）、基准是**生效档**（`cwt.dev ?? prompt_max_tokens`）；
 * 3. **降级**：档位拉取失败/超时/无本组 ⇒ **目录照常返回**，只是没有档位 ——
 *    档位绝不能拖垮目录。
 *
 * 全部零网络（注入假 fetch）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  applyTraeCnAgentTiers,
  applyTraeCnStaticMetadata,
  fetchTraeCnAgentTiers,
  fetchTraeCnDirectory,
  mergeTraeCnDirectory,
  parseTraeCnAgentTiers,
} from '../../src/trae-cn-models.js'
import type { TraeCnAgentTier, TraeCnModelEntry } from '../../src/trae-cn-models.js'
import { TRAE_CN_SOLO_REMOTE_FUNCTION } from '../../src/trae-cn-models.js'
import {
  TRAE_CN_AGENT_MODELS_API_BASE,
  TRAE_CN_AGENT_MODELS_FUNCTIONS,
  TRAE_CN_AGENT_MODELS_PATH,
  TRAE_CN_AGENT_MODELS_QUERY,
  TRAE_CN_IDE_API_BASE,
  TRAE_CN_MODELS_PATH,
} from '../../src/trae-cn-product.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

// ── 测试脚手架 ──

function makeCredential(): TraeCnCredential {
  return {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: '1234567890123456',
    checkin_device_id: '2996599860772203',
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    expires_at: String(Date.now() + 7_200_000),
  }
}

/** 造一个 IDE 目录条目（默认带生效档 200000）。 */
function entryOf(id: string, overrides: Partial<TraeCnModelEntry> = {}): TraeCnModelEntry {
  return {
    id,
    name: id,
    function: TRAE_CN_SOLO_REMOTE_FUNCTION,
    ...overrides,
  }
}

/** agent 组响应的一项（真机键集的最小子集：`name` / `max_mode` / `context_window_tokens`）。 */
function agentModel(
  name: string,
  maxMode: boolean,
  dev: unknown,
  max: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    display_name: `${name} 展示名`,
    max_mode: maxMode,
    context_window_tokens: { dev, max },
    ...extra,
  }
}

/** 造一个 agent 池目录响应（默认只含本组）。 */
function agentResponse(
  models: readonly Record<string, unknown>[],
  functionName: string = TRAE_CN_AGENT_MODELS_FUNCTIONS,
): Response {
  return new Response(JSON.stringify({ code: 0, data: { list: [{ function: functionName, models }] } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 造一个 IDE 目录响应的一项。 */
function directoryModel(id: string, promptMaxTokens?: number): Record<string, unknown> {
  return {
    config_name: id,
    display_config: { display_name: id },
    ...promptMaxTokens === undefined ? {} : { model_detail_list: [{ prompt_max_tokens: promptMaxTokens }] },
  }
}

/** 造一个 IDE 目录响应。 */
function directoryResponse(models: readonly Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ config_info_list: models }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── 解析 ──

describe('parseTraeCnAgentTiers：只认 solo_agent_remote 组', () => {
  it('正常形态：`name` 是 id，`max_mode` 与 `context_window_tokens.max` 逐项读出', () => {
    const tiers = parseTraeCnAgentTiers({
      code: 0,
      data: {
        list: [{
          function: TRAE_CN_AGENT_MODELS_FUNCTIONS,
          models: [
            agentModel('glm-5.3', true, 200_000, 1_000_000),
            // 无 Max 档的三项之一：`max_mode:false` + `max:0`（真机形态）。
            agentModel('kimi-k2.6', false, 200_000, 0),
          ],
        }],
      },
    })
    expect([...tiers.keys()]).toEqual(['glm-5.3', 'kimi-k2.6'])
    expect(tiers.get('glm-5.3')).toEqual({ maxMode: true, max: 1_000_000 })
    // `max_mode:false` 的项**保留在表里**（可区分「上游说没档位」与「没这一项」），
    // 但 `max:0` 按 readPositive 口径**不写入**（0 不是有效窗口）。
    expect(tiers.get('kimi-k2.6')).toEqual({ maxMode: false })
    expect(tiers.get('kimi-k2.6')).not.toHaveProperty('max')
  })

  it('id 取 `name`，**不是** `display_name` / `id`', () => {
    const tiers = parseTraeCnAgentTiers({
      data: {
        list: [{
          function: TRAE_CN_AGENT_MODELS_FUNCTIONS,
          models: [{
            name: 'Doubao-Seed-2.1-Pro',
            display_name: 'Seed-2.1-Pro-0915',
            id: 'not-the-model-id',
            model_name: 'not-the-model-id-either',
            max_mode: true,
            context_window_tokens: { dev: 200_000, max: 1_000_000 },
          }],
        }],
      },
    })
    expect([...tiers.keys()]).toEqual(['Doubao-Seed-2.1-Pro'])
    expect(tiers.has('Seed-2.1-Pro-0915')).toBe(false)
  })

  it('**只取本组**：多组并存时不跨组拼接', () => {
    const tiers = parseTraeCnAgentTiers({
      data: {
        list: [
          { function: 'solo_coder', models: [agentModel('Doubao-Seed-Code', true, 184_000, 256_000)] },
          { function: TRAE_CN_AGENT_MODELS_FUNCTIONS, models: [agentModel('glm-5.3', true, 200_000, 1_000_000)] },
          { function: 'solo_design_remote', models: [agentModel('kimi-k2.7-code', true, 184_000, 512_000)] },
        ],
      },
    })
    expect([...tiers.keys()]).toEqual(['glm-5.3'])
  })

  it('**组缺失即空表**：不认「唯一一组」「第一组」这类容忍分支（跨池取值比无档位更坏）', () => {
    expect(parseTraeCnAgentTiers({
      data: { list: [{ function: 'solo_coder', models: [agentModel('Doubao-Seed-Code', true, 184_000, 256_000)] }] },
    }).size).toBe(0)
    // `function` 字段整个缺失的组同样不算本组。
    expect(parseTraeCnAgentTiers({
      data: { list: [{ models: [agentModel('glm-5.3', true, 200_000, 1_000_000)] }] },
    }).size).toBe(0)
  })

  it('`name` 缺失 / 空串 / 非字符串的项跳过', () => {
    const tiers = parseTraeCnAgentTiers({
      data: {
        list: [{
          function: TRAE_CN_AGENT_MODELS_FUNCTIONS,
          models: [
            agentModel('glm-5.3', true, 200_000, 1_000_000),
            { max_mode: true, context_window_tokens: { max: 1_000_000 } },
            { name: '   ', max_mode: true, context_window_tokens: { max: 1_000_000 } },
            { name: 42, max_mode: true, context_window_tokens: { max: 1_000_000 } },
          ],
        }],
      },
    })
    expect([...tiers.keys()]).toEqual(['glm-5.3'])
  })

  it('`max` 判据与目录侧同口径（正有限数才收：0 / 负数 / NaN / 字符串 / 缺失都不收）', () => {
    const tiers = parseTraeCnAgentTiers({
      data: {
        list: [{
          function: TRAE_CN_AGENT_MODELS_FUNCTIONS,
          models: [
            agentModel('zero', true, 200_000, 0),
            agentModel('negative', true, 200_000, -1),
            agentModel('nan', true, 200_000, Number.NaN),
            agentModel('string', true, 200_000, '1000000'),
            agentModel('missing-max', true, 200_000, null),
            // `context_window_tokens` 整个缺失。
            { name: 'no-window', max_mode: true },
            agentModel('ok', true, 200_000, 1_000_000),
          ],
        }],
      },
    })
    for (const id of ['zero', 'negative', 'nan', 'string', 'missing-max', 'no-window']) {
      expect(tiers.get(id), id).not.toHaveProperty('max')
    }
    expect(tiers.get('ok')!.max).toBe(1_000_000)
  })

  it('`max_mode` 非布尔 true 一律视为 false（缺失 / "true" / 1 都不算）', () => {
    const tiers = parseTraeCnAgentTiers({
      data: {
        list: [{
          function: TRAE_CN_AGENT_MODELS_FUNCTIONS,
          models: [
            { name: 'missing', context_window_tokens: { max: 1_000_000 } },
            { name: 'string-true', max_mode: 'true', context_window_tokens: { max: 1_000_000 } },
            { name: 'numeric', max_mode: 1, context_window_tokens: { max: 1_000_000 } },
          ],
        }],
      },
    })
    expect(tiers.get('missing')!.maxMode).toBe(false)
    expect(tiers.get('string-true')!.maxMode).toBe(false)
    expect(tiers.get('numeric')!.maxMode).toBe(false)
  })

  it('垃圾形态一律空表（不做信封猜测）', () => {
    for (const body of [
      undefined, null, 'x', 42, [],
      { data: null },
      { data: {} },
      { data: { list: 'nope' } },
      { data: { list: [null, 'x'] } },
      { data: { list: [{ function: TRAE_CN_AGENT_MODELS_FUNCTIONS, models: null }] } },
      // 顶层直接是数组（从未观测到的形态，不猜）。
      [{ function: TRAE_CN_AGENT_MODELS_FUNCTIONS, models: [] }],
    ]) {
      expect(parseTraeCnAgentTiers(body).size, JSON.stringify(body)).toBe(0)
    }
  })
})

// ── 合并 ──

describe('applyTraeCnAgentTiers：只补条目，绝不新增', () => {
  const tiersOf = (entries: Array<[string, TraeCnAgentTier]>): Map<string, TraeCnAgentTier> =>
    new Map(entries)

  it('命中且 `max > 生效档` ⇒ 写入 `maxContextWindow`', () => {
    const applied = applyTraeCnAgentTiers(
      [entryOf('glm-5.3', { contextWindow: 168_000 })],
      tiersOf([['glm-5.3', { maxMode: true, max: 1_000_000 }]]),
    )
    expect(applied[0]!.contextWindow).toBe(168_000)
    expect(applied[0]!.maxContextWindow).toBe(1_000_000)
  })

  it('**绝不新增条目**：agent 组独有的 `Doubao-Seed-Code` 必须被忽略', () => {
    // 真机形态：agent 组 13 项里有 `Doubao-Seed-Code`，而 IDE roster 没有它 ——
    // 加进选择器就是一个必然 4001 的选项。
    const applied = applyTraeCnAgentTiers(
      [entryOf('glm-5.3', { contextWindow: 168_000 })],
      tiersOf([
        ['glm-5.3', { maxMode: true, max: 1_000_000 }],
        ['Doubao-Seed-Code', { maxMode: true, max: 1_000_000 }],
        ['kimi-k2.6', { maxMode: false }],
      ]),
    )
    expect(applied.map((entry) => entry.id)).toEqual(['glm-5.3'])
  })

  it('`contextWindow === undefined` 的条目跳过（没有比较基准）', () => {
    const applied = applyTraeCnAgentTiers(
      [entryOf('no-baseline')],
      tiersOf([['no-baseline', { maxMode: true, max: 1_000_000 }]]),
    )
    expect(applied[0]).not.toHaveProperty('maxContextWindow')
  })

  it('`max` 缺失 / `max_mode !== true` / `max <= 生效档` 三种都不收', () => {
    const applied = applyTraeCnAgentTiers(
      [
        entryOf('no-max', { contextWindow: 168_000 }),
        entryOf('no-mode', { contextWindow: 168_000 }),
        entryOf('equal', { contextWindow: 200_000 }),
        entryOf('smaller', { contextWindow: 1_000_000 }),
      ],
      tiersOf([
        ['no-max', { maxMode: true }],
        ['no-mode', { maxMode: false, max: 1_000_000 }],
        ['equal', { maxMode: true, max: 200_000 }],
        ['smaller', { maxMode: true, max: 200_000 }],
      ]),
    )
    for (const entry of applied) {
      expect(entry, entry.id).not.toHaveProperty('maxContextWindow')
    }
  })

  it('目录自己已发布 `maxContextWindow` 时**不覆盖**（同池的值优先于跨池的值）', () => {
    const applied = applyTraeCnAgentTiers(
      [entryOf('glm-5.3', { contextWindow: 168_000, maxContextWindow: 262_144 })],
      tiersOf([['glm-5.3', { maxMode: true, max: 1_000_000 }]]),
    )
    expect(applied[0]!.maxContextWindow).toBe(262_144)
  })

  it('空表（档位拉取失败 / 无本组）⇒ 逐项原样返回', () => {
    const source = [entryOf('glm-5.3', { contextWindow: 168_000 }), entryOf('kimi-k2.6', { contextWindow: 200_000 })]
    const applied = applyTraeCnAgentTiers(source, new Map())
    expect(applied).toEqual(source)
  })
})

// ── 拉取 ──

describe('fetchTraeCnAgentTiers：请求配方与静默降级', () => {
  it('URL / 方法 / **头恰好 5 个**（不带 SOLO 网关头）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return agentResponse([agentModel('glm-5.3', true, 200_000, 1_000_000)])
    }) as unknown as typeof fetch

    const tiers = await fetchTraeCnAgentTiers(makeCredential(), { fetchImpl: fetcher })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      `${TRAE_CN_AGENT_MODELS_API_BASE}${TRAE_CN_AGENT_MODELS_PATH}${TRAE_CN_AGENT_MODELS_QUERY}`,
    )
    expect(calls[0]!.url).toBe(`${TRAE_CN_AGENT_MODELS_API_BASE}/api/remote/v1/models?functions=solo_agent_remote`)
    expect(calls[0]!.init?.method).toBe('GET')
    // 查询串**刻意不带** `show_custom_model=true`（BYOK 项对档位毫无用处）。
    expect(calls[0]!.url).not.toContain('show_custom_model')

    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual([
      'Accept', 'Authorization', 'Content-Type', 'X-Cloudide-Token', 'X-Ide-Token',
    ])
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT AT-1')
    expect(headers['X-Ide-Token']).toBe('AT-1')
    expect(headers['X-Cloudide-Token']).toBe('AT-1')
    expect(headers['Accept']).toBe('application/json')
    // ⚠️ 与 IDE 目录 / chat 的 SOLO 网关头**不是同一套**：本端点实测不需要它们，
    // 多带不是「更保险」而是把请求形态改成未被验证的组合。
    for (const absent of [
      'x-app-id', 'x-ide-version-code', 'x-app-version-code', 'x-ide-version',
      'x-ide-version-type', 'request-traffic-type', 'x-plugin-channel',
      'x-request-id', 'x-trae-request-id', 'x-custom-trace-id', 'x-flow-traceparent',
      'x-uid', 'x-device-id', 'x-device-type', 'x-os-version', 'User-Agent',
    ]) {
      expect(headers, absent).not.toHaveProperty(absent)
    }

    expect(tiers.get('glm-5.3')).toEqual({ maxMode: true, max: 1_000_000 })
  })

  it('抛错 / 非 2xx / 非 JSON **一律空表且不抛**（档位失败绝不拖垮目录）', async () => {
    const boom = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(fetchTraeCnAgentTiers(makeCredential(), { fetchImpl: boom })).resolves.toEqual(new Map())

    const notOk = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchTraeCnAgentTiers(makeCredential(), { fetchImpl: notOk })).resolves.toEqual(new Map())

    const notJson = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchTraeCnAgentTiers(makeCredential(), { fetchImpl: notJson })).resolves.toEqual(new Map())
  })
})

// ── 端到端（目录 + 档位共用一次刷新） ──

describe('fetchTraeCnDirectory：档位并入同一次刷新，失败静默降级', () => {
  /** 一个按 URL 分派的假 fetch：IDE 目录两次 POST + agent 组一次 GET。 */
  function routedFetcher(options: {
    remote?: () => Response
    lite?: () => Response
    agent?: () => Response
  }): { fetcher: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const target = String(url)
      if (target.startsWith(TRAE_CN_AGENT_MODELS_API_BASE)) {
        return (options.agent ?? (() => agentResponse([])))()
      }
      return (JSON.parse(String(init?.body)) as { function: string }).function === TRAE_CN_SOLO_REMOTE_FUNCTION
        ? (options.remote ?? (() => directoryResponse([])))()
        : (options.lite ?? (() => directoryResponse([])))()
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  it('目录成功 + 档位成功 ⇒ 条目带 Max 档，且共 3 次请求（2 POST + 1 GET）', async () => {
    const { fetcher, calls } = routedFetcher({
      // 真机形态：两个窗口字段给不同的数 —— 生效档取 `cwt.dev`（200000，
      // 与官方客户端显示的 200K 同口径），`prompt_max_tokens` 只是回退值。
      remote: () => directoryResponse([
        { ...directoryModel('glm-5.3', 168_000), context_window_tokens: { dev: 200_000 } },
        directoryModel('kimi-k2.6', 200_000),
        { ...directoryModel('Doubao-Seed-2.1-Turbo', 200_000), context_window_tokens: { dev: 200_000 } },
      ]),
      lite: () => directoryResponse([]),
      agent: () => agentResponse([
        agentModel('glm-5.3', true, 200_000, 1_000_000),
        agentModel('kimi-k2.6', false, 200_000, 0),
        agentModel('Doubao-Seed-2.1-Turbo', false, 200_000, 0),
        // ⚠️ agent 组独有的 id：不进目录。
        agentModel('Doubao-Seed-Code', true, 184_000, 1_000_000),
      ]),
    })

    const entries = await fetchTraeCnDirectory(makeCredential(), { fetchImpl: fetcher })
    expect(entries.map((entry) => entry.id)).toEqual(['glm-5.3', 'kimi-k2.6', 'Doubao-Seed-2.1-Turbo'])
    const glm = entries.find((entry) => entry.id === 'glm-5.3')!
    expect(glm.contextWindow).toBe(200_000)
    expect(glm.maxContextWindow).toBe(1_000_000)
    // 没有 Max 档的两项**不编造**。
    for (const id of ['kimi-k2.6', 'Doubao-Seed-2.1-Turbo']) {
      expect(entries.find((entry) => entry.id === id), id).not.toHaveProperty('maxContextWindow')
    }
    // `Doubao-Seed-Code` 无论在 agent 组里带什么档位都不能出现在结果里。
    expect(entries.some((entry) => entry.id === 'Doubao-Seed-Code')).toBe(false)

    expect(calls.filter((call) => call.url === `${TRAE_CN_IDE_API_BASE}${TRAE_CN_MODELS_PATH}`)).toHaveLength(2)
    const agentCalls = calls.filter((call) => call.url.startsWith(TRAE_CN_AGENT_MODELS_API_BASE))
    expect(agentCalls).toHaveLength(1)
    expect(agentCalls[0]!.init?.method).toBe('GET')
  })

  it('档位端点失败（抛错 / 500）⇒ **目录照常返回**，只是没有档位', async () => {
    for (const agent of [
      () => { throw new TypeError('fetch failed') },
      () => new Response('boom', { status: 500 }),
    ]) {
      const { fetcher } = routedFetcher({
        remote: () => directoryResponse([{ ...directoryModel('glm-5.3', 168_000), context_window_tokens: { dev: 200_000 } }]),
        agent: agent as () => Response,
      })
      const entries = await fetchTraeCnDirectory(makeCredential(), { fetchImpl: fetcher })
      expect(entries.map((entry) => entry.id)).toEqual(['glm-5.3'])
      expect(entries[0]!.contextWindow).toBe(200_000)
      expect(entries[0]).not.toHaveProperty('maxContextWindow')
      // 静态元数据照旧补上（档位失败不影响多模态 / 思考档）。
      expect(entries[0]!.supportsImages).toBe(false)
      expect(entries[0]!.reasoningEfforts).toEqual(['light', 'high', 'extra_high'])
    }
  })

  it('目录整体落空 ⇒ **不再打档位端点**（静态回退表一律不带档位，拉了也无处可补）', async () => {
    const { fetcher, calls } = routedFetcher({
      remote: () => new Response('boom', { status: 500 }),
      lite: () => new Response('boom', { status: 500 }),
    })
    expect(await fetchTraeCnDirectory(makeCredential(), { fetchImpl: fetcher })).toEqual([])
    expect(calls.filter((call) => call.url.startsWith(TRAE_CN_AGENT_MODELS_API_BASE))).toHaveLength(0)
  })

  it('档位合并发生在静态元数据补齐**之后**（顺序影响「不覆盖」判据的语义）', () => {
    // 顺序即契约：目录条目先补多模态 / 思考档，再补档位。这里直接把两步串起来，
    // 断言两次补齐互不干扰（同一个条目的三类字段各自独立）。
    const entries = applyTraeCnAgentTiers(
      applyTraeCnStaticMetadata(mergeTraeCnDirectory([
        {
          function: TRAE_CN_SOLO_REMOTE_FUNCTION,
          entries: [entryOf('glm-5.3', { contextWindow: 168_000 })],
        },
      ], true)),
      new Map([['glm-5.3', { maxMode: true, max: 1_000_000 }]]),
    )
    expect(entries[0]!.maxContextWindow).toBe(1_000_000)
    expect(entries[0]!.supportsImages).toBe(false)
    expect(entries[0]!.reasoningEfforts).toEqual(['light', 'high', 'extra_high'])
    expect(entries[0]!.defaultReasoningEffort).toBe('high')
  })
})
