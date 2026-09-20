/**
 * Qoder 上游错误分类。
 *
 * 与 `src/trae-cn-errors.ts` / `src/lobsterai-errors.ts` **平行而非复用**：三条协议线
 * 的错误码体系毫无交集 —— LobsterAI 判 HTTP 状态码 + 中英关键词，Trae CN 判
 * HTTP 200 响应体里的**数字**业务码，而 Qoder 的码值**一半是数字、一半是字符串**，
 * 且 401 根本没有 `code` 字段。共用一套判定只会让三方都变得难以推理。
 *
 * ## T3 真机实测事实（逐字节，本模块的全部判据来源）
 *
 * 两类错误，边界 = **网关层 vs 上游模型层**：
 *
 * | 场景 | HTTP | 容器 | `code` | 文案字段 |
 * |---|---|---|---|---|
 * | quota=0 / 无效模型名 / `model:""` | **402** | pre-stream | `116`（**数字**） | `error` |
 * | `messages:[]` + `stream:true` | **200** | **流内** | `"invalid_parameter_error"` | `message` |
 * | `messages:[]` + `stream:false` | **400** | pre-stream | `"provider_error"` + `details` | `message` |
 * | 缺 `model` + `stream:true` | **200** | **流内** | `"invalid_model_error"` | `message` |
 * | 伪造 jt / PAT 直打 chat | **401** | pre-stream | **无 `code` 字段** | `error` |
 *
 * 由此推出的五条硬约束，实现与使用方都不得违反：
 *
 * 1. **不能只看状态码判成功**：流内错误是 **HTTP 200**，而成功流的唯一收尾判据是
 *    `[DONE]`；两类错误**都绝不出 `[DONE]`**。故本模块的 `status` 只做兜底。
 * 2. **`code` 字段类型不一致**：402 是数字 `116`，400/流内是字符串 —— 分类器**两种都收**。
 * 3. **401 没有 `code`**，只有 `{"error":"unauthorized"}` —— 分类器不能假定 `code` 恒存在。
 * 4. **402 语义污染**：quota=0 时**无效模型名也回 402 `code:116`**（网关先做扣费检查）。
 *    ⇒ **402 绝不可硬编码为「额度耗尽、可换号」**，必须先经额度端点二次判别
 *    （{@link applyQoderQuotaVerdict}）。
 * 5. **同一错误可能发 2 遍**（两个**不同** `chatcmpl-…` id、同一 message）→ 去重取首帧
 *    （{@link createQoderErrorDeduper}）。
 *
 * ## 三类动作
 *
 * | 动作 | 含义 | 由谁执行 |
 * |---|---|---|
 * | `switch-account` | 换下一个账号重试（**仅确证的额度耗尽**） | 适配器的换号循环 |
 * | `backoff` | **不换号**，退避重试同一账号 | DSH 的重试层（抛可重试错误码） |
 * | `fail` | 直接报错给用户 | 适配器抛出带原始 code/message 的错误 |
 *
 * ## 两段式判定：先分类，再由额度端点确证
 *
 * {@link classifyQoderError} 只能看到**错误本身**，看不到账号的额度。因此对
 * 402 + 116 它只标 `quotaCandidate`（候选）并给 `fail`；真正的换号决定由
 * {@link applyQoderQuotaVerdict} 依据额度端点的查询结果做出。这样「未确证前
 * 绝不换号」成为**类型上的默认值**，而不是一句口头约定。
 *
 * 本模块**只有纯函数**，无副作用、不发请求（不 import fetch），故可整表穷举单测。
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'

/**
 * 失败处置动作。
 *
 * 刻意用字符串字面量而非数字：码值在日志与测试断言里可读性差，
 * 且 `'switch-account'` 直接就是适配器要做的动作名。
 */
export type QoderErrorAction =
  /** 换下一个账号重试（**仅确证的额度耗尽**）。 */
  | 'switch-account'
  /** 不换号，退避重试（限流 / 网关瞬时故障）。 */
  | 'backoff'
  /** 直接报错（参数错误 / 模型名错误 / 未知码 / 未确证的 402）。 */
  | 'fail'

/**
 * 业务码的两种输入形态（402 是数字，其余是字符串）。
 *
 * 上游在同一个端点的不同错误里给不同类型：`{"code":116}` 与
 * `{"code":"provider_error"}` 都是实测原文，故两个都收。
 */
export type QoderErrorCode = number | string

/** 错误来源端点（决定 401 的语义分型）。 */
export type QoderErrorSource = 'chat' | 'quota'

/** {@link classifyQoderError} 的入参。 */
export interface QoderErrorInput {
  /** HTTP 状态码；省略视为「未知」。 */
  httpStatus?: number
  /** 业务码（数字或字符串）。 */
  code?: QoderErrorCode
  /** 上游人类可读文案（402 时来自 `error` 字段，其余来自 `message`）。 */
  message?: string
  /** 错误来自哪个端点；省略视为 `'chat'`。 */
  source?: QoderErrorSource
  /** 响应体原文（用于 `provider_error` 包装码的 `details` 二次解析）。 */
  body?: string
  /**
   * 本次分类是否发生在「已重换过一次 jt 之后」。
   * 为 true 时 chat 端点的 401 由「jt 过期」升级为「凭据失效」。
   */
  afterJobTokenRetry?: boolean
}

/** 额度二次判别的结论（步骤 4 接入时由 quota 端点填充）。 */
export interface QoderQuotaVerdict {
  /** quota 端点是否确认额度已耗尽。 */
  exhausted: boolean
}

/** 分类结果。 */
export interface QoderErrorClassification {
  /** 当前知识下的处置动作。 */
  action: QoderErrorAction
  /** 归一化前的业务码原文（有则带）。 */
  code?: QoderErrorCode
  /** HTTP 状态码（有则带）。 */
  status?: number
  /** 是否「额度类候选」（402 + code 116）—— **未确证**，绝不据此换号。 */
  quotaCandidate: boolean
  /** 是否已由 {@link applyQoderQuotaVerdict} 确证为额度耗尽。 */
  quotaConfirmed: boolean
  /** chat 401 的「jt 过期」信号：适配器应先 invalidate + 重换一次再试。 */
  jobTokenExpired: boolean
  /** 凭据（PAT）失效：需用户重新粘贴。 */
  credentialInvalid: boolean
  /** `provider_error` 包装码二次解析出的真码（有则带）。 */
  wrappedCode?: string
  /** 面向用户的中文文案（含上游原文）。 */
  message: string
}

/** 流内 error 帧的解析结果。 */
export interface QoderStreamErrorFrame {
  /** 业务码（有则带）。 */
  code?: QoderErrorCode
  /** 人类可读文案。 */
  message: string
  /**
   * `details` 字段原文（有则带）。
   *
   * ⚠️ **`provider_error` 流内帧的真因只在这里**：外层 `message` 恒为
   * `"Error in upstream response"` / `"All models failed"` 这类无信息量的泛化文案，
   * 上游后端真正说了什么（`'function' is a required property, expected an object -
   * 'tools.0'` 等）全部藏在 `details` 里。帧解析器**必须**把它带出来，否则适配器
   * 的流内分支就只能输出「未能从 details 中二次解析出真码」。
   *
   * 保持**原文**（不在这里解析）：二次解析是 {@link parseQoderWrappedDetailCode}
   * 的职责，两处各写一份必然分叉。
   */
  details?: string
  /** 帧 id（`chatcmpl-…` / `request_id`），仅供日志。 */
  frameId?: string
}

/** 成功状态码（流内错误恰恰发生在 200 上，见模块头注释第 1 条）。 */
const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_FORBIDDEN = 403
const HTTP_REQUEST_TIMEOUT = 408
const HTTP_TOO_MANY_REQUESTS = 429

/**
 * 额度类候选码（402 上的数字码）。
 *
 * ⚠️ **它同时覆盖「模型名无效」** —— 网关先做扣费检查，quota=0 时无效模型名
 * 也回 402/116。所以本常量**只用于标候选**，绝不用于直接决定换号。
 */
const QODER_QUOTA_CODE = 116

/** 包装码：真实业务码藏在字符串化的 `details` 里（形态 C）。 */
const QODER_PROVIDER_ERROR_CODE = 'provider_error'

/** 额度端点 401 的两条可区分文案（真机实测，大小写不敏感）。 */
const QODER_TOKEN_EXPIRE_MARKERS: readonly string[] = ['TOKEN_EXPIRE', 'TOKEN IS NOT ACTIVE']
const QODER_TOKEN_INVALID_MARKERS: readonly string[] = ['TOKEN_INVALID']

/**
 * 流内已知业务码 → 面向用户的中文解释。
 *
 * 只影响**文案**，不影响动作（三个都是 `'fail'`）。不在表里的码走
 * 「未知码直报」路径，文案里只带原始码与原文 —— 不猜语义。
 */
const QODER_STREAM_CODE_HINTS: Readonly<Record<string, string>> = {
  invalid_parameter_error: '请求参数不合法（上游拒绝了消息角色/结构，例如 role 不在允许集合内）。',
  invalid_model_error: '模型名不受支持（「model」为空或不在该账号的可用目录里）。',
}

/** 判定值是否为「普通对象」（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 宽松 JSON 解析。
 *
 * 用 `undefined` 作失败哨兵是安全的：`JSON.parse` 的成功返回值只可能是
 * null / 布尔 / 数字 / 字符串 / 对象 / 数组，**永远不会是 undefined**。
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 把任意形态的业务码归一化成数字；非法值返回 undefined。
 *
 * - 数字：只接受有限值（`NaN` / `Infinity` 视为非法）；
 * - 字符串：去空白后必须**整串是整数** —— `"116"`、`" 116 "` 是码，
 *   `"code=116"` 之类不是。若被 parseInt 静默截取，会把诊断文本误判成业务码。
 */
export function normalizeQoderCode(code: QoderErrorCode | undefined): number | undefined {
  if (code === undefined) return undefined
  if (typeof code === 'number') return Number.isFinite(code) ? code : undefined
  const trimmed = code.trim()
  if (trimmed.length === 0) return undefined
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** 把未知值读成「非空字符串形式的码」（数字归一成字符串）。 */
function readCodeText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  return undefined
}

/** 把未知值读成「原样保留的业务码」（数字保持数字、字符串保持字符串）。 */
function readRawCode(value: unknown): QoderErrorCode | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined
  return undefined
}

/** 读非空字符串字段（用于 `message` / `msg` / `id` / `request_id`）。 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `details` 的二次解析结果。
 *
 * 真机实测（2026-09-21）表明不同上游后端往 `details` 里填的字段**各不相同**，
 * 只有「码」一个出口会让大多数形态的真因丢失 —— 故两个字段分开承载：
 * 有码给码，没码就把上游自己的话（`reason`）透出来。
 */
export interface QoderWrappedDetail {
  /** 真码（`.error.code` → 根层 `.code`）；解析不出时 undefined。 */
  code?: string
  /** 上游自己的文案（`.error.message` → 根层 `.message`）；解析不出时 undefined。 */
  reason?: string
}

/**
 * 剥掉 `details` 里可能套着的一层 SSE 帧外壳。
 *
 * ⚠️ **真机实测的怪形态**：`details` 的值有时是**一整个 SSE 帧的原文**
 * （`data: {"error":{…}}`，末尾还带换行），而不是纯 JSON —— 直接 `JSON.parse`
 * 必然抛异常，真码就此丢失。实测原文（`qmodel` + Raw 形态 tools）：
 *
 * ```text
 * data: {"error":{"code":"invalid_parameter_error","param":null,
 *   "message":"'function' is a required property, expected an object - 'tools.0'",
 *   "type":"invalid_request_error"},"id":"chatcmpl-0643bca2-…"}
 * ```
 *
 * 只取**第一个** `data:` 行的载荷：`details` 里塞完整流是上游的实现细节，
 * 而错误帧恒在首个数据帧里。
 */
function unwrapSseDataLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('data:')) return trimmed.slice('data:'.length).trim()
  }
  return text.trim()
}

/**
 * 从 `details`（字符串化 JSON 或对象）里二次解析真码与上游文案。
 *
 * ## 三类实测形态（全部真机取证，2026-09-21）
 *
 * | 形态 | `details` 原文（节选） | 解析结果 |
 * |---|---|---|
 * | T3 原形态 | `{"error":{"message":"…","type":"…","param":null,"code":"invalid_parameter_error"},"id":"chatcmpl-…"}` | `code` |
 * | SSE 帧套壳 | `data: {"error":{"code":"invalid_parameter_error",…}}`（带换行） | `code`（剥壳后） |
 * | **无码形态** | `{"error":{"message":"Invalid request: unknown tool type: , …","type":"invalid_request_error"}}` / `{"type":"error","error":{"type":"bad_request_error","message":"invalid params, invalid tool type:  (2013)","http_code":"400"}}` | 只有 `reason` |
 * | 根层文案 | `{"message":"Access to Anthropic models is not allowed for this account."}` | 只有 `reason` |
 *
 * 解析规则（顺序即优先级，**只返回非空字符串**，数字归一成字符串）：
 * 码取 `error.code` → 根层 `code`；文案取 `error.message` → 根层 `message`。
 *
 * ⚠️ **解析失败、不是对象、字段全缺一律返回空对象** —— 宁可说「没解析出来」，
 * 也不把包装码 `provider_error` 当成真码。
 *
 * @param details - `details` 字段的值（字符串化 JSON、对象，或任何别的东西）。
 */
export function parseQoderWrappedDetail(details: unknown): QoderWrappedDetail {
  let value = details
  if (typeof details === 'string') {
    value = tryParseJson(details)
    // 第一次解析失败时才剥 SSE 外壳（正常 JSON 里不会有 `data:` 前导行，
    // 故这个兜底不会改变既有形态的解析结果）。
    if (value === undefined) value = tryParseJson(unwrapSseDataLine(details))
  }
  if (!isRecord(value)) return {}
  const nested = isRecord(value.error) ? value.error : undefined
  const code = (nested === undefined ? undefined : readCodeText(nested.code)) ?? readCodeText(value.code)
  const reason = (nested === undefined ? undefined : readText(nested.message))
    ?? readText(value.message)
  return {
    ...code === undefined ? {} : { code },
    ...reason === undefined ? {} : { reason },
  }
}

/**
 * 从 `details`（字符串化 JSON 或对象）里二次解析真码。
 *
 * 形态 C 的实测原文里，400 的外层码是包装码 `provider_error`，**真码**
 * `invalid_parameter_error` 藏在**转义过的 JSON 字符串** `details` 里：
 *
 * ```json
 * {"code":"provider_error","message":"Error in upstream response",
 *  "details":"{\"error\":{\"message\":\"<400> …\",\"type\":\"invalid_request_error\",
 *              \"param\":null,\"code\":\"invalid_parameter_error\"}, … }"}
 * ```
 *
 * 因此必须**先 JSON.parse 一次**才能看到 `details.error.code`。两种输入都收：
 * 字符串（自己再解析一次）与对象（调用方已解析）；依次尝试 `.error.code`
 * 与 `.code`，**只返回非空字符串**（数字归一成字符串）。解析失败、不是对象、
 * 找不到字段一律 undefined —— 宁可说「没解析出来」，也不把包装码当成了真码。
 *
 * ⚠️ 本函数是 {@link parseQoderWrappedDetail} 的**码视图**（只取 `code`）：
 * 需要上游文案的调用方请直接用那个函数，两者的解析规则**只有一处实现**。
 *
 * @param details - `details` 字段的值（字符串化 JSON、对象，或任何别的东西）。
 * @returns 真码字符串；无法解析时 undefined。
 */
export function parseQoderWrappedDetailCode(details: unknown): string | undefined {
  return parseQoderWrappedDetail(details).code
}

/**
 * 解析流内 error 帧的 data 载荷（兼容形态 A 的嵌套 `error` 与形态 B 的平铺）。
 *
 * 两种形态都实测到过，且**结构不同**：
 *
 * - 形态 A（`messages:[]` 流式）：`{"error":{"code":"invalid_parameter_error",
 *   "message":"<400> …","type":"invalid_request_error"},"id":"chatcmpl-…"}`
 *   —— 错误**嵌套在 `error` 对象**里，`code` 是字符串；
 * - 形态 B（缺 `model` 流式）：`{"code":"invalid_model_error","message":"Unsupported
 *   model \"\"","request_id":"…"}` —— `code` **平铺在根层**，且前面有一行
 *   `event: error`（规范 SSE，`data:` 行本身仍是标准 JSON）。
 *
 * 其余输入的处置：字符串整串当 `message`；null / 数字 / 数组一律
 * `message: 'unknown error'` 且无 code —— 宁可给一句占位，也不发明一个假码。
 *
 * 文案回退链：`message` → `msg` → `error`（字符串形态，即 401 的
 * `{"error":"unauthorized"}`）→ `'unknown error'`。
 * `frameId` 取 `id` → `request_id`，**仅字符串且非空**才带（它只用于日志，
 * 不参与任何判定，见 {@link createQoderErrorDeduper}）。
 *
 * @param payload - `data:` 行的 JSON 解析结果（或原始字符串）。
 * @returns 归一化的错误帧。
 */
export function parseQoderStreamErrorPayload(payload: unknown): QoderStreamErrorFrame {
  if (typeof payload === 'string') {
    return { message: payload.length > 0 ? payload : 'unknown error' }
  }
  if (!isRecord(payload)) {
    return { message: 'unknown error' }
  }
  const frameId = readText(payload.id) ?? readText(payload.request_id)
  // `details` 原样带出（字符串或对象都收）：`provider_error` 流内帧的真因只在那里，
  // 丢了它适配器就只能报「未能从 details 中二次解析出真码」（用户报障的次要成因）。
  const rawDetails = payload.details
  const details = typeof rawDetails === 'string' && rawDetails.length > 0
    ? rawDetails
    : isRecord(rawDetails) ? JSON.stringify(rawDetails) : undefined
  const withMeta = <T extends QoderStreamErrorFrame>(frame: T): T => ({
    ...frame,
    ...frameId === undefined ? {} : { frameId },
    ...details === undefined ? {} : { details },
  })

  const nested = payload.error
  if (isRecord(nested)) {
    // 形态 A：错误嵌套在 error 对象里。
    const message = readText(nested.message)
      ?? readText(nested.msg)
      ?? readText(payload.message)
      ?? readText(payload.msg)
      ?? 'unknown error'
    const code = readRawCode(nested.code)
    return withMeta(code === undefined ? { message } : { code, message })
  }

  // 形态 B：code / message 平铺在根层。
  const message = readText(payload.message)
    ?? readText(payload.msg)
    ?? readText(payload.error)
    ?? 'unknown error'
  const code = readRawCode(payload.code)
  return withMeta(code === undefined ? { message } : { code, message })
}

/**
 * 从响应体原文里捞出 `provider_error` 的真码与上游文案。
 *
 * 三种输入形态都要认：**整个响应体**（形态 C，真因在 `details` 字段里）、
 * **`details` 本身**（调用方已剥掉外层）、以及**流内帧的 `details` 原文**
 * （`parseQoderStreamErrorPayload` 带出来的那个字符串）。
 *
 * ⚠️ 不能直接把整个响应体喂给 {@link parseQoderWrappedDetail} —— 那会读到外层的
 * `.code` 并返回包装码 `provider_error` 冒充真码。
 */
function extractWrappedDetail(body: string | undefined): QoderWrappedDetail {
  if (body === undefined) return {}
  const parsed = tryParseJson(body)
  if (parsed === undefined) {
    // 不是 JSON：可能就是一个裸的 `details` 字符串（流内帧路径）。
    return parseQoderWrappedDetail(body)
  }
  if (!isRecord(parsed)) return parseQoderWrappedDetail(parsed)
  if (parsed.details !== undefined) return parseQoderWrappedDetail(parsed.details)
  const direct = parseQoderWrappedDetail(parsed)
  // 剥过外层但仍含包装码时，说明真码确实没带出来 —— 不要返回包装码。
  return direct.code === QODER_PROVIDER_ERROR_CODE ? { ...direct, code: undefined } : direct
}

/** 上游文案；缺失或全空白时给一句占位，避免出现「：」后面空一截的文案。 */
function upstreamText(message: string | undefined): string {
  const text = message?.trim()
  return text !== undefined && text.length > 0 ? text : '（上游未提供文案）'
}

/** 分类结果的内部构造入参：未列出的标志位一律为 false。 */
interface QoderClassificationSeed {
  action: QoderErrorAction
  message: string
  quotaCandidate?: boolean
  quotaConfirmed?: boolean
  jobTokenExpired?: boolean
  credentialInvalid?: boolean
  wrappedCode?: string
}

/**
 * 用统一形状拼出分类结果。
 *
 * 所有布尔标志位**恒有值**（缺省 false），这样调用方可以放心地直接读
 * `classification.quotaConfirmed` 而不必写 `?? false` —— 少一处可选链，
 * 就少一处「忘了判 undefined」的机会。
 */
function buildClassification(input: QoderErrorInput, seed: QoderClassificationSeed): QoderErrorClassification {
  return {
    action: seed.action,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.httpStatus === undefined ? {} : { status: input.httpStatus }),
    quotaCandidate: seed.quotaCandidate ?? false,
    quotaConfirmed: seed.quotaConfirmed ?? false,
    jobTokenExpired: seed.jobTokenExpired ?? false,
    credentialInvalid: seed.credentialInvalid ?? false,
    ...(seed.wrappedCode === undefined ? {} : { wrappedCode: seed.wrappedCode }),
    message: seed.message,
  }
}

/**
 * 按「业务码 + HTTP 状态码 + 来源端点」判定失败处置。
 *
 * ## 判定顺序（即优先级，不要重排）
 *
 * 1. **402 + 归一化 code === 116** → `quotaCandidate`，动作仍是 `'fail'`。
 *    ⚠️ 该 402 可能是模型名错误（见模块头注释第 4 条），**未确证前绝不换号**。
 * 2. **401 且 `source === 'quota'`**：额度端点**无法靠重换 jt 解决**，
 *    故按文案细分为 jt 过期（可重换）与凭据失效（重换也没用）；两者都不命中时
 *    **保守判凭据失效**（让用户重新粘贴，而不是反复重换一个救不回来的令牌）。
 * 3. **401 且 `source !== 'quota'`**（chat 端点，`{"error":"unauthorized"}` 无 code）：
 *    首见按 **jt 过期**（适配器静默重换一次再试）；`afterJobTokenRetry` 为真说明
 *    重换过了仍是 401 ⇒ **凭据失效**。
 * 4. **`code === 'provider_error'`** → 二次解析 `details`，`wrappedCode` 填真码。
 * 5. **流内业务码**（`httpStatus` 为 200 或省略、且有 code）：已知码
 *    （`invalid_parameter_error` / `invalid_model_error`）与**未知码**一律 `'fail'`
 *    —— 流内错误**绝不转成优雅结束**（那会让 DSH 报「Stream ended without
 *    finish_reason」，真因丢失）。
 * 6. **403** → `credentialInvalid`。
 * 7. **无业务码时的 HTTP 兜底**：`429` / `408` / `5xx` → `'backoff'`；
 *    其余（含 400、以及 code 不是 116 的 402）→ `'fail'`。
 * 8. **未知业务码一律 `'fail'`**，文案带上原始码与原文 —— 不猜动作。
 *
 * 为什么业务码优先于状态码：`stream:true` 会把同一个坏 body 从 400 变成
 * **200 + 流内错误**，反过来判会把所有流内失败都当成成功。
 *
 * 关于「空白字符串码」：值与全空白（`""` / `"   "`）都按**没有码**处理，
 * 走 HTTP 兜底 —— 否则文案里会出现「业务码 」这种空一截的句子。
 *
 * @param input - HTTP 状态码、业务码、文案、来源端点与重换标记。
 * @returns 该次失败应执行的动作与全部语义标志位。
 */
export function classifyQoderError(input: QoderErrorInput): QoderErrorClassification {
  const status = input.httpStatus
  const source: QoderErrorSource = input.source ?? 'chat'
  const code = input.code
  const hasCode = code !== undefined && !(typeof code === 'string' && code.trim().length === 0)
  const normalized = normalizeQoderCode(hasCode ? code : undefined)
  const upstream = upstreamText(input.message)

  // 1. 402 + 116：额度类**候选**（也可能是模型名错误，故不换号）。
  if (status === HTTP_PAYMENT_REQUIRED && normalized === QODER_QUOTA_CODE) {
    return buildClassification(input, {
      action: 'fail',
      quotaCandidate: true,
      message: `Qoder 返回 HTTP 402（业务码 116）：${upstream}。`
        + '该 402 只是「额度类候选」—— 网关先做扣费检查，无效模型名同样回 402/116，'
        + '故在额度端点确认之前不会切换账号。',
    })
  }

  // 2. 401 + 额度端点：重换 jt 救不了，只能判「jt 过期」或「凭据失效」。
  if (status === HTTP_UNAUTHORIZED && source === 'quota') {
    const haystack = `${input.message ?? ''}\n${input.body ?? ''}`.toUpperCase()
    if (QODER_TOKEN_EXPIRE_MARKERS.some((marker) => haystack.includes(marker))) {
      return buildClassification(input, {
        action: 'fail',
        jobTokenExpired: true,
        message: `Qoder 额度端点返回 HTTP 401（TOKEN_EXPIRE）：job token 已失效，`
          + `适配器会重新换取后重试。${upstream}`,
      })
    }
    if (QODER_TOKEN_INVALID_MARKERS.some((marker) => haystack.includes(marker))) {
      return buildClassification(input, {
        action: 'fail',
        credentialInvalid: true,
        message: `Qoder 额度端点返回 HTTP 401（TOKEN_INVALID）：凭据类型无效，`
          + `请重新粘贴 PAT。${upstream}`,
      })
    }
    return buildClassification(input, {
      action: 'fail',
      credentialInvalid: true,
      message: `Qoder 额度端点返回 HTTP 401 且无法区分原因：额度端点的 401 无法靠重换 `
        + `job token 解决，保守按凭据失效处理，请重新粘贴 PAT。${upstream}`,
    })
  }

  // 3. 401 + chat 端点：首见是 jt 过期（可自愈），重换过仍是 401 则是凭据失效。
  if (status === HTTP_UNAUTHORIZED) {
    if (input.afterJobTokenRetry === true) {
      return buildClassification(input, {
        action: 'fail',
        credentialInvalid: true,
        message: `Qoder chat 端点在重换 job token 后仍返回 HTTP 401（unauthorized）：`
          + `PAT 已失效或被撤销，请重新粘贴。${upstream}`,
      })
    }
    return buildClassification(input, {
      action: 'fail',
      jobTokenExpired: true,
      message: `Qoder chat 端点返回 HTTP 401（unauthorized）：job token 已过期，`
        + `适配器会先重换一次再试；仍失败则需重新粘贴 PAT。${upstream}`,
    })
  }

  // 4. provider_error 包装码：真因在 details 里（真码或上游文案，见 extractWrappedDetail）。
  if (typeof code === 'string' && code.trim() === QODER_PROVIDER_ERROR_CODE) {
    const { code: wrappedCode, reason } = extractWrappedDetail(input.body)
    // 三段可选信息按「有则带」拼装：真码 → 上游文案 → 兜底的「没解析出来」。
    // 曾经只认真码，于是三种实测形态里的两种（`details.error` 无 code、`details`
    // 只有 message）全部退化成「未能从 details 中二次解析出真码」—— 上游明明把
    // 原因写在 details 里，却对用户说没解析出来（用户报障的次要成因）。
    const parts: string[] = []
    if (wrappedCode !== undefined) parts.push(`真码为 ${wrappedCode}`)
    if (reason !== undefined) parts.push(`上游详情：${reason}`)
    const wrappedText = parts.length > 0 ? parts.join('；') : '未能从 details 中二次解析出真因'
    return buildClassification(input, {
      action: 'fail',
      ...(wrappedCode === undefined ? {} : { wrappedCode }),
      message: `Qoder 上游返回包装码 provider_error（${wrappedText}）：${upstream}`,
    })
  }

  // 5. 流内业务码（HTTP 200 或未知状态）：只报错，绝不转成优雅结束。
  if (hasCode && (status === undefined || status === HTTP_OK)) {
    const codeText = String(code)
    const hint = QODER_STREAM_CODE_HINTS[codeText.trim()]
    return buildClassification(input, {
      action: 'fail',
      message: `Qoder 流内错误（业务码 ${codeText}）：${hint === undefined ? '' : `${hint} `}`
        + `上游原文：${upstream}`,
    })
  }

  // 6. 403：凭据被拒绝。
  if (status === HTTP_FORBIDDEN) {
    return buildClassification(input, {
      action: 'fail',
      credentialInvalid: true,
      message: `Qoder 返回 HTTP 403：凭据被拒绝，请重新粘贴 PAT。${upstream}`,
    })
  }

  // 7. 无业务码时的 HTTP 兜底。
  if (!hasCode) {
    if (status === HTTP_TOO_MANY_REQUESTS || status === HTTP_REQUEST_TIMEOUT
      || (status !== undefined && status >= 500)) {
      return buildClassification(input, {
        action: 'backoff',
        message: `Qoder 返回 HTTP ${status}：网关限流或上游瞬时故障，`
          + `退避重试同一账号（不切换账号）。${upstream}`,
      })
    }
    const quotaHint = status === HTTP_PAYMENT_REQUIRED
      ? '（402 但无业务码，无法判定为额度耗尽）'
      : ''
    return buildClassification(input, {
      action: 'fail',
      message: `Qoder 返回 HTTP ${status ?? '未知'}${quotaHint}：${upstream}`,
    })
  }

  // 8. 未知业务码：直报并带上原始码，不猜动作。
  return buildClassification(input, {
    action: 'fail',
    message: `Qoder 返回未知业务码 ${String(code)}（HTTP ${status ?? '未知'}）：${upstream}。`
      + '未知码一律直报，不猜处置动作。',
  })
}

/**
 * 用 quota 二次判别结果确证/否定额度耗尽（步骤 4 接入，本步只留接口）。
 *
 * 这是「402 语义污染」的**唯一解药**：402 + 116 只说明网关拦下了这次请求，
 * 到底是真的额度耗尽（换号可救）还是模型名错误（换号也无用），只有额度端点
 * 知道。四种分支：
 *
 * - **非候选**（不是 402 + 116）→ **原样返回**（同一对象引用，不做任何包装）；
 * - **候选但 `verdict === undefined`**（额度查不到）→ 保守**不换号**：
 *   动作保持 `'fail'`、`quotaConfirmed` 保持 false。查不到 ≠ 耗尽；
 * - **`verdict.exhausted === true`** → `'switch-account'` + `quotaConfirmed: true`；
 * - **`verdict.exhausted === false`**（额度没超）→ 动作 `'fail'`、`quotaConfirmed`
 *   false —— 此时该 402 是模型路由错，换号只会再撞一次同一堵墙。
 *
 * 文案在候选分支上**追加**一句结论，上游原文原样保留（上游文案是诊断真因的
 * 唯一线索，任何处置都不该把它冲掉）。
 *
 * @param classification - {@link classifyQoderError} 的结果。
 * @param verdict - 额度端点的结论；undefined 表示查询不可用。
 * @returns 更新后的分类结果（非候选时是同一个对象）。
 */
export function applyQoderQuotaVerdict(
  classification: QoderErrorClassification,
  verdict: QoderQuotaVerdict | undefined,
): QoderErrorClassification {
  if (!classification.quotaCandidate) return classification

  if (verdict === undefined) {
    return {
      ...classification,
      action: 'fail',
      quotaConfirmed: false,
      message: `${classification.message}（额度端点查询不可用，未确证额度耗尽：保守起见不切换账号。）`,
    }
  }

  if (verdict.exhausted) {
    return {
      ...classification,
      action: 'switch-account',
      quotaConfirmed: true,
      message: `${classification.message}（额度端点已确证该账号额度耗尽，切换到下一个账号重试。）`,
    }
  }

  return {
    ...classification,
    action: 'fail',
    quotaConfirmed: false,
    message: `${classification.message}（额度端点确认额度未耗尽：该 402 应视为模型路由错误，`
      + '换号无用，直接报错。）',
  }
}

/**
 * 去重器：返回 true 表示这是**首次**看到的该错误（重复帧返回 false）。
 *
 * T3 实测：同一个错误**可能发两遍**，两帧的 `chatcmpl-…` id 不同、`code` 与
 * `message` 完全相同。若不去重，适配器会把同一条错误文案发两次给用户，
 * 更糟的是在换号循环里被计成两次失败。
 *
 * 去重键 = `${code}\u0000${message}`（无 code 时只用 message）：
 * - **刻意不含 `frameId`** —— 两个 id 不同正是需要被判定为重复的那种情况；
 * - `\u0000` 作分隔符，避免 `code` 与 `message` 的拼接产生歧义
 *   （`"1" + "16x"` 与 `"11" + "6x"` 不是同一个键）；
 * - 数字与字符串码会被归一成同一字符串（`116` 与 `"116"` 视为同一个错误）。
 *
 * 状态装在闭包里的 `Set` 中：一次流式请求一个去重器实例，
 * 跨请求不共享（否则第二次请求的同款错误会被静默吞掉）。
 */
export function createQoderErrorDeduper(): (frame: QoderStreamErrorFrame) => boolean {
  const seen = new Set<string>()
  return (frame: QoderStreamErrorFrame): boolean => {
    const key = frame.code === undefined
      ? frame.message
      : `${String(frame.code)}\u0000${frame.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

/** 该动作是否应触发「换下一个账号」。 */
export function shouldSwitchQoderAccount(action: QoderErrorAction): boolean {
  return action === 'switch-account'
}

/**
 * 该动作是否为「退避重试」（**不换号**）。
 *
 * 适配器据此抛**可重试**错误码，把节奏交还给 DSH 的重试层。
 */
export function isQoderBackoff(action: QoderErrorAction): boolean {
  return action === 'backoff'
}

/**
 * 该失败是否应记为**模型的冷却标记**（Account Hub 徽章）。
 *
 * **仅 `quotaConfirmed === true` 时为真**。理由：徽章的实际效果是让下一次
 * 选号跳过这个账号 —— 它等价于一次**隐式换号**。若把 `backoff`（限流/瞬时
 * 故障）或未知码也记上，下一次请求就会毫无提示地绕开该账号；而
 * `quotaCandidate` 未确证时更是可能因为一个模型名错误白白废掉一个账号。
 *
 * 只有额度端点**确证**「这个模型在这个账号上真的没额度了」，徽章才不是虚假信息。
 */
export function recordsQoderCooldown(classification: QoderErrorClassification): boolean {
  return classification.quotaConfirmed === true
}

/**
 * 映射为 harness 的稳定错误码（`LlmError` 的 code）。
 *
 * 口径对齐 `trae-cn-sse.ts` 的 `traeCnErrorCodeForAction`：
 *
 * - `'switch-account'` / `'backoff'` → `'RATE_LIMIT'`：**两者都必须是可重试码**。
 *   `RATE_LIMIT` 在 DSH 的 `DEFAULT_RETRYABLE_CODES` 里，所以 `backoff` 才真的
 *   能退避重试；两者的区别由**适配器**处理（换号循环 vs 直接抛出），错误码只
 *   表达「这是可重试的限流类失败」。发明两个新码会让 DSH 的重试层认不出来。
 * - `credentialInvalid` → `'AUTH'`（需用户重新粘贴 PAT）。
 *   注意 `jobTokenExpired` **刻意不映射 AUTH**：那是适配器内部可自愈的状态
 *   （重换一次 jt），只有重换后仍失败（此时 `credentialInvalid` 已为真）才该
 *   作为认证错误上报，否则会在 DSH 层引发一次无意义的凭据刷新。
 * - 文案命中上下文超限 → `'CONTEXT_WINDOW_EXCEEDED'`（触发 DSH 的上下文自动
 *   压缩恢复）。判据用 harness 自己的权威函数 `isContextWindowExceededError`，
 *   **不自建关键词表** —— 自建的那份必然与 DSH 的判断漂移。
 * - 其余 → `'INVALID_REQUEST'`。
 */
export function qoderHarnessErrorCode(classification: QoderErrorClassification): string {
  if (classification.action === 'switch-account' || classification.action === 'backoff') {
    return 'RATE_LIMIT'
  }
  if (classification.credentialInvalid) return 'AUTH'
  if (isContextWindowExceededError(classification.message)) return CONTEXT_WINDOW_EXCEEDED_CODE
  return 'INVALID_REQUEST'
}
