/**
 * Account Hub **内部协议字段**：自动路由候选的 User-Agent 覆写通道。
 *
 * ## 它补的是哪一段够不着的路
 *
 * 自动路由（`src/auto-route-adapter.ts`）转发一次请求时只改得了 `provider` /
 * `model` / `messages` / 可选 `reasoningEffort`（`forwardOptions()`）—— **出站
 * 请求头由内层真实适配器在它自己的 `send()` 里自建**，聚合层一点都碰不到：
 * 宿主的 `ctx.llm.stream(options)` 没有「带自定义头」这个入口。于是候选条目配了
 * `userAgent` 时，聚合层把它挂在本模块声明的
 * {@link AccountHubUserAgentCarrier.accountHubUserAgent} 上，随 `GenerateOptions`
 * 对象一起穿过 `ctx.llm.stream()`（宿主只按 `provider` / `model` 选适配器，多余
 * 字段原样带着走，见 `dsh-llm` 的 `forAdapter`），由内层适配器在构造完自己的头
 * **之后**覆写 `User-Agent`。
 *
 * ## 为什么是「内部协议字段」而不是给宿主加能力
 *
 * 宿主 `GenerateOptions` 没有、也不该有「任意请求头」这种字段 —— 那等于让任何
 * 插件都能改别的 provider 的出站身份。本字段只在**本插件的八个适配器**之间流转：
 * 写方只有聚合适配器，读方只有那七个真实适配器的 `send()`（qoder 两区同函数）。
 * 宿主与其它插件既不读也不写，故它是本插件自己的内部约定，不是对外契约 ——
 * 字段名带 `accountHub` 前缀就是为了让这一点在日志与断点里一眼可见。
 *
 * ## 默认路径**零变化**
 *
 * 字段缺席（绝大多数请求）时 {@link applyAccountHubUserAgent} 什么都不做，出站头
 * 与加本功能之前**逐字节一致**。这是 AGENTS.md「出站协议值不随 provider id /
 * 显示名变化」红线的延伸：覆写通道没被用上时，任何既有行为都不得改变。
 *
 * @module dsh-account-hub/account-hub-user-agent
 */
/** 覆写值的长度上限（HTTP 头值不该无限长，也挡住把整段 prompt 塞进来的误用）。 */
export declare const ACCOUNT_HUB_USER_AGENT_MAX_LENGTH = 512;
/**
 * 覆写通道的载荷形状（随 `GenerateOptions` 一起流转的内部字段）。
 *
 * 声明成独立接口、不给宿主 `GenerateOptions` 做模块增强：契约属于本插件，
 * 增强宿主类型反而会让「谁在使用它」从类型上消失（任何适配器看起来都能读）。
 */
export interface AccountHubUserAgentCarrier {
    /**
     * Account Hub 内部协议字段：自动路由候选的 UA 覆写，**仅本插件适配器消费**。
     *
     * - 缺席 / 非法（非字符串、空串、超长、含控制字符）= **不覆写**（用适配器自己的值）；
     * - 合法值 = 该请求的 `User-Agent` 头**整体换成**它（不是追加、不是前缀、不是注释）。
     */
    accountHubUserAgent?: string;
}
/**
 * 校验一个候选条目的 UA 覆写值（**写路径与读路径共用的唯一判据**）。
 *
 * 判据逐条（校验的是 `trim()` 之后的值 —— 那才是会被存下、会被发出去的形态）：
 *
 * | 形态 | 结果 |
 * |---|---|
 * | 非字符串 | 拒 |
 * | `trim()` 后为空串 | 拒（缺省 = 用该 provider 的默认 UA，不需要用空串表达） |
 * | `trim()` 后长度 > {@link ACCOUNT_HUB_USER_AGENT_MAX_LENGTH} | 拒 |
 * | 含控制字符（CR / LF / TAB / …） | 拒（HTTP 头值不允许，也是头注入的经典入口） |
 *
 * @returns 合法时 `null`；非法时一句**中文原因**（调用方拼进逐字段报错里 ——
 *          「哪个条目、哪个字段、为什么」三段都要齐，用户才知道去改什么）。
 */
export declare function accountHubUserAgentProblem(value: unknown): string | null;
/**
 * 把任意值归一成可用的覆写值（读路径用：脏值一律当**没有**，不抛错）。
 *
 * @returns 合法值时返回 `trim()` 后的值；否则 `undefined`。
 */
export declare function normalizeAccountHubUserAgent(value: unknown): string | undefined;
/**
 * 从请求 options 里读覆写值（**结构性读取**：类型上不要求 options 声明该字段）。
 *
 * 结构性读取而不是要求调用方先把 options 断言成 {@link AccountHubUserAgentCarrier}：
 * 七个适配器的 `send()` 收到的都是宿主原样的 `GenerateOptions`，让每处都写一次
 * 类型断言等于把同一个断言抄七遍。
 */
export declare function accountHubUserAgentOf(options: unknown): string | undefined;
/**
 * 把候选条目的 UA 覆写应用到**已经构造好的**请求头上。
 *
 * 两个形态各按自己的规矩写：
 * - `Headers`：键大小写不敏感，`set` 天然覆盖框架 `attributionHeaders()` 注入的
 *   小写 `user-agent`；
 * - 普通对象：逐字透传给 `fetch`，**必须先清掉异形键**（`user-agent` 之类）——
 *   留着会变成同一次请求里两个 `User-Agent` 头，上游看到的是拼接值，最难查。
 *
 * @returns 是否真的覆写了（`false` = 该请求没配覆写值，出站头一个字节都没动）。
 */
export declare function applyAccountHubUserAgent(headers: Headers | Record<string, string>, options: unknown): boolean;
//# sourceMappingURL=account-hub-user-agent.d.ts.map