import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError,
  isQuotaExceededError, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import type { RemoteModel } from './models.js'
import { signRequestHuawei } from './sign.js'
// 单凭据 ref 的**唯一真相源**（`CODEARTS_ACCESS_TOKEN`）：目录门控要判它是否
// 可解析，写死字面量会在改名时静默失配。⚠️ 本导入不构成循环依赖 ——
// `service.ts` 不 import 本模块（它只依赖 account-pool / login / oauth / models）。
import { CODEARTS_CREDENTIAL_REF } from './service.js'
import { isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing } from './sse.js'
import type { CodeArtsCredential } from './types.js'

export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'
export const PROVIDER = 'codearts'

// DeepSeek V4（CodeArts Agent 模型列表新增，UI 标注"每日 1000 万免费 Tokens"福利）：
// e2e 实测（2026-08-20，对齐 deveco-code 62834ff6）后端实际注册的模型 ID：
// - deepseek-v4-flash（无日期后缀）✅ 可直接收发消息
// - deepseek-v4-flash-0731（IDE 列表显示的带日期后缀 ID）❌ 后端返回
//   InferHub.002002009.404 "The model is not registered"——后端未注册此 ID
// - deepseek-v4-pro ✅ 可直接收发消息
// 结论：IDE 模型列表显示的 flash ID 与后端实际注册 ID 不一致，使用无后缀的 deepseek-v4-flash。
const DEFAULT_MODELS: readonly string[] = [
  'GLM-5.2', 'GLM-5.1', 'GLM-5',
  'glm-5.3-flash',
  'openpangu-2.0-flash', 'openpangu-2.0-pro',
  'deepseek-v4-flash', 'deepseek-v4-pro',
]

/**
 * 模型上下文窗口**静态兜底表**（最大合并请求+响应 token 数）。
 *
 * ⚠️ **远端优先，此表为兜底快照**：`resolveModel()` 先读远端目录下发的
 * `context_window`（`src/models.ts` 的 `RemoteModel.contextWindow`），只有远端
 * 整体拉取失败、或该模型未下发该字段时才落到这里。故本表**不追求与远端逐项
 * 追平**，它的职责只有一条：远端不可用时声明值不发生漂移。
 *
 * - GLM-5.2：202752（对齐 CodeArts Agent IDE 模型卡标注）。
 * - GLM-5.1：202752（**推断**自 IDE 内置 KERNEL_MODELS 的硬证据取值为 202752；
 *   与 GLM-5.2 同口径）。
 * - glm-5.2-sft-harmony：202752（**推断**：GLM-5.2 系的 SFT/harmony 变体，按
 *   GLM-5.2 同一口径处理；无独立旁证）。
 * - glm-5.3-flash：1048576（1M，逆向自 IDE gateway/config，对齐 deveco-code-rust 90aeb17d）。
 * - deepseek-v4-flash / deepseek-v4-pro：1048576（1M，UI 标注）。
 * - ⚠️ **openpangu-2.0-flash / openpangu-2.0-pro 与 GLM-5 刻意留空**：三者
 *   在 IDE 模型卡、内置 KERNEL_MODELS、远端目录**三方都没有窗口旁证**。宁可让
 *   宿主按「未声明」处理，也不编造一个数字 —— 声明错值会直接改写它的压缩时机
 *   （与「不猜」原则一致）。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['GLM-5.2', 202752],
  ['GLM-5.1', 202752],
  ['glm-5.2-sft-harmony', 202752],
  ['glm-5.3-flash', 1_048_576],
  ['deepseek-v4-flash', 1048576],
  ['deepseek-v4-pro', 1048576],
])

/**
 * glm-5.3-flash（CodeArts Agent 后端新增模型，2026-08 加入）是 benefit（免费额度）
 * 模型：chat 请求必须携带 `maas_type: benefit` 请求头且参与 SDK-HMAC-SHA256
 * 签名，否则后端返回 InferHub.002002009.404 "model is not registered"。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（snap-access/api/v2/chat/completions），
 * 对齐 deveco-code-rust 90aeb17d（codearts.rs chat_stream signer + e2e 实测）。
 */
const MAAS_TYPE_BENEFIT_MODELS: ReadonlySet<string> = new Set(['glm-5.3-flash'])

export interface CodeArtsAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/积分耗尽标记」的账号（见 `buddy-adapter`
   * 的同类说明）。无目标模型的场景（拉模型目录）省略该参数。
   */
  resolveCredential: (model?: string) => Promise<CodeArtsCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link CodeArtsAdapterOptions.resolveCredential} 同源，供
   * 「按账号池选号再续期」的实现保持与选号一致的口径；默认单凭据路径忽略它。
   */
  refresh: (model?: string) => Promise<void>
  /**
   * 动态拉取远端模型列表；失败时调用方回退到静态列表。
   *
   * ⚠️ 目录项带 `contextWindow`（远端 `context_window`）时，`resolveModel`
   * **优先采用远端值**；字段缺失才回退静态兜底表。
   */
  fetchRemoteModels?: () => Promise<RemoteModel[]>
  fetchImpl?: typeof fetch
  chatId?: string
  sessionId?: string
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
}

/**
 * 将消息内容载荷展平为纯文本字符串。Harness 消息
 * 以 OpenAI 风格的块数组形式携带内容（`[{type:'text',...}]`，且
 * 助手历史可能包含 `{type:'reasoning',...}` 块）；CodeArts
 * 端点会拒绝非 `text` 块类型并返回空流，因此只保留
 * `text` 块并拼接。
 */
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
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；`reasoning`
 * 块折叠为 `reasoning_content` 字段（deepseek-v4 等推理模型的后端
 * 校验要求 assistant 消息必须携带该字段，缺失会报 "Missing
 * `reasoning_content` field"）；工具结果（搭载在 harness 用户消息中）
 * 展开为独立的 `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 其余非文本块（图片）被丢弃，与端点接受的格式一致。
 */
function serializeMessages(messages: readonly { role: string; content: unknown }[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  // 剔除无法配对的工具调用/结果（详见 resolveToolPairing）：孤儿 tool_calls
  // 会让后端对之后每一条消息都返回 400，整个会话永久报废。
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
      wire.push({
        role: 'assistant',
        content: contentToText(content),
        // 后端（deepseek-v4-flash/pro）校验要求 assistant 消息必须包含
        // reasoning_content 字段：历史里的推理块在上一轮被持久化，回传时
        // 若缺失该字段会直接 400（"Missing `reasoning_content` field"）。
        // 始终携带该字段（无推理时为空串），确保字段存在。
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；将每个展开为
    // 独立的 role:'tool' 传输消息，与 deepseek 适配器的行为一致。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    // 纯文本 user 消息（字符串 content）需原样传递：contentToText 处理
    // 字符串时直接返回，但这里不能用 `content`（非数组时为 []）——否则
    // 字符串 user 消息会被序列化成空串，模型看不到任务指令。
    const text = contentToText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 tool_call 其结果同样会让后端 400。
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

/**
 * 判断模型是否为 deepseek-v4 系列（flash/pro）。
 *
 * deepseek-v4 对标准 OpenAI 格式的 `tool_calls.arguments` 采用一次性打包
 * 生成：模型在生成超大工具参数（如 2000 行 write content）期间 SSE 流
 * 长时间无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），
 * 且后端不会对任何请求头发送心跳保活（实测 2026-08-22：无论是否携带
 * app-id/plugin-name/x-ot-* 等 IDE 头、是否带 `accept: text/event-stream`、
 * `tool_stream`、调整 `max_tokens`，SSE 流均无 `:` 注释行，60s 静默必断）。
 *
 * 但 deepseek-v4 原生支持 DSML 工具调用格式：工具调用直接写入
 * `delta.content`（形如 `<｜DSML｜tool_calls>...`），走与 reasoning 相同的
 * 流式通道。实测（2026-08-22 e2e 探测）：1000 行 write content 的 DSML
 * 流全程最大静默仅 204ms，146s 完整结束；标准 tool_calls 模式 100 行也
 * 会在 17.7s 静默后一次性到达、300 行即 60s 断连。因此对 deepseek-v4
 * 模型将工具 schema 注入 system 消息、请求体不发送 `tools` 字段，让模型
 * 以 DSML 流式输出工具调用，从根上规避网关空闲断连。
 */
function isDeepseekV4Model(model: string): boolean {
  return /^deepseek-v4-(flash|pro)$/.test(model)
}

/**
 * 工具名匹配大参数写文件类工具（content/arguments 可能达到数万 token）。
 * 仅用于对非 deepseek-v4 模型的 DSML 模式降级判定（当前全量模式不再使用此列表）。
 */
const DSML_LARGE_PARAM_TOOLS = ['write', 'file_write', 'apply_patch']
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * deepseek-v4 模型始终走 DSML 模式（不论工具列表中包含什么工具），原因：
 * - 标准 `tool_calls` 模式要求参数一次性打包生成，SSE 流在生成参数期间长时间
 *   无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），且后端不对
 *   任何请求头发送心跳保活；
 * - 除 write/file_write/apply_patch 外，`subagent` 的 `prompt` 参数也可能很长
 *   （包含详细任务描述与上下文），同样面临网关断连风险；
 * - DSML 模式使工具调用通过 `delta.content` 流式输出（全程有数据流），从根上
 *   规避网关空闲断连，实测 1000 行 write content 的 DSML 流全程最大静默仅
 *   204ms，146s 完整结束；
 * - 模型行为统一，避免不同步骤间标准/DSML 模式切换引入的不一致。
 *
 * 非 deepseek-v4 模型（如 openpangu / GLM-5.2 等）使用华为标准 IAM AK/SK 鉴权，
 * 不走 CodeArts Agent APIG 网关，无 60s 空闲断连问题，继续保持标准 tool_calls。
 */
function needsDsmlToolMode(model: string, _toolNames: readonly string[]): boolean {
  return isDeepseekV4Model(model)
}

/**
 * 构造让 deepseek-v4 以原生 DSML 格式调用工具的 system 提示。
 *
 * 适配器不把 `tools` 字段发给后端（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，
 * 并明确要求模型使用 `<｜DSML｜tool_calls>` 语法。`parseDsmlToolCalls`
 * 会把模型输出的 DSML 块解析为结构化 tool-call，harness 无需感知差异。
 */
function buildDsmlSystemPrompt(tools: Array<{
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}>): string {
  const toolJson = JSON.stringify(tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  })), null, 2)
  return [
    '以下是你可用的工具及其 JSON Schema。当需要调用工具完成任务时，',
    '必须使用原生 DSML 工具调用语法输出，格式如下：',
    '<｜DSML｜tool_calls><｜DSML｜invoke name="工具名"><｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    '',
    '规则：',
    '- 工具名必须是下面列表中的 name。',
    '- 每个参数用一个 <｜DSML｜parameter> 标签包裹，参数值放在标签之间。',
    '- 字符串参数加 string="true" 属性；对象/数组/数字/布尔参数不要加该属性。',
    '- 一次可以输出多个 <｜DSML｜invoke> 调用（工具可以并行）。',
    '- 文件内容请一次性完整写入单个 write 调用的 content 参数，不要拆分或省略。',
    '',
    '工具列表（JSON Schema）：',
    toolJson,
  ].join('\n')
}

/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export const QUEUE_STATUS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status'

/** 在 CodeArts 队列中等待时的轮询间隔。 */
const QUEUE_RETRY_DELAY_MS = 10_000
/** 轮询上限：180 × 10 秒 = 30 分钟，与 deveco-code 参考实现一致。 */
const QUEUE_MAX_ATTEMPTS = 180

/**
 * SSE 流空闲超时。CodeArts 后端 / APIG 网关对 SSE 连接有 ~60 秒无数据即
 * 断开的策略：当模型生成超长推理或大工具调用参数时，两次 chunk 之间可能
 * 静默数十秒，连接被服务端掐断后 Node undici 的 reader.read() 抛
 * `TypeError: terminated`。该错误非 HarnessError，被 normalizeLlmFailure
 * 归类为 UNKNOWN（不可重试），harness 直接失败。
 * 主动以略小于网关超时的窗口检测空闲：超时则取消 reader 并抛可重试的
 * TIMEOUT，让 harness 重试该步骤（历史已持久化，重试会带相同上下文）。
 *
 * SSE 流超时配置（对齐 CodeArts Agent IDE agentkernelServer 逆向实证：
 * `firstTokenTimeout = 300000` / `chunkTimeout = 600000`）。
 *
 * 历史背景：原实现用单一 `SSE_IDLE_TIMEOUT_MS = 55_000`（55s），对齐
 * APIG 网关 ~60s 空闲断连。但 deepseek-v4-flash 生成大文件 write 工具
 * 调用的 content 参数时，会先输出 file_path 参数然后长时间静默（模型
 * 在内部做长文本生成但不在 SSE 上 flush），实测三次均在 ~55s 处被掐断、
 * 重试后又重复相同模式——55s 对这类"思考型长生成"太短。
 *
 * IDE 的方案是拆成两个超时：
 * - firstTokenTimeout=300s：等第一个 token 的窗口，到点才报错
 * - chunkTimeout=600s：每收到一个 chunk 就重置；两次 chunk 之间超过 10 分钟才报错
 *
 * 两者均可通过环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT
 * 路径，或在线上针对特定模型调优。环境变量在每次 stream() 调用时读取，
 * 避免模块顶层常量在 import 时定型、测试运行中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 300_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 600_000
}

/**
 * 判断一个错误是否为 SSE 传输级故障（连接被对端掐断 / socket 重置 /
 * undici 内部 socket 错误），而非业务错误。这类错误可安全重试整个
 * chat 请求，因此映射为可重试的 TRANSPORT code，而非 UNKNOWN。
 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  // undici / Node 流在连接被对端关闭时抛 "terminated"
  if (message.includes('terminated')) return true
  // undici socket 错误（UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT 等）
  if (error.name.startsWith('UND_ERR_')) return true
  // fetch 网络层失败
  if (message.includes('fetch failed')) return true
  // TCP 重置 / 对端中断
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * SSE 流内可重试的排队/限流错误信号。CodeArts 后端有时以 HTTP 200 +
 * SSE 内嵌错误的形式返回排队/限流（如 `InferHub.ModelArts.81111.429`
 * TPM 超限），而不是 4xx——适配器把这种响应当成排队处理：延迟后
 * 重新发起整个 chat 请求，与 TM.00001041 行为一致。
 */
class SseQueueRetryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseQueueRetryError'
    this.code = code
  }
}

/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
  readonly status: 'waiting' | 'working' | 'error' | 'queue_full'
  readonly queuePosition: number
  readonly message: string
}

/** 判断 HTTP 错误体是否表示 CodeArts 并发排队限流。 */
function isQueueError(status: number, body: string): boolean {
  return status === 400
    && (body.includes('TM.00001041')
      || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body)
      || /high\s+demand|too\s+many\s+requests/i.test(body))
}

/**
 * 判断 HTTP 错误是否表示凭据已失效、可通过 refresh_token 续期后重试。
 * CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
 * `APIG.0602`（"Invalid token"），HTTP 状态通常是 401，但也观察到 403。
 * 本适配器在入口已按 expires_at 预判过期，但 SecurityToken 可能被后端
 * 提前吊销、或本地时钟与签发端有偏差——此时首次请求会命中本错误。
 * 策略：触发一次静默 refresh，用新 AK/SK/SecurityToken 重试一次；仍失败
 * 才抛 AUTH，避免把可自愈的瞬时鉴权失败暴露给用户。
 */
function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  return body.includes('APIG.0602') || /invalid\s+token|token\s+expired|token\s+is\s+invalid/i.test(body)
}

/**
 * 判断 SSE 流内返回的 error_code 是否属于可重试的排队/限流错误。
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 */
function isSseQueueErrorCode(code: string): boolean {
  return code === 'TM.00001041'
    || /81111|TPM|429|rate.?limit|too many requests|排队|限流/i.test(code)
}

/** 从错误体提取可分类的 detail 文本（OpenAI 风格 error 或 CodeArts error_code/error_msg）。 */
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
      typeof data.error_code === 'string' ? data.error_code : undefined,
      typeof data.error_msg === 'string' ? data.error_msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体：直接用原文分类。
  }
  return body
}

/**
 * 将 CodeArts 错误响应归一化为 harness 错误码，与 deepseek 适配器的
 * httpErrorCode 词汇一致：400 且命中上下文超限措辞时归为
 * CONTEXT_WINDOW_EXCEEDED（触发 dsh compaction 自动压缩上下文），
 * 而不是不可重试的 HTTP_400，避免长会话在接近窗口上限时直接中断。
 */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = errorDetail(body)
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 可中止的休眠；当信号中止时立即 resolve。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 安全读取 Error.message，避免访问器抛异常。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 在空闲超时内读取一个流块（实现见 {@link readWithIdleTimeout}）。
 * 此处用 codearts 标签包一层，保持错误消息前缀与历史行为一致。
 */
function readCodeArtsChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
  phase: 'first-token' | 'chunk' = 'chunk',
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  return readWithIdleTimeout(reader, timeoutMs, 'codearts', signal, phase)
}

/**
 * DSML 工具调用格式提取器。
 *
 * 某些模型（如 deepseek-v4）在未通过 `tools` 字段告知工具模式、或工具
 * 模式与模型训练格式不匹配时，会把工具调用以原生 DSML XML 风格直接写入
 * `delta.content`，形如：
 *   `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">
 *    <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
 *    </｜DSML｜invoke></｜DSML｜tool_calls>`
 * 适配器若原样作为 text-delta 输出，原始 token 会泄漏到 web UI（表现为
 * "dump 出奇怪的一段内容后终止"）。本提取器以流式状态机从 content 增量
 * 中识别完整 DSML 块并解析为结构化 tool-call；非 DSML 文本原样放行，
 * 保持流式输出不阻塞。
 *
 * 同时支持 DeepSeek-V4 Thinking 模式：模型在工具调用前会把推理过程包裹
 * 在 `<thought>...</thought>` 标记中写入 `delta.content`。本提取器把
 * `<thought>` 内容作为 reasoning 增量流式输出（与 `delta.reasoning_content`
 * 行为一致，显示在 web 的 Think 区域而非正文），避免推理文本泄漏到用户
 * 可见区域。参考 DSML 官方介绍：
 * https://blog.csdn.net/gitblog_00855/article/details/152146045
 *
 * 设计要点：
 * - 增量友好：content 可能跨多个 SSE chunk 分片到达，提取器维护内部
 *   缓冲区与多模式状态机（normal / in-thought / in-dsml），仅对已完成
 *   的 DSML 块产出 tool-call；reasoning 增量流式输出；未完成部分保留
 *   到下次 feed；非 DSML/thought 文本立即 flush，避免延迟。
 * - 容错：若缓冲区包含开标签前缀但长时间未闭合，且后续内容不像该标签
 *   （例如只是普通文本里碰巧出现该前缀），在 flush 时把残留作为纯文本
 *   输出，避免吞掉用户可见内容。
 * - 边界：DSML 标签使用全角 `｜`（U+FF5C）而非半角 `|`，与模型实际
 *   输出一致。`<thought>` 为半角普通 XML 标签，与 DSML 官方文档一致。
 */
const DSML_TOOL_CALLS_OPEN = '<｜DSML｜tool_calls>'
const DSML_TOOL_CALLS_CLOSE = '</｜DSML｜tool_calls>'
const DSML_INVOKE_OPEN_PREFIX = '<｜DSML｜invoke'
const DSML_INVOKE_CLOSE = '</｜DSML｜invoke>'
const DSML_PARAM_OPEN_PREFIX = '<｜DSML｜parameter'
const DSML_PARAM_CLOSE = '</｜DSML｜parameter>'
const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

/** 解析单个 DSML invoke 块为 { name, arguments }。 */

/**
 * 对标记 string="true" 的参数值做宽松解析：若值恰好是 number/boolean
 * /null 字面量（如 "1304"、"true"、"null"），返回原始类型；若值是合法
 * JSON 数组或对象（如 todo_write 的 todos 被写成 `[{"content":...}]`），
 * 还原为原始类型；否则保持字符串。用于纠正模型对数字/数组/对象参数误标
 * string 的 DSML 输出（如 read 的 offset 被写成 offset="1304"、
 * todo_write 的 todos 被写成 string="true" 的 JSON 数组字符串），使工具
 * schema 校验通过。
 */
function tryParseScalar(value: string): unknown {
  if (value === '') return ''
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // 带引号的 JSON 字符串字面量：deepseek-v4-pro 常把数字/布尔参数值用
  // JSON 字符串编码（如 "840"），即便标记了 string="true" 也只输出引号
  // 包裹的字面量。先 JSON.parse 解码去掉外层引号，再递归尝试标量转换：
  // "840" → 840(number)、"true" → true(boolean)、"hello" → "hello"(string)。
  // 仅当整体是合法 JSON 字符串字面量（"..." 配对）时才解码，避免误伤
  // 含引号的普通文本（如路径中的引号片段）。flash 模型输出纯数字字面量
  // 不带引号，不会进入此分支；pro 模型带引号才命中，故 pro 出错多。
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      if (typeof decoded === 'string') return tryParseScalar(decoded)
      return decoded
    } catch { /* 非合法 JSON 字符串字面量，按原样处理 */ }
  }
  // 整数 / 浮点数 / 负数：仅当整体匹配数字语法时才转换，避免误伤路径
  // 中的数字片段（如 "v1.2" 不含；"123abc" 不含）。
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  // 数组 / 对象：模型常对数组/对象参数（如 todo_write 的 todos）误标
  // string="true"，把 JSON 编码的数组/对象当作字符串输出。若值是合法
  // JSON 数组或对象，还原为原始类型，使工具 schema 校验通过。仅对
  // `[` / `{` 开头尝试 JSON.parse，避免误伤普通字符串（路径、正文等
  // 极少以这两个字符开头且整段恰为合法 JSON）。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { /* 非合法 JSON，保持字符串 */ }
  }
  return value
}

function parseDsmlInvoke(block: string): { name: string; arguments: string } | undefined {
  // 提取 name="..." 属性
  const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block)
  if (nameMatch === null) return undefined
  const name = nameMatch[1]
  // 提取所有 parameter 子节点，按出现顺序拼装 arguments JSON
  const params: Record<string, unknown> = {}
  let cursor = 0
  for (;;) {
    const openStart = block.indexOf(DSML_PARAM_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = block.indexOf('>', openStart)
    if (openEnd === -1) break
    const openTag = block.slice(openStart, openEnd + 1)
    const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag)
    if (paramNameMatch === null) { cursor = openEnd + 1; continue }
    const paramName = paramNameMatch[1]
    const closeStart = block.indexOf(DSML_PARAM_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const value = block.slice(openEnd + 1, closeStart)
    // string="true" 属性标记字符串类型。但模型经常对数字参数（如 read 的
    // offset/limit、write 的 offset）误标 string="true"，把 "1304" 当作字符串
    // 输出，工具 schema 校验报 `"offset" must be a number`。因此即使标记了
    // string，也尝试 JSON 解析：若是 number/boolean/null 字面量则按原始类型
    // 使用，其余（路径、正文等）保持字符串。
    const isString = /string\s*=\s*"true"/.test(openTag)
    if (isString) {
      const parsed = tryParseScalar(value)
      params[paramName] = parsed
    } else {
      // 非 string 参数理论上应是 number/array/object/boolean。但
      // deepseek-v4-pro 有时把数字参数值用 JSON 字符串引号包裹（如 "840"）
      // 且不加 string="true"：JSON.parse('"840"') 得到字符串 "840"，
      // schema 校验仍报 "offset" must be a number。对 JSON.parse 得到的
      // 字符串结果再走一次 tryParseScalar，把数字字面量还原为 number。
      try {
        const parsed = JSON.parse(value)
        params[paramName] = typeof parsed === 'string' ? tryParseScalar(parsed) : parsed
      } catch { params[paramName] = value }
    }
    cursor = closeStart + DSML_PARAM_CLOSE.length
  }
  return { name, arguments: JSON.stringify(params) }
}

/**
 * 从一段已闭合的 DSML tool_calls 块中解析所有 invoke，返回结构化
 * tool-call 列表。返回 undefined 表示解析失败（调用方应回退为纯文本）。
 */
function parseDsmlToolCalls(block: string): Array<{ name: string; arguments: string }> | undefined {
  // block 形如 `<｜DSML｜tool_calls>...invokes...</｜DSML｜tool_calls>`
  let inner = block
  if (inner.startsWith(DSML_TOOL_CALLS_OPEN)) inner = inner.slice(DSML_TOOL_CALLS_OPEN.length)
  if (inner.endsWith(DSML_TOOL_CALLS_CLOSE)) inner = inner.slice(0, inner.length - DSML_TOOL_CALLS_CLOSE.length)
  const calls: Array<{ name: string; arguments: string }> = []
  let cursor = 0
  for (;;) {
    const openStart = inner.indexOf(DSML_INVOKE_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = inner.indexOf('>', openStart)
    if (openEnd === -1) break
    const closeStart = inner.indexOf(DSML_INVOKE_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const invokeBlock = inner.slice(openStart, closeStart + DSML_INVOKE_CLOSE.length)
    const parsed = parseDsmlInvoke(invokeBlock)
    if (parsed === undefined) return undefined
    calls.push(parsed)
    cursor = closeStart + DSML_INVOKE_CLOSE.length
  }
  return calls
}

/**
 * 计算缓冲区末尾与任一开标签的最长公共前缀长度。用于流式提取器决定
 * 保留多少缓冲区等待下次 feed：若末尾是某开标签的不完整前缀（例如
 * `<tho` 跨 chunk 到达），保留该前缀；否则全部放行，避免短文本被
 * 过度缓冲延迟输出。
 */
function longestOpenPrefixTail(buffer: string, prefixes: readonly string[]): number {
  let keepLen = 0
  const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map(p => p.length)))
  for (let i = 1; i <= maxCheck; i++) {
    const tail = buffer.slice(buffer.length - i)
    if (prefixes.some(p => p.startsWith(tail))) keepLen = i
  }
  return keepLen
}

/**
 * 流式 DSML 提取器。feed() 接收 content delta，返回一个结果对象：
 * - `text`：应作为 text-delta 输出的纯文本（可能为空串）
 * - `reasoning`：应作为 reasoning-delta 输出的推理增量（可能为空串）
 * - `toolCalls`：已完整解析的 DSML tool-call 列表（可能为空数组）
 * flush() 在流结束时调用，把残留缓冲区作为纯文本返回。
 *
 * 状态机三态：
 * - normal：寻找 `<thought>` 或 `<｜DSML｜tool_calls>` 开标签
 * - in-thought：寻找 `</thought>` 闭标签，期间内容作为 reasoning 流式输出
 * - in-dsml：寻找 `</｜DSML｜tool_calls>` 闭标签，完整后解析为 tool-call
 */
class DsmlContentExtractor {
  private buffer = ''
  private state: 'normal' | 'in-thought' | 'in-dsml' = 'normal'

  feed(chunk: string): { text: string; reasoning: string; toolCalls: Array<{ name: string; arguments: string }> } {
    let text = ''
    let reasoning = ''
    const toolCalls: Array<{ name: string; arguments: string }> = []
    this.buffer += chunk
    for (;;) {
      if (this.state === 'normal') {
        // 寻找最早出现的开标签（thought 或 DSML tool_calls）
        const thoughtIdx = this.buffer.indexOf(THOUGHT_OPEN)
        const dsmlIdx = this.buffer.indexOf(DSML_TOOL_CALLS_OPEN)
        let openIdx = -1
        let nextState: 'in-thought' | 'in-dsml' = 'in-thought'
        if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
          openIdx = thoughtIdx
          nextState = 'in-thought'
        } else if (dsmlIdx !== -1) {
          openIdx = dsmlIdx
          nextState = 'in-dsml'
        }
        if (openIdx === -1) {
          // 没有完整开标签：但缓冲区末尾可能是任一开标签的不完整前缀
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_OPEN, DSML_TOOL_CALLS_OPEN])
          if (keepLen === 0) {
            text += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            text += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        // 放行开标签之前的纯文本
        if (openIdx > 0) text += this.buffer.slice(0, openIdx)
        this.buffer = this.buffer.slice(openIdx)
        // 跳过开标签本身
        const openLen = nextState === 'in-thought' ? THOUGHT_OPEN.length : DSML_TOOL_CALLS_OPEN.length
        this.buffer = this.buffer.slice(openLen)
        this.state = nextState
        continue
      }
      if (this.state === 'in-thought') {
        // 寻找 </thought> 闭标签，期间内容作为 reasoning 流式输出
        const closeIdx = this.buffer.indexOf(THOUGHT_CLOSE)
        if (closeIdx === -1) {
          // 闭标签未到达：放行除可能的不完整闭标签前缀外的内容
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_CLOSE])
          if (keepLen === 0) {
            reasoning += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            reasoning += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        // 放行闭标签之前的推理
        if (closeIdx > 0) reasoning += this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + THOUGHT_CLOSE.length)
        this.state = 'normal'
        continue
      }
      // state === 'in-dsml'：寻找闭标签，完整块才解析
      const closeIdx = this.buffer.indexOf(DSML_TOOL_CALLS_CLOSE)
      if (closeIdx === -1) {
        // 闭标签未到达，等待更多数据
        break
      }
      const block = this.buffer.slice(0, closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      const parsed = parseDsmlToolCalls(block)
      if (parsed === undefined) {
        // 解析失败：把整个块作为纯文本放行，避免吞内容
        text += block
      } else {
        toolCalls.push(...parsed)
      }
      this.buffer = this.buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      this.state = 'normal'
      continue
    }
    return { text, reasoning, toolCalls }
  }

  flush(): { text: string; reasoning: string } {
    // 流结束：残留缓冲根据状态决定输出通道
    const remaining = this.buffer
    this.buffer = ''
    if (this.state === 'in-thought') {
      // 不完整的 thought 块：作为 reasoning 放行（避免泄漏到正文）
      this.state = 'normal'
      return { text: '', reasoning: remaining }
    }
    if (this.state === 'in-dsml') {
      // 不完整的 DSML 块：开标签已在进入 in-dsml 状态时被消耗，需加回
      // 才能保持用户可见内容的完整性（避免 dump 出缺少开标签的残片）。
      this.state = 'normal'
      return { text: DSML_TOOL_CALLS_OPEN + remaining, reasoning: '' }
    }
    // normal 拘留：作为纯文本放行
    this.state = 'normal'
    return { text: remaining, reasoning: '' }
  }
}

/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export class CodeArtsAdapter extends LlmAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly chatId: string
  private readonly sessionId: string

  constructor(private readonly options: CodeArtsAdapterOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, '')
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
   * 入参异常时回退到 PROVIDER 常量，避免客户端抛
   * `undefined.toUpperCase is not a function`。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: 'Codearts' }
  }

  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: RemoteModel[] | undefined

  /**
   * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
   * （如直接进入会话），此时同样触发远端拉取。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
    try {
      const models = await this.options.fetchRemoteModels()
      if (models.length > 0) this.remoteModels = models
    } catch {
      // 拉取失败保持未定义，后续 listModels/resolveModel 仍回退静态列表
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    //
    // ⚠️ **本仓保留 CodeArts 的单凭据路径**（与上游相反）：`/codearts-login`
    // 命令仍活跃，凭据写进固定的 `CODEARTS_ACCESS_TOKEN`，适配器的
    // `makeCredentialResolver` 也在池空时回退读它。故判据必须**同时覆盖
    // 「账号池有可用凭据」与「单凭据 ref 可解析」两条路径** —— 只查池会让纯
    // 单凭据登录的用户看到 codearts 的全部模型凭空消失。
    //
    // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
    // 不必拉（省一次无谓 HTTP）。
    if (!await providerCatalogVisible(this.options.accountPool, PROVIDER, [CODEARTS_CREDENTIAL_REF])) return []
    // 必须 await：ensureRemoteModels 是异步的，早期实现用 `void` 丢弃 Promise，
    // 冷缓存时远端目录尚未落地就走静态兜底表，模型选择器会短暂显示错误的
    // 模型集合（Account Hub 的模型开关也据此渲染，会造成"关掉的模型又冒出来"）。
    await this.ensureRemoteModels()
    const visible = this.listAllModels()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    // 只影响此处对外播报的模型目录，不改变 resolveModel/stream 的路由能力
    // ——与 DSH 对 listModels 的约定一致（目录是建议性的，缺省不构成拒绝）。
    const disabled = this.options.accountPool?.disabledModelsFor(PROVIDER)
    const listed = disabled === undefined || disabled.size === 0
      ? visible
      : visible.filter((m) => !disabled.has(m.id))
    return listed.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] as const }))
  }

  /**
   * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
   *
   * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
   * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
   *
   * ⚠️ **必须与 `listModels` 共用同一份可见性过滤**（此处是 VL 多模态屏蔽），
   * 唯一区别就是不套黑名单、不套账号门控。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }))
    // 屏蔽视觉（VL）多模态模型（id 含 -VL- 或以 -VL 结尾，如 Qwen3-VL-235B）：
    // 这类模型上下文小（32768 tokens）、不支持工具调用（vLLM 未启用
    // auto-tool-choice，发 tools 会 400），不适合当 agent 主模型，故从列表隐藏。
    return source
      .filter((m) => !/-VL-/i.test(m.id) && !/-VL$/i.test(m.id))
      .map((m) => ({ id: m.id, name: m.name }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remoteModel = this.remoteModels?.find((m) => m.id === model)
    const name = remoteModel?.name ?? model
    // 上下文窗口：**远端优先 → 静态兜底**（None 表示两边都没有 → 不声明）。
    //
    // ⚠️ 远端目录失败、或该模型未下发 `context_window` 时必须**原样回退静态表**
    // —— 网络抖动不该改变声明值的来源。`remoteModels` 在拉取失败时保持
    // undefined、列表项在字段缺失时整个属性缺省，两种情形都由这里的 `?.`
    // 与 `??` 落到 `CONTEXT_WINDOWS.get(model)`，不需要额外分支。
    //
    // 为什么要接远端：宿主压缩管线在 `context === undefined` 时逐 step 抛
    // `TargetPressureConfigError`（被 catch 成 warning 后继续）—— 自动压缩
    // **永久失效**，且每个 step 都白跑一次。远端目录是权威声明（如
    // deepseek-v4-flash-0731: context_window=1048576），静态表只是快照。
    //
    // ⚠️ 远端 `max_tokens`（最大输出）**刻意不接线**：它在网关配置里与
    // `context_window` 成对下发，但出站 body 的 `max_tokens` 现由
    // `options.maxTokens ?? 65536` 决定（见下方请求体构造处），接远端值属于
    // 行为变更 —— 本次只接 contextWindow。
    //
    // ⚠️ id 匹配沿用既有语义：远端 id 在 `parseModelInfo` 里已去掉日期后缀
    // （`deepseek-v4-flash-0731` → `deepseek-v4-flash`），与选择器播报的 id
    // 同源，故此处按归一后的 id 直接比对，**不要**另发明一套模糊匹配。
    const contextWindow = remoteModel?.contextWindow ?? CONTEXT_WINDOWS.get(model)
    const resolved: LlmResolvedModelInfo = { provider, id: model, name }
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    return resolved
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: { ...await this.resolveModel(provider, model, signal), inputModalities: ['text'] as const },
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为
    // 限流/积分耗尽的账号（否则每次请求都要先白跑一遍这些账号再换号）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || Date.parse(credential.expires_at) <= Date.now()) {
      await this.options.refresh(options.model)
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      throw new LlmError('codearts: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // Track current account id for rate limit tracking
    let currentAccountId = ''
    if (this.options.accountPool && credential?.access_key_id) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          'codearts',
          credential.access_key_id,
        )
      } catch (error) {
        console.warn('[codearts] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    const messages = serializeMessages(options.messages)
    // harness 的 GenerateOptions.system 是独立的系统提示（如标题生成的
    // systemPrompt、agent 的 persona）。后端 chat/completions 只接受
    // messages 数组里的 system 角色，必须显式插入——否则模型看不到
    // system 指令，只见到 user prompt 本身（实测 2026-08-22：session
    // 标题变成了 "We need to generate a session title..." 的 prompt 回显）。
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    // 将 harness 工具模式以 OpenAI function 格式告知模型，
    // 与 deepseek 适配器序列化 GenerateOptions.tools 的方式一致。
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    // deepseek-v4 大文件写入修复（详见 isDeepseekV4Model 注释）：标准
    // tool_calls 参数一次性打包生成，SSE 静默 >60s 被网关掐断。仅当工具
    // 列表含大参数写文件类工具（write/file_write/apply_patch）时切换到
    // DSML：不发送 tools 字段、把 schema 注入 system 提示，让模型以
    // DSML 流式输出工具调用，全程有数据流、不触发网关空闲断连。read/
    // bash 等小参数工具保持标准 tool_calls，避免 DSML 带来的额外开销。
    let wireTools = tools
    if (wireTools !== undefined && needsDsmlToolMode(options.model, wireTools.map(tool => tool.function.name))) {
      // DSML 工具说明置于 system 之后、user 之前：与 CodeArts Agent IDE
      // 实际请求体一致（IDE 把工具说明作为 system 消息放在最前）。实证
      // （2026-08-22）：DSML 提示 push 到 messages 末尾时，deepseek-v4
      // 倾向把思考写入 content（正文）而非 reasoning_content；unshift 到
      // user 之前后模型恢复走 reasoning 通道，思考不再泄漏到正文。
      messages.splice(messages.findIndex(m => m.role === 'system') + 1, 0, { role: 'system', content: buildDsmlSystemPrompt(wireTools) })
      wireTools = undefined
    }
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回 cached_tokens，
      // 缺少该字段时缓存命中恒为 0（实测 2026-08-24）。
      prompt_cache_key: this.sessionId,
      // include/reasoning_summary 对齐 Rust 端 CodeArtsExtraFields，
      // 让服务端返回加密 reasoning 内容与摘要。
      include: ['reasoning.encrypted_content'],
      reasoning_summary: 'auto',
      // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
      // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
      // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
      // （error decoding response body）。deepseek-v4 的 DSML 路径不受此
      // 影响，保留该字段与 IDE 对齐。
      tool_stream: true,
      // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
      // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
      // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
      // 工具校验报 `invalid arguments: "arguments" must be an object`。
      // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝；
      // 显式传入的 options.maxTokens 优先，未设置时默认 65536。
      max_tokens: options.maxTokens ?? 65536,
      ...wireTools !== undefined && wireTools.length > 0 ? { tools: wireTools } : {},
    })
    const url = `${CHAT_API_BASE}/chat/completions`

    // CodeArts 按账户限制并发：当会话上限
    // 达到时请求以 TM.00001041 失败（或 SSE 流内返回
    // InferHub.ModelArts.81111.429 等排队/限流错误）。对齐参考实现
    // （deveco-code-rust runner.rs）：排队时不等待状态端点
    // working，而是每 QUEUE_RETRY_DELAY_MS 直接重试 chat 请求，
    // 上限 QUEUE_MAX_ATTEMPTS 次（180 × 10s = 30 分钟）。
    let response: Response
    let queueAttempts = 0
    // 鉴权失败（APIG.0602 / 401 / 403）后已刷新过凭据：避免死循环，
    // 同一次 stream() 调用最多 refresh 一次。
    let authRefreshed = false
    // 因限流已尝试过的账号 id：保证每个账号只试一次，试完才判定"全部受限"。
    const rateLimitTried = new Set<string>()
    if (currentAccountId) rateLimitTried.add(currentAccountId)
    for (;;) {
      // glm-5.3-flash 是 benefit（免费额度）模型，后端要求 maas_type: benefit
      // 头参与 SDK-HMAC-SHA256 签名，否则返回 InferHub.002002009.404
      // "model not registered"（逆向自 CodeArts Agent IDE 抓包，见
      // MAAS_TYPE_BENEFIT_MODELS 注释）。
      const extraSignedHeaders = MAAS_TYPE_BENEFIT_MODELS.has(options.model) ? { maas_type: 'benefit' } : undefined
      const signed = await signRequestHuawei(
        credential.access_key_id,
        credential.secret_access_key,
        credential.security_token,
        'POST',
        url,
        new TextEncoder().encode(body),
        extraSignedHeaders,
      )
      const headers = new Headers(attributionHeaders())
      // 签名 map 中的额外头（如 maas_type）必须随请求发送——它们已参与
      // canonical 计算、包含在 SignedHeaders 列表中，缺失会导致服务端验签失败。
      signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
      headers.set('Content-Type', 'application/json')
      headers.set('Chat-Id', this.chatId)
      headers.set('Session-Id', this.sessionId)
      headers.set('lang', 'en')

      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
      if (response.ok) {
        // 200：消费 SSE 流。CodeArts 有时以 HTTP 200 + SSE 内嵌
        // error_code/error_msg 返回排队/限流（如 InferHub.ModelArts.81111.429
        // TPM 超限），而非 4xx——consumeSse 检测到可重试排队错误时抛
        // SseQueueRetryError，落入下方排队重试逻辑，与 TM.00001041 一致。
        try {
          yield* this.consumeSse(response, options)
          break
        } catch (error) {
          if (!(error instanceof SseQueueRetryError)) throw error
          // 落入下方排队重试
        }
      } else {
        const errorText = await response.text().catch(() => '')
        // 鉴权失败（SecurityToken 过期/被吊销/APIG.0602）：刷新一次凭据后
        // 重试整个 chat 请求。入口的 expires_at 预判无法覆盖后端提前吊销
        // 或时钟偏差场景，这里做兜底，避免把可自愈的鉴权失败抛给用户。
        if (isAuthError(response.status, errorText) && !authRefreshed) {
          authRefreshed = true
          await this.options.refresh(options.model)
          credential = await this.options.resolveCredential(options.model)
          if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
            throw new LlmError('codearts: credential missing after refresh; log in again', 'MISSING_CREDENTIAL')
          }
          continue
        }
        // 限流处理：记录当前账号在该模型上的重置时间，然后切换账号重试
        // （外层 for(;;) 会在拿到新凭据后重新签名发请求）。用 tried 集合
        // 保证每个账号只尝试一次，试完才判定"全部受限"——避免只试一个
        // 就下结论，导致 UI 限流状态与实际判定不一致。
        //
        // 积分/额度耗尽（业务码 11114，中文文案「积分不足」等）是**另一种失败**：
        // 它不匹配 RATE_LIMIT_PATTERN，若不并进这个分支，错误会直接抛给用户，
        // 用户只能手动停用那个没额度的账号。两种失败都该换号，故这里取并集；
        // 差别只在冷却时长（积分耗尽用 24h，见 parseQuotaExhausted 的说明）。
        if (this.options.accountPool && (isRateLimited(errorText) || isQuotaExhausted(errorText))) {
          const parsed = parseRateLimitError(errorText, options.model)
            ?? parseQuotaExhausted(errorText, options.model)
          if (parsed) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, parsed.modelId, parsed.resetTimeMs,
              )
            }
            const next = await this.options.accountPool.getAvailableAccount('codearts', options.model)
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id)
              credential = next.credential as CodeArtsCredential
              currentAccountId = next.entry.id
              authRefreshed = false // Reset auth refresh flag for new credential
              continue // Retry request with new credential
            }
            // 试完全部候选：限流与积分耗尽都归为不可重试的 QUOTA_EXCEEDED。
            throw new LlmError(
              `codearts: 模型 ${options.model} 所有账号均不可用（限流或积分耗尽），请稍后再试`,
              'QUOTA_EXCEEDED',
            )
          }
        }
        if (!isQueueError(response.status, errorText)) {
          // 非 TM.00001041 错误也未必没排队：openpangu 等模型的并发限流
          // 错误码/HTTP 状态可能与 GLM 不同，但仍会进入后端队列。先探测
          // 排队状态端点——只有端点确认会话在排队（waiting/queue_full）时
          // 才进入排队流程；端点不可达或未排队（working）则按原错误分类
          // 立即抛出，避免把真错误（如 401/400）拖成 30 分钟超时。
          const probe = await this.queryQueueStatus(credential, options.model, options.signal)
          if (probe === undefined || probe.status === 'working') {
            // 与 deepseek 适配器的 httpErrorCode 词汇保持一致；
            // 400 + 上下文超限措辞归为 CONTEXT_WINDOW_EXCEEDED（触发 compaction）。
            const code = httpErrorCode(response.status, errorText)
            throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status })
          }
          // probe.status 为 'waiting' 或 'queue_full' → 落入下方排队流程。
        }
      }
      // TM.00001041 / 状态端点确认排队 / SSE 内排队错误：对齐参考实现
      // 直接重试 chat 请求，每 QUEUE_RETRY_DELAY_MS（10s）一次，上限
      // QUEUE_MAX_ATTEMPTS（180）次，不等待状态端点 working。排队期间
      // 不产出任何内容块（StreamChunk 协议没有独立的瞬态状态通道，
      // 任何 reasoning/text 块都会被 BlockAssembler 组装进 assistant
      // 消息并持久化到会话历史，reasoning 块还会显示在 web 的 Think
      // 区域，且 visible 回退可能把推理文本作为正文回传给模型），因此
      // 保持静默，web 显示 harness 自身的"运行中"状态。每次重试前查询
      // 状态端点：终态（error/queue_full）立即抛错，其余情况
      // （waiting/working/端点不可达）等待后直接重试 chat。
      queueAttempts += 1
      if (queueAttempts > QUEUE_MAX_ATTEMPTS) {
        throw new LlmError('codearts: queue wait timed out after 30 minutes', 'QUEUE')
      }
      if (options.signal?.aborted) throw new LlmError('codearts: request aborted while waiting in queue', 'QUEUE')
      const status = await this.queryQueueStatus(credential, options.model, options.signal)
      if (status?.status === 'error' || status?.status === 'queue_full') {
        throw new LlmError(`codearts: ${status.message || `queue status: ${status.status}`}`, 'QUEUE')
      }
      await delay(QUEUE_RETRY_DELAY_MS, options.signal)
      // 直接重试 chat 请求（外层 for(;;) 循环）
    }
  }

  /**
   * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
   *
   * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
   * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
   * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
   * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
   * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
   * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
   * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('codearts: empty model response body', 'EMPTY_RESPONSE')
    // 块组装状态：文本 / 推理 / 工具调用各自拥有唯一
    // 索引，与 harness StreamChunk→ContentBlock 契约一致。
    const blocks: Array<{
      index: number
      kind: 'text' | 'reasoning'
      text: string
    }> = []
    let nextIndex = 0
    const toolCalls = new Map<number, { index: number; text: string; callId?: string; name?: string }>()
    const toolOrder: number[] = []
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    // DSML 提取器：从 delta.content 中识别模型以原生 DSML XML 风格
    // 写入的工具调用（deepseek-v4 等模型在工具模式不匹配时会直接
    // 输出 `<｜DSML｜tool_calls>...`），解析为结构化 tool-call，
    // 避免原始 token 泄漏到 web UI。
    // content 与 reasoning_content 两个通道使用各自独立的 DSML 提取器。
    // 早期实现共用单个提取器，但 deepseek-v4 有时在 content 通道输出
    // <thought> 开标签（提取器进入 in-thought 状态）后，把后续推理与
    // DSML 工具调用写到 reasoning_content 通道——共用提取器会把
    // reasoning_content 的 DSML 块当作 thought 内容吞掉，不解析为
    // tool-call，最终残留 DSML 标签经 visible 回退泄漏到正文（实测
    // session-067dcf78 turn1 step13 / turn2 step3）。独立提取器让各
    // 通道状态机互不污染。
    const dsmlContentExtractor = new DsmlContentExtractor()
    const dsmlReasoningExtractor = new DsmlContentExtractor()
    // 分流 DSML 提取结果：正文文本进入 text 块、thought 进入 reasoning
    // 块、解析出的工具调用进入 tool-call 块。
    async function* emitDsmlFeed(
      text: string,
      reasoning: string,
      dsmlCalls: Array<{ name: string; arguments: string }>,
    ): AsyncIterable<StreamChunk> {
      if (text.length > 0) {
        let block = blocks.find(candidate => candidate.kind === 'text')
        if (block === undefined) {
          block = { index: nextIndex++, kind: 'text', text: '' }
          blocks.push(block)
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += text
        yield { type: 'text-delta', index: block.index, text }
      }
      if (reasoning.length > 0) {
        let block = blocks.find(candidate => candidate.kind === 'reasoning')
        if (block === undefined) {
          block = { index: nextIndex++, kind: 'reasoning', text: '' }
          blocks.push(block)
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += reasoning
        yield { type: 'reasoning-delta', index: block.index, text: reasoning }
      }
      for (const call of dsmlCalls) {
        const wireIndex = toolCalls.size
        // DSML 语法没有 provider 签发的 call id，必须生成唯一 id：
        // harness 的 tool/call ↔ tool/result 配对与 web UI 的工具行
        // 渲染都用 callId 作为 key（见 client-runtime 匹配器
        // `tool/call -> id: String(callId)`），空 id 会让同一响应的
        // 多个工具调用（或历史重放）配对冲突，UI 只能回退为泛化的
        // "Tool call" 行而丢失 read/write 专属控件。
        const block = {
          index: nextIndex++,
          text: call.arguments,
          name: call.name,
          callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
        }
        toolCalls.set(wireIndex, block)
        toolOrder.push(block.index)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: call.arguments,
        }
      }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用（对齐 CodeArts Agent IDE）：
    // 第一次读取用 firstTokenTimeout（5min），收到首 chunk 后切换为
    // chunkTimeout（10min），并在每次成功读取后重置。deepseek-v4-flash
    // 生成大文件 write 的 content 参数时，首 token 后可能长时间静默，
    // 需要远大于网关 60s 的窗口才不会误判可重试 TIMEOUT 而反复重试。
    let firstTokenReceived = false
    try {
      for (;;) {
        if (streamEnded) break
        // CodeArts 网关对 SSE 有 ~60s 空闲超时：模型生成长推理 / 大工具
        // 参数时两次 chunk 间可能静默数十秒，连接被对端掐断后 reader.read()
        // 抛 `TypeError: terminated`（非 HarnessError → UNKNOWN 不可重试 →
        // harness 直接失败）。以略小于网关超时的窗口主动检测空闲：超时则
        // 取消 reader 并抛可重试 TIMEOUT；同时把传输级错误映射为可重试
        // TRANSPORT，让 harness 重试该步骤而非直接失败。
        let done: boolean
        let value: Uint8Array | undefined
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          const result = await readCodeArtsChunk(reader, timeoutMs, options.signal, phase)
          done = result.done
          value = result.value
          if (!done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`codearts: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error })
          }
          throw error
        }
        if (done) break
        buffer += decoder.decode(value!, { stream: true })
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
            error_code?: string
            error_msg?: string
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
            usage?: Record<string, number>
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          // SSE 内嵌错误检测：CodeArts 以 HTTP 200 + error_code/error_msg
          // 返回排队/限流（如 InferHub.ModelArts.81111.429 TPM 超限）。
          if (typeof data.error_code === 'string' && data.error_code.length > 0) {
            const message = typeof data.error_msg === 'string' && data.error_msg.length > 0
              ? data.error_msg
              : data.error_code
            if (isSseQueueErrorCode(data.error_code)) {
              throw new SseQueueRetryError(data.error_code, message)
            }
            throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 })
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            // 通过 DSML 提取器：纯文本作为 text-delta 放行，
            // <thought> 内容作为 reasoning-delta 放行（显示在 Think 区域），
            // DSML 块解析为结构化 tool-call（与 delta.tool_calls 路径
            // 合并到同一 toolCalls/toolOrder 状态）。
            const { text, reasoning, toolCalls: dsmlCalls } = dsmlContentExtractor.feed(delta.content)
            yield* emitDsmlFeed(text, reasoning, dsmlCalls)
          }
          if (delta?.reasoning_content) {
            // 模型放在 reasoning_content 通道的内容就是思考，必须进入
            // reasoning 块（Think 区域），绝不能作为正文输出。实测
            // （2026-08-22）：deepseek-v4-flash 的 reasoning_content 通常
            // 没有 <thought> 标签，提取器会把整段当作 `text` 返回——若把
            // `text` 发给正文块，思考就泄漏到正文（TUI 显示 The user wants
            // me to... 跑到正文）。因此这里把 `text + reasoning` 合并后
            // 全部作为 reasoning 输出，仅 DSML 工具调用块单独解析执行。
            const { text, reasoning, toolCalls: reasoningDsmlCalls } = dsmlReasoningExtractor.feed(delta.reasoning_content)
            const thinking = text + reasoning
            if (thinking.length > 0) {
              let block = blocks.find(candidate => candidate.kind === 'reasoning')
              if (block === undefined) {
                block = { index: nextIndex++, kind: 'reasoning', text: '' }
                blocks.push(block)
                yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
              }
              block.text += thinking
              yield { type: 'reasoning-delta', index: block.index, text: thinking }
            }
            for (const call of reasoningDsmlCalls) {
              const wireIndex = toolCalls.size
              const block = {
                index: nextIndex++,
                text: call.arguments,
                name: call.name,
                callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
              }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.callId,
                name: block.name,
                argumentsDelta: call.arguments,
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '' }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (call.id !== undefined) block.callId = call.id
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
              id: ToolCallId(block.callId ?? ''),
              ...block.name !== undefined ? { name: block.name } : {},
              argumentsDelta: fragment,
            }
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            const cachedTokens = (data.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens
              ?? (data.usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = (data.usage as { prompt_tokens_details?: { cache_write_tokens?: number } }).prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = (data.usage as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
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
    // 流结束：分别 flush content 与 reasoning_content 两个独立 DSML 提取器。
    // 若模型输出了不完整的 DSML 块（被 max_tokens 截断或模型异常终止），
    // 残留内容作为纯文本放行，避免吞掉用户可见内容；不完整的 <thought>
    // 块作为 reasoning 放行，避免推理泄漏到正文；同时让 finish_reason='length'
    // 路径生效，触发 harness max-tokens 续写而非执行不完整工具调用。
    // 复用 emitDsmlFeed 把残留 text/reasoning 路由到对应块。
    {
      const f = dsmlContentExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    {
      const f = dsmlReasoningExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    // 按创建顺序关闭每个块。GLM 端点偶尔把整个回答作为 reasoning_content
    // 发出且 content 为空：此时正文区为空，回退用推理文本填充可见区。
    // 但若推理中解析出了 DSML 工具调用（deepseek-v4 的 reasoning_content
    // 内嵌工具块），正文由工具调用承担，不再把推理复制为可见文本。
    const textBlock = blocks.find(block => block.kind === 'text')
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    // visible 回退：正文为空且无工具调用时，用推理文本填充可见区（GLM 端点
    // 偶尔把整个回答作为 reasoning_content 输出）。但若推理含 DSML 标签
    // （deepseek-v4 在推理中引用 DSML 语法讨论实现方案，非完整工具调用块），
    // 不能复制为正文——DSML 标签泄漏到正文会被模型当用户输入，导致任务
    // 终止或循环（实测 session-a69fa289 turn2 step26：推理仅含 DSML 闭合
    // 标签片段，visible 回退复制到正文后任务终止）。此时正文留空，推理仍
    // 在 Think 区域可见。
    const reasoningHasDsml = reasoningBlock !== undefined && reasoningBlock.text.includes('｜DSML｜')
    const visible = textBlock !== undefined && textBlock.text !== ''
      ? textBlock.text
      : reasoningBlock !== undefined && toolOrder.length === 0 && !reasoningHasDsml ? reasoningBlock.text : ''
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name ?? '',
          // 同上：空分片补 {}，残缺参数保持原样交由截断判定处理。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    if (textBlock !== undefined || visible !== '') {
      yield { type: 'block-end', index: textBlock?.index ?? nextIndex, block: { type: 'text', text: visible } }
    }
    if (reasoningBlock !== undefined && reasoningBlock.text !== '') {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    // finish_reason 映射顺序很关键：'length'（输出被 max_tokens 截断）必须优先于
    // 工具调用检查。若先看 toolOrder.length > 0，截断的工具调用会被报告为
    // 'tool-calls'，harness 将执行其不完整的 JSON 参数（报 INVALID_ARGS），并
    // 把截断参数持久化进会话历史——web 加载历史时 presenter 解析也会失败
    // （"Unterminated string in JSON"）。报告 max-tokens 后，dsh 会丢弃不完整的
    // 工具调用并触发 max-tokens 续写（分批生成），避免脏数据与错误执行。
    const reason = finishReason === 'length'
      ? { kind: 'max-tokens' as const }
      : finishReason === 'tool_calls' || toolOrder.length > 0
        ? { kind: 'tool-calls' as const }
        : { kind: 'stop' as const }
    yield { type: 'finish', reason }
  }

  /**
   * 查询某个会话的 CodeArts 并发队列状态。该端点
   * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
   * @param credential - 用于签名请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 状态请求的取消信号。
   * @returns 解析后的排队状态，或当端点不可达
   *   或返回无法识别的载荷时返回 `undefined`。
   */
  private async queryQueueStatus(
    credential: CodeArtsCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<CodeArtsQueueStatus | undefined> {
    const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`
    const signed = await signRequestHuawei(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
    )
    const headers = new Headers()
    signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
    headers.set('x-snap-traceid', crypto.randomUUID())
    headers.set('Agent-Type', 'INFERHUB_AGENT')
    headers.set('X-Language', 'en')
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal })
    } catch {
      return undefined
    }
    if (response.status !== 200) return undefined
    let body: Record<string, unknown>
    try {
      body = await response.json() as Record<string, unknown>
    } catch {
      return undefined
    }
    const status = body.status
    if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full') return undefined
    return {
      status,
      queuePosition: Number(body.queue_position ?? -1),
      message: typeof body.message === 'string' ? body.message : '',
    }
  }
}

/**
 * 在 ctx.llm 上注册 codearts 提供商路由和适配器。
 *
 * ⚠️ **返回适配器实例**（不是 `void`）：Account Hub 的「显示列表」需要它的
 * `listAllModels()`（不套用户黑名单、也不套目录门控的完整目录，带最终展示名）。
 * DSH 的 `ctx.llm` 只保证 `listModels`、且会把条目重建后丢掉额外字段，故实例
 * 必须由调用方持有并注入 RPC 层（见 `src/account-hub-rpc.ts` 的 `ModelCatalogSource`）。
 */
export function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter {
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Codearts', settingsNs: 'llm-codearts', settingsPath: [] },
  ])
  const adapter = new CodeArtsAdapter(options)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return adapter
}

/**
 * Buddy 系（buddy-cn / buddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004

/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本、以及 CodeArts（华为云）的中文错误都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（用户报障，仅国际版暴露）：此处早期只有
 * 中文词（频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版 Buddy
 * （www.workbuddy.ai）返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，直接抛出
 * 原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST 而非
 * QUOTA_EXCEEDED。国内版返回中文文案，所以该缺陷只在国际版复现。
 *
 * `too many requests` 是标准 OpenAI 429 措辞，一并纳入。
 */
const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性；这里只认 JSON 顶层的 `code` 字段。
 * 兼容 `"6004"`（字符串）与 `6004`（数字）两种编码。
 */
function hasRateLimitBusinessCode(body: string): boolean {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const code = data.code
    return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)
  } catch {
    // 非 JSON：交给文案兜底
    return false
  }
}

/** 判断错误文本是否为频率限制错误 */
export function isRateLimited(body: string): boolean {
  return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body)
}

/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（Buddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, ..."
 *
 * 早期只列了中文句式，导致国际版即使判定为限流也只能走「1 小时后重试」的
 * 兜底，丢掉服务端给出的真实重置时刻（UI 限流徽章因此显示错误时间）。
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

/**
 * Buddy 系表示「**账号积分/额度耗尽**」的业务码。
 *
 * 与 {@link RATE_LIMIT_BUSINESS_CODE}（6004，模型级频率限制）是**两种不同的失败**：
 * 6004 是该模型当前用超了频次、过一段时间会自行恢复；11114 是**该账号的积分/
 * 额度用完了**，不充值就永远不会恢复，且影响该账号下的**所有模型**。
 *
 * 报文形态（对齐 workbuddy2api / codebuddy2api 的实现）：
 * `{"code":11114,"msg":"积分不足，请前往购买"}`，HTTP 状态可能是 400 或 402。
 */
const QUOTA_BUSINESS_CODE = 11114

/**
 * 积分耗尽被记录成「限流重置时间」时使用的冷却时长（24 小时）。
 *
 * 积分耗尽是**账号级**、需充值才能恢复的终态，用一个远长于限流的冷却把它从
 * 候选里挡掉。取 24h（而非 lobsterai hard-credit 的 12h）更保守：宁可让用户
 * 手动重置，也不要让一个空账号被反复选中、每次请求都白跑一轮。
 */
const QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 3_600_000

/**
 * 积分/额度耗尽的**自然语言兜底**判据（中英文都要列全）。
 *
 * 为什么不能只依赖 DSH 上游的 `isQuotaExceededError`：它只覆盖英文措辞
 * （insufficient quota/balance/credits、out of credits 等），而腾讯后端实测
 * 返回**中文**文案「积分不足，请前往购买」/「资源已用尽」，只认英文会把这类
 * 错误漏判成普通 400（INVALID_REQUEST），换号分支被整体跳过。
 *
 * ⚠️ **绝不能命中「上下文超限」**。两者都是 HTTP 400，但语义完全不同：
 * 超限是「本次请求的 prompt 太长」（归 CONTEXT_WINDOW_EXCEEDED，需压缩上下文），
 * 换账号毫无用处——同样的上下文会再次超限。因此这里**只匹配「余额/额度/积分」
 * 类措辞**，绝不收录 `exceeded` / `too long` / `context` / `length` 这类
 * 超限也会出现的通用词，也不收录 `limit`（超限报文里就有 context limit）。
 */
const QUOTA_EXHAUSTED_PATTERN =
  /积分不足|积分已用尽|积分用完|积分耗尽|没有积分|积分余额不足|额度不足|额度已用尽|额度用完|额度耗尽|免费额度已用尽|资源已用尽|余额不足|余额已用尽|insufficient credits?|credits? (?:are |is )?insufficient|insufficient (?:credit|quota|balance|funds)|out of credits?|no credits? left|credits? (?:exhausted|depleted|used up)|(?:credit|quota|balance) (?:exhausted|depleted|used up)|quota exhausted|quota exceeded/i

/**
 * 结构化判定：响应体是可解析 JSON 且**顶层** `code` 为该业务码。
 *
 * 与 {@link hasRateLimitBusinessCode} 同一写法与理由：不采用「全文包含 11114」
 * （`requestId` 是 UUID，任意数字子串都可能偶然出现），兼容 `"11114"`（字符串）
 * 与 `11114`（数字）两种编码。
 */
function hasQuotaBusinessCode(body: string): boolean {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const code = data.code
    return code === QUOTA_BUSINESS_CODE || code === String(QUOTA_BUSINESS_CODE)
  } catch {
    // 非 JSON：交给文案兜底
    return false
  }
}

/**
 * 判断错误文本是否为「账号积分/额度耗尽」。
 *
 * 判据顺序与 {@link isRateLimited} 一致：结构化业务码优先（与语言无关、不受
 * 服务端改文案影响），文案兜底（覆盖 SSE 流内错误与网关裸文本等拿不到 code 的场景）。
 */
export function isQuotaExhausted(body: string): boolean {
  return hasQuotaBusinessCode(body) || QUOTA_EXHAUSTED_PATTERN.test(body)
}

/**
 * 积分耗尽时的账号标记参数（与 {@link parseRateLimitError} **同构**返回，
 * 让调用方的换号循环无需为两种失败各写一套）。
 *
 * 与限流的语义差异：积分耗尽是**账号级**耗尽（该账号所有模型都不可用），而现有
 * `updateModelRateLimit` + `getAvailableAccount` 是**模型级**标记。这里刻意用
 * 「模型级标记」近似它——给当前请求的模型记一个 24h 冷却，既不新增 AccountPool
 * 字段（避免 settings schema 迁移），又能让换号循环的模型级过滤自动跳过该账号。
 *
 * ⚠️ 这个近似的可见后果：UI 的限流/冷却徽章会显示在**当前模型**上，而不是整个
 * 账号上；账号下其它模型不会被挡（下次换个模型仍会试到这个空账号）。用户可在
 * Account Hub 账号卡片上手动「重置」清掉这个标记。
 */
export function parseQuotaExhausted(
  body: string,
  currentModel: string,
): { modelId: string; resetTimeMs: number } | null {
  if (!isQuotaExhausted(body)) return null
  return { modelId: currentModel, resetTimeMs: Date.now() + QUOTA_EXHAUSTED_COOLDOWN_MS }
}

/** 从限流错误中提取重置时间 */
export function parseRateLimitError(
  body: string,
  currentModel: string,
): { modelId: string; resetTimeMs: number } | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs }
      }
    }
    // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
    if (isRateLimited(body)) {
      // fallback: 1小时后重试
      return { modelId: currentModel, resetTimeMs: Date.now() + 3_600_000 }
    }
    return null
  } catch {
    return null
  }
}
