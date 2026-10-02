/**
 * 腾讯 Buddy CN 认证常量、凭据结构与纯解析逻辑
 *
 * 逆向自 CodeBuddy CN IDE (genie 扩展 v4.11.2) 的 external-link-v2 轮询式登录：
 * - fetchAuthState → POST /v2/plugin/auth/state?platform=ide 获取 state + authUrl
 * - openAuthUrl    → 打开浏览器到 https://www.codebuddy.cn/login/?platform=ide&state=...
 * - loopGetToken   → GET /v2/plugin/auth/token?state=... 轮询获取 token（1s 间隔，5min 超时）
 * - getAccount     → GET /v2/plugin/login/account?state=... 轮询获取账户信息
 * - refreshToken   → POST /v2/plugin/auth/token/refresh 刷新 token
 *
 * 与 CodeArts 的 PKCE OAuth + 本地回调服务器不同，Buddy 系采用**轮询式**：
 * 客户端不起本地服务器，而是定期轮询后端 API 检查登录状态。
 *
 * 本模块只放常量与纯函数（无网络、无存储），网络流程见 buddy-oauth.ts。
 *
 * 依赖方向：本模块从 `src/product.ts` 读取 Buddy CN 的产品差异取值（只读，
 * 不反向导出）。`product.ts` 不 import 本模块，故不构成循环依赖。
 */
/** 主 API 端点（product.json endpoint）。 */
export declare const API_ENDPOINT: string;
/** API 路径前缀（product.json authentication.attributes.prefixPath，两产品相同）。 */
export declare const PREFIX_PATH = "/plugin";
/** 平台标识（product.json authentication.attributes.platform）。 */
export declare const PLATFORM: string;
/** 登录网站首页（copilot.tencent.com → www.codebuddy.cn 映射）。 */
export declare const WEBSITE_HOME = "https://www.codebuddy.cn";
/** 获取 auth state 端点：POST /v2/plugin/auth/state?platform=ide */
export declare const AUTH_STATE_PATH = "/v2/plugin/auth/state";
/** 轮询 token 端点：GET /v2/plugin/auth/token?state=... */
export declare const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
/** 轮询账户端点：GET /v2/plugin/login/account?state=... */
export declare const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
/** 刷新 token 端点：POST /v2/plugin/auth/token/refresh */
export declare const AUTH_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** 账户列表端点：GET /v2/plugin/accounts */
export declare const ACCOUNTS_PATH = "/v2/plugin/accounts";
/** 云端配置端点：GET /v3/config（获取模型列表、agents、productFeatures） */
export declare const CONFIG_PATH = "/v3/config";
/** 登录轮询总超时（5 分钟，对齐 IDE 的 5*60*1e3）。 */
export declare const LOGIN_TIMEOUT_MS: number;
/** 轮询间隔（1 秒，对齐 IDE 的 setTimeout(o,1e3)）。 */
export declare const POLL_INTERVAL_MS = 1000;
/** auth/state 请求超时（5 秒，对齐 IDE 的 timeout:5e3）。 */
export declare const STATE_REQUEST_TIMEOUT_MS = 5000;
/** 其余控制面请求超时（token/account/refresh/config）。 */
export declare const REQUEST_TIMEOUT_MS = 60000;
/** token 尚未就绪（loopGetToken 中 continue 轮询）。 */
export declare const CODE_TOKEN_NOT_READY = 11217;
/** 账户信息尚未完成（getAccount 中 continue 轮询）。 */
export declare const CODE_ACCOUNT_NOT_READY = 12151;
export declare const HTTP_HEADER_DOMAIN = "X-Domain";
export declare const HTTP_HEADER_ENTERPRISE_ID = "X-Enterprise-Id";
export declare const HTTP_HEADER_TENANT_ID = "X-Tenant-Id";
export declare const HTTP_HEADER_NO_AUTHORIZATION = "X-No-Authorization";
export declare const HTTP_HEADER_NO_USER_ID = "X-No-User-Id";
export declare const HTTP_HEADER_NO_ENTERPRISE_ID = "X-No-Enterprise-Id";
export declare const HTTP_HEADER_NO_DEPARTMENT_INFO = "X-No-Department-Info";
export declare const HTTP_HEADER_REFRESH_TOKEN = "X-Refresh-Token";
export declare const HTTP_HEADER_AUTH_REFRESH_SOURCE = "X-Auth-Refresh-Source";
export declare const HTTP_HEADER_PRODUCT = "X-Product";
export declare const HTTP_HEADER_PRODUCT_CODE = "X-Product-Code";
/**
 * User-Agent 标识（对齐 IDE 的 getUserAgent() → CodeBuddyIDE/${platformVersion}）。
 * platformVersion 来自 IDE product.json version 字段（1.106.1），非 genie 版本。
 */
export declare const BUDDY_USER_AGENT: string;
/** X-Product-Code 值（对齐 IDE headers 设置）。 */
export declare const BUDDY_PRODUCT_CODE: string;
/** X-Product 默认值（deploymentType，对齐 ProductEndpointHttpInterceptor）。 */
export declare const BUDDY_DEPLOYMENT_TYPE = "SaaS";
/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
export declare const AUTH_REFRESH_SOURCE = "ide-main";
/** API 端点的裸域名（X-Domain 头的值）。 */
export declare const API_DOMAIN: string;
/**
 * 持久化的 Buddy 系凭据。
 *
 * 对齐 IDE 的 auth 对象结构（accessToken/refreshToken/expiresAt/...）
 * 加上 account 对象（uid/nickname/enterpriseId/type）。除两个令牌外的字段
 * 均为可选，以便稳妥解析来自磁盘的旧版/部分凭据。
 */
export interface BuddyCredential {
    /** 访问令牌（Authorization: Bearer <access_token>）。 */
    access_token: string;
    /** 刷新令牌（X-Refresh-Token header）。 */
    refresh_token: string;
    /** token 过期时间（原始值，可能为毫秒时间戳或 ISO 字符串）。 */
    expires_at?: string;
    /** refresh_token 过期时间。 */
    refresh_expires_at?: string;
    /** token 类型（"Bearer"）。 */
    token_type?: string;
    /** OAuth scope（通常为空）。 */
    scope?: string;
    /** API 域名（"copilot.tencent.com"）。 */
    domain?: string;
    /**
     * access_token 这个 JWT 的 `iss` 声明（**签发方**，形如
     * `https://www.workbuddy.ai/auth/realms/copilot`）。仅在解析成功时出现。
     *
     * ⚠️ 这是**凭据归属哪个产品**的权威判据（与 `domain` 不同：`domain` 是登录时
     * 快照、可能被历史迁移漏改，而 `iss` 是签发方写死在令牌里的）。判据本体与
     * 两个消费者（登录链的归属闸门、provider 体检迁移）见
     * `src/credential-ownership.ts`。
     */
    issuer?: string;
    /** 用户 ID（account.uid）。 */
    user_id?: string;
    /** 用户昵称（account.nickname）。 */
    nickname?: string;
    /** 企业 ID（account.enterpriseId，个人版为空）。 */
    enterprise_id?: string;
    /** 账户类型（"personal" / "enterprise"）。 */
    account_type?: string;
}
/** auth/token 与 auth/token/refresh 响应的令牌数据。 */
export interface BuddyToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    refreshExpiresAt: string;
    tokenType: string;
    scope: string;
    domain: string;
}
/** login/account 响应的账户数据。 */
export interface BuddyAccount {
    uid: string;
    nickname: string;
    enterpriseId: string;
    accountType: string;
}
/**
 * 从凭据 expires_at 解析毫秒时间戳（兼容毫秒时间戳 / 秒级时间戳 / ISO 8601）。
 * 无法解析或缺失时返回 undefined。
 *
 * 后备来源（e2e 实证 2026-09-11）：Buddy CN 的 `/v2/plugin/auth/token`
 * **不返回绝对的 `expiresAt`**，只返回相对的 `expiresIn`。若凭据里的
 * `expires_at` 为空（历史写入或后端变更），回退到解析 access_token 这个
 * JWT 的 `exp` 声明——它同样是权威的过期时刻。
 */
export declare function credentialExpiresAtMs(credential: BuddyCredential): number | undefined;
/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 * 仅做 base64url 解码，不验签——该值只用于展示与续期调度。
 */
export declare function jwtExpiresAtMs(token: string): number | undefined;
/**
 * 从 JWT 的 payload 读取 `iss`（签发方 URL）；非 JWT、无该声明或解析失败返回空串。
 *
 * 与 `jwtExpiresAtMs` 同一取舍：只解码不验签。返回值形如
 * `https://www.workbuddy.ai/auth/realms/copilot`。
 */
export declare function jwtIssuer(token: string): string;
/**
 * 从 JWT payload 读取 `nickname`（Buddy CN 的 login/account 响应不含昵称，
 * 昵称只在 access_token 的声明里）。解析失败返回空串。
 */
export declare function jwtNickname(token: string): string;
/** 凭据是否已过期；无法解析过期时间时不判定过期（对齐 Rust is_expired）。 */
export declare function isExpired(credential: BuddyCredential): boolean;
/** 凭据是否携带可静默续期的 refresh_token。 */
export declare function isRefreshable(credential: BuddyCredential): boolean;
/** 构造基础请求头（X-Domain + User-Agent + 可选企业头）。 */
export declare function credentialRequestHeaders(credential: BuddyCredential): Record<string, string>;
/** 构造带 Bearer 令牌的认证请求头。 */
export declare function credentialAuthHeaders(credential: BuddyCredential): Record<string, string>;
/**
 * 从 JSON 解析令牌数据（兼容 camelCase 字段名与数字型时间戳）。
 *
 * e2e 实证（2026-09-11）：`/v2/plugin/auth/token` 实际只返回
 * `expiresIn` / `refreshExpiresIn`（相对秒数），**没有** `expiresAt` /
 * `refreshExpiresAt`。因此这里在绝对字段缺失时用相对秒数换算，
 * 否则凭据的 `expires_at` 会一直是空串（UI 显示"有效期未知"）。
 */
export declare function parseTokenData(data: unknown): BuddyToken;
/**
 * 从 JSON 解析账户数据。
 *
 * `login/account` 响应不含 `nickname`（e2e 实证：只有 uid/nickname 之外的
 * 字段都为空），昵称实际在 access_token 的 JWT 声明里；调用方通过
 * `buildCredential` 时传入 token 以便回填。
 */
export declare function parseAccountData(data: unknown): BuddyAccount;
/**
 * 组合令牌与账户数据为可持久化的凭据。
 *
 * 昵称回填顺序（e2e 实证 2026-09-11：`login/account` 的 `nickname` 常为空，
 * 真正的昵称只在 access_token 的 JWT 声明里）：
 * account.nickname → JWT.nickname → JWT.preferred_username。
 * 过期时间同理：token.expiresAt 为空时由 credentialExpiresAtMs 从 JWT exp 兜底。
 */
export declare function buildCredential(token: BuddyToken, account: BuddyAccount): BuddyCredential;
/** 模型 ID → 人类可读显示名称；未知模型回退为 ID 本身。 */
export declare function displayNameForModel(id: string): string;
/** /v3/config 解析出的单个模型：id、展示名与远端声明的能力。 */
export interface BuddyRemoteModel {
    id: string;
    name: string;
    /**
     * 上下文窗口：**上游真实可服务的最大档**（≈1M）。
     *
     * 取值见 {@link parseModelMeta} 的口径说明：双信号取 `min(maxInputTokens,
     * supportedLengths 最大档)`，只有其一取那个，都无才回退 `defaultLength`。
     * ⚠️ **不是 `defaultLength`** —— 它是纯 UI 默认值、不是硬限（2026-09-21 实测）。
     */
    contextWindow?: number;
    /**
     * **完整的上下文窗口档位表**（上游 `contextWindow.supportedLengths`，
     * 升序去重；**只在真正有两个及以上档位时**存在）。
     *
     * ⚠️ **本节于 2026-09-21 被用户需求推翻**：原口径是「`supportedLengths`
     * 只做最小解析、只取最大正整数，不存整档列表、不做 UI」。用户随后要求把
     * Trae CN 已有的「上下文窗口档位选择」推广到**所有**供应商，而档位选择的前提
     * 就是保留完整档位列表 —— 故改为保留。
     *
     * ⚠️ **出站请求体一个字段都不动（红线）**：本字段与 {@link contextWindow}
     * 同一性质，纯声明值，只喂 `resolveModel().context`（宿主压缩阈值与保留预算）。
     * `buddy-adapter.spec.ts` 有逐字节比对请求体的用例钉死。
     *
     * 缺省 = 该模型**没有档位可选**（无 `supportedLengths`，或表里只有一个值）。
     */
    contextTiers?: number[];
    /**
     * 单次请求输出上限（`data.models[].maxOutputTokens`）。
     *
     * ⚠️ 这是**必须消费**的权威字段，不是仅供参考的元数据：适配器早期把它只当
     * 「过滤补全模型」的判据（见 {@link isChatModel}），却从不下发到请求体，导致
     * 所有 buddy / buddy-cn 模型都退化成网关默认输出上限（实测 32000），大文件
     * 写入与长回答被截断成 `finish_reason: 'length'`、`turn/end` 报 `max-tokens`。
     *
     * 实测（2026-09-19）各端点取值不完全一致：`deepseek-v4.1-flash` 在中国版
     * scoped 端点为 128000、`/v3/config` 为 131072、国际版 `/v3/config` 为 128000。
     * 与 `maxInputTokens` 同策略：采信实际命中的那个端点，**不做跨端点取大**。
     */
    maxOutputTokens?: number;
    /** 是否接受图片输入（data.models[].supportsImages）。 */
    supportsImages?: boolean;
    /** 可选思考等级（data.models[].reasoning.supportedEfforts）；无等级可选的模型缺省。 */
    reasoningEfforts?: string[];
    /** 默认思考等级（data.models[].reasoning.defaultEffort）。 */
    defaultReasoningEffort?: string;
}
/**
 * 从 /v3/config 响应解析可用的对话模型。
 *
 * 响应结构：{data: {agents: [{name: "craft", models: ["auto", ...]}, ...],
 *                     models: [{id, name, maxInputTokens,
 *                               contextWindow?: {defaultLength, supportedLengths},
 *                               supportsImages, reasoning: {...}}],
 *                     productFeaturesConfig?: {ModelTrialBanner: {banners: [{targetModelId}]}}}}
 *
 * 解析策略（顺序即优先级）：
 * 1. **craft agent 引用的模型** —— 主对话模型，排在最前（中国版由它列出
 *    hy4-preview / glm-5.3 等具体 id）。
 * 2. **data.models 中剩余的可对话模型** —— 国际版的 craft 只引用 5 个抽象别名
 *    （default-model/fast-model/…），其余可用模型（如 o4-mini）只出现在
 *    data.models 里；若只取 craft，这些模型会在选择器中消失。
 * 3. **试用模型**（productFeaturesConfig.ModelTrialBanner）—— 例如国际版的
 *    hy4-preview：它既不在 craft 列表也不在 data.models，仅由试用横幅下发，
 *    但实测可正常调用，故一并加入。
 *
 * 过滤规则：跳过 `auto` / `default`（自动选择占位，非真实模型 —— 企业端点会同时
 * 下发这两个内部别名）、非对话用途的模型
 * （`text-to-image` 标签）与补全/NES 等专用模型（id 前缀 nes- / completion-）。
 * 解析失败时返回空数组，调用方回退内置列表。
 */
export declare function parseModelsFromConfig(body: unknown): BuddyRemoteModel[];
//# sourceMappingURL=buddy.d.ts.map