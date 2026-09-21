/**
 * Qoder wasm glue 层：**视图缓存 × wasm 内存增长**（全部 mock，不加载真实 wasm）。
 *
 * ## 为什么单独一个文件
 *
 * `qoder-wasm.spec.ts` 覆盖的是提取 / 校验 / import 分派 / 签名器契约；
 * 本文件只钉一件事：glue 的 `getDataView()` 在 **wasm 内存增长**
 * （`memory.buffer` 换成一个新对象）之后，必须绑到**新** buffer 上。
 *
 * ## 缺陷（真机实证，成因已定位）
 *
 * 内存增长后 `memory.buffer` 是**新**对象，而新对象的
 * `ArrayBuffer.prototype.detached` 为 `false`（Node ≥21 起该属性存在，
 * 本机 Node 24.19.0 实测 `typeof buf.detached === 'boolean'`）。旧判据
 *
 * ```ts
 * dataView === null || buf.detached === true
 *   || (buf.detached === undefined && dataView.buffer !== buf)
 * ```
 *
 * 的三个分支因此**全部不成立** ⇒ 返回持**旧（已 detached）** buffer 的陈旧
 * 视图 ⇒ 随后的 `getInt32` 抛
 * `TypeError: Cannot perform DataView.prototype.getInt32 on a detached ArrayBuffer`。
 *
 * 真机上大 body（300 KB 明文签名）**必然**触发内存增长（`passString` 内部的
 * wasm `malloc`/`realloc`），故这条路径必炸；炸点在 wasm 上下文的读取层
 * （`qoder-wasm-context` 的 `getDataView().getInt32(rp + 0, true)`），
 * **在发送之前**，与网络无关。
 *
 * 修法是**与当前内存 buffer 按引用直接比较**（`dataView.buffer !== buf` 即
 * 重建），不再拿 `detached` 属性去猜陈旧 —— 那个属性在 Node ≥21 上恒为布尔值，
 * `undefined` 分支根本进不去。
 *
 * ## 两代 Node 语义都覆盖
 *
 * 「新 buffer 上报的 `detached` 值」是**唯一**区分两代运行时的变量，故本文件用
 * `Object.defineProperty` 把它**显式钉死**（own property 覆盖原型上的原生
 * getter）⇒ 两条用例与本机 Node 版本无关；另有一条用真实
 * `WebAssembly.Memory` 覆盖「本机 Node 24 的真实行为」。
 */

import { describe, expect, it } from 'vitest'

import { createGlueInternals } from '../../src/qoder-wasm-glue.js'
import type { QoderWasmExports } from '../../src/qoder-wasm-glue.js'

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** wasm 内存对象的最小形态（与 `src/qoder-wasm-glue.ts` 的私有声明同构）。 */
interface GlueMemory {
  readonly buffer: ArrayBuffer
  grow(delta: number): number
}

/**
 * 真实 wasm 内存构造器。
 *
 * 本仓库 tsconfig 只有 `lib: ["ES2023"]`（无 DOM）⇒ 全局 `WebAssembly` 的
 * **类型**不可见，这里按需取用并配一个最小形态声明（与 src 里那份同构），
 * 而不是往 tsconfig 里加 `"DOM"` —— 见 `src/qoder-wasm-glue.ts` 模块头的理由。
 */
const RealWasmMemory = (globalThis as unknown as {
  WebAssembly: { Memory: new (descriptor: { initial: number }) => GlueMemory }
}).WebAssembly.Memory

/**
 * 造一个「增长即换新 buffer」的假 wasm 内存。
 *
 * 只复刻与视图缓存相关的三条真实语义（其余领域规则一概不模拟，领域规则由
 * 真实 wasm 负责）：
 *
 * 1. 增长后**换绑新对象**（`memory.buffer` 引用变）；
 * 2. 旧 buffer 被**真 detach** —— 持它的视图读取即抛 `TypeError`，这正是本缺陷的伤害面；
 * 3. 内容**保留**（wasm 增长的既有语义，故新视图能读回增长前写下的值）。
 *
 * ⚠️ 第 2 条必须用 `structuredClone(..., { transfer })` **真的**转移，
 * 不能靠 `Object.defineProperty` 伪造 `detached` —— 引擎的「已分离」是内部
 * 状态，`DataView` 读取看的是它，不是那个 JS 属性。
 *
 * @param nextDetached 新 buffer 上报的 `detached` 值 —— **唯一**用来区分两代
 *   运行时的变量：Node ≥21 为 `false`，旧 Node 上该属性不存在（`undefined`）。
 */
function makeFakeMemory(
  nextDetached: boolean | undefined,
  initialBytes = 65_536,
): GlueMemory {
  let buffer = new ArrayBuffer(initialBytes)
  return {
    get buffer(): ArrayBuffer {
      return buffer
    },
    grow(delta: number): number {
      const previous = buffer
      const next = new ArrayBuffer(previous.byteLength + delta * 65_536)
      // 先拷贝内容（transfer 之后 previous 就空了）。
      new Uint8Array(next).set(new Uint8Array(previous))
      structuredClone(previous, { transfer: [previous] })
      // 显式钉死新 buffer 上报的值（own property 覆盖原型 getter）⇒
      // 本用例与本机 Node 版本无关，两代语义都能被确定性地构造出来。
      Object.defineProperty(next, 'detached', { value: nextDetached, configurable: true })
      buffer = next
      return delta
    },
  }
}

/** 用给定内存对象造一套 glue 内部件（本层的视图函数只用到 `memory`）。 */
function internalsWith(memory: GlueMemory): ReturnType<typeof createGlueInternals> {
  return createGlueInternals(() => ({ memory }) as unknown as QoderWasmExports)
}

// ── 前提（不经生产代码：钉住 Node / wasm 的语义事实） ────────────────────────

describe('前提：内存增长后持旧 buffer 的视图必然失效', () => {
  it('真实 WebAssembly.Memory 增长 ⇒ buffer 换新对象、旧视图读取抛 TypeError', () => {
    const memory = new RealWasmMemory({ initial: 1 })
    const before = memory.buffer
    const stale = new DataView(before)

    memory.grow(1)

    // ① 换新对象（不是「同一个对象变大」）。
    expect(memory.buffer).not.toBe(before)
    // ② 旧 buffer 已分离 —— 这就是陈旧视图的伤害面。
    expect(() => stale.getInt32(0, true)).toThrow(TypeError)
    // ③ 本机（Node ≥21）该属性是**布尔值**，`undefined` 分支进不去。
    expect(typeof before.detached).toBe('boolean')
    expect(before.detached).toBe(true)
    expect(typeof memory.buffer.detached).toBe('boolean')
    expect(memory.buffer.detached).toBe(false)
  })
})

// ── 缺陷复现（红 → 绿） ─────────────────────────────────────────────────────

describe('getDataView：内存增长后不得返回陈旧视图', () => {
  it('真实 WebAssembly.Memory 增长后仍能读出值（真机报错点：跨过内存增长的 getInt32）', () => {
    const memory = new RealWasmMemory({ initial: 1 })
    const internals = internalsWith(memory)
    internals.getDataView().setInt32(0, 0x1234_5678, true)

    memory.grow(1)

    const grown = internals.getDataView()
    // 修好后的判据：视图必须绑在**当前**内存 buffer 上。
    // ⚠️ 写成布尔比较而不是 `toBe(memory.buffer)`：失败时 vitest 的 diff 打印器
    // 会去 `new DataView(陈旧buffer)` 格式化，于是**打印器自己**抛
    // `Cannot perform DataView constructor on a detached ArrayBuffer`，
    // 把「断言失败」伪装成「测试基础设施崩溃」（连带跳过同组后续用例）。
    expect(grown.buffer === memory.buffer).toBe(true)
    // 缺陷态：这条断言抛 `TypeError: Cannot perform DataView.prototype.getInt32
    // on a detached ArrayBuffer` —— 与真机上 300 KB 明文签名时炸的那一条同形。
    expect(grown.getInt32(0, true)).toBe(0x1234_5678)
  })

  it('新 buffer 上报 detached=false 且已换新对象 ⇒ 按引用重建（Node ≥21 的判据失效场景）', () => {
    const memory = makeFakeMemory(false)
    const internals = internalsWith(memory)
    const before = memory.buffer
    internals.getDataView().setInt32(0, 0x0bad_c0de, true)

    memory.grow(1)
    // 前提自证：buffer 真的换成了另一个对象，且新对象上报 detached=false
    // —— 旧判据的第二、三分支因此都不成立。
    expect(memory.buffer).not.toBe(before)
    expect(memory.buffer.detached).toBe(false)

    const grown = internals.getDataView()
    expect(grown.buffer === memory.buffer).toBe(true)
    expect(grown.getInt32(0, true)).toBe(0x0bad_c0de)
  })

  it('新 buffer 没有 detached 属性时（旧 Node 模拟）同样按引用重建', () => {
    const memory = makeFakeMemory(undefined)
    const internals = internalsWith(memory)
    const before = memory.buffer
    internals.getDataView().setInt32(0, 0x00c0_ffee, true)

    memory.grow(1)
    expect(memory.buffer).not.toBe(before)
    expect(memory.buffer.detached).toBeUndefined()

    const grown = internals.getDataView()
    expect(grown.buffer === memory.buffer).toBe(true)
    expect(grown.getInt32(0, true)).toBe(0x00c0_ffee)
  })
})

// ── 回归：缓存语义与相邻视图 ────────────────────────────────────────────────

describe('回归：缓存命中与相邻视图（不许被这次修复改坏）', () => {
  it('内存未增长时缓存命中：同一引用，不每次重建', () => {
    const memory = new RealWasmMemory({ initial: 1 })
    const internals = internalsWith(memory)
    expect(internals.getDataView()).toBe(internals.getDataView())
  })

  it('getUint8 在内存增长后同样换新（既有判据本就是对的，钉住它）', () => {
    const memory = new RealWasmMemory({ initial: 1 })
    const internals = internalsWith(memory)
    const before = internals.getUint8()
    before[0] = 0x5a

    memory.grow(1)

    const after = internals.getUint8()
    expect(after.buffer === memory.buffer).toBe(true)
    expect(after[0]).toBe(0x5a)
    // 没有再次增长时仍然缓存命中。
    expect(internals.getUint8()).toBe(after)
  })
})
