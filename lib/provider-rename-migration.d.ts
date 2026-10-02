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
import type { Context } from '@deepseek-ai/cordis';
import { type AccountPool } from './account-pool.js';
/** 旧命名 → 新命名的 provider 映射（本模块的唯一真相源）。**数组顺序即执行顺序**。 */
export declare const PROVIDER_RENAME_MAP: ReadonlyArray<{
    from: string;
    to: string;
}>;
/** 一次 `moveRef` 的结局（供日志与测试断言）。 */
export type MoveRefOutcome = 'moved' | 'skipped' | 'conflict' | 'failed';
/** 迁移统计（供日志与测试断言）。 */
export interface ProviderRenameMigrationReport {
    /** 是否因 schemaVersion 已达标（或本进程已跑过）而整体跳过。 */
    shortCircuited: boolean;
    /** 账号条目被改写（provider/id/credentialRef 三项）的数量。 */
    accountsRenamed: number;
    /** 账号条目因凭据搬不动（冲突/失败）而**整体保留原样**的数量。 */
    accountsSkipped: number;
    /** 凭据本体成功搬移的数量。 */
    refsMoved: number;
    /** 凭据本体被跳过的数量（源不存在）。 */
    refsSkipped: number;
    /** 凭据冲突数量（目标已存在且值不同，旧 ref 保留）。 */
    refsConflicted: number;
    /** 凭据搬移失败数量（set/unset 抛错）。 */
    refsFailed: number;
    /** `disabledModels` 中被搬运的键数。 */
    disabledModelsRenamed: number;
    /** 本次是否真的产生了写入。 */
    wrote: boolean;
}
/**
 * 仅供测试：重置「本进程已跑」标记。
 *
 * 生产代码**不要**调用 —— 该标记的存在意义就是让同进程的第二次 apply
 * 不再反复访问凭据存储。
 */
export declare function resetMigrationProcessFlagForTest(): void;
/** 按规则把旧 ref 名换算为新 ref 名；无规则命中时返回 undefined。 */
export declare function renameCredentialRef(oldRef: string): string | undefined;
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
export declare function migrateProviderNames(pool: AccountPool, ctx: Context): Promise<ProviderRenameMigrationReport>;
//# sourceMappingURL=provider-rename-migration.d.ts.map