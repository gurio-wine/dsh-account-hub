/**
 * Qoder **账号卡片资料**（昵称 + 有效期）的纯函数与「惰性回填」链。
 *
 * ## 修的是什么缺陷
 *
 * 真机两区账号卡片的「昵称」显示成 UUID、「有效期」显示成「未知」：
 *
 * 1. **昵称**：登录链把 `credential.user_id`（UUIDv7）当昵称写进账号池
 *    （`src/qoder-auth.ts` 的 `persistDeviceToken` / `loginWithPat`），而真正的
 *    用户资料在 `GET {openapiBase}/api/v1/userinfo` 里 —— 那个端点此前只被
 *    签名链拿 uid 时调用，且 `readQoderUserIdentity` 把 `name` / `email` 丢掉。
 * 2. **有效期**：设备流凭据本来带 `token_expires_at`（≈30 天），但
 *    `persistDeviceToken` 的 `updateAccount` 只写了 nickname + refreshable，
 *    **没写 expiresAt**；于是客户端 `account.expiresAt ? … : '未知'` 恒落到「未知」。
 * 3. **存量账号**：只修新登录不够 —— 盘上那几条的昵称**已经是** UUID 了，
 *    必须有一条幂等的回填链把它们拉回来。
 *
 * ## 本文件钉死的三条纪律
 *
 * - **PAT 凭据绝不写 expiresAt**：它里面的 `token_expires_at` 是 **jt（运行时
 *   缓存）** 的过期时刻，不是 PAT 的有效期。写进账号卡片会让它在闲置 24h 后
 *   显示「已过期」，而实际上一次 `getJobToken()` 就能自愈 —— 那是纯粹的假警报。
 * - **幂等必须真的零出网**：回填的触发判据只看「现在缺什么」，改过之后下一次
 *   必须一次网都不出（否则每 30 分钟的续期链会白打 userinfo 到天荒地老）。
 * - **userinfo 失败绝不炸登录**：取不到就回落到 `user_id`，与改动前逐字一致。
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderAuth } from '../../src/qoder-auth.js'
import {
  QODER,
  QODER_CN,
  isQoderNicknamePlaceholder,
  maskQoderMobile,
  needsQoderAccountProfileBackfill,
  qoderAccountExpiresAtMs,
  resolveQoderAccountNickname,
  type QoderCredential,
} from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 现存真机账号的形态：昵称是 exchange / 设备流给的 UUIDv7 用户 id。 */
const UUID_USER_ID = '01a0bb7a-07d3-742f-b1d6-7bfc3d5f337e'

/** 所有已创建的 service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: QoderAuth[] = []

/** 设备流用例建的临时 home 目录；afterEach 统一删除（不碰用户真实 `~/.qoder`）。 */
const tempHomes: string[] = []

/** 最小化的内存凭据提供者（形状与 ctx.credentials 一致）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  readonly writes: string[] = []
  async resolve(ref: unknown) {
    const value = this.store.get(String(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const key = String(ref)
    return { configured: this.store.has(key), source: this.store.has(key) ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) {
    const key = String(ref)
    this.store.set(key, value)
    this.writes.push(key)
  }
  async unset(ref: unknown) { this.store.delete(String(ref)) }
  raw(ref: string): string | undefined { return this.store.get(ref) }
  /**
   * 清空写入记录（**播种后必须调**）。
   *
   * 用例开头那次 `set` 是**播种**、不是被测行为；不清掉它，「本轮一次凭据都
   * 没写」这类断言会把播种算进去从而永远为假 —— 那会让「幂等」这条最重要的
   * 断言退化成一条空断言。
   */
  clearWrites(): void { this.writes.length = 0 }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

interface ServiceOptions {
  fetcher: typeof fetch
  product?: typeof QODER
  deviceFlow?: { homeDir: string }
}

function newService(ctx: Context, options: ServiceOptions): QoderAuth {
  const service = new QoderAuth(ctx, options)
  services.push(service)
  return service
}

/** 记录每次请求的 fetch stub。 */
interface StubFetch {
  fetcher: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
}

function stubFetcher(handler: (url: string) => Response | Promise<Response>): StubFetch {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url)
    calls.push({ url: target, init })
    return handler(target)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** userinfo 成功响应（真机形态：`name` 才是可展示的昵称）。 */
function userinfoSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    id: UUID_USER_ID,
    name: '河童',
    username: 'kappa',
    email: 'kappa@example.test',
    source: 'qoder',
    security_mobile: '18939953995',
    ...overrides,
  }), { status: 200 })
}

/** exchange 成功响应（PAT 路径的 jt 来源）。 */
function exchangeSuccess(): Response {
  return new Response(JSON.stringify({
    token: 'jt-vuFDqRTQFaIblIxdalT2v5aJ',
    expires_in: 86_400_000,
    refresh_token: 'jrt-1',
  }), { status: 200 })
}

/**
 * 一个**会真的应用 updateAccount** 的账号池桩。
 *
 * ⚠️ 补丁必须落到内存条目上，否则「第二次调用零出网」这条**幂等**断言毫无意义
 * ——账号永远还是 UUID 形，回填每次都触发，而那正是要防的退化。
 */
function makePool(accounts: ProviderAccountEntry[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const listed: string[] = []
  return {
    updates,
    listed,
    entry(id: string) { return accounts.find((a) => a.id === id) },
    async listAccounts(provider: string) {
      listed.push(provider)
      return accounts.filter((a) => a.provider === provider)
    },
    async updateAccount(id: string, patch: Record<string, unknown>) {
      updates.push({ id, patch })
      const target = accounts.find((a) => a.id === id)
      if (target !== undefined) Object.assign(target, patch)
    },
  }
}

/** 一个设备流账号条目（昵称是 UUID 形的占位 —— 正是存量账号的形态）。 */
function deviceEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'qoder-a1b2c3d4',
    provider: 'qoder',
    nickname: UUID_USER_ID,
    enabled: true,
    credentialRef: 'QODER_ACCOUNT_A1B2C3D4',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 一份设备流凭据（`dt-` + drt + token_expires_at 齐全）。 */
function deviceCredential(expiresAtMs: number): QoderCredential {
  return {
    access_token: 'dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e',
    refresh_token: 'drt-Ym3pQw8tZc5vNb2kLd7xRf4hJs9gTe6a',
    token_expires_at: String(expiresAtMs),
    user_id: UUID_USER_ID,
  }
}

/** 一份 PAT 凭据（`pt-`；`token_expires_at` 是 **jt** 的过期时刻，不是凭据有效期）。 */
function patCredential(expiresAtMs: number): QoderCredential {
  return {
    access_token: 'pt-tZbovGIr8vR8ZvD4lFoPZnve_01a0bb8c',
    refresh_token: 'jrt-1',
    token_expires_at: String(expiresAtMs),
    user_id: UUID_USER_ID,
  }
}

afterEach(async () => {
  for (const service of services) service.cancelPendingLogin('测试清理')
  for (const service of services) service.stop()
  services.length = 0
  for (const dir of tempHomes.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// A. 昵称取值与「占位形」判据（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveQoderAccountNickname：真实昵称 → 邮箱 → 脱敏手机 → user_id → 账号 id', () => {
  it('displayName（userinfo 的 name）优先', () => {
    expect(resolveQoderAccountNickname(
      { displayName: '河童', email: 'k@e.test', mobile: '18939953995', userId: UUID_USER_ID },
      'qoder-a1b2c3d4',
    )).toBe('河童')
  })

  it('没有 displayName 时退到 email（userinfo 只回了邮箱的账号形态）', () => {
    expect(resolveQoderAccountNickname(
      { email: 'k@e.test', mobile: '18939953995', userId: UUID_USER_ID },
      'qoder-a1b2c3d4',
    )).toBe('k@e.test')
  })

  it('再退到**脱敏后**的手机号（对齐 buddy / lobsterai 卡片的 `189****3995` 惯例）', () => {
    expect(resolveQoderAccountNickname({ mobile: '18939953995', userId: UUID_USER_ID }, 'qoder-a1b2c3d4'))
      .toBe('189****3995')
  })

  it('最后回落到服务端 user_id（**与改动前逐字一致**，不是新编的兜底）', () => {
    expect(resolveQoderAccountNickname({ userId: UUID_USER_ID }, 'qoder-a1b2c3d4')).toBe(UUID_USER_ID)
  })

  it('什么都没有（来源 undefined）时用账号 id', () => {
    expect(resolveQoderAccountNickname(undefined, 'qoder-a1b2c3d4')).toBe('qoder-a1b2c3d4')
    expect(resolveQoderAccountNickname({}, 'qoder-a1b2c3d4')).toBe('qoder-a1b2c3d4')
  })

  it('空白值不算昵称（不能把 "   " 当成真名写进卡片）', () => {
    expect(resolveQoderAccountNickname(
      { displayName: '   ', email: '', mobile: '', userId: 'u-1' },
      'qoder-a1b2c3d4',
    )).toBe('u-1')
  })
})

describe('maskQoderMobile：脱敏成 189****3995', () => {
  it('11 位手机号保留前 3 后 4', () => {
    expect(maskQoderMobile('18939953995')).toBe('189****3995')
  })

  it('容忍空白与连字符 / 国家码前缀里的分隔符', () => {
    expect(maskQoderMobile('  189 3995 3995  ')).toBe('189****3995')
    expect(maskQoderMobile('189-3995-3995')).toBe('189****3995')
  })

  it('位数不足或没有数字 ⇒ undefined（**不编造**一个脱敏形态）', () => {
    expect(maskQoderMobile('12345')).toBeUndefined()
    expect(maskQoderMobile('')).toBeUndefined()
    expect(maskQoderMobile('   ')).toBeUndefined()
    expect(maskQoderMobile('not-a-phone')).toBeUndefined()
  })
})

describe('isQoderNicknamePlaceholder：UUID 形 / 空串才是占位', () => {
  it('UUIDv7 形（登录链写死的那个值）判为占位', () => {
    expect(isQoderNicknamePlaceholder(UUID_USER_ID)).toBe(true)
    // 大小写两种写法都认（UUID 是十六进制，上游可能大写）。
    expect(isQoderNicknamePlaceholder(UUID_USER_ID.toUpperCase())).toBe(true)
    expect(isQoderNicknamePlaceholder(`  ${UUID_USER_ID}  `)).toBe(true)
  })

  it('空串 / 纯空白判为占位（占位条目与历史脏数据）', () => {
    expect(isQoderNicknamePlaceholder('')).toBe(true)
    expect(isQoderNicknamePlaceholder('   ')).toBe(true)
  })

  it('真实昵称、邮箱、账号 id、脱敏手机号都**不是**占位（改过即不再触发）', () => {
    for (const value of ['河童', 'kappa@example.test', 'qoder-a1b2c3d4', '189****3995', '测试用户']) {
      expect(isQoderNicknamePlaceholder(value), value).toBe(false)
    }
  })
})

describe('qoderAccountExpiresAtMs：只有**设备令牌**才有可报告的有效期', () => {
  it('设备令牌凭据：取 token_expires_at（毫秒串）', () => {
    const expires = Date.now() + 30 * 86_400_000
    expect(qoderAccountExpiresAtMs(deviceCredential(expires))).toBe(expires)
  })

  it('PAT 凭据：**恒 undefined** —— 那个字段是 jt 的过期时刻，不是 PAT 的有效期', () => {
    // 写进去会让卡片在闲置 24h 后显示「已过期」，而 getJobToken() 会按需重换、
    // 一切正常 —— 那是纯粹的假警报（与 `checkExpired` 同因）。
    expect(qoderAccountExpiresAtMs(patCredential(Date.now() + 86_400_000))).toBeUndefined()
  })
})

describe('needsQoderAccountProfileBackfill：触发判据必须幂等', () => {
  it('UUID 形昵称 ⇒ 需要回填（存量账号的形态）', () => {
    expect(needsQoderAccountProfileBackfill(
      { nickname: UUID_USER_ID },
      deviceCredential(Date.now() + 86_400_000),
    )).toBe(true)
  })

  it('真实昵称 + 已填有效期 ⇒ **不需要**（改过就不再拉）', () => {
    expect(needsQoderAccountProfileBackfill(
      { nickname: '河童', expiresAt: Date.now() + 86_400_000 },
      deviceCredential(Date.now() + 86_400_000),
    )).toBe(false)
  })

  it('真实昵称但缺有效期（设备令牌）⇒ 仍需回填一次', () => {
    expect(needsQoderAccountProfileBackfill(
      { nickname: '河童' },
      deviceCredential(Date.now() + 86_400_000),
    )).toBe(true)
  })

  it('PAT 账号缺有效期**不算**待回填 —— 否则每 30 分钟白打一次 userinfo', () => {
    // 这是本判据最容易写错的一处：PAT 的有效期永远解析不出来，
    // 拿「expiresAt 缺失」当触发条件会让回填变成永不停止的轮询。
    expect(needsQoderAccountProfileBackfill(
      { nickname: '河童' },
      patCredential(Date.now() + 86_400_000),
    )).toBe(false)
  })

  it('凭据取不到时只有昵称是占位才触发（不回填一个没有凭据的幽灵账号）', () => {
    expect(needsQoderAccountProfileBackfill({ nickname: UUID_USER_ID }, undefined)).toBe(true)
    expect(needsQoderAccountProfileBackfill({ nickname: '河童' }, undefined)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 惰性回填链（宿主侧）
// ─────────────────────────────────────────────────────────────────────────────

describe('QoderAuth.backfillAccountProfiles：存量账号的昵称与有效期回填', () => {
  it('UUID 形昵称 ⇒ 拉一次 userinfo，昵称 / expiresAt 落到账号，user_name 落到凭据', async () => {
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 30 * 86_400_000
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(expires)))
    const pool = makePool([deviceEntry()])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    // 只打一次，且打在 **openapi** 的 userinfo 上（不是 chat / models 基址）。
    // `dt-` 的 getJobToken 是恒等，故这里不会多出一次 exchange。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openapi.qoder.sh/api/v1/userinfo')
    expect(calls[0]!.init?.method).toBe('GET')
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization)
      .toBe('Bearer dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e')
    expect(pool.listed).toEqual(['qoder'])
    expect(pool.updates).toEqual([{ id: 'qoder-a1b2c3d4', patch: { nickname: '河童', expiresAt: expires } }])
    // 凭据也一并升级：写回 user_name / email，下一次展示不必再拉。
    const stored = JSON.parse(credentials.raw('QODER_ACCOUNT_A1B2C3D4')!) as QoderCredential
    expect(stored.user_name).toBe('河童')
    expect(stored.email).toBe('kappa@example.test')
    // 令牌本体**一个字节都不能动**（改它等于把账号废掉）。
    expect(stored.access_token).toBe('dt-Kq7vRt2mXp9sLd4nBc6yZg1hJf8wQa3e')
    expect(stored.refresh_token).toBe('drt-Ym3pQw8tZc5vNb2kLd7xRf4hJs9gTe6a')
  })

  it('**幂等**：改过之后再跑一次，一次网都不出、一个字段都不写', async () => {
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 30 * 86_400_000
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(expires)))
    credentials.clearWrites()
    const pool = makePool([deviceEntry()])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)
    const firstRound = calls.length
    expect(firstRound).toBe(1)
    // 第一轮确实写了凭据（补上 user_name / email）—— 这正是第二轮该省掉的动作。
    expect(credentials.writes).toHaveLength(1)
    // 第二轮：条目已被上一轮改成真名 + 有效期 ⇒ 判据不再触发。
    await service.backfillAccountProfiles(pool as never)

    expect(calls).toHaveLength(firstRound)
    expect(pool.updates).toHaveLength(1)
    expect(credentials.writes).toHaveLength(1)
  })

  it('userinfo 失败（404）⇒ **不炸**、不改昵称，下次还能重试', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(Date.now() + 86_400_000)))
    credentials.clearWrites()
    const pool = makePool([deviceEntry()])
    const { fetcher } = stubFetcher(() => new Response('not found', { status: 404 }))
    const service = newService(ctx, { fetcher })

    await expect(service.backfillAccountProfiles(pool as never)).resolves.toBeUndefined()

    // 昵称保持原样（改成「取不到」那种占位会让用户看到更糟的东西）。
    expect(pool.entry('qoder-a1b2c3d4')!.nickname).toBe(UUID_USER_ID)
    expect(credentials.writes).toEqual([])
  })

  it('userinfo 传输层失败（断网）同样静默 —— 不能把一次断网变成未捕获拒绝', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(Date.now() + 86_400_000)))
    const pool = makePool([deviceEntry()])
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const service = newService(ctx, { fetcher })

    await expect(service.backfillAccountProfiles(pool as never)).resolves.toBeUndefined()
    expect(pool.updates).toEqual([])
  })

  it('PAT 账号：昵称回填，但**绝不**补 expiresAt（jt 的 24h ≠ PAT 的有效期）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_PAT', JSON.stringify(patCredential(Date.now() + 86_400_000)))
    const pool = makePool([deviceEntry({ id: 'qoder-pat1', credentialRef: 'QODER_ACCOUNT_PAT' })])
    const { fetcher, calls } = stubFetcher((url) => (url.includes('/api/v1/userinfo')
      ? userinfoSuccess()
      : exchangeSuccess()))
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    // PAT 要先换 jt 才能打 userinfo（两令牌族同一套代码，分派在 getJobToken 里）。
    expect(calls.map((c) => c.url)).toEqual([
      'https://openapi.qoder.sh/api/v1/jobToken/exchange',
      'https://openapi.qoder.sh/api/v1/userinfo',
    ])
    expect(pool.updates).toEqual([{ id: 'qoder-pat1', patch: { nickname: '河童' } }])
    // 凭据里那个 token_expires_at 是 jt 的过期时刻，**不进**账号卡片。
    expect(pool.updates[0]!.patch).not.toHaveProperty('expiresAt')
    // 第二轮零出网 —— PAT 的 expiresAt 永远解析不出来，若判据把它算作
    // 「待回填」，这里就会每 30 分钟白打一次 exchange + userinfo。
    calls.length = 0
    await service.backfillAccountProfiles(pool as never)
    expect(calls).toEqual([])
  })

  it('只看本 region 的账号（CN 实例绝不碰国际版账号，反之亦然）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_CN_ACCOUNT_CN1', JSON.stringify(deviceCredential(Date.now() + 86_400_000)))
    const pool = makePool([
      deviceEntry({ id: 'intl-1' }),
      deviceEntry({ id: 'cn-1', provider: 'qoder-cn', credentialRef: 'QODER_CN_ACCOUNT_CN1' }),
    ])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher, product: QODER_CN })

    await service.backfillAccountProfiles(pool as never)

    expect(pool.listed).toEqual(['qoder-cn'])
    expect(calls).toHaveLength(1)
    // 两区令牌互不承认：打错 host 的失败形态是「凭据失效」的假象。
    expect(calls[0]!.url).toBe('https://openapi.qoder.com.cn/api/v1/userinfo')
    // expiresAt 走同一个解析口径（毫秒串 → 数字），两个 region 共用一份实现。
    const cnCredential = JSON.parse(credentials.raw('QODER_CN_ACCOUNT_CN1')!) as QoderCredential
    expect(pool.updates).toEqual([
      { id: 'cn-1', patch: { nickname: '河童', expiresAt: Number(cnCredential.token_expires_at) } },
    ])
  })

  it('昵称已是真名但缺有效期（设备令牌）⇒ 只补有效期，**不发任何请求**', async () => {
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 30 * 86_400_000
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(expires)))
    const pool = makePool([deviceEntry({ nickname: '河童' })])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    // 名字已经不用改了 ⇒ 没有理由为它再打一次 userinfo。
    expect(calls).toEqual([])
    expect(pool.updates).toEqual([{ id: 'qoder-a1b2c3d4', patch: { expiresAt: expires } }])
  })

  it('凭据里已存 user_name（账号条目漏更新）⇒ **零出网**直接补昵称', async () => {
    // 登录链写凭据与补账号条目是两步；第二步失败过的话，凭据里其实已经有真名了。
    // 这时再打一次 userinfo 纯属白跑 —— 本地就能算出真名。
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 30 * 86_400_000
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify({
      ...deviceCredential(expires),
      user_name: '河童',
      email: 'kappa@example.test',
    } satisfies QoderCredential))
    credentials.clearWrites()
    const pool = makePool([deviceEntry()])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    expect(calls).toEqual([])
    expect(credentials.writes).toEqual([])
    expect(pool.entry('qoder-a1b2c3d4')!.nickname).toBe('河童')
  })

  it('凭据缺失的账号被跳过（不发请求、不写字段）', async () => {
    const { ctx } = makeContext()
    const pool = makePool([deviceEntry()])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    expect(calls).toEqual([])
    expect(pool.updates).toEqual([])
  })

  it('**用户手改过的昵称绝不被覆盖**（只补有效期，不改名）', async () => {
    // 判据是「昵称是不是占位形」，不是「昵称和凭据里的对不对得上」。
    // 后者会让用户改的名字被机器按凭据内容冲掉，且**不报错** ——
    // 用户会看到自己起的名字莫名其妙变回去。
    const { ctx, credentials } = makeContext()
    const expires = Date.now() + 30 * 86_400_000
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(expires)))
    credentials.clearWrites()
    const pool = makePool([deviceEntry({ nickname: '我的小号' })])
    const { fetcher, calls } = stubFetcher(() => userinfoSuccess())
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    // 名字不是占位形 ⇒ 没有理由为它出网，更没有理由改它。
    expect(calls).toEqual([])
    expect(pool.updates).toEqual([{ id: 'qoder-a1b2c3d4', patch: { expiresAt: expires } }])
    expect(pool.entry('qoder-a1b2c3d4')!.nickname).toBe('我的小号')
    expect(credentials.writes).toEqual([])
  })

  it('userinfo 只有手机号（无 name / email）⇒ 昵称取**脱敏**手机号，原文不落账号', async () => {
    // 真机上存在没有 `name` 的账号形态。脱敏是展示层职责，**必须**在这里生效：
    // 直接把 `18939953995` 写进昵称会让手机号明文出现在设置页与日志里。
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(Date.now() + 86_400_000)))
    const pool = makePool([deviceEntry()])
    const { fetcher } = stubFetcher(() => userinfoSuccess({
      name: '', email: '', security_mobile: '18939953995',
    }))
    const service = newService(ctx, { fetcher })

    await service.backfillAccountProfiles(pool as never)

    expect(pool.entry('qoder-a1b2c3d4')!.nickname).toBe('189****3995')
    expect(pool.entry('qoder-a1b2c3d4')!.nickname).not.toContain('39953995')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 续期链的写回（设备令牌成功续期后，账号卡片的有效期要跟着走）
// ─────────────────────────────────────────────────────────────────────────────

describe('QoderAuth.refreshAll：设备令牌续期成功后回写账号有效期', () => {
  it('临近过期的设备账号续期 ⇒ updateAccount 带上新的 expiresAt', async () => {
    const { ctx, credentials } = makeContext()
    // 1 分钟 < 1h 提前窗口 ⇒ 必须续期。
    await credentials.set('QODER_ACCOUNT_A1B2C3D4', JSON.stringify(deviceCredential(Date.now() + 60_000)))
    const pool = makePool([deviceEntry({ nickname: '河童', expiresAt: Date.now() + 60_000 })])
    const homeDir = await mkdtemp(join(tmpdir(), 'qoder-refresh-writeback-'))
    tempHomes.push(homeDir)
    const newExpires = Date.now() + 30 * 86_400_000
    const { fetcher, calls } = stubFetcher((url) => (url.includes('/api/v1/deviceToken/refresh')
      ? new Response(JSON.stringify({
          device_token: 'dt-renewed',
          refresh_token: 'drt-renewed',
          expires_at: new Date(newExpires).toISOString(),
        }), { status: 200 })
      : userinfoSuccess()))
    const service = newService(ctx, { fetcher, deviceFlow: { homeDir } })

    await service.refreshAll(pool as never)

    // 续期成功 ⇒ 账号卡片的有效期必须跟着新凭据走（否则一直显示旧的到期日）。
    expect(calls.some((c) => c.url.includes('/api/v1/deviceToken/refresh'))).toBe(true)
    expect(pool.updates).toHaveLength(1)
    expect(pool.updates[0]!.id).toBe('qoder-a1b2c3d4')
    expect(Number(pool.updates[0]!.patch.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    const stored = JSON.parse(credentials.raw('QODER_ACCOUNT_A1B2C3D4')!) as QoderCredential
    expect(stored.access_token).toBe('dt-renewed')
  })

  it('PAT 账号续期后**不写** expiresAt（与登录路径同口径）', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('QODER_ACCOUNT_PAT', JSON.stringify(patCredential(Date.now() + 86_400_000)))
    const pool = makePool([deviceEntry({
      id: 'qoder-pat1', credentialRef: 'QODER_ACCOUNT_PAT', nickname: '河童',
    })])
    const { fetcher } = stubFetcher(() => exchangeSuccess())
    const service = newService(ctx, { fetcher })

    await service.refreshAll(pool as never)

    expect(pool.updates).toEqual([])
  })
})
