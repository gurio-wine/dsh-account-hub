/**
 * Qoder wasm 的 **wasm-bindgen glue 层**（手写复刻，两个 region 共用）。
 *
 * ## 为什么需要手写 glue
 *
 * 官方 wasm 是 **wasm-bindgen 产物**：它自己不管理 JS 堆，而是 import 一整套
 * `./qoder_auth_wasm_bg.js` 的宿主函数（31 个），并由配套的 JS glue 负责
 * 「JS 值 ↔ 堆槽索引」的搬运。官方把那份 glue **内联在 35 MB 的 worker
 * runtime 里**（与 wasm 的 base64 同文件），本插件不整体加载那个文件
 * （它自带 CLI 全家桶、会拉起进程/终端等一堆无关副作用），故只把**这一层**
 * 按取证的契约复刻出来。
 *
 * ## 契约来自取证，不是推断
 *
 * 31 个 import 的语义**逐条从官方 worker 的 `Uir()` 函数里读出**（它就是
 * `WebAssembly.instantiate` 的 imports 对象字面量），本文件按同样的语义实现。
 * 关键几条：
 *
 * - `__wbindgen_object_drop_ref` = 取走堆槽（`takeObject`）
 * - `__wbindgen_cast_0000000000000002` = 从 wasm 内存读 UTF-8 字符串并**入堆**
 * - `__wbg_getRandomValues_…` 有**两个**，语义不同：一个用 `globalThis.crypto`，
 *   另一个用宿主对象的 `getRandomValues` ⇒ **必须按完整名区分**，不能按前缀合并。
 * - `__wbg_new_with_length_…` 与 `__wbg_new_99cabae501c0a8a0` 前缀相近但语义
 *   不同（前者 `new Uint8Array(len)`、后者 `new Map()`）⇒ 同样按完整名区分。
 *
 * ## 版本漂移的应对
 *
 * wasm-bindgen 会给 import 名加**内容哈希后缀**（如 `__wbg_length_0c32cb8543c8e4c8`），
 * 换版本时后缀会变。故分派顺序是「**精确名 → 前缀**」：精确名钉死那两个
 * 同名不同义的坑，前缀兜住后缀漂移。遇到**完全无法识别**的 import 时
 * **显式抛错**（而不是塞个空函数）—— 静默的空实现会让 wasm 在深处以
 * 「签名算错」的形态失败，比立即报错难查得多。
 */

import { createRequire } from 'node:module'

/**
 * 最小 `WebAssembly` 类型声明（**模块内私有，不污染全局**）。
 *
 * 本仓库的 `tsconfig.json` 只声明了 `"lib": ["ES2023"]` —— 没有 DOM，
 * 因此全局的 `WebAssembly` 命名空间不可见。这里**只声明用到的三样**
 * （`Memory` / `instantiate` / `Imports`），而不是往共享 tsconfig 里加
 * `"DOM"`：加 DOM lib 会一次性放开几百个浏览器全局（`window`、`document`…），
 * 让「宿主侧代码误用浏览器 API」这类错误不再被编译器拦住 —— 那是整个仓库的
 * 类型防线，不该为这一个模块让路。
 */
declare namespace WebAssembly {
  interface Memory {
    readonly buffer: ArrayBuffer
    grow(delta: number): number
  }
  type ImportValue = (...args: never[]) => unknown
  interface Imports {
    [module: string]: Record<string, ImportValue | Memory | Table | Global>
  }
  interface Table { readonly length: number }
  interface Global { readonly value: unknown }
  interface Instance {
    readonly exports: Record<string, unknown>
  }
  interface InstantiateResult {
    readonly instance: Instance
    readonly module: unknown
  }
  function instantiate(
    bytes: ArrayBuffer | ArrayBufferView,
    imports: Imports,
  ): Promise<InstantiateResult>
}

/** 本文件对上层暴露的 wasm 实例类型（只声明用到的导出）。 */
export interface QoderWasmExports {
  memory: WebAssembly.Memory
  qodercontext_new: (rp: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void
  qodercontext_prepareInferRequest: (rp: number, ctx: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void
  qodercontext_prepareRequest: (rp: number, ctx: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void
  qodercontext_refreshAuthFields: (rp: number, ctx: number, ptr: number, len: number) => void
  requestresult_url: (rp: number, rr: number) => void
  requestresult_body: (rp: number, rr: number) => void
  requestresult_headers: (rr: number) => number
  requestresult_headerCount: (rr: number) => number
  generate_runtime_auth_fields: (rp: number, ptr: number, len: number) => void
  decrypt_server_response: (rp: number, ptr: number, len: number) => void
  __wbg_qodercontext_free: (ptr: number, arg: number) => void
  __wbg_requestresult_free: (ptr: number, arg: number) => void
  __wbindgen_add_to_stack_pointer: (delta: number) => number
  __wbindgen_export: (a: number) => void
  __wbindgen_export2: (a: number, b: number) => number
  __wbindgen_export3: (a: number, b: number, c: number, d: number) => number
  __wbindgen_export4: (a: number, b: number, c: number) => void
}

/** 跨模块复用的 require（wasm 的 `__wbg_require_` import 需要它）。 */
const nodeRequire = createRequire(import.meta.url)

/**
 * 复刻 wasm-bindgen glue 的**通用机制**（堆槽、内存视图、字符串搬运）。
 *
 * ⚠️ 参数是 **getter 而不是实例**：`WebAssembly.instantiate` 要求 imports 在
 * 调用**之前**就绪，而 imports 的实现需要访问 wasm 导出（读 `memory`、
 * 调 `__wbindgen_export`）—— 这是个先有鸡还是先有蛋的循环。用 getter 打破它：
 * 实例化期间 wasm 侧若调用 import，`getWasm()` 已经能拿到（引擎在 start
 * 段之前就绑好了 exports），而实例化完成后同一个 getter 返回真实实例。
 *
 * 因此本函数**只应被调用一次**（每次调用都会新建一套堆槽，wasm 只认
 * `instantiate` 时给的那一套）。
 */
export function createGlueInternals(getWasm: () => QoderWasmExports): {
  getObject: (idx: number) => unknown
  dropObject: (idx: number) => void
  takeObject: (idx: number) => unknown
  addHeapObject: (value: unknown) => number
  getDataView: () => DataView
  getUint8: () => Uint8Array
  getString: (ptr: number, len: number) => string
  getArrayU8: (ptr: number, len: number) => Uint8Array
  passString: (arg: string, malloc: (n: number, s: number) => number, realloc: (p: number, a: number, b: number, c: number) => number) => number
  vectorLen: () => number
} {
  const heap: unknown[] = new Array(1024).fill(undefined)
  // 官方 glue 在初始化时 push 了四个哨兵值，堆槽从 1028 开始分配。
  heap.push(undefined, null, true, false)
  let heapNext = heap.length
  let dataView: DataView | null = null
  let uint8: Uint8Array | null = null
  let vectorLength = 0

  const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const textEncoder = new TextEncoder()
  // 官方 glue 在初始化时先 decode 一次空的（触发内部惰性初始化）。
  textDecoder.decode()

  const getObject = (idx: number): unknown => heap[idx]

  const dropObject = (idx: number): void => {
    // 前 1028 个槽是保留区（哨兵 + 空），回收索引不得写回去。
    if (idx < 1028) return
    heap[idx] = heapNext
    heapNext = idx
  }

  const takeObject = (idx: number): unknown => {
    const value = getObject(idx)
    dropObject(idx)
    return value
  }

  const addHeapObject = (value: unknown): number => {
    if (heapNext === heap.length) heap.push(heap.length + 1)
    const idx = heapNext
    heapNext = heap[idx] as number
    heap[idx] = value
    return idx
  }

  /**
   * wasm 内存的 4 字节对齐视图（缓存，但**陈旧判据按引用比较**）。
   *
   * ⚠️ **不要改用 `buf.detached` 去判陈旧**（真机缺陷，2026-09-21）：
   * 内存增长后 `memory.buffer` 是**新**对象，而新对象的
   * `ArrayBuffer.prototype.detached` 为 **`false`**（Node ≥21 起该属性存在，
   * 本机 Node 24.19.0 实测 `typeof === 'boolean'`）⇒ 「靠 `detached` 猜陈旧」
   * 的判据两个分支都不成立，于是返回持**旧（已 detached）** buffer 的视图，
   * 随后的 `getInt32` 抛
   * `TypeError: Cannot perform DataView.prototype.getInt32 on a detached ArrayBuffer`。
   * 大 body（明文签名）必然经 `passString` 内部的 wasm `malloc`/`realloc`
   * 触发内存增长，故那条路径**必炸**、且炸点在发送之前（与网络无关）。
   *
   * 唯一可靠的判据是**与当前内存 buffer 按引用比较**：换绑了新对象即重建。
   */
  const getDataView = (): DataView => {
    const buf = getWasm().memory.buffer
    if (dataView === null || dataView.buffer !== buf) dataView = new DataView(buf)
    return dataView
  }

  const getUint8 = (): Uint8Array => {
    if (uint8 === null || uint8.byteLength === 0) uint8 = new Uint8Array(getWasm().memory.buffer)
    return uint8
  }

  const getString = (ptr: number, len: number): string => textDecoder.decode(getUint8().subarray(ptr, ptr + len))
  const getArrayU8 = (ptr: number, len: number): Uint8Array => getUint8().subarray(ptr, ptr + len)

  /**
   * 把 JS 字符串搬进 wasm 内存。
   *
   * 两段式（先按 UTF-16 长度试写 ASCII 前缀，遇到非 ASCII 再 realloc 扩到
   * `len + 3×剩余`）是 wasm-bindgen 的既有做法 —— 照抄它，不要「优化」成
   * 一次性 `TextEncoder.encode`：`realloc` 的调用次数与参数是 wasm 侧
   * 分配器所期望的，改变它会引入内存布局差异。
   */
  const passString = (
    arg: string,
    malloc: (n: number, s: number) => number,
    realloc: (p: number, oldLen: number, newLen: number, align: number) => number,
  ): number => {
    let len = arg.length
    let ptr = malloc(len, 1) >>> 0
    const mem = getUint8()
    let offset = 0
    for (; offset < len; offset += 1) {
      const code = arg.charCodeAt(offset)
      if (code > 0x7f) break
      mem[ptr + offset] = code
    }
    if (offset !== len) {
      if (offset !== 0) arg = arg.slice(offset)
      // ⚠️ realloc 的第二参是**旧长度**（官方逐字如此）—— 传错会让 wasm 侧
      // 分配器按错的尺寸搬内存。
      const grown = offset + arg.length * 3
      ptr = realloc(ptr, len, grown, 1) >>> 0
      const view = getUint8().subarray(ptr + offset, ptr + grown)
      offset += textEncoder.encodeInto(arg, view).written
      ptr = realloc(ptr, grown, offset, 1) >>> 0
    }
    vectorLength = offset
    return ptr
  }

  return {
    getObject,
    dropObject,
    takeObject,
    addHeapObject,
    getDataView,
    getUint8,
    getString,
    getArrayU8,
    passString,
    vectorLen: () => vectorLength,
  }
}

/**
 * 构造 `WebAssembly.instantiate` 所需的 imports 对象。
 *
 * `name` 是 wasm 声明的 import 名（带哈希后缀）。分派规则见模块头。
 */
export function createGlueImports(
  getWasm: () => QoderWasmExports,
  internals: ReturnType<typeof createGlueInternals>,
): WebAssembly.Imports {
  const {
    getObject, takeObject, addHeapObject, getString, getArrayU8,
  } = internals

  /** 包一层 try/catch：异常要抛回 wasm（由它转成 JS 异常再抛出）。 */
  const forward = (fn: (...args: never[]) => unknown, args: unknown[]): unknown => {
    try {
      return fn.apply(undefined, args as never[])
    } catch (error) {
      getWasm().__wbindgen_export(addHeapObject(error))
      return undefined
    }
  }

  /** 精确名 → 实现（钉死同名不同义的那几个）。 */
  const exact: Record<string, (...args: never[]) => unknown> = {
    // ⚠️ 两个 getRandomValues 语义不同，必须按完整名区分。
    // 这个用 globalThis.crypto（官方 glue 里直接调 `globalThis.crypto`）。
    __wbg_getRandomValues_d49329ff89a07af1: ((ptr: number, len: number) =>
      forward(() => { globalThis.crypto.getRandomValues(getArrayU8(ptr, len)) }, [])) as never,
    // 这个用宿主对象自己的 getRandomValues。
    __wbg_getRandomValues_c44a50d8cfdaebeb: ((a: number, b: number) =>
      forward(() => { (getObject(a) as { getRandomValues: (v: unknown) => void }).getRandomValues(getObject(b)) }, [])) as never,
    // ⚠️ 新 Map()：前缀与 new_with_length 相近，必须精确匹配。
    __wbg_new_99cabae501c0a8a0: (() => addHeapObject(new Map())) as never,
    __wbindgen_object_drop_ref: ((a: number) => { takeObject(a) }) as never,
    __wbindgen_object_clone_ref: ((a: number) => addHeapObject(getObject(a))) as never,
    // wasm → JS 的两个 cast：一个搬字节数组、一个搬字符串。
    __wbindgen_cast_0000000000000001: ((a: number, b: number) => addHeapObject(getArrayU8(a, b))) as never,
    __wbindgen_cast_0000000000000002: ((a: number, b: number) => addHeapObject(getString(a, b))) as never,
    __wbindgen_string_new: ((a: number, b: number) => addHeapObject(getString(a, b))) as never,
  }

  /** 前缀 → 实现（兜住哈希后缀漂移）。顺序敏感：长前缀在前。 */
  const byPrefix: Array<[string, (...args: never[]) => unknown]> = [
    ['__wbg_new_with_length_', ((a: number) => addHeapObject(new Uint8Array(a >>> 0))) as never],
    ['__wbg_prototypesetcall_', ((a: number, b: number, c: number) => {
      Uint8Array.prototype.set.call(getArrayU8(a, b), getObject(c) as ArrayLike<number>)
    }) as never],
    ['__wbg_randomFillSync_', ((a: number, b: number) =>
      forward(() => { (getObject(a) as { randomFillSync: (v: unknown) => void }).randomFillSync(takeObject(b)) }, [])) as never],
    ['__wbg_static_accessor_GLOBAL_THIS_', (() => accessor('globalThis')) as never],
    ['__wbg_static_accessor_SELF_', (() => accessor('self')) as never],
    ['__wbg_static_accessor_GLOBAL_', (() => accessor('global')) as never],
    ['__wbg_static_accessor_WINDOW_', (() => accessor('window')) as never],
    ['__wbg_subarray_', ((a: number, b: number, c: number) =>
      addHeapObject((getObject(a) as Uint8Array).subarray(b >>> 0, c >>> 0))) as never],
    ['__wbg_versions_', ((a: number) => addHeapObject((getObject(a) as { versions: unknown }).versions)) as never],
    ['__wbg_length_', ((a: number) => (getObject(a) as { length: number }).length) as never],
    ['__wbg_msCrypto_', ((a: number) => addHeapObject((getObject(a) as { msCrypto: unknown }).msCrypto)) as never],
    ['__wbg_crypto_', ((a: number) => addHeapObject((getObject(a) as { crypto: unknown }).crypto)) as never],
    ['__wbg_process_', ((a: number) => addHeapObject((getObject(a) as { process: unknown }).process)) as never],
    ['__wbg_node_', ((a: number) => addHeapObject((getObject(a) as { node: unknown }).node)) as never],
    ['__wbg_require_', (() => addHeapObject(nodeRequire)) as never],
    ['__wbg_set_', ((a: number, b: number, c: number) =>
      addHeapObject((getObject(a) as { set: (x: unknown, y: unknown) => unknown }).set(getObject(b), getObject(c)))) as never],
    ['__wbg_call_', (function (...args: unknown[]) {
      const [fn, thisArg, arg] = args as [Function, unknown, unknown]
      return forward(() => addHeapObject(fn.call(thisArg, arg)), [])
    }) as never],
    ['__wbg_now_', (() => Date.now()) as never],
    ['__wbg_Error_', ((a: number, b: number) => addHeapObject(Error(getString(a, b)))) as never],
    // ⚠️ 这三个 is_* 必须在下面的 `__wbg___wbindgen_is_` 系列之前被匹配到。
    ['__wbg___wbindgen_throw_', ((a: number, b: number) => { throw new Error(getString(a, b)) }) as never],
  ]

  /** 兜底：`__wbindgen_is_xxx` 系列与未知名。 */
  const isPredicates: Record<string, (value: unknown) => boolean> = {
    '__wbg___wbindgen_is_function_': (v) => typeof v === 'function',
    '__wbg___wbindgen_is_object_': (v) => typeof v === 'object' && v !== null,
    '__wbg___wbindgen_is_string_': (v) => typeof v === 'string',
    '__wbg___wbindgen_is_undefined_': (v) => v === undefined,
    '__wbg___wbindgen_is_null_': (v) => v === null,
    '__wbg___wbindgen_is_bigint_': (v) => typeof v === 'bigint',
  }

  function accessor(globalName: 'globalThis' | 'self' | 'global' | 'window'): number {
    const record = globalThis as unknown as Record<string, unknown>
    const value = globalName === 'globalThis' ? globalThis : (record[globalName] ?? null)
    return value === null || value === undefined ? 0 : addHeapObject(value)
  }

  const module = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string): unknown {
      const direct = exact[prop]
      if (direct !== undefined) return direct
      for (const [prefix, impl] of byPrefix) {
        if (prop.startsWith(prefix)) return impl
      }
      for (const [prefix, predicate] of Object.entries(isPredicates)) {
        if (prop.startsWith(prefix)) return (a: number) => predicate(getObject(a))
      }
      // 未知 import：显式抛错。塞空函数会让 wasm 在深处以「签名算错」的形态
      // 失败，比在这里立即报错难查得多。
      throw new Error(
        `Qoder wasm 需要未实现的宿主函数 ${prop}（wasm 版本可能与当前实现不匹配）`,
      )
    },
  })

  // 官方 wasm 声明的 import 模块名就是这一个（含 `.js` 后缀）。
  return { './qoder_auth_wasm_bg.js': module as Record<string, WebAssembly.ImportValue> }
}

/**
 * 用官方 wasm 字节实例化并返回 glue 句柄。
 *
 * @param bytes 官方 wasm 字节（调用方应先过 `verifyQoderWasm`）。
 */
export async function instantiateQoderWasm(bytes: Uint8Array): Promise<{
  wasm: QoderWasmExports
  internals: ReturnType<typeof createGlueInternals>
}> {
  // imports 必须在 instantiate **之前**交出去，而它的实现要读 wasm 导出
  // （forward 里的 __wbindgen_export、内存视图）⇒ 用可变壳 + getter 打破循环。
  let wasm: QoderWasmExports | undefined
  const getWasm = (): QoderWasmExports => {
    if (wasm === undefined) {
      throw new Error('Qoder wasm glue 在实例化完成前被调用（内部错误）')
    }
    return wasm
  }
  const internals = createGlueInternals(getWasm)
  const imports = createGlueImports(getWasm, internals)

  const { instance } = await WebAssembly.instantiate(bytes, imports)
  wasm = instance.exports as unknown as QoderWasmExports
  return { wasm, internals }
}

/** 供上层读取的 glue 句柄类型。 */
export type QoderGlue = Awaited<ReturnType<typeof instantiateQoderWasm>>
