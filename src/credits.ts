/**
 * Buddy 系每日签到（领取积分）客户端。
 *
 * 端点与格式均来自对 WorkBuddy 5.5.6 的逆向 + 真实请求实测（2026-09-14）：
 *
 *   状态查询  POST /v2/billing/meter/checkin-activity-status   body {}
 *   领取      POST /v2/billing/meter/daily-checkin             body {}
 *
 * 两个关键结论（实测）：
 *
 * 1. **必须用 checkin-activity-status，不能用 checkin-status**。后者返回的
 *    是占位数据（active:false、checkin_dates:null、claim_button_text:""），
 *    会让人误判为"活动未开启"。前者才是权威状态源。
 *
 * 2. **不需要 X-Device-Token（图灵盾）**。静态分析曾认为该头是主要门槛，
 *    但实测三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实
 *    领取成功（code:0, credit:100）并可见状态翻转。因此不引入 native SDK。
 *
 * 幂等：重复领取返回 HTTP 400 + code 10001（"今天已签到，请明天再来"）。
 * 判定以响应体 code 为准 —— 不能只看 HTTP 状态。
 */

import {
  BUDDY_DEPLOYMENT_TYPE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
} from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'

/** 签到状态查询端点（权威状态源）。 */
export const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
/** 每日签到领取端点。 */
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
/**
 * 积分余额查询端点。
 *
 * **两个产品通用**（2026-09-15 实测）：Buddy CN（腾讯 CodeBuddy 中国版）
 * 与 Buddy（腾讯 WorkBuddy 国际版，www.workbuddy.ai）都实现该端点，
 * 请求头与响应结构完全一致，只有 baseURL 不同（随 `product.endpoint` 切换）。
 *
 * 这与签到能力形成对比 —— **签到**只有中国版有（国际版内核里连
 * `checkin-status` / `daily-checkin` 的字面量都不存在），但**积分余额查询
 * 两边都有**。两者是彼此独立的能力，不要因为"国际版没有签到"就推断
 * 它也查不到余额。
 *
 * 该端点不在 CLI 内核里（内核只硬编码了 `get-dosage-notify` 用量通知），
 * 是 IDE 前端直接调用的，故静态搜索内核找不到，只能用真实凭据实测发现。
 */
export const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

/** 签到请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30_000

/** 服务端返回的 "今日已签到" 业务码（实测值）。 */
const CODE_ALREADY_CLAIMED = 10001
/** 静态分析列出的备选码表：1001=已领取 1002=无资格 1003=活动结束。 */
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

/** 签到活动状态（字段名已转为 camelCase）。 */
export interface CheckinStatus {
  /** 活动是否进行中。false 时不应尝试领取 */
  active: boolean
  /** 今日是否已签到 —— 领取判定的权威依据 */
  todayCheckedIn: boolean
  /** 连续签到天数 */
  streakDays: number
  /** 每日可领积分 */
  dailyCredit: number
  /** 今日已领积分 */
  todayCredit: number
  /** 今日是否为连续奖励日 */
  isStreakDay: boolean
  /** 累计已领积分 */
  totalCredits: number
  /** 已签到日期列表（如 ["2026-09-14"]） */
  checkinDates: string[]
  /** 活动名（如「开学季」） */
  activityName: string
  /** 主题名（如「Buddy加油站」） */
  themeName: string
  /** 活动结束时间 */
  endTime: string
}

/** 一次领取的结果。 */
export type ClaimOutcome =
  | { kind: 'claimed'; credit: number; streakDays: number; isStreakDay: boolean; delayedMessage?: string }
  | { kind: 'already-claimed'; message: string }
  | { kind: 'inactive'; message: string }
  | {
    kind: 'failed'
    code: number
    message: string
    /**
     * 服务端日志追踪号（**可选**，只有服务端在响应头里给了才有）。
     *
     * 三套协议共用这个判别联合，故字段必须是可选的：Buddy 系与 LobsterAI 的
     * 响应里没有已知的等价头，加了也不会填，其它协议的 outcome 逐字段不变。
     *
     * 唯一的生产者是 Trae CN：它读响应头 `x-tt-logid`（字节系网关的 logid，
     * 真机样本 `20260919142909176141A5DE791F4FE75E`）。**这是定位服务端日志的
     * 唯一线索** —— `code` 与 `message` 只说「失败了、为什么」，logid 才能让
     * 服务端查到这一次请求到底发生了什么。前端失败行会把它一并显示出来。
     */
    logid?: string
  }

/**
 * 积分资源包（`get-user-resource` 响应里 `Accounts[]` 的一项）。
 *
 * ## 一个账号为什么有多个包
 *
 * 每个包是**一份独立的积分授予**（套餐 + 若干运营活动赠包），各自有独立的
 * 计量周期与到期时间。实测某 Buddy CN 账号有 5 个包：1 个体验版套餐 +
 * 4 份「国内运营裂变包」，其中 2 份已过期、1 份本周期已耗尽、2 份可用。
 * 所以界面上「5 个资源包」不等于 5 份额度，需要区分有效与失效。
 *
 * ## 两个 "Remain" 字段的口径差异（关键）
 *
 * 响应里同时有两个剩余值，**含义完全不同**：
 *
 * | 字段                     | 含义                     | 实测（体验版包） |
 * |--------------------------|--------------------------|------------------|
 * | `CapacityRemain`         | 该包的**终身**剩余       | 500              |
 * | `CycleCapacityRemain`    | 该包**本计费周期**剩余   | 0                |
 *
 * IDE 顶部的 "Credits Balance" 用的是**周期口径**（`CycleCapacityRemain`）：
 * 实测该账号终身口径求和为 655.67，而 IDE 显示 155.67 —— 差额 500 正是那个
 * 「终身还剩 500、但本周期已一分不剩」的体验版包。用错字段会让数字凭空多出
 * 一大截，且用户无从核对。
 */
export interface CreditPackage {
  /** 包名（如 'Bonus Pack' / 'CodeBuddy个人体验版'） */
  name: string
  /** 额度单位（'credit' / 'credits'） */
  unit: string
  /** 本计费周期剩余额度（IDE 展示口径，精确值含小数） */
  remaining: number
  /** 本计费周期总额度（精确值） */
  total: number
  /** 本计费周期已用额度（精确值） */
  used: number
  /**
   * 该包是否仍然有效。
   *
   * 判定：服务端 `Status !== 3`（实测 3 = 已过期）且未过 `ExpiredTime`。
   * 失效包仍会出现在 `Accounts[]` 里（额度可能非 0），UI 需要能区分出来，
   * 否则用户会以为那些额度还能用。
   */
  active: boolean
  /** 计量周期开始时间（服务端本地时间字符串，可能为空） */
  cycleStartTime: string
  /** 计量周期结束时间（服务端本地时间字符串，可能为空） */
  cycleEndTime: string
  /** 该包自身的失效时间（可能为空 = 无固定失效时间） */
  expiredTime: string
}

/** 账号的积分余额汇总。 */
export interface CreditBalance {
  /**
   * 当前可用总余额（各**有效**包的本周期剩余之和）。
   *
   * 这个口径与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
   *
   * 刻意不用服务端的 `TotalDosage`：它是**终身口径**且取整（实测同一响应里
   * TotalDosage=655 而 IDE 显示 155.67），既口径不对又有截断误差。
   */
  total: number
  /** 各资源包明细（含已失效的，由 `active` 区分） */
  packages: CreditPackage[]
  /**
   * 已失效包里的剩余额度合计。
   *
   * 单独给出而不是并进 `total`：这些额度服务端仍会返回，但实际不可用于扣费。
   * UI 可以据此提示「另有 N 已失效」，既不误导也不丢信息。
   */
  expiredTotal: number
}

/**
 * 构造签到/余额请求头。不含 X-Device-Token（实测非必需）。
 *
 * `X-Domain` **以产品配置为准**，而不是优先用凭据里的 `credential.domain`：
 * 凭据的 domain 是"登录时用的域名"的快照，若它系从另一个产品遗留/迁移而来
 * （典型场景：国际版 provider（`buddy`）早年指向中国版，改造后旧凭据仍写着
 * copilot.tencent.com），跟着凭据走就会把请求的身份标识发错区域。请求的
 * baseURL 来自 `product.endpoint`，X-Domain 必须与之一致，否则前后矛盾。
 *
 * 保留凭据 domain 仅作为产品未声明 apiDomain 时的兜底。
 */
function checkinHeaders(credential: BuddyCredential, product: BuddyProduct): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set(HTTP_HEADER_DOMAIN, product.apiDomain || credential.domain || '')
  headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE)
  headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode)
  if (credential.user_id !== undefined && credential.user_id.length > 0) {
    headers.set('X-User-Id', credential.user_id)
  }
  if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
    headers.set('X-Enterprise-Id', credential.enterprise_id)
    headers.set('X-Tenant-Id', credential.enterprise_id)
  }
  headers.set('User-Agent', product.userAgent)
  return headers
}

/** 从 JSON 安全读取布尔值。 */
function readBool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/** 从 JSON 安全读取数字。 */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 从 JSON 安全读取字符串。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/** 从 JSON 安全读取字符串数组。 */
function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 一次签到请求的结果。
 *
 * 失败时保留**原因说明**而不是笼统的 undefined：网络异常时带上底层错误消息
 * （如 "socket hang up"），便于上层如实呈现失败原因，也便于排查。
 */
type PostResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/**
 * 发起一次签到请求并解析 JSON 响应体。
 * 网络失败或响应无法解析为对象时返回失败原因（由调用方决定如何呈现）。
 *
 * ⚠️ **不要用 `response.json()`**：凭据过期/失效时，腾讯网关返回的是
 * **HTML 错误页**而不是 JSON，`json()` 会抛
 * `Unexpected token '<', "<html> <h"... is not valid JSON` —— 这条消息对
 * 用户毫无意义，也看不出真正原因是「凭据过期」。故先取文本、再尝试解析，
 * 非 JSON 时带上 HTTP 状态码与响应片段（真实缺陷：用户看到的就是上面那句）。
 */
async function postJson(
  path: string,
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch,
): Promise<PostResult> {
  try {
    const response = await fetcher(`${product.endpoint}${path}`, {
      method: 'POST',
      headers: checkinHeaders(credential, product),
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // 非 JSON：多半是网关 HTML 错误页（凭据失效的典型表现）。
      // 如实带上状态码，让「HTTP 401/403 → 凭据问题」这条线索浮出来。
      return { ok: false, message: describeNonJsonResponse(response.status, text) }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (error) {
    // 保留原始错误消息（含超时/连接被重置等信号），不吞掉诊断信息。
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把「响应不是 JSON」整理成可读原因。
 *
 * 凭据过期时腾讯网关返回 HTML 错误页，原始报错是
 * `Unexpected token '<', "<html> <h"... is not valid JSON` —— 用户既不知道
 * 发生了什么，也看不出该重新登录。这里改为明确指向凭据问题并附状态码。
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
 * 查询签到活动状态。
 * 使用 checkin-activity-status（权威源，非 checkin-status）。
 * 网络失败、响应非法或业务码非 0 时返回 null。
 */
export async function fetchCheckinStatus(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<CheckinStatus | null> {
  const result = await postJson(CHECKIN_ACTIVITY_STATUS_PATH, credential, product, fetcher)
  if (!result.ok) return null
  const body = result.body
  if (body.code !== 0) return null
  const data = body.data
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return {
    active: readBool(record, 'active'),
    todayCheckedIn: readBool(record, 'today_checked_in'),
    streakDays: readNumber(record, 'streak_days'),
    dailyCredit: readNumber(record, 'daily_credit'),
    todayCredit: readNumber(record, 'today_credit'),
    isStreakDay: readBool(record, 'is_streak_day'),
    totalCredits: readNumber(record, 'total_credits'),
    checkinDates: readStringArray(record, 'checkin_dates'),
    activityName: readString(record, 'activity_name'),
    themeName: readString(record, 'theme_name'),
    endTime: readString(record, 'end_time'),
  }
}

/**
 * 执行每日签到领取。
 *
 * 判定顺序：先看业务码是否属于「已领取 / 无资格 / 活动结束」这些非致命类别，
 * 再看是否成功，最后归为 failed。判定以响应体 code 为准（重复领取是 HTTP 400，
 * 只看状态码会把幂等情况误报为失败）。
 */
export async function claimDailyCheckin(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const result = await postJson(DAILY_CHECKIN_PATH, credential, product, fetcher)
  if (!result.ok) {
    return { kind: 'failed', code: -1, message: result.message }
  }
  const body = result.body
  const code = typeof body.code === 'number' ? body.code : -1
  const message = readString(body, 'msg')

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: 'already-claimed', message: message.length > 0 ? message : '今天已签到' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'inactive', message: message.length > 0 ? message : '当前无领取资格' }
  }
  if (code !== 0) {
    return { kind: 'failed', code, message: message.length > 0 ? message : '领取失败' }
  }
  const data = body.data
  if (typeof data !== 'object' || data === null) {
    return { kind: 'failed', code, message: '领取响应缺少 data 字段' }
  }
  const record = data as Record<string, unknown>
  const delayed = readString(record, 'message')
  return {
    kind: 'claimed',
    credit: readNumber(record, 'credit'),
    streakDays: readNumber(record, 'streak_days'),
    isStreakDay: readBool(record, 'is_streak_day'),
    ...delayed.length > 0 ? { delayedMessage: delayed } : {},
  }
}

/**
 * 读取一个数值字段，优先取带 `Precise` 后缀的精确版本。
 *
 * 实测：`CapacityRemain` = 247（整数、截断），`CapacityRemainPrecise` = "247.87"
 * （字符串、两位小数）。IDE 显示的是后者，因此精确值优先；精确值缺失或无法
 * 解析时回退到整数版，保证老响应格式仍能读出数字。
 */
function readPreciseNumber(source: Record<string, unknown>, baseKey: string): number {
  const precise = source[`${baseKey}Precise`]
  if (typeof precise === 'string') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  return readNumber(source, baseKey)
}

/**
 * 服务端标记「该资源包已过期」的 Status 值（实测）。
 *
 * 实测某 Buddy CN 账号的 5 个包里，两个带 `ExpiredTime`（2026-06-02 /
 * 2026-06-06）的条目 Status 均为 3，三个有效条目为 0。故把 3 视为失效；
 * 其他未知取值一律当成有效（宁可多显示一个额度，也不要把能用的额度藏起来）。
 */
const PACKAGE_STATUS_EXPIRED = 3

/**
 * 从 `get-user-resource` 的一个 Account 条目解析资源包。
 *
 * 包名回退链：`PackageName` → `SubProductName` → `PackageCode`。实测两个产品
 * 都会下发 `PackageName`，但企业版等变体可能只有其中之一，故逐级回退而不是
 * 显示成空字符串。
 *
 * 余额取 **`CycleCapacityRemain`（本周期口径）** 而非 `CapacityRemain`
 * （终身口径）—— 理由见 {@link CreditPackage} 的字段对照表。
 */
function parseCreditPackage(entry: Record<string, unknown>): CreditPackage {
  const name = readString(entry, 'PackageName')
    || readString(entry, 'SubProductName')
    || readString(entry, 'PackageCode')
  const unit = readString(entry, 'CapacityUnit') || readString(entry, 'OriginUnit')
  const status = entry.Status
  const expiredTime = readString(entry, 'ExpiredTime')
  // 失效判定：Status 显式为已过期，或存在已过去的 ExpiredTime
  const expiredAt = expiredTime.length > 0 ? Date.parse(expiredTime.replace(' ', 'T')) : Number.NaN
  const active = status !== PACKAGE_STATUS_EXPIRED
    && !(Number.isFinite(expiredAt) && Date.now() >= expiredAt)
  return {
    name,
    unit,
    remaining: readPreciseNumber(entry, 'CycleCapacityRemain'),
    total: readPreciseNumber(entry, 'CycleCapacitySize'),
    used: readPreciseNumber(entry, 'CycleCapacityUsed'),
    active,
    cycleStartTime: readString(entry, 'CycleStartTime'),
    cycleEndTime: readString(entry, 'CycleEndTime'),
    expiredTime,
  }
}

/**
 * 查询账号的积分余额（剩余 credits）。
 *
 * 两个产品通用（见 {@link USER_RESOURCE_PATH} 的说明）。网络失败、响应非法或
 * 业务码非 0 时返回 null —— 与 {@link fetchCheckinStatus} 同款语义，让调用方
 * 能把「查不到」与「余额为 0」区分开，不要把网络故障显示成 0 积分。
 *
 * 注意 `data` 是**双层嵌套**：`data.Response.Data.Accounts[]`。这与签到端点的
 * 单层 `data` 结构不同，是本接口最容易解析错的地方。
 */
export async function fetchCreditBalance(
  credential: BuddyCredential,
  product: BuddyProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const result = await postJson(USER_RESOURCE_PATH, credential, product, fetcher)
  if (!result.ok) return null
  const body = result.body
  if (body.code !== 0) return null
  // data.Response.Data —— 两层嵌套，逐层校验，任一层缺失即视为不可解析
  const outer = body.data
  if (typeof outer !== 'object' || outer === null) return null
  const response = (outer as Record<string, unknown>).Response
  if (typeof response !== 'object' || response === null) return null
  const inner = (response as Record<string, unknown>).Data
  if (typeof inner !== 'object' || inner === null) return null
  const accounts = (inner as Record<string, unknown>).Accounts
  if (!Array.isArray(accounts)) return null

  const packages: CreditPackage[] = []
  for (const item of accounts) {
    if (typeof item !== 'object' || item === null) continue
    packages.push(parseCreditPackage(item as Record<string, unknown>))
  }
  // 只累加**有效**包的本周期余额：失效包里的额度服务端仍会返回，但不能用于
  // 扣费，并进总额会让数字虚高（实测某账号因此从 155.67 变成 655.67）。
  //
  // 累加后按两位小数规整：服务端精确值本身带浮点表示（如 55.67000031），
  // 多包相加会把尾数噪声显式化——金额展示到分即可。
  const total = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? pkg.remaining : 0), 0),
  )
  // 失效包的余额单独汇总，供 UI 提示「另有 N 已失效」——既不误导也不丢信息
  const expiredTotal = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : pkg.remaining), 0),
  )
  return { total, packages, expiredTotal }
}

/**
 * 把额度规整为两位小数。
 *
 * 用 `Math.round(v * 100) / 100` 而不是 `toFixed` 后 parse：后者对
 * 负数与极大值的行为不一致，且返回字符串会污染数值类型。这里只处理
 * 服务端下发的正数额度，乘法取整足够且结果仍是 number。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}
