/**
 * Qoder **签名路径的身份来源与签名器生命周期**（两区共用；CN chat 的必需前置）。
 *
 * ## 本模块解决的两个问题
 *
 * ### 1. `uid` 从哪来（真机 A/B：空 uid 恒回 `101`）
 *
 * `prepareInferRequest` 的 `userInfoJson` 需要四个业务字段
 * （`uid` / `organization_id` / `organization_tags` / `data_policy_agreed`）。
 * 真机单变量实验（2026-09-21，同一请求**只改 uid 这一处**）：
 *
 * | uid | 结果 |
 * |---|---|
 * | 空串 | `{"code":"101","message":"Signature invalid"}` |
 * | 真实 uid | **HTTP 200 + SSE 真内容** |
 *
 * 故「拿不到 uid 就签名」这条路是**必错**的，本模块的职责是让它**根本走不到
 * 签名**：取不到就抛错，绝不回一个空 uid 让下游去签。`exchange` 响应里
 * **没有** userId（只有 token / refresh_token / expires_*），所以 uid 只能从
 * userinfo 端点取。
 *
 * 端点与回退序**逐字对齐官方** `fetchOpenApiUserInfo`：
 *
 * ```js
 * const a = Mk(r, ["id", "user_id", "uid"])          // 第一个非空字符串
 * if (!a) throw new Error(…)
 * ```
 *
 * 真机 CN `GET https://openapi.qoder.com.cn/api/v1/userinfo`（Bearer `jt-`）实测
 * HTTP 200 / 580 字节，顶层有 `id`（36 字符 UUID），**没有** `user_id` 与 `uid`
 * —— 故三段里实际命中的是第一段。
 *
 * ### 2. 签名器实例的生命周期
 *
 * `QoderWasmSigner` 的复用判据是 `[machineId, cosyVersion, userInfoFingerprint]`
 * 三元组（见 `qoder-wasm-context.ts`）。本模块只负责**把正确的 userInfo 喂给
 * 它**并缓存 uid：`security_oauth_token` 参与指纹，所以换 jt 会自动重建上下文
 * —— 这一层不重复实现判据，交给签名器。
 *
 * ⚠️ **uid 缓存按 PAT 分键**：账号池里每个账号是各自的 uid，用全局单值缓存会让
 * 第二个账号拿到第一个账号的 uid（签出来身份不符 → `101`，且极难排查）。
 * **失败不写缓存** —— 缓存里存了「取不到」，上游恢复后也永远起不来了。
 *
 * ## wasm 是懒加载
 *
 * `loadGlue` 在**第一次真正要签名时**才调用：提取 wasm 要扫 35 MB 的 worker
 * 文本或下载 30 MB 的 tarball，把它放在模块 import 期会让插件启动平白变慢，
 * 而国际版根本用不到它。
 */
import type { QoderGlue } from './qoder-wasm-glue.js';
import type { QoderInferRequest } from './qoder-wasm-context.js';
import { QoderSigningContext } from './qoder-wasm-context.js';
import type { QoderMachineIdOptions } from './qoder-device-flow.js';
import type { QoderProduct } from './qoder-product.js';
/** userinfo 端点路径（官方 `fetchOpenApiUserInfo` 的 `path`）。 */
export declare const QODER_USERINFO_PATH = "/api/v1/userinfo";
/** 归一化后的用户身份（`userInfoJson` 的四个业务字段）。 */
export interface QoderUserIdentity {
    /** 用户 id（官方三段回退，**恒非空** —— 空的话本模块直接抛错）。 */
    uid: string;
    /** 组织 id（个人账号是空串，真机实测）。 */
    organizationId: string;
    /** 组织标签（真机响应无该字段 ⇒ 空数组）。 */
    organizationTags: readonly string[];
    /** 是否已同意数据策略。 */
    dataPolicyAgreed: boolean;
    /**
     * **可展示的用户名**（`name`，真机实测的顶层字段）。
     *
     * ## 为什么它与签名字段同处一个结构
     *
     * 账号卡片的昵称要的正是它，而 userinfo **只有本模块在调**
     * （`QoderSigningProvider.identity`）。若为昵称另写一份解析，同一个响应就会
     * 有两套读法：将来官方改键名时必然只改一处，表现为「签名好了、昵称却还是
     * UUID」这种极难归因的半失效。故**同一份解析、同一个结构**，
     * 只是各自有各自的回退序（uid 走三段，昵称走 `resolveQoderAccountNickname`）。
     *
     * ⚠️ **缺字段即 `undefined`，绝不编造**：昵称的兜底是调用方的职责
     * （回落到 email → 脱敏手机 → `uid`），在这里塞一个「未知用户」会让
     * 每一张卡片都显示同一串假名字。
     */
    displayName?: string;
    /** 用户邮箱（`email`，有则带；昵称的第二档回退）。 */
    email?: string;
    /**
     * 手机号（`security_mobile`，**未脱敏原文**，有则带）。
     *
     * ⚠️ **存原文、不在这里脱敏**：脱敏是**展示层**的职责
     * （`maskQoderMobile`）。在解析层就把中间四位抹掉，会让这个字段没法再用于
     * 任何其它判断，而「解析诚实、展示克制」是本仓库其它 provider 的一贯口径。
     */
    mobile?: string;
}
/**
 * 从 userinfo 响应体里读出用户身份；**读不到 uid 时返回 undefined**。
 *
 * 返回 `undefined`（而不是一个 uid 为空串的对象）是**刻意的**：调用方据
 * `undefined` 抛错，而空串会让「没取到」与「取到了空」在下游无法区分 ——
 * 后者正是真机上必回 `101` 的那种请求。
 *
 * ## 两条独立的回退序（不要合并）
 *
 * | 用途 | 回退序 | 缺值语义 |
 * |---|---|---|
 * | 签名（`uid`） | `id` → `user_id` → `uid` | **抛错**，缺它必回 `101` |
 * | 展示（`displayName`） | `name` → `nickname` → `user_name` | `undefined`（由调用方兜底） |
 *
 * **uid 缺了就整条返回 `undefined`**（含资料字段）：资料再全也签不了名，
 * 返回半个对象只会让调用方以为「取到了身份」。
 *
 * ⚠️ **`dataPolicyAgreed` 缺省为 `true`**（本模块唯一的缺省值选择）：真机响应
 * **不含**该字段，而它是「已同意数据策略」的声明。能正常聊天就说明该账号已同意
 * （客户端不允许未同意的账号发请求）；若上游对此有校验，真机三档验证的首档就会
 * 以 `101` 直接暴露出来，而不是留到现在猜。
 */
export declare function readQoderUserIdentity(payload: unknown): QoderUserIdentity | undefined;
/**
 * 取用户身份：`GET {openapiBase}/api/v1/userinfo`（Bearer **`jt-`**）。
 *
 * ⚠️ 鉴权用 **job token**，不是 PAT：三个端点里只有模型目录认 PAT
 * （见 `qoder-product.ts` 的 `qoderPatHeaders` 注释）。用错会得到「凭据失效」的假象。
 *
 * 三种失败都**抛错**（绝不返回空 uid）：
 * - HTTP 非 200（含 401/403 —— 提示重新登录）；
 * - 响应非 JSON；
 * - JSON 解析成功但三段 uid 全缺。
 *
 * @param jobToken - `jt-…`（由 `getJobToken` 换来）。
 * @param product - 决定 host（CN 是 `openapi.qoder.com.cn`）。
 * @param fetcher - 注入面（测试用）。
 * @param signal - 取消信号（与本次 chat 请求同一个）。
 */
export declare function fetchQoderUserIdentity(jobToken: string, product: QoderProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<QoderUserIdentity>;
/**
 * 一次请求要用的签名上下文（`QoderSigningContext` 的结构子集）。
 *
 * 抽成接口是**为了可测**：四参数（`hostBase` / `body` / `modelKey` / `modelSource`）
 * 的取值正确性是适配器的职责，必须能在适配器单测里断言，不能被封进 provider 内部。
 */
export interface QoderSigningContextLike {
    /** 四参数由**适配器**给出（见 `QoderSigningContext.prepareInferRequest`）。 */
    prepareInferRequest(hostBase: string, body: string, modelKey: string, modelSource: string): QoderInferRequest;
}
/**
 * 适配器的签名来源。
 *
 * ⚠️ **一个 region 一个实例**：签名器把 `product` 绑在构造时（见
 * `QoderWasmSignerOptions.product`），同一实例被两区交替使用会拿 CN 的机器码
 * 签国际版的请求 —— 上游回 `101 Signature invalid`，与「凭据失效」同形。
 */
export interface QoderSigningSource {
    /** 取（必要时重建）签名上下文；**每次请求都调**（重建判据在签名器内部）。 */
    contextFor(pat: string, jobToken: string): Promise<QoderSigningContextLike>;
    /** 释放 wasm 侧资源（登出 / 切凭据时调）。 */
    dispose(): void;
}
/** 一次**目录 GET** 要用的签名请求（wasm 给的 URL 与头，原样发出）。 */
export interface QoderSignedDirectoryRequest {
    /** 签名后的完整 URL（`/algo` 前缀与查询串已由 wasm 拼好）。 */
    url: string;
    /** 签名头（**Record 形态**，直接交给 fetch；wasm 侧顺序不保证保留）。 */
    headers: Record<string, string>;
    /** wasm 资源释放（值已拷出后调用）。 */
    free: () => void;
}
/**
 * **目录签名来源**（设备流目录链的注入面，与 chat 的 {@link QoderSigningSource}
 * 并列、互不顶替）。
 *
 * ## 为什么不复用 `QoderSigningSource`
 *
 * chat 的 `contextFor(pat, jobToken)` 两参在 PAT 路径是「PAT + 换出来的 jt」；
 * 设备流**没有换令牌这一步**，`security_oauth_token` 就是 `dt-` 本体。目录链
 * 把这个差异收在自己的注入面里（token 只传一次），适配器与 `fetchQoderDirectory`
 * 不需要知道「jt 与 dt 的区别」。
 *
 * ⚠️ **一个 region 一个实例**（同 chat 来源的理由：机器码/身份绑在 product 上）。
 */
export interface QoderDirectorySigningSource {
    /**
     * 生成目录 GET 请求。
     *
     * @param token 设备流令牌（`dt-`；同时用作 userinfo 的 Bearer 与签名身份的
     *   `security_oauth_token` —— 官方语义，stage-a §1.5）。
     * @param endpoint inference host 基址（`resolveQoderDirectoryEndpoint` 的产物）。
     * @param path 目录路径（`QODER_DEVICE_MODELS_PATH`）。
     */
    prepareGetRequest(token: string, endpoint: string, path: string): Promise<QoderSignedDirectoryRequest>;
    /** 解码目录响应（解密失败**原样返回**——明文兼容，官方 `kfe` 语义）。 */
    decryptResponse(text: string): Promise<string>;
}
/** {@link QoderSigningProvider} 的构造选项。 */
export interface QoderSigningProviderOptions {
    /** 目标 region（决定 machine_id 路径、`cosyVersion`、`clientMetadata`）。 */
    product: QoderProduct;
    /**
     * 加载 wasm glue（**懒调用**：第一次真正要签名时才执行）。
     *
     * 生产接线传 `async () => instantiateQoderWasm((await extractQoderWasm({ product })).bytes)`；
     * 失败时抛 `QoderWasmUnavailableError`（适配器会把它转成可读的直报错误）。
     */
    loadGlue: () => Promise<QoderGlue>;
    /** userinfo 拉取用的 fetch（测试注入）。 */
    fetchImpl?: typeof fetch;
    /** machineId 取用策略的透传（**测试必传**，否则读写用户真实 home）。 */
    machineIdOptions?: QoderMachineIdOptions;
}
/**
 * 默认签名来源实现：uid 缓存 + 懒加载 wasm + 委托给 {@link QoderWasmSignerClass}。
 */
export declare class QoderSigningProvider implements QoderSigningSource {
    private readonly product;
    private readonly loadGlue;
    private readonly fetchImpl;
    private readonly machineIdOptions;
    /** uid 缓存：**按 PAT 分键**（账号池里每个账号各有各的 uid）。 */
    private readonly identityByPat;
    /**
     * 在途的 uid 拉取（按 PAT 分键）。
     *
     * 同一账号可能同时有多个 chat 请求在飞（账号池 + 用户连续发问）。不合并的话，
     * 冷启动那一瞬间会打出 N 个 userinfo 请求 —— 既是无谓往返，也让同一账号在
     * 服务端看起来像异常流量。
     *
     * ⚠️ **失败时必须从表里删掉**：留着失败的 Promise 会让之后每一次请求都复用
     * 同一个失败结果，账号永远起不来（与「失败不写 uid 缓存」是同一条纪律）。
     */
    private readonly pendingIdentityByPat;
    /** 每个 PAT 一个签名器（复用判据在签名器内部，这里只做实例归属）。 */
    private readonly signersByPat;
    /** 共享的 glue 加载 Promise（并发请求只加载一次）。 */
    private gluePromise;
    constructor(options: QoderSigningProviderOptions);
    /**
     * 取（必要时重建）签名上下文。
     *
     * 返回类型标注为**具体类** {@link QoderSigningContext}（接口
     * {@link QoderSigningSource} 仍按 `QoderSigningContextLike` 声明，类方法的
     * 收窄返回是合法协变）：目录链的 `prepareDirectoryRequest` 需要 wasm 上下文
     * 的 `prepareRequest`，那个方法不在结构子集接口上。
     */
    contextFor(pat: string, jobToken: string): Promise<QoderSigningContext>;
    /**
     * 生成**目录 GET** 的签名请求（设备流目录链专用）。
     *
     * ⚠️ **`jobToken` 位就是 `token` 本体**：设备流没有换令牌这一步，
     * `security_oauth_token` 是 `dt-` 令牌（stage-a §1.5 官方语义）；uid 的
     * Bearer 也是它（quota 端点同 Token 族实测 200，openapi 侧认 `dt-`）。
     * chat 路径的 `contextFor(pat, jt)` 两参形态**不受影响**。
     */
    prepareDirectoryRequest(token: string, endpoint: string, path: string): Promise<QoderSignedDirectoryRequest>;
    /**
     * 解码目录响应（{@link decryptQoderServerResponse} 的异步包装）。
     *
     * 解码失败**原样返回输入**（明文兼容）—— catch 在该函数内部，本方法只负责
     * 确保 glue 已加载（glue 懒加载的语义与签名一致：第一次用到才加载）。
     */
    decryptResponse(text: string): Promise<string>;
    dispose(): void;
    /** 取（必要时拉取）某个 PAT 的 uid。**失败不写缓存、也不留在途记录**。 */
    private identity;
    /** 取（必要时创建）某个 PAT 的签名器；glue 懒加载且全局只加载一次。 */
    private signerFor;
}
/**
 * 把 {@link QoderSigningProvider} 包成目录签名来源（`src/index.ts` 的接线点）。
 *
 * 两区各传**自己的** provider 实例（region 绑定纪律与 chat 侧相同）；适配器
 * 拿到的是 {@link QoderDirectorySigningSource} 窄接口，看不见 provider 的
 * chat 方法 —— chat 出站路径与目录链在类型层就分开。
 */
export declare function qoderDirectorySigningSource(provider: QoderSigningProvider): QoderDirectorySigningSource;
//# sourceMappingURL=qoder-signing.d.ts.map