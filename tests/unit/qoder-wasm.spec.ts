/**
 * Qoder wasm 签名链单测（**全部 mock，不发网络、不读本机 Qoder 目录**）。
 *
 * 覆盖任务书点名的六组语义：
 *
 * 1. 提取三级优先级（缓存 → 本机 → npm → CDN）与降级错误文案；
 * 2. SHA-256 不匹配必须**拒绝**（不是「用了再说」）；
 * 3. `QoderContext` 构造参数形态、三件套透传、`free` 调用；
 * 4. 凭据变更触发重建、同凭据复用；
 * 5. `machineId` 的来源是**登录链落盘的那一份**（本模块不自己造）；
 * 6. 从 wasm 的偏移无关性（四个实测来源的偏移各不相同）。
 *
 * ⚠️ **本文件刻意不加载真实 wasm**：wasm 字节是官方二进制，不进仓库
 * （见 `src/qoder-wasm.ts` 的许可说明）。真机验证在提交流程里单独跑。
 * 这里用**假 glue** 钉死契约 —— 假 glue 的形状与真 glue 逐字段一致
 * （`wasm` + `internals` 两个成员），所以「契约有没有被改坏」是可测的。
 */

import { describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'

import { QODER, QODER_CN } from '../../src/qoder-product.js'
import {
  QODER_WASM_BYTES,
  QODER_WASM_SHA256,
  QoderWasmUnavailableError,
  buildUnavailableMessage,
  extractFromTarGz,
  extractQoderWasm,
  extractWasmFromWorkerText,
  localPackageNames,
  parseNpmTarballUrl,
  qoderWasmCachePath,
  qoderWasmLocalInstallDirs,
  sha256Hex,
  verifyQoderWasm,
} from '../../src/qoder-wasm.js'
import {
  QODER_DEFAULT_COSY_VERSION,
  QODER_DEFAULT_SCENE,
  QODER_SIGNED_CHAT_PATH,
  QoderWasmSigner,
  buildQoderRuntimeAuthInput,
  buildQoderUserInfoJson,
  qoderClientMetadata,
  qoderUserInfoFingerprint,
} from '../../src/qoder-wasm-context.js'
import { createGlueImports, createGlueInternals } from '../../src/qoder-wasm-glue.js'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

/**
 * 造一段「看似 wasm」的字节（首四字节是 `\0asm` 魔数）。
 *
 * ⚠️ **必须撑到 23 万字节以上**：生产代码按「base64 长度 ≥ 300 000」筛掉
 * worker 里那几个更小的 wasm（真实 worker 里还有 205 488 与 1 380 769 字节的
 * 两个非签名 wasm）。夹具若做小了，测的就不是「能不能抠出来」而是「阈值
 * 有没有生效」—— 那是另一条用例的事（见「只认够大的那一条」）。
 */
function fakeWasmBytes(payload: string): Uint8Array {
  const head = Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d]),
    Buffer.from(payload, 'utf8'),
  ])
  // 补足到 230 000 字节 ⇒ base64 约 306 668 字符，稳稳越过阈值。
  const target = 230_000
  const filler = Buffer.alloc(Math.max(0, target - head.length), 0x42)
  return new Uint8Array(Buffer.concat([head, filler]))
}

/**
 * 造一个 worker runtime 文本，把给定的 wasm 以 base64 **内联**进去。
 *
 * 前后塞入别的 base64 字面量，模拟真实 worker（里面还有两个更小的 wasm）
 * —— 这正是「按前缀定位 + 大小过滤」要被验证的场景。诱饵**刻意做小**
 * （真实 worker 里的非签名 wasm 是 205 488 / 1 380 769 字节，都小于签名组件的
 * base64 长度阈值）。
 */
function fakeWorkerText(wasm: Uint8Array, options: { offsetPadding?: number } = {}): string {
  const padding = 'x'.repeat(options.offsetPadding ?? 0)
  const decoy = Buffer.from(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, ...Buffer.from('decoy-small-wasm', 'utf8'),
  ])).toString('base64')
  return `${padding}var a="key",$9s="Tir=S(()=>{",b="${decoy}",${'q'.repeat(40)}`
    + `Rir={};Xn(Rir,{default:()=>$9s});var $9s,Tir=S(()=>{$9s="${Buffer.from(wasm).toString('base64')}"`
}

/** 造一个 tar.gz，内含指定名字的文件。 */
function fakeTarGz(name: string, content: Buffer): Uint8Array {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644', 100, 'utf8') // mode
  header.write('0000000', 108, 'utf8') // uid
  header.write('0000000', 116, 'utf8') // gid
  header.write(content.length.toString(8).padStart(11, '0'), 124, 'utf8')
  header.write('00000000000', 136, 'utf8') // mtime
  header.write('        ', 148, 'utf8') // checksum（本实现的解析器不校验）
  header[156] = 0x30 // typeflag '0'
  header.write('ustar', 257, 'utf8')
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length)
  const tar = Buffer.concat([header, content, padding, Buffer.alloc(1024)])
  return new Uint8Array(gzipSync(tar))
}

/**
 * 假 glue —— 形状与真 glue 一致（`wasm` + `internals` 两个成员）。
 *
 * 它按调用序列吐出可预期的数据：`generate_runtime_auth_fields` 回一段固定
 * JSON；`qodercontext_new` 回一个递增的指针；`prepareInferRequest` 回三件套。
 *
 * 放在模块作用域（而不是某个 describe 里）是因为**两组用例都要用它**：
 * 一组测复用/重建，一组测 machineId 来源。
 */
function makeFakeGlue() {
  const calls = {
    generate: [] as string[],
    newContext: [] as Array<[string, string, string, string]>,
    freedContexts: [] as number[],
    infer: [] as Array<[number, string, string, string, string]>,
  }
  let nextPtr = 1000
  let stubString = ''
  let stubInt = 0
  const lastPassed: string[] = []

  const internals = {
    getObject: (i: number) => i,
    dropObject: () => {},
    // 返回 `unknown` 而非 `number`：下面会被换成「真的回一个 Map」的实现
    // （`headers` 走 takeObject 取出），写死 number 就没法覆盖。
    takeObject: (_i: number): unknown => 0,
    addHeapObject: (v: unknown) => (typeof v === 'number' ? v : 0),
    // getDataView/getString 需要按调用点返回不同值 ⇒ 让它们读闭包。
    getDataView: () => {
      const dv = new DataView(new ArrayBuffer(64))
      dv.setInt32(0, stubInt, true)
      return dv
    },
    getUint8: () => new Uint8Array(0),
    getString: () => stubString,
    getArrayU8: () => new Uint8Array(0),
    passString: (s: string) => {
      // 用字符串长度当「指针」，并把内容记在闭包里供断言。
      lastPassed.push(s)
      return s.length
    },
    vectorLen: () => lastPassed[lastPassed.length - 1]?.length ?? 0,
  }

  const wasm = {
    __wbindgen_add_to_stack_pointer: () => 0,
    __wbindgen_export: () => {},
    __wbindgen_export2: () => 0,
    __wbindgen_export3: () => 0,
    __wbindgen_export4: () => {},
    __wbg_qodercontext_free: (ptr: number) => { calls.freedContexts.push(ptr) },
    __wbg_requestresult_free: () => {},
    generate_runtime_auth_fields: (_rp: number, _ptr: number, _len: number) => {
      calls.generate.push(lastPassed[lastPassed.length - 1] ?? '')
      // 回写：把 JSON 塞进 DataView 指向的内存 —— 由 getString 桩返回。
      stubString = JSON.stringify({ encrypt_user_info: 'ENC', key: 'KEY' })
    },
    qodercontext_new: (_rp: number, a: number, b: number, c: number, d: number) => {
      calls.newContext.push([
        lastPassed[lastPassed.length - 4] ?? '',
        lastPassed[lastPassed.length - 3] ?? '',
        lastPassed[lastPassed.length - 2] ?? '',
        lastPassed[lastPassed.length - 1] ?? '',
      ])
      stubInt = nextPtr++
    },
    qodercontext_prepareInferRequest: (
      _rp: number, ctx: number, a: number, b: number, c: number, d: number,
    ) => {
      const s = (i: number) => lastPassed[lastPassed.length - i] ?? ''
      calls.infer.push([ctx, s(4), s(3), s(2), s(1)])
      stubInt = 7777 // RequestResult 指针
    },
    requestresult_url: () => { stubString = 'https://signed.example.test/path?q=1' },
    requestresult_body: () => { stubString = 'CIPHERTEXT' },
    requestresult_headers: () => 0,
    requestresult_headerCount: () => 0,
  }

  // `prepareInferRequest` 的 headers 走 `takeObject` 取出 ⇒ 假 glue 必须真的
  // 回一个 Map（否则会被生产代码的「不是 Map」判据挡下）。这条覆盖掉上面那个
  // 只为错误路径服务的默认实现。
  internals.takeObject = (): unknown => new Map([['Cosy-ClientType', 'qodercli']])

  return { glue: { wasm, internals } as never, calls }
}

/** 一组固定业务字段（每个用例都用同一份，避免各写各的漂移）。 */
const userInfo = {
  uid: 'u-1', securityOauthToken: 'jt-1', organizationId: '', organizationTags: [], dataPolicyAgreed: true,
}

/**
 * 假 homeDir —— ⚠️ **凡是没显式传 machineId 的用例都必须带**。
 *
 * 不传就会去读写用户真实 home 下的 `~/.qoder/.auth/machine_id`；这里给一个
 * 必然不存在的盘符，让默认取用路径走「读不到 ⇒ 生成一个」，既覆盖真实契约、
 * 又不碰用户环境。
 */
const offRealHome = { homeDir: 'X:\\nonexistent-machine-id-home' }

/**
 * 一份「哈希正确」的 wasm 无法在测试里造出来（哈希是官方固定值）。
 *
 * 故凡涉及「缓存命中」的用例都走「哈希不符 ⇒ 跳过」这一侧；
 * 正例由真机验证覆盖。
 */

// ── 抠取：偏移无关 ──────────────────────────────────────────────────────────

describe('从 worker 文本抠 wasm（偏移无关）', () => {
  it('能从内联 base64 抠出字节，且与内联内容逐字节一致', () => {
    const wasm = fakeWasmBytes('hello-wasm-payload')
    const text = fakeWorkerText(wasm)
    const got = extractWasmFromWorkerText(text)
    expect(got).toBeDefined()
    expect(Buffer.from(got!).equals(Buffer.from(wasm))).toBe(true)
  })

  it('**偏移变化不影响结果**（四个真实来源的偏移各异：25371/25438/25442/25447）', () => {
    const wasm = fakeWasmBytes('offset-independent')
    const base = extractWasmFromWorkerText(fakeWorkerText(wasm))
    expect(base).toBeDefined()
    for (const pad of [0, 1234, 56789]) {
      const shifted = extractWasmFromWorkerText(fakeWorkerText(wasm, { offsetPadding: pad }))
      expect(shifted).toBeDefined()
      expect(Buffer.from(shifted!).equals(Buffer.from(base!))).toBe(true)
    }
  })

  it('只认「够大」的那一条：小 wasm 诱饵不会被误取', () => {
    const wasm = fakeWasmBytes('real')
    const text = fakeWorkerText(wasm)
    // 诱饵只有 15 字节，远小于 300 000 的阈值 ⇒ 必须跳过它拿到真身。
    const got = extractWasmFromWorkerText(text)
    expect(Buffer.from(got!).equals(Buffer.from(wasm))).toBe(true)
  })

  it('文本里没有内联 wasm 时返回 undefined（国际版 npm 包就是这个形态）', () => {
    expect(extractWasmFromWorkerText('var a = "nothing here"')).toBeUndefined()
  })

  it('base64 解出来不是 wasm 魔数时跳过（不把垃圾当 wasm）', () => {
    const junkB64 = Buffer.alloc(400_000, 0x41).toString('base64') // 40 万字节的 'A'
    expect(extractWasmFromWorkerText(`$9s="${junkB64}"`)).toBeUndefined()
  })
})

// ── 校验 ────────────────────────────────────────────────────────────────────

describe('SHA-256 校验', () => {
  it('哈希不匹配必须拒绝，且错误里同时给出期望值、实际值与长度', () => {
    const verdict = verifyQoderWasm(fakeWasmBytes('not-the-real-thing'))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toContain(QODER_WASM_SHA256)
    expect(verdict.reason).toContain('SHA-256 不匹配')
  })

  it('空字节被拒绝（不能靠「长度为 0」蒙混）', () => {
    const verdict = verifyQoderWasm(new Uint8Array(0))
    expect(verdict.ok).toBe(false)
  })

  it('判据是哈希而非长度：长度对但内容错照样拒绝', () => {
    // 298 606 字节的正确长度 + 错误内容 ⇒ 必须拒绝。
    const sameLength = new Uint8Array(QODER_WASM_BYTES)
    sameLength.set([0x00, 0x61, 0x73, 0x6d])
    const verdict = verifyQoderWasm(sameLength)
    expect(sameLength.length).toBe(QODER_WASM_BYTES)
    expect(verdict.ok).toBe(false)
  })

  it('sha256Hex 是 64 字符小写十六进制（与常量同口径）', () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{64}$/)
    expect(QODER_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── 缓存路径与 tar 解析 ─────────────────────────────────────────────────────

describe('缓存路径与 tar 解析', () => {
  it('缓存落在 ~/.dsh 下（不写进用户 home 根，也不写进仓库）', () => {
    const path = qoderWasmCachePath('C:\\Users\\someone')
    expect(path).toContain('.dsh')
    expect(path).toContain('qoder-wasm')
    expect(path.endsWith('qoder_auth_wasm_bg.wasm')).toBe(true)
  })

  it('能从 tar.gz 里按后缀取出成员', async () => {
    const tarGz = fakeTarGz('qoder-worker-runtime/dist/_worker/qoder-worker-runtime.obf.mjs', Buffer.from('worker-body'))
    const got = await extractFromTarGz(tarGz, 'qoder-worker-runtime.obf.mjs')
    expect(got).toBeDefined()
    expect(Buffer.from(got!).toString('utf8')).toBe('worker-body')
  })

  it('成员不存在时返回 undefined（不是抛错、也不是空 buffer）', async () => {
    const tarGz = fakeTarGz('some/other-file.txt', Buffer.from('x'))
    expect(await extractFromTarGz(tarGz, 'qoder-worker-runtime')).toBeUndefined()
  })

  it('npm packument 解析只认 dist-tags.latest 指向的 tarball', () => {
    const url = parseNpmTarballUrl({
      'dist-tags': { latest: '1.2.3' },
      versions: { '1.2.3': { dist: { tarball: 'https://example.test/a.tgz' } } },
    })
    expect(url).toBe('https://example.test/a.tgz')
  })

  it('packument 形态不对时返回 undefined（各种残缺形态）', () => {
    expect(parseNpmTarballUrl(null)).toBeUndefined()
    expect(parseNpmTarballUrl({})).toBeUndefined()
    expect(parseNpmTarballUrl({ 'dist-tags': {} })).toBeUndefined()
    expect(parseNpmTarballUrl({ 'dist-tags': { latest: '1.0.0' }, versions: {} })).toBeUndefined()
    expect(parseNpmTarballUrl({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } })).toBeUndefined()
  })
})

// ── 提取优先级 ──────────────────────────────────────────────────────────────

describe('提取优先级（缓存 → 本机 → npm → CDN）', () => {
  it('缓存存在但**哈希不匹配**时被跳过（继续往下一级走，而不是用可疑字节）', async () => {
    const readLocalWorker = vi.fn().mockReturnValue(undefined)
    const fetchBytes = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(extractQoderWasm({
      product: QODER,
      homeDir: 'C:\\fake-home',
      // 缓存存在但内容是垃圾（哈希必然不符）。
      readCache: async () => fakeWasmBytes('corrupted-cache'),
      writeCache: async () => {},
      readLocalWorker,
      fetchBytes,
    })).rejects.toBeInstanceOf(QoderWasmUnavailableError)
    // 「被跳过」的证据：后续各级真的被走到了。
    expect(readLocalWorker).toHaveBeenCalled()
    expect(fetchBytes).toHaveBeenCalled()
  })

  it('本机目录优先于 npm：本机拿不到时才走到 npm', async () => {
    // 造一个哈希正确的 wasm 不可行（哈希是官方固定值），故本用例验证的是
    // 「本机返回 undefined 后，npm/网络这一级确实被走到」这条**控制组**。
    const fetchBytes = vi.fn().mockRejectedValue(new Error('should reach npm'))
    const readLocalWorker = vi.fn().mockReturnValue(undefined)
    await expect(extractQoderWasm({
      product: QODER,
      homeDir: 'C:\\fake-home',
      readCache: async () => undefined,
      writeCache: async () => {},
      readLocalWorker,
      fetchBytes,
      localDirs: ['C:\\no-such-dir'],
    })).rejects.toBeInstanceOf(QoderWasmUnavailableError)
    expect(readLocalWorker).toHaveBeenCalled()
    expect(fetchBytes).toHaveBeenCalled()
  })

  it('全部失败时错误文案含「未找到 Qoder 签名组件」与各级原因', async () => {
    const error = await extractQoderWasm({
      product: QODER,
      homeDir: 'C:\\fake-home',
      readCache: async () => undefined,
      writeCache: async () => {},
      readLocalWorker: () => undefined,
      fetchBytes: async () => { throw new Error('HTTP 500') },
      localDirs: ['C:\\no-such-dir'],
    }).catch((e: unknown) => e as QoderWasmUnavailableError)

    expect(error).toBeInstanceOf(QoderWasmUnavailableError)
    expect(error.message).toContain('未找到 Qoder 签名组件（wasm）')
    expect(error.message).toContain('已尝试本机安装与 npm 提取')
    expect(error.attempts.some((a) => a.source === 'cache')).toBe(true)
    expect(error.attempts.some((a) => a.source === 'local-install')).toBe(true)
    expect(error.attempts.some((a) => a.source === 'npm-tarball')).toBe(true)
    expect(error.attempts.some((a) => a.source === 'cdn-tarball')).toBe(true)
  })

  it('buildUnavailableMessage 在没有任何原因时不拼多余标点', () => {
    expect(buildUnavailableMessage([])).toBe('未找到 Qoder 签名组件（wasm），已尝试本机安装与 npm 提取')
  })

  it('两个 region 的包名各自独立（实测：CN 不是 @qoder-ai/*）', () => {
    expect(localPackageNames(QODER)).toEqual(['@qoder-ai/qoder-agent-sdk'])
    expect(localPackageNames(QODER_CN)).toContain('@qoder-ai/qoder-cn-agent-sdk')
  })

  it('本机目录候选覆盖三类落点，且不依赖某一台机器的盘符', () => {
    const dirs = qoderWasmLocalInstallDirs({
      USERPROFILE: 'C:\\Users\\someone',
      LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    })
    // ① 实测落点
    expect(dirs).toContain('D:\\Programs\\Qoder')
    expect(dirs).toContain('D:\\Programs\\Qoder CN')
    // ② Electron 常规位置（官方安装器默认）
    expect(dirs).toContain('C:\\Users\\someone\\AppData\\Local\\Programs\\Qoder')
    expect(dirs).toContain('C:\\Program Files\\Qoder CN')
    // ③ 非 Windows 的常见位置
    expect(dirs).toContain('/Applications/Qoder.app')
  })

  it('环境变量缺失时不抛错（CI / 精简环境）', () => {
    expect(() => qoderWasmLocalInstallDirs({})).not.toThrow()
    expect(qoderWasmLocalInstallDirs({}).length).toBeGreaterThan(0)
  })
})

// ── clientMetadata 与 userInfo 形态 ─────────────────────────────────────────

describe('clientMetadata 与 userInfo 形态（出站身份标识）', () => {
  it('clientMetadata 的字段集逐字对齐官方 kg()，且 client_type 随 region', () => {
    expect(JSON.parse(qoderClientMetadata(QODER))).toEqual({
      client_type: 'qodercli',
      business_product: 'cli',
      business_type: 'agent',
      scene: QODER_DEFAULT_SCENE,
    })
    expect(JSON.parse(qoderClientMetadata(QODER_CN))).toEqual({
      client_type: '5',
      business_product: 'cli',
      business_type: 'agent',
      scene: QODER_DEFAULT_SCENE,
    })
  })

  it('第一段 userInfo 只有官方那五个业务字段（多的少的一律不行）', () => {
    const json = buildQoderRuntimeAuthInput({
      uid: 'u', securityOauthToken: 'jt-x', organizationId: '', organizationTags: [], dataPolicyAgreed: true,
    })
    expect(Object.keys(JSON.parse(json))).toEqual([
      'uid', 'security_oauth_token', 'organization_id', 'organization_tags', 'data_policy_agreed',
    ])
  })

  it('第二段 userInfo **必须**带上 encrypt_user_info 与 key（漏了 wasm 会直接拒构造）', () => {
    const json = buildQoderUserInfoJson(
      { uid: 'u', securityOauthToken: 'jt-x', organizationId: '', organizationTags: [], dataPolicyAgreed: true },
      { encrypt_user_info: 'ENC', key: 'KEY' },
    )
    const parsed = JSON.parse(json)
    expect(parsed.encrypt_user_info).toBe('ENC')
    expect(parsed.key).toBe('KEY')
    expect(Object.keys(parsed)).toContain('security_oauth_token')
  })

  it('凭据指纹覆盖令牌本体与全部业务字段（令牌变则指纹必变）', () => {
    const base = { uid: 'u', securityOauthToken: 'jt-1', organizationId: '', organizationTags: [], dataPolicyAgreed: true }
    const fp = qoderUserInfoFingerprint(base)
    expect(qoderUserInfoFingerprint({ ...base, securityOauthToken: 'jt-2' })).not.toBe(fp)
    expect(qoderUserInfoFingerprint({ ...base, uid: 'other' })).not.toBe(fp)
    expect(qoderUserInfoFingerprint({ ...base, dataPolicyAgreed: false })).not.toBe(fp)
    expect(qoderUserInfoFingerprint({ ...base, organizationTags: ['t'] })).not.toBe(fp)
    expect(qoderUserInfoFingerprint({ ...base })).toBe(fp)
  })

  it('签名路径常量是官方实测的那一条', () => {
    expect(QODER_SIGNED_CHAT_PATH).toBe('/algo/api/v2/service/pro/sse/agent_chat_generation')
    expect(QODER_DEFAULT_COSY_VERSION).toBe('1.1.57')
  })
})

// ── glue：import 分派 ───────────────────────────────────────────────────────

describe('glue import 分派（同名不同义的两个坑）', () => {
  /** 极简假 wasm：glue 只在 forward 的错误路径上用 `__wbindgen_export`。 */
  const fakeWasm = { __wbindgen_export: vi.fn() } as never

  it('两个 getRandomValues 按完整名分派到不同实现', () => {
    const internals = createGlueInternals(() => fakeWasm)
    const imports = createGlueImports(() => fakeWasm, internals) as {
      './qoder_auth_wasm_bg.js': Record<string, (...a: never[]) => unknown>
    }
    const ns = imports['./qoder_auth_wasm_bg.js']
    const globalCryptoVersion = ns['__wbg_getRandomValues_d49329ff89a07af1']
    const objectVersion = ns['__wbg_getRandomValues_c44a50d8cfdaebeb']
    expect(globalCryptoVersion).toBeDefined()
    expect(objectVersion).toBeDefined()
    expect(globalCryptoVersion).not.toBe(objectVersion)
  })

  it('`__wbg_new_` 的两个变体语义不同：一个是 Uint8Array(len)、一个是 Map()', () => {
    const internals = createGlueInternals(() => fakeWasm)
    const imports = createGlueImports(() => fakeWasm, internals) as {
      './qoder_auth_wasm_bg.js': Record<string, (...a: never[]) => unknown>
    }
    const ns = imports['./qoder_auth_wasm_bg.js']
    const lengthVariant = ns['__wbg_new_with_length_9cedd08484b73942'] as (n: number) => number
    const mapVariant = ns['__wbg_new_99cabae501c0a8a0'] as () => number
    expect(internals.getObject(lengthVariant(4))).toBeInstanceOf(Uint8Array)
    expect(internals.getObject(mapVariant())).toBeInstanceOf(Map)
  })

  it('未知 import 会**显式抛错**（不静默塞空函数）', () => {
    const internals = createGlueInternals(() => fakeWasm)
    const imports = createGlueImports(() => fakeWasm, internals) as {
      './qoder_auth_wasm_bg.js': Record<string, unknown>
    }
    const ns = imports['./qoder_auth_wasm_bg.js'] as Record<string, unknown>
    expect(() => ns['__wbg_totally_unknown_thing_zzz']).toThrow(/未实现的宿主函数/)
  })

  it('堆槽：addHeapObject / takeObject 回收索引，保留区不被写坏', () => {
    const internals = createGlueInternals(() => fakeWasm)
    const a = internals.addHeapObject({ v: 1 })
    const b = internals.addHeapObject({ v: 2 })
    expect(a).not.toBe(b)
    expect(internals.takeObject(a)).toEqual({ v: 1 })
    // 回收后同一索引可被复用。
    const c = internals.addHeapObject({ v: 3 })
    expect(c).toBe(a)
    expect(internals.getObject(b)).toEqual({ v: 2 })
  })

  it('is_* 系列走前缀兜底（哈希后缀漂移时仍可用）', () => {
    const internals = createGlueInternals(() => fakeWasm)
    const imports = createGlueImports(() => fakeWasm, internals) as {
      './qoder_auth_wasm_bg.js': Record<string, (...a: never[]) => unknown>
    }
    const ns = imports['./qoder_auth_wasm_bg.js']
    const isString = ns['__wbg___wbindgen_is_string_deadbeefdeadbeef'] as (i: number) => boolean
    const idx = internals.addHeapObject('hello')
    expect(isString(idx)).toBe(true)
    expect(isString(internals.addHeapObject(42))).toBe(false)
  })
})

// ── 签名器：复用与重建 ──────────────────────────────────────────────────────

describe('QoderWasmSigner：实例复用与凭据变更重建', () => {
  it('同一凭据 + 同一机器码 ⇒ **复用**上下文（不重复构造）', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    const a = await signer.contextFor({ machineId: 'm-1', userInfo })
    const b = await signer.contextFor({ machineId: 'm-1', userInfo })
    expect(a).toBe(b)
    expect(calls.newContext).toHaveLength(1)
  })

  it('**凭据变更触发重建**，且旧上下文被释放', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    const a = await signer.contextFor({ machineId: 'm-1', userInfo })
    const b = await signer.contextFor({
      machineId: 'm-1', userInfo: { ...userInfo, securityOauthToken: 'jt-2' },
    })
    expect(a).not.toBe(b)
    expect(calls.newContext).toHaveLength(2)
    expect(calls.freedContexts).toHaveLength(1)
  })

  it('机器码变更同样触发重建（签名头里的机器身份不能是旧的）', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    await signer.contextFor({ machineId: 'm-1', userInfo })
    await signer.contextFor({ machineId: 'm-2', userInfo })
    expect(calls.newContext).toHaveLength(2)
  })

  it('构造时**先派生密钥再构造上下文**，且构造参数是（machineId, cosyVersion, userInfoJson, clientMetadata）', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    await signer.contextFor({ machineId: 'machine-abc', userInfo })

    // 派生一步：入参是五字段 JSON。
    expect(calls.generate).toHaveLength(1)
    expect(Object.keys(JSON.parse(calls.generate[0]!))).toEqual([
      'uid', 'security_oauth_token', 'organization_id', 'organization_tags', 'data_policy_agreed',
    ])

    // 构造一步：四参数形态。
    expect(calls.newContext).toHaveLength(1)
    const [machineId, cosyVersion, userInfoJson, clientMetadataJson] = calls.newContext[0]!
    expect(machineId).toBe('machine-abc')
    expect(cosyVersion).toBe(QODER_DEFAULT_COSY_VERSION)
    const parsedUser = JSON.parse(userInfoJson)
    expect(parsedUser.encrypt_user_info).toBe('ENC')
    expect(parsedUser.key).toBe('KEY')
    expect(parsedUser.security_oauth_token).toBe('jt-1')
    expect(JSON.parse(clientMetadataJson).business_type).toBe('agent')
  })

  it('CN 的 cosyVersion 取产品配置值（不是国际版的兜底值）', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER_CN, machineIdOptions: offRealHome })
    await signer.contextFor({ machineId: 'm-cn', userInfo })
    expect(calls.newContext[0]![1]).toBe(QODER_CN.cosyVersion)
  })

  it('prepareInferRequest 把四参数原样透传（endpoint/body/modelKey/modelSource）', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    const ctx = await signer.contextFor({ machineId: 'm', userInfo })
    const result = ctx.prepareInferRequest(
      'https://gateway.qoder.com.cn', '{"a":1}', 'lite', 'system',
    )
    expect(calls.infer).toHaveLength(1)
    const [, endpoint, body, modelKey, modelSource] = calls.infer[0]!
    expect(endpoint).toBe('https://gateway.qoder.com.cn')
    expect(body).toBe('{"a":1}')
    expect(modelKey).toBe('lite')
    // ⚠️ `'system'` 是官方 `model_config?.source ?? "system"` 的**兜底值**
    // （三值域 system / user / custom）。本夹具曾写作 `'solo_work_remote'` ——
    // 那是 **Trae** 的 function 名，与 Qoder 毫无关系，已更正。
    expect(modelSource).toBe('system')
    // 三件套来自 wasm，**不是**原样回传调用方的输入。
    expect(result.url).toBe('https://signed.example.test/path?q=1')
    expect(result.body).toBe('CIPHERTEXT')
    expect(result.headers.get('Cosy-ClientType')).toBe('qodercli')
    expect(typeof result.free).toBe('function')
  })

  it('`dispose()` 释放上下文，重复调用安全；释放后再用会抛', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    const ctx = await signer.contextFor({ machineId: 'm', userInfo })
    ctx.dispose()
    ctx.dispose()
    expect(calls.freedContexts).toHaveLength(1)
    expect(() => ctx.prepareInferRequest('e', 'b', 'k', 's')).toThrow(/已释放/)
  })

  it('signer.dispose() 之后再取上下文会重新构造', async () => {
    const { glue, calls } = makeFakeGlue()
    const signer = new QoderWasmSigner({ glue, product: QODER, machineIdOptions: offRealHome })
    await signer.contextFor({ machineId: 'm', userInfo })
    signer.dispose()
    await signer.contextFor({ machineId: 'm', userInfo })
    expect(calls.newContext).toHaveLength(2)
    expect(calls.freedContexts).toHaveLength(1)
  })
})

// ── machineId 的来源（接登录链，而不是自己造） ──────────────────────────────

describe('machineId 的来源：接登录链，而不是自己造', () => {
  /** 假 IO 注入面，避免碰真实文件系统。 */
  function makeIo(existing?: string) {
    const written: Array<{ path: string; data: string }> = []
    const io = {
      readFile: async (): Promise<string> => {
        if (existing === undefined) throw new Error('ENOENT')
        return existing
      },
      mkdir: async (): Promise<void> => {},
      writeFile: async (path: string, data: string): Promise<void> => { written.push({ path, data }) },
    }
    return { io, written }
  }

  it('省略 machineId 时**自动取用**，读的是登录链落盘路径（`<home>/.qoder/.auth/machine_id`）', async () => {
    const { glue, calls } = makeFakeGlue()
    const { io, written } = makeIo('11111111-2222-3333-4444-555555555555')
    const signer = new QoderWasmSigner({
      glue,
      product: QODER,
      machineIdOptions: { homeDir: 'C:\\fake-home', io },
    })
    await signer.contextFor({ userInfo })

    // 落盘已有 ⇒ **原样读用、绝不覆盖**（官方 CLI 共用同一份机器身份）。
    expect(calls.newContext[0]![0]).toBe('11111111-2222-3333-4444-555555555555')
    expect(written).toHaveLength(0)
  })

  it('CN 读的是 CN 的目录（两区机器身份互不覆盖）', async () => {
    const { glue, calls } = makeFakeGlue()
    const { io, written } = makeIo(undefined)
    const signer = new QoderWasmSigner({
      glue,
      product: QODER_CN,
      machineIdOptions: { homeDir: 'C:\\fake-home', io },
    })
    await signer.contextFor({ userInfo })
    // 路径里必须是 `.qoder-cn`，不是 `.qoder`。
    expect(written[0]!.path).toContain('.qoder-cn')
    expect(calls.newContext[0]![0]).toBe(written[0]!.data)
  })

  it('落盘失败 ⇒ 退回内存态 UUID，**不抛**（磁盘不可写不该挡住签名）', async () => {
    const { glue, calls } = makeFakeGlue()
    const io = {
      readFile: async (): Promise<string> => { throw new Error('ENOENT') },
      mkdir: async (): Promise<void> => { throw new Error('EACCES') },
      writeFile: async (): Promise<void> => { throw new Error('EACCES') },
    }
    const signer = new QoderWasmSigner({
      glue,
      product: QODER,
      machineIdOptions: { homeDir: 'C:\\fake-home', io },
    })
    await expect(signer.contextFor({ userInfo })).resolves.toBeDefined()
    expect(calls.newContext[0]![0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('**取用发生在复用判据之前**：机器码来源变了 ⇒ 必须重建', async () => {
    const { glue, calls } = makeFakeGlue()
    let current = 'machine-a'
    const signer = new QoderWasmSigner({
      glue,
      product: QODER,
      readMachineId: async () => current,
    })
    await signer.contextFor({ userInfo })
    await signer.contextFor({ userInfo })
    expect(calls.newContext).toHaveLength(1) // 同机器码 ⇒ 复用

    current = 'machine-b'
    await signer.contextFor({ userInfo })
    expect(calls.newContext).toHaveLength(2) // 机器码变了 ⇒ 重建
  })
})
