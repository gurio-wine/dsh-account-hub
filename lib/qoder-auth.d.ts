/**
 * Qoder（国际版）认证服务：**PAT 粘贴式登录** + job token（`jt-`）运行时缓存。
 *
 * 结构与 `src/lobsterai-auth.ts` / `src/trae-cn-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期、同样的 `RefreshTokenExpiredError` 终态约定。
 * 这是本插件已被五个 provider 验证过的模式，复用它可以减少一类
 * 「某个 provider 的续期行为与众不同」的意外。
 *
 * ## 与其它五条协议线的实质差异（三处，都不可照抄）
 *
 * 1. **没有浏览器登录**。其余五条线全是 OAuth / 本地回调，本 provider 的
 *    登录入口是**用户粘贴 PAT**（官方明示「SDK 不会自动刷新 PAT」，
 *    但换 job token 不需要 PAT 变化）。因此**没有** `prepareLogin` /
 *    `persistLoginResult` 的两段式 —— PAT 验证是一次即时请求，不是
 *    「等用户操作 10 分钟」，没有需要拆分的用户手势窗口。
 * 2. **凭据是长期的，过期的是运行时令牌**。`QoderCredential.access_token`
 *    存 PAT，`jt-` **不落盘**（运行时缓存，见 {@link QoderAuth.getJobToken}）。
 *    这直接决定了 `status().expiresAt` 与 `checkExpired()` 的口径 ——
 *    见那两个方法的说明。
 * 3. **续期 = 重打 exchange**，不是「refresh_token 换新」。`jrt-` 那条
 *    （`jobToken/refresh`）**未实测**（计划文档 §3 风险登记），故本实现
 *    只登记常量、不启用；PAT 不变、exchange 随时可重打，主路径够用。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { AccountPool } from './account-pool.js';
import { type QoderDeviceLoginPrepareOutcome, type QoderDevicePendingLogin, type QoderMachineIdIo } from './qoder-device-flow.js';
import { type QoderCredential, type QoderJobTokenPayload, type QoderProduct } from './qoder-product.js';
/**
 * 凭据已失效（需重新粘贴 PAT）时抛出的错误。
 *
 * ⚠️ **类名是历史惯例，不是字面语义**：本插件五个 provider 各导出一个同名类，
 * 因为 `src/refresh.ts` 的 `isRefreshTokenExpired` 用 **`error.name`**（而非
 * `instanceof`）作判据 —— 跨模块 identity 不同，用 instanceof 会让某个
 * provider 的失效信号穿透为「可重试」而无限重试。
 *
 * 故这里必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 * Qoder 没有 refresh_token 可失效（PAT 是长期凭据），这个类的实际语义是
 * **「PAT 已失效 / 不被接受，请重新粘贴」** —— 消息文案按该语义写，
 * 类名保持与另外四个 provider 一致以便复用调度器逻辑。
 */
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 一次成功登录的结果（与另外四个 auth 服务同构）。 */
export interface QoderLoginResult {
    /** 已存储的凭据 JSON 字符串。 */
    access: string;
    /**
     * 凭据过期的毫秒时间戳。
     *
     * **对 Qoder 恒为 0**：PAT 的过期时间由签发时选择、**本地无从得知**
     * （官方文档未给出可解析的过期声明）。这里保留字段是为了让
     * `account.create` 的返回值与另外四个 provider 同构，**不是**「过期时间未知
     * 就当 0 处理」那种兜底 —— 语义就是「没有可报告的过期时间」。
     */
    expires: number;
    /** 凭据值存储所用的凭据引用。 */
    ref: CredentialRef;
    /**
     * 登录 URL。
     *
     * **对 Qoder 恒为空串**：没有浏览器登录流程。保留字段同样是结构同构；
     * 用户真正需要的是 {@link QoderAuth.patUrl}（PAT 签发页）。
     */
    loginUrl: string;
    /** 凭据是否可续期（见 {@link isQoderRefreshable}；PAT 在即 true）。 */
    refreshable: boolean;
}
/** 用于配置界面的只读登录状态。 */
export interface QoderLoginStatus {
    configured: boolean;
    source?: string;
    /**
     * 凭据过期时间。
     *
     * **对 Qoder 恒不返回**（`undefined`）：PAT 无本地可知的过期时间，
     * 而 `jt-` 的 24h 是**运行时缓存**的有效期 —— 把它塞进这里会让账号卡片在
     * 闲置 24h 后显示「已过期」，而实际上 `getJobToken()` 会按需重换、
     * 一切正常。宁可少显示一行，也不报一个假的过期。
     */
    expiresAt?: number;
    /** 存储的凭据是否可续期（PAT 在即 true）。 */
    refreshable: boolean;
    /** 最近一次刷新失败的原因（如有）。 */
    refreshError?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /**
         * Qoder 的认证服务实例。
         *
         * 服务名由产品 id **机械派生**（`qoder` 无连字符 → `qoderAuth` 合法），
         * 与 `buddyCnAuth` / `buddyAuth` / `lobsteraiAuth` / `codeartsAuth` /
         * `traeCnAuth` 并列。cordis 的 `Service` 按名称注册，同名第二次注册会抛
         * `service "..." has been registered`，故每个 provider 各占一个服务名。
         */
        qoderAuth: QoderAuth;
    }
}
/**
 * 把响应体压成一行可读摘要（供错误信息使用）。
 *
 * 三条约束：
 * 1. **压平空白**（含换行）：错误信息会进日志与 UI，多行 body 会把格式冲乱；
 * 2. **截断**：HTML 错误页可以有几万字符；
 * 3. **不做敏感信息过滤**：这是**服务端返回的错误体**，不含我们发出去的 PAT；
 *    真正要守的边界是「绝不把 PAT 回显进任何错误信息」，由调用方保证
 *    （见 {@link QoderAuth.loginWithPat} —— 那里连 PAT 的长度都不提）。
 */
export declare function summarizeQoderErrorBody(text: string, limit?: number): string;
/**
 * 用 PAT 换 job token（`POST {openapiBase}/api/v1/jobToken/exchange`）。
 *
 * 请求体是 `{"personal_token": "<PAT>"}` —— ⚠️ **键名必须 snake_case**
 * （camelCase `personalToken` 实测回 400 `{"errorCode":"BadRequest",…}`）。
 *
 * @throws {RefreshTokenExpiredError} 凭据失效（HTTP 401/403、或响应命中
 *         {@link isCredentialInvalidExchangeFailure} 的标记、或 200 却拿不到
 *         `token`）—— 三种都重试无意义，需用户重新粘贴 PAT。
 * @throws {Error} 其余情况（网络失败、5xx/429、其它非 200、响应非 JSON）——
 *         **普通 Error**，交给 `RefreshScheduler` 走可重试路径。把网络抖动
 *         判成「PAT 失效」会让用户为一次断网重新签发凭据。
 */
export declare function exchangeQoderJobToken(pat: string, product?: QoderProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<QoderJobTokenPayload>;
/** `QoderAuth` 的构造选项。 */
export interface QoderAuthOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link QODER}。 */
    product?: QoderProduct;
    /** 服务名覆盖（默认取 `product.serviceName`，产品未声明时按 `${id}Auth` 派生）。 */
    serviceName?: string;
    /**
     * 设备流注入面（测试用）。
     *
     * 三个字段都不是「配置」而是**替身入口**：出网、等待节奏、home 目录。
     * ⚠️ `homeDir` 的存在是为了让测试**不污染**用户与官方 CLI 共用的
     * `~/.qoder/.auth/machine_id` —— 那会让用户混用官方 CLI 时签名因机器码
     * 漂移而失效。
     */
    deviceFlow?: QoderDeviceFlowOptions;
}
/** 设备流的可注入面（生产一律走默认值）。 */
export interface QoderDeviceFlowOptions {
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 注入的等待函数（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /** home 目录覆盖（测试用）。 */
    homeDir?: string;
    /** 文件系统注入面（测试用）。 */
    io?: QoderMachineIdIo;
    /** 轮询间隔覆盖。 */
    intervalMs?: number;
    /** 总超时覆盖。 */
    timeoutMs?: number;
}
/** {@link QoderAuth.login} / {@link QoderAuth.loginWithPat} 的公共选项。 */
export interface QoderLoginOptions {
    /** 存储用的凭据 ref 覆盖（默认 {@link QoderProduct.defaultCredentialRef}）。 */
    refName?: string;
    /** 账号池条目 id；与 `pool` 同时提供时登录成功后登记/补全账号。 */
    accountId?: string;
    /** 账号池；与 `accountId` 同时提供时生效。 */
    pool?: AccountPool;
}
/** `QoderAuth` 的登录选项（`pat` 必填，其余同上）。 */
export type QoderLoginWithPatOptions = QoderLoginOptions & {
    pat: string;
};
/**
 * Qoder 认证服务：PAT 粘贴登录 + job token 运行时缓存。
 *
 * ## 三件东西的生命周期（理解本类的关键）
 *
 * | 东西 | 存放位置 | 生命周期 | 谁刷新 |
 * |---|---|---|---|
 * | PAT `pt-…` | `ctx.credentials` | 长期（用户吊销前一直有效） | **不刷新**，失效只能重贴 |
 * | `jrt-…` | `ctx.credentials`（`refresh_token`） | 48h | 随 exchange 更新（未单独使用） |
 * | `jt-…` | **本类进程内缓存** | 24h | {@link getJobToken} 在剩余 <1h 时静默重换 |
 *
 * 因此「续期」在本 provider 的含义是**重打 exchange 换一张 jt**，
 * 而不是「用 refresh_token 换 access_token」。
 */
export declare class QoderAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: QoderProduct;
    /**
     * 本实例默认读写的凭据 ref 名称（`QODER_PERSONAL_TOKEN`）。
     *
     * 由产品配置派生，与另外五个 provider 的 ref 完全隔离。
     */
    readonly credentialRefName: string;
    private readonly scheduler;
    /** 凭据已被服务端判定失效；登录/刷新成功时重置。 */
    private credentialInvalid;
    private lastRefreshError;
    /** 会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
    private active;
    /**
     * job token 运行时缓存：**PAT → jt**。
     *
     * 为什么**按 PAT 分键**而不是单槽位：同一个 `QoderAuth` 实例既服务默认单凭据
     * ref，也服务账号池里的多个账号（适配器拿到哪个账号的凭据就传哪个 PAT 进来，
     * 见 {@link getJobToken}）。单槽位缓存会让多账号并发请求互相踩踏 ——
     * 每次换号都要重打一次 exchange，而换号是失败路径上的高频动作。
     *
     * ⚠️ **jt 刻意不落盘**（计划 §2 决策 2）：它是运行时产物，进程重启即冷，
     * 下次 `getJobToken()` 重打一次即可。落盘反而会引入「磁盘上的 jt 是不是
     * 还有效」这类无法离线判定的状态。
     */
    private readonly jobTokens;
    /**
     * 在途 exchange（PAT → Promise）。
     *
     * 并发去重：两个请求同时发现缓存过期时会各自打一次 exchange，白白多一次
     * 往返（且 Qoder 的 exchange 是否对频次敏感未知）。这里让第二个调用者
     * 搭第一个的便车。
     *
     * 去重**按 PAT 分键**（与 {@link jobTokens} 同理）：不同账号的 exchange
     * 是两件互不相干的事，合并会让 B 拿到 A 的令牌。
     */
    private readonly inFlight;
    constructor(ctx: Context, options?: QoderAuthOptions);
    /** 注入的 fetch（测试用）；默认为全局 fetch。 */
    private get fetchImpl();
    /**
     * 取账号的**可展示资料**（昵称 / 邮箱）；失败一律返回 `undefined`。
     *
     * ## 为什么它绝不抛错（与签名链的同名调用恰好相反）
     *
     * 签名链取 userinfo 是为了 `uid`：**取不到就不许签**（空 uid 必回
     * `101 Signature invalid`），故那里抛错是硬约束。而这里的用途是
     * **账号卡片上的一个名字** —— 把一次 userinfo 抖动升级成「登录失败」，
     * 会让用户白白重走一遍浏览器授权页，只为拿一个显示用的字符串。
     *
     * 故三层失败全部吞掉、只是不返回资料：
     * 1. **取令牌失败**（PAT 的 exchange 401/断网）—— 不改变登录结果，
     *    登录链自己会再打一次 exchange 并把真正的失败如实抛出；
     * 2. **userinfo 非 200 / 非 JSON / 缺 uid**（`fetchQoderUserIdentity` 抛）；
     * 3. 任何其它意外。
     *
     * ## 令牌族由 `getJobToken` 分派（本方法不重复实现）
     *
     * `dt-` 恒等返回（零网络）、`pt-` 换 `jt-`，两条路的出口是同一个
     * `jobToken` 变量 —— 这正是「两令牌族同一套代码」的落点。
     */
    private fetchProfile;
    /**
     * 组装昵称取值来源（userinfo 现场值优先，其次凭据里已存的那份）。
     *
     * 抽出来是让**登录链与回填链共用同一份口径** —— 两处各写一份必然分叉，
     * 而分叉的表现是「新登录的账号有真名、回填过的账号没有」这种只在特定路径
     * 出现的不一致，且**不报任何错**。
     *
     * ⚠️ **优先取凭据里已存的** `user_name` / `email`：回填过的账号第二轮就不必
     * 再拉一次 userinfo（这正是幂等的实现方式），而现场值缺失时也不会把已经
     * 拿到过的好名字冲掉。
     */
    private nicknameSource;
    /**
     * 由凭据 + 资料算出账号池条目的**资料字段**（昵称 + 有效期）。
     *
     * 登录链的两个落点（`persistDeviceToken` / `loginWithPat`）共用它，
     * 与回填链的昵称解析走同一个 {@link nicknameSource}。
     *
     * ⚠️ **`expiresAt` 只对设备令牌族有值**（见 `qoderAccountExpiresAtMs`）：
     * PAT 的那个字段是 jt 的 24h，写进去会让卡片在闲置一天后显示「已过期」。
     */
    private profilePatch;
    /**
     * PAT 签发页 URL（供 Account Hub 的 Qoder 面板展示）。
     *
     * 本 provider 没有浏览器登录流程，用户必须先去这个页面拿到 PAT ——
     * 面板上的「粘贴 PAT」表单需要它作为引导链接，所以由服务暴露，
     * 避免客户端再抄一份字面量。
     */
    get patUrl(): string;
    /** 控制面请求超时（毫秒）；供适配器复用，避免各自写一份常量。 */
    get requestTimeoutMs(): number;
    /**
     * 标记凭据已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
     *
     * ⚠️ **文案刻意是中性的「请重新登录」**（不是「请重新粘贴 PAT」）：Account Hub
     * 的 Qoder 面板现在**只有浏览器设备流一个登录入口**（PAT 粘贴 UI 已于
     * 2026-09-21 按用户要求移除），故「重新登录」是两代令牌下**唯一可执行**的
     * 用户动作。说「重新粘贴」会把用户指向一个界面上不存在的入口。
     */
    private markCredentialInvalid;
    /**
     * 统一登录入口（**两种形态并存**）。
     *
     * | 调用 | 走哪条路 | 形态 |
     * |---|---|---|
     * | `login()` | **浏览器设备流** | 两段式：返回 `loginUrl`，等用户在浏览器授权 |
     * | `login({ pat })` | PAT 粘贴 | 即时请求，当场完成 |
     *
     * `pat` 提供了就走 PAT（**一行未改**的 {@link loginWithPat}）；没提供就走设备流。
     *
     * ⚠️ **为什么无参不再抛错**：本 provider 落地时确实只有 PAT 一种形态，
     * 那时「无参」等于「用户走错了入口」，抛一条指引是正确的。现在设备流是
     * **默认的浏览器登录形态**，无参有了真实含义 —— 继续抛错会让统一接口
     * （AGENTS.md「工作方式」要求每个 `ctx.xxxAuth` 都有 `login(options?)`）
     * 名不副实。
     *
     * 设备流返回的 `loginUrl` 是**授权页地址**，调用方（RPC / 命令）负责把它
     * 交给用户；本方法**不 await 用户操作**（那正是两段式要解决的问题）。
     */
    login(options?: QoderLoginOptions & {
        pat?: string;
    }): Promise<QoderLoginResult>;
    /**
     * **第一段**：建立设备流会话，返回 `loginUrl`（**不 await 用户操作**）。
     *
     * 这是 Account Hub 的入口（`account.create` 无 `pat` 时）：
     *
     * 1. 本方法**只建会话**（本地生成 PKCE、读写 machine_id），一次网都不出；
     * 2. RPC 立刻把 `loginUrl` 返回给客户端，客户端在**同一用户手势内**开窗；
     * 3. 后台由 {@link persistLoginResult} 消费 `awaitToken()` 完成第二段。
     *
     * 已有未结算会话时返回 `login-in-progress`（**provider 级互斥**：不新建、
     * 不复用）；调用方应把该错误码**原样透传**给客户端做提示。
     *
     * ⚠️ **设备流会话与 PAT 无关**：PAT 路径不进这里（它是即时请求，没有
     * 「会话」这个概念）。两条路只在 {@link login} 这一处分流。
     */
    prepareLogin(options?: QoderLoginOptions): Promise<QoderDeviceLoginPrepareOutcome>;
    /**
     * 取消当前进行中的设备流登录（幂等）。
     *
     * 供 `account.delete` 使用：删掉占位账号后必须终止轮询，否则它会一直打到
     * 5 分钟超时（且互斥槽位不释放，用户重新登录会拿到 `login-in-progress`）。
     */
    cancelPendingLogin(reason?: string): void;
    /**
     * **第二段**：把一个已完成的设备流结果落盘（凭据 + 账号池）。
     *
     * 时序约束（不可调换，与另外几个 provider 同因）：
     * 1. 先写凭据，**再**补全账号 —— `login.poll` 以「该 ref 能否解析到凭据」
     *    为完成判据，反过来会让轮询在凭据就绪前就报成功；
     * 2. 占位条目的 `refreshable` / `expiresAt` / `nickname` 都依赖结果，
     *    故第一段只能以 pending 形态存在。
     *
     * `accountId` + `pool` 提供时按账号路径补全；否则落到默认单凭据 ref
     * （{@link login} 走的就是这条）。
     */
    persistLoginResult(session: QoderDevicePendingLogin, options?: QoderLoginOptions): Promise<QoderLoginResult>;
    /**
     * 把设备流拿到的令牌落成凭据（两条消费路径的**唯一**落盘点）。
     *
     * 抽出来是为了让「凭据长什么样」只有一处：`login()` 与
     * `persistLoginResult()` 都走它，否则将来改字段会只改一半。
     *
     * ## 与 PAT 路径写**同一种**凭据形态
     *
     * 设备流的 `token` 与 PAT 在上游是**同一种东西**（都是可换 `jt-` 的长期
     * 令牌），故同样进 `access_token`。这不是图省事：
     * `AccountPool.findAccountIdByCredential` 对非 codearts 的 provider 统一取
     * `access_token` 作身份标识，换字段会让限流记账**静默**失配。
     *
     * ## `refresh_token` 的优先级
     *
     * exchange 响应通常也带 `refresh_token`，但**设备流自己那份是权威**：
     * 它是服务端在授权时签发给这次登录的，而 exchange 可能不带（见
     * `applyQoderRefresh` 的注释）。故这里**显式覆盖**，避免 exchange 的空串
     * 把设备流的令牌冲掉。
     */
    private persistDeviceToken;
    /**
     * 用 PAT 完成登录并持久化凭据。
     *
     * 三步（顺序不可调换）：
     * 1. **本地前缀校验**（`pt-`）—— 在发请求之前挡住「粘错东西」
     *    （粘了别家 token、粘了 `dt-` 设备令牌、粘了半截），把一次必然失败的
     *    网络往返换成一条可读提示；
     * 2. **exchange 验证** —— 只有 200 且响应带 `token` 才继续；
     * 3. **落凭据 + （可选）落账号**。
     *
     * 与另外四个 provider 的登录相比**没有两段式**：PAT 验证是即时请求，
     * 不存在「等用户操作 10 分钟」的用户手势窗口，因此不需要
     * `prepareLogin` / `persistLoginResult` 那一套（计划 §2 决策 1）。
     *
     * ⚠️ **PAT 绝不回显**：错误信息里不含 PAT 本体、长度或任何片段。
     * 凭据是长期有效的秘密，一旦进了日志/UI 就等于泄露。
     *
     * @param pat - 用户粘贴的 PAT；前后空白（剪贴板常见的换行）会被裁掉。
     */
    loginWithPat(pat: string, options?: QoderLoginOptions): Promise<QoderLoginResult>;
    /**
     * 取一个可用的**运行时令牌**，必要时静默重换。
     *
     * ## 两条令牌族，两种取法（这是本方法唯一的分派点）
     *
     * | `access_token` 形态 | 怎么取 | 出网 |
     * |---|---|---|
     * | `dt-…`（设备流） | **原样返回** | 零（它本身就是 Bearer） |
     * | `pt-…`（PAT） | 缓存命中则返回 jt，否则打 exchange | 视缓存 |
     *
     * ⚠️⚠️ **设备令牌绝不能去打 exchange**：那是 PAT 专用端点
     * （见 {@link exchangeQoderJobToken} 与 `QODER_JOB_TOKEN_EXCHANGE_PATH`
     * 的说明），把 `dt-` 提交过去会回 HTTP 400 `BadRequest`。旧实现无条件走
     * exchange 分支，于是「设备流登录」在**登录期**就被判失败。
     *
     * ## 为什么 PAT 分支要提前 1h 重换
     *
     * 剩余有效期小于 {@link QODER_JOB_TOKEN_REFRESH_LEAD_MS}（1h）→ 重打 exchange
     * 并回填缓存。提前量与 `src/refresh.ts` 的 `REFRESH_LEAD_MS` 同口径：卡在
     * 「名义未过期、发请求时已过期」的窗口里会让用户看到一次莫名其妙的 401。
     *
     * @param pat - 凭据的 `access_token`（**PAT 或设备令牌**，不是 jt）。
     * @throws {RefreshTokenExpiredError} PAT 已失效（exchange 401 / `TOKEN_EXPIRE`
     *         类）—— 适配器应把它当凭据失效处理，提示用户重新登录。
     */
    getJobToken(pat: string): Promise<string>;
    /**
     * 丢弃某个 PAT 的 jt 缓存（下次 {@link getJobToken} 必然重换）。
     *
     * 供适配器在收到「jt 过期类 401」时强制重试一次：实测 chat 端点的 401 是
     * 裸 `{"error":"unauthorized"}`、**不带可分型的业务码**，无法与「PAT 类型错」
     * 区分，所以正确动作是「先当过期处理，重换一次再试；仍失败才判凭据失效」
     * （计划 §2 决策 3）。没有这个入口，适配器只能靠等价手段（如自建时间判断）
     * 绕过缓存，那会让缓存的一致性失去单一真相源。
     */
    invalidateJobToken(pat: string): void;
    /**
     * 执行一次 exchange，带**在途去重**。
     *
     * 抽出来供 `getJobToken` / `loginWithPat` / `refreshCredential` 共用，
     * 避免三处各写一遍「打请求 → 判终态 → 回填缓存」而逐渐分叉。
     */
    private exchange;
    /** 报告凭据是否已配置、是否可续期以及最近刷新错误。 */
    status(): Promise<QoderLoginStatus>;
    /**
     * 静默续期：**按令牌族分派**（设备令牌 → `deviceToken/refresh`；PAT → 重打 exchange），
     * 更新 jt 缓存与凭据元数据。
     *
     * ## PAT 族
     * 没有「refresh_token 换新」这回事。PAT 不变 ⇒ 只要它没被吊销，
     * `refresh()` **永远可以成功**。失败即 PAT 已失效 —— exchange 回 401 /
     * `TOKEN_EXPIRE`，本方法抛 {@link RefreshTokenExpiredError}，调度器停止重试
     * 并向 UI 暴露「请重新登录」。
     *
     * ## 设备令牌族
     * 用凭据里的 `drt-…` 打 `deviceToken/refresh` 换一份新的 `dt-…`。
     * 缺少 `refresh_token` 时**不出网**直接判终态（重试也变不出来）。
     *
     * ⚠️ **文案一律中性**（「请重新登录」而非「请重新粘贴 PAT」）：面板已无 PAT 入口。
     *
     * 终态判定边界：
     * - 网络失败、5xx、429 → 普通 Error，走调度器可重试路径（断网不等于凭据失效）；
     * - HTTP 401/403、响应命中失效标记、200 却缺 token → 终态。
     */
    refresh(): Promise<void>;
    /**
     * 按凭据 ref 续期**指定账号**的凭据。
     *
     * 与 {@link refresh} 的区别（与另外四个 provider 同因）：
     * `refresh()` 读写本实例的默认单凭据 ref（`QODER_PERSONAL_TOKEN`），
     * 而 Account Hub 账号卡片对应的是 `QODER_ACCOUNT_XXX` ——
     * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
     *
     * 同样**不触碰** `credentialInvalid` / `lastRefreshError` / 调度器：
     * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
     */
    refreshAccountCredential(refName: string): Promise<void>;
    /**
     * 对一份凭据执行一次续期并返回新凭据（不触碰凭据存储）。
     *
     * ## 按令牌族分派（两条路径，互不替代）
     *
     * | `access_token` | 续期方式 | 官方对应 |
     * |---|---|---|
     * | `pt-…` | 重打 exchange（PAT 不变，随时可重打） | `refreshStrategy: 'pat'` |
     * | `dt-…` | `POST /api/v1/deviceToken/refresh`（body `refresh_token`） | `refreshStrategy: 'device-token'` |
     *
     * ⚠️ **不分派会让设备流登录「先成功后失效」**：设备令牌提交给 PAT 专用的
     * exchange 端点必然 400，而 `refresh()` 把 4xx 之外的失败都当可重试，
     * 用户看到的是登录明明成功、过一阵却报「凭据失效」。
     * PAT 分支一行未动（有逐字节回归用例钉死）。
     */
    private refreshCredential;
    /**
     * 用设备刷新令牌（`drt-…`）换一张新的设备令牌。
     *
     * 官方 `refreshDeviceCredential(A,e)` @ INTL 偏移 4017721：
     * ```js
     * POST {openapiBase}/api/v1/deviceToken/refresh
     * body {refresh_token: A.refresh_token, ...getMachineIdentityRequestFields(machineId)}
     * ```
     * 头是 `Content-Type` / `Accept` / `User-Agent`（**无 Authorization** ——
     * 续期时手上的令牌正是要换掉的那张）。
     *
     * ⚠️ **`machine_id` 一并回传**（官方同款）：它是设备身份，两处漂移会让
     * 服务端把这次续期当成另一台机器。
     *
     * @throws {RefreshTokenExpiredError} 401/403、或响应里没有可用令牌
     *         （`drt-` 已失效 —— 只能重新走浏览器登录）。
     * @throws {Error} 其余（网络失败、5xx）—— 交给调度器重试。
     */
    private refreshDeviceToken;
    /**
     * 批量续期本产品的所有账号。
     *
     * 遍历 pool 中 **`refreshable`** 的本产品账号（**含已停用账号**），逐一确保 jt 可用；
     * 单账号失败不影响其他账号（与另外几个 provider 同语义）。
     *
     * ⚠️ **停用只影响账号池的自动选号，续期仍进行**：早期实现是
     * `if (!entry.enabled || !entry.refreshable)`，停用账号被跳过续期，凭据一路
     * 放到失效，用户重新启用后只能重新登录（真实缺陷，详见 `BuddyAuth.refreshAll`）。
     * 两个 region 共用本类，故一处改动同时覆盖 `qoder` 与 `qoder-cn`。
     *
     * ⚠️ **本 provider 刻意走 `getJobToken` 而不是无条件 exchange**：
     * jt 有效 24h，而 `src/index.ts` 的批量续期**每 30 分钟**跑一趟 ——
     * 无脑重换会让每个账号每天多打约 48 次 exchange，而其中绝大多数纯属浪费。
     * `getJobToken` 自带「剩余 >1h 即命中缓存」的判据，于是每账号每进程
     * 最多每 23 小时换一次，语义与其它 provider 的 `refreshAll` 一致
     * （都保证「下一次请求拿到的令牌是有效的」），只是不再做无用功。
     *
     * ⚠️ **设备令牌族例外，必须真的续期**：`getJobToken` 对 `dt-` 是
     * **原样返回**（它本身就是 Bearer，无缓存可命中），拿它当「续期」等于
     * 什么都没做 —— 设备令牌 ≈30 天到期后账号会静默变成不可用。故这里对
     * 设备令牌走 {@link refreshCredential}（即 `deviceToken/refresh`），
     * 且只在**临近过期**时才打（同样的「不做无用功」判据）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * **存量账号的资料回填**（惰性、幂等、零出网即完成）。
     *
     * ## 为什么需要它
     *
     * 只修登录链是不够的：盘上已有的账号条目**昵称已经是 UUID 了**
     * （改动前的 `persistDeviceToken` 写的就是 `credential.user_id`），而
     * `expiresAt` 压根没写过。这两项都不会因为「以后新登录的账号是对的」而自愈
     * —— 用户必须重新登录一遍才能看到真名。回填链让它们在一轮之内自动修好。
     *
     * ## 为什么挂在「批量续期」上而不是自造定时器
     *
     * `src/index.ts` 已经有一个每 30 分钟的 `refreshAllCredentials()`，且它已经
     * 按 provider 调了 {@link refreshAll}。挂在那里意味着：
     * - **不新增定时器**（插件的定时器数量与 dispose 清理点都是既有事实）；
     * - 触发时机与用户预期一致（打开设置页时账号列表已经跑过至少一轮）。
     *
     * ## 幂等（这是唯一必须守住的性质）
     *
     * 判据全部收敛在 {@link needsQoderAccountProfileBackfill}：昵称不是占位形、
     * 且（该凭据本来有可报告有效期时）有效期已记 ⇒ **跳过，一次网都不出**。
     * 故稳态下本方法是个纯粹的遍历，代价是 N 次内存比较。
     *
     * ⚠️ **PAT 账号天然稳态**：`qoderAccountExpiresAtMs` 对 PAT 恒 `undefined`，
     * 所以「缺 expiresAt」对它们**不构成**待回填条件 —— 否则每 30 分钟都会为
     * 每个 PAT 账号白打一次 exchange + userinfo，永不停止。
     *
     * ## 失败一律静默
     *
     * 单账号失败只记日志、继续下一个（与 {@link refreshAll} 同语义）。
     * 这里**不能抛**：它是挂在批量链上的增强步骤，让一次 userinfo 抖动把
     * 整轮续期变成未捕获拒绝，会让其它账号的续期也被跳过。
     */
    backfillAccountProfiles(pool: AccountPool): Promise<void>;
    /**
     * 移除已存储的凭据、清空 jt 缓存并停止任何待处理的刷新。
     *
     * **清空整个 jt 缓存**（而不是只删本条 PAT 的）：登出的语义是「这个实例不再
     * 持有任何可用令牌」。多账号场景下，登出默认单凭据 ref 并不意味着别的账号
     * 也该被清 —— 但那些账号的 jt 会在下一次 `getJobToken` 时按需重新换取，
     * 代价是一次 exchange，换来的是「登出后内存里不残留任何 jt」这条清晰不变量。
     */
    logout(): Promise<void>;
    /** 停止刷新调度（不清理凭据）。 */
    stop(): void;
    /**
     * 启动时若已有凭据则安排续期（由 `apply` / 登录路径调用）。
     *
     * 武装依据是凭据里记录的 **jt 过期时刻**（`token_expires_at`）：到点前 1h
     * 触发一次 `refresh()`（重打 exchange），既保持 jt 常热，也让
     * `status().refreshError` 能及时反映 PAT 是否已被吊销。
     *
     * 这**不是**把 jt 的 24h 当成凭据有效期 —— `checkExpired()` 与
     * `status().expiresAt` 都不看它（见那两处的说明）。
     */
    scheduleRefresh(): void;
    /**
     * 从存储重载凭据，返回是否**需要用户重新粘贴**（供 UI 判断）。
     *
     * ⚠️ **与另外四个 provider 口径不同，这是有意的**：那边判的是「access token
     * 是否过期」，而 Qoder 的 `access_token` 是 PAT —— **无本地可知的过期时间**
     * （官方不提供、凭据里也没有），`token_expires_at` 记的是 jt（运行时缓存）。
     * 拿 jt 的过期时刻判「凭据过期」会让账号在闲置 24h 后提示重新粘贴，
     * 而实际上一次 `getJobToken()` 就能自愈 —— 那是个纯粹的假警报。
     *
     * 故本方法只回答「有没有一份**看起来能用**的 PAT」：没有（未配置 / 解析失败 /
     * 空串）才返回 true。真正的失效信号只能来自服务端，由 `refresh()` /
     * `getJobToken()` 抛出的 {@link RefreshTokenExpiredError} 表达。
     */
    checkExpired(): Promise<boolean>;
    /**
     * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
     *
     * 供审计 / e2e 探针使用（`account-probe` 走的是
     * `resolveCredentialForAccount`，按账号 id 解析，不受 `enabled` 限制）。
     */
    resolveStoredCredential(): Promise<QoderCredential | undefined>;
}
//# sourceMappingURL=qoder-auth.d.ts.map