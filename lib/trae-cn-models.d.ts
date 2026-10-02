/**
 * Trae CN（字节跳动 Trae 国内版）**SOLO 通道**的模型目录与网关请求形态。
 *
 * ## 为什么单独成模块（而不是塞进适配器）
 *
 * 本模块同时被**两个**消费者使用：`src/trae-cn-adapter.ts`（chat）与它自己的
 * **目录拉取**（`get_detail_param`）。两者共用同一套网关头，而适配器又必须
 * import 本模块的静态表 —— 若把头构造器留在适配器里，目录拉取就会形成
 * `models → adapter → models` 的循环。故「SOLO 通道的请求形态」在这里成篇：
 * 目录解析、目录拉取、静态回退表、头构造器四件事。
 *
 * ## 端点迁移（2026-09-19 五轮真机取证定案）
 *
 * chat 端点已从旧 aiserver 通道 `/api/ide/v1/chat` 迁到
 * **SOLO 通道 `/api/agent/v3/llm_utils_chat`**。旧通道的 `llm_raw_chat` 场景
 * 只有 5 项旧池，我方请求恒回 `3003 all models failed`，历史零成功；真实客户端的
 * 新池聊天走 `harness.dll` 原生链路（第三方无法复刻），而 SOLO 通道**已用我方
 * 凭据实测走通**（`glm-5.2` 流式正常、`glm-5.3` + tools 结构化调用全绿，HTTP 200 SSE）。
 * host 不变（仍是 {@link TRAE_CN_IDE_API_BASE}），凭据不变。
 *
 * **决定成败的是端点 + body 的 `config_name` / `function` 两字段**（头集合差异
 * 已排除：网关对多余头宽容）。
 *
 * ## 目录：动态拉取 + 静态回退
 *
 * 旧记载「模型目录刻意走静态表、远端不可接」**已作废**：当时试的是
 * `model_list` / `batch_get_detail_param` 等端点，它们确实只回旧池；真正可用的是
 * **`POST /api/ide/v1/get_detail_param`**，按 `function` 分别拉取后取并集。
 *
 * ## 档位（dev/Max）的数据源已换成 remote v1 的 agent 组（2026-09-21）
 *
 * `get_detail_param` 曾对部分模型下发 `context_window_tokens:{dev,max}`，但**现在
 * 只对 `custom_model_*` BYOK 项下发 max**（那些项全被过滤网剔除）⇒ 档位列在真机上
 * 没有数据。本模块因此在同一刷新周期里**额外**拉一次 `GET /api/remote/v1/models`
 * 的 `solo_agent_remote` 组，把它的 `max_mode` / `context_window_tokens.max`
 * 合并进 IDE 目录条目（**只补 `maxContextWindow`，绝不新增条目**）。
 * 详见 {@link parseTraeCnAgentTiers} 与 {@link applyTraeCnAgentTiers}。
 */
import type { TraeCnCredential } from './trae-cn-oauth.js';
/**
 * CN 区**优先** function（41 项，用户可调的模型基本都在这里）。
 *
 * 静态回退表的 11 项**全部**映射到本 function —— 实测确认它们在
 * `solo_work_remote` 集内，而 `glm-5.3` 等模型**不在** lite 集里（写死 lite 必
 * `4001 param is invalid`）。
 */
export declare const TRAE_CN_SOLO_REMOTE_FUNCTION = "solo_work_remote";
/**
 * CN 区**次级** function（`solo_work_lite`）。
 *
 * 它列出的项里混有内部 agent 项（见 {@link isInternalTraeCnConfig}），故只在
 * `solo_work_remote` 拉取失败时作为兜底来源（见 {@link mergeTraeCnDirectory}）。
 */
export declare const TRAE_CN_SOLO_LITE_FUNCTION = "solo_work_lite";
/** CN 区目录 function 的拉取顺序（**优先级即数组顺序**，remote 优先）。 */
export declare const TRAE_CN_SOLO_FUNCTIONS: readonly string[];
/**
 * 目录缓存 TTL（毫秒，12 小时）。
 *
 * 与 LobsterAI 的 `clientVersion` 缓存同一口径（那边也是 12h）：目录变化极慢，
 * 而 `listModels` / `resolveModel` / `stream` 都会触发一次「确保目录就绪」，
 * 没有 TTL 就只能进程级缓存一次，有了 TTL 则长会话也能自愈到新模型。
 */
export declare const TRAE_CN_MODELS_TTL_MS: number;
/**
 * SOLO 通道的 `User-Agent`：`Trae/<SOLO 代际版本>`。
 *
 * 与旧 IDE 通道的 `TraeClient/TTNet` **不是一个值** —— 那是旧通道实测的 UA。
 * SOLO 通道的 UA 与**版本头同代际**：实机验证过的成功组合是
 * `x-ide-version-code: 20260820` + `x-ide-version: 0.1.61` + **`User-Agent: Trae/0.1.61`**，
 * 故版本号取 {@link TRAE_CN_SOLO_IDE_VERSION}（`0.1.61`），**不是**签到线的
 * `TRAE_CN_APP_VERSION`（`3.3.102`）—— 后者属另一条协议线，混用会让 UA 与版本头
 * 自相矛盾（迁移前本常量确实取的是它，属于「顺手复用」而非实测值）。
 *
 * 形态前缀仍取 {@link TRAE_CN_USER_AGENT_PREFIX}（`Trae/`，那才是实测的形态本身）。
 */
export declare const TRAE_CN_SOLO_USER_AGENT = "Trae/0.1.61";
/**
 * SOLO 通道的 `x-plugin-channel`（实测值）。
 *
 * 它声明「请求来自 iCube 插件通道」，与 `x-app-id` 一样属于**客户端形态标识**：
 * 不是遥测字段，缺了会让网关按另一种形态归因。
 */
export declare const TRAE_CN_PLUGIN_CHANNEL = "icube-ai";
/** 目录请求体（`function` 由调用方按 function 填入，其余为实测定案的固定值）。 */
export declare const TRAE_CN_DIRECTORY_BODY: Readonly<Record<string, unknown>>;
/**
 * 目录里**明确已知的内部项**（不是用户可调的模型）。
 *
 * 这些 id 出现在 SOLO 目录里，但它们是 agent 内部构件（摘要、文件检索子代理、
 * 浏览器/电脑操作子代理），选中即路由到不存在的能力上。逐个点名而不是只靠
 * 模式匹配：名字是实测观察到的，写死才有回归价值。
 */
export declare const TRAE_CN_INTERNAL_CONFIG_NAMES: readonly string[];
/**
 * 判定目录项是否为**内部 agent 项**（应当从模型目录里剔除）。
 *
 * ## 两道判据，宁可保守
 *
 * 1. **点名**（{@link TRAE_CN_INTERNAL_CONFIG_NAMES}）；
 * 2. **形态**（id 里含 `agent` / `subagent`）。
 *
 * 反向证据（为什么敢用形态判据）：实测 roster 里**用户可调的项要么两个 function
 * 都在集、要么 remote 独有**，而真机 16 项静态表里没有任何一个 id 含 `agent`。
 * 因此「含 agent」在当前 roster 上等价于「内部项」，不会误杀用户可调的模型。
 *
 * 取**保守**方向（宁可多过滤）：多列一个内部项，用户选中后拿到的是一个语义错乱
 * 的回复；少列一个真模型，用户只是看不到它（静态表仍会补上那 11 项）。
 */
export declare function isInternalTraeCnConfig(id: string): boolean;
/**
 * 判定目录项是否为**账号私有自定义模型**（应当从模型目录里剔除）。
 *
 * ## 为什么必须剔
 *
 * 这 14 项（`custom_model_gemini` / `custom_model_deepseek_chat` / …）不是云端
 * 可调模型，而是**账号私有的 BYOK 条目** —— 条目里的 `custom_models` 是三方来源
 * 列表（如 `["deepseek//deepseek-chat"]`、`["gemini//gemini-3.1-pro-preview"]`），
 * 三方 key 存在**该账号的服务端**。列进模型选择器的后果：别的账号选中它必然失败，
 * 而用户完全无法从名字看出「这是某个账号私有的」。
 *
 * ## 两道判据（主判据 + 形态兜底）
 *
 * 1. **主判据 `usage === 'custom_model'`** —— 目录自己给的语义字段，最准确；
 * 2. **兜底 `id` 前缀 `custom_model_`** —— 防上游把 `usage` 改掉/漏发。
 *
 * ⚠️ **实测三条判据的等价性**（2026-09-20 取证，14 项逐项核对）：
 *
 * | 判据 | 命中数 | 与主判据的差集 |
 * |---|---|---|
 * | `usage === 'custom_model'` | 14 | —— |
 * | `id` 前缀 `custom_model_` | 14 | **双向为空**（与主判据完全等价） |
 * | `Array.isArray(custom_models)` | 13 | **漏 `custom_model_placeholder`**（它的 `custom_models` 是 `null`） |
 *
 * 故**不采用** `custom_models` 存在性作判据（会漏一项），只在注释里记下它的形态。
 * 主判据 + 前缀兜底在真实 roster 上双向差集为空 → **零误伤、零漏过**。
 *
 * ⚠️ **两个陷阱字段**（都是恒定的假信息，**不要**拿来判 custom）：
 * `config_source` 恒为 `1`（custom 与正常项都一样）；`display_config.is_custom_model`
 * 恒为 `false`（连 `custom_model_gemini` 也是 false）。
 */
export declare function isCustomTraeCnModel(entry: TraeCnModelEntry): boolean;
/**
 * 实测 8 项 `is_invisible_to_user:true`（客户端自己隐藏）的 id 点名。
 *
 * 用途**只有一个**：给 {@link isTraeCnJunkModelId} 当形态清单。目录路径不读它 ——
 * 那边有逐项的 `entry.invisible` 可用，比点名精确（见
 * {@link TraeCnModelEntry.invisible} 的三态语义）。
 */
export declare const TRAE_CN_INVISIBLE_MODEL_IDS: readonly string[];
/**
 * 判定一个**裸 id** 是否为「垃圾模型 id」（不该出现在 Account Hub 显示列表里）。
 *
 * ## 为什么需要裸 id 版本（{@link isCustomTraeCnModel} 不够用）
 *
 * {@link isCustomTraeCnModel} 的接口是**目录条目**：它的主判据 `usage` 只有目录
 * 端点才发。而本函数服务于另一条链路 —— `model.list` 的**黑名单并集回填**
 * （见 `src/account-hub-rpc.ts`）：那里的候选来自 `dsh_account_hub.disabledModels` 的**键名**，
 * 手上只有 id 字符串，没有任何目录字段。若照抄 entry 版本，`usage` 判据必然落空，
 * 只剩前缀兜底（对 custom 项尚可），而 invisible 项**根本没有形态判据可用**。
 *
 * ## 判据（三道，与目录侧同源）
 *
 * 1. **内部 agent 项**（{@link isInternalTraeCnConfig}）：点名 + 形态；
 * 2. **账号私有 BYOK 项**：`custom_model_` 前缀；
 * 3. **客户端自隐项**（{@link TRAE_CN_INVISIBLE_MODEL_IDS}）：点名清单。
 *
 * 第 1、3 条比目录路径**更严**（目录用逐项字段、此处只能点名/看形态）。这个方向
 * 是刻意选的：本函数的调用场景是「要不要**补回**一个已被关闭的模型」，误杀一个
 * 正常 id 的代价是它在设置页少一行（模型本身仍可在对话框里选用，只是无法重新
 * 打开 —— 而它本来就已经被关闭了），远小于把僵尸行重新灌回列表。
 *
 * ## 判据来源
 *
 * 判据全部是 **id 形态**，不含任何 provider 专属字段：垃圾 id（内部 agent 项、
 * 账号私有 BYOK 的 `custom_model_*`、客户端自隐项）都来自同一个 Trae 账号体系
 * 的目录形态，故本函数不依赖调用方是谁。
 */
export declare function isTraeCnJunkModelId(id: string): boolean;
/**
 * 静态回退表里的一个条目（**真机 16 项中剔除 5 项 SOLO 不可调 id 后的 11 项，
 * 逐字符照抄**）。
 *
 * 本表**只在动态目录整体失败时顶替**（见 {@link TRAE_CN_FALLBACK_MODELS}）。
 */
export interface TraeCnFallbackModel {
    /** 模型 ID（传给 chat 请求体的 `model` / `config_name`）。 */
    id: string;
    /** 展示名。 */
    name: string;
    /**
     * 上下文窗口（**真机目录给出的开发档，非估计值**）。
     *
     * 真机目录（2026-09-18）为每项给出 `ctx(dev/max)` 两档，本字段取 **dev 档**：
     * 它是客户端默认实际使用的窗口（如 `262144/1048576` → 262144）。
     * max 档（多数为 1048576）**刻意不取** —— 目录里它是理论上限，
     * 而 `resolveModel` 声明的窗口会被 DSH 用来决定何时压缩上下文，
     * 按上限声明会让压缩迟迟不触发。
     *
     * ⚠️ **本表一律不带 `maxContextWindow`**（理由见 {@link fallbackTraeCnCatalog}）：
     * 静态路径下这些模型**没有档位可选**，是预期行为而非缺陷。
     */
    contextWindow: number;
    /**
     * 是否接受图片输入（真机目录的「多模态」标记，原 16 项里 12 项为真；本表现存
     * 11 项中 **6 项**为真 —— 被剔除的 5 项恰好全是多模态项，另 1 项见
     * {@link TRAE_CN_FALLBACK_MODELS} 的 `minimax-m3` 修正说明）。
     *
     * 与 `src/product.ts` 的 `supportsImages` 同语义同字段名：适配器据此在
     * `listModels` / `resolveModel` 里输出 `['text','image']` 或 `['text']`。
     */
    supportsImages: boolean;
    /**
     * 该模型的最大输出 token 数（真机目录的 `max_tokens`：`64000` 或 `32000`）。
     *
     * **本 provider 刻意只记录、不落进 `defaultMaxTokens`**：DSH 的
     * `LlmResolvedModelInfo.defaultMaxTokens` 会在调用方未给 `maxTokens` 时自动
     * 填进请求体，而 trae-cn / qoder / lobsterai **仍不设该字段** —— 由适配器替用户
     * 决定输出上限是行为变更，不在本 provider 范围内。
     *
     * ⚠️ **buddy 系已不再适用这条**：`0611485` 起 `src/buddy-adapter.ts` 已移植该机制
     * （远端 `maxOutputTokens` → 请求体 `max_tokens` + `resolveModel().defaultMaxTokens`），
     * 因为 buddy 系的真实缺陷正是「不下发就退回网关默认 32000、长回答被静默截断」。
     * 保留字段是为了让目录与真机逐列对齐（否则后来者会以为目录里本来就没有它）。
     */
    maxTokens: number;
    /**
     * 可选思考档位（真机 vscdb `reasoning_effort_config.options`，逐字符照抄）。
     *
     * 空/缺省 = **不暴露选择器**：DSH 的模型选择器只读 `resolveModel().reasoning`，
     * 不声明该字段时显示「当前模型未提供推理等级」，这是诚实的（同
     * `src/buddy-adapter.ts` 的 `reasoningEfforts` 约定）。
     */
    reasoningEfforts?: readonly string[];
    /**
     * 默认档位（真机 `reasoning_effort_config.default_level`），**必须**在
     * {@link reasoningEfforts} 内。
     *
     * DSH 的 `resolveCallInfo` 会在调用方省略 `reasoningEffort` 时把它 materialize
     * 进请求，故它同时是「用户没选档位时实际下发的值」。声明了却不在
     * efforts 里会被 DSH 判为 `INVALID_MODEL_REASONING` 直接抛错。
     */
    defaultReasoningEffort?: string;
}
/**
 * 静态模型目录 —— **11 项**（真机 `chat_v3` 16 项中剔除 5 项 SOLO 不可调 id）。
 *
 * ## 来源
 *
 * 真机 `chat_v3` 模型目录（2026-09-18），由 Trae 客户端 **vscdb 缓存**与
 * **160 处日志事件**互证得到；id / 展示名 / 多模态标记 / max_tokens /
 * 上下文窗口**逐字符**照抄。id 的形态极不规则（`qwen3.8-flash` 无连字符、
 * `qwen-3.7-plus` 有、`deepseek-v4.1-flash` 是点号、`minimax-m3` 全小写），
 * 任何「规整化」都会让请求打到不存在的模型上 —— 故原样保留，不要改写。
 *
 * ## ⚠️ 为什么从 16 项缩到 11 项（2026-09-19 二次取证）
 *
 * 原表 16 项录自**旧 IDE 通道**的 `chat_v3` 目录。chat 迁到 **SOLO 通道**后，
 * 该通道的 roster 只有 **41 项**，其中 5 项**不在** SOLO roster 内（实测）：
 *
 * | 剔除的 id | 说明 |
 * |---|---|
 * | `Doubao-Seed-Code` | SOLO 41 项里没有它 |
 * | `glm-5.3-flash` | 同上 |
 * | `deepseek-v4.1-flash` | 同上 |
 * | `kimi-k2.8-preview` | 同上 |
 * | `qwen3.8-flash` | 同上 |
 *
 * 剔除的理由不是「表要精简」，而是**本 provider 只走 SOLO 通道**（IDE 通道已由
 * 五轮真机取证定案废弃：`llm_raw_chat` 恒回 `3003 all models failed`）。回退表里
 * 留着 SOLO 调不了的 id，唯一效果是**在模型选择器里产出必然 `4001` 的选项** ——
 * 用户选中即失败，且失败原因（版本头/表不匹配）与模型本身无关，极难自行诊断。
 * 动态目录成功时本来也不会列出它们（它们不在 SOLO roster 里），故剔除后两条
 * 路径的目录**首次一致**。
 *
 * 注意 `Doubao-Seed-Code` 的剔除**只针对本表**：它在 agent 池别的代际里是
 * **默认模型**，两张表互不影响。
 *
 * ## 现在的角色：**回退表**（不再是唯一目录）
 *
 * 动态目录（`get_detail_param`）是权威来源；本表在动态目录整体失败时顶替
 * （见 `src/trae-cn-adapter.ts` 的 `ensureRemoteModels`）。它仍是**唯一**记录
 * 「多模态标记」与**「思考档位」**的地方 —— 目录端点两个字段都不提供（前者本就没有，
 * 后者的 `reasoning_effort_config` 恒为空壳），见
 * {@link applyTraeCnStaticMetadata}。
 *
 * ## 4 个旧死 id 的下落（原 8 项静态表里的）
 *
 * | 旧 id | 现状 |
 * |---|---|
 * | `qwen3.7-max` | **已下线**（真机目录里没有它） |
 * | `deepseek-v4-flash` | 拼写错误的近似形态（真机是 `deepseek-v4.1-flash`，该 id 亦已剔除） |
 * | `doubao-seed-2-1-pro` | 同上（真机是 `Doubao-Seed-2.1-Pro`） |
 * | `MiniMax-M3` | 大小写错误的近似形态（真机是 `minimax-m3`） |
 *
 * 真机目录里**没有** `deepseek//deepseek-chat` 与 `deepseek//deepseek-reasoner`：
 * 那两个是账号自定义的 BYOK 条目，不属于云端目录，故**排除**。
 *
 * ## ⚠️ `minimax-m3` 的多模态标记已修正为 `false`（2026-09-20）
 *
 * 原表照抄的是**旧 IDE 通道** `chat_v3` 缓存里的 `true`，而 SOLO 目录端点实测
 * `display_config.multimodal: false`（remote 与 lite 两条 function 上分别是
 * `false` / `true`，`mergeTraeCnDirectory` 的 **remote 优先**规则取到的正是
 * `false`）。改它与「两条路径同口径」的原则一致：不改的话，同一模型在「目录
 * 成功」路径判纯文本、在「目录失败」路径判多模态 —— 正是
 * {@link applyTraeCnStaticMetadata} 要消灭的那种自相矛盾。
 *
 * 其余 10 项静态值与目录实测**逐项一致**（取证二次核对，2026-09-20），只改这一项。
 *
 * ## ⚠️ `contextWindow` 是 2026-09-18 的快照，**已经漂移**（2026-09-21 复测）
 *
 * 本表的值照抄自当时真机目录的 `prompt_max_tokens`（如 `glm-5.3` = `119040`）。
 * 复测时同一字段已变成 `168000`，而 `context_window_tokens.dev` 是 `200000`
 * —— 即**上游确实在调这个数**。本表**刻意不跟着改**：
 *
 * 1. 它只在动态目录整体失败时顶替，而动态目录成功时本条的值根本不参与（目录优先）；
 * 2. 「跟着上游改静态表」是一条没有终点的路 —— 今天抄 `168000`，明天还会漂；
 *    这里登记漂移事实，比维护一个永远滞后的副本诚实。
 *
 * 真正需要跟上游走的**档位**（Max）已改由 agent 组目录实时提供，见
 * {@link parseTraeCnAgentTiers}。
 */
export declare const TRAE_CN_FALLBACK_MODELS: readonly TraeCnFallbackModel[];
/**
 * 目录条目（**动态与静态两个来源共用同一种形态**）。
 *
 * `function` 是本类型的核心字段：它记录**该模型从哪个 function 拉到的**，
 * chat 请求的 `function` 字段照它下发。写死 `solo_work_lite` 会让
 * `glm-5.3` 等模型回 `4001 param is invalid`（真机实测）。
 */
export interface TraeCnModelEntry {
    id: string;
    name: string;
    /**
     * 是否接受图片输入。
     *
     * **缺省 = 未知**（目录端点不带该字段）→ 适配器按**纯文本**声明。
     * 静态表条目一律有值（真机 vscdb 的多模态标记）。
     *
     * ⚠️ 与 {@link TraeCnModelEntry.multimodal} 的关系：`multimodal`（目录
     * `display_config.multimodal`，**实时权威**）优先，本静态值仅作兜底回退，
     * 见 `TraeCnAdapter.inputModalitiesFor` 的口径。
     */
    supportsImages?: boolean;
    /**
     * `display_config.multimodal` —— 该模型是否接受**用户图片**输入。
     *
     * ## 为什么必须按模型读，而不是依赖静态表快照
     *
     * 目录条目里 `display_config` 一直**在实时下发**该字段（真机 2026-09-21：52 个
     * 可调用条目里 27 个为 `true`），而早期解析器只读了同层级的 `max_mode` /
     * `display_name`，漏了相邻的 `multimodal` —— 于是图片准入只能退回静态表（==
     * 一次性快照），目录一刷新就与真机脱节。本字段是**权威准入判据**：
     *
     * - `true` → `['text','image']`；
     * - `false` / **未声明** → `['text']`（保守：远没说 ≠ 远支持）。
     *
     * 反向对照实证（真机）：`multimodal:false` 的模型（`DeepSeek-V4-Pro-Official`）
     * 收到图后答「无法确定」、思考链明说「但没有图片」—— **与不带图的回答一致**，
     * 证明该标志逐模型可信。
     *
     * ⚠️ 与 {@link TraeCnModelEntry.toolResponseMultimodal} 是**两种独立能力**，
     * 不可合并判断（实测 `deepseek-v4.1-flash` 为 multimodal:true 而
     * tool_response_multimodal:false）。
     */
    multimodal?: boolean;
    /**
     * `display_config.tool_response_multimodal` —— **工具结果**内嵌图片能否回传。
     *
     * ⚠️ 与 {@link TraeCnModelEntry.multimodal} 是**两种独立能力**，不可合并。
     * 当前实现只消费 `multimodal`；单独保存该字段是为了保留远端权威信息、
     * 便于将来细化（本插件自身不发 `read_image` 的工具图，实际影响面有限）。
     */
    toolResponseMultimodal?: boolean;
    /**
     * 上下文窗口（目录给的 dev 档：`context_window_tokens.dev`，回退 `prompt_max_tokens`）。
     * 缺省 = 未提供。
     */
    contextWindow?: number;
    /**
     * 上下文窗口的 **Max 档**（两个来源，见下）。
     *
     * ⚠️ **只在严格大于 {@link contextWindow} 时才写入**（见 {@link parseTraeCnDirectory}）：
     * `max <= dev`（含 `max` 为 0 / 缺失 / 与 dev 相等）一律视为**没有 Max 档** ——
     * Work 侧实测就是 `{dev: 184000, max: 184000}` 这种「两档同值」的形态，
     * 收下它会渲染出一个切过去毫无效果的档位。
     *
     * 缺省 = 无 Max 档或两个来源都没给。用户可选的档位因此**永远精确等于上游公布的
     * 档位之一**，声明值只有 dev / max 两种可能（见 `TraeCnAdapter.resolveModel`
     * 的预算覆盖）。
     *
     * ## 两个来源（2026-09-21 起）
     *
     * | 来源 | 字段 | 现状 |
     * |---|---|---|
     * | IDE 目录条目自身 | `context_window_tokens.max` | ⚠️ **上游已停发**（只剩 `custom_model_*` BYOK 项带 max，而那些项全被过滤网剔除） |
     * | agent 组档位表 | `GET /api/remote/v1/models?functions=solo_agent_remote` 的 `max_mode` + `context_window_tokens.max` | **现行来源**，见 {@link applyTraeCnAgentTiers} |
     *
     * 合并顺序：目录自身的值优先（同池、更权威），agent 组只补**空缺**的条目 ——
     * 与「目录优先、静态表补缺」的既有口径同向。上游若恢复在 IDE 目录下发 max，
     * 这条路径自动让位，无需改代码。
     */
    maxContextWindow?: number;
    /** 最大输出 token（**只记录，不 materialize**，见 TraeCnFallbackModel.maxTokens）。 */
    maxTokens?: number;
    /** 可选思考档位；缺省 = 不声明（选择器不渲染该行）。 */
    reasoningEfforts?: readonly string[];
    /** 默认档位，必须在 {@link reasoningEfforts} 内。 */
    defaultReasoningEffort?: string;
    /** 该模型的来源 function（chat 请求的 `function` 字段）。 */
    function: string;
    /**
     * 目录的 `usage` 字段（实测取值 `chat_completion` / `summary` / `custom_model`）。
     *
     * 用途只有一个：识别**账号私有 BYOK 条目**（见 {@link isCustomTraeCnModel}）。
     * 静态回退表条目**没有**该字段（它们全是云端可调模型）。
     */
    usage?: string;
    /**
     * 目录的 `config_switch` 字段 —— **官方停用开关**（`false` = 上游已停用该条目）。
     *
     * ⚠️ 三态语义，与 {@link TraeCnModelEntry.invisible} 同款：**只有严格 `false`
     * 才剔除**，`true`（官方启用）与 `undefined`（上游没发这个字段）**都必须保留**。
     * 写成 `!entry.configSwitch` 会把所有未表态的条目一并误杀 —— 那等于把整个目录
     * 清空成静态回退表。
     *
     * 上游 `trae.ts` 的 `parseTraeBatchModelList` 把它列为**硬性过滤之一**
     * （`usage` / `config_switch` / `is_invisible_to_user` / 内部项），本模块此前
     * **整条漏接** —— 上游若把某个模型下架（保留条目、只翻这个开关），我们会继续
     * 把它列进选择器，用户选中即回 `4001`。
     */
    configSwitch?: boolean;
    /**
     * 目录的 `is_invisible_to_user` 字段 —— **客户端自己会隐藏**的项。
     *
     * ⚠️ 三态语义，**不能写成 `!entry.invisible`**：`true` 才剔除；
     * `false` 与 **`undefined` 都必须保留**。实测（2026-09-20）40 项里
     * `true` 12 项、`false` 14 项、**缺该字段 14 项**（含 13 项 custom 与
     * `qwen3.8-max` / `qwen-3.7-plus` 两个正常项）—— 把 undefined 当剔除会把
     * 正常模型一并干掉。
     */
    invisible?: boolean;
}
/**
 * 静态回退表 → 目录条目（全部映射到 {@link TRAE_CN_SOLO_REMOTE_FUNCTION}）。
 *
 * ## ⚠️ 静态路径**一律不产出 `maxContextWindow`**（这是设计，不是遗漏）
 *
 * **逐模型**的档位表确实存在了（agent 组目录，见 {@link parseTraeCnAgentTiers}），
 * 但它**只在 IDE 目录刷新成功的那一个周期里被拉取**：本函数是纯函数（不联网），
 * 而目录整体失败时适配器直接回退到这里，`fetchTraeCnDirectory` 也会短路掉那次
 * 档位请求（那时没有任何条目可补，两边都拉不到）。
 *
 * 于是静态路径下**11 项都没有档位 UI**，这是刻意接受的：把 agent 组的 max 摊派到
 * 本表上，等于让「一个没拿到 roster 的降级路径」去声明档位 —— 而本表与 agent 组
 * 的 roster 并不逐项对应（该组带 `Doubao-Seed-Code`，本表没有它；反向也有
 * `minimax-m3` 这类不在该组的项）。**宁缺毋编**：无档位 = 声明 dev 档 = 本次改动
 * 之前的行为，而错档位会直接改写宿主的压缩时机。
 *
 * ⚠️ 顺带说明为什么**不能**拿 4022 的钳制实验（998 161 token 成功 / 1 002 248
 * 失败 ⇒ 上游硬限约 1M）给本表摊派 1M：那是**网关级**的容量证据，说不出
 * 「哪几个模型公布了两档、各自 Max 是多少」。
 */
export declare function fallbackTraeCnCatalog(): TraeCnModelEntry[];
/**
 * 用静态表补**目录端点不提供的字段**：多模态标记与**思考档位**。
 *
 * ## 为什么需要这一步
 *
 * `get_detail_param` 的条目里**没有**多模态标记（对照实现只读
 * `config_name` / `display_config` / `model_detail_list` / `context_window_tokens`），
 * 而静态表是真机 vscdb 逐项记录的模态标记（原 16 项里 12 项、现存 11 项里 6 项）。
 * 不补的话，动态目录一旦生效，这些支持图片的模型会**全部**变成纯文本 ——
 * 同一模型在「目录拉取成功」与「目录拉取失败」两条路径下报出不同模态，是自相矛盾。
 *
 * **思考档位同理，且后果更严重**：SOLO 目录端点对用户可调模型**根本不提供档位**
 * （2026-09-20 取证：9 项带 `reasoning_effort_config` 的全部是
 * `{support_thinking:false}` 形态，**没有** `options` / `default_level`；另 30 项
 * 连该字段都没有）。动态目录取代静态表后，DSH 的「思考程度」选择器**整行消失**，
 * 而档位数据一直是有的（静态表 8 项）。故必须与多模态一起同源补回。
 *
 * ## 两条判据**刻意不同**（写反会让档位永远补不上）
 *
 * | 字段 | 判据 | 理由 |
 * |---|---|---|
 * | `supportsImages` | `entry.supportsImages === undefined` 才补 | 目录**将来可能**带上该字段，届时以目录为准 |
 * | `reasoningEfforts` | **同样只看 `entry.reasoningEfforts === undefined`** | 见下 |
 *
 * ⚠️ **档位绝不能看目录的 `support_thinking`**：目录恒为 `false`（或字段缺席），
 * 照多模态那种「目录已表态就不覆盖」的写法写，就会得到「目录说 false → 不补」
 * 的结果 —— 档位**永远补不上**，而这正是本次要修的缺陷。判据只能是
 * 「动态条目有没有自带档位」，而动态条目**永远不可能**自带（端点不给 options），
 * 故这条判据等价于「按 id 补」。
 *
 * 若上游将来真在目录里发出 `support_thinking:true` + 非空 `options`，
 * {@link parseTraeCnDirectory} 会把档位读进条目，本条判据随即**自动让位**给目录值
 * —— 那时 `reasoningEfforts !== undefined`，不再补。
 *
 * ## 边界（**不是**「接 remote 骨架」）
 *
 * 只对**静态表里已有的 id** 补值，**不新增**任何条目：远端独有 id 的多模态与档位
 * 仍然未知（模态按纯文本、档位不声明）。骨架合并（把远端独有项也列出来）**刻意
 * 不做** —— 那会引入 `join` 不到的不可调项（如旧表里的 `Doubao-Seed-Code`），
 * 选中即失败。
 */
export declare function applyTraeCnStaticMetadata(entries: readonly TraeCnModelEntry[]): TraeCnModelEntry[];
/**
 * 解析 `get_detail_param` 的响应（**只认实测形态**）。
 *
 * ```json
 * {"config_info_list":[{"config_name":"glm-5.3","display_config":{"display_name":"GLM-5.3"},
 *   "model_detail_list":[{"prompt_max_tokens":119040,"max_tokens":64000}],
 *   "context_window_tokens":{"dev":119040,"max":1048576}}, ...]}
 * ```
 *
 * ## 与旧解析器的区别（旧的已删除）
 *
 * 旧 `parseTraeCnModels` 是**容忍式猜测**：从 `data` / `models` / `model_list` /
 * `result` / `items` 等一堆候选键里找数组，字段名也试五六个候选。那是为「远端
 * 不接线、留个入口」写的，从未被真机响应校准过。现在端点已实测，本函数**只读
 * 实测路径**（顶层 `config_info_list`），不做信封猜测 —— 上游真改版时，一个
 * **空目录**（回退静态表，用户仍能用）比「猜对形状但读错字段」的半成品更容易诊断。
 *
 * 字段读取：
 * - id：`config_name`（空串跳过）；
 * - 展示名：`display_config.display_name`，缺省回退 id；
 * - 上下文窗口：**`context_window_tokens.dev` 优先**，回退
 *   `model_detail_list[0].prompt_max_tokens`（口径理由见函数体内的注释：与官方
 *   客户端显示的 200K 对齐，消掉「同模型两个数」的困惑）；
 *   **Max 档**另读 `context_window_tokens.max`，且只在**严格大于**上面那个 dev 档时才收
 *   （`max <= dev`（含 0 与两档同值）、max 缺失、dev 档本身缺失，都视为无 Max 档，
 *   理由见 `TraeCnModelEntry.maxContextWindow`）；
 *
 *   ⚠️ **上游已对可调模型停发 max**（2026-09-21）：复测时只有 `custom_model_*`
 *   BYOK 项带 `max:1048576`，而那些项马上会被过滤网剔除 ⇒ **本函数在当前 roster 上
 *   读不出任何档位**。档位改由 agent 组目录补入（`applyTraeCnAgentTiers`），
 *   本条读取路径**刻意保留**：上游若恢复下发，它与 agent 组的「目录优先」判据
 *   会自动接上，无需改代码。
 * - 输出上限：`model_detail_list[0].max_tokens`；
 * - 思考档位：`reasoning_effort_config`（`support_thinking === true` 且 `options`
 *   是非空字符串数组才声明，`default_level` 不在 options 内时只丢默认档）；
 * - 过滤线索：`usage`（识别账号私有 BYOK）与 `is_invisible_to_user`（客户端自隐项）。
 *
 * ⚠️ **SOLO 端点的档位字段恒为空壳**：实测 39/40 项里带 `reasoning_effort_config`
 * 的 9/10 项**全是** `{support_thinking:false}`（无 `options`），其余项连字段都没有。
 * 故本函数在 SOLO 目录上**永远读不出档位** —— 档位由
 * {@link applyTraeCnStaticMetadata} 按 id 从静态表补回。这是设计，不是缺陷。
 *
 * @param body - 响应体（任意形态，非对象/缺数组时返回空数组）。
 * @param functionName - 本次拉取用的 function（写进每个条目的 `function`）。
 */
export declare function parseTraeCnDirectory(body: unknown, functionName: string): TraeCnModelEntry[];
/** 一次目录拉取里，某个 function 的返回（失败则该 function 不出现）。 */
export interface TraeCnDirectoryGroup {
    /** 拉取用的 function。 */
    function: string;
    /** 该 function 返回的条目。 */
    entries: readonly TraeCnModelEntry[];
}
/**
 * 合并多个 function 的目录（**first wins，调用方按优先级给顺序**）。
 *
 * ## 五道过滤网（在**同一个循环**里逐项判定，与内部项过滤并列）
 *
 * 1. **remote 优先**：先到的 function 拥有该 id（{@link TRAE_CN_SOLO_FUNCTIONS}
 *    的顺序即优先级）。同名 id 在两条 function 下**可能不是同一个可调项**
 *    （`glm-5.3` 只在 remote 集里），故不能后到覆盖先到。
 * 2. **内部 agent 项**（点名或形态命中，见 {@link isInternalTraeCnConfig}）。
 * 3. **账号私有 BYOK 项**（{@link isCustomTraeCnModel}）：14 项
 *    `custom_model_*`，三方 key 存在别的账号服务端，列出即误导。
 * 4. **客户端自隐项**（`invisible === true`）：8 项 —— 其中 `seed-code-pro-0430`
 *    与 `Doubao-Seed-2.0-Code` 的展示名分别是 **`Doubao-Seed-2.1-Pro` /
 *    `Doubao-Seed-2.1-Turbo`**（旧代际重名别名，不剔会与真身**重名**出现在
 *    选择器里），`sagitta` / `aquila` 的展示名是 **`"-"`**。客户端自己隐藏它们。
 * 5. **官方停用项**（`configSwitch === false`，即上游 `config_switch`）：上游把
 *    条目留在表里、只翻这个开关表示**已停用**（上游 `trae.ts` 的
 *    `parseTraeBatchModelList` 把它列为硬性过滤之一）。它此前**整条漏接**，
 *    是本次补上的第五道网。⚠️ **三态、方向与第 4 条相反**：只有严格 `false`
 *    才剔除，`true` 与 `undefined` 都必须保留。
 *
 * ## remote 成功时剔除 lite 独有项
 *
 * 实测「用户可调的项要么两 function 都在集、要么 remote 独有」，故**只在 lite 出现**
 * 的项就是内部 agent 项（见 {@link isInternalTraeCnConfig}）。remote 整体失败时这条
 * 规则不生效 —— 那时 lite 是唯一数据源，留着它的非内部项比空目录有用（空目录会退回
 * 静态表）。
 *
 * ## 过滤后的规模（2026-09-20 取证实测，逐项核对）
 *
 * `40（并集）− 5（内部）− 14（custom）− 8（invisible）= 13 项`。
 * ⚠️ 内部项是 **5** 项而非 4：`computer_use_subagent` 是 **lite 独有**项，它在
 * 第 1 条规则（remote 成功时剔除 lite 独有）里就已经出局，故容易被漏算。
 * ⚠️ 第 5 条在**该次取证的 roster 上零命中**（40 项里没有任何一项
 * `config_switch === false`），故上面的算式**不因它改变** —— 它是**防将来**的网。
 * 13 项与静态回退表（11 项）的差集是 `kimi-k2.7-code` / `kimi-k2.6` 两项 ——
 * 它们是 `is_invisible_to_user:false` 的**正常项**，必须保留。
 */
export declare function mergeTraeCnDirectory(groups: readonly TraeCnDirectoryGroup[], remoteSucceeded: boolean): TraeCnModelEntry[];
/** {@link fetchTraeCnDirectory} 的入参。 */
export interface TraeCnDirectoryOptions {
    /** 注入 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /** 覆盖网关基址（默认 {@link TRAE_CN_IDE_API_BASE}）。 */
    apiBase?: string;
    /** 取消信号。 */
    signal?: AbortSignal;
}
/**
 * agent 池目录里的**一个模型的档位**（{@link parseTraeCnAgentTiers} 的值形态）。
 */
export interface TraeCnAgentTier {
    /**
     * 上游是否对该模型发布了 Max 档（`max_mode === true`）。
     *
     * ⚠️ **本字段是必要条件，不是冗余信息**：真机上 `max_mode:false` 的三项
     * （`Doubao-Seed-2.1-Turbo` / `kimi-k2.7-code` / `kimi-k2.6`）的
     * `context_window_tokens.max` 恰好是 `0` —— 只看数值读不出「有没有档位」，
     * 语义全在本开关上。故 {@link applyTraeCnAgentTiers} 判的是
     * **`maxMode === true` 且 `max > 生效档`**，两条缺一不可。
     *
     * 把它留在值对象里（而不是解析时就丢掉 false 项）是为了让「上游说这个模型
     * 没有档位」与「上游压根没列这个模型」在测试和排障时可区分。
     */
    maxMode: boolean;
    /** `context_window_tokens.max`（正有限数才收；`0` / 缺失即缺省）。 */
    max?: number;
}
/** {@link fetchTraeCnAgentTiers} 的入参。 */
export interface TraeCnAgentTierOptions {
    /** 注入 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /** 覆盖基址（默认 {@link TRAE_CN_AGENT_MODELS_API_BASE}）。 */
    apiBase?: string;
    /** 取消信号。 */
    signal?: AbortSignal;
}
/**
 * 解析 agent 池目录，取出 `模型 id → 档位` 的表。
 *
 * ## 响应形态（真机实测，2026-09-21）
 *
 * ```json
 * {"code":0,"data":{"list":[{"function":"solo_agent_remote","models":[
 *   {"name":"glm-5.3","display_name":"GLM-5.3","max_mode":true,
 *    "context_window_tokens":{"dev":200000,"max":1000000}, …}]}]}}
 * ```
 *
 * ## 取组纪律：只认 `function === solo_agent_remote`，绝不跨组拼接
 *
 * ⚠️ **刻意不做「没命中本组但只有一组时也用」那种容忍**：失败代价只是
 * **没有档位**（等价于本次改动之前的状态，静默降级），跨池取值的代价却是把
 * **另一个池的档位**灌进 IDE 目录 —— 用户会看到一个本池未必认的窗口并选中它。
 * 宁可无档位，也不跨池。组不存在 / 本组 `models` 非数组 → 空表。
 *
 * ## 字段判据
 *
 * - id 取 **`name`**（真机的模型 id 就在 `name` 里，`display_name` 是给人看的
 *   展示名）；非字符串 / 空串跳过；
 * - `maxMode`：`max_mode === true`，其余（`false` / 缺失 / 非布尔）一律 `false`；
 * - `max`：`context_window_tokens.max`，与目录侧**同一口径**（{@link readPositive}：
 *   正有限数才收）。`context_window_tokens.dev` **刻意不读** —— 本表只负责补
 *   Max 档，dev 档的权威来源仍是 IDE 目录条目自己的 `contextWindow`。
 *
 * @param body - 响应体（任意形态；非对象 / 缺 data / 缺 list / 无本组都返回空表）。
 */
export declare function parseTraeCnAgentTiers(body: unknown): Map<string, TraeCnAgentTier>;
/**
 * 把 agent 组档位**补进** IDE 目录条目（`maxContextWindow`）。
 *
 * ## 三条判据（缺一不可）
 *
 * 1. `maxMode === true` —— 上游明说该模型有 Max 档；
 * 2. `max > entry.contextWindow` —— 严格大于**实际生效的 dev 档**。这里的
 *    `contextWindow` 已经是解析侧算好的 `context_window_tokens.dev ??
 *    prompt_max_tokens`（见 {@link parseTraeCnDirectory}），故直接比它就是
 *    「与生效档比」，不需要、也不该再去读原始字段；
 * 3. `entry.contextWindow !== undefined` —— 没有比较基准的条目**跳过**
 *    （`max` 是不是「更大」无从判断）。
 *
 * ## 只补，不增、不覆盖
 *
 * - **绝不新增条目**：agent 组里有 IDE roster 没有的 id（真机如
 *   `Doubao-Seed-Code`），把它加进目录就是给用户一个必然 `4001` 的选项。
 *   本函数只遍历**目录自己的条目**、按 id 查表，天然不可能新增。
 * - **已带 `maxContextWindow` 的条目不覆盖**：那说明 IDE 目录自己下发了 max
 *   （上游恢复发布的情形），而**同池的值比跨池的值权威** —— 与
 *   {@link applyTraeCnStaticMetadata} 对 `supportsImages` 的「目录已表态就不覆盖」
 *   同向。合并顺序上也因此在静态元数据补齐**之后**执行。
 *
 * ## 失败方向
 *
 * `tiers` 为空表（拉取失败 / 无本组）时逐项原样返回 —— 等价于本次改动之前，
 * 即「无档位 UI」而不是「错误档位」。
 */
export declare function applyTraeCnAgentTiers(entries: readonly TraeCnModelEntry[], tiers: ReadonlyMap<string, TraeCnAgentTier>): TraeCnModelEntry[];
/**
 * 拉取 agent 池目录并解析出档位表（`GET /api/remote/v1/models?functions=solo_agent_remote`）。
 *
 * ## 请求配方（真机实测，2026-09-21）
 *
 * | 项 | 值 |
 * |---|---|
 * | URL | `https://solo.trae.cn/api/remote/v1/models?functions=solo_agent_remote` |
 * | 方法 | `GET` |
 * | 头 | **只有 5 个**：{@link traeCnAccessHeaders}（三个等值 token 头 + `Accept` + `Content-Type`） |
 * | 凭据 | 与 IDE 目录**同源同一个已解析账号**（同一刷新周期内不二次选号） |
 *
 * ⚠️ **头刻意只有这 5 个**：与 IDE 目录 / chat 用的 {@link traeCnSoloHeaders}
 * （十来个头，含 SOLO 代际版本码与追踪头）**不是**同一套 —— 本端点实测不需要
 * SOLO 网关头，多带不是「更保险」而是把请求形态改成未被验证的组合。
 *
 * ## 失败一律静默降级（**绝不抛**）
 *
 * 抛错 / 非 2xx / 响应不是 JSON / 无本组 → **空表**。调用方（
 * {@link fetchTraeCnDirectory}）据此保持目录本身照常返回：**档位拉取失败绝不
 * 能拖垮目录**，否则一次档位端点的抖动会让整个模型目录退回静态表。
 *
 * ⚠️ **失败不写进任何缓存判据**：目录缓存（适配器的 12h TTL）只记「目录成功」
 * 这一次，档位的重试由下一次目录刷新自然带上（见
 * `TraeCnAdapter.ensureRemoteModels`）—— 在那里加一个「档位失败就提早重试」的
 * 分支，等于让两个数据源的成功与否互相牵制。
 */
export declare function fetchTraeCnAgentTiers(credential: TraeCnCredential, options?: TraeCnAgentTierOptions): Promise<Map<string, TraeCnAgentTier>>;
/**
 * 拉取动态模型目录（CN 区两个 function 各一次，取并集）。
 *
 * 用**与 chat 完全相同的凭据与网关头**（{@link traeCnSoloHeaders}）——真机实测该
 * 端点带鉴权即 200，且不消耗积分。单个 function 失败**不阻断**另一个：目录是
 * 「尽力而为」的数据，整体落空时适配器回退静态表。
 *
 * ## 档位合并（与目录**同一刷新周期**）
 *
 * 目录条目合并并补齐静态元数据后，再补一次 agent 组档位
 * （{@link fetchTraeCnAgentTiers} + {@link applyTraeCnAgentTiers}）。三件事刻意
 * 收在本函数里，好处是**适配器的缓存与 TTL 逻辑一行不用改**：档位与目录共用
 * 同一次刷新、同一个 12h 周期、同一份「成功才写缓存」判据。
 *
 * ⚠️ 目录整体落空时**直接返回空数组**、不再打档位端点：调用方此时回退静态表，
 * 而静态回退表**一律不带档位**（理由见 {@link fallbackTraeCnCatalog}），拉回来的
 * 档位无处可补 —— 那一次请求纯属浪费。
 */
export declare function fetchTraeCnDirectory(credential: TraeCnCredential, options?: TraeCnDirectoryOptions): Promise<TraeCnModelEntry[]>;
/**
 * 构造 SOLO 通道的请求头（chat 与目录**共用同一份**）。
 *
 * ## 与旧 IDE 通道的差异（逐项都是实测值）
 *
 * | 头 | 旧通道 | **SOLO 通道** |
 * |---|---|---|
 * | `request-traffic-type` | `normal` | **`prod`** |
 * | `x-plugin-channel` | 无 | **`icube-ai`** |
 * | `User-Agent` | `TraeClient/TTNet` | **`Trae/<SOLO 代际版本>`** |
 * | 追踪头 | 无 | **`x-request-id` / `x-trae-request-id` / `x-custom-trace-id` / `x-flow-traceparent`** |
 * | `x-uid` | 无 | **凭据的 `user_id`** |
 *
 * ⚠️ **版本头必须换成 SOLO 代际**（`20260820` / `0.1.61` / `Trae/0.1.61`），
 * **不能**沿用旧 IDE 通道的 `107` / `1.107.1`：SOLO 网关按 `x-ide-version-code`
 * **选模型配置表**，`107` 选出的是一张**空表**，任何模型都恒回
 * `4001 param is invalid`（迁移后 chat 全败的根因）。三个头取自**实机验证过的
 * 成功组合**（`glm-5.3-flash` 流式正常），须成对使用 —— 见
 * {@link TRAE_CN_SOLO_VERSION_CODE} / {@link TRAE_CN_SOLO_IDE_VERSION}。
 *
 * 追踪头三者**同源**：`requestId` 是一个 UUID，`x-custom-trace-id` 是它去横线后
 * 的前 32 字符，`x-flow-traceparent` 是 W3C 形态 `04-<traceId>-<traceId 前 16>-01`。
 * 生成一次、三处复用 —— 每处各 randomUUID() 会让上游的调用链对不上。
 *
 * 刻意**不用** `new Headers(...)`：Headers 构造器会规范化/丢弃部分头，
 * 普通对象逐字传递（与 credits 模块一致），避免两处请求头形态不一致。
 */
export declare function traeCnSoloHeaders(credential: TraeCnCredential, accept?: string): Record<string, string>;
//# sourceMappingURL=trae-cn-models.d.ts.map