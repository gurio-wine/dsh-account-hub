/**
 * 适配器侧的思考死循环中断 / 行首泄漏清洗回归。
 *
 * 覆盖**五个** provider 的接线（codearts / buddy / lobsterai / qoder / trae-cn），
 * 因为五处读取循环结构各不相同（`for (;;)` / `while`、变量名各异），
 * 漏接任何一处都等于漏一条路径。
 *
 * 验收四条：
 * 1. 命中后思考块只剩循环前的干净前缀（截断生效）；
 * 2. `finish` 报 `max-tokens`（可重试），**不是** `stop` —— 否则 harness
 *    会认为「模型正常答完」而让任务静默中断；
 * 3. 命中后**中止上游**（`reader.cancel()`），不再把流读到底；
 * 4. 未命中时行为与现状完全一致。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { CodeArtsAdapter } from '../../src/llm-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { TraeCnAdapter } from '../../src/trae-cn-adapter.js'
import { BUDDY } from '../../src/product.js'
import type { CodeArtsCredential } from '../../src/types.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures')

/** 读 fixture 文本。 */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/**
 * 顶层 `beforeEach`（不是只在文件末尾放 `afterEach`）：若开发者 shell 里设了
 * `DSH_REASONING_LOOP_GUARD` / `DSH_COURSE_LEAK_STRIP`，**文件内首条用例**
 * 会继承该值而失败 —— 末尾的 afterEach 只能清掉后续用例的污染，救不了第一条。
 */
beforeEach(() => {
  delete process.env.DSH_REASONING_LOOP_GUARD
  delete process.env.DSH_COURSE_LEAK_STRIP
})

afterEach(() => {
  delete process.env.DSH_REASONING_LOOP_GUARD
  delete process.env.DSH_COURSE_LEAK_STRIP
})

/** 把一段长文本切成 OpenAI SSE reasoning 帧。 */
function reasoningFrames(text: string, chunkSize = 256): string {
  const frames: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize)
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: delta } }] })}\n\n`)
  }
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/**
 * 把帧数组包装成**可计数**的响应**工厂**：`consumed()` 返回上游实际被读取的帧数。
 *
 * 用途：命中死循环后必须**中止上游**（`reader.cancel()`），否则读取循环仍把流
 * 读到底 —— 实测上游 200 帧被读 200 帧，额度照烧。
 *
 * ⚠️ 必须用逐帧 `pull` 的可计数流：把整个 SSE 拼成一个 `Response` 时全部帧在
 * 一次读取里到达，「读到底」与「提前停止」无法区分。
 *
 * ⚠️ 也必须是**工厂**而不是单一 `Response`：`Response` 的 body 只能被读一次，
 * 而本文件的 `fetchImpl` 桩会被同一个适配器调用多次（目录拉取 / 重试）。
 * 返回同一个实例会让第二次 `getReader()` 抛 `ReadableStream is locked`。
 */
function countedResponse(frames: string[]): {
  make: () => Response
  consumed: () => number
} {
  const encoder = new TextEncoder()
  let consumed = 0
  return {
    make: () => {
      let index = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= frames.length) { controller.close(); return }
          consumed += 1
          controller.enqueue(encoder.encode(frames[index]))
          index += 1
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
    consumed: () => consumed,
  }
}

/** 构造「死循环 reasoning 帧 + 补足帧 + 收尾帧」的帧数组（OpenAI SSE 形态）。 */
function openAiLoopFrames(totalFrames: number, finishFrames: string[]): string[] {
  const loop = fixture('reasoning-loop.txt')
  const frames: string[] = []
  for (let i = 0; i < loop.length; i += 256) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
  }
  while (frames.length < totalFrames - finishFrames.length) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me write.\n\nGo.\n\nOK.\n\nWriting.\n\n' } }] })}\n\n`)
  }
  frames.push(...finishFrames)
  return frames
}

/** trae-cn 专用：SOLO 自定义事件形态的同类帧数组（不能复用 OpenAI 帧）。 */
function soloLoopFrames(totalFrames: number, finishEvents: string[]): string[] {
  const loop = fixture('reasoning-loop.txt')
  const frames: string[] = []
  for (let i = 0; i < loop.length; i += 256) {
    frames.push(`event:output\ndata:${JSON.stringify({ reasoning_content: loop.slice(i, i + 256) })}\n\n`)
  }
  while (frames.length < totalFrames - finishEvents.length) {
    frames.push(`event:output\ndata:${JSON.stringify({ reasoning_content: 'Let me write.\n\nGo.\n\nOK.\n\nWriting.\n\n' })}\n\n`)
  }
  frames.push(...finishEvents)
  return frames
}

/** 上游以 `length` 收尾（报障真实形态）。 */
const openAiTail = [
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
  'data: [DONE]\n\n',
]
const soloTail = [
  `event:done\ndata:${JSON.stringify({ finish_reason: 'length' })}\n\n`,
]

/** 取出收尾时的 reasoning 块文本（未出现则 undefined）。 */
function reasoningBlockText(chunks: Array<Record<string, unknown>>): string | undefined {
  const end = chunks.find(
    chunk => chunk.type === 'block-end' && (chunk.block as { type?: string }).type === 'reasoning',
  )
  return end === undefined ? undefined : String((end.block as { text?: string }).text ?? '')
}

/**
 * 止损三条共用判据：① 上游读取**提前停止**（远小于总帧数），
 * ② 截断仍保留干净前缀，③ `finish` 仍是可重试的 `max-tokens`
 * （不得因止损变成传输错误或用户取消）。
 */
function expectUpstreamStopped(
  chunks: Array<Record<string, unknown>>,
  consumed: number,
  totalFrames: number,
): void {
  // ① 止损：读取帧数必须远小于总帧数（未接线时恒等于总帧数）。
  expect(consumed).toBeLessThan(totalFrames / 2)
  // ② 截断仍生效（保留非空干净前缀）。
  const kept = reasoningBlockText(chunks)
  expect(kept).toBeDefined()
  expect(kept!.length).toBeGreaterThan(0)
  // ③ 行为不变：仍报 max-tokens，未被误判成传输错误 / 用户取消。
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
}

// ─────────────────────────────────────────────────────────────────────────────
// 各适配器的构造。凭据用永不过期的桩值（否则 `stream()` 会先走 `refresh()`
// 而拿到 undefined 凭据直接抛 MISSING_CREDENTIAL）。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造「每次 fetch 都返回同一段 SSE」的适配器。 */
function stubFetch(sse: string | Response | (() => Response)): typeof fetch {
  return (async () => {
    if (typeof sse === 'function') return sse()
    return typeof sse === 'string'
      ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : sse
  }) as unknown as typeof fetch
}

function makeBuddy(sse: string | Response | (() => Response)): BuddyAdapter {
  return new BuddyAdapter({
    credentialRef: 'TEST_REF' as never,
    resolveCredential: async () => ({ access_token: 'stub', refresh_token: 'stub', expires_at: 0 }) as never,
    refresh: async () => {},
    product: BUDDY,
    fetchImpl: stubFetch(sse),
  })
}

function makeCodeArts(sse: string | Response | (() => Response)): CodeArtsAdapter {
  return new CodeArtsAdapter({
    credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
    resolveCredential: async () => ({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2099-01-01T00:00:00Z',
    }) as CodeArtsCredential,
    refresh: async () => {},
    fetchImpl: stubFetch(sse),
  })
}

function makeLobsterai(sse: string | Response | (() => Response)): LobsteraiAdapter {
  return new LobsteraiAdapter({
    credentialRef: 'LOBSTERAI_ACCOUNT_TEST' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', user_id: 'yid-1', nickname: '测试账号', uuid: 'uuid-1',
      first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
    }) as never,
    refresh: async () => {},
    fetchImpl: stubFetch(sse),
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
  })
}

function makeQoder(sse: string | Response | (() => Response)): QoderAdapter {
  return new QoderAdapter({
    credentialRef: QODER.credentialRef,
    resolveCredential: async () => ({
      access_token: 'pt-test-token', refresh_token: 'jrt-test', token_expires_at: '0',
    }) as never,
    refresh: async () => {},
    // job token 必须注入：省略时适配器**刻意**抛 MISSING_CREDENTIAL 而不用 PAT
    // 静默降级（见 qoder-adapter.ts 模块头）。
    getJobToken: async () => 'jt-test',
    invalidateJobToken: () => {},
    // 目录拉取会真的发一次请求，而 fetchImpl 是「每次都返回同一段 SSE」的桩 ——
    // 那一次会把 Response 的 body 读掉，后续 chat 请求就拿到已锁定的流。
    fetchRemoteModels: async () => [],
    fetchImpl: stubFetch(sse),
    product: QODER,
  })
}

function makeTraeCn(sse: string | Response | (() => Response)): TraeCnAdapter {
  return new TraeCnAdapter({
    credentialRef: 'TRAE_CN_ACCESS_TOKEN' as never,
    resolveCredential: async () => ({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      uid: 'uid-1', nickname: '测试账号',
      machine_id: 'a'.repeat(32), device_id: 'c'.repeat(32),
    }) as never,
    refresh: async () => {},
    // 同上：关掉动态目录，避免它消耗掉桩 Response。
    fetchRemoteModels: async () => [],
    fetchImpl: stubFetch(sse),
  })
}

/** 跑一次 stream()，收集全部 chunk。 */
async function drain(adapter: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    provider: 'stub', model: 'deepseek-v4.1-flash', messages: [],
    reasoningEffort: 'high', maxTokens: 128_000,
    signal: new AbortController().signal,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

// 五个 provider 的参数化表：name / 构造 / 是否支持 OpenAI 帧。
const providers = [
  { name: 'buddy（workbuddy，用户报障路径）', make: makeBuddy, solo: false },
  { name: 'codearts', make: makeCodeArts, solo: false },
  { name: 'lobsterai', make: makeLobsterai, solo: false },
  { name: 'qoder', make: makeQoder, solo: false },
  { name: 'trae-cn（SOLO 自定义事件）', make: makeTraeCn, solo: true },
] as const

describe('思考死循环中断（五个 provider 全接线）', () => {
  for (const { name, make, solo } of providers) {
    describe(name, () => {
      const frames = (text: string) => solo
        ? (() => {
            const events: string[] = []
            for (let i = 0; i < text.length; i += 256) {
              events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: text.slice(i, i + 256) })}\n\n`)
            }
            events.push(`event:done\ndata:${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
            return events.join('')
          })()
        : reasoningFrames(text)

      it('命中后截断思考并报 max-tokens', async () => {
        const loop = fixture('reasoning-loop.txt')
        const chunks = await drain(make(frames(loop)))
        const kept = reasoningBlockText(chunks)
        expect(kept).toBeDefined()
        // 既不能截空（`cutAt=0` 是已知的截空风险），也不能保留循环全文。
        expect(kept!.length).toBeGreaterThan(0)
        expect(kept!.length).toBeLessThan(loop.length)
        // ⚠️ 必须断言「是 fixture 的**真前缀**」：只比长度是不够的 ——
        // 命中后下游增量本就不再累积，所以「没做截断」时块文本也只是**短了**，
        // 光看 `length < loop.length` 抓不到「截断这一步没接上」。
        // 真前缀 + 严格短于「已收到的增量之和」才真正锁定 `cutAt` 生效。
        expect(loop.startsWith(kept!)).toBe(true)
        const consumedReasoning = chunks
          .filter(chunk => chunk.type === 'reasoning-delta')
          .reduce((sum, chunk) => sum + String(chunk.text ?? '').length, 0)
        expect(kept!.length).toBeLessThan(consumedReasoning)
        // 必须报 max-tokens（可重试），不能是 stop。
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
      })

      it('正常思考不受影响（零误报）', async () => {
        const normal = fixture('reasoning-normal.txt')
        const chunks = await drain(make(frames(normal)))
        expect(reasoningBlockText(chunks)!.length).toBe(normal.length)
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      })

      it('早期自愈样本不受影响（持续体量不足，不得打断本会成功的响应）', async () => {
        const heal = fixture('reasoning-self-heal.txt')
        const chunks = await drain(make(frames(heal)))
        expect(reasoningBlockText(chunks)!.length).toBe(heal.length)
        // 上游宣告 stop，且**不得**被改写成 max-tokens。
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      })

      it('开关关闭时零变化（字节级：保留循环全文，报 stop）', async () => {
        process.env.DSH_REASONING_LOOP_GUARD = '0'
        const loop = fixture('reasoning-loop.txt')
        const chunks = await drain(make(frames(loop)))
        expect(reasoningBlockText(chunks)!.length).toBe(loop.length)
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      })

      it('命中后 cancel 上游，不再把流读到底（真正止损）', async () => {
        const total = 200
        const raw = solo ? soloLoopFrames(total, soloTail) : openAiLoopFrames(total, openAiTail)
        const { make: makeResponse, consumed } = countedResponse(raw)
        const chunks = await drain(make(makeResponse))
        expectUpstreamStopped(chunks, consumed(), raw.length)
      })
    })
  }
})

describe('思考死循环 / 同帧处理不得被连带跳过', () => {
  // `continue` 会跳过本帧位于 reasoning 分支**之后**的处理，导致 token 记账
  // 静默丢失。
  //
  // ⚠️ **「同帧」的具体内容每个 provider 不同**，不能一刀切用 usage：
  // - buddy / codearts / lobsterai：`choices[0].delta` 与顶层 `usage` 同帧；
  // - qoder / trae-cn：usage 走**独立**帧（`choices:[]` / `token_usage` 事件），
  //   与 reasoning **不可能同帧** —— 它们真正的风险是同一帧里位于思考分支
  //   **之后**的 `tool_calls`。
  // 按实际帧形态分别构造，否则测的是不可达路径（恒真、无牙）。
  const sameFrameUsage = providers.filter(p => !p.solo && p.name !== 'qoder')
  for (const { name, make } of sameFrameUsage) {
    it(`${name}：命中后同帧的 usage 仍被处理`, async () => {
      const loop = fixture('reasoning-loop.txt')
      const frames: string[] = []
      for (let i = 0; i < loop.length; i += 256) {
        frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
      }
      // 最后一帧同时携带 reasoning_content 与 usage。
      frames.push(`data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: '还在循环还在循环' } }],
        usage: { prompt_tokens: 111, completion_tokens: 222 },
      })}\n\n`)
      frames.push('data: [DONE]\n\n')
      const chunks = await drain(make(frames.join('')))
      // usage 必须被产出（用 continue 时会丢失）。
      expect(chunks.filter(chunk => chunk.type === 'usage')).toHaveLength(1)
      // 且死循环仍被正确判定为 max-tokens。
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    })
  }

  it('qoder：命中后同帧的 tool_calls 仍被处理', async () => {
    const loop = fixture('reasoning-loop.txt')
    const frames: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: loop.slice(i, i + 256) } }] })}\n\n`)
    }
    // 一帧同时带 reasoning_content 与 tool_calls（思考分支在 tool_calls 之前）。
    frames.push(`data: ${JSON.stringify({
      choices: [{
        delta: {
          reasoning_content: '还在循环还在循环',
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"file_path":"a"}' } }],
        },
      }],
    })}\n\n`)
    frames.push('data: [DONE]\n\n')
    const chunks = await drain(makeQoder(frames.join('')))
    // 同帧的 tool_calls 必须产出（用 continue 时会丢失）。
    expect(chunks.some(chunk => chunk.type === 'block-end' && (chunk.block as { type?: string }).type === 'tool-call')).toBe(true)
    // 死循环优先级最高：即便有工具调用也报 max-tokens（循环中生成的调用不可信）。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  // trae-cn 的 usage 走**独立** `token_usage` 事件，故「同帧 usage」不可达 ——
  // 真正会被 `continue` 连带丢弃的是同一 `output` 事件里位于思考分支之后的
  // `tool_calls`（该分支确实同时携带两者）。
  it('trae-cn：命中后同帧的 tool_calls 仍被处理', async () => {
    const loop = fixture('reasoning-loop.txt')
    const events: string[] = []
    for (let i = 0; i < loop.length; i += 256) {
      events.push(`event:output\ndata:${JSON.stringify({ reasoning_content: loop.slice(i, i + 256) })}\n\n`)
    }
    events.push(`event:output\ndata:${JSON.stringify({
      reasoning_content: '还在循环还在循环',
      tool_calls: [{ index: 0, id: 'c1', function_call: { name: 'read', arguments: '{"file_path":"a"}' } }],
    })}\n\n`)
    events.push(`event:token_usage\ndata:${JSON.stringify({ prompt_tokens: 111, completion_tokens: 222 })}\n\n`)
    events.push(`event:done\ndata:${JSON.stringify({ finish_reason: 'stop' })}\n\n`)
    const chunks = await drain(makeTraeCn(events.join('')))
    // 同帧的 tool_calls 必须产出（用 continue 时会丢失）。
    expect(chunks.some(chunk => chunk.type === 'block-end' && (chunk.block as { type?: string }).type === 'tool-call')).toBe(true)
    // 收尾的 token_usage 也必须被读到（证明流被消费到终态）。
    expect(chunks.filter(chunk => chunk.type === 'usage')).toHaveLength(1)
    // 死循环优先级最高：即便有工具调用也报 max-tokens（循环中生成的调用不可信）。
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('思考死循环 / 不 abort 调用方信号', () => {
  // abort `options.signal` 会被上层报成「用户取消」而非**标记为不完整**的
  // max-tokens。故只 cancel reader。
  it('命中后调用方 signal 保持未 abort', async () => {
    const total = 200
    const raw = openAiLoopFrames(total, openAiTail)
    const { make: makeResponse } = countedResponse(raw)
    const controller = new AbortController()
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of makeBuddy(makeResponse).stream({
      provider: 'stub', model: 'deepseek-v4.1-flash', messages: [], maxTokens: 128_000,
      signal: controller.signal,
    } as never)) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    expect(controller.signal.aborted).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('行首 course / 课 泄漏清洗（消费侧 block-end）', () => {
  for (const { name, make, solo } of providers) {
    it(`${name}：思考与正文里的行首泄漏都被清掉`, async () => {
      // 思考与正文各带一处行首泄漏。
      const payload = solo
        ? `event:output\ndata:${JSON.stringify({ reasoning_content: 'course 思考里的泄漏。\n\n课正文里的泄漏。' })}\n\n`
          + `event:done\ndata:${JSON.stringify({ finish_reason: 'stop' })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'course 思考里的泄漏。' } }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta: { content: '课正文里的泄漏。' } }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
          + 'data: [DONE]\n\n'
      const chunks = await drain(make(payload))
      const reasoning = reasoningBlockText(chunks) ?? ''
      const text = chunks
        .filter(chunk => chunk.type === 'block-end' && (chunk.block as { type?: string }).type === 'text')
        .map(chunk => String((chunk.block as { text?: string }).text ?? ''))
        .join('')
      // 泄漏必须被清掉（不与具体 provider 的 reasoning/正文分流策略耦合）。
      expect(reasoning).not.toContain('course')
      expect(text).not.toContain('课正文里的泄漏。')
      expect(reasoning + text).toContain('正文里的泄漏。')
    })
  }

  it('开关关闭时泄漏原样保留（行为与现状一致）', async () => {
    process.env.DSH_COURSE_LEAK_STRIP = '0'
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'course 思考里的泄漏。' } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    const chunks = await drain(makeBuddy(payload))
    expect(reasoningBlockText(chunks)).toBe('course 思考里的泄漏。')
  })
})

/**
 * 序列化侧清洗（存量自愈）的**接线**回归。
 *
 * 消费侧只管本次新生成的文本；泄漏早在修复前就已**持久化进会话历史**，
 * 此后每轮请求都会把这段脏历史原样重放给模型。故每个适配器的
 * `serializeMessages` 都必须接上 `stripCourseLeakFromHistoryContent` ——
 * 模块本身的纯函数行为已由 `course-leak-strip.spec.ts` 覆盖，这里只锁**接线**。
 *
 * 判据用**实际发出的请求体**（而不是直接调 serialize）：字段名与角色的转换
 * 各 provider 不同，只有走完整条 `stream()` 才能证明脏历史真的没被发出去。
 */
describe('行首泄漏清洗（序列化侧接线：存量坏会话自愈）', () => {
  /** 构造一条含行首泄漏的 assistant 历史消息。 */
  const dirtyHistory = [{
    role: 'assistant',
    content: [
      { type: 'text', text: '前文。\n\ncourse 正文里的泄漏。' },
      { type: 'reasoning', text: '课查。' },
    ],
  }]

  const quietSse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n'

  /**
   * 把请求发出去并忽略流的结局。
   *
   * ⚠️ 只需要**请求体**（在 fetch 调用时就已抓到），而各 provider 对「空回复」的
   * 容忍度不同：trae-cn 走 SOLO 事件格式（`event:done`），一段 OpenAI 形态的
   * 静默帧会让它判 `EMPTY_RESPONSE` 而抛错。那与「历史是否被清洗」无关，
   * 故此处吞掉流内错误。
   */
  async function sendAndIgnoreOutcome(
    adapter: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
    messages: unknown[],
  ): Promise<void> {
    try {
      for await (const _chunk of adapter.stream({
        provider: 'stub', model: 'deepseek-v4.1-flash', messages,
        signal: new AbortController().signal,
      } as never)) { /* 只需把请求发出去 */ }
    } catch {
      // 静默帧在部分 provider 上会被判「空回复」；请求体已抓到，无需关心。
    }
  }

  /**
   * 用「抓 body」的 fetch 构造适配器：三个适配器（buddy / lobsterai / codearts）
   * 的 `serializeMessages` 是**模块私有**的，且各 provider 的角色与字段名转换
   * 不同 —— 只有走完整条链路并抓实际请求体，才能证明脏历史真的没被发出去。
   */
  function makeCapturing(
    build: (fetchImpl: typeof fetch) => { stream(options: GenerateOptions): AsyncIterable<StreamChunk> },
  ): { adapter: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }; body: () => Record<string, unknown> } {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(quietSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { adapter: build(fetchImpl), body: () => body }
  }

  /** 五个适配器各自的构造（fetchImpl 由外部注入以便抓包）。 */
  const builders: Array<{
    name: string
    build: (fetchImpl: typeof fetch) => { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
  }> = [
    {
      name: 'buddy',
      build: fetchImpl => new BuddyAdapter({
        credentialRef: 'TEST_REF' as never,
        resolveCredential: async () => ({ access_token: 's', refresh_token: 's', expires_at: 0 }) as never,
        refresh: async () => {}, product: BUDDY, fetchImpl,
      }),
    },
    {
      name: 'codearts',
      build: fetchImpl => new CodeArtsAdapter({
        credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
        resolveCredential: async () => ({
          access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
          expires_at: '2099-01-01T00:00:00Z',
        }) as CodeArtsCredential,
        refresh: async () => {}, fetchImpl,
      }),
    },
    {
      name: 'lobsterai',
      build: fetchImpl => new LobsteraiAdapter({
        credentialRef: 'LOBSTERAI_ACCOUNT_TEST' as never,
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
          uid: 'uid-1', user_id: 'yid-1', nickname: '测试账号', uuid: 'uuid-1',
          first_keyfrom: '1700000000000', latest_keyfrom: '1700000000000',
        }) as never,
        refresh: async () => {}, fetchImpl,
        resolveClientVersion: async () => '2026.9.4', product: LOBSTERAI,
      }),
    },
    {
      name: 'qoder',
      build: fetchImpl => new QoderAdapter({
        credentialRef: QODER.credentialRef,
        resolveCredential: async () => ({
          access_token: 'pt-test-token', refresh_token: 'jrt-test', token_expires_at: '0',
        }) as never,
        refresh: async () => {},
        getJobToken: async () => 'jt-test', invalidateJobToken: () => {},
        fetchRemoteModels: async () => [], fetchImpl, product: QODER,
      }),
    },
    {
      name: 'trae-cn',
      build: fetchImpl => new TraeCnAdapter({
        credentialRef: 'TRAE_CN_ACCESS_TOKEN' as never,
        resolveCredential: async () => ({
          access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
          uid: 'uid-1', nickname: '测试账号',
          machine_id: 'a'.repeat(32), device_id: 'c'.repeat(32),
        }) as never,
        refresh: async () => {}, fetchRemoteModels: async () => [], fetchImpl,
      }),
    },
  ]

  /**
   * 把一条消息的 `content` 压成纯文本。
   *
   * ⚠️ 两种形态都要处理：OpenAI 系是**字符串**，而 trae-cn 的 SOLO 通道用
   * **多模态 parts 数组**（`[{type:'text',text:...}]`）—— 直接 `String(content)`
   * 会得到 `[object Object]`，断言就变成了假通过/假失败。
   */
  function contentText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map(part => typeof part === 'object' && part !== null
        ? String((part as { text?: unknown }).text ?? '')
        : String(part))
      .join('')
  }

  /** 从请求体里取出全部 assistant 消息的文本（字段名各 provider 不同）。 */
  function assistantTexts(body: Record<string, unknown>): string {
    const messages = Array.isArray(body.messages) ? body.messages : []
    return messages
      .filter((message): message is Record<string, unknown> =>
        typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'assistant')
      .map(message => `${contentText(message.content)}\u0000${String(message.reasoning_content ?? '')}`)
      .join('\u0001')
  }

  for (const { name, build } of builders) {
    it(`${name}：实际发出的请求体里，assistant 历史已被清洗`, async () => {
      const { adapter, body } = makeCapturing(build)
      await sendAndIgnoreOutcome(adapter, dirtyHistory)
      const sent = assistantTexts(body())
      // 泄漏必须没被发出去（若接线缺失，脏历史会原样重放给模型）。
      expect(sent).not.toContain('course 正文里的泄漏。')
      expect(sent).not.toContain('课查。')
      // 且正文与思考的干净部分仍在（不是整段被清空）。
      expect(sent).toContain('正文里的泄漏。')
      expect(sent).toContain('查。')
    })

    it(`${name}：user 消息绝不被清洗（不得篡改用户的话）`, async () => {
      const { adapter, body } = makeCapturing(build)
      const history = [{ role: 'user', content: [{ type: 'text', text: 'course 这个词是什么意思？' }] }]
      await sendAndIgnoreOutcome(adapter, history)
      const messages = (body().messages ?? []) as Array<Record<string, unknown>>
      const user = messages.find(message => message.role === 'user')!
      expect(contentText(user.content)).toContain('course 这个词是什么意思？')
    })

    it(`${name}：开关关闭时请求体零变化（脏历史原样发出）`, async () => {
      process.env.DSH_COURSE_LEAK_STRIP = '0'
      const { adapter, body } = makeCapturing(build)
      await sendAndIgnoreOutcome(adapter, dirtyHistory)
      const sent = assistantTexts(body())
      expect(sent).toContain('course 正文里的泄漏。')
      expect(sent).toContain('课查。')
    })
  }
})
