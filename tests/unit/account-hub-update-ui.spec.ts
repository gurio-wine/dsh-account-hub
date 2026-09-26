/**
 * 页面级「检查更新 / 一键更新」UI 的**渲染级**回归（v0.3.0 版本文本形态）。
 *
 * ## 为什么必须是渲染级
 *
 * 该功能的状态机（`idle → checking → available / latest → applying → applied /
 * failed`）整个活在 `AccountHubPage` 的 render 路径上：相位判断写错会把版本文本
 * 渲染成空白、把「更新」按钮渲染成可重复点的入口、把失败原文吞掉 —— 这些缺陷
 * 在源码正则里都看不出来（正则只能证明「某个字符串还在」）。故本文件照抄
 * `qoder-hub-blank-screen.spec.ts` 的渲染基建（带 hooks 的 react 占位模块 +
 * renderStable 驱动器）：真的渲染整页、真的点按钮、真的重渲染。
 *
 * ## 覆盖的契约（服务端由 `update.check` / `update.apply` 两个 RPC 提供，
 * ## task-26 双通道契约：请求带 `channel`，响应带 `currentVersion` / `latestVersion` /
 * ## `changelog` / `currentChangelog`，显示串服务端算好直传）
 *
 * - 挂载后**自动静默**按 stable 通道检查一次；有更新时 header 版本文本变黄
 *   「有更新 vX」，⇩ 按钮原地变 primary「更新」按钮；
 * - 无更新时版本文本显示当前版本号（currentVersion），点击展开当前版本日志；
 * - 点「更新」→ 按钮转禁用「更新中…」，版本文本位显示「更新中…」→ 成功后
 *   「已更新到 <版本>，建议重启」+ 可展开的新版本 changelog；
 * - 切换通道下拉为 Beta：立即按 beta 通道重新检查（update.check 带 channel: 'beta'）；
 * - apply 失败：版本文本位显示**服务端原始 message**（error 色）；
 * - 检查失败静默：只 `console.warn`，版本文本不留报错。
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
 *    `ChannelSelect` / `ProviderPanel` 各自的 `useState` 不能共用一份槽位；
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

/** 文字按钮通过可见文案查找。 */
function findButtonByText(node: unknown, text: string): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button' && textsOf(el).join('') === text)
}

/**
 * header 品牌行的版本号文本（v0.3.0 起唯一承载更新状态的文本位）。
 *
 * 判据是 `className` 含 `dim-ah-versionText` 的 button —— 旧「已是最新」Tag
 * 与整行 UpdateNotice 已删，这里就是「一个文本位承载全部状态」的那个位。
 */
function versionTextOf(node: unknown): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button'
      && typeof el.props.className === 'string'
      && el.props.className.includes('dim-ah-versionText'))
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
const LATEST_TITLE = 'dsh-account-hub v0.3.0'
const LATEST_TAG = 'v0.3.0'
const CURRENT_VERSION = 'v0.2.0'
const LATEST_VERSION_BETA = 'v0.2.0+3333333'
const CHANGELOG = '## v0.3.0\n- 检查更新切换 release 轨道\n- 版本号文本三态'
const CURRENT_CHANGELOG = '## v0.2.0\n- 首个正式 release'

/** 可控的 promise：用于把 `update.apply` 卡在「更新中」那一相位上断言按钮态。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => { resolveFn = res })
  return { promise, resolve: resolveFn }
}

interface UpdateRpcOptions {
  /** `update.check` 的响应（省略即「无更新」）；抛错即模拟网络失败。可按 channel 区分。 */
  check?: (channel: string) => Promise<unknown>
  /** `update.apply` 的响应（省略即一次成功安装）。 */
  apply?: () => Promise<unknown>
}

/**
 * rpc 替身：记录调用（含 payload），并按方法给响应。
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
      const channel = typeof payload?.channel === 'string' ? payload.channel : 'stable'
      return options.check
        ? await options.check(channel)
        : {
            hasUpdate: false,
            currentSha: SHA_OLD,
            latestSha: SHA_OLD,
            latestTitle: '',
            currentVersion: CURRENT_VERSION,
            currentChangelog: CURRENT_CHANGELOG,
          }
    }
    if (method === 'update.apply') {
      return options.apply
        ? await options.apply()
        : { previousSha: SHA_OLD, currentSha: SHA_NEW, currentVersion: LATEST_TAG }
    }
    return {}
  }
  return { calls, rpcCall }
}

/** 只统计某方法的调用次数（整页渲染还会打别的 RPC，不能用整表相等）。 */
const countOf = (calls: Array<{ method: string }>, method: string): number =>
  calls.filter((call) => call.method === method).length

/** `update.check` 调用里最后一条 payload 的 channel（缺省记 stable）。 */
const lastCheckChannel = (calls: Array<{ method: string; payload: Record<string, unknown> }>): string => {
  const found = calls.filter((call) => call.method === 'update.check').pop()
  return typeof found?.payload?.channel === 'string' ? (found.payload.channel as string) : '(missing)'
}

describe('页面级「检查更新 / 一键更新」（版本文本三态 + 通道下拉）', () => {
  it('挂载后自动按 stable 检查：版本文本变黄「有更新 vX」，⇩ 变「更新」按钮', async () => {
    const { calls, rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true,
        currentSha: SHA_OLD,
        latestSha: SHA_NEW,
        latestTag: LATEST_TAG,
        latestTitle: LATEST_TITLE,
        latestVersion: LATEST_TAG,
        currentVersion: CURRENT_VERSION,
        changelog: CHANGELOG,
      }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    // 用户没点任何东西，挂载后必须**自动**检查过一次，且默认 stable 通道。
    expect(countOf(calls, 'update.check'), '挂载后没有自动检查更新').toBe(1)
    expect(lastCheckChannel(calls), '默认通道必须是 stable').toBe('stable')

    // 版本文本：有更新态 —— 黄色警示「有更新 <最新版本>」。
    const versionText = versionTextOf(tree)
    expect(versionText, 'header 里没有版本号文本').toBeDefined()
    expect(textsOf(versionText!).join(''), '有更新时版本文本没有显示「有更新」+ 版本号')
      .toContain(`有更新 ${LATEST_TAG}`)
    expect(versionText!.props['data-tone'], '有更新态必须是警示色（黄）').toBe('warn')

    // ⇩ 按钮原地变为白底黑字 primary「更新」按钮（aria-label 同步换）。
    const update = findButtonByLabel(tree, '更新')
    expect(update, '有更新时没有「更新」按钮').toBeDefined()
    expect(update!.props['data-variant'], '「更新」按钮必须是 primary（白底黑字）').toBe('primary')
    expect(update!.props.disabled, '可更新态的「更新」按钮不该被禁用').not.toBe(true)
    expect(findButtonByLabel(tree, '检查更新'), '有更新时不应再显示 ⇩ 检查按钮').toBeUndefined()
  })

  it('无更新：版本文本显示当前版本号，点击展开当前版本日志', async () => {
    const { rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: false,
        currentSha: SHA_OLD,
        latestSha: SHA_OLD,
        latestTitle: '',
        currentVersion: CURRENT_VERSION,
        currentChangelog: CURRENT_CHANGELOG,
      }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    const versionText = versionTextOf(tree)
    expect(versionText, 'header 里没有版本号文本').toBeDefined()
    expect(textsOf(versionText!).join(''), '无更新时应显示当前版本号而非「已是最新」')
      .toContain(CURRENT_VERSION)
    expect(textsOf(versionText!).join(''), '无更新时不应再显示「已是最新」')
      .not.toContain('已是最新')
    expect(versionText!.props['data-tone'], '常态版本文本应是低调色').toBe('idle')

    // 点击版本文本 → 展开当前版本的 changelog（task-26 契约里的 currentChangelog）。
    ;(versionText!.props.onClick as () => void)()
    const openTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const texts = textsOf(openTree).join('')
    expect(texts, '点击版本文本后没有展开当前版本日志').toContain('首个正式 release')
    // 再点一次收起（toggle 语义）。
    ;(versionTextOf(openTree)!.props.onClick as () => void)()
    const closedTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    expect(textsOf(closedTree).join(''), '再次点击没有收起日志').not.toContain('首个正式 release')
  })

  it('有更新时点版本文本展开新版本 changelog，点「更新」走 apply', async () => {
    const { calls, rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true,
        currentSha: SHA_OLD,
        latestSha: SHA_NEW,
        latestTag: LATEST_TAG,
        latestTitle: LATEST_TITLE,
        latestVersion: LATEST_TAG,
        currentVersion: CURRENT_VERSION,
        changelog: CHANGELOG,
      }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

    // 有更新态点版本文本 → 展开的是**新版本**日志（不是当前版本的）。
    ;(versionTextOf(tree)!.props.onClick as () => void)()
    const openTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const texts = textsOf(openTree).join('')
    expect(texts, '有更新态点击版本文本应展开新版本日志').toContain('检查更新切换 release 轨道')

    // 点「更新」→ update.apply 带 stable 通道。apply 返回挂起的 gate，
    // 把相位钉在 applying 上断言「更新过程显示在版本文本位」。
    // ⚠️ 点击必须发生在用 gatedRpc 渲染的树上：openTree 里按钮的 onClick 闭包
    // 捕获的是旧 rpcCall（apply 立即 resolve，相位一闪而过断言不到）。
    const gate = deferred<{ previousSha: string; currentSha: string; currentVersion: string }>()
    const { calls: gatedCalls, rpcCall: gatedRpc } = makeUpdateRpc({ apply: () => gate.promise })
    const gatedTree = await renderStable(client.AccountHubPage, { rpcCall: gatedRpc }, client.hooks)
    ;(findButtonByLabel(gatedTree, '更新')!.props.onClick as () => void)()
    const applyingTree = await renderStable(client.AccountHubPage, { rpcCall: gatedRpc }, client.hooks)
    expect(countOf(gatedCalls, 'update.apply'), '点击「更新」没有调用 update.apply').toBe(1)
    const applyCall = gatedCalls.find((call) => call.method === 'update.apply')!
    expect(applyCall.payload.channel, 'apply 应带当前通道 stable').toBe('stable')
    expect(textsOf(applyingTree).join(''), '更新过程应显示在版本文本位').toContain('更新中')
    gate.resolve({ previousSha: SHA_OLD, currentSha: SHA_NEW, currentVersion: LATEST_TAG })
  })

  it('点「更新」：按钮转禁用「更新中…」，成功后显示「已更新到 <版本>，建议重启」', async () => {
    const gate = deferred<{ previousSha: string; currentSha: string; currentVersion: string }>()
    const { rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true,
        currentSha: SHA_OLD,
        latestSha: SHA_NEW,
        latestTag: LATEST_TAG,
        latestTitle: LATEST_TITLE,
        latestVersion: LATEST_TAG,
        currentVersion: CURRENT_VERSION,
        changelog: CHANGELOG,
      }),
      // 卡住 apply：先断言「更新中」那一相位，再放行看成功态。
      apply: () => gate.promise,
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    ;(findButtonByLabel(tree, '更新')!.props.onClick as () => void)()

    // 「更新中」相位：请求还挂着，按钮必须原地转禁用态（不能是可重复点的入口）。
    const busyTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const busy = findButtonByLabel(busyTree, '更新')
    expect(busy, '点击后没有「更新中…」按钮').toBeDefined()
    expect(busy!.props.disabled, '「更新中…」必须是禁用态').toBe(true)
    expect(textsOf(busy!).join(''), '更新中按钮文案不对').toContain('更新中…')
    expect(textsOf(versionTextOf(busyTree)!).join(''), '版本文本位应同步显示「更新中…」')
      .toContain('更新中…')

    // 放行：成功态 —— 版本文本位变绿「已更新到 <版本>，建议重启」。
    gate.resolve({ previousSha: SHA_OLD, currentSha: SHA_NEW, currentVersion: LATEST_TAG })
    const doneTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const doneText = textsOf(versionTextOf(doneTree)!).join('')
    expect(doneText, '成功后没有显示「已更新到 <版本>，建议重启」')
      .toContain(`已更新到 ${LATEST_TAG}，建议重启`)
    expect(versionTextOf(doneTree)!.props['data-tone'], '成功态应是成功色').toBe('ok')

    // 成功后点击版本文本 → 展开新版本 changelog。
    ;(versionTextOf(doneTree)!.props.onClick as () => void)()
    const openTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    expect(textsOf(openTree).join(''), '成功态点击应能展开新版本日志')
      .toContain('检查更新切换 release 轨道')
  })

  it('apply 响应缺 currentVersion 时回退到检查阶段缓存的 latestVersion', async () => {
    const { rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true,
        currentSha: SHA_OLD,
        latestSha: SHA_NEW,
        latestTag: LATEST_TAG,
        latestTitle: LATEST_TITLE,
        latestVersion: LATEST_TAG,
        currentVersion: CURRENT_VERSION,
        changelog: CHANGELOG,
      }),
      apply: async () => ({ previousSha: SHA_OLD, currentSha: SHA_NEW }),
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    ;(findButtonByLabel(tree, '更新')!.props.onClick as () => void)()
    const doneTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    expect(textsOf(versionTextOf(doneTree)!).join(''), 'apply 缺 currentVersion 应回退 latestVersion')
      .toContain(`已更新到 ${LATEST_TAG}，建议重启`)
    expect(textsOf(doneTree).join(''), '任何回退场景都不该出现「未知」').not.toContain('未知')
  })

  it('apply 失败：版本文本位显示服务端原始错误（error 色）', async () => {
    const SERVER_MESSAGE = 'pnpm add 失败：ERR_PNPM_NO_MATCHING_VERSION 版本不存在'
    const { rpcCall } = makeUpdateRpc({
      check: async () => ({
        hasUpdate: true,
        currentSha: SHA_OLD,
        latestSha: SHA_NEW,
        latestTag: LATEST_TAG,
        latestTitle: LATEST_TITLE,
        latestVersion: LATEST_TAG,
        currentVersion: CURRENT_VERSION,
        changelog: CHANGELOG,
      }),
      apply: async () => { throw new Error(SERVER_MESSAGE) },
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    ;(findButtonByLabel(tree, '更新')!.props.onClick as () => void)()

    const failedTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const failedText = versionTextOf(failedTree)
    expect(failedText, 'apply 失败后版本文本位没有渲染').toBeDefined()
    // 原文一字不改：改写会把唯一可诊断的线索洗掉。
    expect(textsOf(failedText!).join(''), '版本文本里没有服务端原始 message').toContain(SERVER_MESSAGE)
    expect(failedText!.props['data-tone'], '失败态必须是 error 色').toBe('error')
  })

  it('切换通道到 Beta：立即按 beta 重新检查（channel: beta 透传到 update.check）', async () => {
    const { calls, rpcCall } = makeUpdateRpc({
      check: async (channel) => channel === 'beta'
        ? {
            hasUpdate: true,
            currentSha: SHA_OLD,
            latestSha: '3333333333333333333333333333333333333333',
            latestTag: LATEST_TAG,
            latestTitle: LATEST_TITLE,
            latestVersion: LATEST_VERSION_BETA,
            currentVersion: CURRENT_VERSION,
            changelog: CHANGELOG,
          }
        : {
            hasUpdate: false,
            currentSha: SHA_OLD,
            latestSha: SHA_OLD,
            latestTitle: '',
            currentVersion: CURRENT_VERSION,
            currentChangelog: CURRENT_CHANGELOG,
          },
    })

    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    expect(lastCheckChannel(calls), '挂载默认检查应为 stable').toBe('stable')
    expect(textsOf(versionTextOf(tree)!).join(''), 'stable 无更新时应显示当前版本号')
      .toContain(CURRENT_VERSION)

    // 打开通道菜单 → 选 Beta。菜单行是 role="menuitem" 的 button（Menu 替身）。
    ;(findButtonByLabel(tree, '更新通道')!.props.onClick as () => void)()
    const menuTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const betaItem = flatten(menuTree)
      .filter(isElement)
      .find((el) => el.props.role === 'menuitem' && textsOf(el).join('') === 'Beta')
    expect(betaItem, '通道菜单里没有「Beta」选项').toBeDefined()
    ;(betaItem!.props.onClick as () => void)()

    // 切换即检查：update.check 立即带 channel: 'beta' 重发。
    const betaTree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    expect(countOf(calls, 'update.check'), '切换通道后没有立即重新检查').toBe(2)
    expect(lastCheckChannel(calls), '重新检查没有带 beta 通道').toBe('beta')
    // beta 有更新：版本文本显示「有更新 v0.2.0+3333333」（tag+短 sha 形态直显）。
    expect(textsOf(versionTextOf(betaTree)!).join(''), 'beta 有更新应显示 tag+短 sha 版本号')
      .toContain(`有更新 ${LATEST_VERSION_BETA}`)
  })

  it('挂载时的检查网络失败：版本文本不留报错、不抛，只留一条 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { calls, rpcCall } = makeUpdateRpc({
        check: async () => { throw new Error('network down') },
      })

      const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)

      expect(countOf(calls, 'update.check'), '挂载后没有自动检查更新').toBe(1)
      // 用户没主动做任何事：一次后台请求失败不该在 header 上留报错（静默回落 idle）。
      const versionText = versionTextOf(tree)
      if (versionText !== undefined) {
        expect(textsOf(versionText).join(''), '静默失败后版本文本不该显示报错')
          .not.toContain('network down')
      }
      expect(warn, '检查失败应当留一条 console.warn 供排查').toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
