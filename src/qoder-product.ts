/**
 * Qoder provider 产品配置 + 协议常量 + 凭据结构与纯函数（**两个 region**：
 * 国际版 {@link QODER} 与国内版 {@link QODER_CN}）。
 *
 * ## 两个 region 是同一份协议的两套 host
 *
 * 真机探测已确证 Qoder CN 与国际版**同协议双 region**：exchange / quota /
 * models 三个端点的错误信封逐字节同构、PAT 前缀同为 `pt-`、目录字段同构。
 * 故差异**全部收敛在 {@link QoderProduct} 的字段值**里，实现只有一份
 * （`qoder-auth` / `qoder-adapter` / `qoder-models` / `qoder-credits` 四处
 * 一律按传入的 `product` 现算）。每个字段的证据强度已在下方常量处逐条标注。
 *
 * ## 为什么本文件同时承载「配置」与「协议纯函数」
 *
 * 其它产品线是**两个文件**：`*-product.ts`（配置）+ `*.ts`（协议常量与纯函数，
 * 见 `src/lobsterai.ts` / `src/trae-cn-product.ts` 的分工说明）。Qoder 的接入
 * 计划步骤 1 只交付 `qoder-product.ts` 与 `qoder-auth.ts` 两个文件，故这里按
 * 「配置 + 凭据结构 + 无副作用的纯函数」合一；**一切网络流程都在
 * `src/qoder-auth.ts`**（本文件不 import fetch、不发请求）。
 *
 * 后续步骤若把目录 / 额度 / 错误分类拆成 `qoder-models.ts` /
 * `qoder-credits.ts` / `qoder-errors.ts`，纯函数部分可整体迁出，
 * 只要保持本文件现有的对外导出不变，调用方无需改动。
 *
 * ## 协议来源
 *
 * 全部取自 T1 / T2 / T3 三轮**真机实测**（定案摘要见
 * `docs/qoder-integration-plan.md` §0，证据链见
 * `docs/qoder-integration-research.md`）。Qoder 存在**两代协议**并存
 * （老版 `center.qoder.sh` + COSY 签名 / 新版 `openapi.qoder.sh` + 纯 Bearer），
 * 本 provider **只实现新版**，老版常量一个都不搬。
 */

// ── 端点基址 ──
//
// ⚠️ **本节的模块常量是「`QODER` 配置的取值来源」，不是消费点该 import 的东西。**
// 每条协议线都可能存在**第二个 region**（Qoder CN 与 Qoder 是两套 host、
// 账号与用量互不相通，见 `docs/qoder-integration-research.md` §8）。一旦某个
// 消费点直接 import 这里的常量，它就被钉死在**国际版**那一个 host 上，
// 而 CN 产品配置里改成别的值**不会有任何编译错误、也不会报错**——请求会
// 静默打到错误的 region（拿国际版 host 打 CN 凭据，得到的是「凭据失效」的假象）。
//
// 故取值链只有一条：**产品配置字段（`QoderProduct.openapiBase` 等）← 本节的
// 常量**，所有消费点一律走 `product.*`（`qoder-auth` / `qoder-adapter` /
// `qoder-models` / `qoder-credits` 四处均已如此）。新增消费点时请照办，
// 不要把本节的常量 import 出去。CN 的基址同理：常量名带 `_CN_` 后缀，
// 只被 `QODER_CN` 消费。
//
// ## CN 基址的证据强度（**逐个不同，不要一概而论**）
//
// | 常量 | 验证状态 |
// |---|---|
// | `QODER_CN_OPENAPI_BASE` | ✅ 真机实测 200 |
// | `QODER_CN_MODELS_BASE` | ✅ 真机实测 200 |
// | `QODER_CN_CHAT_BASE` | 🔴 **host 是官方源码值，但该路径不存在**（chat 对 PAT 结构性不可用，见该常量注释） |
// | `QODER_CN_PAT_URL` | 官方 CN 文档明写 |
// | `QODER_CN_USER_AGENT` | ⚠️ 官方源码模板 `` `qoder/${version}` ``，未实测（chat 打不通，无从 A/B） |

/**
 * OpenAPI 基址：换令牌（`jobToken/exchange`）与额度（`quota/usage`）端点。
 *
 * 与官方 SDK 文档里的 `QODER_OPENAPI_BASE_URL` 同值。
 */
export const QODER_OPENAPI_BASE = 'https://openapi.qoder.sh'

/**
 * chat 基址：OpenAI 兼容的 `/model/v1/chat/completions`。
 *
 * ⚠️ **只认 `jt-` job token**：实测把 PAT 直接当 Bearer 发过来恒 401
 * （`{"error":"unauthorized"}`），且**伪造的同长度 PAT 返回逐字节相同的 401**
 * —— 说明这是「令牌形态类」拒绝，不是「这个 PAT 不对」。
 */
export const QODER_CHAT_BASE = 'https://api2-v2.qoder.sh'

/**
 * 模型目录基址：`GET /api/v1/cloud/models`。
 *
 * ⚠️ **目录只认 PAT，额度只认 jt-**（`quota/usage` 用 PAT 打回
 * 401 `TOKEN_EXPIRE`）—— 两个端点的凭据**不同源**，不要图省事统一。
 */
export const QODER_MODELS_BASE = 'https://api.qoder.com'

/**
 * User-Agent。
 *
 * ⚠️ 这是**出站身份标识**，不是随手写的版本号：官方 CLI 与两个参考项目
 * 都发同一个实测值。它是否会像 trae-cn 的 `x-ide-version-code` 那样充当
 * 「选表键」**尚未验证**（调研待办 T8），故维持实测值不动。
 */
export const QODER_USER_AGENT = 'qoder/1.1.16'

// ── CN（国内版）基址 ──

/**
 * **CN** OpenAPI 基址：换令牌（`jobToken/exchange`）与额度（`quota/usage`）。
 *
 * ✅ 真机实测 200。
 */
export const QODER_CN_OPENAPI_BASE = 'https://openapi.qoder.com.cn'

/**
 * **CN** chat 基址 —— ⚠️ **对 CN 的 chat 这已不是端点，只是签名路径的 host**
 * （2026-09-21 接线后）。
 *
 * host 取自官方 CN CLI（`@qodercn-ai/qoderclicn@1.1.58`）的选区常量
 * `CR = _o ? "gateway.qoder.com.cn" : "api2.qoder.sh"`（`_o` 为真走 CN）——
 * 这是**官方源码值**，也是官方 chat 真正打的主机。
 *
 * ## 曾经的「结构性不可用」结论已被真机推翻（保留为历史）
 *
 * 旧记载：`/model/v1/chat/completions` 在该 host 上**不存在**（ALB 按路径级
 * 恒 503，四种头组合的 alb 错误页逐字节相同；同 host 的
 * `/api/v2/config/getDataPolicy` 却回**应用层** 401/400，证明路径活着）⇒
 * 当时判定「CN 的 chat 对 PAT 结构性不可用」。**那半段取证至今成立**（REST
 * 路径的确不存在，也不必再试）。
 *
 * ⚠️ **但结论错了**：当时认定「WASM 签名门槛需登录用户密钥，PAT 给不出」——
 * 真机 A/B 已推翻（2026-09-21）：签名身份的四要素（`uid` /
 * `security_oauth_token` / `organization_id` / `organization_tags` /
 * `data_policy_agreed`）**PAT 路径全部拿得到** —— `security_oauth_token` 就是
 * PAT 换来的 `jt-`，`uid` 从 `GET {openapiBase}/api/v1/userinfo` 取。
 * **同一请求只改 `uid` 这一处**：空串 → `{"code":"101","message":"Signature invalid"}`；
 * 真实 uid → **HTTP 200 + SSE 真内容**。⇒ **CN 的 chat 已复活**，走的是
 * `/algo/api/v2/service/pro/sse/agent_chat_generation`（见
 * `QODER_SIGNED_CHAT_PATH`），**不是**本常量拼出来的 REST 路径。
 *
 * ## 于是本常量现在的角色
 *
 * 它是**签名路径的 host 基址** —— `prepareInferRequest(hostBase, …)` 的第一参
 * 由它（经逃生阀）给出，路径与查询串由 wasm 自己拼。⚠️ **不要给它拼
 * `QODER_CHAT_PATH`**：那条路径对 CN 不存在（见上），而签名路径的正确拼法
 * 在 wasm 里（含 `?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`）。
 *
 * ⚠️ **绝不因为「打不通」就把它改成国际版 host** —— 禁令仍然成立，且理由更硬：
 * 实测**CN 的 `jt-` 打国际版 chat 会回 401**（两区令牌互不承认），于是
 * 「路径不存在」会被伪装成**「凭据失效」**，把用户引向反复重贴 PAT 的死路。
 *
 * ⚠️ 另注意它与国际版不同**不带** `-v2` 段（`api2-v2.qoder.sh` vs
 * `gateway.qoder.com.cn`）—— 不要按「同形替换」去猜。
 */
export const QODER_CN_CHAT_BASE = 'https://gateway.qoder.com.cn'

/**
 * **CN** 模型目录基址：`GET /api/v1/cloud/models`。
 *
 * ✅ 真机实测 200（14 项，**全部** `is_enabled:true`）。
 */
export const QODER_CN_MODELS_BASE = 'https://api.qoder.com.cn'

/**
 * **CN** User-Agent。
 *
 * ⚠️ **未实测**（chat 路径不存在，无从 A/B），但**形态已按官方源码校正**：
 * 官方 CN CLI 的 `openApiJsonApiRequest` 用的是模板 `` `qoder/${版本}` `` ——
 * 与 region **无关**。此前写成 `qodercn/1.1.58` 是**推断错值**（把 npm 包名
 * `@qodercn-ai/qoderclicn` 当成了产品名），已改为与国际版同形的 `qoder/<版本>`。
 * 版本号 `1.1.58` 仍取自 CN CLI 的版本（{@link QODER_CN} 的 `cosyVersion` 同源）。
 *
 * 它与 `clientType` 一样属**出站身份标识**，真机可用后若被证伪只改这一处常量。
 */
export const QODER_CN_USER_AGENT = 'qoder/1.1.58'

/**
 * **国际版** inference host（目录链与 chat 签名同一条防线的官方默认主机）。
 *
 * 取自官方 worker runtime 的选区常量 `wR`（stage-a 取证 E7/E8：
 * `_o ? "gateway.qoder.com.cn" : "api2.qoder.sh"`，且 inference 端点默认
 * `pZt = https://${wR}`）。官方按 region 选举（us → api1 / sg → api2 /
 * jp → api3），第一版用**默认 api2**（sg），真机验证若 403/404 再查 region 判定。
 *
 * ⚠️ **不是** chat 的 `QODER_CHAT_BASE`（`api2-v2.qoder.sh`）—— 两个 host
 * 长得像但不同（`-v2` 段），不要按「同形替换」去猜。CN 的 inference host 与
 * CN chat 签名是**同一个** `gateway.qoder.com.cn`（复用 {@link QoderProduct.chatBase}，
 * 见 {@link resolveQoderDirectoryEndpoint}），故本常量只有国际版用。
 */
export const QODER_INFER_HOST = 'https://api2.qoder.sh'

/**
 * 官方逃生阀环境变量：覆盖 **chat / 目录签名主机**的 host 部分。
 *
 * 语义照官方 CN CLI（本插件不发明新开关）：官方支持用该环境变量把 chat 请求
 * 指向别的主机（自建网关 / 代理 / 灰度环境）。
 *
 * ⚠️ **只影响 chat 与 wasm 目录链**：`openapiBase`（exchange / quota）与
 * `modelsBase`（PAT 目录）**不受影响** —— 官方语义就是替换模型服务主机，把
 * 另外两条控制面也一并改掉会让「只换 chat 出口」的用法直接失效（且失败形态
 * 是「凭据失效」，难诊断）。
 *
 * ⚠️ **两个 region 都生效**（不按 product 分）：它是环境级逃生阀，不是产品配置。
 */
const QODER_MODEL_SERVER_HOST_ENV = 'QODER_MODEL_SERVER_HOST'

/**
 * 应用 {@link QODER_MODEL_SERVER_HOST_ENV} 覆盖（仅 host 部分）。
 *
 * **请求时读取**（不是构造时缓存）：逃生阀的语义就是「运行时可切」——
 * 进程启动后再设环境变量也应生效，故不能像模块常量那样在 import 时定型。
 *
 * 取值按官方语义只认「主机」：`host` 或 `host:port`。额外容忍两种书写——
 * - 带 scheme（`http://host`）：**显式 scheme 优先**。这是有意的超集：裸主机名
 *   在官方语义里没有 scheme 可继承，只能沿用原基址的 `https`；而写全
 *   `http://localhost:8080` 的人几乎一定是在指向本地代理，把它悄悄升级成
 *   https 会得到一个 TLS 失败，排查方向完全跑偏。
 * - 带路径 / 查询串：**一律丢弃**。路径由各调用方决定（chat 是
 *   `QODER_CHAT_PATH`，目录链的路径在 wasm 里），否则「覆盖主机」会顺带改掉
 *   端点路径，与变量名和官方语义都不符。
 *
 * 空串 / 全空白视为**未设置**（与其它 provider 读环境变量的口径一致：
 * 空值不是有效覆盖）。
 *
 * 本函数原在 `qoder-adapter.ts`（chat 专用），设备流目录链接线后**搬进
 * product 层**：目录 host（`resolveQoderDirectoryEndpoint`）与 chat host 共用
 * 同一个逃生阀语义，而 `qoder-models.ts` 不能 import 适配器（反向依赖）。
 * `qoder-adapter.ts` 原地 re-export，既有 import 路径不变。
 *
 * @param chatBase - 默认基址（如 `product.chatBase` 或 {@link QODER_INFER_HOST}）。
 */
export function resolveQoderChatBase(chatBase: string): string {
  const raw = process.env[QODER_MODEL_SERVER_HOST_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return chatBase
  const declaredScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw.trim())?.[1]
  const withoutScheme = raw.trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? ''
  if (authority.length === 0) return chatBase
  // scheme：显式给出的优先，否则沿用原基址（逃生阀只换主机，不该顺带把 https
  // 降级成 http）。
  const scheme = declaredScheme ?? /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(chatBase)?.[1] ?? 'https'
  return `${scheme}://${authority}`
}

/**
 * 目录链的 inference host 基址（`prepareRequest` 的 endpoint 参数）。
 *
 * | region | 取值 | 依据 |
 * |---|---|---|
 * | `qoder-cn` | `product.chatBase`（gateway.qoder.com.cn） | CN 目录与 CN chat 签名是**同一个 host**（stage-a §1.2），复用既有基址不新抄字面量 |
 * | `qoder` | {@link QODER_INFER_HOST}（api2.qoder.sh） | 官方 inference 端点默认值（stage-a E8） |
 *
 * 两者都过 {@link resolveQoderChatBase}（逃生阀 `QODER_MODEL_SERVER_HOST`
 * 照 chat 侧既有约定沿用：只换 host、请求时读取、路径丢弃）。
 */
export function resolveQoderDirectoryEndpoint(product: QoderProduct): string {
  const base = product.id === 'qoder-cn' ? product.chatBase : QODER_INFER_HOST
  return resolveQoderChatBase(base)
}

// ── PAT ──

/** PAT 前缀（官方文档：`QODER_PAT="pt-your-token-here"`）。 */
export const QODER_PAT_PREFIX = 'pt-'

// ── 浏览器设备流（第二登录形态，与 PAT 并存） ──

/**
 * CLI 的 OAuth `client_id`（**两个 region 同一个**）。
 *
 * 取自官方 CLI 的 `nec()` 与桌面端 `startDeviceFlow` 解码后的常量 —— 两处
 * 同构、只有域名不同，`client_id` 是同一个。
 *
 * ⚠️ **test 环境是另一个值**（`e93fe488-5778-4c35-a6fc-0f54ed7b3139`）：
 * 本插件**不接** test 环境（接它需要先有「切环境」的开关，那是独立决策）。
 *
 * ⚠️ **桌面端另有一套 `client_id`（`732aef47-…`），不要用** —— 我们复刻的是
 * **CLI** 设备流。混用会让设备流以「应用未授权」类形态失败，而登录 URL
 * 表面上完全正常（只差一个 query 参数的值），故由单测从两个方向钉死。
 */
export const QODER_CLI_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/**
 * **国际版** 设备流授权页基址。
 *
 * 登录 URL 是 `{authBaseUrl}/device/selectAccounts?…` —— ⚠️ 它与
 * {@link QODER_OPENAPI_BASE}（`openapi.qoder.sh`）**不是同一个 host**：
 * 授权页在**主站**上，轮询才在 openapi 上。混用会让授权页 404。
 */
export const QODER_AUTH_BASE = 'https://qoder.com'

/** **CN** 设备流授权页基址（同一个路径，host 换成 `.cn`）。 */
export const QODER_CN_AUTH_BASE = 'https://qoder.cn'

/**
 * machine_id 的**产品目录**（相对 home）。
 *
 * 与官方 CLI **同路径同格式**：国际版 `~/.qoder/.auth/machine_id`、
 * CN `~/.qoder-cn/.auth/machine_id`。共用同一个文件会让「装了 CN CLI 又装
 * 国际版 CLI」的用户两边机器码互相覆盖 —— 而机器码漂移会让 wasm 签名链失效。
 */
export const QODER_MACHINE_ID_DIR = '.qoder'

/** CN 的 machine_id 产品目录。 */
export const QODER_CN_MACHINE_ID_DIR = '.qoder-cn'

/**
 * PAT 签发页（官方入口：登录 → Account → Integrations → 创建 → **立即复制**）。
 *
 * 供 Account Hub 的 Qoder 面板展示 —— 本 provider 没有浏览器登录流程，
 * 用户必须先在这个页面拿到 PAT 才能粘贴进来。
 */
export const QODER_PAT_URL = 'https://qoder.com/account/integrations'

/**
 * **CN** PAT 签发页。
 *
 * 官方 CN 文档明写 `qoder.cn/account/integrations`（与国际版同路径、不同域名）。
 * 两个 region 的 PAT **不通用**，故该 URL 必须随产品切换 —— 把用户送到国际版
 * 签发页，他拿到的 PAT 在 CN 上会被判「凭据失效」。
 */
export const QODER_CN_PAT_URL = 'https://qoder.cn/account/integrations'

// ── 端点路径 ──

/**
 * 换令牌：**PAT** → job token（`jt-`，实测 24h）。
 *
 * ⚠️ body 键名**必须** snake_case `personal_token`（camelCase 回 400
 * `{"errorCode":"BadRequest",…}`，实测）。
 *
 * ⚠️⚠️ **本端点是 PAT 专用，设备流令牌绝不能打它** —— 这是「设备流授权后
 * 换令牌 400」的根因（2026-09-21 真机报障）。两代令牌是**两个体系**：
 *
 * | 令牌族 | 前缀 | 怎么来 | 换不换 job token | 续期端点 |
 * |---|---|---|---|---|
 * | PAT | `pt-` | 用户在 Integrations 页签发 | ✅ 打本端点 | 重打本端点 |
 * | 设备令牌 | `dt-` | 浏览器设备流 poll 返回 | ❌ **它本身就是可用 Bearer** | {@link QODER_DEVICE_TOKEN_REFRESH_PATH} |
 *
 * 官方把这件事写成了显式的 `refreshStrategy` 分派（`wct()` 里 PAT →
 * `refreshStrategy:"pat"`；`Veo()` 里设备流 → `refreshStrategy:"device-token"`，
 * 且**全程不调 `exchangePersonalToken`**）。把 `dt-` 当 `personal_token` 提交，
 * 服务端回 400 `BadRequest`（把它当格式错）或 401 `personal token is invalid`
 * （研究文档 L800 实测），两条都表现为「登录失败」。
 */
export const QODER_JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange'

/**
 * 用 `jrt-` 换新 `jt-`（CLI2API 情报，**未实测**）。
 *
 * 本 provider 的 PAT 路径续期主路径是**重打 exchange**（PAT 不变，随时可重打），
 * 故这条路径只登记常量、不实现 —— 真机验收若发现 exchange 有频次限制再启用。
 */
export const QODER_JOB_TOKEN_REFRESH_PATH = '/api/v1/jobToken/refresh'

/**
 * **设备令牌**续期：`POST {openapiBase}/api/v1/deviceToken/refresh`，
 * body `{"refresh_token":"drt-…","machine_id":…}`。
 *
 * ⚠️ **这是设备流凭据唯一的续期路径，不要拿它去换 job token**。
 * 官方把两条续期路径**按令牌族分派**（`refreshStrategy` 是 `'pat'` 还是
 * `'device-token'`，见 {@link QODER_JOB_TOKEN_EXCHANGE_PATH} 的说明）：
 * PAT 重打 exchange，设备令牌打本端点。用错会得到「凭据失效」的假象。
 *
 * 取证（官方 worker runtime，两区同构）：
 * `refreshDeviceToken(A,e)` @ INTL 偏移 3984700
 * ```js
 * openApiJsonRequest({operation:"refreshDeviceToken", path:"/api/v1/deviceToken/refresh",
 *   method:"POST", body:{refresh_token:A, ...this.getMachineIdentityRequestFields(...)}})
 * ```
 * 旁证：`docs/qoder-integration-research.md` §A3（`tokens.py` 的 `drt-` 分支）。
 */
export const QODER_DEVICE_TOKEN_REFRESH_PATH = '/api/v1/deviceToken/refresh'

/**
 * 设备令牌的**兜底有效期**（30 天）。
 *
 * 仅在设备流 poll 响应里 `expires_at` 与 `expires_in` **双缺**时使用 ——
 * 实测两者都在（真机样本 `expires_in: 2591999994` ≈ 30 天，见
 * `docs/qoder-integration-research.md` L139-147），故这是纯粹的防御分支。
 * **不当作权威值**：权威值永远来自 poll 响应的 `expires_at`（ISO 绝对时刻）
 * 或 `expires_in`（相对，按官方 `rIe()` 启发式解析）。
 */
export const QODER_DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 设备令牌的**提前续期窗口**（1 小时）。
 *
 * 与 {@link QODER_JOB_TOKEN_REFRESH_LEAD_MS} 同口径（也同
 * `src/refresh.ts` 的 `REFRESH_LEAD_MS`）：卡在「名义未过期、发请求时已过期」
 * 的窗口里会让用户看到一次莫名其妙的 401。
 */
export const QODER_DEVICE_TOKEN_REFRESH_LEAD_MS = 60 * 60 * 1000

/** 额度用量（只认 `jt-`）。**步骤 4** 使用。 */
export const QODER_QUOTA_USAGE_PATH = '/api/v2/quota/usage'

/** 模型目录（只认 PAT）。**步骤 3** 使用。 */
export const QODER_MODELS_PATH = '/api/v1/cloud/models'

/** 对话（OpenAI 兼容，只认 `jt-`）。**步骤 2** 使用。 */
export const QODER_CHAT_PATH = '/model/v1/chat/completions'

// ── 超时与有效期 ──

/** 控制面请求超时（毫秒）；对话流式请求不适用。与其它 provider 同值。 */
export const QODER_REQUEST_TIMEOUT_MS = 30_000

/**
 * job token 的**提前刷新窗口**（1 小时）。
 *
 * 剩余有效期小于它时 `getJobToken()` 主动重打 exchange —— 与
 * `src/refresh.ts` 的 `REFRESH_LEAD_MS` 同口径，避免卡在「名义未过期、
 * 发请求时已过期」的窗口里。
 */
export const QODER_JOB_TOKEN_REFRESH_LEAD_MS = 60 * 60 * 1000

/**
 * job token 的兜底有效期（24 小时，实测值）。
 *
 * 仅在 exchange 响应里 `expires_in` 与 `expires_at` **双缺**时使用
 * （实测两者都在，故这是纯粹的防御分支）。**不当作权威值**：权威值永远
 * 来自响应的 `expires_in`（相对毫秒）或 `expires_at`（绝对时刻）。
 */
export const QODER_JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// ── 凭据 ref ──

/**
 * 默认单凭据 ref（无账号池时的回退）。
 *
 * 命名对齐 POSIX 标识符约定（`BUDDY_ACCESS_TOKEN` / `TRAE_CN_ACCESS_TOKEN`），
 * 并与官方环境变量 `QODER_PERSONAL_ACCESS_TOKEN` 同一语义（这里是 PAT 本体）。
 */
export const QODER_DEFAULT_CREDENTIAL_REF = 'QODER_PERSONAL_TOKEN'

/**
 * 账号池凭据 ref 前缀（`{前缀}_{SHORTID}` → `QODER_ACCOUNT_A1B2C3D4`）。
 *
 * 必须与 `src/account-hub-rpc.ts` 的 `accountCredentialRefName('qoder', id)` 同值
 * （它按 `${provider.toUpperCase()}_ACCOUNT_${suffix}` 机械派生；`qoder`
 * 无连字符，两者天然一致，有单测钉死）。
 */
export const QODER_ACCOUNT_REF_PREFIX = 'QODER_ACCOUNT'

// ── 凭据结构 ──

/**
 * 持久化的 Qoder 凭据。
 *
 * ## 为什么 PAT 存成 `access_token`（而不是计划文档里写的 `pat`）
 *
 * 计划文档 §0 把凭据字段记作 `{ pat, refreshToken, tokenExpiresAt }`，但那是
 * **camelCase 的协议字段想法**，与本仓库的**凭据存储约定**冲突，两处都会静默失效：
 *
 * 1. `AccountPool.findAccountIdByCredential`（`src/account-pool.ts`）对非
 *    codearts 的 provider **统一取 `access_token`** 作身份标识（见 AGENTS.md
 *    「选错字段会导致匹配恒失败，限流记录无法归属账号」）。字段叫 `pat` 的话，
 *    402 额度类错误的换号 / 限流记账永远匹配不到账号 —— 而且**不报错**。
 * 2. 仓库里三套凭据（`BuddyCredential` / `LobsteraiCredential` /
 *    `TraeCnCredential`）一律 snake_case（`access_token` / `refresh_token` /
 *    `expires_at`），`src/lobsterai.ts` 的模块头专门解释了原因。
 *
 * 故本实现按**代码现实**收敛为 snake_case，PAT 存进 `access_token`
 * （它确实是「访问令牌」：模型目录端点的 Bearer + 换 jt 的输入）。
 *
 * ## 三个令牌的关系（不要混）
 *
 * | 字段 | 值 | 生命周期 | 用途 |
 * |---|---|---|---|
 * | `access_token` | PAT `pt-…` | 长期（官方**不自动刷新**） | 换 jt；打模型目录 |
 * | `refresh_token` | `jrt-…` | 48h | `jobToken/refresh`（未启用，见上） |
 * | （**不落盘**） | `jt-…` | 24h | chat / quota 的 Bearer |
 *
 * ⚠️ **jt 本体刻意不落盘**：它是运行时缓存（计划 §2 决策 2），存在
 * `QoderAuth` 的进程内缓存里，键为 PAT。故 `token_expires_at` **只是元数据**
 * ——读它**不能**推断「jt 还在手上」；进程重启后缓存即冷，下次 `getJobToken()`
 * 老老实实重打一次 exchange。
 */
export interface QoderCredential {
  /**
   * PAT 本体（`pt-…`）。
   *
   * 字段名取 `access_token` 是为了满足账号池身份约定（见上方长注释），
   * **不是** chat 的 Bearer —— chat 用运行时 jt。
   */
  access_token: string
  /**
   * `jrt-` 刷新令牌（48h）。
   *
   * 可缺失（保持必填但允许空串，`isQoderRefreshable` 以长度判定），与
   * `LobsteraiCredential.refresh_token` 同约定。
   */
  refresh_token: string
  /**
   * 最近一次 exchange 拿到的 job token 的过期时刻（**毫秒时间戳字符串**）。
   *
   * 仅用于状态展示与账号池 `expiresAt`。毫秒字符串与
   * `BuddyCredential.expires_at` / `LobsteraiCredential.expires_at` 同口径。
   */
  token_expires_at?: string
  /** 服务端返回的用户 id（exchange 或 quota 响应里的 `userId`，有则存）。 */
  user_id?: string
  /** 服务端返回的用户类型（如 `personal_standard`，有则存）。 */
  user_type?: string
  /**
   * **可展示的用户名**（userinfo 的 `name`，有则存）。
   *
   * 账号卡片的昵称优先取它 —— `user_id` 是 UUIDv7，把它当昵称正是
   * 「昵称显示成一串码」的来路（见 {@link resolveQoderAccountNickname}）。
   *
   * ⚠️ **与 `user_id` 分开存**（不要合并成一个字段）：`user_id` 是签名链要的
   * 真实 uid 的一部分（空 uid 必回 `101 Signature invalid`），把它换成
   * 「好看的昵称」会让签名静默失败。
   */
  user_name?: string
  /** 用户邮箱（userinfo 的 `email`，有则存；昵称的第二档回退）。 */
  email?: string
}

/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 判断一个字符串是否是 PAT 形态（`pt-` 开头且后面还有内容）。
 *
 * 只校验**前缀**：PAT 的正文是服务端生成的，本地无权也没必要校验其字符集；
 * 前缀校验的意义是**在发请求之前**挡住「粘错东西」（粘了别家的 token、
 * 粘了 `dt-` 设备令牌、粘了半截），把网络往返换成一条可读提示。
 *
 * ⚠️ `prefix` 必须由调用方按**当前产品**传入（`product.patPrefix`），
 * 默认值只是国际版取值。理由是它与 {@link QoderAuth.loginWithPat} 的错误文案
 * 必须同源：校验用一个前缀、提示语里报另一个前缀，用户会照着**错的**前缀
 * 去重新签发 —— 而两个 region 的 PAT 不通用（§8）。
 *
 * ⚠️ 调用方**不得**把入参回显进错误信息（PAT 是凭据。
 * 见 `QoderAuth.loginWithPat` 的提示语）。
 */
export function isQoderPersonalToken(value: string, prefix: string = QODER_PAT_PREFIX): boolean {
  return value.startsWith(prefix) && value.length > prefix.length
}

/**
 * 设备令牌前缀（浏览器设备流 poll 返回的 `dt-…`）。
 *
 * 与 `pt-` 是**两个体系**（见 {@link QODER_JOB_TOKEN_EXCHANGE_PATH} 的表）。
 * 取值来源：`docs/qoder-integration-research.md` L141 的真机 poll 响应样本
 * （`"token":"dt-…"`）与 L789 的方案 B 凭据形态。
 */
export const QODER_DEVICE_TOKEN_PREFIX = 'dt-'

/**
 * 判断一个字符串是否是**设备令牌**形态（`dt-` 开头且后面还有内容）。
 *
 * 判据与 {@link isQoderPersonalToken} 同形（只校验前缀，正文由服务端生成），
 * 用途是**分派令牌族**：设备令牌直接当 Bearer 用、续期走
 * {@link QODER_DEVICE_TOKEN_REFRESH_PATH}；PAT 才需要先换 job token。
 */
export function isQoderDeviceToken(value: string, prefix: string = QODER_DEVICE_TOKEN_PREFIX): boolean {
  return value.startsWith(prefix) && value.length > prefix.length
}

/**
 * 由设备流 poll 结果组装可持久化的凭据（**登录路径**，与 PAT 路径并列）。
 *
 * 与 {@link buildQoderCredential} 的区别只在**入参类型**：设备流拿到的不是
 * job token 而是设备令牌本体，且它自带 `refresh_token` / 过期时刻。
 *
 * ⚠️ **`access_token` 存设备令牌本体**（`dt-…`）—— 与 PAT 存 `pt-…` 同一字段、
 * 同一语义（都是「可当 Bearer 的长期令牌」）。字段名不动是硬约束：
 * `AccountPool.findAccountIdByCredential` 统一取 `access_token` 作身份标识，
 * 换字段会让限流记账**静默**失配。
 */
export function buildQoderDeviceCredential(
  token: string,
  payload: QoderDeviceTokenPayload,
): QoderCredential {
  return {
    access_token: token,
    refresh_token: payload.refreshToken,
    ...payload.expiresAtMs === undefined ? {} : { token_expires_at: String(payload.expiresAtMs) },
    ...payload.userId === undefined ? {} : { user_id: payload.userId },
    // poll / refresh 响应里的 `user_name` 是可展示名（有则带）：账号卡片昵称的
    // 第一档就是它。**没带就不编造** —— 由 userinfo 那一趟补。
    ...payload.userName === undefined ? {} : { user_name: payload.userName },
  }
}

/**
 * 用设备令牌续期的结果更新旧凭据（**设备令牌族的续期路径**）。
 *
 * 与 {@link applyQoderRefresh} 同构：令牌本体保留（续期只换它的值，不换身份），
 * `refresh_token` 响应没带就沿用旧值（不能覆盖成空串 —— 那等于把凭据废掉）。
 */
export function applyQoderDeviceRefresh(
  previous: QoderCredential,
  payload: QoderDeviceTokenPayload,
): QoderCredential {
  return {
    ...previous,
    access_token: payload.token,
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    ...payload.expiresAtMs === undefined ? {} : { token_expires_at: String(payload.expiresAtMs) },
    ...payload.userId === undefined ? {} : { user_id: payload.userId },
    // 续期响应带了新 `user_name` 就取新值（响应没带则**沿用旧的** ——
    // 设备流登录时 userinfo 已经写进去过一份，覆盖成 undefined 等于白丢）。
    ...payload.userName === undefined ? {} : { user_name: payload.userName },
  }
}

/**
 * 设备流 / 设备令牌续期的令牌载荷。
 *
 * 字段名取自官方 `buildUserInfoFromDeviceToken(A)` @ INTL 偏移 4004781
 * （`A.token` / `A.refresh_token` / `A.expires_at` / `A.expires_in` /
 * `A.user_id` / `A.user_name`）与真机 poll 样本
 * （`docs/qoder-integration-research.md` L139-147）。
 */
export interface QoderDeviceTokenPayload {
  /** 设备令牌本体（`dt-…`，直接当 Bearer 用）。 */
  token: string
  /** 设备刷新令牌（`drt-…`）；缺失时为空串。 */
  refreshToken: string
  /**
   * 令牌过期时刻（毫秒）。
   *
   * **缺失即 `undefined`（不编造）**：由调用方按
   * {@link QODER_DEVICE_TOKEN_TTL_MS} 兜底。解析口径见
   * {@link resolveQoderDeviceTokenExpiresAtMs}。
   */
  expiresAtMs?: number
  /** 服务端返回的用户 id（`user_id`，有则带）。 */
  userId?: string
  /** 服务端返回的用户名（`user_name`，有则带）。 */
  userName?: string
}

/**
 * 解析设备令牌的过期时刻（毫秒）；两个字段都缺时返回 `undefined`。
 *
 * ## 取值优先级：绝对时刻优先，相对值按官方 `rIe()` 启发式
 *
 * 1. `expires_at`（ISO 8601 绝对时刻）—— 真机 poll 响应里有它，**最可靠**；
 * 2. `expires_in`（相对值）—— 官方 `rIe()` @ INTL 偏移 3946069：
 *    ```js
 *    function rIe(A){ return Math.floor(Date.now()/1e3) + (A > 86400 ? Math.floor(A/1e3) : A) }
 *    ```
 *    即 **> 86400 视为毫秒、否则视为秒**。真机 deviceToken 的
 *    `expires_in: 2591999994`（≈30 天，毫秒）正落在这个启发式的毫秒分支；
 *    而 jobToken 的 `expires_in: 86400000`（24h）同样落毫秒分支。
 *
 * ⚠️ **与官方 `buildUserInfoFromDeviceToken` 的一处刻意偏离**：那里对
 * `expires_in` **不加启发式**、直接当秒加（`floor(now/1e3)+A.expires_in`）——
 * 照抄会把真机的 `2591999994` 算成 **82 年后**，于是 `token_expires_at` 变成
 * 一个永不触发的时刻、自动续期永不武装。同一个文件里 `rIe()` 才是对的，
 * 故这里以 `rIe()` 为准（**取同一份官方源码内更自洽的那个口径**）。
 *
 * `expires_at` 与 `expires_in` 都缺 ⇒ 返回 `undefined`：**不编造**，
 * 由调用方决定兜底（`undefined` 是「未知」，不是「已过期」）。
 */
export function resolveQoderDeviceTokenExpiresAtMs(
  record: Record<string, unknown>,
  nowMs: number,
): number | undefined {
  const absolute = readString(record, 'expires_at')
  if (absolute.length > 0) {
    const parsed = Date.parse(absolute)
    if (!Number.isNaN(parsed)) return parsed
  }
  const expiresIn = readNumber(record, 'expires_in')
  if (expiresIn !== undefined && expiresIn > 0) {
    const seconds = expiresIn > 86_400 ? Math.floor(expiresIn / 1_000) : expiresIn
    return nowMs + seconds * 1_000
  }
  return undefined
}

/**
 * 解析**设备令牌**响应（poll 与 refresh 两个端点共用这一份）。
 *
 * ## 成功判据：`token` 是 string（照抄官方 `nec()` 的 poll 判据）
 *
 * 官方 @ INTL 偏移 3940912：
 * ```js
 * let e=await A.json(); if(e.token && "string"==typeof e.token) return e
 * ```
 * ⚠️ **判据是「类型是 string」，不是「非空」**（所以 `token: ""` 也**算**成功 ——
 * 上游回空串是上游的事，本地不做二次判断）。但 `token: 123` **不算**：
 * 官方用的是 `typeof`，把数字强转成字符串会让我们接受一个官方拒绝的响应，
 * 然后在下一跳以一个更难查的形态失败。故这里**不用** `readString`
 * （它会把数字转成字符串），而是显式 `typeof === 'string'`。
 *
 * ## 刻意不要求 `refresh_token` 也是 string
 *
 * 旧实现要求两者都是 string —— 那是我们发明的额外约束，**比官方严**。
 * 它会把「服务端只回了 token」这种**官方认为成功**的响应判成「还没好」，
 * 于是继续轮询到 5 分钟超时，用户看到的是「授权了但登录一直不完成」。
 * 而 `token` 本身就够用（它是可直接当 Bearer 的长期令牌，见
 * {@link QODER_JOB_TOKEN_EXCHANGE_PATH} 的表）；缺 `refresh_token` 的后果
 * 只是**不能静默续期**，那是降级、不是失败。
 *
 * ## 令牌字段三级回退
 *
 * `token` → `device_token` → `access_token`。poll 真机回 `token`
 * （`docs/qoder-integration-research.md` L141），refresh 官方读 `device_token`
 * 优先、回退 `token`。两个端点共用一份解析、三处都认，避免「续期成功但
 * 令牌没变」这类**静默**失败（字段改名后只认一个就会命中）。
 */
export function parseQoderDeviceTokenPayload(
  body: unknown,
  nowMs: number = Date.now(),
): QoderDeviceTokenPayload | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const token = readDeviceTokenString(record, 'token')
    ?? readDeviceTokenString(record, 'device_token')
    ?? readDeviceTokenString(record, 'access_token')
  if (token === undefined) return undefined
  const userId = readString(record, 'user_id') || readString(record, 'userId')
  const userName = readString(record, 'user_name') || readString(record, 'userName')
  const expiresAtMs = resolveQoderDeviceTokenExpiresAtMs(record, nowMs)
  return {
    token,
    refreshToken: readString(record, 'refresh_token'),
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
    ...userId.length > 0 ? { userId } : {},
    ...userName.length > 0 ? { userName } : {},
  }
}

/**
 * 按官方 `e.token && typeof e.token === 'string'` 口径读一个令牌字段。
 *
 * 与 {@link readString} 的区别有两点，都是为了**不发明**：
 * 1. **不做数字强转** —— 官方用 `typeof`，把 `123` 强转成 `'123'` 会让我们
 *    接受一个官方拒绝的响应，然后在下一跳以更难查的形态失败；
 * 2. **空串视为缺失** —— 官方判据里的 `e.token &&` 就是真值性检查，
 *    `''` 不满足它，官方会继续轮询。故这里返回 `undefined`（让调用方
 *    继续回退到下一个候选字段名），而不是回一个空令牌。
 */
function readDeviceTokenString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
export function parseQoderCredential(value: string): QoderCredential | undefined {
  try {
    const parsed = JSON.parse(value) as QoderCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 序列化凭据（与 {@link parseQoderCredential} 成对，集中在一处防两处口径分叉）。 */
export function serializeQoderCredential(credential: QoderCredential): string {
  return JSON.stringify(credential)
}

/**
 * 从凭据解析 `token_expires_at` 的毫秒时间戳。
 *
 * 兼容毫秒 / 秒级时间戳与 ISO 8601 三种形态（与
 * `lobsteraiCredentialExpiresAtMs` 同口径）。
 *
 * **刻意没有 JWT `exp` 兜底**（LobsterAI 有）：PAT 与 jt 都不是 JWT，
 * 解不出 `exp`；凭据里的 `token_expires_at` 是唯一来源。
 */
export function qoderCredentialExpiresAtMs(credential: QoderCredential): number | undefined {
  const raw = credential.token_expires_at
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 凭据是否可续期。
 *
 * Qoder 的判据与其它 provider **不同**：不存在「refresh_token 失效」这回事
 * —— PAT **随时可以重打 exchange**（官方明示「SDK 不会自动刷新 PAT」，
 * 但重换 job token 不需要 PAT 变化）。故只要 PAT 还在，就永远可续期；
 * 真正的失效信号来自 exchange 的 401，由 `getJobToken` / `refresh` 抛出
 * {@link RefreshTokenExpiredError}（见 `src/qoder-auth.ts`）。
 */
export function isQoderRefreshable(credential: QoderCredential): boolean {
  return credential.access_token.length > 0
}

// ── 账号卡片资料（昵称 / 有效期） ───────────────────────────────────────────
//
// 本节的四个纯函数服务**同一件事**：让账号卡片显示真实昵称与真实有效期，
// 且**不改动任何出站协议**。它们都放在产品层而不是 `qoder-auth.ts`，因为
// 「什么算占位昵称」「设备令牌的有效期怎么算」是**两区共用**的口径 ——
// 放进 auth 会让 CN / 国际版各有一份可独立漂移的副本。

/**
 * 手机号脱敏（`18939953995` → `189****3995`）。
 *
 * 对齐 buddy / lobsterai 卡片里既有的 `189****3995` 惯例
 * （`src/simple-yaml.ts` 的注释里就有这个真实数据形态）。
 *
 * **位数不足或没有足够数字时返回 `undefined`**（而不是「尽力脱敏」）：
 * 一个长度不对的串很可能不是手机号（是邮箱、是用户名），把它按手机号规则切
 * 会产出一个既不像手机号、又泄露了原文首尾的怪东西。
 *
 * 分隔符（空格 / 连字符）先剔除再判定 —— 真机上带国家码的书写很常见，
 * 但因为**只**接受「剔除分隔符后恰好 11 位数字」，带国家码（13 位）的形态
 * 仍然会被判 `undefined`，不会切出一个错位的结果。
 */
export function maskQoderMobile(raw: string): string | undefined {
  const digits = raw.replace(/[\s-]/g, '')
  if (!/^\d{11}$/.test(digits)) return undefined
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/**
 * 账号卡片昵称的取值来源（**四档回退**，顺序即优先级）。
 *
 * | 档 | 来源 | 说明 |
 * |---|---|---|
 * | 1 | `displayName` | userinfo 的 `name` —— 唯一的「真实昵称」 |
 * | 2 | `email` | 有些账号形态没有 `name` |
 * | 3 | `mobile` | **脱敏后**的手机号（`189****3995`） |
 * | 4 | `userId` | 服务端 user_id —— **与改动前逐字一致**的兜底 |
 *
 * 四档全空时用 `accountId`（账号池自己的 id）。
 *
 * ⚠️ **这不是「宁可显示点什么都行」**：第 4 档正是要修的那个形态
 * （UUIDv7 当昵称）。保留它是因为**它比空白好**，且回填链（
 * `QoderAuth.backfillAccountProfiles`）会在一轮之内把它换成真名 ——
 * 拿掉这一档会让 userinfo 挂掉时的卡片直接变成空标题。
 */
export interface QoderNicknameSource {
  /** userinfo 的 `name`（真实昵称）。 */
  displayName?: string
  /** userinfo 的 `email`。 */
  email?: string
  /** userinfo 的 `security_mobile`（**未脱敏**原文）。 */
  mobile?: string
  /** 服务端 user_id。 */
  userId?: string
}

/** 判定一个候选值是不是「有内容」（非空、非纯空白）。 */
function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 按 {@link QoderNicknameSource} 的四档回退算出账号卡片昵称。
 *
 * @param source - 身份来源；未取到资料时传 `undefined`（照样回 `accountId`）。
 * @param accountId - 账号池条目 id（最后一档）。
 */
export function resolveQoderAccountNickname(
  source: QoderNicknameSource | undefined,
  accountId: string,
): string {
  if (source !== undefined) {
    const display = nonEmpty(source.displayName)
    if (display !== undefined) return display
    const email = nonEmpty(source.email)
    if (email !== undefined) return email
    const mobile = nonEmpty(source.mobile)
    if (mobile !== undefined) {
      const masked = maskQoderMobile(mobile)
      if (masked !== undefined) return masked
    }
    const userId = nonEmpty(source.userId)
    if (userId !== undefined) return userId
  }
  return accountId
}

/**
 * UUID 形（含 32 位无连字符形态）—— 登录链写进昵称的正是那个值。
 *
 * ⚠️ **只认「完整的 UUID 串」，不做「像不像 id」的模糊判定**：模糊判定会把
 * 用户自己起的名字（如 `test-1234-5678-9012-345678901234`）当成占位，
 * 于是回填链每次跑都改一遍昵称 —— 用户手动改的名字被机器覆盖，且**不报错**。
 */
const QODER_UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

/**
 * 判定昵称是否仍是**占位形**（UUID / 空串）。
 *
 * 回填链的触发判据一半靠它，另一半靠 {@link needsQoderAccountProfileBackfill}
 * 的 expiresAt 判定。**幂等的全部依据**就在这里：一旦被改写成真名
 * （或邮箱 / 脱敏手机号），本函数立刻返回 false，回填链此后一次网都不出。
 */
export function isQoderNicknamePlaceholder(nickname: string): boolean {
  const trimmed = nickname.trim()
  if (trimmed.length === 0) return true
  return QODER_UUID_PATTERN.test(trimmed)
}

/**
 * 取账号卡片该显示的**凭据有效期**（毫秒）；无可报告的有效期时 `undefined`。
 *
 * ⚠️ **只有设备令牌族有值**，PAT 恒 `undefined` —— 这是本函数存在的全部理由。
 *
 * `QoderCredential.token_expires_at` 对 PAT 记的是 **`jt-`（运行时缓存）** 的
 * 过期时刻（24h），不是 PAT 的有效期（PAT 的过期时间本地无从得知）。把它写进
 * 账号卡片会让卡片在闲置 24h 后显示「已过期」，而实际上一次 `getJobToken()`
 * 就能自愈 —— 那是纯粹的假警报（`QoderAuth.checkExpired` 的注释同因）。
 *
 * 设备令牌族则相反：`token_expires_at` **就是**这张凭据自己的到期时刻
 * （≈30 天），是可报告的事实。
 */
export function qoderAccountExpiresAtMs(credential: QoderCredential): number | undefined {
  if (!isQoderDeviceToken(credential.access_token)) return undefined
  return qoderCredentialExpiresAtMs(credential)
}

/** {@link needsQoderAccountProfileBackfill} 读得到的账号条目最小字段集。 */
export interface QoderAccountProfileView {
  /** 账号池里的昵称（可能是登录链写下的 UUID）。 */
  nickname: string
  /**
   * 账号池里的有效期（设备令牌账号应当有）。
   *
   * ⚠️ **没有 `refreshable`**：它看着像判据，实际不是 —— 停用/不可续期的账号
   * 其凭据往往仍然有效，而卡片的昵称该修还是要修。把它收进来只会诱导后来者
   * 加一条「不可续期就跳过」的过滤，让那些账号的昵称永远是 UUID。
   */
  expiresAt?: number
}

/**
 * 判定一个账号是否需要**资料回填**（惰性回填链的触发闸门）。
 *
 * ## 为什么必须幂等（这是本函数最容易写错的地方）
 *
 * 回填链挂在**每 30 分钟的批量续期**上。若判据写成「昵称是 UUID **或**
 * 缺 expiresAt」，PAT 账号就会**永远**命中第二条 ——
 * {@link qoderAccountExpiresAtMs} 对 PAT 恒回 `undefined`，于是每个 PAT 账号
 * 每 30 分钟白打一次 exchange + userinfo，**永不停止**。
 *
 * 故两条判据各自有明确的「改过就不再触发」依据：
 * 1. 昵称占位 → 回填后是真名，`isQoderNicknamePlaceholder` 恒 false；
 * 2. 缺 expiresAt → **只对「本来就有可报告有效期」的凭据成立**
 *    （设备令牌族）；PAT 族根本没有这个值，不参与判定。
 *
 * 凭据取不到（`undefined`）时只按昵称判 —— 不回填一个没有凭据的条目。
 */
export function needsQoderAccountProfileBackfill(
  entry: QoderAccountProfileView,
  credential: QoderCredential | undefined,
): boolean {
  if (isQoderNicknamePlaceholder(entry.nickname)) return true
  if (credential === undefined) return false
  // ⚠️ 判据是「**该凭据有可报告的有效期**，而账号上还没记」——
  // 不是「账号上没记有效期」（后者对 PAT 恒真，会变成死循环）。
  if (qoderAccountExpiresAtMs(credential) === undefined) return false
  return entry.expiresAt === undefined
}

// ── exchange 响应 ──

/**
 * `jobToken/exchange` 成功响应的解析结果。
 *
 * 实测原文（2026-09-19，T1）：
 * ```json
 * {"token":"jt-…","created_at":"…","expires_at":"…","expires_in":86400000,
 *  "refresh_token":"jrt-…","refresh_token_expires_at":"…","refresh_token_expires_in":172800000}
 * ```
 * ⚠️ **`expires_in` 的单位是毫秒**（`86400000` = 24h），不是秒
 * —— 老版 deviceToken 那条线的 `expires_in: 2591999994` 也是毫秒，
 * 两条线一致。当成秒会把 24h 算成 1000 天。
 */
export interface QoderJobTokenPayload {
  /** `jt-…` job token（chat / quota 的 Bearer）。 */
  token: string
  /** `jrt-…` 刷新令牌；缺失时为空串。 */
  refreshToken: string
  /** job token 过期时刻（毫秒）；响应双缺时按 {@link QODER_JOB_TOKEN_TTL_MS} 兜底。 */
  expiresAtMs: number
  /** 用户 id（`userId` / `user_id`，有则带）。 */
  userId?: string
  /** 用户类型（`userType` / `user_type`，有则带）。 */
  userType?: string
}

/**
 * 解析 job token 的过期时刻。
 *
 * 优先级：`expires_in`（**相对毫秒**，以 `nowMs` 为基准）→ `expires_at`
 * （ISO 8601 绝对时刻）→ {@link QODER_JOB_TOKEN_TTL_MS} 兜底。
 *
 * 相对值优先于绝对值：与 `buildLobsteraiCredential` 的选择一致，
 * 且相对值不受客户端时钟偏差影响。
 */
function resolveJobTokenExpiresAtMs(record: Record<string, unknown>, nowMs: number): number {
  const expiresIn = readNumber(record, 'expires_in')
  if (expiresIn !== undefined && expiresIn > 0) return nowMs + expiresIn
  const expiresAt = readString(record, 'expires_at')
  if (expiresAt.length > 0) {
    const parsed = Date.parse(expiresAt)
    if (!Number.isNaN(parsed)) return parsed
  }
  return nowMs + QODER_JOB_TOKEN_TTL_MS
}

/**
 * 解析 exchange 成功响应。
 *
 * `nowMs` 显式传入而非在函数内取 `Date.now()`：这样本函数是纯函数、可完整
 * 单测（`expires_in` 是相对值，必须有一个确定的基准）。
 *
 * @returns 响应不是 JSON 对象时返回 undefined（缺 `token` 时返回的载荷里
 *          `token` 为空串 —— 由调用方决定这算终态还是可重试，见
 *          `exchangeQoderJobToken`）。
 */
export function parseQoderJobTokenPayload(body: unknown, nowMs: number = Date.now()): QoderJobTokenPayload | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const userId = readString(record, 'userId') || readString(record, 'user_id')
  const userType = readString(record, 'userType') || readString(record, 'user_type')
  return {
    token: readString(record, 'token'),
    refreshToken: readString(record, 'refresh_token'),
    expiresAtMs: resolveJobTokenExpiresAtMs(record, nowMs),
    ...userId.length > 0 ? { userId } : {},
    ...userType.length > 0 ? { userType } : {},
  }
}

/**
 * 由 PAT + exchange 结果组装可持久化的凭据（登录路径）。
 *
 * 与 {@link applyQoderRefresh} 分开：登录是「从零建凭据」，续期是「在旧凭据上
 * 合并」——合并必须保留 `user_id` 等身份字段，而登录没有旧值可保留。
 */
export function buildQoderCredential(pat: string, payload: QoderJobTokenPayload): QoderCredential {
  return {
    access_token: pat,
    refresh_token: payload.refreshToken,
    token_expires_at: String(payload.expiresAtMs),
    ...payload.userId === undefined ? {} : { user_id: payload.userId },
    ...payload.userType === undefined ? {} : { user_type: payload.userType },
  }
}

/**
 * 把 userinfo 的可展示资料并进凭据（**登录链与回填链共用这一处**）。
 *
 * 三条合并规则与 {@link applyQoderUserIdentity} 同构：
 * - 入参没带该字段（`undefined`）→ 沿用旧值；
 * - 与旧值相同 → 返回**原对象引用**（调用方可用 `===` 判「无需落盘」）；
 * - **不做任何出站行为**，也不碰令牌字段。
 *
 * ⚠️ `user_id` **不在**本函数职责内：它是签名要的 uid，由 exchange / quota
 * 那条线维护。这里只加「给人看」的两个字段。
 */
export function applyQoderProfile(
  credential: QoderCredential,
  profile: { displayName?: string; email?: string },
): QoderCredential {
  const userName = nonEmpty(profile.displayName)
  const email = nonEmpty(profile.email)
  if (userName === credential.user_name && email === credential.email) return credential
  return {
    ...credential,
    ...userName === undefined ? {} : { user_name: userName },
    ...email === undefined ? {} : { email },
  }
}

/**
 * 用重打 exchange 的结果更新旧凭据（续期路径）。
 *
 * **PAT 原样保留**（它不随 exchange 变化，丢了就等于把凭据废掉）；
 * `user_id` / `user_type` 优先取响应里的新值，响应没带就沿用旧值。
 */
export function applyQoderRefresh(
  previous: QoderCredential,
  payload: QoderJobTokenPayload,
): QoderCredential {
  return {
    ...previous,
    access_token: previous.access_token,
    // 响应可能不带 refresh_token（沿用旧的），不能覆盖成空串。
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    token_expires_at: String(payload.expiresAtMs),
    ...payload.userId === undefined ? {} : { user_id: payload.userId },
    ...payload.userType === undefined ? {} : { user_type: payload.userType },
  }
}

// ── 请求头 ──

/**
 * 构造无认证请求头（`jobToken/exchange` 用）。
 *
 * 只设三个头（对齐参考实现的实测头集）：`Accept` / `Content-Type` /
 * `User-Agent`。换令牌时还没有任何令牌可发，故**不带** `Authorization`。
 */
export function qoderAnonymousHeaders(product: QoderProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

/**
 * 构造 PAT 鉴权头（模型目录端点用；**步骤 3** 的消费者）。
 *
 * ⚠️ 只有目录端点认 PAT：chat 用 PAT 恒 401、quota 用 PAT 回
 * 401 `TOKEN_EXPIRE`。用错端点会得到「凭据失效」的假象。
 */
export function qoderPatHeaders(
  credential: QoderCredential,
  product: QoderProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

/**
 * 构造 job token 鉴权头（chat / quota / userinfo 用；**步骤 2 / 4** 的消费者）。
 *
 * 传入的是 {@link QoderAuth.getJobToken} 的返回值（`jt-…`），**不是** PAT。
 *
 * ⚠️ **`/sash/` 活动端点（签到）刻意不走本函数** —— 它还需要
 * `Cosy-ClientType`，见 {@link qoderCampaignHeaders}。本函数是那条约定的**基线**
 * （「不带任何 Cosy 头」），把该头加进来会同时改掉 chat / quota / userinfo 的
 * 出站形态（未验证过影响，属出站协议值红线）。
 */
export function qoderJobTokenHeaders(
  jobToken: string,
  product: QoderProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${jobToken}`,
    Accept: accept,
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

/**
 * `/sash/` 活动端点（签到）专用的 `Cosy-ClientType` 取值 —— **模块级常量，两区同值**。
 *
 * ## 为什么必须有它（2026-09-24 真机定案，缺它 ⇒ 空列表假象）
 *
 * 官方桌面端对 `GET /sash/api/v1/me/campaigns` 发的头里带
 * `Cosy-ClientType: 10`（模块级常量 `yc = Object.freeze({ clientType: 10,
 * businessProduct: "app", sessionType: "app" })`）。真机 A/B（同一账号、同一秒
 * 交错重放）：
 *
 * | 请求头 | 结果 |
 * |---|---|
 * | 本插件现状头（无任何 `Cosy-*`） | `campaigns: []`（**缺头假象**） |
 * | **仅加** `Cosy-ClientType: 10` | 列表非空，含 `CLAIM_BENEFIT/CLAIMED` |
 * | 再加 `Cosy-MachineToken`/`Type`/`Code`/`Version` | 同上（**无额外增益**） |
 *
 * 取值空间扫描：`1–7、9、11、12、20、100、0、-1、app、qodercli、空串` 全部回空
 * 列表，**只有 `8` 与 `10` 返回非空**（`8` 只见 `VIEW_DETAILS`）——`10` 是官方值。
 *
 * ## ⚠️ 与 {@link QoderProduct.clientType} 是**两回事**
 *
 * 产品配置里的 `clientType`（CN 为 `'5'`）是 **chat 请求体**的
 * `metadata.context.client_type`，实测对活动端点**无效**（真机扫描里 `5` 回空列表）。
 * 两者同名不同义、且**不同传输位置**（一个在请求头、一个在请求体），故**不复用**
 * 那个字段：合并会让「改 chat 身份值」静默改掉签到头（或反之）。
 */
export const QODER_CAMPAIGN_CLIENT_TYPE = 10

/**
 * 构造 `/sash/` 活动端点（签到）的鉴权头 —— {@link qoderJobTokenHeaders} **加上**
 * `Cosy-ClientType`。
 *
 * ## ⚠️ 作用域**只限** `/sash/` 的 campaigns 请求
 *
 * `qoderJobTokenHeaders` 被 quota / chat / userinfo / 目录等**多条**链路共用，
 * 而「加 `Cosy-ClientType` 对它们的影响」**从未验证过** —— 按「出站协议值不随
 * 实现方便而变化」的红线，**绝不能**把该头塞进 `qoderJobTokenHeaders`。
 * 故签到线走本函数、其余线一律不动（两处各有单测钉死：`qoder-checkin-credits`
 * 的「quota 请求不带该头」与 `qoder-cn-rpc-dispatch` 的「只有 `/sash/` 请求带」）。
 *
 * 消融证明 `Cosy-MachineToken` / `Cosy-MachineType` / `Cosy-MachineCode` /
 * `Cosy-Version` / `User-Agent: Qoder` **全部非必需**，故一律不发 —— 与
 * `QoderProduct.cosyVersion` 注释里「不猜机器身份」同一条纪律（缺头比错头安全）。
 *
 * @param jobToken - `jt-…`（由 `getJobToken` 换来）。
 * @param product - 决定 `User-Agent`（其余字段与 region 无关）。
 * @param accept - `Accept` 头取值。
 */
export function qoderCampaignHeaders(
  jobToken: string,
  product: QoderProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    ...qoderJobTokenHeaders(jobToken, product, accept),
    'Cosy-ClientType': String(QODER_CAMPAIGN_CLIENT_TYPE),
  }
}

// ── 产品配置 ──

/**
 * Qoder 产品配置（一份配置描述一个 region）。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` / `TraeCnProduct` 平行，字段全部为
 * Qoder 实际需要的。
 *
 * ## `serviceName` 是**可选**字段，判据是「机械派生合不合法」
 *
 * 服务名默认由产品 id 派生（`${id}Auth`）。`qoder`（无连字符）机械派生得到
 * `qoderAuth`，**本身就是合法的 JS 标识符风格**，故 {@link QODER} **刻意不声明**
 * 该字段 —— 这是 AGENTS.md「LLM Provider 约定」里钉死的**反面判据**。
 * 需要显式声明的只有 id 带连字符的产品：`trae-cn` → `traeCnAuth`、
 * `buddy-cn` → `buddyCnAuth`，以及本 region 的 `qoder-cn` → `qoderCnAuth`
 * （机械派生会得到非标识符风格的 `qoder-cnAuth`）。
 *
 * ⚠️ **判据是「派生结果合不合法」，不是「所有 provider 都得声明」**：为了
 * 「形态统一」给无连字符的产品也补一个字段，会让这条判据失去判别力。
 *
 * ## 三个出站身份字段（`clientType` / `cosyVersion` / `userAgent`）
 *
 * 它们与 buddy 的 `X-Product-Code` 同类 —— **后台按它们归因用量，一字符都不能改**。
 * 缺省语义见各字段注释。
 */
export interface QoderProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'qoder' | 'qoder-cn'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * cordis 服务名（`ctx.<serviceName>`）；**缺省时由产品 id 机械派生 `${id}Auth`**。
   *
   * 只在「机械派生结果不是合法标识符风格」时才声明（见接口头的判据）。
   */
  serviceName?: string
  /** OpenAPI 基址（换令牌 / 额度）。 */
  openapiBase: string
  /** chat 基址（OpenAI 兼容对话）。 */
  chatBase: string
  /** 模型目录基址。 */
  modelsBase: string
  /** `User-Agent` 头取值。 */
  userAgent: string
  /** PAT 前缀（`pt-`）。 */
  patPrefix: string
  /** PAT 签发页 URL（供前端展示）。 */
  patUrl: string
  /**
   * 设备流授权页基址（`{authBaseUrl}/device/selectAccounts`）。
   *
   * ⚠️ 它**不是** {@link QoderProduct.openapiBase}：授权页在主站（`qoder.com` /
   * `qoder.cn`），轮询才在 openapi 上。两区只有 host 不同、路径相同。
   */
  authBaseUrl: string
  /**
   * OAuth `client_id`。
   *
   * 两区**同一个值**（{@link QODER_CLI_CLIENT_ID}）—— 官方两区共用同一个 CLI
   * 应用。⚠️ 桌面端另有一套，不要混用（见该常量的说明）。
   *
   * 仍然做成**产品字段**而不是在实现里 import 常量：一旦某个消费点直接 import
   * 常量，它就被钉死在一个取值上，将来某区需要不同 client_id 时会**静默**打错。
   */
  clientId: string
  /**
   * machine_id 的**产品目录**（相对 home）。
   *
   * 国际版 `.qoder`、CN `.qoder-cn` —— 与官方 CLI **同路径同格式**。
   */
  machineIdDir: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 账号池凭据 ref 前缀。 */
  accountCredentialRefPrefix: string
  /**
   * chat 请求体 `metadata.context.client_type` 的取值。
   *
   * **缺省回退 `'qodercli'`**（见 {@link qoderClientType}）—— 国际版的实测可用值，
   * 故 {@link QODER} 不必显式填写、行为逐字节不变。
   *
   * CN 取 `'5'`：来自官方 CN CLI 的 `kg()` 默认值
   * `process.env.CLIENT_TYPE ?? "5"`（⚠️ **源码值，未实测**）。
   */
  clientType?: string
  /**
   * Cosy 头版本号（`Cosy-Version`）；**存在时才发 Cosy 头**。
   *
   * CN 特有：官方 CN CLI 在 chat 请求上带 `Cosy-ClientType`（= `clientType`）
   * 与 `Cosy-Version`（= CLI 版本 `1.1.58`）。国际版**不发**（现有实现实测可用），
   * 故 {@link QODER} 不填该字段 ⇒ 零头变化。
   *
   * ⚠️ **`Cosy-MachineOS` / `Cosy-MachineHostname` 刻意不实现**：官方对这两个头是
   * **条件性**发送（读到机器信息才发），本插件**不猜机器身份** —— 与其发一个
   * 编造的主机名，不如不发（缺头比错头安全：错头会被后台当真记进设备维度）。
   */
  cosyVersion?: string
}

/**
 * chat 请求体的 `metadata.context.client_type` 取值（缺省回退）。
 *
 * 单独抽成函数是让「缺省」这条语义**只有一处**：国际版
 * （{@link QODER} 不声明 `clientType`）与显式声明 `'qodercli'` 必须得到
 * **逐字节相同**的请求体，两处各写一份字符串就会在将来分叉。
 */
export function qoderClientType(product: QoderProduct): string {
  return product.clientType ?? 'qodercli'
}

/**
 * Qoder（**国际版**）provider 配置。
 *
 * 与其它五条协议线**完全不同源**：没有浏览器 OAuth，登录形态是
 * **PAT 粘贴**（PAT → exchange → jt → Bearer）。故不注册回调服务器、
 * 不做两段式登录（`account.create` 收到 PAT 后当场 exchange 验证即可返回，
 * 不存在「等用户操作 10 分钟」的窗口）。
 *
 * ⚠️ **本配置刻意不声明 `clientType`**（缺省即国际版实测值 `'qodercli'`）——
 * 与 `serviceName` 同一判据：只在「缺省不成立」时才填字段。这样国际版的
 * 出站请求体与本 region 落地前**逐字节相同**（有单测钉死）。
 */
export const QODER: QoderProduct = {
  id: 'qoder',
  displayName: 'Qoder',
  openapiBase: QODER_OPENAPI_BASE,
  chatBase: QODER_CHAT_BASE,
  modelsBase: QODER_MODELS_BASE,
  userAgent: QODER_USER_AGENT,
  patPrefix: QODER_PAT_PREFIX,
  patUrl: QODER_PAT_URL,
  authBaseUrl: QODER_AUTH_BASE,
  clientId: QODER_CLI_CLIENT_ID,
  machineIdDir: QODER_MACHINE_ID_DIR,
  defaultCredentialRef: QODER_DEFAULT_CREDENTIAL_REF,
  accountCredentialRefPrefix: QODER_ACCOUNT_REF_PREFIX,
}

/**
 * Qoder **CN（国内版）** provider 配置。
 *
 * ## 与国际版的关系：同协议、双 region
 *
 * 真机探测确证两者**同协议**：exchange / quota / models 的错误信封逐字节同构、
 * PAT 前缀同为 `pt-`、目录字段同构。故本配置不引入任何新代码路径，
 * 只是**另一组 host + 另一组出站身份值**。
 *
 * ⚠️ **两个 region 的账号、用量、PAT 互不相通**：拿国际版 host 打 CN 凭据
 * （或反之）得到的是「凭据失效」的假象。故所有基址都必须走 `product.*`。
 *
 * ## 逐字段的证据强度（不要当成同等可信）
 *
 * | 字段 | 取值 | 状态 |
 * |---|---|---|
 * | `openapiBase` | `openapi.qoder.com.cn` | ✅ 实测 200 |
 * | `modelsBase` | `api.qoder.com.cn` | ✅ 实测 200 |
 * | `chatBase` | `gateway.qoder.com.cn` | ✅ host 是官方源码值，且是**签名路径**的 host（`prepareInferRequest` 的第一参）。⚠️ 它拼出来的 `/model/v1/chat/completions` 在 CN **不存在**（ALB 恒 503）—— 适配器对 CN **不再打那条路径**，改走 `QODER_SIGNED_CHAT_PATH` |
 * | `patUrl` | `qoder.cn/account/integrations` | 官方 CN 文档明写 |
 * | `userAgent` | `qoder/1.1.58` | ⚠️ 官方源码模板 `` `qoder/${版本}` ``（与 region 无关）；版本号取自 CN CLI，未实测 |
 * | `clientType` | `"5"` | ⚠️ 源码值（CN CLI `kg()` 默认），未实测 |
 * | `cosyVersion` | `1.1.58` | 同 `userAgent` 的版本来源（CN CLI 版本）｜**签名器真的用它**（进 wasm 上下文与复用判据） |
 *
 * ## `serviceName` 必须显式声明
 *
 * id `qoder-cn` **带连字符**，`${id}Auth` 机械派生会得到非标识符风格的
 * `qoder-cnAuth` ⇒ 显式给 `qoderCnAuth`（与 `trae-cn` / `buddy-cn` 同一先例）。
 * 这正是接口头那条判据的**正面用例**（`qoder` 是反面用例）。
 *
 * ## 凭据隔离
 *
 * `QODER_CN_ACCOUNT` / `QODER_CN_PERSONAL_TOKEN` 与其它 provider 完全隔离。
 * 带连字符的 provider id 在 `src/account-hub-rpc.ts` 的 `accountCredentialRefName`
 * 里会被 `toUpperCase().replace(/-/g, '_')` 转成 `QODER_CN_ACCOUNT_*`——
 * 与本配置的前缀**逐字符一致**（该转换机制已存在，本段无需改动）。
 */
export const QODER_CN: QoderProduct = {
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  serviceName: 'qoderCnAuth',
  openapiBase: QODER_CN_OPENAPI_BASE,
  chatBase: QODER_CN_CHAT_BASE,
  modelsBase: QODER_CN_MODELS_BASE,
  userAgent: QODER_CN_USER_AGENT,
  patPrefix: QODER_PAT_PREFIX,
  patUrl: QODER_CN_PAT_URL,
  authBaseUrl: QODER_CN_AUTH_BASE,
  // 与两区共用同一个 CLI `client_id`（官方就是一个应用覆盖两个 region）。
  clientId: QODER_CLI_CLIENT_ID,
  machineIdDir: QODER_CN_MACHINE_ID_DIR,
  defaultCredentialRef: 'QODER_CN_PERSONAL_TOKEN',
  accountCredentialRefPrefix: 'QODER_CN_ACCOUNT',
  clientType: '5',
  cosyVersion: '1.1.58',
}

/** 全部 Qoder 产品配置（国际版在前，`QODER` 恒为首项）。 */
export const ALL_QODER_PRODUCTS: readonly QoderProduct[] = [QODER, QODER_CN]

/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（Buddy 系）、`lobsteraiProductById`、`traeCnProductById`
 * 分开：四者返回**不同类型**，合并成一个函数会让调用方拿到联合类型后再也
 * 不得不做类型收窄。
 */
export function qoderProductById(id: string): QoderProduct | undefined {
  return ALL_QODER_PRODUCTS.find((product) => product.id === id)
}
