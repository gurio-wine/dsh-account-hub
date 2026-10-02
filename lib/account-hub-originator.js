/**
 * Account Hub **内部协议字段**：自动路由候选的 Originator 覆写通道。
 *
 * ## 它补的是哪一段够不着的路
 *
 * 与 `src/account-hub-user-agent.ts` **完全同构**的第二条请求头覆写通道（一个模块
 * 一个头，故不合并进那个模块）：自动路由（`src/auto-route-adapter.ts`）转发一次
 * 请求时只改得了 `provider` / `model` / `messages` / 可选 `reasoningEffort`
 * （`forwardOptions()`）—— **出站请求头由内层真实适配器在它自己的 `send()` 里
 * 自建**，聚合层一点都碰不到。于是候选条目配了 `originator` 时，聚合层把它挂在本
 * 模块声明的 {@link AccountHubOriginatorCarrier.accountHubOriginator} 上，随
 * `GenerateOptions` 对象一起穿过 `ctx.llm.stream()`（宿主只按 `provider` / `model`
 * 选适配器，多余字段原样带着走，见 `dsh-llm` 的 `forAdapter`），由内层适配器在构造
 * 完自己的头**之后**设置 `Originator`。
 *
 * ## ⚠️ 本通道是「**新增头**」而不是「覆写既有头」（与 UA 通道的根本差别）
 *
 * `Originator` 在**七家上游协议里都不存在**：全仓（大小写不敏感）零命中，七个适配器
 * 构造的头里没有一个叫这个名字的键，上游也没有任何一处要求或识别它。故：
 *
 * - **默认（字段缺席）= 一个头都不发**，出站请求与加本通道之前**逐字节一致**；
 * - 只有用户显式配了值，这个头才会**第一次**出现在该请求上。
 *
 * 这正是它与 UA 通道的差别：UA 是「把已存在的头整体换掉」，本通道是「凭空加一个」。
 * 因此它**不能**照抄 UA 那句「覆写」措辞 —— 面板上的占位文案也据此写成「默认不发此
 * 头」，而不是显示一个并不存在的默认值（本通道没有 `defaultUserAgent` 那种现算默认
 * 值，`autoroute.model-info` 也不为它提供任何字段）。
 *
 * ## 为什么是「内部协议字段」而不是给宿主加能力
 *
 * 与 UA 通道同因：宿主 `GenerateOptions` 没有、也不该有「任意请求头」这种字段 ——
 * 那等于让任何插件都能改别的 provider 的出站身份。本字段只在**本插件的八个适配器**
 * 之间流转：写方只有聚合适配器，读方只有那七个真实适配器的 `send()`（qoder 两区同
 * 函数）。宿主与其它插件既不读也不写，故它是本插件自己的内部约定，不是对外契约 ——
 * 字段名带 `accountHub` 前缀就是为了让这一点在日志与断点里一眼可见。
 *
 * @module dsh-account-hub/account-hub-originator
 */
/** 覆写值的长度上限（HTTP 头值不该无限长，也挡住把整段 prompt 塞进来的误用）。 */
export const ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH = 512;
/**
 * 控制字符（含 CR / LF / TAB）—— HTTP 头值里不允许出现。
 *
 * ⚠️ **不带 `g` 标志**：带 `g` 的正则对象 `test()` 会在多次调用间记住
 * `lastIndex`，同一份配置第二次校验起结果就随机漂移（这类缺陷在单条用例里
 * 完全看不出来）。
 */
const ACCOUNT_HUB_ORIGINATOR_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/**
 * 校验一个候选条目的 Originator 覆写值（**写路径与读路径共用的唯一判据**）。
 *
 * 判据逐条（校验的是 `trim()` 之后的值 —— 那才是会被存下、会被发出去的形态）：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | 非字符串 | 拒 |
 * | `trim()` 后为空串 | 拒（缺省 = 不发这个头，不需要用空串表达） |
 * | `trim()` 后长度 > {@link ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH} | 拒 |
 * | 含控制字符（CR / LF / TAB / …） | 拒（HTTP 头值不允许，也是头注入的经典入口） |
 *
 * @returns 合法时 `null`；非法时一句**中文原因**（调用方拼进逐字段报错里 ——
 *          「哪个条目、哪个字段、为什么」三段都要齐，用户才知道去改什么）。
 */
export function accountHubOriginatorProblem(value) {
    if (typeof value !== 'string') {
        return '必须是字符串（省略 = 不发 Originator 头）';
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return '不能为空串（省略 = 不发 Originator 头）';
    }
    if (trimmed.length > ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH) {
        return `过长（上限 ${ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH} 个字符，收到 ${trimmed.length} 个）`;
    }
    if (ACCOUNT_HUB_ORIGINATOR_CONTROL_CHARS.test(trimmed)) {
        return '含换行或控制字符（HTTP 头值不允许）';
    }
    return null;
}
/**
 * 把任意值归一成可用的覆写值（读路径用：脏值一律当**没有**，不抛错）。
 *
 * @returns 合法值时返回 `trim()` 后的值；否则 `undefined`。
 */
export function normalizeAccountHubOriginator(value) {
    if (accountHubOriginatorProblem(value) !== null)
        return undefined;
    return value.trim();
}
/**
 * 从请求 options 里读覆写值（**结构性读取**：类型上不要求 options 声明该字段）。
 *
 * 结构性读取而不是要求调用方先把 options 断言成 {@link AccountHubOriginatorCarrier}：
 * 七个适配器的 `send()` 收到的都是宿主原样的 `GenerateOptions`，让每处都写一次
 * 类型断言等于把同一个断言抄七遍。
 */
export function accountHubOriginatorOf(options) {
    if (typeof options !== 'object' || options === null)
        return undefined;
    return normalizeAccountHubOriginator(options.accountHubOriginator);
}
/**
 * 把候选条目的 Originator 覆写应用到**已经构造好的**请求头上。
 *
 * ⚠️ 与 UA 通道的语义差别：这里**新增**一个头（`Originator` 在七家上游协议里都不
 * 存在，见模块头的说明），而不是替换一个既有的头。故默认路径下这个头根本不出现。
 *
 * 两个形态各按自己的规矩写：
 * - `Headers`：键大小写不敏感，`set` 会新增该头（若某天有适配器自己发了 `originator`，
 *   这里同样能覆盖它）；
 * - 普通对象：逐字透传给 `fetch`，**必须先清掉异形键**（`originator` 之类）——
 *   留着会变成同一次请求里两个 `Originator` 头，上游看到的是拼接值，最难查。
 *
 * @returns 是否真的写了（`false` = 该请求没配覆写值，出站头一个字节都没动）。
 */
export function applyAccountHubOriginator(headers, options) {
    const originator = accountHubOriginatorOf(options);
    if (originator === undefined)
        return false;
    if (headers instanceof Headers) {
        headers.set('Originator', originator);
        return true;
    }
    for (const key of Object.keys(headers)) {
        if (key !== 'Originator' && key.toLowerCase() === 'originator')
            delete headers[key];
    }
    headers['Originator'] = originator;
    return true;
}
//# sourceMappingURL=account-hub-originator.js.map