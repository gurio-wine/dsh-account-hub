/**
 * Trae CN（字节跳动 Trae 国内版）登录与凭据。
 *
 * ## 协议（**已用真机证据架构级重写**，2026-09-17）
 *
 * | 项 | LobsterAI | 腾讯系 | **Trae CN** |
 * |---|---|---|---|
 * | 登录 | 本地回调收 `code` → exchange | external-link 轮询 | **本地回调 + PKCE(S256)**，回调投递 `authCodeInfo` |
 * | 换 token | `authCode` → access+refresh | 轮询结果自带 | **`POST /trae/api/v3/oauth/ExchangeToken`**（body 五字段） |
 * | 续期 | `POST /api/auth/refresh` | `X-Refresh-Token` 头 | **`POST /cloudide/api/v3/trae/oauth/ExchangeToken`**（body 四字段） |
 * | 鉴权头 | `Bearer` | `Bearer` + 归属头 | **`Cloud-IDE-JWT`**（另带两个等值 token 头） |
 *
 * ### 旧假设为何被整体推翻
 *
 * 本模块曾按「回调 query 直接携带 refreshToken、无 authCode 交换」实现。真机
 * 2026-09-17 的成功登录日志（`%APPDATA%\Trae CN\logs\20260917T045023\main.log`）
 * 与官方 `main.js` 源码（`loginUrlBuilder.buildLoginUrl` / `gDe` /
 * `exchangeTokenByAuthCode`）共同证明：真机走的是
 * **PKCE → `authCodeInfo.AuthCode` → `trae/api/v3/oauth/ExchangeToken`**。
 *
 * 「直取 refreshToken」并非凭空：它是**同一授权页在另一组参数下的分支**
 * （URL 不带 `code_challenge` 时，页面靠浏览器里的 trae.cn Cookie 会话自己调
 * `GetRefreshToken`，再把 refreshToken 投回回调）。两条分支并存，本实现
 * **以 PKCE 为主路径**（与桌面客户端同款、不依赖「浏览器里已登录 trae.cn」这个
 * 额外前置），并**保留 refreshToken 分支**作为兼容与诊断。
 *
 * 回退到 refreshToken 分支时，凭据缺少 exchange 响应里的 `BoundDeviceID`，
 * 故 `device_id` 只能留空 —— 这是**如实留空**，不是伪造一个看起来合法的设备号。
 *
 * ### 三个曾经写错的点（各自都能单独导致登录静默失败）
 *
 * 1. `client_id`（**snake_case**）而非 `clientID` —— 授权页只读前者，读不到
 *    就停在「认证中」，既不报错也不回调；
 * 2. 缺 `auth_type=local` / `login_channel=native_ide` / `login_version=1`
 *    等流程标记 —— 授权页认不出本地回调模式；
 * 3. 缺 PKCE 参数（`code_challenge` / `code_challenge_method=S256`）——
 *    授权页就不会走 AuthCode 分支。
 *
 * ## 模块边界
 *
 * 本模块只做**登录 + 凭据 + 续期请求**，不含：LLM 适配器、签到、积分余额。
 *
 * ## ⚠️ T9 的第三次修正（2026-09-20）：形态不校验 ≠ 设备被认可
 *
 * T9（2026-09-18）的原始结论是「status / claim **都不校验设备号形态**」——
 * 16 位十进制号 / `BoundDeviceID` / 空串返回**逐字节相同**。该观测本身仍然成立，
 * 但**推论是错的**：不校验形态 ≠ 不校验设备。服务端按 `x-device-id` 做**设备维度
 * 记账**，认不认这台设备是真校验。
 *
 * 单变量隔离证据（status 端点 A/B，2026-09-20）：我们全套头 + **仅**把
 * `x-device-id` 换成官方客户端那个 16 位号 → `did_checked_in` 由 `false` 翻转为
 * `true`；其余头差异（多发的 `Accept` / `Origin` / `Referer` / `X-Ide-Token` /
 * `X-Cloudide-Token`）已证明不影响结果。这正是签到 `9074` 的真根因（见
 * `src/trae-cn-credits.ts` 的 `9074` 小节）。
 *
 * 结论落到本模块：**登录时生成的那个 16 位号必须持久化进凭据**，供签到侧使用
 * —— 它才是「我们注册的这台设备」，见 {@link TraeCnCredential.checkin_device_id}。
 *
 * ⚠️ **本模块的「设备号」仍是两个位置**（2026-09-19 澄清，本次修正后依然成立）：
 *
 * | 位置 | 取值 | 用途 |
 * |---|---|---|
 * | **登录 URL 的 `device_id`**（{@link generateTraeCnDeviceId}） | 现场生成的 16 位十进制 | 登录握手形态要求 **且** 设备身份（现已落盘） |
 * | **exchange 返回的 `BoundDeviceID`**（`TraeCnCredential.device_id`） | 14 位字母数字（如 `wl2k1e2endpp32`） | 服务端的绑定标识；**活动系统不认它** |
 *
 * `README.md` 里讲 16 位形态的是**前者**；后者只是服务端在登录链路里发给我们的
 * 绑定号，不是设备身份。
 */

import { createServer, type Server } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { jwtExpiresAtMs } from './buddy.js'
import {
  TRAE_CN_APP_TYPE,
  TRAE_CN_AUTH_EXCHANGE_PATH,
  TRAE_CN_AUTHORIZATION_PATH,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CHANNEL_NAME,
  TRAE_CN_DEVICE_TYPE_PC,
  TRAE_CN_EXCHANGE_TOKEN_PATH,
  TRAE_CN_IDE_VERSION,
  TRAE_CN_LOGIN_AUTH_FROM,
  TRAE_CN_LOGIN_AUTH_TYPE,
  TRAE_CN_LOGIN_CHANNEL,
  TRAE_CN_LOGIN_OS_INFO,
  TRAE_CN_LOGIN_OS_VERSION,
  TRAE_CN_LOGIN_REDIRECT,
  TRAE_CN_LOGIN_REDIRECT_CALLBACK,
  TRAE_CN_LOGIN_TIMEOUT_MS,
  TRAE_CN_LOGIN_VERSION,
  TRAE_CN_PLATFORM_CODE,
  TRAE_CN_PLUGIN_VERSION,
  TRAE_CN_REQUEST_TIMEOUT_MS,
  type TraeCnDeviceIdSource,
  type TraeCnProduct,
} from './trae-cn-product.js'

/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

// ── 回调参数名（**真机逐字确认**，不再是候选表） ──

/**
 * 回调 query 中承载 **authCode 信封**（`authCodeInfo`）的参数名。
 *
 * 真机 main.log:139 逐字：`authCodeInfo` 的值是一个 **JSON 字符串**，形如
 * `{"AuthCode":"…","ExpireAt":1789592492958,"ExpireDuration":600000}`——
 * 即**双重编码**（URL query 里再套一层 JSON）。这是 PKCE 分支的载荷。
 */
export const TRAE_CN_AUTH_CODE_INFO_PARAM = 'authCodeInfo'
/**
 * 回调 query 中承载 **用户信息**（`userInfo`）的参数名。
 *
 * 真机 main.log:139 逐字：同样是 JSON 字符串，含 `UserID` / `ScreenName` /
 * `Region` / `TenantID` 等 15 个键。`UserID` 是后续 `GetUserInfo` 与
 * 账号展示的来源（真机 `1435281906741923`）。
 */
export const TRAE_CN_USER_INFO_PARAM = 'userInfo'
/**
 * 兼容分支：回调 query 中直接承载 **refreshToken** 的参数名。
 *
 * 这是**不带 PKCE 时授权页的另一条分支**的产物（页面自己调 `GetRefreshToken`）。
 * 本实现以 PKCE 为主路径，故它只在「授权页没走 PKCE」时命中；命中时凭据缺
 * `BoundDeviceID`，`device_id` 留空并在 `device_id_source` 标记 `refreshToken-only`。
 */
export const TRAE_CN_REFRESH_TOKEN_PARAM = 'refreshToken'
/**
 * 回调 query 中承载 **登录追踪号** 的参数名。
 *
 * 真机 main.log:139 的 `loginTraceID` 与登录 URL 的 `login_trace_id` 同值
 * （`5bc786d0-…`）—— 这正是「本次回调属于本次登录」的服务端凭证，
 * 也是我们做防 CSRF 校验的锚点（见 {@link completeTraeCnCallback}）。
 */
export const TRAE_CN_LOGIN_TRACE_ID_PARAM = 'loginTraceID'
/**
 * 回调 query 中承载 **来源作用域** 的参数名（真机值 `trae`）。
 *
 * 不参与判定，但**登记在脱敏白名单**里：它是判断「回调来自哪个产品形态」
 * 的现成证据，且非机密。
 */
export const TRAE_CN_SCOPE_PARAM = 'scope'

// ── PKCE ──

/** 一次 PKCE 生成的产物。 */
export interface TraeCnPkce {
  /** `code_verifier`：48 字节随机数的 base64url（64 字符）。 */
  codeVerifier: string
  /** `code_challenge`：`sha256(codeVerifier)` 的 base64url（43 字符）。 */
  codeChallenge: string
  /** 挑战方法，恒为 `S256`。 */
  codeChallengeMethod: string
}

/**
 * 生成 PKCE 参数（对齐官方 `main.js` 的 `gDe()`，@1426128）。
 *
 * 官方实现逐字：
 * `randomBytes(48).toString("base64url")` → verifier；
 * `createHash("sha256").update(verifier).digest("base64url")` → challenge。
 *
 * ⚠️ 方法名是 **`S256`**，不是 CodeArts 那套 `SHA-256`：授权页按字面量比较，
 * 写成 `SHA-256` 会让它判定为「不支持的挑战方法」而不走 AuthCode 分支。
 */
export function generateTraeCnPkce(): TraeCnPkce {
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' }
}

/**
 * 生成设备公钥（对齐官方 `main.js` 的 `vDe()`）。
 *
 * 官方实现逐字：`generateKeyPairSync("ec",{namedCurve:"P-256",publicKeyEncoding:
 * {type:"spki",format:"pem"},…})`，每次登录生成新对，SPKI PEM 填入
 * `DeviceInfo.DevicePublicKey`。实测留空串时 exchange 回 400「无效参数」。
 */
export function generateTraeCnDevicePublicKey(): string {
  const { publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return publicKey
}

// ── 设备标识生成（**形态即风控**） ──

/** 生成 64 位小写十六进制 `machine_id`（32 字节）。 */
export function generateTraeCnMachineId(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 生成 16 位纯十进制 `device_id`（**登录 URL 专用，且是设备身份**）。
 *
 * 真机值形如 `2996599860772203`（16 位十进制）。**不能用 hex32 或 UUID**：
 * 这是**登录握手**的参数形态要求 —— 授权页与 authCode 交换按这个形态校验。
 *
 * ## ⚠️ 「设备号」在本项目里有**两个位置**，边界不要混（2026-09-20 修正）
 *
 * | 位置 | 取值 | 形态/语义 |
 * |---|---|---|
 * | **登录 URL 的 `device_id`**（本函数） | 现场生成的 16 位十进制号 | **必须** 16 位纯十进制；**且它是签到认的设备身份** |
 * | **exchange 返回的 `BoundDeviceID`**（`TraeCnCredential.device_id`） | 14 位字母数字 | 服务端绑定标识，**活动系统不认** |
 *
 * 早先这条注释把「形态不符」的后果记成「会触发 9074 风控」，**归因是错的**：
 * `9074` 的成因与设备号**形态**无关，而与**设备是否被活动系统认可**有关。
 * 2026-09-20 单变量 A/B 已定案：仅把 `x-device-id` 换成官方 16 位号即让
 * `did_checked_in` 由 false 翻转为 true（见模块头注释）。保留 16 位形态的理由
 * 因此**不止**登录握手 —— 它同时是设备身份本身的形态。
 *
 * ⚠️ **本函数是随机的、且每次登录都不同**（8 字节随机数取低 16 位十进制）。
 * 服务端没有把「我们上报的号」回传（exchange 响应只有它自己新发的
 * `BoundDeviceID`），故**它只能在生成时被保存**：见
 * {@link TraeCnCredential.checkin_device_id}。旧凭据无法恢复该值，走
 * {@link traeCnCheckinDeviceId} 的如实降级路径。
 */
export function generateTraeCnDeviceId(): string {
  // 8 字节 → 最大约 1.8e19（20 位十进制），取其**低 16 位十进制**。
  // 「十进制串的末 16 位」等价于数值 mod 10^16，即每个 16 位串等概率，
  // 不会像「先取 6 字节」那样让首位恒为 0 附近的值过度出现。
  const decimal = BigInt(`0x${randomBytes(8).toString('hex')}`).toString(10)
  // 长度不足 16 是纯防御（8 字节几乎必然 ≥19 位），保留以免将来改字节数时静默变短。
  return decimal.slice(-16).padStart(16, '0')
}

/** 生成登录追踪号（UUID v4 形态，真机逐字样本同形）。 */
export function generateTraeCnLoginTraceId(): string {
  return randomUUID()
}

// ── 凭据数据结构 ──

/**
 * 持久化的 Trae CN 凭据（**五件套整体配对存储**）。
 *
 * 字段名与 `BuddyCredential` / `LobsteraiCredential` 保持同一套 `snake_case`
 * 约定 —— `AccountPool.findAccountIdByCredential`（`src/account-pool.ts`）
 * 对非 codearts 的 provider 统一取 **`access_token`** 作身份标识，
 * 命名一致才能直接复用该函数。与协议字段（`RefreshToken` / `UserID` /
 * `ClientID`）的对应关系见各字段说明。
 *
 * **五件套** = `refresh_token` + `user_id` + `client_id` + `device_id` + `machine_id`。
 * 它们必须**按账号整体配对**：任何一个丢失/串号都会让续期或签到用到别的身份的字段。
 */
export interface TraeCnCredential {
  /**
   * 访问令牌（JWT）。
   *
   * 用法：`Authorization: Cloud-IDE-JWT <access_token>`，另带
   * `X-Ide-Token` 与 `X-Cloudide-Token` 两个同值头（见
   * {@link traeCnAccessHeaders}）。
   */
  access_token: string
  /** 刷新令牌（五件套之一；续期端点的 `RefreshToken`）。 */
  refresh_token: string
  /** 用户 ID（五件套之一；续期端点的 `UserID`）。来源：回调 `userInfo.UserID`。 */
  user_id: string
  /** OAuth 客户端 ID（五件套之一；与产品配置的 `clientId` 同值，随凭据快照留档）。 */
  client_id: string
  /**
   * 设备号（五件套之一）——**服务端的绑定标识**。
   *
   * ## 来源（**已用真机校准**，2026-09-17）
   *
   * 取自登录 exchange 响应的 `Result.BoundDeviceID`（真机 `wl2k1e2endpp32`，
   * 14 位小写字母+数字）—— 服务端**新发**的绑定标识，配套
   * `Result.DeviceBindStatus: "BOUND"`；它**不是**客户端上报的 `DeviceID`
   * （16 位十进制）或 `MachineID`（64 hex）的回显。
   *
   * ## ⚠️ 它**不是**签到用的设备号（2026-09-20 定案）
   *
   * 本字段曾被用作 claim 的 `x-device-id`，理由是 T9 的「服务端不校验设备号
   * 形态」。**该推论已被单变量 A/B 推翻**：不校验**形态** ≠ 不校验**设备** ——
   * 服务端按 `x-device-id` 做设备维度记账，`BoundDeviceID` 不被活动系统认可
   * （仅把它换成官方 16 位号即让 `did_checked_in` 由 false 翻转为 true）。
   *
   * 故签到头现在用 {@link checkin_device_id}（我们注册的 16 位设备号），
   * 本字段只保留它在登录链路里的本义（服务端绑定标识 / 诊断 / 五件套完整性）。
   *
   * 走到兼容分支（回调给 refreshToken、无 exchange 响应）时本字段为**空串** ——
   * 如实留空，不伪造。
   */
  device_id: string
  /**
   * **签到用的设备号**：登录时生成、并原样上报给服务端的那个 16 位纯十进制号。
   *
   * ## 为什么必须有这个独立字段（2026-09-20，9074 真根因修复）
   *
   * 服务端按 `x-device-id` 做**设备维度**记账，且只认**登录时注册的那台设备**。
   * 官方客户端的登录 URL `device_id` 与 claim 的 `x-device-id` 是**同一个稳定
   * AHA 号**；本插件此前两者不同源 —— 登录用现场随机号（用完即丢），claim 却发
   * exchange 返回的 `BoundDeviceID`（{@link device_id}），构成「与登录不匹配且
   * 每次登录都漂移的设备身份」。
   *
   * 单变量证据：全套头不变、**仅**把 `x-device-id` 换成官方 16 位号 →
   * status 的 `did_checked_in` 由 `false` 翻转为 `true`。
   *
   * ## 值域与降级（**不伪造**）
   *
   * - 主路径（PKCE + authCode 交换）：= 本次登录 URL 里的 `device_id`
   *   （{@link generateTraeCnDeviceId} 现场生成，16 位纯十进制）；
   * - 兼容分支（回调给 refreshToken）：登录 URL 里也有那个随机号，同样落盘 ——
   *   该分支能拿到它，只是拿不到 `BoundDeviceID`；
   * - **旧凭据（本字段引入前登录的）**：该号从未被保存、且生成器是**随机**的
   *   （非机器特征派生），服务端也不回传，**无法恢复**。此时本字段为 `''`，
   *   签到侧按 {@link traeCnCheckinDeviceId} 如实降级 —— 详见该函数的取舍说明。
   *
   * ⚠️ **不拿 `machine_id` 折算一个假的 16 位号顶上**：那正是 README 禁止的
   * 「伪造设备身份」。缺字段可以被发现，伪造的号只会让问题更难查。
   */
  checkin_device_id: string
  /** 机器号（五件套之一，64 位小写十六进制）；登录 URL 的 `machine_id` 用之。 */
  machine_id: string
  /** `device_id` 的来源标记（诊断用）。 */
  device_id_source: TraeCnDeviceIdSource
  /**
   * 过期时间（**毫秒时间戳字符串**）。
   *
   * 两级来源，取值口径一致：
   * 1. exchange 响应的 `Result.TokenExpireAt`（**权威**，真机为 13 位 epoch ms）；
   * 2. 缺失时由 {@link jwtExpiresAtMs} 从 access token 的 JWT `exp` 派生。
   */
  expires_at?: string
  /** 昵称（UI 展示；回调 `userInfo.ScreenName` 或 JWT 提供时才写）。 */
  nickname?: string
}

/** 凭据是否携带可静默续期的 `refresh_token`。 */
export function isTraeCnRefreshable(credential: TraeCnCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * 取签到该用的 `x-device-id`（**9074 真根因修复的落点**，2026-09-20）。
 *
 * ## 取值与降级链
 *
 * | 优先级 | 来源 | 何时命中 |
 * |---|---|---|
 * | 1 | {@link TraeCnCredential.checkin_device_id} | 本字段引入后登录的凭据（主路径 + 兼容分支都能拿到） |
 * | 2 | {@link TraeCnCredential.device_id}（`BoundDeviceID`） | **旧凭据**（本字段缺失） |
 *
 * ## 为什么降级到 `BoundDeviceID` 而不是留空
 *
 * 两条都**不是**活动系统认可的设备号，但 `BoundDeviceID` 至少是**服务端自己发的**
 * 一个稳定绑定标识：它保证「同一账号每次签到发同一个值」（幂等语义不被我们自己
 * 打破），且失败时错误码/文案能指向确定的原因。
 *
 * 而**不伪造**是本项目的硬约束（`README.md` 明令禁止伪造设备身份）：不能拿
 * `machine_id` 折算一个看起来合法的 16 位号，也不能读 Trae 客户端 `storage.json`
 * 的 AHA 号（跨产品耦合，需用户拍板）。
 *
 * ## ⚠️ 旧凭据必须重新登录才能修复签到
 *
 * `checkin_device_id` 是**登录时现场随机生成**的 16 位号（见
 * {@link generateTraeCnDeviceId}），服务端**不回传**它，exchange 响应里只有它自己
 * 新发的 `BoundDeviceID`。故本字段引入前登录的凭据**无法恢复**该值 —— 这是如实
 * 的信息缺失，不是可以绕过的实现细节。这类凭据的签到会继续按 `BoundDeviceID`
 * 发（大概率仍不通过活动系统的设备认可），**重新登录一次即可修复**。
 *
 * @param credential - 已解析的凭据（可能来自旧版本，字段缺失时为 `undefined`）。
 * @returns 非空的设备号字符串；两者都缺失时返回 `''`（如实留空）。
 */
export function traeCnCheckinDeviceId(credential: TraeCnCredential): string {
  // 旧凭据（本字段引入前落盘）在 JSON 里根本没有这个键：类型说是 string，
  // 运行时是 undefined。故按「非空字符串」判，而不是按 `!== undefined`。
  const stored = credential.checkin_device_id
  if (typeof stored === 'string' && stored.length > 0) return stored
  return typeof credential.device_id === 'string' ? credential.device_id : ''
}

/**
 * 从凭据解析过期的毫秒时间戳。
 *
 * 优先用存储的 `expires_at`，缺失时**回退解析 access token 的 JWT `exp`** ——
 * 两个口径都是「服务端说了算」：前者来自 `TokenExpireAt`，后者是 token 自述。
 */
export function traeCnCredentialExpiresAtMs(credential: TraeCnCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与另外两条协议线一致）。 */
export function isTraeCnExpired(credential: TraeCnCredential): boolean {
  const expiresAt = traeCnCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/**
 * 解析存储值里的凭据 JSON；解析失败或结构不合法返回 undefined。
 *
 * 判据只有一条：`access_token` 必须是字符串（账号池反查身份标识要用它）。
 * 其余字段允许缺失 —— 老凭据、或兼容分支（refreshToken-only）的凭据都不该因此
 * 判为损坏。
 */
export function parseTraeCnCredential(value: string): TraeCnCredential | undefined {
  try {
    const parsed = JSON.parse(value) as TraeCnCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 序列化凭据（存入 `ctx.credentials` 的形态）。 */
export function serializeTraeCnCredential(credential: TraeCnCredential): string {
  return JSON.stringify(credential)
}

// ── 请求头 ──

/**
 * 构造带 Trae 鉴权的请求头。
 *
 * **三个头都带**：网关接受等价鉴权（三选一即可），但三个同值一起发是
 * 实测量最稳的形态 —— 不同的 Trae 服务端组件读不同的头。
 *
 * 刻意**不带**腾讯系的 `X-Domain` / `X-Product*` 归属头，也不带
 * LobsterAI 的 `X-LobsterAI-Client-*`：那些头对本服务无意义，
 * 带上会让服务端按错误的客户端形态归因。
 */
export function traeCnAccessHeaders(
  credential: TraeCnCredential,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Ide-Token': credential.access_token,
    'X-Cloudide-Token': credential.access_token,
    Accept: accept,
    'Content-Type': 'application/json',
  }
}

/**
 * 构造两个 `ExchangeToken` 端点的无鉴权请求头。
 *
 * 登录的 authCode 交换与续期都**还没有**可用的 access token：服务端只认请求体
 * （`AuthCode`+`CodeVerifier`，或 `RefreshToken`+`UserID`），故不发 `Authorization`。
 *
 * ⚠️ 调研未给出该端点的 `User-Agent` 约定，故**刻意不发明一个值**。
 * 若真机验证发现网关按 UA 拦截，再补一个实测值并在此注明来源。
 */
export function traeCnAnonymousHeaders(): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/json' }
}

// ── 通用 JSON 读取工具 ──

/** 从若干候选键里取第一个非空字符串值。 */
function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** 取出可能承载业务载荷的嵌套对象（响应可能套 `Result` / `Data` 等信封）。 */
function readEnvelopeObjects(body: Record<string, unknown>): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [body]
  for (const key of ['Result', 'result', 'Data', 'data']) {
    const value = body[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      layers.push(value as Record<string, unknown>)
    }
  }
  return layers
}

/**
 * 判定响应是否为业务失败。
 *
 * Trae 的接口风格是 `{Code/Code: 0, Message: "..."}` 信封（大小写两种写法都
 * 出现过）。**没有 code 字段也算成功** —— 有些组件直接返回裸载荷，
 * 按「必须显式 code:0」判会把成功当失败。
 */
function readEnvelopeError(body: Record<string, unknown>): string | undefined {
  for (const key of ['Code', 'code', 'ErrCode', 'errCode']) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      const message = readFirstString(body, ['Message', 'message', 'Msg', 'msg', 'ErrMsg', 'errMsg'])
      return message.length > 0 ? message : `code=${value}`
    }
    if (typeof value === 'string' && value.length > 0 && value !== '0') {
      const message = readFirstString(body, ['Message', 'message', 'Msg', 'msg', 'ErrMsg', 'errMsg'])
      return message.length > 0 ? message : `code=${value}`
    }
  }
  // 顶层 Error/error 字段（部分网关直接返回它）。
  const error = body.Error ?? body.error
  if (typeof error === 'string' && error.length > 0) return error
  return undefined
}

/** 诊断用：响应里出现过的顶层键名（不涉值，可安全入日志）。 */
function describeTopLevelKeys(body: unknown): string {
  if (typeof body !== 'object' || body === null) return typeof body
  return Object.keys(body as Record<string, unknown>).join(',') || '(空对象)'
}

// ── 续期：RefreshToken → access token（`cloudide/api/…`，与登录交换不同端点） ──

/** 续期端点响应解析出的载荷。 */
export interface TraeCnTokenPayload {
  /** 新的 access token（JWT）。 */
  accessToken: string
  /** 新的 refresh token；响应未返回时为空串（沿用旧的）。 */
  refreshToken: string
  /** 响应里带的用户 ID（没有则为空串）。 */
  userId: string
  /** 响应里带的设备号（没有则为空串）。 */
  deviceId: string
  /** 昵称（没有则为空串）。 */
  nickname: string
}

/**
 * 解析续期响应。
 *
 * 候选键**大小写/命名两种风格都收**（`Token` / `AccessToken` / `access_token`…）：
 * 续期端点的响应 schema 未经真机逐字确认（登录端点的已确认，见
 * {@link parseTraeCnAuthExchangeResult}）。与其猜一个，不如按候选表取，
 * 并让 {@link exchangeTraeCnToken} 在**全都没命中**时抛出带上原始键名的错误
 * —— 那样一次真机调用就能把候选表收敛，而不是留下一个「续期永远失败但原因不明」
 * 的哑谜。
 */
export function parseTraeCnTokenPayload(body: unknown): TraeCnTokenPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  if (readEnvelopeError(root) !== undefined) return undefined
  for (const layer of readEnvelopeObjects(root)) {
    const accessToken = readFirstString(layer, [
      'Token', 'token', 'AccessToken', 'access_token', 'accessToken',
    ])
    if (accessToken.length === 0) continue
    const user = typeof layer.User === 'object' && layer.User !== null
      ? layer.User as Record<string, unknown>
      : (typeof layer.user === 'object' && layer.user !== null ? layer.user as Record<string, unknown> : {})
    return {
      accessToken,
      refreshToken: readFirstString(layer, ['RefreshToken', 'refresh_token', 'refreshToken']),
      userId: readFirstString(layer, ['UserID', 'UserId', 'userId', 'user_id', 'uid'])
        || readFirstString(user, ['ID', 'Id', 'id', 'userId', 'user_id']),
      deviceId: readFirstString(layer, ['DeviceID', 'DeviceId', 'deviceId', 'device_id'])
        || readFirstString(user, ['DeviceID', 'DeviceId', 'deviceId', 'device_id']),
      nickname: readFirstString(layer, ['Nickname', 'nickname', 'Name', 'name', 'UserName', 'userName'])
        || readFirstString(user, ['Nickname', 'nickname', 'Name', 'name']),
    }
  }
  return undefined
}

/**
 * 用 `RefreshToken` 换新的 access token（**续期**）。
 *
 * 请求体四字段（实测形态）：
 * `{ClientID, ClientSecret, RefreshToken, UserID}`。
 * `ClientSecret` 实测为占位串 `"-"`，服务端不校验（见产品配置）。
 *
 * ⚠️ 端点 `cloudide/api/v3/trae/oauth/ExchangeToken`，**不是**登录用的
 * `trae/api/v3/oauth/ExchangeToken`（见 {@link exchangeTraeCnAuthCode}）。
 * 两者在服务端并存，混用必 404。
 *
 * @throws 网络失败、HTTP 非 2xx、业务码非 0、或响应中找不到 access token 时。
 */
export async function exchangeTraeCnToken(
  args: { refreshToken: string; userId: string },
  product: TraeCnProduct,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TraeCnTokenPayload> {
  if (args.refreshToken.length === 0) {
    throw new Error('Trae CN 续期缺少 refresh_token，请重新登录')
  }
  const body = {
    ClientID: product.clientId,
    ClientSecret: product.clientSecret,
    RefreshToken: args.refreshToken,
    UserID: args.userId,
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${TRAE_CN_EXCHANGE_TOKEN_PATH}`, {
      method: 'POST',
      headers: traeCnAnonymousHeaders(),
      body: JSON.stringify(body),
      signal: signalToUse,
    })
  } catch (error) {
    // 传输层失败**不**是终态：交给调用方（与 RefreshScheduler）走可重试路径。
    throw new Error(`Trae CN ExchangeToken 网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Trae CN ExchangeToken 响应不是 JSON（HTTP ${response.status}）`)
  }

  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    throw new Error(
      `Trae CN ExchangeToken 失败（HTTP ${response.status}）`
      + `${message === undefined ? '' : `：${message}`}`,
    )
  }

  const payload = parseTraeCnTokenPayload(parsed)
  if (payload === undefined) {
    const envelopeError = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    if (envelopeError !== undefined) {
      throw new Error(`Trae CN ExchangeToken 失败：${envelopeError}`)
    }
    // 没有 access token：把**实际键名**带进错误里，一次真机调用即可定位。
    throw new Error(
      `Trae CN ExchangeToken 响应中找不到 access token（顶层键：${describeTopLevelKeys(parsed)}）`,
    )
  }
  return payload
}

/**
 * 用续期结果更新凭据（保留服务端未返回的字段）。
 *
 * **五件套里的身份字段一律沿用旧值**（`user_id` / `client_id` / `device_id`
 * / `machine_id`）：续期响应只带令牌，不含账号对象。`refresh_token` 仅在
 * 响应给了新值时才覆盖 —— 覆盖成空串会让下一次续期直接失败。
 *
 * `user_id` 是唯一例外：响应若给了（或 JWT 里有），**回填**它 ——
 * 兼容分支拿不到 `userInfo` 时，凭据会因此在首次续期后自愈。
 */
export function applyTraeCnRefresh(
  previous: TraeCnCredential,
  payload: TraeCnTokenPayload,
): TraeCnCredential {
  const expiresAt = jwtExpiresAtMs(payload.accessToken)
  return {
    ...previous,
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    user_id: previous.user_id.length > 0
      ? previous.user_id
      : (payload.userId.length > 0 ? payload.userId : previous.user_id),
    device_id: previous.device_id.length > 0
      ? previous.device_id
      : (payload.deviceId.length > 0 ? payload.deviceId : previous.device_id),
    nickname: previous.nickname !== undefined && previous.nickname.length > 0
      ? previous.nickname
      : payload.nickname,
    expires_at: expiresAt === undefined ? (previous.expires_at ?? '') : String(expiresAt),
  }
}

// ── 登录交换：AuthCode + PKCE → access token（`trae/api/v3/oauth/…`） ──

/** authCode 交换端点响应解析出的载荷（**真机 schema**）。 */
export interface TraeCnAuthExchangeResult {
  /** access token（JWT）；响应 `Result.Token`。 */
  accessToken: string
  /** refresh token；响应 `Result.RefreshToken`。 */
  refreshToken: string
  /**
   * 服务端绑定的设备号；响应 `Result.BoundDeviceID`。
   *
   * 真机 `wl2k1e2endpp32`，配套 `DeviceBindStatus: "BOUND"`。
   * 这是凭据 `device_id` 的真实来源（见 {@link TraeCnCredential.device_id}）。
   */
  boundDeviceId: string
  /** access token 过期时刻（epoch ms）；响应 `Result.TokenExpireAt`，缺失为 undefined。 */
  tokenExpireAt?: number
  /** 绑定状态（诊断用）；响应 `Result.DeviceBindStatus`。 */
  deviceBindStatus: string
}

/**
 * `DeviceInfo` —— authCode 交换请求体的设备块（**真机 12 字段，逐字**）。
 *
 * 真机 main.log:140 的 `DeviceInfo` 完整可解析（客户端日志的脱敏器只按 key 名
 * 过滤 `token`/`userjwt` 等，本对象无这些键），故这 12 个字段名与取值来源
 * 都不是推测。
 *
 * ## 与本插件能力的差距（**如实降级，不发明**）
 *
 * 真机值来自客户端进程内服务，本插件无法等价获取，故采「客户端形态伪装」常量：
 *
 * | 字段 | 真机来源 | 本实现 |
 * |---|---|---|
 * | `DeviceID` | 设备注册服务（16 位十进制） | 登录 URL 用的**同一个**随机 16 位号 |
 * | `MachineID` | 遥测服务（64 hex） | 登录 URL 用的**同一个** 64 hex |
 * | `DeviceName` | `net.exe user %USERNAME%` 的 Full Name | 主机名（`os.hostname()`，非空） |
 * | `DeviceBrand` / `DeviceCPU` / `DeviceModel` | 系统信息 | **空串**（不猜硬件型号） |
 * | `OSInfo` / `OSVersion` | 系统信息 | 常量（`windows` / `Windows 10 Home`） |
 * | `DevicePublicKey` | EC P-256 SPKI PEM（`vDe()` 每次登录生成新对） | 同款现场生成（见下） |
 *
 * `DeviceBrand`/`DeviceCPU`/`DeviceModel` 留空串是**刻意的**（不猜硬件型号）。
 * `DevicePublicKey` 曾按「该路径不发 `DeviceProof`」也留空串，实测
 * （2026-09-18 真机登录）exchange 回 400 `10101 无效参数` —— 服务端至少
 * 校验它非空合法，故改为与官方 `vDe()` 一致：每次登录生成新 EC P-256
 * 密钥对，SPKI PEM 填入。`DeviceProof` 在登录路径上确实不发（真机请求体
 * 逐字确认只有 `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}`）。
 */
export interface TraeCnDeviceInfo {
  DeviceID: string
  MachineID: string
  PlatformCode: string
  DeviceType: string
  DeviceName: string
  DeviceModel: string
  ClientVersion: string
  DevicePublicKey: string
  DeviceBrand: string
  DeviceCPU: string
  OSInfo: string
  OSVersion: string
}

/**
 * 组装 `DeviceInfo`（字段顺序与真机逐字一致，便于与日志逐行对照）。
 *
 * @param deviceId - 16 位十进制设备号（**与登录 URL 的 `device_id` 同值**）。
 * @param machineId - 64 位 hex 机器号（**与登录 URL 的 `machine_id` 同值**）。
 * @param deviceName - 设备名；缺省取主机名（见 {@link buildTraeCnDeviceInfo}）。
 */
export function buildTraeCnDeviceInfo(
  deviceId: string,
  machineId: string,
  deviceName?: string,
  /** EC P-256 SPKI PEM（`vDe()` 生成）；官方实现从不发空串，缺省时现场生成。 */
  devicePublicKey?: string,
): TraeCnDeviceInfo {
  return {
    DeviceID: deviceId,
    MachineID: machineId,
    PlatformCode: TRAE_CN_PLATFORM_CODE,
    DeviceType: TRAE_CN_DEVICE_TYPE_PC,
    // 真机值取自 `net.exe user` 的 Full Name；本插件取**主机名** —— 同样是
    // 「这台机器叫什么」的如实答案，且不依赖执行外部命令。
    // **必须给具体值**：留空会让请求体出现一个官方实现从不发送的空串字段。
    DeviceName: deviceName ?? hostname(),
    DeviceModel: '',
    ClientVersion: TRAE_CN_IDE_VERSION,
    // 官方每次登录都生成新密钥对并把 SPKI PEM 放这里（main.js vDe()）。
    // 实测留空串时 exchange 回 400「无效参数」；本插件同样每次登录生成新的。
    DevicePublicKey: devicePublicKey ?? generateTraeCnDevicePublicKey(),
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: TRAE_CN_LOGIN_OS_INFO,
    OSVersion: TRAE_CN_LOGIN_OS_VERSION,
  }
}

/**
 * 解析 authCode 交换响应（**真机 Result 信封**）。
 *
 * 真机响应（main.log:141）逐字：
 * `{"ResponseMetadata":{…},"Result":{"BoundDeviceID":"wl2k1e2endpp32",
 * "ClientID":"ono9krqynydwx5","DeviceBindStatus":"BOUND",
 * "RefreshExpireAt":1805143893459,"RefreshToken":"…","Token":"…",
 * "TokenExpireAt":1790801493459,"TokenExpireDuration":1209600000,"UserJwt":"…"}}`
 *
 * 判定口径与续期同：先看信封错误码，再看 `Result`。
 */
export function parseTraeCnAuthExchangeResult(body: unknown): TraeCnAuthExchangeResult | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  if (readEnvelopeError(root) !== undefined) return undefined
  const result = typeof root.Result === 'object' && root.Result !== null && !Array.isArray(root.Result)
    ? root.Result as Record<string, unknown>
    : root
  const accessToken = readFirstString(result, ['Token', 'token', 'AccessToken', 'access_token'])
  if (accessToken.length === 0) return undefined
  const expireRaw = result.TokenExpireAt ?? result.tokenExpireAt
  const tokenExpireAt = typeof expireRaw === 'number' && Number.isFinite(expireRaw)
    ? expireRaw
    : (typeof expireRaw === 'string' && /^\d+$/.test(expireRaw) ? Number(expireRaw) : undefined)
  return {
    accessToken,
    refreshToken: readFirstString(result, ['RefreshToken', 'refresh_token', 'refreshToken']),
    boundDeviceId: readFirstString(result, ['BoundDeviceID', 'BoundDeviceId', 'boundDeviceId']),
    ...tokenExpireAt === undefined ? {} : { tokenExpireAt },
    deviceBindStatus: readFirstString(result, ['DeviceBindStatus', 'deviceBindStatus']),
  } satisfies TraeCnAuthExchangeResult
}

/** {@link exchangeTraeCnAuthCode} 的参数。 */
export interface TraeCnAuthCodeExchangeArgs {
  /** 回调 `authCodeInfo.AuthCode`。 */
  authCode: string
  /** 本次登录生成的 PKCE verifier（**必须与登录 URL 的 challenge 配对**）。 */
  codeVerifier: string
  /** 与登录 URL 同值的 16 位十进制设备号。 */
  deviceId: string
  /** 与登录 URL 同值的 64 hex 机器号。 */
  machineId: string
  /** 设备名（真机是 `net.exe user` 的 Full Name；缺省取主机名）。 */
  deviceName?: string
}

/**
 * 用 **AuthCode + PKCE verifier** 换 token（登录流程第二步）。
 *
 * 端点 `POST {apiBase}/trae/api/v3/oauth/ExchangeToken`（**与续期端点不同**，
 * 见 {@link exchangeTraeCnToken}）；body 五字段
 * `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}`，
 * **不含** `ClientSecret` / `DeviceProof`（真机逐字确认）。
 *
 * @throws 网络失败、HTTP 非 2xx、业务码非 0、或响应里找不到 `Result.Token` 时。
 */
export async function exchangeTraeCnAuthCode(
  args: TraeCnAuthCodeExchangeArgs,
  product: TraeCnProduct,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TraeCnAuthExchangeResult> {
  if (args.authCode.length === 0) {
    throw new Error('Trae CN 登录交换缺少 AuthCode，请重新登录')
  }
  if (args.codeVerifier.length === 0) {
    throw new Error('Trae CN 登录交换缺少 CodeVerifier（PKCE），请重新登录')
  }
  const body = {
    ClientID: product.clientId,
    AuthCode: args.authCode,
    CodeVerifier: args.codeVerifier,
    DeviceInfo: buildTraeCnDeviceInfo(args.deviceId, args.machineId, args.deviceName ?? ''),
    IDEVersion: TRAE_CN_IDE_VERSION,
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${TRAE_CN_AUTH_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: traeCnAnonymousHeaders(),
      body: JSON.stringify(body),
      signal: signalToUse,
    })
  } catch (error) {
    throw new Error(
      `Trae CN 登录 ExchangeToken 网络失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Trae CN 登录 ExchangeToken 响应不是 JSON（HTTP ${response.status}）`)
  }

  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    throw new Error(
      `Trae CN 登录 ExchangeToken 失败（HTTP ${response.status}）`
      + `${message === undefined ? '' : `：${message}`}`,
    )
  }

  const result = parseTraeCnAuthExchangeResult(parsed)
  if (result === undefined) {
    const envelopeError = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    if (envelopeError !== undefined) {
      throw new Error(`Trae CN 登录 ExchangeToken 失败：${envelopeError}`)
    }
    throw new Error(
      'Trae CN 登录 ExchangeToken 响应中找不到 Result.Token'
      + `（顶层键：${describeTopLevelKeys(parsed)}）`,
    )
  }
  return result
}

// ── 登录 URL ──

/**
 * 构造登录 URL（**真机参数表逐项对齐** main.log:136）。
 *
 * ## 参数表（顺序与真机一致，便于逐字段比对日志）
 *
 * | 参数 | 值来源 |
 * |---|---|
 * | `login_version` | 常量 `1` |
 * | `auth_from` | 常量 `trae` |
 * | `login_channel` | 常量 `native_ide` |
 * | `plugin_version` | 常量 `2.3.83560` |
 * | `auth_type` | 常量 `local` |
 * | `client_id` | **snake_case**（写错即「认证中」卡死，见产品配置） |
 * | `redirect` | 常量 `0` |
 * | `login_trace_id` | 本次登录随机 UUID（**回调校验的锚点**） |
 * | `auth_callback_url` | `http://127.0.0.1:{port}/authorize` |
 * | `machine_id` | 本次登录随机 64 hex |
 * | `device_id` | 本次登录随机 16 位十进制 |
 * | `x_device_id` / `x_machine_id` | 同 `device_id` / `machine_id` |
 * | `x_device_brand` | 空（真机为空；官方取 `deviceModel`，本插件不猜硬件） |
 * | `x_device_type` | `windows`（真机取 `osName`） |
 * | `x_os_version` | `Windows 10 Home`（真机取 `osVersion`） |
 * | `x_env` | 空（真机为空） |
 * | `x_app_version` | `3.3.100` |
 * | `x_app_type` | `stable` |
 * | `code_challenge` | PKCE challenge（43 字符 base64url） |
 * | `code_challenge_method` | **`S256`**（不是 `SHA-256`） |
 * | `channel_name` | `common` |
 *
 * ⚠️ 用 `URLSearchParams` 而非手工拼串：`auth_callback_url` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 * 参数**顺序**与真机一致只是为了让日志能逐行对照，不承担协议语义。
 *
 * @param redirect - `redirect` 参数值；默认 {@link TRAE_CN_LOGIN_REDIRECT}（`0`，
 * 授权页停在登录流程）。回调成功回跳时传
 * {@link TRAE_CN_LOGIN_REDIRECT_CALLBACK}（`1`）——官方 `updateLocalCredential`
 * 正是用同一构造器换 `redirect` 后 307 回跳的（见该常量的来源说明）。
 */
export function buildTraeCnLoginUrl(
  port: number,
  product: TraeCnProduct,
  machineId: string,
  deviceId: string,
  loginTraceId: string,
  pkce: Pick<TraeCnPkce, 'codeChallenge' | 'codeChallengeMethod'>,
  redirect: string = TRAE_CN_LOGIN_REDIRECT,
): string {
  const query = new URLSearchParams({
    login_version: TRAE_CN_LOGIN_VERSION,
    auth_from: TRAE_CN_LOGIN_AUTH_FROM,
    login_channel: TRAE_CN_LOGIN_CHANNEL,
    plugin_version: TRAE_CN_PLUGIN_VERSION,
    auth_type: TRAE_CN_LOGIN_AUTH_TYPE,
    client_id: product.clientId,
    redirect,
    login_trace_id: loginTraceId,
    auth_callback_url: `http://127.0.0.1:${port}${TRAE_CN_CALLBACK_PATH}`,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: '',
    x_device_type: TRAE_CN_LOGIN_OS_INFO,
    x_os_version: TRAE_CN_LOGIN_OS_VERSION,
    x_env: '',
    x_app_version: TRAE_CN_IDE_VERSION,
    x_app_type: TRAE_CN_APP_TYPE,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
    channel_name: TRAE_CN_CHANNEL_NAME,
  })
  return `${product.portalBase}${TRAE_CN_AUTHORIZATION_PATH}?${query.toString()}`
}

// ── 回调解析 ──

/**
 * 解析后的回调载荷（两个分支的并集）。
 *
 * `mode` 表达**本次回调走了哪条分支**，这对诊断是不可省的：两条分支的凭据
 * 完整度不同（`authCode` 分支能拿到 `BoundDeviceID`，`refreshToken` 分支不能）。
 */
export type TraeCnCallbackPayload =
  | {
    mode: 'auth-code'
    /** `authCodeInfo.AuthCode`。 */
    authCode: string
    /** `authCodeInfo.ExpireAt`（epoch ms），缺失为 undefined。 */
    authCodeExpireAt?: number
    /** `userInfo.UserID`（可能为空串 —— 解析失败不阻断登录，见下）。 */
    userId: string
    /** `userInfo.ScreenName`。 */
    nickname: string
    /** 回调回传的 `loginTraceID`。 */
    loginTraceId: string
  }
  | {
    mode: 'refresh-token'
    /** 回调直接给的 refreshToken。 */
    refreshToken: string
    /** 回调 query 里的 `userId`（该分支没有 userInfo 信封时的兜底）。 */
    userId: string
    /** 回调回传的 `loginTraceID`（该分支可能不带）。 */
    loginTraceId: string
  }

/** 解析 JSON 字符串参数；失败返回 undefined（**不抛错**，由调用方决定是否致命）。 */
function parseJsonParam<T>(raw: string | null): T | undefined {
  if (raw === null || raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as T : undefined
  } catch {
    return undefined
  }
}

/**
 * 从回调 URL 解析出载荷（**双模**，PKCE 优先）。
 *
 * ## 双模的依据
 *
 * 授权页是**双模**的，取决于登录 URL 是否带 `code_challenge`：
 *
 * - **带 PKCE**（本实现的主路径）→ 回调投递 `authCodeInfo`（JSON 字符串），
 *   由客户端自己换 token；
 * - **不带 PKCE** → 页面靠浏览器 Cookie 会话（`withCredentials` 到 api.trae.cn）
 *   自己调 `GetRefreshToken`，回调投递 `refreshToken`。
 *
 * 两份调研看到的正是同一页面的两条分支，都对。本实现主发 PKCE，但**回调侧
 * 两条都收**：真机日志一旦显示回退到了 refreshToken 分支，说明服务端没走我们
 * 请求的那条，那是必须能看见的事实，而不是一个「参数缺失」的 500。
 *
 * ## 校验与取舍
 *
 * - `loginTraceID` 命中我们本次生成的值时**通过**；不匹配或缺失时**不拒绝**，
 *   只在诊断里标注 —— 见 {@link completeTraeCnCallback} 的说明；
 * - `userInfo` 解析失败**不致命**：`UserID` 缺了还能从 JWT 补，而拒掉整次
 *   登录会让用户白跑一遍浏览器流程。仅 `authCodeInfo` 缺 `AuthCode` 才算失败。
 */
export function parseTraeCnCallbackUrl(url: URL): TraeCnCallbackPayload | undefined {
  const authCodeInfo = parseJsonParam<Record<string, unknown>>(
    url.searchParams.get(TRAE_CN_AUTH_CODE_INFO_PARAM),
  )
  if (authCodeInfo !== undefined) {
    const authCode = readFirstString(authCodeInfo, ['AuthCode', 'authCode'])
    if (authCode.length > 0) {
      const userInfo = parseJsonParam<Record<string, unknown>>(
        url.searchParams.get(TRAE_CN_USER_INFO_PARAM),
      )
      const expireRaw = authCodeInfo.ExpireAt ?? authCodeInfo.expireAt
      const authCodeExpireAt = typeof expireRaw === 'number' && Number.isFinite(expireRaw)
        ? expireRaw
        : (typeof expireRaw === 'string' && /^\d+$/.test(expireRaw) ? Number(expireRaw) : undefined)
      return {
        mode: 'auth-code',
        authCode,
        ...authCodeExpireAt === undefined ? {} : { authCodeExpireAt },
        // userInfo 缺失时退到裸 `userId` 参数：兼容分支与异常回调都可能只给后者。
        userId: userInfo === undefined
          ? (url.searchParams.get('userId') ?? '')
          : readFirstString(userInfo, ['UserID', 'UserId', 'userId']),
        nickname: userInfo === undefined ? '' : readFirstString(userInfo, ['ScreenName', 'Nickname', 'nickname']),
        loginTraceId: url.searchParams.get(TRAE_CN_LOGIN_TRACE_ID_PARAM) ?? '',
      }
    }
  }

  const refreshToken = url.searchParams.get(TRAE_CN_REFRESH_TOKEN_PARAM) ?? ''
  if (refreshToken.length > 0) {
    return {
      mode: 'refresh-token',
      refreshToken,
      userId: url.searchParams.get('userId') ?? '',
      loginTraceId: url.searchParams.get(TRAE_CN_LOGIN_TRACE_ID_PARAM) ?? '',
    }
  }
  return undefined
}

/**
 * 从 JWT 里读出用户 ID（`user_id` / `userId` / `uid` / `sub` 依次尝试）。
 *
 * 来源优先级里它是**最后一级**：回调 `userInfo.UserID` 才是权威，JWT 声明只在
 * userInfo 缺失时兜底（兼容分支与异常回调）。
 */
export function readTraeCnJwtUserId(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    return readFirstString(payload, ['user_id', 'userId', 'uid', 'sub', 'UserID'])
  } catch {
    return ''
  }
}

/** 从 JWT 里读出昵称（没有则空串）。 */
function readTraeCnJwtNickname(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    return readFirstString(payload, ['nickname', 'name', 'preferred_username'])
  } catch {
    return ''
  }
}

// ── 回调脱敏 ──

/**
 * 回调参数中**可安全原样入日志**的白名单（非机密元数据）。
 *
 * 采用**白名单（fail-closed）**而非「敏感键黑名单」：黑名单只能挡住你想得到的
 * 名字，而一个叫 `weird_param` 的未知参数完全可能就是凭据。白名单的默认动作是
 * 脱敏，未知参数最多泄露「名字 + 长度 + 6 字符前缀」。
 *
 * 白名单里的值都是**本次登录自己生成**或**非机密**的：
 * `machine_id` / `device_id` 是登录 URL 里那两个随机号（设备形态本来就是明发的
 * 登录参数），`loginTraceID` 是本次登录的一次性追踪号，`scope` / `host` /
 * `userRegion` / `isRedirect` 是服务端的路由元数据。
 *
 * ⚠️ `userInfo` **不在**白名单里：它含 `NonPlainTextMobile`（手机号）与
 * `AvatarUrl`（含账号标识）。只保留参数名即可满足校准需要。
 */
const SAFE_CALLBACK_PARAMS: ReadonlySet<string> = new Set([
  'machine_id',
  'device_id',
  'login_trace_id',
  TRAE_CN_LOGIN_TRACE_ID_PARAM,
  'state',
  'clientID',
  'client_id',
  'auth_callback_url',
  'redirect_uri',
  'port',
  TRAE_CN_SCOPE_PARAM,
  'host',
  'userRegion',
  'isRedirect',
])

/**
 * 把回调 URL 脱敏成可安全入日志的形态（**保留全部参数名**）。
 *
 * 脱敏规则（**默认脱敏，白名单放行**）：
 * - **参数名一律完整保留** —— 它们是判断「走了哪条分支」的证据；
 * - 白名单内的非机密元数据（见 {@link SAFE_CALLBACK_PARAMS}）原样保留其值；
 * - **其余一切参数**（含未知名字）的值压成 `前6位…(len=N)`，只够确认
 *   「拿到了东西」与「长度对不对」。宁可校准信息少一点，也不把可能是
 *   refreshToken / authCode 的值写进日志。
 *
 * 解析失败时**不返回原串**（原串可能带 token），而是返回长度与错误说明。
 */
export function redactTraeCnCallbackUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://127.0.0.1')
  } catch {
    return `<无法解析的回调 URL，长度 ${rawUrl.length}>`
  }
  const parts: string[] = []
  for (const [key, value] of url.searchParams) {
    if (SAFE_CALLBACK_PARAMS.has(key)) {
      parts.push(value.length <= 64 ? `${key}=${value}` : `${key}=${value.slice(0, 32)}…(len=${value.length})`)
      continue
    }
    const head = value.slice(0, Math.min(6, value.length))
    parts.push(`${key}=${head}…(len=${value.length})`)
  }
  const query = parts.length === 0 ? '(无 query 参数)' : parts.join('&')
  const hash = url.hash.length > 0 ? ` hash=${url.hash}` : ''
  return `${url.pathname}?${query}${hash}`
}

// ── 登录流程 ──

/** 一次登录流程的结果。 */
export interface TraeCnLoginFlowResult {
  /** 已序列化的 `TraeCnCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** `runTraeCnLoginFlow` 接受的选项。 */
export interface TraeCnLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 回调等待总超时（毫秒）；默认 10 分钟。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置；默认 TRAE_CN。 */
  product?: TraeCnProduct
  /**
   * 回调诊断钩子（收到**每条**回调时调用，参数已脱敏）。
   *
   * 用途有二：一是记录「本次回调走了哪条分支」（PKCE 还是 refreshToken），
   * 二是真机出现异常流程时留下可逐字段比对服务端行为的现场。
   * 生产侧由 `TraeCnAuth` 接到 `ctx.logger.info`。
   */
  onCallbackDebug?: (message: string) => void
}

/**
 * 一次「已准备、待完成」的登录会话（两段式的第一段产物）。
 *
 * 与 {@link runTraeCnLoginFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 10 分钟」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface TraeCnPendingLogin {
  /** 本地回调服务器实际监听的端口。 */
  port: number
  /** 展示给用户的 portal 登录 URL（含本次随机的 machine_id / device_id / PKCE）。 */
  loginUrl: string
  /** 等待用户在浏览器完成登录、并换取 access token。 */
  awaitCredential(): Promise<TraeCnLoginFlowResult>
  /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
  cancel(reason?: string): void
}

/**
 * {@link prepareTraeCnLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type TraeCnLoginPrepareOutcome =
  | { ok: true; session: TraeCnPendingLogin }
  | { ok: false; error: 'login-in-progress'; message: string }

/** {@link prepareTraeCnLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type TraeCnLoginPrepareOptions =
  Omit<TraeCnLoginFlowOptions, 'openBrowser'> & { product: TraeCnProduct }

/**
 * 进行中的登录槽位（模块级，同一时间最多一个）。
 *
 * prepare 阶段会**占用一个本地监听端口**，而客户端的「新建账号」按钮可以被
 * 反复点击。没有互斥时每次点击都会起一个新的 loopback 服务器，
 * 点 N 次就有 N 个端口一直挂到 10 分钟超时。
 *
 * `'preparing'` 是**同步占位**：从进入临界区到回调服务器真正 listen 成功之间
 * 存在多个 await，若只在 listen 完成后才登记，并发的两次调用会双双通过判空
 * 检查、各自起一个监听（LobsterAI 侧实测：3 次并发 prepare 全部成功、3 个端口）。
 * 故必须在**第一个 await 之前**同步占位。
 */
type TraeCnLoginSlot = TraeCnPendingLogin | 'preparing'

let activeLoginSlot: TraeCnLoginSlot | undefined

/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export function hasActiveTraeCnLogin(): boolean {
  return activeLoginSlot !== undefined
}

/**
 * 处理一次回调：解析载荷 → 换取 access token → 组装凭据。
 *
 * 抽成函数是为了让「回调 → 凭据」这段纯逻辑可被单测直接覆盖，
 * 不必每次都起 HTTP 服务器。
 *
 * ## `state` 校验的取舍（**刻意保留，但只警告不拒绝**）
 *
 * `login_trace_id` 是我们本次生成的随机 UUID，回调把它原样带回；校验通过即
 * 证明「这次回调属于这次登录」，是防 CSRF 的正经手段，故**保留**。
 *
 * 但**不匹配时不予拒绝**：凭证点是我们自己发的随机串、服务端回显；一旦
 * Trae 侧不回显（或改名），硬拒绝会让登录**永久失败且原因看起来像被攻击**。
 * 相比之下，本回调服务器只绑 `127.0.0.1` 且只存活于本次登录窗口内，
 * 「放过一次 trace 不匹配的回调」的风险远小于「登录永远不通」。
 * 故：不匹配 → 记一条诊断，继续。
 *
 * @param callbackUrl - 回调请求的完整 URL（真实 query 未脱敏 —— 脱敏只用于日志）。
 * @param session - 本次登录的三个一次性随机量（machineId / deviceId / PKCE / trace）。
 * @param product - 产品配置（用到 `apiBase` / `clientId` / `clientSecret`）。
 * @throws 载荷无法解析、或 exchange 失败时。
 */
export async function completeTraeCnCallback(
  callbackUrl: URL,
  session: {
    machineId: string
    deviceId: string
    codeVerifier: string
    loginTraceId: string
    deviceName?: string
  },
  product: TraeCnProduct,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<TraeCnCredential> {
  const payload = parseTraeCnCallbackUrl(callbackUrl)
  if (payload === undefined) {
    throw new Error(
      '登录回调未携带 authCodeInfo 或 refreshToken'
      + `（实际参数：${redactTraeCnCallbackUrl(callbackUrl.toString())}）`,
    )
  }

  // PKCE 分支：AuthCode + verifier → trae/api/v3/oauth/ExchangeToken。
  if (payload.mode === 'auth-code') {
    const result = await exchangeTraeCnAuthCode({
      authCode: payload.authCode,
      codeVerifier: session.codeVerifier,
      deviceId: session.deviceId,
      machineId: session.machineId,
      ...session.deviceName === undefined ? {} : { deviceName: session.deviceName },
    }, product, fetcher, signal)

    const userId = payload.userId.length > 0 ? payload.userId : readTraeCnJwtUserId(result.accessToken)
    const nickname = payload.nickname.length > 0
      ? payload.nickname
      : readTraeCnJwtNickname(result.accessToken)
    return buildTraeCnCredential({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId,
      clientId: product.clientId,
      deviceId: result.boundDeviceId,
      deviceIdSource: 'exchange-bound-device-id',
      machineId: session.machineId,
      // **签到设备号 = 本次登录 URL 里的那个 16 位号**（9074 真根因修复）：
      // 它才是「我们注册的这台设备」，服务端按它做设备维度记账。
      checkinDeviceId: session.deviceId,
      ...result.tokenExpireAt === undefined ? {} : { expiresAt: result.tokenExpireAt },
      nickname,
    })
  }

  // 兼容分支：回调直接给 refreshToken（授权页的非 PKCE 模式）。
  // 该分支**没有** exchange 响应，故没有 BoundDeviceID —— device_id 如实留空，
  // 绝不拿 machine_id 折算一个假的 16 位号顶上（伪造设备身份比缺字段更坏）。
  // ⚠️ 但**签到设备号照常落盘**：它就是本次登录 URL 里那个 16 位号，
  //    该分支同样拿得到（只是拿不到服务端的 BoundDeviceID）。两条信息互不依赖。
  const tokenPayload = await exchangeTraeCnToken(
    { refreshToken: payload.refreshToken, userId: payload.userId },
    product,
    fetcher,
    signal,
  )
  const userId = payload.userId.length > 0
    ? payload.userId
    : (tokenPayload.userId.length > 0
      ? tokenPayload.userId
      : readTraeCnJwtUserId(tokenPayload.accessToken))
  const nickname = tokenPayload.nickname.length > 0
    ? tokenPayload.nickname
    : readTraeCnJwtNickname(tokenPayload.accessToken)
  return buildTraeCnCredential({
    accessToken: tokenPayload.accessToken,
    refreshToken: tokenPayload.refreshToken.length > 0 ? tokenPayload.refreshToken : payload.refreshToken,
    userId,
    clientId: product.clientId,
    deviceId: tokenPayload.deviceId,
    deviceIdSource: 'exchange-bound-device-id',
    machineId: session.machineId,
    checkinDeviceId: session.deviceId,
    nickname,
  })
}

/**
 * 组装可持久化的凭据。
 *
 * `expires_at` 两级取值：优先 exchange 响应的 `TokenExpireAt`（服务端权威），
 * 缺失时由 access token 的 JWT `exp` 派生；两者都没拿到就留空 ——
 * `traeCnCredentialExpiresAtMs` 会在读取时再试一次，仍失败则「不判定过期」。
 */
export function buildTraeCnCredential(input: {
  accessToken: string
  refreshToken: string
  userId: string
  clientId: string
  deviceId: string
  deviceIdSource: TraeCnDeviceIdSource
  machineId: string
  /**
   * 登录时生成、并原样上报给服务端的 16 位纯十进制设备号。
   *
   * 主路径与兼容分支都**能**拿到它（它就是登录 URL 里的 `device_id`）；只有
   * 「粘贴 refreshToken」这类**没有登录 URL** 的入口拿不到，那时传空串，
   * 由 {@link traeCnCheckinDeviceId} 如实降级。
   */
  checkinDeviceId?: string
  expiresAt?: number
  nickname?: string
}): TraeCnCredential {
  const expiresAt = input.expiresAt ?? jwtExpiresAtMs(input.accessToken)
  return {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    user_id: input.userId,
    client_id: input.clientId,
    device_id: input.deviceId,
    // 缺失即空串（不是 undefined）：凭据要能 JSON 往返且键存在，
    // 让「本字段为空」与「老凭据没这个键」在存储层可区分。
    checkin_device_id: input.checkinDeviceId ?? '',
    machine_id: input.machineId,
    device_id_source: input.deviceIdSource,
    expires_at: expiresAt === undefined ? '' : String(expiresAt),
    nickname: input.nickname ?? '',
  }
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(credential: TraeCnCredential, loginUrl: string): TraeCnLoginFlowResult {
  return {
    access: serializeTraeCnCredential(credential),
    // 与另外两条协议线一致：无法解析过期时间时报告 0 而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
    expires: traeCnCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isTraeCnRefreshable(credential),
  }
}

/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的既有实现）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 回调响应必须带的 CORS 头。
 *
 * ## 为什么 loopback 回调需要 CORS
 *
 * 官方实现里回调是**浏览器整页跳转**到 `127.0.0.1:{port}/authorize`，同源策略
 * 不介入，故不需要任何 CORS 头。但本插件的登录 URL 由客户端在同一用户手势内
 * 打开，浏览器与授权页的交互方式不受我们控制 —— 一旦回调走的是
 * `fetch`/预检路径（或页面成了带 origin 的 SPA 回调），
 * **不带 `Access-Control-Allow-Origin` 会让浏览器静默丢弃响应**，
 * 表现为「登录页显示成功、宿主一直在等」，比报错更难查。
 *
 * 官方 server 同样设 `Access-Control-Allow-Origin: *` 并处理 `OPTIONS`，
 * 故这是对齐而非发明。`*` 在此**不构成越权**：回调服务只绑 `127.0.0.1`、
 * 只存活于本次登录窗口，且响应体不含任何凭据（成功时只有一条 307 回跳、
 * 失败时只有一句纯文本）。
 */
export const TRAE_CN_CALLBACK_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'x-jwt-token,content-type',
}

/**
 * 准备一次登录（两段式的第一段）：起本地回调服务器，返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link TraeCnPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 超时、成功、失败、{@link TraeCnPendingLogin.cancel} 都会释放会话。
 */
export async function prepareTraeCnLogin(
  options: TraeCnLoginPrepareOptions,
): Promise<TraeCnLoginPrepareOutcome> {
  if (activeLoginSlot !== undefined) {
    return {
      ok: false,
      error: 'login-in-progress',
      message: '已有 Trae CN 登录进行中，请先在浏览器完成或关闭该登录窗口',
    }
  }
  // 同步占位：本函数后面还有 await（listen），不在此刻占住的话并发调用会同时通过上面的判空。
  activeLoginSlot = 'preparing'

  const fetcher = options.fetcher ?? fetch
  const { product } = options
  // 四个一次性随机量：machine_id / device_id / login_trace_id / PKCE。
  // 它们必须**成套**交给回调处理器 —— device_id 与 machine_id 会原样进
  // exchange 请求体的 DeviceInfo，与登录 URL 里的值不一致会被服务端看出。
  const machineId = generateTraeCnMachineId()
  const deviceId = generateTraeCnDeviceId()
  const loginTraceId = generateTraeCnLoginTraceId()
  const pkce = generateTraeCnPkce()

  let resolveResult!: (value: TraeCnLoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const credential = new Promise<TraeCnLoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 这个 Promise 是手工创建的、要过一会儿才被消费者 await，而回调处理器可能在
  // 「构造完成」与「被 await」之间就把它 reject 掉（典型：回调极快，或 exchange
  // 立刻失败）。那一段窗口里 Node 会把它视为**未处理的拒绝**并触发
  // PromiseRejectionHandledWarning / vitest 的 unhandled error。
  // 先挂一个空处理器把「已处理」标记打上；不影响后续消费者 —— 它们仍拿到同一拒绝原因。
  credential.catch(() => {})

  let serverClosed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  /** 关闭回调服务器并停掉超时计时器（幂等）。 */
  const closeServer = async (): Promise<void> => {
    if (serverClosed) return
    serverClosed = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const server = createServer((request, response) => {
    const localPort = request.socket.localPort ?? 0
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${localPort}`)
    // 诊断：**每条**回调先记一份脱敏形态（保留全部参数名），再判分支。
    // 这样即便载荷与预期不符，日志里也有据可查，而不是只有一个 404/400。
    options.onCallbackDebug?.(
      `[trae-cn] 登录回调 ${request.method ?? 'GET'} ${redactTraeCnCallbackUrl(url.toString())}`,
    )
    // ① CORS 预检：必须在路径判定**之前**处理 —— 预检请求打的是同一个 URL，
    //    但方法是 OPTIONS 且不带 query，落到下面的 404 分支会让浏览器认为
    //    回调地址不可跨域访问。
    if (request.method === 'OPTIONS') {
      response.writeHead(204, TRAE_CN_CALLBACK_CORS_HEADERS).end()
      return
    }
    // ② 路径不符：404，同样**不触碰会话**。
    if (!url.pathname.startsWith(TRAE_CN_CALLBACK_PATH)) {
      response.writeHead(404, { ...TRAE_CN_CALLBACK_CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Not found')
      return
    }
    // ③ 无载荷 / 畸形请求：400，**不结算会话**。
    //
    //    这是刻意与「登录失败」分开的一层：打到本端口的未必是登录回调 ——
    //    浏览器预检、安全扫描器、用户误触、我们自己的探测都会命中这里。
    //    早先的实现对任何解析不出 token 的请求直接 reject + 关端口，实测一次
    //    500 探测就把整个登录会话终结了（端口关闭、占位账号被删），
    //    用户之后即使真的在浏览器里完成授权也无处回调。
    //    故：只有**可识别的登录回调**才会进入结算路径；
    //    会话只由「成功」「exchange 失败」「超时」「cancel」四种情况终结。
    if (parseTraeCnCallbackUrl(url) === undefined) {
      response.writeHead(400, { ...TRAE_CN_CALLBACK_CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('缺少登录载荷')
      return
    }
    // 结果里的 loginUrl 用**回调请求实际落到的端口**现算，而不是捕获外层变量：
    // 回调服务器端口是在 `listen` 之后才知道的，先声明后赋值会让这个闭包
    // 引用一个尚未初始化的 const。
    const loginUrl = buildTraeCnLoginUrl(localPort, product, machineId, deviceId, loginTraceId, pkce)
    // 成功回调的 307 回跳目标：**同一条授权页 URL，只把 `redirect` 换成 `1`**
    // （官方 `updateLocalCredential` 的成功分支逐字如此，见
    // {@link TRAE_CN_LOGIN_REDIRECT_CALLBACK} 的来源说明）。
    const redirectBackUrl = buildTraeCnLoginUrl(
      localPort, product, machineId, deviceId, loginTraceId, pkce, TRAE_CN_LOGIN_REDIRECT_CALLBACK,
    )
    void completeTraeCnCallback(
      url,
      { machineId, deviceId, codeVerifier: pkce.codeVerifier, loginTraceId },
      product,
      fetcher,
      options.signal,
    )
      .then((credentialValue) => {
        // 307 回跳而非静态 HTML：回调页停在 127.0.0.1 上自身无法离开
        // （HTML 里没有 `window.close()`），而弹窗被拦截、用户走面板内
        // `<a target="_blank">` 手动链接时客户端**没有窗口引用**、
        // `closeLoginWindow()` 够不到那张标签页 —— 回跳是唯一能把它送回
        // `www.trae.cn`（授权页渲染「登录成功」结果页）的机制。
        response.writeHead(307, {
          ...TRAE_CN_CALLBACK_CORS_HEADERS,
          Location: redirectBackUrl,
        }).end()
        resolveResult(toLoginFlowResult(credentialValue, loginUrl))
      })
      .catch((error: unknown) => {
        // 失败路径**维持 500 纯文本**（不改 307）：官方失败分支会带
        // errorCode/errorMsg 回跳，而本插件的错误码体系与官方不通用，
        // 回跳一个我们无法保证渲染形态的页面比一条明确的 500 更难查。
        response.writeHead(500, { ...TRAE_CN_CALLBACK_CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
          .end('登录换取凭据失败')
        rejectResult(error)
      })
  })

  let port: number
  try {
    port = await listenOnRandomPort(server)
  } catch (error) {
    // 起监听失败：必须把同步占下的槽位还回去，否则此后所有登录都会被
    // `login-in-progress` 永久挡住。
    if (activeLoginSlot === 'preparing') activeLoginSlot = undefined
    throw error
  }
  const loginUrl = buildTraeCnLoginUrl(port, product, machineId, deviceId, loginTraceId, pkce)

  // 超时覆盖「用户操作 + exchange」整个窗口；从「会话建立」起算。
  const timeoutMs = options.timeoutMs ?? TRAE_CN_LOGIN_TIMEOUT_MS
  timeoutTimer = setTimeout(() => {
    rejectResult(new Error(`Trae CN 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timeoutTimer.unref?.()

  const loginSession: TraeCnPendingLogin = {
    port,
    loginUrl,
    awaitCredential: () => credential,
    cancel: (reason = 'Trae CN 登录已取消') => {
      rejectResult(new Error(reason))
    },
  }
  // 用真实句柄替换占位，保持互斥连续（中间没有释放窗口）。
  activeLoginSlot = loginSession
  // 结算即释放会话：成功、失败、超时、取消都汇聚到这一条路径上。
  void credential.then(releaseSession, releaseSession)

  function releaseSession(): void {
    if (activeLoginSlot === loginSession) activeLoginSlot = undefined
    void closeServer()
  }

  return { ok: true, session: loginSession }
}

/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等回调 → 换 access token。
 *
 * 单进程内闭环，不落状态文件。现已成为 {@link prepareTraeCnLogin} 的便捷封装，
 * 供「阻塞式」调用方使用（`TraeCnAuth.login()`、e2e 探针）；Account Hub 走的是
 * 两段式（prepare → 客户端弹窗 → awaitCredential），不经过这里。
 */
export async function runTraeCnLoginFlow(
  options: TraeCnLoginFlowOptions & { product: TraeCnProduct },
): Promise<TraeCnLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const outcome = await prepareTraeCnLogin(options)
  if (!outcome.ok) throw new Error(outcome.message)
  const loginSession = outcome.session
  try {
    await open(loginSession.loginUrl)
  } catch (error) {
    // 打开失败时不能把会话留在原地（会一直占用端口到超时）。
    loginSession.cancel(`打开 Trae CN 登录页失败：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  return loginSession.awaitCredential()
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器，返回实际端口。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，
 * 不对外暴露监听面。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('Trae CN 登录回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}
