/**
 * Account Hub **内部协议字段**：自动路由候选的 windowId 覆写通道。
 *
 * ## 它是第三条同构通道，但只有*一半*是
 *
 * 与 `src/account-hub-user-agent.ts` / `src/account-hub-originator.ts` 同构的第三条
 * 请求头通道（一个头一个文件）：出站头名 `x-codex-window-id`，值来自候选条目的
 * `masquerade.windowId`。
 *
 * ⚠️ **与那两条通道的两处实质差别**：
 *
 * 1. **没有既有的 `apply*` 函数可复用** —— 那两条通道的写路径早已被七个适配器的
 *    `send()` 直接调用（`applyAccountHubUserAgent` / `applyAccountHubOriginator`），
 *    windowId 这条曾在旧实现里走宿主磁盘补丁（那套引擎已整体退役，见
 *    `docs/agents/client-masquerade-design.md`）。故本模块只提供**校验 + 归一**，写路径由
 *    `src/account-hub-masquerade-transport.ts` 统一承担（它复用本模块的
 *    {@link normalizeAccountHubWindowId}，不复制判据）。
 * 2. **上游源形状是嵌套的** —— 那两条读的是 `options.accountHubUserAgent` /
 *    `options.accountHubOriginator`（字符串），本通道读的是
 *    `options.accountHubMasquerade.windowId`（`src/auto-route.ts` 声明的对象）。
 *    本模块**不**重复定义那个对象形状，只把「字符串本身是否合法」这件事收成唯一判据，
 *    嵌套结构的校验仍归 `src/auto-route.ts` 的 `autoRouteMasqueradeProblem`。
 *
 * ## 为什么值取自 `masquerade.windowId` 而不是新加一个顶层字段
 *
 * `masquerade` 这个名字在面板与配置里已经在用（旧实现留下的用户可见契约），
 * 且它的语义是「整块伪装参数」，windowId 是其中一员；拆成顶层
 * `accountHubWindowId` 会让同一件事有两个入口。
 *
 * ## 默认路径**零变化**
 *
 * 字段缺席（绝大多数请求）时一个头都不发，出站请求与加本通道之前**逐字节一致** ——
 * `x-codex-window-id` 与 `Originator` 一样，在七家上游协议里都不存在（全仓零命中），
 * 只有用户显式配了值它才会第一次出现。这是 AGENTS.md「出站协议值不随 provider id /
 * 显示名变化」红线的延伸。
 *
 * @module dsh-account-hub/account-hub-window-id
 */
/**
 * 出站头名（**规范小写形态**）。
 *
 * 小写是刻意的：这个头的来源是客户端抓包（HTTP/2 头一律小写），保持原样最不容易
 * 在比对时出错；`Headers` 形态大小写不敏感、普通对象形态要求「同一次请求只留一个
 * 同名键」，两条约束都由写路径负责，与这里的字面量无关。
 */
export const ACCOUNT_HUB_WINDOW_ID_HEADER = 'x-codex-window-id';
/** 覆写值的长度上限（与两条既有头通道同口径：512，不是另造的夸张数字）。 */
export const ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH = 512;
/**
 * 控制字符（含 CR / LF / TAB）—— HTTP 头值里不允许出现。
 *
 * ⚠️ **不带 `g` 标志**：带 `g` 的正则对象 `test()` 会在多次调用间记住 `lastIndex`，
 * 同一份配置第二次校验起结果就随机漂移（这类缺陷在单条用例里完全看不出来）。
 */
const ACCOUNT_HUB_WINDOW_ID_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/**
 * 校验一个 windowId 覆写值（**写路径与读路径共用的唯一判据**，与两条既有头通道同构）。
 *
 * 判据逐条（校验的是 `trim()` 之后的值 —— 那才是会被存下、会被发出去的形态）：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | 非字符串 | 拒 |
 * | `trim()` 后为空串 | 拒（缺省 = 不发这个头，不需要用空串表达） |
 * | `trim()` 后长度 > {@link ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH} | 拒 |
 * | 含控制字符（CR / LF / TAB / …） | 拒（HTTP 头值不允许，也是头注入的经典入口） |
 *
 * @returns 合法时 `null`；非法时一句**中文原因**（调用方拼进逐字段报错里 ——
 *          「哪个条目、哪个字段、为什么」三段都要齐，用户才知道去改什么）。
 */
export function accountHubWindowIdProblem(value) {
    if (typeof value !== 'string') {
        return `必须是字符串（省略 = 不发 ${ACCOUNT_HUB_WINDOW_ID_HEADER} 头）`;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return `不能为空串（省略 = 不发 ${ACCOUNT_HUB_WINDOW_ID_HEADER} 头）`;
    }
    if (trimmed.length > ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH) {
        return `过长（上限 ${ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH} 个字符，收到 ${trimmed.length} 个）`;
    }
    if (ACCOUNT_HUB_WINDOW_ID_CONTROL_CHARS.test(trimmed)) {
        return '含换行或控制字符（HTTP 头值不允许）';
    }
    return null;
}
/**
 * 把任意值归一成可用的覆写值（写路径与读路径共用：脏值一律当**没有**，不抛错）。
 *
 * 读路径把它当「没有」，写路径把它当「不写这个头」—— 两条路径都**不能抛错**：
 * 校验点离用户输入很远（可能隔着一层 RPC 反序列化），那里抛错等于把一次配置笔误
 * 升级成请求失败。
 *
 * @returns 合法值时返回 `trim()` 后的值；否则 `undefined`。
 */
export function normalizeAccountHubWindowId(value) {
    if (accountHubWindowIdProblem(value) !== null)
        return undefined;
    return value.trim();
}
//# sourceMappingURL=account-hub-window-id.js.map