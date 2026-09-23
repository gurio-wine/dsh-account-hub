/**
 * `CreditBalanceRow` 渲染的回归测试。
 *
 * ## 为什么不沿用源码级断言
 *
 * 本仓库既有的前端测试都是「读源码、正则断言」（`credits-capabilities.spec.ts`、
 * `account-hub-rpc-account-create.spec.ts`），理由是 react 不在依赖里、组件渲染不了。
 * 但**正则断言恰好无法验证本次要证明的东西**：本次的核心命题是「余额对象里
 * 出现任何 Trae 专属字段都不改变渲染 —— 一行永远只有一个数字」，这是**分支
 * 是否还存在的输出差异**，用 `toMatch(/workTotal/)` 只能证明提到过这个名字，
 * 证明不了分支已经删掉。
 *
 * 因此这里换一条路：把插件源码里的 `react` 与 `./credits-capabilities.js` 换成
 * **占位模块**后加载，直接调用纯函数 `CreditBalanceRow`。该组件的产物是一棵
 * 普通对象树，不需要 DOM、不需要 react-dom、不需要 JSX —— 只要 `createElement`
 * 能返回对象即可。于是可以做**精确的整树深比较**，这正是本次要的证据。
 *
 * ## 占位 `createElement` 的边界
 *
 * 这不是 react 的模拟实现，只是把 `(type, props, ...children)` 原样收成对象：
 * 组件不使用 hook、不使用 context、不依赖 key 的调和语义，因此这棵树与 react
 * 真实渲染的**元素结构**一致（断言也只针对结构，不针对真实 DOM 属性）。
 *
 * 同理，`credits-capabilities.js` 被换成固定返回 `true` 的占位：
 * `CreditBalanceRow` 本身不消费能力矩阵（门控在 `ProviderPanel` 里），
 * 换成占位能避免这个测试与能力矩阵的正确性耦合 —— 后者由另一个文件守着。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ui-primitives 是宿主的隐式 baseline（不在本仓库依赖里）：临时目录里必须补一个
// 替身文件，否则 require 会以 Cannot find module 让**整个文件**加载失败。
import { rewriteUiPrimitivesImport, writeUiPrimitivesStub } from './fixtures/ui-primitives-stub.js'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** 一个最小 react 占位模块：把参数收成可深比较的普通对象。 */
const REACT_STUB = `
'use strict';
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
`

/** 能力矩阵占位（组件本身不消费它，见文件头说明）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/**
 * 插件源码是纯 ESM；这里把它的两条 import 与 export 改写成 CJS 形态后加载。
 *
 * 之所以不引 tsx/esbuild 之类工具：被加载的只是两个纯函数组件，源码里没有
 * 需要转换的 TS 语法，正则改写足够且没有额外依赖与启动开销。
 *
 * 改写**只覆盖本文件真正用到的两行 import**，并逐条断言命中 —— 若哪天
 * `account-hub.js` 的 import 形态变了，这里会**立刻报错**，而不是静默加载出一个
 * 缺了模块的半成品（那种失败会伪装成「组件返回 undefined」）。
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

/**
 * 把 `./account-order.js` 按与 `toCjs` 同一套规则转成 CJS 写进临时目录。
 *
 * `account-hub.js` 现在 import 了它（拖拽排序）；不写这个文件，`require` 会以
 * `Cannot find module './account-order.js'` 让本文件**整体加载失败**
 * —— 不是某条用例红，而是「什么都没测到」（那种失败还会伪装成组件问题）。
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
  // `export function` / `export const` → 普通声明（模块作用域内仍互相可见）。
  // ui-primitives 是宿主隐式 baseline（不在本仓库依赖里），临时目录里没有它：
  // 按源码**现算**导入名单并改写为替身 require（见 fixtures/ui-primitives-stub.ts）。
  out = rewriteUiPrimitivesImport(out)
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  // 暴露本次要测的组件。它是模块作用域里的函数声明，故此处必然可见。
  return out.concat(
    '\nmodule.exports.__testExports = { CreditBalanceRow: CreditBalanceRow, Tooltip: Tooltip };\n',
  )
}

function loadClientModule(): Record<string, unknown> {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-row-'))
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
  tempDir = dir
  return loaded.__testExports
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

const { CreditBalanceRow } = loadClientModule() as {
  CreditBalanceRow: (props: Record<string, unknown>) => RowNode
}

/** `createElement` 占位的产物形态。 */
interface RowNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * 把一个节点渲染成「结构快照」：只保留 type / 关键 props / 文本，便于深比较。
 *
 * ⚠️ 子节点取自 `props.children`（真实 react 的形态），回退到占位的 `children`
 * 数组。两者在旧版 react 占位里不一致（`createElement(组件, props, 子节点…)`
 * 的子节点只进数组、不进 props），本文件正是靠 `props.children` 才能看见
 * 「组件渲染出来的子节点」；占位现已补上该字段（见各 spec 的 REACT_STUB）。
 */
function snapshot(node: unknown): unknown {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as RowNode
  return {
    type: element.type,
    className: element.props.className,
    title: element.props.title,
    tooltip: element.props['data-tooltip'],
    tone: element.props['data-tone'],
    children: childrenOf(element).filter((child) => child !== null && child !== undefined).map(snapshot),
  }
}

/**
 * `Tooltip` 是透明代理：树上出现它时，把它折回被包住的那个真实节点，
 * 并把 `label` 投影成该节点的 `data-tooltip`（与替身 `expandTree` 时的行为一致）。
 *
 * 本文件的组件是**直接调用**的（不经 `expandTree`），故代理的投影要在这里补上，
 * 否则 `data-tooltip` 永远取不到、而 `title` 又已被迁移移除 —— 那会让
 * 「悬停文案不许丢」这条回归断言假绿。
 */
function unwrapTooltip(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  const element = node as RowNode
  if (typeof element.type === 'function' && (element.type as { name?: string }).name === 'Tooltip') {
    const child = unwrapTooltip(element.props.children)
    if (child === null || typeof child !== 'object') return child
    const inner = child as RowNode
    return { ...inner, props: { ...inner.props, 'data-tooltip': element.props.label } }
  }
  return node
}

/**
 * 一个节点的子节点（props.children 优先，回退到占位的 children 数组）。
 *
 * 每个子节点都过一遍 {@link unwrapTooltip}：`Tooltip` 替身是**透明**的
 * （不增节点、只把 label 投影成 data-tooltip），故它在树上不该算一层 ——
 * 否则 `ddParts` 拿到的第一层是 Tooltip 而不是 dd。
 */
function childrenOf(element: RowNode): unknown[] {
  const props = element.props.children
  const raw = props === undefined ? element.children : (Array.isArray(props) ? props : [props])
  return raw.map(unwrapTooltip)
}

/** 一个节点的子树里全部可见文本（按渲染顺序展平）。 */
function textOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined) return []
  return childrenOf(node as RowNode).flatMap(textOf)
}

/**
 * 积分行 `dd` 的直接子元素的文本（即界面上依次显示的那几段）。
 *
 * 先滤掉 `null` / `undefined` 子元素：组件用「条件 ? 元素 : null」表达可选片段，
 * 而 react 本身会丢弃 null 子节点、不产生任何 DOM。占位 `createElement` 原样保留
 * 了它们，故这里按 react 的语义过滤，否则「可选片段没渲染」会被误读成一个空段。
 */
function ddParts(balance: Record<string, unknown>): string[][] {
  const node = CreditBalanceRow({ balance }) as RowNode
  const dd = childrenOf(node)[1] as RowNode
  return childrenOf(dd)
    .filter((child) => child !== null && child !== undefined)
    .map(textOf)
}

/** 一个余额对象（所有 provider 的形态，分池后 Trae 也走这一份）。 */
function legacyBalance(overrides: Record<string, unknown> = {}) {
  return {
    total: 247.87,
    packages: [],
    expiredTotal: 0,
    ...overrides,
  }
}

describe('CreditBalanceRow 的三种基础状态（回归护栏，非本次改动）', () => {
  it('loading 显示「读取中…」且不显示 0', () => {
    expect(snapshot(CreditBalanceRow({ loading: true }))).toEqual({
      type: 'div',
      className: 'dim-ah-metaRow',
      title: undefined,
      tone: undefined,
      children: [
        { type: 'dt', className: undefined, title: undefined, tone: undefined, children: ['积分'] },
        { type: 'dd', className: undefined, title: undefined, tone: 'muted', children: ['读取中…'] },
      ],
    })
  })

  it('error 显示原因而不是 0（「查不到」与「余额为 0」严格区分）', () => {
    const node = snapshot(CreditBalanceRow({ balance: null, error: '凭据未配置' }))
    expect(JSON.stringify(node)).toContain('凭据未配置')
    expect(JSON.stringify(node)).not.toContain('0')
  })
})

describe('CreditBalanceRow 永远是单数字（分池后无 provider 专属分支）', () => {
  it('余额对象带 Trae 的旧双池字段时**不**多渲染任何一段，仍是一个数字', () => {
    // 分池后 `fetchTraeCnCreditBalance` 只返回本池，`workTotal` / `pools` 已从
    // 返回类型里删除。这条断言用**旧字段强行喂进来**：组件若还残留任何
    // `workTotal` 分支，这里就会多出「通用 X」前缀与「Work Y」那一段。
    for (const stale of [
      { workTotal: 2000 },
      { workTotal: 0 },
      { workTotal: 2000, pools: [{ endpoint: 0, name: '通用积分', total: 247.87, packages: [] }] },
    ]) {
      const parts = ddParts(legacyBalance(stale))
      expect(parts, JSON.stringify(stale)).toEqual([['247.87']])
    }
  })

  it('渲染层不知道「池」的存在（选池在宿主侧完成）', () => {
    // 宿主选了哪个池，渲染层拿到的都是同一个逐字段同构的 `CreditBalance` ——
    // 「显示哪个池」的决定在 `src/account-hub-rpc.ts` 的 `credits.balances` 分支，
    // 组件不做也不该做任何池判断。
    const rendered = JSON.stringify(snapshot(CreditBalanceRow({ balance: legacyBalance({ total: 154.22 }) })))
    expect(rendered).not.toContain('通用')
    expect(rendered).not.toContain('Work')
  })

  it('资源包列表只渲染传进来的那些包（过滤在宿主侧完成）', () => {
    // 分池后 `packages` 只含本池的包，且包名**不带** `[Work 积分]` 前缀
    // （那个前缀是为两池混排准备的，已随分池删除）。这里钉死渲染层不加料：
    // 名字原样显示、条数就是数组长度。
    const parts = ddParts(legacyBalance({
      total: 30,
      packages: [
        { name: 'Work礼包', remaining: 20, total: 50, active: true, cycleEndTime: '' },
        { name: 'Work礼包B', remaining: 10, total: 50, active: true, cycleEndTime: '' },
      ],
    }))
    expect(parts[0]).toEqual(['30'])
    // 第二段是「2/2 个资源包有效」—— 计数用的就是传进来的数组。
    // ⚠️ `ddParts` 现在取 `props.children`（与真实 react 对齐，见其定义处），
    // 而余额行外面套了一层 `Tooltip` 透明代理，故可见文本要经 `ddParts` 之外的
    // 路径取 —— 这里直接用 `ddParts` 的第二段即可（代理不改变子节点结构）。
    expect(parts[1]).toEqual(['2/2 个资源包有效'])
  })

  it('Work 项的独立 class 已随两段式渲染一并删除（样式表里不得残留死类）', () => {
    // `dim-ah-creditWork` 曾经是 Work 数字的弱化色。留着它等于留着一个
    // 再无引用的死类，而那正是「哪天有人照着旧代码把双池加回来」的邀请。
    const clientSource = readFileSync(
      resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8',
    )
    const stylesSource = readFileSync(
      resolve(here, '../../plugin-src/client/account-hub-styles.js'), 'utf8',
    )
    // 正文里不得出现该 class 的**使用**（注释中叙述历史是允许的）。
    const codeLines = clientSource
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('dim-ah-creditWork')
    expect(stylesSource).not.toMatch(/\.dim-ah-creditWork\s*\{/)
  })
})

describe('CreditBalanceRow 的基础渲染（回归护栏）', () => {
  it('余额对象不带任何 Trae 字段时，渲染结果逐元素不变', () => {
    // 这是「别动其他 provider 的渲染」这条约束的可执行形式：期望值写死成
    // 改动前的树，任何意外新增的节点都会让这条断言失败。
    expect(snapshot(CreditBalanceRow({
      balance: {
        total: 247.87,
        packages: [
          { name: '免费额度', remaining: 100, total: 200, active: true, cycleEndTime: '2026-10-01' },
          { name: '活动包', remaining: 147.87, total: 300, active: false, expiredTime: '2026-09-01' },
        ],
        expiredTotal: 12.5,
      },
    }))).toEqual({
      type: 'div',
      className: 'dim-ah-metaRow',
      title: undefined,
      tooltip: undefined,
      tone: undefined,
      children: [
        { type: 'dt', className: undefined, title: undefined, tooltip: undefined, tone: undefined, children: ['积分'] },
        {
          type: 'dd',
          className: 'dim-ah-creditValue',
          // 明细按 packages 顺序逐行拼接（失效包带自己的失效时间，有效包显示周期）。
          // ⚠️ 迁移后它**不再挂在 `title` 上**，而是经 `Tooltip` 原语渲染成
          // `data-tooltip`（快照里的 `tooltip` 字段）。文案本身一个字符没变。
          title: undefined,
          tooltip: '免费额度: 100 / 200 · 本周期至 2026-10-01\n[已失效] 活动包: 147.87 / 300 · 失效于 2026-09-01',
          tone: undefined,
          children: [
            { type: 'strong', className: 'dim-ah-creditTotal', title: undefined, tooltip: undefined, tone: undefined, children: ['247.87'] },
            { type: 'span', className: 'dim-ah-creditPackages', title: undefined, tooltip: undefined, tone: undefined, children: ['1/2 个资源包有效'] },
            { type: 'span', className: 'dim-ah-creditExpired', title: undefined, tooltip: undefined, tone: undefined, children: ['另有 12.50 已失效'] },
          ],
        },
      ],
    })
  })

  it('整数余额不补小数位（与 IDE 的精确值展示对齐）', () => {
    const parts = ddParts(legacyBalance({ total: 100 }))
    expect(parts[0]).toEqual(['100'])
  })
})
