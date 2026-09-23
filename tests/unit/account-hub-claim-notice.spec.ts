/**
 * `ClaimNotice`（一键领取积分的结果提示）渲染的回归测试。
 *
 * ## 真实缺陷（用户报障）
 *
 * Trae CN 签到失败时，界面只显示「1 个失败」，用户无从判断原因。后端
 * `credits.claimAll` 的响应里 `results[].outcome` **本来就带**服务端原文
 * （如 `{ kind:'failed', code:9074, message:'当前参与用户太多，请稍后再试' }`，
 * 见 `src/credits.ts` 的 `ClaimOutcome`），但客户端只解构了 `{ summary }`，
 * 把 `results` 整块丢掉 —— 计数回答了「有几个失败」，却没人回答「为什么」。
 *
 * 因此本文件守两件事，缺一不可：
 * 1. **失败路径**：每个失败账号的 message 与 code 必须出现在渲染树里；
 * 2. **成功路径逐元素不变**：没有失败账号时，渲染结果与改动前**完全一致**
 *    （整树深比较），证明这次是纯增量、没有顺手改坏正常路径。
 *
 * ## 为什么沿用「占位 react + 整树深比较」
 *
 * react 不在本仓库依赖里，`ProviderPanel` 用了 hooks 渲染不了。但本次要证明的
 * 恰好是**条件分支的输出差异**（有失败明细 / 没有），正则断言只能证明「提到过
 * 某个名字」，证明不了分支正确。故沿用
 * `tests/unit/account-hub-credit-balance-row.spec.ts` 的办法：把 `react` 换成把参数
 * 收成普通对象的占位模块后加载插件源码，直接调用纯函数组件。
 *
 * 为此 `account-hub.js` 里把提示抽成了 `ClaimNotice` 组件与 `buildClaimNotice`
 * 纯函数（原先是内联在 `ProviderPanel` 的 setState 里），两个都不消费 hook。
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

/** 能力矩阵占位（`ClaimNotice` / `buildClaimNotice` 都不消费它，见文件头说明）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/**
 * 插件源码是纯 ESM；这里把它的两条 import 与 export 改写成 CJS 形态后加载。
 * 改写逐条断言命中 —— 若 `account-hub.js` 的 import 形态变了要**立刻报错**，
 * 而不是静默加载出一个缺模块的半成品（那种失败会伪装成「组件返回 undefined」）。
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
  // `export function` / `export const` → 普通声明（模块作用域内仍互相可见）。
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  // 暴露本次要测的纯函数。它们都是模块作用域的声明，故此处必然可见。
  return out.concat(
    '\nmodule.exports.__testExports = { ClaimNotice: ClaimNotice, buildClaimNotice: buildClaimNotice,'
    + ' claimUnavailableLines: claimUnavailableLines, formatClaimUnavailableLine: formatClaimUnavailableLine };\n',
  )
}

function loadClientModule(): Record<string, unknown> {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'account-hub-claim-'))
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

const { ClaimNotice, buildClaimNotice, claimUnavailableLines, formatClaimUnavailableLine } = loadClientModule() as {
  ClaimNotice: (props: Record<string, unknown>) => TreeNode
  buildClaimNotice: (res: unknown) => {
    tone: string
    text: string
    details: string[]
    unavailableDetails: string[]
  }
  claimUnavailableLines: (res: unknown) => string[]
  formatClaimUnavailableLine: (result: unknown) => string
}

/** `createElement` 占位的产物形态。 */
interface TreeNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/**
 * 按 **react 的真实语义**取子元素：丢弃 `null` / `undefined`（组件用
 * 「条件 ? 元素 : null」表达可选片段），并展开嵌套数组（组件用 `.map()` 返回
 * 数组时 react 会逐项展开）。
 *
 * 占位 `createElement` 只是把实参原样收下，不做这两件事；不按 react 语义归一
 * 会把「可选片段没渲染」误读成一个空段，也会让 `.map()` 的子元素被当成一个
 * 整体节点。
 */
function childrenOf(node: TreeNode): unknown[] {
  const out: unknown[] = []
  for (const child of node.children ?? []) {
    if (child === null || child === undefined) continue
    if (Array.isArray(child)) {
      out.push(...child.filter((item) => item !== null && item !== undefined))
    } else {
      out.push(child)
    }
  }
  return out
}

/** 把一个节点渲染成「结构快照」：只保留 type / 关键 props / 文本，便于深比较。 */
function snapshot(node: unknown): unknown {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as TreeNode
  return {
    type: element.type,
    className: element.props.className,
    tone: element.props['data-tone'],
    role: element.props.role,
    children: childrenOf(element).map(snapshot),
  }
}

/** 一个节点的子树里全部可见文本（按渲染顺序展平）。 */
function textOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined || Array.isArray(node)) {
    // 数组只可能来自 `.map()` 的子元素，展平后逐项取文本。
    return Array.isArray(node) ? node.flatMap(textOf) : []
  }
  return childrenOf(node as TreeNode).flatMap(textOf)
}

/** 按 `credits.claimAll` 的真实响应形态走一遍「响应 → props → 渲染树」。 */
function render(res: unknown): TreeNode {
  const notice = buildClaimNotice(res)
  return ClaimNotice(notice) as TreeNode
}

/** 一个全成功的响应（回归护栏的基准形态）。 */
function allClaimedResponse() {
  return {
    results: [
      { accountId: 'acc-1', nickname: '账号一', outcome: { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false } },
      { accountId: 'acc-2', nickname: '账号二', outcome: { kind: 'claimed', credit: 200, streakDays: 2, isStreakDay: true } },
    ],
    summary: { claimed: 2, totalCredit: 300, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 0 },
  }
}

describe('失败账号的服务端原文必须出现在渲染树里（本次修复的核心）', () => {
  it('Trae CN 真机场景：code 9074 与「当前参与用户太多」都显示出来', () => {
    // 真机诊断取到的原文：claim 返回 {"code":9074,"message":"当前参与用户太多，请稍后再试"}
    const tree = render({
      results: [
        { accountId: 'acc-1', nickname: '我的 Trae 账号', outcome: { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false } },
        {
          accountId: 'acc-2',
          nickname: '小号',
          outcome: { kind: 'failed', code: 9074, message: '当前参与用户太多，请稍后再试' },
        },
      ],
      summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })

    const all = textOf(tree).join('\n')
    // 摘要行照旧说「1 个失败」……
    expect(all).toContain('1 个失败')
    // ……但服务端原文与业务码也必须在渲染树里，否则用户还是无从判断原因。
    expect(all).toContain('当前参与用户太多，请稍后再试')
    expect(all).toContain('code 9074')
  })

  it('每个失败账号各占一行，带昵称前缀（多个失败不糊成一行）', () => {
    const tree = render({
      results: [
        { accountId: 'acc-1', nickname: '账号一', outcome: { kind: 'failed', code: 9074, message: '当前参与用户太多，请稍后再试' } },
        { accountId: 'acc-2', nickname: '账号二', outcome: { kind: 'failed', code: 1001, message: '凭据已失效，请重新登录' } },
      ],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 2 },
    })

    expect(tree.children[1]).toMatchObject({ type: 'ul', props: { className: 'dim-ah-probeDetails' } })
    const items = childrenOf(tree.children[1] as TreeNode)
    expect(items).toHaveLength(2)
    expect(textOf(items[0]!)).toEqual(['账号一：当前参与用户太多，请稍后再试（code 9074）'])
    expect(textOf(items[1]!)).toEqual(['账号二：凭据已失效，请重新登录（code 1001）'])
  })

  it('message 为空时回退固定文案，不显示成空白', () => {
    const tree = render({
      results: [{ accountId: 'acc-9', nickname: '', outcome: { kind: 'failed', code: -1, message: '' } }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    const all = textOf(tree).join('\n')
    // 昵称为空 → 回退 accountId；message 为空 → 回退固定文案；code 仍保留。
    expect(all).toContain('acc-9：领取失败（code -1）')
  })

  it('成功 / 已领 / 活动未开启都不产生明细行（只有 failed 才列原因）', () => {
    const tree = render({
      results: [
        { accountId: 'a', nickname: 'A', outcome: { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false } },
        { accountId: 'b', nickname: 'B', outcome: { kind: 'already-claimed', message: '今天已签到' } },
        { accountId: 'c', nickname: 'C', outcome: { kind: 'inactive', message: '签到未开启' } },
      ],
      summary: { claimed: 1, totalCredit: 1, alreadyClaimed: 1, inactive: 1, unavailable: 0, failed: 0 },
    })
    // 除摘要文本外没有任何子节点。
    expect(tree.children.filter((c) => c !== null && c !== undefined)).toHaveLength(1)
    const all = textOf(tree).join('\n')
    expect(all).toContain('1 个账号领取成功（+1 积分），1 个今日已领取，1 个活动未开启')
    expect(all).not.toContain('今天已签到')
    expect(all).not.toContain('签到未开启')
  })

  it('results 缺失或不是数组时不抛错：摘要行照常显示，明细为空', () => {
    for (const results of [undefined, null, 'oops', 42]) {
      const notice = buildClaimNotice({
        results,
        summary: { claimed: 1, totalCredit: 10, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 0 },
      })
      expect(notice.details, String(results)).toEqual([])
      expect(notice.text).toBe('1 个账号领取成功（+10 积分）')
    }
  })
})

/**
 * logid 透传（失败行末尾追加）。
 *
 * 来源：Trae CN 的 claim / status 失败响应头带 `x-tt-logid`
 * （真机样本 `20260919142909176141A5DE791F4FE75E`），它是向服务端追查这一次
 * 请求的**唯一线索**。宿主侧把它透传进 `outcome.logid`（`src/credits.ts` 的
 * `ClaimOutcome` 失败分支），前端在这里显示。
 *
 * 只有 Trae CN 会填该字段 —— 其余协议的 outcome 没有它，故这些用例同时守住
 * 「没有 logid 时**一个字符都不变**」（既有断言已覆盖，这里再加一条显式的）。
 */
describe('失败行的 logid 透传', () => {
  const LOGID = '20260919142909176141A5DE791F4FE75E'

  it('有 logid 时追加「· logid <值>」', () => {
    const tree = render({
      results: [{
        accountId: 'acc-1',
        nickname: '我的 Trae 账号',
        outcome: { kind: 'failed', code: 9074, message: '当前参与用户太多，请稍后再试', logid: LOGID },
      }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    expect(textOf(tree)).toEqual([
      '1 个失败',
      `我的 Trae 账号：当前参与用户太多，请稍后再试（code 9074） · logid ${LOGID}`,
    ])
  })

  it('没有 logid 字段时该行**逐字不变**（其余协议不受影响）', () => {
    const tree = render({
      results: [{
        accountId: 'acc-1',
        nickname: '我的 Trae 账号',
        outcome: { kind: 'failed', code: 9074, message: '当前参与用户太多，请稍后再试' },
      }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    expect(textOf(tree)).toEqual([
      '1 个失败',
      '我的 Trae 账号：当前参与用户太多，请稍后再试（code 9074）',
    ])
    expect(textOf(tree).join('\n')).not.toContain('logid')
  })

  it('logid 为空串 / 纯空白 / 非字符串时都不追加（不挂空尾巴）', () => {
    for (const logid of ['', '   ', undefined, null, 42]) {
      const notice = buildClaimNotice({
        results: [{
          accountId: 'a',
          nickname: 'A',
          outcome: { kind: 'failed', code: 1, message: 'x', logid },
        }],
        summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
      })
      expect(notice.details, String(logid)).toEqual(['A：x（code 1）'])
    }
  })

  it('logid 两侧空白被 trim（服务端偶尔带空格）', () => {
    const notice = buildClaimNotice({
      results: [{
        accountId: 'a',
        nickname: 'A',
        outcome: { kind: 'failed', code: 1, message: 'x', logid: `  ${LOGID}  ` },
      }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    expect(notice.details).toEqual([`A：x（code 1） · logid ${LOGID}`])
  })

  it('message 缺失时回退文案与 logid 并存（两者互不吞并）', () => {
    const notice = buildClaimNotice({
      results: [{
        accountId: 'acc-9',
        nickname: '',
        outcome: { kind: 'failed', code: -1, message: '', logid: LOGID },
      }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    expect(notice.details).toEqual([`acc-9：领取失败（code -1） · logid ${LOGID}`])
  })
})

describe('成功路径的渲染逐元素不变（纯增量护栏）', () => {
  it('全成功响应渲染出的树与改动前完全一致', () => {
    // 期望值**写死**成改动前的树（摘要 div + 文本，没有任何明细列表）。
    // 任何意外新增的节点、类名或 role 变化都会让这条断言失败。
    expect(snapshot(render(allClaimedResponse()))).toEqual({
      type: 'div',
      className: 'dim-ah-probeNotice',
      tone: 'ok',
      role: 'status',
      children: [
        {
          type: 'div',
          className: undefined,
          tone: undefined,
          role: undefined,
          children: ['2 个账号领取成功（+300 积分）'],
        },
      ],
    })
  })

  it('没有失败账号时 details 为空，也不出现明细列表节点', () => {
    const notice = buildClaimNotice(allClaimedResponse())
    expect(notice.details).toEqual([])
    expect(notice.tone).toBe('ok')
    const tree = render(allClaimedResponse())
    // 只有摘要 div 一个子元素；可选明细列表被条件渲染成 null，不产生节点。
    expect(childrenOf(tree)).toHaveLength(1)
  })

  it('全部今日已领取：文案与改动前一致（ok 色调）', () => {
    expect(snapshot(render({
      results: [{ accountId: 'a', nickname: 'A', outcome: { kind: 'already-claimed', message: '今天已签到' } }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, unavailable: 0, failed: 0 },
    }))).toEqual({
      type: 'div',
      className: 'dim-ah-probeNotice',
      tone: 'ok',
      role: 'status',
      children: [
        {
          type: 'div',
          className: undefined,
          tone: undefined,
          role: undefined,
          children: ['1 个今日已领取'],
        },
      ],
    })
  })

  it('空结果：文案仍是「没有可领取的账号」，失败色调与 role 规则不变', () => {
    const tree = render({
      results: [],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 0 },
    })
    expect(textOf(tree)).toEqual(['没有可领取的账号'])
    expect(tree.props['data-tone']).toBe('ok')
    expect(tree.props.role).toBe('status')
  })

  it('有失败账号时色调切 warn（既有行为，未改）', () => {
    const tree = render({
      results: [{ accountId: 'a', nickname: 'A', outcome: { kind: 'failed', code: 1, message: 'x' } }],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 1 },
    })
    expect(tree.props['data-tone']).toBe('warn')
  })

  it('error 色调仍用 role="alert"（整批失败的 catch 分支形态）', () => {
    const tree = ClaimNotice({ tone: 'error', text: '领取积分失败', details: [] }) as TreeNode
    expect(tree.props.role).toBe('alert')
    expect(textOf(tree)).toEqual(['领取积分失败'])
  })
})

/**
 * `unavailable`（「服务端此刻暂不可签」）的通知渲染。
 *
 * ## 为什么它不是「又一种失败」
 *
 * 这是 2026-09-23 新增的 outcome kind，唯一生产者是 Trae CN 的 `9074`
 * （真机定案：**名额/风控类拒绝**，与设备号取值无关 —— 旧定性「设备身份」已作废）。
 * 用户对它的正确动作是**什么都不做**：宿主会把它排除在今日签到状态之外，
 * 4 小时后的 sweep 自动重试。
 *
 * 因此本组守两件事：
 * 1. 它**独立成段**（不并进失败明细列表）—— 混进去用户会当成待处理的问题；
 * 2. 它的回退文案**不是**「领取失败」—— 那会让用户去排查并不存在的问题。
 */
describe('unavailable（暂不可签）既不并进失败明detail，也不报成失败', () => {
  /** 真机响应形态：一个账号被 9074 拒绝。 */
  const unavailableResponse = () => ({
    results: [{
      accountId: 'acc-1',
      nickname: '我的 Trae 账号',
      outcome: { kind: 'unavailable', code: 9074, message: '当前参与用户太多，请稍后再试（服务端此刻暂不可签，稍后自动重试）' },
    }],
    summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 1, failed: 0 },
  })

  it('摘要行说「1 个暂不可签」，色调**仍是 ok**（不是失败）', () => {
    const tree = render(unavailableResponse())
    expect(textOf(tree)[0]).toBe('1 个暂不可签')
    // 关键：`failed` 为 0 ⇒ 色调不变 warn。报成 warn 等于把「等一会儿就好」
    // 渲染成「出问题了」。
    expect(tree.props['data-tone']).toBe('ok')
    expect(tree.props.role).toBe('status')
  })

  it('明细行独立成段（data-kind="unavailable"），**不**混进失败明细列表', () => {
    const tree = render(unavailableResponse())
    // 摘要 div + 一个 unavailable 列表 = 2 个子节点。
    const children = childrenOf(tree)
    expect(children).toHaveLength(2)
    const list = children[1] as TreeNode
    expect(list.type).toBe('ul')
    expect(list.props['data-kind']).toBe('unavailable')
    expect(textOf(children[1])).toEqual([
      '我的 Trae 账号：当前参与用户太多，请稍后再试（服务端此刻暂不可签，稍后自动重试）（code 9074）',
    ])
  })

  it('纯函数契约：details 为空、unavailableDetails 有值（两条通道互不污染）', () => {
    const notice = buildClaimNotice(unavailableResponse())
    expect(notice.details).toEqual([])
    expect(notice.unavailableDetails).toHaveLength(1)
    // 颜色由 failed 决定，不由 unavailable 决定。
    expect(notice.tone).toBe('ok')
  })

  it('failed 与 unavailable 同时存在时各走各的段，摘要分别计数', () => {
    const tree = render({
      results: [
        { accountId: 'a', nickname: 'A', outcome: { kind: 'unavailable', code: 9074, message: '暂不可签' } },
        { accountId: 'b', nickname: 'B', outcome: { kind: 'failed', code: 1001, message: '凭据已失效，请重新登录' } },
      ],
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, unavailable: 1, failed: 1 },
    })
    expect(textOf(tree)[0]).toBe('1 个暂不可签，1 个失败')
    // 有真失败 ⇒ 色调这才切 warn。
    expect(tree.props['data-tone']).toBe('warn')
    const children = childrenOf(tree)
    // 摘要 + 失败明细 + 暂不可签明细 = 3 个。
    expect(children).toHaveLength(3)
    // 失败明细列表**不带** data-kind（保持改动前的形态逐元素不变）。
    expect((children[1] as TreeNode).props['data-kind']).toBeUndefined()
    expect(textOf(children[1])).toEqual(['B：凭据已失效，请重新登录（code 1001）'])
    expect((children[2] as TreeNode).props['data-kind']).toBe('unavailable')
    expect(textOf(children[2])).toEqual(['A：暂不可签（code 9074）'])
  })

  it('message 缺失时回退文案是「服务端此刻暂不可签」，**不是**「领取失败」', () => {
    // 这一条是本次修复的核心之一：回退成「领取失败」会让用户去排查凭据/设备，
    // 而那两件事都治不了 9074。
    const line = formatClaimUnavailableLine({
      accountId: 'acc-9',
      nickname: '',
      outcome: { kind: 'unavailable', code: 9074, message: '' },
    })
    expect(line).toBe('acc-9：服务端此刻暂不可签（code 9074）')
    expect(line).not.toContain('领取失败')
  })

  it('logid 与失败行同款透传（9074 最需要服务端日志）', () => {
    const LOGID = '20260923142909176141A5DE791F4FE75E'
    const lines = claimUnavailableLines({
      results: [{
        accountId: 'acc-1',
        nickname: 'Trae',
        outcome: { kind: 'unavailable', code: 9074, message: '暂不可签', logid: LOGID },
      }],
    })
    expect(lines).toEqual([`Trae：暂不可签（code 9074） · logid ${LOGID}`])
  })

  it('成功 / 已领 / 活动未开启都不产生 unavailable 行（只有该 kind 才有）', () => {
    const res = {
      results: [
        { accountId: 'a', nickname: 'A', outcome: { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false } },
        { accountId: 'b', nickname: 'B', outcome: { kind: 'already-claimed', message: '今天已签到' } },
        { accountId: 'c', nickname: 'C', outcome: { kind: 'inactive', message: '签到未开启' } },
        { accountId: 'd', nickname: 'D', outcome: { kind: 'failed', code: 1, message: 'x' } },
      ],
      summary: { claimed: 1, totalCredit: 1, alreadyClaimed: 1, inactive: 1, unavailable: 0, failed: 1 },
    }
    expect(claimUnavailableLines(res)).toEqual([])
    expect(buildClaimNotice(res).text).toBe('1 个账号领取成功（+1 积分），1 个今日已领取，1 个活动未开启，1 个失败')
  })

  it('results 缺失或不是数组时不抛错：unavailable 明细为空', () => {
    for (const results of [undefined, null, 'oops', 42]) {
      expect(claimUnavailableLines({ results }), String(results)).toEqual([])
    }
  })

  it('旧宿主不返回 summary.unavailable 时摘要行不出现「NaN 个暂不可签」', () => {
    // 兼容性护栏：`unavailable` 是本次新增字段，旧宿主响应里没有它。
    const notice = buildClaimNotice({
      results: [{ accountId: 'a', nickname: 'A', outcome: { kind: 'claimed', credit: 5, streakDays: 1, isStreakDay: false } }],
      summary: { claimed: 1, totalCredit: 5, alreadyClaimed: 0, inactive: 0, unavailable: 0, failed: 0 },
    })
    expect(notice.text).toBe('1 个账号领取成功（+5 积分）')
    expect(notice.text).not.toContain('NaN')
  })
})
