/**
 * Account Hub「消耗顺序 + 切换粒度」两个选择器的**真渲染**测试。
 *
 * ## 为什么必须真渲染，而不是源码级正则断言
 *
 * 本仓库既有的前端测试多为「读源码、正则断言」（react 不在依赖里），但那**恰好
 * 证不了本次要证的东西**。本次的命题是「面板顶部出现两个并排选择器，点击后发出
 * 正确的 RPC，且选中态跟随宿主返回」—— 这是**渲染结构 + 事件流的输出差异**，
 * 正则只能证明某个字符串被提到过，证明不了组件真的渲染了它、更证明不了点击会
 * 走到哪个 `rpcCall` 上。
 *
 * 因此这里沿用 `qoder-hub-blank-screen.spec.ts` 的路子：把插件源码的 import 换成
 * 占位模块加载，配一个**带 hooks 的 react 占位**，真的渲染 `ProviderPanel`、
 * 真的派发 `onChange`。
 *
 * ## 与 `qoder-hub-blank-screen.spec.ts` 的分工
 *
 * 那个文件守的是「面板渲染不抛错 + 登录按钮可用」（白屏类缺陷的通盘闸门）；
 * 本文件守的是本次新增的这两个控件本身。两者共用同款加载器，但**各自维护一份
 * import 改写表**：一方改了 import 形态，两边都会立刻红，不会静默加载出半成品。
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
 * `useState` / `useRef` / `useCallback` / `useEffect` 四个都要真的能用：本组件
 * 在挂载时发 `consumption.get`，其结果经 `setState` 回灌 —— 没有 effect 队列
 * 就永远停在初始态，测出来的是「占位不完整」而不是被测代码。
 */
const REACT_STUB = `
'use strict';
var current = null;
var effectQueue = [];
/**
 * 每个组件函数一个**独立的**实例槽位表（与真实 react 的 fiber 节点一一对应）。
 *
 * ⚠️ 不能用「一个全局 current」：本测试要展开组件树，父子组件的 hooks 会交错
 * 执行（父渲染 → 展开子 → 子渲染 → 回到父继续）。共享一份槽位会让子组件的
 * useState 写进父组件的槽位，读出来的状态完全错位。
 */
var stores = new Map();
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
/**
 * 丢弃全部实例槽位 = **卸载所有组件**。
 *
 * 每个用例必须先调它：槽位表按组件函数缓存，不重置的话第二个用例会**继承**
 * 上一个用例留下的 state（consumption / phase / accounts 等），
 * 于是「挂载时读到的配置」变成上一条测试的残留值 —— 那是一条会因为错误的原因
 * 而变绿或变红的假测试。
 */
exports.__reset = function () { stores.clear(); effectQueue = []; };
exports.__drainEffects = function () {
  var queued = effectQueue;
  effectQueue = [];
  for (var i = 0; i < queued.length; i++) queued[i].run();
};
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
};
function depsEqual(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
exports.useState = function useState(initial) {
  var store = current;
  var index = store.cursor++;
  if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
  var set = function (next) {
    store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
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
  effectQueue.push({ run: fn });
  store.slots[index] = { deps: deps };
};
`

/** 能力矩阵占位（本文件不测积分行为）。 */
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
    + ' ProviderPanel: ProviderPanel, ConsumptionSelectors: ConsumptionSelectors };\n',
  )
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __drainEffects: () => void
  /** 卸载全部组件（丢弃 hooks 槽位）。每个用例开头必须调一次，见其定义处。 */
  __reset: () => void
}

function loadClientModule(): {
  ProviderPanel: (props: Record<string, unknown>) => unknown
  ConsumptionSelectors: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'account-hub-consumption-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeFileSync(join(dir, 'account-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'account-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  return {
    ProviderPanel: loaded.__testExports.ProviderPanel as (props: Record<string, unknown>) => unknown,
    ConsumptionSelectors: loaded.__testExports.ConsumptionSelectors as (props: Record<string, unknown>) => unknown,
    hooks,
  }
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

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

/** 渲染 → 跑 effect → 排空微任务，直到没有新的 setState 排队。 */
async function renderStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  // 先卸载：槽位表按组件函数缓存，不重置会继承上一个用例的状态
  // （见 `__reset` 的说明）。
  hooks.__reset()
  let tree: unknown
  for (let pass = 0; pass < 20; pass++) {
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // effect 里发起的 RPC 会以 setState 回灌；再展开一次让新状态出现在树上，
    // 多跑几轮直到稳定（本面板挂载时并发发三个 RPC）。
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return tree
}

/** 记录调用的 rpcCall 替身；`consumption.get` 回一个可指定的配置。 */
function makeRpc(consumption: { order: string; switch: string } = { order: 'sequential', switch: 'per-turn' }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let current = consumption
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') return { accounts: [] }
    if (method === 'credits.balances') return { accounts: [] }
    if (method === 'consumption.get') return { provider: payload.provider, consumption: current }
    if (method === 'consumption.set') {
      // 复刻宿主的**部分更新**语义：只覆盖传进来的字段。
      current = {
        order: (payload.order as string) ?? current.order,
        switch: (payload.switch as string) ?? current.switch,
      }
      return { provider: payload.provider, consumption: current }
    }
    return {}
  }
  return { calls, rpcCall, currentConsumption: () => current }
}

const client = loadClientModule()

describe('ConsumptionSelectors：两个并排的单选组', () => {
  it('渲染三档消耗顺序与两档切换粒度，文案与需求一致', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn',
        rpcCall,
        value: { order: 'sequential', switch: 'per-turn' },
        busy: false,
        onChange: () => {},
      }),
      client.hooks,
    )
    const text = textsOf(tree).join('')
    // 三档消耗顺序。
    expect(text).toContain('消耗顺序')
    expect(text).toContain('顺序')
    expect(text).toContain('遍历')
    expect(text).toContain('最高优先')
    // 两档切换粒度（第二档是用户拍板的默认值）。
    expect(text).toContain('切换粒度')
    expect(text).toContain('按请求')
    expect(text).toContain('按轮次')
    // 不得出现旧名「轮次」被当成消耗顺序那一档（改名是用户明确要求的）。
    expect(text).not.toMatch(/消耗顺序[\s\S]{0,40}轮次档/)
  })

  it('两个选择器各自是一个 radiogroup，且 radio 数量分别是 3 与 2', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset();
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    const nodes = flatten(tree).filter(isElement)
    const groups = nodes.filter((el) => el.props.role === 'radiogroup')
    expect(groups, '应当恰好有两个单选组（消耗顺序 / 切换粒度）').toHaveLength(2)

    const radiosOf = (group: ElementNode) => flatten(group)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    // 三档顺序 + 两档粒度。
    expect(radiosOf(groups[0]!)).toHaveLength(3)
    expect(radiosOf(groups[1]!)).toHaveLength(2)
    // 每组内的 radio 必须同名（否则浏览器会把四五个 radio 当成一组互斥）。
    const namesOf = (group: ElementNode) => new Set(radiosOf(group).map((el) => el.props.name))
    expect(namesOf(groups[0]!).size).toBe(1)
    expect(namesOf(groups[1]!).size).toBe(1)
    // 两组的 name 必须不同，否则跨组互斥。
    expect([...namesOf(groups[0]!)][0]).not.toBe([...namesOf(groups[1]!)][0])
  })

  it('选中态跟随 value（顺序 + 按轮次时各自勾中默认档）', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset();
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    const checked = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.checked === true)
    expect(checked).toHaveLength(2)
    // 每个组恰好一个勾中。
    const byName = new Map<unknown, number>()
    for (const el of checked) byName.set(el.props.name, (byName.get(el.props.name) ?? 0) + 1)
    expect([...byName.values()].every((count) => count === 1)).toBe(true)
  })

  it('busy 期间全部 radio 禁用（照 ModelTierPicker 的 disabled 语义）', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset();
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: true, onChange: () => {},
      }),
      client.hooks,
    )
    const inputs = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    expect(inputs.length).toBe(5)
    expect(inputs.every((el) => el.props.disabled === true)).toBe(true)
  })

  it('点击某一档只回调 onChange 一次，且带上该档的值（不做本地乐观更新）', () => {
    const { rpcCall } = makeRpc()
    const changes: Array<Record<string, unknown>> = []
    client.hooks.__reset();
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: false, onChange: (patch: Record<string, unknown>) => changes.push(patch),
      }),
      client.hooks,
    )
    const radios = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    // 第 2 个 radio = 消耗顺序的第二档（遍历）。
    ;(radios[1]!.props.onChange as () => void)()
    expect(changes).toEqual([{ order: 'round-robin' }])
    // 第 5 个 radio = 切换粒度的第二档（按轮次）。
    ;(radios[4]!.props.onChange as () => void)()
    expect(changes[1]).toEqual({ switch: 'per-turn' })
  })
})

describe('ProviderPanel：选择器位于账号卡片之前，且读写走 RPC', () => {
  it('挂载时拉一次 consumption.get（与 account.list 并发）', async () => {
    const { calls, rpcCall } = makeRpc({ order: 'round-robin', switch: 'per-request' })
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const get = calls.find((c) => c.method === 'consumption.get')
    expect(get, '挂载时应当拉取消耗配置').toBeDefined()
    expect(get!.payload).toEqual({ provider: 'buddy-cn' })
    // 宿主返回的值必须被渲染出来（否则选择器永远显示默认档）。
    const text = textsOf(tree).join('')
    expect(text).toContain('消耗顺序')
    expect(text).toContain('切换粒度')
  })

  it('选择器在账号卡片列表**之前**（面板顶部，与卡片同宽）', async () => {
    const { rpcCall } = makeRpc()
    const full = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const nodes = flatten(full).filter(isElement)
    const groupIndex = nodes.findIndex((el) => el.props.role === 'radiogroup')
    expect(groupIndex, '面板里找不到选择器').toBeGreaterThan(-1)
    // 账号区（空态提示）必须排在选择器之后 —— 两个选择器在账号卡片列表
    // **之前**，这正是需求要求的版面位置。
    //
    // ⚠️ 判据必须用「节点自身的直接文本」而不是 `textsOf`（整棵子树）：外层容器
    // 的子树里同样含这段文本，`findIndex` 会先命中**根节点**（下标 0），
    // 于是断言变成 `11 < 0` 恒失败 —— 那验的是「根节点在最后」这种无关的事。
    const ownTextOf = (el: ElementNode) => el.children
      .filter((child): child is string => typeof child === 'string')
      .join('');
    const emptyIndex = nodes.findIndex((el) => ownTextOf(el) === '尚未配置账号')
    expect(emptyIndex, '找不到账号区空态节点').toBeGreaterThan(-1)
    expect(groupIndex).toBeLessThan(emptyIndex)
  })

  it('点击轨道后发出 consumption.set，且是**部分更新**（只带一个字段）', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    let radios = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    ;(radios[1]!.props.onChange as () => void)()
    // 让 RPC 的 promise 结算（onChange 是 async 处理器）。
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const set = calls.find((c) => c.method === 'consumption.set')
    expect(set, '点击轨道后应当写回配置').toBeDefined()
    // **只带 order，不带 switch** —— 两个选择器彼此独立，整体覆盖会让另一个
    // 标签页的过期状态把用户刚改的字段冲掉。
    expect(set!.payload).toEqual({ provider: 'buddy-cn', order: 'round-robin' })

    // 宿主接受后再渲染：选中态必须跟着宿主返回的值走。
    tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    radios = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    expect(radios[1]!.props.checked, '宿主已接受 round-robin，界面应当勾中它').toBe(true)
  })

  it('写回失败时不得把选中态改掉（不做乐观更新，与模型开关同理）', async () => {
    const calls: Array<{ method: string }> = []
    const rpcCall = async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method })
      if (method === 'account.list') return { accounts: [] }
      if (method === 'consumption.get') return { provider: payload.provider, consumption: { order: 'sequential', switch: 'per-turn' } }
      if (method === 'consumption.set') throw new Error('宿主拒绝了这次写入')
      return {}
    }
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const radios = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    ;(radios[1]!.props.onChange as () => void)()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls.some((c) => c.method === 'consumption.set')).toBe(true)
    // 重新渲染：仍是「顺序」被勾中（失败没有污染本地状态）。
    const after = expandTree(
      client.hooks.__renderComponent(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }),
      client.hooks,
    )
    const afterRadios = flatten(after)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    expect(afterRadios[0]!.props.checked).toBe(true)
    expect(afterRadios[1]!.props.checked).toBe(false)
  })

  it('consumption.get 失败时面板仍完整可用（选择器退回默认档，不白屏）', async () => {
    const rpcCall = async (method: string) => {
      if (method === 'account.list') return { accounts: [] }
      if (method === 'consumption.get') throw new Error('端点未注册')
      return {}
    }
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const text = textsOf(tree).join('')
    // 面板骨架与选择器都还在（配置读取失败不该让整个面板消失）。
    expect(text).toContain('消耗顺序')
    expect(text).toContain('切换粒度')
    const radios = flatten(tree)
      .filter(isElement)
      .filter((el) => el.type === 'input' && el.props.type === 'radio')
    expect(radios).toHaveLength(5)
    // 退回默认档：顺序 + 按轮次。
    expect(radios[0]!.props.checked).toBe(true)
    expect(radios[4]!.props.checked).toBe(true)
  })

  it('七个 provider 都能渲染出这两个选择器（新增 provider 不会漏接线）', async () => {
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn']) {
      const { rpcCall } = makeRpc()
      const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
      const groups = flatten(tree).filter(isElement).filter((el) => el.props.role === 'radiogroup')
      expect(groups.length, `${provider} 缺少消耗顺序 / 切换粒度选择器`).toBe(2)
    }
  })
})
