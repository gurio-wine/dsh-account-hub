/**
 * AutoRoutePanel（自动路由面板）与左侧「自动路由」tab 的**真渲染**测试。
 *
 * ## 为什么必须真渲染
 *
 * 本单的命题全是**渲染结构 + 事件流的输出差异**：开关切了发什么载荷、草稿怎么改、
 * 三级下拉怎么联动、档位拉了几次、保存失败时草稿还在不在。正则只能证明某个字符串
 * 被提到过 —— 证明不了组件真的渲染了它，更证明不了点击会走到哪个 `rpcCall` 上。
 *
 * 故这里沿用 `account-order-panel.spec.ts` / `qoder-hub-blank-screen.spec.ts` 的路子：
 * 把插件源码的 import 换成占位模块加载，配一个**带 hooks 的 react 占位**，真的渲染
 * `AutoRoutePanel` / `AccountHubPage`、真的派发点击与拖拽。
 *
 * ## 与既有三个客户端 spec 的分工
 *
 * | 文件 | 守什么 |
 * |---|---|
 * | `qoder-hub-blank-screen.spec.ts` | 渲染不抛错（白屏类缺陷的通盘闸门）+ 导航计数 |
 * | `account-consumption-panel.spec.ts` | 消耗顺序 / 切换粒度两个下拉 |
 * | `account-order-panel.spec.ts` | 账号拖拽排序的事件接线 |
 * | **本文件** | 自动路由：总开关、草稿编辑器、三级联动、档位缓存、自动保存流 |
 *
 * 各自维护一份 import 改写表：一方改了 import 形态，几边都会立刻红，
 * 不会静默加载出半成品。
 *
 * ## 状态机（本文件断言的就是它）
 *
 * ```
 * 挂载 ──autoroute.get──▶ phase=ready，draft=宿主权威列表
 *                          │
 *   总开关 click ──autoroute.set {enabled}──▶ 以返回值覆盖 enabled（不做乐观更新）
 *                          │
 *   任何编辑 ──▶ draft 变 ──┬─ 草稿合法（每卡片有条目、每条 provider+model 非空）
 *                          │     └─▶ autoroute.set {models: draft}  ─┬─ 成功 ─▶ draft=返回值
 *                          │                                        └─ 失败 ─▶ 面板内红字显示
 *                          │                                                   服务端消息，draft 原样保留
 *                          └─ 仍是中间态（空卡片 / 半选候选）──▶ **不发任何请求**
 * ```
 *
 * ⚠️ 没有「保存」按钮、也没有脏标记：编辑**就是**保存动作，中间态只留在本地。
 * 总开关与「添加自动模型」入口位于标题行；卡片内仍可添加候选，提交在途时由 `saving`
 * 置灰卡片内的输入与候选按钮。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ui-primitives 是宿主的隐式 baseline（不在本仓库依赖里）：临时目录里必须补一个
// 替身文件，否则 require 会以 Cannot find module 让**整个文件**加载失败。
import { rewriteUiPrimitivesImport, writeUiPrimitivesStub } from './fixtures/ui-primitives-stub.js'
// 服务端的虚拟 provider id：跨端「同一个 id」这条契约必须有测试钉住（见下方用例）。
// 本 spec 是唯一**同时**能拿到客户端常量（从被测源码读出）与服务端常量的地方。
import { AUTO_ROUTE_PROVIDER_ID } from '../../src/auto-route.js'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 带 hooks 的最小 react 占位。
 *
 * 与 `qoder-hub-blank-screen.spec.ts` 同源：hooks 槽位按组件实例隔离、依赖数组真的
 * 比对、cleanup 在 effect 重跑之前执行、`dirty` 由驱动器消费。四条缺一条都会测出
 * 假结论（详见那个文件头的长说明），故这里不再造第二套语义。
 *
 * `__reset` 是**每个用例开头必须调**的：槽位表按组件函数缓存，不重置的话第二个用例
 * 会继承上一个用例留下的 draft / enabled —— 那是一条会因为错误的原因变绿或变红的
 * 假测试。
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
 * props.children，故像 \React.createElement(Modal, {...}, a, b)\ 这种「多子节点
 * 传给组件」的写法，其子节点在 props.children 里；组件若把它透传下去
 * （ui-primitives 的 Button / Menu / Modal 都这么做），只填数组的替身会让这些
 * 内容在树上凭空消失 —— 表现为「按钮渲染出来了但没有文字」。
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

/** 能力矩阵占位（本文件不测积分行为；AutoRoutePanel 完全不碰它）。 */
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
 * 把 `./account-order.js` 转成 CJS 写进临时目录。
 *
 * 放**真件**而不是空占位：本文件要证的是「拖拽把落点转发给了正确的纯函数并得到正确
 * 的新顺序」，把纯逻辑也换成占位就自己拆掉了这条链的一环 ——
 * 那会变成「占位返回什么、断言就期待什么」的假测试。
 *
 * ⚠️ 去掉 `export ` 之后**必须补回 `module.exports`**：只删关键字会让两个函数变成
 * 模块内的私有声明，`require` 拿到空对象，面板在拖拽时抛
 * `dropPositionFromPointer is not a function` —— 那是**测试装载器**的缺陷，
 * 看起来却像被测代码坏了。另外两个客户端 spec 只删不导出之所以没暴露这个问题，
 * 是因为它们的账号列表为空、拖拽回调从未被真的调用过。
 */
function writeOrderModule(dir: string): void {
  const source = readFileSync(resolve(here, '../../plugin-src/client/account-order.js'), 'utf8')
  const body = source.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  writeFileSync(join(dir, 'account-order.js'),
    `${body}\nmodule.exports = { orderAfterDrop, dropPositionFromPointer };\n`)
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
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' AccountHubPage: AccountHubPage, AutoRoutePanel: AutoRoutePanel };\n',
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
  AccountHubPage: (props: Record<string, unknown>) => unknown
  AutoRoutePanel: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
  /**
   * ui-primitives **替身**本身（从临时目录 require）。
   *
   * 直接拿到它才能断言「替身与真件同形」这类**关于替身自己的**契约 —— 例如
   * `Menu` 是否把菜单项的 `disabled` 透传成宿主 `button` 的 `disabled`
   * （真件 `Menu.tsx` 是 `disabled={entry.disabled}`）。这类断言用被测组件间接做
   * 不到：调用点目前没有任何一个 `option.disabled === true` 的候选。
   */
  primitives: { Menu: (props: Record<string, unknown>) => unknown }
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-autoroute-'))
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
  // ui-primitives **替身**本身：只有直接拿到它才能断言「替身与真件同形」这类关于
  // 替身自己的契约（见下方 disabled 透传用例）。
  const primitives = requireFromTemp(join(dir, 'ui-primitives-stub.js')) as {
    Menu: (props: Record<string, unknown>) => unknown
  }
  tempDir = dir
  return {
    AccountHubPage: loaded.__testExports.AccountHubPage as (props: Record<string, unknown>) => unknown,
    AutoRoutePanel: loaded.__testExports.AutoRoutePanel as (props: Record<string, unknown>) => unknown,
    hooks,
    primitives,
  }
}

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
  /** Menu 替身挂在返回节点上的自身 props（items / selectedId / onSelect）。 */
  menuProps?: {
    items?: Array<{ id: string; label: unknown; disabled?: boolean }>
    selectedId?: string
    onSelect?: (id: string) => void
  }
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

function expandTree(node: unknown, hooks: HookedReact, depth = 0): unknown {
  if (depth > 60) throw new Error('组件展开超过 60 层：疑似自引用')
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

const elementsOf = (node: unknown): ElementNode[] => flatten(node).filter(isElement)

/** 按可见文本找**按钮**节点（`type === 'button'`）。 */
function findButtonByText(node: unknown, text: string): ElementNode | undefined {
  return elementsOf(node).find((el) => el.type === 'button' && textsOf(el).includes(text))
}

/** 按无障碍名称查找 icon-only 按钮。 */
function findButtonByLabel(node: unknown, label: string): ElementNode | undefined {
  return elementsOf(node).find((el) => el.type === 'button' && el.props['aria-label'] === label)
}

/**
 * 渲染驱动器：反复「渲染 → 跑 effect → 排空微任务」，直到没有 setState 排队。
 *
 * `reset` 为真时先卸载全部组件（每个用例第一次渲染必须如此，见 REACT_STUB 的说明）；
 * 事件派发之后的重渲染**不能**重置，否则草稿与 `open` 这些 state 会被丢掉。
 */
async function settle(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
  reset = false,
): Promise<unknown> {
  if (reset) hooks.__reset()
  let tree: unknown
  for (let pass = 0; pass < 25; pass++) {
    hooks.__clearDirty()
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    // 让 effect 里发起的 RPC 结算（autoroute.get / catalog / model-info 各一层）。
    for (let i = 0; i < 12; i++) await Promise.resolve()
    if (!hooks.__isDirty()) return tree
  }
  throw new Error('渲染在 25 个 pass 内没有稳定：疑似 setState 循环')
}

const client = loadClientModule()

/** 面板 props（本用例的 rpcCall 替身）。 */
const panelProps = (rpcCall: unknown): Record<string, unknown> => ({ rpcCall })

/**
 * 两条源码级常量：从被测源码里**读出来**（而不是在测试里复制一份）。
 *
 * 悬停提示那组断言要逐字比对文案，写死一份副本就等于「测试自己跟自己比」——
 * 源码里的文案被改短了，副本不会跟着变，断言照样绿。
 */
const constValueOf = (name: string): string => {
  const source = readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8')
  const match = new RegExp(`^const ${name} = '([^']*)'`, 'm').exec(source)
  expect(match, `account-hub.js 里找不到常量 ${name}`).not.toBeNull()
  return match![1]!
}
const AUTO_ROUTE_SWITCH_HELP = constValueOf('AUTO_ROUTE_SWITCH_HELP')
const AUTO_ROUTE_EFFORT_NONE_HELP = constValueOf('AUTO_ROUTE_EFFORT_NONE_HELP')
const AUTO_ROUTE_EFFORT_LOADING_HELP = constValueOf('AUTO_ROUTE_EFFORT_LOADING_HELP')

/** 目录替身：两个供应商，各自两个 / 一个模型。 */
const CATALOG = {
  providers: [
    {
      id: 'dsh',
      name: 'DSH',
      models: [
        { id: 'deepseek-v4', name: 'DeepSeek V4' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
    },
    { id: 'codearts', name: 'Codearts', models: [{ id: 'glm-5', name: 'GLM-5' }] },
  ],
}

/**
 * 配置替身：两个定义。
 *
 * `dsh/deepseek-v4` 在**两个定义**里各出现一次 —— 这正是档位缓存那条断言的素材
 * （同 provider+model 只许拉一次 `autoroute.model-info`）。
 */
const CONFIG = {
  enabled: true,
  models: [
    {
      id: 'auto-1',
      name: '快速',
      entries: [{ provider: 'dsh', model: 'deepseek-v4' }],
    },
    {
      id: 'auto-2',
      name: '强力',
      entries: [
        { provider: 'dsh', model: 'deepseek-v4' },
        { provider: 'codearts', model: 'glm-5', effort: 'high' },
      ],
    },
  ],
}

/** 档位替身：只有 `dsh/deepseek-v4` 有档位，其余回 `{}`（= 该模型无档位）。 */
const EFFORTS: Record<string, { efforts: string[]; defaultEffort?: string }> = {
  'dsh\u0000deepseek-v4': { efforts: ['low', 'high'], defaultEffort: 'high' },
}

/**
 * 记录调用的 rpcCall 替身。
 *
 * `autoroute.set` **复刻宿主的写入语义**：只覆盖传进来的字段，并把写入后的完整配置
 * 回传（客户端以返回值为准）。`setFails` 让写入抛错（模拟服务端 `assertValid` 拒绝），
 * 用于验证「失败时草稿保留 + 显示服务端中文消息」。
 *
 * `catalogFailures` / `holdModelInfo` 是本单新增的两个**时序注入点**：
 * - `catalogFailures: n` 让前 n 次 `autoroute.catalog` 抛错（之后成功）——「目录拉不到
 *   时面板必须说话，且『重试』真的能恢复」需要「先失败、后成功」这条路径；
 * - `holdModelInfo: true` 让 `autoroute.model-info` **永不结算** —— 档位「在途」这个
 *   窗口只有把请求按住才观察得到（正常替身在同一轮微任务里就回了）。
 */
function makeRpc(options: {
  config?: typeof CONFIG
  setFails?: string
  catalogFailures?: number
  holdModelInfo?: boolean
} = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let current = JSON.parse(JSON.stringify(options.config ?? CONFIG)) as typeof CONFIG
  let catalogAttempts = 0
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'autoroute.get') return JSON.parse(JSON.stringify(current))
    if (method === 'autoroute.catalog') {
      catalogAttempts += 1
      if (catalogAttempts <= (options.catalogFailures ?? 0)) {
        throw new Error('模型目录读取失败：上游超时')
      }
      return CATALOG
    }
    if (method === 'autoroute.model-info') {
      // 按住不结算：档位占位 `{ loading: true, efforts: [] }` 会一直留在面板状态里。
      if (options.holdModelInfo === true) return new Promise(() => {})
      const key = `${String(payload.provider)}\u0000${String(payload.model)}`
      return EFFORTS[key] ?? {}
    }
    if (method === 'autoroute.set') {
      if (options.setFails !== undefined) throw new Error(options.setFails)
      current = {
        enabled: (payload.enabled as boolean) ?? current.enabled,
        models: (payload.models as typeof CONFIG.models) ?? current.models,
      }
      return JSON.parse(JSON.stringify(current))
    }
    return {}
  }
  return { calls, rpcCall, currentConfig: () => current }
}

/**
 * 类名判据：**按空白切分后的完整 token** 比对，不是 `includes`。
 *
 * ⚠️ `includes` 在这里会静默出错：`dim-ah-arCardHead` 的字符串里含有
 * `dim-ah-arCard`，于是「卡片头」会被当成「卡片」，一个定义数出两张 ——
 * 断言看到的顺序是 [卡片, 卡片头, 卡片, 卡片头]，看起来像「草稿被复制了一份」。
 * 那是一条因为**测试自己写错**而红的假失败。
 */
const hasClass = (el: ElementNode, name: string): boolean =>
  typeof el.props.className === 'string' && el.props.className.split(/\s+/).includes(name)

/** 树里全部「自动模型」定义卡片（按 DOM 顺序）。 */
function cardsOf(tree: unknown): ElementNode[] {
  return elementsOf(tree).filter((el) => hasClass(el, 'dim-ah-arCard'))
}

/**
 * 某张卡片内的候选行。
 *
 * ⚠️ 没有「全树候选行」的辅助函数是**刻意**的：候选行只在一个定义的卡片内有意义，
 * 跨卡片取它们会让「另一个定义一行不动」那类断言失去作用域。需要时一律先取卡片。
 */
function rowsInCard(card: ElementNode): ElementNode[] {
  return elementsOf(card).filter((el) => hasClass(el, 'dim-ah-arEntryRow'))
}

/** 一个节点子树里的全部 Menu（含替身挂出来的自身 props）。 */
function menusIn(node: unknown): ElementNode[] {
  return elementsOf(node).filter((el) => el.menuProps !== undefined)
}

/** 一张卡片内的名称输入框。 */
function nameInputOf(card: ElementNode): ElementNode {
  const input = elementsOf(card).find((el) => el.type === 'input')
  if (input === undefined) throw new Error('卡片里找不到名称输入框（Input 未接线？）')
  return input
}

/** 改一个输入框的值（受控：只派发 onChange，值由下次渲染的 props 决定）。 */
function typeInto(input: ElementNode, value: string): void {
  ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
}

/** 选中一个 Menu 的某一项（`onSelect` 是唯一写入入口）。 */
function selectInMenu(menu: ElementNode, id: string): void {
  ;(menu.menuProps!.onSelect as (id: string) => void)(id)
}

/**
 * 一张卡片内三条候选下拉各自的当前值（按 Menu 的 `selectedId` 读）。
 *
 * ⚠️ 读 `selectedId` 而不是锚点文案：`selectedId` 是**写给 Menu 的取值**本身，
 * 而锚点文案是它对用户的可读投影。两者分叉（例如「默认」档用空串哨兵值，
 * 锚点显示「默认」而 selectedId 必须是 undefined）时，只有读前者才看得见。
 */
function entryValuesOf(card: ElementNode): Array<{
  provider: string | undefined
  model: string | undefined
  effort: string | undefined
}> {
  return rowsInCard(card).map((row) => {
    const menus = menusIn(row)
    return {
      provider: menus[0]?.menuProps?.selectedId,
      model: menus[1]?.menuProps?.selectedId,
      effort: menus[2]?.menuProps?.selectedId,
    }
  })
}

/** 一个能喂给拖拽回调的最小事件替身（分界线 140，见 `dropPositionFromPointer`）。 */
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
    propagationStopped: false,
    stopPropagation() { this.propagationStopped = true },
    preventDefault() { this.prevented++ },
  }
}

type DragEvent = ReturnType<typeof dragEvent>

/**
 * 把拖拽回调当成函数取出来（拿不到就报清楚，而不是 TypeError: not a function）。
 *
 * 判据是**回调是否存在**，不是 `draggable`：真实 react 的 DOM 属性里
 * `draggable={undefined}` 会让节点不可拖，而 `false` 会让节点**可拖但无反馈**。
 * 本面板刻意传 `undefined` 表示「不启用」，故这里只校验四个回调 ——
 * 「不启用」那一条由专门的用例断言 `draggable` 为 undefined。
 */
function dragPropsOf(node: ElementNode) {
  const missing = ['onDragStart', 'onDragOver', 'onDrop', 'onDragEnd']
    .filter((key) => typeof node.props[key] !== 'function')
  if (missing.length > 0) {
    throw new Error(`节点缺少拖拽回调：${missing.join(' / ')}（拖拽 UI 未接线）`)
  }
  return {
    draggable: node.props.draggable,
    onDragStart: node.props.onDragStart as (event: DragEvent) => void,
    onDragOver: node.props.onDragOver as (event: DragEvent) => void,
    onDrop: node.props.onDrop as (event: DragEvent) => void,
    onDragEnd: node.props.onDragEnd as (event: DragEvent) => void,
  }
}

/**
 * 派发一次拖拽并重渲染，返回「松手之后」的树。
 *
 * 事件回调里的 setState 只把 dirty 置位（与真实 react 一样由下一次渲染消费），
 * 故每一步之后都要显式重渲染 —— 否则读到的是拖拽**之前**的树。
 * 重渲染必须带**同一份 props**（含同一个 rpcCall），漏了它会让后续请求以
 * `rpcCall is not a function` 失败，于是断言因为错误的原因变绿或变红。
 */
async function drag(
  tree: unknown,
  props: Record<string, unknown>,
  pick: (current: unknown) => ElementNode[],
  steps: Array<{ on: number; type: 'start' | 'over' | 'drop' | 'end'; clientY?: number }>,
): Promise<unknown> {
  let current = tree
  for (const step of steps) {
    const nodes = pick(current)
    const node = nodes[step.on]
    if (!node) throw new Error(`第 ${step.on} 个拖拽目标不存在（共 ${nodes.length} 个）`)
    const dragProps = dragPropsOf(node)
    const event = dragEvent(step.clientY ?? 150)
    if (step.type === 'start') dragProps.onDragStart(event)
    else if (step.type === 'over') dragProps.onDragOver(event)
    else if (step.type === 'drop') dragProps.onDrop(event)
    else dragProps.onDragEnd(event)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    current = await settle(client.AutoRoutePanel, props, client.hooks)
  }
  return current
}

/** 面板内红色错误行（保存失败 / 读取失败）。 */
const errorLinesOf = (tree: unknown): string[] =>
  elementsOf(tree)
    .filter((el) => typeof el.props.className === 'string'
      && el.props.className.includes('dim-ah-arError'))
    .map((el) => textsOf(el).join(''))

/** 确认弹窗根节点（Modal 替身渲染成 ui-modal-root）。 */
function modalRoot(tree: unknown): ElementNode | undefined {
  return elementsOf(tree).find((el) => el.props.className === 'ui-modal-root')
}

/**
 * 面板总开关（替身渲染成 `button[role=switch]`）。
 *
 * ⚠️ 真件是**函数组件**，`onChange` 只存在于展开**前**的元素 props 上；展开成宿主
 * 节点后剩下的是 `onClick`（替身内部包了 `onChange(!checked)`）。故断言「点一下会
 * 请求哪个状态」必须走 `clickSwitch`，而不是直接调 `props.onChange`。
 */
const switchOf = (tree: unknown): ElementNode => {
  const found = elementsOf(tree).find((el) => el.props.role === 'switch')
  if (found === undefined) throw new Error('面板里找不到总开关（Switch 未接线？）')
  return found
}

/** 点一下开关（等价于用户在真机上点它）。 */
function clickSwitch(tree: unknown): void {
  const onClick = switchOf(tree).props.onClick as (() => void) | undefined
  if (typeof onClick !== 'function') throw new Error('总开关没有可点的 onClick')
  onClick()
}

describe('AutoRoutePanel：挂载与总开关', () => {
  it('挂载拉 autoroute.get，开关状态按宿主返回值渲染', async () => {
    const { calls, rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)

    const get = calls.find((c) => c.method === 'autoroute.get')
    expect(get, '挂载时应当拉取自动路由配置').toBeDefined()
    // ⚠️ 刻意**不带 provider**：自动路由是全局配置，照抄 consumption.get 的
    // `{ provider }` 形态会误导读者以为配置按 provider 分。
    expect(get!.payload).toEqual({})

    expect(switchOf(tree).props['aria-checked'], '宿主 enabled=true 时开关应当是开态').toBe(true)
    expect(switchOf(tree).props['aria-label'], '开关必须带可读名').toBe('启用自动路由')
    // 编辑器同屏渲染：两个定义各一张卡片。
    expect(cardsOf(tree)).toHaveLength(2)
  })

  it('标题行含唯一开关与加号入口，且均带可发现说明', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const header = elementsOf(tree).find((el) => el.props.className === 'dim-ah-arHead')
    expect(header, '自动路由面板缺少标题行').toBeDefined()
    const headerChildren = header!.children.filter(isElement)
    expect(headerChildren, '标题、Switch、加号应在同一行').toHaveLength(3)
    const heading = headerChildren.find((el) => el.type === 'h2')
    expect(textsOf(heading!).join(''), '标题行 h2 文案错误').toBe('自动路由')
    expect(textsOf(header!).join(''), 'Switch 不应额外渲染可见标签文字').toBe('自动路由')

    const switchAnchor = headerChildren.find((el) => el.props['data-tooltip'] === AUTO_ROUTE_SWITCH_HELP)
    expect(switchAnchor, '标题行总开关缺少原有悬停说明').toBeDefined()
    expect(elementsOf(switchAnchor!).some((el) => el.props.role === 'switch'),
      '标题行中找不到总开关').toBe(true)
    expect(switchOf(tree).props['aria-label'], 'Switch label 应提供无障碍名称')
      .toBe('启用自动路由')
    expect(elementsOf(tree).filter((el) => el.props.role === 'switch'), '面板应只有一个开关')
      .toHaveLength(1)

    const addButton = findButtonByLabel(tree, '添加自动模型')
    expect(addButton, '加号入口必须带「添加自动模型」无障碍名称').toBeDefined()
    expect(addButton!.props.className, '加号按钮应采用方形图标按钮尺寸').toBe('dim-ah-iconBtn')
    expect(textsOf(addButton!).join(''), '添加入口应为纯图标按钮').toBe('')
    const addAnchor = headerChildren.find((el) => el.props['data-tooltip'] === '添加自动模型')
    expect(addAnchor, '加号按钮缺少悬停说明').toBeDefined()
    expect(elementsOf(addAnchor!).some((el) => el.props['aria-label'] === '添加自动模型'),
      '加号按钮不在标题行内').toBe(true)

    expect(elementsOf(tree).some((el) => el.props.className === 'dim-ah-arSwitchRow'),
      '不应再渲染独立开关行').toBe(false)
    expect(elementsOf(tree).some((el) => el.props.className === 'dim-ah-arSwitchLabel'),
      '不应再渲染重复开关文字').toBe(false)
    expect(elementsOf(tree).some((el) => el.props.className === 'dim-ah-arSaveRow'),
      '不应再渲染底部添加行').toBe(false)
    expect(findButtonByText(tree, '添加自动模型'), '底部文字按钮应已移除').toBeUndefined()
  })

  it('关闭状态下面板主体仍可见可编辑（用户可以先配好再开）', async () => {
    const { rpcCall } = makeRpc({ config: { ...CONFIG, enabled: false } })
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    expect(switchOf(tree).props['aria-checked']).toBe(false)
    // 关键：关闭**不是**禁用编辑器 —— 两张卡片、名称输入、两个添加按钮全在。
    expect(cardsOf(tree), '关闭状态下编辑器不该消失').toHaveLength(2)
    expect(nameInputOf(cardsOf(tree)[0]!).props.value).toBe('快速')
    expect(findButtonByLabel(tree, '添加自动模型'), '关闭状态下仍应能添加自动模型').toBeDefined()
    expect(findButtonByText(tree, '添加模型'), '关闭状态下仍应能添加候选').toBeDefined()
  })

  it('切开关发 autoroute.set { enabled }，并以**宿主返回值**回填（不做乐观更新）', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    expect(switchOf(tree).props['aria-checked']).toBe(true)

    // 点一下开关：替身内部把它翻成 onChange(!checked) = onChange(false)。
    clickSwitch(tree)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const set = calls.find((c) => c.method === 'autoroute.set')
    expect(set, '切开关应当写回 enabled').toBeDefined()
    // **只带 enabled**：列表与开关彼此独立，整体覆盖会让用户刚改的草稿被冲掉。
    expect(set!.payload).toEqual({ enabled: false })
    expect(switchOf(tree).props['aria-checked']).toBe(false)
  })

  it('写入被拒时开关回到宿主值（本地先翻会把「被拒绝」显示成成功）', async () => {
    const { rpcCall } = makeRpc({ setFails: '自动路由配置写入被拒绝' })
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    clickSwitch(tree)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    // 宿主拒绝 ⇒ enabled 没有被任何本地写入改过，仍是 true。
    expect(switchOf(tree).props['aria-checked'], '失败后开关不该停在「已关」').toBe(true)
  })

  it('总开关保留精简悬停说明', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const anchor = elementsOf(tree).find((el) => el.props['data-tooltip'] === AUTO_ROUTE_SWITCH_HELP)
    expect(anchor, '总开关缺少悬停说明').toBeDefined()
    expect(AUTO_ROUTE_SWITCH_HELP).toBe('开启后「自动路由」出现在 DSH 模型列表，其它 provider 从列表隐藏')
  })

  it('空列表时总开关禁用，但提示仍为精简说明', async () => {
    const { rpcCall } = makeRpc({ config: { enabled: false, models: [] } })
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)

    expect(switchOf(tree).props.disabled, '一个自动模型都没有时开关必须禁用').toBe(true)
    expect(elementsOf(tree).some((el) => el.props['data-tooltip'] === AUTO_ROUTE_SWITCH_HELP)).toBe(true)
    // ⚠️ 刻意**不点**这个开关：真 DOM 里 disabled 的 button 不派发 click，而替身把
    // onClick 原样接上了 —— 点它只能测出替身的行为，测不出「用户点不动」。
  })

  it('列表非空时开关可用且仍挂同一条精简说明', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    expect(switchOf(tree).props.disabled, '有自动模型时开关必须可用').toBe(false)
    expect(elementsOf(tree).some((el) => el.props['data-tooltip'] === AUTO_ROUTE_SWITCH_HELP)).toBe(true)
  })
})

describe('AutoRoutePanel：草稿编辑（修改即保存）', () => {
  it('改名立即提交：autoroute.set 载荷携带新名，成功后草稿取宿主返回值', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)

    typeInto(nameInputOf(cardsOf(tree)[0]!), '极速')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    expect(nameInputOf(cardsOf(tree)[0]!).props.value, '改名应当反映在草稿上').toBe('极速')
    // 修改即保存：编辑**立即**写服务端（合法配置才提交，改名始终合法）。
    const set = calls.filter((c) => c.method === 'autoroute.set')
    expect(set, '改名应当立即触发 autoroute.set').toHaveLength(1)
    const payload = set[0]!.payload as { models: Array<{ name: string }> }
    expect(payload.models.map((d) => d.name), '载荷应携带新名').toEqual(['极速', '强力'])
    // 成功后无错误行。
    expect(errorLinesOf(tree), '成功提交后不该有错误行').toHaveLength(0)
  })

  it('添加自动模型：新定义 name 为「自动模型 N」且不与已有定义重名', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    ;(findButtonByLabel(tree, '添加自动模型')!.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const cards = cardsOf(tree)
    expect(cards, '添加后应当有三张卡片').toHaveLength(3)
    const names = cards.map((card) => nameInputOf(card).props.value)
    // 已有定义叫「快速」「强力」，故默认名从「自动模型 3」起。
    expect(names[2]).toBe('自动模型 3')
    expect(new Set(names).size, '默认名不得与已有定义重名（写路径按唯一性校验）').toBe(names.length)
    // 新定义 entries 为空 —— 这是**允许的草稿态**，保存时才由服务端拒绝。
    expect(rowsInCard(cards[2]!), '新定义的候选列表应当是空的').toHaveLength(0)
    expect(calls.filter((c) => c.method === 'autoroute.set')).toHaveLength(0)
  })

  it('添加候选：新条目三级全空占位，用户逐级选', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const card = cardsOf(tree)[0]!
    // 卡片内的「添加模型」按钮；「添加自动模型」入口现位于标题行。
    ;(findButtonByText(card, '添加模型')!.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const rows = rowsInCard(cardsOf(tree)[0]!)
    expect(rows).toHaveLength(2)
    const values = entryValuesOf(cardsOf(tree)[0]!)
    expect(values[1], '新条目的三级都应当是空的').toEqual({
      provider: undefined, model: undefined, effort: undefined,
    })
    // 锚点显示引导文案而不是空白（空锚点看起来像坏掉的控件）。
    expect(textsOf(rows[1]!)).toContain('选择供应商')
    expect(textsOf(rows[1]!)).toContain('选择模型')
  })

  it('中间态逐级填：加空候选、只选供应商都不提交，填全的那一刻才提交一次', async () => {
    // 「修改即保存」的闸门判据是**整份草稿合法**（每张卡片有条目、每条候选
    // provider+model 都是非空串）。加一行空候选、或只选了供应商，提交上去必被
    // 服务端 `assertValidAutoRouteConfig` 点名拒绝 —— 那等于用户每点一下都收一条
    // 红字。故这条断言链是「零请求 → 零请求 → 恰好一次」，缺任何一环都测不出闸门：
    // 只测首尾两步的话，「每次编辑都提交、失败就报错」的实现照样能绿。
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const sets = () => calls.filter((c) => c.method === 'autoroute.set')

    // 第一步：加一行空候选（provider / model 都是空串占位）。
    ;(findButtonByText(cardsOf(tree)[0]!, '添加模型')!.props.onClick as () => void)()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    expect(rowsInCard(cardsOf(tree)[0]!), '新候选应当已经进了本地草稿（不是被前端拦下）').toHaveLength(2)
    expect(sets(), 'provider 与 model 都空：一次都不该提交').toHaveLength(0)

    // 第二步：只选供应商 —— 草稿合法了吗？没有，model 还是空串。
    let menus = menusIn(rowsInCard(cardsOf(tree)[0]!)[1]!)
    selectInMenu(menus[0]!, 'dsh')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    expect(entryValuesOf(cardsOf(tree)[0]!)[1]!.provider, '本地草稿要认下这一笔').toBe('dsh')
    expect(sets(), 'model 还空着：仍不该提交').toHaveLength(0)
    expect(errorLinesOf(tree), '中间态不该冒出任何错误行').toHaveLength(0)

    // 第三步：补上 model ⇒ 整份草稿第一次变合法，提交恰好一次。
    menus = menusIn(rowsInCard(cardsOf(tree)[0]!)[1]!)
    selectInMenu(menus[1]!, 'deepseek-v4')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const submitted = sets()
    expect(submitted, '填全的那一刻应当提交，且只提交一次').toHaveLength(1)
    const payload = submitted[0]!.payload as { models: typeof CONFIG.models }
    // 载荷里的新候选已经是填全的形态 —— 证明提交的是**填全之后**的草稿，
    // 而不是把中间态先塞出去。
    expect(payload.models[0]!.entries).toEqual([
      { provider: 'dsh', model: 'deepseek-v4' },
      { provider: 'dsh', model: 'deepseek-v4' },
    ])
    expect(errorLinesOf(tree), '合法提交成功后不该有错误行').toHaveLength(0)
  })

  it('三级联动：选供应商后模型 options 来自 catalog 对应组，且清掉下游取值', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    // 第二张卡片的第二条候选：provider=codearts / model=glm-5 / effort=high。
    let row = rowsInCard(cardsOf(tree)[1]!)[1]!
    let menus = menusIn(row)
    expect(menus[0]!.menuProps!.items!.map((i) => i.id), '供应商下拉来自 catalog').toEqual(['dsh', 'codearts'])
    expect(menus[1]!.menuProps!.items!.map((i) => i.id), '模型下拉来自所选供应商那一组').toEqual(['glm-5'])

    // 换成 dsh ⇒ 模型 options 变成 dsh 的两个模型，且**模型与档位都被清掉**。
    selectInMenu(menus[0]!, 'dsh')
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    row = rowsInCard(cardsOf(tree)[1]!)[1]!
    menus = menusIn(row)
    expect(menus[1]!.menuProps!.items!.map((i) => i.id), '换供应商后模型 options 应当跟着换').toEqual(['deepseek-v4', 'deepseek-v4-flash'])
    const values = entryValuesOf(cardsOf(tree)[1]!)[1]!
    expect(values.provider).toBe('dsh')
    // 旧的 model / effort 属于上一个供应商，留着就是非法配置。
    expect(values.model, '换供应商必须清掉模型').toBeUndefined()
    expect(values.effort, '换供应商必须清掉档位').toBeUndefined()
  })

  it('供应商未选时模型下拉禁用（无从选起），并带引导提示', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    ;(findButtonByText(cardsOf(tree)[0]!, '添加模型')!.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const row = rowsInCard(cardsOf(tree)[0]!)[1]!
    const menus = menusIn(row)
    // 三个锚点里，模型与档位都应当 disabled（供应商空 ⇒ 模型空 ⇒ 档位空）。
    const anchors = elementsOf(row).filter((el) => el.props['aria-haspopup'] === 'menu')
    expect(anchors[1]!.props.disabled, '供应商未选时模型下拉应当禁用').toBe(true)
    expect(anchors[2]!.props.disabled, '模型未选时档位下拉应当禁用').toBe(true)
    expect(menus[1]!.menuProps!.items, '未选供应商时模型 options 为空').toEqual([])
  })

  it('删除定义走二键确认弹窗：取消不删、确认才删（不用原生 confirm）', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    // 卡片头右侧的「删除」（卡片内第一个删除按钮属于定义本身）。
    const deleteButton = findButtonByText(cardsOf(tree)[0]!, '删除')!
    ;(deleteButton.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const modal = modalRoot(tree)
    expect(modal, '删除定义应当先弹确认框').toBeDefined()
    expect(textsOf(modal!).join(''), '确认文案要点名是哪个自动模型').toContain('快速')

    // 取消：什么都不发生。
    ;(findButtonByText(modal!, '取消')!.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    expect(modalRoot(tree), '取消后弹窗应当关闭').toBeUndefined()
    expect(cardsOf(tree), '取消不该删掉卡片').toHaveLength(2)

    // 确认：卡片真的少一张，且本地草稿同步收下这一笔。
    //
    // ⚠️ 删除**会**触发提交（`removeDefinition` 走 `editDraft`）：删掉一张卡片后
    // 剩下的那份草稿仍合法，故与改名/拖拽同属「修改即保存」。这条用例只钉本地
    // 结果，提交载荷由「自动保存流」那组用例负责。
    ;(findButtonByText(cardsOf(tree)[0]!, '删除')!.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    const confirm = findButtonByText(modalRoot(tree)!, '删除')!
    ;(confirm.props.onClick as () => void)()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    expect(cardsOf(tree), '确认后应当删掉一张卡片').toHaveLength(1)
    expect(nameInputOf(cardsOf(tree)[0]!).props.value, '剩下的是第二个定义').toBe('强力')
  })
})

describe('AutoRoutePanel：思考档位（按需拉取 + 缓存）', () => {
  it('按需拉 autoroute.model-info，同一 provider+model 只拉一次', async () => {
    const { calls, rpcCall } = makeRpc()
    await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)

    const infoCalls = calls.filter((c) => c.method === 'autoroute.model-info')
    // 三个不同的 provider+model（dsh/deepseek-v4 在两个定义里各出现一次）。
    const keys = infoCalls.map((c) => `${String(c.payload.provider)}/${String(c.payload.model)}`)
    expect(keys.filter((k) => k === 'dsh/deepseek-v4'), '同 provider+model 不许二次拉取').toHaveLength(1)
    expect(keys.filter((k) => k === 'codearts/glm-5')).toHaveLength(1)
    // 反向锚点：档位确实被拉过（否则「只拉一次」在零次时也成立）。
    expect(keys, '应当为每个已配好 provider+model 的条目拉一次档位').toContain('dsh/deepseek-v4')
  })

  it('有档位时逐档列出 + 「默认」，且选中值跟随草稿的 effort', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const row = rowsInCard(cardsOf(tree)[0]!)[0]!
    const effortMenu = menusIn(row)[2]!
    // 选项 = 「默认」+ 宿主返回的两档（顺序即宿主给的偏好顺序）。
    expect(effortMenu.menuProps!.items!.map((i) => i.id)).toEqual(['', 'low', 'high'])
    // 该条目没配 effort ⇒ 选中「默认」（selectedId 为 undefined，锚点显示「默认」）。
    expect(effortMenu.menuProps!.selectedId).toBeUndefined()
    expect(textsOf(row)).toContain('默认')

    // 第二张卡片的第二条候选配了 high ⇒ 选中态是它。
    const configured = rowsInCard(cardsOf(tree)[1]!)[1]!
    expect(menusIn(configured)[2]!.menuProps!.selectedId).toBe('high')
  })

  it('无档位的模型：档位下拉禁用 + 悬停说明「该模型无思考档位」', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    // codearts/glm-5 在档位替身里回 `{}` ⇒ 无档位。
    const row = rowsInCard(cardsOf(tree)[1]!)[1]!
    const anchor = elementsOf(row).filter((el) => el.props['aria-haspopup'] === 'menu')[2]!
    expect(anchor.props.disabled, '无档位时档位下拉应当禁用').toBe(true)
    const tip = elementsOf(row).find((el) => el.props['data-tooltip'] === AUTO_ROUTE_EFFORT_NONE_HELP)
    expect(tip, '无档位时应当给出「该模型无思考档位」说明').toBeDefined()
    expect(AUTO_ROUTE_EFFORT_NONE_HELP).toBe('该模型无思考档位')
    // 「默认」仍可选（它就是「不配 effort」），故选项不是空的。
    expect(menusIn(row)[2]!.menuProps!.items!.map((i) => i.id)).toEqual([''])
  })

  it('档位在途时不挂「无思考档位」这个错误结论，而是「正在加载」', async () => {
    // ⚠️ 这条守的是一个**错误结论**：`autoroute.model-info` 在途时占位是
    // `{ loading: true, efforts: [] }`，光看 `efforts.length === 0` 会把「还没问」
    // 判成「问过了、没有档位」—— 用户会据此以为该模型不支持思考档位而放弃配置。
    const { rpcCall } = makeRpc({ holdModelInfo: true })
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const row = rowsInCard(cardsOf(tree)[0]!)[0]!
    const anchor = elementsOf(row).filter((el) => el.props['aria-haspopup'] === 'menu')[2]!
    // 在途仍禁用（占位里没有可选项），但提示语必须是「加载中」。
    expect(anchor.props.disabled, '在途时档位下拉应当禁用（占位里没有可选项）').toBe(true)
    const noneTip = elementsOf(row).find((el) => el.props['data-tooltip'] === AUTO_ROUTE_EFFORT_NONE_HELP)
    expect(noneTip, '在途时绝不能挂「该模型无思考档位」—— 那是一个错误结论').toBeUndefined()
    const loadingTip = elementsOf(row).find((el) => el.props['data-tooltip'] === AUTO_ROUTE_EFFORT_LOADING_HELP)
    expect(loadingTip, '在途时应当说明「正在加载思考档位…」').toBeDefined()
    expect(AUTO_ROUTE_EFFORT_LOADING_HELP).toBe('正在加载思考档位…')
  })

  it('选「默认」清掉 effort 键（写空串会被服务端拒）', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    const row = rowsInCard(cardsOf(tree)[1]!)[1]!
    expect(menusIn(row)[2]!.menuProps!.selectedId, '初始应当是 high').toBe('high')

    selectInMenu(menusIn(row)[2]!, '')
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const after = rowsInCard(cardsOf(tree)[1]!)[1]!
    // 关键判据：`effort` **键被删掉**而不是留一个空串 —— 空串在写路径上非法。
    expect(menusIn(after)[2]!.menuProps!.selectedId, '「默认」= 不配 effort').toBeUndefined()
    expect(textsOf(after)).toContain('默认')
  })
})

describe('AutoRoutePanel：自动保存流（修改即保存）', () => {
  it('合法修改立即提交整组 models，成功后无错误行、草稿保留', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    typeInto(nameInputOf(cardsOf(tree)[0]!), '极速')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    const set = calls.find((c) => c.method === 'autoroute.set')
    expect(set, '合法修改应当立即写回 models').toBeDefined()
    // 载荷是**整组替换**（models 有序，逐条合并表达不了「删除」与「挪到队首」）。
    const payload = set!.payload as { models: typeof CONFIG.models }
    expect(Object.keys(payload), '提交只带 models，不重发 enabled').toEqual(['models'])
    expect(payload.models.map((d) => d.name)).toEqual(['极速', '强力'])
    expect(payload.models[0]!.entries).toEqual([{ provider: 'dsh', model: 'deepseek-v4' }])

    // 成功后：无错误行、草稿保留（本地值即提交值，宿主返回值一致时不覆盖）。
    expect(errorLinesOf(tree), '提交成功不该有错误行').toHaveLength(0)
    expect(nameInputOf(cardsOf(tree)[0]!).props.value).toBe('极速')
  })

  it('提交被拒：显示服务端中文错误、草稿原样保留，下一次合法修改再次提交', async () => {
    // 服务端 `assertValidAutoRouteConfig` 对「entries 为空」的定义会点名到定义名。
    const serverMessage = '自动模型『快速』缺少模型条目（至少一条 provider + model）'
    const { calls, rpcCall } = makeRpc({ setFails: serverMessage })
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    typeInto(nameInputOf(cardsOf(tree)[0]!), '极速')
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    expect(calls.some((c) => c.method === 'autoroute.set')).toBe(true)
    // 服务端原文（点名到具体定义）必须出现在面板内的红字行上。
    const errors = errorLinesOf(tree)
    expect(errors.join('\n'), '提交被拒必须显示服务端的中文错误原文').toContain(serverMessage)
    // 草稿**保留**：用户改了一堆东西，失败不该把它清掉。
    expect(nameInputOf(cardsOf(tree)[0]!).props.value, '提交失败后草稿必须保留').toBe('极速')
  })

  it('entries 为空的定义允许存在于草稿且**不触发提交**（中间态跳过，防线在服务端）', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    ;(findButtonByLabel(tree, '添加自动模型')!.props.onClick as () => void)()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)
    // 空 entries 的定义照样渲染出卡片与「添加模型」入口，没有任何前端拦截。
    const card = cardsOf(tree)[2]!
    expect(rowsInCard(card)).toHaveLength(0)
    expect(textsOf(card), '卡片头应当显示条目数').toContain('0 个模型条目')
    expect(findButtonByText(card, '添加模型'), '空定义仍要能加候选').toBeDefined()
    // 修改即保存的合法性闸：中间态不提交（提交必被服务端拒，白报错）。
    expect(calls.filter((c) => c.method === 'autoroute.set'), '空定义中间态不该触发提交').toHaveLength(0)
  })

  it('目录拉取失败：面板显示错误行 + 「重试」，重试成功后错误消失', async () => {
    // 目录是编辑器三个下拉的候选集：静默失败会让用户看到「一个模型都没有」——
    // 一个与真相相反、且无从自行恢复的结论（唯一出路是重进面板）。
    const { calls, rpcCall } = makeRpc({ catalogFailures: 1 })
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)

    const errors = errorLinesOf(tree)
    expect(errors.join('\n'), '目录失败必须在面板上说话，不能只 console.warn').toContain('模型目录读取失败：上游超时')
    // 面板**没有**变成错误页：已有的配置仍要看得到、改得动。
    expect(cardsOf(tree), '目录失败不该让配置消失').toHaveLength(2)
    // 下拉的候选集确实是空的 —— 这正是必须提示的原因。
    expect(menusIn(rowsInCard(cardsOf(tree)[0]!)[0]!)[0]!.menuProps!.items, '目录失败时供应商下拉为空').toEqual([])

    // 「重试」真的重拉：第二次成功 ⇒ 错误行消失、候选集回来。
    const retry = findButtonByText(tree, '重试')
    expect(retry, '目录失败必须给一条恢复路径（重试按钮）').toBeDefined()
    ;(retry!.props.onClick as () => void)()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    expect(errorLinesOf(tree).join('\n'), '重试成功后错误行应当消失').not.toContain('模型目录读取失败')
    expect(calls.filter((c) => c.method === 'autoroute.catalog').length, '重试必须真的重拉目录').toBeGreaterThan(1)
    expect(menusIn(rowsInCard(cardsOf(tree)[0]!)[0]!)[0]!.menuProps!.items!.map((i) => i.id),
      '重试成功后候选集应当回来').toEqual(['dsh', 'codearts'])
  })

  it('开关写入被拒：显示原因（而不是静默弹回）', async () => {
    // 开关**不做乐观更新**，被拒时弹回宿主值 —— 光弹回去等于「点了没反应」。
    const serverMessage = '自动路由开关写入被拒绝：该功能已被策略禁用'
    const { rpcCall } = makeRpc({ setFails: serverMessage })
    let tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    expect(switchOf(tree).props['aria-checked']).toBe(true)

    clickSwitch(tree)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks)

    expect(switchOf(tree).props['aria-checked'], '被拒后开关必须弹回宿主值').toBe(true)
    expect(errorLinesOf(tree).join('\n'), '开关被拒必须显示原因').toContain(serverMessage)
  })
})

describe('AutoRoutePanel：拖拽排序', () => {
  it('定义卡片整卡可拖：drop 后用 orderAfterDrop 的结果重排草稿', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await settle(client.AutoRoutePanel, props, client.hooks, true)
    expect(cardsOf(tree).map((c) => nameInputOf(c).props.value)).toEqual(['快速', '强力'])

    // 把第一张卡片拖到第二张的**下半区**（clientY 160 > 分界线 140）⇒ 落到其后。
    tree = await drag(tree, props, cardsOf, [
      { on: 0, type: 'start' },
      { on: 1, type: 'over', clientY: 160 },
      { on: 1, type: 'drop', clientY: 160 },
    ])

    expect(cardsOf(tree).map((c) => nameInputOf(c).props.value), '拖拽后顺序应当翻转').toEqual(['强力', '快速'])
    // 修改即保存：拖拽落定是合法编辑，drop 后立即写服务端。
    const set = calls.filter((c) => c.method === 'autoroute.set')
    expect(set, '拖拽排序应当立即触发 autoroute.set').toHaveLength(1)
    expect((set[0]!.payload as { models: Array<{ name: string }> }).models.map((d) => d.name), '载荷顺序与界面一致').toEqual(['强力', '快速'])
  })

  it('拖拽过程中给出插入线反馈，dragend 后临时状态清干净', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await settle(client.AutoRoutePanel, props, client.hooks, true)

    tree = await drag(tree, props, cardsOf, [{ on: 0, type: 'start' }])
    expect(cardsOf(tree)[0]!.props['data-dragging'], '源卡片应当淡出').toBe('true')

    tree = await drag(tree, props, cardsOf, [{ on: 1, type: 'over', clientY: 160 }])
    expect(cardsOf(tree)[1]!.props['data-dropAfter'], '下半区应当画「之后」的插入线').toBe('true')

    tree = await drag(tree, props, cardsOf, [{ on: 1, type: 'over', clientY: 110 }])
    expect(cardsOf(tree)[1]!.props['data-dropBefore'], '上半区应当画「之前」的插入线').toBe('true')
    expect(cardsOf(tree)[1]!.props['data-dropAfter']).toBeUndefined()

    tree = await drag(tree, props, cardsOf, [{ on: 1, type: 'end' }])
    for (const card of cardsOf(tree)) {
      expect(card.props['data-dragging'], 'dragend 后不得残留淡出态').toBeUndefined()
      expect(card.props['data-dropBefore'], 'dragend 后不得残留插入线').toBeUndefined()
      expect(card.props['data-dropAfter']).toBeUndefined()
    }
  })

  it('同一卡片内的候选行可拖：只在该卡片内落点，不影响别的定义', async () => {
    const { calls, rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await settle(client.AutoRoutePanel, props, client.hooks, true)
    const card = cardsOf(tree)[1]!
    expect(entryValuesOf(card).map((v) => v.provider), '初始：dsh 在前、codearts 在后')
      .toEqual(['dsh', 'codearts'])

    // 把第一行拖到第二行的下半区 ⇒ 候选顺序翻转。
    tree = await drag(tree, props, (current) => rowsInCard(cardsOf(current)[1]!), [
      { on: 0, type: 'start' },
      { on: 1, type: 'over', clientY: 160 },
      { on: 1, type: 'drop', clientY: 160 },
    ])

    const after = entryValuesOf(cardsOf(tree)[1]!)
    expect(after.map((v) => v.provider), '候选顺序应当翻转').toEqual(['codearts', 'dsh'])
    // 另一个定义的候选一行不动（拖拽作用域限定在所属卡片内）。
    expect(entryValuesOf(cardsOf(tree)[0]!).map((v) => v.provider)).toEqual(['dsh'])
    // 候选行没有自己的 id（宿主契约里没有这个字段），排序键是下标 —— 翻转后
    // 第一条候选的 provider 必须是原来第二条的 provider，这才证明是**搬了元素**
    // 而不是把取值改掉了。
    expect(after[0]!.model, '搬过来的是整条候选（含模型与档位）').toBe('glm-5')
    expect(after[0]!.effort, '档位跟着候选一起搬').toBe('high')

    // 修改即保存：候选行落定同样是合法编辑，drop 后立即**整组**提交目标列表。
    // 「另一张卡片一行不动」在界面上成立还不够 —— 载荷是整个 `models`，一旦提交时
    // 漏带或错带另一张卡片，服务端的 `models` 整组替换语义会把线上配置改坏。
    const set = calls.filter((c) => c.method === 'autoroute.set')
    expect(set, '候选行拖拽应当立即触发 autoroute.set').toHaveLength(1)
    const payload = set[0]!.payload as { models: typeof CONFIG.models }
    expect(payload.models.map((d) => d.name), '载荷仍是完整的目标列表').toEqual(['快速', '强力'])
    expect(payload.models[0]!.entries, '未被拖的定义原样带上').toEqual([{ provider: 'dsh', model: 'deepseek-v4' }])
    expect(payload.models[1]!.entries, '载荷里的候选顺序与界面一致').toEqual([
      { provider: 'codearts', model: 'glm-5', effort: 'high' },
      { provider: 'dsh', model: 'deepseek-v4' },
    ])
  })

  it('候选行拖拽会阻止冒泡：父定义卡不得覆盖 entry 的 drag 状态', async () => {
    const { rpcCall } = makeRpc()
    const props = panelProps(rpcCall)
    let tree = await settle(client.AutoRoutePanel, props, client.hooks, true)
    const card = cardsOf(tree)[1]!
    const sourceRow = rowsInCard(card)[0]!

    // 原生 DOM 会把事件从候选行冒泡到定义卡；候选行必须在此处截断。
    const start = dragEvent(150)
    ;(sourceRow.props.onDragStart as (event: DragEvent) => void)(start)
    if (!start.propagationStopped) {
      ;(card.props.onDragStart as (event: DragEvent) => void)(start)
    }
    expect(start.propagationStopped, '候选行 dragstart 必须阻止冒泡').toBe(true)

    tree = await settle(client.AutoRoutePanel, props, client.hooks)
    const afterStartCard = cardsOf(tree)[1]!
    expect(rowsInCard(afterStartCard)[0]!.props['data-dragging'], '源候选行应进入 dragging 态').toBe('true')
    expect(afterStartCard.props['data-dragging'], '父定义卡不得接管 entry 拖拽').toBeUndefined()

    const targetRow = rowsInCard(afterStartCard)[1]!
    const over = dragEvent(160)
    ;(targetRow.props.onDragOver as (event: DragEvent) => void)(over)
    if (!over.propagationStopped) {
      ;(afterStartCard.props.onDragOver as (event: DragEvent) => void)(over)
    }
    expect(over.propagationStopped, '候选行 dragover 必须阻止冒泡').toBe(true)
    expect(over.prevented, '候选行 dragover 必须允许浏览器 drop').toBe(1)

    tree = await settle(client.AutoRoutePanel, props, client.hooks)
    const afterOverCard = cardsOf(tree)[1]!
    expect(rowsInCard(afterOverCard)[1]!.props['data-dropAfter']).toBe('true')

    const drop = dragEvent(160)
    const afterOverTarget = rowsInCard(afterOverCard)[1]!
    ;(afterOverTarget.props.onDrop as (event: DragEvent) => void)(drop)
    if (!drop.propagationStopped) {
      ;(afterOverCard.props.onDrop as (event: DragEvent) => void)(drop)
    }
    tree = await settle(client.AutoRoutePanel, props, client.hooks)
    expect(entryValuesOf(cardsOf(tree)[1]!).map((entry) => entry.provider), '冒泡路径 drop 后候选顺序应翻转')
      .toEqual(['codearts', 'dsh'])
  })

  it('只有一张卡片 / 一行候选时不启用拖拽（拖了也无处可落）', async () => {
    const { rpcCall } = makeRpc({
      config: { enabled: false, models: [{ id: 'only', name: '唯一', entries: [{ provider: 'dsh', model: 'deepseek-v4' }] }] },
    })
    const tree = await settle(client.AutoRoutePanel, panelProps(rpcCall), client.hooks, true)
    expect(cardsOf(tree)[0]!.props.draggable, '单张卡片不该可拖').toBeUndefined()
    expect(rowsInCard(cardsOf(tree)[0]!)[0]!.props.draggable, '单条候选不该可拖').toBeUndefined()
  })
})

/**
 * 替身**自身**的契约：`Menu` 必须把菜单项的 `disabled` 透传到宿主 `button` 上。
 *
 * 真件 `Menu.tsx` 的菜单行是 `<button disabled={entry.disabled}>`，且真件的键盘
 * 导航只认 `button:not(:disabled)` —— 替身漏掉它，spec 就**永远拿不到**「这一项确实
 * 不可选」这个事实（只能靠「调用点没传 disabled」间接推断，而那正是错的推断方向）。
 *
 * 为什么不走被测组件：`AutoRouteSelect` 确实会把 `option.disabled` 映射进
 * `items`（`account-hub.js` 的 `disabled: option.disabled === true`），但当前
 * `catalog` / `effortOptions` 里没有任何一条候选带 `disabled: true`，故这条契约在
 * 组件路径上不可观测。直接对替身断言，是让这条**替身漂移**（替身比真件弱）在将来
 * 被引入时立刻红掉的唯一办法。
 */
describe('ui-primitives 替身：Menu 菜单项的 disabled 透传', () => {
  /** 用一个最小 React 元素树渲染替身的 Menu（展开态）。 */
  const renderMenu = (items: Array<{ id: string; label: string; disabled?: boolean }>): ElementNode => {
    const anchor = { type: 'button', props: {}, children: [] }
    const node = client.primitives.Menu({
      open: true,
      anchor,
      items,
      selectedId: undefined,
      onSelect: () => {},
      onClose: () => {},
    })
    if (!isElement(node)) throw new Error('Menu 替身没有返回元素节点')
    return node
  }

  it('item.disabled === true → 渲染出的 role="menuitem" 行带 disabled', () => {
    const tree = renderMenu([
      { id: 'a', label: '可选项' },
      { id: 'b', label: '禁选项', disabled: true },
    ])
    const rows = elementsOf(tree).filter((el) => el.props.role === 'menuitem')
    expect(rows, '展开态应当渲染两条菜单行').toHaveLength(2)
    expect(rows[0]!.props.disabled, '未标 disabled 的行不该被禁用').toBeUndefined()
    // 真件把 `entry.disabled` 原样交给宿主 button：undefined / false / true 都照传，
    // 由宿主 DOM 决定「不可点」。断言值本身（而不是「真值」）才能钉住这条同形性。
    expect(rows[1]!.props.disabled, 'item.disabled 必须透传成宿主 button 的 disabled').toBe(true)
  })

  it('未给 disabled 的菜单项不带该属性（不能凭空给 false 之外的东西）', () => {
    const tree = renderMenu([{ id: 'a', label: '唯一' }])
    const row = elementsOf(tree).filter((el) => el.props.role === 'menuitem')[0]!
    expect(row.props.disabled).toBeUndefined()
    // 反向锚点：替身确实渲染了菜单行（否则上面那条在零节点时也成立）。
    expect(textsOf(row)).toEqual(['唯一'])
  })
})

describe('AccountHubPage：左侧「自动路由」选项卡', () => {
  const tabsOf = (tree: unknown): ElementNode[] =>
    elementsOf(tree).filter((el) => el.type === 'button' && el.props.role === 'tab')

  /** 导航里 provider tab 与自动路由 tab 的可见文案。 */
  const tabLabelsOf = (tree: unknown): string[] => tabsOf(tree).map((el) => textsOf(el).join(''))

  it('导航含恰好一个「自动路由」入口，七个 provider tab 一个不少', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks, true)
    const labels = tabLabelsOf(tree)
    expect(labels, '导航应当是 7 个 provider + 1 个自动路由').toHaveLength(8)
    for (const label of ['Codearts', 'Buddy CN', 'Buddy', 'LobsterAI', 'Trae CN', 'Qoder', 'Qoder CN']) {
      expect(labels, `导航里缺少 ${label}`).toContain(label)
    }
    expect(labels.filter((label) => label === '自动路由'), '自动路由入口应当恰好一个').toHaveLength(1)
    // 默认选中仍是第一个 provider（自动路由不该抢初始选中）。
    const selected = tabsOf(tree).filter((el) => el.props['aria-selected'] === true)
    expect(selected.map((el) => textsOf(el).join(''))).toEqual(['Codearts'])
  })

  it('「自动路由」入口在供应商折叠组**之外**（折叠供应商不该藏掉它）', async () => {
    const { rpcCall } = makeRpc()
    const tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks, true)
    const autoRouteTab = tabsOf(tree).find((el) => textsOf(el).join('') === '自动路由')!
    const groupTitle = elementsOf(tree)
      .find((el) => el.props['data-disclosure-row'] === true && el.props.role === 'button')!
    expect(
      flatten(groupTitle).includes(autoRouteTab),
      '自动路由入口被塞进了供应商折叠组：折叠供应商会顺手藏掉一个与供应商无关的入口',
    ).toBe(false)
    // 位置判据的行为级补充：折叠后它仍在。
    ;(groupTitle.props.onClick as () => void)()
    const collapsed = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks)
    expect(tabLabelsOf(collapsed), '折叠后应当只剩自动路由入口').toEqual(['自动路由'])
  })

  it('点击切到自动路由面板：provider 面板卸载、tab 变选中态、面板拉自己的配置', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks, true)
    const initialPanel = elementsOf(tree)
      .find((el) => el.type === 'section' && el.props['aria-label'] === '账号管理')
    expect(initialPanel, '初始 provider 面板 aria-label 应为纯「账号管理」').toBeDefined()
    const initialTitle = elementsOf(tree)
      .find((el) => el.props.className === 'dim-ah-panelTitle')
    expect(textsOf(initialTitle!).join(''), 'provider 面板 h2 应为纯「账号管理」')
      .toBe('账号管理')

    const autoRouteTab = tabsOf(tree).find((el) => textsOf(el).join('') === '自动路由')!
    ;(autoRouteTab.props.onClick as () => void)()
    tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks)

    const autoRoutePanel = elementsOf(tree)
      .find((el) => el.props.className === 'dim-ah-arPage')
    expect(autoRoutePanel, '点击后应当渲染自动路由面板').toBeDefined()
    expect(switchOf(tree).props['aria-label'], '自动路由开关可读名缺失')
      .toBe('启用自动路由')
    expect(
      elementsOf(tree).some((el) => el.type === 'section' && el.props['aria-label'] === '账号管理'),
      '切走后 provider 面板应卸载（不该留下账号管理 section）',
    ).toBe(false)
    expect(
      tabsOf(tree).filter((el) => el.props['aria-selected'] === true).map((el) => textsOf(el).join('')),
      '自动路由 tab 应当变成选中态',
    ).toEqual(['自动路由'])
    // 切换语义与 provider tab 一致：新面板挂载即拉自己的配置。
    expect(calls.some((c) => c.method === 'autoroute.get'), '切过去应当拉 autoroute.get').toBe(true)
  })

  it('切回 provider 后自动路由面板卸载（同一时刻只有一个面板）', async () => {
    const { rpcCall } = makeRpc()
    let tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks, true)
    ;(tabsOf(tree).find((el) => textsOf(el).join('') === '自动路由')!.props.onClick as () => void)()
    tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks)
    ;(tabsOf(tree).find((el) => textsOf(el).join('') === 'Buddy CN')!.props.onClick as () => void)()
    tree = await settle(client.AccountHubPage, panelProps(rpcCall), client.hooks)

    expect(elementsOf(tree).some((el) => el.props.className === 'dim-ah-arPage'),
      '切回 provider 后自动路由面板应当卸载').toBe(false)
  })

  /**
   * 跨端 id 一致性：客户端 `AUTO_ROUTE_TAB_ID` 与服务端 `AUTO_ROUTE_PROVIDER_ID`
   * **同值是刻意设计**，但此前没有任何测试钉住它。
   *
   * 两个常量各自活在自己的语言边界里（客户端源码是纯 JS、服务端是 TS 模块），
   * 客户端那边**读不到**服务端常量（临时目录里的 CJS 装载器没有 `src/`），故这里
   * 用 `constValueOf` 从被测源码里读出客户端值，再与服务端 import 的那个比对 ——
   * 本 spec 是唯一**同时**够得着两侧的地方（既有 import 机制见文件头）。
   *
   * 漂移的后果是静默的：客户端 tab 切到一个服务端不认识的 id 上，`autoroute.get`
   * 照常返回配置（它是全局配置、不收 provider 参数），面板看起来一切正常，而
   * `selectProvider(AUTO_ROUTE_TAB_ID)` 与宿主目录里的 provider id 已经不是同一个
   * 字符串了 —— 这类「看起来能跑」的分叉只有逐字比对才抓得住。
   */
  it('客户端 tab id 与服务端 provider id 同值（跨端契约，刻意设计）', () => {
    expect(constValueOf('AUTO_ROUTE_TAB_ID')).toBe(AUTO_ROUTE_PROVIDER_ID)
  })

  it('「自动路由」图标容器走 token 而不是品牌色豁免', async () => {
    // 品牌色豁免（字面量 white）只覆盖七个第三方产品的官方图标；自动路由是本插件
    // 自己的功能入口，配色必须来自设计体系 —— 这条断言把两者的分界线钉死。
    const styles = readFileSync(resolve(here, '../../plugin-src/client/account-hub-styles.js'), 'utf8')
    const at = styles.indexOf('.dim-ah-providerIcon.ar {')
    expect(at, 'account-hub-styles.js 里找不到 .dim-ah-providerIcon.ar 规则').toBeGreaterThan(-1)
    const rule = styles.slice(at, styles.indexOf('}', at))
    expect(rule, '自动路由图标背景必须走 token').toContain('var(--dsw-alias-state-business-primary)')
    expect(rule, '自动路由图标不得使用品牌色豁免的字面量').not.toContain('white')
    expect(rule, '自动路由图标不得出现十六进制字面量').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // 反向锚点：七个 provider 的白底仍在（豁免没被顺手删掉）。
    expect(styles).toContain('.dim-ah-providerIcon.codearts { background: white; }')
  })
})
