/**
 * LobsterAI（有道龙虾）LLM 适配器。
 *
 * 骨架取自 `src/buddy-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * LobsterAI 与腾讯系只在「OpenAI 兼容 + SSE」这一层相同，其余没有一处能照抄。
 *
 * ## 与 `BuddyAdapter` 的关键差异（逐条对应计划文档 §3.5-C）
 *
 * | 项 | 处理 |
 * |---|---|
 * | URL | `${product.apiBase}/api/proxy/v1/chat/completions` |
 * | 请求头 | 只设 `Authorization` / `Content-Type` / `Accept` / `User-Agent` / `X-LobsterAI-Client-*`；**不设**腾讯系归属头 |
 * | `stream` | **恒为 `true`** —— 上游只支持 SSE，`stream:false` 返回 500 |
 * | `tool_choice` | **不适用**：DSH 的 `GenerateOptions` 无该字段，且 body 由本适配器自建，天然不会出现（Go 桥接层要归一化是因为它转发客户端的原始 body） |
 * | `prompt_cache_key` | **不发** —— 那是腾讯后端的前缀缓存机制，此处未实测支持 |
 * | 思考等级 | **不照抄** buddy 的 deepseek 补档逻辑（那是针对腾讯后端实测的）；仅透传 |
 * | 图片 | **不支持**，`inputModalities` 恒为 `['text']`（判定证据链见 {@link LOBSTERAI_IMAGE_MODALITY_NOTE}） |
 *
 * 可以原样复用的是 `src/sse.ts` 的三个工具函数（`readWithIdleTimeout` /
 * `resolveToolPairing` / `normalizeToolArguments` / `isTruncatedArguments`）——
 * 它们处理的是 **OpenAI 协议层的通用陷阱**，与具体厂商无关。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type LobsteraiCredential } from './lobsterai.js';
import { type LobsteraiProduct } from './lobsterai-product.js';
import type { LlmSettingsAddress } from './types.js';
/** 本适配器注册的 provider 路由名（历史常量，等价于 `LOBSTERAI.id`）。 */
export declare const PROVIDER = "lobsterai";
/**
 * 图片模态**刻意不声明**的判定记录（2026-09-21 取证）。
 *
 * 结论：`inputModalities` 保持 `['text']`，**不补图片出站**。
 * 下面是完整的证据链与取舍，供后来者复核而不是重新猜一遍。
 *
 * ## 已经确证的三件事
 *
 * 1. **远端确实声明图片能力**：真机 `GET /api/models/available` 的
 *    `supportsImage` 在 14 个声明了窗口的模型里 **11 项为 true**（应用日志
 *    `[Auth:getModels] Response data` 逐条可查）。
 * 2. **官方客户端也按多模态用**：`%APPDATA%\LobsterAI\openclaw\state\openclaw.json`
 *    的 `lobsterai-server` 提供者里，同批模型带 `"input": ["text","image"]`，
 *    传输层 `api: "openai-completions"`（`kimi-k3` 还带 `video`）。
 * 3. **协议形态是标准 OpenAI**：装包内 `openclaw` 的
 *    `dist-openai-completions-stream-*.cjs` 把图片块编码为
 *    `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}`
 *    （与 buddy 适配器现在用的形态**逐字节同款**）。
 *
 * ## 为什么仍然不声明（三条独立理由，任一条都足以否决）
 *
 * 1. **我们发不到那个端点**。官方客户端**不直连上游**：它先起一个本地代理
 *    `OpenClawTokenProxy`（应用日志 `started on 127.0.0.1:<port>`），
 *    openclaw 的 `baseUrl` 是 `http://127.0.0.1:<port>/v1`，由该代理注入令牌并
 *    转发到 `{apiBase}/api/proxy/v1`。**图片出站是否被上游 `/api/proxy/v1`
 *    接受，证据全部产生于代理之后的链路**，而我方是直连 —— 「官方能发」推不出
 *    「我们能发」。
 * 2. **没有对上游的直接实测**。上述三条证据里没有一条是「向
 *    `https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions` 发一张
 *    真图并拿到成功响应」。本项目的规矩是「没观察到的东西不猜」——
 *    `reasoning_effort` 当初之所以能接线，是因为有**服务端行为**级的
 *    单变量证据（错值 500、对值 200）；图片没有同等级的样本。
 * 3. **声明错了比不声明更糟**。`stream()` 现在对图片块抛
 *    `UNSUPPORTED_CONTENT`（见下方）。若先声明 `['text','image']` 再补出站，
 *    一旦上游拒绝，用户拿到的会是「选了图片 → 请求失败」，而不是现在这种
 *    「这个模型不吃图」的明确拒绝；更糟的是 DSH 会把图片块**当作已支持**而
 *    路由进这条通道（`src/qoder-adapter.ts` 的注释记着同型教训：
 *    「两处若分叉会让图片被路由进这条**必然丢图**的通道」）。
 *
 * ## 何时可以翻案
 *
 * 拿到「直连上游 + 真图 + 成功响应」的实测样本后：补 `readImage` 桥接
 * （`src/index.ts` 已有 `makeReadImage`，buddy 系在用）、按 `supportsImage`
 * 逐模型给模态、并让 `serializeMessages` 编码 `image_url`。
 * 在那之前，本条与 `stream()` 的拒绝逻辑**必须保持一致**（一处声明、
 * 一处拦截，分叉即静默故障）。
 */
export declare const LOBSTERAI_IMAGE_MODALITY_NOTE = "\u8FDC\u7AEF supportsImage=true \u4F46\u51FA\u7AD9\u672A\u652F\u6301\uFF0C\u4FDD\u5B88\u4E0D\u58F0\u660E";
/**
 * LobsterAI 远端模型条目。
 *
 * ⚠️ **2026-09-19 真机复测推翻了早期注释**。早期版本声称远端只返回
 * `modelId`/`modelName`/`provider`/`apiFormat`（依据是 Go 桥接层的
 * `client.go:254-278`），因此本结构刻意比 `BuddyRemoteModel` 更小。
 * 实测真机响应**还带**这些字段，且它们正是「模型选择器比产品少 / 没有思考档」
 * 两个报障的关键数据：
 *
 * | 真机字段 | 用途 |
 * |---|---|
 * | `modelName` | 展示名（旧表用 id 当展示名，故选择器里全是 `qwen3.7-max` 这种裸 id） |
 * | `contextWindow` | 上下文窗口（`null` 表示上游未给，此时不声明） |
 * | `supportsThinking` | 是否支持思考 |
 * | `thinkingConfig.options[].level` | **可选思考档位**（思考档的权威来源） |
 * | `thinkingConfig.defaultLevel` | 默认档位 |
 *
 * 真机响应条目样例（`deepseek-flash`）：
 * `{modelId, modelName:'DeepSeek-V4.1-Flash', contextWindow:1000000,
 *   supportsThinking:true, thinkingConfig:{options:[{level:'off',openclawLevel:'off'},
 *   {level:'high',openclawLevel:'high'},{level:'max',openclawLevel:'xhigh'}],
 *   defaultLevel:'high'}, requestCapabilities:['lobsterai-options-v1'], ...}`
 */
/**
 * 远端 `thinkingConfig.options[]` 中的一档。
 *
 * **两个字段语义不同，不可混用**（上游 commit 9669ee4 真机定案）：
 * - `level`：**产品侧档位名**（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），
 *   用于 UI 展示与 `defaultLevel` 引用；
 * - `openclawLevel`：**发给服务端的 wire 值**（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`
 *   —— **没有 `max`**），即 `reasoning_effort` 的取值。
 *
 * 实测：远端把 `level: 'max'` 映射到 `openclawLevel: 'xhigh'`。直接发
 * `reasoning_effort: 'max'`（level 值）与不带参数无差异（走服务端默认），
 * 发 `'xhigh'` 才真正触发最高档 —— 因此**线路上必须用 `openclawLevel`**。
 */
export interface LobsteraiThinkingOption {
    /** 产品侧档位名（`defaultLevel` 引用的是这个值）。 */
    level: string;
    /** 发给服务端的 `reasoning_effort` 取值。 */
    openclawLevel: string;
}
/** 远端 `thinkingConfig`：可选档位与默认档位。 */
export interface LobsteraiThinkingConfig {
    options: readonly LobsteraiThinkingOption[];
    /** 默认档位（产品侧 `level` 值，需再经 `options` 映射成 wire 值）。 */
    defaultLevel: string;
}
/**
 * 解析 `thinkingConfig`；结构不符时返回 `undefined`（丢弃而非解析出半截数据）。
 *
 * 严格性对齐 IDE 的 `parseModelThinkingConfig`（`modelThinking.js`）：
 * - `options` 必须是非空数组，每项都要有合法的 `level` 与 `openclawLevel`；
 * - 两者的「是否 off」必须一致（避免 `off` 配一个非 off 的 wire 值）；
 * - 不允许重复档位；
 * - `defaultLevel` 必须存在且落在 `options` 里 —— 否则 DSH 会拿一个
 *   不存在的档位去请求，比不声明更糟。
 *
 * 只有 `off` 一档时视为无档位可选（等价于不支持配置思考），返回 `undefined`。
 */
export declare function parseLobsteraiThinkingConfig(value: unknown): LobsteraiThinkingConfig | undefined;
export interface LobsteraiRemoteModel {
    id: string;
    name: string;
    /** 上下文窗口；真机为 `null` 或缺失时**不声明**（不编造）。 */
    contextWindow?: number;
    /**
     * 可选思考档位（**发给服务端的 wire 值**，由真机
     * `thinkingConfig.options[].openclawLevel` 解析得到，`off` 保留）。
     */
    reasoningEfforts?: readonly string[];
    /** 默认档位（wire 值，由真机 `thinkingConfig.defaultLevel` 经 options 映射）。 */
    defaultReasoningEffort?: string;
}
/**
 * 解析 `GET /api/models/available` 的响应。
 *
 * ⚠️ **响应形状是「统一信封 + data 直接为数组」**，不是双层嵌套：
 * 真机实测 `{code:0, msg:'...', data:[{modelId, modelName, …}, …]}`，
 * 其中 `data` 就是模型数组。
 *
 * 早期实现按 `data.data` 取值（注释写「外层信封 + 内层 data 数组」），
 * 而 `parseLobsteraiEnvelope` 又**明确拒绝数组**（`Array.isArray(data)` 即判失败），
 * 于是这条路径**恒返回空数组** → 适配器永远回退静态兜底表。
 * 这就是「选择器模型比产品少」的根因：远端目录一次都没被真正采用过。
 * 用插件真实解析器对真机响应实测：修前 `0` 条，修后 `27` 条。
 *
 * 兼容性：仍接受旧的 `data.data` 形态（若有代理层包了一层），
 * 但**主路径是 `data` 直接为数组**。
 */
export declare function parseLobsteraiModels(body: unknown): LobsteraiRemoteModel[];
/**
 * 构造模型列表请求的 query 串（keyfrom 身份载荷）。
 *
 * 注意**不含 `refreshToken`** —— `client.go:229-241` 只用了 `KeyfromBody()`
 * 的字段（firstKeyfrom/latestKeyfrom/version/uuid/userId）。
 * 把 refreshToken 放进 query 既是信息泄露（会进服务端访问日志），
 * 也不是该端点的预期输入。
 */
export declare function buildLobsteraiModelsQuery(credential: LobsteraiCredential, clientVersion: string): string;
/** `LobsteraiAdapter` 的构造选项。 */
export interface LobsteraiAdapterOptions {
    credentialRef: CredentialRef;
    /**
     * 从凭据存储解析凭据。
     *
     * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
     * 供多账号池跳过「对该模型仍有限流/积分耗尽标记」的账号。无目标模型的
     * 场景（拉模型目录）省略该参数。
     *
     * `turnIdentity` 是本次请求所属**轮次**的标识对象（`options.signal`），供账号池
     * 实现「切换粒度 = 按轮次」—— 同轮锁同一账号。见 `src/account-consumption.ts`
     * 的 `TurnKeyTracker`（DSH 的 `GenerateOptions` 里没有 turn 级字段）。
     */
    resolveCredential: (model?: string, turnIdentity?: unknown) => Promise<LobsteraiCredential | undefined>;
    /**
     * 静默续期凭据。
     *
     * `model` 与 {@link LobsteraiAdapterOptions.resolveCredential} 同源。**本
     * provider 的接线必须用同一个 model 选号**：`refresh` 是「按账号池选号再
     * 续期该账号」，若它与解析时用的过滤口径不同（例如这里漏传 model），
     * 就会出现「解析到 B、却刷新了 A」——B 的过期 token 永不更新，用户看到
     * 「刚登录好却一直认证失败」而日志全绿（历史上的 S1 缺陷）。
     *
     * `turnIdentity` 同理必须一起透传 —— 它是同一条不变量在「按轮次」档下的形态：
     * 漏传会让续期挑到轮次锁之外的另一个账号，即同一个 S1 缺陷换个触发条件复现。
     */
    refresh: (model?: string, turnIdentity?: unknown) => Promise<void>;
    /** 动态拉取远端模型列表；失败时回退到 `product.fallbackModels`。 */
    fetchRemoteModels?: () => Promise<LobsteraiRemoteModel[]>;
    /** 解析当前客户端版本号（chat 与模型列表都要带）。 */
    resolveClientVersion?: () => Promise<string>;
    fetchImpl?: typeof fetch;
    /** 多账号池（用于限流时切换账号）。 */
    accountPool?: AccountPool;
    /** 产品配置；默认 {@link LOBSTERAI}。 */
    product?: LobsteraiProduct;
    /**
     * 本 provider 目录项的 settings 地址（`settingsNs` + `settingsPath` 成对）。
     *
     * 由 `src/index.ts` 的 `apply()` **按探测到的契约现算**后传入（见
     * `LlmSettingsAddress`）：0.1.6 得 `llm-lobsterai` + `[]`，0.1.7 得 entry id +
     * `['providers', 'lobsterai']`。适配器自己不做探测、也不认识契约版本，只把成对
     * 地址原样转交 `registerConfigurableProviders` —— 这样它既能在单测里直接注入
     * 地址，也不会因「每个适配器各探一次」而在同一进程里得到两种答案。
     *
     * 省略时回退到 **0.1.6 形态**（`llm-lobsterai` + `[]`）：那是本插件迁移前的
     * 既有行为，也让不关心契约的单测保持原样可跑。
     */
    settingsAddress?: LlmSettingsAddress;
}
/** LobsterAI 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export declare class LobsteraiAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 动态模型缓存（首次 listModels 成功后填充）。 */
    private remoteModels;
    /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
    private readonly fallbackIndex;
    constructor(options: LobsteraiAdapterOptions);
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 懒加载远端模型目录（仅拉取一次）。
     *
     * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels`
     * 被调用（如直接从历史会话进入），此时同样需要触发一次拉取。
     */
    private ensureRemoteModels;
    /**
     * 静态兜底模型目录。
     *
     * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：
     * LobsterAI 的远端接口是**权威的**，远端可用时应完全采信，
     * 兜底只在远端整体失败时顶替。
     *
     * 兜底表同样携带 `contextWindow` / `reasoningEfforts`（照抄真机），
     * 故远端失败时思考档与窗口**依然可用**（早期版本因远端恒失败 + 兜底表
     * 无这两个字段，用户永远看不到思考档）。
     */
    private staticFallbackModels;
    /**
     * 按模型 id 取目录条目：远端优先，兜底表兜底。
     *
     * 两个来源都可能缺字段（远端 `contextWindow:null`、兜底表缺项），
     * 故逐字段回退而不是整条替换 —— 远端给了窗口但没给档位时，
     * 仍应能从兜底表补上档位。
     */
    private catalogEntry;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
     *
     * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
     * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
     *
     * ⚠️ 与 `listModels` 的唯一区别就是「不套黑名单、不套门控」——可见性口径
     * （远端优先 / 兜底表）必须同源。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 解析客户端版本号（未注入时用兜底值）。 */
    private clientVersion;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
    /**
     * 消费 SSE 响应并产出 `StreamChunk`。
     *
     * 上游返回标准 OpenAI SSE。移植了 Go 侧 `Aggregate` 的三处兼容处理：
     * 1. **容忍 `data:` 后无空格**（`sse.go:37-39` 注释写明「龙虾上游实测无空格」）——
     *    这里靠 `line.slice(5).trim()` 天然兼容两种形态；
     * 2. `reasoning_content` 单独成块（`sse.go:74-76`）；
     * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
     *
     * 额外保留 buddy 适配器里两条实测得出的防坑规则（与厂商无关，属协议层）：
     * - **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，
     *   直接覆盖会清空已解析出的工具名 → `unknown tool ""`；
     * - **`finish_reason` 映射顺序**：`length` / 中途断流 / 参数残缺一律归为
     *   `max-tokens`，否则 harness 会执行残缺 JSON 参数并污染会话历史。
     */
    private consumeSse;
}
/**
 * 在 `ctx.llm` 上注册 LobsterAI provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到
 * `lobsterai` / `llm-lobsterai`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因
 * 未注册 namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 *
 * ⚠️ **返回适配器实例**（不是 `void`）：Account Hub 的「显示列表」需要它的
 * `listAllModels()`（不套用户黑名单、也不套目录门控的完整目录，带最终展示名）。
 * DSH 的 `ctx.llm` 只保证 `listModels`、且会把条目重建后丢掉额外字段，故实例
 * 必须由调用方持有并注入 RPC 层（见 `src/account-hub-rpc.ts` 的 `ModelCatalogSource`）。
 */
export declare function registerLobsteraiLlm(ctx: Context, options: LobsteraiAdapterOptions): LobsteraiAdapter;
/** 构造远端模型列表请求的完整 URL（供 auth 服务与测试复用）。 */
export declare function buildLobsteraiModelsUrl(product: LobsteraiProduct, credential: LobsteraiCredential, clientVersion: string): string;
/** 模型列表请求超时（与其它控制面请求一致）。 */
export declare const LOBSTERAI_MODELS_TIMEOUT_MS = 30000;
//# sourceMappingURL=lobsterai-adapter.d.ts.map