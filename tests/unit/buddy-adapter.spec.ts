import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CHAT_API_BASE, BuddyAdapter, DEFAULT_MODEL, registerBuddyLlm } from '../../src/buddy-adapter.js'
import type { BuddyCredential, BuddyRemoteModel } from '../../src/buddy.js'
import { BUDDY_CN, BUDDY, type BuddyProduct } from '../../src/product.js'

const CREDENTIAL_REF = credentialRef('BUDDY_CN_ACCESS_TOKEN')

/** 构造一个未过期的凭据。 */
function makeCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** adapter.stream() 的最小 GenerateOptions 形参。 */
const streamOptions = {
  model: DEFAULT_MODEL,
  messages: [],
  signal: new AbortController().signal,
} as never

/** 将 SSE 文本包装为流式 Response。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/**
 * 上下文超限的 400 响应体（用户报障原文，国际版 WorkBuddy + deepseek-v4.1-flash）。
 *
 * 关键字段：`msg` 用「prompt is too long」措辞、`extError.code` 为
 * `context_length_exceeded`。两者都是 DSH `isContextWindowExceededError` 的
 * 识别依据，适配器必须据此把它归为 CONTEXT_WINDOW_EXCEEDED 而非 INVALID_REQUEST。
 */
const CONTEXT_OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
  requestId: '9dc0e856-3dae-431c-a8bd-87a2ab63e8d9',
  extError: {
    code: 'context_length_exceeded',
    message: 'prompt is too long: 1061554 tokens > 1048576 maximum',
    param: '',
    type: 'invalid_request_error',
    StatusCode: 400,
    Request: null,
    Response: null,
  },
  displayMsg: {
    en: 'The request exceeds the model context limit. Please shorten the conversation or remove attachments.',
    zh: '对话内容超出模型长度上限，请精简对话或减少附件后重试。',
  },
})

function makeAdapter(overrides: {
  credential?: BuddyCredential | undefined
  refresh?: () => Promise<void>
  /** refresh() 之后 resolveCredential 应返回的值；默认刷新成功（恢复为有效凭据）。 */
  postRefreshCredential?: BuddyCredential | undefined
  fetchImpl?: typeof fetch
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 刻意比生产类型宽松（允许多返回 `undefined`）：用于模拟「旧版桥接」
   * 或版本错配时传入的 readImage —— 适配器的运行时守卫必须能挡住它，
   * 而不是依赖类型系统保证。生产侧 `BuddyAdapterOptions.readImage`
   * 已不含 undefined（移植上游 39c66ac）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；不传时由 BuddyAdapter 回退到 CodeBuddy。 */
  product?: BuddyProduct
  /** 多账号池替身；本文件只用到模型黑名单（listModels 的过滤输入）。 */
  accountPool?: unknown
} = {}) {
  let credential = 'credential' in overrides ? overrides.credential : makeCredential()
  const refresh = overrides.refresh ?? (async () => {})
  const fetchImpl = overrides.fetchImpl ?? (async () => new Response('not found', { status: 404 }))
  return new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => credential,
    refresh: async () => {
      await refresh()
      credential = 'postRefreshCredential' in overrides ? overrides.postRefreshCredential : makeCredential()
    },
    fetchImpl,
    ...overrides.fetchRemoteModels !== undefined ? { fetchRemoteModels: overrides.fetchRemoteModels } : {},
    ...overrides.readImage !== undefined ? { readImage: overrides.readImage } : {},
    ...overrides.product !== undefined ? { product: overrides.product } : {},
    ...overrides.accountPool !== undefined ? { accountPool: overrides.accountPool as never } : {},
  })
}

describe('BuddyAdapter', () => {
  it('providerInfo identifies the buddy route', () => {
    // 展示名改由产品配置驱动（this.product.displayName）。Buddy CN 的
    // displayName 定稿为 'Buddy CN'（与 Account Hub 前端 PROVIDERS 的 label
    // 一致），故不再断言历史字面量 'CodeBuddy (腾讯)' / 'CodeBuddy (Tencent)'。
    expect(makeAdapter().providerInfo('buddy-cn')).toMatchObject({ id: 'buddy-cn', name: BUDDY_CN.displayName })
  })

  it('listModels falls back to the product catalog when no remote source is configured', async () => {
    // CodeBuddy 现在自带 fallbackModels（实测可用的 14 个），故兜底不再是通用 DEFAULT_MODELS。
    const models = await makeAdapter().listModels('buddy-cn')
    expect(models.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
    expect(models.map((m) => m.id)).toContain('glm-5.3')
    expect(models.every((m) => m.provider === 'buddy-cn')).toBe(true)
  })

  it('listModels prefers the remote catalog and caches it', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls++
        return [{ id: 'remote-model', name: 'Remote Model' }]
      },
    })
    const first = await adapter.listModels('buddy-cn')
    const second = await adapter.listModels('buddy-cn')
    // 产品兜底表是权威白名单：远端多出的 remote-model 被丢弃，
    // 兜底表声明的模型被补齐。重复调用不应再触发远端拉取。
    //
    // ⚠️ 这条「丢弃远端多出条目」是**刻意保留**的设计（服务端按认证上下文下发的
    // 集合可能是残缺甚至错的内部别名），但它的代价正是移植上游 39c66ac 第 3 项的
    // 动机：**兜底表漏一条 = 该模型在远端正常下发却在选择器里彻底看不见**。
    // 故新增模型必须同步补进 `BUDDY_CN_FALLBACK_MODELS` / `BUDDY_FALLBACK_MODELS`，
    // 而不是指望远端把它带进来。
    expect(first.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
    expect(second.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
    expect(calls).toBe(1, '远端列表只应拉取一次')
  })

  it('listModels falls back to the product catalog when the remote fetch fails', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const models = await adapter.listModels('buddy-cn')
    expect(models.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
  })

  it('resolveModel reports the known context window', async () => {
    // 移植上游 39c66ac 后 deepseek-v4-flash **已进产品兜底表**（CN 表 1M），
    // 故它现在走 `productFallbackContextWindows`（1M），与通用静态表
    // CONTEXT_WINDOWS 的取值一致 —— 三层查找的哪一层命中不再影响本断言结果，
    // 但来源变了，注释同步更新以免读者以为它仍在走静态表。
    const resolved = await makeAdapter().resolveModel('buddy-cn', 'deepseek-v4-flash')
    expect(resolved).toMatchObject({ provider: 'buddy-cn', id: 'deepseek-v4-flash', context: { contextWindow: 1_000_000 } })
    // 兜底表确实收录了它（而非仅靠静态表兜住）。
    expect(BUDDY_CN.fallbackModels!.some((m) => m.id === 'deepseek-v4-flash')).toBe(true)
  })

  it('resolveModel matches the product fallback table (max-tier windows)', async () => {
    // ⚠️ 兜底表的 `contextWindow` 语义是**最大档**（2026-09-21 钳制实测口径）：
    // defaultLength 是 UI 默认值、不是硬限（320K–1.0M token 实测全部正常服务，
    // 1.2M 才回 11115），真实窗口 = supportedLengths 最大档 = maxInputTokens。
    // CN 的 1M 系 = 1M；⚠️ minimax-m3 = **512K**（官方档位表最大档是 512K）；
    // 非 1M 条目（glm-5.1 200K / kimi-k2.6 256K）不动。
    const adapter = makeAdapter()
    expect((await adapter.resolveModel('buddy-cn', 'glm-5.3-flash')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy-cn', 'glm-5.3')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy-cn', 'glm-5.2')).context).toEqual({ contextWindow: 1_000_000 })
    expect((await adapter.resolveModel('buddy-cn', 'glm-5.1')).context).toEqual({ contextWindow: 200_000 })
    expect((await adapter.resolveModel('buddy-cn', 'minimax-m3')).context).toEqual({ contextWindow: 512_000 })
    expect((await adapter.resolveModel('buddy-cn', 'kimi-k2.6')).context).toEqual({ contextWindow: 256_000 })
  })

  it('resolveModel prefers the remote window over the static table', async () => {
    // 远端是权威来源（对齐 Rust context_limit_for_model 两级查找）：远端下发值
    // 覆盖静态 fallback。口径是**最大档**（src/buddy.ts 的 parseModelMeta 已把
    // min(maxInputTokens, supportedLengths 最大档) 解析进 contextWindow），
    // 适配器只负责「远端优先」。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576 }],
    })
    const resolved = await adapter.resolveModel('buddy-cn', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('resolveModel falls back to the static table when the remote value is absent', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }],
    })
    const resolved = await adapter.resolveModel('buddy-cn', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('远端最大档窗口端到端生效（不取默认档）', async () => {
    // 端到端口径防线：远端 `maxInputTokens` + `supportedLengths` 经
    // parseModelsFromConfig → reconcileWithFallback → resolveModel 一路到
    // 宿主声明值。真机形态：defaultLength 300K（UI 默认）、最大档 1M（真实服务窗口）。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{
        id: 'glm-5.3-flash',
        name: 'GLM-5.3 Flash',
        contextWindow: 1_000_000,
      }],
    })
    const resolved = await adapter.resolveModel('buddy-cn', 'glm-5.3-flash')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('resolveModel omits context for unknown models', async () => {
    const resolved = await makeAdapter().resolveModel('buddy-cn', 'unknown-model')
    expect(resolved.context).toBeUndefined()
  })

  // ── 图片能力声明 ──
  // 权威来源是 /v3/config 的 supportsImages。此前硬编码 ['text']，会话控制器
  // 直接在附件准入处拒绝图片（MODEL_DOES_NOT_SUPPORT_IMAGES），用户表现为
  // "设置里需要声明才能用图片"。
  describe('图片能力声明', () => {
    it('远端 supportsImages=true 时声明 image 模态', async () => {
      // 用无兜底表的产品：本节测「远端字段如何生效」，而兜底表会充当
      // 白名单把这类临时 id 滤掉（另见「产品兜底模型目录校正」一节）。
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'vision', name: 'V', supportsImages: true }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'vision')).inputModalities).toEqual(['text', 'image'])
    })

    it('远端显式 supportsImages=false 时保持 text-only', async () => {
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'plain', name: 'P', supportsImages: false }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'plain')).inputModalities).toEqual(['text'])
    })

    it('远端未下发该字段时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'deepseek-v4.1-flash')).inputModalities).toEqual(['text', 'image'])
    })

    // 移植上游 39c66ac：scoped 端点对 glm-5.1 误报 supportsImages=false，实测能看图。
    it('glm-5.1 被远端误报 false 时仍声明 image 模态（白名单 override）', async () => {
      // 远端显式 false —— 没有 override 的话这一条会是 ['text']，用户贴图会被
      // 宿主以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝，图片根本到不了上游。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM-5.1', supportsImages: false }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'glm-5.1')).inputModalities).toEqual(['text', 'image'])
    })

    it('白名单只覆盖实测个案，不放大到其他模型', async () => {
      // 反向防线：override 是**逐 id 白名单**，不是「兜底表 true 优先」这类通用规则。
      // 另一个兜底表里同样声明 supportsImages:true 的模型，远端 false 必须照样生效。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'glm-5.2', name: 'GLM-5.2', supportsImages: false }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'glm-5.2')).inputModalities).toEqual(['text'])
    })
  })

  // ── 思考强度声明 ──
  // composer 的模型选择器读取 resolveModel().reasoning.efforts；不声明该字段
  // 就显示"当前模型未提供推理等级"。
  describe('思考强度声明', () => {
    it('按远端 supportedEfforts 暴露等级与默认值', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{
          id: 'deepseek-v4.1-flash',
          name: 'DS',
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        }],
      })
      const resolved = await adapter.resolveModel('buddy-cn', 'deepseek-v4.1-flash')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'high', 'max'])
      expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'High', 'Max'])
      expect(resolved.reasoning?.defaultEffort).toBe('high')
    })

    it('远端未下发等级时回退静态表', async () => {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4-pro', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'deepseek-v4-pro')).reasoning?.efforts.map((e) => e.id))
        .toEqual(['low', 'high', 'xhigh'])
    })

    it('无可选等级的模型不暴露选择器', async () => {
      // 远端与产品兜底表都未声明 reasoningEfforts 时不暴露选择器。
      // （兜底表会给部分模型补上等级，故这里用无兜底表的产品测本行为）
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'glm-5.1')).reasoning).toBeUndefined()
    })

    it('产品兜底表声明的等级在远端缺失时生效', async () => {
      // glm-5.1 在 CodeBuddy 兜底表里声明了 medium 等级。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'glm-5.1', name: 'GLM' }],
      })
      const resolved = await adapter.resolveModel('buddy-cn', 'glm-5.1')
      expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['medium'])
    })
  })

  // 回归：dsh-llm 0.1.1-rc.2 的 LlmRuntime.prepareCall() 会直接调用
  // registration.adapter.prepareCall()，而本仓库链接的副本（0.1.0-rc.6）
  // 的 LlmAdapter 基类没有该方法——缺少时每轮请求都以
  // `registration.adapter.prepareCall is not a function` 失败。
  it('exposes prepareCall for the runtime adapter contract', async () => {
    const adapter = makeAdapter()
    expect(typeof adapter.prepareCall).toBe('function')
    const call = await adapter.prepareCall('buddy-cn', 'hy4-preview')
    expect(call.model).toMatchObject({
      provider: 'buddy-cn',
      id: 'hy4-preview',
      // 最大档口径：hy4-preview 的档位表最大档与 maxInputTokens 都是 1M
      // （defaultLength 300K 是 UI 默认值、不是硬限）。
      context: { contextWindow: 1_000_000 },
      inputModalities: ['text', 'image'],
    })
    expect(typeof call.stream).toBe('function')
  })

  it('prepareCall binds its stream to the same adapter instance', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const call = await adapter.prepareCall('buddy-cn', DEFAULT_MODEL)
    const chunks: Array<Record<string, any>> = []
    for await (const chunk of call.stream(streamOptions as never)) {
      chunks.push(chunk as unknown as Record<string, any>)
    }
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  // ── 单次输出上限（maxOutputTokens）──
  //
  // 用户报障：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被截断，
  // `turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。根因不是
  // 「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当 `isChatModel` 的
  // 过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关默认值，而网关
  // 默认恰好就是 **32000**。远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。
  // 真机日志：20 次 `turn/end max-tokens`，buddy 系 651 次请求零 `maxTokens`。
  describe('单次输出上限', () => {
    it('远端 maxOutputTokens 映射为 defaultMaxTokens', async () => {
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 128_000 },
        ],
      })
      expect((await adapter.resolveModel('buddy-cn', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('远端与兜底表都没有该值时保持 undefined（不编造）', async () => {
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [{ id: 'mystery', name: 'M' }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'mystery')).defaultMaxTokens).toBeUndefined()
    })

    it('远端缺失时用产品兜底表的实测值补位', async () => {
      // deepseek-v4.1-flash 在 Buddy CN 兜底表中已按实测填 128000。
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ id: 'deepseek-v4.1-flash', name: 'DS' }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'deepseek-v4.1-flash')).defaultMaxTokens).toBe(128_000)
    })

    it('国际版同样从兜底表取到实测值（gpt-5.3-codex 刻意留空）', async () => {
      const adapter = makeAdapter({
        product: BUDDY,
        fetchRemoteModels: async () => [
          { id: 'gpt-5.6-sol', name: 'Sol' },
          { id: 'gpt-5.3-codex', name: 'Codex' },
        ],
      })
      expect((await adapter.resolveModel('buddy', 'gpt-5.6-sol')).defaultMaxTokens).toBe(128_000)
      expect((await adapter.resolveModel('buddy', 'gpt-5.3-codex')).defaultMaxTokens).toBeUndefined()
    })

    it('stream 把上限写进请求体的 max_tokens', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(128_000)
    })

    it('调用方显式给出的 maxTokens 优先于远端与兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4_096,
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(4_096)
    })

    it('远端下发的值优先于兜底表', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [
          { id: 'deepseek-v4.1-flash', name: 'DS', maxOutputTokens: 7_000 },
        ],
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body.max_tokens).toBe(7_000)
    })

    it('非法/非正的远端值被忽略（不写 defaultMaxTokens，也不写请求体）', async () => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        product: { ...BUDDY_CN, fallbackModels: undefined } as never,
        fetchRemoteModels: async () => [
          { id: 'zero', name: 'Z', maxOutputTokens: 0 },
          { id: 'neg', name: 'N', maxOutputTokens: -5 },
        ],
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      expect((await adapter.resolveModel('buddy-cn', 'zero')).defaultMaxTokens).toBeUndefined()
      expect((await adapter.resolveModel('buddy-cn', 'neg')).defaultMaxTokens).toBeUndefined()
      await collectChunks(adapter, {
        model: 'zero',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
      expect(body).not.toHaveProperty('max_tokens')
    })

    it('**透传防线**：reconcileWithFallback 重建条目时不丢 maxOutputTokens', async () => {
      // 该函数重建条目对象，漏字段 = 删能力（contextTiers 曾写过同款警告）。
      // 用带兜底表的产品 + 只下发 maxOutputTokens 的远端条目，验证远端值穿过重建。
      const adapter = makeAdapter({
        product: {
          ...BUDDY_CN,
          fallbackModels: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        } as never,
        fetchRemoteModels: async () => [{ id: 'glm-5.3', name: 'GLM-5.3', maxOutputTokens: 12_345 }],
      })
      expect((await adapter.resolveModel('buddy-cn', 'glm-5.3')).defaultMaxTokens).toBe(12_345)
    })
  })
})

/**
 * 上下文窗口档位（推广到全部供应商后的 Buddy 侧）。
 *
 * Buddy 的目录公布 `contextWindow.supportedLengths`，而**生效档已经是最大档**
 * （`min(maxInputTokens, 档位表最大档)`，2026-09-21 钳制实测口径）—— 故这里的
 * 「档位」是**降档**选项，与 Qoder（默认档是最小档、其余是升档）方向相反。
 * 三个落点必须同源同口径：
 *
 * 1. `contextTiers()` —— Host 的「显示列表」据此渲染单选列并校验用户提交值；
 * 2. `resolveModel()` —— 用户选中的档位在这里变成向 DSH 声明的窗口；
 * 3. **出站请求体一个字段都不动**（红线）。
 */
describe('BuddyAdapter 上下文窗口档位（生效档已是最大档）', () => {
  /** 远端目录：`supportedLengths: [300000, 1048576]` 的两档模型。 */
  const REMOTE = [{
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_048_576,
    contextTiers: [300_000, 1_048_576],
  }]

  /** 造适配器；`budgets` 是账号池里存的用户选择。 */
  function makeTierAdapter(budgets: Record<string, number> = {}, overrides: Record<string, unknown> = {}) {
    return makeAdapter({
      fetchRemoteModels: async () => REMOTE as never,
      accountPool: {
        contextBudget: (_provider: string, model: string) => budgets[model],
        // 让 `stream()` 的账号登记路径走通（缺了会打一条无害的 warn，把逐字节
        // 用例的输出弄脏）。**档位读取路径不看它们**。
        findAccountIdByCredential: async () => 'acct-1',
        updateModelRateLimit: async () => {},
      },
      ...overrides,
    })
  }

  it('contextTiers() 播报远端目录的整张档位表（经产品兜底表校正后仍在）', async () => {
    // ⚠️ 这条同时钉死 `reconcileWithFallback` 的**字段透传**：它会重建条目对象，
    // 漏掉 `contextTiers` 就等于把档位能力静默删掉 —— 而 CN 与国际版**都带兜底
    // 表**、都走这条重建路径，故那种漏失会让两个产品的档位列一起消失。
    const tiers = await makeTierAdapter().contextTiers()
    expect(tiers.get('glm-5.3')).toEqual({
      contextWindow: 1_048_576,
      contextTiers: [300_000, 1_048_576],
    })
  })

  it('目录不可用时 contextTiers() 为空表（静态兜底表是快照，不编造档位）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('network down') } })
    expect((await adapter.contextTiers()).size).toBe(0)
  })

  it('resolveModel：未设置预算 = 最大档（接线前逐字段一致）', async () => {
    const resolved = await makeTierAdapter().resolveModel('buddy-cn', 'glm-5.3')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('resolveModel：预算精确命中降档 → 用该档；编造值静默回退最大档', async () => {
    expect((await makeTierAdapter({ 'glm-5.3': 300_000 }).resolveModel('buddy-cn', 'glm-5.3')).context)
      .toEqual({ contextWindow: 300_000 })
    for (const bogus of [500_000, 1, 0, 999_999_999]) {
      expect((await makeTierAdapter({ 'glm-5.3': bogus }).resolveModel('buddy-cn', 'glm-5.3')).context,
        String(bogus)).toEqual({ contextWindow: 1_048_576 })
    }
  })

  /**
   * ⚠️ **红线：出站请求体零变更**。
   *
   * 档位只改 `resolveModel().context.contextWindow`。若有人把 supportedLengths /
   * defaultLength 之类顺手塞进请求体，上游就按另一个口径服务了 —— 那是协议变更。
   *
   * ⚠️ **必须复用同一个适配器实例**：`prompt_cache_key` 由构造时的 `sessionId`
   * 派生，两次各造一个实例会得到两个不同的 key，逐字节比对必然失败 ——
   * 而那个差异与档位无关（`sessionId` 是会话标识，本来就该每会话不同）。
   * 复用一个实例、只改账号池里的预算值，才是「唯一变量 = 档位」的对照。
   */
  it('**逐字节红线**：三种档位下发出的请求体完全相同', async () => {
    const budgets: Record<string, number> = {}
    const bodies: string[] = []
    const adapter = makeTierAdapter(budgets, {
      fetchImpl: async (_url: unknown, init: { body?: unknown }) => {
        bodies.push(String(init?.body))
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })

    for (const budget of [undefined, 300_000, 1_048_576]) {
      if (budget === undefined) delete budgets['glm-5.3']
      else budgets['glm-5.3'] = budget
      // 先确认这一轮的档位**真的不同**，否则「body 相同」可能只是因为档位压根
      // 没生效（那样这条用例就成了同义反复）。
      expect((await adapter.resolveModel('buddy-cn', 'glm-5.3')).context?.contextWindow)
        .toBe(budget ?? 1_048_576)
      await collectChunks(adapter, {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      } as never)
    }

    expect(bodies.length).toBe(3)
    expect(bodies[0]!.length).toBeGreaterThan(0)
    expect(bodies[1]).toBe(bodies[0])
    expect(bodies[2]).toBe(bodies[0])
    for (const forbidden of ['supportedLengths', 'defaultLength', 'contextWindow', 'maxInputTokens']) {
      expect(bodies[0], forbidden).not.toContain(forbidden)
    }
  })
})

describe('BuddyAdapter credential handling', () => {
  it('stream throws MISSING_CREDENTIAL when no credential is configured', async () => {
    // credential 缺失且刷新也拿不到凭据（postRefreshCredential: undefined）。
    const adapter = makeAdapter({ credential: undefined, postRefreshCredential: undefined })
    await expect(collectChunks(adapter, streamOptions)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('stream refreshes first when the credential is expired', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      credential: makeCredential({ expires_at: String(Date.now() - 60_000) }),
      refresh: async () => { refreshed = true },
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
    })
    await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(true)
  })

  it('stream refreshes once and retries on HTTP 401', async () => {
    let refreshed = 0
    let calls = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed++ },
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? new Response('unauthorized', { status: 401 })
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      },
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(refreshed).toBe(1, '401 只应触发一次刷新')
    expect(calls).toBe(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('stream maps HTTP 429 to RATE_LIMIT and 5xx to SERVER', async () => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER'], [400, 'INVALID_REQUEST']] as const) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(`{"error":{"message":"boom"}}`, { status }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe(code)
    }
  })

  /**
   * 上下文超限必须归为 CONTEXT_WINDOW_EXCEEDED，而不是笼统的 INVALID_REQUEST。
   *
   * 为什么这条错误码至关重要：DSH 的自动压缩恢复（dsh-compaction-basic）监听
   * `agent/request-error`，**只对 `failure.code === CONTEXT_WINDOW_EXCEEDED`**
   * 的失败压缩上下文并重试。若标成 INVALID_REQUEST，长会话一旦越过窗口就会把
   * 裸错误直接抛给用户，用户看到的是：
   *
   *   buddy: {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum", ...}
   *
   * 这正是用户报障的现象（国际版 WorkBuddy，deepseek-v4.1-flash）。CodeArts
   * 适配器早已做此归类（llm-adapter.ts 的 httpErrorCode），buddy 此前遗漏。
   *
   * 报文取自真实报障原文：`msg` 为「prompt is too long」措辞、
   * `extError.code` 为 `context_length_exceeded`，两者都应被识别。
   */
  it('stream 把上下文超限的 400 归为 CONTEXT_WINDOW_EXCEEDED（触发自动压缩）', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => new Response(CONTEXT_OVERFLOW_BODY, { status: 400 }),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 错误消息仍须保留可读原因（用户/日志据此定位），不能被错误码改写掉
    expect((error as LlmError).message).toContain('prompt is too long')
  })

  it('上下文超限的 400 不被误判为限流（不触发账号切换）', async () => {
    // 区分「窗口超限」与「用量限流」很重要：前者换账号也没用（同样的上下文
    // 会再次超限），必须走压缩；后者才该切换账号。若误判为限流，适配器会白试
    // 一遍所有账号，最后仍以 QUOTA_EXCEEDED 掩盖真实原因。
    //
    // 这里用自包含的 pool 替身（该 describe 内的 makePool 定义在另一块中）。
    const recorded: Array<{ accountId: string }> = []
    const sentTokens: string[] = []
    const pool = {
      async findAccountIdByCredential() { return 'acct-1' },
      async updateModelRateLimit(accountId: string) { recorded.push({ accountId }) },
      async getAvailableAccount() {
        return { entry: { id: 'acct-2' }, credential: makeCredential({ access_token: 'AT2' }) }
      },
    }
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(CONTEXT_OVERFLOW_BODY, { status: 400 })
      },
    })

    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 只发了当前账号：没有因误判限流而去轮询其余账号
    expect(sentTokens).toEqual(['AT1'])
    // 也不应写入任何限流标记
    expect(recorded).toEqual([])
  })

  /**
   * 对照：同为中国版/国际版常见的 400 错误，只要不含超限措辞，仍须是
   * INVALID_REQUEST —— 避免为了修上下文超限而把所有 400 都当成可压缩错误
   * （那会让真正的请求错误被反复压缩重试，浪费额度且掩盖原因）。
   */
  it('普通 400（模型不存在 / 参数非法）仍归为 INVALID_REQUEST', async () => {
    const cases = [
      '{"error":{"message":"model not found"}}',
      '{"code":11102,"msg":"service info not found"}',
      '{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}',
    ]
    for (const body of cases) {
      const adapter = makeAdapter({ fetchImpl: async () => new Response(body, { status: 400 }) })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect((error as LlmError).failure.code, body).toBe('INVALID_REQUEST')
    }
  })

  /**
   * 判定必须看**完整 body**，不能只看 errorDetail 归一化后的短文本。
   *
   * `errorDetail` 在能提取到 `error.*` / `data.message` 时会返回拼接文本，
   * 从而丢掉 `extError` / `displayMsg`。若把判定建立在它之上，服务端一旦
   * 把 `msg` 改名成 `message`（或补上 `error.code`），`extError.code =
   * context_length_exceeded` 这个最强信号就会被丢弃，超限随即漏判成
   * INVALID_REQUEST、自动压缩再次失效。
   *
   * 这里构造「error.code 为字符串 + msg 为超限措辞」的变体：errorDetail 会
   * 返回 `"some_error prompt is too long: ..."`（丢失 extError），但完整 body
   * 仍含 `context_length_exceeded`，故必须仍判为超限。
   */
  it('判定基于完整 body：extError 在 errorDetail 中被丢弃时仍能识别超限', async () => {
    const variant = JSON.stringify({
      error: { code: 'some_error', message: 'prompt is too long: 1061554 tokens > 1048576 maximum' },
      extError: { code: 'context_length_exceeded' },
    })
    const adapter = makeAdapter({ fetchImpl: async () => new Response(variant, { status: 400 }) })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  /**
   * 安全网：声明值取**最大档**（≈1M）后，万一某个模型真实窗口低于声明值，
   * 撞上的就是 2026-09-21 实测的这条 11115 报文（buddy-cn / glm-5.3，1.2M 请求）：
   *
   * ```
   * {"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum",
   *  "extError":{"code":"400001","type":"invalid_request_error"},
   *  "displayMsg":{"en":"The request exceeds the model context limit. ..."}}
   * ```
   *
   * 报文里的 "100001 > 100000" 是**另一种计数尺度**的钳制显示（精确钳制点未定位），
   * 但语义确凿：prompt 超限。
   *
   * ⚠️ **命中的是 `displayMsg.en` 那句话，不是 `msg`、也不是 `extError.code`** ——
   * 这条必须在测试里写清楚，因为它决定了安全网的**承重点**：
   * - `extError.code` 是**纯数字** `400001`，与旧的 `context_length_exceeded`
   *   不同源，`STRUCTURED_CONTEXT_OVERFLOW` 认不出它；
   * - `msg` 的「prompt is too long: N tokens > M maximum」也**不是**判据目标 ——
   *   `TOO_LARGE_FOR_CONTEXT` 要求「too long **for this model**」，这句没有
   *   `for … model`，故不命中（下面的「已知承重点」用例把这条钉死）。
   *
   * 结论不变：**无需改分类器**（判据的定义权在宿主，见 lobsterai-errors.ts 的
   * 同一先例），只需把这条映射钉住，防它随口径变更静默失效 —— 一旦失效，长会话
   * 就会退回 `INVALID_REQUEST`（致命、**不触发宿主压缩**）而彻底不可用。
   */
  it('安全网：11115 钳制报文（extError.code=400001）仍归为 CONTEXT_WINDOW_EXCEEDED', async () => {
    const clampBody = JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 100001 tokens > 100000 maximum',
      requestId: '1f0c2a94-6b31-4d4e-8f3a-2b0d6c7e9a51',
      extError: { code: '400001', type: 'invalid_request_error' },
      displayMsg: {
        en: 'The request exceeds the model context limit. Please shorten the conversation or remove attachments.',
        zh: '对话内容超出模型长度上限，请精简对话或减少附件后重试。',
      },
    })
    const adapter = makeAdapter({ fetchImpl: async () => new Response(clampBody, { status: 400 }) })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 上游原文保留在 message 里（真机排障要能对上号）
    expect((error as LlmError).message).toContain('prompt is too long')
  })

  /**
   * ⚠️ **已知承重点**：安全网挂在 `displayMsg.en` 的英文措辞上。
   *
   * 把 `displayMsg` 摘掉、只留 `msg` + `extError.code:"400001"`，宿主判定
   * **不命中** ⇒ 落回 `INVALID_REQUEST`（不触发压缩）。这条不是在肯定该行为，
   * 而是把「安全网靠什么承重」钉进测试：上游若改了 displayMsg 文案，这里会给出
   * 最直接的线索，而不是让人对着「长会话忽然不可用」猜。
   *
   * 本次**刻意不改分类器**：判据的定义权在宿主（`isContextWindowExceededError`），
   * 自建关键词表会与它漂移 —— 与 lobsterai / qoder 两条线同一原则。
   */
  it('⚠️ 已知承重点：摘掉 displayMsg 的裸 11115 报文命中不了（安全网依赖英文措辞）', async () => {
    const bareBody = JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 100001 tokens > 100000 maximum',
      extError: { code: '400001', type: 'invalid_request_error' },
    })
    const adapter = makeAdapter({ fetchImpl: async () => new Response(bareBody, { status: 400 }) })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect((error as LlmError).failure.code).toBe('INVALID_REQUEST')
  })

  it('安全网：钳制报文不带任何档位字段时也走同一条映射（出站零变更的对照）', async () => {
    // 声明值只影响宿主的压缩阈值，**绝不进出站请求体**（红线）。这里确认
    // 「最大档口径」没有顺手往请求里塞 supportedLengths / defaultLength 之类字段。
    const clampBody = JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 100001 tokens > 100000 maximum',
      extError: { code: '400001', type: 'invalid_request_error' },
      displayMsg: { en: 'The request exceeds the model context limit.' },
    })
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(clampBody, { status: 400 })
      },
    })
    await collectChunks(adapter, streamOptions).catch(() => undefined)
    for (const forbidden of ['contextWindow', 'defaultLength', 'supportedLengths', 'maxInputTokens', 'context_window']) {
      expect(body, forbidden).not.toHaveProperty(forbidden)
    }
  })

  it('stream sends the required CodeBuddy headers', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, streamOptions)
    expect(seen!.get('Authorization')).toBe('Bearer AT')
    expect(seen!.get('X-Domain')).toBe('copilot.tencent.com')
    expect(seen!.get('X-Product-Code')).toBe('codebuddy')
    expect(seen!.get('User-Agent')).toBe('CodeBuddyIDE/1.106.1')
  })

  /** 抓取一次 stream() 实际发出的请求体；overrides 同时用于 adapter 与请求。 */
  async function captureBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      ...overrides,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      ...overrides,
    } as never)
    return body
  }

  // 实测：reasoning_effort=low/high/max 会显著改变返回的 reasoning_content
  // 长度，是服务端真实生效的参数。
  it('stream forwards a supported reasoning effort as reasoning_effort', async () => {
    expect(await captureBody({ reasoningEffort: 'max' })).toMatchObject({ reasoning_effort: 'max' })
  })

  // 实测（2026-09，直连 workbuddy 国际/中国 UA 与 codebuddy 三站点对照）：
  //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
  //   - 仅 reasoning_effort:high → 返回思考；仅 thinking:{type:'enabled'} → 仍为 0；
  //   - 两者都带 → 返回思考。
  // 即 reasoning_effort 才是真正开关，thinking 单独不生效（保留以对齐官方形态）。
  it('stream enables thinking for deepseek models', async () => {
    expect(await captureBody()).toMatchObject({ thinking: { type: 'enabled' } })
  })

  // 真实缺陷回归（会话 session-03b4d1f2 "测试思考过程显示"）：workbuddy 的
  // deepseek-v4.1-flash 未声明 defaultReasoningEffort，composer 因而未预选档位，
  // 请求体里只剩 thinking 而没有 reasoning_effort → 上游按不思考应答 → UI 看不到
  // 思考块。适配器必须在此情形补档，保证任何 deepseek 请求都带 reasoning_effort。
  it('stream backfills reasoning_effort for deepseek when none is selected or unsupported', async () => {
    // composer 未选等级（options.reasoningEffort === undefined）时补默认档。
    expect(await captureBody()).toMatchObject({ reasoning_effort: 'high' })
    // 会话历史里可能残留切换模型前的旧等级（如 glm-5.2 的 xhigh），
    // 不被该模型支持时也要补成合法档位，而非丢弃导致静默不思考。
    const body = await captureBody({ reasoningEffort: 'xhigh' })
    expect(body).toHaveProperty('reasoning_effort')
    expect(['low', 'high', 'max']).toContain(body.reasoning_effort)
  })

  it('stream does not enable thinking or backfill effort for non-deepseek models', async () => {
    // glm 等其他模型走各自 thinkingFormat（默认开或 enable_thinking），
    // 不注入 thinking 开关、不补默认档。
    const body = await captureBody({ model: 'glm-5.2' })
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  // CodeBuddy 只接受 OpenAI 多模态 parts 形态的图片；
  // {type:'image'} 会被服务端以 `unsupported content type ... image` 400。
  it('stream sends user images as inline image_url parts', async () => {
    const body = await captureBody({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    expect(user.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
  })

  it('stream rejects images for a model that declares text-only', async () => {
    // 用无兜底表的产品，使远端声明的 supportsImages=false 直接生效
    // （兜底表会充当白名单）。模型 id 用兜底表之外的临时值。
    const textOnly = 'text-only-probe'
    const adapter = makeAdapter({
      product: { ...BUDDY_CN, fallbackModels: undefined } as never,
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      fetchRemoteModels: async () => [{ id: textOnly, name: 'M', supportsImages: false }],
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: textOnly,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('stream keeps image-free requests on the plain string content path', async () => {
    // 无图请求的线上格式必须不变，否则整体破坏前缀缓存命中。
    const body = await captureBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    const user = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'user')!
    expect(user.content).toBe('hello')
  })

  // ── 「静默丢图」回归护栏（移植上游 39c66ac）──
  // 旧实现：readImage 返回 undefined 时 `continue` 丢掉整张图，线上请求退化成
  // 纯文本，模型只能答「我看不到图片」，用户拿不到任何错误原因。
  it('stream fails loudly when readImage reports it cannot read the bytes', async () => {
    let body: Record<string, unknown> | undefined
    const adapter = makeAdapter({
      readImage: async () => undefined,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('data: [DONE]\n\n')
      },
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-missing' } },
        ],
      }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    // 关键：请求根本没有发出，图片不可能被静默丢弃。
    expect(body).toBeUndefined()
  })

  it('stream preserves the cause when readImage throws', async () => {
    const cause = new Error('attachment object is gone')
    const adapter = makeAdapter({
      readImage: async () => { throw cause },
      fetchImpl: async () => sseResponse('data: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] }],
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
    expect((error as LlmError).message).toContain('attachment object is gone')
  })
})

describe('BuddyAdapter stream parsing', () => {
  it('emits text and reasoning on separate blocks', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'reasoning')).toBeDefined()
    expect(chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')).toBeDefined()
    const text = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(text[0]).toMatchObject({ block: { type: 'text', text: 'hello world' } })
    const reasoning = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'reasoning')
    expect(reasoning[0]).toMatchObject({ block: { type: 'reasoning', text: 'thinking...' } })
  })

  it('reports stop when no tool calls occur', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  // 回归：CodeBuddy 流式响应仅首个分片携带真实 id（chatcmpl-tool-xxx），
  // 后续参数分片只有 index。若按 index 生成 call_{index} 而非沿用真实 id，
  // 跨轮（每轮都从 call_0 重新编号）会导致 tool/result 配对到错误的历史条目。
  it('keeps one stable id across argument fragments of the same tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\": \\"ls\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
    expect(deltas).not.toHaveLength(0)
    // 所有分片（含首个空参数分片）都必须使用后端签发的真实 id。
    for (const delta of deltas) {
      expect((delta as { id: string }).id).toBe('chatcmpl-tool-abc')
    }
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-abc', name: 'shell', arguments: '{"command": "ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  // 回归：并行工具调用各自拥有独立 id，参数分片不得混淆到同一个工具上。
  it('distinguishes parallel tool calls by id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"shell","arguments":""}},{"index":1,"id":"chatcmpl-tool-2","function":{"name":"file_read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}},{"index":1,"function":{"arguments":"{\\"b\\":2}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(ends).toHaveLength(2)
    const byId = new Map(ends.map((c) => [(c as { block: { id: string } }).block.id, c]))
    expect(byId.get('chatcmpl-tool-1')).toMatchObject({ block: { name: 'shell', arguments: '{"a":1}' } })
    expect(byId.get('chatcmpl-tool-2')).toMatchObject({ block: { name: 'file_read', arguments: '{"b":2}' } })
  })

  // 回归：CodeBuddy 的参数续分片会带回 `"function":{"name":""}`。空串不是
  // undefined，原先的 `!== undefined` 判断会用它覆盖首个分片解析出的真实
  // 工具名，最终 block-end 输出 name:""，harness 报 `unknown tool ""`。
  it('ignores an empty function name on argument continuation fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","type":"function","function":{"name":"shell","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"{\\"command\\":\\"ls -"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"la\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({
      block: { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'shell', arguments: '{"command":"ls -la"}' },
    })
    // 续分片的空名不得传播到 delta 上。
    for (const delta of chunks.filter((c) => c.type === 'tool-call-delta')) {
      expect((delta as { name?: string }).name).toBe('shell')
    }
  })

  it('falls back to call_{index} when the backend sends no id', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]).toMatchObject({ block: { type: 'tool-call', id: 'call_0', name: 'shell' } })
  })

  // 'length'（输出被 max_tokens 截断）必须优先于 tool_calls：否则 harness 会执行
  // 被截断的非法 JSON 参数，并把脏参数持久化进会话历史。
  it('reports max-tokens over tool-calls when the stream is truncated', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('surfaces SSE-embedded errors as SERVER failures', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: {"error":{"message":"internal error"}}\n\ndata: [DONE]\n\n'),
    })
    const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(String((error as LlmError).message)).toContain('internal error')
  })

  // 回归：无参数工具（如 list_dir / get_cwd）只下发一个空的 arguments
  // 分片，拼接结果为空串。harness 解析时报
  // `invalid arguments: "arguments" must be an object`，会话卡在错误态，
  // web 端发送按钮置灰、后续指令无响应。空参数必须归一化为 {}。
  it('normalizes empty arguments of a zero-parameter tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"list_dir","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ block: { name: 'list_dir', arguments: '{}' } })
  })

  // 回归：SSE 流被网关掐断（无 finish_reason、无 [DONE]）时，工具参数是
  // 半截 JSON。原实现把它报告为 tool-calls，harness 执行不完整参数报
  // INVALID_ARGS 并把脏参数持久化进历史。此时应报告 max-tokens，让 dsh
  // 丢弃残缺调用并触发续写。
  it('reports max-tokens instead of executing a half-streamed tool call', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"write","arguments":"{\\"content\\": \\"trunca"}}]}}]}',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    // 残缺参数必须原样保留，交由 max-tokens 触发重试。绝不能补成 {}——
    // 那会让 harness 报 `missing required property` 而非重试。
    const end = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end[0]!.block.arguments).not.toBe('{}')
  })

  // 回归（核心）：hy4-preview 并行下发多个工具调用时会丢参数分片，两个调用
  // 都只剩残缺片段（实测 session-23851745 turn1 step4）。此前适配器把残缺
  // JSON 补成 {}，伪造出合法外观，harness 执行时报
  // `missing required property "file_path"`，模型收到莫名其妙的参数错误并
  // 陷入重试循环。现在必须判定为截断、报告 max-tokens 触发 dsh 重试。
  it('reports max-tokens when parallel tool calls lose argument fragments', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse([
        // 两个并行 read：参数开头的 `{"file_path": "D:\\...` 前缀丢失。
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-a","function":{"name":"read","arguments":""}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"\\\\deveco-code-rust\\\\cr"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"ates\\\\deveco"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tool-b","function":{"name":"read","arguments":"o-llm\\\\src\\\\provider\\\\buddy.rs\\"}"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    // 后端声明 finish_reason=tool_calls，但参数残缺——必须覆盖为 max-tokens，
    // 否则 harness 会执行这两个缺参调用。
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  // 回归：后端掐断连接但既不发数据也不关连接（半开连接）时，裸
  // reader.read() 永久挂起——generator 不返回，harness 步骤既不出结果
  // 也不报错，会话永远停在"运行中"，web 端发送按钮置灰、"继续"无响应。
  // 必须主动超时并抛可重试的 TIMEOUT，把控制权交还给用户。
  it('fails fast with a retryable TIMEOUT when the stream stalls', async () => {
    // 默认 firstTokenTimeout 为 120s，测试里缩短到 20ms 触发超时路径。
    // 环境变量在每次 stream() 调用时读取，因此这里设置即时生效。
    process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS = '20'
    try {
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(
          new ReadableStream<Uint8Array>({ start() { /* 永不产出数据 */ } }),
          { status: 200 },
        ),
      })
      const error = await collectChunks(adapter, streamOptions).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('TIMEOUT')
    } finally {
      delete process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS
    }
  })

  it('skips malformed SSE lines', async () => {
    const adapter = makeAdapter({
      fetchImpl: async () => sseResponse('data: not-json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
    })
    const chunks = await collectChunks(adapter, streamOptions)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('BuddyAdapter message serialization', () => {
  it('sends assistant reasoning_content and null content for tool-only turns', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'let me check' },
          { type: 'tool-call', id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
        ] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    const assistant = payload.messages[0]
    expect(assistant.role).toBe('assistant')
    // 正文为空且带 tool_calls 时 content 必须为 null（对齐 openai_chat.rs）。
    expect(assistant.content).toBeNull()
    // 推理模型要求 assistant 消息始终携带 reasoning_content 字段。
    expect(assistant.reasoning_content).toBe('let me check')
    expect(assistant.tool_calls).toMatchObject([{ id: 'call_1', type: 'function', function: { name: 'shell' } }])

    // 工具结果展开为独立的 role:'tool' 消息。
    const tool = payload.messages[1]
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file.txt' })
  })

  // 回归（严重）：工具执行失败时，assistant 的 tool_calls 会留在会话历史里，
  // 但对应的 tool 结果消息从未写入——形成孤儿 tool_calls。OpenAI 兼容后端
  // 要求带 tool_calls 的 assistant 消息必须紧跟对应 tool 消息，否则每次
  // 请求都 400。由于坏历史被持久化并随每次请求重放，**后续所有消息都会
  // 石沉大海**，整个会话永久报废。适配器是最后一道防线，必须清理。
  it('drops orphan tool_calls that have no tool result', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'list the files' },
        // 助手发起了 Grep 调用，但参数非法导致执行失败，结果从未写回历史。
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'Grep', arguments: '' },
        ] },
        // 用户随后发的消息中没有对应的 tool-result。
        { role: 'user', content: 'continue' },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // 孤儿 tool_calls 必须被剥离，否则后端永久 400、会话报废。
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：只有部分工具调用拿到结果时同样不合法——后端要求 tool_calls 中
  // 的每一个 id 都有对应 tool 消息，缺一个就整体拒绝。
  it('drops a whole tool_calls batch when only part of it has results', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        // 只有 call_1 拿到结果；call_2 是孤儿。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toBeUndefined()
  })

  // 回归：孤儿的 role:'tool' 消息（没有对应的前置 tool_call）同样会被后端
  // 拒绝。assistant 消息被丢弃时可能出现，必须一并清理。
  it('drops orphan tool result messages', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'user', content: 'hi' },
        // 没有任何 assistant tool_call 与之对应。
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] }] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>> }
    expect(payload.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  // 保序回归：正常的工具往返（每个 tool_call 都有结果）必须原样保留，
  // 清理逻辑不得误伤健康会话。
  it('keeps well-formed tool round-trips intact', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'A' }] },
          { type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'B' }] },
        ] },
      ] as never,
      signal: new AbortController().signal,
    } as never)

    const payload = JSON.parse(body!) as { messages: Array<Record<string, any>> }
    const assistant = payload.messages.find((m) => m.role === 'assistant')
    expect(assistant!.tool_calls).toHaveLength(2)
    expect(payload.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  /**
   * 抓取一次 stream() 序列化后的 messages 数组（结构化，未经 JSON 往返）。
   *
   * `overrides` 同时用于适配器构造与请求参数；`readImage` 由用例注入。
   */
  async function captureSerializedMessages(overrides: {
    messages: unknown[]
    system?: string
    readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  }): Promise<Array<Record<string, unknown>>> {
    let body: { messages: Array<Record<string, unknown>> } | undefined
    const adapter = makeAdapter({
      ...overrides.readImage !== undefined ? { readImage: overrides.readImage } : {},
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> }
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      ...overrides,
      signal: new AbortController().signal,
    } as never)
    return body!.messages
  }

  // 逐字节回归（红线）：无图历史的序列化结果必须与本次改动前**完全一致**。
  // 上游有 3906 条真实会话的配对计数作证（1761 相邻 / 291 非相邻两侧相同），
  // 本仓库用硬编码期望值钉死同一契约 —— 任何键顺序、字段增删、字符串化差异
  // 都会破坏前缀缓存（prompt_cache_key 命中的前提是前缀逐字节稳定）。
  it('无图历史的序列化逐字节不变（前缀缓存红线）', async () => {
    const messages = await captureSerializedMessages({
      system: 'You are helpful',
      messages: [
        { role: 'user', content: 'list the files' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: 'let me check' },
          { type: 'text', text: 'checking' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file.txt' }] },
        ] },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
    })
    // 该字符串是改动前实测输出的原样副本（键顺序一并锁定）。
    expect(JSON.stringify(messages)).toBe(
      '[{"role":"system","content":"You are helpful"},'
      + '{"role":"user","content":"list the files"},'
      + '{"role":"assistant","content":"checking","reasoning_content":"let me check",'
      + '"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]},'
      + '{"role":"tool","tool_call_id":"call_1","content":"file.txt"},'
      + '{"role":"user","content":"thanks"}]',
    )
  })

  // 回归（严重）：read_image 等工具把图片放在 tool-result 的 content 数组里。
  // 旧实现的两个 helper 嵌套深度不对称 —— collectImages 递归进 tool-result
  // （字节读到了），userContentParts 只看顶层（返回 undefined），于是序列化
  // 回退到 contentToText，图片**无报错、无占位符**地消失，模型只收到
  // `<path>…</path>` 元数据。
  //
  // 图片**不能**并进 `role:'tool'` 消息：OpenAI 兼容后端要求每条 tool 消息
  // 紧跟其 assistant tool_call，中间插入内容会让整个请求 400（本文件顶部
  // 记录的会话报废成因）。故挂起到其后的独立 user 消息发出。
  it('工具结果内嵌图片挂起到独立 user 消息（不并进 role:tool）', async () => {
    const messages = await captureSerializedMessages({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      messages: [
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'read_image', arguments: '{"path":"a.png"}' },
        ] },
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [
            { type: 'text', text: '<path>a.png</path>' },
            { type: 'image', attachment: { attachmentId: 'att-1' } },
          ] },
        ] },
      ],
    })

    // 工具结果文本照常走 role:'tool'，且**不含**图片块。
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '<path>a.png</path>' })
    expect(JSON.stringify(tool)).not.toContain('image_url')

    // 图片以独立 user 消息发出，带载体文本标记。
    const imageMessage = messages.find((m) => Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some((part) => part.type === 'image_url'))!
    expect(imageMessage.role).toBe('user')
    expect(imageMessage.content).toEqual([
      { type: 'text', text: 'Attached image(s) from tool result:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
  })

  // 回归（语义在移植上游 39c66ac 后收窄，但**防线保留**）：`imageUrls` 为空的
  // 或缺少某个 id 时，`[image unavailable]` 占位符必须照出，不能静默丢图。
  // 旧实现把空 Map 降级成 undefined，于是占位符被跳过 —— 同一故障两种表现。
  //
  // ⚠️ 移植后**适配器自己不再会产生空 Map**：读图返回 undefined / 抛错现在一律
  // 抛 `UNSUPPORTED_CONTENT`（见上面两条护栏），根本走不到序列化。故这里改走
  // **仍然可达**的那条路径：`collectImages` 只收 `attachmentId` 是**字符串**的
  // 附件，而 `userContentParts` 用 `String(...)` 查表 —— 非字符串 id 会被前者
  // 跳过、却被后者查不到，正是「map 存在但缺这个 id」的真实成因。
  it('图片 id 不在 imageUrls 里时留占位符（不静默丢图）', async () => {
    const messages = await captureSerializedMessages({
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'att-ok' } },
          // 数字 id：collectImages 不收它，故不会进 imageUrls。
          { type: 'image', attachment: { attachmentId: 123 } },
        ],
      }],
    })
    const user = messages.find((m) => m.role === 'user' && Array.isArray(m.content))!
    // 能读到的照常发 image_url，读不到的那张必须留占位符（不得悄悄消失）。
    expect(user.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      { type: 'text', text: '[image unavailable]' },
    ])
  })

  it('sends tools and the system prompt', async () => {
    let body: string | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        body = init?.body as string
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }] as never,
      tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object' } }],
      signal: new AbortController().signal,
    } as never)
    const payload = JSON.parse(body!) as { messages: Array<Record<string, unknown>>; tools?: unknown[] }
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' })
    expect(payload.tools).toMatchObject([{ type: 'function', function: { name: 'shell' } }])
  })
})

/** 收集流中所有 chunk；流抛错时 reject。 */
async function collectChunks(adapter: BuddyAdapter, options: never): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as unknown as Record<string, any>)
  }
  return chunks
}

/**
 * 账号池限流切换。
 *
 * 覆盖的关键行为：一个账号触发用量限制后，应逐个尝试其余可用账号，
 * **每个失败账号都要记录其限流重置时间**（UI 据此展示限流标记），
 * 只有真正试完全部候选才报"所有账号均受限"。此前实现只试一个账号
 * 就下结论，导致"UI 上还有未限流账号，对话却报全部受限"。
 */
describe('BuddyAdapter 账号池限流切换', () => {
  /** 构造 6004 频率限制响应体。resetAt 用远未来时间，避免测试随时钟漂移。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置，您也可以切换其他模型继续使用。',
    })
  }

  /**
   * 国际版（WorkBuddy）英文 6004 响应体 —— 用户报障原文。
   *
   * 与 {@link rateLimitBody} 的唯一差别是语言（以及句式）。两者都必须能
   * 触发账号切换：服务端对同一业务码返回哪种语言，取决于请求落在哪个区域。
   */
  function intlRateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: "usage exceeds frequency limit, but don't worry, your usage will reset at "
        + '2099-12-31 23:59:59 UTC+8, alternatively, you can switch to the other models to continue using it.',
      requestId: 'ffb5bd97-2036-48a0-baba-a56c6ab13c9c',
    })
  }

  /**
   * 记录 updateModelRateLimit / getAvailableAccount 调用的轻量 AccountPool 替身。
   * @param current - 会话开始时就已启用的当前账号（token 与 resolveCredential 一致）
   * @param candidates - 切换时按顺序返回的候选账号
   */
  function makePool(
    current: { id: string; token: string },
    candidates: Array<{ id: string; token: string }>,
  ) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const known = [current, ...candidates]
    const queue = [...candidates]
    return {
      recorded,
      /** 适配器用凭据内容反查账号 id。 */
      async findAccountIdByCredential(_provider: string, identity: string) {
        return known.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        const next = queue.shift()
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeCredential({ access_token: next.token }) }
      },
    }
  }

  it('逐个尝试所有账号，每个失败账号都被记录限流', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都限流，AT3 成功 —— 三个账号各试一次
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 三个账号都被尝试过，最终由 AT3 成功返回内容
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言：失败的两个账号都被记录了限流时间（UI 才能显示标记）
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    expect(pool.recorded.every((r) => r.resetAtMs > Date.now())).toBe(true)
  })

  it('全部账号限流后才报错，且错误码为不可重试的 QUOTA_EXCEEDED', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 两个账号都被记录了限流
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  it('切换到的新账号以非限流错误失败时，抛出原始错误而非"全部受限"', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        if (token === 'AT2') {
          return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
        }
        return new Response(rateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 不应被吞成 QUOTA_EXCEEDED —— 这是模型/请求错误，需要如实上报
    expect((error as LlmError).code).not.toBe('QUOTA_EXCEEDED')
    expect((error as LlmError).message).toContain('model not found')
  })

  /**
   * 国际版（WorkBuddy）英文 6004 必须同样触发账号切换。
   *
   * 历史缺陷（用户报障）：限流判定与重置时间解析都只认中文文案，而国际版
   * 返回的是英文 `usage exceeds frequency limit ... reset at <时间> UTC+8`。
   * 于是 `isRateLimited` 恒为 false，适配器**只试了当前账号就抛原始 JSON**
   * （用户看到的正是 `buddy: {"code":6004,...}`），既没切换账号，也没记录
   * 限流标记。国内版返回中文，故该缺陷只在国际版复现。
   *
   * 本用例锁死「英文 6004 → 逐个尝试其余账号 → 成功账号产出内容」的完整链路。
   */
  it('国际版英文 6004 同样触发账号切换，并记录限流标记', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [
        { id: 'acct-2', token: 'AT2' },
        { id: 'acct-3', token: 'AT3' },
      ],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: BUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        // AT1 与 AT2 都被英文 6004 拒绝，AT3 成功
        if (token === 'AT3') {
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const chunks = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)

    // 关键断言 1：确实换了账号（旧实现只会发 AT1 一次）
    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    // 关键断言 2：最终拿到内容，而不是把 6004 抛给用户
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：失败账号都被记录限流（UI 才能显示标记），且用的是真实重置时间
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(pool.recorded.every((r) => r.modelId === DEFAULT_MODEL)).toBe(true)
    // 英文报文里的重置时间是 2099 年（远未来），不能是 fallback 的「1 小时后」
    expect(pool.recorded.every((r) => r.resetAtMs > Date.parse('2090-01-01'))).toBe(true)
  })

  it('国际版英文 6004 全部账号受限时报 QUOTA_EXCEEDED（而非原始 400）', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      product: BUDDY,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(intlRateLimitBody(), { status: 400 })
      },
    })

    const error = await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 关键：错误码必须是不可重试的 QUOTA_EXCEEDED。
    // 旧实现因 HTTP 400 退化成 INVALID_REQUEST，且两个账号都被试过（证明切换生效）
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })
})

/** 端点常量供测试断言引用（避免硬编码字符串漂移）。 */
export { CHAT_API_BASE }

describe('产品参数化', () => {
  it('默认构造时 providerInfo 返回 buddy-cn', () => {
    expect(makeAdapter().providerInfo('buddy-cn')).toMatchObject({
      id: 'buddy-cn', name: 'Buddy CN',
    })
  })

  it('传入 Buddy（国际版）配置时 providerInfo 返回 buddy', () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
    })
    const info = adapter.providerInfo('buddy')
    // DSH 强制校验 info.id === 传入的 provider
    expect(info.id).toBe('buddy')
    expect(info.name).toBe('Buddy')
    expect(typeof info.name).toBe('string')
    expect(info.name.length).toBeGreaterThan(0)
  })

  it('Buddy（国际版）适配器的 listModels 使用 buddy 作为 provider 字段', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
    })
    const models = await adapter.listModels('buddy')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.provider === 'buddy')).toBe(true)
  })

  it('Buddy（国际版）适配器请求带 X-Product-Code: workbuddy（协议值不随改名变化）', async () => {
    let productCode: string | null = null
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
      fetchImpl: async (_url, init) => {
        productCode = (init?.headers as Headers).get('X-Product-Code')
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    // provider id 是 `buddy`，但出站归属头仍是 `workbuddy`。
    expect(productCode).toBe('workbuddy')
  })

  // ── 以下为补充用例：brief 的 4 条未能覆盖 UA、注册路由与默认回退 ──

  it('默认构造的适配器使用 CodeBuddy 的产品码与 User-Agent', async () => {
    let seen: Headers | undefined
    const adapter = makeAdapter({
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe(BUDDY_CN.productCode)
    expect(seen!.get('User-Agent')).toBe(BUDDY_CN.userAgent)
    // X-Product 是**归属名**（产品名），不是部署类型。
    expect(seen!.get('X-Product')).toBe('CodeBuddy')
    // 归属头族：后台「使用端」列按这组头归因。
    expect(seen!.get('X-Agent-Purpose')).toBe('conversation')
    expect(seen!.get('X-IDE-Name')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Type')).toBe('CodeBuddy')
    expect(seen!.get('X-IDE-Version')).toBe(BUDDY_CN.clientVersion)
  })

  it('WorkBuddy 适配器使用自身 product 的 productCode、User-Agent 与 providerInfo 展示名', async () => {
    // deepseek-v4-flash 不命中任何模型族规则 → 回落到 product.userAgent，
    // 故注入自定义 UA 的 product 仍能被观测到。
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/7.7.7' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('X-Product-Code')).toBe('workbuddy')
    expect(seen!.get('User-Agent')).toBe('WorkBuddy/7.7.7')
    expect(seen!.get('X-Product')).toBe('WorkBuddy')
    expect(seen!.get('X-IDE-Name')).toBe('WorkBuddy')
    expect(adapter.providerInfo('buddy').name).toBe(BUDDY.displayName)
  })

  it('send() 的 User-Agent 取自 product 而非固定常量', async () => {
    // 反向验证：默认 CodeBuddy 的 UA 与注入值必须不同，否则该断言无意义。
    const custom: BuddyProduct = { ...BUDDY_CN, userAgent: 'CustomAgent/9.9.9' }
    expect(custom.userAgent).not.toBe(BUDDY_CN.userAgent)
    let seen: Headers | undefined
    const adapter = makeAdapter({
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    expect(seen!.get('User-Agent')).toBe('CustomAgent/9.9.9')
  })

  // ── 按模型族分档的 User-Agent ──

  it('WorkBuddy 的 UA 按模型族分档：GPT 系走国际版形态，GLM 系走国内形态', async () => {
    const uaFor = async (model: string): Promise<string | null> => {
      let seen: Headers | undefined
      const adapter = new BuddyAdapter({
        credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
        resolveCredential: async () => makeCredential(),
        refresh: async () => {},
        product: BUDDY,
        fetchImpl: async (_url, init) => {
          seen = new Headers(init?.headers as HeadersInit)
          return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        },
      })
      await collectChunks(adapter, {
        model,
        messages: [{ role: 'user', content: 'hi' }] as never,
        signal: new AbortController().signal,
      } as never)
      return seen!.get('User-Agent')
    }

    // 国际版独有模型线 → 国际版形态（平台段为 `WorkBuddy AI`）。
    expect(await uaFor('gpt-5.6-sol')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    expect(await uaFor('gemini-3.5-flash')).toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
    // 国内系模型 → 国内客户端形态（平台段为 `WorkBuddy`）。
    expect(await uaFor('glm-5.2')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('hy3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    expect(await uaFor('kimi-k3')).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
    // 未命中任何模型族规则 → 回落到 product.userAgent（默认国际版形态）。
    expect(await uaFor('deepseek-v4.1-flash')).toBe(BUDDY.userAgent)
  })

  it('分档后的 UA 仍含产品品牌字样，不会退化成框架的 harness UA', async () => {
    // 归因前提：腾讯后台按出站 UA 归因「使用端」，UA 必须含 WorkBuddy/CodeBuddy 字样。
    const custom: BuddyProduct = { ...BUDDY, userAgent: 'WorkBuddy/9.9.9' }
    let seen: Headers | undefined
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: custom,
      fetchImpl: async (_url, init) => {
        seen = new Headers(init?.headers as HeadersInit)
        return sseResponse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      },
    })
    await collectChunks(adapter, {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)
    const ua = seen!.get('User-Agent')!
    expect(ua).toContain('WorkBuddy')
    expect(ua).not.toContain('deepseek-harness')
  })

  it('providerInfo 对非字符串入参回退到本产品的 id', () => {    // 上游传入 undefined 时不得让 deriveKeyRef 的 toUpperCase 崩在客户端。
    const workbuddy = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
    })
    expect(workbuddy.providerInfo(undefined as never).id).toBe('buddy')
    expect(makeAdapter().providerInfo('' as never).id).toBe(BUDDY_CN.id)
  })

  /** 记录注册入参的假 llm 服务。 */
  function makeLlm() {
    const providers: Array<{ provider: string; displayName: string; settingsNs: string }> = []
    const adapters: string[][] = []
    const instances: unknown[] = []
    return {
      providers,
      adapters,
      instances,
      llm: {
        registerConfigurableProviders(entries: Array<{ provider: string; displayName: string; settingsNs: string }>) {
          providers.push(...entries)
          return { replace: () => {} }
        },
        registerAdapter(names: string[], adapter: unknown) {
          adapters.push(names)
          instances.push(adapter)
          return { replace: () => {} }
        },
      },
    }
  }

  it('registerBuddyLlm 默认注册 buddy 路由与 llm-buddy-cn 命名空间', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
    })
    expect(fake.providers).toEqual([
      { provider: 'buddy-cn', displayName: BUDDY_CN.displayName, settingsNs: 'llm-buddy-cn', settingsPath: [] },
    ])
    expect(fake.adapters).toEqual([['buddy-cn']])
  })

  it('registerBuddyLlm 传入 WorkBuddy 时注册 workbuddy 路由与 llm-buddy 命名空间', () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
    })
    // CodeBuddy 必须仍是 llm-buddy-cn（与现状一致），WorkBuddy 得到 llm-buddy。
    expect(fake.providers).toEqual([
      { provider: 'buddy', displayName: BUDDY.displayName, settingsNs: 'llm-buddy', settingsPath: [] },
    ])
    expect(fake.adapters).toEqual([['buddy']])
  })

  it('registerBuddyLlm 注册的适配器与其路由使用同一产品', async () => {
    const fake = makeLlm()
    registerBuddyLlm({ llm: fake.llm } as never, {
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
    })
    // 注册进 llm 的适配器实例必须自己就是 WorkBuddy 产品（而非 CodeBuddy），
    // 否则路由名为 workbuddy 却发 codebuddy 的身份标识。
    const adapter = fake.instances[0] as BuddyAdapter
    expect(adapter.providerInfo('buddy')).toMatchObject({ id: 'buddy', name: BUDDY.displayName })
    expect((await adapter.listModels('buddy')).every((m) => m.provider === 'buddy')).toBe(true)
  })
})

/**
 * 账号池 provider 实参。
 *
 * 适配器调用账号池时必须传「本适配器所属产品的 id」，而不是写死的 'buddy-cn'。
 * AccountPool 内部先按 `entry.provider !== provider` 过滤账号，WorkBuddy 账号的
 * provider 是 'buddy'，传 'buddy-cn' 会永远匹配不到：
 *   - findAccountIdByCredential 恒返回 '' → 限流重置时间无法归属账号 → UI 永不显示限流标记；
 *   - getAvailableAccount 恒返回 null → 限流后无法自动切换账号。
 * 即 WorkBuddy 的账号池功能（限流归属 + 自动切换）会完全失效。
 */
describe('BuddyAdapter 向账号池传递的 provider', () => {
  /** 6004 频率限制响应体（resetAt 取远未来，避免测试随时钟漂移）。 */
  function rateLimitBody(): string {
    return JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2099-12-31 23:59:59 UTC+8 重置',
    })
  }

  /**
   * 记录被查询 provider 的账号池替身。
   * @returns queried - 按调用顺序记录 findAccountIdByCredential / getAvailableAccount 收到的 provider
   */
  function makeRecordingPool() {
    const queried: string[] = []
    return {
      queried,
      async listAccounts() {
        return []
      },
      async findAccountIdByCredential(provider: string) {
        queried.push(provider)
        return 'acct-current'
      },
      async updateModelRateLimit() {},
      async getAvailableAccount(provider: string) {
        queried.push(provider)
        return null
      },
    }
  }

  it('WorkBuddy 适配器以 workbuddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: BUDDY,
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 两条路径都被走到；且都必须是 'buddy'，出现 'buddy-cn' 即为回归。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.filter((p) => p === 'buddy').length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'buddy')).toBe(true)
  })

  it('CodeBuddy 适配器仍以 buddy 作为 provider 查询账号池', async () => {
    const pool = makeRecordingPool()
    // 不传 product：适配器回退到 CodeBuddy，provider 应为 'buddy-cn'。
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async () => new Response(rateLimitBody(), { status: 400 }),
    })
    expect(adapter.providerInfo('buddy-cn').id).toBe(BUDDY_CN.id)

    await collectChunks(adapter, {
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never).catch(() => {})

    // 对称性防守：修 WorkBuddy 时不得把 CodeBuddy 也改成 workbuddy。
    expect(pool.queried.length).toBeGreaterThanOrEqual(2)
    expect(pool.queried.every((p) => p === 'buddy-cn')).toBe(true)
  })
})

describe('产品兜底模型目录校正', () => {
  /** 造一个只有 2 个模型的假产品，便于精确断言校正行为。 */
  const fakeProduct = {
    ...BUDDY,
    fallbackModels: [
      { id: 'wanted-a', name: 'Wanted A', contextWindow: 111_000 },
      { id: 'wanted-b', name: 'Wanted B', contextWindow: 222_000 },
    ],
  }

  it('远端多出来的条目被丢弃（只保留兜底表声明的）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      // 远端返回的是残缺/错误的集合（多出的 junk 与缺失的 wanted-b）
      fetchRemoteModels: async () => [{ id: 'junk', name: 'Junk' }, { id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
  })

  it('兜底表声明但远端缺失的条目被补进来', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [{ id: 'wanted-a', name: 'Wanted A' }],
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    // 补齐的条目用兜底表的名称
    expect(models[1]!.name).toBe('Wanted B')
  })

  it('远端元数据优先于兜底表（远端更权威）', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [
        { id: 'wanted-a', name: 'Remote A', contextWindow: 999_000 },
      ],
    })
    const models = await adapter.listModels('buddy')
    expect(models[0]!.name).toBe('Remote A')
    const resolved = await adapter.resolveModel('buddy', 'wanted-a')
    expect(resolved.name).toBe('Remote A')
    expect(resolved.context?.contextWindow).toBe(999_000)
  })

  it('远端不可用时用兜底表的名称与上下文窗口', async () => {
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: fakeProduct as never,
      fetchRemoteModels: async () => [],
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(['wanted-a', 'wanted-b'])
    const resolved = await adapter.resolveModel('buddy', 'wanted-b')
    expect(resolved.name).toBe('Wanted B')
    expect(resolved.context?.contextWindow).toBe(222_000)
  })

  it('没有兜底表的产品不受影响（保持既有远端行为）', async () => {
    const noFallback = { ...BUDDY, fallbackModels: undefined }
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeCredential(),
      refresh: async () => {},
      product: noFallback as never,
      fetchRemoteModels: async () => [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }],
    })
    const models = await adapter.listModels('buddy')
    expect(models.map((m) => m.id)).toEqual(['x', 'y'])
  })
})

/**
 * 模型黑名单对 listModels 的过滤。
 *
 * 这是「关闭开关 → 对话框不再显示该模型」这条链路的关键一环：
 * /api/session 的模型目录正是通过 ctx.llm.listModels() → 适配器 listModels()
 * 构建的。此处断言适配器确实把黑名单里的模型摘掉了。
 */
describe('BuddyAdapter 模型黑名单', () => {
  /**
   * 只实现 listModels / resolveModel 所需方法的账号池替身。
   *
   * `contextBudget` 是 `resolveModel` 读档位预算的入口（未接线时返回 undefined =
   * 默认档）。缺了它 `resolveModel` 会以 `contextBudget is not a function` 抛错 ——
   * 那测的就不是路由能力了。
   */
  function poolWithDisabled(provider: string, ids: string[]) {
    const disabled = new Set(ids)
    return {
      disabledModelsFor: (value: string) => (value === provider ? disabled : new Set<string>()),
      contextBudget: () => undefined,
    } as never
  }

  it('被关闭的模型从列表中消失，其余保持原有顺序', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy-cn', ['glm-5.2', 'hy3']) })
    const models = await adapter.listModels('buddy-cn')
    const ids = models.map((m) => m.id)

    expect(ids).not.toContain('glm-5.2')
    expect(ids).not.toContain('hy3')
    // 未关闭的模型一个都不能少，且顺序不变（顺序即选择器的展示顺序）
    expect(ids).toEqual(
      BUDDY_CN.fallbackModels!.map((m) => m.id).filter((id) => id !== 'glm-5.2' && id !== 'hy3'),
    )
  })

  it('空黑名单不改变列表（默认全开）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy-cn', []) })
    const models = await adapter.listModels('buddy-cn')
    expect(models.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
  })

  it('没有账号池时不过滤（适配器可脱离账号池使用）', async () => {
    const models = await makeAdapter().listModels('buddy-cn')
    expect(models.map((m) => m.id)).toEqual(BUDDY_CN.fallbackModels!.map((m) => m.id))
  })

  it('黑名单按产品 id 隔离：workbuddy 的关闭项不影响 buddy', async () => {
    const adapter = makeAdapter({
      accountPool: {
        // 只对 workbuddy 报告黑名单
        disabledModelsFor: (value: string) => (value === 'buddy' ? new Set(['glm-5.2']) : new Set<string>()),
        contextBudget: () => undefined,
      } as never,
    })
    const ids = (await adapter.listModels('buddy-cn')).map((m) => m.id)
    expect(ids).toContain('glm-5.2')
  })

  it('关闭不影响 resolveModel/stream 的路由能力（目录只是建议性的）', async () => {
    const adapter = makeAdapter({ accountPool: poolWithDisabled('buddy-cn', ['glm-5.2']) })
    // listModels 里已消失……
    expect((await adapter.listModels('buddy-cn')).map((m) => m.id)).not.toContain('glm-5.2')
    // ……但仍可解析元数据（DSH 契约要求目录缺省不构成请求拒绝）
    const resolved = await adapter.resolveModel('buddy-cn', 'glm-5.2')
    expect(resolved.id).toBe('glm-5.2')
    // 兜底表口径是最大档（CN 的 1M 系 → 1M）。
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })
})
