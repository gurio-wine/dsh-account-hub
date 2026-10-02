/**
 * Buddy (腾讯 Buddy CN / Buddy) 认证服务
 *
 * 管理 external-link-v2 轮询式登录、凭据存储与 RefreshScheduler 静默续期，
 * 结构与 CodeArtsAuth 保持一致（同样的调度语义、同样的登出竞态保护）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type BuddyLoginFlowOptions } from './buddy-oauth.js';
import type { BuddyRemoteModel } from './buddy.js';
import { AccountPool } from './account-pool.js';
import { type BuddyProduct } from './product.js';
/**
 * Buddy CN 的登录结果存储所用的凭据引用。
 *
 * 直接取自 `BUDDY_CN.defaultCredentialRef`（产品配置是唯一真相源），保留此
 * 导出仅为兼容既有导入方；新代码请改用 `BuddyAuth` 实例的 `credentialRefName`
 * 字段（随产品变化）。
 */
export declare const BUDDY_CREDENTIAL_REF: string;
/** 一次成功登录的结果。 */
export interface BuddyLoginResult {
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
export interface BuddyLoginStatus {
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
        buddyCnAuth: BuddyAuth;
        /**
         * Buddy（国际版）的认证服务实例。
         *
         * 与 `buddyCnAuth`（Buddy CN）并列存在：cordis 的 `Service` 构造时按名称
         * 注册，同名第二次注册会抛 `service "buddyCnAuth" has been registered`，
         * 故两个产品必须各占一个服务名。
         */
        buddyAuth: BuddyAuth;
    }
}
/** Buddy 登录服务：轮询式登录 + refresh_token 静默续期。 */
export declare class BuddyAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置（Buddy CN 或 Buddy）。 */
    readonly product: BuddyProduct;
    /**
     * 本实例默认读写的凭据 ref 名称。
     * Buddy CN 为 `BUDDY_CN_ACCESS_TOKEN`，Buddy 为 `BUDDY_ACCESS_TOKEN`；
     * 两个产品各自读写自己的 ref，凭据互不可见。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    constructor(ctx: Context, options?: {
        fetcher?: typeof fetch;
        product?: BuddyProduct;
        serviceName?: string;
    });
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
    private markRefreshTokenInvalid;
    /** 运行登录流程并持久化凭据。 */
    login(flowOptions?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & BuddyLoginFlowOptions): Promise<BuddyLoginResult>;
    /**
     * 保存凭据并注册到账号池（供后台登录流程使用）。
     * 账号池已预先创建占位条目时，只做凭据写入和更新。
     *
     * ## 归属闸门在这里同样必须过（本方法是 buddy 系的**第二条**写凭据入口）
     *
     * `runBuddyLoginFlow` 是正常登录链的产出点（闸门已在它返回处），但本方法
     * 接受**任意** `credentialJson` 直接落盘 —— 它是一条独立入口，不经过那条链。
     * 不设闸门就等于留了一条「绕过校验写凭据」的路：将来任何调用方（或误用）
     * 都能把国际版凭据写进 CN 的 ref，正是本次要堵的缺口形态。
     *
     * 判定放在 `ctx.credentials.set` **之前** —— 这就是「错配时凭据不落盘」的
     * 实现方式。与登录链共用同一份判据（`credential-ownership.ts`），不存在
     * 两处标准不一致的可能。
     *
     * @throws {CredentialProductMismatchError} 凭据被确凿判定属于另一个产品。
     */
    saveCredential(credentialJson: string, refName: string, accountId: string, pool: AccountPool): Promise<void>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<BuddyLoginStatus>;
    /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
    refresh(): Promise<void>;
    /**
     * 用给定凭据换新令牌并合并字段（不触碰存储、调度器与错误状态）。
     *
     * 抽出来供 {@link refresh} 与 {@link refreshAccountCredential} 共用，
     * 避免两处各写一遍「换 token → 合并字段」而逐渐分叉。
     */
    private refreshCredential;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（这是修复既有缺陷的关键）：
     * - `refresh()` 读写的是本实例的**默认单凭据 ref**（如 `BUDDY_CN_ACCESS_TOKEN`），
     *   而 Account Hub 的账号卡片对应的是 `BUDDY_CN_ACCOUNT_XXX` ——
     *   用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据；
     * - 本方法也**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     *   那些状态属于「单凭据路径」，被多账号操作污染会让 UI 显示错误的失效提示。
     */
    refreshAccountCredential(refName: string): Promise<void>;
    /**
     * 批量续期本产品的所有账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
     * **自动选号**，不该让凭据烂掉。早期实现是 `if (!entry.enabled || !entry.refreshable)`，
     * 停用账号被跳过续期，refresh_token 一路放到失效 —— 用户重新启用后拿到的是
     * 一个死凭据，**无法自动恢复**，只能重新登录（真实缺陷）。
     *
     * 单账号失败不影响其他账号。
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
     * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
     * 失败或未登录时返回空数组（调用方回退到内置列表）。
     *
     * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
     *
     * **关键**：两处调用都必须把 `this.product` 传给 `fetchModels`，否则
     * Buddy 实例（Task 7 的 `fetchRemoteModels: () => buddy.fetchModels(pool)`）
     * 会以 `X-Product-Code: codebuddy` + Buddy CN 的 UA 请求 /v3/config，
     * 即携带另一个产品的身份标识。
     */
    fetchModels(pool?: AccountPool): Promise<BuddyRemoteModel[]>;
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
}
//# sourceMappingURL=buddy-auth.d.ts.map