/**
 * Trae CN（字节跳动 Trae 国内版）每日签到与积分余额。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）/ `src/lobsterai-credits.ts` **刻意分开**：
 * 三条协议没有一处共用（端点、信封、鉴权头、幂等判据全不同），硬合并只会让
 * 某一个文件出现大量 `if (provider === …)` 分支。但**复用 `credits.ts` 的类型**，
 * 让 `computeClaimSummary`、`collectCreditsStatus` / `collectClaimResults` /
 * `collectCreditBalances` 三个收集器与前端的结果摘要 UI 都不必各写一份 ——
 * Trae 只需注入自己的下钻函数（见 `src/account-hub-rpc.ts` 的三处分发），
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
 * ⚠️ **`x-os-version` / `x-app-version` 的旧「身份保真」修复与 `9074` 无关**（第 4 次
 * 定性说「根因是名额/风控」，第 5 次定性纠正为**设备号拉黑** —— 但两者都不是版本号
 * 形态问题）。见下节。
 *
 * ## `9074` 的定性（2026-09-23 **第五次**修正，前四次均作废）
 *
 * | 次序 | 定性 | 状态 |
 * |---|---|---|
 * | 第 1 次 | 瞬时频次软限流 | **作废**（8 秒退避重放仍 9074、三日 452 次报错） |
 * | 第 2 次 | 活动级当日容量/名额限制或账号侧风控 | **作废**（误读：当时见官方同期签成功，就以为「不是名额」） |
 * | 第 3 次 | 设备身份：服务端按 `x-device-id` 记设备维度签到状态 | **作废**（判定矩阵：账号已签时任意设备号都 code:0） |
 * | 第 4 次 | 名额/风控类拒绝，与设备号取值无关 | **作废**（见下方单变量矩阵） |
 * | **第 5 次（本次，现行）** | **设备号拉黑**：服务端把「在**未产出奖励**的 claim 中出现过的设备号」拉黑 | 真机单变量矩阵（下述） |
 *
 * 真机**单变量矩阵**（2026-09-23，`POST …/checkin_credits/claim`）：
 *
 * | 账号级 `checked_in` | 设备级 `did_checked_in` | 响应 |
 * |---|---|---|
 * | 已签 | 任意 | `code:0`（成功 —— **任意设备号**都成功） |
 * | 未签 | 已签 | `code:9095`「当前设备今日已经签到」 |
 * | 未签 | 未签、设备号**干净** | `code:0`（**首次 claim 即成功**） |
 * | 未签 | 未签、设备号**被拉黑** | `code:9074`「当前参与用户太多，请稍后再试」 |
 *
 * 第 5 次定性的证据是**同一账号同一 token、11 秒间隔的对照**：换一个**全新 16 位
 * 设备号**，首次 claim 直接 `code:0`；换回旧号立刻又是 `9074`（独立复现）。
 * 故「名额/风控」那个第 4 次定性**也是错的** —— 服务端确实在认设备，只是它认的是
 * **「这个号有没有在失败的 claim 里出现过」**，而不是「这个号是不是登录时那个」
 * （第 3 次定性的错处在于把「必须与登录同源」当成了判据）。
 *
 * 被反证的候选（矩阵已排除，不要再回头去查）：传输头 / 会话 / `req_source` / UA
 * **都不是**条件；官方客户端用的是**机器级稳定 AHA 号**（每次登录都换号的实现因此
 * 天然更容易撞上拉黑 —— 这正是「河童重登无效」之谜：那些账号的
 * `checkin_device_id` 是 exchange 绑定的稳定号，重登并不换号）。
 *
 * ## 9074 的处置：换一个干净设备号重试一次（用户 2026-09-23 拍板）
 *
 * 既然 9074 是「这个号被拉黑了」，正确动作就是**换号**（而不是退避或等 sweep）：
 * 见 {@link rotateTraeCnCheckinDeviceId}。重试**硬编码一次**，不做循环 ——
 * 一个刚生成的全新号不该再被拉黑，若它仍回 9074，说明本次拒绝另有原因，
 * 继续换号只是把随机号当骰子摇。
 *
 * ⚠️ **它不走** {@link TRAE_CN_CLAIM_RETRY_CODES}（那张表是「等几秒再问同一个请求」
 * 的软限流退避）：退避再久也不会让一个被拉黑的号变得可用，换号则一次就够。
 * 两条路径的**动作**与**次数**都不同，故刻意分开而不是把 9074 加回那张表。
 *
 * ## claim 段的请求内重试（2026-09-23 收窄）
 *
 * `9074` 已**退出**请求内退避表（见 {@link TRAE_CN_CLAIM_RETRY_CODES}）：它既不是
 * 「等几秒就好」，在旧定性（名额/风控）下重试同一个请求也只是让用户对着转圈多等
 * 4 秒。**它的重试是换号那一次**（见上节）；若换号后仍是 9074，才归 `unavailable`
 * outcome —— **不写今日状态**，故宿主 4 小时的 sweep（`src/account-hub-rpc.ts`）
 * 下一个周期仍会重新尝试（届时凭据里已是那个新号，不是被拉黑的旧号）。
 *
 * 退避表因此只剩 `4007` / `3004` 这类真正的**瞬时软限流**；**status 段不重试**
 * （读接口没有名额问题，重试只是重复请求），`9004`（设备头）与 `1001`（凭据失效）
 * **绝不**重试 —— 那是确定性失败，重试只会把同一个结果问三遍。
 *
 * ⚠️ `9074` 仍留在 **chat 侧**的共享退避表（`TRAE_CN_BACKOFF_CODES`）里：两条
 * 协议线对「这个码该怎么处置」的回答不同（chat 侧动作仍是「退避、不换号」），
 * 签到侧只是不再把它算作**可重试**。
 *
 * ## 与 `lobsterai-credits.ts` 的签名差异（刻意）
 *
 * LobsterAI 版用 positional `fetcher` 形参；本模块改用
 * {@link TraeCnCreditsOptions} 选项包，因为**本协议有两处字段名待校准**
 * （礼包数组位置、礼包余额字段），需要一个**脱敏调试出口**
 * （`onDebug`，只输出字段名不输出值）供真机一次性收敛。为了一个可选的调试
 * 出口而把 `fetcher` 挤成第三、调试挤成第四个位置参数，会让所有调用点都
 * 出现 `undefined` 占位洞，可读性更差。
 *
 * ⚠️ **曾经的第三处「待校准」已随 T8 定案删除**：领取响应里**没有**积分数，
 * 故不再需要「本次获得积分字段名」的校准出口。详见
 * {@link claimTraeCnDailyCheckin} 的「claim 成功后的补查」。
 *
 * ⚠️ **未接线项**：`onDebug` 目前只在 RPC 分发处接到 `ctx.logger.info`，
 * 由宿主日志承接；它**不**经 RPC 回传给客户端（协议里没有这个字段）。
 * 故真机校准时看宿主日志，而不是看 Account Hub 面板。
 */

import { version as osVersion } from 'node:os'
import {
  TRAE_CN_DEVICE_SOURCE_ROTATED,
  TRAE_CN_REQUEST_TIMEOUT_MS,
  type TraeCnProduct,
} from './trae-cn-product.js'
import {
  generateTraeCnDeviceId,
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
 *
 * ⚠️ **与 `9074` 无关**：2026-09-23 的判定矩阵推翻了「9074 = 设备身份」的旧定性
 * （见文件头）。`9004` 才是**设备头本身**的判据 —— 两者此前被混为一谈。
 */
export const TRAE_CN_CODE_DEVICE_REJECTED = 9004

/**
 * 「当前设备今日已经签到」码（`9095`）。
 *
 * 真机判定矩阵（2026-09-23）：**账号级未签 + 设备级已签** → `9095`。
 *
 * 语义是「今天这个设备已经领过一份」—— 账号级的 `checked_in` 仍为 false，
 * 但这份奖励今天确实已经到手，故归一 `already-claimed`（界面显示已签、
 * 宿主写今日状态），**不是**失败、也**不重试**（确定性结果）。
 */
export const TRAE_CN_CODE_DEVICE_ALREADY_CLAIMED = 9095

/**
 * 「当前参与用户太多，请稍后再试」码（**真根因：设备号被服务端拉黑**）。
 *
 * ⚠️ **定性已于 2026-09-23 第五次修正**（前四次均作废，完整历次见文件头）：
 *
 * | 次序 | 定性 | 作废依据 |
 * |---|---|---|
 * | 1 | 瞬时频次软限流 | 8 秒退避重放**仍** 9074；三日 452 次报错 |
 * | 2 | 活动级当日容量/名额限制或账号侧风控 | 误读（官方同期可签成功 ⇒ 当时误判「不是名额」） |
 * | 3 | 设备身份不被活动系统认可 | 判定矩阵：账号级已签时**任意设备号**都回 `code:0` |
 * | 4 | 名额/风控类拒绝，与设备号取值无关 | 换**全新**设备号首次 claim 即 `code:0`（11 秒间隔对照） |
 * | **5（现行）** | **设备号拉黑**：在**未产出奖励**的 claim 中出现过的号被拉黑 | 真机单变量矩阵（文件头） |
 *
 * 故它与 {@link TRAE_CN_CODE_DEVICE_ALREADY_CLAIMED} 的分工是：
 * 9095 = **这台设备今天拿到过奖励**（确定性、归 `already-claimed`）；
 * 9074 = **这个设备号此前在失败的 claim 里出现过**（换一个干净号即可，见
 * {@link rotateTraeCnCheckinDeviceId}）。
 *
 * 处置：**换号重试一次**；仍是 9074 则归 `unavailable` —— **不写**签到状态
 * （下次 sweep 重试，届时用的是已落盘的新号）、不标已签。用户文案见
 * {@link describeFailureCode}。
 */
export const TRAE_CN_CODE_TOO_MANY_USERS = 9074

/** 传输层失败（网络异常 / 响应无法解析 / 信封与预期不符）的统一码。 */
const CODE_TRANSPORT_FAILED = -1

// ── claim 段的请求内重试（2026-09-23 收窄为两个软限流码） ──

/**
 * claim 段可重试的业务码（**`TRAE_CN_BACKOFF_CODES` 的真子集**）。
 *
 * ⚠️ **`9074` 已于 2026-09-23 移出本表**（原为 `[9074, 4007, 3004]`）：它既不是
 * 「等几秒就好」（第五次定性：设备号被拉黑，等多久都不会变），也不是靠退避能
 * 解决的事 —— **它的重试是换设备号那一次**（{@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT}
 * 次，见 {@link claimTraeCnWithDeviceRotation}）。若换号后仍是 9074，才归
 * `unavailable`、不写今日状态，由宿主 4 小时的 sweep 下个周期再试。
 *
 * 留下的两个码在签到语境下都是真正的**瞬时软限流**：服务端明确要求稍后再来，
 * 秒级重试有实际意义。`3003`（`MODEL_FAIL`，`all models failed`）**刻意不在**
 * 本表内 —— 它是 **chat 通道**的基础设施故障码，签到端点上没有对应观测。
 *
 * ⚠️ 判定**同时**要求命中 {@link TRAE_CN_BACKOFF_CODES}（见
 * {@link isTraeCnClaimRetryable}）：上游若把某个码从共享退避表里移除
 * （即不再认为它可重试），签到侧的重试会**自动**跟着停 —— 一处定义，不会漂移。
 * ⚠️ `9074` **仍在**那张共享表里（chat 侧动作不变），故这里必须是**独立的窄表**
 * 而不是直接引用共享表 —— 两处要是写成一份，「签到不再重试 9074」就无从表达。
 */
export const TRAE_CN_CLAIM_RETRY_CODES: readonly number[] = [4007, 3004]

/**
 * 重试前的等待时长（指数退避，**共 2 次重试**：1s → 3s，累计 4s）。
 *
 * 只服务 {@link TRAE_CN_CLAIM_RETRY_CODES} 里那两个瞬时软限流码。上界刻意压得很
 * 小：真正的瞬时抖动在几秒内就会过去，长时间重试只会让用户对着转圈等。
 */
export const TRAE_CN_CLAIM_RETRY_DELAYS_MS: readonly number[] = [1000, 3000]

/**
 * 该业务码是否应触发 claim 段的退避重试。
 *
 * 两道判据缺一不可：本地清单（签到语境的相关码）+ 共享退避表（上游对
 * 「可重试」的权威定义）。`9004`（设备头）、`1001`（凭据失效）与 `9095`
 * （设备今日已签）**都**不在任何一张表里 —— 它们是确定性结果，重试只会把同一个
 * 结果问三遍。`9074` 在共享表里但**不在**本地清单里（见
 * {@link TRAE_CN_CLAIM_RETRY_CODES}），故本函数对它返回 false。
 */
export function isTraeCnClaimRetryable(code: number | undefined): boolean {
  if (code === undefined) return false
  return TRAE_CN_CLAIM_RETRY_CODES.includes(code) && TRAE_CN_BACKOFF_CODES.includes(code)
}

// ── 9074 换号重试（2026-09-23 用户拍板；整段可单独 revert） ──

/**
 * 9074 换号重试的**次数上限**（硬编码 1，不做循环）。
 *
 * 一个刚生成的全新 16 位号**不该**再被拉黑（真机矩阵：全新号首次 claim 即
 * `code:0`）。若换了号仍是 9074，说明这次拒绝另有原因，继续摇随机号没有依据 ——
 * 故不设可配置项、不写循环：改这个数字就等于改「换几次号」这条策略本身，
 * 应当是一次显式改动而不是一个旋钮。
 */
export const TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT = 1

/**
 * 换一个全新的签到设备号（**9074 的唯一处置**，2026-09-23）。
 *
 * ## 为什么是「换号」而不是「退避」
 *
 * 真机单变量矩阵定案：`9074` = 服务端把「在**未产出奖励**的 claim 中出现过的
 * 设备号」拉黑 —— 同一账号同一 token、11 秒间隔的对照里，**全新 16 位号首次
 * claim 直接 `code:0`**，换回旧号立刻又是 `9074`。故这个码描述的是**设备号的
 * 状态**，等多久都不会变；唯一有效的动作是换一个服务端没见过的号。
 *
 * ## 形态**复用登录时的生成器**（不发明新格式）
 *
 * 调 {@link generateTraeCnDeviceId}（登录 URL 的 `device_id` 用的同一个函数），
 * 故新号与登录时那个**逐形态一致**：16 位纯十进制。刻意不另写一个生成器 ——
 * 两份实现一旦漂移，就会出现「登录号合法、换号非法」这种只在一个入口复现的
 * 失败，而那正是设备头类缺陷最难查的形态。
 *
 * ⚠️ **这不是 README 禁止的「伪造设备身份」**：那条禁令针对的是「拿 `machine_id`
 * 之类**别的字段折算**出一个看起来合法的号来掩盖缺失」。这里换的是一个**真实
 * 注册形态的随机设备号**，且是**用户 2026-09-23 明确拍板**的既定策略
 * （见 `docs/agents/providers-trae-cn.md` 的拍板记录）。如实说明区别：前者是
 * 「把没有的说成有」，后者是「换一个身份重新尝试」—— 服务端侧表现为
 * `did_checked_in` 归 false，是**如实**的新设备，不是伪装成旧设备。
 *
 * ## 只动两个字段
 *
 * 返回的是**新对象**（不改入参）：`checkin_device_id` 换成新号、
 * `device_id_source` 标记为 {@link TRAE_CN_DEVICE_SOURCE_ROTATED}，其余字段
 * （含 exchange 绑定的 `device_id`）**逐字段原样保留** —— 换号是签到侧的事，
 * 与 chat 侧的绑定标识无关，`traeCnAccessHeaders` 不受影响。
 *
 * @param credential - 旧凭据（不改动）。
 * @returns 换号后的新凭据（调用方负责写回）。
 */
export function rotateTraeCnCheckinDeviceId(credential: TraeCnCredential): TraeCnCredential {
  return {
    ...credential,
    checkin_device_id: generateTraeCnDeviceId(),
    device_id_source: TRAE_CN_DEVICE_SOURCE_ROTATED,
  }
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
   * 叫什么」。生产接线把它接到 `ctx.logger.info`（见 `src/account-hub-rpc.ts` 的
   * 三处分发）；它**不**回传客户端，故校准看宿主日志。
   */
  onDebug?: (message: string) => void
  /**
   * 凭据写回出口（**9074 换号重试用**，2026-09-23）。
   *
   * 换设备号后必须把新号**持久化**，否则下一次 sweep 又拿被拉黑的旧号去签
   * （每轮都白烧一次 9074 的往返）。本模块拿不到凭据 ref、也不该猜，故与
   * `qoder-credits.ts` 的 `persistIdentity` 同款：**出口交给接线层**
   * （`src/account-hub-rpc.ts` → `ctx.credentials.set(ref, …)`）。
   *
   * 调用时机：仅当 claim 真的因 9074 换过号时（首发就成功、或非 9074 的失败
   * **都不会**调它）—— 每次签到都写一遍凭据是纯粹的磁盘抖动。
   *
   * ⚠️ **抛错不影响签到主流程**：写回失败只记一条 `onDebug`，重试照常进行。
   * 写回的号只决定**下一轮**的起点，与本次领取是否成功无关；因为一次磁盘写
   * 失败把已经成功的领取报成失败，是比「下轮起点脏」更坏的结果。
   *
   * 省略时整条换号重试路径**照常工作**（只是不落盘）—— 老宿主 / 单测无需接线。
   */
  persistCredential?: (credential: TraeCnCredential) => void | Promise<void>
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
 * 把「响应不是 JSON」整理成可读原因。
 *
 * 凭据失效/过期时网关可能返回 **HTML 错误页**，直接 `response.json()` 会抛
 * `Unexpected token '<', "<html> <h"... is not valid JSON` —— 用户既不知道
 * 发生了什么，也看不出该重新登录。这里改为明确指向凭据问题并附状态码。
 *
 * 与 `credits.ts` / `lobsterai-credits.ts` 的同名函数**同款**（三条协议线各自
 * 独立成文件，故刻意各留一份而不是跨文件共用：那两份的调用方签名与错误码
 * 体系都不同，抽出来反而要引入一层新依赖）。
 */
function describeNonJsonResponse(status: number, text: string): string {
  // 401/403 基本就是凭据失效；其余状态也一并如实给出，不做过度推断。
  if (status === 401 || status === 403) {
    return `凭据已失效（HTTP ${status}），请重新登录该账号`
  }
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
  return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`
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
 *
 * ⚠️ **不要用 `response.json()`**：凭据失效时网关返回 HTML 错误页，
 * `json()` 抛出的 `Unexpected token '<'` 对用户毫无意义。故先取文本再解析，
 * 非 JSON 时给出带状态码的可读原因（与 `credits.ts` / `lobsterai-credits.ts`
 * 同款修复 —— 上游 `553ef21` 只改了那两个文件，本条是本仓补齐的第三处）。
 *
 * ⚠️ **读 logid 头必须早于读 body**：`response.text()` 之后 `headers` 仍可读，
 * 但「先读头再读体」这个既有顺序是**刻意**的（让「logid 属于这一次响应」在
 * 代码上显而易见），改动 body 读取方式时不要顺手把它挪到后面。
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
    // 先读响应头再解析 body：`response.text()` 之后再读头同样可行，但把取数
    // 放在紧邻响应的位置，能让「logid 属于这一次响应」这件事在代码上显而易见。
    logid = readLogId(response)
    const text = await response.text()
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      // 非 JSON：多半是网关 HTML 错误页（凭据失效的典型表现）。
      return withLogId(
        {
          ok: false as const,
          code: CODE_TRANSPORT_FAILED,
          message: describeNonJsonResponse(response.status, text),
        },
        logid,
      )
    }
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
    // 服务端原文是「当前参与用户太多，请稍后再试」—— 它就是**准确的**描述，
    // 只是真因（第五次定性，2026-09-23）是**这个设备号在失败的 claim 里出现过、
    // 被服务端拉黑了**，而不是「参与的人真的多」。
    //
    // 这条文案只在**换号重试之后仍是 9074** 时出现（首发 9074 已经换过号了），
    // 故它描述的确实是「换了干净号也不行」的现场。
    //
    // ⚠️ 这里**刻意不给**任何「重新登录 / 登记设备身份」的指引：那个旧文案指向的
    // 动作**治不了**它（账号级已签时任意设备号都回 code:0 —— 服务端认的是
    // 「这个号有没有在黑名单里」，不是「它是不是登录时那个」）。错误指引比没有
    // 指引更坏 —— 用户会照着做，做完仍然失败。
    //
    // 正确动作是「什么都不做，稍后自动重试」：它由宿主 4 小时的 sweep 承接
    // （归 unavailable、不写今日状态），且届时凭据里已是换号后的新号。故文案把
    // 这件事**明说**，让用户不必反复手点。
    //
    // 刻意**不在文案里重复 code**：前端 `formatClaimFailureLine` 会统一追加
    // `（code N）`，这里再写一次会显示成「…（code 9074）…（code 9074）」。
    return `${message}（服务端此刻暂不可签，稍后自动重试）`
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
 * 映射到共用的 {@link CheckinStatus}：`active` / `todayCheckedIn` / `dailyCredit`
 * 三项有实测依据，其余字段（连续天数 / 今日已领 / 活动名…）Trae 的状态响应里
 * **没有已确认的对应字段**，故一律取零值，而不是臆造一份看起来丰满的状态。
 * 这与 LobsterAI 的处理同因（那份协议同样没有这些概念）。
 *
 * ⚠️ **`dailyCredit` 取自 `credits` 字段（T8 定案，2026-09-20）**：真机实测
 * status 响应里 `credits: 150`，与积分余额中「签到奖励」包的 `credits_limit: 150`
 * 完全吻合。**这是全模块唯一有实测依据的积分数来源** —— claim 响应里根本没有
 * 积分字段（见 {@link claimTraeCnDailyCheckin}），故领取后要靠本函数补查。
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
  const data = dataLayer(result.body)
  // `credits` 的**字段名**有实测依据，但它落在哪一层（`data` 还是根对象）没有
  // 取证 —— 与 `checked_in` / `enable` 同一处境，故同样两层都看（见
  // `readBoolAnywhere` 的同款理由）。刻意**不加** `credit` 之类的候选名：
  // 候选表正是 T8 那个「猜一个不存在的字段」的旧缺陷形态。
  const dailyCredit = readFirstNumber(data, ['credits'])
    ?? readFirstNumber(result.body, ['credits'])
    ?? 0
  return {
    // 缺失视为开启：只有服务端**显式** enable:false 才判未开启，
    // 否则一旦响应里省略该字段，UI 会把正常账号显示成「活动未开启」。
    active: state.enabled !== false,
    todayCheckedIn: state.checkedIn,
    streakDays: 0,
    dailyCredit,
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
//
// ✅ **T8 已按真机定案（2026-09-20）——「领取响应里没有积分数」**。
//
// 上游真机实测：`checkin_credits/claim` 的**完整响应**就是
// `{"code":0,"message":"success"}`，**不含任何积分字段**。
//
// 因此本模块曾经那张「本次获得积分」候选表
// （`credit` / `credits` / `credits_granted` / `reward_credits` / `reward` /
// `amount` / `integral`）**注定全部落空** —— 它不是在猜字段名，而是在猜一个
// **根本不存在的字段**，表现为界面永远显示「领取成功 **+0** 积分」。
//
// 真实数值只在 **status 端点**的 `credits` 字段里（真机实测 `credits: 150`，
// 与积分余额里「签到奖励」包的 `credits_limit: 150` 完全吻合 —— 两条独立
// 证据互相印证，故这不是一个「猜出来的字段」）。
//
// 故领取成功后**补查一次 status** 取 `credits`：多一次往返，换取如实报告所得。
// 候选表与 `readClaimedCredit` 已整体删除，理由与处置见
// {@link claimTraeCnDailyCheckin} 的「claim 成功后的补查」一节。

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
 * 9074 的处置：**换一个全新设备号，重试一次 claim**（2026-09-23 用户拍板）。
 *
 * 真机单变量矩阵（见文件头）定案 `9074` = 该设备号已被服务端拉黑，故这里的动作
 * 是**换号**而不是退避。返回的是「重试结果 + 重试用的凭据」——调用方两者都要：
 * 结果决定 outcome，凭据决定写回什么（`checkin_device_id` 必须是**重试实际用的**
 * 那个号，否则下一轮拿旧号起步，每次都要先撞一次 9074）。
 *
 * ## 三条刻意的边界
 *
 * 1. **只重试一次**（{@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT}），不做循环：
 *    全新号不该再被拉黑；仍是 9074 说明另有原因，继续摇号没有依据。
 * 2. **不进** {@link TRAE_CN_CLAIM_RETRY_CODES} 的退避路径：那张表是「等几秒再问
 *    同一个请求」，与「换身份立刻重问」是两种动作，混在一起会让 9074 白等 4 秒。
 * 3. **写回是尽力而为**：{@link TraeCnCreditsOptions.persistCredential} 抛错只记
 *    一条调试行，重试照常返回 —— 写回只决定下一轮起点，与本次领取成败无关。
 *
 * ⚠️ **两个结果分支都要写回**（成功、以及仍是 9074 的 `unavailable` 都一样）：
 * 失败分支尤其不能漏 —— 那正是「这个号被拉黑了，下轮别再拿它去撞」这件事的
 * 唯一落点。漏掉它，4h sweep 的每一次重试都会先烧一发注定 9074 的请求。
 */
async function claimTraeCnWithDeviceRotation(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions,
): Promise<{ result: CreditsCallResult; credential: TraeCnCredential }> {
  const rotated = rotateTraeCnCheckinDeviceId(credential)
  options.onDebug?.(
    `[trae-cn] claim 返回 ${TRAE_CN_CODE_TOO_MANY_USERS}（设备号被拉黑），`
    + `换成新的 16 位设备号重试一次（共 ${TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 次）`,
  )
  const result = await postJson(
    TRAE_CN_CHECKIN_CLAIM_PATH, rotated, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  // 写回**先于**结果分流：成功/失败两条路都要落盘（见函数注释的 ⚠️）。
  await persistRotatedDeviceId(rotated, options)
  return { result, credential: rotated }
}

/**
 * 把轮换后的凭据交给接线层落盘；失败只记调试行，**绝不冒泡**。
 *
 * 与 `qoder-credits.ts` 的 `persistQoderIdentity` 同款取舍（那条路径的理由是
 * 「身份字段只影响昵称显示」，这里更强：写回失败只影响**下一轮 sweep 的起点**）。
 *
 * ⚠️ 未接线 `persistCredential` 时**什么都不做**（而不是抛错或打日志）：那是
 * 「本调用方不负责持久化」的既定形态（单测、老宿主），不是异常。
 */
async function persistRotatedDeviceId(
  credential: TraeCnCredential,
  options: TraeCnCreditsOptions,
): Promise<void> {
  if (options.persistCredential === undefined) return
  try {
    await options.persistCredential(credential)
  } catch (error) {
    options.onDebug?.(
      '[trae-cn] 换号后的设备号写回失败（不影响本次签到，但下一轮仍会用旧号起步）：'
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 执行每日签到领取。
 *
 * 完整流程（**status → 未领则 claim → 补查 status**），返回与 `credits.ts`
 * 同构的 {@link ClaimOutcome} 判别联合 —— `computeClaimSummary` 与结果摘要 UI
 * 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 状态查询失败 → `failed`（转述底层原因；`code:1001` 译为「凭据已失效」）；
 * 2. `checked_in` 为真 → `already-claimed`（**不发领取请求**，也不补查）；
 * 3. 服务端显式 `enable:false` → `inactive`；
 * 4. 领取请求返回失败码，按码分流（**四种，0 不等于「只有一种失败」**）：
 *    - `9095`（设备今日已签）→ `already-claimed`（今天这份已经到手）；
 *    - `9074`（**设备号被拉黑**）→ 换一个全新 16 位号**重试一次**，结果**按重试
 *      自己的码**再走一遍本分流（成功 → `claimed`；仍 9074 → `unavailable`）；
 *    - 其余（`1001` 凭据失效 / `9004` 设备头 / …）→ `failed`；
 * 5. 成功 → **补查一次 status 取 `credits`**（见下），然后 `claimed`。
 *
 * ⚠️ 第 4 步的 `already-claimed` **不补查 status**：这一份奖励不是本次领到的，
 * 补查拿到的数字要么是上次的、要么没有，报出来只会误导。
 *
 * ## claim 成功后的补查（T8 定案，2026-09-20）
 *
 * claim 的完整响应就是 `{"code":0,"message":"success"}`，**没有积分数** ——
 * 故第 5 步必须补查一次 status，从它的 `credits` 字段取本次所得（真机实测 150）。
 * 补查**失败不改变 claimed 语义**：领取这件事已经由服务端的 `code:0` 确认过了，
 * 只是数字拿不到，故 credit 落 0 并留一条调试行说明原因，而不是把整次领取
 * 报成失败（那会让用户重试一次已经成功的领取）。
 *
 * 补查复用 {@link fetchTraeCnCheckinStatus}（**已有的 status 端点函数**），
 * 不另写一份网络代码：它的字段解析、logid 透传、信封判定与预检那次必须同源，
 * 各写一份必然漂移。
 *
 * ## 只有 claim 段重试（status 段**一次都不重试**）
 *
 * 第 1 步的 status 是**读**接口：它没有名额问题（实测同一套设备头下 status
 * 恒成功、claim 才可能被拒），失败即失败，重试只是把同一个结果再问一遍。
 * 第 4 步的 claim 是**写**接口，命中 {@link isTraeCnClaimRetryable} 时按
 * {@link TRAE_CN_CLAIM_RETRY_DELAYS_MS} 退避重试（1s → 3s，共 2 次）；
 * 重试**耗尽**后按**最后一次**尝试的 code / message / logid 返回 ——
 * 用户看到的是最近一次现场，而不是第一次的（logid 尤其如此：它标识单次请求）。
 *
 * ⚠️ `9074` **不在这张重试表里**（2026-09-23 收窄）：它既不是「等几秒就好」，
 * 在处理上也不是退避 —— **它的重试是换设备号那一次**（见
 * {@link claimTraeCnWithDeviceRotation}）。若换号后仍是 9074，才归 `unavailable`、
 * 不写今日状态，故宿主 4 小时的 sweep 下个周期仍会被重新尝试（届时凭据里已是
 * 那个新号，不是被拉黑的旧号）。
 *
 * ⚠️ 第 5 步的补查**不重试**：它是读接口，且它的失败不会改变 outcome 的 kind，
 * 重试只会拖长一次已经成功的领取。它的 `onDebug` 出口与上面共用。
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
  if (claimResult.ok) return await finishTraeCnClaim(claimResult, credential, product, options)
  // `9074` = **设备号被拉黑**（第五次定性，见文件头）：先换一个全新号重试一次
  // （真机矩阵：全新号首次 claim 即 `code:0`）。这是**唯一**会改写凭据的路径，
  // 也是本改动相对既有行为的全部差异 —— 其余失败码直接走下面的分流。
  if (claimResult.code === TRAE_CN_CODE_TOO_MANY_USERS) {
    const rotated = await claimTraeCnWithDeviceRotation(credential, product, options)
    // 重试成功 → 走与首发成功**同一个**收尾（否则这条路径会少一个积分数字）。
    if (rotated.result.ok) {
      return await finishTraeCnClaim(rotated.result, rotated.credential, product, options)
    }
    // 重试的失败**按它自己**的码分流，不是按首发那个 9074：重试撞上 9095 就该报
    // 「今天已签到」——拿首发结果覆盖会把一次实际到手的结果报成「暂不可签」。
    return traeCnClaimFailureOutcome(rotated.result)
  }
  return traeCnClaimFailureOutcome(claimResult)
}

/**
 * 把一次**失败的** claim 结果归一到 {@link ClaimOutcome}。
 *
 * 抽出来是因为它有**两个调用点**：首发失败、以及 9074 换号重试后失败。两处的
 * 分流规则必须逐字相同（`9095` → 已领、`9074` → 暂不可签、其余 → 失败），
 * 各写一份必然漂移。
 *
 * ⚠️ **调用方必须先处理 9074 的换号重试**：本函数对 9074 直接返回 `unavailable`，
 * 它是「换了号仍被拒」的落点，不负责触发轮换 —— 混在一起会让「是否已经换过号」
 * 变成一个隐式状态。
 */
function traeCnClaimFailureOutcome(
  result: Extract<CreditsCallResult, { ok: false }>,
): ClaimOutcome {
  // `9095` = 账号未签但**这台设备今天已经签过**（真机判定矩阵，2026-09-23）。
  // 语义上这份奖励今天已经到手，只是账号级的 `checked_in` 还没翻 —— 归一
  // `already-claimed`（界面显示已签、宿主写今日状态），而不是 failed。
  if (result.code === TRAE_CN_CODE_DEVICE_ALREADY_CLAIMED) {
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  // `9074`（换了号仍被拒）：归 `unavailable` —— **不写**今日状态，故宿主 4h 的
  // sweep 下个周期仍会重试（届时凭据里已是那个新号）。
  if (result.code === TRAE_CN_CODE_TOO_MANY_USERS) {
    return {
      kind: 'unavailable',
      code: result.code,
      message: describeFailureCode(result.code, result.message),
      // logid 透传：设备号黑名单的状态客户端看不见，这是定位的唯一线索。
      ...result.logid === undefined ? {} : { logid: result.logid },
    }
  }
  return {
    kind: 'failed',
    code: result.code,
    message: describeFailureCode(result.code, result.message),
    // logid 透传：claim 失败是最需要服务端日志的场景。
    ...result.logid === undefined ? {} : { logid: result.logid },
  }
}

/**
 * 领取已由服务端 `code:0` 确认后的收尾：补查 status 取积分，组装 `claimed`。
 *
 * 抽出来是因为它有**两个调用点**：首发成功、以及 9074 换号重试后成功。两处的
 * 语义必须逐字相同（补查失败不改变 `claimed`、`delayedMessage` 来自服务端原文），
 * 各写一份必然漂移 —— 而漂移的那一份会让「换号成功的领取」少一个积分数字。
 *
 * ⚠️ 补查用的是**换号后的凭据**（调用方传入）：补查虽只读，但设备头要自洽 ——
 * 用旧号补查会让这一次请求带着刚被拉黑的身份，与本次领取的现场不符。
 */
async function finishTraeCnClaim(
  claimResult: CreditsCallResult & { ok: true },
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions,
): Promise<ClaimOutcome> {
  // 补查一次 status 取本次积分（claim 响应里没有积分数，见函数注释）。
  const claimedStatus = await fetchTraeCnCheckinStatus(credential, product, options)
  if (claimedStatus === null) {
    options.onDebug?.(
      '[trae-cn] 领取成功但补查 status 失败，本次积分按 0 计'
      + '（claim 的 code:0 已确认领取成功，故 kind 仍是 claimed）',
    )
  }
  const delayed = readServerMessage(dataLayer(claimResult.body))
  return {
    kind: 'claimed',
    credit: claimedStatus?.dailyCredit ?? 0,
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
