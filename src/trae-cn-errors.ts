/**
 * Trae CN 上游错误分类。
 *
 * 与 `src/lobsterai-errors.ts` **平行而非复用**：两条协议线的错误码体系毫无交集
 * （LobsterAI 判 HTTP 状态码 + 英文/中文关键词，Trae CN 判 **HTTP 200 响应体里的
 * 业务码**），共用一套判定只会让两边都变得难以推理。
 *
 * ## 为什么必须按「业务码」而不是 HTTP 状态码判
 *
 * 实测（调研报告，已确认）：Trae CN 的 chat 端点在绝大多数失败下**仍返回 HTTP 200**
 * —— 错误走 SSE 的 `event:error` 帧，形如 `data:{"code":4008,"message":"..."}`。
 * 因此「按 402/429 判限流」这类在腾讯系上有效的做法在这里**完全失效**：
 * 一个 4008（限流）和一次正常回复在 HTTP 层长得一模一样。
 *
 * 本模块因此以**业务码**为第一判据；HTTP 状态码只在**拿不到业务码**时兜底
 * （网关 5xx、网络层 401/403、纯文本 429 等）。
 *
 * ## 三类动作
 *
 * | 动作 | 含义 | 由谁执行 |
 * |---|---|---|
 * | `switch-account` | 换下一个账号重试 | 适配器的换号循环 |
 * | `backoff` | **不换号**，退避后重试同一账号 | DSH 的重试层（抛可重试错误码） |
 * | `fail` | 直接报错给用户 | 适配器抛出带原始 code/message 的错误 |
 *
 * 本模块**只有纯函数**，无副作用、不发请求，故可整表穷举单测。
 */

/**
 * 分类结果。
 *
 * 刻意用字符串字面量而非数字：码值在日志与测试断言里可读性差，
 * 且 `'switch-account'` 直接就是适配器要做的动作名。
 */
export type TraeCnErrorAction =
  /** 换下一个账号重试（限流 / 账号失效 / 风控）。 */
  | 'switch-account'
  /** 不换号，退避重试（软限流 / 排队等待）。 */
  | 'backoff'
  /** 直接报错（参数错误 / 超长 / 模型不存在 / 未知码）。 */
  | 'fail'

/**
 * 换号码：限流类。
 *
 * - `4021` / `5003`：请求频率/并发限额；
 * - `977`：服务端限流（客户端侧表现为「请求过于频繁」类）；
 * - `4008`：⚠️ **实测语义是「通用积分池耗尽」，不是频率限额**（2026-09-21
 *   单变量取证，见 {@link TRAE_CN_QUOTA_EXHAUSTED_CODES}）。它**刻意留在本表**：
 *   动作（换号）与徽章（记冷却）和限流码完全一致，语义差别只体现在**终报文案**
 *   上（用户需要知道「等一会儿」不会好）。把它移表不改变任何行为，只会让既有
 *   测试里「限流码集合」的断言与真机事实打架 —— 纯噪音。
 *
 * 这一类换号的意义最直白：**限额是账号级的**，换一个账号就能继续。
 */
export const TRAE_CN_RATE_LIMIT_CODES: readonly number[] = [4008, 4021, 5003, 977]

/**
 * 换号码：额度/付费类（`4200`–`4203`）。
 *
 * 与上表分开是因为**冷却徽章的语义不同**（见 {@link recordsTraeCnCooldown}）：
 * 额度类需要充值/等待周期重置，与「频率限额」在 UI 上应能被区分对待。
 * 但两者在**动作**上一致 —— 都换号。
 */
export const TRAE_CN_QUOTA_CODES: readonly number[] = [4200, 4201, 4202, 4203]

/**
 * 「**积分已耗尽**」的业务码（`4008`，2026-09-21 单变量定案）。
 *
 * ## 为什么它是独立一张表，而不是并进限流表
 *
 * `4008` 此前被当作「请求频率限额」（它也确实躺在
 * {@link TRAE_CN_RATE_LIMIT_CODES} 里，且**继续留在那里**）。真机取证推翻了
 * 那个语义：
 *
 * - 余额端点确认某账号**通用池 `remain=0`** 之后，该账号**连 4 KB 小请求**
 *   都回 `4008`（`"Your requests have exceeded the quota."`），**190 ms 即回**，
 *   且**20 分钟不自愈**；
 * - 同一时刻**健康账号**（`remain 2334.95`）连续 **8 个请求全成功**。
 *
 * ⇒ 与请求频率、字节量、并发**全都无关**，是**配额耗尽**。这也是它跟
 * `4200`–`4203`（{@link TRAE_CN_QUOTA_CODES}）应当被分开叙述的原因：那四个码
 * 从未实测，而 `4008` 有单变量证据。⚠️ 两张表**名字相邻但语义不同**，不要合并：
 * `TRAE_CN_QUOTA_CODES` 是「配额类动作码」，本表是「**已验证为耗尽**的码」，
 * 后者的唯一消费者是终报文案（见 {@link traeCnCreditsExhaustedHint}）。
 *
 * ## 动作与徽章都**不变**（这正是它同时留在限流表里的原因）
 *
 * 换号依然正确（每个账号的池是独立的），记冷却徽章也依然正确（等周期重置）。
 * 本表的**唯一消费者是终报文案**：全部账号都耗尽时，用户必须看到
 * 「积分已耗尽」而不是「请求过于频繁」—— 后者会让他去等一个永远不会到来的
 * 重置时刻，或者反复重试同一个注定失败的请求。
 *
 * 判定用「是否在这张耗尽表里」而不是「是否不在限流表里」，故将来若再拿到
 * 别的耗尽码（例如 `4200` 被实测确认），只需加进本表，无需改任何调用点。
 */
export const TRAE_CN_CREDITS_EXHAUSTED_CODES: readonly number[] = [4008]

/**
 * 换号码：**账号失效**（`1001` / `1002` / `4010` / `4014`）。
 *
 * 令牌被吊销、账号被踢下线、登录态失效等。用户已明确确认**与风控一样换号**
 * （对齐官方客户端的 `isSecurityError` 语义：那套逻辑把这些码统一视为
 * 「当前身份不可用」，一律切号而不是把错误抛给用户）。
 */
export const TRAE_CN_ACCOUNT_INVALID_CODES: readonly number[] = [1001, 1002, 4010, 4014]

/**
 * 换号码：**风控**（`4011` / `4013` / `4015`）。
 *
 * 与账号失效分开的原因同 {@link TRAE_CN_QUOTA_CODES}：风控通常有**时效**
 * （一段时间后自动解除），故应当记冷却徽章；账号失效只能重新登录，
 * 记一个「等待重置」的徽章是误导（见 {@link recordsTraeCnCooldown}）。
 */
export const TRAE_CN_RISK_CONTROL_CODES: readonly number[] = [4011, 4013, 4015]

/**
 * 退避码（**不换号**）。
 *
 * - `4007` / `3004`：软限流 —— 服务端明确要求稍后重试，
 *   换号既无必要（限的是请求节奏而非账号额度），又会额外消耗其它账号的额度；
 * - `9074`（「当前参与用户太多，请稍后再试」）：⚠️ **定性已于 2026-09-23 第五次
 *   修正**（前四次均作废，完整历次见 `src/trae-cn-credits.ts` 文件头）。第 1 次
 *   「瞬时频次软限流」被三日取证推翻（同账号 09-17/18/19 报错 15 / 187 / 250 次、
 *   **8 秒退避重放仍 9074**）；第 2 次「活动级当日名额/账号风控」作废于误读；
 *   第 3 次「**设备身份**不被活动系统认可」被判定矩阵推翻（账号级已签时**任意
 *   设备号**都回 `code:0`）；第 4 次「名额/风控类拒绝、与设备号取值无关」又被
 *   **单变量矩阵**推翻（同一账号同一 token、11 秒后换**全新** 16 位号首次 claim
 *   即 `code:0`）。**现行定性：设备号被服务端拉黑** —— 该号在**未产出奖励**的
 *   claim 中出现过。
 *   仍留在本表（**chat 侧**动作仍是「退避、不换号」：那里没有设备号可选，
 *   换账号只会多烧一个账号的往返），但**它不记冷却徽章**（见
 *   {@link recordsTraeCnCooldown}），且**签到侧已把它移出可重试清单**
 *   （`TRAE_CN_CLAIM_RETRY_CODES`）—— 签到侧对它的处置是**换设备号重试一次**
 *   （`src/trae-cn-credits.ts` 的 `rotateTraeCnCheckinDeviceId`），不是退避。
 *   ⚠️ 本表服务的是 **chat 通道**，改动它等于改 chat 行为 —— 签到侧的收窄
 *   **只动那张更窄的清单**，不要顺手把 9074 从本表删掉。
 * - `3003`：**`MODEL_FAIL`（基础设施类，`all models failed`）** ——
 *   2026-09-19 端点迁移取证时补入。它是**旧 IDE 通道**对我方新池请求的恒定回复，
 *   语义是「服务端这一侧没有可用后端」，与具体账号无关：换号只会拿同一个
 *   基础设施故障再问一遍。归**可重试**（退避）而不是直报，是因为它明确是
 *   瞬时/容量类的失败，退避后可能就好了；
 * - `4000005`、`4050`–`4052`：**排队等待**。用户已确认按退避处理，
 *   理由见 {@link classifyTraeCnError} 的说明。
 */
export const TRAE_CN_BACKOFF_CODES: readonly number[] = [4007, 3004, 9074, 3003]

/**
 * 排队/等待码（**不换号**，按退避处理）。
 *
 * 与 {@link TRAE_CN_BACKOFF_CODES} 分开列，是因为它们的语义不同但动作相同：
 * 前者是「你请求太快」，后者是「服务端忙，你在队列里」。
 *
 * 为什么排队**不换号**：排队是**全局**状态（服务端容量问题），不是某个账号
 * 的问题 —— 换号只会把同一个排队问题再问一遍，还额外消耗另一个账号的一次
 * 往返与额度。正确处置是退避重试同一账号。
 */
export const TRAE_CN_QUEUE_CODES: readonly number[] = [4000005, 4050, 4051, 4052]

/**
 * 直报码（**不换号、不退避**）。
 *
 * - `4001`：参数错误；
 * - `4006`：请求超长（上下文超限）；
 * - `4023`：模型不存在；
 * - `4022`：⚠️ **上下文窗口溢出**（2026-09-21 单变量定案）—— 与 `4006` **同类
 *   但不同成因**，见 {@link TRAE_CN_CONTEXT_OVERFLOW_CODES}。它同样直报，且
 *   同样映射 `CONTEXT_WINDOW_EXCEEDED`（触发 DSH 的自动压缩重试）。
 *
 * 四者都是**确定性**失败：同样的请求换任何账号都会得到同一个结果，
 * 换号与退避都只是浪费往返，必须立刻把原因交给用户/模型。
 *
 * ⚠️ **「未知码一律直报不猜动作」这条原则与 `4022` 的关系**（防后人误读）：
 * `4022` **不是未知码**。它此前不在任何表里，走的是第 4 条「未知码直报」的
 * 保守默认 —— 那条默认的前提是「码的语义未定，先直报把真机样本逼出来」。本次
 * 已经拿到**单变量定案**（见 {@link TRAE_CN_CONTEXT_OVERFLOW_CODES} 的阈值），
 * 语义从「未知」变成「已知」，故按 4006 同款处理。**该原则本身一个字未改**：
 * 尚未取证的业务码仍然一律直报、不猜动作。
 */
export const TRAE_CN_FATAL_CODES: readonly number[] = [4001, 4006, 4023, 4022]

/**
 * 「**上下文窗口溢出**」业务码：`4006` 与 `4022`。
 *
 * ## 为什么两个码都要，而不是只留一个
 *
 * 它们是**两种不同的超限**，真机各有一份证据：
 *
 * | 码 | 真机语义 | 证据形态 |
 * |---|---|---|
 * | `4006` | 请求超长 | 表内既有条目（`prompt too long` 文案） |
 * | `4022` | **prompt token 超过上游上限** | HTTP 200 + SSE 流内 `event:error` 帧，`{"code":4022,"message":"We're sorry, your prompt tokens have exceeded the maximum limit."}` |
 *
 * ## `4022` 的阈值（精确钳制，2026-09-21）
 *
 * 同一个请求只改 prompt token 数：
 *
 * - **998 161 token → 成功**；
 * - **1 002 248 token → 失败**（`4022`）。
 *
 * ⇒ 边界就在 **≈ 1 000 000 token** 附近（模型窗口约 1M）。**同请求降 token 即
 * 成功、与字节量无关、与账号无关** —— 这正是「上下文溢出」而不是「账号问题」
 * 的定义。另有一条排除性证据：`4 KB → 1.5 MB` 十一档字节矩阵**全部 HTTP 200
 * 正常收尾**，故**不存在字节墙**，`4022` 只可能由 token 数触发。
 *
 * ## 为什么必须映射成 `CONTEXT_WINDOW_EXCEEDED`（而不是普通直报）
 *
 * 因为那是**宿主唯一的补救路径**：DSH 对 `failure.code === CONTEXT_WINDOW_EXCEEDED`
 * 的失败会**自动压缩上下文并重试**（`isContextWindowExceededError` /
 * `CONTEXT_WINDOW_EXCEEDED_CODE`，另见 `buddy-adapter.ts` 同款接线）。若按普通
 * `fail` → `INVALID_REQUEST` 直报，用户拿到的是一条**致命错误**：既不会压缩、
 * 也不会重试，1M token 的长会话从此**彻底不可用**，而它其实只需压缩一次即可
 * 继续。故这是一个**功能性必需**的映射，不是措辞偏好。
 *
 * ## 与「未知码不猜动作」的关系
 *
 * `4022` **不是未知码**（见 {@link TRAE_CN_FATAL_CODES} 的说明）：它是**已单变量
 * 定案**的窗口溢出码，阈值、排除项、同请求对照三件证据齐备。
 * 不猜动作 ≠ 拿到证据后仍不动作。
 */
export const TRAE_CN_CONTEXT_OVERFLOW_CODES: readonly number[] = [4006, 4022]

/**
 * 本次取证的窗口溢出码（`4022`）。
 *
 * 单独起一个常量而不是在代码里写 `4022` 字面量，是因为它有一个**专属**行为：
 * 只有它会在终报文案上追加中文说明（见 {@link traeCnContextOverflowHint}）。
 * 写成字面量的话，「为什么 4006 没有这句」这个问题就只能靠读上下文猜。
 */
export const TRAE_CN_WINDOW_OVERFLOW_CODE = 4022

/**
 * `4022`（上下文窗口溢出）在错误文案后追加的中文说明。
 *
 * ## 为什么只给 `4022` 加、不给 `4006` 加
 *
 * 两个码的**映射完全相同**（都进 `CONTEXT_WINDOW_EXCEEDED`），但本次只新增
 * `4022` 的说明：`4006` 的文案已是既成行为，改它属于**未经要求的变更** ——
 * 一个已有真机历史的码，其用户可见文案要改应当有它自己的理由与验证。
 * `tests/unit/trae-cn-adapter.spec.ts` 有一条断言反向钉死「`4006` 的文案里
 * 没有这句话」，防后人「顺手统一」。
 *
 * ## 为什么这句话必须有
 *
 * `CONTEXT_WINDOW_EXCEEDED` 的效果是**宿主自动压缩上下文并重试**，这对用户是
 * 一件「什么都没做，它自己好了」的事；不说明的话，用户看到上游那句
 * `your prompt tokens have exceeded the maximum limit` 只会以为会话废了，
 * 从而手动去开新会话（丢掉全部历史）—— 而正确做法是**什么都不做，等它压缩完**。
 */
export const TRAE_CN_CONTEXT_OVERFLOW_HINT =
  '（上下文超出上游上限，DSH 将自动压缩上下文后重试；无需手动开新会话）'

/**
 * 若业务码是 {@link TRAE_CN_WINDOW_OVERFLOW_CODE}，返回中文说明；否则返回空串。
 *
 * 上游原文**必须保留**（调用方是在原文后面拼接，不是替换）：真机排障要靠它
 * 与字节文档对上号。本函数的返回值永远以空串或一整句括号说明收尾，
 * 调用方可以无条件用 `+` 拼接而不产生悬挂空格。
 */
export function traeCnContextOverflowHint(code: TraeCnErrorCode | undefined): string {
  return normalizeTraeCnCode(code) === TRAE_CN_WINDOW_OVERFLOW_CODE
    ? TRAE_CN_CONTEXT_OVERFLOW_HINT
    : ''
}

/** 上述四类换号码的并集（供实现处一次性判「是否换号类」）。 */
export const TRAE_CN_SWITCH_CODES: readonly number[] = [
  ...TRAE_CN_RATE_LIMIT_CODES,
  ...TRAE_CN_QUOTA_CODES,
  ...TRAE_CN_ACCOUNT_INVALID_CODES,
  ...TRAE_CN_RISK_CONTROL_CODES,
]

/**
 * 业务码的两个输入形态。
 *
 * 上游在不同帧里可能给数字（`{"code":4008}`）或字符串（`{"code":"4008"}`），
 * 客户端源码里两种都出现过，故两个都收。
 */
export type TraeCnErrorCode = number | string

/** {@link classifyTraeCnError} 的入参。 */
export interface TraeCnErrorInput {
  /**
   * HTTP 状态码。
   *
   * **几乎总是 200** —— Trae 把业务失败放在 SSE 的 `event:error` 帧里。
   * 只有网关/网络层失败才会给出非 200，届时 {@link sseErrorCode} 通常缺失，
   * 本参数就是**唯一**判据。省略视为「未知」，等价于 200。
   */
  httpStatus?: number
  /** SSE `event:error` 帧里的业务码；缺失表示这不是业务错误。 */
  sseErrorCode?: TraeCnErrorCode
}

/** 把任意形态的业务码归一化成数字；非法值返回 undefined。 */
export function normalizeTraeCnCode(code: TraeCnErrorCode | undefined): number | undefined {
  if (code === undefined) return undefined
  if (typeof code === 'number') return Number.isFinite(code) ? code : undefined
  const trimmed = code.trim()
  if (trimmed.length === 0) return undefined
  // 只接受**整串是整数**的写法：`"4008"` 是码，`"code=4008"` 之类不是，
  // 后者若被 parseInt 静默截取会把诊断文本误判成业务码。
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** 判定业务码是否落在某个码表里。 */
function inCodes(codes: readonly number[], code: number | undefined): boolean {
  return code !== undefined && codes.includes(code)
}

/**
 * 按「业务码 + HTTP 状态码」判定失败处置动作。
 *
 * ## 判定顺序（即优先级，不要重排）
 *
 * 1. **业务码命中换号表** → `'switch-account'`；
 * 2. **业务码命中退避表（含排队）** → `'backoff'`；
 * 3. **业务码命中直报表** → `'fail'`；
 * 4. **业务码未知（有值但不在任何表里）** → `'fail'` —— 直报并**带上原始码**。
 *    这是刻意的保守默认：未知码可能是积分耗尽（真实码 T3 尚未实测到）之类的
 *    终态，此时换号会把一个确定性的失败放大成 N 次无用请求；直报能让真机
 *    第一次遇到就把码暴露在错误文案里，一步即可校准。
 * 5. 无业务码时按 HTTP 兜底：
 *    - `401` / `403` → `'switch-account'`（凭据被拒 ⇒ 换个账号试；
 *      适配器在此之前还会先做一次静默续期）；
 *    - `429` / `408` / `5xx` → `'backoff'`（网关级限流与瞬时故障都是
 *      「稍后重试」语义，与具体账号无关）；
 *    - 其余（含 200 与非 2xx 的 4xx）→ `'fail'`。
 *
 * 为什么业务码**优先于** HTTP 状态码：状态码在这些场景里几乎恒为 200，
 * 反过来判会把所有业务失败都归成 `'fail'`，换号与退避机制整体失效。
 *
 * @param input - HTTP 状态码与业务码。
 * @returns 该次失败应执行的动作。
 */
export function classifyTraeCnError(input: TraeCnErrorInput): TraeCnErrorAction {
  const code = normalizeTraeCnCode(input.sseErrorCode)

  if (code !== undefined) {
    if (inCodes(TRAE_CN_SWITCH_CODES, code)) return 'switch-account'
    if (inCodes(TRAE_CN_BACKOFF_CODES, code) || inCodes(TRAE_CN_QUEUE_CODES, code)) return 'backoff'
    if (inCodes(TRAE_CN_FATAL_CODES, code)) return 'fail'
    // 未知码：直报（见上方第 4 条）。
    return 'fail'
  }

  const status = input.httpStatus
  if (status === undefined) return 'fail'
  if (status === 401 || status === 403) return 'switch-account'
  if (status === 429 || status === 408) return 'backoff'
  if (status >= 500) return 'backoff'
  return 'fail'
}

/** 该动作是否应当触发「换下一个账号」（而不是退避或直接报错）。 */
export function shouldSwitchTraeCnAccount(action: TraeCnErrorAction): boolean {
  return action === 'switch-account'
}

/**
 * 该动作是否为「退避重试」（**不换号**）。
 *
 * 适配器据此抛**可重试**错误码，把节奏交还给 DSH 的重试层。
 */
export function isTraeCnBackoff(action: TraeCnErrorAction): boolean {
  return action === 'backoff'
}

/**
 * 该业务码的失败是否应**记为该模型的冷却标记**（让 Account Hub 亮出徽章）。
 *
 * 覆盖：
 * - 限流码（{@link TRAE_CN_RATE_LIMIT_CODES}）—— 等一会儿就好；
 * - 额度码（{@link TRAE_CN_QUOTA_CODES}）—— 等周期重置或充值；
 * - 风控码（{@link TRAE_CN_RISK_CONTROL_CODES}）—— 通常有时效，会自动解除。
 *
 * **刻意不覆盖账号失效码**（{@link TRAE_CN_ACCOUNT_INVALID_CODES}）：
 * 那种情况唯一的解法是**重新登录**，而不是等一个重置时刻。给它记一个
 * 「该模型限流 N 分钟」的徽章是虚假信息 —— 用户会照着徽章等，等完仍然失败。
 * 这与 `lobsterai-errors.ts` 里「徽章的含义必须是这个模型受限，而不是
 * 这个账号出过错」是同一条原则。
 *
 * 无业务码的 HTTP 兜底路径（401/403/429/5xx）**一律不记**：那些是传输/网关层
 * 现象，无法归属到「某个模型」上。
 */
export function recordsTraeCnCooldown(code: TraeCnErrorCode | undefined): boolean {
  const normalized = normalizeTraeCnCode(code)
  return inCodes(TRAE_CN_RATE_LIMIT_CODES, normalized)
    || inCodes(TRAE_CN_QUOTA_CODES, normalized)
    || inCodes(TRAE_CN_RISK_CONTROL_CODES, normalized)
}

/**
 * 终报文案：换号循环**试不下去了**之后，追加给用户的那句「到底怎么了」。
 *
 * ## 为什么需要它（修复的缺陷）
 *
 * 换号循环试遍候选后抛的是**最后一次**失败的真实原因，形如
 * `trae-cn: Your requests have exceeded the quota. (code=4008)`。这句话本身
 * 没错，但它有一个致命的**语境缺失**：用户不知道这是**所有账号都这样**
 * （⇒ 换号已无意义，需要充值/等重置）还是**碰巧这一个账号这样**
 * （⇒ 再点一次可能就好了）。同一句 `4008` 在两种语境下该做的事完全不同。
 *
 * 更糟的是措辞方向：`4008` 实测语义是**积分耗尽**（见
 * {@link TRAE_CN_CREDITS_EXHAUSTED_CODES}），而它此前与 `4021`/`5003`/`977`
 * 同列在「限流码」表里，用户读到的上游文案也常是频率类措辞 —— 于是他会
 * **反复重试或干等**一个永远不会到来的时刻，而正确动作是**去充值或换一个
 * 还有积分的账号**。
 *
 * ## 为什么按码分流，而不是对全部失败都说「积分耗尽」
 *
 * 只有**已实测确认**是耗尽语义的码（本表）才说这句话。其余失败（未知码、
 * 账号失效、风控、HTTP 层）保持原样 —— 给一个「参数错误」追加「积分已耗尽」
 * 是把用户引向错误的解法，比不说更糟。这与
 * {@link recordsTraeCnCooldown} 「徽章只覆盖有明确等待语义的码」是同一条原则。
 *
 * ## 池归属由调用方以**数据**传入，不在本函数里写死
 *
 * `poolLabel` 是「哪个积分池被耗尽」的可读名（如 `'通用积分'`）。刻意做成参数
 * 而不是常量：池的归属是**协议事实**，将来上游若改分池口径，改的是传参而不是
 * 本函数。当前 `4008` = 通用池耗尽有单变量实测证据。
 *
 * ## `scope` 决定主语，**绝不能一律说「全部账号」**
 *
 * 换号循环有三条退出路径，只有一条能支撑「全部账号」这句话：
 *
 * | scope | 含义 | 文案主语 |
 * |---|---|---|
 * | `'pool-exhausted'` | 池里**再没有**可试的账号了 | **全部账号** |
 * | `'rotate-cap'` | 换号次数达上限（`TRAE_CN_MAX_ROTATE`）就停了 | **已尝试的账号**（并声明池中可能还有未试的） |
 * | `undefined` | 没有账号池 / 非换号类失败 / 已产出正文 | **不追加**（此时谈「账号」是编造） |
 *
 * 反例说明为什么必须分开：池里有 5 个账号、换号上限是 3 —— 若 cap 路径也报
 * 「全部账号已耗尽」，用户会去给 5 个账号全部充值，而其中 2 个可能根本没问题。
 *
 * ## 「等待」与「耗尽」的区分（刻意保留两种措辞）
 *
 * 码在 {@link TRAE_CN_CREDITS_EXHAUSTED_CODES} 里 → 「已**耗尽**」（确定性，
 * 不会自己好）；在 {@link TRAE_CN_RATE_LIMIT_CODES} /
 * {@link TRAE_CN_QUOTA_CODES} 里但**不在**耗尽表 → 「**仍在冷却或限额中**」
 * （可能自愈，`Account Hub` 的徽章会显示重置时刻）。两者都告诉用户
 * 「不是这一个账号的问题」，但只有前者会说「等也没用」。
 *
 * ⚠️ **`rotate-cap` 只与「耗尽」措辞组合**：cap 是「我提前停了」，与「仍在冷却中」
 * 组合会得到「已尝试的账号都在冷却中（池中可能还有未尝试的）」—— 逻辑没错但
 * 信息量为负（用户在冷却语境下本来就会再试），故该组合**返回空串**。
 *
 * ## 这里曾有一个「证据强度」参数（已随第二条 Trae 路径移除）
 *
 * 原有一个必填的 `semantics` 参数，用来区分「同厂商同码、两条路径证据强度
 * 不同」—— 另一条（TraeWork 网页协议）的码表整体未标定，故只能说「已用尽或
 * 受限」而不能复述「已耗尽」。官方已把 TraeWork 通道并入通用通道，那条路径已
 * 整体移除，于是**唯一剩下的调用方就是实测过的那条**，这个维度不再有区分对象。
 *
 * ⚠️ **不要为「形态对称」把它加回来**：没有第二个取值可传的参数是纯粹的仪式。
 * 将来若真出现第三条 Trae CN 路径且其码表未标定，正确的做法是**先取证**
 * （像 `4008` 那样做单变量实测），而不是预先给它一个「未验证」的措辞通道。
 *
 * @param code - 最后一次失败的业务码（原始形态，数字或字符串）。
 * @param poolLabel - 被耗尽/受限的积分池可读名（如 `'通用积分'`）。
 * @param scope - 换号循环的退出原因（见 {@link TraeCnTerminalScope}）；
 *   `undefined` 表示「没有池 / 不该谈账号」，此时一律返回空串。
 * @returns 追加到错误文案末尾的一句中文说明；无话可说时返回**空串**
 *   （调用方据此决定是否拼接，不留悬挂空格）。
 */
export function traeCnCreditsExhaustedHint(
  code: TraeCnErrorCode | undefined,
  poolLabel: string,
  scope: TraeCnTerminalScope | undefined,
): string {
  const normalized = normalizeTraeCnCode(code)
  if (normalized === undefined || scope === undefined) return ''

  const exhausted = inCodes(TRAE_CN_CREDITS_EXHAUSTED_CODES, normalized)
  const limited = inCodes(TRAE_CN_RATE_LIMIT_CODES, normalized)
    || inCodes(TRAE_CN_QUOTA_CODES, normalized)
  // 其余码（未知码 / 账号失效 / 风控 / 直报类）：**刻意不加** ——
  // 给一个「参数错误」追加「积分已耗尽」会把用户引向错误的解法。
  if (!exhausted && !limited) return ''
  // cap + 冷却：见上方 ⚠️。
  if (scope === 'rotate-cap' && !exhausted) return ''

  const atPoolEnd = scope === 'pool-exhausted'
  const subject = atPoolEnd
    ? `全部账号的 Trae CN ${poolLabel}`
    : `已尝试的账号的 Trae CN ${poolLabel}`
  const tail = atPoolEnd ? '' : '（换号次数已达上限，池中可能还有未尝试的账号）'

  if (exhausted) {
    return `（${subject}均已耗尽：换号已无济于事，请充值或等待额度周期重置；这不是频率限流，稍后重试不会自愈）${tail}`
  }
  return `（${subject}均在冷却或限额中：可在账号中心查看重置时刻，稍后重试）`
}

/**
 * 「为什么这轮试不下去了」——决定终报文案的主语（见
 * {@link traeCnCreditsExhaustedHint}）。
 *
 * 由**适配器的换号循环**在退出点判定后传入，而不是由提示函数自己猜：
 * 只有循环知道自己是走到了哪一条 `break`。
 */
export type TraeCnTerminalScope =
  /** 池里再没有可试的账号（`getAvailableAccount` 返回空 / 候选已被 `tried` 排除）。 */
  | 'pool-exhausted'
  /** 换号次数到达上限就停了，池中**可能还有**未尝试的账号。 */
  | 'rotate-cap'

