/**
 * provider 改名一次性迁移的回归测试（`src/provider-rename-migration.ts`）。
 *
 * ## 这个文件守的是什么
 *
 * 改名（`buddy`→`buddy-cn` / `workbuddy`→`buddy`）落在三处**持久化数据**上，
 * 任何一处漏搬都会让用户看到「账号凭空消失」或「凭据互相覆盖」。这里用一个
 * 内存版 settings + credentials 复刻真实存储语义（`replace()` 整体替换、
 * 凭据可 unset），逐条锁死六个安全语义：
 *
 * 1. **撞名守卫** —— 新国际版目标前缀 `BUDDY_ACCOUNT_*` == 旧中国版现有前缀
 *    （同名不同义）。迁移必须**先让中国版让位、再让国际版搬入**，且冲突时
 *    绝不覆盖、绝不删旧。
 * 2. **幂等** —— 连跑两次，第二次零写入。
 * 3. **中断重入** —— 只搬完中国版就中断，重跑能补完国际版且数据无损。
 * 4. **`modelRateLimits` 逐字保留** —— 它是毫秒时间戳表，不能被迁移「顺手重建」。
 * 5. **`disabledModels` 对调搬运** —— `buddy`/`workbuddy` 两键互换目的地，
 *    第三个 provider（`lobsterai`）必须不受影响。
 * 6. **`schemaVersion` short-circuit** —— 版本号已达标时整体跳过。
 *
 * 另外锁死账号 id 改名与单凭据 ref 迁移（含本机不存在的 no-op 情形）。
 */

import { describe, expect, it, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AccountPool, ACCOUNT_HUB_SCHEMA_VERSION } from '../../src/account-pool.js'
import {
  PROVIDER_RENAME_MAP,
  migrateProviderNames,
  renameCredentialRef,
  resetMigrationProcessFlagForTest,
} from '../../src/provider-rename-migration.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 一条账号夹具（默认形态为中国版，可由 overrides 改成国际版）。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'buddy-00000001',
    provider: 'buddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'BUDDY_ACCOUNT_00000001',
    createdAt: 1_700_000_000_000,
    refreshable: true,
    ...overrides,
  }
}

/**
 * 内存版宿主替身：settings 的 replace 是**整体替换**（与真实实现一致），
 * credentials 可 resolve/set/unset，且能注入只读源（set 抛错）。
 *
 * @param seed - 初始 settings 值与凭据。
 */
function makeHarness(seed: {
  accounts?: ProviderAccountEntry[]
  disabledModels?: Record<string, Record<string, boolean>>
  schemaVersion?: number
  credentials?: Record<string, string>
  /** 设为 true 时 `credentials.set` 一律抛错，模拟只读 shadow 源。 */
  readOnlyCredentials?: boolean
}) {
  let stored: Record<string, unknown> = {
    accounts: seed.accounts ?? [],
    disabledModels: seed.disabledModels ?? {},
    ...seed.schemaVersion === undefined ? {} : { schemaVersion: seed.schemaVersion },
  }
  const credentials = new Map<string, string>(Object.entries(seed.credentials ?? {}))
  /** 每次 replace 的完整载荷，用于断言「版本号/黑名单没被漏写」。 */
  const replacePayloads: Array<Record<string, unknown>> = []
  const errors: string[] = []

  const settings = {
    register: () => ({
      get: () => stored,
      replace: async (value: Record<string, unknown>) => {
        stored = value
        replacePayloads.push(value)
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }

  const ctx = {
    get: (key: string) => (key === 'settings' ? settings : undefined),
    logger: {
      warn: () => {},
      info: () => {},
      error: (message: string) => { errors.push(message) },
    },
    credentials: {
      resolve: async (ref: unknown) => {
        const value = credentials.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' as const }
      },
      set: async (ref: unknown, value: string) => {
        if (seed.readOnlyCredentials === true) {
          throw new Error('credential source is read-only')
        }
        credentials.set(String(ref), value)
      },
      unset: async (ref: unknown) => { credentials.delete(String(ref)) },
      describe: async (ref: unknown) => ({
        configured: credentials.has(String(ref)), source: 'test' as const, writable: true,
      }),
    },
  } as unknown as Context

  return {
    ctx,
    replacePayloads,
    errors,
    credentials,
    /** 当前落盘的 settings 值（迁移后核对用）。 */
    stored: () => stored,
    refs: () => [...credentials.keys()].sort(),
  }
}

/** 建一个真 `AccountPool`（读 settings 快照，与生产路径一致）。 */
function makePool(ctx: Context): AccountPool {
  return new AccountPool(ctx)
}

beforeEach(() => {
  // 模块级「本进程已跑」标记会跨用例残留，必须每次重置。
  resetMigrationProcessFlagForTest()
})

describe('renameCredentialRef —— 前缀换算规则', () => {
  it('账号 ref 与国际版/中国版两族前缀都正确换算', () => {
    // 旧中国版：BUDDY_* → BUDDY_CN_*
    expect(renameCredentialRef('BUDDY_ACCOUNT_7B0C71B1')).toBe('BUDDY_CN_ACCOUNT_7B0C71B1')
    expect(renameCredentialRef('BUDDY_ACCESS_TOKEN')).toBe('BUDDY_CN_ACCESS_TOKEN')
    // 旧国际版：WORKBUDDY_* → BUDDY_*
    expect(renameCredentialRef('WORKBUDDY_ACCOUNT_208D9DB2')).toBe('BUDDY_ACCOUNT_208D9DB2')
    expect(renameCredentialRef('WORKBUDDY_ACCESS_TOKEN')).toBe('BUDDY_ACCESS_TOKEN')
  })

  it('无规则命中的 ref 返回 undefined（不猜）', () => {
    expect(renameCredentialRef('LOBSTERAI_ACCOUNT_X')).toBeUndefined()
    expect(renameCredentialRef('CODEARTS_ACCESS_TOKEN')).toBeUndefined()
    expect(renameCredentialRef('')).toBeUndefined()
  })

  it('换算结果始终是合法的 credential ref 形状（连字符已由 provider 前缀归一化）', () => {
    // BUDDY_CN_ACCOUNT_* 不含连字符 —— 这正是 provider id 带连字符时必须
    // 折成下划线的原因（`credentialRef()` 的 REF_PATTERN 不接受 `-`）。
    for (const ref of [
      'BUDDY_ACCOUNT_A', 'BUDDY_ACCESS_TOKEN',
      'WORKBUDDY_ACCOUNT_B', 'WORKBUDDY_ACCESS_TOKEN',
    ]) {
      expect(renameCredentialRef(ref)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })
})

describe('migrateProviderNames —— 完整迁移', () => {
  it('账号的 provider / credentialRef / id 三项一起改写，凭据本体跟着搬', async () => {
    const h = makeHarness({
      accounts: [
        makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' }),
        makeEntry({
          id: 'workbuddy-208d9db2', provider: 'workbuddy',
          credentialRef: 'WORKBUDDY_ACCOUNT_208D9DB2', nickname: '国际号',
        }),
        makeEntry({
          id: 'lobsterai-aaa', provider: 'lobsterai',
          credentialRef: 'LOBSTERAI_ACCOUNT_AAA', nickname: '龙虾',
        }),
      ],
      credentials: {
        BUDDY_ACCOUNT_7B0C71B1: '{"access_token":"CN"}',
        WORKBUDDY_ACCOUNT_208D9DB2: '{"access_token":"INTL"}',
        LOBSTERAI_ACCOUNT_AAA: '{"access_token":"LOB"}',
      },
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.shortCircuited).toBe(false)
    expect(report.accountsRenamed).toBe(2)
    expect(report.accountsSkipped).toBe(0)
    expect(report.refsMoved).toBe(2)

    const accounts = (h.stored().accounts as ProviderAccountEntry[])
    expect(accounts).toEqual([
      expect.objectContaining({
        id: 'buddy-cn-7b0c71b1', provider: 'buddy-cn', credentialRef: 'BUDDY_CN_ACCOUNT_7B0C71B1',
      }),
      expect.objectContaining({
        id: 'buddy-208d9db2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_208D9DB2',
      }),
      // 未命中映射的 provider 原样保留（连对象内容都不动）。
      expect.objectContaining({
        id: 'lobsterai-aaa', provider: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_AAA',
      }),
    ])

    // 凭据：旧 ref 全部清空，新 ref 带上原值。**没有互相覆盖**。
    expect(h.refs()).toEqual([
      'BUDDY_ACCOUNT_208D9DB2', 'BUDDY_CN_ACCOUNT_7B0C71B1', 'LOBSTERAI_ACCOUNT_AAA',
    ])
    expect(h.credentials.get('BUDDY_CN_ACCOUNT_7B0C71B1')).toBe('{"access_token":"CN"}')
    expect(h.credentials.get('BUDDY_ACCOUNT_208D9DB2')).toBe('{"access_token":"INTL"}')
    // 版本号已落盘。
    expect(h.stored().schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
  })

  it('单凭据 ref 一起迁移（BUDDY_ACCESS_TOKEN→BUDDY_CN_ACCESS_TOKEN、WORKBUDDY_ACCESS_TOKEN→BUDDY_ACCESS_TOKEN）', async () => {
    const h = makeHarness({
      accounts: [],
      credentials: {
        BUDDY_ACCESS_TOKEN: '{"access_token":"CN"}',
        WORKBUDDY_ACCESS_TOKEN: '{"access_token":"INTL"}',
      },
    })
    // 单凭据没有账号条目，故走的是「同前缀替换」：直接改 ref 名。
    // 这条路径由 replaceAll 之外的 moveRef 承担 —— 通过一条指向它们的
    // 账号条目驱动，确保覆盖真实调用链。
    const pool = makePool(h.ctx)
    await pool.addAccount(makeEntry({ id: 'legacy-1', provider: 'buddy', credentialRef: 'BUDDY_ACCESS_TOKEN' }))
    await pool.addAccount(makeEntry({
      id: 'legacy-2', provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCESS_TOKEN',
    }))

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.refsMoved).toBe(2)
    expect(h.credentials.get('BUDDY_CN_ACCESS_TOKEN')).toBe('{"access_token":"CN"}')
    expect(h.credentials.get('BUDDY_ACCESS_TOKEN')).toBe('{"access_token":"INTL"}')
    expect(h.refs()).toEqual(['BUDDY_ACCESS_TOKEN', 'BUDDY_CN_ACCESS_TOKEN'])
  })

  it('本机不存在单凭据时是 no-op（不凭空造 ref）', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'legacy-1', credentialRef: 'BUDDY_ACCESS_TOKEN' })],
      credentials: {}, // 单凭据从未配置
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    // 账号条目照常改名（provider/id/ref 三项），但凭据一次都没搬。
    expect(report.accountsRenamed).toBe(1)
    expect(report.refsMoved).toBe(0)
    expect(report.refsSkipped).toBe(1)
    expect(h.credentials.size).toBe(0)
    expect((h.stored().accounts as ProviderAccountEntry[])[0]!.credentialRef).toBe('BUDDY_CN_ACCESS_TOKEN')
  })

  it('modelRateLimits 等未被触碰的字段逐字保留', async () => {
    const limits = { 'glm-5.2': 1_789_000_000_000, 'deepseek-v4.1-flash': 1_789_100_000_000 }
    const h = makeHarness({
      accounts: [
        makeEntry({
          id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1',
          modelRateLimits: limits, expiresAt: 1_788_000_000_000,
        }),
      ],
      credentials: { BUDDY_ACCOUNT_7B0C71B1: '{"access_token":"CN"}' },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    const entry = (h.stored().accounts as ProviderAccountEntry[])[0]!
    // 深比较：迁移是「展开 + 覆盖三个字段」，其余字段连引用语义都应保留。
    expect(entry.modelRateLimits).toEqual(limits)
    expect(entry.expiresAt).toBe(1_788_000_000_000)
    expect(entry.createdAt).toBe(1_700_000_000_000)
    expect(entry.refreshable).toBe(true)
    expect(entry.enabled).toBe(true)
  })
})

describe('migrateProviderNames —— 撞名守卫（本模块最关键的不变量）', () => {
  it('中国版先让位、国际版后搬入：两个产品的凭据绝不落在同一前缀下', async () => {
    // 这是最容易写反的地方：若先搬国际版，它的目标 BUDDY_ACCOUNT_X 会与
    // 中国版现有的 BUDDY_ACCOUNT_Y 同前缀；随后中国版那趟会把国际版刚写下的
    // 那份凭据当成自己的源搬走（甚至 unset 掉）。
    const h = makeHarness({
      accounts: [
        makeEntry({ id: 'buddy-cn-a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_CNONLY' }),
        makeEntry({
          id: 'workbuddy-b', provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_INTLONLY',
        }),
      ],
      credentials: {
        BUDDY_ACCOUNT_CNONLY: 'CN-VALUE',
        WORKBUDDY_ACCOUNT_INTLONLY: 'INTL-VALUE',
      },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    const byRef = Object.fromEntries(h.credentials)
    expect(byRef).toEqual({
      BUDDY_CN_ACCOUNT_CNONLY: 'CN-VALUE',
      BUDDY_ACCOUNT_INTLONLY: 'INTL-VALUE',
    })
    // 两个产品的凭据值互不串台 —— 这是「先让位」的直接证据。
    expect(byRef.BUDDY_CN_ACCOUNT_CNONLY).toBe('CN-VALUE')
    expect(byRef.BUDDY_ACCOUNT_INTLONLY).toBe('INTL-VALUE')
  })

  it('目标 ref 已存在且值不同 → 记冲突、不覆盖、不删旧，该账号条目整体保留原样', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: {
        BUDDY_ACCOUNT_7B0C71B1: 'OLD-VALUE',
        // 目标已存在且值**不同**（例如用户手工在两个 ref 下写过不同凭据）。
        BUDDY_CN_ACCOUNT_7B0C71B1: 'SOMEONE-ELSE',
      },
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.refsConflicted).toBe(1)
    expect(report.accountsSkipped).toBe(1)
    expect(report.accountsRenamed).toBe(0)
    // 绝不覆盖目标：它仍是原值。
    expect(h.credentials.get('BUDDY_CN_ACCOUNT_7B0C71B1')).toBe('SOMEONE-ELSE')
    // 绝不删旧的：旧 ref 与值都在。
    expect(h.credentials.get('BUDDY_ACCOUNT_7B0C71B1')).toBe('OLD-VALUE')
    // 冲突时账号条目**整体保留原样** —— 半迁移（条目指向新 ref 而凭据还在旧 ref）
    // 比不迁移更糟：账号会在新命名下彻底不可用。
    expect((h.stored().accounts as ProviderAccountEntry[])[0]).toEqual(
      expect.objectContaining({ provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' }),
    )
    // 冲突必须显式点名（两个 ref 全名），不能静默。
    expect(h.errors.some(e => e.includes('BUDDY_ACCOUNT_7B0C71B1'))).toBe(true)
    expect(h.errors.some(e => e.includes('BUDDY_CN_ACCOUNT_7B0C71B1'))).toBe(true)
  })

  it('目标 ref 已存在但值相同 → 视为已搬移完成（补删旧 ref），不报冲突', async () => {
    // 场景：上一次迁移写成功了，但在 unset 之前进程退出。重跑必须能收敛。
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: {
        BUDDY_ACCOUNT_7B0C71B1: 'SAME-VALUE',
        BUDDY_CN_ACCOUNT_7B0C71B1: 'SAME-VALUE',
      },
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.refsConflicted).toBe(0)
    expect(report.refsMoved).toBe(1)
    expect(report.accountsRenamed).toBe(1)
    expect(h.refs()).toEqual(['BUDDY_CN_ACCOUNT_7B0C71B1'])
  })

  it('只读凭据源（set 抛错）→ 保留旧 ref、条目不改名、不删任何凭据', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: { BUDDY_ACCOUNT_7B0C71B1: 'CN-VALUE' },
      readOnlyCredentials: true,
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.refsFailed).toBe(1)
    expect(report.accountsSkipped).toBe(1)
    // 旧凭据仍在（不能被 unset）——否则用户凭据直接丢失。
    expect(h.credentials.get('BUDDY_ACCOUNT_7B0C71B1')).toBe('CN-VALUE')
    expect((h.stored().accounts as ProviderAccountEntry[])[0]!.credentialRef).toBe('BUDDY_ACCOUNT_7B0C71B1')
  })

  it('provider 命中映射但 ref 形态不符 → 不猜、原样保留并点名警告', async () => {
    // 配置文件可能被手工编辑过：一条标了 buddy 却写着 LOBSTERAI_* 的脏条目，
    // 若按 provider 硬改会凭空造出一个指向别家凭据的账号。
    const h = makeHarness({
      accounts: [makeEntry({ id: 'dirty-1', provider: 'buddy', credentialRef: 'LOBSTERAI_ACCOUNT_X' })],
      credentials: { LOBSTERAI_ACCOUNT_X: 'LOB' },
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.accountsRenamed).toBe(0)
    const entry = (h.stored().accounts as ProviderAccountEntry[])[0]!
    expect(entry.provider).toBe('buddy')
    expect(entry.credentialRef).toBe('LOBSTERAI_ACCOUNT_X')
    expect(h.credentials.get('LOBSTERAI_ACCOUNT_X')).toBe('LOB')
  })
})

describe('migrateProviderNames —— 幂等与 short-circuit', () => {
  it('schemaVersion 已达标 → 整体跳过，零写入', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-cn-a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_X' })],
      credentials: { BUDDY_ACCOUNT_X: 'CN' },
      schemaVersion: ACCOUNT_HUB_SCHEMA_VERSION,
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.shortCircuited).toBe(true)
    expect(report.wrote).toBe(false)
    // 一次 replace 都没发。
    expect(h.replacePayloads).toHaveLength(0)
    // 数据一动不动（即使它看起来是「旧命名」—— 版本号才是权威判据）。
    expect((h.stored().accounts as ProviderAccountEntry[])[0]!.provider).toBe('buddy')
    expect(h.credentials.get('BUDDY_ACCOUNT_X')).toBe('CN')
  })

  it('连跑两次：第二次因版本号 short-circuit，零写入', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: { BUDDY_ACCOUNT_7B0C71B1: 'CN' },
    })
    const pool = makePool(h.ctx)

    const first = await migrateProviderNames(pool, h.ctx)
    expect(first.shortCircuited).toBe(false)
    expect(first.wrote).toBe(true)
    const writesAfterFirst = h.replacePayloads.length
    const refsAfterFirst = h.refs()

    // 第二次：同一 pool（schemaVersion 已由 replaceAll 更新到进程内副本）。
    const second = await migrateProviderNames(pool, h.ctx)

    expect(second.shortCircuited).toBe(true)
    expect(second.wrote).toBe(false)
    expect(h.replacePayloads).toHaveLength(writesAfterFirst)
    expect(h.refs()).toEqual(refsAfterFirst)
  })

  it('无待迁移数据时仍落一次版本号（否则每次启动都要重扫）', async () => {
    const h = makeHarness({ accounts: [], disabledModels: {} })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.shortCircuited).toBe(false)
    expect(report.wrote).toBe(true)
    expect(report.accountsRenamed).toBe(0)
    expect(h.stored().schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
  })

  it('中断重入：只搬完中国版就中断，重跑能补完国际版且数据无损', async () => {
    // 复刻「第一趟跑完、第二趟之前进程退出」的中间态：
    // 中国版已改名 + 凭据已搬，国际版还是旧命名，版本号仍是 0。
    const h = makeHarness({
      accounts: [
        makeEntry({
          id: 'buddy-cn-7b0c71b1', provider: 'buddy-cn',
          credentialRef: 'BUDDY_CN_ACCOUNT_7B0C71B1', modelRateLimits: { 'glm-5.2': 123 },
        }),
        makeEntry({
          id: 'workbuddy-208d9db2', provider: 'workbuddy',
          credentialRef: 'WORKBUDDY_ACCOUNT_208D9DB2', modelRateLimits: { 'gpt-5.5': 456 },
        }),
      ],
      credentials: {
        BUDDY_CN_ACCOUNT_7B0C71B1: 'CN-VALUE',
        WORKBUDDY_ACCOUNT_208D9DB2: 'INTL-VALUE',
      },
      schemaVersion: 0,
    })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    // 中国版那趟已无匹配（幂等），国际版那趟补完。
    expect(report.accountsRenamed).toBe(1)
    expect(report.refsMoved).toBe(1)
    const accounts = (h.stored().accounts as ProviderAccountEntry[])
    expect(accounts[0]).toEqual(expect.objectContaining({
      provider: 'buddy-cn', credentialRef: 'BUDDY_CN_ACCOUNT_7B0C71B1',
      modelRateLimits: { 'glm-5.2': 123 },
    }))
    expect(accounts[1]).toEqual(expect.objectContaining({
      provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_208D9DB2',
      modelRateLimits: { 'gpt-5.5': 456 },
    }))
    expect(h.credentials.get('BUDDY_CN_ACCOUNT_7B0C71B1')).toBe('CN-VALUE')
    expect(h.credentials.get('BUDDY_ACCOUNT_208D9DB2')).toBe('INTL-VALUE')
  })

  it('本进程已跑过 → 第二次调用 short-circuit（apply 热重载重入保护）', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: { BUDDY_ACCOUNT_7B0C71B1: 'CN' },
    })
    const pool = makePool(h.ctx)
    await migrateProviderNames(pool, h.ctx)

    // 换一个**全新**的池（版本号回到 0，模拟热重载后重建），
    // 但同进程标记仍在 → 不再访问凭据存储。
    const h2 = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      credentials: { BUDDY_ACCOUNT_7B0C71B1: 'CN' },
    })
    const report = await migrateProviderNames(makePool(h2.ctx), h2.ctx)

    expect(report.shortCircuited).toBe(true)
    expect(h2.replacePayloads).toHaveLength(0)
  })
})

describe('migrateProviderNames —— disabledModels 对调搬运', () => {
  it('两个旧键的目的地对调，且第三个 provider 完全不受影响', async () => {
    const h = makeHarness({
      accounts: [],
      disabledModels: {
        // 旧 buddy = 中国版 → 新 buddy-cn
        buddy: { 'glm-5.2': true, 'hy3': true },
        // 旧 workbuddy = 国际版 → 新 buddy
        workbuddy: { 'gpt-5.5': true, 'gemini-3.5-flash': true },
        // 未命中映射：原样保留
        lobsterai: { 'glm-5.3': true },
        codearts: { 'glm-5.3-flash': true },
        'trae-cn': { 'gpt-5.4': true },
      },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    expect(h.stored().disabledModels).toEqual({
      'buddy-cn': { 'glm-5.2': true, 'hy3': true },
      buddy: { 'gpt-5.5': true, 'gemini-3.5-flash': true },
      lobsterai: { 'glm-5.3': true },
      codearts: { 'glm-5.3-flash': true },
      'trae-cn': { 'gpt-5.4': true },
    })
  })

  it('目标键已存在（迁移跑过一半 / 用户手工写过）→ 保留既有值，不覆盖', async () => {
    const h = makeHarness({
      accounts: [],
      disabledModels: {
        // 旧键仍在（说明这一趟还没跑完）……
        buddy: { 'glm-5.2': true },
        // ……但用户已经在新键下改过开关 → 以用户的新值为准。
        'buddy-cn': { 'hy3': true },
      },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    expect(h.stored().disabledModels).toEqual({ 'buddy-cn': { 'hy3': true } })
  })

  it('两键对调时不会互相覆盖（buddy 与 workbuddy 同时存在）', async () => {
    // 这是「对调」最尖锐的用例：两个源键都非空，若实现按 dict 展开顺序
    // 逐条写入，后写的会把先写的目标键覆盖掉。
    const h = makeHarness({
      accounts: [],
      disabledModels: {
        buddy: { cn: true },
        workbuddy: { intl: true },
      },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    expect(h.stored().disabledModels).toEqual({
      'buddy-cn': { cn: true },
      buddy: { intl: true },
    })
  })

  it('没有黑名单时迁移不报错，且落盘仍是空表', async () => {
    const h = makeHarness({ accounts: [] })
    const pool = makePool(h.ctx)

    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.disabledModelsRenamed).toBe(0)
    expect(h.stored().disabledModels).toEqual({})
  })
})

describe('迁移与存储契约', () => {
  it('一次 replace 同时携带账号 / 黑名单 / 上下文预算 / 版本号（九件套都不丢）', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-7b0c71b1', credentialRef: 'BUDDY_ACCOUNT_7B0C71B1' })],
      disabledModels: { buddy: { 'glm-5.2': true } },
      credentials: { BUDDY_ACCOUNT_7B0C71B1: 'CN' },
    })
    const pool = makePool(h.ctx)

    await migrateProviderNames(pool, h.ctx)

    // 原子写：恰好一次 replace（不是「先写账号、再写黑名单」两趟）。
    expect(h.replacePayloads).toHaveLength(1)
    const payload = h.replacePayloads[0]!
    // `contextBudgets`（Trae CN 的 dev / Max 档位）**不是迁移对象**，但同属这个
    // namespace，故必须原样随写带上 —— 漏带会让改名迁移顺手清空用户的档位选择。
    // `consumption` / `consumptionCursors`（消耗顺序 / 切换粒度 / 遍历游标）同理：
    // 它们比改名迁移更晚加入，同样不是迁移对象，同样必须随写带上，
    // 否则一次「provider 改名」就会把用户配好的消耗顺序与轮转进度一并清零。
    // `providerAuditVersion`（provider 体检闸门）是最新一件：漏带会让体检在
    // 每次启动重跑（体检幂等，症状只是噪音，但那正是「闸门形同虚设」）。
    // `autoRoute`（自动路由配置）同理：漏带会让用户配好的自动模型在一次 provider
    // 改名后整组消失，且完全没有报错。
    expect(Object.keys(payload).sort()).toEqual([
      'accounts', 'autoRoute', 'checkins', 'consumption', 'consumptionCursors',
      'contextBudgets', 'disabledModels', 'providerAuditVersion', 'schemaVersion',
    ])
    expect(payload.schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
  })

  it('写账号不会把版本号重置为 0（否则迁移每次启动都重跑）', async () => {
    const h = makeHarness({
      accounts: [],
      credentials: {},
      schemaVersion: ACCOUNT_HUB_SCHEMA_VERSION,
    })
    const pool = makePool(h.ctx)

    await pool.addAccount(makeEntry({ id: 'buddy-cn-new', provider: 'buddy-cn' }))

    expect(h.stored().schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
    expect((h.stored().accounts as ProviderAccountEntry[])).toHaveLength(1)
  })

  it('写黑名单不会把版本号重置为 0', async () => {
    const h = makeHarness({ accounts: [], schemaVersion: ACCOUNT_HUB_SCHEMA_VERSION })
    const pool = makePool(h.ctx)

    await pool.setModelDisabled('buddy-cn', 'glm-5.2', true)

    expect(h.stored().schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
    expect(pool.schemaVersion).toBe(ACCOUNT_HUB_SCHEMA_VERSION)
  })

  it('pool.allDisabledModels() 返回浅拷贝（改它不影响池内副本）', async () => {
    const h = makeHarness({
      accounts: [],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true } },
    })
    const pool = makePool(h.ctx)

    const snapshot = pool.allDisabledModels()
    snapshot['buddy-cn']!['glm-5.2'] = false
    snapshot.injected = { x: true }

    expect(pool.disabledModelsFor('buddy-cn').has('glm-5.2')).toBe(true)
    expect(pool.disabledModelsFor('injected').size).toBe(0)
  })
})

describe('PROVIDER_RENAME_MAP 顺序契约', () => {
  it('中国版（buddy）必须先于国际版（workbuddy）—— 这是撞名坑的硬约束', () => {
    // 顺序写反会让两个产品的凭据落在同一 `BUDDY_ACCOUNT_*` 前缀下。
    // 该断言把这条不变量钉在数据上，而不是靠注释提醒。
    expect(PROVIDER_RENAME_MAP).toEqual([
      { from: 'buddy', to: 'buddy-cn' },
      { from: 'workbuddy', to: 'buddy' },
    ])
  })

  it('映射的 to 值集合与 product.ts 的实际 provider id 一致', async () => {
    const { ALL_PRODUCTS } = await import('../../src/product.js')
    expect(PROVIDER_RENAME_MAP.map(m => m.to).sort()).toEqual(ALL_PRODUCTS.map(p => p.id).sort())
  })
})

describe('迁移失败不阻断启动', () => {
  it('listAllAccounts 抛错时只记 error，不向调用方抛出', async () => {
    const h = makeHarness({ accounts: [] })
    const pool = makePool(h.ctx)
    pool.listAllAccounts = async () => { throw new Error('settings 读取失败') }

    // 关键：不 reject。fire-and-forget 的调用方用的是 `void migrate(...)`，
    // 一旦这里抛出就会变成 unhandled rejection / 插件启动失败。
    const report = await migrateProviderNames(pool, h.ctx)

    expect(report.wrote).toBe(false)
    expect(h.errors.some(e => e.includes('settings 读取失败'))).toBe(true)
  })
})

/**
 * 启动顺序不变量：**域名审计必须跑在迁移之后**。
 *
 * 这两步都按 `entry.provider` 选账号，而 `buddy` 这个 id 前后指两个不同产品
 * （迁移前=中国版，迁移后=国际版）。若两者并行（例如都是 `void pool.xxx()`），
 * 审计会拿迁移**之前**的账号表去比对 `BUDDY.apiDomain`，把中国版账号
 * （domain=copilot.tencent.com）**误判**成「失配」。
 *
 * 保守语义下审计**不再删号**（只告警不删除），但误判仍会打出误导性警告，让用户
 * 误以为国际版账号出了问题。`src/index.ts` 因此把审计挂在迁移 Promise 的
 * `.then()` 里，避开在迁移之前的账号表上做判定的窗口。本用例锁死这条顺序在
 * 数据层的内核：乱序仍会误判（但绝不删号和凭据），正序则零误判。
 */
describe('启动顺序不变量：域名审计不能先于迁移', () => {
  /** 中国版账号：domain 指向 copilot.tencent.com。 */
  const cnCredential = JSON.stringify({
    access_token: 'CN', refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000), domain: 'copilot.tencent.com',
  })

  function seed() {
    return makeHarness({
      accounts: [
        makeEntry({ id: 'buddy-cn-a', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_CNA' }),
        makeEntry({
          id: 'workbuddy-b', provider: 'workbuddy',
          credentialRef: 'WORKBUDDY_ACCOUNT_INTLB', nickname: '国际号',
        }),
      ],
      credentials: {
        BUDDY_ACCOUNT_CNA: cnCredential,
        // 国际版账号：domain 正确指向 www.workbuddy.ai。
        WORKBUDDY_ACCOUNT_INTLB: JSON.stringify({
          access_token: 'INTL', refresh_token: 'RT',
          expires_at: String(Date.now() + 3_600_000), domain: 'www.workbuddy.ai',
        }),
      },
    })
  }

  it('反例（错误顺序）：审计先跑会把中国版账号误判成失配，但绝不再删号和凭据', async () => {
    const h = seed()
    const pool = makePool(h.ctx)
    const { BUDDY } = await import('../../src/product.js')

    // 模拟「并行」：迁移尚未落盘，审计先读到旧表。
    const flagged = await pool.pruneAccountsWithForeignDomain(BUDDY)

    // 迁移前的 `buddy` = 中国版，其 domain 与 BUDDY.apiDomain（国际版）不符 → 被误判。
    expect(flagged).toEqual(['buddy-cn-a'])
    // 保守语义兜底：**账号与凭据都保留**，不再发生数据丢失。
    expect(h.credentials.has('BUDDY_ACCOUNT_CNA')).toBe(true)
    expect((h.stored().accounts as ProviderAccountEntry[]).length).toBe(2)
  })

  it('正例（正确顺序）：迁移先跑，审计既不误判也不触碰中国版账号', async () => {
    const h = seed()
    const pool = makePool(h.ctx)
    const { BUDDY } = await import('../../src/product.js')

    // 与 src/index.ts 的 apply() 同序：迁移 → 审计。
    await migrateProviderNames(pool, h.ctx)
    const flagged = await pool.pruneAccountsWithForeignDomain(BUDDY)

    // 迁移后 `buddy` 只指国际版；中国版已改名 `buddy-cn`，不再被它选中 → 零误判。
    expect(flagged).toEqual([])
    // 两条账号与凭据都完好。
    expect(h.credentials.get('BUDDY_CN_ACCOUNT_CNA')).toBe(cnCredential)
    expect(h.credentials.has('BUDDY_ACCOUNT_INTLB')).toBe(true)
    const accounts = h.stored().accounts as ProviderAccountEntry[]
    expect(accounts.map(a => a.provider).sort()).toEqual(['buddy', 'buddy-cn'])
  })
})
