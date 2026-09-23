import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACCOUNT_HUB_DOMAIN,
  ACCOUNT_HUB_DOMAIN_VERSION,
  emptyAccountHubDocument,
  openAccountHubStorage,
  sanitizeAccountHubDocument,
} from '../../src/account-hub-storage.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 内存版 DomainFacility：只实现 `open()` 返回的 global 句柄（`get` / `set`），
 * 语义与 DSH 本体 `packages/storage/storage-domain` 一致 —— 读同步取自权威内存态，
 * 写在落盘完成后才更新内存。
 *
 * 刻意**只**实现 storage 域这一条通路：真实实现里还有 table / 事件 / 关闭，
 * 本模块一个都不用（账号池是「一个 global 文档整体读写」）。
 */
function createMockDomainFacility(options: { failOpen?: boolean; initialGlobal?: unknown } = {}) {
  let global: unknown = options.initialGlobal ?? null
  const openedSpecs: Array<Record<string, unknown>> = []
  let setCalls = 0
  const facility = {
    open: async (spec: Record<string, unknown>) => {
      if (options.failOpen) throw new Error('backend-not-found: 无路由后端')
      openedSpecs.push(spec)
      return {
        name: spec.name,
        global: {
          get: () => global,
          set: async (value: unknown) => {
            setCalls++
            global = value
          },
        },
        close: async () => {},
      }
    },
  }
  return {
    facility,
    openedSpecs,
    get global() { return global },
    get setCalls() { return setCalls },
  }
}

/** 最小 Context 替身：只暴露 `get('storageDomain')` 与 logger。 */
function createMockContext(facility: unknown | undefined) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: (key: string) => (key === 'storageDomain' ? facility : undefined),
  }
}

const ACCOUNT: ProviderAccountEntry = {
  id: 'buddy-cn-001',
  provider: 'buddy-cn',
  nickname: '测试账号',
  enabled: true,
  credentialRef: 'BUDDY_CN_ACCOUNT_T1',
  createdAt: 1_789_000_000_000,
  refreshable: true,
}

describe('账号池 storage 域的域名与版本', () => {
  it('域名匹配 storage 的 UNIT_NAME_RE（小写字母开头 + 小写字母/数字/下划线）', () => {
    // ⚠️ 这不是形式检查：storage 后端在 open 时按 `^[a-z][a-z0-9_]*$` 校验域名，
    // 不匹配会直接以 malformed-medium 拒绝。插件 id 是 `dsh-account-hub`（带连字符），
    // 而域名只能用下划线形态，故两者刻意不是同一个字符串。
    expect(ACCOUNT_HUB_DOMAIN).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(ACCOUNT_HUB_DOMAIN).toBe('dsh_account_hub')
    expect(ACCOUNT_HUB_DOMAIN_VERSION).toBe(1)
  })
})

describe('emptyAccountHubDocument', () => {
  it('空文档是七件套齐全的空表，而不是缺字段的部分对象', () => {
    expect(emptyAccountHubDocument()).toEqual({
      accounts: [],
      disabledModels: {},
      contextBudgets: {},
      checkins: {},
      // 「消耗顺序 / 切换粒度」及其遍历游标（比签到更晚加入的两个字段）。
      consumption: {},
      consumptionCursors: {},
      schemaVersion: 0,
    })
  })

  it('旧文档（无新字段）读入时补空表，而不是读成 undefined', () => {
    // 升级路径：盘上那份文档是上一版写的，没有 consumption / consumptionCursors。
    // 读成 `{}` 等价于「顺序 + 按轮次」的默认配置，即**改动前的行为**。
    const doc = sanitizeAccountHubDocument({
      accounts: [],
      disabledModels: {},
      contextBudgets: {},
      checkins: {},
      schemaVersion: 1,
    })
    expect(doc.consumption).toEqual({})
    expect(doc.consumptionCursors).toEqual({})
    expect(doc.schemaVersion).toBe(1)
  })

  it('新字段的脏值逐层丢弃，不影响既有字段', () => {
    const doc = sanitizeAccountHubDocument({
      accounts: [{ id: 'a' }],
      consumption: { ok: { order: 'round-robin', switch: 'per-request' }, bad: 'x', empty: {} },
      consumptionCursors: { ok: 'a', bad: 7, blank: '' },
      schemaVersion: 3,
    })
    expect(doc.consumption).toEqual({ ok: { order: 'round-robin', switch: 'per-request' } })
    expect(doc.consumptionCursors).toEqual({ ok: 'a' })
    expect(doc.schemaVersion).toBe(3)
  })

  it('每次返回新对象（共享引用会被写入方就地改坏）', () => {
    const a = emptyAccountHubDocument()
    const b = emptyAccountHubDocument()
    expect(a).not.toBe(b)
    expect(a.accounts).not.toBe(b.accounts)
  })
})

describe('sanitizeAccountHubDocument —— 落盘边界的归一化', () => {
  it('脏数据被丢弃而不是抛错（外部可能手工编辑过存储文件）', () => {
    const doc = sanitizeAccountHubDocument({
      accounts: 'not-an-array',
      disabledModels: [1, 2, 3],
      contextBudgets: null,
      schemaVersion: 'x',
    })
    expect(doc).toEqual(emptyAccountHubDocument())
  })

  it('只保留合法的黑名单项（显式 true）与正的有限预算', () => {
    const doc = sanitizeAccountHubDocument({
      accounts: [ACCOUNT],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true, 'glm-5.3': false }, bad: 'nope' },
      contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000, zero: 0, neg: -1, str: '5' } },
      schemaVersion: 1,
    })
    expect(doc.accounts).toHaveLength(1)
    // false 不进黑名单（语义是「只有显式 true 才算关闭」），空表不保留 provider 键。
    expect(doc.disabledModels).toEqual({ 'buddy-cn': { 'glm-5.2': true } })
    expect(doc.contextBudgets).toEqual({ 'buddy-cn': { 'glm-5.2': 300_000 } })
    expect(doc.schemaVersion).toBe(1)
  })

  it('非有限 / 非数字的版本号按 0 处理（等价于「尚未迁移」）', () => {
    expect(sanitizeAccountHubDocument({ schemaVersion: Number.NaN }).schemaVersion).toBe(0)
    expect(sanitizeAccountHubDocument({ schemaVersion: -1 }).schemaVersion).toBe(-1)
    expect(sanitizeAccountHubDocument(null).schemaVersion).toBe(0)
  })
})

describe('openAccountHubStorage —— 运行时探测与静默降级', () => {
  it('ctx 没有 storageDomain 服务时返回 undefined，不抛错', async () => {
    await expect(openAccountHubStorage(createMockContext(undefined) as never)).resolves.toBeUndefined()
  })

  it('storageDomain 服务形状不对（没有 open 方法）时返回 undefined', async () => {
    const ctx = createMockContext({ notOpen: () => {} })
    await expect(openAccountHubStorage(ctx as never)).resolves.toBeUndefined()
  })

  it('open 抛错（如后端未注册）时返回 undefined 并记 warn，绝不向调用方抛出', async () => {
    const mock = createMockDomainFacility({ failOpen: true })
    const warnings: string[] = []
    const ctx = {
      logger: { warn: (m: string) => warnings.push(m), info: () => {}, error: () => {} },
      get: (key: string) => (key === 'storageDomain' ? mock.facility : undefined),
    }
    await expect(openAccountHubStorage(ctx as never)).resolves.toBeUndefined()
    expect(warnings.some((m) => m.includes('storage'))).toBe(true)
  })

  it('open 时用本插件的域名与版本声明域（而不是别的字符串）', async () => {
    const mock = createMockDomainFacility()
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage).toBeDefined()
    expect(mock.openedSpecs).toHaveLength(1)
    expect(mock.openedSpecs[0].name).toBe(ACCOUNT_HUB_DOMAIN)
    expect(mock.openedSpecs[0].version).toBe(ACCOUNT_HUB_DOMAIN_VERSION)
    // 单例文档整体读写 ⇒ 不声明任何表。
    expect(mock.openedSpecs[0].tables).toEqual({})
  })
})

describe('openAccountHubStorage —— 域生命周期（disposer 登记）', () => {
  it('打开成功后登记关闭 disposer，并把 domain.close 挂进回调链', async () => {
    let closed = 0
    const effects: Array<{ label?: string; disposer: () => unknown }> = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: (key: string) => (key === 'storageDomain'
        ? {
          open: async () => ({
            global: { get: () => null, set: async () => {} },
            close: async () => { closed++ },
          }),
        }
        : undefined),
      // cordis 的 `effect(execute, label)`：execute 返回 disposer。
      effect: (execute: () => () => unknown, label?: string) => {
        effects.push({ label, disposer: execute() })
        return async () => {}
      },
    }
    await openAccountHubStorage(ctx as never)
    expect(effects).toHaveLength(1)
    expect(effects[0].label).toBe('accountHub.domainClose')
    await effects[0].disposer()
    expect(closed).toBe(1)
  })

  it('ctx 没有 effect 服务时不抛错（退化：域句柄仍可用）', async () => {
    const mock = createMockDomainFacility()
    const ctx = createMockContext(mock.facility) as Record<string, unknown>
    delete ctx.effect
    const storage = await openAccountHubStorage(ctx as never)
    expect(storage).toBeDefined()
    expect(storage!.read()).toEqual(emptyAccountHubDocument())
  })

  it('effect 登记自身抛错时不影响 storage 接管（不能因登记失败而整个降级）', async () => {
    const mock = createMockDomainFacility()
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: (key: string) => (key === 'storageDomain' ? mock.facility : undefined),
      effect: () => { throw new Error('INACTIVE_EFFECT') },
    }
    const storage = await openAccountHubStorage(ctx as never)
    expect(storage).toBeDefined()
    expect(mock.openedSpecs).toHaveLength(1)
  })
})

describe('storage 读取', () => {
  let mock: ReturnType<typeof createMockDomainFacility>

  beforeEach(() => {
    mock = createMockDomainFacility()
  })

  it('存储里从未写过 global 时读出空文档（不是 undefined）', async () => {
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage!.read()).toEqual(emptyAccountHubDocument())
  })

  it('已有数据时原样读回四件套（重启后账号不丢）', async () => {
    mock = createMockDomainFacility({
      initialGlobal: {
        accounts: [ACCOUNT],
        disabledModels: { 'buddy-cn': { 'glm-5.2': true } },
        contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000 } },
        schemaVersion: 1,
      },
    })
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    const doc = storage!.read()
    expect(doc.accounts).toEqual([ACCOUNT])
    expect(doc.disabledModels).toEqual({ 'buddy-cn': { 'glm-5.2': true } })
    expect(doc.contextBudgets).toEqual({ 'buddy-cn': { 'glm-5.2': 300_000 } })
    expect(doc.schemaVersion).toBe(1)
  })

  it('存储里是脏数据时读成空文档而不是抛错（存储被外部改坏不该让账号管理不可用）', async () => {
    mock = createMockDomainFacility({ initialGlobal: 'garbage' })
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage!.read()).toEqual(emptyAccountHubDocument())
  })

  it('read() 是同步的（适配器在 resolveModel 里同步读窗口预算）', async () => {
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage!.read()).not.toBeInstanceOf(Promise)
  })

  it('hasAccounts 以「存储里有没有账号数据」为判据（一次性迁移的幂等闸门）', async () => {
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage!.hasAccounts()).toBe(false)
    await storage!.write({ ...emptyAccountHubDocument(), accounts: [ACCOUNT] })
    expect(storage!.hasAccounts()).toBe(true)
  })

  it('账号列表为空数组时 hasAccounts 为假（空表不算「已有数据」）', async () => {
    mock = createMockDomainFacility({
      initialGlobal: { accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 },
    })
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    expect(storage!.hasAccounts()).toBe(false)
  })
})

describe('storage 写入', () => {
  it('写入走 global.set 整体落盘，且四件套一起带上', async () => {
    const mock = createMockDomainFacility()
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    await storage!.write({
      accounts: [ACCOUNT],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true } },
      contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000 } },
      schemaVersion: 1,
    })
    expect(mock.setCalls).toBe(1)
    expect(mock.global).toEqual({
      accounts: [ACCOUNT],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true } },
      contextBudgets: { 'buddy-cn': { 'glm-5.2': 300_000 } },
      schemaVersion: 1,
    })
  })

  it('写入后再读回一致', async () => {
    const mock = createMockDomainFacility()
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    const doc = { ...emptyAccountHubDocument(), accounts: [ACCOUNT], schemaVersion: 1 }
    await storage!.write(doc)
    expect(storage!.read()).toEqual(doc)
  })

  it('写入失败时向调用方抛出（调用方据此决定不更新进程内副本）', async () => {
    const mock = createMockDomainFacility()
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    // 让 global.set 失败：模拟磁盘不可写。
    ;(mock.facility as unknown as { open: unknown }).open = undefined
    const failing = await openAccountHubStorage({
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: () => ({
        open: async () => ({
          global: { get: () => null, set: async () => { throw new Error('EACCES') } },
          close: async () => {},
        }),
      }),
    } as never)
    await expect(failing!.write(emptyAccountHubDocument())).rejects.toThrow('EACCES')
    // 原句柄不受影响
    await expect(storage!.write(emptyAccountHubDocument())).resolves.toBeUndefined()
  })

  it('写入的内容是深拷贝快照：调用方随后改自己的对象不会污染已落盘的值', async () => {
    const mock = createMockDomainFacility()
    const storage = await openAccountHubStorage(createMockContext(mock.facility) as never)
    const accounts = [ACCOUNT]
    await storage!.write({ ...emptyAccountHubDocument(), accounts })
    accounts.push({ ...ACCOUNT, id: 'later-added' })
    expect((mock.global as { accounts: unknown[] }).accounts).toHaveLength(1)
  })
})
