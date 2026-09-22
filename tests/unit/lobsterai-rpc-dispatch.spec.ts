/**
 * `account.refresh` RPC 分派的回归测试。
 *
 * 覆盖两个**既有缺陷**（T7 修复）：
 *
 * 1. **workbuddy 分支缺失**：原实现只判 `codearts` / `buddy-cn`，workbuddy 落入
 *    else 抛 `Unknown provider` —— 即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的。
 * 2. **刷错凭据**：原实现调 `service.refresh()`，而该方法读写的是该 provider 的
 *    **默认单凭据 ref**（如 `BUDDY_CN_ACCESS_TOKEN`），Account Hub 账号卡片对应的却是
 *    `BUDDY_CN_ACCOUNT_XXX` —— 于是「刷新这个账号」实际刷的是另一个凭据。
 *
 * 这两个缺陷都无法靠 `collect*` 那类纯函数测试发现（它们不在那条代码路径上），
 * 因此这里直接驱动 `registerAccountHubRpc` 注册的 HTTP 处理器，断言真实分派行为。
 */

import { describe, expect, it, vi } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 采集到的「某服务被要求刷新的 credentialRef」。 */
interface RefreshCall {
  service: string
  credentialRef: string
}

/**
 * 构造一个 fake `ctx`，捕获 `connection.fetch.register` 的处理器。
 */
function makeCtx(accounts: ProviderAccountEntry[]) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (options: { fetch: (request: Request) => Promise<Response> }) => {
          handler = options.fetch
        },
      },
    },
    // 生产代码用**惰性注入**（`ctx.inject(['connection'], …)`）挂载端点，而非
    // 插件级静态 `inject`：`connection` 只存在于 Web bundle，静态声明会让
    // headless/CLI profile 永久 pending 而启动失败。替身必须复刻这一机制，
    // 否则 registerAccountHubRpc 会以 `ctx.inject is not a function` 直接抛错。
    // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ configured: false }),
    },
    get: () => undefined,
  }
  return { ctx, getHandler: () => handler! }
}

/** 构造一个只记录调用、不做真实网络的服务替身。 */
function makeServiceStub(name: string, calls: RefreshCall[]) {
  return {
    refreshAccountCredential: vi.fn(async (ref: string) => { calls.push({ service: name, credentialRef: ref }) }),
    refresh: vi.fn(async () => { calls.push({ service: `${name}.refresh(default)`, credentialRef: '' }) }),
  }
}

/** 构造账号池替身。 */
function makePool(accounts: ProviderAccountEntry[]) {
  return {
    listAllAccounts: async () => accounts,
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    updateAccount: async () => {},
  }
}

/**
 * 调用 `account.refresh` 并返回 RPC 结果载荷。
 */
async function callRefresh(
  accounts: ProviderAccountEntry[],
  accountId: string,
): Promise<{ calls: RefreshCall[]; value: { success: boolean; error?: string } }> {
  const calls: RefreshCall[] = []
  const { ctx, getHandler } = makeCtx(accounts)
  registerAccountHubRpc(
    ctx as never,
    makePool(accounts) as never,
    makeServiceStub('codearts', calls) as never,
    makeServiceStub('buddy-cn', calls) as never,
    makeServiceStub('buddy', calls) as never,
    makeServiceStub('lobsterai', calls) as never,
    // traeCn / qoder / qoderCn：本文件只驱动 `account.refresh`，而它按账号条目
    // 自己的 `provider` 分派；这三种 provider 都不在 fixture 里，故不会被碰到。
    makeServiceStub('trae-cn', calls) as never,
    makeServiceStub('qoder', calls) as never,
    makeServiceStub('qoder-cn', calls) as never,
  )
  const response = await getHandler()(new Request('http://127.0.0.1/api/account-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'account-hub',
      payload: { method: 'account.refresh', payload: { accountId } },
    }),
  }))
  const body = await response.json() as {
    result: { ok: boolean; value?: { success: boolean; error?: string } }
  }
  return { calls, value: body.result.value! }
}

function entry(provider: string, credentialRef: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    nickname: '测试号',
    enabled: true,
    credentialRef,
    createdAt: 1,
    refreshable: true,
  }
}

describe('account.refresh 分派（T7 回归）', () => {
  it('buddy-cn 账号刷新**自己的** credentialRef，而不是默认单凭据 ref', async () => {
    // 缺陷 2 的回归：原实现调 buddy.refresh()（读 BUDDY_CN_ACCESS_TOKEN），
    // 刷的是另一个凭据。
    const { calls, value } = await callRefresh(
      [entry('buddy-cn', 'BUDDY_CN_ACCOUNT_AAAA1111')], 'buddy-cn-1',
    )
    expect(value.success).toBe(true)
    expect(calls).toEqual([{ service: 'buddy-cn', credentialRef: 'BUDDY_CN_ACCOUNT_AAAA1111' }])
    // 绝不能退化成「刷默认凭据」。
    expect(calls.some((c) => c.service.includes('refresh(default)'))).toBe(false)
  })

  it('buddy 账号可刷新且不再抛 Unknown provider（缺陷 1 的回归）', async () => {
    // 原实现只判 codearts / buddy（当年的中国版 id），国际版落到 else 抛
    // `Unknown provider`，value.success 为 false。
    const { calls, value } = await callRefresh(
      [entry('buddy', 'BUDDY_ACCOUNT_BBBB2222')], 'buddy-1',
    )
    expect(value.success).toBe(true)
    expect(value.error).toBeUndefined()
    expect(calls).toEqual([{ service: 'buddy', credentialRef: 'BUDDY_ACCOUNT_BBBB2222' }])
  })

  it('lobsterai 账号刷新自己的 credentialRef（新增 provider 不得重蹈覆辙）', async () => {
    const { calls, value } = await callRefresh(
      [entry('lobsterai', 'LOBSTERAI_ACCOUNT_CCCC3333')], 'lobsterai-1',
    )
    expect(value.success).toBe(true)
    expect(calls).toEqual([{ service: 'lobsterai', credentialRef: 'LOBSTERAI_ACCOUNT_CCCC3333' }])
  })

  it('codearts 账号刷新自己的 credentialRef', async () => {
    const { calls, value } = await callRefresh(
      [entry('codearts', 'CODEARTS_ACCOUNT_DDDD4444')], 'codearts-1',
    )
    expect(value.success).toBe(true)
    expect(calls).toEqual([{ service: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_DDDD4444' }])
  })

  it('四个 provider 各自分派到对应服务（互不串用）', async () => {
    const accounts = [
      entry('codearts', 'CODEARTS_ACCOUNT_1'),
      entry('buddy-cn', 'BUDDY_CN_ACCOUNT_1'),
      entry('buddy', 'BUDDY_ACCOUNT_1'),
      entry('lobsterai', 'LOBSTERAI_ACCOUNT_1'),
    ]
    for (const target of accounts) {
      const { calls, value } = await callRefresh(accounts, target.id.replace(`${target.provider}-1`, `${target.provider}-1`))
      expect(value.success, target.provider).toBe(true)
      expect(calls, target.provider).toEqual([
        { service: target.provider, credentialRef: target.credentialRef },
      ])
    }
  })

  it('未知 provider 仍然报错（不静默成功）', async () => {
    const { value } = await callRefresh([entry('mystery', 'MYSTERY_ACCOUNT_1')], 'mystery-1')
    expect(value.success).toBe(false)
    expect(value.error).toMatch(/Unknown provider/)
  })

  it('账号不存在时报错', async () => {
    const { value } = await callRefresh([], 'nope-1')
    expect(value.success).toBe(false)
    expect(value.error).toMatch(/not found/)
  })
})
