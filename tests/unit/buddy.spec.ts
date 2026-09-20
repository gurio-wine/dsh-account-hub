import { describe, expect, it } from 'vitest'
import {
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  displayNameForModel,
  isExpired,
  isRefreshable,
  parseAccountData,
  parseModelsFromConfig,
  parseTokenData,
} from '../../src/buddy.js'

const futureMs = Date.now() + 7_200_000
const pastMs = Date.now() - 60_000

/** 构造一个仅用于解析测试的未签名 JWT（payload 可自定义）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('buddy credential parsing', () => {
  it('parseTokenData accepts string fields and defaults tokenType to Bearer', () => {
    const token = parseTokenData({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: '2026-08-30T00:00:00Z',
      refreshExpiresAt: '2026-09-29T00:00:00Z',
      scope: '',
      domain: 'copilot.tencent.com',
    })
    // ISO 绝对时间被归一化为毫秒时间戳字符串（credentialExpiresAtMs 统一解析）。
    expect(token).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: String(Date.parse('2026-08-30T00:00:00Z')),
      refreshExpiresAt: String(Date.parse('2026-09-29T00:00:00Z')),
      tokenType: 'Bearer',
      scope: '',
      domain: 'copilot.tencent.com',
    })
  })

  it('parseTokenData 用 expiresIn 相对秒数换算绝对过期时间（e2e 实证格式）', () => {
    // 真实响应不含 expiresAt/refreshExpiresAt，只有 expiresIn/refreshExpiresIn。
    // JWT 的 iat=1789132433 / exp=1794316433 作为换算基准。
    const accessToken = makeJwt({ iat: 1789132433, exp: 1794316433, nickname: 'Jet' })
    const token = parseTokenData({
      accessToken,
      refreshToken: 'RT',
      expiresIn: 5184000,
      refreshExpiresIn: 7776000,
      tokenType: 'Bearer',
      scope: 'profile offline_access email',
      domain: 'copilot.tencent.com',
    })
    // 基准用 iat：1789132433000 + 5184000 * 1000
    expect(token.expiresAt).toBe(String(1789132433000 + 5184000 * 1000))
    expect(token.refreshExpiresAt).toBe(String(1789132433000 + 7776000 * 1000))
    // 与 JWT exp 一致（5184000s = 60 天）
    expect(Number(token.expiresAt)).toBe(1794316433 * 1000)
  })

  it('parseTokenData 在无 expiresIn 时保持空串，由 credentialExpiresAtMs 从 JWT exp 兜底', () => {
    const accessToken = makeJwt({ exp: 1794316433 })
    const token = parseTokenData({ accessToken, refreshToken: 'RT' })
    expect(token.expiresAt).toBe('')
    const ms = credentialExpiresAtMs({
      access_token: accessToken, refresh_token: 'RT', expires_at: token.expiresAt,
    })
    expect(ms).toBe(1794316433 * 1000)
  })

  it('buildCredential 从 JWT 回填 nickname 与 user_id（login/account 常为空）', () => {
    const accessToken = makeJwt({ sub: 'uid-from-jwt', nickname: 'Jet', preferred_username: '186' })
    const credential = buildCredential(
      parseTokenData({ accessToken, refreshToken: 'RT', expiresIn: 3600 }),
      parseAccountData({ uid: '', nickname: '', type: 'personal' }),
    )
    expect(credential.nickname).toBe('Jet')
    expect(credential.user_id).toBe('uid-from-jwt')
    // 落盘安全性：JSON 必须是单行（多行会被 YAML 当块标量破坏结构）
    expect(/[\r\n]/.test(JSON.stringify(credential))).toBe(false)
  })

  it('parseTokenData 清洗 scope 中的换行（否则破坏 YAML 中的凭据 JSON）', () => {
    const token = parseTokenData({
      accessToken: 'AT', refreshToken: 'RT', scope: 'profile\n    offline_access\n    email',
    })
    expect(token.scope).toBe('profile offline_access email')
    expect(/[\r\n]/.test(JSON.stringify(token))).toBe(false)
  })

  it('parseTokenData stringifies numeric timestamps', () => {
    const token = parseTokenData({ accessToken: 'AT', refreshToken: 'RT', expiresAt: futureMs })
    expect(token.expiresAt).toBe(String(futureMs))
  })

  it('parseTokenData tolerates null/non-object payloads', () => {
    expect(parseTokenData(null).accessToken).toBe('')
    expect(parseTokenData(undefined).tokenType).toBe('Bearer')
  })

  it('parseAccountData defaults type to personal', () => {
    const account = parseAccountData({ uid: 'u1', nickname: 'n1', enterpriseId: '' })
    expect(account).toEqual({ uid: 'u1', nickname: 'n1', enterpriseId: '', accountType: 'personal' })
  })

  it('buildCredential merges token and account', () => {
    const credential = buildCredential(
      parseTokenData({ accessToken: 'AT', refreshToken: 'RT', domain: 'copilot.tencent.com' }),
      parseAccountData({ uid: 'u1', nickname: 'n1', type: 'enterprise', enterpriseId: 'ent-1' }),
    )
    expect(credential).toMatchObject({
      access_token: 'AT',
      refresh_token: 'RT',
      domain: 'copilot.tencent.com',
      user_id: 'u1',
      nickname: 'n1',
      account_type: 'enterprise',
      enterprise_id: 'ent-1',
    })
  })
})

describe('buddy expiry helpers', () => {
  it('credentialExpiresAtMs reads millisecond timestamps', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(futureMs)
  })

  it('credentialExpiresAtMs converts second timestamps to milliseconds', () => {
    const seconds = Math.floor(futureMs / 1000)
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: String(seconds) })).toBe(seconds * 1000)
  })

  it('credentialExpiresAtMs parses ISO 8601 strings', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: '2026-08-30T00:00:00Z' }))
      .toBe(Date.parse('2026-08-30T00:00:00Z'))
  })

  it('credentialExpiresAtMs returns undefined when absent or unparseable', () => {
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT' })).toBeUndefined()
    expect(credentialExpiresAtMs({ access_token: 'AT', refresh_token: 'RT', expires_at: 'not-a-date' })).toBeUndefined()
  })

  it('isExpired is false when the expiry is unknown (aligns with Rust is_expired)', () => {
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT' })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(futureMs) })).toBe(false)
    expect(isExpired({ access_token: 'AT', refresh_token: 'RT', expires_at: String(pastMs) })).toBe(true)
  })

  it('isRefreshable requires a non-empty refresh_token', () => {
    expect(isRefreshable({ access_token: 'AT', refresh_token: 'RT' })).toBe(true)
    expect(isRefreshable({ access_token: 'AT', refresh_token: '' })).toBe(false)
  })
})

describe('buddy request headers', () => {
  it('requestHeaders sends X-Domain and the IDE User-Agent', () => {
    const headers = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
    expect(headers['User-Agent']).toBe('CodeBuddyIDE/1.106.1')
  })

  it('requestHeaders falls back to the default domain', () => {
    expect(credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT' })['X-Domain']).toBe('copilot.tencent.com')
  })

  it('requestHeaders adds enterprise headers only for enterprise accounts', () => {
    const personal = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: '' })
    expect(personal['X-Enterprise-Id']).toBeUndefined()

    const enterprise = credentialRequestHeaders({ access_token: 'AT', refresh_token: 'RT', enterprise_id: 'ent-123' })
    expect(enterprise['X-Enterprise-Id']).toBe('ent-123')
    expect(enterprise['X-Tenant-Id']).toBe('ent-123')
  })

  it('authHeaders adds the Bearer token', () => {
    const headers = credentialAuthHeaders({ access_token: 'tok', refresh_token: 'RT', domain: 'copilot.tencent.com' })
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['X-Domain']).toBe('copilot.tencent.com')
  })
})

describe('buddy model config parsing', () => {
  it('parses cli agent models from the enterprise models endpoint', () => {
    // 企业模型端点（/console/enterprises/personal/models）用 `cli` agent
    // 承载可选模型清单，且 data.models 带完整元数据（含 /v3/config 没有的 GPT 系列）。
    // ⚠️ 这里刻意保留**旧形态响应**（只有 maxInputTokens、无 contextWindow 档位对）：
    // 解析结果必须与口径变更前逐字节一致 —— 单档模型的 maxInputTokens 就是窗口。
    const models = parseModelsFromConfig({
      data: {
        agents: [
          { name: 'cli', models: ['default-model', 'gpt-5.6-sol', 'glm-5.2'] },
          { name: 'general-purpose' },
          { name: 'contentAnalyzer', models: ['lite'] },
        ],
        models: [
          { id: 'default-model', name: 'Auto', maxInputTokens: 176000 },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', maxInputTokens: 1000000 },
          { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1000000 },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'default-model', name: 'Auto', contextWindow: 176_000 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
    ])
  })

  it('prefers the remote name over the static display table', () => {
    // 服务端下发的 name 是权威来源：新模型不在静态表里，
    // 且静态表对老模型的叫法可能已过时（如 kimi-k2.6 旧名 Kimi K2.6）。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'cli', models: ['gpt-5.6-sol', 'kimi-k2.6', 'unknown-model'] }],
        models: [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
          { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
          { id: 'unknown-model' },
        ],
      },
    })
    expect(models.map((m) => m.name)).toEqual(['GPT-5.6-Sol', 'Kimi-K2.6', 'unknown-model'])
  })

  it('parses remote reasoning efforts from the enterprise endpoint', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'cli', models: ['gpt-5.6-terra'] }],
        models: [{
          id: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          reasoning: { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        }],
      },
    })
    expect(models[0]!.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(models[0]!.defaultReasoningEffort).toBe('high')
  })

  it('parses craft agent models and excludes auto', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [
          { name: 'other', models: ['should-be-ignored'] },
          { name: 'craft', models: ['auto', 'hy4-preview', 'glm-5.3'] },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'hy4-preview', name: 'Hy4 Preview' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ])
  })

  it('attaches maxInputTokens from data.models as contextWindow', () => {
    // ⚠️ 本用例走的是**回退分支**：这批 data.models 条目**不带 `contextWindow`
    // 档位对**，属单档模型，maxInputTokens 即真实服务窗口，故照收。
    // （带档位对时的口径见下面「默认档优先」那组用例。）
    // data.models 中未被 craft 引用但可对话的条目也会被补进列表（如 unknown-model）。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['auto', 'glm-5.3-flash', 'kimi-k2.6'] }],
        models: [
          { id: 'glm-5.3-flash', maxInputTokens: 1048576 },
          { id: 'kimi-k2.6', maxInputTokens: 262144 },
          { id: 'unknown-model', maxInputTokens: 8192 },
          { id: 'bad-entry', maxInputTokens: 0 },
        ],
      },
    })
    expect(models).toEqual([
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_048_576 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
      { id: 'unknown-model', name: 'unknown-model', contextWindow: 8192 },
      { id: 'bad-entry', name: 'bad-entry' },
    ])
  })

  // ── 上下文窗口取值口径：默认档（defaultLength）优先 ──
  //
  // 2026-09-20 真机取证：Buddy 系对「1M 但默认档更小」的模型成对下发
  // `contextWindow: {defaultLength, supportedLengths}`（supportedLengths 最大档
  // 恒为 1M，defaultLength 是 200K–400K 的档位）。**我方 chat 请求体不带任何档位
  // 字段 → 上游按 defaultLength 服务**，故声明值必须取默认档：照抄最大档会让宿主
  // 的压缩阈值（0.8 × 窗口）永远追不上真实窗口，长会话撞上游硬限即死。
  describe('上下文窗口取默认档（contextWindow.defaultLength）', () => {
    it('带档位对时取 defaultLength，而不是 maxInputTokens', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['glm-5.3', 'deepseek-v4.1-flash', 'minimax-m3'] }],
          models: [
            // 真机形态：最大档 1M，默认档 300K。
            { id: 'glm-5.3', maxInputTokens: 1048576, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1048576] } },
            { id: 'deepseek-v4.1-flash', maxInputTokens: 1048576, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1048576] } },
            // 默认档与最大档不同源（minimax-m3 实测 [300K, 512K]）。
            { id: 'minimax-m3', maxInputTokens: 524288, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 524288] } },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([300_000, 300_000, 300_000])
    })

    it('国际版的 200K / 400K 默认档同样生效', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['hy4-preview', 'gpt-6-astra'] }],
          models: [
            { id: 'hy4-preview', maxInputTokens: 1048576, contextWindow: { defaultLength: 200000, supportedLengths: [200000, 1048576] } },
            { id: 'gpt-6-astra', maxInputTokens: 1048576, contextWindow: { defaultLength: 400000, supportedLengths: [400000, 1048576] } },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([200_000, 400_000])
    })

    it('不带 contextWindow 字段的条目保持 maxInputTokens（单档模型无档位可选）', () => {
      // 真机：国际版 9 个 1M 模型（gpt-5.6-*、gpt-5.5、gemini-3.5-flash、
      // glm-5.3、glm-5.2、kimi-k3）都不带该字段。无字段即无档位，maxInputTokens
      // 就是服务窗口，**不能砍** —— 砍了等于谎报容量。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['gpt-5.6-sol', 'gemini-3.5-flash'] }],
          models: [
            { id: 'gpt-5.6-sol', maxInputTokens: 1048576, supportsImages: true },
            { id: 'gemini-3.5-flash', maxInputTokens: 1048576 },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([1_048_576, 1_048_576])
    })

    it('defaultLength 非法时回退 maxInputTokens（不声明非法档）', () => {
      // 0 / 负数 / 非数字 / 空对象 / 非对象 一律视为未下发档位。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['a', 'b', 'c', 'd', 'e', 'f'] }],
          models: [
            { id: 'a', maxInputTokens: 1048576, contextWindow: { defaultLength: 0 } },
            { id: 'b', maxInputTokens: 1048576, contextWindow: { defaultLength: -1 } },
            { id: 'c', maxInputTokens: 1048576, contextWindow: { defaultLength: '300000' } },
            { id: 'd', maxInputTokens: 1048576, contextWindow: {} },
            { id: 'e', maxInputTokens: 1048576, contextWindow: null },
            { id: 'f', maxInputTokens: 1048576, contextWindow: 300000 },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([1_048_576, 1_048_576, 1_048_576, 1_048_576, 1_048_576, 1_048_576])
    })

    it('defaultLength 非法且 maxInputTokens 也非法时不声明窗口', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['bad', 'worse'] }],
          models: [
            { id: 'bad', maxInputTokens: 0, contextWindow: { defaultLength: 0 } },
            { id: 'worse', maxInputTokens: Number.POSITIVE_INFINITY, contextWindow: { defaultLength: Number.NaN } },
          ],
        },
      })
      expect(models).toEqual([
        { id: 'bad', name: 'bad' },
        { id: 'worse', name: 'worse' },
      ])
    })

    it('解析 supportedLengths 之外不发明字段（不选档）', () => {
      // supportedLengths 只描述可选档位；本模块刻意不解析它 —— 选档属于出站协议
      // 变更（见 AGENTS.md 的 Buddy 章节）。这里钉死「解析结果里只有 contextWindow」。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['glm-5.3'] }],
          models: [{
            id: 'glm-5.3',
            maxInputTokens: 1048576,
            contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1048576] },
          }],
        },
      })
      expect(models[0]).toEqual({ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 300_000 })
    })
  })

  it('appends models from data.models that craft does not reference', () => {
    // 国际版的 craft 只引用 5 个抽象别名，其余可用模型只出现在 data.models 里；
    // 若只取 craft，这些模型会在选择器中消失。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['default-model'] }],
        models: [
          { id: 'default-model' },
          { id: 'o4-mini', maxInputTokens: 128000 },
          { id: 'hunyuan-image-alpha', tags: ['text-to-image'] },
          { id: 'nes-1.2' },
          { id: 'completion-1.0' },
          { id: 'codewise-jump', maxOutputTokens: 256 },
          { id: 'codewise-completions', supportsExtra: true },
          { id: 'codewise-default-model-v2', maxOutputTokens: 32000 },
          { id: 'compact-helper', maxOutputTokens: 256 },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['default-model', 'o4-mini'])
  })

  it('appends trial models from productFeaturesConfig.ModelTrialBanner', () => {
    // 国际版的 hy4-preview 既不在 craft 列表也不在 data.models，
    // 仅由试用横幅下发，但实测可正常调用，故一并加入。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['default-model'] }],
        models: [{ id: 'default-model' }],
        productFeaturesConfig: {
          ModelTrialBanner: {
            banners: [{ modelId: 'hy4-preview-f', targetModelId: 'hy4-preview', trialDays: 14 }],
          },
        },
      },
    })
    expect(models.map((m) => m.id)).toEqual(['default-model', 'hy4-preview'])
    expect(models[1]!.name).toBe('Hy4 Preview')
  })

  it('does not duplicate a trial model already present', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['hy4-preview'] }],
        models: [{ id: 'hy4-preview' }],
        productFeaturesConfig: {
          ModelTrialBanner: { banners: [{ targetModelId: 'hy4-preview' }] },
        },
      },
    })
    expect(models.map((m) => m.id)).toEqual(['hy4-preview'])
  })

  it('keeps craft models first when data.models has extra entries', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['glm-5.3', 'hy4-preview'] }],
        models: [{ id: 'aaa-extra' }, { id: 'glm-5.3' }, { id: 'hy4-preview' }],
      },
    })
    // craft 的顺序必须保留在最前，data.models 的其余条目追加在后
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'hy4-preview', 'aaa-extra'])
  })

  it('parses the capability fields the adapter declares models from', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['deepseek-v4.1-flash', 'glm-5.1'] }],
        models: [
          {
            id: 'deepseek-v4.1-flash',
            maxInputTokens: 1_000_000,
            supportsImages: true,
            reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] },
          },
          // 只有固定 effort 的模型没有 supportedEfforts → 不暴露等级选择器
          { id: 'glm-5.1', maxInputTokens: 200_000, supportsImages: true, reasoning: { effort: 'medium' } },
        ],
      },
    })
    expect(models).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        name: 'deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
      },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true },
    ])
  })

  it('preserves an explicit supportsImages=false and omits undisclosed fields', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['plain', 'bare'] }],
        models: [{ id: 'plain', supportsImages: false }, { id: 'bare' }],
      },
    })
    expect(models[0]?.supportsImages).toBe(false)
    expect(models[1]).toEqual({ id: 'bare', name: 'bare' })
  })

  it('returns an empty list for malformed payloads', () => {
    expect(parseModelsFromConfig(null)).toEqual([])
    expect(parseModelsFromConfig({})).toEqual([])
    expect(parseModelsFromConfig({ data: {} })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'craft' }] } })).toEqual([])
    expect(parseModelsFromConfig({ data: { agents: [{ name: 'nope', models: ['a'] }] } })).toEqual([])
  })

  it('displayNameForModel falls back to the raw id', () => {
    expect(displayNameForModel('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(displayNameForModel('some-unknown-model')).toBe('some-unknown-model')
  })
})
