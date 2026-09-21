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
 * **CN** chat 基址：OpenAI 兼容的 `/model/v1/chat/completions`。
 *
 * 🔴 **该路径在 CN 上不存在 —— 不是「未就绪」，而是结构性不可用。**
 *
 * host 本身取自官方 CN CLI（`@qodercn-ai/qoderclicn@1.1.58`）的选区常量
 * `CR = _o ? "gateway.qoder.com.cn" : "api2.qoder.sh"`（`_o` 为真走 CN）——
 * 那一半是**官方源码值**，没有问题。问题在**路径**：
 *
 * ## 二次取证定案（2026-09-21，真机矩阵 + 官方客户端佐证）
 *
 * 1. **503 是路径级的**：`/model/v1/chat/completions` 在该 host 上**不存在**。
 *    ALB 对「该路径 × 任意方法 × 任意头」恒 503（无 `Authorization`、垃圾 `jt-`、
 *    空 Bearer 四种组合返回的 alb 错误页**逐字节相同**）；同 host 的
 *    `/api/v2/config/getDataPolicy` 返回**应用层** 401/400（证明路径活着）。
 *    故与凭据、出口、host 全部无关，**也不会「恢复」**。
 * 2. **官方客户端的真实 chat 通道是另一条路径**：
 *    `/algo/api/v2/service/pro/sse/agent_chat_generation`（用户机器上 Qoder CN
 *    IDE 0.3.4 的 `qodercli.log` 实录 POST 该路径 200）。
 * 3. **该通道有 WASM 签名门槛**：官方请求由 `qoder_auth_wasm` 的
 *    `prepareInferRequest` 生成（构造需 `machineId` + `cosyVersion` +
 *    **`userInfoJson` 里的登录用户密钥**）。用有效 `jt-` 直打会得到 200 + SSE，
 *    但帧内是 `{"code":"101","message":"Signature invalid"}`。
 *    **PAT 型凭据给不出用户密钥 ⇒ PAT 形态永远过不去。**
 *
 * 结论：CN 的 chat 对**本插件的登录形态（PAT）结构性不可用**，不是待恢复的
 * 瞬时故障。国际版（{@link QODER_CHAT_BASE}）**完全正常**（同一套实现实测 200
 * 标准 OpenAI JSON），是本次取证的控制组。
 *
 * ## 为什么仍保留本常量与其路径
 *
 * 字段本身**不做改动**，理由有二：**逃生阀** {@link resolveQoderChatBase}
 * （`QODER_MODEL_SERVER_HOST`）需要一个可被覆盖的默认 host；且上游协议将来
 * 若变化（或 CN 补上 OpenAI 兼容端点），改这一处即可生效。
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
 * 换令牌：PAT → job token（`jt-`，实测 24h）。
 *
 * ⚠️ body 键名**必须** snake_case `personal_token`（camelCase 回 400
 * `{"errorCode":"BadRequest",…}`，实测）。
 */
export const QODER_JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange'

/**
 * 用 `jrt-` 换新 `jt-`（CLI2API 情报，**未实测**）。
 *
 * 本 provider 的续期主路径是**重打 exchange**（PAT 不变，随时可重打），
 * 故这条路径只登记常量、不实现 —— 真机验收若发现 exchange 有频次限制再启用。
 */
export const QODER_JOB_TOKEN_REFRESH_PATH = '/api/v1/jobToken/refresh'

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
 * 必须与 `src/jet-hub-rpc.ts` 的 `accountCredentialRefName('qoder', id)` 同值
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
 * 构造 job token 鉴权头（chat / quota 用；**步骤 2 / 4** 的消费者）。
 *
 * 传入的是 {@link QoderAuth.getJobToken} 的返回值（`jt-…`），**不是** PAT。
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
 * | `chatBase` | `gateway.qoder.com.cn` | 🔴 host 是官方源码值，但 **`/model/v1/chat/completions` 在该 host 上不存在**（ALB 恒 503）⇒ chat 对 PAT 结构性不可用，见该常量注释 |
 * | `patUrl` | `qoder.cn/account/integrations` | 官方 CN 文档明写 |
 * | `userAgent` | `qoder/1.1.58` | ⚠️ 官方源码模板 `` `qoder/${版本}` ``（与 region 无关）；版本号取自 CN CLI，未实测 |
 * | `clientType` | `"5"` | ⚠️ 源码值（CN CLI `kg()` 默认），未实测 |
 * | `cosyVersion` | `1.1.58` | 同 `userAgent` 的版本来源（CN CLI 版本） |
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
 * 带连字符的 provider id 在 `src/jet-hub-rpc.ts` 的 `accountCredentialRefName`
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
