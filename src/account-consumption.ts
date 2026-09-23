/**
 * 「账号消耗顺序 + 切换粒度」——**本功能的唯一真相源**（纯逻辑，无 ctx / 无 IO）。
 *
 * ## 两个配置项
 *
 * | 选择器 | 档位 | 语义 |
 * |---|---|---|
 * | 消耗顺序 | `sequential` | 永远取当前排序第一个可用账号 |
 * | | `round-robin`（默认） | 每次按账号顺序轮转下一个（a→b→c→a），游标持久化 |
 * | | `highest-balance` | 每次取可用账号里积分余额最高的 |
 * | 切换粒度 | `per-request` | 每次请求都按消耗顺序重新选号 |
 * | | `per-turn`（默认） | 一轮对话（同一会话）内锁定同一账号，新轮次才重选 |
 *
 * ## 为什么把「轮次」实现成「会话内的请求集合」而不是「一个 turn id」
 *
 * DSH 的 `llm/stream` 瀑布流只透传 `GenerateOptions`，其中**没有任何 turn 级标识**
 * （只有 `sessionId`，见本仓 README 的接线说明）。而 adapter 每次请求能拿到、且
 * **同一轮内恒定、跨轮必然变化**的东西只有 `options.signal` 的身份：
 * `agent-loop` 每开一个 **turn** 换一次 `AbortController`（`agent.ts` 的 `turn()`
 * 末尾 `phase.abort = new AbortController()`），而同轮内的多个 step（工具调用循环）
 * 共用同一个 signal。故「轮次」= 该 signal 首次出现到消失之间的请求集合，
 * 这恰好就是用户理解的「一轮对话」。
 *
 * 因此 {@link TurnAccountLock} 以**调用方给的任意轮次键**为键，宿主侧用
 * 「signal 的 WeakMap 身份 → 稳定 key」把它换算成一个字符串（见 `src/index.ts`
 * 的 `makeTurnKey`）。无 signal（headless / 单测 / 一次性调用）时调用方给空串，
 * 此时**不锁**（每次请求独立选号）—— 那正是 `per-request` 的行为，也是
 * auth 单发路径（拉目录）需要的语义。
 *
 * @module dsh-account-hub/account-consumption
 */

/** 消耗顺序档位。字面量本身是**持久化值**，改名等于让用户配置失效。 */
export type ConsumptionOrder = 'sequential' | 'round-robin' | 'highest-balance'

/** 切换粒度档位（同上：字面量即持久化值）。 */
export type ConsumptionSwitch = 'per-request' | 'per-turn'

/** 单个 provider 的消耗配置。 */
export interface ConsumptionSetting {
  order: ConsumptionOrder
  switch: ConsumptionSwitch
}

/** 全部 provider 的消耗配置：provider id → 该 provider 的设置。 */
export type ConsumptionMap = Record<string, ConsumptionSetting>

/**
 * 遍历模式的**下一个该用的账号**：provider id → accountId。
 *
 * 存的是「下一个」而不是「上一个」：选号时无需回头找，直接把它提到候选首位即可；
 * 账号被删除 / 停用后找不到该 id，{@link rotateToCursor} 自然回落数组顺序（自愈）。
 */
export type ConsumptionCursorMap = Record<string, string>

/** 三档消耗顺序（顺序即界面上的呈现顺序）。 */
export const CONSUMPTION_ORDERS: readonly ConsumptionOrder[] = Object.freeze([
  'sequential',
  'round-robin',
  'highest-balance',
] as const)

/** 两档切换粒度（顺序即界面上的呈现顺序）。 */
export const CONSUMPTION_SWITCHES: readonly ConsumptionSwitch[] = Object.freeze([
  'per-request',
  'per-turn',
] as const)

/**
 * 默认配置。
 *
 * - `round-robin` = **用户拍板的默认档**：多个账号的积分被均匀消耗，而不是
 *   永远压在排序第一个账号上（`sequential` 因此降级为**普通档位**，只在用户
 *   显式选择时生效）。
 *
 *   ⚠️ **这是相对上一版的行为变化**：本档位是 `fdae868` 随三档一起落地的，
 *   当时的默认是 `sequential`（等价于改动前的历史行为）。改成遍历后，
 *   **从没动过配置的存量用户**重启即从「固定用第一个账号」变为「逐请求轮转」。
 *   这正是用户要求的默认，故**不做任何数据迁移**：旧文档里没有 `consumption`
 *   条目（或条目等于新默认值）读到的就是遍历，与「显式配成遍历」表现一致。
 * - `per-turn` = 用户明确的取舍（「风险小一点」）：同轮对话上下文连贯，
 *   也避免部分后端按会话绑定凭据。**这一档没有变**。
 *
 * 冻结：它是被所有 provider 共享的缺省值，任何就地改写都会污染全局。
 */
export const DEFAULT_CONSUMPTION: ConsumptionSetting = Object.freeze({
  order: 'round-robin',
  switch: 'per-turn',
})

/** 余额缓存的存活时长：4 小时，与自动签到 sweep 同节奏。 */
export const BALANCE_CACHE_TTL_MS = 4 * 60 * 60 * 1000

/**
 * 轮次锁的**硬上限**。
 *
 * 锁是内存态、按会话累积，且会话结束后没有任何回调通知我们（DSH 不暴露
 * 「会话已结束」信号）—— 不设上限就是一个随会话数单调增长的 Map（用户开一百个
 * 会话、每个会话一条），属确定的泄漏。取 100：远超正常并发会话数，且单条记录
 * 只有「短字符串 → 短字符串」，上限内存占用可忽略。
 */
export const TURN_ACCOUNT_LOCK_LIMIT = 100

/** 某个值是否是合法的消耗顺序档位。 */
function isOrder(value: unknown): value is ConsumptionOrder {
  return typeof value === 'string' && (CONSUMPTION_ORDERS as readonly string[]).includes(value)
}

/** 某个值是否是合法的切换粒度档位。 */
function isSwitch(value: unknown): value is ConsumptionSwitch {
  return typeof value === 'string' && (CONSUMPTION_SWITCHES as readonly string[]).includes(value)
}

/**
 * 把任意外部值归一化为一条消耗配置。
 *
 * **逐字段兜底**：只缺一个字段时补那一个字段的默认值，而不是把整条配置丢掉 ——
 * 用户手改配置文件写了一半（或旧版本只有其中一个字段）时，另一半应当仍然生效。
 */
export function sanitizeConsumptionSetting(raw: unknown): ConsumptionSetting {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_CONSUMPTION }
  const value = raw as { order?: unknown; switch?: unknown }
  return {
    order: isOrder(value.order) ? value.order : DEFAULT_CONSUMPTION.order,
    switch: isSwitch(value.switch) ? value.switch : DEFAULT_CONSUMPTION.switch,
  }
}

/** 某条配置是否等于默认值（用于「不留噪音键」的判定）。 */
function isDefaultSetting(setting: ConsumptionSetting): boolean {
  return setting.order === DEFAULT_CONSUMPTION.order && setting.switch === DEFAULT_CONSUMPTION.switch
}

/**
 * 把任意外部值归一化为整张消耗配置表。
 *
 * 与 `sanitizeDisabledModels` / `sanitizeContextBudgets` 同一取舍：脏层丢弃、不抛错。
 * 额外一条：**等于默认值的条目不留**（读入与写入两侧同口径，见
 * `AccountPool.writeConsumption`）—— 否则「用户从没配过」与「配成了默认值」
 * 在存储文件里长得一模一样，排查时分不清是哪种。
 *
 * ⚠️ 判等用的是 {@link DEFAULT_CONSUMPTION}，因此默认档从 `sequential` 翻成
 * `round-robin` 后**剔除的键也跟着翻**：旧文档里显式写着的 `sequential` 现在是
 * 一份真实配置（必须保留），而 `round-robin` 变成了那个「不留噪音」的默认值。
 * 两件事都由这一处判等自动跟随，不存在第二份需要同步的名单。
 */
export function sanitizeConsumption(raw: unknown): ConsumptionMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ConsumptionMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider.length === 0) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const setting = sanitizeConsumptionSetting(value)
    if (isDefaultSetting(setting)) continue
    result[provider] = setting
  }
  return result
}

/** 读某 provider 的消耗配置；未配置时返回默认值（读路径永不抛错）。 */
export function consumptionFor(map: ConsumptionMap, provider: string): ConsumptionSetting {
  return map[provider] ?? DEFAULT_CONSUMPTION
}

/** 把任意外部值归一化为遍历游标表（只收非空字符串值）。 */
export function sanitizeConsumptionCursors(raw: unknown): ConsumptionCursorMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ConsumptionCursorMap = {}
  for (const [provider, accountId] of Object.entries(raw as Record<string, unknown>)) {
    if (provider.length === 0) continue
    if (typeof accountId !== 'string' || accountId.length === 0) continue
    result[provider] = accountId
  }
  return result
}

/**
 * 按游标把候选重排：命中游标的账号提到首位，其余保持相对顺序。
 *
 * **游标缺失 / 指向已删除或已停用的账号时原样返回**（`rotateToCursor` 的自愈语义）：
 * 候选数组来自 `readAccounts()` 的 filter，被排除的账号根本不在里面，
 * `findIndex` 返回 -1 即走这条路径 —— 不需要任何额外的「清理游标」逻辑。
 *
 * 游标已在首位时返回**同一引用**：热路径（每个请求都调）上不为「无变化」造新数组。
 */
export function rotateToCursor<T extends { id: string }>(
  candidates: readonly T[],
  cursor: string | undefined,
): readonly T[] {
  if (cursor === undefined || cursor.length === 0) return candidates
  const index = candidates.findIndex(item => item.id === cursor)
  if (index <= 0) return candidates
  return [...candidates.slice(index), ...candidates.slice(0, index)]
}

/**
 * 推进遍历游标：取候选里「选中项的下一项」（末尾回到开头）。
 *
 * @returns 下一个该用的 accountId；选中项**不在候选里**（并发删除）或候选为空时
 *          返回 `undefined` —— 调用方据此**保持原游标不动**，而不是写一个错的进去。
 */
export function nextCursorAfter<T extends { id: string }>(
  candidates: readonly T[],
  pickedId: string,
): string | undefined {
  if (candidates.length === 0) return undefined
  const index = candidates.findIndex(item => item.id === pickedId)
  if (index === -1) return undefined
  return candidates[(index + 1) % candidates.length].id
}

/**
 * 按余额降序重排候选（最高优先档）。
 *
 * ## 未知余额一律排在有余额的账号之后，且保持它们原有的相对顺序
 *
 * 「未知」不是「0」：余额查询失败（网络抖动、非积分账户、凭据失效）不该让那个
 * 账号被当成没钱的账号排到最后并**因此永远选不上**（越选不上越刷不到余额，
 * 形成自锁）。它们被放在后面但仍按用户手动顺序排列，一旦余额刷出来就自然上浮。
 *
 * `balances` 来自 {@link BalanceCache.snapshot}（已过滤过期项）。**一个都没有时
 * 原样返回** —— 这等价于降级回顺序档，正是需求要求的「余额未知时降级」。
 *
 * 稳定性用「先按原下标排序」显式保证（`Array.prototype.sort` 在现代 V8 上稳定，
 * 但不依赖实现细节更安全）。
 */
export function orderByBalance<T extends { id: string }>(
  candidates: readonly T[],
  balances: ReadonlyMap<string, number>,
): readonly T[] {
  if (candidates.length === 0 || balances.size === 0) return candidates
  let anyKnown = false
  for (const item of candidates) {
    if (balances.has(item.id)) { anyKnown = true; break }
  }
  if (!anyKnown) return candidates
  return candidates
    .map((item, index) => ({ item, index, total: balances.get(item.id) }))
    .sort((left, right) => {
      // 有余额的排在没余额的前面。
      if (left.total === undefined || right.total === undefined) {
        if (left.total === right.total) return left.index - right.index
        return left.total === undefined ? 1 : -1
      }
      if (right.total !== left.total) return right.total - left.total
      return left.index - right.index
    })
    .map(entry => entry.item)
}

/** 一个被记下的余额。 */
interface BalanceEntry {
  total: number
  fetchedAt: number
}
/**
 * 把**轮次标识**换算成一个稳定的轮次键。
 *
 * ## 为什么判据是「这些请求是否共享同一个轮次标识对象」
 *
 * DSH 的 `GenerateOptions` 里**没有任何 turn 级字段**（`sessionId` 是会话级、
 * 跨轮稳定，见 README 的接线说明）。adapter 每次请求能拿到、且**同一轮内恒定、
 * 跨轮必然变化**的东西只有 `options.signal`：`agent-loop` 每开一个 turn 换一次
 * `AbortController`（`packages/core/agent-loop/src/agent.ts` 的 `turn()` 末尾
 * `phase.abort = new AbortController()`），而同轮内的多个 step 共用同一个 signal。
 *
 * 因此「轮次」= 该标识对象首次出现到被回收之间的请求集合，这正是用户理解的
 * 「一轮对话」。
 *
 * ## 实现：WeakMap 身份 + 单调递增序号
 *
 * - **身份而非内容**：`signal` 没有可靠的 id，只能按对象身份区分；`WeakMap`
 *   不阻止它们被 GC（会话结束后自动回收，不构成泄漏）。
 * - **序号而非随机**：键只需「同轮相等、跨轮不等」，一个进程内单调计数最省事，
 *   也便于调试（日志里看到 `turn-7` 就知道是第几次开的轮次）。
 * - **空串表示「不属于任何一轮」**：调用方拿不到标识（headless / 单测 / 一次性
 *   调用）时给空串，池那边据此**不锁**（等价 `per-request`）。
 */
export class TurnKeyTracker {
  private readonly keys = new WeakMap<object, string>()
  private counter = 0

  /**
   * @param identity - 本轮次的标识对象（宿主传 `options.signal`）；缺席或非对象时
   *        返回空串（= 不锁）。
   */
  keyFor(identity: unknown): string {
    if (typeof identity !== 'object' || identity === null) return ''
    const existing = this.keys.get(identity)
    if (existing !== undefined) return existing
    const created = `turn-${++this.counter}`
    this.keys.set(identity, created)
    return created
  }
}
/**
 * 宿主侧**内存级**余额缓存（最高优先档的依赖）。
 *
 * ## 为什么必须有它
 *
 * 余额查询是**纯拉取**的（每个账号一次网络往返），在 UI 里由
 * `credits.balances` 触发；而选号发生在请求热路径上，此刻宿主手里没有任何余额
 * 数据。故由一个后台刷新（启动一次 + 每 4h）把结果记进来，选号时同步读。
 *
 * ## 为什么只记内存、不落盘
 *
 * 余额是**秒级可变的远端事实**，落盘只会让「启动时拿着一份几小时前的余额排序」
 * 这件事看起来像权威数据。缓存过期 → 查不到 → 该档自动降级回顺序模式
 * （见 {@link orderByBalance}），代价只是一次保守的选号。
 */
export class BalanceCache {
  /** provider id → accountId → 余额。 */
  private readonly buckets = new Map<string, Map<string, BalanceEntry>>()

  /**
   * 记一笔余额。
   *
   * **不收非有限数**：`NaN` / `±Infinity` 参与排序会让比较函数自相矛盾
   * （`a>b` 与 `b>a` 同时为假），排出来的顺序不可复现。脏值当作「没查到」。
   */
  record(provider: string, accountId: string, total: number, now: number): void {
    if (provider.length === 0 || accountId.length === 0) return
    if (typeof total !== 'number' || !Number.isFinite(total)) return
    let bucket = this.buckets.get(provider)
    if (bucket === undefined) {
      bucket = new Map()
      this.buckets.set(provider, bucket)
    }
    bucket.set(accountId, { total, fetchedAt: now })
  }

  /** 整批写入（余额端点一次返回多个账号）。查不到余额的账号**不写**，保持原值。 */
  recordMany(
    provider: string,
    entries: readonly { accountId: string; total: number }[],
    now: number,
  ): void {
    for (const entry of entries) this.record(provider, entry.accountId, entry.total, now)
  }

  /**
   * 读一笔余额。
   *
   * @returns TTL 内为具体数值；**过期与从未记过都返回 `undefined`** ——
   *          刻意不返回旧值：「拿着过期余额选号」与「降级回顺序选号」相比，
   *          前者会让一个早就没钱的账号持续被选中，后者只是保守。
   */
  lookup(provider: string, accountId: string, now: number): number | undefined {
    const entry = this.buckets.get(provider)?.get(accountId)
    if (entry === undefined) return undefined
    if (now - entry.fetchedAt >= BALANCE_CACHE_TTL_MS) return undefined
    return entry.total
  }

  /** 该 provider 当前**未过期**的余额快照（供 `orderByBalance` 使用）。 */
  snapshot(provider: string, now: number): Map<string, number> {
    const result = new Map<string, number>()
    const bucket = this.buckets.get(provider)
    if (bucket === undefined) return result
    for (const [accountId, entry] of bucket) {
      if (now - entry.fetchedAt >= BALANCE_CACHE_TTL_MS) continue
      result.set(accountId, entry.total)
    }
    return result
  }

  /** 清空全部桶。 */
  clear(): void {
    this.buckets.clear()
  }
}

/**
 * 轮次锁：会话（轮次键）→ 该轮锁定的 accountId。
 *
 * LRU + 硬上限（见 {@link TURN_ACCOUNT_LOCK_LIMIT}）：`Map` 的迭代顺序即插入顺序，
 * 「删除后重插」把键移到末尾即可实现 LRU，不需要额外链表。
 */
export class TurnAccountLock {
  private readonly entries = new Map<string, string>()

  constructor(private readonly limit: number = TURN_ACCOUNT_LOCK_LIMIT) {}

  /** 当前条数（测试与诊断用）。 */
  get size(): number {
    return this.entries.size
  }

  /**
   * 读该轮锁定的账号。
   *
   * 命中时**刷新最近使用次序**：不改的话，一个开着很久的会话（每轮都读它一次）
   * 会比刚开的新会话更早被淘汰，于是长会话每轮都重新选号 —— 粒度档形同虚设。
   */
  get(key: string): string | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /** 登记该轮锁定的账号；**不做已存在即返回**——限流换号需要在同轮内改锁。 */
  set(key: string, accountId: string): void {
    if (key.length === 0 || accountId.length === 0) return
    this.entries.delete(key)
    this.entries.set(key, accountId)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /** 清空（测试与插件重载用）。 */
  clear(): void {
    this.entries.clear()
  }
}
