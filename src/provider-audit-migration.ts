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
 * ## 判据（两级，都不猜）
 *
 * 逐条账号解析其凭据 JSON：
 *
 * 1. **JWT 的 `iss` 声明（首选）** —— 签发方写死在令牌里，比 `domain` 可信
 *    （后者是登录时的快照，历史迁移漏改过它）。只做 base64url 解码、不验签
 *    （这里不涉及信任判定，令牌另有服务端校验）。判据表
 *    {@link PROVIDER_ISSUER_PATTERNS} **从产品配置派生**，不在这里另造字面量：
 *    中国版要同时认「登录站 `www.codebuddy.cn`」与「API 端点 `copilot.tencent.com`」
 *    —— 它的登录站与 API 端点**不是同一个域**（见 `src/buddy.ts` 的 `WEBSITE_HOME`）；
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

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WEBSITE_HOME, jwtIssuer } from './buddy.js'
import { PROVIDER_AUDIT_VERSION, type AccountPool, type ModelDisableMap } from './account-pool.js'
import { ALL_PRODUCTS, BUDDY_CN, type BuddyProduct } from './product.js'
import type { ProviderAccountEntry } from './types.js'

/** 一次体检的结局（供日志与测试断言）。 */
export type ProviderAuditOutcome =
  /** 判定为「凭据属于另一个产品」，已重建条目并把凭据拷到新 ref。 */
  | 'rebuilt'
  /** 已一致，无需动作。 */
  | 'consistent'
  /** 凭据不可解析 / 归属无法判定 —— 保守不动手。 */
  | 'unjudged'
  /** 目标 ref 已存在且值不同，整条跳过（人工处理）。 */
  | 'conflict'
  /** 凭据拷贝失败（只读源等），整条保持原样。 */
  | 'copy-failed'

/** 单条账号的体检结论。 */
export interface ProviderAuditAccountResult {
  /** 体检前的账号 id。 */
  accountId: string
  /** 体检前条目上的 provider 标签。 */
  provider: string
  outcome: ProviderAuditOutcome
  /** 判定出的真实归属（仅在能从凭据内容判定时给出）。 */
  productId?: string
  /** 判据来源：`iss` = JWT 签发方，`domain` = 凭据 domain 字段。 */
  judgedBy?: 'iss' | 'domain'
  /** 重建后的账号 id（`outcome === 'rebuilt'` 时）。 */
  nextId?: string
  /** 重建后的凭据 ref（`outcome === 'rebuilt'` 时）。 */
  nextRef?: string
  /** 判据用的原始 `iss` / `domain`（写日志用）。 */
  issuer?: string
  domain?: string
}

/** 体检统计（供日志与测试断言）。 */
export interface ProviderAuditReport {
  /** 是否因体检版本号已达标（或本进程已跑过）而整体跳过。 */
  shortCircuited: boolean
  accounts: ProviderAuditAccountResult[]
  /** 被重建的账号数。 */
  rebuilt: number
  /** 判定为「已一致」的账号数。 */
  consistent: number
  /** 无法判定 / 冲突 / 拷贝失败而保持原样的账号数。 */
  skipped: number
  /** 本次是否真的产生了写入。 */
  wrote: boolean
}

/** 本进程是否已跑过一次体检（防 apply 重入，如 cordis 热重载）。 */
let auditRanInProcess = false

/**
 * 仅供测试：重置「本进程已跑」标记。
 *
 * 生产代码**不要**调用 —— 该标记的意义就是让同进程的第二次 apply 不再反复
 * 访问凭据存储。
 */
export function resetAuditProcessFlagForTest(): void {
  auditRanInProcess = false
}

/** 一个产品的凭据归属判据（全部由 {@link BuddyProduct} 配置派生，无字面量）。 */
export interface ProviderIssuerPatterns {
  /** 目标产品 id。 */
  productId: string
  /** `iss` 声明里出现的品牌域名（小写），命中即判定归属该产品。 */
  issuerHosts: readonly string[]
  /** `domain` 字段可接受的取值（小写；同时接受其 `www.` 变体）。 */
  domains: readonly string[]
}

/**
 * 从宿主域名里取**品牌域**（末两段；两段式 TLD 如 `com.cn` 取末三段）。
 *
 * `www.workbuddy.ai` → `workbuddy.ai`；`copilot.tencent.com` → `tencent.com`；
 * `www.codebuddy.cn` → `codebuddy.cn`（`com.cn` 规则只命中 `xx.com.cn` 形态）。
 */
function brandDomain(host: string): string {
  const parts = host.split('.').filter((part) => part.length > 0)
  if (parts.length <= 2) return parts.join('.')
  const tail = parts.slice(-2).join('.')
  // 两级公共后缀（com.cn / net.cn / org.cn …）：品牌域要再往前取一段。
  return /^(com|net|org|gov|edu)\.cn$/.test(tail) ? parts.slice(-3).join('.') : tail
}

/** 从 endpoint（URL）与 apiDomain 里抽出候选宿主名。 */
function hostsOf(product: BuddyProduct): string[] {
  const hosts = new Set<string>()
  hosts.add(product.apiDomain.toLowerCase())
  try {
    hosts.add(new URL(product.endpoint).hostname.toLowerCase())
  } catch {
    // endpoint 不是合法 URL 时忽略（配置是常量，这里只为稳健）
  }
  return [...hosts]
}

/**
 * 该产品的**登录站**宿主名（JWT `iss` 真正指向的域）。
 *
 * ⚠️ 只有中国版是「登录站 ≠ API 端点」的形态（`copilot.tencent.com` ↔
 * `www.codebuddy.cn`，映射关系早就写在 `src/buddy.ts` 的 `WEBSITE_HOME` 上）。
 * 国际版的 `endpoint` 本身就是登录站，故这里返回空数组、由 {@link hostsOf} 覆盖。
 * 别把 `WEBSITE_HOME` 直接套到国际版头上 —— 那是中国版的站点。
 */
function websiteHostsOf(product: BuddyProduct): string[] {
  if (product.id !== BUDDY_CN.id) return []
  try {
    return [new URL(WEBSITE_HOME).hostname.toLowerCase()]
  } catch {
    return []
  }
}

/**
 * 全部产品（buddy 系）的判据表 —— **唯一真相源是 `src/product.ts`**（外加
 * `buddy.ts` 那一个「登录站 ≠ API 端点」的既有映射）。
 *
 * 品牌域由产品自己的宿主名派生：
 *
 * | 产品 | API 端点宿主（`endpoint` / `apiDomain`） | 登录站宿主（令牌 `iss`） |
 * |---|---|---|
 * | `buddy` | www.workbuddy.ai | www.workbuddy.ai（`endpoint` 本身就是登录站） |
 * | `buddy-cn` | copilot.tencent.com | www.codebuddy.cn（`buddy.ts` 的 `WEBSITE_HOME`） |
 *
 * ⚠️ **中国版必须两处都取**：它的登录站与 API 端点**不是同一个域**（这正与
 * 产品注释里那句「`copilot.tencent.com` → `www.codebuddy.cn` 映射」同源）。
 * 只按 `endpoint` 派生的话，真实中国版令牌的 `iss=…codebuddy.cn` 会**判不出来**，
 * 体检只好回退到 `domain` 并给每条正常账号都打一条「无 iss」警告 —— 判据的
 * 覆盖范围凭空少一半。
 */
export const PROVIDER_ISSUER_PATTERNS: readonly ProviderIssuerPatterns[] = ALL_PRODUCTS.map(
  (product) => {
    const hosts = hostsOf(product)
    // 中国版：登录站宿主（`iss` 真正指向的地方）也要算进品牌域。
    // 用 `WEBSITE_HOME` 而不是再写一份字面量 —— 未配置登录站的产品为空数组。
    const issuerHosts = [...new Set([
      ...hosts.map(brandDomain),
      ...websiteHostsOf(product).map(brandDomain),
    ])]
    return { productId: product.id, issuerHosts, domains: hosts }
  },
)

/** 取某产品的判据；未知 product id 返回 undefined。 */
export function issuerPatternsFor(productId: string): ProviderIssuerPatterns | undefined {
  return PROVIDER_ISSUER_PATTERNS.find((entry) => entry.productId === productId)
}

/** 宿主是否属于某个品牌域（相等或以 `.品牌域` 结尾）。 */
function hostMatchesBrand(host: string, brands: readonly string[]): boolean {
  return brands.some((brand) => host === brand || host.endsWith(`.${brand}`))
}

/** 从 `iss`（通常是 URL，也可能是裸域名）里取出宿主名；取不到返回空串。 */
function hostOfIssuer(issuer: string): string {
  const raw = issuer.trim().toLowerCase()
  if (raw.length === 0) return ''
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    // 不是 URL：按裸域名/路径形态尽力取第一段宿主。
    const host = raw.split('/')[0]
    return host.includes('.') ? host : ''
  }
}

/** `domain` 字段的候选形态（自身 + `www.` 变体），用于与产品域集合比对。 */
function domainCandidates(domain: string): string[] {
  const raw = domain.trim().toLowerCase()
  if (raw.length === 0) return []
  return raw.startsWith('www.') ? [raw, raw.slice(4)] : [raw, `www.${raw}`]
}

/**
 * 由 `iss` 判定凭据归属。
 *
 * @returns 命中的产品判据；无法判定时返回 undefined（调用方回退到 domain）。
 */
function productByIssuer(issuer: string): ProviderIssuerPatterns | undefined {
  const host = hostOfIssuer(issuer)
  if (host.length === 0) return undefined
  return PROVIDER_ISSUER_PATTERNS.find((entry) => hostMatchesBrand(host, entry.issuerHosts))
}

/** 由 `domain` 字段判定凭据归属；无法判定时返回 undefined。 */
function productByDomain(domain: string): ProviderIssuerPatterns | undefined {
  const candidates = domainCandidates(domain)
  if (candidates.length === 0) return undefined
  return PROVIDER_ISSUER_PATTERNS.find(
    (entry) => entry.domains.some((expected) => candidates.includes(expected)),
  )
}

/** 账号 id 的短 id 部分（与 `account-hub-rpc.ts` 的 `shortId()` 同形）。 */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 账号凭据 ref 名（与 `account-hub-rpc.ts` 的 `accountCredentialRefName` 同形）。
 *
 * 刻意在这里重写而不是 import：`account-hub-rpc.ts` 是宿主 RPC 层（体量大、
 * 有副作用接线），迁移模块不该为了一个纯函数把它整个拉进来。形状由本模块的
 * 单测钉死（`^<PROVIDER>_ACCOUNT_[0-9A-F]{8}$`）。
 */
function credentialRefName(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_${suffix}`
}

/** 把 `consumptionCursors` 里指向 `oldId` 的值改成 `newId`。 */
function remapCursor(
  cursors: Record<string, string>,
  oldId: string,
  newId: string,
): Record<string, string> {
  let next = cursors
  for (const [provider, accountId] of Object.entries(cursors)) {
    if (accountId !== oldId) continue
    // ⚠️ 判据是**值**（accountId）而不是键（provider）：被重建的账号可能出现在
    // 任意 provider 的游标里（标签错了 ⇒ 旧标签与目标标签都可能记着它），
    // 只按目标 provider 找会漏掉另一个键，那正是「轮转下一轮跳过它」的成因。
    next = { ...next, [provider]: newId }
  }
  return next
}

/**
 * 体检一条账号。
 *
 * **绝不改入参**：返回新条目 / 新签到表由调用方落盘（便于测试逐条断言）。
 */
async function auditEntry(
  ctx: Context,
  entry: ProviderAccountEntry,
  checkins: Record<string, number>,
): Promise<{
  outcome: ProviderAuditOutcome
  /** 重建后的条目；未重建时为 undefined。 */
  next?: ProviderAccountEntry
  /** 重建后的签到表；未重建时为 undefined。 */
  nextCheckins?: Record<string, number>
  detail: Omit<ProviderAuditAccountResult, 'accountId' | 'provider' | 'outcome'>
}> {
  const detail: Omit<ProviderAuditAccountResult, 'accountId' | 'provider' | 'outcome'> = {}
  let parsed: { access_token?: unknown; domain?: unknown }
  try {
    const resolved = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
    if (resolved === undefined) return { outcome: 'unjudged', detail }
    parsed = JSON.parse(resolved.value) as { access_token?: unknown; domain?: unknown }
  } catch (error) {
    // 凭据 JSON 损坏：交给「凭据未配置」的正常报错路径，这里不动手。
    ctx.logger?.warn?.(
      `[account-hub] provider 体检：账号 ${entry.id} 的凭据 ${entry.credentialRef} `
      + `无法解析，已跳过（${String(error)}）`,
    )
    return { outcome: 'unjudged', detail }
  }

  const issuer = typeof parsed.access_token === 'string' ? jwtIssuer(parsed.access_token) : ''
  const domain = typeof parsed.domain === 'string' ? parsed.domain : ''
  detail.issuer = issuer
  detail.domain = domain

  // ① 首选判据：JWT 的签发方。issuerHosts 与 domains 同源（都由产品配置派生），
  //    故这里命中谁就是谁。
  let judged = productByIssuer(issuer)
  if (judged !== undefined) {
    detail.judgedBy = 'iss'
  } else {
    // ② 回退判据：凭据的 domain 字段 + 一条 warn（含 ref 与 domain，便于人工核）。
    judged = productByDomain(domain)
    if (judged === undefined) {
      ctx.logger?.warn?.(
        `[account-hub] provider 体检：账号 ${entry.id}（provider=${entry.provider}）的凭据 `
        + `${entry.credentialRef} 既无可用 iss（${issuer.length > 0 ? issuer : '未记录'}）、`
        + `domain 也不属于任何已知产品（${domain.length > 0 ? domain : '未记录'}），已跳过、未改动`,
      )
      return { outcome: 'unjudged', detail }
    }
    detail.judgedBy = 'domain'
    ctx.logger?.warn?.(
      `[account-hub] provider 体检：账号 ${entry.id} 的凭据 ${entry.credentialRef} 无 iss 声明，`
      + `按 domain=${domain} 判定归属 ${judged.productId}（条目标签为 ${entry.provider}），请人工核对`,
    )
  }
  detail.productId = judged.productId

  // ③ 标签本来就对 → 无动作。
  if (judged.productId === entry.provider) return { outcome: 'consistent', detail }

  // ④ 标签与凭据归属不符 → 重建。id / ref 一律**新生成**（可重入：中断后重跑
  //    不会撞上自己上次留下的半成品，代价只是一份无害的孤儿凭据）。
  const suffix = shortId()
  const nextId = `${judged.productId}-${suffix}`
  const nextRef = credentialRefName(judged.productId, suffix.toUpperCase())
  try {
    const source = await ctx.credentials.resolve(credentialRef(entry.credentialRef))
    if (source === undefined) {
      // 前面刚 resolve 过，这里只可能是并发删除了：保守跳过。
      return { outcome: 'unjudged', detail }
    }
    const existing = await ctx.credentials.resolve(credentialRef(nextRef))
    if (existing !== undefined && existing.value !== source.value) {
      ctx.logger?.error?.(
        `[account-hub] provider 体检：目标凭据 ${nextRef} 已存在且与源 ${entry.credentialRef} `
        + `值不同，账号 ${entry.id} 整条保留原样，请人工确认`,
      )
      return { outcome: 'conflict', detail }
    }
    if (existing === undefined) {
      await ctx.credentials.set(credentialRef(nextRef), source.value)
    }
  } catch (error) {
    // 只读凭据源（shadow）会让 set 抛错：**不**动条目、**不** unset 任何东西。
    ctx.logger?.error?.(
      `[account-hub] provider 体检：拷贝凭据 ${entry.credentialRef} → ${nextRef} 失败，`
      + `账号 ${entry.id} 保持原样（${String(error)}）`,
    )
    return { outcome: 'copy-failed', detail }
  }

  const next: ProviderAccountEntry = {
    ...entry,
    id: nextId,
    provider: judged.productId,
    credentialRef: nextRef,
  }
  // 关联键一起搬：签到记录（`provider:accountId`）与遍历游标（值就是 accountId）。
  const oldKey = `${entry.provider}:${entry.id}`
  const nextCheckins = { ...checkins }
  if (Object.prototype.hasOwnProperty.call(nextCheckins, oldKey)) {
    nextCheckins[`${judged.productId}:${nextId}`] = nextCheckins[oldKey]
    delete nextCheckins[oldKey]
  }
  detail.nextId = nextId
  detail.nextRef = nextRef
  return { outcome: 'rebuilt', next, nextCheckins, detail }
}

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
export async function auditProviderAssignments(
  pool: AccountPool,
  ctx: Context,
): Promise<ProviderAuditReport> {
  const report: ProviderAuditReport = {
    shortCircuited: false,
    accounts: [],
    rebuilt: 0,
    consistent: 0,
    skipped: 0,
    wrote: false,
  }

  // 闸门放在最前面：体检是「一次性」的，重复执行不只是浪费 —— 它每次都读凭据
  // 存储（真实 IO），且会在「冲突」场景下反复刷错误日志。
  if (pool.providerAuditVersion >= PROVIDER_AUDIT_VERSION) {
    report.shortCircuited = true
    return report
  }
  // 同进程重入保护（apply 可能被热重载调用两次）。
  if (auditRanInProcess) {
    report.shortCircuited = true
    return report
  }
  auditRanInProcess = true

  try {
    const accounts = await pool.listAllAccounts()
    const checkins = { ...pool.allCheckins() }
    const cursors = pool.allConsumptionCursors()
    const next: ProviderAccountEntry[] = []
    let nextCheckins = checkins
    let nextCursors = cursors
    let changed = false

    for (const entry of accounts) {
      // ⚠️ **只体检 buddy 系**：本模块的判据表就是 `product.ts` 的 Buddy 产品
      // （判据覆盖的是「签发方属于哪个 buddy 品牌」，对其他产品的凭据没有意义，
      // 强行判还可能把别家的域误配到 buddy 上）。非 buddy 系账号一律**原样保留**、
      // 连凭据都不读 —— 它们没有这类「标签与内容不符」的历史。
      if (issuerPatternsFor(entry.provider) === undefined) {
        report.accounts.push({
          accountId: entry.id,
          provider: entry.provider,
          outcome: 'consistent',
        })
        next.push(entry)
        continue
      }
      const result = await auditEntry(ctx, entry, nextCheckins)
      report.accounts.push({
        accountId: entry.id,
        provider: entry.provider,
        outcome: result.outcome,
        ...result.detail,
      })
      switch (result.outcome) {
        case 'rebuilt': {
          report.rebuilt++
          changed = true
          nextCheckins = result.nextCheckins ?? nextCheckins
          // `next` / `nextCheckins` / `detail.productId` / `detail.nextId` 只在
          // `rebuilt` 分支里被赋值（同一个函数同时构造它们），故这里必定存在。
          const rebuiltEntry = result.next!
          const rebuiltId = result.detail.nextId!
          nextCursors = remapCursor(nextCursors, entry.id, rebuiltId)
          next.push(rebuiltEntry)
          break
        }
        case 'consistent':
          report.consistent++
          next.push(entry)
          break
        default:
          // unjudged / conflict / copy-failed：**原样保留**。半迁移（条目指向新 ref
          // 而凭据没拷过去）会让账号在新标签下彻底不可用，比不迁移更糟。
          report.skipped++
          next.push(entry)
          break
      }
    }

    // 无待修条目时也要落一次体检版本号，否则每次启动都会重扫一遍凭据存储。
    await pool.replaceAll(
      next,
      pool.allDisabledModels(),
      pool.schemaVersion,
      nextCheckins,
      nextCursors,
      PROVIDER_AUDIT_VERSION,
    )
    report.wrote = true

    if (changed) {
      const migrated = report.accounts.filter((entry) => entry.outcome === 'rebuilt')
      ctx.logger?.info?.(
        `[account-hub] provider 体检完成：重建 ${report.rebuilt} 条（`
        + migrated.map((entry) => `${entry.provider}/${entry.accountId} → ${entry.productId}/${entry.nextId}`
          + `（凭据 ${entry.nextRef}）`).join('；')
        + `），一致 ${report.consistent} 条，未判定 ${report.skipped} 条`,
      )
      ctx.logger?.warn?.(
        '[account-hub] provider 体检改写了账号标签：旧凭据 ref 已**保留**（未删除），'
        + '它们是有效登录态、只是标签错了；确认新账号可用后可自行清理旧 ref',
      )
    } else {
      ctx.logger?.info?.(
        `[account-hub] provider 体检完成：无需修正（一致 ${report.consistent} 条，`
        + `未判定 ${report.skipped} 条）`,
      )
    }
    if (report.skipped > 0) {
      ctx.logger?.warn?.(
        `[account-hub] provider 体检存在 ${report.skipped} 条未能判定的账号（凭据缺失 / `
        + `既非 buddy 也非 buddy-cn 的签发方），已原样保留 —— 详见上文逐条日志`,
      )
    }
  } catch (error) {
    // 体检失败绝不能让插件启动失败：数据保持原状，下次启动重试。
    ctx.logger?.error?.(
      `[account-hub] provider 体检失败，数据保持原状（将在下次启动重试）：${String(error)}`,
    )
  }
  return report
}
