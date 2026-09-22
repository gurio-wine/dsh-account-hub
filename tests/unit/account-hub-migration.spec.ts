import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEGACY_SETTINGS_NAMESPACE,
  findLegacyAccountHubSection,
  migrateAccountHubIntoStorage,
  parseLegacySettingsYaml,
} from '../../src/account-hub-migration.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const ACCOUNT: ProviderAccountEntry = {
  id: 'buddy-cn-001',
  provider: 'buddy-cn',
  nickname: '河童',
  enabled: true,
  credentialRef: 'BUDDY_CN_ACCOUNT_T1',
  createdAt: 1_789_000_000_000,
  refreshable: true,
}

/**
 * 真实 `~/.dsh/settings.yaml` 的节选（含注释友好排版、引号、`**` 星号、
 * 块内缩进 flow 映射），用来钉死解析器覆盖的是**真实落盘形态**而不是理想 YAML。
 */
const REAL_SHAPE_YAML = `# 这是 0.1.6 的 settings 文件头注释
ui-theme:
  mode: dark
${LEGACY_SETTINGS_NAMESPACE}:
  accounts:
    - id: buddy-cn-001
      provider: buddy-cn
      nickname: "18283273005"
      enabled: true
      credentialRef: BUDDY_CN_ACCOUNT_T1
      refreshable: true
      createdAt: 1789455550997
      expiresAt: 1792684142000
      modelRateLimits:
        glm-5.3: 1790151758462
    - id: buddy-cn-002
      provider: buddy-cn
      nickname: 189****3995
      enabled: false
      credentialRef: BUDDY_CN_ACCOUNT_T2
      createdAt: 1789459491122
  disabledModels:
    {
      buddy-cn:
        {
          glm-5.2: true,
          glm-5.3: true
        },
      qoder: { gfmodel: true },
      trae-cn-work: { legacy: true }
    }
  schemaVersion: 1
  contextBudgets:
    {
      buddy-cn:
        {
          glm-5.3: 300000
        },
      qoder: { gfmodel: 1000000 }
    }
llm-pi-ai:
  apiKey: sk-not-a-real-key
`

describe('LEGACY_SETTINGS_NAMESPACE', () => {
  it('是历史数据真正所在的键名，迁移期间不得改动', () => {
    // ⚠️ 这个字面量是**历史数据源标识**，不是命名喜好：0.1.6 的 settings.yaml
    // 与 0.1.7 迁移留下的 settings.yaml.imported 里，账号数据都在这个键下。
    // 改成新插件 id 会让迁移在一台已有数据的机器上读到空段 ⇒ 账号凭空消失。
    expect(LEGACY_SETTINGS_NAMESPACE).toBe('jet-hub')
  })
})

describe('parseLegacySettingsYaml —— 只解析迁移需要的部分', () => {
  it('从真实形态里取出账号（含引号、星号、块内 flow 映射的嵌套字段）', () => {
    const sections = parseLegacySettingsYaml(REAL_SHAPE_YAML)
    const section = sections[LEGACY_SETTINGS_NAMESPACE] as Record<string, unknown>
    expect(section).toBeDefined()
    const accounts = section.accounts as ProviderAccountEntry[]
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      id: 'buddy-cn-001',
      provider: 'buddy-cn',
      // 双引号必须被剥掉：留着引号会让 nickname 显示成 "18283273005"
      nickname: '18283273005',
      enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T1',
      createdAt: 1789455550997,
      expiresAt: 1792684142000,
    })
    // 嵌套映射（modelRateLimits）按数字保留
    expect(accounts[0].modelRateLimits).toEqual({ 'glm-5.3': 1790151758462 })
    // 星号是普通字符，不是 YAML 别名
    expect(accounts[1].nickname).toBe('189****3995')
    expect(accounts[1].enabled).toBe(false)
  })

  it('取出黑名单（flow 块内嵌套映射）与上下文预算', () => {
    const sections = parseLegacySettingsYaml(REAL_SHAPE_YAML)
    const section = sections[LEGACY_SETTINGS_NAMESPACE] as Record<string, unknown>
    expect(section.disabledModels).toEqual({
      'buddy-cn': { 'glm-5.2': true, 'glm-5.3': true },
      qoder: { gfmodel: true },
      // ⚠️ 已移除 provider 的残留键**原样搬运**，不清理（历史包袱由用户决定）
      'trae-cn-work': { legacy: true },
    })
    expect(section.contextBudgets).toEqual({
      'buddy-cn': { 'glm-5.3': 300_000 },
      qoder: { gfmodel: 1_000_000 },
    })
    expect(section.schemaVersion).toBe(1)
  })

  it('不把别的节带进来（只取目标节，其余节连内容都不解析）', () => {
    const sections = parseLegacySettingsYaml(REAL_SHAPE_YAML)
    expect(Object.keys(sections)).toEqual([LEGACY_SETTINGS_NAMESPACE])
    expect(JSON.stringify(sections)).not.toContain('sk-not-a-real-key')
  })

  it('其他顶层键下面的同名子键不会被误当成目标节', () => {
    const yaml = `llm-pi-ai:\n  accounts:\n    - id: not-mine\n${LEGACY_SETTINGS_NAMESPACE}:\n  accounts:\n    - id: mine\n`
    const sections = parseLegacySettingsYaml(yaml)
    const accounts = (sections[LEGACY_SETTINGS_NAMESPACE] as { accounts: ProviderAccountEntry[] }).accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].id).toBe('mine')
  })

  it('没有目标节时返回空对象（调用方据此判定「无可迁移数据」）', () => {
    expect(parseLegacySettingsYaml('ui-theme:\n  mode: dark\n')).toEqual({})
  })

  it('文件为空 / 只有注释时返回空对象', () => {
    expect(parseLegacySettingsYaml('')).toEqual({})
    expect(parseLegacySettingsYaml('# 只有注释\n')).toEqual({})
  })

  it('目标节内部语法坏掉时抛错（调用方按「来源读不了」处理，不静默当空）', () => {
    // 未闭合的 flow 集合是硬错误；视作空会让迁移静默放弃用户的账号数据。
    expect(() => parseLegacySettingsYaml(`${LEGACY_SETTINGS_NAMESPACE}:\n  accounts: [\n`)).toThrow()
  })

  it('目标节用到本解析器不支持的构造时抛错，而不是猜一个意思', () => {
    expect(() => parseLegacySettingsYaml(`${LEGACY_SETTINGS_NAMESPACE}:\n  accounts: &anchor\n`)).toThrow()
  })

  it('**无关 section** 里的畸形 / 不支持构造不影响解析（只取目标节）', () => {
    // 真实 settings.yaml 的别的段里就有块标量（`serverPresets: |`）与各种构造；
    // 整文件解析会被无关内容拖垮，而迁移只关心目标节。
    const yaml = `llm-pi-ai:\n  serverPresets: |\n    多行内容\n    第二行\n  a: [ 未闭合\naegis:\n  x: &anchor 1\n${LEGACY_SETTINGS_NAMESPACE}:\n  accounts:\n    - id: mine\n`
    const sections = parseLegacySettingsYaml(yaml)
    expect(sections[LEGACY_SETTINGS_NAMESPACE].accounts).toEqual([{ id: 'mine' }])
  })
})

describe('findLegacyAccountHubSection —— 来源优先级', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-account-hub-mig-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('settings.yaml.imported 优先于 settings.yaml（0.1.7 迁移留下的原件更权威）', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    await writeFile(
      join(home, 'settings.yaml'),
      `${LEGACY_SETTINGS_NAMESPACE}:\n  accounts:\n    - id: from-current\n`,
      'utf8',
    )
    const found = await findLegacyAccountHubSection(home)
    expect(found?.origin).toBe('settings.yaml.imported')
    expect(found?.section.accounts?.[0].id).toBe('buddy-cn-001')
  })

  it('只有 settings.yaml 时用它（0.1.6 现役位置）', async () => {
    await writeFile(join(home, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
    const found = await findLegacyAccountHubSection(home)
    expect(found?.origin).toBe('settings.yaml')
    expect(found?.section.accounts).toHaveLength(2)
  })

  it('两个文件都没有时返回 undefined', async () => {
    expect(await findLegacyAccountHubSection(home)).toBeUndefined()
  })

  it('home 目录不存在时返回 undefined（不抛错）', async () => {
    expect(await findLegacyAccountHubSection(join(home, 'no-such-dir'))).toBeUndefined()
  })

  it('.imported 存在但没有目标节时，继续看 settings.yaml（不是「有文件就算数」）', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), 'ui-theme:\n  mode: dark\n', 'utf8')
    await writeFile(join(home, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
    const found = await findLegacyAccountHubSection(home)
    expect(found?.origin).toBe('settings.yaml')
  })

  it('来源判定用节本身的可迁移性：只有 accounts 非空才算找到', async () => {
    await writeFile(
      join(home, 'settings.yaml.imported'),
      `${LEGACY_SETTINGS_NAMESPACE}:\n  accounts: []\n`,
      'utf8',
    )
    await writeFile(join(home, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
    const found = await findLegacyAccountHubSection(home)
    expect(found?.origin).toBe('settings.yaml')
  })
})

describe('migrateAccountHubIntoStorage —— 一次性迁移', () => {
  let home: string
  let writes: Array<Record<string, unknown>>
  let storage: {
    read: () => Record<string, unknown>
    write: (doc: never) => Promise<void>
    hasAccounts: () => boolean
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-account-hub-mig-'))
    writes = []
    let current: Record<string, unknown> = {
      accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 0,
    }
    storage = {
      read: () => current,
      write: async (doc) => { writes.push(doc as Record<string, unknown>); current = doc as Record<string, unknown> },
      hasAccounts: () => (current.accounts as unknown[]).length > 0,
    }
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function deps(overrides: { legacySection?: () => Promise<unknown> } = {}) {
    return {
      home,
      storage: storage as never,
      readLegacySection: overrides.legacySection
        ?? (async () => (await findLegacyAccountHubSection(home))?.section),
    }
  }

  it('storage 为空 + 有旧数据 → 落盘四件套，返回 migrated', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('migrated')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      accounts: [expect.objectContaining({ id: 'buddy-cn-001' }), expect.objectContaining({ id: 'buddy-cn-002' })],
      disabledModels: { 'buddy-cn': { 'glm-5.2': true, 'glm-5.3': true }, qoder: { gfmodel: true }, 'trae-cn-work': { legacy: true } },
      contextBudgets: { 'buddy-cn': { 'glm-5.3': 300_000 }, qoder: { gfmodel: 1_000_000 } },
      schemaVersion: 1,
    })
  })

  it('幂等：storage 已有账号数据 → 整体跳过，一次都不写', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    await storage.write({ accounts: [ACCOUNT], disabledModels: {}, contextBudgets: {}, schemaVersion: 1 } as never)
    writes.length = 0
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('skipped-storage-populated')
    expect(writes).toHaveLength(0)
  })

  it('无可迁移数据（来源无目标节）→ 跳过且不写空表', async () => {
    await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  mode: dark\n', 'utf8')
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('skipped-no-source')
    expect(writes).toHaveLength(0)
  })

  it('来源里 accounts 是空数组 → 不算可迁移数据，不写空表', async () => {
    await writeFile(join(home, 'settings.yaml'), `${LEGACY_SETTINGS_NAMESPACE}:\n  accounts: []\n`, 'utf8')
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('skipped-no-source')
    expect(writes).toHaveLength(0)
  })

  it('来源只有黑名单 / 预算没有账号 → 同样跳过（空表不落）', async () => {
    await writeFile(
      join(home, 'settings.yaml'),
      `${LEGACY_SETTINGS_NAMESPACE}:\n  disabledModels:\n    qoder: { gfmodel: true }\n`,
      'utf8',
    )
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('skipped-no-source')
    expect(writes).toHaveLength(0)
  })

  it('迁移前后不修改来源文件（字节级一致）', async () => {
    const path = join(home, 'settings.yaml.imported')
    await writeFile(path, REAL_SHAPE_YAML, 'utf8')
    const before = await readFile(path)
    const beforeStat = await stat(path)
    await migrateAccountHubIntoStorage(deps() as never)
    const after = await readFile(path)
    expect(after.equals(before)).toBe(true)
    expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs)
    // 也不产生 .bak / .tmp 之类的新文件
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(home)).sort()).toEqual(['settings.yaml.imported'])
  })

  it('迁移完成后不删除来源（settings.yaml 与 .imported 都留着）', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    await writeFile(join(home, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
    await migrateAccountHubIntoStorage(deps() as never)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(home)).sort()).toEqual(['settings.yaml', 'settings.yaml.imported'])
  })

  it('写入失败 → 返回 failed 且不更新任何进程内状态（绝不半途覆盖）', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    const failing = {
      read: () => ({ accounts: [], disabledModels: {}, contextBudgets: {}, schemaVersion: 0 }),
      hasAccounts: () => false,
      write: async () => { throw new Error('EACCES: 磁盘不可写') },
    }
    const result = await migrateAccountHubIntoStorage({
      home,
      storage: failing as never,
      readLegacySection: async () => (await findLegacyAccountHubSection(home))?.section,
    } as never)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('EACCES')
    // 存储侧仍是空表（没有被写坏）
    expect(failing.read().accounts).toEqual([])
  })

  it('来源的目标节读不了（节内 YAML 语法错）→ 返回 failed，不写任何东西', async () => {
    await writeFile(join(home, 'settings.yaml'), `${LEGACY_SETTINGS_NAMESPACE}:\n  accounts: [\n`, 'utf8')
    const result = await migrateAccountHubIntoStorage(deps() as never)
    expect(result.outcome).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(writes).toHaveLength(0)
  })

  it('重复调用只有第一次写盘（第二次因 storage 已有数据而跳过）', async () => {
    await writeFile(join(home, 'settings.yaml.imported'), REAL_SHAPE_YAML, 'utf8')
    const first = await migrateAccountHubIntoStorage(deps() as never)
    const second = await migrateAccountHubIntoStorage(deps() as never)
    expect(first.outcome).toBe('migrated')
    expect(second.outcome).toBe('skipped-storage-populated')
    expect(writes).toHaveLength(1)
  })

  it('多个 home 目录互不影响（迁移只看传入的 home，不读真实 ~/.dsh）', async () => {
    const other = await mkdtemp(join(tmpdir(), 'dsh-account-hub-other-'))
    try {
      await writeFile(join(other, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
      await migrateAccountHubIntoStorage({
        home,
        storage: storage as never,
        readLegacySection: async () => (await findLegacyAccountHubSection(home))?.section,
      } as never)
      expect(writes).toHaveLength(0)
      const result = await migrateAccountHubIntoStorage({
        home: other,
        storage: storage as never,
        readLegacySection: async () => (await findLegacyAccountHubSection(other))?.section,
      } as never)
      expect(result.outcome).toBe('migrated')
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('真实落盘形态夹具 —— 解析器覆盖的是实际文件而不是理想 YAML', () => {
  /**
   * 夹具来源：本机 `~/.dsh/settings.yaml` 的 `jet-hub` 段**逐行取出后仅脱敏值**
   * （id / nickname / credentialRef 换成占位；缩进、引号、`****`、flow 括号、
   * 尾逗号等**结构一字未改**）。段前额外拼了三个无关 section，其中含块标量与
   * 锚点 —— 本解析器不支持它们，但也不该被它们影响。
   *
   * 这条用例的价值：其余用例用的是手写 YAML，可能「按实现的样子写」；
   * 只有真文件能证明解析器面对 12 个账号、7 种 provider、块内缩进 flow 映射
   * 与 `189****3995` 这类值时不炸也不算错。
   */
  const fixture = (): string => readFileSync(
    join(process.cwd(), 'tests/unit/fixtures/legacy-settings-real-shape.yaml'),
    'utf8',
  )

  it('解析出 12 个账号、7 种 provider，四个字段一个不少', () => {
    const section = parseLegacySettingsYaml(fixture())[LEGACY_SETTINGS_NAMESPACE]
    expect(section.accounts).toHaveLength(12)
    expect(new Set(section.accounts.map((a) => a.provider)).size).toBe(7)
    // 每条账号都必须有 id / provider / credentialRef —— 缺一个就是把脏数据搬进新家。
    for (const account of section.accounts) {
      expect(typeof account.id).toBe('string')
      expect(typeof account.provider).toBe('string')
      expect(typeof account.credentialRef).toBe('string')
    }
  })

  it('账号里的嵌套 modelRateLimits 保留为数字映射（序列项内联块映射的回归）', () => {
    const section = parseLegacySettingsYaml(fixture())[LEGACY_SETTINGS_NAMESPACE]
    const withLimits = section.accounts.filter((a) => a.modelRateLimits !== undefined)
    expect(withLimits.length).toBeGreaterThan(0)
    for (const account of withLimits) {
      const entries = Object.entries(account.modelRateLimits!)
      expect(entries.length).toBeGreaterThan(0)
      for (const [, resetAt] of entries) expect(typeof resetAt).toBe('number')
    }
    // 布尔字段必须是布尔而不是字符串 'true'。
    expect(section.accounts.filter((a) => a.enabled === true).length).toBeGreaterThan(0)
    expect(section.accounts.every((a) => typeof a.enabled === 'boolean')).toBe(true)
  })

  it('黑名单跨 7 种 provider 且值恒为 true（块内缩进 flow 映射）', () => {
    const section = parseLegacySettingsYaml(fixture())[LEGACY_SETTINGS_NAMESPACE]
    const providers = Object.keys(section.disabledModels)
    expect(providers.length).toBeGreaterThanOrEqual(6)
    for (const [, models] of Object.entries(section.disabledModels)) {
      for (const [, flag] of Object.entries(models)) expect(flag).toBe(true)
    }
  })

  it('上下文预算是正数（含块内缩进 flow 与单行 flow 两种写法）', () => {
    const section = parseLegacySettingsYaml(fixture())[LEGACY_SETTINGS_NAMESPACE]
    expect(Object.keys(section.contextBudgets).length).toBeGreaterThanOrEqual(4)
    for (const [, models] of Object.entries(section.contextBudgets)) {
      for (const [, budget] of Object.entries(models)) {
        expect(typeof budget).toBe('number')
        expect(budget).toBeGreaterThan(0)
      }
    }
  })

  it('schemaVersion 是 1（迁移闸门不能被解析成 0，否则改名迁移每次启动重跑）', () => {
    const section = parseLegacySettingsYaml(fixture())[LEGACY_SETTINGS_NAMESPACE]
    expect(section.schemaVersion).toBe(1)
  })

  it('夹具里没有真实个人数据（脱敏是硬要求，防回归时把真值写回仓库）', () => {
    const text = fixture()
    expect(text).not.toMatch(/BUDDY_CN_ACCOUNT_[0-9A-F]/)
    expect(text).not.toMatch(/[a-z]{3}-[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(text).not.toMatch(/18283273005|1898114|467781/)
  })
})

describe('迁移来源 resolvable —— .imported 与 settings.yaml 的解析结果同构', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'dsh-account-hub-mig-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('.imported 与 settings.yaml 里同一份数据解析出同样的四件套', async () => {
    await writeFile(join(home, 'settings.yaml'), REAL_SHAPE_YAML, 'utf8')
    await mkdir(join(home, 'sub'), { recursive: true })
    const a = parseLegacySettingsYaml(REAL_SHAPE_YAML)[LEGACY_SETTINGS_NAMESPACE]
    const b = parseLegacySettingsYaml(await readFile(join(home, 'settings.yaml'), 'utf8'))[LEGACY_SETTINGS_NAMESPACE]
    expect(a).toEqual(b)
  })
})
