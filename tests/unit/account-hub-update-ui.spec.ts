/**
 * 页面级「检查更新 / 一键更新」UI 的**渲染级**回归。
 *
 * ## 为什么必须是渲染级
 *
 * 该功能的状态机（`idle → checking → available / latest → applying → applied /
 * failed`）整个活在 `AccountHubPage` 的 render 路径上：相位判断写错会把提示行渲染成
 * 空白、把「更新中…」渲染成可重复点击的入口、把失败原文吞掉 —— 这些缺陷在源码正则
 * 里都看不出来（正则只能证明「某个字符串还在」）。故本文件照抄
 * `qoder-hub-blank-screen.spec.ts` 的渲染基建（带 hooks 的 react 占位模块 +
 * renderStable 驱动器）：真的渲染整页、真的点按钮、真的重渲染。
 *
 * ## 覆盖的契约（服务端由 `update.check` / `update.apply` 两个 RPC 提供）
 *
 * - 挂载后**自动静默**检查一次；只有真有更新时才出现提示行（含 commit 标题、
 *   新 sha 前 8 位、primary 的「立即更新」）；
 * - 无更新显示「已是最新」短提示，且不再显示「立即更新」；
 * - 点「立即更新」→ 按钮原地转**禁用**的「更新中…」→ 成功后显示
 *   「已更新到 <sha8>，建议重启会话生效」+ 可展开的完整日志；
 * - apply 失败显示**服务端原始 message**（红字错误档）；
 * - 检查失败静默：只 `console.warn`，页面顶部不留提示、也不抛。
 *
 * ⚠️ `account-hub.js` 新增 import 时必须**同时**改 `IMPORT_REWRITES` 与临时目录里的
 * 替身文件：只改前者的话改写规则命中、而 `require` 在临时目录里找不到文件，本文件会以
 * `Cannot find module` **整体加载失败** —— 那不是「某个用例红」，是这里不再守护任何东西。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ui-primitives 是宿主的隐式 baseline（不在本仓库依赖里）：临时目录里必须补一个
// 替身文件，否则 require 会以 Cannot find module 让**整个文件**加载失败。
import { rewriteUiPrimitivesImport, writeUiPrimitivesStub } from './fixtures/ui-primitives-stub.js'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 一个**带 hooks 的** react 占位模块（与 `qoder-hub-blank-screen.spec.ts` 同款）。
 *
 * 三条与真实 react 对齐的语义缺一不可：
 * 1. hooks 槽位按组件实例隔离 —— 本页里 `AccountHubPage` 与它渲染的
 *    `UpdateNotice` / `ProviderPanel` 各自的 `useState` 不能共用一份槽位；
 * 2. 依赖数组真的比对 —— 挂载检查的 effect deps 是 `[]`，若每轮渲染都重跑，
 *    它会无限重发 `update.check`，驱动器永远等不到稳定（而放宽收敛条件是错的：
 *    那会让「真的死循环」也冒充通过）；
 * 3. cleanup 在 effect 重跑**之前**执行。
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

exports.__isDirty = function () { return dirty; };
exports.__clearDirty = function () { dirty = false; };
/**
 * 丢弃全部组件实例槽位 —— 即「重新挂载」。
 *
 * 替身把槽位按组件函数缓存在模块级 Map 里（与真实 react 的 fiber 树同构），
 * 而本文件在**顶层**只加载一次客户端模块，于是第二个用例拿到的是上一个用例
 * 留下的实例：state 直接继承（用例①的 available 会串进用例②），挂载 effect 的
 * deps 又是 []、比对相同即跳过 —— 表现为「第二个用例起，挂载自动检查根本不跑」。
 *
 * 这是**替身的保真度缺口**，不是被测代码的缺陷：真实 react 里每次挂载都是全新
 * 的 state 与 effect。故每个用例开头显式重置一次（见 beforeEach）。
 */
exports.__resetStores = function () {
  stores.clear();
  effectQueue = [];
  dirty = false;
  current = null;
};
exports.__drainEffects = function () {
  var queued = effectQueue;
  effectQueue = [];
  for (var i = 0; i < queued.length; i++) {
    if (typeof queued[i].previousCleanup === 'function') queued[i].previousCleanup();
    var result = queued[i].run();
    queued[i].slot.cleanup = typeof result === 'function' ? result : undefined;
  }
};

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
  if (!(index in store.slots)) {
    store.slots[index] = typeof initial === 'function' ? initial() : initial;
  }
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

/** 能力矩阵占位（本文件不测积分行为）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/** 与既有客户端测试同款的 import 改写（逐条断言命中）。 */
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

/** `account-hub.js` import 了 `./account-order.js`（拖拽排序），临时目录里要放真件。 */
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
  out = rewriteUiPrimitivesImport(out)
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' AccountHubPage: AccountHubPage, ProviderPanel: ProviderPanel };\n',
  )
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __isDirty: () => boolean
  __clearDirty: () => void
  __resetStores: () => void
  __drainEffects: () => void
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

function loadClientModule(): {
  AccountHubPage: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-update-'))
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
  const exported = loaded.__testExports
  return {
    AccountHubPage: exported.AccountHubPage as (props: Record<string, unknown>) => unknown,
    hooks,
  }
}

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

/** 把函数组件展开成它的返回树（递归），其余节点原样保留。 */
function expandTree(node: unknown, hooks: HookedReact, depth = 0): unknown {
  if (depth > 50) throw new Error('组件展开超过 50 层：疑似自引用')
  if (Array.isArray(node)) return node.map((child) => expandTree(child, hooks, depth + 1))
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    const rendered = hooks.__renderComponent(node.type, node.props)
    return expandTree(rendered, hooks, depth + 1)
  }
  return { ...node, children: node.children.map((child) => expandTree(child, hooks, depth + 1)) }
}

/** 深度优先展平整棵树（含字符串子节点）。 */
function flatten(node: unknown, out: unknown[] = []): unknown[] {
  out.push(node)
  if (isElement(node)) for (const child of node.children) flatten(child, out)
  else if (Array.isArray(node)) for (const child of node) flatten(child, out)
  return out
}

/** 整棵树里全部可见文本（按渲染顺序）。 */
function textsOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  if (!isElement(node)) return []
  return node.children.flatMap(textsOf)
}

/** 按钮入口通过可访问名称查找（图标按钮不依赖可见文字）。 */
function findButtonByLabel(node: unknown, label: string): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button' && el.props['aria-label'] === label)
}

/** 文字按钮通过可见文案查找（「立即更新」/「查看完整日志」）。 */
function findButtonByText(node: unknown, text: string): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button' && textsOf(el).join('') === text)
}

/**
 * 页面级更新提示行的容器。
 *
 * ⚠️ 判据是 `.dim-ah-updateBar`（**页面级**那一层），不是 `.dim-ah-probeNotice`：
 * 后者是所有面板通知行共用的类名，用它会在「某个 provider 面板也弹了通知」时
 * 把面板的东西误当成更新提示（反之亦然）。
 */
function updateBarOf(node: unknown): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => typeof el.props.className === 'string'
      && el.props.className.includes('dim-ah-updateBar'))
}

/**
 * 渲染驱动器：反复「渲染 → 跑 effect → 排空微任务」，直到没有 setState 排队。
 *
 * effect 里发起的 `update.check` 是异步的，其结果通过 setState 回灌，故必须在每个
 * pass 之后让微任务队列排空，否则相位永远停在 checking。
 */
async function renderStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  let tree: unknown
  for (let pass = 0; pass < 20; pass++) {
    hooks.__clearDirty()
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    if (!hooks.__isDirty()) return tree
  }
  throw new Error('渲染在 20 个 pass 内没有稳定：疑似 setState 循环')
}

const client = loadClientModule()

/**
 * 每个用例都是一次**全新挂载**：清掉上一个用例留下的组件实例槽位。
 *
 * 少了这一句，用例之间会互相污染 —— 第二个用例拿到的是上一个用例的 state，
 * 且 `useEffect(…, [])` 因 deps 比对相同而**根本不再执行**（挂载自动检查不跑）。
 * 详见 REACT_STUB 里 `__resetStores` 的说明。
 */
beforeEach(() => { client.hooks.__resetStores() })

/** 服务端契约里的两个 sha：前 8 位刻意不同，避免「拿 currentSha 冒充 latestSha」假绿。 */
const SHA_OLD = '1111111111111111111111111111111111111111'
const SHA_NEW = '2222222222222222222222222222222222222222'
const LATEST_TITLE = 'feat: 支持检查更新与一键更新'
const APPLY_LOG = 'Progress: resolved 12, reused 12, downloaded 0\nDone in 1.4s'

/** 可控的 promise：用于把 `update.apply` 卡在「更新中」那一相位上断言按钮态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => { resolveFn = res })
  return { promise, resolve: resolveFn }
}

interface UpdateRpcOptions {
  /** `update.check` 的响应（省略即「无更新」）；抛错即模拟网络失败。 */
  check?: () => Promise<unknown>
  /** `update.apply` 的响应（省略即一次成功安装）。 */
  apply?: () => Promise<unknown>
}

/**
 * rpc 替身：记录调用，并按方法给响应。
 *
 * `account.list` / `credits.balances` 返回空集 —— 整页渲染会挂载 Codearts 面板，
 * 它挂载后立刻拉账号列表；不接住这两个方法的话渲染会在面板里炸，污染本文件的断言。
 */
function makeUpdateRpc(options: UpdateRpcOptions = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') return { accounts: [] }
    if (method === 'credits.balances') return { accounts: [] }
    if (method === 'update.check') {
      return options.check
        ? await options.check()
        : { hasUpdate: false, currentSha: SHA_OLD, latestSha: SHA_OLD, latestTitle: '' }
    }
    if (method === 'update.apply') {
      return options.apply
        ? await options.apply()
        : { previousSha: SHA_OLD, currentSha: SHA_NEW, log: '' }
    }
    return {}
  }
  return { calls, rpcCall }
}

/** 只统计某方法的调用次数（整页渲染还会打别的 RPC，不能用整表相等）。 */
const countOf = (calls: Array<{ method: string }>, method: string): number =>
  calls.filter((call) => call.method === method).length

describe('页面级「检查更新 / 一键更新」', () => {
  it('挂载后自动静默检查：有更新时提示行含 commit 标题、「立即更新」与新 sha 前 8 位', async () => {
    const { calls, rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true, currentSha: SHA_OLD, latestSha: SHA_NEW, latestTitle: LATEST_TITLE,
      }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    // 入口：页面顶部的图标按钮，可读名由 aria-label 提供（本插件不留悬停提示）。
    const entry = findButtonByLabel(tree, '检查更新')
    expect(entry, '页面顶部找不到「检查更新」按钮').toBeDefined()

    // 用户没点任何东西，挂载后必须**自动**检查过一次。
    expect(countOf(calls, 'update.check'), '挂载后没有自动检查更新').toBe(1)

    const bar = updateBarOf(tree)
    expect(bar, '有更新时没有渲染更新提示行').toBeDefined()
    const text = textsOf(bar!).join('')
    expect(text, '提示行里没有 commit 标题').toContain(LATEST_TITLE)
    expect(text, `提示行里没有新 commit 的前 8 位（${SHA_NEW.slice(0, 8)}）`)
      .toContain(`最新 ${SHA_NEW.slice(0, 8)}`)

    const apply = findButtonByText(tree, '立即更新')
    expect(apply, '提示行里没有「立即更新」按钮').toBeDefined()
    expect(apply!.props['data-variant'], '「立即更新」不是 primary 按钮').toBe('primary')
    expect(apply!.props.disabled, '可更新态的「立即更新」不该被禁用').not.toBe(true)
  })

  it('无更新时显示「已是最新」短提示，且不出现「立即更新」', async () => {
    const { calls, rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: false, currentSha: SHA_OLD, latestSha: SHA_OLD, latestTitle: '',
      }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    expect(countOf(calls, 'update.check'), '挂载后没有自动检查更新').toBe(1)
    const bar = updateBarOf(tree)
    expect(bar, '无更新时应当短暂显示「已是最新」提示').toBeDefined()
    expect(textsOf(bar!).join(''), '无更新时没有「已是最新」文案').toContain('已是最新')
    expect(findButtonByText(tree, '立即更新'), '无更新时不该出现「立即更新」按钮').toBeUndefined()
  })

  it('点「立即更新」：按钮转禁用的「更新中…」，成功后显示重启提示与可展开日志', async () => {
    const gate = deferred<{ previousSha: string; currentSha: string; log: string }>()
    const { calls, rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true, currentSha: SHA_OLD, latestSha: SHA_NEW, latestTitle: LATEST_TITLE,
      }),
      // 卡住 apply：先断言「更新中」那一相位，再放行看成功态。
      apply: () => gate.promise,
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const apply = findButtonByText(tree, '立即更新')
    expect(apply, '提示行里没有「立即更新」按钮').toBeDefined()

    const onClick = apply!.props.onClick as () => void
    expect(typeof onClick).toBe('function')
    expect(() => onClick()).not.toThrow()

    // 「更新中」相位：请求还挂着，按钮必须原地转禁用态（不能是可重复点的入口）。
    const busyTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const busy = findButtonByText(busyTree, '更新中…')
    expect(busy, '点击后按钮没有转成「更新中…」').toBeDefined()
    expect(busy!.props.disabled, '「更新中…」必须是禁用态').toBe(true)
    expect(countOf(calls, 'update.apply'), '点击没有调用 update.apply').toBe(1)

    // 放行：成功态 + 日志折叠。
    gate.resolve({ previousSha: SHA_OLD, currentSha: SHA_NEW, log: APPLY_LOG })
    const doneTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    const doneText = textsOf(updateBarOf(doneTree)!).join('')
    expect(doneText, '成功后没有显示新 sha 与「建议重启会话生效」')
      .toContain(`已更新到 ${SHA_NEW.slice(0, 8)}，建议重启会话生效`)
    // 日志默认**收起**：完整输出不该白占版面。
    expect(doneText, '日志默认就是展开的（应当收起）').not.toContain('Done in 1.4s')

    const toggle = findButtonByText(doneTree, '查看完整日志')
    expect(toggle, '成功后没有「查看完整日志」入口').toBeDefined()
    ;(toggle!.props.onClick as () => void)()

    const openTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const openText = textsOf(updateBarOf(openTree)!).join('')
    expect(openText, '展开后没有显示服务端返回的日志').toContain('Done in 1.4s')
    expect(findButtonByText(openTree, '收起日志'), '展开后没有「收起日志」入口').toBeDefined()
  })

  it('apply 失败时显示服务端原始错误 message', async () => {
    const SERVER_MESSAGE = 'pnpm install 失败：ERR_PNPM_NO_MATCHING_VERSION 版本不存在'
    const { rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true, currentSha: SHA_OLD, latestSha: SHA_NEW, latestTitle: LATEST_TITLE,
      }),
      apply: async () => { throw new Error(SERVER_MESSAGE) },
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    ;(findButtonByText(tree, '立即更新')!.props.onClick as () => void)()

    const failedTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const bar = updateBarOf(failedTree)
    expect(bar, 'apply 失败后没有渲染错误提示行').toBeDefined()
    // 原文一字不改：改写会把唯一可诊断的线索洗掉。
    expect(textsOf(bar!).join(''), '错误提示行里没有服务端原始 message').toContain(SERVER_MESSAGE)
    // ⚠️ 色调与语义在**通知行本体**（`.dim-ah-probeNotice`）上，不在包裹它的
    // `.dim-ah-updateBar` 容器上 —— 判据写错层级会让这条断言永远拿到 undefined。
    const notice = flatten(bar!)
      .filter(isElement)
      .find((el) => typeof el.props.className === 'string'
        && el.props.className.includes('dim-ah-probeNotice'))
    expect(notice, '失败提示行里没有通知行本体').toBeDefined()
    expect(notice!.props['data-tone'], '失败提示行不是错误档').toBe('error')
    expect(notice!.props.role, '失败提示行不是 alert 语义').toBe('alert')
  })

  it('挂载时的检查网络失败：不弹提示、不抛，只留一条 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { calls, rpcCall } = makeUpdateRpc({
        check: async () => { throw new Error('network down') },
      })

      const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

      expect(countOf(calls, 'update.check'), '挂载后没有自动检查更新').toBe(1)
      // 用户没主动做任何事：一次后台请求失败不该在页面顶部留提示。
      expect(updateBarOf(tree), '静默检查失败后不该出现任何更新提示行').toBeUndefined()
      expect(warn, '检查失败应当留一条 console.warn 供排查').toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
