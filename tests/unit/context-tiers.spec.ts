/**
 * 上下文窗口档位的**通用**纯函数（`availableContextTiers` / `effectiveContextWindow`）。
 *
 * ## 为什么这两个函数值得单独钉死
 *
 * 档位机制原本只服务 Trae CN（`{contextWindow, maxContextWindow}` 两档形态）。
 * 推广到全部供应商后，三个 provider 的目录给出的档位**语义各不相同**：
 *
 * | provider | 目录字段 | 档位语义 |
 * |---|---|---|
 * | Trae CN | `context_window_tokens.{dev,max}` | dev 是默认档，max 是更大的档 |
 * | Qoder | `available_context_windows` | 默认档是**最小**档，其余是升档选项 |
 * | Buddy | `contextWindow.supportedLengths` | 生效档已是**最大**档，其余是降档选项 |
 *
 * 三者唯一的共同点只有一句话：**「用户能选的档位，精确等于目录公布的那些数」**。
 * 故通用层只做两件事 —— 归一化成一个升序去重的列表，以及「预算精确命中列表
 * 才生效、否则静默回退默认档」。任何 provider 特有的取舍都留在各自的解析器里。
 *
 * 归一化必须**幂等**且**不发明档位**：列表里的每一个数都要能在目录里找到出处
 * （或就是生效的默认档本身）。
 */

import { describe, expect, it } from 'vitest'
import { availableContextTiers, effectiveContextWindow } from '../../src/context-tiers.js'

describe('availableContextTiers：把三种目录形态归一成升序去重的档位列表', () => {
  it('未声明任何窗口 → 空列表（UI 据此不渲染档位列）', () => {
    expect(availableContextTiers(undefined)).toEqual([])
    expect(availableContextTiers({})).toEqual([])
  })

  it('只有默认档 → 单元素列表（单档模型没有可选项）', () => {
    // LobsterAI 的真实形态：目录只给一个窗口。
    expect(availableContextTiers({ contextWindow: 1_000_000 })).toEqual([1_000_000])
  })

  it('Trae CN 两档形态：dev + max 升序排列', () => {
    expect(availableContextTiers({ contextWindow: 119_040, maxContextWindow: 1_048_576 }))
      .toEqual([119_040, 1_048_576])
    // 顺序颠倒的输入也归一到升序（UI 的档位顺序不该取决于目录字段顺序）。
    expect(availableContextTiers({ contextWindow: 1_048_576, maxContextWindow: 119_040 }))
      .toEqual([119_040, 1_048_576])
  })

  it('**Qoder 形态**：完整档位列表原样收下（默认档是最小档，其余是升档选项）', () => {
    // 真机 `qmodel_38max`：`default_context_window: 200000` +
    // `available_context_windows: [200000, 400000, 1000000]`。
    expect(availableContextTiers({
      contextWindow: 200_000,
      contextTiers: [200_000, 400_000, 1_000_000],
    })).toEqual([200_000, 400_000, 1_000_000])
  })

  it('**Buddy 形态**：降档选项（生效档已是最大档）同样收下', () => {
    // `supportedLengths: [300000, 1048576]`，生效档取最大档 1048576。
    expect(availableContextTiers({
      contextWindow: 1_048_576,
      contextTiers: [300_000, 1_048_576],
    })).toEqual([300_000, 1_048_576])
  })

  it('默认档不在列表里时**并入**（否则 UI 无法表达「当前是默认档」）', () => {
    // Buddy 的 `min(maxInputTokens, 档位表最大档)` 会产出这种组合：档位表最大档
    // 被 maxInputTokens 挡住时，生效默认档不等于任何公布档位。
    expect(availableContextTiers({
      contextWindow: 200_000,
      contextTiers: [100_000, 524_288],
    })).toEqual([100_000, 200_000, 524_288])
  })

  it('三个来源**去重**（同一档位既在列表里又是 max 时只出现一次）', () => {
    expect(availableContextTiers({
      contextWindow: 200_000,
      maxContextWindow: 1_000_000,
      contextTiers: [200_000, 400_000, 1_000_000],
    })).toEqual([200_000, 400_000, 1_000_000])
  })

  it('非法值逐项剔除（0 / 负数 / NaN / Infinity / 非 number 一概不收）', () => {
    // 与解析侧「只保留正有限数」的既有口径一致：档位是一个能被声明的窗口，
    // 0 与负数不是窗口，NaN 更不是。
    expect(availableContextTiers({
      contextWindow: 200_000,
      maxContextWindow: 0,
      contextTiers: [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '300000' as never, 400_000],
    })).toEqual([200_000, 400_000])
  })

  it('归一化**幂等**：对结果再跑一次不变', () => {
    const once = availableContextTiers({ contextWindow: 200_000, contextTiers: [200_000, 1_000_000] })
    expect(availableContextTiers({ contextWindow: once[0], contextTiers: once })).toEqual(once)
  })
})

describe('effectiveContextWindow：预算必须**精确命中**档位才生效', () => {
  const QODER_TIERS = [200_000, 400_000, 1_000_000]

  it('默认档缺失 → 不声明窗口（连档位都无从谈起）', () => {
    expect(effectiveContextWindow(undefined, QODER_TIERS, 400_000)).toBeUndefined()
  })

  it('未设置预算 → 默认档（行为与未接档位机制时完全一致）', () => {
    expect(effectiveContextWindow(200_000, QODER_TIERS, undefined)).toBe(200_000)
  })

  it('预算恰好等于默认档 → 默认档（「恢复默认」与「设成默认档」同义）', () => {
    expect(effectiveContextWindow(200_000, QODER_TIERS, 200_000)).toBe(200_000)
  })

  it('预算命中某个非默认档 → 用该档', () => {
    expect(effectiveContextWindow(200_000, QODER_TIERS, 400_000)).toBe(400_000)
    expect(effectiveContextWindow(200_000, QODER_TIERS, 1_000_000)).toBe(1_000_000)
  })

  it('**编造值静默回退默认档**（不报错 —— 报错只会让历史会话突然打不开）', () => {
    for (const bogus of [999_999_999, 200_001, 0, -1, Number.NaN]) {
      expect(effectiveContextWindow(200_000, QODER_TIERS, bogus), String(bogus)).toBe(200_000)
    }
  })

  it('**目录漂移后旧预算失效**：档位列表变了，旧值自动退回默认档', () => {
    // roster 浮动是常态（Trae 的档位表在两个快照之间就变过）。旧预算指向一个
    // 上游已不再公布的档位时，退回默认档是安全方向。
    expect(effectiveContextWindow(200_000, [200_000], 1_000_000)).toBe(200_000)
  })

  it('单档模型：任何非默认值都被拒（列表里只有默认档）', () => {
    expect(effectiveContextWindow(1_000_000, [1_000_000], 400_000)).toBe(1_000_000)
    expect(effectiveContextWindow(1_000_000, [1_000_000], 1_000_000)).toBe(1_000_000)
  })

  it('空档位列表时退化为「只有默认档」（与未接线等价）', () => {
    expect(effectiveContextWindow(200_000, [], 400_000)).toBe(200_000)
  })

  /**
   * ⚠️ **本用例是 Trae CN 既有行为的等价性证明**。
   *
   * 推广前的 `TraeCnAdapter.effectiveContextWindow` 有两条判据：`maxContextWindow`
   * 必须存在**且严格大于** dev 档，且预算必须**恰好等于** max。手工构造出
   * `max <= dev` 的脏条目时，旧实现一律返回 dev 档（不接受那个倒挂的 max）。
   *
   * 通用实现必须给出**同一个答案** —— 否则推广会悄悄放宽一道既有的防线。
   * 关键在 `effectiveContextWindow` 只看「预算是否命中某个**非默认**档」：
   * 倒挂的 max 仍是列表里的一个值，但它不等于 dev，故预算 = max 时**会**命中。
   *
   * ⇒ 防倒挂的判据必须留在解析侧（Trae CN 的 `parseTraeCnDirectory` 与
   * `applyTraeCnAgentTiers` 都在写 `maxContextWindow` 前判过 `max > dev`）。
   * 本用例把这个分工**显式记录下来**，而不是假装通用层能兜住它。
   */
  it('⚠️ 已知边界：`max <= dev` 的脏条目通用层**不拦**，判据在解析侧', () => {
    expect(effectiveContextWindow(200_000, [100_000, 200_000], 100_000)).toBe(100_000)
  })
})
