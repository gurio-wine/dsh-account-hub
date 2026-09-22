import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'
import { ACCOUNT_HUB_DOMAIN, emptyAccountHubDocument } from '../../src/account-hub-storage.js'
import { LEGACY_SETTINGS_NAMESPACE } from '../../src/account-hub-migration.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 双路径 AccountPool 的接线测试。
 *
 * 兼容矩阵（四条都必须绿）：
 *
 * | 运行环境 | storage | settings.register | 行为 |
 * |---|---|---|---|
 * | 0.1.6 | ✓ | ✓ | storage 为主 + 首次启动迁移 |
 * | 0.1.7 | ✓ | ✗ | storage 为主 + 首次启动迁移 |
 * | 旧环境 | ✗ | ✓ | 回退 settings 路径 |
 * | 都缺 | ✗ | ✗ | 纯内存降级 |
 */

const ACCOUNT: ProviderAccountEntry = {
  id: 'buddy-cn-001',
  provider: 'buddy-cn',
  nickname: '河童',
  enabled: true,
  credentialRef: 'BUDDY_CN_ACCOUNT_T1',
  createdAt: 1_789_000_000_000,
  refreshable: true,
}

const SECOND: ProviderAccountEntry = {
  ...ACCOUNT,
  id: 'qoder-002',
  provider: 'qoder',
  credentialRef: 'QODER_ACCOUNT_T1',
}

/** 内存 storage 域：语义与 DSH 的一致（读同步自权威内存态，写在落盘后更新）。 */
function createMockStorage(initial?: Record<string, unknown>) {
  let global: unknown = initial ?? null
  const writes: Array<Record<string, unknown>> = []
  return {
    read: () => global,
    writes,
    get current() { return global },
    storage: {
      read: () => {
        const raw = global
        if (typeof raw !== 'object' || raw === null) return emptyAccountHubDocument()
        const value = raw as Record<string, unknown>
        return {
          accounts: Array.isArray(value.accounts) ? value.accounts : [],
          disabledModels: (value.disabledModels ?? {}) as Record<string, Record<string, boolean>>,
          contextBudgets: (value.contextBudgets ?? {}) as Record<string, Record<string, number>>,
          schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 0,
        }
      },
      write: async (doc: Record<string, unknown>) => {
        const snapshot = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
        writes.push(snapshot)
        global = snapshot
      },
      hasAccounts: () => {
        const raw = global
        return typeof raw === 'object' && raw !== null
          && Array.isArray((raw as { accounts?: unknown }).accounts)
          && ((raw as { accounts: unknown[] }).accounts).length > 0
      },
    },
  }
}

/**
 * MockContext：可分别开关 storage 与 settings.register。
 *
 * `openStorage` 由测试显式调用，与生产一致（`apply()` 里 await 一次）。
 */
function createMockContext(options: {
  storage?: ReturnType<typeof createMockStorage>['storage']
  storageOpenThrows?: boolean
  settings?: boolean
  initialSettings?: Record<string, unknown>
  homePath?: string
} = {}) {
  const settingsValue = options.initialSettings
    ?? { accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 }
  const replacePayloads: Array<Record<string, unknown>> = []
  const mockSettings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => settingsValue,
      replace: async (value: Record<string, unknown>) => { replacePayloads.push(value) },
    }),
    describe: () => [{ ns: LEGACY_SETTINGS_NAMESPACE, value: settingsValue }],
  }
  const warnings: string[] = []
  const facility = options.storage === undefined ? undefined : {
    open: async () => {
      if (options.storageOpenThrows) throw new Error('backend-not-found: json')
      return { global: {
        get: () => options.storage!.read(),
        set: async (value: unknown) => { await options.storage!.write(value as Record<string, unknown>) },
      } }
    },
  }
  const ctx = {
    logger: {
      warn: (m: string) => warnings.push(m),
      info: () => {},
      error: () => {},
    },
    warnings,
    replacePayloads,
    get: (key: string) => {
      if (key === 'storageDomain') return facility
      if (key === 'settings') return options.settings === false ? undefined : mockSettings
      return undefined
    },
    // home 解析走宿主服务（两版 DSH 都用 `ctx.provide('dshHomePath', …)` 暴露）。
    dshHomePath: (...segments: string[]) => join(options.homePath ?? '/nonexistent-home', ...segments),
  }
  return ctx
}

describe('AccountPool × storage —— storage 为主', () => {
  it('storage 有数据时从 storage 读，settings 里的旧数据不参与', async () => {
    const mock = createMockStorage({
      accounts: [ACCOUNT],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true } },
      contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000 } },
      schemaVersion: 1,
    })
    const ctx = createMockContext({
      storage: mock.storage,
      initialSettings: { accounts: [SECOND], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 },
    })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([ACCOUNT.id])
    expect(pool.disabledModelsFor('buddy-cn').has('glm-5.2')).toBe(true)
    expect(pool.contextBudget('buddy-cn', 'glm-5.2')).toBe(300_000)
    expect(pool.schemaVersion).toBe(1)
  })

  it('storage 是加载源：schemeVersion 从 storage 读出（改名迁移闸门靠它）', async () => {
    const mock = createMockStorage({ accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 1 })
    const ctx = createMockContext({ storage: mock.storage })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    expect(pool.schemaVersion).toBe(1)
  })

  it('写入走 storage 的 global.set，且一次写入包含四件套', async () => {
    const mock = createMockStorage()
    const ctx = createMockContext({ storage: mock.storage })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    await pool.addAccount(ACCOUNT)
    expect(mock.writes).toHaveLength(1)
    expect(mock.writes[0]).toEqual({
      accounts: [ACCOUNT],
      disabledModels: {},
      contextBudgets: {},
      schemaVersion: 0,
    })
    // 一次都不该碰 settings 路径（storage 可用时它是唯一写源）
    expect(ctx.replacePayloads).toHaveLength(0)
  })

  it('storage 可用时 settings 的 replace 一次都不被调用（不是双写）', async () => {
    const mock = createMockStorage()
    const ctx = createMockContext({ storage: mock.storage })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    await pool.addAccount(ACCOUNT)
    await pool.removeAccount(ACCOUNT.id)
    expect(ctx.replacePayloads).toHaveLength(0)
    expect(mock.writes.length).toBeGreaterThanOrEqual(4)
  })

  it('0.1.7 场景：settings.register 不存在时仍正常工作（这正是本次修复的病灶）', async () => {
    const mock = createMockStorage({ accounts: [ACCOUNT], disabledModels: {}, contextBudgets: {}, schemaVersion: 1 })
    const ctx = createMockContext({ storage: mock.storage, settings: false })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([ACCOUNT.id])
    await pool.addAccount(SECOND)
    expect((mock.current as { accounts: unknown[] }).accounts).toHaveLength(2)
  })

  it('openStorage 返回是否拿到 storage（调用方可据此记日志）', async () => {
    const withStorage = new AccountPool(createMockContext({ storage: createMockStorage().storage }) as never)
    expect(await withStorage.openStorage()).toBe(true)
    const without = new AccountPool(createMockContext() as never)
    expect(await without.openStorage()).toBe(false)
  })
})

describe('AccountPool × storage —— 四件套互带（红线）', () => {
  let mock: ReturnType<typeof createMockStorage>
  let pool: AccountPool

  beforeEach(async () => {
    mock = createMockStorage()
    pool = new AccountPool(createMockContext({ storage: mock.storage }) as never)
    await pool.openStorage()
  })

  it('写账号不会抹掉黑名单 / 预算 / 版本号', async () => {
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    // ⚠️ `replaceAll` 刻意把「黑名单」也作为实参（它本来就是整体替换入口，
    // 调用方是改名迁移，需要原子落盘新的黑名单）。故这里传当前权威值，
    // 而不是空表 —— 传空表等于显式要求清空，那不是本用例要验的事。
    await pool.replaceAll([], pool.allDisabledModels(), 1)
    await pool.addAccount(ACCOUNT)
    const last = mock.current as Record<string, unknown>
    expect(last.accounts).toEqual([ACCOUNT])
    expect(last.disabledModels).toEqual({ qoder: { gfmodel: true } })
    expect(last.contextBudgets).toEqual({ qoder: { gfmodel: 1_000_000 } })
    expect(last.schemaVersion).toBe(1)
  })

  it('写黑名单不会抹掉账号 / 预算 / 版本号', async () => {
    await pool.addAccount(ACCOUNT)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    await pool.replaceAll([ACCOUNT], pool.allDisabledModels(), 1)
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    const last = mock.current as Record<string, unknown>
    expect(last.accounts).toEqual([ACCOUNT])
    expect(last.contextBudgets).toEqual({ qoder: { gfmodel: 1_000_000 } })
    expect(last.schemaVersion).toBe(1)
  })

  it('写预算不会抹掉账号 / 黑名单 / 版本号', async () => {
    await pool.addAccount(ACCOUNT)
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.replaceAll([ACCOUNT], pool.allDisabledModels(), 1)
    await pool.writeContextBudget('buddy-cn', 'glm-5.3', 300_000)
    const last = mock.current as Record<string, unknown>
    expect(last.accounts).toEqual([ACCOUNT])
    expect(last.disabledModels).toEqual({ qoder: { gfmodel: true } })
    expect(last.schemaVersion).toBe(1)
  })

  it('首次写入前先 ensureLoaded：不把存储里已有的账号 / 黑名单 / 版本号清空', async () => {
    const seeded = createMockStorage({
      accounts: [ACCOUNT],
      disabledModels: { qoder: { gfmodel: true } },
      contextBudgets: { qoder: { gfmodel: 1_000_000 } },
      schemaVersion: 1,
    })
    const fresh = new AccountPool(createMockContext({ storage: seeded.storage }) as never)
    await fresh.openStorage()
    // 直接写（不经过任何读路径）
    await fresh.setModelDisabled('buddy-cn', 'glm-5.2', true)
    const last = seeded.current as Record<string, unknown>
    expect((last.accounts as unknown[]).length).toBe(1)
    expect(last.contextBudgets).toEqual({ qoder: { gfmodel: 1_000_000 } })
    expect(last.schemaVersion).toBe(1)
  })

  it('连续记录限流不互相覆盖（进程内副本是唯一读源）', async () => {
    await pool.addAccount(ACCOUNT)
    await pool.addAccount(SECOND)
    await pool.updateModelRateLimit(ACCOUNT.id, 'glm-5.3', 1_790_000_000_000)
    await pool.updateModelRateLimit(SECOND.id, 'gfmodel', 1_790_000_000_001)
    const accounts = (mock.current as { accounts: ProviderAccountEntry[] }).accounts
    expect(accounts.find((a) => a.id === ACCOUNT.id)?.modelRateLimits).toEqual({ 'glm-5.3': 1_790_000_000_000 })
    expect(accounts.find((a) => a.id === SECOND.id)?.modelRateLimits).toEqual({ gfmodel: 1_790_000_000_001 })
  })
})

describe('AccountPool —— storage 缺席时回退旧 settings 路径', () => {
  it('没有 storage 服务时用 settings.register，行为与既有一致', async () => {
    const ctx = createMockContext({
      initialSettings: { accounts: [ACCOUNT], disabledModels: {}, contextBudgets: {}, schemaVersion: 1 },
    })
    const pool = new AccountPool(ctx as never)
    expect(await pool.openStorage()).toBe(false)
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([ACCOUNT.id])
    await pool.addAccount(SECOND)
    expect(ctx.replacePayloads).toHaveLength(1)
    expect((ctx.replacePayloads[0].accounts as unknown[]).length).toBe(2)
  })

  it('storage 服务在但 open 抛错（后端未注册）时静默回退 settings', async () => {
    const ctx = createMockContext({ storage: createMockStorage().storage, storageOpenThrows: true })
    const pool = new AccountPool(ctx as never)
    expect(await pool.openStorage()).toBe(false)
    // 回退后仍是可用的 settings 路径
    await pool.addAccount(ACCOUNT)
    expect(ctx.replacePayloads).toHaveLength(1)
    expect(ctx.warnings.some((m) => m.includes('storage'))).toBe(true)
  })

  it('回退路径下四件套互带照旧（settings 整体 replace 语义不变）', async () => {
    const ctx = createMockContext({
      initialSettings: { accounts: [ACCOUNT], disabledModels: { qoder: { gfmodel: true } }, contextBudgets: {}, schemaVersion: 1 },
    })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    await pool.addAccount(SECOND)
    expect(ctx.replacePayloads[0]).toMatchObject({
      disabledModels: { qoder: { gfmodel: true } },
      contextBudgets: {},
      schemaVersion: 1,
    })
  })
})

describe('AccountPool —— 两者都缺时纯内存降级（现有行为保留）', () => {
  it('没有 settings.register 也没有 storage 时不抛错，内存态可用', async () => {
    const ctx = createMockContext({ settings: false })
    const pool = new AccountPool(ctx as never)
    expect(await pool.openStorage()).toBe(false)
    await pool.addAccount(ACCOUNT)
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([ACCOUNT.id])
    expect(ctx.warnings.some((m) => m.includes('内存'))).toBe(true)
  })

  it('内存态下黑名单 / 预算 / 版本号仍可读写（不抛错）', async () => {
    const ctx = createMockContext({ settings: false })
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    expect(pool.disabledModelsFor('qoder').has('gfmodel')).toBe(true)
    expect(pool.contextBudget('qoder', 'gfmodel')).toBe(1_000_000)
  })
})

describe('AccountPool —— 一次性迁移接线', () => {
  const realFixture = (): string => readFileSync(
    join(process.cwd(), 'tests/unit/fixtures/legacy-settings-real-shape.yaml'),
    'utf8',
  )

  it('storage 为空 + 有 .imported → 迁移后账号立即可见', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const home = await mkdtemp(join(tmpdir(), 'dsh-ah-wire-'))
    try {
      await writeFile(join(home, 'settings.yaml.imported'), realFixture(), 'utf8')
      const mock = createMockStorage()
      const pool = new AccountPool(createMockContext({ storage: mock.storage, homePath: home }) as never)
      await pool.openStorage()
      const accounts = await pool.listAllAccounts()
      expect(accounts).toHaveLength(12)
      // 版本号也搬过来了（否则改名迁移每次启动重跑）
      expect(pool.schemaVersion).toBe(1)
      expect(mock.writes).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('storage 已有数据时不迁移（幂等），一次都不写', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const home = await mkdtemp(join(tmpdir(), 'dsh-ah-wire-'))
    try {
      await writeFile(join(home, 'settings.yaml.imported'), realFixture(), 'utf8')
      const mock = createMockStorage({
        accounts: [SECOND], disabledModels: {}, contextBudgets: {}, schemaVersion: 1,
      })
      const pool = new AccountPool(createMockContext({ storage: mock.storage, homePath: home }) as never)
      await pool.openStorage()
      expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([SECOND.id])
      expect(mock.writes).toHaveLength(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('迁移后来源文件原样保留（用户降级回 0.1.6 仍能用）', async () => {
    const { mkdtemp, writeFile, readFile, rm, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const home = await mkdtemp(join(tmpdir(), 'dsh-ah-wire-'))
    try {
      const path = join(home, 'settings.yaml.imported')
      await writeFile(path, realFixture(), 'utf8')
      const before = await readFile(path)
      const pool = new AccountPool(
        createMockContext({ storage: createMockStorage().storage, homePath: home }) as never,
      )
      await pool.openStorage()
      expect((await readFile(path)).equals(before)).toBe(true)
      expect(await readdir(home)).toEqual(['settings.yaml.imported'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('迁移失败（storage 写盘抛错）不阻断 openStorage，账号以空表继续（绝不半途覆盖）', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const home = await mkdtemp(join(tmpdir(), 'dsh-ah-wire-'))
    try {
      await writeFile(join(home, 'settings.yaml.imported'), realFixture(), 'utf8')
      const failing = createMockStorage()
      failing.storage.write = async () => { throw new Error('EACCES: 磁盘不可写') }
      const ctx = createMockContext({ storage: failing.storage, homePath: home })
      const pool = new AccountPool(ctx as never)
      // 不抛错：迁移失败只是这一轮不迁移。
      await expect(pool.openStorage()).resolves.toBe(true)
      expect(await pool.listAllAccounts()).toEqual([])
      expect(ctx.warnings.some((m) => m.includes('迁移'))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('没有 dshHomePath 服务时不做文件迁移（不写死路径、不猜 home）', async () => {
    const mock = createMockStorage()
    const ctx = createMockContext({ storage: mock.storage }) as Record<string, unknown>
    delete ctx.dshHomePath
    const pool = new AccountPool(ctx as never)
    await expect(pool.openStorage()).resolves.toBe(true)
    expect(await pool.listAllAccounts()).toEqual([])
    expect(mock.writes).toHaveLength(0)
  })
})

describe('AccountPool —— 存储层不出现旧命名的新落点', () => {
  it('storage 域名是新插件 id 的下划线形态，且不含旧 namespace 字面量', () => {
    expect(ACCOUNT_HUB_DOMAIN).toBe('dsh_account_hub')
    expect(ACCOUNT_HUB_DOMAIN).not.toContain('jet')
  })

  it('旧 namespace 字面量只作为历史读取键存在（不得用于新写入位置）', () => {
    expect(LEGACY_SETTINGS_NAMESPACE).toBe('jet-hub')
    // 源码里该字面量只应出现在迁移模块（历史读取）与 account-pool（回退路径）
    const migration = readFileSync(join(process.cwd(), 'src/account-hub-migration.ts'), 'utf8')
    expect(migration).toContain(LEGACY_SETTINGS_NAMESPACE)
    const storage = readFileSync(join(process.cwd(), 'src/account-hub-storage.ts'), 'utf8')
    expect(storage).not.toContain(`'${LEGACY_SETTINGS_NAMESPACE}'`)
  })
})

describe('AccountPool —— storage 写入失败向上抛出（不静默）', () => {
  it('addAccount 在 storage 写盘失败时抛错', async () => {
    const mock = createMockStorage()
    mock.storage.write = async () => { throw new Error('EIO') }
    const pool = new AccountPool(createMockContext({ storage: mock.storage }) as never)
    await pool.openStorage()
    await expect(pool.addAccount(ACCOUNT)).rejects.toThrow('EIO')
  })

  it('openStorage 之前 storage 未接管：写入仍走并只走 settings（不会被后来者重复写）', async () => {
    const mock = createMockStorage()
    const ctx = createMockContext({ storage: mock.storage })
    const pool = new AccountPool(ctx as never)
    // 刻意不调 openStorage
    await pool.addAccount(ACCOUNT)
    expect(ctx.replacePayloads).toHaveLength(1)
    expect(mock.writes).toHaveLength(0)
  })
})

describe('AccountPool —— logger 用词与降级矩阵一致', () => {
  it('storage 缺席但 settings 可用时：构造不报警（这是设计内的正常回退，不是故障）', () => {
    const ctx = createMockContext({ storage: undefined })
    new AccountPool(ctx as never)
    // 回退路径本身是正常通路；在这里刷警告会让真故障被噪音淹没。
    expect(ctx.warnings.some((m) => m.includes('内存'))).toBe(false)
  })

  it('storage 缺席且 settings 回退也不可用时才说「仅存在于内存中」', async () => {
    const ctxWithFallback = createMockContext({ storage: undefined })
    const poolA = new AccountPool(ctxWithFallback as never)
    expect(await poolA.openStorage()).toBe(false)

    const ctxNoFallback = createMockContext({ storage: undefined, settings: false })
    const poolB = new AccountPool(ctxNoFallback as never)
    expect(await poolB.openStorage()).toBe(false)
    expect(ctxNoFallback.warnings.some((m) => m.includes('内存'))).toBe(true)
  })

  it('0.1.7 场景（settings 无 register + storage 可用）不报「仅内存」假警报', async () => {
    const mock = createMockStorage()
    const ctx = createMockContext({ storage: mock.storage, settings: false })
    const pool = new AccountPool(ctx as never)
    expect(await pool.openStorage()).toBe(true)
    // 这正是 0.1.7 报障时日志误导排查者的那句话，绝不能在 storage 可用时出现。
    expect(ctx.warnings.some((m) => m.includes('内存'))).toBe(false)
  })
})

describe('AccountPool —— 接管时序（storage 迁移必须早于任何读改写）', () => {
  it('openStorage 前若已有人读过池（旧路径缓存），接管后必须从 storage 重新载入', async () => {
    const mock = createMockStorage({
      accounts: [ACCOUNT], disabledModels: {}, contextBudgets: {}, schemaVersion: 1,
    })
    const ctx = createMockContext({
      storage: mock.storage,
      // 旧路径里是**另一批**数据：若不重载，接管后读到的会是它。
      initialSettings: { accounts: [SECOND], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 },
    })
    const pool = new AccountPool(ctx as never)
    // 接管前先触发一次载入（模拟启动早期有人读池）
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([SECOND.id])
    await pool.openStorage()
    // 接管后必须换成 storage 的数据，而不是继续用已缓存的旧路径快照。
    expect((await pool.listAllAccounts()).map((a) => a.id)).toEqual([ACCOUNT.id])
    expect(pool.schemaVersion).toBe(1)
  })

  it('接管后的首次写入落在 storage，不会把已缓存的旧路径数据写回去', async () => {
    const mock = createMockStorage({ accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 })
    const ctx = createMockContext({
      storage: mock.storage,
      initialSettings: { accounts: [SECOND], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 },
    })
    const pool = new AccountPool(ctx as never)
    await pool.listAllAccounts()
    await pool.openStorage()
    await pool.addAccount(ACCOUNT)
    // 旧路径的 SECOND 不该混进来：它从未存在于 storage。
    expect((mock.current as { accounts: ProviderAccountEntry[] }).accounts.map((a) => a.id)).toEqual([ACCOUNT.id])
    expect(ctx.replacePayloads).toHaveLength(0)
  })
})

describe('AccountPool —— openStorage 幂等', () => {
  it('重复调用不重复打开域、不重复迁移', async () => {
    const mock = createMockStorage()
    const openSpy = vi.fn()
    const ctx = createMockContext({ storage: mock.storage }) as Record<string, unknown>
    ;(ctx as { get: (k: string) => unknown }).get = (key: string) => {
      if (key === 'storageDomain') return { open: async () => { openSpy(); return { global: { get: () => mock.read(), set: async (v: unknown) => { await mock.storage.write(v as Record<string, unknown>) } } } } }
      if (key === 'settings') return undefined
      return undefined
    }
    const pool = new AccountPool(ctx as never)
    await pool.openStorage()
    await pool.openStorage()
    expect(openSpy).toHaveBeenCalledTimes(1)
  })
})
