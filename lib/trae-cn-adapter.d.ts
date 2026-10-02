/**
 * Trae CN（字节跳动 Trae 国内版）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * Trae CN 与其它四条线只在「消息结构」这一层相同（OpenAI chat-completions 的消息
 * 数组），其余没有一处能照抄 —— 最本质的是 **SSE 是具名事件流**
 * （`event:output` 而非 `data:{"choices":[...]}`），且**业务失败发生在 HTTP 200 的
 * `event:error` 帧里**。后者决定了本适配器与 lobsterai 在结构上的根本差异：
 * **换号循环必须能接住流内抛出的限流错误**，否则多账号切换在这个 provider 上
 * 等于没实现（lobsterai 的错误都在 `!response.ok` 分支里，流一旦开始就没有换号的
 * 余地）。
 *
 * ## 与其它 provider 的关键差异
 *
 * | 项 | 处理 |
 * |---|---|
 * | 鉴权 | `Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` |
 * | `stream` | **恒为 `true`** —— chat 端点只返回 SSE |
 * | 错误判定 | **按 SSE 业务码**，不按 HTTP 状态码（几乎恒为 200），见 `src/trae-cn-errors.ts` |
 * | 端点 | **SOLO 通道** `TRAE_CN_IDE_API_BASE` + `TRAE_CN_CHAT_PATH`（`/api/agent/v3/llm_utils_chat`） |
 * | body | `model` + **`config_name`（= model）** + **`function`（模型来源 function）**，见 `buildBody` |
 * | 网关头 | 见 `src/trae-cn-models.ts` 的 `traeCnSoloHeaders`（与目录拉取共用一份） |
 * | 目录 | **动态 `get_detail_param`（按 function 取并集）+ 静态 11 项回退**，见 `ensureRemoteModels` |
 * | 图片 | **按模型给**：静态表 11 项里 6 项多模态 → `['text','image']`，其余 `['text']` |
 * | 思考等级 | **声明档位**（静态表 8/11 项按 id 补回；SOLO 目录端点不提供档位，见 `applyTraeCnStaticMetadata`），下发字段名 `reasoning_effort_level` |
 *
 * 可原样复用的只有 `src/sse.ts` 的工具函数（它们处理的是 harness 侧的协议层
 * 陷阱，与厂商无关）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import type { LlmSettingsAddress } from './types.js';
import type { TraeCnCredential } from './trae-cn-oauth.js';
import type { TraeCnProduct } from './trae-cn-product.js';
import type { TraeCnModelEntry } from './trae-cn-models.js';
/** 本适配器注册的 provider 路由名（等价于 `TRAE_CN.id`）。 */
export declare const PROVIDER = "trae-cn";
/**
 * Max 档出站所需的窗口明细（由调用方逐模型解析后实参下发）。
 *
 * 只携带「该模型自己的 Max 档窗口」：输出上限**不在**这里 —— 本仓没有与
 * upstream/master 的 `__max` 明细对应的独立输出声明（`TraeCnModelEntry.maxTokens`
 * 是 dev 明细的 `max_tokens`，多为 32000/64000，不是 Max 会话的输出上限），
 * 臆造会违反「值以 upstream/master 为准」。故 Max 档的 `max_tokens` 走
 * {@link TRAE_CN_MAX_OUTPUT_TOKENS}（64K）兜底，或由调用方显式 `options.maxTokens`
 * 覆盖。
 */
interface TraeCnMaxModeOutbound {
    /** 该模型声明的 Max 窗口（远端 `maxContextWindow`）。 */
    maxContextWindow: number;
}
/**
 * 一个模型在**当前生效目录**里的上下文窗口档位。
 *
 * 只出现在 Trae CN（IDE 路径）：它走动态 `get_detail_param` 目录，部分模型下发
 * `context_window_tokens: {dev, max}` 两档。其余 provider 的适配器不产出本结构，
 * 故 Account Hub 的档位选择列**只会在 Trae CN 面板出现**（Work 侧实测 dev==max，
 * 被解析侧判成「无 Max 档」，同样不渲染）。
 */
export interface TraeCnContextTier {
    /**
     * dev 档：目录公布的默认窗口（`context_window_tokens.dev`，回退 `prompt_max_tokens`）。
     *
     * ⚠️ **dev 优先**是 2026-09-21 统一的口径（早前反向）—— 上游两个字段给的是
     * 不同的数（真机 `glm-5.3`：dev `200000` / `prompt_max_tokens` `168000`），
     * 而官方客户端按 dev 显示 `200K`。取 dev 是为了让两边显示同一个数，
     * 详见 `parseTraeCnDirectory`。
     */
    contextWindow?: number;
    /** Max 档：**仅当严格大于 dev 档**时才存在（见 `TraeCnModelEntry.maxContextWindow`）。 */
    maxContextWindow?: number;
}
/** `TraeCnAdapter` 的构造选项。 */
export interface TraeCnAdapterOptions {
    credentialRef: CredentialRef;
    /**
     * 从凭据存储解析凭据。
     *
     * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
     * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。无目标模型的场景
     * （拉模型目录）省略该参数。
     *
     * `turnIdentity` 是本次请求所属**轮次**的标识对象（`options.signal`），供账号池
     * 实现「切换粒度 = 按轮次」—— 同轮锁同一账号。见 `src/account-consumption.ts`
     * 的 `TurnKeyTracker`（DSH 的 `GenerateOptions` 里没有 turn 级字段）。
     */
    resolveCredential: (model?: string, turnIdentity?: unknown) => Promise<TraeCnCredential | undefined>;
    /**
     * 静默续期凭据。
     *
     * `model` 与 {@link TraeCnAdapterOptions.resolveCredential} 同源。**必须用同一个
     * model 选号**：`refresh` 是「按账号池选号再续期该账号」，若它与解析时用的过滤
     * 口径不同（例如这里漏传 model），就会出现「解析到 B、却刷新了 A」—— B 的过期
     * token 永不更新，用户看到「刚登录好却一直认证失败」而日志全绿（历史上的 S1
     * 缺陷，回归测试见 `tests/unit/lobsterai-wiring.spec.ts`）。
     *
     * `turnIdentity` 同理必须一起透传 —— 同一条不变量在「按轮次」档下的形态。
     */
    refresh: (model?: string, turnIdentity?: unknown) => Promise<void>;
    /**
     * 注入的目录拉取器；**省略时用内置的 `fetchTraeCnDirectory`**
     * （`POST /api/ide/v1/get_detail_param`，按 function 取并集）。
     *
     * 之所以仍留这个口子：
     * - 测试要能在零网络下替换它；
     * - `src/account-probe.ts` 要能**关掉**目录拉取（传 `async () => []` —— 探测只该
     *   发一次 chat，不该顺带打两个目录请求）。
     *
     * 返回空数组或抛错都等价于「目录不可用」→ 回退静态表。
     */
    fetchRemoteModels?: (credential: TraeCnCredential) => Promise<TraeCnModelEntry[]>;
    fetchImpl?: typeof fetch;
    /**
     * 读取图片附件的原始字节（内联为 `data:` URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`（见 `src/index.ts` 的
     * `makeReadImage(ctx)`）。未提供时收到图片会报 `UNSUPPORTED_CONTENT`（而
     * 不是静默丢弃）—— 见 `stream()` 的图片分支。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 多账号池（用于限流时切换账号）。 */
    accountPool?: AccountPool;
    /** 产品配置；默认 `TRAE_CN`。 */
    product?: TraeCnProduct;
    /**
     * 本 provider 目录项的 settings 地址（`settingsNs` + `settingsPath` 成对）。
     *
     * 由 `src/index.ts` 的 `apply()` **按探测到的契约现算**后传入（见
     * `LlmSettingsAddress`）：0.1.6 得 `llm-trae-cn` + `[]`，0.1.7 得 entry id +
     * `['providers', 'trae-cn']`。适配器自己不做探测、也不认识契约版本，只把成对
     * 地址原样转交 `registerConfigurableProviders` —— 这样它既能在单测里直接注入
     * 地址，也不会因「每个适配器各探一次」而在同一进程里得到两种答案。
     *
     * 省略时回退到 **0.1.6 形态**（`llm-trae-cn` + `[]`）：那是本插件迁移前的
     * 既有行为，也让不关心契约的单测保持原样可跑。
     */
    settingsAddress?: LlmSettingsAddress;
}
/** Trae CN 模型适配器。使用 `Cloud-IDE-JWT` 鉴权，仅支持 SSE。 */
export declare class TraeCnAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /** 动态目录缓存（含拉取时刻，用于 TTL 判定）。 */
    private catalog;
    /** 静态回退目录索引（id → 条目）。 */
    private readonly fallbackIndex;
    constructor(options: TraeCnAdapterOptions);
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
     * 确保目录就绪（带 TTL）。
     *
     * `listModels` / `resolveModel` / `stream` 三处都会调用：`resolveModel` 可能先于
     * `listModels` 被调用（如直接从历史会话进入），`stream` 需要它来解析
     * `function` 路由（见 {@link functionForModel}）。
     *
     * ## 缓存策略（参照 LobsterAI 的 `clientVersion` 12h 缓存先例）
     *
     * - **成功**：写缓存 + 记时刻，{@link TRAE_CN_MODELS_TTL_MS} 内不再拉取；
     * - **失败/空**：**不写缓存**（下一次调用重试），也不清掉已有缓存 ——
     *   一次网络抖动不该把目录打回静态表；
     * - 拉取本身按「当前凭据」进行，故没有凭据时直接跳过（回退静态表）。
     *
     * 并发调用会各自触发一次拉取（没有 in-flight 去重）：目录拉取是幂等 GET 语义的
     * POST，重复一次的代价远小于引入一个需要处理的共享 Promise 状态。
     */
    private ensureRemoteModels;
    /** 当前生效的目录（动态优先，失败回退静态表）。 */
    private catalogEntries;
    /**
     * 模型接受的输入模态 —— **逐模型**判定，判据优先级：
     *
     * 1. 目录条目的 `multimodal`（`display_config.multimodal`，**实时权威**，
     *    见 {@link TraeCnModelEntry.multimodal} 的实测记录）；
     * 2. 否则回退条目的 `supportsImages`（静态表兜底 / 解析重塑的现场值）。
     *
     * 三条结论：
     * - `multimodal === true` → `['text','image']`；
     * - `multimodal === false` → `['text']`（远端**明确声明不支持**，权威拒绝）；
     * - `multimodal` **未声明** → 回退 `supportsImages`；两者皆非 true 则保守
     *   判 `['text']`（远端没说 ≠ 远端支持）。
     *
     * ⚠️ **这里返回的 `image` 是 DSH 的准入闸门**：不声明 `image` 时，图片会在
     * **附件入库阶段**就被拒（`session/attachment-invalid`），用户看到「当前模型
     * 不支持图片」—— 而图根本没发到上游。因此漏报 `image` 不只是「少个功能」，
     * 而是「连降级成文本占位符的机会都没有」。
     */
    private inputModalitiesFor;
    /**
     * 目标模型应当用哪个 `function` 下发。
     *
     * ## 为什么必须逐模型记来源
     *
     * roster 被 Trae 摊在多个 SOLO function 下，而**一个模型只在其来源 function 下
     * 可调**：`glm-5.3` 不在 `solo_work_lite` 集里，写死 lite 必回
     * `4001 param is invalid`（真机实测）。故动态目录条目自带 `function`，
     * 静态回退条目一律映射到 {@link TRAE_CN_SOLO_REMOTE_FUNCTION}（11 项实测全在
     * remote 集内）。
     *
     * 表外模型（用户手输 / 历史会话里的旧 id）同样回退 remote —— 那是覆盖最广的
     * function，且与静态表口径一致。**表外 id 会恒回 `4001`**（网关按 `config_name`
     * 找不到配置），故错误路径上会补一句可读提示（见 {@link withOffCatalogHint}）。
     */
    private functionForModel;
    /**
     * 目标模型是否在**当前生效的目录**里（动态优先，回退静态表）。
     *
     * 用途只有一个：区分「模型不在可用目录中」与「其它 `4001`」——
     * 前者换目录/重选即可解决，后者是请求形态问题。判定与
     * {@link functionForModel} **同源同口径**（同一个 `catalogEntries()`），
     * 否则会出现「路由按表外处理、提示却按表内给」的自相矛盾。
     */
    private isModelInCatalog;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
     *
     * 供 Account Hub 的「显示列表」使用：设置页必须始终能看到**全部**模型（含被
     * 用户关闭的那些），否则关掉之后连开关都找不到、更无法重新打开。
     *
     * ⚠️ 与 `listModels` 的唯一区别就是「不套黑名单、不套门控」——可见性口径
     * （动态目录优先 / 静态表兜底）必须同源，故同样走 {@link catalogEntries}。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 当前生效目录的逐模型上下文窗口档位（id → dev / Max）。
     *
     * 用途有两个，都必须与 `listModels` / `resolveModel` **同源同口径**：
     * 1. Account Hub 的「显示列表」据此渲染档位单选列（只有 Max 档存在才渲染）；
     * 2. `model.setContextBudget` 据此**校验**用户提交的 window（必须精确等于 dev 或 max 之一）。
     *
     * 三处读的都是同一个 {@link catalogEntries}，否则会出现「UI 上有 Max 档、
     * 切过去却不生效」这种自相矛盾。
     */
    contextTiers(): Promise<ReadonlyMap<string, TraeCnContextTier>>;
    /**
     * 该模型**本次应当声明的上下文窗口**（dev 档，或用户选中的 Max 档）。
     *
     * ## 机制：声明值与出站字段集**同源**联动（2026-09-19 起不再只是声明值切换）
     *
     * 选择档位**双重生效**：
     * - **声明值**：我们向 DSH 声明的窗口从 dev 换成该模型自己公布的 Max ——
     *   决定宿主何时压缩（阈值 `0.8 × 窗口`）与压缩后的保留预算；
     * - **出站字段**：当命中 Max 档时，`buildTraeCnSoloBody` 会成套携带 Max 字段集
     *   （`model_auto_selection` / `model_selection_strategy` / `mode_type` /
     *   `context_window_size` / `prompt_max_tokens` / `max_tokens`，见
     *   {@link TraeCnAdapter.maxModeOutboundFor}），否则上游按 200K 校验并拒绝 1M 输入。
     *
     * ## 判据：预算值必须**精确命中**目录公布的档位（两条缺一不可）
     *
     * 1. `maxContextWindow` 存在且**严格大于** dev 档（解析侧已保证，这里再判一次，
     *    防手工构造的条目）；
     * 2. 池里存的预算**恰好等于**那个 Max 档。
     *
     * 其余一切情况都退回 dev 档：未设置、预算 == dev、预算是编造值、
     * 目录漂移后旧预算失效（模型下线或 Max 档改值）、以及 max 缺失的模型被写入任意预算。
     * **编造值静默退回默认档是设计**，不是遗漏 —— 用户设置永远不能凭空造出一个
     * 上游不认的窗口；而静默（不报错）是刻意的：回归默认档是安全方向，
     * 报错只会让历史会话在目录浮动后突然打不开。
     */
    private effectiveContextWindow;
    /**
     * 当前请求目标模型**本次是否命中 Max 档**，命中则给出出站所需的 Max 窗口/输出明细。
     *
     * 与 {@link effectiveContextWindow} **同源同口径**（读同一条目、同一个预算判据），
     * 保证「选中的档位」在声明值（DSH 压缩阈值）与出站字段集（上游准入校验）两处
     * **永远一致**。返回 `undefined` = 非 Max 档（dev / 编造值 / 无 Max 档模型），
     * 此时出站请求体保持现状、一个字段都不注入。
     */
    private maxModeOutboundFor;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 若本次失败是 `4001` 且目标模型**不在当前目录**里，给错误文案补一句可读提示。
     *
     * 只处理 `4001`：`4023`（模型不存在）上游自带语义、文案已够清楚；`4001` 则
     * 与「请求形态错误」共用同一句话，用户无法自行区分（见
     * {@link TRAE_CN_OFF_CATALOG_HINT}）。
     *
     * 判定用 {@link isModelInCatalog}，与 `function` 路由**同源** —— 两处若用不同
     * 口径，会出现「路由已按表外处理、提示却说模型在表里」的自相矛盾。
     */
    private withOffCatalogHint;
    /**
     * 消费一次流，并把 outcome 写进调用方给的 cell。
     *
     * 为什么用 cell 而不是生成器的 `return` 值：`for await` 会**丢弃** `return` 值
     * （只保留 `break`/`throw` 语义），所以 outcome 必须走旁路。cell 由调用方分配，
     * 每次尝试一个 —— 用实例字段会在嵌套/并发调用时串号。
     */
    private consumeInto;
    /** 上一次 {@link consume} 的 outcome（生成器的 return 值无法经 `for await` 传出）。 */
    private lastOutcome;
    /**
     * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
     *
     * 只对 `recordsTraeCnCooldown` 认可的码记录，即**换号类**的限流 / 额度 / 风控码。
     *
     * **退避类（软限流 / 排队）刻意不记**，这是功能性的取舍而非遗漏：
     * 冷却标记的作用是让 `getAvailableAccount` 在**下一次选号时跳过该账号**，
     * 而退避的语义恰恰是「不换号、稍后重试同一个账号」。若给 4007 / 4000005 记上
     * 标记，DSH 重试时账号池会把该账号过滤掉、改用另一个账号 —— 那就等于偷偷换号，
     * 与用户确认的「排队不换号」决策相矛盾（排队是全局状态，换号无益）。
     *
     * 账号失效码（1001/1002/4010/4014）同理不记：唯一的解法是重新登录，
     * 给它记一个「等待重置」的徽章是虚假信息（详见 `trae-cn-errors.ts`）。
     */
    private recordCooldown;
    /** 构造 chat 请求体（SOLO 通道形态）。 */
    private buildBody;
    /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
    private send;
}
/**
 * 构造 SOLO 通道的 chat 请求体（**导出的纯函数，便于逐字段单测**）。
 *
 * ## 实测定案的形态（2026-09-19）
 *
 * ```js
 * { messages, model, config_name: model, function, stream: true, tools?, reasoning_effort_level? }
 * ```
 *
 * 与旧 IDE 通道的差异逐项如下，每一条都是「写错就静默失败」的那类：
 *
 * | 项 | 旧 IDE 通道 | **SOLO 通道** |
 * |---|---|---|
 * | `config_name` | 无 | **必填，等于 `model`**（网关按它选配置） |
 * | `function` | 无 | **必填，模型来源 function**（写错必 `4001`） |
 * | 消息 `content` | 字符串 | **`[{type:'text',text}]` 数组** |
 * | `role:"developer"` | 无此角色 | **改写为 `"system"`**（上游不认 developer） |
 * | assistant 的 `tool_calls[].function` | `function` | **改名 `function_call`**（无 er） |
 * | `role:"tool"` | 带 `tool_call_id` | 同左（上游缺它会 400 整条请求） |
 * | `tools[].function.parameters` | 对象 | **JSON 字符串** |
 *
 * ## 消息来源
 *
 * 复用 `serializeTraeCnMessages`（它已处理两条通用协议要求：剔除无法配对的
 * tool_call / tool-result、assistant 正文为空且有 tool_calls 时 `content` 为
 * `null`），再在其结果上做**出站形态改写**。SSE 解析侧**不动** ——
 * `function_call` 是出站改名，入站帧里仍是 `function`。
 *
 * ## 思考字段名维持 `reasoning_effort_level`（**刻意不盲改**）
 *
 * SOLO 通道的第三方可用实现下发的是 `reasoning_effort`，但那是 **SOLO 代际**的
 * 写法，**未做 A/B 验证**；而 `reasoning_effort_level` 有 chat_v3 代际的
 * 三方互证（官方 bundle 的 `resolveReasoningEffortRequestField` + `sT` +
 * `ai_agent.dll` 的 serde 字段块，见 README）。在拿到「同一请求两种字段名哪个
 * 真生效」的对比证据之前，**不因为换了端点就改字段名** —— 那是把一条有证据的
 * 结论换成一条没有证据的猜测。值域 `light` / `high` / `extra_high` 不变。
 *
 * @param options - harness 的生成选项。
 * @param functionName - 目标模型的来源 function（见 `TraeCnAdapter.functionForModel`）。
 * @param imageUrls - 本请求图片附件 → data URL 的映射（见 `serializeTraeCnMessages` 的
 *   `imageUrls` 参数）；`undefined` 表示整个请求**无图**（无图请求的出站形态保持不变）。
 * @param maxMode - 目标模型**本次命中 Max 档**时的出站明细（见
 *   `TraeCnAdapter.maxModeOutboundFor`）。`undefined` = 非 Max 档，此时本函数
 *   不注入任何档位字段、出站形态与历史基线**逐字节一致**（既有逐字节锁死用例
 *   据此保持绿）。
 */
export declare function buildTraeCnSoloBody(options: GenerateOptions, functionName: string, imageUrls?: ReadonlyMap<string, string>, maxMode?: TraeCnMaxModeOutbound): string;
/**
 * 在 `ctx.llm` 上注册 Trae CN provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到 `trae-cn` /
 * `llm-trae-cn`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因未注册
 * namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 *
 * @returns 刚注册的适配器实例 —— `src/index.ts` 把它转交给 `registerAccountHubRpc`，
 *          供 Account Hub 读取逐模型的窗口档位（`contextTiers`）与校验用户选择。
 *          适配器是**动态目录的唯一持有者**，RPC 层拿不到目录就只能靠猜。
 */
export declare function registerTraeCnLlm(ctx: Context, options: TraeCnAdapterOptions): TraeCnAdapter;
export {};
//# sourceMappingURL=trae-cn-adapter.d.ts.map