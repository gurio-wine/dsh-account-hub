/**
 * Buddy 系每日签到（领取积分）客户端。
 *
 * 端点与格式均来自对 WorkBuddy 5.5.6 的逆向 + 真实请求实测（2026-09-14）：
 *
 *   状态查询  POST /v2/billing/meter/checkin-activity-status   body {}
 *   领取      POST /v2/billing/meter/daily-checkin             body {}
 *
 * 两个关键结论（实测）：
 *
 * 1. **必须用 checkin-activity-status，不能用 checkin-status**。后者返回的
 *    是占位数据（active:false、checkin_dates:null、claim_button_text:""），
 *    会让人误判为"活动未开启"。前者才是权威状态源。
 *
 * 2. **不需要 X-Device-Token（图灵盾）**。静态分析曾认为该头是主要门槛，
 *    但实测三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实
 *    领取成功（code:0, credit:100）并可见状态翻转。因此不引入 native SDK。
 *
 * 幂等：重复领取返回 HTTP 400 + code 10001（"今天已签到，请明天再来"）。
 * 判定以响应体 code 为准 —— 不能只看 HTTP 状态。
 */
import type { BuddyCredential } from './buddy.js';
import type { BuddyProduct } from './product.js';
/** 签到状态查询端点（权威状态源）。 */
export declare const CHECKIN_ACTIVITY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
/** 每日签到领取端点。 */
export declare const DAILY_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
/**
 * 积分余额查询端点。
 *
 * **两个产品通用**（2026-09-15 实测）：Buddy CN（腾讯 CodeBuddy 中国版）
 * 与 Buddy（腾讯 WorkBuddy 国际版，www.workbuddy.ai）都实现该端点，
 * 请求头与响应结构完全一致，只有 baseURL 不同（随 `product.endpoint` 切换）。
 *
 * 这与签到能力形成对比 —— **签到**只有中国版有（国际版内核里连
 * `checkin-status` / `daily-checkin` 的字面量都不存在），但**积分余额查询
 * 两边都有**。两者是彼此独立的能力，不要因为"国际版没有签到"就推断
 * 它也查不到余额。
 *
 * 该端点不在 CLI 内核里（内核只硬编码了 `get-dosage-notify` 用量通知），
 * 是 IDE 前端直接调用的，故静态搜索内核找不到，只能用真实凭据实测发现。
 */
export declare const USER_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
/** 签到活动状态（字段名已转为 camelCase）。 */
export interface CheckinStatus {
    /** 活动是否进行中。false 时不应尝试领取 */
    active: boolean;
    /** 今日是否已签到 —— 领取判定的权威依据 */
    todayCheckedIn: boolean;
    /** 连续签到天数 */
    streakDays: number;
    /** 每日可领积分 */
    dailyCredit: number;
    /** 今日已领积分 */
    todayCredit: number;
    /** 今日是否为连续奖励日 */
    isStreakDay: boolean;
    /** 累计已领积分 */
    totalCredits: number;
    /** 已签到日期列表（如 ["2026-09-14"]） */
    checkinDates: string[];
    /** 活动名（如「开学季」） */
    activityName: string;
    /** 主题名（如「Buddy加油站」） */
    themeName: string;
    /** 活动结束时间 */
    endTime: string;
}
/** 一次领取的结果。 */
export type ClaimOutcome = {
    kind: 'claimed';
    credit: number;
    streakDays: number;
    isStreakDay: boolean;
    delayedMessage?: string;
} | {
    kind: 'already-claimed';
    message: string;
} | {
    kind: 'inactive';
    message: string;
}
/**
 * **无法判定**：服务端响应正常，但**不足以判定今天到底领没领**（2026-09-24 新增）。
 *
 * ## 唯一的产生者：Qoder 系「**带头仍空**的活动列表」
 *
 * Qoder 的签到判据是「活动列表里还有没有可领项」（`campaigns[]`）。而
 * **空列表有两种完全相反的含义**，响应上无法区分：
 *
 * | 情形 | 真相 | 正确的后续动作 |
 * |---|---|---|
 * | 今天已经领过了，服务端把列表清空 | 已签 | 无（等明天） |
 * | 活动还没开始 / 本账号暂无活动 | **未签** | 下一轮重试 |
 *
 * 旧实现把两者一律归一成 `already-claimed`（「保守判已领」）—— 那在第二种
 * 情形下**伪造了一次签到**：宿主据此写下「下一次可签时刻」，该账号在**整个
 * 周期内**都不会再被尝试，而它其实一分钱都没领到（真机调查确认这就是
 * 「qoder 假签到」的形态）。反方向的误判（把已领报成未领）代价小得多 ——
 * 只是多打一次幂等请求。故正确取舍是**不猜**。
 *
 * ⚠️ **「带头」是 2026-09-24 的定案补正**：活动端点缺 `Cosy-ClientType: 10`
 * 时服务端**恒回空列表**（那是缺头假象，不是服务端事实），该缺陷已在请求层修掉
 * （`src/qoder-product.ts` 的 `qoderCampaignHeaders`）。故本 kind 现在的含义
 * 收窄为「**头齐了、服务端真的没给条目**」—— 措辞里不要省掉那个限定语。
 * 同理，「服务端明说 `CLAIM_BENEFIT + CLAIMED`」是**已领的确证**（不归本 kind）。
 *
 * ## 与其余 kind 的边界
 *
 * - 与 `already-claimed`：那个是**服务端明确说已领**（Qoder 的 `replayed:true`
 *   与 `CLAIM_BENEFIT/CLAIMED`、Buddy 的 `10001`、Trae CN 的 `9095`）。
 *   本 kind 是「服务端什么都没说」。
 * - 与 `failed`：没有失败可报（HTTP 200、信封合法、没有错误码），用户也**无
 *   事可做**。归 failed 会让用户去排查凭据，而凭据是好的。
 * - 与 `inactive`：`inactive` 是「活动未开启」这个**服务端明说的持续状态」。
 *   本 kind 连这件事都不确定。
 *
 * ## 语义约束（宿主侧必须遵守）
 *
 * **绝不写签到状态**（与 `failed` / `inactive` / `unavailable` / `abnormal`
 * 同待遇）——见 `src/account-hub-rpc.ts` 的 `performCheckinOnTargets`：它只对
 * `claimed` / `already-claimed` 写状态的白名单，故本 kind 天然不命中。
 * 不写 ⇒ 下一轮 sweep 自然重试，**这正是本 kind 存在的全部意义**：把「不知道」
 * 如实说成「不知道」，让重试去把它变成已知。
 *
 * ## UI
 *
 * 面板显示「无法判定」而不是「已签」（`src/qoder-credits.ts` 的
 * `fetchQoderCheckinStatus` 也不再把空列表映射成 `todayCheckedIn: true`；
 * 2026-09-24 起该字段只在服务端明说 `CLAIM_BENEFIT/CLAIMED` 时为 true）。
 */
 | {
    kind: 'undetermined';
    /** 为什么判不了（如「活动列表为空，无法区分『今天已领』与『暂无活动』」）。 */
    message: string;
}
/**
 * **签到异常**：服务端说成功了，但积分余额**没有变多**（2026-09-24 新增）。
 *
 * ## 为什么需要它（它回答的是一个 claimed 答不了的问题）
 *
 * 五家签到协议里有三家的 claim 响应**根本不含积分数**（Trae CN 的完整响应就是
 * `{"code":0,"message":"success"}`，见 `src/trae-cn-credits.ts` 的 T8 记录），
 * 其余几家的「成功」判定也都是**响应码**。响应码只证明「服务端受理了这次请求」，
 * 不证明「积分真的到账」—— 活动结束、账号资格变更、后端结算失败都可能让一次
 * `code:0` 不产生任何额度变化，而用户看到的是「领取成功 +0」，什么也查不了。
 *
 * 判据因此是**签到前后各取一次余额**（同一个账号、同一个端点、同一口径）：
 * claim 被判成功但**后 ≤ 前** ⇒ 归本 kind。`totalCredit` 不计入本次所得
 * （它没有发生），但 `claimed` 那一栏也**不能**算它 —— 那正是本 kind 存在的意义。
 *
 * ## 与其余四个 kind 的边界（逐条都不是重复）
 *
 * - 与 `claimed`：`claimed` 是「响应成功**且**余额确实涨了（或该 provider 豁免
 *   比对）」。本 kind 是「响应成功但账没动」。
 * - 与 `failed`：`failed` 是**需要用户做点什么**（重登 / 校准）。本 kind 的正确
 *   动作是**什么都不做，等下一次自动重试** —— 与 `unavailable` 同款。若后端只是
 *   延迟入账，下一次 sweep 的 `already-claimed` 会把它自然收敛掉。
 * - 与 `unavailable`：那个是**服务端明确拒绝**（Trae CN 的 9074，带 code/logid）。
 *   本 kind 恰恰相反：服务端**没有任何错误**，是「说了成功却没效果」。
 * - 与 `inactive`：`inactive` 是活动层面的**持续**状态（服务端自己说未开启）。
 *
 * ## 语义约束（宿主侧必须遵守）
 *
 * **绝不写签到状态**（与 `failed` / `inactive` / `unavailable` 同待遇）——见
 * `src/account-hub-rpc.ts` 的 `performCheckinOnTargets`：它只对 `claimed` /
 * `already-claimed` 写状态的白名单，故本 kind 天然不命中。写成「已签」会让这次
 * 异常**当天再也不被重试**，等于把「可能只是延迟入账」固化成永久失败。
 *
 * ## 判据的边界（两处「拿不准就放行」）
 *
 * 1. **任一次余额查询拿不到**（网络失败 / 凭据异常 / 非积分账户）→ **跳过比对、
 *    按原判定报 `claimed`**。余额查询故障绝不能把一次真实成功判成异常 ——
 *    那会让用户去追一个不存在的问题，而且下一次 sweep 还得再签一遍。
 * 2. **登记为不参与比对的 provider**（见 `src/checkin-schedule.ts` 的
 *    `BALANCE_COMPARISON_EXEMPT_PROVIDERS`）→ 同样直接 `claimed`。前提
 *    「奖励会立刻体现在这个余额数字上」不成立的 provider 不该被比对。
 */
 | {
    kind: 'abnormal';
    /**
     * 签到**前**读到的余额；`undefined` = 该次查询没拿到（此时不会产生本 kind）。
     *
     * 带上前后两个数字是刻意的：UI 要能显示「签到前 100 → 签到后 100」，
     * 否则用户只看到一句「积分未变」而无从判断是没发还是发少了。
     */
    balanceBefore: number;
    /** 签到**后**读到的余额（`code:0` 已确认，但账没动）。 */
    balanceAfter: number;
    /** 固定文案（服务端没有错误可转述，本 kind 的全部信息都在两个数字里）。 */
    message: string;
}
/**
 * 服务端**此刻暂不受理**这次领取（设备号被拉黑 / 名额类拒绝），稍后自动重试。
 *
 * ## 为什么既不是 `failed` 也不是 `inactive`
 *
 * - 与 `failed` 的区别：`failed` 是**需要用户做点什么**的失败（凭据失效要重新
 *   登录、设备头不对要校准），用户看到它应当去排查；而 `unavailable` 的正确
 *   动作是**什么都不做，等下一次自动重试** —— 报成 failed 会让用户以为插件坏了。
 * - 与 `inactive` 的区别：`inactive` 是**活动层面的持续状态**（服务端说活动
 *   未开启），重试也不会变；`unavailable` 是**服务端侧的拒绝**，同一个请求
 *   换个时刻（或多试一次）就可能成功。两者对「要不要重试」的回答正好相反。
 *
 * ## 唯一的产生者：Trae CN 的 `9074`（换号重试之后仍被拒）
 *
 * 真机单变量矩阵（2026-09-23 **第五次定案**）：账号未签 + 设备号**被拉黑**
 * → `9074`（「当前参与用户太多，请稍后再试」）。⚠️ 前四次定性（瞬时频次软限流
 * / 活动级名额 / 设备身份 / 名额风控）**均已作废**，现行定性是**该设备号在
 * 未产出奖励的 claim 中出现过、被服务端拉黑** —— 故签到侧**先换一个全新 16 位
 * 号重试一次**（`src/trae-cn-credits.ts` 的 `rotateTraeCnCheckinDeviceId`），
 * **只有换了号仍被拒**才落到本 kind。
 *
 * ⚠️ **新增产生者时要顺带改聚合点**：`src/qoder-credits.ts` 的
 * `claimQoderDailyCheckin` 会把多个活动的结果**收敛成一条** outcome，而它只
 * 识别 `claimed` / `failed` / 兜底 `already-claimed`。若将来 Qoder 也开始产出
 * `unavailable`，那条兜底会把它误归成 `already-claimed` —— 界面显示「今天已领」，
 * 而宿主会写今日状态 ⇒ 当天再也不会重试。故**先改聚合再看新产生者**。
 *
 * ## 语义约束（宿主侧必须遵守）
 *
 * **绝不写 `checkins` 状态**（与 `failed` / `inactive` 同待遇）—— 一旦按
 * 「今天办过了」记下今日，4 小时的 sweep 就会短路跳过这个账号，当天再也不会
 * 重试，等于把一次拒绝变成一个永久失败。判据见 `account-hub-rpc.ts` 的
 * `performCheckinOnTargets`（它只对 `claimed` / `already-claimed` 写状态，
 * 故本 kind 天然不命中；`tests/unit/checkin-rpc.spec.ts` 有用例钉死）。
 */
 | {
    kind: 'unavailable';
    /**
     * 服务端业务码（Trae CN 的 `9074`）。
     *
     * 与 `failed` 同款带上：用户与日志都需要它才能把这次拒绝对回服务端语义。
     */
    code: number;
    message: string;
    /**
     * 服务端日志追踪号（**可选**，同 `failed` 分支：只有服务端在响应头里给了才有）。
     *
     * `9074` 恰恰是最需要服务端日志的场景 —— 客户端看不到名额池的状态，只有
     * logid 能让服务端查到这一次请求撞在了什么上面。
     */
    logid?: string;
} | {
    kind: 'failed';
    code: number;
    message: string;
    /**
     * 服务端日志追踪号（**可选**，只有服务端在响应头里给了才有）。
     *
     * 三套协议共用这个判别联合，故字段必须是可选的：Buddy 系与 LobsterAI 的
     * 响应里没有已知的等价头，加了也不会填，其它协议的 outcome 逐字段不变。
     *
     * 唯一的生产者是 Trae CN：它读响应头 `x-tt-logid`（字节系网关的 logid，
     * 真机样本 `20260919142909176141A5DE791F4FE75E`）。**这是定位服务端日志的
     * 唯一线索** —— `code` 与 `message` 只说「失败了、为什么」，logid 才能让
     * 服务端查到这一次请求到底发生了什么。前端失败行会把它一并显示出来。
     */
    logid?: string;
};
/**
 * 积分资源包（`get-user-resource` 响应里 `Accounts[]` 的一项）。
 *
 * ## 一个账号为什么有多个包
 *
 * 每个包是**一份独立的积分授予**（套餐 + 若干运营活动赠包），各自有独立的
 * 计量周期与到期时间。实测某 Buddy CN 账号有 5 个包：1 个体验版套餐 +
 * 4 份「国内运营裂变包」，其中 2 份已过期、1 份本周期已耗尽、2 份可用。
 * 所以界面上「5 个资源包」不等于 5 份额度，需要区分有效与失效。
 *
 * ## 两个 "Remain" 字段的口径差异（关键）
 *
 * 响应里同时有两个剩余值，**含义完全不同**：
 *
 * | 字段                     | 含义                     | 实测（体验版包） |
 * |--------------------------|--------------------------|------------------|
 * | `CapacityRemain`         | 该包的**终身**剩余       | 500              |
 * | `CycleCapacityRemain`    | 该包**本计费周期**剩余   | 0                |
 *
 * IDE 顶部的 "Credits Balance" 用的是**周期口径**（`CycleCapacityRemain`）：
 * 实测该账号终身口径求和为 655.67，而 IDE 显示 155.67 —— 差额 500 正是那个
 * 「终身还剩 500、但本周期已一分不剩」的体验版包。用错字段会让数字凭空多出
 * 一大截，且用户无从核对。
 */
export interface CreditPackage {
    /** 包名（如 'Bonus Pack' / 'CodeBuddy个人体验版'） */
    name: string;
    /** 额度单位（'credit' / 'credits'） */
    unit: string;
    /** 本计费周期剩余额度（IDE 展示口径，精确值含小数） */
    remaining: number;
    /** 本计费周期总额度（精确值） */
    total: number;
    /** 本计费周期已用额度（精确值） */
    used: number;
    /**
     * 该包是否仍然有效。
     *
     * 判定：服务端 `Status !== 3`（实测 3 = 已过期）且未过 `ExpiredTime`。
     * 失效包仍会出现在 `Accounts[]` 里（额度可能非 0），UI 需要能区分出来，
     * 否则用户会以为那些额度还能用。
     */
    active: boolean;
    /** 计量周期开始时间（服务端本地时间字符串，可能为空） */
    cycleStartTime: string;
    /** 计量周期结束时间（服务端本地时间字符串，可能为空） */
    cycleEndTime: string;
    /** 该包自身的失效时间（可能为空 = 无固定失效时间） */
    expiredTime: string;
}
/** 账号的积分余额汇总。 */
export interface CreditBalance {
    /**
     * 当前可用总余额（各**有效**包的本周期剩余之和）。
     *
     * 这个口径与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
     *
     * 刻意不用服务端的 `TotalDosage`：它是**终身口径**且取整（实测同一响应里
     * TotalDosage=655 而 IDE 显示 155.67），既口径不对又有截断误差。
     */
    total: number;
    /** 各资源包明细（含已失效的，由 `active` 区分） */
    packages: CreditPackage[];
    /**
     * 已失效包里的剩余额度合计。
     *
     * 单独给出而不是并进 `total`：这些额度服务端仍会返回，但实际不可用于扣费。
     * UI 可以据此提示「另有 N 已失效」，既不误导也不丢信息。
     */
    expiredTotal: number;
}
/**
 * 查询签到活动状态。
 * 使用 checkin-activity-status（权威源，非 checkin-status）。
 * 网络失败、响应非法或业务码非 0 时返回 null。
 */
export declare function fetchCheckinStatus(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CheckinStatus | null>;
/**
 * 执行每日签到领取。
 *
 * 判定顺序：先看业务码是否属于「已领取 / 无资格 / 活动结束」这些非致命类别，
 * 再看是否成功，最后归为 failed。判定以响应体 code 为准（重复领取是 HTTP 400，
 * 只看状态码会把幂等情况误报为失败）。
 */
export declare function claimDailyCheckin(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 查询账号的积分余额（剩余 credits）。
 *
 * 两个产品通用（见 {@link USER_RESOURCE_PATH} 的说明）。网络失败、响应非法或
 * 业务码非 0 时返回 null —— 与 {@link fetchCheckinStatus} 同款语义，让调用方
 * 能把「查不到」与「余额为 0」区分开，不要把网络故障显示成 0 积分。
 *
 * 注意 `data` 是**双层嵌套**：`data.Response.Data.Accounts[]`。这与签到端点的
 * 单层 `data` 结构不同，是本接口最容易解析错的地方。
 */
export declare function fetchCreditBalance(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/** 一次余额探测的结果：`total` 为 `undefined` 表示**这次没拿到**（不是「余额为 0」）。 */
export interface BalanceProbe {
    /** 可用总余额（`CreditBalance.total` 口径）；查不到时 `undefined`。 */
    total: number | undefined;
}
/**
 * 一次签到前后余额比对的裁决。
 *
 * 三态而不是布尔，是因为「拿到两个数字且没变多」与「有一个数字没拿到」必须走
 * **相反**的处置：前者判 `abnormal`，后者**放行**（按原判定报成功）。
 * 用布尔会把两者压成同一个 `false`，而调用方再也分不出该报异常还是该放行。
 */
export type BalanceComparisonVerdict = 
/** 余额确实变多了 → 成功属实。 */
{
    kind: 'increased';
    before: number;
    after: number;
}
/** 两次数值都拿到了，但**没有变多** → 签到异常。 */
 | {
    kind: 'unchanged';
    before: number;
    after: number;
}
/** 任一侧没拿到 → **跳过比对**，按调用方原本的判定走。 */
 | {
    kind: 'skipped';
    reason: string;
};
/**
 * 比对签到前后的余额，判「这次成功是不是真的到账了」。
 *
 * 纯函数（不触网、不读时钟），故可在单测里直接喂数字把三态钉死 —— 五家 provider
 * 的接线都走这一个函数，逐家写一遍必然在某个边界上漂移。
 *
 * ## 判据是「没有变多」而不是「没有变化」
 *
 * 用 `after <= before` 而不是 `after === before`：签到的同时可能正好有一笔扣费
 * 结算（对话消耗），余额完全可能**变少**。那种情况下更不该报「成功」—— 用户看到
 * 的是一笔没到账还倒扣的账。反之，只要 `after > before` 就判成功：中间夹杂扣费
 * 时这个判据偏宽松（真实增量可能小于差额），但**宁松勿严** —— 报假异常会让用户
 * 去追一个不存在的问题，而漏报只是退回改动前的行为。
 *
 * ## 豁免与探针缺失
 *
 * `exempt` 为真时直接 `skipped`：调用方已按
 * `BALANCE_COMPARISON_EXEMPT_PROVIDERS` 判过，这里再判一次是为了让「跳过」这件事
 * 在同一处可读（否则纯函数的三态里会缺一态）。
 *
 * ⚠️ **浮点噪声不需要特殊处理**：`fetchCreditBalance` 已经 `roundCredits` 到两位
 * 小数（见 {@link roundCredits}），两次取值的尾数噪声在同一个量级上，`>` 比较足够。
 * 刻意不加「差小于 0.01 算没变」的容差 —— 那会让「奖励 0.005 积分」这种不存在的
 * 情形变成一条需要维护的规则，而真实奖励都是整数或两位小数。
 *
 * @param before - 签到前的余额探测。
 * @param after - 签到后的余额探测。
 * @param exempt - 该 provider 是否登记为不参与比对。
 */
export declare function compareBalanceAroundClaim(before: BalanceProbe, after: BalanceProbe, exempt: boolean): BalanceComparisonVerdict;
/**
 * 「签到异常」的固定文案（`abnormal` outcome 的 `message`）。
 *
 * 服务端**没有**错误可转述（这正是本 kind 的处境：它说成功了），故文案由我们写死，
 * 完整信息在那两个数字里（`balanceBefore` / `balanceAfter`，前端另行拼接）。
 *
 * ⚠️ 文案里刻意**不写「失败」**：它不是失败（服务端 code:0），用户也不需要做任何
 * 事 —— 下一次 sweep 会自动重试。写「失败」会让用户去排查凭据，而凭据是好的。
 */
export declare const CHECKIN_ABNORMAL_MESSAGE = "\u7B7E\u5230\u54CD\u5E94\u6210\u529F\u4F46\u79EF\u5206\u672A\u589E\u52A0\uFF0C\u89C6\u4E3A\u672A\u7B7E\u5230";
//# sourceMappingURL=credits.d.ts.map