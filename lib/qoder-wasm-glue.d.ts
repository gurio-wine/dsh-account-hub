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
        readonly buffer: ArrayBuffer;
        grow(delta: number): number;
    }
    type ImportValue = (...args: never[]) => unknown;
    interface Imports {
        [module: string]: Record<string, ImportValue | Memory | Table | Global>;
    }
    interface Table {
        readonly length: number;
    }
    interface Global {
        readonly value: unknown;
    }
    interface Instance {
        readonly exports: Record<string, unknown>;
    }
    interface InstantiateResult {
        readonly instance: Instance;
        readonly module: unknown;
    }
    function instantiate(bytes: ArrayBuffer | ArrayBufferView, imports: Imports): Promise<InstantiateResult>;
}
/** 本文件对上层暴露的 wasm 实例类型（只声明用到的导出）。 */
export interface QoderWasmExports {
    memory: WebAssembly.Memory;
    qodercontext_new: (rp: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    qodercontext_prepareInferRequest: (rp: number, ctx: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    qodercontext_prepareRequest: (rp: number, ctx: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void;
    qodercontext_refreshAuthFields: (rp: number, ctx: number, ptr: number, len: number) => void;
    requestresult_url: (rp: number, rr: number) => void;
    requestresult_body: (rp: number, rr: number) => void;
    requestresult_headers: (rr: number) => number;
    requestresult_headerCount: (rr: number) => number;
    generate_runtime_auth_fields: (rp: number, ptr: number, len: number) => void;
    decrypt_server_response: (rp: number, ptr: number, len: number) => void;
    __wbg_qodercontext_free: (ptr: number, arg: number) => void;
    __wbg_requestresult_free: (ptr: number, arg: number) => void;
    __wbindgen_add_to_stack_pointer: (delta: number) => number;
    __wbindgen_export: (a: number) => void;
    __wbindgen_export2: (a: number, b: number) => number;
    __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    __wbindgen_export4: (a: number, b: number, c: number) => void;
}
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
export declare function createGlueInternals(getWasm: () => QoderWasmExports): {
    getObject: (idx: number) => unknown;
    dropObject: (idx: number) => void;
    takeObject: (idx: number) => unknown;
    addHeapObject: (value: unknown) => number;
    getDataView: () => DataView;
    getUint8: () => Uint8Array;
    getString: (ptr: number, len: number) => string;
    getArrayU8: (ptr: number, len: number) => Uint8Array;
    passString: (arg: string, malloc: (n: number, s: number) => number, realloc: (p: number, a: number, b: number, c: number) => number) => number;
    vectorLen: () => number;
};
/**
 * 构造 `WebAssembly.instantiate` 所需的 imports 对象。
 *
 * `name` 是 wasm 声明的 import 名（带哈希后缀）。分派规则见模块头。
 */
export declare function createGlueImports(getWasm: () => QoderWasmExports, internals: ReturnType<typeof createGlueInternals>): WebAssembly.Imports;
/**
 * 用官方 wasm 字节实例化并返回 glue 句柄。
 *
 * @param bytes 官方 wasm 字节（调用方应先过 `verifyQoderWasm`）。
 */
export declare function instantiateQoderWasm(bytes: Uint8Array): Promise<{
    wasm: QoderWasmExports;
    internals: ReturnType<typeof createGlueInternals>;
}>;
/** 供上层读取的 glue 句柄类型。 */
export type QoderGlue = Awaited<ReturnType<typeof instantiateQoderWasm>>;
export {};
//# sourceMappingURL=qoder-wasm-glue.d.ts.map