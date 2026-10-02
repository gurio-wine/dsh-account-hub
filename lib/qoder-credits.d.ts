/**
 * Qoder（国际版）额度余额（credits balance）与**额度耗尽判别**。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）/ `src/lobsterai-credits.ts` /
 * `src/trae-cn-credits.ts` **刻意分开**：四条协议线的端点、信封、鉴权头、
 * 余额口径没有一处共用，硬合并只会让某一个文件出现大量 `if (provider === …)`
 * 分支。但**复用 `credits.ts` 的类型**（{@link CreditBalance} /
 * {@link CreditPackage}），故 `collectCreditBalances` 与前端 `CreditBalanceRow`
 * 都不必各写一份 —— 返回值与另外三条线**逐字段同构**。
 *
 * ## 本模块做三件事
 *
 * | 导出 | 消费者 | 说明 |
 * |---|---|---|
 * | {@link fetchQoderCreditBalance} | Account Hub 的 `credits.balances` | 余额卡片 |
 * | {@link checkQoderQuotaExhausted} | **步骤 6** 接线的 `quotaVerdict` | 402 的额度二次判别 |
 * | {@link fetchQoderCheckinStatus} / {@link claimQoderDailyCheckin} | `credits.status` / `credits.claimAll` | 每日领取（两区，见下节） |
 *
 * ## 协议（T1 真机实测，逐字节）
 *
 * ```
 * GET {openapiBase}/api/v2/quota/usage
 * Authorization: Bearer jt-…      ← ⚠️ 只认 job token，PAT 打它回 401 TOKEN_EXPIRE
 * ```
 *
 * 200 响应（T1 原文，本模块全部 fixture 的来源）：
 *
 * ```json
 * {"userId":"…","userType":"personal_standard","usageType":"credits",
 *  "totalUsagePercentage":0.0,"isQuotaExceeded":true,"expiresAt":253402214400000,
 *  "upgradeUrl":"https://qoder.com/pricing?client=qoder","outerProviders":[],
 *  "userQuota":{"total":0.0,"used":0.0,"remaining":0.0,"percentage":0.0,"unit":"credits"},
 *  "isPlanQuotaProrated":false}
 * ```
 *
 * ## 四条硬约束（每条都有对应用例钉死）
 *
 * 1. **凭据只认 `jt-`**。PAT 打本端点回 401 `TOKEN_EXPIRE`（`src/qoder-product.ts`
 *    的 `qoderJobTokenHeaders` 注释），伪令牌回 401 `TOKEN_INVALID`。故本模块
 *    一律经 {@link QoderJobTokenProvider.getJobToken} 取令牌，**从不**直接用
 *    `credential.access_token` 当 Bearer。
 * 2. **三池结构，后两池可缺席**。`userQuota` 是 T1 实测存在的那一个；
 *    `addOnQuota`（加量包）/ `orgResourcePackage`（资源包）**本账号缺席**
 *    —— 解析必须容缺，当作「该池不存在」而不是「该池余额为 0」。
 *    （CLI2API 的 `quota.go` 用指针类型正是这个原因。）
 * 3. **主池耗尽 ≠ 额度耗尽**。只要加量包 / 资源包里还有余额，`exhausted`
 *    就是 false —— 这是 {@link checkQoderQuotaExhausted} 存在的全部意义：
 *    它是 `402 code:116` 唯一被允许通向「换号」的门（`src/qoder-errors.ts`
 *    的 {@link applyQoderQuotaVerdict}）。
 * 4. **`expiresAt` 是毫秒**（`253402214400000` = 9999 年 = 永不过期），
 *    **不是秒**。当成秒会算出公元 800 万年。
 *
 * ## 「查不到」与「余额为 0」严格区分
 *
 * {@link fetchQoderCreditBalance} 失败时返回 `null`（不是 0 余额的
 * {@link CreditBalance}）；{@link checkQoderQuotaExhausted} 失败时返回
 * `undefined`（不是 `{ exhausted: false }`）。两者的下游语义完全不同：
 * 前者由 `collectCreditBalances` 填 `error` 文案，后者让
 * {@link applyQoderQuotaVerdict} **保守判「不换号」** —— 查不到 ≠ 耗尽。
 *
 * ## 身份回写（`userId` / `userType`）
 *
 * `userId` / `userType` **不在 exchange 响应里**，但**在本端点响应里**
 * （T1 原文见上）。故本模块提供纯函数 {@link applyQoderUserIdentity} 做合并，
 * 并由 {@link QoderCreditsOptions.persistIdentity} 这个**出口**交给接线层落盘。
 *
 * ⚠️ **该出口目前无人接线**（宿主侧 `credits.balances` 的
 * `fetchBalance` 签名只拿得到凭据、拿不到凭据 ref，接不了）。这是**刻意留白**
 * 而不是缺陷，理由有二：
 *
 * 1. `user_id` 对**登录链**没有影响 —— PAT 路径的 `user_id` 来自 exchange
 *    响应（`buildQoderCredential` 早就写进去了），而签名链要的 uid 是
 *    `GET /api/v1/userinfo` 现场取的，都不读这一个字段；
 * 2. 账号卡片的**昵称**（当初想靠这个出口修的东西）改由 userinfo 的 `name`
 *    提供，见 `qoder-product.ts` 的 `resolveQoderAccountNickname`。
 *
 * 故**不要再**把「昵称变成真实用户 id」当成该出口的用途：`user_id` 是
 * UUIDv7，写成昵称正是用户报障「昵称是 UUID 码」的那个形态。
 *
 * ## 每日领取（签到）
 *
 * 端点由 **keylog 解密抓包** 解出（2026-09-21，真机 200）：
 *
 * ```
 * GET  {openapiBase}/sash/api/v1/me/campaigns
 * POST {openapiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空串**
 * ```
 *
 * ⚠️ **必须带 `Cosy-ClientType: 10`**（2026-09-24 真机定案，见
 * `qoderCampaignHeaders`）：缺这个头时服务端**恒回空列表** —— 那不是服务端事实，
 * 而是缺头的产物。官方 47 条响应里空列表出现 **0** 次。作用域**只限本端点的
 * 两个请求**（`/sash/` 前缀），quota / chat 等仍走不带 Cosy 头的
 * `qoderJobTokenHeaders`（未验证过加头对它们的影响）。
 *
 * 头只需 `Authorization: Bearer …`（与余额同源：经 jt 换取），**无需 wasm 签名**
 * —— 它挂在 `/sash/` 前缀下，不走 `algo` 签名路径。早期只按 `/api/` 前缀搜端点，
 * 因此误判「Qoder 无签到」（用户报障：「登录成功了，没有获取积分吗？」）。
 *
 * 五条硬约束（每条都有对应用例）：
 *
 * 1. **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**。重复领取同样回
 *    **200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是**上一次
 *    领取的旧时间**（实测请求发生在 09-21、`claimedAt` 却是 09-18）。只看状态码
 *    会把「今天已领」误报成「领取成功 +100」。故 `replayed === true` **归一为
 *    `already-claimed`**。
 * 2. **请求体必须是空串**（抓包实测 `content-length: 0`）。
 * 3. **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`** ——
 *    实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。
 * 4. **活动列表是唯一判据源，且判读只有一份**（{@link readQoderCampaignDayState}）：
 *    `CLAIM_BENEFIT + CLAIMED` ⇒ **今天已领**（`already-claimed`）、
 *    `CLAIM_BENEFIT + CLAIMABLE` ⇒ 未签（走领取）、空列表或仅 `VIEW_DETAILS`
 *    ⇒ **判不了**（`undetermined`，**不写签到状态**，下轮 sweep 重试）。
 *    `CheckinStatus.active` **恒为 `true`**（拿到响应即活动开启），**不按列表是否
 *    为空判** —— 否则调用方会先命中「活动未开启」分支。
 * 5. **⚠️ 定案更正（2026-09-24）**：「空列表 = 协议无法区分」这条 60f8127 的
 *    前提**被真机推翻了一半** —— 缺 `Cosy-ClientType` 时看到的空列表是**缺头
 *    假象**（本模块已补头）；补头后仍为空，才是真的判不了。故本模块的措辞一律是
 *    「**带头仍空** ⇒ undetermined」，不要简写成「空列表 ⇒ undetermined」。
 *
 * ## 签到两区共用一份实现
 *
 * 宿主 `credits.status` / `credits.claimAll` 对**两个 region** 都接线：
 * CN 端点由 keylog 解密抓包解出并真机验收（2026-09-21），国际版同一端点已
 * 真机探测（2026-09-23）HTTP 200、响应与 CN 逐字节同构。协议实现本身按传入
 * 的 `product` 现算 host，两区共用一份代码，region 差异全部由产品配置承载。
 */
import type { QoderCredential, QoderProduct } from './qoder-product.js';
import { type QoderErrorClassification, type QoderQuotaVerdict } from './qoder-errors.js';
import type { QoderMachineIdentityFetcher } from './qoder-machine-identity.js';
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js';
/**
 * 额度端点的三个池键，**顺序即响应里的声明顺序，也是包列表的展示顺序**。
 *
 * `userQuota` 必在（T1 实测）；后两个**本账号缺席** —— 见模块头注释第 2 条。
 * 顺序写死在这里而不是按响应对象的键序：解析结果的池顺序必须稳定，
 * 否则包列表在两次查询之间会换位置。
 */
export declare const QODER_QUOTA_POOL_KEYS: readonly ["userQuota", "addOnQuota", "orgResourcePackage"];
/** 池键类型。 */
export type QoderQuotaPoolKey = typeof QODER_QUOTA_POOL_KEYS[number];
/**
 * 池键 → 中文包名。
 *
 * ⚠️ **quota 响应里没有任何包名字段**（对比 Trae CN 的礼包有 `name`、
 * CodeBuddy 的有 `PackageName`）—— 响应只有池**类型**。故包名只能取池类型，
 * 用 DSH 现有的中文包名惯例（「主额度」对齐 `credits.ts` 的
 * 「CodeBuddy个人体验版」这类可读名，而不是把 `userQuota` 原样透出）。
 */
export declare const QODER_QUOTA_POOL_LABELS: Readonly<Record<QoderQuotaPoolKey, string>>;
/**
 * 池未声明 `unit` 时的单位。
 *
 * 实测主池带 `unit: "credits"`，但另外两个池**本账号缺席**、字段未观测到，
 * 故需要一个兜底 —— 不能因为字段缺失就把单位渲染成 `undefined`。
 */
export declare const QODER_QUOTA_UNIT_FALLBACK = "credits";
/**
 * 单个额度池（三池同构）。
 *
 * 字段名逐字符取自 T1 实测的 `userQuota`，与 CLI2API 的 `quota.go` 一致
 * （每池 `{total, used, remaining, percentage, unit, available?}`）。
 */
export interface QoderQuotaPoolEntry {
    /** 池键（`userQuota` / `addOnQuota` / `orgResourcePackage`）。 */
    key: QoderQuotaPoolKey;
    /** 展示用包名（见 {@link QODER_QUOTA_POOL_LABELS}）。 */
    name: string;
    /** 池总额度。 */
    total: number;
    /** 已用额度。 */
    used: number;
    /** 剩余额度（**余额口径的唯一来源**）。 */
    remaining: number;
    /** 服务端自报的已用百分比（仅展示，**不参与**任何判定）。 */
    percentage: number;
    /** 单位（实测 `credits`）。 */
    unit: string;
    /**
     * 服务端是否声明该池可用（CLI2API 情报里的可选字段，**本账号未观测到**）。
     *
     * 记录但**不参与**过滤：T1 响应里没有这个字段，若拿它当门槛，字段缺失的池
     * 会被判成不可用 —— 而「字段缺失」与「明确不可用」是两件事。
     */
    available?: boolean;
}
/** 解析后的整份额度响应。 */
export interface QoderQuotaUsage {
    /** 用户 id（`userId` / `user_id`）—— 步骤 1 留下的回写缺口之一。 */
    userId?: string;
    /** 用户类型（`userType` / `user_type`，实测 `personal_standard`）。 */
    userType?: string;
    /** 计量类型（实测 `credits`）。 */
    usageType: string;
    /** 服务端自报的总用量百分比。 */
    totalUsagePercentage: number;
    /**
     * 服务端自报的「额度已耗尽」。
     *
     * ⚠️ 它**不单独构成**耗尽结论：还要三池 `remaining` 全为 0
     * （见 {@link checkQoderQuotaExhausted}）。字段缺失按 `false` ——
     * 归一是刻意的，缺字段时保守判「未耗尽」，与「未确证前绝不换号」同向。
     */
    isQuotaExceeded: boolean;
    /**
     * 额度计划过期时刻（**毫秒**）。
     *
     * ⚠️ 实测值是 `253402214400000`（9999 年，即永不过期）。**当成秒**会算出
     * 公元 800 万年（见 {@link parseQoderQuotaExpiresAtMs}）。
     *
     * **它不参与池的 `active` 判定**，理由见 {@link fetchQoderCreditBalance}。
     */
    expiresAtMs?: number;
    /** 升级引导 URL（实测 `https://qoder.com/pricing?client=qoder`）。 */
    upgradeUrl: string;
    /** 三池（按 {@link QODER_QUOTA_POOL_KEYS} 顺序，**缺席的池不在列表里**）。 */
    pools: readonly QoderQuotaPoolEntry[];
    /** 计划额度是否按比例折算（实测 false；仅记录）。 */
    isPlanQuotaProrated: boolean;
}
/**
 * 把 `expiresAt` 归一成毫秒时间戳。
 *
 * ## 为什么不能无条件 `* 1000`
 *
 * T1 实测值是 `253402214400000` —— 这是**毫秒**（9999-12-31T23:59:59.999Z 附近）。
 * 当成秒会得到 `2.534e17`，即公元 800 万年，任何与 `Date.now()` 的比较都会
 * 得出「还没过期」的**偶然正确**结论，而一旦有人把它渲染成日期就会显示一个
 * 荒谬的年份。
 *
 * 判据与 {@link qoderCredentialExpiresAtMs}（`src/qoder-product.ts`）同口径：
 * `> 1e12` 视为毫秒（1e12 毫秒 = 2001-09-09，任何真实的毫秒时间戳都大于它），
 * 否则视为秒。字符串形态（`"253402214400000"` 或 ISO 8601）一并接受。
 *
 * @returns 毫秒时间戳；无法解析返回 undefined。
 */
export declare function parseQoderQuotaExpiresAtMs(value: unknown): number | undefined;
/**
 * 解析额度端点的 200 响应体。
 *
 * ## 容缺规则（唯一一处，不要在别处再写一份）
 *
 * - **每个池独立解析**：不是对象的池 = 该池**不存在**（T1 本账号就没有
 *   `addOnQuota` / `orgResourcePackage`），而不是「该池余额为 0」；
 * - **一个池都没有** → 返回 `undefined`。这是「响应形态不是我们认识的那个」
 *   的信号，必须与「三池全为 0 的真余额 0」区分开（见模块头注释最后一节）；
 * - **其余字段宽松**：`isQuotaExceeded` / `isPlanQuotaProrated` 缺失按 false，
 *   `totalUsagePercentage` 缺失按 0，`usageType` / `upgradeUrl` 缺失按空串。
 *   它们**都不参与**余额计算，只是记录。
 *
 * @param body - 响应体 JSON 的解析结果。
 * @returns 解析结果；形态无法识别时 undefined。
 */
export declare function parseQoderQuotaUsage(body: unknown): QoderQuotaUsage | undefined;
/**
 * 三池 `remaining` 之和（负数按 0 计，两位小数规整）。
 *
 * 负数 clamp 与另外三条协议线同因：服务端在超额扣费 / 计量回滚等异常下可能
 * 下发负值，原样相加会让余额显示成负数。
 */
export declare function qoderQuotaRemainingTotal(usage: QoderQuotaUsage): number;
/**
 * 取 job token 的最小依赖面。
 *
 * 刻意**不**直接依赖 `QoderAuth` 类：那会把 `cordis` 的 `Context` 与整个
 * Service 生命周期拖进本模块的签名里，单测也就必须造一个真的服务实例。
 * `QoderAuth`（`src/qoder-auth.ts`）在结构上恰好满足本接口，接线时直接传实例。
 */
export interface QoderJobTokenProvider {
    /**
     * 取一个可用的 job token（`jt-…`），必要时自行重打 exchange。
     *
     * @throws 实现约定的终态错误（`name === 'RefreshTokenExpiredError'`）表示
     *         PAT 已失效、需用户重新粘贴。
     */
    getJobToken(pat: string): Promise<string>;
    /** 丢弃该 PAT 的 jt 缓存（下次 {@link getJobToken} 必然重换）。 */
    invalidateJobToken(pat: string): void;
}
/** {@link fetchQoderQuotaUsage} 与两个公开查询函数共用的选项。 */
export interface QoderCreditsOptions {
    /** 注入的 fetch（测试用）；默认全局 fetch。 */
    fetcher?: typeof fetch;
    /** 产品配置；默认 {@link QODER}。 */
    product?: QoderProduct;
    /** 取消信号（与超时信号合并）。 */
    signal?: AbortSignal;
    /**
     * 身份回写出口。
     *
     * 当 quota 响应里的 `userId` / `userType` 与凭据现值**不同**时被调用，
     * 入参是合并后的新凭据；接线层负责 `ctx.credentials.set(ref, …)`。
     * 未变化时**不调用** —— 每次刷新积分都写一次凭据是纯粹的磁盘抖动。
     *
     * 回调抛错不会影响余额结果（只经 {@link QoderCreditsOptions.onDebug} 记账）：
     * 身份字段缺失只影响昵称显示，不该让一次成功的余额查询变成失败。
     */
    persistIdentity?: (credential: QoderCredential) => void | Promise<void>;
    /**
     * 设备身份取用出口（**只被 `/sash/` 签到链路消费**）。
     *
     * 缺省走 `qoder-machine-identity.ts` 的 {@link getQoderMachineIdentity}（真机可用
     * 路径）；单测注入替身以避免真的起子进程。
     *
     * ⚠️ **CN 不会经这里取任何东西**：`getQoderMachineIdentity` 的第一道闸就是产品字段
     * `campaignDeviceIdentity`（CN 不声明）⇒ 一个 exe 都不调。故在接线层不必再写
     * region 判断（两处判据必然漂移）。
     */
    machineIdentity?: QoderMachineIdentityFetcher;
    /** 脱敏调试出口（只输出原因与状态码，**不输出令牌与凭据**）。 */
    onDebug?: (message: string) => void;
}
/**
 * 一次额度查询的结果。
 *
 * 与另外三条协议线的 `Promise<CreditBalance | null>` 不同，本类型**保留失败
 * 原因与错误分类**：步骤 6 的接线既要能填 `credits.balances` 的 `error` 文案，
 * 也要能把 401 的两类分型喂给适配器（`jt 过期 → 重换` vs `PAT 类型错 → 重贴`）。
 */
export type QoderQuotaFetchResult = {
    ok: true;
    usage: QoderQuotaUsage;
} | {
    ok: false;
    message: string;
    classification?: QoderErrorClassification;
};
/**
 * 查询额度用量（带 **401 的自愈重试一次**）。
 *
 * 流程与 `src/qoder-auth.ts` 的 exchange 同构，但多一层令牌自愈：
 *
 * 1. 取 jt（`auth.getJobToken`，命中缓存则零网络往返）；
 * 2. `GET {openapiBase}/api/v2/quota/usage` + `Bearer jt-…`；
 * 3. **401 `TOKEN_EXPIRE`** → `invalidateJobToken` + 重取一次再打一遍。
 *    这是「缓存里的 jt 名义未过期、服务端却已失效」的唯一解药
 *    （`getJobToken` 的提前 1h 刷新窗口覆盖不到时钟偏差与服务端提前作废）；
 * 4. **401 `TOKEN_INVALID`** → 直接报「请重新粘贴 PAT」。PAT 的**类型**不对
 *    （粘了 `dt-` 设备令牌、粘了别家 token），重换 jt 只会再撞一次同一堵墙；
 * 5. 其余 4xx/5xx 与网络失败 → 分类后如实上报，**不当成「额度耗尽」**
 *    （查不到 ≠ 耗尽，见模块头注释）。
 *
 * @param credential - 凭据（PAT 在 `access_token`）。
 * @param auth - job token 提供者（接线时传 `ctx.qoderAuth`）。
 * @param options - 注入点与调试出口。
 */
export declare function fetchQoderQuotaUsage(credential: QoderCredential, auth: QoderJobTokenProvider, options?: QoderCreditsOptions): Promise<QoderQuotaFetchResult>;
/**
 * 把额度响应里的 `userId` / `userType` 合并进凭据。
 *
 * 纯函数：**不落盘**，落盘由调用方通过
 * {@link QoderCreditsOptions.persistIdentity} 完成（本模块拿不到凭据 ref，
 * 也不该猜）。
 *
 * 三条合并规则：
 * - 响应**没带**该字段 → 沿用旧值（不能把已有的身份抹掉）；
 * - 响应带的值与旧值**相同** → 不算变化；
 * - **两者都没变化时返回原对象引用**（调用方可用 `===` 判断「无需落盘」）。
 *
 * @param credential - 旧凭据。
 * @param usage - 额度响应解析结果。
 * @returns 合并后的凭据；无变化时是入参本身。
 */
export declare function applyQoderUserIdentity(credential: QoderCredential, usage: Pick<QoderQuotaUsage, 'userId' | 'userType'>): QoderCredential;
/**
 * Qoder 的余额结果 —— 与共用 {@link CreditBalance} **逐字段同构**。
 *
 * 故 `collectCreditBalances` 与前端 `CreditBalanceRow` **无需任何 provider
 * 分支**（这是「逐字段同构」的全部价值，也是 trae-cn 分池改造后的同一约定）。
 */
export type QoderCreditBalance = CreditBalance;
/**
 * 查询账号的额度余额。
 *
 * ## 余额口径
 *
 * - `total` = 三池 `remaining` 之和（缺席的池按 0 计，负数 clamp 到 0），
 *   两位小数规整 —— 多池浮点噪声会放大成 `655.67000031`；
 * - `packages` = **有余额或有总量**的池（见 {@link hasQuotaSubstance}），
 *   包名取池类型（quota 响应没有包名字段，见 {@link QODER_QUOTA_POOL_LABELS}）；
 * - `expiredTotal` **恒为 0**，且**这是有依据的**：quota 端点只在**账号级**
 *   给一个 `expiresAt`（实测 `253402214400000` = 9999 年 = 永不过期），
 *   **池本身没有失效字段**（`Status: 3 = 已过期` 是 CodeBuddy 那条线的概念）。
 *   拿账号级时间戳当池失效判据会在哨兵值（如 `0` 表示「不设过期」）上产生
 *   **假的**「另有 N 已失效」，把一个满额账号显示成 0 分 —— 代价远大于收益。
 *   故 `expiresAtMs` 只作为诊断字段保留在 {@link QoderQuotaUsage} 里。
 *
 * ## 失败语义
 *
 * 返回 `null` 表示**查不到**（网络失败 / jt 失效 / 响应形态不认识），
 * 与「余额为 0」（返回一个 `total: 0` 的 {@link CreditBalance}）严格区分 ——
 * 由 `collectCreditBalances` 填 `error` 文案，卡片显示原因而不是 0。
 */
export declare function fetchQoderCreditBalance(credential: QoderCredential, auth: QoderJobTokenProvider, options?: QoderCreditsOptions): Promise<QoderCreditBalance | null>;
/**
 * 查询该账号的额度是否**确证**耗尽 —— `src/qoder-errors.ts` 预留的
 * `quotaVerdict` 接口背后的真数据源（步骤 6 接线到适配器）。
 *
 * ## 判据（两条**同时**成立才算耗尽，缺一不可）
 *
 * 1. 服务端自报 `isQuotaExceeded === true`；
 * 2. **三池 `remaining` 全为 0**。
 *
 * 第 2 条是这个函数存在的理由：**主池耗尽 ≠ 额度耗尽**。CLI2API 的关键修正
 * 逻辑就在这里 —— 主池（`userQuota`）用光但加量包 / 资源包还有余额时，账号
 * 仍然可以继续用，此时判「耗尽」并换号会白白废掉一个可用账号。
 *
 * ## 失败一律 `undefined`（= 未确证），绝不是 `{ exhausted: false }`
 *
 * 两者在 {@link applyQoderQuotaVerdict} 里的处置**恰好一致**（都判「不换号」），
 * 但语义不同：`undefined` 说的是「没查到，保守不动」，`false` 说的是「查到了，
 * 额度没用完」。把查询失败归成 `false` 会让日志与真机排查失去区分度。
 *
 * ⚠️ 本函数**不发** chat 请求、**不换号**、**不写冷却徽章** —— 它只回答一个
 * 事实问题。换号决定由适配器在步骤 6 接线后做出。
 *
 * @param credential - 凭据（PAT 在 `access_token`）。
 * @param auth - job token 提供者（接线时传 `ctx.qoderAuth`）。
 * @param options - 注入点与调试出口。
 * @returns 额度结论；查询不可用时 `undefined`。
 */
export declare function checkQoderQuotaExhausted(credential: QoderCredential, auth: QoderJobTokenProvider, options?: QoderCreditsOptions): Promise<QoderQuotaVerdict | undefined>;
/**
 * 判定一份**已解析**的额度响应是否确证耗尽（纯函数）。
 *
 * 抽出来是为了让「两条判据」成为可穷举单测的纯逻辑，不必每次都造一份响应体；
 * {@link checkQoderQuotaExhausted} 只是「取数 + 调它」。
 */
export declare function isQoderQuotaExhausted(usage: QoderQuotaUsage): boolean;
/**
 * 活动列表路径（挂 `openapiBase`）。
 *
 * ⚠️ 挂在 **`/sash/`** 下、**不是** `/api/` —— 早期只按 `/api/` 前缀搜端点，
 * 因而误判「Qoder 无签到接口」（见模块头注释）。
 */
export declare const QODER_CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";
/** 可领取活动的 `actionType`（另一类是 `VIEW_DETAILS`，对它发 claim 是错的）。 */
export declare const QODER_CAMPAIGN_ACTION_CLAIM = "CLAIM_BENEFIT";
/** 领取前的权威判据值（`campaigns[].claimStatus`）。 */
export declare const QODER_CAMPAIGN_STATUS_CLAIMABLE = "CLAIMABLE";
/** 领取成功响应里的 `status`（实测原文）。 */
export declare const QODER_CAMPAIGN_STATUS_CLAIMED = "CLAIMED";
/**
 * 一个活动条目（`campaigns[]` 的一项，**只保留实现需要的字段**）。
 *
 * 响应里还有 `description` / `startAt` / `endAt` 等展示字段，本模块不消费，
 * 故不解析 —— 解析了就会有「谁在用」的疑问，而答案是没有人。
 */
export interface QoderCampaign {
    /** 领取 URL 里的路径段（实测形如 `01a0bf8d-…`）。 */
    campaignId: string;
    /** 活动键（实测 `act-20260921-308`），用作展示名。 */
    campaignKey?: string;
    /**
     * 动作类型：`CLAIM_BENEFIT` = 可领取积分；`VIEW_DETAILS` = 仅跳转详情。
     *
     * 实测「Pro 首月翻倍」就是后者 —— 对它发 claim 是错的（见模块头第 3 条）。
     */
    actionType?: string;
    /** `CLAIMABLE` / `CLAIMED` / … —— 领取前的权威判据。 */
    claimStatus?: string;
    /** 可领积分（`benefit.amount`，实测 100）。 */
    amount?: number;
}
/**
 * 活动列表的一次解析结果。
 *
 * ⚠️ **`claimable:false` + `campaigns:[]` 不代表「没有活动」**：2026-09-24 真机
 * 定案显示，**缺 `Cosy-ClientType` 时服务端恒回这种形态**（缺头假象，已修），
 * 而补头后仍为空才是真判不了。故本类型只是**如实记录**，调用方不得据此判
 * 「活动未开启」；判读统一走 {@link readQoderCampaignDayState}。
 */
export interface QoderCampaigns {
    /** 服务端自报「是否展示活动入口」（仅记录，不参与判定）。 */
    showCampaign: boolean;
    /** 服务端自报「是否有可领项」（仅记录，不参与判定）。 */
    claimable: boolean;
    /** 活动列表（**带头仍空时判不了，不是「已领」也不是「无活动」**）。 */
    campaigns: QoderCampaign[];
}
/**
 * 解析 `/sash/api/v1/me/campaigns` 的 200 响应体。
 *
 * ## 容缺规则
 *
 * - **顶层不是对象** → `undefined`（形态不认识 ⇒ 查不到，不是「无活动」）；
 * - **`campaigns` 不是数组**（缺失 / null / 其它类型）→ 按**空列表**归一：
 *   字段整个缺失与空数组在语义上同向（都没有可领项），故不把它当成形态错误
 *   —— 否则查得到响应却判成「查不到」。⚠️ 归一成空列表 ≠ 判「已领」：判读见
 *   {@link readQoderCampaignDayState}（空列表一律 `unknown`）；
 * - **单条缺 `campaignId`** → 跳过该条（拿不到 id 就发不出 claim，
 *   伪造一个只会打出一个 404）；
 * - `showCampaign` / `claimable` **只认显式 `true`**（缺失按 false），
 *   但它们**不参与**任何判定，仅作诊断。
 *
 * @param body - 响应体 JSON 的解析结果。
 * @returns 解析结果；顶层形态无法识别时 undefined。
 */
export declare function parseQoderCampaigns(body: unknown): QoderCampaigns | undefined;
/**
 * 可领取的活动：`actionType === 'CLAIM_BENEFIT'` **且** `claimStatus === 'CLAIMABLE'`。
 *
 * 两个条件**缺一不可**：只判 `claimStatus` 会把 `VIEW_DETAILS` 型活动
 * （如「Pro 首月翻倍」）也拿去 claim；只判 `actionType` 会把已领过的再领一次。
 */
export declare function claimableQoderCampaigns(parsed: QoderCampaigns): QoderCampaign[];
/**
 * 从活动列表读出的**当日状态**——三态之一。
 *
 * - `'claimable'`：还有可领项 ⇒ 今天**未签**，走领取；
 * - `'claimed'`：服务端明说 `CLAIM_BENEFIT/CLAIMED` ⇒ 今天**已领**；
 * - `'unknown'`：空列表、或只有 `VIEW_DETAILS` 型 ⇒ **判不了**（不猜）。
 */
export type QoderCampaignDayState = 'claimable' | 'claimed' | 'unknown';
/**
 * **唯一的活动列表判读函数**（claim 与 status 两路共用）。
 *
 * ## 为什么必须收敛成一处
 *
 * 缺陷 2/3（2026-09-24 真机定案）的形态就是「同一份列表被两处用不同判据读」：
 * `claimQoderDailyCheckin` 只留 `CLAIMABLE`、`fetchQoderCheckinStatus` 干脆恒报
 * `todayCheckedIn:false`。结果是签到成功后活动变 `CLAIMED` ⇒ 两处都读成「没有
 * 信息」⇒ 宿主白名单（只认 `claimed` / `already-claimed`）**不写状态** ⇒ 下一轮
 * sweep 重试 ⇒ 又读成「没有信息」—— 用户永远看到「无法判定」，尽管积分已到账。
 * 两处各写一份判据，这种漂移**必然**复发，故判读只留这一份。
 *
 * ## 判据（官方 47 条真机响应支持）
 *
 * `CLAIM_BENEFIT + CLAIMED` 是协议里**唯一明确的「已领」证据**（官方 main.log
 * 里出现 27 次、横跨 5 个账号）；`CLAIM_BENEFIT + CLAIMABLE` 是唯一的「可领」；
 * 其余（空列表、只有 `VIEW_DETAILS`）**什么都不证明**。
 *
 * ⚠️ **顺序**：先判「有可领项」再判「有已领项」—— 多活动账号可能一条已领、
 * 另一条可领，那时今天显然还没领完，必须去领（`claimable` 优先）。
 *
 * ⚠️ **必须同时看 `actionType`**：`VIEW_DETAILS` 型活动（如「Pro 首月翻倍」）
 * 的 `CLAIMED` 与积分签到无关，只按 `claimStatus` 判会把「看了个详情页」写成
 * 「今天已签」（伪造签到，正是本函数要消灭的形态）。
 */
export declare function readQoderCampaignDayState(parsed: QoderCampaigns): QoderCampaignDayState;
/**
 * 查询每日领取状态。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 非 2xx / 形态不认识），与
 * 「无活动可领」严格区分。`CheckinStatus` 是五条签到线共用的结构，此处按
 * Qoder 的语义映射（三条判据见模块头「每日领取」小节）：
 *
 * - `active` **恒为 `true`** —— 拿到响应即活动开启。⚠️ **不按列表是否为空判**：
 *   服务端在「今天已领」时会把 `campaigns` 清空，据此判 `active:false` 会让
 *   `collectClaimResults` 先命中「活动未开启」分支，把「今天已领」误报成
 *   「签到活动未开启」。
 * - `todayCheckedIn`：**只在服务端明说已领时为 true**。⚠️ 2026-09-24 修正两轮：
 *   旧实现写的是「**没有可领活动即为 true**」，那等于把「活动还没开始 / 本账号
 *   暂无活动」也报成已签 —— 这正是「qoder 假签到」的形态（用户看到「已签」而
 *   实际一分没领，且宿主据此写下状态、整个周期不再重试）。上一轮的修法是把该
 *   字段**恒置 false**（「不猜」），但那只修了一半：签到成功后活动变 `CLAIMED`，
 *   界面于是永远显示未签。现在由 {@link readQoderCampaignDayState} 三态判读给出
 *   ——`claimed` ⇒ true、`claimable` ⇒ false、`unknown`（空列表 / 仅
 *   `VIEW_DETAILS`）⇒ false（仍不猜：那两种含义在响应上无法区分）。
 * - `dailyCredit`：可领活动声明的 `benefit.amount`（实测 100）；没有可领项时
 *   回退到任一 `CLAIM_BENEFIT` 活动的声明值（供 UI 显示「每日 100」）。
 *
 * ## 这个函数的返回值只服务 UI，不参与签到判定
 *
 * `todayCheckedIn` 的唯一消费者是 `credits.status`（面板那一行）。宿主写不写
 * 签到状态走的是 claim 的 outcome（见 {@link claimQoderDailyCheckin}），
 * 与这里无关 —— 故 `unknown` 时如实报「未签」不会造成重复领取（服务端幂等）。
 */
export declare function fetchQoderCheckinStatus(credential: QoderCredential, auth: QoderJobTokenProvider, options?: QoderCreditsOptions): Promise<CheckinStatus | null>;
/**
 * 领取**一个**活动的积分。
 *
 * ## 幂等判据是响应体的 `replayed`，不是 HTTP 状态码
 *
 * 重复领取同样返回 **200**，但 `replayed:true`、**不含 `benefit`**，且
 * `claimedAt` 是**上一次领取的旧时间**（实测请求发生在 09-21、`claimedAt`
 * 却是 09-18）。只看状态码会把「今天已领」误报成「领取成功 +100」——
 * 故 `replayed === true` **归一为 `already-claimed`**。
 *
 * ## 请求体必须是空串
 *
 * 抓包实测 `content-length: 0`；源码里该请求无 payload。发 `{}` 属未经验证的
 * 形态，故照实发空串（`qoderCampaignHeaders` 已带 `Content-Type: application/json`）。
 */
export declare function claimQoderCampaign(credential: QoderCredential, auth: QoderJobTokenProvider, campaignId: string, options?: QoderCreditsOptions): Promise<ClaimOutcome>;
/**
 * 领取该账号**当前所有**可领活动。
 *
 * 一个账号可能同时有多个 `CLAIM_BENEFIT` 活动（实测有每日 100 Credits 与其它
 * 运营活动），故逐个领取而非只领第一个。
 *
 * 汇总为**一条** {@link ClaimOutcome}（与另外四条签到线同构，前端摘要 UI 共用）：
 *
 * - 列表查不到 → `failed`（不是 `already-claimed`：查不到 ≠ 已领）；
 * - **`CLAIM_BENEFIT + CLAIMED` → `already-claimed`**（2026-09-24 补齐，见下）；
 * - **带头仍空 / 仅 `VIEW_DETAILS` → `undetermined`**（2026-09-24 修正，见下）；
 * - 至少一个成功 → `claimed`（`credit` 为累计值）；
 * - 全部失败 → `failed`（带第一条错误原因）。
 *
 * ## ⚠️ 三态判读（判据只有一份，见 {@link readQoderCampaignDayState}）
 *
 * | 响应形态 | 判定 | 依据 |
 * |---|---|---|
 * | `[{CLAIM_BENEFIT, CLAIMABLE}]` | 正常走领取 | 有可领项 ⇒ 未签 |
 * | `[{CLAIM_BENEFIT, CLAIMED}]` | **`already-claimed`** | 服务端明说今天已领 |
 * | `[]`（**带头仍空**） | `undetermined` | 真判不了 |
 * | `[{VIEW_DETAILS, …}]` | `undetermined` | 积分活动信息为零 |
 *
 * ## ⚠️ 为什么 `CLAIMED` 必须单独判（缺陷 2 的正面修复）
 *
 * 真机后果链：签到成功 → 活动变 `CLAIMED` → 旧实现把它与空列表一起压进
 * `undetermined` → 宿主白名单（`src/account-hub-rpc.ts`，只认 `claimed` /
 * `already-claimed`）**不写状态** → 下一轮 sweep 重试 → 又判不了 —— 用户永远
 * 看到「无法判定」，尽管积分已到账（实测落 `addOnQuota` 加量包、三池合计可见、
 * **无结算延迟**）。判 `already-claimed` 才能让白名单写状态、终止这个死循环。
 *
 * ⚠️ 判读**必须同时看 `actionType`**：`VIEW_DETAILS` 型活动的 `CLAIMED` 与积分
 * 签到无关，只按 `claimStatus` 判会把「看了个详情页」写成「今天已签」——
 * 那正是 60f8127 之前「空列表即已签」的同款伪造签到，只是换了个入口。
 *
 * ## ⚠️ 为什么「带头仍空」才归 `undetermined`（旧缺陷的另一半）
 *
 * 旧实现写的是「服务端在『今天已领』时清空 campaigns ⇒ 无目标即已领」，把空列表
 * 归一成 `already-claimed`。真机调查（2026-09-24）确认那条推理**只覆盖了两种
 * 含义里的一种**：空列表同样可能是「活动还没开始 / 本账号暂无活动」，那时它是
 * **未签**。归一成已领会让宿主写下「下一次可签时刻」⇒ 该账号**整个周期内**都
 * 不会再被尝试，用户看到「已签」却一分没领 —— 这就是「qoder 假签到」。
 *
 * 两种含义在响应上无法区分，故改为如实报 `undetermined`：**不写状态** ⇒
 * 下一轮 sweep 自然重试（届时活动若已开始就会真的领到；若确实已领，服务端会回
 * `replayed:true` ⇒ `already-claimed` ⇒ 那时才写状态）。不确定的代价从「永久
 * 少领」降级为「多打一次幂等请求」。
 *
 * ⚠️ **限定语「带头仍空」是 2026-09-24 的定案补正**：缺 `Cosy-ClientType: 10`
 * 时服务端恒回空列表（**缺头假象**，已由 {@link qoderCampaignHeaders} 修掉）。
 * 补头后仍为空，才是真正的「判不了」。
 *
 * ## 为什么不选「already-claimed 也比对积分」那条路
 *
 * 那样会在**同期有对话扣费**时算出假异常（余额被扣费抵消，看起来像「没到账」），
 * 把一个正常的幂等响应报成异常。判据的输入必须是**没有歧义**的，故从源头修判据。
 *
 * ⚠️ **自带活动列表查询**，故宿主 RPC 分支必须传 `precheckStatus: false`，
 * 否则会先多发一次 GET（与 LobsterAI / Trae CN 同约定）。
 */
export declare function claimQoderDailyCheckin(credential: QoderCredential, auth: QoderJobTokenProvider, options?: QoderCreditsOptions): Promise<ClaimOutcome>;
//# sourceMappingURL=qoder-credits.d.ts.map