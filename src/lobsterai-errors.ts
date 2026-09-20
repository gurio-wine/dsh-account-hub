/**
 * LobsterAI 上游错误分类。
 *
 * 移植自 `lobsterai2api/internal/upstream/classify.go`（Go）的 `Classify()`：
 * 把 HTTP 状态码 + 响应体文本判定成有限几类，供上层决定「该换号还是该报错」。
 *
 * ## 与 Go 版的**关键分歧**：只移植「分类」，不移植「冷却状态机」
 *
 * Go 的 `internal/pool` 会在分类之后自动执行
 * `Cooldown(CoolHard, 12h)` / `Disable(uid)` —— 表现为账号被**静默停用**，
 * 用户只能从 `/status` 的一个 `reason` 字段里看到原因。
 *
 * 本插件刻意不这样做：账号池只有 `modelRateLimits`（模型级重置时间）与
 * 用户手工的 `enabled` 开关，Account Hub 面板上有具体的限流徽章与「重测 / 重置」
 * 按钮。设计哲学是「如实展示 + 用户可主动验证」（见 `src/account-probe.ts`
 * 模块头注释），把自动禁用搬进来会与这套 UI 语义冲突。
 *
 * 因此本模块**只有纯函数**，无副作用；`hard-credit` 的识别尤其重要 ——
 * 它是 LobsterAI 最主要的失败模式（免费积分用尽）。
 *
 * ## 相对 Go 版的一处**新增**语义：上下文窗口溢出（`context-window`）
 *
 * Go 的 `Classify()` **没有**这一类 —— 它把窗口溢出当成普通 4xx/5xx 处理，
 * 于是长会话一旦越过窗口就只能把裸错误抛给用户。本插件补上它，并且
 * **只做一件事**：让适配器把该失败映射成 harness 的 `CONTEXT_WINDOW_EXCEEDED`，
 * 交给 DSH 的自动压缩补救。理由见 {@link isLobsteraiContextWindowError}。
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'

/**
 * 上游错误类别。
 *
 * 顺序与 Go 版 `ErrKind` 常量一致（`context-window` 是后插的本插件新增项，
 * 见模块头注释），但这里用字符串字面量而非数字：
 * 字号在日志与测试断言里可读性差，且本插件不做数值比较。
 */
export type LobsteraiErrorKind =
  /** 成功（HTTP < 400 且未命中任何关键词）。 */
  | 'none'
  /** 余额/积分不足 → Go 侧会做长冷却（12h）。本插件只标记限流。 */
  | 'hard-credit'
  /** 429 软限流 → Go 侧短冷却（60s）。 */
  | 'soft-rate'
  /** 会话终止：refresh_token 被拒（40100 / 40101），只能重新登录。 */
  | 'session-dead'
  /**
   * 本次请求的 prompt 超出模型上下文窗口。
   *
   * **不换号、不退避、不记徽章**，映射 `CONTEXT_WINDOW_EXCEEDED` 交给宿主压缩
   * 后重试（判据与理由见 {@link isLobsteraiContextWindowError}）。
   */
  | 'context-window'
  /** 上游偶发 404。Go 侧短冷却且**不累计** errCount（防雪崩）。 */
  | 'not-found'
  /** 5xx 上游故障。 */
  | 'server'
  /** 其他 4xx / 业务错误。 */
  | 'client'

/**
 * 余额不足关键词（对齐 `classify.go:55-60` 的 `hardMarkers`）。
 *
 * 中英双通道是必需的：LobsterAI 是网易有道系产品，同一后端在不同场景下
 * 会返回中文或英文文案（实测两种都出现过），只匹配一种会漏判。
 *
 * 比较策略（见 {@link classifyLobsteraiError}）：英文走 `/i` 不区分大小写，
 * 中文走原文包含 —— 中文没有大小写概念，统一转小写再比也等价，
 * 但保留原文比较可避免极端情况下 `toLowerCase()` 改变字符数量的干扰。
 */
export const LOBSTERAI_HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit', 'freecreditsused', 'free credits used',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分', '积分耗尽',
]

/**
 * 会话终止标记（对齐 `classify.go:63` 的 `sessionDeadMarkers`）。
 *
 * `40100` / `40101` 是 LobsterAI 刷新被拒的业务码 —— 终态，重试无意义。
 */
export const LOBSTERAI_SESSION_DEAD_MARKERS: readonly string[] = [
  '40100', '40101', 'token rejected', 'refresh token was rejected',
]

/** HTTP 402 Payment Required：最直接的「余额不足」信号。 */
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_NOT_FOUND = 404

/**
 * 判定错误体是否为「本次请求超出模型上下文窗口」。
 *
 * 命中即归 {@link LobsteraiErrorKind} 的 `context-window`，由适配器映射成
 * harness 的 `CONTEXT_WINDOW_EXCEEDED` —— 那是**宿主唯一的补救路径**：
 * DSH 的 `compaction-basic` 监听 `agent/request-error`，**只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败**自动压缩上下文并重试。
 * 不映射的话，长会话撞上窗口后拿到的是一个不可重试的 `HTTP_400/5xx`，
 * 会话从此彻底不可用 —— 与 Trae CN 的 `4006` / `4022` 是同一个缺口、同一套修法。
 *
 * ## 判据：**复用 harness 的权威函数**，不自建关键词表
 *
 * 用 `@deepseek-ai/dsh-llm` 的 `isContextWindowExceededError`。自建一份关键词表
 * 必然与 DSH 自身的判断漂移，而「什么算上下文超限」的定义权在宿主手里
 * （与 `qoder-errors.ts` 的 `qoderHarnessErrorCode` 同一先例、同一理由）。
 *
 * LobsterAI 是 **OpenAI 兼容端点**，上游错误是标准 OpenAI 形态
 * （`{"error":{"message":"This model's maximum context length is N tokens...",
 * "code":"context_length_exceeded"}}`），其正则覆盖的正是这类措辞。
 *
 * ⚠️ **必须传「原始响应体」而不是 `errorDetail()` 的拼接短文本** —— 与
 * `buddy-adapter.ts` 的 `httpErrorCode` 同款陷阱：`errorDetail` 只挑出
 * `code` / `message` / `msg` 几个字段拼成一行，会把承载判据的
 * `error.code` / `error.type` / `displayMsg` 等字段**丢掉**，从而漏判。
 * 判定看完整报文、展示用归一化文本，两者职责不同。
 *
 * ## 与「未知业务码一律直报不猜动作」原则的关系
 *
 * **不冲突，因为这里根本没有「猜码」**。那条原则管的是「上游给了一个我们
 * 不认识的**业务码**，其语义未定，瞎猜动作就是编造」。本函数判的不是业务码，
 * 而是**错误文案的语义**：`isContextWindowExceededError` 认的是「请求超出
 * 模型上下文」这一**明确表述**（结构化 `context_length_exceeded`、或
 * `prompt is too long for this model` 这类完整句子）。判据来自上游自己的
 * 措辞，不是我们臆测的；这与 buddy / codearts / trae-cn / qoder 四条线既有
 * 的 `CONTEXT_WINDOW_EXCEEDED` 映射是**同一判据、同一先例**。
 *
 * 未命中时**原分类一个字不变**（该 429 还是 429，该 client 还是 client），
 * 故这是一个**只增不减**的识别，不会让任何既有路径改道。
 *
 * ## ⚠️ 已知缺口：判定只认英文，**中文超限文案命不中**
 *
 * `isContextWindowExceededError` 的四条正则全是英文（`context length exceeded` /
 * `maximum context length` / `too long for this model` / `exceeds … context`）。
 * 已用插件链接的 dsh-llm 副本逐条实测：`{"message":"上下文超出上限"}` 与
 * `{"message":"请求内容过长"}` 均返回 **false**。
 *
 * 而 LobsterAI 是网易有道系产品，**中英双通道是它的现实**（`hardMarkers` 之所以
 * 做成双语就是这个原因，注释里写着「实测两种都出现过」）。所以这条识别**可能漏掉
 * 中文表述的超限错误**，届时它仍会落回 `client`（400，不可重试）—— 即本缺陷在
 * 中文文案下**依然存在**。
 *
 * **明知有缺口却刻意不补**，理由有两条：
 * 1. **没有样本**。目前**没有**观测到 LobsterAI 用中文表达上下文超限；
 *    真机目录与错误体样本里超限相关的措辞一个中文例子都没有。按本项目的规矩
 *    （「没观察到的东西不猜」），为想象中的文案编关键词表就是编造。
 * 2. **补了会与宿主漂移**。自建中文关键词表等于在插件里维护第二份「什么算超限」
 *    的定义，而 DSH 只在带 `CONTEXT_WINDOW_EXCEEDED` 时才压缩 —— 两份定义一旦
 *    分叉，就会出现「插件认为是超限、宿主不认这个码」或反过来的静默不一致。
 *    判据的定义权必须留在宿主手里（这是选择复用而非自建的全部理由）。
 *
 * **翻案条件**：真机抓到一条中文的超限错误体（哪怕是 400 + 中文 message），
 * 把原文记进本注释与单测，再决定是补关键词表还是给上游提 issue。在那之前，
 * 缺口的正确处置是**如实记录**，不是猜一个补上。
 *
 * @param body - 响应体原文；空串返回 false。
 */
export function isLobsteraiContextWindowError(body: string): boolean {
  return body.length > 0 && isContextWindowExceededError(body)
}

/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * **判定顺序即优先级**（原样对齐 `classify.go:66-93`，**只插入一条**，且插入点
 * 刻意选在**不改变 Go 既有判定相对顺序**的位置），不要重排：
 *
 * 1. `402` → hard-credit（状态码最权威）
 * 2. body 含 hard 关键词 → hard-credit
 * 3. body 含 session-dead 标记 → session-dead
 * 4. body 命中上下文超限文案 → context-window（本插件新增，见下）
 * 5. `429` → soft-rate
 * 6. `404` → not-found
 * 7. `>= 500` → server
 * 8. `>= 400` → client
 * 9. 否则 none
 *
 * 为什么 body 关键词要**排在状态码之前**（除 402）：实测上游用 400 + 中文
 * 「积分不足」表达余额耗尽，只按状态码会把这类错误误判成 `client`（可重试），
 * 于是反复重试一个永远不会成功的账号。
 *
 * 又为什么 session-dead 要排在 429/404 之前：40100/40101 可能与 4xx 同时出现，
 * 会话已死时任何「换号重试」都没意义（该账号需重新登录），
 * 必须优先识别出来。
 *
 * **为什么新判据插在第 4 位**（而不是更靠前）：Go 的三条 body 判定（402、
 * hard 关键词、session-dead 标记）的相对顺序**一个都不能动** —— 模块头写明
 * 「判定顺序完全对齐 `classify.go`」。插在它们之后、状态码判定之前，可以同时
 * 满足两件事：① 不含超限文案时，**每一条既有分类的结果逐字节不变**；
 * ② 含超限文案时能拦住它 —— 否则它会先落到第 8 条的 `client`（400，不可重试），
 * 这正是本缺陷的核心。
 *
 * 与 hard-credit 的先后**在实践中不构成歧义**：`isContextWindowExceededError`
 * 认的是 `context_length_exceeded` 这类**结构化**表述，而 hard 表是
 * `no credit` 这类宽子串 —— 两侧关键词无交集，实测互不命中。
 *
 * ⚠️ **`context-window` 是「不换号」的类别**：见
 * {@link shouldRotateLobsteraiAccount} 的说明。
 *
 * @param status - HTTP 状态码
 * @param body - 响应体原文（JSON 或纯文本均可；关键词走子串匹配，
 *   上下文判定走 harness 的权威函数）
 */
export function classifyLobsteraiError(status: number, body: string): LobsteraiErrorKind {
  if (status === HTTP_PAYMENT_REQUIRED) return 'hard-credit'

  const lower = body.toLowerCase()
  for (const marker of LOBSTERAI_HARD_CREDIT_MARKERS) {
    // 英文走小写比较，中文走原文比较（中文无大小写，lower 后仍相等，属冗余保险）。
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard-credit'
  }
  for (const marker of LOBSTERAI_SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session-dead'
  }

  if (isLobsteraiContextWindowError(body)) return 'context-window'

  if (status === HTTP_TOO_MANY_REQUESTS) return 'soft-rate'
  if (status === HTTP_NOT_FOUND) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * 该类别是否应当触发「换下一个账号」（而不是直接把错误抛给用户）。
 *
 * **除成功与上下文超限外的每一类都换号**，对齐 Go 的 `handler.go:218-243`：
 * 那个 switch 的**每一个分支都以 `continue` 结尾**（`ErrHardCredit`、
 * `ErrSoftRate`、`ErrSessionDead`、`ErrNotFound`、default 全是），
 * 也就是「任何非 2xx 都轮转到下一个账号」，最多换 `MaxRotate`(3) 次，
 * 全部失败才把 `lastErr` 抛给客户端。注释里写得很直白：
 * default 分支「轮转下一个账号，不直接返回（防雪崩）」。
 *
 * ⚠️ 曾经的实现只对 `hard-credit` / `soft-rate` 换号，并在这段注释里
 * 声称「Go 对这种错误也是不换号（靠 NoteError 累计 3 次）」—— 那是**错的**：
 * `NoteError` 之后紧跟的就是 `continue`，计数只决定「换完之后要不要冷却」，
 * 不决定「要不要换」。少换号会让一个账号的偶发错误直接暴露给用户，
 * 而参考实现靠多账号掩盖它。
 *
 * ⚠️ **`context-window` 是唯一的例外，且不是「保守起见不换」而是「换了没用」**：
 * 上下文超限是**请求本身**的属性（prompt 太长），与账号、积分、限流全无关 ——
 * 换 N 个账号会打出 N 个必然失败的请求，最后还把真因埋在
 * 「所有账号均不可用」的终报里。正确处置是把原始失败立刻抛给宿主，
 * 由 DSH 压缩上下文后重试（同一判据见 {@link isLobsteraiContextWindowError}）。
 * 这与 Trae CN 的 `4006` / `4022`（同为「直报 + 映射 CWE」）是同一形状。
 *
 * 与 D2（不照搬自动冷却状态机）不冲突：**轮转**与**冷却**是两件事 ——
 * 前者是「这次请求换个人试试」，后者是「把这个账号标记为不可用一段时间」。
 * 本插件采纳前者（对齐 Go），不用后者（复用已有的 `modelRateLimits`）。
 */
export function shouldRotateLobsteraiAccount(kind: LobsteraiErrorKind): boolean {
  return kind !== 'none' && kind !== 'context-window'
}

/**
 * 该类别的失败是否应**记为该模型的限流标记**（让 UI 亮出「限额重置」徽章）。
 *
 * 只覆盖 Go 里真正调用 `Cooldown(...)` 的三类（`handler.go:221-237`）：
 * - `hard-credit` → `CoolHard`（12h）
 * - `soft-rate` → `CoolSoft`（60s）
 * - `not-found` → `CoolSoft`（60s）
 *
 * `session-dead` 与 default（server/client）在 Go 里分别走 `Disable` 与
 * `NoteError`，**都不写冷却时间**。本插件没有这两套机制（见 D2），
 * 因此它们只轮转、不留徽章 —— 否则一个 400 请求错误会被显示成
 * 「该模型限流 1 小时」，那是虚假信息。徽章的含义必须是
 * 「这个模型受限」，而不是「这个账号出过错」。
 *
 * ⚠️ **`context-window` 同样不记**（它按 `default` 分支自然落到「否」，此处只是
 * 把理由写明）：徽章的实际效果是让下一次选号**跳过**该账号，等价于一次隐式换号；
 * 而上下文超限与模型额度无关 —— 记上去会让用户在 Account Hub 看到一个
 * 「该模型限额重置」的徽章，去等一个永远不会改变结果的重置时刻。
 */
export function recordsLobsteraiRateLimit(kind: LobsteraiErrorKind): boolean {
  return kind === 'hard-credit' || kind === 'soft-rate' || kind === 'not-found'
}

/**
 * 该类别是否属于**终态**（重试无意义，只能重新登录）。
 *
 * 用途：`LobsteraiAuth.refresh()` 据此抛 `RefreshTokenExpiredError`，
 * 让 `RefreshScheduler` 停止续期并提示重新登录；其余错误走可重试路径。
 * 这是相对 Go 版的一处改进 —— Go 只判「响应里有没有 accessToken」，
 * 把网络抖动也当成了终态。
 */
export function isLobsteraiTerminalError(kind: LobsteraiErrorKind): boolean {
  return kind === 'session-dead'
}

/**
 * 把「类别 + 状态码」映射为 harness 的稳定错误码（`LlmError` 的 code）。
 *
 * 收敛成**一个**函数而不是留在适配器内联，理由与 `trae-cn` / `qoder` 两条线
 * 的同名函数一致：映射规则一旦分散，策略声明与三条抛出路径必然分叉
 * （历史上 `shouldRotateLobsteraiAccount` 沦为死代码就是同类问题，见计划
 * 文档 §7.4 的 C3）。
 *
 * 判定顺序即优先级：
 *
 * 1. `context-window` → `CONTEXT_WINDOW_EXCEEDED`（**唯一的自动压缩入口**）。
 *    必须排在状态码映射之前 —— 上游可用 4xx **或** 5xx 表达超限，
 *    按状态码走会得到 `INVALID_REQUEST` / `SERVER` 这种不可补救的死码。
 * 2. `hard-credit` → `QUOTA_EXCEEDED`。⚠️ 这是**既成行为的字面量**，
 *    不是 `@deepseek-ai/dsh-llm` 的 `QUOTA_EXCEEDED_CODE`（其值为 `'QUOTA'`）——
 *    两者不同值，且有测试与用户可见文案依赖现值，故**刻意不换成常量**
 *    （换掉属于「顺手统一」，会改变错误码本身）。
 * 3. 其余按 HTTP 状态码兜底（与原 `httpErrorCode` 逐字节一致）：
 *    `401/403 → AUTH`、`429 → RATE_LIMIT`、`400 → INVALID_REQUEST`、
 *    `>=500 → SERVER`、其余 `HTTP_<status>`。
 *
 * 注意 `session-dead` **不单独映射**：它按状态码落 `AUTH`（401 是它的典型形态），
 * 终态语义由 {@link isLobsteraiTerminalError} 在续期链路上承载，与本函数无关。
 *
 * @param kind - {@link classifyLobsteraiError} 的结论。
 * @param status - 该次失败的 HTTP 状态码。
 */
export function lobsteraiHarnessErrorCode(kind: LobsteraiErrorKind, status: number): string {
  if (kind === 'context-window') return CONTEXT_WINDOW_EXCEEDED_CODE
  if (kind === 'hard-credit') return 'QUOTA_EXCEEDED'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 上下文超限失败时追加的中文提示（**只加给 `context-window`**）。
 *
 * 上游原文（`prompt is too long for this model ...`）一字不改地保留在前 ——
 * 真机排障要与上游文档对上号；这里只在**后面**补一句用户真正需要知道的事：
 * 这不是账号问题，宿主会压缩上下文后自动重试，**不需要手动开新会话**。
 *
 * 形状与 `trae-cn` 的 `traeCnContextOverflowHint` 同款（那里对应 `4022`
 * 上下文溢出）。不加这句的话，用户看到的是一条裸英文错误，最自然的反应是
 * 反复重试或新建会话 —— 前者必然复现，后者白白丢掉历史。
 */
export const LOBSTERAI_CONTEXT_OVERFLOW_HINT
  = '（上下文已超出该模型上限，将自动压缩后重试；无需手动新建会话）'
