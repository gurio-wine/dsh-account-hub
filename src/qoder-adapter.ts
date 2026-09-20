/**
 * Qoder LLM 适配器（**国际版与 CN 共用同一份实现**）。
 *
 * 骨架取自 `src/trae-cn-adapter.ts`（本插件已验证的换号循环与流消费模式），
 * 但**协议差异全部重写**。Qoder 与 Trae CN 在 chat 面几乎处处相反：
 *
 * | 项 | Trae CN | **Qoder** |
 * |---|---|---|
 * | SSE 形态 | 具名事件流（`event:output`） | **标准 OpenAI**（`data:{"choices":[…]}`） |
 * | 消息结构 | 出站改写（`config_name` / `function` / `function_call`） | **原样透传**（OpenAI 同构） |
 * | `tool_calls` | 具名帧容忍式解析 | **标准 `delta.tool_calls` 增量分片** |
 * | 鉴权 | `Cloud-IDE-JWT` + 两个等值 token 头 | `Bearer jt-…`（**PAT 直打必 401**） |
 * | 流收尾判据 | `event:done` 帧 | **`[DONE]` 是唯一成功收尾判据** |
 *
 * ## 三条决定成败的事实（T1/T2/T3 真机实测）
 *
 * 1. **`[DONE]` 是唯一成功收尾判据**。两类错误（pre-stream 的网关错与 HTTP 200 的
 *    流内 error 帧）**都不出 `[DONE]`** —— 因此「没等到 `[DONE]` 的流」**绝不
 *    允许静默当作优雅结束**，否则失败会退化成一次空回复，真因彻底丢失
 *    （这正是 `src/trae-cn-errors.ts` 模块头记录的那条最大教训）。
 * 2. **`stream:true` 会改变 400 类错误的位置**：同一坏 body，`stream:false` 回
 *    400 pre-stream、`stream:true` 回 **200 + 流内 error 帧**。故流式路径
 *    **必须实现流内错误解析**，不能只看 HTTP 状态码。
 * 3. **`tool_calls` 的存在性不能靠 `finish_reason` 判断**：forced `tool_choice`
 *    时上游给的 `finish_reason` 是 `"stop"` 而**不是** `"tool_calls"`（T2 实测）。
 *    判据只能是「delta 里有没有 tool_calls 内容」。
 *
 * ## 402 刻意不做「换号可救」的硬编码
 *
 * 402 `code:116` 在本 provider 上有**语义污染**：quota=0 的账号上，**无效模型名
 * 也回同一个 402**（网关先做扣费检查，`model:""` 也 402 佐证）。若把 402 直接
 * 当额度耗尽换号，「模型不存在」会被误判成「换号可救」而死循环换号。
 * 故本适配器的换号**只认同一个来源**：{@link QoderAdapterOptions.quotaVerdict}
 * 二次判别后由 `applyQoderQuotaVerdict` 确证的额度耗尽。**该回调省略时一律
 * 保守不换号**（步骤 4 才注入真实实现）。
 *
 * ## 模型目录（步骤 3 已接线，见 `src/qoder-models.ts`）
 *
 * `listModels` / `resolveModel` 从**动态目录**（`GET /api/v1/cloud/models`，
 * 只认 PAT）取数，拉取成功时只播报 `is_enabled === true` 的项；目录不可用时
 * 回退**本产品**的静态兜底表（国际版 3 项含 `lite` / CN 2 项不含）。
 * 12h TTL 缓存，**失败不写缓存**。
 *
 * ⚠️ **`resolveModel` 对表外模型不抛错**（与其余六个 provider 一致）：DSH 约定
 * 「`listModels` 结果仅供参考，模型目录不构成路由白名单」，抛错会让历史会话里
 * 的旧模型 id 与手动输入的 id **彻底无法发起请求**，且没有恢复入口。表外模型的
 * 提示走**失败路径**（{@link QODER_OFF_CATALOG_HINT}），与 trae-cn 的
 * `4001` 提示同一惯例。
 *
 * ## 本步仍不接线
 *
 * 计划步骤 3 只交付目录：不注册 `ctx.llm`（步骤 6）、不实现额度与 quota
 * 二次判别（步骤 4）。真实的 provider 注册函数 {@link registerQoderLlm}
 * 已导出但**尚未被 `src/index.ts` 调用**。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { QODER, QODER_CHAT_PATH, qoderClientType, qoderJobTokenHeaders } from './qoder-product.js'
import type { QoderCredential, QoderProduct } from './qoder-product.js'
import {
  QODER_OFF_CATALOG_HINT,
  QoderCatalogStore,
  effectiveQoderCatalog,
  fallbackQoderCatalog,
  fetchQoderDirectory,
} from './qoder-models.js'
import type { QoderModelEntry } from './qoder-models.js'
import {
  applyQoderQuotaVerdict,
  classifyQoderError,
  parseQoderStreamErrorPayload,
  qoderHarnessErrorCode,
  recordsQoderCooldown,
  shouldSwitchQoderAccount,
} from './qoder-errors.js'
import type { QoderErrorClassification, QoderQuotaVerdict } from './qoder-errors.js'
import {
  isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, resolveToolPairing,
} from './sse.js'

/**
 * 本适配器**默认产品**（`QODER`）的 provider 路由名。
 *
 * ⚠️ **适配器实例实际使用的路由名是 `this.product.id`，不是本常量。**
 * `QoderAdapter` 的一切按构造时传入的 `product` 现算：`providerInfo` 的兜底、
 * `listModels` 播报的 `provider`、以及四处账号池查询（`findAccountIdByCredential`
 * / `disabledModelsFor` / `getAvailableAccount` / `updateModelRateLimit`）全部走
 * `this.product.id`；路由注册（{@link registerQoderLlm}）同样用 `product.id`。
 * 故同一份适配器代码服务第二个 region（如 `qoder-cn`）时，本常量只描述
 * **默认那一份**取值，不代表所有产品。
 *
 * 取值**派生自 `QODER.id` 而不是第二份 `'qoder'` 字面量**：产品配置
 * （`src/qoder-product.ts` 的 `QoderProduct.id`）是 provider id 的唯一真相源，
 * 这里再抄一遍就会在新增 region 时悄悄分叉。
 *
 * 与 `buddy-adapter.ts` 的 `PROVIDER` 同一形态 —— 那份同样在多产品下退化为
 * 「历史常量」，只表示其中一个产品的取值（保留导出以兼容既有导入方）。
 */
export const PROVIDER = QODER.id

/**
 * 单次请求最多换几个账号（含首次）。
 *
 * 与 trae-cn / lobsterai 侧取同一个值（3）：账号池很大时若逐个试完，一次用户
 * 请求会打出 N 个上游请求，既放大延迟也放大额度消耗。
 */
const QODER_MAX_ROTATE = 3

/** 确证额度耗尽后的冷却时长（毫秒，1 小时）。 */
const QODER_COOLDOWN_MS = 3_600_000

/**
 * 官方逃生阀环境变量：覆盖 **chat** 主机的 host 部分。
 *
 * 语义照官方 CN CLI（本插件不发明新开关）：官方支持用该环境变量把 chat 请求
 * 指向别的主机（自建网关 / 代理 / 灰度环境）。
 *
 * ⚠️ **只影响 chat**：`openapiBase`（exchange / quota）与 `modelsBase`（目录）
 * **不受影响** —— 官方语义就是替换模型服务主机，把另外两条控制面也一并改掉
 * 会让「只换 chat 出口」的用法直接失效（且失败形态是「凭据失效」，难诊断）。
 *
 * ⚠️ **两个 region 都生效**（不按 product 分）：它是环境级逃生阀，不是产品配置。
 */
const QODER_MODEL_SERVER_HOST_ENV = 'QODER_MODEL_SERVER_HOST'

/**
 * 应用 {@link QODER_MODEL_SERVER_HOST_ENV} 覆盖（仅 host 部分）。
 *
 * **请求时读取**（不是构造时缓存）：逃生阀的语义就是「运行时可切」——
 * 进程启动后再设环境变量也应生效，故不能像模块常量那样在 import 时定型。
 *
 * 取值按官方语义只认「主机」：`host` 或 `host:port`。额外容忍两种书写——
 * - 带 scheme（`http://host`）：**显式 scheme 优先**。这是有意的超集：裸主机名
 *   在官方语义里没有 scheme 可继承，只能沿用原基址的 `https`；而写全
 *   `http://localhost:8080` 的人几乎一定是在指向本地代理，把它悄悄升级成
 *   https 会得到一个 TLS 失败，排查方向完全跑偏。
 * - 带路径 / 查询串：**一律丢弃**。路径恒为 {@link QODER_CHAT_PATH}，
 *   否则「覆盖主机」会顺带改掉端点路径，与变量名和官方语义都不符。
 *
 * 空串 / 全空白视为**未设置**（与其它 provider 读环境变量的口径一致：
 * 空值不是有效覆盖）。
 *
 * @param chatBase - `product.chatBase`（如 `https://api2-v2.qoder.sh`）。
 */
export function resolveQoderChatBase(chatBase: string): string {
  const raw = process.env[QODER_MODEL_SERVER_HOST_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return chatBase
  const declaredScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw.trim())?.[1]
  const withoutScheme = raw.trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? ''
  if (authority.length === 0) return chatBase
  // scheme：显式给出的优先，否则沿用原基址（逃生阀只换主机，不该顺带把 https
  // 降级成 http）。
  const scheme = declaredScheme ?? /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(chatBase)?.[1] ?? 'https'
  return `${scheme}://${authority}`
}

/** 安全读取 `Error.message`。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 本适配器对外声明的输入模态：**恒为纯文本**。
 *
 * 抽成常量而不是在 `listModels` / `resolveModel` 各写一份 `['text']`：DSH 的
 * `LlmModelInfo.inputModalities` 注释明确「缺席 = 未知、显式给出 = 能力声明」，
 * 两处若分叉（一处报 `['text','image']`）会让图片被路由进这条**必然丢图**的通道
 * （`serializeQoderMessages` 只搬运文本块）。
 *
 * ⚠️ 这是**刻意的**：目录的 `is_vl` 在本 provider 上恒为 `true`（T1 17 项全部），
 * 若照它声明，每个模型都会显示「支持图片」——那是错的（模型支持 ≠ 本适配器能送达）。
 * 与 trae-cn 的写法（目录照实报能力、`stream()` 另设图片防线）不同，理由见
 * `listModels` 的注释：那里的多模态有静态表逐项实测支撑，这里只有一个布尔。
 */
const QODER_TEXT_ONLY: readonly ['text'] = ['text']

/**
 * 思考档位 id → 展示名。
 *
 * 档位 id 取自目录的 `efforts`（T1 实测值域 `low` / `medium` / `high` / `xhigh`
 * / `max`），逐字符照抄；展示名取**英文原词**（与 `buddy-adapter.ts` 的
 * `EFFORT_NAMES` 同一套命名，那是本仓库对同一批档位已有的叫法）。
 *
 * 未登记的 id 直接回退成 id 本身（与 `buddy-adapter` / `trae-cn` 同款）——
 * 目录将来加档位时不会显示成空白。
 */
const QODER_EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/** 档位 id 的展示名；未登记的 id 回退为 id 本身。 */
function effortDisplayName(id: string): string {
  return QODER_EFFORT_NAMES[id] ?? id
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
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次调用时读取** —— 模块顶层常量
 * 会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，adapter 的
 * generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstFrameTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_FRAME_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** 从错误响应体里提取的判据字段。 */
export interface QoderErrorFacts {
  /** 业务码（402 是**数字**，其余是字符串；见 `qoder-errors.ts`）。 */
  code?: number | string
  /** 人类可读文案（402/401 在 `error` 字段，其余在 `message` 字段）。 */
  message?: string
}

/**
 * 从 HTTP 错误体里提取判据字段。
 *
 * ⚠️ **三处 schema 不一致**（T3 实测），故读取必须容忍：
 * - 402 `{"code":116,"error":"quota exceeded"}` —— 文案在 **`error`**；
 * - 401 `{"error":"unauthorized"}` —— **没有 `code` 字段**；
 * - 400 `{"code":"provider_error","message":"…","details":"…"}` —— 真码在 `details`。
 *
 * 解析失败（非 JSON、空体）时回退成「原文即文案」，不丢诊断信息。
 */
export function extractQoderErrorFacts(body: string): QoderErrorFacts {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return body.length > 0 ? { message: body } : {}
    }
    const record = parsed as Record<string, unknown>
    const rawCode = record.code
    const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
      ? rawCode
      : (typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined)
    const text = typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : (typeof record.error === 'string' && record.error.length > 0 ? record.error : undefined)
    return {
      ...code === undefined ? {} : { code },
      ...text === undefined ? {} : { message: text },
    }
  } catch {
    return body.length > 0 ? { message: body } : {}
  }
}

/**
 * 从 `usage` / `raw_usage` 载荷解析用量。
 *
 * 口径与 `trae-cn-sse.ts` 的 `parseTraeCnUsage` **一致**：`inputTokens` 只计
 * **未命中缓存**的部分（`TokenUsage` 的注释明确要求 DISJOINT），命中部分单列
 * `cacheReadTokens`，否则缓存命中率显示会偏大。
 *
 * Qoder 特有字段：`cache_read_tokens` / `cache_write_tokens` / `credits`
 * （float，本次消耗的 Credit 数）。`credits` 不是 token，**不进 `TokenUsage`**
 * —— 它是余额展示的口径，属步骤 4。
 */
export function parseQoderUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }
  const input = pick('prompt_tokens', 'input_tokens')
  const output = pick('completion_tokens', 'output_tokens')
  if (input === undefined && output === undefined) return undefined
  // 缓存命中：Qoder 的平铺字段优先，OpenAI 标准的嵌套 details 兜底。
  const details = typeof record.prompt_tokens_details === 'object' && record.prompt_tokens_details !== null
    ? record.prompt_tokens_details as Record<string, unknown>
    : undefined
  const detailsCached = details === undefined ? undefined : (() => {
    const value = details.cached_tokens
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  })()
  const cached = pick('cache_read_tokens', 'prompt_cache_hit_tokens', 'cached_tokens') ?? detailsCached
  const written = pick('cache_write_tokens')
  const total = pick('total_tokens')
  const reasoning = pick('reasoning_tokens')
  return {
    inputTokens: input === undefined ? 0 : (cached !== undefined && cached > 0 ? input - cached : input),
    outputTokens: output ?? 0,
    ...total === undefined ? {} : { totalTokens: total },
    ...cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {},
    ...written !== undefined && written > 0 ? { cacheWriteTokens: written } : {},
    ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * 把 harness 消息序列化为 **标准 OpenAI** 的 `messages` 数组。
 *
 * 与 `serializeTraeCnMessages` 的差别只有一处：**没有 SOLO 通道的出站改写**
 * （不改 `role`、不包 `[{type:'text',text}]`、不把 `function` 改名
 * `function_call`）—— Qoder 的 chat 端点接受的就是标准 OpenAI 形态，
 * 任何「顺手统一」的改写都会让它认不出消息结构。
 *
 * 两条与厂商无关的通用协议要求仍必须保留（见 `src/sse.ts`）：
 * - **剔除无法配对的 tool_call / tool-result**：后端会以 400 拒绝整个请求，
 *   而这条坏历史会被每次请求原样重放 —— 表现为「会话突然报废，此后所有消息
 *   都无回复」。发出前剔除可让会话自愈；
 * - assistant 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）。
 */
export function serializeQoderMessages(
  messages: readonly { role: string; content: unknown }[],
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []
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
 * 把 harness 的 `ToolSchema[]` 翻译成 **OpenAI 标准 tools 数组**。
 *
 * ## 为什么必须包裹（真机报障根因，2026-09-21）
 *
 * harness 的 `ToolSchema` 是 `{name, description, parameters}` —— **不是** OpenAI
 * 的 `{type:'function', function:{…}}`。曾经这里把它们**原样透传**，注释还写着
 * 「Qoder 网关接受 OpenAI 原生 tools 数组（T2 实测）」——T2 测的是**它自己手写的
 * OpenAI 形态**，不是 `GenerateOptions.tools` 的形态，于是这条注释把「透传」
 * 这个错误结论合法化了。
 *
 * 真机证据（国际版 PAT，全程走本文件的 {@link buildQoderChatBody} 构造请求；
 * 唯一变量 = tools 形态，模型 `qmodel` / Qwen3.7-Plus）：
 *
 * | tools 形态 | 结果 |
 * |---|---|
 * | Raw 透传（曾经） | HTTP 200 + **流内 `provider_error`**，用户可见文本即报障原文：<br>`Qoder 上游返回包装码 provider_error（未能从 details 中二次解析出真码）：Error in upstream response`（harness 码 `INVALID_REQUEST`） |
 * | OpenAI 标准包裹（现在） | `[DONE]=true`，正常收尾 |
 * | 不下发 tools | `[DONE]=true`，正常收尾 |
 *
 * `details` 里上游把话说明白了（各上游后端文案不同，都指向同一个错）：
 * `'function' is a required property, expected an object - 'tools.0'`（`qmodel`）、
 * `Invalid request: unknown tool type: , currently only function and plugin are supported`
 * （`kmodel`）、`tools[0].type: unknown variant ..., expected function`（`dmodel`）、
 * `invalid params, invalid tool type: (2013)`（`mmodel`）。
 *
 * ⚠️ **`lite` 是唯一两种形态都不报错的模型**（它走上游的宽松兼容路径），所以这个
 * 缺陷只在**非 lite 模型**上暴露 —— 这也是它没在 T2 那轮被发现的原因。
 *
 * 包裹后**功能未受损**：`qmodel` / `gmodel` / `dmodel` / `lite` 四个模型实测仍回
 * 标准结构化 `tool_calls`（`read_file` + `{"path": "a.txt"}`），T2 的结论成立。
 *
 * 与其余六个 provider 的做法一致（`buddy-adapter.ts` / `llm-adapter.ts` /
 * `lobsterai-adapter.ts` 都是这么包的）——本 provider 此前是唯一的例外。
 *
 * `type` 恒为 `'function'`：harness 只表达函数型工具，而 Qoder 上游的
 * `unknown tool type` 报错正说明该字段**必填且值必须是 `function`**。
 */
function serializeQoderTools(
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/**
 * 构造 chat 请求体（**导出的纯函数，便于逐字段单测**）。
 *
 * ## 实测定案的形态（T1/T2）
 *
 * ```json
 * { "model", "messages", "stream": true,
 *   "stream_options": { "include_usage": true },
 *   "metadata": { "context": { "client_type": "qodercli" } } }
 * ```
 *
 * - `messages` **原样透传**（标准 OpenAI 格式，**逐项不改写**）；
 * - `tools` **必须包裹成 OpenAI 标准形态** —— 这一条是 2026-09-21 真机报障的
 *   根因修复，证据与形态见 {@link serializeQoderTools}；
 * - `metadata.context.client_type` 是**出站身份标识**（与 buddy 的
 *   `X-Product-Code` 同类，Qoder 后台按它归因用量），**一字符都不能动**。
 *   取值由 `product.clientType` 给出、缺省回退 `'qodercli'`（见
 *   {@link qoderClientType}）：国际版不声明该字段 ⇒ 仍是 `'qodercli'`，
 *   请求体**逐字节不变**；CN 声明 `'5'`（官方 CN CLI 的默认值）。
 * - `stream` **恒为 true**：本适配器只走流式路径（`stream_options` 同发）。
 *
 * ## `reasoning_effort` 透传不拦截
 *
 * T1/T2 **未验证**该字段是否生效（目录的 `efforts` 才是权威档位来源，属步骤 3）。
 * 首版策略与 trae-cn 的「未验证不盲改」同则：调用方给了就下发，**不主动补档**
 * （DSH 已按 `reasoning.defaultEffort` 在省略时补好，适配器再补一次会与 DSH
 * 的口径分叉）。
 *
 * @param options - harness 的生成选项。
 * @param product - 产品配置；**缺省用国际版**，使既有调用点（与既有测试）
 *                  一行不改即得到与接入 CN 前逐字节相同的请求体。
 */
export function buildQoderChatBody(options: GenerateOptions, product: QoderProduct = QODER): string {
  const messages = serializeQoderMessages(options.messages)
  if (options.system !== undefined && options.system.length > 0) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    metadata: { context: { client_type: qoderClientType(product) } },
  }
  // `tools` **包裹后再发**（原样透传是真机报障根因，见 serializeQoderTools）。
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = serializeQoderTools(options.tools)
  }
  // `tool_choice`：⚠️ `GenerateOptions` **没有**这个字段（DSH 不表达强制工具选择），
  // 故这里没有东西可转发。保留这次防御性读取，是为了让「将来 DSH 加上该字段」
  // 与「有人从旁路塞进来」两种情况都不至于静默丢掉强制选择语义。
  const toolChoice = (options as { toolChoice?: unknown }).toolChoice
  if (toolChoice !== undefined) body.tool_choice = toolChoice
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
  return JSON.stringify(body)
}

/** {@link consumeQoderStream} 的入参。 */
export interface QoderStreamOptions {
  /** 错误消息前缀（如 `qoder`）。 */
  label: string
  /** 上游响应的 HTTP 状态码（流内错误几乎恒为 200，仅作分类兜底）。 */
  httpStatus: number
  /** 两阶段空闲超时：等待首帧与帧间静默。 */
  timeouts: { firstFrameMs: number; chunkMs: number }
  /** harness 的取消信号。 */
  signal?: AbortSignal
  /**
   * 本次请求是否发生在「已重换过一次 jt 之后」。
   *
   * 透传给分类器：chat 端点的 401 是裸 `{"error":"unauthorized"}`、**不带可
   * 分型的业务码**，无法与「PAT 类型错」区分，只能靠这个时序标志分型
   * （见 `qoder-errors.ts` 的 401 分支）。
   */
  afterJobTokenRetry?: boolean
  /**
   * 产品配置（**region 上下文**），透传给错误分类器。
   *
   * 分类器按它分流「同一状态码在两个 region 语义不同」的那一条 —— 当前仅
   * CN 的 chat 503（路径不存在 ⇒ 直报，见 `qoder-errors.ts` 的 7a 条）。
   * 省略时分类器按国际版处理，故既有调用点行为不变。
   */
  product?: QoderProduct
}

/** 一次 chat 请求的消费结果（供适配器做换号与收尾判定）。 */
export interface QoderStreamOutcome {
  /** 是否收到 `[DONE]`（**唯一**成功收尾判据）。 */
  done: boolean
  /** 是否产出过任何正文、思考或工具块。 */
  produced: boolean
  /** 是否存在工具调用块。 */
  hasToolCalls: boolean
  /** 是否有工具调用的参数无法解析（分片丢失 / 流被截断）。 */
  argumentsTruncated: boolean
  /** 响应 `model` 回显值（真实模型在 `raw_usage.model`）。 */
  model?: string
  /** 流内错误（有则带；此时 `done` 为 false）。 */
  error?: QoderErrorClassification
}

/**
 * 消费一次 Qoder 的 SSE 流，逐帧翻译成 harness 的 chunk。
 *
 * **不产出 `finish` chunk，也不抛业务错误** —— 两者都交给调用方：
 * `finish` 的 reason 取决于「是否已产出内容 / 是否换号」，而业务错误需要调用方
 * 结合「是否已有产出」决定换号还是直报。本函数只做「帧 → 块」的翻译。
 *
 * ## 设计要点（每一条都对应一个已知的真实缺陷）
 *
 * 1. **行式解析**：只处理完整的 `\n` 结尾行，残行留在 buffer 等下一块 ——
 *    跨 chunk 切断的 `data:` 行是 SSE 解析最常见的错源；
 * 2. **规范 SSE 累积器**：`event:` 记名字、`data:` 累积、**空行分派**。
 *    ⚠️ T3 勘误 v2 已逐字节复核确认：**两种流内 error 帧都有 `data:` 前缀**，
 *    规范累积器能干净处理，**不需要**「无 `data:` 前缀的裸 JSON 行也当帧」的
 *    兜底（那条是 T3 报告初版的误记，勘误里已明确删除）。本实现**刻意不实现它**
 *    —— 按「任意裸行都当帧」解析会让真正的非法行被当成合法载荷。
 * 3. ⚠️ **usage 帧裸 LF 注入兜底（真实缺陷，7 次成功流中 5 次中招）**：
 *    大 usage 帧（约 491–1013 字符）的 JSON 中段会被凭空注入一个裸 `\n`（0x0A），
 *    于是 `data:` 行的 payload 被**物理切成两行**。恢复规则（3/3 实例验证）：
 *    把 payload 与**紧随的下一行（非空、且不以 `data:` 等字段前缀开头）**
 *    拼接时，**必须「无分隔符直接拼」**（`JSON.parse(L1 + L2)` OK；
 *    `JSON.parse(L1 + "\n" + L2)` **FAIL** —— 那个 LF 不属于原文）。
 *    见 {@link isSseFieldLine} 与分发处的拼接尝试。
 * 4. **`event: error` 优先判错**：读到该事件名（或载荷命中 `error` 结构）立即
 *    按流内错误处理并**直报业务码**，**绝不转成优雅关闭**；
 * 5. **`[DONE]` 立即停止读取**：之后上游不再发内容，继续读只会白等到空闲超时；
 * 6. **坏帧跳过**：一个坏帧不该让整条会话报废（与 lobsterai 侧同策略）。
 */
export async function* consumeQoderStream(
  response: Response,
  options: QoderStreamOptions,
): AsyncGenerator<StreamChunk, QoderStreamOutcome, void> {
  const { label, timeouts, signal } = options
  if (!response.body) throw new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE')

  // 非流式路径：`Content-Type: application/json` 的整包响应（无 SSE 封装）。
  // 本适配器恒发 `stream:true`，但错误体与「上游忽略 stream 参数」两种情况都会
  // 走到这里，故必须有解析路径 —— 只看状态码会把一个正常的非流式回复判成空回复。
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return yield* consumeQoderJson(response, options)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstFrameReceived = false

  let eventName = ''
  /** 当前帧累积的 `data:` 载荷（一行一段，按 SSE 规范以 `\n` 连接）。 */
  let dataLines: string[] = []

  let textIndex: number | undefined
  let thoughtIndex: number | undefined
  let nextIndex = 0
  let text = ''
  let thought = ''
  let produced = false
  let done = false
  let model: string | undefined
  let error: QoderErrorClassification | undefined
  const toolCalls = new Map<number, { index: number; text: string; callId: string; name?: string }>()

  try {
    while (!done && error === undefined) {
      const timeoutMs = firstFrameReceived ? timeouts.chunkMs : timeouts.firstFrameMs
      const phase = firstFrameReceived ? 'chunk' : 'first-token'
      const result = await readWithIdleTimeout(reader, timeoutMs, label, signal, phase)
      if (result.done) break
      firstFrameReceived = true
      buffer += decoder.decode(result.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        // ⚠️ **只剥行尾的 `\r`，不做 `trim()`**：注入 LF 的恢复依赖
        // 「行内容逐字节保留」（拼接必须无分隔符、无额外空白）。
        const raw = buffer.slice(0, newline)
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        buffer = buffer.slice(newline + 1)

        if (line.length === 0) {
          // 空行 = 一帧结束，按 SSE 规范分派并清除事件名。
          if (dataLines.length === 0) {
            eventName = ''
            continue
          }
          const payloads = dataLines
          const name = eventName
          dataLines = []
          eventName = ''

          // ⚠️ **`[DONE]` 必须在这里判，不能等 JSON 解析之后**：
          // `[DONE]` 是**裸哨兵文本**，`JSON.parse('[DONE]')` 会抛异常。
          // 若先解析再判，唯一的成功收尾信号会被「坏帧跳过」吃掉，
          // 于是每一次**成功**的流都会以「Stream ended without [DONE]」告终。
          if (payloads.length === 1 && payloads[0].trim() === '[DONE]') {
            done = true
            break
          }

          // 载荷连接：先按 SSE 规范用 `\n`，失败再试**无分隔符直接拼**
          // （覆盖「上游把注入 LF 的两段都写成 data: 行」的变体；单行被注入
          //  LF 切开的场景已在行循环里拼回同一段，见 isSseFieldLine 的说明）。
          let parsed: unknown
          let parsedOk = false
          try {
            parsed = JSON.parse(payloads.join('\n'))
            parsedOk = true
          } catch {
            try {
              parsed = JSON.parse(payloads.join(''))
              parsedOk = true
            } catch {
              parsedOk = false
            }
          }
          if (!parsedOk) {
            // 坏帧跳过：一个坏帧不该让整条会话报废。
            continue
          }

          const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined
          const echoed = record?.model
          if (typeof echoed === 'string' && echoed.length > 0) model = echoed

          // `event: error` **优先判错**（T3 勘误要点 4：按 `event:` 字段判错
          // 比只扫 `data:` 更直接）。载荷里带 error 结构同样判错。
          const isErrorEvent = name === 'error' || record?.error !== undefined
          if (isErrorEvent) {
            const frame = parseQoderStreamErrorPayload(parsed)
            error = classifyQoderError({
              httpStatus: options.httpStatus,
              ...frame.code === undefined ? {} : { code: frame.code },
              message: frame.message,
              source: 'chat',
              // region 上下文：CN 的 chat 503 是「路径不存在」而非瞬时故障，
              // 分类器据此直报（见 qoder-errors.ts 的 7a 条）。
              ...options.product === undefined ? {} : { product: options.product },
              // ⚠️ **流内分支同样要传 `details`**：`provider_error` 帧的外层 message
              // 恒是无信息量的 `"Error in upstream response"` / `"All models failed"`，
              // 真因只在 `details` 里。此前这里没传 body，于是流内 provider_error
              // 永远显示「未能从 details 中二次解析出真码」—— 用户报障的次要成因
              // （真机实测：`kmodel` 的 details 明说 `unknown tool type`）。
              ...frame.details === undefined ? {} : { body: frame.details },
              ...options.afterJobTokenRetry === undefined
                ? {}
                : { afterJobTokenRetry: options.afterJobTokenRetry },
            })
            break
          }
          if (record === undefined) continue

          // 用量收尾帧：`choices:[]` + `usage` / `raw_usage`。
          // **优先 `raw_usage`** —— 它带 `sub_usages` / `ttft` / `from_model`
          // 等展开字段（也正因它够大，才最容易中注入 LF 那个缺陷）。
          if (Array.isArray(record.choices) && record.choices.length === 0) {
            const payload = record.raw_usage !== undefined ? record.raw_usage : record.usage
            const usage = payload === undefined ? undefined : parseQoderUsage(payload)
            if (usage !== undefined) yield { type: 'usage', usage }
            continue
          }

          const choices = record.choices
          if (!Array.isArray(choices) || choices.length === 0) continue
          const first = choices[0]
          if (typeof first !== 'object' || first === null) continue
          const delta = (first as Record<string, unknown>).delta
          const payload = typeof delta === 'object' && delta !== null
            ? delta as Record<string, unknown>
            : undefined
          if (payload === undefined) continue

          // 思考增量（Qoder 也回 `reasoning_content`）。
          const thoughtPiece = typeof payload.reasoning_content === 'string' && payload.reasoning_content.length > 0
            ? payload.reasoning_content
            : (typeof payload.reasoning === 'string' && payload.reasoning.length > 0 ? payload.reasoning : '')
          if (thoughtPiece.length > 0) {
            if (thoughtIndex === undefined) {
              thoughtIndex = nextIndex++
              yield { type: 'block-start', index: thoughtIndex, blockType: 'reasoning' }
            }
            produced = true
            thought += thoughtPiece
            yield { type: 'reasoning-delta', index: thoughtIndex, text: thoughtPiece }
          }

          // 正文增量。
          const piece = typeof payload.content === 'string' ? payload.content : ''
          if (piece.length > 0) {
            if (textIndex === undefined) {
              textIndex = nextIndex++
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            produced = true
            text += piece
            yield { type: 'text-delta', index: textIndex, text: piece }
          }

          // 工具调用增量：**只看 delta 里有没有内容**，不看 `finish_reason`
          // （forced `tool_choice` 时它是 `"stop"`，见模块头第 3 条）。
          const deltas = payload.tool_calls
          if (Array.isArray(deltas)) {
            for (const item of deltas) {
              if (typeof item !== 'object' || item === null) continue
              const fragment = item as Record<string, unknown>
              const rawIndex = fragment.index
              const wireIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex) && rawIndex >= 0
                ? rawIndex
                : 0
              const fn = typeof fragment.function === 'object' && fragment.function !== null
                ? fragment.function as Record<string, unknown>
                : undefined
              const id = typeof fragment.id === 'string' && fragment.id.length > 0 ? fragment.id : undefined
              const name = fn !== undefined && typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : undefined
              const args = fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : ''

              let block = toolCalls.get(wireIndex)
              if (block === undefined) {
                const callId = id ?? `call_${wireIndex}`
                block = { index: nextIndex++, text: '', callId, ...name === undefined ? {} : { name } }
                toolCalls.set(wireIndex, block)
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              } else if (id !== undefined) {
                block.callId = id
              }
              // 只允许非空名字覆盖：后续分片若带空串会清空首个分片解析出的
              // 工具名，表现为 `unknown tool ""`。
              if (name !== undefined) block.name = name
              block.text += args
              produced = true
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: ToolCallId(block.callId),
                ...block.name === undefined ? {} : { name: block.name },
                argumentsDelta: args,
              }
            }
          }
          continue
        }

        if (line.startsWith(':')) continue // 注释行（心跳）
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          // `data: {...}` 与 `data:{...}` 两种写法都兼容（只剥一个前导空格）。
          dataLines.push(line.slice(5).replace(/^ /, ''))
          continue
        }
        if (isSseFieldLine(line)) continue
        // ⚠️ **裸 LF 注入兜底**：既不是空行、也不是任何 SSE 字段行，却出现在
        // `data:` 行之后 —— 这就是被凭空注入的 LF 切出来的后半段 JSON。
        // 按「无分隔符直接拼」接回上一段（用 `\n` 拼会失败，那个 LF 不属于原文）。
        if (dataLines.length > 0) dataLines[dataLines.length - 1] += line;
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 收尾：按创建顺序闭合已开启的块（harness 要求 block-end 携带拼装结果）。
  for (const block of toolCalls.values()) {
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name ?? '',
        // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
        // 由调用方的 max-tokens 判定触发重试（见 `src/sse.ts`）。
        arguments: normalizeToolArguments(block.text),
      },
    }
  }
  if (textIndex !== undefined) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  }
  if (thoughtIndex !== undefined && thought.length > 0) {
    yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: thought } }
  }
  return {
    done,
    produced,
    hasToolCalls: toolCalls.size > 0,
    argumentsTruncated: [...toolCalls.values()].some(block => isTruncatedArguments(block.text)),
    ...model === undefined ? {} : { model },
    ...error === undefined ? {} : { error },
  }
}

/**
 * 该行是否是**已识别的 SSE 字段行**（`field: value` 形态）。
 *
 * 用途只有一个：区分「合法字段行」与「被注入 LF 切出来的 JSON 残段」。
 *
 * 判据刻意**只认前缀、不认「含不含冒号」**：注入残段的实测原文里**有冒号**
 * （`erred_count":0,"from_model"…`），按冒号判会把它当成字段行静默丢掉，
 * 于是 usage 帧永远解析不出来 —— 那正是本兜底要修的那个缺陷。
 */
function isSseFieldLine(line: string): boolean {
  return line.startsWith('event:')
    || line.startsWith('id:')
    || line.startsWith('retry:')
    || line.startsWith('comment:')
}

/**
 * 非流式（`Content-Type: application/json`）响应路径。
 *
 * 形态与 OpenAI 的 `chat.completion` 一致：`choices[0].message` 携带
 * `content` / `reasoning_content` / `tool_calls`，顶层带 `usage` / `model`。
 *
 * `done` 恒为 `true`：整包 JSON 本身就是一次**完整**的响应，`[DONE]` 哨兵
 * 只存在于 SSE 路径。这不是「静默当优雅结束」—— 该分支只在 HTTP 200 且
 * Content-Type 明确为 JSON 时进入，解析失败会直接抛错。
 */
async function* consumeQoderJson(
  response: Response,
  options: QoderStreamOptions,
): AsyncGenerator<StreamChunk, QoderStreamOutcome, void> {
  const { label } = options
  let rawText: string
  try {
    rawText = await response.text()
  } catch (error) {
    throw new LlmError(`${label}: 响应体读取失败：${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new LlmError(`${label}: 非流式响应不是合法 JSON`, 'EMPTY_RESPONSE')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LlmError(`${label}: 非流式响应结构异常`, 'EMPTY_RESPONSE')
  }
  const record = parsed as Record<string, unknown>

  // 错误信封（400/401/402 的非流式分支会走到这里：网关直接回 JSON 错误体）。
  if (record.error !== undefined && record.choices === undefined) {
    const frame = parseQoderStreamErrorPayload(parsed)
    const error = classifyQoderError({
      httpStatus: options.httpStatus,
      ...frame.code === undefined ? {} : { code: frame.code },
      message: frame.message,
      source: 'chat',
      body: rawText,
      ...options.product === undefined ? {} : { product: options.product },
      ...options.afterJobTokenRetry === undefined ? {} : { afterJobTokenRetry: options.afterJobTokenRetry },
    })
    return {
      done: false, produced: false, hasToolCalls: false, argumentsTruncated: false, error,
    }
  }

  const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : undefined
  let produced = false
  let hasToolCalls = false
  const choices = record.choices
  const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined
  const message = typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>).message
    : undefined

  if (typeof message === 'object' && message !== null) {
    const payload = message as Record<string, unknown>
    let nextIndex = 0
    const thought = typeof payload.reasoning_content === 'string' ? payload.reasoning_content : ''
    if (thought.length > 0) {
      produced = true
      const index = nextIndex++
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: thought }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: thought } }
    }
    const text = typeof payload.content === 'string' ? payload.content : ''
    if (text.length > 0) {
      produced = true
      const index = nextIndex++
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'text', text } }
    }
    const calls = payload.tool_calls
    if (Array.isArray(calls) && calls.length > 0) {
      for (const item of calls) {
        if (typeof item !== 'object' || item === null) continue
        const call = item as Record<string, unknown>
        const fn = typeof call.function === 'object' && call.function !== null
          ? call.function as Record<string, unknown>
          : undefined
        const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : 'call_0'
        const name = fn !== undefined && typeof fn.name === 'string' ? fn.name : ''
        const args = fn !== undefined && typeof fn.arguments === 'string' ? fn.arguments : ''
        hasToolCalls = true
        produced = true
        const index = nextIndex++
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: ToolCallId(callId), name, argumentsDelta: args }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: normalizeToolArguments(args) },
        }
      }
    }
  }

  const usage = parseQoderUsage(record.usage ?? record.raw_usage)
  if (usage !== undefined) yield { type: 'usage', usage }

  return {
    done: true,
    produced,
    hasToolCalls,
    argumentsTruncated: false,
    ...model === undefined ? {} : { model },
  }
}

/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
  /** 该适配器消费的默认单凭据 ref（账号池场景下由 `resolveCredential` 决定实际值）。 */
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据（PAT 本体在 `access_token`）。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。无目标模型的场景
   * （拉模型目录）省略该参数。
   */
  resolveCredential: (model?: string) => Promise<QoderCredential | undefined>
  /**
   * 静默续期凭据（对 Qoder 而言就是**重打 exchange**）。
   *
   * `model` 与 {@link QoderAdapterOptions.resolveCredential} 同源。**必须用同一个
   * model 选号**：`refresh` 是「按账号池选号再续期该账号」，若它与解析时用的过滤
   * 口径不同（例如这里漏传 model），就会出现「解析到 B、却刷新了 A」—— B 的过期
   * token 永不更新，用户看到「刚登录好却一直认证失败」而日志全绿。
   */
  refresh: (model?: string) => Promise<void>
  /**
   * 取 job token（`jt-…`）。
   *
   * 接线时传 `(pat) => ctx.qoderAuth.getJobToken(pat)`。
   *
   * ⚠️ **省略时抛错而不是自行降级**：步骤 2 **不接线**（`src/index.ts` 尚未
   * 注册本 provider），此时构造出来的实例没有任何 `ctx` 可取，静默降级成
   * 「用 PAT 当 Bearer」只会换来一个上游 401 —— 那会把「没接线」这个明确的
   * 配置错误伪装成「凭据失效」，让排查方向整个跑偏。
   */
  getJobToken?: (pat: string) => Promise<string>
  /** 丢弃 jt 缓存（下次 {@link QoderAdapterOptions.getJobToken} 必然重换）。 */
  invalidateJobToken?: (pat: string) => void
  /**
   * **额度二次判别**（计划步骤 4 注入；本步省略）。
   *
   * 这是 `402 code:116` 唯一被允许通向「换号」的路径：402 存在语义污染
   * （quota=0 时无效模型名也回 402），故必须由 quota 端点确证。
   * **省略时返回 undefined ⇒ 分类器保守判「不换号」**，把真因直接报给用户。
   */
  quotaVerdict?: (classification: QoderErrorClassification) => Promise<QoderQuotaVerdict | undefined>
  /**
   * 覆盖目录拉取（测试 / 上层缓存注入）。
   *
   * 省略时适配器自己调 {@link fetchQoderDirectory}（PAT 直连，见
   * `src/qoder-models.ts`）。注入点存在是为了让单测能确定性地喂 17 项快照，
   * 而不必在适配器里假设响应形态 —— 解析规则只有一处（`parseQoderDirectory`）。
   */
  fetchRemoteModels?: (credential: QoderCredential) => Promise<readonly QoderModelEntry[]>
  fetchImpl?: typeof fetch
  /** 多账号池（用于确证额度耗尽后切换账号）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 `QODER`。 */
  product?: QoderProduct
}

/** Qoder LLM 适配器。使用 `Bearer jt-…` 鉴权，仅支持流式（SSE）。 */
export class QoderAdapter extends LlmAdapter {
  private readonly product: QoderProduct
  private readonly fetchImpl: typeof fetch
  /** 模型目录缓存（12h TTL，成功才写；见 {@link ensureCatalog}）。 */
  private readonly catalog = new QoderCatalogStore()

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.product = options.product ?? QODER
    this.fetchImpl = options.fetchImpl ?? fetch
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
   * 模型目录：动态目录（只认 PAT）+ 静态兜底，12h TTL。
   *
   * 见 `src/qoder-models.ts` 的模块头：定案是「拉取成功时只播报
   * `is_enabled === true` 的项」，故拿到非空动态目录时**直接播报它**，不并入
   * 静态项（`lite` 因此只在目录失败时出现 —— 那条不对称是刻意的）。
   *
   * ⚠️ 回退的是**本产品**的静态表（`this.product`）：CN 那张不含 `lite`
   * （CN 目录与账号侧都没有它的证据，见 `qoder-models.ts` 模块头）。
   *
   * 黑名单在**播报前**过滤（`disabledModelsFor`）：黑名单是黑名单制（键存在且为
   * `true` 才隐藏），每次调用实时读，改开关后无需重建适配器。它**只影响播报、
   * 不影响路由**（见 {@link resolveModel}）。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureCatalog()
    const source = this.catalogEntries()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // ⚠️ **恒为纯文本**，不按目录的 `is_vl` 声明 —— 本适配器的 chat 路径
      // （`serializeQoderMessages`）只搬运文本块，图片块会被静默丢弃。把
      // `is_vl:true` 报成「支持图片」会让 DSH 把图片路由进这条必然丢图的通道。
      // 与 trae-cn 的「目录照实报能力、请求路径另设防线」**刻意不同**：那边的
      // 图片通路有实测依据（静态表逐项标过多模态），这里只有目录一个布尔，
      // 不足以支撑「图片能送达上游」这个结论。
      inputModalities: QODER_TEXT_ONLY,
    }))
  }

  /**
   * 解析单个模型的路由信息。
   *
   * ## 表外模型**不抛错**（这是有意的，不是漏写）
   *
   * 计划文档说「目录里没有的模型名直报『不在 Qoder 可用目录』」，但**直报的位置
   * 是失败路径而不是这里**：DSH 约定 `listModels` 结果仅供参考、模型目录**不构成
   * 路由白名单**（`LlmModelInfo` 的注释原文：catalog membership is advisory,
   * not request validation）。在 `resolveModel` 抛错会让两类**正常**用法彻底无法
   * 发起请求且没有恢复入口：
   *
   * - 历史会话里保存的旧模型 id（roster 浮动，昨天可用的今天可能不在表里）；
   * - 目录拉取失败时回退的静态表只有极少数项（国际版 3 项 / CN 2 项），
   *   而账号其实能用别的模型。
   *
   * 故表外 id **原样路由**，由上游回 402/`invalid_model_error`，届时
   * {@link withOffCatalogHint} 补一句可读提示 —— 与 trae-cn 的 `4001` 提示同源同则。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureCatalog()
    // **两级查找**（与 trae-cn 的 `catalogEntries() ?? fallbackIndex` 同构）：
    // 生效目录优先，未命中再查**本产品**的静态兜底表。第二级不是冗余 —— 国际版的
    // `lite` 按设计**不在动态目录里**（见 `qoder-models.ts` 模块头），只有静态表
    // 能给它展示名；少了这级，`lite` 在目录成功时会退化成「名字就是 id」。
    // CN 的静态表没有 `lite` ⇒ CN 下这级对它自然不命中（按表外处理，是有意的）。
    const entry = this.catalogEntries().find((candidate) => candidate.id === model)
      ?? fallbackQoderCatalog(this.product).find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      // 模态与 `listModels` **同源同口径**（同一个常量），否则选择器显示的能力
      // 与请求路径的实际行为会分叉。
      inputModalities: QODER_TEXT_ONLY,
    }
    // 上下文窗口：目录的 `default_context_window`（缺它时取
    // `available_context_windows` 首项）。272000 这类非整值**照收** —— 它是目录
    // 的实测值，按「常见整数」规整化会让 DSH 的压缩时机与上游实际窗口不符。
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    // 思考档位：DSH 的「思考程度」选择器**唯一**的数据源是本字段 —— 不声明时
    // 模型选择器里整行不渲染（显示「当前模型未提供推理等级」）。
    //
    // 数据源是目录的 `efforts` / `default_effort`（T1 定案：目录是思考档位的
    // **权威来源**，不再需要像 trae-cn 那样从静态表按 id 补）—— 目录拉取失败
    // 回退静态表时，只有 `qmodel_38max` / `qfmodel` 有档位（`lite` **不声明**，
    // 目录没给、也没有别的实测来源）。
    const efforts = entry?.reasoningEfforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        // id **逐字符照抄**目录值：它会原样进请求体（`reasoning_effort`），
        // 规整化（如 xhigh→high）会让上游认不出档位。
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: effortDisplayName(id) })),
        // 默认档必须落在 efforts 内：声明了却不在里面会被 DSH 判为
        // `INVALID_MODEL_REASONING` 直接抛错（解析器已挡一道，这里再挡一道，
        // 防静态表将来出现不自洽的组合）。
        ...entry?.defaultReasoningEffort !== undefined && efforts.includes(entry.defaultReasoningEffort)
          ? { defaultEffort: ReasoningEffortId(entry.defaultReasoningEffort) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 确保目录就绪（带 12h TTL）。
   *
   * `listModels` / `resolveModel` / `stream` 三处都会调用：`resolveModel` 可能先于
   * `listModels` 被调用（直接从历史会话进入），`stream` 需要它来判定目标模型是否
   * 在目录里（{@link withOffCatalogHint}）。
   *
   * ## 缓存策略（照 trae-cn / LobsterAI 的 12h 先例）
   *
   * - **成功**：写缓存 + 记时刻，{@link QODER_MODELS_TTL_MS} 内不再拉取；
   * - **失败/空**：**不写缓存**（`store` 对空数组是 no-op），也**不清**已有缓存
   *   —— 一次网络抖动不该把目录从「上次成功的完整目录」打回 3 项静态表；
   * - **无凭据**：直接跳过（回退静态表），不发一次必然 401 的请求。
   *
   * 并发调用会各自触发一次拉取（没有 in-flight 去重）：目录是幂等 GET，重复一次的
   * 代价远小于引入一个需要处理的共享 Promise 状态（与 trae-cn 同一取舍）。
   */
  private async ensureCatalog(): Promise<void> {
    if (this.catalog.fresh() !== undefined) return
    try {
      // 目录端点用 **PAT** 直连（不传 model：目录对所有模型一致，故不做逐模型
      // 限流过滤，见 AGENTS.md 的账号池约定）。
      const credential = await this.options.resolveCredential()
      if (credential === undefined || credential.access_token.length === 0) return
      const entries = this.options.fetchRemoteModels === undefined
        ? await fetchQoderDirectory(credential, { fetchImpl: this.fetchImpl, product: this.product })
        : await this.options.fetchRemoteModels(credential)
      this.catalog.store(entries)
    } catch {
      // 远端不可用：回退静态目录（由 catalogEntries 提供）。
    }
  }

  /** 当前生效的目录（动态优先，失败/空回退本产品的静态表）。 */
  private catalogEntries(): readonly QoderModelEntry[] {
    return effectiveQoderCatalog(this.catalog.entries(), this.product)
  }

  /**
   * 目标模型是否**确知不在**可用目录里。
   *
   * ## 两道都要过：目录已确证 + 不是我们已知可用的 id
   *
   * 1. **只在动态目录已成功拉到**（`catalog.entries()` 有值）时才敢谈「不在目录中」
   *    —— 那时目录是权威的完整集，表外即真的不可用。回退静态表时我们只有极少数
   *    项（国际版 3 / CN 2，账号实际能用的远不止这些），对任何别的模型说
   *    「不在目录」都是**错的**。
   * 2. **本产品静态兜底表里的 id 恒不算「表外」**。国际版下这一条为 `lite` 而设：
   *    它按设计不在动态目录里，却是 quota=0 账号上**唯一实测可用**的模型
   *    （T2/T3）—— 对它说「已不在可用目录中，请重选」会把用户从唯一能用的模型上
   *    劝走，是**有害**的误导。同理两个目录项也已确证官方启用。
   *    ⚠️ **CN 下这张表不含 `lite`**，于是 CN 上 `lite` 会正常被判为表外 ——
   *    这是**刻意**的（CN 目录与账号侧都没有它的任何证据，见 `qoder-models.ts`
   *    模块头）。两个 region 的差别不需要额外分支：它由「查哪张表」自然导出。
   *
   * 任一条件不满足即返回 false（不补提示）：宁可少说一句，也不给误导性建议。
   */
  private isModelKnownOffCatalog(model: string): boolean {
    const remote = this.catalog.entries()
    if (remote === undefined) return false
    if (remote.some((candidate) => candidate.id === model)) return false
    if (fallbackQoderCatalog(this.product).some((candidate) => candidate.id === model)) return false
    return true
  }

  /**
   * 给失败文案补「模型不在目录」提示（照 trae-cn 的 `4001` 提示惯例）。
   *
   * 两道判据都过才补：
   * 1. **确知不在目录里**（{@link isModelKnownOffCatalog}）；
   * 2. **失败码可归因于模型名** —— 只认流内的 `invalid_model_error`
   *    （上游直说该模型名不受支持）。
   *
   * ⚠️ **判据只认 `code`，不认 `wrappedCode`**：`wrappedCode` 是 `provider_error`
   * 包装码二次解析出的真码，而 `invalid_model_error` 是**流内直接给出的业务码**
   * （走分类器第 5 条），它只落在 `code` 上。写 `wrappedCode` 会让本提示
   * **永远不触发**（静默失效，且测试若也照抄该字段就会一起绿）。
   *
   * ⚠️ **402 一律不补**，无论是否已确证额度耗尽：402 的语义是额度，不是模型名
   * （T3 实测 quota=0 时无效模型名也回 402 `code:116`）—— 对「只是没额度」的用户
   * 说「模型不在目录、请重选」，会让他在换模型上白费功夫，而换模型救不了额度。
   */
  private withOffCatalogHint(message: string, model: string, classification: QoderErrorClassification): string {
    if (classification.code !== 'invalid_model_error') return message
    if (!this.isModelKnownOffCatalog(model)) return message
    return `${message}${QODER_OFF_CATALOG_HINT}`
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本基类尚未
   * 提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` / `TraeCnAdapter` 同款 shim。
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
    // 1. 获取凭据（PAT 本体在 access_token）。
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为额度耗尽的
    // 账号（否则每次请求都要先白跑一遍这些账号再换号）。
    const credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError(
        `${this.product.id}: no usable credential; paste a personal access token first`,
        'MISSING_CREDENTIAL',
      )
    }

    // 2. 记录当前账号（确证额度耗尽后可切换）。
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        )
        if (currentAccountId === '') {
          console.warn('[qoder] 当前凭据未匹配到账号池条目，额度标记将被跳过')
        }
      } catch (error) {
        console.warn('[qoder] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    const body = buildQoderChatBody(options, this.product)

    // ⚠️ **刻意不在这里拉目录**（只读已就绪的缓存）。
    //
    // 失败文案里的「不在目录」提示（{@link withOffCatalogHint}）需要目录，但
    // **拉取动作不该发生在请求路径上**：那会给每次冷启动的对话多打一个与本次
    // 请求无关的网络往返，并让 `stream()` 依赖目录端点的可用性（目录抖动会拖慢
    // 首字节）。而目录在实践中**必然已经就绪** —— DSH 进对话前一定先经
    // `prepareCall` → `resolveModel`（以及模型选择器的 `listModels`），两者都会
    // 调 `ensureCatalog()`。
    //
    // 极端情况（有人绕过 `prepareCall` 直接调 `stream()`）下目录为空，
    // `isModelKnownOffCatalog` 返回 false ⇒ 只是**少一句提示**，不影响请求本身。
    // 这个降级方向是正确的：诊断信息的缺失远轻于把网络依赖引进热路径。

    /**
     * 已试过的账号 id。
     *
     * 换号时必须传给池：刚失败的账号仍是池里排序第一，不排除就会拿回同一个
     * 账号、命中 `tried.has` 而立即中断 —— 换号形同虚设。
     */
    const tried = new Set<string>()
    let accountId = currentAccountId
    if (accountId !== '') tried.add(accountId)

    /** 最后一次失败的成组状态（message / classification / status 必须同源）。 */
    let lastClassification: QoderErrorClassification | undefined
    let lastStatus = 0
    let lastMessage = ''

    // 3. 首次尝试（内含 401 的「重换 jt 一次再试」）。
    let attempt = await this.attempt(credential, body, options)

    // 4. 换号循环。
    //
    // ⚠️ **上限减 1**：首个账号在循环外已经发过一次请求；不减的话总请求数会变成
    // 1 + MaxRotate，比 `QODER_MAX_ROTATE` 的设计值多一次。
    const maxRotate = QODER_MAX_ROTATE - 1
    for (let round = 0; ; round++) {
      if (!attempt.response.ok) {
        const text = await attempt.response.text().catch(() => '')
        const facts = extractQoderErrorFacts(text)
        lastStatus = attempt.response.status
        lastClassification = await this.classifyHttpFailure(
          attempt.response.status, facts, text, attempt.afterJobTokenRetry,
        )
        lastMessage = lastClassification.message
      } else {
        // 消费流：chunk **实时透传**（用户要看到逐字输出），同时记录是否已有产出。
        const cell: ConsumeCell = { yielded: false }
        for await (const chunk of this.consumeInto(attempt.response, options, attempt.afterJobTokenRetry, cell)) {
          cell.yielded = true
          yield chunk
        }
        const outcome = cell.outcome!
        lastStatus = attempt.response.status

        if (outcome.error !== undefined) {
          // 流内失败已经透传出内容时不再换号：换号会让用户看到「半截回答 +
          // 完整回答」两段内容，比直接报错更糟。降级为直报。
          //
          // 用 `cell.yielded`（而不是 `outcome.produced`）：前者涵盖所有已发出的
          // chunk（含 `usage`），后者只涵盖正文/思考/工具块。只发过 usage 就失败时
          // 同样不能重来，否则用量会被重复计入。
          lastClassification = cell.yielded
            ? { ...outcome.error, action: 'fail' }
            : await this.confirmQuota(outcome.error)
          lastMessage = lastClassification.message
        } else if (!outcome.done) {
          // ⚠️ **没有 `[DONE]` 就不是成功收尾**（模块头第 1 条）。
          // 两类错误都不出 `[DONE]`，所以静默当优雅结束＝把失败伪装成空回复。
          // 归类 TRANSPORT（可重试）：这是传输层的截断，不是业务终态。
          throw new LlmError(
            `${this.product.id}: Stream ended without [DONE]`
            + (outcome.produced ? '（流在产出中途被截断）' : '（流未产出任何内容即结束）'),
            'TRANSPORT',
            { status: attempt.response.status },
          )
        } else if (!outcome.produced) {
          // 收到 `[DONE]` 却一个内容块都没有：报 EMPTY_RESPONSE 让 DSH 重试，
          // 而不是把一条空 assistant 消息交给用户（那会静默结束本轮）。
          // **不换号** —— 空回复不是账号问题，换个账号只会再拿到一次空回复。
          throw new LlmError(
            `${this.product.id}: 上游返回空回复（[DONE] 后无任何内容块）`,
            'EMPTY_RESPONSE',
            { status: attempt.response.status },
          )
        } else {
          // 成功收尾。三种「不完整」都必须报告 max-tokens 而非 tool-calls：
          // 未收到 `[DONE]`（已在上面的分支拦截）、工具参数无法解析（分片丢失）。
          // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，模型收到
          // 莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试（与其它 provider
          // 同策略）。
          //
          // ⚠️ `model` 回显值经 `replayState` 透传给 DSH（真实模型在
          // `raw_usage.model`，上游 `model` 字段回显的是**传入值**）。
          yield {
            type: 'finish',
            reason: outcome.argumentsTruncated
              ? { kind: 'max-tokens' }
              : outcome.hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' },
            ...outcome.model === undefined ? {} : { replayState: { response: { model: outcome.model } } },
          }
          return
        }
      }

      // **先记冷却，再决定是否换号**。
      //
      // 顺序不能颠倒：`recordCooldown` 只对**确证额度耗尽**写标记
      // （见 `recordsQoderCooldown`），而 `accountId` 在下面会被推进到下一个
      // 账号 —— 先记才不会记到别人头上。
      await this.recordCooldown(accountId, options.model, lastClassification)

      if (!this.options.accountPool) break
      if (lastClassification === undefined) break
      if (!shouldSwitchQoderAccount(lastClassification.action)) break
      if (round >= maxRotate) break

      const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried)
      if (!next || tried.has(next.entry.id)) break
      tried.add(next.entry.id)
      accountId = next.entry.id
      attempt = await this.attempt(next.credential as QoderCredential, body, options)
    }

    // 5. 试遍候选（或本就没有池、或已产出过内容不能再换号）：抛出**最后一次**的
    // 真实原因，不吞诊断信息。
    if (lastClassification !== undefined) {
      throw new LlmError(
        this.withOffCatalogHint(lastMessage, options.model, lastClassification),
        qoderHarnessErrorCode(lastClassification),
        { status: lastStatus },
      )
    }
    throw new LlmError(
      lastMessage.length > 0 ? lastMessage : `${this.product.id}: 请求失败`,
      'INVALID_REQUEST',
      { status: lastStatus },
    )
  }

  /**
   * 把 HTTP 层失败转成分类结果，并对额度类候选做**二次判别**。
   *
   * 402 的语义污染（quota=0 时无效模型名也回 402 `code:116`）决定了这里不能
   * 直接采信 `quotaCandidate` —— 必须经 {@link confirmQuota} 确证才可能换号。
   */
  private async classifyHttpFailure(
    status: number,
    facts: QoderErrorFacts,
    body: string,
    afterJobTokenRetry: boolean,
  ): Promise<QoderErrorClassification> {
    const classification = classifyQoderError({
      httpStatus: status,
      ...facts.code === undefined ? {} : { code: facts.code },
      ...facts.message === undefined ? {} : { message: facts.message },
      source: 'chat',
      body,
      afterJobTokenRetry,
      // region 上下文：CN 的 chat 503 是「路径不存在」（ALB 按路径级拒绝），
      // 直报而非退避 —— 这是本 provider 唯一按 region 分流的分类分支。
      product: this.product,
    })
    return this.confirmQuota(classification)
  }

  /**
   * 对「额度类候选」执行 quota 二次判别（步骤 4 注入回调）。
   *
   * 回调省略、抛错、或返回 `undefined` 时**一律保守不换号** —— 这正是
   * `applyQoderQuotaVerdict` 的既定语义（查不到 ⇒ 不换）。把「查不到」当成
   * 「已耗尽」会让一个模型名错误触发死循环换号，把 N 个账号的额度一起烧掉。
   */
  private async confirmQuota(classification: QoderErrorClassification): Promise<QoderErrorClassification> {
    if (!classification.quotaCandidate) return classification
    const probe = this.options.quotaVerdict
    if (probe === undefined) return applyQoderQuotaVerdict(classification, undefined)
    let verdict: QoderQuotaVerdict | undefined
    try {
      verdict = await probe(classification)
    } catch (error) {
      console.warn('[qoder] 额度二次判别失败（保守按不换号处理）:', error)
      verdict = undefined
    }
    return applyQoderQuotaVerdict(classification, verdict)
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
    afterJobTokenRetry: boolean,
    cell: ConsumeCell,
  ): AsyncGenerator<StreamChunk, void, void> {
    const inner = consumeQoderStream(response, {
      label: this.product.id,
      httpStatus: response.status,
      timeouts: { firstFrameMs: resolveFirstFrameTimeoutMs(), chunkMs: resolveChunkTimeoutMs() },
      afterJobTokenRetry,
      product: this.product,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    try {
      cell.outcome = yield* inner
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof LlmError) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `${this.product.id}: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error },
        )
      }
      throw error
    }
  }

  /**
   * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
   *
   * 只对 `recordsQoderCooldown` 认可的失败记录，即**已确证的额度耗尽**。
   * 402 未确证、退避类与未知码**一律不记**：冷却标记的作用是让
   * `getAvailableAccount` 在**下一次选号时跳过该账号**，给一个未确证的 402
   * 记标记等于偷偷换号 —— 而它可能只是一个模型名错误，换号永远救不了。
   */
  private async recordCooldown(
    accountId: string,
    model: string,
    classification: QoderErrorClassification | undefined,
  ): Promise<void> {
    if (!this.options.accountPool || accountId === '') return
    if (classification === undefined) return
    if (!recordsQoderCooldown(classification)) return
    try {
      await this.options.accountPool.updateModelRateLimit(
        accountId,
        model,
        Date.now() + QODER_COOLDOWN_MS,
      )
    } catch (error) {
      console.warn('[qoder] 记录额度标记失败（不影响本次请求）:', error)
    }
  }

  /**
   * 取 job token；**省略注入时抛错而不是自行降级**（理由见
   * {@link QoderAdapterOptions.getJobToken}）。
   */
  private async jobToken(pat: string): Promise<string> {
    const provider = this.options.getJobToken
    if (provider === undefined) {
      throw new LlmError(
        'qoder: 未注入 job token 提供者（适配器尚未接线，见 qoder-adapter.ts 模块头）',
        'MISSING_CREDENTIAL',
      )
    }
    return provider(pat)
  }

  /** 丢弃 jt 缓存；未注入时静默跳过（重换本身仍会发生，只是缓存没被清）。 */
  private discardJobToken(pat: string): void {
    this.options.invalidateJobToken?.(pat)
  }

  /**
   * 发起一次 chat 请求，**内含 401 的「静默重换 jt 一次再试」**。
   *
   * ## 为什么 401 必须重换一次而不是直接判凭据失效
   *
   * chat 端点的 401 是裸 `{"error":"unauthorized"}`、**不带可分型的业务码**
   * （T3 矩阵第 4/4b 行），无法与「PAT 类型错」在响应上区分。而 jt 的 24h
   * 有效期是**运行时缓存**，进程重启、缓存过期、或服务端提前失效都会得到
   * 同一个 401。正确动作是「先当过期处理：invalidate → exchange → 重试一次；
   * 仍 401 才判凭据失效」（计划 §2 决策 3）。
   *
   * `afterJobTokenRetry` 随结果返回，透传给流内错误分类器 —— 它是 401 分型的
   * **唯一**依据（时序标志），丢了它分类器就只能按「第一次」处理。
   */
  private async attempt(
    credential: QoderCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<{ response: Response; afterJobTokenRetry: boolean }> {
    const pat = credential.access_token
    const first = await this.jobToken(pat)
    let response = await this.send(first, body, options)
    if (response.status !== 401) return { response, afterJobTokenRetry: false }
    // 先丢弃缓存，再取一次 —— 不丢弃的话 `getJobToken` 会把同一个（被判失效的）
    // jt 从缓存里原样还回来，重试变成一次无意义的重复请求。
    this.discardJobToken(pat)
    const second = await this.jobToken(pat)
    response = await this.send(second, body, options)
    return { response, afterJobTokenRetry: true }
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    jobToken: string,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    // 注意：不用 `new Headers(...)` —— Headers 构造器会丢弃/规范化部分头，
    // 普通对象逐字传递（与 credits 模块一致），避免两处请求头形态不一致。
    const headers = qoderJobTokenHeaders(jobToken, this.product, 'text/event-stream')
    // Cosy 头：**只在产品声明了 `cosyVersion` 时才发**（CN 特有）。国际版不声明
    // ⇒ 零头变化。两处口径同源（`product.cosyVersion`），不要在这里再写一份判断。
    //
    // ⚠️ `Cosy-MachineOS` / `Cosy-MachineHostname` **刻意不发**：官方对它们是
    // 条件性发送，本插件不猜机器身份（见 `QoderProduct.cosyVersion` 的注释）。
    if (this.product.cosyVersion !== undefined) {
      headers['Cosy-ClientType'] = qoderClientType(this.product)
      headers['Cosy-Version'] = this.product.cosyVersion
    }
    // chat 主机：**每次请求时**读 `QODER_MODEL_SERVER_HOST`（逃生阀语义 = 运行时可切，
    // 故不能在构造时缓存）。只覆盖 chat，openapi / models 两条控制面不受影响。
    const chatBase = resolveQoderChatBase(this.product.chatBase)
    try {
      return await this.fetchImpl(`${chatBase}${QODER_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `${this.product.id}: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error },
        )
      }
      throw error
    }
  }
}

/** 一次流消费的旁路结果（`for await` 会丢弃生成器的 `return` 值，故用 cell 传递）。 */
interface ConsumeCell {
  /** 流消费完成后的结果。 */
  outcome?: QoderStreamOutcome
  /** 是否已向外透传过 chunk（决定能否安全换号）。 */
  yielded: boolean
}

/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * ⚠️ **本步（步骤 2）尚未被调用**：`src/index.ts` 的接线属步骤 6。此函数现在
 * 就导出，是为了让接线那一步只需要加一行调用 —— 路由名、配置页展示名与
 * settingsNs 全部由产品配置驱动（`qoder` / `llm-qoder`）。
 *
 * `settingsNs` **必须**与 `src/index.ts` 的 `registerProviderSettings` 注册的
 * namespace 一致，否则模型设置页会因未注册 namespace 在
 * `refFor → deriveKeyRef(provider)` 处崩溃。
 */
export function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): void {
  const product = options.product ?? QODER
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([product.id], new QoderAdapter(options))
}
