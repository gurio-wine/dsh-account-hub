/**
 * Qoder **`QoderContext` 封装**（两区共用）—— 把 wasm 边界收在这一层。
 *
 * ## 三件套语义（真机 + 官方源码双重取证）
 *
 * 官方 CLI 的请求构造是这一个形态（`ari()` 函数，逐字取证）：
 *
 * ```js
 * function ari(endpoint, body, modelKey, modelSource, auth) {
 *   const r = Wd(n => n.prepareInferRequest(endpoint, body, modelKey, modelSource))
 *   return { url: r.url, headers: gd(r.headers), body: r.body, free: () => r.free() }
 * }
 * ```
 *
 * ⚠️ **`prepareInferRequest` 返回的 `body` 是加密后的密文，必须整包替换原
 * body** —— 只往原 body 上补几个签名头必然被上游判 `101 Signature invalid`。
 * 同理 URL 也由它给出（含 `?FetchKeys=…&AgentId=…&Encode=1` 查询串），
 * headers 是 20 项（含 `Authorization: Bearer COSY.…`、`Cosy-Key`、`Cosy-Date`）。
 *
 * ## `endpoint` 参数是 **host 基址**，不是完整 URL
 *
 * wasm 侧自己拼 `{endpoint}{固定路径}`。实测：传完整 URL 会得到
 * `…/algo/…/agent_chat_generation/algo/…/agent_chat_generation`（路径重复两遍）；
 * 传 `https://gateway.qoder.com.cn` 才得到正确 URL。
 *
 * ## `machineId` / `cosyVersion` / `userInfoJson` / `clientMetadata`
 *
 * | 参数 | 取值 |
 * |---|---|
 * | `machineId` | **登录链落盘的那个**（`readOrCreateQoderMachineId`：`~/.qoder/.auth/machine_id`，CN 是 `~/.qoder-cn/…`），36 字符 UUID |
 * | `cosyVersion` | CLI 版本（官方兜底 `1.1.57`） |
 * | `userInfoJson` | 见下 —— **必须先跑 `generate_runtime_auth_fields`** |
 * | `clientMetadata` | `JSON.stringify(kg())`，见 {@link qoderClientMetadata} |
 *
 * ⚠️ `machineId` **刻意不复用官方契约里那个 `product` 位置**：把 `product` 挂在
 * `contextFor()` 入参上会让同一签名器实例被两个 region 交替使用（拿 CN 的机器码
 * 签国际版的请求），而上游对此的回复是 `101 Signature invalid` —— 与「凭据失效」
 * 同形。故 region 绑定在**构造签名器**时，`contextFor()` 只收每次请求会变的东西。
 *
 * ⚠️ 官方 `yfe()` 内部就是 `JSON.stringify(kg())` 自算第四参，故本模块自己
 * 算一遍即可（不依赖官方那个函数）。
 *
 * ## `userInfoJson` 的两个阶段（**关键，漏了会构造失败**）
 *
 * wasm 构造时会校验 `encrypt_user_info` **字段存在**（缺失直接抛
 * `Invalid user info: missing field \`encrypt_user_info\``）。所以有两步：
 *
 * 1. 先用**五个业务字段**调 `generate_runtime_auth_fields`，拿回
 *    `{encrypt_user_info, key}`；
 * 2. 把这两个字段**并进** userInfoJson 再构造上下文。
 *
 * 这正是官方 `regenerateRuntimeFields()` 的做法（逐字取证）。PAT 路径同样要跑
 * —— 官方 `loginWithPAT` 末尾也调它。
 *
 * ## 实例复用
 *
 * 一次构造 = 一次 wasm 侧密钥派生，不必每个请求重来。但**凭据换了必须重建**：
 * `userInfoJson` 里嵌着 `security_oauth_token` 与由它派生的 `encrypt_user_info`，
 * 复用旧上下文会让新凭据签出旧身份的签名。故本模块以
 * {@link qoderUserInfoFingerprint} 为判据做复用/重建。
 */
import type { QoderMachineIdOptions } from './qoder-device-flow.js';
import type { QoderProduct } from './qoder-product.js';
import type { QoderGlue, QoderWasmExports } from './qoder-wasm-glue.js';
/**
 * 签名路径（chat）：`POST {chatBaseHost}{该路径}`。
 *
 * 官方 CLI 实测 200 + SSE 的路径；包内亦点名该路径走 wasm 签名。
 */
export declare const QODER_SIGNED_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
/**
 * `cosyVersion` 的兜底值。
 *
 * 官方是 `Pie = Oke || "1.1.57"`。本插件优先用产品配置的 `cosyVersion`
 * （CN 有显式值），缺省才落到这里。
 */
export declare const QODER_DEFAULT_COSY_VERSION = "1.1.57";
/**
 * `clientMetadata` 的**非 work 模式**默认值（官方 `kg()` 逐字取证）。
 *
 * ```js
 * function kg(){ const A = og(); return {
 *   client_type:      process.env.CLIENT_TYPE      ?? (A ? "6" : "5"),
 *   business_product: process.env.BUSINESS_PRODUCT ?? (A ? "qoder_work" : "cli"),
 *   business_type:    process.env.BUSINESS_TYPE    ?? "agent",
 *   scene:            process.env.SCENE            ?? "assistant" } }
 * ```
 *
 * ⚠️ 本插件**不复刻 `QODER_WORK_INTEGRATION_MODE` 分支**（那是官方 Work 集成
 * 形态，与本插件无关），只取默认分支。`client_type` 仍按 region 走产品配置
 * （CN 是 `5`，国际版 `qodercli` —— 见 {@link qoderClientType}）。
 */
export declare const QODER_DEFAULT_BUSINESS_PRODUCT = "cli";
export declare const QODER_DEFAULT_BUSINESS_TYPE = "agent";
export declare const QODER_DEFAULT_SCENE = "assistant";
/** 进 `userInfoJson` 的业务字段（`generate_runtime_auth_fields` 的入参形态）。 */
export interface QoderUserInfoInput {
    /** 用户 id（官方 PAT 路径可为空串）。 */
    uid: string;
    /** 长期令牌（PAT 或设备流 token）—— 签名把它绑进身份。 */
    securityOauthToken: string;
    /** 组织 id（个人账号为空串）。 */
    organizationId: string;
    /** 组织标签（无则空数组）。 */
    organizationTags: readonly string[];
    /** 是否已同意数据策略。 */
    dataPolicyAgreed: boolean;
}
/** `prepareInferRequest` 的产物（**整包替换**原 URL/headers/body）。 */
export interface QoderInferRequest {
    /** 签名后的完整 URL（**直接用它**，不要再拼路径）。 */
    url: string;
    /** 签名头（20 项；`Map` 保持 wasm 侧给的顺序）。 */
    headers: Map<string, string>;
    /** 签名后的请求体（**密文**）。 */
    body: string;
    /** wasm 资源的释放函数（**用完必须调**，否则 wasm 线性内存泄漏）。 */
    free: () => void;
}
/**
 * `prepareRequest`（**目录 GET**）的产物。
 *
 * 与 {@link QoderInferRequest} 的差别只有一个：**没有 body**（GET 无请求体，
 * wasm 的 RequestResult 也按无 body 处理）。URL 与 headers 的语义完全相同
 * —— **原样发出，不做任何二次加工**。
 */
export interface QoderPreparedRequest {
    /** 签名后的完整 URL（wasm 已拼好 `/algo` 前缀与查询串）。 */
    url: string;
    /** 签名头（`Map` 保持 wasm 侧给的顺序）。 */
    headers: Map<string, string>;
    /** wasm 资源的释放函数（值拷进 JS 后调用；本实现里 RequestResult 已即时释放）。 */
    free: () => void;
}
/**
 * 组装 `clientMetadata` JSON（官方 `kg()` 的等价物）。
 *
 * 导出成纯函数便于单测逐字钉死字段集 —— 它是**出站身份标识**，
 * 少一个字段或多一个字段都会改变上游归因。
 */
export declare function qoderClientMetadata(product: QoderProduct): string;
/**
 * 组装**第一段** `userInfoJson`（五字段，喂给 `generate_runtime_auth_fields`）。
 *
 * 字段集与顺序**逐字对齐官方** `regenerateRuntimeFields()` —— 它把这五个字段
 * `JSON.stringify` 后交给 wasm 派生 `encrypt_user_info`。顺序虽不该有语义，
 * 但保持一致能让「官方能跑、我们不能」时排除掉序列化差异这个变量。
 */
export declare function buildQoderRuntimeAuthInput(input: QoderUserInfoInput): string;
/**
 * 组装**第二段** `userInfoJson`（并进派生字段后的完整形态）。
 *
 * `encrypt_user_info` / `key` 放在**最后**，与官方 `cachedUserInfo` 的字段
 * 追加顺序一致（官方是先有业务字段、再由 `regenerateRuntimeFields` 补这两个）。
 */
export declare function buildQoderUserInfoJson(input: QoderUserInfoInput, derived: {
    encrypt_user_info: string;
    key: string;
}): string;
/**
 * 凭据指纹 —— **实例复用/重建的唯一判据**。
 *
 * 覆盖全部会进 `userInfoJson` 的字段（含令牌本体）：令牌换了却复用旧上下文，
 * 签出来的就是**旧身份**的签名，而上游只会回那句笼统的 `101 Signature invalid`。
 *
 * 用 JSON 串而不是哈希：指纹只用于**同进程内比较**，不做持久化，没必要付
 * 哈希的代价，而可读的串在排查时能直接看出是哪个字段变了。
 */
export declare function qoderUserInfoFingerprint(input: QoderUserInfoInput): string;
/**
 * 解码目录响应（官方 `kfe` 的语义逐字复刻）。
 *
 * 官方（stage-a 取证 E4）：`try { return SE().decrypt_server_response(A) }
 * catch { return A }` —— **解码失败原样返回输入**（明文兼容）。这个 catch
 * 包的是**整个调用**（glue 层与 wasm 侧都算），不是只包 wasm：官方没法区分
 * 失败发生在哪一层，我们也照抄，因为「响应是密文还是明文」只有试过才知道。
 */
export declare function decryptQoderServerResponse(glue: QoderGlue, text: string): string;
/** 构造 `QoderContext` 所需的全部输入。 */
export interface QoderContextInit {
    /**
     * 36 字符机器码。
     *
     * **省略时本模块自己去取**（见 {@link QoderWasmSignerOptions.machineIdSource}）：
     * 默认走登录链的 `readOrCreateQoderMachineId(product)`，与官方 CLI / 设备流
     * 读**同一个文件**（`~/.qoder/.auth/machine_id`，CN 是 `~/.qoder-cn/…`）。
     *
     * ⚠️ **只在测试 / 显式派发时传**：随便给一个值会让签名头与登录侧记下的
     * 机器身份不一致，而上游对这种不一致的回复是 `101 Signature invalid`
     * —— 与「凭据失效」同形，极难排查。
     */
    machineId?: string;
    /** 用户信息（业务字段；派生字段由本模块自己算）。 */
    userInfo: QoderUserInfoInput;
    /** `cosyVersion` 覆盖（缺省取 `product.cosyVersion`，再缺省 `1.1.57`）。 */
    cosyVersion?: string;
}
/**
 * 一个**已就绪**的 Qoder 签名上下文。
 *
 * 生命周期由 {@link QoderWasmSigner} 管理；调用方只拿 `prepareInferRequest`。
 */
export declare class QoderSigningContext {
    private readonly glue;
    private readonly ptr;
    private disposed;
    /** @internal 只由 {@link QoderWasmSigner} 构造。 */
    constructor(glue: QoderGlue, ptr: number);
    /**
     * 构造签名请求（**返回的三件套必须整包替换原请求**）。
     *
     * @param endpoint **host 基址**（如 `https://gateway.qoder.com.cn`），
     *   ⚠️ **不是**完整 URL —— 路径由 wasm 侧自己拼。
     * @param body 原始 JSON 请求体（明文）。
     * @param modelKey 模型 id（`X-Model-Key` 头）。
     * @param modelSource 模型来源 function（`X-Model-Source` 头）。
     */
    prepareInferRequest(endpoint: string, body: string, modelKey: string, modelSource: string): QoderInferRequest;
    /**
     * 构造**目录 GET** 的签名请求（官方 `sri()` 普通账号分支的逐字复刻）。
     *
     * 官方调用形态（stage-a 取证 E2/E3）：`prepareRequest(endpoint, path,
     * "GET", "auth", void 0, void 0)` —— 返回的 `RequestResult` 与
     * `prepareInferRequest` 同形（url / headers），**没有 body**（GET）。
     * wasm ABI 里那 4 个 None 槽位（两个 `Option<String>`）按 wasm-bindgen
     * 语义传 `(0, 0)`。
     *
     * ⚠️ **`/algo` 前缀由 wasm 内部拼**（官方 service-account 分支才用 JS 侧的
     * `Aoe()` 拼；普通账号分支直接拿 `i.url`）—— 返回的 `url` 原样发，**不要**
     * 在 JS 侧再补前缀或过任何「修正」，否则签名作废（`101 Signature invalid`）。
     *
     * @param endpoint **host 基址**（同 {@link QoderSigningContext.prepareInferRequest}）。
     * @param path 目录路径（含查询串，如 `/api/v2/model/list?Encode=1`）。
     * @param method HTTP 方法（官方恒 `"GET"`）。
     * @param requestClass 官方的请求类（目录链恒 `"auth"`，与 chat 的 body 签名同类）。
     */
    prepareRequest(endpoint: string, path: string, method: string, requestClass: string): QoderPreparedRequest;
    /** 释放 wasm 侧上下文。重复调用安全。 */
    dispose(): void;
}
/** {@link QoderWasmSigner} 的依赖注入面（测试用）。 */
export interface QoderWasmSignerOptions {
    /** 已实例化的 glue（由 `instantiateQoderWasm` 产出，或测试注入的假实例）。 */
    glue: QoderGlue;
    /**
     * 产品配置 —— **签名身份的唯一来源**（决定 `clientMetadata` / `cosyVersion`
     * / machine_id 路径）。
     *
     * ⚠️ 刻意**不从 `contextFor()` 的入参取**：一个签名器必须绑定一个 region，
     * 若允许每次调用带一个 `product`，同一实例就可能被两个 region 交替使用
     * —— 拿 CN 的机器码去签国际版的请求，上游回 `101 Signature invalid`
     * （与凭据失效同形）。构造时绑定一次，调用方按 region 各建一个签名器。
     */
    product: QoderProduct;
    /**
     * machineId 取用策略（缺省 {@link readSignerMachineId}：读登录链落盘的那个）。
     *
     * 两层注入面是**刻意分开**的：
     * - 想验证「确实走了登录链的真实契约」⇒ 传 `machineIdOptions`（假 homeDir /
     *   假 IO），仍然跑真函数；
     * - 想绕过文件系统、只钉死「取用时机」（缓存 / 重建）⇒ 换掉整个函数。
     */
    readMachineId?: (product: QoderProduct, options?: QoderMachineIdOptions) => Promise<string>;
    /**
     * 传给默认取用函数的选项（**测试必用**：生产下它会读写用户真实 home）。
     *
     * ⚠️ 不传就是读写 `~/.qoder/.auth/machine_id` —— 测试里漏传会污染用户环境。
     */
    machineIdOptions?: QoderMachineIdOptions;
}
/**
 * Qoder 签名器 —— **上下文的复用与重建**都在这里。
 *
 * 复用判据是「机器码 + cosyVersion + 凭据指纹」三元组：三者任一变化都必须
 * 重建（机器码换了签名头就错，凭据换了身份就错）。判据不做成「定时重建」：
 * 凭据是**事件驱动**变化的（用户重贴 PAT / 续期拿到新 jt），定时器只会
 * 既在无谓时重建、又在关键时漏掉。
 */
export declare class QoderWasmSigner {
    private readonly glue;
    private readonly product;
    private readonly readMachineId;
    private readonly machineIdOptions;
    private context;
    private currentKey;
    constructor(options: QoderWasmSignerOptions);
    /** 取（必要时重建）一个就绪的签名上下文。 */
    contextFor(init: QoderContextInit): Promise<QoderSigningContext>;
    /** 释放当前上下文（登出 / 切换凭据时调）。 */
    dispose(): void;
    /** 复用判据（导出成私有方法便于测试直接验证，不暴露内部状态）。 */
    private reuseKey;
    private createContext;
}
/** 供上层判断「这个实例是不是可用的 Qoder 签名器」。 */
export declare function isQoderWasmSigner(value: unknown): value is QoderWasmSigner;
/** wasm 导出类型再导出（上层做类型标注时不必深入 glue 模块）。 */
export type { QoderWasmExports };
//# sourceMappingURL=qoder-wasm-context.d.ts.map