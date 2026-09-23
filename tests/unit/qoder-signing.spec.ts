/**
 * Qoder **签名路径的用户身份来源**（两区共用，CN chat 的必需前置）单测（全 mock，零网络）。
 *
 * ## 为什么需要这个模块
 *
 * `prepareInferRequest` 要的 `userInfoJson` 里，`security_oauth_token` 是 jt、
 * 其余四个业务字段（`uid` / `organization_id` / `organization_tags` /
 * `data_policy_agreed`）**必须来自真实账号**。真机 A/B 定案（2026-09-21）：
 * **同一请求只改 `uid` 这一处** —— 空串回 `{"code":"101","message":"Signature invalid"}`，
 * 真实 uid 回 HTTP 200 + SSE 真内容。故「拿不到 uid 就签名」这条路是**必错**的，
 * 本模块的职责就是让它**根本走不到签名**：取不到就抛可读错误。
 *
 * ## uid 的三段回退序（官方源码逐字取证）
 *
 * 官方 `fetchOpenApiUserInfo` 读的是 `Mk(r, ["id","user_id","uid"])` ——
 * 依次找第一个非空字符串。真机 CN `GET https://openapi.qoder.com.cn/api/v1/userinfo`
 * 实测返回 `{id: "<36 字符 UUID>", …}`，**`user_id` 与 `uid` 都不存在**，
 * 故实际命中的是第一段 `id`。三段都要实现：官方对三种账号形态都可能下发不同键名。
 *
 * ## 端点与鉴权
 *
 * `GET {openapiBase}/api/v1/userinfo`，**Bearer `jt-`**（不是 PAT）。探针实测
 * HTTP 200 / `application/json` / 580 字节。⚠️ 不要改成 PAT：三端点里只有目录
 * 认 PAT（见 `qoder-product.ts` 的 `qoderPatHeaders` 注释）。
 */

import { describe, expect, it } from 'vitest'
import {
  QoderSigningProvider,
  fetchQoderUserIdentity,
  readQoderUserIdentity,
} from '../../src/qoder-signing.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import type { QoderProduct } from '../../src/qoder-product.js'

/** 真机 CN userinfo 响应的**真实形态**（键名逐字照抄，值换成占位）。 */
const CN_USERINFO = {
  id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  name: '测试用户',
  username: 'tester',
  avatar: 'https://example.test/a.png',
  source: 'qoder',
  current_sign_in_at: '2026-09-21T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  register_ip: '127.0.0.1',
  organization_id: '',
  organization_name: '',
  is_privacy_policy_modifiable: true,
  is_highest_tier: false,
  third_party_identities: [],
  security_mobile: '',
}

/** 造一个 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// A. uid 的三段回退序（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe('readQoderUserIdentity：uid 回退序 id → user_id → uid', () => {
  it('三段齐备时**取第一段 id**（不是 uid / user_id）', () => {
    const identity = readQoderUserIdentity({ id: 'ID-1', user_id: 'UID-2', uid: 'UID-3' })
    expect(identity?.uid).toBe('ID-1')
  })

  it('只有 user_id 时取 user_id（缺 id 的第二形态）', () => {
    expect(readQoderUserIdentity({ user_id: 'UID-2', uid: 'UID-3' })?.uid).toBe('UID-2')
  })

  it('只有 uid 时取 uid（第三形态）', () => {
    expect(readQoderUserIdentity({ uid: 'UID-3' })?.uid).toBe('UID-3')
  })

  it('真机 CN 响应：命中 `id`（36 字符 UUID），且 user_id / uid 确实不存在', () => {
    // 这条同时是**真机形态的记录**：CN 的个人账号只回 `id`。
    expect('user_id' in CN_USERINFO).toBe(false)
    expect('uid' in CN_USERINFO).toBe(false)
    expect(readQoderUserIdentity(CN_USERINFO)?.uid).toBe(CN_USERINFO.id)
    expect(CN_USERINFO.id).toHaveLength(36)
  })

  it('空串 / 全空白 / 非字符串一律跳过，落到下一段或判失败', () => {
    // 官方 `Mk` 的语义是「第一个**非空字符串**」：空串不是有效值。
    expect(readQoderUserIdentity({ id: '', user_id: 'UID-2' })?.uid).toBe('UID-2')
    expect(readQoderUserIdentity({ id: '   ', user_id: 'UID-2' })?.uid).toBe('UID-2')
    expect(readQoderUserIdentity({ id: 123, user_id: 'UID-2' })?.uid).toBe('UID-2')
    expect(readQoderUserIdentity({ id: null, user_id: 'UID-2' })?.uid).toBe('UID-2')
    // 三段全废 ⇒ undefined（**不是空串**：调用方据 undefined 抛错，
    // 返回空串会让「没取到」与「取到了空」在下游无法区分）。
    expect(readQoderUserIdentity({ id: '', user_id: '  ', uid: 0 })).toBeUndefined()
  })

  it('非对象输入（null / 字符串 / 数组 / 数字）一律 undefined，不抛', () => {
    for (const input of [null, undefined, 'text', 42, [], true]) {
      expect(readQoderUserIdentity(input), String(input)).toBeUndefined()
    }
  })

  it('uid 两端的空白被裁掉（否则会签出一个带空格的假身份）', () => {
    expect(readQoderUserIdentity({ id: '  UID-1  ' })?.uid).toBe('UID-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 其余三个业务字段（真机缺字段时的缺省值）
// ─────────────────────────────────────────────────────────────────────────────

describe('readQoderUserIdentity：organization_id / tags / data_policy_agreed', () => {
  it('真机 CN 响应：organization_id 是空串（个人账号），tags 缺字段 ⇒ []', () => {
    const identity = readQoderUserIdentity(CN_USERINFO)
    expect(identity?.organizationId).toBe('')
    // ⚠️ 真机响应里**没有** organization_tags / data_policy_agreed 两个字段。
    // 缺字段必须归一成「安全缺省」而不是 undefined —— 它们要进 JSON。
    expect('organization_tags' in CN_USERINFO).toBe(false)
    expect(identity?.organizationTags).toEqual([])
  })

  it('organization_id 兼容 orgId / organization_id / organizationId 三种书写', () => {
    // 顺序与官方 `Mk(r, ["orgId","organization_id","organizationId"])` 同源。
    expect(readQoderUserIdentity({ id: 'u', orgId: 'ORG-A' })?.organizationId).toBe('ORG-A')
    expect(readQoderUserIdentity({ id: 'u', organization_id: 'ORG-B' })?.organizationId).toBe('ORG-B')
    expect(readQoderUserIdentity({ id: 'u', organizationId: 'ORG-C' })?.organizationId).toBe('ORG-C')
    // 都没有 ⇒ 空串（个人账号的正常形态，不是错误）。
    expect(readQoderUserIdentity({ id: 'u' })?.organizationId).toBe('')
  })

  it('organization_tags 只收字符串数组；非法值归一成 []', () => {
    expect(readQoderUserIdentity({ id: 'u', organization_tags: ['A', 'B'] })?.organizationTags)
      .toEqual(['A', 'B'])
    // 非数组 ⇒ 空数组（wasm 侧要的是字符串数组，塞别的进去会在派生阶段炸）。
    expect(readQoderUserIdentity({ id: 'u', organization_tags: 'A' })?.organizationTags).toEqual([])
    // 混入非字符串 ⇒ 过滤掉非法项，保留合法的。
    expect(readQoderUserIdentity({ id: 'u', organization_tags: ['A', 1, null] })?.organizationTags)
      .toEqual(['A'])
  })

  it('data_policy_agreed 缺省 **true**（真人账号必然已同意，否则客户端不让用）', () => {
    // ⚠️ 这是本模块**唯一**的缺省值选择，理由写在 src 的注释里：
    // 真机响应不含该字段，而它是「已同意隐私政策」的声明 —— CN 客户端能正常
    // 聊天就说明账号已同意。若上游对此有校验，三档真机验证的首档就会以 101 暴露。
    expect(readQoderUserIdentity(CN_USERINFO)?.dataPolicyAgreed).toBe(true)
    expect(readQoderUserIdentity({ id: 'u' })?.dataPolicyAgreed).toBe(true)
    // 显式给了布尔就照用（非布尔取值不认，回缺省）。
    expect(readQoderUserIdentity({ id: 'u', data_policy_agreed: false })?.dataPolicyAgreed).toBe(false)
    expect(readQoderUserIdentity({ id: 'u', data_policy_agreed: 'yes' })?.dataPolicyAgreed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B2. 可展示资料（昵称 / 邮箱 / 手机号）—— 账号卡片昵称的来源
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为什么这三个字段长在**本**函数上（而不是另写一份解析）
 *
 * 账号卡片的昵称要取 `userinfo` 的 `name`，而**签名链已经在调本模块**了
 * （`QoderSigningProvider.identity` 经 {@link fetchQoderUserIdentity}）。
 * 两处分头解析同一个响应，将来字段名一变必然分叉 —— 一处改了、另一处还读旧键，
 * 表现为「签名好了但昵称还是 UUID」这种极难归因的半失效。
 * 故资料字段与 uid **同源同函数**，只是各自有各自的回退序。
 */
describe('readQoderUserIdentity：displayName / email / mobile（账号卡片资料）', () => {
  it('真机 CN 响应：name 是可展示昵称，email 与 security_mobile 一并带出', () => {
    const identity = readQoderUserIdentity({
      ...CN_USERINFO,
      name: '测试用户',
      email: 'tester@example.test',
      security_mobile: '18939953995',
    })
    expect(identity?.displayName).toBe('测试用户')
    expect(identity?.email).toBe('tester@example.test')
    expect(identity?.mobile).toBe('18939953995')
  })

  it('字段缺失 ⇒ 各回 undefined（**不编造**昵称，昵称回退序由调用方决定）', () => {
    const identity = readQoderUserIdentity({ id: 'u-1' })
    expect(identity?.displayName).toBeUndefined()
    expect(identity?.email).toBeUndefined()
    expect(identity?.mobile).toBeUndefined()
  })

  it('空白 / 非字符串不算资料（不能把 "   " 当成真名）', () => {
    const identity = readQoderUserIdentity({
      id: 'u-1', name: '   ', email: 123, security_mobile: '  ',
    })
    expect(identity?.displayName).toBeUndefined()
    expect(identity?.email).toBeUndefined()
    expect(identity?.mobile).toBeUndefined()
  })

  it('displayName 兼容 name / nickname / user_name 三种书写（官方键名漂移时的兜底）', () => {
    // `name` 是实测键名（第一优先）；另两个是各端历史用过的写法。
    expect(readQoderUserIdentity({ id: 'u', name: 'A' })?.displayName).toBe('A')
    expect(readQoderUserIdentity({ id: 'u', nickname: 'B' })?.displayName).toBe('B')
    expect(readQoderUserIdentity({ id: 'u', user_name: 'C' })?.displayName).toBe('C')
  })

  it('两端空白被裁掉（否则卡片上的名字带着看不见的空格）', () => {
    const identity = readQoderUserIdentity({ id: 'u', name: '  河童  ', email: ' k@e.test ' })
    expect(identity?.displayName).toBe('河童')
    expect(identity?.email).toBe('k@e.test')
  })

  it('uid 读不到时**整条**返回 undefined（资料再全也不够 —— 签名缺它必回 101）', () => {
    expect(readQoderUserIdentity({ name: '河童', email: 'k@e.test' })).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. userinfo 端点（URL / 头 / 失败形态）
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchQoderUserIdentity：GET {openapiBase}/api/v1/userinfo', () => {
  /** 记录请求的假 fetch。 */
  /**
   * 记录请求的假 fetch。
   *
   * ⚠️ 收的是**工厂**而不是 `Response` 实例：`Response` 的 body 只能读一次，
   * 同一个实例被同一用例的多次调用复用会抛「Body is unusable」—— 那会让失败
   * 原因从「uid 解析」变成「响应读取」，而后者正是本模块要排除的干扰。
   */
  function spyFetch(
    build: () => Response,
  ): { fetcher: typeof fetch; calls: Array<[string, RequestInit]> } {
    const calls: Array<[string, RequestInit]> = []
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      calls.push([String(url), init ?? {}])
      return build()
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  it('打到 CN 的 openapi 基址（不是 chat / models 基址）', async () => {
    const spy = spyFetch(() => jsonResponse(CN_USERINFO))
    await fetchQoderUserIdentity('jt-cn', QODER_CN, spy.fetcher)

    expect(spy.calls[0]![0]).toBe(`${QODER_CN.openapiBase}/api/v1/userinfo`)
    expect(spy.calls[0]![0]).toBe('https://openapi.qoder.com.cn/api/v1/userinfo')
    // 三个基址里只有 openapi 是 userinfo 的归属，写错会得到 404/403 而非清晰报错。
    expect(spy.calls[0]![0]).not.toContain('gateway.qoder.com.cn')
  })

  it('鉴权是 **Bearer jt-**（不是 PAT），方法是 GET，且不带 body', async () => {
    const spy = spyFetch(() => jsonResponse(CN_USERINFO))
    await fetchQoderUserIdentity('jt-cn', QODER_CN, spy.fetcher)
    const init = spy.calls[0]![1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jt-cn')
    expect(init.method).toBe('GET')
    // GET 不带 body：带上会让部分网关回 400。
    expect(init.body).toBeUndefined()
  })

  it('国际版同样可用（端点同形，只换 host）', async () => {
    const spy = spyFetch(() => jsonResponse(CN_USERINFO))
    await fetchQoderUserIdentity('jt-intl', QODER, spy.fetcher)
    expect(spy.calls[0]![0]).toBe(`${QODER.openapiBase}/api/v1/userinfo`)
  })

  it('HTTP 非 200 → 抛**可读**错误（点名端点、状态码与重新登录）', async () => {
    const spy = spyFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
    await expect(fetchQoderUserIdentity('jt-bad', QODER_CN, spy.fetcher))
      .rejects.toThrow(/userinfo/)
    await expect(fetchQoderUserIdentity('jt-bad', QODER_CN, spy.fetcher))
      .rejects.toThrow(/401/)
    await expect(fetchQoderUserIdentity('jt-bad', QODER_CN, spy.fetcher))
      .rejects.toThrow(/重新登录/)
  })

  it('响应非 JSON → 抛错（诊断信息里带前若干字符）', async () => {
    const notJson = spyFetch(() => new Response('<html>oops</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    await expect(fetchQoderUserIdentity('jt', QODER_CN, notJson.fetcher)).rejects.toThrow(/不是 JSON/)
  })

  it('200 + JSON 但三段 uid 全缺 → 抛错，**绝不**回一个空 uid 让调用方去签', async () => {
    // 这是最危险的一种：HTTP 全绿、uid 为空 —— 真机上它必回 101。
    const noUid = spyFetch(() => jsonResponse({ name: 'x' }))
    await expect(fetchQoderUserIdentity('jt', QODER_CN, noUid.fetcher)).rejects.toThrow(/uid/)
    await expect(fetchQoderUserIdentity('jt', QODER_CN, noUid.fetcher))
      .rejects.toThrow(/id → user_id → uid/)
  })

  it('传输层失败（网络）→ 抛错而不是静默降级', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(fetchQoderUserIdentity('jt', QODER_CN, failing)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('product 参数决定 host：两个 region 各自打自己的 openapi', async () => {
    const cn = spyFetch(() => jsonResponse(CN_USERINFO))
    const intl = spyFetch(() => jsonResponse(CN_USERINFO))
    await fetchQoderUserIdentity('jt', QODER_CN, cn.fetcher)
    await fetchQoderUserIdentity('jt', QODER, intl.fetcher)
    expect(new URL(cn.calls[0]![0]).hostname).toBe('openapi.qoder.com.cn')
    expect(new URL(intl.calls[0]![0]).hostname).toBe('openapi.qoder.sh')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. QoderSigningProvider：uid 缓存与签名器生命周期
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 假 glue —— 与 `qoder-wasm.spec.ts` 的 `makeFakeGlue` 同形，但**只实现本文件
 * 用到的部分**：本文件测的是「什么时候去取 uid / 要不要重建签名器」，
 * 签名算子本身的逐字节行为在 `qoder-wasm.spec.ts` 里测。
 */
function makeFakeGlue() {
  const calls = {
    generate: [] as string[],
    newContext: [] as Array<[string, string, string, string]>,
    freed: [] as number[],
  }
  let ptr = 1000
  let stubString = ''
  const passed: string[] = []
  const internals = {
    getObject: (i: number) => i,
    dropObject: () => {},
    takeObject: (_i: number): unknown => new Map([['Cosy-ClientType', '5']]),
    addHeapObject: (v: unknown) => (typeof v === 'number' ? v : 0),
    getDataView: () => {
      const dv = new DataView(new ArrayBuffer(64))
      dv.setInt32(0, ptr, true)
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
    __wbg_qodercontext_free: (p: number) => { calls.freed.push(p) },
    __wbg_requestresult_free: () => {},
    generate_runtime_auth_fields: () => {
      calls.generate.push(passed[passed.length - 1] ?? '')
      stubString = JSON.stringify({ encrypt_user_info: 'ENC', key: 'KEY' })
    },
    qodercontext_new: () => {
      calls.newContext.push([
        passed[passed.length - 4] ?? '',
        passed[passed.length - 3] ?? '',
        passed[passed.length - 2] ?? '',
        passed[passed.length - 1] ?? '',
      ])
      ptr += 1
    },
    qodercontext_prepareInferRequest: () => {
      stubString = JSON.stringify({
        url: 'https://signed.example.test/path?q=1',
        headers: {},
        body: 'CIPHERTEXT',
      })
    },
  }
  return { glue: { wasm, internals } as never, calls }
}

/**
 * 一个**离线**的 provider（不碰真实 home、不下载 wasm）。
 *
 * ⚠️ **机器码必须落盘成功**，否则每次取用都会生成一个**新的** UUID
 * （`readOrCreateQoderMachineId` 的契约 3：落盘失败退回内存态），而机器码是
 * 签名器复用判据的第一项 —— 判据每次都变，上下文自然每次都重建，
 * 「同一凭据复用同一个上下文」这条就没法测了。故这里注入一个**能写成功**的
 * 内存 io（不碰真实文件系统）。
 */
function makeProvider(overrides: {
  fetcher?: typeof fetch
  product?: QoderProduct
  loadGlue?: () => Promise<never>
} = {}) {
  const { glue, calls } = makeFakeGlue()
  const userinfoCalls: string[] = []
  const fetcher = overrides.fetcher ?? (async (url: unknown) => {
    userinfoCalls.push(String(url))
    return jsonResponse(CN_USERINFO)
  }) as unknown as typeof fetch
  // 内存文件系统：第一次读 ENOENT ⇒ 生成一个固定的机器码并「落盘」。
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
    product: overrides.product ?? QODER_CN,
    loadGlue: overrides.loadGlue ?? (async () => glue),
    fetchImpl: fetcher,
    machineIdOptions: { homeDir: 'X:\\fake-signing-home', io },
  })
  return { provider, userinfoCalls, calls, files }
}

describe('QoderSigningProvider：uid 缓存与凭据变更', () => {
  it('同一凭据重复取上下文：userinfo **只取一次**（缓存命中）', async () => {
    const { provider, userinfoCalls } = makeProvider()
    await provider.contextFor('pt-1', 'jt-1')
    await provider.contextFor('pt-1', 'jt-2')
    expect(userinfoCalls).toHaveLength(1)
  })

  it('凭据变更（换 PAT）⇒ **重取** uid，且签名器上下文随之重建', async () => {
    const { provider, userinfoCalls, calls } = makeProvider()
    await provider.contextFor('pt-1', 'jt-1')
    await provider.contextFor('pt-2', 'jt-2')
    expect(userinfoCalls).toHaveLength(2)
    // 凭据换了 ⇒ userInfo 指纹变了 ⇒ wasm 侧必须重建上下文（复用会签出旧身份）。
    expect(calls.newContext).toHaveLength(2)
  })

  it('同一 PAT 但 **jt 变了** ⇒ 上下文重建（security_oauth_token 参与身份）', async () => {
    const { provider, calls } = makeProvider()
    await provider.contextFor('pt-1', 'jt-old')
    await provider.contextFor('pt-1', 'jt-new')
    expect(calls.newContext).toHaveLength(2)
    // 第二段的 userInfoJson 里必须是**新的** jt。
    expect(calls.newContext[1]![2]).toContain('jt-new')
    expect(calls.newContext[1]![2]).not.toContain('jt-old')
  })

  it('同一 PAT 同一 jt ⇒ 复用同一个上下文（不重复构造）', async () => {
    const { provider, calls } = makeProvider()
    const first = await provider.contextFor('pt-1', 'jt-1')
    const second = await provider.contextFor('pt-1', 'jt-1')
    expect(calls.newContext).toHaveLength(1)
    expect(second).toBe(first)
  })

  it('userinfo 取不到 ⇒ **抛错**，绝不拿空 uid 去签（真机 101 的根因）', async () => {
    const fetcher = (async () => new Response('{"error":"unauthorized"}', {
      status: 401, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const { provider, calls } = makeProvider({ fetcher })

    await expect(provider.contextFor('pt-1', 'jt-1')).rejects.toThrow()
    // ⚠️ 本模块存在的**全部意义**：一次签名都不许发生。
    expect(calls.newContext).toHaveLength(0)
    expect(calls.generate).toHaveLength(0)
  })

  it('uid 解析失败（200 但三段全缺）⇒ 同样不签', async () => {
    const fetcher = (async () => jsonResponse({ name: 'no-uid' })) as unknown as typeof fetch
    const { provider, calls } = makeProvider({ fetcher })

    await expect(provider.contextFor('pt-1', 'jt-1')).rejects.toThrow(/uid/)
    expect(calls.newContext).toHaveLength(0)
  })

  it('失败**不写缓存**：下一次取上下文会重新尝试拉 uid', async () => {
    let attempt = 0
    const fetcher = (async () => {
      attempt += 1
      return attempt === 1
        ? new Response('boom', { status: 500 })
        : jsonResponse(CN_USERINFO)
    }) as unknown as typeof fetch
    const { provider } = makeProvider({ fetcher })

    await expect(provider.contextFor('pt-1', 'jt-1')).rejects.toThrow()
    // 第二次（上游恢复）必须成功 —— 缓存里存了「失败」就永远起不来了。
    await expect(provider.contextFor('pt-1', 'jt-1')).resolves.toBeDefined()
    expect(attempt).toBe(2)
  })

  it('uid 进了 userInfoJson（第一段派生入参与第二段上下文入参都带它）', async () => {
    const { provider, calls } = makeProvider()
    await provider.contextFor('pt-1', 'jt-1')
    // 第一段：generate_runtime_auth_fields 的入参。
    expect(calls.generate[0]).toContain(CN_USERINFO.id)
    // 第二段：qodercontext_new 的 userInfoJson（第 3 个参数）。
    expect(calls.newContext[0]![2]).toContain(CN_USERINFO.id)
    // security_oauth_token 是 jt，不是 PAT。
    expect(calls.newContext[0]![2]).toContain('jt-1')
    expect(calls.newContext[0]![2]).not.toContain('pt-1')
  })

  it('**uid 缓存按 PAT 分键**：两个账号各拿各的 uid（全局单值缓存会串号）', async () => {
    let n = 0
    const fetcher = (async () => {
      n += 1
      return jsonResponse({ ...CN_USERINFO, id: `uid-${n}` })
    }) as unknown as typeof fetch
    const { provider, calls } = makeProvider({ fetcher })

    await provider.contextFor('pt-A', 'jt-A')
    await provider.contextFor('pt-B', 'jt-B')
    // 两个账号的上下文各带各的 uid —— 串号会签出「身份不符」的请求（101）。
    expect(calls.newContext[0]![2]).toContain('uid-1')
    expect(calls.newContext[1]![2]).toContain('uid-2')
  })

  it('`dispose()` 释放上下文；之后再取会重建', async () => {
    const { provider, calls } = makeProvider()
    await provider.contextFor('pt-1', 'jt-1')
    provider.dispose()
    expect(calls.freed).toHaveLength(1)
    await provider.contextFor('pt-1', 'jt-1')
    expect(calls.newContext).toHaveLength(2)
  })

  it('wasm **懒加载**：uid 取不到时不触发 glue 加载', async () => {
    let loads = 0
    const { provider } = makeProvider({
      fetcher: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
      loadGlue: (async () => { loads += 1; throw new Error('不该被调用') }) as never,
    })
    await expect(provider.contextFor('pt-1', 'jt-1')).rejects.toThrow()
    // uid 先取、取不到就直接抛 ⇒ glue 加载器一次都没被调用。
    expect(loads).toBe(0)
  })

  it('wasm 加载失败原样上抛（不吞成「签名失败」这种难查的形态）', async () => {
    const provider = new QoderSigningProvider({
      product: QODER_CN,
      loadGlue: async () => { throw new Error('未找到 Qoder 签名组件（wasm）') },
      fetchImpl: (async () => jsonResponse(CN_USERINFO)) as unknown as typeof fetch,
      machineIdOptions: { homeDir: 'X:\\nonexistent' },
    })
    await expect(provider.contextFor('pt-1', 'jt-1')).rejects.toThrow(/未找到 Qoder 签名组件/)
  })

  it('**并发**取上下文只加载一次 glue（35 MB 提取不能重复跑）', async () => {
    let loads = 0
    const { glue } = makeFakeGlue()
    const provider = new QoderSigningProvider({
      product: QODER_CN,
      loadGlue: async () => { loads += 1; return glue },
      fetchImpl: (async () => jsonResponse(CN_USERINFO)) as unknown as typeof fetch,
      machineIdOptions: { homeDir: 'X:\\nonexistent' },
    })
    await Promise.all([
      provider.contextFor('pt-1', 'jt-1'),
      provider.contextFor('pt-1', 'jt-1'),
      provider.contextFor('pt-1', 'jt-1'),
    ])
    expect(loads).toBe(1)
  })

  it('**并发**取同一账号的 uid 只打一次 userinfo（在途请求要合并）', async () => {
    // 账号池场景下同一账号可能同时有多个 chat 请求在飞。不合并的话，冷启动
    // 一瞬间会打出 N 个 userinfo 请求 —— 既是无谓的往返，也让「同一账号」在
    // 服务端看来像异常流量。
    let fetches = 0
    const fetcher = (async () => {
      fetches += 1
      // 让出几个微任务，确保三个调用真的**重叠**（不是顺序跑完）。
      await new Promise((resolve) => setTimeout(resolve, 5))
      return jsonResponse(CN_USERINFO)
    }) as unknown as typeof fetch
    const { provider } = makeProvider({ fetcher })

    await Promise.all([
      provider.contextFor('pt-1', 'jt-1'),
      provider.contextFor('pt-1', 'jt-1'),
      provider.contextFor('pt-1', 'jt-1'),
    ])
    expect(fetches).toBe(1)
  })

  it('在途请求**失败后不留下毒缓存**：下一次照常重试', async () => {
    let fetches = 0
    const fetcher = (async () => {
      fetches += 1
      if (fetches === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new Response('boom', { status: 500 })
      }
      return jsonResponse(CN_USERINFO)
    }) as unknown as typeof fetch
    const { provider } = makeProvider({ fetcher })

    // 两个并发调用共享同一次失败的拉取。
    const results = await Promise.allSettled([
      provider.contextFor('pt-1', 'jt-1'),
      provider.contextFor('pt-1', 'jt-1'),
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(fetches).toBe(1)
    // 失败的在途 Promise **不能**留在缓存里，否则永远起不来。
    await expect(provider.contextFor('pt-1', 'jt-1')).resolves.toBeDefined()
    expect(fetches).toBe(2)
  })
})
