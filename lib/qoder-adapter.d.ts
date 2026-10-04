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
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type ContextTier } from './context-tiers.js';
import type { LlmSettingsAddress } from './types.js';
import type { QoderCredential, QoderProduct } from './qoder-product.js';
import type { QoderSigningSource, QoderDirectorySigningSource } from './qoder-signing.js';
import type { QoderModelEntry } from './qoder-models.js';
import type { QoderErrorClassification, QoderQuotaVerdict } from './qoder-errors.js';
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
export declare const PROVIDER: "qoder-cn" | "qoder";
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
 *
 * 设备流目录链接线后，本函数**本体搬到了 `qoder-product.ts`**（目录 host 与
 * chat host 共用同一个逃生阀语义，而 `qoder-models.ts` 不能反向 import 适配器）；
 * 这里 re-export 保持既有 import 路径（`qoder-cn.spec.ts` 等从本模块取它）。
 */
export { resolveQoderChatBase } from './qoder-product.js';
/** 从错误响应体里提取的判据字段。 */
export interface QoderErrorFacts {
    /** 业务码（402 是**数字**，其余是字符串；见 `qoder-errors.ts`）。 */
    code?: number | string;
    /** 人类可读文案（402/401 在 `error` 字段，其余在 `message` 字段）。 */
    message?: string;
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
export declare function extractQoderErrorFacts(body: string): QoderErrorFacts;
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
export declare function parseQoderUsage(payload: unknown): TokenUsage | undefined;
export declare function serializeQoderMessages(messages: readonly {
    role: string;
    content: unknown;
}[], imageUrls?: ReadonlyMap<string, string>): Array<Record<string, unknown>>;
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
export declare function buildQoderChatBody(options: GenerateOptions, product?: QoderProduct, imageUrls?: ReadonlyMap<string, string>): string;
/** {@link consumeQoderStream} 的入参。 */
export interface QoderStreamOptions {
    /** 错误消息前缀（如 `qoder`）。 */
    label: string;
    /** 上游响应的 HTTP 状态码（流内错误几乎恒为 200，仅作分类兜底）。 */
    httpStatus: number;
    /** 两阶段空闲超时：等待首帧与帧间静默。 */
    timeouts: {
        firstFrameMs: number;
        chunkMs: number;
    };
    /** harness 的取消信号。 */
    signal?: AbortSignal;
    /**
     * 本次请求是否发生在「已重换过一次 jt 之后」。
     *
     * 透传给分类器：chat 端点的 401 是裸 `{"error":"unauthorized"}`、**不带可
     * 分型的业务码**，无法与「PAT 类型错」区分，只能靠这个时序标志分型
     * （见 `qoder-errors.ts` 的 401 分支）。
     */
    afterJobTokenRetry?: boolean;
    /**
     * 产品配置（**region 上下文**），透传给错误分类器。
     *
     * 分类器按它分流「同一状态码在两个 region 语义不同」的那一条 —— 当前仅
     * CN 的 chat 503（路径不存在 ⇒ 直报，见 `qoder-errors.ts` 的 7a 条）。
     * 省略时分类器按国际版处理，故既有调用点行为不变。
     */
    product?: QoderProduct;
}
/** 一次 chat 请求的消费结果（供适配器做换号与收尾判定）。 */
export interface QoderStreamOutcome {
    /** 是否收到 `[DONE]`（**唯一**成功收尾判据）。 */
    done: boolean;
    /** 是否产出过任何正文、思考或工具块。 */
    produced: boolean;
    /** 是否存在工具调用块（**只计已发射的块**，见 `droppedUnnamedCalls`）。 */
    hasToolCalls: boolean;
    /** 是否有工具调用的参数无法解析（分片丢失 / 流被截断）。 */
    argumentsTruncated: boolean;
    /**
     * 是否丢弃过**名称不可用**的 tool-call 分片（见 `consumeQoderStream` 的说明）。
     *
     * 丢弃它们是对的（无名调用无法执行、留着会污染会话），但**不能让这一步
     * 静默地以 `stop` 结束** —— 那正是「没有任何报错就中断」：模型本意要调工具，
     * harness 却认为它「正常答完了」。适配器据此改报 `max-tokens`（可重试）。
     *
     * 仅当**没有任何可用调用留下来**时才该改报；同批还有可用调用时照常报
     * `tool-calls`（那几个调用与无名块各自独立，没理由因一个坏块一起作废）。
     */
    droppedUnnamedCalls: boolean;
    /**
     * 思考死循环命中（见 `src/reasoning-loop-guard.ts`）。命中后流是被**主动
     * abort** 的，故 `done` 为 false —— 调用方必须**优先**据此报 `max-tokens`，
     * 而不是当成「流被截断」去抛 TRANSPORT。
     */
    thoughtLoopDetected?: boolean;
    /** 响应 `model` 回显值（真实模型在 `raw_usage.model`）。 */
    model?: string;
    /** 流内错误（有则带；此时 `done` 为 false）。 */
    error?: QoderErrorClassification;
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
export declare function consumeQoderStream(response: Response, options: QoderStreamOptions): AsyncGenerator<StreamChunk, QoderStreamOutcome, void>;
/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
    /** 该适配器消费的默认单凭据 ref（账号池场景下由 `resolveCredential` 决定实际值）。 */
    credentialRef: CredentialRef;
    /**
     * 从凭据存储解析凭据（PAT 本体在 `access_token`）。
     *
     * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
     * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。无目标模型的场景
     * （拉模型目录）省略该参数。
     *
     * `turnIdentity` 是本次请求所属**轮次**的标识对象（`options.signal`），供账号池
     * 实现「切换粒度 = 按轮次」—— 同轮锁同一账号。见 `src/account-consumption.ts`
     * 的 `TurnKeyTracker`（DSH 的 `GenerateOptions` 里没有 turn 级字段）。
     */
    resolveCredential: (model?: string, turnIdentity?: unknown) => Promise<QoderCredential | undefined>;
    /**
     * 静默续期凭据（对 Qoder 而言就是**重打 exchange**）。
     *
     * `model` 与 {@link QoderAdapterOptions.resolveCredential} 同源。**必须用同一个
     * model 选号**：`refresh` 是「按账号池选号再续期该账号」，若它与解析时用的过滤
     * 口径不同（例如这里漏传 model），就会出现「解析到 B、却刷新了 A」—— B 的过期
     * token 永不更新，用户看到「刚登录好却一直认证失败」而日志全绿。
     *
     * `turnIdentity` 同理必须一起透传（形状与 `resolveCredential` 一致）。
     */
    refresh: (model?: string, turnIdentity?: unknown) => Promise<void>;
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
    getJobToken?: (pat: string) => Promise<string>;
    /** 丢弃 jt 缓存（下次 {@link QoderAdapterOptions.getJobToken} 必然重换）。 */
    invalidateJobToken?: (pat: string) => void;
    /**
     * **额度二次判别**（计划步骤 4 注入；本步省略）。
     *
     * 这是 `402 code:116` 唯一被允许通向「换号」的路径：402 存在语义污染
     * （quota=0 时无效模型名也回 402），故必须由 quota 端点确证。
     * **省略时返回 undefined ⇒ 分类器保守判「不换号」**，把真因直接报给用户。
     */
    quotaVerdict?: (classification: QoderErrorClassification) => Promise<QoderQuotaVerdict | undefined>;
    /**
     * 覆盖目录拉取（测试 / 上层缓存注入）。
     *
     * 省略时适配器自己调 {@link fetchQoderDirectory}（PAT 直连，见
     * `src/qoder-models.ts`）。注入点存在是为了让单测能确定性地喂 17 项快照，
     * 而不必在适配器里假设响应形态 —— 解析规则只有一处（`parseQoderDirectory`）。
     */
    fetchRemoteModels?: (credential: QoderCredential) => Promise<readonly QoderModelEntry[]>;
    /** 读取图片附件字节；附件缺失或读取失败时请求中保留占位文本。 */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    fetchImpl?: typeof fetch;
    /** 多账号池（用于确证额度耗尽后切换账号）。 */
    accountPool?: AccountPool;
    /**
     * 调试观测回调（可选）。
     *
     * 目前只有一个用途：**每次 chat 发送都把请求体字节数报出来**
     * （`bodyBytes`），供撞墙趋势可见 —— 这条墙是字节级硬阈值，等到用户报障
     * 才知道「已经贴着墙了」是不可接受的。
     *
     * 与 `trae-cn-credits` / `qoder-credits` 的 `onDebug` 同一形态与同一接线
     * （宿主接 `ctx.logger`）。⚠️ **它不是日志设施本身**：本插件没有注入
     * `ctx.logger` 的通道（适配器是纯构造注入的），故这里只留回调，由宿主决定
     * 落到哪一级；省略时**静默不报**（不影响请求）。
     */
    onDebug?: (message: string) => void;
    /** 产品配置；默认 `QODER`。 */
    product?: QoderProduct;
    /**
     * **签名来源**（CN 的 chat 必需；国际版忽略）。
     *
     * CN 的 chat 只有签名路径可用（`/model/v1/chat/completions` 在 CN 网关
     * 不存在，ALB 按路径级恒 503），故 CN 分支用它换出整包签名三件套。
     *
     * ⚠️ **省略时 CN 抛错，而不是静默回退 REST**：回退会得到上游 503，用户看到
     * 的是「网关故障」而非「插件没接线」—— 后者是可修的配置错误，前者会把人
     * 引向等待恢复。国际版路径一个字节都不碰（不注入也不影响）。
     *
     * ⚠️ **一个 region 一个实例**：签名器把 `product` 绑在构造时，两区共用会拿
     * CN 的机器码签国际版的请求（上游回 `101 Signature invalid`）。
     */
    signing?: QoderSigningSource;
    /**
     * **目录签名来源**（设备流目录链专用，两区都可注入；与 chat 的
     * {@link QoderSigningSource} 并列、互不顶替）。
     *
     * 注入后，设备流令牌（`dt-`）的目录请求改走 wasm 签名链
     * （`GET {inferenceHost}/algo/api/v2/model/list?Encode=1`，stage-a 结论 B）
     * —— `dt-` 打 PAT 目录端点恒 401（总根因），这条链是设备流账号拿到动态
     * 目录的**唯一**通路。PAT 令牌（`pt-`）的目录路径**不经过这里**（一行不动）。
     *
     * ⚠️ **与 chat 的 `signing` 分开注入**：国际版 chat 走 REST（一行不动），
     * 但国际版目录链需要签名 —— 故国际版接线是「`signing` 不传、
     * `directorySigning` 传」。wasm 失败时目录侧静默回退静态表（经 onDebug 报
     * debug 级原因），**不像 CN chat 那样直报**：目录是尽力而为的数据。
     */
    directorySigning?: QoderDirectorySigningSource;
    /**
     * 本 provider 目录项的 settings 地址（`settingsNs` + `settingsPath` 成对）。
     *
     * 由 `src/index.ts` 的 `apply()` **按探测到的契约现算**后传入（见
     * `LlmSettingsAddress`）：0.1.6 得 `llm-qoder` / `llm-qoder-cn` + `[]`，
     * 0.1.7 得 entry id + `['providers', 'qoder' | 'qoder-cn']`。
     *
     * ⚠️ **本适配器被两个 region 共用**（`qoder` / `qoder-cn` 各一个实例，见
     * `src/qoder-product.ts` 的模块头），故地址必须由调用方**逐实例**传入，
     * 不能在适配器内按 `product.id` 现算 —— 那样两个实例的地址虽然也对，但
     * 会把「契约探测」这件事复制到适配器层，与「探测只做一次」的设计冲突。
     *
     * 省略时回退到 **0.1.6 形态**（`llm-<product.id>` + `[]`）：那是迁移前的既有
     * 行为，也让不关心契约的单测保持原样可跑。
     */
    settingsAddress?: LlmSettingsAddress;
}
/** Qoder LLM 适配器。使用 `Bearer jt-…` 鉴权，仅支持流式（SSE）。 */
export declare class QoderAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 模型目录缓存（12h TTL，成功才写；见 {@link ensureCatalog}）。 */
    private readonly catalog;
    /** 目录失败负缓存（5 分钟，仅生产路径生效；见 {@link ensureCatalog}）。 */
    private readonly negativeCache;
    constructor(options: QoderAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页会用
     * 该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。一旦
     * provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，避免
     * `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
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
     *
     * 没有已登录账号时返回 `[]`（目录门控，见 {@link providerCatalogVisible}）——
     * DSH 的 `buildModelCatalog` 会把空分组整个隐藏，模型选择器不再列出用不上的
     * provider。⚠️ **两个 region 共用本类，但 `this.product.id` 不同**，故 Qoder 与
     * Qoder CN 各自独立判定，一区没账号不影响另一区。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
     *
     * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
     * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
     *
     * ⚠️ 与 `listModels` 的唯一区别就是「不套黑名单、不套门控」——可见性口径
     * （动态目录优先 / 静态表兜底）必须同源，故同样走 {@link catalogEntries}。
     * 本方法**同步且有缓存副作用之外的零 IO**：它不触发目录拉取，冷缓存时读到的
     * 就是静态表 —— `model.list` 在调用它之前必然已经跑过 `llm.listModels`。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
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
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 当前生效目录的逐模型上下文窗口档位（id → 默认档 + 完整档位表）。
     *
     * ## 为什么在适配器上而不是 RPC 层现算
     *
     * 目录的持有者是本实例（12h TTL、失败回退本产品的静态表）。`ctx.llm.listModels()`
     * 帮不上忙 —— `LlmRuntime` 会把条目重建成
     * `{provider, id, name, description?, inputModalities?}`，`contextTiers` 这类额外
     * 字段在那一层被丢掉。故由 `src/index.ts` 把本实例交给 `registerAccountHubRpc`
     * （见 `ContextTierRegistry`）；两个 region 各有一个实例，档位互不顶替。
     *
     * ## 数据源与 `resolveModel` **同源同口径**
     *
     * 读的就是 `resolveModel` 查找所用的同一份 `catalogEntries()`。Qoder 的默认档是
     * **最小档**（`default_context_window`），其余是升档选项 —— 与 Buddy 的
     * 「生效档已是最大档」方向相反，但两处都只把目录公布的数带出去。
     *
     * ⚠️ **静态兜底表不带 `contextTiers`**（T1 快照里没有档位表可抄，不编造）：
     * 目录拉取失败时本方法返回的条目只有单个窗口 ⇒ UI 不渲染档位列。
     *
     * ⚠️ **第二级查找（静态表）里的条目不算「表外」**：`lite` 按设计不在动态目录里，
     * 但它有窗口（国际版静态表）—— 校验用户提交的档位时同样要查得到它，故这里
     * 与 `resolveModel` 一样按「生效目录 → 本产品静态表」两级取条目。
     */
    contextTiers(): Promise<ReadonlyMap<string, ContextTier>>;
    /**
     * 确保目录就绪（带 12h TTL + 失败负缓存）。
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
     *   同时记**负缓存**（{@link QODER_DIRECTORY_NEGATIVE_TTL_MS}，E1）：
     *   设备流目录链失败后 5 分钟内不再重试，消除每次 `model.list` 都白打一个
     *   必失败请求的浪费。⚠️ 负缓存**只在生产路径**（未注入 `fetchRemoteModels`）
     *   生效 —— 注入面语义是「调用方接管目录拉取」，重试节奏归注入方，两者
     *   不抢方向盘（既有「失败后重试」用例即钉这一语义）。
     * - **无凭据**：直接跳过（回退静态表），不发一次必然 401 的请求。
     *
     * 并发调用会各自触发一次拉取（没有 in-flight 去重）：目录是幂等 GET，重复一次的
     * 代价远小于引入一个需要处理的共享 Promise 状态（与 trae-cn 同一取舍）。
     */
    private ensureCatalog;
    /** 当前生效的目录（动态优先，失败/空回退本产品的静态表）。 */
    private catalogEntries;
    /**
     * 按 id 查**当前生效目录**里的展示名（两级：生效目录 → 静态表）。
     *
     * {@link ContextTierSource} 的可选能力（B1）：Account Hub「显示列表」的黑名单
     * 并集回填行用它替换写死的 `name = id`（症状一）—— 用户关掉的模型若是目录
     * 里的正常模型（或静态表成员），回填行应带**人话名字**，而不是一串短 key。
     *
     * ## 刻意是**同步**方法、且**刻意不触发目录拉取**
     *
     * `model.list` RPC 在调用它之前必然已经跑过 `llm.listModels` →
     * `ensureCatalog`，目录状态已经是「这一刻的最新值」；再拉一次只会拖慢响应
     * 并引入第二份时序。冷缓存时读到的就是回退值（静态表名或 undefined）——
     * 与 resolveModel 的两级查找同构，宁缺毋编。
     */
    displayName(modelId: string): string | undefined;
    /**
     * 当前目录来源（B3）：**远端成功过一次 = remote，否则 fallback**。
     *
     * 判据是 {@link QoderCatalogStore.entries}（最近一次成功写入）而非
     * `fresh()`：TTL 过期但曾成功的目录对用户来说仍是「远端目录」（抖动期间
     * `entries()` 仍在播报它），报 fallback 会让客户端显示一条与现状矛盾的提示。
     */
    catalogSource(): 'remote' | 'fallback';
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
    private isModelKnownOffCatalog;
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
    private withOffCatalogHint;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 把 HTTP 层失败转成分类结果，并对额度类候选做**二次判别**。
     *
     * 402 的语义污染（quota=0 时无效模型名也回 402 `code:116`）决定了这里不能
     * 直接采信 `quotaCandidate` —— 必须经 {@link confirmQuota} 确证才可能换号。
     */
    private classifyHttpFailure;
    /**
     * 对「额度类候选」执行 quota 二次判别（步骤 4 注入回调）。
     *
     * 回调省略、抛错、或返回 `undefined` 时**一律保守不换号** —— 这正是
     * `applyQoderQuotaVerdict` 的既定语义（查不到 ⇒ 不换）。把「查不到」当成
     * 「已耗尽」会让一个模型名错误触发死循环换号，把 N 个账号的额度一起烧掉。
     */
    private confirmQuota;
    /**
     * 消费一次流，并把 outcome 写进调用方给的 cell。
     *
     * 为什么用 cell 而不是生成器的 `return` 值：`for await` 会**丢弃** `return` 值
     * （只保留 `break`/`throw` 语义），所以 outcome 必须走旁路。cell 由调用方分配，
     * 每次尝试一个 —— 用实例字段会在嵌套/并发调用时串号。
     */
    private consumeInto;
    /**
     * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
     *
     * 只对 `recordsQoderCooldown` 认可的失败记录，即**已确证的额度耗尽**。
     * 402 未确证、退避类与未知码**一律不记**：冷却标记的作用是让
     * `getAvailableAccount` 在**下一次选号时跳过该账号**，给一个未确证的 402
     * 记标记等于偷偷换号 —— 而它可能只是一个模型名错误，换号永远救不了。
     */
    private recordCooldown;
    /**
     * 取 job token；**省略注入时抛错而不是自行降级**（理由见
     * {@link QoderAdapterOptions.getJobToken}）。
     */
    private jobToken;
    /** 丢弃 jt 缓存；未注入时静默跳过（重换本身仍会发生，只是缓存没被清）。 */
    private discardJobToken;
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
     *
     * ⚠️ **签名路径下 401 不会发生**（鉴权头是 `Bearer COSY.…`，不是 jt），故签名
     * 分支只发一次请求。这与「jt 过期 ⇒ 重换」无关，不需要在该路径上保留重试。
     */
    private attempt;
    /**
     * 本实例的签名来源：**只有 CN 走签名路径**。
     *
     * 判据是 region（`product.id`）而不是「有没有注入 signing」：国际版即使被
     * 注入了签名来源也必须走 REST（它的 REST 路径实测可用，换路径等于把一条
     * 已验证的通路改成未验证的）。反向也成立 —— CN 的 REST 路径不存在，
     * 无论有没有注入都不能回退过去（见 {@link QoderAdapterOptions.signing}）。
     */
    private signingSource;
    /** 发起一次**签名**请求：换出签名三件套后整包发出。 */
    private sign;
    /**
     * 把签名环节的异常转成面向用户的 LlmError。
     *
     * 两类**直报**（换号与退避都救不了，判成可重试会让用户白等）：
     * - **wasm 组件不可用** —— 环境问题，文案里带三级尝试的原因（`qoder-wasm.ts`
     *   已经拼好）；
     * - **uid 取不到** —— 签名身份的必需输入，重试同一个账号只会再失败一次。
     *
     * 其余异常**原样上抛**：那多半是代码缺陷（如签名器被释放后复用），
     * 包装它会掩盖真因。
     */
    private signingFailure;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
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
 *
 * @returns 刚注册的适配器实例 —— `src/index.ts` 把它转交给 `registerAccountHubRpc`，
 *          供 Account Hub 读取逐模型的窗口档位（`contextTiers`）与校验用户选择。
 *          适配器是**动态目录的唯一持有者**，RPC 层拿不到目录就只能靠猜。
 */
export declare function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter;
//# sourceMappingURL=qoder-adapter.d.ts.map