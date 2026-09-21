/**
 * Account Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled / model.setContextBudget
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
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
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance,
} from './lobsterai-credits.js'
import { TRAE_CN } from './trae-cn-product.js'
import { TRAE_CN_WORK } from './trae-cn-work-product.js'
import { QODER, QODER_CN, qoderProductById } from './qoder-product.js'
import { fetchQoderCreditBalance } from './qoder-credits.js'
import type { QoderCredential, QoderProduct } from './qoder-product.js'
import { isTraeCnJunkModelId } from './trae-cn-models.js'
import type { TraeCnContextTier } from './trae-cn-adapter.js'
import type { TraeCnCredential, TraeCnPendingLogin } from './trae-cn-oauth.js'
import type { QoderDevicePendingLogin } from './qoder-device-flow.js'
import type { TraeCnProduct } from './trae-cn-product.js'
import {
  TRAE_CN_POOL_UNIVERSAL,
  TRAE_CN_POOL_WORK,
  claimTraeCnDailyCheckin,
  fetchTraeCnCheckinStatus,
  fetchTraeCnCreditBalance,
  type TraeCnPoolId,
} from './trae-cn-credits.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
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
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

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
 * provider id → **账号池的 provider 键**（未映射的 provider 原样返回）。
 *
 * ## 为什么需要它
 *
 * 绝大多数 provider 的路由名与账号池键是同一个字符串，但 **`trae-cn-work`
 * 不是**：Work 没有独立登录，账号、凭据（`TRAE_CN_ACCOUNT_*`）与限流切换全部
 * 复用 `trae-cn`（详见 `src/trae-cn-work-product.ts` 的 `poolProviderId`）。
 * Account Hub 的 Work 面板必须列出 `provider === 'trae-cn'` 的那批账号，
 * 否则面板是空的；积分余额也必须查同一批账号的同一个端点。
 *
 * ## 为什么收敛在这里（客户端不映射）
 *
 * 三个理由，缺一不可：
 *
 * 1. **它取代的正是宿主侧既有的字面量分支**。积分三端点原先硬编码
 *    `req.provider === TRAE_CN.id`，账号列表走 `pool.listAccounts(req.provider)`。
 *    若把映射放在客户端，宿主这三个分支**必须一起改**（否则积分端点仍会以
 *    `productById('trae-cn-work')` 判成 unsupported），等于同一件事写两遍；
 * 2. **这是同一个概念的宿主侧落点**。池键的真相源是 `TraeCnWorkProduct.poolProviderId`，
 *    把映射写成引用该常量、而不是再抄一遍 `'trae-cn'` 字面量，两个方向就永远同步；
 * 3. **它让「面板 id 与池键不同」这件事只在一个函数里可见**。将来再加
 *    「复用别人账号」的 provider，只需在这里加一行，而不是把 if 撒进客户端
 *    六处调用点（账号列表 / 余额 / 签到状态 / 领取 / 重测 / 重置）。
 *
 * ## 刻意**不**映射的两个入口
 *
 * - **`account.create`**：`trae-cn-work` 没有独立登录，面板也不渲染「+ 新建账号」。
 *    这里若把它映射成 `trae-cn`，两次点击会派生出两个 `trae-cn-<shortId>` 占位
 *    账号，而它们背后是同一份凭据体系 —— 一个账号被建两次。故该入口对未知
 *    provider 的拒绝行为**保持不变**（宁可拒绝，不可静默重复建号）。
 * - **`login.poll`**：轮询的键是 accountId + 该账号自己的 provider，与面板 id 无关。
 */
export function poolProviderFor(provider: string): string {
  if (provider === TRAE_CN_WORK.id) return TRAE_CN_WORK.poolProviderId
  return provider
}

/**
 * 面板 id → **积分池**（余额显示口径；未映射的 provider 取通用池）。
 *
 * ## 与 {@link poolProviderFor} 是**两个不同的问题**，不要合并
 *
 * | 问题 | 函数 | `trae-cn` | `trae-cn-work` |
 * |---|---|---|---|
 * | **查谁的账号 / 打哪个端点** | {@link poolProviderFor} | `trae-cn` | `trae-cn`（映射过去） |
 * | **显示哪个积分池** | 本函数 | 通用池（0） | Work 池（1） |
 *
 * 前者必须把两个面板映射到**同一个键**（它们查的就是同一批账号与同一个端点），
 * 后者必须把它们**分成两个池**（各自只能花自己那个）。把两者混为一谈，就会
 * 出现「两个面板显示同一个池」——而且**不报错**：数字看着正常，只是 Work 面板
 * 显示的是它花不掉的那笔钱。
 *
 * ## 语义锚点
 *
 * **面板显示的数字 = 该 provider 实际能花的池**：Trae CN 面板显示通用池
 * （IDE 对话扣的），Trae CN Work 面板显示 Work 池（TraeWork 网页版能花的）。
 * 两个池互不通用，故各自只显示自己那一个。
 *
 * 取通用池是**默认值而非兜底猜测**：本函数目前只被 Trae 的余额分支调用，
 * 而该分支的守卫是 `provider === TRAE_CN.id`，即调用方只可能是 `trae-cn` 或
 * `trae-cn-work`；写成「非 Work 即通用」使将来新增的 Trae 路径默认看到
 * IDE 那个池（本插件主路径消耗的池），而不是看到一个空池。
 */
export function traeCnPoolFor(provider: string): TraeCnPoolId {
  return provider === TRAE_CN_WORK.id ? TRAE_CN_POOL_WORK : TRAE_CN_POOL_UNIVERSAL
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
 * ## 与 `poolProviderFor` / `traeCnPoolFor` 的区别
 *
 * 那两者答的是「面板 id 该查哪个池 / 显示哪个池」，本函数答的是「这个 region
 * 该用哪份配置与哪个实例」。Qoder **没有**池映射（两区是两批账号），故
 * `qoder-cn` 既不被映射到 `qoder`，也不反向映射 —— 这正是与国际版账号隔离的
 * 实现方式，与 `trae-cn-work` 的「复用池」方向刻意相反。
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
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  const fetchStatus = deps.fetchStatus ?? (fetchCheckinStatus as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchStatus']>)
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
      deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
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
  const fetchStatus = deps.fetchStatus ?? (fetchCheckinStatus as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchStatus']>)
  const claim = deps.claim ?? (claimDailyCheckin as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['claim']>)
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
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
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
  const fetchBalance = deps.fetchBalance ?? (fetchCreditBalance as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchBalance']>)
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
        balance = await fetchBalance(credential, product)
        // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
        if (balance === null) error = '余额查询失败'
      }
    } catch (caught) {
      deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
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
 * 逐模型**上下文窗口档位**的来源（目前只有 `TraeCnAdapter` 实现它）。
 *
 * ## 为什么由调用方注入，而不是 RPC 自己去捞
 *
 * 目录的持有者是**适配器实例**（它带 12h TTL 缓存、远端优先、失败回退静态表）。
 * `ctx.llm.listModels()` 帮不上忙：`LlmRuntime.listModels` 会把适配器返回的条目
 * **重建**成 `{provider, id, name, description?, inputModalities?}`，任何额外字段都
 * 在那一层被丢掉（已读 `lib/types/index.js` 确认），所以窗口档位不可能搭它的车。
 * 而 `ctx` 上也没有「按 provider 取适配器」的入口。最省事、也最不可能撒谎的做法，
 * 就是让组装方（`src/index.ts`）把 `registerTraeCnLlm` 返回的实例直接交过来。
 *
 * 结构类型而非 import 适配器类：RPC 层只消费这一个方法。
 */
export interface ContextTierSource {
  /** 当前生效目录的逐模型档位（id → dev / Max）。 */
  contextTiers(): Promise<ReadonlyMap<string, TraeCnContextTier>>
}

/**
 * 注册 Account Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 *
 * @param contextTiers - 可选的窗口档位来源（见 {@link ContextTierSource}）。
 *        省略时 `model.list` 不带窗口字段、`model.setContextBudget` 一律拒绝 ——
 *        这是 headless / 测试场景的既定降级，不是缺陷。
 */
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddyCn: BuddyAuth,
  buddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  traeCn: TraeCnAuth,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
  contextTiers?: ContextTierSource,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerJetHubEndpoints(
      connectionCtx as Context, pool, codearts, buddyCn, buddy, lobsterai, traeCn, qoder, qoderCn, contextTiers,
    )
  })
}

/** 注册 Account Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddyCn: BuddyAuth,
  buddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  traeCn: TraeCnAuth,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
  contextTiers: ContextTierSource | undefined,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  connection.fetch.register({
    path: JET_HUB_API_PATH,
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
        || message.method !== JET_HUB_ENDPOINT
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
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'jet-hub/handler-failed', message },
        })
      }
    },
  })

  /** 分发端点方法到对应的处理器 */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        // 面板 id → 池键的映射：`trae-cn-work` 面板列出的是 `trae-cn` 的账号
        //（它们就是能跑 Work 路径的账号）。见 {@link poolProviderFor}。
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
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`)
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
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
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
              `[jet-hub] background codearts login failed for ${id}: `
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
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
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
              `[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: `
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
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
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
              `[jet-hub] background ${TRAE_CN.id} login failed for ${id}: `
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
          // 用户要求「不要 pat 登录，只要浏览器登录」，故 `plugin-src/client/jet-hub.js`
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
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
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
                `[jet-hub] background ${provider} device login failed for ${id}: `
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
          // 刻意**不做** `poolProviderFor()` 映射：`trae-cn-work` 没有独立登录，
          // 面板也不渲染「+ 新建账号」。若这里把它映射成 `trae-cn`，多出来的
          // 二次点击会派生第二个 `trae-cn-<shortId>` 占位账号，而两者背后是
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
      // ⚠️ 三个积分端点（status / claimAll / balances）都以 `productById()`
      // 判能力，而 **CodeArts 不是 BuddyProduct**（华为云账号体系没有腾讯计费
      // 接口），因此 `codearts` 必定落到下面的 bad-request。这是正确且必要的
      // 拒绝，但客户端**不应**把这条错误当作运行时故障去展示：它应当在发请求
      // 之前就按 `plugin-src/client/credits-capabilities.js` 的能力矩阵判掉
      // （历史缺陷：CodeArts 面板挂载时无条件调用 credits.balances，导致每次
      // 打开设置页都在控制台报 unsupported provider 并把账号卡片标成查询失败）。
      // 此处的拒绝是兜底与契约声明，不是常规路径。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        // provider → 池键：`trae-cn-work` 与 `trae-cn` 是同一批账号，
        // 签到状态自然也是同一份（见 {@link poolProviderFor}）。
        const provider = poolProviderFor(req.provider)
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
          //
          // `trae-cn-work` 也会落到这里（poolProviderFor 把它映射成 `trae-cn`）：
          // Work 面板不渲染签到按钮，但**端点仍如实工作** —— 客户端不渲染只是
          // UI 便利，不是安全边界，这与 `credits.balances` 的既有约定一致。
          const accounts = await pool.listAccounts(provider)
          const results = await collectCreditsStatus<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchStatus: (credential, product) =>
              fetchTraeCnCheckinStatus(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
        }
        const product = productById(provider)
        if (product === undefined) {
          // ⚠️ **Qoder 系两个 region 都刻意落到这里**（`qoder` 与 `qoder-cn`）：
          // 它们**没有公开的签到接口**（官方每日 100 Credits 只能在 Qoder 桌面
          // App 手动领），故 `unsupported provider: qoder-cn` 是**正确契约**，
          // 不是漏加分支。客户端靠 `credits-capabilities.js` 的
          // `dailyCheckin: false` 在**发请求之前**就不发（`loadCredits` /
          // `claimCredits` 各有一道守卫）。
          // 判据是 `productById()`（Buddy 系）—— Qoder 的产品配置是
          // `QoderProduct`，**任何 region 都不会命中它**，故这条拒绝是结构性的、
          // 不需要为 CN 单独写一行。
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
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        // 与 status 同源：`trae-cn-work` 走 trae-cn 的同一批账号。
        const provider = poolProviderFor(req.provider)
        const accounts = await pool.listAccounts(provider)
        if (provider === LOBSTERAI.id) {
          // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
          //（带缓存，通常无额外网络开销）。
          const clientVersion = await lobsterai.resolveClientVersion()
          const value = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimLobsteraiDailyCheckin(credential, product, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (provider === TRAE_CN.id) {
          // Trae CN 的领取流程**自身**就是两步（status → 未领则 claim），
          // 内部已按 `checked_in` 幂等预检 —— 外部再查一次纯属重复请求，
          // 故与其他多步流程（LobsterAI）一样传 precheckStatus: false。
          const value = await collectClaimResults<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimTraeCnDailyCheckin(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        const product = productById(provider)
        if (product === undefined) {
          // ⚠️ **Qoder 系两个 region 都刻意落到这里** —— 理由与 `credits.status`
          // 处那条同源（没有公开的签到接口，`dailyCheckin: false` 由能力矩阵在
          // 发请求之前挡掉）。这里是**契约声明**，不是待补的分支。
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }

      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        // **Account Hub 的 Work 面板就靠这一行拿到余额**：`trae-cn-work` →
        // `trae-cn`，同一批账号、同一个端点。刻意不新写一套 Work 专用逻辑
        // —— 余额**账号**属性是共用的，但**显示哪个池**是路径属性，见下。
        const provider = poolProviderFor(req.provider)
        const accounts = await pool.listAccounts(provider)
        if (provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (provider === TRAE_CN.id) {
          // ⚠️ 选池用 **`req.provider`（面板 id）而不是上面映射后的 `provider`**：
          // 两个面板查的是同一份响应，但**显示的是各自能花的池** —— Trae CN 面板
          // 显示通用池（IDE 对话扣的），Trae CN Work 面板显示 Work 池（TraeWork
          // 能花的）。若误用 `provider`，两个面板都会显示通用池，而 Work 面板
          // 的数字将永远不是它实际能花的钱（静默且方向一致地错）。
          const pool = traeCnPoolFor(req.provider)
          const values = await collectCreditBalances<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) =>
              fetchTraeCnCreditBalance(credential, product, pool, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (provider === QODER.id || provider === QODER_CN.id) {
          // Qoder **只有一个池**（三池结构里另外两个本账号缺席，且它们同属这一个
          // 端点的同一个数字口径），故没有任何选池映射 —— 与 Trae 系那条
          // `traeCnPoolFor()` 刻意不同，不要为「形态对称」凭空造一个。
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
        // listModels 结果中」的模型，补回列表并标记为已关闭。设置页据此始终能
        // 渲染出全部开关；而对话框模型选择器读的仍是过滤后的 listModels，
        // 可见性行为完全不变。
        //
        // ⚠️ **回填必须先过垃圾判定**（2026-09-20 修复的黑名单并集泄漏）：回填的
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
        const isTraeProvider = req.provider === TRAE_CN.id || req.provider === TRAE_CN_WORK.id
        const junkBackfilled = (id: string): boolean => isTraeProvider && isTraeCnJunkModelId(id)
        const listedIds = new Set(models.map((model) => model.id))
        const filteredOut = Object.keys(disabledMap)
          .filter((id) => disabledMap[id] === true && !listedIds.has(id) && !junkBackfilled(id))
        // 逐模型窗口档位：**只有 Trae CN 有**（其余 provider 的适配器不产出窗口元数据，
        // 也没人把 `contextTiers` 交进来）。缺省即「不渲染档位列」。
        //
        // 读失败**不影响列表本身**：档位是附加信息，拿不到就不渲染那一列，
        // 而不是让整个「显示列表」报错（用户会以为模型目录没了）。
        let tiers: ReadonlyMap<string, TraeCnContextTier> | undefined
        if (req.provider === TRAE_CN.id && contextTiers !== undefined) {
          try {
            tiers = await contextTiers.contextTiers()
          } catch (error) {
            ctx.logger?.warn?.(`[jet-hub] 读取 ${req.provider} 窗口档位失败（不影响模型列表）: ${String(error)}`)
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
        // 回填行走 `name = id`（拿不到原始展示名，见下），`withWindows` 只加字段、
        // 不改 name，两者天然相容。
        const withWindows = (entry: { id: string; name: string; disabled: boolean }): RpcModelListEntry => {
          if (tiers === undefined) return entry
          const tier = tiers.get(entry.id)
          if (tier === undefined) return entry
          const budget = pool.contextBudget(req.provider, entry.id)
          return {
            ...entry,
            ...tier.contextWindow === undefined ? {} : { contextWindow: tier.contextWindow },
            ...tier.maxContextWindow === undefined ? {} : { maxContextWindow: tier.maxContextWindow },
            ...budget === undefined ? {} : { contextBudget: budget },
          }
        }
        const value: RpcModelListResponse = {
          models: [
            ...models.map((model) => withWindows({
              id: model.id,
              name: model.name,
              disabled: disabledMap[model.id] === true,
            })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            // 档位字段照常补（见上面 `withWindows` 的说明）。
            ...filteredOut.map((id) => withWindows({ id, name: id, disabled: true })),
          ],
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
                `[jet-hub] 已从 ${req.provider} 显示列表清理 ${junkKeys.length} 个垃圾模型键`,
              )
            } catch (error) {
              ctx.logger?.warn?.(`[jet-hub] 清理 ${req.provider} 垃圾模型键失败: ${String(error)}`)
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
          `[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      // 设置某个模型的**上下文窗口档位**（dev / Max）。
      //
      // ⚠️ **纯声明值切换**：只改「我们向 DSH 声明的窗口」，出站请求体一个字段都不动
      // （Trae 的 chat 体里本来就没有档位字段，见 `TraeCnAdapter.effectiveContextWindow`）。
      // 声明值决定宿主的压缩阈值（`0.8 × 窗口`）与压缩后的保留预算。
      //
      // 校验全部在这里做：只有本层同时握着「目录公布的档位」与「用户提交的值」。
      // 适配器读取时会**再判一次**是否精确命中 Max 档，两道判据同向 ——
      // 即便有人绕过这里写入编造值，最坏也只是静默退回默认档。
      case 'model.setContextBudget': {
        const req = payload as RpcModelSetContextBudgetRequest
        if (typeof req.provider !== 'string' || typeof req.model !== 'string' || req.model.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 model 必填' } }
        }
        // 目前只有 Trae CN 有逐模型档位：Work 侧目录实测 `dev == max`（无档位可选），
        // 其余 provider 的适配器根本不产出窗口元数据。对它们直接拒绝，
        // 而不是静默写下一个永远不生效的值。
        if (req.provider !== TRAE_CN.id || contextTiers === undefined) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `provider 不支持上下文窗口档位: ${req.provider}` },
          }
        }
        const tiers = await contextTiers.contextTiers()
        const tier = tiers.get(req.model)
        const fallback = tier?.contextWindow
        const max = tier?.maxContextWindow
        // 目录里没有该模型，或该模型没声明窗口（含静态回退表路径：它一律不带 Max 档，
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
        // 错误信息里**带上实际可用的档位值**：用户提交了一个编造数字时，
        // 他需要看到的是「有哪些档位可选」，而不是一句「参数非法」。
        const available = max === undefined
          ? `${fallback}（默认）`
          : `${fallback}（默认）/ ${max}（Max）`
        // 恢复默认：`window` 省略，或恰好等于 dev 档。两者都清除预算（**不是**写入 dev）。
        if (req.window === undefined || req.window === fallback) {
          await pool.writeContextBudget(req.provider, req.model, undefined)
          ctx.logger.info(`[jet-hub] ${req.provider}/${req.model} 上下文窗口档位恢复默认（${fallback}）`)
          const restored: RpcModelSetContextBudgetResponse = { provider: req.provider, model: req.model }
          return { ok: true, value: restored }
        }
        // 只接受**精确等于**目录公布的 Max 档；max 缺失时任何非 dev 值都拒绝。
        if (max === undefined || req.window !== max) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: `不支持 ${String(req.window)}：模型 ${req.model} 可用档位为 ${available}`,
            },
          }
        }
        await pool.writeContextBudget(req.provider, req.model, max)
        ctx.logger.info(`[jet-hub] ${req.provider}/${req.model} 上下文窗口档位设为 ${max}`)
        const applied: RpcModelSetContextBudgetResponse = {
          provider: req.provider,
          model: req.model,
          contextBudget: max,
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
