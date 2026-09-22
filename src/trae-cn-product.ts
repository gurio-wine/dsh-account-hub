/**
 * Trae CN（字节跳动 Trae 国内版）产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * 三者是**三条互不相干的协议线**：Buddy 系走腾讯的 external-link 轮询登录 +
 * `X-Product-Code` 归属头；LobsterAI 走本地回调 + `authCode` 换 token + keyfrom
 * 身份载荷；Trae CN 走**本地回调 + PKCE（S256）+ authCode 换 token** +
 * `Cloud-IDE-JWT` 鉴权。三个类型的字段集合几乎不相交
 * （`productCode` / `apiDomain` / `userAgentByModelFamily` 对 Trae CN 全部无意义；
 * `clientSecret` / `machineId` 语义对前两者无意义），合并只会让调用方拿到联合类型
 * 后再也不得不做类型收窄。
 *
 * 因此这里定义**平行**的 `TraeCnProduct`：共用的是架构**模式**
 * （产品配置驱动、账号池、限流切换、模型黑名单），不是那个类型。
 *
 * ## 编译期常量约束（对齐 LobsterAI）
 *
 * `apiBase` / `portalBase` / `clientId` 全部是**编译期常量，不从凭据推断**。
 * 凭据里的字段是登录时的快照，跨环境迁移后会留下旧值；跟着凭据走会让请求的
 * baseURL 与身份标识自相矛盾（本插件在 `X-Domain` 上踩过同类坑，见 AGENTS.md）。
 *
 * ## 数据来源
 *
 * **登录协议已用真机校准（2026-09-17）**，三条独立证据一致：
 *
 * 1. 官方 `main.js` 源码只读提取（`loginUrlBuilder.buildLoginUrl` @1640193、
 *    `gDe()` @1426128、`exchangeTokenByAuthCode` @1430351、
 *    `_buildDeviceInfo` @1430476）；
 * 2. 本机真实**成功**登录日志
 *    `%APPDATA%\Trae CN\logs\20260917T045023\main.log:136/139/140/141`
 *    （登录 URL / 回调载荷 / exchange 请求体 / exchange 响应体，四段逐字）；
 * 3. 授权页 chunk 的行为解剖（两条流程分支、`get("client_id")` 只读 snake_case）。
 *
 * 此前「回调 query 直接携带 refreshToken、无 authCode 交换」的假设**已被整体
 * 证伪**：真机走的是 PKCE(S256) → `authCodeInfo.AuthCode` → `trae/api/v3/oauth/ExchangeToken`。
 * 「直取 refreshToken」是**同一授权页在另一个参数组合下的分支**（不带
 * `code_challenge` 时页面自己调 `GetRefreshToken`，依赖浏览器里的 trae.cn
 * Cookie 会话），本实现**保留它作为兼容分支**并记录日志，但**主路径是 PKCE**。
 * 依据见 `src/trae-cn-oauth.ts` 的模块头注释。
 *
 * ## 仍未校准的部分
 *
 * ⚠️ 本条已于 2026-09-20 更新：签到该用哪个号**已定案** —— 用**登录时注册的
 * 16 位设备号**（`TraeCnCredential.checkin_device_id`），因为活动系统按
 * `x-device-id` 认**设备**，而 exchange 返回的 `BoundDeviceID` 不被认可
 * （单变量 A/B：仅换该头即让 `did_checked_in` 由 false 翻转为 true）。
 * 仍待验证的是 **claim 级**闭环（需等次日名额重置）。见
 * `src/trae-cn-credits.ts` 的 `9074` 小节。
 */

/**
 * Trae CN 上游 API 基址（**编译期常量**）。
 *
 * 与 portal 分开成两个字段：登录页在 `www.trae.cn`，OpenAPI 在 `api.trae.cn`，
 * 两者是不同域名（实测确认），不排除未来进一步分离部署。
 *
 * ⚠️ 真机回调载荷里的 `host` 字段是 `https://api.trae.com.cn`（**`.com.cn`**），
 * 而 exchange 请求实际打到 `https://api.trae.cn`（**`.cn`**）—— 两个域名并存。
 * 本常量取**实际请求**的那个，绝不从回调载荷的 `host` 推断 baseURL
 * （与本插件「baseURL 是编译期常量」那条约定同因；回调载荷是服务端可变的
 * 声明，不是我们的配置）。
 */
export const TRAE_CN_API_BASE = 'https://api.trae.cn'

/**
 * Trae CN **IDE 网关**基址（`/api/ide/*` 专用，**编译期常量**）。
 *
 * ## 为什么必须与 {@link TRAE_CN_API_BASE} 分开（T6 真机校准，2026-09-18）
 *
 * `/api/ide/*` **不在** `api.trae.cn` 上：实测该 host 上的
 * `/api/ide/v1/ping` 回 **404**，而在本 host 上回 **200**。
 * 官方 product.json 的 `bootConfig.agent.trae.normal` 指定的就是本 host。
 * 对话（`/api/ide/v1/chat`）因此必须打到本网关 —— 原实现把它拼在
 * `api.trae.cn` 后面，是 T6 的真实错误（**路径本来就对，错的是 host**）。
 *
 * 签到 / 续期 / 余额**仍然走 `api.trae.cn`**：那三条协议线不在 IDE 网关下，
 * 换过来会 404。两个 base 不可互相替换。
 */
export const TRAE_CN_IDE_API_BASE = 'https://trae-api-cn.mchost.guru'

/**
 * IDE 网关请求头：应用 ID（`x-app-id`）。
 *
 * 实测该网关按这几个头做客户端形态校验：**缺了直接 500 / 401，带上才是 200**
 * （所以它们不是「可选的遥测字段」，而是请求能否成立的一部分）。
 * 取自官方 product.json（公开标识，非机密）。
 */
export const TRAE_CN_IDE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * **IDE 网关代际**的客户端版本号（`x-ide-version-code` / `x-app-version-code`）。
 *
 * ⚠️ **必须是纯数字**：真机实测发 `"3.3.100"` 会被网关 **400** 拒掉，
 * 发 `"107"` 才是 200。注意它与 {@link TRAE_CN_IDE_VERSION}（`3.3.100`，
 * 登录 URL 的 `x_app_version`）**不是一个号**，也不可互换 ——
 * 一个进 URL/请求体，一个进网关头，形态要求还不同。
 *
 * ## ⚠️ SOLO 通道**不再使用本常量**（2026-09-19 二次取证定案）
 *
 * chat 与目录都已迁到 SOLO 通道，而 **SOLO 网关按 `x-ide-version-code` 选模型
 * 配置表**：发 `107`（本常量，IDE 网关代际）选出的是**空表**，于是**任何模型**
 * 都恒回 `4001 param is invalid` —— 这正是 `bedd149` 迁移后 chat 全败的根因。
 * SOLO 通道改用日期式的 {@link TRAE_CN_SOLO_VERSION_CODE}（`20260820`）。
 *
 * **两者同名不同物，不可合并、不可互相替换**：它们不是同一个号的两种写法，
 * 而是**两个网关代际各自的版本码**。本常量保留，是为了让「107 从哪来」有据可查
 * （它仍是 IDE 网关代际的正确取值），并防止后来者把两者「顺手统一」。
 */
export const TRAE_CN_IDE_VERSION_CODE = '107'

/**
 * **IDE 网关代际**的 `x-ide-version`（形如 `1.107.1`）。
 *
 * 与 {@link TRAE_CN_IDE_VERSION}（`3.3.100`）同名不同物，故本常量**刻意不叫**
 * `TRAE_CN_IDE_VERSION` —— 那个名字已被登录协议的 IDE 版本占用（真机 main.log
 * 逐字），改它会牵动登录 URL / `DeviceInfo.ClientVersion` / exchange body 三处。
 *
 * ⚠️ 与 {@link TRAE_CN_IDE_VERSION_CODE} 同理，**SOLO 通道不再发本值**：
 * SOLO 代际的对应取值是 {@link TRAE_CN_SOLO_IDE_VERSION}（`0.1.61`）。
 */
export const TRAE_CN_IDE_GATEWAY_VERSION = '1.107.1'

/**
 * **SOLO 代际**的版本码（`x-ide-version-code` / `x-app-version-code`）。
 *
 * ## 为什么必须与 {@link TRAE_CN_IDE_VERSION_CODE}（`107`）分开
 *
 * 两者**同名不同物**：一个是 **IDE 网关代际**的版本码，一个是 **SOLO 代际**的。
 * 它们在同一个请求头上，但**语义与值域都不同**，合并成一个是错的。
 *
 * ## SOLO 网关按本头选模型配置表（4001 的根因，真机 A/B 已定案）
 *
 * SOLO 网关用 `x-ide-version-code` **决定上游返回哪张模型配置表**。发 IDE 代际的
 * `107` 时，网关选出的是一张**空表** —— 后果不是「某个模型不可用」，而是
 * **任何模型**都回 `4001 param is invalid`（迁移后 chat 全败的真因）。
 * 历史旁证：第三方实现（traework2api 的 `constants.ts`）早有注释记着同一现象
 * （「version-code 决定上游返回哪张模型配置表……拿 `20260716` 直接调 `glm-5.3`
 * 会 4001」），而 `bedd149` 当时假设「版本头维持现状即可」是**错的**。
 *
 * ## 值域：必须是 8 位日期式 `YYYYMMDD`（目录端点值扫描）
 *
 * 对目录端点扫描 `x-ide-version-code` 的取值空间得到：**只有 8 位日期式**才命中
 * 有内容的配置表；`20260801` 起表已满 **41 项**，取证当日（`20260919`）同为 41 项。
 * 故本值取**实机验证过的成功组合**中的 `20260820`。
 *
 * ⚠️ **只认本头**：`x-app-version-code` 与选表无关（已隔离验证），但本实现让它
 * 与本常量**同代际**（同发 `20260820`），避免两个版本头自相矛盾。
 */
export const TRAE_CN_SOLO_VERSION_CODE = '20260820'

/**
 * **SOLO 代际**的 `x-ide-version`（`0.1.61`）。
 *
 * 与 {@link TRAE_CN_SOLO_VERSION_CODE} 同属 SOLO 代际，须**成对使用**：实机验证
 * 过的成功组合是
 * `x-ide-version-code: 20260820` + `x-ide-version: 0.1.61` + `User-Agent: Trae/0.1.61`。
 * 单独换其中一个不保证仍命中同一张配置表。
 *
 * 形态上它与 IDE 代际的 `1.107.1` 也不同：SOLO 代际是 `0.1.x` 三段式。
 */
export const TRAE_CN_SOLO_IDE_VERSION = '0.1.61'

/** IDE 网关请求头：版本通道（`x-ide-version-type`，真机 `stable`）。 */
export const TRAE_CN_IDE_VERSION_TYPE = 'stable'

/**
 * 网关请求头：流量类型（`request-traffic-type`）。
 *
 * 旧 IDE 通道实测为 `normal`，**SOLO 通道实测为 `prod`**（2026-09-19 迁移取证，
 * 与第三方可用实现一致）。两者是同一个头的两种取值，端点换了就跟着换 ——
 * 留着 `normal` 是「旧通道的残留值」，而不是一个可选项。
 */
export const TRAE_CN_REQUEST_TRAFFIC_TYPE = 'prod'

/**
 * 网关请求头：`User-Agent` 的**形态前缀**。
 *
 * SOLO 通道实测值为 **`Trae/<appVersion>`**（客户端形态标识），不是浏览器 UA，
 * 也不是旧 IDE 通道的 `TraeClient/TTNet` —— 那是旧通道的值，端点迁移后一并换掉
 * （两个通道的 UA 形态本就不同）。
 *
 * 完整值由 `src/trae-cn-models.ts` 的 `TRAE_CN_SOLO_USER_AGENT` 拼接给出：
 * 那里能拿到 `TRAE_CN_APP_VERSION`（`3.3.102`，与签到头同源），而本模块若反过来
 * import credits 会形成 `product → credits → product` 的循环依赖。
 * 故这里只留**前缀**（形态本身），版本号由 models 模块补上。
 */
export const TRAE_CN_USER_AGENT_PREFIX = 'Trae/'

/** Trae CN 登录门户基址（**编译期常量**）。 */
export const TRAE_CN_PORTAL_BASE = 'https://www.trae.cn'

/**
 * OAuth 客户端 ID。
 *
 * 取自 Trae CN 桌面客户端的内置值（公开标识，非机密）。它同时是：
 * - 登录 URL 的 **`client_id`** query 参数（**snake_case**）；
 * - 两个 `ExchangeToken` 端点的请求体字段 **`ClientID`**（**PascalCase**）。
 *
 * ## ⚠️ 两侧拼写方向相反，写错就是「认证中」卡死（真机根因，2026-09-17）
 *
 * | 位置 | 形态 | 举证 |
 * |---|---|---|
 * | 登录 URL query | `client_id`（snake_case） | 真机 main.log:136 逐字 |
 * | 授权页读取 | `get("client_id")` —— 读不到 `clientID` | 授权页源码 |
 * | JSON body | `ClientID`（PascalCase） | main.log:140 逐字 |
 *
 * 本文件曾把这条注释写反（「URL 用 `clientID`」），而它正是那次登录失败的
 * **思想源头**：授权页拿不到 `client_id` 后既不报错也不回调，页面停在
 * 「认证中」，从外部看完全像网络问题。故这里显式写死两个方向防回归 ——
 * `tests/unit/trae-cn-oauth.spec.ts` 另有逐项断言锁住两侧拼写。
 */
export const TRAE_CN_CLIENT_ID = 'ono9krqynydwx5'

/**
 * OAuth 客户端密钥。
 *
 * 实测值为占位串 `"-"`：服务端**不校验**该字段。仅用于**续期**端点
 * （`cloudide/api/v3/trae/oauth/ExchangeToken`，body 含 `ClientSecret`）；
 * 登录的 authCode 交换端点 body **不含**该字段。
 * 照抄原值而非留空 —— 空串可能被服务端当成「缺字段」而拒绝，
 * 而 `"-"` 是客户端实际发送的值。
 */
export const TRAE_CN_CLIENT_SECRET = '-'

/**
 * `ExchangeToken` 端点路径 —— **续期**（`RefreshToken` + `UserID`）。
 *
 * 全路径 `https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`。
 * 这是 REFRESH_CONTRACT.cn 的实测形态：用 `RefreshToken` + `UserID` 换新
 * access token（JWT）。
 *
 * ⚠️ **与登录时的 authCode 交换不是同一个端点**（路径首段不同：本端点
 * `cloudide/api/…`，登录端点 `trae/api/…`）。两者在服务端**并存**，
 * 见 {@link TRAE_CN_AUTH_EXCHANGE_PATH}。混用会让登录/续期之一 404。
 */
export const TRAE_CN_EXCHANGE_TOKEN_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/**
 * `ExchangeToken` 端点路径 —— **登录后的 AuthCode 交换**（PKCE 流程第二步）。
 *
 * 全路径 `https://api.trae.cn/trae/api/v3/oauth/ExchangeToken`，真机实测
 * （main.log:140 的 `[exchangeTokenByAuthCode] request`）逐字确认。
 *
 * body 五字段：`{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}` ——
 * **没有** `ClientSecret`、**没有** `DeviceProof`（那两者属于 `cloudide/api/…`
 * 那条续期路径）。
 */
export const TRAE_CN_AUTH_EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken'

/**
 * 登录回调路径。
 *
 * 登录 URL 的 `auth_callback_url` 为 `http://127.0.0.1:{port}/authorize`，
 * 故本地 loopback 服务器只接受这个路径的回调。
 *
 * ✅ **已用真机日志校准（T5，2026-09-17 main.log:136）**：回调路径与
 * `auth_callback_url` 形态均与实测一致，不再是假设。
 */
export const TRAE_CN_CALLBACK_PATH = '/authorize'

/**
 * 登录 URL 上的客户端流程常量（**全部取自真机** main.log:136 逐字）。
 *
 * ## 为什么这四个字面量值得做成常量
 *
 * 它们的共同点是「服务端/授权页按存在性判流程分支，缺失时的表现是**静默**的」：
 * 页面既不报错也不回调，只在首屏显示「认证中」。少任何一个都无法从错误信息
 * 反推原因 —— 这就是本 provider 首次真机登录失败的机型（见 {@link TRAE_CN_CLIENT_ID}）。
 *
 * - {@link TRAE_CN_LOGIN_VERSION}：登录协议版本（授权页据此选解析分支）；
 * - {@link TRAE_CN_LOGIN_AUTH_FROM}：来源标识，真机 `trae`（SOLO 形态为 `solo`，
 *   本 provider 只走 `trae`）；
 * - {@link TRAE_CN_LOGIN_CHANNEL}：`native_ide` —— 声明「本地 IDE 回调」这一
 *   登录通道，授权页据此决定**是否**调 `GetRefreshToken` 与投递何种载荷；
 * - {@link TRAE_CN_LOGIN_AUTH_TYPE}：`local` —— **缺它是失败的直接原因**：
 *   授权页认不出本地回调模式便一直停在「认证中」。
 */
export const TRAE_CN_LOGIN_VERSION = '1'
/** 登录 URL 的 `auth_from`（真机 `trae`；SOLO 形态的 `solo` 不适用本 provider）。 */
export const TRAE_CN_LOGIN_AUTH_FROM = 'trae'
/** 登录 URL 的 `login_channel`（真机 `native_ide`）。 */
export const TRAE_CN_LOGIN_CHANNEL = 'native_ide'
/** 登录 URL 的 `auth_type`（真机 `local`；缺失时授权页停在「认证中」）。 */
export const TRAE_CN_LOGIN_AUTH_TYPE = 'local'
/**
 * 插件版本（登录 URL 的 `plugin_version`）。
 *
 * 取自本机客户端 `main.js` 尾部 sourcemap 注释
 * （`/stable/2.3.83560/win32/x64/main.js.map`）与真机 main.log:136，
 * 两处一致。官方实现取的是 `productService.tronBuildVersion` ——
 * 即**客户端插件版本**，与 {@link TRAE_CN_IDE_VERSION} 是两个不同的号。
 */
export const TRAE_CN_PLUGIN_VERSION = '2.3.83560'
/**
 * IDE 版本（登录 URL 的 `x_app_version`，也是 `DeviceInfo.ClientVersion`
 * 与 exchange body 的 `IDEVersion`）。
 *
 * 真机值与签到设备头的 `x-app-version` 相同（均为 `3.3.100`），
 * 故本常量与 `TRAE_CN_APP_VERSION` 同值；**刻意分成两个常量**，
 * 因为它们是两条独立的协议线（登录 URL / 签到头），任一变动不应牵动另一个。
 */
export const TRAE_CN_IDE_VERSION = '3.3.100'
/** 登录 URL 的 `x_app_type`（真机 `stable`）。 */
export const TRAE_CN_APP_TYPE = 'stable'
/**
 * 登录 URL 的 `channel_name`（真机 `common`）。
 *
 * 官方实现在 `productService.channelName` 存在时才追加；本 provider 恒发 `common`
 * （真机实测值），不做条件分支 —— 少一个参数就多一种静默失败形态。
 */
export const TRAE_CN_CHANNEL_NAME = 'common'
/**
 * `redirect` 参数值（真机 `0`）。
 *
 * 官方实现是 `redirect || 0`，即「未指定时填 0」。本 provider 无重定向需求，
 * 恒为 `0`。
 */
export const TRAE_CN_LOGIN_REDIRECT = '0'
/**
 * 登录**成功回调**回跳时用的 `redirect` 值（官方 `1`）。
 *
 * ## 来源（本机官方客户端逐字提取，非发明）
 *
 * `%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\main.js` 的
 * `updateLocalCredential` 函数里，成功分支调用
 * `s()`（无参）→ `getLoginUrl(t, await this.server.getPort(), 1, …)` →
 * `buildLoginUrl` 里 `redirect=${r||0}`；随后 `i.writeHead(307,{Location:a}),i.end()`
 * —— 即**用同一条授权页 URL 构造器、把 `redirect` 换成 `1`**，再 307 回跳。
 *
 * 失败分支走 `s(errorCode, errorMsg)`，同样 307（本插件失败路径维持 500，
 * 见 `trae-cn-oauth.ts` 回调处理器的说明）。
 *
 * ## 为什么必须有这一跳
 *
 * 回调页停在 `127.0.0.1:{port}`，自身无法离开（静态 HTML 没有 `window.close()`）。
 * 弹窗被拦截、用户走面板内 `<a target="_blank">` 手动链接时，客户端**没有窗口
 * 引用**，`closeLoginWindow()` 够不到那张标签页 —— 307 回跳是唯一能让它离开
 * loopback 的机制（官方同款）。授权页收到 `redirect=1` 后渲染「登录成功」结果页。
 */
export const TRAE_CN_LOGIN_REDIRECT_CALLBACK = '1'
/**
 * `DeviceInfo.PlatformCode` —— 真机 `IDE_PC`（官方实现按 SOLO/IDE 二分，
 * 本 provider 恒为 IDE 形态）。
 */
export const TRAE_CN_PLATFORM_CODE = 'IDE_PC'
/**
 * `DeviceInfo.DeviceType` —— 真机字面量 `PC`。
 */
export const TRAE_CN_DEVICE_TYPE_PC = 'PC'
/**
 * 登录 URL 的 `x_device_type` / `DeviceInfo.OSInfo` —— 真机值 `windows`。
 *
 * 与 `TRAE_CN_DEVICE_TYPE`（签到头的 `x-device-type`）同值但**刻意分开**：
 * 两条协议线的取值来源不同，任一侧调整都不该牵动另一侧。
 */
export const TRAE_CN_LOGIN_OS_INFO = 'windows'
/**
 * 登录 URL 的 `x_os_version` / `DeviceInfo.OSVersion` —— 真机逐字值
 * `Windows 10 Home`（该机器上 `getSystemInformation().osVersion` 的输出）。
 *
 * ⚠️ 这是**真机取值**而非发明：官方实现取系统信息，本插件无法等价获取，
 * 故采「客户端形态伪装」常量（与签到头的 `TRAE_CN_OS_VERSION` 同一约定）。
 * 注意两者形态不同：这里是**市场营销名**（`Windows 10 Home`），
 * 签到头用的是**构建号**（`Windows 10.0.22631`）—— 别互相替换。
 */
export const TRAE_CN_LOGIN_OS_VERSION = 'Windows 10 Home'

/** 登录页授权端点路径（拼在 `portalBase` 之后）。 */
export const TRAE_CN_AUTHORIZATION_PATH = '/authorization'

/**
 * chat（流式对话）端点**路径**（拼在 {@link TRAE_CN_IDE_API_BASE} 之后）。
 *
 * ## ✅ 2026-09-19 迁移：SOLO 通道 `/api/agent/v3/llm_utils_chat`
 *
 * 旧值 `/api/ide/v1/chat` 是**旧 aiserver 通道**：它的 `llm_raw_chat` 场景只认
 * 5 项旧池，我方请求（`glm-5.3` 等新池模型）**恒回 `3003 all models failed`**，
 * 历史零成功。真实客户端的新池聊天走的是
 * 「AhaRpc → ai-agent 子进程 → `harness.dll` → 原生出网」五段链路，
 * 第三方无法复刻；而 **SOLO 通道已用我方凭据实测走通**
 * （`glm-5.2` 流式正常、`glm-5.3` + tools 结构化调用全绿，HTTP 200 SSE）。
 *
 * host **不变**（仍是 {@link TRAE_CN_IDE_API_BASE}），凭据不变，
 * 决定成败的是**端点 + body 的 `config_name` / `function` 两字段**
 * （头集合差异已排除：网关对多余头宽容）。
 *
 * 因此旧的 `TRAE_CN_CHAT_PATH_CANDIDATES` 候选表已**删除**：它记录的是
 * 「路径 vs host」那次误判的留痕，与本次迁移无关，留着只会让人以为
 * `/api/ide/v1/*` 仍是可选路径（它们对新池全部无效）。
 */
export const TRAE_CN_CHAT_PATH = '/api/agent/v3/llm_utils_chat'

/**
 * 模型目录端点路径（**SOLO 通道的目录，已接线**）。
 *
 * ## 为什么这次能接（推翻 2026-09-18 的「远端不可接」结论）
 *
 * 旧结论「新池在任何 HTTP 端点都拿不到」是**对的，但试错了端点**：
 * `model_list` 只回 6 项旧池、`batch_get_detail_param` 只回 4 个 seed 配置。
 * 真正可用的是**本端点**，且必须**按 `function` 分别拉取后取并集** ——
 * roster 被 Trae 摊在多个 SOLO function 下（`glm-5.3` 只在 `solo_work_remote`）。
 *
 * 请求体固定字段见 `src/trae-cn-models.ts` 的 `TRAE_CN_DIRECTORY_BODY`；
 * 解析与合并见 `parseTraeCnDirectory` / `mergeTraeCnDirectory`。
 */
export const TRAE_CN_MODELS_PATH = '/api/ide/v1/get_detail_param'

/**
 * **agent 池目录**基址（`GET /api/remote/v1/models`，**编译期常量**）。
 *
 * ## 为什么本 provider 需要第二个目录端点
 *
 * IDE 目录端点（{@link TRAE_CN_MODELS_PATH}）自 2026-09-21 起**对可调模型不再
 * 下发 `context_window_tokens.max`**（只剩 `custom_model_*` BYOK 项带 max，而那
 * 14 项被账号私有 BYOK 过滤网剔除）⇒ 档位列在真机上**无数据可渲染**，
 * `07dde5d` 建好的 dev/Max 档位链路（解析 → RPC → UI → `resolveModel` 覆盖）
 * 空转。本端点是**同一批上游数据**的另一面：它按 agent 分组列出各模型的
 * `max_mode` 与 `context_window_tokens.max`（真机实测 `solo_agent_remote` 组
 * 10 个 id 为 `max_mode:true` + `max:1000000`）。
 *
 * ⚠️ 档位**只用来补 `maxContextWindow`**（一个纯声明值，出站请求体一个字段都
 * 不动）；模型 roster 仍以 IDE 目录为唯一来源 —— 本组独有的 id（如
 * `Doubao-Seed-Code`）**必须被忽略**，加进选择器就是必然 `4001` 的选项。
 *
 * ## ⚠️ 本 host 是第三个 Trae CN 域名，不可与另外两个互换
 *
 * | 常量 | 值 | 归属 |
 * |---|---|---|
 * | {@link TRAE_CN_API_BASE} | `api.trae.cn` | 签到 / 续期 / 余额 |
 * | {@link TRAE_CN_IDE_API_BASE} | `trae-api-cn.mchost.guru` | SOLO 通道 chat 与 IDE 目录 |
 * | **本常量** | **`solo.trae.cn`** | **agent 池目录（档位数据源）** |
 *
 * ⚠️ 它与 `work.trae.cn` 上的同名路径（`/api/remote/v1/models`）**不是同一个
 * 服务**：Work 侧那条要带 `?functions=…&show_custom_model=true` 并且必须带
 * SOLO 网关头；本侧实测**头只需 5 个**（oauth 模块的 `traeCnAccessHeaders`：
 * 三个等值 token 头 + `Accept` + `Content-Type`），多带 SOLO 网关头**不需要**。
 */
export const TRAE_CN_AGENT_MODELS_API_BASE = 'https://solo.trae.cn'

/**
 * agent 池目录路径（拼在 {@link TRAE_CN_AGENT_MODELS_API_BASE} 之后）。
 *
 * 响应形态 `{data:{list:[{function, models:[…]}]}}` —— 与 TraeWork 的同名端点
 * **逐字段同构**（两条协议线各自独立解析，见 `src/trae-cn-models.ts` 的
 * `parseTraeCnAgentTiers`）。
 */
export const TRAE_CN_AGENT_MODELS_PATH = '/api/remote/v1/models'

/**
 * agent 池目录的 `functions` 参数值 —— **必须是 agent 池，不是 IDE 池**。
 *
 * 该端点的分组由 query 决定：不带 `functions` 时回的是**另一个池**
 * （实测为 `solo_coder`，同名 id 的窗口都不同）。本 provider 取
 * `solo_agent_remote`，因为只有它的 `max_mode` / `context_window_tokens.max`
 * 被实测证明与 IDE 侧那 10 个 id 对得上（2026-09-21 真机核对）。
 */
export const TRAE_CN_AGENT_MODELS_FUNCTIONS = 'solo_agent_remote'

/**
 * agent 池目录的 query 串。
 *
 * ⚠️ **刻意不带 `show_custom_model=true`**：那会把账号私有 BYOK 项
 * （`custom_model_*`，三方 key 存在该账号服务端）一起拉回来，而它们在本侧
 * 全被过滤网剔除、对档位毫无用处。真机实测配方就是本串。
 */
export const TRAE_CN_AGENT_MODELS_QUERY = `?functions=${TRAE_CN_AGENT_MODELS_FUNCTIONS}`

/** 控制面请求超时（毫秒）；流式对话请求不适用。 */
export const TRAE_CN_REQUEST_TIMEOUT_MS = 30_000

/** 登录流程总超时（毫秒）；与 LobsterAI / CodeArts 的 10 分钟窗口一致。 */
export const TRAE_CN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 凭据对象里持久化的设备号来源标记（诊断用，不影响鉴权）。
 *
 * ## 值域已按真机证据收敛（2026-09-17）
 *
 * `device_id` 的来源**已经查清**：它是登录 exchange 响应的
 * `Result.BoundDeviceID`（真机 `wl2k1e2endpp32`，14 位小写字母+数字）。
 * 这**不是**客户端上报的 `DeviceID`（16 位十进制）或 `MachineID`（64 hex）
 * 的回显 —— 服务端新发了一个绑定标识，`DeviceBindStatus: "BOUND"` 与之配套。
 *
 * 故旧的 `machine-id-fallback` 降级路径已**删除**：登录 URL 里的 `device_id`
 * 是我们随机生成的临时值（仅参与登录握手与风控形态校验），把它折算成设备号
 * 存进凭据是**伪造设备身份**，比缺字段更坏 —— 缺字段至少能被发现。
 *
 * ## ⚠️ 本标记只描述 `device_id`，与签到设备号无关（2026-09-20 修正）
 *
 * 2026-09-20 单变量 A/B 定案：活动系统按 `x-device-id` 认**设备**，而
 * `BoundDeviceID` **不被认可**（仅换成官方 16 位号即让 `did_checked_in` 由
 * false 翻转为 true）。故签到头已改用**登录时注册的 16 位号**
 * （`TraeCnCredential.checkin_device_id`，见 `src/trae-cn-oauth.ts` 的
 * `traeCnCheckinDeviceId`）。
 *
 * 本类型**不**为那个字段扩展取值：`checkin_device_id` 是「登录 URL 的
 * `device_id` 原样落盘」，来源没有分叉，加一个恒为同一个值的标记只是噪声。
 *
 * @see TraeCnDeviceIdSource
 */
export type TraeCnDeviceIdSource = 'exchange-bound-device-id'

/**
 * Trae CN 产品配置。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` 平行，字段全部为 Trae CN 实际需要的。
 */
export interface TraeCnProduct {
  /**
   * provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。
   *
   * **带连字符**：对齐用户与生态的叫法（`dsh-connect-trae` 等插件同样用
   * `trae-cn`）。注意它同时被 `jet-hub-rpc` 用来拼凭据 ref 前缀
   * （`${provider.toUpperCase()}_ACCOUNT_XXX` → `TRAE_CN_ACCOUNT_XXX`），
   * 这是**合法**的（连字符经 toUpperCase 后由 `_` 承接，
   * 见 `src/trae-cn-oauth.ts` 的 `traeCnAccountRefPrefix`）。
   *
   * 但它**不能**直接用来派生 cordis 服务名（`trae-cnAuth` 不是合法的 JS
   * 标识符风格），故服务名由 {@link TraeCnProduct.serviceName} **显式指定**。
   * 详见 `src/trae-cn-auth.ts` 的 `TraeCnAuthOptions.serviceName`。
   */
  id: 'trae-cn'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * cordis 服务名（`ctx.<serviceName>`）。
   *
   * **刻意不用 `${product.id}Auth` 机械派生**：产品 id 为 `trae-cn`，
   * 机械派生会得到 `trae-cnAuth` —— 带连字符的属性名虽在 JS 里合法，
   * 但与 `buddyCnAuth` / `buddyAuth` / `lobsteraiAuth` / `codeartsAuth`
   * 四个既有两个单词驼峰名风格不一致，且无法用点号语法访问
   * （必须写 `ctx['trae-cnAuth']`）。这里显式声明 `traeCnAuth`，
   * 让「用户可见的 provider 名」与「代码里的服务标识符」各自取合适的形态。
   */
  serviceName: string
  /** 登录门户基址（不含授权路径）。 */
  portalBase: string
  /** 上游 API 基址（不含路径）。 */
  apiBase: string
  /** OAuth 客户端 ID。 */
  clientId: string
  /** OAuth 客户端密钥（实测为占位串 `"-"`）。 */
  clientSecret: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 账号池凭据 ref 前缀（`{前缀}_{SUFFIX}`）。 */
  accountCredentialRefPrefix: string
}

/**
 * Trae CN provider 配置。
 *
 * 登录方式与腾讯系、LobsterAI 都不同：**两段式 loopback 回调 + PKCE(S256)**，
 * 回调投递 `authCodeInfo`（AuthCode 模式），再由本插件调
 * `trae/api/v3/oauth/ExchangeToken` 换 token。
 */
export const TRAE_CN: TraeCnProduct = {
  id: 'trae-cn',
  displayName: 'Trae CN',
  serviceName: 'traeCnAuth',
  portalBase: TRAE_CN_PORTAL_BASE,
  apiBase: TRAE_CN_API_BASE,
  clientId: TRAE_CN_CLIENT_ID,
  clientSecret: TRAE_CN_CLIENT_SECRET,
  defaultCredentialRef: 'TRAE_CN_ACCESS_TOKEN',
  accountCredentialRefPrefix: 'TRAE_CN_ACCOUNT',
}

/** 全部 Trae CN 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_TRAE_CN_PRODUCTS: readonly TraeCnProduct[] = [TRAE_CN]

/**
 * 按 provider id 取 Trae CN 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（Buddy 系）、`lobsteraiProductById` 分开：三者返回
 * **不同类型**，合并成一个函数会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function traeCnProductById(id: string): TraeCnProduct | undefined {
  return ALL_TRAE_CN_PRODUCTS.find((product) => product.id === id)
}
