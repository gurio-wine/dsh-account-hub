/**
 * Qoder（国际版）额度余额（credits balance）与**额度耗尽判别**。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）/ `src/lobsterai-credits.ts` /
 * `src/trae-cn-credits.ts` **刻意分开**：四条协议线的端点、信封、鉴权头、
 * 余额口径没有一处共用，硬合并只会让某一个文件出现大量 `if (provider === …)`
 * 分支。但**复用 `credits.ts` 的类型**（{@link CreditBalance} /
 * {@link CreditPackage}），故 `collectCreditBalances` 与前端 `CreditBalanceRow`
 * 都不必各写一份 —— 返回值与另外三条线**逐字段同构**。
 *
 * ## 本模块做三件事
 *
 * | 导出 | 消费者 | 说明 |
 * |---|---|---|
 * | {@link fetchQoderCreditBalance} | Account Hub 的 `credits.balances` | 余额卡片 |
 * | {@link checkQoderQuotaExhausted} | **步骤 6** 接线的 `quotaVerdict` | 402 的额度二次判别 |
 * | {@link fetchQoderCheckinStatus} / {@link claimQoderDailyCheckin} | `credits.status` / `credits.claimAll` | 每日领取（**只给 CN**，见下节） |
 *
 * ## 协议（T1 真机实测，逐字节）
 *
 * ```
 * GET {openapiBase}/api/v2/quota/usage
 * Authorization: Bearer jt-…      ← ⚠️ 只认 job token，PAT 打它回 401 TOKEN_EXPIRE
 * ```
 *
 * 200 响应（T1 原文，本模块全部 fixture 的来源）：
 *
 * ```json
 * {"userId":"…","userType":"personal_standard","usageType":"credits",
 *  "totalUsagePercentage":0.0,"isQuotaExceeded":true,"expiresAt":253402214400000,
 *  "upgradeUrl":"https://qoder.com/pricing?client=qoder","outerProviders":[],
 *  "userQuota":{"total":0.0,"used":0.0,"remaining":0.0,"percentage":0.0,"unit":"credits"},
 *  "isPlanQuotaProrated":false}
 * ```
 *
 * ## 四条硬约束（每条都有对应用例钉死）
 *
 * 1. **凭据只认 `jt-`**。PAT 打本端点回 401 `TOKEN_EXPIRE`（`src/qoder-product.ts`
 *    的 `qoderJobTokenHeaders` 注释），伪令牌回 401 `TOKEN_INVALID`。故本模块
 *    一律经 {@link QoderJobTokenProvider.getJobToken} 取令牌，**从不**直接用
 *    `credential.access_token` 当 Bearer。
 * 2. **三池结构，后两池可缺席**。`userQuota` 是 T1 实测存在的那一个；
 *    `addOnQuota`（加量包）/ `orgResourcePackage`（资源包）**本账号缺席**
 *    —— 解析必须容缺，当作「该池不存在」而不是「该池余额为 0」。
 *    （CLI2API 的 `quota.go` 用指针类型正是这个原因。）
 * 3. **主池耗尽 ≠ 额度耗尽**。只要加量包 / 资源包里还有余额，`exhausted`
 *    就是 false —— 这是 {@link checkQoderQuotaExhausted} 存在的全部意义：
 *    它是 `402 code:116` 唯一被允许通向「换号」的门（`src/qoder-errors.ts`
 *    的 {@link applyQoderQuotaVerdict}）。
 * 4. **`expiresAt` 是毫秒**（`253402214400000` = 9999 年 = 永不过期），
 *    **不是秒**。当成秒会算出公元 800 万年。
 *
 * ## 「查不到」与「余额为 0」严格区分
 *
 * {@link fetchQoderCreditBalance} 失败时返回 `null`（不是 0 余额的
 * {@link CreditBalance}）；{@link checkQoderQuotaExhausted} 失败时返回
 * `undefined`（不是 `{ exhausted: false }`）。两者的下游语义完全不同：
 * 前者由 `collectCreditBalances` 填 `error` 文案，后者让
 * {@link applyQoderQuotaVerdict} **保守判「不换号」** —— 查不到 ≠ 耗尽。
 *
 * ## 身份回写（步骤 1 留下的缺口）
 *
 * `userId` / `userType` **不在 exchange 响应里**，但**在本端点响应里**
 * （T1 原文见上）。故本模块负责把它们回写进凭据的 `user_id` / `user_type`
 * 字段：纯函数 {@link applyQoderUserIdentity} 负责合并，接线层通过
 * {@link QoderCreditsOptions.persistIdentity} 落盘。账号卡片上的昵称因此
 * 从「账号 id」变成真实的用户 id。
 *
 * ## 每日领取（签到）
 *
 * 端点由 **keylog 解密抓包** 解出（2026-09-21，真机 200）：
 *
 * ```
 * GET  {openapiBase}/sash/api/v1/me/campaigns
 * POST {openapiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空串**
 * ```
 *
 * 头只需 `Authorization: Bearer …`（与余额同源：经 jt 换取），**无需 wasm 签名**
 * —— 它挂在 `/sash/` 前缀下，不走 `algo` 签名路径。早期只按 `/api/` 前缀搜端点，
 * 因此误判「Qoder 无签到」（用户报障：「登录成功了，没有获取积分吗？」）。
 *
 * 四条硬约束（每条都有对应用例）：
 *
 * 1. **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**。重复领取同样回
 *    **200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是**上一次
 *    领取的旧时间**（实测请求发生在 09-21、`claimedAt` 却是 09-18）。只看状态码
 *    会把「今天已领」误报成「领取成功 +100」。故 `replayed === true` **归一为
 *    `already-claimed`**。
 * 2. **请求体必须是空串**（抓包实测 `content-length: 0`）。
 * 3. **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`** ——
 *    实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。
 * 4. **`campaigns` 为空数组不是「没有活动」**：活动**每日 10:00（UTC+8）刷新**，
 *    服务端在「今天已领」时会**清空 campaigns** 并回
 *    `{"showCampaign":false,"claimable":false,"campaigns":[]}`。故
 *    `CheckinStatus.active` **恒为 `true`**（拿到响应即活动开启），**不按列表是否
 *    为空判** —— 否则调用方会先命中「活动未开启」分支，把「今天已领」误报成
 *    「签到活动未开启」；而「无活动可领」归一为 `already-claimed`（保守判已领，
 *    比误报可领更不容易误导用户）。
 *
 * ## 签到只接 CN
 *
 * 宿主 `credits.status` / `credits.claimAll` **只给 `qoder-cn` 接线**，国际版
 * `qoder` 维持拒绝（`dailyCheckin: false`）—— 上游情报明说该活动在**桌面 App**
 * 才能领，本模块的实现只对 CN 打开。协议实现本身按传入的 `product` 现算 host，
 * 两区共用一份代码。
 */

import {
  QODER,
  QODER_QUOTA_USAGE_PATH,
  QODER_REQUEST_TIMEOUT_MS,
  qoderJobTokenHeaders,
} from './qoder-product.js'
import type { QoderCredential, QoderProduct } from './qoder-product.js'
import {
  classifyQoderError,
  type QoderErrorClassification,
  type QoderQuotaVerdict,
} from './qoder-errors.js'
import { summarizeQoderErrorBody } from './qoder-auth.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

// ── 池 ──

/**
 * 额度端点的三个池键，**顺序即响应里的声明顺序，也是包列表的展示顺序**。
 *
 * `userQuota` 必在（T1 实测）；后两个**本账号缺席** —— 见模块头注释第 2 条。
 * 顺序写死在这里而不是按响应对象的键序：解析结果的池顺序必须稳定，
 * 否则包列表在两次查询之间会换位置。
 */
export const QODER_QUOTA_POOL_KEYS = ['userQuota', 'addOnQuota', 'orgResourcePackage'] as const

/** 池键类型。 */
export type QoderQuotaPoolKey = typeof QODER_QUOTA_POOL_KEYS[number]

/**
 * 池键 → 中文包名。
 *
 * ⚠️ **quota 响应里没有任何包名字段**（对比 Trae CN 的礼包有 `name`、
 * CodeBuddy 的有 `PackageName`）—— 响应只有池**类型**。故包名只能取池类型，
 * 用 DSH 现有的中文包名惯例（「主额度」对齐 `credits.ts` 的
 * 「CodeBuddy个人体验版」这类可读名，而不是把 `userQuota` 原样透出）。
 */
export const QODER_QUOTA_POOL_LABELS: Readonly<Record<QoderQuotaPoolKey, string>> = {
  userQuota: '主额度',
  addOnQuota: '加量包',
  orgResourcePackage: '资源包',
}

/**
 * 池未声明 `unit` 时的单位。
 *
 * 实测主池带 `unit: "credits"`，但另外两个池**本账号缺席**、字段未观测到，
 * 故需要一个兜底 —— 不能因为字段缺失就把单位渲染成 `undefined`。
 */
export const QODER_QUOTA_UNIT_FALLBACK = 'credits'

/**
 * 错误响应体参与分类时的截断上限（字符）。
 *
 * 分类器会在大写化后的 `message + body` 里找标记，并把 `body` 当 JSON 二次解析
 * （`provider_error` 的 `details`）。正常错误体只有几百字节，但网关在故障时
 * 可能回一整页 HTML —— 截断把最坏情况的最坏代价钉住，且不影响任何实测形态。
 */
const QODER_ERROR_BODY_LIMIT = 8192

// ── 解析结果 ──

/**
 * 单个额度池（三池同构）。
 *
 * 字段名逐字符取自 T1 实测的 `userQuota`，与 CLI2API 的 `quota.go` 一致
 * （每池 `{total, used, remaining, percentage, unit, available?}`）。
 */
export interface QoderQuotaPoolEntry {
  /** 池键（`userQuota` / `addOnQuota` / `orgResourcePackage`）。 */
  key: QoderQuotaPoolKey
  /** 展示用包名（见 {@link QODER_QUOTA_POOL_LABELS}）。 */
  name: string
  /** 池总额度。 */
  total: number
  /** 已用额度。 */
  used: number
  /** 剩余额度（**余额口径的唯一来源**）。 */
  remaining: number
  /** 服务端自报的已用百分比（仅展示，**不参与**任何判定）。 */
  percentage: number
  /** 单位（实测 `credits`）。 */
  unit: string
  /**
   * 服务端是否声明该池可用（CLI2API 情报里的可选字段，**本账号未观测到**）。
   *
   * 记录但**不参与**过滤：T1 响应里没有这个字段，若拿它当门槛，字段缺失的池
   * 会被判成不可用 —— 而「字段缺失」与「明确不可用」是两件事。
   */
  available?: boolean
}

/** 解析后的整份额度响应。 */
export interface QoderQuotaUsage {
  /** 用户 id（`userId` / `user_id`）—— 步骤 1 留下的回写缺口之一。 */
  userId?: string
  /** 用户类型（`userType` / `user_type`，实测 `personal_standard`）。 */
  userType?: string
  /** 计量类型（实测 `credits`）。 */
  usageType: string
  /** 服务端自报的总用量百分比。 */
  totalUsagePercentage: number
  /**
   * 服务端自报的「额度已耗尽」。
   *
   * ⚠️ 它**不单独构成**耗尽结论：还要三池 `remaining` 全为 0
   * （见 {@link checkQoderQuotaExhausted}）。字段缺失按 `false` ——
   * 归一是刻意的，缺字段时保守判「未耗尽」，与「未确证前绝不换号」同向。
   */
  isQuotaExceeded: boolean
  /**
   * 额度计划过期时刻（**毫秒**）。
   *
   * ⚠️ 实测值是 `253402214400000`（9999 年，即永不过期）。**当成秒**会算出
   * 公元 800 万年（见 {@link parseQoderQuotaExpiresAtMs}）。
   *
   * **它不参与池的 `active` 判定**，理由见 {@link fetchQoderCreditBalance}。
   */
  expiresAtMs?: number
  /** 升级引导 URL（实测 `https://qoder.com/pricing?client=qoder`）。 */
  upgradeUrl: string
  /** 三池（按 {@link QODER_QUOTA_POOL_KEYS} 顺序，**缺席的池不在列表里**）。 */
  pools: readonly QoderQuotaPoolEntry[]
  /** 计划额度是否按比例折算（实测 false；仅记录）。 */
  isPlanQuotaProrated: boolean
}

// ── 解析工具 ──

/** 判定值是否为「普通对象」（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读非空字符串字段（兼容后端把数字返回成 number）。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 读数字字段（兼容字符串形态的数字）；缺失或非数值返回 undefined。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 读布尔字段：只认 `true` / `false` 两种显式形态，其余（含缺失）返回 undefined。 */
function readBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return value === true || value === false ? value : undefined
}

/** 依次尝试两个键名（quota 响应对 snake_case / camelCase 两种命名都出现过）。 */
function readEither(source: Record<string, unknown>, camel: string, snake: string): string {
  return readString(source, camel) || readString(source, snake)
}

/**
 * 把 `expiresAt` 归一成毫秒时间戳。
 *
 * ## 为什么不能无条件 `* 1000`
 *
 * T1 实测值是 `253402214400000` —— 这是**毫秒**（9999-12-31T23:59:59.999Z 附近）。
 * 当成秒会得到 `2.534e17`，即公元 800 万年，任何与 `Date.now()` 的比较都会
 * 得出「还没过期」的**偶然正确**结论，而一旦有人把它渲染成日期就会显示一个
 * 荒谬的年份。
 *
 * 判据与 {@link qoderCredentialExpiresAtMs}（`src/qoder-product.ts`）同口径：
 * `> 1e12` 视为毫秒（1e12 毫秒 = 2001-09-09，任何真实的毫秒时间戳都大于它），
 * 否则视为秒。字符串形态（`"253402214400000"` 或 ISO 8601）一并接受。
 *
 * @returns 毫秒时间戳；无法解析返回 undefined。
 */
export function parseQoderQuotaExpiresAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return undefined
  if (/^\d+$/.test(text)) {
    const numeric = Number(text)
    if (!Number.isFinite(numeric)) return undefined
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 解析单个池；不是对象时返回 undefined（= 该池**不存在**，不是「余额为 0」）。 */
function parseQoderQuotaPool(key: QoderQuotaPoolKey, value: unknown): QoderQuotaPoolEntry | undefined {
  if (!isRecord(value)) return undefined
  const unit = readString(value, 'unit')
  const available = readBool(value, 'available')
  return {
    key,
    name: QODER_QUOTA_POOL_LABELS[key],
    total: readNumber(value, 'total') ?? 0,
    used: readNumber(value, 'used') ?? 0,
    remaining: readNumber(value, 'remaining') ?? 0,
    percentage: readNumber(value, 'percentage') ?? 0,
    unit: unit.length > 0 ? unit : QODER_QUOTA_UNIT_FALLBACK,
    ...available === undefined ? {} : { available },
  }
}

/**
 * 解析额度端点的 200 响应体。
 *
 * ## 容缺规则（唯一一处，不要在别处再写一份）
 *
 * - **每个池独立解析**：不是对象的池 = 该池**不存在**（T1 本账号就没有
 *   `addOnQuota` / `orgResourcePackage`），而不是「该池余额为 0」；
 * - **一个池都没有** → 返回 `undefined`。这是「响应形态不是我们认识的那个」
 *   的信号，必须与「三池全为 0 的真余额 0」区分开（见模块头注释最后一节）；
 * - **其余字段宽松**：`isQuotaExceeded` / `isPlanQuotaProrated` 缺失按 false，
 *   `totalUsagePercentage` 缺失按 0，`usageType` / `upgradeUrl` 缺失按空串。
 *   它们**都不参与**余额计算，只是记录。
 *
 * @param body - 响应体 JSON 的解析结果。
 * @returns 解析结果；形态无法识别时 undefined。
 */
export function parseQoderQuotaUsage(body: unknown): QoderQuotaUsage | undefined {
  if (!isRecord(body)) return undefined

  const pools: QoderQuotaPoolEntry[] = []
  for (const key of QODER_QUOTA_POOL_KEYS) {
    const pool = parseQoderQuotaPool(key, body[key])
    if (pool !== undefined) pools.push(pool)
  }
  if (pools.length === 0) return undefined

  const userId = readEither(body, 'userId', 'user_id')
  const userType = readEither(body, 'userType', 'user_type')
  const expiresAtMs = parseQoderQuotaExpiresAtMs(body.expiresAt)

  return {
    ...userId.length === 0 ? {} : { userId },
    ...userType.length === 0 ? {} : { userType },
    usageType: readString(body, 'usageType'),
    totalUsagePercentage: readNumber(body, 'totalUsagePercentage') ?? 0,
    isQuotaExceeded: readBool(body, 'isQuotaExceeded') ?? false,
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
    upgradeUrl: readString(body, 'upgradeUrl'),
    pools,
    isPlanQuotaProrated: readBool(body, 'isPlanQuotaProrated') ?? false,
  }
}

/**
 * 三池 `remaining` 之和（负数按 0 计，两位小数规整）。
 *
 * 负数 clamp 与另外三条协议线同因：服务端在超额扣费 / 计量回滚等异常下可能
 * 下发负值，原样相加会让余额显示成负数。
 */
export function qoderQuotaRemainingTotal(usage: QoderQuotaUsage): number {
  return roundCredits(usage.pools.reduce((sum, pool) => sum + Math.max(0, pool.remaining), 0))
}

// ── 请求 ──

/**
 * 取 job token 的最小依赖面。
 *
 * 刻意**不**直接依赖 `QoderAuth` 类：那会把 `cordis` 的 `Context` 与整个
 * Service 生命周期拖进本模块的签名里，单测也就必须造一个真的服务实例。
 * `QoderAuth`（`src/qoder-auth.ts`）在结构上恰好满足本接口，接线时直接传实例。
 */
export interface QoderJobTokenProvider {
  /**
   * 取一个可用的 job token（`jt-…`），必要时自行重打 exchange。
   *
   * @throws 实现约定的终态错误（`name === 'RefreshTokenExpiredError'`）表示
   *         PAT 已失效、需用户重新粘贴。
   */
  getJobToken(pat: string): Promise<string>
  /** 丢弃该 PAT 的 jt 缓存（下次 {@link getJobToken} 必然重换）。 */
  invalidateJobToken(pat: string): void
}

/** {@link fetchQoderQuotaUsage} 与两个公开查询函数共用的选项。 */
export interface QoderCreditsOptions {
  /** 注入的 fetch（测试用）；默认全局 fetch。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 取消信号（与超时信号合并）。 */
  signal?: AbortSignal
  /**
   * 身份回写出口。
   *
   * 当 quota 响应里的 `userId` / `userType` 与凭据现值**不同**时被调用，
   * 入参是合并后的新凭据；接线层负责 `ctx.credentials.set(ref, …)`。
   * 未变化时**不调用** —— 每次刷新积分都写一次凭据是纯粹的磁盘抖动。
   *
   * 回调抛错不会影响余额结果（只经 {@link QoderCreditsOptions.onDebug} 记账）：
   * 身份字段缺失只影响昵称显示，不该让一次成功的余额查询变成失败。
   */
  persistIdentity?: (credential: QoderCredential) => void | Promise<void>
  /** 脱敏调试出口（只输出原因与状态码，**不输出令牌与凭据**）。 */
  onDebug?: (message: string) => void
}

/**
 * 一次额度查询的结果。
 *
 * 与另外三条协议线的 `Promise<CreditBalance | null>` 不同，本类型**保留失败
 * 原因与错误分类**：步骤 6 的接线既要能填 `credits.balances` 的 `error` 文案，
 * 也要能把 401 的两类分型喂给适配器（`jt 过期 → 重换` vs `PAT 类型错 → 重贴`）。
 */
export type QoderQuotaFetchResult =
  | { ok: true; usage: QoderQuotaUsage }
  | { ok: false; message: string; classification?: QoderErrorClassification }

/**
 * 判定一个错误是否表示「PAT 已失效」。
 *
 * ⚠️ **用 `error.name` 而不是 `instanceof`**：`src/refresh.ts` 的失效判据就是
 * 按 `name` 写的（见 `src/qoder-auth.ts` 的 `RefreshTokenExpiredError` 注释），
 * 跨模块 identity 不同时 `instanceof` 会漏判，让一个终态失败穿透成「可重试」。
 */
function isCredentialExpiredError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RefreshTokenExpiredError'
}

/** 把额度端点的失败响应压成一条分类结果（401 的两类分型都在 `classifyQoderError` 里）。 */
function classifyQuotaFailure(status: number, rawText: string, product: QoderProduct = QODER): QoderErrorClassification {
  return classifyQoderError({
    httpStatus: status,
    source: 'quota',
    message: summarizeQoderErrorBody(rawText),
    // 分类器会在 `details` 里二次解析真码，故要给它**原文**而不是压平的摘要。
    body: rawText.slice(0, QODER_ERROR_BODY_LIMIT),
    // region 上下文：当前按 region 分流的分支只作用于 chat（`source === 'chat'`），
    // 额度线不受影响；传下去是为了让两个 region 的分类入参形态一致，
    // 免得将来只在 chat 线上有 region 信息、额度线却拿不到。
    product,
  })
}

/**
 * 查询额度用量（带 **401 的自愈重试一次**）。
 *
 * 流程与 `src/qoder-auth.ts` 的 exchange 同构，但多一层令牌自愈：
 *
 * 1. 取 jt（`auth.getJobToken`，命中缓存则零网络往返）；
 * 2. `GET {openapiBase}/api/v2/quota/usage` + `Bearer jt-…`；
 * 3. **401 `TOKEN_EXPIRE`** → `invalidateJobToken` + 重取一次再打一遍。
 *    这是「缓存里的 jt 名义未过期、服务端却已失效」的唯一解药
 *    （`getJobToken` 的提前 1h 刷新窗口覆盖不到时钟偏差与服务端提前作废）；
 * 4. **401 `TOKEN_INVALID`** → 直接报「请重新粘贴 PAT」。PAT 的**类型**不对
 *    （粘了 `dt-` 设备令牌、粘了别家 token），重换 jt 只会再撞一次同一堵墙；
 * 5. 其余 4xx/5xx 与网络失败 → 分类后如实上报，**不当成「额度耗尽」**
 *    （查不到 ≠ 耗尽，见模块头注释）。
 *
 * @param credential - 凭据（PAT 在 `access_token`）。
 * @param auth - job token 提供者（接线时传 `ctx.qoderAuth`）。
 * @param options - 注入点与调试出口。
 */
export async function fetchQoderQuotaUsage(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions = {},
): Promise<QoderQuotaFetchResult> {
  const product = options.product ?? QODER
  const fetcher = options.fetcher ?? fetch
  const pat = credential.access_token
  if (pat.length === 0) {
    // 空 PAT 是**本地**就能判定的终态，不必浪费一次网络往返。
    return { ok: false, message: '凭据缺少 PAT，请重新粘贴个人访问令牌' }
  }

  let jobToken: string
  try {
    jobToken = await auth.getJobToken(pat)
  } catch (error) {
    if (isCredentialExpiredError(error)) {
      return {
        ok: false,
        message: `PAT 已失效或不被接受，请重新粘贴：${error instanceof Error ? error.message : String(error)}`,
        // 走同一张分类表：quota 端点的 401 分型是 `credentialInvalid`。
        classification: classifyQuotaFailure(401, error instanceof Error ? error.message : String(error), product),
      }
    }
    // 传输层失败：**不**分类成 401（断网不等于凭据失效）。
    return { ok: false, message: `换取 Qoder job token 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 至多两次：第一次 401 TOKEN_EXPIRE 时丢弃缓存重换一次再打。
  for (let attempt = 0; ; attempt += 1) {
    const url = `${product.openapiBase}${QODER_QUOTA_USAGE_PATH}`
    const timeout = AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: qoderJobTokenHeaders(jobToken, product),
        signal,
      })
    } catch (error) {
      return { ok: false, message: `Qoder 额度查询网络失败：${error instanceof Error ? error.message : String(error)}` }
    }

    let rawText: string
    try {
      rawText = await response.text()
    } catch (error) {
      return {
        ok: false,
        message: `Qoder 额度查询响应读取失败（HTTP ${response.status}）：`
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (!response.ok) {
      const classification = classifyQuotaFailure(response.status, rawText, product)
      // 401 TOKEN_EXPIRE：jt 过期，丢弃缓存重换一次 —— 只重试一次。
      if (classification.jobTokenExpired && attempt === 0) {
        options.onDebug?.(`[qoder] 额度端点 401 TOKEN_EXPIRE（HTTP ${response.status}），丢弃 jt 缓存后重试一次`)
        auth.invalidateJobToken(pat)
        try {
          jobToken = await auth.getJobToken(pat)
        } catch (error) {
          if (isCredentialExpiredError(error)) {
            return {
              ok: false,
              message: `PAT 已失效或不被接受，请重新粘贴：${error instanceof Error ? error.message : String(error)}`,
              classification: classifyQuotaFailure(401, error instanceof Error ? error.message : String(error), product),
            }
          }
          return { ok: false, message: `重换 Qoder job token 失败：${error instanceof Error ? error.message : String(error)}` }
        }
        continue
      }
      options.onDebug?.(`[qoder] 额度查询失败 HTTP ${response.status}：${summarizeQoderErrorBody(rawText)}`)
      return { ok: false, message: classification.message, classification }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      return {
        ok: false,
        message: `Qoder 额度查询响应不是 JSON（HTTP ${response.status}）：${summarizeQoderErrorBody(rawText)}`,
      }
    }
    const usage = parseQoderQuotaUsage(parsed)
    if (usage === undefined) {
      // 形态不认识 ⇒ 查不到（**不是**余额 0）：宁可让卡片显示原因，
      // 也不能把一个解析失败伪装成「这个账号一分钱都没有了」。
      options.onDebug?.(
        `[qoder] 额度响应里没有任何已知的池键（${QODER_QUOTA_POOL_KEYS.join(' / ')}），`
        + `顶层字段名: ${Object.keys(parsed as Record<string, unknown>).join(',') || '(空对象)'}`,
      )
      return { ok: false, message: 'Qoder 额度响应结构无法识别（三池缺失）' }
    }
    return { ok: true, usage }
  }
}

// ── 身份回写 ──

/**
 * 把额度响应里的 `userId` / `userType` 合并进凭据。
 *
 * 纯函数：**不落盘**，落盘由调用方通过
 * {@link QoderCreditsOptions.persistIdentity} 完成（本模块拿不到凭据 ref，
 * 也不该猜）。
 *
 * 三条合并规则：
 * - 响应**没带**该字段 → 沿用旧值（不能把已有的身份抹掉）；
 * - 响应带的值与旧值**相同** → 不算变化；
 * - **两者都没变化时返回原对象引用**（调用方可用 `===` 判断「无需落盘」）。
 *
 * @param credential - 旧凭据。
 * @param usage - 额度响应解析结果。
 * @returns 合并后的凭据；无变化时是入参本身。
 */
export function applyQoderUserIdentity(
  credential: QoderCredential,
  usage: Pick<QoderQuotaUsage, 'userId' | 'userType'>,
): QoderCredential {
  const userId = usage.userId !== undefined && usage.userId.length > 0 ? usage.userId : credential.user_id
  const userType = usage.userType !== undefined && usage.userType.length > 0 ? usage.userType : credential.user_type
  if (userId === credential.user_id && userType === credential.user_type) return credential
  return {
    ...credential,
    ...userId === undefined ? {} : { user_id: userId },
    ...userType === undefined ? {} : { user_type: userType },
  }
}

/**
 * 计算身份回写并交给出口；无变化或出口缺失时**什么都不做**。
 *
 * 出口抛错只记调试日志：身份字段只影响昵称显示，不该让一次成功的余额查询
 * 变成失败。
 */
async function persistQoderIdentity(
  credential: QoderCredential,
  usage: QoderQuotaUsage,
  options: QoderCreditsOptions,
): Promise<void> {
  if (options.persistIdentity === undefined) return
  const updated = applyQoderUserIdentity(credential, usage)
  if (updated === credential) return
  try {
    await options.persistIdentity(updated)
  } catch (error) {
    options.onDebug?.(
      `[qoder] 身份回写失败（不影响余额结果）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ── 余额 ──

/**
 * Qoder 的余额结果 —— 与共用 {@link CreditBalance} **逐字段同构**。
 *
 * 故 `collectCreditBalances` 与前端 `CreditBalanceRow` **无需任何 provider
 * 分支**（这是「逐字段同构」的全部价值，也是 trae-cn 分池改造后的同一约定）。
 */
export type QoderCreditBalance = CreditBalance

/**
 * 池是否值得作为一行明细列出。
 *
 * 判据 = **有余额或有总额**（任务定案）。后果要说清楚：T1 那个全零响应
 * （`total/used/remaining` 全为 0）因此得到**空包列表**，卡片只显示一个
 * 「0」—— 这正是实情：该账号一个可用池都没有。列一行「主额度: 0 / 0」
 * 并不比空列表多出任何信息。
 */
function hasQuotaSubstance(pool: QoderQuotaPoolEntry): boolean {
  return pool.remaining > 0 || pool.total > 0
}

/** 把一个池转成 {@link CreditPackage}（逐字段同构，前端不区分 provider）。 */
function toCreditPackage(pool: QoderQuotaPoolEntry): CreditPackage {
  return {
    name: pool.name,
    unit: pool.unit,
    // 负数 clamp：服务端在超额扣费 / 计量回滚下可能下发负值（与另外三条线同因）。
    remaining: Math.max(0, pool.remaining),
    total: Math.max(0, pool.total),
    used: Math.max(0, pool.used),
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询账号的额度余额。
 *
 * ## 余额口径
 *
 * - `total` = 三池 `remaining` 之和（缺席的池按 0 计，负数 clamp 到 0），
 *   两位小数规整 —— 多池浮点噪声会放大成 `655.67000031`；
 * - `packages` = **有余额或有总量**的池（见 {@link hasQuotaSubstance}），
 *   包名取池类型（quota 响应没有包名字段，见 {@link QODER_QUOTA_POOL_LABELS}）；
 * - `expiredTotal` **恒为 0**，且**这是有依据的**：quota 端点只在**账号级**
 *   给一个 `expiresAt`（实测 `253402214400000` = 9999 年 = 永不过期），
 *   **池本身没有失效字段**（`Status: 3 = 已过期` 是 CodeBuddy 那条线的概念）。
 *   拿账号级时间戳当池失效判据会在哨兵值（如 `0` 表示「不设过期」）上产生
 *   **假的**「另有 N 已失效」，把一个满额账号显示成 0 分 —— 代价远大于收益。
 *   故 `expiresAtMs` 只作为诊断字段保留在 {@link QoderQuotaUsage} 里。
 *
 * ## 失败语义
 *
 * 返回 `null` 表示**查不到**（网络失败 / jt 失效 / 响应形态不认识），
 * 与「余额为 0」（返回一个 `total: 0` 的 {@link CreditBalance}）严格区分 ——
 * 由 `collectCreditBalances` 填 `error` 文案，卡片显示原因而不是 0。
 */
export async function fetchQoderCreditBalance(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions = {},
): Promise<QoderCreditBalance | null> {
  const result = await fetchQoderQuotaUsage(credential, auth, options)
  if (!result.ok) {
    options.onDebug?.(`[qoder] 余额查询失败：${result.message}`)
    return null
  }
  const usage = result.usage
  await persistQoderIdentity(credential, usage, options)

  const listed = usage.pools.filter(hasQuotaSubstance)
  return {
    total: qoderQuotaRemainingTotal(usage),
    packages: listed.map(toCreditPackage),
    expiredTotal: 0,
  }
}

// ── 额度耗尽判别（402 的二次判别数据源） ──

/**
 * 查询该账号的额度是否**确证**耗尽 —— `src/qoder-errors.ts` 预留的
 * `quotaVerdict` 接口背后的真数据源（步骤 6 接线到适配器）。
 *
 * ## 判据（两条**同时**成立才算耗尽，缺一不可）
 *
 * 1. 服务端自报 `isQuotaExceeded === true`；
 * 2. **三池 `remaining` 全为 0**。
 *
 * 第 2 条是这个函数存在的理由：**主池耗尽 ≠ 额度耗尽**。CLI2API 的关键修正
 * 逻辑就在这里 —— 主池（`userQuota`）用光但加量包 / 资源包还有余额时，账号
 * 仍然可以继续用，此时判「耗尽」并换号会白白废掉一个可用账号。
 *
 * ## 失败一律 `undefined`（= 未确证），绝不是 `{ exhausted: false }`
 *
 * 两者在 {@link applyQoderQuotaVerdict} 里的处置**恰好一致**（都判「不换号」），
 * 但语义不同：`undefined` 说的是「没查到，保守不动」，`false` 说的是「查到了，
 * 额度没用完」。把查询失败归成 `false` 会让日志与真机排查失去区分度。
 *
 * ⚠️ 本函数**不发** chat 请求、**不换号**、**不写冷却徽章** —— 它只回答一个
 * 事实问题。换号决定由适配器在步骤 6 接线后做出。
 *
 * @param credential - 凭据（PAT 在 `access_token`）。
 * @param auth - job token 提供者（接线时传 `ctx.qoderAuth`）。
 * @param options - 注入点与调试出口。
 * @returns 额度结论；查询不可用时 `undefined`。
 */
export async function checkQoderQuotaExhausted(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions = {},
): Promise<QoderQuotaVerdict | undefined> {
  const result = await fetchQoderQuotaUsage(credential, auth, options)
  if (!result.ok) {
    // 查不到 ≠ 耗尽：返回 undefined 让调用方保守判「不换号」。
    options.onDebug?.(`[qoder] 额度耗尽判别不可用（保守判未耗尽）：${result.message}`)
    return undefined
  }
  await persistQoderIdentity(credential, result.usage, options)
  const exhausted = isQoderQuotaExhausted(result.usage)
  options.onDebug?.(
    `[qoder] 额度判别：isQuotaExceeded=${result.usage.isQuotaExceeded}，`
    + `三池剩余合计=${qoderQuotaRemainingTotal(result.usage)} ⇒ exhausted=${exhausted}`,
  )
  return { exhausted }
}

/**
 * 判定一份**已解析**的额度响应是否确证耗尽（纯函数）。
 *
 * 抽出来是为了让「两条判据」成为可穷举单测的纯逻辑，不必每次都造一份响应体；
 * {@link checkQoderQuotaExhausted} 只是「取数 + 调它」。
 */
export function isQoderQuotaExhausted(usage: QoderQuotaUsage): boolean {
  if (usage.isQuotaExceeded !== true) return false
  return usage.pools.every((pool) => pool.remaining <= 0)
}

/**
 * 把额度规整为两位小数。
 *
 * 服务端精确值本身可能带浮点表示，多池相加会把尾数噪声显式化 ——
 * 金额展示到分即可（与 `credits.ts` / `lobsterai-credits.ts` /
 * `trae-cn-credits.ts` 同口径、同实现）。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}

// ── 每日领取（签到）──

/**
 * 活动列表路径（挂 `openapiBase`）。
 *
 * ⚠️ 挂在 **`/sash/`** 下、**不是** `/api/` —— 早期只按 `/api/` 前缀搜端点，
 * 因而误判「Qoder 无签到接口」（见模块头注释）。
 */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'

/** 可领取活动的 `actionType`（另一类是 `VIEW_DETAILS`，对它发 claim 是错的）。 */
export const QODER_CAMPAIGN_ACTION_CLAIM = 'CLAIM_BENEFIT'

/** 领取前的权威判据值（`campaigns[].claimStatus`）。 */
export const QODER_CAMPAIGN_STATUS_CLAIMABLE = 'CLAIMABLE'

/** 领取成功响应里的 `status`（实测原文）。 */
export const QODER_CAMPAIGN_STATUS_CLAIMED = 'CLAIMED'

/**
 * 一个活动条目（`campaigns[]` 的一项，**只保留实现需要的字段**）。
 *
 * 响应里还有 `description` / `startAt` / `endAt` 等展示字段，本模块不消费，
 * 故不解析 —— 解析了就会有「谁在用」的疑问，而答案是没有人。
 */
export interface QoderCampaign {
  /** 领取 URL 里的路径段（实测形如 `01a0bf8d-…`）。 */
  campaignId: string
  /** 活动键（实测 `act-20260921-308`），用作展示名。 */
  campaignKey?: string
  /**
   * 动作类型：`CLAIM_BENEFIT` = 可领取积分；`VIEW_DETAILS` = 仅跳转详情。
   *
   * 实测「Pro 首月翻倍」就是后者 —— 对它发 claim 是错的（见模块头第 3 条）。
   */
  actionType?: string
  /** `CLAIMABLE` / `CLAIMED` / … —— 领取前的权威判据。 */
  claimStatus?: string
  /** 可领积分（`benefit.amount`，实测 100）。 */
  amount?: number
}

/**
 * 活动列表的一次解析结果。
 *
 * ⚠️ **`claimable:false` + `campaigns:[]` 不代表「没有活动」**：实测「今天已领」
 * 之后服务端正是这样回的（见模块头第 4 条）。故本类型只是**如实记录**，
 * 调用方不得据此判「活动未开启」。
 */
export interface QoderCampaigns {
  /** 服务端自报「是否展示活动入口」（仅记录，不参与判定）。 */
  showCampaign: boolean
  /** 服务端自报「是否有可领项」（仅记录，不参与判定）。 */
  claimable: boolean
  /** 活动列表（**今天已领时服务端会清空它**）。 */
  campaigns: QoderCampaign[]
}

/** 读 `benefit.amount`（嵌套一层，与 `campaigns[]` 同级结构不同）。 */
function readBenefitAmount(source: Record<string, unknown>): number | undefined {
  const benefit = source.benefit
  if (!isRecord(benefit)) return undefined
  return readNumber(benefit, 'amount')
}

/** 把一条活动条目归一成 {@link QoderCampaign}；缺 `campaignId` 的条目**跳过**。 */
function parseQoderCampaign(value: unknown): QoderCampaign | undefined {
  if (!isRecord(value)) return undefined
  const campaignId = readString(value, 'campaignId')
  if (campaignId.length === 0) return undefined
  const campaignKey = readString(value, 'campaignKey')
  const actionType = readString(value, 'actionType')
  const claimStatus = readString(value, 'claimStatus')
  const amount = readBenefitAmount(value)
  return {
    campaignId,
    ...campaignKey.length === 0 ? {} : { campaignKey },
    ...actionType.length === 0 ? {} : { actionType },
    ...claimStatus.length === 0 ? {} : { claimStatus },
    ...amount === undefined ? {} : { amount },
  }
}

/**
 * 解析 `/sash/api/v1/me/campaigns` 的 200 响应体。
 *
 * ## 容缺规则
 *
 * - **顶层不是对象** → `undefined`（形态不认识 ⇒ 查不到，不是「无活动」）；
 * - **`campaigns` 不是数组**（缺失 / null / 其它类型）→ 按**空列表**归一：
 *   「今天已领」时服务端确实会回空数组，而字段整个缺失与空数组在语义上同向
 *   （都没有可领项），故不把它当成形态错误；
 * - **单条缺 `campaignId`** → 跳过该条（拿不到 id 就发不出 claim，
 *   伪造一个只会打出一个 404）；
 * - `showCampaign` / `claimable` **只认显式 `true`**（缺失按 false），
 *   但它们**不参与**任何判定，仅作诊断。
 *
 * @param body - 响应体 JSON 的解析结果。
 * @returns 解析结果；顶层形态无法识别时 undefined。
 */
export function parseQoderCampaigns(body: unknown): QoderCampaigns | undefined {
  if (!isRecord(body)) return undefined
  const raw = body.campaigns
  const campaigns: QoderCampaign[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const campaign = parseQoderCampaign(item)
      if (campaign !== undefined) campaigns.push(campaign)
    }
  }
  return {
    showCampaign: readBool(body, 'showCampaign') === true,
    claimable: readBool(body, 'claimable') === true,
    campaigns,
  }
}

/**
 * 可领取的活动：`actionType === 'CLAIM_BENEFIT'` **且** `claimStatus === 'CLAIMABLE'`。
 *
 * 两个条件**缺一不可**：只判 `claimStatus` 会把 `VIEW_DETAILS` 型活动
 * （如「Pro 首月翻倍」）也拿去 claim；只判 `actionType` 会把已领过的再领一次。
 */
export function claimableQoderCampaigns(parsed: QoderCampaigns): QoderCampaign[] {
  return parsed.campaigns.filter(
    (campaign) => campaign.actionType === QODER_CAMPAIGN_ACTION_CLAIM
      && campaign.claimStatus === QODER_CAMPAIGN_STATUS_CLAIMABLE,
  )
}

/**
 * 用 jt 发一次签到请求，**带一次 401 `TOKEN_EXPIRE` 自愈重试**。
 *
 * 与 {@link fetchQoderQuotaUsage} 的令牌自愈同因（缓存里的 jt 名义未过期、
 * 服务端却已失效），但**刻意不复用那段代码**：额度线还要把失败喂给分类器
 * （`jobTokenExpired` / `credentialInvalid` 两个标志位），签到线只需要
 * 「成 / 败 + 可读原因」，两处合并会让分类器语义渗进一条不消费它的链路。
 *
 * @returns 响应；取令牌或出网失败时 `{ error }`。
 */
async function sendQoderCheckinRequest(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions,
  build: (jobToken: string) => { url: string; init: { method: string; body?: string; headers?: Record<string, string> } },
): Promise<{ response: Response } | { error: string }> {
  const product = options.product ?? QODER
  const fetcher = options.fetcher ?? fetch
  const pat = credential.access_token
  if (pat.length === 0) {
    // 空 PAT 是**本地**就能判定的终态，不必浪费一次网络往返。
    return { error: '凭据缺少 PAT，请重新粘贴个人访问令牌' }
  }

  let jobToken: string
  try {
    jobToken = await auth.getJobToken(pat)
  } catch (error) {
    if (isCredentialExpiredError(error)) {
      return { error: `PAT 已失效或不被接受，请重新粘贴：${error instanceof Error ? error.message : String(error)}` }
    }
    return { error: `换取 Qoder job token 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 至多两次：第一次 401 TOKEN_EXPIRE 时丢弃缓存重换一次再打。
  for (let attempt = 0; ; attempt += 1) {
    const { url, init } = build(jobToken)
    const timeout = AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
    let response: Response
    try {
      response = await fetcher(url, { ...init, headers: { ...qoderJobTokenHeaders(jobToken, product), ...init.headers }, signal })
    } catch (error) {
      return { error: `Qoder 签到请求网络失败：${error instanceof Error ? error.message : String(error)}` }
    }

    if (response.status !== 401 || attempt > 0) return { response }

    // 401 分型：只有 `TOKEN_EXPIRE` 才值得重换（`TOKEN_INVALID` 是 PAT 类型错，
    // 重换 jt 只会再撞一次同一堵墙）。
    let rawText = ''
    try {
      rawText = await response.clone().text()
    } catch {
      // 读不出原文就**不重试**：无法分型时保守按终态处理（与额度线同向）。
      return { response }
    }
    const classification = classifyQoderError({
      httpStatus: 401,
      source: 'quota',
      message: summarizeQoderErrorBody(rawText),
      body: rawText.slice(0, QODER_ERROR_BODY_LIMIT),
      product,
    })
    if (!classification.jobTokenExpired) return { response }
    options.onDebug?.(`[qoder] 签到端点 401 TOKEN_EXPIRE，丢弃 jt 缓存后重试一次`)
    auth.invalidateJobToken(pat)
    try {
      jobToken = await auth.getJobToken(pat)
    } catch (error) {
      if (isCredentialExpiredError(error)) {
        return { error: `PAT 已失效或不被接受，请重新粘贴：${error instanceof Error ? error.message : String(error)}` }
      }
      return { error: `重换 Qoder job token 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * 拉取活动列表。
 *
 * 抽出来是因为 {@link fetchQoderCheckinStatus} 与 {@link claimQoderDailyCheckin}
 * **都需要它** —— 两处各写一次会重复发一次 GET（与 LobsterAI 传
 * `precheckStatus: false` 同一个道理：claim 内部自带列表查询）。
 *
 * @returns `{ ok: true, campaigns }`；失败 / 形态不认识时 `{ ok: false, reason }`
 *          —— **保留原因**，见下。
 */
async function loadQoderCampaigns(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions,
): Promise<{ ok: true; campaigns: QoderCampaigns } | { ok: false; reason: string }> {
  const product = options.product ?? QODER
  const sent = await sendQoderCheckinRequest(credential, auth, options, (jobToken) => ({
    url: `${product.openapiBase}${QODER_CAMPAIGNS_PATH}`,
    init: { method: 'GET' },
  }))
  if ('error' in sent) {
    options.onDebug?.(`[qoder] 活动列表查询失败：${sent.error}`)
    // ⚠️ **原因必须带出去**：凭据失效（`PAT 已失效，请重新粘贴`）与网络抖动
    // 对用户是**两种完全不同的处置**。把它压成一句「活动列表查询失败」会让
    // 用户在一个自己修不了的方向上排查（与 `describeQoderClaimFailure` 同因）。
    return { ok: false, reason: sent.error }
  }
  const response = sent.response
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const reason = describeQoderClaimFailure(response.status, text)
    options.onDebug?.(`[qoder] 活动列表查询失败 HTTP ${response.status}：${summarizeQoderErrorBody(text)}`)
    return { ok: false, reason }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text()) as unknown
  } catch {
    options.onDebug?.('[qoder] 活动列表响应不是 JSON')
    return { ok: false, reason: '活动列表响应不是 JSON' }
  }
  const campaigns = parseQoderCampaigns(parsed)
  if (campaigns === undefined) {
    options.onDebug?.('[qoder] 活动列表响应结构无法识别')
    return { ok: false, reason: '活动列表响应结构无法识别' }
  }
  return { ok: true, campaigns }
}

/**
 * 查询每日领取状态。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 非 2xx / 形态不认识），与
 * 「无活动可领」严格区分。`CheckinStatus` 是五条签到线共用的结构，此处按
 * Qoder 的语义映射（三条判据见模块头「每日领取」小节）：
 *
 * - `active` **恒为 `true`** —— 拿到响应即活动开启。⚠️ **不按列表是否为空判**：
 *   服务端在「今天已领」时会把 `campaigns` 清空，据此判 `active:false` 会让
 *   `collectClaimResults` 先命中「活动未开启」分支，把「今天已领」误报成
 *   「签到活动未开启」。
 * - `todayCheckedIn`：**没有可领活动即为 true**（含列表为空）。「已领」与
 *   「本来就没活动」在响应上无法区分，而这是个**每日 10:00（UTC+8）刷新**的
 *   活动 —— 保守判「已领」比误报「可领」更不容易误导用户。
 * - `dailyCredit`：可领活动声明的 `benefit.amount`（实测 100）；没有可领项时
 *   回退到任一 `CLAIM_BENEFIT` 活动的声明值（供 UI 显示「每日 100」）。
 */
export async function fetchQoderCheckinStatus(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions = {},
): Promise<CheckinStatus | null> {
  const loaded = await loadQoderCampaigns(credential, auth, options)
  // ⚠️ 失败一律回 `null`（= 查不到）：`CheckinStatus` 没有「失败原因」字段，
  // 原因由 {@link claimQoderDailyCheckin} 那条路径带给用户（见 loadQoderCampaigns）。
  if (!loaded.ok) return null
  const parsed = loaded.campaigns

  const claimable = claimableQoderCampaigns(parsed)
  const benefitCampaigns = parsed.campaigns.filter(
    (campaign) => campaign.actionType === QODER_CAMPAIGN_ACTION_CLAIM,
  )
  return {
    active: true,
    todayCheckedIn: claimable.length === 0,
    streakDays: 0,
    dailyCredit: claimable[0]?.amount ?? benefitCampaigns[0]?.amount ?? 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: benefitCampaigns[0]?.campaignKey ?? '',
    themeName: '',
    endTime: '',
  }
}

/** 领取响应里我们需要的字段（实测原文见模块头）。 */
interface QoderClaimResult {
  status?: string
  replayed?: boolean
  amount?: number
}

/** 解析 claim 响应；形态不认识时回空对象（由调用方按 `status` 缺失处理）。 */
function parseQoderClaimResult(body: unknown): QoderClaimResult {
  if (!isRecord(body)) return {}
  const status = readString(body, 'status')
  const replayed = readBool(body, 'replayed')
  const amount = readBenefitAmount(body)
  return {
    ...status.length === 0 ? {} : { status },
    ...replayed === undefined ? {} : { replayed },
    ...amount === undefined ? {} : { amount },
  }
}

/** 非 JSON 响应 / 非 2xx 的可读原因（凭据失效时网关会回 HTML）。 */
function describeQoderClaimFailure(status: number, text: string): string {
  if (status === 401 || status === 403) return `凭据已失效（HTTP ${status}），请重新登录该账号`
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
  return snippet.length === 0
    ? `服务端返回了非 JSON 响应（HTTP ${status}）`
    : `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`
}

/**
 * 领取**一个**活动的积分。
 *
 * ## 幂等判据是响应体的 `replayed`，不是 HTTP 状态码
 *
 * 重复领取同样返回 **200**，但 `replayed:true`、**不含 `benefit`**，且
 * `claimedAt` 是**上一次领取的旧时间**（实测请求发生在 09-21、`claimedAt`
 * 却是 09-18）。只看状态码会把「今天已领」误报成「领取成功 +100」——
 * 故 `replayed === true` **归一为 `already-claimed`**。
 *
 * ## 请求体必须是空串
 *
 * 抓包实测 `content-length: 0`；源码里该请求无 payload。发 `{}` 属未经验证的
 * 形态，故照实发空串（`qoderJobTokenHeaders` 已带 `Content-Type: application/json`）。
 */
export async function claimQoderCampaign(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  campaignId: string,
  options: QoderCreditsOptions = {},
): Promise<ClaimOutcome> {
  const product = options.product ?? QODER
  const sent = await sendQoderCheckinRequest(credential, auth, options, (jobToken) => ({
    url: `${product.openapiBase}${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`,
    init: { method: 'POST', body: '' },
  }))
  if ('error' in sent) return { kind: 'failed', code: -1, message: sent.error }

  const response = sent.response
  const text = await response.text().catch(() => '')
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) as unknown : {}
  } catch {
    return { kind: 'failed', code: response.status, message: describeQoderClaimFailure(response.status, text) }
  }
  if (!response.ok) {
    return { kind: 'failed', code: response.status, message: describeQoderClaimFailure(response.status, text) }
  }

  const result = parseQoderClaimResult(body)
  // `replayed:true` = 本次活动此前已领（服务端回放上次结果）—— **不是** claimed。
  if (result.replayed === true) return { kind: 'already-claimed', message: '今天已领取' }
  if (result.status !== undefined && result.status !== QODER_CAMPAIGN_STATUS_CLAIMED) {
    return { kind: 'failed', code: -1, message: `领取未成功（status=${result.status}）` }
  }
  return { kind: 'claimed', credit: result.amount ?? 0, streakDays: 0, isStreakDay: false }
}

/**
 * 领取该账号**当前所有**可领活动。
 *
 * 一个账号可能同时有多个 `CLAIM_BENEFIT` 活动（实测有每日 100 Credits 与其它
 * 运营活动），故逐个领取而非只领第一个。
 *
 * 汇总为**一条** {@link ClaimOutcome}（与另外四条签到线同构，前端摘要 UI 共用）：
 *
 * - 列表查不到 → `failed`（不是 `already-claimed`：查不到 ≠ 已领）；
 * - **无可领活动 → `already-claimed`**（服务端在「今天已领」时清空列表，
 *   而「本来就没活动」无法区分 —— 保守判已领，见模块头第 4 条）；
 * - 至少一个成功 → `claimed`（`credit` 为累计值）；
 * - 全部失败 → `failed`（带第一条错误原因）。
 *
 * ⚠️ **自带活动列表查询**，故宿主 RPC 分支必须传 `precheckStatus: false`，
 * 否则会先多发一次 GET（与 LobsterAI / Trae CN 同约定）。
 */
export async function claimQoderDailyCheckin(
  credential: QoderCredential,
  auth: QoderJobTokenProvider,
  options: QoderCreditsOptions = {},
): Promise<ClaimOutcome> {
  const loaded = await loadQoderCampaigns(credential, auth, options)
  if (!loaded.ok) {
    // ⚠️ 带上**精确原因**（`PAT 已失效，请重新粘贴` 与 `HTTP 502` 的处置完全
    // 不同）。压成笼统文案会把可修问题伪装成未知故障。
    return { kind: 'failed', code: -1, message: `活动列表查询失败：${loaded.reason}` }
  }
  const parsed = loaded.campaigns

  const targets = claimableQoderCampaigns(parsed)
  if (targets.length === 0) {
    // 服务端在「今天已领」时清空 campaigns ⇒ 无目标即已领（见函数注释）。
    return { kind: 'already-claimed', message: '今天已领取' }
  }

  let total = 0
  let firstError: string | undefined
  for (const target of targets) {
    const outcome = await claimQoderCampaign(credential, auth, target.campaignId, options)
    if (outcome.kind === 'claimed') total += outcome.credit
    else if (outcome.kind === 'failed' && firstError === undefined) firstError = outcome.message
  }
  if (total > 0) return { kind: 'claimed', credit: total, streakDays: 0, isStreakDay: false }
  if (firstError !== undefined) return { kind: 'failed', code: -1, message: firstError }
  // 全部 `already-claimed`：没有任何新领取，但仍不是失败。
  return { kind: 'already-claimed', message: '今天已领取' }
}
