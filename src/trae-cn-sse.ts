/**
 * Trae CN（字节跳动 Trae 国内版）SSE 流解析。
 *
 * ## 与其它 provider 的根本差异：**不是 OpenAI 协议**
 *
 * Trae CN 的 chat 端点返回的 SSE **不是** OpenAI 的 `data: {choices:[...]}`
 * 形态，而是**具名事件**流：
 *
 * ```
 * event:metadata
 * data:{"conversation_id":"...","model_name":"..."}
 *
 * event:timing_cost
 * data:{...}
 *
 * event:output
 * data:{"response":"片段"}          ← 正文增量
 *
 * event:done
 * data:{...}                        ← 流结束
 * ```
 *
 * 因此 `src/sse.ts` 的 `normalizeToolArguments` / `readWithIdleTimeout` 仍可复用
 * （它们处理的是 harness 侧的协议层陷阱，与厂商无关），但**帧解析必须重写** ——
 * 照抄 OpenAI 那套会一行都匹配不上。
 *
 * ## 事件名证据（本机客户端只读提取，未发任何网络请求）
 *
 * 取自 Trae CN 桌面客户端 `resources/app/modules/ai-agent/ai_agent.dll` 的
 * 字符串池：Rust 侧 `modules/ai-agent/src/infrastructure/adapter/llm/event.rs`
 * 有一份**权威事件类型清单**
 * （`metadata output extra_info suggested_questions token_usage compact_token_usage
 * request_wait_in_queue queue_begin queue_end fee_usage notify_usage queue_continue
 * timing_cost done turn_completion tool_call tool_call_cancel monitor_stop_request
 * task_created thought ...`），每个变体都带一条
 * `Failed to deserialize <name> event` 诊断串（实测提取到 22 条）。
 *
 * 两条独立佐证：
 * 1. 客户端 JS 侧的 `super_completion_query` 用**同名简化常量**
 *    `{Meta:"meta", Output:"output", Done:"done", Error:"error"}` —— 那里的
 *    `meta` 与 Rust 侧的 `metadata` 是同一类帧的不同命名。本解析器**两个都认**
 *    （见 {@link TRAE_CN_METADATA_EVENTS}），不赌单一形态。
 * 2. `error` 帧不在上面那份 `Failed to deserialize` 清单里，但出现在同一段
 *    事件枚举中，且调研报告实测确认错误走
 *    `event:error` + `data:{"code":N,"message":"..."}`。故照实现。
 *
 * ## 错误帧**不抛异常**，而是回填到返回值里
 *
 * 这是刻意的接口选择，不是疏忽。原因：Trae 把限流/额度/风控失败放在
 * **HTTP 200 的 `event:error` 帧**里，而这类失败**可以换号重试**。
 * 若解析器直接抛，调用方在已经 yield 过若干正文块之后就失去了「要不要换号」
 * 的判断余地（换号会导致正文重复）。把错误放进 outcome，调用方就能同时看到
 * 「是否已经产出过内容」与「错误码是什么」，从而做正确的取舍。
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  hasUsableToolName, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing,
} from './sse.js'
import {
  createReasoningLoopDetector,
  isReasoningLoopGuardEnabled,
} from './reasoning-loop-guard.js'
import {
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled,
} from './course-leak-strip.js'
import {
  TRAE_CN_CONTEXT_OVERFLOW_CODES,
  classifyTraeCnError,
  normalizeTraeCnCode,
} from './trae-cn-errors.js'
import type { TraeCnErrorAction, TraeCnErrorCode } from './trae-cn-errors.js'

/** 元数据帧的事件名候选（`metadata` 为 Rust 侧名，`meta` 为 JS 侧名）。 */
export const TRAE_CN_METADATA_EVENTS: readonly string[] = ['metadata', 'meta']

/** 正文增量帧的事件名。 */
export const TRAE_CN_OUTPUT_EVENT = 'output'

/** 流结束帧的事件名。 */
export const TRAE_CN_DONE_EVENT = 'done'

/** 错误帧的事件名。 */
export const TRAE_CN_ERROR_EVENT = 'error'

/** 用量帧的事件名。 */
export const TRAE_CN_USAGE_EVENT = 'token_usage'

/** 思考帧的事件名。 */
export const TRAE_CN_THOUGHT_EVENT = 'thought'

/** 工具调用帧的事件名。 */
export const TRAE_CN_TOOL_CALL_EVENT = 'tool_call'

/**
 * `output` 帧内**内嵌工具调用**的字段名（2026-09-21 真机定案）。
 *
 * ⚠️ 上游把工具调用直接挂在 `event:output` 帧的 data 里返回，形如：
 *
 * ```
 * event:output
 * data:{"response":"","reasoning_content":null,
 *       "tool_calls":[{"index":0,"id":"call_e73a…","type":"function",
 *                      "function_call":{"name":"glob","arguments":"",…}}],…}
 * ```
 *
 * 而 output 分支原先只读 `response` / `reasoning_content` ⇒ 工具调用被**整块
 * 丢弃** ⇒ 该步既无正文也无 tool-call 块 ⇒ 适配器按「空步」收尾为 `stop`，
 * 回合就此终止且零报错。后果是 trae-cn **从未成功调用过一次工具**。
 *
 * 字段名是 `tool_calls`（复数，与 OpenAI 的 assistant 消息字段同名），
 * 而**调用项内部**用的是 `function_call` —— 详见 {@link parseTraeCnToolCall}。
 */
export const TRAE_CN_TOOL_CALLS_FIELD = 'tool_calls'

/** 排队相关帧的事件名（均按「等待」处理，不产生内容）。 */
export const TRAE_CN_QUEUE_EVENTS: readonly string[] = [
  'request_wait_in_queue', 'queue_begin', 'queue_end', 'queue_continue',
]

/**
 * 从 `output` 帧的 data 里取出正文片段。
 *
 * Trae 的正文载荷是 `response` 字段（调研实测形态）。`content` / `text` /
 * `delta` 是**同义回退**，不是「多协议支持」：真机若字段名不同，这条回退链
 * 能让流不至于一字不出；而万一全部落空，适配器侧的「有 `done` 却零产出」
 * 判定会把这件事显式报成 `EMPTY_RESPONSE`，而不是静默的空回复。
 *
 * 刻意**不做 `String(value)` 兜底**：那会把 `{"a":1}` 这类结构化载荷渲染成
 * 用户可见的乱码。
 */
export function extractTraeCnOutputText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (typeof payload !== 'object' || payload === null) return ''
  const record = payload as Record<string, unknown>
  for (const key of ['response', 'content', 'text', 'delta']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 从 `output` 帧里取出思考片段。
 *
 * **只认真正的「思考」字段**（`reasoning_content` / `reasoning` / `thought`），
 * 绝不回退到 `content` / `text` —— 在 `output` 帧里那两者是**正文**，
 * 把它们当思考会同一段文字既进正文块又进思考块（用户看到内容翻倍）。
 * 思考帧（`event:thought`）的载荷才允许用 `content`/`text` 兜底，
 * 见 {@link extractTraeCnThoughtFrameText}。
 */
export function extractTraeCnThoughtText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const record = payload as Record<string, unknown>
  for (const key of ['reasoning_content', 'reasoning', 'thought']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 从独立的 `thought` 帧里取出思考文本（允许 `content` / `text` 兜底）。
 *
 * ⚠️ **T9 待校准**：Rust 事件清单里有 `thought` 这个事件名，但调研报告**未给出
 * 其载荷字段**。这里对 `reasoning_content` / `reasoning` / `thought` /
 * `content` / `text` 做容忍式读取 —— 对一个**专用思考帧**而言，这几个键无论哪个
 * 承载文本，都只可能是思考内容，故兜底不会造成语义错位（与 `output` 帧不同，
 * 那里的 `content` 是正文）。
 */
export function extractTraeCnThoughtFrameText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (typeof payload !== 'object' || payload === null) return ''
  const record = payload as Record<string, unknown>
  for (const key of ['reasoning_content', 'reasoning', 'thought', 'content', 'text']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 从 `error` 帧里取出的业务错误。 */
export interface TraeCnSseError {
  /** 业务码的原始形态（数字或字符串）。 */
  code: TraeCnErrorCode | undefined
  /** 服务端给的可读文案。 */
  message: string
  /** 由 {@link classifyTraeCnError} 判定的处置动作。 */
  action: TraeCnErrorAction
}

/**
 * 解析 `error` 帧的 data。
 *
 * 形态（调研实测）：`{"code":4008,"message":"..."}`。
 * 同时兼容嵌套一层的 `{"error":{"code":..,"message":..}}` —— 客户端 JS 侧读的
 * 正是 `e.error`，两种形态在同一份客户端代码里都出现过。
 *
 * `httpStatus` 参与分类：业务错误几乎恒为 200，但当错误帧出现在一个非 200
 * 响应上时（网关同时给了状态码与业务码），两者都会被用上，业务码优先。
 */
export function parseTraeCnSseError(payload: unknown, httpStatus = 200): TraeCnSseError {
  if (typeof payload !== 'object' || payload === null) {
    const message = typeof payload === 'string' && payload.length > 0 ? payload : 'unknown error'
    return { code: undefined, message, action: classifyTraeCnError({ httpStatus }) }
  }
  const record = payload as Record<string, unknown>
  const nested = record.error
  const source = typeof nested === 'object' && nested !== null ? nested as Record<string, unknown> : record
  const rawCode = source.code
  const code: TraeCnErrorCode | undefined = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? rawCode
    : undefined
  return {
    code,
    message: pickMessage(source),
    action: classifyTraeCnError({ httpStatus, ...code === undefined ? {} : { sseErrorCode: code } }),
  }
}

/** 依次尝试 `message` / `msg` / `error` 三个文案字段。 */
function pickMessage(source: Record<string, unknown>): string {
  for (const key of ['message', 'msg']) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const nested = source.error
  if (typeof nested === 'string' && nested.length > 0) return nested
  return 'unknown error'
}

/**
 * 把分类动作映射为 harness 错误码。
 *
 * - `switch-account` / `backoff` → `'RATE_LIMIT'`：**两者都必须是可重试码**。
 *   `RATE_LIMIT` 在 DSH 的 `DEFAULT_RETRYABLE_CODES` 里（实测确认，见
 *   `dsh-llm/lib/types/retry-policy.js`），所以 `backoff` 才真的能退避重试；
 *   两者的区别由**适配器**处理（换号循环 vs 直接抛出），错误码只表达
 *   「这是可重试的限流类失败」。发明两个新码会让 DSH 的重试层认不出来，
 *   退避就成了空话。
 * - `fail` 且码命中 {@link TRAE_CN_CONTEXT_OVERFLOW_CODES}（`4006` 请求超长、
 *   `4022` 上下文窗口溢出）→ `CONTEXT_WINDOW_EXCEEDED`：触发 DSH 的上下文自动
 *   压缩恢复；其余 → `INVALID_REQUEST`。
 *
 * ## 为什么判定走码表 + {@link normalizeTraeCnCode}，而不是内联比较
 *
 * 原实现是内联的 `numeric === 4006`，本次扩到两个码时改为**与分类器同源**的
 * 归一化 + 码表查询。理由不是整洁，是**防分叉**：分类器那边判「是不是直报类」
 * 用的是 `normalizeTraeCnCode`（它拒绝 `"code=4008"` 这类诊断文本），若这里
 * 保留另一份内联解析，两处对同一个码的认知迟早不一致 —— 本仓库已有
 * `isModelInCatalog` / `functionForModel` 同源同口径的先例。
 */
export function traeCnErrorCodeForAction(action: TraeCnErrorAction, code?: TraeCnErrorCode): string {
  if (action === 'switch-account' || action === 'backoff') return 'RATE_LIMIT'
  const numeric = normalizeTraeCnCode(code)
  if (numeric !== undefined && TRAE_CN_CONTEXT_OVERFLOW_CODES.includes(numeric)) {
    return 'CONTEXT_WINDOW_EXCEEDED'
  }
  return 'INVALID_REQUEST'
}

/** 从 `tool_call` 帧里取出的工具调用片段。 */
export interface TraeCnToolCallDelta {
  /** 工具调用 id（首片携带；后续片缺失时沿用已记录的值）。 */
  id?: string
  /** 工具名（只允许非空覆盖）。 */
  name?: string
  /** 参数片段（可能被拆成多片）。 */
  argumentsDelta?: string
}

/**
 * 解析一**项**工具调用（不管它来自哪种投递形态）。
 *
 * ## 两种投递形态（2026-09-21 真机定案）
 *
 * 1. **`output` 帧内嵌**：`event:output` 的 data 里带 `tool_calls` 数组，
 *    每项是 `{index, id, type, function_call:{name, arguments}}` ——
 *    这是真机实录的**主要形态**（见 {@link TRAE_CN_TOOL_CALLS_FIELD}）；
 * 2. **独立 `event:tool_call` 帧**：载荷结构未真机取证，按
 *    `{tool_call:{…}}` / 平铺 / OpenAI 式嵌套三种常见形态容忍式读取
 *    （⚠️ **T7 仍待校准**）。
 *
 * 两者共用**这一个**解析入口（不是两份逻辑）：形态 2 的 `{tool_call:{…}}`
 * 外壳在这里剥掉，形态 1 直接传数组里的一项即可。
 *
 * ## ⚠️ 字段名是 `function_call`（**无 er**），不要「修正」成 `function`
 *
 * 这不是笔误，是**同一条协议约定**：出站时 assistant 的
 * `tool_calls[].function` 要**改名 `function_call`** 再发（`buildTraeCnSoloBody`
 * 里那条改名约定，已有逐字节测试钉死），入站就按同名读回。把这里改成
 * `function` 会让整条工具链路**静默**断掉 —— 上游给的字段读不到，表现为
 * 「工具调用凭空消失」，与本次修复的缺陷一模一样。
 * `function` 这个键**仍保留**在读取链上：形态 2 的 OpenAI 式嵌套用它。
 *
 * 全部落空时返回 `undefined`（该项被忽略，而不是产出一个空工具调用）——
 * 这样「结构猜错」表现为工具调用不出现（可观测），而不是伪造出一个
 * `unknown tool ""` 的错误调用污染会话历史。
 */
export function parseTraeCnToolCall(payload: unknown): TraeCnToolCallDelta | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const outer = payload as Record<string, unknown>
  const inner = asRecord(outer.tool_call) ?? outer
  // `function_call` 优先（内嵌形态的原生字段名），`function` 作为形态 2 的嵌套回退。
  const fn = asRecord(inner.function_call) ?? asRecord(inner.function)

  const id = firstString(inner, ['id', 'tool_call_id', 'toolCallId', 'call_id'])
  const name = firstString(inner, ['name', 'tool_name', 'toolName'])
    ?? (fn === undefined ? undefined : firstString(fn, ['name']))
  const rawArgs = inner.arguments ?? inner.args ?? inner.parameters
    ?? (fn === undefined ? undefined : fn.arguments)
  let argumentsDelta: string | undefined
  if (typeof rawArgs === 'string') argumentsDelta = rawArgs
  // 结构化参数（非流式下发整包）：序列化回字符串，交给 harness 的常规解析路径。
  else if (typeof rawArgs === 'object' && rawArgs !== null) argumentsDelta = JSON.stringify(rawArgs)

  if (id === undefined && name === undefined && argumentsDelta === undefined) return undefined
  return {
    ...id === undefined ? {} : { id },
    ...name === undefined ? {} : { name },
    ...argumentsDelta === undefined ? {} : { argumentsDelta },
  }
}

/** 取出对象形态的值；标量 / null / 数组一律视为不存在。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 一个**待累积**的工具调用分片：统一的 wire 编号 + 待解析载荷。
 *
 * 两种投递形态（内嵌数组的一项、独立帧的整包）都先归一成这个形状，
 * 再由 {@link accumulateTraeCnToolCall} 走**同一条**累积路径。
 */
interface TraeCnToolCallEntry {
  /** wire 层调用编号：同一批次内不同调用靠它分块。 */
  wireIndex: number
  /** 交给 {@link parseTraeCnToolCall} 的载荷。 */
  payload: unknown
}

/**
 * 从 `output` 帧的 data 里取出内嵌的工具调用条目。
 *
 * 只认**数组**形态的 `tool_calls`：`null` / `undefined` / 标量一律当「本帧没有
 * 工具调用」（上游在纯正文帧里发的是 `"tool_calls":null`，实测如此）。
 * 数组**为空**同样不产出任何东西（不是错误，只是没有调用）。
 */
function traeCnEmbeddedToolCallEntries(data: unknown): TraeCnToolCallEntry[] {
  const record = asRecord(data)
  if (record === undefined) return []
  const raw = record[TRAE_CN_TOOL_CALLS_FIELD]
  if (!Array.isArray(raw)) return []
  return raw.map((item, position) => ({ wireIndex: readTraeCnToolCallIndex(item, position), payload: item }))
}

/**
 * 读内嵌调用项自带的 wire 编号；缺失 / 非法时回退到它在数组中的位置。
 *
 * 回退值是**位置**而不是 0：并行调用里若某一项漏发 `index`，写死 0 会让它
 * 悄悄并进第一个调用的参数串（表现为「第一个工具的参数突然多出一段」）。
 */
function readTraeCnToolCallIndex(item: unknown, fallback: number): number {
  const record = asRecord(item)
  if (record === undefined) return fallback
  const value = record.index
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** 累积中的工具调用块（`callId` 可被后续分片更新，`text` 是参数全文）。 */
export interface TraeCnToolCallBlock {
  /** harness 侧的块序号（按创建顺序分配）。 */
  index: number
  /** 已累积的参数片段（可能是半截 JSON，收尾时才判定）。 */
  text: string
  /** 调用 id。 */
  callId: string
  /** 工具名（只允许非空覆盖）。 */
  name?: string
  /** 是否已发过 `block-start`（名字可用的那一刻才发，见 `accumulateTraeCnToolCall`）。 */
  announced: boolean
}

/**
 * 把一**个**工具调用分片累积进已有块（或建新块），返回应产出的 chunk。
 *
 * ⚠️ 两种投递形态共用这一个函数是刻意的：内嵌 `tool_calls` 与独立
 * `event:tool_call` 帧的**累积语义完全一致**（OpenAI 式：首片带 `id` / `name`，
 * 后续片为空串 + 参数增量），复制第二份迟早会分叉。
 *
 * 三条判据与既有行为逐字相同：
 * - `id` 允许覆盖（首片缺 id 时后续片可补上）；
 * - **`name` 只允许非空覆盖** —— 后续分片带的空串会清掉首片解析出的工具名，
 *   表现为 `unknown tool ""`；
 * - 参数片段**无条件拼接**（空串拼接是无副作用的）。
 *
 * ⚠️ **名字可用之前不发射任何 chunk**（与 `openai-compat.ts` /`buddy-adapter.ts`
 * 同因同修，见 `src/sse.ts`）：本 provider 的首片**可能只带 id/参数、名字稍后
 * 才到**，若在首片就发 `block-start`，一个**永远不带 name** 的调用会让
 * `BlockAssembler` 组装出 `name:''` 的坏块并持久化进会话（下游端点随后
 * 以 400 code 11133 拒绝每一次请求）。必须让该块一个 chunk 都不产出。
 * 名字一旦可用就把**已累积的全部参数**一次性补发，正常形态行为不变。
 */
function accumulateTraeCnToolCall(
  state: Map<number, TraeCnToolCallBlock>,
  allocateIndex: () => number,
  wireIndex: number,
  delta: TraeCnToolCallDelta,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let block = state.get(wireIndex)
  if (block === undefined) {
    const callId = delta.id ?? `call_${wireIndex}`
    block = {
      index: allocateIndex(),
      text: '',
      callId,
      announced: false,
      ...delta.name === undefined ? {} : { name: delta.name },
    }
    state.set(wireIndex, block)
  } else if (delta.id !== undefined) {
    block.callId = delta.id
  }
  // 只允许非空名字覆盖：后续分片若带空串会清空首个分片解析出的工具名，
  // 表现为 `unknown tool ""`。
  if (delta.name !== undefined && delta.name.length > 0) block.name = delta.name
  const fragment = delta.argumentsDelta ?? ''
  block.text += fragment
  if (!block.announced) {
    // 名字仍不可用：一个 chunk 都不产出（连 block-start 都不能有）。
    if (!hasUsableToolName(block.name)) return chunks
    block.announced = true
    chunks.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
    chunks.push({
      type: 'tool-call-delta',
      index: block.index,
      id: ToolCallId(block.callId),
      name: block.name!,
      argumentsDelta: block.text,
    })
    return chunks
  }
  chunks.push({
    type: 'tool-call-delta',
    index: block.index,
    id: ToolCallId(block.callId),
    ...block.name === undefined ? {} : { name: block.name },
    argumentsDelta: fragment,
  })
  return chunks
}

/** 依次尝试若干键，返回首个非空字符串。 */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 从 `token_usage` 帧解析用量；无可用字段时返回 undefined。 */
export function parseTraeCnUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }
  const input = pick('prompt_tokens', 'input_tokens', 'prompt_tokens_total')
  const output = pick('completion_tokens', 'output_tokens', 'completion_tokens_total')
  if (input === undefined && output === undefined) return undefined
  const cached = pick('cache_read_tokens', 'prompt_cache_hit_tokens', 'cached_tokens')
  const reasoning = pick('reasoning_tokens')
  return {
    // inputTokens 只计**未命中缓存**的部分，命中部分单列 cacheReadTokens
    // （与 buddy / lobsterai 侧同口径），否则缓存命中率显示会偏大。
    inputTokens: input === undefined ? 0 : (cached !== undefined && cached > 0 ? input - cached : input),
    outputTokens: output ?? 0,
    ...cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/** 一次 chat 请求的 SSE 消费结果（供适配器做换号与收尾判定）。 */
export interface TraeCnStreamOutcome {
  /** 是否收到过 `done` 帧。未收到说明连接被中途掐断（工具参数可能是半截 JSON）。 */
  done: boolean
  /** 是否产出过任何正文或思考片段。 */
  produced: boolean
  /** 是否存在工具调用块（**只计已发射的块**，见 `droppedUnnamedCalls`）。 */
  hasToolCalls: boolean
  /** 是否有工具调用的参数无法解析（分片丢失 / 流被截断）。 */
  argumentsTruncated: boolean
  /**
   * 是否丢弃过**名称不可用**的 tool-call 分片（见 `accumulateTraeCnToolCall`）。
   *
   * 丢弃它们是对的（无名调用无法执行、留着会污染会话），但**不能让这一步
   * 静默地以 `stop` 结束** —— 那正是「没有任何报错就中断」：模型本意要调工具，
   * harness 却认为它「正常答完了」。适配器据此改报 `max-tokens`（可重试）。
   */
  droppedUnnamedCalls: boolean
  /**
   * 思考死循环命中（见 `src/reasoning-loop-guard.ts`）。命中后流是被**主动
   * abort** 的，故 `done` 为 false —— 调用方必须**优先**据此报 `max-tokens`，
   * 而不是当成「未收到 done 帧」的截断。
   */
  thoughtLoopDetected?: boolean
  /** 上游以 `event:error` 帧报错时填入（此时 `done` 为 false）。 */
  sseError?: TraeCnSseError
}

/** {@link consumeTraeCnStream} 的入参。 */
export interface TraeCnStreamOptions {
  /** harness 的取消信号。 */
  signal?: AbortSignal
  /** 上游响应的 HTTP 状态码（业务错误几乎恒为 200，仅作分类兜底）。 */
  httpStatus: number
  /** 错误消息前缀（如 `trae-cn`）。 */
  label: string
  /** 两阶段空闲超时：等待首帧与帧间静默。 */
  timeouts: { firstFrameMs: number; chunkMs: number }
}

/**
 * 逐帧翻译 Trae CN 的 SSE 流。
 *
 * **不产出 `finish` chunk，也不抛业务错误** —— 两者都交给调用方：
 * `finish` 的 reason 取决于「换号是否发生」，而业务错误需要调用方结合
 * 「是否已有产出」决定换号还是直报。本函数只做帧 → 块的翻译。
 *
 * 设计要点（每一条都对应一个已知或已踩过的坑）：
 *
 * 1. **行式解析**：只处理完整的 `\n` 结尾行，残行留在 buffer 等下一块 ——
 *    跨 chunk 切断的 `data:` 行是 SSE 解析最常见的错源；
 * 2. **`event:` 与 `data:` 配对**：`event` 行记录当前事件名，`data` 行按该名字
 *    分发；**空行**表示一帧结束并清空事件名（SSE 规范）。`trim()` 同时消化了
 *    CRLF 的 `\r`；
 * 3. **事件名未知的 `data` 行被忽略**（不发正文）：把「事件行缺失」当 `output`
 *    会让 error/done 帧的载荷被渲染成用户可见的正文；
 * 4. **畸形 JSON 帧跳过**：一个坏帧不该让整条会话报废（与 lobsterai 侧同策略）；
 * 5. **`done` 帧立即停止读取**（与客户端 `parseSSEStream` 一致）：Trae 在
 *    `done` 之后不再发内容，继续读只会白等到空闲超时。
 */
export async function* consumeTraeCnStream(
  response: Response,
  options: TraeCnStreamOptions,
): AsyncGenerator<StreamChunk, TraeCnStreamOutcome, void> {
  const { label, timeouts, signal } = options
  if (!response.body) throw new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstFrameReceived = false

  let eventName = ''
  let textIndex: number | undefined
  let thoughtIndex: number | undefined
  let nextIndex = 0
  let text = ''
  let thought = ''
  let produced = false
  let done = false
  let sseError: TraeCnSseError | undefined
  /**
   * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
   * reasoning 增量、中止上游（`reader.cancel()`），收尾时发截断后的思考块，
   * 并让 finish 报 max-tokens。
   *
   * 本函数不产出 `finish`（reason 由调用方决定），故命中状态经
   * {@link TraeCnStreamOutcome.thoughtLoopDetected} 旁路传出。
   */
  const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
  let loopDetected = false
  const toolCalls = new Map<number, TraeCnToolCallBlock>()

  try {
    while (!done && sseError === undefined) {
      const timeoutMs = firstFrameReceived ? timeouts.chunkMs : timeouts.firstFrameMs
      const phase = firstFrameReceived ? 'chunk' : 'first-token'
      const result = await readWithIdleTimeout(reader, timeoutMs, label, signal, phase)
      if (result.done) break
      firstFrameReceived = true
      buffer += decoder.decode(result.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)

        if (line.length === 0) {
          // 空行 = 一帧结束，事件名按 SSE 规范清除。
          eventName = ''
          continue
        }
        if (line.startsWith(':')) continue // 注释行（心跳）
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (!line.startsWith('data:')) continue
        // 兼容 `data: {...}` 与 `data:{...}`（上游两种写法都可能出现）。
        const payload = line.slice(5).trim()
        if (payload.length === 0) continue

        if (TRAE_CN_METADATA_EVENTS.includes(eventName)) continue
        if (TRAE_CN_QUEUE_EVENTS.includes(eventName)) continue
        if (eventName === TRAE_CN_DONE_EVENT) {
          done = true
          break
        }
        if (eventName === TRAE_CN_ERROR_EVENT) {
          let parsed: unknown = payload
          try {
            parsed = JSON.parse(payload)
          } catch {
            // 错误帧本身不是 JSON：把原文当文案交出（比吞掉有用）。
          }
          sseError = parseTraeCnSseError(parsed, options.httpStatus)
          break
        }
        if (eventName === TRAE_CN_USAGE_EVENT) {
          let usage: unknown
          try {
            usage = JSON.parse(payload)
          } catch {
            continue
          }
          const parsed = parseTraeCnUsage(usage)
          if (parsed !== undefined) yield { type: 'usage', usage: parsed }
          continue
        }

        let data: unknown
        try {
          data = JSON.parse(payload)
        } catch {
          // 畸形帧跳过：一个坏帧不该让整条会话报废。
          continue
        }

        if (eventName === TRAE_CN_THOUGHT_EVENT) {
          const piece = extractTraeCnThoughtFrameText(data)
          if (piece.length > 0) {
            // 死循环守卫（出口 ①：独立 `thought` 事件）：命中后不再累积、不再发射。
            //
            // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
            // 本 chunk 的行循环**全部处理完之后**、外层 `while` 末尾执行（见下方
            // ★ 止损块）—— 这样同一 chunk 里已到达的 `token_usage` / `done` 仍会
            // 被处理。
            // ⚠️ 也**不能用 `continue`**：本分支的 `continue` 会跳过本帧之后的
            // 处理（`thought` 事件本身不与其它内容同帧，但保持与出口 ② 同构的
            // 写法可避免将来改动时踩坑）。故用 `if (!loopDetected)` 守卫分支体。
            if (loopGuard !== undefined) {
              if (loopGuard.observe(piece)) loopDetected = true
            }
            if (!loopDetected) {
              if (thoughtIndex === undefined) {
                thoughtIndex = nextIndex++
                yield { type: 'block-start', index: thoughtIndex, blockType: 'reasoning' }
              }
              produced = true
              thought += piece
              yield { type: 'reasoning-delta', index: thoughtIndex, text: piece }
            }
          }
          continue
        }

        if (eventName === TRAE_CN_TOOL_CALL_EVENT) {
          const delta = parseTraeCnToolCall(data)
          if (delta === undefined) continue
          // 上游未给 index 时按「同一批次的后续分片」处理：单工具场景下分片
          // 必然同属一个调用，用 0 作 wire index 与 OpenAI 侧口径一致。
          for (const chunk of accumulateTraeCnToolCall(toolCalls, () => nextIndex++, 0, delta)) {
            produced = true
            yield chunk
          }
          continue
        }

        if (eventName === TRAE_CN_OUTPUT_EVENT) {
          const piece = extractTraeCnOutputText(data)
          const thoughtPiece = extractTraeCnThoughtText(data)
          // ⚠️ **工具调用与正文共存于同一帧时两者都要产出**（不是二选一）：
          // 上游确实会在一帧里同时给「一句话说明 + 一个工具调用」（实测形态）。
          // 这里的次序（正文 → 思考 → 工具调用）与块的创建顺序一致，harness
          // 按 `index` 组装，先后不影响正确性。
          const toolCallEntries = traeCnEmbeddedToolCallEntries(data)
          if (piece.length > 0) {
            if (textIndex === undefined) {
              textIndex = nextIndex++
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            produced = true
            text += piece
            yield { type: 'text-delta', index: textIndex, text: piece }
          }
          if (thoughtPiece.length > 0) {
            // 死循环守卫（出口 ②：`output` 事件内嵌思考）：与出口 ① 同一判据。
            //
            // ⚠️ 也**不能用 `continue`**：它会连带跳过本帧位于思考分支**之后**的
            // 工具调用解析（一个 `output` 事件确实可能同时携带思考与工具调用）。
            // 故用 `if (!loopDetected)` 守卫分支体。
            if (loopGuard !== undefined) {
              if (loopGuard.observe(thoughtPiece)) loopDetected = true
            }
            if (!loopDetected) {
              if (thoughtIndex === undefined) {
                thoughtIndex = nextIndex++
                yield { type: 'block-start', index: thoughtIndex, blockType: 'reasoning' }
              }
              produced = true
              thought += thoughtPiece
              yield { type: 'reasoning-delta', index: thoughtIndex, text: thoughtPiece }
            }
          }
          for (const entry of toolCallEntries) {
            const delta = parseTraeCnToolCall(entry.payload)
            // 单项缺 `function_call`（id / name / arguments 全落空）→ **跳过该项**，
            // 而不是伪造出一个空调用。
            if (delta === undefined) continue
            for (const chunk of accumulateTraeCnToolCall(toolCalls, () => nextIndex++, entry.wireIndex, delta)) {
              produced = true
              yield chunk
            }
          }
          continue
        }
        // 其余事件（timing_cost / extra_info / suggested_questions / turn_completion …）
        // 直接忽略：它们不产出 harness 的块类型，也不影响流的完整性。
      }
      // ★ 止损：命中死循环后**中止上游**，否则输出额度照烧。
      // 只跳过下行累积/发射、却把流读到底，则上游继续生成，额度照烧。
      //
      // ⚠️ 位置：内层行循环**之后**、外层 `while` 末尾 —— 同一 chunk 里已到达的
      // `token_usage` / `done` 事件因此仍会被处理，但命中后**立即**退出，不再读下一块。
      //
      // ⚠️ 只 cancel **reader**，绝不 abort `signal`：后者是调用方信号，
      // abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`
      // （DSH 在 `max-tokens` 时**不自动重试**，由用户/上层决定是否继续）。
      // ⚠️ `.catch(() => {})` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把
      // 「正常止损」变成一次失败。
      if (loopDetected) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 收尾：按创建顺序闭合已开启的块（harness 要求 block-end 携带拼装结果）。
  // ⚠️ 只闭合**已发射**的块：名字始终不可用的块一个 chunk 都不该产出，否则
  // `BlockAssembler` 会组装出 `name:''` 的坏块并污染会话（见
  // `accumulateTraeCnToolCall` 的说明）。
  for (const block of toolCalls.values()) {
    if (!block.announced || !hasUsableToolName(block.name)) continue
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name!,
        // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
        // 由调用方的 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {}
        // 会伪造出合法外观，让 harness 报 missing required property 而非重试。
        arguments: normalizeToolArguments(block.text),
      },
    }
  }
  if (textIndex !== undefined) {
    // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: stripCourseLeakIfEnabled(text) } }
  }
  if (thoughtIndex !== undefined && thought.length > 0) {
    // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
    // **权威覆盖**：即便前面已 yield 了全部重复 delta，这里发截断后的 block
    // 即可，无需撤回。
    const thoughtText = loopDetected && loopGuard?.cutAt !== undefined
      ? thought.slice(0, loopGuard.cutAt)
      : thought
    // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
    const cleanedThought = stripCourseLeakIfEnabled(thoughtText)
    if (cleanedThought !== '') {
      yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: cleanedThought } }
    }
  }
  return {
    done,
    produced,
    // 只计**已发射**的块：名字不可用的块被丢弃，不该算作「有工具调用」
    // （否则调用方会报 tool-calls，让 harness 去执行一个并不存在的调用）。
    hasToolCalls: [...toolCalls.values()].some(block => block.announced),
    argumentsTruncated: [...toolCalls.values()].some(block => isTruncatedArguments(block.text)),
    /**
     * 是否丢弃过**名称不可用**的 tool-call 块（见 `accumulateTraeCnToolCall`）。
     *
     * 丢弃是对的（无名调用无法执行、留着会污染会话），但不能让它**静默地以
     * `stop` 结束** —— 那正是「没有任何报错就中断」。调用方据此改报 max-tokens。
     */
    droppedUnnamedCalls: [...toolCalls.values()].some(block => !block.announced),
    // 命中死循环时流是被**主动 abort** 的（`done` 为 false），调用方必须
    // **优先**据此报 `max-tokens`，而不是当成「未收到 done 帧」的截断。
    ...loopDetected ? { thoughtLoopDetected: true } : {},
    ...sseError === undefined ? {} : { sseError },
  }
}

/**
 * 把 harness 消息序列化为 Trae CN 的 chat 请求体里的 `messages` 数组。
 *
 * 与 `lobsterai-adapter.ts` 的 `serializeMessages` **刻意保持同一形态**
 * （OpenAI chat-completions 消息数组）：Trae 的 chat 端点接受的正是这套消息结构，
 * 差异只在**外层**（SSE 事件名与请求字段名），不在消息结构本身。
 *
 * 两条通用协议要求必须保留（与厂商无关，见 `src/sse.ts` 的说明）：
 * - **剔除无法配对的 tool_call / tool-result**：后端会以 400 拒绝整个请求，
 *   而这条坏历史会被每次请求原样重放 —— 表现为「会话突然报废，此后所有消息
 *   都无回复」。发出前剔除可让会话自愈；
 * - assistant 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）。
 *
 * ## 图片（`imageUrls`）
 *
 * `imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined（**含空 Map**）
 * 时把带图的 user 消息升级为多模态 parts（`{type:'image_url',image_url:{url}}`）。
 * 空 Map **不能**降级为 undefined —— 那会让「图片存在但字节读取失败」的
 * `[image unavailable]` 占位符也被跳过，图片静默消失。
 *
 * ⚠️ 图片形态沿用 SOLO 对数组 content 的**原样透传**（实测上游直接接受），
 * 无需额外协议转换 —— 见 {@link userContentParts}。
 */
export function serializeTraeCnMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  // 工具结果内嵌图片（`read_image` 等）不能并入 `role:'tool'` 消息：该角色的
  // content 只能是字符串，且必须紧跟其 assistant tool_call，中间插消息会 400。
  // 故挂起到其后的独立 user 消息统一发出（与 buddy / lobsterai 同款处理）。
  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
      // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
      // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
      const content = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : [],
      )
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
    // 图片：仅当本请求带图（imageUrls 非 undefined）时升级为多模态 parts。
    const parts = imageUrls === undefined ? undefined : userContentParts(content, imageUrls)
    if (parts !== undefined) {
      // 有图：正文与图片合并为一条多模态 user 消息（parts 里已含文本块）。
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 的结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      const innerParts = imageUrls === undefined
        ? undefined
        : (Array.isArray(result.content) ? userContentParts(result.content, imageUrls) : undefined)
      if (innerParts !== undefined) {
        // 工具结果内嵌图片：该消息的 content 只能是字符串，图片挂到后续独立
        // user 消息里（不能就地展开，否则违反 role:'tool' 的协议约束）。
        pendingToolImages.push(...innerParts.filter((part) => part.type === 'image_url'))
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || (innerParts !== undefined ? TOOL_RESULT_IMAGE_TEXT : '(no output)'),
      })
    }
    flushToolImages()
  }
  return wire
}

/** 工具结果内嵌图片的载体文本（与 buddy / lobsterai 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * 把 harness 内容块转成 OpenAI 多模态 parts（含图片）。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— **实测上游唯一接受的
 * 形态**：SOLO 对数组 content 原样透传，这种 parts 形状直发即可被模型读到
 * （纯红图答「红色」、纯蓝图答「蓝色」，不带图则答「无法确定」）。故无需任何
 * 额外的协议转换。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 `collectImages` **对称地递归**处理 `tool-result` 内层：收集侧是任意深度，
 * 序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
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
export function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
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
