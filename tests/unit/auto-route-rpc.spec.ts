/**
 * 「自动路由」的**配置面**测试：存储字段 `autoRoute` + 池读写 + RPC `autoroute.get` / `autoroute.set`。
 *
 * 纯逻辑（`auto-route.spec.ts`）已守住 `sanitizeAutoRouteConfig` / `assertValidAutoRouteConfig`
 * 的判据；本文件补的是**两端之间的那一段**，也正是最容易静默断掉的地方：
 *
 * 1. **落盘互带**：`autoRoute` 是那份单例文档的第九件。任何一次写入都是整体 replace，
 *    **漏带即清空** —— 表现是「用户配好的自动模型过一会儿自己没了」，且完全没有报错。
 *    故这里逐条写路径断言落盘键集合，并专测「写完 autoRoute 再走别的写路径」。
 * 2. **读盘兜底**：存储文件可能被手工编辑过 / 残留旧格式，脏值必须回落默认而不是抛错。
 * 3. **写路径的严格性**：非法配置必须 throw（由 RPC 包成 bad-request 带回原文），
 *    且**拒绝后配置一字不变** —— 写路径上静默丢弃等于「点了保存却什么都没存」。
 * 4. **部分更新**：`enabled` 与 `models` 是两个彼此独立的入口，各自只发自己那一个。
 */

import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { sanitizeAccountHubDocument } from '../../src/account-hub-storage.js'
import { AUTO_ROUTE_PROVIDER_ID } from '../../src/auto-route.js'
import type { AutoRouteDefinition } from '../../src/auto-route.js'

/** 一份合法定义（`entries` 至少一条、provider 不自引用）。 */
const DEFINITION: AutoRouteDefinition = {
  id: 'def-1',
  name: 'fast-auto',
  entries: [{ provider: 'buddy-cn', model: 'glm-5.3' }],
}

/** 第二份合法定义（用于「只传 models 不抹 enabled」等多定义场景）。 */
const SECOND_DEFINITION: AutoRouteDefinition = {
  id: 'def-2',
  name: 'cheap-auto',
  entries: [
    { provider: 'qoder', model: 'gfmodel', effort: 'low' },
    { provider: 'trae-cn', model: 'doubao' },
  ],
}

/** 落盘载荷必须**恰好**是这九个键（漏带一个 = 清空一个）。 */
const DOCUMENT_KEYS = [
  'accounts', 'autoRoute', 'checkins', 'consumption', 'consumptionCursors',
  'contextBudgets', 'disabledModels', 'providerAuditVersion', 'schemaVersion',
].sort()

interface HarnessOptions {
  /** `false` = 关掉 storage 域，走 settings 回退路径。 */
  withStorage?: boolean
  /**
   * 预置进持久层文档的 `autoRoute` **原值**。
   *
   * 刻意用 `'autoRoute' in options` 判定「是否给过」：不给 = 字段**不存在**（老文档），
   * 给 `undefined` / `'garbage'` = 字段在但值脏 —— 两种形态都要覆盖。
   */
  autoRoute?: unknown
}

/**
 * 双通路替身：storage 域（主路径）与 settings scope（回退路径）各一份。
 *
 * ⚠️ `storage.read()` **刻意不做归一化**（直接交回原始文档）：真实实现会经
 * `sanitizeAccountHubDocument`，而池自己**也**必须扛得住缺字段 / 脏值 —— 那正是
 * 「mock 比真实实现更宽松」时唯一能抓住的形态。
 */
function makeHarness(options: HarnessOptions = {}) {
  const storageWrites: Array<Record<string, unknown>> = []
  const settingsWrites: Array<Record<string, unknown>> = []

  const seedDocument = (): Record<string, unknown> => {
    const doc: Record<string, unknown> = {
      accounts: [],
      disabledModels: {},
      contextBudgets: {},
      checkins: {},
      consumption: {},
      consumptionCursors: {},
      schemaVersion: 0,
      providerAuditVersion: 0,
    }
    if ('autoRoute' in options) doc.autoRoute = options.autoRoute
    return doc
  }

  let storageGlobal: Record<string, unknown> = seedDocument()
  let settingsValue: Record<string, unknown> = seedDocument()

  const storage = {
    read: () => storageGlobal,
    write: async (doc: Record<string, unknown>) => {
      const snapshot = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
      storageWrites.push(snapshot)
      storageGlobal = snapshot
    },
  }

  type Handler = (request: Request) => Promise<Response>
  let handler: Handler | undefined
  /**
   * 被 `settings.register()` 收下的 schema。
   *
   * ⚠️ 必须留一份：其余用例的 settings 替身**绕过了 schema**（`get` 直接交回原始
   * 文档），于是「`accountHubSchema` 忘了给 `autoRoute` 带 `.default`」这条真实
   * 缺陷在所有替身用例里都抓不到 —— 而它的后果是 settings 回退路径下字段读成
   * `undefined`。下面有一条用例拿真 schema 跑一遍。
   */
  let registeredSchema: ((value: unknown) => Record<string, unknown>) | undefined

  const ctx = {
    get: (key: string) => {
      if (key === 'storageDomain' && options.withStorage !== false) {
        return {
          open: async () => ({
            global: { get: () => storage.read(), set: storage.write },
            close: async () => {},
          }),
        }
      }
      if (key === 'settings') {
        return {
          register: (_ns: string, schema: unknown) => {
            registeredSchema = schema as (value: unknown) => Record<string, unknown>
            return {
              get: () => settingsValue,
              replace: async (value: Record<string, unknown>) => {
                settingsWrites.push(value)
                settingsValue = value
              },
            }
          },
        }
      }
      if (key === 'connection') {
        return { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      }
      return undefined
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      resolve: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
  }

  const newPool = (): AccountPool => new AccountPool(ctx as never)

  const register = (pool: AccountPool): void => {
    registerAccountHubRpc(
      ctx as never, pool, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    )
  }

  const call = async (method: string, payload: unknown) => {
    if (handler === undefined) throw new Error('endpoint handler was not registered')
    const response = await handler(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'account-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: unknown; error?: { message: string } }
    }
    return body.result
  }

  return {
    ctx,
    newPool,
    register,
    call,
    storageWrites,
    settingsWrites,
    registeredSchema: () => registeredSchema,
    storageCurrent: () => storageGlobal,
    settingsCurrent: () => settingsValue,
  }
}

/** 建池 → 打开持久层 → 注册端点（生产 `apply()` 的时序）。 */
async function setup(options: HarnessOptions = {}) {
  const h = makeHarness(options)
  const pool = h.newPool()
  await pool.openStorage()
  h.register(pool)
  return { h, pool }
}

describe('autoroute.get / autoroute.set 端点', () => {
  it('新库（老文档，无 autoRoute 字段）get 返回默认关闭的空配置，而不是 undefined', async () => {
    const { h } = await setup()
    const result = await h.call('autoroute.get', {})
    expect(result.ok).toBe(true)
    // 默认关闭 + 空列表：新功能默认关，用户显式打开才生效。
    expect(result.value).toEqual({ enabled: false, models: [] })
  })

  it('set enabled=true → get 读回 true；且**池重载（storage 往返）后仍在**', async () => {
    const { h, pool } = await setup()
    const written = await h.call('autoroute.set', { enabled: true })
    expect(written.ok).toBe(true)
    expect(written.value).toEqual({ enabled: true, models: [] })
    expect(pool.autoRouteConfig().enabled).toBe(true)
    // 落盘了才算数：换一个池读同一份持久层。
    expect((h.storageCurrent().autoRoute as { enabled: boolean }).enabled).toBe(true)
    const reloaded = h.newPool()
    await reloaded.openStorage()
    expect(reloaded.autoRouteConfig()).toEqual({ enabled: true, models: [] })
  })

  it('set models → get 读回整组定义（含 effort 缺省不写键）', async () => {
    const { h } = await setup()
    const written = await h.call('autoroute.set', { models: [DEFINITION, SECOND_DEFINITION] })
    expect(written.ok).toBe(true)
    expect(written.value).toEqual({ enabled: false, models: [DEFINITION, SECOND_DEFINITION] })
    const read = await h.call('autoroute.get', {})
    expect(read.value).toEqual({ enabled: false, models: [DEFINITION, SECOND_DEFINITION] })
    // effort 缺省时**不留键**（缺省 = 该模型默认档，与显式空串是两回事）。
    const entries = (read.value as { models: AutoRouteDefinition[] }).models[0]!.entries
    expect(Object.keys(entries[0]!).sort()).toEqual(['model', 'provider'])
  })

  it('**部分更新**：只传 models 时 enabled 保留', async () => {
    const { h } = await setup()
    await h.call('autoroute.set', { enabled: true })
    const second = await h.call('autoroute.set', { models: [DEFINITION] })
    expect(second.value).toEqual({ enabled: true, models: [DEFINITION] })
  })

  it('**部分更新**：只传 enabled 时 models 保留', async () => {
    const { h } = await setup()
    await h.call('autoroute.set', { models: [DEFINITION, SECOND_DEFINITION] })
    const second = await h.call('autoroute.set', { enabled: false })
    expect(second.value).toEqual({ enabled: false, models: [DEFINITION, SECOND_DEFINITION] })
  })

  it('models 是**整组替换**语义（不做逐条合并）', async () => {
    const { h } = await setup()
    await h.call('autoroute.set', { models: [DEFINITION, SECOND_DEFINITION] })
    const replaced = await h.call('autoroute.set', { models: [SECOND_DEFINITION] })
    expect(replaced.value).toEqual({ enabled: false, models: [SECOND_DEFINITION] })
  })

  it('非法配置一律拒绝，且错误原文透出（用户唯一能据以改正的信息）', async () => {
    const { h, pool } = await setup()
    const cases: Array<{ payload: unknown; expect: string }> = [
      // 名称重复（name 即暴露给 DSH 的模型 id，重复即歧义）
      {
        payload: { models: [DEFINITION, { ...SECOND_DEFINITION, name: DEFINITION.name }] },
        expect: '重复',
      },
      // entries 为空（没有候选的自动模型等于死路）
      { payload: { models: [{ ...DEFINITION, entries: [] }] }, expect: '缺少模型条目' },
      // 自引用（自动路由委派给自动路由 = 无限递归）
      {
        payload: { models: [{ ...DEFINITION, entries: [{ provider: AUTO_ROUTE_PROVIDER_ID, model: 'x' }] }] },
        expect: '无限递归',
      },
      // 条目缺 provider / model
      { payload: { models: [{ ...DEFINITION, entries: [{ model: 'x' }] }] }, expect: '缺少 provider' },
      { payload: { models: [{ ...DEFINITION, entries: [{ provider: 'qoder' }] }] }, expect: '缺少 model' },
      // models 不是数组 / enabled 不是布尔
      { payload: { models: 'not-an-array' }, expect: 'models 必须是数组' },
      { payload: { enabled: 'yes' }, expect: 'enabled 必须是布尔值' },
      { payload: { enabled: null }, expect: 'enabled 必须是布尔值' },
    ]
    for (const { payload, expect: fragment } of cases) {
      const rejected = await h.call('autoroute.set', payload)
      expect(rejected.ok, `应拒绝：${JSON.stringify(payload)}`).toBe(false)
      expect(rejected.error?.message, `错误原文应点名原因：${JSON.stringify(payload)}`)
        .toContain(fragment)
    }
    // 全部被拒之后配置**一字不变**：不能留下半截写入。
    expect(pool.autoRouteConfig()).toEqual({ enabled: false, models: [] })
    expect(h.storageWrites).toHaveLength(0)
  })

  it('自引用常量就是虚拟 provider id（判据不能漂移）', () => {
    expect(AUTO_ROUTE_PROVIDER_ID).toBe('auto-route')
  })

  // ── 畸形顶层：**必须报错**，不能回 ok:true ──
  //
  // 修复前的实测缺陷：`payload as RpcAutoRouteSetRequest` 之后，`42` / `"x"` / `null`
  // 上的 `req?.enabled` / `req?.models` 全都读成 `undefined`，于是走
  // 「两字段都不给 = 无操作」的**合法**分支并回 `ok: true`。用户点保存拿到「成功」，
  // 配置一字未动，且没有任何可排查的痕迹 —— 静默无操作比明确报错糟得多。

  it('畸形顶层（42 / "x" / null）被拒为 bad-request，且配置一字不变', async () => {
    const { h, pool } = await setup()
    // 先写一份真实配置，用来证明「被拒之后它没有被任何畸形请求改掉」。
    await h.call('autoroute.set', { enabled: true, models: [DEFINITION] })
    const before = pool.autoRouteConfig()
    const writesBefore = h.storageWrites.length

    for (const malformed of [42, 'x', null]) {
      const rejected = await h.call('autoroute.set', malformed)
      expect(rejected.ok, `畸形顶层 ${JSON.stringify(malformed)} 必须被拒，不能回 ok:true`).toBe(false)
      expect(rejected.error?.message, '错误消息应说明要求是对象').toContain('对象')
    }

    // 三次拒绝之后：配置仍是先前那份，且**一次落盘都没发生**。
    expect(pool.autoRouteConfig()).toEqual(before)
    expect(h.storageWrites).toHaveLength(writesBefore)
  })

  it('畸形顶层被拒 → **不**通知运行时重建（与其它拒绝路径同款）', async () => {
    let calls = 0
    const h = makeHarness()
    const pool = h.newPool()
    await pool.openStorage()
    registerAccountHubRpc(
      h.ctx as never, pool, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      undefined, undefined, () => { calls++ },
    )

    const rejected = await h.call('autoroute.set', 42)

    expect(rejected.ok).toBe(false)
    expect(calls, '畸形请求没写任何东西，不该让运行时重建').toBe(0)
  })

  it('合法空对象 `{}` 仍是「无操作」而不是报错（守卫只挡非对象）', async () => {
    const { h } = await setup()
    // 部分更新语义的既有边界：两个字段都不给 = 什么都不改，但**形状合法**。
    // 守卫写成「必须至少给一个字段」会误伤这条既有契约。
    const result = await h.call('autoroute.set', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: false, models: [] })
  })

  it('get 返回的是**深拷贝**：客户端改它不会串到池内状态', async () => {
    const { h, pool } = await setup()
    await h.call('autoroute.set', { models: [DEFINITION] })
    const first = await h.call('autoroute.get', {})
    const models = (first.value as { models: AutoRouteDefinition[] }).models
    models.push(SECOND_DEFINITION)
    models[0]!.entries[0]!.model = '被客户端改坏'
    expect(pool.autoRouteConfig()).toEqual({ enabled: false, models: [DEFINITION] })
    expect((await h.call('autoroute.get', {})).value).toEqual({ enabled: false, models: [DEFINITION] })
  })

  it('未知方法仍然报 bad-request（default 分支未被新 case 破坏）', async () => {
    const { h } = await setup()
    const result = await h.call('autoroute.nope', {})
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('unknown method')
  })
})

describe('autoRoute 的读盘兜底（脏值回落默认，绝不抛错）', () => {
  it('raw 文档里 autoRoute 是垃圾值 → 加载后回落默认', async () => {
    for (const garbage of ['garbage', 42, null, [], { enabled: 'yes', models: 'nope' }]) {
      const { pool } = await setup({ autoRoute: garbage })
      expect(pool.autoRouteConfig()).toEqual({ enabled: false, models: [] })
    }
  })

  it('storage 的 sanitize 同口径兜底（字段缺失 / 脏值都回落默认）', () => {
    expect(sanitizeAccountHubDocument({}).autoRoute).toEqual({ enabled: false, models: [] })
    expect(sanitizeAccountHubDocument({ autoRoute: 'x' }).autoRoute).toEqual({ enabled: false, models: [] })
    // 逐条丢弃非法定义 / 条目，保留合法部分。
    const doc = sanitizeAccountHubDocument({
      autoRoute: {
        enabled: true,
        models: [
          DEFINITION,
          { ...SECOND_DEFINITION, entries: [] },
          { ...SECOND_DEFINITION, entries: [{ provider: AUTO_ROUTE_PROVIDER_ID, model: 'x' }] },
        ],
      },
    })
    expect(doc.autoRoute).toEqual({ enabled: true, models: [DEFINITION] })
  })

  it('老文档（无 autoRoute 字段）读入补默认值，而不是 undefined', () => {
    const doc = sanitizeAccountHubDocument({ accounts: [], schemaVersion: 5 })
    expect(doc.autoRoute).toEqual({ enabled: false, models: [] })
    expect(doc.schemaVersion).toBe(5)
  })

  it('settings 回退路径的 schema 必须给 autoRoute 带 default（真 schema 跑一遍）', async () => {
    // ⚠️ 这条**刻意不走替身文档**：其余用例的 settings 替身直接交回原始值，绕过了
    // `accountHubSchema`，于是「schema 忘了带 `.default`」在它们那里抓不到 ——
    // 而真实后果是 settings 回退路径下老配置读成 `undefined`（面板读到空、
    // 写入路径又把它当缺省重新落盘）。
    const { h } = await setup({ withStorage: false })
    const schema = h.registeredSchema()
    expect(schema, 'settings.register 应被调用并收下 schema').toBeTypeOf('function')
    // 老配置：namespace 首次注册时配置文件里根本没有 autoRoute 键。
    const resolved = schema!({ accounts: [], disabledModels: {}, contextBudgets: {} })
    expect(resolved.autoRoute).toEqual({ enabled: false, models: [] })
    // 默认值必须是**可写副本**（深冻结的 DEFAULT_AUTO_ROUTE_CONFIG 直接塞进去
    // 会让下游的写入当场 TypeError），且两次解析互不共享引用。
    const other = schema!({ accounts: [] })
    expect(resolved.autoRoute).not.toBe(other.autoRoute)
    expect(() => (resolved.autoRoute as { models: unknown[] }).models.push({})).not.toThrow()
    expect(other.autoRoute).toEqual({ enabled: false, models: [] })
  })
})

describe('autoRoute 的持久化互带（漏一处就被静默清空）', () => {
  it('writeAutoRoute 之后再走 writeAccounts（以及其余各写路径），autoRoute 不丢', async () => {
    const { h, pool } = await setup()
    await pool.writeAutoRoute({ enabled: true, models: [DEFINITION] })
    await pool.addAccount({
      id: 'buddy-cn-001',
      provider: 'buddy-cn',
      nickname: '测试',
      enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T1',
      createdAt: 1_789_000_000_000,
      refreshable: true,
    })
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    await pool.writeCheckinNextEligible('buddy-cn', 'buddy-cn-001', Date.now() + 60_000)
    await pool.writeConsumption('qoder', { order: 'sequential' })
    await pool.removeAccount('buddy-cn-001')
    expect(pool.autoRouteConfig()).toEqual({ enabled: true, models: [DEFINITION] })
    expect(h.storageCurrent().autoRoute).toEqual({ enabled: true, models: [DEFINITION] })
  })

  it('每一条写路径的落盘载荷都带齐九个键', async () => {
    const { h, pool } = await setup()
    await pool.writeAutoRoute({ enabled: true, models: [DEFINITION] })
    await pool.addAccount({
      id: 'buddy-cn-001',
      provider: 'buddy-cn',
      nickname: '测试',
      enabled: true,
      credentialRef: 'BUDDY_CN_ACCOUNT_T1',
      createdAt: 1_789_000_000_000,
      refreshable: true,
    })
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    await pool.writeContextBudget('qoder', 'gfmodel', 1_000_000)
    await pool.writeCheckinNextEligible('buddy-cn', 'buddy-cn-001', Date.now() + 60_000)
    await pool.writeConsumption('qoder', { order: 'sequential' })
    await pool.replaceAll([], pool.allDisabledModels(), 6)
    expect(h.storageWrites.length).toBeGreaterThanOrEqual(7)
    for (const write of h.storageWrites) {
      expect(Object.keys(write).sort()).toEqual(DOCUMENT_KEYS)
    }
  })

  it('replaceAll（一次性迁移的原子写）同样携带 autoRoute', async () => {
    const { h, pool } = await setup()
    await pool.writeAutoRoute({ enabled: true, models: [DEFINITION] })
    await pool.replaceAll([], {}, 6)
    const last = h.storageWrites.at(-1)!
    expect(Object.keys(last).sort()).toEqual(DOCUMENT_KEYS)
    expect(last.autoRoute).toEqual({ enabled: true, models: [DEFINITION] })
    expect(pool.autoRouteConfig()).toEqual({ enabled: true, models: [DEFINITION] })
  })

  it('写 autoRoute 本身也是一次整体 replace，不动其它八件', async () => {    const { h, pool } = await setup()
    await pool.setModelDisabled('qoder', 'gfmodel', true)
    const before = h.storageCurrent()
    await pool.writeAutoRoute({ models: [DEFINITION] })
    const after = h.storageCurrent()
    expect(after.disabledModels).toEqual(before.disabledModels)
    expect(Object.keys(after).sort()).toEqual(DOCUMENT_KEYS)
  })

  it('settings 回退分支：storage 不可用时字段经 settings 路径存活（读 + 写都验）', async () => {
    const { h, pool } = await setup({ withStorage: false, autoRoute: { enabled: true, models: [DEFINITION] } })
    // 读：回退路径同样读得到并归一化。
    expect(pool.autoRouteConfig()).toEqual({ enabled: true, models: [DEFINITION] })
    // 写：整份文档落进 settings，键集合仍是九件。
    await pool.writeAutoRoute({ models: [DEFINITION, SECOND_DEFINITION] })
    const last = h.settingsWrites.at(-1)!
    expect(Object.keys(last).sort()).toEqual(DOCUMENT_KEYS)
    expect(last.autoRoute).toEqual({ enabled: true, models: [DEFINITION, SECOND_DEFINITION] })
    // 换一个池读同一份 settings：仍在。
    const reloaded = h.newPool()
    expect(await reloaded.openStorage()).toBe(false)
    expect(reloaded.autoRouteConfig()).toEqual({
      enabled: true,
      models: [DEFINITION, SECOND_DEFINITION],
    })
  })
})

// ──────────────────────────── 配置变更通知（第 12 实参）────────────────────────────

/**
 * `registerAccountHubRpc(…, onAutoRouteChanged?)` 的**第 12 个实参**。
 *
 * 它连接的是「配置面」与「运行面」这两处**不同所有者**的状态：配置写在池上，
 * 而降级队列握在聚合适配器手里（见 `src/account-hub-rpc.ts` 的 `@param`）。
 * 没有这条通知，用户在面板里改了候选顺序后运行时仍按旧顺序转发，且**没有任何报错**。
 *
 * 本组用例守三件事：**成功才通知**、**通知失败不上抛**（fire-and-forget 自吞异常）、
 * **失败路径不通知**（配置没写进去就不该让运行时去重建）。
 */
describe('autoroute.set：第 12 实参（配置变更通知）', () => {
  /** 与生产 `apply()` 同序：建池 → 打开持久层 → 注册（带第 12 实参）。 */
  const setupWithNotify = async (onAutoRouteChanged?: () => void) => {
    const h = makeHarness()
    const pool = h.newPool()
    await pool.openStorage()
    registerAccountHubRpc(
      h.ctx as never, pool, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
      undefined, undefined, onAutoRouteChanged,
    )
    return { h, pool }
  }

  it('set 成功 → 回调**恰好**被调用一次（每次写入一次，不多不少）', async () => {
    let calls = 0
    const { h, pool } = await setupWithNotify(() => { calls++ })

    const result = await h.call('autoroute.set', { enabled: true, models: [DEFINITION] })

    expect(result.ok).toBe(true)
    expect(calls, '配置写成功后应当通知运行时重建降级队列').toBe(1)
    expect(pool.autoRouteConfig()).toEqual({ enabled: true, models: [DEFINITION] })
    // 读端点（autoroute.get）**不**触发通知：它不改任何状态。
    await h.call('autoroute.get', {})
    expect(calls, '读配置不该触发运行时重建').toBe(1)
  })

  it('回调抛错 → set 仍返回成功（fire-and-forget 自吞异常）', async () => {
    const { h } = await setupWithNotify(() => { throw new Error('运行时重建失败') })

    const result = await h.call('autoroute.set', { enabled: true })

    // ⚠️ 这是本组最要紧的一条：回调失败绝不能让用户看到「保存失败」——
    // 那会促使他再点一次保存，而配置其实早就写对了。
    expect(result.ok, '通知失败不得冒泡成保存失败').toBe(true)
    expect(result.value).toEqual({ enabled: true, models: [] })
  })

  it('非法配置被拒 → **不**通知（配置没落盘就不该让运行时重建）', async () => {
    let calls = 0
    const { h, pool } = await setupWithNotify(() => { calls++ })

    const rejected = await h.call('autoroute.set', { models: [{ ...DEFINITION, entries: [] }] })

    expect(rejected.ok).toBe(false)
    expect(calls, '写入被拒时不得通知运行时').toBe(0)
    expect(pool.autoRouteConfig()).toEqual({ enabled: false, models: [] })
  })

  it('省略第 12 实参（headless / 既有调用点）→ 配置照常写入，不抛错', async () => {
    const { h } = await setupWithNotify(undefined)

    const result = await h.call('autoroute.set', { enabled: true, models: [DEFINITION] })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ enabled: true, models: [DEFINITION] })
  })
})
