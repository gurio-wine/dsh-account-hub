/**
 * Account Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 account-hub → 路径 /api/account-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           credits.checkinStatus / checkin.perform / checkin.sweep /
 *           model.list / model.setDisabled / model.setContextBudget
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool, todayDayNumber } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { TraeCnAuth } from './trae-cn-auth.js'
import type { QoderAuth } from './qoder-auth.js'
import type { LobsteraiPendingLogin } from './lobsterai-oauth.js'
import type { CodeartsPendingLogin } from './login.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js'
import { credentialExpiresAtMs } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
  type CheckinStatus,
  type ClaimOutcome,
  type CreditBalance,
} from './credits.js'
import { BUDDY, BUDDY_CN, productById, type BuddyProduct } from './product.js'
import {
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfoDetailed,
} from './codearts-credits.js'
import {
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance,
} from './lobsterai-credits.js'
import { TRAE_CN } from './trae-cn-product.js'
import { QODER, QODER_CN, qoderProductById } from './qoder-product.js'
import {
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  fetchQoderCreditBalance,
} from './qoder-credits.js'
import type { QoderCredential, QoderProduct } from './qoder-product.js'
import { isTraeCnJunkModelId } from './trae-cn-models.js'
import {
  availableContextTiers,
  describeContextTiers,
  type ContextTier,
  type ContextTierRegistry,
} from './context-tiers.js'
import type { TraeCnCredential, TraeCnPendingLogin } from './trae-cn-oauth.js'
import type { QoderDevicePendingLogin } from './qoder-device-flow.js'
import type { TraeCnProduct } from './trae-cn-product.js'
import {
  TRAE_CN_POOL_UNIVERSAL,
  claimTraeCnDailyCheckin,
  fetchTraeCnCheckinStatus,
  fetchTraeCnCreditBalance,
} from './trae-cn-credits.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
import type { CodeArtsCredential } from './types.js'
import type {
  ProviderAccountEntry,
  RpcListAccountsRequest,
  RpcListAccountsResponse,
  RpcCreateAccountRequest,
  RpcCreateAccountResponse,
  RpcPollLoginRequest,
  RpcPollLoginResponse,
  RpcUpdateAccountRequest,
  RpcDeleteAccountRequest,
  RpcReorderAccountsRequest,
  RpcRefreshAccountRequest,
  RpcRefreshAccountResponse,
  RpcRetestAccountRequest,
  RpcRetestAllRequest,
  RpcResetAccountRequest,
  RpcResetAllRequest,
  RpcCreditsStatusRequest,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllRequest,
  RpcCreditsClaimAllResponse,
  RpcCreditsClaimAccountResult,
  RpcCreditsClaimSummary,
  RpcCreditsBalancesRequest,
  RpcCreditsBalancesResponse,
  RpcModelListRequest,
  RpcModelListResponse,
  RpcModelListEntry,
  RpcModelSetDisabledRequest,
  RpcModelSetDisabledResponse,
  RpcModelSetContextBudgetRequest,
  RpcModelSetContextBudgetResponse,
} from './types.js'

/** Account Hub RPC API 路径 */
export const ACCOUNT_HUB_API_PATH = '/api/account-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const ACCOUNT_HUB_ENDPOINT = 'account-hub'

/**
 * 自动签到（Auto Check-in）**可签到 provider** 的宿主侧真相源。
 *
 * sweep（`checkin.sweep`）与 `checkin.perform` 的 provider 全量退化只遍历这套集合。
 * ⚠️ 它是宿主侧的独立常量：客户端的能力真相源在
 * `plugin-src/client/credits-capabilities.js`（esbuild 进 bundle，宿主无法 import）。
 * 两处靠 `tests/unit/credits-capabilities.spec.ts` 的**相等断言**锁一致，漂移当场抓红。
 *
 * 六条（qoder 国际版已拍板接入，2026-09-23）：buddy-cn / lobsterai / trae-cn /
 * codearts / qoder / qoder-cn。
 */
export const CHECKIN_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
  'buddy-cn',
  'lobsterai',
  'trae-cn',
  'codearts',
  'qoder',
  'qoder-cn',
])

/**
 * sweep 的**模块级互斥信号量**。
 *
 * 4 小时定时器与页面触发（`checkin.perform` 无 accountId / `checkin.sweep`）可能
 * 同时跑。入口若非空闲直接跳过本趟（不排队、不重入），返回「进行中」摘要。
 * 因每账号依次 `await`、服务端本身幂等（already-claimed 也写今日），同一账号
 * 几乎不可能被两路真正走到 claim；即便竞态，两 claim 中后到者拿到
 * already-claimed 也写今日，结果一致。—— 语义见设计文档 §9。
 */
export let sweepRunning = false

/** 重置 sweep 互斥（仅测试用）。 */
export function __resetSweepRunning(): void {
  sweepRunning = false
}

/**
 * 执行一次**单个账号**或**单个 provider 全量**的自动签到（复用 claimAll 分派逻辑）。
 *
 * 内部实现见下方 `runCreditsClaim`：对账号数组逐账号走与 `credits.claimAll` 分支
 * **完全相同**的 claim 分派，差异仅在：
 *  1. accountId 给定时只处理该账号；
 *  2. 成功（claimed）或已领（already-claimed）都写 `writeCheckinDay`（今日），
 *     inactive / failed **不写**（失败不写，下次 sweep 重试）。
 *
 * 返回按账号的 outcome 摘要（claimed / already-claimed / failed）。互斥由调用方
 * （`checkin.sweep` case）统一管理，这里不做 —— 单账号 perform 不占互斥。
 */
/**
 * 与 `credits.claimAll` 的 {@link RpcCreditsClaimAccountResult} **同构**的逐账号
 * 签到结果：`outcome` 是完整 {@link ClaimOutcome} 对象（`{kind, code, message,
 * logid?}`），不是拍扁成裸字符串 —— 客户端通知 UI（claimFailureLines /
 * formatClaimFailureLine）依赖它带 code/message/logid。
 */
export type CheckinAccountResult = RpcCreditsClaimAccountResult

/** RPC: `credits.checkinStatus` 请求。 */
export interface RpcCheckinStatusRequest {
  provider: string
}
/** RPC: `credits.checkinStatus` 响应（纯内存读，不发网络请求）。 */
export interface RpcCheckinStatusResponse {
  provider: string
  /** 今日本地纪元日数（`todayDayNumber()` 口径）。 */
  today: number
  /** accountId → 今日是否已签（checkinDay === today）。无账号时为空对象。 */
  checkedIn: Record<string, boolean>
}

/** RPC: `checkin.perform` 请求（accountId 缺省/空串 → 该 provider 全量）。 */
export interface RpcCheckinPerformRequest {
  provider: string
  accountId?: string
}
/** RPC: `checkin.perform` 响应。 */
export interface RpcCheckinPerformResponse {
  provider: string
  today: number
  results: CheckinAccountResult[]
  summary: RpcCreditsClaimSummary
}

/** 单个 provider 的一次 sweep 结果。 */
export interface RpcCheckinSweepProviderResult {
  provider: string
  results: CheckinAccountResult[]
  summary: RpcCreditsClaimSummary
}
/** RPC: `checkin.sweep` 响应。 */
export interface RpcCheckinSweepResponse {
  /** 本趟是否真正执行（false = 被互斥排到，返回进行中快照）。 */
  running: boolean
  providers: RpcCheckinSweepProviderResult[]
}

/** 生成 8 字符随机短 ID（小写 hex） */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 由 provider 名与短 id 派生**账号凭据 ref 名**。
 *
 * ## 为什么必须归一化连字符
 *
 * provider id 允许带连字符（`trae-cn` 是对齐生态叫法的刻意选择，见
 * `src/trae-cn-product.ts`），但 DSH 的 `@deepseek-ai/dsh-credentials` 把 ref 名
 * 约束为 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` —— 连字符**不在**字符集内。
 *
 * 归一化前的后果链（已实证）：`pool.addAccount` 把 `TRAE-CN_ACCOUNT_XXX` 原样
 * 写进账号池 → 后台登录第二段调 `credentialRef(refName)` 直接抛 TypeError →
 * 凭据**从未**写入 `.credentials.yaml` → 池里留下一个永远没有凭据的条目，
 * 三个积分收集器在 `credentialRef(entry.credentialRef)` 处一并抛错（面板显示
 * 「积分查询失败 / 领取失败」），trae-cn 的 LLM 对话同样不可用。
 *
 * ## 为什么是「先 toUpperCase、再折连字符」
 *
 * `trae-cn` → `TRAE_CN_ACCOUNT_XXX`，与 `src/trae-cn-product.ts` 的
 * `accountCredentialRefPrefix`（`TRAE_CN_ACCOUNT`）**逐字符一致** —— 后者是
 * 该前缀的唯一真相源，本函数必须与它同值。同理 `buddy-cn` →
 * `BUDDY_CN_ACCOUNT_XXX`（与 `product.ts` 的 `defaultCredentialRef`
 * `BUDDY_CN_ACCESS_TOKEN` 同族）。
 *
 * 无连字符的 provider（`codearts` / `buddy` / `lobsterai`）
 * 输出与归一化前**完全相同**，既有账号的 ref 全部兼容，**无需迁移**。
 * ⚠️ 但 `buddy` 这个 id 本身**换了产品**（原中国版 → 现国际版），
 * 旧 `BUDDY_ACCOUNT_*` 前缀下躺着的是中国版凭据 —— 这段历史由
 * `src/provider-rename-migration.ts` 一次性搬运，**不能**只靠本函数的兼容性。
 */
export function accountCredentialRefName(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_${suffix}`
}

/**
 * provider id → **账号池的 provider 键**（当前对每个 provider 都是恒等）。
 *
 * ## 为什么留着一个恒等函数
 *
 * 它存在的理由是**收敛点**，不是映射本身：账号列表 / 余额 / 签到状态 / 领取 /
 * 重测 / 重置六个入口都经它把「面板 id」翻成「池键」，客户端因此永远不需要
 * 知道池键与面板 id 可能不同（客户端发的就是面板 id）。
 *
 * 它曾经有过非恒等分支 —— 某个复用 `trae-cn` 账号的 TraeWork 路线 provider
 * （官方已把该通道并入通用通道，那个 provider 已整体移除）。**恒等是
 * 今天的取值，不是这个函数的语义**：将来若再出现「复用别人账号」的 provider，
 * 在这里加一行即可，而不必把 if 撒进客户端六处调用点。
 *
 * ## 刻意**不**经过本函数的入口
 *
 * - **`account.create`**：它按 provider 解析产品配置来决定「登录怎么做」。
 *   若某天出现共用账号的 provider，这里**不能**映射成宿主 provider ——
 *   那会派生出一个占位账号，而它背后是另一份凭据体系，等于把一个账号建两遍。
 *   故该入口对未知 provider 的拒绝行为**保持不变**（宁可拒绝，不可静默重复建号）。
 * - **`login.poll`**：轮询的键是 accountId + 该账号自己的 provider，与面板 id 无关。
 */
export function poolProviderFor(provider: string): string {
  return provider
}

/**
 * Qoder 的 **region 解引用**：provider id → （产品配置, 该 region 的 auth 实例）。
 *
 * ## 为什么必须是**成对**返回，而不是让调用方各取各的
 *
 * Qoder 的两个 region 是**同协议、两套 host、两批互不相通的账号**
 * （见 `src/qoder-product.ts` 的模块头）。三条依赖都必须与 region 对齐：
 *
 * | 依赖 | 落在哪 | 配错的失败形态 |
 * |---|---|---|
 * | exchange / quota / models 的 host | `product.*` | 拿 CN 的 PAT 打国际版端点 → 假的「凭据失效」 |
 * | jt 运行时缓存、在途去重、失效标记 | **auth 实例的字段** | 用国际版实例换的 jt 打 CN → 401 → 又指向「PAT 失效」 |
 * | 账号池键 / 凭据 ref 前缀 | `product.id` / `product.*Ref` | 串到另一区的账号 |
 *
 * 三者的取值来源**不同**（配置 vs 实例），所以「调用方自己按 id 取配置、
 * 再自己按 id 挑实例」这种写法在将来新增 region 时极易只改一半。本函数把它们
 * 绑成一个返回值，调用点拿到的是**已经对齐的**一对。
 *
 * ## 与 `poolProviderFor` 的区别
 *
 * 那个答的是「面板 id 该查哪个账号池」，本函数答的是「这个 region
 * 该用哪份配置与哪个实例」。Qoder **没有**任何池映射（两区是两批账号），故
 * `qoder-cn` 既不被映射到 `qoder`，也不反向映射 —— 这正是与国际版账号隔离的
 * 实现方式。
 *
 * @returns 该 provider 的 region；**不是 Qoder 系 provider 时 `undefined`**
 *          （由调用方决定是拒绝还是走别的分支 —— 本函数不抛错，因为
 *          调用点还需要区分「未知 provider」与「已知但配置不全」）。
 */
export function qoderRegionFor(
  provider: string,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
): { product: QoderProduct; auth: QoderAuth } | undefined {
  const product = qoderProductById(provider)
  if (product === undefined) return undefined
  // 显式列举两个 region，**不用** `product === QODER ? qoder : qoderCn` 这种
  // 二选一：后者会让将来新增的第三个 region 静默复用 CN 的实例（也就是用 CN
  // 的 jt 缓存去打第三区的端点），而那种错误在响应上表现为「凭据失效」，与
  // 真实原因毫无关系。
  if (product === QODER) return { product, auth: qoder }
  if (product === QODER_CN) return { product, auth: qoderCn }
  return undefined
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 进行中的 LobsterAI 登录登记表（accountId → 会话句柄）。
 *
 * 只做**生命周期管理**：`account.delete` 时按 accountId 找到会话并 cancel，
 * 立刻释放它占用的 127.0.0.1 回调端口；会话结算（成功/失败/超时）后自行删除。
 *
 * 真正的并发互斥在 `prepareLobsteraiLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingLobsteraiLogins = new Map<string, { accountId: string; session: LobsteraiPendingLogin }>()

/**
 * 进行中的 CodeArts 登录登记表（accountId → 会话句柄）。
 *
 * 与 {@link pendingLobsteraiLogins} 同构、同样**只做生命周期管理**：
 * `account.delete` 时按 accountId 找到会话并 cancel，立刻释放它占用的
 * 回调端口（CodeArts 的端口还必须 ≥10000）；会话结算（成功/失败/超时）后自行删除。
 *
 * 真正的并发互斥在 `prepareCodeartsLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingCodeartsLogins = new Map<string, { accountId: string; session: CodeartsPendingLogin }>()

/**
 * 进行中的 Trae CN 登录登记表（accountId → 会话句柄）。
 *
 * 与 {@link pendingLobsteraiLogins} 同构、同样**只做生命周期管理**：
 * `account.delete` 时按 accountId 找到会话并 cancel，立刻释放它占用的
 * 回调端口；会话结算（成功/失败/超时）后自行删除。
 *
 * 真正的并发互斥在 `prepareTraeCnLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingTraeCnLogins = new Map<string, { accountId: string; session: TraeCnPendingLogin }>()

/**
 * 进行中的 Qoder 设备流登录登记表（accountId → 会话句柄）。
 *
 * 与上面三张表同构、同样**只做生命周期管理**：`account.delete` 时按 accountId
 * 找到会话并 cancel，立刻终止轮询并释放 provider 级互斥槽位。
 *
 * ## 与另外三张表的一个实质差异（为什么取消是必须的）
 *
 * 那三个 provider 的会话占用的是**本地回调端口**，不 cancel 的后果是端口挂到
 * 超时；Qoder 设备流不占端口，但**每 1 秒打一次轮询**，不 cancel 的后果是：
 *
 * 1. 用户删掉占位账号后，后台仍在每秒钟问一次上游，直到 5 分钟超时；
 * 2. **互斥槽位不释放** —— 用户想重新登录会一直拿到 `login-in-progress`，
 *    而界面上看不出任何东西还在进行中。
 *
 * 真正的并发互斥在 `prepareQoderDeviceLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingQoderDeviceLogins = new Map<string, { accountId: string; session: QoderDevicePendingLogin }>()

/**
 * 登录**失败终态**登记表（accountId → 失败原因）。
 *
 * ## 为什么需要它（用户报障的根因）
 *
 * 两段式登录的第二段失败时（网络错、协议变更、凭据名非法……），现有实现只做
 * `pool.removeAccount(id)` 把占位账号删掉。而 `login.poll` 的完成判据是
 * 「账号池里有这个 id **且** 其凭据可解析」—— 账号被删后 poll 永远落到
 * `entry === undefined` 分支，返回 `{ done: false }`。于是：
 *
 * - 客户端把 5 分钟轮询白等到底，**永远等不到 `done`**；
 * - 登录窗口一直留着（用户报障：「登录后多出残留标签页」）。
 *
 * 失败必须是**终态**，与「还没完成」严格区分：登记表让 poll 能如实回
 * `{ done: true, error }`。poll 读到即清（一次性语义，避免同一 accountId
 * 的陈旧失败污染下一次登录），故不需要过期时间。
 *
 * 刻意**不**按 provider 分表：accountId 本身已全局唯一（`${provider}-${shortId()}`）。
 */
const loginFailures = new Map<string, string>()

/**
 * 登记一次登录失败终态，并把原因整理成**可展示**的短文案。
 *
 * 四个 provider 的第二段失败路径共用它：先登记失败，再删占位账号。
 * 顺序不能反 —— 虽然 poll 是异步读的，但「登记 → 删除」让窗口期内
 * 读到的是确定的失败，而不是「账号还在但没凭据」的中间态。
 *
 * @param accountId - 占位账号 id（poll 的查询键）。
 * @param error - 第二段抛出的原因（任意类型，按 Error/字符串归一化）。
 */
function recordLoginFailure(accountId: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  loginFailures.set(accountId, reason.length > 0 ? reason : '登录失败（宿主未提供原因）')
}

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<
  TCredential = BuddyCredential,
  TProduct = BuddyProduct,
> {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: TCredential, product: TProduct) => Promise<ClaimOutcome>
  /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /**
   * 带**精确原因**的余额查询（可选，优先于 {@link fetchBalance}）。
   *
   * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
   * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
   * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
   * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
   * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
   *
   * `error` 为 `undefined` 且 `balance` 为 `null` 时，调用方按「余额查询失败」
   * 兜底 —— 实现不必自己造一句笼统文案。
   */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
  ) => Promise<{ balance: CreditBalance | null; error?: string }>
  /**
   * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
   * 使用的 fetch。
   *
   * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
   * `(credential, product, fetcher)`，而本模块的历史写法用**双重类型断言**
   * （`deps.claim ?? (claimDailyCheckin as …)`）把三参函数硬转成「只传两个参数」
   * 的类型 —— 于是调用点写 `claim(credential, product, entry)` 时，`entry` 落进了
   * **`fetcher` 的位置**，运行时抛 **`TypeError: fetcher is not a function`**。
   *
   * 现改为**显式包装**默认实现（见 `collectCreditsStatus` / `collectClaimResults` /
   * `collectCreditBalances`），把 fetcher 正确送进第三参。未提供时用全局 `fetch`。
   */
  fetcher?: typeof fetch
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /**
   * 领取前是否先查一次签到状态（默认 `true`）。
   *
   * Buddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
   * 领取请求（活动未开 / 今天已领时直接短路）。
   *
   * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
   * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
   * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
   * 故它传 `false` 跳过预检，直接交给 `claim`。
   */
  precheckStatus?: boolean
}

/**
 * 把注入的依赖与**默认实现**（Buddy 系三兄弟）合流成一组可直接调用的函数。
 *
 * ⚠️ **默认实现必须显式适配，不能靠双重类型断言硬转。**
 *
 * 真实签名是 `(credential, product, fetcher)`，而 {@link CreditsEndpointDeps} 把它们
 * 声明为两参 `(credential, product)`。历史写法用 `as` 双重断言把这个不匹配
 * 「压」了过去 —— TypeScript 于是不再报错，但调用点一旦按**声明**多传一个实参
 * （`claim(credential, product, entry)`），`entry` 就落进 **`fetcher` 的位置**，
 * 运行时抛 **`TypeError: fetcher is not a function`**（上游真实缺陷：一键领取的
 * 账号全部失败，而报错信息与「第三参错位」毫无字面关联，极难定位）。
 *
 * 这里把 `deps.fetcher`（或全局 `fetch`）显式送进第三参，从此不存在「谁多传一个
 * 实参就炸」的窗口。**集中成一处而不是三个收集器各写一遍**：三份包装一旦漂移
 * （例如只改了 `claim` 忘了 `fetchBalance`），缺陷会以「某个面板的积分突然查不到」
 * 的形态复现，而这里只有一个落点。
 *
 * 非 Buddy 系的 provider（LobsterAI / Trae CN / Qoder）**全部显式注入**这三个函数，
 * 因此不会走到下面的默认实现；泛型实参在此断言成 Buddy 系类型是刻意的 ——
 * 默认实现本身就是 Buddy 系的，而 `CreditsEndpointDeps` 的泛型参数只为
 * 「注入路径」服务。
 */
function resolveCreditsDeps<TCredential, TProduct>(
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): {
  fetchStatus: NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchStatus']>
  claim: NonNullable<CreditsEndpointDeps<TCredential, TProduct>['claim']>
  fetchBalance: NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchBalance']>
} {
  const fetcher = deps.fetcher ?? fetch
  return {
    fetchStatus: deps.fetchStatus
      ?? ((credential, product) => fetchCheckinStatus(credential as BuddyCredential, product as BuddyProduct, fetcher)),
    claim: deps.claim
      ?? ((credential, product) => claimDailyCheckin(credential as BuddyCredential, product as BuddyProduct, fetcher)),
    fetchBalance: deps.fetchBalance
      ?? ((credential, product) => fetchCreditBalance(credential as BuddyCredential, product as BuddyProduct, fetcher)),
  }
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `account-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  const { fetchStatus } = resolveCreditsDeps(deps)
  const results: RpcCreditsStatusResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as TCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
      deps.warn?.(`[account-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  const { fetchStatus, claim } = resolveCreditsDeps(deps)
  // 默认保留预检（Buddy 系需要）；LobsterAI 显式传 false 跳过。
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[account-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  const { fetchBalance } = resolveCreditsDeps(deps)
  const fetchDetailed = deps.fetchBalanceDetailed
  const results: RpcCreditsBalancesResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        error = '凭据未配置'
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (fetchDetailed !== undefined) {
          // 带原因的查询：实现自己决定「非积分账户」这类业务状态的文案。
          const detailed = await fetchDetailed(credential, product)
          balance = detailed.balance
          error = detailed.error
          if (balance === null && error === undefined) error = '余额查询失败'
        } else {
          balance = await fetchBalance(credential, product)
          // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
          if (balance === null) error = '余额查询失败'
        }
      }
    } catch (caught) {
      deps.warn?.(`[account-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
      error = caught instanceof Error ? caught.message : String(caught)
      balance = null
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
    })
  }
  return results
}

/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * 用 `ctx.get` 而不是 `inject`：Account Hub 的账号管理是主要职责，模型开关只是
 * 附加能力；llm 服务缺失时账号面板仍应可用，只是「显示列表」按钮报错。
 */
function llmServiceOf(ctx: Context): { listModels(provider: string): Promise<Array<{ id: string; name: string }>> } | undefined {
  return ctx.get('llm') as
    | { listModels(provider: string): Promise<Array<{ id: string; name: string }>> }
    | undefined
}

/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单、也不套目录门控**的
 * 完整目录（带最终展示名）。
 *
 * ## 为什么需要它
 *
 * 适配器的 `listModels` 会按用户黑名单过滤，于是**被关闭的模型不在其返回值里**；
 * 设置页必须把它们渲染出来（否则用户无法重新打开），此前只能凭黑名单的键（裸 id）
 * 补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。
 * 有了本接口，关闭项与开启项走同一份目录、同一个名字。
 *
 * ⚠️ 它**同时不受目录门控影响**（`providerCatalogVisible`）：没有已登录账号时
 * `listModels` 返回空数组（整个 provider 分组从模型选择器消失），而设置页仍须
 * 列出该 provider 的全部模型 —— 反而更需要它（此时 `listModels` 一个都不给）。
 *
 * ⚠️ **只声明用到的方法**（结构化类型），避免本模块依赖七个具体适配器类。
 * 实例由 `src/index.ts` 显式收集后传入（`ctx.llm` 不透传自定义方法）。
 */
export interface ModelCatalogSource {
  listAllModels(): readonly { id: string; name: string }[]
}

/**
 * 逐模型**上下文窗口档位**的**按 provider 分派**注册表（定义在 `src/context-tiers.ts`）。
 *
 * ## 为什么由调用方注入，而不是 RPC 自己去捞
 *
 * 目录的持有者是**适配器实例**（它带 TTL 缓存、远端优先、失败回退静态表）。
 * `ctx.llm.listModels()` 帮不上忙：`LlmRuntime.listModels` 会把适配器返回的条目
 * **重建**成 `{provider, id, name, description?, inputModalities?}`，任何额外字段都
 * 在那一层被丢掉（已读 `lib/types/index.js` 确认），所以窗口档位不可能搭它的车。
 * 而 `ctx` 上也没有「按 provider 取适配器」的入口。最省事、也最不可能撒谎的做法，
 * 就是让组装方（`src/index.ts`）把各 `register*Llm` 返回的实例按 provider id 装进
 * 注册表交过来。
 *
 * ## 从「只服务 Trae CN」推广到全部供应商（2026-09-21）
 *
 * 本层的两个端点原先对 provider 名字写死特判（`req.provider === TRAE_CN.id`），
 * 只服务 Trae CN 的两档形态。推广后**一律问注册表**：`sourceFor(provider)` 有来源
 * 就走通用路径，没有来源就维持既定降级（`model.list` 不带窗口字段、
 * `model.setContextBudget` 拒绝）。
 *
 * ⚠️ **注册表按 provider id 分键，与 `contextBudgets` 的存储分键同构**。
 * 没有档位数据源的 provider（如 LobsterAI：目录里没有档位元数据）**不进注册表**
 * —— 注册进去只会让面板多出一列切了没反应的选项，与「宁缺毋编」同一条铁律。
 */
export type { ContextTierRegistry, ContextTierSource } from './context-tiers.js'

/**
 * 自动签到**全量 sweep**（宿主自触发与 `checkin.sweep` RPC 共用）所需的最小依赖集合。
 *
 * 原实现作为 `registerAccountHubEndpoints` 的闭包捕获 `ctx` / `pool` / 各 auth 实例；
 * 为让 `src/index.ts` 的宿主触发层（启动 sweep + 4h 定时器）能直接调用，把这一整条
 * 执行链抽成模块级函数，把闭包捕获的依赖显式收进这一个对象。**只搬结构、不改行为**：
 * `runCreditsClaim` / `performCheckinOnTargets` / `performCheckinSweep` 的执行体与原
 * 闭包版逐字相同，既有 RPC 分支（`credits.claimAll` / `checkin.perform` / `checkin.sweep`）
 * 经它调用后行为零变化。
 */
export interface CheckinSweepDeps {
  ctx: Context
  pool: AccountPool
  lobsterai: LobsteraiAuth
  qoder: QoderAuth
  qoderCn: QoderAuth
}

/** 未知 provider 的可判别异常（两类调用点据此转成 bad-request）。 */
class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`unsupported provider: ${provider}`)
    this.name = 'UnsupportedProviderError'
  }
}

/**
 * 该 provider 是否属于「已知可签到」集合（buddy 系 / codearts / lobsterai /
 * trae-cn / qoder 两区）。**单一真相源**：`credits.claimAll` / `checkin.perform` /
 * `checkin.sweep` 都经它判定未知 provider 时应拒绝，而不各自散落判断。
 */
function isKnownCheckinProvider(provider: string): boolean {
  if (provider === 'codearts') return true
  if (provider === LOBSTERAI.id) return true
  if (provider === TRAE_CN.id) return true
  if (provider === QODER.id || provider === QODER_CN.id) return true
  return productById(provider) !== undefined
}

/**
 * 复用 `credits.claimAll` 的**逐账号分派逻辑**。
 *
 * 五个 provider 分支（codearts / lobsterai / trae-cn / qoder 两区 / buddy 系）
 * 与 `credits.claimAll` case 内**逐字相同**，只是把「全账号数组」收成一个入参。
 * `credits.claimAll` 与 `checkin.perform` / `checkin.sweep` 共用这一份实现，
 * 因此签到领取的分派不会漂移。
 *
 * 未知 provider 抛 {@link UnsupportedProviderError}，由调用点决定如何呈现。
 *
 * @returns 与 claimAll 同构的逐账号结果数组（含 nickname）。
 */
async function runCreditsClaim(
  deps: CheckinSweepDeps,
  provider: string,
  accounts: ProviderAccountEntry[],
): Promise<RpcCreditsClaimAccountResult[]> {
  const { ctx, lobsterai, qoder, qoderCn } = deps
  if (!isKnownCheckinProvider(provider)) throw new UnsupportedProviderError(provider)
  if (provider === 'codearts') {
    // CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
    // 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
    // 故 precheckStatus: false 跳过外部那次 Buddy 式的状态查询 ——
    // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
    // 第二、三个实参是 `undefined`：CodeArts 没有 BuddyProduct，
    // 而下钻函数只吃凭据（product 对华为协议无意义）。
    const value = await collectClaimResults<CodeArtsCredential, undefined>(accounts, undefined, {
      resolve: (ref) => ctx.credentials.resolve(ref),
      claim: (credential) => claimCodeArtsDailyCheckin(credential),
      precheckStatus: false,
      warn: (msg) => ctx.logger?.warn?.(msg),
    })
    return value.results
  }
  if (provider === LOBSTERAI.id) {
    // LobsterAI 的 clientVersion 是签到必填参数，需动态解析（带缓存）。
    const clientVersion = await lobsterai.resolveClientVersion()
    const value = await collectClaimResults(accounts, LOBSTERAI, {
      resolve: (ref) => ctx.credentials.resolve(ref),
      claim: (credential, product) =>
        claimLobsteraiDailyCheckin(credential, product, clientVersion),
      // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
      precheckStatus: false,
      warn: (msg) => ctx.logger?.warn?.(msg),
    })
    return value.results
  }
  if (provider === TRAE_CN.id) {
    // Trae CN 的领取流程**自身**就是两步（status → 未领则 claim），内部已按
    // `checked_in` 幂等预检 —— 外部再查一次纯属重复请求，故 precheckStatus: false。
    const value = await collectClaimResults<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
      resolve: (ref) => ctx.credentials.resolve(ref),
      claim: (credential, product) =>
        claimTraeCnDailyCheckin(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
      precheckStatus: false,
      warn: (msg) => ctx.logger?.warn?.(msg),
    })
    return value.results
  }
  if (provider === QODER.id || provider === QODER_CN.id) {
    // 两区都有签到：`qoder-credits.ts` 按传入的 `product` 现算 host，region
    // 差异全部由产品配置承载。`precheckStatus: false` —— claimQoderDailyCheckin
    // **自带活动列表查询**，外部再查一次纯属重复 GET。
    // ⚠️ provider → 这里的 region 解析对未知 Qoder region 抛错（即「必须显式接线」）。
    const region = qoderRegionFor(provider, qoder, qoderCn)
    if (region === undefined) throw new UnsupportedProviderError(provider)
    const value = await collectClaimResults<QoderCredential, QoderProduct>(accounts, region.product, {
      resolve: (ref) => ctx.credentials.resolve(ref),
      claim: (credential, product) =>
        claimQoderDailyCheckin(credential, region.auth, {
          product,
          onDebug: (msg) => ctx.logger?.info?.(msg),
        }),
      precheckStatus: false,
      warn: (msg) => ctx.logger?.warn?.(msg),
    })
    return value.results
  }
  const product = productById(provider)
  if (product === undefined) throw new UnsupportedProviderError(provider)
  const value = await collectClaimResults(accounts, product, {
    resolve: (ref) => ctx.credentials.resolve(ref),
    warn: (msg) => ctx.logger?.warn?.(msg),
  })
  return value.results
}

/**
 * 对**给定账号数组**执行一次自动签到：成功或已领都写今日，失败不写。
 *
 * 与 `credits.claimAll` 的核心差异只在写状态这一步。inactive / failed **不写**
 * （失败不写，下次 sweep 重试）——见设计文档 §2/§9。
 *
 * @param targets - 本次实际要签的账号；空数组 = 无操作（不发起任何请求）。
 */
async function performCheckinOnTargets(
  deps: CheckinSweepDeps,
  provider: string,
  targets: ProviderAccountEntry[],
  today: number,
): Promise<{ results: CheckinAccountResult[]; summary: RpcCreditsClaimSummary }> {
  if (targets.length === 0) {
    return { results: [], summary: computeClaimSummary([]) }
  }
  const claimResults = await runCreditsClaim(deps, provider, targets)
  const results: CheckinAccountResult[] = []
  for (const r of claimResults) {
    if (r.outcome.kind === 'claimed' || r.outcome.kind === 'already-claimed') {
      await deps.pool.writeCheckinDay(provider, r.accountId, today)
    }
    // outcome 保留 runCreditsClaim 产出的完整 ClaimOutcome 对象（不拍扁成字符串），
    // 并带上 nickname —— 与 `credits.claimAll` 同构，客户端通知 UI 直接可用。
    results.push({ accountId: r.accountId, nickname: r.nickname, outcome: r.outcome })
  }
  return { results, summary: computeClaimSummary(claimResults.map((c) => c.outcome)) }
}

/**
 * 执行一次**全量 sweep**（`checkin.sweep` RPC / 宿主定时器共用入口）。
 *
 * - 只遍历 {@link CHECKIN_ELIGIBLE_PROVIDERS}（六条）；
 * - 无账号 provider 跳过；
 * - 每个 provider 只签「今日未签」（`checkinDay !== todayDayNumber()`）的账号；
 * - 模块级互斥 {@link sweepRunning}：已有一趟在跑就**直接返回进行中快照**，
 *   不排队不重入（设计文档 §9 并发防重）。
 */
export async function performCheckinSweep(deps: CheckinSweepDeps): Promise<RpcCheckinSweepResponse> {
  const { pool } = deps
  if (sweepRunning) return { running: false, providers: [] }
  sweepRunning = true
  try {
    const today = todayDayNumber()
    const providers: RpcCheckinSweepProviderResult[] = []
    for (const provider of CHECKIN_ELIGIBLE_PROVIDERS) {
      const accounts = await pool.listAccounts(provider)
      if (accounts.length === 0) continue
      // 只签「今日未签」：checkinDay === today 直接短路，不发任何请求。
      const due = accounts.filter((a) => pool.checkinDay(provider, a.id) !== today)
      const { results, summary } = await performCheckinOnTargets(deps, provider, due, today)
      providers.push({ provider, results, summary })
    }
    return { running: true, providers }
  } finally {
    sweepRunning = false
  }
}

/**
 * 注册 Account Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 *
 * @param contextTiers - 可选的窗口档位注册表（见 {@link ContextTierRegistry}）。
 *        省略时 `model.list` 不带窗口字段、`model.setContextBudget` 一律拒绝 ——
 *        这是 headless / 测试场景的既定降级，不是缺陷。
 * @param modelAdapters - 可选的 provider → 适配器实例映射（见
 *        {@link ModelCatalogSource}）。用于「显示列表」拿到**不套用户黑名单、也不套
 *        目录门控**的完整目录，使被关闭的模型也显示正确的展示名（含倍率）而不是
 *        退化成裸 id。省略时退化为「`listModels` 结果 + 黑名单裸 id 回补」的历史
 *        行为（同样是 headless / 测试的既定降级）。
 */
export function registerAccountHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddyCn: BuddyAuth,
  buddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  traeCn: TraeCnAuth,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
  contextTiers?: ContextTierRegistry,
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerAccountHubEndpoints(
      connectionCtx as Context, pool, codearts, buddyCn, buddy, lobsterai, traeCn, qoder, qoderCn,
      contextTiers, modelAdapters,
    )
  })
}

/** 注册 Account Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerAccountHubEndpoints(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddyCn: BuddyAuth,
  buddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  traeCn: TraeCnAuth,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
  contextTiers: ContextTierRegistry | undefined,
  modelAdapters: Readonly<Record<string, ModelCatalogSource>> | undefined,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[account-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  connection.fetch.register({
    path: ACCOUNT_HUB_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = await request.json() as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== ACCOUNT_HUB_ENDPOINT
        || !call || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Account Hub management request.' } })
      }

      try {
        const result = await handleMethod(call.method as string, call.payload, request.signal)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
        // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[account-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'account-hub/handler-failed', message },
        })
      }
    },
  })

  // 自动签到全量 sweep / 单账号签到所需的宿主依赖：本闭包持有 `ctx`/`pool` 与各 auth
  // 实例，收进 {@link CheckinSweepDeps} 后交给模块级实现（见模块定义）。执行逻辑
  // `runCreditsClaim` / `performCheckinOnTargets` / `performCheckinSweep` 已提升到
  // 模块级，宿主（`src/index.ts`）用同一份 deps 调用，绝不复制第二份。
  const checkinDeps: CheckinSweepDeps = { ctx, pool, lobsterai, qoder, qoderCn }

  /**
   * 执行自动签到（`checkin.perform` / `checkin.sweep` 共用）。
   *
   * accountId 缺省/空串 → 该 provider 全量账号；否则只处理该账号（若不在列表中，
   * targets 为空，结果为空、不发请求）。未知 provider **即使无账号也拒绝**（在该
   * provider 有账号时 `runCreditsClaim` 会二次抛，空数组分支提前兜住）。
   */
  async function performCheckin(
    provider: string,
    accountId?: string,
  ): Promise<RpcCheckinPerformResponse> {
    const accounts = await pool.listAccounts(provider)
    const targets = accountId !== undefined && accountId.length > 0
      ? accounts.filter((a) => a.id === accountId)
      : accounts
    const today = todayDayNumber()
    if (!isKnownCheckinProvider(provider)) throw new UnsupportedProviderError(provider)
    const { results, summary } = await performCheckinOnTargets(checkinDeps, provider, targets, today)
    return { provider, today, results, summary }
  }

  /** 分发端点方法到对应的处理器 */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        // provider → 池键（见 {@link poolProviderFor}）。
        const accounts = await pool.listAccounts(poolProviderFor(req.provider))
        return { ok: true, value: { accounts } }
      }

      case 'account.create': {
        const req = payload as RpcCreateAccountRequest
        const { provider } = req
        const id = `${provider}-${shortId()}`
        const suffix = shortId().toUpperCase()
        // 归一化连字符：`trae-cn` → `TRAE_CN_ACCOUNT_XXX`（见
        // {@link accountCredentialRefName} 的后果链说明）。无连字符的 provider
        // 输出与归一化前逐字符相同。
        const refName = accountCredentialRefName(provider, suffix)

        // Buddy 系（buddy-cn / buddy）共用两步登录流程：
        // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
        // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
        // 参数、X-Product-Code、User-Agent），全部由 product 承载。
        const product = productById(provider)
        if (product !== undefined) {
          let state: string
          let authUrl: string
          try {
            const authState = await fetchAuthState(undefined, undefined, product)
            state = authState.state
            // Buddy（国际版）的登录 URL 需要追加 version 与 loginSessionId
            authUrl = decorateLoginUrl(authState.authUrl, product)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`)
          }
          const ref = credentialRef(refName)
          // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          // 后台异步执行完整登录流程，使用同一个 state
          runBuddyLoginFlow({ openBrowser: () => {}, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access)
            // 续期定时器归属该产品自己的服务实例
            ;(product.id === BUDDY_CN.id ? buddyCn : buddy).scheduleRefresh()
            const credential = parseBuddyCredential(flow.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((err) => {
            ctx.logger.warn(`[account-hub] background ${product.id} login failed for ${id}: ${err}`)
            // 登录失败是**终态**：先登记失败（poll 据此收窗并提示），
            // 再移除占位条目，避免留下无凭据的幽灵账号。
            recordLoginFailure(id, err)
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: authUrl } }
        } else if (provider === 'codearts') {
          // CodeArts 与 LobsterAI 同款：**回调式**登录，走两段式。
          //   1. 先 prepare（起 127.0.0.1 回调服务器，端口 ≥10000）→ 立即返回 loginUrl；
          //   2. 客户端在同一用户手势内 open 该 URL —— 这正是本次改造的目的：
          //      宿主不再持有一个可能长达 180 秒的阻塞 RPC。阻塞期间用户手势
          //      早已过期，客户端兜底会自行开窗，把 DSH 页面顶掉；
          //   3. 后台 awaitCredential 完成后写凭据并补全占位账号。
          //
          // 宿主 opener 为空的表达方式与 lobsterai 分支一致：prepareLogin 本身
          // 不接收 openBrowser，这里通过「根本不打开」来表达同一约束（打开动作
          // 归客户端，宿主再开一次会变成两个标签页）。
          let prepared
          try {
            prepared = await codearts.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 CodeArts 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。原样返回可判别错误码，
            // 而不是抛异常 —— 抛异常会被包装成 account-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 先在 pool 中添加启用的占位条目（无凭据、pending 形态），
          // 满足 login.poll 的检测路径：它按「该 credentialRef 能否解析到凭据」判完成。
          await pool.addAccount({
            id,
            provider: 'codearts',
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // 占位期间不可续期、无过期时间：两者都要等换取结果才知道。
            refreshable: false,
            createdAt: Date.now(),
          })
          // 登记表只做生命周期管理：失败/超时释放端口，account.delete 时取消。
          pendingCodeartsLogins.set(id, { accountId: id, session: loginSession })
          void loginSession.awaitCredential().then(async (flow) => {
            // 凭据落盘 + 占位账号补全（两段式的第二段），时序由该方法内部保证。
            await codearts.persistLoginResult(flow, { refName, accountId: id, pool })
          }).catch(async (error: unknown) => {
            ctx.logger.warn(
              `[account-hub] background codearts login failed for ${id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            // 登录失败是**终态**（见 loginFailures 的说明）：登记后再删占位。
            recordLoginFailure(id, error)
            await pool.removeAccount(id).catch(() => {})
          }).finally(() => {
            pendingCodeartsLogins.delete(id)
          })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else if (provider === LOBSTERAI.id) {
          // LobsterAI 与 Buddy 系一样走**两段式**，但第一段不是「轮询式取 state」，
          // 而是「起本地回调服务器拿 loginUrl」：
          //   1. 先 prepare（起 127.0.0.1 回调服务器）→ 立即返回 loginUrl；
          //   2. 客户端在同一用户手势内 open 该 URL —— 这正是本次改造的目的：
          //      宿主不再持有一个可能长达 10 分钟的阻塞 RPC。阻塞期间用户手势
          //      早已过期，客户端兜底会自行开窗，把 DSH 页面顶掉；
          //   3. 后台 awaitCredential 完成后写凭据并补全占位账号。
          //
          // 宿主 opener 为空函数（对齐上面 Buddy 分支的 `openBrowser: () => {}`）：
          // 打开动作归客户端，宿主再开一次会变成两个标签页。prepareLogin 本身
          // 不接收 openBrowser，这里通过「根本不打开」来表达同一约束。
          let prepared
          try {
            prepared = await lobsterai.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 LobsterAI 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。原样返回可判别错误码，
            // 而不是抛异常 —— 抛异常会被包装成 account-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 先在 pool 中添加启用的占位条目（无凭据、pending 形态），
          // 满足 login.poll 的检测路径：它按「该 credentialRef 能否解析到凭据」判完成。
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // 占位期间不可续期、无过期时间：两者都要等 exchange 结果才知道。
            refreshable: false,
            createdAt: Date.now(),
          })
          // 登记表只做生命周期管理：失败/超时释放端口，account.delete 时取消。
          pendingLobsteraiLogins.set(id, { accountId: id, session: loginSession })
          void loginSession.awaitCredential().then(async (flow) => {
            // 凭据落盘 + 占位账号补全（两段式的第二段），时序由该方法内部保证。
            await lobsterai.persistLoginResult(flow, { refName, accountId: id, pool })
          }).catch(async (error: unknown) => {
            ctx.logger.warn(
              `[account-hub] background ${LOBSTERAI.id} login failed for ${id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            // 登录失败是**终态**（见 loginFailures 的说明）：登记后再删占位。
            recordLoginFailure(id, error)
            await pool.removeAccount(id).catch(() => {})
          }).finally(() => {
            pendingLobsteraiLogins.delete(id)
          })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else if (provider === TRAE_CN.id) {
          // Trae CN 与 lobsterai/codearts 同款两段式（本地回调服务器拿 loginUrl），
          // 但更简单：回调 query 直接携带 refreshToken，没有 authCode 交换。
          //   1. 先 prepare（起 127.0.0.1 回调服务器）→ 立即返回 loginUrl；
          //   2. 客户端在同一用户手势内 open 该 URL；
          //   3. 后台 awaitCredential 完成后写凭据并补全占位账号。
          // 宿主不打开浏览器（打开动作归客户端，宿主再开一次会变成两个标签页）。
          let prepared
          try {
            prepared = await traeCn.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Trae CN 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。原样返回可判别错误码，
            // 而不是抛异常 —— 抛异常会被包装成 account-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 先在 pool 中添加启用的占位条目（无凭据、pending 形态），
          // 满足 login.poll 的检测路径：它按「该 credentialRef 能否解析到凭据」判完成。
          await pool.addAccount({
            id,
            provider: TRAE_CN.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // 占位期间不可续期、无过期时间：两者都要等 exchange 结果才知道。
            refreshable: false,
            createdAt: Date.now(),
          })
          // 登记表只做生命周期管理：失败/超时释放端口，account.delete 时取消。
          pendingTraeCnLogins.set(id, { accountId: id, session: loginSession })
          void loginSession.awaitCredential().then(async (flow) => {
            // 凭据落盘 + 占位账号补全（两段式的第二段），时序由该方法内部保证。
            await traeCn.persistLoginResult(flow, { refName, accountId: id, pool })
          }).catch(async (error: unknown) => {
            ctx.logger.warn(
              `[account-hub] background ${TRAE_CN.id} login failed for ${id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            // 登录失败是**终态**（见 loginFailures 的说明）：登记后再删占位。
            recordLoginFailure(id, error)
            await pool.removeAccount(id).catch(() => {})
          }).finally(() => {
            pendingTraeCnLogins.delete(id)
          })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else if (provider === QODER.id || provider === QODER_CN.id) {
          // 本分支按「载荷里有没有 pat」分流：
          //
          // | 载荷 | 形态 | 时序 |
          // |---|---|---|
          // | `{ provider, pat }` | PAT 粘贴 | **同步完成**（即时 exchange 验证） |
          // | `{ provider }` | 浏览器设备流 | **两段式**（占位 → loginUrl → 后台补全） |
          //
          // ## ⚠️ 客户端 UI 已移除 PAT 形态，但这条分支**不是死代码**（2026-09-21）
          //
          // 用户要求「不要 pat 登录，只要浏览器登录」，故 `plugin-src/client/account-hub.js`
          // 里的 PAT 表单与形态选择器已整体删除 —— **客户端不再发含 `pat` 的载荷**。
          // 但下面这条 `hasPat` 分支**刻意保留**，理由是它是**协议层**的分派
          // （对载荷形态的防御），不是 UI：
          //
          //   1. **headless / 脚本调用**：RPC 是对外协议面，不只有我们这个 UI 在调。
          //      带 `pat` 的请求仍然应当被正确处理，而不是收到一个含糊的
          //      `bad-request`；删掉它等于把「协议仍支持 PAT」这件事悄悄收回。
          //   2. **测试**：`qoder-rpc-dispatch` / `qoder-cn-rpc-dispatch` /
          //      `qoder-device-flow-rpc` 三处都直接驱动真实 HTTP 处理器发
          //      `{ provider, pat }`。它们是**协议分派**的回归，与 UI 形态无关，
          //      删实现就会连带删掉这些覆盖。
          //   3. **未来形态**：PAT 是不依赖浏览器的那条路（企业策略禁用弹窗、
          //      无头环境）。UI 入口收起来是产品决定，能力本身留着成本为零。
          //
          // 故**不要**因为「客户端不再发 pat」就删这一支 —— 那属于把产品决定
          // 误读成协议决定。库层（`src/qoder-auth.ts` 的 `loginWithPat`）同理保留。
          //
          // ## 两个 region 共用这两条分支（**同协议**，不要拆成四份）
          //
          // CN 与国际版的 exchange 请求逐字节同构（错误信封一致、PAT 前缀同为
          // `pt-`）、设备流三步也同构（只有域名不同）—— 差异**全部由传入的
          // auth 实例 / 产品配置承载**。拆开会把下面那些契约各抄一遍，任何一条
          // 改动漏了另一半就是静默分叉。
          //
          // ## ⚠️ 产品配置与 auth 实例必须**成对**取（两个 region 各一份）
          //
          // jt 缓存、在途 exchange 去重、失效标记、设备流互斥槽位都是
          // **实例 / 产品级**状态。用国际版实例换来的 `jt-` 打 CN 端点只会得到
          // 一次 401 —— 而错误文案会指向「PAT 失效」，把用户引去重签一张本来
          // 好用的凭据。同理设备流的 `loginUrl` 会指向错的授权页（用户在那
          // 一页上根本看不到自己的 CN 账号）。
          //
          // 故两处一律走 {@link qoderRegionFor}（唯一一处「哪个 region 用哪份
          // 配置与实例」的映射），不在这里就地拼。
          const region = qoderRegionFor(provider, qoder, qoderCn)
          if (region === undefined) {
            // 不可达：上面的分支条件已限定为两个 region 之一。保留这道闸是
            // 为了让将来新增 region 时**显式接线**，而不是静默落到国际版。
            return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
          }

          // ⚠️ 判据是「`pat` 这个**键**在不在载荷里」，不是「它的值非不非空」：
          // `{ pat: '' }` 是「用户提交了一个空 PAT」，属于 PAT 路径的非法输入
          // （应回「PAT 格式不正确」）；把它当成「无 pat」会静默改走设备流、
          // 开出一个用户没要求的授权页。客户端提交 PAT 表单时**总是**带这个键。
          const hasPat = typeof req.pat === 'string'

          if (hasPat) {
            // ===== 形态一：PAT 粘贴（**同步完成，无两段式**） =====
            //
            // PAT 验证是一次即时请求，不存在「等用户操作 10 分钟」的手势窗口，
            // 故这里**不建占位账号**：失败时没有「后台第二段」会去清理，
            // 先建占位就会留下一个永远没有凭据的幽灵账号。
            //
            // 四条契约（region 无关）：
            //   1. **同步完成**：`loginWithPat` 内部是「前缀校验 → exchange →
            //      落凭据 + 落账号」，返回时凭据已在盘上，客户端那套按「凭据
            //      可解析」判定的 `login.poll` 天然兼容；
            //   2. **PAT 绝不回显**：错误信息里不含 PAT 本体、长度或任何片段；
            //   3. **失败即拒绝**：`loginWithPat` 抛出的原因（前缀不对 /
            //      exchange 401 判 PAT 失效 / 网络失败）原样透传；
            //   4. **`loginUrl` 恒为空串**（无事可开）。客户端按 `loginUrl`
            //      决定是否开窗，空串正好表达这一点。
            try {
              const result = await region.auth.loginWithPat(req.pat as string, { refName, accountId: id, pool })
              return { ok: true, value: { accountId: id, loginUrl: result.loginUrl } }
            } catch (error) {
              // 前缀带上产品展示名：两区共用一条分支后，只说「Qoder 登录失败」
              // 会让拿着 CN PAT 的用户分不清该去哪张签发页重签。
              throw new Error(
                `${region.product.displayName} 登录失败：${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }

          // ===== 形态二：浏览器设备流（**两段式**） =====
          //
          //   1. **第一段（同步返回）**：`prepareLogin` 只建会话（本地生成
          //      PKCE、读写 machine_id，**一次网都不出**），拿到 `loginUrl` 后
          //      写占位条目并**立即** `return`；
          //   2. **宿主 opener 置空**：打开动作归客户端（宿主再开一次会变成
          //      两个标签页）。本分支根本不接收 `openBrowser`，用「不打开」
          //      表达同一约束；
          //   3. **第二段（后台）**：`persistLoginResult` 完成后写凭据并补全
          //      占位账号；失败则登记失败终态 + 移除占位。
          //
          // ⚠️ **第一段绝不能 await 用户操作**：设备流最长 5 分钟，等它返回时
          // 用户手势早已过期，客户端拿到 URL 再开窗会被弹窗拦截、兜底逻辑于是
          // 自行开窗把 DSH 页面顶掉 —— 这正是两段式要消灭的缺陷形态。
          let prepared
          try {
            prepared = await region.auth.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 ${region.product.displayName} 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。**原样返回可判别错误码**，
            // 而不是抛异常 —— 抛异常会被包装成 account-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 占位条目：满足 `login.poll` 的检测路径（它按「该 credentialRef
          // 能否解析到凭据」判完成）。三项 pending 形态字段都等第二段补全。
          await pool.addAccount({
            id,
            provider,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          pendingQoderDeviceLogins.set(id, { accountId: id, session: loginSession })
          void region.auth.persistLoginResult(loginSession, { refName, accountId: id, pool })
            .catch(async (error: unknown) => {
              ctx.logger.warn(
                `[account-hub] background ${provider} device login failed for ${id}: `
                + `${error instanceof Error ? error.message : String(error)}`,
              )
              // 登录失败是**终态**：登记后再删占位（顺序不可反 —— 见
              // `recordLoginFailure` 的说明）。
              recordLoginFailure(id, error)
              await pool.removeAccount(id).catch(() => {})
            })
            .finally(() => {
              pendingQoderDeviceLogins.delete(id)
            })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else {
          // 本入口**刻意不经过** `poolProviderFor()`：它按 provider 解析产品配置来
          // 决定登录怎么做，对未知 provider 一律拒绝。若把某个 provider 映射成
          // 宿主 provider，多出来的二次点击会派生第二个占位账号，而两者背后是
          // 同一份凭据体系 —— 等于把一个账号建两遍。宁可拒绝，不可静默重复建号。
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }

      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }

      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        // 若该账号正处于「等待浏览器登录」状态，先取消会话：否则它会一直占着
        // 127.0.0.1 的回调端口到 10 分钟超时；更糟的是 prepare 的互斥锁是
        // provider 级的 —— 旧会话不释放，用户删掉占位账号后想重新登录
        // 会一直拿到 `login-in-progress`，直到旧会话超时。
        pendingLobsteraiLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingLobsteraiLogins.delete(req.accountId)
        // CodeArts 同理（互斥同样是 provider 级的，且它占用的端口还要求 ≥10000）。
        pendingCodeartsLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingCodeartsLogins.delete(req.accountId)
        // Trae CN 同理（互斥同样是 provider 级的）。
        pendingTraeCnLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingTraeCnLogins.delete(req.accountId)
        // Qoder 设备流同理，但后果更重：它不占端口，却**每 1 秒轮询一次**，
        // 且互斥槽位不释放会让用户此后所有登录都被 `login-in-progress` 挡住。
        // ⚠️ 必须走 `cancelQoderDeviceLogin` 而不是只调会话的 `cancel()` ——
        // 槽位表在设备流模块内部，会话句柄的 cancel 已经会释放它，但这里
        // 还要覆盖「会话句柄拿不到」的兜底路径（登记表按 accountId 索引，
        // 而槽位按 provider 索引，两者不是同一把键）。
        pendingQoderDeviceLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingQoderDeviceLogins.delete(req.accountId)
        // 失败终态随账号一起清：账号已被用户主动删除，不该再有一条针对它的
        // 失败登记等着被下一次 poll 读到（那会让新登录的窗口无端收到旧失败）。
        loginFailures.delete(req.accountId)
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }

      case 'account.reorder': {
        // 拖拽排序：重写该 provider 账号在池中的顺序。
        // 该顺序是自动选号与限流换号的候选优先级（见 `AccountPool.reorderAccounts`），
        // 因此不是纯 UI 操作。⚠️ 客户端暂未发这个 RPC（UI 拖拽是第二阶段），
        // 入口先就位并单测，避免「后端语义有了但没接线」。
        const req = payload as RpcReorderAccountsRequest
        if (typeof req.provider !== 'string' || req.provider.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
          return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } }
        }
        try {
          await pool.reorderAccounts(poolProviderFor(req.provider), req.orderedIds)
        } catch (error) {
          // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
          // 刷新重试，而不是抛成 account-hub/handler-failed 那种「未知故障」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return { ok: true, value: undefined }
      }

      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，国际版（当年叫 `workbuddy`）会落到 else 抛
          //    `Unknown provider`，即该产品账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，国际版（当年叫 `workbuddy`）会落到 else 抛
          //    `Unknown provider`，即该产品账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          switch (entry.provider) {
            case 'codearts':
              await codearts.refreshAccountCredential(entry.credentialRef)
              break
            case BUDDY_CN.id:
              await buddyCn.refreshAccountCredential(entry.credentialRef)
              break
            case BUDDY.id:
              await buddy.refreshAccountCredential(entry.credentialRef)
              break
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef)
              break
            case TRAE_CN.id:
              await traeCn.refreshAccountCredential(entry.credentialRef)
              break
            case QODER.id:
              // 对 Qoder「刷新」= 重打一次 exchange 换新 jt（PAT 不变，随时可重打）。
              await qoder.refreshAccountCredential(entry.credentialRef)
              break
            case QODER_CN.id:
              // CN 与 国际版**各刷各的 auth 实例**：两者是两批账号（`entry.provider`
              // 就是 `qoder-cn`），而 jt 缓存与 exchange host 都按实例/产品取值。
              // 用国际版实例刷 CN 账号 = 拿 CN 的 PAT 打国际版 exchange 端点，
              // 结果是「PAT 已失效，请重新粘贴」—— 而那张 PAT 本来完全好用。
              await qoderCn.refreshAccountCredential(entry.credentialRef)
              break
            default:
              throw new Error(`Unknown provider: ${entry.provider}`)
          }
          return { ok: true, value: { success: true } }
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }

      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        // ① **失败终态优先**：第二段失败后占位账号已被删除，若先查账号条目就会
        //    落进 `!entry → done:false`，客户端永远等不到结算（本次修的缺陷 2）。
        //    读到即清：失败是一次性终态，避免同一 accountId 的陈旧失败污染下次登录。
        const failure = loginFailures.get(req.accountId)
        if (failure !== undefined) {
          loginFailures.delete(req.accountId)
          return { ok: true, value: { done: true, error: failure } }
        }
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // ② **非法 ref 预检**：`credentialRef()` 对不合规名称抛 TypeError
        //    （REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/）。裸用它会让 poll 被
        //    RPC 层包成 handler-failed，客户端把它当网络抖动吞掉继续轮询 ——
        //    又是一种「静默空等 5 分钟」。这里用官方导出的校验函数预检
        //    （与 credentialRef 同一个 REF_PATTERN，不本地复制正则），
        //    非法即回失败终态。这层防御覆盖「未来同类拼写错误」。
        if (!isCredentialRefName(entry.credentialRef)) {
          return { ok: true, value: { done: true, error: 'invalid-credential-ref' } }
        }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }

      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
        const account = await retestAccount(pool, req.accountId)
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length },
        }
      }

      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case 'account.retestAll': {
        const req = payload as RpcRetestAllRequest
        const value = await retestAllAccounts(pool, poolProviderFor(req.provider))
        return { ok: true, value }
      }

      // ── 限流标记：重置（不发请求，直接清除）──
      case 'account.reset': {
        const req = payload as RpcResetAccountRequest
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }

      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        const value = await resetAllAccounts(pool, poolProviderFor(req.provider))
        return { ok: true, value }
      }

      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // ⚠️ 三个积分端点（status / claimAll / balances）分派规则：
      //   - Buddy 系经 `productById()` 取产品配置；
      //   - `codearts`（华为云 SDK-HMAC-SHA256 签名）、`lobsterai`、
      //     `trae-cn`、Qoder 两区**各自提前分支** —— 它们都不是 BuddyProduct。
      // 只有**未知** provider 才会落到 bad-request。历史上 CodeArts 曾恒回
      // `unsupported provider: codearts`（客户端在面板挂载时无条件调用
      // credits.balances，于是每打开一次设置页都在控制台报错并把账号卡片标成
      // 查询失败）；现在 CodeArts 已有真实实现，客户端仍按
      // `plugin-src/client/credits-capabilities.js` 的能力矩阵在**发请求之前**门控。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        // provider → 池键（见 {@link poolProviderFor}）。
        const provider = poolProviderFor(req.provider)
        if (provider === 'codearts') {
          // CodeArts 没有独立的「签到状态」端点：可领状态要经
          // `statistics/plugin`（账户类型）+ `/v1/ops/delivery`（活动列表）
          // 两步才能得到，且语义与 Buddy 的 CheckinStatus 不同构
          //（无 streak_days / daily_credit 等概念）。
          // 故与 LobsterAI 同样如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (provider === LOBSTERAI.id) {
          // LobsterAI 没有独立的「签到状态」端点：活动状态要经
          // slot → context 两步才能得到，且语义与 Buddy 的
          // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
          // 故这里如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (provider === TRAE_CN.id) {
          // Trae CN **有**独立的状态端点（`checkin_credits/status`），但它只给出
          // 「今天领了没」与 `enable` 两项，其余字段（连续天数 / 每日积分 /
          // 活动名…）协议里没有已确认的对应字段，故由 fetchTraeCnCheckinStatus
          // 如实补零。与 LobsterAI 的「压根没有状态端点」不是同一种情况。
          const accounts = await pool.listAccounts(provider)
          const results = await collectCreditsStatus<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchStatus: (credential, product) =>
              fetchTraeCnCheckinStatus(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
        }
        if (provider === QODER.id || provider === QODER_CN.id) {
          // 两区都有签到：活动端点 `sash/api/v1/me/campaigns` 由 keylog 解密抓包
          // 解出并真机验证（2026-09-21，CN）；国际版 `qoder` 已真机探测
          // （2026-09-23）同一端点 200、响应与 CN 逐字节同构。`src/qoder-credits.ts`
          // 按传入的 `product` **现算 host**，两份 region 共用一份实现 —— 这里
          // 只借 {@link qoderRegionFor} 对齐「哪个 region 用哪份配置与实例」。
          const region = qoderRegionFor(req.provider, qoder, qoderCn)
          if (region === undefined) {
            return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
          }
          const qoderAccounts = await pool.listAccounts(provider)
          const results = await collectCreditsStatus<QoderCredential, QoderProduct>(qoderAccounts, region.product, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchStatus: (credential, product) =>
              fetchQoderCheckinStatus(credential, region.auth, {
                product,
                onDebug: (msg) => ctx.logger?.info?.(msg),
              }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
        }
        const product = productById(provider)
        if (product === undefined) {
          // ⚠️ 未知 provider 才落到这里拒绝。Qoder 两区已在上面各自的
          // `qoderRegionFor` 分支处理；`productById()`（Buddy 系）对它们返回
          // undefined，但上面已提前 return，故这条拒绝仅是未知 provider 的兜底。
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(provider)
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
      }

      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      // 分派逻辑抽到 {@link runCreditsClaim}，与自动签到（checkin.perform / sweep）共用，
      // 避免两处漂移。
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        // provider → 池键（见 {@link poolProviderFor}）。
        const provider = poolProviderFor(req.provider)
        const accounts = await pool.listAccounts(provider)
        let results: RpcCreditsClaimAccountResult[]
        try {
          results = await runCreditsClaim(checkinDeps, provider, accounts)
        } catch (error) {
          if (error instanceof UnsupportedProviderError) {
            return { ok: false, error: { code: 'bad-request', message: error.message } }
          }
          throw error
        }
        const summary = computeClaimSummary(results.map((r) => r.outcome))
        return { ok: true, value: { results, summary } satisfies RpcCreditsClaimAllResponse }
      }

      // ── 自动签到（Auto Check-in）──
      //
      // 三个端点与 claimAll 的关系：
      //   - `credits.checkinStatus`：**纯内存读**进程内 `checkins`，**不发任何网络
      //     请求**。供面板挂载时渲染「哪些账号今日已签」。未知/无签到能力 provider
      //     返回空 checkedIn（能力门控在客户端）。
      //   - `checkin.perform`：单账号（或 provider 全量）自动签到。**复用
      //     `credits.claimAll` 的同一份分派逻辑**（{@link runCreditsClaim}），差异仅
      //     在写 `writeCheckinDay`：成功或 already-claimed 都写今日，failed/inactive
      //     不写（下次 sweep 重试）。
      //   - `checkin.sweep`：全量 sweep，遍历 {@link CHECKIN_ELIGIBLE_PROVIDERS}，
      //     每 provider 只签「今日未签」的账号。模块级互斥防 4h 定时器与页面触发并发。
      case 'credits.checkinStatus': {
        const req = payload as RpcCheckinStatusRequest
        const provider = poolProviderFor(req.provider)
        const today = todayDayNumber()
        const accounts = await pool.listAccounts(provider)
        const checkedIn: Record<string, boolean> = {}
        for (const entry of accounts) {
          checkedIn[entry.id] = pool.checkinDay(provider, entry.id) === today
        }
        return { ok: true, value: { provider, today, checkedIn } satisfies RpcCheckinStatusResponse }
      }

      case 'checkin.perform': {
        const req = payload as RpcCheckinPerformRequest
        const provider = poolProviderFor(req.provider)
        if (typeof provider !== 'string' || provider.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        let value: RpcCheckinPerformResponse
        try {
          value = await performCheckin(provider, req.accountId)
        } catch (error) {
          if (error instanceof UnsupportedProviderError) {
            return { ok: false, error: { code: 'bad-request', message: error.message } }
          }
          throw error
        }
        return { ok: true, value: value satisfies RpcCheckinPerformResponse }
      }

      case 'checkin.sweep': {
        const value = await performCheckinSweep(checkinDeps)
        return { ok: true, value: value satisfies RpcCheckinSweepResponse }
      }

      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        // provider → 池键（见 {@link poolProviderFor}）。
        const provider = poolProviderFor(req.provider)
        const accounts = await pool.listAccounts(provider)
        if (provider === 'codearts') {
          // 余额来自 `statistics/plugin`（与账户类型检测**同一个响应**），
          // 故用带原因的钩子：非积分账户要显示「Token 计费账户」而不是
          // 误导性的「余额查询失败」——账户类型差异不是故障。
          const values = await collectCreditBalances<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalanceDetailed: async (credential) => {
              // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
              // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
              // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
              // 无信息量的「账户信息查询失败」）。
              const result = await fetchCodeArtsAccountInfoDetailed(credential)
              if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
              const info = result.info
              if (!info.isCreditPackage) {
                return {
                  balance: null,
                  error: info.isTokenPackage
                    ? 'Token 计费账户，无积分余额'
                    : '非积分计费账户，无积分余额',
                }
              }
              // 积分账户但没有 credit metric：如实报「未返回积分数据」，
              // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
              if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
              return { balance: info.credit }
            },
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (provider === TRAE_CN.id) {
          // Trae CN 面板显示**通用池**（`available_endpoint === 0`）—— IDE 对话
          // 扣的就是它，即本 provider 实际能花的钱。
          // ⚠️ 池是**路径属性**，与账号无关（账号池那条链路见上面的
          // {@link poolProviderFor}）：将来若再出现别的 Trae 路径，在这里按
          // `req.provider` 分支选池，而不是把池并进账号映射。
          const values = await collectCreditBalances<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) =>
              fetchTraeCnCreditBalance(credential, product, TRAE_CN_POOL_UNIVERSAL, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (provider === QODER.id || provider === QODER_CN.id) {
          // Qoder **只有一个池**（三池结构里另外两个本账号缺席，且它们同属这一个
          // 端点的同一个数字口径），故没有任何选池分支，不要为「形态对称」凭空造一个。
          // CN 同样如此：实测 CN 的 quota 响应只有 `userQuota` + `addOnQuota`，
          // `orgResourcePackage` 键**整个不存在** —— 而三池解析本来就是容缺的
          // （每个池独立解析，缺席 = 该池不存在），故**无需任何 CN 专属分支**。
          //
          // 第二个实参是本 region 的 auth 实例：额度端点**只认 `jt-`**
          // （PAT 打它回 401 `TOKEN_EXPIRE`），由 auth 负责换取与缓存；
          // 而 jt 缓存是**实例字段**，用错实例换来的是另一区的 jt。
          //
          // ⚠️ **第三个实参必须是本 region 的产品配置**（`region.product`）：
          // 它决定 `openapiBase`（额度端点 host）。传错会让请求打到另一区，
          // 表现为「凭据失效」而不是任何配置错误。
          const region = qoderRegionFor(req.provider, qoder, qoderCn)
          if (region === undefined) {
            return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
          }
          const values = await collectCreditBalances<QoderCredential, QoderProduct>(accounts, region.product, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) =>
              fetchQoderCreditBalance(credential, region.auth, {
                product,
                onDebug: (msg) => ctx.logger?.info?.(msg),
              }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        const product = productById(provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
      }

      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case 'model.list': {
        const req = payload as RpcModelListRequest
        const llm = llmServiceOf(ctx)
        if (llm === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
        }
        let models: Array<{ id: string; name: string }>
        try {
          // ⚠️ **即使下面可能不用它的结果，这一次调用也必须保留**：适配器的
          // `listAllModels()` 是**同步且不触发 IO** 的（它只读目录缓存），远端目录
          // 要靠 `listModels` 这一趟才会被拉取 / 刷新（`ensureRemoteModels` /
          // `ensureCatalog`）。去掉它，全量目录会永远停在静态兜底表上。
          models = await llm.listModels(req.provider)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
        }
        // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
        // 下一次 listModels 就会应用新的过滤结果。
        const disabledMap = pool.listDisabledModels(req.provider)
        // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：两个适配器
        // （llm-adapter.ts / buddy-adapter.ts）的 listModels 内部都会实时
        // `filter(m => !disabledModelsFor(provider).has(m.id))`。若直接对这个
        // 结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
        // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
        // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
        // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
        //
        // 因此这里以黑名单为准做并集：凡是「黑名单里为 true、却已不在
        // 目录结果中」的模型，补回列表并标记为已关闭。设置页据此始终能
        // 渲染出全部开关；而对话框模型选择器读的仍是过滤后的 listModels，
        // 可见性行为完全不变。
        //
        // ⚠️ **目录来源优先用适配器的 `listAllModels()`**（`modelAdapters` 注入）：
        // 它**不套黑名单、也不套账号门控**，且带**最终展示名**（含倍率 / 多模态名）。
        // 少了它会有两个后果：① 补回行只能显示裸 id（用户报障「关闭的就没有显示
        // 倍率」）；② **没有已登录账号的 provider** 在设置页会一行都不剩 —— 门控让
        // `listModels` 返回 `[]`（对话框里整个分组隐藏，这是需求本身），但「显示
        // 列表」必须照常列出全部模型开关，否则用户连模型名单都看不到。
        // 适配器实例不存在时（外部 / 旧适配器）退化为历史行为。
        //
        // ⚠️ 回填必须先过垃圾判定（2026-09-20 修复的黑名单并集泄漏）：回填的
        // 候选是**黑名单的键名**——它们不只是「用户显式关过的正常模型」，还包括
        // 用户在目录过滤网上线之前关掉的那批 custom / invisible / 内部项，以及
        // 目录那次快照里存在、后来下线的 id。真机实测：目录 13 项 + 黑名单 30 个
        // 历史键 = 弹窗 43 行，其中 14 个 `custom_model_*` 是**账号私有 BYOK**
        // （别的账号选中必失败），用户在界面上完全无法分辨它们从哪来。
        // 更糟的是副作用：这些键已在黑名单里，用户点开关只会在**同一批键上**
        // 增删，列表永远清不掉这批僵尸行。
        //
        // 判据与目录侧**同源**（`isTraeCnJunkModelId`，见 src/trae-cn-models.ts），
        // 且只对 Trae 系 provider 生效：其它 provider 的黑名单语义没变（它们的
        // 历史行为原样保留，见 README 的「显示列表的回填机制与过滤」）。
        const isTraeProvider = req.provider === TRAE_CN.id
        const junkBackfilled = (id: string): boolean => isTraeProvider && isTraeCnJunkModelId(id)
        // 全量目录（不套黑名单 / 不套门控），缺失时回退 `listModels` 的结果。
        const allModels = modelAdapters?.[req.provider]?.listAllModels()
        const catalog: ReadonlyArray<{ id: string; name: string }> =
          allModels === undefined ? models : [...allModels]
        const listedIds = new Set(catalog.map((model) => model.id))
        const filteredOut = Object.keys(disabledMap)
          .filter((id) => disabledMap[id] === true && !listedIds.has(id) && !junkBackfilled(id))
        // 逐模型窗口档位：**问注册表要本 provider 的来源**（不再对 provider
        // 名字写特判）。未注册 = 该 provider 没有档位数据，缺省即「不渲染档位列」。
        //
        // 读失败**不影响列表本身**：档位是附加信息，拿不到就不渲染那一列，
        // 而不是让整个「显示列表」报错（用户会以为模型目录没了）。
        let tiers: ReadonlyMap<string, ContextTier> | undefined
        const tierSource = contextTiers?.sourceFor(req.provider)
        if (tierSource !== undefined) {
          try {
            tiers = await tierSource.contextTiers()
          } catch (error) {
            ctx.logger?.warn?.(`[account-hub] 读取 ${req.provider} 窗口档位失败（不影响模型列表）: ${String(error)}`)
          }
        }
        // ⚠️ 窗口字段对**目录里的模型**与**回填行**一视同仁（2026-09-21 修复）：
        // 档位数据来自适配器目录（`contextTiers`），**与用户的显示开关无关** ——
        // 被关掉的模型只是从 listModels 里消失，它在目录里照样有 dev / Max 档。
        // 早前只在 `models.map(...)` 那一支加窗口字段，于是回填行（正是被关闭的
        // 那些）一律不带档位 ⇒ 用户报障「只有开启后才能选上下文档位」：关掉模型
        // 想顺手改档，档位列整个不见了。修法就是把同一份 tiers 也用在回填行上，
        // 而不是另算一套判据。
        //
        // 回填行的名字走 `tierSource.displayName` 两级查名（2026-09-21 修复，见
        // 下方组装处）；`withWindows` 只加字段、不改 name，两者天然相容。
        //
        // ⚠️ **三个窗口字段的判据都只依赖目录数据**（`tier` 与 `budget`），不依赖
        // 用户提交过什么：
        // - `contextWindow` = 生效的默认档（Trae CN 的 dev / Qoder 的最小档 /
        //   Buddy 的最大档，口径各自由解析侧决定）；
        // - `maxContextWindow` = Trae CN 的两档形态专有字段（其余 provider 用
        //   `contextTiers` 承载整张表）；
        // - `contextTiers` = 归一后的**完整档位表**（升序去重，**≥2 档才带**）——
        //   客户端据此渲染任意档数的单选列，不再假设「只有默认 / Max 两档」；
        // - `contextBudget` = 当前存储的用户选择（UI 的选中态）。
        const withWindows = (entry: { id: string; name: string; disabled: boolean }): RpcModelListEntry => {
          if (tiers === undefined) return entry
          const tier = tiers.get(entry.id)
          if (tier === undefined) return entry
          const budget = pool.contextBudget(req.provider, entry.id)
          const available = availableContextTiers(tier)
          return {
            ...entry,
            ...tier.contextWindow === undefined ? {} : { contextWindow: tier.contextWindow },
            ...tier.maxContextWindow === undefined ? {} : { maxContextWindow: tier.maxContextWindow },
            ...available.length >= 2 ? { contextTiers: available } : {},
            ...budget === undefined ? {} : { contextBudget: budget },
          }
        }
        const value: RpcModelListResponse = {
          models: [
            ...catalog.map((model) => withWindows({
              id: model.id,
              name: model.name,
              disabled: disabledMap[model.id] === true,
            })),
            // 回填行：名字两级查（2026-09-21 修复，症状一）—— 黑名单并集回填
            // 此前写死 `name = id`，目录不可达时用户看到的每行都是一串短 key。
            // 现在 `tierSource.displayName` 能查到目录/静态表的原始展示名就带名
            // （Qoder 两区），查不到仍回退 id（与既有行为一致，宁缺毋编）——
            // 但静态表有名的必须带名（`qmodel_38max` → `Qwen3.8-Max`）。
            // 档位字段照常补（见上面 `withWindows` 的说明）。
            ...filteredOut.map((id) => withWindows({
              id,
              name: tierSource?.displayName?.(id) ?? id,
              disabled: true,
            })),
          ],
          // 目录来源（C3）：只有实现了该能力的适配器（Qoder 两区）会带；
          // 缺省 = 客户端不渲染「兜底清单」提示行。
          ...(tierSource?.catalogSource !== undefined
            ? { catalogSource: tierSource.catalogSource() }
            : {}),
        }
        // **顺手清尸**：把命中垃圾判定的键从黑名单里真正剔除并写回 settings。
        // 只过滤不清理的话，僵尸键会永远留在配置文件里 —— 列表虽然干净了，
        // 但每次 `model.list` 都要再判一遍，且用户换回旧版本插件时它们会重新
        // 冒出来。清理**只针对垃圾键**：正常被关闭的模型哪怕暂时不在目录里
        // （如模型临时下线）也**必须保留**，否则用户会发现「关掉的模型自己
        // 又打开了」—— 这正是回填机制存在的理由。
        //
        // 走 `setModelDisabled(id, false)` 而不是自己写 settings：它是账号池
        // 公开的开关入口，写入是「读 → 改 → **整体 replace**」且已携带 accounts
        // 与 schemaVersion（漏带会把账号列表或数据版本号清空，见 account-pool.ts
        // 的 writeModels 注释）。代价是每个键一次写盘 —— 一次性清理，且清完
        // 即不再触发（下面的 `junkKeys.length > 0` 门），不值得为此新开一个
        // 批量入口。
        //
        // 失败不影响本次响应：列表已经算好了，清理是尽力而为的副作用。
        if (isTraeProvider) {
          const junkKeys = Object.keys(disabledMap).filter((id) => isTraeCnJunkModelId(id))
          if (junkKeys.length > 0) {
            try {
              for (const id of junkKeys) {
                await pool.setModelDisabled(req.provider, id, false)
              }
              ctx.logger?.info?.(
                `[account-hub] 已从 ${req.provider} 显示列表清理 ${junkKeys.length} 个垃圾模型键`,
              )
            } catch (error) {
              ctx.logger?.warn?.(`[account-hub] 清理 ${req.provider} 垃圾模型键失败: ${String(error)}`)
            }
          }
        }
        return { ok: true, value }
      }

      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一轮模型目录刷新即生效。
      case 'model.setDisabled': {
        const req = payload as RpcModelSetDisabledRequest
        if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } }
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true)
        ctx.logger.info(
          `[account-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      // 设置某个模型的**上下文窗口档位**。
      //
      // ⚠️ **纯声明值切换**：只改「我们向 DSH 声明的窗口」，出站请求体一个字段都不动
      // （各 provider 的 chat 体里本来就没有档位字段，见 `effectiveContextWindow`）。
      // 声明值决定宿主的压缩阈值（`0.8 × 窗口`）与压缩后的保留预算。
      //
      // 推广到全部供应商后，本层的判据**一个 provider 名都不提**：问注册表要该
      // provider 的档位来源（没有就拒绝），再从来源的目录里取该模型的档位表。
      // 校验全部在这里做：只有本层同时握着「目录公布的档位」与「用户提交的值」。
      // 适配器读取时会**再判一次**是否精确命中某个档位，两道判据同向 ——
      // 即便有人绕过这里写入编造值，最坏也只是静默退回默认档。
      case 'model.setContextBudget': {
        const req = payload as RpcModelSetContextBudgetRequest
        if (typeof req.provider !== 'string' || typeof req.model !== 'string' || req.model.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 model 必填' } }
        }
        // 未注册的 provider 一律拒绝，而不是静默写下一个永远不生效的值：
        // 没有目录就没有校验依据，而「写进去却不生效」比拒绝更难排查。
        const tierSource = contextTiers?.sourceFor(req.provider)
        if (tierSource === undefined) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `provider 不支持上下文窗口档位: ${req.provider}` },
          }
        }
        const tiers = await tierSource.contextTiers()
        const tier = tiers.get(req.model)
        const fallback = tier?.contextWindow
        // 目录里没有该模型，或该模型没声明窗口（含静态回退表路径：它一律不带档位表，
        // 连 `contextWindow` 也可能因为目录未达而缺失）——都无法判档位，拒绝。
        if (fallback === undefined) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: `模型 ${req.model} 当前目录未声明上下文窗口，无法设置档位`,
            },
          }
        }
        // 可选的档位 = 目录公布的**全部**窗口（升序去重；默认档必在其中）。
        // 错误信息里**带上实际可用的档位值**：用户提交了一个编造数字时，
        // 他需要看到的是「有哪些档位可选」，而不是一句「参数非法」。
        const available = availableContextTiers(tier)
        const description = describeContextTiers(available, fallback)
        // 恢复默认：`window` 省略，或恰好等于默认档。两者都清除预算
        // （**不是**写入默认档）。
        if (req.window === undefined || req.window === fallback) {
          await pool.writeContextBudget(req.provider, req.model, undefined)
          ctx.logger.info(`[account-hub] ${req.provider}/${req.model} 上下文窗口档位恢复默认（${fallback}）`)
          const restored: RpcModelSetContextBudgetResponse = { provider: req.provider, model: req.model }
          return { ok: true, value: restored }
        }
        // 只接受**精确等于**目录公布的某个档位；其余（含编造值、目录漂移后的旧值）
        // 全部拒绝。单档模型没有任何非默认档，等价于「只接受默认档」。
        if (!available.includes(req.window)) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: `不支持 ${String(req.window)}：模型 ${req.model} 可用档位为 ${description}`,
            },
          }
        }
        await pool.writeContextBudget(req.provider, req.model, req.window)
        ctx.logger.info(`[account-hub] ${req.provider}/${req.model} 上下文窗口档位设为 ${req.window}`)
        const applied: RpcModelSetContextBudgetResponse = {
          provider: req.provider,
          model: req.model,
          contextBudget: req.window,
        }
        return { ok: true, value: applied }
      }

      default:
        return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
}

/** 构造带 rpcId 的响应 JSON */
function reply(rpcId: string, result: unknown): Response {
  const value = typeof result === 'object' && result !== null && (result as Record<string, unknown>).ok === false
    ? { ...result as Record<string, unknown>, error: { ...(result as Record<string, unknown>).error as Record<string, unknown>, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
