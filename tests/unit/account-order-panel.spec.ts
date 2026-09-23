/**
 * 账号拖拽排序的**事件接线**测试（真渲染 `ProviderPanel`）。
 *
 * ## 为什么单有 `account-order.spec.ts` 不够
 *
 * 那份文件证明「落点算得对」，但证不了**接得上**：拖拽是一串 DOM 事件
 * （dragstart → dragover → drop → dragend）接到 React 的 props 上，再由
 * `ProviderPanel` 提交 `account.reorder`。算错的纯函数可以在单测里绿着，
 * 而界面上一次都触发不了 —— 那正是「UI 拖拽待接」这个状态本身。
 *
 * 本文件的命题因此是**事件流的输出差异**，只能靠真渲染 + 真派发来证：
 *
 *   1. 两个以上账号时卡片真的带 `draggable` 与四个拖拽回调；
 *   2. 派发 dragstart / dragover 后，源卡片 `data-dragging`、目标卡片按指针
 *      上下半区出现 `data-dropBefore` / `data-dropAfter` 插入线；
 *   3. drop 后发出**正确载荷**的 `account.reorder`（新顺序 id 数组），
 *      且本地顺序**先**变（乐观更新）；
 *   4. 拖回原位 → 不发 RPC；
 *   5. RPC 失败 → 顺序**回滚** + 弹通知（不留「看起来已生效」的假状态）；
 *   6. dragend / drop 之后临时状态全部清掉（`data-dragging` 与插入线都不残留）；
 *   7. 只有一个账号时不启用拖拽（拖了也无处可落）。
 *
 * ## 与 `qoder-hub-blank-screen.spec.ts` 的分工
 *
 * 那个文件守「面板渲染不抛错 + 登录按钮可用」（白屏类缺陷的通盘闸门），
 * 顺带断言卡片按钮集合。本文件守本次新增的拖拽路径本身。
 * 两者共用同款加载器，但**各自维护一份 import 改写表**：一方改了 import 形态，
 * 两边都会立刻红，不会静默加载出半成品。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 带 hooks 的最小 react 占位。
 *
 * 与 `qoder-hub-blank-screen.spec.ts` 同源：hooks 槽位按组件实例隔离、
 * 依赖数组真的比对、cleanup 在 effect 重跑之前执行。三条缺一条都会测出假结论
 * （详见那个文件头的长说明），故这里不再造第二套语义。
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
/** 丢弃全部实例槽位 = 卸载所有组件。每个用例开头必须调一次。 */
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

exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
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

/**
 * 与既有客户端测试同款的 import 改写（逐条断言命中）。
 *
 * ⚠️ `./account-order.js` 那一条是本次新增的 import：少一条，`toCjs` 会在
 * 第一条不匹配的正则上抛「import 形态已变化」，而不是加载出一个半成品。
 */
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

function toCjs(source: string): string {
  let out = source
  for (const [pattern, replacement] of IMPORT_REWRITES) {
    if (!pattern.test(out)) {
      throw new Error(`account-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' ProviderPanel: ProviderPanel };\n',
  )
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __isDirty: () => boolean
  __clearDirty: () => void
  __drainEffects: () => void
  __reset: () => void
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

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-order-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  // 纯逻辑模块**用真件**（复制源码，不做占位）：本文件要证的是「接线把落点
  // 转发给了正确的纯函数并发出正确载荷」，把纯逻辑也换成占位就自己拆掉了
  // 这条链的一环 —— 那会变成「占位返回什么、断言就期待什么」的假测试。
  writeFileSync(join(dir, 'account-order.js'),
    readFileSync(resolve(here, '../../plugin-src/client/account-order.js'), 'utf8'))
  writeFileSync(join(dir, 'account-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'account-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  return {
    ProviderPanel: loaded.__testExports.ProviderPanel as (props: Record<string, unknown>) => unknown,
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

/**
 * 渲染驱动器：反复「渲染 → 跑 effect → 排空微任务」，直到没有 setState 排队。
 *
 * `ProviderPanel` 挂载时并发发好几个 RPC（account.list / consumption.get /
 * credits.* / checkinStatus），它们的结果都经 setState 回灌，故每个 pass 之后
 * 必须让微任务队列排空，否则 `phase` 永远停在 loading、卡片区根本不存在。
 */
async function renderStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  hooks.__reset()
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

/** 一个账号条目（面板要的字段齐即可）。 */
function accountFixture(id: string, nickname: string) {
  return {
    id,
    nickname,
    enabled: true,
    credentialRef: `BUDDY_CN_ACCOUNT_${id.toUpperCase()}`,
    expiresAt: Date.now() + 86400000,
    refreshable: true,
  }
}

/** 三个账号：A / B / C，顺序即初始优先级。 */
const ACCOUNTS = [
  accountFixture('acc-a', '账号A'),
  accountFixture('acc-b', '账号B'),
  accountFixture('acc-c', '账号C'),
]

/**
 * 记录调用的 rpcCall 替身；`account.reorder` 的行为可指定（成功 / 抛错 / 挂起）。
 */
function makeRpc(
  options: { accounts?: unknown[]; reorderFails?: boolean } = {},
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') return { accounts: options.accounts ?? ACCOUNTS }
    if (method === 'credits.balances') return { accounts: [] }
    if (method === 'credits.checkinStatus') return { checkedIn: {} }
    if (method === 'consumption.get') return { consumption: { order: 'sequential', switch: 'per-turn' } }
    if (method === 'account.reorder') {
      if (options.reorderFails) throw new Error('列表已变化，请刷新')
      return { provider: payload.provider, orderedIds: payload.orderedIds }
    }
    return {}
  }
  return { calls, rpcCall }
}

/** 树里的账号卡片（按 DOM 顺序）。 */
function accountCards(tree: unknown): ElementNode[] {
  return flatten(tree)
    .filter(isElement)
    .filter((el) => typeof el.props.className === 'string' && el.props.className.includes('dim-ah-accountCard'))
}

/** 卡片上显示的账号名（用于确认顺序）。 */
const nicknameOf = (card: ElementNode): string => textsOf(card).find((t) => t.startsWith('账号')) ?? ''

/**
 * 一个能喂给拖拽回调的**最小事件替身**。
 *
 * `getBoundingClientRect` 返回固定矩形（top 100 / height 80 ⇒ 分界线 140），
 * 让「指针在上半还是下半」由 `clientY` 一个数字决定 —— 与
 * `dropPositionFromPointer` 的语义对齐，测试里不必造真实布局。
 */
function dragEvent(clientY: number) {
  const rect = { top: 100, height: 80, bottom: 180, left: 0, right: 300, width: 300 }
  return {
    clientY,
    prevented: 0,
    dataTransfer: {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) { this.data[type] = value },
    },
    currentTarget: { getBoundingClientRect: () => rect },
    preventDefault() { this.prevented++ },
  }
}

type DragEvent = ReturnType<typeof dragEvent>

/** 把拖拽回调当成函数取出来（拿不到就报清楚，而不是 TypeError: not a function）。 */
function dragPropsOf(card: ElementNode) {
  const missing = ['draggable', 'onDragStart', 'onDragOver', 'onDrop', 'onDragEnd']
    .filter((key) => card.props[key] === undefined)
  if (missing.length > 0) {
    throw new Error(`账号卡片缺少拖拽属性：${missing.join(' / ')}（拖拽 UI 未接线）`)
  }
  return {
    draggable: card.props.draggable,
    onDragStart: card.props.onDragStart as (event: DragEvent) => void,
    onDragOver: card.props.onDragOver as (event: DragEvent) => void,
    onDrop: card.props.onDrop as (event: DragEvent) => void,
    onDragEnd: card.props.onDragEnd as (event: DragEvent) => void,
  }
}

/** 面板 props（provider + 本用例的 rpcCall 替身）。 */
type PanelProps = Record<string, unknown>
const panelProps = (rpcCall: unknown): PanelProps => ({ provider: 'buddy-cn', rpcCall })

/**
 * 派发一次拖拽并重渲染，返回「松手之后」的树。
 *
 * 事件回调里的 setState 只把 dirty 置位（与真实 react 一样由下一次渲染消费），
 * 故每一步之后都要显式重渲染 —— 否则读到的是拖拽**之前**的树，
 * 断言会误判成「没有视觉反馈」。
 *
 * ⚠️ 重渲染必须用**同一份 props**（含同一个 rpcCall）：漏了它，drop 里的提交
 * 会以 `rpcCall is not a function` 失败，于是「不发 RPC」的用例因为错误的原因
 * 变绿、「发了正确载荷」的用例变红 —— 两边都是假结论。
 */
async function drag(
  tree: unknown,
  hooks: HookedReact,
  props: PanelProps,
  steps: Array<{ on: number; type: 'start' | 'over' | 'drop' | 'end'; clientY?: number }>,
): Promise<unknown> {
  let current = tree
  for (const step of steps) {
    const cards = accountCards(current)
    const card = cards[step.on]
    if (!card) throw new Error(`第 ${step.on} 张卡片不存在（共 ${cards.length} 张）`)
    const dragProps = dragPropsOf(card)
    if (step.type === 'start') dragProps.onDragStart(dragEvent(step.clientY ?? 150))
    else if (step.type === 'over') dragProps.onDragOver(dragEvent(step.clientY ?? 150))
    else if (step.type === 'drop') dragProps.onDrop(dragEvent(step.clientY ?? 150))
    else dragProps.onDragEnd(dragEvent(step.clientY ?? 150))
    // 事件回调里可能发起异步提交（drop → commitOrder），让微任务结算后再渲染。
    for (let i = 0; i < 10; i++) await Promise.resolve()
    current = expandTree(hooks.__renderComponent(client.ProviderPanel, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return current
}

const reorderCalls = (calls: Array<{ method: string; payload: Record<string, unknown> }>) =>
  calls.filter((call) => call.method === 'account.reorder')

describe('账号拖拽排序（渲染级事件接线）', () => {
  it('三个账号时卡片带 draggable 与四个拖拽回调', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(client.ProviderPanel, panelProps(rpcCall), client.hooks)
    const cards = accountCards(tree)
    expect(cards.length, '没渲染出三张账号卡片').toBe(3)
    for (const card of cards) {
      const dragProps = dragPropsOf(card)
      expect(dragProps.draggable).toBe('true')
      expect(typeof dragProps.onDrop).toBe('function')
    }
  })

  it('只有一个账号时不启用拖拽（拖了也无处可落）', async () => {
    const { rpcCall } = makeRpc({ accounts: [ACCOUNTS[0]] })
    const tree = await renderStable(client.ProviderPanel, panelProps(rpcCall), client.hooks)
    const cards = accountCards(tree)
    expect(cards.length).toBe(1)
    expect(cards[0].props.draggable).toBeUndefined()
  })

  it('dragstart 后源卡片半透明、dragover 目标下半区出现插入线', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    // 拖 A（下标 0）到 C（下标 2）的下半区 → 应插到 C 之后。
    tree = await drag(tree, client.hooks, props, [
      { on: 0, type: 'start' },
      { on: 2, type: 'over', clientY: 170 },
    ])
    const [cardA, , cardC] = accountCards(tree)
    expect(cardA.props['data-dragging'], '源卡片没有 data-dragging').toBe('true')
    expect(cardC.props['data-dropAfter'], '目标卡片下半区没有插入线').toBe('true')
    expect(cardC.props['data-dropBefore']).toBeUndefined()
  })

  it('dragover 目标上半区 → 插入线在上面（before）', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    // 拖 C（下标 2）到 A（下标 0）的上半区 → 应插到 A 之前。
    tree = await drag(tree, client.hooks, props, [
      { on: 2, type: 'start' },
      { on: 0, type: 'over', clientY: 110 },
    ])
    const [cardA] = accountCards(tree)
    expect(cardA.props['data-dropBefore']).toBe('true')
    expect(cardA.props['data-dropAfter']).toBeUndefined()
  })

  it('drop 后本地顺序立即更新，并发出带新顺序的 account.reorder', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    // 把 A 拖到 C 之后：A B C → B C A。
    tree = await drag(tree, client.hooks, props, [
      { on: 0, type: 'start' },
      { on: 2, type: 'over', clientY: 170 },
      { on: 2, type: 'drop', clientY: 170 },
    ])
    expect(accountCards(tree).map(nicknameOf)).toEqual(['账号B', '账号C', '账号A'])
    const reorders = reorderCalls(calls)
    expect(reorders.length, '没有发 account.reorder').toBe(1)
    expect(reorders[0].payload).toEqual({
      provider: 'buddy-cn',
      orderedIds: ['acc-b', 'acc-c', 'acc-a'],
    })
  })

  it('拖到目标上半区 → 插到其前（载荷是 before 语义）', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    // 把 C 拖到 A 之前：A B C → C A B。
    tree = await drag(tree, client.hooks, props, [
      { on: 2, type: 'start' },
      { on: 0, type: 'over', clientY: 110 },
      { on: 0, type: 'drop', clientY: 110 },
    ])
    expect(accountCards(tree).map(nicknameOf)).toEqual(['账号C', '账号A', '账号B'])
    expect(reorderCalls(calls)[0].payload.orderedIds).toEqual(['acc-c', 'acc-a', 'acc-b'])
  })

  it('拖回原位（相邻同类落点）→ 不发 RPC，顺序不变', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    // A 拖到 B 的上半区：A 本就在 B 之前 → 无变化。
    tree = await drag(tree, client.hooks, props, [
      { on: 0, type: 'start' },
      { on: 1, type: 'over', clientY: 110 },
      { on: 1, type: 'drop', clientY: 110 },
    ])
    expect(accountCards(tree).map(nicknameOf)).toEqual(['账号A', '账号B', '账号C'])
    expect(reorderCalls(calls).length, '无效落点不该发 RPC').toBe(0)
  })

  it('拖到自己身上 → 不发 RPC', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    tree = await drag(tree, client.hooks, props, [
      { on: 1, type: 'start' },
      { on: 1, type: 'over' },
      { on: 1, type: 'drop' },
    ])
    expect(accountCards(tree).map(nicknameOf)).toEqual(['账号A', '账号B', '账号C'])
    expect(reorderCalls(calls).length).toBe(0)
  })

  it('RPC 失败 → 回滚原顺序并弹通知', async () => {
    const { calls, rpcCall } = makeRpc({ reorderFails: true })
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    tree = await drag(tree, client.hooks, props, [
      { on: 0, type: 'start' },
      { on: 2, type: 'over', clientY: 170 },
      { on: 2, type: 'drop', clientY: 170 },
    ])
    // 服务端没接受 ⇒ 界面不能停在「看起来已生效」的状态。
    expect(accountCards(tree).map(nicknameOf), '失败后顺序没有回滚').toEqual(['账号A', '账号B', '账号C'])
    expect(reorderCalls(calls).length).toBe(1)
    const noticeText = flatten(tree)
      .filter(isElement)
      .filter((el) => typeof el.props.className === 'string' && el.props.className.includes('dim-ah-probeNotice'))
      .map((el) => textsOf(el).join(''))
      .join('|')
    expect(noticeText, '失败后没有弹通知').toContain('顺序保存失败')
    expect(noticeText).toContain('列表已变化，请刷新')
  })

  it('dragend 之后清掉 data-dragging 与插入线', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    tree = await drag(tree, client.hooks, props, [
      { on: 0, type: 'start' },
      { on: 2, type: 'over', clientY: 170 },
      { on: 2, type: 'drop', clientY: 170 },
      { on: 0, type: 'end' },
    ])
    for (const card of accountCards(tree)) {
      expect(card.props['data-dragging']).toBeUndefined()
      expect(card.props['data-dropBefore']).toBeUndefined()
      expect(card.props['data-dropAfter']).toBeUndefined()
    }
  })

  it('dragstart 写入 dataTransfer（Firefox 不设它就不启动拖拽）', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(client.ProviderPanel, panelProps(rpcCall), client.hooks)
    const dragProps = dragPropsOf(accountCards(tree)[0])
    const event = dragEvent(150)
    dragProps.onDragStart(event)
    expect(event.dataTransfer.data['text/plain']).toBe('acc-a')
    expect(event.dataTransfer.effectAllowed).toBe('move')
  })

  it('dragover 必须 preventDefault（否则浏览器不允许 drop）', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await renderStable(client.ProviderPanel, props, client.hooks)
    dragPropsOf(accountCards(tree)[0]).onDragStart(dragEvent(150))
    tree = expandTree(client.hooks.__renderComponent(client.ProviderPanel, props), client.hooks)
    const target = dragPropsOf(accountCards(tree)[1])
    const event = dragEvent(150)
    target.onDragOver(event)
    expect(event.prevented, '未 preventDefault 的 dragover 会拒绝 drop').toBeGreaterThan(0)
    expect(event.dataTransfer.dropEffect).toBe('move')
  })
})
