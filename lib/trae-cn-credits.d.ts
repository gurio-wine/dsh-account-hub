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
 * ## 9074 的处置：换一个干净设备号重试，最多三次（用户 2026-09-24 拍板）
 *
 * 既然 9074 是「这个号被拉黑了」，正确动作就是**换号**（而不是退避或等 sweep）：
 * 见 {@link rotateTraeCnCheckinDeviceId}。**次数由
 * {@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 定，当前 3**（2026-09-23 首次拍板为
 * 1，2026-09-24 用户提高上限），且**每次重试用一个全新生成的号** —— 服务端拉黑
 * 的是号，重发同一个新号必然拿到同一个 9074。
 *
 * ⚠️ **它不是「多试几次同样的请求」，而是「多换几个身份」**：这正是它不能并进
 * 退避重试的原因（见下）。
 *
 * ⚠️ **它不走** {@link TRAE_CN_CLAIM_RETRY_CODES}（那张表是「等几秒再问同一个请求」
 * 的软限流退避）：退避再久也不会让一个被拉黑的号变得可用，换号才是对症的动作。
 * 两条路径的**动作**与**节奏**都不同，故刻意分开而不是把 9074 加回那张表。
 *
 * ## claim 段的请求内重试（2026-09-23 收窄）
 *
 * `9074` 已**退出**请求内退避表（见 {@link TRAE_CN_CLAIM_RETRY_CODES}）：它既不是
 * 「等几秒就好」，在旧定性（名额/风控）下重试同一个请求也只是让用户对着转圈多等
 * 4 秒。**它的重试是换号那一组**（见上节）；若换号用尽仍是 9074，才归 `unavailable`
 * outcome —— **不写状态**，故宿主 4 小时的 sweep（`src/account-hub-rpc.ts`）
 * 下一个周期仍会重新尝试（届时凭据里已是**最后一发用的那个新号**，不是被拉黑的旧号）。
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
import { type TraeCnProduct } from './trae-cn-product.js';
import { type TraeCnCredential } from './trae-cn-oauth.js';
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js';
/** 签到状态查询端点（权威状态源）。 */
export declare const TRAE_CN_CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
/** 签到领取端点。 */
export declare const TRAE_CN_CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
/**
 * 积分余额端点。
 *
 * **刻意不用** `ug/activity/info` 的活动口径：实测那个接口写「200 work 积分」
 * 而实际到账 150 通用积分，是**口径陷阱**（见 README「Trae CN provider」）。
 * 余额只能以本端点的资源包明细为准。
 */
export declare const TRAE_CN_USER_ENT_USAGE_PATH = "/trae/api/v2/pay/web_user_ent_usage";
/**
 * 两个签到端点的请求体字段。
 *
 * ⚠️ **T1 已校准**（2026-09-18 真机）：`req_source` 带与不带，服务端返回
 * **逐字节相同**，它不是 `code:9004` 的成因。保留 `req_source: 1` 是因为
 * 它是唯一被实测成功过的组合，且带一个多余字段的成本是零。
 */
export declare const TRAE_CN_CHECKIN_REQ_SOURCE = 1;
/** 设备头中的客户端形态（**伪装**，与运行环境无关，非 Windows 上也照发）。 */
export declare const TRAE_CN_DEVICE_TYPE = "windows";
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
export declare function traeCnOsVersion(): string;
/**
 * `x-os-version` 的模块级快照（派生自 {@link traeCnOsVersion}）。
 *
 * **单一生效者是上面那个函数**；本常量存在只是因为 `src/trae-cn-adapter.ts`
 * 的 chat 头需要一个字符串（它不做函数调用），而 chat 与签到**必须报同一种
 * 设备身份**。`os.version()` 在同一进程内不会变化，模块加载时取一次快照
 * 与每次调用取值等价。
 */
export declare const TRAE_CN_OS_VERSION: string;
/**
 * 设备头中的客户端版本（**签到专用常量**）。
 *
 * 真机客户端已到 `3.3.102`（原值 `3.3.100` 落后两个补丁号）。
 *
 * ⚠️ 与登录协议的 {@link TRAE_CN_IDE_VERSION}（`3.3.100`，`x_app_version` /
 * `DeviceInfo.ClientVersion` / exchange body 的 `IDEVersion`）**是两个号**，
 * 刻意分开：那是登录 URL 与 authCode 交换那条协议线的逐字真机值，本次不动它。
 */
export declare const TRAE_CN_APP_VERSION = "3.3.102";
/** 成功码（签到判定以 body code 为准，不看 HTTP 状态）。 */
export declare const TRAE_CN_CODE_OK = 0;
/**
 * 凭据失效码。
 *
 * 实测：**不带 auth 时服务端不返回 401，而是 HTTP 200 + `code:1001` +
 * `enable:false`** —— 这正是「必须按业务码判」的实证。
 */
export declare const TRAE_CN_CODE_CREDENTIAL_INVALID = 1001;
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
export declare const TRAE_CN_CODE_DEVICE_REJECTED = 9004;
/**
 * 「当前设备今日已经签到」码（`9095`）。
 *
 * 真机判定矩阵（2026-09-23）：**账号级未签 + 设备级已签** → `9095`。
 *
 * 语义是「今天这个设备已经领过一份」—— 账号级的 `checked_in` 仍为 false，
 * 但这份奖励今天确实已经到手，故归一 `already-claimed`（界面显示已签、
 * 宿主写今日状态），**不是**失败、也**不重试**（确定性结果）。
 */
export declare const TRAE_CN_CODE_DEVICE_ALREADY_CLAIMED = 9095;
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
 * 处置：**换号重试（最多 {@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 次，每次全新号）**；
 * 用尽仍是 9074 则归 `unavailable` —— **不写**签到状态（下次 sweep 重试，届时用的是
 * 已落盘的**最后一发**新号）、不标已签。用户文案见 {@link describeFailureCode}。
 */
export declare const TRAE_CN_CODE_TOO_MANY_USERS = 9074;
/**
 * claim 段可重试的业务码（**`TRAE_CN_BACKOFF_CODES` 的真子集**）。
 *
 * ⚠️ **`9074` 已于 2026-09-23 移出本表**（原为 `[9074, 4007, 3004]`）：它既不是
 * 「等几秒就好」（第五次定性：设备号被拉黑，等多久都不会变），也不是靠退避能
 * 解决的事 —— **它的重试是换设备号那一组**（最多
 * {@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 次、每次全新号，见
 * {@link claimTraeCnWithDeviceRotation}）。若换号用尽仍是 9074，才归
 * `unavailable`、不写状态，由宿主 4 小时的 sweep 下个周期再试。
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
export declare const TRAE_CN_CLAIM_RETRY_CODES: readonly number[];
/**
 * 重试前的等待时长（指数退避，**共 2 次重试**：1s → 3s，累计 4s）。
 *
 * 只服务 {@link TRAE_CN_CLAIM_RETRY_CODES} 里那两个瞬时软限流码。上界刻意压得很
 * 小：真正的瞬时抖动在几秒内就会过去，长时间重试只会让用户对着转圈等。
 */
export declare const TRAE_CN_CLAIM_RETRY_DELAYS_MS: readonly number[];
/**
 * 该业务码是否应触发 claim 段的退避重试。
 *
 * 两道判据缺一不可：本地清单（签到语境的相关码）+ 共享退避表（上游对
 * 「可重试」的权威定义）。`9004`（设备头）、`1001`（凭据失效）与 `9095`
 * （设备今日已签）**都**不在任何一张表里 —— 它们是确定性结果，重试只会把同一个
 * 结果问三遍。`9074` 在共享表里但**不在**本地清单里（见
 * {@link TRAE_CN_CLAIM_RETRY_CODES}），故本函数对它返回 false。
 */
export declare function isTraeCnClaimRetryable(code: number | undefined): boolean;
/**
 * 9074 换号重试的**次数上限**（硬编码，不做配置项）。
 *
 * 一个刚生成的全新 16 位号**不该**再被拉黑（真机矩阵：全新号首次 claim 即
 * `code:0`）。若换了号仍是 9074，说明这次拒绝另有原因，继续摇随机号没有依据 ——
 * 故不设可配置项、不写循环：改这个数字就等于改「换几次号」这条策略本身，
 * 应当是一次显式改动而不是一个旋钮。
 *
 * ## ⚠️ 2026-09-24 由 1 提升到 3（用户拍板）
 *
 * 用户规则原文：「每个账号单独一个设备id，签到成功就存起来先不变，防止被风控；
 * 出现『人太多』这种限制（9074 类）再生成一个新的设备号重新签到，**最多重试三次**」。
 *
 * 提升的实际含义：首发 9074 之后，最多再发 **3** 次 claim，每次带一个**全新生成**
 * 的号（不是同一个新号重发三遍 —— 服务端拉黑的是**号**，重发同一个号必然同结果）。
 * 故单次签到的 claim 请求上界是 `1 + 本常量`。
 *
 * ⚠️ **不要把它读成「4 次机会」而顺手加退避**：这三次是**立刻**连发（换身份而不是
 * 等窗口），与 `TRAE_CN_CLAIM_RETRY_DELAYS_MS` 那条「等几秒再问同一个请求」的
 * 退避路径**刻意分开**（见 `claimTraeCnWithDeviceRotation` 的边界 2）。
 */
export declare const TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT = 3;
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
export declare function rotateTraeCnCheckinDeviceId(credential: TraeCnCredential): TraeCnCredential;
/**
 * 通用积分池（`available_endpoint === 0`）—— **Trae CN（IDE 对话）实际扣的就是它**。
 *
 * 与 {@link TRAE_CN_POOL_WORK} 的关系见 {@link fetchTraeCnCreditBalance} 的
 * 「按 provider 分池」一节：两个池**互不通用**，各自只有一条路径能花。
 */
export declare const TRAE_CN_POOL_UNIVERSAL = 0;
/**
 * Work 积分池（`available_endpoint === 1`）—— **只在 TraeWork 里能花**
 * （`work.trae.cn` 网页版 / 桌面版）。
 *
 * ⚠️ 官方已把 TraeWork 通道并入通用通道，**本插件不再有任何路径走这个池**。
 * 常量保留是因为 `available_endpoint` 这个上游字段仍然分池、礼包仍按它归类
 * （见 {@link parseTraeCnPackage} 与 {@link fetchTraeCnCreditBalance}）。
 */
export declare const TRAE_CN_POOL_WORK = 1;
/** 本模块三个函数共用的请求选项。 */
export interface TraeCnCreditsOptions {
    /** 注入的 fetch（测试用）；默认全局 fetch。 */
    fetcher?: typeof fetch;
    /**
     * 脱敏调试出口（**只输出字段名与结构判定，不输出值**）。
     *
     * 用途是在真机校准时一次性看清「礼包数组在哪、余额字段叫什么、领取积分字段
     * 叫什么」。生产接线把它接到 `ctx.logger.info`（见 `src/account-hub-rpc.ts` 的
     * 三处分发）；它**不**回传客户端，故校准看宿主日志。
     */
    onDebug?: (message: string) => void;
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
    persistCredential?: (credential: TraeCnCredential) => void | Promise<void>;
}
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
export declare function traeCnCreditsHeaders(credential: TraeCnCredential, product: TraeCnProduct): Record<string, string>;
/** 签到状态的两个**实测确认**字段。 */
export interface TraeCnCheckinState {
    /**
     * 账号级「今天是否已签到」——**幂等判据**。
     *
     * 刻意不用 `did_checked_in`：那是**设备级**语义（换设备后仍为 false），
     * 拿它判幂等会对已领取的账号重复发领取请求。
     */
    checkedIn: boolean;
    /**
     * 服务端是否开启签到。
     *
     * `undefined` 表示响应里没有该字段 —— 与显式 `false` **严格区分**：
     * 只有服务端明确说关，才判「签到未开启」。
     */
    enabled: boolean | undefined;
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
export declare function fetchTraeCnCheckinStatus(credential: TraeCnCredential, product: TraeCnProduct, options?: TraeCnCreditsOptions): Promise<CheckinStatus | null>;
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
 *    - `9074`（**设备号被拉黑**）→ 换一个全新 16 位号**重试**，最多
 *      {@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 次（每次都是全新号），结果
 *      **按最后一次尝试自己的码**再走一遍本分流（成功 → `claimed`；仍 9074 →
 *      `unavailable`）；
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
 * 在处理上也不是退避 —— **它的重试是换设备号那一组**（见
 * {@link claimTraeCnWithDeviceRotation}，最多
 * {@link TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT} 次、每次全新号）。若换号用尽仍是
 * 9074，才归 `unavailable`、不写状态，故宿主 4 小时的 sweep 下个周期仍会被重新
 * 尝试（届时凭据里已是**最后一发用的那个新号**，不是被拉黑的旧号）。
 *
 * ⚠️ 第 5 步的补查**不重试**：它是读接口，且它的失败不会改变 outcome 的 kind，
 * 重试只会拖长一次已经成功的领取。它的 `onDebug` 出口与上面共用。
 *
 * 幂等是**服务端**保证的（`checked_in`），本模块只在客户端做一次预检以省掉
 * 无效请求 —— 即便预检与实际状态竞态，重复领取也只会得到服务端的幂等响应。
 * 重试因此也是安全的：服务端不会因为同一账号连发三次 claim 就发三份奖励。
 */
export declare function claimTraeCnDailyCheckin(credential: TraeCnCredential, product: TraeCnProduct, options?: TraeCnCreditsOptions): Promise<ClaimOutcome>;
/**
 * 礼包数组所在的候选键（**T7 已按真机校准**，2026-09-18）。
 *
 * 真机 `web_user_ent_usage` 的礼包数组位于**根层**、键名
 * `user_entitlement_pack_list` —— 故它排在首位。其余候选键与「按
 * `available_endpoint` 指纹扫描」兜底一并保留：`require_usage:true` 下响应里
 * 同时有「用量」数组与「礼包」数组，只按名字猜容易猜错，只按扫描又可能命中
 * 用量数组。名字优先 + 分池指纹兜底是最稳的组合。
 */
export declare const TRAE_CN_BALANCE_ARRAY_KEYS: readonly string[];
/** 礼包「剩余额度」的候选字段（按优先级）。 */
export declare const TRAE_CN_BALANCE_REMAIN_FIELDS: readonly string[];
/** 礼包「总额度」的候选字段（按优先级）。 */
export declare const TRAE_CN_BALANCE_TOTAL_FIELDS: readonly string[];
/** 礼包「已用额度」的候选字段（按优先级）。 */
export declare const TRAE_CN_BALANCE_USED_FIELDS: readonly string[];
/**
 * 积分池的**标识**（`available_endpoint` 的取值）。
 *
 * 它只用来选池，**不再有展示名** —— 分池之后每个面板只显示自己那一个池，
 * 界面上不会出现「通用」「Work」这类字样，池名在此没有任何消费者。
 * 池的**可用范围**语义见 {@link TraeCnCreditBalance}。
 */
export type TraeCnPoolId = typeof TRAE_CN_POOL_UNIVERSAL | typeof TRAE_CN_POOL_WORK;
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
export type TraeCnCreditBalance = CreditBalance;
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
export declare function fetchTraeCnCreditBalance(credential: TraeCnCredential, product: TraeCnProduct, pool: TraeCnPoolId, options?: TraeCnCreditsOptions): Promise<TraeCnCreditBalance | null>;
//# sourceMappingURL=trae-cn-credits.d.ts.map