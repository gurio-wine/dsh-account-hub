import { describe, expect, it } from 'vitest'
import { BUDDY_CN, BUDDY, productById } from '../../src/product.js'

describe('产品配置', () => {
  it('CodeBuddy 使用 ide platform、codebuddy 产品码与中国区端点', () => {
    expect(BUDDY_CN).toMatchObject({
      id: 'buddy-cn',
      platform: 'ide',
      endpoint: 'https://copilot.tencent.com',
      apiDomain: 'copilot.tencent.com',
      productCode: 'codebuddy',
      defaultCredentialRef: 'BUDDY_CN_ACCESS_TOKEN',
      appendSessionParams: false,
    })
  })

  it('WorkBuddy 使用 workbuddy-ai platform 与 workbuddy 产品码', () => {
    expect(BUDDY).toMatchObject({
      id: 'buddy',
      platform: 'workbuddy-ai',
      productCode: 'workbuddy',
      defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
      appendSessionParams: true,
    })
  })

  it('两个产品的 id 互不相同', () => {
    expect(BUDDY_CN.id).not.toBe(BUDDY.id)
  })

  it('两个产品使用不同的 endpoint（模型池随区域不同，不能共用）', () => {
    // 这是国际版改造的核心：路径与解析逻辑相同，但域名不同，
    // 不同区域后端返回不同模型池（中国版 glm/hy/deepseek，国际版 claude/gpt/gemini）。
    expect(BUDDY.endpoint).toBe('https://www.workbuddy.ai')
    expect(BUDDY.endpoint).not.toBe(BUDDY_CN.endpoint)
  })

  it('apiDomain 与 endpoint 的主机名一致', () => {
    for (const product of [BUDDY_CN, BUDDY]) {
      expect(new URL(product.endpoint).hostname).toBe(product.apiDomain)
    }
  })

  it('WorkBuddy 携带 pluginVersion 且 appendSessionParams 为 true', () => {
    // 逆向自 WorkBuddyAI 5.5.2 的 cli/product.json
    expect(BUDDY.pluginVersion).toBe('5.5.2')
    expect(BUDDY.appendSessionParams).toBe(true)
  })

  it('CodeBuddy 不需要追加会话参数', () => {
    expect(BUDDY_CN.appendSessionParams).toBe(false)
    expect(BUDDY_CN.pluginVersion).toBeUndefined()
  })

  it('两个产品的 endpoint 都是 HTTPS', () => {
    for (const product of [BUDDY_CN, BUDDY]) {
      expect(product.endpoint.startsWith('https://')).toBe(true)
    }
  })

  it('两个产品都带兜底模型目录，且条目字段完整', () => {
    // 兜底目录的用途：服务端按认证上下文下发的模型集合可能残缺，
    // 用产品自带的权威清单校正（见 BuddyAdapter.reconcileWithFallback）。
    for (const product of [BUDDY_CN, BUDDY]) {
      expect(product.fallbackModels, product.id).toBeDefined()
      expect(product.fallbackModels!.length).toBeGreaterThan(0)
      for (const model of product.fallbackModels!) {
        expect(typeof model.id).toBe('string')
        expect(model.id.length).toBeGreaterThan(0)
        expect(typeof model.name).toBe('string')
        expect(model.name.length).toBeGreaterThan(0)
        expect(model.contextWindow).toBeGreaterThan(0)
      }
    }
  })

  it('WorkBuddy 兜底目录含 IDE 实际展示的 GPT 系列', () => {
    // 这 6 个模型是 CLI token 从 /v3/config 拿不到的（实测只返回 13 个内部别名），
    // 必须由兜底目录提供。
    const ids = new Set(BUDDY.fallbackModels!.map((m) => m.id))
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  // ── 单次输出上限兜底值（2026-09-19 真机实测）──
  //
  // 该字段是**必须下发**的权威额度，不是装饰：适配器把它写进请求体 `max_tokens`
  // 并声明为 `defaultMaxTokens`。远端不可用时若兜底表也没值，上限会退回网关默认
  // 32000，长回答被静默截断（`turn/end` 报 `max-tokens`）。
  describe('兜底表 maxOutputTokens 实测值', () => {
    /** 逐 id 取兜底值；id 不在表里时返回 undefined。 */
    const maxOut = (product: { fallbackModels?: readonly { id: string; maxOutputTokens?: number }[] }, id: string) =>
      product.fallbackModels?.find((m) => m.id === id)?.maxOutputTokens

    it('Buddy CN：逐 id 实测值', () => {
      // 2026-09-21 移植上游 39c66ac：`deepseek-v4-flash`(50k) 与
      // `kimi-k2.8-preview`(64k) 已补录进本表（原先缺失 ⇒ 远端正常下发的模型
      // 被 reconcileWithFallback 丢弃）。两者按上游逐 id 抄值。
      expect(maxOut(BUDDY_CN, 'hy4-preview')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'hy3')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'hy3-x')).toBe(64_000)
      // deepseek-v4.1-flash：scoped 端点 128000、/v3/config 131072 ⇒ 取较小者。
      expect(maxOut(BUDDY_CN, 'deepseek-v4.1-flash')).toBe(128_000)
      expect(maxOut(BUDDY_CN, 'deepseek-v4-pro')).toBe(128_000)
      expect(maxOut(BUDDY_CN, 'deepseek-v4-flash')).toBe(50_000)
      expect(maxOut(BUDDY_CN, 'glm-5.3')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'glm-5.2')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'glm-5v-turbo')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'glm-5.3-flash')).toBe(32_000)
      expect(maxOut(BUDDY_CN, 'glm-5.1')).toBe(48_000)
      expect(maxOut(BUDDY_CN, 'kimi-k3-1')).toBe(32_000)
      expect(maxOut(BUDDY_CN, 'kimi-k2.8-preview')).toBe(64_000)
      expect(maxOut(BUDDY_CN, 'kimi-k2.7')).toBe(32_000)
      expect(maxOut(BUDDY_CN, 'kimi-k2.6')).toBe(32_000)
      expect(maxOut(BUDDY_CN, 'minimax-m3')).toBe(64_000)
    })

    it('Buddy（国际版）：逐 id 实测值', () => {
      expect(maxOut(BUDDY, 'default-model')).toBe(24_000)
      expect(maxOut(BUDDY, 'deep-model')).toBe(24_000)
      expect(maxOut(BUDDY, 'fast-model')).toBe(32_000)
      expect(maxOut(BUDDY, 'balanced-model')).toBe(32_000)
      expect(maxOut(BUDDY, 'primary-model')).toBe(72_000)
      expect(maxOut(BUDDY, 'gpt-5.4')).toBe(72_000)
      expect(maxOut(BUDDY, 'deepseek-v4.1-flash')).toBe(128_000)
      expect(maxOut(BUDDY, 'gpt-6-astra')).toBe(128_000)
      expect(maxOut(BUDDY, 'gpt-5.6-sol')).toBe(128_000)
      expect(maxOut(BUDDY, 'gpt-5.6-terra')).toBe(128_000)
      expect(maxOut(BUDDY, 'gpt-5.6-luna')).toBe(128_000)
      expect(maxOut(BUDDY, 'gpt-5.5')).toBe(128_000)
      // 65536 不是 64K 取整：真机就是 65536。
      expect(maxOut(BUDDY, 'gemini-3.5-flash')).toBe(65_536)
      expect(maxOut(BUDDY, 'glm-5.3')).toBe(48_000)
      expect(maxOut(BUDDY, 'glm-5.2')).toBe(48_000)
      expect(maxOut(BUDDY, 'kimi-k3')).toBe(32_000)
      // 2026-09-21 移植上游 39c66ac 补录的三条（hy4-preview / -sg / kimi-k2.8-preview）。
      expect(maxOut(BUDDY, 'hy4-preview')).toBe(64_000)
      expect(maxOut(BUDDY, 'deepseek-v4.1-flash-sg')).toBe(128_000)
      expect(maxOut(BUDDY, 'kimi-k2.8-preview')).toBe(32_000)
      expect(maxOut(BUDDY, 'kimi-k2.6')).toBe(32_000)
      // ⚠️ 刻意留空（上游也没给），不编造数值 —— 缺省即交回网关默认。
      expect(maxOut(BUDDY, 'gpt-5.3-codex')).toBeUndefined()
    })

    it('凡填了的 maxOutputTokens 都是正的安全整数（DSH 硬校验防线）', () => {
      // DSH 的 `resolveModelInfoFor` 对 `defaultMaxTokens` 有硬校验：非安全整数或
      // ≤0 会直接抛 INVALID_MODEL_MAX_TOKENS，整轮对话起不来。兜底表是手写常量，
      // 这条守住「有人手滑写成 0 / 负数 / 非整数」。
      for (const product of [BUDDY_CN, BUDDY]) {
        for (const model of product.fallbackModels!) {
          if (model.maxOutputTokens === undefined) continue
          expect(Number.isSafeInteger(model.maxOutputTokens), `${product.id}/${model.id}`).toBe(true)
          expect(model.maxOutputTokens, `${product.id}/${model.id}`).toBeGreaterThan(0)
        }
      }
    })

    it('除 gpt-5.3-codex 外，两个产品的每个条目都填了 maxOutputTokens', () => {
      // 反向防线：漏填会让该模型退回网关默认 32000 —— 那正是本次修复要消除的
      // 静默截断。已知且**刻意**的唯一例外是国际版 `gpt-5.3-codex`（上游未给值）。
      for (const product of [BUDDY_CN, BUDDY]) {
        for (const model of product.fallbackModels!) {
          if (product.id === 'buddy' && model.id === 'gpt-5.3-codex') continue
          expect(model.maxOutputTokens, `${product.id}/${model.id}`).toBeDefined()
        }
      }
    })
  })

  it('凡声明了 reasoningEfforts 的 deepseek 系模型都必须声明 defaultReasoningEffort', () => {
    // 真实缺陷回归（会话 session-03b4d1f2 "测试思考过程显示"）：WorkBuddy 的
    // deepseek-v4.1-flash 只声明了 reasoningEfforts:['high'] 而漏了默认档，
    // 导致 resolveModel() 不下发 reasoning.defaultEffort → composer 不预选档位
    // → 请求体缺 reasoning_effort → 上游对 deepseek 系按不思考应答 → UI 无思考块。
    //
    // 只对 deepseek 系设限：实测只有它们把 reasoning_effort 当开关（不带就不思考）；
    // glm/kimi 等走默认开的 thinkingFormat，缺默认档不影响思考返回。
    for (const product of [BUDDY_CN, BUDDY]) {
      for (const model of product.fallbackModels!) {
        if (!/^deepseek/i.test(model.id)) continue
        expect(model.reasoningEfforts, `${product.id}/${model.id}`).toBeDefined()
        expect(model.defaultReasoningEffort, `${product.id}/${model.id}`).toBeDefined()
        // 默认档必须在支持档之内，否则 resolveModel() 会静默丢弃该字段。
        expect(model.reasoningEfforts, `${product.id}/${model.id}`).toContain(model.defaultReasoningEffort)
      }
    }
  })

  it('WorkBuddy 与 CodeBuddy 对 deepseek-v4.1-flash 声明一致的默认思考档', () => {
    // 两个产品共用同一后端协议，deepseek 系开思考依赖 reasoning_effort。
    // 同一模型在两边的思考元数据不应分叉——任一缺失都会让该产品静默不思考。
    const find = (models: readonly { id: string }[], id: string) => models.find((m) => m.id === id) as
      { reasoningEfforts?: readonly string[]; defaultReasoningEffort?: string } | undefined
    const cb = find(BUDDY_CN.fallbackModels!, 'deepseek-v4.1-flash')
    const wb = find(BUDDY.fallbackModels!, 'deepseek-v4.1-flash')
    expect(cb?.defaultReasoningEffort).toBeDefined()
    expect(wb?.defaultReasoningEffort).toBe(cb?.defaultReasoningEffort)
    expect(wb?.reasoningEfforts).toContain(wb?.defaultReasoningEffort)
  })

  it('兜底目录的 contextWindow 是**最大档**（2026-09-21 钳制实测），不是 defaultLength', () => {
    // 09-20 的「上游按默认档（defaultLength）服务」是**推断**，已被 09-21 单变量
    // 钳制二分**推翻**：buddy-cn 的 glm-5.3 在 prompt 320,307 / 500,507 / 900,910 /
    // 1,000,970 token 全部 HTTP 200 正常服务，1.2M 才回 `code:11115`
    //（prompt is too long）⇒ defaultLength（300K）是**纯 UI 默认值、不是硬限**，
    // 真实可服务窗口 ≈ 1M = supportedLengths 最大档 = maxInputTokens。
    // 照默认档声明会让宿主 0.8 × 300K = 240K 就压缩、白丢历史。
    //
    // 口径：带档位对的条目 = min(maxInputTokens, 档位表最大档)；无档位对的条目 =
    // maxInputTokens。⚠️ 逐条钉死，任何一条被改错都等于谎报一个模型的容量。
    const cnWindow = (id: string) => BUDDY_CN.fallbackModels!.find((m) => m.id === id)?.contextWindow
    const intlWindow = (id: string) => BUDDY.fallbackModels!.find((m) => m.id === id)?.contextWindow

    // Buddy CN：带档位对（[300K, 1M]）的条目 → 1M；maxInputTokens 与档位表最大档一致。
    for (const id of ['hy4-preview', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3-1']) {
      expect(cnWindow(id), `buddy-cn/${id}`).toBe(1_000_000)
    }
    // ⚠️ minimax-m3 是**唯一**例外：官方档位表最大档是 512K（[300K, 512K]），
    // 档位表是刻意上限 ⇒ 取 512K，不是 1M、更不是默认档 300K。
    expect(cnWindow('minimax-m3')).toBe(512_000)
    // 国际版：三项远端下发过档位对（[300K/400K, 1M]）⇒ 取最大值 1M。
    expect(intlWindow('hy4-preview-f')).toBe(1_000_000)
    expect(intlWindow('deepseek-v4.1-flash')).toBe(1_000_000)
    expect(intlWindow('gpt-6-astra')).toBe(1_000_000)
  })

  it('未定性条目的窗口一律不动（不许错位，也不许砍单档模型）', () => {
    // ① 非 1M 条目：本来就没有「最大档 vs 默认档」之分，保持原值。
    const cnWindow = (id: string) => BUDDY_CN.fallbackModels!.find((m) => m.id === id)?.contextWindow
    expect(cnWindow('hy3')).toBe(192_000)
    expect(cnWindow('hy3-x')).toBe(192_000)
    expect(cnWindow('glm-5.1')).toBe(200_000)
    expect(cnWindow('glm-5v-turbo')).toBe(200_000)
    expect(cnWindow('kimi-k2.7')).toBe(256_000)
    expect(cnWindow('kimi-k2.6')).toBe(256_000)
    // ② 国际版的非 1M 条目（含抽象别名档）。
    const intlWindow = (id: string) => BUDDY.fallbackModels!.find((m) => m.id === id)?.contextWindow
    for (const [id, expected] of [
      ['default-model', 176_000], ['fast-model', 200_000], ['balanced-model', 256_000],
      ['primary-model', 272_000], ['deep-model', 176_000], ['hy3', 192_000],
      ['gpt-5.4', 272_000], ['gpt-5.3-codex', 272_000], ['kimi-k2.6', 256_000],
    ] as const) {
      expect(intlWindow(id), `buddy/${id}`).toBe(expected)
    }
  })

  it('国际版 1M 条目集合 = 无档位对的 8 项 + 带档位对的 3 项 + 补录的 3 项（集合相等钉死）', () => {
    // 三组互斥来源，合起来必须恰好等于国际版全部 1M 条目 —— 多一个（漏改的口径）
    // 或少一个（误砍的单档模型）都会在这里炸：
    //   ① **无 `contextWindow` 字段**（单档模型）8 项 → maxInputTokens 即服务窗口，
    //      保持 1M；砍它等于谎报容量；
    //   ② 远端**下发过档位对**的三项 → 最大档口径取 1M（09-20 曾按默认档写成
    //      300K/400K，09-21 钳制实测已推翻该口径）；
    //   ③ 其余非 1M 条目（gpt-5.4 272K、kimi-k2.6 256K 等）不在本条射程内。
    const noTierField = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gemini-3.5-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3']
    for (const id of noTierField) {
      expect(BUDDY.fallbackModels!.find((m) => m.id === id)?.contextWindow, `buddy/${id}`).toBe(1_000_000)
    }
    const withTierField = ['hy4-preview-f', 'deepseek-v4.1-flash', 'gpt-6-astra']
    for (const id of withTierField) {
      expect(BUDDY.fallbackModels!.find((m) => m.id === id)?.contextWindow, `buddy/${id}`).toBe(1_000_000)
    }
    // ③ 2026-09-21 移植上游 39c66ac 补录的三条。⚠️ 单列一组而不是塞进上面任一组：
    // 上游只给出「远端在正常下发」这一条证据，**没有**说明它们是否带档位对，
    // 归入 ① 或 ② 都等于替远端形态编造一个未核实的断言。三条都是 1M（上游同款）。
    const portedWithoutTierEvidence = ['hy4-preview', 'deepseek-v4.1-flash-sg', 'kimi-k2.8-preview']
    for (const id of portedWithoutTierEvidence) {
      expect(BUDDY.fallbackModels!.find((m) => m.id === id)?.contextWindow, `buddy/${id}`).toBe(1_000_000)
    }
    // 反向防线（比逐条断言更强）：集合相等，两边都不许多也不许少。
    const oneMeg = BUDDY.fallbackModels!.filter((m) => m.contextWindow === 1_000_000).map((m) => m.id).sort()
    expect(oneMeg).toEqual([...noTierField, ...withTierField, ...portedWithoutTierEvidence].sort())
  })

  it('Buddy CN 兜底表的 1M 条目集合恰好等于带档位对的 7 项 + 补录的 2 项（集合相等钉死）', () => {
    // CN 侧同样用集合相等钉死，防止回退时漏改或误砍。
    // ⚠️ minimax-m3 **不在**其中：它的官方档位表最大档是 512K（[300K, 512K]），
    // 最大档口径取 512K 而非 1M —— 档位表是**刻意上限**，不是摆设。
    const oneMeg = BUDDY_CN.fallbackModels!.filter((m) => m.contextWindow === 1_000_000).map((m) => m.id).sort()
    expect(oneMeg).toEqual([
      'deepseek-v4-pro', 'deepseek-v4.1-flash', 'glm-5.2',
      'glm-5.3', 'glm-5.3-flash', 'hy4-preview', 'kimi-k3-1',
      // 2026-09-21 移植上游 39c66ac 补录（见 CN 表头注释）：漏掉任一条，远端已在
      // 正常下发的模型就会被 reconcileWithFallback 丢弃、选择器里看不见。
      'deepseek-v4-flash', 'kimi-k2.8-preview',
    ].sort())
    // 反向也钉一次：minimax-m3 的 512K 必须原样在表里（别被「统一成 1M」顺手改掉）。
    expect(BUDDY_CN.fallbackModels!.find((m) => m.id === 'minimax-m3')?.contextWindow).toBe(512_000)
  })

  it('兜底目录不含非对话模型与实测不可用的内部别名', () => {
    const banned = ['o4-mini', 'nes-1.1', 'nes-1.2', 'completion-1.0', 'codewise-jump', 'hunyuan-image-alpha']
    for (const product of [BUDDY_CN, BUDDY]) {
      for (const id of banned) {
        expect(product.fallbackModels!.some((m) => m.id === id), `${product.id}:${id}`).toBe(false)
      }
    }
  })

  it('思考等级非空的条目带默认等级', () => {
    for (const product of [BUDDY_CN, BUDDY]) {
      for (const model of product.fallbackModels!) {
        if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0) {
          for (const effort of model.reasoningEfforts) {
            expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(effort)
          }
        }
      }
    }
  })

  it('productById 能按 id 查到配置', () => {
    expect(productById('buddy-cn')).toBe(BUDDY_CN)
    expect(productById('buddy')).toBe(BUDDY)
  })

  it('productById 对未知 id 返回 undefined', () => {
    expect(productById('codearts')).toBeUndefined()
    expect(productById('')).toBeUndefined()
  })
})
