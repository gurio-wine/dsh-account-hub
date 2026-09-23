/**
 * SSE 流读取与工具参数归一化的共享工具。
 *
 * codearts 与 buddy 两个适配器都消费 OpenAI 风格的 SSE chat 响应，并面临
 * 同一类后端行为：网关在连接空闲一段时间后静默掐断，或模型在生成大工具
 * 参数期间长时间不 flush 任何字节。若不主动检测空闲，`reader.read()` 会
 * 无限期挂起——适配器的 generator 永不返回，harness 当前步骤既不出结果
 * 也不报错"，web 端表现为后续指令无响应。主动超时并把失败归类为可重试的
 * TIMEOUT，harness 才能重试该步骤，把控制权交还给用户。
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** SSE 读取阶段：等待首 token 与已收到数据后的 chunk 间等待。 */
export type SsePhase = 'first-token' | 'chunk'

/**
 * 在空闲超时内读取一个流块。超过 {@link timeoutMs} 无数据则取消
 * reader 并抛可重试的 `LlmError('TIMEOUT')`——比被动等待网关掐断更早
 * 失败，且归类为可重试 code。尊重用户传入的 {@link signal}：若已 abort
 * 则直接抛 abort 原因，不误报超时。
 *
 * @param label - 提供者标签，仅用于错误消息前缀（如 'codearts' / 'buddy'）。
 * @param phase - 仅用于错误消息区分首 token 超时与 chunk 间超时。
 */
export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  phase: SsePhase = 'chunk',
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  const onUserAbort = (): void => { if (timer) clearTimeout(timer) }
  signal?.addEventListener('abort', onUserAbort, { once: true })
  const readPromise = reader.read()
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new LlmError(`${label}: sse ${phase} timeout after ${timeoutMs}ms`, 'TIMEOUT')) }, timeoutMs)
  })
  try {
    const result = await Promise.race([readPromise, timeoutPromise])
    return { done: result.done, value: result.value }
  } catch (error) {
    // 用户取消：透传
    if (signal?.aborted) throw signal.reason ?? error
    // 空闲超时：取消 reader 释放底层连接，再抛可重试 TIMEOUT
    if (error instanceof LlmError) {
      await reader.cancel().catch(() => {})
      throw error
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onUserAbort)
  }
}

/**
 * 把工具调用的 arguments 文本归一化为合法的 JSON 对象字面量。
 *
 * 后端在两种情况下会给出非对象的 arguments：
 * - 无参数工具只下发一个空分片（`"arguments":""`），拼接结果为空串；
 * - SSE 流被截断（连接中断 / 网关掐断），只收到半截 JSON。
 *
 * 两者都会让 harness 解析参数时报
 * `invalid arguments: "arguments" must be an object`，并把会话卡在错误态
 * ——web 后续"继续"指令无响应。归一化为 `{}` 后，缺少必填
 * 参数的工具会走正常的 schema 校验错误并回传给模型，由模型重新发起调用，
 * 而不是让整个会话崩溃。
 */
/**
 * 工具名是否可用（非空字符串）。
 *
 * ⚠️ **不能用 `String(name).length > 0` 代替**：`undefined` / `null` 经 `String()`
 * 会变成 `"undefined"` / `"null"` 这类**非空**字符串，于是"缺名字"被误判成
 * "有名字"，原样发给上游照样 400。判据必须落在原始值上。
 */
export function hasUsableToolName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().length > 0
}

/**
 * 剔除无法配对、或**名称不可用**的工具调用与工具结果。
 *
 * ## 两类必须剔除的坏数据
 *
 * ① **配对缺口**：OpenAI 兼容协议要求带 `tool_calls` 的 assistant 消息，
 * 其**每一个** tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；
 * 反之，`role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
 * 400 拒绝整个请求。工具执行失败时（参数非法、超时、工具不存在……）harness
 * 会把 assistant 的 tool_calls 持久化进会话历史，却写不回结果消息。
 *
 * ② **名称为空 / 缺失的 tool_call**（2026-09-23 定位，用户报障）：
 * 会话历史里出现 `{type:'tool-call', id:'call_…', name:'', arguments:'{}'}`
 * 时，腾讯系端点以 **HTTP 400 `code 11133 model_param_invalid`** 拒绝整个请求
 * （错误文案只说"请求参数不符合当前模型要求"，**不指出是哪个字段**，极难排查）。
 *
 * | wire 上 `function.name` | 结果 |
 * |---|---|
 * | `"read"` | 200 |
 * | `"unknown_tool"`（不存在的工具名） | 200 ← **只校验"非空"，不校验存在性** |
 * | `""` / `null` / 缺失 | **400 code 11133** |
 *
 * 与配对缺口的关键差异：**空名字即使配对完整也照样 400**，两者成因完全独立。
 *
 * 来源是 SSE 消费侧：模型偶发吐出一个**完全没有 name 字段**的 tool-call
 * 分片，消费端若在 block-end 处以 `name: block.name ?? ''` 落块，harness 执行
 * 得到 `unknown tool ""` 并把这条坏块**持久化进会话**。此后用户一旦切换到
 * 腾讯系端点，该坏块被**每次请求原样重放** → 会话彻底报废（表现为"一发消息
 * 就报参数错误，怎么重试都不行"）。
 *
 * 这条坏数据**跨 provider 传染**（qoder 产生、workbuddy 受害），且**五个适配器
 * 的序列化入口都调用本函数**（`buddy` / `codearts` / `lobsterai` / `qoder` /
 * `trae-cn`）—— 故防线放在这里一处，而不是某个适配器内部。
 *
 * ## 为什么由适配器兜底
 *
 * 坏块已在会话里，harness 不会自愈。适配器是最后一道防线：发出请求前剔除，
 * 宁可丢失一轮工具上下文，也好过整条会话死亡。
 *
 * @param messages - harness 会话消息（按时间顺序）。
 * @returns 应当保留的 tool_call id 与 tool 结果 id 集合。
 */
export function resolveToolPairing(
  messages: readonly { role: string; content: unknown }[],
): { keepCallIds: Set<string>; keepResultIds: Set<string> } {
  // 收集历史上出现过的所有工具结果 id（harness 把结果搭载在 user 消息里）。
  const allResultIds = new Set<string>()
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result') {
        allResultIds.add(String((block as { toolCallId?: unknown }).toolCallId))
      }
    }
  }
  // 一批 tool_calls 里，**名称可用**的那些才可能保留：名称为空的调用无论
  // 是否配对完整都会被上游 400（见上方说明）。同批其余调用不受影响 ——
  // 结果按 id 匹配，剔掉一个不会破坏另一个的配对。
  const keepCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const content = Array.isArray(message.content) ? message.content : []
    const calls = content.filter((block): block is { type: string; id: unknown; name: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
    if (calls.length === 0) continue
    const usable = calls.filter(block => hasUsableToolName(block.name))
    if (usable.length === 0) continue
    // 一批里可用的那些只有**全部**拿到结果才能保留：部分保留会留下无结果的
    // tool_call，后端照样拒绝。
    if (usable.every(block => allResultIds.has(String(block.id)))) {
      for (const block of usable) keepCallIds.add(String(block.id))
    }
  }
  // 结果消息只有在对应 tool_call 被保留时才保留。
  const keepResultIds = new Set<string>()
  for (const id of keepCallIds) {
    if (allResultIds.has(id)) keepResultIds.add(id)
  }
  return { keepCallIds, keepResultIds }
}

export function normalizeToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return '{}'
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 不完整的 JSON（流被截断）：回退为空对象。
    return '{}'
  }
  // OpenAI 规范要求 arguments 是对象；null / 数组 / 标量都不是合法参数包。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
  return trimmed
}

/**
 * 判断工具参数是否因分片丢失而残缺（区别于"该工具本就无参数"）。
 *
 * 两种"不合法"必须区分对待：
 * - **空串**：无参数工具（如 `list_dir`）只下发一个空分片，这是**合法**的，
 *   补 `{}` 即可，工具照常执行；
 * - **非空但无法解析**：说明参数分片在流式下发中丢了。后端并行下发多个工具
 *   调用时偶发——实测 session-23851745 turn1 step4，模型并行发起两个 `read`，
 *   两个调用都丢了 `{"file_path": "…` 前缀，仅剩路径中段与尾部。
 *
 * 后者绝不能补成 `{}` 了事：那等于伪造一个"看起来合法"的调用，harness 执行
 * 时报 `missing required property "file_path"`，模型收到莫名其妙的参数错误，
 * 而真正的病因（分片丢失）被掩盖。正确做法是判定为截断，报告 max-tokens，
 * 让 dsh 丢弃残缺调用并重试——实测重试一次即恢复正常。
 *
 * 注意：只把**无法解析**视为截断。能解析但类型不对（标量、数组）属于模型
 * 输出有误，交给 schema 校验回传即可，不应触发重试。
 */
export function isTruncatedArguments(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}
