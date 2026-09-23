/**
 * 「账号消耗顺序 + 切换粒度」的**纯逻辑**回归测试。
 *
 * ## 本文件守什么
 *
 * `src/account-consumption.ts` 是本功能的唯一真相源，它同时承载三件彼此独立的事：
 *
 * 1. **两个配置项的取值域与默认值**（消耗顺序三档 / 切换粒度两档，默认
 *    `sequential` + `per-turn`）。默认值不是随手定的：`sequential` 是**现状行为**
 *    （永远取排序第一个可用账号），`per-turn` 是用户拍板的「风险小一点」那一档 ——
 *    同轮对话锁同一账号，上下文连贯、也避免部分后端按会话绑定凭据。
 * 2. **候选重排**（遍历游标轮转 / 余额降序 + 未知余额降级）。
 * 3. **两个有界状态**：余额缓存（TTL 4h）与轮次锁（LRU 上限 100）。
 *
 * ## 为什么拆成纯函数 + 两个小类，而不是写进 AccountPool
 *
 * `AccountPool.getAvailableAccount` 是宿主热路径且已有 1300 行；把重排逻辑内联进去
 * 会让「顺序档下行为 100% 不变」这条回归判据无从验证。拆出来后本文件可以对**每一档
 * 语义**做精确断言，池那一侧只需验「接线正确」。
 */

import { describe, expect, it } from 'vitest'
import {
  BALANCE_CACHE_TTL_MS,
  BalanceCache,
  CONSUMPTION_ORDERS,
  CONSUMPTION_SWITCHES,
  DEFAULT_CONSUMPTION,
  TURN_ACCOUNT_LOCK_LIMIT,
  TurnAccountLock,
  TurnKeyTracker,
  consumptionFor,
  nextCursorAfter,
  orderByBalance,
  rotateToCursor,
  sanitizeConsumption,
  sanitizeConsumptionCursors,
  sanitizeConsumptionSetting,
} from '../../src/account-consumption.js'

const A = { id: 'a' }
const B = { id: 'b' }
const C = { id: 'c' }
const ids = (list: readonly { id: string }[]): string[] => list.map(item => item.id)

describe('消耗顺序 / 切换粒度的取值域与默认值', () => {
  it('三档顺序与两档粒度的字面量**固定**（它们同时是持久化值，改名等于丢配置）', () => {
    expect([...CONSUMPTION_ORDERS]).toEqual(['sequential', 'round-robin', 'highest-balance'])
    expect([...CONSUMPTION_SWITCHES]).toEqual(['per-request', 'per-turn'])
  })

  it('默认值是「顺序 + 按轮次」——顺序档 = 现状行为，按轮次是用户拍板的保守档', () => {
    expect(DEFAULT_CONSUMPTION).toEqual({ order: 'sequential', switch: 'per-turn' })
    // 冻结：它是共享只读实例，任何就地改写都会污染所有 provider 的缺省值。
    expect(Object.isFrozen(DEFAULT_CONSUMPTION)).toBe(true)
  })

  it('缺省 / 脏值 / 半截对象一律补默认值，而不是丢弃整条配置', () => {
    // 缺 order 只补 order，缺 switch 只补 switch —— 用户改了一半的配置不能被整条丢掉。
    expect(sanitizeConsumptionSetting({ order: 'round-robin' }))
      .toEqual({ order: 'round-robin', switch: 'per-turn' })
    expect(sanitizeConsumptionSetting({ switch: 'per-request' }))
      .toEqual({ order: 'sequential', switch: 'per-request' })
    expect(sanitizeConsumptionSetting({ order: '轮次', switch: true })).toEqual(DEFAULT_CONSUMPTION)
    expect(sanitizeConsumptionSetting(undefined)).toEqual(DEFAULT_CONSUMPTION)
    expect(sanitizeConsumptionSetting(null)).toEqual(DEFAULT_CONSUMPTION)
    expect(sanitizeConsumptionSetting('round-robin')).toEqual(DEFAULT_CONSUMPTION)
    expect(sanitizeConsumptionSetting(['round-robin'])).toEqual(DEFAULT_CONSUMPTION)
  })

  it('sanitizeConsumption 只保留「与默认值不同」的 provider 条目（不留噪音键）', () => {
    // 与 `disabledModels` 同一取舍：整条等于默认值的条目不该落盘，
    // 否则「用户从没配过」与「配成了默认值」在文件里长得一样。
    const map = sanitizeConsumption({
      'buddy-cn': { order: 'round-robin', switch: 'per-request' },
      qoder: { order: 'sequential', switch: 'per-turn' },
      'trae-cn': { order: 'bogus', switch: 'per-turn' },
      garbage: 'x',
    })
    expect(map).toEqual({ 'buddy-cn': { order: 'round-robin', switch: 'per-request' } })
  })

  it('未知 provider 读回默认值（读路径永不抛错）', () => {
    expect(consumptionFor({}, 'nobody')).toEqual(DEFAULT_CONSUMPTION)
    expect(consumptionFor(sanitizeConsumption({ qoder: { order: 'highest-balance', switch: 'per-request' } }), 'qoder'))
      .toEqual({ order: 'highest-balance', switch: 'per-request' })
  })

  it('游标表只收非空字符串值', () => {
    expect(sanitizeConsumptionCursors({ 'buddy-cn': 'a1', qoder: '', 'trae-cn': 7, 'x': null }))
      .toEqual({ 'buddy-cn': 'a1' })
    expect(sanitizeConsumptionCursors(null)).toEqual({})
  })
})

describe('遍历游标：按账号 id 轮转，游标消失即自愈', () => {
  it('游标命中时把该账号提到首位（其余保持相对顺序）', () => {
    expect(ids(rotateToCursor([A, B, C], 'b'))).toEqual(['b', 'c', 'a'])
    expect(ids(rotateToCursor([A, B, C], 'c'))).toEqual(['c', 'a', 'b'])
    // 游标已在首位时输出与输入**同一引用**：热路径上不必为「无变化」造新数组。
    const list = [A, B, C]
    expect(rotateToCursor(list, 'a')).toBe(list)
  })

  it('游标缺失 / 账号已被删除 / 已停用（不在候选里）→ 回落数组顺序，不抛错', () => {
    expect(ids(rotateToCursor([A, B, C], undefined))).toEqual(['a', 'b', 'c'])
    expect(ids(rotateToCursor([A, B, C], 'gone'))).toEqual(['a', 'b', 'c'])
    expect(ids(rotateToCursor([A, B, C], ''))).toEqual(['a', 'b', 'c'])
    expect(ids(rotateToCursor([], 'a'))).toEqual([])
  })

  it('推进游标：取候选里「选中项的下一项」（末尾回到开头）', () => {
    expect(nextCursorAfter([A, B, C], 'a')).toBe('b')
    expect(nextCursorAfter([A, B, C], 'c')).toBe('a')
    // 单账号：下一项恒为自己 —— 池据此判定「游标没变」从而跳过写盘。
    expect(nextCursorAfter([A], 'a')).toBe('a')
    // 选中项已不在候选里（并发删除）→ 不推进，交回调用方保持原游标。
    expect(nextCursorAfter([A, B], 'gone')).toBeUndefined()
    expect(nextCursorAfter([], 'a')).toBeUndefined()
  })

  it('两轮轮转真的走遍全部账号（a→b→c→a）', () => {
    const list = [A, B, C]
    let cursor: string | undefined
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const chosen = rotateToCursor(list, cursor)[0]
      seen.push(chosen.id)
      cursor = nextCursorAfter(list, chosen.id)
    }
    expect(seen).toEqual(['a', 'b', 'c', 'a'])
  })
})

describe('最高优先：按余额降序，余额未知即降级回数组顺序', () => {
  it('已知余额排在前（降序），未知余额的账号按原顺序排在后面', () => {
    const balances = new Map([['b', 300], ['c', 100]])
    expect(ids(orderByBalance([A, B, C], balances))).toEqual(['b', 'c', 'a'])
  })

  it('余额全未知（缓存空 / 全过期）→ **原样返回**（等价于顺序档），不抛错', () => {
    const list = [A, B, C]
    expect(orderByBalance(list, new Map())).toBe(list)
  })

  it('余额相同保持原相对顺序（稳定排序，不能因一次刷新就打乱用户顺序）', () => {
    const balances = new Map([['a', 50], ['b', 50], ['c', 50]])
    expect(ids(orderByBalance([A, B, C], balances))).toEqual(['a', 'b', 'c'])
  })

  it('0 与负数视为「已知且更低」，不会与「未知」混淆', () => {
    const balances = new Map([['a', 0], ['c', -5]])
    expect(ids(orderByBalance([A, B, C], balances))).toEqual(['a', 'c', 'b'])
  })
})

describe('余额缓存：TTL 4h、按 provider 分桶、脏值不收', () => {
  it('TTL 与签到 sweep 同节奏（4 小时）', () => {
    expect(BALANCE_CACHE_TTL_MS).toBe(4 * 60 * 60 * 1000)
  })

  it('TTL 内命中，过期后查不到（而不是返回旧值）', () => {
    const cache = new BalanceCache()
    cache.record('buddy-cn', 'a1', 120, 1_000)
    expect(cache.lookup('buddy-cn', 'a1', 1_000 + BALANCE_CACHE_TTL_MS - 1)).toBe(120)
    // 边界：恰好到期即失效（与 checkins 的「精确相等即已签」同款边界口径）。
    expect(cache.lookup('buddy-cn', 'a1', 1_000 + BALANCE_CACHE_TTL_MS)).toBeUndefined()
    expect(cache.lookup('buddy-cn', 'a1', 1_000 + BALANCE_CACHE_TTL_MS + 1)).toBeUndefined()
  })

  it('按 provider 分桶，不串号', () => {
    const cache = new BalanceCache()
    cache.record('buddy-cn', 'a1', 10, 5_000)
    expect(cache.lookup('qoder', 'a1', 5_000)).toBeUndefined()
    expect(cache.lookup('buddy-cn', 'a1', 5_000)).toBe(10)
  })

  it('非有限数（NaN / Infinity / 字符串）一律不收，避免脏值参与排序', () => {
    const cache = new BalanceCache()
    cache.record('buddy-cn', 'a1', Number.NaN, 1)
    cache.record('buddy-cn', 'a2', Number.POSITIVE_INFINITY, 1)
    cache.record('buddy-cn', 'a3', '9' as unknown as number, 1)
    cache.record('buddy-cn', '', 5, 1)
    expect(cache.snapshot('buddy-cn', 2).size).toBe(0)
  })

  it('recordMany 整批写入（余额端点一次回多个账号），跳过查不到的账号', () => {
    const cache = new BalanceCache()
    cache.recordMany('trae-cn', [
      { accountId: 'a1', total: 8 },
      { accountId: 'a2', total: Number.NaN },
      { accountId: 'a3', total: 0 },
    ], 100)
    expect([...cache.snapshot('trae-cn', 100)]).toEqual([['a1', 8], ['a3', 0]])
  })

  it('snapshot 过滤过期项（过期项不得参与「最高优先」排序）', () => {
    const cache = new BalanceCache()
    cache.record('qoder', 'fresh', 5, 1_000)
    cache.record('qoder', 'stale', 9_999, 1_000)
    const snap = cache.snapshot('qoder', 1_000 + BALANCE_CACHE_TTL_MS + 1)
    expect([...snap.keys()]).toEqual([])
  })

  it('clear 清空全部桶（测试与重载用）', () => {
    const cache = new BalanceCache()
    cache.record('a', 'x', 1, 1)
    cache.clear()
    expect(cache.lookup('a', 'x', 1)).toBeUndefined()
  })
})

describe('轮次键换算：同一标识对象恒等，不同对象必不同', () => {
  it('同一个对象反复取到同一个键（同轮内的多个 step）', () => {
    const tracker = new TurnKeyTracker()
    const signalOfTurn1 = {}
    const first = tracker.keyFor(signalOfTurn1)
    expect(first).not.toBe('')
    expect(tracker.keyFor(signalOfTurn1)).toBe(first)
    expect(tracker.keyFor(signalOfTurn1)).toBe(first)
  })

  it('不同对象取到不同的键（新的一轮）', () => {
    const tracker = new TurnKeyTracker()
    const a = tracker.keyFor({})
    const b = tracker.keyFor({})
    const c = tracker.keyFor({})
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('非对象 / 缺席 → 空串（= 不属于任何一轮，池据此不锁）', () => {
    const tracker = new TurnKeyTracker()
    expect(tracker.keyFor(undefined)).toBe('')
    expect(tracker.keyFor(null)).toBe('')
    expect(tracker.keyFor('signal')).toBe('')
    expect(tracker.keyFor(7)).toBe('')
  })

  it('不阻止标识对象被回收（WeakMap，会话结束后不留引用）', () => {
    // 这里能验的是「键表不持有强引用」这一语义：换一个**新的**，等价对象，
    // 必须得到一个**新的**键 —— 若实现改成了 Map（强引用 + 内容比较），
    // 它既泄漏又会让两个不同轮次撞到同一个键。
    const tracker = new TurnKeyTracker()
    const first = tracker.keyFor({})
    const second = tracker.keyFor({})
    expect(first).not.toBe(second)
  })
})

describe('轮次锁：同轮锁同一账号，超上限淘汰最久未用的', () => {
  it('写入后可读；未写入返回 undefined（调用方据此重新选号）', () => {
    const lock = new TurnAccountLock()
    expect(lock.get('s1')).toBeUndefined()
    lock.set('s1', 'a1')
    expect(lock.get('s1')).toBe('a1')
  })

  it('重复 get 刷新最近使用次序：被读过的键不会在淘汰时先死', () => {
    const lock = new TurnAccountLock(3)
    lock.set('k1', 'a1')
    lock.set('k2', 'a2')
    lock.set('k3', 'a3')
    // 触摸 k1 → 它变成「最近使用」，最旧的应是 k2。
    expect(lock.get('k1')).toBe('a1')
    lock.set('k4', 'a4')
    expect(lock.size).toBe(3)
    expect(lock.get('k1')).toBe('a1')
    expect(lock.get('k2')).toBeUndefined()
    expect(lock.get('k3')).toBe('a3')
    expect(lock.get('k4')).toBe('a4')
  })

  it('上限是 100 条（防会话泄漏），且**硬上限**：插入第 101 条时淘汰最旧', () => {
    expect(TURN_ACCOUNT_LOCK_LIMIT).toBe(100)
    const lock = new TurnAccountLock()
    for (let i = 0; i < TURN_ACCOUNT_LOCK_LIMIT; i++) lock.set(`k${i}`, `a${i}`)
    expect(lock.size).toBe(TURN_ACCOUNT_LOCK_LIMIT)
    lock.set('overflow', 'a')
    expect(lock.size).toBe(TURN_ACCOUNT_LOCK_LIMIT)
    expect(lock.get('k0')).toBeUndefined()
    expect(lock.get('overflow')).toBe('a')
  })

  it('覆盖同一个键不增加条数（同轮换号：锁住的账号被限流后改锁新账号）', () => {
    const lock = new TurnAccountLock(2)
    lock.set('k1', 'a1')
    lock.set('k1', 'a2')
    expect(lock.size).toBe(1)
    expect(lock.get('k1')).toBe('a2')
  })
})
