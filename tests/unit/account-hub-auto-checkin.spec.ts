/**
 * Account Hub「进入页面自动签到」的**挂载时序**回归测试。
 *
 * ## 守的是什么缺陷
 *
 * 真机报障：**首次进账号中心时该签的没签（一声不响），退出重进才签成功**。
 *
 * 面板挂载时并发发起两条 RPC：`account.list`（`loadAccounts`）与
 * `credits.checkinStatus`（`loadCheckinStatus`）。自动补签的触发 effect 依赖
 * `[checkinStatusLoaded, accounts]`，而 `autoCheckinOnEntry` 的判据是
 * **「accounts 引用非空」**—— 于是当**签到状态先回、账号列表后回**时，那次
 * effect 跑在一个「状态已就绪但账号还是空数组」的渲染里：
 *
 * - 它 `return`，且**不置** `autoCheckinRanRef`（本意是「等账号就绪再补判」）；
 * - 「账号就绪」这件事**只由 `accounts` 这个依赖的引用变化来表达**。
 *
 * 把「账号是否就绪」编码成「一个数组的引用」是这次缺陷的根：只要那一轮渲染里
 * 账号不可用（空列表 / 拉取失败 / 与状态落地同批次），本次挂载就**再也没有**
 * 补签的机会，而界面看起来一切正常（头部按钮只是停在「一键签到」）—— 正是
 * 「静默失败、重进才成功」的形态。
 *
 * 修法是把就绪判据换成**显式的完成信号**（`accountsLoaded`），并在两个信号都
 * 就绪后补发一次。本文件用**真渲染**（带 hooks 的 react 占位）驱动真实面板，
 * 按「RPC 谁先回」的两种顺序各跑一遍 —— 两种顺序都必须**恰好发出一发**
 * `checkin.perform`。
 *
 * ## 为什么必须真渲染
 *
 * 本仓库既有前端测试多为「读源码 + 正则断言」。本次的命题是**跨渲染轮次的
 * 状态机行为**（第 N 轮渲染不发、第 N+1 轮必须发），正则只能证明某个字符串被
 * 提到过，证明不了「哪一轮渲染真的发出了请求」。故这里沿用
 * `account-consumption-panel.spec.ts` / `qoder-hub-blank-screen.spec.ts` 的
 * 占位 react + 驱动器的路子，并且**由测试自己控制两条 RPC 的结算顺序**。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ui-primitives 是宿主的隐式 baseline（不在本仓库依赖里）：临时目录里必须补一个
// 替身文件，否则 require 会以 Cannot find module 让**整个文件**加载失败。
import { rewriteUiPrimitivesImport, writeUiPrimitivesStub } from './fixtures/ui-primitives-stub.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 带 hooks 的最小 react 占位。
 *
 * 与 `account-consumption-panel.spec.ts` 的同名占位同源，只多一个 `dirty` 标记：
 * 驱动器靠它判断「这一轮渲染有没有触发新的 setState」，从而**停在账号列表仍未
 * 结算的那一帧**（这正是本文件要复现的中间态；固定跑 N 轮会把它跳过去）。
 *
 * 三条与真实 react 对齐的语义（缺一条就会测出假结论）：
 * 1. hooks 槽位按组件实例隔离（`storeFor(fn)`），父子组件交错渲染不串味；
 * 2. 依赖数组真的比对（`Object.is` 逐项）：`ProviderPanel` 的挂载 effect 依赖
 *    `[provider]`，若无条件重跑会无限重发 `account.list`；
 * 3. cleanup 先于本次执行（`previousCleanup`）—— `mounted.current` 的语义全靠它。
 */
const REACT_STUB = `
'use strict';
var stores = new Map();
var current = null;
var effectQueue = [];
var dirty = false;

function depsEqual(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function storeFor(fn) {
  var store = stores.get(fn);
  if (!store) { store = { slots: [], cursor: 0 }; stores.set(fn, store); }
  return store;
}

exports.__renderComponent = function (fn, props) {
  var previous = current;
  var store = storeFor(fn);
  current = store;
  store.cursor = 0;
  try {
    return fn(props);
  } finally {
    current = previous;
  }
};

exports.__reset = function () { stores.clear(); effectQueue = []; dirty = false; };
exports.__isDirty = function () { return dirty; };
exports.__clearDirty = function () { dirty = false; };
exports.__drainEffects = function () {
  var queued = effectQueue;
  effectQueue = [];
  for (var i = 0; i < queued.length; i++) {
    if (typeof queued[i].previousCleanup === 'function') queued[i].previousCleanup();
    var result = queued[i].run();
    queued[i].slot.cleanup = typeof result === 'function' ? result : undefined;
  }
};

/**
 * 与真实 react 对齐：**同时**填 props.children 与 children 数组。
 *
 * 只填数组是旧版替身的一个保真度缺口：JSX 的多个子节点在 react 里会进
 * props.children，故像 \React.createElement(Menu, {...}, a, b)\ 这种「多子节点
 * 传给组件」的写法，其子节点在 props.children 里；组件若把它透传下去
 * （ui-primitives 的 Button / Menu / Modal 都这么做），只填数组的替身会让这些
 * 内容在树上凭空消失 —— 表现为「按钮渲染出来了但没有文字」。
 * 本仓库所有代码都用 \React.createElement(组件, props, 子节点…)\，从不用 JSX，
 * 故补上 props.children 不会与既有断言冲突。
 */
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  var merged = Object.assign({}, props || {});
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type: type, props: merged, children: children };
};
exports.useState = function useState(initial) {
  var store = current;
  var index = store.cursor++;
  if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
  var set = function set(next) {
    store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
    dirty = true;
  };
  return [store.slots[index], set];
};
exports.useRef = function useRef(initial) {
  var store = current;
  var index = store.cursor++;
  if (!(index in store.slots)) store.slots[index] = { current: initial };
  return store.slots[index];
};
exports.useCallback = function useCallback(fn, deps) {
  var store = current;
  var index = store.cursor++;
  var slot = store.slots[index];
  if (slot && depsEqual(slot.deps, deps)) return slot.fn;
  store.slots[index] = { fn: fn, deps: deps };
  return fn;
};
exports.useEffect = function useEffect(fn, deps) {
  var store = current;
  var index = store.cursor++;
  var slot = store.slots[index];
  if (slot && depsEqual(slot.deps, deps)) return;
  var next = { deps: deps, cleanup: undefined };
  effectQueue.push({ run: fn, slot: next, previousCleanup: slot ? slot.cleanup : undefined });
  store.slots[index] = next;
};
`

/** 能力矩阵占位：trae-cn 支持签到（本文件只测时序，不测能力矩阵本身）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

const IMPORT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^import \* as React from 'react';$/m, "const React = require('react');"],
  [
    /^import \{ supportsCreditBalance, supportsDailyCheckin \} from '\.\/credits-capabilities\.js';$/m,
    "const { supportsCreditBalance, supportsDailyCheckin } = require('./credits-capabilities.js');",
  ],
  [
    /^import \{ orderAfterDrop, dropPositionFromPointer \} from '\.\/account-order\.js';$/m,
    "const { orderAfterDrop, dropPositionFromPointer } = require('./account-order.js');",
  ],
]

/**
 * 把 `./account-order.js` 按与 `toCjs` 同一套规则转成 CJS 写进临时目录。
 *
 * `account-hub.js` import 了它：不写这个文件，`require` 会以
 * `Cannot find module` 失败 —— 整个文件一起红，那不是「自动签到没测到」，
 * 而是「什么都没测到」。
 */
function writeOrderModule(dir: string): void {
  const source = readFileSync(resolve(here, '../../plugin-src/client/account-order.js'), 'utf8')
  writeFileSync(join(dir, 'account-order.js'),
    source.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, ''))
}

function toCjs(source: string): string {
  let out = source
  for (const [pattern, replacement] of IMPORT_REWRITES) {
    if (!pattern.test(out)) {
      throw new Error(`account-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  // ui-primitives 是宿主隐式 baseline（不在本仓库依赖里），临时目录里没有它：
  // 按源码**现算**导入名单并改写为替身 require（见 fixtures/ui-primitives-stub.ts）。
  out = rewriteUiPrimitivesImport(out)
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat('\nmodule.exports.__testExports = { ProviderPanel: ProviderPanel };\n')
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __reset: () => void
  __isDirty: () => boolean
  __clearDirty: () => void
  __drainEffects: () => void
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

function loadClientModule(): {
  ProviderPanel: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'account-hub-auto-checkin-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeOrderModule(dir)
  writeUiPrimitivesStub(dir, (path, data) => writeFileSync(path, data))
  writeFileSync(join(dir, 'account-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'account-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  return { ProviderPanel: loaded.__testExports.ProviderPanel as (p: Record<string, unknown>) => unknown, hooks }
}

const client = loadClientModule()

/** 排空微任务（RPC 替身都是 async 函数，结果经 setState 回灌）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/**
 * 渲染到**稳定**：反复「渲染 → 跑 effect → 排空微任务」，直到没有新的 setState。
 *
 * 刻意带 `dirty` 判据而不是固定跑 N 轮：本文件的被测中间态是「签到状态已落地、
 * 账号列表仍未结算」，固定轮次会直接越过它。返回稳定那一轮的元素树。
 */
async function driveStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  let tree: unknown
  for (let pass = 0; pass < 20; pass++) {
    hooks.__clearDirty()
    tree = hooks.__renderComponent(Component, props)
    hooks.__drainEffects()
    await flushMicrotasks()
    if (!hooks.__isDirty()) return tree
  }
  throw new Error('渲染在 20 个 pass 内没有稳定：疑似 setState 循环')
}

/** 一条延迟结算的 RPC（由测试决定何时 resolve）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

/** 把函数组件展开成它的返回树（子组件必须经 `__renderComponent` 拿自己的槽位）。 */
function expandTree(node: unknown, hooks: HookedReact, depth = 0): unknown {
  if (depth > 50) throw new Error('组件展开超过 50 层：疑似自引用')
  if (Array.isArray(node)) return node.map((child) => expandTree(child, hooks, depth + 1))
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    return expandTree(hooks.__renderComponent(node.type, node.props), hooks, depth + 1)
  }
  return { ...node, children: node.children.map((child) => expandTree(child, hooks, depth + 1)) }
}

function flatten(node: unknown, out: unknown[] = []): unknown[] {
  out.push(node)
  if (isElement(node)) for (const child of node.children) flatten(child, out)
  else if (Array.isArray(node)) for (const child of node) flatten(child, out)
  return out
}

function textsOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  if (!isElement(node)) return []
  return node.children.flatMap(textsOf)
}

/** 按可见文本找**按钮**（容器节点也有同一段文本，但它们没有 onClick）。 */
function findButtonByText(node: unknown, text: string): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button' && textsOf(el).includes(text))
}

interface AccountRow {
  id: string
  nickname: string
  enabled: boolean
}

/**
 * `account.list` 的结算形态。
 *
 * - `hold`：**不结算**（由测试稍后放行）——复现「状态先回、账号后回」的中间态；
 * - `ok`：立即返回一个账号；
 * - `empty`：结算为**空列表**（能读到、但列表为空）；
 * - `fail`：**结算为失败**（RPC 抛错，面板进 error 态）。
 *
 * 后两种是本次缺陷真正的落点：`accounts` 的引用**再也不会变化**，于是
 * 「账号列表非空」这个就绪判据永远为假 —— 自动补签在整个挂载周期里一次都不发。
 */
type AccountsMode = 'hold' | 'ok' | 'empty' | 'fail'

/**
 * 可控的 `rpcCall` 替身：**两条挂载期 RPC 的结算时机由测试掌握**。
 *
 * `credits.checkinStatus` 立即结算（宿主侧是纯内存读、零网络）—— 这正是真机上
 * 「读内存的状态先回、要读池的账号列表后回」的顺序。
 */
function makeRpc(options: { accountsMode: AccountsMode; checkinBusy?: boolean }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const accountListGate = deferred<{ accounts: AccountRow[] }>()
  const checkinPerforms: Array<Record<string, unknown>> = []

  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') {
      if (options.accountsMode === 'hold') return await accountListGate.promise
      if (options.accountsMode === 'empty') return { accounts: [] }
      if (options.accountsMode === 'fail') throw new Error('账号列表读取失败（RPC 暂不可用）')
      return { accounts: [defaultAccount] }
    }
    if (method === 'credits.checkinStatus') {
      // 纯内存读（宿主侧零网络）→ 立即结算；账号此刻尚未就绪。
      return { provider: payload.provider, nextReset: 0, checkedIn: {} }
    }
    if (method === 'credits.balances') return { accounts: [] }
    if (method === 'consumption.get') return { provider: payload.provider, consumption: { order: 'round-robin', switch: 'per-turn' } }
    if (method === 'checkin.perform') {
      checkinPerforms.push(payload)
      const summary = { claimed: 1, alreadyClaimed: 0, inactive: 0, unavailable: 0, abnormal: 0, undetermined: 0, failed: 0, total: 1 }
      // 宿主侧共享互斥的「被挡」形态：`busy: true` + 空 results（一个 claim 都没发）。
      if (options.checkinBusy === true) {
        return {
          provider: payload.provider,
          nextReset: 0,
          results: [],
          summary: { ...summary, claimed: 0, total: 0 },
          busy: true,
        }
      }
      return {
        provider: payload.provider,
        nextReset: 0,
        results: [{ accountId: defaultAccount.id, nickname: defaultAccount.nickname, outcome: { kind: 'claimed' } }],
        summary,
      }
    }
    return {}
  }

  return {
    rpcCall,
    calls,
    checkinPerforms,
    /** 放行 `account.list`（模拟账号列表后回）。 */
    releaseAccounts: (accounts: AccountRow[] = [defaultAccount]) => accountListGate.resolve({ accounts }),
  }
}

const defaultAccount: AccountRow = { id: 'trae-cn-a1', nickname: 'A1', enabled: true }

const performCallsOf = (rpc: ReturnType<typeof makeRpc>) => rpc.calls.filter((c) => c.method === 'checkin.perform')

describe('进入 Hub 自动补签：挂载期两条 RPC 的结算顺序', () => {
  it('签到状态先回、账号列表后回 → 账号就绪后必须仍发出一次 `checkin.perform`', async () => {
    const rpc = makeRpc({ accountsMode: 'hold' })
    client.hooks.__reset()

    // 第 1 段：签到状态已落地，账号列表**挂在半路**。
    await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

    // 前提确认：状态确实先回了（否则本用例证明不了那个中间态），且账号还没回。
    expect(rpc.calls.map((c) => c.method)).toContain('credits.checkinStatus')
    // 账号未就绪 => 此刻一发都不该发（无从判断要签谁）。
    expect(performCallsOf(rpc), '账号未就绪就发了 checkin.perform').toHaveLength(0)

    // 第 2 段：账号列表后回 —— 这正是真机上「读池的那条慢」的顺序。
    rpc.releaseAccounts()
    await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

    expect(performCallsOf(rpc), '账号列表就绪后自动补签没有发出').toHaveLength(1)
    expect(performCallsOf(rpc)[0]!.payload).toEqual({ provider: 'trae-cn' })
  })

  it('账号列表先回、签到状态后回 → 同样恰好发出一发（既有顺序不得回归）', async () => {
    const rpc = makeRpc({ accountsMode: 'ok' })
    client.hooks.__reset()

    await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

    expect(performCallsOf(rpc)).toHaveLength(1)
    expect(performCallsOf(rpc)[0]!.payload).toEqual({ provider: 'trae-cn' })
  })

  it('账号列表**结算为失败** → 自动补签仍必须补发一次（宿主自己掌握目标集合）', async () => {
    // 真机形态：首次进页面时账号列表那条 RPC 失败一次（面板进 error 态、列表为空），
    // 下一条 `accounts` 状态更新**再也不会到来** —— 于是「非空即就绪」的判据
    // 把整个挂载周期的自动补签静默吞掉。而 `checkin.perform` 不带 accountId 时，
    // 目标集合是**宿主**按自己的账号池算的（`performCheckin` → `pool.listAccounts`），
    // 客户端读不到列表并不妨碍这次签到发生。
    const rpc = makeRpc({ accountsMode: 'fail' })
    client.hooks.__reset()

    await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

    expect(performCallsOf(rpc), '账号列表读取失败后自动补签被静默吞掉').toHaveLength(1)
    expect(performCallsOf(rpc)[0]!.payload).toEqual({ provider: 'trae-cn' })
  })

  it('账号列表结算为空数组 → 仍必须补发一次，且不得被「空数组 every 恒真」判成已全签', async () => {
    // ⚠️ 这条用例同时钉住修法里的一个陷阱：把「列表非空」那道守卫删掉之后，
    // 紧接着的「已全部签过」判据 `accounts.every(...)` 对**空数组恒为 true** ——
    // 少一个 `accounts.length > 0 &&` 就会把「本地没有可判对象」误判成
    // 「已全部签过」，缺陷只是换了个位置（从静默 return 变成静默跳过）。
    const rpc = makeRpc({ accountsMode: 'empty' })
    client.hooks.__reset()

    await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

    expect(performCallsOf(rpc), '空列表被误判为「已全部签过」，自动补签没有发出').toHaveLength(1)
  })
})

describe('「被挡」必须与「没跑」可区分（宿主 busy 语义的客户端一半）', () => {
  /** 自动补签的「被挡」只留一行控制台记录（静默语义的**可诊断**那一半）。 */
  const AUTO_BUSY_LOG = 'another check-in is already running'

  /** 静音并记录 `console.warn`（自动补签的被挡日志要走这里断言，而不是漏进测试输出）。 */
  function spyWarn() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    return {
      messages: () => warn.mock.calls.map((args) => args.map(String).join(' ')),
      restore: () => warn.mockRestore(),
    }
  }

  it('自动补签拿到 busy 时保持静默：不弹提示，但留一行可区分的日志', async () => {
    const rpc = makeRpc({ accountsMode: 'ok', checkinBusy: true })
    client.hooks.__reset()
    const warn = spyWarn()
    try {
      const tree = await driveStable(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks)

      expect(performCallsOf(rpc)).toHaveLength(1)
      // 静默 = 树上不出现那条提示（提示只属于用户**主动点击**的路径）。
      expect(textsOf(expandTree(tree, client.hooks)).join('')).not.toContain('已有签到正在进行')
      // 但「被挡」不能连日志都没有：静默的「跑了」与静默的「没跑」必须可区分。
      expect(warn.messages().some((m) => m.includes(AUTO_BUSY_LOG))).toBe(true)
    } finally {
      warn.restore()
    }
  })

  it('单账号「签到」拿到 busy 时提示「已有签到正在进行」而不是装作签过', async () => {
    const rpc = makeRpc({ accountsMode: 'ok', checkinBusy: true })
    client.hooks.__reset()
    const warn = spyWarn()
    try {
      const tree = await driveStable(
        client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }, client.hooks,
      )
      // ⚠️ 必须 expand：账号卡片是函数组件，不展开就只能看到 `<AccountCard/>` 这个
      // 元素本身，按钮（以及它的 onClick）根本不在树上。
      const button = findButtonByText(expandTree(tree, client.hooks), '签到')
      expect(button, '面板里找不到单账号「签到」按钮').toBeDefined()

      const before = performCallsOf(rpc).length
      ;(button!.props.onClick as () => void)()
      await flushMicrotasks()
      // 反向锚点：点击必须**真的发出了**那一发（否则下面的断言只是在看初始状态）。
      expect(performCallsOf(rpc).length).toBe(before + 1)
      expect(performCallsOf(rpc)[before]!.payload).toEqual({ provider: 'trae-cn', accountId: 'trae-cn-a1' })

      const after = expandTree(
        client.hooks.__renderComponent(client.ProviderPanel, { provider: 'trae-cn', rpcCall: rpc.rpcCall }),
        client.hooks,
      )
      const text = textsOf(after).join('')
      // 提示语必须出现：这一发**没有跑**，用户需要知道「稍候」而不是「失败了」。
      expect(text).toContain('已有签到正在进行，请稍候')
      // 反向锚点：**不得**画成「已签」——那是把「被挡」谎报成「签到成功」，
      // 而宿主侧一个 claim 都没发。
      expect(text).not.toContain('已签')
    } finally {
      warn.restore()
    }
  })
})
