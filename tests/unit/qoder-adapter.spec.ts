/**
 * Qoder 适配器单测（**全 mock，零网络**）。
 *
 * 三条主线，对应 T1/T2/T3 真机实测里最容易写错的三处：
 * 1. **`[DONE]` 是唯一成功收尾判据** —— 缺了它必须报错，不许静默当优雅结束；
 * 2. **成功流的大 usage 帧会被注入裸 LF** —— 恢复规则是「无分隔符直接拼」；
 * 3. **`tool_calls` 的存在性不能靠 `finish_reason` 判** —— forced `tool_choice`
 *    时它是 `"stop"`。
 *
 * 流式 fixture 全部照抄 T3 报告的逐字节原文（含被 `…` 省略的长 id），
 * **不凭记忆编造**。
 */

import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AccountPool } from '../../src/account-pool.js'
import { QODER_MAX_REQUEST_BYTES } from '../../src/qoder-errors.js'
import type { QoderCredential } from '../../src/qoder-product.js'
import {
  QoderAdapter,
  buildQoderChatBody,
  consumeQoderStream,
  extractQoderErrorFacts,
  parseQoderUsage,
  serializeQoderMessages,
} from '../../src/qoder-adapter.js'
import type { QoderAdapterOptions, QoderStreamOptions, QoderStreamOutcome } from '../../src/qoder-adapter.js'

// ── 夹具与工具 ──

/** 一个形态完整的凭据（PAT 本体在 `access_token`）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-test-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/** 构造一个 SSE 响应；`contentType` 默认 `text/event-stream`。 */
function sseResponse(body: string, status = 200, contentType = 'text/event-stream'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

/** 构造一个 JSON 响应。 */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 把一帧 `data:` 行拼成 SSE 文本（**分隔符用实测的 `\n\n\n`**）。 */
function frame(payload: string, eventName?: string): string {
  const head = eventName === undefined ? '' : `event: ${eventName}\n`
  return `${head}data: ${payload}\n\n\n`
}

/** 消费一个流式生成器，同时拿到 chunks 与 outcome。 */
async function runStream(
  response: Response,
  overrides: Partial<QoderStreamOptions> = {},
): Promise<{ chunks: StreamChunk[]; outcome: QoderStreamOutcome }> {
  const generator = consumeQoderStream(response, {
    label: 'qoder',
    httpStatus: response.status,
    timeouts: { firstFrameMs: 5_000, chunkMs: 5_000 },
    ...overrides,
  })
  const chunks: StreamChunk[] = []
  let step = await generator.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await generator.next()
  }
  return { chunks, outcome: step.value }
}

/** 消费一个 chunk 迭代器，只收 chunks。 */
async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** 拼出正文（所有 text-delta 之和）。 */
function textOf(chunks: readonly StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

/** 取最后一个 finish chunk 的 reason.kind。 */
function finishKind(chunks: readonly StreamChunk[]): string | undefined {
  const finish = chunks.filter((chunk) => chunk.type === 'finish').pop()
  return finish === undefined ? undefined : (finish as { reason: { kind: string } }).reason.kind
}

/** 取最后一个 usage chunk。 */
function usageOf(chunks: readonly StreamChunk[]): TokenUsage | undefined {
  const usage = chunks.filter((chunk) => chunk.type === 'usage').pop()
  return usage === undefined ? undefined : (usage as { usage: TokenUsage }).usage
}

/** 组装一份最小 `GenerateOptions`。 */
function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'qoder',
    model: 'lite',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as unknown as GenerateOptions
}

/**
 * 组装适配器选项（默认注入可用的 jt 提供者）。
 *
 * ⚠️ **默认也注入 `fetchRemoteModels`**（返回空数组 = 目录不可用）：该默认值保证
 * 本文件的每个用例都**零网络**。不注入的话，`resolveModel` / `listModels` 会去
 * 打真实的 `https://api.qoder.com/api/v1/cloud/models` —— 单测里那是不可接受的：
 * 它会让用例的成败取决于本机网络与线上 roster（两者都会变），而且慢。
 *
 * 空数组是「目录失败」的规范表达（见 `src/qoder-models.ts`），此时适配器回退
 * 静态兜底表 —— 目录面的完整行为在 `tests/unit/qoder-models.spec.ts` 里测。
 */
function adapterOptions(overrides: Partial<QoderAdapterOptions> = {}): QoderAdapterOptions {
  return {
    credentialRef: 'QODER_PERSONAL_TOKEN' as QoderAdapterOptions['credentialRef'],
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    getJobToken: async () => 'jt-test',
    invalidateJobToken: () => {},
    fetchRemoteModels: async () => [],
    ...overrides,
  }
}

// ── 1. 请求体构造 ──

describe('buildQoderChatBody', () => {
  it('下发 metadata.context.client_type=qodercli（出站身份标识，不可改）', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions())) as Record<string, unknown>
    expect(body.metadata).toEqual({ context: { client_type: 'qodercli' } })
  })

  it('恒为流式并索要 usage', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions())) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('tools 包裹成 OpenAI 标准形态 `{type:function,function:{…}}`（真机报障根因，见下）', () => {
    // ⚠️ 曾经的实现是「原样透传」（`expect(body.tools).toEqual(tools)`），
    // 那是**错的**：harness 的 `ToolSchema` 是 `{name,description,parameters}`，
    // 而 Qoder 的 chat 端点要的是 OpenAI 标准 `{type:'function',function:{…}}`。
    //
    // 真机证据（2026-09-21，国际版 PAT 实测，全程走本函数构造请求）：
    //   同一请求唯一变量 = tools 形态，模型 `qmodel`（Qwen3.7-Plus）：
    //   - Raw 透传 → HTTP 200 流内 `provider_error`，
    //     details 原文：`'function' is a required property, expected an object - 'tools.0'`
    //     用户可见：`Qoder 上游返回包装码 provider_error（未能从 details 中二次解析出真码）：
    //               Error in upstream response` + harness 码 INVALID_REQUEST（即用户报障原文）
    //   - OpenAI 标准包裹 → `[DONE]=true` 正常收尾
    //   其余模型同型：`kmodel`（`unknown tool type: , currently only function and plugin
    //   are supported`）、`dmodel`（`tools[0].type: unknown variant ... expected function`）、
    //   `mmodel` / `gmodel`（`invalid tool type`、`API 调用参数有误`）全部只在 Raw 形态下失败。
    //   `lite` 走宽松路径两种形态都成功 —— 所以这个缺陷只在非 lite 模型上暴露。
    const tools = [{
      name: 'read',
      description: '读文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]
    const options = generateOptions({ tools })
    const body = JSON.parse(buildQoderChatBody(options)) as Record<string, unknown>
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read',
        description: '读文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    }])
    // messages 仍然原样透传（这条没变，也不要顺手改）。
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  it('tools 为空数组时不下发该字段（包裹逻辑不得凭空造出空 tools）', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions({ tools: [] }))) as Record<string, unknown>
    expect('tools' in body).toBe(false)
  })

  it('system 作为首条 system 消息前置', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions({ system: '你是助手' }))) as Record<string, unknown>
    expect((body.messages as unknown[])[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('reasoning_effort 透传不拦截，未给则不下发', () => {
    const withEffort = JSON.parse(
      buildQoderChatBody(generateOptions({ reasoningEffort: 'high' as never })),
    ) as Record<string, unknown>
    expect(withEffort.reasoning_effort).toBe('high')
    const withoutEffort = JSON.parse(buildQoderChatBody(generateOptions())) as Record<string, unknown>
    expect('reasoning_effort' in withoutEffort).toBe(false)
  })

  it('temperature / max_tokens / stop 有值才透传', () => {
    const body = JSON.parse(buildQoderChatBody(
      generateOptions({ temperature: 0.3, maxTokens: 128, stop: ['END'] }),
    )) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(128)
    expect(body.stop).toEqual(['END'])
  })

  it('model 原样下发（短 key，不是 tier 名）', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions({ model: 'qmodel_38max' }))) as Record<string, unknown>
    expect(body.model).toBe('qmodel_38max')
  })

  it('剔除无法配对的 tool_call / tool-result（防会话报废）', () => {
    const wire = serializeQoderMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_orphan', name: 'read', arguments: '{}' }],
      },
    ])
    // 没有对应 tool-result 的 tool_call 必须被剔除，否则后端 400 拒绝整条请求。
    expect(wire.find((message) => message.role === 'assistant')?.tool_calls).toBeUndefined()
  })

  it('assistant 只有 tool_calls 时 content 为 null（OpenAI 规范）', () => {
    const wire = serializeQoderMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ])
    const assistant = wire.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBeNull()
    expect(wire.find((message) => message.role === 'tool')).toBeDefined()
  })
})

// ── 2. [DONE] 判据 ──

/** 一条完整的正常流（帧序照 T3 报告：role → 正文 → finish_reason → usage → [DONE]）。 */
const NORMAL_STREAM = frame('{"id":"c1","model":"lite","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}')
  + frame('{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}')
  + frame('{"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}')
  + frame('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}')
  + frame('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}')
  + frame('[DONE]')

describe('流式解析器：[DONE] 判据', () => {
  it('完整流：done 为真、正文拼装正确、usage 收到、model 回显', async () => {
    const { chunks, outcome } = await runStream(sseResponse(NORMAL_STREAM))
    expect(outcome.done).toBe(true)
    expect(outcome.produced).toBe(true)
    expect(textOf(chunks)).toBe('Hello world')
    expect(usageOf(chunks)?.totalTokens).toBe(15)
    expect(outcome.model).toBe('lite')
  })

  it('去掉 [DONE] 的同一个流：done 为假（绝不静默当优雅结束）', async () => {
    const withoutSentinel = NORMAL_STREAM.replace(frame('[DONE]'), '')
    const { outcome } = await runStream(sseResponse(withoutSentinel))
    expect(outcome.done).toBe(false)
    // 正文仍然透传出来了 —— 失败必须由调用方按 done 判定，而不是靠「有没有内容」。
    expect(outcome.produced).toBe(true)
  })

  it('适配器对缺 [DONE] 的流抛错，文案含 Stream ended without [DONE]', async () => {
    const withoutSentinel = NORMAL_STREAM.replace(frame('[DONE]'), '')
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(withoutSentinel)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/Stream ended without \[DONE\]/)
  })

  it('适配器对含 [DONE] 的流产出 finish: stop', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(NORMAL_STREAM)) as unknown as typeof fetch,
    }))
    const chunks = await collect(adapter.stream(generateOptions()))
    expect(finishKind(chunks)).toBe('stop')
    expect(textOf(chunks)).toBe('Hello world')
  })

  it('[DONE] 是裸哨兵文本，不会被坏帧跳过吃掉', async () => {
    // 反证：JSON.parse('[DONE]') 必然抛错 —— 若「先解析再判哨兵」，
    // 每一次**成功**的流都会以「缺少 [DONE]」告终。
    expect(() => JSON.parse('[DONE]')).toThrow()
    const { outcome } = await runStream(sseResponse(frame('[DONE]')))
    expect(outcome.done).toBe(true)
  })
})

// ── 3. 流内 error 帧 ──

/** 形态 A：错误嵌套在 `error` 对象里（有 `data:` 前缀）。 */
const ERROR_FRAME_A_PAYLOAD = '{"error":{"code":"invalid_parameter_error","param":null,'
  + '"message":"<400> InternalError.Algo.InvalidParameter: Role must be in '
  + '[\\"user\\", \\"assistant\\", \\"system\\", \\"function\\", \\"plugin\\", \\"tool\\"] and the role '
  + 'in last message must be in [\\"user\\", \\"function\\", \\"tool\\"]","type":"invalid_request_error"},'
  + '"id":"chatcmpl-8241a39c-…"}'

/** 形态 B：`event: error` + 平铺 `code`/`message`（T3 勘误 v2 的逐字节形态）。 */
const ERROR_FRAME_B_PAYLOAD = '{"code":"invalid_model_error","message":"Unsupported model \\"\\"",'
  + '"request_id":"85cb66a06aa0-…","type":"invalid_model_error"}'

describe('流式解析器：流内 error 帧', () => {
  it('形态 A（嵌套 error 对象）→ 直报 invalid_parameter_error', async () => {
    const { outcome } = await runStream(sseResponse(frame(ERROR_FRAME_A_PAYLOAD)))
    expect(outcome.done).toBe(false)
    expect(outcome.error?.code).toBe('invalid_parameter_error')
    expect(outcome.error?.action).toBe('fail')
    expect(outcome.error?.message).toContain('InvalidParameter')
  })

  it('形态 B（event: error + 平铺码，逐字节 \\n\\n\\n 帧尾）→ 直报 invalid_model_error', async () => {
    // 逐字节原文：event: error\ndata: {…}\n\n\n
    const raw = `event: error\ndata: ${ERROR_FRAME_B_PAYLOAD}\n\n\n`
    expect(raw.endsWith('\n\n\n')).toBe(true)
    const { outcome } = await runStream(sseResponse(raw))
    expect(outcome.done).toBe(false)
    expect(outcome.error?.code).toBe('invalid_model_error')
    expect(outcome.error?.action).toBe('fail')
  })

  it('流内错误绝不转成优雅结束（不出 finish chunk）', async () => {
    const { chunks, outcome } = await runStream(sseResponse(frame(ERROR_FRAME_A_PAYLOAD)))
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
    expect(outcome.done).toBe(false)
    expect(outcome.error).toBeDefined()
  })

  it('HTTP 200 + 流内错误：适配器抛出的错误带业务码判据（不是静默成功）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(frame(ERROR_FRAME_A_PAYLOAD), 200)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/InvalidParameter|invalid_parameter_error/)
  })

  it('同一错误发 2 遍（两个不同 chatcmpl id）只取首帧', async () => {
    const second = ERROR_FRAME_A_PAYLOAD.replace('chatcmpl-8241a39c-…', 'chatcmpl-b7f0c2e1-…')
    const { outcome } = await runStream(sseResponse(frame(ERROR_FRAME_A_PAYLOAD) + frame(second)))
    expect(outcome.error?.code).toBe('invalid_parameter_error')
    // 首帧之后即停止，不会把第二帧当成第二处错误。
    expect(outcome.done).toBe(false)
  })
})

// ── 4. usage 帧裸 LF 注入兜底 ──

/**
 * 三个**逐字节**注入实例（T3 报告 §4 的断点表）。
 *
 * `l1Tail` 是被注入 LF 切开的前半段（**以 `data:` 行结尾**），`l2Head` 是
 * 无前缀的后半段。恢复规则：**无分隔符直接拼**。
 *
 * ⚠️ 两个断点都不是完整的 JSON 片段 —— 拼接后才形成 `usage` 对象，
 * 故组装时必须补上 `}}`（闭合 `usage` 与根对象）。
 */
const LF_INJECTION_CASES: ReadonlyArray<{ name: string; l1Tail: string; l2Head: string }> = [
  { name: '实例 1', l1Tail: '"data_policy_pref', l2Head: 'erred_count":0,"from_model":"qwen3-coder"' },
  { name: '实例 2', l1Tail: ',"data_policy_pref', l2Head: 'erred_count":0,"from_model":"lite"' },
  { name: '实例 3', l1Tail: '"data_policy_preferred_count":0,"', l2Head: 'from_model":"qwen3-coder"' },
]

/**
 * 被注入 LF 切开的那一行 `data:` 行内容（`data:` 之后的部分）。
 *
 * ⚠️ 三个断点是**从不同偏移量截取的逐字节片段**，故 L1 尾是否自带前置逗号
 * 各不相同（实例 2 的尾本身就是 `,"data_policy_pref`）。这里按「尾已自带逗号
 * 就不再补」归一，**尾片段本身保持逐字节原样**。
 */
function injectionL1(l1Tail: string): string {
  const head = '{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":10,"total_tokens":21'
  return head + (l1Tail.startsWith(',') ? '' : ',') + l1Tail
}

/** 后半段（补上闭合 `usage` 与根对象的两个 `}`）。 */
function injectionL2(l2Head: string): string {
  return l2Head + '}}'
}

describe('流式解析器：usage 帧裸 LF 注入兜底', () => {
  for (const testCase of LF_INJECTION_CASES) {
    it(`${testCase.name}：被注入 LF 切开的 usage 帧仍能解析出来`, async () => {
      // 逐字节形态：`data: <L1>\n<L2>\n\n\n` —— 注入的 LF 把 JSON 切成两行，
      // 且第二行**没有** `data:` 前缀（这正是「按空行分帧」的规范累积器会失败的原因）。
      const raw = `data: ${injectionL1(testCase.l1Tail)}\n${injectionL2(testCase.l2Head)}\n\n\n`
        + frame('[DONE]')
      const { chunks, outcome } = await runStream(sseResponse(raw))
      expect(outcome.done).toBe(true)
      expect(usageOf(chunks)?.totalTokens).toBe(21)
      expect(usageOf(chunks)?.inputTokens).toBe(11)
    })
  }

  it('反证：无分隔符拼接 OK，用 \\n 拼接 FAIL（那个 LF 是凭空注入的）', () => {
    for (const testCase of LF_INJECTION_CASES) {
      const l1 = injectionL1(testCase.l1Tail)
      const l2 = injectionL2(testCase.l2Head)
      // 无分隔符直接拼 → 合法 JSON。
      expect(JSON.parse(l1 + l2)).toMatchObject({ usage: { total_tokens: 21 } })
      // 用 `\n` 拼 → 必然失败（JSON 字符串字面量里不允许裸换行）。
      // 本适配器因此绝不采用这种拼法。
      expect(() => JSON.parse(`${l1}\n${l2}`)).toThrow()
    }
  })

  it('未注入的大 usage 帧照常解析（兜底不改变正常路径）', async () => {
    const normal = frame('{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,'
      + '"total_tokens":150,"data_policy_preferred_count":0,"from_model":"qwen3-coder"}}')
      + frame('[DONE]')
    const { chunks, outcome } = await runStream(sseResponse(normal))
    expect(outcome.done).toBe(true)
    expect(usageOf(chunks)?.totalTokens).toBe(150)
  })

  it('usage 帧优先取 raw_usage（展开字段更全的那份）', async () => {
    const raw = frame('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1},'
      + '"raw_usage":{"prompt_tokens":70,"completion_tokens":30,"total_tokens":100,'
      + '"cache_read_tokens":20}}') + frame('[DONE]')
    const { chunks } = await runStream(sseResponse(raw))
    const usage = usageOf(chunks)
    expect(usage?.totalTokens).toBe(100)
    // 口径：inputTokens 只计未命中缓存的部分，命中部分单列。
    expect(usage?.inputTokens).toBe(50)
    expect(usage?.cacheReadTokens).toBe(20)
  })
})

// ── 5. tool_calls 聚合 ──

describe('流式解析器：tool_calls 增量聚合', () => {
  const TOOL_STREAM = frame('{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":'
    + '[{"index":0,"id":"call_abc","type":"function","function":{"name":"read","arguments":""}}]}}]}')
    + frame('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file"}}]}}]}')
    + frame('{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"a.txt\\"}"}}]}}]}')
    + frame('{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}')
    + frame('[DONE]')

  it('分片按 index 累积拼成完整 arguments', async () => {
    const { chunks, outcome } = await runStream(sseResponse(TOOL_STREAM))
    expect(outcome.hasToolCalls).toBe(true)
    const end = chunks.filter((chunk) => chunk.type === 'block-end').pop()
    const block = (end as { block: { type: string; name: string; arguments: string; id: string } }).block
    expect(block.type).toBe('tool-call')
    expect(block.name).toBe('read')
    expect(JSON.parse(block.arguments)).toEqual({ file_path: 'a.txt' })
  })

  it('⚠️ forced tool_choice 场景：finish_reason 是 "stop" 仍报 tool-calls', async () => {
    // T2 实测：forced `tool_choice` 时上游给 `finish_reason:"stop"` 而非 `"tool_calls"`。
    // 判据只能是「delta 里有没有 tool_calls 内容」。
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(TOOL_STREAM)) as unknown as typeof fetch,
    }))
    const chunks = await collect(adapter.stream(generateOptions()))
    expect(finishKind(chunks)).toBe('tool-calls')
  })

  it('多个工具调用按各自 index 分别聚合', async () => {
    const stream = frame('{"choices":[{"index":0,"delta":{"tool_calls":['
      + '{"index":0,"id":"call_a","function":{"name":"read","arguments":"{}"}},'
      + '{"index":1,"id":"call_b","function":{"name":"write","arguments":"{}"}}]}}]}')
      + frame('[DONE]')
    const { chunks, outcome } = await runStream(sseResponse(stream))
    expect(outcome.hasToolCalls).toBe(true)
    const ends = chunks.filter((chunk) => chunk.type === 'block-end')
    expect(ends).toHaveLength(2)
  })

  it('残缺 arguments 判为截断（由适配器报 max-tokens 而非 tool-calls）', async () => {
    const stream = frame('{"choices":[{"index":0,"delta":{"tool_calls":'
      + '[{"index":0,"id":"call_x","function":{"name":"read","arguments":"{\\"file_pat"}}]}}]}')
      + frame('[DONE]')
    const { outcome } = await runStream(sseResponse(stream))
    expect(outcome.argumentsTruncated).toBe(true)
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(stream)) as unknown as typeof fetch,
    }))
    expect(finishKind(await collect(adapter.stream(generateOptions())))).toBe('max-tokens')
  })

  it('思考增量走 reasoning 块', async () => {
    const stream = frame('{"choices":[{"index":0,"delta":{"reasoning_content":"想一下"}}]}') + frame('[DONE]')
    const { chunks } = await runStream(sseResponse(stream))
    const reasoning = chunks
      .filter((chunk): chunk is { type: 'reasoning-delta'; text: string } => chunk.type === 'reasoning-delta')
      .map((chunk) => chunk.text)
      .join('')
    expect(reasoning).toBe('想一下')
  })
})

// ── 6. 非流式路径 ──

describe('非流式路径（Content-Type: application/json）', () => {
  it('整包 completion 正常解析出正文与 usage', async () => {
    const body = JSON.stringify({
      id: 'c1',
      model: 'lite',
      choices: [{ index: 0, message: { role: 'assistant', content: '非流式回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    })
    const { chunks, outcome } = await runStream(sseResponse(body, 200, 'application/json'))
    expect(outcome.done).toBe(true)
    expect(textOf(chunks)).toBe('非流式回复')
    expect(usageOf(chunks)?.totalTokens).toBe(10)
    expect(outcome.model).toBe('lite')
  })

  it('非流式 tool_calls 一次性下发', async () => {
    const body = JSON.stringify({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }],
        },
      }],
    })
    const { chunks, outcome } = await runStream(sseResponse(body, 200, 'application/json'))
    expect(outcome.hasToolCalls).toBe(true)
    const block = (chunks.filter((chunk) => chunk.type === 'block-end').pop() as
      { block: { name: string; arguments: string } }).block
    expect(block.name).toBe('read')
    expect(JSON.parse(block.arguments)).toEqual({ p: 1 })
  })

  it('非流式 JSON 错误信封被分类，不当成功', async () => {
    const body = JSON.stringify({ error: { code: 'invalid_parameter_error', message: 'bad role' } })
    const { outcome } = await runStream(sseResponse(body, 200, 'application/json'))
    expect(outcome.done).toBe(false)
    expect(outcome.error?.code).toBe('invalid_parameter_error')
  })

  it('usage 解析：cache_write_tokens 与字符串形态数字', () => {
    expect(parseQoderUsage({ prompt_tokens: 5, completion_tokens: 5, cache_write_tokens: 3 })?.cacheWriteTokens).toBe(3)
    // 非数字 / 负值一律忽略
    expect(parseQoderUsage({ prompt_tokens: -1 })).toBeUndefined()
    expect(parseQoderUsage(null)).toBeUndefined()
  })
})

// ── 7. HTTP 层错误与 401 重换 ──

describe('HTTP 层错误分类', () => {
  it('extractQoderErrorFacts：402 的文案在 error 字段、code 是数字', () => {
    expect(extractQoderErrorFacts('{"code":116,"error":"quota exceeded"}'))
      .toEqual({ code: 116, message: 'quota exceeded' })
  })

  it('extractQoderErrorFacts：401 没有 code 字段', () => {
    expect(extractQoderErrorFacts('{"error":"unauthorized"}')).toEqual({ message: 'unauthorized' })
  })

  it('extractQoderErrorFacts：非 JSON 体回退成原文', () => {
    expect(extractQoderErrorFacts('boom')).toEqual({ message: 'boom' })
    expect(extractQoderErrorFacts('')).toEqual({})
  })

  it('402 + code:116 未确证 → 抛错且**不换号**', async () => {
    const getAvailableAccount = vi.fn()
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse('{"code":116,"error":"quota exceeded"}', 402)) as unknown as typeof fetch,
      // 刻意不注入 quotaVerdict：步骤 4 之前的保守路径。
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
      } as unknown as AccountPool,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/quota exceeded/)
    expect(getAvailableAccount).not.toHaveBeenCalled()
  })

  it('quota 确证耗尽 → 换号（注入 verdict 后唯一通向 switch-account 的路径）', async () => {
    let call = 0
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acct-2' },
      credential: { access_token: 'pt-second', refresh_token: '' },
    }))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => {
        call += 1
        return call === 1
          ? jsonResponse('{"code":116,"error":"quota exceeded"}', 402)
          : sseResponse(NORMAL_STREAM)
      }) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit: async () => {},
      } as unknown as AccountPool,
      quotaVerdict: async () => ({ exhausted: true }),
    }))
    const chunks = await collect(adapter.stream(generateOptions()))
    expect(getAvailableAccount).toHaveBeenCalledTimes(1)
    expect(textOf(chunks)).toBe('Hello world')
  })

  it('quota 判别返回未耗尽 → 不换号，直报', async () => {
    const getAvailableAccount = vi.fn()
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse('{"code":116,"error":"quota exceeded"}', 402)) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
      } as unknown as AccountPool,
      quotaVerdict: async () => ({ exhausted: false }),
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow()
    expect(getAvailableAccount).not.toHaveBeenCalled()
  })

  it('400 provider_error 包装码：二次解析出真码并出现在错误文案里', async () => {
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Error in upstream response',
      request_id: '5376777cd1f1-…',
      type: 'provider_error',
      details: '{"error":{"message":"<400> InternalError.Algo.InvalidParameter: Role must be …",'
        + '"type":"invalid_request_error","param":null,"code":"invalid_parameter_error"},'
        + '"id":"chatcmpl-f561d739-…","request_id":"f561d739-…"}',
    })
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse(body, 400)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/invalid_parameter_error/)
  })

  it('凭据缺失 → MISSING_CREDENTIAL', async () => {
    const adapter = new QoderAdapter(adapterOptions({ resolveCredential: async () => undefined }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('未注入 job token 提供者 → 明确报错而不是静默降级用 PAT', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      getJobToken: undefined,
      fetchImpl: (async () => sseResponse(NORMAL_STREAM)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('401 静默重换 jt 一次', () => {
  it('首次 401 → invalidate + 重换 → 重试成功', async () => {
    const invalidate = vi.fn()
    let tokenCall = 0
    let fetchCall = 0
    const adapter = new QoderAdapter(adapterOptions({
      getJobToken: async () => { tokenCall += 1; return `jt-${tokenCall}` },
      invalidateJobToken: invalidate,
      fetchImpl: (async () => {
        fetchCall += 1
        return fetchCall === 1
          ? jsonResponse('{"error":"unauthorized"}', 401)
          : sseResponse(NORMAL_STREAM)
      }) as unknown as typeof fetch,
    }))
    const chunks = await collect(adapter.stream(generateOptions()))
    // 缓存必须先被丢弃，否则 getJobToken 会把被判失效的同一个 jt 原样还回来。
    expect(invalidate).toHaveBeenCalledWith('pt-test-token')
    expect(tokenCall).toBe(2)
    expect(textOf(chunks)).toBe('Hello world')
  })

  it('两次都 401 → 判凭据失效（AUTH）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse('{"error":"unauthorized"}', 401)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('非 401 的 402 不触发重换（只有 401 是 jt 过期信号）', async () => {
    const invalidate = vi.fn()
    const adapter = new QoderAdapter(adapterOptions({
      invalidateJobToken: invalidate,
      fetchImpl: (async () => jsonResponse('{"code":116,"error":"quota exceeded"}', 402)) as unknown as typeof fetch,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
  })
})

// ── 8. 换号边界 ──

describe('换号循环边界', () => {
  it('已透传过内容后流内失败不再换号（避免正文重复）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acct-2' },
      credential: { access_token: 'pt-second', refresh_token: '' },
    }))
    // 先发一段正文，再报流内错误。
    const partialThenError = frame('{"choices":[{"index":0,"delta":{"content":"半截"}}]}')
      + frame(ERROR_FRAME_A_PAYLOAD)
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(partialThenError)) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
      } as unknown as AccountPool,
    }))
    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const chunk of adapter.stream(generateOptions())) seen.push(chunk)
    })()).rejects.toThrow()
    // 用户看到的仍是那半截内容，没有被第二段完整回答污染。
    expect(textOf(seen)).toBe('半截')
    expect(getAvailableAccount).not.toHaveBeenCalled()
  })

  it('换号次数有上限：3 个账号全部额度耗尽后停止', async () => {
    let fetchCall = 0
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: `acct-${fetchCall + 1}` },
      credential: { access_token: `pt-${fetchCall + 1}`, refresh_token: '' },
    }))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => {
        fetchCall += 1
        return jsonResponse('{"code":116,"error":"quota exceeded"}', 402)
      }) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit: async () => {},
      } as unknown as AccountPool,
      quotaVerdict: async () => ({ exhausted: true }),
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow(/quota exceeded/)
    // MAX_ROTATE = 3（含首次）⇒ 总共 3 次请求、2 次换号。
    expect(fetchCall).toBe(3)
    expect(getAvailableAccount).toHaveBeenCalledTimes(2)
  })

  it('已确证额度耗尽时写冷却徽章（下一次选号跳过该账号）', async () => {
    const updateModelRateLimit = vi.fn(async () => {})
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse('{"code":116,"error":"quota exceeded"}', 402)) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount: async () => undefined,
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit,
      } as unknown as AccountPool,
      quotaVerdict: async () => ({ exhausted: true }),
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow()
    expect(updateModelRateLimit).toHaveBeenCalledTimes(1)
    expect(updateModelRateLimit.mock.calls[0][0]).toBe('acct-1')
  })

  it('未确证的 402 不写冷却徽章（写了下一次就会偷偷换号）', async () => {
    const updateModelRateLimit = vi.fn(async () => {})
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => jsonResponse('{"code":116,"error":"quota exceeded"}', 402)) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount: async () => undefined,
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit,
      } as unknown as AccountPool,
    }))
    await expect(collect(adapter.stream(generateOptions()))).rejects.toThrow()
    expect(updateModelRateLimit).not.toHaveBeenCalled()
  })
})

// ── 9. 模型目录已接线（步骤 3；完整目录面在 qoder-models.spec.ts） ──

describe('模型目录已接线（步骤 3 起不再是占位）', () => {
  it('listModels 不再抛「未实现」，而是给出目录（此处为目录失败的回退表）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
  })

  it('resolveModel 声明目录产出的能力（此处为静态兜底表的档位与窗口）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(resolved.name).toBe('Qwen3.8-Max')
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
    expect(resolved.context).toEqual({ contextWindow: 200_000 })
    // ⚠️ 模态**恒为纯文本**，与目录的 is_vl 无关（见 qoder-models.spec.ts 的
    // 「模态恒声明纯文本」用例）。
    expect(resolved.inputModalities).toEqual(['text'])
  })

  it('providerInfo 对非字符串 provider 做防御性回退', () => {
    const adapter = new QoderAdapter(adapterOptions())
    expect(adapter.providerInfo(undefined as unknown as string).id).toBe('qoder')
    expect(adapter.providerInfo('qoder').name).toBe('Qoder')
  })
})

// ── 10. 本地字节闸（256 KiB 墙；真机取证的确定性阈值） ──────────────────────

/**
 * 网关对请求体有一条**确定性**字节墙：≥ 262 144 B 恒回 HTTP 500
 * `{"error":"internal server error"}`，**无任何可判别的 code**（2026-09-21
 * 字节级矩阵：262 144 B → 200 四次复测、262 145 B → 500 三次复测）。
 *
 * 交给下游分类器只会落进 `5xx → backoff`（无限退避重试一个不可能成功的请求），
 * 故闸门必须发生在**序列化之后、fetch 之前**：本地量字节、本地判、本地抛
 * `CONTEXT_WINDOW_EXCEEDED`（DSH 的自动压缩补救只认这个码）。
 *
 * 这一组用例的两条主线：
 * 1. **阈值处真的不发请求**（断言 fetch 零调用 —— 这是本功能的全部意义）；
 * 2. **阈值下照常放行**（闸门不能误伤正常请求）。
 */
describe('本地字节闸', () => {
  /**
   * 造一个「请求体恰好 N 字节」的 options。
   *
   * 用 {@link buildQoderChatBody} 自己量出**空正文时**的固定开销（模型名 /
   * 元数据 / JSON 结构），再补足正文 —— 这样「阈值处」「阈值下一字节」是
   * **精确**构造的，而不是靠估一个大数碰运气。
   *
   * ⚠️ 基准必须量**空正文**那版：量 `generateOptions()` 默认的 `'hi'` 会多算
   * 两个字符，夹具就整体偏移 2 字节，「恰好等于阈值」那条断言会变成
   * 「阈值 − 2」（用例仍然绿，但测的已经不是边界）。
   * ASCII 正文保证 1 字符 = 1 字节。
   */
  function optionsWithBodyBytes(target: number): GenerateOptions {
    const empty: GenerateOptions = generateOptions({
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    })
    const base = Buffer.byteLength(buildQoderChatBody(empty), 'utf8')
    const filler = 'x'.repeat(target - base)
    return generateOptions({
      messages: [{ role: 'user', content: [{ type: 'text', text: filler }] }],
    })
  }

  it('阈值处（245 760 B）：不发请求，直接抛 CONTEXT_WINDOW_EXCEEDED', async () => {
    const fetcher = vi.fn(async () => sseResponse(NORMAL_STREAM))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
    }))
    const options = optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES)
    // 先确证这个夹具真的是「恰好在阈值上」（否则下面测的是别的东西）。
    expect(Buffer.byteLength(buildQoderChatBody(options), 'utf8')).toBe(QODER_MAX_REQUEST_BYTES)

    await expect(collect(adapter.stream(options)))
      .rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    // ⚠️ 本功能的**全部意义**就在这一条：请求根本没发出去。
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('阈值下一字节：放行（闸门不误伤正常请求）', async () => {
    const fetcher = vi.fn(async () => sseResponse(NORMAL_STREAM))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
    }))
    const options = optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES - 1)

    const chunks = await collect(adapter.stream(options))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(textOf(chunks)).toBe('Hello world')
  })

  it('远超阈值（320 KiB）：同样本地拦下，且不换号、不记冷却徽章', async () => {
    const fetcher = vi.fn(async () => sseResponse(NORMAL_STREAM))
    const getAvailableAccount = vi.fn()
    const updateModelRateLimit = vi.fn()
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount,
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit,
      } as unknown as AccountPool,
    }))

    await expect(collect(adapter.stream(optionsWithBodyBytes(320 * 1024))))
      .rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(fetcher).not.toHaveBeenCalled()
    // 请求太大与账号无关：换号只会拿同一个超长 body 再撞一次同一道墙。
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(updateModelRateLimit).not.toHaveBeenCalled()
  })

  it('错误文案不丢关键信息（字节数 / 256 KiB / 压缩重试 / 新建对话）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(NORMAL_STREAM)) as unknown as typeof fetch,
    }))

    const error = await collect(adapter.stream(optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES)))
      .then(() => undefined, (caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(Error)
    const message = String(error?.message)
    expect(message).toContain('256 KiB')
    expect(message).toContain('压缩')
    expect(message).toContain('新建对话')
    // 真的报出**实测的那个字节数**（不是阈值），用户据此能知道超了多少。
    expect(message).toContain(String(QODER_MAX_REQUEST_BYTES))
  })

  it('每次发送都报出 bodyBytes（debug 观测；撞墙趋势要可见）', async () => {
    const seen: string[] = []
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(NORMAL_STREAM)) as unknown as typeof fetch,
      onDebug: (message) => seen.push(message),
    }))
    const options = optionsWithBodyBytes(1000)

    await collect(adapter.stream(options))
    const expected = Buffer.byteLength(buildQoderChatBody(options), 'utf8')
    expect(seen.join('\n')).toContain(String(expected))
    expect(seen.join('\n')).toContain('阈值')
  })

  it('被拦下时**也**报 bodyBytes（否则「刚好撞闸」在日志里是空白）', async () => {
    const seen: string[] = []
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(NORMAL_STREAM)) as unknown as typeof fetch,
      onDebug: (message) => seen.push(message),
    }))

    await expect(collect(adapter.stream(optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES)))).rejects.toThrow()
    expect(seen.join('\n')).toContain(String(QODER_MAX_REQUEST_BYTES))
  })
})
