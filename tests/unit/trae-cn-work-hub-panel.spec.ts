/**
 * Account Hub 的 **Trae CN Work 面板**回归测试。
 *
 * ## 这个面板为什么需要专门的测试
 *
 * Work 是本插件里**唯一一个「面板 id ≠ 账号池键」**的 provider：它没有独立登录，
 * 账号、凭据（`TRAE_CN_ACCOUNT_*`）与限流切换全部复用 `trae-cn`
 * （`TraeCnWorkProduct.poolProviderId`，见 `src/trae-cn-work-product.ts`）。
 * 于是存在两处**静默失效**，都不会报错、只会「看着不对」：
 *
 * 1. **面板空白**：`account.list` 若按面板 id 过滤，`provider === 'trae-cn'` 的账号
 *    一个都匹配不到 —— 面板永远显示「尚未配置账号」，而账号明明在 Trae CN 里；
 * 2. **积分恒失败**：`credits.balances` 若按面板 id 走 `productById()`，
 *    返回的是 unsupported（积分端点的产品解析只认 `trae-cn`）。
 *
 * 两处都由 `src/jet-hub-rpc.ts` 的 `poolProviderFor()` 收敛，本文件直接驱动
 * `registerJetHubRpc` 注册出来的 HTTP 处理器来断言**真实分派行为**，而不是
 * 断言源码里出现过某个字符串。
 *
 * ## 余额上挂着**两个方向相反**的映射
 *
 * `credits.balances` 是唯一同时需要两者的端点：
 *
 * | 问题 | 函数 | `trae-cn` | `trae-cn-work` |
 * |---|---|---|---|
 * | 查谁的账号 / 打哪个端点 | `poolProviderFor` | `trae-cn` | `trae-cn`（映射过去） |
 * | 显示哪个积分池 | `traeCnPoolFor` | 通用池（0） | Work 池（1） |
 *
 * 前者要「合」（同批账号），后者要「分」（各显示自己花得掉的那笔）。写反任何
 * 一个都不报错：账号查不到是面板空白，池选错是数字看着正常但根本不是这个面板
 * 能花的钱。故下面两组断言成对出现，锁死「两个映射各管一件事」。
 *
 * ## 另外两个反向断言
 *
 * 「映射到位」与「映射过头」只差一行，故同时钉死：
 * - `account.create` **不**做映射（否则二次点击会给同一份凭据建出第二个占位账号）；
 * - `model.list` / `model.setDisabled` **不**做映射（黑名单按 provider id 存，
 *   `TraeCnWorkAdapter.listModels` 读的正是 `trae-cn-work` 这个键；
 *   映射过去会把 Work 的开关写进 IDE 路径的黑名单）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerJetHubRpc,
  accountCredentialRefName,
  poolProviderFor,
  traeCnPoolFor,
} from '../../src/jet-hub-rpc.js'
import { TRAE_CN_WORK } from '../../src/trae-cn-work-product.js'
import { TRAE_CN_POOL_UNIVERSAL, TRAE_CN_POOL_WORK } from '../../src/trae-cn-credits.js'
import type { ProviderAccountEntry } from '../../src/types.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

const DEVICE = '7212345678901234'

function credential(nickname: string): TraeCnCredential {
  return {
    access_token: `AT-${nickname}`,
    refresh_token: 'RT',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: DEVICE,
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    nickname,
  }
}

/** 一个 Trae CN 账号 —— 注意 provider 是 `trae-cn`，不是 `trae-cn-work`。 */
function entry(id: string, enabled = true): ProviderAccountEntry {
  return {
    id,
    provider: 'trae-cn',
    nickname: id,
    enabled,
    credentialRef: `TRAE_CN_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 1,
    refreshable: true,
  }
}

/** 构造 ctx / pool / 服务替身并注册端点。只实现本文件用到的方法。 */
function makeHarness(accounts: ProviderAccountEntry[]) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const listAccountsCalls: string[] = []
  /** 被 `retestAllAccounts` / `resetAllAccounts` 按 provider 选出的账号 id。 */
  const byProviderCalls: Array<{ provider: string; ids: string[] }> = []
  const setModelDisabledCalls: Array<{ provider: string; modelId: string; disabled: boolean }> = []
  const listModelsCalls: string[] = []
  const listDisabledCalls: string[] = []

  const ctx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (config: { fetch: (request: Request) => Promise<Response> }) => {
          handler = config.fetch
        },
      },
    },
    // 生产代码用**惰性注入**（`ctx.inject(['connection'], …)`）挂载端点；
    // 替身必须复刻这一机制，否则 registerJetHubRpc 会直接抛
    // `ctx.inject is not a function`。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async (ref: { name?: string } | string) => {
        const name = typeof ref === 'string' ? ref : String(ref.name ?? '')
        const suffix = name.replace('TRAE_CN_ACCOUNT_', '')
        return { value: JSON.stringify(credential(suffix)) }
      },
      describe: async () => ({ configured: true }),
      set: async () => {},
    },
    // `model.list` 走 `ctx.get('llm')`，返回适配器播报的目录。
    get: (name: string) => name === 'llm'
      ? {
          listModels: async (provider: string) => {
            listModelsCalls.push(provider)
            return [{ id: 'glm-5.1', name: 'GLM-5.1' }]
          },
        }
      : undefined,
  }

  const pool = {
    listAllAccounts: async () => accounts,
    listAccounts: async (provider: string) => {
      listAccountsCalls.push(provider)
      return accounts.filter((a) => a.provider === provider)
    },
    /**
     * `retestAllAccounts` / `resetAllAccounts` 走的是**这一个**按 provider 全量选号
     * 的入口（`src/account-probe.ts` 的 `ProbePool`），与 `listAccounts` 是两条
     * 不同的路径 —— 只断言前者会漏掉这两个端点。
     */
    listAccountsByProvider: (provider: string) => {
      const matched = accounts.filter((a) => a.provider === provider)
      byProviderCalls.push({ provider, ids: matched.map((a) => a.id) })
      return matched
    },
    findAccount: (id: string) => accounts.find((a) => a.id === id),
    clearModelRateLimits: async () => 0,
    updateAccount: async () => {},
    removeAccount: async () => {},
    // `account.refresh` 只用到 `listAllAccounts` + 账号条目自己的 `provider`，
    // 真正的续期动作在 traeCn 服务上（替身见下）。
    listDisabledModels: (provider: string) => {
      listDisabledCalls.push(provider)
      // 返回一个**总是为空**的黑名单：`model.list` 会把「在黑名单里却不在这份
      // 目录里」的模型补回列表（见 jet-hub-rpc.ts 的模型列表并集逻辑），
      // 替身若造假键，目录里就会凭空多出一项，掩盖真正要断言的东西。
      return {}
    },
    setModelDisabled: async (provider: string, modelId: string, disabled: boolean) => {
      setModelDisabledCalls.push({ provider, modelId, disabled })
    },
  }

  // traeCn（最后一个实参）是 `account.refresh` 唯一用到的服务：它按**账号条目自己的
  // `provider`** 分派，Work 面板的刷新因此不需要映射就能工作。替身必须实现
  // `refreshAccountCredential`，否则 handler 抛 TypeError 被包成 handler-failed，
  // 看起来像是「映射错了」。
  const traeCn = { refreshAccountCredential: async () => {} }

  registerJetHubRpc(
    ctx as never,
    pool as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    traeCn as never,
    // qoder / qoderCn：本文件只用到 `account.list` / `model.*` / `credits.*` 的
    // trae 分支，Qoder 两个 region 都走不到。
    {} as never,
    {} as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  return {
    listAccountsCalls,
    byProviderCalls,
    listModelsCalls,
    listDisabledCalls,
    setModelDisabledCalls,
    call: async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://127.0.0.1/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('poolProviderFor：面板 id → 账号池键的唯一收敛点', () => {
  it('trae-cn-work 映射到 trae-cn，其余 provider 原样返回', () => {
    expect(poolProviderFor('trae-cn-work')).toBe('trae-cn')
    // 取自产品配置而不是硬编码副本：两处必须永远同值。
    expect(poolProviderFor(TRAE_CN_WORK.id)).toBe(TRAE_CN_WORK.poolProviderId)
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'mystery']) {
      expect(poolProviderFor(provider), provider).toBe(provider)
    }
  })

  it('两个方向的错误都仍然是静默的，故这里钉死的是**值**而不是「差不多」', () => {
    // 池查询若用 `trae-cn-work`：账号条目的 provider 字段是 `trae-cn`，
    // 一个都匹配不到 → 面板空白（见下面的 account.list 用例）。
    expect(poolProviderFor('trae-cn-work')).not.toBe('trae-cn-work')
    // 路由名若用 `trae-cn`：Work 根本不会出现在模型选择器里。
    expect(TRAE_CN_WORK.id).toBe('trae-cn-work')
    expect(TRAE_CN_WORK.poolProviderId).not.toBe(TRAE_CN_WORK.id)
  })
})

describe('traeCnPoolFor：面板 id → 积分池（与池键映射**方向相反**）', () => {
  it('trae-cn → 通用池，trae-cn-work → Work 池', () => {
    expect(traeCnPoolFor('trae-cn')).toBe(TRAE_CN_POOL_UNIVERSAL)
    expect(traeCnPoolFor('trae-cn-work')).toBe(TRAE_CN_POOL_WORK)
    // 两个池必须是不同的值 —— 写成同一个常量（如复制粘贴漏改）会让两个面板
    // 显示同一个数字，且**不报错**。
    expect(TRAE_CN_POOL_UNIVERSAL).not.toBe(TRAE_CN_POOL_WORK)
  })

  it('这两个映射是**两个不同的问题**，不能互相顶替', () => {
    // 同一个面板 id 在两个函数下得到**不同**的答案，这正是它们必须分开的理由：
    //   - `poolProviderFor` 答「查谁的账号」（两个面板同一个答案）；
    //   - `traeCnPoolFor`   答「显示哪个池」（两个面板必须是不同答案）。
    // 若有人「顺手统一」成一个函数，必然有一边错，而且是静默的。
    expect(poolProviderFor('trae-cn-work')).toBe('trae-cn')
    expect(traeCnPoolFor('trae-cn-work')).toBe(TRAE_CN_POOL_WORK)
    expect(traeCnPoolFor('trae-cn-work')).not.toBe(traeCnPoolFor('trae-cn'))
    // 未映射的 provider 取通用池：本函数只被 Trae 余额分支调用（守卫是
    // `provider === TRAE_CN.id`），默认落在本插件主路径消耗的那个池上。
    expect(traeCnPoolFor('mystery')).toBe(TRAE_CN_POOL_UNIVERSAL)
  })
})

describe('Work 面板列出的 Trae CN 账号', () => {
  it('account.list 用 `trae-cn-work` 请求，返回的是 provider=trae-cn 的那批账号', async () => {
    const h = makeHarness([entry('a'), entry('b', false)])
    const result = await h.call('account.list', { provider: 'trae-cn-work' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as { accounts: ProviderAccountEntry[] }
    expect(value.accounts.map((a) => a.id)).toEqual(['a', 'b'])
    // 面板不能是空的 —— 这正是加这个面板要修的那件事。
    expect(value.accounts.length).toBeGreaterThan(0)
    // 池确实是按 `trae-cn` 查的（映射生效），不是按面板 id 查了个空。
    expect(h.listAccountsCalls).toEqual(['trae-cn'])
  })

  it('账号卡片四类操作按 credentialRef / accountId 走，与面板 id 无关', async () => {
    // 设计决策 3 的核实结论：刷新 / 删除 / 启停都不按 provider 字面量分派 ——
    // 它们的载荷里根本没有 provider 字段，只有 accountId（或凭据 ref）。
    // 因此 Work 面板的这四类操作**不需要任何映射**，自然照常工作；
    // 只有「按 provider 查一批账号」的操作才需要 poolProviderFor。
    const h = makeHarness([entry('a')])

    // 启停：account.update 只吃 accountId + patch。
    const updated = await h.call('account.update', { accountId: 'a', patch: { enabled: false } })
    expect(updated.ok, updated.error?.message).toBe(true)

    // 重测单个账号：同样只吃 accountId。
    const retested = await h.call('account.retest', { accountId: 'a' })
    expect(retested.ok, retested.error?.message).toBe(true)
    // 重置单个账号：同上。
    const reset = await h.call('account.reset', { accountId: 'a' })
    expect(reset.ok, reset.error?.message).toBe(true)

    // 删除：只吃 accountId（另外会取消该账号待登录的会话，与 provider 无关）。
    const deleted = await h.call('account.delete', { accountId: 'a' })
    expect(deleted.ok, deleted.error?.message).toBe(true)

    // 刷新：载荷里也只有 accountId —— 宿主按**账号条目自己的 `provider` 字段**
    // （这里是 `trae-cn`）分派到 traeCn 服务。账号此刻已被上面删掉（替身不真删，
    // 但 find 得到），故这里断言的是**分派到了 traeCn 且如实返回**，
    // 而不是「面板 id 恰好等于 trae-cn 所以蒙对了」。
    const refreshed = await h.call('account.refresh', { accountId: 'a' })
    expect(refreshed.ok, refreshed.error?.message).toBe(true)
    expect((refreshed.value as { success: boolean }).success).toBe(true)
  })

  it('账号不存在时刷新如实报失败（不静默成功）', async () => {
    const h = makeHarness([entry('a')])
    const refreshed = await h.call('account.refresh', { accountId: 'nope' })
    expect(refreshed.ok).toBe(true)
    expect((refreshed.value as { success: boolean; error?: string }).success).toBe(false)
  })

  it('retestAll / resetAll 按池键批量操作，不会「找不到账号」而空跑', async () => {
    const h = makeHarness([entry('a'), entry('b')])
    // 这两个端点走 `pool.listAccountsByProvider(provider)`（`src/account-probe.ts`），
    // 用的是**另一条**按 provider 全量选号的路径 —— 只测 account.list 会漏掉它。
    // 没映射的话这里选出 0 个账号，端点照样 ok，但一个标记也不会被处理。
    const retest = await h.call('account.retestAll', { provider: 'trae-cn-work' })
    expect(retest.ok, retest.error?.message).toBe(true)
    const reset = await h.call('account.resetAll', { provider: 'trae-cn-work' })
    expect(reset.ok, reset.error?.message).toBe(true)
    expect(h.byProviderCalls).toEqual([
      { provider: 'trae-cn', ids: ['a', 'b'] },
      { provider: 'trae-cn', ids: ['a', 'b'] },
    ])
  })
})

describe('Work 面板的积分余额', () => {
  /** 双池余额响应（通用 154.22 / Work 2000），沿用 trae-cn 的端点与口径。 */
  const respond = (url: string): Response => {
    expect(url).toContain('/trae/api/v2/pay/web_user_ent_usage')
    return new Response(JSON.stringify({
      code: 0,
      data: {
        packages: [
          { available_endpoint: 0, name: '通用礼包', remain_amount: 154.22 },
          { available_endpoint: 1, name: 'Work礼包', remain_amount: 2000 },
        ],
      },
    }), { status: 200 })
  }

  it('credits.balances 收到 trae-cn-work 时返回**同一批账号**的 **Work 池**余额', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => respond(String(url))))
    const h = makeHarness([entry('a')])
    const result = await h.call('credits.balances', { provider: 'trae-cn-work' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as {
      accounts: Array<{ accountId: string; balance: { total: number; packages: Array<{ name: string }> } | null }>
    }
    // 映射生效的证据：账号确实查到了（没映射的话这里是空数组）。
    expect(value.accounts).toHaveLength(1)
    expect(value.accounts[0]!.accountId).toBe('a')
    // ⚠️ 数字是 **Work 池**（2000），不是通用池的 154.22 —— Work 面板显示的是
    // 它自己那条路径实际能花的钱。资源包同样只含本池。
    expect(value.accounts[0]!.balance!.total).toBe(2000)
    expect(value.accounts[0]!.balance!.packages.map((pkg) => pkg.name)).toEqual(['Work礼包'])
    expect(h.listAccountsCalls).toEqual(['trae-cn'])
  })

  it('同一份响应在 Trae CN 面板上显示的是通用池（选池用面板 id、不是映射后的池键）', async () => {
    // `credits.balances` 上挂着两个**方向不同**的映射：账号池键要映射
    // （`trae-cn-work` → `trae-cn`，否则查不到账号），显示池**不能**用映射后的
    // 值（否则两个面板都显示通用池，Work 面板的数字永远不是它能花的钱）。
    // 这条与上一条成对：它们一起把「两个映射各管一件事」钉死。
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => respond(String(url))))
    const h = makeHarness([entry('a')])
    const result = await h.call('credits.balances', { provider: 'trae-cn' })
    const value = result.value as { accounts: Array<{ balance: { total: number } }> }
    expect(value.accounts[0]!.balance.total).toBe(154.22)
    expect(h.listAccountsCalls).toEqual(['trae-cn'])
  })

  it('未知 provider 仍然被拒绝（映射没有把拒绝分支吃掉）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => respond(String(url))))
    const h = makeHarness([entry('a')])
    const result = await h.call('credits.balances', { provider: 'mystery' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: mystery')
  })
})

describe('Work 面板的模型显示开关作用于 `trae-cn-work` 键', () => {
  it('model.list 把面板 id 原样透传给 ctx.llm（不映射成 trae-cn）', async () => {
    const h = makeHarness([entry('a')])
    const result = await h.call('model.list', { provider: 'trae-cn-work' })
    expect(result.ok, result.error?.message).toBe(true)
    // 适配器由 `registerTraeCnWorkLlm` 按 `trae-cn-work` 注册；映射过去会
    // 列出 IDE 路径的 16 项目录，与 Work 实际可选的 12 项完全对不上。
    expect(h.listModelsCalls).toEqual(['trae-cn-work'])
    const value = result.value as { models: Array<{ id: string; disabled: boolean }> }
    // 黑名单也按同一个键读：模型与开关必须同源，否则开关会「点了没反应」——
    // `listDisabledCalls` 就是这条的证据（替身把收到的 provider 记了下来）。
    expect(h.listDisabledCalls).toEqual(['trae-cn-work'])
    expect(value.models).toEqual([{ id: 'glm-5.1', name: 'GLM-5.1', disabled: false }])
  })

  it('model.setDisabled 写入 `trae-cn-work` 键（不污染 IDE 路径的黑名单）', async () => {
    const h = makeHarness([entry('a')])
    const result = await h.call('model.setDisabled', {
      provider: 'trae-cn-work', modelId: 'glm-5.1', disabled: true,
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.setModelDisabledCalls).toEqual([
      { provider: 'trae-cn-work', modelId: 'glm-5.1', disabled: true },
    ])
  })
})

describe('account.create 刻意不映射', () => {
  it('trae-cn-work 落到 unknown provider 而不是建出第二个 trae-cn 占位账号', async () => {
    // Work 没有独立登录。若这里映射成 `trae-cn`，面板多出来的二次点击会派生
    // 第二个 `trae-cn-<shortId>` 占位条目，而两者背后是同一份凭据体系 ——
    // 等于把一个账号建两遍。宁可拒绝，不可静默重复建号。
    const h = makeHarness([entry('a')])
    const result = await h.call('account.create', { provider: 'trae-cn-work' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unknown provider: trae-cn-work')
  })

  it('凭据 ref 派生仍与 trae-cn 同族（Work 复用同一份 TRAE_CN_ACCOUNT_*）', () => {
    // 面板不建号，但换号/续期路径拿到的仍是这批 ref；两处前缀必须一致。
    expect(accountCredentialRefName('trae-cn', 'ABC12345')).toBe('TRAE_CN_ACCOUNT_ABC12345')
    expect(poolProviderFor('trae-cn-work')).toBe('trae-cn')
  })
})
