/**
 * 上下文窗口档位的**通用**机制（全部 provider 共用一条路径）。
 *
 * ## 背景：为什么需要通用层
 *
 * 档位选择最初只服务 Trae CN（`{contextWindow, maxContextWindow}` 两档形态，
 * 见 `TraeCnAdapter.contextTiers`）。用户随后要求把它推广到**所有**能选窗口的
 * 供应商 —— buddy / qoder / lobsterai 的目录各自公布了窗口数据，但**形态互不
 * 相同**：
 *
 * | provider | 目录字段 | 语义 |
 * |---|---|---|
 * | Trae CN | `context_window_tokens.{dev,max}` | dev 默认档 + max 升档 |
 * | Qoder | `available_context_windows` | **最小**档是默认档，其余是升档 |
 * | Buddy | `contextWindow.supportedLengths` | 生效档已是**最大**档，其余是降档 |
 * | LobsterAI | 单个 `contextWindow` | 无档位可选 |
 *
 * 三者的唯一共同点是「**用户能选的档位精确等于目录公布的那些数**」。故本模块
 * 只提供两件与 provider 无关的事：
 *
 * 1. {@link availableContextTiers} —— 把各形态归一成**升序去重的档位列表**；
 * 2. {@link effectiveContextWindow} —— 「预算精确命中列表才生效，否则静默回退
 *    默认档」。
 *
 * provider 特有的取舍（怎么解析、哪条路径优先、默认档取哪个）**留在各自的
 * 解析器里**，本模块一概不知情。
 *
 * ## 红线：纯声明值，出站零变更
 *
 * `contextWindow` 只喂给 `resolveModel().context`，决定宿主压缩管线的触发阈值
 * （`0.8 × 窗口`）与压缩后的保留预算。它**不进出站请求体** —— 各 provider 的
 * `build*ChatBody` 字段全集不变（各有逐字节比对用例钉死）。
 */
/** 档位来源：把 `maxContextWindow` 与 `contextTiers` 两个形态摊平成一个候选集。 */
function collectCandidates(tier) {
    const candidates = [];
    if (isPositiveWindow(tier.contextWindow))
        candidates.push(tier.contextWindow);
    if (isPositiveWindow(tier.maxContextWindow))
        candidates.push(tier.maxContextWindow);
    if (Array.isArray(tier.contextTiers)) {
        for (const value of tier.contextTiers) {
            if (isPositiveWindow(value))
                candidates.push(value);
        }
    }
    return candidates;
}
/** 正有限数才是窗口（0 / 负数 / NaN / Infinity / 非 number 一概不是）。 */
function isPositiveWindow(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
/**
 * 把目录条目的档位归一成**升序去重**的可选窗口列表。
 *
 * ## 归一化规则（顺序即步骤）
 *
 * 1. 三个来源（`contextWindow` / `maxContextWindow` / `contextTiers`）全部摊平；
 * 2. 逐项剔除非法值（只留正有限数）—— 与各解析侧「只保留正数」的既有口径一致；
 * 3. 升序排序 + 去重。
 *
 * ## 为什么默认档要**并入**而不是当作列表首项
 *
 * Buddy 的生效档是 `min(maxInputTokens, 档位表最大档)`：当 `maxInputTokens` 比
 * 档位表最大档还小时，生效默认档**不等于任何公布档位**。此时若不并入，UI 就
 * 无法表达「当前是默认档」这个状态（radio 全不选中）。并入后列表仍然**只含
 * 真实值** —— 默认档本身必然是目录给的某个数，不是编造的。
 *
 * ## 返回空列表的两种情形都表示「没有档位可选」
 *
 * - 条目未声明任何窗口（`{}`）：连默认档都没有；
 * - 只有一个档位（单档模型）：列表长度为 1，UI 侧判据是 `length >= 2`。
 *
 * 调用方（RPC / 客户端）据此决定是否渲染档位列 —— **宁缺毋编**：不给一个切过去
 * 毫无效果的选项。
 */
export function availableContextTiers(tier) {
    if (tier === undefined)
        return [];
    const candidates = collectCandidates(tier);
    if (candidates.length === 0)
        return [];
    // `sort` 默认按字符串比较会把 [300000, 1048576] 排成 [1048576, 300000]，
    // 必须显式给数值比较器。
    return [...new Set(candidates)].sort((a, b) => a - b);
}
/**
 * 该模型**本次应当声明的上下文窗口**：用户选中的档位，或默认档。
 *
 * ## 判据：预算必须**精确命中**档位列表里的某个值
 *
 * 只有 `budget ∈ tiers` 且 `budget !== fallback` 时才采用它，其余一切情况都退回
 * `fallback`：
 *
 * - 未设置预算（`undefined`）；
 * - 预算恰好等于默认档（「恢复默认」与「设成默认档」同义）；
 * - 预算**命中默认档以外的任何公布档位**（升档或降档都允许 —— Qoder 的默认档
 *   是最小档、Buddy 的默认档是最大档，两个方向都真实存在）；
 * - 预算是**编造值**（不在列表里）；
 * - 目录漂移后旧预算失效（roster 浮动，模型下线或档位改值）。
 *
 * ## 「编造值静默回退默认档」是设计，不是遗漏
 *
 * 用户设置永远不能凭空造出一个上游不认的窗口。而**静默**（不报错）同样是刻意
 * 的 —— 回归默认档是安全方向，报错只会让历史会话在目录浮动后突然打不开。
 *
 * ⚠️ **本函数不负责判「档位是否倒挂」**（如 `max <= dev` 的脏条目）：那是解析侧
 * 的判据（Trae CN 的 `parseTraeCnDirectory` / `applyTraeCnAgentTiers` 都在写
 * `maxContextWindow` 前判过 `max > dev`）。通用层只做「精确命中」，不替解析侧
 * 兜底 —— 两处判据混在一起会让「倒挂条目已被拦下」这件事无法定位。
 *
 * @param fallback - 生效的默认档（`undefined` = 目录未声明窗口，此时无从谈档位）。
 * @param tiers - {@link availableContextTiers} 归一后的档位列表。
 * @param budget - 账号池里存的用户选择（`undefined` = 未设置）。
 */
export function effectiveContextWindow(fallback, tiers, budget) {
    if (fallback === undefined)
        return undefined;
    if (budget === undefined || budget === fallback)
        return fallback;
    return tiers.includes(budget) ? budget : fallback;
}
/**
 * 由「provider id → 适配器」的普通对象构造注册表。
 *
 * 值为 `undefined` 的键**直接丢弃**：组装点常常要按条件传适配器（例如某个
 * provider 未接线），让调用方写 `...(x === undefined ? {} : {p: x})` 只会在每个
 * 调用点重复一遍同样的判断。
 *
 * ## 键收窄为 {@link ProviderId}：这是拼错键**唯一**能拿到编译期报错的地方
 *
 * 本函数是档位注册表的**唯一构造点**，且调用方传的是对象字面量 —— 故把
 * `ProviderId` 约束加在**形参**上，`src/index.ts` 里写错的键会被 excess property
 * check 当场拦下（`TS2353`）。
 *
 * ⚠️ **加在 `registerAccountHubRpc` 的 `contextTiers` 字段上是无效的**：那里的
 * 类型是 {@link ContextTierRegistry}（只有 `sourceFor(provider: string)`），键信息
 * 在构造完就已擦除 —— 事后无法校验。保护必须落在**键还存在的那一刻**。
 *
 * ⚠️ **`Partial` 允许子集 ⇒ 漏登记不报错**：档位注册表本来就只登记有档位数据源的
 * provider（5/7，codearts 与 lobsterai 刻意不在其中）。「有目录却漏登记档位」由
 * `src/account-hub-rpc.ts` 的 `warnMissingTierSources` 在注册入口运行时告警兜底。
 */
export function createContextTierRegistry(sources) {
    const table = new Map();
    for (const [provider, source] of Object.entries(sources)) {
        if (source !== undefined)
            table.set(provider, source);
    }
    return {
        sourceFor: (provider) => table.get(provider),
    };
}
/**
 * 把档位列表渲染成给用户看的文案（错误提示里列出「有哪些档位可选」）。
 *
 * 用户提交了一个编造数字时，他需要看到的是**可选值**，而不是一句「参数非法」；
 * 因此默认档要标出来（他不知道哪个是不选档时的行为）。
 *
 * 例：`119040（默认） / 1048576`、`200000（默认） / 400000 / 1000000`；
 * 单档模型（无可选档位）只列默认档（`119040（默认）`）。
 */
export function describeContextTiers(tiers, fallback) {
    if (fallback === undefined)
        return '（目录未声明）';
    if (tiers.length <= 1)
        return `${fallback}（默认）`;
    return tiers.map((value) => (value === fallback ? `${value}（默认）` : String(value))).join(' / ');
}
//# sourceMappingURL=context-tiers.js.map