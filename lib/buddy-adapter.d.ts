/**
 * Buddy 系 (腾讯 Buddy CN / Buddy) LlmAdapter
 *
 * 使用标准 OpenAI Chat Completions 协议 + Bearer access_token 鉴权。
 * 认证由 buddy-auth.ts 服务完成（external-link-v2 轮询式登录 + refresh_token 续期）。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 模型列表：静态默认（对齐 /v3/config craft agent models）+ 登录后的动态拉取
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type ContextTier } from './context-tiers.js';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { BuddyCredential, BuddyRemoteModel } from './buddy.js';
import { type BuddyProduct } from './product.js';
import type { LlmSettingsAddress } from './types.js';
/**
 * Buddy CN（中国版）的 chat completions 基址。
 *
 * 由 `BUDDY_CN.endpoint` 派生（产品配置是唯一真相源）；仅供既有导入方
 * （如 e2e 探针）使用。适配器实例实际请求的基址是
 * `` `${this.product.endpoint}/v2` `` —— 国际版 Buddy 的域名不同
 * （www.workbuddy.ai），故不能再用本常量拼接请求 URL。
 */
export declare const CHAT_API_BASE: string;
/**
 * CodeBuddy 的 provider 路由名（历史常量，保留导出以兼容既有导入方）。
 *
 * 注意：适配器实例实际使用的路由名是 `product.id`（`this.product.id`），
 * 本常量只表示 Buddy CN 那一份取值，不再代表所有产品。
 */
export declare const PROVIDER = "buddy";
/** 默认模型（deepseek-v4-flash，对齐 IDE 默认）。 */
export declare const DEFAULT_MODEL = "deepseek-v4-flash";
export interface BuddyAdapterOptions {
    credentialRef: CredentialRef;
    /** 前缀缓存会话标识（prompt_cache_key）；未提供时随机生成一个。 */
    sessionId?: string;
    /**
     * 从凭据存储解析凭据。
     *
     * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传。
     * 多账号池据此跳过「对该模型仍有限流/积分耗尽标记」的账号，使不可用账号在
     * **发请求之前**就被排除，而不是先发一次必然失败的请求再换号。
     * 拉模型目录（`fetchModels`）等无目标模型的场景省略该参数。
     *
     * `turnIdentity` 是本次请求所属**轮次**的标识对象（`options.signal`），供账号池
     * 实现「切换粒度 = 按轮次」—— 同轮锁同一账号。见 `src/account-consumption.ts`
     * 的 `TurnKeyTracker`（DSH 的 `GenerateOptions` 里没有 turn 级字段）。
     */
    resolveCredential: (model?: string, turnIdentity?: unknown) => Promise<BuddyCredential | undefined>;
    /**
     * 静默续期凭据。
     *
     * `model` 与 {@link BuddyAdapterOptions.resolveCredential} 同源（同样由
     * `stream()` 从 `options.model` 透传），供「按账号池选号再续期」的实现
     * （如 LobsterAI 的 `refresh`）保持与选号一致的口径。默认单凭据路径忽略它。
     *
     * `turnIdentity` 同理必须一起透传：续期与解析必须挑到**同一个**账号。
     */
    refresh: (model?: string, turnIdentity?: unknown) => Promise<void>;
    /** 动态拉取远端模型列表（含上下文窗口与能力，若远端下发）；失败时调用方回退到静态列表。 */
    fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>;
    /**
     * 读取一张图片的原始字节（图片输入必需）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`。**失败必须抛错**：
     * 未提供本回调时适配器会报 UNSUPPORTED_CONTENT；提供了但读不到字节时
     * 也必须抛错（不要返回 undefined），否则图片会被静默丢弃、线上请求
     * 退化成纯文本，而用户看不到任何原因。
     *
     * 返回类型刻意不含 `undefined`——早期契约允许返回 undefined 表示
     * 「读不到」，调用方据此 `continue`，正是静默丢图的源头。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    fetchImpl?: typeof fetch;
    /** 多账号池（用于限流时切换账号） */
    accountPool?: AccountPool;
    /**
     * 产品配置；默认为 Buddy CN。
     *
     * 决定请求身份标识（X-Product-Code / User-Agent）、模型元数据的 provider
     * 字段、providerInfo 的展示名，以及 registerBuddyLlm 注册的路由与
     * settingsNs。两个内置产品（Buddy CN / Buddy）共用同一后端与协议，
     * 差异全部由本配置承载。
     */
    product?: BuddyProduct;
    /**
     * 本 provider 目录项的 settings 地址（namespace + 分槽路径）。
     *
     * 两版契约成对不同（0.1.6：`llm-buddy-cn` + `[]`；0.1.7：entry id +
     * `['providers', 'buddy-cn']`），且**探测只在 `src/index.ts` 的 `apply()` 里
     * 做一次**（见 `LlmSettingsAddress`）：适配器不做探测、也不认识契约版本。
     * 省略时回退 **0.1.6 形态**（`llm-<product.id>` + `[]`），与历史行为逐字一致。
     */
    settingsAddress?: LlmSettingsAddress;
}
/** Buddy 系 (腾讯 Buddy CN / Buddy) 模型适配器。使用 Bearer access_token 鉴权。 */
export declare class BuddyAdapter extends LlmAdapter {
    private readonly options;
    /** 本适配器所属的产品配置（默认 Buddy CN）。 */
    private readonly product;
    private readonly fetchImpl;
    /**
     * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
     * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
     */
    private readonly sessionId;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
    private remoteMeta;
    /** 远端下发的模型上下文窗口（**最大档**：min(maxInputTokens, 档位表最大档)）。 */
    private remoteContextWindows;
    /**
     * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
     * 远端缺失时补位；构造时一次性建立，只读。
     */
    private readonly productFallbackIndex;
    /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
    private readonly productFallbackContextWindows;
    constructor(options: BuddyAdapterOptions);
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
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
     * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
     */
    /**
     * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
     * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
     * 触发一次远端拉取，保证远端的上下文窗口（最大档）能生效。
     */
    private ensureRemoteModels;
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
    private reconcileWithFallback;
    /**
     * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
     *
     * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
     * 实测 `glm-5.1`（2026-09）：
     * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
     * - `/v3/config` → `supportsImages: true`
     * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
     *
     * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
     * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
     * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
     *
     * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
     * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
     * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
     * 必须先有真实请求证据。
     */
    private static readonly IMAGE_CAPABILITY_OVERRIDES;
    /**
     * 模型接受的输入模态：远端 supportsImages 优先，静态表兜底；
     * {@link IMAGE_CAPABILITY_OVERRIDES} 中的模型强制为支持图片。
     */
    private inputModalitiesFor;
    /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
    private effortsFor;
    /**
     * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
     *
     * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
     * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
     */
    private defaultEffortFor;
    /**
     * 产品级兜底模型目录（`product.fallbackModels`）。
     *
     * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
     * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
     */
    private get productFallbackMeta();
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
     *
     * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
     * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。同名消歧的
     * 展示名也要在这里算出来，否则回填行只能显示裸 id。
     *
     * ⚠️ 与 `listModels` 的唯一区别就是「不套黑名单、不套门控」——可见性口径
     * （远端优先 / 兜底表）必须同源。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
     *
     * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
     * token 未必能取到完整集合（实测 Buddy 经 CLI token 只能拿到
     * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
     */
    private staticFallbackModels;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
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
    contextTiers(): Promise<ReadonlyMap<string, ContextTier>>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
    /**
     * 消费 SSE 响应并产出 StreamChunk。
     *
     * Buddy 返回标准 OpenAI SSE：`delta.content` 为正文、
     * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
     * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
     * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
     */
    private consumeSse;
}
/**
 * 在 ctx.llm 上注册 Buddy 系产品的 provider 路由与适配器。
 *
 * 路由名与配置页展示名由产品配置驱动：Buddy CN 得到 `buddy-cn`，Buddy 得到
 * `buddy`。
 *
 * ## settings 地址由调用方**按契约现算**后传入
 *
 * 目录项的 `settingsNs` / `settingsPath` 两版契约成对不同（0.1.6：
 * `llm-<id>` + `[]`；0.1.7：entry id + `['providers', <id>]`），而**探测只在
 * `src/index.ts` 的 `apply()` 里做一次**（见 `LlmSettingsAddress`）：适配器自己
 * 不做探测、也不认识契约版本，只把成对地址原样转交 —— 这样它既能在单测里直接
 * 注入地址，也不会因为「每个适配器各探一次」而在同一进程里得到两种答案。
 * 地址必须与 `src/index.ts` 注册/投影出的 namespace 一致，否则模型设置页会因
 * 未注册 namespace 崩溃。
 *
 * @returns 刚注册的适配器实例 —— `src/index.ts` 把它转交给 `registerAccountHubRpc`，
 *          供 Account Hub 读取逐模型的窗口档位（`contextTiers`）与校验用户选择。
 *          适配器是**模型目录的唯一持有者**，RPC 层拿不到目录就只能靠猜
 *          （与 `registerTraeCnLlm` / `registerQoderLlm` 同一约定）。
 */
export declare function registerBuddyLlm(ctx: Context, options: BuddyAdapterOptions): BuddyAdapter;
//# sourceMappingURL=buddy-adapter.d.ts.map