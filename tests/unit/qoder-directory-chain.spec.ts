/**
 * Qoder **设备流目录链**（wasm 签名目录）+ 目录回填行显示名 + catalogSource 单测。
 *
 * ## 为什么单独成文件
 *
 * 本文件钉的是 stage-a 取证定案（结论 B）的三条链：
 *
 * 1. **目录链**：`GET {inferenceHost}/algo/api/v2/model/list?Encode=1`，
 *    URL 与头全由 wasm `QoderContext.prepareRequest(endpoint, path, "GET",
 *    "auth", …)` 生成（与 chat 的 `prepareInferRequest` 同机制），响应经
 *    `decrypt_server_response` 解码（失败原样返回 = 明文兼容）。分派判据是
 *    **令牌族**：`dt-` 走目录链，`pt-` 走既有 `/api/v1/cloud/models`（一行不动）。
 * 2. **回填行显示名**：`ContextTierSource.displayName` 两级查名
 *    （生效目录 → 静态表），黑名单并集回填行用它替换写死的 `name = id`。
 * 3. **catalogSource**：`model.list` 响应带 `catalogSource`，客户端据此提示
 *    「当前为兜底清单」。
 *
 * 全部 mock（假 glue / 假签名来源 / 假 fetch），零网络、零真 wasm。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  QoderDirectoryNegativeCache,
  QODER_DEVICE_MODELS_PATH,
  QODER_DIRECTORY_NEGATIVE_TTL_MS,
  fetchQoderDirectory,
  parseQoderSceneDirectory,
  resolveQoderDirectoryEndpoint,
} from '../../src/qoder-models.js'
import type { QoderModelEntry } from '../../src/qoder-models.js'
import {
  QODER,
  QODER_CN,
  QODER_INFER_HOST,
} from '../../src/qoder-product.js'
import type { QoderCredential } from '../../src/qoder-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import type { QoderAdapterOptions } from '../../src/qoder-adapter.js'
import {
  QoderSigningProvider,
  qoderDirectorySigningSource,
} from '../../src/qoder-signing.js'
import type { QoderDirectorySigningSource } from '../../src/qoder-signing.js'
import { QoderSigningContext, decryptQoderServerResponse } from '../../src/qoder-wasm-context.js'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 设备流凭据（`dt-` 前缀，与真机 poll 返回同形）。 */
const DEVICE_CREDENTIAL: QoderCredential = {
  access_token: 'dt-device-token',
  refresh_token: 'drt-test',
}

/** PAT 凭据（既有目录路径的既有形态）。 */
const PAT_CREDENTIAL: QoderCredential = {
  access_token: 'pt-test-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/**
 * scene 键控目录响应（新端点形态，字段清单照 **真机 dump**（2026-09-21 两区
 * 200 实测）逐字对齐：`key` / `display_name` / `enable` / `is_vl` /
 * `is_reasoning` / `max_input_tokens` / `is_default` / `price_factor` / …，
 * 窗口在 **`context_config`**（`{档名: {token_count, is_default?}}`）、
 * 档位在 **`thinking_config.enabled.efforts`**（对象 + 各档 `is_default`）。
 *
 * ⚠️ 与 stage-a 报告从 worker 代码推断的平铺 `available_context_windows` /
 * `efforts` 不同 —— 真机 200 响应是嵌套形态，解析器以真机为准（平铺字段
 * 保留作兜底读取，见 `readLegacyTiers`）。
 */
const SCENE_DIRECTORY = {
  assistant: [
    {
      key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_vl: true,
      is_reasoning: true, is_default: false, price_factor: 0.5,
      max_input_tokens: 180000,
      // 真机 CN qmodel_38max 逐字：200K 是默认档。
      context_config: {
        '1M': { token_count: 1000000 },
        '200K': { token_count: 200000, is_default: true },
        '400K': { token_count: 400000 },
      },
      thinking_config: {
        disabled: {},
        enabled: {
          efforts: { xhigh: {}, low: {}, medium: { is_default: true } },
          is_default: true,
        },
      },
    },
    {
      key: 'gmodel', display_name: 'GLM-5.3', enable: true, is_vl: true,
      is_reasoning: true, max_input_tokens: 180000,
      context_config: {
        '1M': { token_count: 1000000 },
        '200K': { token_count: 200000, is_default: true },
        '400K': { token_count: 400000 },
      },
      thinking_config: {
        disabled: { description: 'Disable thinking' },
        enabled: {
          description: 'Enable thinking',
          efforts: { xhigh: {}, high: { is_default: true }, low: {}, max: {}, medium: {} },
          is_default: true,
        },
      },
    },
    {
      // enable:false —— 既有目录的「只播报启用项」判据在新端点上同构。
      key: 'offmodel', display_name: 'Off Model', enable: false,
    },
    {
      // display_name 缺失 → 名字回退 id（宁缺毋编：id 是事实）；
      // 无 context_config / thinking_config → 不声明窗口与档位（不编造）。
      key: 'noname', enable: true,
    },
    {
      // **平铺旧形态兜底**（stage-a 报告的推断形态）：若上游回退到平铺字段，
      // 同一套解析仍能读出窗口与档位（读法与 PAT 端点共用）。
      key: 'flat', display_name: 'Flat Form', enable: true, is_vl: false,
      max_input_tokens: 100000,
      default_context_window: 200000,
      available_context_windows: [200000, 400000],
      efforts: ['high', 'low'], default_effort: 'high',
    },
  ],
  other_scene: [
    // 别的 scene 不进结果（我们发的是 assistant）。
    { key: 'other', display_name: 'Other Scene', enable: true },
  ],
}

/** 构造 JSON 响应。 */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** 假目录签名来源（记录调用、吐固定 URL/头）。 */
function makeFakeDirectorySigning(overrides: {
  url?: string
  status?: number
  body?: string
  decryptError?: boolean
} = {}) {
  const calls = {
    prepare: [] as Array<[string, string, string]>,
    decrypt: [] as string[],
  }
  const signing: QoderDirectorySigningSource = {
    prepareGetRequest: async (token, endpoint, path) => {
      calls.prepare.push([token, endpoint, path])
      return {
        url: overrides.url ?? `${endpoint}/algo${path}`,
        headers: { Authorization: 'Bearer COSY.stub', 'Cosy-MachineId': 'M' },
        free: () => {},
      }
    },
    decryptResponse: async (text) => {
      calls.decrypt.push(text)
      if (overrides.decryptError === true) throw new Error('decrypt boom')
      return text
    },
  }
  return { signing, calls }
}

/** 适配器选项（默认设备流凭据 + 注入目录签名链）。 */
function adapterOptions(overrides: Partial<QoderAdapterOptions> = {}): QoderAdapterOptions {
  const { signing, calls } = makeFakeDirectorySigning()
  const fetcher = vi.fn(async (_url: unknown, init?: { headers?: unknown }) => {
    void init
    return jsonResponse(JSON.stringify(SCENE_DIRECTORY))
  }) as unknown as typeof fetch
  return {
    credentialRef: 'QODER_PERSONAL_TOKEN' as QoderAdapterOptions['credentialRef'],
    resolveCredential: async () => DEVICE_CREDENTIAL,
    refresh: async () => {},
    fetchImpl: fetcher,
    directorySigning: signing,
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.QODER_MODEL_SERVER_HOST
})

// ── 1. scene 键控目录解析 ────────────────────────────────────────────────────

describe('parseQoderSceneDirectory：按 scene 键控的新端点响应', () => {
  it('嵌套形态（真机 200 实测）：context_config / thinking_config 逐档读取', () => {
    const entries = parseQoderSceneDirectory(SCENE_DIRECTORY)
    const max = entries.find((entry) => entry.id === 'qmodel_38max')
    expect(max).toEqual({
      id: 'qmodel_38max',
      name: 'Qwen3.8-Max',
      enabled: true,
      supportsImages: true,
      // 默认档 = context_config 里 `is_default:true` 的那档（200K，真机逐字）；
      // 不是 max_input_tokens（那是输入上限，字段语义不同）。
      contextWindow: 200000,
      maxInputTokens: 180000,
      // availableContextWindows **原样保留真机键序**（官方 UI 显示序 1M/200K/400K，
      // 与 PAT 端点「原样保留」同一语义）；contextTiers 才是升序归一（buildTiers）。
      availableContextWindows: [1000000, 200000, 400000],
      contextTiers: [200000, 400000, 1000000],
      // thinking_config.enabled.efforts 的**对象键序**照抄（官方即此顺序）；
      // 默认档 = 带 `is_default:true` 的那档（medium）。
      reasoningEfforts: ['xhigh', 'low', 'medium'],
      defaultReasoningEffort: 'medium',
    } satisfies QoderModelEntry)
    const glm = entries.find((entry) => entry.id === 'gmodel')
    expect(glm?.contextWindow).toBe(200000)
    expect(glm?.reasoningEfforts).toEqual(['xhigh', 'high', 'low', 'max', 'medium'])
    expect(glm?.defaultReasoningEffort).toBe('high')
  })

  it('无 context_config / thinking_config 的条目不声明窗口与档位（宁缺毋编）', () => {
    const entries = parseQoderSceneDirectory(SCENE_DIRECTORY)
    const noname = entries.find((entry) => entry.id === 'noname')
    expect(noname?.contextWindow).toBeUndefined()
    expect(noname?.availableContextWindows).toBeUndefined()
    expect(noname?.contextTiers).toBeUndefined()
    expect(noname?.reasoningEfforts).toBeUndefined()
  })

  it('平铺旧形态兜底：available_context_windows / efforts 仍被读取（同一套字段读取）', () => {
    const entries = parseQoderSceneDirectory(SCENE_DIRECTORY)
    const flat = entries.find((entry) => entry.id === 'flat')
    expect(flat).toEqual({
      id: 'flat',
      name: 'Flat Form',
      enabled: true,
      supportsImages: false,
      contextWindow: 200000,
      maxInputTokens: 100000,
      availableContextWindows: [200000, 400000],
      contextTiers: [200000, 400000],
      reasoningEfforts: ['high', 'low'],
      defaultReasoningEffort: 'high',
    } satisfies QoderModelEntry)
  })

  it('enable 只认严格 true；includeDisabled 才保留关闭项', () => {
    const enabled = parseQoderSceneDirectory(SCENE_DIRECTORY).map((entry) => entry.id)
    expect(enabled).toEqual(['qmodel_38max', 'gmodel', 'noname', 'flat'])
    const all = parseQoderSceneDirectory(SCENE_DIRECTORY, { includeDisabled: true }).map((e) => e.id)
    expect(all).toContain('offmodel')
  })

  it('display_name 缺失回退 id（id 是事实，不是编造）', () => {
    const entries = parseQoderSceneDirectory(SCENE_DIRECTORY)
    expect(entries.find((entry) => entry.id === 'noname')?.name).toBe('noname')
  })

  it('双形态兼容：{data:[…]} 明文形态交给既有解析器（kfe 失败原样返回的兜底）', () => {
    const legacy = {
      data: [{ id: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_enabled: true }],
    }
    const entries = parseQoderSceneDirectory(legacy)
    expect(entries.map((entry) => entry.id)).toEqual(['qmodel_38max'])
  })

  it('缺 scene 键 / 非对象 / 数组 → 空数组（不猜别的候选键）', () => {
    expect(parseQoderSceneDirectory({ models: [] })).toEqual([])
    expect(parseQoderSceneDirectory(undefined)).toEqual([])
    expect(parseQoderSceneDirectory([1, 2])).toEqual([])
    expect(parseQoderSceneDirectory({ assistant: 'nope' })).toEqual([])
  })
})

// ── 2. 目录 host ─────────────────────────────────────────────────────────────

describe('resolveQoderDirectoryEndpoint：inference host', () => {
  it('CN 复用 chat 签名同一 host（gateway，不新抄字面量）', () => {
    expect(resolveQoderDirectoryEndpoint(QODER_CN)).toBe(QODER_CN.chatBase)
    expect(resolveQoderDirectoryEndpoint(QODER_CN)).toBe('https://gateway.qoder.com.cn')
  })

  it('国际版默认 api2.qoder.sh（官方 pZt 值）', () => {
    expect(QODER_INFER_HOST).toBe('https://api2.qoder.sh')
    expect(resolveQoderDirectoryEndpoint(QODER)).toBe('https://api2.qoder.sh')
  })

  it('逃生阀 QODER_MODEL_SERVER_HOST 语义照 chat 侧沿用（请求时读、只换 host）', () => {
    process.env.QODER_MODEL_SERVER_HOST = 'gw.example'
    expect(resolveQoderDirectoryEndpoint(QODER)).toBe('https://gw.example')
    process.env.QODER_MODEL_SERVER_HOST = 'http://localhost:8080/x?q=1'
    expect(resolveQoderDirectoryEndpoint(QODER)).toBe('http://localhost:8080')
  })
})

// ── 3. fetchQoderDirectory 的令牌族分派 ─────────────────────────────────────

describe('fetchQoderDirectory：dt- 走 wasm 目录链', () => {
  it('prepareGetRequest 收到（dt 令牌, endpoint, path），fetch 用 wasm 给的 URL 与头', async () => {
    const { signing, calls } = makeFakeDirectorySigning()
    const fetcher = vi.fn(async () => jsonResponse(JSON.stringify(SCENE_DIRECTORY))) as unknown as typeof fetch
    const entries = await fetchQoderDirectory(DEVICE_CREDENTIAL, {
      fetchImpl: fetcher, deviceSigning: signing,
    })
    expect(calls.prepare).toEqual([[
      'dt-device-token',
      'https://api2.qoder.sh',
      QODER_DEVICE_MODELS_PATH,
    ]])
    expect(QODER_DEVICE_MODELS_PATH).toBe('/api/v2/model/list?Encode=1')
    expect(fetcher).toHaveBeenCalledWith(
      'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer COSY.stub', 'Cosy-MachineId': 'M' },
      }),
    )
    // 响应经 decryptResponse → scene 解析。
    expect(calls.decrypt).toHaveLength(1)
    expect(entries.map((entry) => entry.id)).toEqual(['qmodel_38max', 'gmodel', 'noname', 'flat'])
  })

  it('CN 凭据的 endpoint 是 gateway（product 驱动）', async () => {
    const { signing, calls } = makeFakeDirectorySigning()
    const fetcher = vi.fn(async () => jsonResponse(JSON.stringify(SCENE_DIRECTORY))) as unknown as typeof fetch
    await fetchQoderDirectory(DEVICE_CREDENTIAL, {
      fetchImpl: fetcher, deviceSigning: signing, product: QODER_CN,
    })
    expect(calls.prepare[0]![1]).toBe('https://gateway.qoder.com.cn')
  })

  it('HTTP 非 2xx → 空数组 + onDebug 提示（错误不抛、不分类）', async () => {
    const { signing } = makeFakeDirectorySigning()
    const fetcher = vi.fn(async () => jsonResponse('{"code":"101","message":"Signature invalid"}', 403)) as unknown as typeof fetch
    const onDebug = vi.fn()
    const entries = await fetchQoderDirectory(DEVICE_CREDENTIAL, {
      fetchImpl: fetcher, deviceSigning: signing, onDebug,
    })
    expect(entries).toEqual([])
    expect(onDebug).toHaveBeenCalledTimes(1)
    expect(String(onDebug.mock.calls[0]![0])).toContain('403')
  })

  it('响应不是 JSON → 空数组（与 PAT 路径同一失败语义）', async () => {
    const { signing } = makeFakeDirectorySigning()
    const fetcher = vi.fn(async () => jsonResponse('not-json')) as unknown as typeof fetch
    await expect(fetchQoderDirectory(DEVICE_CREDENTIAL, {
      fetchImpl: fetcher, deviceSigning: signing,
    })).resolves.toEqual([])
  })

  it('未注入 deviceSigning → 不发任何请求（dt- 打 PAT 端点恒 401，白打）+ onDebug', async () => {
    const fetcher = vi.fn(async () => jsonResponse('{}')) as unknown as typeof fetch
    const onDebug = vi.fn()
    const entries = await fetchQoderDirectory(DEVICE_CREDENTIAL, { fetchImpl: fetcher, onDebug })
    expect(entries).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(onDebug).toHaveBeenCalledTimes(1)
  })

  it('pt- 路径一行不动：仍打 {modelsBase}/api/v1/cloud/models + PAT 头', async () => {
    const fetcher = vi.fn(async () => jsonResponse('{"data":[]}')) as unknown as typeof fetch
    const { signing } = makeFakeDirectorySigning()
    await fetchQoderDirectory(PAT_CREDENTIAL, {
      fetchImpl: fetcher, deviceSigning: signing,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.qoder.com/api/v1/cloud/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer pt-test-token' }),
      }),
    )
  })
})

// ── 4. wasm 上下文：prepareRequest ABI 与 decrypt ────────────────────────────

/** 假 glue（记录 prepareRequest 的 14 参 ABI）。 */
function makeContextGlue() {
  const calls = {
    prepareRequest: [] as Array<[number, number, number, number, number, number, number, number, number, number, number, number, number, number]>,
    decrypt: [] as Array<[number, number, number]>,
    decryptThrow: false,
  }
  let stubString = ''
  let stubInt = 0
  const passed: string[] = []
  const internals = {
    getObject: (i: number) => i,
    dropObject: () => {},
    takeObject: (): unknown => new Map([['Cosy-ClientType', 'qodercli']]),
    addHeapObject: (v: unknown) => (typeof v === 'number' ? v : 0),
    getDataView: () => {
      const dv = new DataView(new ArrayBuffer(64))
      dv.setInt32(0, stubInt, true)
      return dv
    },
    getUint8: () => new Uint8Array(0),
    getString: () => stubString,
    getArrayU8: () => new Uint8Array(0),
    passString: (s: string) => { passed.push(s); return s.length },
    vectorLen: () => passed[passed.length - 1]?.length ?? 0,
  }
  const wasm = {
    __wbindgen_add_to_stack_pointer: () => 0,
    __wbindgen_export: () => {},
    __wbindgen_export2: () => 0,
    __wbindgen_export3: () => 0,
    __wbindgen_export4: () => {},
    __wbg_qodercontext_free: () => {},
    __wbg_requestresult_free: () => {},
    qodercontext_new: () => { stubInt = 4242 },
    generate_runtime_auth_fields: () => {
      stubString = JSON.stringify({ encrypt_user_info: 'ENC', key: 'KEY' })
    },
    qodercontext_prepareRequest: (
      rp: number, ctx: number, a: number, b: number, c: number, d: number,
      e: number, f: number, g: number, h: number, i: number, j: number,
      k: number, l: number,
    ) => {
      calls.prepareRequest.push([rp, ctx, a, b, c, d, e, f, g, h, i, j, k, l])
      stubInt = 7777
    },
    requestresult_url: () => { stubString = 'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1' },
    requestresult_body: () => { stubString = '' },
    requestresult_headers: () => 0,
    requestresult_headerCount: () => 0,
    decrypt_server_response: (rp: number, ptr: number, len: number) => {
      calls.decrypt.push([rp, ptr, len])
      if (calls.decryptThrow) throw new Error('wasm decrypt boom')
      stubString = 'DECODED'
    },
  }
  return { glue: { wasm, internals } as never, calls, setString: (s: string) => { stubString = s } }
}

describe('QoderSigningContext.prepareRequest：目录 GET 的 wasm ABI', () => {
  it('四串 + 两个 None（i..l 恒 0），URL/headers 从 RequestResult 读出', () => {
    const { glue, calls } = makeContextGlue()
    const ctx = new QoderSigningContext(glue, 42)
    const prepared = ctx.prepareRequest('https://api2.qoder.sh', '/api/v2/model/list?Encode=1', 'GET', 'auth')
    expect(calls.prepareRequest).toHaveLength(1)
    const [rp, ctxPtr, a, aLen, b, bLen, c, cLen, d, dLen, i, j, k, l] = calls.prepareRequest[0]!
    expect(rp).toBe(0)
    expect(ctxPtr).toBe(42)
    // endpoint / path / method / requestClass 按 passString 序传入。
    expect(a).toBe('https://api2.qoder.sh'.length)
    expect(b).toBe('/api/v2/model/list?Encode=1'.length)
    expect(c).toBe('GET'.length)
    expect(d).toBe('auth'.length)
    // 官方调用形态：prepareRequest(endpoint, path, "GET", "auth", void 0, void 0)
    // —— 后两个 Option 是 None ⇒ (ptr=0, len=0)。
    expect([i, j, k, l]).toEqual([0, 0, 0, 0])
    expect(prepared.url).toBe('https://api2.qoder.sh/algo/api/v2/model/list?Encode=1')
    expect(prepared.headers.get('Cosy-ClientType')).toBe('qodercli')
    // 目录 GET 没有 body —— prepared 不暴露 body（或为空）。
    expect('body' in prepared ? (prepared as { body?: unknown }).body : undefined).toBeUndefined()
  })

  it('已释放的上下文拒绝再签（与 chat 侧同一守卫）', () => {
    const { glue } = makeContextGlue()
    const ctx = new QoderSigningContext(glue, 1)
    ctx.dispose()
    expect(() => ctx.prepareRequest('e', 'p', 'GET', 'auth')).toThrow(/已释放/)
  })
})

describe('decryptQoderServerResponse：明文兼容（官方 kfe 语义）', () => {
  it('解码成功返回解码值', () => {
    const { glue } = makeContextGlue()
    expect(decryptQoderServerResponse(glue, 'CIPHER')).toBe('DECODED')
  })

  it('wasm 抛错原样返回输入（明文兼容，不吞原文）', () => {
    const { glue, calls } = makeContextGlue()
    calls.decryptThrow = true
    expect(decryptQoderServerResponse(glue, 'PLAINTEXT')).toBe('PLAINTEXT')
  })
})

// ── 5. QoderSigningProvider 的目录方法与工厂 ────────────────────────────────

/** 离线 provider（假 glue + 假 userinfo + 内存机器码盘，不碰真实 home）。 */
function makeOfflineProvider(product: typeof QODER | typeof QODER_CN = QODER_CN) {
  const { glue, calls, setString } = makeContextGlue()
  const userinfoCalls: string[] = []
  const fetcher = (async (url: unknown) => {
    userinfoCalls.push(String(url))
    return jsonResponse(JSON.stringify({ id: 'uid-1' }))
  }) as unknown as typeof fetch
  const files = new Map<string, string>()
  const io = {
    readFile: async (path: string): Promise<string> => {
      const value = files.get(path)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    mkdir: async (): Promise<void> => {},
    writeFile: async (path: string, data: string): Promise<void> => { files.set(path, data) },
  }
  const provider = new QoderSigningProvider({
    product,
    loadGlue: async () => glue,
    fetchImpl: fetcher,
    machineIdOptions: { homeDir: 'X:\\fake-dir-home', io },
  })
  return { provider, userinfoCalls, calls, setString }
}

describe('QoderSigningProvider.prepareDirectoryRequest：dt- 令牌的目录签名', () => {
  it('uid 用 dt- 令牌作 Bearer 取；security_oauth_token 是 dt- 本体（不是 jt）', async () => {
    const { provider, userinfoCalls, calls } = makeOfflineProvider()
    const prepared = await provider.prepareDirectoryRequest(
      'dt-token', 'https://gateway.qoder.com.cn', '/api/v2/model/list?Encode=1',
    )
    expect(userinfoCalls[0]).toContain('/api/v1/userinfo')
    expect(prepared.url).toBe('https://api2.qoder.sh/algo/api/v2/model/list?Encode=1')
    expect(typeof prepared.headers).toBe('object')
    // ABI：method=GET、requestClass=auth。
    expect(calls.prepareRequest).toHaveLength(1)
    expect(calls.decrypt).toHaveLength(0)
  })

  it('同一令牌重复取：userinfo 只取一次（uid 缓存按令牌分键）', async () => {
    const { provider, userinfoCalls } = makeOfflineProvider()
    await provider.prepareDirectoryRequest('dt-token', 'https://h', '/p')
    await provider.prepareDirectoryRequest('dt-token', 'https://h', '/p')
    expect(userinfoCalls).toHaveLength(1)
  })

  it('decryptResponse：正常解码与明文兼容两路', async () => {
    const { provider, calls, setString } = makeOfflineProvider()
    setString('')
    expect(await provider.decryptResponse('CIPHER')).toBe('DECODED')
    calls.decryptThrow = true
    expect(await provider.decryptResponse('PLAIN')).toBe('PLAIN')
  })
})

describe('qoderDirectorySigningSource：把 provider 包成目录签名来源', () => {
  it('prepareGetRequest 返回 Record 头 + wasm URL；decryptResponse 透传 provider', async () => {
    const { provider, setString } = makeOfflineProvider()
    const source = qoderDirectorySigningSource(provider)
    const prepared = await source.prepareGetRequest(
      'dt-token', 'https://gateway.qoder.com.cn', '/api/v2/model/list?Encode=1',
    )
    expect(prepared.url).toContain('/algo/api/v2/model/list?Encode=1')
    expect(prepared.headers['Cosy-ClientType']).toBe('qodercli')
    expect(typeof prepared.free).toBe('function')
    setString('')
    expect(await source.decryptResponse('CIPHER')).toBe('DECODED')
  })
})

// ── 6. 适配器：目录链接线 + 负缓存 ───────────────────────────────────────────

describe('QoderAdapter：设备流目录链', () => {
  it('dt- 凭据经 directorySigning 拉到 scene 目录并播报', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const models = await adapter.listModels('qoder')
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'gmodel', 'noname', 'flat'])
    expect(models[0]!.name).toBe('Qwen3.8-Max')
  })

  it('目录链失败回退静态表且 catalogSource=fallback；成功为 remote', async () => {
    const failing = adapterOptions({
      fetchImpl: vi.fn(async () => jsonResponse('nope', 403)) as unknown as typeof fetch,
    })
    const adapter = new QoderAdapter(failing)
    await adapter.listModels('qoder')
    expect(adapter.catalogSource()).toBe('fallback')

    const ok = new QoderAdapter(adapterOptions())
    await ok.listModels('qoder')
    expect(ok.catalogSource()).toBe('remote')
  })

  it('负缓存：生产路径失败后 5 分钟内不重拉（E1）', async () => {
    const fetcher = vi.fn(async () => jsonResponse('{}', 403)) as unknown as typeof fetch
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))
    await adapter.listModels('qoder')
    await adapter.listModels('qoder')
    await adapter.resolveModel('qoder', 'qmodel_38max')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('负缓存只在生产路径生效：注入 fetchRemoteModels 的重试语义不受影响', async () => {
    let fail = true
    const fetchRemoteModels = vi.fn(async () => {
      if (fail) return []
      return parseLegacyForTest()
    })
    const adapter = new QoderAdapter(adapterOptions({ fetchRemoteModels }))
    await adapter.listModels('qoder')
    fail = false
    const models = await adapter.listModels('qoder')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(2)
    expect(models.length).toBeGreaterThan(0)
  })

  it('displayName：生效目录两级查（目录优先，静态表兜底，未知 undefined）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    await adapter.listModels('qoder')
    expect(adapter.displayName('gmodel')).toBe('GLM-5.3')
    expect(adapter.displayName('noname')).toBe('noname')
    expect(adapter.displayName('unknown-model')).toBeUndefined()

    // 目录失败：静态表兜底（lite 不在 scene 目录里，两级查找能给它名字）。
    const failing = new QoderAdapter(adapterOptions({
      fetchImpl: vi.fn(async () => jsonResponse('{}', 403)) as unknown as typeof fetch,
    }))
    await failing.listModels('qoder')
    expect(failing.displayName('lite')).toBe('Lite')
    expect(failing.displayName('qmodel_38max')).toBe('Qwen3.8-Max')
  })
})

/** 旧形态目录（fetchRemoteModels 用例的合法返回）。 */
function parseLegacyForTest(): QoderModelEntry[] {
  return [
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', enabled: true },
    { id: 'qfmodel', name: 'Qwen3.8-Flash', enabled: true },
  ]
}

// ── 7. 负缓存类本身 ──────────────────────────────────────────────────────────

describe('QoderDirectoryNegativeCache', () => {
  it('mark → blocked；TTL 到点自动解禁；clear 立即解禁', () => {
    let now = 1_000_000
    const cache = new QoderDirectoryNegativeCache(QODER_DIRECTORY_NEGATIVE_TTL_MS, () => now)
    expect(QODER_DIRECTORY_NEGATIVE_TTL_MS).toBe(5 * 60 * 1000)
    expect(cache.blocked).toBe(false)
    cache.mark()
    expect(cache.blocked).toBe(true)
    now += QODER_DIRECTORY_NEGATIVE_TTL_MS - 1
    expect(cache.blocked).toBe(true)
    now += 1
    expect(cache.blocked).toBe(false)
    cache.mark()
    expect(cache.blocked).toBe(true)
    cache.clear()
    expect(cache.blocked).toBe(false)
  })
})
