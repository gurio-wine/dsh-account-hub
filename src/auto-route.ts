/**
 * 「自动路由」——**本功能的唯一真相源**（纯逻辑：无 ctx、无 IO、零依赖既有运行时代码）。
 *
 * ## 功能
 *
 * 用户在面板里定义若干**自动模型**，每个自动模型是一条**有序**的
 * `(provider, model, effort?)` 候选列表。插件把它们注册成一个虚拟 provider
 * （id 固定为 {@link AUTO_ROUTE_PROVIDER_ID}），其模型列表 = 这些自动模型。
 * DSH 选中某个自动模型发起请求时，宿主按列表顺序取**队首**条目委派给真实
 * provider；**失败者被移到队尾**（跨请求持续），降级后新队首立刻顶替。
 *
 * ## 三条被钉死的语义
 *
 * 1. **降级是轮转，不是淘汰**：失败条目排到队尾，靠后的条目因此获得机会；
 *    成功**不升位**、不探活、不主动恢复（懒恢复：只有前面的都失败才轮到它）。
 * 2. **满一圈的判定归调用方**：本模块**不计数**。调用方（宿主适配器）在单次
 *    请求内累计 demote 次数，达到 {@link autoRouteEntryCount} 即判「该自动模型
 *    全部不可用」并向 DSH 报错 —— 这样「一次请求最多试 N 次」的口径只写在
 *    调用方一处，引擎保持无状态计数。
 * 3. **运行时状态不落盘**：进程重启即回到用户手排的原始顺序。用户排的顺序是
 *    意图，运行时轮转只是本次进程内的临时偏移，持久化它会让用户看到「我明明
 *    把 A 排在第一位，重启后却从 C 开始」。
 *
 * ## 读路径与写路径的判据必须一致
 *
 * {@link sanitizeAutoRouteConfig}（读盘 / 降级读，脏层丢弃、永不抛错）与
 * {@link assertValidAutoRouteConfig}（RPC 写入前，非法即抛）**共用同一套判据**，
 * 差别只在处置。判据若分叉，会出现「存得进去却读不出来」或反过来的静默丢失，
 * 故两者的合法判定都收敛到本文件里的 {@link readEntry} / {@link readDefinition}
 * 两个内部函数，不存在第二份名单。
 *
 * @module dsh-account-hub/auto-route
 */

/**
 * 虚拟 provider 的固定 id。
 *
 * 自动模型条目里出现它 = **自引用**（自动路由委派给自动路由），会造成无限递归，
 * 因此读路径丢弃、写路径拒绝，两侧都不留口子。
 */
export const AUTO_ROUTE_PROVIDER_ID = 'auto-route'

/**
 * 历史消息的**来源 provider 重写**（转发前的唯一改写动作）。
 *
 * ## 为什么必须做这件事（宿主侧 `LlmRuntime.forAdapter` 的判据）
 *
 * 嵌套转发时，外层请求的 provider 是 {@link AUTO_ROUTE_PROVIDER_ID}，于是宿主把
 * 助手消息的 `source.provider` 也记成 `auto-route`，而那份消息上的 `replayState`
 * 却是**真实 provider 的适配器**产出的（它随内层 finish chunk 原样透传上来）。
 * 内层重入 `ctx.llm.stream()` 时，宿主会做一次「历史消息归属检查」：只有当
 * `source.provider` 所属适配器 === 本次要打的目标适配器时，才保留 `replayState`；
 * 否则**整条消息的 replayState 被摘掉**（等价测试：宿主 `service.spec.ts` 的
 * 「strips replay state ... different adapter instance」）。
 *
 * 摘掉 replayState 的后果不是「降级成普通历史」那么轻：思考模式下的工具调用轮
 * 依赖 provider 侧的签名（Anthropic 的 `thinkingSignature` / DeepSeek Messages 的
 * `reasoning.signature`），签名一丢，下一轮请求会被上游以 400 拒绝。
 *
 * 因此转发前把 `source.provider` 改写成**本次目标 provider**：内层那次归属检查
 * 就命中「同一个适配器」，replayState 得以保留。
 *
 * ## 改写范围刻意最小
 *
 * 只碰 `role === 'assistant' && source?.kind === 'model'` 的消息，其余**原样引用**
 * （同一个对象，不是拷贝）—— 工具结果、用户消息、system 消息上的任何字段都不属于
 * 本模块的职责，多改一处就多一处静默篡改用户历史的风险。
 *
 * ## 不冻结返回值（刻意的）
 *
 * 请求对象与其 `messages` 数组是**深冻结**的（宿主 `agent.ts`），故这里必须
 * `map` 出新数组、浅拷贝出新消息对象，绝不原地改。但新对象**不再深冻结**：
 * 深冻结要遍历整条历史的全部内容块，长会话下是每轮请求一次的纯开销，而这条
 * 路径上没有任何人会写它们（下游适配器只读）。数组本身也不冻结，理由同上。
 *
 * @param messages - 宿主请求携带的历史消息（只读、可能深冻结）。
 * @param provider - 本次转发的目标 provider。
 * @returns 新数组：目标消息是**新对象**，其余是原引用。
 */
export function rewriteMessagesForTarget<T extends AutoRouteMessage>(
  messages: readonly T[],
  provider: string,
): T[] {
  return messages.map((message): T => {
    const source = message.source
    if (message.role !== 'assistant' || source === undefined || source.kind !== 'model') return message
    return { ...message, source: { ...source, provider } }
  })
}

/**
 * 消息的**结构化最小视图**（本模块只关心这两个字段）。
 *
 * 刻意不 import 宿主的 `Message` 类型：本文件是「无 ctx、无 IO、零依赖既有运行时代码」
 * 的纯逻辑层，连类型依赖也不引入。宿主的 `Message` 与 `ModelMessageSource` 在结构上
 * 都满足本接口（`role` 是字符串字面量联合、`kind` 是 `'model'`），故调用点直接传
 * 宿主的消息数组即可 —— 形状一旦不符，`tsc` 在调用点就报错，不会静默漏改。
 */
export interface AutoRouteMessage {
  readonly role?: string
  readonly source?: {
    readonly kind?: string
    readonly provider?: string
  }
}

/**
 * 「该自动模型的全部条目都试过且都失败」的**稳定错误码**。
 *
 * ## 为什么是自定义码，而不是借用宿主的可重试码
 *
 * 宿主的默认重试策略（`resolveRetryPolicy(undefined, ...)`）只认五个码：
 * `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`，
 * 且 `maxRetries` 默认 **5**。这个码不在其中 —— 这是**刻意的**：一轮请求里每条
 * 候选都已经实测失败过了，让官方重试把「一轮全失败」放大成五轮，用户要等五次
 * 指数退避才看到那句错误，而结果必然还是同一句。
 *
 * ⚠️ 实测结论（探针脚本，2026-09 于本仓依赖 `dsh-llm@0.1.2-rc.1`）：
 * 默认 `retryableCodes` 恰好是那五个，本码**不在集合内** ⇒ 官方重试不会放大它。
 * 但适配器仍**显式**声明策略（见 `providerRetryPolicy`），不依赖「默认值恰好合适」
 * 这个巧合：宿主的默认值是可配置的，而「全部不可用最多一次到达用户」是本功能的
 * 语义要求，不能建立在别人的缺省值上。
 */
export const AUTO_ROUTE_EXHAUSTED_CODE = 'AUTO_ROUTE_EXHAUSTED'

/**
 * 「全部条目不可用」的用户可见消息（中文，点名是哪个自动模型）。
 *
 * 单独一个构造函数：适配器与错误码两处必须给出**同一句**，否则用户拿到的提示
 * 与日志里那句对不上，排查时无法互相对照。
 */
export function autoRouteExhaustedMessage(name: string): string {
  return `自动模型『${name}』全部条目不可用`
}

/**
 * 配置的**内容指纹**：运行时是否需要重建的**唯一判据**。
 *
 * ## 为什么判据是「整份内容」而不是「开关」或「定义 id 集合」
 *
 * 运行时（降级队列）必须与用户当前排的顺序一致。三种漏法各有一个具体症状：
 * - **只看开关**：用户改候选顺序/加删条目后运行时不动 ⇒ 新加的候选永远轮不到、
 *   删掉的还会被使用；
 * - **只看定义 id 集合**：定义 id 没变、只改 `entries`（界面上最常见的编辑）时
 *   同样不动 ⇒ 同上；
 * - **看对象引用**：`autoRouteConfig()` 每次都返回**深拷贝**（`sanitizeAutoRouteConfig`
 *   逐层新建），引用恒不相等 ⇒ 每次读都重建，降级进度被无声清空（「配了三个候选，
 *   第一个失败后下一轮又从它开始」，无限循环打同一个失败 provider）。
 *
 * 故比较**内容**，且只比较会影响队列的字段（`enabled` + 定义的身份与条目顺序）。
 *
 * ## 为什么用 `JSON.stringify`
 *
 * 键序稳定：输入来自 {@link sanitizeAutoRouteConfig}，它按固定字段顺序新建对象
 * （`{provider, model}` 与 `{provider, model, effort}` 都是显式字面量）。`effort` 的
 * 缺省写成 `null` 占位 —— `undefined` 会被 `JSON.stringify` 整键丢弃，从而与
 * 「键存在但值为 undefined」混为一谈，而两者在本配置里是不同语义（前者 = 该模型
 * 默认档，后者非法且已被读路径丢弃）。
 *
 * 返回值是**不透明字符串**，只应用于相等比较，不要解析它。
 */
export function autoRouteConfigFacts(config: AutoRouteConfig): string {
  return JSON.stringify([
    config.enabled,
    config.models.map((definition) => [
      definition.id,
      definition.name,
      definition.entries.map((entry) => [entry.provider, entry.model, entry.effort ?? null]),
    ]),
  ])
}

/**
 * 「DSH 请求的模型名不在自动模型列表里」的稳定错误码 —— **目录漂移**专用。
 *
 * 这是一个**配置漂移**信号，不是一个可降级的候选失败：它说明 DSH 手里那份模型
 * 目录比池里的配置旧（用户刚删掉一个自动模型，而界面还在用它发请求）。既然没有
 * 任何候选可试，重试与降级都无意义，必须直接报出来 —— 故同样**不在**可重试集合内。
 *
 * ## 与 {@link AUTO_ROUTE_ENTRY_UNRESOLVED_CODE} 的判别（两者都是「解析不了」，但不是一回事）
 *
 * | 码 | 故障 | 触发点 | 用户该做什么 |
 * |---|---|---|---|
 * | 本码 | **定义 id 找不到**（目录比池旧） | DSH 请求的模型名在池配置里没有对应定义 | 刷新 DSH 的模型目录后重选（配置本身没坏） |
 * | `ENTRY_UNRESOLVED` | **队首条目解析不了**（provider 未注册 / 模型不存在） | 定义存在，但队首条目的目标 `resolveModelInfo` 抛错 | 去面板改候选：换 provider / 换模型 / 检查该 provider 是否已装并登录 |
 *
 * 两者**刻意分开**：旧实现把条目解析失败也报成本码，用户拿到的提示是「请刷新模型
 * 目录重选」—— 而刷新目录对「provider 插件被卸掉」毫无作用，排查方向被直接带偏。
 */
export const AUTO_ROUTE_UNKNOWN_MODEL_CODE = 'AUTO_ROUTE_UNKNOWN_MODEL'

/**
 * 「未知自动模型」的用户可见消息（中文）。
 *
 * 与 {@link autoRouteExhaustedMessage} 分列两个函数而不是合成一个带 mode 参数的：
 * 两者是**两种不同的故障**（配置漂移 vs 候选全灭），用户要做的事也不同
 * （刷新模型目录 vs 检查 provider 账号），消息必须各自点名。
 */
export function autoRouteUnknownModelMessage(modelId: string): string {
  return `自动路由里没有名为『${modelId}』的自动模型（DSH 的模型目录可能已过期，请刷新后重选）`
}

/**
 * 「自动模型存在，但队首条目的目标解析不了」的稳定错误码。
 *
 * 故障面是**候选条目本身**：定义在池里好好的，而它的队首条目指向一个宿主
 * `resolveModelInfo` 解析不出的目标 —— 该 provider 没有适配器注册（插件被卸掉 /
 * 名字写错）或该 provider 下没有这个模型（模型下架 / 名字写错）。
 *
 * ## 为什么不复用 {@link AUTO_ROUTE_UNKNOWN_MODEL_CODE}
 *
 * 那个码的语义是「定义 id 找不到」，它的用户动作是**刷新 DSH 模型目录**。把它挪用
 * 到这里会让用户照着提示去刷新目录，而目录刷新对一个未注册的 provider 一点用都没有
 * —— 真正的修法是**改这条候选**。两种故障的判别与用户动作都不同，码就必须不同。
 *
 * 同样**不在**可重试集合内：这是配置/安装面的事实，重试只会重复同一条解析失败。
 */
export const AUTO_ROUTE_ENTRY_UNRESOLVED_CODE = 'AUTO_ROUTE_ENTRY_UNRESOLVED'

/**
 * 「队首条目解析不了」的用户可见消息（中文，点名是哪个自动模型、哪条候选、以及原因）。
 *
 * `reason` 是内层错误的原文：用户唯一能据以分辨「provider 没装」与「模型下架」的
 * 信息就在里面，故原样带上（与「保留错误链 `cause`」是同一件事的两个面向）。
 */
export function autoRouteEntryUnresolvedMessage(
  name: string,
  provider: string,
  model: string,
  reason: string,
): string {
  return `自动模型『${name}』的队首条目 ${provider}/${model} 无法解析：${reason}`
}

/**
 * 「内层流没有给出终止 chunk 就结束了」的稳定错误码。
 *
 * 这违反的是**适配器契约**（宿主的 `llm-invariant` 明确要求每条 provider 流以终止
 * chunk 收尾，否则报 "LLM stream ended without a terminal finish chunk"）。本适配器
 * 仍然自己造一个终止 chunk，而不是让外层流「静静地结束」：
 *
 * - **静静结束**在外层看来是「成功但一个字都没有」，loop 会把它当成空回答，
 *   用户拿到的是莫名的空白而不是可排查的失败；
 * - 造一个 error finish 则让 loop 走它既有的失败路径（`agent/request-error`），
 *   错误消息与错误码都能到达用户。
 *
 * 同样**不在**可重试集合内：内层连终止 chunk 都给不出来，通常不是瞬时故障，重试
 * 只会重复同一条坏路径（且此时已经透传过内容，重试由 loop 决定）。
 */
export const AUTO_ROUTE_INCOMPLETE_CODE = 'AUTO_ROUTE_INCOMPLETE'

/** 「内层流没有终止 chunk」的用户可见消息（中文，点名是哪个候选）。 */
export function autoRouteIncompleteMessage(name: string, provider: string, model: string): string {
  return `自动模型『${name}』的候选 ${provider}/${model} 没有返回终止状态（流被中断）`
}

/** 自动模型里的一条候选。 */
export interface AutoRouteEntry {
  /** 任意 DSH provider id（含 `dsh` 内置；**不含** {@link AUTO_ROUTE_PROVIDER_ID} 自身）。 */
  provider: string
  /** 该 provider 下的模型 id。 */
  model: string
  /** 思考程度；**缺省 = 该模型默认档**（缺省与显式空串是两回事：后者非法）。 */
  effort?: string
}

/** 一个「自动模型」：暴露给 DSH 的一个模型 + 它背后的有序候选列表。 */
export interface AutoRouteDefinition {
  /** 定义 id（客户端生成，跨定义唯一；RPC 寻址与排序用）。 */
  id: string
  /** 显示名，**即暴露给 DSH 的模型 id**：非空且跨定义唯一。 */
  name: string
  /** 有序候选；index 0 = 队首。 */
  entries: AutoRouteEntry[]
}

/** 自动路由的整份配置。 */
export interface AutoRouteConfig {
  /** 总开关，默认 `false`（新功能默认关，用户显式打开才生效）。 */
  enabled: boolean
  /** 自动模型列表，默认 `[]`。 */
  models: AutoRouteDefinition[]
}

/**
 * 冻结的空列表。类型上仍是可变数组（契约如此），运行时不可写 —— 冻结就是那道防线。
 */
const FROZEN_EMPTY_MODELS = Object.freeze([]) as unknown as AutoRouteDefinition[]

/**
 * 默认配置：**深冻结**。
 *
 * 它是所有读取点的共享缺省值（读盘缺失、非法输入回落），任何就地改写都会污染
 * 全局缺省 —— 故连 `models` 数组一起冻结，而不只是外层对象。
 */
export const DEFAULT_AUTO_ROUTE_CONFIG: AutoRouteConfig = Object.freeze({
  enabled: false,
  models: FROZEN_EMPTY_MODELS,
})

/** 空列表的快捷构造（每次新建，避免把冻结的缺省数组交给调用方去改）。 */
function emptyModels(): AutoRouteDefinition[] {
  return []
}

/** 归一化一个字符串字段：只接受字符串，两端空白剪掉；空串视为缺失。 */
function readText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * 读取一条候选条目。
 *
 * @returns 合法条目（新对象）；任一项非法时 `null` —— 调用方据此**只丢这一条**，
 *          不牵连同一份配置里的其它条目。
 *
 * 非法形态（与写路径判据一致）：非对象、`provider` / `model` 空或非字符串、
 * `provider` 等于 {@link AUTO_ROUTE_PROVIDER_ID}（自引用）、`effort` 存在但为空串。
 */
function readEntry(raw: unknown): AutoRouteEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as { provider?: unknown; model?: unknown; effort?: unknown }
  const provider = readText(value.provider)
  const model = readText(value.model)
  if (provider === null || model === null) return null
  if (provider === AUTO_ROUTE_PROVIDER_ID) return null
  if (value.effort === undefined) return { provider, model }
  const effort = readText(value.effort)
  if (effort === null) return null
  return { provider, model, effort }
}

/** 条目身份键（用于同定义内的去重）：`provider` + `model` + `effort`（缺省用空串占位）。 */
function entryKey(entry: AutoRouteEntry): string {
  return `${entry.provider}\u0000${entry.model}\u0000${entry.effort ?? ''}`
}

/**
 * 读取一份有序候选列表：逐条过滤非法条目，并丢弃**完全同形**的重复条目（保留先出现的）。
 *
 * 重复条目没有意义（同一 provider + 模型 + 档位试两次，第二次必然同样失败），
 * 但它会**虚增 {@link autoRouteEntryCount}** —— 于是「满一圈」的判据被拉长，
 * 用户看到的是「明明只有两条候选，却转了三圈才报不可用」。故在读入处就去重。
 */
function readEntries(raw: unknown): AutoRouteEntry[] {
  if (!Array.isArray(raw)) return []
  const result: AutoRouteEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = readEntry(item)
    if (entry === null) continue
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

/**
 * 读取一个自动模型定义（**不含**「entries 是否为空」的判定）。
 *
 * 结构性非法（非对象 / `id` 空 / `name` 空）返回 `null`；`entries` 非数组当作空列表。
 * 「空 entries 的定义算不算合法」在两侧处置不同，故**不在这里判定**：
 * sanitize 丢弃它（没有候选的自动模型等于死路），运行时保留它（队首为 `null`，
 * 计数 0，调用方据此直接判全部不可用），语义各自明确。
 */
function readDefinition(raw: unknown): AutoRouteDefinition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as { id?: unknown; name?: unknown; entries?: unknown }
  const id = readText(value.id)
  const name = readText(value.name)
  if (id === null || name === null) return null
  return { id, name, entries: readEntries(value.entries) }
}

/**
 * 把任意外部值归一化为整份自动路由配置（**读路径**：脏层丢弃，永不抛错）。
 *
 * 处置矩阵：
 *
 * | 形态 | 处置 |
 * |---|---|
 * | 非对象（`null` / 字符串 / 数字 / 数组） | 整份回落默认值 |
 * | `enabled` 非布尔 | 强制 `false` |
 * | `models` 非数组 | `[]` |
 * | 定义非对象 / `id` 空 / `name` 空 | 丢弃该定义 |
 * | 定义 `entries` 为空 | 丢弃该定义 |
 * | `name` 跨定义重复 | 保留第一个，丢弃后来者 |
 * | 定义 `id` 重复 | 保留第一个，丢弃后来者 |
 * | 条目非法（`provider`/`model` 空、自引用、`effort` 空串） | 丢弃该条目 |
 * | 同定义内条目完全同形 | 保留第一个，丢弃后来者 |
 *
 * 返回**全新对象**（定义、条目逐层新建），调用方改返回值不会串到输入，反之亦然。
 */
export function sanitizeAutoRouteConfig(raw: unknown): AutoRouteConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { enabled: false, models: emptyModels() }
  }
  const value = raw as { enabled?: unknown; models?: unknown }
  const enabled = value.enabled === true
  const models: AutoRouteDefinition[] = []
  if (Array.isArray(value.models)) {
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    for (const item of value.models) {
      const definition = readDefinition(item)
      if (definition === null) continue
      // 没有候选的自动模型是死路：留着只会在 DSH 里显示一个永远不可用的模型。
      if (definition.entries.length === 0) continue
      // id 是 RPC 寻址键、name 是暴露给 DSH 的模型 id，重复即歧义，一律保留第一个。
      if (seenIds.has(definition.id) || seenNames.has(definition.name)) continue
      seenIds.add(definition.id)
      seenNames.add(definition.name)
      models.push(definition)
    }
  }
  return { enabled, models }
}

/**
 * 严格校验整份配置（**写路径**：RPC 写入前调用，非法即 `throw Error`）。
 *
 * 判据与 {@link sanitizeAutoRouteConfig} **完全一致**（同一套 {@link readEntry} /
 * {@link readDefinition}），只是处置从「丢弃」改为「拒绝」—— 写路径上静默丢弃
 * 等于用户点了保存却什么都没存，必须让界面拿到明确的错误消息。
 *
 * 一条刻意的例外：**`enabled` 缺省视为 `false` 可接受**（部分更新语义：客户端
 * 只提交 `models` 时不该被迫回传开关）。其余字段必须齐形。
 *
 * 错误消息一律中文并指明「哪个定义 / 哪个字段」。
 */
export function assertValidAutoRouteConfig(config: unknown): void {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('自动路由配置必须是一个对象')
  }
  const value = config as { enabled?: unknown; models?: unknown }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`自动路由配置的 enabled 必须是布尔值，收到 ${describe(value.enabled)}`)
  }
  if (!Array.isArray(value.models)) {
    throw new Error(`自动路由配置的 models 必须是数组，收到 ${describe(value.models)}`)
  }
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  value.models.forEach((item, index) => {
    const position = `第 ${index + 1} 个自动模型`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${position}不是对象（收到 ${describe(item)}）`)
    }
    const rawDefinition = item as { id?: unknown; name?: unknown; entries?: unknown }
    const id = readText(rawDefinition.id)
    if (id === null) throw new Error(`${position}缺少 id（必须是非空字符串）`)
    if (seenIds.has(id)) throw new Error(`${position}的 id 与前面的定义重复：${id}`)
    seenIds.add(id)
    const name = readText(rawDefinition.name)
    if (name === null) throw new Error(`${position}缺少名称（必须是非空字符串）`)
    if (seenNames.has(name)) throw new Error(`${position}名称与『${name}』重复`)
    seenNames.add(name)
    if (!Array.isArray(rawDefinition.entries) || rawDefinition.entries.length === 0) {
      throw new Error(`自动模型『${name}』缺少模型条目（至少一条 provider + model）`)
    }
    const seenEntries = new Set<string>()
    rawDefinition.entries.forEach((rawEntry, entryIndex) => {
      const entryPosition = `${position}『${name}』的第 ${entryIndex + 1} 个条目`
      if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(`${entryPosition}不是对象（收到 ${describe(rawEntry)}）`)
      }
      const rawValue = rawEntry as { provider?: unknown; model?: unknown; effort?: unknown }
      if (readText(rawValue.provider) === null) {
        throw new Error(`${entryPosition}缺少 provider（必须是非空字符串）`)
      }
      if (readText(rawValue.model) === null) {
        throw new Error(`${entryPosition}缺少 model（必须是非空字符串）`)
      }
      if (readText(rawValue.provider) === AUTO_ROUTE_PROVIDER_ID) {
        throw new Error(
          `自动模型『${name}』的${entryPosition}引用了 ${AUTO_ROUTE_PROVIDER_ID} 自身（会造成无限递归）`,
        )
      }
      if (rawValue.effort !== undefined && readText(rawValue.effort) === null) {
        throw new Error(`${entryPosition}的 effort 必须是非空字符串或省略（省略 = 该模型默认档）`)
      }
      const entry = readEntry(rawEntry)
      if (entry === null) throw new Error(`${entryPosition}不合法`)
      const key = entryKey(entry)
      if (seenEntries.has(key)) {
        throw new Error(`${position}『${name}』的第 ${entryIndex + 1} 个条目与前面的条目重复（${entry.provider} / ${entry.model}）`)
      }
      seenEntries.add(key)
    })
  })
}

/** 把任意值渲染成错误消息里的简短描述（不 JSON.stringify，避免把超长内容带进界面）。 */
function describe(raw: unknown): string {
  if (raw === null) return 'null'
  if (Array.isArray(raw)) return '数组'
  const type = typeof raw
  if (type === 'string') return '字符串'
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(raw)
  if (type === 'undefined') return 'undefined'
  return type
}

/**
 * 运行时降级状态（**不透明**：只应经本模块的函数读写）。
 *
 * `queues`：定义 id → 当前有序队列（队首在 index 0）。进程内内存态，**不落盘**。
 */
export interface AutoRouteRuntime {
  /** 定义 id → 当前队列。 */
  readonly queues: Map<string, AutoRouteEntry[]>
}

/**
 * 建一个运行时。
 *
 * **深拷贝传入的定义**（条目逐条新建）：调用方手里的配置对象属于用户，运行时轮转
 * 绝不能改到它 —— 否则「重启回到原始顺序」会变成「重启也回不去」，而且面板读到的
 * 顺序会跟着请求成败漂移。
 *
 * 归一化口径与读路径一致（脏定义丢弃、重复 id / 名称保留第一个），但**保留空
 * entries 的定义**：它对应的自动模型没有任何可用候选，{@link autoRouteHead} 返回
 * `null`、{@link autoRouteEntryCount} 返回 0，调用方据此直接判全部不可用。
 * 本函数**不抛错**（运行时永远建得起来，坏配置表现为「该模型不可用」）。
 */
export function createAutoRouteRuntime(models: readonly AutoRouteDefinition[]): AutoRouteRuntime {
  const queues = new Map<string, AutoRouteEntry[]>()
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  if (Array.isArray(models)) {
    for (const item of models) {
      const definition = readDefinition(item)
      if (definition === null) continue
      if (seenIds.has(definition.id) || seenNames.has(definition.name)) continue
      seenIds.add(definition.id)
      seenNames.add(definition.name)
      queues.set(definition.id, definition.entries)
    }
  }
  return { queues }
}

/**
 * 当前队首条目（**副本**，调用方就地改它不会污染队列）。
 *
 * @returns 未知定义 id / 空队列时 `null` —— 调用方据此直接判「该自动模型不可用」，
 *          不需要额外的存在性检查。
 */
export function autoRouteHead(rt: AutoRouteRuntime, definitionId: string): AutoRouteEntry | null {
  const queue = rt.queues.get(definitionId)
  if (queue === undefined || queue.length === 0) return null
  return { ...queue[0] }
}

/**
 * 把队首移到队尾（一次降级），返回**新的队首**。
 *
 * - 单条目队列：轮转是 no-op（队首还是它）—— 调用方靠「demote 次数 ≥ 条目数」判满圈，
 *   不依赖队列本身发生变化。
 * - 未知定义 id / 空队列：返回 `null`，不抛错。
 *
 * 不计数、不记录失败原因：失败原因的处置（是否报错、报什么）属于调用方。
 */
export function demoteAutoRouteHead(rt: AutoRouteRuntime, definitionId: string): AutoRouteEntry | null {
  const queue = rt.queues.get(definitionId)
  if (queue === undefined || queue.length === 0) return null
  const head = queue.shift()
  if (head === undefined) return null
  queue.push(head)
  return { ...queue[0] }
}

/**
 * 该自动模型的候选条目数 —— 也是**「满一圈」的阈值**：单次请求内 demote 次数达到
 * 这个数，说明每条候选都试过一次且都失败了，调用方此时才向 DSH 报「全部不可用」。
 *
 * 未知定义 id → 0。
 */
export function autoRouteEntryCount(rt: AutoRouteRuntime, definitionId: string): number {
  return rt.queues.get(definitionId)?.length ?? 0
}
