import { describe, expect, it } from 'vitest'
import {
  LOBSTERAI_CONTEXT_OVERFLOW_HINT,
  LOBSTERAI_HARD_CREDIT_MARKERS,
  LOBSTERAI_SESSION_DEAD_MARKERS,
  classifyLobsteraiError,
  isLobsteraiContextWindowError,
  isLobsteraiTerminalError,
  lobsteraiHarnessErrorCode,
  recordsLobsteraiRateLimit,
  shouldRotateLobsteraiAccount,
} from '../../src/lobsterai-errors.js'

describe('LobsterAI 错误分类', () => {
  it('HTTP 402 直接判为余额不足', () => {
    expect(classifyLobsteraiError(402, '')).toBe('hard-credit')
  })

  it('body 含英文余额不足关键词时判为 hard-credit（不区分大小写）', () => {
    expect(classifyLobsteraiError(400, 'Insufficient Credit')).toBe('hard-credit')
    expect(classifyLobsteraiError(200, 'QUOTA EXCEEDED')).toBe('hard-credit')
    expect(classifyLobsteraiError(400, 'free credits used')).toBe('hard-credit')
  })

  it('body 含中文余额不足关键词时判为 hard-credit', () => {
    // LobsterAI 是网易有道系产品，同一后端在不同场景返回中文或英文文案，
    // 任一漏匹配都会让「余额耗尽」被误判成可重试错误而反复重试。
    for (const text of ['积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分', '积分耗尽']) {
      expect(classifyLobsteraiError(400, `请求失败：${text}`), text).toBe('hard-credit')
    }
  })

  it('body 关键词优先于状态码（上游用 400 + 中文文案表达余额耗尽）', () => {
    // 若先按状态码判，400 会落到 client（不换号），于是反复重试一个
    // 永远不会成功的账号 —— 这是本判定顺序存在的全部理由。
    expect(classifyLobsteraiError(400, '你的积分不足')).toBe('hard-credit')
  })

  it('存在空白字符的英文关键词仍可命中（词间无换行但大小写混杂）', () => {
    expect(classifyLobsteraiError(400, 'Error: Not Enough Credit')).toBe('hard-credit')
  })

  it('会话终止标记 40100 / 40101 判为 session-dead', () => {
    expect(classifyLobsteraiError(401, '{"code":40100}')).toBe('session-dead')
    expect(classifyLobsteraiError(401, '{"code":40101}')).toBe('session-dead')
    expect(classifyLobsteraiError(400, 'token rejected')).toBe('session-dead')
    expect(classifyLobsteraiError(400, 'refresh token was rejected')).toBe('session-dead')
  })

  it('会话终止优先于 429 / 404（已死的会话换号也没意义）', () => {
    expect(classifyLobsteraiError(429, 'code 40101')).toBe('session-dead')
    expect(classifyLobsteraiError(404, 'token rejected')).toBe('session-dead')
  })

  it('余额不足优先于会话终止（两者同时出现时以余额为准）', () => {
    expect(classifyLobsteraiError(402, '40101')).toBe('hard-credit')
  })

  it('429 判为 soft-rate', () => {
    expect(classifyLobsteraiError(429, 'too many requests')).toBe('soft-rate')
  })

  it('404 判为 not-found', () => {
    expect(classifyLobsteraiError(404, 'not found')).toBe('not-found')
  })

  it('5xx 判为 server', () => {
    expect(classifyLobsteraiError(500, '')).toBe('server')
    expect(classifyLobsteraiError(503, 'unavailable')).toBe('server')
  })

  it('其他 4xx 判为 client', () => {
    expect(classifyLobsteraiError(400, 'bad request')).toBe('client')
    expect(classifyLobsteraiError(403, 'forbidden body')).toBe('client')
  })

  it('成功响应判为 none', () => {
    expect(classifyLobsteraiError(200, '{}')).toBe('none')
    expect(classifyLobsteraiError(204, '')).toBe('none')
  })

  it('空 body 不抛异常', () => {
    expect(() => classifyLobsteraiError(429, '')).not.toThrow()
  })
})

describe('上下文超限识别（context-window）', () => {
  /**
   * 这些是**真机可能的 OpenAI 兼容形态**：LobsterAI 的 chat 端点是标准
   * OpenAI 兼容端点，它的错误体沿用 OpenAI 的 `{"error":{...}}` 信封。
   */
  const HITTING_BODIES = [
    // 结构化 code —— 最典型、也最稳的判据。
    '{"error":{"message":"This model\'s maximum context length is 1000000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
    // 仅 message 陈述（无 code），走 `maximum context length` 正则。
    '{"error":{"message":"This model\'s maximum context length is 128000 tokens."}}',
    // 纯结构化 code（无 message）。
    '{"code":"context_length_exceeded"}',
    // `context window exceeded` 形态。
    '{"message":"context window exceeded"}',
    // `too long for this model` 完整句式。
    '{"error":{"message":"prompt is too long for this model"}}',
  ]

  it('命中文案 → context-window（覆盖 4 类正则形态）', () => {
    for (const body of HITTING_BODIES) {
      expect(classifyLobsteraiError(400, body), body).toBe('context-window')
    }
  })

  it('大小写不敏感（正则带 /i）', () => {
    expect(classifyLobsteraiError(400, '{"message":"CONTEXT LENGTH EXCEEDED"}')).toBe('context-window')
    expect(classifyLobsteraiError(400, '{"message":"Context Window Exceeded"}')).toBe('context-window')
    expect(classifyLobsteraiError(400, '{"message":"PROMPT IS TOO LONG FOR THIS MODEL"}')).toBe('context-window')
  })

  it('子串位置无关（前缀 / 中缀 / 后缀都能命中；判据不是整串相等）', () => {
    expect(classifyLobsteraiError(400, 'error: context_length_exceeded')).toBe('context-window')
    expect(classifyLobsteraiError(400, '{"msg":"oops"} context_length_exceeded tail')).toBe('context-window')
    expect(classifyLobsteraiError(400, 'context_length_exceeded')).toBe('context-window')
  })

  it('5xx 也能命中（超限不必然走 400 —— 按状态码兜底会得到不可补救的 SERVER）', () => {
    expect(classifyLobsteraiError(500, '{"error":{"code":"context_length_exceeded"}}')).toBe('context-window')
    expect(classifyLobsteraiError(503, 'prompt is too long for this model')).toBe('context-window')
  })

  it('**不命中**时原分类逐条不变（这是「只增不减」的识别）', () => {
    // 每一条都是既有的分类结果，加了超限判据后必须一字不变。
    expect(classifyLobsteraiError(402, '')).toBe('hard-credit')
    expect(classifyLobsteraiError(400, '积分不足')).toBe('hard-credit')
    expect(classifyLobsteraiError(401, '{"code":40100}')).toBe('session-dead')
    expect(classifyLobsteraiError(429, 'too many requests')).toBe('soft-rate')
    expect(classifyLobsteraiError(404, 'not found')).toBe('not-found')
    expect(classifyLobsteraiError(503, 'unavailable')).toBe('server')
    expect(classifyLobsteraiError(400, 'bad request')).toBe('client')
    expect(classifyLobsteraiError(200, '{}')).toBe('none')
  })

  it('常见「像超限但不是」的措辞一律不误命中', () => {
    // 误命中的代价是把一个普通请求错误变成「压缩上下文」——那会真实改写用户
    // 会话历史（trae-cn-work 的注释记着同型风险），故反向也钉死。
    // ⚠️ 每条都要写出**它本来的**分类：`quota exceeded` 本来就属 hard-credit
    // （hard 表里的既有词），超限判据不得把它抢走 —— 这正是「判定顺序」的意义。
    const cases: Array<[string, string]> = [
      ['{"msg":"max_tokens is too large"}', 'client'],
      ['{"msg":"input is too large"}', 'client'],
      ['{"msg":"maximum tokens exceeded"}', 'client'],
      ['{"msg":"parameter max_length exceeded"}', 'client'],
      ['{"msg":"service unavailable, try again later"}', 'client'],
      // 既有 hard-credit 词：不能被超限判据改写。
      ['{"msg":"quota exceeded"}', 'hard-credit'],
      ['{"msg":"credit exhausted"}', 'hard-credit'],
      // 既有 session-dead 标记同理。
      ['{"msg":"refresh token was rejected"}', 'session-dead'],
    ]
    for (const [body, expected] of cases) {
      expect(classifyLobsteraiError(400, body), body).toBe(expected)
    }
    // 限流类走状态码判定，也不受影响。
    expect(classifyLobsteraiError(429, '{"msg":"rate limit exceeded"}')).toBe('soft-rate')
  })

  /**
   * ⚠️ **已知缺口的回归锚点**：harness 的判定函数只认英文，中文超限文案命不中，
   * 因此中文表述的超限错误**仍会落回 `client`**（即本缺陷在中文下依然存在）。
   *
   * 这条测试**不是在肯定这个行为**，而是把缺口钉在测试里：将来若补了中文判据
   * （翻案条件见 `isLobsteraiContextWindowError` 的注释），它会失败，
   * 提醒改的人一并更新那段注释与文档 —— 而不是让缺口悄悄消失或悄悄扩大。
   */
  it('⚠️ 已知缺口：中文超限文案命不中，落回 client', () => {
    expect(classifyLobsteraiError(400, '{"code":400,"message":"上下文超出上限"}')).toBe('client')
    expect(classifyLobsteraiError(400, '{"code":400,"message":"请求内容过长"}')).toBe('client')
  })

  it('isLobsteraiContextWindowError 是纯判定，空串安全', () => {
    expect(isLobsteraiContextWindowError('')).toBe(false)
    expect(isLobsteraiContextWindowError('context_length_exceeded')).toBe(true)
    expect(() => isLobsteraiContextWindowError('')).not.toThrow()
  })
})

describe('harness 错误码映射（lobsteraiHarnessErrorCode）', () => {
  it('context-window → CONTEXT_WINDOW_EXCEEDED（宿主唯一的自动压缩入口）', () => {
    // 无论上游用哪个状态码表达超限，都必须映射成这一个码。
    for (const status of [400, 413, 422, 500, 503]) {
      expect(lobsteraiHarnessErrorCode('context-window', status), String(status))
        .toBe('CONTEXT_WINDOW_EXCEEDED')
    }
  })

  it('**优先于**状态码兜底（错误码不能被 400/5xx 抢走）', () => {
    // 这是本缺陷的核心：不这样排，长会话撞窗口后会拿到不可补救的死码。
    expect(lobsteraiHarnessErrorCode('context-window', 400)).not.toBe('INVALID_REQUEST')
    expect(lobsteraiHarnessErrorCode('context-window', 500)).not.toBe('SERVER')
  })

  it('hard-credit → QUOTA_EXCEEDED（既成字面量，不是 harness 的 QUOTA 常量）', () => {
    // ⚠️ 刻意不是 `QUOTA_EXCEEDED_CODE`（其值为 'QUOTA'）：这是用户可见的
    // 既成行为字面量，换成常量会**改变错误码本身**。
    expect(lobsteraiHarnessErrorCode('hard-credit', 402)).toBe('QUOTA_EXCEEDED')
    expect(lobsteraiHarnessErrorCode('hard-credit', 400)).toBe('QUOTA_EXCEEDED')
  })

  it('其余按 HTTP 状态码兜底（与原 httpErrorCode 逐字节一致）', () => {
    expect(lobsteraiHarnessErrorCode('client', 401)).toBe('AUTH')
    expect(lobsteraiHarnessErrorCode('client', 403)).toBe('AUTH')
    expect(lobsteraiHarnessErrorCode('session-dead', 401)).toBe('AUTH')
    expect(lobsteraiHarnessErrorCode('soft-rate', 429)).toBe('RATE_LIMIT')
    expect(lobsteraiHarnessErrorCode('client', 400)).toBe('INVALID_REQUEST')
    expect(lobsteraiHarnessErrorCode('server', 500)).toBe('SERVER')
    expect(lobsteraiHarnessErrorCode('server', 503)).toBe('SERVER')
    expect(lobsteraiHarnessErrorCode('not-found', 404)).toBe('HTTP_404')
    expect(lobsteraiHarnessErrorCode('client', 422)).toBe('HTTP_422')
    expect(lobsteraiHarnessErrorCode('none', 200)).toBe('HTTP_200')
  })
})

describe('错误分类的派生谓词', () => {
  it('**所有**非成功类别都可换号（对齐 handler.go:218-243 每个分支都 continue）', () => {
    // 曾经只对 hard-credit / soft-rate 换号，并错误地声称 Go 对 client 类
    // 也不换号 —— 实际 NoteError 之后紧跟的就是 continue。
    expect(shouldRotateLobsteraiAccount('hard-credit')).toBe(true)
    expect(shouldRotateLobsteraiAccount('soft-rate')).toBe(true)
    expect(shouldRotateLobsteraiAccount('not-found')).toBe(true)
    expect(shouldRotateLobsteraiAccount('server')).toBe(true)
    expect(shouldRotateLobsteraiAccount('client')).toBe(true)
    expect(shouldRotateLobsteraiAccount('session-dead')).toBe(true)
    // context-window 是唯一的例外（见下方专门用例）。
    expect(shouldRotateLobsteraiAccount('context-window')).toBe(false)
  })

  it('成功不换号', () => {
    expect(shouldRotateLobsteraiAccount('none')).toBe(false)
  })

  it('只有 session-dead 属终态', () => {
    // 终态判定比 Go 版精确：Go 只判「响应里有没有 accessToken」，
    // 会把网络抖动也当成终态而停止续期。
    expect(isLobsteraiTerminalError('session-dead')).toBe(true)
    for (const kind of ['none', 'hard-credit', 'soft-rate', 'not-found', 'server', 'client', 'context-window'] as const) {
      expect(isLobsteraiTerminalError(kind), kind).toBe(false)
    }
  })

  it('只有 Go 里真正 Cooldown 的三类记限流徽章', () => {
    expect(recordsLobsteraiRateLimit('hard-credit')).toBe(true)
    expect(recordsLobsteraiRateLimit('soft-rate')).toBe(true)
    expect(recordsLobsteraiRateLimit('not-found')).toBe(true)
    // session-dead 走 Disable、default 走 NoteError，都不写冷却时间。
    expect(recordsLobsteraiRateLimit('session-dead')).toBe(false)
    expect(recordsLobsteraiRateLimit('server')).toBe(false)
    expect(recordsLobsteraiRateLimit('client')).toBe(false)
  })

  it('上下文超限**不换号**（换号解决不了「请求太长」）', () => {
    // 这不是「保守起见不换」，而是「换了必然同样失败」：超限是请求本身的属性。
    // 换 N 个账号会打出 N 个必然失败的请求，并把真因埋进「所有账号均不可用」。
    expect(shouldRotateLobsteraiAccount('context-window')).toBe(false)
  })

  it('上下文超限**不留**限流徽章（它与模型额度无关）', () => {
    // 徽章的效果是让下一次选号跳过该账号 —— 超限记上去等于误导用户
    // 去等一个永远不会改变结果的重置时刻。
    expect(recordsLobsteraiRateLimit('context-window')).toBe(false)
  })
})

describe('关键词表完整性', () => {
  it('中英双通道覆盖（中文关键词不含 ASCII 大写，英文全为小写）', () => {
    const chinese = LOBSTERAI_HARD_CREDIT_MARKERS.filter((m) => /[\u4e00-\u9fff]/.test(m))
    const english = LOBSTERAI_HARD_CREDIT_MARKERS.filter((m) => !/[\u4e00-\u9fff]/.test(m))
    expect(chinese.length).toBeGreaterThan(0)
    expect(english.length).toBeGreaterThan(0)
    for (const marker of english) {
      expect(marker, marker).toBe(marker.toLowerCase())
    }
  })

  it('会话终止标记含两个业务码', () => {
    expect(LOBSTERAI_SESSION_DEAD_MARKERS).toContain('40100')
    expect(LOBSTERAI_SESSION_DEAD_MARKERS).toContain('40101')
  })
})

describe('上下文超限的用户可见文案', () => {
  it('提示同时含「压缩后重试」与「无需新建会话」两个要点', () => {
    // 这是用户拿到超限错误后真正需要知道的两件事：它会被自动处理、
    // 以及不要因此丢掉会话历史。缺任一条，用户的行为都会是错的
    // （反复重试 / 新建会话）。
    expect(LOBSTERAI_CONTEXT_OVERFLOW_HINT).toContain('压缩')
    expect(LOBSTERAI_CONTEXT_OVERFLOW_HINT).toContain('无需手动新建会话')
  })
})
