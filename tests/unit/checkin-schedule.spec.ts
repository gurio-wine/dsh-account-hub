/**
 * 签到**周期模型**（`src/checkin-schedule.ts`）的单元测试。
 *
 * ## 这一组测的是「下一次可签时刻」的算术，不是某次请求
 *
 * 旧模型的判据是「日数相等」，它对**重置钟点不是 0 点**的 provider（实测
 * `qoder-cn` 是本地 10:00）在窗口边界两侧各错一次。新模型把这件事收敛成一个
 * 纯函数（{@link nextEligibleAt}），故这里逐条钉死它的边界语义 —— 包括用户
 * 2026-09-24 明确拍板的那条「9:00 签到成功 → 下次可签 = 当日 10:00」。
 *
 * 时区：全部用**本地时区**构造期望值（`new Date(y, m, d, h)`），与实现同口径。
 * 刻意不写死 `+08:00` —— 本仓库的时区口径只在实现里收敛一次，测试跟着同一套
 * 构造方式走，换一台机器跑也是同样的语义（而不是同样的毫秒数）。
 */

import { describe, expect, it } from 'vitest'
import {
  BALANCE_COMPARISON_EXEMPT_PROVIDERS,
  CHECKIN_RESET_HOURS,
  LEGACY_DAY_NUMBER_MAX,
  checkinResetHour,
  comparesBalanceAroundClaim,
  isCheckinDue,
  localResetInstant,
  migrateLegacyCheckinDay,
  nextEligibleAt,
  normalizeCheckinValue,
} from '../../src/checkin-schedule.js'
// ⚠️ 余额比对的**裁决函数**住在 `credits.ts`（与它产出的 `abnormal` outcome 同处），
// 而「谁参与比对」的**豁免表**住在本模块 —— 两者刻意分居：前者是协议无关的算术，
// 后者是积分域的策略。故这里从两个模块各取所需。
import { compareBalanceAroundClaim } from '../../src/credits.js'

/** 本地时刻构造器（测试与实现同一套本地口径）。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('CHECKIN_RESET_HOURS —— 逐 provider 的重置钟点', () => {
  it('qoder-cn 是 10 点，其余已确认的是 0 点', () => {
    expect(checkinResetHour('qoder-cn')).toBe(10)
    expect(checkinResetHour('buddy-cn')).toBe(0)
    expect(checkinResetHour('lobsterai')).toBe(0)
    expect(checkinResetHour('trae-cn')).toBe(0)
    expect(checkinResetHour('codearts')).toBe(0)
  })

  it('qoder 国际版**单独**一条 0 点，不是复用 qoder-cn 的 10 点', () => {
    // 两区同协议但「窗口几点翻页」是活动系统的属性，只有 CN 被观测到 10 点。
    // 这条断言守的是「不要为形态统一把两区并成一条」。
    expect(checkinResetHour('qoder')).toBe(0)
    expect(CHECKIN_RESET_HOURS.qoder).toBe(0)
    expect(CHECKIN_RESET_HOURS['qoder-cn']).toBe(10)
  })

  it('未登记的 provider 缺省 0 点（新增 provider 忘登记时行为等于旧模型）', () => {
    expect(checkinResetHour('some-new-provider')).toBe(0)
  })

  it('配置被改坏（非整数 / 越界）时回落 0，而不是算出一个跨日的怪时刻', () => {
    const original = { ...CHECKIN_RESET_HOURS }
    try {
      // 直接改共享表来模拟「外部改坏」——它只被本模块的读取函数消费。
      ;(CHECKIN_RESET_HOURS as Record<string, number>)['bad-frac'] = 10.5
      ;(CHECKIN_RESET_HOURS as Record<string, number>)['bad-neg'] = -3
      ;(CHECKIN_RESET_HOURS as Record<string, number>)['bad-big'] = 25
      expect(checkinResetHour('bad-frac')).toBe(0)
      expect(checkinResetHour('bad-neg')).toBe(0)
      expect(checkinResetHour('bad-big')).toBe(0)
    } finally {
      for (const key of Object.keys(CHECKIN_RESET_HOURS)) {
        if (!(key in original)) delete (CHECKIN_RESET_HOURS as Record<string, number>)[key]
      }
    }
  })
})

describe('nextEligibleAt —— 签到成功后应记录的「下一次可签时刻」', () => {
  it('0 点重置：任何时刻签到都得到「次日 0 点」（等价旧模型的按自然日）', () => {
    expect(nextEligibleAt(at(2026, 9, 24, 15, 30), 'buddy-cn')).toBe(at(2026, 9, 25))
    // 日初那一瞬：`claimedAt >= 当日重置点` ⇒ 属于本周期 ⇒ 明天。
    expect(nextEligibleAt(at(2026, 9, 24, 0, 0), 'buddy-cn')).toBe(at(2026, 9, 25))
    // 当日最后一刻仍是明天（不会滑到后天）。
    expect(nextEligibleAt(at(2026, 9, 24, 23, 59), 'buddy-cn')).toBe(at(2026, 9, 25))
  })

  it('qoder-cn（10 点重置）：15:00 签到成功 → 次日 10:00', () => {
    expect(nextEligibleAt(at(2026, 9, 24, 15, 0), 'qoder-cn')).toBe(at(2026, 9, 25, 10))
  })

  it('qoder-cn：**09:00 签到成功 → 当日 10:00**（用户拍板的边界语义）', () => {
    // 这条是本次改动最容易写错的一格：09:00 时当日 10:00 的窗口还没开，
    // 这一签消耗的是**上一周期**（23 日 10:00 开的那个）的份额，
    // 故 24 日 10:00 一到就应该能再签 —— 而不是等到 25 日 10:00。
    expect(nextEligibleAt(at(2026, 9, 24, 9, 0), 'qoder-cn')).toBe(at(2026, 9, 24, 10))
  })

  it('qoder-cn：10:00 整点这一瞬算**本周期**（边界取闭区间左侧）', () => {
    // `claimedAt === 当日重置点` ⇒ 属于本周期 ⇒ 明天 10:00。
    // 与上一格（09:00 → 当日 10:00）合起来把「<」与「>=」的分界钉死。
    expect(nextEligibleAt(at(2026, 9, 24, 10, 0), 'qoder-cn')).toBe(at(2026, 9, 25, 10))
  })

  it('qoder-cn：09:59 与 10:01 分居边界两侧', () => {
    expect(nextEligibleAt(at(2026, 9, 24, 9, 59), 'qoder-cn')).toBe(at(2026, 9, 24, 10))
    expect(nextEligibleAt(at(2026, 9, 24, 10, 1), 'qoder-cn')).toBe(at(2026, 9, 25, 10))
  })

  it('返回值**严格大于**签到时刻（否则下一次 sweep 立刻会再签一次）', () => {
    for (const provider of ['buddy-cn', 'qoder-cn', 'trae-cn']) {
      for (const hour of [0, 5, 9, 10, 15, 23]) {
        const claimedAt = at(2026, 9, 24, hour, 30)
        expect(nextEligibleAt(claimedAt, provider), `${provider}@${hour}`).toBeGreaterThan(claimedAt)
      }
    }
  })

  it('跨月与跨年都正确（12 月 31 日 → 次年 1 月 1 日）', () => {
    expect(nextEligibleAt(at(2026, 12, 31, 23, 0), 'buddy-cn')).toBe(at(2027, 1, 1))
    expect(nextEligibleAt(at(2026, 12, 31, 23, 0), 'qoder-cn')).toBe(at(2027, 1, 1, 10))
    // 月末：9 月 30 日 → 10 月 1 日。
    expect(nextEligibleAt(at(2026, 9, 30, 12, 0), 'buddy-cn')).toBe(at(2026, 10, 1))
  })

  it('闰年 2 月 28 日 → 2 月 29 日', () => {
    // 2028 是闰年。
    expect(nextEligibleAt(at(2028, 2, 28, 12, 0), 'buddy-cn')).toBe(at(2028, 2, 29))
    expect(nextEligibleAt(at(2028, 2, 29, 12, 0), 'trae-cn')).toBe(at(2028, 3, 1))
  })

  it('本地构造而非「日初 + 小时数」：与 localResetInstant 同源', () => {
    const claimedAt = at(2026, 9, 24, 15, 0)
    expect(localResetInstant(claimedAt, 10)).toBe(at(2026, 9, 24, 10))
    // nextEligibleAt 在「已过重置点」时给出的就是**明天**的那个 localResetInstant。
    expect(nextEligibleAt(claimedAt, 'qoder-cn')).toBe(localResetInstant(claimedAt + 86_400_000, 10))
  })
})

describe('isCheckinDue —— 判「此刻是否可签」', () => {
  const now = at(2026, 9, 24, 15, 0)

  it('无记录 = 可签（从未签过）', () => {
    expect(isCheckinDue(undefined, now)).toBe(true)
  })

  it('记录的未来时刻还没到 = 已签', () => {
    expect(isCheckinDue(at(2026, 9, 25, 10), now)).toBe(false)
  })

  it('记录的时刻刚好到 = 可签（闭区间右侧）', () => {
    expect(isCheckinDue(now, now)).toBe(true)
  })

  it('记录的过去时刻 = 可签（上一周期已翻页）', () => {
    expect(isCheckinDue(at(2026, 9, 23, 10), now)).toBe(true)
  })

  it('非有限值（NaN / Infinity）视为无记录，不炸', () => {
    expect(isCheckinDue(Number.NaN, now)).toBe(true)
    expect(isCheckinDue(Number.POSITIVE_INFINITY, now)).toBe(true)
  })
})

describe('旧 dayNumber → 新时间戳的迁移', () => {
  /** 由本地年月日算旧口径的纪元日数（与 `todayDayNumber` 同式）。 */
  function dayNumber(year: number, month: number, day: number): number {
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
  }

  it('0 点重置：d 天签过 → d+1 天本地 0 点（与旧行为逐刻一致）', () => {
    expect(migrateLegacyCheckinDay(dayNumber(2026, 9, 24), 'buddy-cn')).toBe(at(2026, 9, 25))
  })

  it('qoder-cn：d 天签过 → d+1 天的 10 点（向后取满一个周期）', () => {
    // 旧模型对 qoder-cn 本来就判错（它按 0 点翻页），迁移取保守方向：
    // 宁可少签一次，也不打一发注定 already-claimed 的请求。
    expect(migrateLegacyCheckinDay(dayNumber(2026, 9, 24), 'qoder-cn')).toBe(at(2026, 9, 25, 10))
  })

  it('迁移结果是过去时刻时 = 可签（升级后今天还没签的状态）', () => {
    const yesterday = dayNumber(2026, 9, 23)
    const migrated = migrateLegacyCheckinDay(yesterday, 'buddy-cn')
    // 昨日签过 ⇒ 下一次可签是今日 0 点 ⇒ 现在（今日 15:00）已过 ⇒ 可签。
    expect(isCheckinDue(migrated, at(2026, 9, 24, 15, 0))).toBe(true)
  })

  it('迁移结果确实是未来时不可签（当天签过、升级后不重复签）', () => {
    const today = dayNumber(2026, 9, 24)
    const migrated = migrateLegacyCheckinDay(today, 'buddy-cn')
    // 今天签过 ⇒ 下一次可签是明天 0 点 ⇒ 今天 15:00 不可签。
    expect(isCheckinDue(migrated, at(2026, 9, 24, 15, 0))).toBe(false)
  })

  it('跨月与跨年边界都由 Date 自身规整', () => {
    expect(migrateLegacyCheckinDay(dayNumber(2026, 12, 31), 'buddy-cn')).toBe(at(2027, 1, 1))
    expect(migrateLegacyCheckinDay(dayNumber(2026, 9, 30), 'qoder-cn')).toBe(at(2026, 10, 1, 10))
  })
})

describe('normalizeCheckinValue —— 双口径读入', () => {
  it('小值（旧日数）走迁移', () => {
    const migrated = normalizeCheckinValue(20_831, 'buddy-cn')
    expect(migrated).toBeDefined()
    // 迁移后的值必然远大于日数区间（它是毫秒时间戳）。
    expect(migrated!).toBeGreaterThan(LEGACY_DAY_NUMBER_MAX)
  })

  it('大值（新时间戳）原样保留 —— 反复读不会二次迁移', () => {
    const timestamp = at(2026, 9, 25, 10)
    expect(normalizeCheckinValue(timestamp, 'qoder-cn')).toBe(timestamp)
    // 幂等：迁移产物再喂一遍还是同一个值。
    const once = normalizeCheckinValue(20_831, 'qoder-cn')!
    expect(normalizeCheckinValue(once, 'qoder-cn')).toBe(once)
  })

  it('边界：恰好 LEGACY_DAY_NUMBER_MAX 视为新口径（上界是开区间）', () => {
    expect(normalizeCheckinValue(LEGACY_DAY_NUMBER_MAX, 'buddy-cn')).toBe(LEGACY_DAY_NUMBER_MAX)
    expect(normalizeCheckinValue(LEGACY_DAY_NUMBER_MAX - 1, 'buddy-cn')).not.toBe(LEGACY_DAY_NUMBER_MAX - 1)
  })

  it('脏值一律丢弃（字符串 / NaN / 负数 / 小数 / 非数字）', () => {
    for (const raw of ['12', Number.NaN, -1, 12.5, null, undefined, {}, [], true]) {
      expect(normalizeCheckinValue(raw, 'buddy-cn'), String(raw)).toBeUndefined()
    }
  })

  it('秒级时间戳（10 位数）**不**被当成旧日数', () => {
    // 这是选 1e5 作阈值而不是按「位数」判断的原因：1.79e9 与日数区间只差
    // 4 个数量级，按位数会把它误判成一种「未来的日数」而算出一个荒唐的时刻。
    const seconds = 1_789_000_000
    expect(normalizeCheckinValue(seconds, 'buddy-cn')).toBe(seconds)
  })
})

describe('余额比对豁免表', () => {
  it('codearts 登记为豁免（登记理由与解除条件见模块注释）', () => {
    expect(BALANCE_COMPARISON_EXEMPT_PROVIDERS.has('codearts')).toBe(true)
    expect(comparesBalanceAroundClaim('codearts')).toBe(false)
  })

  it('其余五家都参与比对', () => {
    for (const provider of ['buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn']) {
      expect(comparesBalanceAroundClaim(provider), provider).toBe(true)
    }
  })

  it('未登记的 provider 默认参与（豁免是白名单式的显式登记）', () => {
    expect(comparesBalanceAroundClaim('some-new-provider')).toBe(true)
  })
})

describe('compareBalanceAroundClaim —— 签到前后余额的三态裁决', () => {
  it('余额变多 → increased', () => {
    expect(compareBalanceAroundClaim({ total: 100 }, { total: 150 }, false))
      .toEqual({ kind: 'increased', before: 100, after: 150 })
  })

  it('余额没变 → unchanged（本 kind 的由来）', () => {
    expect(compareBalanceAroundClaim({ total: 100 }, { total: 100 }, false))
      .toEqual({ kind: 'unchanged', before: 100, after: 100 })
  })

  it('余额**变少**也算 unchanged：签到同时结算了一笔扣费时更不该报成功', () => {
    expect(compareBalanceAroundClaim({ total: 100 }, { total: 80 }, false))
      .toEqual({ kind: 'unchanged', before: 100, after: 80 })
  })

  it('签到前没查到 → skipped（不能因余额查询故障把真成功判异常）', () => {
    const verdict = compareBalanceAroundClaim({ total: undefined }, { total: 100 }, false)
    expect(verdict.kind).toBe('skipped')
    expect((verdict as { reason: string }).reason).toContain('签到前')
  })

  it('签到后没查到 → skipped（同上，方向上更常见）', () => {
    const verdict = compareBalanceAroundClaim({ total: 100 }, { total: undefined }, false)
    expect(verdict.kind).toBe('skipped')
    expect((verdict as { reason: string }).reason).toContain('签到后')
  })

  it('两侧都没查到 → skipped，不是 unchanged', () => {
    expect(compareBalanceAroundClaim({ total: undefined }, { total: undefined }, false).kind)
      .toBe('skipped')
  })

  it('豁免 provider → skipped（即使余额确实没变）', () => {
    const verdict = compareBalanceAroundClaim({ total: 100 }, { total: 100 }, true)
    expect(verdict.kind).toBe('skipped')
    expect((verdict as { reason: string }).reason).toContain('不参与')
  })

  it('余额为 0 → 0 是**有效数字**，不当作「没查到」', () => {
    // 0 与 undefined 的区分是整个余额域的老约定（见 `CreditBalance` 的说明）：
    // 签到前 0、签到后 0 是「没到账」，而签到前 0、签到后 5 是「到账了」。
    expect(compareBalanceAroundClaim({ total: 0 }, { total: 0 }, false).kind).toBe('unchanged')
    expect(compareBalanceAroundClaim({ total: 0 }, { total: 5 }, false).kind).toBe('increased')
  })

  it('小数余额（两位小数）按数值比较，不做字符串化', () => {
    expect(compareBalanceAroundClaim({ total: 155.67 }, { total: 255.67 }, false).kind).toBe('increased')
    // 尾数噪声不构成「变多」：155.67 → 155.67 是没变。
    expect(compareBalanceAroundClaim({ total: 55.67000031 }, { total: 55.67 }, false).kind).toBe('unchanged')
  })
})
