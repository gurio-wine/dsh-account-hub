/**
 * Account Hub **客户端伪装运输层**：把候选条目的伪装参数（User-Agent / Originator /
 * windowId）送到「真的被发出去的那一次请求」的头上。
 *
 * ## 它补的是哪一段够不着的路
 *
 * 自动路由候选条目上的三个伪装值（`src/auto-route.ts` 的 `entry.userAgent` /
 * `entry.originator` / `entry.masquerade.windowId`）必须在**该条目自己的那次请求**
 * 上生效。它**不写宿主磁盘上的任何文件**（那套「打补丁」的引擎已整体退役，根因见
 * `docs/agents/client-masquerade-design.md` §0.1 决策记录）。本模块就是这件事的全部实现：
 *
 * 1. **载荷跟着请求走** —— {@link withMasqueradeAsyncIterable} 用
 *    `AsyncLocalStorage` 把 {@link MasqueradePayload} 绑在「驱动这一路流」的异步
 *    上下文上，于是内层真实适配器在生成器里做的任何事（包括它自己发 `fetch`）都
 *    天然看得到属于本次请求的伪装参数，**不需要把参数塞进任何一个既有函数的入参**。
 * 2. **头在最后时刻改** —— {@link ensureMasqueradeFetch} 包装 `globalThis.fetch`，
 *    在请求真正出网前的最后一毫秒读一次 {@link currentMasqueradePayload}，把三个头
 *    就地写进这次请求自己的 `init.headers`。
 *
 * 为什么非得「最后时刻」：出站请求头由内层真实适配器在它自己的 `send()` 里自建，
 * 聚合层（`src/auto-route-adapter.ts`）一点都碰不到；宿主 `ctx.llm.stream(options)`
 * 也没有「带自定义头」这个入口。与其把三个值逐个穿进七个适配器（七处接线、七处
 * 漏接风险），不如在唯一的出网咽喉上统一改写。
 *
 * ## 核心纪律：async generator 的执行上下文属于**恢复它的那一次 `.next()`**
 *
 * 这条纪律是本模块最容易写错的地方：async generator 的**函数体**不在创建它的地方
 * 执行，而在**每一次恢复它的 `.next()` / `.return()` / `.throw()` 调用的上下文**里
 * 执行。故只包住「创建」、然后让外层 `yield*` 去消费，载荷在整段运行期都是**看不见**
 * 的（创建时的上下文根本不会被函数体继承）。
 *
 * 因此 {@link withMasqueradeAsyncIterable} 返回的代理**必须把 `next` / `return` /
 * `throw` 三个方法全部包住** —— 少包一个，那条退出路径上的清理逻辑（`finally` 里
 * 收尾、销账、上报）就会掉回无载荷的上下文。三个一起包，语义才闭合。
 *
 * ## 默认路径**零变化**
 *
 * 上下文里没有载荷（绝大多数请求：非自动路由、或该条目没配伪装参数）时，
 * 包装器**一次都不碰参数**，直接原样转发给安装时捕获的 `base` —— 出站请求与加本模块
 * 之前**逐字节一致**。这是 AGENTS.md「出站协议值不随 provider id / 显示名变化」
 * 红线的延伸。
 *
 * ## 模块加载**零副作用**
 *
 * 本模块被 import 时**不安装任何东西**（不碰 `globalThis.fetch`、不注册钩子）。
 * 安装只发生在显式调用 {@link ensureMasqueradeFetch} 时 —— 由接线方决定时机，
 * 也让单测能干净地进出这个状态。
 *
 * @module dsh-account-hub/account-hub-masquerade-transport
 */
/**
 * 一次请求的伪装载荷（三个字段**各自独立、都可以缺席**）。
 *
 * 部分伪装是合法形态：只配了 `userAgent` 的条目就只换 UA，另外两个头一个字节都不动。
 *
 * 值在此处**不再校验**：三个字段的判据分别归 `src/account-hub-user-agent.ts` /
 * `src/account-hub-originator.ts` / `src/account-hub-window-id.ts`（写路径与读路径
 * 共用的唯一判据），本模块在写入前调用它们的 `normalize*`，脏值一律当「没有」。
 */
export interface MasqueradePayload {
    /** 该请求的 `User-Agent` **整体换成**它（不是追加、不是前缀）。 */
    userAgent?: string;
    /** 该请求**新增**一个 `Originator` 头并取该值（七家上游协议里本就没有这个头）。 */
    originator?: string;
    /** 该请求**新增**一个 `x-codex-window-id` 头并取该值。 */
    windowId?: string;
}
/**
 * 把一路异步流**整段**置于伪装载荷的上下文里。
 *
 * 用法（接线方）：拿到内层适配器返回的流之后，套一层再交给宿主消费 ——
 *
 * ```ts
 * return withMasqueradeAsyncIterable({ userAgent, originator, windowId }, stream)
 * ```
 *
 * ## 为什么三个方法都要包（本模块的核心纪律，详见模块头）
 *
 * 代理每次转发调用时，都用 `masqueradeStorage.run(payload, ...)` 把这次调用**推**进
 * 载荷上下文，再由源迭代器在**该上下文里**恢复执行。于是：
 *
 * - `next()` → 载荷在「生成器函数体运行 + 它发出的请求」期间可见；
 * - `return()` → 载荷在「`break` / 提前退出触发的 `finally` 收尾」期间可见；
 * - `throw()` → 载荷在「异常处理分支」期间可见。
 *
 * ⚠️ 不能只包 `next()`：真实适配器的流在提前退出时会走 `return()`，那条路径上的清理
 * 逻辑一样可能发请求（销账、上报），掉了载荷就会用错身份。
 *
 * @param payload 本次请求的伪装载荷（三个字段都可缺席）。
 * @param source 内层真实适配器返回的流（**创建位置无关紧要**，见模块头）。
 */
export declare function withMasqueradeAsyncIterable<T>(payload: MasqueradePayload, source: AsyncIterable<T>): AsyncIterable<T>;
/**
 * 读当前上下文里的伪装载荷（供 {@link ensureMasqueradeFetch} 在请求时刻取用）。
 *
 * @returns 当前异步上下文里绑定的载荷；不在任何伪装上下文里时 `undefined`。
 */
export declare function currentMasqueradePayload(): MasqueradePayload | undefined;
/**
 * 把三个头**就地**写进已经构造好的请求头容器里（不重建容器、不重建任何对象）。
 *
 * 三种载体形态各按自己的规矩写（**同一个头名在一次请求里只能出现一次**，
 * 否则上游看到的是拼接值，是最难查的一类缺陷）：
 *
 * | 形态 | 写法 |
 * |---|---|
 * | `Headers` | `set()`，键大小写不敏感，天然覆盖 |
 * | `string[][]` | 同名的对就地对调（保序），多余的重复对删掉，没有则 push 一对新的 |
 * | 普通对象 | 先删掉同名异形键（`user-agent` 之类），再按规范键名赋值 |
 *
 * `User-Agent` / `Originator` 的**写路径直接复用**两个既有头通道模块的 `apply*`
 * 函数（判据与写法都不再抄一份）；`windowId` 走本模块自己的写法，值先经
 * `src/account-hub-window-id.ts` 的 `normalizeAccountHubWindowId` 归一。
 *
 * ⚠️ **单个头写失败只允许退化成「少一个头」**：值非法（如含 CR / LF 让
 * `Headers.set` 抛 `TypeError`）、容器处于只读 guard 等异常一律就地吞掉，既不外抛、
 * 也不连累后面两个头 —— 伪装是锦上添花，绝不能把一次配置笔误升级成请求失败。
 *
 * @param headers 已经构造好的头容器（`undefined` 由调用方负责造出载体，本函数不代劳）。
 * @param payload 本次请求的伪装载荷（字段缺席 = 不写那个头）。
 * @returns 是否至少写成功一个头（`false` = 一个字节都没动）。
 */
export declare function applyMasqueradeHeaders(headers: Headers | string[][] | Record<string, string> | undefined, payload: MasqueradePayload): boolean;
/**
 * 安装 `globalThis.fetch` 包装器（**幂等**：重复调用不会叠加层数）。
 *
 * 包装器只做一件事：请求出网前读一次 {@link currentMasqueradePayload}。
 *
 * - **无载荷** → `base(input, init)` 原样转发，`init` 连字段都不读（零变化路径）；
 * - **有载荷** → 就地改写 `init.headers`（没有载体就先造一个空对象挂上去），
 *   然后 `base(input, init)`。**绝不重建 `init` 对象** —— 它上面可能挂着
 *   `duplex`（流式请求体必需）、`signal`、`body` 流等一堆不能复制的字段；
 * - **`init` 缺席** → 原样转发，**不代造 `init`**。openai SDK 的真实调用形状恒为
 *   `(url, init)`；`fetch(request)` 那种 Request 对象形态放弃伪装照常发送（造一个
 *   假的 init 去补头，等于替调用方改变请求语义，比不伪装危险得多）。
 *
 * `base` 在**安装时刻**捕获，故本包装器能与其它同样包装 `globalThis.fetch` 的插件
 * 共存（后装的套在外层，逐层透传）；宿主代理插件那条走 undici dispatcher 的路子
 * 是更底层的一层，与这里不冲突。
 */
export declare function ensureMasqueradeFetch(): void;
/**
 * 卸下 {@link ensureMasqueradeFetch} 装的包装器，还原成安装时捕获的那一层。
 *
 * ⚠️ **只还原自己那一层**：若 `globalThis.fetch` 已经不是本模块装的包装器（被别的
 * 插件又套了一层、或被测试替换过），就什么都不做 —— 硬还原会踩掉别人的包装。
 */
export declare function releaseMasqueradeFetch(): void;
/** 当前 `globalThis.fetch` 是不是本模块装的包装器。 */
export declare function isMasqueradeFetchInstalled(): boolean;
//# sourceMappingURL=account-hub-masquerade-transport.d.ts.map