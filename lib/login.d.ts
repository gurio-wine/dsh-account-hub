import { createServer } from 'node:http';
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js';
import type { DpopKeyPair, PkcePair } from './oauth.js';
export declare const CODEARTS_LOGIN_BASE = "https://devcloud.cn-north-4.huaweicloud.com/doer/redirect";
export declare const HUAWEI_AUTH_BASE = "https://auth.huaweicloud.com/authui/login.html";
export declare const CREDENTIAL_ENDPOINT = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket";
/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export declare function generateRandomSecret(): string;
/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export declare function buildLoginUrl(port: number, ticketId: string): {
    redirectUrl: string;
    loginUrl: string;
};
/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export declare function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null;
/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export declare function expiresFromCredential(credential: CodeArtsCredential): number;
/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export declare function pollForCredential(ticketId: string, secret: string, options?: {
    fetcher?: typeof fetch;
    maxAttempts?: number;
    pluginName?: string;
    pluginVersion?: string;
}): Promise<CodeArtsCredential>;
/** 使用平台默认打开器打开 URL；永不抛出异常。 */
export declare function openBrowser(url: string): void;
/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export declare function startCallbackServer(ticketId: string, secret: string, options: LoginFlowOptions): Promise<{
    port: number;
    server: ReturnType<typeof createServer>;
    result: Promise<LoginFlowResult>;
}>;
/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export declare function runLoginFlow(options?: LoginFlowOptions): Promise<LoginFlowResult>;
/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export declare const PORTAL_AUTHORIZE_BASE = "https://codearts.huaweicloud.com/portal/authorize";
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export declare const PORTAL_LOGIN_BASE = "https://codearts.huaweicloud.com/portal/login";
/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export declare function buildPortalLoginResultUrl(succeeded: boolean): string;
/** portal 期望的插件名（逆向常量，硬编码）。 */
export declare const LOGIN_PLUGIN_NAME = "snap_AIIDE";
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export declare const LOGIN_PLUGIN_VERSION = "5.2.0";
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export declare const OAUTH_THEME = "2";
/** 界面语言（对齐 env.language）。 */
export declare const OAUTH_LOCALE = "zh-cn";
/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export declare function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string;
/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export declare function startOAuthCallbackServer(ticketId: string, pkce: PkcePair, keyPair: DpopKeyPair, options: LoginFlowOptions): Promise<{
    port: number;
    server: ReturnType<typeof createServer>;
    result: Promise<LoginFlowResult>;
}>;
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
export declare const MIN_CALLBACK_PORT = 10000;
/**
 * 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。
 *
 * `listen(0)` 由系统分配的端口可能低于 10000，此时关闭并用随机端口重试 ——
 * 该随机端口可能落在**系统保留段**（Windows 上 `netsh int ipv4 show
 * excludedportrange protocol=tcp` 常见成百上千个保留端口），`listen` 会以
 * `EACCES` 失败。这类失败与「端口被占用」一样属于**挑选失败**，不是登录本身
 * 失败，故同样换端口重试（带上限，避免极端情况下死循环）；只有连续
 * {@link CALLBACK_PORT_ATTEMPTS} 次都挑不到端口才认为真的起不来。
 *
 * `options` 仅供测试注入确定的端口序列：`initialPort` 覆盖首次尝试的端口
 * （默认 0 = 由系统分配），`pickPort` 覆盖重试时的随机取端口。
 */
export declare function listenOnCallbackPort(server: ReturnType<typeof createServer>, options?: {
    initialPort?: number;
    pickPort?: () => number;
}): Promise<number>;
/**
 * 一次「已准备、待完成」的 OAuth 登录会话（两段式的第一段产物）。
 *
 * 与阻塞式 {@link runOAuthFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 180 秒」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface CodeartsPendingLogin {
    /** 本地回调服务器实际监听的端口（必然 ≥ {@link MIN_CALLBACK_PORT}）。 */
    port: number;
    /** 展示给用户的 portal 授权 URL（含一次性 PKCE 挑战与 ticket_id）。 */
    loginUrl: string;
    /** 等待用户在浏览器完成授权并换回凭据。 */
    awaitCredential(): Promise<LoginFlowResult>;
    /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
    cancel(reason?: string): void;
}
/**
 * {@link prepareCodeartsLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type CodeartsLoginPrepareOutcome = {
    ok: true;
    session: CodeartsPendingLogin;
} | {
    ok: false;
    error: 'login-in-progress';
    message: string;
};
/** {@link prepareCodeartsLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type CodeartsLoginPrepareOptions = Omit<LoginFlowOptions, 'openBrowser' | 'flow'> & {
    /** 回调等待总超时（毫秒）；默认 180 秒（{@link OAUTH_CALLBACK_TIMEOUT_MS}）。 */
    timeoutMs?: number;
};
/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export declare function hasActiveCodeartsLogin(): boolean;
/**
 * 准备一次新式 IAM OAuth 登录（两段式的第一段）：起本地回调服务器，
 * 返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link CodeartsPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 超时、成功、失败、{@link CodeartsPendingLogin.cancel} 都会释放会话。
 *
 * 其余语义（180 秒等待预算、`code_challenge_method=SHA-256`、回调端口 ≥10000、
 * 成功/失败 307 重定向到 portal 结果页、旧 secret 回退轮询）与
 * {@link startOAuthCallbackServer} / 原 `runOAuthFlow` 完全一致。
 */
export declare function prepareCodeartsLogin(options?: CodeartsLoginPrepareOptions): Promise<CodeartsLoginPrepareOutcome>;
/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 现已成为 {@link prepareCodeartsLogin} 的阻塞式便捷封装，供「同步」调用方使用
 * （`CodeArtsAuth.login()`、`/codearts-login` 命令、e2e 探针）；Account Hub
 * 走的是两段式（prepare → 客户端弹窗 → awaitCredential），不经过这里。
 */
export declare function runOAuthFlow(options?: LoginFlowOptions): Promise<LoginFlowResult>;
//# sourceMappingURL=login.d.ts.map