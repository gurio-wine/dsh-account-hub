/**
 * 「自动路由」**运行面**回归测试：聚合适配器（`src/auto-route-adapter.ts`）+ 隐藏门控
 * + 注册生命周期。
 *
 * ## 本文件守什么
 *
 * `auto-route.spec.ts` 守纯逻辑（配置判据 / 轮转引擎），`auto-route-rpc.spec.ts` 守
 * 配置面（落盘 / RPC）。本文件守的是**中间那一段**，也是三处最容易静默失效的地方：
 *
 * 1. **转发语义**：目标 provider / model / effort 怎么取（条目配了用条目的、没配就不写该键，
 *    落目标自己的默认档）、历史消息的 `source.provider` 怎么重写（不重写 = 思考模式工具轮
 *    400，见 `rewriteMessagesForTarget` 的说明）、冻结请求能不能改。
 * 2. **能力声明**：聚合模型只合并 context / defaultMaxTokens，**不声明 reasoning**
 *    （档位唯一归属条目，会话侧没有档位下拉）——见第 9 节。
 * 3. **降级语义**：内层失败以 **finish chunk** 到达（不是 throw）；没透传过任何 chunk
 *    就静默换下一个（DSH 无感）；透传过就不硬换（外层流语法不允许重复 block-start /
 *    两次 usage）；`aborted` 绝不降级；满一圈只报一次中文错。
 * 4. **注册生命周期**：内容幂等门、开关 → 路由集（`replace([])` 休眠）。
 *
 * ## mock 的边界（哪些**刻意不 mock**）
 *
 * `ctx.llm` 用真实 `LlmRuntime`（`@deepseek-ai/dsh-llm` 的默认导出）＋一个记录型
 * 目标适配器：只有这样才能钉住「重入 `ctx.llm.stream()` 真的会重新走适配器选择与
 * 能力解析」这条通路 —— 用替身 mock 掉 `ctx.llm.stream` 等于把被测的那一层也换掉了。
 * 同理，`resolveCallConfig` 的档位物化行为也由真实运行时校验（聚合模型不声明档位时
 * 它**不会**补档，这正是「会话侧没有档位」的可观测判据）。
 *
 * 内层失败**以 finish chunk 注入**（`SCRIPT` 里的 `error` 标记），不是 throw：这正是
 * 宿主 `adapterStream` 规范化后的形态（建立/迭代阶段的抛错都变成终止 chunk），照
 * throw 写用例会测到一条线上不存在的路径。
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  createAssistantMessage,
  createUserMessage,
  createMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AUTO_ROUTE_ENTRY_UNRESOLVED_CODE,
  AUTO_ROUTE_EXHAUSTED_CODE,
  AUTO_ROUTE_PROVIDER_ID,
  AUTO_ROUTE_UNKNOWN_MODEL_CODE,
  autoRouteConfigFacts,
  autoRouteExhaustedMessage,
  autoRouteHead,
  createAutoRouteRuntime,
  rewriteMessagesForTarget,
  type AutoRouteConfig,
  type AutoRouteDefinition,
} from '../../src/auto-route.js'
import {
  AutoRouteAdapter,
  createAutoRouteRegistration,
  installAutoRouteEffortGuard,
  registerAutoRouteLlm,
} from '../../src/auto-route-adapter.js'
import { AccountPool, providerCatalogVisible } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

// ──────────────────────────── 工具 ────────────────────────────

/** 造一份配置（测试里只覆盖关心的字段）。 */
const config = (enabled: boolean, models: AutoRouteDefinition[]): AutoRouteConfig => ({ enabled, models })

const def = (
  id: string,
  name: string,
  entries: { provider: string; model: string; effort?: string }[],
): AutoRouteDefinition => ({ id, name, entries })

/** 目标模型能力（含思考档，用于测合并规则）。 */
const TARGET_MODEL_INFO = {
  context: { contextWindow: 200_000 },
  defaultMaxTokens: 8192,
  reasoning: {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  },
} as const satisfies Partial<LlmResolvedModelInfo>

/**
 * 内层脚本的一步。
 *
 * `chunks` 是原样 yield 的内容 chunk；`error` / `aborted` 产出一个终止 finish（模拟
 * 宿主 `adapterStream` 规范化后的形态）；`noFinish` 模拟「流没给终止 chunk 就结束」。
 */
type Step =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'aborted'; message?: string }
  | { kind: 'noFinish' }

/** 目标适配器：按 provider 名记录每次收到的 options，并按脚本产出 chunk。 */
class TargetAdapter extends LlmAdapter {
  /** provider → 每次 `stream()` 收到的 options（原样，便于断言 provider/model/effort）。 */
  readonly seen = new Map<string, GenerateOptions[]>()
  /** provider → 剩余脚本（每 `stream()` 消费一步）。 */
  private readonly scripts = new Map<string, Step[]>()
  /** 本适配器拥有的全部 provider。 */
  constructor(private readonly providers: readonly string[]) {
    super()
  }

  /** 为某个 provider 排队若干步（按调用顺序消费）。 */
  queue(provider: string, ...steps: Step[]): void {
    const list = this.scripts.get(provider) ?? []
    list.push(...steps)
    this.scripts.set(provider, list)
  }

  providerInfo(provider: string) {
    return { id: provider, name: `目标 ${provider}` }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: 'target-model', name: '目标模型' }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: `目标 ${model}`, ...TARGET_MODEL_INFO }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const list = this.seen.get(options.provider) ?? []
    list.push(options)
    this.seen.set(options.provider, list)
    const step = this.scripts.get(options.provider)?.shift()
    if (step === undefined) {
      // 没排脚本：默认成功（一条文本 + stop）。
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    switch (step.kind) {
      case 'chunks':
        for (const chunk of step.chunks) yield chunk
        return
      case 'error':
        yield { type: 'finish', reason: { kind: 'error', failure: { message: step.message, code: step.code } } }
        return
      case 'aborted':
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: step.message ?? 'aborted', code: 'ABORTED' } },
        }
        return
      case 'noFinish':
        yield { type: 'text-delta', index: 0, text: 'partial' }
        return
    }
  }
}

/** 建一个真实 `LlmRuntime` + 目标适配器 + 自动路由适配器的测试台。 */
async function harness(options: {
  config: () => AutoRouteConfig
  /** 注册进运行时的目标 provider（默认取配置里出现过的那些）。 */
  providers?: readonly string[]
}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const initial = options.config()
  const providers = options.providers
    ?? [...new Set(initial.models.flatMap((definition) => definition.entries.map((entry) => entry.provider)))]
  const target = new TargetAdapter(providers)
  if (providers.length > 0) ctx.llm.registerAdapter([...providers], target)
  const adapter = registerAutoRouteLlm(ctx, { ctx, config: options.config }).adapter
  return { ctx, target, adapter }
}

/** 收集一次流式请求的全部 chunk（`provider` 固定为自动路由）。 */
async function drain(
  adapter: AutoRouteAdapter,
  model: string,
  options: Partial<GenerateOptions> = {},
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: AUTO_ROUTE_PROVIDER_ID,
    model,
    messages: [],
    ...options,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** chunk 序列的简写：`text:ok` / `finish:stop` / `finish:error:CODE` / `finish:aborted`。 */
const kinds = (chunks: readonly StreamChunk[]): string[] => chunks.map((chunk) => {
  if (chunk.type !== 'finish') return `${chunk.type}`
  const reason = chunk.reason
  return reason.kind === 'error' || reason.kind === 'aborted'
    ? `finish:${reason.kind}:${reason.failure.code}`
    : `finish:${reason.kind}`
})

/** 造一条 assistant 历史消息（带 model source，可选 replayState）。 */
const assistantHistory = (provider: string, replayState?: unknown) => createAssistantMessage({
  content: [{ type: 'text', text: '历史回答' }],
  source: { provider, model: 'old-model', ...replayState === undefined ? {} : { replayState } },
})

// ──────────────────────────── 1. 纯函数：历史消息重写 ────────────────────────────

describe('rewriteMessagesForTarget：只改 assistant + model source 的 provider', () => {
  it('assistant 且 source.kind === "model" → 浅拷贝并改写 provider（其余字段与内容不动）', () => {
    const message = assistantHistory('buddy-cn', { private: 'state' })
    const [rewritten] = rewriteMessagesForTarget([message], 'qoder')

    expect(rewritten).not.toBe(message)
    expect(rewritten.source).toEqual({ kind: 'model', provider: 'qoder', model: 'old-model', replayState: { private: 'state' } })
    // 内容与 id 原样（replayState 的块数必须与 content 长度一致，动一个就整份作废）。
    expect(rewritten.content).toBe(message.content)
    expect(rewritten.id).toBe(message.id)
  })

  it('其余消息**原样引用**（不拷贝）：user / system / tool source / 无 source 的 assistant', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: '问' }], source: { kind: 'user' } })
    const system = createMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'x' } })
    // 工具结果消息（role 是 user，source.kind 是 tool）。
    const toolResult = createMessage({
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] }],
      source: { kind: 'tool', callId: 'c1' as never },
    })
    const messages = [user, system, toolResult]
    const rewritten = rewriteMessagesForTarget(messages, 'qoder')

    expect(rewritten).not.toBe(messages)
    expect(rewritten).toEqual(messages)
    for (const [index, message] of rewritten.entries()) expect(message).toBe(messages[index])
  })

  it('深冻结的请求不崩：返回新数组新对象，**不**改原对象（原对象仍冻结且 provider 未变）', () => {
    const message = assistantHistory('buddy-cn')
    Object.freeze(message.source)
    Object.freeze(message)
    const messages = Object.freeze([message])

    const rewritten = rewriteMessagesForTarget(messages, 'trae-cn')

    expect(rewritten).not.toBe(messages)
    expect(Object.isFrozen(messages)).toBe(true)
    expect(message.source.provider).toBe('buddy-cn')
    expect(rewritten[0].source?.provider).toBe('trae-cn')
  })
})

// ──────────────────────────── 2. 转发改写（provider / model / effort）────────────────────────────

describe('stream：转发改写', () => {
  it('条目**配了** effort → 用条目的（自动模型 = provider + model + effort 打包语义）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('low') })

    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-a')![0]).toMatchObject({ provider: 'p-a', model: 'a', reasoningEffort: 'high' })
  })

  it('条目**没配** effort → 不写该键（调用方若已带档位，原样透传；会话侧现已无从选择）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    // ⚠️ 这是**直接调适配器**的场景（绕过宿主）。真实会话路径下聚合模型不声明档位，
    // 用户根本没有档位可选、宿主也不会物化，故 `options.reasoningEffort` 恒为
    // undefined（见下一条用例）。这条用例钉的是**转发函数本身**的语义：条目没配
    // 档位时它**不写** `reasoningEffort` 键 —— 于是调用方带来的值原样过去，而不是
    // 被一个 `undefined` 覆盖掉。写成 `reasoningEffort: undefined` 会让上游
    // 「调用方给的值」被静默清空，这正是这类转发函数最经典的错法。
    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    expect(target.seen.get('p-a')![0]).toMatchObject({ reasoningEffort: 'high' })
  })

  it('条目没配 effort 且用户也没选 → 聚合层不物化档位，目标收到**它自己的默认档**', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { ctx, adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    // 新语义下「不发明档位」的落点分两层：
    // 1. **外层**（聚合模型）：不再声明 reasoning → 宿主 `resolveCallWithInfo` 无从物化
    //    → 转发出去的请求**不带档位键**（旧实现这里会带上聚合模型声明的 defaultEffort）。
    //    这一层在 `resolveCallConfig` 上可观测：
    const outer = await ctx.llm.resolveCallConfig({ provider: AUTO_ROUTE_PROVIDER_ID, model: 'm1' })
    expect('reasoningEffort' in outer).toBe(false)
    // 2. **内层**：转发请求里没有档位 → 宿主按**目标模型自己的声明**补它的默认档
    //    （p-a/a 声明默认 low）——这是目标自己的事，自动路由这一层不替它决定。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low')
  })

  it('历史消息 source.provider 被重写为目标 provider（replayState 归属检查的落地处）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const history = assistantHistory(AUTO_ROUTE_PROVIDER_ID, { private: 'state' })
    await drain(adapter, 'm1', { messages: [history] })

    const forwarded = target.seen.get('p-a')![0]
    expect(forwarded.messages[0].source).toMatchObject({ kind: 'model', provider: 'p-a' })
    // 外层那条历史**没有被就地改**（深冻结 + 纯函数两条约束一起成立）。
    expect(history.source.provider).toBe(AUTO_ROUTE_PROVIDER_ID)
  })

  it('冻结的请求（Object.freeze + 冻结 messages）转发不崩', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const messages = Object.freeze([assistantHistory(AUTO_ROUTE_PROVIDER_ID)])
    const options = Object.freeze({
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      messages,
    }) as GenerateOptions

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-a')![0].messages[0].source).toMatchObject({ provider: 'p-a' })
  })
})

// ──────────────────────────── 3. 降级：首 chunk 前失败 ────────────────────────────

describe('stream：首 chunk 前失败 → 静默降级', () => {
  it('第一个条目失败、第二个成功 → 外层只见到成功流，**没有** error finish', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a 挂了' })
    target.queue('p-b', { kind: 'chunks', chunks: [
      { type: 'text-delta', index: 0, text: '来自 b' },
      { type: 'finish', reason: { kind: 'stop' } },
    ] })

    const chunks = await drain(adapter, 'm1')

    // 「无感」的准确断言：yield 序列里**一个 error finish 都没有**，且只有 b 的内容。
    expect(kinds(chunks)).toEqual(['text-delta', 'finish:stop'])
    expect(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-b')).toHaveLength(1)
  })

  it('降级后**跨请求持续**：下一次请求直接从 b 开始（a 被排到队尾）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a 挂了' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')
    await drain(adapter, 'm1')

    // 第二次请求**没有再碰 a**：b 一次成功，随后仍从 b 开始（成功不升位、懒恢复）。
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-b')).toHaveLength(2)
  })

  it('中间条目失败也继续往后走（不是只试前两个）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
      { provider: 'p-c', model: 'c' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'error', code: 'TIMEOUT', message: 'b' })
    target.queue('p-c', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-c')).toHaveLength(1)
  })

  it('内层流**没给终止 chunk** 就结束 → 补一个 error finish（绝不静默变成「空回答」）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    // `noFinish` 会 yield 一个 text-delta —— 那属于「已透传」，故这一支不能换条目重来。
    target.queue('p-a', { kind: 'noFinish' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    // 已透传过 partial → 不硬换（换了外层会看到重复 block-start），但**必须**给出
    // 终止状态：静默结束在外层看来是「成功但一个字都没有」。
    expect(kinds(chunks)).toEqual(['text-delta', 'finish:error:AUTO_ROUTE_INCOMPLETE'])
    expect(target.seen.get('p-b')).toBeUndefined()
    // 失败条目已排到队尾：下一轮从 b 开始。
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')
    expect(target.seen.get('p-b')).toHaveLength(1)
  })

  it('内层流没给终止 chunk 且**一个 chunk 都没透传** → 静默换下一个候选', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    // 空的 chunks 步 = 什么都不 yield 就结束（合法的「无终止 chunk」形态）。
    target.queue('p-a', { kind: 'chunks', chunks: [] })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-b')).toHaveLength(1)
  })
})

// ──────────────────────────── 4. 降级：已出 chunk 后失败 ────────────────────────────

describe('stream：已透传 chunk 后失败 → 透传 + demote', () => {
  it('透传 error finish（让 loop 走官方重试），且**已 demote**（下次从新队首开始）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [
      { type: 'text-delta', index: 0, text: '已经出字了' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'a 中途挂了', code: 'SERVER' } } },
    ] })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['text-delta', 'finish:error:SERVER'])
    // 本轮**没有**去试 b（已出字不硬换）。
    expect(target.seen.get('p-b')).toBeUndefined()
    // 但失败条目已排到队尾：下一次请求从 b 开始。
    await drain(adapter, 'm1')
    expect(target.seen.get('p-b')).toHaveLength(1)
  })

  it('`usage` / `block-start` 也算「已透传」（外层流语法不允许重来）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'x', code: 'SERVER' } } },
    ] })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['block-start', 'finish:error:SERVER'])
    expect(target.seen.get('p-b')).toBeUndefined()
  })
})

// ──────────────────────────── 5. aborted 绝不降级 ────────────────────────────

describe('stream：aborted 透传不降级', () => {
  it('用户取消 → 原样透传 aborted，**一个候选都不再试**', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'aborted' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:aborted:ABORTED'])
    expect(target.seen.get('p-b')).toBeUndefined()
  })

  it('首 chunk 前 aborted 同样不降级（「没出字就换一个」**不**适用于取消）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'aborted' })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:aborted:ABORTED'])
    expect(target.seen.get('p-b')).toBeUndefined()
  })
})

// ──────────────────────────── 6. 满一圈 → 中文错误只出现一次 ────────────────────────────

describe('stream：满一圈全失败', () => {
  it('每个候选各试一次 → 抛中文错，且**只报一次**（不放大、不重复）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
      { provider: 'p-c', model: 'c' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'error', code: 'SERVER', message: 'b' })
    target.queue('p-c', { kind: 'error', code: 'SERVER', message: 'c' })

    await expect(drain(adapter, 'm1')).rejects.toThrow(autoRouteExhaustedMessage('自动一号'))

    // 每条候选**恰好**一次 —— 「单次请求最多试 N 次」的口径落在这一处。
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-b')).toHaveLength(1)
    expect(target.seen.get('p-c')).toHaveLength(1)
  })

  it('错误码是自定义的 AUTO_ROUTE_EXHAUSTED（**不在**宿主默认可重试集合里）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })

    await expect(drain(adapter, 'm1')).rejects.toMatchObject({ code: AUTO_ROUTE_EXHAUSTED_CODE })
  })

  it('单条目自动模型：失败一次即满一圈（不重复打同一个 provider）', async () => {
    const cfg = () => config(true, [def('m1', '独苗', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })

    await expect(drain(adapter, 'm1')).rejects.toThrow(/全部条目不可用/)
    expect(target.seen.get('p-a')).toHaveLength(1)
  })

  it('满一圈后队列回到原顺序（下一轮仍从 a 开始，不是永远卡在 c）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'error', code: 'SERVER', message: 'b' })
    await expect(drain(adapter, 'm1')).rejects.toThrow()

    // 第二轮：a 又有机会（b 排在后面）。
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a2' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-a')).toHaveLength(2)
  })
})

// ──────────────────────────── 7. 未知模型（配置漂移）────────────────────────────

describe('stream / resolveModel：模型名不在配置里', () => {
  it('未知模型 → 中文错 + AUTO_ROUTE_UNKNOWN_MODEL（不是「全部不可用」）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    await expect(drain(adapter, '不存在')).rejects.toMatchObject({ code: AUTO_ROUTE_UNKNOWN_MODEL_CODE })
    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, '不存在')).rejects.toMatchObject({
      code: AUTO_ROUTE_UNKNOWN_MODEL_CODE,
    })
  })

  it('定义存在但条目为空（手工构造）→ 抛「全部条目不可用」，不越界不崩', async () => {
    // 读路径会丢弃空定义，故这条只能手工构造（运行时保留空 entries 的定义）。
    const empty = def('m1', '空的', [])
    const cfg = () => config(true, [empty])
    const { adapter } = await harness({ config: cfg })

    await expect(drain(adapter, 'm1')).rejects.toThrow(autoRouteExhaustedMessage('空的'))
    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')).rejects.toMatchObject({
      code: AUTO_ROUTE_EXHAUSTED_CODE,
    })
  })
})

// ──────────────────────────── 8. listModels 门控 ────────────────────────────

describe('listModels：总开关即目录', () => {
  it('enabled → 每个定义一个条目（id = 定义 id、name = 定义名、provider = auto-route）', async () => {
    const cfg = () => config(true, [
      def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }]),
      def('m2', '自动二号', [{ provider: 'p-b', model: 'b' }]),
    ])
    const { adapter } = await harness({ config: cfg })

    await expect(adapter.listModels(AUTO_ROUTE_PROVIDER_ID)).resolves.toEqual([
      { provider: AUTO_ROUTE_PROVIDER_ID, id: 'm1', name: '自动一号' },
      { provider: AUTO_ROUTE_PROVIDER_ID, id: 'm2', name: '自动二号' },
    ])
  })

  it('disabled → 返回 []（分组从 DSH 模型下拉消失）', async () => {
    const cfg = () => config(false, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    await expect(adapter.listModels(AUTO_ROUTE_PROVIDER_ID)).resolves.toEqual([])
  })

  it('定义列表为空 → []（即使开关开着）', async () => {
    const cfg = () => config(true, [])
    const { adapter } = await harness({ config: cfg, providers: ['p-a'] })

    await expect(adapter.listModels(AUTO_ROUTE_PROVIDER_ID)).resolves.toEqual([])
  })
})

// ──────────────────────────── 9. resolveModel 能力合并 ────────────────────────────

describe('resolveModel：队首目标能力 + 本自动模型身份', () => {
  it('身份换成 auto-route / 定义 id / 定义名，能力（窗口 / 输出上限）原样透传', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect(resolved).toMatchObject({
      provider: AUTO_ROUTE_PROVIDER_ID,
      id: 'm1',
      name: '自动一号',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8192,
    })
  })

  // ── 档位：聚合模型**一律不声明**（会话侧没有档位下拉）──
  //
  // 目标 `p-a/a` 有 low/high 档位表、默认 low，但聚合模型必须把它整个丢掉：档位的
  // 唯一归属是**条目**，会话侧那条下拉站不住（条目配了会被无视 / 没配时只对队首
  // 有意义 / 失配会引发链式降级）。这三条设计原因见 `src/auto-route-adapter.ts`。

  it('目标有 reasoning 也不合并：聚合模型**不声明** reasoning（会话侧没有档位下拉）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    // 键本身不该存在（写成 `reasoning: undefined` 会让「不声明」与「声明了空档位表」
    // 在 `in` 判据下混同，而宿主恰恰按 `info.reasoning` 的存在与否分流）。
    expect('reasoning' in resolved).toBe(false)
    expect(resolved.reasoning).toBeUndefined()
    // 反面判据：目标的档位表一个都不许漏出来（`...target` 展开最容易在这里漏）。
    expect(JSON.stringify(resolved)).not.toContain('efforts')
  })

  it('条目**配了**档位（且落在目标表里）也**不**作为 defaultEffort 透出', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter } = await harness({ config: cfg })

    // 条目的档位由 `forwardOptions` 在**转发时**注入，不走能力声明这条路 ——
    // 声明出去就等于把「会话侧可选档位」又装回来了。
    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect('reasoning' in resolved).toBe(false)
  })

  it('条目档位**不在**目标表里同样不声明（旧实现会退回目标默认档）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'max' }])])
    const { adapter } = await harness({ config: cfg })

    // 目标只支持 low / high。旧实现把「条目档位非法」退回目标默认档（low）透出，
    // 那等于替用户声明了一个他没选的档位；新语义下整块 reasoning 都不存在，
    // 非法档位只会在真正转发到该条目时由内层报错并触发降级。
    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect('reasoning' in resolved).toBe(false)
  })

  it('队首条目变化 → 能力跟着变（能力是**队首**的，不是第一个定义的）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    // p-a 失败一次 → 队首换成 p-b。
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect(resolved.id).toBe('m1')
    expect(resolved.name).toBe('自动一号')
  })

  it('目标 provider 未注册 → 中文错 + 保留原错误链（cause）', async () => {
    // 配置引用了没注册的 provider（用户手填 / provider 插件被卸掉）。
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'ghost', model: 'g' }])])
    const { adapter } = await harness({ config: cfg, providers: [] })

    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')).rejects.toThrow(/ghost\/g 无法解析/)
  })

  // ── 两种「解析不了」的判别：目录漂移 vs 条目解析失败 ──
  //
  // 旧实现把两者都报成 `AUTO_ROUTE_UNKNOWN_MODEL`，而那个码给用户的动作是
  // 「刷新 DSH 模型目录」—— 对「provider 没注册」毫无作用，排查方向被直接带偏。
  // 下面两条**成对**断言：新码出现在条目解析失败，且原码**不再**出现在该场景。

  it('队首条目 provider 未注册 → 抛 AUTO_ROUTE_ENTRY_UNRESOLVED（不是「模型名不在目录里」）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'ghost', model: 'g' }])])
    const { adapter } = await harness({ config: cfg, providers: [] })

    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')).rejects.toMatchObject({
      code: AUTO_ROUTE_ENTRY_UNRESOLVED_CODE,
    })
  })

  it('条目解析失败**不再**复用目录漂移码（旧码只留给「定义 id 找不到」）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'ghost', model: 'g' }])])
    const { adapter } = await harness({ config: cfg, providers: [] })

    // 反面判据：把条目解析失败报成目录漂移码，会让用户照着「请刷新模型目录重选」
    // 去修一个「provider 没装」的问题 —— 这条断言把两码钉死在各自的场景上。
    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')).rejects.not.toMatchObject({
      code: AUTO_ROUTE_UNKNOWN_MODEL_CODE,
    })
    // 对偶面：真正的目录漂移（定义 id 找不到）仍报原码。
    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, '不存在')).rejects.toMatchObject({
      code: AUTO_ROUTE_UNKNOWN_MODEL_CODE,
    })
  })

  it('条目解析失败的错误消息保留内层原文（用户据此分辨「provider 没装」与「模型下架」）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'ghost', model: 'g' }])])
    const { adapter } = await harness({ config: cfg, providers: [] })

    // 消息里必须同时有「哪条候选」与「为什么」：只有前者用户不知道该改什么，
    // 只有后者用户不知道改哪一行。
    await expect(adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')).rejects.toThrow(/自动一号.*ghost\/g.*ghost/)
  })

  it('目标模型**没有** reasoning → 不声明 reasoning（不造假档位表）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-plain', model: 'p' }])])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    class Plain extends LlmAdapter {
      providerInfo(provider: string) { return { id: provider, name: 'plain' } }
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: '无档模型' }
      }
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['p-plain'], new Plain())
    const adapter = registerAutoRouteLlm(ctx, { ctx, config: cfg }).adapter

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect('reasoning' in resolved).toBe(false)
    expect(resolved.name).toBe('自动一号')
  })
})

// ──────────────────────────── 10. providerRetryPolicy ────────────────────────────

describe('providerRetryPolicy：全部不可用最多一次到达用户', () => {
  it('三个自有错误码都**不在**本路由的可重试集合里', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const policy = adapter.providerRetryPolicy(AUTO_ROUTE_PROVIDER_ID)
    expect(policy.mode).toBe('normal')
    const codes = policy.mode === 'normal' ? policy.retryableCodes : []
    expect(codes).not.toContain(AUTO_ROUTE_EXHAUSTED_CODE)
    expect(codes).not.toContain(AUTO_ROUTE_UNKNOWN_MODEL_CODE)
    // 条目解析失败也是配置/安装面的事实：重试只会重复同一条解析失败。
    expect(codes).not.toContain(AUTO_ROUTE_ENTRY_UNRESOLVED_CODE)
  })

  it('透传上来的失败仍可重试（镜像宿主默认集合，不把 maxRetries 掐成 0）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const policy = adapter.providerRetryPolicy(AUTO_ROUTE_PROVIDER_ID)
    const codes = policy.mode === 'normal' ? policy.retryableCodes : []
    // 透传那条路径（已出 chunk 后失败）刻意留给官方重试，故 SERVER 等必须在集合里。
    for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
      expect(codes).toContain(code)
    }
  })

  it('宿主注册表读到的就是这份策略（注册时被快照）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { ctx, adapter } = await harness({ config: cfg })

    expect(ctx.llm.providerRetryPolicy(AUTO_ROUTE_PROVIDER_ID)).toEqual(
      adapter.providerRetryPolicy(AUTO_ROUTE_PROVIDER_ID),
    )
  })

  it('实测：宿主默认策略的可重试码恰好是那五个，自定义码不在其中（写进文档的实测依据）', async () => {
    const { resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm')
    const defaults = resolveRetryPolicy(undefined, 'spec.defaults')
    expect(defaults.mode).toBe('normal')
    const codes = defaults.mode === 'normal' ? defaults.retryableCodes : []
    expect([...codes].sort()).toEqual(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
    expect(defaults.mode === 'normal' ? defaults.maxRetries : -1).toBe(5)
    expect(codes).not.toContain(AUTO_ROUTE_EXHAUSTED_CODE)
  })
})

// ──────────────────────────── 11. 注册生命周期 ────────────────────────────

describe('createAutoRouteRegistration：注册 / 唤醒 / 休眠 / 归位', () => {
  /** 记录 `registerAdapter` 与 `replace` 调用的 llm 替身。 */
  function registrationSpy() {
    const replaces: string[][] = []
    let adapter: LlmAdapter | undefined
    const llm = {
      registerAdapter: vi.fn((providers: string[], registered: LlmAdapter) => {
        adapter = registered
        const handle = (() => {}) as unknown as { (): void; replace: (next: string[]) => void }
        handle.replace = (next: string[]) => { replaces.push([...next]) }
        return handle
      }),
      resolveModelInfo: vi.fn(),
      stream: vi.fn(),
    }
    return {
      ctx: { llm } as unknown as Context,
      replaces,
      get adapter() { return adapter },
      registerCalls: () => llm.registerAdapter.mock.calls.length,
    }
  }

  it('首次调用即注册（**即使关着**），且按开关把路由集置空（休眠）', () => {
    const spy = registrationSpy()
    let current = config(false, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const ensure = createAutoRouteRegistration(spy.ctx, () => current)

    ensure()

    expect(spy.registerCalls()).toBe(1)
    // 关着 = 零路由：provider 从 listProviders() 与模型目录里一并消失。
    expect(spy.replaces).toEqual([[]])
  })

  it('首次调用时开关**开着** → 路由集是 [auto-route]', () => {
    const spy = registrationSpy()
    const current = config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    createAutoRouteRegistration(spy.ctx, () => current)()

    expect(spy.replaces).toEqual([[AUTO_ROUTE_PROVIDER_ID]])
  })

  it('facts 不变 → 不 replace（无谓的 llm/adapters-updated 通知都不发）', () => {
    const spy = registrationSpy()
    const current = config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const ensure = createAutoRouteRegistration(spy.ctx, () => current)

    ensure()
    ensure()
    ensure()

    expect(spy.registerCalls()).toBe(1)
    expect(spy.replaces).toEqual([[AUTO_ROUTE_PROVIDER_ID]])
  })

  it('开关切换 → replace([]) / replace([auto-route])（休眠与唤醒）', () => {
    const spy = registrationSpy()
    let enabled = true
    const models = [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]
    const ensure = createAutoRouteRegistration(spy.ctx, () => config(enabled, models))

    ensure()
    enabled = false
    ensure()
    enabled = true
    ensure()

    expect(spy.replaces).toEqual([[AUTO_ROUTE_PROVIDER_ID], [], [AUTO_ROUTE_PROVIDER_ID]])
    // 全程只有一次注册（handle 复用，不是反复 register —— 那会抛 DUPLICATE_ADAPTER）。
    expect(spy.registerCalls()).toBe(1)
  })

  it('只改 entries（定义 id 不变）也算内容变化 → 重新应用，但**不白发 replace**', () => {
    const spy = registrationSpy()
    let models = [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]
    const ensure = createAutoRouteRegistration(spy.ctx, () => config(true, models))
    ensure()

    models = [def('m1', '自动一号', [{ provider: 'p-b', model: 'b' }])]
    ensure()

    // 开关没变 ⇒ 路由集无需重发（`replace` 会发 `llm/adapters-updated`，订阅者会白
    // 重算一遍模型目录）。归位是 `applyConfig` 的职责，下面用真实运行时验证它确实发生。
    expect(spy.replaces).toEqual([[AUTO_ROUTE_PROVIDER_ID]])
  })

  it('**端到端归位**：改 entries 后运行时回到新顺序（新候选立刻成为队首）', async () => {
    let models = [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const target = new TargetAdapter(['p-a', 'p-b'])
    ctx.llm.registerAdapter(['p-a', 'p-b'], target)
    const ensure = createAutoRouteRegistration(ctx, () => config(true, models))
    ensure()
    const adapter = ctx.llm.listProviders().some((provider) => provider.id === AUTO_ROUTE_PROVIDER_ID)

    expect(adapter).toBe(true)
    // 通过真实运行时把 b 排到队首（配置变更 = 队列归位）。
    models = [def('m1', '自动一号', [{ provider: 'p-b', model: 'b' }, { provider: 'p-a', model: 'a' }])]
    ensure()

    // 现在发一次请求：第一个被调用的必须是 p-b。
    const runtimeAdapter = (ctx.llm as unknown as {
      adapters: Map<string, { adapter: AutoRouteAdapter }>
    }).adapters.get(AUTO_ROUTE_PROVIDER_ID)!.adapter
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    const chunks = await drain(runtimeAdapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-b')).toHaveLength(1)
    expect(target.seen.get('p-a')).toBeUndefined()
  })

  it('**休眠真的摘掉路由**：关掉后 ctx.llm 不再认识 auto-route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['p-a'], new TargetAdapter(['p-a']))
    let enabled = true
    const ensure = createAutoRouteRegistration(
      ctx,
      () => config(enabled, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
    )
    ensure()
    expect(ctx.llm.listProviders().map((provider) => provider.id)).toContain(AUTO_ROUTE_PROVIDER_ID)

    enabled = false
    ensure()
    expect(ctx.llm.listProviders().map((provider) => provider.id)).not.toContain(AUTO_ROUTE_PROVIDER_ID)

    enabled = true
    ensure()
    expect(ctx.llm.listProviders().map((provider) => provider.id)).toContain(AUTO_ROUTE_PROVIDER_ID)
  })

  it('applyConfig 内容幂等：同一份配置重复应用不重建运行时（降级进度不被清空）', async () => {
    const models = [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])]
    const cfg = config(true, models)
    const { adapter, target } = await harness({ config: () => cfg })
    // a 失败一次 → 队首变成 b。
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')

    // 同一份配置（内容相同但对象不同，模拟「读一次配置」）重复应用。
    adapter.applyConfig(config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])]))

    // 降级进度**保留**：下一次仍从 b 开始，不回到 a。
    await drain(adapter, 'm1')
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-b')).toHaveLength(2)
  })

  it('applyConfig 内容变了 → 重建运行时（队列归位到用户新排的顺序）', async () => {
    const models = [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])]
    const { adapter, target } = await harness({ config: () => config(true, models) })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')

    // 用户把 a 重新排到队首（内容变了）→ 运行时归位。
    adapter.applyConfig(config(true, [def('m1', '自动一号', [
      { provider: 'p-b', model: 'b' },
      { provider: 'p-a', model: 'a' },
    ])]))

    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')
    // 新顺序的队首是 b（归位前它也是 b，故再改一次以区分：把 a 排首位）。
    adapter.applyConfig(config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])]))
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a again' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')

    expect(target.seen.get('p-a')!.length).toBeGreaterThanOrEqual(2)
  })
})

// ──────────────────────────── 12. autoRouteConfigFacts（幂等门的判据本身）────────────────────────────

describe('autoRouteConfigFacts：内容指纹的判据', () => {
  it('同一份内容 → 相同指纹（**即使对象引用不同**：池每次返回深拷贝）', () => {
    const build = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    expect(autoRouteConfigFacts(build())).toBe(autoRouteConfigFacts(build()))
  })

  it('开关 / 定义 id / 定义名 / 条目顺序 / effort 任一变化 → 指纹变化', () => {
    const base = config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const variants = [
      config(false, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m2', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m1', '自动二号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-b', model: 'a' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'b' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'low' }])]),
    ]
    for (const variant of variants) {
      expect(autoRouteConfigFacts(variant)).not.toBe(autoRouteConfigFacts(base))
    }
  })

  it('**effort 缺省 vs 显式空串之外的差异**：缺省写成 null 占位，不会与「有值」混同', () => {
    const withEffort = config(true, [def('m1', 'x', [{ provider: 'p-a', model: 'a', effort: 'low' }])])
    const without = config(true, [def('m1', 'x', [{ provider: 'p-a', model: 'a' }])])
    expect(autoRouteConfigFacts(withEffort)).not.toBe(autoRouteConfigFacts(without))
  })

  it('条目顺序变化 → 指纹变化（顺序就是候选优先级，必须重建）', () => {
    const ab = config(true, [def('m1', 'x', [{ provider: 'p-a', model: 'a' }, { provider: 'p-b', model: 'b' }])])
    const ba = config(true, [def('m1', 'x', [{ provider: 'p-b', model: 'b' }, { provider: 'p-a', model: 'a' }])])
    expect(autoRouteConfigFacts(ab)).not.toBe(autoRouteConfigFacts(ba))
  })
})

// ──────────────────────────── 13. 隐藏门控（providerCatalogVisible）────────────────────────────

describe('providerCatalogVisible：自动路由按开关可见', () => {
  /** 最小账号池替身：只有 `autoRouteConfig`（门控只读它）。 */
  const poolStub = (enabled: boolean) => ({ autoRouteConfig: () => config(enabled, []) })

  it('开关关着 → 不可见（模型分组从下拉消失）', async () => {
    expect(await providerCatalogVisible(poolStub(false) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(false)
  })

  it('开关开着 → 可见（**不看账号**：自动路由自己没有任何账号）', async () => {
    expect(await providerCatalogVisible(poolStub(true) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
  })

  it('替身连 `hasLoggedInAccount` 都没有（大量既有替身）→ 开着仍可见', async () => {
    // 若自动路由照抄账号判据，这条会返回 true 只是因为「能力检测保守放行」——
    // 而下面那条「关着」的用例会把真实的判据暴露出来。
    expect(await providerCatalogVisible(poolStub(true) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
    expect(await providerCatalogVisible(poolStub(false) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(false)
  })

  it('读配置抛异常 → 保守放行（与账号判据同款）', async () => {
    const broken = { autoRouteConfig: () => { throw new Error('storage corrupted') } }
    expect(await providerCatalogVisible(broken as never, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
  })

  it('accountPool 缺失（headless / CLI）→ 放行', async () => {
    expect(await providerCatalogVisible(undefined, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
  })

  it('真实账号池：无账号且开关关着 → 不可见；开关开着 → 可见（门控不依赖账号）', async () => {
    const { pool } = await makeRealPool()
    expect(await providerCatalogVisible(pool, AUTO_ROUTE_PROVIDER_ID)).toBe(false)
    await pool.writeAutoRoute({ enabled: true })
    expect(await providerCatalogVisible(pool, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
  })

  // ── 全局隐藏：自动路由开着 → 本插件其它 provider 全部从 DSH 目录消失 ──
  //
  // 修复前实测反证：`enabled=true` 时七个 provider **仍然全部可见** —— 这条函数
  // 当时只管了 auto-route 自己的可见性，全仓没有「开启后隐藏其它 provider」的判据。
  // 于是面板文案声称的「开启后本插件其它供应商从列表隐藏」是一句不成立的话。

  /** 七个真实 provider（与客户端 PROVIDERS 同一份清单，逐条覆盖而不是抽查一个）。 */
  const REAL_PROVIDERS = [
    'codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn',
  ] as const

  /**
   * 替身：开关 + 「账号可解析」。
   *
   * `loggedIn` 默认 `true` 是刻意的：只有账号判据为「已登录」，`false` 才**只可能**
   * 来自自动路由那条全局判据 —— 否则用例会因为「本来就没账号」而假绿。
   */
  const gatedStub = (enabled: boolean, loggedIn = true) => ({
    autoRouteConfig: () => config(enabled, []),
    hasLoggedInAccount: async () => loggedIn,
  })

  it('自动路由开着 → 七个真实 provider **全部**不可见（哪怕它账号可解析）', async () => {
    for (const provider of REAL_PROVIDERS) {
      expect(
        await providerCatalogVisible(gatedStub(true) as never, provider),
        `${provider} 应当在自动路由开启时从 DSH 目录隐藏`,
      ).toBe(false)
    }
    // 对偶面：开关关着 → 七个各自回到**账号判据**（账号可解析 ⇒ 可见）。
    for (const provider of REAL_PROVIDERS) {
      expect(
        await providerCatalogVisible(gatedStub(false) as never, provider),
        `${provider} 在自动路由关闭时应当按账号判据可见`,
      ).toBe(true)
    }
  })

  it('全局隐藏不误伤自动路由自己：开着时它仍可见', async () => {
    // 「开启后只剩自动路由」不能变成「什么都不剩」—— 新判据必须与自身判据同源。
    expect(await providerCatalogVisible(gatedStub(true) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
    expect(await providerCatalogVisible(gatedStub(false) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(false)
  })

  it('真实账号池：开关开着 → 七个 provider 全部隐藏，自动路由自己仍可见', async () => {
    const { pool } = await makeRealPool()
    await pool.writeAutoRoute({ enabled: true })
    for (const provider of REAL_PROVIDERS) {
      expect(await providerCatalogVisible(pool, provider)).toBe(false)
    }
    expect(await providerCatalogVisible(pool, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
  })

  it('对偶：目录被隐藏 ≠ 路由失效 —— 被隐藏的 provider 仍能被自动路由转发', async () => {
    // 门控只作用于 DSH 的**目录拉取**（各适配器 `listModels` → `buildModelCatalog`）；
    // DSH 约定「目录仅供参考，缺省不构成请求拒绝」。这里先把隐藏原因**锁定**在
    // 自动路由判据上（该 provider 的账号可解析 ⇒ 账号判据本来会放行），再断言请求
    // 照旧被转发过去 —— 否则「隐藏」会被误当成「这条路由被停用」。
    const { pool, credentials } = await makeRealPool()
    const entry: ProviderAccountEntry = {
      id: 'pa-1', provider: 'p-a', nickname: 'P A', enabled: true,
      credentialRef: 'PA_ACCOUNT_1', createdAt: 1, refreshable: true,
    }
    await pool.addAccount(entry)
    credentials.set(entry.credentialRef, JSON.stringify({ access_token: 'AT' }))
    await pool.writeAutoRoute({ enabled: true })

    expect(await pool.hasLoggedInAccount('p-a'), '前置：该 provider 账号可解析').toBe(true)
    expect(await providerCatalogVisible(pool, 'p-a'), '前置：仍被自动路由判据隐藏').toBe(false)

    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    expect(target.seen.get('p-a'), '目录被隐藏的 provider 仍应收到转发请求').toHaveLength(1)
  })

  it('DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0 **只豁免账号门控**，自动路由隐藏不受影响', async () => {
    const original = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
    process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = '0'
    try {
      // 该变量的名字与文档都只讲一件事：「没有已登录账号就隐藏」。显式假值豁免它。
      expect(await providerCatalogVisible(gatedStub(false, false) as never, 'buddy-cn')).toBe(true)
      // 自动路由的隐藏是**用户在面板上的显式选择**，与账号门控无关 ⇒ 不随它豁免。
      expect(await providerCatalogVisible(gatedStub(true, false) as never, 'buddy-cn')).toBe(false)
      // 自动路由**自己**那条判据仍归这条变量管（既有语义：全局关掉门控后，
      // 连虚拟 provider 的开关也不再藏它）—— 本次只把「开启后隐藏别人」单列出来。
      expect(await providerCatalogVisible(poolStub(false) as never, AUTO_ROUTE_PROVIDER_ID)).toBe(true)
    } finally {
      if (original === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
      else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = original
    }
  })
})

/** 建一个真实 `AccountPool`（无账号、无凭据）—— 门控读的是池自己的配置副本。 */
async function makeRealPool() {
  const credentials = new Map<string, string>()
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: [] }
  const settings = {
    register: () => ({
      get: () => stored,
      replace: async (value: { accounts?: ProviderAccountEntry[] }) => { stored = value },
    }),
    describe: () => [{ ns: 'dsh_account_hub', value: stored }],
  }
  const refKey = (ref: unknown): string => (typeof ref === 'string' ? ref : String(ref))
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => (key === 'settings' ? settings : undefined),
    credentials: {
      describe: async (ref: unknown) => ({ configured: credentials.has(refKey(ref)), writable: true }),
      resolve: async (ref: unknown) => {
        const value = credentials.get(refKey(ref))
        return value === undefined ? undefined : { value }
      },
      set: async (ref: unknown, value: string) => { credentials.set(refKey(ref), value) },
      unset: async (ref: unknown) => { credentials.delete(refKey(ref)) },
    },
  }
  const pool = new AccountPool(ctx as never)
  return { pool, credentials }
}

// ──────────────────────────── 14. 与纯逻辑层的一致性（承重点）────────────────────────────

describe('运行面与纯逻辑层的判据同源', () => {
  it('降级阈值来自 autoRouteEntryCount（适配器不自建计数口径）', () => {
    const rt = createAutoRouteRuntime([def('m1', 'x', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
      { provider: 'p-c', model: 'c' },
    ])])
    expect(autoRouteHead(rt, 'm1')).toMatchObject({ provider: 'p-a' })
  })

  it('自动路由 provider id 是纯逻辑层的常量（不写字面量）', () => {
    expect(AUTO_ROUTE_PROVIDER_ID).toBe('auto-route')
  })
})

// ──────────────────────────── 15. 会话侧残留档位的兜底 ────────────────────────────
//
// 聚合模型不声明 reasoning 后，宿主对「无声明 + 请求带档位」是**硬拒**
// （`UNSUPPORTED_REASONING_EFFORT`），且发生在**适配器之前** —— 实测那条路径上
// `adapter.stream()` 根本不会被调用。真实 agent 路径更早：`llm.prepareCall()` 内部
// 就抛，其 catch 只放行 `NO_ADAPTER`，其余 rethrow ⇒ 整轮直接死。
//
// 残留档位来自升级前用过自动路由并显式选过档位的历史会话（持久化在 `model/selection`
// 或 request header 上，恢复时由 `agent.ts` 还原），而用户此时**没有任何界面手段**
// 清掉它（档位下拉已不存在）。故兜底挂在 `agent/request` 瀑布流上 —— 它在
// `prepareRequest` 里**早于 `prepareCall`**，是唯一能改变「校验前配置」的可挂点。

describe('installAutoRouteEffortGuard：剥掉会话侧残留档位（不打死）', () => {
  /** 建一个带 logger 替身的真实运行时 + 聚合适配器 + 已安装兜底。 */
  async function guardBench() {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { ctx, target, adapter } = await harness({ config: cfg })
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn, info: () => {} }
    installAutoRouteEffortGuard(ctx)
    return { ctx, target, adapter, warn }
  }

  /** 走真实的 `agent/request` 瀑布流跑一遍 seedConfig（模拟 agent.ts 的 prepareRequest）。 */
  async function throughRequestWaterfall(ctx: Context, seed: LlmCallConfig): Promise<LlmCallConfig> {
    return ctx.waterfall(
      ctx,
      'agent/request',
      { agent: {} as never, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(seed),
    )
  }

  it('带残留档位 → 剥键 + warn 一次；**用剥键后的配置真能跑通**（这正是修复点）', async () => {
    const { ctx, target, warn } = await guardBench()
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const proposed = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })

    // ① 键被**删掉**（不是置 undefined —— 那仍是一次显式覆盖）。
    expect('reasoningEffort' in proposed).toBe(false)
    // ② warn 恰好一次，且点名是哪个模型。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(`${AUTO_ROUTE_PROVIDER_ID}/m1`)

    // ③ **承重断言**：修复前这里会抛 UNSUPPORTED_REASONING_EFFORT（整轮死）。
    const prepared = await ctx.llm.prepareCall(proposed)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    // ④ 转发照常走条目档位语义：条目没配 → 落目标自己的默认档 low。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low')
  })

  it('warn 按定义去重：同一模型连发两次请求只 warn 一次（不逐步刷屏）', async () => {
    const { ctx, warn } = await guardBench()
    const seed: LlmCallConfig = {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    }

    await throughRequestWaterfall(ctx, seed)
    await throughRequestWaterfall(ctx, seed)
    await throughRequestWaterfall(ctx, seed)

    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('对偶面：**非** auto-route 的 provider 带档位原样放行、不 warn', async () => {
    const { ctx, warn } = await guardBench()

    const proposed = await throughRequestWaterfall(ctx, {
      provider: 'p-a',
      model: 'a',
      reasoningEffort: ReasoningEffortId('high'),
    })

    // 兜底只服务聚合模型：别的 provider 的档位是正经能力，动它就是缺陷。
    expect(proposed.reasoningEffort).toBe('high')
    expect(warn).not.toHaveBeenCalled()
  })

  it('对偶面：auto-route 但**没带**档位 → 原样返回、不 warn（不动正常路径）', async () => {
    const { ctx, warn } = await guardBench()

    const proposed = await throughRequestWaterfall(ctx, { provider: AUTO_ROUTE_PROVIDER_ID, model: 'm1' })

    expect(proposed).toEqual({ provider: AUTO_ROUTE_PROVIDER_ID, model: 'm1' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('返回的是**新对象**：不改调用方传进来的那份（seedConfig 可能是冻结的）', async () => {
    const { ctx } = await guardBench()
    const seed = Object.freeze({
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })

    const proposed = await throughRequestWaterfall(ctx, seed)

    expect(proposed).not.toBe(seed)
    // 原对象仍冻结且档位未被动过（原地 delete 会在这里静默失败或抛错）。
    expect(Object.isFrozen(seed)).toBe(true)
    expect(seed.reasoningEffort).toBe('high')
  })

  it('返回值是注销函数（fiber 释放时能摘掉监听器）', async () => {
    // ⚠️ 这里刻意**不用** guardBench：它自己会装一个兜底，那样注销掉第二个之后
    // 第一个仍在生效，用例会变成「注销是假的」的假阳性。
    const { ctx } = await harness({
      config: () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
    })
    const dispose = installAutoRouteEffortGuard(ctx)
    expect(typeof dispose).toBe('function')

    // 装着的状态：剥键。
    const before = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect('reasoningEffort' in before).toBe(false)

    dispose()

    // 摘掉后不再剥键（否则「注销」是假的，fiber 释放后会留下一个野监听器）。
    const after = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(after.reasoningEffort).toBe('high')
  })

  it('兜底**真的**救活了 agent 会话路径：prepareCall 不再抛，整轮跑通（承重用例）', async () => {
    const { ctx, target, warn } = await guardBench()
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    // 照 `agent-loop/agent.ts:502-550 prepareRequest` 的真实序列走一遍：
    //   seedConfig(带持久化档位) → agent/request 瀑布流 → prepareCall → preparedCall.stream
    const proposed = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    // 修复前：这一行就抛 UNSUPPORTED_REASONING_EFFORT（agent.ts 的 catch 只放行
    // NO_ADAPTER，其余 rethrow ⇒ 整轮直接死）。
    const prepared = await ctx.llm.prepareCall(proposed)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    // 剥键后照常转发，且落**目标自己的**默认档（条目没配档位）。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('**没有**在 `stream()` 入口剥键（否则会破坏「条目没配 → 透传调用方档位」的直调语义）', async () => {
    // 这条是**反面判据**，钉住一个被实测证伪的设计：任务书曾要求在适配器 `stream()`
    // 入口加一道防御剥键，声称能兜底 `resolveCallConfig` 直调路径。实测（真实
    // `LlmRuntime`，三条宿主路径）证伪：
    //
    // | 路径 | 结果 | adapter.stream 调用数 |
    // |---|---|---|
    // | `resolveCallConfig` 带档位 | 抛 UNSUPPORTED_REASONING_EFFORT | **0** |
    // | `ctx.llm.stream` 带档位 | 终止 chunk 报错 | **0** |
    // | `prepareCall` 带档位 | 抛 UNSUPPORTED_REASONING_EFFORT | **0** |
    //
    // 校验（`resolveCallWithInfo`，dsh-llm/lib/index.js:1561-1586）**早于**适配器被
    // 调用 ⇒ 入口剥键**永远执行不到**，是死代码。更糟的是它**有害**：直接调适配器的
    // 场景（本文件的转发语义用例、未来的外部调用方）依赖「条目没配档位时不写该键、
    // 调用方带来的值原样透传」，入口剥键会把那个值静默清掉。
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    // 调用方显式给的档位**必须原样到达目标**（若入口加了剥键，这里会变成 'low'）。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('兜底对**非** auto-route provider 是纯直通：连 next() 的返回值都原样透传（引用相等）', async () => {
    const { ctx } = await guardBench()
    const seed = { provider: 'p-a', model: 'a', reasoningEffort: ReasoningEffortId('high') } as const

    const proposed = await throughRequestWaterfall(ctx, seed)

    // 对偶面比「值没变」更强：必须是**同一个对象引用**，证明兜底没做任何拷贝/重建。
    expect(proposed).toBe(seed)
  })

  it('剥键形态：**删除**键；且「置 undefined」在本链路上等效（记录实测，勿写成正确性要求）', async () => {
    const { ctx, target } = await guardBench()
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const proposed = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    // 实现选的是「删除」：键不存在（语义是「这一轮压根没有档位这回事」）。
    expect('reasoningEffort' in proposed).toBe(false)

    // 对照面：宿主各判据都是 `=== void 0`，故「键在但值为 undefined」同样能跑通 ——
    // 这里断言的是**不抛**且整轮正常（不是断言 config 上有个档位：聚合模型不声明档位，
    // 故 `prepareCall` 的 config 本来就不带它，目标默认档是在内层才补上的）。
    // 实测这一条，是为了让「必须 delete、否则会坏」这类**过度断言**无处生根 ——
    // 选 delete 是偏好（更诚实、且与 agent.ts:66 的 requestProposal 一致），不是正确性要求。
    const asUndefined = { ...proposed, reasoningEffort: undefined }
    expect('reasoningEffort' in asUndefined).toBe(true)
    const prepared = await ctx.llm.prepareCall(asUndefined)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low') // 目标自己的默认档
  })
})
