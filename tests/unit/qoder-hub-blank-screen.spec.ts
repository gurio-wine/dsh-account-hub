/**
 * 「点击 + 新建账号 → 整个 Account Hub 白屏」的根因回归测试。
 *
 * ## 用户报障（2026-09-21）
 *
 * > qoder点击新建账号直接Hub界面空了
 *
 * 时间点很关键：这是 `2015b03`（Qoder 浏览器设备流登录）第一次**真正跑起来**。
 * 该提交给 Qoder 加了「浏览器登录 / 粘贴 PAT」二选一的登录形态选择器，
 * 而这个选择器的渲染路径上有一个**自由变量**，只有真机首次点击才会走到。
 *
 * ## 为什么 2402 个测试全绿却真机白屏
 *
 * 根因是 `ProviderPanel` 里这一行：
 *
 * ```js
 * loginChoiceOpen && patLogin
 *   ? React.createElement(LoginChoiceForm, {
 *       productLabel: label,   // ← label 在 ProviderPanel 作用域里根本不存在
 * ```
 *
 * `label` 只作为**局部变量**存在于两个完全无关的地方：
 *   - `formatClaimFailureLine`（第 520 行）里的 `const label = result?.nickname || …`；
 *   - `PROVIDERS` 条目的 `label` 字段。
 * 二者都不是 `ProviderPanel` 能看到的绑定，故这一行是 `ReferenceError: label is
 * not defined`，而**不是** `undefined`。
 *
 * 三道既有闸门为什么都拦不住：
 *
 * | 闸门 | 为什么看不见 |
 * |---|---|
 * | `tsc --noEmit` | `plugin-src/` 不在 `tsconfig.json` 的 include 里（只有 `src/`） |
 * | `vitest` | 不用 `__testExports` 之外的代码：`ProviderPanel` 用了 hooks，而 react 不在依赖里，既有测试只能**源码切片 / 正则**断言，从不真的渲染它 |
 * | `build:client` 冒烟 | 只求值 bundle **顶层**；`ProviderPanel` 的函数体从未被调用 |
 *
 * 于是「自由变量」这一类缺陷在三道闸门之间恰好掉进缝里 —— 正则能看到
 * `productLabel: label` 这串字符，但看不出 `label` 是个未绑定标识符。
 *
 * ## 为什么症状是「白屏」而不是「报错」
 *
 * 三元表达式的对象字面量**只在条件为真时求值**：
 *   - `loginChoiceOpen` 初始为 `false` → 整个 Hub 页面渲染正常，用户看到面板；
 *   - 点击「+ 新建账号」→ `setLoginChoiceOpen(true)` → 重新渲染 → 对象字面量
 *     求值 → `ReferenceError` 从 render 中抛出 → 该子树所属的 React 根没有错误
 *     边界 → **整棵树卸载** → 整页空白。
 *
 * 这精确复现了报障措辞：「点击新建账号**直接**空了」—— 点击**之前**页面是好的，
 * 点击**那一瞬间**才炸，且没有任何可见错误（异常只进控制台）。
 *
 * ## 本文件的做法：真的把 `ProviderPanel` 渲染出来
 *
 * 与既有的源码切片断言不同，这里补一个**带 hooks 的最小 react 运行器**，
 * 让面板真的渲染、真的派发点击、真的重渲染。这样「自由变量」会在测试里以
 * 与真机**同一个异常**暴露出来，而不是靠人去读正则。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 一个**带 hooks 的** react 占位模块。
 *
 * 既有测试用的占位只有 `createElement`（元素树是普通对象，够做整树深比较），
 * 但深度比较**不会执行组件函数体**，因此看不见自由变量。这里补上
 * `useState` / `useRef` / `useCallback` / `useEffect` 的最小实现。
 *
 * 三条与真实 react 对齐的语义（缺一条就会测出假结论）：
 *
 * 1. **hooks 槽位按组件实例隔离**（`storeFor(fn)`），不是一份全局数组。
 *    全局槽位在「面板里嵌了子组件」时必然错位 —— 本文件第一版就是全局槽位，
 *    表现为子组件渲染不出来、文案断言失败，而代码其实是好的。
 * 2. **依赖数组真的比对**（`Object.is` 逐项）。面板的挂载 effect 依赖
 *    `[provider]`；若每轮渲染都无条件重跑，它会无限地重新发起 `account.list`
 *    → setState → 再渲染，驱动器永远等不到稳定。修法是补上依赖语义，
 *    而**不是**放宽驱动器的收敛条件 —— 后者会让「真的死循环」也冒充通过。
 * 3. **cleanup 在 effect 重跑之前执行**，不是紧随其后。本文件第一版一跑完
 *    就调 cleanup，于是 `mounted.current` 立刻变回 false，异步的
 *    `loadAccounts` 结果被丢弃、`phase` 永远停在 loading —— 断言会看到
 *    「正在读取账号列表…」而不是真实渲染结果。
 *
 * `setState` 只把 `dirty` 置位，由驱动器决定何时重渲染；`__renderComponent`
 * 负责切换当前组件实例，使子组件（`ProviderLogo` / `LoginChoiceForm` …）
 * 拥有自己的槽位。
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

/** 像 react 那样调用一个函数组件：切到它的实例槽位，渲染完再切回来。 */
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
exports.__drainEffects = function () {
  var queued = effectQueue;
  effectQueue = [];
  for (var i = 0; i < queued.length; i++) {
    // cleanup 先于本次执行：与 react 一致（依赖变化时先清理上一次）。
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

/** 与既有客户端测试同款的 import 改写（逐条断言命中）。 */
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
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' JetHubPage: JetHubPage, ProviderPanel: ProviderPanel, LoginChoiceForm: LoginChoiceForm };\n',
  )
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __isDirty: () => boolean
  __clearDirty: () => void
  __drainEffects: () => void
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

/**
 * 最小 `window` 替身。
 *
 * 浏览器登录路径（`createAccount`）第一件事就是 `window.open('', …)` 抢用户
 * 手势 —— Node 里没有 `window`，不补就会以 `ReferenceError: window is not
 * defined` 失败，而那是**测试环境**的缺失、不是被测代码的缺陷（真机上这一步
 * 完全正常）。
 *
 * 返回的「窗口」只要够 `createAccount` 用即可：`closed` 为 false（走
 * 「手势内开的空窗还在」那一支）、`location.replace` 记下被导航到的 URL、
 * `close()` 置 `closed`。这样点击路径会完整跑完，而不是在开窗处短路 ——
 * 短路掉的话，开窗**之后**的代码（`res.accountId` 分支、轮询、错误处理）
 * 就全都测不到了。
 */
interface StubWindow {
  closed: boolean
  navigatedTo: string[]
  close: () => void
}

function installWindowStub(): { opened: StubWindow[]; restore: () => void } {
  const opened: StubWindow[] = []
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    open: () => {
      const stub: StubWindow = {
        closed: false,
        navigatedTo: [],
        close() { stub.closed = true },
      }
      // 真实窗口对象上 `location` 是只读的；这里用可变对象即可，
      // 被测代码只调 `location.replace`，不重新赋值 location 本身。
      ;(stub as unknown as { location: { replace: (url: string) => void } }).location = {
        replace(url: string) { stub.navigatedTo.push(url) },
      }
      opened.push(stub)
      return stub
    },
  }
  return {
    opened,
    restore: () => { (globalThis as { window?: unknown }).window = previous },
  }
}

function loadClientModule(): {
  JetHubPage: (props: Record<string, unknown>) => unknown
  ProviderPanel: (props: Record<string, unknown>) => unknown
  LoginChoiceForm: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'jet-hub-blank-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeFileSync(join(dir, 'jet-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'jet-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  const exported = loaded.__testExports
  return {
    JetHubPage: exported.JetHubPage as (props: Record<string, unknown>) => unknown,
    ProviderPanel: exported.ProviderPanel as (props: Record<string, unknown>) => unknown,
    LoginChoiceForm: exported.LoginChoiceForm as (props: Record<string, unknown>) => unknown,
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

/**
 * 把函数组件展开成它的返回树（递归），其余节点原样保留。
 *
 * 真实 react 在渲染时会调用函数组件；占位 `createElement` 只把组件**记成**
 * `type`，不调用它。于是「子树里的文案」在未展开时根本不在树上 ——
 * `textsOf` 会看不到 `LoginChoiceForm` 渲染出来的那段话。
 *
 * 本文件第一版就踩了这个：修好自由变量之后断言仍然红，报「树里找不到
 * Qoder 支持两种登录方式」，而字符串其实就在下一层组件里。
 *
 * 必须经 `__renderComponent` 调用而不是直接 `node.type(props)`：前者会切到
 * 该组件的 hooks 实例槽位，后者会让子组件的 hooks 写进父组件的槽位。
 */
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

/** 按可见文本找一个节点（用于拿按钮的 onClick）。 */
function findByText(node: unknown, text: string): ElementNode | undefined {
  return flatten(node).filter(isElement).find((el) => textsOf(el).includes(text))
}

/**
 * 按可见文本找**按钮**节点。
 *
 * 不能直接用 {@link findByText}：外层 `section` / `div` 的子树里同样含这段
 * 文本，而它们**没有** `onClick` —— 那会拿到一个 `props.onClick === undefined`
 * 的容器，点击断言变成 `TypeError: onClick is not a function`（本文件第一版
 * 就是这么失败的），与要验的自由变量毫无关系。
 */
function findButtonByText(node: unknown, text: string): ElementNode | undefined {
  return flatten(node)
    .filter(isElement)
    .find((el) => el.type === 'button' && textsOf(el).includes(text))
}

/**
 * 渲染驱动器：反复「渲染 → 跑 effect → 排空微任务」，直到没有 setState 排队。
 *
 * effect 里发起的 `account.list` 是异步的，其结果通过 setState 回灌，
 * 故必须在每个 pass 之后让微任务队列排空，否则 `phase` 永远停在 loading。
 *
 * 每次渲染都经 `hooks.__renderComponent`，让面板拿到属于它自己的 hooks 槽位。
 */
async function renderStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  let tree: unknown
  for (let pass = 0; pass < 20; pass++) {
    hooks.__clearDirty()
    tree = hooks.__renderComponent(Component, props)
    hooks.__drainEffects()
    // 让 effect 里发起的 promise 结算（loadAccounts / loadCredits 各一层）。
    for (let i = 0; i < 10; i++) await Promise.resolve()
    if (!hooks.__isDirty()) return tree
  }
  throw new Error('渲染在 20 个 pass 内没有稳定：疑似 setState 循环')
}

const client = loadClientModule()

/** 一个记录调用的 rpcCall 替身。 */
function makeRpc() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') return { accounts: [] }
    if (method === 'credits.balances') return { accounts: [] }
    return {}
  }
  return { calls, rpcCall }
}

describe('「+ 新建账号」点击后 Hub 白屏（真机首跑暴露的自由变量）', () => {
  it('点击 qoder 的「+ 新建账号」不得抛出 ReferenceError', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(
      client.ProviderPanel,
      { provider: 'qoder', rpcCall },
      client.hooks,
    )

    const button = findButtonByText(tree, '+ 新建账号')
    expect(button, '面板里找不到「+ 新建账号」按钮').toBeDefined()

    // 真机路径：点击 → setLoginChoiceOpen(true) → 重渲染。
    // 修复前这一步**本身**不抛（它只是 setState），真正的崩溃点是紧接着的
    // 那一轮渲染 —— 见下面的断言。
    const onClick = button!.props.onClick as () => void
    expect(typeof onClick).toBe('function')
    expect(() => onClick()).not.toThrow()

    // 重渲染就是崩溃点：`label` 在 LoginChoiceForm 的 props 对象字面量里，
    // 而对象字面量只在条件为真时求值 —— 所以异常必然发生在点击后的这一轮，
    // 点击之前的所有渲染都是好的（正是报障措辞「点击新建账号**直接**空了」）。
    client.hooks.__clearDirty()
    expect(() => client.hooks.__renderComponent(client.ProviderPanel, { provider: 'qoder', rpcCall }))
      .not.toThrow()
  })

  it('选择器渲染出来的产品名取自 PROVIDERS，而不是未绑定标识符', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(
      client.ProviderPanel,
      { provider: 'qoder', rpcCall },
      client.hooks,
    )
    const button = findButtonByText(tree, '+ 新建账号')
    expect(button, '面板里找不到「+ 新建账号」按钮').toBeDefined()
    ;(button!.props.onClick as () => void)()

    // 展开子组件：选择器是嵌在面板返回树里的一个 `React.createElement(LoginChoiceForm, …)`，
    // 不展开就看不清它渲染出来的文案。
    client.hooks.__clearDirty()
    const afterClick = expandTree(
      client.hooks.__renderComponent(client.ProviderPanel, { provider: 'qoder', rpcCall }),
      client.hooks,
    )

    // 面板 id 是 `qoder`，而**显示名**是 `Qoder`（PROVIDERS 条目的 label）。
    // 断言显示名而不是 id：这条同时排除「随手写成 provider」的替代修法。
    expect(textsOf(afterClick).join('')).toContain('Qoder 支持两种登录方式')
    // 反面锚点：选择器确实出来了（否则上面那句在回归成「点击无反应」时也会绿）。
    expect(findButtonByText(afterClick, '浏览器登录'), '选择器没有渲染出来').toBeDefined()
  })
})

describe('LoginChoiceForm 的 productLabel 取自 PROVIDERS 表', () => {
  it('两个 region 各自拿到自己的显示名（不是 id、也不是同一个值）', () => {
    const qoder = client.LoginChoiceForm({
      productLabel: 'Qoder',
      onBrowserLogin: () => {},
      onPatLogin: () => {},
      onCancel: () => {},
    })
    const qoderCn = client.LoginChoiceForm({
      productLabel: 'Qoder CN',
      onBrowserLogin: () => {},
      onPatLogin: () => {},
      onCancel: () => {},
    })
    expect(textsOf(qoder).join('')).toContain('Qoder 支持两种登录方式')
    expect(textsOf(qoderCn).join('')).toContain('Qoder CN 支持两种登录方式')
  })
})

describe('整页渲染与逐面板冒烟（Hub 白屏类缺陷的通盘闸门）', () => {
  /**
   * 八个 provider 的全集，**写死**而不是从 `PROVIDERS` 读。
   *
   * 从被测源码里读列表会让「新增 provider 忘了接线」这类缺陷自动通过
   * （新条目被顺带测到，但若它本身没被渲染，测试也发现不了）。
   * 写死的一份在条目增减时会红，逼人回来确认 —— 那正是这条测试的价值。
   */
  const ALL_PROVIDERS = [
    'codearts',
    'buddy-cn',
    'buddy',
    'lobsterai',
    'trae-cn',
    'trae-cn-work',
    'qoder',
    'qoder-cn',
  ] as const

  it('JetHubPage 整页渲染不抛错，且八个 provider 的导航项都在', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(client.JetHubPage, { rpcCall }, client.hooks)
    const expanded = expandTree(tree, client.hooks)
    const text = textsOf(expanded).join('')

    // 页面骨架必须在（这是「Hub 界面」本身）。
    expect(text).toContain('Account Hub')
    // 导航渲染的是**显示名**而不是 id（`label`），故这里逐个断言显示名 ——
    // 拿 id 去比会误报（第一版就是这么红的）。
    // 同时断言导航按钮的数量：只比文案的话，某个条目渲染成空壳也算过。
    const navButtons = flatten(expanded)
      .filter(isElement)
      .filter((el) => el.type === 'button' && el.props.role === 'tab')
    expect(navButtons, '导航项数量与 provider 数量不一致').toHaveLength(ALL_PROVIDERS.length)
    for (const label of ['Codearts', 'Buddy CN', 'Buddy', 'LobsterAI', 'Trae CN', 'Trae CN Work', 'Qoder', 'Qoder CN']) {
      expect(text, `导航里缺少 ${label}`).toContain(label)
    }
    // 未选中的 provider 不该出现面板（`JetHubPage` 只挂载 selected 那一个）。
    expect(text).toContain('Codearts 账号管理')
  })

  it('逐个 provider 渲染面板并点击「+ 新建账号」，一律不得抛错', async () => {
    // 这是本次白屏的**通盘**闸门：不再只盯 qoder，而是把八个面板都真的渲染
    // 一遍、把每个能点的登录按钮都点一次。自由变量、未定义导出、缺字段的
    // 条目 —— 无论落在哪个 provider 上，都会在这里炸出来。
    const windowStub = installWindowStub()
    try {
      for (const provider of ALL_PROVIDERS) {
        const { rpcCall } = makeRpc()
        const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
        expect(() => expandTree(tree, client.hooks), `${provider} 渲染抛错`).not.toThrow()

        // 有登录入口的面板（除 Trae CN Work）都必须能点，且点完不炸。
        const button = findButtonByText(tree, '+ 新建账号')
        if (provider === 'trae-cn-work') {
          // 共用账号：刻意不渲染按钮，改为常驻提示行（见 providerLoginHint）。
          expect(button, 'Trae CN Work 不该有新建账号按钮').toBeUndefined()
          continue
        }
        expect(button, `${provider} 缺少「+ 新建账号」按钮`).toBeDefined()
        const openedBefore = windowStub.opened.length
        const onClick = button!.props.onClick as () => void
        expect(() => onClick(), `${provider} 点击抛错`).not.toThrow()
        client.hooks.__clearDirty()
        const afterClick = expandTree(
          client.hooks.__renderComponent(client.ProviderPanel, { provider, rpcCall }),
          client.hooks,
        )
        expect(() => afterClick, `${provider} 点击后重渲染抛错`).not.toThrow()
        // 点击必须**产生效果**，不能是「点了没反应」：
        //   - 浏览器登录 → 手势内开窗（`window.open` 被调用）；
        //   - 形态选择器 → 选择器渲染出来。
        // 两条满足其一即可（Qoder 两区当前走后者；PAT 形态移除后走前者）。
        // 这条反向锚点很关键：若将来有人把 onClick 改成空实现，
        // 上面那句「不抛错」照样是绿的。
        const openedWindow = windowStub.opened.length > openedBefore
        const showedChooser = findButtonByText(afterClick, '浏览器登录') !== undefined
        expect(
          openedWindow || showedChooser,
          `${provider} 点击后既没有开窗、也没有渲染选择器（点了没反应）`,
        ).toBe(true)
      }
    } finally {
      windowStub.restore()
    }
  })

  it('每个 provider 的显示名都取自 PROVIDERS（面板标题不是裸 id）', async () => {
    // 面板标题此前重复了三次 `PROVIDERS.find(...)?.label || provider` 内联表达式，
    // 现已收敛到 providerLabel 一个绑定。这条断言同时守住收敛本身：
    // 标题必须真的是**显示名**（Qoder、Buddy CN…），而不是 id。
    const DISPLAY: Record<string, string> = {
      codearts: 'Codearts',
      'buddy-cn': 'Buddy CN',
      buddy: 'Buddy',
      lobsterai: 'LobsterAI',
      'trae-cn': 'Trae CN',
      'trae-cn-work': 'Trae CN Work',
      qoder: 'Qoder',
      'qoder-cn': 'Qoder CN',
    }
    for (const provider of ALL_PROVIDERS) {
      const { rpcCall } = makeRpc()
      const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
      expect(textsOf(tree).join(''), provider).toContain(`${DISPLAY[provider]} 账号管理`)
    }
  })
})
