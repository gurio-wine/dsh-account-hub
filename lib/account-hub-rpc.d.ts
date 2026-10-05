/**
 * Account Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 account-hub → 路径 /api/account-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           credits.checkinStatus / checkin.perform / checkin.sweep /
 *           update.check / update.leftovers / update.apply / update.status /
 *           consumption.get / consumption.set /
 *           autoroute.get / autoroute.set / autoroute.catalog / autoroute.model-info /
 *           masquerade.status / masquerade.apply /
 *           model.list / model.setDisabled / model.setContextBudget
 */
import type { Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { AccountPool } from './account-pool.js';
import type { CodeArtsAuth } from './service.js';
import type { BuddyAuth } from './buddy-auth.js';
import type { LobsteraiAuth } from './lobsterai-auth.js';
import type { TraeCnAuth } from './trae-cn-auth.js';
import type { QoderAuth } from './qoder-auth.js';
import type { BuddyCredential } from './buddy.js';
import { type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js';
import { type BuddyProduct } from './product.js';
import type { QoderProduct } from './qoder-product.js';
import { type ContextTierRegistry } from './context-tiers.js';
import type { ProviderId } from './types.js';
import type { ProviderAccountEntry, RpcCreditsStatusResponse, RpcCreditsClaimAllResponse, RpcCreditsClaimAccountResult, RpcCreditsClaimSummary, RpcCreditsBalancesResponse } from './types.js';
import { type AccountHubUpdateDeps } from './account-hub-update.js';
/** Account Hub RPC API 路径 */
export declare const ACCOUNT_HUB_API_PATH = "/api/account-hub";
/**
 * 自动签到（Auto Check-in）**可签到 provider** 的宿主侧真相源。
 *
 * sweep（`checkin.sweep`）与 `checkin.perform` 的 provider 全量退化只遍历这套集合。
 * ⚠️ 它是宿主侧的独立常量：客户端的能力真相源在
 * `plugin-src/client/credits-capabilities.js`（esbuild 进 bundle，宿主无法 import）。
 * 两处靠 `tests/unit/credits-capabilities.spec.ts` 的**相等断言**锁一致，漂移当场抓红。
 *
 * 六条（qoder 国际版已拍板接入，2026-09-23）：buddy-cn / lobsterai / trae-cn /
 * codearts / qoder / qoder-cn。
 */
export declare const CHECKIN_ELIGIBLE_PROVIDERS: ReadonlySet<string>;
/**
 * 签到路径的**模块级共享互斥信号**。
 *
 * 三路触发都可能撞在一起：4 小时定时器 sweep、启动 sweep（`src/index.ts`）与
 * 面板单发（`checkin.perform`）。**面板单发与 sweep 签的是同一批账号**
 * （`performCheckin` 不带 accountId 时目标集就是该 provider 的全部账号），故两路
 * 必须共享**同一把**锁，入口非空闲的一方直接让路（不排队、不重入）。
 *
 * ⚠️ 名字从 `sweepRunning` 改成 `checkinBusy` 是刻意的：旧名字只覆盖 sweep 内部，
 * 而面板单发原先**根本不看它** —— 于是「进页面自动补签」与 sweep 可以对同一账号
 * 各发一次 claim。这不是理论风险：`trae-cn` 的 9074 处置会**各自换设备号并各自
 * 落盘**（见 `src/trae-cn-credits.ts` 的 `claimTraeCnWithDeviceRotation`），后写
 * 覆盖先写 ⇒ 盘上留的可能是**另一路**用的号，下一轮又从旧号起步白撞一次 9074，
 * 或者「这一发成功了、盘上却是另一个号」。锁名必须覆盖它真正保护的东西。
 *
 * 被挡方的语义各不相同，但都**不能**伪装成「跑了但没账号可签」：
 * - sweep 被挡 → `{ running: false, providers: [] }`（既有形态，不动）；
 * - 面板单发被挡 → `RpcCheckinPerformResponse.busy = true` + 空 results/summary。
 */
export declare let checkinBusy: boolean;
/** 重置签到互斥（仅测试用）。 */
export declare function __resetCheckinBusy(): void;
/** 清空抑制表（仅测试用，与 {@link __resetCheckinBusy} 同款）。 */
export declare function __resetUndeterminedSuppression(): void;
/**
 * 执行一次**单个账号**或**单个 provider 全量**的自动签到（复用 claimAll 分派逻辑）。
 *
 * 内部实现见下方 `runCreditsClaim`：对账号数组逐账号走与 `credits.claimAll` 分支
 * **完全相同**的 claim 分派，差异仅在：
 *  1. accountId 给定时只处理该账号；
 *  2. 成功（claimed）或已领（already-claimed）都写 `writeCheckinDay`（今日），
 *     inactive / failed **不写**（失败不写，下次 sweep 重试）。
 *
 * 返回按账号的 outcome 摘要（claimed / already-claimed / failed）。
 *
 * ⚠️ **互斥由本路径自己持有**（模块级 {@link checkinBusy}，与 sweep 共享同一把）：
 * 撞上 sweep 在跑时回 `busy: true` 的空响应，**不发任何 claim** —— 早期版本的注释
 * 写的是「单账号 perform 不占互斥」，那正是「进页面自动补签与 4h sweep 并发各发
 * 一发」的缺口。
 */
/**
 * 与 `credits.claimAll` 的 {@link RpcCreditsClaimAccountResult} **同构**的逐账号
 * 签到结果：`outcome` 是完整 {@link ClaimOutcome} 对象（`{kind, code, message,
 * logid?}`），不是拍扁成裸字符串 —— 客户端通知 UI（claimFailureLines /
 * formatClaimFailureLine）依赖它带 code/message/logid。
 */
export type CheckinAccountResult = RpcCreditsClaimAccountResult;
/** RPC: `credits.checkinStatus` 请求。 */
export interface RpcCheckinStatusRequest {
    provider: string;
}
/** RPC: `consumption.get` 请求（读某 provider 的消耗顺序 / 切换粒度）。 */
export interface RpcConsumptionGetRequest {
    provider: string;
}
/** RPC: `consumption.get` 响应。 */
export interface RpcConsumptionGetResponse {
    provider: string;
    /** 当前配置；未配置过时是默认值（顺序 + 按轮次），**不会是 undefined**。 */
    consumption: {
        order: string;
        switch: string;
    };
}
/**
 * RPC: `consumption.set` 请求（**部分更新**）。
 *
 * 两个字段都可选：界面上的两个选择器彼此独立，各自只发自己那一个。
 * `order` / `switch` 的取值域与默认值见 `src/account-consumption.ts`。
 */
export interface RpcConsumptionSetRequest {
    provider: string;
    order?: string;
    switch?: string;
}
/** RPC: `consumption.set` 响应（回传写入后的**权威**配置，供客户端对齐选中态）。 */
export interface RpcConsumptionSetResponse {
    provider: string;
    consumption: {
        order: string;
        switch: string;
    };
}
/** RPC: `credits.checkinStatus` 响应（纯内存读，不发网络请求）。 */
export interface RpcCheckinStatusResponse {
    provider: string;
    /**
     * 该 provider 的**下一次重置时刻**（本地时间毫秒时间戳）。
     *
     * 客户端只用它做展示（「明天 10:00 后可再签」），**不参与判定** —— 判定是
     * `checkedIn` 那一格，由宿主按 `Date.now()` 算好。放在响应里是为了让界面
     * 不用自己算重置钟点（那会变成客户端第二份 `CHECKIN_RESET_HOURS`）。
     */
    nextReset: number;
    /** accountId → 此刻是否**已签**（记录的下一次可签时刻还没到）。无账号时为空对象。 */
    checkedIn: Record<string, boolean>;
    /**
     * accountId → 此刻是否处于 `undetermined` 的**旁路抑制期**（见
     * {@link undeterminedSuppressUntil}）。无账号时为空对象。
     *
     * ## 为什么必须与 `checkedIn` **分开**两个字段
     *
     * 两者是**正交**的两件事，合并任何一个方向都会制造缺陷：
     *
     * - 并进 `checkedIn` ⇒ 被抑制的账号显示「已签」+ 按钮禁用，而它**可能一分没领**
     *   —— 那正是「qoder 假签到」的界面形态，也是本次改动明令不许出现的；
     * - 并进「未签」而不给字段 ⇒ 客户端**无从知道**宿主这轮为什么没签，于是
     *   「进页面自动补签」会照着「有账号未签」判断并**再发一发** —— 抑制表刚堵住的
     *   空转循环会从客户端这条路上原样复活（宿主少发的那一发由客户端补上）。
     *
     * 故 `checkedIn` 的语义**一字未动**（仍是「`checkins` 里记的下一次可签时刻还没
     * 到」），抑制态独立成这一格。旧客户端不读它 ⇒ 行为退回改动前（多发一发幂等
     * 查询），不会读错任何东西。
     */
    suppressed: Record<string, boolean>;
}
/** RPC: `checkin.perform` 请求（accountId 缺省/空串 → 该 provider 全量）。 */
export interface RpcCheckinPerformRequest {
    provider: string;
    accountId?: string;
}
/** RPC: `checkin.perform` 响应。 */
export interface RpcCheckinPerformResponse {
    provider: string;
    /**
     * 该 provider 的**下一次重置时刻**（本地毫秒时间戳）。
     *
     * ⚠️ 字段名历史上的含义是「今天的日数」（`today: number`），新口径下那个值
     * 已经不存在于本域（判定不再需要「今天是几号」）。保留同一位置但改语义会
     * 让旧客户端读到 1.7e12 这样的数字并当成日数显示 —— 故**改名**，
     * 旧客户端读 `today` 拿到 `undefined` 即自然降级（它只用于展示，不参与判定）。
     */
    nextReset: number;
    results: CheckinAccountResult[];
    summary: RpcCreditsClaimSummary;
    /**
     * **本趟被共享互斥挡下**（另一路签到——sweep 或面板另一发——正在跑）。
     *
     * `true` 时 `results` 为空、`summary` 全零，且**没有发过任何 claim**。刻意做成
     * 「成功响应 + 一个显式标志」而不是 RPC 错误，理由有两条：
     *  1. 它不是失败：同一批账号**正在被签**，客户端不该报错、也不该提示用户排查；
     *  2. 客户端必须能把它与「跑了但没账号可签」（同样是空 results）区分开 ——
     *     否则「被挡」会退化成静默（正是本次要修的缺陷形态）。
     */
    busy?: boolean;
}
/** 单个 provider 的一次 sweep 结果。 */
export interface RpcCheckinSweepProviderResult {
    provider: string;
    results: CheckinAccountResult[];
    summary: RpcCreditsClaimSummary;
}
/** RPC: `checkin.sweep` 响应。 */
export interface RpcCheckinSweepResponse {
    /** 本趟是否真正执行（false = 被互斥排到，返回进行中快照）。 */
    running: boolean;
    providers: RpcCheckinSweepProviderResult[];
}
/**
 * 由 provider 名与短 id 派生**账号凭据 ref 名**。
 *
 * ## 为什么必须归一化连字符
 *
 * provider id 允许带连字符（`trae-cn` 是对齐生态叫法的刻意选择，见
 * `src/trae-cn-product.ts`），但 DSH 的 `@deepseek-ai/dsh-credentials` 把 ref 名
 * 约束为 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` —— 连字符**不在**字符集内。
 *
 * 归一化前的后果链（已实证）：`pool.addAccount` 把 `TRAE-CN_ACCOUNT_XXX` 原样
 * 写进账号池 → 后台登录第二段调 `credentialRef(refName)` 直接抛 TypeError →
 * 凭据**从未**写入 `.credentials.yaml` → 池里留下一个永远没有凭据的条目，
 * 三个积分收集器在 `credentialRef(entry.credentialRef)` 处一并抛错（面板显示
 * 「积分查询失败 / 领取失败」），trae-cn 的 LLM 对话同样不可用。
 *
 * ## 为什么是「先 toUpperCase、再折连字符」
 *
 * `trae-cn` → `TRAE_CN_ACCOUNT_XXX`，与 `src/trae-cn-product.ts` 的
 * `accountCredentialRefPrefix`（`TRAE_CN_ACCOUNT`）**逐字符一致** —— 后者是
 * 该前缀的唯一真相源，本函数必须与它同值。同理 `buddy-cn` →
 * `BUDDY_CN_ACCOUNT_XXX`（与 `product.ts` 的 `defaultCredentialRef`
 * `BUDDY_CN_ACCESS_TOKEN` 同族）。
 *
 * 无连字符的 provider（`codearts` / `buddy` / `lobsterai`）
 * 输出与归一化前**完全相同**，既有账号的 ref 全部兼容，**无需迁移**。
 * ⚠️ 但 `buddy` 这个 id 本身**换了产品**（原中国版 → 现国际版），
 * 旧 `BUDDY_ACCOUNT_*` 前缀下躺着的是中国版凭据 —— 这段历史由
 * `src/provider-rename-migration.ts` 一次性搬运，**不能**只靠本函数的兼容性。
 */
export declare function accountCredentialRefName(provider: string, suffix: string): string;
/**
 * provider id → **账号池的 provider 键**（当前对每个 provider 都是恒等）。
 *
 * ## 为什么留着一个恒等函数
 *
 * 它存在的理由是**收敛点**，不是映射本身：账号列表 / 余额 / 签到状态 / 领取 /
 * 重测 / 重置六个入口都经它把「面板 id」翻成「池键」，客户端因此永远不需要
 * 知道池键与面板 id 可能不同（客户端发的就是面板 id）。
 *
 * 它曾经有过非恒等分支 —— 某个复用 `trae-cn` 账号的 TraeWork 路线 provider
 * （官方已把该通道并入通用通道，那个 provider 已整体移除）。**恒等是
 * 今天的取值，不是这个函数的语义**：将来若再出现「复用别人账号」的 provider，
 * 在这里加一行即可，而不必把 if 撒进客户端六处调用点。
 *
 * ## 刻意**不**经过本函数的入口
 *
 * - **`account.create`**：它按 provider 解析产品配置来决定「登录怎么做」。
 *   若某天出现共用账号的 provider，这里**不能**映射成宿主 provider ——
 *   那会派生出一个占位账号，而它背后是另一份凭据体系，等于把一个账号建两遍。
 *   故该入口对未知 provider 的拒绝行为**保持不变**（宁可拒绝，不可静默重复建号）。
 * - **`login.poll`**：轮询的键是 accountId + 该账号自己的 provider，与面板 id 无关。
 */
export declare function poolProviderFor(provider: string): string;
/**
 * Qoder 的 **region 解引用**：provider id → （产品配置, 该 region 的 auth 实例）。
 *
 * ## 为什么必须是**成对**返回，而不是让调用方各取各的
 *
 * Qoder 的两个 region 是**同协议、两套 host、两批互不相通的账号**
 * （见 `src/qoder-product.ts` 的模块头）。三条依赖都必须与 region 对齐：
 *
 * | 依赖 | 落在哪 | 配错的失败形态 |
 * |---|---|---|
 * | exchange / quota / models 的 host | `product.*` | 拿 CN 的 PAT 打国际版端点 → 假的「凭据失效」 |
 * | jt 运行时缓存、在途去重、失效标记 | **auth 实例的字段** | 用国际版实例换的 jt 打 CN → 401 → 又指向「PAT 失效」 |
 * | 账号池键 / 凭据 ref 前缀 | `product.id` / `product.*Ref` | 串到另一区的账号 |
 *
 * 三者的取值来源**不同**（配置 vs 实例），所以「调用方自己按 id 取配置、
 * 再自己按 id 挑实例」这种写法在将来新增 region 时极易只改一半。本函数把它们
 * 绑成一个返回值，调用点拿到的是**已经对齐的**一对。
 *
 * ## 与 `poolProviderFor` 的区别
 *
 * 那个答的是「面板 id 该查哪个账号池」，本函数答的是「这个 region
 * 该用哪份配置与哪个实例」。Qoder **没有**任何池映射（两区是两批账号），故
 * `qoder-cn` 既不被映射到 `qoder`，也不反向映射 —— 这正是与国际版账号隔离的
 * 实现方式。
 *
 * @returns 该 provider 的 region；**不是 Qoder 系 provider 时 `undefined`**
 *          （由调用方决定是拒绝还是走别的分支 —— 本函数不抛错，因为
 *          调用点还需要区分「未知 provider」与「已知但配置不全」）。
 */
export declare function qoderRegionFor(provider: string, qoder: QoderAuth, qoderCn: QoderAuth): {
    product: QoderProduct;
    auth: QoderAuth;
} | undefined;
/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export declare function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary;
/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<TCredential = BuddyCredential, TProduct = BuddyProduct> {
    /**
     * 解析凭据引用。
     * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
     * 实现允许抛错，调用方必须把异常算在单个账号头上。
     */
    resolve(ref: CredentialRef): Promise<{
        value: string;
    } | undefined>;
    /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
    fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>;
    /**
     * 执行签到领取；默认使用真实的 claimDailyCheckin。
     *
     * 第三个参数是本账号的**凭据写回出口**（`undefined` = 该调用方不负责持久化）。
     *
     * ## 为什么它必须经形参传进来，而不是让 claim 自己写
     *
     * 只有本函数（{@link collectClaimResults}）知道**当前是哪个账号** —— 它在循环里
     * 握着 `entry.credentialRef`，而注入的 `claim` 闭包只拿到凭据本身。Trae CN 的
     * 「9074 换设备号」路径需要在领取过程中**改写凭据**（换号后落盘，下一轮才不用
     * 旧号去撞黑名单），那个动作必须落到**这个账号自己的 ref** 上。
     *
     * 传**回调**而不是传 ref 名字：写什么（序列化格式、要不要顺带更新别的字段）是
     * provider 的知识，由接线层（`src/index.ts` 的 `ctx.credentials`）持有；
     * 本模块只负责「哪个账号」。
     *
     * ⚠️ 已注入两参 `claim` 的调用方**不受影响**（TS 允许少形参），它们是
     * CodeArts / LobsterAI / Qoder 与 Buddy 系 —— 那几条协议都没有「领取中途改凭据」
     * 的需求。
     */
    claim?: (credential: TCredential, product: TProduct, persistCredential?: (credential: TCredential) => void | Promise<void>) => Promise<ClaimOutcome>;
    /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
    fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>;
    /**
     * 带**精确原因**的余额查询（可选，优先于 {@link fetchBalance}）。
     *
     * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
     * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
     * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
     * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
     * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
     *
     * `error` 为 `undefined` 且 `balance` 为 `null` 时，调用方按「余额查询失败」
     * 兜底 —— 实现不必自己造一句笼统文案。
     */
    fetchBalanceDetailed?: (credential: TCredential, product: TProduct) => Promise<{
        balance: CreditBalance | null;
        error?: string;
    }>;
    /**
     * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
     * 使用的 fetch。
     *
     * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
     * `(credential, product, fetcher)`，而本模块的历史写法用**双重类型断言**
     * （`deps.claim ?? (claimDailyCheckin as …)`）把三参函数硬转成「只传两个参数」
     * 的类型 —— 于是调用点写 `claim(credential, product, entry)` 时，`entry` 落进了
     * **`fetcher` 的位置**，运行时抛 **`TypeError: fetcher is not a function`**。
     *
     * 现改为**显式包装**默认实现（见 `collectCreditsStatus` / `collectClaimResults` /
     * `collectCreditBalances`），把 fetcher 正确送进第三参。未提供时用全局 `fetch`。
     */
    fetcher?: typeof fetch;
    /** 单账号异常时的告警出口（不参与控制流）。 */
    warn?: (message: string) => void;
    /**
     * 账号凭据写回出口（**可选**，2026-09-23 新增）。
     *
     * 用途只有一个：Trae CN 的 **9074 换设备号**路径需要在领取过程中改写该账号的
     * 凭据（换号后落盘，下一轮 sweep 才不用旧号去撞服务端的设备号黑名单）。
     *
     * `refName` 是**账号自己的** `credentialRef`（由 {@link collectClaimResults} 从
     * 当前 `entry` 解出），实现方负责 `ctx.credentials.set(credentialRef(refName), …)`
     * 与序列化格式 —— 本模块刻意不碰存储细节。
     *
     * 省略时该路径**照常工作**，只是不落盘（老宿主 / 单测的既定降级）。
     */
    persistCredential?: (refName: string, credential: TCredential) => void | Promise<void>;
    /**
     * 领取前是否先查一次签到状态（默认 `true`）。
     *
     * Buddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
     * 领取请求（活动未开 / 今天已领时直接短路）。
     *
     * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
     * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
     * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
     * 故它传 `false` 跳过预检，直接交给 `claim`。
     */
    precheckStatus?: boolean;
    /**
     * 本批账号所属的 **provider id**（**签到前后余额比对**的开关与口径来源）。
     *
     * ## 为什么由调用方传，而不是从 `product` 反推
     *
     * 比对要做两个按 provider 的判定：① 该 provider 是否登记为参与比对
     * （`comparesBalanceAroundClaim`）；② 它是不是 Qoder 系（那个 provider id 决定
     * 拿哪个 region 的实例，而 product 里没有 id 之外的信息）。本模块对泛型
     * `TProduct` 一无所知，**只有调用方知道手里这个是哪个 provider**。
     *
     * ⚠️ **省略 = 不做比对**（既有调用点与单测的既定降级）：那时 outcome 逐字段
     * 与改动前一致。新增调用点若忘了传，最坏是少一道防线，而**不会**让请求凭空
     * 多出两次余额查询。
     */
    provider?: string;
}
/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `account-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export declare function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsStatusResponse['accounts']>;
/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export declare function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsClaimAllResponse>;
/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export declare function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(accounts: readonly ProviderAccountEntry[], product: TProduct, deps: CreditsEndpointDeps<TCredential, TProduct>): Promise<RpcCreditsBalancesResponse['accounts']>;
/**
 * 查询某 provider 全部账号余额所需的宿主依赖。
 *
 * 抽出来是因为它有**三个调用方**：RPC `credits.balances`（面板打开 / 手动刷新）、
 * 宿主的**定时余额缓存刷新**（最高优先档的依赖，见 `src/index.ts`）与
 * `consumption.set` 的**切档补刷**。三处各写一份分派必然漂移 —— 而漂移的形态很
 * 隐蔽：面板显示的数字与选号用的数字来自两套口径，用户看到「余额最高的那个」
 * 并不是实际被选中的那个。
 *
 * ⚠️ **同一口径不止是「查同一份数据」，还包括「同一处回写」**：查到的余额必须经
 * {@link recordCollectedBalances} 写进池缓存，否则面板路径查完就丢，最高优先档
 * 依旧读不到数据（这正是「配了该档却一直用第一个账号」的根因）。两个调用方都
 * 必须调它。
 */
export interface ProviderBalancesDeps {
    /** 账号池（读账号列表 + 回写余额缓存）。 */
    pool: AccountPool;
    ctx: Context;
    qoder: QoderAuth;
    qoderCn: QoderAuth;
}
/**
 * 逐账号查询某 provider 的余额（三个调用方**共用**的唯一实现）。
 *
 * ⚠️ **`provider` 是面板 id**，池键映射（{@link poolProviderFor}）在本函数内部完成
 * —— 调用方都不该各自映射一次。
 *
 * ⚠️ 本函数**只查不记**：写回缓存是调用方的责任，且必须走
 * {@link recordCollectedBalances}（唯一写入口径）。
 *
 * @returns 每个账号的余额条目（含失败原因）；provider 无法识别时返回 `undefined`
 *          （调用方决定是回 RPC 错误还是跳过）。
 */
export declare function collectProviderBalances(deps: ProviderBalancesDeps, provider: string): Promise<RpcCreditsBalancesResponse['accounts'] | undefined>;
/**
 * 余额缓存刷新：只刷**配置了「最高优先」档**的 provider。
 *
 * ## 为什么必须按档位过滤（而不是刷全部）
 *
 * 余额刷新是**逐账号一次网络请求**。七个 provider × 每人数个账号 = 每次刷新十几到
 * 几十个请求；而只有开了「最高优先」档的 provider 才**真的会读**这些数字
 * （见 `AccountPool.applyConsumptionOrder`）。为没开那一档的 provider 白打请求
 * 是纯粹的浪费与风控风险。
 *
 * ## 失败一律静默
 *
 * 它跑在定时器里，没有用户可操作的上下文；抛错只会变成一个 unhandledRejection。
 * 单个 provider 失败也不影响其余 —— 最高优先档在余额未知时自动降级回顺序模式。
 *
 * @param providers - 可选**白名单**：只刷名单里的 provider（与档位过滤是**交集**）。
 *        唯一的白名单调用方是 `consumption.set` —— 用户中途切到「最高优先」档时
 *        缓存大概率是空的（它只在启动 + 每 4h 被填），不补一次就会**静默退化**成
 *        顺序档；而切档只需要这一个 provider 的数据，没有理由顺带打其余六个。
 *        定时刷新（`src/index.ts`）不传，语义仍是「刷全部该档 provider」。
 * @returns 实际刷新的 provider 列表（供调用方记日志与测试断言）。
 */
export declare function refreshConsumptionBalances(deps: ProviderBalancesDeps, providers?: readonly string[]): Promise<string[]>;
/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单、也不套目录门控**的
 * 完整目录（带最终展示名）。
 *
 * ## 为什么需要它
 *
 * 适配器的 `listModels` 会按用户黑名单过滤，于是**被关闭的模型不在其返回值里**；
 * 设置页必须把它们渲染出来（否则用户无法重新打开），此前只能凭黑名单的键（裸 id）
 * 补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。
 * 有了本接口，关闭项与开启项走同一份目录、同一个名字。
 *
 * ⚠️ 它**同时不受目录门控影响**（`providerCatalogVisible`）：没有已登录账号时
 * `listModels` 返回空数组（整个 provider 分组从模型选择器消失），而设置页仍须
 * 列出该 provider 的全部模型 —— 反而更需要它（此时 `listModels` 一个都不给）。
 *
 * ⚠️ `autoroute.catalog` 会在读取本目录前通过 `llm.listModels()` 预热适配器缓存；
 * 若预热失败，仍继续读取此方法提供的缓存/静态兜底目录。
 *
 * ⚠️ **只声明用到的方法**（结构化类型），避免本模块依赖七个具体适配器类。
 * 实例由 `src/index.ts` 显式收集后传入（`ctx.llm` 不透传自定义方法）。
 */
export interface ModelCatalogSource {
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
}
/**
 * 逐模型**上下文窗口档位**的**按 provider 分派**注册表（定义在 `src/context-tiers.ts`）。
 *
 * ## 为什么由调用方注入，而不是 RPC 自己去捞
 *
 * 目录的持有者是**适配器实例**（它带 TTL 缓存、远端优先、失败回退静态表）。
 * `ctx.llm.listModels()` 帮不上忙：`LlmRuntime.listModels` 会把适配器返回的条目
 * **重建**成 `{provider, id, name, description?, inputModalities?}`，任何额外字段都
 * 在那一层被丢掉（已读 `lib/types/index.js` 确认），所以窗口档位不可能搭它的车。
 * 而 `ctx` 上也没有「按 provider 取适配器」的入口。最省事、也最不可能撒谎的做法，
 * 就是让组装方（`src/index.ts`）把各 `register*Llm` 返回的实例按 provider id 装进
 * 注册表交过来。
 *
 * ## 从「只服务 Trae CN」推广到全部供应商（2026-09-21）
 *
 * 本层的两个端点原先对 provider 名字写死特判（`req.provider === TRAE_CN.id`），
 * 只服务 Trae CN 的两档形态。推广后**一律问注册表**：`sourceFor(provider)` 有来源
 * 就走通用路径，没有来源就维持既定降级（`model.list` 不带窗口字段、
 * `model.setContextBudget` 拒绝）。
 *
 * ⚠️ **注册表按 provider id 分键，与 `contextBudgets` 的存储分键同构**。
 * 没有档位数据源的 provider（如 LobsterAI：目录里没有档位元数据）**不进注册表**
 * —— 注册进去只会让面板多出一列切了没反应的选项，与「宁缺毋编」同一条铁律。
 */
export type { ContextTierRegistry, ContextTierSource } from './context-tiers.js';
/**
 * 自动签到**全量 sweep**（宿主自触发与 `checkin.sweep` RPC 共用）所需的最小依赖集合。
 *
 * 原实现作为 `registerAccountHubEndpoints` 的闭包捕获 `ctx` / `pool` / 各 auth 实例；
 * 为让 `src/index.ts` 的宿主触发层（启动 sweep + 4h 定时器）能直接调用，把这一整条
 * 执行链抽成模块级函数，把闭包捕获的依赖显式收进这一个对象。**只搬结构、不改行为**：
 * `runCreditsClaim` / `performCheckinOnTargets` / `performCheckinSweep` 的执行体与原
 * 闭包版逐字相同，既有 RPC 分支（`credits.claimAll` / `checkin.perform` / `checkin.sweep`）
 * 经它调用后行为零变化。
 */
export interface CheckinSweepDeps {
    ctx: Context;
    pool: AccountPool;
    lobsterai: LobsteraiAuth;
    qoder: QoderAuth;
    qoderCn: QoderAuth;
}
/**
 * 执行一次**全量 sweep**（`checkin.sweep` RPC / 宿主定时器共用入口）。
 *
 * - 只遍历 {@link CHECKIN_ELIGIBLE_PROVIDERS}（六条）；
 * - 无账号 provider 跳过；
 * - 每个 provider 只签**此刻可签**的账号（`pool.isCheckinDue`：无记录、或记录的
 *   下一次可签时刻已过）；
 * - 模块级互斥 {@link checkinBusy}：已有一趟在跑（sweep **或**面板单发
 *   `checkin.perform`）就**直接返回进行中快照**，不排队不重入（设计文档 §9）。
 */
export declare function performCheckinSweep(deps: CheckinSweepDeps): Promise<RpcCheckinSweepResponse>;
/**
 * {@link registerAccountHubRpc} 的**单一 options 对象形参**。
 *
 * ## 为什么从位置实参改成对象
 *
 * 原签名收 **12 个位置实参**（`ctx` + `pool` + 七个 auth 服务 + 三个可选注入），
 * 每新增一个 provider 都要改签名，并且**全部转发点与调用点必须同步改**。更危险的是
 * 位置实参的**静默错位**：相邻的 auth 服务类型相同（七个都是 `login/status/refresh/
 * logout` 形状），互换两个实参 `tsc` 一声不吭，只表现为「登录写进了另一个 provider」。
 *
 * 改成单一 options 对象后：**新增 provider 只加字段，不再动签名**；调用点按字段名
 * 传参、与顺序无关；字段名与原形参名逐一对应（含可选性），故本次重构是纯搬运。
 *
 * ## 两套按 provider 分键的映射：类型层保护
 *
 * {@link contextTiers} 与 {@link modelAdapters} 都按 provider id 分键，且**漏登记
 * 只会静默退化**（档位不显示 / 关闭项退回裸 id）。二者的键现由 `ProviderId`
 * 联合（`src/types.ts` 的唯一真相源）约束，键拼错在调用点的对象字面量处被
 * excess property check 拦下；「漏登记」编译期不报（`Partial` 允许子集），
 * 由 {@link warnMissingTierSources} 运行时兜底。
 */
export interface AccountHubRpcOptions {
    /** 宿主上下文。`connection` 只存在于 Web bundle，故由本函数**惰性注入**。 */
    ctx: Context;
    /** 账号池（持久层与候选优先级）。 */
    pool: AccountPool;
    /** CodeArts 认证服务。 */
    codearts: CodeArtsAuth;
    /** Buddy **中国版**认证服务（与 {@link buddy} 同源、不同产品配置）。 */
    buddyCn: BuddyAuth;
    /** Buddy **国际版**认证服务。 */
    buddy: BuddyAuth;
    /** LobsterAI 认证服务。 */
    lobsterai: LobsteraiAuth;
    /** Trae CN 认证服务。 */
    traeCn: TraeCnAuth;
    /** Qoder **国际版**认证服务。 */
    qoder: QoderAuth;
    /** Qoder **国内版**认证服务（与 {@link qoder} 同协议、双 region）。 */
    qoderCn: QoderAuth;
    /**
     * 可选的窗口档位注册表（见 {@link ContextTierRegistry}）。
     *
     * 省略时 `model.list` 不带窗口字段、`model.setContextBudget` 一律拒绝 ——
     * 这是 headless / 测试场景的既定降级，不是缺陷。
     *
     * ⚠️ **构造点的键也受 `ProviderId` 约束**（`createContextTierRegistry` 的形参
     * 已收窄）：键写错在那里就会报错，而不是等到这里。
     */
    contextTiers?: ContextTierRegistry;
    /**
     * 可选的 provider → 适配器实例映射（见 {@link ModelCatalogSource}）。
     *
     * 用于「显示列表」拿到**不套用户黑名单、也不套目录门控**的完整目录，使被关闭的
     * 模型也显示正确的展示名（含倍率）而不是退化成裸 id。省略时退化为
     * 「`listModels` 结果 + 黑名单裸 id 回补」的历史行为（同样是 headless / 测试的
     * 既定降级）。
     *
     * ⚠️ **键是 `Partial<Record<ProviderId, …>>`**：拼错键编译期报错；但 `Partial`
     * 允许子集，「漏登记某 provider」不报错 —— 那由 {@link warnMissingTierSources}
     * 在注册入口运行时告警。本插件七个 provider **一个都不能少**
     * （缺一个，那一个的关闭项就退回裸 id）。
     */
    modelAdapters?: Partial<Record<ProviderId, ModelCatalogSource>>;
    /**
     * 可选的**配置变更通知**（`autoroute.set` 成功后调用）。
     *
     * 自动路由的运行时（降级队列）由聚合适配器持有，而配置写入发生在池上 ——
     * 没有这条通知，用户在面板里改了候选顺序后，适配器仍握着**旧队列**：新加的
     * 候选永远轮不到、删掉的还会被使用，且没有任何报错。由 `src/index.ts` 传
     * `ensureAutoRouteRegistration`（它内部做内容幂等，重复调用无副作用）。
     * 省略时（headless / 测试）配置照常写入，只是运行时不在本进程内。
     */
    onAutoRouteChanged?: () => void;
    /** 可选更新依赖；headless 测试可省略，更新端点调用时会返回规范错误。 */
    updateDeps?: AccountHubUpdateDeps;
}
/**
 * 注册 Account Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 *
 * @param options - 见 {@link AccountHubRpcOptions}。**新增 provider 时只加字段，
 *        不再改签名**（这正是本函数从 12 个位置实参改成单一对象的原因）。
 */
export declare function registerAccountHubRpc(options: AccountHubRpcOptions): void;
//# sourceMappingURL=account-hub-rpc.d.ts.map