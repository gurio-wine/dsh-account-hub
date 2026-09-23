/**
 * 「点击 登录账号（旧文案「+ 新建账号」）→ 整个 Hub 白屏」的根因回归测试。
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
 * 根因是 `ProviderPanel` 里给 `LoginChoiceForm` 传 props 的那一行写成了
 * `productLabel: label`，而 `label` 在那个位置**没有任何绑定**：
 *
 * `label` 只作为**局部变量**存在于两个完全无关的地方：
 *   - `formatClaimFailureLine` 里的 `const label = result?.nickname || …`；
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
 *   - 点击「登录账号」→ `setLoginChoiceOpen(true)` → 重新渲染 → 对象字面量
 *     求值 → `ReferenceError` 从 render 中抛出 → 该子树所属的 React 根没有错误
 *     边界 → **整棵树卸载** → 整页空白。
 *
 * 这精确复现了报障措辞：「点击新建账号**直接**空了」—— 点击**之前**页面是好的，
 * 点击**那一瞬间**才炸，且没有任何可见错误（异常只进控制台）。
 *
 * ## ⚠️ 本次改动后本文件守护什么
 *
 * PAT 登录形态已于同日按用户要求整体移除（「我说不要pat登录，只要浏览器登录了」），
 * 故 `LoginChoiceForm` / `patLogin` 那条具体路径**已不存在**，上面那段根因叙述
 * 是历史记录。本文件继续守的是**这一类缺陷**，而不是那一行代码：
 *
 *   - 真的渲染 `ProviderPanel` / `AccountHubPage`、真的派发点击、真的重渲染；
 *   - 八个 provider 逐个冒烟，点击必须**有反应**（浏览器登录 → 开窗）；
 *   - 面板标题必须取显示名而不是裸 id。
 *
 * 换句话说：再有人在 render 路径上写一个自由变量、或在某个 provider 分支上
 * 访问了不存在的字段，都会在这里以真机同一个异常炸出来。
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
  [
    /^import \{ orderAfterDrop, dropPositionFromPointer \} from '\.\/account-order\.js';$/m,
    "const { orderAfterDrop, dropPositionFromPointer } = require('./account-order.js');",
  ],
]

/**
 * 把 `./account-order.js` 按与 `toCjs` 同一套规则转成 CJS 写进临时目录。
 *
 * `account-hub.js` 现在 import 了它（拖拽排序）：**新增 import 必须同时改
 * `IMPORT_REWRITES` 和这里**。只改前者的话改写规则会命中、而 `require` 在临时
 * 目录里找不到文件，本文件以 `Cannot find module` **整体加载失败** ——
 * 白屏闸门直接失效（不是变红，是不再守护任何东西）。
 *
 * 放**真件**：本文件会真的渲染 `ProviderPanel`，而它的拖拽属性构造里用到
 * `orderAfterDrop`；换成空占位就会掩盖「渲染路径上真的调了它」这件事。
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
  AccountHubPage: (props: Record<string, unknown>) => unknown
  ProviderPanel: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-blank-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeOrderModule(dir)
  writeFileSync(join(dir, 'account-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'account-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  const exported = loaded.__testExports
  return {
    AccountHubPage: exported.AccountHubPage as (props: Record<string, unknown>) => unknown,
    ProviderPanel: exported.ProviderPanel as (props: Record<string, unknown>) => unknown,
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

describe('「登录账号」点击后 Hub 白屏（真机首跑暴露的自由变量）', () => {
  it('点击 qoder 的「登录账号」不得抛错，且必须真的开窗', async () => {
    // 根因叙述见文件头：当年崩在 `LoginChoiceForm` 的 props 对象字面量里那个
    // 自由变量上。PAT 形态移除后那条具体路径没有了，但**这一类**缺陷仍会在这
    // 三条断言上炸出来（渲染 → 点击 → 点击后重渲染）。
    const windowStub = installWindowStub()
    try {
      const { rpcCall } = makeRpc()
      const tree = await renderStable(
        client.ProviderPanel,
        { provider: 'qoder', rpcCall },
        client.hooks,
      )

      const button = findButtonByText(tree, '登录账号')
      expect(button, '面板里找不到「登录账号」按钮').toBeDefined()

      const onClick = button!.props.onClick as () => void
      expect(typeof onClick).toBe('function')
      expect(() => onClick()).not.toThrow()

      // 点击后重渲染（真机上 setState 之后必然发生）：
      // 任何在 render 路径上求值的坏表达式都会在这里抛。
      client.hooks.__clearDirty()
      expect(() => client.hooks.__renderComponent(client.ProviderPanel, { provider: 'qoder', rpcCall }))
        .not.toThrow()

      // 反向锚点：点击必须**有反应**。少了这条，「onClick 被改成空实现」
      // 也能让上面那句 not.toThrow() 绿着 —— 那只证明了没炸，没证明能用。
      // PAT 移除后 Qoder 走的正是浏览器登录，故必须开窗。
      expect(windowStub.opened.length, 'Qoder 点击应当走浏览器登录并开窗').toBe(1)
    } finally {
      windowStub.restore()
    }
  })

  it('Qoder 两区都走浏览器登录：点击一律开窗、且不再有任何 PAT 表单', async () => {
    // 用户要求「不要 pat 登录，只要浏览器登录」的可执行形式：
    // 两个 region 的登录入口都**只有**浏览器设备流这一条。
    const windowStub = installWindowStub()
    try {
      for (const provider of ['qoder', 'qoder-cn']) {
        const { rpcCall } = makeRpc()
        const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
        const button = findButtonByText(tree, '登录账号')
        expect(button, `${provider} 缺少「登录账号」按钮`).toBeDefined()

        const before = windowStub.opened.length
        ;(button!.props.onClick as () => void)()
        expect(windowStub.opened.length, `${provider} 点击没有开窗`).toBe(before + 1)

        // 面板里不得再有 PAT 相关的输入框/链接（表单已整体删除）。
        client.hooks.__clearDirty()
        const after = expandTree(
          client.hooks.__renderComponent(client.ProviderPanel, { provider, rpcCall }),
          client.hooks,
        )
        const nodes = flatten(after).filter(isElement)
        // ⚠️ 判据是「没有**文本录入**控件」，不能写成「一个 input 都没有」：
        // 面板后来新增了消耗顺序 / 切换粒度两个选择器，它们的原生
        // `input[type=radio]` 同样是 input —— 用「数量为 0」会把那两个**正当**
        // 控件误报成 PAT 表单残留（这条断言当初的意图也只是「粘贴式表单没了」）。
        // 真正要排除的是能承载 PAT 文本的那些类型。
        const TEXT_ENTRY_TYPES = ['text', 'password', 'search', 'url', 'email', 'tel', 'number', 'textarea']
        const textInputs = nodes.filter((el) => el.type === 'input'
          && TEXT_ENTRY_TYPES.includes(String(el.props.type)))
        expect(textInputs, `${provider} 出现了文本录入框（PAT 表单残留？）`).toHaveLength(0)
        expect(nodes.filter((el) => el.type === 'textarea'), `${provider} 出现了多行输入框`).toHaveLength(0)
        expect(textsOf(after).join(''), `${provider} 文案里仍有 PAT`)
          .not.toContain('PAT')
      }
    } finally {
      windowStub.restore()
    }
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
    'qoder',
    'qoder-cn',
  ] as const

  it('AccountHubPage 整页渲染不抛错，且七个 provider 的导航项都在', async () => {
    const { rpcCall } = makeRpc()
    const tree = await renderStable(client.AccountHubPage, { rpcCall }, client.hooks)
    const expanded = expandTree(tree, client.hooks)
    const text = textsOf(expanded).join('')

    // 页面骨架必须在（这是「Hub 界面」本身）。
    expect(text).toContain('账号中心')
    // 导航渲染的是**显示名**而不是 id（`label`），故这里逐个断言显示名 ——
    // 拿 id 去比会误报（第一版就是这么红的）。
    // 同时断言导航按钮的数量：只比文案的话，某个条目渲染成空壳也算过。
    const navButtons = flatten(expanded)
      .filter(isElement)
      .filter((el) => el.type === 'button' && el.props.role === 'tab')
    expect(navButtons, '导航项数量与 provider 数量不一致').toHaveLength(ALL_PROVIDERS.length)
    for (const label of ['Codearts', 'Buddy CN', 'Buddy', 'LobsterAI', 'Trae CN', 'Qoder', 'Qoder CN']) {
      expect(text, `导航里缺少 ${label}`).toContain(label)
    }
    // 未选中的 provider 不该出现面板（`AccountHubPage` 只挂载 selected 那一个）。
    expect(text).toContain('Codearts 账号管理')
  })

  it('逐个 provider 渲染面板并点击「登录账号」，一律不得抛错', async () => {
    // 这是白屏缺陷的**通盘**闸门：不再只盯 qoder，而是把每个面板都真的渲染
    // 一遍、把每个能点的登录按钮都点一次。自由变量、未定义导出、缺字段的
    // 条目 —— 无论落在哪个 provider 上，都会在这里炸出来。
    const windowStub = installWindowStub()
    try {
      for (const provider of ALL_PROVIDERS) {
        const { rpcCall } = makeRpc()
        const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
        expect(() => expandTree(tree, client.hooks), `${provider} 渲染抛错`).not.toThrow()

        // 每个面板都有自己的登录入口，故按钮一律必须存在且能点。
        const button = findButtonByText(tree, '登录账号')
        expect(button, `${provider} 缺少「登录账号」按钮`).toBeDefined()
        const openedBefore = windowStub.opened.length
        const onClick = button!.props.onClick as () => void
        expect(() => onClick(), `${provider} 点击抛错`).not.toThrow()
        client.hooks.__clearDirty()
        const afterClick = expandTree(
          client.hooks.__renderComponent(client.ProviderPanel, { provider, rpcCall }),
          client.hooks,
        )
        expect(() => afterClick, `${provider} 点击后重渲染抛错`).not.toThrow()
        // 点击必须**产生效果**，不能是「点了没反应」：全部面板都走浏览器设备流，
        // 故一律必须开窗。
        // 这条反向锚点很关键：若将来有人把 onClick 改成空实现，
        // 上面那句「不抛错」照样是绿的。
        expect(
          windowStub.opened.length,
          `${provider} 点击后没有开窗（点了没反应）`,
        ).toBe(openedBefore + 1)
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

/**
 * 面板按钮集合的**渲染级**回归（Hub UI 调整包）。
 *
 * 与 `credits-capabilities.spec.ts` 里那组源码级断言互补：源码正则能证明
 * 「某个字符串还在/不在了」，但证明不了**按钮真的按预期渲染出来**（比如把
 * 卡片按钮删掉、却把 handler 接到了别处）。这里真的渲染面板，逐个按钮点名。
 */
describe('面板按钮集合（渲染级）', () => {
  /** 带一个账号的 rpc 替身：卡片区才会真的渲染出来。 */
  function makeRpcWithAccount() {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    const rpcCall = async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload })
      if (method === 'account.list') {
        return {
          accounts: [{
            id: 'acc-1',
            nickname: 'BUDDY_CN_ACCOUNT_9F3A21C4',
            enabled: true,
            credentialRef: 'BUDDY_CN_ACCOUNT_9F3A21C4',
            expiresAt: Date.now() + 86400000,
            refreshable: true,
            modelRateLimits: { 'glm-5.2-sft-harmony': Date.now() + 86400000 },
          }],
        }
      }
      if (method === 'credits.balances') return { accounts: [] }
      return {}
    }
    return { calls, rpcCall }
  }

  /** 渲染树里全部 button 的可见文案。 */
  const buttonTexts = (tree: unknown): string[] =>
    flatten(expandTreeStub(tree))
      .filter(isElement)
      .filter((el) => el.type === 'button')
      .map((el) => textsOf(el).join(''))
      .filter((t) => t !== '')

  /** `expandTree` 需要 hooks 实例，这里包一层省得每处都传。 */
  const expandTreeStub = (tree: unknown): unknown => expandTree(tree, client.hooks)

  it('供应商级按钮是「模型列表 / 重测所有 / 清除限额 / 登录账号」，旧文案一个不留', async () => {
    const { rpcCall } = makeRpcWithAccount()
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const texts = buttonTexts(tree)
    // 逐个点名本轮改名后的四个按钮。
    for (const label of ['模型列表', '重测所有', '清除限额', '登录账号']) {
      expect(texts, `头部按钮缺少「${label}」`).toContain(label)
    }
    // 旧文案不得出现在任何按钮上。
    for (const stale of ['显示列表', '重置所有', '+ 新建账号']) {
      expect(texts, `按钮里仍有旧文案「${stale}」`).not.toContain(stale)
    }
  })

  it('账号卡片上只剩 签到 / 停用 / 删除，单账号「重测」「重置」已移除', async () => {
    const { rpcCall } = makeRpcWithAccount()
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const expanded = expandTree(tree, client.hooks)
    const card = flatten(expanded)
      .filter(isElement)
      .find((el) => typeof el.props.className === 'string' && el.props.className.includes('dim-ah-accountCard'))
    expect(card, '没有渲染出账号卡片').toBeDefined()

    const inCard = flatten(card!)
      .filter(isElement)
      .filter((el) => el.type === 'button')
      .map((el) => textsOf(el).join(''))
    // buddy-cn 支持签到 ⇒ 卡片上是这三个。
    expect(inCard.sort()).toEqual(['停用', '删除', '签到'])
    // 关键：单账号的清理入口确实没了（它们现在只在头部、且是 all 版本）。
    expect(inCard).not.toContain('重测')
    expect(inCard).not.toContain('重置')
  })

  it('卡片不再接收 onRetest / onReset（没有死 prop）', async () => {
    // 源码级反面：面板传 prop 的那一段里不得再有这两个名字。渲染级断言只能
    // 证明「按钮没渲染」，证明不了「prop 还在传但没人用」。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/account-hub.js'),
      'utf8',
    )
    expect(source).not.toContain('onRetest')
    expect(source).not.toContain('onReset')
  })
})
