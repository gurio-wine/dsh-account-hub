import { describe, expect, it } from 'vitest'
import {
  ALL_LOBSTERAI_PRODUCTS,
  LOBSTERAI,
  LOBSTERAI_API_BASE,
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_FALLBACK_CLIENT_VERSION,
  LOBSTERAI_PORTAL_BASE,
  LOBSTERAI_USER_AGENT,
  lobsteraiProductById,
} from '../../src/lobsterai-product.js'

describe('LobsterAI 产品配置', () => {
  it('基础字段与实测值一致', () => {
    expect(LOBSTERAI).toMatchObject({
      id: 'lobsterai',
      displayName: 'LobsterAI',
      defaultCredentialRef: 'LOBSTERAI_ACCESS_TOKEN',
    })
  })

  it('API 基址来自 sigin.py:10 的实测值', () => {
    expect(LOBSTERAI.apiBase).toBe('https://lobsterai-server.youdao.com')
    expect(LOBSTERAI_API_BASE).toBe(LOBSTERAI.apiBase)
  })

  it('portal 基址来自实测（与 API 同 IP、同 CNAME）', () => {
    // 两个域名解析到同一 IP 与同一 CNAME 目标，但仍是两个独立字段：
    // Go 侧本就是两个 env，且不排除未来门户与 API 分离部署。
    expect(LOBSTERAI.portalBase).toBe('https://lobsterai.youdao.com')
    expect(LOBSTERAI_PORTAL_BASE).toBe(LOBSTERAI.portalBase)
  })

  it('portal 与 api 是**不同**的域名（这是与腾讯系最大的配置差异）', () => {
    // CodeBuddy / WorkBuddy 的登录与 API 共用一个 endpoint，
    // LobsterAI 则是同域不同路径的两个 host。
    expect(new URL(LOBSTERAI.portalBase).hostname).not.toBe(new URL(LOBSTERAI.apiBase).hostname)
  })

  it('两个基址都是 HTTPS 且无尾斜杠', () => {
    for (const base of [LOBSTERAI.portalBase, LOBSTERAI.apiBase]) {
      expect(base.startsWith('https://')).toBe(true)
      expect(base.endsWith('/')).toBe(false)
    }
  })

  it('版本号接口是第三方域名（与业务域名不同服务）', () => {
    expect(LOBSTERAI.clientVersionApi)
      .toBe('https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update')
    expect(new URL(LOBSTERAI.clientVersionApi).hostname).toBe('api-overmind.youdao.com')
  })

  it('兜底版本号是日期式形态（非语义化版本）', () => {
    // 实测真值形如 2026.9.4；Go 侧硬编码的 0.1.0 是假值。
    expect(LOBSTERAI.fallbackClientVersion).toBe(LOBSTERAI_FALLBACK_CLIENT_VERSION)
    expect(LOBSTERAI.fallbackClientVersion).toMatch(/^\d+(\.\d+)+$/)
    expect(LOBSTERAI.fallbackClientVersion).not.toBe('0.1.0')
  })

  it('UA 与 Capabilities 与实测实现一致', () => {
    expect(LOBSTERAI.userAgent).toBe(LOBSTERAI_USER_AGENT)
    expect(LOBSTERAI.userAgent).toBe('LobsterAI/0.1.0')
    expect(LOBSTERAI.clientCapabilities).toBe(LOBSTERAI_CLIENT_CAPABILITIES)
    // 能力值本身的语义断言见下方「LobsterAI 客户端能力声明」。
  })

  it('**不**含 CodeBuddy 系专有字段（避免被误当成 BuddyProduct 使用）', () => {
    for (const banned of ['apiDomain', 'productCode', 'attributionName', 'platform',
      'appendSessionParams', 'pluginVersion', 'userAgentByModelFamily', 'cliVersion', 'endpoint']) {
      expect(LOBSTERAI, banned).not.toHaveProperty(banned)
    }
  })
})

describe('LobsterAI 兜底模型目录', () => {
  it('含 27 个模型（对齐 2026-09-19 真机 /api/models/available）', () => {
    expect(LOBSTERAI.fallbackModels).toHaveLength(27)
  })

  it('每个条目的 id / name 均完整有效', () => {
    for (const model of LOBSTERAI.fallbackModels) {
      expect(typeof model.id).toBe('string')
      expect(model.id.length).toBeGreaterThan(0)
      expect(typeof model.name).toBe('string')
      expect(model.name.length).toBeGreaterThan(0)
    }
  })

  it('模型 id 唯一（重复会让选择器出现两个同名条目）', () => {
    const ids = LOBSTERAI.fallbackModels.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('展示名取自真机 modelName（不是裸 id）', () => {
    // 旧表把 name 也填成 id，选择器里全是 `qwen3.7-max` 这种裸 id。
    const byId = new Map(LOBSTERAI.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('deepseek-flash')).toBe('DeepSeek-V4.1-Flash')
    expect(byId.get('qwen3.7-max')).toBe('Qwen3.7-Max')
    expect(byId.get('kimi-k2.6')).toBe('Kimi-K2.6')
  })

  it('覆盖真机新增的 9 项', () => {
    const ids = new Set(LOBSTERAI.fallbackModels.map((m) => m.id))
    for (const id of ['deepseek-flash', 'glm-5.3-flashx', 'glm-5.3-flash', 'glm-5.3',
      'qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-omni-flash',
      'doubao-seed-2-1-pro-260915', 'deepseek-v4-flash-vision-exp']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('不含真机已下架的 doubao-seed-2-1-pro-260628', () => {
    // 真机改名成 …-260915；留着它会让用户选到一个路由不到的条目。
    const ids = new Set(LOBSTERAI.fallbackModels.map((m) => m.id))
    expect(ids.has('doubao-seed-2-1-pro-260628')).toBe(false)
  })

  it('顺序照抄真机返回顺序（保持与上游对比时的可比性）', () => {
    expect(LOBSTERAI.fallbackModels[0]!.id).toBe('deepseek-flash')
    expect(LOBSTERAI.fallbackModels[1]!.id).toBe('deepseek-v4-pro')
    expect(LOBSTERAI.fallbackModels[26]!.id).toBe('doubao-seed-2-0-code-preview-260215')
  })

  it('contextWindow 用真机权威值，缺失的条目不编造', () => {
    // 真机 14 项 1000000、2 项 262144、2 项 256000，其余 9 项为 null（不声明）。
    const declared = LOBSTERAI.fallbackModels.filter((m) => m.contextWindow !== undefined)
    expect(declared).toHaveLength(18)
    for (const model of declared) {
      expect(model.contextWindow, model.id).toBeGreaterThan(0)
    }
    expect(LOBSTERAI.fallbackModels.find((m) => m.id === 'glm-5.2')?.contextWindow).toBe(1_000_000)
    expect(LOBSTERAI.fallbackModels.find((m) => m.id === 'kimi-k2.6')?.contextWindow).toBeUndefined()
  })

  it('8 项声明思考档位，存 wire 值 openclawLevel（off 保留、max→xhigh）', () => {
    const withEfforts = LOBSTERAI.fallbackModels.filter((m) => m.reasoningEfforts !== undefined)
    expect(withEfforts).toHaveLength(8)
    for (const model of withEfforts) {
      // wire 值：`level:'max'` 映射成 `openclawLevel:'xhigh'`（上游实测定案）；
      // `off` 保留在列（Capabilities 头已含 thinking-level-control-v1，off 可用）。
      expect(model.reasoningEfforts, model.id).toEqual(['off', 'high', 'xhigh'])
      // 默认档必须落在可用档位内（否则 DSH 会 materialize 一个非法档位）。
      expect(model.reasoningEfforts, model.id).toContain(model.defaultReasoningEffort)
    }
  })

  it('其余 19 项不声明思考档位（真机无 thinkingConfig）', () => {
    const ids = LOBSTERAI.fallbackModels.filter((m) => m.reasoningEfforts === undefined).map((m) => m.id)
    expect(ids).toHaveLength(19)
    expect(ids).toContain('qwen3.8-max')
    expect(ids).toContain('kimi-k2.6')
  })
})

/**
 * 客户端能力声明必须与「可选思考档位」配套。
 *
 * 实测（2026-09-17，真实凭据，上游 commit 9669ee4）：`reasoning_effort: "off"`
 * 只在 `X-LobsterAI-Client-Capabilities` **包含 `thinking-level-control-v1`** 时
 * 返回 200；只发 `kimi-k3-agentic-v1`（Go 桥接层的硬编码值）时服务端直接
 * HTTP 500。即「关掉思考」这条协议需要客户端先声明支持它。这里锁定的是**两个
 * 能力必须同时在**，且以逗号分隔下发（服务端按逗号拆分）。
 */
describe('LobsterAI 客户端能力声明', () => {
  it('包含 thinking-level-control-v1（否则 off 档会 500）', () => {
    expect(LOBSTERAI.clientCapabilities).toContain('thinking-level-control-v1')
  })

  it('保留 kimi-k3-agentic-v1（kimi-k3 上线的前提）', () => {
    // 实测：不带该能力时模型列表少一个 kimi-k3（25 vs 26）。
    expect(LOBSTERAI.clientCapabilities).toContain('kimi-k3-agentic-v1')
  })

  it('以逗号分隔的多值形态下发（服务端按逗号拆分）', () => {
    expect(LOBSTERAI.clientCapabilities).toBe(
      'kimi-k3-agentic-v1,thinking-level-control-v1',
    )
  })
})

describe('lobsteraiProductById', () => {
  it('能按 id 查到配置', () => {
    expect(lobsteraiProductById('lobsterai')).toBe(LOBSTERAI)
  })

  it('对未知 id 返回 undefined（含 CodeBuddy 系的 id）', () => {
    // 两个 productById 刻意分开：返回类型不同，合并会让调用方不得不做类型收窄。
    expect(lobsteraiProductById('buddy-cn')).toBeUndefined()
    expect(lobsteraiProductById('buddy')).toBeUndefined()
    expect(lobsteraiProductById('codearts')).toBeUndefined()
    expect(lobsteraiProductById('')).toBeUndefined()
  })

  it('ALL_LOBSTERAI_PRODUCTS 含且仅含 LobsterAI', () => {
    expect(ALL_LOBSTERAI_PRODUCTS).toEqual([LOBSTERAI])
  })
})
