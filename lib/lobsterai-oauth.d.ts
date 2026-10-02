/**
 * LobsterAI（有道龙虾）登录：本地回调服务器 + `authCode` 换 token。
 *
 * ## 与 `lobsterai2api` 的实现差异（有意为之）
 *
 * Go 侧是**两个进程 + 一个 `/tmp` 状态文件**：
 * `login.exe url` 起回调服务器后把 `{port,state,uuid,firstKeyfrom}` 落盘到
 * `/tmp/lb2api-login-state.json`，阻塞等待 `.result` 文件出现；
 * `login.exe poll` 再读那个文件取结果（由 `login.sh` 顺序驱动，
 * 中间还夹一个 `read -rp "按 y 继续"` 的人在环确认）。
 *
 * 本模块把这套编排**收进单个进程内的 Promise**：
 * 回调服务器收到 `code` 后**立即在本进程完成 exchange**，
 * 直接 `resolve` 结果。这样就没有跨进程状态文件、没有残留文件误判、
 * 没有 shell 与 python3 依赖 —— 而这三样正是 Go 侧最脆弱的环节
 * （`main.go:162-164` 专门写了清理上一轮残留的代码，就说明它踩过坑）。
 *
 * 骨架取自 `src/login.ts` 的 CodeArts OAuth 回调服务器（本插件已验证的模式），
 * 但没有 PKCE / DPoP —— LobsterAI 的 exchange 不要求它们。
 */
import { type LobsteraiCredential } from './lobsterai.js';
import type { LobsteraiProduct } from './lobsterai-product.js';
/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>;
/** 一次登录流程的结果。 */
export interface LobsteraiLoginFlowResult {
    /** 已序列化的 `LobsteraiCredential` JSON 字符串（直接存入 ctx.credentials）。 */
    access: string;
    /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
    expires: number;
    /** 展示给用户的登录 URL。 */
    loginUrl: string;
    /** 凭据是否携带 refresh_token。 */
    refreshable: boolean;
}
/** `runLobsteraiLoginFlow` 接受的选项。 */
export interface LobsteraiLoginFlowOptions {
    /** 使用的 fetch 实现；默认为全局 fetch。 */
    fetcher?: typeof fetch;
    /** 打开登录 URL 的方式；默认用平台打开器。 */
    openBrowser?: OpenBrowser;
    /** 回调等待总超时（毫秒）；默认 10 分钟。 */
    timeoutMs?: number;
    /** 外部取消信号。 */
    signal?: AbortSignal;
    /** 产品配置；默认 LOBSTERAI。 */
    product?: LobsteraiProduct;
}
/**
 * 登录会话状态。
 *
 * `uuid` / `firstKeyfrom` 由**客户端**生成并贯穿整个账号生命周期：
 * 它们不在服务端响应里，而是要在 exchange 时提交、并在之后**每次续期**时
 * 原样回传（见 `lobsteraiRefreshBody`）。因此必须随凭据持久化。
 */
export interface LobsteraiLoginSession {
    /** 安装 UUID（对齐 `main.go:166` `newUuid()`）。 */
    uuid: string;
    /** 首次登录时间戳（毫秒字符串，对齐 `nowMillis()`）。 */
    firstKeyfrom: string;
}
/** 生成一次性登录会话（uuid + firstKeyfrom）。 */
export declare function createLobsteraiLoginSession(nowMs?: number): LobsteraiLoginSession;
/**
 * 构造 portal 登录 URL。
 *
 * 形态照抄 `main.go:225-228`：
 * `{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
 *
 * 三个 query 参数的语义：
 * - `source=electron` —— 声明登录来源是桌面客户端（portal 据此选择交互流程）；
 * - `redirect_uri` —— **必须**是 `http://127.0.0.1:{port}/auth/callback` 形态，
 *   登录页会校验（`main.go:223-225` 的注释明确记录了这一约束）；
 * - `state` —— 防 CSRF 的一次性随机串，回调时原样带回并比对。
 *
 * ⚠️ 用 `URL` + `searchParams` 而非手工拼字符串：`redirect_uri` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 * 但 hash 段（`#/login`）不能用 `URL.searchParams` 构造 —— 它属于 fragment，
 * 故这里显式拼装：路径 + hash + `?` + 编码后的 query。
 */
export declare function buildLobsteraiLoginUrl(port: number, state: string, product: LobsteraiProduct): string;
/**
 * 用授权码换取凭据。
 *
 * 请求体**必须**含 5 个字段（对齐 `main.go:264-270`）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 * 其中 `uuid` 与 `firstKeyfrom` 来自 {@link LobsteraiLoginSession}，
 * `latestKeyfrom` 取当前时刻，`version` 用动态拉取的真值。
 *
 * 该端点**不需要** `Authorization` 头（换 token 时还没有 token）。
 *
 * @throws 当网络失败、信封 code 非 0、或响应缺 accessToken 时。
 */
export declare function exchangeLobsteraiAuthCode(code: string, session: LobsteraiLoginSession, clientVersion: string, product: LobsteraiProduct, fetcher?: typeof fetch, signal?: AbortSignal): Promise<LobsteraiCredential>;
/**
 * 一次「已准备、待完成」的登录会话（两段式的第一段产物）。
 *
 * 与 {@link runLobsteraiLoginFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 10 分钟」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface LobsteraiPendingLogin {
    /** 本地回调服务器实际监听的端口。 */
    port: number;
    /** 展示给用户的 portal 登录 URL（含一次性 state）。 */
    loginUrl: string;
    /** 等待用户在浏览器完成登录并换回凭据。 */
    awaitCredential(): Promise<LobsteraiLoginFlowResult>;
    /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
    cancel(reason?: string): void;
}
/**
 * {@link prepareLobsteraiLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `account-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type LobsteraiLoginPrepareOutcome = {
    ok: true;
    session: LobsteraiPendingLogin;
} | {
    ok: false;
    error: 'login-in-progress';
    message: string;
};
/** {@link prepareLobsteraiLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type LobsteraiLoginPrepareOptions = Omit<LobsteraiLoginFlowOptions, 'openBrowser'> & {
    product: LobsteraiProduct;
    clientVersion: string;
};
/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export declare function hasActiveLobsteraiLogin(): boolean;
/**
 * 准备一次登录（两段式的第一段）：起本地回调服务器，返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link LobsteraiPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 重复点击由调用方把该错误提示给用户（「已有登录进行中」）。
 * 超时、成功、失败、{@link LobsteraiPendingLogin.cancel} 都会释放会话。
 *
 * 其余语义（`state` 校验、回调页 HTML、exchange 五字段、10 分钟超时）
 * 与原 `runLobsteraiLoginFlow` 完全一致。
 */
export declare function prepareLobsteraiLogin(options: LobsteraiLoginPrepareOptions): Promise<LobsteraiLoginPrepareOutcome>;
/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等 `code` → exchange。
 *
 * 单进程内闭环，不落状态文件（见模块头注释）。现已成为
 * {@link prepareLobsteraiLogin} 的便捷封装，供「阻塞式」调用方使用
 * （`LobsteraiAuth.login()`、e2e 探针）；Account Hub 走的是两段式
 * （prepare → 客户端弹窗 → awaitCredential），不经过这里。
 *
 * `timeoutMs` 覆盖「浏览器打开 + 用户操作」整个窗口，超时抛错；
 * 无论成功失败都关闭本地服务器。
 */
export declare function runLobsteraiLoginFlow(options: LobsteraiLoginFlowOptions & {
    product: LobsteraiProduct;
    clientVersion: string;
}): Promise<LobsteraiLoginFlowResult>;
//# sourceMappingURL=lobsterai-oauth.d.ts.map