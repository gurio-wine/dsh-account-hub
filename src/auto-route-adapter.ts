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
 * ## 伪装运输层：只包「消费」，且只在真有载荷时才包
 *
 * 转发出去的流由 `account-hub-masquerade-transport` 的 `fetch` 包装器负责把三个头写到
 * 真实请求上，而它读的是 `AsyncLocalStorage` 里的当前载荷。本文件负责**把载荷放进去**，
 * 纪律有两条，都不是风格问题：
 *
 * 1. **ALS 必须包「消费」而不是「创建」**：`this.options.ctx.llm.stream(forwarded)`
 *    只是造了个异步生成器对象，一个字节都还没跑；生成器的函数体是在**恢复它的那次
 *    `.next()`** 的上下文里执行的。故上下文必须加在 `for await` 这一侧（见
 *    {@link withMasqueradeAsyncIterable} 对三个迭代方法的处理），加在创建点等于什么都没包
 *    —— 且不会报任何错，只会「伪装整段静默失效」。
 * 2. **默认路径一个字节都不动**：载荷为 `undefined`（三个字段归一后全空）时既不装
 *    `fetch` 包装器、也不套 ALS 代理，`consumed` 就是内层流本身。包装器即使在零载荷时
 *    只是纯转发，装它也会改变**所有**出站请求的调用栈形态，而 `globalThis.fetch` 是
 *    全进程共享的 —— 别的插件也看得见。
 *
 * 载荷与 `forwarded` 上那三个载体字段（`accountHubUserAgent` / `accountHubOriginator` /
 * `accountHubMasquerade`）**必须同源**：都由同一条 entry 现算，见
 * {@link masqueradePayloadOf}。
 *
 * @module dsh-account-hub/auto-route-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
// 两条头覆写通道 + windowId 通道：既要它们的**类型**（形状，字段本体由 forwardOptions
// 写入、由内层适配器读取），也要它们的**归一化函数** —— 伪装载荷与转发载体必须同源，
// 而「值是否合法」的唯一判据在那三个模块里（见 `masqueradePayloadOf`）。
import { normalizeAccountHubOriginator, type AccountHubOriginatorCarrier } from './account-hub-originator.js'
import { normalizeAccountHubUserAgent, type AccountHubUserAgentCarrier } from './account-hub-user-agent.js'
import { normalizeAccountHubWindowId } from './account-hub-window-id.js'
// 伪装**运输层**：`ensureMasqueradeFetch` 装出站包装器（幂等），
// `withMasqueradeAsyncIterable` 把「消费一路流」整段放进载荷上下文里。
import {
  ensureMasqueradeFetch,
  withMasqueradeAsyncIterable,
  type MasqueradePayload,
} from './account-hub-masquerade-transport.js'
import type {
  AdapterRegistrationHandle,
  GenerateOptions,
  LlmCallConfig,
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
  type AccountHubMasqueradeCarrier,
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
   *   就没有这些字段，它们由 {@link resolveModel} 按**当前队首条目**现算（含思考档），
   *   随运行时降级队列的变化而变化。这里刻意只给
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
   * 精确模型能力 = **当前队首条目的目标能力** + 本自动模型的 id / 名称。
   *
   * ## 为什么 `provider` / `id` 必须改写成 `auto-route` / `definition.id`
   *
   * 宿主 `normalizeModelInfo` 会硬校验 `resolved.provider === 路由名` 且
   * `resolved.id === 请求的模型名`，不符即抛 `INVALID_MODEL_INFO` —— 整轮对话起不来。
   * 故目标能力按当前队首条目透传，身份三元组必须换成本路由的。
   *
   * ## reasoning 的动态聚合
   *
   * `reasoning` 只来自当前队首条目解析出的目标 provider/model；目标没有有效的
   * `efforts` 时不声明。`entry.effort` 是聚合模型 `defaultEffort` 的来源，也是在调用方
   * 未显式选择档位或其选择不被当前目标接受时的回落值：命中目标 `efforts` 时用作聚合
   * 模型的默认档，非法时回退目标自身的有效 `defaultEffort`，两者都无效则省略默认值。
   * 因此能力声明随队首动态变化；实际转发仍由 {@link forwardOptions} 按调用方优先、
   * 条目回落的语义处理。
   *
   * 这里不复制 provider 名单，也不把非法条目档位伪装成能力；当前队首若因降级
   * 变化，下一次 `resolveModel` 会重新读取对应目标能力。
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
      // 这是能力预检，不是一次额外的路由解析：entry.effort 或调用方档位任一存在时，
      // 都要按这一轮的当前队首目标校验。预检失败时保留调用方显式档位（缺省时才回落条目档位），
      // 让真实目标 `ctx.llm.stream()` 继续产生原有的失败 chunk，降级拓扑不变。预检成功后，
      // `forwardOptions` 只转发当前目标支持的调用方档位或条目回落档位，否则不带该键。
      let targetCapability: TargetCapabilityProbe | undefined
      if (entry.effort !== undefined || options.reasoningEffort !== undefined) {
        try {
          targetCapability = {
            status: 'resolved',
            info: await this.options.ctx.llm.resolveModelInfo(entry.provider, entry.model, options.signal),
          }
        } catch {
          targetCapability = { status: 'failed' }
          // 查询失败不改变降级拓扑；真实转发负责暴露错误。
        }
      }
      const forwarded = forwardOptions(options, entry, targetCapability)
      // 伪装运输层：载荷**与 forwarded 上那三个载体字段同源** —— 都由这一条 entry
      // 归一化而来（三者全空 ⇒ `undefined` ⇒ 整条伪装路径不走，见
      // {@link masqueradePayloadOf}）。
      const masquerade = masqueradePayloadOf(entry)
      // ⚠️ **只有真要伪装时才装包装器**：默认路径下 `globalThis.fetch` 必须与加本功能
      // 之前是**同一个对象**（哪怕包装器在零载荷时只是纯转发，装上它就改变了所有出站
      // 请求的调用栈形态，别的插件也看得见）。
      if (masquerade !== undefined) ensureMasqueradeFetch()
      let emitted = false
      const upstream = this.options.ctx.llm.stream(forwarded)
      // ⚠️ **ALS 必须包「消费」而不是「创建」**：async generator 的函数体是在恢复它的
      // 那次 `.next()` 的上下文里执行的 —— `upstream` 这一句只是造了个生成器对象，
      // 一个字节都还没跑，把载荷上下文加在创建点上等于什么都没包。只有让 `for await`
      // 的每一次 `.next()` 都进上下文，内层适配器**真正发请求那一刻**才看得见载荷。
      //
      // 三条迭代方法都要包（`return()` 负责提前退出时的收尾逻辑，那条路上一样可能发
      // 请求）—— 那是 `withMasqueradeAsyncIterable` 的职责，这里只把它套在对的位置。
      const consumed = masquerade === undefined
        ? upstream
        : withMasqueradeAsyncIterable(masquerade, upstream)
      for await (const chunk of consumed) {
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
          logAutoRouteDemotion(this.options.ctx, definition, entry, reason, {
            branch: '已透传后失败降级',
            emitted: true,
          })
          yield chunk
          return
        }
        // 一个 chunk 都还没透传：静默吞掉这个 finish，换下一个候选，DSH 无感。
        logAutoRouteDemotion(this.options.ctx, definition, entry, reason, {
          branch: '静默降级',
          emitted: false,
        })
        demotions += 1
        continue candidates
      }
      // 内层流**没有**终止 chunk 就结束了（违反适配器契约，宿主 `llm-invariant`
      // 会先报出来）。这里仍然按失败处置，绝不让它悄悄变成「成功但空回答」。
      demoteAutoRouteHead(this.runtime, definition.id)
      if (!emitted) {
        // 一个 chunk 都没透传：静默换下一个候选。
        logAutoRouteDemotion(this.options.ctx, definition, entry, null, {
          branch: '静默降级',
          emitted: false,
        })
        demotions += 1
        continue
      }
      // 已经透传过内容 ⇒ 不能换条目重来（外层流语法不允许），但**也绝不能**就这么
      // 静静地结束：外层装配器会把「无终止 chunk」当成一次正常完成，用户拿到的是
      // 一个没有解释的空白回答。故自己补一个 error finish，把控制权交给 loop 既有的
      // 失败路径。
      const incompleteMessage = autoRouteIncompleteMessage(definition.name, entry.provider, entry.model)
      logAutoRouteDemotion(this.options.ctx, definition, entry, {
        kind: 'error',
        failure: {
          message: incompleteMessage,
          code: AUTO_ROUTE_INCOMPLETE_CODE,
        },
      }, {
        branch: '已透传后流提前结束',
        emitted: true,
      })
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: incompleteMessage,
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
 * - `reasoningEffort`：目标能力预检成功时，先转发目标支持的调用方显式档位；调用方缺省
 *   或其档位不被当前目标接受时，回落到目标支持的条目档位；两者都不受支持时不带该键，
 *   由目标 provider 物化自身默认。目标能力预检不可用时，调用方显式档位原样优先转发，
 *   调用方缺省时才转发条目档位，二者皆缺省则不带该键。真实请求路径会在有任一档位时
 *   先尝试预检；预检不可用时不验证调用方或条目档位，潜在非法值交由目标宿主校验并走既有
 *   错误 / 降级处置。直接调用适配器没有预检时遵循同一分支，保持「调用方优先、条目回落」语义。
 * - `messages`：必须走 {@link rewriteMessagesForTarget}（replayState 归属检查，
 *   见那里的说明）。请求对象与其 `messages` 都是**深冻结**的，故这里 `map` 出新
 *   数组、浅拷贝出新对象，绝不原地改。
 * - `accountHubUserAgent`：条目配了 `userAgent` 就挂上**本插件的内部通道字段**
 *   （{@link AccountHubUserAgentCarrier.accountHubUserAgent}）。出站请求头由内层
 *   适配器自建，聚合层够不着，故只能随 options 带过去、由内层覆写。**没配就一个
 *   键都不挂** —— 与 `reasoningEffort` 同一处置：字段缺席 = 用内层自己的默认 UA，
 *   出站形态与加这条通道之前逐字节一致。
 * - `accountHubOriginator`：与 `accountHubUserAgent` **逐字同款**的另一条内部通道
 *   （{@link AccountHubOriginatorCarrier.accountHubOriginator}），缺省同样一个键都
 *   不挂。两条通道的差别只在内层怎么用它：UA 是**换掉一个既有头**，Originator 是
 *   **新增一个原本不存在的头**；但「聚合层只管把值带过去」这件事完全一样，故这里
 *   两行的写法也必须一样（少一行 = 用户在面板里配了 Originator 却什么都没发生，
 *   且没有任何报错）。
 * - `accountHubMasquerade`：第三条内部通道
 *   （{@link AccountHubMasqueradeCarrier.accountHubMasquerade}），缺省同样一个键都
 *   不挂。它与前两条的**归属相同、消费点不同**：三者都取自**同一条** entry（前两条取
 *   条目上的同名字段，本字段取 `entry.masquerade` 这个对象），但 UA / Originator 由
 *   内层适配器自己的 `send()` 读（七个适配器的 `applyAccountHub*` 调用），而本字段
 *   **在出站路径上没有内层消费者** —— `x-codex-window-id` 由运输层落地：
 *   {@link masqueradePayloadOf} 从同一条 entry 现算载荷，`fetch` 包装器在出网前把它
 *   写进这次请求自己的头。
 *
 *   于是同一次出站请求的身份有**两条到达路径**：载体字段（内层 `send()` 读）与运输层
 *   载荷（`fetch` 包装器读）。两者**必须同源**，都由这一条 entry 归一化而来；分叉等于
 *   同一次请求有两个身份，而上游只看到一个 —— 症状是「面板里配的值」与「实际发出的
 *   值」对不上，且没有任何报错。两层缺一都会「配了却没生效且无报错」，故都必须留。
 *
 *   形态**逐字一致**：条目上的 `masquerade` 与这里的 `accountHubMasquerade` 都是
 *   `{ windowId }`，且载体形状**直接引用** `AutoRouteMasquerade`（见
 *   {@link AccountHubMasqueradeCarrier}）—— 形状一旦分叉不会有任何编译期报错。
 */
type TargetCapabilityProbe =
  | { status: 'resolved'; info: LlmResolvedModelInfo }
  | { status: 'failed' }

function forwardOptions(
  options: GenerateOptions,
  entry: AutoRouteEntry,
  target?: TargetCapabilityProbe,
): GenerateOptions {
  // 有能力预检时只转发当前目标接受的档位：调用方显式选择优先，条目档位作为回落。
  // 预检不可用（包括直调适配器）时无法验证任何一方，调用方显式选择优先原样转发；
  // 调用方缺省才回落到条目值，二者皆缺省则不带档位键。
  const { reasoningEffort: callerEffort, ...optionsWithoutEffort } = options
  let effort: ReasoningEffortId | undefined
  if (target !== undefined && target.status === 'resolved') {
    if (callerEffort !== undefined && reasoningEffortSupported(target.info, callerEffort)) {
      effort = callerEffort
    } else if (entry.effort !== undefined && reasoningEffortSupported(target.info, entry.effort)) {
      effort = ReasoningEffortId(entry.effort)
    }
  } else if (callerEffort !== undefined) {
    effort = callerEffort
  } else if (entry.effort !== undefined) {
    effort = ReasoningEffortId(entry.effort)
  }
  return {
    ...optionsWithoutEffort,
    provider: entry.provider,
    model: entry.model,
    messages: rewriteMessagesForTarget(options.messages, entry.provider),
    ...effort === undefined ? {} : { reasoningEffort: effort },
    ...entry.userAgent === undefined ? {} : { accountHubUserAgent: entry.userAgent },
    ...entry.originator === undefined ? {} : { accountHubOriginator: entry.originator },
    ...entry.masquerade === undefined ? {} : { accountHubMasquerade: entry.masquerade },
  }
}

/** 判断目标当前能力是否确实接受一个条目档位。 */
function reasoningEffortSupported(target: LlmResolvedModelInfo, effort: string): boolean {
  const efforts = target.reasoning?.efforts
  return Array.isArray(efforts) && efforts.some((candidate) => candidate.id === effort)
}

/**
 * 从**同一条**候选条目归一出这次出站的伪装载荷。
 *
 * ## 为什么必须与 {@link forwardOptions} 同源
 *
 * 同一次出站请求的身份现在有**两条**到达路径：三个载体字段（内层适配器自己的
 * `send()` 读，见 {@link AccountHubUserAgentCarrier} 等）与这里这份载荷（供
 * `account-hub-masquerade-transport` 的 `fetch` 包装器在出网前读）。两条路径分叉
 * 就等于同一次请求有两个身份，而上游只会看到一个 —— 排查时「面板里配的值」与
 * 「实际发出的值」对不上，且没有任何报错。故载荷只能由 **entry 这一份数据**现算，
 * 不得另立真相源，也不得从 `forwarded` 里回读（那是本函数的产物，回读会把
 * 「谁先谁后」变成隐式约束）。
 *
 * ## 三个字段全都取归一化结果，且**共用**那三个模块的判据
 *
 * `normalize*` 已经保证「脏值一律当没有、绝不抛错」（配置面到出站面隔着 RPC
 * 反序列化，那里抛错等于把一次配置笔误升级成请求失败）。这里**不再抄一份校验** ——
 * 三处判据一旦分叉，就会出现「配置面接受、出站面拒绝」这类只在特定输入下现形的缺口。
 *
 * ## 三者全空 ⇒ `undefined`（= 整条伪装路径不走）
 *
 * 这是**默认路径逐字节不变**的判据所在：绝大多数条目三个字段都没配，此时本函数
 * 返回 `undefined`，调用方既不装 `fetch` 包装器、也不套 ALS 代理，出站形态与本功能
 * 存在之前完全一致。⚠️ 判据刻意是「归一化后是否**至少有一个**字段」，而不是
 * 「`entry.masquerade` 在不在」—— UA / Originator 单配（没配 windowId）同样是要
 * 伪装的请求，漏掉它们会让那两条既有通道在包装器眼里「没有载荷」，从而在内层
 * 适配器不经过 `send()` 的那些出站路径上掉身份。
 *
 * @returns 至少一个字段可用时的载荷；三者都不可用时 `undefined`。
 */
function masqueradePayloadOf(entry: AutoRouteEntry): MasqueradePayload | undefined {
  const userAgent = normalizeAccountHubUserAgent(entry.userAgent)
  const originator = normalizeAccountHubOriginator(entry.originator)
  const windowId = normalizeAccountHubWindowId(entry.masquerade?.windowId)
  if (userAgent === undefined && originator === undefined && windowId === undefined) return undefined
  // 缺省一个键都不挂（与 {@link forwardOptions} 的载体写法逐字同款）：落一个
  // `undefined` 键会让「载荷有三个字段」与「载荷有一个字段」在下游判别时混同。
  return {
    ...userAgent === undefined ? {} : { userAgent },
    ...originator === undefined ? {} : { originator },
    ...windowId === undefined ? {} : { windowId },
  }
}

/**
 * 把目标能力合并成「本自动模型」的能力声明。
 *
 * `context` / `defaultMaxTokens` 等目标能力原样保留；`reasoning` 也只保留当前
 * 队首目标声明的 `efforts`，不把其他 provider/model 的能力拼进来。目标没有有效
 * 档位表时整块省略 reasoning，避免把空能力误报成可选能力。
 *
 * `entry.effort` 是聚合模型 `defaultEffort` 的来源，也是调用方未显式选择或其档位不被
 * 当前目标接受时的回落值：它命中目标 `efforts` 时作为聚合模型默认档；缺失或非法时
 * 回退目标 resolver 自己的有效 `defaultEffort`，再无有效默认值就省略。构造全新的 reasoning
 * 与返回对象，绝不修改 resolver 所有的 target 或其嵌套的 efforts 数组。
 *
 * 独立成函数是为了让 `resolveModel` 只读一遍：合并规则集中在一处，加字段时不会漏改。
 */
function mergeResolvedModel(
  target: LlmResolvedModelInfo,
  definition: AutoRouteDefinition,
  entry: AutoRouteEntry,
): LlmResolvedModelInfo {
  const { reasoning: targetReasoning, ...targetWithoutReasoning } = target
  const reasoning = mergeReasoning(targetReasoning, entry.effort)
  return {
    ...targetWithoutReasoning,
    ...reasoning === undefined ? {} : { reasoning },
    provider: AUTO_ROUTE_PROVIDER_ID,
    id: definition.id,
    name: definition.name,
  }
}

/**
 * 只把当前目标的 reasoning 能力映射到聚合模型，并按当前条目计算默认档位。
 * 返回新对象，避免修改 `resolveModelInfo` 所有的目标能力对象。
 */
function mergeReasoning(
  target: LlmResolvedModelInfo['reasoning'],
  entryEffort: AutoRouteEntry['effort'],
): LlmResolvedModelInfo['reasoning'] {
  if (target === undefined) return undefined
  const efforts = target.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined

  const { defaultEffort: targetDefaultEffort, ...otherReasoning } = target
  const entryDefaultEffort = entryEffort === undefined
    ? undefined
    : efforts.find((effort) => effort.id === entryEffort)?.id
  const fallbackDefaultEffort = targetDefaultEffort !== undefined
    && efforts.some((effort) => effort.id === targetDefaultEffort)
    ? targetDefaultEffort
    : undefined
  const defaultEffort = entryDefaultEffort ?? fallbackDefaultEffort

  return {
    ...otherReasoning,
    efforts: [...efforts],
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

const AUTO_ROUTE_DEMOTION_LOG_MAX_BYTES = 1024 * 1024
const AUTO_ROUTE_DEMOTION_LOG_RELATIVE_PATH = join('logs', 'dsh-account-hub', 'auto-route-demotion.log')

type AutoRouteLogContext = Context & {
  dshHomePath?: (...segments: string[]) => string
}

const autoRouteDemotionLogDirectoryPromises = new Map<string, Promise<void>>()
const autoRouteDemotionLogWritePromises = new Map<string, Promise<void>>()

function autoRouteDemotionLogPath(ctx: Context): string {
  const resolveHome = (ctx as AutoRouteLogContext).dshHomePath
  const home = typeof resolveHome === 'function'
    ? resolveHome()
    : process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, AUTO_ROUTE_DEMOTION_LOG_RELATIVE_PATH)
}

function ensureAutoRouteDemotionLogDirectory(logPath: string): Promise<void> {
  const directory = dirname(logPath)
  const existing = autoRouteDemotionLogDirectoryPromises.get(directory)
  if (existing !== undefined) return existing
  const promise = mkdir(directory, { recursive: true }).then(() => undefined)
  autoRouteDemotionLogDirectoryPromises.set(directory, promise)
  return promise
}

/** 文件通道只做诊断：任何路径/目录/轮转/追加错误都不能影响路由。 */
export function writeAutoRouteDemotionLog(ctx: Context, details: string): void {
  let logPath: string
  try {
    logPath = autoRouteDemotionLogPath(ctx)
    const previous = autoRouteDemotionLogWritePromises.get(logPath) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await ensureAutoRouteDemotionLogDirectory(logPath)
        let existingSize = 0
        try {
          existingSize = (await stat(logPath)).size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
        }
        if (existingSize > AUTO_ROUTE_DEMOTION_LOG_MAX_BYTES) {
          const backupPath = `${logPath}.1`
          try {
            await unlink(backupPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await rename(logPath, backupPath)
        }
        return appendFile(
          logPath,
          `${new Date().toISOString()} [auto-route] ${details}\n`,
          'utf8',
        ).then(() => undefined)
      })
    autoRouteDemotionLogWritePromises.set(logPath, next)
    void next.catch(() => {})
  } catch {
    // 解析 DSH 根或排队时的同步异常同样只能静默跳过。
  }
}

/** 仅供单测等待 fire-and-forget 文件写入收口；生产路径绝不调用。 */
export async function flushAutoRouteDemotionLogWrites(): Promise<void> {
  await Promise.allSettled([...autoRouteDemotionLogWritePromises.values()])
}

/** 记录队列轮转原因；所有分支共用同一条 warn + 文件日志管道。 */
function logAutoRouteDemotion(
  ctx: Context,
  definition: AutoRouteDefinition,
  entry: AutoRouteEntry,
  reason: Extract<StreamChunk, { type: 'finish' }>['reason'] | null,
  outcome: { branch: string; emitted: boolean },
): void {
  const finishKind = reason?.kind ?? '无终止 chunk'
  const failure = reason?.kind === 'error' ? reason.failure : undefined
  const details = [
    outcome.branch,
    `emitted=${outcome.emitted}`,
    `聚合模型 ${AUTO_ROUTE_PROVIDER_ID}/${definition.id}（${definition.name}）`,
    `候选 ${entry.provider}/${entry.model}`,
    `finish=${finishKind}`,
    ...(failure === undefined ? [] : [
      `code=${failure.code ?? '未知'}`,
      `message=${failure.message}`,
    ]),
    ...entry.userAgent === undefined ? [] : [`userAgent=${entry.userAgent}`],
    ...entry.originator === undefined ? [] : [`originator=${entry.originator}`],
    ...entry.masquerade?.windowId === undefined ? [] : [`masquerade.windowId=${entry.masquerade.windowId}`],
  ]
  const message = details.join('；')
  try {
    const logger = ctx.logger
    if (typeof logger?.warn === 'function') logger.warn(`[auto-route] ${message}`)
  } catch {
    // 日志后端异常不得改变候选轮转、吞错或 exhaust 行为。
  }
  writeAutoRouteDemotionLog(ctx, message)
}

/**
 * 在 `agent/request` 瀑布流上兜底校验打到聚合模型的 `reasoningEffort`。
 *
 * ## 为什么需要它（宿主在**到达适配器之前**就校验）
 *
 * 聚合模型现在按当前队首目标声明 `reasoning.efforts`（见
 * {@link AutoRouteAdapter.resolveModel}），而宿主的 `resolveCallWithInfo` 会对请求档位
 * 做硬校验。监听器必须以**同一份当前能力**为准：仍合法的用户选择不能被抹掉，失配的
 * 历史残留或过期值才需要止损剥除：
 *
 * ```text
 * reasoning === undefined && requested !== undefined → UNSUPPORTED_REASONING_EFFORT
 * ```
 *
 * 实测（`dsh-llm@0.1.2-rc.1`，真实 `LlmRuntime`）它发生在适配器 `stream()` **之前**
 * —— 那条路径上 `adapter.stream()` 的调用数是 0。真实 agent 路径更早：
 * `agent-loop/agent.ts` 的 `llm.prepareCall()` 内部就抛，而其 catch 只放行
 * `NO_ADAPTER`，其余 rethrow ⇒ **整轮直接死**。
 *
 * ## 谁会带着档位打过来
 *
 * 一部分请求来自升级前用过自动路由、并在会话侧显式选过档位的历史会话：档位被持久化在
 * `model/selection` 或 request header 的 `config.reasoningEffort` 上，恢复时由
 * `agent.ts` 的 `persistedReasoningEffort` 还原。也可能是当前聚合能力中仍合法的选择，
 * 因此不能再按 provider 直接无条件删除；只对当前 `resolveModelInfo` 仍不接受的值止损。
 *
 * ## 为什么挂在这里，而不是适配器 `stream()` 入口
 *
 * 适配器入口的**无条件剥键**不能替代这里的宿主校验前处理：档位校验在
 * `resolveCallWithInfo`（`dsh-llm/lib/index.js`），发生在适配器真正 dispatch 之前；
 * `agent/request` 是唯一能在校验前修正会话配置的挂点。真实 `AutoRouteAdapter.stream()`
 * 仍会在已经进入适配器的请求上做当前目标能力预检，但那是另一条更晚的转发保护，不能
 * 修复宿主校验前的会话残留，也不能替代直接调适配器所依赖的 `forwardOptions` 兼容语义。
 *
 * 直接调适配器的场景（测试、未来的外部调用方）不经过这里，且依赖 `forwardOptions`
 * 在条目缺省档位时保留调用方值。这里不能猜测或反向改写直调路径，其边界仍是
 * `agent/request`。
 *
 * ## 作用域：根级监听器可达，但仍显式带 `{ global: true }`
 *
 * `dsh-scope` 的 `scopeTarget` 让**无 scope 标签的监听器全局放行**（本插件的根级 ctx
 * 无标签），故不带 `global` 实测也收得到。仍然显式写，是因为 cordis 的派发过滤是
 * `hook.global || !filter || filter.call(thisArg, hook.ctx)`（`cordis/lib/index.js:263`）——
 * `global` 是短路项、零成本；而「插件恰好挂在根上」一旦变化（本插件被装进某个 scope），
 * 不带 `global` 的监听器会被静默过滤掉，兜底无声消失，症状却是「历史会话又整轮报错」。
 *
 * ## 覆盖面边界（刻意接受）
 *
 * 它只覆盖 agent 会话路径。`llm.resolveCallConfig` 的直调路径（面板选择、子代理预检等）
 * 是直接方法调用、无事件可挂，仍由宿主按当前聚合能力自行校验；其他插件对
 * `ctx.llm.stream()` 的直调同样绕开这里。直调绕过 agent/request 是本切片的非目标边界，
 * 不猜测私有 API，也不新增反向 RPC。
 *
 * ## 处置：合法保留；明确失配时 warn 一次 + 剥键，未知时保留
 *
 * 能力查询成功且当前 `efforts` 缺失、为空或不包含请求值时，才确认失配并删除该键；
 * 能力查询失败只能说明暂时无法判断，守卫只 warn 并保留用户选择。warn **按定义去重**
 * （同一 provider/model 只报一次），避免历史残留在每一步刷满日志。
 *
 * @param ctx - 宿主上下文（注册 `agent/request` 监听器）。
 * @returns 注销函数。
 */
export function installAutoRouteEffortGuard(ctx: Context): () => void {
  /** 已告警过的 `provider/model`（按定义去重，避免逐步刷屏）。 */
  const warned = new Set<string>()
  // `{ global: true }` 是**显式**的，尽管本插件的根级 ctx 不带 scope 标签、实测不带它
  // 也照样收到 `agent/request`（`dsh-scope` 的 `scopeTarget` 对无标签监听器全局放行）。
  // 写成显式的，是为了不把「插件恰好挂在根上」这件事变成一条**静默失效**的隐式前提：
  // 一旦本插件将来被装进某个 scope，不带 `global` 的监听器会被 cordis 的
  // `hook.global || !filter || filter.call(...)` 过滤掉 —— 兜底静默消失，而症状是
  // 「历史会话又整轮报错了」，极难归因。cordis 里 `global` 是短路项，零成本。
  return ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (resolved.provider !== AUTO_ROUTE_PROVIDER_ID) return resolved
    const effort = resolved.reasoningEffort
    if (effort === undefined) return resolved

    const key = `${resolved.provider}/${resolved.model}`
    const warnOnce = (message: string): void => {
      if (warned.has(key)) return
      warned.add(key)
      ctx.logger?.warn?.(`[account-hub] 自动路由模型 ${key} ${message}`)
    }

    let supported = false
    try {
      const current = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model)
      supported = reasoningEffortSupported(current, effort)
    } catch {
      // 能力解析失败只能说明「无法判断」，不能把未知状态当成明确失配而删除用户选择。
      warnOnce(
        `无法确认会话侧思考档位 "${String(effort)}" 是否受当前队首支持，暂时保留`
        + '（请检查当前队首目标的 reasoning 能力；需要调整默认档位时请在自动路由条目配置）',
      )
      return { ...resolved }
    }
    if (supported) return { ...resolved }

    warnOnce(
      `收到当前能力不支持的会话侧思考档位 "${String(effort)}"，已忽略`
      + '（请检查当前队首目标的 reasoning 能力；需要调整默认档位时请在自动路由条目配置）',
    )
    // 只有解析成功且明确失配时才剥键。删除而不是置 undefined 是语义偏好，不是正确性要求：
    // 宿主各处判据都是 `=== void 0`，两种形态在本链路上等效；删除更准确表达本轮不带档位。
    const { reasoningEffort: _dropped, ...withoutEffort } = resolved
    return withoutEffort
  }, { global: true })
}
