/**
 * 签到**周期**模型：把「今天签过没」换成「下一次可签是什么时刻」。
 *
 * ## 为什么不再用「本地纪元日数」
 *
 * 旧模型（`checkins` 存 dayNumber，判定 `日数 === 今天日数`）隐含一个假设：
 * **所有 provider 都在本地零点重置**。该假设对 `qoder-cn` 不成立 ——
 * 实测它的签到窗口在**本地 10:00** 才翻页（真机观测，见
 * {@link CHECKIN_RESET_HOURS}）。用日数表达时，这个 provider 在 00:00–10:00
 * 之间会被判成「今天还没签」而反复请求（服务端仍回 already-claimed），
 * 10:00 之后又会被判成「今天签过了」而**整天不再尝试**（哪怕上一签是昨天
 * 9:59 完成的、此刻其实已经可签）。
 *
 * 新模型只存**一个毫秒时间戳**：`checkins[provider:accountId]` = 下一次可签时刻。
 * 判定退化成一次比较，**不需要知道「今天是几号」**：
 *
 * - 有记录且 `Date.now() < 记录值` → 已签（等窗口翻页）
 * - 有记录且 `Date.now() >= 记录值` → 可签（上一周期的窗口已经翻过）
 * - 无记录 → 可签（从未签过）
 *
 * 时区口径仍然是**本地时区**（用户在中国，qoder-cn 的 10 点就是本地 10 点），
 * 与旧模型一致。
 *
 * ## 本模块是「周期」这件事的唯一真相源
 *
 * 重置钟点、周期边界换算、旧值迁移、余额比对豁免表都收在这里，`account-pool` /
 * `account-hub-storage` / `account-hub-rpc` 只调用不重写 —— 三处各写一份「下一天
 * 几点」的算术，迟早会在某个 DST 边界或某个 provider 上漂移。
 *
 * @module dsh-account-hub/checkin-schedule
 */

/**
 * **逐 provider 的签到重置钟点**（本地时区，24 小时制整点）。
 *
 * ## 为什么必须按 provider 配，而不是一处全局常量
 *
 * 签到窗口由**各家活动系统**决定，不是我们定的。目前已观测到两种：
 *
 * | provider | 重置钟点 | 依据 |
 * |---|---|---|
 * | `qoder-cn` | **10** | 文档口径「每日 10:00 (UTC+8) 刷新」+ 真机观测（用户 2026-09-24 确认） |
 * | 其余（`buddy-cn` / `lobsterai` / `trae-cn` / `codearts`） | **0** | 用户观测「其它目前看来都还是 0 点」 |
 *
 * ## ⚠️ 时区等价性：本地钟点 **只在 UTC+8 的机器上与文档口径一致**
 *
 * 上表的数字是**本地时区**的钟点（本模块的全部换算都走 `new Date(y,m,d,h)` 的本地
 * 构造），而 Qoder 的文档口径写的是 **`UTC+8`**。两者只在「运行本插件的机器其
 * 本地时区恰好是 UTC+8」时逐刻等价 —— 用户在中国，这是当前的实际情形，故实现取
 * 本地口径（与旧模型「时区口径只在一处收敛」一致，也不引入新的时区依赖）。
 *
 * **换一台时区不同的机器会偏移**：本地时区为 UTC+9 时，`10` 表示该机器本地
 * 10:00，即 UTC 01:00，而活动实际在 UTC 02:00 翻页 ⇒ 判「可签」会比真实窗口早
 * 一小时，那一发会拿到「列表为空 ⇒ `undetermined`」（不写状态、下轮重试），
 * 即**偏早只会多打一次幂等请求，不会少领**。偏晚（本地时区 < UTC+8）则会晚一小时
 * 才尝试，同样不会漏掉当天的窗口。
 *
 * 若将来要彻底对齐文档口径，改法是把本表换成「UTC 偏移 + 钟点」的二元组并在
 * {@link localResetInstant} 里换算 —— 那是一次**显式**的口径变更，涉及全部
 * provider 的既有数据迁移，不要在没确认用户时区的前提下顺手做。
 *
 * ## ⚠️ `qoder`（国际版）刻意单列一行 0，不要与 `qoder-cn` 合并
 *
 * 两区是**同协议、两套 host、两批账号**（见 `src/qoder-product.ts`），
 * 但「活动窗口几点翻页」是**活动系统**的属性，不是协议属性 —— 没有任何证据表明
 * 两区共享同一个翻页时刻。目前只观测到 CN 是 10 点；国际版的观测仍然是用户那句
 * 「其它都还是 0 点」。若将来在国际版上观察到同样是 10 点，改**这一行**即可
 * （`qoder: 10`），不要顺手把它并进 `qoder-cn` 的条目里 —— 那等于替国际版
 * 假定了一个没人观测过的窗口。
 *
 * ## 缺省即 0
 *
 * 不在表里的 provider 一律按 0 点处理（{@link checkinResetHour}）。这是**刻意**
 * 的缺省：新增 provider 若忘了登记，行为等于旧模型的「按自然日重置」，不会
 * 因为查不到配置而拒绝签到或算出 NaN。
 */
export const CHECKIN_RESET_HOURS: Readonly<Record<string, number>> = {
  'qoder-cn': 10,
  // 显式列出 0 点的四家：让「已确认是 0 点」与「尚未登记」在表里可区分
  // （前者是观测结论，后者是缺省值）。
  'buddy-cn': 0,
  lobsterai: 0,
  'trae-cn': 0,
  codearts: 0,
  // ⚠️ 未观测项，暂按 0（见模块头表格下方的说明）。
  qoder: 0,
}

/**
 * 该 provider 的签到重置钟点（本地时区整点）。
 *
 * @param provider - provider id。
 * @returns 0–23 的整点；未登记时 **0**（见 {@link CHECKIN_RESET_HOURS} 的缺省说明）。
 */
export function checkinResetHour(provider: string): number {
  const hour = CHECKIN_RESET_HOURS[provider]
  // 防御：配置表被外部改坏（非整数 / 越界）时回落 0，而不是算出一个跨日的怪时刻。
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return 0
  return hour
}

/**
 * 时刻 `at` 所在**本地日**的重置点（本地时区 `hour:00:00.000` 那一刻的毫秒时间戳）。
 *
 * 用 `new Date(y, m, d, hour)` 构造而**不是**「日初时间戳 + hour * 3600_000」：
 * 后者在夏令时切换日会偏一小时（那一天本地 10 点与日初的间隔不是 10 小时）。
 * 本地构造让运行时的时区数据库去处理 DST —— 与旧模型「时区口径只在一处收敛」
 * 的取舍一致。
 *
 * @param at - 参照时刻（毫秒时间戳）。
 * @param hour - 本地整点。
 */
export function localResetInstant(at: number, hour: number): number {
  const date = new Date(at)
  return new Date(
    date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0,
  ).getTime()
}

/**
 * 本地日偏移 `days` 天的重置点（`days` 可为负）。
 *
 * 同样走 `new Date(y, m, d + days, hour)`（月份/年份溢出由 Date 自身规整），
 * 故跨月、跨年、跨 DST 都正确。
 */
function shiftedResetInstant(at: number, hour: number, days: number): number {
  const date = new Date(at)
  return new Date(
    date.getFullYear(), date.getMonth(), date.getDate() + days, hour, 0, 0, 0,
  ).getTime()
}

/**
 * **签到成功后应记录的「下一次可签时刻」**。
 *
 * 语义（用户 2026-09-24 拍板，逐条对应测试）：
 *
 * - 签到时刻 **≥ 当日重置点** → 这次属于**本周期**，下次可签 = **明日**重置点；
 * - 签到时刻 **< 当日重置点** → 这次属于**上一周期**（本周期还没开始），
 *   下次可签 = **当日**重置点。
 *
 * 第二条是有意为之的边界语义（以 qoder-cn 为例）：9 月 24 日 09:00 签到成功，
 * 此刻 24 日的 10:00 窗口尚未开始 —— 这一签实际消耗的是 23 日 10:00 那个周期的
 * 份额，故 24 日 10:00 一到就**应该**可以再签，而不是等到 25 日 10:00。
 * 结算成「下次 = 25 日 10:00」会让用户白丢一天的窗口。
 *
 * @param claimedAt - 签到成功的时刻（毫秒时间戳）。
 * @param provider - provider id（决定重置钟点）。
 * @returns 下一次可签时刻（毫秒时间戳，**严格大于** `claimedAt`）。
 */
export function nextEligibleAt(claimedAt: number, provider: string): number {
  const hour = checkinResetHour(provider)
  const resetToday = localResetInstant(claimedAt, hour)
  return claimedAt < resetToday ? resetToday : shiftedResetInstant(claimedAt, hour, 1)
}

/**
 * 该账号**此刻是否可签**（`checkins` 里那个值是否已经过期）。
 *
 * 无记录（`undefined` / 脏值）一律可签 —— 与旧模型「读不到即未签」同款。
 *
 * @param recorded - `checkins` 里记录的下一次可签时刻；缺省/脏值 = 从未签过。
 * @param now - 判定时刻，缺省当前时间（便于测试注入）。
 */
export function isCheckinDue(recorded: number | undefined, now: number = Date.now()): boolean {
  if (recorded === undefined || !Number.isFinite(recorded)) return true
  return now >= recorded
}

/**
 * 旧 dayNumber 值的上界：**小于它就认为是旧口径的天数，而不是毫秒时间戳**。
 *
 * 两个口径差着约 7 个数量级，边界可以取得很宽：
 * - 旧日数：2026-09 约 `20700`；即使到 2243 年也只有 6 位数；
 * - 新时间戳：2026-09 约 `1.79e12`（13 位）、2001 年也有 `1e12`。
 *
 * 取 10 万（`1e5`）：任何**合理的**日数都落在下面，而任何**合理的**毫秒时间戳
 * 都落在上面。刻意不用「位数」判断 —— 秒级时间戳（`1.79e9`）是 10 位数、
 * 与日数区间只差 4 个数量级，用位数会把它误判成一种「未来的日数」。
 */
export const LEGACY_DAY_NUMBER_MAX = 100_000

/**
 * 把旧口径的签到值迁移成新口径（{@link CheckinsMap} 的毫秒时间戳）。
 *
 * ## 旧语义 → 新语义的换算
 *
 * 旧值 `d` 的含义是「**第 d 天签过了**」，判定 `d === 今天日数` 即已签；
 * 日数在本地零点翻页。故它表达的「下一次可签」就是**第 d+1 天的重置点**
 * —— 注意不是 `d` 那天的重置点：旧模型里签到当天的余下时间一律算「已签」，
 * 若迁移成「d 当天的重置点」，一台在 9 月 24 日签过的机器升级后会立刻被判定
 * 为「可签」（因为 24 日 0 点已过），当天重复签一次。
 *
 * 对重置钟点为 0 的 provider，结果就是 `d+1` 天本地零点 —— 与旧行为逐刻一致。
 * 对 `qoder-cn`（10 点）则向**后**取到 `d+1` 天的 10 点：旧模型在这里本来就
 * 判断得不对（它按 0 点翻页），迁移取保守方向（宁可少签一次，不可多打一次
 * 注定 already-claimed 的请求）。
 *
 * 若 `d+1` 的重置点已成为过去（正常：升级时旧值多为「昨天」或更早），结果是
 * 一个过去的时间戳 —— {@link isCheckinDue} 会判它可签，这正是从旧数据恢复后的
 * 正确状态（今天还没签过）。
 *
 * @param dayNumber - 旧口径的本地纪元日数。
 * @param provider - provider id（决定重置钟点）。
 */
export function migrateLegacyCheckinDay(dayNumber: number, provider: string): number {
  // 由日数反推「那一天」的本地时刻：日数是 `Date.UTC(y,m,d)/86400000`（见
  // `src/account-pool.ts` 旧实现），故乘回来即那天的 UTC 零点；取它的本地
  // 年月日即为当天（UTC 零点落在哪个本地日 = 该日数的本地日，两侧定义同源）。
  const dayStart = new Date(dayNumber * 86_400_000)
  return shiftedResetInstant(dayStart.getTime(), checkinResetHour(provider), 1)
}

/**
 * 把 `checkins` 里的一个原始值归一到新口径；非数字 / 非有限值 / 负值一律丢弃。
 *
 * **双口径读入**是刻意的（sanitize 兼容旧值，见任务约束）：存储文件可能是
 * 旧版本写下的日数，也可能是新版本写下的时间戳，读的时候按
 * {@link LEGACY_DAY_NUMBER_MAX} 分流，写回时一律是新口径。
 *
 * @param raw - 存储里的原始值。
 * @param provider - 该键的 provider（决定迁移后的钟点）。
 * @returns 新口径时间戳；不可用时 `undefined`（调用方丢弃该键，不抛错）。
 */
export function normalizeCheckinValue(raw: unknown, provider: string): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    return undefined
  }
  return raw < LEGACY_DAY_NUMBER_MAX ? migrateLegacyCheckinDay(raw, provider) : raw
}

/**
 * **不参与「签到前后余额比对」的 provider**（登记表，不是开关）。
 *
 * ## 为什么需要一张豁免表
 *
 * 比对本身极便宜（复用 `credits.balances` 的同一个端点），但它有一条**前提**：
 * 「签到奖励会立刻体现在这个余额数字上」。前提不成立时，比对会把一次**真实
 * 成功**报成异常，那比不比对坏得多。故不满足前提的 provider 要显式登记在这里，
 * 而不是各自在接线处写一个 if。
 *
 * ## 当前登记项：`codearts`
 *
 * 理由（**登记，不是结论**）：CodeArts 的余额来自 `statistics/plugin` 的
 * `metrics[]` 统计口径（见 `src/codearts-credits.ts`），而它是**用量统计**接口
 * —— 签到发的积分何时反映到该统计里**没有真机证据**（仓库里既没有「领完立刻
 * 可见」的观测，也没有「有结算延迟」的观测）。比对要求前后两次取值同源可比，
 * 这一条在 CodeArts 上无法证实，故按「拿不准就跳过」处理。
 *
 * ⚠️ **解除豁免的唯一条件是真机证据**：先手动签一次，立刻查两次余额
 * （`credits.balances` 前后各一次）并确认数字确实增加了，再把 `codearts`
 * 从本集合删掉，并在 `docs/agents/providers-codearts.md` 记下观测。
 * 在此之前不要因为「看起来应该会加」而放开它。
 *
 * 其余六家（含余额口径同为「积分包」的 buddy 系 / lobsterai / trae-cn / qoder
 * 两区）都参与比对：它们的签到奖励与余额出自**同一个积分口径**。
 */
export const BALANCE_COMPARISON_EXEMPT_PROVIDERS: ReadonlySet<string> = new Set([
  'codearts',
])

/**
 * 该 provider 的签到是否参与「前后余额比对」。
 *
 * @param provider - provider id。
 */
export function comparesBalanceAroundClaim(provider: string): boolean {
  return !BALANCE_COMPARISON_EXEMPT_PROVIDERS.has(provider)
}
