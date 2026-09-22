/**
 * LobsterAI（有道龙虾）LLM 适配器。
 *
 * 骨架取自 `src/buddy-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * LobsterAI 与腾讯系只在「OpenAI 兼容 + SSE」这一层相同，其余没有一处能照抄。
 *
 * ## 与 `BuddyAdapter` 的关键差异（逐条对应计划文档 §3.5-C）
 *
 * | 项 | 处理 |
 * |---|---|
 * | URL | `${product.apiBase}/api/proxy/v1/chat/completions` |
 * | 请求头 | 只设 `Authorization` / `Content-Type` / `Accept` / `User-Agent` / `X-LobsterAI-Client-*`；**不设**腾讯系归属头 |
 * | `stream` | **恒为 `true`** —— 上游只支持 SSE，`stream:false` 返回 500 |
 * | `tool_choice` | **不适用**：DSH 的 `GenerateOptions` 无该字段，且 body 由本适配器自建，天然不会出现（Go 桥接层要归一化是因为它转发客户端的原始 body） |
 * | `prompt_cache_key` | **不发** —— 那是腾讯后端的前缀缓存机制，此处未实测支持 |
 * | 思考等级 | **不照抄** buddy 的 deepseek 补档逻辑（那是针对腾讯后端实测的）；仅透传 |
 * | 图片 | **不支持**，`inputModalities` 恒为 `['text']`（判定证据链见 {@link LOBSTERAI_IMAGE_MODALITY_NOTE}） |
 *
 * 可以原样复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` /
 * `resolveToolPairing` / `normalizeToolArguments` / `isTruncatedArguments`）——
 * 它们处理的是 **OpenAI 协议层的通用陷阱**，与具体厂商无关。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter, LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { parseRateLimitError } from './llm-adapter.js'
import {
  LOBSTERAI_CHAT_PATH,
  LOBSTERAI_MODELS_PATH,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  isLobsteraiExpired,
  lobsteraiChatHeaders,
  lobsteraiKeyfromBody,
  readNumberField,
  readStringField,
  type LobsteraiCredential,
} from './lobsterai.js'
import { LOBSTERAI, type LobsteraiFallbackModel, type LobsteraiProduct } from './lobsterai-product.js'
import {
  LOBSTERAI_CONTEXT_OVERFLOW_HINT,
  classifyLobsteraiError,
  lobsteraiHarnessErrorCode,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount,
} from './lobsterai-errors.js'
import { isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing } from './sse.js'

/** 本适配器注册的 provider 路由名（历史常量，等价于 `LOBSTERAI.id`）。 */
export const PROVIDER = 'lobsterai'

/**
 * 图片模态**刻意不声明**的判定记录（2026-09-21 取证）。
 *
 * 结论：`inputModalities` 保持 `['text']`，**不补图片出站**。
 * 下面是完整的证据链与取舍，供后来者复核而不是重新猜一遍。
 *
 * ## 已经确证的三件事
 *
 * 1. **远端确实声明图片能力**：真机 `GET /api/models/available` 的
 *    `supportsImage` 在 14 个声明了窗口的模型里 **11 项为 true**（应用日志
 *    `[Auth:getModels] Response data` 逐条可查）。
 * 2. **官方客户端也按多模态用**：`%APPDATA%\LobsterAI\openclaw\state\openclaw.json`
 *    的 `lobsterai-server` 提供者里，同批模型带 `"input": ["text","image"]`，
 *    传输层 `api: "openai-completions"`（`kimi-k3` 还带 `video`）。
 * 3. **协议形态是标准 OpenAI**：装包内 `openclaw` 的
 *    `dist-openai-completions-stream-*.cjs` 把图片块编码为
 *    `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}`
 *    （与 buddy 适配器现在用的形态**逐字节同款**）。
 *
 * ## 为什么仍然不声明（三条独立理由，任一条都足以否决）
 *
 * 1. **我们发不到那个端点**。官方客户端**不直连上游**：它先起一个本地代理
 *    `OpenClawTokenProxy`（应用日志 `started on 127.0.0.1:<port>`），
 *    openclaw 的 `baseUrl` 是 `http://127.0.0.1:<port>/v1`，由该代理注入令牌并
 *    转发到 `{apiBase}/api/proxy/v1`。**图片出站是否被上游 `/api/proxy/v1`
 *    接受，证据全部产生于代理之后的链路**，而我方是直连 —— 「官方能发」推不出
 *    「我们能发」。
 * 2. **没有对上游的直接实测**。上述三条证据里没有一条是「向
 *    `https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions` 发一张
 *    真图并拿到成功响应」。本项目的规矩是「没观察到的东西不猜」——
 *    `reasoning_effort` 当初之所以能接线，是因为有**服务端行为**级的
 *    单变量证据（错值 500、对值 200）；图片没有同等级的样本。
 * 3. **声明错了比不声明更糟**。`stream()` 现在对图片块抛
 *    `UNSUPPORTED_CONTENT`（见下方）。若先声明 `['text','image']` 再补出站，
 *    一旦上游拒绝，用户拿到的会是「选了图片 → 请求失败」，而不是现在这种
 *    「这个模型不吃图」的明确拒绝；更糟的是 DSH 会把图片块**当作已支持**而
 *    路由进这条通道（`src/qoder-adapter.ts` 的注释记着同型教训：
 *    「两处若分叉会让图片被路由进这条**必然丢图**的通道」）。
 *
 * ## 何时可以翻案
 *
 * 拿到「直连上游 + 真图 + 成功响应」的实测样本后：补 `readImage` 桥接
 * （`src/index.ts` 已有 `makeReadImage`，buddy 系在用）、按 `supportsImage`
 * 逐模型给模态、并让 `serializeMessages` 编码 `image_url`。
 * 在那之前，本条与 `stream()` 的拒绝逻辑**必须保持一致**（一处声明、
 * 一处拦截，分叉即静默故障）。
 */
export const LOBSTERAI_IMAGE_MODALITY_NOTE = '远端 supportsImage=true 但出站未支持，保守不声明'

/**
 * 限流重置时间的本地兜底（毫秒，1 小时）。
 *
 * 仅在**解析不出服务端声明的重置时刻**时使用（如纯文本 429）。
 * 取值与 `parseRateLimitError` 内部 JSON 路径下的 fallback 一致，
 * 避免同一场景在不同路径给出不同的冷却时长。
 */
const LOBSTERAI_RATE_LIMIT_FALLBACK_MS = 3_600_000

/**
 * 单次请求最多换几个账号（含首次），对齐 Go 的 `MaxRotate`。
 *
 * Go 在 `server.NewHandler` 中把 `MaxRotate` 默认设为 3（`handler.go:38-40`），
 * 循环写成 `for i := 0; i < h.cfg.MaxRotate; i++`（`handler.go:190`），
 * 注释明写是**防雪崩**：账号池很大时若逐个试完，一次用户请求可能打出
 * N 个上游请求，既放大延迟也放大额度消耗。
 */
const LOBSTERAI_MAX_ROTATE = 3

/**
 * 思考档位的展示名。
 *
 * 与 `src/trae-cn-adapter.ts` 的 `effortDisplayName` 同约定（中英并列，
 * 让选择器在中文界面下也可读）；未登记的 id 回退为 id 本身，
 * 这样真机将来加档位时不会显示成空白。
 *
 * 真机当前只会出现 `high` / `max`（`max` 在出站时被上游映射成 `xhigh`，
 * 但**请求体里发的就是 `max`** —— 映射发生在服务端，插件照抄 `level`）。
 */
const LOBSTERAI_EFFORT_NAMES: Readonly<Record<string, string>> = {
  high: '高 High',
  max: '最高 Max',
}

/** 档位 id 的展示名；未登记的 id 回退为 id 本身。 */
function effortDisplayName(id: string): string {
  return LOBSTERAI_EFFORT_NAMES[id] ?? id
}

/**
 * 目录条目：远端响应与产品兜底表的**共同形状**。
 *
 * 两个来源的字段一一对应（远端 `modelId`/`modelName`/`contextWindow`/
 * `thinkingConfig` → 本结构的 `id`/`name`/`contextWindow`/`reasoningEfforts`），
 * 故解析与展示可以用同一套逻辑，无需在调用点区分来源。
 */
interface LobsteraiCatalogEntry {
  id: string
  name: string
  contextWindow?: number
  reasoningEfforts?: readonly string[]
  defaultReasoningEffort?: string
}

/**
 * LobsterAI 远端模型条目。
 *
 * ⚠️ **2026-09-19 真机复测推翻了早期注释**。早期版本声称远端只返回
 * `modelId`/`modelName`/`provider`/`apiFormat`（依据是 Go 桥接层的
 * `client.go:254-278`），因此本结构刻意比 `BuddyRemoteModel` 更小。
 * 实测真机响应**还带**这些字段，且它们正是「模型选择器比产品少 / 没有思考档」
 * 两个报障的关键数据：
 *
 * | 真机字段 | 用途 |
 * |---|---|
 * | `modelName` | 展示名（旧表用 id 当展示名，故选择器里全是 `qwen3.7-max` 这种裸 id） |
 * | `contextWindow` | 上下文窗口（`null` 表示上游未给，此时不声明） |
 * | `supportsThinking` | 是否支持思考 |
 * | `thinkingConfig.options[].level` | **可选思考档位**（思考档的权威来源） |
 * | `thinkingConfig.defaultLevel` | 默认档位 |
 *
 * 真机响应条目样例（`deepseek-flash`）：
 * `{modelId, modelName:'DeepSeek-V4.1-Flash', contextWindow:1000000,
 *   supportsThinking:true, thinkingConfig:{options:[{level:'off',openclawLevel:'off'},
 *   {level:'high',openclawLevel:'high'},{level:'max',openclawLevel:'xhigh'}],
 *   defaultLevel:'high'}, requestCapabilities:['lobsterai-options-v1'], ...}`
 */
export interface LobsteraiRemoteModel {
  id: string
  name: string
  /** 上下文窗口；真机为 `null` 或缺失时**不声明**（不编造）。 */
  contextWindow?: number
  /** 可选思考档位（真机 `thinkingConfig.options[].level`，已剔除不可用的 `off`）。 */
  reasoningEfforts?: readonly string[]
  /** 默认档位（真机 `thinkingConfig.defaultLevel`）。 */
  defaultReasoningEffort?: string
}

/**
 * 真机实测**会导致 HTTP 500** 的思考档位，解析时剔除。
 *
 * 真机 `thinkingConfig.options` 里含 `off`，但发 `reasoning_effort: "off"` 时：
 * `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
 * 返回 `HTTP 500 {"code":500,"message":"服务器内部错误"}`（3/3 复现），
 * 而 `glm-5.x` 系返回 200。**同一档位在不同模型上行为不一致**，且失败的三个
 * 恰好是默认档模型，用户一旦选择就必然拿到 500。
 *
 * 等价语义的关闭开关是 `none`（实测 200 且 `reasoningChars: 0`），
 * 但真机 `options` 里没有 `none`，故**不自行发明档位**（见任务约束「没观察到
 * 的东西不猜」）—— 只剔除已证实会炸的 `off`，把「关闭思考」留给
 * 不带档位的模型。这个白名单是**实测黑名单**，不是猜测。
 */
export const LOBSTERAI_UNSAFE_REASONING_EFFORTS: readonly string[] = ['off']

/**
 * 解析 `GET /api/models/available` 的响应。
 *
 * ⚠️ **响应形状是「统一信封 + data 直接为数组」**，不是双层嵌套：
 * 真机实测 `{code:0, msg:'...', data:[{modelId, modelName, …}, …]}`，
 * 其中 `data` 就是模型数组。
 *
 * 早期实现按 `data.data` 取值（注释写「外层信封 + 内层 data 数组」），
 * 而 `parseLobsteraiEnvelope` 又**明确拒绝数组**（`Array.isArray(data)` 即判失败），
 * 于是这条路径**恒返回空数组** → 适配器永远回退静态兜底表。
 * 这就是「选择器模型比产品少」的根因：远端目录一次都没被真正采用过。
 * 用插件真实解析器对真机响应实测：修前 `0` 条，修后 `27` 条。
 *
 * 兼容性：仍接受旧的 `data.data` 形态（若有代理层包了一层），
 * 但**主路径是 `data` 直接为数组**。
 */
export function parseLobsteraiModels(body: unknown): LobsteraiRemoteModel[] {
  const raw = readLobsteraiModelsArray(body)
  if (raw === undefined) return []
  const models: LobsteraiRemoteModel[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readStringField(record, 'modelId')
    if (id.length === 0) continue
    const name = readStringField(record, 'modelName')
    const model: LobsteraiRemoteModel = { id, name: name.length > 0 ? name : id }
    // 上下文窗口：真机为 null 时不声明（编一个数会让选择器显示错误容量）。
    const contextWindow = readNumberField(record, 'contextWindow')
    if (contextWindow !== undefined && contextWindow > 0) model.contextWindow = contextWindow
    // 思考档位：真机权威来源。`supportsThinking:false` 时不声明。
    if (record.supportsThinking !== false) {
      const { efforts, defaultEffort } = parseLobsteraiThinkingConfig(record.thinkingConfig)
      if (efforts.length > 0) {
        model.reasoningEfforts = efforts
        if (defaultEffort !== undefined) model.defaultReasoningEffort = defaultEffort
      }
    }
    models.push(model)
  }
  return models
}

/**
 * 从响应体取出模型数组，兼容两种形态。
 *
 * 校验口径与 `parseLobsteraiEnvelope` 一致的部分：`code` 必须为 0
 * （凭据失效时上游倾向返回非 0 或 `data:null`）。差异只在 `data` 允许是数组。
 */
function readLobsteraiModelsArray(body: unknown): unknown[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const code = readNumberField(record, 'code')
  if (code !== undefined && code !== 0) return undefined
  const data = record.data
  if (Array.isArray(data)) return data
  // 兼容（非主路径）：data.data 形态。
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>).data
    if (Array.isArray(nested)) return nested
  }
  return undefined
}

/**
 * 解析真机 `thinkingConfig` → 可用档位 + 默认档位。
 *
 * 档位 id **逐字符照抄**真机 `level`（它会原样进请求体，规整化会让上游认不出）。
 * 剔除 {@link LOBSTERAI_UNSAFE_REASONING_EFFORTS}；默认档若被剔除或不在可用集合内，
 * **不下发默认档**（否则 DSH 会把一个必然失败的档位 materialize 进每次请求）。
 */
function parseLobsteraiThinkingConfig(
  value: unknown,
): { efforts: string[], defaultEffort?: string } {
  if (typeof value !== 'object' || value === null) return { efforts: [] }
  const record = value as Record<string, unknown>
  const options = record.options
  if (!Array.isArray(options)) return { efforts: [] }
  const efforts: string[] = []
  for (const option of options) {
    if (typeof option !== 'object' || option === null) continue
    const level = readStringField(option as Record<string, unknown>, 'level')
    if (level.length === 0) continue
    if (LOBSTERAI_UNSAFE_REASONING_EFFORTS.includes(level)) continue
    if (!efforts.includes(level)) efforts.push(level)
  }
  const declaredDefault = readStringField(record, 'defaultLevel')
  const defaultEffort = efforts.includes(declaredDefault) ? declaredDefault : undefined
  return { efforts, defaultEffort }
}

/**
 * 构造模型列表请求的 query 串（keyfrom 身份载荷）。
 *
 * 注意**不含 `refreshToken`** —— `client.go:229-241` 只用了 `KeyfromBody()`
 * 的字段（firstKeyfrom/latestKeyfrom/version/uuid/userId）。
 * 把 refreshToken 放进 query 既是信息泄露（会进服务端访问日志），
 * 也不是该端点的预期输入。
 */
export function buildLobsteraiModelsQuery(
  credential: LobsteraiCredential,
  clientVersion: string,
): string {
  const body = lobsteraiKeyfromBody(credential, clientVersion)
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value)
  }
  return params.toString()
}

/** `LobsteraiAdapter` 的构造选项。 */
export interface LobsteraiAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/积分耗尽标记」的账号。无目标模型的
   * 场景（拉模型目录）省略该参数。
   */
  resolveCredential: (model?: string) => Promise<LobsteraiCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link LobsteraiAdapterOptions.resolveCredential} 同源。**本
   * provider 的接线必须用同一个 model 选号**：`refresh` 是「按账号池选号再
   * 续期该账号」，若它与解析时用的过滤口径不同（例如这里漏传 model），
   * 就会出现「解析到 B、却刷新了 A」——B 的过期 token 永不更新，用户看到
   * 「刚登录好却一直认证失败」而日志全绿（历史上的 S1 缺陷）。
   */
  refresh: (model?: string) => Promise<void>
  /** 动态拉取远端模型列表；失败时回退到 `product.fallbackModels`。 */
  fetchRemoteModels?: () => Promise<LobsteraiRemoteModel[]>
  /** 解析当前客户端版本号（chat 与模型列表都要带）。 */
  resolveClientVersion?: () => Promise<string>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link LOBSTERAI}。 */
  product?: LobsteraiProduct
}

/** 将消息内容载荷展平为纯文本字符串。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/**
 * 将 harness 对话消息序列化为 OpenAI chat-completions 传输格式。
 *
 * 与 buddy 适配器的差异：这里**不强制** assistant 携带 `reasoning_content`
 * （那是腾讯后端对推理模型的要求，未在 LobsterAI 上实测），
 * 但仍保留其中的**通用协议要求**：
 * - 孤儿工具调用清理（见 `resolveToolPairing` 的说明，后端会 400）；
 * - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）。
 *
 * 图片块在此**不处理**：LobsterAI 是否支持图片输入未实测，
 * `stream()` 已在更早的地方以 `UNSUPPORTED_CONTENT` 拒绝。
 */
function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  // OpenAI 兼容协议要求 tool_call 与 tool 结果严格配对：缺任一侧后端都会
  // 以 400 拒绝整个请求，而这条坏历史会被每次请求原样重放 ——
  // 表现为「会话突然报废，此后所有消息都无回复」。发出前剔除可让会话自愈。
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
        }))
      const reasoning = content
        .filter((block): block is { type: string; text: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
        .map((block) => String(block.text))
        .join('')
      const text = contentToText(content)
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 的结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
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
 * 构造上下文超限失败（本适配器**唯一**的 `CONTEXT_WINDOW_EXCEEDED` 抛出点）。
 *
 * 两处会用到它：无账号池的直报路径，以及换号循环**中途**撞上超限时的提前放行
 * （见 `stream()` 里的说明）。收敛成一个构造函数，是为了让「文案 + 错误码 +
 * status」三者在两条路径上逐字节一致 —— 否则用户会看到两种不同的措辞，
 * 而排查者无从判断它们是不是同一种失败。
 *
 * 文案 = 上游原文（`errorDetail` 归一化）+ 中文补救说明（{@link
 * LOBSTERAI_CONTEXT_OVERFLOW_HINT}）。原文必须保留：真机排障要与上游文档
 * 对得上号，且它是判断「上游到底怎么表述超限」的唯一证据。
 */
function contextWindowError(body: string, status: number): LlmError {
  return new LlmError(
    `lobsterai: ${errorDetail(body)}${LOBSTERAI_CONTEXT_OVERFLOW_HINT}`,
    lobsteraiHarnessErrorCode('context-window', status),
    { status },
  )
}

/**
 * 判断是否为传输级错误（可重试的 TRANSPORT）。
 *
 * 与 buddy 适配器同源：半开连接与 TCP 重置都会以这些特征出现。
 */
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
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量覆盖
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取** ——
 * 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_LOBSTERAI_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** LobsterAI 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class LobsteraiAdapter extends LlmAdapter {
  private readonly product: LobsteraiProduct
  private readonly fetchImpl: typeof fetch
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: LobsteraiRemoteModel[] | undefined
  /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, LobsteraiFallbackModel>

  constructor(private readonly options: LobsteraiAdapterOptions) {
    super()
    this.product = options.product ?? LOBSTERAI
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model]),
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 懒加载远端模型目录（仅拉取一次）。
   *
   * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels`
   * 被调用（如直接从历史会话进入），此时同样需要触发一次拉取。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
    try {
      const models = await this.options.fetchRemoteModels()
      if (models.length > 0) this.remoteModels = models
    } catch {
      // 远端不可用：回退兜底目录（由 staticFallbackModels 提供）。
    }
  }

  /**
   * 静态兜底模型目录。
   *
   * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：
   * LobsterAI 的远端接口是**权威的**，远端可用时应完全采信，
   * 兜底只在远端整体失败时顶替。
   *
   * 兜底表同样携带 `contextWindow` / `reasoningEfforts`（照抄真机），
   * 故远端失败时思考档与窗口**依然可用**（早期版本因远端恒失败 + 兜底表
   * 无这两个字段，用户永远看不到思考档）。
   */
  private staticFallbackModels(): readonly LobsteraiCatalogEntry[] {
    return this.product.fallbackModels
  }

  /**
   * 按模型 id 取目录条目：远端优先，兜底表兜底。
   *
   * 两个来源都可能缺字段（远端 `contextWindow:null`、兜底表缺项），
   * 故逐字段回退而不是整条替换 —— 远端给了窗口但没给档位时，
   * 仍应能从兜底表补上档位。
   */
  private catalogEntry(model: string): LobsteraiCatalogEntry | undefined {
    const remote = this.remoteModels?.find((entry) => entry.id === model)
    const fallback = this.fallbackIndex.get(model)
    if (remote === undefined) return fallback
    return {
      id: remote.id,
      name: remote.name.length > 0 ? remote.name : fallback?.name ?? remote.id,
      contextWindow: remote.contextWindow ?? fallback?.contextWindow,
      reasoningEfforts: remote.reasoningEfforts ?? fallback?.reasoningEfforts,
      defaultReasoningEffort: remote.defaultReasoningEffort ?? fallback?.defaultReasoningEffort,
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
    // 不必拉（省一次无谓 HTTP）。返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.staticFallbackModels()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // 图片输入刻意不声明，判定证据链见 LOBSTERAI_IMAGE_MODALITY_NOTE。
      inputModalities: ['text'] as const,
    }))
  }

  /**
   * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
   *
   * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
   * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
   *
   * ⚠️ 与 `listModels` 的唯一区别就是「不套黑名单、不套门控」——可见性口径
   * （远端优先 / 兜底表）必须同源。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.staticFallbackModels()
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const entry = this.catalogEntry(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      // 与 listModels **同源同口径**：LobsterAI 逐模型区分多模态没有实测依据，
      // 两处一律 `['text']`（判定证据链见 LOBSTERAI_IMAGE_MODALITY_NOTE）。
      // ⚠️ 两处若分叉（一处报 `['text','image']`）会让图片被路由进这条
      // **必然丢图**的通道 —— 与 qoder / trae-cn 的同型约束一致。
      inputModalities: ['text'],
    }
    // 上下文窗口：真机 `contextWindow` 为权威值；真机给 null 的条目**不声明**
    // （早期版本一律写死 131072，比真值小 8 倍，会误导用户判断上下文余量）。
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    // 思考档位：DSH 的「思考程度」选择器**唯一**的数据源就是本字段
    // （`resolveModel().reasoning`）—— 不声明时该行不渲染。
    //
    // 早期版本注释写「刻意不声明，因为未实测」——**该结论已于 2026-09-19 被真机推翻**：
    // 远端 `thinkingConfig` 就是权威档位表，且实测 `reasoning_effort` 被服务端
    // 真实消费（见 `LOBSTERAI_UNSAFE_REASONING_EFFORTS` 的说明）。
    // 无档位的模型（真机 19/27 项）保持不声明 —— 那是诚实的。
    const efforts = entry?.reasoningEfforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        // id **逐字符照抄**真机 level：它会原样进请求体，规整化会让上游认不出档位。
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: effortDisplayName(id) })),
        ...entry?.defaultReasoningEffort !== undefined && efforts.includes(entry.defaultReasoningEffort)
          ? { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` 同款 shim。
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

  /** 解析客户端版本号（未注入时用兜底值）。 */
  private async clientVersion(): Promise<string> {
    if (this.options.resolveClientVersion === undefined) return this.product.fallbackClientVersion
    try {
      return await this.options.resolveClientVersion()
    } catch {
      return this.product.fallbackClientVersion
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片：明确报错而不是静默丢弃（静默丢弃会让用户以为模型看到了图片）。
    // 检查在取凭据之前，省掉一次无谓的凭据读取。
    //
    // ⚠️ **这条拒绝与 `inputModalities` 的 `['text']` 是一对**：一旦哪天补上
    // 图片出站，两处必须**同时**改（判定与翻案条件见
    // {@link LOBSTERAI_IMAGE_MODALITY_NOTE}）。只改一处就是静默故障。
    for (const message of options.messages) {
      if (!Array.isArray(message.content)) continue
      const hasImage = message.content.some((block) =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
      if (hasImage) {
        throw new LlmError(
          'lobsterai: 当前 provider 不支持图片输入',
          'UNSUPPORTED_CONTENT',
        )
      }
    }

    // 1. 获取凭据（过期则先静默续期）
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为
    // 限流/积分耗尽的账号（否则每次请求都要先白跑一遍这些账号再换号）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isLobsteraiExpired(credential)) {
      await this.options.refresh(options.model)
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('lobsterai: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 记录当前账号（限流时可切换）
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
        if (currentAccountId === '') {
          // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
          // 此时限流无法归属到具体账号，UI 上也显示不出标记。
          console.warn('[lobsterai] 当前凭据未匹配到账号池条目，限流记录将被跳过')
        }
      } catch (error) {
        console.warn('[lobsterai] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    await this.ensureRemoteModels()

    // 3. 构造请求体
    const messages = serializeMessages(options.messages)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages,
      // **恒为 true**：上游只支持 SSE，stream:false 会返回 500
      // （`client.go:168-195` prepareChatBody 强制改写）。
      stream: true,
    }
    if (tools !== undefined && tools.length > 0) bodyObj.tools = tools
    // 关于 `tool_choice`：Go 桥接层要把它归一化（`""` / `"none"` / `null`
    // 一律删除，见 `client.go:176-189` 的 `prepareChatBody`），那是因为它
    // **转发任意 OpenAI SDK 客户端发来的原始 body**，无法预知里面写了什么。
    //
    // 本适配器是自己构造 body：DSH 的 `GenerateOptions` 根本没有 `toolChoice`
    // 字段（见 dsh-llm 的 types.d.ts），所以 `tool_choice` 天然不会出现 ——
    // 目标状态（字段缺席）已经达成，无需再写一段无效的归一化代码。
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    if (options.maxTokens !== undefined) bodyObj.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 思考档位下发：字段名 `reasoning_effort`（**2026-09-19 真机定案**）。
    //
    // 证据链（三条独立互证）：
    //   1. **服务端行为**：同一请求只改该字段的值，`bogus-xyz` 与 `off` 返回
    //      HTTP 500、`none` 返回 200 且思考内容为空、`high`/`max` 返回 200 并
    //      带 `reasoning_content` —— 若服务端不解析该字段，未知值不可能 500。
    //   2. **产品自身实现**：LobsterAI 桌面端 `app.asar` 内 openclaw 的
    //      `openai-completions` 传输层在 `supportsReasoningEffort` 时写
    //      `params.reasoning_effort = reasoningEffort`，取值经
    //      `reasoningEffortMap[level] ?? thinkingLevelMap[level] ?? level` 映射。
    //   3. **契约字段**：模型目录 `requestCapabilities: ['lobsterai-options-v1']`
    //      对应的 `lobsterai_options`（version 1）是另一套能力协商，**不**承载档位。
    //
    // 只透传、**不补档**：buddy 那套「deepseek 系必须补档否则不思考」是针对腾讯
    // 后端的实测，LobsterAI 实测不带该字段时照样返回 `reasoning_content`
    // （默认档由服务端决定，与真机目录的 `defaultLevel` 一致），
    // 照搬会造成非法参数 400。
    if (options.reasoningEffort !== undefined) {
      bodyObj.reasoning_effort = options.reasoningEffort
    }
    // **不发 prompt_cache_key**：那是腾讯后端的前缀缓存机制，此处未实测支持。
    const body = JSON.stringify(bodyObj)

    // 4. 发送请求（401/403 时刷新一次凭据后重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh(options.model)
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('lobsterai: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }

    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      // 当前这次失败的**成组**状态（status / kind / body 必须同源）。
      //
      // 用一组可变变量而不是只看循环外的 `kind`：换号循环里
      // `response`、`errorText` 每轮都被覆盖，若单把 `kind` 留在循环外，
      // 就会出现「A 账号的 kind 配 B 账号的 status/body」——
      //   实测：A=402(积分不足) → B=503 时最终 code 变成 SERVER，
      //   用户完全看不到「积分不足」这个真实原因；
      //   且会拿 A 的 kind 去判断「要不要给 B 记限流徽章」，
      //   给 B 写上「该模型限流 1 小时」这种虚假信息。
      let lastStatus = response.status
      let lastKind = classifyLobsteraiError(response.status, errorText)

      // 任何非 2xx 都轮转到下一个账号（对齐 Go `handler.go:218-243`：
      // 那个 switch 每个分支都以 continue 结尾）。策略判定集中在
      // `shouldRotateLobsteraiAccount` 里，不在这里内联条件 ——
      // 否则「策略声明」与「实际行为」两处分叉，后续维护必然互相误导。
      if (this.options.accountPool && shouldRotateLobsteraiAccount(lastKind)) {
        const tried = new Set<string>()
        if (currentAccountId) tried.add(currentAccountId)

        // 换号次数上限，对齐 Go 的 `MaxRotate`（`handler.go:190` 的
        // `for i := 0; i < h.cfg.MaxRotate; i++`，默认值 3 见
        // `server.NewHandler`）。防雪崩：账号池很大时若逐个试完，
        // 一次用户请求会打出 N 个上游请求，放大延迟与额度消耗。
        //
        // ⚠️ **减 1**：Go 的循环计数**包含首个账号**（它每次迭代都
        // `PickExcluding` 取一个号），而本适配器在进入这个循环**之前**
        // 已经用首个凭据发过一次请求了。若这里不减，总请求数会变成
        // 1 + MaxRotate = 4，比 Go 多一次。
        const maxRotate = LOBSTERAI_MAX_ROTATE - 1
        for (let round = 0; round < maxRotate; round++) {
          // 用**本轮**的 lastKind 判断是否该记徽章，而不是循环外的 kind：
          // 只有 Go 里真正 `Cooldown(...)` 的三类才记（见
          // `recordsLobsteraiRateLimit` 的说明），且必须记在**真正失败的那个
          // 账号**上 —— currentAccountId 在下面的循环体里会被推进到下一个账号。
          if (currentAccountId && recordsLobsteraiRateLimit(lastKind)) {
            // 两层取值：优先 `parseRateLimitError` 从错误体里抠出**服务端声明的**
            // 重置时刻；抠不到则用本地兜底。两者都要能落地 ——
            // 若在抠不到时直接跳过记录，UI 上就不会出现任何限流标记，
            // 「重测/重置」按钮也就无从操作。
            const parsed = parseRateLimitError(errorText, options.model)
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              parsed?.modelId ?? options.model,
              // `parseRateLimitError` 内部要求错误体是 JSON（它 `JSON.parse` 取 msg），
              // 而部分上游/网关会用**纯文本** 429。此时它返回 null，这里用
              // 「1 小时后」兜底 —— 与它自己 JSON 路径下的 fallback 同一口径，
              // 也与本插件「标记只是快照、可主动重测」的语义一致。
              parsed?.resetTimeMs ?? Date.now() + LOBSTERAI_RATE_LIMIT_FALLBACK_MS,
            )
          }
          // 必须把 `tried` 传给池：失败类别为 5xx / 请求错误时**不写限流标记**
          // （它们不是限流，不该留徽章），刚失败的账号**仍在数组原位**（候选顺序
          // 即用户手动顺序），不排除就会拿回同一个账号、命中下面的 `tried.has`
          // 而**立即 break** —— 换号形同虚设。对齐 Go 的 `PickExcluding(tried)`
          // （`pool.go:131`）。
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential as LobsteraiCredential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options)
            return
          }
          // 覆盖成组状态：status / kind / body 三者必须一起更新，
          // 否则下面抛出的错误码与实际原因会对不上（见上方说明）。
          errorText = await response.text().catch(() => '')
          lastStatus = response.status
          lastKind = classifyLobsteraiError(response.status, errorText)
          // 新账号也不可轮转时收手：两种情况，处置**完全不同**，故分开写。
          //
          // 1. `context-window` —— 必须在**这一轮**就把原始失败抛出去。
          //    换号循环跑到这里说明「第一个账号已超限、又换了一个账号仍超限」，
          //    而超限是**请求本身**的属性（prompt 太长），与账号无关：继续换下去
          //    只会打出更多必然失败的请求，最后落到下面那句「所有账号均不可用」——
          //    用户会以为是自己账号的问题，而真因（请求太长）被埋在终报里。
          //    直接抛可让宿主立刻压缩上下文并重试。
          // 2. 其它类别（理论上不该出现：`shouldRotate` 只对 `none` 与
          //    `context-window` 为 false，而非 2xx 已排除 `none`）—— 留作防御，
          //    避免将来改动引入死循环。
          if (lastKind === 'context-window') throw contextWindowError(errorText, lastStatus)
          if (!shouldRotateLobsteraiAccount(lastKind)) break
        }
        // 试遍候选：报「均不可用」，并带上**最后一次**的真实原因（不吞诊断信息）。
        throw new LlmError(
          `lobsterai: 模型 ${options.model} 所有账号均不可用（${errorDetail(errorText)}）`,
          lobsteraiHarnessErrorCode(lastKind, lastStatus),
          { status: lastStatus },
        )
      }

      // 上下文超限但没进换号循环（未配账号池，或首个账号就命中）：立刻交给宿主
      // 压缩上下文后重试。**不换号**的理由见 `shouldRotateLobsteraiAccount`。
      if (lastKind === 'context-window') throw contextWindowError(errorText, lastStatus)

      // 积分不足但无账号池（或只有一个账号）：用可读文案明确告知，
      // 而不是抛一个泛泛的 HTTP 错误 —— 这是 LobsterAI 最主要的失败模式。
      if (lastKind === 'hard-credit') {
        throw new LlmError(`lobsterai: 积分不足（${errorDetail(errorText)}）`, 'QUOTA_EXCEEDED', { status: lastStatus })
      }
      throw new LlmError(
        `lobsterai: ${errorDetail(errorText)}`,
        lobsteraiHarnessErrorCode(lastKind, lastStatus),
        { status: lastStatus },
      )
    }

    // 5. 消费 SSE 流
    yield* this.consumeSse(response, options)
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: LobsteraiCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    const clientVersion = await this.clientVersion()
    const headers = new Headers(lobsteraiChatHeaders(credential, this.product, clientVersion))
    try {
      return await this.fetchImpl(`${this.product.apiBase}${LOBSTERAI_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`lobsterai: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 消费 SSE 响应并产出 `StreamChunk`。
   *
   * 上游返回标准 OpenAI SSE。移植了 Go 侧 `Aggregate` 的三处兼容处理：
   * 1. **容忍 `data:` 后无空格**（`sse.go:37-39` 注释写明「龙虾上游实测无空格」）——
   *    这里靠 `line.slice(5).trim()` 天然兼容两种形态；
   * 2. `reasoning_content` 单独成块（`sse.go:74-76`）；
   * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
   *
   * 额外保留 buddy 适配器里两条实测得出的防坑规则（与厂商无关，属协议层）：
   * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，
   *   直接覆盖会清空已解析出的工具名 → `unknown tool ""`；
   * - **`finish_reason` 映射顺序**：`length` / 中途断流 / 参数残缺一律归为
   *   `max-tokens`，否则 harness 会执行残缺 JSON 参数并污染会话历史。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('lobsterai: empty model response body', 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    const toolCalls = new Map<number, { index: number; text: string; callId?: string; name?: string }>()
    const toolOrder: number[] = []
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    /**
     * 是否已通过 `delta.content` 收到过正文。
     *
     * 用途与 Go 的 `gotAnyContent`（`sse.go:72,98`）一致：一旦为 true，
     * 就不再采纳 `message.content` 这条兼容回退路径，避免两种下发形态
     * 同时出现时把内容重复拼接。
     */
    let gotAnyContent = false
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let firstTokenReceived = false

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'lobsterai', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`lobsterai: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
          }
          throw error
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          // 兼容 "data: {...}" 与 "data:{...}"（上游实测无空格）。
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            error?: { message?: string }
            choices?: Array<{
              delta?: {
                // ⚠️ `| null` 不是防御性收窄：上游**真的**会下发 `"content": null`
                // 与 `"reasoning_content": null`（工具调用轮的首帧 / 只带思考的帧）。
                // 只写 `?: string` 会让下面基于 `.length` 的守卫在运行时炸成
                // `TypeError: Cannot read properties of null (reading 'length')`。
                content?: string | null
                reasoning_content?: string | null
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              /** 有的上游把完整消息放在 message 而非 delta（对齐 sse.go:97-102）。 */
              message?: { content?: string | null }
              finish_reason?: string
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
              completion_tokens_details?: { reasoning_tokens?: number }
              prompt_cache_hit_tokens?: number
            }
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          if (data.error !== undefined) {
            throw new LlmError(`lobsterai: ${data.error.message ?? 'unknown error'}`, 'SERVER')
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          // `message.content` 只是**兼容回退**：有的上游把完整消息放在 message
          // 而非 delta 里（对齐 `sse.go:97-102`）。它与 delta 是**互斥**的两种
          // 下发形态，不能同时采纳 —— 一旦某个 chunk 既有 delta.content 又有
          // message.content，无守卫的 `??` 会把两段都拼进去。
          //
          // Go 用 `&& !gotAnyContent`（`sse.go:98`，标志位在 `sse.go:72`
          // 每次写入 delta.content 时置 true）表达「只要已经收到过正文，
          // 就再也不采纳 message 形态」。这里照搬该语义。
          // ⚠️ 守卫必须是 `typeof === 'string'` 而不是 `!== undefined`：
          // 上游会下发 `"content": null`，`null.length` 直接抛 TypeError 并炸掉
          // 整轮（null 与 undefined 的分别正是本处历史缺陷的根因）。
          const deltaContent = delta?.content
          const hasDeltaContent = typeof deltaContent === 'string' && deltaContent.length > 0
          const textDelta = hasDeltaContent
            ? deltaContent
            : (!gotAnyContent && typeof choice?.message?.content === 'string' ? choice.message.content : undefined)
          if (textDelta !== undefined && textDelta.length > 0) {
            if (hasDeltaContent) gotAnyContent = true
            let block = blocks.find(candidate => candidate.kind === 'text')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += textDelta
            yield { type: 'text-delta', index: block.index, text: textDelta }
          }
          // 同上：`reasoning_content: null` 会让 `!== undefined` 守卫放行到 `.length`。
          const reasoningDelta = delta?.reasoning_content
          if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
            let block = blocks.find(candidate => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            block.text += reasoningDelta
            yield { type: 'reasoning-delta', index: block.index, text: reasoningDelta }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            block.callId = callId
            // 只允许非空名字覆盖：后续分片带空串 "" 会清空首个分片解析出的工具名，
            // 表现为 `unknown tool ""`。
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name
            }
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              ...block.name !== undefined ? { name: block.name } : {},
              argumentsDelta: fragment,
            }
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            // 缓存命中字段有多处来源，取首个有值的（与 buddy 侧同口径）。
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
              ?? data.usage.prompt_cache_hit_tokens
              ?? 0
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
                // inputTokens 只计**未命中缓存**的部分，命中部分单列
                // cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
              },
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 按创建顺序关闭每个块
    const textBlock = blocks.find(block => block.kind === 'text')
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name ?? '',
          // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
          // 合法外观，让 harness 报 missing required property 而非重试。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    if (textBlock !== undefined) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    // 三种「不完整」都必须报告 max-tokens 而非 tool-calls：
    // - 'length'：被 max_tokens 显式截断；
    // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
    // - 参数无法解析：分片丢失（并行工具调用时偶发）。
    // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，
    // 模型收到莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试，
    // 实测一次即恢复。
    const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
    const reason = finishReason === 'length'
      || (finishReason === undefined && toolOrder.length > 0)
      || argsTruncated
      ? { kind: 'max-tokens' as const }
      : finishReason === 'tool_calls' || toolOrder.length > 0
        ? { kind: 'tool-calls' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }
}

/**
 * 在 `ctx.llm` 上注册 LobsterAI provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到
 * `lobsterai` / `llm-lobsterai`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因
 * 未注册 namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 *
 * ⚠️ **返回适配器实例**（不是 `void`）：Account Hub 的「显示列表」需要它的
 * `listAllModels()`（不套用户黑名单、也不套目录门控的完整目录，带最终展示名）。
 * DSH 的 `ctx.llm` 只保证 `listModels`、且会把条目重建后丢掉额外字段，故实例
 * 必须由调用方持有并注入 RPC 层（见 `src/account-hub-rpc.ts` 的 `ModelCatalogSource`）。
 */
export function registerLobsteraiLlm(ctx: Context, options: LobsteraiAdapterOptions): LobsteraiAdapter {
  const product = options.product ?? LOBSTERAI
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  const adapter = new LobsteraiAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}

/** 构造远端模型列表请求的完整 URL（供 auth 服务与测试复用）。 */
export function buildLobsteraiModelsUrl(
  product: LobsteraiProduct,
  credential: LobsteraiCredential,
  clientVersion: string,
): string {
  const query = buildLobsteraiModelsQuery(credential, clientVersion)
  const base = `${product.apiBase}${LOBSTERAI_MODELS_PATH}`
  return query.length > 0 ? `${base}?${query}` : base
}

/** 模型列表请求超时（与其它控制面请求一致）。 */
export const LOBSTERAI_MODELS_TIMEOUT_MS = LOBSTERAI_REQUEST_TIMEOUT_MS
