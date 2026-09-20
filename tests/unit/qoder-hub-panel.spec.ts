/**
 * Account Hub 的 **Qoder 面板**（PAT 粘贴式登录）回归测试。
 *
 * ## 这个面板与众不同的地方
 *
 * 其余六个 provider 的「+ 新建账号」都是**浏览器登录**（两段式：宿主先回
 * `loginUrl`、客户端在同一用户手势里开窗、再轮询 `login.poll`）。Qoder 没有
 * 浏览器登录协议 —— 用户要做的只有「去官方 Integrations 页面签发一个 PAT、
 * 复制、粘回来」。于是存在三处**静默失效**，都不会报错、只会「看着不对」：
 *
 * 1. **载荷写错键名**：`account.create` 发的若不是 `{ provider, pat }`，宿主只会
 *    回一个 bad-request，而按钮看上去是「点了没反应」；
 * 2. **两条建号路径被揉在一起**：PAT 形态若走进 `createAccount()`，会先开一个
 *    空白登录窗、再发一个**不含 `pat`** 的 `account.create` —— 浏览器里多一张
 *    白页，后端必然拒绝，而用户只看到「登录失败」；
 * 3. **散落的 `provider === 'qoder'`**：将来漏改一处，表现就是「按钮还在、
 *    点了报 unknown provider」。
 *
 * 本文件用两种手法分别守住它们：**可执行逻辑**（A/B/C/D 组）直接驱动真实代码，
 * **面板接线**（E 组）用源码切片断言 —— `ProviderPanel` 用了 hooks，而 react 不在
 * 本仓库依赖里，加载不了（见 `tests/unit/jet-hub-credit-balance-row.spec.ts` 的
 * 文件头说明）。
 *
 * ## 为什么 Qoder 不需要 `poolProviderFor` 映射
 *
 * Trae CN Work 是本插件里唯一「面板 id ≠ 账号池键」的 provider
 * （见 `tests/unit/trae-cn-work-hub-panel.spec.ts`）。Qoder 是**恒等映射**：
 * 面板 id、账号池键、凭据 ref 前缀、模型黑名单键全是 `qoder` 这一个字符串。
 * 故 A 组的断言是「映射函数对 qoder **原样返回**」，而不是「映射到了别处」——
 * 与 Trae CN Work 那组正好互为反例（Trae CN Work 的映射必须**不**回到自己）。
 *
 * ## 刻意**不**断言的两件事
 *
 * `account.create` 对 qoder **返回什么**、`credits.balances` 对 qoder 返回什么，
 * 本文件一概不碰：宿主侧这两个分支属于后续接入步骤，此刻它们仍会回
 * `unknown provider: qoder`。断言它们等于把测试钉死在半成品状态上，等那一步
 * 落地时又会莫名其妙地红。这里只锁**客户端**契约：载荷形状、判别联合、
 * 渲染树、面板接线。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  accountCredentialRefName,
  poolProviderFor,
  registerJetHubRpc,
} from '../../src/jet-hub-rpc.js'
import { QODER, QODER_PAT_URL as HOST_QODER_PAT_URL } from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 一个最小 react 占位模块：把参数收成可深比较的普通对象。 */
const REACT_STUB = `
'use strict';
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
};
`

/** 能力矩阵占位（`PatLoginForm` 不消费它，见 D 组说明）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/**
 * 插件源码是纯 ESM；这里把它的两条 import 与 export 改写成 CJS 形态后加载。
 *
 * 改写**逐条断言命中** —— 若哪天 `jet-hub.js` 的 import 形态变了，这里会立刻
 * 报错，而不是静默加载出一个缺了模块的半成品（那种失败会伪装成「组件返回
 * undefined」或「rpcCall 未定义」）。
 */
const IMPORT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^import \* as React from 'react';$/m, "const React = require('react');"],
  [
    /^import \{ supportsCreditBalance, supportsDailyCheckin \} from '\.\/credits-capabilities\.js';$/m,
    "const { supportsCreditBalance, supportsDailyCheckin } = require('./credits-capabilities.js');",
  ],
]

function toCjs(source: string): string {
  let out = source
  for (const [pattern, replacement] of IMPORT_REWRITES) {
    if (!pattern.test(out)) {
      throw new Error(`jet-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  // `export function` / `export const` → 普通声明（模块作用域内仍互相可见）。
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  // 暴露本次要测的符号。它们都是模块作用域的声明，故此处必然可见。
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' providerPatLogin: providerPatLogin,'
    + ' normalizePatInput: normalizePatInput,'
    + ' createAccountWithPat: createAccountWithPat,'
    + ' PatLoginForm: PatLoginForm,'
    + ' QODER_PAT_URL: QODER_PAT_URL };\n',
  )
}

function loadClientModule(): Record<string, unknown> {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'jet-hub-qoder-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeFileSync(join(dir, 'jet-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'jet-hub.js')) as { __testExports: Record<string, unknown> }
  tempDir = dir
  return loaded.__testExports
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

const {
  providerPatLogin,
  normalizePatInput,
  createAccountWithPat,
  PatLoginForm,
  QODER_PAT_URL,
} = loadClientModule() as {
  providerPatLogin: (provider: string) => { patUrl: string } | null
  normalizePatInput: (raw: unknown) => string
  createAccountWithPat: (options: {
    provider: string
    pat: string
    rpcCall: (method: string, payload: Record<string, unknown>) => Promise<unknown>
    sleep?: (ms: number) => Promise<void>
    attempts?: number
    intervalMs?: number
  }) => Promise<Record<string, unknown>>
  PatLoginForm: (props: Record<string, unknown>) => TreeNode
  QODER_PAT_URL: string
}

/** `createElement` 占位的产物形态。 */
interface TreeNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * 按 **react 的真实语义**取子元素：丢弃 `null` / `undefined`（组件用
 * 「条件 ? 元素 : null」表达可选片段），并展开嵌套数组。
 *
 * 占位 `createElement` 只是把实参原样收下，不做这两件事；不按 react 语义归一
 * 会把「可选片段没渲染」误读成一个空段。
 */
function childrenOf(node: TreeNode): unknown[] {
  const out: unknown[] = []
  for (const child of node.children ?? []) {
    if (child === null || child === undefined) continue
    if (Array.isArray(child)) {
      out.push(...child.filter((item) => item !== null && item !== undefined))
    } else {
      out.push(child)
    }
  }
  return out
}

/** D 组关心的节点属性（其余属性如事件回调不进快照，否则深比较毫无意义）。 */
const SNAPSHOT_PROPS = [
  'className', 'data-tone', 'role', 'href', 'target', 'rel',
  'type', 'placeholder', 'value', 'disabled', 'data-kind',
] as const

/** 把一个节点渲染成「结构快照」：只保留 type / 关键 props / 文本，便于深比较。 */
function snapshot(node: unknown): unknown {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as TreeNode
  const kept: Record<string, unknown> = {}
  for (const key of SNAPSHOT_PROPS) {
    if (element.props[key] !== undefined) kept[key] = element.props[key]
  }
  return { type: element.type, props: kept, children: childrenOf(element).map(snapshot) }
}

/** 子树里全部可见文本（按渲染顺序展平）。 */
function textOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined) return []
  return childrenOf(node as TreeNode).flatMap(textOf)
}

/** 深度优先找出所有满足条件的节点（用于「必须恰好有一个原生 <a>」这类断言）。 */
function findAll(node: unknown, predicate: (element: TreeNode) => boolean): TreeNode[] {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return []
  const element = node as TreeNode
  const out = predicate(element) ? [element] : []
  for (const child of childrenOf(element)) out.push(...findAll(child, predicate))
  return out
}

/** 客户端 bundle 的源码（未打包的 plugin-src 版本），归一化 CRLF。 */
function readClientSourceNormalized(): string {
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 去掉**整行**注释后的正文。
 *
 * E 组有几条断言查的是「正文里不得出现某段代码」，而文件里保留了大量叙述历史
 * 缺陷的注释（本仓库的注释风格本就如此）—— 不剥注释会把「注释里解释过这件事」
 * 误判成「代码里又写了一遍」。
 */
function codeLinesOf(source: string): string {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 真实 RPC 分派：面板 id 就是池键，qoder 不需要任何映射
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 ctx / pool 替身并注册端点，返回一个 `call(method, payload)`。
 *
 * 照 `tests/unit/trae-cn-work-hub-panel.spec.ts` 的 `makeHarness` 手法：驱动
 * `registerJetHubRpc` 注册出来的**真实 HTTP 处理器**，而不是断言源码里出现过
 * 某个字符串 —— 前者能证明「分派真的走对了」，后者只能证明「提到过」。
 */
function makeHarness(accounts: ProviderAccountEntry[]) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  /** `account.list` 实际拿去查池的 provider。 */
  const listAccountsCalls: string[] = []
  /** `model.list` 透传给 `ctx.llm` 的 provider。 */
  const listModelsCalls: string[] = []
  /** 黑名单**读取**用的 provider 键。 */
  const listDisabledCalls: string[] = []
  const setModelDisabledCalls: Array<{ provider: string; modelId: string; disabled: boolean }> = []

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
    // `model.list` 走 `ctx.get('llm')`，返回适配器播报的目录。
    get: (name: string) => name === 'llm'
      ? {
          listModels: async (provider: string) => {
            listModelsCalls.push(provider)
            return [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }]
          },
        }
      : undefined,
  }

  const pool = {
    listAccounts: async (provider: string) => {
      listAccountsCalls.push(provider)
      return accounts.filter((a) => a.provider === provider)
    },
    // 返回一个**总是为空**的黑名单：`model.list` 会把「在黑名单里却不在这份
    // 目录里」的模型补回列表，替身若造假键，目录里就会凭空多出一项。
    listDisabledModels: (provider: string) => {
      listDisabledCalls.push(provider)
      return {}
    },
    setModelDisabled: async (provider: string, modelId: string, disabled: boolean) => {
      setModelDisabledCalls.push({ provider, modelId, disabled })
    },
  }

  registerJetHubRpc(
    ctx as never,
    pool as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // qoder / qoderCn：本文件只断 `account.list` / `model.*` / `poolProviderFor`
    // 的分派（不建号、不查余额），两条 Qoder 分支都不会被进入。
    {} as never,
    {} as never,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  return {
    listAccountsCalls,
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

/** 一个 provider 为 `qoder` 的账号条目。 */
function qoderEntry(id: string, enabled = true): ProviderAccountEntry {
  return {
    id,
    provider: 'qoder',
    nickname: id,
    enabled,
    credentialRef: `QODER_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 1,
    refreshable: true,
  }
}

describe('poolProviderFor：qoder 是恒等映射（与 trae-cn-work 互为反例）', () => {
  it('qoder 原样返回', () => {
    // Qoder 的面板 id、账号池键、凭据 ref 前缀、模型黑名单键**全是同一个字符串**。
    // 这条断言看似废话，它的价值在于：一旦将来有人把 Qoder 接进某个共享账号池，
    // 必须同时改这里与宿主的分派，而那时这条会立刻变红提醒他确认「是不是也该
    // 像 trae-cn-work 那样登记 poolProviderId」。
    expect(poolProviderFor('qoder')).toBe('qoder')
    expect(poolProviderFor(QODER.id)).toBe('qoder')
  })

  it('反例锚点：trae-cn-work **必须**映射到别处（本插件唯一的非恒等映射）', () => {
    // 这两条断言放在一起，是为了让「恒等」这个词有对照物：
    // 若有人把 poolProviderFor 改成恒返回入参（或删掉映射），上面那条依然绿，
    // 而这条会红 —— 那正是「面板空白」这个真实故障的形态。
    expect(poolProviderFor('trae-cn-work')).not.toBe('trae-cn-work')
    expect(poolProviderFor('trae-cn-work')).toBe('trae-cn')
    // 其余 provider（含未登记的）一律原样返回。
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'mystery']) {
      expect(poolProviderFor(provider), provider).toBe(provider)
    }
  })
})

describe('Qoder 面板的 RPC 分派（qoder 一路原样透传）', () => {
  it('account.list 按 `qoder` 查池，账号条目拿得到', async () => {
    const h = makeHarness([qoderEntry('qoder-1'), qoderEntry('qoder-2', false)])
    const result = await h.call('account.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as { accounts: ProviderAccountEntry[] }
    expect(value.accounts.map((a) => a.id)).toEqual(['qoder-1', 'qoder-2'])
    // 池确实按 `qoder` 查的 —— 若哪天有人给它加了映射，账号会一个都查不到，
    // 而端点的 ok 仍是 true（面板只是「尚未配置账号」）。
    expect(h.listAccountsCalls).toEqual(['qoder'])
  })

  it('model.list 把 `qoder` 原样透传给 ctx.llm（黑名单键就是这个 id）', async () => {
    const h = makeHarness([qoderEntry('qoder-1')])
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    // 适配器由 `registerQoderLlm` 按 `qoder` 注册；映射到别处会列出别的
    // provider 的目录，与 Qoder 实际可选的模型完全对不上。
    expect(h.listModelsCalls).toEqual(['qoder'])
    // 黑名单也按同一个键读：模型与开关必须同源，否则开关会「点了没反应」。
    expect(h.listDisabledCalls).toEqual(['qoder'])
    const value = result.value as { models: Array<{ id: string; disabled: boolean }> }
    expect(value.models).toEqual([{ id: 'qwen3-coder', name: 'Qwen3 Coder', disabled: false }])
  })

  it('model.setDisabled 写入 `qoder` 键', async () => {
    const h = makeHarness([qoderEntry('qoder-1')])
    const result = await h.call('model.setDisabled', {
      provider: 'qoder', modelId: 'qwen3-coder', disabled: true,
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.setModelDisabledCalls).toEqual([
      { provider: 'qoder', modelId: 'qwen3-coder', disabled: true },
    ])
  })
})

describe('Qoder 的账号凭据 ref 前缀', () => {
  it('accountCredentialRefName 产出 QODER_ACCOUNT_xxx，且被真实的 credentialRef() 接受', () => {
    const name = accountCredentialRefName('qoder', 'A1B2C3D4')
    expect(name).toBe('QODER_ACCOUNT_A1B2C3D4')
    // 不抛 TypeError 才是关键：ref 一旦非法，凭据**从未落盘**，账号池里会留下
    // 一个永远没有凭据的幽灵条目（见 src/jet-hub-rpc.ts 的后果链说明）。
    // Qoder 无连字符，归一化前后逐字符相同，故既有形态无需迁移。
    expect(() => credentialRef(name)).not.toThrow()
  })

  it('与宿主 src/qoder-product.ts 的 accountCredentialRefPrefix 逐字符一致', () => {
    // 两处漂移的后果是「凭据写到一个名字、读的时候找另一个名字」——
    // 账号建得出来，但下一次请求就报「请先登录」。
    expect(accountCredentialRefName('qoder', 'A1B2C3D4'))
      .toBe(`${QODER.accountCredentialRefPrefix}_A1B2C3D4`)
    expect(QODER.accountCredentialRefPrefix).toBe('QODER_ACCOUNT')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A'. PAT 登录注册表：provider → 登录形态的唯一查表入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这一组单列（而不是并进 A 组）是因为它答的是**另一个问题**：
 * A 组问「账号查谁的池」，本组问「这个面板的登录入口长什么样」。
 * 面板里**不得**出现 `provider === 'qoder'` 这类散落比较，一切经
 * `providerPatLogin()`；散落条件的失效形态是「按钮还在，点了报 unknown provider」。
 *
 * `PROVIDERS` 条目里 qoder **没有** `loginHint`（有的话 `canCreateAccount` 会变成
 * false，PAT 表单的唯一入口整块消失）—— 那条由
 * `tests/unit/credits-capabilities.spec.ts` 守着，本文件不重复。
 */
describe('providerPatLogin：PAT 形态的查表入口', () => {
  it('qoder 返回带 patUrl 的元数据，其余 provider 一律 null（= 浏览器登录）', () => {
    expect(providerPatLogin('qoder')).toEqual({ patUrl: QODER_PAT_URL })
    // 默认方向是「浏览器登录」：将来新增 provider 忘记登记时，最坏结果是多出一个
    // 本来就用得上的浏览器登录入口，而不是把一个能登录的面板变成没有入口的死面板。
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'trae-cn-work']) {
      expect(providerPatLogin(provider), provider).toBeNull()
    }
  })

  it('用 hasOwnProperty 查表：原型链上的键一律回 null，不误判成 PAT 形态', () => {
    // 直接下标时 `PAT_LOGIN_PROVIDERS['__proto__']` 会命中 Object.prototype
    // （**真值**），于是一个叫 `__proto__` 的 provider 会被误判成 PAT 形态，
    // 面板就会渲染出一个 `patUrl: undefined` 的表单。
    for (const provider of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(providerPatLogin(provider), provider).toBeNull()
    }
    // 顺带锁死空串与大小写变体（`QODER` 不是合法 id）。
    for (const provider of ['', 'QODER', 'qoder2']) {
      expect(providerPatLogin(provider), provider).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. createAccountWithPat：载荷正确发出 + 判别联合正确
// ─────────────────────────────────────────────────────────────────────────────

/** 不记录、不等待的假 sleep（轮询瞬时完成）。 */
const noopSleep = async (): Promise<void> => {}

interface RpcStub {
  calls: Array<[string, Record<string, unknown>]>
  rpcCall: (method: string, payload: Record<string, unknown>) => Promise<unknown>
}

/**
 * 桩 `rpcCall`：记录每一次调用的完整载荷。
 *
 * `polls` 是**顺序**应答的队列 —— 队列比调用次数短时后续返回 undefined，
 * 于是「轮询次数超出预期」会以 undefined 的形式暴露，而不是静默通过。
 */
function makeRpcStub(options: {
  create?: unknown
  createError?: Error
  polls?: unknown[]
}): RpcStub {
  const calls: Array<[string, Record<string, unknown>]> = []
  let pollIndex = 0
  const rpcCall = async (method: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push([method, payload])
    if (method === 'account.create') {
      if (options.createError !== undefined) throw options.createError
      return options.create
    }
    const answer = (options.polls ?? [])[pollIndex]
    pollIndex += 1
    return answer
  }
  return { calls, rpcCall }
}

/** 只挑出 `login.poll` 那几次调用。 */
function pollCalls(calls: RpcStub['calls']): Array<[string, Record<string, unknown>]> {
  return calls.filter(([method]) => method === 'login.poll')
}

describe('createAccountWithPat 的载荷形状（核心契约）', () => {
  it('第一次调用是 account.create，载荷逐字等于 { provider, pat }', async () => {
    const stub = makeRpcStub({ create: { accountId: 'qoder-1' }, polls: [{ done: true }] })
    const outcome = await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    expect(outcome).toEqual({ kind: 'created', accountId: 'qoder-1' })

    const first = stub.calls[0]!
    expect(first[0]).toBe('account.create')
    // **深比较整个 payload 对象**，而不是 toHaveBeenCalledWith 的松散形态：
    // 这样多一个字段（比如有人顺手加了 loginUrl）也会立刻红。
    expect(first[1]).toEqual({ provider: 'qoder', pat: 'pt-abc' })
    // toEqual 会忽略值为 undefined 的多余键，故再钉一次**键集合本身**。
    expect(Object.keys(first[1]!)).toEqual(['provider', 'pat'])
  })

  it('载荷里**不带** loginUrl（PAT 不是两段式，混进浏览器登录那套就会多开一个空窗）', async () => {
    const stub = makeRpcStub({ create: { accountId: 'qoder-1' }, polls: [{ done: true }] })
    await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    const payload = stub.calls[0]![1]!
    expect(payload).not.toHaveProperty('loginUrl')
    expect(payload).not.toHaveProperty('state')
    // 浏览器登录那套的字段名一个都不该出现（复制粘贴过来的典型残留）。
    expect(Object.keys(payload).sort()).not.toContain('loginUrl')
    // 建号只发一次：多出来的一次「补发」会让宿主建出两个占位账号。
    expect(stub.calls.filter(([method]) => method === 'account.create')).toHaveLength(1)
  })

  it('轮询用 login.poll + { accountId, provider }，provider 就是 qoder', async () => {
    const stub = makeRpcStub({ create: { accountId: 'qoder-9' }, polls: [{ done: true }] })
    await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    // 逐字深比较：provider 写成别的会让宿主按另一个 provider 去找账号，
    // 表现是「PAT 明明提交了，账号却一直不出现」。
    expect(stub.calls[1]).toEqual(['login.poll', { accountId: 'qoder-9', provider: 'qoder' }])
    expect(pollCalls(stub.calls)).toHaveLength(1)
  })

  it('空 pat 也照发：判空是 submitPat 的职责，本函数不重复判一次口径', async () => {
    // 客户端若在这里也判一次空，两处口径就会分叉：submitPat 给的是可读中文提示
    // （「请先粘贴 PAT。」），本函数只能给一个判别联合 —— 用户看到的提示会变成
    // 后者，而那条提示不会告诉他「去粘点什么」。
    const stub = makeRpcStub({ create: { accountId: 'qoder-1' }, polls: [{ done: true }] })
    await createAccountWithPat({
      provider: 'qoder', pat: '', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    expect(stub.calls[0]![1]).toEqual({ provider: 'qoder', pat: '' })
  })
})

describe('createAccountWithPat 的四种判别联合', () => {
  it('done:true 且无 error → created', async () => {
    const stub = makeRpcStub({ create: { accountId: 'qoder-1' }, polls: [{ done: true }] })
    const outcome = await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    expect(outcome).toEqual({ kind: 'created', accountId: 'qoder-1' })
  })

  it('done:true 带 error → failed，且**不再继续轮询**', async () => {
    const stub = makeRpcStub({
      create: { accountId: 'qoder-1' },
      // 第二个应答是哨兵：若实现失败后仍继续轮询，就会拿到 done:true 而变成 created。
      polls: [{ done: true, error: 'invalid personal token' }, { done: true }],
    })
    const outcome = await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    expect(outcome).toEqual({ kind: 'failed', accountId: 'qoder-1', error: 'invalid personal token' })
    // PAT 被拒是**确定性**失败，重试只是让用户多等 20 秒。
    expect(pollCalls(stub.calls)).toHaveLength(1)
  })

  it('一直 done:false → unconfirmed，login.poll 恰好调 attempts 次', async () => {
    const stub = makeRpcStub({
      create: { accountId: 'qoder-1' },
      // 第 4 个应答是哨兵：attempts 若被写死或改大，循环会拿到 done:true。
      polls: [{ done: false }, { done: false }, { done: false }, { done: true }],
    })
    const outcome = await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep, attempts: 3,
    })
    // 既不说成功也不说失败：宿主没在窗口内确认凭据可解析，但它可能稍后才落盘。
    expect(outcome).toEqual({ kind: 'unconfirmed', accountId: 'qoder-1' })
    expect(pollCalls(stub.calls)).toHaveLength(3)
    expect(pollCalls(stub.calls).map(([, payload]) => payload)).toEqual([
      { accountId: 'qoder-1', provider: 'qoder' },
      { accountId: 'qoder-1', provider: 'qoder' },
      { accountId: 'qoder-1', provider: 'qoder' },
    ])
  })

  it('默认轮询窗口是 40 次（20 秒）—— PAT 是即时请求，不是浏览器登录那 5 分钟', async () => {
    const stub = makeRpcStub({ create: { accountId: 'qoder-1' }, polls: [] })
    const outcome = await createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })
    expect(outcome).toEqual({ kind: 'unconfirmed', accountId: 'qoder-1' })
    // polls 队列为空 → 每次应答都是 undefined → done 恒不为 true。
    expect(pollCalls(stub.calls)).toHaveLength(40)
  })

  it('响应缺 accountId → incomplete，且**一次都不轮询**', async () => {
    // 这是「不浪费时间轮询」那条契约的可执行形式：没有 accountId 就连轮询的
    // 入参都没有，硬轮下去只会让按钮多转 20 秒再报一个更含糊的错。
    for (const create of [{}, { accountId: '' }, { accountId: null }, null, undefined]) {
      const stub = makeRpcStub({ create, polls: [{ done: true }] })
      const outcome = await createAccountWithPat({
        provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
      })
      expect(outcome, JSON.stringify(create)).toEqual({ kind: 'incomplete' })
      expect(pollCalls(stub.calls), JSON.stringify(create)).toHaveLength(0)
      // 整个调用序列只有那一次 account.create。
      expect(stub.calls, JSON.stringify(create)).toHaveLength(1)
    }
  })
})

describe('createAccountWithPat 不吞宿主错误', () => {
  it('rpcCall 抛错时原样抛出（宿主此刻回 unknown provider 是**预期**行为）', async () => {
    // 宿主侧 account.create 的 qoder 分支属于后续接入步骤，在它落地之前会回
    // `unknown provider: qoder`。客户端**不得**把它吞成一个「点了没反应」：
    // 吞掉之后用户拿不到任何原因，只会以为按钮坏了。
    const stub = makeRpcStub({
      createError: new Error('unknown provider: qoder'),
      polls: [{ done: true }],
    })
    await expect(createAccountWithPat({
      provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
    })).rejects.toThrow('unknown provider: qoder')
    // 抛错后不再轮询（没有 accountId，也无从轮询）。
    expect(pollCalls(stub.calls)).toHaveLength(0)
  })

  it('抛的是**同一个错误对象**，没有被包装成新 Error（判据是 toBe 而不是 toThrow）', async () => {
    // 重新 `new Error(...)` 会把宿主的 code / details 一起丢掉，客户端后续
    // 想按 `error.code` 分流（如 login-in-progress）就再也拿不到它。
    const failure = new Error('unknown provider: qoder')
    const stub = makeRpcStub({ createError: failure })
    let caught: unknown
    try {
      await createAccountWithPat({
        provider: 'qoder', pat: 'pt-abc', rpcCall: stub.rpcCall, sleep: noopSleep,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
  })
})

describe('createAccountWithPat 的轮询节拍', () => {
  it('每次轮询前都 sleep(intervalMs)，用的是传入的值而不是硬编码 500', async () => {
    const slept: number[] = []
    const stub = makeRpcStub({
      create: { accountId: 'qoder-1' },
      polls: [{ done: false }, { done: true }],
    })
    const outcome = await createAccountWithPat({
      provider: 'qoder',
      pat: 'pt-abc',
      rpcCall: stub.rpcCall,
      sleep: async (ms: number) => { slept.push(ms) },
      attempts: 2,
      // 可辨识的值：写死 500 的实现会立刻在下面现形。
      intervalMs: 7,
    })
    expect(outcome).toEqual({ kind: 'created', accountId: 'qoder-1' })
    // 第一次轮询**前**先等一个间隔：与浏览器登录的 setInterval 惯例一致，
    // 也避免在宿主还没写完凭据时白打一发。
    expect(slept).toEqual([7, 7])
    expect(slept).not.toContain(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. normalizePatInput 的边界：只削尾部换行，别的一律不动
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePatInput 只去尾部换行', () => {
  const TRIMMED: ReadonlyArray<readonly [string, string, string]> = [
    ['尾部单个 \\n', 'pt-abc\n', 'pt-abc'],
    ['尾部 \\r\\n', 'pt-abc\r\n', 'pt-abc'],
    ['尾部连续多个换行', 'pt-abc\n\n\n', 'pt-abc'],
    ['尾部混合 \\r 与 \\n', 'pt-abc\r\n\r\n', 'pt-abc'],
    ['尾部孤立 \\r', 'pt-abc\r', 'pt-abc'],
    ['全是换行 → 空串', '\n\n', ''],
    ['无换行时原样', 'pt-abc', 'pt-abc'],
    ['空串仍是空串', '', ''],
  ]

  it.each(TRIMMED)('%s', (_name, raw, expected) => {
    // 网页复制或终端 `cat` 出来的 PAT 常带一个（有时两个）尾部换行，而宿主是拿它
    // 当 exchange 的 body 与目录端点的 Bearer 用的 —— 带着 `\n` 会被服务端当成
    // 令牌正文的一部分。
    expect(normalizePatInput(raw)).toBe(expected)
  })

  const UNTOUCHED: ReadonlyArray<readonly [string, string, string]> = [
    ['开头空格不动（不 trim 开头）', ' pt-abc', ' pt-abc'],
    ['开头换行不动', '\npt-abc', '\npt-abc'],
    ['开头换行 + 尾部换行：只削尾部', '\npt-abc\n', '\npt-abc'],
    ['中间空格不动', 'pt-a b', 'pt-a b'],
    ['中间换行不动', 'pt-a\nb', 'pt-a\nb'],
    ['没有 pt- 前缀也原样返回', 'nope', 'nope'],
    ['看起来像别处的缩进也原样返回', '    pt-abc', '    pt-abc'],
  ]

  it.each(UNTOUCHED)('%s', (_name, raw, expected) => {
    // **刻意不做 trim()**：开头的空白往往是「粘错了东西」的信号（粘进了别处的
    // 缩进、粘了半截 YAML）。把它悄悄修好，用户只会在「我明明粘对了却报无效」
    // 里绕圈，不如原样送去让服务端明确拒绝。
    //
    // 同理**不做 `pt-` 前缀校验**：那是宿主侧 `isQoderPersonalToken` 的职责，
    // 客户端再判一次就是两处口径 —— 改了一处，另一处就静默失效。
    expect(normalizePatInput(raw)).toBe(expected)
  })

  it('返回值永远是 string（非字符串一律回空串，由调用方按「空」处理）', () => {
    for (const raw of [null, undefined, 123, {}, [], true, Number.NaN]) {
      const out = normalizePatInput(raw)
      expect(typeof out, String(raw)).toBe('string')
      expect(out, String(raw)).toBe('')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. PatLoginForm 的渲染（占位 react + 整树深比较）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本组**不消费能力矩阵**（占位 `credits-capabilities.js` 恒返回 true）：
 * 表单本身与「这个 provider 有没有积分能力」无关，混进来只会让两个文件的
 * 失败互相牵连 —— 能力矩阵的正确性由 `tests/unit/credits-capabilities.spec.ts` 守。
 */

/** 刻意与宿主常量**不同**：组件若写死 `QODER_PAT_URL` 而不是用 prop，下面立刻红。 */
const PAT_URL = 'https://qoder.example/pat'

function renderForm(overrides: Record<string, unknown> = {}): TreeNode {
  return PatLoginForm({
    patUrl: PAT_URL,
    value: '',
    busy: false,
    error: null,
    onChange: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...overrides,
  }) as TreeNode
}

describe('PatLoginForm 的整树结构', () => {
  it('内联展开：根节点是 div.dim-jh-patForm，不是 modal 覆盖层', () => {
    // Qoder 没有浏览器登录流程，用户要做的只有「复制一串字符、粘回来」，
    // 弹窗只会多一层关闭动作。故这里钉死根节点的类名与整棵树的形状 ——
    // 换成 `.dim-jh-modalOverlay` 那种结构会让这条立刻失败。
    expect(snapshot(renderForm())).toEqual({
      type: 'div',
      props: { className: 'dim-jh-patForm' },
      children: [
        {
          type: 'p',
          props: {},
          children: ['Qoder 不支持浏览器登录：请先在官方的 Integrations 页面签发一个 PAT（Personal Access Token），再把它粘贴到这里。'],
        },
        {
          type: 'p',
          props: {},
          children: [
            {
              type: 'a',
              props: { href: PAT_URL, target: '_blank', rel: 'noreferrer noopener' },
              children: ['打开 Qoder 的 Integrations 页面签发 PAT'],
            },
          ],
        },
        {
          type: 'div',
          props: { className: 'dim-jh-patField' },
          children: [
            {
              type: 'input',
              props: { type: 'password', value: '', placeholder: 'pt-…', disabled: false },
              children: [],
            },
          ],
        },
        {
          type: 'div',
          props: { className: 'dim-jh-patActions' },
          children: [
            {
              type: 'button',
              props: { className: 'dim-jh-btn', 'data-kind': 'primary', disabled: false },
              children: ['确认'],
            },
            { type: 'button', props: { className: 'dim-jh-btn', disabled: false }, children: ['取消'] },
          ],
        },
        {
          type: 'p',
          props: { className: 'dim-jh-patHint' },
          children: ['PAT 只保存在本地，用于换取短期 job token；面板不会把它发给任何第三方。'],
        },
      ],
    })
    expect(JSON.stringify(snapshot(renderForm()))).not.toContain('modalOverlay')
  })
})

describe('PatLoginForm 的签发链接必须是原生 <a href>', () => {
  it('全树恰好一个链接，href 就是传入的 patUrl', () => {
    // 「不新开浏览器标签、不由脚本开窗」这条契约就是它：原生 `<a>` 由浏览器
    // 自己处理导航，不受脚本开窗策略影响 —— 与 `manualLogin`（弹窗被拦截时的
    // 兜底链接）的做法一致。写成 `<button onClick={window.open}>` 会在这条红。
    const links = findAll(renderForm(), (element) => element.type === 'a')
    expect(links).toHaveLength(1)
    expect(links[0]!.props.href).toBe(PAT_URL)
  })

  it('链接带 target=_blank 与 noreferrer（新标签打开且不泄露来源页）', () => {
    const [link] = findAll(renderForm({ patUrl: 'https://other.example/pat' }), (e) => e.type === 'a')
    expect(link!.props.href).toBe('https://other.example/pat')
    expect(link!.props.target).toBe('_blank')
    expect(String(link!.props.rel)).toContain('noreferrer')
    // patUrl 完全由调用方透传：组件里写死地址会让 workspace 之外的部署指向旧页。
    expect(link!.props.href).not.toBe(HOST_QODER_PAT_URL)
  })
})

describe('PatLoginForm 的输入框与按钮', () => {
  it('输入框是 type=password 且 placeholder 为 pt-…', () => {
    // PAT 是**长期凭据**（官方明确不自动过期）：明文显示会让它出现在肩窥视野
    // 与随手截的屏里，比面板里任何别的字段都值钱。
    const [input] = findAll(renderForm(), (element) => element.type === 'input')
    expect(input!.props.type).toBe('password')
    expect(input!.props.placeholder).toBe('pt-…')
  })

  it('value 原样透传（受控输入，组件自己不持有状态）', () => {
    const [input] = findAll(renderForm({ value: 'pt-secret-123' }), (e) => e.type === 'input')
    expect(input!.props.value).toBe('pt-secret-123')
  })

  it('disabled 跟随 busy：busy 时输入框与两个按钮都禁用', () => {
    for (const busy of [true, false]) {
      const tree = renderForm({ busy })
      const [input] = findAll(tree, (e) => e.type === 'input')
      expect(input!.props.disabled, `busy=${String(busy)}`).toBe(busy)
      for (const button of findAll(tree, (e) => e.type === 'button')) {
        expect(button.props.disabled, `busy=${String(busy)}`).toBe(busy)
      }
    }
  })

  it('busy 时主按钮文案是「提交中…」，空闲时是「确认」', () => {
    const idle = findAll(renderForm({ busy: false }), (e) => e.type === 'button')
    expect(textOf(idle[0]!)).toEqual(['确认'])
    const busy = findAll(renderForm({ busy: true }), (e) => e.type === 'button')
    expect(textOf(busy[0]!)).toEqual(['提交中…'])
    // 取消按钮的文案不随 busy 变（它只是被禁用，含义仍是「取消」）。
    expect(textOf(busy[1]!)).toEqual(['取消'])
  })

  it('主按钮是 primary 形态（两个按钮的 class 相同、靠 data-kind 区分）', () => {
    const buttons = findAll(renderForm(), (e) => e.type === 'button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.props['data-kind']).toBe('primary')
    expect(buttons[1]!.props['data-kind']).toBeUndefined()
  })
})

describe('PatLoginForm 的错误块', () => {
  it('error 为空时不渲染任何错误节点', () => {
    for (const error of [null, undefined, '']) {
      const tree = renderForm({ error })
      // 整树只有 5 个子节点（说明段 / 链接段 / 输入段 / 按钮段 / 提示段），
      // 没有第 6 个错误块 —— 空错误留一个空壳会让用户以为出了什么事。
      expect(childrenOf(tree), String(error)).toHaveLength(5)
      expect(findAll(tree, (e) => e.props['data-tone'] !== undefined), String(error)).toHaveLength(0)
    }
  })

  it('error 非空时渲染 div.dim-jh-probeNotice + tone=error + role=alert，文本就是它', () => {
    // 复用既有的提示块样式而不是新造一套：同一个面板里两处提示长得不一样，
    // 只会让人以为是两类问题。
    const tree = renderForm({ error: 'PAT 无效或已过期' })
    const notices = findAll(tree, (e) => e.type === 'div' && e.props['data-tone'] === 'error')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.props.className).toBe('dim-jh-probeNotice')
    expect(notices[0]!.props.role).toBe('alert')
    // 文本原样透传（组件不加工宿主的原文）。
    expect(textOf(notices[0]!)).toEqual(['PAT 无效或已过期'])
    expect(childrenOf(tree)).toHaveLength(6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. 源码级回归（`ProviderPanel` 用了 hooks，单测渲染不了）
// ─────────────────────────────────────────────────────────────────────────────

describe('PAT 形态绝不走浏览器登录（源码级回归）', () => {
  const normalized = readClientSourceNormalized()

  it('「+ 新建账号」的 onClick 是三元表达式：真分支展开 PAT 表单，假分支才走 createAccount', () => {
    // 走错分支的后果是「点一下弹出一个空白登录窗，而后端收不到 pat 直接拒绝」——
    // 用户看到的是多了一张白页 + 一条含糊的失败提示。
    const start = normalized.indexOf('onClick: patLogin')
    expect(start, '找不到「+ 新建账号」的 onClick').toBeGreaterThan(-1)
    const slice = normalized.slice(start, start + 240)
    // 用**精确的多行形态**而不是模糊正则：两个分支的先后、缩进与调用形态都要对上。
    expect(slice).toMatch(
      /^onClick: patLogin\n\s*\? \(\) => \{ setPatOpen\(true\); setPatError\(null\); \}\n\s*: \(\) => void createAccount\(\),/,
    )
    // 再加一条**顺序**断言：即使将来改了措辞，PAT 分支也必须在浏览器登录分支之前
    // 出现（反过来写会把两件事对调，而正则一旦被人放宽就会静默通过）。
    const patBranch = slice.indexOf('setPatOpen(true)')
    const browserBranch = slice.indexOf('createAccount()')
    expect(patBranch).toBeGreaterThan(-1)
    expect(browserBranch).toBeGreaterThan(-1)
    expect(patBranch).toBeLessThan(browserBranch)
  })

  it('整个源码里 window.open 只有一次调用，且落在 createAccount（浏览器登录）里', () => {
    // 注释里提到 `window.open` 是合理的（文件里解释了为什么必须开空窗），
    // 故先剥掉整行注释再查 —— 判据是**调用**，不是子串。
    const code = codeLinesOf(normalized)
    const opens = [...code.matchAll(/\bwindow\.open\s*\(/g)]
    expect(opens).toHaveLength(1)
    const createAccountStart = code.indexOf('const createAccount = async () => {')
    expect(createAccountStart).toBeGreaterThan(-1)
    expect(opens[0]!.index!).toBeGreaterThan(createAccountStart)
  })

  it('createAccount 的函数体里不出现 pat —— 两条建号路径没有被揉在一起', () => {
    // 切片前先剥掉整行注释：两个函数之间**本该**有叙述 PAT 形态的文档注释，
    // 不剥的话这条断言只能被删掉（而它正是本次要守的东西）。
    const code = codeLinesOf(normalized)
    const start = code.indexOf('const createAccount = async () => {')
    const end = code.indexOf('const submitPat = async () => {')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = code.slice(start, end)
    // 一旦 createAccount 里出现 pat，说明有人把「浏览器登录」与「粘贴 PAT」
    // 揉成了一条路径 —— 那正是「点一下弹出空白登录窗」的成因。
    expect(body).not.toMatch(/pat/i)
    // 反面锚点：切片必须真的覆盖到 submitPat（它**确实**用了 pat）。没有这条，
    // 上面那句在切片意外切空时也是绿的。
    const toggleStart = code.indexOf('const toggleAccount = async (accountId, enabled) => {')
    expect(toggleStart).toBeGreaterThan(end)
    expect(code.slice(end, toggleStart)).toMatch(/\bpat\b/)
  })
})

describe('PAT 表单的渲染受 patOpen 与 patLogin 双重门控', () => {
  const normalized = readClientSourceNormalized()

  it('判据是 `patOpen && patLogin`，不是只看 patOpen', () => {
    // 只判 `patOpen` 会让一个**非 PAT 形态**的 provider 在 patOpen 为真时误渲染
    // 表单 —— 那时 `patLogin.patUrl` 是 undefined，链接指向 undefined，
    // 而节点照样渲染出来，不报任何错。
    expect(normalized).toMatch(
      /patOpen && patLogin\n\s*\? React\.createElement\(PatLoginForm, \{\n\s*patUrl: patLogin\.patUrl,/,
    )
    // 反向：不得存在只判 patOpen 的形态。
    expect(normalized).not.toMatch(/patOpen\n\s*\? React\.createElement\(PatLoginForm/)
  })
})

describe('客户端 QODER_PAT_URL 与宿主同值（跨侧副本）', () => {
  const normalized = readClientSourceNormalized()

  it('两处字面量逐字相等', () => {
    // 客户端 bundle 不能 import 宿主 TS（一侧是 esbuild 打包的浏览器代码、
    // 一侧是 tsc 编译的 Node 代码），故这里是**副本**。副本的风险是「改了宿主、
    // 忘了客户端」：表现只是面板上的链接指向一个旧地址（用户点过去 404），
    // **不报任何错**，故必须有单测钉死。
    const matched = /const QODER_PAT_URL = '([^']*)';/.exec(normalized)
    expect(matched, '客户端源码里找不到 QODER_PAT_URL 常量声明').not.toBeNull()
    expect(matched![1]).toBe(HOST_QODER_PAT_URL)
    // 运行时值也断言一次：源码字面量与加载出来的模块值若不一致，说明加载路径错了
    // （那时上面的断言仍然绿，而这条会红）。
    expect(QODER_PAT_URL).toBe(HOST_QODER_PAT_URL)
    // 查表入口拿到的就是这个常量，而不是另一份手抄的地址。
    expect(providerPatLogin('qoder')?.patUrl).toBe(HOST_QODER_PAT_URL)
  })
})

describe('能力矩阵驱动的积分行为在客户端不被 qoder 特判', () => {
  const normalized = readClientSourceNormalized()

  it('两处门控都取自能力矩阵函数，源码里没有第二份 provider 白名单', () => {
    // 能力矩阵是唯一真相源（见 plugin-src/client/credits-capabilities.js）。
    // Qoder 的 `dailyCheckin` 是 false（每日 100 Credits 只能在桌面 App 手动领），
    // 故面板不会渲染签到按钮 —— 那是矩阵的事，不是面板里再写一条 if。
    expect(normalized).toContain('const canLoadCredits = supportsCreditBalance(provider);')
    expect(normalized).toContain('const supportsCredits = supportsDailyCheckin(provider);')
    // 签到按钮按矩阵渲染。
    expect(normalized).toMatch(/supportsCredits\n\s*\? React\.createElement\('button'/)
  })

  it('credits.claimAll 与 credits.balances 的调用点邻域里没有 qoder 字面量', () => {
    // 这两条是「能力矩阵驱动、而非 provider 特判」的可执行形式：只要有人在
    // 调用点旁边加一句 `provider === 'qoder' ? … : …`，这条立刻红。
    //
    // 同样先剥整行注释：窗口取的是**调用点邻域**，紧邻的文档注释里提一句 qoder
    // （解释「Qoder 没有签到能力」是合理叙述）不该被判成违规。
    const code = codeLinesOf(normalized)
    for (const call of ["rpcCall('credits.claimAll'", "rpcCall('credits.balances'"]) {
      const at = code.indexOf(call)
      expect(at, call).toBeGreaterThan(-1)
      const around = code.slice(Math.max(0, at - 400), at + 400)
      expect(around, call).not.toContain('qoder')
    }
  })
})

describe('qoder 不作为比较表达式出现（判据是表达式，不是子串）', () => {
  const code = codeLinesOf(readClientSourceNormalized())

  it('正文里没有任何 === / !== 的 qoder 字面量比较', () => {
    // ⚠️ 判据必须是**比较表达式**而不是 `'qoder'` 这个子串：`PROVIDERS` 条目
    // （`id: 'qoder'`）、`PAT_LOGIN_PROVIDERS` 的键（`qoder: Object.freeze(…)`）、
    // 以及 `QODER_PAT_URL` 的 URL 里**本来就应该**出现它 —— 查子串会把这三处
    // 全部误判成违规，于是这条断言只能被删掉，也就什么都守不住了。
    const COMPARISONS: ReadonlyArray<RegExp> = [
      /===\s*'qoder'/, /!==\s*'qoder'/, /===\s*"qoder"/, /!==\s*"qoder"/,
      /'qoder'\s*===/, /'qoder'\s*!==/, /"qoder"\s*===/, /"qoder"\s*!==/,
    ]
    for (const pattern of COMPARISONS) {
      expect(code, String(pattern)).not.toMatch(pattern)
    }
  })

  it('反过来，qoder 子串确实出现在条目 / 表键 / URL 常量里（所以判据只能是表达式）', () => {
    expect(code).toContain("id: 'qoder'")
    expect(code).toContain('qoder: Object.freeze({ patUrl: QODER_PAT_URL })')
    expect(code).toContain("const QODER_PAT_URL = 'https://qoder.com/account/integrations';")
    expect(code).toMatch(/qoder/)
  })
})
