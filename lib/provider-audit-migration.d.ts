/**
 * 一次性**体检迁移**：修正「账号的 provider 标签与它凭据的真实归属不符」的历史脏数据。
 *
 * ## 现场（本模块存在的唯一理由）
 *
 * `~/.dsh/.credentials.yaml` 里 `BUDDY_CN_ACCOUNT_5C80F1BE` 存着一份
 * `iss=https://www.workbuddy.ai/auth/realms/copilot`、`domain=www.workbuddy.ai`、
 * 一年期（`expires_at` 2027-09-23）的令牌 —— **国际版内容挂在 `buddy-cn` 前缀下**，
 * 条目上写着 `provider: 'buddy-cn'`。真正的中国版凭据是
 * `iss=…codebuddy.cn`、30 天期。
 *
 * ## 脏数据是怎么产生的（成因已关闭，但数据还在）
 *
 * 1. `AccountPool.pruneAccountsWithForeignDomain` 在 276521d（2026-09-23 14:48）
 *    之前**直接删号**，而它的判据按 `entry.provider` 选账号；
 * 2. 更早的 `removeAccount` 顺序是「先 `credentials.unset(旧 ref)` → 再写账号
 *    列表」，两步之间中断就留下**孤儿凭据**（ref 还在、条目没了）；
 * 3. 下一次同前缀登录复用了同一个 ref ⇒ 新凭据被写进旧 ref，条目却还是旧标签。
 *    （该顺序已在本轮改成「先写条目、后 unset」，见 `AccountPool.removeAccount`。）
 *
 * ## 为什么它能活到今天（本模块的**闸门设计约束**）
 *
 * 当年的体检把闸门判据写成 `pool.schemaVersion >= ACCOUNT_HUB_SCHEMA_VERSION`
 * —— 与**改名迁移共用同一个数字**。而 `ACCOUNT_HUB_SCHEMA_VERSION` 在改名迁移
 * 落地那天**就已经是 1**，09-18 之后被任何一版写过的文档版本号都已 ≥ 1
 * ⇒ 体检**每次都 short-circuit，从未执行过**。
 *
 * 结论被写进了代码而不是注释：体检用**自己的**版本号
 * （`AccountHubDocument.providerAuditVersion`，见 `PROVIDER_AUDIT_VERSION`），
 * 与字段集合版本 `schemaVersion` 各司其职。**不要再合并这两个数字。**
 *
 * ## 判据（两级，都不猜）—— **本体在 `src/credential-ownership.ts`**
 *
 * 判据**不再定义在本模块**：登录链（`runBuddyLoginFlow`）写凭据前问的是同一个
 * 问题，故两级判据与判据表已抽到 `src/credential-ownership.js`，由
 * {@link judgeCredentialOwnership} 一次定义、两处消费。本模块只把它的结论翻译成
 * 体检动作（重建 / 保持一致 / 不动手）与日志。**判据一旦分叉，会出现「登录链
 * 放行的东西体检要重建」这种自相矛盾的状态** —— 那正是抽公共模块要根除的。
 *
 * 摘要（细节见该模块）：
 *
 * 1. **JWT 的 `iss` 声明（首选）** —— 签发方写死在令牌里，比 `domain` 可信
 *    （后者是登录时的快照，历史迁移漏改过它）。只做 base64url 解码、不验签
 *    （这里不涉及信任判定，令牌另有服务端校验）；
 * 2. **`domain` 字段（回退）** —— 老令牌没有 `iss` 时按它判，并 `logger.warn`
 *    一条（含 ref 与 domain），便于人工复核；
 * 3. 两级都说不清（凭据缺失 / JSON 损坏 / `iss` 与 `domain` 都不属于已知产品）
 *    时**一律不动手** —— 与 `pruneAccountsWithForeignDomain` 的保守语义同款：
 *    机器不猜、不删。
 *
 * ⚠️ **`iss` 与 `domain` 矛盾时以 `iss` 为准**（有测试钉死）：`iss` 是签发方，
 * `domain` 只是登录时的字段。
 *
 * ⚠️ **只体检 buddy 系**：非 buddy 系账号（codearts / lobsterai / trae-cn / qoder…）
 * 连凭据都不读、原样保留 —— 它们没有这类「标签与内容不符」的历史，而把别家的
 * 域往 buddy 品牌上套只会制造误判。
 *
 * ## 动作（重建，不是改标签）
 *
 * 判定「凭据属于另一个产品」时，把条目**原地重建**为目标 provider 的形态：
 *
 * - `provider` → 目标产品 id，`id` → `<目标 id>-<新短 id>`；
 * - `credentialRef` → `<目标前缀>_ACCOUNT_<新短 id 大写>`（形状与
 *   `account-hub-rpc.ts` 的 `accountCredentialRefName` 一致）；
 * - 凭据本体 **读旧写新**（`credentials.resolve` + `credentials.set`）：
 *   **绝不 `unset` 旧 ref** —— 那份登录态是有效的，只是标签错了；旧 ref 留成
 *   孤儿由用户自行清理；
 * - 关联键一起搬：`checkins` 的 `${provider}:${accountId}` 键、
 *   `consumptionCursors` 的值（它的值就是 accountId）。
 *   `disabledModels` / `contextBudgets` **不搬** —— 它们的键是 provider id，
 *   属于「面板配置」而不属于账号（目标 provider 自己那份配置照旧生效）。
 *   `loginFailures` 是宿主内存表（`account-hub-rpc.ts`），不落盘，无需搬。
 *
 * 同名目标 ref 已存在且**值不同**时按冲突处理：整条跳过、记 `logger.error`，
 * 绝不覆盖（同 `provider-rename-migration.ts` 的冲突语义）。
 *
 * ## 安全语义
 *
 * - **幂等**：完成后写 `providerAuditVersion = PROVIDER_AUDIT_VERSION`，
 *   函数入口版本号达标即整体 short-circuit。反过来，万一有人把版本号手工改回 0，
 *   重跑也**不会破坏数据**（重建后的条目与凭据内容一致 ⇒ 判定为「无需动作」）。
 * - **不阻断启动**：全程 try/catch，失败只 `logger.error`，绝不向调用方抛出。
 * - **先写凭据、后写文档**：中断时最坏留下「新 ref 已有凭据、条目还没重建」
 *   —— 下次启动重跑会重新生成 ref 并再拷一份（新 ref 是随机的，不会撞上
 *   上次留下的那一份），代价只是一份无害的孤儿凭据。
 *
 * @module dsh-account-hub/provider-audit-migration
 */
import type { Context } from '@deepseek-ai/cordis';
import { type AccountPool } from './account-pool.js';
/** 一次体检的结局（供日志与测试断言）。 */
export type ProviderAuditOutcome = 
/** 判定为「凭据属于另一个产品」，已重建条目并把凭据拷到新 ref。 */
'rebuilt'
/** 已一致，无需动作。 */
 | 'consistent'
/** 凭据不可解析 / 归属无法判定 —— 保守不动手。 */
 | 'unjudged'
/** 目标 ref 已存在且值不同，整条跳过（人工处理）。 */
 | 'conflict'
/** 凭据拷贝失败（只读源等），整条保持原样。 */
 | 'copy-failed';
/** 单条账号的体检结论。 */
export interface ProviderAuditAccountResult {
    /** 体检前的账号 id。 */
    accountId: string;
    /** 体检前条目上的 provider 标签。 */
    provider: string;
    outcome: ProviderAuditOutcome;
    /** 判定出的真实归属（仅在能从凭据内容判定时给出）。 */
    productId?: string;
    /** 判据来源：`iss` = JWT 签发方，`domain` = 凭据 domain 字段。 */
    judgedBy?: 'iss' | 'domain';
    /** 重建后的账号 id（`outcome === 'rebuilt'` 时）。 */
    nextId?: string;
    /** 重建后的凭据 ref（`outcome === 'rebuilt'` 时）。 */
    nextRef?: string;
    /** 判据用的原始 `iss` / `domain`（写日志用）。 */
    issuer?: string;
    domain?: string;
}
/** 体检统计（供日志与测试断言）。 */
export interface ProviderAuditReport {
    /** 是否因体检版本号已达标（或本进程已跑过）而整体跳过。 */
    shortCircuited: boolean;
    accounts: ProviderAuditAccountResult[];
    /** 被重建的账号数。 */
    rebuilt: number;
    /** 判定为「已一致」的账号数。 */
    consistent: number;
    /** 无法判定 / 冲突 / 拷贝失败而保持原样的账号数。 */
    skipped: number;
    /** 本次是否真的产生了写入。 */
    wrote: boolean;
}
/**
 * 仅供测试：重置「本进程已跑」标记。
 *
 * 生产代码**不要**调用 —— 该标记的意义就是让同进程的第二次 apply 不再反复
 * 访问凭据存储。
 */
export declare function resetAuditProcessFlagForTest(): void;
/**
 * 判据**本体**已迁至 `src/credential-ownership.ts`（登录链与本体检共用一份，
 * 避免两处判据漂移）。这里原样再导出，只为兼容既有导入方与测试 ——
 * 新增代码请直接从 `credential-ownership.js` 导入。
 */
export { PROVIDER_ISSUER_PATTERNS, issuerPatternsFor, judgeCredentialOwnership, } from './credential-ownership.js';
export type { ProviderIssuerPatterns } from './credential-ownership.js';
/**
 * 执行一次性 provider 体检迁移。
 *
 * fire-and-forget 调用（`void auditProviderAssignments(pool, ctx)`）：内部自吞异常
 * 并打日志，绝不抛出、绝不阻断插件启动。
 *
 * @param pool - 账号池（读写文档的唯一入口）。
 * @param ctx - 宿主上下文（只用到 `credentials` 与 `logger`）。
 * @returns 体检统计；供测试断言，生产调用方可以忽略。
 */
export declare function auditProviderAssignments(pool: AccountPool, ctx: Context): Promise<ProviderAuditReport>;
//# sourceMappingURL=provider-audit-migration.d.ts.map