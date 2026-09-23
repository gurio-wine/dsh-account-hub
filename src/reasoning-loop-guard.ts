/**
 * 思考死循环检测（Reasoning Loop Guard）。
 *
 * ## 它解决的真实缺陷
 *
 * `workbuddy/deepseek-v4.1-flash` 报「已达到输出 token 上限，回答被截断」。
 * 排查确认**不是**参数沿用上一个模型（DSH 的 `prepareCall` → `resolveCallWithInfo`
 * 按**当前**模型解析 `maxTokens`；且同一会话 turn 1 未做任何切换就爆额度），
 * 而是模型思考陷入病态重复：
 *
 * ```
 * Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
 * ```
 *
 * `reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出，
 * 最终 `reasoningTokens == outputTokens == 128000`、`finish_reason: length`。
 *
 * ## 为什么单列一个纯函数模块
 *
 * 1. 判据是**纯函数**，与 SSE 解析、HTTP 形态、provider 协议全部无关 ——
 *    放进适配器里会被五份拷贝散开，也没有纯函数断言；
 * 2. 五个 provider 适配器（codearts / buddy / lobsterai / qoder / trae-cn）
 *    共用**同一份**判据，阈值调参只需改一处；
 * 3. 本模块**零依赖**（不 import 任何其它模块），便于直接单测。
 *
 * ⚠️ 本模块只负责**判定**，不负责中止。命中后的止损动作（丢弃后续增量、
 * `reader.cancel()` 中止上游、收尾发截断后的 block、`finish` 报 max-tokens）
 * 是各适配器的职责 —— 见各适配器 `consumeSse` 里的「止损」块。
 *
 * ## 判据选型（上游实测：正常 109 条 / 死循环 6 条真实样本）
 *
 * | 判据 | 正常误报 | 死循环命中 |
 * |---|---|---|
 * | n-gram 重复占比 | 0/109 | 2/3 |
 * | **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
 * | 尾部行周期 | 0/109 | 1/3 |
 *
 * 故取第二种。
 *
 * ⚠️ **「持续体量」这一层不可省**：实测 seq=401 在 14848/15795（94%）处被判
 * 局部循环，但它随即**自愈并产出了工具调用** —— 它的持续体量仅 1024 字符，
 * 被 `minLoopChars=2000` 正确排除；而三个真死循环的持续体量是 435,968 ~ 509,184。
 * 区分度极高。正常样本窗口去重率最低 0.149、死循环 0.017~0.031（**5 倍余量**）。
 *
 * ⚠️ **只应喂 `reasoning` 增量**：正文里的重复（代码块、列表、表格）是**正常输出**，
 * 喂进来会误伤。这是**调用方契约**，不是本模块的性质 —— 判据对重复本身是敏感的。
 */

/** {@link createReasoningLoopDetector} 的可调参数。 */
export interface ReasoningLoopDetectorOptions {
  /** 判定窗口大小（字符）。默认 3000。 */
  windowChars?: number
  /** 窗口内去重行比例低于此值视为局部循环。默认 0.35。 */
  maxDistinctLineRatio?: number
  /** 窗口内至少这么多非空行才参与判定。默认 40。 */
  minLines?: number
  /** 循环状态须持续这么多字符才确认中断。默认 2000。 */
  minLoopChars?: number
  /**
   * 内部切片大小（字符）。默认 64；**<1 会被钳到 1**，非有限值（`NaN` /
   * `Infinity`）回退默认 64 —— 归一化见 {@link resolveSliceChars}。
   *
   * 它使**触发结论**与 `cutAt > 0` 与调用方粒度无关；`cutAt` 数值精度受切片
   * 大小限制（调用方粒度小于切片大小时更精确：实测粒度 3 → 1614、10 → 1610、
   * ≥64 → 1600），触发时机也会随 delta 边界略有推迟。
   */
  sliceChars?: number
}

/** 思考死循环检测器。 */
export interface ReasoningLoopDetector {
  /**
   * 喂入一个 reasoning 增量；返回 true 表示**本次调用首次**确认死循环。
   * 确认后恒返回 false（幂等），调用方据此只处理一次。
   */
  observe(delta: string): boolean
  /** 是否已确认死循环。 */
  readonly detected: boolean
  /**
   * 截断点（字符偏移）：只保留 `[0, cutAt)` 的干净前缀。
   * 未检测到时为 undefined。
   */
  readonly cutAt: number | undefined
}

/**
 * 归一化 `sliceChars`：非有限值（NaN / Infinity）回退默认值，并钳到 ≥1。
 *
 * ⚠️ **必须钳下限**：`observe` 用 `offset += sliceChars` 推进切片循环，
 * 步长为 0 或负数会让循环永不推进 → **同步死循环、进程挂死**。
 * 而同步死循环**无法被测试框架的超时打断**（超时由事件循环 timer 实现），
 * 表现为整个测试进程永久挂住且零诊断 —— 故这里必须兜住，不能只靠调用方自觉。
 *
 * `NaN` 也必须兜：`Math.max(1, NaN)` 仍是 `NaN`，会让 `offset < delta.length`
 * 恒为 false → 判据**静默失效**（fail-open，不检测任何循环）。
 */
export function resolveSliceChars(raw: number | undefined): number {
  const value = raw ?? 64
  return Number.isFinite(value) ? Math.max(1, value) : 64
}

/**
 * 创建思考死循环检测器。判据与实测依据见模块头注释。
 *
 * ## 为什么内部要再切一次片（`sliceChars`）
 *
 * 判据的「持续体量」必须按**内部切片**累加，不能按调用方给的 delta 累加。
 * 旧实现 `runChars += delta.length` 直接采用调用方边界，于是单个 delta 大于
 * `minLoopChars` 时一次观察即满足阈值、`runStart` 落在该 delta 开头 →
 * `cutAt = 0` → **把回答截成空**；更糟的是会误伤「早期自愈」负样本
 * （它正是「零误报」结论的关键）。实测粒度 3000 时自愈样本被误触发。
 *
 * 真实流式帧极小（实测 1379 万帧：p99=10、max=95 字符），故逐帧调用的适配器
 * 不可达；但 codearts 适配器是**累积后一次性调用** → **真实可达**，必须兜住。
 *
 * ## `cutAt === 0` 的不可达性（默认参数下）
 *
 * 等价说法：默认参数下 `cutAt > 0` **必然**成立。下述论证**不依赖调用方粒度**：
 * 进入 looping 至少需 `minLines=40` 个非空行。`n` 个非空行**至少**占 `2n−1`
 * 字符（每行 ≥1 字符，行间 1 个换行），代入 `n ≥ 40` 得**至少 79 字符**；
 * 而任一片的长度恒 `≤ sliceChars`(64) < 79 ⇒ **首片结束时不可能已满足 40 行**
 * ⇒ `runStart` 最早只能落在**第二片开头**，即 `runStart ≥ 首片长度 ≥ 1`
 * ⇒ **`cutAt > 0`**。
 *
 * 若调用方**调大 `sliceChars`** 使单片即可容纳 ≥79 字符（即 ≥40 个非空行），
 * 或**下调 `minLines`**（两者都是既有可调项），首片即可能直接命中、
 * `runStart = 0` → **`cutAt = 0` 截空复现**。
 *
 * **实测（40 个非空行的重复体，单元 79 字符）**：`sliceChars=32` → `cutAt=64`、
 * `64` → `64`（默认参数，安全）；**`sliceChars=128` → `cutAt=0`**（截空）、
 * `256` → `0`。即约束的临界正在「单片 ≥79 字符」处，`128` 已越过它。
 * 调参时必须重新核验该约束。
 */
export function createReasoningLoopDetector(
  options: ReasoningLoopDetectorOptions = {},
): ReasoningLoopDetector {
  const windowChars = options.windowChars ?? 3000
  const maxDistinctLineRatio = options.maxDistinctLineRatio ?? 0.35
  const minLines = options.minLines ?? 40
  const minLoopChars = options.minLoopChars ?? 2000
  /** 内部切片大小；归一化与理由见 {@link resolveSliceChars}。 */
  const sliceChars = resolveSliceChars(options.sliceChars)

  let text = ''
  let detected = false
  let cutAt: number | undefined
  /** 当前连续循环段的起点（字符偏移）与已持续长度。 */
  let runStart = 0
  let runChars = 0

  /**
   * 喂入一个**固定小片**并推进状态机。
   *
   * ⚠️ `runChars += piece.length` 用的是**切片**长度而非调用方 delta 长度，
   * 理由见 {@link createReasoningLoopDetector} 的「为什么内部要再切一次片」。
   */
  function feedPiece(piece: string): boolean {
    text += piece
    // 只看尾部窗口：循环是「局部持续」现象，不必回溯全文。
    const window = text.slice(Math.max(0, text.length - windowChars))
    const lines = window.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const looping = lines.length >= minLines
      && new Set(lines).size / lines.length < maxDistinctLineRatio
    if (!looping) {
      // 恢复正常：清零持续计数，使「循环→正常→再循环」只认后一段。
      runStart = 0
      runChars = 0
      return false
    }
    if (runChars === 0) runStart = text.length - piece.length
    runChars += piece.length
    if (runChars < minLoopChars) return false
    detected = true
    cutAt = runStart
    return true
  }

  return {
    get detected(): boolean { return detected },
    get cutAt(): number | undefined { return cutAt },
    observe(delta: string): boolean {
      if (detected) return false
      if (delta.length === 0) return false
      // 把任意粒度的 delta 切成固定小片，使结论只取决于切片大小而非调用方边界。
      for (let offset = 0; offset < delta.length; offset += sliceChars) {
        if (feedPiece(delta.slice(offset, offset + sliceChars))) return true
      }
      return false
    },
  }
}

/**
 * 解析 `DSH_REASONING_LOOP_GUARD`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与本地 `isTruthyFlag`
 * 一类「默认关」的解析语义相反（对齐 `resolveHideWithoutAccountFlag`
 * —— `src/account-pool.ts` 末尾那个模块私有的「默认开」解析），故单列一个
 * **导出**函数，**不要混用**。
 */
export function resolveReasoningLoopGuardFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/** 思考死循环检测是否启用（读环境变量）。 */
export function isReasoningLoopGuardEnabled(): boolean {
  return resolveReasoningLoopGuardFlag(process.env.DSH_REASONING_LOOP_GUARD)
}
