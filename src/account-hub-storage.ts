/**
 * 账号池的 **storage 域持久层**（`ctx.storage.domain`）。
 *
 * ## 为什么从 `ctx.settings` 搬到这里
 *
 * 0.1.6 的账号索引存在 settings namespace `jet-hub` 里（`~/.dsh/settings.yaml`）。
 * 0.1.7 把 `ctx.settings.register(ns, schema) → owner scope` 整套 seam **删除**了，
 * 换成「插件读自己 Config 的 volatile 字段 + 用 `ctx.configEditor.edit()` 写」——
 * 插件在新版下走优雅降级分支，于是**不抛错、静默全空**，用户看到「所有账号消失」。
 *
 * 更根本的是语义：账号列表是**动态数据**（会增删、含限流时间戳），塞进 profile 的
 * `cordis.patch.yml` 属于把「数据」写成「配置」。storage 域才是给动态数据的正规落点，
 * 且三件套（`dsh-storage` / `dsh-storage-json` root=`dshHomePath('storages')` /
 * `dsh-storage-domain`）在 0.1.6 与 0.1.7 的 base patch 里**逐字一致**，两版通吃。
 *
 * ## 布局选型：single 布局 + 一个 global 单例文档
 *
 * 账号池的数据量小（十几个账号）且**整体读写**（见 `AccountPool` 的五件套互带），
 * 用 `per-record` 表反而要把「一次原子的整体替换」拆成多次记录写入。故域声明里
 * **不声明任何表**，只用一个 global 单例文档承接五件套 —— 一次 `set` 就是一次整体落盘，
 * 落盘形态是 `$DSH_HOME/storages/<域>.json`。
 *
 * ## 域名为什么带下划线
 *
 * storage 后端在 `open` 时按 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 校验域名，
 * 不匹配直接以 `malformed-medium` 拒绝。插件 id 是 `dsh-account-hub`（带连字符），
 * 而**连字符不是合法域名字符**，故域名为 `dsh_account_hub` —— 两者刻意不是同一个字符串，
 * 不要为了「统一」把连字符塞进来。
 *
 * @module dsh-account-hub/account-hub-storage
 */

import type { Context } from '@deepseek-ai/cordis'
import { sanitizeConsumption, sanitizeConsumptionCursors } from './account-consumption.js'
import type { ConsumptionCursorMap, ConsumptionMap } from './account-consumption.js'
import { normalizeCheckinValue } from './checkin-schedule.js'
import type { ProviderAccountEntry } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** storage 域数据形态（由 `@deepseek-ai/dsh-storage-domain` 注入）。 */
    storageDomain?: DomainFacilityLike
  }
}

/**
 * `ctx.effect` 的最小形状（登记域的生命周期清理）。
 *
 * 声明成可选是为了让「极简 ctx / 测试替身」仍能构造本模块 —— 拿不到 effect
 * 服务时退化为不登记 disposer（见 {@link openAccountHubStorage}）。
 */
interface EffectContextLike {
  effect?(execute: () => () => unknown, label?: string): unknown
}

/**
 * storage 域名。**必须匹配 `UNIT_NAME_RE`**（见模块头「域名为什么带下划线」）。
 *
 * 落盘路径：`$DSH_HOME/storages/dsh_account_hub.json`。
 */
export const ACCOUNT_HUB_DOMAIN = 'dsh_account_hub'

/**
 * 域格式版本号。
 *
 * 与 {@link AccountHubDocument.schemaVersion} **不是一回事**，不要合并：
 * - 本常量是 storage 后端校验的**文件格式版本**，改结构时提升，后端按它拒绝旧文件；
 * - `schemaVersion` 是**业务数据版本**（provider 改名迁移的一次性闸门），存在文档内部。
 */
export const ACCOUNT_HUB_DOMAIN_VERSION = 1

/** 模型黑名单：provider id → **被关闭**的模型 id → true。 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/** 逐模型的上下文窗口预算：provider id → 模型 id → token 数。 */
export type ContextBudgetMap = Record<string, Record<string, number>>

/**
 * 自动签到记录：`provider:accountId` → **下一次可签时刻（毫秒时间戳）**。
 *
 * - 键格式 `${provider}:${accountId}`（accountId 已含 provider 前缀，但显式带
 *   provider 让键自解释、且孤儿清理时可按 provider 前缀批量删，**也是旧值迁移时
 *   查重置钟点的依据**）。
 * - 值 = 「下一次可签」的**本地时间**毫秒时间戳。判定退化为一次比较：
 *   `Date.now() < 值` = 已签（等窗口翻页）、`>= 值` = 可签。
 * - 不在表里的键 = 从未签过（读不到即「可签」）。
 *
 * ## ⚠️ 值口径已经变过一次（旧数据仍是纪元日数）
 *
 * 旧口径是「本地纪元日数」（`checkinDay === today` 判已签），**它隐含所有
 * provider 都在本地零点重置**；`qoder-cn` 实测在**本地 10 点**才翻页，用日数
 * 表达会在窗口边界两侧各错一次（详见 `src/checkin-schedule.ts` 的模块头）。
 *
 * 旧值**不会被读成新值**：两个口径差约 7 个数量级，`sanitizeCheckins` 按
 * `LEGACY_DAY_NUMBER_MAX` 分流并把旧值就地换成新口径（`dayNumber` → 次日重置点）。
 * 因此本类型的**运行时值恒为新口径**，迁移只发生在读盘那一层。
 */
export type CheckinsMap = Record<string, number>

/**
 * 账号**消耗顺序 / 切换粒度**与**遍历游标**的类型。
 *
 * 语义与取值域见 `src/account-consumption.ts`（唯一真相源）—— 这里**重导出**它的
 * 类型而不是另写一份同形接口：两份定义一旦漂移，落盘形态与选号读取的形态就会
 * 静默错位（存了却永远不生效）。等于默认值的条目不留，因此文件里出现的键一定是
 * 用户真的改过的。旧文档（无这两个字段）读入时补空对象。
 */
export type { ConsumptionCursorMap, ConsumptionMap } from './account-consumption.js'

/**
 * storage 里那份单例文档的结构。
 *
 * ⚠️ **七件套是一个整体**：`AccountPool` 的每次写入都是「读 → 改 → 整体 replace」，
 * 漏带任何一个字段就会在下次别的写入里被清空（`schemaVersion` 丢失会让改名迁移
 * 在每次启动重跑）。前五件与旧 settings namespace 里的字段**逐字段对应**，
 * 迁移就是原样搬运；末两件是「消耗顺序 / 切换粒度」带来的新字段。
 */
export interface AccountHubDocument {
  accounts: ProviderAccountEntry[]
  disabledModels: ModelDisableMap
  contextBudgets: ContextBudgetMap
  checkins: CheckinsMap
  /** 消耗顺序 / 切换粒度（见 {@link ConsumptionMap}）。 */
  consumption: ConsumptionMap
  /** 遍历游标（见 {@link ConsumptionCursorMap}）。 */
  consumptionCursors: ConsumptionCursorMap
  schemaVersion: number
}

/** 空文档。每次都返回新对象 —— 共享引用会被写入方就地改坏。 */
export function emptyAccountHubDocument(): AccountHubDocument {
  return {
    accounts: [],
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    consumption: {},
    consumptionCursors: {},
    schemaVersion: 0,
  }
}

/** 把任意外部值归一化为黑名单（同既有 `sanitizeDisabledModels` 的口径）。 */
function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      // 只把显式 true 视为「关闭」；false 既不隐藏也不写回，避免判定与磁盘内容分歧。
      if (flag === true) perProvider[modelId] = true
    }
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/** 把任意外部值归一化为上下文预算（同既有 `sanitizeContextBudgets` 的口径）。 */
function sanitizeContextBudgets(raw: unknown): ContextBudgetMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ContextBudgetMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, number> = {}
    for (const [modelId, budget] of Object.entries(value as Record<string, unknown>)) {
      if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) perProvider[modelId] = budget
    }
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * 把任意外部值归一化为签到表（同既有 `sanitizeDisabledModels` 的口径）。
 *
 * ## 双口径读入（旧 dayNumber 就地迁移）
 *
 * 值可能是两种口径：**旧**的本地纪元日数（几百到五位数）与**新**的下一次可签
 * 毫秒时间戳（十三位）。两者差约 7 个数量级，故按 `LEGACY_DAY_NUMBER_MAX`
 * 分流：小值按旧口径换算成新口径（见 `migrateLegacyCheckinDay`），大值原样保留。
 *
 * ⚠️ **provider 从键里解出来**（`provider:accountId`，按**第一个**冒号切）：
 * 换算要按该 provider 的重置钟点算，而钟点对 `qoder-cn` 与其余五家不同。
 * 键里没有冒号（外部手写的脏键）时按缺省钟点 0 处理 —— 不为了一个畸形键
 * 抛错，也不丢掉它（它仍是一个合法的 `provider:accountId` 之外的字符串，
 * 孤儿清理会按前缀规则处理）。
 *
 * ⚠️ **只在读盘这一层迁移**：返回的表是新口径，调用方（`AccountPool`）拿到后
 * 若发生写入，落盘的自然是新口径；若一直不写，下次启动重跑一次同样的迁移
 * —— 换算纯函数、幂等（新口径值不会再落入小值区间）。
 */
export function sanitizeCheckins(raw: unknown): CheckinsMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: CheckinsMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeCheckinValue(value, providerOfCheckinKey(key))
    // 脏值（字符串 / NaN / 小数 / 非法结构）一律丢弃，不抛错。
    if (normalized === undefined) continue
    result[key] = normalized
  }
  return result
}

/**
 * 从 `checkins` 的键解出 provider（换算重置钟点用）。
 *
 * 按**第一个**冒号切：accountId 自身可能含冒号（外部手写的键），而 provider id
 * 的形态里没有冒号。无冒号时返回空串 —— `checkinResetHour('')` 落到缺省的 0。
 */
function providerOfCheckinKey(key: string): string {
  const index = key.indexOf(':')
  return index <= 0 ? '' : key.slice(0, index)
}

/**
 * 把任意外部值归一化为 {@link AccountHubDocument}。
 *
 * 存储文件可能被手工编辑过，也可能残留旧格式，因此逐层校验：任何一层形状不符就
 * 丢弃那一层，**不抛错** —— 存储被外部改坏不该让整个账号管理功能不可用
 * （既有 settings 路径的 `sanitizeDisabledModels` 同一取舍）。
 * 旧文档（无 `checkins` / `consumption` / `consumptionCursors` 字段）读入时补空对象。
 */
export function sanitizeAccountHubDocument(raw: unknown): AccountHubDocument {
  const empty = emptyAccountHubDocument()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty
  const value = raw as Record<string, unknown>
  const accounts = Array.isArray(value.accounts)
    ? (value.accounts as ProviderAccountEntry[])
    : empty.accounts
  const version = value.schemaVersion
  return {
    accounts,
    disabledModels: sanitizeDisabledModels(value.disabledModels),
    contextBudgets: sanitizeContextBudgets(value.contextBudgets),
    checkins: sanitizeCheckins(value.checkins),
    consumption: sanitizeConsumption(value.consumption),
    consumptionCursors: sanitizeConsumptionCursors(value.consumptionCursors),
    schemaVersion: typeof version === 'number' && Number.isFinite(version) ? version : 0,
  }
}

/** 文档的深拷贝（全是 JSON 值，结构化往返即可）。 */
function cloneDocument(doc: AccountHubDocument): AccountHubDocument {
  return JSON.parse(JSON.stringify(doc)) as AccountHubDocument
}

/**
 * 域声明里 global 的 schema 形状。
 *
 * ⚠️ **刻意不引 zod**：本插件不是 DSH 本体，仓库里没有（也不该为这个功能引入）
 * zod 依赖。storage 域只用到 schema 的两件事 —— `safeParse(null)` 必须失败
 * （`defineDomain` 用它证明「null 哨兵不会与合法值混淆」），以及每次读取时 `parse()`。
 * 故这里提供一个**最小结构实现**：只拒绝 null（存储的「从未写过」哨兵），
 * 其余一律归一化 —— 与 {@link sanitizeAccountHubDocument} 同口径，脏数据不抛错。
 */
const accountHubGlobalSchema = {
  safeParse(value: unknown): { success: boolean; data?: AccountHubDocument } {
    if (value === null || value === undefined) return { success: false }
    return { success: true, data: sanitizeAccountHubDocument(value) }
  },
  parse(value: unknown): AccountHubDocument {
    if (value === null || value === undefined) {
      throw new Error('account hub global is the never-written sentinel')
    }
    return sanitizeAccountHubDocument(value)
  },
  toJSON(): unknown {
    return { type: 'object' }
  },
}

/** `ctx.storageDomain.open()` 返回的域句柄（只用到 global 单例）。 */
interface DomainGlobalLike {
  get(): unknown
  set(value: unknown): Promise<void>
}

interface OpenedDomainLike {
  global: DomainGlobalLike
  close?(): Promise<void>
}

/**
 * `ctx.storageDomain` 服务的最小接口。
 *
 * 与 `ctx.settings` 的处理方式一致：**结构化最小接口而不是 import 依赖包**
 * （插件通过 peer 依赖在宿主里解析服务，不把 storage 包变成自己的依赖）。
 */
export interface DomainFacilityLike {
  open(spec: unknown): Promise<OpenedDomainLike>
}

/** 已打开的账号池 storage 句柄。 */
export interface AccountHubStorage {
  /** 当前域句柄（供诊断 / 关闭）。 */
  readonly domain: OpenedDomainLike
  /** 同步读取归一化后的文档（读自 storage 域的权威内存态）。 */
  read(): AccountHubDocument
  /** 整体写入七件套；落盘失败时向调用方抛出。 */
  write(doc: AccountHubDocument): Promise<void>
  /** 存储里是否已有账号数据（一次性迁移的幂等闸门）。 */
  hasAccounts(): boolean
}

/**
 * 打开账号池的 storage 域。
 *
 * **运行时探测、缺席即静默降级**：storage 服务不存在、形状不对、或 `open()` 抛错
 * （后端未注册 / 文件损坏 / 版本不符）时一律返回 `undefined` 并记一条 warn，
 * 交给调用方回退旧 settings 路径 —— 绝不抛错、绝不阻断插件启动。
 *
 * @param ctx - 宿主上下文（只用到 `storageDomain` 与 `logger`）。
 * @returns 已打开的 storage 句柄；不可用时 `undefined`。
 */
export async function openAccountHubStorage(ctx: Context): Promise<AccountHubStorage | undefined> {
  const facility = ctx.get('storageDomain') as DomainFacilityLike | undefined
  if (!facility || typeof facility.open !== 'function') {
    ctx.logger?.warn?.(
      '[account-hub] storage 服务不可用，账号池回退旧 settings 路径',
    )
    return undefined
  }
  let domain: OpenedDomainLike
  try {
    domain = await facility.open({
      name: ACCOUNT_HUB_DOMAIN,
      version: ACCOUNT_HUB_DOMAIN_VERSION,
      // single 布局 + 无表 + 一个 global：账号池是「一个文档整体读写」。
      global: { schema: accountHubGlobalSchema, initial: emptyAccountHubDocument() },
      tables: {},
    })
  } catch (error) {
    ctx.logger?.warn?.(`[account-hub] storage 域打开失败，账号池回退旧 settings 路径: ${String(error)}`)
    return undefined
  }

  // ⚠️ **必须注册关闭 disposer**：domain facility 按域名做**单开**约束
  // （同名域第二次 `open` 直接以 `already-open` 拒绝）。不注册就等于把域名
  // 永久占住 —— 插件重载、或同进程内任何一次重新接管都会再也打不开这个域。
  // 这是 DSH 本体的既有约定（`ctx.effect(() => () => domain.close(), '<name>.domainClose')`
  // 见 workspace / session-projection-cache 两处），照它写。
  try {
    ;(ctx as EffectContextLike).effect?.(() => () => domain.close?.(), 'accountHub.domainClose')
  } catch {
    // 登记失败（无 effect 服务 / fiber 非活跃）时退化为「不主动关闭」：
    // 域句柄仍可用，只是生命周期交给进程 —— 不能因为登记不上 disposer 就整个降级。
  }

  const read = (): AccountHubDocument => sanitizeAccountHubDocument(domain.global.get())

  return {
    domain,
    read,
    async write(doc: AccountHubDocument): Promise<void> {
      // 深拷贝后落盘：写入是异步的，调用方随后改自己的数组不该污染已提交的值。
      await domain.global.set(cloneDocument(doc))
    },
    hasAccounts(): boolean {
      return read().accounts.length > 0
    },
  }
}
