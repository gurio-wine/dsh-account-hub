/**
 * 消费侧（SSE 解析）回归：**名称为空的 tool-call 不得产出任何 chunk** ——
 * buddy（CodeBuddy / WorkBuddy）、codearts、trae-cn 三条线。
 *
 * ## 为什么这三个 provider 也要修
 *
 * 坏块**跨 provider 传染**：任一条线把无名分片落成 `name:''` 的块，harness 就会
 * 执行出 `unknown tool ""` 并把这条坏块**持久化进会话**；此后用户切到腾讯系端点，
 * 坏块被每次请求原样重放 → **HTTP 400 code 11133**，会话彻底报废。
 * 序列化侧（`resolveToolPairing`）只救**存量**会话；消费侧不修，坏块会**再次**产生。
 *
 * ⚠️ **只跳过收尾的 `block-end` 是不够的**：上游 `BlockAssembler.assemble()`
 * 对没有 `block-end` 的 partial 同样会组装出
 * `name: partial.toolCallName ?? ''`（已核对 `dsh-llm/lib/index.js:881`）。
 * 必须让该块**一个 chunk 都不产出**（连同 `block-start`）。
 *
 * ## 本文件锁定的三件事
 *
 * 1. 无名分片 → 零 tool-call chunk；
 * 2. 名字**延迟到达** → 已累积参数不得丢失（一次性补发），正常形态行为不变；
 * 3. 丢弃无名调用且**无**可用调用留下 → finish 报 `max-tokens`（可重试），
 *    **不是** `stop`（否则模型本意调工具、harness 却认为「正常答完了」）。
 *    同批还有可用调用时照常报 `tool-calls`。
 */
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { TraeCnAdapter } from '../../src/trae-cn-adapter.js'
import { BUDDY_CN } from '../../src/product.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CodeArtsCredential } from '../../src/types.js'
import type { TraeCnCredential } from '../../src/trae-cn.js'

// ── 通用断言工具 ──

/** 该 chunk 列表里是否出现任何 tool-call 相关 chunk。 */
function toolChunks(chunks: readonly StreamChunk[]): StreamChunk[] {
  return chunks.filter((chunk) =>
    (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
}

/** 取最后一个 finish chunk 的 reason.kind。 */
function finishKind(chunks: readonly StreamChunk[]): string | undefined {
  const finish = chunks.filter((chunk) => chunk.type === 'finish').at(-1)
  return finish?.type === 'finish' ? finish.reason.kind : undefined
}

/** 取 tool-call 的 block-end 载荷。 */
function toolEnds(chunks: readonly StreamChunk[]): Array<{ id?: string; name?: string; arguments?: string }> {
  return chunks
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    .map((chunk) => (chunk as { block: { id?: string; name?: string; arguments?: string } }).block)
}

// ── 通用 SSE 构造 ──

/** 无名 tool-call 分片（线上实测形态：完全没有 `name` 字段）。 */
function unnamedToolCallFrame(index: number, id: string, args = ''): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { arguments: args } }] } }],
  })}\n\n`
}

/** 带名字的 tool-call 分片。 */
function namedToolCallFrame(index: number, name: string, args: string, id?: string): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index,
          ...id === undefined ? {} : { id },
          type: 'function',
          function: { name, arguments: args },
        }],
      },
    }],
  })}\n\n`
}

const FINISH_TOOL_CALLS = `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'tool_calls' }],
})}\n\n`
const DONE_FRAME = 'data: [DONE]\n\n'

/** 一个无名 + 一个合法调用（线上真实形态）同帧下发。 */
function mixedToolCallFrame(): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, id: 'call_bad', type: 'function', function: { arguments: '{}' } },
          { index: 1, id: 'call_good', type: 'function', function: { name: 'pwsh', arguments: '{"command":"ls"}' } },
        ],
      },
    }],
  })}\n\n`
}

// ── Buddy（CodeBuddy 中国版 / WorkBuddy 国际版共用同一个适配器） ──

describe('Buddy 消费侧：名称为空的 tool-call 不得产出任何 chunk', () => {
  function makeBuddy(fetchImpl: typeof fetch) {
    const credential: BuddyCredential = {
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      token_type: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    }
    return new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_CN_ACCESS_TOKEN'),
      resolveCredential: async () => credential,
      refresh: async () => {},
      fetchImpl,
      product: BUDDY_CN,
    })
  }

  /** 把 SSE 文本包成 Response。 */
  function sse(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function drain(adapter: BuddyAdapter): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ model: 'deepseek-v4.1-flash', messages: [] } as never)) {
      chunks.push(chunk)
    }
    return chunks
  }

  it('无名分片 → 零 tool-call chunk，且 finish 报 max-tokens（不是 stop）', async () => {
    const adapter = makeBuddy((async () => sse(
      unnamedToolCallFrame(2, 'call_25e97a78849f449da444fc72') + FINISH_TOOL_CALLS + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    expect(toolChunks(chunks)).toEqual([])
    expect(finishKind(chunks)).toBe('max-tokens')
  })

  it('名字延迟到达：已累积参数不得丢失', async () => {
    const adapter = makeBuddy((async () => sse(
      unnamedToolCallFrame(0, 'call_x', '{"command":')
      + namedToolCallFrame(0, 'pwsh', '"ls"}')
      + FINISH_TOOL_CALLS + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: 'call_x', name: 'pwsh' })
    expect(ends[0]!.arguments).toBe('{"command":"ls"}')
    expect(finishKind(chunks)).toBe('tool-calls')
  })

  it('一个无名 + 一个合法：保留合法者，照常报 tool-calls', async () => {
    const adapter = makeBuddy((async () => sse(
      mixedToolCallFrame() + FINISH_TOOL_CALLS + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: 'call_good', name: 'pwsh' })
    expect(finishKind(chunks)).toBe('tool-calls')
  })
})

// ── CodeArts（含两条 DSML 分支） ──

describe('CodeArts 消费侧：名称为空的 tool-call 不得产出任何 chunk', () => {
  function makeCodeArts(fetchImpl: typeof fetch) {
    const credential: CodeArtsCredential = {
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2099-01-01T00:00:00Z',
    }
    return new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async () => credential,
      refresh: async () => {},
      fetchImpl,
    })
  }

  function sse(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function drain(adapter: CodeArtsAdapter): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      model: 'GLM-5.2', messages: [], signal: new AbortController().signal,
    } as never)) {
      chunks.push(chunk)
    }
    return chunks
  }

  it('无名 tool_calls 分片 → 零 tool-call chunk，且 finish 报 max-tokens', async () => {
    const adapter = makeCodeArts((async () => sse(
      unnamedToolCallFrame(0, 'call_bad') + FINISH_TOOL_CALLS + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    expect(toolChunks(chunks)).toEqual([])
    expect(finishKind(chunks)).toBe('max-tokens')
  })

  it('名字延迟到达：已累积参数不得丢失', async () => {
    const adapter = makeCodeArts((async () => sse(
      unnamedToolCallFrame(0, 'call_x', '{"command":')
      + namedToolCallFrame(0, 'bash', '"ls"}')
      + FINISH_TOOL_CALLS + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: 'call_x', name: 'bash' })
    expect(ends[0]!.arguments).toBe('{"command":"ls"}')
  })

  /**
   * DSML 分支：codearts 有**两条** DSML 出口（`delta.content` 与
   * `delta.reasoning_content`），两条都必须接同一判据 —— 漏一条就等于漏一条路径。
   *
   * DSML 里的名字由 `parseDsmlInvoke` 从 XML 属性解析，**理论上**不会是空串；
   * 但那是解析器的内部假设，不是协议保证。此处用一个畸形 invoke（缺 `name` 属性）
   * 验证防线确实在，而不是靠「上游不会那样发」。
   */
  it('DSML：缺 name 属性的 invoke 不产出任何 tool-call chunk', async () => {
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke>'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const adapter = makeCodeArts((async () => sse(
      `data: ${JSON.stringify({ choices: [{ delta: { content: dsml }, finish_reason: 'stop' }] })}\n\n`
      + DONE_FRAME,
    )) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    // 该畸形块必须一个 chunk 都不产出（不能留下 name:'' 的坏块）。
    expect(toolEnds(chunks).filter((end) => !end.name)).toEqual([])
    for (const end of toolEnds(chunks)) {
      expect(String(end.name).trim().length).toBeGreaterThan(0)
    }
  })
})

// ── Trae CN ──

describe('Trae CN 消费侧：名称为空的 tool-call 不得产出任何 chunk', () => {
  function makeTraeCn(fetchImpl: typeof fetch) {
    const credential: TraeCnCredential = {
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      user_id: 'u1', machine_id: 'm1',
    } as TraeCnCredential
    return new TraeCnAdapter({
      credentialRef: credentialRef('TRAE_CN_ACCOUNT_TEST'),
      resolveCredential: async () => credential,
      refresh: async () => {},
      fetchImpl,
      fetchRemoteModels: async () => [],
      product: TRAE_CN,
    })
  }

  /** trae-cn 是**具名事件**流，不是 OpenAI 形态。 */
  function traeSse(events: Array<{ event: string; data: unknown }>): Response {
    const body = events.map(({ event, data }) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`).join('')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function drain(adapter: TraeCnAdapter): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      model: 'glm-5.2', messages: [], signal: new AbortController().signal,
    } as never)) {
      chunks.push(chunk)
    }
    return chunks
  }

  it('无名 tool_call 帧 → 零 tool-call chunk，且 finish 报 max-tokens', async () => {
    // 独立 `event:tool_call` 帧只带 id + 参数、**没有 name**。
    const adapter = makeTraeCn((async () => traeSse([
      { event: 'metadata', data: { conversation_id: 'c1' } },
      { event: 'tool_call', data: { id: 'call_bad', arguments: '{}' } },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ])) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    expect(toolChunks(chunks)).toEqual([])
    // ⚠️ 必须是 max-tokens 而非 stop，也不能是 EMPTY_RESPONSE ——
    // 模型明确要调工具、只是名字缺失，那**不是**「上游什么都没回」。
    expect(finishKind(chunks)).toBe('max-tokens')
  })

  it('名字延迟到达：已累积参数不得丢失', async () => {
    const adapter = makeTraeCn((async () => traeSse([
      { event: 'metadata', data: { conversation_id: 'c1' } },
      { event: 'tool_call', data: { id: 'call_x', arguments: '{"file_path":"a' } },
      { event: 'tool_call', data: { name: 'read', arguments: '.ts"}' } },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ])) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: 'call_x', name: 'read' })
    expect(ends[0]!.arguments).toBe('{"file_path":"a.ts"}')
    expect(finishKind(chunks)).toBe('tool-calls')
  })

  it('一个无名 + 一个合法：保留合法者，照常报 tool-calls', async () => {
    // ⚠️ 必须用 **`output` 帧内嵌的 `tool_calls` 数组**（真机主要形态）来表达
    // 「两个调用」：独立 `event:tool_call` 帧**没有自己的 wire index**
    // （适配器按 0 累积），两帧会被并成同一个调用、参数还会被拼接 ——
    // 那是这条投递形态的既有语义，不是本缺陷。内嵌数组带 per-item `index`，
    // 才能真正构造出「同批两个调用」。
    const adapter = makeTraeCn((async () => traeSse([
      { event: 'metadata', data: { conversation_id: 'c1' } },
      {
        event: 'output',
        data: {
          response: '',
          tool_calls: [
            { index: 0, id: 'call_bad', function_call: { arguments: '{}' } },
            { index: 1, id: 'call_good', function_call: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
          ],
        },
      },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ])) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: 'call_good', name: 'read' })
    expect(finishKind(chunks)).toBe('tool-calls')
  })

  it('正常流（首片即带 name）行为不变', async () => {
    const adapter = makeTraeCn((async () => traeSse([
      { event: 'metadata', data: { conversation_id: 'c1' } },
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' } },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ])) as unknown as typeof fetch)

    const chunks = await drain(adapter)
    const ends = toolEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ name: 'read' })
    expect(finishKind(chunks)).toBe('tool-calls')
  })
})
