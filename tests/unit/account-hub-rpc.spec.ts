import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  accountCredentialRefName,
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  registerAccountHubRpc,
} from '../../src/account-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/account-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { createContextTierRegistry } from '../../src/context-tiers.js'
import type { ClaimOutcome, CheckinStatus, CreditBalance } from '../../src/credits.js'
import { BUDDY } from '../../src/product.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 账号凭据 ref 的归一化（连字符 → 下划线）。
 *
 * ## 为什么这条必须有测试
 *
 * provider id 允许带连字符（`trae-cn`），而 DSH 的 `credentialRef()` 只接受
 * `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`。不归一化时 `TRAE-CN_ACCOUNT_XXX`
 * 会让 `credentialRef()` 抛 TypeError，后果链是：凭据**从未落盘** → 账号池里
 * 留下永远没有凭据的条目 → 三个积分收集器在 `credentialRef(entry.credentialRef)`
 * 处一并抛错（面板显示「积分查询失败 / 领取失败」）→ 对话也不可用。
 *
 * 因此本组断言不满足于「形状对」：直接把结果喂给**真实的** `credentialRef()`，
 * 用它的接受与否作为判据 —— 那正是当初炸掉的那一步。
 */
describe('accountCredentialRefName（账号凭据 ref 归一化）', () => {
  const PROVIDERS = ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn'] as const

  it.each(PROVIDERS)('%s 产出的 ref 被 credentialRef() 接受，且前缀为 ^[A-Z_]+_ACCOUNT$', (provider) => {
    const name = accountCredentialRefName(provider, 'A1B2C3D4')
    // 不抛 TypeError = 当初那条后果链的断点已被修好。
    expect(() => credentialRef(name)).not.toThrow()
    // 整体形状：前缀 + 大写十六进制后缀。
    expect(name).toMatch(/^[A-Z_]+_ACCOUNT_[A-Z0-9]+$/)
    // 前缀（去掉后缀）必须匹配该模式 —— 连字符一旦漏折就会在这里现形。
    expect(name.replace(/_A1B2C3D4$/, '')).toMatch(/^[A-Z_]+_ACCOUNT$/)
    // 后缀必须原样保留（它是账号身份，不该被归一化动到）。
    expect(name.endsWith('_A1B2C3D4')).toBe(true)
  })

  it('trae-cn 归一化为 TRAE_CN_ACCOUNT，与产品配置的 accountCredentialRefPrefix 同值', () => {
    // 归一化后的前缀必须与 trae-cn-product.ts 的 accountCredentialRefPrefix
    // **逐字符一致** —— 后者是该前缀的唯一真相源，两处漂移会让凭据写到
    // 一个名字、读的时候找另一个名字。
    expect(accountCredentialRefName('trae-cn', 'A1B2C3D4'))
      .toBe(`${TRAE_CN.accountCredentialRefPrefix}_A1B2C3D4`)
    expect(TRAE_CN.accountCredentialRefPrefix).toBe('TRAE_CN_ACCOUNT')
  })

  it('无连字符的 provider 输出与归一化前**逐字符相同**（既有账号 ref 无需迁移）', () => {
    // 这四条锁住「改动不外溢」：回归时若有人顺手改了大小写或分隔符，
    // 用户既有账号的凭据会瞬间全部失联。
    expect(accountCredentialRefName('codearts', 'A1B2C3D4')).toBe('CODEARTS_ACCOUNT_A1B2C3D4')
    expect(accountCredentialRefName('buddy-cn', 'A1B2C3D4')).toBe('BUDDY_CN_ACCOUNT_A1B2C3D4')
    expect(accountCredentialRefName('buddy', 'A1B2C3D4')).toBe('BUDDY_ACCOUNT_A1B2C3D4')
    expect(accountCredentialRefName('lobsterai', 'A1B2C3D4')).toBe('LOBSTERAI_ACCOUNT_A1B2C3D4')
  })

  it('多个连字符也全部折成下划线（不留下第二个非法字符）', () => {
    expect(accountCredentialRefName('a-b-c', 'X')).toBe('A_B_C_ACCOUNT_X')
  })
})

describe('积分领取结果汇总', () => {
  it('统计成功数量与累计积分', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 50, streakDays: 2, isStreakDay: true },
      { kind: 'already-claimed', message: '今天已签到' },
      { kind: 'failed', code: 500, message: 'boom' },
    ]
    // ⚠️ 精确形状（`toEqual` 而非 `toMatchObject`）是刻意的：新增一个 kind 时
    // **必须**在这里多写一格，否则一个「有产生者、却没人计数」的 kind 会静默漏计。
    // `abnormal`（签到前后余额没变）与 `undetermined`（Qoder 空活动列表）是
    // 2026-09-24 新增的两个独立计数栏，本用例不产它们 ⇒ 都是 0。
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 2, totalCredit: 150, alreadyClaimed: 1, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 1,
    })
  })

  it('全部已领取时 claimed 为 0', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ claimed: 0, totalCredit: 0, alreadyClaimed: 2 })
  })

  it('混合 inactive 与 failed 分别计数', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'inactive', message: '活动未开启' },
      { kind: 'failed', code: 1, message: 'x' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ inactive: 1, failed: 1, claimed: 0 })
  })

  /**
   * `unavailable`（2026-09-23 新增，唯一生产者是 Trae CN 的 `9074`）**独立计数**，
   * 不并入 `failed`。
   *
   * 这条断言守的是**语义**而不只是数字：两者对用户的含义相反 —— `failed` 是
   * 「你需要做点什么」（重新登录 / 校准设备头），`unavailable` 是「什么都不用做，
   * 4 小时后的自动 sweep 会重试」。并进 failed 会让界面报出一个不需要行动的
   * 「失败」，用户只会白折腾一轮。
   */
  it('unavailable 独立计数，且**不**并入 failed（两者对用户的含义相反）', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'unavailable', code: 9074, message: '当前参与用户太多，请稍后再试' },
      { kind: 'failed', code: 1001, message: '凭据已失效' },
      { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 1, totalCredit: 10, alreadyClaimed: 0, inactive: 0,
      unavailable: 1, abnormal: 0, undetermined: 0, failed: 1,
    })
  })

  it('空数组返回全 0', () => {
    expect(computeClaimSummary([])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 0,
    })
  })

  it('未知 kind 兜底计入 failed，而不是被静默漏计', () => {
    // 模拟 ClaimOutcome 未来新增 kind、但汇总分支未同步更新的情况。
    // ⚠️ 注意本兜底只覆盖「**运行期**出现了类型声明之外的 kind」；类型层面新增
    // kind 会被 computeClaimSummary 的 `never` 穷尽性检查当场拦下（编译不过），
    // 那条闸比这条运行期兜底更早生效。
    const unknown = { kind: 'brand-new-kind', message: 'x' } as unknown as ClaimOutcome
    expect(computeClaimSummary([unknown, { kind: 'inactive', message: 'i' }]))
      .toMatchObject({ failed: 1, inactive: 1, claimed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────
// 逐账号异常隔离（Task 8 补充修复）
//
// 直接调用 RPC 端点需要构造 ctx.connection.fetch.register 替身，
// 因此端点已把「逐账号处理」抽成 collectCreditsStatus / collectClaimResults
// 两个可导出函数（方案 A）。这里对它们单测：既能精确断言单账号隔离，
// 又能验证顺序性，且完全不发起网络请求（fetchStatus / claim 均注入桩）。
// ─────────────────────────────────────────────────────────────

/** 构造账号条目；默认是启用的合法账号。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'buddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'BUDDY_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 最小合法凭据 JSON。 */
const VALID_CREDENTIAL_JSON = JSON.stringify({
  access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
})

/** 构造签到状态。 */
function makeStatus(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100,
    todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
    activityName: 'a', themeName: 't', endTime: '', ...overrides,
  }
}

/**
 * 构造依赖替身。
 * 默认：所有 ref 都能解析出合法凭据，状态接口返回「可领取」，领取返回成功。
 */
function makeDeps(overrides: Partial<CreditsEndpointDeps> = {}): CreditsEndpointDeps {
  return {
    resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
    fetchStatus: async () => makeStatus(),
    claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    ...overrides,
  }
}

describe('credits.status 单账号异常隔离', () => {
  it('非法 credentialRef 只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const asked: string[] = []
    const deps = makeDeps({
      resolve: async (ref) => {
        asked.push(String(ref))
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, BUDDY, deps)

    // 三个账号都要出现在结果里（不是整批抛异常）
    expect(results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(results[0]?.status).toBeNull()
    // 关键：坏账号之后的两个账号确实被继续处理
    expect(results[1]?.status).not.toBeNull()
    expect(results[2]?.status).not.toBeNull()
    // 坏账号根本没走到 resolve（名称校验先抛）
    expect(asked).toEqual(['BUDDY_ACCOUNT_AAAA1111', 'BUDDY_ACCOUNT_AAAA1111'])
  })

  it('resolve 抛错只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => {
        resolveCalls++
        // 第一个账号的 resolve 抛错（如凭据已被外部删除）；后续账号正常。
        if (resolveCalls === 1) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, BUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['boom', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toEqual(makeStatus())
    expect(resolveCalls).toBe(2)
  })

  it('JSON 损坏与网络失败都只影响该账号', async () => {
    const accounts = [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'network-down' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => ({ value: resolveCalls++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      // 第二个账号（network-down）的状态请求抛网络错误
      fetchStatus: async () => {
        if (resolveCalls === 2) throw new Error('socket hang up')
        return makeStatus()
      },
    })

    const results = await collectCreditsStatus(accounts, BUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['corrupt', 'network-down', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toBeNull()
    expect(results[2]?.status).toEqual(makeStatus())
  })

  it('停用账号同样处理（停用与签到无关），异常出口收到告警', async () => {
    const warnings: string[] = []
    const accounts = [
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'bad-ref', credentialRef: '非法名称' }),
    ]
    const results = await collectCreditsStatus(accounts, BUDDY, makeDeps({
      warn: (msg) => warnings.push(msg),
    }))

    // 停用只影响账号池的自动选择与限流切换，不改变「该账号今天领了没」，
    // 故两个账号都要出现在结果里。
    expect(results.map(r => r.accountId)).toEqual(['off', 'bad-ref'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad-ref')
  })

  it('凭据解析为 undefined 时状态为 null，且不调用状态接口', async () => {
    let statusCalls = 0
    const results = await collectCreditsStatus([makeEntry({ id: 'noconf' })], BUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { statusCalls++; return makeStatus() },
    }))

    expect(results[0]?.status).toBeNull()
    expect(statusCalls).toBe(0)
  })
})

describe('credits.claimAll 单账号异常隔离与顺序性', () => {
  it('停用账号也被领取（一键领取覆盖全部账号）', async () => {
    const accounts = [
      makeEntry({ id: 'enabled-1', enabled: true }),
      makeEntry({ id: 'disabled-1', enabled: false }),
      makeEntry({ id: 'disabled-2', enabled: false }),
    ]
    const deps = makeDeps({
      claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    })

    const response = await collectClaimResults(accounts, BUDDY, deps)

    // 停用只影响账号池的自动选择与限流切换；积分照领。
    expect(response.results.map(r => r.accountId)).toEqual(['enabled-1', 'disabled-1', 'disabled-2'])
    expect(response.results.every(r => r.outcome.kind === 'claimed')).toBe(true)
    expect(response.summary).toEqual({
      claimed: 3, totalCredit: 300, alreadyClaimed: 0, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 0,
    })
  })

  it('非法 credentialRef 的账号记为 failed，其余账号仍被领取', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const claimed: string[] = []
    const deps = makeDeps({
      claim: async () => {
        claimed.push(`claim-${claimed.length}`)
        return { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, BUDDY, deps)

    // 整批成功返回，三个账号都有结果
    expect(response.results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', code: -1 })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.results[2]?.outcome).toMatchObject({ kind: 'claimed' })
    // 坏账号没有阻止后两个账号真正发起领取
    expect(claimed).toHaveLength(2)
    expect(response.summary).toEqual({
      claimed: 2, totalCredit: 200, alreadyClaimed: 0, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 1,
    })
  })

  it('resolve 抛错被收敛为该账号的 failed，不冒泡中断整批', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let first = true
    const deps = makeDeps({
      resolve: async () => {
        if (first) { first = false; throw new Error('凭据已被外部删除') }
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, BUDDY, deps)

    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', message: '凭据已被外部删除' })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.summary.failed).toBe(1)
    expect(response.summary.claimed).toBe(1)
  })

  it('凭据未配置记为 failed 且不发起任何请求', async () => {
    let touched = 0
    const response = await collectClaimResults([makeEntry({ id: 'noconf' })], BUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { touched++; return makeStatus() },
      claim: async () => { touched++; return { kind: 'failed', code: -1, message: 'x' } },
    }))

    expect(response.results[0]?.outcome).toEqual({ kind: 'failed', code: -1, message: '凭据未配置' })
    expect(touched).toBe(0)
  })

  it('保持「先查状态再领取」：活动未开启/今日已签到时跳过领取请求', async () => {
    const accounts = [makeEntry({ id: 'inactive' }), makeEntry({ id: 'done' }), makeEntry({ id: 'ready' })]
    let call = 0
    const claimCalls: string[] = []
    const deps = makeDeps({
      fetchStatus: async () => {
        call++
        if (call === 1) return makeStatus({ active: false })
        if (call === 2) return makeStatus({ todayCheckedIn: true })
        return makeStatus()
      },
      claim: async () => {
        claimCalls.push('claim')
        return { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, BUDDY, deps)

    expect(response.results.map(r => r.outcome.kind))
      .toEqual(['inactive', 'already-claimed', 'claimed'])
    // 只有第三个账号真正调用了领取接口
    expect(claimCalls).toHaveLength(1)
  })

  it('顺序执行：任一时刻只有一个账号在处理（不并发）', async () => {
    const accounts = [
      makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' }),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      resolve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return makeStatus()
      },
      claim: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false }
      },
    })

    await collectClaimResults(accounts, BUDDY, deps)

    expect(maxInFlight).toBe(1)
  })

  it('按账号顺序串行，且结果顺序与账号顺序一致', async () => {
    const accounts = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]
    const order: string[] = []
    let seq = 0
    const deps = makeDeps({
      // 让先启动的账号耗时更长，若并发则 c 会先完成
      resolve: async () => {
        const mine = seq++
        await new Promise(r => setTimeout(r, mine === 0 ? 10 : 1))
        order.push(`entry-${mine}`)
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, BUDDY, deps)

    expect(order).toEqual(['entry-0', 'entry-1', 'entry-2'])
    expect(response.results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * collectCreditBalances：逐账号收集积分余额。
 *
 * 与状态/领取的关键差异是**保留失败原因**——账号卡片要显示"为什么没查到"，
 * 把它降级成 null 会让 UI 显示成空白，用户无从判断是余额为 0 还是查询失败。
 */
describe('credits.balances 逐账号余额收集', () => {
  const BALANCE: CreditBalance = {
    total: 347.87,
    packages: [
      { name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, cycleStartTime: '', cycleEndTime: '2026-09-28 10:05:56' },
      { name: 'Free Plan Subscription', unit: 'credits', remaining: 100, total: 100, used: 0, cycleStartTime: '', cycleEndTime: '2026-09-30 23:59:59' },
    ],
  }

  it('成功时回传余额与包明细', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances([makeEntry({ id: 'a' })], BUDDY, deps)

    expect(results).toEqual([{ accountId: 'a', nickname: '测试号', balance: BALANCE }])
  })

  it('余额为 0 与查询失败严格区分', async () => {
    const empty: CreditBalance = { total: 0, packages: [] }
    let call = 0
    const deps = makeDeps({ fetchBalance: async () => (call++ === 0 ? empty : null) })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'zero' }), makeEntry({ id: 'failed' })], BUDDY, deps,
    )

    // 第一个真余额 0：可展示为 0，不算错误
    expect(results[0]!.balance).toEqual(empty)
    expect(results[0]!.error).toBeUndefined()
    // 第二个查不到：balance 为 null 且带原因，UI 不能显示成 0
    expect(results[1]!.balance).toBeNull()
    expect(results[1]!.error).toBe('余额查询失败')
  })

  it('凭据未配置时给出原因，且不发起余额请求', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances([makeEntry({ id: 'noconf' })], BUDDY, deps)

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBe('凭据未配置')
    expect(touched).toBe(0)
  })

  it('单个账号异常不中断整批，且记录该账号的原因', async () => {
    let call = 0
    const warnings: string[] = []
    const deps = makeDeps({
      resolve: async () => {
        if (call++ === 0) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchBalance: async () => BALANCE,
      warn: (msg) => warnings.push(msg),
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })], BUDDY, deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe('凭据已被外部删除')
    expect(results[0]!.balance).toBeNull()
    expect(results[1]!.balance).toEqual(BALANCE)
    expect(warnings).toHaveLength(1)
  })

  it('凭据 JSON 损坏只影响该账号', async () => {
    let call = 0
    const deps = makeDeps({
      resolve: async () => ({ value: call++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      fetchBalance: async () => BALANCE,
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'ok' })], BUDDY, deps,
    )

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBeDefined()
    expect(results[1]!.balance).toEqual(BALANCE)
  })

  it('停用账号同样查询（停用与余额无关）', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'off', enabled: false })], BUDDY, deps,
    )

    expect(results[0]!.balance).toEqual(BALANCE)
  })

  it('顺序执行，不并发（避免风控）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      fetchBalance: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return BALANCE
      },
    })
    await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], BUDDY, deps,
    )

    expect(maxInFlight).toBe(1)
  })

  it('结果顺序与账号顺序一致', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], BUDDY, deps,
    )

    expect(results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * ⚠️ **真实缺陷回归：`as unknown as` 签名谎言 ⇒ `fetcher is not a function`。**
 *
 * `fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance` 的真实签名是
 * `(credential, product, fetcher)`，而 `CreditsEndpointDeps` 把它们声明为两参。
 * 历史写法 `deps.claim ?? (claimDailyCheckin as unknown as …)` 用双重断言把签名
 * 不匹配「压」了过去 —— TypeScript 不再报错，但**一旦调用点按声明多传一个实参**
 * （`claim(credential, product, entry)`），那个 `entry` 就落进 `fetcher` 的位置，
 * 运行时抛 `TypeError: fetcher is not a function`。
 *
 * ⚠️ **为什么长期零覆盖**：`makeDeps()` **总是注入** `fetchStatus` / `claim`，
 * 于是真实的默认实现路径**从未被任何用例走到**。本组用例刻意**只给
 * `resolve` + `fetcher`**，把三条默认实现全部拉进执行路径。
 */
describe('credits 默认实现（未注入 deps 时）—— as unknown as 签名谎言回归', () => {
  /** 只记录请求、按端点返回真实形态响应的 fetcher 替身。 */
  function makeFetcher(): { fetcher: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/checkin-activity-status')) {
        // ⚠️ 字段名必须是真实的 `active` / `today_checked_in`（见 fetchCheckinStatus），
        // 名字写错会被 readBool 读成 false → 流程落到「活动未开启」短路。
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false, streak_days: 3 },
        }), { status: 200 })
      }
      if (url.includes('/daily-checkin')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { credit: 100, streak_days: 3, is_streak_day: false },
        }), { status: 200 })
      }
      // 余额端点是**双层嵌套** `data.Response.Data.Accounts[]`（见 fetchCreditBalance）。
      return new Response(JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: 'Bonus Pack',
                Status: 1,
                CycleCapacityRemainPrecise: '347.87',
                CapacityRemainPrecise: '347.87',
              }],
            },
          },
        },
      }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  it('collectCreditsStatus 走真实默认实现，fetcher 被当成函数调用', async () => {
    const { fetcher, calls } = makeFetcher()
    // ⚠️ 关键：**不传** fetchStatus。
    const results = await collectCreditsStatus([makeEntry({ id: 'cb-1' })], BUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher,
    })

    expect(results[0]!.status).toMatchObject({ active: true, todayCheckedIn: false, streakDays: 3 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/checkin-activity-status')
  })

  it('collectClaimResults 走真实默认实现，第三参必须是 fetcher 而不是 entry（真实缺陷回归）', async () => {
    const { fetcher, calls } = makeFetcher()
    // ⚠️ 关键：**不传** claim / fetchStatus，只注入 fetcher。
    const response = await collectClaimResults([makeEntry({ id: 'cb-1' })], BUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher,
    })

    const outcome = response.results[0]?.outcome
    // 缺陷形态：`entry` 被当成 fetcher 调用 ⇒ 这条消息出现，且下面两条断言同时失败。
    if (outcome?.kind === 'failed') {
      expect(outcome.message).not.toContain('fetcher is not a function')
    }
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 预检 + 领取两次真实请求（顺序固定）。
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/checkin-activity-status')
    expect(calls[1]).toContain('/daily-checkin')
  })

  it('collectClaimResults 未注入 claim 且 precheckStatus=false 时同样走默认实现', async () => {
    // LobsterAI 形态：跳过预检、直接领取。默认实现仍必须把 fetcher 送进第三参。
    const { fetcher, calls } = makeFetcher()
    const response = await collectClaimResults([makeEntry({ id: 'cb-1' })], BUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      precheckStatus: false,
      fetcher,
    })

    expect(response.results[0]!.outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 跳过预检 ⇒ 只发领取那一次。
    expect(calls).toEqual([expect.stringContaining('/daily-checkin')])
  })

  it('collectCreditBalances 走真实默认实现，fetcher 被当成函数调用', async () => {
    const { fetcher, calls } = makeFetcher()
    // ⚠️ 关键：**不传** fetchBalance。
    const results = await collectCreditBalances([makeEntry({ id: 'cb-1' })], BUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher,
    })

    expect(results[0]!.balance?.total).toBe(347.87)
    expect(results[0]!.error).toBeUndefined()
    expect(calls).toEqual([expect.stringContaining('/get-user-resource')])
  })

  it('未提供 fetcher 时回退全局 fetch（不抛 fetcher is not a function）', async () => {
    // 默认实现必须能在**完全没有 fetcher 注入**时也正常降级到全局 fetch ——
    // 生产路径（src/account-hub-rpc.ts 的三处默认分支）就是这个形态。
    const original = globalThis.fetch
    const { fetcher, calls } = makeFetcher()
    globalThis.fetch = fetcher
    try {
      const results = await collectCreditsStatus([makeEntry({ id: 'cb-1' })], BUDDY, {
        resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      })
      expect(results[0]!.status).toMatchObject({ active: true })
      expect(calls).toHaveLength(1)
    } finally {
      globalThis.fetch = original
    }
  })
})

/**
 * model.list / model.setDisabled 端点。
 *
 * 这两个端点是 Account Hub「显示列表」按钮的唯一数据通道，同时串起三件必须
 * 一起正确的事：
 * 1. 列表来自 `ctx.llm.listModels()`（对话框模型选择器读的同一份目录）；
 * 2. 黑名单经 AccountPool 持久化；
 * 3. 关闭后的模型从对话框选择器里消失，**但在设置页仍可被重新打开**。
 *
 * 因此这里用「注册端点 → 通过 HTTP 请求调用 → 断言响应」的方式做端到端
 * 验证，而不是分别测两个函数——两者的衔接正是最容易出错的地方。
 *
 * ⚠️ 第 3 条的两个方向必须都覆盖，且**桩必须模拟真实适配器的过滤行为**：
 * 真实 `listModels` 会实时剔除黑名单命中的模型，所以 `model.list` 绝不能在
 * 一个已被过滤的目录上「回填 disabled」——那样被关闭的模型会连同开关一起
 * 消失，用户再也无法重新打开（历史 bug）。早期版本的桩是
 * `options.models.map(...)`（从不过滤），恰好绕过这个矛盾，导致该 bug 在
 * 「注释声称已验证第 3 条」的情况下依然漏到了线上。
 */
describe('model.list / model.setDisabled 端点', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 构造带 RPC 端点所需的 ctx 替身，返回注册进去的 fetch 处理器。 */
  function registerEndpoints(options: {
    models: Array<{ id: string; name: string }>
    disabledModels?: Record<string, Record<string, boolean>>
    /** listModels 抛错时用于验证错误路径。 */
    listModelsError?: string
    /** 省略 llm 服务（验证降级行为）。 */
    withoutLlm?: boolean
    /**
     * 是否让桩复刻真实适配器的黑名单过滤（默认 true）。
     *
     * 真实 `CodeArtsAdapter.listModels` / `BuddyAdapter.listModels` 都会实时
     * 剔除 `disabledModelsFor(provider)` 命中的模型，因此桩默认也必须过滤，
     * 否则「端点在一个已过滤目录上回填 disabled」这类缺陷会被静默绕过。
     * 仅当需要验证「适配器未过滤」这一非真实场景时才置为 false。
     */
    adapterFiltersDisabledModels?: boolean
    /**
     * 预置账号列表（用于断言整体 replace 不会把 accounts 写坏）。
     *
     * ⚠️ 形状必须是**完整**的 `ProviderAccountEntry`：`writeModels` 走的是整体
     * replace，若这里塞个残缺对象，测出来的会是「替身数据不全」而不是真实缺陷。
     */
    accounts?: Array<Record<string, unknown>>
    /** 预置数据版本号（断言它将随 replace 一起被携带）。 */
    schemaVersion?: number
    /** 预置上下文窗口预算（按 provider → 模型存）。 */
    contextBudgets?: Record<string, Record<string, number>>
    /**
     * 窗口档位来源（`registerAccountHubRpc` 的第 10 个参数）—— **按 provider id 分键**
     * 的注册表，缺省的键就是「该 provider 不参与档位机制」。
     *
     * 省略即「未接线」：`model.list` 不带窗口字段、`model.setContextBudget` 一律拒绝
     * （headless / 未传适配器时的既定降级）。
     */
    contextTiers?: Record<string, { contextTiers(): Promise<Map<string, { contextWindow?: number; maxContextWindow?: number; contextTiers?: number[] }>> } | undefined>
  }) {
    // settings 替身：内存里保存 namespace 的值，语义与真实服务一致的
    // 「整体 replace」。
    let stored: Record<string, unknown> = {
      accounts: options.accounts ?? [],
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
      ...options.contextBudgets !== undefined ? { contextBudgets: options.contextBudgets } : {},
      ...options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {},
    }
    let handler: Handler | undefined
    // 落盘次数：用于断言「没有垃圾键时不写盘」。
    let writes = 0

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value; writes++ },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { fetch: Handler }) => { handler = config.fetch },
            },
          }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              // 复刻真实适配器：黑名单命中的模型不会出现在 listModels 结果里。
              // 读的是 settings 替身的当前值（而非构造时的快照），这样
              // model.setDisabled 之后的下一次 listModels 会立刻反映过滤结果，
              // 与真实「每次调用都实时读账号池」的语义一致。
              const disabled = options.adapterFiltersDisabledModels !== false
                ? ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider] ?? {})
                : {}
              return options.models
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
      // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
      // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerAccountHubRpc
      // 会以 `ctx.inject is not a function` 直接抛错。
      //
      // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用（本替身里 connection
      // 始终可用），使端点注册行为与 Web profile 下完全一致。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
    }

    registerAccountHubRpc(
      ctx as never, pool, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      // 生产路径传的是 `createContextTierRegistry(...)` 的产物；这里**走同一个
      // 构造函数**，而不是手搓一个带 `sourceFor` 的对象 —— 否则测试可能在一个
      // 与生产不同的分派实现上通过（注册表的丢弃 undefined 键等语义要一起覆盖）。
      options.contextTiers === undefined ? undefined : createContextTierRegistry(options.contextTiers) as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    /** 调用一个端点方法，返回解包后的 result。 */
    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/account-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'account-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored, writeCount: () => writes }
  }

  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  it('model.list 回传 llm 的模型目录，并把黑名单回填为 disabled', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { 'buddy-cn': { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.ok).toBe(true)
    // hy3 已被适配器过滤掉（桩复刻了真实过滤），由端点补回列表；
    // 补回的条目拿不到原始 name，回退为 id —— 这是与契约一致的取舍：
    // 设置页需要的是「能重新打开它」，而不是它的展示名。
    expect(result.value).toEqual({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', disabled: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', disabled: false },
        { id: 'hy3', name: 'hy3', disabled: true },
      ],
    })
  })

  /**
   * 回归测试：关闭 → 列表 → 重新打开的完整往返。
   *
   * 历史 bug：`model.list` 直接在 `llm.listModels()`（已被适配器过滤）的结果上
   * 回填 disabled，被关闭的模型不在数组里，它的开关因此从设置页彻底消失，
   * 用户无法重新打开。此用例锁死「关掉的模型必须仍在 model.list 里且可被 reopen」。
   */
  it('关闭模型后它仍出现在 model.list 中（可被重新打开），但不在对话框目录里', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    // 初始：全部可见、全部打开
    const before = await call('model.list', { provider: 'buddy-cn' })
    expect((before.value as { models: Array<{ id: string }> }).models.map(m => m.id))
      .toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])

    // 关闭 hy3
    await call('model.setDisabled', { provider: 'buddy-cn', modelId: 'hy3', disabled: true })

    // 关键断言：hy3 仍出现在设置页列表里，且标记为已关闭 —— 否则无法重新打开
    const after = await call('model.list', { provider: 'buddy-cn' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    const hy3 = models.find(m => m.id === 'hy3')
    expect(hy3).toBeDefined()
    expect(hy3!.disabled).toBe(true)
    // 其余模型不受影响
    expect(models.filter(m => m.disabled).map(m => m.id)).toEqual(['hy3'])

    // 重新打开：hy3 恢复正常显示
    await call('model.setDisabled', { provider: 'buddy-cn', modelId: 'hy3', disabled: false })
    const reopened = await call('model.list', { provider: 'buddy-cn' })
    const reopenedModels = (reopened.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(reopenedModels.map(m => m.id)).toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])
    expect(reopenedModels.every(m => !m.disabled)).toBe(true)
  })

  /**
   * 关闭多个模型（含连续操作）后，全部都能在设置页找到。
   *
   * 覆盖用户实际场景：连续关掉多个模型后想找回其中一个。
   */
  it('连续关闭多个模型后，每个都仍可在 model.list 中找到并重新打开', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    for (const id of ['glm-5.2', 'hy3']) {
      await call('model.setDisabled', { provider: 'buddy-cn', modelId: id, disabled: true })
    }

    const listed = await call('model.list', { provider: 'buddy-cn' })
    const models = (listed.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.map(m => m.id).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    expect(models.filter(m => m.disabled).map(m => m.id).sort()).toEqual(['glm-5.2', 'hy3'])
  })

  it('未配置黑名单时全部模型默认打开（黑名单制）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.list', { provider: 'buddy' })
    const models = (result.value as { models: Array<{ disabled: boolean }> }).models

    expect(models.every(m => m.disabled === false)).toBe(true)
  })

  it('黑名单按 provider 隔离', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { 'buddy-cn': { hy3: true } },
    })

    const buddyCn = await call('model.list', { provider: 'buddy-cn' })
    const buddy = await call('model.list', { provider: 'buddy' })

    const flagOf = (result: unknown, id: string) =>
      (result as { models: Array<{ id: string; disabled: boolean }> }).models.find(m => m.id === id)!.disabled

    expect(flagOf(buddyCn.value, 'hy3')).toBe(true)
    // 另一个 provider 的同名模型不受影响
    expect(flagOf(buddy.value, 'hy3')).toBe(false)
  })

  it('model.setDisabled 持久化到 settings，并在后续 model.list 中生效', async () => {
    const { call, storedValue } = registerEndpoints({ models: MODELS })

    const set = await call('model.setDisabled', { provider: 'buddy-cn', modelId: 'hy3', disabled: true })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ provider: 'buddy-cn', disabledModels: { hy3: true } })
    // 落盘内容可核对：
    expect(storedValue().disabledModels).toEqual({ 'buddy-cn': { hy3: true } })

    const list = await call('model.list', { provider: 'buddy-cn' })
    const hy3 = (list.value as { models: Array<{ id: string; disabled: boolean }> })
      .models.find(m => m.id === 'hy3')!
    expect(hy3.disabled).toBe(true)
  })

  it('重新打开时从黑名单移除（写 false 不残留）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { 'buddy-cn': { hy3: true } },
    })

    const set = await call('model.setDisabled', { provider: 'buddy-cn', modelId: 'hy3', disabled: false })

    expect(set.value).toEqual({ provider: 'buddy-cn', disabledModels: {} })
    expect(storedValue().disabledModels).toEqual({})
  })

  it('model.setDisabled 缺少 modelId 时返回 bad-request 而不是静默成功', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.setDisabled', { provider: 'buddy-cn', modelId: '' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('modelId')
  })

  it('llm 服务不可用时 model.list 返回可读错误（账号面板不受影响）', async () => {
    const { call } = registerEndpoints({ models: MODELS, withoutLlm: true })
    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })

  it('适配器 listModels 抛错时返回可读错误而不是裸 500', async () => {
    const { call } = registerEndpoints({ models: MODELS, listModelsError: '令牌已过期' })
    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('令牌已过期')
  })

  /**
   * 黑名单并集回填的**垃圾键过滤**（2026-09-20 报障修复）。
   *
   * ## 缺陷形态（真机取证）
   *
   * 目录过滤网上线（`1e2e15b`）后，`trae-cn` 的 `listModels` 只报 13 项、
   * 0 custom / 0 invisible。但 Account Hub「显示列表」弹窗仍有 **43 行**，
   * 其中 14 个 `custom_model_*` —— 全由 `model.list` 的回填侧补回来的：
   * `13（目录）∪ 30（黑名单里的历史键）= 43`。
   *
   * 这 30 个键是用户在过滤网上线**之前**从 UI 关掉的 custom / invisible / 内部项。
   * 副作用：它们已在黑名单里，用户点开关只会在**同一批键上**增删，
   * 列表永远清不掉这批僵尸行。
   *
   * ## 为什么回填机制本身要保留
   *
   * 「目录里暂时消失但黑名单仍记录」是**真实且合法**的状态（模型临时下线），
   * 回填让用户能把它重新打开。所以修法是**过滤回填源**，不是删掉回填：
   * 下面第 2 组用例专门锁住「正常模型哪怕不在目录里也必须回填」。
   */
  describe('model.list 黑名单并集：垃圾键不回填（custom / invisible / 内部项）', () => {
  /**
   * 真机 13 项目录里的一小段代表 + 黑名单里的历史僵尸键。
   *
   * 垃圾键清单逐字符取自实测（见 `tests/unit/trae-cn-adapter.spec.ts` 的
   * `TRAE_CN_CUSTOM_MODEL_IDS` / `TRAE_CN_INVISIBLE_IDS`）：custom 项、内部
   * agent 项、客户端自隐项各取样，覆盖三道判据。
   */
  const TRAE_MODELS = [
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'kimi-k3', name: 'Kimi-K3' },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max' },
  ]
  const JUNK_KEYS = [
    // custom（账号私有 BYOK）—— 真机 14 项
    'custom_model_gemini',
    'custom_model_deepseek_chat',
    'custom_model_placeholder',
    // 内部 agent 项
    'summary',
    'explore_sub_agent_v2',
    // 客户端自隐项（`is_invisible_to_user:true`）
    'sagitta',
    'aquila',
    'glm-5',
    'Doubao-Seed-2.0-Code',
    'seed-code-pro-0430',
    // 形态命中的内部项（未点名的将来项也要挡住）
    'some_new_agent_thing',
  ]

  it('**垃圾键不回填**，目录项照常返回（复刻真机 13 ∪ 30 的泄漏形态）', async () => {
    const { call } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: {
        'trae-cn': Object.fromEntries(JUNK_KEYS.map((id) => [id, true])),
      },
    })

    const result = await call('model.list', { provider: 'trae-cn' })
    const models = (result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }).models

    expect(result.ok).toBe(true)
    // 只有目录那 3 项 —— 一个僵尸行都不许出现。
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'kimi-k3', 'qwen3.8-max'])
    expect(models.every((m) => m.disabled === false)).toBe(true)
    // 反向断言（防「过滤条件写反了」把目录项一起干掉）：
    expect(models.some((m) => m.id.startsWith('custom_model_'))).toBe(false)
  })

  it('**正常模型不在目录里时仍回填**（回填机制不能因过滤一起被删掉）', async () => {
    const { call } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: { 'trae-cn': { 'glm-5.2': true, custom_model_gemini: true } },
    })

    const result = await call('model.list', { provider: 'trae-cn' })
    const models = (result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }).models

    // `glm-5.2` 是**真机 13 项里的正常模型**，临时不在目录里 → 必须保留开关，
    // 否则用户再也无法重新打开它（这正是回填机制存在的理由）。
    const glm52 = models.find((m) => m.id === 'glm-5.2')
    expect(glm52).toBeDefined()
    expect(glm52!.disabled).toBe(true)
    // 同一批里的 custom 键则不回填。
    expect(models.some((m) => m.id === 'custom_model_gemini')).toBe(false)
  })

  it('**顺手清尸**：垃圾键从 settings 的 disabledModels 里被剔除，正常键保留', async () => {
    const { call, storedValue } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: {
        'trae-cn': {
          ...Object.fromEntries(JUNK_KEYS.map((id) => [id, true])),
          'glm-5.2': true,
        },
      },
    })

    await call('model.list', { provider: 'trae-cn' })

    // 僵尸键落盘内容里已不存在 —— 用户换回旧版本插件也不会再看到它们。
    expect(storedValue().disabledModels).toEqual({ 'trae-cn': { 'glm-5.2': true } })
  })

  it('清理**不碰其它 provider**的黑名单（按 provider 精确生效）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: {
        'trae-cn': { 'custom_model_gemini': true, 'glm-5.3': true },
        'buddy-cn': { 'custom_model_gemini': true },
      },
    })

    await call('model.list', { provider: 'trae-cn' })

    expect(storedValue().disabledModels).toEqual({
      'trae-cn': { 'glm-5.3': true },
      'buddy-cn': { 'custom_model_gemini': true },
    })
  })

  it('**accounts 与 schemaVersion 不被清理写坏**（settings 是整体 replace）', async () => {
    // `writeModels` 若漏带 accounts / schemaVersion，一次清尸就会把账号列表
    // 清空、或让数据版本号归零（改名迁移于是每次启动重跑）。
    const account = {
      id: 'trae-cn-acc1',
      provider: 'trae-cn',
      nickname: '测试账号',
      enabled: true,
      credentialRef: 'TRAE_CN_ACCOUNT_ACC1',
      createdAt: 1_700_000_000_000,
      refreshable: true,
    }
    const { call, storedValue } = registerEndpoints({
      models: TRAE_MODELS,
      accounts: [account],
      schemaVersion: 3,
      disabledModels: { 'trae-cn': { custom_model_gemini: true } },
    })

    await call('model.list', { provider: 'trae-cn' })

    expect(storedValue().accounts).toEqual([account])
    expect(storedValue().schemaVersion).toBe(3)
    // 垃圾键确实被清掉了（否则这条用例会在「什么都没写」的情况下虚假通过）。
    expect(storedValue().disabledModels).toEqual({})
  })

  it('**其它 provider 的回填行为完全不变**（Buddy 系黑名单语义没变）', async () => {
    // buddy 的历史行为原样保留：任何黑名单键都回填，不做垃圾判定 ——
    // `custom_model_gemini` 这种 id 在 Buddy 池里根本不存在，判定对它无意义，
    // 而误杀一个真实 id 会让用户无法重新打开模型。
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { 'buddy-cn': { 'glm-5.2': true, custom_model_gemini: true } },
    })

    const result = await call('model.list', { provider: 'buddy-cn' })
    const models = (result.value as { models: Array<{ id: string }> }).models

    // 目录里未被关闭的两项 + 两个回填项（正常键与「看起来像垃圾」的键**都**回填）。
    expect(models.map((m) => m.id).sort())
      .toEqual(['custom_model_gemini', 'deepseek-v4-flash', 'glm-5.2', 'hy3'])
    // 且没有发生任何清理写入。
    expect(storedValue().disabledModels).toEqual({
      'buddy-cn': { 'glm-5.2': true, custom_model_gemini: true },
    })
  })

  it('垃圾键全清后整个 provider 子表被移除（不留空对象噪音）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: { 'trae-cn': { custom_model_gemini: true, sagitta: true } },
    })

    await call('model.list', { provider: 'trae-cn' })

    expect(storedValue().disabledModels).toEqual({})
  })

  it('没有垃圾键时**不写盘**（避免每次刷新设置页都产生无谓写入）', async () => {
    const { call, writeCount } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: { 'trae-cn': { 'glm-5.2': true } },
    })

    await call('model.list', { provider: 'trae-cn' })

    expect(writeCount()).toBe(0)
  })

  it('清理是**一次性**的：第二次 model.list 不再写盘', async () => {
    // 清尸本身要写盘（每个垃圾键一次 `setModelDisabled`），但清完之后
    // 黑名单里已无垃圾键，后续每次刷新设置页都必须零写入 —— 否则这个
    // 「顺手清理」会变成每次开面板都写配置文件。
    const { call, writeCount } = registerEndpoints({
      models: TRAE_MODELS,
      disabledModels: { 'trae-cn': { custom_model_gemini: true, sagitta: true } },
    })

    await call('model.list', { provider: 'trae-cn' })
    const afterFirst = writeCount()
    expect(afterFirst).toBeGreaterThan(0)

    await call('model.list', { provider: 'trae-cn' })
    expect(writeCount()).toBe(afterFirst)
  })
  })

  /**
   * 上下文窗口档位（推广后覆盖全部有档位数据的 provider）。
   *
   * 四条必须一起成立的事：
   * 1. `model.list` 把目录公布的档位与**当前存储的预算**一起播报，UI 才能渲染
   *    单选列并显示选中项；
   * 2. 档位数据**按 provider 分派**（问注册表，而不是对 provider 名写特判）：
   *    注册了就带窗口字段（Trae CN 的两档、Qoder 的三档都走同一条路径），
   *    没注册就一个字都不带（CodeArts / LobsterAI 这类无档位数据的 provider）；
   * 3. `model.setContextBudget` 只接受**精确等于目录公布的某个档位**的值 ——
   *    编造值被拒，且错误信息里带着可用档位（用户唯一能据以改正的信息）；
   * 4. 未注册的 provider 直接拒绝，而不是静默写一个永不生效的值。
   */
  describe('model.list 窗口档位 / model.setContextBudget', () => {
    /** 目录档位替身：Trae CN 的两字段形态（一多档 + 一单档，id 取自共用的 MODELS）。 */
    const TIERS = new Map([
      ['glm-5.2', { contextWindow: 119_040, maxContextWindow: 1_048_576 }],
      ['deepseek-v4-flash', { contextWindow: 119_040 }],
    ])
    const tierSource = { contextTiers: async () => TIERS }
    /**
     * Qoder 形态：挂 `contextTiers` 数组（**默认档是最小档**，真机
     * `[200000, 400000, 1000000]` 三档）。三档是为了证明 UI / 校验都不假设
     * 「只有默认 / Max 两档」—— 两档形态下「多档」与「两档」的实现无法区分。
     */
    const QODER_TIERS = new Map([
      ['qmodel_38max', { contextWindow: 200_000, contextTiers: [200_000, 400_000, 1_000_000] }],
      // 单档项：目录有窗口但只有一档（UI 据此不渲染档位列）。
      ['qauto', { contextWindow: 200_000, contextTiers: [200_000] }],
    ])
    /** 按 provider 分键的注册表：Trae CN + Qoder 有来源，其余键缺席。 */
    const TIER_REGISTRY = {
      'trae-cn': tierSource,
      'qoder': { contextTiers: async () => QODER_TIERS },
    }
    /** Buddy 形态：生效档已是**最大**档（`min(maxInputTokens, 档位表最大档)`）。 */
    const BUDDY_TIERS = new Map([
      ['glm-5.2', { contextWindow: 1_048_576, contextTiers: [300_000, 1_048_576] }],
    ])

    it('model.list 播报 dev / Max / 当前预算（有则带，无则缺省）', async () => {
      const { call } = registerEndpoints({
        models: MODELS,
        contextTiers: TIER_REGISTRY,
        contextBudgets: { 'trae-cn': { 'glm-5.2': 1_048_576 } },
      })

      const result = await call('model.list', { provider: 'trae-cn' })
      expect(result.ok).toBe(true)
      const byId = new Map((result.value as { models: Array<Record<string, unknown>> }).models.map(m => [m.id, m]))
      // 选过 Max 档的模型：三个字段齐全。
      expect(byId.get('glm-5.2')).toMatchObject({
        contextWindow: 119_040, maxContextWindow: 1_048_576, contextBudget: 1_048_576,
      })
      // 目录里没声明窗口的模型（`hy3` 不在 TIERS 里）：一个字都不带 ——
      // UI 据此不渲染档位列。
      expect(byId.get('hy3')).not.toHaveProperty('contextWindow')
      expect(byId.get('hy3')).not.toHaveProperty('contextBudget')
    })

    it('单档模型只带 dev，且**没有预算时 contextBudget 缺省**（而非 0）', async () => {
      const { call } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      const result = await call('model.list', { provider: 'trae-cn' })
      const byId = new Map((result.value as { models: Array<Record<string, unknown>> }).models.map(m => [m.id, m]))
      expect(byId.get('deepseek-v4-flash')).toMatchObject({ contextWindow: 119_040 })
      expect(byId.get('deepseek-v4-flash')).not.toHaveProperty('maxContextWindow')
      expect(byId.get('deepseek-v4-flash')).not.toHaveProperty('contextBudget')
    })

    /**
     * 用户报障（2026-09-21）：「为什么只有开启后才能可选上下文？」
     *
     * 根因是**同一份档位数据被两条渲染路径区别对待**：`model.list` 早前只在
     * `models.map(...)`（= 未被黑名单过滤的那批）上加窗口字段，而**被关闭的模型
     * 由回填侧补回**（见上面的并集逻辑），走的是另一条 `filteredOut.map(...)`
     * 分支 —— 那条分支只产出 `{id, name: id, disabled: true}`，档位列于是整行消失。
     *
     * 档位数据来自适配器目录（`contextTiers`），**与用户的显示开关毫无关系**：
     * 关掉一个模型只是让它从对话框选择器里消失，它在目录里的 dev / Max 档一字未变。
     * 下面两条一起钉死这件事。
     */
    it('**被关闭的模型（回填行）照样带窗口档位**，与开启状态逐字段一致', async () => {
      // 先拿「开启」状态下的那一行做基准。
      const enabled = await (async () => {
        const { call } = registerEndpoints({
          models: MODELS, contextTiers: TIER_REGISTRY,
          contextBudgets: { 'trae-cn': { 'glm-5.2': 1_048_576 } },
        })
        const result = await call('model.list', { provider: 'trae-cn' })
        return (result.value as { models: Array<Record<string, unknown>> }).models
          .find(m => m.id === 'glm-5.2')!
      })()

      // 再拿同一个模型被关闭后的那一行：它已被适配器过滤掉，由**回填侧**产出。
      const { call } = registerEndpoints({
        models: MODELS, contextTiers: TIER_REGISTRY,
        contextBudgets: { 'trae-cn': { 'glm-5.2': 1_048_576 } },
        disabledModels: { 'trae-cn': { 'glm-5.2': true } },
      })
      const result = await call('model.list', { provider: 'trae-cn' })
      const models = (result.value as { models: Array<Record<string, unknown>> }).models
      const disabled = models.find(m => m.id === 'glm-5.2')!

      // 三个档位字段一个不少（这正是用户要能在关闭状态下改档的前提）。
      expect(disabled).toMatchObject({
        contextWindow: 119_040, maxContextWindow: 1_048_576, contextBudget: 1_048_576,
      })
      // 与开启状态**逐字段相同**，只有开关状态与展示名不同（回填拿不到原始 name）。
      expect({ ...disabled, disabled: false, name: enabled.name }).toEqual(enabled)
      expect(disabled.name).toBe('glm-5.2')
      expect(disabled.disabled).toBe(true)
    })

    it('关闭状态下**设置档位照常生效**（校验读的是目录，与显示开关无关）', async () => {
      // UI 现在会在回填行上渲染档位 radio，那条路径必须真的能写进去 ——
      // 否则就成了「点了没反应」，比不渲染更糟。
      const { call, storedValue } = registerEndpoints({
        models: MODELS, contextTiers: TIER_REGISTRY,
        disabledModels: { 'trae-cn': { 'glm-5.2': true } },
      })

      const set = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 1_048_576 })
      expect(set.ok).toBe(true)
      expect(storedValue().contextBudgets).toEqual({ 'trae-cn': { 'glm-5.2': 1_048_576 } })

      // 且回填行立刻反映出新预算（选中态据此渲染）。
      const result = await call('model.list', { provider: 'trae-cn' })
      const glm = (result.value as { models: Array<Record<string, unknown>> }).models.find(m => m.id === 'glm-5.2')!
      expect(glm.contextBudget).toBe(1_048_576)
    })

    /**
     * 推广后的**分派语义**：窗口字段的有无由**注册表**决定，不由 provider 名决定。
     *
     * 这一对用例是「推广」这件事的核心防线 —— 早前 `model.list` 写死
     * `req.provider === TRAE_CN.id`，于是 buddy / qoder 的目录数据即使存在也带不出来。
     */
    it('未注册的 provider **一个窗口字段都不带**（codearts / lobsterai 刻意不注册）', async () => {
      const { call } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      for (const provider of ['codearts', 'lobsterai']) {
        const result = await call('model.list', { provider })
        for (const model of (result.value as { models: Array<Record<string, unknown>> }).models) {
          expect(model, provider).not.toHaveProperty('contextWindow')
          expect(model, provider).not.toHaveProperty('maxContextWindow')
          expect(model, provider).not.toHaveProperty('contextTiers')
          expect(model, provider).not.toHaveProperty('contextBudget')
        }
      }
    })

    it('注册了的 provider 各自按**自己的目录**带档位（buddy 的最大档形态 / qoder 的三档形态）', async () => {
      // Buddy 形态：生效档已是**最大**档（`supportedLengths` 的其余项是降档选项）。
      const buddy = await (async () => {
        const { call } = registerEndpoints({
          models: MODELS,
          contextTiers: { 'buddy-cn': { contextTiers: async () => BUDDY_TIERS } },
          contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000 } },
        })
        const result = await call('model.list', { provider: 'buddy-cn' })
        return (result.value as { models: Array<Record<string, unknown>> }).models.find(m => m.id === 'glm-5.2')!
      })()
      expect(buddy).toMatchObject({
        contextWindow: 1_048_576,
        contextTiers: [300_000, 1_048_576],
        contextBudget: 300_000,
      })
      // Buddy 没有 `maxContextWindow` 这个概念（那是 Trae CN 的两字段形态），
      // 整张表由 `contextTiers` 承载 —— 不为了「统一」而编造一个 max 字段。
      expect(buddy).not.toHaveProperty('maxContextWindow')

      // Qoder 形态：默认档是**最小**档，三档可选。
      const { call } = registerEndpoints({
        models: [{ id: 'qmodel_38max', name: 'Qwen3.8-Max' }],
        contextTiers: TIER_REGISTRY,
        contextBudgets: { 'qoder': { qmodel_38max: 1_000_000 } },
      })
      const result = await call('model.list', { provider: 'qoder' })
      const qwen = (result.value as { models: Array<Record<string, unknown>> }).models[0]!
      expect(qwen).toMatchObject({
        contextWindow: 200_000,
        contextTiers: [200_000, 400_000, 1_000_000],
        contextBudget: 1_000_000,
      })
    })

    it('**单档模型不带 `contextTiers`**（一档等于没有可选项，宁缺毋编）', async () => {
      const { call } = registerEndpoints({
        models: [{ id: 'qauto', name: 'Auto' }],
        contextTiers: TIER_REGISTRY,
      })
      const result = await call('model.list', { provider: 'qoder' })
      const auto = (result.value as { models: Array<Record<string, unknown>> }).models[0]!
      expect(auto).toMatchObject({ contextWindow: 200_000 })
      expect(auto).not.toHaveProperty('contextTiers')
    })

    it('未接线（没有档位来源）时 model.list 不带窗口字段，也不报错', async () => {
      const { call } = registerEndpoints({ models: MODELS })
      const result = await call('model.list', { provider: 'trae-cn' })
      expect(result.ok).toBe(true)
      for (const model of (result.value as { models: Array<Record<string, unknown>> }).models) {
        expect(model).not.toHaveProperty('contextWindow')
      }
    })

    it('设置 Max 档：写入预算，且后续 model.list 立刻反映', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })

      const set = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 1_048_576 })
      expect(set.ok).toBe(true)
      expect((set.value as Record<string, unknown>).contextBudget).toBe(1_048_576)
      expect(storedValue().contextBudgets).toEqual({ 'trae-cn': { 'glm-5.2': 1_048_576 } })

      const result = await call('model.list', { provider: 'trae-cn' })
      const glm = (result.value as { models: Array<Record<string, unknown>> }).models.find(m => m.id === 'glm-5.2')!
      expect(glm.contextBudget).toBe(1_048_576)
    })

    it('**编造值被拒**，且错误信息里带着该模型实际可用的档位', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })

      for (const window of [999_999_999, 119_041, 0, -1]) {
        const result = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window })
        expect(result.ok, String(window)).toBe(false)
        const message = (result.error as { message: string }).message
        // 两个可用档位值都要出现在提示里（用户据此改正）。
        expect(message, String(window)).toContain('119040')
        expect(message, String(window)).toContain('1048576')
      }
      // 一次都没写进去。
      expect(storedValue().contextBudgets ?? {}).toEqual({})
    })

    it('**单档模型**只接受 dev（= 恢复默认），任何 Max 值都被拒', async () => {
      const { call } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      const rejected = await call('model.setContextBudget', {
        provider: 'trae-cn', model: 'deepseek-v4-flash', window: 1_048_576,
      })
      expect(rejected.ok).toBe(false)
      const message = (rejected.error as { message: string }).message
      // 可用档位只有那一个，且**不编造 Max**（提示里的 1048576 是用户提交的原值，
      // 出现在「不支持 1048576」那一段，不是被列出的档位）。
      expect(message).toContain('可用档位为 119040（默认）')
      expect(message).not.toContain('（Max）')
    })

    it('省略 window 或恰好等于 dev = **恢复默认档**（清除预算，而不是写入 dev）', async () => {
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        contextTiers: TIER_REGISTRY,
        contextBudgets: { 'trae-cn': { 'glm-5.2': 1_048_576 } },
      })

      const restored = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2' })
      expect(restored.ok).toBe(true)
      expect((restored.value as Record<string, unknown>).contextBudget).toBeUndefined()
      expect(storedValue().contextBudgets).toEqual({})

      // 再按 Max 设一次，然后用 dev 值恢复（两条恢复路径都要成立）。
      await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 1_048_576 })
      expect(storedValue().contextBudgets).toEqual({ 'trae-cn': { 'glm-5.2': 1_048_576 } })
      await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 119_040 })
      expect(storedValue().contextBudgets).toEqual({})
    })

    it('目录里没有该模型 / 模型未声明窗口 → 拒绝（不写任何东西）', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      const unknown = await call('model.setContextBudget', { provider: 'trae-cn', model: 'brand-new', window: 1_048_576 })
      expect(unknown.ok).toBe(false)
      expect((unknown.error as { message: string }).message).toContain('未声明上下文窗口')
      expect(storedValue().contextBudgets ?? {}).toEqual({})
    })

    it('**非注册 provider 一律拒绝**（codearts / lobsterai 刻意不在注册表里）', async () => {
      const { call } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      for (const provider of ['codearts', 'lobsterai']) {
        const result = await call('model.setContextBudget', { provider, model: 'glm-5.2', window: 1_048_576 })
        expect(result.ok, provider).toBe(false)
        expect((result.error as { message: string }).message, provider).toContain('不支持上下文窗口档位')
      }
    })

    /**
     * 多档校验（推广的核心行为）：**接受档位表里的任意一项**，
     * 不再只认「dev 或 max」两个值。
     *
     * Qoder 真机目录给 `[200000, 400000, 1000000]`，中间那档 400000 在旧实现里
     * 既不是默认档也不是 Max 档 —— 旧实现只比对 `tier.maxContextWindow`，
     * 而 Qoder 的档位用 `contextTiers` 数组承载，`maxContextWindow` 根本不存在
     * ⇒ 三档模型的每一个非默认档都会被拒（UI 上点了没反应）。
     * 这条用例把「任意档都收」钉死。
     */
    it('**多档模型**：列表里的每一档都能设，编造值被拒且提示列出**全部**档位', async () => {
      const { call, storedValue } = registerEndpoints({
        models: [{ id: 'qmodel_38max', name: 'Qwen3.8-Max' }],
        contextTiers: TIER_REGISTRY,
      })

      // 三档逐个设进去（含中间档 —— 旧实现唯一接不住的那个）。
      for (const window of [400_000, 1_000_000, 200_000]) {
        const set = await call('model.setContextBudget', { provider: 'qoder', model: 'qmodel_38max', window })
        expect(set.ok, String(window)).toBe(true)
        // 设成默认档 = **清除预算**（而不是写入默认档值）。
        const expected = window === 200_000 ? {} : { qoder: { qmodel_38max: window } }
        expect(storedValue().contextBudgets, String(window)).toEqual(expected)
      }

      // 编造值：错误信息里要列出**三个**档位（用户据此改正），默认档要有标注。
      const rejected = await call('model.setContextBudget', {
        provider: 'qoder', model: 'qmodel_38max', window: 500_000,
      })
      expect(rejected.ok).toBe(false)
      const message = (rejected.error as { message: string }).message
      expect(message).toContain('可用档位为 200000（默认） / 400000 / 1000000')
      // 拒绝时一个字节都没写。
      expect(storedValue().contextBudgets).toEqual({})
    })

    it('**档位数据按 provider 隔离**：同一个模型 id 在两个 provider 上各按各的档位校验', async () => {
      // 各 provider 的档位在存储上也是分开的；
      // 这里用 trae-cn 与 qoder 造同样的「同名模型、不同档位」场景，确认校验读的是
      // **该 provider 自己的目录**，而不是某个全局表。
      const { call, storedValue } = registerEndpoints({
        models: MODELS,
        contextTiers: {
          'trae-cn': tierSource,
          'qoder': { contextTiers: async () => new Map([['glm-5.2', { contextWindow: 200_000, contextTiers: [200_000, 400_000] }]]) },
        },
      })

      // trae-cn 的 glm-5.2 没有 400000 这一档 → 拒绝。
      const wrong = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 400_000 })
      expect(wrong.ok).toBe(false)
      // qoder 的同名模型有 → 接受，且写进 **qoder** 的键下。
      const right = await call('model.setContextBudget', { provider: 'qoder', model: 'glm-5.2', window: 400_000 })
      expect(right.ok).toBe(true)
      expect(storedValue().contextBudgets).toEqual({ qoder: { 'glm-5.2': 400_000 } })
    })

    it('未接线时同样拒绝（没有目录就无法校验，宁可拒绝也不盲写）', async () => {
      const { call, storedValue } = registerEndpoints({ models: MODELS })
      const result = await call('model.setContextBudget', { provider: 'trae-cn', model: 'glm-5.2', window: 1_048_576 })
      expect(result.ok).toBe(false)
      expect(storedValue().contextBudgets ?? {}).toEqual({})
    })

    it('参数缺失时拒绝（provider / model 必填）', async () => {
      const { call } = registerEndpoints({ models: MODELS, contextTiers: TIER_REGISTRY })
      for (const payload of [{}, { provider: 'trae-cn' }, { provider: 'trae-cn', model: '' }, { model: 'glm-5.2' }]) {
        const result = await call('model.setContextBudget', payload)
        expect(result.ok, JSON.stringify(payload)).toBe(false)
        expect((result.error as { message: string }).message).toContain('必填')
      }
    })
  })
})

/**
 * 三个积分端点的 provider 能力边界（后端侧契约）。
 *
 * CodeArts **已接入真实实现**（华为云 SDK-HMAC-SHA256 签名，见
 * `src/codearts-credits.ts`），故它**必须被接受**，不再回 bad-request。
 *
 * 历史背景（本用例的由来）：CodeArts 曾**不是** BuddyProduct，
 * `productById('codearts')` 返回 undefined，于是三个端点必然回
 * `bad-request: unsupported provider: codearts`。当时客户端在面板挂载时对
 * **所有** provider 无条件调用 `credits.balances`，把这条必然的拒绝当成运行时
 * 故障打进了控制台，并把账号卡片的「积分」渲染成「查询失败」（修法见
 * `plugin-src/client/credits-capabilities.js` 与 `tests/unit/credits-capabilities.spec.ts`）。
 *
 * 此用例锁三件事：
 * 1. 未知 provider 仍回可读的 bad-request（契约不变，只是不再拿 CodeArts 当例子）；
 * 2. CodeArts 被**接受**并返回结构化结果（新能力的回归保护）；
 * 3. 拒绝是**按 provider 精确生效**的，没有连 Buddy 系一起误拒。
 */
describe('积分端点的 provider 能力边界', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 注册端点，返回一个「调用端点方法并解包 result」的函数。 */
  function registerCreditsEndpoints() {
    let handler: Handler | undefined
    const ctx: Record<string, unknown> = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      // 生产代码用惰性注入挂载 connection 端点（见 registerAccountHubRpc 的说明）：
      // 替身必须提供 inject，否则会以 `ctx.inject is not a function` 抛错。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
    }
    // pool 替身：一旦 provider 校验被绕过，listAccounts 会返回空数组，
    // 端点便以 `ok: true` + 空列表「假成功」——下面的断言会立刻揭穿它，
    // 而不会因为抛 TypeError 变成误导性的 handler-failed。
    const pool = { listAccounts: async () => [] }

    registerAccountHubRpc(
      ctx as never, pool as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    return async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/account-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'account-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
  }

  const CREDITS_METHODS = ['credits.status', 'credits.claimAll', 'credits.balances']

  it.each(CREDITS_METHODS)('%s 对未知 provider 返回 unsupported provider（可读的 bad-request）', async (method) => {
    // ⚠️ 历史上这条用例断言的是 **codearts** 被拒 —— 当时 CodeArts 确实没有
    // 实现。现在它已接入（`src/codearts-credits.ts`），故改用真正未登记的
    // provider 名来守住「未知 provider 必须被可读地拒绝」这条契约。
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'not-a-provider' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: not-a-provider')
  })

  it.each(CREDITS_METHODS)('%s 不会把 Buddy 系一并误拒', async (method) => {
    const call = registerCreditsEndpoints()
    // 两个 Buddy 系产品都能通过 provider 校验，走到 listAccounts（替身返回空）。
    for (const provider of ['buddy-cn', 'buddy']) {
      const result = await call(method, { provider })
      expect(result.ok, `${method}/${provider}`).toBe(true)
    }
  })

  /**
   * CodeArts 现在**必须**被接受（不再回 bad-request）。
   *
   * 这是本次接入的核心契约：三个积分端点都要为 `codearts` 分支。
   * 替身 pool 返回空列表，故结果结构可断言、不会发任何网络请求。
   */
  it.each(CREDITS_METHODS)('%s 接受 codearts（已接入华为云签名协议）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'codearts' })
    expect(result.ok, `${method} 不该拒绝 codearts`).toBe(true)
  })

  it('credits.balances 对 codearts 返回 accounts 数组', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.balances', { provider: 'codearts' })
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.status 对 codearts 返回 accounts 数组（状态如实为 null）', async () => {
    // CodeArts 没有独立的签到状态端点：可领状态要经「账户类型 + 活动列表」
    // 两步才能得到，语义与 CheckinStatus 不同构 —— 故如实回 null，
    // 由 claimAll 内部自行预检（precheckStatus: false）。
    const call = registerCreditsEndpoints()
    const result = await call('credits.status', { provider: 'codearts' })
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.claimAll 对 codearts 返回 summary 结构', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.claimAll', { provider: 'codearts' })
    expect((result.value as { summary: unknown }).summary).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0,
      unavailable: 0, abnormal: 0, undetermined: 0, failed: 0,
    })
  })
})

/**
 * `account.reorder` 端点（Account Hub 拖拽排序的后端部分，移植上游 84d0b3f）。
 *
 * 用**真实 AccountPool** + 内存 settings 替身，而不是给 pool 打桩：
 * 这个端点的价值全在「参数校验 + 转交 pool.reorderAccounts」，用桩替换 pool
 * 就只剩「调用了某方法」这种无信息量的断言，无法发现「集合校验被绕过」
 * 「顺序没持久化」这类真实问题。
 *
 * 客户端入口在 `plugin-src/client/account-hub.js`（`ProviderPanel.commitOrder`）：
 * 拖拽落点由 `plugin-src/client/account-order.js` 算出后发这个 RPC，失败即回滚
 * —— 本文件守宿主这一端的参数校验与转交，客户端那一端由
 * `tests/unit/account-order.spec.ts` 与 `tests/unit/account-order-panel.spec.ts` 守。
 */
describe('account.reorder 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 建一个真实 pool（内存 settings）+ 端点调用器。 */
  function setup(initial: Array<{ id: string; provider: string }>) {
    let stored: { accounts: unknown[]; disabledModels: Record<string, unknown> } = {
      accounts: initial.map(a => ({
        ...a,
        nickname: a.id,
        enabled: true,
        credentialRef: `${a.provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_${a.id.toUpperCase()}`,
        createdAt: 1,
        refreshable: true,
      })),
      disabledModels: {},
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: typeof stored) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }
    registerAccountHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never)

    const call = async (method: string, payload: unknown) => {
      if (handler === undefined) throw new Error('endpoint handler was not registered')
      const response = await handler(new Request('http://localhost/api/account-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'account-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { code?: string; message: string } } }
      return body.result
    }
    return { call, orderInStore: () => (stored.accounts as Array<{ id: string }>).map(a => a.id) }
  }

  it('重排成功并把新顺序写入存储', async () => {
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy-cn' },
      { id: 'b', provider: 'buddy-cn' },
      { id: 'c', provider: 'buddy-cn' },
    ])
    const result = await call('account.reorder', { provider: 'buddy-cn', orderedIds: ['c', 'a', 'b'] })
    expect(result.ok).toBe(true)
    expect(orderInStore()).toEqual(['c', 'a', 'b'])
  })

  it('集合不一致（列表过期）回可读的 bad-request，而不是 handler-failed', async () => {
    // 这类并发是可预期的：用户拖拽期间在别处新增/删除了账号。
    // 回 bad-request + 可读文案，前端能提示「刷新后重试」；
    // 若抛异常会退化成 account-hub/handler-failed，用户只看到「未知故障」。
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy-cn' },
      { id: 'b', provider: 'buddy-cn' },
    ])
    const result = await call('account.reorder', { provider: 'buddy-cn', orderedIds: ['a'] })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('bad-request')
    expect(result.error?.message).toContain('账号列表已变化')
    // 数据未被破坏
    expect(orderInStore()).toEqual(['a', 'b'])
  })

  it('缺 provider 或 orderedIds 非字符串数组 → bad-request', async () => {
    const { call } = setup([{ id: 'a', provider: 'buddy-cn' }])
    expect((await call('account.reorder', { orderedIds: ['a'] })).ok).toBe(false)
    expect((await call('account.reorder', { provider: '', orderedIds: ['a'] })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy-cn' })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy-cn', orderedIds: [1, 2] })).ok).toBe(false)
  })

  it('重排不影响其他 provider 账号的位置', async () => {
    const { call, orderInStore } = setup([
      { id: 'b1', provider: 'buddy-cn' },
      { id: 'c1', provider: 'codearts' },
      { id: 'b2', provider: 'buddy-cn' },
    ])
    const result = await call('account.reorder', { provider: 'buddy-cn', orderedIds: ['b2', 'b1'] })
    expect(result.ok).toBe(true)
    // buddy-cn 的两个账号在各自原下标上互换，codearts 仍在中间
    expect(orderInStore()).toEqual(['b2', 'c1', 'b1'])
  })
})
