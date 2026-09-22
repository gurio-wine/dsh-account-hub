/**
 * 一次性数据迁移：provider 改名
 * `buddy`（中国版 CodeBuddy）→ `buddy-cn`，
 * `workbuddy`（国际版 WorkBuddy）→ `buddy`。
 *
 * ## 为什么必须迁移，而不是靠「兼容旧 id」
 *
 * 改名落在**三处持久化数据**上，任何一处漏搬都会让用户看到「账号凭空消失」：
 *
 * | 存储 | 字段 | 旧值 | 新值 |
 * |---|---|---|---|
 * | `settings.yaml`（namespace `jet-hub`） | 账号条目 `provider` / `credentialRef` / `id` | `buddy` / `workbuddy` | `buddy-cn` / `buddy` |
 * | `settings.yaml`（namespace `jet-hub`） | `disabledModels` 的 provider 键 | `buddy` / `workbuddy` | `buddy-cn` / `buddy` |
 * | `.credentials.yaml` | 凭据 ref 名 | `BUDDY_*` / `WORKBUDDY_*` | `BUDDY_CN_*` / `BUDDY_*` |
 *
 * ⚠️ **撞名坑（本模块的核心设计约束）**：
 * 新国际版（`buddy`）的目标凭据前缀 `BUDDY_ACCOUNT_*` **恰好等于旧中国版的现有前缀**
 * —— 同名不同义。若先搬国际版再让中国版让位，两个产品的凭据会在同一前缀下重叠，
 * 且 `AccountPool.removeAccount()` 只按 ref unset，会顺手删掉**别人**的凭据。
 * 因此顺序**不可颠倒**，且必须**按 provider 分两趟**跑（而不是按账号列表顺序
 * 逐条处理 —— 那样一条国际版账号可能先写下 `BUDDY_ACCOUNT_X`，随后被中国版
 * 那一趟当成自己的源凭据搬走）：
 *
 * 1. **先让中国版让位**：`buddy` + `BUDDY_*` → `buddy-cn` + `BUDDY_CN_*`，
 *    把 `BUDDY_*` 前缀腾空；
 * 2. **再让国际版搬入**：`workbuddy` + `WORKBUDDY_*` → `buddy` + `BUDDY_*`。
 *
 * ## 安全语义（六条，缺一不可）
 *
 * 1. **先写新、后删旧**：`moveRef` 只有在 `set(新, 旧值)` 成功后才 `unset(旧)`。
 *    中途崩溃时新旧两份都在，重跑即可收敛，不会丢凭据。
 * 2. **冲突不覆盖**：目标 ref 已存在且值不同 → 记为 `conflict`，`logger.error`
 *    打出两个全名并**保留旧 ref**（既不删也不改），交由用户人工判断。
 * 3. **幂等**：源 ref 解析不到（`resolve` 返回 undefined）→ `skipped`。
 *    迁移完成后写 `schemaVersion: 1`，函数入口版本号 ≥1 时整体 short-circuit。
 * 4. **可重入**：两趟各有天然幂等判据（该 provider 无匹配条目即整趟跳过），
 *    中断后重跑能补完；`modelRateLimits` 等未被触碰的字段逐字保留。
 * 5. **只读源保护**：`set` 可能因凭据源是只读 shadow 而抛错 —— try/catch 后
 *    保留旧 ref（该条目整体跳过），不让一半迁移的账号指向不存在的凭据。
 * 6. **不阻断启动**：全程 try/catch，失败只 `logger.error`，不向调用方抛出。
 *
 * ## 与 `disabledModels` 的「对调式搬运」
 *
 * 旧 `buddy` 键的值属于中国版 → 新 `buddy-cn` 键；旧 `workbuddy` 键的值属于国际版
 * → 新 `buddy` 键。两个键互为对方的「源」与「目标」，所以判定规则是
 * **「先搬未命中映射的 provider，再按映射逐条搬源键」**：搬迁源键永远不会被
 * 当成「目标已存在」而误判 —— 只有 `buddy-cn` 这类**不在映射源里**的键才可能
 * 是用户预先手工写下的目标，此时保留用户的值、不覆盖。
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ACCOUNT_HUB_SCHEMA_VERSION, type AccountPool, type ModelDisableMap } from './account-pool.js'
import type { ProviderAccountEntry } from './types.js'

/** 旧命名 → 新命名的 provider 映射（本模块的唯一真相源）。**数组顺序即执行顺序**。 */
export const PROVIDER_RENAME_MAP: ReadonlyArray<{ from: string; to: string }> = [
  // 中国版必须先让位（见模块头「撞名坑」）。
  { from: 'buddy', to: 'buddy-cn' },
  { from: 'workbuddy', to: 'buddy' },
]

/**
 * 凭据 ref 的旧前缀 → 新前缀。
 *
 * ⚠️ `BUDDY_ACCOUNT_` 同时出现在「源」（旧中国版的账号前缀）与「目标」
 * （新国际版的账号前缀）两侧 —— 这正是必须分两趟、且中国版那趟先跑的原因。
 * 匹配按**数组顺序**遇到即返回，因此不会出现 `BUDDY_` 之类的短前缀把
 * 长前缀吃掉的问题（表里给的都是完整前缀）。
 */
const REF_PREFIX_RULES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'WORKBUDDY_ACCOUNT_', to: 'BUDDY_ACCOUNT_' },
  { from: 'WORKBUDDY_ACCESS_TOKEN', to: 'BUDDY_ACCESS_TOKEN' },
  { from: 'BUDDY_ACCOUNT_', to: 'BUDDY_CN_ACCOUNT_' },
  { from: 'BUDDY_ACCESS_TOKEN', to: 'BUDDY_CN_ACCESS_TOKEN' },
]

/** 一次 `moveRef` 的结局（供日志与测试断言）。 */
export type MoveRefOutcome = 'moved' | 'skipped' | 'conflict' | 'failed'

/** 迁移统计（供日志与测试断言）。 */
export interface ProviderRenameMigrationReport {
  /** 是否因 schemaVersion 已达标（或本进程已跑过）而整体跳过。 */
  shortCircuited: boolean
  /** 账号条目被改写（provider/id/credentialRef 三项）的数量。 */
  accountsRenamed: number
  /** 账号条目因凭据搬不动（冲突/失败）而**整体保留原样**的数量。 */
  accountsSkipped: number
  /** 凭据本体成功搬移的数量。 */
  refsMoved: number
  /** 凭据本体被跳过的数量（源不存在）。 */
  refsSkipped: number
  /** 凭据冲突数量（目标已存在且值不同，旧 ref 保留）。 */
  refsConflicted: number
  /** 凭据搬移失败数量（set/unset 抛错）。 */
  refsFailed: number
  /** `disabledModels` 中被搬运的键数。 */
  disabledModelsRenamed: number
  /** 本次是否真的产生了写入。 */
  wrote: boolean
}

/** 本进程是否已跑过一次迁移（防 apply 重入，如 cordis 热重载）。 */
let migrationRanInProcess = false

/**
 * 仅供测试：重置「本进程已跑」标记。
 *
 * 生产代码**不要**调用 —— 该标记的存在意义就是让同进程的第二次 apply
 * 不再反复访问凭据存储。
 */
export function resetMigrationProcessFlagForTest(): void {
  migrationRanInProcess = false
}

/** 按规则把旧 ref 名换算为新 ref 名；无规则命中时返回 undefined。 */
export function renameCredentialRef(oldRef: string): string | undefined {
  for (const rule of REF_PREFIX_RULES) {
    if (oldRef.startsWith(rule.from)) return `${rule.to}${oldRef.slice(rule.from.length)}`
  }
  return undefined
}

/**
 * 把一条账号条目的 provider / credentialRef / id 改写为新命名。
 *
 * 改写的判据**同时**要求「provider 命中映射」与「credentialRef 命中对应前缀」，
 * 而不是只看 provider：配置文件可能被手工编辑过，只看 provider 会把一条
 * 写着 `LOBSTERAI_ACCOUNT_*` 却标了 `buddy` 的脏条目改成 `BUDDY_CN_*` ——
 * 那等于凭空制造一个指向别家凭据的账号。形状不符时**不猜**，原样保留并记警告。
 *
 * @returns 改写后的条目；无需改写或形状不符时返回 undefined。
 */
function renameAccountEntry(entry: ProviderAccountEntry): ProviderAccountEntry | undefined {
  const mapping = PROVIDER_RENAME_MAP.find((m) => m.from === entry.provider)
  if (mapping === undefined) return undefined
  const nextRef = renameCredentialRef(entry.credentialRef)
  if (nextRef === undefined) return undefined
  // 账号 id 前缀同步改写（`buddy-xxxx` → `buddy-cn-xxxx`）：
  // id 是 `loginFailures` 等登记表的键，也是客户端轮询的查询键，
  // 留着旧前缀会让同一条账号在新旧两条路径上对不上号。
  const nextId = entry.id.startsWith(`${mapping.from}-`)
    ? `${mapping.to}-${entry.id.slice(mapping.from.length + 1)}`
    : entry.id
  return { ...entry, provider: mapping.to, credentialRef: nextRef, id: nextId }
}

/**
 * 搬移一份凭据：`oldRef` → `newRef`。
 *
 * 语义见模块头的第 1/2/3/5 条。**绝不覆盖**目标：目标已存在且值不同时保留双方，
 * 只记冲突并让调用方跳过该条目。
 */
async function moveRef(ctx: Context, oldRef: string, newRef: string): Promise<MoveRefOutcome> {
  let oldValue: string
  try {
    const resolved = await ctx.credentials.resolve(credentialRef(oldRef))
    // 源不存在 = 已经搬过（或从未配置）→ 幂等跳过。
    if (resolved === undefined) return 'skipped'
    oldValue = resolved.value
  } catch (error) {
    ctx.logger?.error?.(
      `[account-hub] provider 改名迁移：读取凭据 ${oldRef} 失败，保留原状（${String(error)}）`,
    )
    return 'failed'
  }

  try {
    const existing = await ctx.credentials.resolve(credentialRef(newRef))
    if (existing !== undefined && existing.value !== oldValue) {
      ctx.logger?.error?.(
        `[account-hub] provider 改名迁移：凭据冲突，未覆盖 —— 目标 ${newRef} 已存在且与源 `
        + `${oldRef} 值不同；旧 ref 保留，请人工确认后处理`,
      )
      return 'conflict'
    }
    if (existing === undefined) {
      await ctx.credentials.set(credentialRef(newRef), oldValue)
    }
    // 值相同 = 上一次迁移已写成功、但在 unset 前中断 → 补删即可，仍算搬移完成。
    await ctx.credentials.unset(credentialRef(oldRef))
    return 'moved'
  } catch (error) {
    // 只读凭据源（shadow）会让 set 抛错：此时**不**删旧 ref，保持可重试。
    ctx.logger?.error?.(
      `[account-hub] provider 改名迁移：搬移凭据 ${oldRef} → ${newRef} 失败，保留旧 ref（${String(error)}）`,
    )
    return 'failed'
  }
}

/**
 * 搬移 `disabledModels` 的 provider 键（对调式）。
 *
 * 规则：**先把未命中映射的 provider 原样拷贝**，再按 {@link PROVIDER_RENAME_MAP}
 * 逐条搬源键。这样搬迁源键（`buddy` / `workbuddy`）永远不会被误判成
 * 「目标已存在」—— 只有 `buddy-cn` 这类不在源集合里的键才可能是用户预先
 * 手工写下的目标，此时保留用户的值。
 *
 * @returns 新的黑名单与「被搬运的键数」。
 */
function renameDisabledModels(before: ModelDisableMap): { after: ModelDisableMap; renamed: number } {
  const sources = new Set(PROVIDER_RENAME_MAP.map((m) => m.from))
  const after: ModelDisableMap = {}
  // 1) 不在映射源里的 provider（codearts / lobsterai / trae-cn，以及用户提前
  //    写下的 `buddy-cn`）先原样落位。
  for (const [provider, models] of Object.entries(before)) {
    if (sources.has(provider)) continue
    after[provider] = models
  }
  // 2) 再按映射搬源键。目标已被第 1) 步占用时不覆盖（保留用户已有的值）。
  let renamed = 0
  for (const { from, to } of PROVIDER_RENAME_MAP) {
    const models = before[from]
    if (models === undefined) continue
    if (Object.prototype.hasOwnProperty.call(after, to)) continue
    after[to] = models
    renamed++
  }
  return { after, renamed }
}

/**
 * 执行一次性 provider 改名迁移。
 *
 * fire-and-forget 调用（`void migrateProviderNames(pool, ctx)`）：内部自吞异常
 * 并打日志，绝不抛出、绝不阻断插件启动。
 *
 * @param pool - 账号池（读写 settings 的唯一入口）。
 * @param ctx - 宿主上下文（只用到 `credentials` 与 `logger`）。
 * @returns 迁移统计；供测试断言，生产调用方可以忽略。
 */
export async function migrateProviderNames(
  pool: AccountPool,
  ctx: Context,
): Promise<ProviderRenameMigrationReport> {
  const report: ProviderRenameMigrationReport = {
    shortCircuited: false,
    accountsRenamed: 0,
    accountsSkipped: 0,
    refsMoved: 0,
    refsSkipped: 0,
    refsConflicted: 0,
    refsFailed: 0,
    disabledModelsRenamed: 0,
    wrote: false,
  }

  // 版本号已达标 → 整体跳过。放在最前面：迁移是「一次性」的，重复执行不只是
  // 浪费，还会在冲突场景下反复刷错误日志。
  if (pool.schemaVersion >= ACCOUNT_HUB_SCHEMA_VERSION) {
    report.shortCircuited = true
    return report
  }
  // 同进程重入保护（apply 可能被热重载调用两次）。
  if (migrationRanInProcess) {
    report.shortCircuited = true
    return report
  }
  migrationRanInProcess = true

  try {
    const accounts = await pool.listAllAccounts()
    const renamed: ProviderAccountEntry[] = [...accounts]
    let accountsChanged = false

    // ★ 按 PROVIDER_RENAME_MAP 的顺序分趟处理，而不是按账号列表顺序逐条处理：
    //   中国版那趟必须整体跑完，`BUDDY_*` 前缀才算腾空（见模块头「撞名坑」）。
    for (const { from } of PROVIDER_RENAME_MAP) {
      for (let i = 0; i < renamed.length; i++) {
        const entry = renamed[i]
        if (entry.provider !== from) continue
        const next = renameAccountEntry(entry)
        if (next === undefined) {
          // provider 命中但 ref 形态不符：不猜，原样保留并点名，便于人工排查。
          ctx.logger?.warn?.(
            `[account-hub] provider 改名迁移：账号 ${entry.id} 标为 ${from} 但凭据 ref `
            + `${entry.credentialRef} 不符合该产品的前缀形态，已原样保留`,
          )
          continue
        }
        const outcome = await moveRef(ctx, entry.credentialRef, next.credentialRef)
        if (outcome === 'conflict' || outcome === 'failed') {
          // 凭据没搬成 → **整条保留原样**。半迁移（条目指向新 ref 而凭据还在
          // 旧 ref）会让账号在新命名下彻底不可用，比不迁移更糟。
          report.accountsSkipped++
          if (outcome === 'conflict') report.refsConflicted++
          else report.refsFailed++
          continue
        }
        if (outcome === 'moved') report.refsMoved++
        else report.refsSkipped++
        report.accountsRenamed++
        accountsChanged = true
        renamed[i] = next
      }
    }

    const before = pool.allDisabledModels()
    const { after, renamed: modelsRenamed } = renameDisabledModels(before)
    report.disabledModelsRenamed = modelsRenamed
    // 键集合变化即视为「黑名单变了」—— 源键被丢弃、目标键被写入都算。
    const modelsChanged = Object.keys(after).sort().join('\u0000')
      !== Object.keys(before).sort().join('\u0000')

    if (!accountsChanged && !modelsChanged) {
      // 没有任何待迁移数据：仍然落一次版本号，避免每次启动都重新扫一遍。
      await pool.replaceAll(renamed, after, ACCOUNT_HUB_SCHEMA_VERSION)
      report.wrote = true
      return report
    }

    // 一次性原子写：账号 + 黑名单 + 版本号三件套同时落盘，
    // 中途崩溃不会留下「账号搬了、版本号没搬」的半迁移状态。
    await pool.replaceAll(renamed, after, ACCOUNT_HUB_SCHEMA_VERSION)
    report.wrote = true
    ctx.logger?.info?.(
      `[account-hub] provider 改名迁移完成：账号 ${report.accountsRenamed} 条改写`
      + `（保留 ${report.accountsSkipped}）、凭据 ${report.refsMoved} 份搬移`
      + `（跳过 ${report.refsSkipped}）、模型黑名单键 ${report.disabledModelsRenamed} 个`,
    )
    if (report.accountsSkipped > 0) {
      ctx.logger?.warn?.(
        `[account-hub] provider 改名迁移存在未处理项：保留账号 ${report.accountsSkipped} 条、`
        + `凭据冲突 ${report.refsConflicted} 份 —— 详见上文 error 日志`,
      )
    }
  } catch (error) {
    // 迁移失败绝不能让插件启动失败：数据保持原状，下次启动重试。
    ctx.logger?.error?.(
      `[account-hub] provider 改名迁移失败，数据保持原状（将在下次启动重试）：${String(error)}`,
    )
  }
  return report
}
