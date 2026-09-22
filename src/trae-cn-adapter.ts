/**
 * Trae CN（字节跳动 Trae 国内版）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * Trae CN 与其它四条线只在「消息结构」这一层相同（OpenAI chat-completions 的消息
 * 数组），其余没有一处能照抄 —— 最本质的是 **SSE 是具名事件流**
 * （`event:output` 而非 `data:{"choices":[...]}`），且**业务失败发生在 HTTP 200 的
 * `event:error` 帧里**。后者决定了本适配器与 lobsterai 在结构上的根本差异：
 * **换号循环必须能接住流内抛出的限流错误**，否则多账号切换在这个 provider 上
 * 等于没实现（lobsterai 的错误都在 `!response.ok` 分支里，流一旦开始就没有换号的
 * 余地）。
 *
 * ## 与其它 provider 的关键差异
 *
 * | 项 | 处理 |
 * |---|---|
 * | 鉴权 | `Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` |
 * | `stream` | **恒为 `true`** —— chat 端点只返回 SSE |
 * | 错误判定 | **按 SSE 业务码**，不按 HTTP 状态码（几乎恒为 200），见 `src/trae-cn-errors.ts` |
 * | 端点 | **SOLO 通道** `TRAE_CN_IDE_API_BASE` + `TRAE_CN_CHAT_PATH`（`/api/agent/v3/llm_utils_chat`） |
 * | body | `model` + **`config_name`（= model）** + **`function`（模型来源 function）**，见 `buildBody` |
 * | 网关头 | 见 `src/trae-cn-models.ts` 的 `traeCnSoloHeaders`（与目录拉取共用一份） |
 * | 目录 | **动态 `get_detail_param`（按 function 取并集）+ 静态 11 项回退**，见 `ensureRemoteModels` |
 * | 图片 | **按模型给**：静态表 11 项里 6 项多模态 → `['text','image']`，其余 `['text']` |
 * | 思考等级 | **声明档位**（静态表 8/11 项按 id 补回；SOLO 目录端点不提供档位，见 `applyTraeCnStaticMetadata`），下发字段名 `reasoning_effort_level` |
 *
 * 可原样复用的只有 `src/sse.ts` 的工具函数（它们处理的是 harness 侧的协议层
 * 陷阱，与厂商无关）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { isTraeCnExpired } from './trae-cn-oauth.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import {
  TRAE_CN,
  TRAE_CN_CHAT_PATH,
  TRAE_CN_IDE_API_BASE,
} from './trae-cn-product.js'
import type { TraeCnProduct } from './trae-cn-product.js'
import {
  TRAE_CN_MODELS_TTL_MS,
  TRAE_CN_SOLO_REMOTE_FUNCTION,
  applyTraeCnStaticMetadata,
  fallbackTraeCnCatalog,
  fetchTraeCnDirectory,
  traeCnSoloHeaders,
} from './trae-cn-models.js'
import type { TraeCnModelEntry } from './trae-cn-models.js'
import {
  classifyTraeCnError,
  recordsTraeCnCooldown,
  shouldSwitchTraeCnAccount,
  traeCnContextOverflowHint,
  traeCnCreditsExhaustedHint,
} from './trae-cn-errors.js'
import type { TraeCnErrorAction, TraeCnTerminalScope } from './trae-cn-errors.js'
import { consumeTraeCnStream, serializeTraeCnMessages, traeCnErrorCodeForAction } from './trae-cn-sse.js'
import type { TraeCnStreamOutcome } from './trae-cn-sse.js'

/** 本适配器注册的 provider 路由名（等价于 `TRAE_CN.id`）。 */
export const PROVIDER = 'trae-cn'

/**
 * 单次请求最多换几个账号（含首次）。
 *
 * 与 lobsterai 侧取同一个值（3）：账号池很大时若逐个试完，一次用户请求会打出
 * N 个上游请求，既放大延迟也放大额度消耗。**减 1** 的缘由见 `stream()` 内注释。
 */
const TRAE_CN_MAX_ROTATE = 3

/** 限流/额度/风控类冷却时长（毫秒，1 小时）。 */
const TRAE_CN_COOLDOWN_MS = 3_600_000

/**
 * 思考档位 id → 展示名。
 *
 * ## 为什么是这三个词，而不是 Trae 的原始文案
 *
 * id 取自真机（`light` / `high` / `extra_high`），展示名取**中文**（对齐本插件
 * 其余面向用户的文案语言）。Trae 客户端自己的中文文案是「轻 / 高 / 极高」
 * （`ai.model.reasoning_effort.*`，见官方 `index.mjs` 的 i18n 表），本表在其
 * 前面补上英文原词，让用户在 DSH 里既认得出档位、又对得上 Trae 界面。
 *
 * 未登记的 id 直接回退成 id 本身（与 `buddy-adapter` 的 `EFFORT_NAMES` 同款），
 * 这样真机将来加档位时不会显示成空白。
 */
const TRAE_CN_EFFORT_NAMES: Readonly<Record<string, string>> = {
  light: '轻 Light',
  high: '高 High',
  extra_high: '极高 Extra high',
}

/** 档位 id 的展示名；未登记的 id 回退为 id 本身。 */
function effortDisplayName(id: string): string {
  return TRAE_CN_EFFORT_NAMES[id] ?? id
}

/** 安全读取 Error.message。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 从错误体提取可读 detail 文本。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/**
 * 表外模型在 `4001` 上追加的可读提示。
 *
 * ## 为什么需要它
 *
 * `4001 param is invalid` 在本 provider 上有**两个完全不同的成因**，而上游文案
 * 一模一样：
 *
 * 1. **模型不在可用目录里** —— 用户手输的 id、或历史会话里被剔除的旧 id
 *    （如 `glm-5.3-flash` / `Doubao-Seed-Code` 等 5 项 SOLO 调不了的 id）。
 *    此时网关按 `config_name` 找不到配置，解法是**重选模型**；
 * 2. **请求形态问题**（参数类型、body 字段等）—— 解法是改代码，与模型无关。
 *
 * 不区分的话，用户看到「4001 param is invalid」只会以为是插件坏了，而实际上
 * 他只需要在 Hub 的显示列表里换一个模型。故在**确认模型不在当前目录**时补一句。
 *
 * 措辞刻意指向「显示列表」：那是用户真正能操作的地方（Account Hub 的模型开关），
 * 而不是让他去翻配置文件。
 */
const TRAE_CN_OFF_CATALOG_HINT = '（该模型已不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选）'

/** 将 HTTP 状态码映射为 harness 错误码（仅用于**无业务码**的兜底路径）。 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 把分类动作映射为**无账号池 / 池已试遍时**抛出的错误码。
 *
 * 有账号池时换号循环会先跑完（见 `stream()`）。`switch-account` 在 HTTP 200
 * 的语境下（业务限流）映射为 `RATE_LIMIT`，否则按真实状态码。
 */
function actionErrorCode(action: TraeCnErrorAction, status: number): string {
  if (action === 'backoff') return 'RATE_LIMIT'
  if (action === 'switch-account') return httpErrorCode(status === 200 ? 429 : status)
  return httpErrorCode(status)
}

/** 判断是否为传输级错误（可重试的 TRANSPORT）。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首帧的窗口与两次 chunk 之间的最大静默，均可用环境变量覆盖
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取** ——
 * 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，adapter 的
 * generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstFrameTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_SSE_FIRST_FRAME_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 一个模型在**当前生效目录**里的上下文窗口档位。
 *
 * 只出现在 Trae CN（IDE 路径）：它走动态 `get_detail_param` 目录，部分模型下发
 * `context_window_tokens: {dev, max}` 两档。其余 provider 的适配器不产出本结构，
 * 故 Account Hub 的档位选择列**只会在 Trae CN 面板出现**（Work 侧实测 dev==max，
 * 被解析侧判成「无 Max 档」，同样不渲染）。
 */
export interface TraeCnContextTier {
  /**
   * dev 档：目录公布的默认窗口（`context_window_tokens.dev`，回退 `prompt_max_tokens`）。
   *
   * ⚠️ **dev 优先**是 2026-09-21 统一的口径（早前反向）—— 上游两个字段给的是
   * 不同的数（真机 `glm-5.3`：dev `200000` / `prompt_max_tokens` `168000`），
   * 而官方客户端按 dev 显示 `200K`。取 dev 是为了让两边显示同一个数，
   * 详见 `parseTraeCnDirectory`。
   */
  contextWindow?: number
  /** Max 档：**仅当严格大于 dev 档**时才存在（见 `TraeCnModelEntry.maxContextWindow`）。 */
  maxContextWindow?: number
}

/** `TraeCnAdapter` 的构造选项。 */
export interface TraeCnAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。无目标模型的场景
   * （拉模型目录）省略该参数。
   */
  resolveCredential: (model?: string) => Promise<TraeCnCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link TraeCnAdapterOptions.resolveCredential} 同源。**必须用同一个
   * model 选号**：`refresh` 是「按账号池选号再续期该账号」，若它与解析时用的过滤
   * 口径不同（例如这里漏传 model），就会出现「解析到 B、却刷新了 A」—— B 的过期
   * token 永不更新，用户看到「刚登录好却一直认证失败」而日志全绿（历史上的 S1
   * 缺陷，回归测试见 `tests/unit/lobsterai-wiring.spec.ts`）。
   */
  refresh: (model?: string) => Promise<void>
  /**
   * 注入的目录拉取器；**省略时用内置的 `fetchTraeCnDirectory`**
   * （`POST /api/ide/v1/get_detail_param`，按 function 取并集）。
   *
   * 之所以仍留这个口子：
   * - 测试要能在零网络下替换它；
   * - `src/account-probe.ts` 要能**关掉**目录拉取（传 `async () => []` —— 探测只该
   *   发一次 chat，不该顺带打两个目录请求）。
   *
   * 返回空数组或抛错都等价于「目录不可用」→ 回退静态表。
   */
  fetchRemoteModels?: (credential: TraeCnCredential) => Promise<TraeCnModelEntry[]>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 `TRAE_CN`。 */
  product?: TraeCnProduct
}

/** Trae CN 模型适配器。使用 `Cloud-IDE-JWT` 鉴权，仅支持 SSE。 */
export class TraeCnAdapter extends LlmAdapter {
  private readonly product: TraeCnProduct
  private readonly fetchImpl: typeof fetch
  /** 动态目录缓存（含拉取时刻，用于 TTL 判定）。 */
  private catalog: { entries: readonly TraeCnModelEntry[]; fetchedAt: number } | undefined
  /** 静态回退目录索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, TraeCnModelEntry>

  constructor(private readonly options: TraeCnAdapterOptions) {
    super()
    this.product = options.product ?? TRAE_CN
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(fallbackTraeCnCatalog().map((entry) => [entry.id, entry]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页会用
   * 该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。一旦
   * provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 确保目录就绪（带 TTL）。
   *
   * `listModels` / `resolveModel` / `stream` 三处都会调用：`resolveModel` 可能先于
   * `listModels` 被调用（如直接从历史会话进入），`stream` 需要它来解析
   * `function` 路由（见 {@link functionForModel}）。
   *
   * ## 缓存策略（参照 LobsterAI 的 `clientVersion` 12h 缓存先例）
   *
   * - **成功**：写缓存 + 记时刻，{@link TRAE_CN_MODELS_TTL_MS} 内不再拉取；
   * - **失败/空**：**不写缓存**（下一次调用重试），也不清掉已有缓存 ——
   *   一次网络抖动不该把目录打回静态表；
   * - 拉取本身按「当前凭据」进行，故没有凭据时直接跳过（回退静态表）。
   *
   * 并发调用会各自触发一次拉取（没有 in-flight 去重）：目录拉取是幂等 GET 语义的
   * POST，重复一次的代价远小于引入一个需要处理的共享 Promise 状态。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.catalog !== undefined && Date.now() - this.catalog.fetchedAt < TRAE_CN_MODELS_TTL_MS) return
    try {
      // 目录端点要鉴权，且**不消耗积分**；用与 chat 同源的凭据解析（不传 model：
      // 目录对所有模型一致，故不做逐模型限流过滤，见 AGENTS.md 的账号池约定）。
      const credential = await this.options.resolveCredential()
      if (credential === undefined || credential.access_token.length === 0) return
      const entries = this.options.fetchRemoteModels === undefined
        ? await fetchTraeCnDirectory(credential, { fetchImpl: this.fetchImpl })
        : await this.options.fetchRemoteModels(credential)
      if (entries.length === 0) return
      // 目录既不提供多模态标记，也不提供思考档位（SOLO 端点的
      // `reasoning_effort_config` 恒为 `{support_thinking:false}` 空壳），
      // 两者都由静态表按 id 补回（**不新增条目**，见该函数的说明）。
      this.catalog = { entries: applyTraeCnStaticMetadata(entries), fetchedAt: Date.now() }
    } catch {
      // 远端不可用：回退静态目录（由 catalogEntries 提供）。
    }
  }

  /** 当前生效的目录（动态优先，失败回退静态表）。 */
  private catalogEntries(): readonly TraeCnModelEntry[] {
    return this.catalog?.entries ?? fallbackTraeCnCatalog()
  }

  /**
   * 模型接受的输入模态。
   *
   * 真机目录（2026-09-18）逐项标了多模态：原 16 项里 **12 项支持图片**；剔除 5 项
   * SOLO 不可调 id 后现存 11 项里 6 项（`minimax-m3` 按 SOLO 目录实测改为 false）。
   * 动态目录条目由 `applyTraeCnStaticMetadata` 从静态表补齐该标记；仍缺省的
   * （远端独有 id）**保守判为纯文本** —— 目录里没有的能力不该被假定存在（与
   * `stream()` 的图片拦截同向：宁可报 UNSUPPORTED_CONTENT，也不静默丢图）。
   */
  private inputModalitiesFor(supportsImages: boolean | undefined): readonly ['text'] | readonly ['text', 'image'] {
    return supportsImages === true ? ['text', 'image'] : ['text']
  }

  /**
   * 目标模型应当用哪个 `function` 下发。
   *
   * ## 为什么必须逐模型记来源
   *
   * roster 被 Trae 摊在多个 SOLO function 下，而**一个模型只在其来源 function 下
   * 可调**：`glm-5.3` 不在 `solo_work_lite` 集里，写死 lite 必回
   * `4001 param is invalid`（真机实测）。故动态目录条目自带 `function`，
   * 静态回退条目一律映射到 {@link TRAE_CN_SOLO_REMOTE_FUNCTION}（11 项实测全在
   * remote 集内）。
   *
   * 表外模型（用户手输 / 历史会话里的旧 id）同样回退 remote —— 那是覆盖最广的
   * function，且与静态表口径一致。**表外 id 会恒回 `4001`**（网关按 `config_name`
   * 找不到配置），故错误路径上会补一句可读提示（见 {@link withOffCatalogHint}）。
   */
  private functionForModel(model: string): string {
    const entry = this.catalogEntries().find((candidate) => candidate.id === model)
      ?? this.fallbackIndex.get(model)
    return entry?.function ?? TRAE_CN_SOLO_REMOTE_FUNCTION
  }

  /**
   * 目标模型是否在**当前生效的目录**里（动态优先，回退静态表）。
   *
   * 用途只有一个：区分「模型不在可用目录中」与「其它 `4001`」——
   * 前者换目录/重选即可解决，后者是请求形态问题。判定与
   * {@link functionForModel} **同源同口径**（同一个 `catalogEntries()`），
   * 否则会出现「路由按表外处理、提示却按表内给」的自相矛盾。
   */
  private isModelInCatalog(model: string): boolean {
    return this.catalogEntries().some((candidate) => candidate.id === model)
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const source = this.catalogEntries()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // 模态按目录条目给（静态表 11 项里 6 项多模态）；远端条目无该字段时判纯文本。
      inputModalities: this.inputModalitiesFor(model.supportsImages),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remote = this.catalogEntries().find((entry) => entry.id === model)
    const entry = remote ?? this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      // 模态与 `listModels` **同源同口径**：两处都读同一条目的 supportsImages，
      // 否则选择器显示「支持图片」而请求路径按纯文本处理（或反之），是自相矛盾。
      inputModalities: this.inputModalitiesFor(entry?.supportsImages),
    }
    // 上下文窗口：动态目录给 `context_window_tokens.dev`（回退 `prompt_max_tokens`，
    // 与官方客户端显示的 200K 同口径），静态表给真机 dev 档 —— 两者同口径
    // （都是客户端默认实际使用的窗口）。
    // 用户在 Account Hub 选了 Max 档时由 `effectiveContextWindow` 换成该模型的 Max 档
    // （**纯声明值切换**：请求体一个字段都不动，见该方法说明）。
    if (entry !== undefined) {
      const effectiveWindow = this.effectiveContextWindow(entry, model)
      if (effectiveWindow !== undefined) resolved.context = { contextWindow: effectiveWindow }
    }
    // 思考档位：DSH 的「思考程度」选择器**唯一**的数据源就是本字段
    // （`resolveModel().reasoning`）——不声明时模型选择器里整行不渲染，
    // 用户只能看到「当前模型未提供推理等级」。档位数据来自真机 vscdb 的
    // `reasoning_effort_config`（原 13/16 项、现存 **8/11** 项有档位）。
    // ⚠️ SOLO 目录端点**不提供**档位（`support_thinking` 恒 false、无 options），
    // 故动态条目在 `applyTraeCnStaticMetadata` 里按 id 从静态表补回；
    // 目录将来真带上档位时以目录为准（该函数判据是「条目自己有没有档位」）。
    // 无档位的模型（minimax-m3 / qwen-3.7-plus / Doubao-Seed-Evolving）与不在
    // 表内的模型**保持不声明**：那是诚实的，而不是给一个上游不认的档位。
    const efforts = entry?.reasoningEfforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        // id **逐字符照抄**真机值：它会原样进请求体，规整化会让上游认不出档位。
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: effortDisplayName(id) })),
        ...entry?.defaultReasoningEffort !== undefined && efforts.includes(entry.defaultReasoningEffort)
          ? { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 当前生效目录的逐模型上下文窗口档位（id → dev / Max）。
   *
   * 用途有两个，都必须与 `listModels` / `resolveModel` **同源同口径**：
   * 1. Account Hub 的「显示列表」据此渲染档位单选列（只有 Max 档存在才渲染）；
   * 2. `model.setContextBudget` 据此**校验**用户提交的 window（必须精确等于 dev 或 max 之一）。
   *
   * 三处读的都是同一个 {@link catalogEntries}，否则会出现「UI 上有 Max 档、
   * 切过去却不生效」这种自相矛盾。
   */
  async contextTiers(): Promise<ReadonlyMap<string, TraeCnContextTier>> {
    await this.ensureRemoteModels()
    const tiers = new Map<string, TraeCnContextTier>()
    for (const entry of this.catalogEntries()) {
      if (entry.contextWindow === undefined && entry.maxContextWindow === undefined) continue
      tiers.set(entry.id, {
        ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
        ...entry.maxContextWindow === undefined ? {} : { maxContextWindow: entry.maxContextWindow },
      })
    }
    return tiers
  }

  /**
   * 该模型**本次应当声明的上下文窗口**（dev 档，或用户选中的 Max 档）。
   *
   * ## 机制：只有声明值会变，出站请求体一个字段都不动
   *
   * Trae 的 chat 请求体里**没有**任何档位字段（`buildTraeCnSoloBody` 的字段全集是
   * `messages` / `model` / `config_name` / `function` / `stream` / `tools` /
   * `temperature` / `max_tokens` / `stop` / `reasoning_effort_level`）。所谓「选 Max 档」
   * 只是把**我们向 DSH 声明的窗口**从 dev 换成该模型自己公布的 Max ——
   * 上游本来就按请求实际长度服务，声明值决定的是**宿主何时压缩**（阈值 `0.8 × 窗口`）
   * 与压缩后的保留预算。因此本函数绝不产生任何出站差异。
   *
   * ## 判据：预算值必须**精确命中**目录公布的档位（两条缺一不可）
   *
   * 1. `maxContextWindow` 存在且**严格大于** dev 档（解析侧已保证，这里再判一次，
   *    防手工构造的条目）；
   * 2. 池里存的预算**恰好等于**那个 Max 档。
   *
   * 其余一切情况都退回 dev 档：未设置、预算 == dev、预算是编造值、
   * 目录漂移后旧预算失效（模型下线或 Max 档改值）、以及 max 缺失的模型被写入任意预算。
   * **编造值静默退回默认档是设计**，不是遗漏 —— 用户设置永远不能凭空造出一个
   * 上游不认的窗口；而静默（不报错）是刻意的：回归默认档是安全方向，
   * 报错只会让历史会话在目录浮动后突然打不开。
   */
  private effectiveContextWindow(entry: TraeCnModelEntry, model: string): number | undefined {
    const dev = entry.contextWindow
    if (dev === undefined) return undefined
    const max = entry.maxContextWindow
    if (max === undefined || max <= dev) return dev
    const budget = this.options.accountPool?.contextBudget(this.product.id, model)
    return budget === max ? max : dev
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本基类尚未
   * 提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片：静态表 11 项里 6 项标了多模态，但**本适配器的图片通路未实测**
    // （`serializeTraeCnMessages` 只展平文本块，没有把 image 块编码成上游要的
    // 形态）。故这里明确报错而不是静默丢弃 —— 静默丢弃会让用户以为模型看到了
    // 图片，那比报错更糟。
    //
    // ⚠️ 与 `inputModalities` 的关系（**有意的不一致**，不要「顺手」改掉）：
    // 目录照实报 `['text','image']`（那是模型的能力），而请求路径仍拒绝图片
    // （那是本适配器的能力）。DSH 会在路由层按 `inputModalities` 把图片投影成
    // 文本占位（`projectImagesForTextModel`），所以正常调用到不了这里；
    // 这条抛错是**最后一道防线**，防的是绕过路由层直接调 `stream()` 的路径。
    for (const message of options.messages) {
      if (!Array.isArray(message.content)) continue
      const hasImage = message.content.some((block) =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
      if (hasImage) throw new LlmError('trae-cn: 当前 provider 不支持图片输入', 'UNSUPPORTED_CONTENT')
    }

    // 1. 获取凭据（过期则先静默续期）
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为限流/额度耗尽的
    // 账号（否则每次请求都要先白跑一遍这些账号再换号）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isTraeCnExpired(credential)) {
      await this.options.refresh(options.model)
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('trae-cn: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 记录当前账号（限流时可切换）
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        )
        if (currentAccountId === '') {
          console.warn('[trae-cn] 当前凭据未匹配到账号池条目，限流记录将被跳过')
        }
      } catch (error) {
        console.warn('[trae-cn] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    await this.ensureRemoteModels()
    const body = this.buildBody(options)

    // 3. 发送首个请求（401/403 时先续期一次再重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh(options.model)
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('trae-cn: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }

    /**
     * 已试过的账号 id。
     *
     * 换号时必须传给池：失败类别为 5xx / 请求错误时**不写冷却标记**，
     * 刚失败的账号仍是池里排序第一，不排除就会拿回同一个账号、命中 `tried.has`
     * 而立即中断 —— 换号形同虚设。对齐 Go 的 `PickExcluding(tried)`。
     */
    const tried = new Set<string>()
    let accountId = currentAccountId
    if (accountId !== '') tried.add(accountId)

    /** 最后一次失败的成组状态（message / action / status / 业务码必须同源）。 */
    let lastMessage = ''
    let lastAction: TraeCnErrorAction = 'fail'
    let lastStatus = response.status
    let lastSseCode: string | undefined
    /**
     * 换号循环的**退出原因**，供终报文案决定主语。
     *
     * 留 `undefined` 的三种情形都是刻意的，此时终报**不得**谈「账号」
     * （详见 `traeCnCreditsExhaustedHint` 的表格）：
     * - 没有账号池（单凭据场景，压根没有「其它账号」这回事）；
     * - 失败不是换号类（直报 / 退避）—— 循环本来就不该换号；
     * - 已经透传出正文才失败 —— 降级为直报，与账号数量无关。
     */
    let terminalScope: TraeCnTerminalScope | undefined

    // 4. 换号循环。
    //
    // 这一个循环覆盖**两条**失败路径，因为它们在本 provider 上同等重要：
    // - **HTTP 失败**（无业务码，按状态码分类）：401/403 已在上面处理过一次，
    //   这里接住的是 429/5xx；
    // - **流内业务错误**（HTTP 200 + `event:error`，按业务码分类）：限流 / 额度 /
    //   风控 / 账号失效**全部**走这条 —— 这是本 provider 最主要的失败模式，
    //   也是它与 lobsterai 在结构上的根本差异（后者的错误都在 `!response.ok` 里，
    //   流一旦开始就没有换号的余地）。
    //
    // ⚠️ **上限减 1**：首个账号在循环外已经发过一次请求；不减的话总请求数会变成
    // 1 + MaxRotate，比 `TRAE_CN_MAX_ROTATE` 的设计值多一次。
    const maxRotate = TRAE_CN_MAX_ROTATE - 1
    for (let round = 0; ; round++) {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        lastAction = classifyTraeCnError({ httpStatus: response.status })
        lastStatus = response.status
        lastMessage = `trae-cn: ${errorDetail(text) || `HTTP ${response.status}`}`
        lastSseCode = undefined
      } else {
        // 消费流：chunk **实时透传**（用户要看到逐字输出），同时记录是否已有产出。
        const cell: ConsumeCell = { yielded: false }
        for await (const chunk of this.consumeInto(response, options, cell)) {
          cell.yielded = true
          yield chunk
        }
        const outcome = cell.outcome!

        if (outcome.sseError === undefined && outcome.produced) {
          // 成功收尾。三种「不完整」都必须报告 max-tokens 而非 tool-calls：
          // - 未收到 done 帧：连接被中途掐断，工具参数必然是半截 JSON；
          // - 工具参数无法解析：分片在流式下发中丢失。
          // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，模型收到
          // 莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试（与其它 provider
          // 同策略）。
          yield {
            type: 'finish',
            reason: !outcome.done || outcome.argumentsTruncated
              ? { kind: 'max-tokens' }
              : outcome.hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' },
          }
          return
        }

        if (outcome.sseError === undefined) {
          // 用了 `done` 帧却一个内容块都没有：报 EMPTY_RESPONSE 让 DSH 重试，而不是
          // 把一条空 assistant 消息交给用户（那会静默结束本轮）。**不换号** ——
          // 空回复不是账号问题，换个账号只会再拿到一次空回复。
          throw new LlmError(
            'trae-cn: 上游返回空回复（done 帧后无任何内容块）',
            'EMPTY_RESPONSE',
            { status: response.status },
          )
        }

        lastStatus = response.status
        lastSseCode = outcome.sseError.code === undefined ? undefined : String(outcome.sseError.code)
        lastMessage = `trae-cn: ${outcome.sseError.message}`
          + (lastSseCode === undefined ? '' : ` (code=${lastSseCode})`)
        // 已经透传出内容时不再换号：换号会让用户看到「半截回答 + 完整回答」两段
        // 内容，比直接报错更糟。降级为直报 —— 下面的 `shouldSwitchTraeCnAccount`
        // 因此为假，循环会带着这次失败的真实原因退出。
        //
        // 用 `cell.yielded`（而不是 `outcome.produced`）：前者涵盖所有已发出的
        // chunk（含 `usage`），后者只涵盖正文/思考/工具块。只发过 usage 就失败时
        // 同样不能重来，否则用量会被重复计入。
        //
        // 注意**不要**在这里 break：那样会跳过 `recordCooldown`，让一个真实发生的
        // 限流不留任何痕迹（用户事后无从知道是限流导致的）。
        lastAction = cell.yielded ? 'fail' : outcome.sseError.action
      }

      // **先记冷却，再决定是否换号**。
      //
      // 顺序不能颠倒：`recordCooldown` 只对**换号类**的码写标记（见其说明），
      // 而 `accountId` 在下面会被推进到下一个账号 —— 先记才不会记到别人头上。
      // 退避类（软限流 / 排队）在这里**不写标记**：写了下一次选号就会跳过该账号，
      // 等于偷偷换号，与「排队不换号」的决策相矛盾。
      await this.recordCooldown(accountId, options.model, lastSseCode)

      if (!this.options.accountPool) break
      if (!shouldSwitchTraeCnAccount(lastAction)) break
      // 换号上限：**必须在这里记下退出原因**（见下面的 terminalScope）。
      // 池里还有账号、只是我们不再试了 —— 终报文案不能说「全部账号都已耗尽」。
      if (round >= maxRotate) {
        terminalScope = 'rotate-cap'
        break
      }

      // 走到这里就说明「池里没有下一个可试的账号了」：`getAvailableAccount` 返回空，
      // 或返回的账号已在本轮试过（它被记了冷却标记后仍是排序第一时会出现）。
      // 两种情况对用户都是「换号已到头」，与 `rotate-cap` 刻意区分。
      const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried)
      if (!next || tried.has(next.entry.id)) {
        terminalScope = 'pool-exhausted'
        break
      }
      tried.add(next.entry.id)
      accountId = next.entry.id
      response = await this.send(next.credential as TraeCnCredential, body, options)
    }

    // 5. 试遍候选（或本就没有池、或已产出过内容不能再换号）：抛出**最后一次**的
    // 真实原因，不吞诊断信息。
    //
    // 两条路径的错误码来源不同，不能混用：
    // - **无业务码**（HTTP 层失败）→ 按状态码映射（401→AUTH、429/5xx→可重试）；
    // - **有业务码**（流内业务失败）→ 按业务码映射（`4006` / `4022` →
    //   CONTEXT_WINDOW_EXCEEDED 触发上下文压缩，其余 fail → INVALID_REQUEST）。
    //   若这里误用状态码，一个「请求超长」的业务错误会被映射成 `HTTP_200`，
    //   既不可重试也不触发压缩，用户只看到一句无意义的错误码。
    if (lastSseCode !== undefined) {
      throw new LlmError(
        this.withOffCatalogHint(lastMessage, options.model, lastSseCode)
          + traeCnContextOverflowHint(lastSseCode)
          // 池名传 `'通用积分'`：IDE 路径只扣通用池（`endpoint=0`）。
          + traeCnCreditsExhaustedHint(lastSseCode, '通用积分', terminalScope),
        traeCnErrorCodeForAction(lastAction, lastSseCode),
      )
    }
    throw new LlmError(lastMessage, actionErrorCode(lastAction, lastStatus), { status: lastStatus })
  }

  /**
   * 若本次失败是 `4001` 且目标模型**不在当前目录**里，给错误文案补一句可读提示。
   *
   * 只处理 `4001`：`4023`（模型不存在）上游自带语义、文案已够清楚；`4001` 则
   * 与「请求形态错误」共用同一句话，用户无法自行区分（见
   * {@link TRAE_CN_OFF_CATALOG_HINT}）。
   *
   * 判定用 {@link isModelInCatalog}，与 `function` 路由**同源** —— 两处若用不同
   * 口径，会出现「路由已按表外处理、提示却说模型在表里」的自相矛盾。
   */
  private withOffCatalogHint(message: string, model: string, sseCode: string): string {
    if (sseCode !== '4001') return message
    if (this.isModelInCatalog(model)) return message
    return `${message}${TRAE_CN_OFF_CATALOG_HINT}`
  }

  /**
   * 消费一次流，并把 outcome 写进调用方给的 cell。
   *
   * 为什么用 cell 而不是生成器的 `return` 值：`for await` 会**丢弃** `return` 值
   * （只保留 `break`/`throw` 语义），所以 outcome 必须走旁路。cell 由调用方分配，
   * 每次尝试一个 —— 用实例字段会在嵌套/并发调用时串号。
   */
  private async *consumeInto(
    response: Response,
    options: GenerateOptions,
    cell: ConsumeCell,
  ): AsyncGenerator<StreamChunk, void, void> {
    const inner = consumeTraeCnStream(response, {
      label: 'trae-cn',
      httpStatus: response.status,
      timeouts: { firstFrameMs: resolveFirstFrameTimeoutMs(), chunkMs: resolveChunkTimeoutMs() },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    try {
      cell.outcome = yield* inner
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof LlmError) throw error
      if (isTransportError(error)) {
        throw new LlmError(`trae-cn: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /** 上一次 {@link consume} 的 outcome（生成器的 return 值无法经 `for await` 传出）。 */
  private lastOutcome: TraeCnStreamOutcome | undefined

  /**
   * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
   *
   * 只对 `recordsTraeCnCooldown` 认可的码记录，即**换号类**的限流 / 额度 / 风控码。
   *
   * **退避类（软限流 / 排队）刻意不记**，这是功能性的取舍而非遗漏：
   * 冷却标记的作用是让 `getAvailableAccount` 在**下一次选号时跳过该账号**，
   * 而退避的语义恰恰是「不换号、稍后重试同一个账号」。若给 4007 / 4000005 记上
   * 标记，DSH 重试时账号池会把该账号过滤掉、改用另一个账号 —— 那就等于偷偷换号，
   * 与用户确认的「排队不换号」决策相矛盾（排队是全局状态，换号无益）。
   *
   * 账号失效码（1001/1002/4010/4014）同理不记：唯一的解法是重新登录，
   * 给它记一个「等待重置」的徽章是虚假信息（详见 `trae-cn-errors.ts`）。
   */
  private async recordCooldown(
    accountId: string,
    model: string,
    sseErrorCode: string | undefined,
  ): Promise<void> {
    if (!this.options.accountPool || accountId === '') return
    if (!recordsTraeCnCooldown(sseErrorCode)) return
    try {
      await this.options.accountPool.updateModelRateLimit(
        accountId,
        model,
        Date.now() + TRAE_CN_COOLDOWN_MS,
      )
    } catch (error) {
      console.warn('[trae-cn] 记录限流标记失败（不影响本次请求）:', error)
    }
  }

  /** 构造 chat 请求体（SOLO 通道形态）。 */
  private buildBody(options: GenerateOptions): string {
    return buildTraeCnSoloBody(options, this.functionForModel(options.model))
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: TraeCnCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    // 注意：这里不用 `new Headers(...)` —— Headers 构造器会丢弃/规范化部分头，
    // 普通对象逐字传递（与 credits 模块一致），避免两处请求头形态不一致。
    const headers = traeCnSoloHeaders(credential, 'text/event-stream')
    try {
      // **SOLO 通道**（`/api/agent/v3/llm_utils_chat`）打在 IDE 网关上，
      // 而不是 `product.apiBase`（见 TRAE_CN_CHAT_PATH 的迁移说明）。
      return await this.fetchImpl(`${TRAE_CN_IDE_API_BASE}${TRAE_CN_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`trae-cn: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/**
 * 构造 SOLO 通道的 chat 请求体（**导出的纯函数，便于逐字段单测**）。
 *
 * ## 实测定案的形态（2026-09-19）
 *
 * ```js
 * { messages, model, config_name: model, function, stream: true, tools?, reasoning_effort_level? }
 * ```
 *
 * 与旧 IDE 通道的差异逐项如下，每一条都是「写错就静默失败」的那类：
 *
 * | 项 | 旧 IDE 通道 | **SOLO 通道** |
 * |---|---|---|
 * | `config_name` | 无 | **必填，等于 `model`**（网关按它选配置） |
 * | `function` | 无 | **必填，模型来源 function**（写错必 `4001`） |
 * | 消息 `content` | 字符串 | **`[{type:'text',text}]` 数组** |
 * | `role:"developer"` | 无此角色 | **改写为 `"system"`**（上游不认 developer） |
 * | assistant 的 `tool_calls[].function` | `function` | **改名 `function_call`**（无 er） |
 * | `role:"tool"` | 带 `tool_call_id` | 同左（上游缺它会 400 整条请求） |
 * | `tools[].function.parameters` | 对象 | **JSON 字符串** |
 *
 * ## 消息来源
 *
 * 复用 `serializeTraeCnMessages`（它已处理两条通用协议要求：剔除无法配对的
 * tool_call / tool-result、assistant 正文为空且有 tool_calls 时 `content` 为
 * `null`），再在其结果上做**出站形态改写**。SSE 解析侧**不动** ——
 * `function_call` 是出站改名，入站帧里仍是 `function`。
 *
 * ## 思考字段名维持 `reasoning_effort_level`（**刻意不盲改**）
 *
 * SOLO 通道的第三方可用实现下发的是 `reasoning_effort`，但那是 **SOLO 代际**的
 * 写法，**未做 A/B 验证**；而 `reasoning_effort_level` 有 chat_v3 代际的
 * 三方互证（官方 bundle 的 `resolveReasoningEffortRequestField` + `sT` +
 * `ai_agent.dll` 的 serde 字段块，见 README）。在拿到「同一请求两种字段名哪个
 * 真生效」的对比证据之前，**不因为换了端点就改字段名** —— 那是把一条有证据的
 * 结论换成一条没有证据的猜测。值域 `light` / `high` / `extra_high` 不变。
 *
 * @param options - harness 的生成选项。
 * @param functionName - 目标模型的来源 function（见 `TraeCnAdapter.functionForModel`）。
 */
export function buildTraeCnSoloBody(options: GenerateOptions, functionName: string): string {
  const messages = serializeTraeCnMessages(normalizeSoloRoles(options.messages))
  if (options.system !== undefined && options.system.length > 0) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const body: Record<string, unknown> = {
    messages: messages.map(toSoloWireMessage),
    model: options.model,
    // `config_name` 与 `model` 恒等：网关按 config_name 选配置，而它必须与
    // `model` 一致（实测两个字段都要给，且给成同一个值）。
    config_name: options.model,
    function: functionName,
    // **恒为 true**：chat 端点只返回 SSE。
    stream: true,
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      // ⚠️ **对象 → JSON 字符串**：上游把该字段当字符串绑定，传对象会
      // `4001 parameter type does not match binding data`。
      parameters: JSON.stringify(tool.parameters ?? {}),
    },
  }))
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
  // 思考档位：仅在调用方显式传入时透传（**不主动补档** —— DSH 已按
  // `reasoning.defaultEffort` 在调用方省略时补好，适配器再补一次会与 DSH
  // 的口径分叉）。字段名的证据链见函数头注释。
  if (options.reasoningEffort !== undefined) body.reasoning_effort_level = options.reasoningEffort
  return JSON.stringify(body)
}

/**
 * 把 `role:"developer"` 归一成 `"system"`（**在序列化之前**）。
 *
 * 为什么必须在 `serializeTraeCnMessages` **之前**做：那个函数只认
 * `assistant` / `system` / user 三类，未知角色会落进 user 分支 —— 于是
 * `developer` 会被当成**用户发言**发出去，语义完全错位（上游收到一条用户消息，
 * 而不是系统指令）。归一后再交给它，`developer` 才真的变成 system。
 */
function normalizeSoloRoles(
  messages: readonly { role: string; content: unknown }[],
): readonly { role: string; content: unknown }[] {
  return messages.map((message) =>
    message.role === 'developer' ? { ...message, role: 'system' } : message)
}

/**
 * 把 `serializeTraeCnMessages` 的输出改写成 SOLO 通道的出站形态。
 *
 * 三条改写（**逐条都是实测要求**）：
 * 1. `role:"developer"` → `"system"`（上游没有 developer 角色；实际归一在
 *    {@link normalizeSoloRoles} 里做，此处兜一道防「有人绕过它直接调本函数」）；
 * 2. 字符串 `content` → `[{type:'text',text}]`（`null` 保持 `null`：那是
 *    「assistant 只有工具调用、没有正文」的合法形态，包成数组会让上游读到空文本）；
 * 3. assistant 的 `tool_calls[].function` → **`function_call`**（无 er）。
 */
function toSoloWireMessage(message: Record<string, unknown>): Record<string, unknown> {
  const role = message.role === 'developer' ? 'system' : message.role
  const content = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
  const calls = message.tool_calls
  if (!Array.isArray(calls)) return { ...message, role, content }
  return {
    ...message,
    role,
    content,
    tool_calls: calls.map((call) => {
      if (typeof call !== 'object' || call === null) return call
      const record = call as Record<string, unknown>
      const fn = record.function
      if (typeof fn !== 'object' || fn === null) return record
      // 出站改名：`function` → `function_call`（入站帧仍是 `function`，
      // 故解析侧不用动）。
      const { function: _renamed, ...rest } = record
      return { ...rest, function_call: fn }
    }),
  }
}

/** 一次流消费的旁路结果（`for await` 会丢弃生成器的 `return` 值，故用 cell 传递）。 */
interface ConsumeCell {
  /** 流消费完成后的结果。 */
  outcome?: TraeCnStreamOutcome
  /** 是否已向外透传过 chunk（决定能否安全换号）。 */
  yielded: boolean
}

/**
 * 在 `ctx.llm` 上注册 Trae CN provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到 `trae-cn` /
 * `llm-trae-cn`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因未注册
 * namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 *
 * @returns 刚注册的适配器实例 —— `src/index.ts` 把它转交给 `registerAccountHubRpc`，
 *          供 Account Hub 读取逐模型的窗口档位（`contextTiers`）与校验用户选择。
 *          适配器是**动态目录的唯一持有者**，RPC 层拿不到目录就只能靠猜。
 */
export function registerTraeCnLlm(ctx: Context, options: TraeCnAdapterOptions): TraeCnAdapter {
  const product = options.product ?? TRAE_CN
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  const adapter = new TraeCnAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
