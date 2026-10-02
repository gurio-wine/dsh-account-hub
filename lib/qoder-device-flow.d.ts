/**
 * Qoder **浏览器设备流登录**（两个 region 共用一份实现）。
 *
 * ## 与 PAT 粘贴的关系：**并存**，不是替换
 *
 * Qoder 此前只有 PAT 粘贴一种登录形态（见 `src/qoder-auth.ts` 的模块头）。
 * 本文件补上官方 CLI / 桌面端同款的**设备流**，两者并存：
 *
 * | 形态 | 入口 | 凭据 |
 * |---|---|---|
 * | 设备流 | `login()` 无参 | `token` + `refresh_token`（长期） |
 * | PAT 粘贴 | `login({ pat })` | `pt-…` 作为 `access_token` |
 *
 * 两条路径**写同一种凭据形态**（`QoderCredential`）：它们在上游是同一种身份
 * （`access_token` 都是可换 `jt-` 的长期令牌），故 `refresh` / 额度 / 目录
 * 三条下游链路一行都不用改。**绝不把两条路径揉成一条** —— PAT 是即时请求
 * （同步完成、无占位中间态），设备流是「等用户在浏览器点授权」（两段式），
 * 时序契约完全不同。
 *
 * ## 协议三步（全部照抄官方源码取证，未做任何发明）
 *
 * 1. **PKCE**：`verifier` 64 字符随机、`challenge = base64url(sha256(verifier))`、
 *    `challenge_method: "S256"`；`nonce = randomUUID()`。
 * 2. **登录 URL**：`{authBaseUrl}/device/selectAccounts?challenge&challenge_method
 *    &nonce&machine_id&client_id`。⚠️ **CN 的 `redirect_uri` 是 null ⇒ 不带该参数**。
 *    参数顺序不做要求，但**字段名逐字符照抄**。
 * 3. **轮询**：`GET {openapiBase}/api/v1/deviceToken/poll?nonce&verifier
 *    &challenge_method&machine_id`。**404 → 等 1 秒重试**，总超时 **5 分钟**；
 *    成功判据是「`token` 与 `refresh_token` **都是 string**」。
 *
 * ⚠️ **桌面端另有一套 `client_id`（`732aef47-…`），不要用** —— 我们复刻的是
 * **CLI** 设备流，两区共用同一个 CLI `client_id`（见 {@link QODER_CLI_CLIENT_ID}）。
 *
 * ## 本文件与 `qoder-auth.ts` 的分工
 *
 * 这里只有**协议与流程**（纯函数 + 一次会话的生命周期），不碰 `ctx.credentials`
 * 与账号池 —— 落盘是 `QoderAuth.persistLoginResult` 的事，与另外几个 provider
 * 的两段式分工完全一致。
 */
import { QODER_CLI_CLIENT_ID, type QoderDeviceTokenPayload, type QoderProduct } from './qoder-product.js';
/**
 * 转出 CLI 的 `client_id`（**唯一取值来源在 `qoder-product.ts`**）。
 *
 * 它是产品配置字段 `QoderProduct.clientId` 的取值来源，故常量本体住在产品
 * 配置文件里；这里转出只是为了「设备流相关的常量都在一处」这条可读性，
 * **不重新声明值**（两处各写一份字面量必然分叉）。
 */
export { QODER_CLI_CLIENT_ID };
/** 设备流总超时：官方 5 分钟。到点是**终态**，不再继续轮询。 */
export declare const QODER_DEVICE_LOGIN_TIMEOUT_MS: number;
/** 轮询间隔：官方在 404（尚未授权）后等 1 秒再试。 */
export declare const QODER_DEVICE_POLL_INTERVAL_MS = 1000;
/** 登录 URL 路径（两个 region 相同）。 */
export declare const QODER_DEVICE_LOGIN_PATH = "/device/selectAccounts";
/** 轮询路径（打在 `product.openapiBase` 上）。 */
export declare const QODER_DEVICE_POLL_PATH = "/api/v1/deviceToken/poll";
/** machine_id 相对 home 的落盘位置（与官方 CLI **逐字符一致**）。 */
export declare const QODER_MACHINE_ID_DIR = ".auth";
export declare const QODER_MACHINE_ID_FILE = "machine_id";
/** 单次轮询请求的超时（毫秒）；避免一次挂死的连接吃掉整个 5 分钟预算。 */
export declare const QODER_DEVICE_REQUEST_TIMEOUT_MS = 30000;
/** 一次登录用的 PKCE 配对（S256）。 */
export interface QoderPkce {
    /** 明文 verifier，只在轮询时回传，**绝不进登录 URL**。 */
    codeVerifier: string;
    /** `base64url(sha256(verifier))`。 */
    codeChallenge: string;
    /** 恒为 `'S256'`（官方只发这一种）。 */
    codeChallengeMethod: string;
}
/**
 * 生成 PKCE 配对。
 *
 * `verifier` 是 **48 字节随机 → base64url**：恰好 64 字符（48 % 3 === 0，
 * 无填充），与官方实现一致。base64url 的字符集（`A-Za-z0-9-_`）是 PKCE 规范
 * 允许集（`A-Za-z0-9-._~`）的子集，故无需再做替换。
 *
 * `challenge` 是 `base64url(sha256(verifier))` —— 43 字符（32 字节摘要的
 * base64url 无填充长度）。**不要用 hex**：官方是 base64url，hex 会让服务端
 * 校验失败，而失败形态只是「授权页一直转圈」。
 */
export declare function generateQoderPkce(): QoderPkce;
/**
 * 生成 nonce（UUID）。
 *
 * nonce 是**这次登录的一次性标识**：它同时进登录 URL 与轮询请求，是服务端
 * 把「浏览器里那次授权」与「这个进程的这次轮询」对上的唯一凭据。
 */
export declare function generateQoderNonce(): string;
/** {@link buildQoderDeviceLoginUrl} 的入参。 */
export interface QoderDeviceLoginUrlInput {
    codeChallenge: string;
    nonce: string;
    machineId: string;
}
/**
 * 构造设备流登录 URL。
 *
 * 字段名逐字符照抄官方：`challenge` / `challenge_method` / `nonce` /
 * `machine_id` / `client_id`。**参数顺序不做要求**（`URLSearchParams` 的
 * 序列化顺序即可），但**不得增删字段**。
 *
 * ⚠️ **不带 `redirect_uri`**：官方 CN 的该值是 `null`，国际版设备流同样不带
 * —— 带上会让授权页走「回调」分支而不是「设备码」分支。
 */
export declare function buildQoderDeviceLoginUrl(product: QoderProduct, input: QoderDeviceLoginUrlInput): string;
/** 文件系统注入面（测试用；生产走 `node:fs/promises`）。 */
export interface QoderMachineIdIo {
    readFile(path: string): Promise<string>;
    mkdir(path: string): Promise<void>;
    writeFile(path: string, data: string): Promise<void>;
}
/** {@link readOrCreateQoderMachineId} 的选项。 */
export interface QoderMachineIdOptions {
    /** home 目录覆盖（测试用；默认 `os.homedir()`）。 */
    homeDir?: string;
    /** 文件系统注入面（测试用）。 */
    io?: QoderMachineIdIo;
}
/**
 * machine_id 的落盘绝对路径。
 *
 * 两区**路径隔离**：国际版 `~/.qoder/.auth/machine_id`、CN
 * `~/.qoder-cn/.auth/machine_id` —— 与官方 CLI **同路径同格式**。共用同一个
 * 文件会让「装了 CN CLI 又装国际版 CLI」的用户两边机器码互相覆盖。
 */
export declare function qoderMachineIdPath(product: QoderProduct, homeDir?: string): string;
/**
 * 读取或生成该产品的 machine_id（36 字符 UUID 文本）。
 *
 * 行为契约（三条，都有单测钉死）：
 *
 * 1. **已存在则读用** —— 绝不覆盖。与官方 CLI 共用同一个文件是**刻意的**：
 *    用户混用官方 CLI 时两边读同一个机器身份，wasm 签名链才不会因机器码漂移
 *    而失效。
 * 2. **不存在则生成并落盘**（目录递归创建）。
 * 3. **落盘 / 读取失败不挡登录** —— 退回一个内存态 UUID 继续用。
 *    磁盘不可写是环境问题，不是「用户没资格登录」；把它变成登录失败，
 *    用户除了换台机器别无他法。
 *
 * 读取时 `trim()`：官方 CLI 可能写成「一行 + `\n`」，把换行当令牌正文的一部分
 * 会让 `machine_id` 参数多一个 `%0A`。
 */
export declare function readOrCreateQoderMachineId(product: QoderProduct, options?: QoderMachineIdOptions): Promise<string>;
/**
 * 设备流成功返回的令牌载荷（**类型与解析都在 `qoder-product.ts`**）。
 *
 * 转出而不在本文件重新声明：poll 与 `deviceToken/refresh` 两个端点回的是
 * **同一种载荷**，两处各写一份类型与解析必然分叉（典型后果：「续期成功但
 * 令牌没变」这类静默失败）。协议纯函数统一住在产品层，本文件只负责流程。
 */
export { parseQoderDeviceTokenPayload, type QoderDeviceTokenPayload, } from './qoder-product.js';
/** {@link pollQoderDeviceToken} 的选项。 */
export interface QoderDevicePollOptions {
    nonce: string;
    codeVerifier: string;
    machineId: string;
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 注入的等待函数（测试用）；默认 `setTimeout`。 */
    sleep?: (ms: number) => Promise<void>;
    /** 取消信号：登出 / 删除账号时终止轮询。 */
    signal?: AbortSignal;
    /** 轮询间隔覆盖（默认 {@link QODER_DEVICE_POLL_INTERVAL_MS}）。 */
    intervalMs?: number;
    /** 总超时覆盖（默认 {@link QODER_DEVICE_LOGIN_TIMEOUT_MS}）。 */
    timeoutMs?: number;
}
/**
 * 轮询直到拿到令牌 / 超时 / 被取消 / 出错。
 *
 * ## 三类「不成功」的区分（这是本函数的核心语义）
 *
 * | 情况 | 动作 |
 * |---|---|
 * | **404** | 尚未授权 ⇒ 等 `intervalMs` 重试（官方节奏） |
 * | **200 但判据不满足** | 同上（授权页尚未点击时上游回 200 + 空对象） |
 * | **其它非 2xx** | **直报**，不当作「还在等授权」空转 |
 * | **传输层失败** | **直报**（断网不是「继续等」） |
 *
 * 把非 404 的失败也当成「重试」会让一个必然失败的请求空转到 5 分钟，
 * 而用户看到的只是「登录一直不完成」。
 *
 * ## 超时与取消都是**终态**
 *
 * 到点或被 abort 后**必须真的停下来** —— 否则删除账号后轮询仍在后台打请求，
 * 且每次都要等满 5 分钟才释放。
 *
 * @throws 超时 / 取消 / 非 404 失败 / 传输层失败 / 响应非 JSON。
 */
export declare function pollQoderDeviceToken(product: QoderProduct, options: QoderDevicePollOptions): Promise<QoderDeviceTokenPayload>;
/**
 * 一次进行中的设备流登录。
 *
 * 与 `TraeCnPendingLogin` / `LobsteraiPendingLogin` 同构：`account.create` 拿到
 * `loginUrl` 就返回，后台 `awaitToken()` 结算。
 */
export interface QoderDevicePendingLogin {
    /** 本次登录所属的 provider id（互斥按它分槽）。 */
    productId: string;
    /** 展示给用户的授权页 URL（含本次 PKCE / nonce / machine_id）。 */
    loginUrl: string;
    /** 本次登录的一次性 nonce。 */
    nonce: string;
    /** 明文 PKCE verifier（只在轮询时回传）。 */
    codeVerifier: string;
    /** 本次登录使用的 machine_id（已落盘，供签名链复用）。 */
    machineId: string;
    /**
     * 等待用户在浏览器完成授权并拿到令牌。
     *
     * **首次调用才发起轮询**（prepare 阶段一次网都不出）：这样「打开授权页」
     * 与「开始轮询」的先后由调用方掌握，也避免用户在弹窗被拦截时白白轮询
     * 5 分钟。重复调用返回同一个 Promise（幂等消费）。
     */
    awaitToken(): Promise<QoderDeviceTokenPayload>;
    /** 主动放弃本次登录：终止轮询并释放互斥槽位。幂等。 */
    cancel(reason?: string): void;
}
/** {@link prepareQoderDeviceLogin} 的结果（判别联合，与另外几个 provider 同构）。 */
export type QoderDeviceLoginPrepareOutcome = {
    ok: true;
    session: QoderDevicePendingLogin;
} | {
    ok: false;
    error: 'login-in-progress';
    message: string;
};
/** {@link prepareQoderDeviceLogin} 的选项。 */
export interface QoderDevicePrepareOptions {
    product: QoderProduct;
    /** 注入的 fetch（测试用）。 */
    fetcher?: typeof fetch;
    /** 注入的等待函数（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /** home 目录覆盖（测试用）。 */
    homeDir?: string;
    /** 文件系统注入面（测试用）。 */
    io?: QoderMachineIdIo;
    /** 轮询间隔覆盖。 */
    intervalMs?: number;
    /** 总超时覆盖。 */
    timeoutMs?: number;
}
/** 该 provider 当前是否有未结算的登录会话（含正在准备中的）。 */
export declare function hasActiveQoderDeviceLogin(productId: string): boolean;
/**
 * 取消该 provider 进行中的设备流登录（幂等；无会话时 no-op）。
 *
 * 供 `account.delete` 使用 —— 它只知道 accountId / provider id，拿不到会话
 * 句柄，故由模块级槽位表提供按 provider 的取消入口。
 *
 * ⚠️ **`'preparing'` 阶段也一并释放**：那个阶段没有可 abort 的轮询，但槽位
 * 必须还回去，否则「建会话途中用户删了账号」会让该 provider 此后所有登录
 * 都被 `login-in-progress` 永久挡住。
 */
export declare function cancelQoderDeviceLogin(productId: string, reason?: string): void;
/**
 * **第一段**：建立一次设备流会话，返回 `loginUrl`（**不等待用户操作**）。
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享；
 * - **不静默新建**：每次点击都堆一个轮询循环到超时。
 *
 * 本函数**不发任何请求**（PKCE 是本地生成、machine_id 是本地读写）——
 * 轮询由 {@link QoderDevicePendingLogin.awaitToken} 在第二段发起。
 */
export declare function prepareQoderDeviceLogin(options: QoderDevicePrepareOptions): Promise<QoderDeviceLoginPrepareOutcome>;
//# sourceMappingURL=qoder-device-flow.d.ts.map