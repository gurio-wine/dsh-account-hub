/**
 * 消费侧（SSE 解析）回归：**名称为空的 tool-call 不得产出任何 chunk**
 * + **网关形态错误帧不得被静默吞掉**。
 *
 * ## 为什么消费侧必须修（而不只是序列化侧）
 *
 * 序列化侧（`resolveToolPairing`）只能让**存量**会话自愈；若消费侧继续把无名
 * 分片落成 `name:''` 的块，坏块就会**再次**产生并持久化进会话 —— 治标不治本。
 * 两处缺一不可，这是上游 a391dcc 明确的分工。
 *
 * ⚠️ **只跳过收尾的 `block-end` 是不够的**：上游 `BlockAssembler.assemble()`
 * 对没有 `block-end` 的 partial 同样会组装出
 * `name: partial.toolCallName ?? ''`（已核对 `dsh-llm/lib/index.js:881`）。
 * 必须让该块**一个 chunk 都不产出**（连同 `block-start`），assembler 才会
 * 彻底看不见它 —— 这正是本文件的核心断言。
 *
 * ## 三件事一起锁死
 *
 * 1. 无名分片 → 零 tool-call chunk（连 `block-start` 都没有）；
 * 2. 名字**延迟到达** → 已累积的参数不得丢失（一次性补发），正常形态行为不变；
 * 3. 丢弃了无名调用且**没有**可用调用留下 → finish 报 `max-tokens`（可重试），
 *    **不是** `stop` —— 否则模型本意调工具、harness 却认为「正常答完了」，
 *    又是一次「没有任何报错就中断」。
 *    同批若还有可用调用，则照常报 `tool-calls`（坏块不连累好块）。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { classifyQoderError } from '../../src/qoder-errors.js'
import { consumeQoderStream } from '../../src/qoder-adapter.js'
import type { QoderStreamOptions, QoderStreamOutcome } from '../../src/qoder-adapter.js'

/** 把一帧拼成 SSE 文本（分隔符用该 provider 实测的 `\n\n\n`）。 */
function frame(payload: string, eventName?: string): string {
  const head = eventName === undefined ? '' : `event: ${eventName}\n`
  return `${head}data: ${payload}\n\n\n`
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/** 消费一个流，同时拿到 chunks 与 outcome。 */
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

/** 只带 id / args、**完全没有 name** 的 tool-call 分片（线上实测形态）。 */
function unnamedFrame(index: number, id: string, args = ''): string {
  return frame(JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { arguments: args } }] } }],
  }))
}

/** 带名字的 tool-call 分片。 */
function namedFrame(index: number, name: string, args: string, id?: string): string {
  return frame(JSON.stringify({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          ...id === undefined ? {} : { id },
          type: 'function',
          function: { name, arguments: args },
        }],
      },
    }],
  }))
}

const FINISH_TOOL_CALLS = frame(JSON.stringify({
  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
}))
const DONE = frame('[DONE]')

/** 该流里是否出现任何 tool-call 相关 chunk。 */
function toolChunks(chunks: readonly StreamChunk[]): StreamChunk[] {
  return chunks.filter((chunk) =>
    (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
}

describe('消费侧：名称为空的 tool-call 不得产出任何 chunk', () => {
  it('无名分片不产出 block-start / tool-call-delta / block-end', async () => {
    // 回归（真实缺陷）：早期在首片就 `yield block-start`，名字稍后才到；
    // 而永远不带 name 的分片会让 BlockAssembler 组装出 `name:''` 的块，
    // 被 harness 执行成 `unknown tool ""` 并**持久化进会话**，
    // 之后切到腾讯系端点时被每次请求重放 → HTTP 400 code 11133。
    const { chunks, outcome } = await runStream(
      sseResponse(unnamedFrame(2, 'call_25e97a78849f449da444fc72') + FINISH_TOOL_CALLS + DONE),
    )

    // ① 连 block-start 都不能有 —— 否则 assembler 会为它建 partial。
    expect(toolChunks(chunks)).toEqual([])
    // ② outcome 侧也不得声称「有工具调用」。
    expect(outcome.hasToolCalls).toBe(false)
    // ③ 但必须让调用方知道「丢弃过无名调用」，否则会静默 stop。
    expect(outcome.droppedUnnamedCalls).toBe(true)
    expect(outcome.produced).toBe(false)
  })

  it('名字**延迟到达**时：先前累积的参数不得丢失（一次性补发）', async () => {
    // 首片只有 args、第二片才带 name —— 并行工具调用时常见。
    // 正常形态（首片即带 name）必须与旧行为完全一致。
    const { chunks, outcome } = await runStream(sseResponse(
      unnamedFrame(0, 'call_x', '{"command":')
      + namedFrame(0, 'pwsh', '"ls"}')
      + FINISH_TOOL_CALLS + DONE,
    ))

    const ends = chunks.filter(
      (chunk): chunk is { type: 'block-end'; block: { type: 'tool-call'; id: string; name: string; arguments: string } } =>
        chunk.type === 'block-end' && chunk.block.type === 'tool-call',
    )
    expect(ends).toHaveLength(1)
    // 名字可用前累积的参数必须**完整**补发（丢失它等于伪造一次缺参调用）。
    expect(ends[0]!.block).toMatchObject({ id: 'call_x', name: 'pwsh', arguments: '{"command":"ls"}' })
    expect(outcome.hasToolCalls).toBe(true)
    expect(outcome.droppedUnnamedCalls).toBe(false)
  })

  it('一个无名 + 一个合法调用：保留合法者，**不**因坏块作废好块', async () => {
    const mixed = frame(JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_bad', type: 'function', function: { arguments: '{}' } },
            { index: 1, id: 'call_good', type: 'function', function: { name: 'pwsh', arguments: '{"command":"ls"}' } },
          ],
        },
      }],
    }))
    const { chunks, outcome } = await runStream(sseResponse(mixed + FINISH_TOOL_CALLS + DONE))

    const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { id: 'call_good', name: 'pwsh' } })
    expect(outcome.hasToolCalls).toBe(true)
    expect(outcome.droppedUnnamedCalls).toBe(true)
  })

  it('正常流（首片即带 name）行为不变', async () => {
    const { chunks, outcome } = await runStream(sseResponse(
      namedFrame(0, 'read', '{"file_path":"a.ts"}', 'call_abc') + FINISH_TOOL_CALLS + DONE,
    ))
    const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { name: 'read' } })
    expect(outcome.droppedUnnamedCalls).toBe(false)
    expect(outcome.hasToolCalls).toBe(true)
  })

  it('非流式 JSON 路径同样丢弃无名调用（同一缺陷，同一判据）', async () => {
    const body = JSON.stringify({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_bad', type: 'function', function: { arguments: '{}' } },
            { id: 'call_good', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
          ],
        },
      }],
    })
    const { chunks, outcome } = await runStream(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { id: 'call_good', name: 'read' } })
    expect(outcome.droppedUnnamedCalls).toBe(true)
    expect(outcome.hasToolCalls).toBe(true)
  })
})

describe('网关形态错误帧不得被静默吞掉', () => {
  /**
   * 真机形态：既没有 `code`、也没有 `error`、也没有 `choices`，
   * 只带 `statusCodeValue` / `stackTrace` + `message`。
   *
   * 早期判定全部条件都不命中，下面「`choices` 不是数组 ⇒ continue」把它
   * **整帧丢弃** → 流照常结束 → 报笼统的「Stream ended without [DONE]」，
   * 网关真正说了什么完全丢失。
   */
  const gatewayFrame = (message: string, statusCodeValue: number): string =>
    frame(JSON.stringify({ stackTrace: ['a', 'b'], message, statusCodeValue }), 'error')

  it('{message, statusCodeValue:400} 必须被判为错误（不再静默）', async () => {
    const { outcome } = await runStream(sseResponse(gatewayFrame('upstream boom', 400)))
    expect(outcome.error).toBeDefined()
    // 用户的诊断信息来自网关原文，必须原样带出。
    expect(outcome.error!.message).toContain('upstream boom')
    expect(outcome.done).toBe(false)
  })

  it('statusCodeValue:500 同样判错（不能只看 4xx）', async () => {
    const { outcome } = await runStream(sseResponse(frame(
      JSON.stringify({ message: 'gateway exploded', statusCodeValue: 500 }),
    )))
    expect(outcome.error).toBeDefined()
    expect(outcome.error!.message).toContain('gateway exploded')
  })

  it('没有 `event: error` 前缀、仅凭帧内字段也要认出来', async () => {
    // 两条独立判据（事件名 / 帧内字段）任一成立即判错 —— 不能只靠事件名。
    const { outcome } = await runStream(sseResponse(frame(
      JSON.stringify({ stackTrace: [], message: 'no event name', statusCodeValue: 429 }),
    )))
    expect(outcome.error).toBeDefined()
    expect(outcome.error!.message).toContain('no event name')
  })

  it('帧内状态码参与分类（不被恒为 200 的传输层状态抹平）', async () => {
    // 这是本组最容易写错的一处：`options.httpStatus` 在流内恒为 200，
    // 直接拿它分类会把 500 也当成「200 = 成功」，走错兜底分支。
    const { outcome } = await runStream(sseResponse(frame(
      JSON.stringify({ message: 'server side failure', statusCodeValue: 500 }),
    )))
    expect(outcome.error).toBeDefined()
    // 500 + 无业务码 → 分类器判退避（可重试），而不是「未知/成功」。
    expect(outcome.error!.action).toBe('backoff')
    // 反向：同一帧若被当成 200 处理，分类器不会给出 backoff。
    expect(classifyQoderError({ httpStatus: 200, message: 'server side failure', source: 'chat' }).action)
      .not.toBe('backoff')
  })

  it('没有 choices 但也没有错误信号 → 不误杀（只带 usage 的收尾帧）', async () => {
    const usageOnly = frame(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      + frame(JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] }))
      + DONE
    const { outcome } = await runStream(sseResponse(usageOnly))
    expect(outcome.error).toBeUndefined()
    expect(outcome.done).toBe(true)
  })

  it('非流式路径的同形网关信封同样不再落空', async () => {
    const body = JSON.stringify({ stackTrace: [], message: 'json gateway boom', statusCodeValue: 400 })
    const { outcome } = await runStream(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    expect(outcome.error).toBeDefined()
    expect(outcome.error!.message).toContain('json gateway boom')
  })
})
