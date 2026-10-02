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
 * ⚠️ **`5xx → backoff` 有一条被实测推翻的例外：CN 的 chat 503**。它不是网关
 * 抖动，而是**路径不存在**（`gateway.qoder.com.cn` 上 `/model/v1/chat/completions`
 * 被 ALB 按路径级拒绝，恒 503，与凭据/头/出口无关）。对 CN 退避重试等于**永远
 * 重试一个不可能成功的请求**，故 {@link classifyQoderError} 按 region 分流：
 * CN 的 chat 503 直报 `'fail'`，**国际版的 503 维持 `'backoff'` 不变**
 * （对它而言瞬时故障是真实可能，实测可用）。分流判据见
 * {@link QoderErrorInput.product}。
 *
 * ## 两段式判定：先分类，再由额度端点确证
 *
 * {@link classifyQoderError} 只能看到**错误本身**，看不到账号的额度。因此对
 * 402 + 116 它只标 `quotaCandidate`（候选）并给 `fail`；真正的换号决定由
 * {@link applyQoderQuotaVerdict} 依据额度端点的查询结果做出。这样「未确证前
 * 绝不换号」成为**类型上的默认值**，而不是一句口头约定。
 *
 * ## 本地字节闸：≥ 240 KiB 的请求在**发出之前**就判 `CONTEXT_WINDOW_EXCEEDED`
 *
 * Qoder 国际版的 chat 网关对请求体有一条**确定性字节墙**（2026-09-21 字节级
 * 矩阵取证）：body ≥ **262 144 B（256 KiB）** 恒回 HTTP 500
 * `{"error":"internal server error"}`，**没有任何可判别的 code**；单变量钉死、
 * 零抖动（262 144 B → 200 四次复测，262 145 B → 500 三次复测）。
 *
 * 这条墙的处置**不能**交给既有的 HTTP 兜底：`500 → 'backoff'` 会把一个
 * **确定性失败**变成无限退避重试（永远救不回来），真因（请求太大）被
 * 「网关瞬时故障」完全掩盖。故在适配器侧设一道**本地闸**
 * （{@link QODER_MAX_REQUEST_BYTES}）：序列化完成后先量字节，达阈值即
 * **不发请求**、直接以 {@link buildQoderByteGateFailure} 的结果抛错。
 *
 * 映射成 `CONTEXT_WINDOW_EXCEEDED` 的理由与 trae-cn 的 `4006`（请求超长）
 * 完全同构（`traeCnErrorCodeForAction`）：DSH 的自动压缩补救**只认这一个码**
 * （`packages/compaction/compaction-basic` 的 `agent/request-error` 处理器
 * 首行就判 `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE` 即放行），压缩后
 * 请求体回落到墙内，重试必成功。
 *
 * ⚠️ **这与「未知码不得瞎猜 CONTEXT_WINDOW_EXCEEDED」的原则不冲突**，两者
 * 判据的性质根本不同：未知**业务码**是上游语义未知、猜了就是编造；而本地
 * 字节数是**我们自己算出来的确定性事实**（`Buffer.byteLength` 的结果），
 * 「这个请求一定过不了那道墙」是算术，不是猜测。故这里用**显式标志位**
 * （{@link QoderErrorClassification.localByteGate}）承载判据，
 * **不靠文案关键词**去命中 `isContextWindowExceededError` —— 文案是中文，
 * 正则本就命不中，靠关键词等于把确定性判据降级成字符串巧合。
 *
 * 本模块**只有纯函数**，无副作用、不发请求（不 import fetch），故可整表穷举单测。
 */
import type { QoderProduct } from './qoder-product.js';
/**
 * 失败处置动作。
 *
 * 刻意用字符串字面量而非数字：码值在日志与测试断言里可读性差，
 * 且 `'switch-account'` 直接就是适配器要做的动作名。
 */
export type QoderErrorAction = 
/** 换下一个账号重试（**仅确证的额度耗尽**）。 */
'switch-account'
/** 不换号，退避重试（限流 / 网关瞬时故障）。 */
 | 'backoff'
/** 直接报错（参数错误 / 模型名错误 / 未知码 / 未确证的 402）。 */
 | 'fail';
/**
 * 业务码的两种输入形态（402 是数字，其余是字符串）。
 *
 * 上游在同一个端点的不同错误里给不同类型：`{"code":116}` 与
 * `{"code":"provider_error"}` 都是实测原文，故两个都收。
 */
export type QoderErrorCode = number | string;
/** 错误来源端点（决定 401 的语义分型）。 */
export type QoderErrorSource = 'chat' | 'quota';
/** {@link classifyQoderError} 的入参。 */
export interface QoderErrorInput {
    /** HTTP 状态码；省略视为「未知」。 */
    httpStatus?: number;
    /** 业务码（数字或字符串）。 */
    code?: QoderErrorCode;
    /** 上游人类可读文案（402 时来自 `error` 字段，其余来自 `message`）。 */
    message?: string;
    /** 错误来自哪个端点；省略视为 `'chat'`。 */
    source?: QoderErrorSource;
    /** 响应体原文（用于 `provider_error` 包装码的 `details` 二次解析）。 */
    body?: string;
    /**
     * 本次分类是否发生在「已重换过一次 jt 之后」。
     * 为 true 时 chat 端点的 401 由「jt 过期」升级为「凭据失效」。
     */
    afterJobTokenRetry?: boolean;
    /**
     * 出错的产品配置（**region 上下文**）；省略视为国际版 {@link QODER}。
     *
     * ⚠️ **只用于「同一状态码在两个 region 语义不同」的分流**，当前仅一处：
     * CN 的 chat `503` 是**路径不存在**（ALB 按路径级恒 503）而非网关抖动，
     * 必须直报而非退避重试（见模块头注释）。
     *
     * 判据**显式列举 `=== QODER_CN.id`**，不做「非国际版即 CN」的反向推断
     * —— 第三个 region 落地时反向推断会把它**静默**归到 CN 的分支上
     * （与 `qoder-models.ts` 的 `qoderFallbackModels` 同一先例、同一理由）。
     *
     * 缺省即国际版，故既有调用点（与既有断言）语义逐字节不变。
     */
    product?: QoderProduct;
}
/** 额度二次判别的结论（步骤 4 接入时由 quota 端点填充）。 */
export interface QoderQuotaVerdict {
    /** quota 端点是否确认额度已耗尽。 */
    exhausted: boolean;
}
/** 分类结果。 */
export interface QoderErrorClassification {
    /** 当前知识下的处置动作。 */
    action: QoderErrorAction;
    /** 归一化前的业务码原文（有则带）。 */
    code?: QoderErrorCode;
    /** HTTP 状态码（有则带）。 */
    status?: number;
    /** 是否「额度类候选」（402 + code 116）—— **未确证**，绝不据此换号。 */
    quotaCandidate: boolean;
    /** 是否已由 {@link applyQoderQuotaVerdict} 确证为额度耗尽。 */
    quotaConfirmed: boolean;
    /** chat 401 的「jt 过期」信号：适配器应先 invalidate + 重换一次再试。 */
    jobTokenExpired: boolean;
    /** 凭据（PAT）失效：需用户重新粘贴。 */
    credentialInvalid: boolean;
    /**
     * 本结果来自**本地字节闸**（请求体 ≥ {@link QODER_MAX_REQUEST_BYTES}），
     * 而不是上游的任何响应。
     *
     * 它与 `jobTokenExpired` 等同属「标志位」：下游据此把错误码映射到
     * `CONTEXT_WINDOW_EXCEEDED`，**不靠文案关键词**（判据性质的说明见模块头）。
     */
    localByteGate: boolean;
    /** `provider_error` 包装码二次解析出的真码（有则带）。 */
    wrappedCode?: string;
    /** 面向用户的中文文案（含上游原文）。 */
    message: string;
}
/** 流内 error 帧的解析结果。 */
export interface QoderStreamErrorFrame {
    /** 业务码（有则带）。 */
    code?: QoderErrorCode;
    /** 人类可读文案。 */
    message: string;
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
    details?: string;
    /** 帧 id（`chatcmpl-…` / `request_id`），仅供日志。 */
    frameId?: string;
}
/**
 * chat 请求体的**本地字节闸**阈值（字节，240 KiB）。
 *
 * ## 为什么是这个数
 *
 * 实测墙是 **262 144 B（256 KiB）**：字节级矩阵取证（2026-09-21）里
 * 262 144 B 恒回 200（4 次复测）、262 145 B 恒回 500（3 次复测），**零抖动**。
 * 阈值取 240 KiB 是对该墙留 **~8.5%** 的余量（262 144 − 245 760 = 16 384 B）：
 *
 * - **余量是必需的**，不是保守：这次量的是我们**序列化出来的 body**，
 *   而网关量的是**它收到的那份**。两者之间还隔着 `fetch` 的传输编码与
 *   中间层（istio-envoy）可能引入的差异 —— 贴着 262 144 设阈值，任何一点
 *   协议开销都会让「本地放行」的请求正好撞墙，闸门就成了摆设。
 * - **余量不能更大**：闸门每收紧一字节，用户就少一截可用上下文（撞闸会触发
 *   一次压缩 + 重试，白丢历史）。8.5% 足以覆盖上述差异，又不会平白砍掉
 *   可用窗口。
 *
 * 该墙**只在国际版 chat 上实测**（CN 的 REST 路径根本不存在，实测无从谈起）。
 * ⚠️ **CN 的 chat 自 2026-09-21 起走 wasm 签名路径，闸门对它同样生效** ——
 * 量的是**签名之前的明文**（见 `qoder-adapter.ts` 的 `stream()`）：密文长度由
 * wasm 决定、我们既预测不了也控制不了，拿它当判据只会引入假阳性。
 * 故两个 region 共用同一个阈值与同一段判定，不按 product 分叉。
 */
export declare const QODER_MAX_REQUEST_BYTES = 245760;
/**
 * 把任意形态的业务码归一化成数字；非法值返回 undefined。
 *
 * - 数字：只接受有限值（`NaN` / `Infinity` 视为非法）；
 * - 字符串：去空白后必须**整串是整数** —— `"116"`、`" 116 "` 是码，
 *   `"code=116"` 之类不是。若被 parseInt 静默截取，会把诊断文本误判成业务码。
 */
export declare function normalizeQoderCode(code: QoderErrorCode | undefined): number | undefined;
/**
 * `details` 的二次解析结果。
 *
 * 真机实测（2026-09-21）表明不同上游后端往 `details` 里填的字段**各不相同**，
 * 只有「码」一个出口会让大多数形态的真因丢失 —— 故两个字段分开承载：
 * 有码给码，没码就把上游自己的话（`reason`）透出来。
 */
export interface QoderWrappedDetail {
    /** 真码（`.error.code` → 根层 `.code`）；解析不出时 undefined。 */
    code?: string;
    /** 上游自己的文案（`.error.message` → 根层 `.message`）；解析不出时 undefined。 */
    reason?: string;
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
export declare function parseQoderWrappedDetail(details: unknown): QoderWrappedDetail;
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
export declare function parseQoderWrappedDetailCode(details: unknown): string | undefined;
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
export declare function parseQoderStreamErrorPayload(payload: unknown): QoderStreamErrorFrame;
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
 * 7. **无业务码时的 HTTP 兜底**：
 *    7a. **CN 的 chat 503** → `'fail'` 直报（路径不存在，见模块头注释；**不重试、
 *        不换号**）—— 这一条**必须排在通用兜底之前**，否则会被 7b 的
 *        `5xx → backoff` 吃掉；
 *    7b. 其余 `429` / `408` / `5xx` → `'backoff'`（**国际版 503 走这条**，
 *        语义与本条落地前逐字节相同）；
 *    7c. 其余（含 400、以及 code 不是 116 的 402）→ `'fail'`。
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
export declare function classifyQoderError(input: QoderErrorInput): QoderErrorClassification;
/**
 * 本地字节闸的判定结果：请求体已达/超过 {@link QODER_MAX_REQUEST_BYTES} 时，
 * 构造一个**不发请求**就能得到的分类结果。
 *
 * @param bodyBytes - 已序列化的请求体的 UTF-8 字节数（`Buffer.byteLength(body, 'utf8')`）。
 * @param product - 产品配置（只用于文案里的 provider 名与声明窗口）。
 * @returns 动作恒为 `'fail'`（确定性失败：同一个 body 再发多少次都撞同一道墙）、
 *          `localByteGate: true` 的分类结果。
 */
export declare function buildQoderByteGateFailure(bodyBytes: number, product?: QoderProduct): QoderErrorClassification;
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
export declare function applyQoderQuotaVerdict(classification: QoderErrorClassification, verdict: QoderQuotaVerdict | undefined): QoderErrorClassification;
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
export declare function createQoderErrorDeduper(): (frame: QoderStreamErrorFrame) => boolean;
/** 该动作是否应触发「换下一个账号」。 */
export declare function shouldSwitchQoderAccount(action: QoderErrorAction): boolean;
/**
 * 该动作是否为「退避重试」（**不换号**）。
 *
 * 适配器据此抛**可重试**错误码，把节奏交还给 DSH 的重试层。
 */
export declare function isQoderBackoff(action: QoderErrorAction): boolean;
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
export declare function recordsQoderCooldown(classification: QoderErrorClassification): boolean;
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
 * - **本地字节闸**（`localByteGate`）→ `'CONTEXT_WINDOW_EXCEEDED'`，同上触发
 *   自动压缩。⚠️ 它**排在上一条之前**，且**不经过** `isContextWindowExceededError`：
 *   闸门文案是中文，正则是英文关键词，走那条路必然命不中（判据性质的说明见
 *   模块头「本地字节闸」一节）。
 * - 其余 → `'INVALID_REQUEST'`。
 */
export declare function qoderHarnessErrorCode(classification: QoderErrorClassification): string;
//# sourceMappingURL=qoder-errors.d.ts.map