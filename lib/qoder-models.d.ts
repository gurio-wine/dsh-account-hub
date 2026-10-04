/**
 * Qoder 模型目录：动态拉取 + 静态兜底 + 12h 缓存（**国际版与 CN 共用**）。
 *
 * ## 为什么单独成模块
 *
 * 与 `src/trae-cn-models.ts` 同一分工：目录解析、目录拉取、静态回退表、
 * 缓存四件事成篇，`src/qoder-adapter.ts` 只负责把它接到 `ctx.llm` 的
 * `listModels` / `resolveModel` 上。适配器的 chat 路径（流式解析、错误分类）
 * 不依赖本模块 —— 本模块是**纯目录面**。
 *
 * ## 目录端点只认 PAT（与 chat / quota 不同源）
 *
 * | 端点 | 凭据 | 证据 |
 * |---|---|---|
 * | `GET {modelsBase}/api/v1/cloud/models` | **PAT（`pt-`）** | T1 实测 200 |
 * | `POST {chatBase}/model/v1/chat/completions` | jt（`jt-`） | PAT 直打恒 401 |
 * | `GET {openapiBase}/api/v2/quota/usage` | jt（`jt-`） | PAT 打回 401 `TOKEN_EXPIRE` |
 *
 * 故本模块**不做 exchange、不取 job token**（那是 `src/qoder-auth.ts` 的职责），
 * 直接用凭据里的 `access_token`（PAT 本体）打目录 —— 加一层 jt 换取只会白白
 * 引入一个会过期的中间态（计划 §0「目录端点」行的定案）。
 *
 * ## 目录形态（T1 实测 17 项，`has_more:false`）
 *
 * 实测定案与原调研报告 C2 的二手 schema 有两处**关键差异**，都以实测为准：
 *
 * 1. **返回全表 + `is_enabled` 标记**，不是「只返回 enabled 模型」——
 *    本账号 17 项里**仅 2 项** `is_enabled:true`（`qmodel_38max` / `qfmodel`）。
 *    故过滤策略是「拉取成功时**只播报** `is_enabled === true` 的项」。
 * 2. **没有 `type` / `source`**，但多 `is_vl` / `support_disable_reasoning`。
 *
 * `id` 是**短 key**（`qmodel_38max` / `qfmodel` / `gmodel` / `dmodel` / `mmodel`…），
 * **不是 tier 名** —— `auto` / `efficient` 虽是目录里的合法 id，但作为 `model`
 * 值下发时回 402（T4 定案：chat 只认短 key）。
 *
 * ## roster 会浮动 → 绝不硬编码全表
 *
 * 实测目录与官方 CLI 表、国内版表**三者都不一致**（国际版目录里没有 `lite`、
 * 没有 `Kimi-K2.7-Code`、没有 `Qwen3.6-Flash`、没有 `MiniMax-M2.7`）。故静态表
 * 只放**本插件确实要在目录不可用时也能播报**的极少项，不做全表镜像。
 *
 * ## CN 目录（真机 14 项快照）的两点差异
 *
 * CN 目录与国际版**字段同构**，差别只在内容：
 *
 * 1. **14 项全部 `is_enabled:true`**（国际版 17 项里只有 2 项 true）——
 *    「只播报 `is_enabled` 项」这条规则不变，但在 CN 上等于**整表播报**；
 * 2. **id 集合不同**：有 `q37fmodel` / `gm51model`，**没有** `ultimate` /
 *    `performance` / `efficient` / `smodel` / `cmodel` 这些 tier 项，
 *    也**没有 `lite`**。
 *
 * 解析器（{@link parseQoderDirectory}）**不做任何按 region 的分支** —— 两个
 * 目录的「读哪些字段、怎么读」逐条相同，差异全在响应内容里。
 *
 * ## `lite` 的特殊处理（**两条路径不对称，是刻意的**）
 *
 * `lite` 不在**国际版**官方目录里，但 T2/T3 实测它是该 region 的 quota=0 账号上
 * **唯一能回 200 的模型**（免费遗留路径，上游路由到 `qwen3-coder-plus`）。
 * 它的处理规则：
 *
 * - **动态目录成功时「不并入」lite** —— 目录是「官方认可集」，把 lite 并进去
 *   等于**伪造官方认可**，用户会以为官方仍在提供它；
 * - **目录整体失败回退静态表时 lite 自然在列** —— 此时没有任何官方数据可用，
 *   把实测可用的 lite 列出来是「尽力而为」而不是「声称官方支持」。
 *
 * ⚠️ **CN 完全不适用这条**：CN 目录（14 项）与 CN 账号侧都没有 `lite` 的任何
 * 证据，故 {@link QODER_CN_FALLBACK_MODELS} **不含它**。两个 region 的差别
 * 不需要额外分支：`lite` 落在哪张静态表里，就决定了它是否被认可。
 *
 * 该不对称由 {@link effectiveQoderCatalog} 一处收敛，不要在别处再写一份判断。
 *
 * ## 兜底表**按 product 分**（两个 region 的可用集不同）
 *
 * 静态兜底表不是「一套表两个 region 共用」，而是每个产品一份：
 *
 * | 产品 | 兜底表 | 项数 |
 * |---|---|---|
 * | {@link QODER} | {@link QODER_FALLBACK_MODELS} | 3（含 `lite`） |
 * | {@link QODER_CN} | {@link QODER_CN_FALLBACK_MODELS} | 2（**不含 `lite`**） |
 *
 * ⚠️ **CN 兜底表刻意不含 `lite`**：CN 目录 14 项里没有它，「免费遗留路径」是
 * **国际版账号侧**的实测现象，没有任何 CN 证据。把国际版的遗留项混进 CN 兜底，
 * 产出的是一个**必然不可调**的选项（用户选中即失败，且失败原因与模型名毫无
 * 关联）—— 那比少列一项糟得多。反向也成立：国际版兜底表**逐字节不变**。
 */
import type { QoderCredential, QoderProduct } from './qoder-product.js';
import type { QoderDirectorySigningSource } from './qoder-signing.js';
export { resolveQoderDirectoryEndpoint } from './qoder-product.js';
/**
 * 目录缓存 TTL（毫秒，12 小时）。
 *
 * 与 `TRAE_CN_MODELS_TTL_MS` / LobsterAI 的 `clientVersion` 缓存同一口径：
 * 模型目录变化极慢，而 `listModels` / `resolveModel` 都会触发一次「确保目录就绪」，
 * 没有 TTL 就只能进程级缓存一次（长会话中新增模型永远看不见）。
 */
export declare const QODER_MODELS_TTL_MS: number;
/**
 * 表外模型的可读提示（追加在失败文案之后）。
 *
 * 与 `src/trae-cn-adapter.ts` 的 `TRAE_CN_OFF_CATALOG_HINT` 同一惯例、同一句式：
 * 判定「模型不在可用目录中」与「请求形态错误」共用同一句上游文案时，用户无法
 * 自行区分，故由本插件补一句「换一个模型」的可执行建议。
 *
 * ⚠️ **本提示只用于失败路径的文案，不用于 `resolveModel` 抛错** —— DSH 约定
 * `listModels` 仅供参考，表外 id 必须仍可路由（见 `qoder-adapter.ts` 模块头）。
 */
export declare const QODER_OFF_CATALOG_HINT = "\uFF08\u8BE5\u6A21\u578B\u5DF2\u4E0D\u5728 Qoder \u53EF\u7528\u76EE\u5F55\u4E2D\uFF0C\u8BF7\u5728 Hub \u7684\u6A21\u578B\u5217\u8868\u91CC\u91CD\u9009\uFF09";
/**
 * 静态兜底表的条目（**roster 浮动，故只放极少项**）。
 *
 * 三个字段来源不同，逐项说明见 {@link QODER_FALLBACK_MODELS}：
 * - `qmodel_38max` / `qfmodel`：目录实测 `is_enabled:true` 的两项（本账号）
 *   —— 字段值（展示名 / 档位 / 窗口 / `is_vl`）**逐字符照抄 T1 快照**；
 * - `lite`：**不在目录**，靠 T2/T3 实测可用性入选，故**没有任何目录字段可抄**
 *   （无档位、无窗口声明）。
 */
export interface QoderFallbackModel {
    /** 模型 ID（chat 请求体的 `model` 取值，**短 key**）。 */
    id: string;
    /** 展示名（目录的 `display_name`）。 */
    name: string;
    /**
     * 图片能力（静态表真值；目录的 `is_vl` 在 T1 快照 17 项恒为 true，不能作为
     * 逐模型信号，解析时降级为目录元数据）。`supportsImages: true` 的模型，
     * 适配器的 chat 路径（`serializeQoderMessages`）会把图片块转成 OpenAI
     * `image_url` data URL 真实出站；未标注的模型一律按纯文本处理。
     */
    supportsImages?: boolean;
    /**
     * 上下文窗口（目录的 `default_context_window`；缺该字段时取
     * `available_context_windows` 首项 —— 实测两者一致，见
     * {@link parseQoderDirectory}）。
     */
    contextWindow?: number;
    /**
     * 可选思考档位（目录的 `efforts`，**顺序逐字符照抄**）。
     *
     * 缺省 = **不暴露选择器**：DSH 的「思考程度」只读 `resolveModel().reasoning`，
     * 不声明时显示「当前模型未提供推理等级」，这是诚实的（同 trae-cn 约定）。
     */
    reasoningEfforts?: readonly string[];
    /** 默认档位（目录的 `default_effort`），必须落在 {@link reasoningEfforts} 内。 */
    defaultReasoningEffort?: string;
}
/**
 * 静态兜底表 —— **3 项**。
 *
 * ## 为什么只有 3 项（而不是镜像 17 项）
 *
 * 目录 17 项里 15 项对本账号 `is_enabled:false`，且**它们的可用性随账号与
 * roster 浮动**（同一 id 在别的账号 / 别的时间未必在表里）。把 17 项抄进静态表
 * 会在目录失败时**播报一批本账号根本用不了的模型** —— 用户选中即 402，
 * 且失败原因（额度/账号）与模型名看起来毫无关系，极难自行诊断。
 *
 * 故只保留「目录失败时最可能仍然可用」的极小集：
 *
 * | id | 展示名 | 来源 | 档位 |
 * |---|---|---|---|
 * | `qmodel_38max` | Qwen3.8-Max | T1 目录 `is_enabled:true` | xhigh / low / medium，默认 medium |
 * | `qfmodel` | Qwen3.8-Flash | T1 目录 `is_enabled:true` | 同上 |
 * | `lite` | Lite | **不在目录**，T2/T3 实测可用（免费遗留路径） | **不声明** |
 *
 * `lite` 的展示名取 `Lite`：官方目录不提供它，参考实现（QoderGateway）硬编码的
 * 也是 `Lite` —— 这里只沿用这个公认叫法，**不抄它硬编码的 `max_input_tokens:
 * 180000`**（那是参考项目自己编的常量，不是实测值）。
 */
export declare const QODER_FALLBACK_MODELS: readonly QoderFallbackModel[];
/**
 * **CN** 静态兜底表 —— **2 项**：`qmodel_38max` + `qfmodel`。
 *
 * 两个 id 与 {@link QODER_FALLBACK_MODELS} 的前两项**同名**（CN 快照里这两项
 * 同样 `is_enabled:true`，且档位声明逐字段相同），故字段值照抄那一对。
 *
 * ⚠️ **不含 `lite`**（理由见模块头）：CN 目录没有它，也没有任何 CN 侧的可用性
 * 证据。CN 目录的**其他 12 项**同样不进兜底表 —— 它们虽然 `is_enabled:true`，
 * 但 roster 会浮动，而静态表的定位是「目录不可用时的极小可用集」，不是镜像
 * （与国际版同一取舍，见 {@link QODER_FALLBACK_MODELS} 的说明）。
 */
export declare const QODER_CN_FALLBACK_MODELS: readonly QoderFallbackModel[];
/**
 * 取某产品的静态兜底表。
 *
 * **判据只看 `id === 'qoder-cn'`**（显式列举，不做「非 qoder 即 CN」的反向推断）：
 * 第三个 region 落地时，那条反向推断会**静默**把新 region 也指向 CN 表。
 *
 * ⚠️ 本函数同时是「该产品认不认 `lite`」的**唯一真相源**：`lite` 只在国际版
 * 表里，故 CN 下它按表外模型处理（`resolveModel` 不给展示名、失败时补
 * 「不在目录」提示）。**不要再写一个独立的 `recognizesLite` 谓词** —— 两份
 * 判据会分叉，而分叉的后果是 CN 上凭空多出一个必然不可调的选项。
 */
export declare function qoderFallbackModels(product?: QoderProduct): readonly QoderFallbackModel[];
/**
 * 目录条目（**动态与静态两个来源共用同一种形态**）。
 *
 * 字段全部可选（`id` / `name` 除外），因为「缺省」与「明确为假」在 DSH 侧
 * 语义不同：`inputModalities` 缺席 = 未知、显式 `['text']` = 明确的否定能力。
 */
export interface QoderModelEntry {
    /** 模型 ID（短 key）。 */
    id: string;
    /** 展示名。 */
    name: string;
    /** 目录的 `is_enabled`（静态兜底条目恒为 true）。 */
    enabled: boolean;
    /** 目录的 `is_vl`；缺省 = 目录未提供。 */
    supportsImages?: boolean;
    /** 上下文窗口（见 {@link QoderFallbackModel.contextWindow}）。 */
    contextWindow?: number;
    /** 目录的 `max_input_tokens`（**只记录，不 materialize**，见下）。 */
    maxInputTokens?: number;
    /** 目录的 `available_context_windows`（原样保留，含 272000 这类非整值）。 */
    availableContextWindows?: readonly number[];
    /**
     * **完整的上下文窗口档位表**（升序去重；**只在两个及以上档位时**存在）。
     *
     * Qoder 的目录公布 `available_context_windows`（真机 `[200000, 400000,
     * 1000000]`），**默认档是最小档**（`default_context_window`），其余是升档选项
     * —— 与 Buddy 的 `supportedLengths`（生效档已是最大档、其余是降档选项）
     * 方向相反，但「用户能选的档位精确等于目录公布的那些数」这条原则一致。
     *
     * ⚠️ **纯声明值，不出站**：只喂 `resolveModel().context`（宿主压缩阈值与保留
     * 预算）。`qoder-adapter.spec.ts` 有逐字节比对请求体的用例钉死。
     *
     * 缺省 = 没有档位可选（目录只给一个窗口，或 `available_context_windows`
     * 缺席）。动态目录与**静态兜底表**两条路径的产物都不带它 —— 静态表照抄的是
     * T1 快照的 `default_context_window`，没有档位表可抄，**不编造**。
     */
    contextTiers?: number[];
    /** 可选思考档位；缺省 = 不声明。 */
    reasoningEfforts?: readonly string[];
    /** 默认档位，必须落在 {@link reasoningEfforts} 内。 */
    defaultReasoningEffort?: string;
}
/**
 * 静态兜底表 → 目录条目（**按 product**）。
 *
 * 这是「目录失败时」的播报来源：国际版含 `lite`、CN 不含
 * （见 {@link qoderFallbackModels} 与模块头的两条路径不对称）。
 *
 * `product` 缺省为国际版 —— 与 `fallbackQoderCatalog()` 原有的零参调用形态
 * 兼容（既有调用点与既有测试一行不改）。
 */
export declare function fallbackQoderCatalog(product?: QoderProduct): QoderModelEntry[];
/**
 * 当前生效的目录：**动态优先，空则回退静态表**。
 *
 * ⚠️ 本函数是「`lite` 只在静态表里」这条不对称规则的**唯一**落点：
 * 只要动态目录拿到了非空结果就直接返回它，**绝不把静态项并进去**（并进去等于
 * 伪造「官方认可 lite」）。调用方不要在别处再写一份合并判断。
 *
 * 传空数组（拉取失败 / 无 `is_enabled` 项）即回退 —— 与「失败不写缓存」配套：
 * 失败根本不会进缓存，故 `undefined` 与 `[]` 在这里等价处理。
 *
 * `product` 决定回退**哪一张**静态表（CN 不含 `lite`），缺省为国际版。
 */
export declare function effectiveQoderCatalog(remote: readonly QoderModelEntry[] | undefined, product?: QoderProduct): QoderModelEntry[];
/** {@link parseQoderDirectory} 的选项。 */
export interface QoderDirectoryParseOptions {
    /**
     * 是否保留 `is_enabled:false` 的项（默认 **false**，即只留官方启用项）。
     *
     * 生产路径**必须**用默认值：定案是「拉取成功时只播报 `is_enabled === true`
     * 的项」。置 true 只用于诊断与测试（核对过滤前后各有多少项）。
     */
    includeDisabled?: boolean;
}
/**
 * 解析 `GET /api/v1/cloud/models` 的响应（**只认实测形态**）。
 *
 * ```json
 * {"data":[{"id":"qmodel_38max","display_name":"Qwen3.8-Max","is_enabled":true,
 *   "is_vl":true,"support_disable_reasoning":false,"price_factor":0.2,
 *   "efforts":["xhigh","low","medium"],"default_effort":"medium",
 *   "max_input_tokens":180000,"default_context_window":200000,
 *   "available_context_windows":[200000,400000,1000000]}, ...],
 *  "has_more":false}
 * ```
 *
 * ## 只读实测路径，不做信封猜测
 *
 * 顶层 `data` 数组、字段名逐字符已知（T1 快照）。与 `parseTraeCnDirectory`
 * 同一纪律：**不猜** `models` / `list` / `result` 等候选键 —— 上游真改版时，
 * 一个**空目录**（回退静态表、用户仍能用）比「猜对形状但读错字段」的半成品
 * 更容易诊断。
 *
 * ## 字段读取规则
 *
 * | 目录字段 | 条目字段 | 规则 |
 * |---|---|---|
 * | `id` | `id` | 去空白后必须非空，否则**跳过该项** |
 * | `display_name` | `name` | 缺省回退 `id` |
 * | `is_enabled` | `enabled` | **只认严格 `=== true`**（见下） |
 * | `is_vl` | `supportsImages` | 布尔才收，缺省 = 未提供 |
 * | `max_input_tokens` | `maxInputTokens` | 正有限数才收 |
 * | `default_context_window` | `contextWindow` | 首选；**272000 这类非整值照收** |
 * | `available_context_windows` | `availableContextWindows` | 正数数组原样保留（非空才收） |
 * | `available_context_windows[0]` | `contextWindow` | 仅当 `default_context_window` 缺席时兜底 |
 * | `available_context_windows` + 默认档 | `contextTiers` | 升序去重，**≥2 档才收**（见 `buildTiers`） |
 * | `efforts` | `reasoningEfforts` | 非空字符串数组（去空白）才收 |
 * | `default_effort` | `defaultReasoningEffort` | **仅当它落在 `efforts` 内**才收（见下） |
 *
 * ## 两处刻意的判据
 *
 * 1. **`is_enabled` 只认严格 `true`**：字段缺失时**不保留**该项。保守方向
 *    与「目录是官方启用集」一致 —— 上游若改名该字段，结果是空目录 → 回退静态表
 *    （用户仍能用），而不是把 17 项（含必然 402 的 tier 名）整批放出去。
 * 2. **`default_effort` 不在 `efforts` 内时只丢默认档、保留档位列表** ——
 *    与 `src/trae-cn-models.ts` 的同名规则逐字一致：声明了却不在列表里的默认档
 *    会被 DSH 判为 `INVALID_MODEL_REASONING` **直接抛错**，把请求打死；
 *    而上游发出不自洽组合时用户仍应能手动选档。
 *
 * @param body - 响应体（非对象 / 缺 `data` 数组时返回空数组）。
 * @param options - 见 {@link QoderDirectoryParseOptions}。
 */
export declare function parseQoderDirectory(body: unknown, options?: QoderDirectoryParseOptions): QoderModelEntry[];
/**
 * 解析**新端点**（设备流 wasm 目录链）的响应：**按 scene 键控的对象**。
 *
 * ```json
 * {"assistant":[{"key":"qmodel_38max","display_name":"Qwen3.8-Max","enable":true,
 *   "is_vl":true,"max_input_tokens":180000,"default_context_window":200000,
 *   "available_context_windows":[200000,400000,1000000],
 *   "efforts":["xhigh","low","medium"],"default_effort":"medium"}, ...]}
 * ```
 *
 * ## 为什么取 `assistant` 键
 *
 * 官方解析器（stage-a 取证 E5）就是 `let u=kg().scene, w=d[u]` —— 键是**请求方
 * `clientMetadata` 的 `scene` 值**，不是什么全局约定。本插件构造上下文时发的
 * `scene` 恒为 {@link QODER_DEFAULT_SCENE}（`assistant`），所以收到的键就是它；
 * 「发送的键」与「读取的键」同源于一个常量，不是两处独立写死的字面量。
 *
 * ## 双形态兼容是刻意的（不是懦弱）
 *
 * 响应先过 wasm `decrypt_server_response`（失败**原样返回** = 明文兼容），
 * 解出来的 JSON 可能是加密形态也可能撞上明文形态。scene 键控对象是新端点的
 * 定案形态（官方解析器只认它）；`{data:[…]}` 是 PAT 端点的形态 —— 解码兜底
 * 场景下两条解析路径都保留，**数据能用就不该因为形态猜测被丢掉**。两者的
 * 字段读取已收敛在 {@link entryFromDirectoryRecord} 一处，不存在两套语义。
 */
export declare function parseQoderSceneDirectory(body: unknown, options?: QoderDirectoryParseOptions): QoderModelEntry[];
/**
 * 新端点（设备流 wasm 目录链）的路径常量（官方 `JHA`，两区逐字相同）。
 *
 * ⚠️ **不含 `/algo` 前缀**：前缀由 wasm `prepareRequest` 内部拼（官方
 * service-account 分支才用 JS 侧拼，普通账号分支的 URL 直接来自 wasm），
 * 调用方拿 `prepareGetRequest` 的产物原样发。
 */
export declare const QODER_DEVICE_MODELS_PATH = "/api/v2/model/list?Encode=1";
/** {@link fetchQoderDirectory} 的入参。 */
export interface QoderDirectoryOptions {
    /** 注入 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /** 覆盖目录基址（默认 `product.modelsBase`，**仅 PAT 路径**）。 */
    modelsBase?: string;
    /** 产品配置；默认 `QODER`。 */
    product?: QoderProduct;
    /** 取消信号。 */
    signal?: AbortSignal;
    /**
     * 设备流令牌的 wasm 目录签名链（`dt-` 路径必需）。
     *
     * ⚠️ 省略时 `dt-` 凭据**不发任何请求**（直接回空数组 + onDebug 提示）：
     * 设备流令牌打 PAT 目录端点恒 401（本任务的总根因），继续发是白打。
     */
    deviceSigning?: QoderDirectorySigningSource;
    /** 调试观测回调（目录链失败原因，debug 级；省略时静默）。 */
    onDebug?: (message: string) => void;
}
/**
 * 拉取动态模型目录（**按令牌族分派**）。
 *
 * ## 两条路径（互不顶替）
 *
 * | 令牌族 | 路径 | 证据 |
 * |---|---|---|
 * | `dt-`（设备流） | wasm 签名 `GET {inferenceHost}/algo/api/v2/model/list?Encode=1` | stage-a 结论 B（官方客户端即此路径）；`dt-` 打 PAT 端点恒 401 |
 * | `pt-`（PAT） | `GET {modelsBase}/api/v1/cloud/models`（**一行不动**） | T1 实测 200；既有回归用例钉死 |
 *
 * 判据是 {@link isQoderDeviceToken}（前缀 `dt-`），显式列举不分「其它前缀
 * 反推 PAT」—— 分派错误的表现是「凭据失效」的假象，比白打一次请求难查得多。
 *
 * ## 失败语义：返回空数组，**绝不抛错**
 *
 * 两条路径一致：任何网络失败、非 2xx、响应不是 JSON、解析失败，一律返回 `[]`，
 * 由调用方回退静态表。抛错只会让一次目录抖动升级成「模型选择器整块炸掉」。
 *
 * ⚠️ **只认 HTTP 2xx 才算成功**：401（PAT 失效）/ 403（签名未对齐，`101`）
 * 都走这条「空目录」路径，本模块**不解释错误**，只经 `onDebug` 报原因
 * （debug 级），错误分类属 `src/qoder-errors.ts`。
 *
 * ## 返回的是**已过滤**的目录
 *
 * 只含启用项（PAT 端点 `is_enabled === true` / 新端点 `enable === true`），
 * 且**不含 `lite`**（它不在目录里）。调用方拿到非空结果即可直接播报。
 */
export declare function fetchQoderDirectory(credential: QoderCredential, options?: QoderDirectoryOptions): Promise<QoderModelEntry[]>;
/**
 * 12h TTL 的目录缓存（成功才写，失败不写也不清）。
 *
 * ## 两个读口，语义不同（不要混）
 *
 * | 方法 | 返回 | 用途 |
 * |---|---|---|
 * | {@link QoderCatalogStore.fresh} | 仅**未过期**时有值 | `ensureCatalog` 判断「要不要重新拉」 |
 * | {@link QoderCatalogStore.entries} | 有值即返回（**含已过期**） | 播报 / 解析——网络抖动时不打回静态表 |
 *
 * 分开的原因是 trae-cn 已验证的行为约定：**一次网络抖动不该把目录打回静态表**。
 * 若只留一个「过期即 undefined」的读口，TTL 到点后的那次失败刷新会让目录
 * 从「上次成功的完整目录」直接掉到静态表（国际版 3 项 / CN 2 项）——
 * 用户看到模型列表突然变短。
 *
 * ## 失败不写缓存
 *
 * {@link QoderCatalogStore.store} 对**空数组是 no-op** —— 这是「失败不写缓存」
 * 的**唯一执行点**（`fetchQoderDirectory` 用空数组表达一切失败）。缓存里因此
 * 永远不会出现「空目录」这种状态，调用方不必区分「没拉过」与「拉过但没结果」。
 *
 * `now` 可注入，使 TTL 判定可确定性单测（不需要 fake timers）。
 */
export declare class QoderCatalogStore {
    private readonly ttlMs;
    private readonly now;
    private cached?;
    constructor(ttlMs?: number, now?: () => number);
    /** TTL **内**的目录；冷缓存或已过期时 undefined。 */
    fresh(): readonly QoderModelEntry[] | undefined;
    /** 最近一次成功写入的目录（**已过期也返回**）；从未成功过时 undefined。 */
    entries(): readonly QoderModelEntry[] | undefined;
    /** 写入目录；**空数组是 no-op**（失败不写缓存，也不清掉已有缓存）。 */
    store(entries: readonly QoderModelEntry[]): void;
    /** 丢弃缓存（下次必重新拉取）；供登出 / 测试使用。 */
    clear(): void;
}
/**
 * 目录失败的**负缓存 TTL**（5 分钟，E1）。
 *
 * 设备流目录链失败（403 签名未对齐 / 网关抖动 / wasm 不可用）后，下一次
 * `model.list` / `resolveModel` / `contextTiers` 都会再触发一次 `ensureCatalog`
 * —— 每次都白打一个注定失败的请求。短 TTL 的内存态负缓存把重试风暴压到
 * 5 分钟一次。
 *
 * ⚠️ **内存态，不写盘**：失败原因多半是瞬时或环境性的，持久化负缓存会让
 * 「用户修好了环境但目录五分钟不恢复」变成跨重启的谜题。
 */
export declare const QODER_DIRECTORY_NEGATIVE_TTL_MS: number;
/**
 * 目录失败的内存态负缓存（短 TTL，**独立于** {@link QoderCatalogStore}）。
 *
 * ⚠️ **不碰 `QoderCatalogStore` 的「失败不写缓存、不清已有缓存」契约**：
 * 负缓存是独立字段/时间戳，`entries()` 语义原样 —— 负缓存期间旧目录（若有）
 * 仍然可用，只是「重新拉取」这个动作被压住。
 *
 * `now` 可注入（与 `QoderCatalogStore` 同一口径，TTL 判定可确定性单测）。
 */
export declare class QoderDirectoryNegativeCache {
    private readonly ttlMs;
    private readonly now;
    private until?;
    constructor(ttlMs?: number, now?: () => number);
    /** 负缓存生效中（期限内不重拉目录）。 */
    get blocked(): boolean;
    /** 记一次失败（从现在起 TTL 内不重拉）。 */
    mark(): void;
    /** 清除（目录成功后调用；登出 / 测试用）。 */
    clear(): void;
}
//# sourceMappingURL=qoder-models.d.ts.map