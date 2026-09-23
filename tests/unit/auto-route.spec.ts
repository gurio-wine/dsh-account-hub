/**
 * 「自动路由」的**纯逻辑**回归测试。
 *
 * ## 本文件守什么
 *
 * `src/auto-route.ts` 是自动路由功能的唯一真相源，它同时承载三件彼此独立的事：
 *
 * 1. **配置契约**（一个总开关 + 若干「自动模型」，每个自动模型是一条有序的
 *    `(provider, model, effort?)` 候选列表）。读盘路径容错（{@link sanitizeAutoRouteConfig}
 *    永不抛错、脏层丢弃），写路径严格（{@link assertValidAutoRouteConfig} 非法即抛）——
 *    两者对「什么是非法」的判据**完全一致**，只是处置从丢弃改成拒绝。
 * 2. **运行时降级引擎**：失败者移到队尾、新队首立刻顶替、跨请求持续、重启归位。
 * 3. **满一圈的判定归调用方**：引擎只做轮转、不计数，调用方按「单次请求内
 *    demote 次数 ≥ 条目总数」判「该自动模型全部不可用」。
 *
 * ## 为什么先把契约钉死
 *
 * 后续两单（宿主接线、客户端 UI）都要 import 这份契约：宿主适配器按条目委派真实
 * provider、客户端按定义 id 做增删排序。导出名与语义一旦漂移，两侧同时失效，
 * 故本文件把每个判据都写成显式断言，而不是只测「大致能用」。
 */

import { describe, expect, it } from 'vitest'
import {
  AUTO_ROUTE_PROVIDER_ID,
  DEFAULT_AUTO_ROUTE_CONFIG,
  assertValidAutoRouteConfig,
  autoRouteEntryCount,
  autoRouteHead,
  createAutoRouteRuntime,
  demoteAutoRouteHead,
  sanitizeAutoRouteConfig,
  type AutoRouteDefinition,
} from '../../src/auto-route.js'

/** 造一个合法的自动模型定义（测试里只覆盖关心的字段）。 */
const def = (
  id: string,
  name: string,
  entries: { provider: string; model: string; effort?: string }[],
): AutoRouteDefinition => ({ id, name, entries })

const entry = (provider: string, model: string, effort?: string): { provider: string; model: string; effort?: string } =>
  effort === undefined ? { provider, model } : { provider, model, effort }

/** 从定义里取出条目三元组，便于断言「顺序 + 内容」。 */
const triples = (list: readonly { provider: string; model: string; effort?: string }[]): string[] =>
  list.map(item => `${item.provider}/${item.model}${item.effort === undefined ? '' : `@${item.effort}`}`)

describe('默认值：深冻结、且每次返回的都是全新对象', () => {
  it('默认值就是「关着 + 空列表」，并深冻结（共享缺省值不得被就地改写）', () => {
    expect(DEFAULT_AUTO_ROUTE_CONFIG).toEqual({ enabled: false, models: [] })
    expect(Object.isFrozen(DEFAULT_AUTO_ROUTE_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_AUTO_ROUTE_CONFIG.models)).toBe(true)
  })

  it('非对象输入一律回落默认值，且**不共享**默认值实例（改返回值不得污染全局缺省）', () => {
    for (const dirty of [undefined, null, 'auto', 7, true, []]) {
      const result = sanitizeAutoRouteConfig(dirty)
      expect(result).toEqual({ enabled: false, models: [] })
      expect(result).not.toBe(DEFAULT_AUTO_ROUTE_CONFIG)
      expect(result.models).not.toBe(DEFAULT_AUTO_ROUTE_CONFIG.models)
    }
  })
})

describe('sanitizeAutoRouteConfig：读路径容错（脏层丢弃，永不抛错）', () => {
  it('enabled 强制 boolean：非布尔一律 false（只有真正的 true 才算开着）', () => {
    expect(sanitizeAutoRouteConfig({ enabled: true }).enabled).toBe(true)
    expect(sanitizeAutoRouteConfig({ enabled: 'yes' }).enabled).toBe(false)
    expect(sanitizeAutoRouteConfig({ enabled: 1 }).enabled).toBe(false)
    expect(sanitizeAutoRouteConfig({ enabled: 0 }).enabled).toBe(false)
    expect(sanitizeAutoRouteConfig({}).enabled).toBe(false)
  })

  it('models 非数组 → 空列表（不把对象/字符串当定义表用）', () => {
    expect(sanitizeAutoRouteConfig({ models: 'x' }).models).toEqual([])
    expect(sanitizeAutoRouteConfig({ models: { a: 1 } }).models).toEqual([])
    expect(sanitizeAutoRouteConfig({ models: null }).models).toEqual([])
    expect(sanitizeAutoRouteConfig({}).models).toEqual([])
  })

  it('丢弃非法条目：provider / model 为空、自引用 auto-route、effort 空串', () => {
    const result = sanitizeAutoRouteConfig({
      models: [def('m1', '自动一号', [
        entry('', 'gpt'),                                        // provider 空
        entry('dsh', ''),                                        // model 空
        entry(AUTO_ROUTE_PROVIDER_ID, 'loop'),                    // 自引用
        entry('dsh', 'x', ''),                                    // effort 空串
        entry('  ', 'x'),                                         // 全空白也算空
        entry('dsh', 'deepseek-chat', 'high'),                     // 唯一合法条目
      ])],
    })
    expect(triples(result.models[0].entries)).toEqual(['dsh/deepseek-chat@high'])
  })

  it('条目里的字符串两端空白被归一（比较与存储用同一份归一值）', () => {
    const result = sanitizeAutoRouteConfig({ models: [def('m1', ' 自动一号 ', [entry(' dsh ', ' x ', ' low ')])] })
    expect(result.models[0].name).toBe('自动一号')
    expect(triples(result.models[0].entries)).toEqual(['dsh/x@low'])
  })

  it('缺省 effort 即「该模型默认档」，**不写这个键**（与显式空串是两回事）', () => {
    const result = sanitizeAutoRouteConfig({ models: [def('m1', '自动一号', [entry('dsh', 'x')])] })
    expect(result.models[0].entries[0]).toEqual({ provider: 'dsh', model: 'x' })
    expect('effort' in result.models[0].entries[0]).toBe(false)
  })

  it('entries 为空（或非数组）→ 丢弃整个定义（没有候选的自动模型等于死路）', () => {
    const result = sanitizeAutoRouteConfig({
      models: [
        def('m1', '空的', []),
        { id: 'm2', name: '非数组', entries: 'x' } as unknown as AutoRouteDefinition,
        def('m3', '活着的', [entry('dsh', 'x')]),
      ],
    })
    expect(result.models.map(model => model.id)).toEqual(['m3'])
  })

  it('id / name 为空 → 丢弃整个定义（寻址与显示都不能没有键）', () => {
    const result = sanitizeAutoRouteConfig({
      models: [
        def('', '没有 id', [entry('dsh', 'x')]),
        def('m2', '', [entry('dsh', 'x')]),
        def('m3', '   ', [entry('dsh', 'x')]),
        def('m4', '活着的', [entry('dsh', 'x')]),
      ],
    })
    expect(result.models.map(model => model.id)).toEqual(['m4'])
  })

  it('非对象定义（数字 / 字符串 / null）直接丢弃', () => {
    const result = sanitizeAutoRouteConfig({
      models: [7, 'x', null, undefined, def('m1', '活着的', [entry('dsh', 'x')])],
    })
    expect(result.models.map(model => model.id)).toEqual(['m1'])
  })

  it('name 跨定义重复 → 保留第一个、丢弃后来者（它是暴露给 DSH 的模型 id）', () => {
    const result = sanitizeAutoRouteConfig({
      models: [
        def('m1', '同名', [entry('dsh', 'a')]),
        def('m2', '同名', [entry('dsh', 'b')]),
        def('m3', '另一个', [entry('dsh', 'c')]),
      ],
    })
    expect(result.models.map(model => model.id)).toEqual(['m1', 'm3'])
    expect(result.models[0].entries[0].model).toBe('a')
  })

  it('定义 id 重复 → 保留第一个（RPC 寻址靠 id，重复即歧义）', () => {
    const result = sanitizeAutoRouteConfig({
      models: [
        def('m1', '先来的', [entry('dsh', 'a')]),
        def('m1', '后来的', [entry('dsh', 'b')]),
      ],
    })
    expect(result.models).toHaveLength(1)
    expect(result.models[0].name).toBe('先来的')
  })

  it('同定义内完全同形的重复条目 → 丢弃后来者；effort 不同则视为两条', () => {
    const result = sanitizeAutoRouteConfig({
      models: [def('m1', '自动一号', [
        entry('dsh', 'x', 'high'),
        entry('dsh', 'x', 'high'),   // 完全同形 → 丢
        entry('dsh', 'x'),           // 缺省 effort ≠ high → 留
        entry('dsh', 'x'),           // 与上一条同形 → 丢
        entry('qoder', 'x', 'high'), // provider 不同 → 留
      ])],
    })
    expect(triples(result.models[0].entries)).toEqual(['dsh/x@high', 'dsh/x', 'qoder/x@high'])
  })

  it('返回全新对象：改返回值 / 改输入都不得互相串味（无共享可变引用）', () => {
    const input = { enabled: true, models: [def('m1', '自动一号', [entry('dsh', 'x', 'high')])] }
    const first = sanitizeAutoRouteConfig(input)
    // 改输入：输出不受影响（说明是深拷贝，不是引用透传）。
    input.models[0].entries[0].model = '被改了'
    input.models.push(def('m9', '偷偷加的', [entry('dsh', 'y')]))
    expect(triples(first.models[0].entries)).toEqual(['dsh/x@high'])
    expect(first.models).toHaveLength(1)
    // 改输出：再次 sanitize 同一份原始输入不受影响。
    first.models[0].entries.push(entry('dsh', 'z'))
    expect(sanitizeAutoRouteConfig({ models: [def('m1', '自动一号', [entry('dsh', 'x', 'high')])] }).models[0].entries)
      .toHaveLength(1)
  })

  it('只丢脏的那一条，不牵连同一份配置里的好定义', () => {
    const result = sanitizeAutoRouteConfig({
      enabled: 'true',
      models: [
        def('m1', '好的', [entry('dsh', 'x'), entry('auto-route', 'self')]),
        { id: 'm2', name: '坏的', entries: [] },
        def('m3', '也好的', [entry('qoder', 'y')]),
      ],
    })
    expect(result.enabled).toBe(false)
    expect(result.models.map(model => model.id)).toEqual(['m1', 'm3'])
    expect(triples(result.models[0].entries)).toEqual(['dsh/x'])
  })
})

describe('assertValidAutoRouteConfig：写路径非法即抛（判据与 sanitize 完全一致）', () => {
  const valid = {
    enabled: true,
    models: [
      def('m1', '自动一号', [entry('dsh', 'x', 'high'), entry('qoder', 'y')]),
      def('m2', '自动二号', [entry('buddy-cn', 'z')]),
    ],
  }

  it('合法配置放行', () => {
    expect(() => assertValidAutoRouteConfig(valid)).not.toThrow()
    // enabled 缺省 = false（部分更新语义），其余字段必须齐形。
    expect(() => assertValidAutoRouteConfig({ models: [] })).not.toThrow()
    expect(() => assertValidAutoRouteConfig({ enabled: false, models: [] })).not.toThrow()
  })

  it('非对象 / enabled 非布尔 → 抛错并指明字段', () => {
    expect(() => assertValidAutoRouteConfig(null)).toThrow(/配置/)
    expect(() => assertValidAutoRouteConfig('x')).toThrow(/配置/)
    expect(() => assertValidAutoRouteConfig([])).toThrow(/配置/)
    expect(() => assertValidAutoRouteConfig({ models: [], enabled: 'true' })).toThrow(/enabled/)
  })

  it('models 缺失 / 非数组 → 抛错（只有 enabled 允许缺省）', () => {
    expect(() => assertValidAutoRouteConfig({})).toThrow(/models/)
    expect(() => assertValidAutoRouteConfig({ models: 'x' })).toThrow(/models/)
    expect(() => assertValidAutoRouteConfig({ enabled: true })).toThrow(/models/)
  })

  it('定义非对象 / id 空 / id 重复 → 抛错并指认是第几个', () => {
    expect(() => assertValidAutoRouteConfig({ models: [7] })).toThrow(/第 1 个自动模型/)
    expect(() => assertValidAutoRouteConfig({ models: [def('', 'A', [entry('dsh', 'x')])] })).toThrow(/id/)
    expect(() => assertValidAutoRouteConfig({
      models: [def('m1', 'A', [entry('dsh', 'x')]), def('m1', 'B', [entry('dsh', 'y')])],
    })).toThrow(/第 2 个自动模型.*重复/)
  })

  it('name 空 / name 重复 → 抛错并指认冲突对象', () => {
    expect(() => assertValidAutoRouteConfig({ models: [def('m1', '  ', [entry('dsh', 'x')])] })).toThrow(/名称/)
    expect(() => assertValidAutoRouteConfig({
      models: [def('m1', '同名', [entry('dsh', 'x')]), def('m2', '同名', [entry('dsh', 'y')])],
    })).toThrow(/同名/)
  })

  it('entries 缺失 / 空 → 抛「缺少模型条目」', () => {
    expect(() => assertValidAutoRouteConfig({ models: [def('m1', 'A', [])] })).toThrow(/缺少模型条目/)
    expect(() => assertValidAutoRouteConfig({
      models: [{ id: 'm1', name: 'A', entries: 'x' } as unknown as AutoRouteDefinition],
    })).toThrow(/缺少模型条目/)
  })

  it('条目非法（provider 空 / model 空 / 自引用 / effort 空串 / 重复）逐条抛错', () => {
    const withEntry = (bad: unknown): unknown => ({ models: [{ id: 'm1', name: 'A', entries: [bad] }] })
    expect(() => assertValidAutoRouteConfig(withEntry({ provider: '', model: 'x' }))).toThrow(/provider/)
    expect(() => assertValidAutoRouteConfig(withEntry({ provider: 'dsh', model: '' }))).toThrow(/model/)
    expect(() => assertValidAutoRouteConfig(withEntry({ provider: AUTO_ROUTE_PROVIDER_ID, model: 'x' }))).toThrow(/自身/)
    expect(() => assertValidAutoRouteConfig(withEntry({ provider: 'dsh', model: 'x', effort: '' }))).toThrow(/effort/)
    expect(() => assertValidAutoRouteConfig(withEntry(7))).toThrow(/第 1 个条目/)
    expect(() => assertValidAutoRouteConfig({
      models: [{ id: 'm1', name: 'A', entries: [entry('dsh', 'x'), entry('dsh', 'x')] }],
    })).toThrow(/第 2 个条目.*重复/)
  })

  it('抛出的消息带上出问题的定义名（用户要在界面上知道改哪一条）', () => {
    expect(() => assertValidAutoRouteConfig({
      models: [def('m1', '坏掉的', [entry('auto-route', 'x')])],
    })).toThrow(/坏掉的/)
  })
})

describe('运行时降级引擎：失败者移到队尾，新队首立刻顶替', () => {
  const models = (): AutoRouteDefinition[] => [
    def('m1', '自动一号', [entry('dsh', 'a'), entry('qoder', 'b'), entry('buddy-cn', 'c')]),
  ]

  it('初始队首 = 列表第一条；条目数 = 列表长度', () => {
    const rt = createAutoRouteRuntime(models())
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
    expect(autoRouteEntryCount(rt, 'm1')).toBe(3)
  })

  it('快照隔离：runtime 深拷贝定义，demote 绝不改动传入的配置数组', () => {
    const source = models()
    const rt = createAutoRouteRuntime(source)
    demoteAutoRouteHead(rt, 'm1')
    demoteAutoRouteHead(rt, 'm1')
    expect(triples(source[0].entries)).toEqual(['dsh/a', 'qoder/b', 'buddy-cn/c'])
    // 反向也要成立：事后改传入数组，不得影响运行时队列。
    source[0].entries.reverse()
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['buddy-cn/c'])
  })

  it('降级轮转：fail a → 队首 b；再 fail b → 队首 c', () => {
    const rt = createAutoRouteRuntime(models())
    expect(triples([demoteAutoRouteHead(rt, 'm1')!])).toEqual(['qoder/b'])
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['qoder/b'])
    expect(triples([demoteAutoRouteHead(rt, 'm1')!])).toEqual(['buddy-cn/c'])
    expect(autoRouteEntryCount(rt, 'm1')).toBe(3)
  })

  it('满一圈判定归调用方：3 连败后第 4 次取队首回到 a（引擎自己不计数）', () => {
    const rt = createAutoRouteRuntime(models())
    const total = autoRouteEntryCount(rt, 'm1')
    const seen: string[] = []
    let demotions = 0
    // 模拟一次请求：失败即 demote，demote 次数达到条目总数即判「全部不可用」。
    while (demotions < total) {
      seen.push(triples([autoRouteHead(rt, 'm1')!])[0])
      demoteAutoRouteHead(rt, 'm1')
      demotions += 1
    }
    expect(seen).toEqual(['dsh/a', 'qoder/b', 'buddy-cn/c'])
    expect(demotions).toBe(total)
    // 满一圈后队列回到原顺序，队首又是 a —— 调用方此时才向 DSH 报「全部不可用」。
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
  })

  it('单条目轮转是 no-op：[a] demote 后仍 [a]、队首仍 a（靠计数判满圈）', () => {
    const rt = createAutoRouteRuntime([def('m1', '独苗', [entry('dsh', 'a')])])
    expect(triples([demoteAutoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
    expect(autoRouteEntryCount(rt, 'm1')).toBe(1)
  })

  it('跨请求持续：第二次请求从上次轮转后的队首开始（被降过的排在后面）', () => {
    const rt = createAutoRouteRuntime(models())
    // 第一次请求：a 失败一次 → b 顶替，随后 b 成功（不再 demote）。
    demoteAutoRouteHead(rt, 'm1')
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['qoder/b'])
    // 第二次请求（同一 runtime，无重置）：仍从 b 开始；b 再失败才轮到 c。
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['qoder/b'])
    expect(triples([demoteAutoRouteHead(rt, 'm1')!])).toEqual(['buddy-cn/c'])
    // a 被降到了队尾：懒恢复，只有 c 也失败才会重新轮到它。
    expect(triples([demoteAutoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
  })

  it('未知定义 id：队首 null、条目数 0、demote 也是 null（不抛错）', () => {
    const rt = createAutoRouteRuntime(models())
    expect(autoRouteHead(rt, 'nobody')).toBeNull()
    expect(demoteAutoRouteHead(rt, 'nobody')).toBeNull()
    expect(autoRouteEntryCount(rt, 'nobody')).toBe(0)
  })

  it('空条目列表（未经 sanitize 的手工定义）：队首 null、计数 0、demote 不炸', () => {
    const rt = createAutoRouteRuntime([def('m1', '空的', [])])
    expect(autoRouteHead(rt, 'm1')).toBeNull()
    expect(demoteAutoRouteHead(rt, 'm1')).toBeNull()
    expect(autoRouteEntryCount(rt, 'm1')).toBe(0)
  })

  it('多个自动模型各自独立轮转，互不影响', () => {
    const rt = createAutoRouteRuntime([
      def('m1', '一号', [entry('dsh', 'a'), entry('qoder', 'b')]),
      def('m2', '二号', [entry('buddy-cn', 'c'), entry('dsh', 'd')]),
    ])
    demoteAutoRouteHead(rt, 'm1')
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['qoder/b'])
    expect(triples([autoRouteHead(rt, 'm2')!])).toEqual(['buddy-cn/c'])
    expect(autoRouteEntryCount(rt, 'm2')).toBe(2)
  })

  it('返回的是副本：调用方就地改队首条目也污染不了运行时队列', () => {
    const rt = createAutoRouteRuntime(models())
    const head = autoRouteHead(rt, 'm1')!
    head.model = '被改了'
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
  })

  it('createAutoRouteRuntime 不抛错：脏定义被丢弃、重复 id 保留第一个（与 sanitize 同口径）', () => {
    const rt = createAutoRouteRuntime([
      7 as unknown as AutoRouteDefinition,
      def('m1', '先来的', [entry('dsh', 'a')]),
      def('m1', '后来的', [entry('dsh', 'b')]),
      def('m2', '空的', []),
    ])
    expect(autoRouteEntryCount(rt, 'm1')).toBe(1)
    expect(triples([autoRouteHead(rt, 'm1')!])).toEqual(['dsh/a'])
    expect(autoRouteEntryCount(rt, 'm2')).toBe(0)
  })

  it('重启回到用户手排的原始顺序（运行时状态不落盘，重建即归位）', () => {
    const source = models()
    const first = createAutoRouteRuntime(source)
    demoteAutoRouteHead(first, 'm1')
    demoteAutoRouteHead(first, 'm1')
    // 走了两条（a、b），队首是 c —— 运行时确实偏离了用户排的原始顺序。
    expect(triples([autoRouteHead(first, 'm1')!])).toEqual(['buddy-cn/c'])
    // 同一份用户配置重建 = 重启后的样子：**不继承**上一进程的轮转偏移，回到 a。
    const restarted = createAutoRouteRuntime(source)
    expect(triples([autoRouteHead(restarted, 'm1')!])).toEqual(['dsh/a'])
    // 两个 runtime 互不影响：旧的仍在 c。
    expect(triples([autoRouteHead(first, 'm1')!])).toEqual(['buddy-cn/c'])
  })
})
