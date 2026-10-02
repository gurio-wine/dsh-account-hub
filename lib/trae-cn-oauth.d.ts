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
import { type TraeCnDeviceIdSource, type TraeCnProduct } from './trae-cn-product.js';
/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>;
/**
 * 回调 query 中承载 **authCode 信封**（`authCodeInfo`）的参数名。
 *
 * 真机 main.log:139 逐字：`authCodeInfo` 的值是一个 **JSON 字符串**，形如
 * `{"AuthCode":"…","ExpireAt":1789592492958,"ExpireDuration":600000}`——
 * 即**双重编码**（URL query 里再套一层 JSON）。这是 PKCE 分支的载荷。
 */
export declare const TRAE_CN_AUTH_CODE_INFO_PARAM = "authCodeInfo";
/**
 * 回调 query 中承载 **用户信息**（`userInfo`）的参数名。
 *
 * 真机 main.log:139 逐字：同样是 JSON 字符串，含 `UserID` / `ScreenName` /
 * `Region` / `TenantID` 等 15 个键。`UserID` 是后续 `GetUserInfo` 与
 * 账号展示的来源（真机 `1435281906741923`）。
 */
export declare const TRAE_CN_USER_INFO_PARAM = "userInfo";
/**
 * 兼容分支：回调 query 中直接承载 **refreshToken** 的参数名。
 *
 * 这是**不带 PKCE 时授权页的另一条分支**的产物（页面自己调 `GetRefreshToken`）。
 * 本实现以 PKCE 为主路径，故它只在「授权页没走 PKCE」时命中；命中时凭据缺
 * `BoundDeviceID`，`device_id` 留空并在 `device_id_source` 标记 `refreshToken-only`。
 */
export declare const TRAE_CN_REFRESH_TOKEN_PARAM = "refreshToken";
/**
 * 回调 query 中承载 **登录追踪号** 的参数名。
 *
 * 真机 main.log:139 的 `loginTraceID` 与登录 URL 的 `login_trace_id` 同值
 * （`5bc786d0-…`）—— 这正是「本次回调属于本次登录」的服务端凭证，
 * 也是我们做防 CSRF 校验的锚点（见 {@link completeTraeCnCallback}）。
 */
export declare const TRAE_CN_LOGIN_TRACE_ID_PARAM = "loginTraceID";
/**
 * 回调 query 中承载 **来源作用域** 的参数名（真机值 `trae`）。
 *
 * 不参与判定，但**登记在脱敏白名单**里：它是判断「回调来自哪个产品形态」
 * 的现成证据，且非机密。
 */
export declare const TRAE_CN_SCOPE_PARAM = "scope";
/** 一次 PKCE 生成的产物。 */
export interface TraeCnPkce {
    /** `code_verifier`：48 字节随机数的 base64url（64 字符）。 */
    codeVerifier: string;
    /** `code_challenge`：`sha256(codeVerifier)` 的 base64url（43 字符）。 */
    codeChallenge: string;
    /** 挑战方法，恒为 `S256`。 */
    codeChallengeMethod: string;
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
export declare function generateTraeCnPkce(): TraeCnPkce;
/**
 * 生成设备公钥（对齐官方 `main.js` 的 `vDe()`）。
 *
 * 官方实现逐字：`generateKeyPairSync("ec",{namedCurve:"P-256",publicKeyEncoding:
 * {type:"spki",format:"pem"},…})`，每次登录生成新对，SPKI PEM 填入
 * `DeviceInfo.DevicePublicKey`。实测留空串时 exchange 回 400「无效参数」。
 */
export declare function generateTraeCnDevicePublicKey(): string;
/** 生成 64 位小写十六进制 `machine_id`（32 字节）。 */
export declare function generateTraeCnMachineId(): string;
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
export declare function generateTraeCnDeviceId(): string;
/** 生成登录追踪号（UUID v4 形态，真机逐字样本同形）。 */
export declare function generateTraeCnLoginTraceId(): string;
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
    access_token: string;
    /** 刷新令牌（五件套之一；续期端点的 `RefreshToken`）。 */
    refresh_token: string;
    /** 用户 ID（五件套之一；续期端点的 `UserID`）。来源：回调 `userInfo.UserID`。 */
    user_id: string;
    /** OAuth 客户端 ID（五件套之一；与产品配置的 `clientId` 同值，随凭据快照留档）。 */
    client_id: string;
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
    device_id: string;
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
    checkin_device_id: string;
    /** 机器号（五件套之一，64 位小写十六进制）；登录 URL 的 `machine_id` 用之。 */
    machine_id: string;
    /** `device_id` 的来源标记（诊断用）。 */
    device_id_source: TraeCnDeviceIdSource;
    /**
     * 过期时间（**毫秒时间戳字符串**）。
     *
     * 两级来源，取值口径一致：
     * 1. exchange 响应的 `Result.TokenExpireAt`（**权威**，真机为 13 位 epoch ms）；
     * 2. 缺失时由 {@link jwtExpiresAtMs} 从 access token 的 JWT `exp` 派生。
     */
    expires_at?: string;
    /** 昵称（UI 展示；回调 `userInfo.ScreenName` 或 JWT 提供时才写）。 */
    nickname?: string;
}
/** 凭据是否携带可静默续期的 `refresh_token`。 */
export declare function isTraeCnRefreshable(credential: TraeCnCredential): boolean;
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
export declare function traeCnCheckinDeviceId(credential: TraeCnCredential): string;
/**
 * 从凭据解析过期的毫秒时间戳。
 *
 * 优先用存储的 `expires_at`，缺失时**回退解析 access token 的 JWT `exp`** ——
 * 两个口径都是「服务端说了算」：前者来自 `TokenExpireAt`，后者是 token 自述。
 */
export declare function traeCnCredentialExpiresAtMs(credential: TraeCnCredential): number | undefined;
/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与另外两条协议线一致）。 */
export declare function isTraeCnExpired(credential: TraeCnCredential): boolean;
/**
 * 解析存储值里的凭据 JSON；解析失败或结构不合法返回 undefined。
 *
 * 判据只有一条：`access_token` 必须是字符串（账号池反查身份标识要用它）。
 * 其余字段允许缺失 —— 老凭据、或兼容分支（refreshToken-only）的凭据都不该因此
 * 判为损坏。
 */
export declare function parseTraeCnCredential(value: string): TraeCnCredential | undefined;
/** 序列化凭据（存入 `ctx.credentials` 的形态）。 */
export declare function serializeTraeCnCredential(credential: TraeCnCredential): string;
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
export declare function traeCnAccessHeaders(credential: TraeCnCredential, accept?: string): Record<string, string>;
/**
 * 构造两个 `ExchangeToken` 端点的无鉴权请求头。
 *
 * 登录的 authCode 交换与续期都**还没有**可用的 access token：服务端只认请求体
 * （`AuthCode`+`CodeVerifier`，或 `RefreshToken`+`UserID`），故不发 `Authorization`。
 *
 * ⚠️ 调研未给出该端点的 `User-Agent` 约定，故**刻意不发明一个值**。
 * 若真机验证发现网关按 UA 拦截，再补一个实测值并在此注明来源。
 */
export declare function traeCnAnonymousHeaders(): Record<string, string>;
/** 续期端点响应解析出的载荷。 */
export interface TraeCnTokenPayload {
    /** 新的 access token（JWT）。 */
    accessToken: string;
    /** 新的 refresh token；响应未返回时为空串（沿用旧的）。 */
    refreshToken: string;
    /** 响应里带的用户 ID（没有则为空串）。 */
    userId: string;
    /** 响应里带的设备号（没有则为空串）。 */
    deviceId: string;
    /** 昵称（没有则为空串）。 */
    nickname: string;
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
export declare function parseTraeCnTokenPayload(body: unknown): TraeCnTokenPayload | undefined;
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
export declare function exchangeTraeCnToken(args: {
    refreshToken: string;
    userId: string;
}, product: TraeCnProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<TraeCnTokenPayload>;
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
export declare function applyTraeCnRefresh(previous: TraeCnCredential, payload: TraeCnTokenPayload): TraeCnCredential;
/** authCode 交换端点响应解析出的载荷（**真机 schema**）。 */
export interface TraeCnAuthExchangeResult {
    /** access token（JWT）；响应 `Result.Token`。 */
    accessToken: string;
    /** refresh token；响应 `Result.RefreshToken`。 */
    refreshToken: string;
    /**
     * 服务端绑定的设备号；响应 `Result.BoundDeviceID`。
     *
     * 真机 `wl2k1e2endpp32`，配套 `DeviceBindStatus: "BOUND"`。
     * 这是凭据 `device_id` 的真实来源（见 {@link TraeCnCredential.device_id}）。
     */
    boundDeviceId: string;
    /** access token 过期时刻（epoch ms）；响应 `Result.TokenExpireAt`，缺失为 undefined。 */
    tokenExpireAt?: number;
    /** 绑定状态（诊断用）；响应 `Result.DeviceBindStatus`。 */
    deviceBindStatus: string;
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
    DeviceID: string;
    MachineID: string;
    PlatformCode: string;
    DeviceType: string;
    DeviceName: string;
    DeviceModel: string;
    ClientVersion: string;
    DevicePublicKey: string;
    DeviceBrand: string;
    DeviceCPU: string;
    OSInfo: string;
    OSVersion: string;
}
/**
 * 组装 `DeviceInfo`（字段顺序与真机逐字一致，便于与日志逐行对照）。
 *
 * @param deviceId - 16 位十进制设备号（**与登录 URL 的 `device_id` 同值**）。
 * @param machineId - 64 位 hex 机器号（**与登录 URL 的 `machine_id` 同值**）。
 * @param deviceName - 设备名；缺省取主机名（见 {@link buildTraeCnDeviceInfo}）。
 */
export declare function buildTraeCnDeviceInfo(deviceId: string, machineId: string, deviceName?: string, 
/** EC P-256 SPKI PEM（`vDe()` 生成）；官方实现从不发空串，缺省时现场生成。 */
devicePublicKey?: string): TraeCnDeviceInfo;
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
export declare function parseTraeCnAuthExchangeResult(body: unknown): TraeCnAuthExchangeResult | undefined;
/** {@link exchangeTraeCnAuthCode} 的参数。 */
export interface TraeCnAuthCodeExchangeArgs {
    /** 回调 `authCodeInfo.AuthCode`。 */
    authCode: string;
    /** 本次登录生成的 PKCE verifier（**必须与登录 URL 的 challenge 配对**）。 */
    codeVerifier: string;
    /** 与登录 URL 同值的 16 位十进制设备号。 */
    deviceId: string;
    /** 与登录 URL 同值的 64 hex 机器号。 */
    machineId: string;
    /** 设备名（真机是 `net.exe user` 的 Full Name；缺省取主机名）。 */
    deviceName?: string;
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
export declare function exchangeTraeCnAuthCode(args: TraeCnAuthCodeExchangeArgs, product: TraeCnProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<TraeCnAuthExchangeResult>;
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
export declare function buildTraeCnLoginUrl(port: number, product: TraeCnProduct, machineId: string, deviceId: string, loginTraceId: string, pkce: Pick<TraeCnPkce, 'codeChallenge' | 'codeChallengeMethod'>, redirect?: string): string;
/**
 * 解析后的回调载荷（两个分支的并集）。
 *
 * `mode` 表达**本次回调走了哪条分支**，这对诊断是不可省的：两条分支的凭据
 * 完整度不同（`authCode` 分支能拿到 `BoundDeviceID`，`refreshToken` 分支不能）。
 */
export type TraeCnCallbackPayload = {
    mode: 'auth-code';
    /** `authCodeInfo.AuthCode`。 */
    authCode: string;
    /** `authCodeInfo.ExpireAt`（epoch ms），缺失为 undefined。 */
    authCodeExpireAt?: number;
    /** `userInfo.UserID`（可能为空串 —— 解析失败不阻断登录，见下）。 */
    userId: string;
    /** `userInfo.ScreenName`。 */
    nickname: string;
    /** 回调回传的 `loginTraceID`。 */
    loginTraceId: string;
} | {
    mode: 'refresh-token';
    /** 回调直接给的 refreshToken。 */
    refreshToken: string;
    /** 回调 query 里的 `userId`（该分支没有 userInfo 信封时的兜底）。 */
    userId: string;
    /** 回调回传的 `loginTraceID`（该分支可能不带）。 */
    loginTraceId: string;
};
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
export declare function parseTraeCnCallbackUrl(url: URL): TraeCnCallbackPayload | undefined;
/**
 * 从 JWT 里读出用户 ID（`user_id` / `userId` / `uid` / `sub` 依次尝试）。
 *
 * 来源优先级里它是**最后一级**：回调 `userInfo.UserID` 才是权威，JWT 声明只在
 * userInfo 缺失时兜底（兼容分支与异常回调）。
 */
export declare function readTraeCnJwtUserId(token: string): string;
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
export declare function redactTraeCnCallbackUrl(rawUrl: string): string;
/** 一次登录流程的结果。 */
export interface TraeCnLoginFlowResult {
    /** 已序列化的 `TraeCnCredential` JSON 字符串（直接存入 ctx.credentials）。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** `runTraeCnLoginFlow` 接受的选项。 */
export interface TraeCnLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 打开登录 URL 的方式；默认用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 回调等待总超时（毫秒）；默认 10 分钟。 */
    timeoutMs?: number;
    /** 外部取消信号。 */
    signal?: AbortSignal;
    /** 产品配置；默认 TRAE_CN。 */
    product?: TraeCnProduct;
    /**
     * 回调诊断钩子（收到**每条**回调时调用，参数已脱敏）。
     *
     * 用途有二：一是记录「本次回调走了哪条分支」（PKCE 还是 refreshToken），
     * 二是真机出现异常流程时留下可逐字段比对服务端行为的现场。
     * 生产侧由 `TraeCnAuth` 接到 `ctx.logger.info`。
     */
    onCallbackDebug?: (message: string) => void;
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
    port: number;
    /** 展示给用户的 portal 登录 URL（含本次随机的 machine_id / device_id / PKCE）。 */
    loginUrl: string;
    /** 等待用户在浏览器完成登录、并换取 access token。 */
    awaitCredential(): Promise<TraeCnLoginFlowResult>;
    /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
    cancel(reason?: string): void;
}
/**
 * {@link prepareTraeCnLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type TraeCnLoginPrepareOutcome = {
    ok: true;
    session: TraeCnPendingLogin;
} | {
    ok: false;
    error: 'login-in-progress';
    message: string;
};
/** {@link prepareTraeCnLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type TraeCnLoginPrepareOptions = Omit<TraeCnLoginFlowOptions, 'openBrowser'> & {
    product: TraeCnProduct;
};
/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export declare function hasActiveTraeCnLogin(): boolean;
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
export declare function completeTraeCnCallback(callbackUrl: URL, session: {
    machineId: string;
    deviceId: string;
    codeVerifier: string;
    loginTraceId: string;
    deviceName?: string;
}, product: TraeCnProduct, fetcher: typeof fetch, signal?: AbortSignal): Promise<TraeCnCredential>;
/**
 * 组装可持久化的凭据。
 *
 * `expires_at` 两级取值：优先 exchange 响应的 `TokenExpireAt`（服务端权威），
 * 缺失时由 access token 的 JWT `exp` 派生；两者都没拿到就留空 ——
 * `traeCnCredentialExpiresAtMs` 会在读取时再试一次，仍失败则「不判定过期」。
 */
export declare function buildTraeCnCredential(input: {
    accessToken: string;
    refreshToken: string;
    userId: string;
    clientId: string;
    deviceId: string;
    deviceIdSource: TraeCnDeviceIdSource;
    machineId: string;
    /**
     * 登录时生成、并原样上报给服务端的 16 位纯十进制设备号。
     *
     * 主路径与兼容分支都**能**拿到它（它就是登录 URL 里的 `device_id`）；只有
     * 「粘贴 refreshToken」这类**没有登录 URL** 的入口拿不到，那时传空串，
     * 由 {@link traeCnCheckinDeviceId} 如实降级。
     */
    checkinDeviceId?: string;
    expiresAt?: number;
    nickname?: string;
}): TraeCnCredential;
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
export declare const TRAE_CN_CALLBACK_CORS_HEADERS: Readonly<Record<string, string>>;
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
export declare function prepareTraeCnLogin(options: TraeCnLoginPrepareOptions): Promise<TraeCnLoginPrepareOutcome>;
/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等回调 → 换 access token。
 *
 * 单进程内闭环，不落状态文件。现已成为 {@link prepareTraeCnLogin} 的便捷封装，
 * 供「阻塞式」调用方使用（`TraeCnAuth.login()`、e2e 探针）；Account Hub 走的是
 * 两段式（prepare → 客户端弹窗 → awaitCredential），不经过这里。
 */
export declare function runTraeCnLoginFlow(options: TraeCnLoginFlowOptions & {
    product: TraeCnProduct;
}): Promise<TraeCnLoginFlowResult>;
//# sourceMappingURL=trae-cn-oauth.d.ts.map