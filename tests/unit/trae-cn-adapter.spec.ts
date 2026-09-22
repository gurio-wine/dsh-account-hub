/**
 * Trae CN LLM 适配器测试。
 *
 * 三块内容各自独立：
 * 1. **错误码分类**（纯函数，整表穷举，正反例各一）；
 * 2. **SSE 解析**（正常流 / 错误流 / 中断流）；
 * 3. **适配器行为**（stream 传 model、换号、listModels 黑名单、resolveModel、注册）。
 *
 * 全部不发真实网络请求（`fetchImpl` 注入假实现）。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { version as osVersion } from 'node:os'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  PROVIDER,
  TraeCnAdapter,
  buildTraeCnSoloBody,
  registerTraeCnLlm,
} from '../../src/trae-cn-adapter.js'
import {
  TRAE_CN_FALLBACK_MODELS,
  TRAE_CN_INTERNAL_CONFIG_NAMES,
  TRAE_CN_MODELS_TTL_MS,
  TRAE_CN_SOLO_LITE_FUNCTION,
  TRAE_CN_SOLO_REMOTE_FUNCTION,
  TRAE_CN_SOLO_USER_AGENT,
  applyTraeCnStaticMetadata,
  fallbackTraeCnCatalog,
  fetchTraeCnDirectory,
  isCustomTraeCnModel,
  isInternalTraeCnConfig,
  isTraeCnJunkModelId,
  mergeTraeCnDirectory,
  parseTraeCnDirectory,
  traeCnSoloHeaders,
} from '../../src/trae-cn-models.js'
import type { TraeCnModelEntry } from '../../src/trae-cn-models.js'
import {
  TRAE_CN_ACCOUNT_INVALID_CODES,
  TRAE_CN_BACKOFF_CODES,
  TRAE_CN_CONTEXT_OVERFLOW_CODES,
  TRAE_CN_CREDITS_EXHAUSTED_CODES,
  TRAE_CN_FATAL_CODES,
  TRAE_CN_QUEUE_CODES,
  TRAE_CN_QUOTA_CODES,
  TRAE_CN_RATE_LIMIT_CODES,
  TRAE_CN_RISK_CONTROL_CODES,
  classifyTraeCnError,
  normalizeTraeCnCode,
  recordsTraeCnCooldown,
  shouldSwitchTraeCnAccount,
  isTraeCnBackoff,
  traeCnContextOverflowHint,
  traeCnCreditsExhaustedHint,
} from '../../src/trae-cn-errors.js'
import {
  TRAE_CN_AGENT_MODELS_API_BASE,
  TRAE_CN_AGENT_MODELS_PATH,
  TRAE_CN_AGENT_MODELS_QUERY,
  TRAE_CN_CHAT_PATH,
  TRAE_CN_IDE_API_BASE,
  TRAE_CN_IDE_APP_ID,
  TRAE_CN_IDE_GATEWAY_VERSION,
  TRAE_CN_IDE_VERSION_CODE,
  TRAE_CN_IDE_VERSION_TYPE,
  TRAE_CN_MODELS_PATH,
  TRAE_CN_REQUEST_TRAFFIC_TYPE,
  TRAE_CN_SOLO_IDE_VERSION,
  TRAE_CN_SOLO_VERSION_CODE,
  TRAE_CN,
} from '../../src/trae-cn-product.js'
import {
  consumeTraeCnStream,
  extractTraeCnOutputText,
  parseTraeCnSseError,
  parseTraeCnToolCall,
  parseTraeCnUsage,
  serializeTraeCnMessages,
  traeCnErrorCodeForAction,
} from '../../src/trae-cn-sse.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'
import { TRAE_CN_OS_VERSION } from '../../src/trae-cn-credits.js'
// ── 测试脚手架 ──

function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: '1234567890123456',
    // ⚠️ **与 `device_id` 刻意不同值**：chat（本 spec）必须用 `device_id`，
    // 签到用本字段。两者同值时，「chat 是否误用了签到设备号」就测不出来了 ——
    // 那正是 2026-09-20 设备身份修复后最需要防的「顺手统一」回归。
    checkin_device_id: '2996599860772203',
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    // 用**不透明**的过期值：`isTraeCnExpired` 只在能解析出过期时间时才判定过期，
    // 这里给一个远期时间戳，避免测试里被动触发续期分支。
    expires_at: String(Date.now() + 7_200_000),
    ...overrides,
  }
}

/** 构造一段 Trae CN 风格的 SSE 文本（具名事件）。 */
function traeSse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(({ event, data }) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`)
    .join('')
}

/** 一次普通的文本回复流。 */
function textStream(text: string): string {
  return traeSse([
    { event: 'metadata', data: { conversation_id: 'c1', model_name: 'glm-5.2' } },
    { event: 'timing_cost', data: { first_token: 120 } },
    { event: 'output', data: { response: text } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ])
}

/** 一个错误流（HTTP 200 + `event:error`，这是 Trae 的主要失败形态）。 */
function errorStream(code: number, message = '限流中'): string {
  return traeSse([
    { event: 'metadata', data: { conversation_id: 'c1' } },
    { event: 'error', data: { code, message } },
  ])
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * 读取**真机录制**的 SSE 帧夹具。
 *
 * 夹具来源：探针实录 `%TEMP%\dsh-trunc-probe\run-{notokens,maxtokens}.frames.json`，
 * 逐帧还原为 SSE 文本后入库。拷入前已人工核对**不含任何凭据 / token**
 * （探针只落 `event` / `keys` / `data` 三列，不落请求头）。
 *
 * 两个变体是同一请求在两组 max-tokens 参数下的实录：帧结构（含 `tool_calls`
 * 的首片与增量片）完全一致，只有 session id、工具调用 id 与 token 计数不同 ——
 * 正因如此，它证明的是**协议形态**而不是某一次偶然输出。
 */
function readTraeCnFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** 按类型过滤 chunk（断言里高频使用，避免每处都写一次 cast）。 */
function chunksOfType(chunks: unknown[], type: string): Array<Record<string, unknown>> {
  return chunks.filter((c): c is Record<string, unknown> => (c as { type?: unknown }).type === type)
}

/** 收集 `stream()` 的全部 chunk；返回 chunk 与抛出的错误。 */
async function collect(
  adapter: TraeCnAdapter,
  options: GenerateOptions,
): Promise<{ chunks: unknown[]; error?: { code?: string; message?: string } }> {
  const chunks: unknown[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error: error as { code?: string; message?: string } }
  }
}

/**
 * 构造适配器 + 捕获请求的 fetch stub。
 *
 * `responder` 收到 `(url, init, callIndex)`，可据 callIndex 让不同账号得到不同结果。
 *
 * ⚠️ **默认关掉动态目录**（`fetchRemoteModels: async () => []`）：适配器内置的
 * 目录拉取会真的发网络请求，而本文件全部用例都是零网络的。要测目录相关行为的
 * 用例显式覆盖该选项。
 */
function makeAdapter(
  responder: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof TraeCnAdapter>[0]> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init, calls.length - 1)
  }) as unknown as typeof fetch
  const adapter = new TraeCnAdapter({
    credentialRef: credentialRef('TRAE_CN_ACCOUNT_TEST'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: fetcher,
    fetchRemoteModels: async () => [],
    product: TRAE_CN,
    ...options,
  })
  return { adapter, calls, fetcher }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'trae-cn',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

// ── 一、错误码分类（纯函数） ──

describe('Trae CN 错误码分类：换号类', () => {
  it('限流码（4008/4021/5003/977）全部判 switch-account', () => {
    for (const code of TRAE_CN_RATE_LIMIT_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('额度码（4200-4203）判 switch-account', () => {
    for (const code of TRAE_CN_QUOTA_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('账号失效码（1001/1002/4010/4014）判 switch-account（对齐官方 isSecurityError）', () => {
    for (const code of TRAE_CN_ACCOUNT_INVALID_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('风控码（4011/4013/4015）判 switch-account', () => {
    for (const code of TRAE_CN_RISK_CONTROL_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('字符串形态的业务码与数字形态等价（上游两种都出现过）', () => {
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: '4008' })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 4008 })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: ' 4008 ' })).toBe('switch-account')
  })
})

describe('Trae CN 错误码分类：退避类（不换号）', () => {
  it('软限流码（4007/3004/9074）判 backoff', () => {
    for (const code of TRAE_CN_BACKOFF_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('backoff')
    }
  })

  it('排队码（4000005、4050-4052）判 backoff —— 排队是全局状态，换号无益', () => {
    for (const code of TRAE_CN_QUEUE_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('backoff')
    }
  })

  it('**`3003`（MODEL_FAIL / all models failed）判 backoff** —— 基础设施类，可重试', () => {
    // 这是端点迁移取证时补入的码：旧 IDE 通道对我方新池请求的恒定回复。
    // 它必须**可重试**（退避），而不是被当成确定性失败直报 —— 否则用户看到的是
    // 一个永远不可恢复的错误。同时它**不该换号**：与具体账号无关。
    expect(TRAE_CN_BACKOFF_CODES).toContain(3003)
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 3003 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: '3003' })).toBe('backoff')
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 3003 }))).toBe(false)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 3003 }))).toBe(true)
    // 退避 → 可重试的 RATE_LIMIT（否则 DSH 的重试层认不出来）。
    expect(traeCnErrorCodeForAction('backoff', 3003)).toBe('RATE_LIMIT')
    // 也不记冷却徽章（它不是账号级的模型限流）。
    expect(recordsTraeCnCooldown(3003)).toBe(false)
  })

  it('`4023`（模型不存在）与 `4001`（参数错误）都直报', () => {
    for (const code of [4023, 4001]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('fail')
    }
    expect(traeCnErrorCodeForAction('fail', 4023)).toBe('INVALID_REQUEST')
    expect(traeCnErrorCodeForAction('fail', 4001)).toBe('INVALID_REQUEST')
  })

  it('退避类**不**触发换号（正反例：换成限流码就要换号）', () => {
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4007 }))).toBe(false)
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4000005 }))).toBe(false)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 4007 }))).toBe(true)
    // 反例
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4008 }))).toBe(true)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 4008 }))).toBe(false)
  })
})

describe('Trae CN 错误码分类：直报类', () => {
  it('参数/超长/模型不存在（4001/4006/4023）判 fail', () => {
    for (const code of TRAE_CN_FATAL_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('fail')
    }
  })

  it('**未知码默认直报**（带原始码，便于真机校准）', () => {
    for (const code of [12345, 99999, 8888, 0, -1]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('fail')
    }
  })

  it('非法码形态（非整数字符串）等同于「无业务码」，退回 HTTP 判定', () => {
    // `"code=4008"` 这类诊断文本不能被 parseInt 静默截取成 4008。
    expect(normalizeTraeCnCode('code=4008')).toBeUndefined()
    expect(normalizeTraeCnCode('4008.5')).toBeUndefined()
    expect(classifyTraeCnError({ httpStatus: 500, sseErrorCode: 'code=4008' })).toBe('backoff')
  })
})

describe('Trae CN 错误码分类：HTTP 兜底（无业务码时）', () => {
  it('401/403 → switch-account（凭据被拒，换个账号试）', () => {
    expect(classifyTraeCnError({ httpStatus: 401 })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 403 })).toBe('switch-account')
  })

  it('429/408/5xx → backoff（网关级限流与瞬时故障，与账号无关）', () => {
    expect(classifyTraeCnError({ httpStatus: 429 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 408 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 500 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 502 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 503 })).toBe('backoff')
  })

  it('其余（200 / 400 / 404）→ fail', () => {
    expect(classifyTraeCnError({ httpStatus: 200 })).toBe('fail')
    expect(classifyTraeCnError({ httpStatus: 400 })).toBe('fail')
    expect(classifyTraeCnError({ httpStatus: 404 })).toBe('fail')
    expect(classifyTraeCnError({})).toBe('fail')
  })

  it('**业务码优先于 HTTP 状态码**：200 + 4008 仍要换号', () => {
    // 这是本 provider 的核心事实：失败几乎恒为 HTTP 200。
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 4008 })).toBe('switch-account')
    // 反之，业务码说直报时即使状态码是 5xx 也以业务码为准。
    expect(classifyTraeCnError({ httpStatus: 503, sseErrorCode: 4001 })).toBe('fail')
  })
})

describe('Trae CN 终报文案（积分耗尽 vs 限流冷却）', () => {
  it('**4008 是「积分耗尽」**，不是频率限流（2026-09-21 单变量定案）', () => {
    // 归在池耗尽表里，同时仍留在限流表（动作与徽章不变，只影响文案）。
    expect(TRAE_CN_CREDITS_EXHAUSTED_CODES).toContain(4008)
    expect(TRAE_CN_RATE_LIMIT_CODES).toContain(4008)
    // 诚实性原则：4021/5003/977 没有被实测为耗尽，**不得**混进耗尽表。
    for (const code of [4021, 5003, 977]) {
      expect(TRAE_CN_CREDITS_EXHAUSTED_CODES).not.toContain(code)
    }
  })

  it('池已试遍 + 4008 → 「全部账号…已耗尽」+ 下一步 + 「等不会自愈」', () => {
    const hint = traeCnCreditsExhaustedHint(4008, '通用积分', 'pool-exhausted')
    expect(hint).toMatch(/全部账号的 Trae CN 通用积分均已耗尽/)
    expect(hint).toMatch(/请充值或等待额度周期重置/)
    expect(hint).toMatch(/这不是频率限流，稍后重试不会自愈/)
  })

  it('**换号达上限 → 主语降级**，不得谎称「全部账号」', () => {
    const hint = traeCnCreditsExhaustedHint(4008, '通用积分', 'rotate-cap')
    expect(hint).toMatch(/已尝试的账号的 Trae CN 通用积分均已耗尽/)
    expect(hint).toMatch(/换号次数已达上限，池中可能还有未尝试的账号/)
    expect(hint).not.toMatch(/全部账号的/)
  })

  it('**限流冷却（非耗尽）措辞不同**：说「冷却或限额中」而不断言耗尽', () => {
    const hint = traeCnCreditsExhaustedHint(4007, '通用积分', 'pool-exhausted')
    // 4007 是退避表里的码，不在限流/额度表 ⇒ 不提账号池。
    expect(hint).toBe('')
    const limited = traeCnCreditsExhaustedHint(4021, '通用积分', 'pool-exhausted')
    expect(limited).toMatch(/均在冷却或限额中/)
    expect(limited).toMatch(/可在 Account Hub 查看重置时刻/)
    expect(limited).not.toMatch(/均已耗尽/)
  })

  it('cap + 冷却 → 空串（信息量为负，刻意不说）', () => {
    expect(traeCnCreditsExhaustedHint(4021, '通用积分', 'rotate-cap')).toBe('')
  })

  it('不该谈账号的三种情形一律返回空串（不留悬挂括号）', () => {
    // 没有池（scope undefined）
    expect(traeCnCreditsExhaustedHint(4008, '通用积分', undefined)).toBe('')
    // 业务码缺失
    expect(traeCnCreditsExhaustedHint(undefined, '通用积分', 'pool-exhausted')).toBe('')
    // 非额度类码（直报 / 未知 / 账号失效 / 风控）
    for (const code of [4001, 4006, 4022, 4023, 1001, 4011, 99999]) {
      expect(traeCnCreditsExhaustedHint(code, '通用积分', 'pool-exhausted'), String(code))
        .toBe('')
    }
  })

  it('池名是实参（换池名不改判定，防写死）', () => {
    expect(traeCnCreditsExhaustedHint(4008, '签到积分', 'pool-exhausted'))
      .toMatch(/Trae CN 签到积分/)
  })
})

describe('Trae CN 冷却徽章判据', () => {  it('限流 / 额度 / 风控码记徽章', () => {
    for (const code of [...TRAE_CN_RATE_LIMIT_CODES, ...TRAE_CN_QUOTA_CODES, ...TRAE_CN_RISK_CONTROL_CODES]) {
      expect(recordsTraeCnCooldown(code)).toBe(true)
    }
  })

  it('**账号失效码不记**（唯一解法是重新登录，记「等待重置」是虚假信息）', () => {
    for (const code of TRAE_CN_ACCOUNT_INVALID_CODES) {
      expect(recordsTraeCnCooldown(code)).toBe(false)
    }
  })

  it('退避类 / 直报类 / 未知码都不记', () => {
    for (const code of [...TRAE_CN_BACKOFF_CODES, ...TRAE_CN_QUEUE_CODES, ...TRAE_CN_FATAL_CODES, 99999]) {
      expect(recordsTraeCnCooldown(code)).toBe(false)
    }
    expect(recordsTraeCnCooldown(undefined)).toBe(false)
  })
})

describe('Trae CN 动作 → harness 错误码', () => {
  it('换号/退避都映射为可重试的 RATE_LIMIT（否则退避无从生效）', () => {
    expect(traeCnErrorCodeForAction('switch-account', 4008)).toBe('RATE_LIMIT')
    expect(traeCnErrorCodeForAction('backoff', 4007)).toBe('RATE_LIMIT')
    expect(traeCnErrorCodeForAction('backoff', 4000005)).toBe('RATE_LIMIT')
  })

  it('4006（请求超长）映射为 CONTEXT_WINDOW_EXCEEDED（触发上下文压缩）', () => {
    expect(traeCnErrorCodeForAction('fail', 4006)).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(traeCnErrorCodeForAction('fail', '4006')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('**4022（上下文窗口溢出）与 4006 同路**：CONTEXT_WINDOW_EXCEEDED（触发上下文压缩）', () => {
    // 2026-09-21 单变量定案：prompt token ≈ 1M 时 HTTP 200 + 流内 event:error
    // 4022（998 161 成功 / 1 002 248 失败；同请求降 token 即成功、与字节和账号无关）。
    // 它此前落「未知码」路径 → fail → INVALID_REQUEST（致命、不触发压缩），
    // 长会话因此彻底不可用 —— 这条断言钉死它与 4006 同款处理。
    expect(traeCnErrorCodeForAction('fail', 4022)).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(traeCnErrorCodeForAction('fail', '4022')).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 与 4006 同表：两者是「同类不同成因」的超限，映射必须一致。
    expect(TRAE_CN_CONTEXT_OVERFLOW_CODES).toContain(4006)
    expect(TRAE_CN_CONTEXT_OVERFLOW_CODES).toContain(4022)
  })

  it('4022 是**已定案**的直报类码，不再走「未知码」路径', () => {
    // 「未知业务码一律直报不猜动作」这条原则**未被绕过**：4022 已从「未知」变成
    // 「已知」（阈值 + 排除项 + 同请求对照三件证据齐备），故按已知码处理。
    expect(TRAE_CN_FATAL_CODES).toContain(4022)
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 4022 })).toBe('fail')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: '4022' })).toBe('fail')
    // 不换号、不退避（确定性失败：同样的请求换任何账号都溢出）。
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4022 }))).toBe(false)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 4022 }))).toBe(false)
    // 不记冷却徽章：上下文溢出与账号/模型额度无关，记「限流至 …」是虚假信息。
    expect(recordsTraeCnCooldown(4022)).toBe(false)
  })

  it('4022 的中文说明只给 4022，**4006 刻意不加**（反向锁死，防「顺手统一」）', () => {
    expect(traeCnContextOverflowHint(4022)).toMatch(/上下文超出上游上限/)
    expect(traeCnContextOverflowHint(4022)).toMatch(/自动压缩/)
    expect(traeCnContextOverflowHint('4022')).toMatch(/上下文超出上游上限/)
    // 4006 的文案是既成行为，本次不动它。
    expect(traeCnContextOverflowHint(4006)).toBe('')
    // 其余码一律不加（拼接处才不会出现悬挂括号）。
    expect(traeCnContextOverflowHint(4001)).toBe('')
    expect(traeCnContextOverflowHint(undefined)).toBe('')
  })

  it('**加入 4022 不改变其它任何码的分类**（既有码逐一复验）', () => {
    // 换号类：一字未动
    for (const code of [...TRAE_CN_RATE_LIMIT_CODES, ...TRAE_CN_QUOTA_CODES,
      ...TRAE_CN_ACCOUNT_INVALID_CODES, ...TRAE_CN_RISK_CONTROL_CODES]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code }), String(code)).toBe('switch-account')
    }
    // 退避类：一字未动
    for (const code of [...TRAE_CN_BACKOFF_CODES, ...TRAE_CN_QUEUE_CODES]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code }), String(code)).toBe('backoff')
    }
    // 直报类：新增 4022 之外的三个仍原样
    for (const code of [4001, 4006, 4023]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code }), String(code)).toBe('fail')
      expect(traeCnErrorCodeForAction('fail', code), String(code))
        .toBe(code === 4006 ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST')
    }
    // **4022 的邻码不受牵连**（4020/4021/4023/4024）：4021 仍换号，其余仍走各自路径。
    expect(classifyTraeCnError({ sseErrorCode: 4021 })).toBe('switch-account')
    expect(traeCnErrorCodeForAction('fail', 4020)).toBe('INVALID_REQUEST')
    expect(traeCnErrorCodeForAction('fail', 4023)).toBe('INVALID_REQUEST')
    expect(traeCnErrorCodeForAction('fail', 4024)).toBe('INVALID_REQUEST')
  })

  it('其余直报映射为 INVALID_REQUEST', () => {
    expect(traeCnErrorCodeForAction('fail', 4001)).toBe('INVALID_REQUEST')
    expect(traeCnErrorCodeForAction('fail', undefined)).toBe('INVALID_REQUEST')
  })
})

// ── 二、SSE 解析 ──

describe('Trae CN SSE 帧解析（纯函数）', () => {
  it('output 帧取 response 字段；同义字段作为回退', () => {
    expect(extractTraeCnOutputText({ response: '你好' })).toBe('你好')
    expect(extractTraeCnOutputText({ content: 'x' })).toBe('x')
    expect(extractTraeCnOutputText('裸字符串')).toBe('裸字符串')
    // 结构化载荷**不**被 String() 成乱码。
    expect(extractTraeCnOutputText({ other: { a: 1 } })).toBe('')
    expect(extractTraeCnOutputText(null)).toBe('')
  })

  it('error 帧解析业务码与文案（含嵌套 error 形态）', () => {
    expect(parseTraeCnSseError({ code: 4008, message: '限流' }))
      .toMatchObject({ code: 4008, message: '限流', action: 'switch-account' })
    expect(parseTraeCnSseError({ error: { code: '4021', message: '并发超限' } }))
      .toMatchObject({ code: '4021', message: '并发超限', action: 'switch-account' })
    // 无 code 时按 HTTP 兜底。
    expect(parseTraeCnSseError({ message: 'oops' }, 503).action).toBe('backoff')
  })

  it('tool_call 帧容忍三种载荷形态；全落空时返回 undefined（不伪造空调用）', () => {
    expect(parseTraeCnToolCall({ id: 'c1', name: 'read', arguments: '{"a":1}' }))
      .toEqual({ id: 'c1', name: 'read', argumentsDelta: '{"a":1}' })
    expect(parseTraeCnToolCall({ tool_call: { id: 'c2', name: 'grep', arguments: '{}' } }))
      .toEqual({ id: 'c2', name: 'grep', argumentsDelta: '{}' })
    expect(parseTraeCnToolCall({ tool_call: { function: { name: 'ls', arguments: '{}' } } }))
      .toEqual({ name: 'ls', argumentsDelta: '{}' })
    // 结构化参数序列化回字符串。
    expect(parseTraeCnToolCall({ name: 'x', arguments: { a: 1 } })).toEqual({ name: 'x', argumentsDelta: '{"a":1}' })
    expect(parseTraeCnToolCall({ nothing: true })).toBeUndefined()
  })

  it('`function_call` 嵌套形态（output 帧内嵌 tool_calls 的原生形态）与顶层形态都从同一入口解析', () => {
    // 真机帧实录：字段名是 `function_call`（**无 er**），与出站改名约定同源 ——
    // assistant 的 `tool_calls[].function` 出站改名 `function_call`，入站按同名读回。
    // 这里钉死「不要顺手修正成 function」，否则这条链路会静默断掉。
    expect(parseTraeCnToolCall({
      index: 0,
      id: 'call_e73ac491c3ae4cf783f02af4',
      type: 'function',
      function_call: { name: 'glob', arguments: '', partial_arguments: null, namespace: null },
    })).toEqual({ id: 'call_e73ac491c3ae4cf783f02af4', name: 'glob', argumentsDelta: '' })

    // 增量片：id / name 是**空串**，只有 arguments 是增量。
    expect(parseTraeCnToolCall({
      index: 0,
      id: '',
      type: 'function',
      function_call: { name: '', arguments: '{"pattern": "*"}', partial_arguments: null, namespace: null },
    })).toEqual({ argumentsDelta: '{"pattern": "*"}' })

    // 顶层形态（没有 `tool_call` 包裹）同样认。
    expect(parseTraeCnToolCall({ id: 'c9', function_call: { name: 'ls', arguments: '{}' } }))
      .toEqual({ id: 'c9', name: 'ls', argumentsDelta: '{}' })
  })

  it('usage 帧只把未命中缓存部分计入 inputTokens', () => {
    expect(parseTraeCnUsage({ prompt_tokens: 100, completion_tokens: 20 }))
      .toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(parseTraeCnUsage({ prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 30 }))
      .toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 })
    // 无可用字段时不产出 usage（而不是产出一个全 0 的假用量）。
    expect(parseTraeCnUsage({ foo: 1 })).toBeUndefined()
    expect(parseTraeCnUsage('nope')).toBeUndefined()
  })

  it('消息序列化：剔除孤儿工具调用、空正文 + tool_calls 时 content 为 null', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'orphan', name: 'x', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ]
    const wire = serializeTraeCnMessages(messages)
    const withCalls = wire.filter((m) => m.tool_calls !== undefined)
    // 孤儿调用（没有结果的 orphan）被剔除，配对的 c1 保留。
    expect(withCalls).toHaveLength(1)
    expect((withCalls[0]!.tool_calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['c1'])
    expect(withCalls[0]!.content).toBeNull()
    expect(wire.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true)
  })
})

describe('Trae CN SSE 流消费', () => {
  /** 直接消费一段 SSE 文本，返回 chunk 与 outcome。 */
  async function consume(body: string, status = 200) {
    const chunks: unknown[] = []
    const generator = consumeTraeCnStream(sseResponse(body, status), {
      label: 'trae-cn',
      httpStatus: status,
      timeouts: { firstFrameMs: 1000, chunkMs: 1000 },
    })
    let outcome
    for (;;) {
      const next = await generator.next()
      if (next.done === true) { outcome = next.value; break }
      chunks.push(next.value)
    }
    return { chunks, outcome }
  }

  it('正常流：metadata/timing_cost 被忽略，output 产出正文，done 结束', async () => {
    const { chunks, outcome } = await consume(textStream('你好世界'))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好世界' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } },
    ])
    expect(outcome).toMatchObject({ done: true, produced: true, hasToolCalls: false, argumentsTruncated: false })
    expect(outcome.sseError).toBeUndefined()
  })

  it('多个 output 帧累积成同一个正文块', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'output', data: { response: '你' } },
      { event: 'output', data: { response: '好' } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([
        { type: 'text-delta', index: 0, text: '你' },
        { type: 'text-delta', index: 0, text: '好' },
      ])
    const end = chunks.at(-1) as { block: { text: string } }
    expect(end.block.text).toBe('你好')
  })

  it('事件名 `meta`（JS 侧命名）与 `metadata` 都被识别为元数据帧', async () => {
    const { outcome } = await consume(traeSse([
      { event: 'meta', data: { id: 'log-1' } },
      { event: 'output', data: { response: 'x' } },
      { event: 'done', data: {} },
    ]))
    expect(outcome).toMatchObject({ done: true, produced: true })
  })

  it('**错误流**：error 帧回填 outcome.sseError，且不抛异常（换号判定权交给调用方）', async () => {
    const { chunks, outcome } = await consume(errorStream(4008, '请求过于频繁'))
    expect(outcome.produced).toBe(false)
    expect(outcome.done).toBe(false)
    expect(outcome.sseError).toMatchObject({ code: 4008, message: '请求过于频繁', action: 'switch-account' })
    expect(chunks).toEqual([])
  })

  it('错误流里 `data:` 不是 JSON 时也不炸，原文作为文案', async () => {
    const { outcome } = await consume('event:error\ndata:gateway exploded\n\n')
    expect(outcome.sseError).toMatchObject({ message: 'gateway exploded' })
  })

  it('**中断流**：连接提前关闭时 done 为 false，但已产出的正文仍在', async () => {
    const { chunks, outcome } = await consume(traeSse([
      { event: 'output', data: { response: '半截' } },
      // 没有 done 帧
    ]))
    expect(outcome).toMatchObject({ done: false, produced: true })
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('工具调用分片合并；参数残缺时 argumentsTruncated 为真', async () => {
    const complete = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"file_path":"a' } },
      { event: 'tool_call', data: { arguments: '.ts"}' } },
      { event: 'done', data: {} },
    ]))
    expect(complete.outcome).toMatchObject({ hasToolCalls: true, argumentsTruncated: false })
    const block = complete.chunks.at(-1) as { block: { name: string; arguments: string } }
    expect(block.block).toMatchObject({ name: 'read', arguments: '{"file_path":"a.ts"}' })

    const truncated = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"file_path":"a' } },
      { event: 'done', data: {} },
    ]))
    expect(truncated.outcome.argumentsTruncated).toBe(true)
  })

  it('工具名只允许**非空**覆盖（后续空串不会清掉已解析出的名字）', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{}' } },
      { event: 'tool_call', data: { name: '', arguments: '' } },
      { event: 'done', data: {} },
    ]))
    const block = chunks.at(-1) as { block: { name: string } }
    expect(block.block.name).toBe('read')
  })

  it('thought 帧产出 reasoning 块；usage 帧产出 usage', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'thought', data: { content: '让我想想' } },
      { event: 'output', data: { response: '答案' } },
      { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 2 } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.some((c) => (c as { type: string }).type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
  })

  it('output 帧里的 content 是**正文**，不会被当成思考（同一段文字不重复出现）', async () => {
    // 锁死一个真实歧义：`output` 帧的 `content` 与「思考」字段同形，
    // 若把 content 也当思考，正文会在两个块里各出现一次。
    const { chunks } = await consume(traeSse([
      { event: 'output', data: { content: '正文内容' } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.some((c) => (c as { type: string }).type === 'reasoning-delta')).toBe(false)
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([{ type: 'text-delta', index: 0, text: '正文内容' }])
  })

  it('排队帧被忽略，不产出内容也不报错', async () => {
    const { outcome } = await consume(traeSse([
      { event: 'queue_begin', data: { position: 3 } },
      { event: 'request_wait_in_queue', data: { wait: 5 } },
      { event: 'output', data: { response: 'ok' } },
      { event: 'done', data: {} },
    ]))
    expect(outcome).toMatchObject({ done: true, produced: true })
  })

  it('畸形 JSON 帧被跳过而不中断流；未知事件名的 data 不被当作正文', async () => {
    const body = 'event:output\ndata:{bad json\n\n'
      + 'event:timing_cost\ndata:{"a":1}\n\n'
      + 'event:output\ndata:{"response":"ok"}\n\n'
      + 'event:done\ndata:{}\n\n'
    const { chunks, outcome } = await consume(body)
    expect(outcome.produced).toBe(true)
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([{ type: 'text-delta', index: 0, text: 'ok' }])
  })

  it('兼容 `data:{...}`（无空格）与 CRLF 行尾', async () => {
    const body = 'event:output\r\ndata:{"response":"crlf"}\r\n\r\nevent:done\r\ndata:{}\r\n\r\n'
    const { outcome } = await consume(body)
    expect(outcome.produced).toBe(true)
  })
})

/**
 * `output` 帧内嵌 `tool_calls`（2026-09-21 真机定案）。
 *
 * ## 缺陷本体
 *
 * 上游把工具调用嵌在 **`event:output` 帧的 `tool_calls` 字段**里返回，而 output
 * 分支只读 `response` / `reasoning_content` ⇒ 工具调用被整块丢弃 ⇒ 该步既无正文
 * 也无 tool-call 块 ⇒ 适配器走 `{kind:'stop'}` ⇒ 回合终止且零报错。
 * 后果是 **trae-cn 从未成功调用过一次工具**（343 个历史会话扫描 0/10）。
 *
 * 下面第一条用例用真机帧序列端到端钉死这条链路；其余用例锁单帧语义。
 */
describe('Trae CN output 帧内嵌 tool_calls（真机帧夹具）', () => {
  /** 直接消费一段 SSE 文本，返回 chunk 与 outcome。 */
  async function consume(body: string, status = 200) {
    const chunks: unknown[] = []
    const generator = consumeTraeCnStream(sseResponse(body, status), {
      label: 'trae-cn',
      httpStatus: status,
      timeouts: { firstFrameMs: 1000, chunkMs: 1000 },
    })
    let outcome
    for (;;) {
      const next = await generator.next()
      if (next.done === true) { outcome = next.value; break }
      chunks.push(next.value)
    }
    return { chunks, outcome }
  }

  for (const variant of ['notokens', 'maxtokens']) {
    it(`真机帧序列（${variant}）：工具调用被解析为 tool-call 块，收尾为 tool-calls`, async () => {
      const { chunks, outcome } = await consume(readTraeCnFixture(`trae-cn-output-tool-calls-${variant}.sse.txt`))

      // ① 建块 + 增量：id / name / 累积 arguments 三项全断言。
      expect(chunksOfType(chunks, 'block-start')).toEqual([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
      ])
      const deltas = chunksOfType(chunks, 'tool-call-delta')
      expect(deltas).toHaveLength(2)
      expect(deltas[0]).toMatchObject({ index: 1, name: 'glob', argumentsDelta: '' })
      expect(deltas[1]).toMatchObject({ index: 1, argumentsDelta: '{"pattern": "*"}' })
      // id 只出现在首片；两个分片的 id 必须**同值**（增量片的空串不得覆盖已记录值）。
      expect(deltas[0]!.id).toEqual(deltas[1]!.id)
      expect(String(deltas[0]!.id).startsWith('call_')).toBe(true)

      // 收尾块按「工具调用 → 正文 → 思考」的创建顺序闭合，故这里按块类型取，
      // 不能假定 `at(-1)` 就是工具块（本夹具里最后闭合的是 reasoning 块）。
      const toolEnd = chunksOfType(chunks, 'block-end')
        .find(e => (e.block as { type?: unknown }).type === 'tool-call')!
      expect(toolEnd.index).toBe(1)
      expect(toolEnd.block).toMatchObject({ type: 'tool-call', name: 'glob', arguments: '{"pattern": "*"}' })

      // ② outcome 三项：都收到 done 帧、参数不残缺、确实存在工具调用。
      expect(outcome).toMatchObject({ done: true, produced: true, hasToolCalls: true, argumentsTruncated: false })

      // ③ 适配器收尾必须是 tool-calls —— 修复前这里是 stop，回合就此终止。
      const { adapter } = makeAdapter(() => sseResponse(
        readTraeCnFixture(`trae-cn-output-tool-calls-${variant}.sse.txt`),
      ))
      const result = await collect(adapter, generateOptions())
      expect(result.error).toBeUndefined()
      expect(result.chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    })
  }

  it('`response` 正文与 `tool_calls` 同帧共存时**两者都产出**', async () => {
    const { chunks } = await consume(traeSse([
      {
        event: 'output',
        data: {
          response: '我先看一下目录',
          tool_calls: [{
            index: 0,
            id: 'c1',
            type: 'function',
            function_call: { name: 'glob', arguments: '{"pattern":"*"}' },
          }],
        },
      },
      { event: 'done', data: {} },
    ]))
    expect(chunksOfType(chunks, 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: '我先看一下目录' }])
    expect(chunksOfType(chunks, 'tool-call-delta')).toHaveLength(1)
  })

  it('`tool_calls` 为空数组 / 非数组 / 缺 `function_call` 时不产出块', async () => {
    const empty = await consume(traeSse([
      { event: 'output', data: { response: 'x', tool_calls: [] } },
      { event: 'done', data: {} },
    ]))
    expect(empty.outcome.hasToolCalls).toBe(false)
    expect(chunksOfType(empty.chunks, 'tool-call-delta')).toEqual([])

    const notArray = await consume(traeSse([
      { event: 'output', data: { response: 'x', tool_calls: null } },
      { event: 'done', data: {} },
    ]))
    expect(notArray.outcome.hasToolCalls).toBe(false)

    // 单项缺 `function_call`（id / name / arguments 全落空）→ 跳过该项，
    // 而不是伪造出一个 `unknown tool ""` 的空调用污染会话历史。
    const missingFn = await consume(traeSse([
      { event: 'output', data: { response: 'x', tool_calls: [{ index: 0, type: 'function' }] } },
      { event: 'done', data: {} },
    ]))
    expect(missingFn.outcome.hasToolCalls).toBe(false)
    expect(chunksOfType(missingFn.chunks, 'tool-call-delta')).toEqual([])
  })

  it('既有独立 `event:tool_call` 帧不受影响（两种投递形态并存）', async () => {
    const { chunks, outcome } = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"a":1}' } },
      { event: 'done', data: {} },
    ]))
    expect(outcome.hasToolCalls).toBe(true)
    const end = chunks.at(-1) as { block: { name: string; arguments: string } }
    expect(end.block).toMatchObject({ name: 'read', arguments: '{"a":1}' })
  })

  it('同一帧内多个 tool_calls（并行调用）按 `index` 各建一块，后续分片各归其位', async () => {
    const { chunks, outcome } = await consume(traeSse([
      {
        event: 'output',
        data: {
          response: '',
          tool_calls: [
            { index: 0, id: 'c1', type: 'function', function_call: { name: 'read', arguments: '{"a":1}' } },
            // glob 的参数**故意只给前半截**，由后一帧补齐。
            { index: 1, id: 'c2', type: 'function', function_call: { name: 'glob', arguments: '{"pattern":"*"' } },
          ],
        },
      },
      // 后续帧只带 index=1 的增量：它必须落到 glob 那一块，而不是并吞进 read。
      {
        event: 'output',
        data: {
          response: '',
          tool_calls: [
            { index: 1, id: '', type: 'function', function_call: { name: '', arguments: ',"x":1}' } },
          ],
        },
      },
      { event: 'done', data: {} },
    ]))

    expect(chunksOfType(chunks, 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
    ])
    expect(outcome.hasToolCalls).toBe(true)
    const ends = chunksOfType(chunks, 'block-end').map(e => e.block as Record<string, unknown>)
    expect(ends.map(b => b.name)).toEqual(['read', 'glob'])
    expect(ends[0]!.arguments).toBe('{"a":1}')
    expect(ends[1]!.arguments).toBe('{"pattern":"*","x":1}')
  })

  it('**只有工具调用、零正文**时适配器收尾仍为 tool-calls（不得判成空回复）', async () => {
    // 这条是缺陷的第二个后果面：工具调用被丢弃后该步既无 text 也无 tool-call，
    // 适配器会把「上游明明给了工具调用」误判为 EMPTY_RESPONSE / stop。
    const body = traeSse([
      {
        event: 'output',
        data: {
          response: '',
          reasoning_content: null,
          tool_calls: [{
            index: 0,
            id: 'c1',
            type: 'function',
            function_call: { name: 'glob', arguments: '{"pattern":"*"}' },
          }],
        },
      },
      { event: 'done', data: { finish_reason: 'stop' } },
    ])
    const { adapter } = makeAdapter(() => sseResponse(body))
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

// ── 三、适配器行为 ──

describe('TraeCnAdapter providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(adapter.providerInfo('trae-cn')).toEqual({ id: 'trae-cn', name: 'Trae CN' })
  })

  it('provider 入参非法时回退到产品 id（避免 toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(adapter.providerInfo(undefined as never).id).toBe('trae-cn')
    expect(adapter.providerInfo('' as never).id).toBe('trae-cn')
  })

  it('PROVIDER 常量为 trae-cn', () => {
    expect(PROVIDER).toBe('trae-cn')
  })
})

describe('TraeCnAdapter 模型目录', () => {
  it('静态回退表为 **11 项**（真机 16 项剔除 5 项 SOLO 不可调 id），且 id 逐字符等于真机目录', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const models = await adapter.listModels('trae-cn')
    expect(models).toHaveLength(11)
    // 真机 id 形态极不规则（大小写/点号/连字符混用），逐项锁死防「顺手规整化」。
    expect(models.map((m) => m.id)).toEqual([
      'Doubao-Seed-Evolving',
      'Doubao-Seed-2.1-Pro',
      'Doubao-Seed-2.1-Turbo',
      'glm-5.3',
      'glm-5.2',
      'DeepSeek-V4-Flash-Official',
      'DeepSeek-V4-Pro-Official',
      'kimi-k3',
      'minimax-m3',
      'qwen3.8-max',
      'qwen-3.7-plus',
    ])
  })

  it('**5 项 SOLO 不可调 id 已从回退表剔除**（留在表里只会产出必然 4001 的选项）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    // 这 5 项实测**不在 SOLO 41 项 roster** 内：本 provider 只走 SOLO 通道
    // （IDE 通道已由五轮取证定案废弃），故它们调不了，列出来就是死选项。
    for (const gone of [
      'Doubao-Seed-Code',
      'glm-5.3-flash',
      'deepseek-v4.1-flash',
      'kimi-k2.8-preview',
      'qwen3.8-flash',
    ]) {
      expect(ids, gone).not.toContain(gone)
    }
    // 反证：同族的「近似但不同」的 id 仍在表里，否则上面那条反断言可能因为
    // 整表被清空而假通过。
    for (const live of ['Doubao-Seed-2.1-Pro', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'qwen3.8-max']) {
      expect(ids, live).toContain(live)
    }
  })

  it('**4 个旧死 id 已不在表中**（换真机表的核心目的）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    // qwen3.7-max 已下线；其余三个是拼写/大小写错误的近似形态 ——
    // 它们曾经让用户选中一个必然 404 的模型。
    for (const dead of ['qwen3.7-max', 'deepseek-v4-flash', 'doubao-seed-2-1-pro', 'MiniMax-M3']) {
      expect(ids, dead).not.toContain(dead)
    }
    // 反证：真机形态的「近似但不同」的 id 必须在表里，否则上面那条反断言
    // 可能因为整表为空而假通过。
    for (const live of ['Doubao-Seed-2.1-Pro', 'minimax-m3']) {
      expect(ids, live).toContain(live)
    }
  })

  it('**排除 BYOK 自定义条目**（deepseek//deepseek-chat / -reasoner 不属云端目录）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    for (const byok of ['deepseek//deepseek-chat', 'deepseek//deepseek-reasoner']) {
      expect(ids).not.toContain(byok)
    }
  })

  it('静态表逐项带 supportsImages 与 maxTokens（目录与真机逐列对齐）', () => {
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(typeof model.supportsImages, model.id).toBe('boolean')
      expect([32_000, 64_000], model.id).toContain(model.maxTokens)
      expect(model.contextWindow, model.id).toBeGreaterThan(0)
    }
    // 原真机 16 项里 12 项多模态；剔除的 5 项**全是多模态项**，故原本是 7 项。
    // 2026-09-20 按 SOLO 目录实测把 `minimax-m3` 改成 false → **6 项**。
    // 数一下，避免整表被改成全 true / 全 false 还绿。
    expect(TRAE_CN_FALLBACK_MODELS.filter((m) => m.supportsImages)).toHaveLength(6)
  })

  it('inputModalities 按模型给：多模态项 image，非多模态项只有 text', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const byId = new Map((await adapter.listModels('trae-cn')).map((m) => [m.id, m]))
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(byId.get(model.id)!.inputModalities, model.id).toEqual(
        model.supportsImages ? ['text', 'image'] : ['text'],
      )
      expect(byId.get(model.id)!.provider).toBe('trae-cn')
    }
    // 两边的代表各点一次（防止上面的循环整体失效还绿）。
    expect(byId.get('kimi-k3')!.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('glm-5.3')!.inputModalities).toEqual(['text'])
  })

  it('远端可用时以远端为准（不做「以兜底表为准」的裁剪）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    const models = await adapter.listModels('trae-cn')
    expect(models).toEqual([{ provider: 'trae-cn', id: 'remote-only', name: 'Remote Only', inputModalities: ['text'] }])
  })

  it('远端返回空数组 / 抛错时回退静态表', async () => {
    const empty = makeAdapter(() => sseResponse(''), { fetchRemoteModels: async () => [] })
    expect(await empty.adapter.listModels('trae-cn')).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
    const failing = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    expect(await failing.adapter.listModels('trae-cn')).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
  })

  it('**目录拉取成功后再调用不重复拉取**（12h TTL 内命中缓存）', async () => {
    const fetchRemoteModels = vi.fn(async () => [
      { id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
    ])
    const { adapter } = makeAdapter(() => sseResponse(''), { fetchRemoteModels })
    await adapter.listModels('trae-cn')
    await adapter.listModels('trae-cn')
    await adapter.resolveModel('trae-cn', 'remote-only')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    expect(TRAE_CN_MODELS_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('**目录拉取失败不写缓存**（下一次调用会重试，而不是永久停在静态表）', async () => {
    let attempt = 0
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('network down')
        return [{ id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION }]
      },
    })
    // 第一次失败 → 静态表（11 项）。
    expect(await adapter.listModels('trae-cn')).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
    // 第二次成功 → 远端目录生效（若失败被缓存，这里仍是 11 项）。
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).toEqual(['remote-only'])
    expect(attempt).toBe(2)
  })

  it('**动态目录的多模态标记由静态表补齐**（否则支持图片的模型会全变纯文本）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'kimi-k3', name: 'Kimi-K3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
        { id: 'glm-5.3', name: 'GLM-5.3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
        // 远端独有 id：静态表没有它 → 多模态未知 → 保守判纯文本。
        { id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    const byId = new Map((await adapter.listModels('trae-cn')).map((m) => [m.id, m]))
    expect(byId.get('kimi-k3')!.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('glm-5.3')!.inputModalities).toEqual(['text'])
    expect(byId.get('remote-only')!.inputModalities).toEqual(['text'])
  })

  it('**应用账号池的模型黑名单**（黑名单制：只滤显式关闭的）', async () => {
    const disabledModelsFor = vi.fn(() => new Set(['glm-5.2']))
    const { adapter } = makeAdapter(() => sseResponse(''), {
      accountPool: { disabledModelsFor } as never,
    })
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    expect(disabledModelsFor).toHaveBeenCalledWith('trae-cn')
    expect(ids).not.toContain('glm-5.2')
    expect(ids).toContain('kimi-k3')
  })

  it('黑名单每次调用实时读取（改开关后无需重建适配器）', async () => {
    let disabled = new Set<string>()
    const { adapter } = makeAdapter(() => sseResponse(''), {
      accountPool: { disabledModelsFor: () => disabled } as never,
    })
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).toContain('glm-5.2')
    disabled = new Set(['glm-5.2'])
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).not.toContain('glm-5.2')
  })
})

describe('TraeCnAdapter resolveModel', () => {
  it('用静态表给出真机目录的上下文窗口（dev 档）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(await adapter.resolveModel('trae-cn', 'glm-5.2')).toMatchObject({
      provider: 'trae-cn', id: 'glm-5.2', name: 'GLM-5.2', context: { contextWindow: 119_040 },
    })
    // 另一档（262144 / 204800）各点一次，防止整表被改成同一个数还绿。
    expect((await adapter.resolveModel('trae-cn', 'Doubao-Seed-Evolving')).context)
      .toEqual({ contextWindow: 262_144 })
    expect((await adapter.resolveModel('trae-cn', 'qwen3.8-max')).context)
      .toEqual({ contextWindow: 204_800 })
  })

  /**
   * dev / Max 档位选择（Account Hub 的档位单选列）。
   *
   * 机制是**纯声明值切换**：只改我们向 DSH 声明的窗口（它决定宿主压缩阈值
   * `0.8 × 窗口` 与压缩后的保留预算），出站请求体一个字段都不动 —— 这是红线，
   * 由下面那条「逐字节比对两次请求体」的用例钉死。
   *
   * 判据是「预算值必须**精确命中**目录公布的 Max 档」：未设置、等于 dev、
   * 编造值、目录漂移后旧值失效，四种情况一律静默退回 dev 档。
   */
  describe('上下文窗口档位（dev / Max）', () => {
    /** 目录形态：一个两档模型 + 一个单档模型。 */
    const catalog: TraeCnModelEntry[] = [
      {
        id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 119_040, maxContextWindow: 1_048_576,
        function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      },
      { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, function: TRAE_CN_SOLO_REMOTE_FUNCTION },
    ]

    /** 构造一个「目录固定 + 池里带若干预算」的适配器。 */
    function withBudget(budgets: Record<string, number>, responder = () => sseResponse(textStream('ok'))) {
      return makeAdapter(responder, {
        fetchRemoteModels: async () => catalog,
        accountPool: {
          contextBudget: (_provider: string, model: string) => budgets[model],
          // 断言「出站请求体与档位无关」那条会真的走一遍 `stream()`；池里给出一个
          // 能匹配到的账号 id，免得适配器每次都打一行「未匹配到账号池条目」的警告
          // 把测试输出淹掉（那与档位无关）。
          findAccountIdByCredential: async () => 'acct-1',
        } as never,
      })
    }

    it('预算 = 目录公布的 Max 档 → 声明 Max', async () => {
      const { adapter } = withBudget({ 'glm-5.3': 1_048_576 })
      expect((await adapter.resolveModel('trae-cn', 'glm-5.3')).context)
        .toEqual({ contextWindow: 1_048_576 })
    })

    it('未设置 / 恰好等于 dev / 编造值 → 一律声明 dev', async () => {
      for (const budgets of [{}, { 'glm-5.3': 119_040 }, { 'glm-5.3': 999_999_999 }]) {
        const { adapter } = withBudget(budgets)
        expect((await adapter.resolveModel('trae-cn', 'glm-5.3')).context, JSON.stringify(budgets))
          .toEqual({ contextWindow: 119_040 })
      }
    })

    it('**无 Max 档的模型**带任何预算都只声明 dev（不给不存在的档位）', async () => {
      const { adapter } = withBudget({ 'kimi-k2.6': 1_048_576, 'glm-5.3': 200_000 })
      expect((await adapter.resolveModel('trae-cn', 'kimi-k2.6')).context)
        .toEqual({ contextWindow: 200_000 })
      // 反证：同一适配器里两档模型仍能命中（否则上面可能因为「预算整个没读」而假通过）。
      expect((await adapter.resolveModel('trae-cn', 'glm-5.3')).context)
        .toEqual({ contextWindow: 119_040 })
    })

    it('**目录漂移后旧预算自动失效**（Max 档改值 → 静默退回 dev，不报错）', async () => {
      // 用户按旧的 Max(524288) 选过档，上游后来把它改成 1048576：旧值不再命中。
      const { adapter } = withBudget({ 'glm-5.3': 524_288 })
      expect((await adapter.resolveModel('trae-cn', 'glm-5.3')).context)
        .toEqual({ contextWindow: 119_040 })
    })

    it('**静态回退路径下预算永远不生效**（静态表不带 Max 档）', async () => {
      const { adapter } = makeAdapter(() => sseResponse(''), {
        accountPool: {
          // 拿静态表的 dev 档当预算值也照样退回 dev：没有 maxContextWindow 就没有档位。
          contextBudget: () => 119_040,
        } as never,
      })
      expect((await adapter.resolveModel('trae-cn', 'glm-5.3')).context)
        .toEqual({ contextWindow: 119_040 })
    })

    it('**出站请求体与档位无关**（红线：切换档位不改请求体一个字节）', async () => {
      const options = generateOptions({ model: 'glm-5.3' })
      const dev = withBudget({})
      await collect(dev.adapter, options)
      const max = withBudget({ 'glm-5.3': 1_048_576 })
      await collect(max.adapter, options)
      expect(dev.calls).toHaveLength(1)
      expect(max.calls).toHaveLength(1)
      expect(String(max.calls[0]!.init?.body)).toBe(String(dev.calls[0]!.init?.body))
      // 反证：两条路径确实各自发了请求（不是「都没发」而恒等）。
      expect(String(dev.calls[0]!.init?.body)).toContain('"config_name":"glm-5.3"')
    })
  })

  describe('contextTiers（供 Account Hub 渲染与校验档位）', () => {
    it('逐模型给 dev / Max；单档模型只带 dev', async () => {
      const { adapter } = makeAdapter(() => sseResponse(''), {
        fetchRemoteModels: async () => [
          {
            id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 119_040, maxContextWindow: 1_048_576,
            function: TRAE_CN_SOLO_REMOTE_FUNCTION,
          },
          { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000, function: TRAE_CN_SOLO_REMOTE_FUNCTION },
        ],
      })
      const tiers = await adapter.contextTiers()
      expect(tiers.get('glm-5.3')).toEqual({ contextWindow: 119_040, maxContextWindow: 1_048_576 })
      expect(tiers.get('kimi-k2.6')).toEqual({ contextWindow: 200_000 })
      expect(tiers.get('kimi-k2.6')).not.toHaveProperty('maxContextWindow')
    })

    it('**静态回退路径下 11 项一个 Max 都没有**（模型自动无档位 UI，是预期行为）', async () => {
      const { adapter } = makeAdapter(() => sseResponse(''))
      const tiers = await adapter.contextTiers()
      expect(tiers.size).toBe(TRAE_CN_FALLBACK_MODELS.length)
      for (const [id, tier] of tiers) {
        expect(tier, id).not.toHaveProperty('maxContextWindow')
        expect(typeof tier.contextWindow, id).toBe('number')
      }
    })
  })

  it('resolveModel 的 inputModalities 与 listModels **同源同口径**', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // 两处不一致会让选择器显示「支持图片」而请求路径按纯文本处理（或反之）。
    expect((await adapter.resolveModel('trae-cn', 'kimi-k3')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('trae-cn', 'DeepSeek-V4-Pro-Official')).inputModalities).toEqual(['text'])
  })

  it('**声明** reasoning：glm-5.2 是真机的 high/extra_high 两档，默认 high', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // 这条断言曾经锁死的是**缺陷**：resolveModel 刻意不声明 reasoning，
    // 于是 DSH 的「思考程度」选择器整行不渲染（那是唯一数据源）。
    const reasoning = (await adapter.resolveModel('trae-cn', 'glm-5.2')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['high', 'extra_high'])
    expect(reasoning?.defaultEffort).toBe('high')
  })

  it('档位 id **逐字符**照抄真机值（含 extra_high 这种非标准档）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // DSH 的 ReasoningEffortId 是 branded string、**不校验取值**；
    // 改写 id 会让请求体里的档位与上游对不上。
    const ids = (await adapter.resolveModel('trae-cn', 'glm-5.3')).reasoning?.efforts.map((e) => e.id)
    expect(ids).toEqual(['light', 'high', 'extra_high'])
  })

  it('kimi-k3 的默认档是 extra_high（真机 default_level，与其余模型不同）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // 同族的 `kimi-k2.8-preview` 已随 5 项 SOLO 不可调 id 一起剔除，故这里只剩它。
    const reasoning = (await adapter.resolveModel('trae-cn', 'kimi-k3')).reasoning
    expect(reasoning?.defaultEffort).toBe('extra_high')
    expect(reasoning?.efforts.map((e) => e.id)).toContain('extra_high')
  })

  it('无档位的三个模型与表外模型**仍不声明** reasoning', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // 真机 support_thinking:false —— 声明了会让用户以为档位生效。
    for (const model of ['minimax-m3', 'qwen-3.7-plus', 'Doubao-Seed-Evolving']) {
      expect((await adapter.resolveModel('trae-cn', model)).reasoning, model).toBeUndefined()
    }
    expect((await adapter.resolveModel('trae-cn', 'brand-new')).reasoning).toBeUndefined()
  })

  it('档位形状满足 DSH 校验（四种畸形各防一条，避免 resolveModel 被改成非法形态）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      const reasoning = (await adapter.resolveModel('trae-cn', model.id)).reasoning
      if (reasoning === undefined) continue
      // 1. efforts 不能为空数组（DSH: INVALID_MODEL_REASONING）
      expect(reasoning.efforts.length, model.id).toBeGreaterThan(0)
      for (const effort of reasoning.efforts) {
        // 2. id / 3. name 都不能为空串
        expect(effort.id.length, model.id).toBeGreaterThan(0)
        expect(effort.name.length, model.id).toBeGreaterThan(0)
      }
      // 4. id 不能重复
      const ids = reasoning.efforts.map((e) => e.id)
      expect(new Set(ids).size, model.id).toBe(ids.length)
      // 5. defaultEffort 必须在 efforts 内（否则 DSH 直接抛错）
      if (reasoning.defaultEffort !== undefined) {
        expect(ids, model.id).toContain(reasoning.defaultEffort)
      }
    }
  })

  it('档位与 listModels 一致：表里声明了档位的模型正是选择器里有档位的那些', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      const declared = (await adapter.resolveModel('trae-cn', model.id)).reasoning !== undefined
      const expected = (model.reasoningEfforts?.length ?? 0) > 0
      expect(declared, model.id).toBe(expected)
    }
    // 原真机 16 项里 13 项有档位；剔除的 5 项里 5 项都有档位，故现存 11 项里 8 项。
    // 数一下，避免整表被改成全有/全无还绿。
    const withEffort = TRAE_CN_FALLBACK_MODELS.filter((m) => (m.reasoningEfforts?.length ?? 0) > 0)
    expect(withEffort).toHaveLength(8)
    // 无档位的 3 项也点一次：它们的理由与「剔除」无关（真机 support_thinking:false）。
    expect(withEffort.map((m) => m.id)).not.toContain('minimax-m3')
    expect(withEffort.map((m) => m.id)).not.toContain('qwen-3.7-plus')
    expect(withEffort.map((m) => m.id)).not.toContain('Doubao-Seed-Evolving')
  })

  it('未知模型回退为 id 作展示名且不报错（模态保守判纯文本）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(await adapter.resolveModel('trae-cn', 'brand-new')).toMatchObject({
      id: 'brand-new', name: 'brand-new', inputModalities: ['text'],
    })
  })

  it('远端给了展示名时优先用远端', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'glm-5.2', name: '远端 GLM', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    expect((await adapter.resolveModel('trae-cn', 'glm-5.2')).name).toBe('远端 GLM')
  })

  it('**远端条目没带档位时，按 id 从静态表补上**（本次缺陷的核心）', async () => {
    // ⚠️ 这条断言曾经锁死的是**缺陷**：它写的是「远端没给档位就不声明」，
    // 而 SOLO 目录端点**根本不提供档位**（`support_thinking` 恒 false），
    // 于是动态目录一旦生效，「思考程度」选择器整行消失 —— 用户报的正是这个。
    // 正确语义：档位判据是「条目自己有没有档位」，没有就按 id 从静态表补。
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'glm-5.2', name: 'GLM-5.2', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    const reasoning = (await adapter.resolveModel('trae-cn', 'glm-5.2')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['high', 'extra_high'])
    expect(reasoning?.defaultEffort).toBe('high')
  })

  it('**远端独有 id 仍不声明档位**（静态表没有它 → 不编造）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    expect((await adapter.resolveModel('trae-cn', 'remote-only')).reasoning).toBeUndefined()
  })

  it('**目录明说 `support_thinking:false` 不阻止补齐**（判据不是目录字段）', async () => {
    // 目录端点对 9/10 项回的是 `{support_thinking:false}` 空壳。若照「目录已表态
    // 就不覆盖」写，档位永远补不上；这里的条目形态就是那个空壳解析后的结果
    // （`parseTraeCnDirectory` 读不出档位 → 条目上无 reasoningEfforts）。
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [
        { id: 'kimi-k3', name: 'Kimi-K3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    const reasoning = (await adapter.resolveModel('trae-cn', 'kimi-k3')).reasoning
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['light', 'high', 'extra_high'])
    // kimi-k3 的默认档是 extra_high（与其余模型不同）。
    expect(reasoning?.defaultEffort).toBe('extra_high')
  })

  it('**补齐后 listModels 与 resolveModel 的档位口径一致**（8 项都有档位）', async () => {
    // 用真实 roster 形态（不带档位）走一遍：过滤后 13 项里应有 8 项声明档位。
    const ids = [
      'Doubao-Seed-Evolving', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-2.1-Turbo', 'glm-5.3', 'glm-5.2',
      'DeepSeek-V4-Flash-Official', 'DeepSeek-V4-Pro-Official', 'kimi-k3', 'kimi-k2.7-code',
      'kimi-k2.6', 'minimax-m3', 'qwen3.8-max', 'qwen-3.7-plus',
    ]
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => ids.map((id) => ({
        id, name: id, usage: 'chat_completion', function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      })),
    })
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).toEqual(ids)
    let declared = 0
    for (const id of ids) {
      const reasoning = (await adapter.resolveModel('trae-cn', id)).reasoning
      if (reasoning !== undefined) declared += 1
    }
    expect(declared).toBe(8)
    // 反证：三个无档位项确实没有（避免「全补上」也算通过）。
    for (const id of ['minimax-m3', 'qwen-3.7-plus', 'Doubao-Seed-Evolving']) {
      expect((await adapter.resolveModel('trae-cn', id)).reasoning, id).toBeUndefined()
    }
    // 动态独有项也必须**能**补上档位（kimi-k2.6 不在静态表 → 无档位）。
    expect((await adapter.resolveModel('trae-cn', 'kimi-k2.6')).reasoning).toBeUndefined()
  })
})

describe('TraeCnAdapter 请求构造', () => {
  it('POST 到 **SOLO 通道**（`/api/agent/v3/llm_utils_chat`，仍在 IDE 网关 host 上）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${TRAE_CN_IDE_API_BASE}${TRAE_CN_CHAT_PATH}`)
    // 端点迁移的**唯一判据**（旧 `/api/ide/v1/chat` 对新池恒回 3003）：
    expect(TRAE_CN_CHAT_PATH).toBe('/api/agent/v3/llm_utils_chat')
    // host 不变（迁移只动路径，不动 host）。
    expect(new URL(calls[0]!.url).host).toBe('trae-api-cn.mchost.guru')
    expect(new URL(calls[0]!.url).origin).not.toBe(TRAE_CN.apiBase)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('**不再存在旧端点常量**（`/api/ide/v1/chat` 与候选表已删除，不留死代码）', async () => {
    // 用源码扫描而不是 import 断言：常量被删掉时 import 会直接编译失败，
    // 而「有人把它加回来」只有扫描源码才拦得住。只看**赋值语句**，
    // 注释里提到旧路径（迁移留痕）是允许且必要的。
    const { readFileSync } = await import('node:fs')
    const productSource = readFileSync(new URL('../../src/trae-cn-product.ts', import.meta.url), 'utf8')
    const assignments = productSource.split('\n').filter((line) => line.startsWith('export const '))
    expect(assignments.join('\n')).not.toContain('/api/ide/v1/chat')
    expect(assignments.join('\n')).not.toContain('TRAE_CN_CHAT_PATH_CANDIDATES')
    expect(assignments.join('\n')).toContain("export const TRAE_CN_CHAT_PATH = '/api/agent/v3/llm_utils_chat'")
  })

  it('请求头用 Cloud-IDE-JWT + 两个同值 token 头，且**不带**腾讯系归属头', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    const headers = calls[0]!.init?.headers as Record<string, string>
    // 普通对象（非 Headers 实例）：与 credits 模块一致，避免 Headers 构造器
    // 丢弃/规范化部分请求头导致两处形态不一致。
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT AT-1')
    expect(headers['X-Ide-Token']).toBe('AT-1')
    expect(headers['X-Cloudide-Token']).toBe('AT-1')
    expect(headers['Accept']).toBe('text/event-stream')
    // 归属头：Trae CN 一个都不发。
    for (const name of ['X-Domain', 'X-Product-Code', 'X-Product', 'X-LobsterAI-Client-Version']) {
      expect(headers[name]).toBeUndefined()
    }
  })

  it('**带齐 SOLO 通道网关全套头**（版本头换成 SOLO 代际 + 追踪/通道/身份头）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['x-app-id']).toBe(TRAE_CN_IDE_APP_ID)
    expect(headers['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
    // ⚠️ **版本头必须是 SOLO 代际的日期式版本码**：SOLO 网关按
    // `x-ide-version-code` 选模型配置表，发 IDE 代际的 `107` 选出的是**空表**
    // → 任何模型恒回 `4001 param is invalid`（迁移后 chat 全败的根因）。
    expect(headers['x-ide-version-code']).toBe('20260820')
    expect(headers['x-ide-version-code']).toBe(TRAE_CN_SOLO_VERSION_CODE)
    // 8 位日期式 `YYYYMMDD` —— 目录端点值扫描：只有该形态才命中非空配置表。
    expect(headers['x-ide-version-code']).toMatch(/^\d{8}$/)
    // `x-app-version-code` 与选表**无关**（已隔离验证），但同发 SOLO 代际，
    // 免得两个版本头互相矛盾。
    expect(headers['x-app-version-code']).toBe(TRAE_CN_SOLO_VERSION_CODE)
    expect(headers['x-ide-version']).toBe('0.1.61')
    expect(headers['x-ide-version']).toBe(TRAE_CN_SOLO_IDE_VERSION)
    expect(headers['x-ide-version-type']).toBe('stable')
    // ⚠️ SOLO 通道实测值：`prod`（旧 IDE 通道是 `normal`）。
    expect(headers['request-traffic-type']).toBe('prod')
    expect(TRAE_CN_REQUEST_TRAFFIC_TYPE).toBe('prod')
    // ⚠️ SOLO 通道 UA 是 `Trae/<SOLO 代际版本>`，**不是**旧通道的
    // `TraeClient/TTNet`，也不是签到线的 `3.3.102`（那是另一条协议线）。
    expect(headers['User-Agent']).toBe('Trae/0.1.61')
    expect(headers['User-Agent']).toBe(TRAE_CN_SOLO_USER_AGENT)
    expect(headers['x-plugin-channel']).toBe('icube-ai')
    // 追踪四头**同源**：requestId 一个 UUID，trace-id 是它去横线后的前 32 位。
    const requestId = headers['x-request-id']!
    expect(headers['x-trae-request-id']).toBe(requestId)
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    const traceId = requestId.replace(/-/g, '').slice(0, 32)
    expect(headers['x-custom-trace-id']).toBe(traceId)
    expect(headers['x-flow-traceparent']).toBe(`04-${traceId}-${traceId.slice(0, 16)}-01`)
    // `x-uid` 取凭据的 user_id（不是昵称、不是设备号）。
    expect(headers['x-uid']).toBe('uid-1')
    // ⚠️ chat 的设备头取凭据的 `device_id`（`BoundDeviceID`），
    // **不是**签到用的 `checkin_device_id`（登录时生成并上报的 16 位号）——
    // 两条协议线在 2026-09-20 的 9074 修复后**刻意分道**，
    // 见 `src/trae-cn-oauth.ts` 的 `traeCnCheckinDeviceId` 与 `src/trae-cn-credits.ts`。
    expect(headers['x-device-id']).toBe('1234567890123456')
    // 防「顺手统一」的回归点：`makeCredential()` 里两个设备号**不同值**，
    // 若有人把这里改成「优先 checkin_device_id」的签到语义，上一行会立刻变红
    // （已用变异测试确认：改动后本用例失败，而不是静默通过）。
    expect(makeCredential().checkin_device_id).not.toBe(makeCredential().device_id)
    expect(headers['x-device-type']).toBe('windows')
    // chat 与签到**必须报同一种设备身份**，故共用 `TRAE_CN_OS_VERSION`
    // （它是 `os.version()` 的模块级快照，2026-09-19 起不再是硬编码构建号）。
    expect(headers['x-os-version']).toBe(TRAE_CN_OS_VERSION)
    expect(headers['x-os-version']).toBe(osVersion())
  })

  it('**IDE 代际与 SOLO 代际的版本码是两组值**（同名不同物，不可合并）', () => {
    // 这条断言的价值在于「防止有人把两个代际的常量合并成一个」：
    // 它们在同一个请求头上，但 SOLO 网关按它选配置表，值域与语义都不同。
    expect(TRAE_CN_IDE_VERSION_CODE).toBe('107')
    expect(TRAE_CN_IDE_GATEWAY_VERSION).toBe('1.107.1')
    expect(TRAE_CN_SOLO_VERSION_CODE).not.toBe(TRAE_CN_IDE_VERSION_CODE)
    expect(TRAE_CN_SOLO_IDE_VERSION).not.toBe(TRAE_CN_IDE_GATEWAY_VERSION)
    // 形态也不同：IDE 代际是纯数字短码 / `1.x.y`，SOLO 代际是日期式 / `0.1.x`。
    expect(TRAE_CN_IDE_VERSION_CODE).toMatch(/^\d+$/)
    expect(TRAE_CN_SOLO_VERSION_CODE).toMatch(/^\d{8}$/)
    expect(TRAE_CN_SOLO_IDE_VERSION).toMatch(/^0\.1\./)
  })

  it('**每次请求的追踪 id 都是新的**（同一个 id 复用会让上游调用链混在一起）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    await collect(adapter, generateOptions())
    const first = (calls[0]!.init?.headers as Record<string, string>)['x-request-id']
    const second = (calls[1]!.init?.headers as Record<string, string>)['x-request-id']
    expect(first).not.toBe(second)
  })

  it('body：model / config_name / function / stream 恒为 true', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ model: 'kimi-k3' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.model).toBe('kimi-k3')
    // ⚠️ `config_name` 必须与 `model` 同值：网关按它选配置。
    expect(body.config_name).toBe('kimi-k3')
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('**function 路由**：静态表模型一律走 `solo_work_remote`（11 项全在 remote 集内）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ model: 'glm-5.3' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    // 写死 `solo_work_lite` 会让 glm-5.3 回 `4001 param is invalid`（真机实测）。
    expect(body.function).toBe(TRAE_CN_SOLO_REMOTE_FUNCTION)
    expect(body.function).toBe('solo_work_remote')
  })

  it('**function 路由跟随动态目录**：远端条目自带的 function 优先于静态回退值', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')), {
      fetchRemoteModels: async () => [
        { id: 'glm-5.3', name: 'GLM-5.3', function: TRAE_CN_SOLO_LITE_FUNCTION },
      ],
    })
    await collect(adapter, generateOptions({ model: 'glm-5.3' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.function).toBe('solo_work_lite')
  })

  it('表外模型（历史会话里的旧 id）回退 `solo_work_remote`', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ model: 'brand-new-model' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.function).toBe(TRAE_CN_SOLO_REMOTE_FUNCTION)
    expect(body.config_name).toBe('brand-new-model')
  })

  it('system 提示折叠进 messages 首位，且 content 是 `[{type,text}]` 数组', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ system: '你是助手' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: '你是助手' }] })
    // 后续 user 消息同样被改写成数组形态（上游不接受裸字符串）。
    expect(body.messages[1]!.content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('工具 schema 的 parameters **字符串化**；无工具时不发 tools', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { p: { type: 'string' } } } }],
    }))
    const withTools = JSON.parse(String(calls[0]!.init?.body)) as { tools: unknown[] }
    // ⚠️ 上游把 parameters 当字符串绑定，传对象会 4001 type mismatch。
    expect(withTools.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read',
        description: '读文件',
        parameters: JSON.stringify({ type: 'object', properties: { p: { type: 'string' } } }),
      },
    }])

    const second = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(second.adapter, generateOptions())
    expect(JSON.parse(String(second.calls[0]!.init?.body))).not.toHaveProperty('tools')
  })

  it('透传 temperature / maxTokens / stop；reasoningEffort 仅在显式传入时带', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ temperature: 0.3, maxTokens: 512, stop: ['END'] }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(512)
    expect(body.stop).toEqual(['END'])
    expect(body).not.toHaveProperty('reasoning_effort_level')
    // 字段名是 `reasoning_effort_level`：另一个名字**不得**出现（见下一条）。
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('档位下发用**真机定案的字段名** `reasoning_effort_level`，不是 `reasoning_effort`', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ reasoningEffort: 'extra_high' as never }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    // ⚠️ **换端点不改字段名**：SOLO 代际的第三方实现用 `reasoning_effort`，但那
    // 未做 A/B 验证；`reasoning_effort_level` 有 chat_v3 代际的三方互证（见
    // buildTraeCnSoloBody 的注释）。在有对比证据前维持有证据的那个。
    expect(body.reasoning_effort_level).toBe('extra_high')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('图片输入报 UNSUPPORTED_CONTENT（而不是静默丢弃）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', ref: { id: 'x' } } as never],
        source: { kind: 'user' },
      })],
    })
    const { error } = await collect(adapter, options)
    expect(error?.code).toBe('UNSUPPORTED_CONTENT')
    // 在取凭据/发请求之前就拒绝。
    expect(calls).toHaveLength(0)
  })
})

describe('buildTraeCnSoloBody（纯函数，逐字段锁死出站形态）', () => {
  /** 用 harness 的真实消息类型构造一次调用。 */
  function bodyOf(options: Partial<GenerateOptions> = {}, functionName = 'solo_work_remote') {
    return JSON.parse(buildTraeCnSoloBody(generateOptions(options), functionName)) as Record<string, unknown>
  }

  it('`role:"developer"` 改写为 `system`（上游没有 developer 角色）', () => {
    const body = buildTraeCnSoloBody({
      ...generateOptions(),
      messages: [{ role: 'developer', content: '你是助手' } as never],
    }, 'solo_work_remote')
    const messages = JSON.parse(body).messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: '你是助手' }] })
  })

  it('assistant 的 `tool_calls[].function` **改名 `function_call`**（出站改名）', () => {
    const body = buildTraeCnSoloBody({
      ...generateOptions(),
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"a":1}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
        },
      ] as never,
    }, 'solo_work_remote')
    const messages = JSON.parse(body).messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === 'assistant')!
    const calls = assistant.tool_calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    // ⚠️ 键是 `function_call`（无 er），且**不得**同时留着 `function`。
    expect(calls[0]!.function_call).toEqual({ name: 'read', arguments: '{"a":1}' })
    expect(calls[0]).not.toHaveProperty('function')
    // assistant 只有工具调用、没有正文 → content 为 null（不是空数组）。
    expect(assistant.content).toBeNull()
    // tool 消息带 tool_call_id（上游缺它会 400 整条请求）。
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.tool_call_id).toBe('c1')
  })

  it('`function` 字段按入参下发；`config_name` 恒等于 `model`', () => {
    const body = bodyOf({ model: 'glm-5.3' }, 'solo_work_lite')
    expect(body.function).toBe('solo_work_lite')
    expect(body.config_name).toBe('glm-5.3')
    expect(body.model).toBe('glm-5.3')
    expect(body.stream).toBe(true)
  })
})

describe('TraeCnAdapter 凭据处理', () => {
  it('凭据缺失时抛 MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), {
      resolveCredential: async () => undefined,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('**stream 把 options.model 传给 resolveCredential 与 refresh**', async () => {
    // 这是硬约定：账号池的限流过滤是**逐模型**的，传空串会让每次请求都先白跑
    // 一遍已限额的账号；refresh 用不同口径选号还会导致「解析到 B、却刷新了 A」。
    const resolveCredential = vi.fn(async () => makeCredential())
    const refresh = vi.fn(async () => {})
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), { resolveCredential, refresh })
    await collect(adapter, generateOptions({ model: 'kimi-k3' }))
    expect(resolveCredential).toHaveBeenCalledWith('kimi-k3')
  })

  it('凭据过期时先续期再发请求，且续期也用同一个 model', async () => {
    const refreshed: string[] = []
    const resolveCredential = vi.fn(async () => makeCredential({ expires_at: String(Date.now() - 1000) }))
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), {
      resolveCredential,
      refresh: async (model?: string) => { refreshed.push(model ?? '(空)') },
    })
    await collect(adapter, generateOptions({ model: 'glm-5.2' }))
    expect(refreshed).toEqual(['glm-5.2'])
  })

  it('HTTP 401 时续期一次并重试', async () => {
    let attempt = 0
    const refresh = vi.fn(async () => {})
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1
        ? new Response('unauthorized', { status: 401 })
        : sseResponse(textStream('ok'))
    }, { refresh })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(refresh).toHaveBeenCalled()
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })
})

describe('TraeCnAdapter 流内错误与换号', () => {
  it('**流内限流（HTTP 200 + 4008）触发换号** —— 这是本 provider 的主要失败模式', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_2' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1 ? sseResponse(errorStream(4008, '请求过于频繁')) : sseResponse(textStream('ok'))
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(calls).toHaveLength(2)
    // 换号时必须把已试账号传给池（否则拿回同一个账号，换号形同虚设）。
    expect(getAvailableAccount).toHaveBeenCalledWith('trae-cn', 'glm-5.2', expect.any(Set))
    // 刚失败的账号记上限流徽章。
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('所有账号都限流时报可读错误（带真实业务码），且不超过换号上限', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4008, '请求过于频繁')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: `acc-${Math.random()}`, provider: 'trae-cn' },
          credential: makeCredential({ access_token: 'AT-x' }),
        }),
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/请求过于频繁/)
    expect(error?.message).toMatch(/code=4008/)
    // 首账号 + 最多 (MAX_ROTATE - 1) 次换号 = 3 次请求。
    expect(calls).toHaveLength(3)
  })

  it('**全部账号 4008 耗尽 → 终报明说「积分已耗尽」**（不再只有限流措辞）', async () => {
    // 修复的缺陷：换号循环试遍后抛的是最后一次的真实原因，用户看不出
    // 「所有账号都这样」（⇒ 充值/等重置）还是「就这一个账号这样」（⇒ 再试）。
    // 而 4008 实测是**积分耗尽**（通用池 remain=0 时连 4 KB 小请求都 190ms 回它），
    // 说成「请求过于频繁」会让用户去等一个永远不会到来的时刻。
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4008, 'Your requests have exceeded the quota.')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        // 池里**再没有**下一个账号 → 退出原因应为 pool-exhausted。
        getAvailableAccount: async () => null,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    // 上游原文**必须保留**（真机排障要靠它与字节文档对上号）。
    expect(error?.message).toMatch(/Your requests have exceeded the quota\./)
    expect(error?.message).toMatch(/code=4008/)
    // 中文终报：明确指出是积分耗尽 + 全部账号 + 给出下一步。
    expect(error?.message).toMatch(/全部账号的 Trae CN 通用积分均已耗尽/)
    expect(error?.message).toMatch(/请充值或等待额度周期重置/)
    // 关键的一句：它不是频率限流，等不会好。这是用户此前最容易被误导的点。
    expect(error?.message).toMatch(/这不是频率限流，稍后重试不会自愈/)
    // 错误码仍是可重试的 RATE_LIMIT（换号机制与 DSH 重试层语义都未改动）。
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('**换号达上限（池里还有账号）→ 终报不谎称「全部账号」**', async () => {
    // 池里有更多账号、只是换号次数到顶了就停 —— 此时说「全部账号已耗尽」会让
    // 用户去给每个账号充值，而其中一些可能根本没问题。主语必须降级。
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4008, 'quota')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        // 永远返回一个新的可用账号：池「looks」无穷，故退出只可能是 round cap。
        getAvailableAccount: async () => ({
          entry: { id: `acc-${Math.random()}`, provider: 'trae-cn' },
          credential: makeCredential({ access_token: 'AT-x' }),
        }),
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(3)
    // 必须**不**出现「全部账号」这个断言，改说「已尝试的账号」+ 声明池中可能还有。
    expect(error?.message).not.toMatch(/全部账号的/)
    expect(error?.message).toMatch(/已尝试的账号的 Trae CN 通用积分均已耗尽/)
    expect(error?.message).toMatch(/换号次数已达上限，池中可能还有未尝试的账号/)
  })

  it('**部分账号可用时仍正常换号**（终报改进不干扰换号主路径）', async () => {
    // 反向回归：终报文案只影响「全都失败」的出口，换号本身一行未动。
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      // 第 1 个账号 4008 耗尽 → 换号 → 第 2 个账号正常返回。
      return attempt === 1
        ? sseResponse(errorStream(4008, 'Your requests have exceeded the quota.'))
        : sseResponse(textStream('好了'))
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(getAvailableAccount).toHaveBeenCalledWith('trae-cn', 'glm-5.2', expect.any(Set))
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('**没有账号池时不谈「账号」**（单凭据场景不得编造池状态）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4008, 'quota')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('RATE_LIMIT')
    expect(error?.message).toMatch(/code=4008/)
    // 没有池 ⇒ 不存在「全部/已尝试的账号」这回事，不得追加任何池结论。
    expect(error?.message).not.toMatch(/全部账号的/)
    expect(error?.message).not.toMatch(/已尝试的账号的/)
    expect(error?.message).not.toMatch(/均已耗尽/)
  })

  it('**非额度类失败不追加池结论**（4023 模型不存在 ≠ 账号问题）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4023, '模型不存在')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => null,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/模型不存在/)
    expect(error?.message).not.toMatch(/积分/)
  })

  it('**已产出正文后失败也不追加池结论**（降级直报，与账号数量无关）', async () => {
    const body = traeSse([
      { event: 'output', data: { response: '半截' } },
      { event: 'error', data: { code: 4008, message: 'quota' } },
    ])
    const { adapter } = makeAdapter(() => sseResponse(body), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => null,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/quota/)
    expect(error?.message).not.toMatch(/全部账号的/)
  })

  it('**4022 端到端**：错误码为 CONTEXT_WINDOW_EXCEEDED 且文案含上游原文 + 中文说明', async () => {
    const upstream = "We're sorry, your prompt tokens have exceeded the maximum limit."
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4022, upstream)))
    const { error } = await collect(adapter, generateOptions())
    // 宿主据此压缩上下文并重试 —— 这是 1M token 长会话唯一的补救路径。
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(error?.message).toMatch(/code=4022/)
    expect(error?.message).toMatch(/exceeded the maximum limit/)
    expect(error?.message).toMatch(/上下文超出上游上限/)
    expect(error?.message).toMatch(/自动压缩/)
  })

  it('**4022 不换号**（与账号无关的确定性失败）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4022, 'too long')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('**4006 的文案仍然没有那句中文说明**（反向：本次只动 4022）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4006, 'prompt too long')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(error?.message).toMatch(/prompt too long/)
    expect(error?.message).not.toMatch(/上下文超出上游上限/)
  })

  it('**排队码（4000005）不换号**：只发一次请求，抛可重试错误', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4000005, '排队中')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.code).toBe('RATE_LIMIT')
    // 退避类**不记**冷却徽章：记了下一次选号会跳过该账号 = 偷偷换号。
    expect(updateModelRateLimit).not.toHaveBeenCalled()
  })

  it('**直报码（4001）不换号**，且错误码为 INVALID_REQUEST', async () => {
    const getAvailableAccount = vi.fn(async () => null)
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4001, '参数错误')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toMatch(/code=4001/)
    // 模型**在目录里**（glm-5.2）：这个 4001 与「模型不在目录」无关，
    // 故**不得**追加那句提示 —— 否则会把用户引去重选一个本来可用的模型。
    expect(error?.message).not.toMatch(/不在 Trae CN 可用目录/)
  })

  it('**表外模型的 4001 追加可读提示**（用户只需重选，而不是以为插件坏了）', async () => {
    // `glm-5.3-flash` 是刚被剔除的 5 项 SOLO 不可调 id 之一 —— 正是历史会话里
    // 最可能残留、且必然回 4001 的形态。
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4001, '参数错误')))
    const { error } = await collect(adapter, generateOptions({ model: 'glm-5.3-flash' }))
    expect(calls).toHaveLength(1)
    expect(error?.code).toBe('INVALID_REQUEST')
    // 原始诊断信息**必须保留**（不能只留提示），否则真机排障失去依据。
    expect(error?.message).toMatch(/code=4001/)
    expect(error?.message).toMatch(/参数错误/)
    expect(error?.message).toMatch(/不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选/)
  })

  it('表外模型**在动态目录里**时不追加提示（判定与 function 路由同源）', async () => {
    // 远端目录给出了 `brand-new`，它因此**在**当前目录里：此时 4001 是别的
    // 原因（请求形态），提示会误导用户去重选一个刚被目录列出的模型。
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4001, '参数错误')), {
      fetchRemoteModels: async () => [
        { id: 'brand-new', name: 'Brand New', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      ],
    })
    const { error } = await collect(adapter, generateOptions({ model: 'brand-new' }))
    expect(error?.message).toMatch(/code=4001/)
    expect(error?.message).not.toMatch(/不在 Trae CN 可用目录/)
  })

  it('**非 4001 的错误不加提示**（4023 上游自带语义，文案已够清楚）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4023, '模型不存在')))
    const { error } = await collect(adapter, generateOptions({ model: 'glm-5.3-flash' }))
    expect(error?.message).toMatch(/模型不存在/)
    expect(error?.message).not.toMatch(/不在 Trae CN 可用目录/)
  })

  it('4006（请求超长）映射为 CONTEXT_WINDOW_EXCEEDED（触发上下文压缩）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4006, 'prompt too long')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('未知码直报，且把原始码带进错误文案（便于真机校准）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(77777, '未知错误')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toMatch(/code=77777/)
  })

  it('**已产出正文后不再换号**（避免用户看到半截回答 + 完整回答两段内容）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    const body = traeSse([
      { event: 'output', data: { response: '我已经说了一半' } },
      { event: 'error', data: { code: 4008, message: '中途限流' } },
    ])
    const { adapter, calls } = makeAdapter(() => sseResponse(body), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.message).toMatch(/中途限流/)
    // 但不换号**不等于**不记录：这次限流是真实发生的，要留下徽章，
    // 否则用户事后完全看不到原因。
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
  })

  it('**HTTP 5xx 退避但不换号**（网关故障与账号无关，换个账号只会同样失败）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter, calls } = makeAdapter(() => new Response('bad gateway', { status: 502 }), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    // 可重试码交给 DSH 的重试层退避，而不是烧掉其它账号的额度。
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('**HTTP 401/403 换号**（凭据被拒是账号级问题）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    // 首个账号 401 → 适配器先续期一次并重试（仍是 401）→ 再换号。
    let call = 0
    const { adapter, calls } = makeAdapter(() => {
      call += 1
      return call <= 2 ? new Response('unauthorized', { status: 401 }) : sseResponse(textStream('ok'))
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(getAvailableAccount).toHaveBeenCalled()
    expect(calls).toHaveLength(3)
  })

  it('无账号池时限流直接报错，且**只发一次**请求', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4008, '限流')))
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('零产出（done 但没有内容块）抛 EMPTY_RESPONSE，且不换号', async () => {
    const getAvailableAccount = vi.fn(async () => null)
    const { adapter, calls } = makeAdapter(
      () => sseResponse(traeSse([{ event: 'done', data: {} }])),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount,
        } as never,
      },
    )
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('EMPTY_RESPONSE')
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
  })

  it('传输层失败映射为可重试的 TRANSPORT', async () => {
    const { adapter } = makeAdapter(() => { throw new TypeError('fetch failed') })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('TRANSPORT')
  })
})

describe('TraeCnAdapter 收尾判定', () => {
  it('正常结束 → finish: stop', async () => {
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('有工具调用 → finish: tool-calls', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"a":1}' } },
      { event: 'done', data: {} },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('**中断流（无 done）→ finish: max-tokens**（不让 harness 执行残缺参数）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'output', data: { response: '半截' } },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('工具参数残缺 → finish: max-tokens（而不是 tool-calls）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"a"' } },
      { event: 'done', data: {} },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('Trae CN 目录解析（parseTraeCnDirectory）', () => {
  /** 一条实测形态的目录条目。 */
  const entry = {
    config_name: 'glm-5.3',
    display_config: { display_name: 'GLM-5.3' },
    model_detail_list: [{ prompt_max_tokens: 119_040, max_tokens: 64_000 }],
    context_window_tokens: { dev: 119_040, max: 1_048_576 },
  }

  it('只读实测路径 `config_info_list`；字段按实测形态取', () => {
    expect(parseTraeCnDirectory({ config_info_list: [entry] }, 'solo_work_remote')).toEqual([{
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 119_040,
      // 实测样例的 Max 档（`context_window_tokens.max`）**严格大于** dev 档 → 收下。
      maxContextWindow: 1_048_576,
      maxTokens: 64_000,
      function: 'solo_work_remote',
    }])
  })

  /**
   * Max 档的收与不收。
   *
   * 收下一条「max <= dev」的条目，用户会看到一个切过去毫无效果的档位
   * （Work 侧实测就是 `{dev: 184000, max: 184000}` 这种两档同值形态）；
   * 收下一条 dev 缺失的条目，则会声明一个没有默认档可退的 Max。
   * 故判据是**严格大于**，边界一个都不放过。
   */
  it('Max 档只在**严格大于** dev 档时收下（dev==max / 更小 / 0 / 缺失都不收）', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [
        { config_name: 'a', context_window_tokens: { dev: 119_040, max: 1_048_576 } },
        // Work 侧实测形态：两档同值。
        { config_name: 'b', context_window_tokens: { dev: 184_000, max: 184_000 } },
        // 脏数据：max 比 dev 小。
        { config_name: 'c', context_window_tokens: { dev: 200_000, max: 100_000 } },
        // max 为 0（实测真实下发过 `{dev: 200000, max: 0}`）。
        { config_name: 'd', context_window_tokens: { dev: 200_000, max: 0 } },
        // max 字段缺失。
        { config_name: 'e', context_window_tokens: { dev: 200_000 } },
        // dev 档本身缺失：没有可比对的基准，不收。
        { config_name: 'f', context_window_tokens: { max: 1_048_576 } },
        // 负数 / 字符串：`readPositive` 同口径，一律视为未声明。
        { config_name: 'g', context_window_tokens: { dev: 1_000, max: -5 } },
        { config_name: 'h', context_window_tokens: { dev: 1_000, max: '1048576' } },
      ],
    }, 'solo_work_remote')
    const byId = new Map(parsed.map((e) => [e.id, e]))
    // 反证：确实读到了 Max 字段（否则下面的循环可能因为整条链路失效而恒真）。
    expect(byId.get('a')).toMatchObject({ contextWindow: 119_040, maxContextWindow: 1_048_576 })
    for (const id of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(byId.get(id), id).not.toHaveProperty('maxContextWindow')
    }
    // dev 档本身仍然照常声明（不收 Max 不等于丢窗口）。
    expect(byId.get('e')).toMatchObject({ contextWindow: 200_000 })
    expect(byId.get('g')).toMatchObject({ contextWindow: 1_000 })
  })

  it('上下文窗口**取 dev、不取 prompt_max_tokens**（与官方客户端显示的 200K 同口径）', () => {
    // 真机形态：上游两个字段给两个数（`glm-5.3`：dev 200000 / prompt_max_tokens
    // 168000），而官方客户端显示 200K。早前取 `prompt_max_tokens` ⇒ 客户端 200K、
    // 我们 168K，用户看到「同模型两个数」。
    const parsed = parseTraeCnDirectory({
      config_info_list: [{
        config_name: 'm',
        model_detail_list: [{ prompt_max_tokens: 168_000 }],
        context_window_tokens: { dev: 200_000 },
      }],
    }, 'solo_work_remote')
    expect(parsed[0]).toMatchObject({ id: 'm', contextWindow: 200_000 })
  })

  it('dev 缺失时才回退 `prompt_max_tokens`（回退值，不是被取代值）', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [
        // 只有 prompt_max_tokens。
        { config_name: 'a', model_detail_list: [{ prompt_max_tokens: 168_000 }] },
        // dev 是脏数据（0 / 负数 / 字符串）→ 走 readPositive 口径，视为未声明。
        { config_name: 'b', model_detail_list: [{ prompt_max_tokens: 168_000 }], context_window_tokens: { dev: 0 } },
        { config_name: 'c', model_detail_list: [{ prompt_max_tokens: 168_000 }], context_window_tokens: { dev: '200000' } },
        // 两个都没有 → 不声明窗口。
        { config_name: 'd' },
      ],
    }, 'solo_work_remote')
    const byId = new Map(parsed.map((e) => [e.id, e]))
    expect(byId.get('a')).toMatchObject({ contextWindow: 168_000 })
    expect(byId.get('b')).toMatchObject({ contextWindow: 168_000 })
    expect(byId.get('c')).toMatchObject({ contextWindow: 168_000 })
    expect(byId.get('d')).not.toHaveProperty('contextWindow')
  })

  it('Max 的判据对着**实际生效的 dev 档**（一律是 `context_window_tokens.dev`）', () => {
    // 探针：生效档 = dev(100000)，max(200000) 严格大于它 → 收下。
    // 若误用 `prompt_max_tokens`(300000) 当基准，200000 <= 300000 就会**漏收**
    // 一个真实存在的 Max 档（口径写反的另一种表现）。
    const parsed = parseTraeCnDirectory({
      config_info_list: [{
        config_name: 'm',
        model_detail_list: [{ prompt_max_tokens: 300_000 }],
        context_window_tokens: { dev: 100_000, max: 200_000 },
      }],
    }, 'solo_work_remote')
    expect(parsed[0]).toMatchObject({ id: 'm', contextWindow: 100_000, maxContextWindow: 200_000 })
  })

  it('静态回退表**一律不带 Max 档**（4022 钳制是网关级证据，不是逐模型的档位表）', () => {
    const catalog = fallbackTraeCnCatalog()
    // 反证：表非空，否则下面的循环恒真。
    expect(catalog).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
    expect(catalog.length).toBeGreaterThan(0)
    for (const entry of catalog) {
      expect(entry, entry.id).not.toHaveProperty('maxContextWindow')
    }
    // 反向也成立：静态表**不是**「整表没有窗口」，dev 档一个不少。
    for (const entry of catalog) {
      expect(typeof entry.contextWindow, entry.id).toBe('number')
    }
    // 静态表的源数据里也没有该字段（不是「映射时忘了带」而是「本来就不该有」）。
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(model, model.id).not.toHaveProperty('maxContextWindow')
    }
  })

  it('上下文窗口回退 `context_window_tokens.dev`（缺 model_detail_list 时）', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [{ config_name: 'm1', context_window_tokens: { dev: 200_000, max: 0 } }],
    }, 'solo_work_remote')
    expect(parsed[0]).toMatchObject({ id: 'm1', name: 'm1', contextWindow: 200_000 })
    // 没读到 max_tokens 时字段**缺席**（不编造）。
    expect(parsed[0]).not.toHaveProperty('maxTokens')
  })

  it('缺展示名时以 id 兜底；缺 id / 非法条目被跳过', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [
        { config_name: 'm1' },
        { display_config: { display_name: '无 id' } },
        null,
        'x',
        { config_name: '   ' },
      ],
    }, 'solo_work_lite')
    expect(parsed).toEqual([{ id: 'm1', name: 'm1', function: 'solo_work_lite' }])
  })

  it('读 `reasoning_effort_config`：`support_thinking:true` + 非空 options 才声明', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [
        { config_name: 'a', reasoning_effort_config: { support_thinking: true, options: ['light', 'high'], default_level: 'high' } },
        // support_thinking 为假 → 不声明。
        { config_name: 'b', reasoning_effort_config: { support_thinking: false, options: null, default_level: '' } },
        // options 为空 → 不声明。
        { config_name: 'c', reasoning_effort_config: { support_thinking: true, options: [] } },
        // default_level 不在 options 内 → 只丢默认档、保留档位列表。
        { config_name: 'd', reasoning_effort_config: { support_thinking: true, options: ['high'], default_level: 'extra_high' } },
      ],
    }, 'solo_work_remote')
    expect(parsed[0]).toMatchObject({ reasoningEfforts: ['light', 'high'], defaultReasoningEffort: 'high' })
    expect(parsed[1]).not.toHaveProperty('reasoningEfforts')
    expect(parsed[2]).not.toHaveProperty('reasoningEfforts')
    expect(parsed[3]).toMatchObject({ reasoningEfforts: ['high'] })
    expect(parsed[3]).not.toHaveProperty('defaultReasoningEffort')
  })

  it('结构不符时返回空数组（**不做信封猜测**：调用方回退静态表）', () => {
    for (const bad of [null, 'x', 42, {}, { data: [] }, { config_info_list: null }, { config_info_list: 'nope' }]) {
      expect(parseTraeCnDirectory(bad, 'solo_work_remote')).toEqual([])
    }
  })
})

describe('Trae CN 目录合并与过滤（mergeTraeCnDirectory）', () => {
  const entryOf = (id: string, fn: string): TraeCnModelEntry => ({ id, name: id, function: fn })

  it('**remote 优先**：同名 id 以 remote 那份为准（function 也以 remote 为准）', () => {
    const merged = mergeTraeCnDirectory([
      { function: TRAE_CN_SOLO_REMOTE_FUNCTION, entries: [entryOf('glm-5.3', TRAE_CN_SOLO_REMOTE_FUNCTION)] },
      { function: TRAE_CN_SOLO_LITE_FUNCTION, entries: [entryOf('glm-5.3', TRAE_CN_SOLO_LITE_FUNCTION), entryOf('glm-5.2', TRAE_CN_SOLO_LITE_FUNCTION)] },
    ], true)
    const byId = new Map(merged.map((m) => [m.id, m]))
    expect(byId.get('glm-5.3')!.function).toBe(TRAE_CN_SOLO_REMOTE_FUNCTION)
    // lite 独有项被剔除（见下一条的理由）。
    expect(byId.has('glm-5.2')).toBe(false)
    expect(merged).toHaveLength(1)
  })

  it('**remote 成功时剔除 lite 独有项**（那些是内部 agent 项）', () => {
    const merged = mergeTraeCnDirectory([
      { function: TRAE_CN_SOLO_REMOTE_FUNCTION, entries: [entryOf('glm-5.3', TRAE_CN_SOLO_REMOTE_FUNCTION)] },
      { function: TRAE_CN_SOLO_LITE_FUNCTION, entries: [entryOf('some_internal_thing', TRAE_CN_SOLO_LITE_FUNCTION)] },
    ], true)
    expect(merged.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('remote 失败时**保留** lite 的非内部项（那时它是唯一数据源）', () => {
    const merged = mergeTraeCnDirectory([
      { function: TRAE_CN_SOLO_LITE_FUNCTION, entries: [entryOf('glm-5.2', TRAE_CN_SOLO_LITE_FUNCTION)] },
    ], false)
    expect(merged.map((m) => m.id)).toEqual(['glm-5.2'])
  })

  it('**内部 agent 项被过滤**（点名 + 形态两道网）', () => {
    for (const id of TRAE_CN_INTERNAL_CONFIG_NAMES) {
      expect(isInternalTraeCnConfig(id), id).toBe(true)
    }
    // 形态判据：含 agent / subagent 的一律内部项。
    for (const id of ['some_new_agent', 'X_SubAgent', 'file_search_agent_v3']) {
      expect(isInternalTraeCnConfig(id), id).toBe(true)
    }
    // 现存 11 项**一个都不该**命中（否则会误杀用户可调的模型）。
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(isInternalTraeCnConfig(model.id), model.id).toBe(false)
    }
    const merged = mergeTraeCnDirectory([
      { function: TRAE_CN_SOLO_REMOTE_FUNCTION, entries: [
        entryOf('glm-5.3', TRAE_CN_SOLO_REMOTE_FUNCTION),
        entryOf('summary', TRAE_CN_SOLO_REMOTE_FUNCTION),
        entryOf('explore_sub_agent_v2', TRAE_CN_SOLO_REMOTE_FUNCTION),
      ] },
    ], true)
    expect(merged.map((m) => m.id)).toEqual(['glm-5.3'])
  })
})

describe('Trae CN 目录拉取（fetchTraeCnDirectory，零网络）', () => {
  /** 造一个目录响应。 */
  function directoryResponse(ids: string[]): Response {
    return new Response(JSON.stringify({
      config_info_list: ids.map((id) => ({ config_name: id, display_config: { display_name: id } })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  it('两个 function 各拉一次，body 是实测定案的固定形态（另加一次 agent 组档位 GET）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      // 档位端点（`GET`，**无 body**）：本用例不关心档位，回一个合法的空本组即可
      // —— 档位数据源的解析/合并/降级由 `trae-cn-agent-tiers.spec.ts` 专门覆盖。
      if (String(url).startsWith(TRAE_CN_AGENT_MODELS_API_BASE)) {
        return new Response(JSON.stringify({ code: 0, data: { list: [{ function: 'solo_agent_remote', models: [] }] } }), {
          status: 200,
        })
      }
      const fn = (JSON.parse(String(init?.body)) as { function: string }).function
      return fn === TRAE_CN_SOLO_REMOTE_FUNCTION
        ? directoryResponse(['glm-5.3', 'glm-5.2'])
        : directoryResponse(['glm-5.2', 'lite_only_internal_agent'])
    }) as unknown as typeof fetch

    const entries = await fetchTraeCnDirectory(makeCredential(), { fetchImpl: fetcher })
    // IDE 目录端点仍是**两次 POST**（一个 function 一次，顺序不变）；
    // 第三次是档位数据源的 agent 组 GET（与目录同一刷新周期）。
    const directoryCalls = calls.filter((call) => call.url === `${TRAE_CN_IDE_API_BASE}${TRAE_CN_MODELS_PATH}`)
    expect(directoryCalls).toHaveLength(2)
    expect(calls[2]!.url).toBe(`${TRAE_CN_AGENT_MODELS_API_BASE}${TRAE_CN_AGENT_MODELS_PATH}${TRAE_CN_AGENT_MODELS_QUERY}`)
    expect(calls[2]!.init?.method).toBe('GET')
    expect(calls[0]!.url).toBe(`${TRAE_CN_IDE_API_BASE}${TRAE_CN_MODELS_PATH}`)
    expect(calls[0]!.init?.method).toBe('POST')
    // body 的固定字段逐项锁死（`function` 按轮次变化，其余恒为这些值）。
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    })
    expect(JSON.parse(String(calls[1]!.init?.body)).function).toBe(TRAE_CN_SOLO_LITE_FUNCTION)
    // 目录头与 chat 同源（鉴权三头 + SOLO 通道头），Accept 为 JSON。
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT AT-1')
    expect(headers['Accept']).toBe('application/json')
    expect(headers['request-traffic-type']).toBe('prod')
    // 结果：remote 优先 + 剔除 lite 独有项。
    expect(entries.map((e) => e.id)).toEqual(['glm-5.3', 'glm-5.2'])
    expect(entries.find((e) => e.id === 'glm-5.3')!.function).toBe(TRAE_CN_SOLO_REMOTE_FUNCTION)
  })

  it('单 function 失败不阻断另一个（HTTP 非 200 / 抛错都只跳过该 function）', async () => {
    const nonOk = vi.fn(async (url: unknown, init?: RequestInit) => {
      const fn = (JSON.parse(String(init?.body)) as { function: string }).function
      return fn === TRAE_CN_SOLO_REMOTE_FUNCTION
        ? new Response('boom', { status: 500 })
        : directoryResponse(['glm-5.2'])
    }) as unknown as typeof fetch
    // remote 失败 → remoteSucceeded 为假 → 保留 lite 的非内部项。
    expect((await fetchTraeCnDirectory(makeCredential(), { fetchImpl: nonOk })).map((e) => e.id))
      .toEqual(['glm-5.2'])

    const throws = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await fetchTraeCnDirectory(makeCredential(), { fetchImpl: throws })).toEqual([])
  })

  it('**多模态与思考档位都由静态表补齐**（applyTraeCnStaticMetadata 只补不增）', () => {
    const applied = applyTraeCnStaticMetadata([
      { id: 'kimi-k3', name: 'Kimi-K3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      { id: 'remote-only', name: 'Remote Only', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      // 目录将来若自带该字段，以目录为准（不被静态表覆盖）。
      { id: 'glm-5.3', name: 'GLM-5.3', supportsImages: true, function: TRAE_CN_SOLO_REMOTE_FUNCTION },
    ])
    expect(applied[0]!.supportsImages).toBe(true)
    // 档位**同源补上** —— 这是本次缺陷的核心：SOLO 目录不提供档位，
    // 不补的话「思考程度」选择器整行消失。
    expect(applied[0]!.reasoningEfforts).toEqual(['light', 'high', 'extra_high'])
    expect(applied[0]!.defaultReasoningEffort).toBe('extra_high')
    // 远端独有 id：静态表没有它 → 两个字段都仍然缺席（保守判纯文本、不声明档位），
    // **不新增条目**。
    expect(applied[1]).not.toHaveProperty('supportsImages')
    expect(applied[1]).not.toHaveProperty('reasoningEfforts')
    expect(applied[2]!.supportsImages).toBe(true)
    // 目录给的多模态不被覆盖，但档位仍补（两个字段判据独立）。
    expect(applied[2]!.reasoningEfforts).toEqual(['light', 'high', 'extra_high'])
    expect(applied).toHaveLength(3)
  })

  it('**档位补齐判据是 `reasoningEfforts === undefined`，不是目录的 `support_thinking`**', () => {
    // ⚠️ 这条用例锁死最容易写反的地方：目录的 `support_thinking` **恒为 false**
    // （实测 9/10 项都是 `{support_thinking:false}`，其余连字段都没有）。
    // 若照「目录已表态就不覆盖」写，档位将**永远补不上** —— 那正是本次要修的缺陷。
    const applied = applyTraeCnStaticMetadata([
      // 目录明说 support_thinking:false，但条目本身没有档位 → **必须补**。
      { id: 'glm-5.2', name: 'GLM-5.2', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
      // 反例：条目**自带**档位时不被静态表覆盖（目录将来真带上档位的情形）。
      {
        id: 'glm-5.2', name: 'GLM-5.2 远端', reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
        function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      },
      // 静态表本身无档位的项（minimax-m3）**不编造**。
      { id: 'minimax-m3', name: 'MiniMax-M3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
    ])
    expect(applied[0]!.reasoningEfforts).toEqual(['high', 'extra_high'])
    expect(applied[0]!.defaultReasoningEffort).toBe('high')
    // 自带档位的不覆盖：仍是远端那一档，而不是静态表的两档。
    expect(applied[1]!.reasoningEfforts).toEqual(['high'])
    expect(applied[2]).not.toHaveProperty('reasoningEfforts')
  })

  it('**8 项补齐档位且逐项等于静态表值**（含 kimi-k3 的默认档是 extra_high）', () => {
    // 用「目录原样返回静态表那 11 项」模拟真实 SOLO 目录：目录条目**不带**档位。
    const directoryShaped = TRAE_CN_FALLBACK_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
    }))
    const applied = applyTraeCnStaticMetadata(directoryShaped)
    const withEffort = applied.filter((entry) => entry.reasoningEfforts !== undefined)
    expect(withEffort).toHaveLength(8)
    for (const entry of applied) {
      const expected = TRAE_CN_FALLBACK_MODELS.find((m) => m.id === entry.id)!
      expect(entry.reasoningEfforts, entry.id).toEqual(expected.reasoningEfforts)
      expect(entry.defaultReasoningEffort, entry.id).toBe(expected.defaultReasoningEffort)
    }
    // 逐字符点名一条：档位 id 会原样进请求体，规整化会让上游认不出。
    expect(applied.find((e) => e.id === 'kimi-k3')!.defaultReasoningEffort).toBe('extra_high')
  })

  it('**minimax-m3 两条路径同口径**（目录实测 multimodal:false，静态表不再说 true）', () => {
    const staticValue = TRAE_CN_FALLBACK_MODELS.find((m) => m.id === 'minimax-m3')!.supportsImages
    // 静态表（目录整体失败时的路径）
    expect(staticValue).toBe(false)
    // 动态目录路径：条目不带该字段 → 由静态表补 → 同样是 false。
    const applied = applyTraeCnStaticMetadata([
      { id: 'minimax-m3', name: 'MiniMax-M3', function: TRAE_CN_SOLO_REMOTE_FUNCTION },
    ])
    expect(applied[0]!.supportsImages).toBe(false)
    // 反证：同表里确有 true 的项，避免「整表被改成 false」还绿。
    expect(TRAE_CN_FALLBACK_MODELS.find((m) => m.id === 'kimi-k3')!.supportsImages).toBe(true)
  })

  it('静态回退目录 = 11 项且全部映射到 `solo_work_remote`', () => {
    const catalog = fallbackTraeCnCatalog()
    expect(catalog).toHaveLength(11)
    for (const entry of catalog) {
      expect(entry.function, entry.id).toBe(TRAE_CN_SOLO_REMOTE_FUNCTION)
      expect(entry.id.length).toBeGreaterThan(0)
      expect(entry.name.length).toBeGreaterThan(0)
    }
  })

  it('目录请求头与 chat 头**同源**（同一个构造器，两处不可能分叉）', () => {
    const chat = traeCnSoloHeaders(makeCredential(), 'text/event-stream')
    const directory = traeCnSoloHeaders(makeCredential(), 'application/json')
    expect(directory['Accept']).toBe('application/json')
    expect(chat['Accept']).toBe('text/event-stream')
    // 除 Accept 外逐键相同（追踪 id 每次不同，故只比对键集合与固定值）。
    expect(Object.keys(directory).sort()).toEqual(Object.keys(chat).sort())
    for (const key of ['x-app-id', 'x-ide-version-code', 'request-traffic-type', 'x-plugin-channel', 'User-Agent', 'x-uid']) {
      expect(directory[key], key).toBe(chat[key])
    }
  })
})

// ── 四、目录过滤：custom（BYOK）与 invisible（客户端自隐） ──

/**
 * 实测 14 项账号私有 BYOK 项（2026-09-20 取证清单，逐字符照抄）。
 *
 * 它们的三方 key 存在**某个账号**的服务端，列出即误导别的账号。
 */
const TRAE_CN_CUSTOM_MODEL_IDS: readonly string[] = [
  'custom_model_gemini',
  'custom_model_placeholder',
  'custom_model_1M_text',
  'custom_model_1M',
  'custom_model_doubao_1M',
  'custom_model_doubao_256k',
  'custom_model_kimi',
  'custom_model_claude',
  'custom_model_gpt-6',
  'custom_model_gpt-5',
  'custom_model_no-fc',
  'custom_model_deepseek_chat',
  'custom_model_deepseek_reasoner',
  'custom_model_deepseek_v4',
]

/**
 * 实测 8 项 `is_invisible_to_user:true`（客户端自己隐藏）。
 *
 * ⚠️ 其中 `seed-code-pro-0430` / `Doubao-Seed-2.0-Code` 的展示名分别是
 * `Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo`（旧代际重名别名），
 * `sagitta` / `aquila` 的展示名是 `"-"`。
 */
const TRAE_CN_INVISIBLE_IDS: readonly string[] = [
  'seed-code-pro-0430',
  'Doubao-Seed-2.0-Code',
  'glm-5-turbo',
  'glm-5',
  'DeepSeek-V4-Flash',
  'DeepSeek-V4-Pro',
  'sagitta',
  'aquila',
]

/** 实测 26 项用户可调项（40 项并集剔除 5 内部 − 14 custom 后剩 21，其中 8 项 invisible）。 */
const TRAE_CN_PRESET_IDS: readonly string[] = [
  'Doubao-Seed-Evolving',
  'Doubao-Seed-2.1-Pro',
  'Doubao-Seed-2.1-Turbo',
  'glm-5.3',
  'glm-5.2',
  'DeepSeek-V4-Flash-Official',
  'DeepSeek-V4-Pro-Official',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'minimax-m3',
  'qwen3.8-max',
  'qwen-3.7-plus',
  'seed-code-pro-0430',
  'Doubao-Seed-2.0-Code',
  'glm-5-turbo',
  'glm-5',
  'DeepSeek-V4-Flash',
  'DeepSeek-V4-Pro',
  'sagitta',
  'aquila',
]

describe('Trae CN 目录过滤：custom（账号私有 BYOK）', () => {
  const entryOf = (id: string, extra: Partial<TraeCnModelEntry> = {}): TraeCnModelEntry =>
    ({ id, name: id, function: TRAE_CN_SOLO_REMOTE_FUNCTION, ...extra })

  it('**14 项 custom 零漏过**（主判据 `usage === "custom_model"`）', () => {
    for (const id of TRAE_CN_CUSTOM_MODEL_IDS) {
      expect(isCustomTraeCnModel(entryOf(id, { usage: 'custom_model' })), id).toBe(true)
    }
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        ...TRAE_CN_CUSTOM_MODEL_IDS.map((id) => entryOf(id, { usage: 'custom_model' })),
        entryOf('glm-5.3', { usage: 'chat_completion' }),
      ],
    }], true)
    expect(merged.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('**`usage` 缺失时由 id 前缀兜底**（上游漏发 `usage` 也不会漏过）', () => {
    for (const id of TRAE_CN_CUSTOM_MODEL_IDS) {
      // 不带 usage：只能靠形态判据。
      expect(isCustomTraeCnModel(entryOf(id)), id).toBe(true)
    }
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: TRAE_CN_CUSTOM_MODEL_IDS.map((id) => entryOf(id)),
    }], true)
    expect(merged).toEqual([])
  })

  it('**21 项 preset 零误伤**（正常项一个都不命中两条判据）', () => {
    for (const id of TRAE_CN_PRESET_IDS) {
      expect(isCustomTraeCnModel(entryOf(id, { usage: 'chat_completion' })), id).toBe(false)
    }
    // 反证：过滤后 normal 项仍在（否则「全被误杀」也会让上面那条假通过）。
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: TRAE_CN_PRESET_IDS.map((id) => entryOf(id, { usage: 'chat_completion' })),
    }], true)
    expect(merged).toHaveLength(TRAE_CN_PRESET_IDS.length)
  })

  it('**两个陷阱字段不得用作判据**（`config_source` 恒 1 / `is_custom_model` 恒 false）', () => {
    // 目录里 custom 与正常项的这两个字段**取值完全相同**，用它们判会零命中。
    // 这里锁死的是「判据只能是 usage + id 前缀」这一事实。
    const custom = entryOf('custom_model_gemini', { usage: 'custom_model' })
    const normal = entryOf('glm-5.3', { usage: 'chat_completion' })
    // 两个条目在接口层面**只有** usage / id 不同 —— 没有别的字段可供判定。
    expect(Object.keys(custom).sort()).toEqual(Object.keys(normal).sort())
    expect(isCustomTraeCnModel(custom)).toBe(true)
    expect(isCustomTraeCnModel(normal)).toBe(false)
  })
})

describe('Trae CN 目录过滤：invisible（客户端自隐项）', () => {
  const entryOf = (id: string, extra: Partial<TraeCnModelEntry> = {}): TraeCnModelEntry =>
    ({ id, name: id, function: TRAE_CN_SOLO_REMOTE_FUNCTION, ...extra })

  it('**8 项 invisible 全剔除**（含重名别名与展示名为 "-" 的两项）', () => {
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        ...TRAE_CN_INVISIBLE_IDS.map((id) => entryOf(id, { invisible: true })),
        entryOf('glm-5.3', { invisible: false }),
      ],
    }], true)
    expect(merged.map((m) => m.id)).toEqual(['glm-5.3'])
    for (const id of TRAE_CN_INVISIBLE_IDS) {
      expect(merged.map((m) => m.id), id).not.toContain(id)
    }
  })

  it('**`invisible: undefined` 不剔除**（14 项缺该字段，含两个正常项）', () => {
    // ⚠️ 写成 `!entry.invisible` 会把这 14 项全部误杀 —— 其中
    // `qwen3.8-max` / `qwen-3.7-plus` 是**正常可调项**。
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        entryOf('qwen3.8-max'),
        entryOf('qwen-3.7-plus'),
        entryOf('glm-5.3', { invisible: false }),
      ],
    }], true)
    expect(merged.map((m) => m.id)).toEqual(['qwen3.8-max', 'qwen-3.7-plus', 'glm-5.3'])
  })

  it('**kimi-k2.7-code / kimi-k2.6 必须保留**（`invisible:false` 的正常项）', () => {
    // 这两项**不在**静态表里（静态表是旧 IDE 通道的 16 项），只在 SOLO 目录出现；
    // 一旦被误判成 invisible，用户就永远看不到它们。
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        entryOf('kimi-k2.7-code', { invisible: false, usage: 'chat_completion' }),
        entryOf('kimi-k2.6', { invisible: false, usage: 'chat_completion' }),
      ],
    }], true)
    expect(merged.map((m) => m.id)).toEqual(['kimi-k2.7-code', 'kimi-k2.6'])
  })

  it('**解析器只把 `true` 读成 invisible**（false / 缺字段都不写该属性）', () => {
    const parsed = parseTraeCnDirectory({
      config_info_list: [
        { config_name: 'a', is_invisible_to_user: true, usage: 'chat_completion' },
        { config_name: 'b', is_invisible_to_user: false, usage: 'chat_completion' },
        { config_name: 'c', usage: 'chat_completion' },
        { config_name: 'd', is_invisible_to_user: 'true', usage: 'chat_completion' },
      ],
    }, TRAE_CN_SOLO_REMOTE_FUNCTION)
    expect(parsed[0]!.invisible).toBe(true)
    expect(parsed[1]).not.toHaveProperty('invisible')
    expect(parsed[2]).not.toHaveProperty('invisible')
    // 字符串 `"true"` **不算**（只认布尔，避免上游形态漂移时误杀）。
    expect(parsed[3]).not.toHaveProperty('invisible')
    expect(parsed.map((e) => e.usage)).toEqual(['chat_completion', 'chat_completion', 'chat_completion', 'chat_completion'])
  })
})

/**
 * 裸 id 版垃圾判定（`isTraeCnJunkModelId`）—— 服务于 `model.list` 的**黑名单
 * 并集回填**，那里的候选来自 settings 的**键名**，手上没有任何目录字段。
 *
 * 这组用例与上面的目录过滤共用同一批实测清单（`TRAE_CN_CUSTOM_MODEL_IDS` /
 * `TRAE_CN_INVISIBLE_IDS` / `TRAE_CN_PRESET_IDS`），因此它同时是**同源性断言**：
 * 两个判据对真实 roster 的结论必须一致，不能出现「目录里剔了、回填又补回来」。
 */
describe('Trae CN 垃圾 id 判定（裸 id，供 model.list 回填侧使用）', () => {
  it('**14 项 custom 全部命中**（前缀判据，无 usage 字段可用）', () => {
    for (const id of TRAE_CN_CUSTOM_MODEL_IDS) {
      expect(isTraeCnJunkModelId(id), id).toBe(true)
    }
  })

  it('**8 项 invisible 全部命中**（点名清单）', () => {
    for (const id of TRAE_CN_INVISIBLE_IDS) {
      expect(isTraeCnJunkModelId(id), id).toBe(true)
    }
  })

  it('**内部 agent 项全部命中**（点名 + 形态两道网）', () => {
    for (const id of TRAE_CN_INTERNAL_CONFIG_NAMES) {
      expect(isTraeCnJunkModelId(id), id).toBe(true)
    }
    // 形态命中的**将来项**也要挡住：上游随时可能新增一个 `xxx_agent`。
    expect(isTraeCnJunkModelId('some_new_subagent')).toBe(true)
    expect(isTraeCnJunkModelId('coder_agent_v3')).toBe(true)
  })

  it('**13 项可见目录零误伤**（= 40 − 5 内部 − 14 custom − 8 invisible）', () => {
    // ⚠️ 这里必须先把 8 项 invisible 从 preset 清单里剔掉：`TRAE_CN_PRESET_IDS`
    // 是「剔除了内部项与 custom 之后的 21 项」，其中 8 项是客户端自隐项 ——
    // 它们**本来就该**命中垃圾判定。剩下的 13 项才是真机目录的那 13 行。
    const visible = TRAE_CN_PRESET_IDS.filter((id) => !TRAE_CN_INVISIBLE_IDS.includes(id))
    expect(visible).toHaveLength(13)
    // 误杀的后果是用户**无法重新打开**一个真实模型 —— 比多显示一行僵尸更糟，
    // 因此这条断言是这组用例里最重要的一条。
    for (const id of visible) {
      expect(isTraeCnJunkModelId(id), id).toBe(false)
    }
  })

  it('**目录路径与回填路径对真实 roster 结论一致**（不产生「剔了又补回来」）', () => {
    // 两条判据必须同源：目录过滤（`mergeTraeCnDirectory`）剔掉的项，
    // `model.list` 的回填侧必须也认定它是垃圾，否则僵尸行会被补回列表 ——
    // 那正是本次缺陷的形态。
    const dropped = [
      ...TRAE_CN_CUSTOM_MODEL_IDS,
      ...TRAE_CN_INVISIBLE_IDS,
      ...TRAE_CN_INTERNAL_CONFIG_NAMES,
    ]
    for (const id of dropped) {
      expect(isTraeCnJunkModelId(id), id).toBe(true)
    }
    const visible = TRAE_CN_PRESET_IDS.filter((id) => !TRAE_CN_INVISIBLE_IDS.includes(id))
    for (const id of visible) {
      expect(isTraeCnJunkModelId(id), id).toBe(false)
    }
  })

  it('空串 / 普通未知名不命中（判定不误伤将来上线的新模型）', () => {
    expect(isTraeCnJunkModelId('')).toBe(false)
    expect(isTraeCnJunkModelId('glm-6')).toBe(false)
    expect(isTraeCnJunkModelId('kimi-k4')).toBe(false)
    // Work 池的 `-Official` 后缀项与 IDE 的同名旧项**不是一回事**，不许误伤。
    expect(isTraeCnJunkModelId('DeepSeek-V4-Flash-Official')).toBe(false)
    expect(isTraeCnJunkModelId('DeepSeek-V4-Pro-Official')).toBe(false)
  })
})

describe('Trae CN 目录过滤：四道网合流（真实 roster 规模）', () => {
  const entryOf = (id: string, extra: Partial<TraeCnModelEntry> = {}): TraeCnModelEntry =>
    ({ id, name: id, function: TRAE_CN_SOLO_REMOTE_FUNCTION, ...extra })

  it('**40 项并集 → 13 项**（−5 内部 −14 custom −8 invisible，实测逐项核对）', () => {
    // 内部项 5 项：4 项点名 + `computer_use_subagent`（**lite 独有**，由 remote
    // 优先规则顺带剔除）。
    const internal = [
      'summary', 'file_search_agent', 'explore_sub_agent_v2', 'browser_use_subagent',
    ]
    const remoteEntries = [
      ...TRAE_CN_PRESET_IDS.map((id) => entryOf(id, {
        usage: 'chat_completion',
        ...TRAE_CN_INVISIBLE_IDS.includes(id as never) ? { invisible: true } : {},
      })),
      ...TRAE_CN_CUSTOM_MODEL_IDS.map((id) => entryOf(id, { usage: 'custom_model' })),
      ...internal.map((id) => entryOf(id, { usage: 'chat_completion', invisible: true })),
    ]
    const liteEntries = [
      ...remoteEntries,
      // lite 独有项：内部项，且被 remote 优先规则剔除。
      entryOf('computer_use_subagent', { usage: 'chat_completion', invisible: true }),
    ]
    expect(remoteEntries).toHaveLength(39)
    expect(liteEntries).toHaveLength(40)

    const merged = mergeTraeCnDirectory([
      { function: TRAE_CN_SOLO_REMOTE_FUNCTION, entries: remoteEntries },
      { function: TRAE_CN_SOLO_LITE_FUNCTION, entries: liteEntries },
    ], true)

    expect(merged).toHaveLength(13)
    expect(merged.map((m) => m.id)).toEqual([
      'Doubao-Seed-Evolving',
      'Doubao-Seed-2.1-Pro',
      'Doubao-Seed-2.1-Turbo',
      'glm-5.3',
      'glm-5.2',
      'DeepSeek-V4-Flash-Official',
      'DeepSeek-V4-Pro-Official',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'minimax-m3',
      'qwen3.8-max',
      'qwen-3.7-plus',
    ])
    // 算术自查：40 − 5 − 14 − 8 = 13（内部项是 **5** 项，不是 4）。
    expect(40 - 5 - 14 - 8).toBe(13)
  })

  it('**过滤后仍补齐档位**（合流顺序：先过滤，后补静态元数据）', () => {
    const merged = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        entryOf('glm-5.3', { usage: 'chat_completion' }),
        entryOf('custom_model_gemini', { usage: 'custom_model' }),
      ],
    }], true)
    const applied = applyTraeCnStaticMetadata(merged)
    expect(applied.map((e) => e.id)).toEqual(['glm-5.3'])
    expect(applied[0]!.reasoningEfforts).toEqual(['light', 'high', 'extra_high'])
  })

  it('**动态目录的 13 项与静态表 11 项的差集只有两项**（kimi-k2.7-code / kimi-k2.6）', () => {
    const dynamic = mergeTraeCnDirectory([{
      function: TRAE_CN_SOLO_REMOTE_FUNCTION,
      entries: [
        ...TRAE_CN_PRESET_IDS.map((id) => entryOf(id, {
          usage: 'chat_completion',
          ...TRAE_CN_INVISIBLE_IDS.includes(id as never) ? { invisible: true } : {},
        })),
        ...TRAE_CN_CUSTOM_MODEL_IDS.map((id) => entryOf(id, { usage: 'custom_model' })),
      ],
    }], true).map((e) => e.id)
    const staticIds = TRAE_CN_FALLBACK_MODELS.map((m) => m.id)
    expect(dynamic.filter((id) => !staticIds.includes(id))).toEqual(['kimi-k2.7-code', 'kimi-k2.6'])
    // 反向：静态表里没有一项被过滤掉（11 项全是保留项）。
    expect(staticIds.filter((id) => !dynamic.includes(id))).toEqual([])
  })
})

describe('registerTraeCnLlm', () => {
  it('注册 provider 目录与适配器，settingsNs 为 llm-trae-cn', () => {
    const configurable: Array<Record<string, unknown>> = []
    const adapters: string[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: Array<Record<string, unknown>>) => { configurable.push(...entries) },
        registerAdapter: (providers: string[]) => { adapters.push(...providers) },
      },
    }
    const adapter = registerTraeCnLlm(ctx as never, {
      credentialRef: credentialRef('TRAE_CN_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    expect(configurable).toEqual([{
      provider: 'trae-cn',
      displayName: 'Trae CN',
      // 连字符在这里是**正确的**：namespace 是字符串键，与 cordis 服务名
      // （traeCnAuth）走两套命名规则。漏注册会让模型设置页在
      // refFor → deriveKeyRef(provider) 处崩溃。
      settingsNs: 'llm-trae-cn',
      settingsPath: [],
    }])
    expect(adapters).toEqual(['trae-cn'])
    // 返回值是**刚注册的那个适配器实例**：`src/index.ts` 把它转交给
    // `registerAccountHubRpc`（Account Hub 的窗口档位只能由目录持有者回答）。
    // 返回 undefined 会让 `model.list` 永远没有档位列、`model.setContextBudget` 恒拒绝。
    expect(adapter).toBeInstanceOf(TraeCnAdapter)
    expect(typeof adapter.contextTiers).toBe('function')
  })
})
