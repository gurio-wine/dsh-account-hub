import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CHAT_API_BASE, CodeArtsAdapter, QUEUE_STATUS_BASE } from '../../src/llm-adapter.js'
import type { RemoteModel } from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: 'GLM-5.2',
  messages: [],
  signal: new AbortController().signal,
} as never

function makeAdapter(overrides: {
  credential?: CodeArtsCredential | undefined
  refresh?: () => Promise<void>
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<RemoteModel[]>
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : validCredential
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => { await refresh(); credential = validCredential },
    fetchImpl,
    fetchRemoteModels: overrides.fetchRemoteModels,
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
  return adapter
}

/** 只实现 listModels 所需方法的账号池替身：对指定 provider 报告黑名单。 */
function poolWithDisabled(provider: string, ids: string[]) {
  const disabled = new Set(ids)
  return {
    disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
  }
}

describe('CodeArtsAdapter', () => {
  it('providerInfo identifies the codearts route', () => {
    // 展示名与其它 provider 统一为「产品名」风格（Codearts），不再用
    // 'CodeArts Agent' —— 模型选择器里应显示产品名而非 IDE 形态名。
    expect(makeAdapter().providerInfo('codearts')).toMatchObject({ id: 'codearts', name: 'Codearts' })
  })

  it('listModels advertises the openpangu-2.0 and deepseek-v4 models alongside the GLM family', async () => {
    // 对齐 deveco-code-rust 参考实现 codearts.rs：新增盘古模型
    // openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
    // 后端 /v1/default/models 下发的 model_id 为全小写。
    // DeepSeek V4（对齐 deveco-code 62834ff6）：CodeArts Agent 模型列表新增
    // deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费 Tokens 福利）。
    // e2e 实测确认后端实际注册的 flash ID 是 deepseek-v4-flash（无 -0731 后缀），
    // IDE 显示的 deepseek-v4-flash-0731 后端返回 404 not registered。
    const models = await makeAdapter().listModels('codearts')
    const ids = models.map(model => model.id)
    expect(ids).toContain('openpangu-2.0-flash')
    expect(ids).toContain('openpangu-2.0-pro')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('deepseek-v4-pro')
    const flash = models.find(model => model.id === 'openpangu-2.0-flash')
    const pro = models.find(model => model.id === 'openpangu-2.0-pro')
    const dsFlash = models.find(model => model.id === 'deepseek-v4-flash')
    const dsPro = models.find(model => model.id === 'deepseek-v4-pro')
    expect(flash).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-flash' })
    expect(pro).toMatchObject({ provider: 'codearts', name: 'openpangu-2.0-pro' })
    expect(dsFlash).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-flash' })
    expect(dsPro).toMatchObject({ provider: 'codearts', name: 'deepseek-v4-pro' })
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(ids[0]).toBe('GLM-5.2')
  })

  it('static DEFAULT_MODLES covers deepseek-v4.1-flash and glm-5.2-sft-harmony', async () => {
    // 真机实测（2026-09-23）：远端两处都下发这两条文本模型 ——
    // - glm-5.2-sft-harmony（端点 B snap-access builtinModels，context_window=202752）
    // - deepseek-v4.1-flash（端点 A opengw gateway/config，context_window=1048576）
    // 此前静态表 DEFAULT_MODELS 漏接，远端目录未落地时会整条消失。
    const ids = (await makeAdapter().listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).toContain('deepseek-v4.1-flash')
  })

  it('static context fallback discloses windows for deepseek-v4.1-flash (1048576) and glm-5.2-sft-harmony (202752)', async () => {
    // 静态兜底值钉死：远端目录整体失败时这两个模型窗口不能漂移。
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('codearts', 'deepseek-v4.1-flash')).context).toEqual({ contextWindow: 1048576 })
    expect((await adapter.resolveModel('codearts', 'glm-5.2-sft-harmony')).context).toEqual({ contextWindow: 202752 })
  })

  it('resolveModel discloses contextWindow for GLM-5.2 and deepseek-v4 models', async () => {
    // GLM-5.2：202752；glm-5.3-flash：1048576（1M，对齐 deveco-code-rust 90aeb17d）；
    // deepseek-v4-flash/pro：1048576（1M）。
    // 其余模型（GLM-5/openpangu-*）未公开容量，context 应为 undefined。
    const adapter = makeAdapter()
    const glm52 = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(glm52.context).toEqual({ contextWindow: 202752 })
    const glm53flash = await adapter.resolveModel('codearts', 'glm-5.3-flash')
    expect(glm53flash.context).toEqual({ contextWindow: 1_048_576 })
    const dsFlash = await adapter.resolveModel('codearts', 'deepseek-v4-flash')
    expect(dsFlash.context).toEqual({ contextWindow: 1048576 })
    const dsPro = await adapter.resolveModel('codearts', 'deepseek-v4-pro')
    expect(dsPro.context).toEqual({ contextWindow: 1048576 })
    const pangu = await adapter.resolveModel('codearts', 'openpangu-2.0-pro')
    expect(pangu.context).toBeUndefined()
  })

  /**
   * 静态兜底表的两项追加（远端不可用时才生效）。
   *
   * - `GLM-5.1`：IDE 内置 KERNEL_MODELS 硬证据 202752；
   * - `glm-5.2-sft-harmony`：GLM-5.2 系的变体，按同一口径推断。
   *
   * ⚠️ `openpangu-2.0-flash` / `openpangu-2.0-pro` / `GLM-5` **刻意不补** ——
   * 三方（IDE 模型卡、内置 KERNEL_MODELS、远端目录）都没有窗口旁证，编造一个
   * 数字会直接改写宿主的压缩时机。
   */
  it('static fallback covers GLM-5.1 and glm-5.2-sft-harmony, and deliberately omits the unsubstantiated trio', async () => {
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('codearts', 'GLM-5.1')).context).toEqual({ contextWindow: 202752 })
    expect((await adapter.resolveModel('codearts', 'glm-5.2-sft-harmony')).context).toEqual({ contextWindow: 202752 })
    expect((await adapter.resolveModel('codearts', 'GLM-5')).context).toBeUndefined()
    expect((await adapter.resolveModel('codearts', 'openpangu-2.0-flash')).context).toBeUndefined()
    expect((await adapter.resolveModel('codearts', 'openpangu-2.0-pro')).context).toBeUndefined()
  })

  /**
   * 远端窗口接线：远端目录下发的 `context_window` **优先于**静态表。
   * 用与静态值不同的数字，确保断言命中的是远端而不是兜底。
   */
  it('prefers the remote context_window over the static fallback', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 999_999 },
        { id: 'GLM-5.1', name: 'GLM-5.1', contextWindow: 123_456 },
      ],
    })
    expect((await adapter.resolveModel('codearts', 'GLM-5.2')).context).toEqual({ contextWindow: 999_999 })
    expect((await adapter.resolveModel('codearts', 'GLM-5.1')).context).toEqual({ contextWindow: 123_456 })
  })

  /**
   * 回退语义（本修复的硬约束）：**远端字段缺失 / 目录整体失败时，声明值的来源
   * 必须原样回到静态表** —— 网络抖动不该改变声明的窗口。
   */
  it('falls back to the static table when the remote entry omits context_window', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'GLM-5.1', name: 'GLM-5.1' },
      ],
    })
    expect((await adapter.resolveModel('codearts', 'GLM-5.2')).context).toEqual({ contextWindow: 202752 })
    expect((await adapter.resolveModel('codearts', 'GLM-5.1')).context).toEqual({ contextWindow: 202752 })
  })

  it('falls back to the static table when the remote catalog fails outright', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    expect((await adapter.resolveModel('codearts', 'GLM-5.2')).context).toEqual({ contextWindow: 202752 })
    expect((await adapter.resolveModel('codearts', 'deepseek-v4-pro')).context).toEqual({ contextWindow: 1048576 })
    // 静态表也没有的模型：仍然不声明，不因远端失败而编造。
    expect((await adapter.resolveModel('codearts', 'openpangu-2.0-pro')).context).toBeUndefined()
  })

  it('falls back to the static table when the remote catalog comes back empty', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => [] })
    expect((await adapter.resolveModel('codearts', 'GLM-5.2')).context).toEqual({ contextWindow: 202752 })
  })

  /**
   * id 归一回归：远端下发的是带日期后缀的 `deepseek-v4-flash-0731`，解析层已
   * 归一为 `deepseek-v4-flash`（选择器播报的也正是归一后的 id），故窗口能按
   * 归一后的 id 命中 —— 此处**不引入新的模糊匹配**，靠的是既有归一语义。
   */
  it('matches the remote context_window through the existing date-suffix normalization', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 1_048_576 },
      ],
    })
    const resolved = await adapter.resolveModel('codearts', 'deepseek-v4-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
    // 带后缀的原始 id 不作为路由 id（既有语义：后端未注册该 id）。
    expect((await adapter.resolveModel('codearts', 'deepseek-v4-flash-0731')).context).toBeUndefined()
  })

  it('does not invent a context window for a remote-only model that discloses none', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'brand-new-model', name: 'Brand New' }],
    })
    expect((await adapter.resolveModel('codearts', 'brand-new-model')).context).toBeUndefined()
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('prepareCall resolves the model and binds its stream', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('codearts', 'GLM-5.2')
    expect(call.model).toMatchObject({
      provider: 'codearts',
      id: 'GLM-5.2',
      context: { contextWindow: 202752 },
      inputModalities: ['text'],
    })
    expect(typeof call.stream).toBe('function')
  })

  it('streams text deltas from an OpenAI-compatible SSE response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks).toEqual(['hi', ' there'])
  })

  it('refreshes an expired credential before streaming and signs the request', async () => {
    let refreshed = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(String(input)).toBe(`${CHAT_API_BASE}/chat/completions`)
      expect(headers.get('Authorization')).toMatch(/^SDK-HMAC-SHA256 Access=AK/)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(headers.get('Chat-Id')).toBeTruthy()
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      credential: { ...validCredential, expires_at: '2020-01-01T00:00:00Z' },
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['ok'])
  })

  it('listModels advertises glm-5.3-flash with the GLM family', async () => {
    // 对齐 deveco-code-rust 90aeb17d：CodeArts Agent 后端新增 GLM-5.3 Flash
    // （benefit 免费额度模型，后端注册 id 为全小写 glm-5.3-flash）。
    const models = await makeAdapter().listModels('codearts')
    expect(models.map((model) => model.id)).toContain('glm-5.3-flash')
    // 默认模型仍是 GLM-5.2（新增模型不应改变默认模型）。
    expect(models[0]!.id).toBe('GLM-5.2')
  })

  it('signs glm-5.3-flash requests with the maas_type: benefit header', async () => {
    // glm-5.3-flash 是 benefit（免费额度）模型：maas_type: benefit 必须
    // 参与 SDK-HMAC-SHA256 签名并随请求发送，否则后端返回
    // InferHub.002002009.404 "model is not registered"。
    // （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('maas_type')).toBe('benefit')
      const auth = headers.get('Authorization') ?? ''
      expect(auth).toContain('maas_type')
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream({ ...streamOptions, model: 'glm-5.3-flash' } as never)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['ok'])
  })

  it('does not send maas_type for other models', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('maas_type')).toBeNull()
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('refreshes the credential once when the chat request fails with APIG.0602 and retries successfully', async () => {
    // CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
    // APIG.0602 "Invalid token"。入口的 expires_at 预判无法覆盖后端提前
    // 吊销或时钟偏差，stream() 应在收到该错误后触发一次静默 refresh，
    // 用新凭据重试 chat 请求；最多 refresh 一次，避免死循环。
    let refreshed = false
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      if (chatCalls === 1) {
        return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
      }
      // 第二次请求在 refresh 后发出，应使用刷新后的凭据（makeAdapter 的
      // refresh() 会把 credential 恢复为 validCredential）。
      const headers = new Headers(init?.headers)
      expect(headers.get('x-security-token')).toBe('ST')
      expect(refreshed).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshed = true },
      fetchImpl,
    })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(chatCalls).toBe(2)
    expect(refreshed).toBe(true)
    expect(texts).toEqual(['recovered'])
  })

  it('does not refresh more than once on repeated auth errors', async () => {
    // 连续两次 APIG.0602：第一次触发 refresh+重试，第二次仍失败应直接抛 AUTH，
    // 不再刷新，避免死循环。
    let refreshCount = 0
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
      }
      chatCalls += 1
      return new Response(JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' }), { status: 401 })
    })
    const adapter = makeAdapter({
      refresh: async () => { refreshCount += 1 },
      fetchImpl,
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
    expect(chatCalls).toBe(2)
    expect(refreshCount).toBe(1)
  })

  it('throws MISSING_CREDENTIAL when no credential is available', async () => {
    // 直接构建适配器：makeAdapter 的 refresh() 会恢复
    // 有效凭据，因此"刷新后仍无凭据"需要用原始适配器。
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('normalizes a non-2xx response to an LlmError', async () => {
    const adapter = makeAdapter({ fetchImpl: async () => new Response('nope', { status: 500 }) })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toBeInstanceOf(LlmError)
  })

  it('retries the chat request after a queue error even when the queue status is working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求，不轮询等待
    // working。状态端点仅在每次重试前查一次（此处 working 非终态，
    // 不抛错），等待 10s 后重试 chat 成功。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'working', queue_position: 1, message: 'admitted' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // 第一次 chat 调用被并发上限限流。
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"queued-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['queued-ok'])
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('directly retries the chat request while queued instead of waiting for working', async () => {
    // 对齐参考实现 runner.rs：排队时直接重试 chat 请求（10s 一次），
    // 不轮询等待状态端点 working。状态端点仅在每次重试前查一次，
    // 用于检测终态（error/queue_full）提前抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"finally"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['finally'])
    expect(calls.chat).toBe(2)
    // 排队中不轮询状态端点：仅重试前查一次。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('retries the chat request when the SSE stream carries the TPM limit error (81111.429)', async () => {
    // CodeArts 以 HTTP 200 + SSE 内嵌 error_code 返回 TPM 限流
    // （InferHub.ModelArts.81111.429），而非 4xx。适配器必须把它当成排队
    // 处理（延迟后重试 chat），而不是静默当成 [DONE] 流结束吞掉——否则
    // 用户看到"思考后无输出"。本用例：第一次请求 SSE 返回该错误，重试后
    // 第二次返回正常文本。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        // HTTP 200 + SSE 内嵌排队/限流错误（e2e 实测的真实响应形态）。
        return new Response(
          'data:{"text":"[DONE]","error_code":"InferHub.ModelArts.81111.429","error_msg":"The model TPM limit has been significantly exceeded. Please reduce the request rate and retry later."}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 81111.429 被识别为排队错误：重试 chat 后成功输出正文。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(1)
    // 排队/限流期间零产出：只有重试成功后的正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('emits no content blocks while waiting for queue admission', async () => {
    // 排队期间适配器不得产出任何内容块：StreamChunk 协议没有瞬态状态通道，
    // reasoning/text 块都会被组装进 assistant 消息并持久化（reasoning 还会
    // 显示在 web 的 Think 区域，visible 回退可能把推理文本回传给模型），
    // 因此排队提示既不显示也不留痕，web 显示 harness 自身的"运行中"状态。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        return new Response(
          JSON.stringify({ status: 'waiting', queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const blocks: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-start') blocks.push(chunk.blockType)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 排队期间零产出：放行后只有正文文本块。
    expect(blocks).toEqual(['text'])
    expect(texts).toEqual(['admitted-ok'])
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('never leaks queue notices into the visible text fallback when the model returns reasoning only', async () => {
    // GLM 特性：模型可能只返回 reasoning_content 而 content 为空，适配器
    // 回退把推理作为可见文本。排队提示必须被排除在该回退之外——否则排队
    // 文本会作为正文持久化并在后续调用中作为上下文发送给模型。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue === 1 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限(3个)，请关闭部分会话后重试。' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"real-reasoning"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textEnds: string[] = []
    const reasoningEnds: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') textEnds.push(chunk.block.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') reasoningEnds.push(chunk.block.text)
    }
    // 可见文本回退只包含模型真实推理；排队期间零产出，故绝无"排队中"字样。
    expect(textEnds.some(text => text.includes('排队中'))).toBe(false)
    expect(textEnds).toEqual(['real-reasoning'])
    // reasoning 块只有模型真实推理，不持久化任何排队文本。
    expect(reasoningEnds.every(text => !text.includes('排队中'))).toBe(true)
    expect(calls.chat).toBe(2)
    // 排队中只重试前查一次状态端点（终态检测），不轮询等待 working。
    expect(calls.queue).toBe(1)
  }, 30_000)

  it('enters the queue path for non-TM.00001041 errors when the queue endpoint reports waiting (openpangu)', async () => {
    // openpangu 等模型的并发限流错误码/HTTP 状态可能与 GLM 的
    // TM.00001041 不同（例如 HTTP 429 + 其他错误码），但只要排队状态
    // 端点确认会话在排队，适配器就必须进入排队逻辑而不是立即抛错。
    const calls = { chat: 0, queue: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        calls.queue += 1
        const status = calls.queue <= 2 ? 'waiting' : 'working'
        return new Response(
          JSON.stringify({ status, queue_position: calls.queue, message: 'queue status' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      calls.chat += 1
      if (calls.chat === 1) {
        return new Response(
          JSON.stringify({ error_code: 'TM.00001042', error_msg: '并发请求过多，请稍后重试。' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"admitted-ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const reasoning: string[] = []
    const texts: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    // 探测一次（确认排队）+ 重试前查一次状态端点（终态检测），重试 chat 成功。
    expect(calls.chat).toBe(2)
    expect(calls.queue).toBe(2)
    // 排队期间零产出：不放行后正文之前没有任何块（无"排队中"字样）。
    expect(reasoning).toEqual([])
    expect(texts).toEqual(['admitted-ok'])
  }, 30_000)

  it('surfaces the queue error message when the queue status is terminal', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(QUEUE_STATUS_BASE)) {
        return new Response(
          JSON.stringify({ status: 'error', queue_position: -1, message: 'peak hours, try later' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ error_code: 'TM.00001041', error_msg: '并发会话数已达上限' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toThrow(/peak hours, try later/)
  })

  it('throws a normal HTTP error when the failure is not a queue error', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error_code: 'OTHER', error_msg: 'bad request' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    await expect(async () => {
      for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('translates tool_calls deltas into tool-call blocks so the harness can run them', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const seen: string[] = []
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      seen.push(chunk.type)
      if (chunk.type === 'tool-call-delta') {
        expect(chunk.id).toBe('call-1')
        expect(chunk.name).toBe('bash')
        expect(chunk.argumentsDelta).toContain('ls')
      }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  // 回归：tool_stream 分段传输时，参数续分片会带回 `"function":{"name":""}`。
  // 空串不是 undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出
  // 的真实工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on tool_calls argument continuation fragments', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":""}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    let toolCallBlock: { type: 'tool-call'; id: string; name: string; arguments: string } | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'tool-call-delta') expect(chunk.name).toBe('bash')
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCallBlock = chunk.block
    }
    expect(toolCallBlock).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'bash' })
    expect(JSON.parse(toolCallBlock!.arguments)).toEqual({ command: 'ls -la' })
  })

  it('serializes harness tool schemas into the request tools field', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
        tool_stream?: boolean
      }
      expect(sent.model).toBe('GLM-5.2')
      // 对齐 CodeArts Agent IDE：tool_stream=true 让后端对超大工具
      // 调用参数（如大文件 file_write）分段流式传输，避免单次 SSE 事件
      // 过大导致连接被掐断（error decoding response body）。
      expect(sent.tool_stream).toBe(true)
      expect(sent.tools).toEqual([{
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      }])
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [],
      tools: [{
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('hides vision-only (VL) models from listModels so they cannot be used as the agent model', async () => {
    // VL 多模态模型（如 Qwen3-VL-235B）上下文小、不支持工具调用，不适合当
    // agent 主模型，从模型列表屏蔽。它们只通过 analyzeImage 工具间接调用。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
        { id: 'Qwen3.6-27B-VL', name: 'Qwen3.6-27B-VL' },
        { id: 'Qwen3.5-397B-A17B-VL', name: 'Qwen3.5-397B-A17B-VL' },
      ],
    })
    const models = await adapter.listModels('codearts')
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('Qwen3.6-27B-VL')
    expect(ids).not.toContain('Qwen3.5-397B-A17B-VL')
    // 普通模型不受影响。
    expect(ids).toContain('GLM-5.2')
  })

  it('filters VL models case-insensitively from listModels (lowercase kimi-k2.6-vl)', async () => {
    // 真机实测（2026-09-23）：远端 builtinModels 下发小写 `kimi-k2.6-vl`，
    // 只匹配大写 -VL- 会让它漏过滤混进目录。大小写都要滤掉。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'kimi-k2.6-vl', name: 'kimi-k2.6-vl' },
        { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
        { id: 'GLM-5.2', name: 'GLM-5.2' },
      ],
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).not.toContain('kimi-k2.6-vl')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).toContain('GLM-5.2')
    // listAllModels（设置页「显示列表」）共用同一份 VL 可见性过滤。
    const allIds = adapter.listAllModels().map((m) => m.id)
    expect(allIds).not.toContain('kimi-k2.6-vl')
    expect(allIds).not.toContain('Qwen3-VL-235B')
  })

  /**
   * 模型黑名单：Account Hub 的「显示列表」开关关闭某模型后，它必须从
   * listModels 的播报里消失 —— 对话框模型选择器读的正是这份数据。
   */
  it('hides models the user disabled from listModels', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'GLM-5.2', name: 'GLM-5.2' },
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'openpangu-2.0-pro', name: 'openpangu-2.0-pro' },
      ],
      accountPool: poolWithDisabled('codearts', ['GLM-5.2']),
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).not.toContain('GLM-5.2')
    // 未关闭的模型保持原样与原有顺序
    expect(ids).toEqual(['deepseek-v4-flash', 'openpangu-2.0-pro'])
  })

  it('an empty disabled set leaves listModels untouched', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', []) })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('deepseek-v4-flash')
  })

  it('blacklist is keyed by provider: another route\'s entries do not leak in', async () => {
    // 池里只有 buddy 的黑名单，codearts 路由不该被它影响
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy-cn', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).toContain('GLM-5.2')
  })

  it('a disabled model still resolves and remains requestable (catalog is advisory)', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('codearts', ['GLM-5.2']) })
    expect((await adapter.listModels('codearts')).map((m) => m.id)).not.toContain('GLM-5.2')
    // DSH 契约：listModels 的结果仅供参考，缺省不构成请求拒绝。
    const resolved = await adapter.resolveModel('codearts', 'GLM-5.2')
    expect(resolved.id).toBe('GLM-5.2')
    expect(resolved.context?.contextWindow).toBe(202752)
  })

  it('switches deepseek-v4 to DSML tool mode: no tools field, schema injected into system', async () => {
    // deepseek-v4 大文件写入修复（实测 2026-08-22）：标准 tool_calls 参数
    // 一次性打包生成，SSE 静默 >60s 被 APIG 网关掐断且后端不发心跳；
    // 当工具列表含大参数写文件类工具（write）时改为不发送 tools 字段、
    // 把 function schema 注入 system 提示，让模型以原生 DSML 流式输出
    // 工具调用（delta.content 走流式通道，全程有数据）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // deepseek-v4 的 DSML 工具模式下不得发送 tools 字段（发送会触发
      // 标准 tool_calls 一次性打包路径）。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      const system = wire.find(message => message.role === 'system') as Record<string, unknown> | undefined
      // DSML 指令 + 工具 schema 注入 system 消息。
      expect(system?.content).toContain('DSML')
      expect(system?.content).toContain('工具名')
      expect(String(system?.content)).toContain('write')
      expect(String(system?.content)).toContain('Write content to a file')
      // harness 原始 user 消息保留在 system 之后。
      expect(wire.some(message => message.role === 'user')).toBe(true)
      // 模型以 DSML 格式输出工具调用，适配器解析为结构化 tool-call。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
  })

  it('mints a unique callId for DSML tool calls so harness pairing and web UI work', async () => {
    // DSML 语法没有 provider 签发的 call id。空 id 会让同一响应的多个
    // 工具调用（tool/call ↔ tool/result 配对、web UI 工具行 key）冲突，
    // UI 只能回退为泛化的 "Tool call" 而丢失 read/write 专属控件。
    // 适配器必须为每个 DSML 调用生成非空且互不相同的 callId。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '<｜DSML｜invoke name="write"><｜DSML｜parameter name="filePath" string="true">/tmp/b.ts</｜DSML｜parameter><｜DSML｜parameter name="content" string="true">x</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const deltas: Array<{ id: string; name?: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'do both' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'tool-call-delta') {
        deltas.push({ id: String(chunk.id), ...chunk.name !== undefined ? { name: chunk.name } : {} })
      }
    }
    expect(deltas).toHaveLength(2)
    // 两个 DSML 调用的 callId 非空且互不相同。
    expect(deltas[0].id).not.toBe('')
    expect(deltas[1].id).not.toBe('')
    expect(deltas[0].id).not.toBe(deltas[1].id)
    expect(deltas.map(d => d.name)).toEqual(['read', 'write'])
  })

  it('parses DSML tool calls embedded in reasoning_content (deepseek-v4 quirk)', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 有时把完整回答（含 DSML 块）输出在
    // reasoning_content 而 content 为空。旧实现把 reasoning_content 直接追加
    // 到 reasoning 块、从不走 DSML 提取器，导致 DSML 块被当推理文本吞掉
    // （任务 completed 但工具未执行，text 与 reasoning 内容重复）。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="write">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="content" string="true">export const x = 1;</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      // 模型把正文+DSML 全放在 reasoning_content。
      const reasoning = '用户要求写入文件，我需要调用 write 工具。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{
        name: 'write',
        description: 'Write content to a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute file path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['filePath', 'content'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('write')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts', content: 'export const x = 1;' })
    expect(finishKind).toBe('tool-calls')
    // reasoning_content 中的 DSML 已解析为工具调用，不再泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('routes reasoning_content thinking into the reasoning block, never the text body', async () => {
    // 实测 2026-08-22：deepseek-v4-flash 的 reasoning_content 通常没有
    // <thought> 标签（如 "The user wants me to:..."）。旧实现把提取器返回
    // 的 `text`（开标签前思考）发给正文块，导致思考泄漏到 TUI 正文
    // （The user wants me to... 跑到正文、没有 Think）。修复后
    // reasoning_content 的 text+reasoning 必须全部进入 reasoning 块。
    const fetchImpl = vi.fn(async () => {
      // 模型把思考（无 <thought> 标签）+ DSML 工具调用全放 reasoning_content。
      const reasoning = 'The user wants me to read the file and write it.\nLet me do that step by step.'
        + '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read and write a file' }],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } },
        { name: 'write', description: 'Write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name })
      }
    }
    // 思考进入 Think 区域。
    const reasoningText = reasoningDeltas.join('')
    expect(reasoningText).toContain('The user wants me to read the file')
    expect(reasoningText).toContain('Let me do that step by step.')
    // 正文不泄漏思考。
    expect(textDeltas.join('')).not.toContain('The user wants me')
    // DSML 工具调用正常解析。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
  })

  it('parses DSML in reasoning_content even when content channel has an unclosed <thought> (independent extractors)', async () => {
    // 回归 session-067dcf78 turn1 step13 / turn2 step3：deepseek-v4 在
    // content 通道输出 <thought> 开标签（提取器进入 in-thought 状态）后，
    // 把推理与完整 DSML 工具调用写到 reasoning_content 通道。旧实现共用
    // 单个 DSML 提取器，content 的 <thought> 污染提取器状态为 in-thought，
    // reasoning_content 的 DSML 块被当作 thought 内容吞掉、不解析为
    // tool-call，残留 DSML 标签经 visible 回退泄漏到正文 text 块
    // （reasoning 与 text 内容完全相同、均含 <｜DSML｜...>，任务中断）。
    // 修复后 content 与 reasoning_content 使用独立提取器，互不污染。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls>'
        + '<｜DSML｜invoke name="read"><｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter></｜DSML｜invoke>'
        + '</｜DSML｜tool_calls>'
      // content 通道：<thought> 开标签 + 思考片段，无闭标签（提取器进入 in-thought）。
      const content = '<thought>用户要求读取文件，我需要调用 read 工具。'
      // reasoning_content 通道：推理 + 完整 DSML 块。
      const reasoning = '让我先读取文件内容。\n' + dsml
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(content)},"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const textDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // reasoning_content 的 DSML 块被独立提取器解析为 tool-call。
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
    expect(finishKind).toBe('tool-calls')
    // DSML 标签不泄漏到正文。
    expect(textDeltas.join('')).not.toContain('DSML')
    expect(textDeltas.join('')).not.toContain('<｜DSML｜')
  })

  it('does not leak DSML tags from reasoning to text via visible fallback (reasoning references DSML syntax)', async () => {
    // 回归 session-a69fa289 turn2 step26：deepseek-v4 在推理中引用 DSML 语法
    // （仅含闭合标签片段，非完整工具调用块），提取器正确不解析（无开标签），
    // 整段作为 reasoning。但 visible 回退把含 DSML 标签的推理复制到正文，
    // 导致 DSML 标签泄漏到正文、任务终止。修复后 visible 回退检查推理是否
    // 含 DSML 标签，含则不复制为正文（推理仍在 Think 区域可见）。
    const fetchImpl = vi.fn(async () => {
      const reasoning = 'Let me read protocol/mod.rs to see the current SseTimeoutConfig.\n'
        + '</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"reasoning_content":${JSON.stringify(reasoning)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    let finishKind: string | undefined
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'continue' }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 推理在 Think 区域可见。
    expect(reasoningDeltas.join('')).toContain('SseTimeoutConfig')
    // DSML 标签不泄漏到正文（visible 回退不复制含 DSML 标签的推理）。
    expect(textDeltas.join('')).toBe('')
    expect(finishKind).toBe('stop')
  })

  it('coerces numeric-looking DSML string params (offset="1304") to number', async () => {
    // 实测 2026-08-22：deepseek-v4 对 read 的 offset 误标 string="true"，
    // 输出 offset="1304"。旧实现保持字符串，工具 schema 校验报
    // `"offset" must be a number`。修复后数字字面量字符串按原始类型解析。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">1304</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">2000</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    // 数字字符串参数被转换为 number。
    expect(args.offset).toBe(1304)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(2000)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML string params (offset string="true" value "840", pro quirk) to number', async () => {
    // 实测 deepseek-v4-pro：pro 模型常把数字参数值用 JSON 字符串引号包裹
    // 输出（如 "840"），即便标记了 string="true"。旧实现 tryParseScalar
    // 不处理带引号的字面量——"840"（含引号字符）不匹配数字正则、保持
    // 字符串，schema 校验报 "offset" must be a number。flash 输出纯数字
    // 不带引号故不受影响，这是 pro 出错多、flash 不出错的根因。修复后
    // tryParseScalar 先 JSON.parse 解码外层引号再递归标量转换。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset" string="true">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit" string="true">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.filePath).toBe('/tmp/big.ts')
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces quoted numeric DSML params without string attr (pro quirk) to number', async () => {
    // deepseek-v4-pro 另一种形态：数字参数不加 string="true"，但值仍用
    // JSON 字符串引号包裹（"840"）。走非 string 路径 JSON.parse('"840"')
    // 得到字符串 "840"，旧实现直接使用导致 schema 校验失败。修复后非
    // string 路径对 JSON.parse 得到的字符串结果再走 tryParseScalar 还原。
    const fetchImpl = vi.fn(async () => {
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/big.ts</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="offset">"840"</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="limit">"40"</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read big file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { filePath: string; offset: number; limit: number }
    expect(args.offset).toBe(840)
    expect(typeof args.offset).toBe('number')
    expect(args.limit).toBe(40)
    expect(typeof args.limit).toBe('number')
  })

  it('coerces array-looking DSML string params (todos string="true") to array', async () => {
    // 实测 session-59e52486 turn1 step3：deepseek-v4 对 todo_write 的 todos
    // 数组参数误标 string="true"，把 JSON 编码的数组当作字符串输出。旧实现
    // tryParseScalar 只解析 number/boolean/null 标量，不解析 JSON 数组，
    // todos 保持字符串，工具 schema 校验报 `"todos" must be an array`。
    // 修复后 tryParseScalar 对 [ / { 开头的合法 JSON 还原为原始类型。
    const todosJson = JSON.stringify([
      { content: '了解项目结构', status: 'in_progress' },
    ])
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="todo_write">'
      + `<｜DSML｜parameter name="todos" string="true">${todosJson}</｜DSML｜parameter>`
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'plan the work' }],
      tools: [{
        name: 'todo_write',
        description: 'Write a todo list',
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
              },
            },
          },
          required: ['todos'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    const args = JSON.parse(toolCallBlocks[0].arguments) as { todos: unknown }
    // todos 被还原为数组，而非保持字符串。
    expect(Array.isArray(args.todos)).toBe(true)
    expect(args.todos).toEqual([
      { content: '了解项目结构', status: 'in_progress' },
    ])
  })

  it('forwards GenerateOptions.system as a system message (session title fix)', async () => {
    // 标题生成等辅助请求通过 GenerateOptions.system 传入系统提示。旧实现
    // 丢弃了 options.system，模型只看到 user prompt 本身，于是把
    // "Generate the session title from this JSON array..." 回显成标题
    // （实测 2026-08-22：session 标题显示为 prompt 文本）。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>
      }
      const systems = (sent.messages ?? []).filter(m => m.role === 'system')
      expect(systems).toHaveLength(1)
      expect(systems[0].content).toContain('Create a concise title')
      return new Response(
        'data: {"choices":[{"delta":{"content":"Fix DSML parsing"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const texts: string[] = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[...]' }],
      system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line.',
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('Fix DSML parsing')
  })

  it('switches deepseek-v4 to DSML tool mode even with small-parameter-only tools (read/bash)', async () => {
    // deepseek-v4 模型始终走 DSML 模式（不论工具列表）：标准 tool_calls 模式下
    // `subagent` 工具的长 prompt 参数生成期间 SSE 无数据，APIG 网关 ~60s 空闲超时
    // 必然掐断连接。DSML 模式让工具调用通过 delta.content 流式输出，全程有数据流。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        model?: string
        tools?: unknown[]
        messages?: Array<Record<string, unknown>>
      }
      expect(sent.model).toBe('deepseek-v4-flash')
      // DSML 模式：不发送 tools 字段（对齐 IDE 请求体），schema 注入 system 消息。
      expect(sent.tools).toBeUndefined()
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'system' && typeof message.content === 'string'
        && message.content.includes('<｜DSML｜tool_calls>'))).toBe(true)
      // 模型以 DSML 格式输出，适配器从 delta.content 解析。
      const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="read">'
        + '<｜DSML｜parameter name="filePath" string="true">/tmp/a.ts</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>'
      return new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [{
        name: 'read',
        description: 'Read a file at the given path.',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Absolute file path' } },
          required: ['filePath'],
        },
      }],
      signal: new AbortController().signal,
    } as never
    for await (const chunk of adapter.stream(opts)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('read')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ filePath: '/tmp/a.ts' })
  })

  it('replays assistant tool_calls and tool results back to the model', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      // 助手消息携带其 tool_calls；随后用户消息的
      // tool-result 块展开为 role:'tool' 传输消息。
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toEqual([{
        id: 'call-9',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }])
      const tool = wire.find(message => message.role === 'tool') as Record<string, unknown> | undefined
      expect(tool?.tool_call_id).toBe('call-9')
      expect(tool?.content).toContain('src/')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call-9', content: [{ type: 'text', text: 'src/ lib/' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  // 回归（严重）：工具执行失败时 assistant 的 tool_calls 留在会话历史里，
  // 但结果消息从未写回——形成孤儿 tool_calls。坏历史随每次请求重放，后端
  // 对之后**每一条**用户消息都返回 400，表现为"任务中断后发送任何内容都
  // 没有回复"。适配器必须在发出请求前剔除。
  it('drops orphan tool_calls that never received a tool result', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const assistant = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(assistant?.tool_calls).toBeUndefined()
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call-9', name: 'bash', arguments: '{"command":"ls"}' },
        ] },
        // 工具执行失败，没有对应的 tool-result 写回历史。
        { role: 'user', content: 'continue' },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('drops orphan tool result messages with no matching tool_call', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      expect(wire.some(message => message.role === 'tool')).toBe(false)
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'GLM-5.2',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] },
        ] },
      ],
      tools: [{ name: 'bash', description: 'Run a shell command', parameters: {} }],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('replays assistant reasoning blocks as reasoning_content for the model', async () => {
    // deepseek-v4 等推理模型后端校验：回传历史时 assistant 消息必须携带
    // reasoning_content 字段，缺失会 400 "Missing `reasoning_content` field"。
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<Record<string, unknown>>
      }
      const wire = sent.messages ?? []
      const first = wire.find(message => message.role === 'assistant') as Record<string, unknown> | undefined
      expect(first?.content).toBe('visible-answer')
      expect(first?.reasoning_content).toBe('hidden-thought')
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = makeAdapter({ fetchImpl })
    const opts = {
      provider: 'codearts',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'summarize' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'hidden-thought' },
          { type: 'text', text: 'visible-answer' },
        ] },
      ],
      signal: new AbortController().signal,
    } as never
    for await (const _ of adapter.stream(opts)) { /* drain */ }
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('classifies an SSE transport "terminated" error as retryable TRANSPORT, not UNKNOWN', async () => {
    // CodeArts 网关在 SSE 空闲 ~60s 后掐断连接，Node undici reader.read() 抛
    // TypeError: terminated。该错误非 HarnessError，会被归为 UNKNOWN（不可重试）
    // 导致 harness 直接失败。适配器须把它映射为可重试的 TRANSPORT。
    let pullCalls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 第一次 pull：发送一个 chunk；第二次 pull（数据已被消费后）让流
        // error 模拟对端掐断。用计数器确保先消费再 error。
        pullCalls++
        if (pullCalls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        } else {
          controller.error(new TypeError('terminated'))
        }
      },
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const adapter = makeAdapter({ fetchImpl })
    const chunks: string[] = []
    let caught: LlmError | undefined
    try {
      for await (const chunk of adapter.stream(streamOptions)) {
        if (chunk.type === 'text-delta') chunks.push(chunk.text)
      }
    } catch (error) {
      if (error instanceof LlmError) caught = error
    }
    expect(chunks).toEqual(['hi'])
    expect(caught?.code).toBe('TRANSPORT')
  })

  it('reports a retryable TIMEOUT when the SSE stream goes idle beyond the chunk threshold', async () => {
    // 模型生成长推理时两次 chunk 间静默超过 chunk 超时窗口：适配器应主动以
    // 可重试 TIMEOUT 失败（而非被动等网关掐断后变成 UNKNOWN）。
    // 用短超时环境变量避免真实等待 600s。
    const prev = process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          // 永不发送更多数据——触发空闲超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      const chunks: string[] = []
      let caught: LlmError | undefined
      try {
        for await (const chunk of adapter.stream(streamOptions)) {
          if (chunk.type === 'text-delta') chunks.push(chunk.text)
        }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(chunks).toEqual(['hi'])
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('chunk timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('reports a retryable TIMEOUT when no first token arrives in time', async () => {
    // 首 token 超时：连接建立后模型长时间不输出任何数据（如排队中、
    // 模型冷启动）。适配器应以可重试 TIMEOUT 失败，phase=first-token。
    const prev = process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
    process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = '200'
    try {
      const body = new ReadableStream<Uint8Array>({
        start() {
          // 永不 enqueue 任何数据——触发首 token 超时
        },
      })
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      const adapter = makeAdapter({ fetchImpl })
      let caught: LlmError | undefined
      try {
        for await (const _ of adapter.stream(streamOptions)) { /* drain */ }
      } catch (error) {
        if (error instanceof LlmError) caught = error
      }
      expect(caught?.code).toBe('TIMEOUT')
      expect(caught?.message).toContain('first-token timeout')
    } finally {
      if (prev === undefined) delete process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS
      else process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS = prev
    }
  }, 10_000)

  it('extracts DSML tool_calls embedded in delta.content into structured tool-call blocks', async () => {
    // 某些模型（如 deepseek-v4）在工具模式不匹配时会把工具调用以原生
    // DSML XML 风格直接写入 delta.content，适配器须识别并解析为结构化
    // tool-call，避免原始 <｜DSML｜...> token 泄漏到 web UI。
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '<｜DSML｜parameter name="description" string="true">list files</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // DSML 内容不应作为文本泄漏
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls', description: 'list files' })
    expect(finishKind).toBe('tool-calls')
  })

  it('extracts DSML tool_calls streamed across multiple chunks', async () => {
    // DSML 块可能跨多个 SSE chunk 分片到达，提取器须缓冲未完成部分
    // 直到闭标签到达才解析，期间不产出任何文本。
    const parts = [
      '<｜DSML｜tool_calls><｜DSML｜invoke name="pwsh">',
      '<｜DSML｜parameter name="command" string="true">ls "D:\\hub"',
      '</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe('')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('pwsh')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls "D:\\hub"' })
  })

  it('passes through plain text alongside DSML tool_calls', async () => {
    // 模型可能在同一段输出中先写普通文本再写 DSML 工具调用，
    // 提取器须放行文本部分并解析 DSML 部分。
    const text = '查看providers目录\n'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(text + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
    }
    expect(textDeltas.join('')).toBe(text)
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
  })

  it('flushes incomplete DSML as text when the stream ends without a closing tag', async () => {
    // 若模型输出被 max_tokens 截断，DSML 块可能不完整（无闭标签）。
    // 提取器 flush() 须把残留作为纯文本放行，避免吞掉内容；同时
    // finish_reason='length' 路径触发 harness max-tokens 续写。
    const incomplete = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incomplete)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    // 不完整 DSML 作为文本放行（用户可见），finish 报 max-tokens 触发续写
    expect(textDeltas.join('')).toBe(incomplete)
    expect(finishKind).toBe('max-tokens')
  })

  it('extracts <thought> blocks as reasoning instead of leaking to visible text', async () => {
    // DeepSeek-V4 Thinking 模式：模型把推理过程包裹在 <thought>...</thought>
    // 中写入 delta.content。适配器须把 <thought> 内容作为 reasoning-delta
    // 输出（显示在 Think 区域），而非作为 text-delta 泄漏到正文。
    const thought = '<thought>我需要先查看目录结构，再决定如何操作。</thought>'
    const visible = '查看完成，开始操作。'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + visible)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // <thought> 内容作为 reasoning 输出，不泄漏到正文
    expect(textDeltas.join('')).toBe(visible)
    expect(reasoningDeltas.join('')).toBe('我需要先查看目录结构，再决定如何操作。')
  })

  it('streams <thought> reasoning incrementally across multiple chunks', async () => {
    // <thought> 块跨多个 SSE chunk 分片到达，提取器须流式输出 reasoning
    // 增量（与 delta.reasoning_content 行为一致），不等到块结束才输出。
    const parts = [
      '<thought>第一步：分析需求',
      '。第二步：制定计划。',
      '</thought>开始执行。',
    ]
    const sse = parts.map(p => `data: {"choices":[{"delta":{"content":${JSON.stringify(p)}}}]}\n\n`).join('')
      + 'data: [DONE]\n\n'
    const fetchImpl = vi.fn(async () => new Response(
      sse,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    expect(textDeltas.join('')).toBe('开始执行。')
    expect(reasoningDeltas.join('')).toBe('第一步：分析需求。第二步：制定计划。')
  })

  it('handles <thought> followed by DSML tool_calls in the same content stream', async () => {
    // Thinking 模式 + 工具调用：模型先输出 <thought> 推理，再输出
    // DSML tool_calls。适配器须分别路由到 reasoning 和 tool-call 块。
    const thought = '<thought>需要列出目录内容。</thought>'
    const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">'
      + '<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(thought + dsml)}}}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolCallBlocks: Array<{ name: string; arguments: string }> = []
    let finishKind: string | undefined
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallBlocks.push({ name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('需要列出目录内容。')
    expect(toolCallBlocks).toHaveLength(1)
    expect(toolCallBlocks[0].name).toBe('bash')
    expect(JSON.parse(toolCallBlocks[0].arguments)).toEqual({ command: 'ls' })
    expect(finishKind).toBe('tool-calls')
  })

  it('flushes incomplete <thought> as reasoning when the stream ends without closing tag', async () => {
    // 不完整的 <thought> 块（被 max_tokens 截断）：flush() 须把残留
    // 作为 reasoning 放行，避免推理泄漏到正文。
    const incompleteThought = '<thought>我正在思考'
    const fetchImpl = vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(incompleteThought)}},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const adapter = makeAdapter({ fetchImpl })
    const textDeltas: string[] = []
    const reasoningDeltas: string[] = []
    for await (const chunk of adapter.stream(streamOptions)) {
      if (chunk.type === 'text-delta') textDeltas.push(chunk.text)
      if (chunk.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    }
    // 不完整 thought 作为 reasoning 放行，不泄漏到正文
    expect(textDeltas.join('')).toBe('')
    expect(reasoningDeltas.join('')).toBe('我正在思考')
  })
})
