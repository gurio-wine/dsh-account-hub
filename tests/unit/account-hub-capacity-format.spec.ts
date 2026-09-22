/**
 * 上下文窗口档位文案的回归测试（`formatCapacity` + `ModelTierPicker`）。
 *
 * ## 为什么是「加载源码 + 断言元素树」而不是正则断言
 *
 * 本次要钉死的是一个**渲染结果**：「用户看到的到底是 `168K` 还是 `168000`」。
 * 正则只能证明源码里出现过 `1e6` 这种字符串，证明不了 168000 走的是哪一支。
 * 故沿用 `account-hub-credit-balance-row.spec.ts` 的做法：把 `react` 与
 * `credits-capabilities.js` 换成占位模块后加载客户端源码，直接调用纯函数
 * —— 元素树是普通对象，不需要 DOM、不需要 react-dom。
 *
 * ## 用户报障背景（2026-09-21）
 *
 * 上一版规则是「**能被 1024 整除才缩写，否则原样输出数字**」，理由是缩写不能
 * 失真。真机目录给的是 168000 这类**既非 1024 整数倍、又是厂商口径整数**的值，
 * 于是界面上出现 `168000` / `1000000` 两串裸数字 —— 既难扫视，又与 Trae 客户端
 * 显示的 `168K` 看起来像两个不同的东西。现在改按 **1000 进制**缩写（与
 * OpenAI / Anthropic / 字节的模型卡口径一致），精确值挪进 `title` 兜底。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** 一个最小 react 占位模块：把参数收成可深比较的普通对象。 */
const REACT_STUB = `
'use strict';
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
};
`

/** 能力矩阵占位（本文件测的两个函数都不消费它）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/**
 * 与 `account-hub-credit-balance-row.spec.ts` 同款改写：只覆盖真正用到的两行
 * import，并逐条断言命中 —— import 形态变了要**立刻报错**，而不是静默加载出
 * 一个缺模块的半成品。
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
      throw new Error(`account-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat(
    '\nmodule.exports.__testExports = { formatCapacity: formatCapacity, ModelTierPicker: ModelTierPicker, tierOptionsOf: tierOptionsOf };\n',
  )
}

function loadClientModule(): Record<string, unknown> {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-capacity-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
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

const { formatCapacity, ModelTierPicker, tierOptionsOf } = loadClientModule() as {
  formatCapacity: (value: unknown) => string
  ModelTierPicker: (props: Record<string, unknown>) => TierNode | null
  tierOptionsOf: (model: Record<string, unknown>) => number[] | null
}

/** `createElement` 占位的产物形态。 */
interface TierNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** 整棵树里全部可见文本（按渲染顺序展平）。 */
function textsOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined) return []
  return ((node as TierNode).children ?? []).flatMap(textsOf)
}

/** 收集整棵树里所有 `title` 属性值。 */
function titlesOf(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const element = node as TierNode
  return [
    ...(typeof element.props?.title === 'string' ? [element.props.title] : []),
    ...(element.children ?? []).flatMap(titlesOf),
  ]
}

describe('formatCapacity：1000 进制缩写（与厂商口径一致）', () => {
  it('**用户报障的那两个数**：168000 → `168K`、1000000 → `1M`', () => {
    // 这两个值正是报障原文里的「显示168000和1000000不好看」。
    expect(formatCapacity(168_000)).toBe('168K')
    expect(formatCapacity(1_000_000)).toBe('1M')
  })

  it('M 档：整兆不带小数，非整兆保留一位（去掉尾随 `.0`）', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    // 目录里的 Max 档真机值（1024 进制写法），按 1000 进制口径落在 1M。
    expect(formatCapacity(1_048_576)).toBe('1M')
    expect(formatCapacity(1_500_000)).toBe('1.5M')
    expect(formatCapacity(2_000_000)).toBe('2M')
    // 边界：刚好 1e6 走 M 支，差一点走 K 支。
    expect(formatCapacity(999_999)).toBe('1000K')
  })

  it('K 档：四舍五入到整 K，目录真机值逐个核对', () => {
    expect(formatCapacity(200_000)).toBe('200K')
    // `glm-5.3` 的时代值（1024 进制写法）+ 漂移后的 dev 档。
    expect(formatCapacity(119_040)).toBe('119K')
    expect(formatCapacity(262_144)).toBe('262K')
    expect(formatCapacity(204_800)).toBe('205K')
    expect(formatCapacity(1_000)).toBe('1K')
    expect(formatCapacity(1_500)).toBe('2K')
  })

  it('不足 1K 原样输出；非法值返回空串（不渲染出 `NaN` / `undefined`）', () => {
    expect(formatCapacity(999)).toBe('999')
    expect(formatCapacity(1)).toBe('1')
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '168000', null, undefined, {}]) {
      expect(formatCapacity(bad), String(bad)).toBe('')
    }
  })
})

describe('ModelTierPicker：标签用缩写、title 保留精确值', () => {
  const model = {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
  }

  it('两个档位的可见文案是缩写（`默认 200K` / `Max 1M`）', () => {
    const tree = ModelTierPicker({ model, busy: false, onSelect: () => {} })
    expect(textsOf(tree)).toEqual(['默认 200K', 'Max 1M'])
  })

  it('精确值仍可见（四个 title 里带上原始 token 数）', () => {
    // 缩写负责扫视、tooltip 负责核对 —— 「精确值不丢」是这条改动的边界条件。
    const tree = ModelTierPicker({ model, busy: false, onSelect: () => {} })
    const titles = titlesOf(tree)
    expect(titles).toContain('默认档 · 200000 token')
    expect(titles).toContain('Max档 · 1000000 token')
  })

  it('没有 Max 档（`max <= dev` / 缺字段）时整个组件不渲染', () => {
    for (const bad of [
      { ...model, maxContextWindow: undefined },
      { ...model, maxContextWindow: 200_000 },
      { ...model, maxContextWindow: 100_000 },
      { ...model, contextWindow: undefined },
    ]) {
      expect(ModelTierPicker({ model: bad, busy: false, onSelect: () => {} }), JSON.stringify(bad)).toBeNull()
    }
  })
})

/**
 * 多档渲染（「档位选择器推广到全部供应商」的客户端侧）。
 *
 * 推广前客户端只认「默认 / Max」两个 radio；推广后 Host 会带出
 * `contextTiers` 数组（Qoder 真机三档、Buddy 两档），客户端必须**数据驱动**：
 * 有几档画几个 radio，选中态由 `contextBudget` **精确等于**哪一档决定。
 *
 * ⚠️ 判据是 `tierOptionsOf` 一个函数，UI 与提示行共用 —— 否则会出现「提示行说
 * 能选档、行上却没有控件」这类分叉。
 */
describe('ModelTierPicker：多档通用（数据驱动，档数不限）', () => {
  /** Qoder 真机三档形态（默认档是最小档）。 */
  const qoder = {
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    contextWindow: 200_000,
    contextTiers: [200_000, 400_000, 1_000_000],
  }

  it('三档模型渲染三个 radio（默认档标「默认」，其余用容量缩写）', () => {
    const tree = ModelTierPicker({ model: qoder, busy: false, onSelect: () => {} })
    expect(textsOf(tree)).toEqual(['默认 200K', '400K', '1M'])
    expect(titlesOf(tree)).toEqual([
      '默认档 · 200000 token',
      '400K档 · 400000 token',
      '1M档 · 1000000 token',
    ])
  })

  it('选中态 = `contextBudget` 精确等于该档；未设预算 / 编造值都是默认档', () => {
    const checkedOf = (budget: number | undefined) => {
      const tree = ModelTierPicker({ model: { ...qoder, contextBudget: budget }, busy: false, onSelect: () => {} })!
      return tree.children
        .map((child) => (child as TierNode).children.find((node) => (node as TierNode)?.type === 'input') as TierNode)
        .map((input) => input.props.checked)
    }
    // 未设预算 → 默认档；设中间档 → 中间档；设编造值 → 静默回默认档
    // （与宿主 `effectiveContextWindow` 同向：界面显示的选中项就是宿主会用的窗口）。
    expect(checkedOf(undefined)).toEqual([true, false, false])
    expect(checkedOf(400_000)).toEqual([false, true, false])
    expect(checkedOf(1_000_000)).toEqual([false, false, true])
    expect(checkedOf(200_000)).toEqual([true, false, false])
    expect(checkedOf(500_000)).toEqual([true, false, false])
  })

  it('点击某一档把**该档的值**交给回调（宿主据此校验与写入）', () => {
    const seen: Array<[string, number]> = []
    const tree = ModelTierPicker({ model: qoder, busy: false, onSelect: (id: string, w: number) => seen.push([id, w]) })!
    const inputs = tree.children.map((child) =>
      (child as TierNode).children.find((node) => (node as TierNode)?.type === 'input') as TierNode)
    for (const input of inputs) (input.props.onChange as () => void)()
    expect(seen).toEqual([
      ['qmodel_38max', 200_000],
      ['qmodel_38max', 400_000],
      ['qmodel_38max', 1_000_000],
    ])
  })

  it('**Trae CN 同时带数组与两字段**时仍渲染「默认 / Max」两个 radio（文案不降级）', () => {
    // Host 侧对 Trae CN 也会把 dev / max 归一进 `contextTiers`（同一套通用路径），
    // 故这条形态在真机上会同时出现 —— 「Max」这个词不能因此消失。
    const trae = { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxContextWindow: 1_000_000 }
    const tree = ModelTierPicker({
      model: { ...trae, contextTiers: [200_000, 1_000_000] }, busy: false, onSelect: () => {},
    })
    expect(textsOf(tree)).toEqual(['默认 200K', 'Max 1M'])
  })

  it('单档 / 无窗口 / 无 data 一律不渲染（宁缺毋编）', () => {
    expect(ModelTierPicker({ model: { ...qoder, contextTiers: [200_000] }, busy: false, onSelect: () => {} })).toBeNull()
    expect(ModelTierPicker({ model: { ...qoder, contextTiers: [] }, busy: false, onSelect: () => {} })).toBeNull()
    expect(ModelTierPicker({
      model: { id: 'x', contextWindow: 200_000 }, busy: false, onSelect: () => {},
    })).toBeNull()
    expect(ModelTierPicker({
      model: { id: 'x', contextTiers: [200_000, 400_000] }, busy: false, onSelect: () => {},
    })).toBeNull()  // 缺默认档：无法表达选中态，故不画
  })

  it('tierOptionsOf：默认档并入列表、升序去重、非法值剔除', () => {
    // Buddy 的 `min(maxInputTokens, 档位表最大档)` 会产出「默认档不落在档位表里」
    // 的组合 —— 不并入则「当前是默认档」无法表达（radio 全不选中）。
    expect(tierOptionsOf({ contextWindow: 200_000, contextTiers: [100_000, 524_288] }))
      .toEqual([100_000, 200_000, 524_288])
    expect(tierOptionsOf({ contextWindow: 1_048_576, contextTiers: [300_000, 1_048_576, 300_000] }))
      .toEqual([300_000, 1_048_576])
    expect(tierOptionsOf({
      contextWindow: 200_000, contextTiers: [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 400_000],
    })).toEqual([200_000, 400_000])
    // 老形态（无数组）走两字段分支；`max <= dev` 不算第二档。
    expect(tierOptionsOf({ contextWindow: 200_000, maxContextWindow: 1_000_000 })).toEqual([200_000, 1_000_000])
    expect(tierOptionsOf({ contextWindow: 200_000, maxContextWindow: 200_000 })).toBeNull()
  })
})
