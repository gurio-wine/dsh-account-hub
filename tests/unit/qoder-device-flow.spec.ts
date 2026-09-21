/**
 * Qoder 浏览器设备流登录 —— **协议层**测试（两个 region 共用一份实现）。
 *
 * ## 本文件覆盖什么
 *
 * 设备流是 Qoder 新增的**第二种登录形态**（PAT 粘贴并存保留），三步协议：
 * PKCE → 登录 URL → 轮询换令牌。全部取自官方 CLI 的 `nec()` 与桌面端
 * `startDeviceFlow`（同构，只有域名不同），故这里逐条钉死**照抄来的**事实，
 * 而不是「看起来合理」的构造：
 *
 * 1. **PKCE**：verifier 64 字符随机、challenge = base64url(sha256(verifier))、
 *    `challenge_method: "S256"`；nonce = UUID；
 * 2. **登录 URL**：`{authBaseUrl}/device/selectAccounts?challenge&challenge_method
 *    &nonce&machine_id&client_id` —— 字段名逐字符照抄，**CN 不带 `redirect_uri`**；
 * 3. **轮询**：`GET {openapiBase}/api/v1/deviceToken/poll?nonce&verifier
 *    &challenge_method`，**404 → 1 秒后重试**、总超时 **5 分钟**，成功判据是
 *    「`token` 与 `refresh_token` **都是 string**」。
 *
 * ## 为什么重试节奏不用 `vi.useFakeTimers()`
 *
 * 「404 后等 1 秒再试」这件事的可断言对象是**注入的 sleep 收到了什么参数**，
 * 而不是「系统时钟走过了 1000ms」。故这里注入一个**记录型 sleep**（记录入参后
 * 立即 resolve）：既让节奏变成可断言的确定事实，又不必真等 5 分钟超时。
 * 这与假定时器的意图一致，且不会与 fetch 的 microtask 队列互相干扰。
 *
 * ## machine_id 绝不落到真实的 `~/.qoder`
 *
 * 每个用例都注入 `homeDir` 指向临时目录 —— 真实 `~/.qoder/.auth/machine_id`
 * 是**用户与官方 CLI 共用**的机器身份，测试污染它会让用户混用官方 CLI 时
 * 签名因机器码漂移而失效。
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QODER, QODER_CN, type QoderProduct } from '../../src/qoder-product.js'
import {
  QODER_CLI_CLIENT_ID,
  QODER_DEVICE_LOGIN_TIMEOUT_MS,
  QODER_DEVICE_POLL_INTERVAL_MS,
  buildQoderDeviceLoginUrl,
  generateQoderNonce,
  generateQoderPkce,
  hasActiveQoderDeviceLogin,
  parseQoderDeviceTokenPayload,
  pollQoderDeviceToken,
  prepareQoderDeviceLogin,
  readOrCreateQoderMachineId,
  type QoderDevicePendingLogin,
} from '../../src/qoder-device-flow.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** 本用例创建的临时 home 目录；afterEach 统一删除。 */
const tempHomes: string[] = []

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-device-flow-'))
  tempHomes.push(dir)
  return dir
}

/** 本用例建立的设备流会话；afterEach 统一取消，避免互斥槽位泄漏到下一个用例。 */
const sessions: QoderDevicePendingLogin[] = []

function track(session: QoderDevicePendingLogin): QoderDevicePendingLogin {
  sessions.push(session)
  return session
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try { session.cancel('测试清理') } catch { /* 已结算的会话 cancel 是 no-op */ }
  }
  for (const dir of tempHomes.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 记录每次请求的 fetch 替身。 */
interface StubFetch {
  fetcher: typeof fetch
  calls: string[]
}

function stubFetcher(
  handler: (url: string, index: number) => Response | Promise<Response>,
): StubFetch {
  const calls: string[] = []
  const fetcher = vi.fn(async (url: unknown) => {
    const target = String(url)
    calls.push(target)
    return handler(target, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/**
 * 记录型 sleep：把入参记下来就立即 resolve。
 *
 * 这样「404 之后等 1 秒」变成「sleep 收到的第一个参数是 1000」这条**确定事实**，
 * 而用例本身瞬间结束。
 */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => { delays.push(ms) },
  }
}

/** 一次成功的轮询响应（官方成功判据：两个字段都是 string）。 */
function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    token: 'pt-from-device-flow',
    refresh_token: 'jrt-from-device-flow',
    ...overrides,
  }), { status: 200 })
}

/** UUID 形态（machine_id 是 36 字符文本）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── ① PKCE 与 nonce ─────────────────────────────────────────────────────────

describe('PKCE 生成（官方 nec() 的 S256 配对）', () => {
  it('verifier 是 64 字符、charset 合法（base64url 是 PKCE 允许字符集的子集）', () => {
    const pkce = generateQoderPkce()
    // 官方是 64 字符。48 字节 base64url 恰好 64 字符（48 % 3 === 0，无填充）。
    expect(pkce.codeVerifier).toHaveLength(64)
    // PKCE 规范允许 `[A-Za-z0-9-._~]`；base64url 用 `A-Za-z0-9-_`，是其子集。
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9\-_]{64}$/)
  })

  it('challenge 严格等于 base64url(sha256(verifier))（就地复算，不接受别的算法）', () => {
    const pkce = generateQoderPkce()
    const expected = createHash('sha256').update(pkce.codeVerifier).digest('base64url')
    expect(pkce.codeChallenge).toBe(expected)
    // 43 字符 = 32 字节 sha256 的 base64url 无填充长度。
    expect(pkce.codeChallenge).toHaveLength(43)
  })

  it('challenge_method 恒为 "S256"（官方只发这一种）', () => {
    expect(generateQoderPkce().codeChallengeMethod).toBe('S256')
  })

  it('每次生成都不同（一次性随机量，复用会让两次登录的挑战撞车）', () => {
    const a = generateQoderPkce()
    const b = generateQoderPkce()
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
  })

  it('nonce 是 UUID（36 字符文本）', () => {
    expect(generateQoderNonce()).toMatch(UUID_PATTERN)
    expect(generateQoderNonce()).not.toBe(generateQoderNonce())
  })
})

// ── ② 登录 URL ──────────────────────────────────────────────────────────────

describe('登录 URL 构造（字段名逐字符照抄官方）', () => {
  const base = {
    codeChallenge: 'CHALLENGE-43',
    nonce: '11111111-2222-3333-4444-555555555555',
    machineId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }

  it('国际版：路径 /device/selectAccounts 打在 qoder.com 上', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER, base))
    expect(url.origin).toBe('https://qoder.com')
    expect(url.pathname).toBe('/device/selectAccounts')
  })

  it('CN：同一个路径，host 换成 qoder.cn（两区只有域名不同）', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER_CN, base))
    expect(url.origin).toBe('https://qoder.cn')
    expect(url.pathname).toBe('/device/selectAccounts')
  })

  it('五个字段名逐字符正确，且**没有多余参数**', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER, base))
    // 集合相等（顺序不做要求）：多一个字段就是发明，少一个就是漏抄。
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['challenge', 'challenge_method', 'client_id', 'machine_id', 'nonce'],
    )
    expect(url.searchParams.get('challenge')).toBe(base.codeChallenge)
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('nonce')).toBe(base.nonce)
    expect(url.searchParams.get('machine_id')).toBe(base.machineId)
  })

  it('client_id 是 CLI 那一个（**不是**桌面端 `732aef47-…`）', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER, base))
    expect(url.searchParams.get('client_id')).toBe(QODER_CLI_CLIENT_ID)
    // 反向锚点：桌面端那套 client_id 一旦混进来，设备流会以「应用未授权」类
    // 形态失败，而表面上 URL 看着完全正常。
    expect(url.searchParams.get('client_id')).not.toContain('732aef47')
  })

  it('两个 region 用**同一个** client_id（官方两区同一个 CLI 应用）', () => {
    const intl = new URL(buildQoderDeviceLoginUrl(QODER, base))
    const cn = new URL(buildQoderDeviceLoginUrl(QODER_CN, base))
    expect(cn.searchParams.get('client_id')).toBe(intl.searchParams.get('client_id'))
  })

  it('CN **不带** redirect_uri（官方 CN 的 redirect_uri 是 null）', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER_CN, base))
    expect(url.searchParams.has('redirect_uri')).toBe(false)
    expect(url.search).not.toContain('redirect_uri')
  })

  it('machine_id 注入的是传入的那一个（不是就地新生成的）', () => {
    const url = new URL(buildQoderDeviceLoginUrl(QODER, { ...base, machineId: 'fixed-machine' }))
    expect(url.searchParams.get('machine_id')).toBe('fixed-machine')
  })
})

// ── ③ machine_id 持久化 ─────────────────────────────────────────────────────

describe('machine_id：与官方 CLI 同路径同格式', () => {
  it('首次生成并落盘：返回 UUID，且文件内容就是它', async () => {
    const home = await makeTempHome()
    const machineId = await readOrCreateQoderMachineId(QODER, { homeDir: home })

    expect(machineId).toMatch(UUID_PATTERN)
    // 路径与官方 CLI **逐字符一致**（`.qoder/.auth/machine_id`）：用户混用官方
    // CLI 时两边读同一个机器身份，签名才不会因机器码漂移失效。
    const onDisk = await readFile(join(home, '.qoder', '.auth', 'machine_id'), 'utf8')
    expect(onDisk.trim()).toBe(machineId)
  })

  it('已存在则读用：二次调用返回同一个值，且不重写文件', async () => {
    const home = await makeTempHome()
    const first = await readOrCreateQoderMachineId(QODER, { homeDir: home })
    const second = await readOrCreateQoderMachineId(QODER, { homeDir: home })
    expect(second).toBe(first)
  })

  it('读取时容忍尾部换行（官方 CLI 可能写成一行 + \\n）', async () => {
    const home = await makeTempHome()
    const file = join(home, '.qoder', '.auth', 'machine_id')
    await readOrCreateQoderMachineId(QODER, { homeDir: home })
    const written = (await readFile(file, 'utf8')).trim()
    await writeFile(file, `${written}\n`, 'utf8')
    expect(await readOrCreateQoderMachineId(QODER, { homeDir: home })).toBe(written)
  })

  it('两 region 路径隔离：国际版 .qoder、CN .qoder-cn，各存各的', async () => {
    const home = await makeTempHome()
    const intl = await readOrCreateQoderMachineId(QODER, { homeDir: home })
    const cn = await readOrCreateQoderMachineId(QODER_CN, { homeDir: home })

    // 两区是两套账号体系，机器身份也各存各的 —— 共用一个文件会让「装了 CN CLI
    // 又装国际版 CLI」的用户两边机器码互相覆盖。
    expect(intl).not.toBe(cn)
    expect((await readFile(join(home, '.qoder', '.auth', 'machine_id'), 'utf8')).trim()).toBe(intl)
    expect((await readFile(join(home, '.qoder-cn', '.auth', 'machine_id'), 'utf8')).trim()).toBe(cn)
  })

  it('落盘失败**不挡登录**：仍返回可用的内存态 UUID，不抛错', async () => {
    const io = {
      readFile: async () => { throw new Error('ENOENT') },
      mkdir: async () => { throw new Error('EACCES: permission denied') },
      writeFile: async () => { throw new Error('EACCES: permission denied') },
    }
    // 磁盘不可写是环境问题，不是「用户没资格登录」——把它变成登录失败，
    // 用户除了换台机器别无他法。
    const machineId = await readOrCreateQoderMachineId(QODER, { homeDir: 'C:/nope', io })
    expect(machineId).toMatch(UUID_PATTERN)
  })

  it('读取失败但写入成功时也能拿到值（半可用环境）', async () => {
    const home = await makeTempHome()
    const io = {
      readFile: async () => { throw new Error('EPERM') },
      mkdir: async (path: string) => { await (await import('node:fs/promises')).mkdir(path, { recursive: true }) },
      writeFile: async (path: string, data: string) => {
        await (await import('node:fs/promises')).writeFile(path, data, 'utf8')
      },
    }
    const machineId = await readOrCreateQoderMachineId(QODER, { homeDir: home, io })
    expect(machineId).toMatch(UUID_PATTERN)
    expect((await readFile(join(home, '.qoder', '.auth', 'machine_id'), 'utf8')).trim()).toBe(machineId)
  })
})

// ── ④ 轮询 ──────────────────────────────────────────────────────────────────

describe('轮询换令牌', () => {
  const pollBase = {
    nonce: '11111111-2222-3333-4444-555555555555',
    codeVerifier: 'v'.repeat(64),
    machineId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }

  it('轮询 URL：打在 openapi 基址上，三个字段名逐字符正确', async () => {
    const { fetcher, calls } = stubFetcher(() => tokenResponse())
    await pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep: recordingSleep().sleep })

    const url = new URL(calls[0]!)
    expect(url.origin).toBe('https://openapi.qoder.sh')
    expect(url.pathname).toBe('/api/v1/deviceToken/poll')
    expect(url.searchParams.get('nonce')).toBe(pollBase.nonce)
    expect(url.searchParams.get('verifier')).toBe(pollBase.codeVerifier)
    expect(url.searchParams.get('challenge_method')).toBe('S256')
  })

  it('轮询也带 machine_id（签名链依赖它，登录与轮询必须同一个）', async () => {
    const { fetcher, calls } = stubFetcher(() => tokenResponse())
    await pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep: recordingSleep().sleep })
    expect(new URL(calls[0]!).searchParams.get('machine_id')).toBe(pollBase.machineId)
  })

  it('CN 轮询打在 CN 的 openapi host 上（不落到国际版）', async () => {
    const { fetcher, calls } = stubFetcher(() => tokenResponse())
    await pollQoderDeviceToken(QODER_CN, { ...pollBase, fetcher, sleep: recordingSleep().sleep })
    const url = new URL(calls[0]!)
    expect(url.origin).toBe('https://openapi.qoder.com.cn')
    expect(url.origin).not.toBe(new URL(QODER.openapiBase).origin)
  })

  it('404 → 按 intervalMs 等待后重试（默认 1 秒）', async () => {
    let attempt = 0
    const { fetcher, calls } = stubFetcher(() => {
      attempt += 1
      return attempt <= 2 ? new Response('not found', { status: 404 }) : tokenResponse()
    })
    const { sleep, delays } = recordingSleep()

    const payload = await pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep })
    expect(payload.token).toBe('pt-from-device-flow')
    expect(calls).toHaveLength(3)
    // 前两次 404 各等一拍；成功那一次不再等。
    expect(delays).toEqual([QODER_DEVICE_POLL_INTERVAL_MS, QODER_DEVICE_POLL_INTERVAL_MS])
    expect(QODER_DEVICE_POLL_INTERVAL_MS).toBe(1000)
  })

  it('intervalMs 可覆盖，等待用的就是它（不写死 1000）', async () => {
    let attempt = 0
    const { fetcher } = stubFetcher(() => {
      attempt += 1
      return attempt === 1 ? new Response('', { status: 404 }) : tokenResponse()
    })
    const { sleep, delays } = recordingSleep()
    await pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep, intervalMs: 250 })
    expect(delays).toEqual([250])
  })

  it('成功判据照抄官方：`token` 是**非空 string**（`refresh_token` 不作要求）', () => {
    expect(parseQoderDeviceTokenPayload({ token: 'dt-x', refresh_token: 'drt-y' })).toEqual({
      token: 'dt-x',
      refreshToken: 'drt-y',
    })
    // 官方 `nec()` 判据是 `e.token && "string"==typeof e.token`：
    // 缺 token / 空串 / 非 string 都不算成功（继续轮询）。
    expect(parseQoderDeviceTokenPayload({ token: 'dt-x' })).toEqual({ token: 'dt-x', refreshToken: '' })
    expect(parseQoderDeviceTokenPayload({ refresh_token: 'drt-y' })).toBeUndefined()
    expect(parseQoderDeviceTokenPayload({ token: '' })).toBeUndefined()
    expect(parseQoderDeviceTokenPayload({ token: 123, refresh_token: 'drt-y' })).toBeUndefined()
    expect(parseQoderDeviceTokenPayload(null)).toBeUndefined()
    expect(parseQoderDeviceTokenPayload('nope')).toBeUndefined()
    // ⚠️ **`refresh_token` 不作要求**：旧实现要求两者都是 string，那是我们发明的
    // 额外约束、比官方严 —— 它会把「服务端只回了 token」这种官方认为成功的响应
    // 判成「还没好」，于是空转到 5 分钟超时（用户看到「授权了但一直不完成」）。
  })

  it('顺带解析 expires_at / expires_in / user_id（官方 buildUserInfoFromDeviceToken 的字段）', () => {
    // 官方 `buildUserInfoFromDeviceToken` 读 `expires_at` / `expires_in` /
    // `user_id` / `user_name` —— 设备流令牌的**真实寿命**只能从这里拿。
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const parsed = parseQoderDeviceTokenPayload({
      token: 'dt-x', refresh_token: 'drt-y', expires_at: expiresAt, user_id: 'u-9',
    })
    expect(parsed?.token).toBe('dt-x')
    expect(parsed?.refreshToken).toBe('drt-y')
    expect(parsed?.userId).toBe('u-9')
    expect(parsed?.expiresAtMs).toBe(Date.parse(expiresAt))
  })

  it('expires_in 按官方 rIe() 的启发式解析（>86400 视为毫秒，否则视为秒）', () => {
    const now = Date.now()
    // 真机 deviceToken poll 的 `expires_in` 是 **2591999994（毫秒 ≈30 天）**：
    // 官方 `rIe(A) = floor(now/1000) + (A > 86400 ? floor(A/1000) : A)`。
    // 当成「秒」会算出 82 年，当成「毫秒」才对；而 jobToken 的
    // `expires_in: 86400000` 同一个启发式也落在 24h。
    const big = parseQoderDeviceTokenPayload({ token: 'dt-x', refresh_token: 'r', expires_in: 2_591_999_994 })
    expect(big?.expiresAtMs).toBeGreaterThan(now + 29 * 86_400_000)
    expect(big?.expiresAtMs).toBeLessThan(now + 31 * 86_400_000)

    const small = parseQoderDeviceTokenPayload({ token: 'dt-x', refresh_token: 'r', expires_in: 3600 })
    expect(small?.expiresAtMs).toBeGreaterThan(now + 3_500_000)
    expect(small?.expiresAtMs).toBeLessThan(now + 3_700_000)
  })

  it('两个过期字段都缺时**不编造**（expiresAtMs 为 undefined，由上层兜底）', () => {
    const parsed = parseQoderDeviceTokenPayload({ token: 'dt-x', refresh_token: 'r' })
    expect(parsed?.expiresAtMs).toBeUndefined()
  })

  it('200 但判据不满足（用户还没点授权）→ 继续轮询，不提前失败', async () => {
    let attempt = 0
    const { fetcher, calls } = stubFetcher(() => {
      attempt += 1
      return attempt === 1 ? new Response('{}', { status: 200 }) : tokenResponse()
    })
    const { sleep } = recordingSleep()
    const payload = await pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep })
    expect(payload.token).toBe('pt-from-device-flow')
    expect(calls).toHaveLength(2)
  })

  it('总超时 5 分钟：到点抛超时错误，不再无限轮询', async () => {
    const { fetcher, calls } = stubFetcher(() => new Response('', { status: 404 }))
    const { sleep } = recordingSleep()

    await expect(
      pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep, timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toThrow(/超时/)
    // 关键：必须真的停下来。超时是终态，不是「再试一次」。
    const after = calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.length).toBe(after)
    expect(QODER_DEVICE_LOGIN_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it('取消（AbortSignal）后停止轮询并抛可读原因', async () => {
    const controller = new AbortController()
    const { fetcher, calls } = stubFetcher(() => new Response('', { status: 404 }))
    const { sleep } = recordingSleep()

    const pending = pollQoderDeviceToken(QODER, {
      ...pollBase, fetcher, sleep, signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow(/取消/)
    const after = calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.length).toBe(after)
  })

  it('非 404 的失败状态直报，不当作「还在等授权」空转', async () => {
    const { fetcher } = stubFetcher(() => new Response('boom', { status: 500 }))
    const { sleep } = recordingSleep()
    await expect(
      pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep }),
    ).rejects.toThrow(/500/)
  })

  it('传输层失败直报（不把断网当成「继续等」）', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const { sleep } = recordingSleep()
    await expect(
      pollQoderDeviceToken(QODER, { ...pollBase, fetcher, sleep }),
    ).rejects.toThrow(/网络失败/)
  })
})

// ── ⑤ 两段式会话与互斥 ──────────────────────────────────────────────────────

describe('两段式设备流会话（prepare → awaitToken）', () => {
  /** 一次「先 404 再成功」的轮询替身。 */
  function prepareHarness(product: QoderProduct, home: string) {
    let attempt = 0
    const { fetcher, calls } = stubFetcher(() => {
      attempt += 1
      return attempt === 1 ? new Response('', { status: 404 }) : tokenResponse()
    })
    const { sleep, delays } = recordingSleep()
    return { fetcher, calls, sleep, delays, product, home }
  }

  it('prepare 立即返回 loginUrl（不 await 用户操作），URL 带本次 PKCE/nonce/machine_id', async () => {
    const home = await makeTempHome()
    const h = prepareHarness(QODER, home)
    const outcome = await prepareQoderDeviceLogin({
      product: QODER, fetcher: h.fetcher, sleep: h.sleep, homeDir: home,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const session = track(outcome.session)

    const url = new URL(session.loginUrl)
    expect(url.origin).toBe('https://qoder.com')
    expect(url.searchParams.get('challenge_method')).toBe('S256')
    expect(url.searchParams.get('challenge')).toBeTruthy()
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('machine_id')).toBe(session.machineId)
    // prepare 阶段一次网都不出：轮询是第二段的事。
    expect(h.calls).toHaveLength(0)
  })

  it('同一 region 已有未结算会话 → login-in-progress（不新建、不复用）', async () => {
    const home = await makeTempHome()
    const first = await prepareQoderDeviceLogin({
      product: QODER, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    track(first.session)

    const second = await prepareQoderDeviceLogin({
      product: QODER, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    // 复用会让一份凭据被多个占位 accountId 共享；静默新建则每次点击都堆一个
    // 轮询循环直到 5 分钟超时。
    expect(second.error).toBe('login-in-progress')
  })

  it('两个 region **各自独立**互斥：国际版进行中不影响 CN', async () => {
    const home = await makeTempHome()
    const intl = await prepareQoderDeviceLogin({
      product: QODER, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    expect(intl.ok).toBe(true)
    if (!intl.ok) return
    track(intl.session)

    expect(hasActiveQoderDeviceLogin(QODER.id)).toBe(true)
    const cn = await prepareQoderDeviceLogin({
      product: QODER_CN, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    // 两区是两批账号、两套令牌 —— 一区的登录窗口不该挡住另一区。
    expect(cn.ok).toBe(true)
    if (cn.ok) track(cn.session)
  })

  it('cancel 释放互斥槽位：取消后可以立刻重新登录', async () => {
    const home = await makeTempHome()
    const first = await prepareQoderDeviceLogin({
      product: QODER, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    first.session.cancel('用户取消')
    await expect(first.session.awaitToken()).rejects.toThrow(/取消/)

    const again = await prepareQoderDeviceLogin({
      product: QODER, fetcher: stubFetcher(() => tokenResponse()).fetcher,
      sleep: recordingSleep().sleep, homeDir: home,
    })
    expect(again.ok).toBe(true)
    if (again.ok) track(again.session)
  })

  it('结算（成功）后释放槽位', async () => {
    const home = await makeTempHome()
    const h = prepareHarness(QODER, home)
    const outcome = await prepareQoderDeviceLogin({
      product: QODER, fetcher: h.fetcher, sleep: h.sleep, homeDir: home,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const session = track(outcome.session)

    const payload = await session.awaitToken()
    expect(payload.token).toBe('pt-from-device-flow')
    // 结算即释放：槽位不清会让此后所有登录都被 login-in-progress 永久挡住。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasActiveQoderDeviceLogin(QODER.id)).toBe(false)
  })

  it('awaitToken 可重复调用拿到同一个结果（幂等消费）', async () => {
    const home = await makeTempHome()
    const h = prepareHarness(QODER, home)
    const outcome = await prepareQoderDeviceLogin({
      product: QODER, fetcher: h.fetcher, sleep: h.sleep, homeDir: home,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const session = track(outcome.session)

    const first = await session.awaitToken()
    const second = await session.awaitToken()
    expect(second).toEqual(first)
  })

  it('machine_id 落盘路径由产品决定（会话里的值与盘上一致）', async () => {
    const home = await makeTempHome()
    const h = prepareHarness(QODER_CN, home)
    const outcome = await prepareQoderDeviceLogin({
      product: QODER_CN, fetcher: h.fetcher, sleep: h.sleep, homeDir: home,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const session = track(outcome.session)

    expect((await readFile(join(home, '.qoder-cn', '.auth', 'machine_id'), 'utf8')).trim())
      .toBe(session.machineId)
  })
})
