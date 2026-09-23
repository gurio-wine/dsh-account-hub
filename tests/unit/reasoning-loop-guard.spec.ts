/**
 * 思考死循环检测（`src/reasoning-loop-guard.ts`）的回归测试。
 *
 * ## 真实缺陷
 *
 * `workbuddy/deepseek-v4.1-flash` 报「已达到输出 token 上限，回答被截断」。
 * 实测确认**不是**参数沿用上一个模型，而是模型思考陷入病态重复：
 *
 * ```
 * Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
 * ```
 *
 * `reasoning_tokens` 计入 `completion_tokens`，故思考停不下来 = 正文零产出，
 * 最终 `reasoningTokens == outputTokens == 128000`、`finish_reason: length`。
 *
 * ## 判据来源（全部实测）
 *
 * 窗口去重行比例 + 持续体量，是唯一「零误报 + 全命中」的方案：
 * 正常样本最低去重率 0.149，死循环 0.017~0.031（5 倍余量）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createReasoningLoopDetector,
  resolveReasoningLoopGuardFlag,
  resolveSliceChars,
} from '../../src/reasoning-loop-guard.js'

/** 读 `tests/fixtures/` 下的 fixture。 */
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

/** 按 chunk 模拟流式喂入，返回首次触发的偏移（未触发返回 undefined）。 */
function feedStreaming(text: string, chunkSize = 256): { triggeredAt?: number; cutAt?: number } {
  const detector = createReasoningLoopDetector()
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize)
    if (detector.observe(delta)) {
      return { triggeredAt: i + delta.length, cutAt: detector.cutAt }
    }
  }
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 阈值边界的**精确**锁定。
//
// ⚠️ 这些用例用**合成文本**而非 fixture —— 因为 fixture 只能证明「会触发」，
// 证明不了「阈值到底在哪」。三个判据参数各需一条可判定边界的构造：
// 临界值必须**恰好**落在一侧，否则调参把 40 改成 39、0.35 改成 0.40 都不会
// 有任何用例失败。
//
// 统一手法：`unit` = 每行占的字符数（含 `\n`），用**等长行**保证行数不受内容
// 影响，再用**二分 `minLines`** 直接量出窗口内的真实行数 —— 不靠 `floor` 心算。
//
// ⚠️ 别用 `floor(windowChars / unit)` 心算行数：窗口从尾部截取，其起点会落在
// **某一行中间**，那半行只要是非空的就仍算一行 —— 于是真实行数比 `floor`
// 多 1。实测 unit=75 → 40 行（3000/75=40 恰好整除，无半行）、
// unit=77 → **39** 行（`floor=38`，多出的正是被截断的那半行）。
// 下面每条断言都用「minLines=n 触发 / n+1 不触发」这一对来**锁定**行数。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 `count` 个等长非空行（每行 `unit − 1` 个字符 + `\n`）。
 *
 * @param distinct - 不同取值的个数（1 = 全同 → 去重比例 1/count）。
 */
function repeatedLines(unit: number, count: number, distinct = 1): string {
  const lines: string[] = []
  for (let i = 0; i < count; i += 1) {
    const value = distinct === 1 ? 'A'.repeat(unit - 1) : `v${i % distinct}`.padEnd(unit - 1, 'x')
    lines.push(value)
  }
  return lines.map(line => `${line}\n`).join('')
}

/**
 * 喂入合成文本（**切片粒度 = 行长**，使 `runStart` 恒落在行边界、`cutAt` 可预测），
 * 返回是否触发。
 */
function feedLines(text: string, unit: number, overrides: Parameters<typeof createReasoningLoopDetector>[0] = {}) {
  const detector = createReasoningLoopDetector({ sliceChars: unit, ...overrides })
  for (let i = 0; i < text.length; i += unit) {
    if (detector.observe(text.slice(i, i + unit))) {
      return { fired: true, cutAt: detector.cutAt }
    }
  }
  return { fired: false, cutAt: undefined as number | undefined }
}

describe('createReasoningLoopDetector / 阈值边界（40 行临界）', () => {
  // windowChars=3000、unit=75 ⇒ 窗口内容纳 40 个非空行（3000 是 75 的整数倍，
  // 窗口起点恰落在行边界上，故不多不少恰好 40）。
  it('窗口内恰好 40 个非空行且高度重复 → 触发（`>= minLines` 的闭区间侧）', () => {
    expect(feedLines(repeatedLines(75, 200), 75).fired).toBe(true)
  })

  it('窗口内行数不足 40 → 不触发（差一行就是不够）', () => {
    // unit=77 ⇒ 窗口内 **39** 行（用二分 minLines 量出来的真实值，不是 floor 心算）。
    const text = repeatedLines(77, 200)
    // 锁定行数确实是 39：38 触发、39 触发（说明 ≥39），而 40 不触发（说明 <40）。
    expect(feedLines(text, 77, { minLines: 38 }).fired).toBe(true)
    expect(feedLines(text, 77, { minLines: 39 }).fired).toBe(true)
    expect(feedLines(text, 77, { minLines: 40 }).fired).toBe(false)
    // 默认 minLines=40 下自然也不触发。
    expect(feedLines(text, 77).fired).toBe(false)
  })

  it('minLines 上下一格即翻转，证明临界正在 40', () => {
    const text = repeatedLines(75, 200) // 窗口内恰 40 行
    expect(feedLines(text, 75, { minLines: 40 }).fired).toBe(true)
    expect(feedLines(text, 75, { minLines: 41 }).fired).toBe(false)
    // 40 行全同 ⇒ 去重比例 1/40 = 0.025，远低于 0.35，故不触发只可能是行数不足。
    expect(feedLines(text, 75, { minLines: 39 }).fired).toBe(true)
  })
})

describe('createReasoningLoopDetector / 阈值边界（去重比例 0.35）', () => {
  // windowChars=3000、unit=75 ⇒ 窗口内恒 40 个非空行。
  // 去重比例 = distinct / 40，故 distinct=14 时恰为 0.350（不触发），13 时 0.325（触发）。
  it('去重比例 0.325（13/40）→ 触发', () => {
    expect(feedLines(repeatedLines(75, 200, 13), 75).fired).toBe(true)
  })

  it('去重比例恰好 0.350（14/40）→ **不触发**（判据是严格小于）', () => {
    expect(feedLines(repeatedLines(75, 200, 14), 75).fired).toBe(false)
  })

  it('去重比例 0.375（15/40）→ 不触发（上侧对照）', () => {
    expect(feedLines(repeatedLines(75, 200, 15), 75).fired).toBe(false)
  })

  it('maxDistinctLineRatio 可覆盖：把阈值抬到 0.4 后 0.375 也触发', () => {
    // 反向对照：证明上面的「不触发」确实来自比例判据而非其它原因。
    expect(feedLines(repeatedLines(75, 200, 15), 75, { maxDistinctLineRatio: 0.4 }).fired).toBe(true)
  })
})

describe('createReasoningLoopDetector / 阈值边界（持续体量 2000 字符）', () => {
  // 用 minLines=1 + maxDistinctLineRatio=1 让「局部循环」从第 3 个字符起恒为真，
  // 且 sliceChars=1 使 runChars **逐字符精确**累加 —— 于是 minLoopChars 的
  // 临界可被精确判定（否则受切片粒度四舍五入影响）。
  const ALWAYS = 'x\n'.repeat(4000)
  const loopOptions = { minLines: 1, maxDistinctLineRatio: 1, sliceChars: 1 }

  /**
   * 逐字符喂入并返回**首次触发时已喂入的字符数**（未触发返回 undefined）。
   *
   * ## 为什么 `runChars` 从第 3 片才开始累加（偏移量 = 2）
   *
   * `maxDistinctLineRatio: 1` 下判据是 `distinct / count < 1`，即需要**至少两行
   * 且不全同**才成立。逐字符看：
   *
   * | 片 | 内容 | `text` | 非空行 | 比例 | looping |
   * |---|---|---|---|---|---|
   * | 1 | `x` | `x` | 1 | 1/1 | 否 |
   * | 2 | `\n` | `x\n` | 1 | 1/1 | 否 |
   * | 3 | `x` | `x\nx` | 2 | 1/2 | **是** ← 首次进入，`runStart=2`、`runChars=1` |
   * | N≥3 | | | | | `runChars = N − 2` |
   *
   * （第 2 片的 `x\n` 经 `split('\n')` 得 `['x','']`，空行被 `filter` 去掉，
   * 故仍只有 **1** 个非空行 —— 这正是「偏移 2 而非 1」的原因。）
   *
   * 于是 `runChars >= minLoopChars` ⇔ `N − 2 >= minLoopChars`
   * ⇔ **在 `N = minLoopChars + 2` 处首次触发**。
   */
  const firesAt = (minLoopChars: number): number | undefined => {
    const detector = createReasoningLoopDetector({ ...loopOptions, minLoopChars })
    for (let i = 0; i < ALWAYS.length; i += 1) {
      if (detector.observe(ALWAYS.slice(i, i + 1))) return i + 1
    }
    return undefined
  }

  it('持续体量恰好达标即触发：minLoopChars=2000 → 第 2002 字符触发', () => {
    expect(firesAt(2000)).toBe(2002)
  })

  it('差一个字符不触发：minLoopChars=2001 → 第 2003 字符才触发', () => {
    // 与上一条合看即锁定「临界恰在 2000、且是闭区间（`< minLoopChars` 才 false）」：
    // 阈值 +1 则触发点也严格 +1（延迟一个字符），而不是被取整掩盖。
    expect(firesAt(2001)).toBe(2003)
  })

  it('下侧对照：minLoopChars=1999 → 第 2001 字符触发（早一格）', () => {
    expect(firesAt(1999)).toBe(2001)
  })
})

describe('createReasoningLoopDetector / 真实 fixture', () => {
  it('真实死循环文本必定触发，且远早于烧满额度', () => {
    const text = fixture('reasoning-loop.txt')
    const result = feedStreaming(text)
    expect(result.triggeredAt).toBeDefined()
    // 必须尽早触发：真实场景里循环会一路烧到 128000 token。
    expect(result.triggeredAt!).toBeLessThan(text.length * 0.5)
    expect(result.cutAt).toBeDefined()
  })

  it('真实正常思考零触发（不得打断正常回答）', () => {
    const text = fixture('reasoning-normal.txt')
    expect(feedStreaming(text).triggeredAt).toBeUndefined()
  })

  // 关键回归：seq=401 在 14848/15795（94%）处被判循环，但它随即自愈并
  // 产出了工具调用。若只看去重比例就会打断一个本会成功的响应 ——
  // 「持续体量 ≥2000」正是为排除它而加（它的持续体量仅 1024）。
  it('早期自愈样本不触发（持续体量不足）', () => {
    const text = fixture('reasoning-self-heal.txt')
    expect(feedStreaming(text).triggeredAt).toBeUndefined()
  })

  it('触发后幂等：再次 observe 返回 false 且 cutAt 不变', () => {
    const detector = createReasoningLoopDetector()
    const loop = fixture('reasoning-loop.txt')
    let fired = 0
    for (let i = 0; i < loop.length; i += 256) {
      if (detector.observe(loop.slice(i, i + 256))) fired += 1
    }
    expect(fired).toBe(1)
    const cutAt = detector.cutAt
    expect(detector.observe('又来一段')).toBe(false)
    expect(detector.cutAt).toBe(cutAt)
  })

  it('正文式的结构化重复：判据对重复敏感，正文安全靠调用方契约（适配器只喂 reasoning）', () => {
    // ⚠️ 这条测试断言的是**调用方契约**：判据只应喂 reasoning 增量。
    // 一段 400 行、3 种取值的重复代码（10399 字符、去重比例 0.0075）若被喂进
    // 判据，**会**触发（持续体量 10399 远超 2000）—— 所以正文绝不能喂进来。
    // 正文路径本身无法在这里断言（它压根不调用 observe），故本用例只锁
    // 「同段文本喂给判据必触发」这一反向对照，并以此说明契约为何必须存在。
    const repeated = Array.from({ length: 400 }, (_unused, i) => `const value${i % 3} = compute();`).join('\n')
    const detector = createReasoningLoopDetector()
    expect(detector.observe(repeated)).toBe(true)
  })

  it('空增量不触发、不破坏状态', () => {
    const detector = createReasoningLoopDetector()
    expect(detector.observe('')).toBe(false)
    expect(detector.detected).toBe(false)
  })

  it('阈值可覆盖（便于将来调参）', () => {
    const detector = createReasoningLoopDetector({ minLoopChars: 100_000 })
    const loop = fixture('reasoning-loop.txt')
    for (let i = 0; i < loop.length; i += 256) detector.observe(loop.slice(i, i + 256))
    // 阈值调到 10 万后，1.5 万字符的 fixture 不足以触发。
    expect(detector.detected).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 回归：判据必须与**调用方 delta 粒度**无关。
//
// 旧实现 `runChars += delta.length` 直接采用调用方边界，于是单个 delta 大于
// minLoopChars(2000) 时一次观察即满足阈值、runStart 落在 delta 开头 →
// cutAt=0 → 把回答截成空；且会误伤「早期自愈」负样本。
//
// ⚠️ 这条脆弱性在真实流式下对四个逐帧适配器不可达（真实帧 max=95 字符），
// 但 codearts 适配器是累积后一次性调用 → **真实可达**。
// ─────────────────────────────────────────────────────────────────────────────
describe('createReasoningLoopDetector / 粒度无关性', () => {
  it('任意粒度下结论一致，且 cutAt 绝不为 0（不得把回答截成空）', () => {
    const loop = fixture('reasoning-loop.txt')
    const heal = fixture('reasoning-self-heal.txt')
    const normal = fixture('reasoning-normal.txt')
    // 覆盖真实帧粒度（3~10）到整段一次性调用（65536）。
    for (const granularity of [3, 10, 256, 2048, 3000, 65536]) {
      const run = (text: string) => {
        const detector = createReasoningLoopDetector()
        for (let i = 0; i < text.length; i += granularity) {
          if (detector.observe(text.slice(i, i + granularity))) {
            return { fired: true, cutAt: detector.cutAt }
          }
        }
        return { fired: false, cutAt: undefined as number | undefined }
      }
      const loopResult = run(loop)
      // 死循环在任何粒度下都必须触发。
      expect({ granularity, fired: loopResult.fired }).toEqual({ granularity, fired: true })
      // 且绝不能把回答截成空（cutAt=0 就是截空）。
      expect(loopResult.cutAt!).toBeGreaterThan(0)
      // 两个负样本在任何粒度下都不得触发（尤其 2048+ 曾误伤自愈样本）。
      expect({ granularity, fired: run(heal).fired }).toEqual({ granularity, fired: false })
      expect({ granularity, fired: run(normal).fired }).toEqual({ granularity, fired: false })
    }
  })

  it('cutAt 指向循环起点而非 delta 边界（大 delta 下仍精确）', () => {
    // 用整段一次性喂入：旧实现会得到 cutAt=0，新实现应落在循环起点附近。
    const loop = fixture('reasoning-loop.txt')
    const detector = createReasoningLoopDetector()
    detector.observe(loop)
    expect(detector.detected).toBe(true)
    // 循环起点实测约 1536~1614（切片大小决定精度），关键是不能为 0。
    expect(detector.cutAt!).toBeGreaterThan(1000)
    expect(detector.cutAt!).toBeLessThan(2500)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 回归：`sliceChars` 是公开可调项，必须自行锁定 —— 上面的用例全部走默认值，
  // 覆盖不到它。
  // ───────────────────────────────────────────────────────────────────────────
  it('sliceChars 可覆盖：切片越大 cutAt 精度越低但仍 > 0', () => {
    const loop = fixture('reasoning-loop.txt')
    const run = (sliceChars: number) => {
      const detector = createReasoningLoopDetector({ sliceChars })
      for (let i = 0; i < loop.length; i += 256) {
        if (detector.observe(loop.slice(i, i + 256))) return detector.cutAt
      }
      return undefined
    }
    // 实测（本 fixture + 上述 256 粒度喂入）：sliceChars=256 → 1536，
    // sliceChars=64 → 1600。两者都落在各自切片大小的整数倍上，说明
    // 自定义切片确实生效；且都绝不为 0（为 0 即把回答截空）。
    // ⚠️ 等值断言依赖 fixture 内容，fixture 变更时需同步更新。
    const wide = run(256)
    expect(wide).toBe(1536)
    const fine = run(64)
    expect(fine).toBe(1600)
    // 细切片更精确：截断点更靠近真实循环起点（数值更大 = 保留更多干净前缀）。
    expect(fine!).toBeGreaterThan(wide!)
  })

  // ⚠️ 接线（`observe` 是否真的调用了 `resolveSliceChars`）**不能用
  // `sliceChars: 0` 或负数来测**：若钳制被回退，`offset += 0` 是**同步死循环**，
  // 而 vitest 的 testTimeout 由事件循环 timer 实现、同步阻塞下根本不触发 →
  // 整个测试进程永久挂住且零诊断。
  //
  // 改用 **`NaN`** 测接线：`offset += NaN` 会让 `offset < delta.length` 立即为假，
  // 循环**立即退出**（不挂死）→ 表现为「判据静默失效、detected=false」。
  // 于是这条用例既安全、又能真正检测接线：
  //   - 有接线（NaN → 64）→ 正常检测，cutAt=1600；
  //   - 无接线（NaN 直通）→ detected=false，断言失败（可诊断，不挂死）。
  it('sliceChars 传 NaN 时接线生效：回退默认值而非静默失效（不挂死，可诊断）', () => {
    const loop = fixture('reasoning-loop.txt')
    const detector = createReasoningLoopDetector({ sliceChars: Number.NaN })
    // 若接线被回退，`NaN` 会直通进切片循环 → 立即退出 → 此处为 false（失败可诊断）。
    expect(detector.observe(loop)).toBe(true)
    // 回退到默认 64，故 cutAt 与默认切片一致（1600），而非切片 1 的 1616。
    expect(detector.cutAt).toBe(1600)
  })
})

// ⚠️ 这些用例刻意测**纯函数**而非集成路径：若钳制被回退，集成用例会因
// `offset += 0` 同步死循环而让**整个测试进程挂住**（超时由事件循环 timer
// 实现，同步阻塞下不触发），且零诊断信息。纯函数断言则可诊断。
describe('resolveSliceChars', () => {
  it('0 / 负数被钳到 1（否则切片循环永不推进）', () => {
    expect(resolveSliceChars(0)).toBe(1)
    expect(resolveSliceChars(-5)).toBe(1)
  })

  it('NaN / Infinity 回退默认 64（否则判据静默失效）', () => {
    expect(resolveSliceChars(Number.NaN)).toBe(64)
    expect(resolveSliceChars(Number.POSITIVE_INFINITY)).toBe(64)
    expect(resolveSliceChars(Number.NEGATIVE_INFINITY)).toBe(64)
  })

  it('合法值原样返回，未提供时用默认 64', () => {
    expect(resolveSliceChars(256)).toBe(256)
    expect(resolveSliceChars(1)).toBe(1)
    expect(resolveSliceChars(undefined)).toBe(64)
  })
})

describe('resolveReasoningLoopGuardFlag', () => {
  // 与 resolveHideWithoutAccountFlag（src/account-pool.ts）同为「默认开」语义。
  it('未设置时默认开启', () => {
    expect(resolveReasoningLoopGuardFlag(undefined)).toBe(true)
  })

  it('显式假值才关闭', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
      expect(resolveReasoningLoopGuardFlag(raw)).toBe(false)
    }
  })

  it('其余取值保持开启', () => {
    for (const raw of ['1', 'true', 'yes', 'on', '']) {
      expect(resolveReasoningLoopGuardFlag(raw)).toBe(true)
    }
  })
})
