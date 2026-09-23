import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import {
  emptyAccountHubDocument,
  openAccountHubStorage,
  sanitizeCheckins,
  type AccountHubStorage,
} from './account-hub-storage.js'
import {
  BalanceCache,
  CONSUMPTION_ORDERS,
  CONSUMPTION_SWITCHES,
  TurnAccountLock,
  consumptionFor,
  nextCursorAfter,
  orderByBalance,
  rotateToCursor,
  sanitizeConsumption,
  sanitizeConsumptionCursors,
  type ConsumptionCursorMap,
  type ConsumptionMap,
  type ConsumptionSetting,
} from './account-consumption.js'
import { migrateAccountHubIntoStorage } from './account-hub-migration.js'
import { isCheckinDue } from './checkin-schedule.js'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import type {
  CodeArtsCredential,
  ProviderAccountEntry,
  ProviderAccountStatus,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    accountPool: AccountPool
    /** 宿主解析的 `$DSH_HOME`（`@deepseek-ai/dsh-home-paths` 的 `dshHomePath`）。 */
    dshHomePath?: (...segments: string[]) => string
  }
}

/**
 * Account Hub 旧 settings namespace。
 *
 * ⚠️ **历史兼容读取，勿改** —— 这个字面量是 0.1.6 的 settings namespace，
 * 也是老用户数据真正所在的键。新写入一律走 storage 域（见
 * `src/account-hub-storage.ts` 的 `ACCOUNT_HUB_DOMAIN`），这里只在**回退路径**
 * （storage 不可用）下继续读写它，以及被迁移模块用于定位旧数据。
 */
export const ACCOUNT_HUB_NS = 'jet-hub'

/**
 * 模型黑名单：provider id → **被关闭**的模型 id 列表。
 *
 * 采用**黑名单制**：只有出现在这里、且 `disabled` 为 true 的模型会被隐藏，
 * 未记录的模型一律视为默认打开。这样服务端新增模型时无需任何配置即自动可见，
 * 不会像白名单那样把新模型静默挡在门外。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/**
 * 逐模型的**上下文窗口预算**：provider id → 模型 id → 窗口 token 数。
 *
 * ## 语义（与「专家设置」严格区分）
 *
 * 这里的值**不是用户可以自由填的数字**，而是「该模型目录公布过的档位之一」——
 * 由 `model.setContextBudget` 校验后写入（见 `src/account-hub-rpc.ts`），适配器读取时
 * 还要**再判一次**「它是否精确等于该模型当前目录的 Max 档」（见
 * `TraeCnAdapter.resolveModel` 的预算覆盖）。
 *
 * 两道判据都指向同一件事：**用户设置永远不能编造窗口**。目录 roster 浮动后
 * 旧预算自动失效（退回默认档），而不是拿一个模型已经不认的数字去声明窗口 ——
 * 声明值决定宿主的压缩阈值（`0.8 × 窗口`），编造值会静默改写用户的压缩时机。
 *
 * 缺省 = 全部模型用**默认档**（目录的 dev 档）。
 */
export type ContextBudgetMap = Record<string, Record<string, number>>

/** 账号池在 settings 中存储的值结构。 */
interface AccountHubSettingsValue {
  accounts?: ProviderAccountEntry[]
  /** 模型黑名单（见 {@link ModelDisableMap}）。 */
  disabledModels?: ModelDisableMap
  /** 逐模型上下文窗口预算（见 {@link ContextBudgetMap}）。 */
  contextBudgets?: ContextBudgetMap
  /** 自动签到记录（`provider:accountId` → 下一次可签毫秒时间戳，见 `CheckinsMap`）。 */
  checkins?: Record<string, number>
  /** 消耗顺序 / 切换粒度（见 `ConsumptionMap`）。 */
  consumption?: ConsumptionMap
  /** 遍历游标（见 `ConsumptionCursorMap`）。 */
  consumptionCursors?: ConsumptionCursorMap
  /** 数据版本号，供一次性迁移 short-circuit（见 provider-rename-migration.ts）。 */
  schemaVersion?: number
}

/**
 * 当前数据版本号。
 *
 * - `0`（或字段缺失）= 旧命名：provider 为 `buddy`（中国版）/ `workbuddy`（国际版）；
 * - `1` = 新命名（`buddy-cn` / `buddy`），已由
 *   `src/provider-rename-migration.ts` 迁移完毕；
 * - `2` = 文档新增第五字段 `checkins`（自动签到记录）。
 * - `3` = 文档新增第六、第七字段 `consumption` / `consumptionCursors`
 *   （消耗顺序 / 切换粒度 / 遍历游标）。
 * - `4` = `checkins` 的值口径由「本地纪元日数」换成「**下一次可签毫秒时间戳**」
 *   （各 provider 重置钟点不同，见 `src/checkin-schedule.ts`）。
 *
 * ⚠️ **4 是唯一一次「搬动既有数据」的版本提升**（前三次都只补字段）：旧值必须
 * 换算，否则会被当成一个 1970 年的时间戳、判成「永远可签」而每轮重复签到。
 * 换算本身发生在**读盘那一层**（`sanitizeCheckins` + `normalizeCheckinValue`），
 * 故它不依赖迁移函数是否跑过 —— 版本号的提升只是把「文档已按新口径读过一次」
 * 这件事在存储里落个可判定的标记，并让 `migrateProviderNames` 多跑一趟
 * （那一趟对已迁移数据是无操作）。
 *
 * ⚠️ **2 与 3 两次提升都只是「补字段」，不搬动任何既有数据**：旧文档读入时
 * 由 `sanitizeAccountHubDocument` 补空对象（缺 `consumption` 即等于
 * `DEFAULT_CONSUMPTION`）。提升版本号的实际效果是让 `migrateProviderNames`
 * 对旧文档**多跑一次无操作迁移**并把版本号落定，从而「文档已含该字段」这件事
 * 在存储里有个可判定的标记。
 *
 * ⚠️ **默认档位从 `sequential` 翻成 `round-robin` 时刻意不提升版本号**：
 * 那是 `DEFAULT_CONSUMPTION` 的取值变化，**不涉及文档形状**——旧文档本来就可能
 * 没有 `consumption` 条目，读出来即新默认值；提升版本号只会白跑一次无操作迁移
 * 并让版本号与「文档长什么样」脱钩（版本号表达的是字段集合，不是取值语义）。
 * 存量用户的选号行为确实会从「固定第一个」变为「逐请求轮转」，那正是用户要的。
 *
 * 迁移函数在版本号 ≥ 本常量时整体 short-circuit，因此这个数字只会前进。
 */
export const ACCOUNT_HUB_SCHEMA_VERSION = 4

/** ctx.settings.register() 返回的 owner scope（只用到 get/replace）。 */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
}

/**
 * 一次整体写入的载荷形状。
 *
 * 与 storage 域的 `AccountHubDocument` **刻意同形**（五件套齐全）：两条写路径
 * （storage 的 `global.set` 与 settings 的 `replace`）都是整体替换，用同一个形状
 * 可以让 `persist()` 成为唯一写落点，杜绝「某条路径漏带某个字段」。
 */
interface AccountHubDocumentLike {
  accounts: ProviderAccountEntry[]
  disabledModels: ModelDisableMap
  contextBudgets: ContextBudgetMap
  checkins: Record<string, number>
  consumption: ConsumptionMap
  consumptionCursors: ConsumptionCursorMap
  schemaVersion: number
}

/** ctx.settings 服务的最小接口。schema 必须是 schemastery schema。 */
interface SettingsServiceLike {
  register(ns: string, schema: unknown): SettingsScopeLike
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown }>
}

/**
 * Account Hub 的 settings schema。
 *
 * 必须是 **schemastery schema**，不能是裸函数。schemastery 对象既可调用
 * （`schema(value)` 解析，满足 SettingsProvider.resolve 的用法），又有
 * `toJSON()` 与 `redactSecrets()` 所需的结构；而裸函数只有前者 ——
 * `settings.describe()` 会对每个注册项无条件调用 `schema.toJSON()`，
 * 裸函数会让整条 describe() 抛
 * `TypeError: registration.schema.toJSON is not a function`，
 * 进而使模型设置页、主题设置，以及 sidebar 的
 * `/sidebar/api/settings.get`、`/api/shell.get` 全部 500。
 *
 * 账号列表是动态结构，此处用 `Schema.array(Schema.any())` 承接，
 * 单项字段由 AccountPool 自身在读写时保证。
 */
const accountHubSchema = Schema.object({
  accounts: Schema.array(Schema.any()).default([]),
  // 模型黑名单：对象（provider id → 模型 id → boolean）而非数组。
  //
  // 为什么用 `Schema.dict(Schema.any())` 而不是 `Schema.array(...)`：与账号
  // 列表同理，单项字段由 AccountPool 自身在读写时保证；这里只需让 settings
  // 的 schema 校验不把动态结构（任意 provider、任意模型 id）拒之门外。
  //
  // 为什么带 `.default({})`：namespace 首次注册时配置文件里没有该字段，
  // 没有默认值的话 `scope.get()` 会返回 undefined，需在读取处层层判空。
  disabledModels: Schema.dict(Schema.any()).default({}),
  // 逐模型上下文窗口预算（provider id → 模型 id → token 数）。与黑名单同理用
  // `Schema.dict(Schema.any())`：key 是动态的 provider / 模型 id。
  // **必须带 `.default({})`**：namespace 首次注册时配置里没有该字段。
  contextBudgets: Schema.dict(Schema.any()).default({}),
  // 自动签到记录（`provider:accountId` → 本地纪元日数）。键与值都是动态的，
  // 用 dict 承接，单项由 AccountPool 自身在读写时保证。
  // **必须带 `.default({})`**：老配置里没有该字段（见 schemaVersion 同理）。
  checkins: Schema.dict(Schema.any()).default({}),
  // 消耗顺序 / 切换粒度（provider id → `{ order, switch }`）。与黑名单同理用
  // `Schema.dict(Schema.any())`：key 是动态的 provider id，值由 AccountPool 校验。
  // **必须带 `.default({})`**：老配置里没有该字段。
  consumption: Schema.dict(Schema.any()).default({}),
  // 遍历游标（provider id → 下一个该用的 accountId）。同上，键值都动态。
  // **必须带 `.default({})`**：老配置里没有该字段。
  consumptionCursors: Schema.dict(Schema.any()).default({}),
  // 数据版本号。`0` = 旧命名（buddy=中国版 / workbuddy=国际版）尚未迁移；
  // 见 {@link ACCOUNT_HUB_SCHEMA_VERSION}。**必须带 default**：老配置文件里没有
  // 这个字段，缺失时按 0 处理才等价于「迁移尚未执行」。
  schemaVersion: Schema.number().default(0),
})

/**
 * 空黑名单的共享只读实例。
 *
 * 适配器的 `listModels` 每次都会被模型目录调用，绝大多数 provider/时刻都
 * 没有黑名单；共享同一个冻结集合可以避免每次调用都分配一个新 Set。
 */
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set<string>()

/**
 * 把 settings 里读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 配置文件可能被手工编辑过，也可能残留老版本格式（如数组），因此这里
 * 逐层校验：任何一层不是对象就丢弃那一层，只保留"provider → 模型 → true"
 * 这种合法结构，其余一律忽略而不是抛错——设置页读不出黑名单不该让整个
 * 账号管理功能不可用。
 */
function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      // 只把显式 true 视为"关闭"；false / 其他值既不算关闭，也不写回内存，
      // 避免 `disabledModelsFor` 的判定与配置文件内容产生分歧。
      if (flag === true) perProvider[modelId] = true
    }
    // 空表不保留：让配置文件里不留 `{ provider: {} }` 这类无意义噪音。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * 把 settings 里读到的原始值归一化为 {@link ContextBudgetMap}。
 *
 * 与 {@link sanitizeDisabledModels} 同一取舍：配置文件可能被手工编辑过，任何
 * 一层不是对象就丢弃那一层，不抛错。**只收正的有限数**——0 / 负数 / `NaN` /
 * 字符串一律视为脏值丢弃（一个非正数的窗口不是「很小的窗口」，是无效声明；
 * 适配器侧的 `readPositive` 同口径，两处若不一致会出现「存下了却永远不生效」）。
 */
function sanitizeContextBudgets(raw: unknown): ContextBudgetMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ContextBudgetMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, number> = {}
    for (const [modelId, budget] of Object.entries(value as Record<string, unknown>)) {
      if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) perProvider[modelId] = budget
    }
    // 空表不保留（与黑名单同理：不留 `{ provider: {} }` 这类无意义噪音）。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * AccountPool —— 多账号管理核心
 *
 * 职责：
 * - 账号列表 CRUD（索引存于 **storage 域** `dsh_account_hub`
 *   → `$DSH_HOME/storages/dsh_account_hub.json`，凭据存于 `ctx.credentials`，各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * ## 持久层的三条通路（storage 优先，settings 回退，内存兜底）
 *
 * | 运行环境 | storage | `settings.register` | 行为 |
 * |---|---|---|---|
 * | 0.1.6（现役） | ✓ | ✓ | storage 为主；首次启动做一次性迁移 |
 * | 0.1.7 | ✓ | ✗ | storage 为主；首次启动做一次性迁移 |
 * | 旧环境 / 测试缺 storage | ✗ | ✓ | 回退旧 settings 路径 |
 * | 两者都缺 | ✗ | ✗ | 纯内存降级 |
 *
 * 为什么不再以 settings 为主：0.1.7 删除了 `ctx.settings.register(ns, schema) → scope`
 * 整套 seam，插件在新版下走优雅降级分支、**不抛错、静默全空** —— 用户看到
 * 「所有账号消失」。storage 三件套在两版的 base patch 里逐字一致，两版通吃。
 *
 * ⚠️ 构造**同步**完成，`openStorage()` 才是异步的：storage 域的打开要走后端 IO，
 * 而本类的所有读方法都是同步的（适配器在 `resolveModel` 里同步读窗口预算）。
 * 故由 `src/index.ts` 的 `apply()` 显式 `await pool.openStorage()` —— 在那之前
 * 写入仍走旧 settings/内存路径，不会「先写内存再被 storage 覆盖」。
 */
export class AccountPool {
  /** 已注册的 settings scope（**回退路径**；storage 可用时它是死路径）。 */
  private scope: SettingsScopeLike | undefined
  /** 已打开的 storage 域句柄；不可用时为 undefined（回退 settings / 内存）。 */
  private storage: AccountHubStorage | undefined
  /**
   * **首次** `openStorage()` 的在途/已决 Promise（`openStorage` 的幂等闸门）。
   *
   * 为什么必须是 Promise 而不是布尔标记：只用布尔闸门时，第二次调用会立刻
   * `return this.storage !== undefined` —— 若首次打开**仍在途**，此刻 `storage`
   * 还是 undefined，第二次调用就以 `false` **提前 resolve**，于是挂在它
   * `.then()` 上的启动逻辑会在 storage 接管**之前**跑（读到旧 settings/内存快照）。
   * `apply()` 里几处 `void pool.openStorage().then(...)`（改名迁移、Qoder 资料
   * 回填、自动签到 sweep，以及续期调度判据）全部踩这一条。
   *
   * 缓存 Promise 后，所有调用方拿到的是**同一个**「storage 真的就绪」信号，
   * 与调用顺序无关。
   */
  private storagePromise: Promise<boolean> | undefined
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接每次读持久层：settings 的 resolved 快照在 `replace()` 后未必立即更新，
   * 而本类的每次写入都是「读 → 改 → 整体 replace」。若以滞后快照为读源，
   * 并发/连续的 updateModelRateLimit 会互相覆盖（典型表现：多个账号触发限流后，
   * 一条 modelRateLimits 都没有）。因此首次载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理）。
   */
  private modelCache: ModelDisableMap = {}
  /**
   * 逐模型上下文窗口预算的**权威进程内副本**（同 {@link cache}）。
   *
   * ⚠️ 它与账号、黑名单、签到、版本号是**同一份文档的五件套**：任何一次写入都是整体
   * replace，五者必须互相携带，漏一个就会在下次别的写入里被清空。
   */
  private budgetCache: ContextBudgetMap = {}
  /**
   * 自动签到记录的**权威进程内副本**（同 {@link cache}）。
   *
   * ⚠️ 它与账号、黑名单、预算、版本号是**同一份文档的五件套**：任何一次写入都是
   * 整体 replace，五者必须互相携带，漏一个就会在下次别的写入里被清空。
   * 字段语义与 {@link budgetCache} 完全同构（键 `provider:accountId`，见
   * `sanitizeCheckins`）。
   */
  private checkinCache: Record<string, number> = {}
  /**
   * 消耗顺序 / 切换粒度的**权威进程内副本**（同 {@link cache}）。
   *
   * ⚠️ 与账号、黑名单、预算、签到、游标、版本号是**同一份文档的七件套**：任何一次
   * 写入都是整体 replace，七者必须互相携带，漏一个就会在下次别的写入里被清空。
   */
  private consumptionCache: ConsumptionMap = {}
  /**
   * 遍历游标的**权威进程内副本**（同 {@link cache}）。
   *
   * ⚠️ 同属七件套（理由见 {@link consumptionCache}）。它只有 `round-robin` 档会写，
   * 但**任何**写入路径都必须带上它 —— 否则一次无关的“改个模型开关”就会把游标清零，
   * 表现是「轮转突然从第一个重新开始」。
   */
  private cursorCache: ConsumptionCursorMap = {}
  /**
   * 数据版本号的**权威进程内副本**（同 {@link cache}）。
   *
   * 一次性迁移（provider 改名）靠它 short-circuit，因此它必须与账号、黑名单
   * 一起参与「读 → 改 → 整体 replace」，漏带就会在下次写入时被重置为 0，
   * 让迁移在每次启动时重跑。
   */
  private versionCache = 0
  /** 是否已从持久层完成首次载入。 */
  private loaded = false
  /**
   * 宿主侧**内存级余额缓存**（最高优先档的依赖）。
   *
   * 刻意不落盘（理由见 `src/account-consumption.ts` 的 `BalanceCache` 说明）：
   * 余额是秒级可变的远端事实，落盘只会让一份几小时前的数字看起来像权威数据。
   */
  private readonly balances = new BalanceCache()
  /**
   * 轮次锁：轮次键 → 该轮锁定的 accountId（`per-turn` 粒度用）。
   *
   * 轮次键由调用方（宿主的选号器）给出 —— 它把 `options.signal` 的身份换算成一个
   * 稳定字符串（见 `src/index.ts` 的 `makeTurnKey`）。池这一层不认识 signal，
   * 只认「同一个键 = 同一轮」，从而保持可单测。
   */
  private readonly turnLocks = new TurnAccountLock()

  constructor(private readonly ctx: Context) {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (!settings || typeof settings.register !== 'function') {
      // ⚠️ 措辞必须准确：0.1.7 下 settings 服务仍在、只是没有 `register`，
      // 而 storage 主路径正常 —— 此时说「仅存在于内存中」是**假警报**，
      // 当初排查 0.1.7 报障的人正是被这类日志引偏的。存储服务在时这里就不吭声，
      // 最终降级状态由 `openStorage()` 统一判定并播报。
      if (this.ctx.get('storageDomain') === undefined) {
        this.ctx.logger?.warn?.(
          '[account-hub] settings.register 与 storage 均不可用，账号列表将仅存在于内存中',
        )
      }
      return
    }
    try {
      this.scope = settings.register(ACCOUNT_HUB_NS, accountHubSchema)
    } catch (error) {
      // 重复注册（如插件热重载）时降级为内存态。
      this.ctx.logger?.warn?.(`[account-hub] settings namespace 注册失败，降级运行: ${String(error)}`)
    }
  }

  /**
   * 打开 storage 域并（首次时）执行一次性迁移。
   *
   * **幂等且可重入**：重复调用返回**同一个** Promise（见 {@link storagePromise}）——
   * 并发/后续调用不会在首次打开仍在途时提前拿到 false。storage 不可用时静默返回
   * false，账号池继续用 settings（回退路径）或纯内存 —— 绝不抛错、绝不阻断插件启动。
   *
   * ⚠️ 因此调用方 `await pool.openStorage()` / `.then(...)` 拿到 true 时，
   * **storage 一定已接管**（`this.storage` 已赋值、一次性迁移已跑完），
   * 这正是 `src/index.ts` 里各处启动逻辑所依赖的时序保证。
   *
   * @returns 是否成功接管（true = storage 为主路径）。
   */
  async openStorage(): Promise<boolean> {
    if (this.storagePromise !== undefined) return this.storagePromise
    this.storagePromise = this.openStorageOnce()
    return this.storagePromise
  }

  /** `openStorage` 的**单次**实现；只由 {@link openStorage} 在首次调用时进入。 */
  private async openStorageOnce(): Promise<boolean> {
    const storage = await openAccountHubStorage(this.ctx)
    if (storage === undefined) {
      // storage 缺席：只有连 settings 回退路径也没有时，才是真正的「仅内存」。
      if (this.scope === undefined) {
        this.ctx.logger?.warn?.('[account-hub] settings 与 storage 均不可用，账号列表仅存在于内存中')
      } else {
        this.ctx.logger?.warn?.('[account-hub] storage 不可用，账号池回退 settings 路径')
      }
      return false
    }
    this.storage = storage
    // ⚠️ **接管时必须让首次载入重新发生**：若此前已有任何读路径跑过（`ensureLoaded`
    // 把 `loaded` 置 true 并缓存了旧 settings 快照），继续用它会让接管后的读
    // 返回旧路径的数据，而写入却落到 storage —— 两边数据分叉。
    // 顺序也不可颠倒：先迁移**再**交给读路径，否则首次读取拿到空表。
    this.loaded = false
    await this.runLegacyMigration()
    // 迁移可能刚把数据写进 storage，而 `ensureLoaded` 尚未跑过（`loaded` 仍为 false）
    // ⇒ 下次读会自然取到新数据。但若此前已载入过一次，上面那句 reset 就是关键。
    return true
  }

  /** 把旧 settings 位置的数据一次性搬进 storage（失败只记日志，不阻断）。 */
  private async runLegacyMigration(): Promise<void> {
    const storage = this.storage
    if (storage === undefined) return
    const resolveHome = this.ctx.dshHomePath
    if (typeof resolveHome !== 'function') {
      // 没有 home 解析服务就不猜路径：宁可这轮不迁移，也不能读错目录或写坏别处。
      this.ctx.logger?.warn?.('[account-hub] 宿主未提供 dshHomePath，跳过账号数据一次性迁移')
      return
    }
    try {
      const result = await migrateAccountHubIntoStorage({ home: resolveHome(), storage })
      if (result.outcome === 'migrated') {
        this.ctx.logger?.info?.(
          `[account-hub] 账号池已迁入 storage 域（来源 ${result.origin}，${result.accountCount} 个账号）`,
        )
      } else if (result.outcome === 'failed') {
        this.ctx.logger?.warn?.(
          `[account-hub] 账号数据一次性迁移失败，本轮以现有数据继续（下次启动重试）：${result.error}`,
        )
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`[account-hub] 账号数据一次性迁移异常，本轮跳过：${String(error)}`)
    }
  }

  /** 首次访问时从**主路径**载入五件套。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.storage !== undefined) {
      const doc = this.storage.read()
      this.cache = doc.accounts
      this.modelCache = doc.disabledModels
      this.budgetCache = doc.contextBudgets
      this.checkinCache = doc.checkins
      this.consumptionCache = doc.consumption
      this.cursorCache = doc.consumptionCursors
      this.versionCache = doc.schemaVersion
      return
    }
    if (!this.scope) return
    const value = this.scope.get() as AccountHubSettingsValue | undefined
    const accounts = value?.accounts
    if (Array.isArray(accounts)) {
      this.cache = accounts as ProviderAccountEntry[]
    } else {
      this.ctx.logger?.warn?.(
        `[account-hub] 账号列表首次载入为空（scope 返回 ${JSON.stringify(value)}）`,
      )
    }
    // 黑名单是后来才加入的字段：老配置文件里没有它，缺失时保持空表
    // （等价于"全部模型默认打开"），而不是报错或让整次载入失败。
    this.modelCache = sanitizeDisabledModels(value?.disabledModels)
    // 上下文窗口预算同理（比黑名单更晚加入）：缺失时保持空表，
    // 等价于"全部模型用默认档"。
    this.budgetCache = sanitizeContextBudgets(value?.contextBudgets)
    // 签到记录同理（比预算更晚加入）：缺失时保持空表（等价于"全部未签到"）。
    this.checkinCache = sanitizeCheckins(value?.checkins)
    // 消耗顺序 / 游标同理（比签到更晚加入）：缺失时保持空表
    // —— 等价于「顺序 + 按轮次」的默认配置，即**改动前的行为**。
    this.consumptionCache = sanitizeConsumption(value?.consumption)
    this.cursorCache = sanitizeConsumptionCursors(value?.consumptionCursors)
    // 版本号同理：老配置文件（或首次安装）没有该字段 → 按 0 处理，
    // 即「迁移尚未执行」。
    const version = value?.schemaVersion
    this.versionCache = typeof version === 'number' && Number.isFinite(version) ? version : 0
  }

  /**
   * 持久化七件套。
   *
   * ⚠️ **唯一写落点**：所有写入方法最终都汇到这里，七件套一起带上。
   * 主路径是 storage 域的 `global.set`（整体替换那份单例文档）；回退路径是
   * settings scope 的 `replace`（同样是整体替换，漏带即清空）。
   */
  private async persist(document: AccountHubDocumentLike, warning: string): Promise<void> {
    if (this.storage !== undefined) {
      // storage 写盘失败会**向上抛**：调用方据此知道「没落盘」，而进程内副本
      // 已经更新（读路径是同步的）—— 这与既有的 settings 路径行为一致。
      await this.storage.write({
        accounts: document.accounts,
        disabledModels: document.disabledModels,
        contextBudgets: document.contextBudgets,
        checkins: document.checkins,
        consumption: document.consumption,
        consumptionCursors: document.consumptionCursors,
        schemaVersion: document.schemaVersion,
      })
      return
    }
    if (!this.scope) {
      this.ctx.logger?.warn?.(`[account-hub] ${warning}`)
      return
    }
    await this.scope.replace(document)
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 数据版本号（0 = 旧命名尚未迁移，见 {@link ACCOUNT_HUB_SCHEMA_VERSION}）。
   *
   * 一次性迁移用它做 short-circuit；普通读取路径不关心它。
   */
  get schemaVersion(): number {
    this.ensureLoaded()
    return this.versionCache
  }

  /**
   * 列出**全部** provider 的模型黑名单（含从未改过开关的 provider）。
   *
   * 与 {@link listDisabledModels} 的区别：后者按 provider 取单个子表，
   * 满足设置页渲染；一次性迁移需要整体搬运键名（`buddy` ↔ `workbuddy`），
   * 因此需要一份完整快照。返回的是浅拷贝，改它不会影响进程内副本。
   */
  allDisabledModels(): ModelDisableMap {
    this.ensureLoaded()
    const snapshot: ModelDisableMap = {}
    for (const [provider, models] of Object.entries(this.modelCache)) {
      snapshot[provider] = { ...models }
    }
    return snapshot
  }

  /**
   * 一次性整体写入账号列表、模型黑名单与上下文预算（外加版本号和签到）。
   *
   * 为什么需要它：{@link writeAccounts} / {@link writeModels} 各自只接受
   * 自己那一半，调用方要先写一半再写另一半，中间崩溃会留下半迁移状态。
   * 一次性迁移必须**原子**地落盘「账号 + 黑名单 + 上下文预算 + 版本号」五件套，
   * 故这里直接构造完整的 replace 载荷，只发一次写。
   *
   * ⚠️ **上下文预算原样带上**（不是本次迁移的对象，但同属一个 namespace）：
   * 漏带会让改名迁移顺手清空用户的窗口档位选择。
   *
   * @param accounts - 新的账号列表。
   * @param disabledModels - 新的模型黑名单。
   * @param schemaVersion - 迁移完成后的版本号。
   * @param checkins - 签到记录；缺省取进程内副本（与 `contextBudgets` 的处理一致）。
   */
  async replaceAll(
    accounts: ProviderAccountEntry[],
    disabledModels: ModelDisableMap,
    schemaVersion: number = ACCOUNT_HUB_SCHEMA_VERSION,
    checkins?: Record<string, number>,
  ): Promise<void> {
    // ⚠️ 必须先 ensureLoaded()：本方法只从调用方接收三件套，**上下文预算取自进程内
    // 副本**（它不是迁移对象）。没载入就写，会把用户已有的档位选择覆盖成空。
    // 同 `setModelDisabled` / `writeContextBudget` 的那条陷阱。签到同理。
    this.ensureLoaded()
    this.cache = accounts
    this.modelCache = disabledModels
    this.versionCache = schemaVersion
    if (checkins !== undefined) this.checkinCache = checkins
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无 storage 域与 settings scope，数据迁移结果未持久化')
      return
    }
    await this.persist({
      accounts,
      disabledModels,
      contextBudgets: this.budgetCache,
      checkins: checkins ?? this.checkinCache,
      consumption: this.consumptionCache,
      consumptionCursors: this.cursorCache,
      schemaVersion,
    }, '无 settings scope，数据迁移结果未持久化')
  }

  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单、上下文预算、签到与版本号一起写回**：settings 的 `replace()` 是整体替换，
   * 只写 `{ accounts }` 会把同一 namespace 下的 `disabledModels`、`contextBudgets`
   * 与 `checkins` 抹掉，`schemaVersion` 同理会被重置为 0（于是改名迁移会在每次启动时重跑）。
   */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    this.cache = accounts
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无持久化通路，账号变更未持久化')
      return
    }
    await this.persist({
      accounts,
      disabledModels: this.modelCache,
      contextBudgets: this.budgetCache,
      checkins: this.checkinCache,
      consumption: this.consumptionCache,
      consumptionCursors: this.cursorCache,
      schemaVersion: this.versionCache,
    }, '无 settings scope，账号变更未持久化')
  }

  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
   * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return EMPTY_MODEL_SET
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true)
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET
  }

  /**
   * 列出某 provider 的模型黑名单，供设置页渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
   * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
   */
  listDisabledModels(provider: string): Record<string, boolean> {
    this.ensureLoaded()
    return { ...(this.modelCache[provider] ?? {}) }
  }

  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void> {
    // 必须先 ensureLoaded()：`writeModels` 会把 `loaded` 置 true 并整表写回，
    // 若此时 `modelCache` / `cache` / `budgetCache` / `versionCache` 还是构造初值，
    // 这次写入会**把它们覆盖成空**——已有的黑名单、账号列表、上下文预算与数据
    // 版本号一起丢（版本号丢失会让改名迁移在每次启动重跑）。`writeAccounts` 的
    // 调用方都先读列表因而躲过了这一坑，这里是唯一不经过读路径的直接写入入口。
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeModels(next)
  }

  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  private async writeModels(disabledModels: ModelDisableMap): Promise<void> {
    this.modelCache = disabledModels
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无持久化通路，模型黑名单变更未持久化')
      return
    }
    // 与 writeAccounts 对称：整体 replace 必须携带账号列表、上下文预算、签到与版本号，否则会被清空。
    await this.persist({
      accounts: this.cache,
      disabledModels,
      contextBudgets: this.budgetCache,
      checkins: this.checkinCache,
      consumption: this.consumptionCache,
      consumptionCursors: this.cursorCache,
      schemaVersion: this.versionCache,
    }, '无 settings scope，模型黑名单变更未持久化')
  }

  /**
   * 读取某模型的**上下文窗口预算**（未被设置过时为 `undefined` = 默认档）。
   *
   * 与 {@link disabledModelsFor} 同款：只读进程内权威副本，同步返回 —— 适配器在
   * `resolveModel` 里同步调用它，写档位后无需重建适配器，下一次解析即生效。
   */
  contextBudget(provider: string, modelId: string): number | undefined {
    this.ensureLoaded()
    return this.budgetCache[provider]?.[modelId]
  }

  /**
   * 写入/清除某模型的上下文窗口预算。
   *
   * 只改**单个键**（读 → 改 → 整体 replace），与 {@link setModelDisabled} 同款。
   * `value === undefined` = **删除该键**（恢复默认档），而不是写一个 0 或 -1 的哨兵值：
   * 「未设置」与「设成某个数」在读取侧必须是两种可区分的状态，写哨兵会让
   * `contextBudget()` 的返回值语义分叉。
   *
   * ⚠️ 本方法**不做档位校验** —— 校验属于 RPC 层（它手上有目录）。
   * 但读取侧（`TraeCnAdapter.resolveModel`）仍会再判一次「是否精确命中目录公布的档位」，
   * 故即便有人绕过 RPC 写入一个编造值，最坏结果也只是静默退回默认档，不会改写声明窗口。
   */
  async writeContextBudget(provider: string, modelId: string, value: number | undefined): Promise<void> {
    // 必须先 ensureLoaded()：`writeBudgets` 会把 `loaded` 置 true 并整表写回，
    // 若此时 `budgetCache` / `cache` / `modelCache` / `versionCache` 还是构造初值，
    // 这次写入会**把它们覆盖成空** —— 账号列表、黑名单与数据版本号一起丢
    // （版本号丢失会让改名迁移在每次启动重跑）。同 `setModelDisabled`。
    this.ensureLoaded()
    const next: ContextBudgetMap = { ...this.budgetCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (value === undefined) delete perProvider[modelId]
    else perProvider[modelId] = value
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeBudgets(next)
  }

  /** 持久化上下文窗口预算（同时更新进程内权威副本）。 */
  private async writeBudgets(contextBudgets: ContextBudgetMap): Promise<void> {
    this.budgetCache = contextBudgets
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无持久化通路，上下文窗口预算变更未持久化')
      return
    }
    // 与 writeAccounts / writeModels 对称：整体 replace 必须携带另外四件套，否则会被清空。
    await this.persist({
      accounts: this.cache,
      disabledModels: this.modelCache,
      contextBudgets,
      checkins: this.checkinCache,
      consumption: this.consumptionCache,
      consumptionCursors: this.cursorCache,
      schemaVersion: this.versionCache,
    }, '无 settings scope，上下文窗口预算变更未持久化')
  }

  /**
   * 读取某账号的**下一次可签时刻**（本地时间毫秒时间戳）。
   *
   * 只读进程内权威副本，同步返回 —— 与 {@link contextBudget} 同款。不在表里的键
   * （尚未签过 / 该键不存在）读回 `undefined` = 可签。
   *
   * ⚠️ **返回值不是「签到日」**：它是「下一次可签的时刻」，判定已签要用
   * `Date.now() < 返回值`（见 `src/checkin-schedule.ts` 的 `isCheckinDue`）。
   * 旧口径（本地纪元日数）已整体作废，读盘时由 `sanitizeCheckins` 就地迁移。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   */
  checkinNextEligible(provider: string, accountId: string): number | undefined {
    this.ensureLoaded()
    return this.checkinCache[`${provider}:${accountId}`]
  }

  /**
   * 判定某账号**此刻是否可签**（无记录、或记录的下一次可签时刻已过）。
   *
   * 收在池上而不是让调用方自己比：`now` 的取值时点与存储的读法必须一致，
   * 三处调用点（sweep 筛选 / 面板状态 / 单账号签到）各写一次就会在边界上漂移。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @param now - 判定时刻，缺省当前时间（便于测试注入固定时刻）。
   */
  isCheckinDue(provider: string, accountId: string, now: number = Date.now()): boolean {
    return isCheckinDue(this.checkinNextEligible(provider, accountId), now)
  }

  /**
   * 持久化某账号的**下一次可签时刻**。
   *
   * 只改**单个键**（读 → 改 → 整体 replace），与 {@link writeContextBudget} 同款。
   * 键格式 `${provider}:${accountId}`。
   *
   * ⚠️ **必须先 ensureLoaded()**：整体 replace 若在 `loaded` 尚未置位时跑，会把账号、
   * 黑名单、预算、版本号一起覆盖成空（同 `setModelDisabled` / `writeContextBudget`
   * 那条陷阱）。读经 `ensureLoaded`、写经 `persist` 的唯一通路。
   *
   * ⚠️ **值是「下一次可签时刻」，不是签到时刻**：调用方应传
   * `nextEligibleAt(签到成功时刻, provider)`（见 `src/checkin-schedule.ts`），
   * 不要传 `Date.now()` —— 那等于把「刚签完」记成「此刻可签」，下一个 tick 就会
   * 再签一次。
   *
   * @param provider - provider id。
   * @param accountId - 账号 id。
   * @param nextEligible - 下一次可签时刻（毫秒时间戳，按该 provider 的重置钟点算）。
   */
  async writeCheckinNextEligible(
    provider: string,
    accountId: string,
    nextEligible: number,
  ): Promise<void> {
    this.ensureLoaded()
    const next: Record<string, number> = { ...this.checkinCache }
    next[`${provider}:${accountId}`] = nextEligible
    await this.writeCheckins(next)
  }

  /** 持久化签到记录（同时更新进程内权威副本）。 */
  private async writeCheckins(checkins: Record<string, number>): Promise<void> {
    this.checkinCache = checkins
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无持久化通路，签到记录变更未持久化')
      return
    }
    // 与 writeAccounts / writeModels / writeBudgets 对称：整体 replace 必须携带
    // 另外四件套，否则会被清空。
    await this.persist({
      accounts: this.cache,
      disabledModels: this.modelCache,
      contextBudgets: this.budgetCache,
      checkins,
      consumption: this.consumptionCache,
      consumptionCursors: this.cursorCache,
      schemaVersion: this.versionCache,
    }, '无 settings scope，签到记录变更未持久化')
  }

  /**
   * 清理该 provider 的**孤儿签到键**（兜底，供设置页打开面板时调用）。
   *
   * 删除 `checkins` 里 `provider:` 前缀匹配、但 accountId **不在当前账号列表**的键。
   * 「账号删除时」那条清理（{@link removeAccount}）只在单键发生时顺带做；这是
   * **残留兜底**：太久不删的账号若在别处（如 provider 改名）留下残余，面板打开时
   * 一次性清掉。无账号时跳过。
   *
   * @param provider - provider id。
   */
  async pruneOrphanCheckins(provider: string): Promise<void> {
    const accounts = this.listAccountsByProvider(provider)
    if (accounts.length === 0) return
    const keep = new Set(accounts.map((a) => a.id))
    const prefix = `${provider}:`
    let changed = false
    const next: Record<string, number> = {}
    for (const [key, day] of Object.entries(this.checkinCache)) {
      if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length))) {
        changed = true
        continue
      }
      next[key] = day
    }
    if (!changed) return
    await this.writeCheckins(next)
  }

  /** 列出某个 provider 的所有账号（含状态信息） */
  /**
   * 读某 provider 的**消耗顺序 / 切换粒度**配置。
   *
   * 未配置时返回默认值（`round-robin` + `per-turn`），**永不抛错** —— 它是选号
   * 热路径上的同步读，一次配置读取失败绝不能让请求发不出去。
   */
  consumptionSetting(provider: string): ConsumptionSetting {
    this.ensureLoaded()
    return consumptionFor(this.consumptionCache, provider)
  }

  /**
   * 列出**全部** provider 的消耗配置（浅拷贝快照）。
   *
   * 供 RPC 一次性回传整页状态，以及宿主判定「哪些 provider 开了最高优先档」
   * （后者决定余额刷新要不要为它发请求，见 `src/index.ts` 的余额刷新接线）。
   */
  allConsumption(): ConsumptionMap {
    this.ensureLoaded()
    const snapshot: ConsumptionMap = {}
    for (const [provider, setting] of Object.entries(this.consumptionCache)) {
      snapshot[provider] = { ...setting }
    }
    return snapshot
  }

  /**
   * 写某 provider 的消耗配置（**部分更新**）。
   *
   * ## 为什么是部分更新而不是整体覆盖
   *
   * 界面是两个**彼此独立**的选择器（消耗顺序 / 切换粒度），各自只改一个字段。
   * 若做成整体覆盖，客户端每次都要把另一半也回传 —— 一旦它手上的另一半是过期的
   * （另一个标签页刚改过），用户改顺序会顺手把粒度改回去。
   *
   * ## 校验在写入侧（RPC 也要再判一次）
   *
   * 非法档位**抛错拒绝**，而不是「尽力而为」地写一个永不生效的值：
   * 后者在界面上的表现是「选了没反应」，比一句明确的报错难排查得多。
   *
   * @param provider - provider id。
   * @param patch - 只含要改的字段；两个字段都不给时是无操作（不写盘）。
   */
  async writeConsumption(provider: string, patch: Partial<ConsumptionSetting>): Promise<void> {
    // 必须先 ensureLoaded()：`writeConsumptionAll` 会把 `loaded` 置 true 并整表写回，
    // 若此时七件套还是构造初值，这次写入会把它们全部覆盖成空（同 `setModelDisabled`）。
    this.ensureLoaded()
    if (patch.order !== undefined && !CONSUMPTION_ORDERS.includes(patch.order)) {
      throw new Error(`不支持的消耗顺序：${String(patch.order)}（可选 ${CONSUMPTION_ORDERS.join(' / ')}）`)
    }
    if (patch.switch !== undefined && !CONSUMPTION_SWITCHES.includes(patch.switch)) {
      throw new Error(`不支持的切换粒度：${String(patch.switch)}（可选 ${CONSUMPTION_SWITCHES.join(' / ')}）`)
    }
    if (patch.order === undefined && patch.switch === undefined) return
    const current = consumptionFor(this.consumptionCache, provider)
    const merged: ConsumptionMap = { ...this.consumptionCache }
    // 经 `sanitizeConsumption` 落位：**等于默认值的条目会被剔除**，因此「改回默认」
    // 就是删除键，文件里不留 `{ provider: {默认值} }` 这类无意义噪音。
    // 复用同一个归一化函数而不是自己判等 —— 判据只有一份，不会与读路径漂移。
    const normalized = sanitizeConsumption({
      [provider]: {
        order: patch.order ?? current.order,
        switch: patch.switch ?? current.switch,
      },
    })
    if (normalized[provider] === undefined) delete merged[provider]
    else merged[provider] = normalized[provider]
    await this.writeConsumptionAll(merged)
  }

  /** 持久化消耗配置（同时更新进程内权威副本）。 */
  private async writeConsumptionAll(consumption: ConsumptionMap): Promise<void> {
    this.consumptionCache = consumption
    this.loaded = true
    if (this.storage === undefined && !this.scope) {
      this.ctx.logger?.warn?.('[account-hub] 无持久化通路，消耗配置变更未持久化')
      return
    }
    // 与其余各 writeXxx 对称：整体 replace 必须携带另外六件套，否则会被清空。
    await this.persist({
      accounts: this.cache,
      disabledModels: this.modelCache,
      contextBudgets: this.budgetCache,
      checkins: this.checkinCache,
      consumption,
      consumptionCursors: this.cursorCache,
      schemaVersion: this.versionCache,
    }, '无 settings scope，消耗配置变更未持久化')
  }

  /**
   * 记下遍历游标（`round-robin` 档「下一个该用的账号」）。
   *
   * **游标没变时不写盘**：单账号 provider 每次请求的游标都是它自己，若照写不误，
   * 每个请求都会触发一次整体 replace（含全部账号与配置）——纯属浪费，且在
   * storage 上是真实的 IO。
   */
  private async writeConsumptionCursor(provider: string, accountId: string): Promise<void> {
    this.ensureLoaded()
    if (this.cursorCache[provider] === accountId) return
    const next: ConsumptionCursorMap = { ...this.cursorCache, [provider]: accountId }
    this.cursorCache = next
    this.loaded = true
    if (this.storage === undefined && !this.scope) return
    await this.persist({
      accounts: this.cache,
      disabledModels: this.modelCache,
      contextBudgets: this.budgetCache,
      checkins: this.checkinCache,
      consumption: this.consumptionCache,
      consumptionCursors: next,
      schemaVersion: this.versionCache,
    }, '无 settings scope，遍历游标变更未持久化')
  }

  /**
   * 整批记录余额（供宿主侧的余额刷新调用，见 `src/account-hub-rpc.ts` 的
   * `collectProviderBalances`）。**只进内存缓存，不落盘**。
   *
   * @param provider - provider id。
   * @param entries - 每个账号的余额；查不到的账号不在数组里（保持缓存原值）。
   * @param now - 记录时刻（缺省为当前时间；便于测试注入）。
   */
  recordBalances(
    provider: string,
    entries: readonly { accountId: string; total: number }[],
    now: number = Date.now(),
  ): void {
    this.balances.recordMany(provider, entries, now)
  }

  /** 读该 provider 当前**未过期**的余额快照（最高优先档的排序依据）。 */
  balanceSnapshot(provider: string, now: number = Date.now()): Map<string, number> {
    return this.balances.snapshot(provider, now)
  }

  async listAccounts(provider: string): Promise<ProviderAccountStatus[]> {
    const filtered = this.readAccounts().filter(a => a.provider === provider)
    const results: ProviderAccountStatus[] = []
    for (const entry of filtered) {
      const status: ProviderAccountStatus = { ...entry }
      try {
        const info = await this.ctx.credentials.describe(credentialRef(entry.credentialRef))
        status.source = info.source
      } catch {
        // 凭据可能已被外部删除
      }
      results.push(status)
    }
    return results
  }

  /** 列出所有 provider 的账号 */
  async listAllAccounts(): Promise<ProviderAccountEntry[]> {
    return this.readAccounts()
  }

  /**
   * **同步**列出所有 provider 的账号（进程内权威副本）。
   *
   * 与 {@link listAllAccounts} 是同一份数据，唯一区别是**不需要 await** ——
   * 供「判据本身就是同步逻辑」的调用点使用（如启动续期调度的 `hasRefreshable`
   * 判定）。它读的就是 `ensureLoaded()` 之后的权威副本，因此**必须在
   * `openStorage()` 之后调用**：在那之前副本来自 settings 回退路径或空表。
   *
   * 刻意返回**副本**而不是内部数组：调用方（含定时器回调）拿到的是快照，
   * 就地改它不会污染池。
   */
  listAllAccountsSnapshot(): ProviderAccountEntry[] {
    return [...this.readAccounts()]
  }

  /**
   * 审计「凭据域名与当前产品配置不符」的账号，**只告警、不删除**。
   *
   * 用途：国际版 provider（`buddy`，www.workbuddy.ai）早年是中国版实现
   * （copilot.tencent.com），改造后旧账号存的仍是中国版凭据 —— 它们的
   * `token.domain` 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   *
   * ⚠️ **迷信删除是数据丢失事故的根因**：domain 失配的账号其凭据往往依然有效
   * （例如国际版账号凭据里写着中国版时代遗留的 domain），直接连凭据一起删除会把
   * 不可恢复的登录凭据销毁。因此这里**保留**账号与凭据，仅记一条含 provider /
   * accountId / domain 的警告，交由用户自行判断与处理——机器不再静默销毁数据。
   *
   * 判据是**凭据里记录的 domain 与产品配置的 apiDomain 不一致**（而不是简单按
   * provider 名），这样只圈定真正失配的条目，不会误伤已在新端点登录的账号。
   * 凭据完全不可解析（缺失 / domain 为空 / JSON 损坏）的历史条目**从不动手**，
   * 一律保守保留，交给「凭据未配置」的正常报错路径处理。
   *
   * @returns 被判定为「域名失配」的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(product: BuddyProduct): Promise<string[]> {
    const flagged: string[] = []
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue
      let domain = ''
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined) continue
        const parsed = JSON.parse(resolved.value) as { domain?: unknown }
        domain = typeof parsed.domain === 'string' ? parsed.domain : ''
      } catch {
        // 凭据缺失或损坏：留给「凭据未配置」的正常报错路径处理，这里不动
        continue
      }
      // domain 为空表示历史凭据未记录域名，无法判定，保守保留。
      if (domain.length === 0) continue
      if (domain !== product.apiDomain) {
        // 保守语义：不删除、不 unset 凭据，只告警，让用户可以自行处理。
        this.ctx.logger?.warn?.(
          `[account-hub] ${product.id} 账号 ${entry.id} 的凭据域名失配：记录 ${domain}，`
          + `预期 ${product.apiDomain}。账号与凭据已保留、未删除，请人工确认该账号是否仍有效；`
          + `若不适用可自行注销。`,
        )
        flagged.push(entry.id)
      }
    }
    return flagged
  }

  /** 添加新账号（登录成功后调用） */
  async addAccount(entry: ProviderAccountEntry): Promise<void> {
    const accounts = [...this.readAccounts(), entry]
    await this.writeAccounts(accounts)
  }

  /** 更新账号部分字段 */
  async updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
  ): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const next = [...accounts]
    next[idx] = { ...next[idx], ...patch }
    await this.writeAccounts(next)
  }

  /** 删除账号（同时清理凭据，并顺带清掉其孤儿签到键） */
  async removeAccount(id: string): Promise<void> {
    const accounts = this.readAccounts()
    const entry = accounts.find(a => a.id === id)
    if (!entry) return
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef))
    } catch { /* 凭据可能已被删除 */ }
    // 清除该账号的签到记录（`provider:${id}` 精确键），随本次整体 replace 顺带写。
    // 与 `clearModelRateLimits` 同模式：不额外写盘，避免删除账号触发两次落盘。
    if (Object.prototype.hasOwnProperty.call(this.checkinCache, `${entry.provider}:${id}`)) {
      delete this.checkinCache[`${entry.provider}:${id}`]
    }
    await this.writeAccounts(accounts.filter(a => a.id !== id))
  }

  /**
   * 重排某 provider 下账号的顺序（Account Hub 拖拽排序）。
   *
   * ## 为什么顺序有实际意义
   *
   * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
   * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
   * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
   *
   * ## 只动本 provider 的槽位
   *
   * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
   * 而设置页是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
   * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
   *
   * 不这么做（例如把该 provider 的账号整体挪到数组头部）会让拖拽 CodeArts
   * 的顺序顺带改变 Buddy 账号的相对位置，属于跨面板的意外副作用。
   *
   * ## 校验：必须是同一集合的一个排列
   *
   * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
   * 不满足就抛错而不是「尽力而为」：
   * - 少了某个 id（前端列表过期，期间账号被别处新增）→ 若静默忽略，那个账号
   *   会莫名其妙掉到末尾，用户看到的是"顺序自己变了"；
   * - 多了未知 id、或同一个 id 出现两次 → 说明前端状态与服务端不一致。
   * 两种情况都让用户刷新重试，比悄悄改数据安全。
   *
   * @param provider - provider id
   * @param orderedIds - 该 provider 全部账号 id 的目标顺序
   */
  async reorderAccounts(provider: string, orderedIds: readonly string[]): Promise<void> {
    const accounts = this.readAccounts()
    // 该 provider 占用的下标，与这些下标上的条目一一对应。
    const indices: number[] = []
    const currentIds: string[] = []
    const byId = new Map<string, ProviderAccountEntry>()
    accounts.forEach((entry, index) => {
      if (entry.provider !== provider) return
      indices.push(index)
      currentIds.push(entry.id)
      byId.set(entry.id, entry)
    })

    // 集合一致性校验（顺序无关）：数量相等 + 无重复 + 每个 id 都属于本 provider。
    const got = new Set(orderedIds)
    const sameSet = orderedIds.length === byId.size
      && got.size === orderedIds.length
      && orderedIds.every(id => byId.has(id))
    if (!sameSet) {
      throw new Error(
        `账号列表已变化，请刷新后重试（${provider} 期望 ${byId.size} 个账号 id 的一个排列，`
        + `收到 ${orderedIds.length} 个）`,
      )
    }

    // 顺序没变（含该 provider 无账号、只有一个账号两种退化情形）→ 不写盘：
    // 拖拽落回原位是常见操作，没必要为一次无变化的整体 replace 惊动持久层。
    if (orderedIds.every((id, position) => id === currentIds[position])) return

    const next = [...accounts]
    // 按新顺序回填到该 provider 原本占用的下标上。
    indices.forEach((accountIndex, position) => {
      next[accountIndex] = byId.get(orderedIds[position])!
    })
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(`[account-hub] 已重排 ${provider} 账号顺序: ${orderedIds.join(', ')}`)
  }

  /**
   * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
   *
   * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
   * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   * @param provider - provider 名称（'buddy-cn' | 'buddy' | 'codearts'）。
   * @param identity - 比对用的标识值：Buddy 系传 access_token，CodeArts 传 access_key_id。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider: string, identity: string): Promise<string> {
    if (identity.length === 0) return ''
    // 凭据中的唯一标识字段：Buddy 系（buddy-cn / buddy）用 access_token，
    // CodeArts 用 access_key_id。选错字段会导致匹配恒失败，限流记录无法归属账号。
    const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      if (resolved[identifierKey] === identity) return entry.id
    }
    return ''
  }

  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  private async resolveCredentialByRef(refName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
      if (!resolved) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id: string): ProviderAccountEntry | undefined {
    return this.readAccounts().find(a => a.id === id)
  }

  /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    return this.readAccounts().filter(a => a.provider === provider)
  }

  /**
   * 该 provider 是否**至少有一个已登录（凭据可解析）的账号**。
   *
   * 供适配器的 `listModels` 做目录门控：没有已登录账号时返回空目录，让 DSH 的
   * `buildModelCatalog` 把整个 provider 分组隐藏（它显式
   * `.filter(group => group.models.length > 0)`），从而显著减少模型选择列表里
   * 用不上的条目。
   *
   * ## 为什么判据是「凭据可解析」而不是「有条目」
   *
   * 1. **`logout()` 只清凭据、保留账号条目**（删除条目是另一条路径
   *    `removeAccount`）。若只看「有没有条目」，用户登出后模型仍会显示，
   *    门控形同虚设。
   * 2. **不看 `enabled`**：停用只应影响「自动选号」，与「是否已登录」无关。
   *    这与续期调度器「只按 `refreshable` 过滤、不看 `enabled`」是同一条既有
   *    约定（停用账号同样参与积分领取），故这里保持一致。
   *
   * ⚠️ **这是异步的**：需要逐个解析凭据。但只解析到**第一个可用凭据**即返回
   * （短路），多账号场景下通常第一次就命中。
   *
   * ⚠️ **本方法只用于「目录展示」的门控**，绝不能用于路由判定 —— DSH 约定
   * `listModels` 结果仅供参考，隐藏目录不等于拒绝请求（被隐藏的模型仍可
   * `resolveModel` / 正常收发）。
   *
   * ## `extraCredentialRefs`：本仓特有的**单凭据路径**（不要照抄上游删掉）
   *
   * 上游把 CodeArts 的单凭据回退整体移除（`extraCredentialRefs` 参数一并删除），
   * 因为它的登录入口只剩设置页、凭据一律写入 `CODEARTS_ACCOUNT_XXX`。
   *
   * **本仓不同**：`/codearts-login` 命令仍然存在且活跃（`src/index.ts` 的
   * `service.login()`），它把凭据写进固定的 `CODEARTS_ACCESS_TOKEN`；适配器的
   * `makeCredentialResolver` 也在池中取不到账号时回退读同一个 ref。若门控只看
   * 账号池，**纯单凭据登录的用户会看到 codearts 的全部模型凭空消失**。
   * 故这里额外接受一组 ref，任一可解析即视为「已登录」。
   *
   * 其余五个 provider 的 `Auth.login()` 在本仓**没有任何调用者**（Account Hub
   * 一律走两段式直接写 `*_ACCOUNT_XXX`），故它们的默认 ref 不构成活跃登录路径，
   * 刻意不传 —— 传了是死代码。
   *
   * @param provider - provider id。
   * @param extraCredentialRefs - 额外的单凭据 ref（如 `CODEARTS_ACCESS_TOKEN`）。
   */
  async hasLoggedInAccount(provider: string, extraCredentialRefs?: readonly string[]): Promise<boolean> {
    for (const entry of this.listAccountsByProvider(provider)) {
      const credential = await this.resolveCredentialByRef(entry.credentialRef)
      if (credential !== undefined) return true
    }
    for (const ref of extraCredentialRefs ?? []) {
      const credential = await this.resolveCredentialByRef(ref)
      if (credential !== undefined) return true
    }
    return false
  }

  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
   * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
   * 只认启用账号，而按 id 的显式探测认全部账号。
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   */
  async resolveCredentialForAccount(
    id: string,
  ): Promise<CodeArtsCredential | BuddyCredential | undefined> {
    const entry = this.findAccount(id)
    if (entry === undefined) return undefined
    const parsed = await this.resolveCredentialByRef(entry.credentialRef)
    if (parsed === undefined) return undefined
    return parsed as unknown as CodeArtsCredential | BuddyCredential
  }

  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) return 0
    const entry = accounts[idx]
    const current = entry.modelRateLimits
    if (!current || Object.keys(current).length === 0) return 0

    const limits = { ...current }
    let removed = 0
    const targets = modelIds ?? Object.keys(limits)
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed++
      }
    }
    if (removed === 0) return 0

    const next = [...accounts]
    const updated = { ...entry }
    // 清空后删除字段本身，避免 settings 里留下空对象噪音。
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits
    else updated.modelRateLimits = limits
    next[idx] = updated
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[account-hub] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
    )
    return removed
  }

  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
   * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
   * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param modelId - 目标模型；空串表示不按模型过滤
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
   * 候选顺序是**用户手动顺序**（见 {@link reorderAccounts}），当失败类别
   * **不写限流标记**时（如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍排在原位，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   *
   * ## `pick`：消耗顺序 / 切换粒度（可选，**不传即历史行为**）
   *
   * 见 `src/account-consumption.ts`。四种调用形态的语义：
   *
   * | `pick` | 行为 |
   * |---|---|
   * | 不传 | **与改动前逐字段一致**（顺序档：永远取第一个可用账号） |
   * | `{ turnKey }` | 按该 provider 配置的档位选号，`per-turn` 时同轮锁同一账号 |
   * | `{ turnKey: '' }` / 省略 `turnKey` | 按档位选号但**不锁**（等价 `per-request`） |
   *
   * ⚠️ **不传 `pick` 与「传了但没配过」必须都是历史行为** —— auth 的单发路径
   * （`buddy-auth.fetchModels` / `lobsterai-auth.fetchModels`）与
   * `makeAccountPicker` 都靠这条不被影响。
   *
   * ## 适配器的**换号重试循环刻意不传 `pick`**
   *
   * `buddy-adapter` / `lobsterai-adapter` / `trae-cn-adapter` / `qoder-adapter` /
   * `llm-adapter` 在限流或额度耗尽后各自有一个「取下一个未试过的账号」循环，
   * 那里的调用**刻意保持三个实参**（不传 `pick`）。理由是语义而非省事：
   *
   * - 消耗顺序的档位定义是「每次**请求**轮转下一个」。一次请求内部的换号重试
   *   仍是**同一次请求**，让它再消耗一格轮转名额，会让「两个账号」的池在
   *   一请求一失败后跳过整整一轮 —— 用户看到的是「轮转跳着走」；
   * - 重试的目标只有一个：**换一个没试过的账号**。候选已被 `tried` 排除，
   *   取数组顺序的下一个即可，与档位无关；
   * - 它同时避开了「重试路径二次写游标」——那会让一次失败请求落盘两次。
   *
   * 换句话说：档位决定**请求开始时**用谁，重试只决定**这一个请求内**还试谁。
   *
   * @param pick.turnKey - 轮次键：同一个键 = 同一轮对话（`per-turn` 档据此锁号）。
   *        宿主侧由 `options.signal` 的身份换算（见 `src/index.ts` 的
   *        `TurnKeyTracker`）；空串 / 缺省表示「这不是一轮对话」（不锁）。
   */
  async getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
    pick?: { turnKey?: string },
  ): Promise<{ entry: ProviderAccountEntry; credential: CodeArtsCredential | BuddyCredential } | null> {
    const candidates = this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => excludeAccountIds === undefined || !excludeAccountIds.has(a.id))
      .filter(a => {
        // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
    if (candidates.length === 0) return null
    // 候选顺序即**用户在 Account Hub 拖拽设定的手动顺序**（`reorderAccounts` 写入）。
    //
    // 为什么不再按「限流重置时间最早到期」重排（早期实现如此，上游 84d0b3f 移除）：
    // 那个排序会让手动顺序形同虚设 —— 用户把某账号拖到首位，只要另一个
    // 账号的限流重置时间更早，实际选中的仍是后者，拖拽变成纯 UI 装饰。
    // 现在的语义是「手动顺序优先，限流豁免」：顺序完全由用户决定，
    // 而当前正处于限流期的账号已被上面的 filter 排除，不会选到。
    //
    // 注意 candidates 来自 readAccounts() 的 filter，而 filter 保持原数组
    // 顺序，故这里天然就是手动顺序，无需任何排序。
    //
    // ── 消耗顺序 / 切换粒度（只在调用方传了 `pick` 时介入）──
    //
    // ⚠️ **不传 `pick` 时下面整段都不执行**，候选顺序与选中结果与改动前逐字段
    // 相同。这是硬约束：`buddy-auth.fetchModels` / `lobsterai-auth.fetchModels`
    // 与各适配器的换号重试循环都走那条路，它们拿到的必须是「第一个可用账号」。
    const ordered = pick === undefined ? candidates : this.applyConsumptionOrder(provider, candidates, pick)
    if (ordered.length === 0) return null
    const selected = await this.resolveFirstUsable(provider, ordered)
    // 选中的是**轮转序**里的某一个时，把游标推进到它的下一项（下次请求从下一个开始）。
    // 顺序档与最高优先档不维护游标 —— 它们的「下一个」不由上次选中决定。
    if (selected !== null && pick !== undefined) {
      await this.advanceCursorIfNeeded(provider, selected.entry.id, pick)
    }
    return selected
  }

  /**
   * 按配置的档位重排候选（消耗顺序 + 切换粒度）。
   *
   * 四步，顺序不可调换：
   * 1. **轮次锁**命中 → 直接返回那一个（只锁**已启用且通过限流过滤**的账号：
   *    锁里的账号可能已被停用/删除/限流，那种情况必须重新选，见第 4 步）；
   * 2. **顺序档** → 原样返回（历史行为）；
   * 3. **遍历档** → 按游标轮转；**最高优先档** → 按余额降序（余额未知即原样，
   *    等价降级回顺序）；
   * 4. 选完（并在调用方解析出真正可用的账号后）登记/更新轮次锁。
   */
  private applyConsumptionOrder(
    provider: string,
    candidates: readonly ProviderAccountEntry[],
    pick: { turnKey?: string },
  ): readonly ProviderAccountEntry[] {
    const setting = this.consumptionSetting(provider)
    const turnKey = pick.turnKey
    // ① 轮次锁：`per-turn` 档 + 有轮次键时，同轮恒用同一个账号。
    //
    // ⚠️ 锁里的账号必须**仍在本次候选里**才算命中。候选已经过 `enabled` 与
    // 逐模型限流过滤，因此「锁住的账号刚被停用 / 刚触发限流」时这里自然落空，
    // 走下面的重新选号并把锁改写到新账号上 —— 这正是需求里「锁要自愈」那条，
    // 而且不需要任何额外的失效判定。
    if (setting.switch === 'per-turn' && turnKey !== undefined && turnKey.length > 0) {
      const locked = this.turnLocks.get(`${provider}\u0000${turnKey}`)
      if (locked !== undefined) {
        const found = candidates.find(entry => entry.id === locked)
        if (found !== undefined) return [found]
      }
    }
    // ② 顺序档：原样返回（永远取排序第一个可用账号）。
    if (setting.order === 'sequential') return candidates
    // ③ 遍历档（**默认档**）：把「下一个该用的」提到首位。
    if (setting.order === 'round-robin') {
      return rotateToCursor(candidates, this.cursorCache[provider])
    }
    // ④ 最高优先档：余额降序。余额全未知时 `orderByBalance` 原样返回 →
    //    自动降级为顺序档（需求明示的降级，且不许抛错）。
    return orderByBalance(candidates, this.balances.snapshot(provider, Date.now()))
  }

  /**
   * 从（可能已被重排的）候选里解析出**第一个凭据可用**的账号。
   *
   * 与改动前的循环逐行等价，唯一区别是输入数组可能已被重排 —— 因此「跳过
   * 凭据未配置 / 损坏的账号」这条既有语义完整保留（遍历档下它会顺延到下一个）。
   */
  private async resolveFirstUsable(
    provider: string,
    candidates: readonly ProviderAccountEntry[],
  ): Promise<{ entry: ProviderAccountEntry; credential: CodeArtsCredential | BuddyCredential } | null> {
    const failures: string[] = []
    for (const entry of candidates) {
      let resolved
      try {
        resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      } catch (error) {
        failures.push(`${entry.id}: 读取凭据失败 (${String(error)})`)
        continue
      }
      if (!resolved) {
        failures.push(`${entry.id}: 凭据未配置`)
        continue
      }
      try {
        const credential = JSON.parse(resolved.value) as CodeArtsCredential | BuddyCredential
        if (failures.length > 0) {
          this.ctx.logger?.warn?.(
            `[account-hub] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
          )
        }
        return { entry, credential }
      } catch (error) {
        failures.push(`${entry.id}: 凭据 JSON 损坏 (${String(error)})`)
        continue
      }
    }
    if (failures.length > 0) {
      this.ctx.logger?.warn?.(
        `[account-hub] 没有可用的 ${provider} 账号：${failures.join('; ')}`,
      )
    }
    return null
  }

  /**
   * 选号收尾：推进遍历游标、登记轮次锁。
   *
   * ## 为什么两件事都在这里（而不是在 `applyConsumptionOrder` 里）
   *
   * 它们都需要**最终真的被选中的那个账号**，而那只在凭据解析成功之后才知道
   * （重排后的首位可能凭据损坏、被顺延到下一个）。在这里做，锁与游标记的就是
   * 「本次实际用了谁」，不会出现「记了 A、实际用了 B」的分叉。
   */
  private async advanceCursorIfNeeded(
    provider: string,
    pickedId: string,
    pick: { turnKey?: string },
  ): Promise<void> {
    const setting = this.consumptionSetting(provider)
    // 轮次锁：登记/改写本次实际选中的账号。`per-request` 档**不写锁**，
    // 免得一份永不被读的锁把真正开着的会话挤出 LRU。
    const turnKey = pick.turnKey
    if (setting.switch === 'per-turn' && turnKey !== undefined && turnKey.length > 0) {
      this.turnLocks.set(`${provider}\u0000${turnKey}`, pickedId)
    }
    if (setting.order !== 'round-robin') return
    // 游标取「候选里选中项的下一项」。用**未重排**的原始候选算 —— 重排后的
    // 数组里选中项恒在首位，取它的下一项会退化成「第二个账号」而非「下一个轮到的」。
    const ordered = this.readAccounts().filter(a => a.provider === provider && a.enabled)
    const next = nextCursorAfter(ordered, pickedId)
    if (next === undefined) return
    try {
      await this.writeConsumptionCursor(provider, next)
    } catch (error) {
      // 游标写失败（存储只读 / 落盘异常）**绝不能让请求失败**：它只是一个
      // 「下次从谁开始」的提示，这一轮的凭据已经选好了。下次请求回落数组顺序即可。
      this.ctx.logger?.warn?.(`[account-hub] ${provider} 遍历游标未持久化（不影响本次请求）：${String(error)}`)
    }
  }

  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
   * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
   * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
   * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
   */
  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[account-hub] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx] }
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[account-hub] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`,
    )
  }

  /** 清理已过期的重置时间记录 */
  async sweepExpiredRateLimits(): Promise<void> {
    const accounts = this.readAccounts()
    let changed = false
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry
      const limits = { ...entry.modelRateLimits }
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId]
          changed = true
        }
      }
      return { ...entry, modelRateLimits: limits }
    })
    if (changed) await this.writeAccounts(next)
  }
}

/**
 * 计算「今天」的**本地时区纪元日数**。
 *
 * 口径：取 `new Date(...)` 的**本地年月日**（`getFullYear()` / `getMonth()` /
 * `getDate()`），再换算成 epoch day（`Date.UTC(y,m,d) / 86400000`）。
 *
 * ⚠️ **签到域已不再用它判「今天签过没」**（2026-09-24 起改用「下一次可签时刻」
 * 毫秒时间戳，见 `src/checkin-schedule.ts`）。它仍然有两个在用的消费者：
 * 1. 旧 dayNumber → 新时间戳的**迁移**（`migrateLegacyCheckinDay` 的换算基准）；
 * 2. `checkins` 的键之外、按自然日表达的历史语义（如既有测试基线）。
 * 新代码**不要**再拿它做签到判定。
 *
 * ⚠️ 不要用 `getUTCDay`，也不用时间戳毫秒数 —— 跨时区 / 跨日边界都会乱。时区切换、
 * 夏令时的偏移只在**这一处**收敛，存的值本身不依赖「今天」。
 *
 * @param now - 要换算的时刻；缺省为当前时间（便于测试注入固定时刻）。
 */
export function todayDayNumber(now: Date = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000)
}

/**
 * 清理某个 provider 的**孤儿签到键**（兜底，供设置页打开面板时调用）。
 *
 * 直接委托给 {@link AccountPool.pruneOrphanCheckins}。以自由函数形态导出，
 * 便于面板调用方不持有 pool 类型也能直接复用（见设计文档 §孤儿清理策略）。
 *
 * @param pool - AccountPool（读账号列表与写 checkins 的唯一入口）。
 * @param provider - provider id。
 */
export async function pruneOrphanCheckins(pool: AccountPool, provider: string): Promise<void> {
  await pool.pruneOrphanCheckins(provider)
}

/**
 * `listModels` 的目录门控：**该 provider 是否应在模型目录中展示**。
 *
 * ## 需求来源
 *
 * 「如果某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对大多数
 * 用户来说模型选择选项卡臃肿的问题能改善很多。」
 *
 * ## 为什么可行：DSH 原生支持「空目录即隐藏」
 *
 * `packages/api/session-controller/src/catalog.ts` 的 `buildModelCatalog` 显式做了
 * `.filter(group => group.models.length > 0)`（注释：*"successful non-empty
 * provider groups"*）。因此适配器返回 `[]` 就能让整个 provider 分组从模型选择器
 * 中消失 —— **无需任何前端改动**。
 *
 * ⚠️ **必须返回空数组，不能抛错**：`buildModelCatalog` 的 `catch` 会把抛错归入
 * `failures`，界面上会多出一条 provider 报错，比「不显示」更糟。
 *
 * ⚠️ **不影响路由**：`catalog.routableProviders` 由 `listProviders()` 单独生成
 * （不经过该 filter），且 DSH 明确约定 *"Catalog membership is advisory and never
 * changes routing"* —— 隐藏目录不等于拒绝请求，已持久化的模型仍能 `resolveModel`
 * / 正常收发。
 *
 * ## 判定语义
 *
 * - **默认开启**（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 可关）：与
 *   `DSH_TRAE_MAX_MODE` 同为「默认开、显式假值才关」的语义，故单列一个解析
 *   函数，**不要与「默认关」的解析混用**。
 * - `accountPool` 缺失（headless / CLI / 单测）或替身未实现
 *   `hasLoggedInAccount` 时**视为可见** —— 门控是**展示优化而非安全边界**，
 *   判定不可用时宁多勿少（否则会让整个 provider 的模型凭空消失且无从排查）。
 * - 读凭据抛异常（存储损坏等）时同样**保守展示**。
 * - `extraCredentialRefs` 承载本仓的**单凭据路径**（见
 *   {@link AccountPool.hasLoggedInAccount} 的说明），仅 CodeArts 需要。
 *
 * @param accountPool - 适配器的账号池（可能为 undefined）。
 * @param provider - provider id。
 * @param extraCredentialRefs - 额外的单凭据 ref（CodeArts 的单凭据回退）。
 */
export async function providerCatalogVisible(
  accountPool: AccountPool | undefined,
  provider: string,
  extraCredentialRefs?: readonly string[],
): Promise<boolean> {
  if (!resolveHideWithoutAccountFlag(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT)) return true
  if (accountPool === undefined) return true
  // 能力检测：单测替身通常只 mock 了 disabledModelsFor 等少量方法。
  if (typeof accountPool.hasLoggedInAccount !== 'function') return true
  try {
    return await accountPool.hasLoggedInAccount(provider, extraCredentialRefs)
  } catch {
    // 读凭据异常（存储损坏等）时保守展示：宁可多显示，也不要让用户因为一次
    // 读取抖动而「所有模型都不见了」且无从排查。
    return true
  }
}

/**
 * 解析 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与「默认关」的 flag 解析
 * 语义相反，故单列一个函数，**不要混用**。
 */
function resolveHideWithoutAccountFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}
