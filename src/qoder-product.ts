/**
 * Qoder（国际版）provider 产品配置 + 协议常量 + 凭据结构与纯函数。
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
// 不要把本节的常量 import 出去。

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

// ── PAT ──

/** PAT 前缀（官方文档：`QODER_PAT="pt-your-token-here"`）。 */
export const QODER_PAT_PREFIX = 'pt-'

/**
 * PAT 签发页（官方入口：登录 → Account → Integrations → 创建 → **立即复制**）。
 *
 * 供 Account Hub 的 Qoder 面板展示 —— 本 provider 没有浏览器登录流程，
 * 用户必须先在这个页面拿到 PAT 才能粘贴进来。
 */
export const QODER_PAT_URL = 'https://qoder.com/account/integrations'

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
 * Qoder 产品配置。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` / `TraeCnProduct` 平行，字段全部为
 * Qoder 实际需要的。
 *
 * **刻意没有 `serviceName` 字段**：产品 id 为 `qoder`（无连字符），
 * `${id}Auth` 机械派生即合法标识符 `qoderAuth`，与 `LobsteraiProduct` 同形。
 * 需要显式 `serviceName` 的只有 id 带连字符的产品（`trae-cn` → `traeCnAuth`、
 * `buddy-cn` → `buddyCnAuth`），它们的机械派生会得到非标识符风格的
 * `trae-cnAuth` / `buddy-cnAuth`。新增 provider 时请守住这条判据，
 * 不要为了「形态统一」给无连字符的产品也加一个字段。
 */
export interface QoderProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'qoder'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
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
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 账号池凭据 ref 前缀。 */
  accountCredentialRefPrefix: string
}

/**
 * Qoder provider 配置。
 *
 * 与其它五条协议线**完全不同源**：没有浏览器 OAuth，登录形态是
 * **PAT 粘贴**（PAT → exchange → jt → Bearer）。故不注册回调服务器、
 * 不做两段式登录（`account.create` 收到 PAT 后当场 exchange 验证即可返回，
 * 不存在「等用户操作 10 分钟」的窗口）。
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
  defaultCredentialRef: QODER_DEFAULT_CREDENTIAL_REF,
  accountCredentialRefPrefix: QODER_ACCOUNT_REF_PREFIX,
}

/** 全部 Qoder 产品配置（当前只有一个，保留数组以便将来扩展，如国内版 `qoder-cn`）。 */
export const ALL_QODER_PRODUCTS: readonly QoderProduct[] = [QODER]

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
