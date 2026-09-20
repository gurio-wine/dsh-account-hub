/**
 * Qoder **CN（国内版）** 第二 region 单测（**全 mock，零网络**）。
 *
 * ## 两条主线
 *
 * 1. **配置层的每个字段都逐字段钉死**：{@link QODER_CN} 的值来自真机探测
 *    （openapi / models 实测 200）与官方 CN CLI 源码（chat 主机、`client_type`、
 *    Cosy 版本），**证据强度逐个不同** —— 断言里带 `🔴`/`⚠️` 标记的项明确写出
 *    「这是源码值而非实测值」，避免后来者误以为它们已被真机验证。
 * 2. **国际版零变化**：{@link QODER} 的每个字段、以及它在
 *    `buildQoderChatBody` / `qoderJobTokenHeaders` 上的产物，都与本 region
 *    落地前**逐字节相同**（那批既有用例会一起证明这一点，这里补几条显式的
 *    反向断言，防「顺手给国际版也补上 CN 字段」）。
 *
 * ## CN 目录 fixture 的来源
 *
 * {@link CN_SNAPSHOT} 是真机 `GET https://api.qoder.com.cn/api/v1/cloud/models`
 * 的**逐字节原文**（14 项、`has_more:false`）。它与国际版快照
 * （`qoder-models.spec.ts` 的 `T1_SNAPSHOT`）**字段同构、内容不同**：CN 的 14 项
 * **全部** `is_enabled:true`，且 id 集合里没有 `ultimate` / `performance` /
 * `efficient` / `smodel` / `cmodel` / `lite`，多了 `q37fmodel` / `gm51model`。
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALL_QODER_PRODUCTS,
  QODER,
  QODER_CN,
  QODER_CN_CHAT_BASE,
  QODER_CN_MODELS_BASE,
  QODER_CN_OPENAPI_BASE,
  QODER_CN_PAT_URL,
  QODER_CN_USER_AGENT,
  QODER_PAT_PREFIX,
  qoderClientType,
  qoderJobTokenHeaders,
  qoderProductById,
} from '../../src/qoder-product.js'
import type { QoderCredential } from '../../src/qoder-product.js'
import {
  QODER_CN_FALLBACK_MODELS,
  QODER_FALLBACK_MODELS,
  QODER_OFF_CATALOG_HINT,
  effectiveQoderCatalog,
  fallbackQoderCatalog,
  fetchQoderDirectory,
  parseQoderDirectory,
} from '../../src/qoder-models.js'
import {
  QoderAdapter,
  buildQoderChatBody,
  resolveQoderChatBase,
} from '../../src/qoder-adapter.js'
import type { QoderAdapterOptions } from '../../src/qoder-adapter.js'
import { QoderAuth } from '../../src/qoder-auth.js'
import {
  classifyQoderError,
  isQoderBackoff,
  qoderHarnessErrorCode,
  recordsQoderCooldown,
  shouldSwitchQoderAccount,
} from '../../src/qoder-errors.js'
import { accountCredentialRefName } from '../../src/jet-hub-rpc.js'

// ── 夹具 ──

/** 一个形态完整的凭据（PAT 本体在 `access_token`）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-cn-test-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/** 组装适配器选项（默认目录拉取返回空 = 回退静态表，保证零网络）。 */
function adapterOptions(overrides: Partial<QoderAdapterOptions> = {}): QoderAdapterOptions {
  return {
    credentialRef: 'QODER_CN_PERSONAL_TOKEN' as QoderAdapterOptions['credentialRef'],
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    getJobToken: async () => 'jt-test',
    invalidateJobToken: () => {},
    fetchRemoteModels: async () => [],
    product: QODER_CN,
    ...overrides,
  }
}

/** 造一份最小 `GenerateOptions`。 */
function generateOptions(overrides: Record<string, unknown> = {}): never {
  return {
    provider: 'qoder-cn',
    model: 'qmodel_38max',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as never
}

/**
 * CN 真机目录快照（14 项，逐字节照抄）。
 *
 * ⚠️ **不要「整理」这个数组**：字段顺序、`efforts` 的顺序（`qmodel_38max` 是
 * `["xhigh","low","medium"]` 而 `dfmodel` 是 `["max","low","high"]`）、
 * `mmodel` 的 `is_vl:false` 与只有一个可用窗口都是实测值。
 */
const CN_SNAPSHOT = {
  data: [
    { id: 'auto', display_name: 'Auto', is_enabled: true, is_new: false, is_vl: true, support_disable_reasoning: false, price_factor: 0.5, max_input_tokens: 180000 },
    { id: 'qmodel_38max', display_name: 'Qwen3.8-Max', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.5, efforts: ['xhigh', 'low', 'medium'], default_effort: 'medium', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qfmodel', display_name: 'Qwen3.8-Flash', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0, efforts: ['xhigh', 'low', 'medium'], default_effort: 'medium', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qmodel_latest', display_name: 'Qwen3.7-Max', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.5, max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'qmodel', display_name: 'Qwen3.7-Plus', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.1, max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'q37fmodel', display_name: 'Qwen3.7-Flash', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.1, max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'dmodel', display_name: 'DeepSeek-V4-Pro', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.8, efforts: ['high', 'max'], default_effort: 'max', max_input_tokens: 96000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'dfmodel', display_name: 'DeepSeek-Flash', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.2, efforts: ['max', 'low', 'high'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'gmodel', display_name: 'GLM-5.3', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.6, efforts: ['high', 'low', 'max'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'gfmodel', display_name: 'GLM-5.3-Flash', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.1, efforts: ['max', 'high'], default_effort: 'max', max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'gm51model', display_name: 'GLM-5.2', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: true, price_factor: 0.6, efforts: ['high', 'max'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'kmodel_latest', display_name: 'Kimi-K3', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.8, efforts: ['high', 'low', 'max'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'kmodel', display_name: 'Kimi-K2.8-Preview', is_enabled: true, is_new: true, is_vl: true, support_disable_reasoning: false, price_factor: 0.3, efforts: ['high', 'low', 'max'], default_effort: 'max', max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] },
    { id: 'mmodel', display_name: 'MiniMax-M2.7', is_enabled: true, is_new: true, is_vl: false, support_disable_reasoning: false, price_factor: 0.2, max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000] },
  ],
  has_more: false,
}

/** CN 快照的项数（真机记的就是 14）。 */
const CN_ITEM_COUNT = 14

/** 所有已创建的 auth service；afterEach 统一 stop()，避免刷新定时器泄漏。 */
const services: QoderAuth[] = []

/** 最小化的内存凭据提供者（形状与 ctx.credentials 一致）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): Context {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  return ctx
}

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  delete process.env.QODER_MODEL_SERVER_HOST
})

// ─────────────────────────────────────────────────────────────────────────────
// A. QODER_CN 配置逐字段
// ─────────────────────────────────────────────────────────────────────────────

describe('QODER_CN 配置逐字段', () => {
  it('id / displayName（provider id 带连字符，是本 region 的判据前提）', () => {
    expect(QODER_CN.id).toBe('qoder-cn')
    expect(QODER_CN.displayName).toBe('Qoder CN')
  })

  it('三个基址：openapi / models 实测值，chat host 为官方 CN CLI 源码值', () => {
    expect(QODER_CN.openapiBase).toBe('https://openapi.qoder.com.cn')
    expect(QODER_CN_OPENAPI_BASE).toBe('https://openapi.qoder.com.cn')
    expect(QODER_CN.modelsBase).toBe('https://api.qoder.com.cn')
    expect(QODER_CN_MODELS_BASE).toBe('https://api.qoder.com.cn')
    // 🔴 chat 主机来自官方 CN CLI 的 `CR = _o ? "gateway.qoder.com.cn" : "api2.qoder.sh"`。
    // **故意把「它是源码值」写进断言**：该 host 上的 `/model/v1/chat/completions`
    // 不存在（ALB 按路径级恒 503 —— 见下面 I 节的定性），故这一项**永远不会**有真机证据。
    // 常量本身仍被保留：逃生阀与未来协议变化要用它。
    expect(QODER_CN.chatBase).toBe('https://gateway.qoder.com.cn')
    expect(QODER_CN_CHAT_BASE).toBe('https://gateway.qoder.com.cn')
  })

  it('三个基址**都与国际版不同**（改错会静默打到错 region）', () => {
    expect(QODER_CN.openapiBase).not.toBe(QODER.openapiBase)
    expect(QODER_CN.chatBase).not.toBe(QODER.chatBase)
    expect(QODER_CN.modelsBase).not.toBe(QODER.modelsBase)
  })

  it('chatBase 不带 `-v2` 段（不要按「同形替换」去猜 CN 主机）', () => {
    expect(QODER.chatBase).toBe('https://api2-v2.qoder.sh')
    expect(QODER_CN.chatBase).not.toContain('-v2')
  })

  it('PAT：前缀与官方文档同源（`pt-`），签发页换成 CN 域名', () => {
    expect(QODER_CN.patPrefix).toBe(QODER_PAT_PREFIX)
    expect(QODER_CN.patPrefix).toBe('pt-')
    expect(QODER_CN.patUrl).toBe('https://qoder.cn/account/integrations')
    expect(QODER_CN_PAT_URL).toBe('https://qoder.cn/account/integrations')
    // 两个 region 的 PAT 不通用 ⇒ 签发页必须跟着 region 走。
    expect(QODER_CN.patUrl).not.toBe(QODER.patUrl)
  })

  it('userAgent 为 `qoder/<CN CLI 版本>`（⚠️ 官方源码模板，与 region 无关）', () => {
    // ⚠️ 曾经写成 `qodercn/1.1.58` —— 那是把 **npm 包名**（`@qodercn-ai/qoderclicn`）
    // 当成了产品名而推断出的错值。官方 `openApiJsonApiRequest` 用的是
    // `` `qoder/${version}` `` 模板，**与 region 无关**，故 CN 与国际版同形。
    expect(QODER_CN.userAgent).toBe('qoder/1.1.58')
    expect(QODER_CN_USER_AGENT).toBe('qoder/1.1.58')
    expect(QODER.userAgent).toBe('qoder/1.1.16')
    // 两个 region 的 UA **前缀相同**（同形不同版本号）—— 这条反向锁死
    // 「不要为 CN 另发明一个前缀」，与 cn 的 client_type / Cosy 头那类差异不同。
    expect(QODER_CN.userAgent.startsWith('qoder/')).toBe(true)
    expect(QODER.userAgent.startsWith('qoder/')).toBe(true)
  })

  it('clientType 为 `"5"`（⚠️ 官方 CN CLI 的 kg() 默认值，未实测）', () => {
    expect(QODER_CN.clientType).toBe('5')
    // 它是**字符串** `"5"` 而不是数字 5：请求体里必须与 CLI 逐字节一致。
    expect(typeof QODER_CN.clientType).toBe('string')
  })

  it('cosyVersion 为 CN CLI 版本（存在 ⇒ 发 Cosy 头）', () => {
    expect(QODER_CN.cosyVersion).toBe('1.1.58')
  })

  it('凭据 ref：默认与账号池前缀都带 CN，机械派生与之一致', () => {
    expect(QODER_CN.defaultCredentialRef).toBe('QODER_CN_PERSONAL_TOKEN')
    expect(QODER_CN.accountCredentialRefPrefix).toBe('QODER_CN_ACCOUNT')
    // 账号池前缀不是手写惯例，而是必须与 jet-hub-rpc 的机械派生**逐字符一致**：
    // 带连字符的 provider id 会被 `toUpperCase().replace(/-/g,'_')` 转成下划线。
    expect(accountCredentialRefName(QODER_CN.id, 'A1B2C3D4'))
      .toBe(`${QODER_CN.accountCredentialRefPrefix}_A1B2C3D4`)
    expect(accountCredentialRefName(QODER_CN.id, 'A1B2C3D4')).toBe('QODER_CN_ACCOUNT_A1B2C3D4')
  })

  it('两个 region 的凭据 ref 互不相同（否则账号会串到同一个池）', () => {
    expect(QODER_CN.defaultCredentialRef).not.toBe(QODER.defaultCredentialRef)
    expect(QODER_CN.accountCredentialRefPrefix).not.toBe(QODER.accountCredentialRefPrefix)
  })

  it('国际版 QODER **逐字段不变**：键集合与取值都与接入 CN 前一致', () => {
    // 键集合锁死：新增 CN 专属字段（serviceName / clientType / cosyVersion）时
    // 若「顺手」也给国际版补上，这条会立刻失败。CN 落地前 QODER 恰有这 10 个键。
    expect(Object.keys(QODER).sort()).toEqual([
      'accountCredentialRefPrefix',
      'chatBase',
      'defaultCredentialRef',
      'displayName',
      'id',
      'modelsBase',
      'openapiBase',
      'patPrefix',
      'patUrl',
      'userAgent',
    ])
    // 取值逐条照抄接入前的实测值（改动这几行等于改了国际版的出站身份）。
    expect(QODER).toEqual({
      id: 'qoder',
      displayName: 'Qoder',
      openapiBase: 'https://openapi.qoder.sh',
      chatBase: 'https://api2-v2.qoder.sh',
      modelsBase: 'https://api.qoder.com',
      userAgent: 'qoder/1.1.16',
      patPrefix: 'pt-',
      patUrl: 'https://qoder.com/account/integrations',
      defaultCredentialRef: 'QODER_PERSONAL_TOKEN',
      accountCredentialRefPrefix: 'QODER_ACCOUNT',
    })
  })

  it('CN 独有的三个可选字段只出现在 CN 配置上', () => {
    expect(QODER.clientType).toBeUndefined()
    expect(QODER.cosyVersion).toBeUndefined()
    expect(QODER.serviceName).toBeUndefined()
    expect(QODER_CN.clientType).toBeDefined()
    expect(QODER_CN.cosyVersion).toBeDefined()
    expect(QODER_CN.serviceName).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. serviceName 判据（AGENTS.md 钉死的正反两面）
// ─────────────────────────────────────────────────────────────────────────────

describe('serviceName 判据：无连字符不声明，带连字符必须声明', () => {
  it('qoder（反面用例）**不声明** serviceName —— 机械派生 qoderAuth 本就合法', () => {
    expect(QODER.serviceName).toBeUndefined()
    expect('serviceName' in QODER).toBe(false)
    expect(`${QODER.id}Auth`).toBe('qoderAuth')
  })

  it('qoder-cn（正面用例）**必须声明** qoderCnAuth —— 机械派生不合法', () => {
    expect(QODER_CN.serviceName).toBe('qoderCnAuth')
    // 反证：不声明的话派生出来的是这个非标识符风格的字符串。
    expect(`${QODER_CN.id}Auth`).toBe('qoder-cnAuth')
    expect(QODER_CN.serviceName).not.toBe(`${QODER_CN.id}Auth`)
  })

  it('QoderAuth 按 product.serviceName 注册（CN → ctx.qoderCnAuth）', () => {
    const ctx = makeContext()
    const service = new QoderAuth(ctx, { product: QODER_CN })
    services.push(service)
    expect(service.name).toBe('qoderCnAuth')
    expect((ctx as unknown as Record<string, unknown>).qoderCnAuth).toBeInstanceOf(QoderAuth)
    // 国际版的服务名不受影响。
    expect((ctx as unknown as Record<string, unknown>).qoderAuth).toBeUndefined()
  })

  it('QoderAuth 读 CN 的凭据 ref 与 PAT 签发页', () => {
    const ctx = makeContext()
    const service = new QoderAuth(ctx, { product: QODER_CN })
    services.push(service)
    expect(service.credentialRefName).toBe('QODER_CN_PERSONAL_TOKEN')
    expect(service.patUrl).toBe('https://qoder.cn/account/integrations')
  })

  it('不声明 serviceName 的产品仍按 `${id}Auth` 派生（国际版行为不变）', () => {
    const ctx = makeContext()
    const service = new QoderAuth(ctx, { product: QODER })
    services.push(service)
    expect(service.name).toBe('qoderAuth')
  })

  it('构造选项的 serviceName 仍可整体覆盖产品声明（多实例测试用）', () => {
    const ctx = makeContext()
    const service = new QoderAuth(ctx, { product: QODER_CN, serviceName: 'customCnAuth' })
    services.push(service)
    expect(service.name).toBe('customCnAuth')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. clientType 与 Cosy 头
// ─────────────────────────────────────────────────────────────────────────────

describe('chat 请求体：metadata.context.client_type', () => {
  it('CN 下发 "5"', () => {
    const body = JSON.parse(buildQoderChatBody(generateOptions(), QODER_CN)) as Record<string, unknown>
    expect(body.metadata).toEqual({ context: { client_type: '5' } })
  })

  it('国际版仍是 qodercli（不传 product 时同值 —— 缺省即国际版）', () => {
    const explicit = JSON.parse(buildQoderChatBody(generateOptions(), QODER)) as Record<string, unknown>
    const omitted = JSON.parse(buildQoderChatBody(generateOptions())) as Record<string, unknown>
    expect(explicit.metadata).toEqual({ context: { client_type: 'qodercli' } })
    // 「缺省回退」与「显式声明」必须逐字节相同，否则将来会分叉。
    expect(omitted).toEqual(explicit)
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicit))
  })

  it('qoderClientType：缺省回退 qodercli，声明则原样用', () => {
    expect(qoderClientType(QODER)).toBe('qodercli')
    expect(qoderClientType(QODER_CN)).toBe('5')
    // 不声明 clientType 的产品（将来第三 region）也走回退。
    expect(qoderClientType({ ...QODER, id: 'qoder-cn', clientType: undefined })).toBe('qodercli')
  })

  it('除 client_type 外，两个 region 的请求体逐字段相同（同协议）', () => {
    const cn = JSON.parse(buildQoderChatBody(generateOptions(), QODER_CN)) as Record<string, unknown>
    const intl = JSON.parse(buildQoderChatBody(generateOptions(), QODER)) as Record<string, unknown>
    expect(Object.keys(cn).sort()).toEqual(Object.keys(intl).sort())
    expect(cn.messages).toEqual(intl.messages)
    expect(cn.model).toEqual(intl.model)
    expect(cn.stream).toEqual(intl.stream)
    expect(cn.stream_options).toEqual(intl.stream_options)
  })
})

describe('Cosy 头：存在 cosyVersion 才发', () => {
  /** 记录最后一次请求头的假 fetch（返回 JSON 错误体，让 stream 快速结束）。 */
  function headerSpy(): { fetcher: typeof fetch; headers: () => Record<string, string> } {
    let captured: Record<string, string> = {}
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>
      return new Response('{"error":"unauthorized"}', {
        status: 401, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { fetcher, headers: () => captured }
  }

  it('CN：发 Cosy-ClientType = clientType 与 Cosy-Version = cosyVersion', async () => {
    const spy = headerSpy()
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: spy.fetcher }))
    try {
      for await (const _chunk of adapter.stream(generateOptions())) { /* 消费到结束 */ }
    } catch { /* 401 是预期的收尾方式 */ }
    expect(spy.headers()['Cosy-ClientType']).toBe('5')
    expect(spy.headers()['Cosy-Version']).toBe('1.1.58')
    // 与请求体的 client_type 同源（两处必须是同一个值）。
    expect(spy.headers()['Cosy-ClientType']).toBe(qoderClientType(QODER_CN))
  })

  it('国际版：**一个 Cosy 头都不发**（零头变化）', async () => {
    const spy = headerSpy()
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: spy.fetcher, product: QODER }))
    try {
      for await (const _chunk of adapter.stream(generateOptions())) { /* 同上 */ }
    } catch { /* 同上 */ }
    const headers = spy.headers()
    expect(Object.keys(headers).filter((key) => key.toLowerCase().startsWith('cosy-'))).toEqual([])
    expect('Cosy-ClientType' in headers).toBe(false)
    expect('Cosy-Version' in headers).toBe(false)
  })

  it('刻意不发 Cosy-MachineOS / Cosy-MachineHostname（不猜机器身份）', async () => {
    const spy = headerSpy()
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: spy.fetcher }))
    try {
      for await (const _chunk of adapter.stream(generateOptions())) { /* 同上 */ }
    } catch { /* 同上 */ }
    expect('Cosy-MachineOS' in spy.headers()).toBe(false)
    expect('Cosy-MachineHostname' in spy.headers()).toBe(false)
  })

  it('除 Cosy 外，CN 与国际化版请求头逐键相同（同协议）', async () => {
    const cnSpy = headerSpy()
    const cnAdapter = new QoderAdapter(adapterOptions({ fetchImpl: cnSpy.fetcher }))
    try { for await (const _c of cnAdapter.stream(generateOptions())) { /* noop */ } } catch { /* noop */ }

    const intlSpy = headerSpy()
    const intlAdapter = new QoderAdapter(adapterOptions({ fetchImpl: intlSpy.fetcher, product: QODER }))
    try { for await (const _c of intlAdapter.stream(generateOptions())) { /* noop */ } } catch { /* noop */ }

    const cnExtra = Object.keys(cnSpy.headers()).filter((key) => !(key in intlSpy.headers()))
    expect(cnExtra.sort()).toEqual(['Cosy-ClientType', 'Cosy-Version'])
    // 国际版的头集合是 CN 的**子集**（没有 CN 独有头之外的差异）。
    for (const [key, value] of Object.entries(intlSpy.headers())) {
      // User-Agent 是唯一按产品取值的头，其余（鉴权 / Accept / Content-Type）同值。
      if (key === 'User-Agent') continue
      expect(cnSpy.headers()[key], key).toBe(value)
    }
    expect(intlSpy.headers()['User-Agent']).toBe(QODER.userAgent)
    expect(cnSpy.headers()['User-Agent']).toBe(QODER_CN.userAgent)
  })

  it('qoderJobTokenHeaders 本身不带 Cosy 头（头集在适配器 send() 里追加）', () => {
    const headers = qoderJobTokenHeaders('jt-x', QODER_CN, 'text/event-stream')
    expect(headers['User-Agent']).toBe(QODER_CN.userAgent)
    expect(Object.keys(headers).some((key) => key.toLowerCase().startsWith('cosy-'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. QODER_MODEL_SERVER_HOST 逃生阀
// ─────────────────────────────────────────────────────────────────────────────

describe('QODER_MODEL_SERVER_HOST 逃生阀（仅 chat）', () => {
  it('未设置 → 原样返回 product.chatBase', () => {
    delete process.env.QODER_MODEL_SERVER_HOST
    expect(resolveQoderChatBase(QODER.chatBase)).toBe('https://api2-v2.qoder.sh')
    expect(resolveQoderChatBase(QODER_CN.chatBase)).toBe('https://gateway.qoder.com.cn')
  })

  it('设置后替换 host，**两个 region 都生效**（照官方语义）', () => {
    process.env.QODER_MODEL_SERVER_HOST = 'model-gw.internal'
    expect(resolveQoderChatBase(QODER.chatBase)).toBe('https://model-gw.internal')
    expect(resolveQoderChatBase(QODER_CN.chatBase)).toBe('https://model-gw.internal')
  })

  it('带端口保留端口；带 scheme 时显式 scheme 优先', () => {
    process.env.QODER_MODEL_SERVER_HOST = 'localhost:8080'
    expect(resolveQoderChatBase(QODER.chatBase)).toBe('https://localhost:8080')

    process.env.QODER_MODEL_SERVER_HOST = 'http://localhost:8080'
    expect(resolveQoderChatBase(QODER.chatBase)).toBe('http://localhost:8080')
  })

  it('带路径 / 查询串时只取主机（路径恒为 QODER_CHAT_PATH）', () => {
    process.env.QODER_MODEL_SERVER_HOST = 'proxy.example.com/some/prefix?x=1'
    expect(resolveQoderChatBase(QODER.chatBase)).toBe('https://proxy.example.com')
  })

  it('空串 / 全空白 / 只有 scheme 一律视为未设置', () => {
    for (const value of ['', '   ', 'https://']) {
      process.env.QODER_MODEL_SERVER_HOST = value
      expect(resolveQoderChatBase(QODER.chatBase), JSON.stringify(value)).toBe(QODER.chatBase)
    }
  })

  it('**请求时读取**（不是构造时缓存）：构造后再改环境变量也生效', async () => {
    const urls: string[] = []
    // 回一条**成功**的流：每次 stream() 只发一个请求（401 会触发重换重试，
    // 用 401 的话一次 stream 有两次请求，断言下标就会指错那一次）。
    const successStream = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n\n'
      + 'data: [DONE]\n\n\n'
    const fetcher = (async (url: unknown) => {
      urls.push(String(url))
      return new Response(successStream, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    // 基线：构造时**没有**该环境变量。
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))
    for await (const _c of adapter.stream(generateOptions())) { /* noop */ }
    expect(urls).toEqual([`${QODER_CN.chatBase}/model/v1/chat/completions`])

    // 构造之后才设 —— 若实现把它缓存在构造时，这里仍会打到原 host。
    process.env.QODER_MODEL_SERVER_HOST = 'late-bound.example'
    for await (const _c of adapter.stream(generateOptions())) { /* noop */ }
    expect(urls[1]).toBe('https://late-bound.example/model/v1/chat/completions')
  })

  it('只影响 chat：目录与额度端点仍走 product 的 base', async () => {
    process.env.QODER_MODEL_SERVER_HOST = 'model-gw.internal'
    const urls: string[] = []
    const fetcher = (async (url: unknown) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await fetchQoderDirectory(CREDENTIAL, { fetchImpl: fetcher, product: QODER_CN })
    expect(urls[0]).toBe(`${QODER_CN.modelsBase}/api/v1/cloud/models`)
    expect(urls[0]).not.toContain('model-gw.internal')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. CN 静态兜底表（含「CN 不认 lite」反向断言）
// ─────────────────────────────────────────────────────────────────────────────

describe('静态兜底表按 product 分', () => {
  it('CN 兜底表恰好 2 项：qmodel_38max + qfmodel', () => {
    expect(QODER_CN_FALLBACK_MODELS.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel'])
    expect(fallbackQoderCatalog(QODER_CN).map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel'])
  })

  it('**CN 不认 lite**（反向断言）：兜底表里没有它，回退产物里也没有', () => {
    expect(QODER_CN_FALLBACK_MODELS.some((model) => model.id === 'lite')).toBe(false)
    expect(fallbackQoderCatalog(QODER_CN).map((entry) => entry.id)).not.toContain('lite')
    expect(effectiveQoderCatalog([], QODER_CN).map((entry) => entry.id)).not.toContain('lite')
    expect(effectiveQoderCatalog(undefined, QODER_CN).map((entry) => entry.id)).not.toContain('lite')
  })

  it('国际版兜底表逐字节不变（3 项、含 lite、lite 无档位）', () => {
    expect(QODER_FALLBACK_MODELS.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    expect(effectiveQoderCatalog([]).map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    expect(effectiveQoderCatalog([], QODER).map((entry) => entry.id)).toEqual(['qmodel_38max', 'qfmodel', 'lite'])
    const lite = fallbackQoderCatalog(QODER).find((entry) => entry.id === 'lite')
    expect(lite).toEqual({ id: 'lite', name: 'Lite', enabled: true })
  })

  it('两张表的前两项逐字段相同（同名同档位，只是 CN 少了 lite）', () => {
    expect(QODER_CN_FALLBACK_MODELS).toEqual(QODER_FALLBACK_MODELS.slice(0, 2))
  })

  it('回退时返回新数组（CN 表同样不被调用方污染）', () => {
    const cn = fallbackQoderCatalog(QODER_CN)
    cn.pop()
    expect(fallbackQoderCatalog(QODER_CN)).toHaveLength(2)
    expect(QODER_CN_FALLBACK_MODELS).toHaveLength(2)
  })

  it('动态目录成功时 CN 也不并入静态项', () => {
    const remote = parseQoderDirectory(CN_SNAPSHOT)
    const effective = effectiveQoderCatalog(remote, QODER_CN)
    expect(effective).toHaveLength(CN_ITEM_COUNT)
    expect(effective.map((entry) => entry.id)).not.toContain('lite')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. CN 目录 fixture 解析（14 项全 is_enabled）
// ─────────────────────────────────────────────────────────────────────────────

describe('parseQoderDirectory：CN 真机 14 项快照', () => {
  it('14 项**全部** is_enabled:true ⇒ 默认过滤后仍是 14 项', () => {
    const entries = parseQoderDirectory(CN_SNAPSHOT)
    expect(entries).toHaveLength(CN_ITEM_COUNT)
    expect(entries.every((entry) => entry.enabled)).toBe(true)
  })

  it('id 顺序与真机一致（含 CN 独有的 q37fmodel / gm51model）', () => {
    expect(parseQoderDirectory(CN_SNAPSHOT).map((entry) => entry.id)).toEqual([
      'auto', 'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel', 'q37fmodel',
      'dmodel', 'dfmodel', 'gmodel', 'gfmodel', 'gm51model', 'kmodel_latest',
      'kmodel', 'mmodel',
    ])
  })

  it('CN 没有 tier 项与 lite（与国际版集合不同）', () => {
    const ids = parseQoderDirectory(CN_SNAPSHOT).map((entry) => entry.id)
    for (const absent of ['ultimate', 'performance', 'efficient', 'smodel', 'cmodel', 'lite']) {
      expect(ids, absent).not.toContain(absent)
    }
  })

  it('字段读取与国际版同口径：档位逐字符、窗口含非整值、is_vl 如实', () => {
    const entries = parseQoderDirectory(CN_SNAPSHOT)
    const max = entries.find((entry) => entry.id === 'qmodel_38max')
    expect(max?.name).toBe('Qwen3.8-Max')
    expect(max?.reasoningEfforts).toEqual(['xhigh', 'low', 'medium'])
    expect(max?.defaultReasoningEffort).toBe('medium')
    expect(max?.contextWindow).toBe(200_000)
    expect(max?.maxInputTokens).toBe(180_000)

    // `mmodel` 是 CN 快照里**唯一** is_vl:false、且只有一个可用窗口的项。
    const mmodel = entries.find((entry) => entry.id === 'mmodel')
    expect(mmodel?.supportsImages).toBe(false)
    expect(mmodel?.availableContextWindows).toEqual([200_000])

    // `dfmodel` 的档位顺序是 ['max','low','high'] —— 不排序、不规整。
    expect(entries.find((entry) => entry.id === 'dfmodel')?.reasoningEfforts)
      .toEqual(['max', 'low', 'high'])
  })

  it('无档位的项不声明档位（auto / qmodel_latest / qmodel / q37fmodel）', () => {
    const entries = parseQoderDirectory(CN_SNAPSHOT)
    for (const id of ['auto', 'qmodel_latest', 'qmodel', 'q37fmodel']) {
      expect(entries.find((entry) => entry.id === id)?.reasoningEfforts, id).toBeUndefined()
    }
    // 对照组：同一次解析里 `dmodel` **有**档位 —— 证明上面的 undefined 不是
    // 「解析器整体没读 efforts」造成的假绿。
    expect(entries.find((entry) => entry.id === 'dmodel')?.reasoningEfforts).toEqual(['high', 'max'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G. 适配器按 product 工作（provider / 目录 / 表外判定）
// ─────────────────────────────────────────────────────────────────────────────

describe('适配器按 product 工作', () => {
  it('providerInfo 用 CN 的 id 与展示名', () => {
    const adapter = new QoderAdapter(adapterOptions())
    expect(adapter.providerInfo(QODER_CN.id)).toEqual({ id: 'qoder-cn', name: 'Qoder CN' })
  })

  it('目录失败时播报 CN 兜底表（2 项、无 lite）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const models = await adapter.listModels(QODER_CN.id)
    expect(models.map((model) => model.id)).toEqual(['qmodel_38max', 'qfmodel'])
    // provider 字段必须是 CN 的 id（写死 qoder 会让黑名单与账号池查错键）。
    expect(models.every((model) => model.provider === 'qoder-cn')).toBe(true)
  })

  it('CN：lite 按**表外模型**处理（无展示名、无档位、无窗口）', async () => {
    const adapter = new QoderAdapter(adapterOptions())
    const resolved = await adapter.resolveModel(QODER_CN.id, 'lite')
    expect(resolved).toEqual({
      provider: QODER_CN.id,
      id: 'lite',
      name: 'lite',
      inputModalities: ['text'],
    })
  })

  it('国际版：lite 仍被认可（有展示名 Lite）—— 反向锁死 CN 的分支没波及它', async () => {
    const adapter = new QoderAdapter(adapterOptions({ product: QODER }))
    const resolved = await adapter.resolveModel(QODER.id, 'lite')
    expect(resolved.name).toBe('Lite')
  })

  it('CN 目录成功时用目录给的展示名，静态表仍作第二级', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchRemoteModels: async () => parseQoderDirectory(CN_SNAPSHOT),
    }))
    const models = await adapter.listModels(QODER_CN.id)
    expect(models).toHaveLength(CN_ITEM_COUNT)
    expect((await adapter.resolveModel(QODER_CN.id, 'mmodel')).name).toBe('MiniMax-M2.7')
    // 目录里没有 lite ⇒ 第二级（CN 静态表）也不命中 ⇒ 名字回退成 id。
    expect((await adapter.resolveModel(QODER_CN.id, 'lite')).name).toBe('lite')
  })

  it('CN 上 live 表外模型失败时补「不在目录」提示（lite 与 third-party id 都是表外）', async () => {
    const INVALID_MODEL_STREAM = 'event: error\n'
      + 'data: {"error":{"code":"invalid_model_error","message":"model not found"}}\n\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchRemoteModels: async () => parseQoderDirectory(CN_SNAPSHOT),
      fetchImpl: (async () => new Response(INVALID_MODEL_STREAM, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
    }))
    await adapter.listModels(QODER_CN.id)
    const error = await (async () => {
      try {
        for await (const _chunk of adapter.stream(generateOptions({ model: 'lite' }))) { /* noop */ }
      } catch (caught) { return caught as Error }
      throw new Error('expected stream to throw')
    })()
    expect(error.message).toContain(QODER_OFF_CATALOG_HINT)
  })

  it('同一个表外 id 在两个 region 下都补提示（判据按「查哪张表」，不是「一律表外」）', async () => {
    // `ultimate` 是**国际版**的 tier 名，两张快照的生效目录里都没有它 ⇒ 两个
    // region 都应判表外。用同一个 id 跑两遍，证明 region 分支没有把提示判据
    // 变成「总是补」或「总是不补」。
    const INVALID_MODEL_STREAM = 'event: error\n'
      + 'data: {"error":{"code":"invalid_model_error","message":"model not found"}}\n\n\n'
    const remote = async () => parseQoderDirectory({ data: CN_SNAPSHOT.data })
    const streamError = async (product: typeof QODER | typeof QODER_CN): Promise<Error> => {
      const adapter = new QoderAdapter(adapterOptions({
        product,
        fetchRemoteModels: remote,
        fetchImpl: (async () => new Response(INVALID_MODEL_STREAM, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
      }))
      await adapter.listModels(product.id)
      try {
        for await (const _chunk of adapter.stream(generateOptions({ model: 'ultimate' }))) { /* noop */ }
      } catch (caught) { return caught as Error }
      throw new Error('expected stream to throw')
    }
    expect((await streamError(QODER)).message).toContain(QODER_OFF_CATALOG_HINT)
    expect((await streamError(QODER_CN)).message).toContain(QODER_OFF_CATALOG_HINT)
  })

  it('CN 的默认凭据 ref 用于账号池查询（provider id 必须是 qoder-cn）', async () => {
    expect(QODER_CN.defaultCredentialRef).toBe('QODER_CN_PERSONAL_TOKEN')
    const seen: string[] = []
    const adapter = new QoderAdapter(adapterOptions({
      accountPool: {
        findAccountIdByCredential: async (provider: string) => { seen.push(provider); return '' },
        disabledModelsFor: () => new Set<string>(),
      } as never,
      fetchImpl: (async () => new Response('{"error":"unauthorized"}', {
        status: 401, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    }))
    try { for await (const _c of adapter.stream(generateOptions())) { /* noop */ } } catch { /* noop */ }
    expect(seen).toEqual(['qoder-cn'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// H. 注册表与 productById
// ─────────────────────────────────────────────────────────────────────────────

describe('ALL_QODER_PRODUCTS 与 qoderProductById', () => {
  it('恰好两项，国际版恒为首项（既有调用方的默认取值不变）', () => {
    expect(ALL_QODER_PRODUCTS).toHaveLength(2)
    expect(ALL_QODER_PRODUCTS[0]).toBe(QODER)
    expect(ALL_QODER_PRODUCTS[1]).toBe(QODER_CN)
  })

  it('qoderProductById 覆盖两个 region，未知 id 返回 undefined', () => {
    expect(qoderProductById('qoder')).toBe(QODER)
    expect(qoderProductById('qoder-cn')).toBe(QODER_CN)
    for (const unknown of ['', 'QODER', 'Qoder-CN', 'qoder-cn ', 'qoder2']) {
      expect(qoderProductById(unknown), unknown).toBeUndefined()
    }
  })

  it('两个产品 id 互不相同且写法稳定（id 是账号池与黑名单的键）', () => {
    expect(new Set(ALL_QODER_PRODUCTS.map((product) => product.id)).size).toBe(2)
    expect(ALL_QODER_PRODUCTS.map((product) => product.id)).toEqual(['qoder', 'qoder-cn'])
  })

  it('只有带连字符的那个产品声明了 serviceName', () => {
    for (const product of ALL_QODER_PRODUCTS) {
      if (product.id.includes('-')) {
        expect(product.serviceName, product.id).toBeDefined()
        expect(product.serviceName, product.id).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      } else {
        expect(product.serviceName, product.id).toBeUndefined()
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I. CN 的 chat 503 定性：路径不存在 ⇒ 直报，不退避、不换号
//
// 二次取证定案（2026-09-21）：`gateway.qoder.com.cn` 上
// `/model/v1/chat/completions` **不存在**，ALB 按路径级恒 503（与凭据/头/出口
// 无关，也不会恢复）。故对 CN 退避重试是纯粹的误导 —— 永远不可能成功。
// 国际版的 503 维持退避语义不变（对它而言瞬时故障是真实可能，实测可用）。
// ─────────────────────────────────────────────────────────────────────────────

describe('chat 503 按 region 分流的定性（路径不存在 vs 瞬时故障）', () => {
  it('**CN 的 503 直报**：fail、不退避、不换号、不记徽章', () => {
    const result = classifyQoderError({
      httpStatus: 503, message: '<html>503 Service Temporarily Unavailable</html>', product: QODER_CN,
    })

    expect(result.action).toBe('fail')
    expect(isQoderBackoff(result.action)).toBe(false)
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
    expect(recordsQoderCooldown(result)).toBe(false)
    // 关键：**不能**是 RATE_LIMIT —— 那正是「可重试」的信号，会让 DSH 白白退避重试。
    expect(qoderHarnessErrorCode(result)).toBe('INVALID_REQUEST')
  })

  it('CN 的 503 文案点名真因：路径不存在 + WASM 签名门槛 + PAT 过不去', () => {
    const result = classifyQoderError({ httpStatus: 503, message: 'upstream unavailable', product: QODER_CN })

    // 三个事实都要在文案里，否则用户只会看到一句「503」而无从判断该不该重试。
    expect(result.message).toContain('gateway.qoder.com.cn')
    expect(result.message).toContain('/model/v1/chat/completions')
    expect(result.message).toContain('不存在')
    expect(result.message).toContain('agent_chat_generation')
    expect(result.message).toContain('签名')
    expect(result.message).toContain('PAT')
    // 并明确告知**不会重试**，以及控制面不受影响（避免用户以为整个 provider 挂了）。
    expect(result.message).toContain('不会重试')
    // 上游原文原样保留（诊断线索不该被处置文案冲掉）。
    expect(result.message).toContain('upstream unavailable')
  })

  it('**国际版的 503 仍退避重试同一账号**（反向回归：CN 分支没波及它）', () => {
    const result = classifyQoderError({ httpStatus: 503, message: 'gateway hiccup', product: QODER })

    expect(result.action).toBe('backoff')
    expect(isQoderBackoff(result.action)).toBe(true)
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
    expect(recordsQoderCooldown(result)).toBe(false)
    expect(qoderHarnessErrorCode(result)).toBe('RATE_LIMIT')
    // 文案不得出现 CN 那套「路径不存在」的定性。
    expect(result.message).not.toContain('不存在')
  })

  it('**省略 product 时按国际版处理**（缺省语义，既有调用点零变化）', () => {
    const omitted = classifyQoderError({ httpStatus: 503, message: 'gateway hiccup' })
    const explicit = classifyQoderError({ httpStatus: 503, message: 'gateway hiccup', product: QODER })

    expect(omitted.action).toBe('backoff')
    expect(omitted).toEqual(explicit)
  })

  it('CN 的**其余** 5xx / 429 / 408 维持退避（判据只认 503，不宽一格）', () => {
    // 实测只覆盖了 503 这一个状态码。把判据放大成「CN 的 5xx 一律结构性失败」
    // 会把「上游真的抖了一下」也说成不可恢复 —— 那是用户无法自行分辨的假信息。
    for (const status of [500, 502, 504, 429, 408]) {
      const result = classifyQoderError({ httpStatus: status, message: 'hiccup', product: QODER_CN })
      expect(result.action, String(status)).toBe('backoff')
      expect(qoderHarnessErrorCode(result), String(status)).toBe('RATE_LIMIT')
    }
  })

  it('CN 的 503 只在 **chat** 线上直报；额度线（source=quota）不受影响', () => {
    // 该定性说的是「chat 路径不存在」—— 额度端点（openapi.qoder.com.cn）实测正常，
    // 它的 503 仍是普通的瞬时故障。
    const quota = classifyQoderError({ httpStatus: 503, message: 'hiccup', source: 'quota', product: QODER_CN })

    expect(quota.action).toBe('backoff')
  })

  it('CN 的 503 带业务码时**不**走结构性分支（业务码优先于状态码）', () => {
    // 有业务码说明请求确实到了应用层，不是 ALB 的路径级拒绝 —— 该走码的判定。
    const result = classifyQoderError({
      httpStatus: 503, code: 'some_business_code', message: 'boom', product: QODER_CN,
    })

    expect(result.action).toBe('fail')
    expect(result.message).toContain('some_business_code')
    expect(result.message).not.toContain('agent_chat_generation')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// J. 适配器端到端：CN 503 的**行为**（不换号、错误码不可重试）
// ─────────────────────────────────────────────────────────────────────────────

describe('适配器：CN 的 chat 503 不退避不换号，国际版仍退避', () => {
  /** 造一个 503 的 HTML 响应（ALB 错误页形态：非 JSON、无业务码）。 */
  function albResponse(): Response {
    return new Response('<html><body>503 Service Temporarily Unavailable</body></html>', {
      status: 503, headers: { 'content-type': 'text/html' },
    })
  }

  /** 跑一次 stream，返回抛出的错误（或 null）。 */
  async function errorOf(adapter: QoderAdapter, options: never): Promise<Error | null> {
    try {
      for await (const _chunk of adapter.stream(options)) { /* noop */ }
      return null
    } catch (caught) {
      return caught as Error
    }
  }

  it('CN：抛 INVALID_REQUEST（**不可重试**），且一次都不问账号池', async () => {
    let poolCalls = 0
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => albResponse()) as unknown as typeof fetch,
      accountPool: {
        getAvailableAccount: async () => { poolCalls += 1; return undefined },
        findAccountIdByCredential: async () => 'acct-1',
      } as never,
    }))
    const error = await errorOf(adapter, generateOptions())

    expect(error).toBeInstanceOf(Error)
    expect((error as unknown as { code?: string }).code).toBe('INVALID_REQUEST')
    // 不换号：ALB 的路径级拒绝与账号无关，换 N 个账号只会得到 N 个同样的 503。
    expect(poolCalls).toBe(0)
    expect(error!.message).toContain('agent_chat_generation')
  })

  it('国际版：同一份 503 响应仍抛 RATE_LIMIT（可重试，回归保护）', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      product: QODER,
      fetchImpl: (async () => albResponse()) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())

    expect((error as unknown as { code?: string }).code).toBe('RATE_LIMIT')
    expect(error!.message).not.toContain('不存在')
  })
})
