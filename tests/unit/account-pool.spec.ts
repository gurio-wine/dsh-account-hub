import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool, todayDayNumber, pruneOrphanCheckins } from '../../src/account-pool.js'
import { migrateLegacyCheckinDay } from '../../src/checkin-schedule.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 伪造的 MockContext。
 *
 * `staleReads` 选项模拟 DSH settings 服务的真实行为：`scope.get()` 返回的是
 * 服务内部的 resolved 快照，`replace()` 之后该快照未必立即更新。开启后
 * get() 会返回上一次 replace() 之前的值——用于复现"连续记录限流互相覆盖"。
 */
function createMockContext(
  initialAccounts: ProviderAccountEntry[] = [],
  options: {
    staleReads?: boolean
    initialDisabledModels?: Record<string, Record<string, boolean>>
    initialContextBudgets?: Record<string, Record<string, number>>
    initialCheckins?: Record<string, number>
    initialSchemaVersion?: number
  } = {},
) {
  let stored: {
    accounts?: ProviderAccountEntry[]
    disabledModels?: Record<string, Record<string, boolean>>
    contextBudgets?: Record<string, Record<string, number>>
    checkins?: Record<string, number>
    schemaVersion?: number
  } = {
    accounts: initialAccounts,
    ...options.initialDisabledModels !== undefined ? { disabledModels: options.initialDisabledModels } : {},
    ...options.initialContextBudgets !== undefined ? { contextBudgets: options.initialContextBudgets } : {},
    ...options.initialCheckins !== undefined ? { checkins: options.initialCheckins } : {},
    ...options.initialSchemaVersion !== undefined ? { schemaVersion: options.initialSchemaVersion } : {},
  }
  // 滞后读：get() 返回的这个值只在"下一次 replace 之后"才追平
  let visible = stored
  const replaceCalls: Array<ProviderAccountEntry[]> = []
  // 每次 replace 的完整载荷：用于断言「写账号时没有把黑名单抹掉」这类
  // 整体替换语义带来的数据丢失。
  const replacePayloads: Array<Record<string, unknown>> = []
  const mockSettings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => (options.staleReads ? visible : stored),
      replace: async (value: {
        accounts?: ProviderAccountEntry[]
        disabledModels?: Record<string, Record<string, boolean>>
        contextBudgets?: Record<string, Record<string, number>>
        checkins?: Record<string, number>
        schemaVersion?: number
      }) => {
        if (options.staleReads) {
          // 模拟滞后：get() 始终慢一拍，本次写入要等下一次 replace 才可见
          visible = stored
        }
        stored = value
        replaceCalls.push(value.accounts ?? [])
        replacePayloads.push(value as Record<string, unknown>)
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const mockCredentials = new Map<string, string>()
  return {
    replaceCalls,
    replacePayloads,
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => key === 'settings' ? mockSettings : undefined,
    credentials: {
      describe: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        return { configured: mockCredentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        const value = mockCredentials.get(key)
        return value ? { value, source: 'test' as const } : undefined
      },
      set: async (ref: ReturnType<typeof credentialRef>, value: string) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.set(key, value)
      },
      unset: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.delete(key)
      },
    },
  }
}

describe('AccountPool', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 每次通过工厂返回新对象，避免测试间 Object.assign 污染共享引用 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy-cn',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as any)
  })

  it('should add and list accounts', async () => {
    await pool.addAccount(makeMockAccount())
    const list = await pool.listAccounts('buddy-cn')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('buddy-001')
  })

  it('should filter by provider', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const buddyAccounts = await pool.listAccounts('buddy-cn')
    const codeartsAccounts = await pool.listAccounts('codearts')
    expect(buddyAccounts).toHaveLength(1)
    expect(codeartsAccounts).toHaveLength(1)
  })

  it('should update account', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.updateAccount('buddy-001', { enabled: false })
    const list = await pool.listAccounts('buddy-cn')
    expect(list[0].enabled).toBe(false)
  })

  it('should throw on update for non-existent account', async () => {
    await expect(pool.updateAccount('nonexistent', { enabled: false })).rejects.toThrow('Account nonexistent not found')
  })

  it('should remove account and credential', async () => {
    await pool.addAccount(makeMockAccount())
    // 先设一个凭据，确认删除时清理
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.removeAccount('buddy-001')
    const list = await pool.listAccounts('buddy-cn')
    expect(list).toHaveLength(0)
    const resolved = await ctx.credentials.resolve(credentialRef('BUDDY_CN_ACCOUNT_T1'))
    expect(resolved).toBeUndefined()
  })

  it('should return available account for model', async () => {
    // 为两个账号都设置凭据
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T1'), JSON.stringify({ access_token: 'test1' }))
    await pool.addAccount(makeMockAccount())
    // 为第二个账号设置模型限流
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T2'), JSON.stringify({ access_token: 'test2' }))
    await pool.addAccount(makeMockAccount({
      id: 'buddy-002',
      credentialRef: 'BUDDY_CN_ACCOUNT_T2',
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.entry.id).toBe('buddy-001')
  })

  it('should return null when all accounts rate-limited', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when no accounts at all', async () => {
    const result = await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential resolve fails', async () => {
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential JSON parse fails', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T1'), 'not-json')
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should update model rate limit', async () => {
    await pool.addAccount(makeMockAccount())
    const resetAt = Date.now() + 7200000
    await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', resetAt)
    const list = await pool.listAccounts('buddy-cn')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(resetAt)
  })

  it('should sweep expired rate limits', async () => {
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() - 1000, 'deepseek-v4-pro': Date.now() + 3600000 },
    }))
    await pool.sweepExpiredRateLimits()
    const list = await pool.listAccounts('buddy-cn')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBeUndefined()
    expect(list[0].modelRateLimits?.['deepseek-v4-pro']).toBeDefined()
  })

  // ── 手动排序（Account Hub 拖拽，移植上游 84d0b3f 的后端部分）──
  // 顺序即 getAvailableAccount 的候选优先级，故这些用例同时守「持久化」与
  // 「真的影响选号」两件事 —— 只测前者会让拖拽退化成 UI 装饰。
  describe('reorderAccounts', () => {
    /** 建同 provider 账号，凭据齐备，便于验证选号结果。 */
    async function seed(ids: string[], provider = 'buddy-cn'): Promise<void> {
      for (const id of ids) {
        const ref = `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_${id.toUpperCase()}`
        await ctx.credentials.set(credentialRef(ref), JSON.stringify({ access_token: id }))
        await pool.addAccount(makeMockAccount({ id, provider, credentialRef: ref }))
      }
    }

    it('重排后 listAccounts 顺序随之改变', async () => {
      await seed(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy-cn', ['c', 'a', 'b'])
      const list = await pool.listAccounts('buddy-cn')
      expect(list.map(a => a.id)).toEqual(['c', 'a', 'b'])
    })

    it('重排真正影响 getAvailableAccount 的选号结果', async () => {
      await seed(['a', 'b', 'c'])
      expect((await pool.getAvailableAccount('buddy-cn', ''))?.entry.id).toBe('a')
      await pool.reorderAccounts('buddy-cn', ['c', 'b', 'a'])
      expect((await pool.getAvailableAccount('buddy-cn', ''))?.entry.id).toBe('c')
    })

    /**
     * 删除「按限流重置时间最早到期重排候选」的 sort 之后的行为锁。
     *
     * 两个账号对目标模型的限流标记**都已过期**（故都在候选里），且重置时间
     * 一前一后：旧排序会把更早到期的 b 提到前面，新语义必须取数组顺序第一的 a。
     */
    it('数组顺序即优先级：限流重置时间不再参与候选排序', async () => {
      const pastLater = Date.now() - 5_000
      const past = Date.now() - 10_000
      await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a',
        credentialRef: 'BUDDY_CN_ACCOUNT_A',
        // a 的限流重置时间**更晚**（但已过期）
        modelRateLimits: { 'deepseek-v4-flash': pastLater },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({
        id: 'b',
        credentialRef: 'BUDDY_CN_ACCOUNT_B',
        // b 更早到期 → 旧排序会把 b 排到 a 前面
        modelRateLimits: { 'deepseek-v4-flash': past },
      }))

      expect(
        (await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash'))?.entry.id,
        '数组顺序即选号优先级（上游 84d0b3f 删除了按限流重置时间重排候选的 sort）',
      ).toBe('a')
      // 拖到首位后选号跟着变，证明顺序确实是唯一的优先级来源。
      await pool.reorderAccounts('buddy-cn', ['b', 'a'])
      expect((await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash'))?.entry.id).toBe('b')
    })

    it('限流期内的账号被跳过，即使它排在最前（限流豁免）', async () => {
      await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a',
        credentialRef: 'BUDDY_CN_ACCOUNT_A',
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3_600_000 },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({ id: 'b', credentialRef: 'BUDDY_CN_ACCOUNT_B' }))

      await pool.reorderAccounts('buddy-cn', ['a', 'b'])
      expect((await pool.getAvailableAccount('buddy-cn', 'deepseek-v4-flash'))?.entry.id).toBe('b')
    })

    it('只动本 provider 占用的下标，其他 provider 位置不变', async () => {
      // 账号存在一个全局数组里，而设置页按 provider 分组渲染。
      // 拖 buddy-cn 不应顺带改动 codearts 账号的位置。
      await seed(['b1'])
      await seed(['c1'], 'codearts')
      await seed(['b2'])

      await pool.reorderAccounts('buddy-cn', ['b2', 'b1'])
      const all = await pool.listAllAccounts()
      // 两个 buddy-cn 账号在各自原本的下标（0 与 2）上互换，codearts 仍在中间
      expect(all.map(a => a.id)).toEqual(['b2', 'c1', 'b1'])
    })

    it('id 集合不一致（少 / 多 / 重复）时抛错且不改动数据', async () => {
      await seed(['a', 'b', 'c'])
      await expect(pool.reorderAccounts('buddy-cn', ['a', 'b'])).rejects.toThrow()
      await expect(pool.reorderAccounts('buddy-cn', ['a', 'b', 'c', 'zzz'])).rejects.toThrow()
      await expect(pool.reorderAccounts('buddy-cn', ['a', 'a', 'b'])).rejects.toThrow()
      // 数据未被破坏
      const list = await pool.listAccounts('buddy-cn')
      expect(list.map(a => a.id)).toEqual(['a', 'b', 'c'])
    })

    it('空数组（该 provider 无账号）是 no-op，不写盘', async () => {
      await seed(['a', 'b'])
      const before = ctx.replaceCalls.length
      await pool.reorderAccounts('codearts', [])
      expect(ctx.replaceCalls.length).toBe(before)
      expect((await pool.listAccounts('buddy-cn')).map(a => a.id)).toEqual(['a', 'b'])
    })

    it('顺序未变时不写盘（拖拽落回原位是常见操作）', async () => {
      await seed(['a', 'b', 'c'])
      const before = ctx.replaceCalls.length
      await pool.reorderAccounts('buddy-cn', ['a', 'b', 'c'])
      expect(ctx.replaceCalls.length).toBe(before)
    })

    it('重排结果落盘，新池从同一持久层读回同一顺序', async () => {
      await seed(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy-cn', ['c', 'b', 'a'])
      // 同一个 ctx（同一份 settings 存储）上新建的池必须读到新顺序
      const reopened = new AccountPool(ctx as never)
      expect((await reopened.listAccounts('buddy-cn')).map(a => a.id)).toEqual(['c', 'b', 'a'])
    })

    it('重排只写账号字段，不抹掉黑名单 / 上下文预算 / 版本号', async () => {
      // writeAccounts 是整体 replace，漏带另外三件套会一起清空。
      await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
      await pool.writeContextBudget('buddy-cn', 'glm-5.2', 200_000)
      await seed(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy-cn', ['c', 'b', 'a'])

      expect([...pool.disabledModelsFor('buddy-cn')]).toEqual(['glm-5.2'])
      expect(pool.contextBudget('buddy-cn', 'glm-5.2')).toBe(200_000)
      const payload = ctx.replacePayloads.at(-1)!
      expect(payload.accounts).toBeDefined()
      expect(payload.disabledModels).toEqual({ 'buddy-cn': { 'glm-5.2': true } })
      expect(payload.contextBudgets).toEqual({ 'buddy-cn': { 'glm-5.2': 200_000 } })
      // schemaVersion 必须原样携带（漏带会让改名迁移每次启动重跑）
      expect(payload.schemaVersion).toBe(0)
    })
  })

  it('should list all accounts', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const all = await pool.listAllAccounts()
    expect(all).toHaveLength(2)
  })

  // ── 停用账号绝不参与自动选择 ──
  // `getAvailableAccount` 是 provider 的凭据入口。停用只意味着"不自动参与
  // 轮换"，因此任何情况下都不能返回停用账号——包括 modelId 为空串时
  //（此时无法做限流过滤，最容易误把停用账号当成候选）。
  describe('停用账号不参与自动选择', () => {
    it('modelId 为空串时也不返回停用账号', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on', provider: 'codearts', enabled: true, credentialRef: 'CA_ON',
      }))

      const result = await pool.getAvailableAccount('codearts', '')
      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('codearts-on')
    })

    it('仅剩停用账号时返回 null（空 modelId 同样如此）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })

    it('空 modelId 会跳过限流过滤，但启用账号仍被返回', async () => {
      // 空 modelId 的语义：调用方还不知道目标模型，只能退化为"任取一个
      // 启用账号"。此处记录该既有行为，避免日后被误改成"一并过滤"。
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on',
        provider: 'codearts',
        enabled: true,
        credentialRef: 'CA_ON',
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3_600_000 },
      }))

      expect((await pool.getAvailableAccount('codearts', ''))?.entry.id).toBe('codearts-on')
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })
  })

  // ── 限流标记清除（重测/重置的底层能力）──
  describe('clearModelRateLimits', () => {
    it('清空后删除 modelRateLimits 字段本身，不留空对象', async () => {
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 1000 },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001')
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy-cn'))[0].modelRateLimits).toBeUndefined()
    })

    it('只清除指定的模型，其余保留', async () => {
      const keep = Date.now() + 3_600_000
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': keep },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001', ['model-a'])
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy-cn'))[0].modelRateLimits).toEqual({ 'model-b': keep })
    })

    it('对无标记的账号返回 0 且不写盘', async () => {
      await pool.addAccount(makeMockAccount())
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(0)
    })

    it('对不存在的账号返回 0', async () => {
      expect(await pool.clearModelRateLimits('nonexistent')).toBe(0)
    })
  })

  describe('resolveCredentialForAccount（含停用账号）', () => {
    it('停用账号凭据仍可按 id 解析（重测需要）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      const credential = await pool.resolveCredentialForAccount('codearts-off')
      expect(credential).toMatchObject({ access_key_id: 'off' })
      // 但自动选择必须仍然排除它
      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
    })

    it('账号不存在或凭据不可用时返回 undefined', async () => {
      expect(await pool.resolveCredentialForAccount('missing')).toBeUndefined()
      await pool.addAccount(makeMockAccount())  // 未设置凭据
      expect(await pool.resolveCredentialForAccount('buddy-001')).toBeUndefined()
    })
  })

  it('listAccountsByProvider 含停用账号', async () => {
    await pool.addAccount(makeMockAccount({ id: 'on', enabled: true }))
    await pool.addAccount(makeMockAccount({ id: 'off', enabled: false, credentialRef: 'BUDDY_CN_ACCOUNT_T2' }))
    await pool.addAccount(makeMockAccount({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))

    expect(pool.listAccountsByProvider('buddy-cn').map(a => a.id).sort()).toEqual(['off', 'on'])
    expect(pool.findAccount('off')?.enabled).toBe(false)
  })

  it('should handle removeAccount of non-existent account gracefully', async () => {
    await pool.removeAccount('nonexistent')
    const list = await pool.listAllAccounts()
    expect(list).toHaveLength(0)
  })

  it('should handle updateModelRateLimit for non-existent account gracefully', async () => {
    await pool.updateModelRateLimit('nonexistent', 'deepseek-v4-flash', Date.now() + 3600000)
    // 不会抛出
  })

  /**
   * 回归：settings scope 的 get() 滞后于 replace() 时，连续记录多个账号的
   * 限流不能互相覆盖。
   *
   * 曾经的实现每次都以 scope.get() 为读源，若快照滞后，第二次写入会基于
   * 不含第一次记录的旧快照整体 replace，把前一条限流抹掉——表现为
   * "多个账号都触发过限流，settings.yaml 里却一条 modelRateLimits 都没有"。
   */
  it('keeps earlier rate limits when recording several accounts under a stale scope', async () => {
    const staleCtx = createMockContext([], { staleReads: true })
    const stalePool = new AccountPool(staleCtx as never)

    await stalePool.addAccount(makeMockAccount({ id: 'acct-1', credentialRef: 'BUDDY_CN_ACCOUNT_T1' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-2', credentialRef: 'BUDDY_CN_ACCOUNT_T2' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-3', credentialRef: 'BUDDY_CN_ACCOUNT_T3' }))

    const t1 = Date.now() + 3_600_000
    const t2 = Date.now() + 7_200_000
    const t3 = Date.now() + 10_800_000
    await stalePool.updateModelRateLimit('acct-1', 'deepseek-v4.1-flash', t1)
    await stalePool.updateModelRateLimit('acct-2', 'deepseek-v4.1-flash', t2)
    await stalePool.updateModelRateLimit('acct-3', 'deepseek-v4.1-flash', t3)

    const list = await stalePool.listAllAccounts()
    const limits = list.map(a => a.modelRateLimits?.['deepseek-v4.1-flash'])
    // 三条记录都必须留存（fix 前这里会是 [undefined, undefined, t3] 或类似）
    expect(limits).toEqual([t1, t2, t3])
  })
})

describe('findAccountIdByCredential 的 provider 字段选择', () => {
  it('workbuddy 按 access_token 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({
      access_token: 'WB-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-1', provider: 'buddy', nickname: 'WB', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T1', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('buddy', 'WB-TOKEN')).toBe('workbuddy-1')
  })

  it('workbuddy 不会误用 access_key_id 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T2'), JSON.stringify({
      access_token: 'WB-TOKEN', access_key_id: 'SOMETHING-ELSE', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-2', provider: 'buddy', nickname: 'WB', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T2', createdAt: Date.now(), refreshable: true,
    })
    // 传入 access_token 值应命中
    expect(await pool.findAccountIdByCredential('buddy', 'WB-TOKEN')).toBe('workbuddy-2')
    // 传入 access_key_id 值不应命中（说明用的确实是 access_token 字段）
    expect(await pool.findAccountIdByCredential('buddy', 'SOMETHING-ELSE')).toBe('')
  })

  it('codearts 仍按 access_key_id 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_T3'), JSON.stringify({
      access_key_id: 'AK-1', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-12-31T00:00:00Z',
    }))
    await pool.addAccount({
      id: 'codearts-1', provider: 'codearts', nickname: 'CA', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_T3', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('codearts', 'AK-1')).toBe('codearts-1')
  })

  it('buddy 仍按 access_token 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_T4'), JSON.stringify({
      access_token: 'BD-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'buddy-4', provider: 'buddy-cn', nickname: 'BD', enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T4', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('buddy-cn', 'BD-TOKEN')).toBe('buddy-4')
  })
})

describe('pruneAccountsWithForeignDomain', () => {
  /** WorkBuddy 国际版的判定目标：域名是 www.workbuddy.ai */
  const product = { id: 'buddy', apiDomain: 'www.workbuddy.ai' } as never

  it('domain 失配 → 保留账号与凭据，仅记警告不删除', async () => {
    const ctx = createMockContext()
    const warn = vi.fn()
    ctx.logger.warn = warn
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_OLD'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'workbuddy-old', provider: 'buddy', nickname: '旧', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_OLD', createdAt: Date.now(), refreshable: true,
    })

    const flagged = await pool.pruneAccountsWithForeignDomain(product)

    // 机器不再静默销毁数据：账号与凭据都保留。
    expect(flagged).toEqual(['workbuddy-old'])
    expect(await pool.listAllAccounts()).toHaveLength(1)
    expect(await ctx.credentials.resolve(credentialRef('BUDDY_ACCOUNT_OLD'))).toBeDefined()
    // 记一条含 provider / accountId / domain 的警告，让用户可自行处理。
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('workbuddy-old')
    expect(warn.mock.calls[0][0]).toContain('copilot.tencent.com')
  })

  it('保留 domain 与新端点一致的 WorkBuddy 账号，且零警告', async () => {
    const ctx = createMockContext()
    const warn = vi.fn()
    ctx.logger.warn = warn
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_NEW'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'www.workbuddy.ai',
    }))
    await pool.addAccount({
      id: 'workbuddy-new', provider: 'buddy', nickname: '新', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_NEW', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('不触碰其他 provider 的账号', async () => {
    const ctx = createMockContext()
    const warn = vi.fn()
    ctx.logger.warn = warn
    const pool = new AccountPool(ctx as never)
    // CodeBuddy 账号的 domain 也是 copilot.tencent.com，但不该被 WorkBuddy 的审计波及
    await ctx.credentials.set(credentialRef('BUDDY_CN_ACCOUNT_KEEP'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'buddy-keep', provider: 'buddy-cn', nickname: 'CB', enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_KEEP', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('domain 为空的历史凭据保守保留（无法判定，不告警）', async () => {
    const ctx = createMockContext()
    const warn = vi.fn()
    ctx.logger.warn = warn
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_NODOMAIN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: '',
    }))
    await pool.addAccount({
      id: 'workbuddy-nodomain', provider: 'buddy', nickname: '?', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_NODOMAIN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('凭据缺失时不删除（交给正常的「凭据未配置」报错路径）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'workbuddy-nocred', provider: 'buddy', nickname: '无', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_MISSING', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据 JSON 损坏时不删除且不抛异常', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_BROKEN'), '{not json')
    await pool.addAccount({
      id: 'workbuddy-broken', provider: 'buddy', nickname: '坏', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_BROKEN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('混合场景：失配的全部保留并在案，其余不动', async () => {
    const ctx = createMockContext()
    const warn = vi.fn()
    ctx.logger.warn = warn
    const pool = new AccountPool(ctx as never)
    for (const [ref, domain] of [
      ['BUDDY_ACCOUNT_A', 'copilot.tencent.com'],
      ['BUDDY_ACCOUNT_B', 'www.workbuddy.ai'],
      ['BUDDY_ACCOUNT_C', 'copilot.tencent.com'],
    ] as const) {
      await ctx.credentials.set(credentialRef(ref), JSON.stringify({
        access_token: 'AT', refresh_token: 'RT',
        expires_at: String(Date.now() + 3_600_000), domain,
      }))
      await pool.addAccount({
        id: ref.toLowerCase(), provider: 'buddy', nickname: ref, enabled: true,
        credentialRef: ref, createdAt: Date.now(), refreshable: true,
      })
    }

    const flagged = await pool.pruneAccountsWithForeignDomain(product)

    // 三条账号一条都不删。
    expect(flagged.sort()).toEqual(['buddy_account_a', 'buddy_account_c'])
    expect(await pool.listAllAccounts()).toHaveLength(3)
    // 只对失配的两条各记一条警告。
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

/**
 * 模型黑名单（Account Hub 的「显示列表」开关）。
 *
 * 语义核心是**黑名单制**：只有被显式关闭的模型会隐藏，未记录的模型
 * 一律默认打开。这保证服务端新增模型时不需要任何配置就能出现在选择器里
 * —— 白名单制会把新模型静默挡在门外，是这套开关最容易踩的坑。
 */
describe('AccountPool 模型黑名单', () => {
  it('未配置时没有任何模型被关闭（默认全开）', () => {
    const pool = new AccountPool(createMockContext() as never)
    expect(pool.disabledModelsFor('buddy-cn').size).toBe(0)
    expect(pool.listDisabledModels('buddy-cn')).toEqual({})
  })

  it('关闭模型后该模型进入黑名单，其余模型不受影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)

    const disabled = pool.disabledModelsFor('buddy-cn')
    expect(disabled.has('glm-5.2')).toBe(true)
    // 没被关掉的模型默认打开 —— 黑名单制的关键断言
    expect(disabled.has('deepseek-v4-flash')).toBe(false)
    expect(disabled.has('hy3')).toBe(false)
  })

  it('重新打开时删除条目，而不是写入 false', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', false)

    expect(pool.disabledModelsFor('buddy-cn').size).toBe(0)
    // 打开后 provider 表变空，应当整体从配置里消失（不留 { buddy: {} } 噪音）
    const last = ctx.replacePayloads.at(-1)!
    expect(last.disabledModels).toEqual({})
  })

  it('不同 provider 的黑名单互不影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    await pool.setModelDisabled('buddy', 'gpt-5.4', true)

    expect([...pool.disabledModelsFor('buddy-cn')]).toEqual(['glm-5.2'])
    expect([...pool.disabledModelsFor('buddy')]).toEqual(['gpt-5.4'])
    expect(pool.disabledModelsFor('codearts').size).toBe(0)
  })

  it('关闭多个模型后全部保留', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    await pool.setModelDisabled('buddy-cn', 'hy3', true)
    await pool.setModelDisabled('buddy-cn', 'kimi-k2.6', true)

    expect([...pool.disabledModelsFor('buddy-cn')].sort()).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6'])
  })

  it('从已有配置载入黑名单', () => {
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: { 'buddy-cn': { 'glm-5.2': true } },
    }) as never)
    const disabled = pool.disabledModelsFor('buddy-cn')
    expect(disabled.has('glm-5.2')).toBe(true)
    expect(disabled.size).toBe(1)
  })

  /**
   * 回归：settings 的 replace() 是**整体替换**。写账号列表时若不带上
   * disabledModels，用户刚设置的模型开关会被下一次账号操作（新增/删除/
   * 限流标记）静默清空。
   */
  it('写账号列表时不会抹掉已有的黑名单', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    await pool.addAccount({
      id: 'buddy-x', provider: 'buddy-cn', nickname: 'X', enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_X', createdAt: Date.now(), refreshable: true,
    })

    expect(ctx.replacePayloads.at(-1)!.disabledModels).toEqual({ 'buddy-cn': { 'glm-5.2': true } })
    expect(pool.disabledModelsFor('buddy-cn').has('glm-5.2')).toBe(true)
  })

  /** 反向回归：写黑名单时若丢掉账号列表，账号池会被清空。 */
  it('写黑名单时不会抹掉账号列表', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'buddy-y', provider: 'buddy-cn', nickname: 'Y', enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_Y', createdAt: Date.now(), refreshable: true,
    })
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)

    expect(ctx.replacePayloads.at(-1)!.accounts).toHaveLength(1)
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('配置文件里的脏数据被忽略而不是抛错', () => {
    // 模拟手工编辑过的/老版本的配置文件：数组、字符串、false 都应被丢弃
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: {
        'buddy-cn': { 'glm-5.2': true, 'hy3': false, 'bad': 'yes' } as never,
        broken: ['glm-5.2'] as never,
      },
    }) as never)

    // 只有显式 true 的条目生效
    expect([...pool.disabledModelsFor('buddy-cn')]).toEqual(['glm-5.2'])
    // 结构非法的 provider 整层丢弃
    expect(pool.disabledModelsFor('broken').size).toBe(0)
  })

  it('无 settings scope 时降级为内存态，不抛错', async () => {
    const pool = new AccountPool({ get: () => undefined, logger: { warn: () => {}, info: () => {} } } as never)
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    expect(pool.disabledModelsFor('buddy-cn').has('glm-5.2')).toBe(true)
  })
})

/**
 * 逐模型上下文窗口预算（Trae CN 的 dev / Max 档位选择）。
 *
 * 语义核心与黑名单**同构**：它跟账号列表、黑名单、数据版本号住在同一个
 * settings namespace 里，而 `replace()` 是**整体替换** —— 四件套任何一个写操作
 * 都必须携带另外三个，漏一个就会在下次别的写入里被静默清空。
 *
 * 与黑名单唯一的不同：这里的值是**数字**（窗口 token 数），且「删除键」与
 * 「写入某个值」必须可区分（`undefined` = 恢复默认档，而不是写 0）。
 */
describe('AccountPool 上下文窗口预算', () => {
  it('未配置时读不到任何预算（默认档）', () => {
    const pool = new AccountPool(createMockContext() as never)
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBeUndefined()
  })

  it('写入后能按 provider + 模型读出', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)

    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
    // 黑名单制同款：没写过的键读出来是 undefined（= 默认档），而不是 0。
    expect(pool.contextBudget('trae-cn', 'glm-5.2')).toBeUndefined()
    expect(pool.contextBudget('lobsterai', 'glm-5.3')).toBeUndefined()
  })

  it('写 `undefined` = **删除该键**（恢复默认档），且表空时 provider 整体消失', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', undefined)

    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBeUndefined()
    // 不留 `{ 'trae-cn': {} }` 这类无意义噪音。
    expect(ctx.replacePayloads.at(-1)!.contextBudgets).toEqual({})
  })

  it('不同 provider / 不同模型互不影响（只改单个键）', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)
    await pool.writeContextBudget('trae-cn', 'glm-5.2', 262_144)
    await pool.writeContextBudget('buddy-cn', 'glm-5.2', 300_000)

    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
    expect(pool.contextBudget('trae-cn', 'glm-5.2')).toBe(262_144)
    expect(pool.contextBudget('buddy-cn', 'glm-5.2')).toBe(300_000)
  })

  it('从已有配置载入预算（配置里已有档位时，重启后不丢）', () => {
    const pool = new AccountPool(createMockContext([], {
      initialContextBudgets: { 'trae-cn': { 'glm-5.3': 1_048_576 } },
    }) as never)
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
  })

  it('配置文件里的脏数据被忽略而不是抛错（0 / 负数 / 字符串 / 非法结构）', () => {
    const pool = new AccountPool(createMockContext([], {
      initialContextBudgets: {
        'trae-cn': { good: 1_048_576, zero: 0, negative: -1, text: '1048576', nan: Number.NaN } as never,
        broken: ['glm-5.3'] as never,
      },
    }) as never)
    expect(pool.contextBudget('trae-cn', 'good')).toBe(1_048_576)
    // 非正数不是「很小的窗口」，是无效声明 —— 与适配器侧 readPositive 同口径丢弃。
    for (const bad of ['zero', 'negative', 'text', 'nan']) {
      expect(pool.contextBudget('trae-cn', bad), bad).toBeUndefined()
    }
    // 结构非法的 provider 整层丢弃。
    expect(pool.contextBudget('broken', 'glm-5.3')).toBeUndefined()
  })

  /**
   * 四件套互带：账号 / 黑名单 / 上下文预算 / 数据版本号。
   *
   * 三个方向各测一次（写账号、写黑名单、写预算），每个方向都断言**另外三个**
   * 都还在载荷里。
   */
  it('写账号列表时不会抹掉预算与黑名单', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)
    await pool.setModelDisabled('trae-cn', 'kimi-k3', true)
    await pool.addAccount({
      id: 'trae-1', provider: 'trae-cn', nickname: 'T', enabled: true,
      credentialRef: 'TRAE_CN_ACCOUNT_1', createdAt: Date.now(), refreshable: true,
    })

    const last = ctx.replacePayloads.at(-1)!
    expect(last.contextBudgets).toEqual({ 'trae-cn': { 'glm-5.3': 1_048_576 } })
    expect(last.disabledModels).toEqual({ 'trae-cn': { 'kimi-k3': true } })
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
  })

  it('写黑名单时不会抹掉预算', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)
    await pool.setModelDisabled('trae-cn', 'kimi-k3', true)

    expect(ctx.replacePayloads.at(-1)!.contextBudgets).toEqual({ 'trae-cn': { 'glm-5.3': 1_048_576 } })
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
  })

  it('写预算时不会抹掉账号列表、黑名单与版本号', async () => {
    const ctx = createMockContext([], {
      initialDisabledModels: { 'trae-cn': { 'kimi-k3': true } },
      initialSchemaVersion: 1,
    })
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'trae-2', provider: 'trae-cn', nickname: 'T2', enabled: true,
      credentialRef: 'TRAE_CN_ACCOUNT_2', createdAt: Date.now(), refreshable: true,
    })
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)

    const last = ctx.replacePayloads.at(-1)!
    expect(last.accounts).toHaveLength(1)
    expect(last.disabledModels).toEqual({ 'trae-cn': { 'kimi-k3': true } })
    expect(last.schemaVersion).toBe(1)
  })

  /**
   * 回归（与 `setModelDisabled` 同款陷阱）：`writeContextBudget` 是**不经过读路径**
   * 的直接写入入口。它若忘了先 `ensureLoaded()`，整表 replace 会把还没载入的
   * 账号、黑名单与数据版本号一起覆盖成空。
   */
  it('首次写入前先 ensureLoaded：不会把配置里已有的账号 / 黑名单 / 版本号清空', async () => {
    const ctx = createMockContext([
      {
        id: 'trae-9', provider: 'trae-cn', nickname: 'T9', enabled: true,
        credentialRef: 'TRAE_CN_ACCOUNT_9', createdAt: Date.now(), refreshable: true,
      },
    ], {
      initialDisabledModels: { 'trae-cn': { 'kimi-k3': true } },
      initialSchemaVersion: 1,
    })
    const pool = new AccountPool(ctx as never)
    // 刻意**不先读**任何东西，直接写预算。
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)

    const last = ctx.replacePayloads.at(-1)!
    expect(last.accounts).toHaveLength(1)
    expect(last.disabledModels).toEqual({ 'trae-cn': { 'kimi-k3': true } })
    expect(last.schemaVersion).toBe(1)
  })

  /**
   * 回归：一次性改名迁移走 `replaceAll`（原子写账号 + 黑名单 + 版本号）。
   * 它必须**原样带上预算**——预算不是迁移对象，但同属一个 namespace，
   * 漏带会让迁移顺手清空用户的档位选择。
   */
  it('`replaceAll`（改名迁移）不会清空已有的预算', async () => {
    const ctx = createMockContext([], {
      initialContextBudgets: { 'trae-cn': { 'glm-5.3': 1_048_576 } },
    })
    const pool = new AccountPool(ctx as never)
    await pool.replaceAll([], {}, 1)

    expect(ctx.replacePayloads.at(-1)!.contextBudgets).toEqual({ 'trae-cn': { 'glm-5.3': 1_048_576 } })
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
  })

  it('无 settings scope 时降级为内存态，不抛错', async () => {
    const pool = new AccountPool({ get: () => undefined, logger: { warn: () => {}, info: () => {} } } as never)
    await pool.writeContextBudget('trae-cn', 'glm-5.3', 1_048_576)
    expect(pool.contextBudget('trae-cn', 'glm-5.3')).toBe(1_048_576)
  })
})

// ── 自动签到存储层（第五件套 checkins）──

describe('todayDayNumber —— 本地时区纪元日数', () => {
  /** 假时钟让"今天"固定在某时刻，再断言跨时区/跨日的日数口径。 */
  function freezeNow(iso: string): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('用本地日期的纪元日数（秒级：一天的毫秒数，日数 = floor(date/86400000) 的本地口径）', () => {
    // UTC 中午的时刻：东京（UTC+9）已是当天深夜、美西（UTC-7）还是当天凌晨，
    // 本地日数都应在「本地当日」的语义下给出。
    freezeNow('2026-06-15T12:00:00.000Z')
    const now = new Date('2026-06-15T12:00:00.000Z')
    // 参考：本地时区的年月日 → epoch day = Date.UTC(y,m,d)/86400000。
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    expect(todayDayNumber(now)).toBe(Math.floor(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000))
  })

  it('跨日翻转：UTC 与本地日界不一致处以本地年月日为准（JP 时区 UTC+9）', () => {
    // 东京时间 2026-06-16 00:30 = UTC 2026-06-15 15:30。
    // 固定系统时钟为 UTC 时刻，但 todayDayNumber 必须按本地（此处为宿主机时区）算。
    freezeNow('2026-06-15T15:30:00.000Z')
    const now = new Date('2026-06-15T15:30:00.000Z')
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const expected = Math.floor(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000)
    expect(todayDayNumber(now)).toBe(expected)
    // 跨过本地日边界后再翻转一次：06-16 的东八区零点 == UTC 前一天的 16 点。
    // 这一步验证的是公式在「同一 Date 实例、只看本地年月日」下稳定，不漂移。
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const expectedTomorrow = Math.floor(Date.UTC(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()) / 86_400_000)
    expect(todayDayNumber(new Date(tomorrow.getTime()))).toBe(expectedTomorrow)
  })

  it('凌晨时分日数不等于前一毫秒（同日边界唯一、跨日严格递增）', () => {
    freezeNow('2026-01-02T16:00:00.000Z')
    const a = new Date('2026-01-02T16:00:00.000Z')
    const aDay = todayDayNumber(a)
    // 往前 24h 的同一瞬时（农历/时区不变），日数应恰好少 1（无夏令时越界的普通场景）。
    const b = new Date(a.getTime() - 86_400_000)
    expect(todayDayNumber(a) - todayDayNumber(b)).toBe(1)
    expect(aDay).toBeGreaterThan(0)
  })
})

describe('AccountPool 签到存储（checkins 第五件套）', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 顶层需要的账号工厂（外层 describe 里的 makeMockAccount 作用域不可达）。 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy-cn',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as any)
  })

  it('写下一次可签时刻经整体 replace 落盘，读回一致（读经 ensureLoaded 从进程内副本）', async () => {
    // ⚠️ 值必须是**毫秒时间戳**（本次改动后）：日数那种量级的数字会被
    // `isCheckinDue` 判成「1970 年就可以再签了」，每轮 sweep 都重签。
    const nextEligible = Date.now() + 3_600_000
    await pool.writeCheckinNextEligible('trae-cn', 'trae-cn-a1b2', nextEligible)
    expect(pool.checkinNextEligible('trae-cn', 'trae-cn-a1b2')).toBe(nextEligible)
    // 写账号操作不得抹掉已写入的时刻（九件套互带）
    await pool.addAccount(makeMockAccount({ id: 'trae-cn-x', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_X' }))
    expect(pool.checkinNextEligible('trae-cn', 'trae-cn-a1b2')).toBe(nextEligible)
    // 未写入的键读不到（undefined = 从未签过 ⇒ 可签）
    expect(pool.checkinNextEligible('trae-cn', 'never')).toBeUndefined()
    expect(pool.isCheckinDue('trae-cn', 'never')).toBe(true)
  })

  it('isCheckinDue：未来时刻 = 已签，过去/无记录 = 可签', async () => {
    const now = Date.now()
    await pool.writeCheckinNextEligible('buddy-cn', 'future', now + 60_000)
    await pool.writeCheckinNextEligible('buddy-cn', 'past', now - 60_000)
    expect(pool.isCheckinDue('buddy-cn', 'future', now)).toBe(false)
    expect(pool.isCheckinDue('buddy-cn', 'past', now)).toBe(true)
    expect(pool.isCheckinDue('buddy-cn', 'absent', now)).toBe(true)
  })

  it('回退路径下 checkins 照常读写（settings 整体 replace 同样携带该件套）', async () => {
    const nextEligible = Date.now() + 7_200_000
    await pool.writeCheckinNextEligible('codearts', 'codearts-c1', nextEligible)
    expect(pool.checkinNextEligible('codearts', 'codearts-c1')).toBe(nextEligible)
    const last = ctx.replacePayloads.at(-1)!
    expect(last.checkins).toEqual({ 'codearts:codearts-c1': nextEligible })
  })

  it('从已有配置载入（重启后不丢，键格式 provider:accountId，新口径原样读回）', () => {
    const stored = Date.now() + 3_600_000
    const seeded = createMockContext([], { initialCheckins: { 'trae-cn:trae-cn-a1b2': stored } })
    const p = new AccountPool(seeded as never)
    expect(p.checkinNextEligible('trae-cn', 'trae-cn-a1b2')).toBe(stored)
    // 其他键读不到，不串
    expect(p.checkinNextEligible('trae-cn', 'other')).toBeUndefined()
    expect(p.checkinNextEligible('buddy', 'trae-cn-a1b2')).toBeUndefined()
  })

  it('旧 dayNumber 值在**读盘那一层**就地迁移成时间戳（不是原样读成一个小数字）', () => {
    // 旧口径的 20_831 = 2027-01-26 前后的日数；迁移后必须是**毫秒时间戳**量级。
    const seeded = createMockContext([], { initialCheckins: { 'trae-cn:trae-cn-a1b2': 20_831 } })
    const p = new AccountPool(seeded as never)
    const migrated = p.checkinNextEligible('trae-cn', 'trae-cn-a1b2')!
    expect(migrated).toBeGreaterThan(1_000_000_000_000)
    // 迁移结果与纯函数同值（不是另一套算法）。
    expect(migrated).toBe(migrateLegacyCheckinDay(20_831, 'trae-cn'))
  })

  it('旧 dayNumber 迁移到 qoder-cn 时按 10 点算（不是按 0 点）', () => {
    const seeded = createMockContext([], { initialCheckins: { 'qoder-cn:q1': 20_831 } })
    const p = new AccountPool(seeded as never)
    const migrated = p.checkinNextEligible('qoder-cn', 'q1')!
    expect(migrated).toBe(migrateLegacyCheckinDay(20_831, 'qoder-cn'))
    // 落在本地 10 点整。
    expect(new Date(migrated).getHours()).toBe(10)
  })

  it('旧文档（无 checkins 字段）读入时补空对象，不抛错、不崩', async () => {
    // 手工构造缺 checkins 的 settings 值（0.1.x 老配置没有第五字段）。
    const p = new AccountPool(createMockContext([makeMockAccount()], { initialSchemaVersion: 1 }) as never)
    expect(p.checkinNextEligible('buddy-cn', 'buddy-001')).toBeUndefined()
    // 老配置（没有任何 checkins 键）读写新字段后，再次读仍是同一份权威副本。
    const nextEligible = Date.now() + 1000
    await p.writeCheckinNextEligible('buddy-cn', 'buddy-001', nextEligible)
    expect(p.checkinNextEligible('buddy-cn', 'buddy-001')).toBe(nextEligible)
  })

  it('removeAccount 顺带清掉该账号的孤儿 checkins 键（provider:accountId 精确键）', async () => {
    const a = Date.now() + 10_000
    const b = Date.now() + 20_000
    await pool.writeCheckinNextEligible('trae-cn', 'trae-cn-x', a)
    await pool.writeCheckinNextEligible('trae-cn', 'trae-cn-y', b)
    await pool.addAccount(makeMockAccount({ id: 'trae-cn-x', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_X' }))
    await pool.addAccount(makeMockAccount({ id: 'trae-cn-y', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_Y' }))
    await pool.removeAccount('trae-cn-x')
    expect(pool.checkinNextEligible('trae-cn', 'trae-cn-x')).toBeUndefined()
    expect(pool.checkinNextEligible('trae-cn', 'trae-cn-y')).toBe(b)
    // 删除的键真的不复存在（而不是被覆盖成空表丢了 y —— 互带不允许丢）
    expect(pool.checkinNextEligible('trae-cn', 'trae-cn-y')).toBe(b)
  })

  it('pruneOrphanCheckins 按 provider 前缀清除不在账号列表里的孤儿键', async () => {
    await pool.addAccount(makeMockAccount({ id: 'a', provider: 'buddy-cn', credentialRef: 'B1' }))
    const keep = Date.now() + 10_000
    await pool.writeCheckinNextEligible('buddy-cn', 'a', keep)
    await pool.writeCheckinNextEligible('buddy-cn', 'gone', Date.now() + 20_000)   // 孤儿
    const other = Date.now() + 30_000
    await pool.writeCheckinNextEligible('codearts', 'c-keep', other) // 别的 provider，不该被清
    await pruneOrphanCheckins(pool, 'buddy-cn')
    expect(pool.checkinNextEligible('buddy-cn', 'a')).toBe(keep)
    expect(pool.checkinNextEligible('buddy-cn', 'gone')).toBeUndefined()
    expect(pool.checkinNextEligible('codearts', 'c-keep')).toBe(other)
  })

  /** 无账号 provider：prune 返回不炸，且一个键都不清（无账号跳过）。 */
  it('无账号时 pruneOrphanCheckins 跳过（不清任何键）', async () => {
    const a = Date.now() + 10_000
    const gone = Date.now() + 20_000
    await pool.writeCheckinNextEligible('buddy-cn', 'a', a)
    await pool.writeCheckinNextEligible('buddy-cn', 'gone', gone)
    await pruneOrphanCheckins(pool, 'buddy-cn')
    expect(pool.checkinNextEligible('buddy-cn', 'a')).toBe(a)
    expect(pool.checkinNextEligible('buddy-cn', 'gone')).toBe(gone)
  })

  it('配置文件里的脏 checkins 值被忽略而不是抛错', () => {
    const seeded = createMockContext([], {
      initialCheckins: {
        // `12` 是旧口径的日数 ⇒ 会被**迁移**（不是原样读回），故这里断言它落在
        // 时间戳量级；下面三个脏值应整个消失。
        'trae-cn:ok': 12,
        'trae-cn:str': '12',
        'trae-cn:nan': Number.NaN,
        'trae-cn:obj': { x: 1 },
      } as never,
    })
    const p = new AccountPool(seeded as never)
    expect(p.checkinNextEligible('trae-cn', 'ok')).toBe(migrateLegacyCheckinDay(12, 'trae-cn'))
    expect(p.checkinNextEligible('trae-cn', 'str')).toBeUndefined()
    expect(p.checkinNextEligible('trae-cn', 'nan')).toBeUndefined()
    expect(p.checkinNextEligible('trae-cn', 'obj')).toBeUndefined()
  })

  it('九件套互带：写账号只带 checkins，不抹黑名单 / 预算 / 版本号', async () => {
    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)
    await pool.writeContextBudget('buddy-cn', 'glm-5.2', 200_000)
    const nextEligible = Date.now() + 9_000
    await pool.writeCheckinNextEligible('buddy-cn', 'buddy-001', nextEligible)
    await pool.addAccount(makeMockAccount())
    const last = ctx.replacePayloads.at(-1)!
    expect(last.accounts).toBeDefined()
    expect(last.disabledModels).toEqual({ 'buddy-cn': { 'glm-5.2': true } })
    expect(last.contextBudgets).toEqual({ 'buddy-cn': { 'glm-5.2': 200_000 } })
    expect(last.schemaVersion).toBe(0)
    expect(last.checkins).toEqual({ 'buddy-cn:buddy-001': nextEligible })
  })
})
