/**
 * 「自动路由」的**聚合适配器**：把若干自动模型暴露成 DSH 上的一个虚拟 provider
 * （{@link AUTO_ROUTE_PROVIDER_ID}），并在一次请求内按候选顺序**转发 + 降级**。
 *
 * ## 分层：本文件只做「接线」，语义全在 `src/auto-route.ts`
 *
 * 配置契约（读/写判据、默认值）、降级轮转引擎（`autoRouteHead` /
 * `demoteAutoRouteHead` / `autoRouteEntryCount`）与历史消息重写
 * （`rewriteMessagesForTarget`）都在那个纯逻辑模块里，本文件**不重新实现任何判据**
 * —— 它只做三件事：把 DSH 的模型目录问询转成对池配置的读取、把一次请求按队首
 * 条目转发给真实 provider、把内层失败翻译成「降级」或「透传」。
 *
 * ## 转发为什么是「重入 `ctx.llm.stream()`」而不是直接调别的适配器
 *
 * `ctx` 上**没有**「按 provider 取适配器实例」的入口（`LlmRuntime` 只暴露
 * `listProviders` / `listModels` / `resolveModelInfo` / `stream`）。跨 provider 的
 * 唯一通路就是在适配器的 `stream()` 里带目标 provider 重入 `ctx.llm.stream()` ——
 * 宿主会据此重新走一遍适配器选择、能力解析与请求装配。这也是官方认可的做法。
 *
 * ## 内层失败以 `finish` chunk 到达，**不是 throw**
 *
 * 宿主的 `adapterStream` 把「建立阶段抛错」与「迭代阶段抛错」**都**规范化为一个
 * 终止 chunk：`finish{reason:{kind:'error'|'aborted'}}`。故本适配器的降级判据读的是
 * chunk，而不是 try/catch —— 若照 throw 写，转发路径上的失败将**一条都降级不了**，
 * 全部直报给用户。
 *
 * ## `emitted` 的判据是「已 yield 过任何非 finish chunk」，不是「已出字」
 *
 * 这一条比字面语义更严，是**宿主流语法**要求的：一旦我们把内层的 `block-start` /
 * 文本增量 / `usage` 透传给外层，就不能再静默换到下一个条目重来 —— 新条目会从
 * `block-start(0)` 重新开始，外层装配器会看到「重复的 block-start index 0」；
 * `usage` 同理（宿主 `llm-invariant` 明确禁止一条流里出现两次 usage）。故只要
 * 透传过任何非终止 chunk，后续失败一律**透传**，交由官方重试在**新一轮**请求上
 * 从新队首继续。
 *
 * @module dsh-account-hub/auto-route-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  AUTO_ROUTE_ENTRY_UNRESOLVED_CODE,
  AUTO_ROUTE_EXHAUSTED_CODE,
  AUTO_ROUTE_INCOMPLETE_CODE,
  AUTO_ROUTE_PROVIDER_ID,
  AUTO_ROUTE_UNKNOWN_MODEL_CODE,
  autoRouteConfigFacts,
  autoRouteEntryCount,
  autoRouteEntryUnresolvedMessage,
  autoRouteExhaustedMessage,
  autoRouteHead,
  autoRouteIncompleteMessage,
  autoRouteUnknownModelMessage,
  createAutoRouteRuntime,
  demoteAutoRouteHead,
  rewriteMessagesForTarget,
  type AutoRouteConfig,
  type AutoRouteDefinition,
  type AutoRouteEntry,
  type AutoRouteRuntime,
} from './auto-route.js'

/**
 * 本路由声明的可重试码：**宿主默认集合的原样镜像**（`dsh-llm` 的
 * `DEFAULT_RETRYABLE_CODES`），两个自动路由自有码都不在其中。
 *
 * ## 为什么明明「默认就不可重试」还要显式声明
 *
 * 实测（本仓依赖 `dsh-llm@0.1.2-rc.1`，见 `tests/unit/auto-route-adapter.spec.ts`
 * 的实测用例）默认策略是
 * `{mode:'normal', maxRetries:5, retryableCodes:[EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT]}`，
 * {@link AUTO_ROUTE_EXHAUSTED_CODE} 不在其中 ⇒ 官方重试**不会**把「一轮全失败」
 * 放大成五轮。但那是**别人的缺省值**，而「全部不可用最多一次到达用户」是本功能的
 * 语义要求，不能建立在别人默认值恰好合适这个巧合上 —— 显式写死这五个码，语义
 * 就钉在我们自己这边。
 *
 * ## 为什么不是 `maxRetries: 0`
 *
 * 那条会把**透传**上来的失败也一并掐掉重试。透传那条路径（已出 chunk 后失败）
 * 是刻意留给官方重试的：已产出的内容不可回退，但让 loop 在**新一轮**请求上从新
 * 队首继续，用户只看到一条正常重试 —— 这正是「已出字不硬换」的落地方式。
 */
const AUTO_ROUTE_RETRYABLE_CODES: readonly string[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * 本路由的重试策略（模块级只解析一次，注册时被宿主快照捕获）。
 *
 * `resolveRetryPolicy` 会做完整校验并冻结结果，故这里不手写对象字面量 ——
 * 手写会绕过「initialDelayMs ≤ maxDelayMs」这类不变量。
 */
const AUTO_ROUTE_RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(
  { mode: 'normal', retryableCodes: [...AUTO_ROUTE_RETRYABLE_CODES] },
  'dsh-account-hub: auto-route retryPolicy',
)

/** 虚拟 provider 在模型选择器里的展示名。 */
const AUTO_ROUTE_DISPLAY_NAME = '自动路由'

export interface AutoRouteAdapterOptions {
  /**
   * 宿主上下文：适配器只用到 `ctx.llm`（重入 `stream` 与 `resolveModelInfo`）。
   *
   * 刻意收 `ctx` 而不是两个函数：重入的通路必须是**同一个 `LlmRuntime` 实例**，
   * 否则「转发」会打到另一个注册表上（拿到的适配器、重试策略与目录全都不是同一份）。
   */
  ctx: Context
  /**
   * 读取**当前**自动路由配置（同步、永不抛错）。
   *
   * 由 `src/index.ts` 传 `() => pool.autoRouteConfig()`。适配器**不缓存**它的返回值：
   * `listModels` / `resolveModel` 每次都现读，模型目录与定义因此永远与池一致，
   * 不需要任何「重建适配器」的时机配合。
   */
  config: () => AutoRouteConfig
}

/**
 * 聚合路由适配器。
 *
 * 两套状态，各有明确的所有者：
 * - **配置读路径**（`listModels` / `resolveModel`）永远现读 {@link AutoRouteAdapterOptions.config}，
 *   不做缓存 —— 用户改了自动模型，下一轮目录刷新就该看到，不存在「忘了重建」的窗口。
 * - **降级运行时**（{@link AutoRouteRuntime}）是本适配器独有的**进程内轮转偏移**，
 *   只能由 {@link applyConfig} 重建（配置变更 = 队列归位）。
 */
export class AutoRouteAdapter extends LlmAdapter {
  private runtime: AutoRouteRuntime
  /** 上一次 `applyConfig` 收到的配置指纹（内容幂等门的依据）。 */
  private appliedFacts: string

  constructor(private readonly options: AutoRouteAdapterOptions) {
    super()
    const config = options.config()
    this.runtime = createAutoRouteRuntime(config.models)
    this.appliedFacts = autoRouteConfigFacts(config)
  }

  /**
   * 把当前配置应用到运行时（**内容幂等**：内容没变就什么都不做）。
   *
   * ## 为什么重建条件是「内容」而不是「定义 id 集合」
   *
   * 定义 id 集合不变、只改 `entries`（加一条候选 / 换 provider / 调顺序）是界面上
   * **最常见**的编辑。若重建只看 id 集合，这类编辑之后运行时仍握着旧条目：新加的
   * 候选永远轮不到，删掉的候选还会继续被使用 —— 而且没有任何报错。故这里比对整份
   * 配置的内容指纹，任何内容变化都重建（= 用户新排的顺序立即成为权威顺序）。
   *
   * 调用方（`ensureAutoRouteRegistration`）可以**无条件**调用本方法：幂等门在这里，
   * 不在调用方 —— 「配置变没变」只应该有一个判据。
   */
  applyConfig(config: AutoRouteConfig): void {
    const next = autoRouteConfigFacts(config)
    if (next === this.appliedFacts) return
    this.appliedFacts = next
    this.runtime = createAutoRouteRuntime(config.models)
  }

  /** 当前配置里的定义表（按定义 id 索引）—— 每次现读，供 `resolveModel` 用。 */
  private definitionOf(modelId: string): AutoRouteDefinition | undefined {
    return this.options.config().models.find((definition) => definition.id === modelId)
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: AUTO_ROUTE_DISPLAY_NAME }
  }

  /**
   * 本路由的重试策略。
   *
   * 宿主在**注册时**把它快照进注册表（`prepareRoutes`），故这里只需返回同一份
   * 冻结策略；返回 `undefined` 会让宿主落到它的默认策略，而「两个自有错误码都
   * 不在默认集合里」这件事就会变成一条依赖外部默认值的隐式假设。
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return AUTO_ROUTE_RETRY_POLICY
  }

  /**
   * 模型目录 = 用户定义的自动模型列表。
   *
   * - **总开关关着 → `[]`**：与七个真实 provider 的目录门控同一手段（DSH 的
   *   `buildModelCatalog` 会 `.filter(group => group.models.length > 0)`，空数组
   *   即整个分组消失）。关掉开关却还在下拉里留一组点了必然失败的模型，是最糟的
   *   形态。
   * - 能力（上下文窗口 / 思考档 / 模态）**不在这里声明**：`LlmModelInfo` 本来
   *   就没有这些字段，它们由 {@link resolveModel} 按队首条目现算。这里刻意只给
   *   `{provider, id, name}` —— 多塞字段会在宿主 `listModels` 那一层被静默丢掉
   *   （它只重建这四个字段），不如不写。
   */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.config()
    if (!config.enabled) return []
    return config.models.map((definition) => ({
      provider,
      id: definition.id,
      name: definition.name,
    }))
  }

  /**
   * 精确模型能力 = **队首条目目标能力** + 本自动模型的 id / 名称。
   *
   * ## 为什么 `provider` / `id` 必须改写成 `auto-route` / `definition.id`
   *
   * 宿主 `normalizeModelInfo` 会硬校验 `resolved.provider === 路由名` 且
   * `resolved.id === 请求的模型名`，不符即抛 `INVALID_MODEL_INFO` —— 整轮对话起不来。
   * 故目标能力**原样透传**，身份三元组必须换成本路由的。
   *
   * ## 两处刻意的「不编造」
   *
   * 1. **目标没有 `reasoning` 就不声明它**。凭空造一个空档位表会让宿主
   *    `normalizeModelInfo` 抛 `INVALID_MODEL_REASONING`（空 efforts 非法）。
   * 2. **`entry.effort` 不在目标档位表里时，不把它塞进 `defaultEffort`**。
   *    宿主的校验会抛 `INVALID_MODEL_REASONING`（未知 defaultEffort），于是整个
   *    模型变成「目录里点一下就报错」。让它**留空**、由运行时降级兜底才对：请求真的
   *    打到那个条目时，内层会以 `UNSUPPORTED_REASONING_EFFORT` 失败，本适配器据此
   *    静默换下一个候选（这正是「档位不匹配」该有的表现）。
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const definition = this.definitionOf(model)
    if (definition === undefined) {
      throw new LlmError(autoRouteUnknownModelMessage(model), AUTO_ROUTE_UNKNOWN_MODEL_CODE)
    }
    const entry = autoRouteHead(this.runtime, definition.id)
    if (entry === null) {
      throw new LlmError(autoRouteExhaustedMessage(definition.name), AUTO_ROUTE_EXHAUSTED_CODE)
    }
    let target: LlmResolvedModelInfo
    try {
      target = await this.options.ctx.llm.resolveModelInfo(entry.provider, entry.model, signal)
    } catch (error) {
      // 目标 provider 未注册 / 目标模型不存在：包成中文并**保留原错误链**（cause），
      // 否则用户看到的是一句 `no adapter registered for provider "x"`，与自动路由
      // 的配置动作对不上号。
      //
      // ⚠️ 错误码用**条目解析失败**那个，不用 `AUTO_ROUTE_UNKNOWN_MODEL_CODE`：
      // 后者是「定义 id 找不到」的目录漂移信号，它给用户的动作是「刷新 DSH 模型
      // 目录」—— 而目录刷新对「provider 没注册」毫无作用，复用会把排查方向带偏。
      // 两种故障的判别与用户动作都不同，见 `src/auto-route.ts` 的码表。
      throw new LlmError(
        autoRouteEntryUnresolvedMessage(
          definition.name,
          entry.provider,
          entry.model,
          error instanceof Error ? error.message : String(error),
        ),
        AUTO_ROUTE_ENTRY_UNRESOLVED_CODE,
        { cause: error },
      )
    }
    return mergeResolvedModel(target, definition, entry)
  }

  /**
   * 兼容旧版 `dsh-llm` 的 `prepareCall` shim（与其余五个适配器同款）。
   *
   * 宿主新版基类已提供该方法；旧副本（0.1.0-rc.6）没有，缺了它每轮请求开头会以
   * `registration.adapter.prepareCall is not a function` 崩。这里把「能力解析」与
   * 「分发」绑定到同一个适配器实例，语义与基类默认实现一致。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 一次请求：按队首条目转发，失败即降级，满一圈才报「全部条目不可用」。
   *
   * 逐条语义见模块头。三个**不变量**在这里落地：
   * 1. **单次请求最多试 N 次**（N = 条目数）：`demotions` 计数是本适配器唯一的
   *    请求内状态，引擎本身不计数（见 `src/auto-route.ts` 的语义说明）。
   * 2. **`aborted` 绝不降级**：用户取消不是候选不可用，换一个 provider 继续跑
   *    等于无视取消。
   * 3. **透传过的流不换条目**：见模块头对 `emitted` 的说明。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const definition = this.definitionOf(options.model)
    if (definition === undefined) {
      throw new LlmError(autoRouteUnknownModelMessage(options.model), AUTO_ROUTE_UNKNOWN_MODEL_CODE)
    }
    const maxDemotions = autoRouteEntryCount(this.runtime, definition.id)
    let demotions = 0
    // 带标签的 while：`continue candidates` = 「换下一个候选」，它必须能从 for-await
    // **内部**直接跳出去（降级发生在读到失败 chunk 的那一刻）。改用 `break` + 外部
    // 标志位分辨「换候选」还是「已结束」，是这类循环最经典的静默错法 —— 标志位一写漏，
    // 降级就退化成「静默返回空流」。
    candidates: while (demotions < maxDemotions) {
      const entry = autoRouteHead(this.runtime, definition.id)
      // 队首为 null = 该定义没有任何候选（未经 sanitize 的手工定义才会出现）。
      if (entry === null) break
      const forwarded = forwardOptions(options, entry)
      let emitted = false
      for await (const chunk of this.options.ctx.llm.stream(forwarded)) {
        if (chunk.type !== 'finish') {
          // ⚠️ 任何非终止 chunk 都算「已透传」（含 `usage` 与 `block-start`），
          // 判据刻意比「已出字」更严：见模块头对宿主流语法的说明。
          emitted = true
          yield chunk
          continue
        }
        const reason = chunk.reason
        if (reason.kind !== 'error') {
          // 两条都是「原样透传、绝不降级」，故**刻意合成一个分支**：
          // - `stop` / `tool-calls` / `max-tokens`：正常终止；
          // - `aborted`：**用户取消**。取消不是「候选不可用」——换一个 provider 继续
          //   跑等于无视用户的取消动作（也违背 `options.signal` 的语义）。
          //
          // 分成两个 `if` 只会多一处「改了其中一个忘了另一个」的漂移点，而这两条恰好
          // 是「取消被误当失败」这类缺陷的唯一发生地。
          yield chunk
          return
        }
        // 失败：无论哪种处置，先把失败条目排到队尾 —— 下一次请求（含官方重试）
        // 都从**新的**队首开始，这是「跨请求持续降级」的落地处。
        demoteAutoRouteHead(this.runtime, definition.id)
        if (emitted) {
          // 已透传过内容：不硬换（换了会污染外层流语法），透传失败让 loop 走
          // 官方的 `agent/request-error` 重试 —— 用户只看到一条正常重试。
          yield chunk
          return
        }
        // 一个 chunk 都还没透传：静默吞掉这个 finish，换下一个候选，DSH 无感。
        demotions += 1
        continue candidates
      }
      // 内层流**没有**终止 chunk 就结束了（违反适配器契约，宿主 `llm-invariant`
      // 会先报出来）。这里仍然按失败处置，绝不让它悄悄变成「成功但空回答」。
      demoteAutoRouteHead(this.runtime, definition.id)
      if (!emitted) {
        // 一个 chunk 都没透传：静默换下一个候选。
        demotions += 1
        continue
      }
      // 已经透传过内容 ⇒ 不能换条目重来（外层流语法不允许），但**也绝不能**就这么
      // 静静地结束：外层装配器会把「无终止 chunk」当成一次正常完成，用户拿到的是
      // 一个没有解释的空白回答。故自己补一个 error finish，把控制权交给 loop 既有的
      // 失败路径。
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: autoRouteIncompleteMessage(definition.name, entry.provider, entry.model),
            code: AUTO_ROUTE_INCOMPLETE_CODE,
          },
        },
      }
      return
    }
    throw new LlmError(autoRouteExhaustedMessage(definition.name), AUTO_ROUTE_EXHAUSTED_CODE)
  }
}

/**
 * 构造转发请求：**目标 provider + 目标模型 + 重写后的历史消息**。
 *
 * ## 逐字段语义
 *
 * - `provider` / `model`：换成队首条目的目标。
 * - `reasoningEffort`：条目**配了**档位就用条目的（自动模型 = provider + model +
 *   effort 的打包语义）；**没配**就原样透传用户实时选择的那一档（`...options` 已经
 *   带着它，故这里连键都不写 —— 写一个 `undefined` 会覆盖掉调用方给的值）。
 * - `messages`：必须走 {@link rewriteMessagesForTarget}（replayState 归属检查，
 *   见那里的说明）。请求对象与其 `messages` 都是**深冻结**的，故这里 `map` 出新
 *   数组、浅拷贝出新对象，绝不原地改。
 */
function forwardOptions(options: GenerateOptions, entry: AutoRouteEntry): GenerateOptions {
  return {
    ...options,
    provider: entry.provider,
    model: entry.model,
    messages: rewriteMessagesForTarget(options.messages, entry.provider),
    ...entry.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(entry.effort) },
  }
}

/**
 * 把目标能力合并成「本自动模型」的能力声明。
 *
 * 独立成函数是为了让 `resolveModel` 只读一遍：合并规则（尤其是
 * `defaultEffort` 的两条不编造）集中在一处，加字段时不会漏改某一条分支。
 */
function mergeResolvedModel(
  target: LlmResolvedModelInfo,
  definition: AutoRouteDefinition,
  entry: AutoRouteEntry,
): LlmResolvedModelInfo {
  const reasoning = target.reasoning
  // 目标模型没有思考档 → 不声明 reasoning（凭空造空档位表会被宿主判非法）。
  const mergedReasoning = reasoning === undefined ? undefined : mergedReasoningInfo(reasoning, entry)
  return {
    ...target,
    provider: AUTO_ROUTE_PROVIDER_ID,
    id: definition.id,
    name: definition.name,
    ...mergedReasoning === undefined ? {} : { reasoning: mergedReasoning },
  }
}

/**
 * 合并思考档位：**档位表原样透传**，默认档按「条目优先、目标兜底」取。
 *
 * 条目档位**只有落在目标档位表里**才作为默认档透出：否则宿主的
 * `normalizeModelInfo` 会以「未知 defaultEffort」抛 `INVALID_MODEL_REASONING`，
 * 模型直接不可用。落不进去时**退回目标自己的默认档**（而不是留空）—— 留空会让
 * 宿主的 `resolveCallWithInfo` 不再补档，deepseek 系「不带档位 = 不思考」的行为
 * 就会因为用户配了一个无效档位而静默改变。
 */
function mergedReasoningInfo(
  reasoning: NonNullable<LlmResolvedModelInfo['reasoning']>,
  entry: AutoRouteEntry,
): NonNullable<LlmResolvedModelInfo['reasoning']> {
  const preferred = entry.effort !== undefined
    && reasoning.efforts.some((effort) => effort.id === entry.effort)
    ? ReasoningEffortId(entry.effort)
    : undefined
  const defaultEffort = preferred ?? reasoning.defaultEffort
  return {
    efforts: reasoning.efforts,
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/**
 * 在 `ctx.llm` 上注册自动路由的虚拟 provider 路由。
 *
 * ## 为什么**不**登记进「可配置 provider 目录」
 *
 * 其余七个 `register*Llm` 都会调 `registerConfigurableProviders`，因为它们的配置面
 * 就是模型设置页（要一个 `settingsNs` 与一个可填的 API key）。自动路由两样都没有：
 * 它的配置面是 Account Hub 面板（`autoroute.get` / `autoroute.set`），且它自己不
 * 持有任何凭据 —— 凭据属于被转发的那些真实 provider。
 *
 * 登记进去的代价是具体的：设置页会多出一行「自动路由」，带一个永远用不上的
 * `AUTO_ROUTE_API_KEY` 输入框，还会要求一个真实存在的 `settingsNs`（不存在就是
 * `deriveKeyRef` 那条崩溃路径）。不登记时它只是作为「已注册但未声明」的路由出现，
 * 不索取任何配置。
 *
 * ## 为什么返回 handle
 *
 * 调用方（`src/index.ts`）要按总开关**休眠/唤醒**这条路由（`handle.replace([])` /
 * `replace([AUTO_ROUTE_PROVIDER_ID])`）。返回裸适配器会让调用方只能自己再调一次
 * `registerAdapter` —— 那第二次调用会因为「路由已被本适配器占用」而抛
 * `DUPLICATE_ADAPTER`。
 *
 * @returns 注册 handle 与适配器实例。
 */
export function registerAutoRouteLlm(
  ctx: Context,
  options: AutoRouteAdapterOptions,
): { handle: AdapterRegistrationHandle; adapter: AutoRouteAdapter } {
  const adapter = new AutoRouteAdapter(options)
  const handle = ctx.llm.registerAdapter([AUTO_ROUTE_PROVIDER_ID], adapter)
  return { handle, adapter }
}

/**
 * 造一个「读配置 → 注册/唤醒/休眠 → 运行时归位」的刷新函数。
 *
 * ## 为什么这段生命周期是**本模块的导出**，而不是 `src/index.ts` 里的一段闭包
 *
 * 它有三条容易写错、且写错后完全静默的判据（内容幂等门、空路由集休眠、首次注册
 * 与唤醒的分工）。放在 `apply()` 的闭包里意味着**只有一条巨型接线路径能覆盖它**，
 * 单测无从下手；而这三条恰恰是「关掉开关后 provider 仍在列表里」「改了候选顺序
 * 运行时不动」这类缺陷的唯一发生地。故整段搬到这里，`src/index.ts` 只负责传
 * `() => pool.autoRouteConfig()`。
 *
 * ## 调用方**可以无条件反复调用**返回值
 *
 * 幂等门在这里，不在调用方 —— 「配置变没变」只应该有一个判据。启动一次、每次
 * `autoroute.set` 一次，多余的调用是零副作用的。
 *
 * ## 语义
 *
 * - **内容没变**（`autoRouteConfigFacts` 相同）且已注册过 → 立即返回，**一次
 *   `replace` 都不发**（`replace` 会发 `llm/adapters-updated`，无谓的通知会让
 *   订阅者白重算目录）。
 * - **首次**：即使总开关关着也要注册（否则打开开关时没有 handle 可 replace），
 *   注册后按开关调整路由集。
 * - **开关**落在**路由集**上：关着 = `replace([])`（零路由，provider 从 DSH 的
 *   `listProviders()` 与模型目录里一并消失），开着 = `replace([auto-route])`。
 *   `replace([])` 是宿主契约明确允许的形态（「空数组合法，与空的首次注册不同」）。
 * - **内容变了**（含只改 `entries`）→ `applyConfig` 重建运行时（队列归位）。
 *
 * ## 失败处置：抛出去，由调用方决定
 *
 * 本函数**不吞异常**。两个调用点各自处置：启动链记日志（功能本次不可用），RPC 的
 * `autoroute.set` 侧也记日志（配置已写入，运行时下一轮自愈）。在这里吞掉会让
 * 「为什么没生效」失去唯一的可观测点。
 *
 * @returns 幂等的刷新函数（可反复调用）。
 */
export function createAutoRouteRegistration(
  ctx: Context,
  config: () => AutoRouteConfig,
): () => void {
  let handle: AdapterRegistrationHandle | undefined
  let adapter: AutoRouteAdapter | undefined
  let appliedFacts: string | undefined
  /** 当前路由集是否已按开关置位（避免内容变化时白发一次 `replace`）。 */
  let routed = false
  return () => {
    const current = config()
    const facts = autoRouteConfigFacts(current)
    if (facts === appliedFacts && handle !== undefined) return
    if (handle === undefined) {
      const registered = registerAutoRouteLlm(ctx, { ctx, config })
      adapter = registered.adapter
      handle = registered.handle
    }
    adapter?.applyConfig(current)
    // 只在**开关状态真的变了**时才动路由集：`replace` 会发 `llm/adapters-updated`，
    // 每次改候选都白发一次会让订阅者白重算一遍模型目录。首次必须置位（`routed`
    // 初值 false 与「关着」不同 —— 关着时注册出来的路由集是非空的，必须摘掉）。
    if (current.enabled !== routed || appliedFacts === undefined) {
      handle.replace(current.enabled ? [AUTO_ROUTE_PROVIDER_ID] : [])
      routed = current.enabled
    }
    appliedFacts = facts
  }
}
