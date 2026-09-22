import { describe, expect, it, vi } from 'vitest'
import { version as osVersion } from 'node:os'
import {
  TRAE_CN_APP_VERSION,
  TRAE_CN_BALANCE_ARRAY_KEYS,
  TRAE_CN_BALANCE_REMAIN_FIELDS,
  TRAE_CN_CHECKIN_CLAIM_PATH,
  TRAE_CN_CHECKIN_REQ_SOURCE,
  TRAE_CN_CHECKIN_STATUS_PATH,
  TRAE_CN_CLAIM_RETRY_CODES,
  TRAE_CN_CLAIM_RETRY_DELAYS_MS,
  TRAE_CN_CODE_CREDENTIAL_INVALID,
  TRAE_CN_CODE_TOO_MANY_USERS,
  TRAE_CN_DEVICE_TYPE,
  TRAE_CN_OS_VERSION,
  TRAE_CN_POOL_UNIVERSAL,
  TRAE_CN_POOL_WORK,
  TRAE_CN_USER_ENT_USAGE_PATH,
  claimTraeCnDailyCheckin,
  fetchTraeCnCheckinStatus,
  fetchTraeCnCreditBalance,
  isTraeCnClaimRetryable,
  traeCnCreditsHeaders,
  traeCnOsVersion,
} from '../../src/trae-cn-credits.js'
import { TRAE_CN, TRAE_CN_LOGIN_OS_VERSION } from '../../src/trae-cn-product.js'
import { TRAE_CN_BACKOFF_CODES, recordsTraeCnCooldown } from '../../src/trae-cn-errors.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

/**
 * 签到设备号（`x-device-id` 的来源）——**登录时注册的 16 位号**。
 *
 * ⚠️ **T9 第三次修正（2026-09-20）**：T9 原结论「服务端不校验设备号形态」观测
 * 成立但**推论错了** —— 不校验**形态** ≠ 不校验**设备**。服务端按 `x-device-id`
 * 做设备维度记账，只有登录时注册的那台设备被认可（单变量 A/B：仅换该头即让
 * `did_checked_in` 由 false 翻转为 true）。故本常量现在模拟
 * `checkin_device_id`，与 `device_id`（`BoundDeviceID`）**刻意不同值** ——
 * 用例要能区分「发了哪一个」。
 */
const CHECKIN_DEVICE_ID = '2996599860772203'
/** 服务端绑定标识（`BoundDeviceID`，14 位字母数字）——**不再**用作签到头。 */
const BOUND_DEVICE_ID = 'kxrq746j3w0l86'

function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: BOUND_DEVICE_ID,
    checkin_device_id: CHECKIN_DEVICE_ID,
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    nickname: '测试',
    ...overrides,
  }
}

/** 记录请求并按 URL 分派的 stub fetch。 */
function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 从一次请求里解出请求头（Headers 实例或普通对象都可）。 */
function headersOf(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers)
  const result: Record<string, string> = {}
  headers.forEach((value, key) => { result[key] = value })
  return result
}

/**
 * 在**假定时器**下跑一次 claim。
 *
 * 2026-09-20 起 claim 段对 `9074` / `4007` / `3004` 做有界退避重试
 * （1s → 3s），真等会让每条涉及 9074 的用例多花 4 秒。假定时器把这段等待
 * 压成零耗时，同时**不改变被测语义** —— 退避时长本身由
 * `TRAE_CN_CLAIM_RETRY_DELAYS_MS` 的常量断言守着。
 *
 * 推进循环的写法：`advanceTimersByTimeAsync` 每次都会顺带 flush 微任务，
 * 于是「上一发请求落定 → 排入下一次退避定时器 → 下一轮推进把它烧掉」
 * 这个链条能在固定轮数内走完；轮数取得比最大重试次数宽裕，成功路径提前
 * 结束时多余的推进只是空转。
 */
async function claimWithFakeTimers(
  options: Parameters<typeof claimTraeCnDailyCheckin>[2] = {},
  credential: TraeCnCredential = makeCredential(),
) {
  vi.useFakeTimers()
  try {
    const promise = claimTraeCnDailyCheckin(credential, TRAE_CN, options)
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(5_000)
    return await promise
  } finally {
    vi.useRealTimers()
  }
}

/** 未签到 + 领取成功的标准响应集。 */
function happyPath(overrides: {
  status?: Record<string, unknown>
  claim?: Record<string, unknown>
} = {}) {
  return (url: string) => {
    if (url.includes('/claim')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'OK', data: { credit: 100, ...overrides.claim },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0, msg: 'OK', data: { checked_in: false, enable: true, ...overrides.status },
    }), { status: 200 })
  }
}

describe('Trae CN 签到端点常量', () => {
  it('路径与调研实测一致', () => {
    expect(TRAE_CN_CHECKIN_STATUS_PATH).toBe('/trae/api/v2/ug/checkin_credits/status')
    expect(TRAE_CN_CHECKIN_CLAIM_PATH).toBe('/trae/api/v2/ug/checkin_credits/claim')
    expect(TRAE_CN_USER_ENT_USAGE_PATH).toBe('/trae/api/v2/pay/web_user_ent_usage')
  })

  it('请求体固定带 req_source:1（唯一次实测成功的组合）', async () => {
    expect(TRAE_CN_CHECKIN_REQ_SOURCE).toBe(1)
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ req_source: 1 })
  })

  it('设备头常量与真实客户端一致（app 版本 3.3.102）', () => {
    expect(TRAE_CN_DEVICE_TYPE).toBe('windows')
    // 反混淆真机客户端 claim 调用链后确认已到 3.3.102（原 3.3.100 落后两个补丁号）。
    expect(TRAE_CN_APP_VERSION).toBe('3.3.102')
  })

  it('x-os-version 是运行时 os.version() 的取值，不是硬编码构建号', () => {
    // 真机客户端发的是 `os.version()`（本机 `Windows 10 Home`，市场营销名），
    // 而不是 `Windows 10.0.22631` 这种构建号。故断言「等于本机 os.version()」，
    // 而不是断言某个写死的形态 —— 写死形态的断言在别的机器上会假绿。
    expect(TRAE_CN_OS_VERSION).toBe(osVersion())
    expect(traeCnOsVersion()).toBe(osVersion())
    // 回归护栏：旧的硬编码构建号必须**不再**出现（它会掩盖真实机器身份）。
    expect(TRAE_CN_OS_VERSION).not.toBe('Windows 10.0.22631')
    expect(TRAE_CN_OS_VERSION).not.toMatch(/^Windows 10\.0\.\d+$/)
  })

  it('登录 URL 的 x_os_version 与签到头**形态一致**（都是市场营销名，不再是构建号）', () => {
    // 修复前：登录 URL 发 `Windows 10 Home`（市场营销名），签到头发
    // `Windows 10.0.22631`（构建号）—— 同一个插件对同一台机器报了两种**形态**。
    // 现在两者都是「系统 API 的 osVersion」，形态统一。
    //
    // 刻意**不**断言两者逐字相等：登录 URL 那个常量是登录握手线里
    // 逐字校准过的真机字面量（`src/trae-cn-product.ts`，不在本次改动边界内），
    // 在非 Windows 10 Home 的机器上它与本机 `os.version()` 自然不同 ——
    // 那是「两条协议线各自如实」的结果，不是缺陷。
    expect(TRAE_CN_LOGIN_OS_VERSION).not.toMatch(/^Windows 10\.0\.\d+$/)
    expect(traeCnOsVersion()).not.toMatch(/^Windows 10\.0\.\d+$/)
  })
})

describe('traeCnCreditsHeaders（设备头与官方头集对齐）', () => {
  it('x-device-id 用登录时注册的 16 位号，**不是** BoundDeviceID', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['x-device-id']).toBe(CHECKIN_DEVICE_ID)
    // 反向护栏：BoundDeviceID 绝不能出现在签到头里（9074 的真根因就是它）。
    expect(headers['x-device-id']).not.toBe(BOUND_DEVICE_ID)
    // 形态：16 位纯十进制（与登录 URL 的 device_id 同源）。
    expect(headers['x-device-id']).toMatch(/^\d{16}$/)
  })

  it('设备头齐全（claim 缺一个就回 9004）', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['x-device-id']).toBeTruthy()
    expect(headers['x-device-type']).toBe('windows')
    expect(headers['x-os-version']).toBe(TRAE_CN_OS_VERSION)
    expect(headers['x-app-version']).toBe(TRAE_CN_APP_VERSION)
  })

  it('鉴权头只有 Authorization: Cloud-IDE-JWT（官方 claim 头集）', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT')
    expect(headers.Authorization).not.toContain('Bearer')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('删除官方不发的 5 个头（Accept / Origin / Referer / X-Ide-Token / X-Cloudide-Token）', () => {
    // 官方 claim 的头集逐字来自 bundle：`bb()` 只给 Content-Type，
    // `mixAuthorization` 只加 Authorization，`fb()` 只加 5 个设备头。
    // 本插件此前多发这 5 个；单变量 A/B 已证明它们**不影响**结果，
    // 删除是「对齐官方形态」而不是「修复」—— 故用严格断言钉死。
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    for (const removed of ['Accept', 'Origin', 'Referer', 'X-Ide-Token', 'X-Cloudide-Token']) {
      expect(headers, removed).not.toHaveProperty(removed)
    }
    // 头集**完全等于**官方那 6 个（多一个少一个都算漂移）。
    expect(Object.keys(headers).sort()).toEqual([
      'Authorization', 'Content-Type',
      'x-app-version', 'x-device-id', 'x-device-type', 'x-os-version',
    ])
  })

  it('刻意**不**发 x-device-brand（官方条件性发，我们不猜硬件型号）', () => {
    // 官方：`i?.device_model && (e["x-device-brand"]=i.device_model)` —— 条件性。
    // 本插件拿不到硬件型号，按约定如实**不发**，而不是发空串冒充「官方也发」。
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers).not.toHaveProperty('x-device-brand')
  })

  it('旧凭据（无 checkin_device_id）降级用 BoundDeviceID —— 如实降级不伪造', () => {
    // 该字段引入前落盘的凭据 JSON 里根本没有这个键。
    const legacy = makeCredential({ checkin_device_id: undefined as unknown as string })
    const headers = traeCnCreditsHeaders(legacy, TRAE_CN)
    expect(headers['x-device-id']).toBe(BOUND_DEVICE_ID)
    // 不拿 machine_id 折算一个假的 16 位号顶上（README 禁止伪造设备身份）。
    expect(headers['x-device-id']).not.toBe('a'.repeat(16))
  })

  it('两个设备号都缺时留空（不发明值）', () => {
    const empty = makeCredential({ checkin_device_id: '', device_id: '' })
    expect(traeCnCreditsHeaders(empty, TRAE_CN)['x-device-id']).toBe('')
  })

  it('不发腾讯系 / LobsterAI 的归属头', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['X-Domain']).toBeUndefined()
    expect(headers['X-Product-Code']).toBeUndefined()
    expect(Object.keys(headers).some((key) => key.startsWith('X-LobsterAI'))).toBe(false)
  })

  it('请求头带设备头且 host 为 api.trae.cn', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    const headers = headersOf(calls[0]!.init)
    expect(headers['x-device-id']).toBe(CHECKIN_DEVICE_ID)
    expect(headers['x-device-type']).toBe('windows')
    expect(headers['origin']).toBeUndefined()
    expect(new URL(calls[0]!.url).origin).toBe('https://api.trae.cn')
    expect(calls[0]!.init!.method).toBe('POST')
  })
})

describe('fetchTraeCnCheckinStatus', () => {
  it('解析 checked_in 与 enable', async () => {
    const { fetcher } = stubFetch(happyPath({ status: { checked_in: true } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status).not.toBeNull()
    expect(status!.todayCheckedIn).toBe(true)
    expect(status!.active).toBe(true)
  })

  it('用 checked_in 而**不是** did_checked_in 作幂等判据', async () => {
    // 设备级语义的 did_checked_in 为 true、账号级 checked_in 为 false：
    // 若实现读错字段就会误判「今天已签到」。
    const { fetcher } = stubFetch(happyPath({ status: { checked_in: false, did_checked_in: true } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.todayCheckedIn).toBe(false)
  })

  it('checked_in 在根对象上也认（信封层级容错）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, checked_in: true, data: { enable: true },
    }), { status: 200 }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.todayCheckedIn).toBe(true)
  })

  it('enable 显式 false 时 active 为 false', async () => {
    const { fetcher } = stubFetch(happyPath({ status: { enable: false } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.active).toBe(false)
  })

  it('enable 缺失时 active 视为 true（不把省略当关闭）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { checked_in: false },
    }), { status: 200 }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.active).toBe(true)
  })

  it('无实测依据的字段一律取零值（不臆造状态）', async () => {
    const { fetcher } = stubFetch(happyPath())
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status).toMatchObject({
      streakDays: 0, dailyCredit: 0, todayCredit: 0, isStreakDay: false,
      totalCredits: 0, checkinDates: [], activityName: '', themeName: '', endTime: '',
    })
  })

  it('code:1001（无 auth 的失效形态）返回 null —— 与「未签到」区分', async () => {
    // 实测：不带 auth 时是 HTTP 200 + code:1001 + enable:false，不是 401。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID, msg: 'unauthorized', data: { enable: false },
    }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('HTTP 200 但 code 非 0 返回 null（判定以 body code 为准）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 9004 }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('响应缺 code 字段返回 null（不当作成功）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('响应不是 JSON 对象返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response('[1,2,3]', { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })
})

describe('claimTraeCnDailyCheckin', () => {
  it('未签到时走 status → claim 两步并返回 claimed', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/status')
    expect(calls[1]!.url).toContain('/claim')
  })

  it('两个请求都是 POST 且带 req_source:1', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    for (const call of calls) {
      expect(call.init!.method).toBe('POST')
      expect(JSON.parse(String(call.init!.body))).toEqual({ req_source: 1 })
    }
  })

  it('checked_in=true 时返回 already-claimed 且**不发**领取请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ status: { checked_in: true } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toEqual({ kind: 'already-claimed', message: '今天已签到' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/status')
  })

  it('enable=false 时返回 inactive 且不发领取请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ status: { enable: false } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('inactive')
    expect(calls).toHaveLength(1)
  })

  it('状态查询 code:1001 → failed 且文案说明凭据失效', async () => {
    const { fetcher, calls } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID, enable: false,
    }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(TRAE_CN_CODE_CREDENTIAL_INVALID)
    expect((outcome as { message: string }).message).toBe('凭据已失效，请重新登录')
    expect(calls).toHaveLength(1)
  })

  it('领取 code:1001 → failed 且文案说明凭据失效', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ code: TRAE_CN_CODE_CREDENTIAL_INVALID }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { message: string }).message).toBe('凭据已失效，请重新登录')
  })

  it('领取 code:9004 → failed，且文案指向设备头待校准', async () => {
    const { fetcher, calls } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ code: 9004, msg: 'device not allowed' }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(9004)
    const message = (outcome as { message: string }).message
    expect(message).toContain('9004')
    expect(message).toContain('x-os-version')
    // 9004 是**设备身份**问题（确定性失败）：重试只会把同一个结果问三遍。
    expect(calls.filter((call) => call.url.includes('/claim'))).toHaveLength(1)
  })

  it('领取响应缺积分字段时按 0 计并留调试行（不发明字段名）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(happyPath({ claim: { credit: undefined, mystery_field: 7 } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
    expect(debug.some((line) => line.includes('未命中积分字段候选表'))).toBe(true)
    // 脱敏：只报字段名，不报值。
    expect(debug.join('\n')).not.toContain('7')
  })

  it('领取响应带 msg 时作为 delayedMessage 透出', async () => {
    const { fetcher } = stubFetch(happyPath({ claim: { credit: 50, msg: '明天再来' } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 50, delayedMessage: '明天再来' })
  })

  it('字符串形态的积分也能解析', async () => {
    const { fetcher } = stubFetch(happyPath({ claim: { credit: '88.5' } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 88.5 })
  })

  it('网络失败 → failed 且 code 为 -1', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(-1)
    expect((outcome as { message: string }).message).toContain('签到状态查询失败')
  })
})

// ─────────────────────────────────────────────────────────────
// logid 透传（x-tt-logid → outcome.logid）
// ─────────────────────────────────────────────────────────────

/** 真机样本（字节系网关的 logid 形态）。 */
const REAL_LOGID = '20260919142909176141A5DE791F4FE75E'

/**
 * 构造一个带 `x-tt-logid` 响应头的 200 响应。
 *
 * 直接传 body 字符串而不是包装已有 `Response`：包装会转发 ReadableStream，
 * 而这里只需要一个干净响应，少一层流传递就少一种失败模式。
 */
function jsonWithLogId(body: unknown, logid: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  headers.set('x-tt-logid', logid)
  return new Response(JSON.stringify(body), { status: 200, headers })
}

describe('logid 透传（失败诊断的关键线索）', () => {
  it('claim 失败时把响应头 x-tt-logid 透传到 outcome.logid', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      // 真机场景：HTTP 200 + code 9074（活动级名额限制）+ logid。
      ? jsonWithLogId({ code: 9074, message: '当前参与用户太多，请稍后再试' }, REAL_LOGID)
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome).toMatchObject({ kind: 'failed', code: 9074, logid: REAL_LOGID })
    // 文案在服务端原文之后补了**定性**（见下一条用例）。
    expect((outcome as { message: string }).message).toContain('当前参与用户太多，请稍后再试')
  })

  it('status 失败时同样透传 logid（两步里任一步失败都带得上）', async () => {
    const { fetcher } = stubFetch(() => jsonWithLogId({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID,
    }, REAL_LOGID))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({
      kind: 'failed', code: TRAE_CN_CODE_CREDENTIAL_INVALID, logid: REAL_LOGID,
    })
  })

  it('响应头没有 logid 时 outcome **不含** logid 字段（不是空串）', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ code: 9074, message: '限流' }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome.kind).toBe('failed')
    // 关键：字段**不存在**，而不是 `logid: undefined` / `logid: ''`。
    // 前端判「非空才追加显示」时，空串与 undefined 都要被挡住。
    expect('logid' in outcome).toBe(false)
  })

  it('logid 为空白串时视为没有（不显示一个空的 logid 尾巴）', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? jsonWithLogId({ code: 9074, message: '限流' }, '   ')
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimWithFakeTimers({ fetcher })
    expect('logid' in outcome).toBe(false)
  })

  it('logid 两侧空白被 trim（服务端偶尔带空格）', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? jsonWithLogId({ code: 9074, message: '限流' }, `  ${REAL_LOGID}  `)
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimWithFakeTimers({ fetcher })
    expect((outcome as { logid?: string }).logid).toBe(REAL_LOGID)
  })

  it('响应头名大小写不敏感（X-TT-LogId 同样命中）', async () => {
    const { fetcher } = stubFetch((url) => {
      if (!url.includes('/claim')) {
        return new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 })
      }
      const headers = new Headers()
      headers.set('X-TT-LogId', REAL_LOGID)
      return new Response(JSON.stringify({ code: 9074, message: '限流' }), { status: 200, headers })
    })
    const outcome = await claimWithFakeTimers({ fetcher })
    expect((outcome as { logid?: string }).logid).toBe(REAL_LOGID)
  })

  it('响应体无法解析（信封异常）时也透传 logid', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? jsonWithLogId([1, 2, 3], REAL_LOGID)
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'failed', logid: REAL_LOGID })
  })

  it('传输层失败（fetch 抛错）没有响应，故没有 logid —— 如实缺失', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect('logid' in outcome).toBe(false)
  })

  it('成功路径**不带** logid 字段（只有 failed 才需要）', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? jsonWithLogId({ code: 0, data: { credit: 100 } }, REAL_LOGID)
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('claimed')
    expect('logid' in outcome).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// claim 段有界重试（2026-09-20）
// ─────────────────────────────────────────────────────────────

/** 成功 / 未签到的 status 响应（重试用例里恒定不变）。 */
function statusOk(): Response {
  return new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 })
}

/**
 * 按「第 N 次 claim 调用」返回不同响应的 stub。
 *
 * `sequence[n]` 是第 n+1 次 claim 的响应构造器；越界后一直用最后一个
 * （这样「三次全失败」只需给一个元素）。
 */
function sequenceClaimFetch(sequence: Array<() => Response>) {
  let claimIndex = 0
  const { fetcher, calls } = stubFetch((url) => {
    if (!url.includes('/claim')) return statusOk()
    const step = sequence[Math.min(claimIndex, sequence.length - 1)]!
    claimIndex += 1
    return step()
  })
  const claimCalls = () => calls.filter((call) => call.url.includes('/claim'))
  return { fetcher, calls, claimCalls }
}

describe('claim 段有界重试（9074 定性的配套处置）', () => {
  it('重试判据：只有 9074 / 4007 / 3004 可重试，且必须在共享退避表里', () => {
    for (const code of TRAE_CN_CLAIM_RETRY_CODES) {
      expect(isTraeCnClaimRetryable(code), String(code)).toBe(true)
      // 双向钉死：本地清单**必须**是共享退避表的子集（上游移除即自动停重试）。
      expect(TRAE_CN_BACKOFF_CODES, String(code)).toContain(code)
    }
    // 9004（设备身份）/ 1001（凭据失效）是确定性失败 —— 重试只会问三遍同一个结果。
    for (const code of [9004, 1001, 1002, 4010, 4014, 4008, 4200, 4001, 4006, 4023, -1, 99999, undefined]) {
      expect(isTraeCnClaimRetryable(code), String(code)).toBe(false)
    }
    // 3003 在共享退避表里（chat 通道的 MODEL_FAIL），但签到端点没有对应观测，
    // 刻意不放进本地清单 —— 否则签到会白等 4 秒。
    expect(TRAE_CN_BACKOFF_CODES).toContain(3003)
    expect(isTraeCnClaimRetryable(3003)).toBe(false)
  })

  it('退避是 1s → 3s 共 2 次（总等待 4s，有界）', () => {
    expect(TRAE_CN_CLAIM_RETRY_DELAYS_MS).toEqual([1000, 3000])
    expect(TRAE_CN_CLAIM_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(10_000)
  })

  it('9074 两次重试后成功 → claimed（前两次失败不返回给调用方）', async () => {
    const { fetcher, claimCalls } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多，请稍后再试' }), { status: 200 }),
      () => new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多，请稍后再试' }), { status: 200 }),
      () => new Response(JSON.stringify({ code: 0, data: { credit: 150 } }), { status: 200 }),
    ])
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
    // 共 3 次 claim：首发 + 2 次重试（与 delays 长度一致）。
    expect(claimCalls()).toHaveLength(1 + TRAE_CN_CLAIM_RETRY_DELAYS_MS.length)
  })

  it('9074 三次全失败 → 返回**最后一次**的 code / message / logid', async () => {
    // 三次的 logid 各不相同：能区分「取最后一次」与「取第一次」。
    const logids = ['LOGID-FIRST', 'LOGID-SECOND', 'LOGID-LAST']
    let index = 0
    const { fetcher, calls } = stubFetch((url) => {
      if (!url.includes('/claim')) return statusOk()
      const logid = logids[Math.min(index, logids.length - 1)]!
      index += 1
      return jsonWithLogId({ code: 9074, message: '当前参与用户太多，请稍后再试' }, logid)
    })
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(calls.filter((call) => call.url.includes('/claim'))).toHaveLength(3)
    expect(outcome).toMatchObject({ kind: 'failed', code: 9074, logid: 'LOGID-LAST' })
    // 文案里带上新定性：不是「等名额」，而是指向**设备身份**这个真根因，
    // 并给出可执行动作（重新登录以登记设备身份）。
    expect((outcome as { message: string }).message)
      .toContain('x-device-id')
    expect((outcome as { message: string }).message)
      .toContain('重新登录')
  })

  it('4007 触发重试（同属共享退避表里的软限流）', async () => {
    const { fetcher, claimCalls } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: 4007, message: '请求过于频繁' }), { status: 200 }),
      () => new Response(JSON.stringify({ code: 0, data: { credit: 150 } }), { status: 200 }),
    ])
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
    expect(claimCalls()).toHaveLength(2)
  })

  it('9004 不重试（设备身份问题，重试只会问三遍同一个结果）', async () => {
    const { fetcher, claimCalls } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: 9004, msg: 'device not allowed' }), { status: 200 }),
    ])
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome).toMatchObject({ kind: 'failed', code: 9004 })
    expect(claimCalls()).toHaveLength(1)
  })

  it('1001 不重试（凭据失效只能重新登录）', async () => {
    const { fetcher, claimCalls } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: TRAE_CN_CODE_CREDENTIAL_INVALID }), { status: 200 }),
    ])
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome).toMatchObject({ kind: 'failed', code: TRAE_CN_CODE_CREDENTIAL_INVALID })
    expect(claimCalls()).toHaveLength(1)
  })

  it('status 段**不重试**：status 失败即返回，claim 一次都没发', async () => {
    const { fetcher, calls } = stubFetch(
      () => new Response(JSON.stringify({ code: 9074, message: '当前参与用户太多，请稍后再试' }), { status: 200 }),
    )
    const outcome = await claimWithFakeTimers({ fetcher })
    expect(outcome.kind).toBe('failed')
    // status 是**读**接口（实测同一套设备头下恒成功）：失败即失败，不重试。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/status')
    expect(calls.filter((call) => call.url.includes('/claim'))).toHaveLength(0)
  })

  it('重试次数上界与 delays 长度同源（改常量即改行为，不会各写一份）', async () => {
    const { fetcher, claimCalls } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: 9074 }), { status: 200 }),
    ])
    await claimWithFakeTimers({ fetcher })
    expect(claimCalls()).toHaveLength(1 + TRAE_CN_CLAIM_RETRY_DELAYS_MS.length)
  })

  it('重试过程留下脱敏调试行（便于真机核对节奏）', async () => {
    const debug: string[] = []
    const { fetcher } = sequenceClaimFetch([
      () => new Response(JSON.stringify({ code: 9074 }), { status: 200 }),
      () => new Response(JSON.stringify({ code: 0, data: { credit: 150 } }), { status: 200 }),
    ])
    await claimWithFakeTimers({ fetcher, onDebug: (message) => debug.push(message) })
    const joined = debug.join('\n')
    expect(joined).toContain('9074')
    expect(joined).toContain('1000ms 后重试')
  })
})

describe('9074 不记冷却徽章（定性已改为设备身份）', () => {
  it('recordsTraeCnCooldown(9074) 为 false —— 设备身份不是「该模型限流 N 分钟」', () => {
    // 徽章语义是「这个模型受限，等一会儿自动解除」。9074 的现行定性是
    // **设备身份不被活动系统认可**（2026-09-20 单变量 A/B 定案）——
    // 它与具体模型无关，且等多久都不会自愈（要么重新登录登记设备身份，
    // 要么走后续路径），记徽章是虚假信息。
    expect(recordsTraeCnCooldown(TRAE_CN_CODE_TOO_MANY_USERS)).toBe(false)
    expect(recordsTraeCnCooldown(9074)).toBe(false)
    // 反向对照：限流码确实会记（证明上面的 false 不是「判据整体失效」）。
    expect(recordsTraeCnCooldown(4008)).toBe(true)
  })

  it('9074 常量与真机原文对应，且仍是共享退避表成员', () => {
    expect(TRAE_CN_CODE_TOO_MANY_USERS).toBe(9074)
    expect(TRAE_CN_BACKOFF_CODES).toContain(9074)
    expect(TRAE_CN_CLAIM_RETRY_CODES).toContain(9074)
  })
})

// ─────────────────────────────────────────────────────────────
// 积分余额（按 provider 分池：一个面板只显示自己那个池）
// ─────────────────────────────────────────────────────────────

/** 构造一个礼包条目。 */
function gift(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_endpoint: TRAE_CN_POOL_UNIVERSAL,
    name: '礼包',
    remain_amount: 100,
    total_amount: 200,
    ...overrides,
  }
}

/** 余额 stub：按给定礼包数组返回成功响应。 */
function balanceFetch(gifts: Record<string, unknown>[], wrap: (gifts: unknown[]) => unknown = (g) => ({
  code: 0, msg: 'OK', data: { packages: g },
})) {
  return stubFetch(() => new Response(JSON.stringify(wrap(gifts)), { status: 200 }))
}

describe('fetchTraeCnCreditBalance', () => {
  it('请求体是 {"require_usage":true}，端点为 web_user_ent_usage', async () => {
    const { fetcher, calls } = balanceFetch([gift()])
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(new URL(calls[0]!.url).pathname).toBe(TRAE_CN_USER_ENT_USAGE_PATH)
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ require_usage: true })
    expect(calls[0]!.init!.method).toBe('POST')
  })

  it('Trae CN 面板（通用池）：只有通用包与通用 total，Work 包被过滤掉', async () => {
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 54.22, name: '礼包A' }),
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 100, name: '礼包B' }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, remain_amount: 2000, name: 'Work礼包' }),
    ])
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )
    expect(balance).not.toBeNull()
    // 数字只含通用池（54.22 + 100），既不是 2154.22 也不是 2000。
    expect(balance!.total).toBe(154.22)
    // 资源包列表同样只含通用包 —— Work 包不出现在 Trae CN 面板上。
    expect(balance!.packages.map((pkg) => pkg.name)).toEqual(['礼包A', '礼包B'])
  })

  it('传入 Work 池时只返回 Work 包与 Work total，通用包被过滤掉', async () => {
    // ⚠️ 池过滤本身是**上游协议事实**（`available_endpoint` 仍分池），故这条
    // 覆盖保留；但本插件**已无任何面板显示 Work 池**（TraeWork 通道已被官方
    // 并入通用通道，那条 provider 已整体移除），生产路径只传 `POOL_UNIVERSAL`。
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 54.22, name: '礼包A' }),
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 100, name: '礼包B' }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, remain_amount: 2000, name: 'Work礼包' }),
    ])
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, { fetcher },
    )
    expect(balance!.total).toBe(2000)
    expect(balance!.packages.map((pkg) => pkg.name)).toEqual(['Work礼包'])
    // 包名原样透出：`[Work 积分]` 前缀是为两池混排准备的，分池后已无意义。
    expect(balance!.packages[0]!.name).not.toContain('[Work')
  })

  it('另一池整个为空时该池显示 0（不是 null）—— 池为空 ≠ 查不到', async () => {
    // 真实场景：账号只有通用积分、一分 Work 积分都没有。此时查 Work 池该显示
    // 「0」，而不是「余额查询失败」—— 服务端确实回了、只是本池一个包都没有。
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 30, name: '通用包' }),
    ])
    const work = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, { fetcher },
    )
    expect(work).not.toBeNull()
    expect(work!.total).toBe(0)
    expect(work!.packages).toEqual([])
  })

  it('响应里**没有** available_endpoint 字段时不崩（老响应形态）', async () => {
    const { fetcher } = balanceFetch([{ name: '无名池', remain_amount: 30 }])
    const universal = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )
    // 缺 endpoint 的礼包归通用池（见 parseTraeCnPackage），故通用面板看得见它。
    expect(universal!.total).toBe(30)
    expect(universal!.packages).toHaveLength(1)
  })

  it('调试行如实报出「本池取了几项 / 响应里有哪些池」（真机校准靠它）', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 10 }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, remain_amount: 20 }),
      gift({ available_endpoint: 7, remain_amount: 30 }),
    ])
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    const joined = debug.join('\n')
    expect(joined).toContain('分池展示')
    expect(joined).toContain('本池 endpoint=1，取 1/3 项')
    // 未知池（endpoint=7）也要被报出来：它既不属于本池也不属于另一池，
    // 真机校准时这是「服务端加了新池」的唯一线索。
    expect(joined).toContain('0,1,7')
    // 只输出池号与条数，不输出金额。
    expect(joined).not.toContain('30')
  })

  it('失效额度按**本池**汇总（不跨池，否则会出现「明细里没有却提示已失效」）', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, name: '通用过期', remain_amount: 99, expire_time: past }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, name: 'Work过期', remain_amount: 7, expire_time: past }),
    ])
    const universal = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )
    expect(universal!.expiredTotal).toBe(99)
    expect(universal!.packages.map((pkg) => pkg.name)).toEqual(['通用过期'])
  })

  it('缺 available_endpoint 的礼包归入通用池（故通用面板看得见、Work 面板看不见）', async () => {
    const { fetcher } = balanceFetch([{ name: '无名池', remain_amount: 30 }])
    const universal = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )
    expect(universal!.total).toBe(30)
    const work = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, { fetcher },
    )
    expect(work!.total).toBe(0)
  })

  it('余额字段候选表：remain 类字段优先', async () => {
    for (const field of ['remain_amount', 'remaining_amount', 'remain', 'balance']) {
      const { fetcher } = balanceFetch([{ available_endpoint: 0, name: 'x', [field]: 12.5 }])
      const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
      expect(balance!.total, field).toBe(12.5)
    }
  })

  it('字段容错：余额 = total_amount - 已用', async () => {
    const { fetcher } = balanceFetch([{
      available_endpoint: 0, name: 'x', total_amount: 4500, used_amount: 300,
    }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.packages[0]!.remaining).toBe(4200)
    expect(balance!.packages[0]!.total).toBe(4500)
  })

  it('字段容错：只有 total_amount 时按余额计，且 total 置 0（不伪装成 1:1）', async () => {
    const { fetcher } = balanceFetch([{ available_endpoint: 0, name: 'x', total_amount: 4650 }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.packages[0]!.remaining).toBe(4650)
    expect(balance!.packages[0]!.total).toBe(0)
  })

  it('礼包数组按名字找不到时，按 available_endpoint 指纹扫描兜底', async () => {
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: { usage: { detail: { mystery_array: [{ available_endpoint: 0, remain_amount: 42 }] } } },
    }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(42)
  })

  it('同名用量数组不会被误当成礼包数组（指纹优先于键名）', async () => {
    // `require_usage:true` 下响应里可能同时有已用量的 `list` 与带分池指纹的
    // `gift_list`。只按候选键名取第一个会把用量当余额读出来。
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: {
        list: [{ date: '2026-09-01', used: 1000 }],
        gift_list: [{ available_endpoint: 0, remain_amount: 42 }],
      },
    }))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance!.total).toBe(42)
    expect(debug.some((line) => line.includes('data.gift_list') && line.includes('已按分池指纹确认'))).toBe(true)
  })

  it('候选键名命中但无指纹时回退使用，并在调试行标注「未确认」', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: { packages: [{ name: 'x', remain_amount: 7 }] },
    }))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance!.total).toBe(7)
    expect(debug.some((line) => line.includes('未确认'))).toBe(true)
  })

  it('名字命中空数组时返回 0（服务端明确说没有礼包）而不是 null', async () => {
    const { fetcher } = balanceFetch([], () => ({ code: 0, data: { packages: [] } }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(0)
    expect(balance!.packages).toEqual([])
  })

  it('多包浮点相加规整为两位小数', async () => {
    const { fetcher } = balanceFetch([
      { available_endpoint: 0, remain_amount: 55.67000031 },
      { available_endpoint: 0, remain_amount: 99.99999999 },
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(155.67)
  })

  it('负余额 clamp 到 0（不显示 -12.5 积分）', async () => {
    const { fetcher } = balanceFetch([{ available_endpoint: 0, remain_amount: -12.5 }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(0)
    expect(balance!.packages[0]!.remaining).toBe(0)
  })

  it('已过失效时间的礼包标 active:false 并计入 expiredTotal（不并入 total）', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const { fetcher } = balanceFetch([
      { available_endpoint: 0, name: '有效', remain_amount: 10 },
      { available_endpoint: 0, name: '过期', remain_amount: 99, expire_time: past },
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(10)
    expect(balance!.expiredTotal).toBe(99)
    expect(balance!.packages.find((pkg) => pkg.name === '过期')!.active).toBe(false)
  })

  it('领取后 total_amount 由 4500 变 4650 的形态可被读成余额', async () => {
    // 调研给出的唯一可核对数字：签到后总额抬升 150。
    const before = balanceFetch([{ available_endpoint: 0, total_amount: 4500 }])
    const after = balanceFetch([{ available_endpoint: 0, total_amount: 4650 }])
    const b1 = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher: before.fetcher },
    )
    const b2 = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher: after.fetcher },
    )
    expect(b2!.total - b1!.total).toBe(150)
  })

  it('查不到（找不到礼包数组）返回 null + 调试行，**不是** 0 积分', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({ code: 0, data: { unrelated: 1 } }))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance).toBeNull()
    expect(debug.some((line) => line.includes('找不到礼包数组'))).toBe(true)
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('timeout') }) as unknown as typeof fetch
    expect(await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )).toBeNull()
  })

  it('code:1001 返回 null（凭据失效 = 查不到，不显示成 0）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID,
    }), { status: 200 }))
    expect(await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )).toBeNull()
  })

  it('调试行只输出键名，不输出金额', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([{ available_endpoint: 0, remain_amount: 1234.56, secret: 'SK' }])
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    const joined = debug.join('\n')
    expect(joined).toContain('remain_amount')
    expect(joined).not.toContain('1234.56')
    expect(joined).not.toContain('SK')
  })

  it('候选表与实现同源（防止改常量不改实现）', () => {
    expect(TRAE_CN_BALANCE_ARRAY_KEYS).toContain('packages')
    expect(TRAE_CN_BALANCE_REMAIN_FIELDS).toContain('remain_amount')
  })
})

// ─────────────────────────────────────────────────────────────
// 真机校准（2026-09-18）：无 code 信封 + 嵌套 credits_limit / credits_amount
// ─────────────────────────────────────────────────────────────

/**
 * 真机 `web_user_ent_usage` 的响应样例（字段名与层级照抄实测，数值用实测值）。
 *
 * 两个**已实证**的形态差异正是本节要锁住的：
 *
 * 1. **顶层没有 `code` 字段**。原实现按 code 信封判定，直接 `return` 失败
 *    （「响应缺少 code 字段」）→ 余额**恒失败**，与「余额为 0」无关。
 * 2. 礼包数组的真名是根层的 `user_entitlement_pack_list`，且额度**嵌在**
 *    `entitlement_base_info.product_extra.package_extra.quota.credits_limit`，
 *    已用在 `usage.credits_amount`。只看顶层的读法会全部 miss → 每个包算 0。
 *
 * 真机响应里的包名字段**未在校准结论中列出**，故 fixture 只用已登记的
 * `name` 候选，不对名字做任何断言（断言按 `available_endpoint` 定位礼包）。
 */
function realDeviceBalanceResponse(): Record<string, unknown> {
  return {
    is_credits_billing: true,
    is_dollar_usage_billing: false,
    is_pay_freshman: false,
    trial_status: { is_in_trial: false },
    usage_summary: { consumed_amount: 2650, total_amount: 4650 },
    user_entitlement_pack_list: [
      {
        // endpoint=0 通用池：2000 用满 → 余额 0。
        entitlement_base_info: {
          available_endpoint: TRAE_CN_POOL_UNIVERSAL,
          entitlement_id: 'ent-universal',
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 9999 },
        },
        usage: { credits_amount: 2000 },
      },
      {
        // endpoint=1 Work 池：usage 为 `{}`（该包未产生用量）→ 按 0 计 → 余额 2000。
        entitlement_base_info: {
          available_endpoint: TRAE_CN_POOL_WORK,
          entitlement_id: 'ent-work',
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 2000 },
        },
        usage: {},
      },
    ],
  }
}

describe('fetchTraeCnCreditBalance —— 真机样例（2026-09-18 校准）', () => {
  it('无 code 信封也判成功（不再报「响应缺少 code 字段」）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance).not.toBeNull()
    // 原缺陷的原文案绝不能出现 —— 那正是「余额恒失败」的直接原因。
    expect(debug.join('\n')).not.toContain('响应缺少 code 字段')
    expect(debug.join('\n')).not.toContain('余额查询失败')
  })

  it('真机样例 —— Trae CN 面板只见通用池 0（Work 包的 2000 不进这个数字）', async () => {
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance).not.toBeNull()
    // endpoint=0 包 limit 2000 − consumed 2000 = 0；endpoint=1 包（2000）被过滤掉。
    expect(balance!.total).toBe(0)
    expect(balance!.packages).toHaveLength(1)
    expect(balance!.packages[0]!.remaining).toBe(0)
  })

  it('真机样例 —— 查 Work 池只见 Work 池 2000（通用包的 0 不进这个数字）', async () => {
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, { fetcher })
    expect(balance).not.toBeNull()
    // endpoint=1 包 limit 2000 − 0（`usage:{}`）= 2000。
    expect(balance!.total).toBe(2000)
    expect(balance!.packages).toHaveLength(1)
    expect(balance!.packages[0]!.remaining).toBe(2000)
  })

  it('嵌套口径生效：credits_limit 与 credits_amount 都被读到（两个池各查一次）', async () => {
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const universal = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher },
    )
    // 分池后 `packages` 里只有本池那一个包（包名字段未在校准结论中，不做名字断言）。
    const universalPkg = universal!.packages[0]!
    expect(universalPkg.total).toBe(2000)
    expect(universalPkg.used).toBe(2000)
    expect(universalPkg.remaining).toBe(0)

    const work = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_WORK, { fetcher },
    )
    const workPkg = work!.packages[0]!
    // usage:{} ⇒ 已用按 0（不是「查不到」）。
    expect(workPkg.total).toBe(2000)
    expect(workPkg.used).toBe(0)
    expect(workPkg.remaining).toBe(2000)
  })

  it('礼包数组从根层 user_entitlement_pack_list 定位，且按分池指纹确认为可信', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    const joined = debug.join('\n')
    // 真机响应**没有** `data` 层，礼包数组就在根上 —— 路径必须如实报 root，
    // 而不是回退层被误标成 data（那会让真机校准时找不到数组的真实位置）。
    expect(joined).toContain('root.user_entitlement_pack_list')
    expect(joined).not.toContain('data.user_entitlement_pack_list')
    // 真机的 available_endpoint 嵌在 entitlement_base_info 里，指纹扫描必须
    // 认得出它 —— 否则会退化成「仅按候选键名命中」的不可信路径。
    expect(joined).toContain('已按分池指纹确认')
    expect(joined).not.toContain('未确认')
  })

  it('嵌套 credits_limit 优先于同层 quota.credits_limit', async () => {
    // 两个路径同时存在且取值不同（2000 vs 9999）：必须取 package_extra 那一个。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: {
          available_endpoint: 0,
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 9999 },
        },
        usage: { credits_amount: 500 },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.packages[0]!.total).toBe(2000)
    expect(balance!.total).toBe(1500)
  })

  it('package_extra 缺失时回退 entitlement_base_info.quota.credits_limit', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: { available_endpoint: 0, quota: { credits_limit: 800 } },
        usage: { credits_amount: 300 },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(500)
    expect(balance!.packages[0]!.total).toBe(800)
  })

  it('usage 缺失时已用按 0（未产生用量 ≠ 查不到）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: {
          available_endpoint: 0,
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
        },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, { fetcher })
    expect(balance!.total).toBe(2000)
    expect(balance!.packages[0]!.used).toBe(0)
  })

  it('只有 usage_summary（无礼包数组）时不再按 code 判失败，而是找不到数组返回 null', async () => {
    // `usage_summary` 也是 trae-pay 信封特征字段，故**不会**被报成
    // 「响应缺少 code 字段」——失败原因如实指向「找不到礼包数组」。
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      is_credits_billing: true,
      usage_summary: { consumed_amount: 2650, total_amount: 4650 },
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('找不到礼包数组')
    expect(debug.join('\n')).not.toContain('响应缺少 code 字段')
  })

  it('业务失败仍按 code 报错（code:1001 凭据失效的翻译不丢）', async () => {
    // 「无 code 信封」不等于「忽略 code」：服务端真返回非 0 码时照样失败。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID,
      user_entitlement_pack_list: [],
    }), { status: 200 }))
    const debug: string[] = []
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('余额查询失败')
  })

  it('既无 code 也无信封特征字段时仍判失败（不把垃圾响应当成功）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      mystery: 'payload',
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(
      makeCredential(), TRAE_CN, TRAE_CN_POOL_UNIVERSAL, {
        fetcher, onDebug: (message) => debug.push(message),
      },
    )
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('无余额信封特征字段')
  })
})

describe('签到端点不受余额信封改动影响（仍按 code 判定）', () => {
  it('status 响应缺 code 时仍返回 null（信封宽松只对余额端点生效）', async () => {
    // 若把「结构特征即成功」误推广到签到端点，一次失败的领取会被报成
    // 「已领取」—— 比报失败更糟。这条断言就是那道边界。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [], usage_summary: {},
    }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('claim 响应缺 code 时不返回 claimed', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ credit: 100 }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
  })
})
