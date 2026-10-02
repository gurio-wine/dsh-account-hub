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
import { AsyncLocalStorage } from 'node:async_hooks';
import { applyAccountHubUserAgent, normalizeAccountHubUserAgent, } from './account-hub-user-agent.js';
import { applyAccountHubOriginator, normalizeAccountHubOriginator, } from './account-hub-originator.js';
import { ACCOUNT_HUB_WINDOW_ID_HEADER, normalizeAccountHubWindowId, } from './account-hub-window-id.js';
/**
 * 两条既有头通道的出站头名。
 *
 * ⚠️ 这两个字面量必须与 `src/account-hub-user-agent.ts` / `src/account-hub-originator.ts`
 * 里 `headers.set(...)` 的实参**逐字一致**（那两个模块没有导出头名常量，故此处按需复述）。
 * 它们只在 `string[][]` 形态下被本模块用到 —— `Headers` 与普通对象形态一律走那两个
 * 模块自己的写函数，不经过这里。
 */
const USER_AGENT_HEADER = 'User-Agent';
const ORIGINATOR_HEADER = 'Originator';
/**
 * 载荷的**模块级单例**（`AsyncLocalStorage` 实例本身就代表「当前上下文里绑着什么」，
 * 故全插件只该有这一个；另起一个实例等于把上下文切成两半，两边的值互相看不见）。
 */
const masqueradeStorage = new AsyncLocalStorage();
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
export function withMasqueradeAsyncIterable(payload, source) {
    return {
        [Symbol.asyncIterator]() {
            // 迭代器在**进入上下文之前**取，且每个 `for await` 各取一个（与源语义一致）。
            const iterator = source[Symbol.asyncIterator]();
            return {
                next(...args) {
                    return masqueradeStorage.run(payload, () => iterator.next(...args));
                },
                return(value) {
                    // 源没实现 `return` 时按协议自己收尾（`for await` 的 `break` 依赖它）。
                    const sourceReturn = iterator.return;
                    if (sourceReturn === undefined) {
                        return Promise.resolve({ done: true, value });
                    }
                    return masqueradeStorage.run(payload, () => sourceReturn.call(iterator, value));
                },
                throw(error) {
                    // 源没实现 `throw` 时按协议把异常抛回给调用方。
                    const sourceThrow = iterator.throw;
                    if (sourceThrow === undefined)
                        return Promise.reject(error);
                    return masqueradeStorage.run(payload, () => sourceThrow.call(iterator, error));
                },
            };
        },
    };
}
/**
 * 读当前上下文里的伪装载荷（供 {@link ensureMasqueradeFetch} 在请求时刻取用）。
 *
 * @returns 当前异步上下文里绑定的载荷；不在任何伪装上下文里时 `undefined`。
 */
export function currentMasqueradePayload() {
    return masqueradeStorage.getStore();
}
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
export function applyMasqueradeHeaders(headers, payload) {
    if (headers === undefined)
        return false;
    let applied = false;
    if (Array.isArray(headers)) {
        // 数组形态：两个既有模块的 `apply*` 不认这个形态（它们的参数类型只有
        // `Headers | 普通对象`），故写数组的动作落在本模块；**判据仍复用**
        // 那两条通道的 `normalize*`，不复制校验逻辑。
        applied = writeSafely(applied, () => writePairHeader(headers, USER_AGENT_HEADER, normalizeAccountHubUserAgent(payload.userAgent)));
        applied = writeSafely(applied, () => writePairHeader(headers, ORIGINATOR_HEADER, normalizeAccountHubOriginator(payload.originator)));
        applied = writeSafely(applied, () => writePairHeader(headers, ACCOUNT_HUB_WINDOW_ID_HEADER, normalizeAccountHubWindowId(payload.windowId)));
        return applied;
    }
    applied = writeSafely(applied, () => applyAccountHubUserAgent(headers, { accountHubUserAgent: payload.userAgent }));
    applied = writeSafely(applied, () => applyAccountHubOriginator(headers, { accountHubOriginator: payload.originator }));
    applied = writeSafely(applied, () => {
        const windowId = normalizeAccountHubWindowId(payload.windowId);
        if (windowId === undefined)
            return false;
        writeHeaderValue(headers, ACCOUNT_HUB_WINDOW_ID_HEADER, windowId);
        return true;
    });
    return applied;
}
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
export function ensureMasqueradeFetch() {
    if (isMasqueradeFetchInstalled())
        return;
    const base = globalThis.fetch;
    const wrapper = function masqueradeFetch(input, init) {
        const payload = currentMasqueradePayload();
        // 零变化路径：没有载荷时连 `init` 的形状都不看。
        if (payload === undefined)
            return base(input, init);
        // `init` 缺席（含运行时传 null）→ 原样转发，见函数头说明。
        const target = init;
        if (target === undefined || target === null)
            return base(input, init);
        // 没有载体就先挂一个空对象：**不改 `init` 的其它任何字段**。
        if (target.headers === undefined)
            target.headers = {};
        // `RequestInit.headers` 的静态类型（`HeadersInit`）比本模块声明的三种形态宽一档：
        // 它的普通对象形态允许 `readonly string[]` 值（HTTP 多值头）。此处断言**无害** ——
        // `applyMasqueradeHeaders` 内部按 `Array.isArray` / `instanceof Headers` 分派，
        // 落进对象分支后对容器只做「删同名异形键 + 赋单值」，这两步在宽形态上同样成立
        // （多值条目被覆写成单值，正是伪装要的语义）。故签名保持三形态不变，断言只此一处。
        applyMasqueradeHeaders(target.headers, payload);
        return base(input, init);
    };
    wrapper[MASQUERADE_FETCH_MARKER] = true;
    masqueradeFetchBase = base;
    globalThis.fetch = wrapper;
}
/**
 * 卸下 {@link ensureMasqueradeFetch} 装的包装器，还原成安装时捕获的那一层。
 *
 * ⚠️ **只还原自己那一层**：若 `globalThis.fetch` 已经不是本模块装的包装器（被别的
 * 插件又套了一层、或被测试替换过），就什么都不做 —— 硬还原会踩掉别人的包装。
 */
export function releaseMasqueradeFetch() {
    if (!isMasqueradeFetchInstalled())
        return;
    const base = masqueradeFetchBase;
    if (base === undefined)
        return;
    masqueradeFetchBase = undefined;
    globalThis.fetch = base;
}
/** 当前 `globalThis.fetch` 是不是本模块装的包装器。 */
export function isMasqueradeFetchInstalled() {
    const current = globalThis.fetch;
    if (typeof current !== 'function')
        return false;
    return current[MASQUERADE_FETCH_MARKER] === true;
}
/**
 * 包装器的身份标记（挂在包装函数自己身上）。
 *
 * 用 `Symbol.for` 而不是 `Symbol()`：同一个模块被两条路径加载出两份实例时（打包器
 * 去重失败、ESM/CJS 双份），`Symbol()` 的两份标记互不相等，会各装一层；
 * 全局注册表里的这个键能让两份实例认出同一个包装器。
 */
const MASQUERADE_FETCH_MARKER = Symbol.for('dsh-account-hub.masquerade-transport.fetch');
/** 安装时捕获的下一层 `fetch`（`undefined` = 当前没有本模块装的包装器）。 */
let masqueradeFetchBase;
/**
 * 写一个头，并把它可能抛出的异常就地吃掉（只退化成「少一个头」）。
 *
 * @param previous 之前是否已经写成功过（异常时原样返回，不抹掉已有战果）。
 * @param write 实际写入动作，返回是否写了。
 */
function writeSafely(previous, write) {
    try {
        return write() || previous;
    }
    catch {
        return previous;
    }
}
/** 把 `string[][]` 形态里的某个头写成新值（值为 `undefined` = 不写）。 */
function writePairHeader(headers, name, value) {
    if (value === undefined)
        return false;
    writeHeaderValue(headers, name, value);
    return true;
}
/**
 * 就地写一个头（三种载体形态共用，`Headers` / 数组 / 普通对象各按自己的规矩）。
 *
 * 数组形态**保序**：第一个同名对就地对调，其余同名对删除（只是换个值，不该把
 * `User-Agent` 挪到头的末尾去）。
 */
function writeHeaderValue(headers, name, value) {
    if (headers instanceof Headers) {
        headers.set(name, value);
        return;
    }
    if (Array.isArray(headers)) {
        const lowerName = name.toLowerCase();
        let replaced = false;
        // 倒序：splice 不会影响尚未访问的下标；留下的那对保持原位置。
        for (let index = headers.length - 1; index >= 0; index -= 1) {
            const pair = headers[index];
            const pairName = pair?.[0];
            if (typeof pairName !== 'string' || pairName.toLowerCase() !== lowerName)
                continue;
            if (replaced)
                headers.splice(index, 1);
            else {
                headers[index] = [name, value];
                replaced = true;
            }
        }
        if (!replaced)
            headers.push([name, value]);
        return;
    }
    for (const key of Object.keys(headers)) {
        if (key !== name && key.toLowerCase() === name.toLowerCase())
            delete headers[key];
    }
    headers[name] = value;
}
//# sourceMappingURL=account-hub-masquerade-transport.js.map