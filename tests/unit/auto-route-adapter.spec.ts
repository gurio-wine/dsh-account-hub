/**
 * 「自动路由」**运行面**回归测试：聚合适配器（`src/auto-route-adapter.ts`）+ 隐藏门控
 * + 注册生命周期。
 *
 * ## 本文件守什么
 *
 * `auto-route.spec.ts` 守纯逻辑（配置判据 / 轮转引擎），`auto-route-rpc.spec.ts` 守
 * 配置面（落盘 / RPC）。本文件守的是**中间那一段**，也是三处最容易静默失效的地方：
 *
 * 1. **转发语义**：目标 provider / model / effort 怎么取（预检可用时优先调用方合法档位，再回落合法条目档位；预检不可用时保留调用方带值、缺省则回落条目档位；皆无时不带该键并落目标默认档），
 *    历史消息的 `source.provider` 怎么重写（不重写 = 思考模式工具轮
 *    400，见 `rewriteMessagesForTarget` 的说明）、冻结请求能不能改。
 * 2. **能力声明**：聚合模型按当前队首目标动态合并 reasoning 能力（只暴露非空
 *    `efforts`，并按条目 / 目标默认档回退）；队首变化后能力随之变化——见第 9 节。
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
 * 同理，`resolveCallConfig` 的档位物化行为也由真实运行时校验（聚合模型按当前队首目标
 * 声明非空 `efforts`，并按当前合法 `defaultEffort` 物化缺省档位）。
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
  // 两个头覆写字段也要能造出来：它们与 effort 一样**影响出站行为**，故同样必须进
  // 内容指纹（见 autoRouteConfigFacts 那组用例）。
  entries: {
    provider: string
    model: string
    effort?: string
    userAgent?: string
    originator?: string
    masquerade?: { windowId: string }
  }[],
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
  /** provider/model → 解析结果脚本（用于覆盖能力与预检失败路径）。 */
  private readonly resolveScripts = new Map<string, (LlmResolvedModelInfo | Error)[]>()
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

  /** 覆盖一个目标模型的能力解析（也可排入一次性 reject）。 */
  queueResolve(provider: string, model: string, ...results: (LlmResolvedModelInfo | Error)[]): void {
    const key = `${provider}/${model}`
    const list = this.resolveScripts.get(key) ?? []
    list.push(...results)
    this.resolveScripts.set(key, list)
  }

  providerInfo(provider: string) {
    return { id: provider, name: `目标 ${provider}` }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: 'target-model', name: '目标模型' }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const scripted = this.resolveScripts.get(`${provider}/${model}`)?.shift()
    if (scripted instanceof Error) throw scripted
    if (scripted !== undefined) return scripted
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
  it('调用方合法档位优先于条目 effort；entry.effort 成为默认回落档', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('low') })

    // 目标预检接受调用方 low 时优先转发；条目的 high 仅在调用方缺省或非法时回落使用。
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-a')![0]).toMatchObject({ provider: 'p-a', model: 'a', reasoningEffort: 'low' })
  })

  it('预检成功 + caller 缺省 + 条目档位受支持 → 转发 entry.effort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', {
      provider: 'p-a',
      id: 'a',
      name: '目标 a',
      ...TARGET_MODEL_INFO,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('预检成功 + caller 档位不受支持、条目档位受支持 → 回落 entry.effort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', {
      provider: 'p-a',
      id: 'a',
      name: '目标 a',
      ...TARGET_MODEL_INFO,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('max') })

    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('预检成功 + caller 与条目档位均不受支持 → 转发 options 省略 reasoningEffort 键', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'minimal' }])])
    const { ctx, adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', {
      provider: 'p-a',
      id: 'a',
      name: '目标 a',
      ...TARGET_MODEL_INFO,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    const streamSpy = vi.spyOn(ctx.llm, 'stream')

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('max') })

    // 在真实 LlmRuntime 物化目标默认档之前，断言适配器交给 stream 的 options 省略了键。
    const forwarded = streamSpy.mock.calls[0]![0]
    expect('reasoningEffort' in forwarded).toBe(false)
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low')
  })

  it('条目没配 effort 且 caller 带合法档位 → 直调真实 stream 预检后在目标支持时转发', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    // ⚠️ 这是直接调用 `AutoRouteAdapter.stream()` 的场景，绕过宿主调度与 `prepareCall`；
    // 但真实 adapter stream 仍会对带 `reasoningEffort` 的 caller 执行目标能力预检。
    // 本条验证当前目标支持该档位时，条目未配置 effort 不会改写 caller 已带的
    // `reasoningEffort`，而是将合法值转发；不声称只测 `forwardOptions`，也不覆盖
    // `target === undefined` 的私有 no-probe 分支。
    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    expect(target.seen.get('p-a')![0]).toMatchObject({ reasoningEffort: 'high' })
  })

  it('条目没配 effort 且用户也没选 → 聚合层物化队首目标的默认档', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { ctx, adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    // 外层按当前队首目标声明 reasoning，并由其合法 defaultEffort 物化缺省档位。
    const outer = await ctx.llm.resolveCallConfig({ provider: AUTO_ROUTE_PROVIDER_ID, model: 'm1' })
    expect(outer.reasoningEffort).toBe('low')
    // 转发请求最终仍落到当前目标的默认档。
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
  it('记录被降级候选、聚合模型、真实失败原因与出站覆写', async () => {
    const cfg = () => config(true, [def('glm-53-auto', 'GLM 5.3 自动', [
      {
        provider: 'qoder-cn',
        model: 'gmodel',
        userAgent: 'test-agent',
        originator: 'test-origin',
      },
      { provider: 'qoder', model: 'fallback-model' },
    ])])
    const { ctx, adapter, target } = await harness({ config: cfg })
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn }
    target.queue('qoder-cn', { kind: 'error', code: 'UPSTREAM_REJECTED', message: '真实错误原文：model unavailable' })
    target.queue('qoder', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'glm-53-auto')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('qoder-cn')).toHaveLength(1)
    expect(target.seen.get('qoder')).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[auto-route]'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('qoder-cn/gmodel'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('聚合模型 auto-route/glm-53-auto（GLM 5.3 自动）'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('finish=error'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=UPSTREAM_REJECTED'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('真实错误原文：model unavailable'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('userAgent=test-agent'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('originator=test-origin'))
  })

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

  it('内层流没给终止 chunk 且**一个 chunk 都没透传** → 静默换下一个候选并记录原因', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { ctx, adapter, target } = await harness({ config: cfg })
    const warn = vi.fn()
    ;(ctx as unknown as { logger: unknown }).logger = { warn }
    // 空的 chunks 步 = 什么都不 yield 就结束（合法的「无终止 chunk」形态）。
    target.queue('p-a', { kind: 'chunks', chunks: [] })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1')

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-b')).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('候选 p-a/a'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('finish=无终止 chunk'))
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

  // ── 档位：只暴露当前队首目标的非空 efforts ──
  //
  // 聚合模型的 reasoning 能力跟随当前队首目标动态变化：不混入备用候选，也不把非法
  // 的条目档位伪装成能力。条目档位合法时成为 defaultEffort，缺省或非法时回退到
  // 目标自身的合法 defaultEffort；两者都无效则省略默认值。

  it('目标有非空 efforts → 聚合模型暴露队首能力，身份与窗口仍按自动模型', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect(resolved).toMatchObject({
      provider: AUTO_ROUTE_PROVIDER_ID,
      id: 'm1',
      name: '自动一号',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8192,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    })
  })

  it('条目档位合法 → 成为聚合模型的 defaultEffort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect(resolved.reasoning).toMatchObject({
      efforts: [
        { id: 'low' },
        { id: 'high' },
      ],
      defaultEffort: 'high',
    })
  })

  it('条目缺省档位 → 回退目标合法 defaultEffort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect(resolved.reasoning).toMatchObject({ defaultEffort: 'low' })
  })

  it('条目档位非法 → 不覆盖目标合法 defaultEffort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'max' }])])
    const { adapter } = await harness({ config: cfg })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    // 非法条目值不能进入 defaultEffort；仍可回退到目标声明的合法默认档。
    expect(resolved.reasoning).toMatchObject({ defaultEffort: 'low' })
    expect(resolved.reasoning?.defaultEffort).not.toBe('max')
  })

  it('条目档位非法且目标缺省 defaultEffort → 保留合法 efforts 但省略 defaultEffort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'max' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', {
      provider: 'p-a',
      id: 'a',
      name: '目标 a',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8192,
      reasoning: {
        efforts: TARGET_MODEL_INFO.reasoning.efforts,
      },
    })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect(resolved.reasoning?.efforts).toEqual(TARGET_MODEL_INFO.reasoning.efforts)
    expect('defaultEffort' in (resolved.reasoning ?? {})).toBe(false)
  })

  it('目标无 reasoning → reasoning 键省略（空 efforts 在公开 resolver 边界被宿主拒绝）', async () => {
    // 真实 `LlmRuntime.resolveModelInfo` 会在进入本适配器的 mergeReasoning 前拒绝
    // `reasoning.efforts = []`，故空 efforts 不是本适配器可接收的目标能力夹具；这里只测
    // 宿主真实可接受的「无 reasoning」输入。
    const provider = 'p-none'
    const model = 'none'
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider, model }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve(provider, model, {
      provider,
      id: model,
      name: `目标 ${model}`,
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8192,
    })

    const resolved = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')

    expect('reasoning' in resolved).toBe(false)
    expect(resolved.reasoning).toBeUndefined()
  })

  it('队首切换后能力跟随当前队首，不混合备用候选', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    const lowOnly = {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    }
    const highOnly = {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    }
    target.queueResolve('p-a', 'a', {
      provider: 'p-a', id: 'a', name: '目标 a', ...TARGET_MODEL_INFO, reasoning: lowOnly,
    })
    const first = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect(first.reasoning).toMatchObject({ efforts: [{ id: 'low' }], defaultEffort: 'low' })

    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await drain(adapter, 'm1')

    target.queueResolve('p-b', 'b', {
      provider: 'p-b', id: 'b', name: '目标 b', ...TARGET_MODEL_INFO, reasoning: highOnly,
    })
    const second = await adapter.resolveModel(AUTO_ROUTE_PROVIDER_ID, 'm1')
    expect(second.reasoning).toMatchObject({ efforts: [{ id: 'high' }], defaultEffort: 'high' })
    expect(second.reasoning?.efforts).not.toEqual(expect.arrayContaining([{ id: 'low', name: 'Low' }]))
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

  it('开关 / 定义 id / 定义名 / 条目顺序 / effort / 两个头覆写 任一变化 → 指纹变化', () => {
    const base = config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const variants = [
      config(false, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m2', '自动一号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m1', '自动二号', [{ provider: 'p-a', model: 'a' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-b', model: 'a' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'b' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'low' }])]),
      // ⚠️ 两个头覆写字段也必须各自改变指纹：漏了它们，用户在面板里改了 UA / Originator
      // 之后运行时**不会重建**，请求仍按旧值发出去 —— 界面显示已保存、出站却纹丝不动。
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', userAgent: 'Agent/1.0' }])]),
      config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', originator: 'my-app' }])]),
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

// ──────────────────────────── 15. 会话侧档位的能力兜底 ────────────────────────────
//
// 聚合模型现在暴露当前队首目标的非空 reasoning.efforts，宿主会在适配器之前校验
// 请求档位。agent/request 瀑布流是会话配置进入 prepareCall 前唯一可修正的挂点：当前
// 能力支持的档位必须保留，只有解析成功且明确失配的历史残留才剥除并告警；能力解析失败
// 时无法判断，保留用户选择并告警。
//
// 失配档位来自升级前用过自动路由并显式选过档位的历史会话（持久化在 `model/selection`
// 或 request header 上，恢复时由 `agent.ts` 还原）。兜底只作用于 agent/request；直接
// 调适配器的转发语义仍由前面的用例覆盖。

describe('installAutoRouteEffortGuard：按当前能力清理会话档位', () => {
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

  it('当前能力支持的 auto-route effort → 保留且不 warn；会话路径照常跑通', async () => {
    const { ctx, target, warn } = await guardBench()
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const proposed = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })

    expect(proposed.reasoningEffort).toBe('high')
    expect(warn).not.toHaveBeenCalled()

    const prepared = await ctx.llm.prepareCall(proposed)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('当前能力不支持的 auto-route effort → 删除并按模型 warn 去重', async () => {
    const { ctx, warn } = await guardBench()
    const seed: LlmCallConfig = {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('max'),
    }

    const first = await throughRequestWaterfall(ctx, seed)
    const second = await throughRequestWaterfall(ctx, seed)

    expect('reasoningEffort' in first).toBe(false)
    expect('reasoningEffort' in second).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(`${AUTO_ROUTE_PROVIDER_ID}/m1`)
  })

  it('resolveModelInfo reject → 保留档位并 warn 一次（能力未知不能当作失配）', async () => {
    const { ctx, target, warn } = await guardBench()
    target.queueResolve('p-a', 'a', new Error('resolve failed'), new Error('resolve failed again'))

    const seed: LlmCallConfig = {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    const first = await throughRequestWaterfall(ctx, seed)
    const second = await throughRequestWaterfall(ctx, seed)

    expect(first.reasoningEffort).toBe('high')
    expect(second.reasoningEffort).toBe('high')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(`${AUTO_ROUTE_PROVIDER_ID}/m1`)
    expect(String(warn.mock.calls[0]![0])).toContain('无法确认')
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

    // 装着的状态：失配档位被剥除。
    const before = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('max'),
    })
    expect('reasoningEffort' in before).toBe(false)

    dispose()

    // 摘掉后不再剥键（否则「注销」是假的，fiber 释放后会留下一个野监听器）。
    const after = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('max'),
    })
    expect(after.reasoningEffort).toBe('max')
  })

  it('当前能力支持的档位不会被兜底破坏：prepareCall 与整轮会话路径跑通', async () => {
    const { ctx, target, warn } = await guardBench()
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    // 照 `agent-loop/agent.ts:502-550 prepareRequest` 的真实序列走一遍：
    //   seedConfig(带当前合法档位) → agent/request 瀑布流 → prepareCall → preparedCall.stream
    const proposed = await throughRequestWaterfall(ctx, {
      provider: AUTO_ROUTE_PROVIDER_ID,
      model: 'm1',
      reasoningEffort: ReasoningEffortId('high'),
    })
    const prepared = await ctx.llm.prepareCall(proposed)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)

    expect(kinds(chunks)).toEqual(['finish:stop'])
    // 合法档位原样转发，且不触发告警。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
    expect(warn).not.toHaveBeenCalled()
  })

  it('真实 `stream()` 仅对带 effort 的请求预检；合法 caller 不被剥除（无条件入口剥键不作兜底）', async () => {
    // 这里走真实 `adapter.stream` 的 resolved probe 路径：请求带 caller effort 时按当前
    // 目标能力预检，合法 caller 值仍到达目标；不声称覆盖 `forwardOptions` 的
    // `target === undefined` 私有分支。
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    // 合法 caller 档位必须原样到达目标；无条件在 stream 入口剥键不能作为兜底。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('caller-only 非法 effort → 预检后回落目标默认 low 且流成功', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', {
      provider: 'p-a',
      id: 'a',
      name: '目标 a',
      ...TARGET_MODEL_INFO,
    })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('max') })

    expect(kinds(chunks)).toEqual(['finish:stop'])
    // 真实运行时会按聚合模型的合法默认档物化；非法 caller max 不得透传。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('low')
  })

  it('caller-only 合法 effort 且预检 reject → 保留 caller，只调用队首候选并成功', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', new Error('preflight failed'))
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    const chunks = await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    expect(kinds(chunks)).toEqual(['finish:stop'])
    expect(target.seen.get('p-a')).toHaveLength(1)
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
    expect(target.seen.get('p-b')).toBeUndefined()
  })

  it('兜底对**非** auto-route provider 是纯直通：连 next() 的返回值都原样透传（引用相等）', async () => {
    const { ctx } = await guardBench()
    const seed = { provider: 'p-a', model: 'a', reasoningEffort: ReasoningEffortId('high') } as const

    const proposed = await throughRequestWaterfall(ctx, seed)

    // 对偶面比「值没变」更强：必须是**同一个对象引用**，证明兜底没做任何拷贝/重建。
    expect(proposed).toBe(seed)
  })

  it('stream 预检发现条目档位失配 → 不发送非法 entry，保留调用方合法档位', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'max' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    // 预检确认 max 不在目标 low/high 表中后，entry 值不得污染出站；合法 caller 值仍可用。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('stream 预检 resolveModelInfo reject + 调用方带档位 → 原样优先于 entry.effort', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'max' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', new Error('preflight failed'))
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1', { reasoningEffort: ReasoningEffortId('high') })

    // 预检失败时不验证两方档位；调用方显式值原样优先于 entry.effort。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })

  it('stream 预检 resolveModelInfo reject + 调用方缺省 → 回落 entry 档位并继续转发', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a', effort: 'high' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queueResolve('p-a', 'a', new Error('preflight failed'))
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    // 预检失败时调用方缺省，按新语义回落到 entry.effort；真实转发仍携带 high。
    expect(target.seen.get('p-a')![0].reasoningEffort).toBe('high')
  })
})

// ──────────────────────────── 15. 两个头覆写通道的转发注入 ────────────────────────────

/**
 * 头覆写通道在**转发**这一步的注入断言（`forwardOptions()`，`src/auto-route-adapter.ts`）。
 *
 * ## 为什么这一层必须单独钉住
 *
 * 出站请求头由**内层真实适配器**自建，聚合层一点都碰不到：`ctx.llm.stream()` 没有
 * 「带自定义头」这个入口。故聚合层唯一能做的就是把候选条目的值挂到 options 的
 * 内部通道字段上（`accountHubUserAgent` / `accountHubOriginator`），随对象一起穿过
 * `ctx.llm.stream()`，由内层在构造完自己的头**之后**应用。
 *
 * 于是「注入」与「应用」是两个**各自会独立失效**的接缝：
 * - 注入漏了 → 内层读不到值，用户配了覆写却什么都没发生（且没有任何报错）；
 * - 应用漏了 → 同上。
 * 本组用例守的是前者（后者由各适配器 spec 的出站头断言守）。这里的断言对象是
 * **内层适配器 `stream()` 真正收到的那个对象**，而不是 `forwardOptions` 的返回值 ——
 * 因为中间还夹着宿主 `LlmRuntime` 的适配器选择与能力解析，只有端到端的形态才能
 * 证明「值确实穿过去了」（见本文件模块头对 mock 边界的说明）。
 */
describe('stream：两个头覆写通道在转发时注入 options', () => {
  /** 内层收到的 options 的通道字段形态（内部协议字段不在宿主 `GenerateOptions` 类型里）。 */
  type ForwardedOptions = GenerateOptions & {
    accountHubUserAgent?: string
    accountHubOriginator?: string
  }

  it('条目**配了** userAgent + originator → 内层收到的 options 里两个键都在且值正确', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a', userAgent: 'AutoRoute/1.0', originator: 'my-app' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    const forwarded = target.seen.get('p-a')![0] as ForwardedOptions
    // ⚠️ 两条通道的注入是**两行独立代码**：只写一行 = 另一条通道整条失效，
    // 而面板上那个值明明配着（用户以为生效了）。
    expect(
      forwarded.accountHubUserAgent,
      'User-Agent 通道：条目配的值必须随 options 到达内层适配器，否则覆写永远不会落到出站头',
    ).toBe('AutoRoute/1.0')
    expect(
      forwarded.accountHubOriginator,
      'Originator 通道：与 UA 逐字同款的一行，漏写它等于该通道整条失效且无任何报错',
    ).toBe('my-app')
  })

  it('条目**缺省**两者 → options 里这两个键**都不存在**（不是空串、不是 undefined）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    const forwarded = target.seen.get('p-a')![0] as ForwardedOptions
    // ⚠️ 判据必须是「键不存在」而不是「值为空」：缺省路径要保证出站形态与加这两条
    // 通道之前**逐字节一致**（AGENTS.md 的出站协议值红线）。写成 `field: undefined`
    // 会让「没配」与「配了个 undefined」在 `in` 判据下混同，也会让任何按 `in` 分支的
    // 内层实现（或调试时的对象打印）凭空多出一个键。
    expect(
      'accountHubUserAgent' in forwarded,
      'User-Agent 通道缺省时**一个键都不该挂**：字段缺席 = 用内层自己的默认 UA',
    ).toBe(false)
    expect(
      'accountHubOriginator' in forwarded,
      'Originator 通道缺省时**一个键都不该挂**：该头在七家上游协议里本就不存在，缺省必须一个字节都不发',
    ).toBe(false)
    // 反面判据：不能是空串占位（空串同样会被判为非法而「不覆写」，但它在对象里
    // 是个实实在在的键，会让上面两条 `in` 断言失去意义）。
    expect(forwarded.accountHubUserAgent).toBeUndefined()
    expect(forwarded.accountHubOriginator).toBeUndefined()
  })

  it('只配 userAgent → originator 键不挂（两条通道**互不牵连**，不互相补空）', async () => {
    // 反面判据：若实现把两条通道写成「要么都挂、要么都不挂」，用户只配 UA 时就会
    // 多出一个空的 Originator 键 —— 而它一旦被内层当成合法值，就会凭空发出一个头。
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a', userAgent: 'AutoRoute/1.0' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    const forwarded = target.seen.get('p-a')![0] as ForwardedOptions
    expect(forwarded.accountHubUserAgent).toBe('AutoRoute/1.0')
    expect('accountHubOriginator' in forwarded).toBe(false)
  })

  it('只配 originator → userAgent 键不挂（反向对偶）', async () => {
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a', originator: 'my-app' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    const forwarded = target.seen.get('p-a')![0] as ForwardedOptions
    expect(forwarded.accountHubOriginator).toBe('my-app')
    expect('accountHubUserAgent' in forwarded).toBe(false)
  })

  it('降级到第二个条目时，**失败条目配的覆写值不会漏给成功条目**（每条候选各自成对）', async () => {
    // 降级是「换一个 provider/model 重发同一次请求」，故注入必须按**当次尝试的条目**
    // 重算。若实现把值缓存在请求级（例如写在闭包外的变量里），用户给 a 配的 UA 就会
    // 跟着发到 b 去 —— 出站身份被悄悄改成了另一家的形态。
    const cfg = () => config(true, [def('m1', '自动一号', [
      { provider: 'p-a', model: 'a', userAgent: 'OnlyForA/1.0', originator: 'app-a' },
      { provider: 'p-b', model: 'b' },
    ])])
    const { adapter, target } = await harness({ config: cfg })
    target.queue('p-a', { kind: 'error', code: 'SERVER', message: 'a 挂了' })
    target.queue('p-b', { kind: 'chunks', chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })

    await drain(adapter, 'm1')

    const failed = target.seen.get('p-a')![0] as ForwardedOptions
    const succeeded = target.seen.get('p-b')![0] as ForwardedOptions
    expect(failed.accountHubUserAgent).toBe('OnlyForA/1.0')
    expect(failed.accountHubOriginator).toBe('app-a')
    // b 没配 ⇒ 两个键都不挂（绝不继承 a 的值）。
    expect('accountHubUserAgent' in succeeded).toBe(false)
    expect('accountHubOriginator' in succeeded).toBe(false)
  })
})
