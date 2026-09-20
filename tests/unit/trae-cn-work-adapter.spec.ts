/**
 * Trae CN **Work** LLM 适配器测试。
 *
 * 四块内容各自独立：
 * 1. **累计快照 → 增量**（`diffCumulativeSnapshot`，真机形态的核心纯函数）；
 * 2. **SSE 解析**（真机帧序列重放 / 两条正文通道 / `__dev` 归一 / 错误帧）；
 * 3. **错误分类**（纯函数，码表穷举 + 未标定码的保守默认）；
 * 4. **适配器行为**（三段式、finally DELETE、换号、黑名单、注册、静态兜底）。
 *
 * 全部不发真实网络请求（`fetchImpl` 注入假实现）。真机观测到的事件形态
 * 逐字进 fixture，见 `realPlanItem` / `realTokenUsage` 的注释。
 */

import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  PROVIDER,
  TraeCnWorkAdapter,
  fetchTraeCnWorkModels,
  parseTraeCnWorkModels,
  registerTraeCnWorkLlm,
} from '../../src/trae-cn-work-adapter.js'
import {
  TRAE_CN_WORK,
  TRAE_CN_WORK_AGENT_TYPE,
  TRAE_CN_WORK_DEFAULT_MODEL,
  TRAE_CN_WORK_FALLBACK_MODELS,
  TRAE_CN_WORK_MODELS_FUNCTIONS,
  TRAE_CN_WORK_MODELS_PATH,
  TRAE_CN_WORK_MODELS_QUERY,
  TRAE_CN_WORK_SESSIONS_PATH,
} from '../../src/trae-cn-work-product.js'
import {
  TRAE_CN_WORK_KNOWN_BACKOFF_CODES,
  TRAE_CN_WORK_KNOWN_QUOTA_CODES,
  TRAE_CN_WORK_KNOWN_RATE_LIMIT_CODES,
  TRAE_CN_WORK_SWITCH_CODES,
  classifyTraeCnWorkError,
  isTraeCnWorkBackoff,
  normalizeTraeCnWorkCode,
  recordsTraeCnWorkCooldown,
  shouldSwitchTraeCnWorkAccount,
} from '../../src/trae-cn-work-errors.js'
import {
  consumeTraeCnWorkStream,
  diffCumulativeSnapshot,
  extractTraeCnWorkFinishSummary,
  normalizeTraeCnWorkModelName,
  parseTraeCnWorkModelConfig,
  parseTraeCnWorkPlanItem,
  parseTraeCnWorkSseError,
  parseTraeCnWorkStatusChange,
  parseTraeCnWorkUsage,
  serializeTraeCnWorkQuery,
  traeCnWorkErrorCodeForAction,
} from '../../src/trae-cn-work-sse.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

// ── 测试脚手架 ──

function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: 'kxrq746j3w0l86',
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    // 远期时间戳：避免测试被动触发续期分支。
    expires_at: String(Date.now() + 7_200_000),
    ...overrides,
  }
}

/**
 * 构造一段 Work 风格的 SSE 文本（**带 `id:` 行**，真机形态）。
 *
 * 真机每帧三行：`id: <seq>` / `event: <name>` / `data: <json>`，帧间空行。
 * 这里逐字复刻 —— 解析器必须容忍 `id:` 行（IDE 路径没有该行）。
 */
function workSse(events: Array<{ event: string; data: unknown }>, idPrefix = 'seq'): string {
  return events
    .map(({ event, data }, index) => `id: ${idPrefix}-${index}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

/**
 * 真机第 1 轮的 `plan_item` 帧（**逐字取自实测记录**）。
 *
 * 注意 `thought` 与 `reasoning_content` 都是**累计快照**：每一帧是上一帧的
 * 前缀扩展。这是本 provider 最容易搞错的地方（当增量拼接会让文本重复）。
 */
function realPlanItem(thought: string, reasoning: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '6aad4eb610a657cd03141701',
    task_id: '6aad4eb510a657cd03141687',
    thought,
    reasoning_content: reasoning,
    timing: { generated_at_ms: 1789742774897 },
    tool_call_info: {
      id: '6aad4eb610a657cd03141703',
      name: '',
      params: null,
      result: {},
      meta: null,
    },
    agent_id: 'solo_agent_remote',
    agent_display_name: 'SOLO Remote',
    agent_status: { status: 'running', run_mode: 'foreground' },
    reply_to_message_id: '6aad4eb2291488ef14a82b01',
    ...overrides,
  }
}

/** 真机 `token_usage` 帧（逐字，含缓存与 reasoning 计数）。 */
const realTokenUsage = {
  input: '0.000',
  output: '0.000',
  last_turn_total_tokens: 20866,
  max_tokens: 256000,
  completion_tokens: 166,
  prompt_tokens: 20700,
  reasoning_tokens: 38,
  total_tokens: 20866,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 20536,
  prompt_tokens_total: 0,
  completion_tokens_total: 0,
  reply_to_message_id: '6aad4eb2291488ef14a82b01',
  __packet_seq__: 26,
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集 `stream()` 的全部 chunk；返回 chunk 与抛出的错误。 */
async function collect(
  adapter: TraeCnWorkAdapter,
  options: GenerateOptions,
): Promise<{ chunks: unknown[]; error?: { code?: string; message?: string } }> {
  const chunks: unknown[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error: error as { code?: string; message?: string } }
  }
}

/** 取出所有 text-delta 的文本拼接。 */
function textOf(chunks: unknown[]): string {
  return chunks
    .filter((c) => (c as { type: string }).type === 'text-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
}

/** 取出所有 reasoning-delta 的文本拼接。 */
function reasoningOf(chunks: unknown[]): string {
  return chunks
    .filter((c) => (c as { type: string }).type === 'reasoning-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
}

/**
 * 构造适配器 + 捕获请求的 fetch stub。
 *
 * 三段式意味着一次成功尝试 = **3 个请求**（建会话 / 发消息 / 订阅），
 * 外加收尾的 1 个 DELETE = 4 个。故 responder 按 URL 分派而不是按序号，
 * 这样测试读起来是「哪一段」，不是「第几个请求」。
 */
function makeAdapter(
  responder: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof TraeCnWorkAdapter>[0]> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init, calls.length - 1)
  }) as unknown as typeof fetch
  const adapter = new TraeCnWorkAdapter({
    credentialRef: credentialRef('TRAE_CN_ACCOUNT_TEST'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: fetcher,
    product: TRAE_CN_WORK,
    ...options,
  })
  return { adapter, calls, fetcher }
}

/**
 * 标准三段式 responder：建会话 → 发消息 → 订阅（SSE）。
 *
 * `sseBody` 可为字符串或「按尝试次数返回不同内容」的函数。
 */
function threeStageResponder(
  sseBody: string | ((attempt: number) => string),
  overrides: { create?: Response; message?: Response; events?: Response } = {},
) {
  let attempt = -1
  let currentSse = ''
  return (url: string, init: RequestInit | undefined) => {
    if (url.endsWith(TRAE_CN_WORK_SESSIONS_PATH) && init?.method === 'POST') {
      attempt += 1
      currentSse = typeof sseBody === 'string' ? sseBody : sseBody(attempt)
      if (overrides.create) return overrides.create
      return new Response(JSON.stringify({ code: 0, data: { chat_session_id: `sid-${attempt}`, status: 1 } }), { status: 200 })
    }
    if (url.includes('/messages')) {
      if (overrides.message) return overrides.message
      return new Response(JSON.stringify({ code: 0, data: { message_id: `mid-${attempt}`, accepted: true } }), { status: 200 })
    }
    if (url.includes('/events')) {
      if (overrides.events) return overrides.events
      return sseResponse(currentSse)
    }
    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ code: 0, message: 'success' }), { status: 200 })
    }
    throw new Error(`unexpected request: ${url}`)
  }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'trae-cn-work',
    model: 'Doubao-Seed-Code',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

// ── 一、累计快照 → 增量（真机形态的核心） ──

describe('Trae CN Work 累计快照 → 增量', () => {
  it('空的前一帧 → 返回整个当前帧（首帧就是全部内容）', () => {
    expect(diffCumulativeSnapshot('', 'The')).toBe('The')
    expect(diffCumulativeSnapshot('', '')).toBeUndefined()
  })

  it('前缀扩展 → 只返回新增的后缀（真机三帧序列）', () => {
    // 真机逐字序列：The → The user wants me to → …alpha beta gamma delta
    expect(diffCumulativeSnapshot('The', 'The user wants me to')).toBe(' user wants me to')
    expect(diffCumulativeSnapshot(
      'The user wants me to',
      'The user wants me to reply with exactly: alpha beta gamma delta',
    )).toBe(' reply with exactly: alpha beta gamma delta')
  })

  it('内容相同 → 返回 undefined（不发重复块）', () => {
    expect(diffCumulativeSnapshot('abc', 'abc')).toBeUndefined()
  })

  it('**非前缀扩展 → 返回 null**（不猜差异，交由调用方处置）', () => {
    // 服务端重算/回退：新快照不是旧快照的延伸。
    expect(diffCumulativeSnapshot('abc', 'xyz')).toBeNull()
    expect(diffCumulativeSnapshot('abcdef', 'abc')).toBeNull()
  })

  it('**逐帧拼接累计快照 ≠ 直接拼接快照**（正反例钉死语义）', () => {
    const snapshots = ['The', 'The user', 'The user wants']
    const diffed = snapshots.map((s, i) => diffCumulativeSnapshot(i === 0 ? '' : snapshots[i - 1]!, s)).join('')
    expect(diffed).toBe('The user wants')
    // 反例：把快照当增量拼接会得到重复文本 —— 这正是要避免的 bug。
    expect(snapshots.join('')).not.toBe(diffed)
  })
})

// ── 二、SSE 解析 ──

describe('Trae CN Work SSE：plan_item 解析', () => {
  it('解析真机 plan_item 帧的字段', () => {
    const item = parseTraeCnWorkPlanItem(realPlanItem('hi', 'thinking'))
    expect(item).toBeDefined()
    expect(item?.id).toBe('6aad4eb610a657cd03141701')
    expect(item?.thought).toBe('hi')
    expect(item?.reasoningContent).toBe('thinking')
    expect(item?.agentStatus).toBe('running')
    expect(item?.toolCall?.name).toBe('')
  })

  it('缺 id 的帧被忽略（返回 undefined，而不是产出无法归因的块）', () => {
    expect(parseTraeCnWorkPlanItem({ thought: 'x' })).toBeUndefined()
    expect(parseTraeCnWorkPlanItem(null)).toBeUndefined()
    expect(parseTraeCnWorkPlanItem('x')).toBeUndefined()
  })

  it('字段缺失按空串处理（容忍式读取）', () => {
    const item = parseTraeCnWorkPlanItem({ id: 'p1' })
    expect(item?.thought).toBe('')
    expect(item?.reasoningContent).toBe('')
    expect(item?.toolCall).toBeUndefined()
  })
})

describe('Trae CN Work SSE：两条正文通道', () => {
  it('通道 1：plan_item.thought 的累计快照被差分成增量', async () => {
    const body = workSse([
      { event: 'status_changed', data: { new_status: 3 } },
      { event: 'plan_item', data: realPlanItem('Hi', 'The') },
      { event: 'plan_item', data: realPlanItem('Hi there', 'The user') },
      { event: 'plan_item', data: realPlanItem('Hi there! 👋', 'The user said') },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const outcome = await (async () => {
      const gen = consumeTraeCnWorkStream(sseResponse(body), {
        httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
      })
      let result = await gen.next()
      while (!result.done) { chunks.push(result.value); result = await gen.next() }
      return result.value
    })()

    // 三帧累计快照 → 三段增量，拼起来等于最终快照（**不重复**）。
    expect(textOf(chunks)).toBe('Hi there! 👋')
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta')).toHaveLength(3)
    expect(reasoningOf(chunks)).toBe('The user said')
    expect(outcome.done).toBe(true)
    expect(outcome.produced).toBe(true)
    expect(outcome.snapshotRewinds).toBe(0)
  })

  it('通道 2：finish 动作的 summary 承载正文（真机第 2 轮 thought 全程为空）', async () => {
    const finishItem = realPlanItem('', 'The user wants me to reply', {
      tool_call_info: {
        id: 'tc1',
        name: 'finish',
        params: { summary: 'alpha beta gamma delta epsilon' },
        result: {},
        meta: null,
      },
    })
    const body = workSse([
      { event: 'plan_item', data: finishItem },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }

    // thought 为空，正文只来自 summary —— 漏掉这条通道会得到空回复。
    expect(textOf(chunks)).toBe('alpha beta gamma delta epsilon')
    expect(reasoningOf(chunks)).toBe('The user wants me to reply')
  })

  it('**两条通道去重**：summary 与 thought 相同时不重复发（真机第 1 轮形态）', async () => {
    const text = 'Hi there! 👋 I can help.'
    const body = workSse([
      { event: 'plan_item', data: realPlanItem(text, 'r') },
      {
        event: 'plan_item',
        data: realPlanItem(text, 'r', {
          tool_call_info: { id: 'tc1', name: 'finish', params: { summary: text }, result: {}, meta: null },
        }),
      },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }

    // 关键：文本**恰好一次**，不是两次。
    expect(textOf(chunks)).toBe(text)
  })

  it('summary 补发 thought 未覆盖的后缀（部分重叠场景）', async () => {
    const body = workSse([
      { event: 'plan_item', data: realPlanItem('alpha beta', 'r') },
      {
        event: 'plan_item',
        data: realPlanItem('alpha beta', 'r', {
          tool_call_info: { id: 'tc1', name: 'finish', params: { summary: 'alpha beta gamma' }, result: {}, meta: null },
        }),
      },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('alpha beta gamma')
  })

  it('非 finish 动作的 params 不当正文（避免把内部动作渲染进回复）', () => {
    expect(extractTraeCnWorkFinishSummary({ name: 'run_command', params: { summary: 'x' } })).toBe('')
    expect(extractTraeCnWorkFinishSummary({ name: 'finish', params: { summary: 'ok' } })).toBe('ok')
    expect(extractTraeCnWorkFinishSummary(undefined)).toBe('')
    expect(extractTraeCnWorkFinishSummary({ name: 'finish', params: undefined })).toBe('')
  })

  it('多个 plan item（不同 id）各自独立累计，不串号', async () => {
    const body = workSse([
      { event: 'plan_item', data: realPlanItem('A1', 'r1') },
      { event: 'plan_item', data: { ...realPlanItem('B1', 'r2'), id: 'other-id' } },
      { event: 'plan_item', data: realPlanItem('A1A2', 'r1') },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    // A1 / B1 / A2 —— 第二个 item 的 B1 不应被当成 A 的延伸。
    expect(textOf(chunks)).toBe('A1B1A2')
  })

  it('非前缀扩展（快照回退）被计数并放弃，不产出乱序文本', async () => {
    const body = workSse([
      { event: 'plan_item', data: realPlanItem('abcdef', 'r') },
      { event: 'plan_item', data: realPlanItem('xyz', 'r') },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('abcdef')
    expect(result.value.snapshotRewinds).toBe(1)
  })
})

describe('Trae CN Work SSE：__dev 后缀归一', () => {
  it('剥掉 __dev 后缀（真机 model_config 回的形态）', () => {
    expect(normalizeTraeCnWorkModelName('Doubao-Seed-Code__dev')).toBe('Doubao-Seed-Code')
  })

  it('无后缀时原样返回（其它模型不带后缀）', () => {
    expect(normalizeTraeCnWorkModelName('DeepSeek-V4-Pro')).toBe('DeepSeek-V4-Pro')
  })

  it('**归一后的名字能在静态表里匹配到**（正反例钉死这条接线的意义）', () => {
    const ids = new Set(TRAE_CN_WORK_FALLBACK_MODELS.map((m) => m.id))
    const raw = 'Doubao-Seed-Code__dev'
    expect(ids.has(raw)).toBe(false) // 不归一 → 匹配不上
    expect(ids.has(normalizeTraeCnWorkModelName(raw))).toBe(true)
  })

  it('parseTraeCnWorkModelConfig 优先取 config_name（即请求时的名字）', () => {
    expect(parseTraeCnWorkModelConfig({
      model_name: 'Doubao-Seed-Code__dev', config_name: 'Doubao-Seed-Code',
    })).toBe('Doubao-Seed-Code')
    // 无 config_name 时从 model_name 归一。
    expect(parseTraeCnWorkModelConfig({ model_name: 'Doubao-Seed-Code__dev' })).toBe('Doubao-Seed-Code')
    expect(parseTraeCnWorkModelConfig({})).toBeUndefined()
  })
})

describe('Trae CN Work SSE：用量与状态', () => {
  it('解析真机 token_usage 帧（缓存与 reasoning 单列）', () => {
    const usage = parseTraeCnWorkUsage(realTokenUsage)
    expect(usage).toEqual({
      // prompt_tokens 20700 - cache_read_input_tokens 20536 = 164（未命中缓存的部分）
      inputTokens: 164,
      outputTokens: 166,
      cacheReadTokens: 20536,
      reasoningTokens: 38,
    })
  })

  it('无可用字段时返回 undefined（不伪造 0 用量）', () => {
    expect(parseTraeCnWorkUsage({ input: '0.000', output: '0.000' })).toBeUndefined()
    expect(parseTraeCnWorkUsage(null)).toBeUndefined()
  })

  it('status_changed 解析 new_status', () => {
    expect(parseTraeCnWorkStatusChange({ new_status: 3 })).toBe(3)
    expect(parseTraeCnWorkStatusChange({ new_status: 4 })).toBe(4)
    expect(parseTraeCnWorkStatusChange({})).toBeUndefined()
  })

  it('**终态（4/5）停止读取**，但真机的 3 不停止', async () => {
    const body = workSse([
      { event: 'status_changed', data: { new_status: 3 } },
      { event: 'plan_item', data: realPlanItem('partial', 'r') },
      { event: 'status_changed', data: { new_status: 4 } },
      // 终态之后的内容不该被读入（真机 done 之后也没有内容帧）。
      { event: 'plan_item', data: realPlanItem('partial plus more', 'r') },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('partial')
    expect(result.value.terminalStatus).toBe(4)
    expect(result.value.done).toBe(false)
  })
})

describe('Trae CN Work SSE：错误帧与忽略的帧', () => {
  it('error 帧进 outcome（不抛），带业务码与动作', async () => {
    const body = workSse([
      { event: 'metadata', data: { message_id: 'm1' } },
      { event: 'error', data: { code: 4008, message: '额度不足' } },
    ])
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) result = await gen.next()
    expect(result.value.sseError?.code).toBe(4008)
    expect(result.value.sseError?.message).toBe('额度不足')
    expect(result.value.sseError?.action).toBe('switch-account')
    expect(result.value.done).toBe(false)
  })

  it('parseTraeCnWorkSseError 容忍嵌套 error 形态与字符串码', () => {
    expect(parseTraeCnWorkSseError({ error: { code: '4008', msg: 'x' } }).code).toBe('4008')
    expect(parseTraeCnWorkSseError({ code: 5003, message: 'y' }).action).toBe('switch-account')
    expect(parseTraeCnWorkSseError('plain text').message).toBe('plain text')
  })

  it('**元数据帧不被当正文**（把它们的 JSON 渲染成回复是真实的坑）', async () => {
    const body = workSse([
      { event: 'platform_timing', data: { sandbox_name: 'run-agent-x' } },
      { event: 'metadata', data: { message_id: 'm1', agent_name: 'SOLO Code' } },
      { event: 'model_config', data: { model_name: 'Doubao-Seed-Code__dev' } },
      { event: 'session_title_message', data: { session_title: 'Hello' } },
      { event: 'timing_events', data: { model_name: 'x' } },
      { event: 'plan_item', data: realPlanItem('real text', 'r') },
      { event: 'done', data: { status: 'completed' } },
    ])
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('real text')
  })

  it('id: 行被忽略（Work 独有，IDE 路径没有）', async () => {
    const body = 'id: 6aad4eb310a657cd03141681:7\nevent: plan_item\ndata: ' + JSON.stringify(realPlanItem('x', 'y')) + '\n\ndone\n'
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('x')
  })

  it('畸形 JSON 帧被跳过（一个坏帧不该让整条会话报废）', async () => {
    const body = 'event: plan_item\ndata: {broken\n\nevent: plan_item\ndata: '
      + JSON.stringify(realPlanItem('good', 'r')) + '\n\nevent: done\ndata: {}\n\n'
    const chunks: unknown[] = []
    const gen = consumeTraeCnWorkStream(sseResponse(body), {
      httpStatus: 200, label: 'test', timeouts: { firstFrameMs: 5000, chunkMs: 5000 },
    })
    let result = await gen.next()
    while (!result.done) { chunks.push(result.value); result = await gen.next() }
    expect(textOf(chunks)).toBe('good')
  })
})

// ── 三、query 序列化 ──

describe('Trae CN Work query 序列化', () => {
  it('产出 **JSON 字符串**，元素形态为 {type:"text",data:{content}}', () => {
    const query = serializeTraeCnWorkQuery([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(typeof query).toBe('string')
    const parsed = JSON.parse(query) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.type).toBe('text')
    // ⚠️ 是 data.content，**不是** IDE 路径的 text_content。
    expect(parsed[0]?.data).toEqual({ content: '用户: hi' })
    expect(parsed[0]).not.toHaveProperty('text_content')
  })

  it('system prompt 排在最前（Work body 无 system 字段，故并入 query）', () => {
    const query = serializeTraeCnWorkQuery(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      '你是助手',
    )
    const parsed = JSON.parse(query) as Array<{ data: { content: string } }>
    expect(parsed[0]!.data.content.startsWith('你是助手')).toBe(true)
  })

  it('历史被展平进 query（一次性会话必须自带上下文）', () => {
    const query = serializeTraeCnWorkQuery([
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ])
    const content = (JSON.parse(query) as Array<{ data: { content: string } }>)[0]!.data.content
    expect(content).toContain('第一问')
    expect(content).toContain('第一答')
    expect(content).toContain('第二问')
  })

  it('图片块展平为占位而不是静默丢弃', () => {
    const query = serializeTraeCnWorkQuery([
      { role: 'user', content: [{ type: 'image', data: 'x' }, { type: 'text', text: '看图' }] },
    ])
    const content = (JSON.parse(query) as Array<{ data: { content: string } }>)[0]!.data.content
    expect(content).toContain('[图片]')
    expect(content).toContain('看图')
  })
})

// ── 四、错误分类 ──

describe('Trae CN Work 错误码分类：已确证的码', () => {
  it('额度类码判 switch-account', () => {
    for (const code of TRAE_CN_WORK_KNOWN_QUOTA_CODES) {
      expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('限流类码判 switch-account', () => {
    for (const code of TRAE_CN_WORK_KNOWN_RATE_LIMIT_CODES) {
      expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('退避类码判 backoff（**不换号**）', () => {
    for (const code of TRAE_CN_WORK_KNOWN_BACKOFF_CODES) {
      expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: code })).toBe('backoff')
      expect(shouldSwitchTraeCnWorkAccount(classifyTraeCnWorkError({ sseErrorCode: code }))).toBe(false)
      expect(isTraeCnWorkBackoff(classifyTraeCnWorkError({ sseErrorCode: code }))).toBe(true)
    }
  })

  it('字符串形态与数字形态等价（上游两种都出现过）', () => {
    expect(classifyTraeCnWorkError({ sseErrorCode: '4008' })).toBe('switch-account')
    expect(classifyTraeCnWorkError({ sseErrorCode: 4008 })).toBe('switch-account')
    expect(classifyTraeCnWorkError({ sseErrorCode: ' 4008 ' })).toBe('switch-account')
  })
})

describe('Trae CN Work 错误码分类：**未标定码一律直报**', () => {
  it('未知码判 fail（保守默认：不猜动作，让真实码暴露出来）', () => {
    // 这些是 IDE 路径的码，Work 侧语义未知 —— 猜成换号会放大成 N 次无用请求。
    expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: 4011 })).toBe('fail')
    expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: 1001 })).toBe('fail')
    expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: 99999 })).toBe('fail')
  })

  it('非整数码（诊断文本）不被当业务码', () => {
    expect(normalizeTraeCnWorkCode('code=4008')).toBeUndefined()
    expect(normalizeTraeCnWorkCode('')).toBeUndefined()
    expect(normalizeTraeCnWorkCode(Number.NaN)).toBeUndefined()
  })
})

describe('Trae CN Work 错误码分类：HTTP 兜底', () => {
  it('401/403 判 switch-account（凭据被拒 ⇒ 换号）', () => {
    expect(classifyTraeCnWorkError({ httpStatus: 401 })).toBe('switch-account')
    expect(classifyTraeCnWorkError({ httpStatus: 403 })).toBe('switch-account')
  })

  it('429/408/5xx 判 backoff（网关级限流与瞬时故障与具体账号无关）', () => {
    expect(classifyTraeCnWorkError({ httpStatus: 429 })).toBe('backoff')
    expect(classifyTraeCnWorkError({ httpStatus: 408 })).toBe('backoff')
    expect(classifyTraeCnWorkError({ httpStatus: 500 })).toBe('backoff')
    expect(classifyTraeCnWorkError({ httpStatus: 503 })).toBe('backoff')
  })

  it('其余状态码判 fail', () => {
    expect(classifyTraeCnWorkError({ httpStatus: 400 })).toBe('fail')
    expect(classifyTraeCnWorkError({ httpStatus: 404 })).toBe('fail')
    expect(classifyTraeCnWorkError({ httpStatus: 200 })).toBe('fail')
    expect(classifyTraeCnWorkError({})).toBe('fail')
  })

  it('**业务码优先于 HTTP 状态码**（状态码可能恒为 200）', () => {
    expect(classifyTraeCnWorkError({ httpStatus: 200, sseErrorCode: 4008 })).toBe('switch-account')
    // 反例：只按状态码判会把业务失败全归成 fail，换号机制整体失效。
    expect(classifyTraeCnWorkError({ httpStatus: 200 })).toBe('fail')
  })
})

describe('Trae CN Work 冷却标记', () => {
  it('换号类码记徽章', () => {
    for (const code of TRAE_CN_WORK_SWITCH_CODES) {
      expect(recordsTraeCnWorkCooldown(code)).toBe(true)
    }
  })

  it('**退避类不记**（记了下次选号会跳过该账号 = 偷偷换号）', () => {
    for (const code of TRAE_CN_WORK_KNOWN_BACKOFF_CODES) {
      expect(recordsTraeCnWorkCooldown(code)).toBe(false)
    }
  })

  it('未标定码与无码不记', () => {
    expect(recordsTraeCnWorkCooldown(4011)).toBe(false)
    expect(recordsTraeCnWorkCooldown(undefined)).toBe(false)
  })
})

describe('Trae CN Work 动作 → harness 错误码', () => {
  it('换号/退避类映射为可重试的 RATE_LIMIT', () => {
    expect(traeCnWorkErrorCodeForAction('switch-account')).toBe('RATE_LIMIT')
    expect(traeCnWorkErrorCodeForAction('backoff')).toBe('RATE_LIMIT')
  })

  it('fail 映射为 INVALID_REQUEST，**不**映射成 CONTEXT_WINDOW_EXCEEDED', () => {
    // Work 码表未标定：映射成上下文超长会让 DSH 误触发压缩，真实改写用户会话。
    expect(traeCnWorkErrorCodeForAction('fail')).toBe('INVALID_REQUEST')
  })
})

// ── 五、模型目录 ──

describe('Trae CN Work 模型目录：远端解析', () => {
  /** 真机 `GET /api/remote/v1/models` 的响应（结构逐字，模型条目取前 2 项）。 */
  const realModelsBody = {
    code: 0,
    message: 'success',
    data: {
      list: [{
        function: 'solo_coder',
        models: [
          {
            name: 'Doubao-Seed-2.0-Code',
            multimodal: true,
            is_default: false,
            display_name: 'Doubao-Seed-2.0-Code',
            is_new: false,
            is_beta: true,
            icon: { dark: 'https://x/doubao.svg', light: 'https://x/doubao.svg' },
            features: '{"access":{"data":{"identity_list":[0,5,1]}},"beta":{"enable":true},"consumption_rate":{"enable":true,"data":{"rate":0.39}},"multimodal":{"enable":true},"reasoning":{"enable":true}}',
            config_source: 1,
            is_preset: true,
            max_mode: true,
            context_window_tokens: { dev: 184000, max: 184000 },
          },
          {
            name: 'Doubao-Seed-Code',
            multimodal: true,
            is_default: true,
            display_name: 'Seed-Code',
            is_new: false,
            icon: { dark: 'x', light: 'x' },
            features: '{"consumption_rate":{"enable":true,"data":{"rate":0.06}},"multimodal":{"enable":true}}',
            config_source: 1,
            is_preset: true,
            max_mode: true,
            context_window_tokens: { dev: 184000, max: 184000 },
            reasoning_effort_config: { support_thinking: false, options: null, default_level: '' },
          },
        ],
      }],
    },
  }

  it('解析分组结构 {data:{list:[{models:[...]}]}}（**不是**顶层平铺数组）', () => {
    const models = parseTraeCnWorkModels(realModelsBody)
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({
      id: 'Doubao-Seed-2.0-Code',
      name: 'Doubao-Seed-2.0-Code',
      supportsImages: true,
      contextWindow: 184000,
      consumptionRate: 0.39,
    })
    // display_name 与 name 不同时取 display_name（真机 Seed-Code）。
    expect(models[1]?.name).toBe('Seed-Code')
    expect(models[1]?.consumptionRate).toBe(0.06)
  })

  it('**倍率从 features 这个 JSON 字符串里二次解析**', () => {
    // features 是字符串不是对象 —— 直接读 features.consumption_rate 会拿到 undefined。
    const models = parseTraeCnWorkModels(realModelsBody)
    expect(models[0]?.consumptionRate).toBe(0.39)
  })

  it('context_window_tokens 取 dev 档', () => {
    const models = parseTraeCnWorkModels({
      data: { list: [{ models: [{ name: 'm', context_window_tokens: { dev: 200000, max: 0 } }] }] },
    })
    expect(models[0]?.contextWindow).toBe(200000)
  })

  it('**只认实测的分组形态**，不猜测未观测的平铺形态（返回空 → 回退静态表）', () => {
    // 真机形态（分组）能读到。
    expect(parseTraeCnWorkModels({ data: { list: [{ models: [{ name: 'a' }] }] } })).toHaveLength(1)
    // 未观测到的平铺形态**刻意不支持**：猜错字段比空目录更难诊断。
    expect(parseTraeCnWorkModels({ data: { models: [{ name: 'a' }] } })).toEqual([])
    expect(parseTraeCnWorkModels({ data: [{ name: 'a' }] })).toEqual([])
  })

  it('**只取本 agent（solo_agent_remote）那组**，不把别组拼进来', () => {
    // 多组时只认 function === solo_agent_remote —— 别的池的模型列出来也路由不到。
    const models = parseTraeCnWorkModels({
      data: {
        list: [
          { function: 'solo_coder', models: [{ name: 'Doubao-Seed-2.0-Code' }] },
          { function: 'solo_agent_remote', models: [{ name: 'glm-5.3' }, { name: 'kimi-k3' }] },
          { function: 'solo_work_remote', models: [{ name: 'qwen3.8-max' }] },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k3'])
  })

  it('**多组但没有本组时返回空**（宁可回退静态表，也不拼出不可路由的目录）', () => {
    // 这是本次修复前的缺陷形态：拼接多组会把别的池的模型列给用户。
    expect(parseTraeCnWorkModels({
      data: {
        list: [
          { function: 'solo_coder', models: [{ name: 'a' }] },
          { function: 'solo_work_remote', models: [{ name: 'b' }] },
        ],
      },
    })).toEqual([])
  })

  it('只有一组时容忍（服务端忽略 functions 参数的情形）', () => {
    const models = parseTraeCnWorkModels({
      data: { list: [{ function: 'solo_coder', models: [{ name: 'a' }, { name: 'b' }] }] },
    })
    expect(models.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('本组存在但为空数组时不回退别组（返回空 → 静态表）', () => {
    expect(parseTraeCnWorkModels({
      data: {
        list: [
          { function: 'solo_agent_remote', models: [] },
          { function: 'solo_coder', models: [{ name: 'a' }] },
        ],
      },
    })).toEqual([])
  })

  it('**思考档只在 support_thinking 为 true 且 options 非空时解析**', () => {
    const models = parseTraeCnWorkModels({
      data: {
        list: [{
          function: 'solo_agent_remote',
          models: [
            { name: 'a', reasoning_effort_config: { support_thinking: true, options: ['light', 'high'], default_level: 'high' } },
            { name: 'b', reasoning_effort_config: { support_thinking: false, options: null, default_level: '' } },
            { name: 'c', reasoning_effort_config: { support_thinking: true, options: [], default_level: 'high' } },
            { name: 'd' },
          ],
        }],
      },
    })
    expect(models[0]?.reasoningEfforts).toEqual(['light', 'high'])
    expect(models[0]?.defaultReasoningEffort).toBe('high')
    // 不支持的三项都不带档位字段（不给上游发无效档位）。
    expect(models[1]?.reasoningEfforts).toBeUndefined()
    expect(models[2]?.reasoningEfforts).toBeUndefined()
    expect(models[3]?.reasoningEfforts).toBeUndefined()
  })

  it('default_level 不在 options 内时**只丢默认档、保留档位列表**', () => {
    const models = parseTraeCnWorkModels({
      data: {
        list: [{
          function: 'solo_agent_remote',
          models: [{ name: 'a', reasoning_effort_config: { support_thinking: true, options: ['light'], default_level: 'high' } }],
        }],
      },
    })
    expect(models[0]?.reasoningEfforts).toEqual(['light'])
    expect(models[0]?.defaultReasoningEffort).toBeUndefined()
  })

  it('结构不符时返回空数组（调用方据此回退静态表）', () => {
    expect(parseTraeCnWorkModels(null)).toEqual([])
    expect(parseTraeCnWorkModels({})).toEqual([])
    expect(parseTraeCnWorkModels({ data: {} })).toEqual([])
  })

  it('无 id 的条目被跳过（不产出 id 为空串的条目）', () => {
    expect(parseTraeCnWorkModels({ data: { list: [{ models: [{ display_name: 'x' }] }] } })).toEqual([])
  })
})

describe('Trae CN Work 模型目录：静态兜底表', () => {
  it('真机 **14 项**，id 逐字符（`solo_agent_remote` 组）', () => {
    expect(TRAE_CN_WORK_FALLBACK_MODELS).toHaveLength(14)
    const ids = TRAE_CN_WORK_FALLBACK_MODELS.map((m) => m.id)
    expect(ids).toEqual([
      'Doubao-Seed-Evolving', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo',
      'Doubao-Seed-Code', 'glm-5.3', 'glm-5.2',
      'DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Pro-Official',
      'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3',
      'qwen3.8-max', 'qwen-3.7-plus',
    ])
  })

  it('**旧 `solo_coder` 组的 id 全部清出**（它们在本 agent 的池里不存在）', () => {
    const ids = new Set(TRAE_CN_WORK_FALLBACK_MODELS.map((m) => m.id))
    // 这 11 项是修前那张表的成员，全部属于另一个池 —— 留着就是「选中即路由失败」。
    for (const stale of [
      'Doubao-Seed-2.0-Code', 'minimax-m2.7', 'glm-5.1', 'glm-5v-turbo', 'glm-5',
      'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'kimi-k2.5', 'qwen-3.6-plus', 'qwen-3.5',
    ]) {
      expect(ids.has(stale)).toBe(false)
    }
  })

  it('默认模型在表里且 is_default 的那一项是 Doubao-Seed-Code', () => {
    expect(TRAE_CN_WORK_FALLBACK_MODELS.some((m) => m.id === TRAE_CN_WORK_DEFAULT_MODEL)).toBe(true)
  })

  it('每条都有正的上下文窗口与倍率（不留 undefined 的坑）', () => {
    for (const model of TRAE_CN_WORK_FALLBACK_MODELS) {
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.consumptionRate).toBeGreaterThan(0)
    }
  })

  it('**9 项声明思考档，5 项不声明**（逐字符照抄真机 options）', () => {
    const withEfforts = TRAE_CN_WORK_FALLBACK_MODELS.filter((m) => m.reasoningEfforts !== undefined)
    expect(withEfforts.map((m) => m.id)).toEqual([
      'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo', 'Doubao-Seed-Code',
      'glm-5.3', 'glm-5.2', 'DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Pro-Official',
      'kimi-k3', 'qwen3.8-max',
    ])
    // 档位取值只允许真机出现过的三个 id。
    for (const model of withEfforts) {
      for (const effort of model.reasoningEfforts ?? []) {
        expect(['light', 'high', 'extra_high']).toContain(effort)
      }
      // 默认档必须在档位表内，否则 DSH 会判 INVALID_MODEL_REASONING。
      expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort)
    }
    // glm-5.2 真机只有 high/extra_high（**没有 light**）—— 别照抄其它项的档位表。
    const glm52 = TRAE_CN_WORK_FALLBACK_MODELS.find((m) => m.id === 'glm-5.2')
    expect(glm52?.reasoningEfforts).toEqual(['high', 'extra_high'])
  })

  it('**无思考档的 5 项不声明 reasoningEfforts**', () => {
    for (const id of ['Doubao-Seed-Evolving', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3', 'qwen-3.7-plus']) {
      const model = TRAE_CN_WORK_FALLBACK_MODELS.find((m) => m.id === id)
      expect(model?.reasoningEfforts).toBeUndefined()
      expect(model?.defaultReasoningEffort).toBeUndefined()
    }
  })
})

// ── 六、适配器行为 ──

describe('TraeCnWorkAdapter 三段式', () => {
  it('**一次成功调用 = 建会话 + 发消息 + 订阅 + DELETE**（四请求）', async () => {
    const sse = workSse([
      { event: 'plan_item', data: realPlanItem('hello', 'r') },
      { event: 'token_usage', data: realTokenUsage },
      { event: 'done', data: { status: 'completed' } },
    ])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    const { chunks, error } = await collect(adapter, generateOptions())

    expect(error).toBeUndefined()
    expect(calls).toHaveLength(4)
    // 1) 建会话
    expect(calls[0]!.url).toBe('https://work.trae.cn/api/remote/v1/chat_sessions')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ mode: 'code' })
    // 2) 发消息
    expect(calls[1]!.url).toBe('https://work.trae.cn/api/remote/v1/chat_sessions/sid-0/messages')
    // 3) 订阅
    expect(calls[2]!.url).toBe('https://work.trae.cn/api/remote/v1/chat_sessions/sid-0/events?reply_to_message_id=mid-0')
    // 4) 删会话
    expect(calls[3]!.url).toBe('https://work.trae.cn/api/remote/v1/chat_sessions/sid-0')
    expect(calls[3]!.init?.method).toBe('DELETE')

    expect(textOf(chunks)).toBe('hello')
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
  })

  it('发消息 body 的关键字段逐字（query 是 JSON 字符串 + agent 四件套）', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    await collect(adapter, generateOptions())

    const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>
    expect(body.chat_session_id).toBe('sid-0')
    expect(body.content).toEqual([])
    expect(body.model_name).toBe('Doubao-Seed-Code')
    expect(body.agent_type).toBe('solo_agent_remote')
    expect(body.agent_id).toBe('solo_agent_remote')
    expect(body.model_selection_strategy).toBe('manual')
    expect(body.origin).toBe('web')
    // query 必须是**字符串**，且能被解析回数组。
    expect(typeof body.query).toBe('string')
    expect(Array.isArray(JSON.parse(body.query as string))).toBe(true)
    // 未指定档位时**整个 custom_model 都不发**（零行为变更，见 buildCustomModel）。
    expect(body.custom_model).toBeUndefined()
  })

  it('**思考档下发在 `custom_model.reasoning_effort_level`**（对象内部，不是顶层）', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    await collect(adapter, { ...generateOptions(), reasoningEffort: 'high' as never })

    const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>
    // ⚠️ 落点在 custom_model **内部** —— 与 IDE 路径（顶层字段）不同，别统一掉。
    expect(body.reasoning_effort_level).toBeUndefined()
    const custom = body.custom_model as Record<string, unknown>
    expect(custom.reasoning_effort_level).toBe('high')
    // 真机 bundle 的同一构造式里的固定字段。
    expect(custom.model_name).toBe('Doubao-Seed-Code')
    expect(custom.config_name).toBe('Doubao-Seed-Code')
    expect(custom.config_source).toBe(1)
    expect(custom.is_preset).toBe(true)
    expect(custom.use_remote_service).toBe(true)
    expect(custom.display_model_name).toBe('Seed-Code')
    // 错名的 `reasoning_effort` 不发（真机 A/B 证明上游只认 _level 那个）。
    expect(custom.reasoning_effort).toBeUndefined()
  })

  it('出站身份标识**一个字符不动**（思考档只新增字段，不改既有四件套）', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    await collect(adapter, { ...generateOptions(), reasoningEffort: 'light' as never })
    const withEffort = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>

    const sse2 = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const second = makeAdapter(threeStageResponder(sse2))
    await collect(second.adapter, generateOptions())
    const without = JSON.parse(String(second.calls[1]!.init?.body)) as Record<string, unknown>

    for (const key of ['agent_type', 'agent_id', 'model_selection_strategy', 'origin', 'model_name', 'query']) {
      expect(withEffort[key]).toEqual(without[key])
    }
  })

  it('请求头**只有鉴权三头 + Content-Type**，不带 IDE 网关全套', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    await collect(adapter, generateOptions())

    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT-1')
    expect(headers['X-Ide-Token']).toBe('AT-1')
    expect(headers['X-Cloudide-Token']).toBe('AT-1')
    // 调研实测：这些头 Work 不需要（带不带都 200），故刻意不发。
    expect(headers['x-app-id']).toBeUndefined()
    expect(headers['x-ide-version-code']).toBeUndefined()
    expect(headers['x-device-id']).toBeUndefined()
  })

  it('订阅请求带 Accept: text/event-stream', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    await collect(adapter, generateOptions())
    const headers = calls[2]!.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('成功时产出 finish(stop)', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const { adapter } = makeAdapter(threeStageResponder(sse))
    const { chunks } = await collect(adapter, generateOptions())
    const finish = chunks.find((c) => (c as { type: string }).type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('未收到 done（流被掐断）时产出 finish(max-tokens)', async () => {
    // 无 done 帧：正文可能被截断，报 max-tokens 让 DSH 重试。
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('partial', 'r') }])
    const { adapter } = makeAdapter(threeStageResponder(sse))
    const { chunks } = await collect(adapter, generateOptions())
    const finish = chunks.find((c) => (c as { type: string }).type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('done 后零产出 → EMPTY_RESPONSE（不把空回复交给用户）', async () => {
    const sse = workSse([{ event: 'metadata', data: { x: 1 } }, { event: 'done', data: {} }])
    const { adapter } = makeAdapter(threeStageResponder(sse))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('EMPTY_RESPONSE')
  })
})

describe('TraeCnWorkAdapter 会话清理（finally DELETE）', () => {
  it('**流内错误也要删会话**（否则会话泄漏 + 用户列表被污染）', async () => {
    const sse = workSse([
      { event: 'metadata', data: { x: 1 } },
      { event: 'error', data: { code: 99999, message: 'boom' } },
    ])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/boom/)
    const deletes = calls.filter((c) => c.init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toContain('/chat_sessions/sid-0')
  })

  it('**取消（abort）也要删会话**', async () => {
    const controller = new AbortController()
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('partial', 'r') }])
    const { adapter, calls } = makeAdapter(threeStageResponder(sse))
    const { chunks } = await collect(adapter, generateOptions({ signal: controller.signal }))
    expect(chunks.length).toBeGreaterThan(0)
    // 主动取消：模拟用户按下停止。
    controller.abort()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true)
  })

  it('删除失败**只告警不抛**（回复成功不该因收尾问题报错）', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('ok', 'r') }, { event: 'done', data: {} }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 注意：responder 只构造**一次**（它是按 URL 分派的状态机，重复构造会丢 attempt 计数）。
    const respond = threeStageResponder(sse)
    const { adapter } = makeAdapter((url, init) => {
      if (init?.method === 'DELETE') return new Response('server error', { status: 500 })
      return respond(url, init)
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(textOf(chunks)).toBe('ok')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('建会话就失败时**不发 DELETE**（没有会话可删）', async () => {
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith(TRAE_CN_WORK_SESSIONS_PATH) && init?.method === 'POST') {
        return new Response('bad request', { status: 400 })
      }
      return new Response('{}', { status: 200 })
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error).toBeDefined()
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false)
  })

  it('发消息失败时**仍删会话**（会话已建起来）', async () => {
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith(TRAE_CN_WORK_SESSIONS_PATH) && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { chat_session_id: 'sid-x' } }), { status: 200 })
      }
      if (url.includes('/messages')) return new Response('nope', { status: 500 })
      return new Response('{}', { status: 200 })
    })
    await collect(adapter, generateOptions())
    const deletes = calls.filter((c) => c.init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toContain('/chat_sessions/sid-x')
  })

  it('建会话响应无 chat_session_id → 明确失败，不发后续请求', async () => {
    const { adapter, calls } = makeAdapter((url, init) => {
      if (url.endsWith(TRAE_CN_WORK_SESSIONS_PATH) && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/no chat_session_id/)
    expect(calls).toHaveLength(1)
  })
})

describe('TraeCnWorkAdapter 换号', () => {
  it('**流内限流（HTTP 200 + 4008）触发换号**，且池查询传的是 trae-cn', async () => {
    const errorSse = workSse([{ event: 'error', data: { code: 4008, message: '请求过于频繁' } }])
    const okSse = workSse([{ event: 'plan_item', data: realPlanItem('ok', 'r') }, { event: 'done', data: {} }])
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_2' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    const { adapter, calls } = makeAdapter(
      threeStageResponder((attempt) => (attempt === 0 ? errorSse : okSse)),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit,
          getAvailableAccount,
        } as never,
      },
    )
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(textOf(chunks)).toBe('ok')
    // ⚠️ 池键是 'trae-cn'（**不是** 'trae-cn-work'）—— 账号条目的 provider 是前者。
    expect(getAvailableAccount).toHaveBeenCalledWith('trae-cn', 'Doubao-Seed-Code', expect.any(Set))
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'Doubao-Seed-Code', expect.any(Number))
  })

  it('findAccountIdByCredential 也用 trae-cn（同源池键）', async () => {
    const sse = workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])
    const findAccountIdByCredential = vi.fn(async () => 'acc-1')
    const { adapter } = makeAdapter(threeStageResponder(sse), {
      accountPool: { findAccountIdByCredential, updateModelRateLimit: async () => {}, getAvailableAccount: async () => null } as never,
    })
    await collect(adapter, generateOptions())
    expect(findAccountIdByCredential).toHaveBeenCalledWith('trae-cn', 'AT-1')
  })

  it('建会话 HTTP 401 触发换号（凭据被拒）', async () => {
    const okSse = workSse([{ event: 'plan_item', data: realPlanItem('ok', 'r') }, { event: 'done', data: {} }])
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    // 状态机只构造一次：首次建会话 401，之后走正常三段式。
    const respond = threeStageResponder(okSse)
    let createCount = 0
    const { adapter } = makeAdapter((url, init) => {
      if (url.endsWith(TRAE_CN_WORK_SESSIONS_PATH) && init?.method === 'POST') {
        createCount += 1
        if (createCount === 1) return new Response('unauthorized', { status: 401 })
      }
      return respond(url, init)
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(textOf(chunks)).toBe('ok')
    expect(getAvailableAccount).toHaveBeenCalled()
  })

  it('**退避类不换号**：只尝试一次', async () => {
    const errorSse = workSse([{ event: 'error', data: { code: 4007, message: '慢点' } }])
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter, calls } = makeAdapter(threeStageResponder(errorSse), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('RATE_LIMIT')
    expect(getAvailableAccount).not.toHaveBeenCalled()
    // 3 段（建会话/发消息/订阅）+ 1 次 DELETE；**没有第二次尝试**。
    expect(calls).toHaveLength(4)
    expect(calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith(TRAE_CN_WORK_SESSIONS_PATH))).toHaveLength(1)
  })

  it('已产出内容后再失败**不换号**（避免半截回答 + 完整回答两段）', async () => {
    const sse = workSse([
      { event: 'plan_item', data: realPlanItem('half answer', 'r') },
      { event: 'error', data: { code: 4008, message: '限流' } },
    ])
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter, calls } = makeAdapter(threeStageResponder(sse), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(textOf(chunks)).toBe('half answer')
    expect(error).toBeDefined()
    expect(getAvailableAccount).not.toHaveBeenCalled()
    // 一次尝试的三段 + 一次 DELETE。
    expect(calls).toHaveLength(4)
  })

  it('所有账号都失败时报可读错误（带真实业务码），且不超过换号上限', async () => {
    const errorSse = workSse([{ event: 'error', data: { code: 4008, message: '额度不足' } }])
    let attempt = 0
    const { adapter, calls } = makeAdapter(
      threeStageResponder(() => { attempt += 1; return errorSse }),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount: async () => ({
            entry: { id: `acc-${Math.random()}`, provider: 'trae-cn' },
            credential: makeCredential({ access_token: 'AT-x' }),
          }),
        } as never,
      },
    )
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/额度不足/)
    expect(error?.message).toMatch(/code=4008/)
    // 3 次尝试 × 3 段 = 9 请求 + 每次尝试的 DELETE = 3 → 12。
    expect(attempt).toBe(3)
    expect(calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith(TRAE_CN_WORK_SESSIONS_PATH))).toHaveLength(3)
  })

  it('**全部账号 4008 → 终报可读，但措辞保守**（Work 码表未标定，不复述「已耗尽」）', async () => {
    // 与 IDE 路径共用同一个终报提示函数（账号是同批的、用户下一步动作相同），
    // 但 `semantics` 传 'exhaustion-unverified'：Work 码表整体未标定，
    // 那里收 4008 进额度表时就写明「尚未实测」。故**不能**把 IDE 路径的
    // 单变量结论（积分已耗尽）当事实复述到这条路径上。
    const errorSse = workSse([{ event: 'error', data: { code: 4008, message: 'quota exceeded' } }])
    const { adapter } = makeAdapter(threeStageResponder(errorSse), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        // 池里再没有下一个 → pool-exhausted。
        getAvailableAccount: async () => null,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    // 上游原文保留。
    expect(error?.message).toMatch(/quota exceeded/)
    expect(error?.message).toMatch(/code=4008/)
    // 可操作指引在（换号已试遍 + 下一步）。
    expect(error?.message).toMatch(/全部账号的 Trae CN Work 积分均已用尽或受限/)
    expect(error?.message).toMatch(/请充值或等待额度周期重置/)
    // ⚠️ 反向断言：**不得**复述 IDE 路径那句「已耗尽 / 不是频率限流」——
    // Work 侧没有证据支撑这个结论。
    expect(error?.message).not.toMatch(/均已耗尽/)
    expect(error?.message).not.toMatch(/这不是频率限流/)
    // 池名是 Work 池（与 traeCnPoolFor() 给本面板选的池一致），不是通用池。
    expect(error?.message).not.toMatch(/通用积分/)
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('**池键仍是 trae-cn**：终报改进不影响共享账号池的查询口径', async () => {
    const errorSse = workSse([{ event: 'error', data: { code: 4008, message: 'quota' } }])
    const getAvailableAccount = vi.fn(async () => null)
    const { adapter } = makeAdapter(threeStageResponder(errorSse), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    await collect(adapter, generateOptions())
    // ⚠️ 必须是 'trae-cn'（账号条目的 provider 字段），不是 'trae-cn-work'。
    expect(getAvailableAccount).toHaveBeenCalledWith('trae-cn', expect.anything(), expect.any(Set))
  })

  it('**部分账号可用时仍正常换号**（Work 侧反向回归）', async () => {
    let attempt = 0
    const errorSse = workSse([{ event: 'error', data: { code: 4008, message: 'quota' } }])
    const okSse = workSse([{ event: 'plan_item', data: realPlanItem('好了', 'r') }, { event: 'done', data: {} }])
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter } = makeAdapter(
      threeStageResponder(() => { attempt += 1; return attempt === 1 ? errorSse : okSse }),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount,
        } as never,
      },
    )
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(textOf(chunks)).toBe('好了')
    expect(getAvailableAccount).toHaveBeenCalled()
  })
})

describe('TraeCnWorkAdapter 凭据', () => {
  it('无凭据 → MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'), { resolveCredential: async () => undefined })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('凭据过期 → 先续期再取（且传 model）', async () => {
    const refresh = vi.fn(async () => {})
    let resolved = 0
    const { adapter } = makeAdapter(
      threeStageResponder(workSse([{ event: 'plan_item', data: realPlanItem('x', 'r') }, { event: 'done', data: {} }])),
      {
        refresh,
        resolveCredential: async () => {
          resolved += 1
          return resolved === 1
            ? makeCredential({ expires_at: String(Date.now() - 1000) })
            : makeCredential()
        },
      },
    )
    await collect(adapter, generateOptions())
    expect(refresh).toHaveBeenCalledWith('Doubao-Seed-Code')
  })

  it('图片输入被明确拒绝（不静默丢弃）', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    const { error } = await collect(adapter, generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', data: 'x' } as never],
        source: { kind: 'user' },
      })],
    }))
    expect(error?.code).toBe('UNSUPPORTED_CONTENT')
  })
})

describe('TraeCnWorkAdapter 模型目录与黑名单', () => {
  it('listModels 用远端目录（拉取成功时远端权威）', async () => {
    const fetchRemoteModels = vi.fn(async () => [
      { id: 'remote-1', name: 'Remote One', supportsImages: true, contextWindow: 1234 },
    ])
    const { adapter } = makeAdapter(() => new Response('{}'), { fetchRemoteModels })
    const models = await adapter.listModels(PROVIDER)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ provider: 'trae-cn-work', id: 'remote-1', name: 'Remote One' })
    expect(models[0]?.inputModalities).toEqual(['text', 'image'])
  })

  it('远端失败 → 回退静态 **14 项**（solo_agent_remote 组）', async () => {
    const fetchRemoteModels = vi.fn(async () => { throw new Error('network') })
    const { adapter } = makeAdapter(() => new Response('{}'), { fetchRemoteModels })
    const models = await adapter.listModels(PROVIDER)
    expect(models).toHaveLength(14)
  })

  it('未注入远端拉取时直接用静态表', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    expect(await adapter.listModels(PROVIDER)).toHaveLength(14)
  })

  it('黑名单按 **trae-cn-work** 过滤（不是账号池键 trae-cn）', async () => {
    const disabledModelsFor = vi.fn(() => new Set(['glm-5.3']))
    const { adapter } = makeAdapter(() => new Response('{}'), {
      accountPool: { disabledModelsFor } as never,
    })
    const models = await adapter.listModels(PROVIDER)
    expect(disabledModelsFor).toHaveBeenCalledWith('trae-cn-work')
    expect(models.some((m) => m.id === 'glm-5.3')).toBe(false)
    expect(models).toHaveLength(13)
  })

  it('模型条目带 provider 描述（唯一能承载该文案的位置）', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    const models = await adapter.listModels(PROVIDER)
    expect(models[0]?.description).toBe('TraeWork 网页协议，消耗 Work 专属积分池')
  })

  it('resolveModel 给出真机 dev 档上下文窗口，并**声明思考档**', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    const resolved = await adapter.resolveModel(PROVIDER, 'Doubao-Seed-Code')
    // 本组（solo_agent_remote）的 dev 档是 256000 —— 旧表按 solo_coder 组写的是
    // 184000，那正是「读错分组」留下的痕迹。
    expect(resolved.context).toEqual({ contextWindow: 256000 })
    // 真机 `reasoning_effort_config` = {support_thinking:true,
    // options:["light","high"], default_level:"high"}。
    expect(resolved.reasoning?.efforts.map((e) => String(e.id))).toEqual(['light', 'high'])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('high')
  })

  it('**无思考档的模型不声明 reasoning**（不发射上游不认的档位）', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    // kimi-k2.6 真机连 reasoning_effort_config 字段都没有。
    const kimi = await adapter.resolveModel(PROVIDER, 'kimi-k2.6')
    expect(kimi.reasoning).toBeUndefined()
    // minimax-m3 是 support_thinking:false。
    const minimax = await adapter.resolveModel(PROVIDER, 'minimax-m3')
    expect(minimax.reasoning).toBeUndefined()
  })

  it('resolveModel 对未知模型回退为 id 本身，不伪造上下文', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    const resolved = await adapter.resolveModel(PROVIDER, 'unknown-model')
    expect(resolved.name).toBe('unknown-model')
    expect(resolved.context).toBeUndefined()
  })

  it('providerInfo 对非字符串 provider 做防御性回退', () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    expect(adapter.providerInfo(undefined as never)).toEqual({ id: 'trae-cn-work', name: 'Trae CN Work' })
    expect(adapter.providerInfo(PROVIDER)).toEqual({ id: 'trae-cn-work', name: 'Trae CN Work' })
  })

  it('prepareCall 提供 resolveModel + stream（兼容 rc.2 的 shim）', async () => {
    const { adapter } = makeAdapter(() => new Response('{}'))
    const prepared = await adapter.prepareCall(PROVIDER, 'Doubao-Seed-Code')
    expect(prepared.model.id).toBe('Doubao-Seed-Code')
    expect(typeof prepared.stream).toBe('function')
  })
})

describe('TraeCnWorkAdapter 注册', () => {
  it('注册路由名 trae-cn-work 与 settingsNs llm-trae-cn-work', () => {
    const registerConfigurableProviders = vi.fn()
    const registerAdapter = vi.fn()
    const ctx = { llm: { registerConfigurableProviders, registerAdapter } } as never
    registerTraeCnWorkLlm(ctx, {
      credentialRef: credentialRef('TRAE_CN_ACCOUNT_TEST'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
    })
    expect(registerConfigurableProviders).toHaveBeenCalledWith([{
      provider: 'trae-cn-work',
      displayName: 'Trae CN Work',
      settingsNs: 'llm-trae-cn-work',
      settingsPath: [],
    }])
    expect(registerAdapter).toHaveBeenCalledWith(['trae-cn-work'], expect.any(TraeCnWorkAdapter))
  })
})

describe('Trae CN Work 产品配置', () => {
  it('id / displayName / poolProviderId（**两者不同名**，这是本 provider 的关键接线）', () => {
    expect(TRAE_CN_WORK.id).toBe('trae-cn-work')
    expect(TRAE_CN_WORK.displayName).toBe('Trae CN Work')
    expect(TRAE_CN_WORK.poolProviderId).toBe('trae-cn')
    expect(TRAE_CN_WORK.id).not.toBe(TRAE_CN_WORK.poolProviderId)
  })

  it('apiBase 是 work.trae.cn（**不是** IDE 网关，也不是 api.trae.cn）', () => {
    expect(TRAE_CN_WORK.apiBase).toBe('https://work.trae.cn')
  })

  it('models 路径与真机一致', () => {
    expect(TRAE_CN_WORK_MODELS_PATH).toBe('/api/remote/v1/models')
  })

  it('**目录 query 钉死本 agent 的 function**（不带它拿到的是另一个池）', () => {
    // 这条断言锁死本次缺陷的根因：query 必须带 functions=solo_agent_remote。
    expect(TRAE_CN_WORK_MODELS_QUERY).toContain('functions=solo_agent_remote')
    // 与出站 agent 同名 —— 目录分组必须与请求 agent 一致。
    expect(TRAE_CN_WORK_MODELS_FUNCTIONS).toBe(TRAE_CN_WORK_AGENT_TYPE)
    // 账号私有自定义模型也一起要（它们只在远端出现，不进静态表）。
    expect(TRAE_CN_WORK_MODELS_QUERY).toContain('show_custom_model=true')
  })
})

describe('fetchTraeCnWorkModels', () => {
  it('用鉴权三头拉目录并解析', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        code: 0,
        data: { list: [{ function: 'solo_agent_remote', models: [{ name: 'm1', display_name: 'M1', multimodal: false, context_window_tokens: { dev: 100 } }] }] },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const models = await fetchTraeCnWorkModels(makeCredential(), fetcher)
    expect(models).toHaveLength(1)
    // ⚠️ 带 query：裸打端点会回 solo_coder 组（**另一个池**）—— 见常量注释。
    expect(calls[0]!.url).toBe(
      'https://work.trae.cn/api/remote/v1/models?functions=solo_agent_remote&show_custom_model=true',
    )
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT-1')
  })

  it('非 200 抛错（调用方据此回退静态表）', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(fetchTraeCnWorkModels(makeCredential(), fetcher)).rejects.toThrow(/HTTP 500/)
  })
})
