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
    const accessToken = makeJwt({ iat: 1789132433, exp: 1794316433, nickname: 'Hub' })
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
    const accessToken = makeJwt({ sub: 'uid-from-jwt', nickname: 'Hub', preferred_username: '186' })
    const credential = buildCredential(
      parseTokenData({ accessToken, refreshToken: 'RT', expiresIn: 3600 }),
      parseAccountData({ uid: '', nickname: '', type: 'personal' }),
    )
    expect(credential.nickname).toBe('Hub')
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

  // ── 上下文窗口取值口径：最大档 ──
  //
  // ⚠️ 2026-09-21 钳制二分实测**推翻**了 09-20 的「上游按默认档服务」推断：
  // buddy-cn 的 glm-5.3 在 prompt 320,307 / 500,507 / 900,910 / 1,000,970 token
  // **全部 HTTP 200 正常服务**，1.2M token 才回 HTTP 400 `code:11115`
  //（`prompt is too long`）⇒ `contextWindow.defaultLength`(300K) 是**纯 UI 默认值、
  // 不是硬限**；真实可服务窗口 ≈ 1M，等于 supportedLengths 最大档 = maxInputTokens。
  // 官方客户端取证同样成立：档位选择器**不发任何出站字段**，只驱动它自己的压缩触发
  // 点 —— 最大档在上游有真实对应窗口。
  //
  // 故声明值取**最大档**：按默认档声明会让宿主 0.8 × 300K = 240K 就压缩、白丢历史，
  // 与本仓批判过的 trae-cn `prompt_max_tokens=168K` 完全同类。
  //
  // 口径（a = maxInputTokens，b = supportedLengths 的最大正整数）：
  //   ① 两者都有 → min(a, b)（档位表是刻意上限，它更小时听它的）
  //   ② 只有其一 → 取那个
  //   ③ 都无 → 回退 defaultLength（正整数）；再无不声明
  describe('上下文窗口取最大档（min(maxInputTokens, supportedLengths 最大档)）', () => {
    it('双信号都存在时取 min —— 档位表更小时听档位表的', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['glm-5.3', 'minimax-m3', 'small-max'] }],
          models: [
            // 真机形态：maxInputTokens 与档位表最大档都是 1M（glm-5.3 实测服务到 1M）。
            { id: 'glm-5.3', maxInputTokens: 1048576, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1048576] } },
            // 档位表更小 ⇒ 听档位表的（真机 [300K, 512K]），不按 maxInputTokens 虚报。
            { id: 'minimax-m3', maxInputTokens: 1048576, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 524288] } },
            // 反向：maxInputTokens 更小时取它（不因为档位表更大就跟着抬）。
            { id: 'small-max', maxInputTokens: 200000, contextWindow: { defaultLength: 100000, supportedLengths: [100000, 524288] } },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([1_048_576, 524_288, 200_000])
    })

    it('只有 maxInputTokens 时取它（单档模型的真实窗口）', () => {
      // 真机：国际版 8 个 1M 模型（gpt-5.6-*、gpt-5.5、gemini-3.5-flash、
      // glm-5.3、glm-5.2、kimi-k3）都不带 `contextWindow` 字段。无档位表即单档，
      // maxInputTokens 就是服务窗口，**不能砍** —— 砍了等于谎报容量。
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

    it('只有 supportedLengths 时取它的最大正整数（逐项剔除非法值）', () => {
      // 档位表在、maxInputTokens 缺失或非法时，档位表最大档是唯一信号；
      // 表内非正整数项（0 / 负数 / 字符串 / NaN）逐个剔除，取剩下的最大值。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['only-lengths', 'dirty-lengths', 'zero-max'] }],
          models: [
            { id: 'only-lengths', contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] } },
            { id: 'dirty-lengths', contextWindow: { supportedLengths: [200000, 0, -1, 'x', Number.NaN, 800000] } },
            { id: 'zero-max', maxInputTokens: 0, contextWindow: { supportedLengths: [300000, 1000000] } },
          ],
        },
      })
      expect(models.map((m) => m.contextWindow)).toEqual([1_000_000, 800_000, 1_000_000])
    })

    it('两者都无时回退 defaultLength（最后手段，不是首选）', () => {
      // defaultLength 只在**没有任何「最大档」信号**时兜底：它已实测不是硬限
      //（320K–1.0M 全部正常服务），拿它当首选就是怂恿过早压缩。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['only-default', 'bad-everything'] }],
          models: [
            { id: 'only-default', contextWindow: { defaultLength: 300000 } },
            { id: 'bad-everything', contextWindow: { defaultLength: -1, supportedLengths: [] } },
          ],
        },
      })
      expect(models).toEqual([
        { id: 'only-default', name: 'only-default', contextWindow: 300_000 },
        { id: 'bad-everything', name: 'bad-everything' },
      ])
    })

    it('三个信号全非法时不声明窗口', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['bad', 'worse', 'worst'] }],
          models: [
            { id: 'bad', maxInputTokens: 0, contextWindow: { defaultLength: 0, supportedLengths: [0] } },
            { id: 'worse', maxInputTokens: Number.POSITIVE_INFINITY, contextWindow: { defaultLength: Number.NaN } },
            { id: 'worst', contextWindow: { supportedLengths: null } },
          ],
        },
      })
      expect(models).toEqual([
        { id: 'bad', name: 'bad' },
        { id: 'worse', name: 'worse' },
        { id: 'worst', name: 'worst' },
      ])
    })

    /**
     * ⚠️ **本用例于 2026-09-21 被用户需求推翻，原文保留在下方说明里**。
     *
     * 推翻前它锁死的是「`supportedLengths` 只用来取最大值，**不存整档列表**」，
     * 理由是「选档属于出站协议变更」。用户随后明确要求把 Trae CN 已有的
     * 「上下文窗口档位选择」推广到**所有**供应商 —— 而档位选择的前提正是
     * **保留完整的档位列表**。于是本节改为钉死新的契约：
     *
     * 1. `contextWindow` 仍是**最大档**（口径一字未改，见上面的取值链）；
     * 2. **新增** `contextTiers` 携带全部档位（升序去重）；
     * 3. 出站请求体**一个字段都不动**（红线，见 `buddy-adapter.spec.ts` 的逐字节用例）。
     *
     * 第 3 条是这次推翻之所以安全的全部理由：`contextTiers` 是**纯声明值**的
     * 数据来源，不进出站请求体 —— 与 `contextWindow` 本身完全同一性质。
     */
    it('supportedLengths 的**整张档位表**记进 contextTiers（`contextWindow` 仍是最大档）', () => {
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
      expect(models[0]).toEqual({
        id: 'glm-5.3',
        name: 'GLM-5.3',
        // 生效默认档 = 最大档（口径未变）。
        contextWindow: 1_048_576,
        // 新增：整张档位表（升序去重），供 Account Hub 渲染档位单选。
        contextTiers: [300_000, 1_048_576],
      })
    })

    it('档位表**排序去重**、非法项逐项剔除（上游的数组顺序不可信）', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['m'] }],
          models: [{
            id: 'm',
            maxInputTokens: 1048576,
            // 倒序 + 重复项 + 0 / 负数 / 字符串 / NaN 混入。
            contextWindow: { supportedLengths: [1048576, 300000, 300000, 0, -1, 'x', Number.NaN, 524288] },
          }],
        },
      })
      expect(models[0]?.contextTiers).toEqual([300_000, 524_288, 1_048_576])
    })

    it('**没有档位表**的单档模型不产出 contextTiers（宁缺毋编）', () => {
      // 国际版 8 个「1M 且无 contextWindow 字段」的模型就是这一形态：
      // 它们只有一个窗口，没有档位可选，UI 因此不该渲染档位列。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['gpt-5.6-sol'] }],
          models: [{ id: 'gpt-5.6-sol', maxInputTokens: 1048576 }],
        },
      })
      expect(models[0]).toEqual({ id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', contextWindow: 1_048_576 })
      expect(models[0]).not.toHaveProperty('contextTiers')
    })

    it('**只有一个档位**的档位表不产出 contextTiers（单元素列表没有可选项）', () => {
      // 「宁缺毋编」的边界：一个只含单个档位的列表在 UI 上等价于「无档位」，
      // 带出去只会让 Host 多算一轮、客户端多判一次。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['solo'] }],
          models: [{ id: 'solo', contextWindow: { supportedLengths: [524288] } }],
        },
      })
      expect(models[0]?.contextWindow).toBe(524_288)
      expect(models[0]).not.toHaveProperty('contextTiers')
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

  // ── 单次输出上限（maxOutputTokens）──
  //
  // 用户报障：长回答在 32000 token 处被截断，`turn/end` 为 `{kind:'max-tokens'}`。
  // 根因是适配器**从未下发 max_tokens**，上限完全由网关默认值决定（实测网关对
  // auto / glm-4.6 等模型正是 32000）；而远端早已下发权威的 maxOutputTokens。
  describe('单次输出上限解析', () => {
    it('远端 maxOutputTokens 被收进目录项', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['deepseek-v4.1-flash'] }],
          models: [{ id: 'deepseek-v4.1-flash', maxOutputTokens: 128_000 }],
        },
      })
      expect(models[0]!.maxOutputTokens).toBe(128_000)
    })

    it('非法值一律视为未声明（0 / 负数 / NaN / 字符串 / Infinity）', () => {
      // 与上下文窗口同一口径：只保留正的**有限**数。DSH 对 defaultMaxTokens 有
      // 硬校验（非安全整数或 ≤0 直接抛 INVALID_MODEL_MAX_TOKENS，整轮起不来），
      // 故远端作为外部输入必须逐项过滤。
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['zero', 'neg', 'nan', 'str', 'inf'] }],
          models: [
            { id: 'zero', maxOutputTokens: 0 },
            { id: 'neg', maxOutputTokens: -5 },
            { id: 'nan', maxOutputTokens: Number.NaN },
            { id: 'str', maxOutputTokens: '32000' },
            { id: 'inf', maxOutputTokens: Number.POSITIVE_INFINITY },
          ],
        },
      })
      for (const model of models) {
        expect(model.maxOutputTokens, model.id).toBeUndefined()
        expect(model).not.toHaveProperty('maxOutputTokens')
      }
    })

    it('远端未下发该字段时不声明（不猜默认值）', () => {
      const models = parseModelsFromConfig({
        data: {
          agents: [{ name: 'craft', models: ['bare'] }],
          models: [{ id: 'bare' }],
        },
      })
      expect(models[0]).not.toHaveProperty('maxOutputTokens')
    })
  })

  // ── `default` 内部别名过滤 ──
  //
  // 企业端点实测会下发**两个**自动选择占位别名：`auto` 与 `default`。二者都不是
  // 真实可路由模型（选中后服务端无法解析），必须与 `auto` 同样过滤掉。
  it('excludes the `default` alias alongside `auto`', () => {
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'cli', models: ['auto', 'default', 'glm-5.3'] }],
        models: [{ id: 'auto' }, { id: 'default' }, { id: 'glm-5.3' }],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['glm-5.3'])
  })

  it('excludes the `default` alias coming from the trial banner', () => {
    // 试用横幅是第二条 push 路径（不经 `push` 闭包），必须同样过滤。
    const models = parseModelsFromConfig({
      data: {
        agents: [{ name: 'craft', models: ['glm-5.3'] }],
        models: [{ id: 'glm-5.3' }],
        productFeaturesConfig: {
          ModelTrialBanner: { banners: [{ targetModelId: 'default' }, { targetModelId: 'hy4-preview' }] },
        },
      },
    })
    expect(models.map((m) => m.id)).toEqual(['glm-5.3', 'hy4-preview'])
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
