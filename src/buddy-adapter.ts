/**
 * Buddy 系 (腾讯 Buddy CN / Buddy) LlmAdapter
 *
 * 使用标准 OpenAI Chat Completions 协议 + Bearer access_token 鉴权。
 * 认证由 buddy-auth.ts 服务完成（external-link-v2 轮询式登录 + refresh_token 续期）。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 模型列表：静态默认（对齐 /v3/config craft agent models）+ 登录后的动态拉取
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter, LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { availableContextTiers, effectiveContextWindow, type ContextTier } from './context-tiers.js'
import { isQuotaExhausted, isRateLimited, parseQuotaExhausted, parseRateLimitError } from './llm-adapter.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  credentialExpiresAtMs,
} from './buddy.js'
import type { BuddyCredential, BuddyRemoteModel } from './buddy.js'
import { BUDDY_CN, resolveUserAgent, type BuddyFallbackModel, type BuddyProduct } from './product.js'
import { isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing } from './sse.js'

/**
 * Buddy CN（中国版）的 chat completions 基址。
 *
 * 由 `BUDDY_CN.endpoint` 派生（产品配置是唯一真相源）；仅供既有导入方
 * （如 e2e 探针）使用。适配器实例实际请求的基址是
 * `` `${this.product.endpoint}/v2` `` —— 国际版 Buddy 的域名不同
 * （www.workbuddy.ai），故不能再用本常量拼接请求 URL。
 */
export const CHAT_API_BASE = `${BUDDY_CN.endpoint}/v2`

/**
 * 是否为 DeepSeek 系模型（前缀匹配，不区分大小写）。
 *
 * 对齐 workbuddy2api-panel `thinking.go` 的 `isDeepSeekModel` 判定口径与
 * 官方客户端 `thinkingFormat:"deepseek"` 标记：deepseek 系模型「开思考」
 * 必须显式带 `thinking:{type:"enabled"}` + `reasoning_effort` 档位，缺任一
 * 上游都按不思考应答（`reasoning_content` 为空/缺失）。glm/kimi 等其他模型
 * 走各自 thinkingFormat（默认开或 `enable_thinking`），不需要此开关。
 */
function isDeepSeekModel(model: string): boolean {
  return /^deepseek/i.test(model.trim())
}
/**
 * CodeBuddy 的 provider 路由名（历史常量，保留导出以兼容既有导入方）。
 *
 * 注意：适配器实例实际使用的路由名是 `product.id`（`this.product.id`），
 * 本常量只表示 Buddy CN 那一份取值，不再代表所有产品。
 */
export const PROVIDER = 'buddy'

/** 静态默认模型（对齐 /v3/config 返回的 craft agent models；动态拉取失败时的兜底）。 */
const DEFAULT_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
]

/** 默认模型（deepseek-v4-flash，对齐 IDE 默认）。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 模型上下文窗口（对齐 Rust BuddyProvider::context_limit 的静态 fallback 表；
 * 权威来源是 /v3/config 的**最大档**上下文窗口 —— `data.models[].maxInputTokens`
 * 与 `contextWindow.supportedLengths` 的最大档取 min（见 `src/buddy.ts` 的
 * parseModelMeta），由 fetchRemoteModels 动态拉取后经 remoteContextWindows 优先
 * 采用，此表仅作远端不可用时的兜底）。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['deepseek-v4-flash', 1_000_000],
  ['deepseek-v4-pro', 1_000_000],
  ['hy4-preview', 1_000_000],
  ['hy4-preview-x', 1_000_000],
  ['hy3', 192_000],
  ['hy3-x', 192_000],
  ['glm-5.3', 1_000_000],
  ['glm-5.3-flash', 1_000_000],
  ['glm-5.2', 1_000_000],
  ['glm-5.1', 200_000],
  ['glm-5v-turbo', 200_000],
  ['kimi-k3-1', 1_000_000],
  ['kimi-k2.7', 256_000],
  ['kimi-k2.6', 256_000],
  ['minimax-m3', 512_000],
])

/**
 * 模型是否接受图片输入（远端 /v3/config `supportsImages` 不可用时的兜底）。
 *
 * 权威来源是远端下发的 `supportsImages`；此表只在远端未下发该字段时使用。
 * 实测（2026-09 /v3/config）craft agent 的对话模型全部 supportsImages=true，
 * 故这里列出全部对话模型，非对话模型（codewise-* 等）不在此表内。
 */
const IMAGE_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
])

/**
 * 各模型可选的思考等级（远端 `reasoning.supportedEfforts` 不可用时的兜底）。
 *
 * 只列出**可枚举**等级的模型；仅有固定默认 effort 的模型（glm-5.1/kimi-*）
 * 不在此表内，即不向用户暴露等级选择器。
 */
const REASONING_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek-v4-flash', ['low', 'high', 'max']],
  ['deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'xhigh']],
  ['hy4-preview', ['high']],
  ['hy4-preview-x', ['high']],
  ['hy3', ['low', 'high']],
  ['hy3-x', ['low', 'high']],
  ['glm-5.3', ['low', 'high', 'max']],
  ['glm-5.3-flash', ['low', 'high', 'max']],
  ['glm-5.2', ['high', 'xhigh']],
])

/** 思考等级 id → 展示名（对齐 DeepSeek 官方 provider 的命名）。 */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export interface BuddyAdapterOptions {
  credentialRef: CredentialRef
  /** 前缀缓存会话标识（prompt_cache_key）；未提供时随机生成一个。 */
  sessionId?: string
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传。
   * 多账号池据此跳过「对该模型仍有限流/积分耗尽标记」的账号，使不可用账号在
   * **发请求之前**就被排除，而不是先发一次必然失败的请求再换号。
   * 拉模型目录（`fetchModels`）等无目标模型的场景省略该参数。
   */
  resolveCredential: (model?: string) => Promise<BuddyCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link BuddyAdapterOptions.resolveCredential} 同源（同样由
   * `stream()` 从 `options.model` 透传），供「按账号池选号再续期」的实现
   * （如 LobsterAI 的 `refresh`）保持与选号一致的口径。默认单凭据路径忽略它。
   */
  refresh: (model?: string) => Promise<void>
  /** 动态拉取远端模型列表（含上下文窗口与能力，若远端下发）；失败时调用方回退到静态列表。 */
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 读取一张图片的原始字节（图片输入必需）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * UNSUPPORTED_CONTENT，而不是把图片静默丢掉。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
  /**
   * 产品配置；默认为 Buddy CN。
   *
   * 决定请求身份标识（X-Product-Code / User-Agent）、模型元数据的 provider
   * 字段、providerInfo 的展示名，以及 registerBuddyLlm 注册的路由与
   * settingsNs。两个内置产品（Buddy CN / Buddy）共用同一后端与协议，
   * 差异全部由本配置承载。
   */
  product?: BuddyProduct
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
 * 将 harness 对话消息序列化为 Buddy chat-completions 的传输格式。
 *
 * 与 openai_chat/codearts 适配器一致：assistant 的 `tool-call` 块转为
 * `tool_calls`，`reasoning` 块折叠为 `reasoning_content`，user 消息中搭载的
 * 工具结果展开为独立的 `{role: 'tool'}` 消息。
 *
 * 两点 Buddy 特有要求（对齐 Rust buddy.rs）：
 * - assistant 消息**始终**携带 `reasoning_content` 字段（推理模型缺失会 400）
 *   ——与 codearts 的 deepseek-v4 校验一致；
 * - 正文为空且带 tool_calls 时 `content` 必须为 `null`（对齐 openai_chat.rs）。
 */
/** 工具结果内嵌图片的载体文本（与官方 deepseek 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []

  // 工具结果内嵌图片（read_image 等）不能并入 `role:'tool'` 消息：OpenAI 兼容
  // 协议要求每条 tool 消息紧跟其 assistant tool_call，中间插入任何消息都会 400。
  // 故与官方 deepseek 适配器一致：挂起到其后的独立 user 消息统一发出。
  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  // ── 孤儿工具调用清理（会话续命的关键）──
  // OpenAI 兼容协议要求：带 `tool_calls` 的 assistant 消息，其**每一个**
  // tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；反之，
  // `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
  // 400 拒绝整个请求。
  //
  // 工具执行失败时（参数非法、超时、工具不存在……）harness 会把 assistant
  // 的 tool_calls 持久化进会话历史，却写不回结果消息。这条坏历史随后被
  // **每次请求原样重放**，于是后端对之后每一条用户消息都返回 400——表现为
  // "任务突然中断，此后发送任何内容都没有回复"，整个会话彻底报废。
  //
  // 适配器是最后一道防线：发出请求前把无法配对的 tool_calls 与 tool 结果
  // 一并剔除，让会话自愈。宁可丢失一轮工具上下文，也好过整条会话死亡。
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCallBlocks = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
      const toolCalls = toolCallBlocks.map((block) => ({
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
      // 挂起的工具结果图片必须在 assistant 之前发出（对齐官方适配器）：
      // 否则它们会漂到这条 assistant 之后，与产生它们的工具调用脱节。
      flushToolImages()
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    // 工具结果之外的常规内容（含顶层图片）。
    const regular = content.filter((block) =>
      !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'))
    // 含图片时 content 升级为 OpenAI 多模态 parts（Buddy 唯一接受的图片
    // 形态；{type:'image'} 会以 `unsupported content type ... image` 400）。
    //
    // 注意：这里**不能**把「空 Map」也降级为 undefined。`imageUrls` 为 undefined
    // 只发生在整个请求都没有图片时；若图片存在但全部读取失败，map 是**空的**
    // 而非 undefined。降级成 undefined 会让 `[image unavailable]` 占位符也被跳过，
    // 图片静默消失；只有部分失败时（map 非空）才会出现占位符 —— 同一故障两种
    // 表现。保留空 Map 可让 `userContentParts` 统一产出占位符。
    const parts = imageUrls === undefined
      ? undefined
      : userContentParts(regular, imageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 其结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      // 工具结果内嵌的图片（read_image 等）单独收集：文本继续走 `role:'tool'`，
      // 图片挂起到其后的 user 消息 —— 与原实现相比，这里补上了递归分支，
      // 否则图片会被 contentToText 静默丢弃（只留元数据文本）。
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts
            .filter((part) => part.type === 'text')
            .map((part) => String(part.text))
            .join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText,
      })
    }
  }
  flushToolImages()
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
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    const parts = [
      typeof error?.code === 'string' ? error.code : undefined,
      typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/**
 * 将 HTTP 状态码映射为 harness 错误码。
 *
 * 400 需要看**响应体**才能区分「上下文超限」与「普通请求错误」：前者必须归为
 * CONTEXT_WINDOW_EXCEEDED，才能触发 DSH 的 context-overflow 自动压缩恢复
 * （dsh-compaction-basic 监听 `agent/request-error`，只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败压缩上下文并重试）；
 * 若一律标成 INVALID_REQUEST，长会话一旦越过窗口就会直接把裸错误抛给用户。
 *
 * 实测报文（国际版 Buddy，deepseek-v4.1-flash）：
 * ```
 * {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum",
 *  "extError":{"code":"context_length_exceeded","type":"invalid_request_error",...},
 *  "displayMsg":{"en":"The request exceeds the model context limit. ..."}}
 * ```
 * 注意该报文的 `msg` 是「prompt is too long」措辞、`extError.code` 是
 * `context_length_exceeded`，两者都能被 `isContextWindowExceededError` 识别。
 *
 * ⚠️ **2026-09-21 起这是「安全网」而非兜底主力**：声明窗口取最大档（≈1M）后，
 * 正常路径不该撞窗口；万一某个模型真实窗口低于声明值，撞上的是今天实测的
 * `{"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum",
 *   "extError":{"code":"400001",...},"displayMsg":{"en":"The request exceeds the
 *   model context limit. ..."}}` —— `extError.code` 从 `context_length_exceeded`
 * 变成了**纯数字** `400001`，`msg` 也没有 `for this model` 后缀，故**命中的是
 * `displayMsg.en` 那句英文措辞**。判据仍复用宿主的 `isContextWindowExceededError`
 * （不在插件侧自建关键词表，见 lobsterai-errors.ts 的同一先例）；这条映射由
 * `tests/unit/buddy-adapter.spec.ts` 的「安全网」用例钉死，含一条「摘掉
 * displayMsg 就命中不了」的承重点记录。
 *
 * 与 CodeArts 适配器（llm-adapter.ts 的 httpErrorCode）同一判定口径，但
 * **传入原始 body 而非 errorDetail(body)**：`errorDetail` 在能提取到
 * `error.*` / `message` 时会返回拼接后的短文本，从而丢掉 `extError`、
 * `displayMsg` 等字段——实测「仅 msg 文本」这种输入会被
 * `isContextWindowExceededError` 漏判（其正则要求出现 context/for-the-model
 * 字样），而完整 body 因含 `extError.code = context_length_exceeded` 能稳定命中。
 * 判定看完整报文、展示用归一化文本，两者职责不同。
 */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    // 先判上下文超限，再退回通用 INVALID_REQUEST。
    if (isContextWindowExceededError(body)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * SSE 流空闲超时。Buddy 系后端对 SSE 连接有空闲断连策略：模型
 * 生成超长推理或大工具调用参数时，两次 chunk 之间可能静默数十秒。原实现
 * 直接 `await reader.read()` 且没有任何超时——连接被服务端掐断后若对端
 * 既不发数据也不关连接（半开连接），read() 会**永久挂起**，generator 永不
 * 返回，harness 当前步骤既不出结果也不报错，会话永久停留在"运行中"：web
 * 端表现为进度停止、发送按钮置灰、后续"继续"指令完全无响应。
 *
 * 主动以略小于后端超时窗口的间隔检测空闲，超时则取消 reader 并抛可重试
 * 的 TIMEOUT，让 harness 重试该步骤并把控制权交还给用户。
 *
 * 分两个阶段，与 codearts 适配器保持一致：
 * - firstTokenTimeout：等待首个 chunk 的窗口（模型排队 / 长思考时较长）；
 * - chunkTimeout：收到首 chunk 后，两次 chunk 之间的最大静默（每次成功
 *   读取后重置）。
 *
 * 两者均可由环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT 路径，
 * 或线上针对特定模型调优。在每次 stream() 调用时读取，避免模块顶层常量
 * 在 import 时定型导致测试中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** 判断是否为传输级错误。 */
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
 * 把 user 消息内容块转为 OpenAI 多模态 parts；无图片时返回 undefined，
 * 让调用方保持原有的纯字符串路径（无图请求的线上格式不变，避免破坏前缀缓存）。
 *
 * `tool-result` 分支为**递归**，与 `collectImages()` 的递归深度保持一致：
 * 二者若不对称，出现在深层工具结果里的图片会被 collectImages 收进 refs、
 * 却因这里只走一层而在序列化阶段被静默丢弃（连 `[image unavailable]`
 * 占位符都没有）。实测 harness 目前只产生一层嵌套，但既然收集侧已经是
 * 任意深度，序列化侧就必须同样递归，否则是一处埋着的静默丢图。
 */
function userContentParts(
  content: readonly unknown[],
  imageUrls: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> | undefined {
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as {
      type?: unknown
      text?: unknown
      attachment?: { attachmentId?: unknown }
      content?: unknown
    }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      const url = block.attachment?.attachmentId === undefined
        ? undefined
        : imageUrls.get(String(block.attachment.attachmentId))
      // 解析不到字节时留占位文本，而不是静默吞掉整张图。
      parts.push(url === undefined
        ? { type: 'text', text: '[image unavailable]' }
        : { type: 'image_url', image_url: { url } })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      // 递归取内层 parts：内层只要出现图片，hasImage 即为真，
      // 从而让整条消息升级为多模态形态。
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        hasImage = true
        parts.push(...inner)
      } else {
        // 内层无图：保留其文本，避免内容丢失。
        const text = contentToText(block.content)
        if (text.length > 0) parts.push({ type: 'text', text })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/** 收集 user 消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown }; content?: unknown }
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      refs.set(block.attachment.attachmentId, block.attachment)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) collectImages(block.content, refs)
  }
}

/** Buddy 系 (腾讯 Buddy CN / Buddy) 模型适配器。使用 Bearer access_token 鉴权。 */
export class BuddyAdapter extends LlmAdapter {
  /** 本适配器所属的产品配置（默认 Buddy CN）。 */
  private readonly product: BuddyProduct
  private readonly fetchImpl: typeof fetch
  /**
   * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
   * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
   */
  private readonly sessionId: string
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: BuddyRemoteModel[] | undefined
  /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
  private remoteMeta: ReadonlyMap<string, BuddyRemoteModel> = new Map()
  /** 远端下发的模型上下文窗口（**最大档**：min(maxInputTokens, 档位表最大档)）。 */
  private remoteContextWindows: ReadonlyMap<string, number> = new Map()
  /**
   * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
   * 远端缺失时补位；构造时一次性建立，只读。
   */
  private readonly productFallbackIndex: ReadonlyMap<string, BuddyFallbackModel>
  /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
  private readonly productFallbackContextWindows: ReadonlyMap<string, number>

  constructor(private readonly options: BuddyAdapterOptions) {
    super()
    // 默认 Buddy CN，保证既有行为完全不变。
    this.product = options.product ?? BUDDY_CN
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
    const fallback = this.product.fallbackModels ?? []
    this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]))
    this.productFallbackContextWindows = new Map(
      fallback
        .filter((model) => model.contextWindow !== undefined)
        .map((model) => [model.id, model.contextWindow as number]),
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
   * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
   * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
   * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
   * 直接回退到本适配器所属产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   *
   * 展示名同样来自产品配置：Buddy CN 为 'Buddy CN'，
   * Buddy 为 'Buddy'。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
   * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
   */
  /**
   * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
   * 触发一次远端拉取，保证远端的上下文窗口（最大档）能生效。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
    try {
      const models = await this.options.fetchRemoteModels()
      if (models.length > 0) {
        // /v3/config data.models[] 是权威来源（对齐 Rust TUI buddy_context_limits
        // 注入逻辑）：远端下发的上下文窗口优先于静态 fallback 表；
        // 能力字段（supportsImages / reasoning.supportedEfforts）同理。
        // ⚠️ 窗口口径是**最大档**（min(maxInputTokens, supportedLengths 最大档)），
        // 不是 defaultLength —— 见 `src/buddy.ts` 的 parseModelMeta：真机实测
        // defaultLength 是 UI 默认值、不是硬限（320K–1.0M token 全部正常服务）。
        const reconciled = this.reconcileWithFallback(models)
        this.remoteModels = reconciled
        this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]))
        this.remoteContextWindows = new Map(
          reconciled
            .filter((model) => model.contextWindow !== undefined)
            .map((model) => [model.id, model.contextWindow as number]),
        )
      }
    } catch {
      // 远端不可用：回退静态列表
    }
  }

  /**
   * 用产品兜底表校正远端结果。
   *
   * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
   * token 拿到的集合可能是残缺甚至错的 —— 实测 Buddy 的 CLI token
   * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
   * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
   *
   * 有产品兜底表时以它为准：
   * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
   * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）。
   *
   * 没有产品兜底表时原样返回远端结果，保持既有行为。
   *
   * ⚠️ **现行两个产品都带兜底表**（`BUDDY_CN_FALLBACK_MODELS` /
   * `BUDDY_FALLBACK_MODELS`），故生产路径上「原样返回」那一支不会走到 ——
   * 它是给未声明 `fallbackModels` 的自定义产品与测试留的。
   */
  private reconcileWithFallback(models: readonly BuddyRemoteModel[]): BuddyRemoteModel[] {
    const fallback = this.product.fallbackModels
    if (fallback === undefined || fallback.length === 0) return [...models]
    const remoteById = new Map(models.map((model) => [model.id, model]))
    return fallback.map((entry) => {
      const remote = remoteById.get(entry.id)
      // 远端元数据优先（更权威），缺失的字段用兜底表补齐
      return {
        id: entry.id,
        name: remote?.name ?? entry.name,
        ...entry.contextWindow !== undefined || remote?.contextWindow !== undefined
          ? { contextWindow: remote?.contextWindow ?? entry.contextWindow }
          : {},
        // ⚠️ 输出上限与上面同一理由：本函数重建了条目对象，漏掉哪个字段就等于
        // 在该产品上删掉哪个能力 —— 漏了这一行，`resolveModel().defaultMaxTokens`
        // 与请求体的 `max_tokens` 会**同时**退回网关默认 32000（远端明明有值）。
        // 「远端优先、兜底补位」，两边都没有则留 undefined（不编造）。
        ...entry.maxOutputTokens !== undefined || remote?.maxOutputTokens !== undefined
          ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens }
          : {},
        // ⚠️ **档位表必须一并透传**：本函数重建了条目对象，漏掉哪个字段就等于
        // 在该产品上删掉哪个能力。**两个产品都带兜底表**（`BUDDY_CN_FALLBACK_MODELS`
        // / `BUDDY_FALLBACK_MODELS`），故两侧都走这条重建路径 —— 漏了这一行，
        // CN 与国际版的档位列会一起消失，而目录里明明有数据。
        // 兜底表侧没有档位数据（那是快照，不编造），故这里只认远端。
        ...remote?.contextTiers === undefined ? {} : { contextTiers: [...remote.contextTiers] },
        ...entry.supportsImages !== undefined || remote?.supportsImages !== undefined
          ? { supportsImages: remote?.supportsImages ?? entry.supportsImages }
          : {},
        ...entry.reasoningEfforts !== undefined || remote?.reasoningEfforts !== undefined
          ? { reasoningEfforts: [...(remote?.reasoningEfforts ?? entry.reasoningEfforts ?? [])] }
          : {},
        ...entry.defaultReasoningEffort !== undefined || remote?.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort }
          : {},
      }
    })
  }

  /** 模型接受的输入模态：远端 supportsImages 优先，静态表兜底。 */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    const supportsImages = this.remoteMeta.get(model)?.supportsImages
      ?? this.productFallbackMeta.get(model)?.supportsImages
      ?? IMAGE_MODELS.has(model)
    return supportsImages ? ['text', 'image'] : ['text']
  }

  /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
  private effortsFor(model: string): readonly string[] {
    return this.remoteMeta.get(model)?.reasoningEfforts
      ?? this.productFallbackMeta.get(model)?.reasoningEfforts
      ?? REASONING_EFFORTS.get(model)
      ?? []
  }

  /**
   * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
   *
   * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
   * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
   */
  private defaultEffortFor(model: string): string | undefined {
    const declared = this.remoteMeta.get(model)?.defaultReasoningEffort
      ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort
    return declared !== undefined && this.effortsFor(model).includes(declared) ? declared : undefined
  }

  /**
   * 产品级兜底模型目录（`product.fallbackModels`）。
   *
   * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
   * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
   */
  private get productFallbackMeta(): ReadonlyMap<string, BuddyFallbackModel> {
    return this.productFallbackIndex
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.staticFallbackModels()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    // 按本适配器的产品 id 取表，Buddy CN 与 Buddy 的开关互不影响。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  /**
   * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
   *
   * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
   * token 未必能取到完整集合（实测 Buddy 经 CLI token 只能拿到
   * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
   */
  private staticFallbackModels(): readonly { id: string; name: string }[] {
    const productModels = this.product.fallbackModels
    if (productModels !== undefined && productModels.length > 0) {
      return productModels.map((model) => ({ id: model.id, name: model.name }))
    }
    return DEFAULT_MODELS.map((id) => ({ id, name: id }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    // 三级查找：远端最大档窗口 → 产品兜底表 → 通用静态表
    // （对齐 Rust context_limit_for_model 的两级查找，多一层产品级）。
    const declared = this.remoteContextWindows.get(model)
      ?? this.productFallbackContextWindows.get(model)
      ?? CONTEXT_WINDOWS.get(model)
    // 用户选的档位只可能落在**远端目录公布的窗口**上：静态兜底表是快照、没有
    // 档位数据，故远端条目缺席时列表为空，`effectiveContextWindow` 原样返回
    // `declared`（与接线前逐字节等价）。
    // ⚠️ 档位是**纯声明值切换**（只影响宿主压缩阈值与保留预算），请求体一个
    // 字段都不动 —— 见 `tests/unit/buddy-adapter.spec.ts` 的逐字节比对用例。
    const tiers = availableContextTiers(this.remoteMeta.get(model))
    const contextWindow = effectiveContextWindow(
      declared, tiers, this.options.accountPool?.contextBudget(this.product.id, model),
    )
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: this.remoteMeta.get(model)?.name ?? this.productFallbackIndex.get(model)?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // 单次输出上限：远端 `maxOutputTokens` 优先，产品兜底表次之（与
    // supportsImages / reasoningEfforts **同源**：都读 `productFallbackMeta`，
    // **不是** `productFallbackContextWindows` —— 那个 map 只装上下文档位）。
    //
    // **为什么必须声明**：DSH 的 `resolveCallWithInfo` 只在调用方未显式给值时用
    // `defaultMaxTokens` 兜底；适配器不声明就等于把上限永久交给网关默认
    // （实测仅 32000 —— 远端 `auto` / `glm-4.6` 等声明的即为此值）。结果是长回答
    // 与大文件写入在 32000 处被截断成 `finish_reason:'length'`，`turn/end` 报
    // `max-tokens`，UI 显示「已达到输出 token 上限」。真机日志：20 次
    // `turn/end max-tokens`，buddy 系 651 次请求**零** `maxTokens`。
    //
    // 远端与兜底表都没有该模型的值时**保持 undefined**，交回网关默认：
    // 编造偏大的值会被服务端 400 拒绝，偏小则无谓截断用户输出。
    const maxOutputTokens = positiveMaxTokens(
      this.remoteMeta.get(model)?.maxOutputTokens ?? this.productFallbackMeta.get(model)?.maxOutputTokens,
    )
    if (maxOutputTokens !== undefined) resolved.defaultMaxTokens = maxOutputTokens
    // 思考等级：这是"思考强度"选择器出现在模型选择里的唯一入口——composer
    // 读取 resolveModel().reasoning。无等级可选的模型不声明该字段，UI 显示
    // "当前模型未提供推理等级"。
    const efforts = this.effortsFor(model)
    if (efforts.length > 0) {
      const remoteDefault = this.remoteMeta.get(model)?.defaultReasoningEffort
        ?? this.productFallbackIndex.get(model)?.defaultReasoningEffort
      resolved.reasoning = {
        efforts: efforts.map((id) => ({
          id: ReasoningEffortId(id),
          name: EFFORT_NAMES[id] ?? id,
        })),
        ...remoteDefault !== undefined && efforts.includes(remoteDefault)
          ? { defaultEffort: ReasoningEffortId(remoteDefault) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 当前生效目录的逐模型上下文窗口档位（id → 默认档 + 完整档位表）。
   *
   * ## 为什么在适配器上而不是 RPC 层现算
   *
   * 目录的持有者是本实例（懒加载一次、失败静默回退静态表）。`ctx.llm.listModels()`
   * 帮不上忙 —— `LlmRuntime` 会把适配器返回的条目重建成
   * `{provider, id, name, description?, inputModalities?}`，`contextTiers` 这类
   * 额外字段在那一层被丢掉。故由 `src/index.ts` 把本实例交给
   * `registerAccountHubRpc`（见 `ContextTierRegistry`）。
   *
   * ## 数据源与 `resolveModel` **同源同口径**
   *
   * 读的就是 `resolveModel` 用的那份 `remoteMeta`（`parseModelMeta` 的产物）：
   * `contextWindow` 是**生效的默认档**（最大档口径），`contextTiers` 是
   * `supportedLengths` 的整张表。三处（UI 渲染 / RPC 校验 / 实际声明值）读同一份
   * 数据，否则会出现「UI 上有档位、切过去却不生效」这种自相矛盾。
   *
   * ⚠️ **静态兜底表不参与**：它是快照，没有档位数据（不编造）。远端不可用时本
   * 方法返回空表 ⇒ `model.list` 不带窗口字段、档位列整行不渲染 —— 与 Trae CN
   * 静态回退路径同一处置。
   *
   * ⚠️ **过滤条件只看「有没有窗口」**：单档模型（无 `contextTiers`）照样带出去，
   * 由 RPC / UI 用「列表长度 ≥ 2」判定要不要渲染 —— 与 Trae CN 的
   * `contextTiers()` 同一判据，两处都不在这里替 UI 做决定。
   */
  async contextTiers(): Promise<ReadonlyMap<string, ContextTier>> {
    await this.ensureRemoteModels()
    const tiers = new Map<string, ContextTier>()
    for (const model of this.remoteMeta.values()) {
      if (model.contextWindow === undefined && model.contextTiers === undefined) continue
      tiers.set(model.id, {
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.contextTiers === undefined ? {} : { contextTiers: [...model.contextTiers] },
      })
    }
    return tiers
  }

  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
   * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
   * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
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
    // 1. 获取凭据（过期则先静默续期）
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为
    // 限流/积分耗尽的账号（否则每次请求都要先白跑一遍这些账号再换号）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isCredentialExpired(credential)) {
      await this.options.refresh(options.model)
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('buddy: no usable credential; log in first with /buddy-login', 'MISSING_CREDENTIAL')
    }

    // Track current account for rate limit switching
    let currentAccountId = ''
    if (this.options.accountPool && credential) {
      try {
        // provider 实参必须是本适配器所属产品的 id（buddy-cn / buddy）：
        // AccountPool 先按 entry.provider !== provider 过滤账号，写死 'buddy'
        // 时另一产品的账号（provider 不同）永远匹配不到，限流时间
        // 无法归属账号，UI 也永不显示限流标记。
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
        if (currentAccountId === '') {
          // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
          // 此时限流无法归属到具体账号，也就无法在 UI 上显示标记。
          console.warn(`[${this.product.id}] 当前凭据未匹配到账号池条目，限流记录将被跳过`)
        }
      } catch (error) {
        console.warn(`[${this.product.id}] 账号匹配失败（不影响本次请求）:`, error)
      }
    }

    // 能力判定（图片 / 思考强度）必须有远端目录在手：两者都以 /v3/config
    // 下发值为权威，而该拉取是懒加载的。缺了这一步，远端显式 false 会被
    // 静态兜底表覆盖，合法的思考等级也会被误判为不支持而丢弃。
    await this.ensureRemoteModels()

    // 2. 序列化消息
    // 图片：读原始字节并以内联 data URL 发出——这是 Buddy 系唯一接受的
    // 图片形态（{type:'image'} 会被服务端 400 拒绝）。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(`buddy: model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('buddy: image input requires the attachment service.', 'UNSUPPORTED_CONTENT')
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }
    const messages = serializeMessages(options.messages, imageUrls)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    // 3. 构造请求体
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
      // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
      // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
      //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
      //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
      // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
      prompt_cache_key: this.sessionId,
    }
    if (tools !== undefined && tools.length > 0) bodyObj.tools = tools
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 单次请求输出上限。此前**完全没有**下发该字段，上限由网关默认值决定
    // （实测仅 32000），长回答与大文件写入在中途被截断成 `finish_reason:'length'`，
    // UI 报「已达到输出 token 上限」，且本地无从调整。
    //
    // 取值优先级：调用方显式给的 `options.maxTokens`（DSH 会先注入 `resolveModel`
    // 声明的 `defaultMaxTokens`）→ 远端 `maxOutputTokens` → 产品兜底表。
    // 三者皆无则**不发该字段**，保持网关默认（不编造，理由见 `resolveModel`）。
    //
    // ⚠️ 与 AGENTS.md「Buddy 系出站请求体一个字段都不动」的**红线关系**：那条红线
    // **专属于上下文档位机制**（防「用户选的档位」漏进 body、把纯声明值切换变成
    // 协议变更）。本修复是**正交关注点** —— 输出上限，与档位选择无关，且它本来
    // 就是必须下发的权威字段。既有「三种档位下请求体逐字节相同」的用例仍然全绿：
    // `max_tokens` 在三种档位下恒定，且它不在该用例的 forbidden 列表里。
    const maxTokens = positiveMaxTokens(
      options.maxTokens
        ?? this.remoteMeta.get(options.model)?.maxOutputTokens
        ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens,
    )
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    // DeepSeek 思维链开关（逆向官方 codebuddy.js，对齐 workbuddy2api-panel
    // thinking.go）。**实测关键结论（2026-09，直连三站点对照）**：
    //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
    //   - 仅带 reasoning_effort:high → 返回思考（148~250 字符）；
    //   - 仅带 thinking:{type:'enabled'} → 仍为 0（该字段单独无效）；
    //   - 两者都带 → 返回思考。
    // 即 **reasoning_effort 是真正的开关**，thinking 字段单独不生效（保留它是
    // 为对齐官方客户端出站形态，并覆盖未来后端按它判定的情形）。
    // 三站点（workbuddy 国际/中国 UA、codebuddy）行为一致 → endpoint/UA 无关。
    const deepseek = isDeepSeekModel(options.model)
    if (deepseek) {
      bodyObj.thinking = { type: 'enabled' }
    }
    // 思考强度：composer 选中的等级透传为 `reasoning_effort`（实测
    // low/high/max 会显著改变返回的 reasoning_content 长度，服务端真实生效）。
    // 只在该模型确实支持该等级时才发，否则服务端会因非法参数 400。
    const efforts = this.effortsFor(options.model)
    if (options.reasoningEffort !== undefined && efforts.includes(options.reasoningEffort)) {
      bodyObj.reasoning_effort = options.reasoningEffort
    } else if (deepseek && efforts.length > 0) {
      // composer 未选档位（历史请求可能 `adapterDefaults: undefined`）或所选
      // 档位不被支持时，必须补一个档位——否则请求体里只剩 thinking，上游仍按
      // 不思考应答（实测）。回退顺序：声明默认档 → high（对齐官方客户端
      // REASONING_SUPPLEMENTS.defaultEffort 与 thinking.go 的兜底）→ 最低支持档
      // （绝不臆造模型未声明的档位，否则服务端 400）。
      bodyObj.reasoning_effort = this.defaultEffortFor(options.model)
        ?? (efforts.includes('high') ? 'high' : efforts[0])
    }
    const body = JSON.stringify(bodyObj)

    // 4. 发送请求（401/403 时刷新一次凭据后重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh(options.model)
      // 同样传目标模型：刷新后重新选号时要继续跳过已限流的账号。
      credential = await this.options.resolveCredential(options.model)
      if (credential === undefined || credential.access_token.length === 0) {
        throw new LlmError('buddy: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      response = await this.send(credential, body, options)
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      // 限流处理：把当前账号在该模型上的重置时间记录下来，然后逐个尝试
      // 其余可用账号。每个失败账号都会被记录，只有真正试完全部候选才报
      // "所有账号均受限"——避免只试一个就下结论（那会让 UI 显示的限流
      // 状态与实际判定不一致）。
      //
      // 积分/额度耗尽（业务码 11114，中文文案「积分不足」等）是**账号级**的
      // 另一种失败：它不匹配 RATE_LIMIT_PATTERN，若不并进这个分支，换号会被
      // 整体跳过、错误直接抛给用户（HTTP 400 还会把它退化成 INVALID_REQUEST），
      // 用户只能手动停用那个没额度的账号。两种失败都该换号，故这里取并集。
      if (this.options.accountPool && (isRateLimited(errorText) || isQuotaExhausted(errorText))) {
        const tried = new Set<string>()
        if (currentAccountId) tried.add(currentAccountId)

        for (;;) {
          // 限流走服务端声明的重置时刻（抠不到则 1h 兜底）；积分耗尽没有可解析
          // 的重置时刻，用 24h 长冷却挡住该账号——它是需充值才能恢复的终态，
          // 短冷却只会让它被反复选中、每次请求白跑一轮。
          const parsed = parseRateLimitError(errorText, options.model)
            ?? parseQuotaExhausted(errorText, options.model)
          if (!parsed) break
          // 记录当前账号在该模型上的限流重置时间（UI 据此展示限流标记）
          if (currentAccountId) {
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId, parsed.modelId, parsed.resetTimeMs,
            )
          }
          // 取下一个未尝试过的可用账号（同样按本产品 id 过滤，否则另一产品
          // 永远取不到候选账号，限流后无法自动切换）。
          //
          // 必须把 `tried` 传给池：见 `AccountPool.getAvailableAccount` 的说明 ——
          // 池按「重置时间最早到期」排序，刚失败的账号可能仍排第一，
          // 不排除就会拿回同一个、命中下面的 `tried.has` 而立即 break。
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential as BuddyCredential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options)
            return
          }
          errorText = await response.text().catch(() => '')
          if (!isRateLimited(errorText) && !isQuotaExhausted(errorText)) {
            // 新账号失败但既非限流也非积分耗尽：按原错误分类抛出，不要再吞成"均受限"
            throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status })
          }
        }
        // 试完全部候选：两种失败都归为不可重试的 QUOTA_EXCEEDED
        // （积分耗尽更是终态 —— 不充值就永远失败，重试没有意义）。
        throw new LlmError(`buddy: 模型 ${options.model} 所有账号均不可用（限流或积分耗尽），请稍后再试`, 'QUOTA_EXCEEDED')
      }
      throw new LlmError(`buddy: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status })
    }

    // 5. 消费 SSE 流
    yield* this.consumeSse(response, options)
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: BuddyCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(attributionHeaders())
    headers.set('Authorization', `Bearer ${credential.access_token}`)
    headers.set('Accept', 'text/event-stream')
    headers.set('Content-Type', 'application/json')
    headers.set(HTTP_HEADER_DOMAIN, credential.domain ?? this.product.apiDomain)
    headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode)
    // 用量归属头族：后台「使用端」列按这组头归因，缺任一个都会显示为 `-`。
    // 注意 X-Product 是**归属名**（产品名），不是部署类型 —— 历史实现发成
    // `SaaS` 导致后台归因不到产品。
    headers.set('X-Agent-Purpose', 'conversation')
    headers.set('X-IDE-Name', this.product.attributionName)
    headers.set('X-IDE-Type', this.product.attributionName)
    headers.set('X-IDE-Version', this.product.clientVersion)
    headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName)
    // User-Agent 按模型族分档：不同模型线归属不同客户端形态，后台据此分列。
    // 必须用 set 覆盖（attributionHeaders() 注入的框架 UA 键为小写，
    // 但 Headers 键大小写不敏感，set 能正常覆盖）。
    headers.set('User-Agent', resolveUserAgent(this.product, options.model))
    try {
      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`buddy: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 消费 SSE 响应并产出 StreamChunk。
   *
   * Buddy 返回标准 OpenAI SSE：`delta.content` 为正文、
   * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
   * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
   * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('buddy: empty model response body', 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    const toolCalls = new Map<number, { index: number; text: string; callId?: string; name?: string }>()
    const toolOrder: number[] = []
    // tool_call index → 后端签发的真实 id。缺失时回退 call_{index}，
    // 保证 Start/Delta 使用同一 id。
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用：第一次读取用 firstTokenTimeout，
    // 收到首 chunk 后切换为 chunkTimeout 并在每次成功读取后重置。没有这层
    // 保护时，半开的 SSE 连接会让 read() 永久挂起，会话卡死在"运行中"。
    let firstTokenReceived = false

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'buddy', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`buddy: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
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
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            error?: { message?: string }
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              /** 缓存命中的 prompt token 数（与 prompt_cache_hit_tokens 同值）。 */
              prompt_tokens_details?: {
                cached_tokens?: number
                cache_write_tokens?: number
              }
              completion_tokens_details?: { reasoning_tokens?: number }
              prompt_cache_hit_tokens?: number
              prompt_cache_miss_tokens?: number
              /** 费用权重（非 token 数）。 */
              credit?: number
            }
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          if (data.error !== undefined) {
            throw new LlmError(`buddy: ${data.error.message ?? 'unknown error'}`, 'SERVER')
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            let block = blocks.find(candidate => candidate.kind === 'text')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += delta.content
            yield { type: 'text-delta', index: block.index, text: delta.content }
          }
          if (delta?.reasoning_content) {
            let block = blocks.find(candidate => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            block.text += delta.reasoning_content
            yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id.length > 0) {
              toolIds.set(wireIndex, call.id)
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            block.callId = callId
            // 后续参数分片会带上空的 function.name（""），它不是 undefined，
            // 直接覆盖会把首个分片解析出的真实工具名清空，导致
            // `unknown tool ""`。只有非空名字才允许更新。
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
            // 后端在六处回传缓存信息，其中 cached_tokens 同时出现在
            // prompt_tokens_details 与 completion_tokens_details 里，但后者
            // **恒为 0**（实测）——只认 prompt_tokens_details，误取会永远读到 0。
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
              ?? data.usage.prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
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
          // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
          // 伪造出合法外观，让 harness 报 `missing required property` 而
          // 非重试，掩盖真正的分片丢失。
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
    // 三种"不完整"都必须报告 max-tokens 而非 tool-calls，否则 harness 会
    // 执行残缺调用、报 INVALID_ARGS，并把脏参数持久化进会话历史：
    // - 'length'：模型输出被 max_tokens 显式截断；
    // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
    // - 参数分片丢失：后端并行下发多个工具调用时偶发丢分片（实测
    //   session-23851745 turn1 step4，两个并行 `read` 都丢了 `{"file_path": "…`
    //   前缀）。此时报告 tool-calls 会让 harness 执行缺参调用，报
    //   `missing required property "file_path"`，模型收到莫名其妙的参数错误
    //   并陷入重试循环。判定为截断后 dsh 丢弃残缺调用并重试，实测一次即恢复。
    const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
    const reason = finishReason === 'length'
      || finishReason === undefined && toolOrder.length > 0
      || argsTruncated
      ? { kind: 'max-tokens' as const }
      : finishReason === 'tool_calls' || toolOrder.length > 0
        ? { kind: 'tool-calls' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }
}

/** 凭据是否已过期；无法解析过期时间时不判定过期（与 Rust is_expired 一致）。 */
function isCredentialExpired(credential: BuddyCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/**
 * 把候选输出上限规整为「可安全下发的正整数」，否则返回 undefined。
 *
 * 为什么必须过滤：DSH 的 `LlmRuntime.resolveModelInfoFor` 对适配器声明的
 * `defaultMaxTokens` 有**硬校验** —— 非安全整数或 ≤0 会直接抛
 * `adapter returned invalid default maxTokens`（`INVALID_MODEL_MAX_TOKENS`），
 * **整轮对话起不来**（不是降级，是崩）。远端是外部输入，`0` / 负数 / `NaN`
 * 都可能出现，不能在适配器里假设它合法。
 */
function positiveMaxTokens(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 在 ctx.llm 上注册 Buddy 系产品的 provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动：
 * Buddy CN 得到 `buddy-cn` / `llm-buddy-cn`，
 * Buddy 得到 `buddy` / `llm-buddy`。
 * 注意 settingsNs 必须与 `src/index.ts` 的 registerProviderSettings 注册的
 * namespace 保持一致，否则模型设置页会因未注册 namespace 崩溃。
 *
 * @returns 刚注册的适配器实例 —— `src/index.ts` 把它转交给 `registerAccountHubRpc`，
 *          供 Account Hub 读取逐模型的窗口档位（`contextTiers`）与校验用户选择。
 *          适配器是**模型目录的唯一持有者**，RPC 层拿不到目录就只能靠猜
 *          （与 `registerTraeCnLlm` / `registerQoderLlm` 同一约定）。
 */
export function registerBuddyLlm(ctx: Context, options: BuddyAdapterOptions): BuddyAdapter {
  const product = options.product ?? BUDDY_CN
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  const adapter = new BuddyAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
