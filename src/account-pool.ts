import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
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
  }
}

/** Account Hub schema namespace（必须在 ctx.settings 中注册后才能读写） */
export const JET_HUB_NS = 'jet-hub'

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
 * 由 `model.setContextBudget` 校验后写入（见 `src/jet-hub-rpc.ts`），适配器读取时
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
interface JetHubSettingsValue {
  accounts?: ProviderAccountEntry[]
  /** 模型黑名单（见 {@link ModelDisableMap}）。 */
  disabledModels?: ModelDisableMap
  /** 逐模型上下文窗口预算（见 {@link ContextBudgetMap}）。 */
  contextBudgets?: ContextBudgetMap
  /** 数据版本号，供一次性迁移 short-circuit（见 provider-rename-migration.ts）。 */
  schemaVersion?: number
}

/**
 * 当前数据版本号。
 *
 * - `0`（或字段缺失）= 旧命名：provider 为 `buddy`（中国版）/ `workbuddy`（国际版）；
 * - `1` = 新命名（`buddy-cn` / `buddy`），已由
 *   `src/provider-rename-migration.ts` 迁移完毕。
 *
 * 迁移函数在版本号 ≥1 时整体 short-circuit，因此这个数字只会前进。
 */
export const JET_HUB_SCHEMA_VERSION = 1

/** ctx.settings.register() 返回的 owner scope（只用到 get/replace）。 */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
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
const jetHubSchema = Schema.object({
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
  // 数据版本号。`0` = 旧命名（buddy=中国版 / workbuddy=国际版）尚未迁移；
  // 见 {@link JET_HUB_SCHEMA_VERSION}。**必须带 default**：老配置文件里没有
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
 * - 账号列表 CRUD（索引存于 ctx.settings namespace jet-hub
 *   → 配置文件，凭据存于 ctx.credentials，各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * 注意：DSH 的 settings 服务要求 namespace 先注册再读写，
 * 因此构造时调用 ctx.settings.register(JET_HUB_NS, schema)。
 * 注册失败（服务缺失）时退化为内存态，保证不抛错。
 */
export class AccountPool {
  /** 已注册的 settings scope；未注册成功时为 undefined。 */
  private scope: SettingsScopeLike | undefined
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接依赖 `scope.get()`：settings 服务的 resolved 快照在 replace() 后
   * 未必立即更新，而本类的每次写入都是「读 → 改 → 整体 replace」。
   * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
   * （典型表现：多个账号触发限流后，settings.yaml 里一条 modelRateLimits
   * 都没有）。因此首次从 scope 载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：settings 的
   * resolved 快照在 replace() 后未必立即更新，因此加载一次后即以本副本为准）。
   */
  private modelCache: ModelDisableMap = {}
  /**
   * 逐模型上下文窗口预算的**权威进程内副本**（同 {@link cache} / {@link modelCache}）。
   *
   * ⚠️ 它与账号、黑名单、版本号是**同一个 namespace 的四件套**：任何一次写入都是
   * 整体 replace，四者必须互相携带，漏一个就会在下次别的写入里被清空。
   */
  private budgetCache: ContextBudgetMap = {}
  /**
   * 数据版本号的**权威进程内副本**（同 {@link cache} / {@link modelCache}）。
   *
   * 一次性迁移（provider 改名）靠它 short-circuit，因此它必须与账号、黑名单
   * 一起参与「读 → 改 → 整体 replace」，漏带就会在下次写入时被重置为 0，
   * 让迁移在每次启动时重跑。
   */
  private versionCache = 0
  /** 是否已从 settings scope 完成首次载入。 */
  private loaded = false

  constructor(private readonly ctx: Context) {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (!settings || typeof settings.register !== 'function') {
      this.ctx.logger?.warn?.('[jet-hub] settings 服务不可用，账号列表仅存在于内存中')
      return
    }
    try {
      this.scope = settings.register(JET_HUB_NS, jetHubSchema)
    } catch (error) {
      // 重复注册（如插件热重载）时降级为内存态。
      this.ctx.logger?.warn?.(`[jet-hub] settings namespace 注册失败，降级运行: ${String(error)}`)
    }
  }

  /** 首次访问时从 settings scope 载入账号列表。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.scope) return
    const value = this.scope.get() as JetHubSettingsValue | undefined
    const accounts = value?.accounts
    if (Array.isArray(accounts)) {
      this.cache = accounts as ProviderAccountEntry[]
    } else {
      this.ctx.logger?.warn?.(
        `[jet-hub] 账号列表首次载入为空（scope 返回 ${JSON.stringify(value)}）`,
      )
    }
    // 黑名单是后来才加入的字段：老配置文件里没有它，缺失时保持空表
    // （等价于"全部模型默认打开"），而不是报错或让整次载入失败。
    this.modelCache = sanitizeDisabledModels(value?.disabledModels)
    // 上下文窗口预算同理（比黑名单更晚加入）：缺失时保持空表，
    // 等价于"全部模型用默认档"。
    this.budgetCache = sanitizeContextBudgets(value?.contextBudgets)
    // 版本号同理：老配置文件（或首次安装）没有该字段 → 按 0 处理，
    // 即「迁移尚未执行」。
    const version = value?.schemaVersion
    this.versionCache = typeof version === 'number' && Number.isFinite(version) ? version : 0
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 数据版本号（0 = 旧命名尚未迁移，见 {@link JET_HUB_SCHEMA_VERSION}）。
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
   * 一次性整体写入账号列表、模型黑名单与上下文预算（外加版本号）。
   *
   * 为什么需要它：{@link writeAccounts} / {@link writeModels} 各自只接受
   * 自己那一半，调用方要先写一半再写另一半，中间崩溃会留下半迁移状态。
   * 一次性迁移必须**原子**地落盘「账号 + 黑名单 + 上下文预算 + 版本号」四件套，
   * 故这里直接构造完整的 replace 载荷，只发一次写。
   *
   * ⚠️ **上下文预算原样带上**（不是本次迁移的对象，但同属一个 namespace）：
   * 漏带会让改名迁移顺手清空用户的窗口档位选择。
   *
   * @param accounts - 新的账号列表。
   * @param disabledModels - 新的模型黑名单。
   * @param schemaVersion - 迁移完成后的版本号。
   */
  async replaceAll(
    accounts: ProviderAccountEntry[],
    disabledModels: ModelDisableMap,
    schemaVersion: number = JET_HUB_SCHEMA_VERSION,
  ): Promise<void> {
    // ⚠️ 必须先 ensureLoaded()：本方法只从调用方接收三件套，**上下文预算取自进程内
    // 副本**（它不是迁移对象）。没载入就写，会把用户已有的档位选择覆盖成空。
    // 同 `setModelDisabled` / `writeContextBudget` 的那条陷阱。
    this.ensureLoaded()
    this.cache = accounts
    this.modelCache = disabledModels
    this.versionCache = schemaVersion
    this.loaded = true
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，数据迁移结果未持久化')
      return
    }
    await this.scope.replace({
      accounts,
      disabledModels,
      contextBudgets: this.budgetCache,
      schemaVersion,
    })
  }

  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单、上下文预算与版本号一起写回**：settings 的 `replace()` 是整体替换，
   * 只写 `{ accounts }` 会把同一 namespace 下的 `disabledModels` 与 `contextBudgets`
   * 抹掉，`schemaVersion` 同理会被重置为 0（于是改名迁移会在每次启动时重跑）。
   */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    this.cache = accounts
    this.loaded = true
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，账号变更未持久化')
      return
    }
    await this.scope.replace({
      accounts,
      disabledModels: this.modelCache,
      contextBudgets: this.budgetCache,
      schemaVersion: this.versionCache,
    })
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
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，模型黑名单变更未持久化')
      return
    }
    // 与 writeAccounts 对称：整体 replace 必须携带账号列表、上下文预算与版本号，否则会被清空。
    await this.scope.replace({
      accounts: this.cache,
      disabledModels,
      contextBudgets: this.budgetCache,
      schemaVersion: this.versionCache,
    })
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
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，上下文窗口预算变更未持久化')
      return
    }
    // 与 writeAccounts / writeModels 对称：整体 replace 必须携带另外三件套，否则会被清空。
    await this.scope.replace({
      accounts: this.cache,
      disabledModels: this.modelCache,
      contextBudgets,
      schemaVersion: this.versionCache,
    })
  }

  /** 列出某个 provider 的所有账号（含状态信息） */
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
   * 清理「凭据域名与当前产品配置不符」的账号。
   *
   * 用途：国际版 provider（`buddy`，www.workbuddy.ai）早年是中国版实现
   * （copilot.tencent.com），改造后旧账号存的仍是中国版凭据 —— 它们的
   * `token.domain` 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   * 这类条目已无修复价值，直接删除，让用户在 Account Hub 重新登录。
   *
   * 判据是**凭据里记录的 domain 与产品配置的 apiDomain 不一致**（而不是简单按
   * provider 名删），这样只清理真正失配的条目，不会误删已在新端点登录的账号。
   *
   * @returns 被删除的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(product: BuddyProduct): Promise<string[]> {
    const removed: string[] = []
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue
      let domain = ''
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined) continue
        const parsed = JSON.parse(resolved.value) as { domain?: unknown }
        domain = typeof parsed.domain === 'string' ? parsed.domain : ''
      } catch {
        // 凭据缺失或损坏：留给「凭据未配置」的正常报错路径处理，这里不删
        continue
      }
      // domain 为空表示历史凭据未记录域名，无法判定，保守保留。
      if (domain.length === 0) continue
      if (domain !== product.apiDomain) {
        await this.removeAccount(entry.id)
        removed.push(entry.id)
      }
    }
    return removed
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

  /** 删除账号（同时清理凭据） */
  async removeAccount(id: string): Promise<void> {
    const accounts = this.readAccounts()
    const entry = accounts.find(a => a.id === id)
    if (!entry) return
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef))
    } catch { /* 凭据可能已被删除 */ }
    await this.writeAccounts(accounts.filter(a => a.id !== id))
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
      `[jet-hub] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
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
   * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
   * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   */
  async getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
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
    // 优先选择无限制或限制最早到期的
    candidates.sort((a, b) => {
      const ra = a.modelRateLimits?.[modelId] ?? 0
      const rb = b.modelRateLimits?.[modelId] ?? 0
      return ra - rb
    })
    // 逐个尝试解析凭据，跳过占位/损坏条目（并记录原因，避免静默失败）
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
            `[jet-hub] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
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
        `[jet-hub] 没有可用的 ${provider} 账号：${failures.join('; ')}`,
      )
    }
    return null
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
        `[jet-hub] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx] }
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`,
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
