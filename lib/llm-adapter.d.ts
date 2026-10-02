import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import type { RemoteModel } from './models.js';
import type { CodeArtsCredential, LlmSettingsAddress } from './types.js';
export declare const CHAT_API_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2";
export declare const PROVIDER = "codearts";
/**
 * benefit（免费额度）模型的判定**已迁到 `src/models.ts` 的
 * {@link isCodeArtsBenefitModel}**：它按「内存缓存 → 磁盘缓存（远端 gateway/config
 * 下发所得）→ 静态兜底表」三级取值，使后端新增 benefit 模型时**无需改代码**。
 *
 * ⚠️ 早期这里是一个硬编码集合 `new Set(['glm-5.3-flash'])` —— 于是
 * `deepseek-v4.1-flash` 等其它 benefit 模型调用时缺 `maas_type: benefit` 头，
 * 后端按非 benefit 通道处理并报错（用户报障）。**不要**再在本文件重新引入
 * 硬编码集合：判定必须与远端集合同源，否则每新增一个 benefit 模型就要改一次代码。
 */
export interface CodeArtsAdapterOptions {
    credentialRef: CredentialRef;
    /**
     * 从凭据存储解析凭据。
     *
     * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
     * 供多账号池跳过「对该模型仍有限流/积分耗尽标记」的账号（见 `buddy-adapter`
     * 的同类说明）。无目标模型的场景（拉模型目录）省略该参数。
     *
     * `turnIdentity` 是本次请求所属**轮次**的标识对象（`options.signal`），
     * 供账号池实现「切换粒度 = 按轮次」—— 同轮锁同一账号。见
     * `src/account-consumption.ts` 的 `TurnKeyTracker`（DSH 的 `GenerateOptions`
     * 里没有 turn 级字段，signal 是唯一的轮次标识）。
     */
    resolveCredential: (model?: string, turnIdentity?: unknown) => Promise<CodeArtsCredential | undefined>;
    /**
     * 静默续期凭据。
     *
     * `model` 与 {@link CodeArtsAdapterOptions.resolveCredential} 同源，供
     * 「按账号池选号再续期」的实现保持与选号一致的口径；默认单凭据路径忽略它。
     *
     * `turnIdentity` 同理必须一起透传：续期与解析必须挑到**同一个**账号，
     * 否则会刷新另一个账号的凭据（详见 `src/index.ts` 的 `makeAccountRefresher`）。
     */
    refresh: (model?: string, turnIdentity?: unknown) => Promise<void>;
    /**
     * 动态拉取远端模型列表；失败时调用方回退到静态列表。
     *
     * ⚠️ 目录项带 `contextWindow`（远端 `context_window`）时，`resolveModel`
     * **优先采用远端值**；字段缺失才回退静态兜底表。
     */
    fetchRemoteModels?: () => Promise<RemoteModel[]>;
    fetchImpl?: typeof fetch;
    chatId?: string;
    sessionId?: string;
    /** 多账号池（用于限流时切换账号） */
    accountPool?: AccountPool;
    /**
     * 该 provider 目录项在 settings 里的**成对地址**（namespace + 分槽路径）。
     *
     * 由 `src/index.ts` 的 `apply()` 按探测到的契约现算后传入（见
     * `LlmSettingsAddress` 与 `registerCodeArtsLlm` 的说明）。**省略时回退到
     * 0.1.6 形态**（`llm-codearts` + `[]`），使直接构造的单元测试无需关心契约。
     */
    settingsAddress?: LlmSettingsAddress;
}
/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export declare const QUEUE_STATUS_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status";
/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
    readonly status: 'waiting' | 'working' | 'error' | 'queue_full';
    readonly queuePosition: number;
    readonly message: string;
}
/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export declare class CodeArtsAdapter extends LlmAdapter {
    private readonly options;
    private readonly fetchImpl;
    private readonly chatId;
    private readonly sessionId;
    constructor(options: CodeArtsAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
     * 入参异常时回退到 PROVIDER 常量，避免客户端抛
     * `undefined.toUpperCase is not a function`。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /**
     * 上报一次**续期失败**，但不让异常冒泡。
     *
     * 为什么吞：`refresh` 回调的失败原因是「续期这条支线」的问题（池内无凭据、
     * refresh_token 缺失、瞬时网络故障），把它原样抛给用户会顶掉**真正的**鉴权
     * 错误、并给出「请重新登录」这类误导性文案。归一语义是：续期失败 → 记一条
     * 警告 → 继续用「续期后能否解析到可用凭据」这一**统一判据**决定报什么错。
     *
     * ⚠️ 走 `warn` 而不是 `debug`：续期失败若被静默，用户侧只看到「突然要重新
     * 登录」，没有任何可排查的线索 —— 那正是本单要消灭的形态。
     */
    private reportRefreshFailure;
    /**
     * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
     * （如直接进入会话），此时同样触发远端拉取。
     */
    private ensureRemoteModels;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
     *
     * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
     * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
     *
     * ⚠️ **必须与 `listModels` 共用同一份可见性过滤**（此处是 VL 多模态屏蔽），
     * 唯一区别就是不套黑名单、不套账号门控。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
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
    private consumeSse;
    /**
     * 查询某个会话的 CodeArts 并发队列状态。该端点
     * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
     * @param credential - 用于签名请求的 AK/SK/SecurityToken。
     * @param model - 模型 id，作为 `model` 查询参数回传。
     * @param signal - 状态请求的取消信号。
     * @returns 解析后的排队状态，或当端点不可达
     *   或返回无法识别的载荷时返回 `undefined`。
     */
    private queryQueueStatus;
}
/**
 * 在 ctx.llm 上注册 codearts 提供商路由和适配器。
 *
 * ⚠️ **返回适配器实例**（不是 `void`）：Account Hub 的「显示列表」需要它的
 * `listAllModels()`（不套用户黑名单、也不套目录门控的完整目录，带最终展示名）。
 * DSH 的 `ctx.llm` 只保证 `listModels`、且会把条目重建后丢掉额外字段，故实例
 * 必须由调用方持有并注入 RPC 层（见 `src/account-hub-rpc.ts` 的 `ModelCatalogSource`）。
 *
 * ## settings 地址由调用方**按契约现算**后传入
 *
 * 目录项的 `settingsNs` / `settingsPath` 两版契约成对不同（0.1.6：
 * `llm-codearts` + `[]`；0.1.7：entry id + `['providers', 'codearts']`），
 * 而**探测只在 `src/index.ts` 的 `apply()` 里做一次**（见 `LlmSettingsAddress`）：
 * 适配器自己不做探测、也不认识契约版本，只把成对地址原样转交 —— 这样它既能在
 * 单测里直接注入地址，也不会因为「每个适配器各探一次」而在同一进程里得到两种答案。
 *
 * 省略 `settingsAddress` 时回退到 **0.1.6 形态**（`llm-codearts` + `[]`）：
 * 那是本 provider 在旧契约下的地址，`src/index.ts` 的 `legacy` 分支算出来的
 * 就是它，故直接调用本函数的单测与旧接线行为逐字一致。
 */
export declare function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter;
/** 判断错误文本是否为频率限制错误 */
export declare function isRateLimited(body: string): boolean;
/**
 * 判断错误文本是否为「账号积分/额度耗尽」。
 *
 * 判据顺序与 {@link isRateLimited} 一致：结构化业务码优先（与语言无关、不受
 * 服务端改文案影响），文案兜底（覆盖 SSE 流内错误与网关裸文本等拿不到 code 的场景）。
 */
export declare function isQuotaExhausted(body: string): boolean;
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
export declare function parseQuotaExhausted(body: string, currentModel: string): {
    modelId: string;
    resetTimeMs: number;
} | null;
/** 从限流错误中提取重置时间 */
export declare function parseRateLimitError(body: string, currentModel: string): {
    modelId: string;
    resetTimeMs: number;
} | null;
//# sourceMappingURL=llm-adapter.d.ts.map