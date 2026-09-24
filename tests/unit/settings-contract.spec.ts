import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {
  Config,
  apply,
  detectSettingsContract,
  makeSettingsAddressResolver,
  name,
  resolveSettingsEntryId,
} from '../../src/index.js'
import { BUDDY, BUDDY_CN } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'

/**
 * settings 契约的路由（0.1.6 ↔ 0.1.7 双路兼容）。
 *
 * ## 这两条路为什么必须各测一遍
 *
 * DSH 0.1.7 删除了 `settings.register(ns, schema) → owner scope` 整套 seam，
 * namespace 语义改为「**profile entry id 的 Config 投影**」。三个症状完全不同的
 * 运行形态都会让 `typeof settings.register !== 'function'` 成立，但处置**相反**：
 *
 * | 形态 | settings 服务 | `register` | 正确处置 |
 * |---|---|---|---|
 * | 0.1.6 `legacy` | 在 | 有 | 逐个注册 7 个 namespace |
 * | 0.1.7 `projection` | 在 | **没有** | 什么都不注册（改由 `Config` 投影） |
 * | headless `absent` | 不在 | — | 只提示一次，不抛错 |
 *
 * 早期实现把后两者混成一句「settings 服务不可用」，于是 0.1.7 上那句假警报把
 * 排查方向整个引偏 —— 服务好端端在，只是方法没了。故这里对**三种形态分别**钉死
 * 日志措辞与副作用。
 *
 * ## 地址两半必须同源
 *
 * 除 namespace 从哪来之外，探测结果还决定每个 provider 目录项的
 * `settingsNs`/`settingsPath`。两者配错一半（新 namespace + 老空 path）**不报错**，
 * 只让模型设置页读到 undefined 的 profile（配置项凭空消失），故这里也把成对地址
 * 逐 provider 钉死。
 */

/** 收集 logger 输出的最小替身（三种形态都靠它断言措辞）。 */
interface LogSink {
  warns: string[]
  infos: string[]
  errors: string[]
}

/**
 * 建一个真实 `Context`（`apply()` 需要它），按运行形态注入 settings 替身。
 *
 * `settings` 三种入参分别对应上表的三行：
 * - 省略 ⇒ `absent`（`ctx.get('settings')` 返回 undefined）；
 * - `{ register }` ⇒ `legacy`；
 * - `{ configure, describe }`（**无 register**）⇒ `projection`。
 */
function makeContext(
  settings: Record<string, unknown> | undefined,
  options: { describeResult?: Array<{ ns: string }> } = {},
): {
  ctx: Context
  llm: { configurableProviders: Array<Record<string, unknown>> }
  logs: LogSink
} {
  const ctx = new Context()
  const logs: LogSink = { warns: [], infos: [], errors: [] }
  const configurableProviders: Array<Record<string, unknown>> = []
  ctx.provide('credentials', {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
  } as never)
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: (entries: Array<Record<string, unknown>>) => {
      configurableProviders.push(...entries)
      return { replace: () => {} }
    },
    registerAdapter: () => ({ replace: () => {} }),
  } as never)
  if (settings !== undefined) ctx.provide('settings', settings as never)
  // logger 是 cordis 内建服务：只能在实例化后覆盖，不能 provide（会撞内建注册）。
  ;(ctx as unknown as { logger: unknown }).logger = {
    warn: (message: string) => { logs.warns.push(message) },
    info: (message: string) => { logs.infos.push(message) },
    error: (message: string) => { logs.errors.push(message) },
  }
  return {
    ctx,
    llm: { configurableProviders },
    logs,
  }
}

/**
 * 0.1.6 形态的 settings 替身：收下 namespace，`describe()` 回读已注册项。
 *
 * ⚠️ `register` 收下的 **scope 必须带 `get()`**：`AccountPool` 的构造器也会
 * 调 `settings.register('jet-hub', …)`（账号池自己的旧回退路径），并保存返回值
 * 当 `scope`；少了 `get` 会在 `ensureLoaded` 里抛
 * `this.scope.get is not a function`，而且那是在 `apply()` 之后的异步链上，
 * 表现为**未处理的 rejection**（Vitest 会单独报 Unhandled Rejection）。
 */
function legacySettings(options: { describeThrows?: boolean } = {}) {
  const registered: string[] = []
  const schemas: unknown[] = []
  return {
    registered,
    schemas,
    service: {
      register: (ns: string, schema: unknown) => {
        registered.push(ns)
        schemas.push(schema)
        return { get: () => ({}), replace: async () => {} }
      },
      describe: (): Array<{ ns: string }> => {
        if (options.describeThrows === true) throw new Error('boom')
        return registered.map((ns) => ({ ns }))
      },
    },
  }
}

/**
 * 本插件在 0.1.6 下注册 provider namespace 的数量。
 *
 * ⚠️ settings 替身还会被 `AccountPool` 使用（它注册自己的 `jet-hub`），故断言
 * 「注册了哪 7 个」时必须先按前缀过滤，不能拿全部注册项直接比对。
 */
const PROVIDER_NAMESPACES = [
  'llm-buddy', 'llm-buddy-cn', 'llm-codearts', 'llm-lobsterai',
  'llm-qoder', 'llm-qoder-cn', 'llm-trae-cn',
] as const

/** 从替身记录的注册项里挑出 provider 配置 namespace（滤掉账号池的 `jet-hub`）。 */
function providerNamespacesOf(registered: readonly string[]): string[] {
  return registered.filter((ns) => ns.startsWith('llm-')).sort()
}

/** 0.1.7 形态的 settings 替身：**没有** `register`，只有 describe/configure/update。 */
function projectionSettings(options: { describeResult?: Array<{ ns: string }> } = {}) {
  const configured: Array<{ presentation: { auto?: boolean }; owner: unknown }> = []
  return {
    configured,
    service: {
      // 刻意不提供 register：这正是 0.1.7 删除的那个方法。
      describe: (): Array<{ ns: string }> => options.describeResult ?? [],
      configure: (presentation: { auto?: boolean }, owner: unknown) => {
        configured.push({ presentation, owner })
        return () => {}
      },
      update: async () => {},
      replace: async () => {},
      mutate: async () => {},
    },
  }
}

/** 本插件 7 个 provider 的 id（与 `apply()` 注册的路由一一对应）。 */
const PROVIDERS = [
  'codearts',
  BUDDY_CN.id,
  BUDDY.id,
  LOBSTERAI.id,
  TRAE_CN.id,
  QODER.id,
  QODER_CN.id,
] as const

afterEach(() => {
  vi.clearAllMocks()
})

describe('detectSettingsContract：三种运行形态的判据', () => {
  it('settings 服务缺失 → absent', () => {
    const { ctx } = makeContext(undefined)
    expect(detectSettingsContract(ctx)).toBe('absent')
  })

  it('有 register → legacy（0.1.6）', () => {
    const { ctx } = makeContext(legacySettings().service)
    expect(detectSettingsContract(ctx)).toBe('legacy')
  })

  it('服务在但**没有 register** → projection（0.1.7），不是 absent', () => {
    // 这是本次修复的核心判据：两者都让 `typeof register` 不是函数，
    // 但 0.1.7 是**正常路径**，绝不能报「服务不可用」。
    const { ctx } = makeContext(projectionSettings().service)
    expect(detectSettingsContract(ctx)).toBe('projection')
  })
})

describe('resolveSettingsEntryId：0.1.7 下 namespace 的来源', () => {
  it('无 loader（测试/裸上下文）时回退到模块级 name', () => {
    const { ctx } = makeContext(projectionSettings().service)
    // `ctx.fiber.entry` 由 cordis-plugin-loader 增强；本仓库依赖树里没有它，
    // 故回退值必须与 cordis.patch.yml 的 `id: codearts-auth` 同源。
    expect(resolveSettingsEntryId(ctx)).toBe(name)
    expect(resolveSettingsEntryId(ctx)).toBe('codearts-auth')
  })

  it('loader 给出 entry id 时以它为准（profile 可改名，namespace 必须跟着走）', () => {
    const { ctx } = makeContext(projectionSettings().service)
    ;(ctx.fiber as unknown as { entry: unknown }).entry = { options: { id: 'my-hub' } }
    expect(resolveSettingsEntryId(ctx)).toBe('my-hub')
  })

  it('entry id 为空串 / 非字符串时回退（不能让空 namespace 流到注册处）', () => {
    const { ctx } = makeContext(projectionSettings().service)
    for (const bad of ['', 42, null, undefined]) {
      ;(ctx.fiber as unknown as { entry: unknown }).entry = { options: { id: bad } }
      expect(resolveSettingsEntryId(ctx), String(bad)).toBe('codearts-auth')
    }
  })
})

describe('makeSettingsAddressResolver：namespace 与 path 必须成对', () => {
  it('legacy → llm-<provider> + 空 path（整节就是该 provider 的 profile）', () => {
    const address = makeSettingsAddressResolver('legacy', 'codearts-auth')
    expect(address('codearts')).toEqual({ settingsNs: 'llm-codearts', settingsPath: [] })
    // 带连字符的 id 是正确的（namespace 是字符串键，与 cordis 服务名两套规则）。
    expect(address('trae-cn')).toEqual({ settingsNs: 'llm-trae-cn', settingsPath: [] })
    expect(address('buddy-cn')).toEqual({ settingsNs: 'llm-buddy-cn', settingsPath: [] })
    expect(address('qoder-cn')).toEqual({ settingsNs: 'llm-qoder-cn', settingsPath: [] })
  })

  it('projection → entry id + [providers, <id>]（七个 provider 共用一个 namespace）', () => {
    const address = makeSettingsAddressResolver('projection', 'codearts-auth')
    for (const provider of PROVIDERS) {
      expect(address(provider), provider).toEqual({
        settingsNs: 'codearts-auth',
        settingsPath: ['providers', provider],
      })
    }
  })

  it('absent 沿用 legacy 形态（服务后到时行为一致，地址无人消费）', () => {
    expect(makeSettingsAddressResolver('absent', 'codearts-auth')('qoder'))
      .toEqual({ settingsNs: 'llm-qoder', settingsPath: [] })
  })
})

describe('0.1.6 形态（legacy）：7 个 namespace 逐个注册', () => {
  it('注册全部 7 个 provider namespace，且 settingsNs 就是这些 namespace', () => {
    const legacy = legacySettings()
    const { ctx, llm, logs } = makeContext(legacy.service)
    apply(ctx)

    // 账号池也在这条路上注册了自己的 `jet-hub`（旧回退路径），故只看 provider 那 7 个。
    expect(providerNamespacesOf(legacy.registered)).toEqual([...PROVIDER_NAMESPACES].sort())
    // 传下去的 schema 必须是真 schemastery schema（裸函数会让宿主 describe() 抛错）。
    for (const schema of legacy.schemas) {
      expect(typeof (schema as { toJSON?: unknown }).toJSON).toBe('function')
    }
    // 目录项的 settingsNs 必须与注册的 namespace **逐字一致**，否则模型设置页崩。
    for (const entry of llm.configurableProviders) {
      expect(legacy.registered, String(entry.provider)).toContain(entry.settingsNs)
    }
    // 0.1.6 下不该出现「服务不可用」这类误报。
    // ⚠️ 只断言**本插件**打的日志：账号池在缺 storage 时会打自己的
    // 「[account-hub] storage 服务不可用，账号池回退旧 settings 路径」（另一条通路、
    // 措辞正确），把它算进来测的就不是同一件事了。故按 `[codearts-auth]` 前缀过滤。
    const ours = logs.warns.filter((m) => m.startsWith('[codearts-auth]'))
    expect(ours.some((m) => m.includes('服务不可用'))).toBe(false)
    expect(ours.some((m) => m.includes('settings 服务不存在'))).toBe(false)
  })

  it('注册后回读 describe() 自检，并报出未生效的 namespace', () => {
    // describe() 恒返回空 ⇒ 7 个 namespace 全部「未生效」，必须逐个报出来。
    const service = {
      register: () => ({ get: () => ({}), replace: async () => {} }),
      describe: (): Array<{ ns: string }> => [],
    }
    const { ctx, logs } = makeContext(service)
    apply(ctx)
    const notEffective = logs.warns.filter((m) => m.includes('provider namespace 未生效'))
    expect(notEffective).toHaveLength(1)
    expect(notEffective[0]).toContain('llm-codearts')
    expect(notEffective[0]).toContain('llm-qoder-cn')
  })

  it('describe() 自身抛错时打 error（不静默吞，也不炸插件加载）', () => {
    const legacy = legacySettings({ describeThrows: true })
    const { ctx, logs } = makeContext(legacy.service)
    expect(() => { apply(ctx) }).not.toThrow()
    expect(logs.errors.some((m) => m.includes('settings.describe 失败'))).toBe(true)
  })

  it('单个 namespace 注册抛错时只警告该条，其余继续注册', () => {
    const registered: string[] = []
    const service = {
      register: (ns: string) => {
        if (ns === 'llm-buddy') throw new Error('already registered')
        registered.push(ns)
        return { get: () => ({}), replace: async () => {} }
      },
      describe: (): Array<{ ns: string }> => registered.map((ns) => ({ ns })),
    }
    const { ctx, logs } = makeContext(service)
    expect(() => { apply(ctx) }).not.toThrow()
    expect(logs.warns.some((m) => m.includes('"llm-buddy" 注册失败'))).toBe(true)
    // 失败的那条不影响其余 6 条（`jet-hub` 是账号池自己注册的，按前缀滤掉）。
    expect(providerNamespacesOf(registered)).toHaveLength(6)
    expect(providerNamespacesOf(registered)).not.toContain('llm-buddy')
  })
})

describe('0.1.7 形态（projection）：不注册、不误报', () => {
  it('**不 warn**：服务在、只是没有 register，这是正常路径', () => {
    const projection = projectionSettings({ describeResult: [{ ns: 'codearts-auth' }] })
    const { ctx, logs } = makeContext(projection.service)
    apply(ctx)
    // 旧文案「settings 服务不可用」必须彻底消失 —— 它正是把排查引偏的元凶。
    // ⚠️ 只断言**本插件**打的日志：账号池在缺 storage 时会打自己的
    // 「storage 服务不可用，账号池回退旧 settings 路径」（另一条通路，措辞正确），
    // 把它算进来会让这条断言测的不是同一件事。故按 `[codearts-auth]` 前缀过滤。
    const ours = logs.warns.filter((m) => m.startsWith('[codearts-auth]'))
    expect(ours.filter((m) => m.includes('服务不可用'))).toEqual([])
    expect(ours.filter((m) => m.includes('settings 服务不存在'))).toEqual([])
  })

  it('目录项的 settingsNs 全部是 entry id，path 是 [providers, <id>]', () => {
    const projection = projectionSettings()
    const { ctx, llm } = makeContext(projection.service)
    apply(ctx)

    expect(llm.configurableProviders).toHaveLength(7)
    for (const entry of llm.configurableProviders) {
      expect(entry.settingsNs, String(entry.provider)).toBe('codearts-auth')
      expect(entry.settingsPath, String(entry.provider)).toEqual(['providers', entry.provider])
    }
    // 七个 provider 一个都不能少（少一个，那个面板的配置项就凭空消失）。
    expect(llm.configurableProviders.map((e) => e.provider).sort())
      .toEqual([...PROVIDERS].sort())
  })

  it('entry id 已投影到 describe() 时报 info 就绪，且**不 warn**', () => {
    // 测试用 root context：apply() 期间 fiber 已 ACTIVE，自检同步执行。
    const projection = projectionSettings({ describeResult: [{ ns: 'codearts-auth' }] })
    const { ctx, logs } = makeContext(projection.service)
    apply(ctx)
    expect(logs.infos.some((m) => m.includes('settings namespace 投影就绪: codearts-auth'))).toBe(true)
    expect(logs.warns.filter((m) => m.includes('未出现在 describe() 中'))).toEqual([])
  })

  it('entry id **缺席** describe() 时如实警告（模型设置页要崩的前兆）', () => {
    const projection = projectionSettings({ describeResult: [{ ns: 'llm-pi-ai' }] })
    const { ctx, logs } = makeContext(projection.service)
    apply(ctx)
    const missing = logs.warns.filter((m) => m.includes('未出现在 describe() 中'))
    expect(missing).toHaveLength(1)
    // 措辞必须可行动：报出期望的 namespace、病因与当前已投影的集合。
    expect(missing[0]).toContain('codearts-auth')
    expect(missing[0]).toContain('llm-pi-ai')
    expect(missing[0]).toContain('0.1.7')
  })

  it('entry id 改名后以新 id 校验（profile 可改名，namespace 必须跟着走）', () => {
    const projection = projectionSettings({ describeResult: [{ ns: 'my-hub' }] })
    const { ctx, llm, logs } = makeContext(projection.service)
    ;(ctx.fiber as unknown as { entry: unknown }).entry = { options: { id: 'my-hub' } }
    apply(ctx)
    expect(logs.infos.some((m) => m.includes('投影就绪: my-hub'))).toBe(true)
    // 且目录项也改用新 id（namespace 与 path 同源：两者都从 entry id 派生，
    // 改名后仍必须成对 —— 一处跟新一处留旧正是最难查的半迁移态）。
    expect(llm.configurableProviders).toHaveLength(7)
    for (const entry of llm.configurableProviders) {
      expect(entry.settingsNs, String(entry.provider)).toBe('my-hub')
      expect(entry.settingsPath, String(entry.provider)).toEqual(['providers', entry.provider])
    }
    expect(logs.warns.filter((m) => m.includes('未出现在 describe() 中'))).toEqual([])
  })

  it('describe() 抛错时打 error 且不炸加载', () => {
    const service = {
      describe: () => { throw new Error('describe boom') },
      configure: () => () => {},
    }
    const { ctx, logs } = makeContext(service)
    expect(() => { apply(ctx) }).not.toThrow()
    expect(logs.errors.some((m) => m.includes('settings.describe 失败'))).toBe(true)
  })

  it('0.1.7 下登记 auto:false 关闭自动生成页（本插件有自己的 Account Hub 面板）', async () => {
    const projection = projectionSettings()
    const { ctx } = makeContext(projection.service)
    apply(ctx)
    // configure 走 ctx.inject(['settings']) 惰性注入：子 fiber 在服务就绪后才会跑。
    await vi.waitFor(() => { expect(projection.configured.length).toBeGreaterThan(0) })
    expect(projection.configured[0].presentation).toEqual({ auto: false })
    // owner 必须是本插件实例的 fiber（否则会关掉别人的自动生成页）。
    expect(projection.configured[0].owner).toBe(ctx.fiber)
  })

  it('0.1.6 下没有 configure → 整体跳过，不抛错', async () => {
    const legacy = legacySettings()
    const { ctx } = makeContext(legacy.service)
    expect(() => { apply(ctx) }).not.toThrow()
    // 让惰性注入的子 fiber 有机会跑一遍（0.1.6 的 settings 没有 configure）。
    await Promise.resolve()
  })
})

describe('服务完全缺失（absent / headless）：只提示一次、不抛错', () => {
  it('apply 不抛错，且只提示一次（措辞区分「服务不在」与「服务在但没方法」）', () => {
    const { ctx, llm, logs } = makeContext(undefined)
    expect(() => { apply(ctx) }).not.toThrow()
    const absent = logs.warns.filter((m) => m.includes('settings 服务不存在'))
    expect(absent).toHaveLength(1)
    // 措辞必须点明「服务不在」，而不是含糊的「不可用」。
    expect(absent[0]).toContain('未装载')
    // 且必须说清影响面：账号池/登录/模型路由不受影响（否则用户会以为全坏了）。
    expect(absent[0]).toContain('不受影响')
    // 服务缺失不阻断路由注册。
    expect(llm.configurableProviders).toHaveLength(7)
  })

  it('absent 下沿用 0.1.6 地址形态（服务后到时行为一致）', () => {
    const { ctx, llm } = makeContext(undefined)
    apply(ctx)
    for (const entry of llm.configurableProviders) {
      expect(entry.settingsNs, String(entry.provider)).toBe(`llm-${String(entry.provider)}`)
      expect(entry.settingsPath, String(entry.provider)).toEqual([])
    }
  })
})

/**
 * 复刻宿主 settings 的 `volatileForm()`（`packages/settings/settings/src/schema.ts:37-47`）。
 *
 * 判据逐字照抄：根带 `meta.volatile` 即整体可投影；否则**只有 object 类型**才逐子节点
 * 递归，且**子节点里一个 volatile 都没有时返回 undefined**。宿主 `describe()` 正是
 * 用它决定「这个 entry 要不要进 descriptors」—— 返回 undefined 就等于 namespace
 * 不存在，模型设置页随后崩在 `refFor → deriveKeyRef`。
 *
 * @param schema - 待判定的 schema 节点。
 * @returns 可投影的子表单映射；无可投影字段时为 undefined。
 */
function volatileFormOf(schema: unknown): Record<string, unknown> | undefined {
  const node = schema as {
    meta?: { volatile?: boolean }
    type?: string
    dict?: Record<string, unknown>
  }
  if (node.meta?.volatile === true) return { $self: node }
  if (node.type !== 'object') return undefined
  const dict = Object.fromEntries(Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
    const field = volatileFormOf(child)
    return field === undefined ? [] : [[key, field]]
  }))
  return Object.keys(dict).length === 0 ? undefined : dict
}

/**
 * 复刻宿主 settings 的 `isVolatilePath()`（同文件 `:74-79`）。
 *
 * 设置页写入 `['providers', <id>]` 时宿主会先过这道闸：路径上每级都要落在 volatile
 * 节点之下，否则 `settings.write` 抛 `Config field "..." is not volatile`。
 *
 * @param schema - 插件 Config 根 schema。
 * @param path - 字段路径（如 `['providers', 'codearts']`）。
 * @returns 该路径是否可热改。
 */
function isVolatilePathOf(schema: unknown, path: readonly string[]): boolean {
  const node = schema as {
    meta?: { volatile?: boolean }
    dict?: Record<string, unknown>
  }
  if (node.meta?.volatile === true) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : node.dict?.[key]
  return child !== undefined && isVolatilePathOf(child, rest)
}

describe('Config：0.1.7 namespace 投影的接线本体', () => {
  it('**通过宿主的 volatileForm() 闸门**（返回 undefined 就等于 namespace 不存在）', () => {
    const form = volatileFormOf(Config)
    expect(form, 'volatileForm(Config) 不得为 undefined').toBeDefined()
    // 闸门放行的正是 `providers` 这个槽 —— 7 个 provider 都挂在它下面。
    expect(Object.keys(form!)).toEqual(['providers'])
  })

  it('providers 槽本身带 meta.volatile（这是「能有 volatile 字段」的唯一来源）', () => {
    // ⚠️ 不断言 `Config.toJSON()` 的行内结构：schemastery 的 toJSON() 是
    // **按引用序列化**（产出 `{ uid, refs }`），子节点在 `refs` 里以 id 互指，
    // 故 JSON 里根本没有 `dict.providers.meta`。判据要看**活 schema**。
    const providers = (Config as unknown as {
      dict?: Record<string, { meta?: { volatile?: boolean } }>
    }).dict?.providers
    expect(providers?.meta?.volatile).toBe(true)
  })

  it('[providers, <id>] 是宿主认可的 volatile 路径（设置页据此读写该槽）', () => {
    for (const provider of PROVIDERS) {
      expect(isVolatilePathOf(Config, ['providers', provider]), provider).toBe(true)
    }
    // 反面：未声明 volatile 的路径必须被拒（否则「写入成功」会变成静默无效）。
    expect(isVolatilePathOf(Config, ['accounts'])).toBe(false)
  })

  it('通过 standard-schema 校验：空配置归一为 { providers: {} }（cordis 启动即走这条）', () => {
    const standard = (Config as unknown as {
      '~standard': { validate: (value: unknown) => { value?: unknown; issues?: unknown } }
    })['~standard']
    for (const raw of [undefined, null, {}]) {
      const result = standard.validate(raw)
      expect(result.issues, String(raw)).toBeUndefined()
      expect(result.value, String(raw)).toEqual({ providers: {} })
    }
  })

  it('用户填的 provider 槽原样保留（设置页写入的值不能被 schema 丢掉）', () => {
    const standard = (Config as unknown as {
      '~standard': { validate: (value: unknown) => { value?: unknown } }
    })['~standard']
    const result = standard.validate({ providers: { codearts: { apiKeyEnv: 'CODEARTS_ACCESS_TOKEN' } } })
    expect(result.value).toEqual({ providers: { codearts: { apiKeyEnv: 'CODEARTS_ACCESS_TOKEN' } } })
  })

  it('导出的是真 schema 而不是裸函数（裸函数会让宿主 describe() 抛 toJSON 不是函数）', () => {
    // 宿主对每个进 describe() 的表单无条件调用 `schema.toJSON()` 与
    // `redactSecrets(schema, value)`；裸函数（`(value) => …`）会让 describe() 抛
    // `TypeError: schema.toJSON is not a function`，进而使所有依赖 settings 的
    // 界面（模型设置页、主题、sidebar）全部失败。故这三条必须成立。
    const schema = Config as unknown as { toJSON?: unknown; meta?: unknown; '~standard'?: unknown }
    expect(typeof schema.toJSON).toBe('function')
    // ⚠️ `Schema.is()` 返回的是**判据本身**（判定通过时回传那个 schema 节点、
    // 失败时回 false/undefined），不是布尔 `true` —— 故这里断言真值而非 `toBe(true)`。
    expect(Schema.is(Config)).toBeTruthy()
    expect(typeof schema['~standard']).toBe('object') // cordis 靠它校验 Config
  })
})
