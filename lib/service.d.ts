import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type CodeartsLoginPrepareOptions, type CodeartsLoginPrepareOutcome } from './login.js';
import type { LoginFlowOptions, LoginFlowResult } from './types.js';
import { AccountPool } from './account-pool.js';
/** CodeArts 登录结果存储所用的凭据引用。 */
export declare const CODEARTS_CREDENTIAL_REF = "CODEARTS_ACCESS_TOKEN";
/** 一次成功登录的结果。 */
export interface LoginResult {
    /** 已存储的凭据值（原始令牌或 JSON 凭据字符串）。 */
    access: string;
    /** 凭据过期的毫秒时间戳。 */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /** 打开的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token（新式 OAuth 流程为 true）。 */
    refreshable: boolean;
}
/** 用于配置界面的只读登录状态。 */
export interface LoginStatus {
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
        codeartsAuth: CodeArtsAuth;
    }
}
/** CodeArts 登录服务：默认新式 IAM OAuth，ticket 流程回退，refresh_token 静默续期。 */
export declare class CodeArtsAuth extends Service {
    private readonly scheduler;
    /** refresh_token 已被后端判定失效（InvalidGrant）；登录/刷新成功时重置。 */
    private refreshTokenInvalid;
    private lastRefreshError;
    /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /** 远端模型列表定时刷新定时器。 */
    private modelRefreshTimer;
    /** 用于测试的可注入 fetch；默认为全局 fetch。 */
    private fetchImpl;
    /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
    private markRefreshTokenInvalid;
    constructor(ctx: Context, options?: {
        fetcher?: typeof fetch;
    });
    /**
     * 运行登录流程（默认新式 OAuth；flow: 'ticket' 走旧流程回退）并持久化凭据。
     *
     * **阻塞式**：会一直等到用户在浏览器完成授权（最长 180 秒）。
     * Account Hub 用的是两段式 {@link prepareLogin} + {@link persistLoginResult}，
     * 以便 RPC 立即返回登录 URL、不阻塞客户端；`/codearts-login` 命令与 e2e
     * 探针等同步调用方继续用这里。
     *
     * 第一段（跑流程拿到 `LoginFlowResult`）与第二段（落盘）已拆开，
     * 本方法只是二者的串联 —— 两段式的后台路径复用同一个第二段。
     */
    login(options?: {
        flow?: 'oauth' | 'ticket';
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    } & LoginFlowOptions): Promise<LoginResult>;
    /**
     * 两段式的**第一段**：准备一次新式 IAM OAuth 登录，返回登录 URL 与会话句柄。
     *
     * 只做「生成 PKCE/DPoP + 起本地回调服务器」，**不打开浏览器、不等待用户**。
     * 调用方应立即把 `session.loginUrl` 交给客户端弹窗（用户手势必须发生在
     * 同一轮交互里），随后用 {@link persistLoginResult} 在后台消费
     * `session.awaitCredential()` 的结果。
     *
     * 这里**不写凭据、不动账号池** —— 凭据落盘与占位账号的补全由
     * {@link persistLoginResult} 负责。
     *
     * 已有进行中的会话时返回 `login-in-progress`（provider 级互斥：
     * 不新建监听、不复用旧会话）；调用方应把该错误原样透传给客户端提示用户。
     */
    prepareLogin(options?: CodeartsLoginPrepareOptions): Promise<CodeartsLoginPrepareOutcome>;
    /**
     * 两段式的**第二段**：把一个已完成的登录结果落盘（凭据 + 账号池）。
     *
     * 时序约束（不可调换）：
     * 1. `expiresAt` / `refreshable` 都来自换取的凭据，流程返回前无法得知，
     *    因此占位账号只能以「pending 形态」存在（无 `expiresAt`、
     *    `refreshable: false`）；
     * 2. 先把凭据写入 `ctx.credentials`，**再**补全账号条目 —— 客户端轮询的
     *    `login.poll` 以「该 ref 能否解析到凭据」为完成判据，反过来（先补全
     *    账号字段再写凭据）会让轮询在凭据就绪前就报成功。
     *
     * `accountId` + `pool` 提供时**按 id 落位**：账号已存在（两段式的占位条目）
     * 就补全，不存在（直接调用 `login()` 的注册路径）就新建 —— 用一次查找
     * 决定走哪条，避免「先 addAccount 占位、第二段再 addAccount 补全」把
     * 同一个 id 写成账号池里的两条记录。
     *
     * 不触碰 `active`：那是「登出竞态」的开关（见 {@link refresh}），
     * 由 {@link login} / {@link prepareLogin} 在会话开始时置位。
     */
    persistLoginResult(flow: LoginFlowResult, options?: {
        refName?: string;
        accountId?: string;
        pool?: AccountPool;
    }): Promise<LoginResult>;
    /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
    status(): Promise<LoginStatus>;
    /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与 `BuddyAuth.refreshAccountCredential` 同因）：
     * `refresh()` 读写的是 `CODEARTS_ACCESS_TOKEN` 这个**默认单凭据 ref**，
     * 而 Account Hub 账号卡片对应的是 `CODEARTS_ACCOUNT_XXX` ——
     * 用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     */
    refreshAccountCredential(refName: string): Promise<void>;
    /**
     * 批量续期所有 codearts 账号。
     *
     * **包含已停用账号**（只按 `refreshable` 过滤）：停用只影响账号池的
     * **自动选号**，不该让凭据烂掉 —— 否则用户重新启用时只能重新登录。
     * 详见 `BuddyAuth.refreshAll` 的注释（同一缺陷）。
     *
     * 单账号失败不影响其他账号。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 移除已存储的凭据并停止任何待处理的刷新。 */
    logout(): Promise<void>;
    /** 停止刷新调度与模型刷新定时器（不清理凭据）。 */
    stop(): void;
    /**
     * 按**默认单凭据 ref**（`CODEARTS_ACCESS_TOKEN`）武装续期调度器。
     *
     * ⚠️ **只能用于单凭据路径**：调度器的回调是 {@link refresh}，而它读写的正是
     * `CODEARTS_ACCESS_TOKEN`。若在**池内账号**登录后调用它，读到的会是另一个
     * ref（该默认 ref 对纯池内账号用户**根本不存在**）⇒ 要么不武装、要么按一个
     * 与本次登录无关的过期时间武装。池内账号（`CODEARTS_ACCOUNT_XXX`）的续期
     * 由 `refreshAll(pool)` 的 30 分钟定时器负责（见 `src/index.ts` 的多账号
     * 静默续期调度），**不是**这里。
     *
     * 调用点只有两处，都在本类内（不存在「由 apply 调用」——`apply()` 走的是
     * 上面那条按池遍历的批量路径）：
     * 1. {@link persistLoginResult}（**且仅当**未传 `refName`，即单凭据登录）；
     * 2. {@link refresh} 成功之后（它刚刷新了默认 ref，按新过期时间重新武装）。
     */
    scheduleRefresh(): void;
    /** 启动时若已有可解析凭据则安排模型刷新（由 apply 调用）。 */
    scheduleModelRefresh(): void;
    /** 停止模型刷新定时器。 */
    stopModelRefresh(): void;
    /**
     * 解析一个可用于拉取远端模型目录、且不含 refresh_token 流出到模型的凭据。
     *
     * 凭据来源**回退链**（账号池用户走 `CODEARTS_ACCOUNT_*`，单凭据用户走
     * `CODEARTS_ACCESS_TOKEN`）：
     * 1. 默认单凭据 ref（`CODEARTS_ACCESS_TOKEN`）可解析且含 AK/SK → 用之；
     * 2. 否则从账号池的 codearts 条目里找**第一条可解析且含 AK/SK** 的凭据；
     * 3. 仍找不到 → 返回 undefined（调用方不刷新、不写缓存）。
     *
     * 刻意不走 `AccountPool.getAvailableAccount`（它只选 **enabled** 账号、还可能被
     * 限流过滤）：模型目录拉取只需**任意一条有效凭据**，与「发请求选号」语义不同；
     * 也刻意不放宽到已停用账号 —— 停用账号的凭据可能已烂，用它拉目录纯属浪费网络。
     *
     * ⚠️ 依赖账号池仅在 `ctx.accountPool` 已注入（`src/index.ts` 在 `apply()` 里
     * `ctx.provide('accountPool', pool)`）之后才可用 —— 本方法的调用点（启动定时
     * 刷新、适配器懒加载）都发生在 `apply()` 完成后，故取不到时安全降级为 undefined。
     */
    private resolveModelsCredential;
    /** 用当前凭据从远端拉取模型列表，非空时更新内存缓存与磁盘。返回模型列表（可能为空）。 */
    refreshModels(): Promise<Array<{
        id: string;
        name: string;
    }>>;
}
//# sourceMappingURL=service.d.ts.map