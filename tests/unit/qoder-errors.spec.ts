import { describe, expect, it } from 'vitest'
import {
  QODER_MAX_REQUEST_BYTES,
  applyQoderQuotaVerdict,
  buildQoderByteGateFailure,
  classifyQoderError,
  createQoderErrorDeduper,
  isQoderBackoff,
  normalizeQoderCode,
  parseQoderStreamErrorPayload,
  parseQoderWrappedDetailCode,
  qoderHarnessErrorCode,
  recordsQoderCooldown,
  shouldSwitchQoderAccount,
} from '../../src/qoder-errors.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'

/**
 * Qoder 错误分类的单测。
 *
 * fixture 全部**照抄 T3 真机实测报告原文**（逐字节），不凭记忆编造。
 * 报告中省略的长值以 `...` **原样保留**，不补造内容 —— 这些值（`chatcmpl` id、
 * `request_id`）不参与任何判定，只用于 `frameId` 日志字段与去重键之外的断言。
 *
 * 被测事实的核心矛盾：**失败可以发生在 HTTP 200 上**（流内 error 帧），
 * 而 402 的语义是**被污染的**（额度耗尽与模型名错误同码）。这两条决定了
 * 绝大多数判定的形态，测试据此逐条锁死。
 */

// ── 真机 fixture（T3 报告原文） ──────────────────────────────────────────────

/**
 * 形态 A：`messages:[]` + `stream:true` → **HTTP 200 + 流内错误**。
 *
 * 错误**嵌套在 `error` 对象**里，`code` 是**字符串**。这是 `data:` 行的 JSON 载荷
 * （规范 SSE，累积器先 JSON.parse 再交给 `parseQoderStreamErrorPayload`）。
 */
const FORM_A_PAYLOAD = {
  error: {
    code: 'invalid_parameter_error',
    param: null,
    message: '<400> InternalError.Algo.InvalidParameter: Role must be in ["user", "assistant", '
      + '"system", "function", "plugin", "tool"] and the role in last message must be in '
      + '["user", "function", "tool"]',
    type: 'invalid_request_error',
  },
  id: 'chatcmpl-8241a39c-...',
  request_id: '...',
}

/**
 * 形态 B：缺 `model` + `stream:true` → **HTTP 200 + 流内错误**，逐字节原文。
 *
 * 结构：`event: error` 行 + `data:` 行 + **连续三个 LF**（数据本身以 `\n\n` 收尾，
 * 帧尾的第三个 `\n` 属下一轮空行）。`code` **平铺在根层**。
 * 与形态 A 的差别正是本模块必须同时兼容两种结构的理由。
 */
const FORM_B_FRAME = 'event: error\ndata: {"code":"invalid_model_error","message":"Unsupported model \\"\\"","request_id":"85cb66a06aa0-...","type":"invalid_model_error"}\n\n\n'

/** 从逐字节帧里取出 `data:` 行的 JSON 文本（适配器累积器的等价动作）。 */
function dataLineOf(frame: string): string {
  const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'))
  if (line === undefined) throw new Error('fixture 里没有 data: 行')
  return line.slice('data:'.length).trim()
}

/**
 * 形态 C：`messages:[]` + `stream:false` → **HTTP 400**（pre-stream，非流式）。
 *
 * 外层码是包装码 `provider_error`，**真码藏在转义过的 JSON 字符串 `details` 里**
 * （`details.error.code`），且 `details` 里又嵌了一层 `id` / `request_id`。
 * 原文照抄（含 `...` 省略号）。
 */
const FORM_C_BODY = '{"code":"provider_error","message":"Error in upstream response","request_id":"5376777cd1f1-...","type":"provider_error","details":"{\\"error\\":{\\"message\\":\\"<400> InternalError.Algo.InvalidParameter: Role must be ...\\",\\"type\\":\\"invalid_request_error\\",\\"param\\":null,\\"code\\":\\"invalid_parameter_error\\"},\\"id\\":\\"chatcmpl-f561d739-...\\",\\"request_id\\":\\"f561d739-...\\"}"}'

/** 402 错误体全文（`code` 是**数字**，文案在 `error` 字段而非 `message`）。 */
const QUOTA_BODY = '{"code":116,"error":"quota exceeded"}'

/** chat 端点 401 错误体全文：**没有 `code` 字段**。 */
const UNAUTHORIZED_BODY = '{"error":"unauthorized"}'

// ── 1. 402 + 116：候选而非结论 ───────────────────────────────────────────────

describe('Qoder 402 + code 116（额度类候选）', () => {
  it('402 + 数字 116 只标候选，动作是 fail 而不是 switch-account', () => {
    // 402 语义污染：quota=0 时**无效模型名也回 402/116**（网关先做扣费检查）。
    // 若这里直接换号，一个模型名错误会白白废掉一个账号。
    const result = classifyQoderError({
      httpStatus: 402,
      code: 116,
      message: 'quota exceeded',
      body: QUOTA_BODY,
    })

    expect(result.quotaCandidate).toBe(true)
    expect(result.quotaConfirmed).toBe(false)
    expect(result.action).toBe('fail')
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
    expect(result.status).toBe(402)
    expect(result.code).toBe(116)
    // 上游原文必须保留（它是诊断真因的唯一线索）。
    expect(result.message).toContain('quota exceeded')
  })

  it('402 + 字符串 "116" 同样判为候选（code 类型两种都收）', () => {
    const result = classifyQoderError({ httpStatus: 402, code: '116', message: 'quota exceeded' })

    expect(result.quotaCandidate).toBe(true)
    expect(result.action).toBe('fail')
  })

  it('分类结果的布尔标志位恒有值（调用方无需 ?? false）', () => {
    const result = classifyQoderError({ httpStatus: 500 })

    expect(result.quotaCandidate).toBe(false)
    expect(result.quotaConfirmed).toBe(false)
    expect(result.jobTokenExpired).toBe(false)
    expect(result.credentialInvalid).toBe(false)
  })
})

// ── 2. applyQoderQuotaVerdict：四位分支 ──────────────────────────────────────

describe('applyQoderQuotaVerdict 二次判别', () => {
  const candidate = classifyQoderError({ httpStatus: 402, code: 116, message: 'quota exceeded' })

  it('非候选（额度类之外）原样返回，不被改写', () => {
    const plain = classifyQoderError({ httpStatus: 429, message: 'too many requests' })
    const verdict = { exhausted: true }

    // 同一对象引用：非候选路径不应产生任何包装。
    expect(applyQoderQuotaVerdict(plain, verdict)).toBe(plain)
  })

  it('候选 + verdict 为 undefined（额度查不到）→ 保守不换号', () => {
    // 「查不到」≠「耗尽」。宁可报错，也不赌一个可能存在的额度。
    const result = applyQoderQuotaVerdict(candidate, undefined)

    expect(result.action).toBe('fail')
    expect(result.quotaConfirmed).toBe(false)
    expect(result.quotaCandidate).toBe(true)
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
  })

  it('候选 + exhausted:true → switch-account 且 quotaConfirmed', () => {
    // 这是**唯一**通向换号的路径：额度端点确证该账号额度耗尽。
    const result = applyQoderQuotaVerdict(candidate, { exhausted: true })

    expect(result.action).toBe('switch-account')
    expect(result.quotaConfirmed).toBe(true)
    expect(result.quotaCandidate).toBe(true)
    expect(shouldSwitchQoderAccount(result.action)).toBe(true)
    expect(result.code).toBe(116)
  })

  it('候选 + exhausted:false → fail（额度没超 ⇒ 当模型路由错直报）', () => {
    // 网关扣费检查通过却仍回 402 ⇒ 是模型名/路由问题，换号只会再撞一次。
    const result = applyQoderQuotaVerdict(candidate, { exhausted: false })

    expect(result.action).toBe('fail')
    expect(result.quotaConfirmed).toBe(false)
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
  })

  it('三种分支都保留上游原文，只追加结论', () => {
    for (const verdict of [undefined, { exhausted: true }, { exhausted: false }]) {
      const result = applyQoderQuotaVerdict(candidate, verdict)
      expect(result.message, JSON.stringify(verdict)).toContain('quota exceeded')
    }
  })
})

// ── 3. 402 但不是 116 ───────────────────────────────────────────────────────

describe('Qoder 402 的其它业务码', () => {
  it('402 + code 105 不是额度候选，直报并带原始码', () => {
    const result = classifyQoderError({ httpStatus: 402, code: 105, message: 'payment required' })

    expect(result.quotaCandidate).toBe(false)
    expect(result.quotaConfirmed).toBe(false)
    expect(result.action).toBe('fail')
    expect(result.message).toContain('105')
    expect(result.message).toContain('payment required')
  })

  it('402 无业务码不是候选（无法判定为额度耗尽）', () => {
    const result = classifyQoderError({ httpStatus: 402, message: 'payment required' })

    expect(result.quotaCandidate).toBe(false)
    expect(result.action).toBe('fail')
    expect(result.message).toContain('402')
  })
})

// ── 4. chat 端点 401 ────────────────────────────────────────────────────────

describe('Qoder chat 端点 401（无 code 字段）', () => {
  const first = classifyQoderError({
    httpStatus: 401,
    message: 'unauthorized',
    body: UNAUTHORIZED_BODY,
    source: 'chat',
  })

  it('首见 401 → jobTokenExpired（适配器先重换一次 jt 再试）', () => {
    expect(first.jobTokenExpired).toBe(true)
    expect(first.credentialInvalid).toBe(false)
    expect(first.action).toBe('fail')
    expect(first.quotaCandidate).toBe(false)
  })

  it('重换过仍是 401 → credentialInvalid，且不再声称 jt 过期', () => {
    // afterJobTokenRetry 是适配器给的「已经重换过一次」信号：还失败就只能是 PAT 废了。
    const result = classifyQoderError({
      httpStatus: 401,
      message: 'unauthorized',
      body: UNAUTHORIZED_BODY,
      afterJobTokenRetry: true,
    })

    expect(result.credentialInvalid).toBe(true)
    expect(result.jobTokenExpired).toBe(false)
    expect(result.action).toBe('fail')
  })

  it('source 省略时按 chat 端点处理', () => {
    expect(classifyQoderError({ httpStatus: 401, message: 'unauthorized' }).jobTokenExpired).toBe(true)
  })
})

// ── 5. quota 端点 401 的两种可区分形态 ──────────────────────────────────────

describe('Qoder quota 端点 401', () => {
  it('TOKEN_EXPIRE → jobTokenExpired', () => {
    const result = classifyQoderError({
      httpStatus: 401,
      source: 'quota',
      message: 'TOKEN_EXPIRE',
      body: '{"code":"TOKEN_EXPIRE"}',
    })

    expect(result.jobTokenExpired).toBe(true)
    expect(result.credentialInvalid).toBe(false)
    expect(result.action).toBe('fail')
  })

  it('token is not active → jobTokenExpired（同一语义的另一种文案）', () => {
    const result = classifyQoderError({
      httpStatus: 401,
      source: 'quota',
      message: 'token is not active',
    })

    expect(result.jobTokenExpired).toBe(true)
    expect(result.credentialInvalid).toBe(false)
  })

  it('TOKEN_INVALID → credentialInvalid（凭据类型错，重换也没用）', () => {
    const result = classifyQoderError({
      httpStatus: 401,
      source: 'quota',
      message: 'TOKEN_INVALID',
      body: '{"code":"TOKEN_INVALID"}',
    })

    expect(result.credentialInvalid).toBe(true)
    expect(result.jobTokenExpired).toBe(false)
    expect(result.action).toBe('fail')
    expect(qoderHarnessErrorCode(result)).toBe('AUTH')
  })

  it('两种都不命中 → 保守判凭据失效（额度端点的 401 无法靠重换解决）', () => {
    const result = classifyQoderError({ httpStatus: 401, source: 'quota', message: 'unauthorized' })

    expect(result.credentialInvalid).toBe(true)
    expect(result.jobTokenExpired).toBe(false)
  })

  it('文案大小写不敏感（markers 与 body 都忽略大小写）', () => {
    expect(classifyQoderError({ httpStatus: 401, source: 'quota', message: 'token_expire' }).jobTokenExpired).toBe(true)
    expect(classifyQoderError({ httpStatus: 401, source: 'quota', message: 'token_invalid' }).credentialInvalid).toBe(true)
  })
})

// ── 6. 形态 C：provider_error 包装码 + 二次解析 ─────────────────────────────

describe('Qoder 形态 C（400 provider_error）', () => {
  it('fixture 的转义是逐字节原文（details 是字符串，且内层可再解析）', () => {
    // 这条断言是 fixture 自身的守门人：若转义被写错，`details` 就不再是字符串，
    // 后续那条 wrappedCode 断言会变成「碰巧通过」的假绿。
    const parsed = JSON.parse(FORM_C_BODY) as { details: unknown; code: string }

    expect(parsed.code).toBe('provider_error')
    expect(typeof parsed.details).toBe('string')
    const inner = JSON.parse(parsed.details as string) as { error: { code: string } }
    expect(inner.error.code).toBe('invalid_parameter_error')
  })

  it('provider_error + body → wrappedCode 是真码，动作 fail', () => {
    const result = classifyQoderError({
      httpStatus: 400,
      code: 'provider_error',
      message: 'Error in upstream response',
      body: FORM_C_BODY,
      source: 'chat',
    })

    expect(result.wrappedCode).toBe('invalid_parameter_error')
    expect(result.action).toBe('fail')
    expect(result.status).toBe(400)
    expect(result.message).toContain('invalid_parameter_error')
    expect(result.message).toContain('Error in upstream response')
  })

  it('未确证的包装码不会触发换号或冷却徽章', () => {
    const result = classifyQoderError({ httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body: FORM_C_BODY })

    expect(result.quotaCandidate).toBe(false)
    expect(recordsQoderCooldown(result)).toBe(false)
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
  })

  it('body 缺失、非 JSON 或无 details 时仍然直报（不抛错、不编造真码）', () => {
    const bodies = [undefined, 'not json at all', '{}', '[1,2,3]', '"just a string"']

    for (const body of bodies) {
      const result = classifyQoderError({ httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body })
      expect(result.action, String(body)).toBe('fail')
      expect(result.wrappedCode, String(body)).toBeUndefined()
      expect(result.message, String(body)).toContain('Error in upstream response')
    }
  })

  it('details 是「转义过一层的 JSON 字符串」时解析出真码（最小样例）', () => {
    // 源码里写成 `\\"` 才能在真正的字符串里得到 `\"` —— 这正是形态 C 的编码方式。
    // 若只写 `\"`，得到的是一段非法 JSON，解析必然失败（fixture 自身的陷阱）。
    const body = '{"code":"provider_error","message":"Error in upstream response","details":"{\\"code\\":\\"x\\"}"}'
    expect((JSON.parse(body) as { details: string }).details).toBe('{"code":"x"}')

    const result = classifyQoderError({ httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body })

    expect(result.wrappedCode).toBe('x')
    expect(result.action).toBe('fail')
  })

  it('从整个响应体解析时不会把包装码当成真码', () => {
    // 直接把整个 body 交给 parseQoderWrappedDetailCode 会读到外层 .code。
    // 判定路径必须先取 details —— 这里锁死「包装码绝不冒充真码」。
    const result = classifyQoderError({ httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body: '{"code":"provider_error","message":"boom"}' })

    expect(result.wrappedCode).toBeUndefined()
  })

  it('details 是流内 error 帧原文（带 `data: ` 前缀）时也能解出真码', () => {
    // ⚠️ 真机实测（2026-09-21，`qmodel` + Raw 形态 tools）：details 的值竟是
    // **一整个 SSE 帧的原文**（`data: {"error":{…}}`，末尾还带两个换行），
    // 不是纯 JSON —— `JSON.parse` 必然抛异常。
    // 原文：details = 'data: {"error":{"code":"invalid_parameter_error",…},"id":"chatcmpl-…"}\n\n'
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Error in upstream response',
      type: 'provider_error',
      details: 'data: {"error":{"code":"invalid_parameter_error","param":null,'
        + '"message":"\'function\' is a required property, expected an object - \'tools.0\'",'
        + '"type":"invalid_request_error"},"id":"chatcmpl-0643bca2-…"}\n\n',
    })

    const result = classifyQoderError({
      httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body,
    })

    expect(result.wrappedCode).toBe('invalid_parameter_error')
    expect(result.message).toContain('invalid_parameter_error')
  })

  it('details.error 没有 code 时，从 details.error.message 里榨出上游真因', () => {
    // ⚠️ 真机实测的**第二种新形态**：不同上游后端填 details 的字段各不相同，
    // `details.error.code` 经常缺席，真因只在 `error.message` 里：
    //   kmodel：{"error":{"message":"Invalid request: unknown tool type: , currently only
    //            function and plugin are supported","type":"invalid_request_error"}}
    //   mmodel：{"type":"error","error":{"type":"bad_request_error","message":"invalid params,
    //            invalid tool type:  (2013)","http_code":"400"},"request_id":"…"}
    // 旧解析器只认 `error.code` / 根层 `code`，于是这两种都退化成
    // 「未能从 details 中二次解析出真码」—— 真因被藏进壳里（用户报障的次要成因）。
    const kmodelDetails = '{"error":{"message":"Invalid request: unknown tool type: , '
      + 'currently only function and plugin are supported","type":"invalid_request_error"}}'
    const mmodelDetails = '{"type":"error","error":{"type":"bad_request_error","message":'
      + '"invalid params, invalid tool type:  (2013)","http_code":"400"},"request_id":"06fee2f9"}'

    // 每个 fixture 断言它**自己**那句真因（两者文案不同，不能共用一条 substring）。
    const cases: ReadonlyArray<{ details: string; reason: string }> = [
      { details: kmodelDetails, reason: 'unknown tool type' },
      { details: mmodelDetails, reason: 'invalid tool type' },
    ]

    for (const testCase of cases) {
      const body = JSON.stringify({
        code: 'provider_error',
        message: 'Error in upstream response',
        type: 'provider_error',
        details: testCase.details,
      })
      const result = classifyQoderError({
        httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body,
      })

      // 没有数字/字符串业务码可给时**不编造码**（wrappedCode 保持 undefined），
      // 但真因必须透出到用户文案里。
      expect(result.wrappedCode, testCase.details).toBeUndefined()
      expect(result.message, testCase.details).toContain(testCase.reason)
      expect(result.message, testCase.details).not.toContain('未能从 details 中二次解析出真因')
    }
  })

  it('details.error.code 是业务文本（如 "1210"）时照常解出并透出文案', () => {
    // gmodel 真机原文：details.error.code = "1210"，message 是中文。
    const body = JSON.stringify({
      code: 'provider_error', message: 'Error in upstream response', type: 'provider_error',
      details: '{"error":{"code":"1210","message":"API 调用参数有误，请检查文档。"}}',
    })
    const result = classifyQoderError({
      httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body,
    })

    expect(result.wrappedCode).toBe('1210')
    expect(result.message).toContain('1210')
    expect(result.message).toContain('请检查文档')
  })

  it('流内 provider_error 帧的 details 同样能被解出（帧解析器不得丢弃它）', () => {
    // ⚠️ **用户报障的次要成因**：流内 error 帧走 `parseQoderStreamErrorPayload`，
    // 而它只读 code/message，**把 details 整个丢掉**；适配器调用分类器时也没传
    // body（`qoder-adapter.ts` 的流内分支）—— 于是流内 provider_error 的真因
    // 永远显示成「未能从 details 中二次解析出真码」。
    // 真机原文（HTTP 200 流内，`kmodel`）：
    const payload = JSON.parse(
      '{"code":"provider_error","message":"Error in upstream response",'
      + '"request_id":"4e15912aef3c-70db-8684-97c3-6a154c09","type":"provider_error",'
      + '"details":"{\\"error\\":{\\"message\\":\\"Invalid request: unknown tool type: , '
      + 'currently only function and plugin are supported\\",\\"type\\":\\"invalid_request_error\\"}}"}',
    ) as unknown

    const frame = parseQoderStreamErrorPayload(payload)
    expect(frame.code).toBe('provider_error')
    // 帧解析结果必须带上 details（新字段），适配器才能把它交给分类器做二次解析。
    expect(frame.details).toContain('unknown tool type')

    const result = classifyQoderError({
      httpStatus: 200,
      code: frame.code,
      message: frame.message,
      source: 'chat',
      ...frame.details === undefined ? {} : { body: frame.details },
    })
    expect(result.message).toContain('unknown tool type')
    expect(result.message).not.toContain('未能从 details 中二次解析出真码')
  })
})

// ── 7. parseQoderWrappedDetailCode ─────────────────────────────────────────

describe('parseQoderWrappedDetailCode', () => {
  it('字符串化 JSON：取 details.error.code', () => {
    const details = JSON.stringify({
      error: { message: 'boom', type: 'invalid_request_error', param: null, code: 'invalid_parameter_error' },
      id: 'chatcmpl-f561d739-...',
      request_id: 'f561d739-...',
    })

    expect(parseQoderWrappedDetailCode(details)).toBe('invalid_parameter_error')
  })

  it('对象形态：同样取 .error.code', () => {
    expect(parseQoderWrappedDetailCode({ error: { code: 'invalid_parameter_error' } }))
      .toBe('invalid_parameter_error')
  })

  it('没有 .error 时退回根层 .code', () => {
    expect(parseQoderWrappedDetailCode({ code: 'fallback_code' })).toBe('fallback_code')
    expect(parseQoderWrappedDetailCode('{"code":"fallback_code"}')).toBe('fallback_code')
  })

  it('数字码归一成字符串', () => {
    expect(parseQoderWrappedDetailCode({ error: { code: 116 } })).toBe('116')
    expect(parseQoderWrappedDetailCode({ code: 4006 })).toBe('4006')
  })

  it('缺字段 / 空串 / 非 JSON / null / 非对象 一律 undefined', () => {
    expect(parseQoderWrappedDetailCode({ error: { message: 'boom' } })).toBeUndefined()
    expect(parseQoderWrappedDetailCode({ error: { code: '' } })).toBeUndefined()
    expect(parseQoderWrappedDetailCode({ error: { code: '   ' } })).toBeUndefined()
    expect(parseQoderWrappedDetailCode('not json')).toBeUndefined()
    expect(parseQoderWrappedDetailCode('null')).toBeUndefined()
    expect(parseQoderWrappedDetailCode(null)).toBeUndefined()
    expect(parseQoderWrappedDetailCode(undefined)).toBeUndefined()
    expect(parseQoderWrappedDetailCode(42)).toBeUndefined()
    expect(parseQoderWrappedDetailCode(['x'])).toBeUndefined()
  })
})

// ── 8. parseQoderStreamErrorPayload ────────────────────────────────────────

describe('parseQoderStreamErrorPayload', () => {
  it('形态 A（嵌套 error）：读到字符串码与 message', () => {
    const frame = parseQoderStreamErrorPayload(FORM_A_PAYLOAD)

    expect(frame.code).toBe('invalid_parameter_error')
    expect(frame.message).toContain('InternalError.Algo.InvalidParameter')
    expect(frame.message).toContain('Role must be in')
    // frameId 取 id（优先于 request_id）。
    expect(frame.frameId).toBe('chatcmpl-8241a39c-...')
  })

  it('形态 A 也可以直接喂原始 JSON 字符串解析后的对象（等价路径）', () => {
    const reparsed = JSON.parse(JSON.stringify(FORM_A_PAYLOAD)) as unknown
    expect(parseQoderStreamErrorPayload(reparsed).code).toBe('invalid_parameter_error')
  })

  it('形态 B（平铺）：逐字节帧的 data 部分', () => {
    // fixture 自身的守门人：event 行 + data 行 + 三个 LF。
    expect(FORM_B_FRAME.startsWith('event: error\n')).toBe(true)
    expect(FORM_B_FRAME.endsWith('\n\n\n')).toBe(true)

    const frame = parseQoderStreamErrorPayload(JSON.parse(dataLineOf(FORM_B_FRAME)) as unknown)

    expect(frame.code).toBe('invalid_model_error')
    expect(frame.message).toBe('Unsupported model ""')
    // 形态 B 没有 id，只有 request_id。
    expect(frame.frameId).toBe('85cb66a06aa0-...')
  })

  it('字符串载荷整串当 message，无 code', () => {
    const frame = parseQoderStreamErrorPayload('<500> upstream exploded')

    expect(frame.message).toBe('<500> upstream exploded')
    expect(frame.code).toBeUndefined()
    expect(frame.frameId).toBeUndefined()
  })

  it('401 的 {"error":"unauthorized"}：字符串 error 走文案回退链', () => {
    const frame = parseQoderStreamErrorPayload(JSON.parse(UNAUTHORIZED_BODY) as unknown)

    expect(frame.message).toBe('unauthorized')
    expect(frame.code).toBeUndefined()
  })

  it('null / 数字 / 数组 / 空对象 → unknown error，不发明假码', () => {
    for (const payload of [null, 42, ['x'], {}, '']) {
      const frame = parseQoderStreamErrorPayload(payload)
      expect(frame.message, JSON.stringify(payload)).toBe('unknown error')
      expect(frame.code, JSON.stringify(payload)).toBeUndefined()
      expect(frame.frameId, JSON.stringify(payload)).toBeUndefined()
    }
  })

  it('message 缺失时依次回退 msg → error', () => {
    expect(parseQoderStreamErrorPayload({ code: 'x', msg: 'from msg' }).message).toBe('from msg')
    expect(parseQoderStreamErrorPayload({ code: 'x', error: 'from error' }).message).toBe('from error')
    expect(parseQoderStreamErrorPayload({ code: 'x' }).message).toBe('unknown error')
  })

  it('形态 A 的 error 对象没带文案时，回退到根层 message/msg', () => {
    // 容忍式读取：上游若把文案放在外层而只在内层留 code，不该让整条错误失去文案。
    expect(parseQoderStreamErrorPayload({ error: { code: 'x' }, message: 'root message' }).message).toBe('root message')
    expect(parseQoderStreamErrorPayload({ error: { code: 'x' }, msg: 'root msg' }).message).toBe('root msg')
    // 内层文案优先于根层文案。
    expect(parseQoderStreamErrorPayload({ error: { code: 'x', message: 'inner' }, message: 'root' }).message).toBe('inner')
    // 但 code 仍取内层。
    expect(parseQoderStreamErrorPayload({ error: { code: 'inner_code' }, message: 'root' }).code).toBe('inner_code')
  })

  it('frameId 只接受非空字符串（数字或空串时不带）', () => {
    expect(parseQoderStreamErrorPayload({ message: 'boom', id: '' }).frameId).toBeUndefined()
    expect(parseQoderStreamErrorPayload({ message: 'boom', id: 123 }).frameId).toBeUndefined()
    expect(parseQoderStreamErrorPayload({ message: 'boom', id: 'chatcmpl-1' }).frameId).toBe('chatcmpl-1')
  })

  it('流的错误帧经分类器得到 fail（HTTP 200 也不许当成功）', () => {
    const frame = parseQoderStreamErrorPayload(FORM_A_PAYLOAD)
    const result = classifyQoderError({ httpStatus: 200, code: frame.code, message: frame.message })

    expect(result.action).toBe('fail')
    expect(result.message).toContain('invalid_parameter_error')
  })
})

// ── 9. 去重器 ──────────────────────────────────────────────────────────────

describe('createQoderErrorDeduper', () => {
  it('同一错误发两遍（两个不同 chatcmpl id）第二次返回 false', () => {
    // T3 实测：同一错误可能发 2 遍，只取首帧。
    const deduper = createQoderErrorDeduper()
    const first = parseQoderStreamErrorPayload(FORM_A_PAYLOAD)
    const second = parseQoderStreamErrorPayload({
      ...FORM_A_PAYLOAD,
      id: 'chatcmpl-8241a39c-DIFFERENT',
    })

    expect(first.message).toBe(second.message)
    expect(first.frameId).not.toBe(second.frameId)
    expect(deduper(first)).toBe(true)
    expect(deduper(second)).toBe(false)
  })

  it('同一错误重复喂多次只放行首帧', () => {
    const deduper = createQoderErrorDeduper()
    const frame = { code: 'invalid_model_error', message: 'Unsupported model ""' }

    expect(deduper(frame)).toBe(true)
    expect(deduper(frame)).toBe(false)
    expect(deduper({ ...frame })).toBe(false)
  })

  it('不同 code 或不同 message 都算新错误', () => {
    const deduper = createQoderErrorDeduper()

    expect(deduper({ code: 'a', message: 'same' })).toBe(true)
    expect(deduper({ code: 'b', message: 'same' })).toBe(true)
    expect(deduper({ code: 'a', message: 'other' })).toBe(true)
  })

  it('无 code 时只用 message 作键', () => {
    const deduper = createQoderErrorDeduper()

    expect(deduper({ message: 'unauthorized' })).toBe(true)
    expect(deduper({ message: 'unauthorized' })).toBe(false)
    expect(deduper({ message: 'forbidden' })).toBe(true)
  })

  it('数字码与字符串码视为同一错误', () => {
    const deduper = createQoderErrorDeduper()

    expect(deduper({ code: 116, message: 'quota exceeded' })).toBe(true)
    expect(deduper({ code: '116', message: 'quota exceeded' })).toBe(false)
  })

  it('分隔符避免拼接歧义（"1"+"16x" 与 "11"+"6x" 不是同一个键）', () => {
    const deduper = createQoderErrorDeduper()

    expect(deduper({ code: '1', message: '16x' })).toBe(true)
    expect(deduper({ code: '11', message: '6x' })).toBe(true)
  })

  it('两个去重器互不共享状态（一次流式请求一个实例）', () => {
    const a = createQoderErrorDeduper()
    const b = createQoderErrorDeduper()
    const frame = { code: 'invalid_model_error', message: 'Unsupported model ""' }

    expect(a(frame)).toBe(true)
    expect(a(frame)).toBe(false)
    // 换一次请求：同样的错误必须能再次上报，否则真因会被静默吞掉。
    expect(b(frame)).toBe(true)
  })
})

// ── 10. 未知业务码 ──────────────────────────────────────────────────────────

describe('Qoder 未知业务码', () => {
  it('未知码一律 fail，且文案带上原始码与原文', () => {
    const result = classifyQoderError({
      httpStatus: 200,
      code: 'some_new_error',
      message: 'the upstream said something new',
    })

    expect(result.action).toBe('fail')
    expect(result.message).toContain('some_new_error')
    expect(result.message).toContain('the upstream said something new')
    expect(result.code).toBe('some_new_error')
    expect(result.quotaCandidate).toBe(false)
    expect(recordsQoderCooldown(result)).toBe(false)
  })

  it('已知流内码也走 fail，但文案给出可读解释', () => {
    const parameter = classifyQoderError({
      httpStatus: 200,
      code: 'invalid_parameter_error',
      message: '<400> InternalError.Algo.InvalidParameter: Role must be in [...]',
    })
    const model = classifyQoderError({
      httpStatus: 200,
      code: 'invalid_model_error',
      message: 'Unsupported model ""',
    })

    for (const result of [parameter, model]) {
      expect(result.action).toBe('fail')
      // 绝不转成优雅结束：DSH 会报「Stream ended without finish_reason」，真因丢失。
      expect(result.message).toContain('上游原文')
    }
    expect(parameter.message).toContain('invalid_parameter_error')
    expect(model.message).toContain('invalid_model_error')
  })

  it('流内未知码在 HTTP 省略时同样直报（状态码未知 ≠ 成功）', () => {
    const result = classifyQoderError({ code: 'brand_new_code', message: 'boom' })

    expect(result.action).toBe('fail')
    expect(result.message).toContain('brand_new_code')
  })

  it('空白字符串码按「没有码」处理，走 HTTP 兜底', () => {
    const result = classifyQoderError({ httpStatus: 429, code: '   ', message: 'too many requests' })

    expect(result.action).toBe('backoff')
  })
})

// ── 11. HTTP 兜底 ───────────────────────────────────────────────────────────

describe('Qoder 无业务码时的 HTTP 兜底', () => {
  it('429 / 408 / 5xx → backoff（不换号）', () => {
    for (const status of [429, 408, 500, 502, 503, 504]) {
      const result = classifyQoderError({ httpStatus: status, message: 'gateway hiccup' })
      expect(result.action, String(status)).toBe('backoff')
      expect(isQoderBackoff(result.action)).toBe(true)
      expect(shouldSwitchQoderAccount(result.action)).toBe(false)
      expect(recordsQoderCooldown(result)).toBe(false)
    }
  })

  it('400 → fail', () => {
    const result = classifyQoderError({ httpStatus: 400, message: 'bad request' })

    expect(result.action).toBe('fail')
    expect(result.message).toContain('400')
  })

  it('403 → credentialInvalid（凭据被拒绝）', () => {
    const result = classifyQoderError({ httpStatus: 403, message: 'Forbidden' })

    expect(result.credentialInvalid).toBe(true)
    expect(result.action).toBe('fail')
    expect(shouldSwitchQoderAccount(result.action)).toBe(false)
    expect(qoderHarnessErrorCode(result)).toBe('AUTH')
  })

  it('无状态码也无码 → fail', () => {
    const result = classifyQoderError({})

    expect(result.action).toBe('fail')
    expect(result.message).toContain('未知')
  })
})

// ── 12. qoderHarnessErrorCode ──────────────────────────────────────────────

describe('qoderHarnessErrorCode', () => {
  it('switch-account / backoff → RATE_LIMIT（必须在 DSH 的可重试码表里）', () => {
    const confirmed = applyQoderQuotaVerdict(
      classifyQoderError({ httpStatus: 402, code: 116, message: 'quota exceeded' }),
      { exhausted: true },
    )
    const backoff = classifyQoderError({ httpStatus: 429, message: 'too many requests' })

    expect(qoderHarnessErrorCode(confirmed)).toBe('RATE_LIMIT')
    expect(qoderHarnessErrorCode(backoff)).toBe('RATE_LIMIT')
  })

  it('credentialInvalid → AUTH', () => {
    const invalid = classifyQoderError({ httpStatus: 401, message: 'unauthorized', afterJobTokenRetry: true })
    const quotaInvalid = classifyQoderError({ httpStatus: 401, source: 'quota', message: 'TOKEN_INVALID' })

    expect(qoderHarnessErrorCode(invalid)).toBe('AUTH')
    expect(qoderHarnessErrorCode(quotaInvalid)).toBe('AUTH')
  })

  it('未确证的 402 → INVALID_REQUEST（不可重试，不换号）', () => {
    const candidate = classifyQoderError({ httpStatus: 402, code: 116, message: 'quota exceeded' })

    expect(qoderHarnessErrorCode(candidate)).toBe('INVALID_REQUEST')
  })

  it('jt 过期（未重换）不映射 AUTH —— 它是适配器可自愈的状态', () => {
    const expired = classifyQoderError({ httpStatus: 401, message: 'unauthorized' })

    expect(expired.jobTokenExpired).toBe(true)
    expect(qoderHarnessErrorCode(expired)).toBe('INVALID_REQUEST')
  })

  it('上下文超限文案 → CONTEXT_WINDOW_EXCEEDED（用 harness 的权威判定）', () => {
    const result = classifyQoderError({
      httpStatus: 400,
      code: 'invalid_parameter_error',
      message: "This model's maximum context length is 128000 tokens",
    })

    expect(result.action).toBe('fail')
    expect(qoderHarnessErrorCode(result)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('未知码（非超限文案）→ INVALID_REQUEST', () => {
    const result = classifyQoderError({ httpStatus: 200, code: 'some_new_error', message: 'boom' })

    expect(qoderHarnessErrorCode(result)).toBe('INVALID_REQUEST')
  })
})

// ── 13. recordsQoderCooldown ───────────────────────────────────────────────

describe('recordsQoderCooldown', () => {
  it('仅确证的额度耗尽为真', () => {
    const candidate = classifyQoderError({ httpStatus: 402, code: 116, message: 'quota exceeded' })

    expect(recordsQoderCooldown(candidate)).toBe(false)
    expect(recordsQoderCooldown(applyQoderQuotaVerdict(candidate, { exhausted: true }))).toBe(true)
    expect(recordsQoderCooldown(applyQoderQuotaVerdict(candidate, { exhausted: false }))).toBe(false)
    expect(recordsQoderCooldown(applyQoderQuotaVerdict(candidate, undefined))).toBe(false)
  })

  it('退避类与未知码都不记徽章（记了等于下一次选号偷偷换号）', () => {
    const cases = [
      classifyQoderError({ httpStatus: 429, message: 'too many requests' }),
      classifyQoderError({ httpStatus: 503, message: 'unavailable' }),
      classifyQoderError({ httpStatus: 200, code: 'some_new_error', message: 'boom' }),
      classifyQoderError({ httpStatus: 401, message: 'unauthorized' }),
      classifyQoderError({ httpStatus: 403, message: 'Forbidden' }),
      classifyQoderError({ httpStatus: 400, code: 'provider_error', message: 'Error in upstream response', body: FORM_C_BODY }),
    ]

    for (const classification of cases) {
      expect(recordsQoderCooldown(classification), classification.message).toBe(false)
    }
  })
})

// ── 14. normalizeQoderCode ─────────────────────────────────────────────────

describe('normalizeQoderCode', () => {
  it('数字原样返回', () => {
    expect(normalizeQoderCode(116)).toBe(116)
    expect(normalizeQoderCode(0)).toBe(0)
    expect(normalizeQoderCode(-1)).toBe(-1)
  })

  it('整数字符串（含前后空白）归一成数字', () => {
    expect(normalizeQoderCode('116')).toBe(116)
    expect(normalizeQoderCode(' 116 ')).toBe(116)
    expect(normalizeQoderCode('\t116\n')).toBe(116)
  })

  it('非整串整数的字符串一律 undefined', () => {
    // parseInt 会静默截取，把诊断文本误判成业务码。
    expect(normalizeQoderCode('code=116')).toBeUndefined()
    expect(normalizeQoderCode('116abc')).toBeUndefined()
    expect(normalizeQoderCode('11.6')).toBeUndefined()
    expect(normalizeQoderCode('invalid_parameter_error')).toBeUndefined()
    expect(normalizeQoderCode('provider_error')).toBeUndefined()
  })

  it('空串 / 空白串 / undefined / 非有限数 → undefined', () => {
    expect(normalizeQoderCode('')).toBeUndefined()
    expect(normalizeQoderCode('   ')).toBeUndefined()
    expect(normalizeQoderCode(undefined)).toBeUndefined()
    expect(normalizeQoderCode(Number.NaN)).toBeUndefined()
    expect(normalizeQoderCode(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

// ── 15. 动作判定真值表 ──────────────────────────────────────────────────────

describe('shouldSwitchQoderAccount / isQoderBackoff 真值表', () => {
  it('三个动作的两种判定互斥且完备', () => {
    const table = [
      { action: 'switch-account' as const, switchAccount: true, backoff: false },
      { action: 'backoff' as const, switchAccount: false, backoff: true },
      { action: 'fail' as const, switchAccount: false, backoff: false },
    ]

    for (const row of table) {
      expect(shouldSwitchQoderAccount(row.action), row.action).toBe(row.switchAccount)
      expect(isQoderBackoff(row.action), row.action).toBe(row.backoff)
    }
  })

  it('没有任何分类结果会同时要求换号与退避', () => {
    const inputs = [
      { httpStatus: 402, code: 116, message: 'quota exceeded' },
      { httpStatus: 401, message: 'unauthorized' },
      { httpStatus: 403, message: 'Forbidden' },
      { httpStatus: 429, message: 'too many requests' },
      { httpStatus: 200, code: 'some_new_error', message: 'boom' },
    ]

    for (const input of inputs) {
      const { action } = classifyQoderError(input)
      expect(
        shouldSwitchQoderAccount(action) && isQoderBackoff(action),
        JSON.stringify(input),
      ).toBe(false)
    }
  })
})

// ── 16. 本地字节闸（256 KiB 墙） ────────────────────────────────────────────

/**
 * 字节墙是**确定性**的（2026-09-21 字节级矩阵取证：262 144 B → 200 四次复测、
 * 262 145 B → 500 三次复测，零抖动），故闸门的判据必须来自**本地算术**
 * 而不是上游文案 —— 这一组用例正是钉死「不确定的东西不许猜、确定的东西不靠猜」。
 */
describe('本地字节闸（QODER_MAX_REQUEST_BYTES）', () => {
  it('阈值就是 240 KiB（245 760 B），对实测墙 262 144 B 留 ~8.5% 余量', () => {
    expect(QODER_MAX_REQUEST_BYTES).toBe(240 * 1024)
    expect(QODER_MAX_REQUEST_BYTES).toBeLessThan(262_144)
    // 余量是「传输开销 + 中间层差异」的容错空间，不是随手取的整数：
    // 贴着墙设阈值会让任何一点协议开销把「本地放行」的请求正好送进墙里。
    expect(262_144 - QODER_MAX_REQUEST_BYTES).toBe(16_384)
  })

  it('闸门结果：动作恒为 fail（确定性失败，重发无用，也不换号）', () => {
    const gated = buildQoderByteGateFailure(300_000)

    expect(gated.action).toBe('fail')
    expect(shouldSwitchQoderAccount(gated.action)).toBe(false)
    expect(isQoderBackoff(gated.action)).toBe(false)
    // 不是额度问题：不该记冷却徽章，也不该被当成额度候选。
    expect(recordsQoderCooldown(gated)).toBe(false)
    expect(gated.quotaCandidate).toBe(false)
    expect(gated.credentialInvalid).toBe(false)
  })

  it('闸门结果映射为 CONTEXT_WINDOW_EXCEEDED（DSH 唯一的自动压缩补救入口）', () => {
    const gated = buildQoderByteGateFailure(300_000)

    expect(gated.localByteGate).toBe(true)
    expect(qoderHarnessErrorCode(gated)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('映射走显式标志位，**不靠文案关键词**（文案是中文，正则命不中）', () => {
    // 反证：闸门文案里没有任何 harness 英文关键词，若靠 isContextWindowExceededError
    // 判，这条映射会**静默失效**（压缩补救整条路走不通）。
    const gated = buildQoderByteGateFailure(300_000)
    expect(gated.message).not.toMatch(/context (length|window)/i)
    // 标志位为真时映射无需文案配合 —— 这就是它与「未知码不猜」的区别。
    expect(qoderHarnessErrorCode({ ...gated, message: '完全无关的一句话' }))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('文案含关键信息：字节数、256 KiB 墙、宿主将压缩重试、压缩不可用则新建对话', () => {
    const gated = buildQoderByteGateFailure(262_400)

    expect(gated.message).toContain('262400')
    expect(gated.message).toContain('256 KiB')
    expect(gated.message).toContain('262 144')
    expect(gated.message).toContain('压缩')
    expect(gated.message).toContain('新建对话')
  })

  it('文案带 provider 名，两个 region 各自可分辨（共用同一道闸）', () => {
    expect(buildQoderByteGateFailure(300_000, QODER).message).toContain('qoder 的请求体')
    expect(buildQoderByteGateFailure(300_000, QODER_CN).message).toContain('qoder-cn 的请求体')
  })

  it('其余标志位恒为 false（与既有布尔位同约定：调用方无需 ?? false）', () => {
    const gated = buildQoderByteGateFailure(245_760)

    expect(gated.jobTokenExpired).toBe(false)
    expect(gated.quotaConfirmed).toBe(false)
    expect(gated.wrappedCode).toBeUndefined()
  })

  it('上游 500 仍然按 backoff 处理 —— 闸门不改变既有的 5xx 语义', () => {
    // 闸门是「本地提前拦」，不是「把 500 重新定义」。国际版的 500 语义
    // （瞬时故障，退避重试）一个字节都没动：真正撞墙的请求根本发不出去，
    // 能收到 500 的请求说明它没到墙。
    const upstream = classifyQoderError({ httpStatus: 500, message: 'internal server error' })

    expect(upstream.action).toBe('backoff')
    expect(upstream.localByteGate).toBe(false)
    expect(qoderHarnessErrorCode(upstream)).toBe('RATE_LIMIT')
  })
})
