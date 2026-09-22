/**
 * Trae CN（字节跳动 Trae 国内版）每日签到与积分余额。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）/ `src/lobsterai-credits.ts` **刻意分开**：
 * 三条协议没有一处共用（端点、信封、鉴权头、幂等判据全不同），硬合并只会让
 * 某一个文件出现大量 `if (provider === …)` 分支。但**复用 `credits.ts` 的类型**，
 * 让 `computeClaimSummary`、`collectCreditsStatus` / `collectClaimResults` /
 * `collectCreditBalances` 三个收集器与前端的结果摘要 UI 都不必各写一份 ——
 * Trae 只需注入自己的下钻函数（见 `src/jet-hub-rpc.ts` 的三处分发），
 * 唯一的类型改动是补上显式类型参数（因为 Trae 的凭据不是 `BuddyCredential`）。
 *
 * ## 协议（调研实测）
 *
 * ```
 * 状态  POST {apiBase}/trae/api/v2/ug/checkin_credits/status   body {"req_source":1}
 * 领取  POST {apiBase}/trae/api/v2/ug/checkin_credits/claim    body {"req_source":1}
 * 余额  POST {apiBase}/trae/api/v2/pay/web_user_ent_usage      body {"require_usage":true}
 * ```
 *
 * 鉴权是 `Authorization: Cloud-IDE-JWT <access>` + 设备头（官方 claim 头集，
 * 见 {@link traeCnCreditsHeaders}）。
 *
 * ## 三条本协议独有的约束
 *
 * 1. **必须带设备头**：`x-device-id`（登录时注册的 16 位号，见
 *    {@link traeCnCheckinDeviceId}）+ `x-device-type` / `x-os-version` /
 *    `x-app-version`。⚠️ **T9 的第三次修正（2026-09-20）**：T9 原结论「服务端
 *    **不校验设备号形态**」（16 位十进制号 / `BoundDeviceID` / 空串返回逐字节
 *    相同）**观测成立但推论错了** —— 不校验**形态** ≠ 不校验**设备**。服务端按
 *    `x-device-id` 做设备维度记账，认不认这台设备是真校验。
 *    **这是 Trae 与另外两条线最大的形态差异** —— 腾讯系与 LobsterAI 都不需要
 *    设备头。
 * 2. **签到判定以 body `code:0` 为准，不看 HTTP 状态**（对齐 CodeBuddy 既有约定）。
 *    `code:1001` + `enable:false` 是「凭据失效」，按需要重新登录处理。
 *    **余额端点例外**：`web_user_ent_usage` 的响应**没有 code 信封**（T7 已校准），
 *    按结构特征判成功 —— 详见 {@link ResponseEnvelope}。
 * 3. **幂等判据是 `checked_in`（账号级当日）**，而**不是** `did_checked_in`
 *    ——后者是**设备级**语义：同一账号换一台设备仍为 false，拿它判幂等会
 *    对已经领过的账号重复发领取请求。
 *
 * ## 身份保真对照（2026-09-20 第二次反混淆真机客户端，bundle 逐字）
 *
 * 反混淆 `out/main.js` 的 claim 调用链
 * （`claimCheckinCredits()` → `eb("/trae/api/v2/ug/checkin_credits/claim","POST","checkin_claim")`）
 * 后与本节实现逐头对照，**本次两处都已改为对齐官方**：
 *
 * | 项 | 真机 | 本实现（改后） | 处置 |
 * |---|---|---|---|
 * | `x-device-id` | `guaranteedDeviceId`（AHA 16 位号，与登录 URL 同源） | **登录时注册的 16 位号**（旧凭据降级为 `BoundDeviceID`） | **已修**（9074 真根因） |
 * | `Content-Type` | `application/json`（`bb()`） | 同 | 已对齐 |
 * | `Authorization` | `Cloud-IDE-JWT <token>`（`mixAuthorization`） | 同 | 已对齐 |
 * | `x-device-type` / `x-os-version` / `x-app-version` | `commonParams` 三字段 | `windows` / 运行时 `os.version()` / `3.3.102` | 已对齐 |
 * | `x-device-brand` | 条件性发（`device_model` 非空才发） | **不发** | 刻意（不猜硬件型号，不发空串冒充） |
 * | `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token` | **官方都不发** | 原多发 → **已删** | **已删**（对齐官方头集） |
 *
 * ⚠️ **`x-os-version` / `x-app-version` 的旧「身份保真」修复与 `9074` 无关**，
 * 本次定案的根因是**设备身份**（`x-device-id`），不是版本号形态。见下节。
 *
 * ## `9074` 的定性（2026-09-20 **第三次**修正，前两次均作废）
 *
 * | 次序 | 定性 | 状态 |
 * |---|---|---|
 * | 第 1 次 | 瞬时频次软限流 | **作废**（8 秒退避重放仍 9074、三日 452 次报错） |
 * | 第 2 次 | 活动级当日容量/名额限制或账号侧风控 | **作废**（官方客户端同期可签成功；单变量 A/B 找到真变量） |
 * | **第 3 次（本次）** | **设备身份**：服务端按 `x-device-id` 记设备维度签到状态，我们发的 `BoundDeviceID` 不被活动系统认可 | 单变量隔离证据 |
 *
 * 决定性证据（status 端点 A/B，2026-09-20）：我们全套头不变 + **仅**把
 * `x-device-id` 换成官方客户端的 16 位号 → `did_checked_in` 由 `false` 翻转为
 * `true`。其余头差异（我们多发的 `Accept` / `Origin` / `Referer` /
 * `X-Ide-Token` / `X-Cloudide-Token`）已证明**不影响**结果。
 *
 * 根因结构：官方登录 URL 的 `device_id` 与 claim 的 `x-device-id` 是**同一个稳定
 * AHA 号**；本插件此前两者不同源 —— 登录用现场随机号（用完即丢），claim 却发
 * exchange 返回的 `BoundDeviceID`，构成「与登录不匹配且每次登录都漂移的设备身份」。
 * 修复即 {@link TraeCnCredential.checkin_device_id}：把登录时的 16 位号落盘。
 *
 * ⚠️ **待验证假设**：本次修复是「按证据最优假设落地 + 次日自然验证」——
 * 定案当天官方已签到成功（幂等挡路），claim 级验证需等次日名额重置。
 * 若明日仍 9074，后续路径是「读 Trae 客户端 AHA 设备号」（跨产品耦合，
 * 需用户拍板），而不是再改形态。
 *
 * ## claim 段的有界重试（2026-09-20）
 *
 * 定性改变**不等于「不该重试」**：名额在同一分钟内也可能被释放（前一次请求
 * 恰好撞在桶满的瞬间），而 `9074` / `4007` / `3004` 这三个码本身都带「稍后再来」
 * 语义。故 claim 段做**有界**退避重试（1s → 3s，共 2 次，见
 * {@link TRAE_CN_CLAIM_RETRY_DELAYS_MS}）；**status 段不重试**（读接口没有名额
 * 问题，重试只是重复请求），`9004`（设备被拒）与 `1001`（凭据失效）**绝不**
 * 重试 —— 那是确定性失败，重试只会把同一个结果问三遍。
 *
 * ⚠️ 第三次定性**不推翻**这段重试：设备身份错误虽然确定性，但「设备维度当日
 * 已签」与「名额释放」的边界在客户端不可见，保留有界重试的成本仍只有 4 秒。
 *
 * ## 与 `lobsterai-credits.ts` 的签名差异（刻意）
 *
 * LobsterAI 版用 positional `fetcher` 形参；本模块改用
 * {@link TraeCnCreditsOptions} 选项包，因为**本协议有三处字段名待校准**
 * （领取积分字段、礼包数组位置、礼包余额字段），需要一个**脱敏调试出口**
 * （`onDebug`，只输出字段名不输出值）供真机一次性收敛。为了一个可选的调试
 * 出口而把 `fetcher` 挤成第三、调试挤成第四个位置参数，会让所有调用点都
 * 出现 `undefined` 占位洞，可读性更差。
 *
 * ⚠️ **未接线项**：`onDebug` 目前只在 RPC 分发处接到 `ctx.logger.info`，
 * 由宿主日志承接；它**不**经 RPC 回传给客户端（协议里没有这个字段）。
 * 故真机校准时看宿主日志，而不是看 Account Hub 面板。
 */

import { version as osVersion } from 'node:os'
import {
  TRAE_CN_REQUEST_TIMEOUT_MS,
  type TraeCnProduct,
} from './trae-cn-product.js'
import {
  traeCnCheckinDeviceId,
  type TraeCnCredential,
} from './trae-cn-oauth.js'
// 重试判据**复用** chat 侧的退避码表（`src/trae-cn-errors.ts`）——「哪些码算
// 稍后再来」在两条协议线上必须是同一份定义，各写一份必然漂移。
import { TRAE_CN_BACKOFF_CODES } from './trae-cn-errors.js'
import type {
  CheckinStatus,
  ClaimOutcome,
  CreditBalance,
  CreditPackage,
} from './credits.js'

// ── 端点与请求体常量 ──

/** 签到状态查询端点（权威状态源）。 */
export const TRAE_CN_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
/** 签到领取端点。 */
export const TRAE_CN_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
/**
 * 积分余额端点。
 *
 * **刻意不用** `ug/activity/info` 的活动口径：实测那个接口写「200 work 积分」
 * 而实际到账 150 通用积分，是**口径陷阱**（见 README「Trae CN provider」）。
 * 余额只能以本端点的资源包明细为准。
 */
export const TRAE_CN_USER_ENT_USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage'

/**
 * 两个签到端点的请求体字段。
 *
 * ⚠️ **T1 已校准**（2026-09-18 真机）：`req_source` 带与不带，服务端返回
 * **逐字节相同**，它不是 `code:9004` 的成因。保留 `req_source: 1` 是因为
 * 它是唯一被实测成功过的组合，且带一个多余字段的成本是零。
 */
export const TRAE_CN_CHECKIN_REQ_SOURCE = 1

/** 设备头中的客户端形态（**伪装**，与运行环境无关，非 Windows 上也照发）。 */
export const TRAE_CN_DEVICE_TYPE = 'windows'

/**
 * 设备头中的操作系统版本 —— 运行时取 `node:os` 的 `os.version()`。
 *
 * ## 为什么不硬编码（2026-09-19 身份保真修复）
 *
 * 原实现硬编码 `Windows 10.0.22631`（一个**构建号**形态），而反混淆真实客户端的
 * claim 调用链（`out/main.js` 的 `claimCheckinCredits()` → `eb(…)`）后确认：
 * 真机发的是 **`os.version()` 的返回值**，本机实测为 `Windows 10 Home`
 * —— 是**带品牌名的市场营销名**，不是 `10.0.x` 构建号。两者形态不同。
 *
 * 更早的一处自相矛盾也因此消除：登录 URL 的 `x_os_version` 一直是
 * `Windows 10 Home`（`TRAE_CN_LOGIN_OS_VERSION`），而签到头却发 `10.0.22631`
 * —— 同一个插件对同一台机器报了两种操作系统身份。
 *
 * ⚠️ **如实说明一个已知边界**：`os.version()` 是**宿主真实值**，故本插件跑在
 * macOS / Linux 上时这里会发出该平台自己的版本串，而同一组头里的
 * `x-device-type` 仍是伪装常量 `windows` —— 两者会不自洽。这是**如实反映
 * 「真机取系统 API」这一事实**的代价，刻意不做「非 Windows 就回退 Windows 串」
 * 的兜底：那会把「运行环境不是 Windows」这一事实掩盖掉，而且真机客户端本身
 * 就是 Windows 桌面应用，非 Windows 宿主本来就不在模仿的目标形态内。
 */
export function traeCnOsVersion(): string {
  return osVersion()
}

/**
 * `x-os-version` 的模块级快照（派生自 {@link traeCnOsVersion}）。
 *
 * **单一生效者是上面那个函数**；本常量存在只是因为 `src/trae-cn-adapter.ts`
 * 的 chat 头需要一个字符串（它不做函数调用），而 chat 与签到**必须报同一种
 * 设备身份**。`os.version()` 在同一进程内不会变化，模块加载时取一次快照
 * 与每次调用取值等价。
 */
export const TRAE_CN_OS_VERSION = traeCnOsVersion()

/**
 * 设备头中的客户端版本（**签到专用常量**）。
 *
 * 真机客户端已到 `3.3.102`（原值 `3.3.100` 落后两个补丁号）。
 *
 * ⚠️ 与登录协议的 {@link TRAE_CN_IDE_VERSION}（`3.3.100`，`x_app_version` /
 * `DeviceInfo.ClientVersion` / exchange body 的 `IDEVersion`）**是两个号**，
 * 刻意分开：那是登录 URL 与 authCode 交换那条协议线的逐字真机值，本次不动它。
 */
export const TRAE_CN_APP_VERSION = '3.3.102'

// ── 业务码 ──

/** 成功码（签到判定以 body code 为准，不看 HTTP 状态）。 */
export const TRAE_CN_CODE_OK = 0
/**
 * 凭据失效码。
 *
 * 实测：**不带 auth 时服务端不返回 401，而是 HTTP 200 + `code:1001` +
 * `enable:false`** —— 这正是「必须按业务码判」的实证。
 */
export const TRAE_CN_CODE_CREDENTIAL_INVALID = 1001
/**
 * 设备校验失败码（缺少**设备头本身**时返回；T9 校准确认设备**号形态**不校验）。
 *
 * 本模块**总是**带设备四件套，因此真机遇到它只可能是「服务端不认可我们构造的
 * 设备身份」（例如 {@link TRAE_CN_OS_VERSION} 的构建号形态不对）。故错误文案
 * 必须把这件事说清楚，而不是笼统报「领取失败」。
 */
export const TRAE_CN_CODE_DEVICE_REJECTED = 9004

/**
 * 「当前参与用户太多，请稍后再试」码（**真根因：设备身份**）。
 *
 * ⚠️ **定性已于 2026-09-20 第三次修正**（前两次均作废）：
 *
 * | 次序 | 定性 | 作废依据 |
 * |---|---|---|
 * | 1 | 瞬时频次软限流 | 8 秒退避重放**仍** 9074；三日 452 次报错 |
 * | 2 | 活动级当日容量/名额限制或账号侧风控 | 官方客户端同期签成功；单变量 A/B 定位到真变量 |
 * | **3（现行）** | **设备身份不被活动系统认可** | status 端点 A/B：仅换 `x-device-id` 即让 `did_checked_in` 由 false 翻转为 true |
 *
 * 服务端按 `x-device-id` 做**设备维度**签到记账，我们发的 `BoundDeviceID`
 * 不在它的设备表里。修复见 {@link traeCnCreditsHeaders} /
 * {@link TraeCnCredential.checkin_device_id}。
 *
 * ⚠️ **待验证假设**：claim 级验证需等次日名额重置（定案当天官方已签成功、
 * 幂等挡路）。若明日仍 9074，后续路径是「读 Trae 客户端 AHA 设备号」
 * （跨产品耦合，需用户拍板）。
 */
export const TRAE_CN_CODE_TOO_MANY_USERS = 9074

/** 传输层失败（网络异常 / 响应无法解析 / 信封与预期不符）的统一码。 */
const CODE_TRANSPORT_FAILED = -1

// ── claim 段的有界重试（2026-09-20） ──

/**
 * claim 段可重试的业务码（**`TRAE_CN_BACKOFF_CODES` 的真子集**）。
 *
 * 刻意不是「整张退避码表」：那张表里还有 `3003`（`MODEL_FAIL`，
 * `all models failed`）—— 它是 **chat 通道**的基础设施故障码，签到端点上
 * 没有对应的观测，把它放进来只会让签到多等 4 秒再拿到同一个结果。
 *
 * 三个码在签到语境下都意味着「服务端此刻不受理这次写入，稍后再来」：
 * - `9074`：活动级当日名额已满 / 账号侧风控（新定性，见文件头注释）；
 * - `4007` / `3004`：服务端明确要求稍后重试。
 *
 * ⚠️ 判定**同时**要求命中 {@link TRAE_CN_BACKOFF_CODES}（见
 * {@link isTraeCnClaimRetryable}）：上游若把某个码从共享退避表里移除
 * （即不再认为它可重试），签到侧的重试会**自动**跟着停 —— 一处定义，不会漂移。
 */
export const TRAE_CN_CLAIM_RETRY_CODES: readonly number[] = [9074, 4007, 3004]

/**
 * 重试前的等待时长（指数退避，**共 2 次重试**：1s → 3s，累计 4s）。
 *
 * 上界刻意压得很小：`9074` 的新定性是**当日名额/风控**，不是「等几秒就好」，
 * 长时间重试只会让用户对着转圈等；这两次重试的真正价值是覆盖「撞在名额释放
 * 瞬间」的极小概率，以及 `4007` / `3004` 这类真正的瞬时软限流。
 */
export const TRAE_CN_CLAIM_RETRY_DELAYS_MS: readonly number[] = [1000, 3000]

/**
 * 该业务码是否应触发 claim 段的退避重试。
 *
 * 两道判据缺一不可：本地清单（签到语境的相关码）+ 共享退避表（上游对
 * 「可重试」的权威定义）。`9004`（设备被拒）与 `1001`（凭据失效）**都**不在
 * 任何一张表里 —— 它们是确定性失败，重试只会把同一个结果问三遍。
 */
export function isTraeCnClaimRetryable(code: number | undefined): boolean {
  if (code === undefined) return false
  return TRAE_CN_CLAIM_RETRY_CODES.includes(code) && TRAE_CN_BACKOFF_CODES.includes(code)
}

// ── 积分池 ──

/**
 * 通用积分池（`available_endpoint === 0`）—— **Trae CN（IDE 对话）实际扣的就是它**。
 *
 * 与 {@link TRAE_CN_POOL_WORK} 的关系见 {@link fetchTraeCnCreditBalance} 的
 * 「按 provider 分池」一节：两个池**互不通用**，各自只有一条路径能花。
 */
export const TRAE_CN_POOL_UNIVERSAL = 0
/**
 * Work 积分池（`available_endpoint === 1`）—— **只在 TraeWork 里能花**
 * （`work.trae.cn` 网页版 / 桌面版）。
 *
 * ⚠️ 官方已把 TraeWork 通道并入通用通道，**本插件不再有任何路径走这个池**。
 * 常量保留是因为 `available_endpoint` 这个上游字段仍然分池、礼包仍按它归类
 * （见 {@link parseTraeCnPackage} 与 {@link fetchTraeCnCreditBalance}）。
 */
export const TRAE_CN_POOL_WORK = 1

/**
 * 定长字段的脱敏描述：**只列字段名，不带任何值**。
 *
 * 待校准项（礼包数组位置、余额字段名）只能靠真机响应的**结构**收敛，
 * 而值里可能含账号标识与金额 —— 只输出键名即可完成任务，且不泄露内容。
 */
function describeKeys(record: Record<string, unknown>): string {
  const keys = Object.keys(record)
  return keys.length === 0 ? '(空对象)' : keys.join(',')
}

// ── 请求 ──

/** 本模块三个函数共用的请求选项。 */
export interface TraeCnCreditsOptions {
  /** 注入的 fetch（测试用）；默认全局 fetch。 */
  fetcher?: typeof fetch
  /**
   * 脱敏调试出口（**只输出字段名与结构判定，不输出值**）。
   *
   * 用途是在真机校准时一次性看清「礼包数组在哪、余额字段叫什么、领取积分字段
   * 叫什么」。生产接线把它接到 `ctx.logger.info`（见 `src/jet-hub-rpc.ts` 的
   * 三处分发）；它**不**回传客户端，故校准看宿主日志。
   */
  onDebug?: (message: string) => void
}

/** 一次请求的解析结果（与 `credits.ts` 的 `PostResult` 同构，另带业务码）。 */
type CreditsCallResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number; message: string; logid?: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/**
 * 读取带 Trae 鉴权与设备头的签到请求头。
 *
 * ## 与官方 claim 请求头**逐头对齐**（2026-09-20，bundle 反混淆取证）
 *
 * 官方 `claimCheckinCredits()` 的调用链（`out/main.js` @1696645 附近）是
 * `eb(path,"POST","checkin_claim")`，其头集合由两处拼成：
 *
 * ```js
 * bb(){ const e={"Content-Type":"application/json"}; …; return e }        // 基础头
 * cb(e){ return { headers: this.mixAuthorization(this.bb(), e) } }        // + Authorization
 * fb(e){ e["x-device-id"] = this.S.guaranteedDeviceId;                    // + 设备头
 *        const i=this.g?.commonParams;
 *        i?.device_model && (e["x-device-brand"]=i.device_model),
 *        i?.os_name      && (e["x-device-type"]=i.os_name),
 *        i?.os_version   && (e["x-os-version"]=i.os_version),
 *        i?.app_version  && (e["x-app-version"]=i.app_version) }
 * ```
 *
 * 故官方全集是 **`Content-Type` + `Authorization: Cloud-IDE-JWT` + 设备头**，
 * **没有** `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token`。
 * 本函数此前多发这 5 个头，现已删除（对齐取证结论；单变量 A/B 已证明它们不影响
 * 结果，故删除是「对齐官方形态」而非「修复」）。
 *
 * ## `x-device-id` 用 {@link traeCnCheckinDeviceId}（**9074 真根因修复**）
 *
 * 服务端按 `x-device-id` 做**设备维度记账**，只认登录时注册的那台设备。
 * 官方登录 URL 的 `device_id` 与 claim 的 `x-device-id` 是**同一个稳定 AHA 号**；
 * 本插件此前两者不同源（登录用现场随机号、claim 发 `BoundDeviceID`），构成
 * 「与登录不匹配且每次登录都漂移的设备身份」。
 *
 * 单变量隔离证据（status 端点 A/B，2026-09-20）：我们全套头 + **仅**把
 * `x-device-id` 换成官方 16 位号 → `did_checked_in` 由 `false` 翻转为 `true`。
 *
 * ## 刻意**不**发 `x-device-brand`
 *
 * 官方是**条件性**发它（`commonParams.device_model` 非空才发），而本插件拿不到
 * 硬件型号 —— 按既有约定「不猜硬件型号」如实**不发**，而不是发一个空串冒充
 * 「官方也发这个头」。发空串与不发在服务端看来是两种不同的客户端形态。
 *
 * ## 鉴权头不再复用 `traeCnAccessHeaders`
 *
 * 那个构造器是 **chat（SOLO）与签到共用**的，带 `Accept` 与两个多余 token 头。
 * 官方 claim 三者都没有，故签到侧改为**自建**这三个头；chat 侧
 * （`src/trae-cn-models.ts` 的 `traeCnSoloHeaders`）继续用它，**不受影响**。
 * 这正是「签到侧删除不影响 chat」的边界所在。
 *
 * ⚠️ `product` 形参在删除 `Origin` / `Referer` 后**已不再被读取**，但**刻意保留**：
 * 它是「本构造器随产品配置走」的既有签名（调用点与测试都按两参调用），
 * 且将来若某个 Trae 变体需要按产品区分头集，它就是现成的挂点。
 * （`tsconfig.json` 未开 `noUnusedParameters`，故保留形参不会报错。）
 */
export function traeCnCreditsHeaders(
  credential: TraeCnCredential,
  product: TraeCnProduct,
): Record<string, string> {
  return {
    // 官方基础头：只有 Content-Type（`bb()` 逐字）。`Accept` 官方不发。
    'Content-Type': 'application/json',
    // 官方 `mixAuthorization` 逐字：`Authorization: Cloud-IDE-JWT ${token}`。
    // **不**发 `X-Ide-Token` / `X-Cloudide-Token`（官方 claim 没有这两个头）。
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    // 设备四件套：claim 严格校验，缺了回 9004。
    // `x-device-id` 取「登录时注册的 16 位号」（旧凭据如实降级，见该函数说明）。
    'x-device-id': traeCnCheckinDeviceId(credential),
    // 官方取 `commonParams.os_name`；真机实测值为 `windows`。
    'x-device-type': TRAE_CN_DEVICE_TYPE,
    // 运行时取 `os.version()`（真机客户端同源），不再硬编码构建号。
    'x-os-version': traeCnOsVersion(),
    'x-app-version': TRAE_CN_APP_VERSION,
  }
}

/** 从 JSON 安全读取业务码（兼容数字与整数字符串两种形态）。 */
function readCode(source: Record<string, unknown>): number | undefined {
  for (const key of ['code', 'Code']) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    // `"1001"` 是码；`"code=1001"` 之类不是，后者被 parseInt 静默截取会把诊断文本误判成业务码。
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  }
  return undefined
}

/**
 * 从 JSON 读取服务端说明文案（`msg` / `message` / 大写变体）。
 *
 * ⚠️ 这里读的是**服务端文案**，用于失败原因透出。**不用于**判定成功与否 ——
 * 判定只认 `code`。
 */
function readServerMessage(source: Record<string, unknown>): string {
  for (const key of ['msg', 'message', 'Msg', 'Message']) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 取响应体里的数据层：优先 `data`，缺失时回退到根对象。 */
function dataLayer(body: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['data', 'Data']) {
    const value = body[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return body
}

/**
 * 响应信封形态。
 *
 * - `code`：**业务码信封**（签到 status / claim）。判定全部依据 body 的 `code`，
 *   缺失即失败 —— 信封与预期不符时「当作成功」会把一次失败的领取报成
 *   「已领取」，比报失败更糟。
 * - `trae-pay`：`web_user_ent_usage` 的**无 code 信封**。真机实测（2026-09-18）
 *   该端点响应顶层是 `{"is_credits_billing":…,"usage_summary":{…},
 *   "user_entitlement_pack_list":[…]}`，**根本没有 `code` 字段** —— 沿用
 *   `code` 信封会让余额**恒失败**（实测表现为「响应缺少 code 字段」）。
 *   故本形态按「结构特征存在即成功」，同时保留「若真的解析出 `code` 且非 0，
 *   仍按业务码报错」的通道（对齐「业务失败在 HTTP 200」的协议，
 *   `code:1001` 的凭据失效翻译因此不丢）。
 */
type ResponseEnvelope = 'code' | 'trae-pay'

/** `trae-pay` 信封的结构特征字段：任一存在即认定响应形态正确。 */
const TRAE_PAY_ENVELOPE_MARKERS: readonly string[] = [
  'user_entitlement_pack_list', 'usage_summary',
]

/** `trae-pay` 信封的响应体是否具备已实测的结构特征。 */
function hasTraePayEnvelope(record: Record<string, unknown>): boolean {
  return TRAE_PAY_ENVELOPE_MARKERS.some((key) => key in record)
}

/**
 * 服务端日志追踪号响应头（字节系网关的 logid）。
 *
 * 真机样本：`x-tt-logid: 20260919142909176141A5DE791F4FE75E`。
 *
 * 它是**定位服务端日志的唯一线索**：`code` / `message` 只说「失败了、为什么」，
 * 而「这一次请求在服务端到底发生了什么」只有 logid 能查。故失败时若响应头带值，
 * 就一路透传到 outcome 与前端失败行。
 *
 * 读取用 `Headers.get`（大小写不敏感），并 trim + 判空：缺失或空白串一律
 * 视为「没有」，避免前端显示出一个空的 logid 尾巴。
 */
const TRAE_CN_LOGID_HEADER = 'x-tt-logid'

/** 从响应头读 logid；没有（或为空白）返回 undefined。 */
function readLogId(response: Response): string | undefined {
  const raw = response.headers?.get(TRAE_CN_LOGID_HEADER)
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 把可选 logid 合并进结果对象（无值时**不新增字段**，保持对象形态干净）。 */
function withLogId<T extends Record<string, unknown>>(base: T, logid: string | undefined): T & { logid?: string } {
  return logid === undefined ? base : { ...base, logid }
}

/**
 * 发起一次 POST 并解析业务码。
 *
 * 判定的全部依据是 **body 的 `code`**，`response.ok` 一概不看：实测无 auth 时
 * 服务端返回的是 HTTP 200 + `code:1001`，按状态码判会把它当成成功。
 *
 * `code` **缺失**时按 `envelope` 分派（见 {@link ResponseEnvelope}）：
 * 签到端点判失败，余额端点按结构特征判成功。
 *
 * 失败路径**一律带上响应头里的 logid**（见 {@link TRAE_CN_LOGID_HEADER}）——
 * 传输层失败（fetch 抛错）时没有响应，故那里取不到 logid，这是如实的缺失。
 */
async function postJson(
  path: string,
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions,
  body: string,
  envelope: ResponseEnvelope = 'code',
): Promise<CreditsCallResult> {
  const fetcher = options.fetcher ?? fetch
  let parsed: unknown
  let logid: string | undefined
  try {
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: 'POST',
      headers: traeCnCreditsHeaders(credential, product),
      body,
      signal: AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS),
    })
    // 先读响应头再解析 body：`response.json()` 之后再读头同样可行，但把取数
    // 放在紧邻响应的位置，能让「logid 属于这一次响应」这件事在代码上显而易见。
    logid = readLogId(response)
    parsed = await response.json() as unknown
  } catch (error) {
    // 保留原始错误消息（含 timeout / socket hang up），不吞掉诊断信息。
    return {
      ok: false,
      code: CODE_TRANSPORT_FAILED,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return withLogId(
      { ok: false as const, code: CODE_TRANSPORT_FAILED, message: UNPARSABLE_RESPONSE_MESSAGE },
      logid,
    )
  }
  const record = parsed as Record<string, unknown>
  const code = readCode(record)
  if (code === undefined) {
    if (envelope === 'trae-pay') {
      // 无 code 信封：结构特征在即成功（真机校准，2026-09-18）。
      if (hasTraePayEnvelope(record)) return { ok: true, body: record }
      options.onDebug?.(
        `[trae-cn] ${path} 响应既无 code 也无余额信封特征字段，字段名: ${describeKeys(record)}`,
      )
      return withLogId(
        { ok: false as const, code: CODE_TRANSPORT_FAILED, message: UNPARSABLE_RESPONSE_MESSAGE },
        logid,
      )
    }
    options.onDebug?.(`[trae-cn] ${path} 响应缺少 code 字段，字段名: ${describeKeys(record)}`)
    return withLogId(
      { ok: false as const, code: CODE_TRANSPORT_FAILED, message: '响应缺少 code 字段' },
      logid,
    )
  }
  if (code !== TRAE_CN_CODE_OK) {
    const serverMessage = readServerMessage(record)
    return withLogId(
      {
        ok: false as const,
        code,
        message: serverMessage.length > 0 ? serverMessage : `服务端返回 code=${code}`,
      },
      logid,
    )
  }
  return { ok: true, body: record }
}

/** 把业务码翻译成用户可读的失败说明（凭据失效与设备被拒各有专门文案）。 */
function describeFailureCode(code: number, message: string): string {
  if (code === TRAE_CN_CODE_CREDENTIAL_INVALID) return '凭据已失效，请重新登录'
  if (code === TRAE_CN_CODE_DEVICE_REJECTED) {
    // 本模块总是带设备头 ⇒ 9004 只可能是「服务端不认可我们构造的设备身份」，
    // 而不是「忘了带设备头」。文案因此指向真正要校准的那个值。
    // （T9 已校准确认设备号**形态**不被校验，故这里不声称形态是成因。）
    return `设备校验未通过（code ${TRAE_CN_CODE_DEVICE_REJECTED}）：`
      + 'x-device-id 取自凭据的 checkin_device_id（登录时注册的 16 位设备号），'
      + `x-os-version 为本机 os.version() 的运行时取值（${TRAE_CN_OS_VERSION}）、`
      + `x-app-version 为实测常量（${TRAE_CN_APP_VERSION}）`
  }
  if (code === TRAE_CN_CODE_TOO_MANY_USERS) {
    // 服务端原文（「当前参与用户太多，请稍后再试」）说的是「稍后」，但实测证明
    // 那不是几秒钟的事 —— 三日 452 次报错、8 秒退避重放仍 9074。
    //
    // 2026-09-20 第三次定性：真根因是**设备身份**（服务端按 x-device-id 记设备
    // 维度签到状态，我们发的 BoundDeviceID 不被活动系统认可）。故文案把用户
    // 引向**可执行的动作**（重新登录以注册设备身份），而不是让他反复刷新等名额。
    //
    // 刻意**不在文案里重复 code**：前端 `formatClaimFailureLine` 会统一追加
    // `（code N）`，这里再写一次会显示成「…（code 9074）…（code 9074）」。
    return `${message}（服务端按 x-device-id 记设备维度签到状态；`
      + '若本账号是旧版凭据登录的，请重新登录一次以登记设备身份）'
  }
  return message
}

// ── 签到状态 ──

/** 签到状态的两个**实测确认**字段。 */
export interface TraeCnCheckinState {
  /**
   * 账号级「今天是否已签到」——**幂等判据**。
   *
   * 刻意不用 `did_checked_in`：那是**设备级**语义（换设备后仍为 false），
   * 拿它判幂等会对已领取的账号重复发领取请求。
   */
  checkedIn: boolean
  /**
   * 服务端是否开启签到。
   *
   * `undefined` 表示响应里没有该字段 —— 与显式 `false` **严格区分**：
   * 只有服务端明确说关，才判「签到未开启」。
   */
  enabled: boolean | undefined
}

/** 读取布尔值：只认 `true` / `false` 两种显式形态，其余（含缺失）返回 undefined。 */
function readOptionalBool(source: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value === true || value === false) return value
  }
  return undefined
}

/** 从任意一层读取布尔值（先数据层、再根对象），任一处显式为 true 即为 true。 */
function readBoolAnywhere(
  data: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return readOptionalBool(data, keys) === true || readOptionalBool(root, keys) === true
}

/** 从响应体解析签到状态。 */
function parseCheckinState(body: Record<string, unknown>): TraeCnCheckinState {
  const data = dataLayer(body)
  return {
    checkedIn: readBoolAnywhere(data, body, ['checked_in', 'checkedIn']),
    // enable 可能在数据层也可能在根上（实测的失效形态是「code:1001 + enable:false」，
    // 未记录它的层级），故两层都看。
    enabled: readOptionalBool(data, ['enable', 'enabled'])
      ?? readOptionalBool(body, ['enable', 'enabled']),
  }
}

/**
 * 查询签到状态。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 信封异常 / 业务码非 0，含 `code:1001`
 * 的凭据失效），与「服务端明确说未签到」严格区分 —— 后者返回
 * `todayCheckedIn: false` 的对象。
 *
 * 映射到共用的 {@link CheckinStatus}：只有 `active` 与 `todayCheckedIn` 有
 * 实测依据，其余字段（连续天数 / 每日积分 / 活动名…）Trae 的状态响应里
 * **没有已确认的对应字段**，故一律取零值，而不是臆造一份看起来丰满的状态。
 * 这与 LobsterAI 的处理同因（那份协议同样没有这些概念）。
 */
export async function fetchTraeCnCheckinStatus(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions = {},
): Promise<CheckinStatus | null> {
  const result = await postJson(
    TRAE_CN_CHECKIN_STATUS_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  if (!result.ok) {
    options.onDebug?.(
      `[trae-cn] 签到状态查询失败 code=${result.code}: ${result.message}`,
    )
    return null
  }
  const state = parseCheckinState(result.body)
  return {
    // 缺失视为开启：只有服务端**显式** enable:false 才判未开启，
    // 否则一旦响应里省略该字段，UI 会把正常账号显示成「活动未开启」。
    active: state.enabled !== false,
    todayCheckedIn: state.checkedIn,
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

// ── 签到领取 ──

/**
 * 领取响应里「本次获得积分」的候选字段表。
 *
 * ⚠️ **T8 待校准**：调研报告未给出 claim 成功的响应结构。故按候选表依次尝试，
 * 全部未命中时按 0 处理并输出一条脱敏调试行（列出实际字段名），真机跑一次
 * 即可把本表收敛成唯一字段。**不发明**字段名，也不把 0 当成「服务端说 0 分」。
 */
export const TRAE_CN_CLAIM_CREDIT_FIELDS: readonly string[] = [
  'credit', 'credits', 'credits_granted', 'reward_credits', 'reward', 'amount', 'integral',
]

/** 从领取响应的数据层取本次积分；取不到返回 undefined。 */
function readClaimedCredit(data: Record<string, unknown>): number | undefined {
  for (const key of TRAE_CN_CLAIM_CREDIT_FIELDS) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 等待指定毫秒（抽成函数是为了让测试能用假定时器接管，不必真等 4 秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 发起 claim 请求，命中可重试码时按 {@link TRAE_CN_CLAIM_RETRY_DELAYS_MS} 退避重试。
 *
 * 语义边界（三条都刻意）：
 * - **只重试可重试码**（{@link isTraeCnClaimRetryable}）：`9004` / `1001` 等
 *   确定性失败第一次就返回，绝不浪费两次往返；
 * - **最多重试 `delays.length` 次**（当前 2 次，累计等待 4s，加上请求耗时
 *   仍远低于 {@link TRAE_CN_REQUEST_TIMEOUT_MS} 的三倍）；
 * - **返回最后一次的结果**，无论成功还是失败 —— 调用方拿到的 code / message /
 *   logid 一定是最近一次尝试的现场。
 *
 * 成功时立即返回，不等待剩余退避。
 */
async function claimTraeCnWithRetry(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions,
): Promise<CreditsCallResult> {
  let result = await postJson(
    TRAE_CN_CHECKIN_CLAIM_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  for (const delay of TRAE_CN_CLAIM_RETRY_DELAYS_MS) {
    if (result.ok) return result
    if (!isTraeCnClaimRetryable(result.code)) return result
    options.onDebug?.(
      `[trae-cn] claim 命中可重试码 ${result.code}，${delay}ms 后重试`,
    )
    await sleep(delay)
    result = await postJson(
      TRAE_CN_CHECKIN_CLAIM_PATH, credential, product, options,
      JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
    )
  }
  return result
}

/**
 * 执行每日签到领取。
 *
 * 完整两步流程（**status → 未领则 claim**），返回与 `credits.ts` 同构的
 * {@link ClaimOutcome} 判别联合 —— `computeClaimSummary` 与结果摘要 UI 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 状态查询失败 → `failed`（转述底层原因；`code:1001` 译为「凭据已失效」）；
 * 2. `checked_in` 为真 → `already-claimed`（**不发领取请求**）；
 * 3. 服务端显式 `enable:false` → `inactive`；
 * 4. 领取请求失败 → `failed`（`1001` 凭据失效 / `9004` 设备被拒各有专门文案）；
 * 5. 成功 → `claimed`。
 *
 * ## 只有 claim 段重试（status 段**一次都不重试**）
 *
 * 第 1 步的 status 是**读**接口：它没有名额问题（实测同一套设备头下 status
 * 恒成功、claim 恒 `9074`），失败即失败，重试只是把同一个结果再问一遍。
 * 第 4 步的 claim 是**写**接口，命中 {@link isTraeCnClaimRetryable} 时按
 * {@link TRAE_CN_CLAIM_RETRY_DELAYS_MS} 退避重试（1s → 3s，共 2 次）；
 * 重试**耗尽**后按**最后一次**尝试的 code / message / logid 返回 ——
 * 用户看到的是最近一次现场，而不是第一次的（logid 尤其如此：它标识单次请求）。
 *
 * 幂等是**服务端**保证的（`checked_in`），本模块只在客户端做一次预检以省掉
 * 无效请求 —— 即便预检与实际状态竞态，重复领取也只会得到服务端的幂等响应。
 * 重试因此也是安全的：服务端不会因为同一账号连发三次 claim 就发三份奖励。
 */
export async function claimTraeCnDailyCheckin(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions = {},
): Promise<ClaimOutcome> {
  const statusResult = await postJson(
    TRAE_CN_CHECKIN_STATUS_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  if (!statusResult.ok) {
    return {
      kind: 'failed',
      code: statusResult.code,
      message: statusResult.code === TRAE_CN_CODE_CREDENTIAL_INVALID
        ? describeFailureCode(statusResult.code, statusResult.message)
        : `签到状态查询失败：${statusResult.message}`,
      // logid 透传（响应头有值才有这个字段）。
      ...statusResult.logid === undefined ? {} : { logid: statusResult.logid },
    }
  }
  const state = parseCheckinState(statusResult.body)
  if (state.checkedIn) {
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  if (state.enabled === false) {
    return { kind: 'inactive', message: '签到未开启' }
  }

  const claimResult = await claimTraeCnWithRetry(credential, product, options)
  if (!claimResult.ok) {
    return {
      kind: 'failed',
      code: claimResult.code,
      message: describeFailureCode(claimResult.code, claimResult.message),
      // logid 透传：claim 失败是最需要服务端日志的场景（9074 就发生在这里）。
      ...claimResult.logid === undefined ? {} : { logid: claimResult.logid },
    }
  }
  const data = dataLayer(claimResult.body)
  const credit = readClaimedCredit(data)
  if (credit === undefined) {
    options.onDebug?.(
      `[trae-cn] 领取成功但未命中积分字段候选表，响应字段名: ${describeKeys(data)}`,
    )
  }
  const delayed = readServerMessage(data)
  return {
    kind: 'claimed',
    credit: credit ?? 0,
    // Trae 的签到响应不含连续签到天数概念（那是 CodeBuddy 的活动机制）。
    streakDays: 0,
    isStreakDay: false,
    ...delayed.length > 0 ? { delayedMessage: delayed } : {},
  }
}

// ── 积分余额 ──

/**
 * 礼包数组所在的候选键（**T7 已按真机校准**，2026-09-18）。
 *
 * 真机 `web_user_ent_usage` 的礼包数组位于**根层**、键名
 * `user_entitlement_pack_list` —— 故它排在首位。其余候选键与「按
 * `available_endpoint` 指纹扫描」兜底一并保留：`require_usage:true` 下响应里
 * 同时有「用量」数组与「礼包」数组，只按名字猜容易猜错，只按扫描又可能命中
 * 用量数组。名字优先 + 分池指纹兜底是最稳的组合。
 */
export const TRAE_CN_BALANCE_ARRAY_KEYS: readonly string[] = [
  'user_entitlement_pack_list',
  'packages', 'gift_packages', 'gifts', 'gift_list', 'credit_packages',
  'resource_list', 'ent_list', 'entitlements', 'data_list', 'list', 'items',
]

/** 礼包「剩余额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_REMAIN_FIELDS: readonly string[] = [
  'remain_amount', 'remaining_amount', 'remain', 'remaining', 'balance',
  'available_amount', 'left_amount', 'surplus_amount', 'usable_amount',
  'remain_credits', 'credits_remain', 'remain_balance',
]

/** 礼包「总额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_TOTAL_FIELDS: readonly string[] = [
  'total_amount', 'total', 'amount', 'capacity', 'total_credits',
]

/** 礼包「已用额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_USED_FIELDS: readonly string[] = [
  'used_amount', 'used', 'consume_amount', 'consumed_amount', 'used_credits', 'usage_amount',
]

/** 礼包名候选字段（按优先级）。 */
const BALANCE_NAME_FIELDS: readonly string[] = [
  'name', 'package_name', 'gift_name', 'product_name', 'title', 'desc',
]

/** 礼包失效时间候选字段（按优先级）。 */
const BALANCE_EXPIRE_FIELDS: readonly string[] = [
  'expire_time', 'expired_time', 'expire_at', 'end_time', 'expired_at',
]

/** `available_endpoint` 字段名候选（分池依据）。 */
const BALANCE_ENDPOINT_FIELDS: readonly string[] = [
  'available_endpoint', 'endpoint', 'resource_endpoint',
]

/**
 * 积分池的**标识**（`available_endpoint` 的取值）。
 *
 * 它只用来选池，**不再有展示名** —— 分池之后每个面板只显示自己那一个池，
 * 界面上不会出现「通用」「Work」这类字样，池名在此没有任何消费者。
 * 池的**可用范围**语义见 {@link TraeCnCreditBalance}。
 */
export type TraeCnPoolId = typeof TRAE_CN_POOL_UNIVERSAL | typeof TRAE_CN_POOL_WORK

/**
 * Trae CN 的余额结果 —— 与共用 {@link CreditBalance} **逐字段同构**。
 *
 * ## 两个积分池（互相独立，各有一条能花掉它的路径）
 *
 * - **通用池（`available_endpoint=0`）**：TraeCode / IDE 对话扣的就是它，
 *   也就是 `trae-cn` provider 走的那条路径；**2026-09 起签到发的也是通用积分**；
 * - **Work 池（`available_endpoint=1`）**：**只在 TraeWork 里能花**
 *   （`work.trae.cn` 网页版 / 桌面版）；在 TraeWork 中两类积分按**到期时间先后**
 *   扣，Work 专属**仅在到期时间相同时**才优先。⚠️ 官方已把 TraeWork 通道并入
 *   通用通道，本插件不再有任何路径走 Work 池 —— 该常量保留是因为
 *   `available_endpoint` 这个上游字段仍然分池，礼包仍按它归类。
 *
 * ## 展示口径：**按 provider 分池**，一个面板一个池
 *
 * `fetchTraeCnCreditBalance` 按调用方给的 provider 选池（见该函数的说明）：
 * 返回的 `total` 与 `packages` **只含那一个池**。
 *
 * 曾经的「双池超集」（`total` = 通用池 + 另给 `workTotal` / `pools` 让 UI 渲染
 * 「通用 154.22 / Work 2000」）**已删除**：两个面板各显示两段数字，其中永远有
 * 一段是那个面板**花不掉**的（Trae CN 面板花不了 Work 额度、Work 面板花不了
 * 通用额度），信息量是负的。分池之后每个面板的数字就是**它自己实际能花的池**，
 * 不再需要「绝不合并」这条提醒 —— 合并的前提（同一处同时显示两池）已经不存在。
 */
export type TraeCnCreditBalance = CreditBalance

/** 从对象里读第一个存在且可解析的数值；都没有返回 undefined。 */
function readFirstNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 从对象里读第一个非空字符串。 */
function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 沿嵌套路径读取一个**普通对象**；任一层缺失或不是对象时返回 undefined。
 *
 * 真机的礼包条目把额度放在嵌套对象里（`entitlement_base_info` →
 * `product_extra` → `package_extra` → `quota`），`readFirstNumber` 那种只看
 * 顶层的读法在真机响应上**全部 miss**（表现为每个礼包余额都算 0）。
 */
function readObjectPath(
  source: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let current: unknown = source
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined
}

/** 真机（2026-09-18）实测的额度字段名：`credits_limit` 是总额，`credits_amount` 是已用。 */
const NESTED_LIMIT_FIELD = 'credits_limit'
/** 已用额度的字段名（位于 `usage` 对象内）。 */
const NESTED_CONSUMED_FIELD = 'credits_amount'

/**
 * 定位礼包数组。
 *
 * `require_usage:true` 意味着响应里很可能**同时**有「用量」数组与「礼包」数组，
 * 故单纯的「按名字找」或「按扫描找」都会猜错。这里分三轮：
 *
 * 1. **名字命中且可信**：候选键上的数组，要么是**空数组**（服务端明确说没有
 *    礼包），要么元素里带 `available_endpoint` 分池指纹 —— 这两类直接采纳；
 * 2. **广度优先扫描**：取第一个元素带分池指纹的数组（用量数组没有这个指纹）；
 * 3. **回退**：名字命中但「非空且无指纹」的数组（可能是同名的用量列表）。
 *    只在 1、2 都无果时使用，并由调用方在调试行里报出路径与口径，便于校准。
 */
function findPackageArray(
  body: Record<string, unknown>,
): { path: string; items: unknown[]; confident: boolean } | undefined {
  const hasMarker = (items: unknown[]): boolean => items.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const record = item as Record<string, unknown>
    if (BALANCE_ENDPOINT_FIELDS.some((field) => field in record)) return true
    // 真机的分池字段**嵌在** `entitlement_base_info` 里（不在条目顶层），
    // 只看顶层会把真机礼包数组判成「无指纹」，退化成仅按键名命中的不可信路径。
    const base = readObjectPath(record, ['entitlement_base_info'])
    return base !== undefined && BALANCE_ENDPOINT_FIELDS.some((field) => field in base)
  })

  const data = dataLayer(body)
  // `dataLayer` 在没有 `data` 键时**回退到根对象** —— 此时若仍把这一层叫
  // 'data'，调试行会报出「data.user_entitlement_pack_list」这种不存在的路径，
  // 而调试行的全部价值就在于如实报出真实层级（真机校准靠它）。
  const scopes: ReadonlyArray<readonly [string, Record<string, unknown>]> = data === body
    ? [['root', body]]
    : [['data', data], ['root', body]]
  let fallback: { path: string; items: unknown[] } | undefined
  for (const [scopeName, scope] of scopes) {
    for (const key of TRAE_CN_BALANCE_ARRAY_KEYS) {
      const value = scope[key]
      if (!Array.isArray(value)) continue
      const items = value as unknown[]
      if (items.length === 0 || hasMarker(items)) {
        return { path: `${scopeName}.${key}`, items, confident: true }
      }
      fallback ??= { path: `${scopeName}.${key}`, items }
    }
  }

  // 扫描兜底：只认带分池指纹的数组。
  const queue: Array<{ path: string; value: unknown }> = [{ path: 'root', value: body }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (typeof current.value !== 'object' || current.value === null) continue
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      const items = current.value as unknown[]
      if (hasMarker(items)) return { path: current.path, items, confident: true }
      continue
    }
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        queue.push({ path: `${current.path}.${key}`, value })
      }
    }
  }
  return fallback === undefined ? undefined : { ...fallback, confident: false }
}

/** 把数值或时间字符串解析为毫秒时间戳；无法解析返回 NaN。 */
function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级与毫秒级时间戳都见过程（>= 1e12 视为毫秒）。
    return value >= 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value.trim())
    if (Number.isFinite(numeric)) return numeric >= 1e12 ? numeric : numeric * 1000
    return Date.parse(value.replace(' ', 'T'))
  }
  return Number.NaN
}

/** 解析后的单条礼包。 */
interface ParsedPackage {
  endpoint: number
  pkg: CreditPackage
  /** 余额取数口径（供脱敏调试行说明「这个数是怎么来的」）。 */
  source: 'nested-limit' | 'remain-field' | 'total-minus-used' | 'total-as-remain' | 'none'
}

/**
 * 按真机口径读取礼包的额度（**T7 已按真机校准**，2026-09-18）。
 *
 * 真机响应的礼包条目把额度放在**嵌套对象**里，顶层没有任何额度字段：
 *
 * ```
 * entitlement_base_info.product_extra.package_extra.quota.credits_limit  ← 总额（主路径）
 * entitlement_base_info.quota.credits_limit                              ← 总额（回退）
 * usage.credits_amount                                                   ← 已用
 * entitlement_base_info.available_endpoint                               ← 分池
 * ```
 *
 * `usage` 真机上可能是 `{}`（该包尚未产生用量），此时已用按 0 计 ——
 * 不是「查不到」，而是「这个包一分没用过」。
 *
 * 主路径（含 `credits_limit`）命中时返回**余额 = limit − consumed**；
 * 未命中返回 undefined，由调用方走原有的候选表回退链。
 */
function readNestedQuota(record: Record<string, unknown>): {
  endpoint: number | undefined
  limit: number
  consumed: number
  total: number
} | undefined {
  const base = readObjectPath(record, ['entitlement_base_info'])
  if (base === undefined) return undefined

  const packageQuota = readObjectPath(base, ['product_extra', 'package_extra', 'quota'])
  const plainQuota = readObjectPath(base, ['quota'])
  const limit = readFirstNumber(packageQuota ?? {}, [NESTED_LIMIT_FIELD])
    ?? readFirstNumber(plainQuota ?? {}, [NESTED_LIMIT_FIELD])
  if (limit === undefined) return undefined

  // `usage` 可为 `{}` 或缺失 —— 两种都按「未产生用量」计 0。
  const consumed = readFirstNumber(readObjectPath(record, ['usage']) ?? {}, [NESTED_CONSUMED_FIELD]) ?? 0
  const endpoint = readFirstNumber(base, BALANCE_ENDPOINT_FIELDS)
  return { endpoint, limit, consumed, total: limit - consumed }
}

/** 解析一个礼包条目。 */
function parseTraeCnPackage(record: Record<string, unknown>): ParsedPackage {
  // 真机嵌套口径优先；未命中时 endpoint 才走顶层候选表。
  const nested = readNestedQuota(record)
  const endpointRaw = nested?.endpoint ?? readFirstNumber(record, BALANCE_ENDPOINT_FIELDS)
  // 缺失 available_endpoint 时归入**通用池**：chat 扣的就是通用池，
  // 且缺失数量会由调试行报出，真机校准时一眼能看到是不是猜错了。
  const endpoint = endpointRaw ?? TRAE_CN_POOL_UNIVERSAL

  const remain = readFirstNumber(record, TRAE_CN_BALANCE_REMAIN_FIELDS)
  const total = readFirstNumber(record, TRAE_CN_BALANCE_TOTAL_FIELDS)
  const used = readFirstNumber(record, TRAE_CN_BALANCE_USED_FIELDS)

  let remaining: number
  let source: ParsedPackage['source']
  let totalForDisplay: number
  if (nested !== undefined) {
    remaining = nested.total
    totalForDisplay = nested.limit
    source = 'nested-limit'
  } else if (remain !== undefined) {
    remaining = remain
    totalForDisplay = total ?? 0
    source = 'remain-field'
  } else if (total !== undefined && used !== undefined) {
    // 余额 = 总额 - 已用（调研给出的口径之一）。
    remaining = total - used
    totalForDisplay = total
    source = 'total-minus-used'
  } else if (total !== undefined) {
    // 三级回退：调研观察到 claim 后 `total_amount` 由 4500 变为 4650，形态上
    // 它就是「当前可用额」。**此时总额未知**，故 totalForDisplay 置 0
    // （UI 的 formatPackageLine 对 0 显示 '?'，不会把它伪装成 1:1）。
    remaining = total
    totalForDisplay = 0
    source = 'total-as-remain'
  } else {
    remaining = 0
    totalForDisplay = 0
    source = 'none'
  }

  // 已用额度：真机在嵌套 `usage.credits_amount`，其余形态走顶层候选表。
  const usedForDisplay = nested?.consumed ?? used
  const expireRaw = readFirstString(record, BALANCE_EXPIRE_FIELDS)
  const expireValue = BALANCE_EXPIRE_FIELDS
    .map((field) => record[field])
    .find((value) => typeof value === 'string' || typeof value === 'number')
  const expiresAt = toTimestamp(expireValue)
  const name = readFirstString(record, BALANCE_NAME_FIELDS)

  return {
    endpoint,
    source,
    pkg: {
      name: name.length > 0 ? name : '积分包',
      unit: 'credit',
      // 负数一律 clamp 到 0：服务端在计量回滚/超额扣费等异常下可能下发负值，
      // 原样透出会让卡片显示「-12.5 积分」，既无意义又误导。
      remaining: Math.max(0, remaining),
      total: Math.max(0, totalForDisplay),
      used: Math.max(0, usedForDisplay ?? 0),
      // 只按失效时间判：本协议未见 Status 字段（CodeBuddy 那套 3=已过期 不适用）。
      active: !(Number.isFinite(expiresAt) && Date.now() >= expiresAt),
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: expireRaw,
    },
  }
}

/**
 * 查询账号积分余额 —— **只返回 `pool` 那一个池**。
 *
 * 返回 `null` 表示**查不到**（网络 / 信封 / 业务码异常 / 找不到礼包数组），
 * 与「余额为 0」严格区分 —— 失败时 UI 应显示原因而不是 0。
 *
 * ## `pool` 由调用方按 **provider（面板 id）** 给出
 *
 * 这是本次的语义锚点：**面板显示的数字 = 该 provider 实际能花的池**。
 *
 * | provider | 面板 | `pool` | 谁在花它 |
 * |---|---|---|---|
 * | `trae-cn` | Trae CN | `TRAE_CN_POOL_UNIVERSAL`（0） | IDE 对话扣的就是它 |
 *
 * 于是一个面板只显示一个数字与自己那批资源包，界面上不再出现「通用」
 * 「Work」字样 —— 每个数字都对应一条**能把钱花掉的真实路径**，不存在
 * 「显示了但花不掉」的那一段。这也让「绝不把两池相加」这条提醒失去对象：
 * 同一处已经不会再同时出现两个池。
 *
 * ⚠️ `pool` 是**路径属性、与账号无关**：它必须由面板分支（`req.provider`）
 * 决定，而不是由账号池那条链路顺带给出 —— 后者答的是「查谁的账号」，
 * 两个问题混在一起会让某个面板显示它花不掉的池，且**不报错**。
 *
 * ## 解析一行未动
 *
 * 本函数前半段（T7 校准的嵌套口径、候选表 + `available_endpoint` 指纹扫描
 * 兜底、三级余额回退链）与改动前**逐字节相同** —— 本次只改了「解析完成后的
 * 池选择与响应构造」。缺 `available_endpoint` 的礼包仍归**通用池**
 * （见 {@link parseTraeCnPackage}）。
 */
export async function fetchTraeCnCreditBalance(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  pool: TraeCnPoolId,
  options: TraeCnCreditsOptions = {},
): Promise<TraeCnCreditBalance | null> {
  const result = await postJson(
    TRAE_CN_USER_ENT_USAGE_PATH, credential, product, options,
    JSON.stringify({ require_usage: true }),
    // 本端点**没有 code 信封**（真机校准），按结构特征判成功。
    'trae-pay',
  )
  if (!result.ok) {
    options.onDebug?.(`[trae-cn] 余额查询失败 code=${result.code}: ${result.message}`)
    return null
  }
  const found = findPackageArray(result.body)
  if (found === undefined) {
    // 拿不到礼包数组 = 查不到，**不是** 0 积分。
    options.onDebug?.(
      `[trae-cn] 余额响应里找不到礼包数组，字段名: ${describeKeys(dataLayer(result.body))}`,
    )
    return null
  }

  const parsed: ParsedPackage[] = []
  for (const item of found.items) {
    if (typeof item !== 'object' || item === null) continue
    parsed.push(parseTraeCnPackage(item as Record<string, unknown>))
  }
  const firstItem = found.items.find((item) => typeof item === 'object' && item !== null)
  options.onDebug?.(
    `[trae-cn] 余额礼包数组=${found.path}（${found.confident ? '已按分池指纹确认' : '**未确认**，仅按候选键名命中'}），`
    + `共 ${parsed.length} 项；`
    + `字段名（仅键名）: ${firstItem === undefined ? '(无条目)' : describeKeys(firstItem as Record<string, unknown>)}`,
  )
  const sources = [...new Set(parsed.map((entry) => entry.source))]
  options.onDebug?.(`[trae-cn] 余额取数口径: ${sources.length === 0 ? '(无条目)' : sources.join(' / ')}（T7 已校准：nested-limit 为主路径）`)

  // 只留本池：另一个池的礼包不在本面板能花的范围内，显示出来只会误导。
  const inPool = parsed.filter((entry) => entry.endpoint === pool)
  const endpoints = [...new Set(parsed.map((entry) => entry.endpoint))].sort((a, b) => a - b)
  options.onDebug?.(
    `[trae-cn] 分池展示: 本池 endpoint=${pool}，取 ${inPool.length}/${parsed.length} 项；`
    + `响应中出现过的池: ${endpoints.length === 0 ? '(无)' : endpoints.join(',')}`,
  )

  // 只累加**有效**礼包的本池余额：失效包里的额度服务端仍会返回，但不能用于
  // 扣费，并进总额会让数字虚高。失效额度也**按本池**汇总 —— 包明细已被过滤，
  // 跨池汇总会得到「tooltip 里一行都没有，却提示另有 N 已失效」的自相矛盾。
  const total = roundCredits(
    inPool.reduce((sum, entry) => sum + (entry.pkg.active ? entry.pkg.remaining : 0), 0),
  )
  const expiredTotal = roundCredits(
    inPool.reduce((sum, entry) => sum + (entry.pkg.active ? 0 : Math.max(0, entry.pkg.remaining)), 0),
  )
  return {
    total,
    // 包名原样透出：分池之后同一个列表里只有本池的包，不再需要「[Work 积分]」
    // 这类前缀来区分（那前缀本就是为两池混排准备的）。
    packages: inPool.map((entry) => entry.pkg),
    expiredTotal,
  }
}

/**
 * 把额度规整为两位小数。
 *
 * 服务端精确值本身可能带浮点表示（如 55.67000031），多包相加会把尾数噪声
 * 显式化 —— 金额展示到分即可（与 `credits.ts` / `lobsterai-credits.ts` 同口径）。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}
