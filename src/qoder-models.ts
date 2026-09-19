/**
 * Qoder（国际版）模型目录：动态拉取 + 静态兜底 + 12h 缓存。
 *
 * ## 为什么单独成模块
 *
 * 与 `src/trae-cn-models.ts` 同一分工：目录解析、目录拉取、静态回退表、
 * 缓存四件事成篇，`src/qoder-adapter.ts` 只负责把它接到 `ctx.llm` 的
 * `listModels` / `resolveModel` 上。适配器的 chat 路径（流式解析、错误分类）
 * 不依赖本模块 —— 本模块是**纯目录面**。
 *
 * ## 目录端点只认 PAT（与 chat / quota 不同源）
 *
 * | 端点 | 凭据 | 证据 |
 * |---|---|---|
 * | `GET {modelsBase}/api/v1/cloud/models` | **PAT（`pt-`）** | T1 实测 200 |
 * | `POST {chatBase}/model/v1/chat/completions` | jt（`jt-`） | PAT 直打恒 401 |
 * | `GET {openapiBase}/api/v2/quota/usage` | jt（`jt-`） | PAT 打回 401 `TOKEN_EXPIRE` |
 *
 * 故本模块**不做 exchange、不取 job token**（那是 `src/qoder-auth.ts` 的职责），
 * 直接用凭据里的 `access_token`（PAT 本体）打目录 —— 加一层 jt 换取只会白白
 * 引入一个会过期的中间态（计划 §0「目录端点」行的定案）。
 *
 * ## 目录形态（T1 实测 17 项，`has_more:false`）
 *
 * 实测定案与原调研报告 C2 的二手 schema 有两处**关键差异**，都以实测为准：
 *
 * 1. **返回全表 + `is_enabled` 标记**，不是「只返回 enabled 模型」——
 *    本账号 17 项里**仅 2 项** `is_enabled:true`（`qmodel_38max` / `qfmodel`）。
 *    故过滤策略是「拉取成功时**只播报** `is_enabled === true` 的项」。
 * 2. **没有 `type` / `source`**，但多 `is_vl` / `support_disable_reasoning`。
 *
 * `id` 是**短 key**（`qmodel_38max` / `qfmodel` / `gmodel` / `dmodel` / `mmodel`…），
 * **不是 tier 名** —— `auto` / `efficient` 虽是目录里的合法 id，但作为 `model`
 * 值下发时回 402（T4 定案：chat 只认短 key）。
 *
 * ## roster 会浮动 → 绝不硬编码全表
 *
 * 实测目录与官方 CLI 表、国内版表**三者都不一致**（目录里没有 `lite`、
 * 没有 `Kimi-K2.7-Code`、没有 `Qwen3.6-Flash`、没有 `MiniMax-M2.7`）。故静态表
 * 只放**本插件确实要在目录不可用时也能播报**的极少项，不做全表镜像。
 *
 * ## `lite` 的特殊处理（**两条路径不对称，是刻意的**）
 *
 * `lite` 不在官方目录里，但 T2/T3 实测它是 **quota=0 账号上唯一能回 200 的模型**
 * （免费遗留路径，上游路由到 `qwen3-coder-plus`）。它的处理规则：
 *
 * - **动态目录成功时「不并入」lite** —— 目录是「官方认可集」，把 lite 并进去
 *   等于**伪造官方认可**，用户会以为官方仍在提供它；
 * - **目录整体失败回退静态表时 lite 自然在列** —— 此时没有任何官方数据可用，
 *   把实测可用的 lite 列出来是「尽力而为」而不是「声称官方支持」。
 *
 * 该不对称由 {@link effectiveQoderCatalog} 一处收敛，不要在别处再写一份判断。
 */

import {
  QODER_MODELS_PATH,
  qoderPatHeaders,
} from './qoder-product.js'
import type { QoderCredential, QoderProduct } from './qoder-product.js'
import { QODER } from './qoder-product.js'

// ── 常量 ──

/**
 * 目录缓存 TTL（毫秒，12 小时）。
 *
 * 与 `TRAE_CN_MODELS_TTL_MS` / LobsterAI 的 `clientVersion` 缓存同一口径：
 * 模型目录变化极慢，而 `listModels` / `resolveModel` 都会触发一次「确保目录就绪」，
 * 没有 TTL 就只能进程级缓存一次（长会话中新增模型永远看不见）。
 */
export const QODER_MODELS_TTL_MS = 12 * 60 * 60 * 1000

/**
 * 表外模型的可读提示（追加在失败文案之后）。
 *
 * 与 `src/trae-cn-adapter.ts` 的 `TRAE_CN_OFF_CATALOG_HINT` 同一惯例、同一句式：
 * 判定「模型不在可用目录中」与「请求形态错误」共用同一句上游文案时，用户无法
 * 自行区分，故由本插件补一句「换一个模型」的可执行建议。
 *
 * ⚠️ **本提示只用于失败路径的文案，不用于 `resolveModel` 抛错** —— DSH 约定
 * `listModels` 仅供参考，表外 id 必须仍可路由（见 `qoder-adapter.ts` 模块头）。
 */
export const QODER_OFF_CATALOG_HINT = '（该模型已不在 Qoder 可用目录中，请在 Hub 的显示列表里重选）'

/**
 * 静态兜底表的条目（**roster 浮动，故只放极少项**）。
 *
 * 三个字段来源不同，逐项说明见 {@link QODER_FALLBACK_MODELS}：
 * - `qmodel_38max` / `qfmodel`：目录实测 `is_enabled:true` 的两项（本账号）
 *   —— 字段值（展示名 / 档位 / 窗口 / `is_vl`）**逐字符照抄 T1 快照**；
 * - `lite`：**不在目录**，靠 T2/T3 实测可用性入选，故**没有任何目录字段可抄**
 *   （无档位、无窗口声明）。
 */
export interface QoderFallbackModel {
  /** 模型 ID（chat 请求体的 `model` 取值，**短 key**）。 */
  id: string
  /** 展示名（目录的 `display_name`）。 */
  name: string
  /**
   * 目录的 `is_vl`（多模态标记）。
   *
   * ⚠️ **本字段目前不参与 `inputModalities` 声明**：本适配器的 chat 路径
   * （`serializeQoderMessages`）只搬运文本块，图片块会被静默丢弃，故对外
   * **一律声明纯文本**。把 `is_vl:true` 报成「支持图片」会让 DSH 把图片路由
   * 进这条必然丢图的通道 —— 那是真实的数据丢失，比少报一个能力严重得多。
   * 保留字段是为了忠实记录实测值（将来接上图片通路时按它声明）。
   */
  supportsImages?: boolean
  /**
   * 上下文窗口（目录的 `default_context_window`；缺该字段时取
   * `available_context_windows` 首项 —— 实测两者一致，见
   * {@link parseQoderDirectory}）。
   */
  contextWindow?: number
  /**
   * 可选思考档位（目录的 `efforts`，**顺序逐字符照抄**）。
   *
   * 缺省 = **不暴露选择器**：DSH 的「思考程度」只读 `resolveModel().reasoning`，
   * 不声明时显示「当前模型未提供推理等级」，这是诚实的（同 trae-cn 约定）。
   */
  reasoningEfforts?: readonly string[]
  /** 默认档位（目录的 `default_effort`），必须落在 {@link reasoningEfforts} 内。 */
  defaultReasoningEffort?: string
}

/**
 * 静态兜底表 —— **3 项**。
 *
 * ## 为什么只有 3 项（而不是镜像 17 项）
 *
 * 目录 17 项里 15 项对本账号 `is_enabled:false`，且**它们的可用性随账号与
 * roster 浮动**（同一 id 在别的账号 / 别的时间未必在表里）。把 17 项抄进静态表
 * 会在目录失败时**播报一批本账号根本用不了的模型** —— 用户选中即 402，
 * 且失败原因（额度/账号）与模型名看起来毫无关系，极难自行诊断。
 *
 * 故只保留「目录失败时最可能仍然可用」的极小集：
 *
 * | id | 展示名 | 来源 | 档位 |
 * |---|---|---|---|
 * | `qmodel_38max` | Qwen3.8-Max | T1 目录 `is_enabled:true` | xhigh / low / medium，默认 medium |
 * | `qfmodel` | Qwen3.8-Flash | T1 目录 `is_enabled:true` | 同上 |
 * | `lite` | Lite | **不在目录**，T2/T3 实测可用（免费遗留路径） | **不声明** |
 *
 * `lite` 的展示名取 `Lite`：官方目录不提供它，参考实现（QoderGateway）硬编码的
 * 也是 `Lite` —— 这里只沿用这个公认叫法，**不抄它硬编码的 `max_input_tokens:
 * 180000`**（那是参考项目自己编的常量，不是实测值）。
 */
export const QODER_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  {
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    supportsImages: true,
    contextWindow: 200_000,
    reasoningEfforts: ['xhigh', 'low', 'medium'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'qfmodel',
    name: 'Qwen3.8-Flash',
    supportsImages: true,
    contextWindow: 200_000,
    reasoningEfforts: ['xhigh', 'low', 'medium'],
    defaultReasoningEffort: 'medium',
  },
  {
    // 免费遗留路径：不在官方目录，但实测可用。**无档位声明** —— 目录没给，
    // 也没有别的实测来源，宁可不声明也不给一个上游不认的档位。
    id: 'lite',
    name: 'Lite',
  },
]

// ── 目录条目 ──

/**
 * 目录条目（**动态与静态两个来源共用同一种形态**）。
 *
 * 字段全部可选（`id` / `name` 除外），因为「缺省」与「明确为假」在 DSH 侧
 * 语义不同：`inputModalities` 缺席 = 未知、显式 `['text']` = 明确的否定能力。
 */
export interface QoderModelEntry {
  /** 模型 ID（短 key）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 目录的 `is_enabled`（静态兜底条目恒为 true）。 */
  enabled: boolean
  /** 目录的 `is_vl`；缺省 = 目录未提供。 */
  supportsImages?: boolean
  /** 上下文窗口（见 {@link QoderFallbackModel.contextWindow}）。 */
  contextWindow?: number
  /** 目录的 `max_input_tokens`（**只记录，不 materialize**，见下）。 */
  maxInputTokens?: number
  /** 目录的 `available_context_windows`（原样保留，含 272000 这类非整值）。 */
  availableContextWindows?: readonly number[]
  /** 可选思考档位；缺省 = 不声明。 */
  reasoningEfforts?: readonly string[]
  /** 默认档位，必须落在 {@link reasoningEfforts} 内。 */
  defaultReasoningEffort?: string
}

/**
 * 静态兜底表 → 目录条目。
 *
 * 这是「目录失败时」的播报来源，**含 `lite`**（见模块头的两条路径不对称）。
 */
export function fallbackQoderCatalog(): QoderModelEntry[] {
  return QODER_FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    enabled: true,
    ...model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts },
    ...model.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: model.defaultReasoningEffort },
  }))
}

/**
 * 当前生效的目录：**动态优先，空则回退静态表**。
 *
 * ⚠️ 本函数是「`lite` 只在静态表里」这条不对称规则的**唯一**落点：
 * 只要动态目录拿到了非空结果就直接返回它，**绝不把静态项并进去**（并进去等于
 * 伪造「官方认可 lite」）。调用方不要在别处再写一份合并判断。
 *
 * 传空数组（拉取失败 / 无 `is_enabled` 项）即回退 —— 与「失败不写缓存」配套：
 * 失败根本不会进缓存，故 `undefined` 与 `[]` 在这里等价处理。
 */
export function effectiveQoderCatalog(remote: readonly QoderModelEntry[] | undefined): QoderModelEntry[] {
  if (remote !== undefined && remote.length > 0) return [...remote]
  return fallbackQoderCatalog()
}

// ── 目录解析 ──

/** {@link parseQoderDirectory} 的选项。 */
export interface QoderDirectoryParseOptions {
  /**
   * 是否保留 `is_enabled:false` 的项（默认 **false**，即只留官方启用项）。
   *
   * 生产路径**必须**用默认值：定案是「拉取成功时只播报 `is_enabled === true`
   * 的项」。置 true 只用于诊断与测试（核对过滤前后各有多少项）。
   */
  includeDisabled?: boolean
}

/**
 * 解析 `GET /api/v1/cloud/models` 的响应（**只认实测形态**）。
 *
 * ```json
 * {"data":[{"id":"qmodel_38max","display_name":"Qwen3.8-Max","is_enabled":true,
 *   "is_vl":true,"support_disable_reasoning":false,"price_factor":0.2,
 *   "efforts":["xhigh","low","medium"],"default_effort":"medium",
 *   "max_input_tokens":180000,"default_context_window":200000,
 *   "available_context_windows":[200000,400000,1000000]}, ...],
 *  "has_more":false}
 * ```
 *
 * ## 只读实测路径，不做信封猜测
 *
 * 顶层 `data` 数组、字段名逐字符已知（T1 快照）。与 `parseTraeCnDirectory`
 * 同一纪律：**不猜** `models` / `list` / `result` 等候选键 —— 上游真改版时，
 * 一个**空目录**（回退静态表、用户仍能用）比「猜对形状但读错字段」的半成品
 * 更容易诊断。
 *
 * ## 字段读取规则
 *
 * | 目录字段 | 条目字段 | 规则 |
 * |---|---|---|
 * | `id` | `id` | 去空白后必须非空，否则**跳过该项** |
 * | `display_name` | `name` | 缺省回退 `id` |
 * | `is_enabled` | `enabled` | **只认严格 `=== true`**（见下） |
 * | `is_vl` | `supportsImages` | 布尔才收，缺省 = 未提供 |
 * | `max_input_tokens` | `maxInputTokens` | 正有限数才收 |
 * | `default_context_window` | `contextWindow` | 首选；**272000 这类非整值照收** |
 * | `available_context_windows` | `availableContextWindows` | 正数数组原样保留（非空才收） |
 * | `available_context_windows[0]` | `contextWindow` | 仅当 `default_context_window` 缺席时兜底 |
 * | `efforts` | `reasoningEfforts` | 非空字符串数组（去空白）才收 |
 * | `default_effort` | `defaultReasoningEffort` | **仅当它落在 `efforts` 内**才收（见下） |
 *
 * ## 两处刻意的判据
 *
 * 1. **`is_enabled` 只认严格 `true`**：字段缺失时**不保留**该项。保守方向
 *    与「目录是官方启用集」一致 —— 上游若改名该字段，结果是空目录 → 回退静态表
 *    （用户仍能用），而不是把 17 项（含必然 402 的 tier 名）整批放出去。
 * 2. **`default_effort` 不在 `efforts` 内时只丢默认档、保留档位列表** ——
 *    与 trae-cn / trae-cn-work 的同名规则逐字一致：声明了却不在列表里的默认档
 *    会被 DSH 判为 `INVALID_MODEL_REASONING` **直接抛错**，把请求打死；
 *    而上游发出不自洽组合时用户仍应能手动选档。
 *
 * @param body - 响应体（非对象 / 缺 `data` 数组时返回空数组）。
 * @param options - 见 {@link QoderDirectoryParseOptions}。
 */
export function parseQoderDirectory(
  body: unknown,
  options: QoderDirectoryParseOptions = {},
): QoderModelEntry[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return []
  const list = (body as Record<string, unknown>).data
  if (!Array.isArray(list)) return []

  const includeDisabled = options.includeDisabled === true
  const entries: QoderModelEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = readString(record.id)
    if (id === undefined) continue
    const enabled = record.is_enabled === true
    if (!enabled && !includeDisabled) continue

    const contextWindows = readPositiveArray(record.available_context_windows)
    const declaredWindow = readPositive(record.default_context_window)
    // `default_context_window` 优先；缺它时取可用窗口首项 —— 实测两者一致
    // （200000/[200000,…]、272000/[272000,…]），故这是有依据的兜底而非猜测。
    const contextWindow = declaredWindow ?? (contextWindows === undefined ? undefined : contextWindows[0])
    const maxInputTokens = readPositive(record.max_input_tokens)
    const reasoning = readReasoning(record)

    entries.push({
      id,
      name: readString(record.display_name) ?? id,
      enabled,
      ...record.is_vl === true || record.is_vl === false ? { supportsImages: record.is_vl } : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxInputTokens === undefined ? {} : { maxInputTokens },
      ...contextWindows === undefined ? {} : { availableContextWindows: contextWindows },
      ...reasoning,
    })
  }
  return entries
}

/**
 * 读取 `efforts` / `default_effort`。
 *
 * 规则与 `src/trae-cn-models.ts` / `src/trae-cn-work-adapter.ts` 的同名读取
 * **刻意一致**：档位 id 逐字符照抄（不做 `light`→`low` 之类的归一化 ——
 * 它会原样进请求体），`default_effort` 只在落在列表内时才声明。
 */
function readReasoning(record: Record<string, unknown>): {
  reasoningEfforts?: readonly string[]
  defaultReasoningEffort?: string
} {
  const raw = record.efforts
  if (!Array.isArray(raw)) return {}
  const efforts = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (efforts.length === 0) return {}
  const declared = readString(record.default_effort)
  return {
    reasoningEfforts: efforts,
    ...declared !== undefined && efforts.includes(declared) ? { defaultReasoningEffort: declared } : {},
  }
}

/** 读非空字符串（去首尾空白），否则 undefined。 */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 读正有限数，否则 undefined（**不把 0 当成有效窗口**）。 */
function readPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 读「正有限数数组」（非数组或过滤后为空时返回 undefined）。 */
function readPositiveArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const numbers = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0,
  )
  return numbers.length === 0 ? undefined : numbers
}

// ── 目录拉取 ──

/** {@link fetchQoderDirectory} 的入参。 */
export interface QoderDirectoryOptions {
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 覆盖目录基址（默认 `product.modelsBase`）。 */
  modelsBase?: string
  /** 产品配置；默认 `QODER`。 */
  product?: QoderProduct
  /** 取消信号。 */
  signal?: AbortSignal
}

/**
 * 拉取动态模型目录（**PAT 直连，不需要 job token**）。
 *
 * ## 失败语义：返回空数组，**绝不抛错**
 *
 * 目录是「尽力而为」的数据：任何网络失败、非 2xx、响应不是 JSON、`data` 不是
 * 数组，一律返回 `[]`，由调用方回退静态表。抛错只会让一次目录抖动升级成
 * 「模型选择器整块炸掉」。
 *
 * ⚠️ **只认 HTTP 2xx 才算成功**：401（PAT 失效）也走这条「空目录」路径 ——
 * 目录的 401 与 chat 的 401 语义不同（后者有「jt 过期，重换一次」的动作），
 * 本模块**不解释错误**，只回空（错误分类属 `src/qoder-errors.ts`）。
 *
 * ## 返回的是**已过滤**的目录
 *
 * 只含 `is_enabled === true` 的项（定案），且**不含 `lite`**（它不在目录里）。
 * 调用方拿到非空结果即可直接播报，不需要再过滤一次。
 */
export async function fetchQoderDirectory(
  credential: QoderCredential,
  options: QoderDirectoryOptions = {},
): Promise<QoderModelEntry[]> {
  const product = options.product ?? QODER
  const fetcher = options.fetchImpl ?? fetch
  const base = options.modelsBase ?? product.modelsBase
  try {
    const response = await fetcher(`${base}${QODER_MODELS_PATH}`, {
      method: 'GET',
      headers: qoderPatHeaders(credential, product, 'application/json'),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (!response.ok) return []
    return parseQoderDirectory(await response.json() as unknown)
  } catch {
    return []
  }
}

// ── 目录缓存 ──

/**
 * 12h TTL 的目录缓存（成功才写，失败不写也不清）。
 *
 * ## 两个读口，语义不同（不要混）
 *
 * | 方法 | 返回 | 用途 |
 * |---|---|---|
 * | {@link QoderCatalogStore.fresh} | 仅**未过期**时有值 | `ensureCatalog` 判断「要不要重新拉」 |
 * | {@link QoderCatalogStore.entries} | 有值即返回（**含已过期**） | 播报 / 解析——网络抖动时不打回静态表 |
 *
 * 分开的原因是 trae-cn 已验证的行为约定：**一次网络抖动不该把目录打回静态表**。
 * 若只留一个「过期即 undefined」的读口，TTL 到点后的那次失败刷新会让目录
 * 从「上次成功的完整目录」直接掉到 3 项静态表 —— 用户看到模型列表突然变短。
 *
 * ## 失败不写缓存
 *
 * {@link QoderCatalogStore.store} 对**空数组是 no-op** —— 这是「失败不写缓存」
 * 的**唯一执行点**（`fetchQoderDirectory` 用空数组表达一切失败）。缓存里因此
 * 永远不会出现「空目录」这种状态，调用方不必区分「没拉过」与「拉过但没结果」。
 *
 * `now` 可注入，使 TTL 判定可确定性单测（不需要 fake timers）。
 */
export class QoderCatalogStore {
  private cached?: { entries: readonly QoderModelEntry[]; fetchedAt: number }

  constructor(
    private readonly ttlMs: number = QODER_MODELS_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** TTL **内**的目录；冷缓存或已过期时 undefined。 */
  fresh(): readonly QoderModelEntry[] | undefined {
    if (this.cached === undefined) return undefined
    if (this.now() - this.cached.fetchedAt >= this.ttlMs) return undefined
    return this.cached.entries
  }

  /** 最近一次成功写入的目录（**已过期也返回**）；从未成功过时 undefined。 */
  entries(): readonly QoderModelEntry[] | undefined {
    return this.cached?.entries
  }

  /** 写入目录；**空数组是 no-op**（失败不写缓存，也不清掉已有缓存）。 */
  store(entries: readonly QoderModelEntry[]): void {
    if (entries.length === 0) return
    this.cached = { entries: [...entries], fetchedAt: this.now() }
  }

  /** 丢弃缓存（下次必重新拉取）；供登出 / 测试使用。 */
  clear(): void {
    this.cached = undefined
  }
}
