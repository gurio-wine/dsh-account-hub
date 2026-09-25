/**
 * Qoder **设备身份**（`Cosy-MachineToken` / `Type` / `Code`）与其在 `/sash/` 活动
 * 端点上的头集注入 —— 协议级单元测试。
 *
 * ## 为什么单独一个文件
 *
 * 这条链路的失效形态与签到**判定**（`qoder-checkin-credits.spec.ts`）完全不同：
 * 判定错了会「多发一次领取」或「伪造已签」，而这里错了会**静默退回**「天天
 * `undetermined`、一分不领」—— 服务端对缺设备头的请求恒回空列表，看状态码一切
 * 正常（HTTP 200、信封合法），只有活动列表是空的。故它必须单独钉死。
 *
 * ## 真机依据（2026-09-23 探针矩阵 + 2026-09-25 两次重放，共三次成功）
 *
 * | region | 必需头集 |
 * |---|---|
 * | **国际版** | `Cosy-ClientType` + `Cosy-Version` + `Cosy-Machine{Token,Type,Code}` + `UA: Qoder`（**缺任一即回空列表**） |
 * | **CN** | 只需 `Cosy-ClientType: 10`（现状即满额） |
 *
 * 故本文件的断言分两类：① 国际版拿到身份 ⇒ **逐字节**的全官方头集（含 `UA: Qoder`，
 * 而**不是**产品 UA `qoder/1.1.16`）；② CN ⇒ 头集**一个字符都不变**、且**一个 exe
 * 都不调**（省一次 ~1.2 s 子进程）。
 *
 * ## 替身边界
 *
 * 子进程与文件系统**全部**是替身（`exec` / `fs` 注入面）：单测绝不真的起
 * `runtime-info.exe` —— 那会让用例依赖「这台机器装没装 Qoder」并慢 1.2 s
 * （本仓库的单测约定是「快速、无网络、全部 mock」）。被测的是**真实的探测顺序、
 * 真实的解析、真实的头构造、真实的接线**，只有「问操作系统」这一步被换掉。
 *
 * ⚠️ 每条用例都传**自己的 `cache` Map**：模块级缓存是进程级的，共用会让
 * 「第二次调用命中缓存」这类断言在用例之间互相污染。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  QODER_RUNTIME_INFO_ARGS,
  QODER_RUNTIME_INFO_GLOB_PREFIX,
  getQoderMachineIdentity,
  matchesObservedQoderMachineIdentityShape,
  parseQoderMachineIdentity,
  qoderRuntimeInfoCandidates,
  type QoderMachineIdentityExec,
  type QoderMachineIdentityFs,
} from '../../src/qoder-machine-identity.js'
import {
  QODER,
  QODER_CN,
  QODER_CAMPAIGN_CLIENT_TYPE,
  QODER_CAMPAIGN_DEVICE_COSY_VERSION,
  QODER_CAMPAIGN_DEVICE_USER_AGENT,
  qoderCampaignHeaders,
  qoderJobTokenHeaders,
  type QoderCredential,
  type QoderMachineIdentity,
} from '../../src/qoder-product.js'
import {
  QODER_CAMPAIGNS_PATH,
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
} from '../../src/qoder-credits.js'

// ── 测试基建 ────────────────────────────────────────────────────────────────

/** 真机三次验证的取值形态（88 字符 `P1g` + 两个 18 位 hex）。 */
const IDENTITY: QoderMachineIdentity = {
  machineToken: `P1g${'A'.repeat(85)}`,
  machineType: '4aca3f7d14f2e9c479',
  machineCode: '56b3a82b76aa6cc927',
}

/** 假 home（不碰真实用户目录）。 */
const HOME = join('C:', 'Users', 'probe')

/** 用户级安装目录（探针第 1 档，真机就在这一档命中）。 */
const BIN_DIR = join(HOME, QODER.machineIdDir, '.bin')

/**
 * 用户级档里的**版本目录名**（hash 段随客户端版本变，这里取真机观测到的那个）。
 *
 * ⚠️ exe 路径由它拼出（见 {@link BIN_EXE}）而**不是各写一份字面量**：两份字面量一旦
 * 不一致，用例的失效形态是「替身目录里列出的版本目录 ≠ 期待命中的 exe 路径」，
 * 表现为探测静默回落到安装档 —— 看起来像生产代码的探测顺序错了，实际是夹具自相矛盾。
 */
const BIN_ENTRY = `${QODER_RUNTIME_INFO_GLOB_PREFIX}48d1294f147c9d89`
const BIN_EXE = join(BIN_DIR, BIN_ENTRY, 'runtime-info.exe')

/** 安装目录档（探针第 2 档）。 */
const PROGRAM_EXE = join('D:', 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe')

/** 一次 `runtime-info.exe` 调用记录。 */
interface ExecCall {
  file: string
  args: readonly string[]
  input: string
  timeoutMs: number
}

/**
 * 文件系统替身：只回答「这个路径在不在」与「这个目录下有哪些子目录」。
 *
 * `probes` 记录**被问过的路径**（顺序即探测顺序）—— 「第一个存在的胜出」这条
 * 规则只有靠它才可断言。`listed` 同理记录被列过的目录。
 */
function fakeFs(options: { files?: string[]; dirs?: Record<string, string[]> } = {}) {
  const files = options.files ?? []
  const dirs = options.dirs ?? {}
  const probes: string[] = []
  const listed: string[] = []
  const fs: QoderMachineIdentityFs = {
    async exists(path) {
      probes.push(path)
      return files.includes(path)
    },
    async listDirs(path) {
      listed.push(path)
      return dirs[path] ?? []
    },
  }
  return { fs, probes, listed }
}

/** 子进程替身：返回给定 stdout，或按给定错误 reject。 */
function fakeExec(result: string | Error) {
  const calls: ExecCall[] = []
  const exec: QoderMachineIdentityExec = async (file, args, options) => {
    calls.push({ file, args, input: options.input, timeoutMs: options.timeoutMs })
    if (result instanceof Error) throw result
    return result
  }
  return { exec, calls }
}

/** 一行合法的 stdout（末行是诊断噪音：解析只取第一行）。 */
function stdoutLine(identity: QoderMachineIdentity = IDENTITY): string {
  return `${JSON.stringify({ ...identity, vmInfo: {}, accountOutcome: 'ok' })}\nsome trailing noise\n`
}

/** 一份可用的凭据（签到只用 `access_token` 去换 jt，`user_id` 进 stdin）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-token',
  refresh_token: 'jrt-1',
  user_id: '0192f0aa-0000-7000-8000-000000000001',
}

/** jt 提供者替身。 */
function fakeAuth() {
  return {
    async getJobToken(_pat: string): Promise<string> { return 'jt-1' },
    invalidateJobToken(_pat: string) { /* 本文件不触发 401 自愈 */ },
  }
}

/** 一次被捕获的出网请求（头键按**原文**保留，用于逐字节比对头集）。 */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

/**
 * 出网替身：按方法分流，并记录每次请求的头。
 *
 * ⚠️ **头名大小写原样保留，绝不用 `new Headers()` 归一**：`Headers` 会把头名全部
 * 小写化，于是 `headers['User-Agent']` 恒为 `undefined` —— 而「`User-Agent` 是裸
 * `Qoder`」这条断言正是本次真机定案的核心。用归一化后的键去断言，失败形态是
 * 「拿到了 undefined」，看起来像接线没生效，实际是**测量工具错了**。
 * 被测代码传进来的是普通对象，故直接取它的键值对。
 */
function withFetcher(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const raw = init?.headers
    const headers: Record<string, string> = raw === undefined
      ? {}
      : raw instanceof Headers
        ? Object.fromEntries(raw.entries())
        : Object.fromEntries(Object.entries(raw as Record<string, string>))
    const call: Call = { url: String(url), method: String(init?.method ?? 'GET'), headers }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

/** 活动列表响应（含一条可领活动）。 */
function campaignsBody(): Response {
  return new Response(JSON.stringify({
    showCampaign: true,
    claimable: true,
    campaigns: [{
      campaignId: 'c-1',
      campaignKey: 'act-1',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { amount: 100 },
    }],
  }), { status: 200 })
}

// ── A. 候选路径 ─────────────────────────────────────────────────────────────

describe('qoderRuntimeInfoCandidates —— 探测顺序', () => {
  it('四档按序：用户级 glob → D 盘 → Program Files → %LOCALAPPDATA%', () => {
    const candidates = qoderRuntimeInfoCandidates(QODER, HOME, { LOCALAPPDATA: join('C:', 'Users', 'probe', 'AppData', 'Local') })

    expect(candidates[0]).toEqual({ kind: 'glob', dir: BIN_DIR })
    expect(candidates.slice(1)).toEqual([
      { kind: 'file', path: join('D:', 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe') },
      { kind: 'file', path: join('C:', 'Program Files', 'Qoder', 'resources', 'umid', 'runtime-info.exe') },
      {
        kind: 'file',
        path: join('C:', 'Users', 'probe', 'AppData', 'Local', 'Programs', 'Qoder', 'resources', 'umid', 'runtime-info.exe'),
      },
    ])
  })

  it('⚠️ 安装目录名**不是**从 machineIdDir 推的：CN 是 `Qoder CN`（带空格）', () => {
    // 两者是两件事：`machineIdDir` 是 home 下的隐藏目录（`.qoder` / `.qoder-cn`），
    // 安装目录名是真机实测的 `Qoder` / `Qoder CN`。按「同形替换」从对方推会推错。
    const candidates = qoderRuntimeInfoCandidates(QODER_CN, HOME, {})
    expect(candidates[0]).toEqual({ kind: 'glob', dir: join(HOME, '.qoder-cn', '.bin') })
    expect(candidates[1]).toMatchObject({ path: join('D:', 'Programs', 'Qoder CN', 'resources', 'umid', 'runtime-info.exe') })
  })

  it('`%LOCALAPPDATA%` 缺失 / 空白时不产出该档（不拼出半截路径）', () => {
    for (const env of [{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: '   ' }]) {
      const candidates = qoderRuntimeInfoCandidates(QODER, HOME, env)
      expect(candidates.filter((c) => c.kind === 'file')).toHaveLength(2)
    }
  })
})

// ── B. 解析 ─────────────────────────────────────────────────────────────────

describe('parseQoderMachineIdentity —— 只取第一行，畸形即 undefined', () => {
  it('正常输出 ⇒ 三值（后随诊断噪音行被忽略）', () => {
    expect(parseQoderMachineIdentity(stdoutLine())).toEqual(IDENTITY)
  })

  it('整段 stdout 不是 JSON，但**首行**是 ⇒ 仍然解析成功', () => {
    // 探针同款：exe 之后可能再打印别的行，`JSON.parse` 整段必然失败。
    expect(parseQoderMachineIdentity(`${JSON.stringify(IDENTITY)}\n{"extra":1}\n`)).toEqual(IDENTITY)
  })

  it('空输出 / 非 JSON / 非对象 / 数组 ⇒ undefined', () => {
    for (const stdout of ['', '\n', '   ', 'not json', '[1,2]', 'null', '42', '"str"']) {
      expect(parseQoderMachineIdentity(stdout), JSON.stringify(stdout)).toBeUndefined()
    }
  })

  it('三值有任一缺失 / 非字符串 / 空串 ⇒ undefined（缺字段即降级，不猜）', () => {
    const cases: Array<Record<string, unknown>> = [
      { machineType: IDENTITY.machineType, machineCode: IDENTITY.machineCode },
      { machineToken: IDENTITY.machineToken, machineCode: IDENTITY.machineCode },
      { machineToken: IDENTITY.machineToken, machineType: IDENTITY.machineType },
      { ...IDENTITY, machineToken: '' },
      { ...IDENTITY, machineType: '   ' },
      { ...IDENTITY, machineCode: 12345 },
    ]
    for (const body of cases) {
      expect(parseQoderMachineIdentity(JSON.stringify(body)), JSON.stringify(body)).toBeUndefined()
    }
  })

  it('含控制字符的值 ⇒ undefined（放它出去会让 `Headers` 构造抛错，而契约是「绝不抛」）', () => {
    expect(parseQoderMachineIdentity(JSON.stringify({ ...IDENTITY, machineToken: 'P1g\r\nX-Injected: 1' }))).toBeUndefined()
    expect(parseQoderMachineIdentity(JSON.stringify({ ...IDENTITY, machineCode: 'a\u0000b' }))).toBeUndefined()
  })

  it('超长值 ⇒ undefined（防「exe 吐一整篇日志」被原样塞进请求头）', () => {
    expect(parseQoderMachineIdentity(JSON.stringify({ ...IDENTITY, machineToken: 'P'.repeat(5000) }))).toBeUndefined()
  })

  it('取值前后空白被 trim（官方可能写成「一行 + \\n」）', () => {
    expect(parseQoderMachineIdentity(JSON.stringify({ ...IDENTITY, machineType: ` ${IDENTITY.machineType} ` })))
      .toEqual(IDENTITY)
  })
})

describe('matchesObservedQoderMachineIdentityShape —— 只诊断，不拦截', () => {
  it('真机形态 ⇒ true', () => {
    expect(matchesObservedQoderMachineIdentityShape(IDENTITY)).toBe(true)
  })

  it('形态不符 ⇒ false（但**不**因此拒绝取值，见下条用例）', () => {
    expect(matchesObservedQoderMachineIdentityShape({ ...IDENTITY, machineToken: 'other-88-chars' })).toBe(false)
    expect(matchesObservedQoderMachineIdentityShape({ ...IDENTITY, machineType: 'XYZ' })).toBe(false)
  })

  it('⚠️ 形态不符的值**照发**（官方 exe 是权威来源，不是我们猜的）', () => {
    // 把观测形态写成硬闸门的后果：Qoder 哪天换 token 格式，本插件**静默退回**
    // 「天天 undetermined、一分不领」—— 正是要修的那个故障，且连原因都看不出。
    expect(parseQoderMachineIdentity(JSON.stringify({ ...IDENTITY, machineToken: 'a-new-format-token' }))).not.toBeUndefined()
  })
})

// ── C. 获取（探测 + 调用 + 缓存） ───────────────────────────────────────────

describe('getQoderMachineIdentity —— 任何失败都返回 undefined，绝不抛', () => {
  it('国际版 + 全局唯一 exe 命中 ⇒ 返回三值，且用的是 `--account-stdin`', async () => {
    const { fs } = fakeFs({ dirs: { [BIN_DIR]: [`${QODER_RUNTIME_INFO_GLOB_PREFIX}48d1294f147c9d89`] }, files: [BIN_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())

    const identity = await getQoderMachineIdentity(QODER, CREDENTIAL.user_id, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    expect(identity).toEqual(IDENTITY)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe(BIN_EXE)
    expect(calls[0]!.args).toEqual([...QODER_RUNTIME_INFO_ARGS])
    // 账号经 **stdin** 传（放命令行会进进程列表）。
    expect(calls[0]!.input).toBe(`${JSON.stringify({ account: CREDENTIAL.user_id })}\n`)
    expect(calls[0]!.input.endsWith('\n')).toBe(true)
  })

  it('账号缺失 ⇒ 仍发 stdin（传空串），不因此失败', async () => {
    const { fs } = fakeFs({ files: [PROGRAM_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())

    const identity = await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    expect(identity).toEqual(IDENTITY)
    expect(calls[0]!.input).toBe(`${JSON.stringify({ account: '' })}\n`)
  })

  it('⚠️ 三值是机器级的：换 account 拿到的仍是同一组值（缓存按 product 而非账号）', async () => {
    const { fs } = fakeFs({ files: [PROGRAM_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())
    const cache = new Map<string, QoderMachineIdentity>()
    const options = { homeDir: HOME, env: {}, platform: 'win32' as const, fs, exec, cache }

    const first = await getQoderMachineIdentity(QODER, 'user-a', options)
    const second = await getQoderMachineIdentity(QODER, 'user-b', options)

    expect(second).toEqual(first)
    // 第二次命中缓存 ⇒ 只起了一次子进程（多账号签到的 ~1.2 s 只付一次）。
    expect(calls).toHaveLength(1)
  })

  it('缓存**不跨 region**（CN 与 国际版 各自的键）', async () => {
    const { fs } = fakeFs({ files: [PROGRAM_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())
    const cache = new Map<string, QoderMachineIdentity>()

    await getQoderMachineIdentity(QODER, undefined, { homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache })
    // CN 被 region 闸挡下（下面有专条），这里只钉「缓存没被它读到」。
    await getQoderMachineIdentity(QODER_CN, undefined, { homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache })

    expect(cache.has(QODER.id)).toBe(true)
    expect(cache.has(QODER_CN.id)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('⚠️ CN ⇒ **一个 exe 都不调**、连客户端都不探测（省 ~1.2 s）', async () => {
    // 真机三次验证：CN 只需 `Cosy-ClientType: 10` 即满额，现状已够用。
    const { fs, probes, listed } = fakeFs({ files: [PROGRAM_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())
    const debug: string[] = []

    const identity = await getQoderMachineIdentity(QODER_CN, CREDENTIAL.user_id, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
      onDebug: (message) => debug.push(message),
    })

    expect(identity).toBeUndefined()
    expect(calls).toHaveLength(0)
    // 连「文件在不在」都没问过 —— 不是「探测失败」，是**这条链路不需要**。
    expect(probes).toHaveLength(0)
    expect(listed).toHaveLength(0)
    expect(debug.join('\n')).toContain('不需要设备头')
  })

  it('非 Windows ⇒ undefined，且不碰文件系统、不起子进程', async () => {
    for (const platform of ['linux', 'darwin']) {
      const { fs, probes } = fakeFs({ files: [PROGRAM_EXE] })
      const { exec, calls } = fakeExec(stdoutLine())

      const identity = await getQoderMachineIdentity(QODER, undefined, {
        homeDir: HOME, env: {}, platform, fs, exec, cache: new Map(),
      })

      expect(identity, platform).toBeUndefined()
      expect(probes, platform).toHaveLength(0)
      expect(calls, platform).toHaveLength(0)
    }
  })

  it('找不到 exe（所有候选都不存在）⇒ undefined，一次都不调用', async () => {
    const { fs, probes } = fakeFs({ dirs: { [BIN_DIR]: [] } })
    const { exec, calls } = fakeExec(stdoutLine())

    const identity = await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    expect(identity).toBeUndefined()
    expect(calls).toHaveLength(0)
    // 三个安装档**全部问过**（glob 档不含子目录 ⇒ 那档没有 `exists` 可问）。
    // 断言按真实候选表推导，而不是写一个魔数：候选增删时这里自动跟上。
    const installTierPaths = qoderRuntimeInfoCandidates(QODER, HOME, {})
      .flatMap((candidate) => candidate.kind === 'file' ? [candidate.path] : [])
    expect(probes).toEqual(installTierPaths)
  })

  it('**探测顺序**：用户级档命中时不再问后面的安装档', async () => {
    const { fs, probes } = fakeFs({
      dirs: { [BIN_DIR]: [BIN_ENTRY] },
      files: [BIN_EXE, PROGRAM_EXE],
    })
    const { exec, calls } = fakeExec(stdoutLine())

    await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    expect(calls[0]!.file).toBe(BIN_EXE)
    expect(probes).not.toContain(PROGRAM_EXE)
  })

  it('glob 档里**同目录多个版本**时取排序后的第一个（枚举顺序不稳定，须确定性）', async () => {
    const older = join(BIN_DIR, `${QODER_RUNTIME_INFO_GLOB_PREFIX}aaa`, 'runtime-info.exe')
    const newer = join(BIN_DIR, `${QODER_RUNTIME_INFO_GLOB_PREFIX}zzz`, 'runtime-info.exe')
    const { fs } = fakeFs({
      dirs: { [BIN_DIR]: [`${QODER_RUNTIME_INFO_GLOB_PREFIX}zzz`, `${QODER_RUNTIME_INFO_GLOB_PREFIX}aaa`] },
      files: [older, newer],
    })
    const { exec, calls } = fakeExec(stdoutLine())

    await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    expect(calls[0]!.file).toBe(older)
  })

  it('glob 档里前缀不符的子目录被跳过', async () => {
    const { fs } = fakeFs({ dirs: { [BIN_DIR]: ['umid-darwin-arm64-x'] }, files: [PROGRAM_EXE] })
    const { exec, calls } = fakeExec(stdoutLine())

    await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    // 前缀不符 ⇒ 回落到安装档（而不是把那个目录当成 exe 目录）。
    expect(calls[0]!.file).toBe(PROGRAM_EXE)
  })

  it('调用失败（超时 / 非零退出 / 起不来）⇒ undefined，不抛', async () => {
    for (const error of [
      Object.assign(new Error('spawn ETIMEDOUT'), { name: 'Error' }),
      Object.assign(new Error('Command failed'), { code: 1 }),
      new Error('ENOENT'),
    ]) {
      const { fs } = fakeFs({ files: [PROGRAM_EXE] })
      const { exec } = fakeExec(error)

      const identity = await getQoderMachineIdentity(QODER, undefined, {
        homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
      })

      expect(identity, error.message).toBeUndefined()
    }
  })

  it('输出畸形 ⇒ undefined，不抛', async () => {
    for (const stdout of ['', 'not json', '{}', '{"machineToken":"x"}']) {
      const { fs } = fakeFs({ files: [PROGRAM_EXE] })
      const { exec } = fakeExec(stdout)
      const debug: string[] = []

      const identity = await getQoderMachineIdentity(QODER, undefined, {
        homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
        onDebug: (message) => debug.push(message),
      })

      expect(identity, JSON.stringify(stdout)).toBeUndefined()
      expect(debug.join('\n')).toContain('输出畸形')
    }
  })

  it('⚠️ **失败不缓存**：一次失败不该让整个进程生命周期都失去设备身份', async () => {
    const { fs } = fakeFs({ files: [PROGRAM_EXE] })
    const cache = new Map<string, QoderMachineIdentity>()
    const failing = fakeExec(new Error('ENOENT'))

    expect(await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec: failing.exec, cache,
    })).toBeUndefined()

    // 下一次签到重试（exe 已可用）必须能拿到身份。
    const working = fakeExec(stdoutLine())
    expect(await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec: working.exec, cache,
    })).toEqual(IDENTITY)
  })

  it('文件系统探测抛错 ⇒ 当成「找不到」，不抛', async () => {
    const fs: QoderMachineIdentityFs = {
      async exists() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
      async listDirs() { throw new Error('EACCES') },
    }
    const { exec, calls } = fakeExec(stdoutLine())

    const identity = await getQoderMachineIdentity(QODER, undefined, {
      homeDir: HOME, env: {}, platform: 'win32', fs, exec, cache: new Map(),
    })

    // 生产默认 fs 把错误吞成 falsy；注入面若抛错，本函数也不该把它变成异常。
    expect(identity).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

// ── D. 头集构造 ─────────────────────────────────────────────────────────────

describe('qoderCampaignHeaders —— 设备头集按 region 分岔', () => {
  /** 「4. 全官方头」逐字节等价物（真机成功探针的那一套）。 */
  const OFFICIAL = {
    Accept: 'application/json',
    'User-Agent': 'Qoder',
    Authorization: 'Bearer jt-x',
    'Cosy-ClientType': '10',
    'Cosy-Version': '0.3.4',
    'Cosy-MachineToken': IDENTITY.machineToken,
    'Cosy-MachineType': IDENTITY.machineType,
    'Cosy-MachineCode': IDENTITY.machineCode,
    'Content-Type': 'application/json',
  }

  it('国际版 + 身份 ⇒ **完整全官方头集**（`UA` 是裸 `Qoder`，不是产品 UA）', () => {
    const headers = qoderCampaignHeaders('jt-x', QODER, 'application/json', IDENTITY)
    // 逐字节比对：多一个头、少一个头、大小写不同都算失败。
    expect(headers).toEqual(OFFICIAL)
    // 反证：它**不是**产品 UA（`qoder/1.1.16`）—— 真机成功探针用的是裸 `Qoder`。
    expect(headers['User-Agent']).toBe(QODER_CAMPAIGN_DEVICE_USER_AGENT)
    expect(headers['User-Agent']).not.toBe(QODER.userAgent)
    expect(headers['Cosy-Version']).toBe(QODER_CAMPAIGN_DEVICE_COSY_VERSION)
  })

  it('国际版 **无**身份 ⇒ 逐字节回到现状头集（降级路径）', () => {
    const headers = qoderCampaignHeaders('jt-x', QODER)
    expect(headers).toEqual({
      ...qoderJobTokenHeaders('jt-x', QODER),
      'Cosy-ClientType': String(QODER_CAMPAIGN_CLIENT_TYPE),
    })
    // 一个设备头都不出现（`UA` 仍是产品 UA）。
    expect(headers['User-Agent']).toBe(QODER.userAgent)
    for (const key of ['Cosy-Version', 'Cosy-MachineToken', 'Cosy-MachineType', 'Cosy-MachineCode']) {
      expect(key in headers, key).toBe(false)
    }
  })

  it('⚠️ CN + 误传身份 ⇒ 头集**一个字符都不变**（红线在构造点就被守住）', () => {
    // 不靠调用方自觉：CN 不声明 `campaignDeviceIdentity`，故即便有人误传 identity，
    // 出站形态仍与改动前逐字节相同。这是「不改 CN 任何出站值」这条红线的守卫。
    const withIdentity = qoderCampaignHeaders('jt-x', QODER_CN, 'application/json', IDENTITY)
    expect(withIdentity).toEqual(qoderCampaignHeaders('jt-x', QODER_CN))
    expect(withIdentity).toEqual({
      ...qoderJobTokenHeaders('jt-x', QODER_CN),
      'Cosy-ClientType': String(QODER_CAMPAIGN_CLIENT_TYPE),
    })
    expect(withIdentity['User-Agent']).toBe(QODER_CN.userAgent)
    expect(Object.keys(withIdentity).some((key) => key.startsWith('Cosy-Machine'))).toBe(false)
  })

  it('`accept` 透传（两个 region 都不被设备头影响）', () => {
    expect(qoderCampaignHeaders('jt-x', QODER, 'text/event-stream', IDENTITY).Accept).toBe('text/event-stream')
    expect(qoderCampaignHeaders('jt-x', QODER_CN, 'text/event-stream').Accept).toBe('text/event-stream')
  })

  it('设备头**不泄漏**到基线头集 `qoderJobTokenHeaders`（quota / chat / userinfo 的红线）', () => {
    for (const product of [QODER, QODER_CN]) {
      const headers = qoderJobTokenHeaders('jt-x', product)
      expect(Object.keys(headers).some((key) => key.toLowerCase().startsWith('cosy-')), product.id).toBe(false)
    }
  })
})

// ── E. 接线：签到 GET 与 claim POST 必须带同一套头 ──────────────────────────

describe('签到链路接线 —— 设备头同时覆盖 GET 与 POST', () => {
  /** 供测试注入的身份取用替身（记录调用，便于断言「CN 一次都没调」）。 */
  function identitySource(identity: QoderMachineIdentity | undefined) {
    const calls: Array<{ product: string; accountUserId: string | undefined }> = []
    return {
      calls,
      fetcher: async (product: { id: string }, accountUserId: string | undefined) => {
        calls.push({ product: product.id, accountUserId })
        return identity
      },
    }
  }

  it('国际版：`GET campaigns` 带全官方头，且 `user_id` 被传进身份取用', async () => {
    const source = identitySource(IDENTITY)
    const { fetcher, calls } = withFetcher(() => campaignsBody())

    await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER, machineIdentity: source.fetcher,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${QODER.openapiBase}${QODER_CAMPAIGNS_PATH}`)
    expect(calls[0]!.headers['User-Agent']).toBe('Qoder')
    expect(calls[0]!.headers['Cosy-Version']).toBe('0.3.4')
    expect(calls[0]!.headers['Cosy-MachineToken']).toBe(IDENTITY.machineToken)
    expect(calls[0]!.headers['Cosy-MachineType']).toBe(IDENTITY.machineType)
    expect(calls[0]!.headers['Cosy-MachineCode']).toBe(IDENTITY.machineCode)
    expect(source.calls).toEqual([{ product: QODER.id, accountUserId: CREDENTIAL.user_id }])
  })

  it('⚠️ 国际版：claim **POST 也是同一套全官方头**（9/23 真机 claim 成功时的形态）', async () => {
    const source = identitySource(IDENTITY)
    const { fetcher, calls } = withFetcher((call) => call.method === 'POST'
      ? new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
      : campaignsBody())

    const outcome = await claimQoderDailyCheckin(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER, machineIdentity: source.fetcher,
    })

    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    const post = calls.find((c) => c.method === 'POST')!
    const get = calls.find((c) => c.method === 'GET')!
    // GET 与 POST 的头集**逐字节相同** —— 这正是「两个调用点必须带同一套设备头」。
    expect(post.headers).toEqual(get.headers)
    expect(post.headers['User-Agent']).toBe('Qoder')
    expect(post.headers['Cosy-MachineToken']).toBe(IDENTITY.machineToken)
  })

  it('国际版：取不到身份 ⇒ 降级现状头集，签到照常发出（落入既有 undetermined 兜底）', async () => {
    const source = identitySource(undefined)
    const { fetcher, calls } = withFetcher(() => new Response(
      JSON.stringify({ showCampaign: false, claimable: false, campaigns: [] }),
      { status: 200 },
    ))

    const status = await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER, machineIdentity: source.fetcher,
    })

    // 请求**照发**（不是失败），只是头集回到现状。
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['User-Agent']).toBe(QODER.userAgent)
    expect(calls[0]!.headers['Cosy-ClientType']).toBe('10')
    expect('Cosy-MachineToken' in calls[0]!.headers).toBe(false)
    // 空列表 ⇒ active 恒 true、不伪造成已签（既有三态判读不变）。
    expect(status).toMatchObject({ active: true, todayCheckedIn: false })
  })

  it('⚠️ CN：**不调身份取用**，出站头集维持现状（无任何 Cosy-Machine*）', async () => {
    const source = identitySource(IDENTITY)
    const { fetcher, calls } = withFetcher(() => campaignsBody())

    await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER_CN, machineIdentity: source.fetcher,
    })

    // CN 不取身份（省 1.2 s）—— 这里注入的是**替身**，故断言的是接线层的行为。
    expect(source.calls).toEqual([])
    expect(calls[0]!.headers['User-Agent']).toBe(QODER_CN.userAgent)
    expect(calls[0]!.headers['Cosy-ClientType']).toBe('10')
    for (const key of ['Cosy-Version', 'Cosy-MachineToken', 'Cosy-MachineType', 'Cosy-MachineCode']) {
      expect(key in calls[0]!.headers, key).toBe(false)
    }
  })

  it('⚠️ 设备头**只**出现在 `/sash/` 请求上：quota 一次都不带', async () => {
    // 出站协议值红线：quota / chat / userinfo 走 `qoderJobTokenHeaders`，
    // 「加设备头对它们的影响」从未验证过，故绝不污染。
    const source = identitySource(IDENTITY)
    const { fetcher, calls } = withFetcher((call) => call.url.includes('/quota/usage')
      ? new Response(JSON.stringify({
          userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
        }), { status: 200 })
      : campaignsBody())

    const { fetchQoderQuotaUsage } = await import('../../src/qoder-credits.js')
    await fetchQoderQuotaUsage(CREDENTIAL, fakeAuth(), { fetcher, product: QODER })
    await fetchQoderCheckinStatus(CREDENTIAL, fakeAuth(), {
      fetcher, product: QODER, machineIdentity: source.fetcher,
    })

    const quota = calls.find((c) => c.url.includes('/quota/usage'))!
    const sash = calls.find((c) => c.url.includes('/sash/'))!
    expect(Object.keys(quota.headers).some((key) => key.toLowerCase().startsWith('cosy-'))).toBe(false)
    expect(sash.headers['Cosy-MachineToken']).toBe(IDENTITY.machineToken)
  })
})
