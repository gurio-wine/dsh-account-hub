/**
 * Trae CN（字节跳动 Trae 国内版）认证服务。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/buddy-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期、同样的两段式 `prepareLogin` /
 * `persistLoginResult`。这是本插件已被三个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与另外两条协议线的实质差异只有两处：
 *
 * 1. **续期端点是 `ExchangeToken`**（不是 `/refresh`）：body 四字段
 *    `{ClientID, ClientSecret, RefreshToken, UserID}`，且 `UserID` **必填** ——
 *    它来自凭据的五件套，故续期前必须先解析出 `user_id`，缺失时只能让用户重新登录。
 *    注意这与**登录**的 authCode 交换**不是同一个端点**：续期在
 *    `cloudide/api/v3/trae/oauth/ExchangeToken`，登录在
 *    `trae/api/v3/oauth/ExchangeToken`（见 `src/trae-cn-oauth.ts` 模块头）。
 * 2. **access token 用法是 `Authorization: Cloud-IDE-JWT`**（不是 `Bearer`），
 *    另带 `X-Ide-Token` / `X-Cloudide-Token` 两个同值头。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type TraeCnProduct } from './trae-cn-product.js';
import { type TraeCnCredential, type TraeCnLoginFlowOptions, type TraeCnLoginFlowResult, type TraeCnLoginPrepareOptions, type TraeCnLoginPrepareOutcome } from './trae-cn-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与 `buddy-oauth.ts` / `oauth.ts` / `lobsterai-auth.ts` 同名类**刻意是各自独立的类**：
 * `src/refresh.ts` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果。 */
export interface TraeCnLoginResult {
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
export interface TraeCnLoginStatus {
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
         * Trae CN 的认证服务实例。
         *
         * 与 `buddyCnAuth` / `buddyAuth` / `codeartsAuth` / `lobsteraiAuth` 并列。
         * **服务名刻意不是 `${product.id}Auth`**：product.id 为 `trae-cn`，
         * 机械派生会得到 `trae-cnAuth`（带连字符，需用 `ctx['trae-cnAuth']` 访问）。
         * 服务名由产品配置的 `serviceName` 显式给出 `traeCnAuth`，
         * 详见 `src/trae-cn-product.ts` 的说明。
         */
        traeCnAuth: TraeCnAuth;
    }
}
/** `TraeCnAuth` 的构造选项。 */
export interface TraeCnAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link TRAE_CN}。 */
    product?: TraeCnProduct;
    /**
     * 服务名覆盖；默认取 `product.serviceName`（即 `traeCnAuth`）。
     *
     * 保留这个覆盖口是为了让「产品 id」与「服务名」彻底解耦：产品 id 可以
     * 任意更名而不牵动服务标识符，测试也能在同一 Context 上挂多个实例。
     */
    serviceName?: string;
}
/**
 * Trae CN 认证服务：loopback 回调登录 + `ExchangeToken` 静默续期。
 */
export declare class TraeCnAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: TraeCnProduct;
    /**
     * 本实例默认读写的凭据 ref 名称（`TRAE_CN_ACCESS_TOKEN`）。
     *
     * 由产品配置派生，与另外四个 provider 的 ref 完全隔离。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    constructor(ctx: Context, options?: TraeCnAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
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
    } & Partial<TraeCnLoginFlowOptions>): Promise<TraeCnLoginResult>;
    /** 把回调诊断写进宿主日志（T5 校准用；内容已脱敏，见 trae-cn-oauth.ts）。 */
    private logCallbackDebug;
    /**
     * 两段式的**第一段**：准备一次登录，返回登录 URL 与会话句柄。
     *
     * 只做「起本地回调服务器」，**不打开浏览器、不等待用户**。
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
    prepareLogin(options?: Partial<Omit<TraeCnLoginPrepareOptions, 'product'>>): Promise<TraeCnLoginPrepareOutcome>;
    /**
     * 两段式的**第二段**：把一个已完成的登录结果落盘（凭据 + 账号池）。
     *
     * 时序约束（不可调换）：
     * 1. `expiresAt` / `refreshable` / `nickname` 都来自登录结果，
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
     */
    persistLoginResult(flow: TraeCnLoginFlowResult, options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<TraeCnLoginResult>;
    /**
     * 用**已有的 refreshToken** 完成登录（供 e2e 探针与「粘贴凭据」场景使用）。
     *
     * 与 {@link login} 的区别：不起回调服务器，直接走**续期端点**
     * （`cloudide/api/v3/trae/oauth/ExchangeToken`）。保留这个入口是为了让 e2e
     * 探针能在不打开浏览器的情况下验证续期链路。
     *
     * ⚠️ 它**不是**登录协议的主路径：真机登录走的是 PKCE → `authCodeInfo` →
     * `trae/api/v3/oauth/ExchangeToken`（见 `src/trae-cn-oauth.ts` 模块头）。
     * 这里拿不到 exchange 响应的 `BoundDeviceID`，故凭据的 `device_id` 只能取
     * 续期响应里自带的设备字段（通常为空）。
     *
     * ⚠️ **本入口造的凭据也缺签到设备号**（`checkin_device_id` 为空）：签到用的
     * 16 位号只在登录 URL 里生成，本入口没有登录 URL。签到侧会**如实降级**为
     * `BoundDeviceID`（见 `traeCnCheckinDeviceId`），而该值不被活动系统认可 ——
     * 故**要签到就得走浏览器登录**，这一点在 2026-09-20 的 9074 定案后更明确了。
     */
    loginWithRefreshToken(refreshToken: string, options?: {
        userId?: string;
        machineId?: string;
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<TraeCnLoginResult>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<TraeCnLoginStatus>;
    /**
     * 静默续期：`ExchangeToken` 用 refreshToken + userID 换新 access token。
     *
     * 终态判定：
     * - HTTP 401/403、或响应里找不到 access token → 抛
     *   {@link RefreshTokenExpiredError}，让调度器停止续期；
     * - 网络失败、5xx、429 → 抛普通 Error，走调度器的可重试路径。
     *   （`exchangeTraeCnToken` 已按这个口径分类：传输层失败与 HTTP 错误
     *   都是普通 Error，只有「调用方判定的终态」才升级成上面那个类。）
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与另外三个 provider 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`TRAE_CN_ACCESS_TOKEN`），
     * 而 Account Hub 账号卡片对应的是 `TRAE_CN_ACCOUNT_XXX` ——
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
     * 单账号失败不影响其他账号（与另外几个 provider 同语义）。
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
    resolveStoredCredential(): Promise<TraeCnCredential | undefined>;
    /**
     * 构造带 Trae 鉴权的请求头（供后续的 LLM 适配器 / 签到模块复用）。
     *
     * `Accept` 可切换成 `text/event-stream` 供流式对话使用；
     * 鉴权三头（`Authorization` / `X-Ide-Token` / `X-Cloudide-Token`）不变。
     */
    accessHeaders(credential: TraeCnCredential, accept?: string): Record<string, string>;
    /** 控制面请求超时（毫秒）；供后续模块复用，避免各自写一份常量。 */
    get requestTimeoutMs(): number;
}
//# sourceMappingURL=trae-cn-auth.d.ts.map