/**
 * LobsterAI（有道龙虾）认证服务。
 *
 * 结构与 `src/buddy-auth.ts` 的 `BuddyAuth` **刻意保持一致**：同样的
 * `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被两个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 Buddy 侧的实质差异只有两处：
 *
 * 1. **续期的终态判定更精确**。Go 版只判「响应里有没有 accessToken」，
 *    会把网络抖动也当成终态而停止续期；本实现按 HTTP 状态码 +
 *    `classifyLobsteraiError` 的 `session-dead` 判定，其余错误交给
 *    `RefreshScheduler` 走可重试路径。
 * 2. **凭据里必须回写 `latest_keyfrom`**（LobsterAI 的续期请求体不是只带
 *    refreshToken，还要带身份字段；见 `lobsteraiRefreshBody`）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LobsteraiClientVersionResolver, type LobsteraiCredential } from './lobsterai.js';
import { type LobsteraiRemoteModel } from './lobsterai-adapter.js';
import { type LobsteraiProduct } from './lobsterai-product.js';
import { type LobsteraiLoginFlowOptions, type LobsteraiLoginFlowResult, type LobsteraiLoginPrepareOptions, type LobsteraiLoginPrepareOutcome } from './lobsterai-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * LobsterAI 的默认凭据 ref。
 *
 * 等价于 `LOBSTERAI.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `LobsterAI.defaultCredentialRef`。
 */
export declare const LOBSTERAI_CREDENTIAL_REF = "LOBSTERAI_ACCESS_TOKEN";
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与 `buddy-oauth.ts` / `oauth.ts` 同名类**刻意是各自独立的类**：
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果。 */
export interface LobsteraiLoginResult {
    /** 已存储的凭据 JSON 字符串。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /** 打开的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** 用于配置界面的只读登录状态。 */
export interface LobsteraiLoginStatus {
    configured: boolean;
    source?: string;
    expiresAt?: number;
    /** 存储的凭据是否可通过刷新令牌静默续期。 */
    refreshable: boolean;
    /** 最近一次刷新失败的原因（如有）。 */
    refreshError?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * LobsterAI 的认证服务实例。
         *
         * 与 `buddyCnAuth` / `buddyAuth` / `codeartsAuth` 并列：
         * cordis 的 `Service` 构造时按名称注册，同名第二次注册会抛
         * `service "..." has been registered`，故每个 provider 各占一个服务名。
         */
        lobsteraiAuth: LobsteraiAuth;
    }
}
/** `LobsteraiAuth` 的构造选项。 */
export interface LobsteraiAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link LOBSTERAI}。 */
    product?: LobsteraiProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `lobsteraiAuth`）。 */
    serviceName?: string;
    /** 客户端版本号解析器；默认为内部新建的实例。 */
    versionResolver?: LobsteraiClientVersionResolver;
}
/**
 * LobsterAI 认证服务：本地回调登录 + refresh_token 静默续期。
 */
export declare class LobsteraiAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: LobsteraiProduct;
    /**
     * 本实例默认读写的凭据 ref 名称（`LOBSTERAI_ACCESS_TOKEN`）。
     *
     * 由产品配置派生，与 Buddy 系的两个 ref 完全隔离。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /** 客户端版本号解析器（带缓存与兜底）。 */
    private readonly versionResolver;
    constructor(ctx: Context, options?: LobsteraiAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /**
     * 解析客户端版本号（带缓存与兜底）。
     *
     * 三个消费点都需要它：登录 exchange 的 `version` 字段、续期请求体的
     * `version`、以及签到接口的必填 query 参数。集中在此避免三处各自拉取。
     */
    resolveClientVersion(): Promise<string>;
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
    private markRefreshTokenInvalid;
    /**
     * 运行完整登录流程并持久化凭据。
     *
     * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
     * （Account Hub 的「+ 新建账号」路径）。
     *
     * **阻塞式**：会一直等到用户在浏览器完成登录（最长 10 分钟）。
     * Account Hub 用的是两段式 {@link prepareLogin} + {@link persistLoginResult}，
     * 以便 RPC 立即返回登录 URL、不阻塞客户端。
     */
    login(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & Partial<LobsteraiLoginFlowOptions>): Promise<LobsteraiLoginResult>;
    /**
     * 两段式的**第一段**：准备一次登录，返回登录 URL 与会话句柄。
     *
     * 只做「起本地回调服务器 + 解析版本号」，**不打开浏览器、不等待用户**。
     * 调用方应立即把 `session.loginUrl` 交给客户端弹窗（用户手势必须发生在
     * 同一轮交互里），随后用 {@link persistLoginResult} 在后台消费
     * `session.awaitCredential()` 的结果。
     *
     * 这里**不写凭据、不动账号池** —— 凭据落盘与占位账号的补全由
     * {@link persistLoginResult} 负责，两者时序必须保持「先跑完流程、
     * 再写凭据、最后补全账号」。
     *
     * 已有进行中的会话时返回 `login-in-progress`（provider 级互斥：
     * 不新建监听、不复用旧会话）；调用方应把该错误原样透传给客户端提示用户。
     */
    prepareLogin(options?: Partial<Omit<LobsteraiLoginPrepareOptions, 'product' | 'clientVersion'>>): Promise<LobsteraiLoginPrepareOutcome>;
    /**
     * 两段式的**第二段**：把一个已完成的登录结果落盘（凭据 + 账号池）。
     *
     * 时序约束（不可调换）：
     * 1. `expiresAt` / `refreshable` / `nickname` 都来自 exchange 结果，
     *    流程返回前无法得知，因此占位账号只能以「pending 形态」存在
     *    （无 `expiresAt`、`refreshable: false`）；
     * 2. 先把凭据写入 `ctx.credentials`，**再**补全账号条目 —— 客户端轮询的
     *    `login.poll` 以「该 ref 能否解析到凭据」为完成判据，反过来（先补全
     *    账号字段再写凭据）会让轮询在凭据就绪前就报成功。
     *
     * `accountId` + `pool` 提供时按账号路径补全；否则落到默认单凭据 ref
     * （{@link login} 走的就是这条）。
     *
     * 不触碰 `active`：那是「登出竞态」的开关（见 {@link refresh}），
     * 由 {@link login} / {@link prepareLogin} 在会话开始时置位。
     * 两段式路径下 `prepareLogin` 已经置位，第二段只需落盘。
     */
    persistLoginResult(flow: LobsteraiLoginFlowResult, options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<LobsteraiLoginResult>;
    /**
     * 用**已有的授权码**完成登录（供需要自行起回调的场景使用）。
     *
     * 与 {@link login} 的区别：不走本地服务器，直接拿 code 换凭据。
     * 保留这个入口是为了让 e2e 探针能在不打开浏览器的情况下验证 exchange。
     */
    loginWithCode(code: string, session: {
        uuid: string;
        firstKeyfrom: string;
    }, options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<LobsteraiLoginResult>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<LobsteraiLoginStatus>;
    /**
     * 静默续期：`refresh_token` + keyfrom 身份载荷换取新令牌。
     *
     * 终态判定（**比 Go 版精确**，见模块头注释）：
     * - HTTP 401/403、或响应体命中 `session-dead` 标记 → 抛
     *   {@link RefreshTokenExpiredError}，让调度器停止续期；
     * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`LOBSTERAI_ACCESS_TOKEN`），
     * 而 Account Hub 账号卡片对应的是 `LOBSTERAI_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     */
    refreshAccountCredential(refName: string): Promise<void>;
    /**
     * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
     *
     * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
     * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
     */
    private refreshCredential;
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
     * **自动选号**，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
     * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
     *
     * 单账号失败不影响其他账号（与 `BuddyAuth.refreshAll` 同语义）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 移除已存储的凭据并停止任何待处理的刷新。 */
    logout(): Promise<void>;
    /** 停止刷新调度（不清理凭据）。 */
    stop(): void;
    /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
    scheduleRefresh(): void;
    /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
    checkExpired(): Promise<boolean>;
    /**
     * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
     *
     * 供 e2e 探针与 `account-probe` 使用（后者实际走 `resolveCredentialForAccount`，
     * 按账号 id 解析，不受 `enabled` 限制）。
     */
    resolveStoredCredential(): Promise<LobsteraiCredential | undefined>;
    /**
     * `GET /api/models/available` → 远端模型列表。
     *
     * 失败或未登录时返回空数组（调用方回退到产品兜底目录），
     * 与 `BuddyAuth.fetchModels` 同语义。
     *
     * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
     * 两处都必须带上 `this.product` 与真实版本号 —— 该端点的 query 是
     * **身份载荷**（keyfrom），发错身份会让服务端返回错误的模型集合。
     *
     * ⚠️ **请求头必须用 `lobsteraiModelsHeaders`**：该端点按
     * `X-LobsterAI-Client-Capabilities` 过滤模型集合，不带时只回 25 个、
     * **没有 `kimi-k3`**（带上回 26 个，上游实测）。基础 4 头的
     * `lobsteraiAuthHeaders` 不够用。
     */
    fetchModels(pool?: AccountPool): Promise<LobsteraiRemoteModel[]>;
}
//# sourceMappingURL=lobsterai-auth.d.ts.map