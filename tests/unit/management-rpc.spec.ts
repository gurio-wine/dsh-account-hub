import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callManagementRpc, unwrapRpcResult } from '../../plugin-src/management-rpc.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 读源文件（归一化 CRLF），供源码级接线断言使用。 */
function readSource(relative: string): string {
  return readFileSync(resolve(here, relative), 'utf8').replace(/\r\n/g, '\n')
}

/** 抓一个字面量常量；抓不到直接抛，避免断言在解析失败时静默通过。 */
function readConst(source: string, pattern: RegExp, label: string): string {
  const matched = pattern.exec(source)
  if (!matched) throw new Error(`未能从源码中解析出 ${label}`)
  return matched[1]!
}

/**
 * 只保留可执行代码行（滤掉 `//` `*` `/*` 起始的注释行）。
 *
 * 用于「旧形态不得复辟」类断言：文件里保留了叙述该缺陷的注释，
 * 注释提及旧常量名是合理且有益的，不该被当成违规。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/**
 * `callManagementRpc` 的通道接线测试。
 *
 * ## 为什么这条必须有测试
 *
 * 本函数曾把宿主端点名硬编码成模块内常量（`const ENDPOINT = 'account-hub'`），
 * 形参 `channel` 只出现在 JSDoc 里、从未被读取 —— 一个假参数。后果是：
 * 客户端通道常量（`ACCOUNT_HUB_RPC_CHANNEL`，由 `plugin-src/client/index.js`
 * 传进来）与宿主端点名（`src/account-hub-rpc.ts` 的 `ACCOUNT_HUB_ENDPOINT`）
 * 各自独立声明，改一处另一处静默漂移，且**没有任何断言会红**。
 *
 * 因此这里不满足于「第二实参等于 'account-hub'」（那对硬编码同样成立），
 * 关键用例是**换一个 channel，endpoint 必须跟着换** —— 只有真的读了形参才能通过。
 */

/** 最小 connection 替身：只暴露本函数用到的 rpc.call。 */
function fakeConnection() {
  const call = vi.fn(() => Promise.resolve({ ok: true, value: 'ok' }))
  return { connection: { rpc: { call } }, call }
}

describe('callManagementRpc（通道形参 → RPC endpoint 派生）', () => {
  it("channel '/account-hub' 派生 endpoint 'account-hub'，mountPoint 固定 '/api'", async () => {
    const { connection, call } = fakeConnection()
    await callManagementRpc(connection, '/account-hub', 'account.list', { provider: 'buddy-cn' })
    expect(call).toHaveBeenCalledTimes(1)
    const [mountPoint, endpoint, payload, signal] = call.mock.calls[0] as unknown[]
    expect(mountPoint).toBe('/api')
    expect(endpoint).toBe('account-hub')
    expect(payload).toEqual({ method: 'account.list', payload: { provider: 'buddy-cn' } })
    expect(signal).toBeUndefined()
  })

  it('endpoint 真的来自 channel：换 channel 则 endpoint 跟着换（硬编码常量会在这里现形）', async () => {
    const { connection, call } = fakeConnection()
    await callManagementRpc(connection, '/another-hub', 'account.list', {})
    expect(call.mock.calls[0]?.[0]).toBe('/api')
    expect(call.mock.calls[0]?.[1]).toBe('another-hub')
  })

  it('剥的是前导斜杠而非固定 slice(1)：无前导斜杠的 channel 也原样可用', async () => {
    const { connection, call } = fakeConnection()
    await callManagementRpc(connection, 'account-hub', 'account.list', {})
    // 若实现写成 channel.slice(1)，这里会得到 'ccount-hub'。
    expect(call.mock.calls[0]?.[1]).toBe('account-hub')
  })

  it('只剥一个前导斜杠，内层斜杠不受影响', async () => {
    const { connection, call } = fakeConnection()
    await callManagementRpc(connection, '/a/b', 'm', {})
    expect(call.mock.calls[0]?.[1]).toBe('a/b')
  })

  it('signal 原样透传给 rpc.call（第四实参）', async () => {
    const { connection, call } = fakeConnection()
    const controller = new AbortController()
    await callManagementRpc(connection, '/account-hub', 'm', {}, controller.signal)
    expect(call.mock.calls[0]?.[3]).toBe(controller.signal)
  })

  it('rpc.call 的返回值原样返回（解包归 unwrapRpcResult 负责）', async () => {
    const { connection } = fakeConnection()
    const result = await callManagementRpc(connection, '/account-hub', 'm', {})
    expect(result).toEqual({ ok: true, value: 'ok' })
  })
})

/**
 * 跨文件一致性锁：客户端通道名 ↔ 宿主端点名 ↔ 宿主 API 路径。
 *
 * 让 `channel` 形参真正被读取只解决了**一半**问题：endpoint 现在跟着 channel 走，
 * 但 channel 自身的**取值**（`plugin-src/client/account-hub.js` 的
 * `ACCOUNT_HUB_RPC_CHANNEL`）与宿主端点名（`src/account-hub-rpc.ts` 的
 * `ACCOUNT_HUB_ENDPOINT`）仍是两处独立声明 —— 改一处另一处照旧静默漂移，
 * 运行时表现为「RPC 打空 / 面板全空」，没有任何构建或类型闸门会拦。
 *
 * 三个值本是同一事实（`/api` + `account-hub`），故在此用相等断言钉在一起。
 * 读源码而非 import：客户端源码是 esbuild 专用 ESM（顶层 import `react` 与
 * `@deepseek-ai/dsh-client-ui-primitives`，二者都不在依赖里），宿主的
 * `ACCOUNT_HUB_ENDPOINT` 是模块私有常量未导出。做法与
 * `credits-capabilities.spec.ts` 锁宿主/客户端 provider 集合一致。
 */
describe('通道常量跨文件一致（客户端 ↔ 宿主，防静默漂移）', () => {
  const clientSource = readSource('../../plugin-src/client/account-hub.js')
  const hostSource = readSource('../../src/account-hub-rpc.ts')

  /** 客户端通道常量（`'/account-hub'`）。 */
  const clientChannel = readConst(
    clientSource,
    /export const ACCOUNT_HUB_RPC_CHANNEL = '([^']+)'/,
    'ACCOUNT_HUB_RPC_CHANNEL',
  )
  /** 宿主端点名（`'account-hub'`）。 */
  const hostEndpoint = readConst(
    hostSource,
    /const ACCOUNT_HUB_ENDPOINT = '([^']+)'/,
    'ACCOUNT_HUB_ENDPOINT',
  )
  /** 宿主注册路径（`'/api/account-hub'`）。 */
  const hostApiPath = readConst(
    hostSource,
    /export const ACCOUNT_HUB_API_PATH = '([^']+)'/,
    'ACCOUNT_HUB_API_PATH',
  )

  it('客户端 channel 去掉前导斜杠后，与宿主 ACCOUNT_HUB_ENDPOINT 逐字符相同', () => {
    expect(clientChannel.startsWith('/')).toBe(true)
    expect(clientChannel.replace(/^\//, '')).toBe(hostEndpoint)
    // 值本身也钉住：三方一起改名时这条会提醒「确认过宿主注册了吗」。
    expect(hostEndpoint).toBe('account-hub')
  })

  it('宿主注册路径等于 /api/ 加端点名（注册路径与端点名同源）', () => {
    expect(hostApiPath).toBe(`/api/${hostEndpoint}`)
  })

  it('客户端 channel 与宿主注册路径同构：/api + channel（端到端三点对齐）', () => {
    // 把「客户端发出的通道」直接对到「宿主注册的路径」，
    // 中间任何一环改名都会在此现形；也锁住单段路径形态 ——
    // 派生只剥前导斜杠，宿主若改成 /api/v2/account-hub，两边不再同构。
    expect(hostApiPath).toMatch(/^\/api\/[^/]+$/)
    expect(hostApiPath).toBe(`/api${clientChannel}`)
  })

  it('客户端调用链把该常量真的传给了 callManagementRpc（否则锁的是死常量）', () => {
    const entry = readSource('../../plugin-src/client/index.js')
    expect(entry).toContain('ACCOUNT_HUB_RPC_CHANNEL')
    expect(entry).toContain('callManagementRpc(ctx.connection, ACCOUNT_HUB_RPC_CHANNEL')
  })

  it('反面：management-rpc.mjs 不再持有端点名常量 —— 假参数不得复辟', () => {
    const code = codeOnly(readSource('../../plugin-src/management-rpc.mjs'))
    // 硬编码端点名常量一旦回归，channel 形参就会重新变成摆设。
    expect(code).not.toMatch(/\bconst\s+ENDPOINT\b/)
    expect(code).not.toContain("'account-hub'")
    // endpoint 必须由 channel 派生（形参真的被读）。
    expect(code).toContain("channel.replace(/^\\//, '')")
  })
})

describe('unwrapRpcResult（RPC 响应解包）', () => {
  it('ok=true 返回 value', () => {
    expect(unwrapRpcResult({ ok: true, value: { accounts: [] } })).toEqual({ accounts: [] })
  })

  it('ok=false 抛出带 code 的 Error', () => {
    expect(() => unwrapRpcResult({ ok: false, error: { code: 'E_BOOM', message: '炸了' } }))
      .toThrowError('炸了')
    try {
      unwrapRpcResult({ ok: false, error: { code: 'E_BOOM', message: '炸了' } })
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('E_BOOM')
    }
  })

  it('非 {ok} 形态原样返回', () => {
    expect(unwrapRpcResult('raw')).toBe('raw')
  })
})