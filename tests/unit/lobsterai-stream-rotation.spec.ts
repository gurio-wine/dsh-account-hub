/**
 * 任务 2 回归：**流内错误帧（HTTP 200 + SSE `{error:{message}}`）必须参与换号**
 * ※ 以及任务 3：**最强思考档展示名用产品侧 `Max`**。
 *
 * ## 真实缺陷（用户报障）
 *
 * 「本插件出现 lobsterai 一个账号用完出错但是没有从账号切换的问题，应该能自动切换，
 *   web 显示：失败原因：lobsterai: 免费额度已用完，请升级套餐 …… 账号还有 2 个能用的」
 *
 * 根因有两处，**缺一不可**：
 *
 * 1. **换号循环整体位于 `if (!response.ok)` 之内**，而额度耗尽是以
 *    **HTTP 200 + SSE 流内错误帧** 表达的（Web 上那句文案正是 `consumeSse` 里
 *    `lobsterai: ${data.error.message}` 模板的产物）。流内错误在
 *    `yield* this.consumeSse(...)` 处抛出，**完全绕过了换号逻辑** ——
 *    池里还有可用账号也不会被尝试。
 * 2. `LOBSTERAI_HARD_CREDIT_MARKERS` 不含「免费额度已用完」这类文案 ——
 *    即便把流内错误接进分类，也会判成 `none`（`shouldRotate` 为 false）。
 *
 * ⚠️ 注意 HTTP 200 下 `classifyLobsteraiError` 的**状态码分支全部失效**
 * （它只在 402/429/404/4xx/5xx 上生效），流内错误只能靠关键词判定 ——
 * 这正是新增 `classifyLobsteraiStreamError` 的理由（分类单测见
 * `lobsterai-errors.spec.ts`）。
 *
 * ## 关键安全约束：已产出内容后**绝不**换号
 *
 * 换号会重放一次请求，而新的 `consumeSse` 是**全新生成器**（`nextIndex` 从 0 重来），
 * 于是会再发一次 `block-start(index=0)`。DSH 对重复块索引是**硬失败**：
 *
 * ```
 * dsh-llm/lib/invariant.js:
 *   case "block-start":
 *     if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`)
 * ```
 *
 * 即：已产出内容后换号会把「额度耗尽」这个**可读错误**升级成 harness 的
 * invariant 崩溃 —— 比不换号更糟。故本文件正反两向都钉死。
 */
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

/** 用户报障时 Web 上显示的原文（不得改写，它是判定关键词的依据）。 */
const QUOTA_MESSAGE = '免费额度已用完，请升级套餐'

function makeCredential(token: string, overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: token,
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    user_id: 'yid-1',
    uuid: 'uuid-1',
    first_keyfrom: '1',
    latest_keyfrom: '1',
    ...overrides,
  }
}

function options(): GenerateOptions {
  return {
    provider: 'lobsterai',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  }
}

function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 上游表达「额度耗尽」的真实形态：HTTP 200，**首帧即错误**。 */
function inStreamError(message: string): Response {
  return sseResponse([JSON.stringify({ error: { message } })])
}

function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
}

/** 先产出正文、随后才报错（用于验证「已产出内容不换号」的守卫）。 */
function partialThenError(text: string, message: string): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ error: { message } }),
  ])
}

/** 构造带账号池的适配器；`responses` 按请求顺序返回。 */
function makeAdapter(config: {
  responses: Array<() => Response>
  poolAccounts?: Array<{ id: string; token: string }>
}) {
  let call = 0
  const rateLimitWrites: Array<{ accountId: string; modelId: string }> = []
  const fetcher = vi.fn(async () => {
    const make = config.responses[Math.min(call, config.responses.length - 1)]!
    call += 1
    return make()
  }) as unknown as typeof fetch

  const accounts = config.poolAccounts ?? []
  let pick = 0
  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef('LOBSTERAI_ACCOUNT_A'),
    resolveCredential: async () => makeCredential('AT-A'),
    refresh: async () => {},
    fetchImpl: fetcher,
    resolveClientVersion: async () => '2026.9.4',
    product: LOBSTERAI,
    accountPool: {
      findAccountIdByCredential: async () => 'acc-A',
      updateModelRateLimit: async (accountId: string, modelId: string) => {
        rateLimitWrites.push({ accountId, modelId })
      },
      getAvailableAccount: async () => {
        const next = accounts[pick]
        pick += 1
        return next === undefined
          ? null
          : { entry: { id: next.id, provider: 'lobsterai' }, credential: makeCredential(next.token) }
      },
    } as never,
  })
  return { adapter, rateLimitWrites, callCount: () => call }
}

interface ThrownLlmError { code?: string; message: string; failure?: { status?: number } }

async function drain(adapter: LobsteraiAdapter): Promise<{ error?: ThrownLlmError; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    return { chunks }
  } catch (e) {
    return { error: e as ThrownLlmError, chunks }
  }
}

/** 取最终文本块的正文。 */
function textOf(chunks: readonly StreamChunk[]): string | undefined {
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  return end?.type === 'block-end' && end.block.type === 'text' ? end.block.text : undefined
}

describe('额度耗尽必须换号（用户报障的主路径）', () => {
  it('A 返回流内额度错误 → 自动换到 B 并正常返回 B 的内容', async () => {
    const { adapter, rateLimitWrites, callCount } = makeAdapter({
      responses: [
        () => inStreamError(QUOTA_MESSAGE),
        () => textSse('来自账号 B 的回复'),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error, chunks } = await drain(adapter)

    // 核心断言：必须真的换号重试，而不是把 A 的错误直接抛给用户。
    expect(error).toBeUndefined()
    expect(callCount()).toBe(2)
    expect(textOf(chunks)).toBe('来自账号 B 的回复')
    // 额度耗尽应给**真正失败的账号 A** 记上限流徽章（hard-credit 属 Cooldown 类）。
    expect(rateLimitWrites).toEqual([{ accountId: 'acc-A', modelId: 'glm-5.2' }])
  })

  it('所有账号都额度耗尽 → 抛 QUOTA_EXCEEDED，并保留真实原因', async () => {
    const { adapter, callCount } = makeAdapter({
      responses: [() => inStreamError(QUOTA_MESSAGE)],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error } = await drain(adapter)

    expect(callCount()).toBe(2)
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    // 诊断信息不得被吞掉：用户必须能看到「免费额度已用完」这个真实原因。
    expect(error!.message).toMatch(/免费额度已用完/)
  })

  it('已产出正文后才报错 → 不换号（否则触发 harness 的重复 block-start 崩溃）', async () => {
    const { adapter, callCount } = makeAdapter({
      responses: [() => partialThenError('前半段', QUOTA_MESSAGE)],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error, chunks } = await drain(adapter)

    // 换号会重放一次请求，新的 `consumeSse` 会**再发一次 block-start(index=0)**，
    // 而 DSH 对重复块索引是硬失败（见文件头引文）—— 那会把一个可读的业务错误
    // 升级成 invariant 崩溃。故这里必须**不换号**，如实抛出交由 harness 重试整轮。
    expect(callCount()).toBe(1)
    expect(error).toBeDefined()

    // 直接锁死「绝不出现重复的 block-start 索引」—— 这是 DSH 的硬契约。
    const started = chunks
      .filter((chunk) => chunk.type === 'block-start')
      .map((chunk) => chunk.index)
    expect(new Set(started).size).toBe(started.length)

    // 已产出的增量文本已经流给用户了（错误在 block-end 之前抛出，
    // 故这里断言的是 text-delta 而非最终文本块）。
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '前半段' })
  })

  it('流内错误未命中关键词（默认 client）同样参与换号', async () => {
    // 对齐 Go `handler.go:218-243`：每个分支都以 continue 结尾（含 default）。
    const { adapter, callCount } = makeAdapter({
      responses: [
        () => inStreamError('某种未登记的上游业务错误'),
        () => textSse('B 的回复'),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })

    const { error } = await drain(adapter)
    expect(error).toBeUndefined()
    expect(callCount()).toBe(2)
  })

  it('HTTP 非 2xx 的换号行为不受影响（回归）', async () => {
    const { adapter, callCount } = makeAdapter({
      responses: [
        () => new Response('too many requests', { status: 429 }),
        () => textSse('B 的回复'),
      ],
      poolAccounts: [{ id: 'acc-B', token: 'AT-B' }],
    })
    const { error } = await drain(adapter)
    expect(error).toBeUndefined()
    expect(callCount()).toBe(2)
  })

  it('流内错误在**无账号池**时如实报错（不静默、不换号）', async () => {
    const fetcher = vi.fn(async () => inStreamError(QUOTA_MESSAGE)) as unknown as typeof fetch
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: fetcher,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
    })
    const { error } = await drain(adapter)
    expect(error).toBeDefined()
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    expect(error!.message).toMatch(/免费额度已用完/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

/**
 * 任务 3（Issue #IKHCZF）：最强思考档的**展示名**必须是产品侧的 `Max`。
 *
 * 远端把产品侧 `level: 'max'` 映射到 `openclawLevel: 'xhigh'`，用户在 IDE 里看到的
 * 是 **Max**。早期把 wire 值当展示名，界面上只有「最高 XHigh」，用户按 IDE 的
 * 「Max」找不到对应档位，以为缺了最高档。
 *
 * ⚠️ **wire 值 `xhigh` 一个字符都不能动** —— 它才决定真正触发哪一档
 * （实测 `reasoning_effort=max` 与不带参数无差异）。
 */
describe('最强思考档展示名为 Max（Issue #IKHCZF 回归）', () => {
  it('档位 name 显示「最高 Max」，而 id 仍是 wire 值 xhigh', async () => {
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: (async () => textSse('x')) as unknown as typeof fetch,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
      fetchRemoteModels: async () => [{
        id: 'glm-5.2',
        name: 'GLM-5.2',
        reasoningEfforts: ['off', 'high', 'xhigh'],
        defaultReasoningEffort: 'xhigh',
      }],
    })

    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.2')
    const efforts = resolved.reasoning?.efforts ?? []
    const strongest = efforts.find((effort) => effort.id === 'xhigh')

    // ① 展示名用产品侧命名：Max（不是 wire 值的直译 XHigh）。
    expect(strongest?.name).toBe('最高 Max')
    expect(efforts.map((effort) => effort.name)).not.toContain('最高 XHigh')
    // ② 但 id 必须仍是 wire 值 —— 否则请求会走服务端默认档。
    expect(efforts.map((effort) => effort.id)).toContain('xhigh')
    // ③ defaultEffort 也必须是 wire 值。
    expect(resolved.reasoning?.defaultEffort).toBe('xhigh')
  })

  it('出站 `reasoning_effort` 仍是 wire 值 xhigh（wire 行为零变更）', async () => {
    const bodies: string[] = []
    const adapter = new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
      resolveCredential: async () => makeCredential('AT'),
      refresh: async () => {},
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''))
        return textSse('ok')
      }) as unknown as typeof fetch,
      resolveClientVersion: async () => '2026.9.4',
      product: LOBSTERAI,
    })
    for await (const _chunk of adapter.stream({ ...options(), reasoningEffort: 'xhigh' as never })) {
      /* drain */
    }
    expect(JSON.parse(bodies[0]!).reasoning_effort).toBe('xhigh')
  })
})
