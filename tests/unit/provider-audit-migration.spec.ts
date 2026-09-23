/**
 * provider 体检迁移的回归测试（`src/provider-audit-migration.ts`）。
 *
 * ## 这个文件守的是什么
 *
 * 修的是「账号条目的 `provider` 标签与它凭据的真实归属不符」的历史脏数据。
 * 现场案例：`BUDDY_CN_ACCOUNT_5C80F1BE` 里躺着 `iss=…workbuddy.ai` 的国际版
 * 令牌，条目却写着 `buddy-cn`。六条不变量逐条钉死：
 *
 * 1. **国际版凭据挂在 CN 条目下** → 重建为 `buddy`：新 id / 新 ref、凭据拷到新
 *    ref、**旧 ref 一个都不许动**（`credentials.unset` 调用数必须为 0）；
 * 2. **反向**（CN 凭据挂在 `buddy` 条目下）同样重建；
 * 3. **无 `iss` 的老令牌** → 按凭据的 `domain` 判 + `warn` 一条（不猜、不乱建）；
 * 4. **幂等** —— 连跑两次，第二次零写入（被闸门 short-circuit）；
 * 5. **闸门** —— `providerAuditVersion` 达标时整体跳过，哪怕数据是脏的；
 * 6. **正常条目零改动** —— 只落一次版本号，条目 / 凭据 / 关联键逐字段不变。
 *
 * 另外锁死关联键搬运（`checkins` 的 `provider:accountId` 键与 `consumptionCursors`
 * 的值）、冲突（目标 ref 已存在且值不同）与只读凭据源（拷贝失败）两种保守路径。
 *
 * ⚠️ 这里刻意走 **storage 域**（而不是 settings 回退路径）：生产就是它，
 * 而「八件套在 storage 那条 `persist()` 分支里漏带字段」正是最隐蔽的失败形态。
 */

import { describe, expect, it, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AccountPool, ACCOUNT_HUB_SCHEMA_VERSION, PROVIDER_AUDIT_VERSION } from '../../src/account-pool.js'
import { sanitizeAccountHubDocument } from '../../src/account-hub-storage.js'
import {
  PROVIDER_ISSUER_PATTERNS,
  auditProviderAssignments,
  issuerPatternsFor,
  resetAuditProcessFlagForTest,
} from '../../src/provider-audit-migration.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 现场铁证里的两个签发方（真实取值，勿改成编造值）。 */
const INTL_ISSUER = 'https://www.workbuddy.ai/auth/realms/copilot'
const CN_ISSUER = 'https://www.codebuddy.cn/auth/realms/copilot'

/** 造一个「只用于本地归类」的 JWT：`header.payload.signature`，payload 带 iss。 */
function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature-not-verified`
}

/** 一条 Buddy 系凭据（默认形态：中国版，`iss` 与 `domain` 都是中国版）。 */
function makeCredential(overrides: { iss?: string | null; domain?: string } = {}): string {
  const iss = overrides.iss === undefined ? CN_ISSUER : overrides.iss
  const claims: Record<string, unknown> = { exp: 1_900_000_000, nickname: '测试号' }
  if (iss !== null) claims.iss = iss
  return JSON.stringify({
    access_token: makeJwt(claims),
    refresh_token: 'RT',
    expires_at: String(Date.now() + 3_600_000),
    domain: overrides.domain ?? 'copilot.tencent.com',
  })
}

/** 一条账号条目（默认：标签 buddy-cn + 中国版 ref 前缀）。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'buddy-cn-5c80f1be',
    provider: 'buddy-cn',
    nickname: '河童',
    enabled: true,
    credentialRef: 'BUDDY_CN_ACCOUNT_5C80F1BE',
    createdAt: 1_789_000_000_000,
    refreshable: true,
    ...overrides,
  }
}

/**
 * 内存版宿主替身：**storage 域**（global 单例文档）+ credentials + logger。
 *
 * @param seed - 初始文档与凭据。
 */
function makeHarness(seed: {
  accounts?: ProviderAccountEntry[]
  credentials?: Record<string, string>
  checkins?: Record<string, number>
  consumptionCursors?: Record<string, string>
  providerAuditVersion?: number
  schemaVersion?: number
  /** 设为 true 时 `credentials.set` 一律抛错，模拟只读 shadow 源。 */
  readOnlyCredentials?: boolean
} = {}) {
  let global: unknown = {
    accounts: seed.accounts ?? [],
    disabledModels: {},
    contextBudgets: {},
    checkins: seed.checkins ?? {},
    consumption: {},
    consumptionCursors: seed.consumptionCursors ?? {},
    schemaVersion: seed.schemaVersion ?? ACCOUNT_HUB_SCHEMA_VERSION,
    providerAuditVersion: seed.providerAuditVersion ?? 0,
  }
  const credentials = new Map<string, string>(Object.entries(seed.credentials ?? {}))
  const writes: Array<Record<string, unknown>> = []
  const unsetCalls: string[] = []
  const warns: string[] = []
  const errors: string[] = []

  const logger = {
    info: () => {},
    warn: (message: string) => { warns.push(message) },
    error: (message: string) => { errors.push(message) },
  }
  const facility = {
    open: async () => ({
      global: {
        get: () => global,
        set: async (value: unknown) => {
          const snapshot = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
          writes.push(snapshot)
          global = snapshot
        },
      },
      close: async () => {},
    }),
  }
  const ctx = {
    logger,
    get: (key: string) => (key === 'storageDomain' ? facility : undefined),
    dshHomePath: (...segments: string[]) => ['C:', 'nonexistent-dsh-home', ...segments].join('\\'),
    credentials: {
      resolve: async (ref: unknown) => {
        const value = credentials.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' as const }
      },
      set: async (ref: unknown, value: string) => {
        if (seed.readOnlyCredentials === true) throw new Error('credential source is read-only')
        credentials.set(String(ref), value)
      },
      unset: async (ref: unknown) => {
        unsetCalls.push(String(ref))
        credentials.delete(String(ref))
      },
      describe: async (ref: unknown) => ({
        configured: credentials.has(String(ref)), source: 'test' as const, writable: true,
      }),
    },
  } as unknown as Context

  return {
    ctx,
    writes,
    unsetCalls,
    warns,
    errors,
    credentials,
    /** 当前落盘的文档（体检后核对用）。 */
    stored: () => sanitizeAccountHubDocument(global),
    /** 最后一次写入的原始快照（断言「八件套一起带上」）。 */
    lastWrite: () => writes[writes.length - 1],
  }
}

/** 建一个真 `AccountPool` 并打开 storage（与生产 `apply()` 同序）。 */
async function makePool(ctx: Context): Promise<AccountPool> {
  const pool = new AccountPool(ctx)
  await pool.openStorage()
  return pool
}

beforeEach(() => {
  // 模块级「本进程已跑」标记会跨用例残留，必须每次重置。
  resetAuditProcessFlagForTest()
})

describe('PROVIDER_ISSUER_PATTERNS —— 期望域从产品配置派生', () => {
  it('两个 buddy 系产品都在表里，品牌域由 apiDomain / endpoint / 登录站派生', () => {
    expect(PROVIDER_ISSUER_PATTERNS.map((entry) => entry.productId).sort()).toEqual(['buddy', 'buddy-cn'])
    // 国际版：www.workbuddy.ai → 品牌域 workbuddy.ai（endpoint 本身就是登录站）
    expect(issuerPatternsFor('buddy')?.issuerHosts).toContain('workbuddy.ai')
    // 中国版：**登录站与 API 端点不是同一个域** ——
    // API 端点是 copilot.tencent.com，而真实令牌的 iss 指向 www.codebuddy.cn。
    // 两处都必须进品牌域表，否则「国际版令牌挂在 CN 前缀下」这类脏数据有一半
    // 判不出来（只能回退 domain，并给每条正常账号打一条无 iss 警告）。
    expect(issuerPatternsFor('buddy-cn')?.issuerHosts).toContain('codebuddy.cn')
    expect(issuerPatternsFor('buddy-cn')?.issuerHosts).toContain('tencent.com')
    expect(issuerPatternsFor('buddy-cn')?.domains).toContain('copilot.tencent.com')
    // 未知 provider 没有判据（体检据此跳过非 buddy 系账号）。
    expect(issuerPatternsFor('codearts')).toBeUndefined()
  })
})

describe('auditProviderAssignments —— 国际版凭据挂在 CN 条目下（现场案例）', () => {
  it('重建为 buddy：id / ref / 关联键全搬、凭据拷到新 ref、旧 ref 未 unset', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ modelRateLimits: { 'glm-5.3': 1_790_000_000_000 } })],
      credentials: {
        BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential({
          iss: INTL_ISSUER, domain: 'www.workbuddy.ai',
        }),
      },
      checkins: {
        'buddy-cn:buddy-cn-5c80f1be': 1_790_000_000_000,
        // ⚠️ 值必须是**新口径**（下一次可签毫秒时间戳）：`sanitizeCheckins` 会把
        // 小值当旧口径（本地纪元日数）就地换算，写 1 会读成 144000000。
        'qoder:other': 1_800_000_000_000,
      },
      consumptionCursors: { 'buddy-cn': 'buddy-cn-5c80f1be', buddy: 'buddy-keep' },
    })
    const pool = await makePool(h.ctx)
    expect(pool.providerAuditVersion).toBe(0)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.shortCircuited).toBe(false)
    expect(report.rebuilt).toBe(1)
    expect(report.consistent).toBe(0)
    const result = report.accounts[0]
    expect(result.outcome).toBe('rebuilt')
    expect(result.provider).toBe('buddy-cn')
    expect(result.productId).toBe('buddy')
    expect(result.judgedBy).toBe('iss')

    // 条目：provider / id / credentialRef 三项一起改，其余字段逐字保留。
    const accounts = (await pool.listAllAccounts())
    expect(accounts).toHaveLength(1)
    const rebuilt = accounts[0]
    expect(rebuilt.provider).toBe('buddy')
    expect(rebuilt.id).toBe(result.nextId)
    expect(rebuilt.id).toMatch(/^buddy-[0-9a-f]{8}$/)
    expect(rebuilt.credentialRef).toBe(result.nextRef)
    // ref 形状与 account-hub-rpc 的 accountCredentialRefName 一致（DHS ref 正则不允许连字符）
    expect(rebuilt.credentialRef).toMatch(/^BUDDY_ACCOUNT_[0-9A-F]{8}$/)
    expect(rebuilt.nickname).toBe('河童')
    expect(rebuilt.createdAt).toBe(1_789_000_000_000)
    expect(rebuilt.modelRateLimits).toEqual({ 'glm-5.3': 1_790_000_000_000 })

    // 凭据：新 ref 上是同一份内容，旧 ref **一字未动**。
    expect(h.credentials.get(rebuilt.credentialRef)).toBe(h.credentials.get('BUDDY_CN_ACCOUNT_5C80F1BE'))
    expect(h.credentials.has('BUDDY_CN_ACCOUNT_5C80F1BE')).toBe(true)
    expect(h.unsetCalls).toEqual([])

    // 关联键：签到记录整条搬到新键、旧键删除；游标跟着换；别的 provider 不受影响。
    const stored = h.stored()
    expect(stored.checkins).toEqual({
      [`buddy:${rebuilt.id}`]: 1_790_000_000_000,
      'qoder:other': 1_800_000_000_000,
    })
    // ⚠️ 游标的值就是 accountId：**任何** provider 键下写着旧 id 的都要换成新 id
    // （这里 `buddy-cn` 的游标正指向被重建的那条账号）。漏换会让轮转档下一轮
    // 指向一个不存在的 id，静默退回数组首位。
    expect(stored.consumptionCursors).toEqual({
      'buddy-cn': rebuilt.id,
      buddy: 'buddy-keep',
    })

    // 体检版本号落定，且八件套一起写（一次原子写）。
    expect(h.writes).toHaveLength(1)
    expect(h.lastWrite()).toMatchObject({
      providerAuditVersion: PROVIDER_AUDIT_VERSION,
      schemaVersion: ACCOUNT_HUB_SCHEMA_VERSION,
    })
    expect(pool.providerAuditVersion).toBe(PROVIDER_AUDIT_VERSION)
  })

  it('反向：CN 凭据挂在 buddy 条目下 → 重建为 buddy-cn', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-208d9db2', provider: 'buddy', credentialRef: 'BUDDY_ACCOUNT_208D9DB2' })],
      credentials: {
        BUDDY_ACCOUNT_208D9DB2: makeCredential({ iss: CN_ISSUER, domain: 'copilot.tencent.com' }),
      },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(1)
    expect(report.accounts[0].productId).toBe('buddy-cn')
    const rebuilt = (await pool.listAllAccounts())[0]
    expect(rebuilt.provider).toBe('buddy-cn')
    expect(rebuilt.id).toMatch(/^buddy-cn-[0-9a-f]{8}$/)
    expect(rebuilt.credentialRef).toMatch(/^BUDDY_CN_ACCOUNT_[0-9A-F]{8}$/)
    expect(h.credentials.has('BUDDY_ACCOUNT_208D9DB2')).toBe(true)
    expect(h.unsetCalls).toEqual([])
  })

  it('iss 与 domain 互相矛盾时**以 iss 为准**（iss 是签发方，domain 是快照）', async () => {
    // 一份真中国版令牌（iss=codebuddy.cn），但 domain 字段是被写坏的 www.workbuddy.ai：
    // 若判据跟着 domain 走，这条会被误重建为国际版。
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-cn-conflict', credentialRef: 'BUDDY_CN_ACCOUNT_CONFLICT' })],
      credentials: {
        BUDDY_CN_ACCOUNT_CONFLICT: makeCredential({ iss: CN_ISSUER, domain: 'www.workbuddy.ai' }),
      },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(report.accounts[0].outcome).toBe('consistent')
    expect(report.accounts[0].judgedBy).toBe('iss')
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy-cn')
  })
})

describe('auditProviderAssignments —— 无 iss 的老令牌', () => {
  it('按 domain 判定归属并 warn（不猜、标签不符才重建）', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-cn-legacy', credentialRef: 'BUDDY_CN_ACCOUNT_LEGACY' })],
      credentials: {
        // 老令牌：没有 iss 声明，只有 domain —— 且 domain 指向国际版端点。
        BUDDY_CN_ACCOUNT_LEGACY: makeCredential({ iss: null, domain: 'www.workbuddy.ai' }),
      },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(1)
    expect(report.accounts[0].judgedBy).toBe('domain')
    expect(report.accounts[0].productId).toBe('buddy')
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy')
    // 告警必须含 ref 与 domain，便于人工核。
    const warn = h.warns.find((message) => message.includes('BUDDY_CN_ACCOUNT_LEGACY'))
    expect(warn).toBeDefined()
    expect(warn).toContain('www.workbuddy.ai')
    expect(warn).toContain('请人工核对')
  })

  it('domain 与标签一致时零重建（老令牌不是脏数据的同义词）', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-cn-legacy2', credentialRef: 'BUDDY_CN_ACCOUNT_LEGACY2' })],
      credentials: {
        BUDDY_CN_ACCOUNT_LEGACY2: makeCredential({ iss: null, domain: 'copilot.tencent.com' }),
      },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(report.consistent).toBe(1)
    expect((await pool.listAllAccounts())[0].credentialRef).toBe('BUDDY_CN_ACCOUNT_LEGACY2')
    // 仍然 warn 一条（老令牌没有 iss 这件事本身要留痕），但不改动数据。
    expect(h.warns.some((message) => message.includes('无 iss 声明'))).toBe(true)
  })

  it('既非 buddy 也非 buddy-cn 的签发方 → 保守不动手', async () => {
    const h = makeHarness({
      accounts: [makeEntry({ id: 'buddy-cn-alien', credentialRef: 'BUDDY_CN_ACCOUNT_ALIEN' })],
      credentials: {
        BUDDY_CN_ACCOUNT_ALIEN: makeCredential({
          iss: 'https://accounts.google.com', domain: 'example.com',
        }),
      },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(report.skipped).toBe(1)
    expect(report.accounts[0].outcome).toBe('unjudged')
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy-cn')
    expect(h.credentials.has('BUDDY_CN_ACCOUNT_ALIEN')).toBe(true)
  })
})

describe('auditProviderAssignments —— 闸门与幂等', () => {
  it('providerAuditVersion 已达标时整体跳过（哪怕数据是脏的）', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential({ iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }) },
      providerAuditVersion: PROVIDER_AUDIT_VERSION,
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.shortCircuited).toBe(true)
    expect(report.wrote).toBe(false)
    expect(h.writes).toEqual([])
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy-cn')
    expect(h.credentials.has('BUDDY_CN_ACCOUNT_5C80F1BE')).toBe(true)
  })

  it('**独立闸门**：schemaVersion 已是最新也不 short-circuit，体检照跑', async () => {
    // 这条钉的是本次事故的教训：当年体检的闸门判据与改名迁移共用
    // `schemaVersion`，而它早已达标 ⇒ 体检**从未执行**、脏数据活到今天。
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential({ iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }) },
      schemaVersion: ACCOUNT_HUB_SCHEMA_VERSION,
      providerAuditVersion: 0,
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.shortCircuited).toBe(false)
    expect(report.rebuilt).toBe(1)
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy')
  })

  it('幂等：第二次调用不再写入（版本号已由第一次落定）', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential({ iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }) },
    })
    const pool = await makePool(h.ctx)

    const first = await auditProviderAssignments(pool, h.ctx)
    const writesAfterFirst = h.writes.length
    const accountsAfterFirst = await pool.listAllAccounts()

    const second = await auditProviderAssignments(pool, h.ctx)

    expect(first.rebuilt).toBe(1)
    expect(first.wrote).toBe(true)
    expect(second.shortCircuited).toBe(true)
    expect(second.wrote).toBe(false)
    expect(h.writes).toHaveLength(writesAfterFirst)
    // 数据不再被二次改动（新 ref 是随机的 —— 再跑一次就会多出一份凭据）。
    expect(await pool.listAllAccounts()).toEqual(accountsAfterFirst)
  })

  it('正常条目零改动：只落一次版本号，条目 / 凭据 / 关联键不变', async () => {
    const entry = makeEntry({ id: 'buddy-cn-e8e0b0f3', credentialRef: 'BUDDY_CN_ACCOUNT_E8E0B0F3' })
    const h = makeHarness({
      accounts: [entry],
      credentials: { BUDDY_CN_ACCOUNT_E8E0B0F3: makeCredential({ iss: CN_ISSUER }) },
      checkins: { 'buddy-cn:buddy-cn-e8e0b0f3': 1_790_000_000_000 },
      consumptionCursors: { 'buddy-cn': 'buddy-cn-e8e0b0f3' },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(report.consistent).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.wrote).toBe(true)
    expect(h.unsetCalls).toEqual([])
    expect(h.errors).toEqual([])
    expect(await pool.listAllAccounts()).toEqual([entry])
    expect(h.stored().checkins).toEqual({ 'buddy-cn:buddy-cn-e8e0b0f3': 1_790_000_000_000 })
    expect(h.stored().consumptionCursors).toEqual({ 'buddy-cn': 'buddy-cn-e8e0b0f3' })
    expect(h.stored().providerAuditVersion).toBe(PROVIDER_AUDIT_VERSION)
    // 幂等：第二次整体跳过，不再写。
    resetAuditProcessFlagForTest()
    const again = await auditProviderAssignments(await makePool(h.ctx), h.ctx)
    expect(again.shortCircuited).toBe(true)
    expect(h.writes).toHaveLength(1)
  })
})

describe('auditProviderAssignments —— 保守路径', () => {
  it('非 buddy 系账号不进体检（连凭据都不读），原样保留', async () => {
    const codearts: ProviderAccountEntry = {
      id: 'codearts-a1b2c3d4',
      provider: 'codearts',
      nickname: '华为云',
      enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_A1B2C3D4',
      createdAt: 1_789_000_000_000,
      refreshable: true,
    }
    const h = makeHarness({
      accounts: [codearts],
      // 故意给它塞一份「像 buddy 国际版」的凭据：体检**不该**去读它、更不该重建。
      credentials: { CODEARTS_ACCOUNT_A1B2C3D4: makeCredential({ iss: INTL_ISSUER }) },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(await pool.listAllAccounts()).toEqual([codearts])
    expect(h.credentials.has('CODEARTS_ACCOUNT_A1B2C3D4')).toBe(true)
    expect(h.warns).toEqual([])
  })

  it('凭据缺失时不动手、不抛错', async () => {
    const h = makeHarness({ accounts: [makeEntry()] })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.rebuilt).toBe(0)
    expect(report.skipped).toBe(1)
    expect((await pool.listAllAccounts())[0].credentialRef).toBe('BUDDY_CN_ACCOUNT_5C80F1BE')
  })

  it('凭据 JSON 损坏时不动手', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: '{not json' },
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.skipped).toBe(1)
    expect(h.credentials.has('BUDDY_CN_ACCOUNT_5C80F1BE')).toBe(true)
  })

  it('只读凭据源（set 抛错）时整条保持原样，不 unset 任何东西', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential({ iss: INTL_ISSUER, domain: 'www.workbuddy.ai' }) },
      readOnlyCredentials: true,
    })
    const pool = await makePool(h.ctx)

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.accounts[0].outcome).toBe('copy-failed')
    expect((await pool.listAllAccounts())[0].provider).toBe('buddy-cn')
    expect((await pool.listAllAccounts())[0].credentialRef).toBe('BUDDY_CN_ACCOUNT_5C80F1BE')
    expect(h.unsetCalls).toEqual([])
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('listAllAccounts 抛错时只记 error，不向调用方抛出（fire-and-forget 安全）', async () => {
    const h = makeHarness({ accounts: [] })
    const pool = await makePool(h.ctx)
    pool.listAllAccounts = async () => { throw new Error('storage 读取失败') }

    const report = await auditProviderAssignments(pool, h.ctx)

    expect(report.wrote).toBe(false)
    expect(h.errors.some((message) => message.includes('storage 读取失败'))).toBe(true)
  })
})

describe('AccountPool.removeAccount —— 先写条目、后 unset 凭据', () => {
  it('unset 抛错时条目已被删除，且不回滚', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential() },
    })
    const pool = await makePool(h.ctx)
    // 让 unset 失败：模拟凭据存储只读 / 外部删除竞态。
    ;(h.ctx as unknown as { credentials: { unset: () => Promise<void> } }).credentials.unset =
      async () => { throw new Error('credentials store is read-only') }

    await expect(pool.removeAccount('buddy-cn-5c80f1be')).resolves.toBeUndefined()

    // 条目先落盘 ⇒ 最坏形态是「孤儿凭据但无条目」（无害），而不是「条目指向错凭据」。
    expect(await pool.listAllAccounts()).toEqual([])
    expect(h.warns.some((message) => message.includes('未能清理'))).toBe(true)
  })

  it('正常路径仍然「删条目 + 清凭据」，且 unset 发生在条目落盘之后', async () => {
    const h = makeHarness({
      accounts: [makeEntry()],
      credentials: { BUDDY_CN_ACCOUNT_5C80F1BE: makeCredential() },
    })
    const pool = await makePool(h.ctx)

    await pool.removeAccount('buddy-cn-5c80f1be')

    expect(await pool.listAllAccounts()).toEqual([])
    expect(h.credentials.has('BUDDY_CN_ACCOUNT_5C80F1BE')).toBe(false)
    expect(h.unsetCalls).toEqual(['BUDDY_CN_ACCOUNT_5C80F1BE'])
    // 写入已经发生（条目下发早于凭据清理）。
    expect(h.writes.length).toBe(1)
  })
})
