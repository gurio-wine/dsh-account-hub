/**
 * 一次性迁移：把账号池从旧 settings 位置搬进 storage 域。
 *
 * ## 为什么需要它
 *
 * 0.1.7 把 `ctx.settings.register(ns, schema) → owner scope` 整套 seam 删掉了，
 * 插件在新版下静默降级 ⇒ 账号列表为空。改用 storage 后，**已在旧位置存了数据的
 * 用户必须被自动搬过来**，否则升级等于账号凭空消失。
 *
 * ## 来源优先级（三选一，第一个「真的含可迁移数据」的胜出）
 *
 * 1. `$DSH_HOME/settings.yaml.imported` —— 0.1.7 那次启动把原 `settings.yaml`
 *    **无条件改名**留下的原件，是降级前最完整的快照；
 * 2. `$DSH_HOME/settings.yaml` —— 0.1.6 的现役位置（也是降级回去后继续被写的位置）；
 * 3. 旧 settings scope —— 回退路径下由 `AccountPool` 直接读（不经本模块）。
 *
 * ⚠️ **优先级判据是「节本身可迁移」，不是「文件存在」**：`.imported` 存在但没有
 * {@link LEGACY_SETTINGS_NAMESPACE} 段（或 `accounts` 为空）时继续往后看，否则
 * 一个空壳 `.imported` 会把真正有数据的 `settings.yaml` 挡住。
 *
 * ## 安全语义（逐条都有测试钉死）
 *
 * - **只读来源**：迁移不修改、不删除、不重命名任何来源文件（`settings.yaml` 与
 *   `.imported` 都原样留着，用户降级回 0.1.6 仍能正常用）。
 * - **幂等**：storage 里已有账号数据即整体跳过。空表（`accounts: []`）不算
 *   「已有数据」，故「来源无账号」时不会写一张空表把后续迁移闸门永久关上。
 * - **不半途覆盖**：只有落盘成功才算完成；读来源失败或写 storage 失败时返回
 *   `failed`，存储保持原样、进程内状态不变，下次启动可重试。
 * - **路径全部从传入的 home 解析**：不写死 `~`、不拼 `C:\Users\...`，
 *   调用方用 `dshHomePath()` 同源解析。
 *
 * @module dsh-account-hub/account-hub-migration
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeAccountHubDocument, type AccountHubDocument, type AccountHubStorage } from './account-hub-storage.js'
import { parseSimpleYamlSection, type YamlValue } from './simple-yaml.js'

/**
 * ⚠️ **历史兼容读取，勿改**。
 *
 * 这是 0.1.6 的 settings namespace，也是**历史数据真正所在的键**：
 * `settings.yaml` 与 `settings.yaml.imported` 里的账号数据都在它下面。
 * 改成新插件 id（`dsh-account-hub`）会让迁移在一台已有数据的机器上读到空段，
 * 用户看到「所有账号消失」。它只用于**读取**旧数据，新写入一律走 storage 域
 * （{@link ACCOUNT_HUB_DOMAIN}）。
 */
export const LEGACY_SETTINGS_NAMESPACE = 'jet-hub'

/** 旧 settings 位置的文件名（相对 `$DSH_HOME`）。 */
export const LEGACY_SETTINGS_FILE = 'settings.yaml'
/** 0.1.7 迁移留下的原件名（相对 `$DSH_HOME`）。 */
export const LEGACY_IMPORTED_FILE = 'settings.yaml.imported'

/** 从旧 settings 段里取出的可迁移数据。 */
export interface LegacyAccountHubSection {
  accounts: AccountHubDocument['accounts']
  disabledModels: AccountHubDocument['disabledModels']
  contextBudgets: AccountHubDocument['contextBudgets']
  /** 签到记录：旧版段里不存在，可选（缺失 = 迁移时补空表）。 */
  checkins?: AccountHubDocument['checkins']
  /** 消耗顺序 / 切换粒度：旧版段里不存在，可选（缺失 = 补空表 = 默认配置）。 */
  consumption?: AccountHubDocument['consumption']
  /** 遍历游标：同上，旧版段里不存在。 */
  consumptionCursors?: AccountHubDocument['consumptionCursors']
  schemaVersion: number
}

/** {@link findLegacyAccountHubSection} 的结果：节本身 + 它来自哪个文件。 */
export interface FoundLegacySection {
  origin: typeof LEGACY_SETTINGS_FILE | typeof LEGACY_IMPORTED_FILE
  path: string
  section: LegacyAccountHubSection
}

/**
 * 解析 settings YAML，**只取 {@link LEGACY_SETTINGS_NAMESPACE} 一节**。
 *
 * 返回归一化后的节（脏字段按 storage 同口径丢弃），其余顶层键一概不带出
 * —— 旧文件里还有别家的 API key 之类内容，迁移不该顺手把它们搬走。
 *
 * @param text - YAML 文本。
 * @returns 目标节；文档里没有该键时返回空对象。
 * @throws YAML 语法错或用到不支持的构造时抛出（调用方按「来源读不了」处理）。
 */
export function parseLegacySettingsYaml(text: string): Record<string, LegacyAccountHubSection> {
  const raw = parseSimpleYamlSection(text, LEGACY_SETTINGS_NAMESPACE)
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`settings 里的 ${LEGACY_SETTINGS_NAMESPACE} 段不是映射`)
  }
  const value = raw as Record<string, YamlValue>
  // 复用 storage 的归一化：来源与存储的字段口径必须**同源**，否则「搬过去」
  // 与「读回来」会得出不同的值（黑名单的 false、预算的 0 / 负数都属此类）。
  const sanitized = sanitizeAccountHubDocument({
    accounts: value.accounts,
    disabledModels: value.disabledModels,
    contextBudgets: value.contextBudgets,
    schemaVersion: value.schemaVersion,
  })
  return { [LEGACY_SETTINGS_NAMESPACE]: sanitized }
}

/** 节里是否有可迁移数据：`accounts` 非空数组才算（空表不落，见模块头「幂等」）。 */
function sectionHasAccounts(section: LegacyAccountHubSection): boolean {
  return section.accounts.length > 0
}

async function readSectionFile(path: string): Promise<LegacyAccountHubSection | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // ENOENT = 该来源不存在，正常往后看；其他 IO 错误同样按「这个来源不可用」处理，
    // 由调用方在全都读不到时判为 skipped-no-source（而非把启动搞崩）。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseLegacySettingsYaml(text)[LEGACY_SETTINGS_NAMESPACE]
}

/**
 * 按优先级找一个含可迁移数据的旧来源。
 *
 * @param home - 解析好的 `$DSH_HOME`（调用方用 `dshHomePath()` 同源解析后传入）。
 * @returns 命中的来源与节；都没有时 `undefined`。
 * @throws 命中的文件语法错时抛出 —— **不**降级为「没找到」：静默跳过会让用户
 *   的账号数据永远搬不过来，而报错只是本轮不迁移（来源文件一个字都没动）。
 */
export async function findLegacyAccountHubSection(home: string): Promise<FoundLegacySection | undefined> {
  for (const name of [LEGACY_IMPORTED_FILE, LEGACY_SETTINGS_FILE] as const) {
    const path = join(home, name)
    const section = await readSectionFile(path)
    if (section !== undefined && sectionHasAccounts(section)) {
      return { origin: name, path, section }
    }
  }
  return undefined
}

/** 迁移结局（供日志与测试断言）。 */
export type AccountHubMigrationOutcome =
  /** 已把旧数据写入 storage。 */
  | 'migrated'
  /** storage 里已有账号数据，整体跳过（幂等）。 */
  | 'skipped-storage-populated'
  /** 旧来源里没有可迁移的账号数据（含来源不存在），一张空表都不写。 */
  | 'skipped-no-source'
  /** 读取来源或写入 storage 失败；存储与内存均保持原状，下次启动可重试。 */
  | 'failed'

/** 迁移结果。 */
export interface AccountHubMigrationResult {
  outcome: AccountHubMigrationOutcome
  /** `outcome === 'migrated'` 时实际搬运的账号数。 */
  accountCount: number
  /** 来源文件名（`skipped-no-source` 时为 `undefined`）。 */
  origin?: string
  /** `outcome === 'failed'` 时的原因。 */
  error?: string
}

/** {@link migrateAccountHubIntoStorage} 的依赖（显式注入，便于测试替换 home）。 */
export interface AccountHubMigrationDeps {
  /** 已解析的 `$DSH_HOME`。 */
  home: string
  /** 已打开的 storage 句柄。 */
  storage: AccountHubStorage
  /**
   * 覆盖来源读取（回退路径下用于取旧 settings scope，而不是读文件）。
   * 省略时读 `$DSH_HOME` 下的两个文件。
   */
  readLegacySection?: () => Promise<LegacyAccountHubSection | undefined>
}

/**
 * 执行一次性迁移。
 *
 * **绝不抛出**：任何失败都收敛成 `outcome: 'failed'` + `error`，让调用方
 * 打一条 warn 后照常启动（账号池以 storage 的空表或旧路径继续工作）。
 *
 * @param deps - home、storage 句柄与可选的来源读取覆盖。
 * @returns 迁移结果。
 */
export async function migrateAccountHubIntoStorage(
  deps: AccountHubMigrationDeps,
): Promise<AccountHubMigrationResult> {
  // ① storage 已有数据 ⇒ 幂等跳过。放在最前面：既要避免重复搬运，也要避免在
  //    来源已被用户改坏时白跑一趟读取。
  if (deps.storage.hasAccounts()) {
    return { outcome: 'skipped-storage-populated', accountCount: 0 }
  }

  let found: FoundLegacySection | undefined
  try {
    if (deps.readLegacySection !== undefined) {
      const section = await deps.readLegacySection()
      if (section !== undefined) {
        found = { origin: 'settings.yaml', path: '(旧 settings scope)', section }
      }
    } else {
      found = await findLegacyAccountHubSection(deps.home)
    }
  } catch (error) {
    // 来源读不了（IO 错误 / YAML 语法错）⇒ 本轮不迁移，来源文件一个字都不动。
    return { outcome: 'failed', accountCount: 0, error: String(error) }
  }

  if (found === undefined || !sectionHasAccounts(found.section)) {
    return { outcome: 'skipped-no-source', accountCount: 0 }
  }

  const { section } = found
  const document: AccountHubDocument = {
    accounts: section.accounts,
    disabledModels: section.disabledModels,
    contextBudgets: section.contextBudgets,
    // 签到记录从 storage 全局文档首次迁移时**不存在**（旧 settings 没有该字段）
    // —— 补空表，与「旧文档读入补空对象」的口径一致。
    checkins: section.checkins ?? {},
    // 消耗顺序 / 遍历游标同理：旧 settings 时代不存在这两个字段，补空表
    // —— 等价于「顺序 + 按轮次」的默认配置，即迁移前的行为。
    consumption: section.consumption ?? {},
    consumptionCursors: section.consumptionCursors ?? {},
    schemaVersion: section.schemaVersion,
  }

  try {
    // ② 原子整体写：四件套一次落盘。写成功才算迁移完成 —— 失败时 storage 保持
    //    原样（`global.set` 在落盘失败时不会更新内存态），不会留下半迁移状态。
    await deps.storage.write(document)
  } catch (error) {
    return { outcome: 'failed', accountCount: 0, origin: found.origin, error: String(error) }
  }

  return { outcome: 'migrated', accountCount: section.accounts.length, origin: found.origin }
}
