/**
 * 「消耗顺序 + 切换粒度」在**账号池**这一层的接线测试。
 *
 * 纯逻辑（取值域 / 轮转 / 排序 / 缓存 / 锁）由 `account-consumption.spec.ts` 单独守着；
 * 本文件只验**池怎么用它**，以及四件最容易静默出错的接线：
 *
 * 1. **默认值**：没配过任何东西时读回「遍历 + 按轮次」（宿主 `DEFAULT_CONSUMPTION`）。
 *    ⚠️ 与「不传新的可选参数」是**两件事**：不传 `pick` 的调用点（`buddy-auth` /
 *    `lobsterai-auth` 拉目录、适配器换号重试）在任何档位下都必须拿到第一个可用
 *    账号 —— 那条由「不传 pick 时整段重排都不执行」保证，与默认档位无关。
 * 2. **持久化九件套互带**：新增字段（含后来加的 `providerAuditVersion` 体检闸门与
 *    `autoRoute` 自动路由配置）与既有字段同属一份文档，任何一次整体 replace 漏带即被清空。
 * 3. **遍历游标持久化 + 自愈**：跨请求记忆下一个轮到谁；账号被删除 / 停用后
 *    回落数组顺序，绝不抛错。
 * 4. **轮次锁**：按调用方给的轮次键（宿主侧由 `options.signal` 身份换算）锁定账号，
 *    `per-request` 档不锁。
 */

import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import { BALANCE_CACHE_TTL_MS } from '../../src/account-consumption.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 落盘载荷必须**恰好**是这九个键。
 *
 * ⚠️ 断言的是「键集合完全相等」而不是「包含」：整体 replace 的语义下，
 * **漏带一个键就等于清空它**，只断言包含会让漏带悄悄通过。
 */
const ACCOUNT_KEYS = [
  'accounts', 'autoRoute', 'consumption', 'consumptionCursors', 'contextBudgets',
  'disabledModels', 'checkins', 'schemaVersion', 'providerAuditVersion',
].sort()

interface HarnessOptions {
  accounts?: ProviderAccountEntry[]
  consumption?: Record<string, unknown>
  consumptionCursors?: Record<string, unknown>
  withStorage?: boolean
  withSettings?: boolean
}

/**
 * 双通路替身：storage 域（主路径）与 settings scope（回退路径）各一份，
 * 语义都与真实实现一致 —— 整体 replace、读同步取自权威内存态。
 */
function makeHarness(options: HarnessOptions = {}) {
  const storageWrites: Array<Record<string, unknown>> = []
  let storageGlobal: Record<string, unknown> | null = null
  const settingsWrites: Array<Record<string, unknown>> = []
  let settingsValue: Record<string, unknown> = {
    accounts: options.accounts ?? [],
    consumption: options.consumption ?? {},
    consumptionCursors: options.consumptionCursors ?? {},
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    schemaVersion: 0,
  }

  const storage = {
    read: () => {
      if (storageGlobal === null) return undefined
      const value = storageGlobal
      return {
        accounts: (value.accounts ?? []) as ProviderAccountEntry[],
        consumption: (value.consumption ?? {}) as Record<string, never>,
        consumptionCursors: (value.consumptionCursors ?? {}) as Record<string, string>,
        disabledModels: (value.disabledModels ?? {}) as Record<string, Record<string, boolean>>,
        contextBudgets: (value.contextBudgets ?? {}) as Record<string, Record<string, number>>,
        checkins: (value.checkins ?? {}) as Record<string, number>,
        schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 0,
      }
    },
    write: async (doc: Record<string, unknown>) => {
      storageWrites.push(JSON.parse(JSON.stringify(doc)) as Record<string, unknown>)
      storageGlobal = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
    },
  }
  if (options.accounts !== undefined) {
    storageGlobal = {
      accounts: options.accounts,
      consumption: options.consumption ?? {},
      consumptionCursors: options.consumptionCursors ?? {},
      disabledModels: {},
      contextBudgets: {},
      checkins: {},
      schemaVersion: 0,
    }
  }

  const credentials = new Map<string, string>()
  /**
   * 被**显式**清掉的凭据 ref。
   *
   * 默认行为是「任何 ref 都能解析出一份合法凭据」—— 本文件验的是**选号顺序**，
   * 让每个被测账号都先手写一份凭据只会把噪音混进断言。而「凭据不可解析」这条
   * 既有过滤必须仍可被触发，故用一张显式黑名单表达它（`credentials.unset` 即登记）。
   */
  const unresolved = new Set<string>()
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: (key: string) => {
      if (key === 'storageDomain' && options.withStorage !== false) {
        return { open: async () => ({ global: { get: () => storage.read(), set: storage.write }, close: async () => {} }) }
      }
      if (key === 'settings' && options.withSettings !== false) {
        return {
          register: () => ({
            get: () => settingsValue,
            replace: async (value: Record<string, unknown>) => {
              settingsWrites.push(value)
              settingsValue = value
            },
          }),
        }
      }
      return undefined
    },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        const key = String(ref)
        if (unresolved.has(key)) return undefined
        const stored = credentials.get(key)
        if (stored !== undefined) return { value: stored, source: 'test' as const }
        // 未登记的 ref 自动给一份最小合法凭据（见 `unresolved` 的说明）。
        return { value: JSON.stringify({ access_token: `tok-${key}` }), source: 'test' as const }
      },
      set: async (ref: ReturnType<typeof credentialRef>, value: string) => {
        credentials.set(String(ref), value)
        unresolved.delete(String(ref))
      },
      unset: async (ref: ReturnType<typeof credentialRef>) => {
        credentials.delete(String(ref))
        unresolved.add(String(ref))
      },
    },
  }

  return { ctx, storageWrites, settingsWrites, credentials, storageCurrent: () => storageGlobal }
}

function account(id: string, provider = 'buddy-cn'): ProviderAccountEntry {
  return {
    id,
    provider,
    nickname: id,
    enabled: true,
    credentialRef: `${provider.replace(/-/g, '_').toUpperCase()}_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 1_789_000_000_000,
    refreshable: true,
  }
}

/** 建池 + 给每个账号写一份可解析凭据。 */
async function makePool(
  h: ReturnType<typeof makeHarness>,
  entries: ProviderAccountEntry[],
): Promise<AccountPool> {
  const pool = new AccountPool(h.ctx as never)
  for (const entry of entries) {
    await h.credentials.set(credentialRef(entry.credentialRef), JSON.stringify({ access_token: `tok-${entry.id}` }))
  }
  await pool.openStorage()
  return pool
}

async function seed(pool: AccountPool, entries: ProviderAccountEntry[]): Promise<void> {
  for (const entry of entries) await pool.addAccount(entry)
}

/**
 * 「这是一次请求，但不属于任何一轮对话」的 `pick`。
 *
 * ⚠️ 它与**完全不传 `pick`** 是两种语义，不要混用：
 * - 不传 = 历史行为（永远取第一个可用账号），既有调用点（拉目录、换号重试）走这条；
 * - 传了空对象 = 按配置的档位选号，但不锁轮次（`per-turn` 的锁需要 turnKey）。
 *
 * 因此「验证三档顺序语义」的用例必须传它 —— 用「不传」去验轮转只会恒拿到第一个账号，
 * 是一条**因为错误的原因而变绿**的假测试。
 */
const PER_REQUEST: { turnKey?: string } = {}

/** 一轮对话的 `pick`（`per-turn` 档据此锁号）。 */
const turn = (key: string): { turnKey?: string } => ({ turnKey: key })

describe('默认值与既有调用点（红线：不传新参数时行为逐字不变）', () => {
  it('未配置任何东西时读回「遍历 + 按轮次」（用户拍板的默认）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    expect(pool.consumptionSetting('buddy-cn')).toEqual({ order: 'round-robin', switch: 'per-turn' })
    // 未知 provider 同样回默认值，不抛错。
    expect(pool.consumptionSetting('nobody')).toEqual({ order: 'round-robin', switch: 'per-turn' })
    expect(pool.allConsumption()).toEqual({})
  })

  it('不传 pick：恒取数组第一个可用账号（与档位无关，遍历档也不轮转）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('b1'), account('b2'), account('b3')])
    // 默认档现在是遍历，但**不传 pick 的调用点一条都不受影响**（红线）。
    for (let i = 0; i < 3; i++) {
      const picked = await pool.getAvailableAccount('buddy-cn', '')
      expect(picked?.entry.id).toBe('b1')
    }
    // 空 modelId 的既有语义（不过滤限流）也没变。
    expect((await pool.getAvailableAccount('buddy-cn', 'glm-5.2'))?.entry.id).toBe('b1')
  })

  it('账号被停用 / 凭据不可解析时的既有过滤不变', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('b1'), account('b2')])
    await pool.updateAccount('b1', { enabled: false })
    expect((await pool.getAvailableAccount('buddy-cn', ''))?.entry.id).toBe('b2')
    await h.ctx.credentials.unset(credentialRef('BUDDY_CN_ACCOUNT_B2'))
    expect(await pool.getAvailableAccount('buddy-cn', '')).toBeNull()
  })
})

describe('遍历档：每次请求轮转下一个，游标持久化且自愈', () => {
  it('连续四次请求按 a→b→c→a 轮转', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    const seen: string[] = []
    for (let i = 0; i < 4; i++) seen.push((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id)
    expect(seen).toEqual(['a', 'b', 'c', 'a'])
  })

  it('游标落盘：重建池后从下一个继续（跨进程记忆）', async () => {
    const accounts = [account('a'), account('b'), account('c')]
    const h = makeHarness({ accounts })
    const first = await makePool(h, accounts)
    await first.writeConsumption('buddy-cn', { order: 'round-robin' })
    expect((await first.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
    const stored = h.storageCurrent()!
    expect(stored.consumptionCursors).toEqual({ 'buddy-cn': 'b' })

    // 同一份存储重建一个池：下一个应当是 b。
    const second = new AccountPool(h.ctx as never)
    await second.openStorage()
    expect((await second.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('b')
  })

  it('切回顺序档后不再轮转（游标留在存储里但不参与选号）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
    await pool.writeConsumption('buddy-cn', { order: 'sequential' })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
  })

  it('游标指向已删除账号 → 自愈回落数组第一个，不抛错', async () => {
    const h = makeHarness({ accounts: [account('a'), account('b'), account('c')], consumptionCursors: { 'buddy-cn': 'gone' } })
    const pool = await makePool(h, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
    expect((h.storageCurrent()!.consumptionCursors as Record<string, string>)['buddy-cn']).toBe('b')
  })

  it('游标指向已停用账号 → 同样自愈（停用账号不在候选里）', async () => {
    const accounts = [account('a'), account('b')]
    const h = makeHarness({ accounts, consumptionCursors: { 'buddy-cn': 'b' } })
    const pool = await makePool(h, accounts)
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    await pool.updateAccount('b', { enabled: false })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
  })

  it('单账号 provider 不重复写盘（游标没变时跳过持久化）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('only')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    // 第一次请求把游标从「未设置」写成 only（这是一次真实变化，必须落盘）。
    await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST)
    const before = h.storageWrites.length
    // 后续请求的游标恒为 only（没变）→ 一次都不该再写盘。
    await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST)
    await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST)
    expect(h.storageWrites.length).toBe(before)
  })

  it('轮转与 excludeAccountIds 叠加时不会卡在同一个账号上（换号重试路径）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    const tried = new Set<string>()
    const first = await pool.getAvailableAccount('buddy-cn', '', tried)
    tried.add(first!.entry.id)
    const second = await pool.getAvailableAccount('buddy-cn', '', tried)
    expect([first!.entry.id, second!.entry.id]).toEqual(['a', 'b'])
  })
})

describe('最高优先档：余额降序，余额未知即降级回顺序', () => {
  it('已知余额时取最高者', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'highest-balance' })
    pool.recordBalances('buddy-cn', [
      { accountId: 'a', total: 10 },
      { accountId: 'b', total: 900 },
      { accountId: 'c', total: 50 },
    ])
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('b')
  })

  it('余额一个都没有（未刷新 / 全部过期）→ 降级回顺序档，不抛错', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'highest-balance' })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
    pool.recordBalances('buddy-cn', [{ accountId: 'b', total: 5 }])
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('b')
    // 超过 TTL 后回到降级（未知 ≠ 0，不得把过期值当权威）。
    expect(pool.balanceSnapshot('buddy-cn', Date.now() + BALANCE_CACHE_TTL_MS + 1).size).toBe(0)
  })

  it('余额只覆盖部分账号时：有余额的优先，未知的按原顺序排在后面', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'highest-balance' })
    pool.recordBalances('buddy-cn', [{ accountId: 'c', total: 1 }])
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('c')
    await pool.updateAccount('c', { enabled: false })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST))!.entry.id).toBe('a')
  })

  it('余额按 provider 分桶，不串到别的 provider', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('q1', 'qoder')])
    await pool.writeConsumption('qoder', { order: 'highest-balance' })
    pool.recordBalances('buddy-cn', [{ accountId: 'q1', total: 999 }])
    expect((await pool.getAvailableAccount('qoder', '', undefined, PER_REQUEST))!.entry.id).toBe('q1')
    expect(pool.balanceSnapshot('qoder').size).toBe(0)
  })
})

describe('切换粒度：per-turn 锁住同轮账号，per-request 每次重选', () => {
  it('per-turn（默认）：同一轮次键内恒为同一账号，换轮次才重选', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    const turn1 = { turnKey: 'turn-1' }
    const first = await pool.getAvailableAccount('buddy-cn', '', undefined, turn1)
    const second = await pool.getAvailableAccount('buddy-cn', '', undefined, turn1)
    expect([first!.entry.id, second!.entry.id]).toEqual(['a', 'a'])
    const turn2 = await pool.getAvailableAccount('buddy-cn', '', undefined, { turnKey: 'turn-2' })
    expect(turn2!.entry.id).toBe('b')
  })

  it('per-request：同一轮次键内也每次重选', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin', switch: 'per-request' })
    const turn = { turnKey: 'turn-1' }
    const first = await pool.getAvailableAccount('buddy-cn', '', undefined, turn)
    const second = await pool.getAvailableAccount('buddy-cn', '', undefined, turn)
    expect([first!.entry.id, second!.entry.id]).toEqual(['a', 'b'])
  })

  it('per-turn 但不给轮次键（pick 在场、turnKey 缺席）→ 策略生效但不锁，等价 per-request', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    // `pick` 在场 = 这是一次真实请求（按配置选号）；`turnKey` 缺席 = 不属于任何一轮
    // （一次性调用 / 测试），故不锁 —— 两次调用各选一个，正是「按请求」的语义。
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, {}))!.entry.id).toBe('a')
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, {}))!.entry.id).toBe('b')
  })

  it('**完全不给 pick**（auth 拉目录 / 适配器换号重试）走历史行为，且不消耗轮转游标', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b'), account('c')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    // 既有调用点（`buddy-auth.fetchModels` / `lobsterai-auth.fetchModels` /
    // 适配器的 `getAvailableAccount(provider, model, tried)` 换号循环）都不传 pick：
    // 它们必须拿到**与改动前逐字相同**的结果（第一个可用账号），
    // 否则一次「拉模型目录」就会偷偷吃掉一个轮转名额。
    expect((await pool.getAvailableAccount('buddy-cn', ''))!.entry.id).toBe('a')
    expect((await pool.getAvailableAccount('buddy-cn', ''))!.entry.id).toBe('a')
    expect(h.storageCurrent()!.consumptionCursors).toEqual({})
    // 带 pick 的真实请求仍从游标起点开始轮转（上面两次没有推进它）。
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, { turnKey: 't1' }))!.entry.id).toBe('a')
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, { turnKey: 't2' }))!.entry.id).toBe('b')
  })

  it('锁住的账号被停用 / 删除后，同轮内重新选号（锁自愈）', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'sequential' })
    const turn = { turnKey: 'turn-x' }
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, turn))!.entry.id).toBe('a')
    await pool.updateAccount('a', { enabled: false })
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, turn))!.entry.id).toBe('b')
  })

  it('锁按 provider 分键：同一轮次里两个 provider 各锁各的', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('b1'), account('q1', 'qoder')])
    await pool.writeConsumption('buddy-cn', { order: 'sequential' })
    await pool.writeConsumption('qoder', { order: 'sequential' })
    const turn = { turnKey: 'same-turn' }
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, turn))!.entry.id).toBe('b1')
    expect((await pool.getAvailableAccount('qoder', '', undefined, turn))!.entry.id).toBe('q1')
    // 两边都锁住了自己那一个（各自只有一个账号，连查两次都稳定）。
    expect((await pool.getAvailableAccount('buddy-cn', '', undefined, turn))!.entry.id).toBe('b1')
  })
})

describe('配置持久化：九件套互带（漏一个就被静默清空）', () => {
  it('每一条写路径的落盘载荷都带齐九个键', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    await pool.setModelDisabled('buddy-cn', 'x', true)
    await pool.writeContextBudget('buddy-cn', 'x', 1000)
    await pool.writeCheckinNextEligible('buddy-cn', 'a', Date.now() + 60_000)
    await pool.replaceAll([account('a')], pool.allDisabledModels(), 3)
    expect(h.storageWrites.length).toBeGreaterThanOrEqual(5)
    for (const write of h.storageWrites) {
      expect(Object.keys(write).sort()).toEqual(ACCOUNT_KEYS)
    }
  })

  it('写账号 / 黑名单 / 预算 / 签到都不会抹掉消耗配置与游标', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a'), account('b')])
    await pool.writeConsumption('buddy-cn', { order: 'round-robin', switch: 'per-request' })
    await pool.getAvailableAccount('buddy-cn', '', undefined, PER_REQUEST)
    await pool.setModelDisabled('buddy-cn', 'x', true)
    await pool.writeContextBudget('buddy-cn', 'x', 1000)
    const nextEligible = Date.now() + 7_000
    await pool.writeCheckinNextEligible('buddy-cn', 'a', nextEligible)
    await pool.removeAccount('b')
    const last = h.storageCurrent()!
    expect(last.consumption).toEqual({ 'buddy-cn': { order: 'round-robin', switch: 'per-request' } })
    expect(last.consumptionCursors).toEqual({ 'buddy-cn': 'b' })
    expect(last.disabledModels).toEqual({ 'buddy-cn': { x: true } })
    expect(last.contextBudgets).toEqual({ 'buddy-cn': { x: 1000 } })
    expect(last.checkins).toEqual({ 'buddy-cn:a': nextEligible })
  })

  it('写消耗配置本身是「读 → 改单键 → 整体 replace」，不动其它 provider 与其它字段', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await seed(pool, [account('a')])
    // ⚠️ 这里必须用**非默认档**：默认档（遍历）写入即被剔除，验不出「保留」语义。
    await pool.writeConsumption('buddy-cn', { order: 'sequential' })
    await pool.writeConsumption('qoder', { order: 'highest-balance' })
    expect(pool.allConsumption()).toEqual({
      'buddy-cn': { order: 'sequential', switch: 'per-turn' },
      qoder: { order: 'highest-balance', switch: 'per-turn' },
    })
    // 改回默认（遍历）→ 该 provider 的键被删除，不留 `{ provider: {默认值} }` 噪音。
    await pool.writeConsumption('buddy-cn', { order: 'round-robin' })
    expect(pool.allConsumption()).toEqual({ qoder: { order: 'highest-balance', switch: 'per-turn' } })
    expect((h.storageCurrent()!.consumption as Record<string, unknown>).buddy_cn).toBeUndefined()
  })

  it('脏值 / 半截配置在读取侧被归一化，不让整条配置失效', async () => {
    const h = makeHarness({
      accounts: [],
      consumption: { 'buddy-cn': { order: 'sequential' }, qoder: { order: 5 }, 'trae-cn': 'x' },
      consumptionCursors: { 'buddy-cn': 'a', qoder: 9 },
    })
    const pool = await makePool(h, [])
    // 半截条目补默认的 switch；非法档位（`5` / `'x'`）回退**默认档遍历**，
    // 于是那两条等于默认值 → 整条被剔除（不留噪音键）。
    expect(pool.allConsumption()).toEqual({ 'buddy-cn': { order: 'sequential', switch: 'per-turn' } })
    expect(pool.consumptionSetting('qoder')).toEqual({ order: 'round-robin', switch: 'per-turn' })
  })

  it('settings 回退路径同样读得到两个新字段（并归一化）', async () => {
    const h = makeHarness({ withStorage: false, consumption: { 'buddy-cn': { order: 'sequential' } } })
    const pool = new AccountPool(h.ctx as never)
    expect(await pool.openStorage()).toBe(false)
    expect(pool.consumptionSetting('buddy-cn')).toEqual({ order: 'sequential', switch: 'per-turn' })
  })

  it('回退路径写入两个新字段，且仍带上既有六件套', async () => {
    const h = makeHarness({ withStorage: false })
    const pool = new AccountPool(h.ctx as never)
    await pool.openStorage()
    await pool.writeConsumption('buddy-cn', { switch: 'per-request' })
    const last = h.settingsWrites.at(-1)!
    expect(Object.keys(last).sort()).toEqual(ACCOUNT_KEYS)
    // 只改了 switch ⇒ order 落的是**默认档遍历**。
    expect(last.consumption).toEqual({ 'buddy-cn': { order: 'round-robin', switch: 'per-request' } })
    expect(last.accounts).toEqual([])
  })

  it('非法档位一律拒绝写入，而不是把一个永不生效的值落盘', async () => {
    const h = makeHarness()
    const pool = await makePool(h, [])
    await expect(pool.writeConsumption('buddy-cn', { order: 'bogus' as never })).rejects.toThrow(/消耗顺序/)
    await expect(pool.writeConsumption('buddy-cn', { switch: 'bogus' as never })).rejects.toThrow(/切换粒度/)
    // 拒绝之后存储仍是干净的（没有半截写入）。
    expect(pool.allConsumption()).toEqual({})
  })
})
