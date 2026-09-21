/**
 * Qoder CN **chat 接入 wasm 签名路径**的单测（全 mock，零网络）。
 *
 * ## 本文件守的是什么
 *
 * CN 的 chat 曾经只能打 `/model/v1/chat/completions`，而那条 REST 路径在 CN 网关**不存在**（ALB 按路径级恒
 * 503，二次取证定案，见 `qoder-errors.ts` 的 7a 条），官方客户端走的是 `/algo/api/v2/service/pro/sse/agent_chat_generation`
 * 且**必须整包带 wasm 签名**。接线后 CN 的发送路径从「REST + jt」换成
 * 「wasm 签名三件套」，本文件把这个替换的**每个必要环节**钉死：
 *
 * 1. **整包替换**（URL + headers + body **全部**来自签名结果，不许混用）；
 * 2. **`hostBase` 是 host 基址**（传完整 URL 会得到路径重复两遍的 URL，实测）；
 * 3. **`modelKey` / `modelSource` 与官方同源**（`model_config?.key ?? "unknown"` /
 *    `model_config?.source ?? "system"`）；
 * 4. **国际版一个字节都不动**（REST + jt，逐字节回归）；
 * 5. **字节闸量的是明文**（不是密文，密文长度由 wasm 决定、不可控）；
 * 6. **uid 拿不到就不签**（真机 A/B：空 uid 恒回 `101`）。
 *
 * ## 为什么 `modelSource` 恒为 `"system"`
 *
 * `buildQoderChatBody` **不下发 `model_config`**（Qoder 的 REST body 没有这个字段），
 * 故官方那两行 `??` 兜底必然生效：`modelKey = options.model`、`modelSource = "system"`。
 * 官方三值域是 `system` / `user` / `custom`（`PIe` / `prA` / `U2`）——
 * ⚠️ 曾经的探针记录里写过一个 `solo_work_remote`，那是 **Trae 的 function 名**，
 * 与 Qoder 无关，**不得**出现在这里。
 *
 * ## 注入面为何是 `contextFor` + `prepareInferRequest` 两层
 *
 * 与 `src/qoder-wasm-context.ts` 的真实形状逐层对应（`QoderWasmSigner.contextFor`
 * → `QoderSigningContext.prepareInferRequest`）。四参数由**适配器**给出而不是
 * 藏在 provider 里面：`hostBase` / `modelKey` / `modelSource` 的取值正确性正是
 * 本文件要钉死的东西，把它们埋进 provider 就没法断言了。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { QoderAdapter, buildQoderChatBody } from '../../src/qoder-adapter.js'
import type { QoderAdapterOptions } from '../../src/qoder-adapter.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import type { QoderCredential } from '../../src/qoder-product.js'
import { QODER_MAX_REQUEST_BYTES } from '../../src/qoder-errors.js'
import { QoderWasmUnavailableError } from '../../src/qoder-wasm.js'
import { QODER_SIGNED_CHAT_PATH } from '../../src/qoder-wasm-context.js'
import type { QoderInferRequest } from '../../src/qoder-wasm-context.js'
import type { QoderSigningSource } from '../../src/qoder-signing.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
/** 一个形态完整的 CN 凭据（PAT 本体在 `access_token`）。 */
const CREDENTIAL: QoderCredential = {
  access_token: 'pt-cn-signed-token',
  refresh_token: 'jrt-test',
  token_expires_at: '0',
}

/** 一段标准的 OpenAI SSE（签名路径返回的形态与 REST 完全相同）。 */
const SIGNED_STREAM = 'data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\n'
  + 'data: {"choices":[{"index":0,"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n'
  + 'data: [DONE]\n\n'

/** 造一份 SSE 响应。 */
function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 一次签名的入参记录（四参数 + 凭据两件）。
 *
 * 三件套的每个值都刻意与原请求不同（URL host 是 `signed.example.test`、
 * 头里带 `X-Signed-Marker`、body 是 `CIPHERTEXT`），这样「整包替换」的断言就能
 * 通过「旧值一个都不剩」来证明，而不是只看新值在不在。
 */
interface SignCall {
  pat: string
  jobToken: string
  hostBase?: string
  body?: string
  modelKey?: string
  modelSource?: string
}

/** 假的签名来源 —— 记录每次 `contextFor` 与 `prepareInferRequest` 的入参。 */
function makeSigningSource(overrides: {
  contextFor?: (pat: string, jobToken: string) => Promise<{ prepareInferRequest: QoderSigningSource['prepareInferRequest'] }>
  prepareInferRequest?: QoderSigningSource['prepareInferRequest']
} = {}) {
  const calls: SignCall[] = []
  const source: QoderSigningSource = {
    contextFor: async (pat: string, jobToken: string) => {
      const record: SignCall = { pat, jobToken }
      calls.push(record)
      if (overrides.contextFor) return overrides.contextFor(pat, jobToken)
      return {
        prepareInferRequest: overrides.prepareInferRequest ?? ((hostBase, body, modelKey, modelSource) => {
          record.hostBase = hostBase
          record.body = body
          record.modelKey = modelKey
          record.modelSource = modelSource
          return {
            url: `https://signed.example.test${QODER_SIGNED_CHAT_PATH}`
              + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
            headers: new Map<string, string>([
              ['Authorization', 'Bearer COSY.signed-blob'],
              ['Cosy-Key', 'signed-key'],
              ['Cosy-Date', '2026-09-21T00:00:00Z'],
              ['X-Signed-Marker', 'yes'],
            ]),
            body: 'CIPHERTEXT',
            free: () => {},
          } satisfies QoderInferRequest
        }),
      }
    },
    dispose: () => {},
  }
  return { source, calls }
}

/** 组装适配器选项。 */
function adapterOptions(overrides: Partial<QoderAdapterOptions> = {}): QoderAdapterOptions {
  const { source } = makeSigningSource()
  return {
    credentialRef: 'QODER_CN_PERSONAL_TOKEN' as QoderAdapterOptions['credentialRef'],
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    getJobToken: async () => 'jt-cn-test',
    invalidateJobToken: () => {},
    fetchRemoteModels: async () => [],
    product: QODER_CN,
    signing: source,
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
 * 跑一次 stream 并收集正文（抛出时返回 null）。
 *
 * ⚠️ 正文块的类型是 **`text-delta`**（不是 `text`）—— 与
 * `qoder-adapter.spec.ts` 的 `textOf` 同口径：正文是「块开始 + 增量」两段式，
 * 拼正文只能累加 `text-delta`。
 */
async function runStream(adapter: QoderAdapter, options: never): Promise<string | null> {
  const chunks = await chunksOf(adapter, options)
  if (chunks === null) return null
  return chunks
    .filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

/** 跑一次 stream，返回抛出的错误（无错时返回 null）。 */
async function errorOf(adapter: QoderAdapter, options: never): Promise<(Error & { code?: string }) | null> {
  try {
    for await (const _chunk of adapter.stream(options)) { /* noop */ }
    return null
  } catch (caught) {
    return caught as Error & { code?: string }
  }
}

/** 跑一次 stream，返回**全部 chunk**（抛出时返回 null）。 */
async function chunksOf(adapter: QoderAdapter, options: never): Promise<StreamChunk[] | null> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return chunks
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 签名三件套整包替换
// ─────────────────────────────────────────────────────────────────────────────

describe('CN chat：签名三件套**整包替换**原请求', () => {
  it('URL 用签名结果，且**不含** REST 路径（不是「补个头」）', async () => {
    const urls: string[] = []
    const fetcher = (async (url: unknown) => {
      urls.push(String(url))
      return sseResponse(SIGNED_STREAM)
    }) as unknown as typeof fetch
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))

    expect(await runStream(adapter, generateOptions())).toBe('Hello world')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('signed.example.test')
    expect(urls[0]).toContain(QODER_SIGNED_CHAT_PATH)
    // ⚠️ REST 路径必须**消失**：混着发就是「只补签名头」的形态，真机必回 101。
    expect(urls[0]).not.toContain('/model/v1/chat/completions')
    expect(urls[0]).not.toContain(QODER_CN.chatBase)
  })

  it('headers 用签名结果：`Authorization: Bearer COSY.…`，**没有** `Bearer jt-`', async () => {
    const headers: Array<Record<string, string>> = []
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return sseResponse(SIGNED_STREAM)
    }) as unknown as typeof fetch
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))
    await runStream(adapter, generateOptions())

    const sent = headers[0]!
    expect(sent.Authorization).toBe('Bearer COSY.signed-blob')
    expect(sent['Cosy-Key']).toBe('signed-key')
    expect(sent['X-Signed-Marker']).toBe('yes')
    // ⚠️ jt 形态与 REST 专有头**一个都不许留**（混用 = 未真正走签名路径）。
    expect(JSON.stringify(sent)).not.toContain('jt-cn-test')
    expect(sent['User-Agent']).toBeUndefined()
    expect(sent['Content-Type']).toBeUndefined()
    // 签名头集就是权威，逐键与签名结果一致（不多不少）。
    expect(Object.keys(sent)).toEqual([
      'Authorization', 'Cosy-Key', 'Cosy-Date', 'X-Signed-Marker',
    ])
  })

  it('body 用签名结果的**密文**（明文一个字节都不发）', async () => {
    const bodies: string[] = []
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return sseResponse(SIGNED_STREAM)
    }) as unknown as typeof fetch
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))
    await runStream(adapter, generateOptions())

    expect(bodies[0]).toBe('CIPHERTEXT')
    // 明文 body 里的特征串（client_type / 消息正文 / 模型名）不得出现在出站 body 里。
    expect(bodies[0]).not.toContain('client_type')
    expect(bodies[0]).not.toContain('qmodel_38max')
  })

  it('方法仍是 `POST`，并透传 `options.signal`（取消语义不变）', async () => {
    const seen: Array<{ method?: string; signal?: unknown }> = []
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ method: init?.method, signal: init?.signal })
      return sseResponse(SIGNED_STREAM)
    }) as unknown as typeof fetch
    const controller = new AbortController()
    const adapter = new QoderAdapter(adapterOptions({ fetchImpl: fetcher }))
    await runStream(adapter, generateOptions({ signal: controller.signal }))

    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.signal).toBe(controller.signal)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 传给签名算子的四个参数（官方 ari() 同源）
// ─────────────────────────────────────────────────────────────────────────────

describe('CN chat：签名入参与官方 ari() 同源', () => {
  it('`hostBase` 是 **host 基址**（传完整 URL 会路径重复两遍）', async () => {
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      signing: source,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
    }))
    await runStream(adapter, generateOptions())

    const call = calls[0]!
    expect(call.hostBase).toBe('https://gateway.qoder.com.cn')
    expect(call.hostBase).toBe(QODER_CN.chatBase)
    // ⚠️ host 基址**不带路径**：带上就会得到
    // `…/agent_chat_generation/…/agent_chat_generation`（实测）。
    expect(call.hostBase).not.toContain('/algo/')
    expect(call.hostBase).not.toContain(QODER_SIGNED_CHAT_PATH)
    expect(call.hostBase).not.toContain('/model/v1/chat/completions')
  })

  it('`modelKey` 取 `options.model`（body 无 model_config ⇒ 官方 `?? "unknown"` 的等价物）', async () => {
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      signing: source,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
    }))
    await runStream(adapter, generateOptions({ model: 'qmodel_38max' }))
    expect(calls[0]!.modelKey).toBe('qmodel_38max')
  })

  it('`modelSource` 恒为 **"system"**（⚠️ 不是 Trae 的 `solo_work_remote`）', async () => {
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      signing: source,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
    }))
    await runStream(adapter, generateOptions())
    expect(calls[0]!.modelSource).toBe('system')
    // 反向：那个错值绝不能出现（它是另一个 provider 的 function 名）。
    expect(calls[0]!.modelSource).not.toBe('solo_work_remote')
  })

  it('`body` 是**明文**，与 `buildQoderChatBody` 的产物逐字节相同（加密是签名算子的事）', async () => {
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      signing: source,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
    }))
    const options = generateOptions()
    await runStream(adapter, options)
    expect(calls[0]!.body).toBe(buildQoderChatBody(options as never, QODER_CN))
  })

  it('pat / jt 两件都交给签名来源（userinfo 与身份派生都要用）', async () => {
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      signing: source,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
    }))
    await runStream(adapter, generateOptions())
    expect(calls.map(({ pat, jobToken }) => ({ pat, jobToken })))
      .toEqual([{ pat: 'pt-cn-signed-token', jobToken: 'jt-cn-test' }])
    // 给的是 PAT 本体（不是 jt）—— userinfo 与 userInfoJson 的派生化都要它。
    expect(calls[0]!.pat).toBe(CREDENTIAL.access_token)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 国际版零变化（反向回归，逐字节）
// ─────────────────────────────────────────────────────────────────────────────

describe('国际版 REST 路径**逐字节不变**（反向回归）', () => {
  it('URL / headers / body 与接线前完全一致，且一次签名都不发生', async () => {
    const captured: Array<{ url: string; init: RequestInit }> = []
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} })
      return sseResponse(SIGNED_STREAM)
    }) as unknown as typeof fetch

    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      product: QODER,
      fetchImpl: fetcher,
      signing: source,
    }))
    const options = generateOptions({ provider: 'qoder', model: 'lite' })
    await runStream(adapter, options)

    // ① URL 是 REST 路径。
    expect(captured[0]!.url).toBe(`${QODER.chatBase}/model/v1/chat/completions`)
    // ② headers 是 jt 形态（与国际版接线前逐字节相同）。
    expect(captured[0]!.init.headers).toEqual({
      Authorization: 'Bearer jt-cn-test',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': QODER.userAgent,
    })
    // ③ body 是明文 chat body。
    expect(captured[0]!.init.body).toBe(buildQoderChatBody(options, QODER))
    // ④ **一次签名都没发生**（国际版没走签名路径）。
    expect(calls).toHaveLength(0)
  })

  it('国际版**不消费** `signing` 注入（即使注入了也不用）', async () => {
    const prepare = vi.fn()
    const adapter = new QoderAdapter(adapterOptions({
      product: QODER,
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
      signing: {
        contextFor: async () => ({ prepareInferRequest: prepare }),
        dispose: () => {},
      } as never,
    }))
    await runStream(adapter, generateOptions({ provider: 'qoder' }))
    expect(prepare).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 本地字节闸：量**明文**，对 CN 同样生效
// ─────────────────────────────────────────────────────────────────────────────

describe('本地字节闸：量的是**明文** body（签名之前）', () => {
  /**
   * 造一个「明文 body 恰好 N 字节」的 options。
   *
   * 与 `qoder-adapter.spec.ts` 的同名 helper 同口径：先量空正文的固定开销，
   * 再补足正文 —— 这样「恰好等于阈值」是精确构造的。
   */
  function optionsWithBodyBytes(target: number): never {
    const empty = generateOptions({
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    })
    const base = Buffer.byteLength(buildQoderChatBody(empty as never, QODER_CN), 'utf8')
    return generateOptions({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(target - base) }] }],
    })
  }

  it('CN 明文达阈值（245 760 B）：**不发请求**、也不签名，直接 CONTEXT_WINDOW_EXCEEDED', async () => {
    const fetcher = vi.fn(async () => sseResponse(SIGNED_STREAM))
    const { source, calls } = makeSigningSource()
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
      signing: source,
    }))
    const options = optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES)
    expect(Buffer.byteLength(buildQoderChatBody(options as never, QODER_CN), 'utf8'))
      .toBe(QODER_MAX_REQUEST_BYTES)

    const error = await errorOf(adapter, options)
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 本功能的**全部意义**：请求没发出去。
    expect(fetcher).not.toHaveBeenCalled()
    // 拦在签名**之前** —— 没必要为一个必被拦下的请求先跑一遍 wasm。
    expect(calls).toHaveLength(0)
  })

  it('CN 明文阈值下一字节：放行（闸门不误伤）', async () => {
    const fetcher = vi.fn(async () => sseResponse(SIGNED_STREAM))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
    }))
    expect(await runStream(adapter, optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES - 1)))
      .toBe('Hello world')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('**密文再大也不拦**（闸门只量明文；密文长度由 wasm 决定、不可控）', async () => {
    // 造一个密文远超阈值、明文在阈值内的签名结果。
    const hugeCiphertext = 'C'.repeat(QODER_MAX_REQUEST_BYTES * 2)
    const { source } = makeSigningSource({
      prepareInferRequest: () => ({
        url: `https://signed.example.test${QODER_SIGNED_CHAT_PATH}`,
        headers: new Map([['Authorization', 'Bearer COSY.x']]),
        body: hugeCiphertext,
        free: () => {},
      }),
    })
    const fetcher = vi.fn(async () => sseResponse(SIGNED_STREAM))
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: fetcher as unknown as typeof fetch,
      signing: source,
    }))

    expect(await runStream(adapter, optionsWithBodyBytes(QODER_MAX_REQUEST_BYTES - 1)))
      .toBe('Hello world')
    // 密文原样发出（放行了就是放行，不再二次判断）。
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. 失败形态：签名相关错误直报
// ─────────────────────────────────────────────────────────────────────────────

describe('CN chat：签名路径的失败形态', () => {
  it('wasm 不可用 ⇒ **直报**（不换号、不退避），文案带各级尝试原因', async () => {
    const attempts = [
      { source: 'local-install' as const, detail: 'D:\\Qoder CN\\…worker-runtime.obf.mjs', ok: false, error: '文件不存在' },
      { source: 'npm-tarball' as const, detail: '@qodercn-ai/qoderclicn', ok: false, error: 'HTTP 404' },
      { source: 'cdn-tarball' as const, detail: 'https://download.qoder.com/…', ok: false, error: '超时' },
    ]
    const unavailable = new QoderWasmUnavailableError(attempts)
    const poolCalls: string[] = []
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
      signing: {
        contextFor: async () => { throw unavailable },
        dispose: () => {},
      } as never,
      accountPool: {
        getAvailableAccount: async () => { poolCalls.push('call'); return undefined },
        findAccountIdByCredential: async () => 'acct-1',
      } as never,
    }))

    const error = await errorOf(adapter, generateOptions())
    expect(error).toBeInstanceOf(Error)
    // 组件缺失是**环境问题**，换号/退避都救不了 ⇒ 直报 + 不可重试。
    expect(error!.code).toBe('INVALID_REQUEST')
    expect(error!.message).toContain('未找到 Qoder 签名组件')
    // 三级尝试的原因都要在（否则用户不知道该修哪一级）。
    expect(error!.message).toContain('文件不存在')
    expect(error!.message).toContain('HTTP 404')
    expect(error!.message).toContain('超时')
    expect(poolCalls).toEqual([])
  })

  it('uid 取不到（签名来源抛错）⇒ 原样上抛，**不伪装成凭据失效**', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(SIGNED_STREAM)) as unknown as typeof fetch,
      signing: {
        contextFor: async () => { throw new Error('Qoder 取 userinfo 失败（HTTP 401）') },
        dispose: () => {},
      } as never,
    }))
    const error = await errorOf(adapter, generateOptions())
    expect(error!.message).toContain('userinfo')
    // ⚠️ 判成 AUTH 会把用户引向「重新贴 PAT」，而真因可能是端点/网络。
    expect(error!.code).not.toBe('AUTH')
  })

  it('签名路径的 `101 Signature invalid` 流内帧 ⇒ 直报 + 中文提示重新登录', async () => {
    // ⚠️ 帧形态照抄真机：`code` / `message` **平铺在根层**（与 `invalid_model_error`
    // 同形），且**带 `event: error`** —— 适配器按 `event:` 字段判错，裸的
    // `data: {"code":"101"}` 不会被当成错误帧（那会退化成「无内容块」）。
    const frame = 'event: error\n'
      + 'data: {"code":"101","message":"Signature invalid","request_id":"req-1"}\n\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(frame)) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())

    expect(error!.code).toBe('INVALID_REQUEST')
    expect(error!.message).toContain('Signature invalid')
    expect(error!.message).toContain('重新登录')
  })

  it('签名路径的**未知**业务码照旧直报，不猜动作', async () => {
    const frame = 'event: error\n'
      + 'data: {"code":"9999","message":"something new"}\n\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(frame)) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())

    expect(error!.code).toBe('INVALID_REQUEST')
    expect(error!.message).toContain('9999')
    expect(error!.message).toContain('something new')
    // 不许编造「签名」相关的解释（那会误导用户去重新登录）。
    expect(error!.message).not.toContain('重新登录')
    expect(error!.message).not.toContain('签名失效')
  })

  it('嵌套形态（`error` 对象里带 code/message）同样识别为签名失效', async () => {
    // 上游两种信封形态都出现过（见 qoder-errors.ts 的形态 A / B），
    // 签名帧不保证只用平铺那一种。
    const frame = 'data: {"error":{"code":"101","message":"Signature invalid"},'
      + '"id":"chatcmpl-1"}\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(frame)) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())

    // 载荷里带 `error` 结构即判错（不需要 `event:` 行）。
    expect(error!.message).toContain('Signature invalid')
    expect(error!.message).toContain('重新登录')
  })

  it('`HTTP 200` + 空 body（无 `[DONE]`）仍报缺 `[DONE]`，不静默当成功', async () => {
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse('')) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())
    expect(error!.message).toContain('[DONE]')
  })

  // ── 真机帧形态：**外层信封**（2026-09-21 真机实录夹具） ──
  //
  // ⚠️ 签名路径的帧**不是**裸 OpenAI chunk，而是再包一层信封：
  //
  //     data:{"headers":{"Content-Type":["application/json"]},
  //           "body":"{\"choices\":[…]}",          ← 内层是 **JSON 字符串**（要再 parse）
  //           "statusCodeValue":200,"statusCode":"OK"}
  //
  // 接线前假设「签名路径返回标准 OpenAI SSE，可复用同一消费器」—— 真机推翻了
  // 后半句：**协议是同一套**（内层确实是标准 OpenAI chunk），但**多了一层信封**，
  // 于是原消费器一帧都认不出来（`choices` 不在根层），表现为
  // 「Stream ended without [DONE]（流未产出任何内容即结束）」。
  //
  // 夹具 `tests/unit/fixtures/qoder-cn-signed-sse.sse.txt` 是真机响应的逐字节
  // 副本（内容只有一句 "pong"，无凭据；`event:finish` 尾帧一并保留）。

  it('真机信封帧：正文 / 思考 / 用量 / 收尾四项都从 `body` 内层解析出来', async () => {
    const raw = readFileSync(
      new URL('./fixtures/qoder-cn-signed-sse.sse.txt', import.meta.url), 'utf8',
    )
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(raw)) as unknown as typeof fetch,
    }))
    const chunks = await chunksOf(adapter, generateOptions())
    expect(chunks, '信封帧必须能被解析（否则整条流会以「未产出内容」告终）').not.toBeNull()

    const kinds = chunks!.map((chunk) => chunk.type)
    const text = chunks!
      .filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
      .map((chunk) => chunk.text).join('')
    const thought = chunks!
      .filter((chunk): chunk is { type: 'reasoning-delta'; index: number; text: string } => chunk.type === 'reasoning-delta')
      .map((chunk) => chunk.text).join('')
    const usage = chunks!.filter((chunk) => chunk.type === 'usage').pop() as
      { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } | undefined

    // 正文：真机回了 `"content":"pong"`。
    expect(text).toBe('pong')
    // 思考：真机回了一串 `reasoning_content` 增量，拼接后是整句。
    expect(thought).toContain('only reply pong')
    expect(kinds).toContain('block-start')
    expect(kinds).toContain('finish')
    // 用量帧：`choices:[]` + `usage`（内层），三项 token 都要读出来。
    expect(usage).toBeDefined()
    expect(usage!.usage.inputTokens).toBe(64)
    expect(usage!.usage.outputTokens).toBe(28)
    expect(usage!.usage.totalTokens).toBe(92)
  })

  it('信封里的 `[DONE]` 同样算正常收尾（`body` 是裸哨兵，不是 JSON）', async () => {
    // 真机的最后一帧是 `data:{"…","body":"[DONE]","…"}` —— `[DONE]` 被**包在
    // 信封里**而不是裸的 `data: [DONE]`。只认裸哨兵的话，每一次**成功**的 CN
    // 会话都会以「Stream ended without [DONE]」告终（真机实测到的正是这个）。
    const envelope = (inner: string, extra = '') =>
      `data:{"headers":{"Content-Type":["application/json"]},"body":${JSON.stringify(inner)}`
      + `,"statusCodeValue":200,"statusCode":"OK"}${extra}\n\n`
    const raw = envelope('{"choices":[{"delta":{"content":"hi"},"index":0}]}')
      + envelope('[DONE]')

    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(raw)) as unknown as typeof fetch,
    }))
    const chunks = await chunksOf(adapter, generateOptions())
    expect(chunks).not.toBeNull()
    const text = chunks!
      .filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
      .map((chunk) => chunk.text).join('')
    expect(text).toBe('hi')
    expect(chunks!.some((chunk) => chunk.type === 'finish')).toBe(true)
  })

  it('信封里的错误帧照样直报（`event: error` + 内层 `body` 的真因）', async () => {
    // ⚠️ **错误帧的信封形态未经真机取证**（本次只captured 到成功流）。
    // 故这里**沿用既有的判错契约**（`event: error` 或根层 `error`），只是把
    // 载荷换成信封 —— 不发明新判据（详见 `unwrapQoderFrame` 与 AGENTS.md 的
    // 「未取证项」）。真因在内层 `body` 里，剥信封后必须能读出来。
    const envelope =
      'event: error\n'
      + 'data:{"headers":{"Content-Type":["application/json"]},'
      + '"body":"{\\"code\\":\\"101\\",\\"message\\":\\"Signature invalid\\"}",'
      + '"statusCodeValue":200,"statusCode":"OK"}\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(envelope)) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())
    expect(error!.message).toContain('Signature invalid')
    expect(error!.message).toContain('重新登录')
  })

  it('**裸** OpenAI 帧（国际版形态）不受信封解析影响（反向回归）', async () => {
    // 判据必须是「根层有没有信封特征」，不能是「一律先解一层 body」——
    // 后者会把国际版裸帧的 `body` 字段（若有）误当内层。这里用一条**同时**
    // 带 `body` 字符串字段的裸帧，锁死判据不是「见到 body 就解」。
    const raw = 'data: {"choices":[{"delta":{"content":"bare"},"index":0}],'
      + '"body":"not-an-envelope"}\n\n'
      + 'data: [DONE]\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      product: QODER,
      fetchImpl: (async () => sseResponse(raw)) as unknown as typeof fetch,
    }))
    const chunks = await chunksOf(adapter, generateOptions())
    expect(chunks).not.toBeNull()
    const text = chunks!
      .filter((chunk): chunk is { type: 'text-delta'; index: number; text: string } => chunk.type === 'text-delta')
      .map((chunk) => chunk.text).join('')
    expect(text).toBe('bare')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. 流式解析：签名路径复用同一套消费器（标准 OpenAI SSE）
// ─────────────────────────────────────────────────────────────────────────────

describe('CN chat：签名路径的响应仍是标准 OpenAI SSE', () => {
  it('正文 / reasoning / tool_calls / usage 四条通路都照常', async () => {
    const stream = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想…"}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{"content":"答"}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",'
      + '"type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n'
      + 'data: [DONE]\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(stream)) as unknown as typeof fetch,
    }))

    const kinds: string[] = []
    for await (const chunk of adapter.stream(generateOptions())) {
      kinds.push(chunk.type)
    }
    // ⚠️ 正文/思考/工具块都是**两段式**（`block-start` + `*-delta`），
    // 故逐个断言的类型名要与 `qoder-adapter.ts` 的产出**逐字一致**。
    expect(kinds).toContain('text-delta')
    expect(kinds).toContain('reasoning-delta')
    expect(kinds).toContain('tool-call-delta')
    expect(kinds).toContain('usage')
    expect(kinds).toContain('finish')
    // 签名路径**不改变**分块协议：仍是同一条消费器产出的同一套 chunk。
    expect(kinds).toContain('block-start')
  })

  it('缺 `[DONE]` 的签名流仍判失败（不静默当优雅结束）', async () => {
    const stream = 'data: {"choices":[{"index":0,"delta":{"content":"半截"}}]}\n\n'
    const adapter = new QoderAdapter(adapterOptions({
      fetchImpl: (async () => sseResponse(stream)) as unknown as typeof fetch,
    }))
    const error = await errorOf(adapter, generateOptions())
    expect(error!.message).toContain('[DONE]')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// G. 未注入 signing 时的降级（headless / 尚未接线）
// ─────────────────────────────────────────────────────────────────────────────

describe('CN chat：未注入签名来源', () => {
  it('CN 未注入 `signing` ⇒ 抛可读错误，**不静默回退 REST**（那必回 503）', async () => {
    const fetcher = vi.fn(async () => sseResponse(SIGNED_STREAM))
    const options = adapterOptions({ fetchImpl: fetcher as unknown as typeof fetch })
    delete (options as { signing?: unknown }).signing

    const adapter = new QoderAdapter(options)
    const error = await errorOf(adapter, generateOptions())

    expect(error).toBeInstanceOf(Error)
    // 「没接线」是明确的配置错误，绝不能伪装成上游问题。
    expect(error!.message).toMatch(/签名|signing/)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
