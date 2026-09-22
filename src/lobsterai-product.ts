/**
 * LobsterAI（有道龙虾）产品配置。
 *
 * ## 为什么不复用 `BuddyProduct`
 *
 * `src/product.ts` 的 `BuddyProduct` 是**围绕 Buddy 系协议**设计的，
 * 它的这些字段对 LobsterAI 完全无意义：
 *
 * - `productCode` / `attributionName` / `clientVersion` / `cliVersion`
 *   —— LobsterAI 不发 `X-Product*` / `X-IDE-*` 归属头，
 *   只发 `X-LobsterAI-Client-*`；
 * - `apiDomain`（`X-Domain` 头）—— 无此头；
 * - `userAgentByModelFamily` —— 那是腾讯后台按 UA 归因的机制；
 * - `appendSessionParams` / `pluginVersion` —— Buddy（国际版）登录 URL 的后缀参数。
 *
 * 且 `BuddyProduct.id` 是字面量联合 `'buddy-cn' | 'buddy'`，加第三个值会牵动
 * `productById` / `registerBuddyLlm` / `reconcileWithFallback` 一串调用点。
 *
 * 因此这里定义**平行**的 `LobsteraiProduct`：共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - API 基址 / 版本号接口：`lobsterai2api/sigin.py:10-11`（实测可用）；
 * - 端点路径与请求头：`lobsterai2api/internal/upstream/client.go`；
 * - 兜底模型表：`lobsterai2api/internal/server/handler.go:94-114`
 *   （注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」）；
 * - portal 基址：本次实测确认（见下）。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **2026-09-19 起字段语义已变**：早期版本据 `handler.go:94-114` 认为
 * 远端只返回 `modelId`/`modelName`/`provider`/`apiFormat`，于是把窗口与推理等级
 * 当作**纯本地估计值**。真机复测证明该认识是错的 —— 远端响应实际还带
 * `contextWindow` / `supportsThinking` / `thinkingConfig` / `requestCapabilities`
 * 等字段，本表因此改为**照抄真机值**，与 Buddy 侧语义一致（远端权威、本地兜底）。
 */
export interface LobsteraiFallbackModel {
  /** 模型 ID（传给 `POST /api/proxy/v1/chat/completions` 的 `model`）。 */
  id: string
  /** 展示名（真机 `modelName`）。 */
  name: string
  /**
   * 上下文窗口（真机 `contextWindow`，权威值）。
   *
   * **可选**：真机有 9 个条目该字段为 `null`（老一代模型），此时**不声明** ——
   * 编一个数出来会让选择器显示错误的容量，而 DSH 在缺失时本就不显示。
   */
  contextWindow?: number
  /**
   * 可选思考档位（**发给服务端的 wire 值** `thinkingConfig.options[].openclawLevel`，
   * 逐字符照抄）。
   *
   * ⚠️ **wire 值是 `openclawLevel`，不是 `level`**（上游 commit 9669ee4 真机定案）：
   * 远端 `options[]` 每项同时含 `level`（产品侧档位名，有 `max`）与
   * `openclawLevel`（发给服务端的 `reasoning_effort` 取值，**无 `max`**）；
   * 远端把 `level:'max'` 映射到 `openclawLevel:'xhigh'`。实测直接发
   * `reasoning_effort:'max'`（level 值）与不带参数**无差异**（走服务端默认），
   * 发 `'xhigh'` 才真正触发最高档 —— 因此本表存的是 `openclawLevel`。
   *
   * ⚠️ **`off` 保留在列表、不过滤**：关掉思考（`reasoning_effort:'off'`）要求
   * `X-LobsterAI-Client-Capabilities` 头含 `thinking-level-control-v1`
   * （见 {@link LOBSTERAI_CLIENT_CAPABILITIES}），带上即正常；只发
   * `kimi-k3-agentic-v1` 时才 HTTP 500。本仓已同步该头，off 档可用。
   *
   * 空/缺省 = **不暴露选择器**：DSH 的模型选择器只读 `resolveModel().reasoning`，
   * 不声明时该行不渲染（与 `src/trae-cn-adapter.ts` 同约定）。
   */
  reasoningEfforts?: readonly string[]
  /**
   * 默认档位（**wire 值** `openclawLevel`，由真机 `thinkingConfig.defaultLevel`
   * 经 `options` 映射得到），**必须**在 {@link reasoningEfforts} 内。
   *
   * DSH 的 `resolveCallInfo` 会在调用方省略 `reasoningEffort` 时把它
   * materialize 进请求 —— 与真机网页版「默认档」语义一致。
   */
  defaultReasoningEffort?: string
}

/**
 * 上游 API 基址。
 *
 * `sigin.py:10` 硬编码 `https://lobsterai-server.youdao.com`；Go 侧被
 * 脱敏成 env `LB2A_UPSTREAM_BASE`（无编译期默认值）。
 * 本插件按文档 §0.2b 的结论固化在常量里 —— 插件面向终端用户，
 * 不应要求用户自行提供域名。
 */
export const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'

/**
 * 登录 portal 基址。
 *
 * 实测（见文档 §0.2b）：与 `LOBSTERAI_API_BASE` **同一 IP、同一 CNAME 目标**
 * （`pub-g1-gz.alb.ntes53.netease.com`），说明是同一套服务的不同路径；
 * 访问 `{portalBase}/portal` 返回 HTTP 200，页面标题
 * 「LobsterAI - 全场景个人助理 Agent」，与 `cmd/login/main.go:226` 拼出的
 * `{portal}/portal#/login?...` 路径吻合。
 *
 * 之所以仍与 `apiBase` 分成两个字段：Go 侧本就是两个独立 env，
 * 且不排除未来门户与 API 分离部署。
 */
export const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'

/**
 * 客户端版本号查询端点（第三方域名）。
 *
 * 注意该响应**不是**统一信封：`code`/`msg` 在**外层**，载荷在 `data.value`。
 * 实测（2026）返回 `version: "2026.9.4"`（日期式版本号）。
 */
export const LOBSTERAI_CLIENT_VERSION_API
  = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'

/**
 * 无法动态取到版本号时的兜底值。
 *
 * `sigin.py:73-76` 在取不到版本号时**整个脚本放弃签到**；本插件比它宽容：
 * 用这个兜底值继续尝试，并在日志里警告。理由是宁可用一个稍旧的版本号试，
 * 也别让用户完全无法签到 —— 后端对 `version` 并不强校验
 * （反证：Go 侧一直发假值 `0.1.0` 也未导致失败）。
 *
 * 取值来自 2026 年实测的最后一个已知版本；随着客户端更新会逐渐变旧。
 */
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.9.4'

/**
 * 客户端能力声明（`X-LobsterAI-Client-Capabilities` 头）。
 *
 * 两个能力**都必须声明**，各自解决一个具体问题（2026-09-17 真实凭据实测，
 * 上游 commit 9669ee4 真机定案）：
 *
 * - `kimi-k3-agentic-v1`：**模型列表的准入条件**。不带该能力时
 *   `/api/models/available` 只返回 25 个模型且**没有 `kimi-k3`**；带上才 26 个。
 *   该值来自 `internal/upstream/client.go:99` 的硬编码。
 * - `thinking-level-control-v1`：**思考档位协议的前提**。`reasoning_effort`
 *   的常规档位（low/high/max/xhigh）不需要它，但 `"off"`（关闭思考）
 *   在**不带**该能力时服务端直接 HTTP 500（`{"code":500,"message":"服务器内部错误"}`），
 *   带上则正常返回。也就是说「关掉思考」这条协议要先声明支持它。
 *
 * 顺序无关（两种顺序都实测通过），但保持与 IDE 的
 * `LOBSTERAI_CLIENT_CAPABILITIES`（`modelRuntimeProfiles.js`）一致的排列。
 */
export const LOBSTERAI_CLIENT_CAPABILITIES
  = 'kimi-k3-agentic-v1,thinking-level-control-v1'

/**
 * User-Agent。
 *
 * 原样照抄 `client.go:21` 的 `clientUA = "LobsterAI/0.1.0"`。
 *
 * **刻意不跟着真版本号改**：Go 侧用这个 UA 是实测可用的，而
 * `X-LobsterAI-Client-Version` 头用真值 `2026.9.4`（见下方说明）。
 * 若同时改两处，一旦服务端行为变化将无法归因是哪一个导致的，
 * 故先只改有确定依据的那一个（版本头），UA 待单独实测。
 */
export const LOBSTERAI_USER_AGENT = 'LobsterAI/0.1.0'

/**
 * LobsterAI 产品配置。
 *
 * 与 `BuddyProduct` 平行，字段全部为 LobsterAI 实际需要的。
 */
export interface LobsteraiProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'lobsterai'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 登录门户基址（不含 `/portal` 路径）。 */
  portalBase: string
  /** 上游 API 基址（不含路径）。 */
  apiBase: string
  /** 客户端版本号查询端点。 */
  clientVersionApi: string
  /** 版本号动态拉取失败时的兜底值。 */
  fallbackClientVersion: string
  /** `User-Agent` 头取值。 */
  userAgent: string
  /** `X-LobsterAI-Client-Capabilities` 头取值。 */
  clientCapabilities: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底模型目录。 */
  fallbackModels: readonly LobsteraiFallbackModel[]
}

/**
 * 兜底模型目录（27 个）。
 *
 * **来源：2026-09-19 真机 `GET /api/models/available` 实测拉取**（用账号池凭据
 * 直连上游），逐字段照抄：`modelId` → `id`、`modelName` → `name`、
 * `contextWindow` → `contextWindow`、`thinkingConfig.options[].openclawLevel`
 * → `reasoningEfforts`、`defaultLevel` 经 options 映射成 wire 值 →
 * `defaultReasoningEffort`。**思考档位一律存 wire 值 `openclawLevel`**（含保留
 * `off`），`level:'max'` 映射为 `'xhigh'`（上游 commit 9669ee4 真机定案）。
 *
 * 早期版本照抄的是 `lobsterai2api/internal/server/handler.go:94-114` 的
 * `staticModels`（注释标明 2026-08-06 拉取），那份表**已过时**：19 项里
 * 少 9 项、多 1 项，且把窗口统一填成 `131072`。两处差异：
 *
 * - **新增 9 项**：`deepseek-flash`（DeepSeek-V4.1-Flash，真机第 1 项）、
 *   `glm-5.3` 系 3 项、`qwen3.8` 系 3 项、`doubao-seed-2-1-pro-260915`、
 *   `deepseek-v4-flash-vision-exp`；
 * - **移除 1 项**：`doubao-seed-2-1-pro-260628`（真机已下架，改名成
 *   `…-260915`）。
 *
 * 顺序**照抄真机返回顺序**，不重排 —— 它是上游的权威顺序，重排会让
 * 「与上游对比」这类排查工作失去可比性。
 */
const LOBSTERAI_FALLBACK_MODELS: readonly LobsteraiFallbackModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'xhigh' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'xhigh' },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'xhigh' },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 1_000_000 },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 1_000_000 },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 1_000_000 },
  { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash', contextWindow: 1_000_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', contextWindow: 262_144 },
  { id: 'doubao-seed-2-1-pro-260915', name: 'Doubao-Seed-2.1-Pro', contextWindow: 256_000 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'high' },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 1_000_000 },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 1_000_000 },
  { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus' },
  { id: 'qwen3.5-plus-2026-04-20', name: 'Qwen3.5-plus' },
  { id: 'kimi-k2.7-code-highspeed', name: 'Kimi-K2.7-Code-Highspeed', contextWindow: 262_144 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, reasoningEfforts: ['off', 'high', 'xhigh'], defaultReasoningEffort: 'xhigh' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo' },
  { id: 'glm-5', name: 'GLM-5' },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao-Seed-2.1-Turbo', contextWindow: 256_000 },
  { id: 'doubao-seed-2-0-code-preview-260215', name: 'Doubao-Seed-2.0-Code' },
]

/**
 * LobsterAI provider 配置。
 *
 * 与 Buddy CN / Buddy 并列的第三个产品线，但**协议完全不同**：
 * 它不走腾讯的 external-link 轮询登录，而是本地回调 + `authCode` 换 token。
 */
export const LOBSTERAI: LobsteraiProduct = {
  id: 'lobsterai',
  displayName: 'LobsterAI',
  portalBase: LOBSTERAI_PORTAL_BASE,
  apiBase: LOBSTERAI_API_BASE,
  clientVersionApi: LOBSTERAI_CLIENT_VERSION_API,
  fallbackClientVersion: LOBSTERAI_FALLBACK_CLIENT_VERSION,
  userAgent: LOBSTERAI_USER_AGENT,
  clientCapabilities: LOBSTERAI_CLIENT_CAPABILITIES,
  defaultCredentialRef: 'LOBSTERAI_ACCESS_TOKEN',
  fallbackModels: LOBSTERAI_FALLBACK_MODELS,
}

/** 全部 LobsterAI 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOBSTERAI_PRODUCTS: readonly LobsteraiProduct[] = [LOBSTERAI]

/**
 * 按 provider id 取 LobsterAI 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（Buddy 系）分开：两者返回**不同类型**，
 * 合并成一个函数会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function lobsteraiProductById(id: string): LobsteraiProduct | undefined {
  return ALL_LOBSTERAI_PRODUCTS.find((product) => product.id === id)
}
