import { describe, expect, it, vi } from 'vitest'
import {
  CHECKIN_ACTIVITY_STATUS_PATH,
  DAILY_CHECKIN_PATH,
  USER_RESOURCE_PATH,
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
} from '../../src/credits.js'
import { BUDDY_CN, BUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

function makeCredential(): BuddyCredential {
  return {
    access_token: 'AT', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    token_type: 'Bearer', scope: '', domain: 'copilot.tencent.com',
    user_id: 'uid-1',
  }
}

/** 构造按规则应答的桩 fetch。 */
function stubFetch(responder: (url: string) => Response): typeof fetch {
  return vi.fn(async (url: unknown) => responder(String(url))) as unknown as typeof fetch
}

describe('积分签到模块', () => {
  it('使用正确的端点路径', () => {
    expect(CHECKIN_ACTIVITY_STATUS_PATH).toBe('/v2/billing/meter/checkin-activity-status')
    expect(DAILY_CHECKIN_PATH).toBe('/v2/billing/meter/daily-checkin')
  })

  it('fetchCheckinStatus 解析活动状态', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, msg: 'OK',
      data: {
        active: true, today_checked_in: false, streak_days: 3, daily_credit: 100,
        today_credit: 0, is_streak_day: false, total_credits: 300,
        checkin_dates: ['2026-09-12', '2026-09-13'], activity_name: '开学季',
        theme_name: 'Buddy加油站', end_time: '2026-09-15 23:59:59',
      },
    }), { status: 200 }))
    const status = await fetchCheckinStatus(makeCredential(), BUDDY, fetcher)
    expect(status).toEqual({
      active: true, todayCheckedIn: false, streakDays: 3, dailyCredit: 100,
      todayCredit: 0, isStreakDay: false, totalCredits: 300,
      checkinDates: ['2026-09-12', '2026-09-13'], activityName: '开学季',
      themeName: 'Buddy加油站', endTime: '2026-09-15 23:59:59',
    })
  })

  it('fetchCheckinStatus 对缺失字段容错（不抛异常，取默认值）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    const status = await fetchCheckinStatus(makeCredential(), BUDDY, fetcher)
    expect(status).toEqual({
      active: false, todayCheckedIn: false, streakDays: 0, dailyCredit: 0,
      todayCredit: 0, isStreakDay: false, totalCredits: 0,
      checkinDates: [], activityName: '', themeName: '', endTime: '',
    })
  })

  it('fetchCheckinStatus 在网络失败时返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchCheckinStatus(makeCredential(), BUDDY, fetcher)).toBeNull()
  })

  it('fetchCheckinStatus 在非 0 code 时返回 null', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 200 }))
    expect(await fetchCheckinStatus(makeCredential(), BUDDY, fetcher)).toBeNull()
  })

  it('claimDailyCheckin 成功时返回 claimed 与领取数额', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, msg: 'OK', data: { credit: 100, streak_days: 1, is_streak_day: false },
    }), { status: 200 }))
    expect(await claimDailyCheckin(makeCredential(), BUDDY, fetcher)).toEqual({
      kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false,
    })
  })

  it('claimDailyCheckin 对 code 10001 返回 already-claimed（幂等，非错误）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 10001, msg: '今天已签到，请明天再来',
    }), { status: 400 }))
    const outcome = await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: '今天已签到，请明天再来' })
  })

  it('claimDailyCheckin 对 code 1001/1002/1003 同样视为非致命', async () => {
    for (const [code, expected] of [[1001, 'already-claimed'], [1002, 'inactive'], [1003, 'inactive']] as const) {
      const fetcher = stubFetch(() => new Response(JSON.stringify({ code, msg: `err ${code}` }), { status: 400 }))
      const outcome = await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
      expect(outcome.kind).toBe(expected)
    }
  })

  it('claimDailyCheckin 对其他错误返回 failed 并保留 code 与消息', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 500, msg: '服务器错误' }), { status: 500 }))
    expect(await claimDailyCheckin(makeCredential(), BUDDY, fetcher)).toEqual({
      kind: 'failed', code: 500, message: '服务器错误',
    })
  })

  it('claimDailyCheckin 在网络异常时返回 failed', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const outcome = await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(outcome.kind).toBe('failed')
    expect(outcome).toMatchObject({ message: expect.stringContaining('socket hang up') })
  })

  /**
   * 真实缺陷（上游 `553ef21` 修复）：凭据失效后腾讯网关返回的是 **HTML 错误页**
   * 而不是 JSON，而实现直接 `await response.json()`，于是抛出
   * `Unexpected token '<', "<html> <h"... is not valid JSON` —— 用户既看不出
   * 「凭据失效」，也想不到要重新登录。
   *
   * 修法：先取文本再解析，非 JSON 时给出带状态码的可读原因。
   */
  it('HTML 错误页（凭据失效）不抛 Unexpected token，而是可读的凭据提示', async () => {
    const fetcher = stubFetch(() => new Response(
      '<html><head><title>401 Unauthorized</title></head><body>...</body></html>',
      { status: 401 },
    ))
    const outcome = await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message).not.toContain('Unexpected token')
      expect(outcome.message).toContain('凭据已失效')
      expect(outcome.message).toContain('401')
      expect(outcome.message).toContain('重新登录')
    }
  })

  it('非 JSON 且非鉴权类状态码 → 带状态码与响应片段', async () => {
    const fetcher = stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }))
    const outcome = await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message).not.toContain('Unexpected token')
      expect(outcome.message).toContain('502')
      expect(outcome.message).toContain('非 JSON')
    }
  })

  it('状态查询与余额查询遇 HTML 错误页返回 null（不抛异常）', async () => {
    // 两者的契约都是「查不到返回 null」，不能因为服务端返回 HTML 就让异常
    // 冒泡到批量领取/批量查余额的循环里。
    const forbidden = stubFetch(() => new Response('<html>403</html>', { status: 403 }))
    await expect(fetchCheckinStatus(makeCredential(), BUDDY, forbidden)).resolves.toBeNull()
    const broken = stubFetch(() => new Response('<html>500</html>', { status: 500 }))
    await expect(fetchCreditBalance(makeCredential(), BUDDY, broken)).resolves.toBeNull()
  })

  it('请求携带产品码与 bearer 凭据，且不携带 X-Device-Token', async () => {
    let seen: Headers | undefined
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init?.headers as Headers
      return new Response(JSON.stringify({ code: 0, data: { credit: 100, streak_days: 1, is_streak_day: false } }), { status: 200 })
    }) as unknown as typeof fetch
    await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(seen?.get('Authorization')).toBe('Bearer AT')
    expect(seen?.get('X-Product-Code')).toBe('workbuddy')
    expect(seen?.get('X-User-Id')).toBe('uid-1')
    // 实测证明该风控头非必需，实现不依赖本地图灵盾 SDK
    expect(seen?.get('X-Device-Token')).toBeNull()
  })

  it('请求方法为 POST 且 body 为 {}', async () => {
    let method = ''
    let body: unknown
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      method = init?.method ?? ''
      body = init?.body
      return new Response(JSON.stringify({ code: 0, data: { credit: 1, streak_days: 1, is_streak_day: false } }), { status: 200 })
    }) as unknown as typeof fetch
    await claimDailyCheckin(makeCredential(), BUDDY, fetcher)
    expect(method).toBe('POST')
    expect(body).toBe('{}')
  })
})

/**
 * 积分余额（get-user-resource）。
 *
 * 固件取自 2026-09-15 对真实账号的实测响应，保留了容易踩坑的四处特征：
 * 双层嵌套、终身/周期两套口径并存、整数/精确值并存、已失效包混在列表里。
 *
 * WorkBuddy 国际版实测：Bonus Pack 247.87 + Free Plan 100 = **347.87**，
 * 与 IDE 顶部 "Credits Balance 347.87" 一致。
 */
describe('积分余额查询', () => {
  const REAL_BALANCE_RESPONSE = {
    code: 0,
    msg: 'OK',
    requestId: 'test',
    data: {
      Response: {
        Data: {
          TotalCount: 2,
          // 服务端的终身口径且取整；与本周期口径的 347.87 不同
          TotalDosage: 347,
          Accounts: [
            {
              PackageName: 'Bonus Pack',
              CapacityUnit: 'credit',
              CapacityRemain: 247,
              CapacitySize: 250,
              CapacityUsed: 2,
              CapacityRemainPrecise: '247.87',
              CapacitySizePrecise: '250',
              CapacityUsedPrecise: '2.13',
              CycleCapacityRemain: 247,
              CycleCapacityRemainPrecise: '247.87',
              CycleCapacitySize: 250,
              CycleCapacitySizePrecise: '250',
              CycleCapacityUsedPrecise: '2.13',
              Status: 0,
              ExpiredTime: '',
              CycleStartTime: '2026-09-14 10:05:57',
              CycleEndTime: '2026-09-28 10:05:56',
            },
            {
              PackageName: 'Free Plan Subscription',
              CapacityUnit: 'credits',
              CapacityRemain: 100,
              CapacitySize: 100,
              CapacityUsed: 0,
              CapacityRemainPrecise: '100',
              CapacitySizePrecise: '100',
              CycleCapacityRemain: 100,
              CycleCapacityRemainPrecise: '100',
              CycleCapacitySizePrecise: '100',
              Status: 0,
              ExpiredTime: '',
              CycleStartTime: '2026-09-01 00:00:00',
              CycleEndTime: '2026-09-30 23:59:59',
            },
          ],
        },
        RequestId: 'inner',
        ProTrialStatus: 0,
      },
    },
  }

  it('端点路径正确', () => {
    expect(USER_RESOURCE_PATH).toBe('/v2/billing/meter/get-user-resource')
  })

  it('解析双层嵌套的响应并汇总各包余额', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify(REAL_BALANCE_RESPONSE), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance).not.toBeNull()
    expect(balance!.packages).toHaveLength(2)
    expect(balance!.packages[0]).toMatchObject({
      name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, active: true,
    })
    expect(balance!.packages[1]).toMatchObject({
      name: 'Free Plan Subscription', remaining: 100, total: 100, used: 0, active: true,
    })
    expect(balance!.packages[0].cycleEndTime).toBe('2026-09-28 10:05:56')
  })

  it('总额与 IDE 的 Credits Balance 一致（347.87）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify(REAL_BALANCE_RESPONSE), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance!.total).toBe(347.87)
    // 服务端的 TotalDosage 是终身口径且取整，不能直接拿来用
    expect(balance!.total).not.toBe(347)
  })

  /**
   * 回归：额度必须取**本周期**口径（CycleCapacityRemain），不是终身口径
   * （CapacityRemain）。
   *
   * 真实事故——某 CodeBuddy 账号的体验版包终身还剩 500，但本周期已用尽
   * （CycleCapacityRemain=0）。用终身口径算出 655.67，而 IDE 显示 155.67；
   * 凭空多出的 500 让用户以为插件算错了。
   */
  it('取本周期口径而非终身口径（155.67 vs 655.67 的根因）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              // 体验版：终身还剩 500，但本周期已用尽
              {
                PackageName: 'CodeBuddy个人体验版', Status: 0, ExpiredTime: '',
                CapacityRemain: 500, CapacityRemainPrecise: '500',
                CycleCapacityRemain: 0, CycleCapacityRemainPrecise: '0',
              },
              {
                PackageName: '裂变包A', Status: 0, ExpiredTime: '',
                CapacityRemain: 55, CapacityRemainPrecise: '55.67000031',
                CycleCapacityRemain: 55, CycleCapacityRemainPrecise: '55.67000031',
              },
              {
                PackageName: '裂变包B', Status: 0, ExpiredTime: '',
                CapacityRemain: 100, CapacityRemainPrecise: '100',
                CycleCapacityRemain: 100, CycleCapacityRemainPrecise: '100',
              },
            ],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)

    // 0 + 55.67 + 100 —— 与 IDE 一致
    expect(balance!.total).toBe(155.67)
    // 明细同样用周期口径，与总数保持一致
    expect(balance!.packages[0]!.remaining).toBe(0)
  })

  it('精确值缺失时回退到整数字段', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [{ PackageName: 'X', CycleCapacityRemain: 42, CycleCapacitySize: 50, CycleCapacityUsed: 8 }] } } },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance!.packages[0]).toMatchObject({ remaining: 42, total: 50, used: 8 })
    expect(balance!.total).toBe(42)
  })

  it('包名逐级回退（PackageName → SubProductName → PackageCode）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { SubProductName: '次级名', Status: 0, CycleCapacityRemainPrecise: '1' },
              { PackageCode: 'CODE-ONLY', Status: 0, CycleCapacityRemainPrecise: '2' },
              { Status: 0, CycleCapacityRemainPrecise: '3' },
            ],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance!.packages.map(p => p.name)).toEqual(['次级名', 'CODE-ONLY', ''])
  })

  /**
   * 已失效的资源包：Status=3 或 ExpiredTime 已过。它们仍出现在 Accounts[] 里，
   * 额度可能非 0，但**不能**计入可用总额。
   */
  it('失效包不计入总额，但保留在明细里并由 active 标记', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              // Status=3 已过期，但仍有 200 额度
              {
                PackageName: '过期包', Status: 3, ExpiredTime: '2026-06-02 20:48:06',
                CycleCapacityRemain: 200, CycleCapacityRemainPrecise: '200',
              },
              {
                PackageName: '可用包', Status: 0, ExpiredTime: '',
                CycleCapacityRemain: 55, CycleCapacityRemainPrecise: '55.67000031',
              },
            ],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)

    expect(balance!.total).toBe(55.67)
    expect(balance!.expiredTotal).toBe(200)
    expect(balance!.packages[0]).toMatchObject({ name: '过期包', active: false, expiredTime: '2026-06-02 20:48:06' })
    expect(balance!.packages[1]).toMatchObject({ name: '可用包', active: true })
  })

  it('ExpiredTime 已过（即使 Status 为 0）也算失效', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{
              PackageName: 'X', Status: 0, ExpiredTime: '2020-01-01 00:00:00',
              CycleCapacityRemain: 999, CycleCapacityRemainPrecise: '999',
            }],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)

    expect(balance!.packages[0]!.active).toBe(false)
    expect(balance!.total).toBe(0)
    expect(balance!.expiredTotal).toBe(999)
  })

  it('未知 Status 值保守视为有效（不藏起可能可用的额度）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{
              PackageName: 'X', Status: 7, ExpiredTime: '',
              CycleCapacityRemain: 30, CycleCapacityRemainPrecise: '30',
            }],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)

    expect(balance!.packages[0]!.active).toBe(true)
    expect(balance!.total).toBe(30)
  })

  it('全部包都失效时总额为 0，失效合计不为 0', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: 'A', Status: 3, ExpiredTime: '2026-06-02 20:48:06', CycleCapacityRemainPrecise: '10' },
              { PackageName: 'B', Status: 3, ExpiredTime: '2026-06-06 09:52:06', CycleCapacityRemainPrecise: '20' },
            ],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)

    expect(balance!.total).toBe(0)
    expect(balance!.expiredTotal).toBe(30)
  })

  it('业务码非 0 时返回 null（不把错误当成 0 积分）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 10001, msg: 'boom' }), { status: 200 }))
    expect(await fetchCreditBalance(makeCredential(), BUDDY, fetcher)).toBeNull()
  })

  it('嵌套层级缺失时返回 null 而不是崩溃', async () => {
    for (const payload of [
      { code: 0 },
      { code: 0, data: {} },
      { code: 0, data: { Response: {} } },
      { code: 0, data: { Response: { Data: {} } } },
      // Accounts 不是数组
      { code: 0, data: { Response: { Data: { Accounts: 'nope' } } } },
    ]) {
      const fetcher = stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }))
      expect(await fetchCreditBalance(makeCredential(), BUDDY, fetcher)).toBeNull()
    }
  })

  it('网络异常返回 null 而不是抛出', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    expect(await fetchCreditBalance(makeCredential(), BUDDY, fetcher)).toBeNull()
  })

  it('Accounts 为空数组时余额为 0（区别于查询失败）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { Response: { Data: { Accounts: [] } } },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(0)
    expect(balance!.packages).toEqual([])
  })

  /**
   * 回归：多包累加的浮点尾数噪声。
   *
   * 服务端下发的精确值带浮点表示（55.67000031），直接累加会得到
   * 655.67000031 这种尾数——展示到分即可。
   */
  it('多包累加后规整为两位小数', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: 'A', Status: 0, CycleCapacityRemainPrecise: '500' },
              { PackageName: 'B', Status: 0, CycleCapacityRemainPrecise: '0' },
              { PackageName: 'C', Status: 0, CycleCapacityRemainPrecise: '0' },
              { PackageName: 'D', Status: 0, CycleCapacityRemainPrecise: '55.67000031' },
              { PackageName: 'E', Status: 0, CycleCapacityRemainPrecise: '100' },
            ],
          },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance!.total).toBe(655.67)
    // 明细保留原始精度，不做二次加工
    expect(balance!.packages[3]!.remaining).toBe(55.67000031)
  })

  it('单包时总额等于该包余额（不受规整影响）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: { Accounts: [{ PackageName: 'X', Status: 0, CycleCapacityRemainPrecise: '247.87' }] },
        },
      },
    }), { status: 200 }))
    const balance = await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(balance!.total).toBe(247.87)
  })

  /**
   * 两个产品通用同一端点：只有 baseURL 随 product.endpoint 变化。
   * 这是本功能能同时服务 CodeBuddy 与 WorkBuddy 的基础。
   */
  it('请求打到各自 product.endpoint（中国版 / 国际版都可用）', async () => {
    const seen: string[] = []
    const fetcher = vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchCreditBalance(makeCredential(), BUDDY_CN, fetcher)
    await fetchCreditBalance(makeCredential(), BUDDY, fetcher)

    expect(seen[0]).toBe('https://copilot.tencent.com/v2/billing/meter/get-user-resource')
    expect(seen[1]).toBe('https://www.workbuddy.ai/v2/billing/meter/get-user-resource')
  })

  it('请求头随产品切换（X-Product-Code 与 X-Domain）', async () => {
    let seen: Headers | undefined
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchCreditBalance(makeCredential(), BUDDY, fetcher)
    expect(seen?.get('X-Product-Code')).toBe('workbuddy')
    expect(seen?.get('X-Domain')).toBe('www.workbuddy.ai')
    expect(seen?.get('Authorization')).toBe('Bearer AT')
  })

  /**
   * 回归：X-Domain 必须跟随**产品**，不能跟随凭据里记录的历史域名。
   *
   * 真实场景——早期 workbuddy 指向中国版 copilot.tencent.com，改造为国际版后
   * 旧凭据的 domain 字段仍是 copilot.tencent.com。若 X-Domain 取凭据值，请求会
   * 打到 www.workbuddy.ai 却声明自己属于 copilot.tencent.com，身份标识与
   * baseURL 自相矛盾。
   */
  it('凭据 domain 与产品不符时，以产品配置为准', async () => {
    let seen: Headers | undefined
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }), { status: 200 })
    }) as unknown as typeof fetch

    // 凭据里是 CodeBuddy 的域名，但当前产品是 WorkBuddy
    const stale = { ...makeCredential(), domain: 'copilot.tencent.com' }
    await fetchCreditBalance(stale, BUDDY, fetcher)

    expect(seen?.get('X-Domain')).toBe('www.workbuddy.ai')
  })
})
