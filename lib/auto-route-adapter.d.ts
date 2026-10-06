/**
 * 「自动路由」的**聚合适配器**：把若干自动模型暴露成 DSH 上的一个虚拟 provider
 * （{@link AUTO_ROUTE_PROVIDER_ID}），并在一次请求内按候选顺序**转发 + 降级**。
 *
 * ## 分层：本文件只做「接线」，语义全在 `src/auto-route.ts`
 *
 * 配置契约（读/写判据、默认值）、降级轮转引擎（`autoRouteHead` /
 * `demoteAutoRouteHead` / `autoRouteEntryCount`）与历史消息重写
 * （`rewriteMessagesForTarget`）都在那个纯逻辑模块里，本文件**不重新实现任何判据**
 * —— 它只做三件事：把 DSH 的模型目录问询转成对池配置的读取、把一次请求按队首
 * 条目转发给真实 provider、把内层失败翻译成「降级」或「透传」。
 *
 * ## 转发为什么是「重入 `ctx.llm.stream()`」而不是直接调别的适配器
 *
 * `ctx` 上**没有**「按 provider 取适配器实例」的入口（`LlmRuntime` 只暴露
 * `listProviders` / `listModels` / `resolveModelInfo` / `stream`）。跨 provider 的
 * 唯一通路就是在适配器的 `stream()` 里带目标 provider 重入 `ctx.llm.stream()` ——
 * 宿主会据此重新走一遍适配器选择、能力解析与请求装配。这也是官方认可的做法。
 *
 * ## 内层失败以 `finish` chunk 到达，**不是 throw**
 *
 * 宿主的 `adapterStream` 把「建立阶段抛错」与「迭代阶段抛错」**都**规范化为一个
 * 终止 chunk：`finish{reason:{kind:'error'|'aborted'}}`。故本适配器的降级判据读的是
 * chunk，而不是 try/catch —— 若照 throw 写，转发路径上的失败将**一条都降级不了**，
 * 全部直报给用户。
 *
 * ## `emitted` 的判据是「已 yield 过任何非 finish chunk」，不是「已出字」
 *
 * 这一条比字面语义更严，是**宿主流语法**要求的：一旦我们把内层的 `block-start` /
 * 文本增量 / `usage` 透传给外层，就不能再静默换到下一个条目重来 —— 新条目会从
 * `block-start(0)` 重新开始，外层装配器会看到「重复的 block-start index 0」；
 * `usage` 同理（宿主 `llm-invariant` 明确禁止一条流里出现两次 usage）。故只要
 * 透传过任何非终止 chunk，后续失败一律**透传**，交由官方重试在**新一轮**请求上
 * 从新队首继续。
 *
 * ## 伪装运输层：只包「消费」，且只在真有载荷时才包
 *
 * 转发出去的流由 `account-hub-masquerade-transport` 的 `fetch` 包装器负责把三个头写到
 * 真实请求上，而它读的是 `AsyncLocalStorage` 里的当前载荷。本文件负责**把载荷放进去**，
 * 纪律有两条，都不是风格问题：
 *
 * 1. **ALS 必须包「消费」而不是「创建」**：`this.options.ctx.llm.stream(forwarded)`
 *    只是造了个异步生成器对象，一个字节都还没跑；生成器的函数体是在**恢复它的那次
 *    `.next()`** 的上下文里执行的。故上下文必须加在 `for await` 这一侧（见
 *    {@link withMasqueradeAsyncIterable} 对三个迭代方法的处理），加在创建点等于什么都没包
 *    —— 且不会报任何错，只会「伪装整段静默失效」。
 * 2. **默认路径一个字节都不动**：载荷为 `undefined`（三个字段归一后全空）时既不装
 *    `fetch` 包装器、也不套 ALS 代理，`consumed` 就是内层流本身。包装器即使在零载荷时
 *    只是纯转发，装它也会改变**所有**出站请求的调用栈形态，而 `globalThis.fetch` 是
 *    全进程共享的 —— 别的插件也看得见。
 *
 * 载荷与 `forwarded` 上那三个载体字段（`accountHubUserAgent` / `accountHubOriginator` /
 * `accountHubMasquerade`）**必须同源**：都由同一条 entry 现算，见
 * {@link masqueradePayloadOf}。
 *
 * @module dsh-account-hub/auto-route-adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { AdapterRegistrationHandle, GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type AutoRouteConfig } from './auto-route.js';
export interface AutoRouteAdapterOptions {
    /**
     * 宿主上下文：适配器只用到 `ctx.llm`（重入 `stream` 与 `resolveModelInfo`）。
     *
     * 刻意收 `ctx` 而不是两个函数：重入的通路必须是**同一个 `LlmRuntime` 实例**，
     * 否则「转发」会打到另一个注册表上（拿到的适配器、重试策略与目录全都不是同一份）。
     */
    ctx: Context;
    /**
     * 读取**当前**自动路由配置（同步、永不抛错）。
     *
     * 由 `src/index.ts` 传 `() => pool.autoRouteConfig()`。适配器**不缓存**它的返回值：
     * `listModels` / `resolveModel` 每次都现读，模型目录与定义因此永远与池一致，
     * 不需要任何「重建适配器」的时机配合。
     */
    config: () => AutoRouteConfig;
}
/**
 * 聚合路由适配器。
 *
 * 两套状态，各有明确的所有者：
 * - **配置读路径**（`listModels` / `resolveModel`）永远现读 {@link AutoRouteAdapterOptions.config}，
 *   不做缓存 —— 用户改了自动模型，下一轮目录刷新就该看到，不存在「忘了重建」的窗口。
 * - **降级运行时**（{@link AutoRouteRuntime}）是本适配器独有的**进程内轮转偏移**，
 *   只能由 {@link applyConfig} 重建（配置变更 = 队列归位）。
 */
export declare class AutoRouteAdapter extends LlmAdapter {
    private readonly options;
    private runtime;
    /** 上一次 `applyConfig` 收到的配置指纹（内容幂等门的依据）。 */
    private appliedFacts;
    constructor(options: AutoRouteAdapterOptions);
    /**
     * 把当前配置应用到运行时（**内容幂等**：内容没变就什么都不做）。
     *
     * ## 为什么重建条件是「内容」而不是「定义 id 集合」
     *
     * 定义 id 集合不变、只改 `entries`（加一条候选 / 换 provider / 调顺序）是界面上
     * **最常见**的编辑。若重建只看 id 集合，这类编辑之后运行时仍握着旧条目：新加的
     * 候选永远轮不到，删掉的候选还会继续被使用 —— 而且没有任何报错。故这里比对整份
     * 配置的内容指纹，任何内容变化都重建（= 用户新排的顺序立即成为权威顺序）。
     *
     * 调用方（`ensureAutoRouteRegistration`）可以**无条件**调用本方法：幂等门在这里，
     * 不在调用方 —— 「配置变没变」只应该有一个判据。
     */
    applyConfig(config: AutoRouteConfig): void;
    /** 当前配置里的定义表（按定义 id 索引）—— 每次现读，供 `resolveModel` 用。 */
    private definitionOf;
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 本路由的重试策略。
     *
     * 宿主在**注册时**把它快照进注册表（`prepareRoutes`），故这里只需返回同一份
     * 冻结策略；返回 `undefined` 会让宿主落到它的默认策略，而「两个自有错误码都
     * 不在默认集合里」这件事就会变成一条依赖外部默认值的隐式假设。
     */
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    /**
     * 模型目录 = 用户定义的自动模型列表。
     *
     * - **总开关关着 → `[]`**：与七个真实 provider 的目录门控同一手段（DSH 的
     *   `buildModelCatalog` 会 `.filter(group => group.models.length > 0)`，空数组
     *   即整个分组消失）。关掉开关却还在下拉里留一组点了必然失败的模型，是最糟的
     *   形态。
     * - 能力（上下文窗口 / 思考档 / 模态）**不在这里声明**：`LlmModelInfo` 本来
     *   就没有这些字段，它们由 {@link resolveModel} 按**当前队首条目**现算（含思考档），
     *   随运行时降级队列的变化而变化。这里刻意只给
     *   `{provider, id, name}` —— 多塞字段会在宿主 `listModels` 那一层被静默丢掉
     *   （它只重建这四个字段），不如不写。
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 精确模型能力 = **当前队首条目的目标能力** + 本自动模型的 id / 名称。
     *
     * ## 为什么 `provider` / `id` 必须改写成 `auto-route` / `definition.id`
     *
     * 宿主 `normalizeModelInfo` 会硬校验 `resolved.provider === 路由名` 且
     * `resolved.id === 请求的模型名`，不符即抛 `INVALID_MODEL_INFO` —— 整轮对话起不来。
     * 故目标能力按当前队首条目透传，身份三元组必须换成本路由的。
     *
     * ## reasoning 的动态聚合
     *
     * `reasoning` 只来自当前队首条目解析出的目标 provider/model；目标没有有效的
     * `efforts` 时不声明。`entry.effort` 是聚合模型 `defaultEffort` 的来源，也是在调用方
     * 未显式选择档位或其选择不被当前目标接受时的回落值：命中目标 `efforts` 时用作聚合
     * 模型的默认档，非法时回退目标自身的有效 `defaultEffort`，两者都无效则省略默认值。
     * 因此能力声明随队首动态变化；实际转发仍由 {@link forwardOptions} 按调用方优先、
     * 条目回落的语义处理。
     *
     * 这里不复制 provider 名单，也不把非法条目档位伪装成能力；当前队首若因降级
     * 变化，下一次 `resolveModel` 会重新读取对应目标能力。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 一次请求：按队首条目转发，失败即降级，满一圈才报「全部条目不可用」。
     *
     * 逐条语义见模块头。三个**不变量**在这里落地：
     * 1. **单次请求最多试 N 次**（N = 条目数）：`demotions` 计数是本适配器唯一的
     *    请求内状态，引擎本身不计数（见 `src/auto-route.ts` 的语义说明）。
     * 2. **`aborted` 绝不降级**：用户取消不是候选不可用，换一个 provider 继续跑
     *    等于无视取消。
     * 3. **透传过的流不换条目**：见模块头对 `emitted` 的说明。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * 在 `ctx.llm` 上注册自动路由的虚拟 provider 路由。
 *
 * ## 为什么**不**登记进「可配置 provider 目录」
 *
 * 其余七个 `register*Llm` 都会调 `registerConfigurableProviders`，因为它们的配置面
 * 就是模型设置页（要一个 `settingsNs` 与一个可填的 API key）。自动路由两样都没有：
 * 它的配置面是 Account Hub 面板（`autoroute.get` / `autoroute.set`），且它自己不
 * 持有任何凭据 —— 凭据属于被转发的那些真实 provider。
 *
 * 登记进去的代价是具体的：设置页会多出一行「自动路由」，带一个永远用不上的
 * `AUTO_ROUTE_API_KEY` 输入框，还会要求一个真实存在的 `settingsNs`（不存在就是
 * `deriveKeyRef` 那条崩溃路径）。不登记时它只是作为「已注册但未声明」的路由出现，
 * 不索取任何配置。
 *
 * ## 为什么返回 handle
 *
 * 调用方（`src/index.ts`）要按总开关**休眠/唤醒**这条路由（`handle.replace([])` /
 * `replace([AUTO_ROUTE_PROVIDER_ID])`）。返回裸适配器会让调用方只能自己再调一次
 * `registerAdapter` —— 那第二次调用会因为「路由已被本适配器占用」而抛
 * `DUPLICATE_ADAPTER`。
 *
 * @returns 注册 handle 与适配器实例。
 */
export declare function registerAutoRouteLlm(ctx: Context, options: AutoRouteAdapterOptions): {
    handle: AdapterRegistrationHandle;
    adapter: AutoRouteAdapter;
};
/**
 * 造一个「读配置 → 注册/唤醒/休眠 → 运行时归位」的刷新函数。
 *
 * ## 为什么这段生命周期是**本模块的导出**，而不是 `src/index.ts` 里的一段闭包
 *
 * 它有三条容易写错、且写错后完全静默的判据（内容幂等门、空路由集休眠、首次注册
 * 与唤醒的分工）。放在 `apply()` 的闭包里意味着**只有一条巨型接线路径能覆盖它**，
 * 单测无从下手；而这三条恰恰是「关掉开关后 provider 仍在列表里」「改了候选顺序
 * 运行时不动」这类缺陷的唯一发生地。故整段搬到这里，`src/index.ts` 只负责传
 * `() => pool.autoRouteConfig()`。
 *
 * ## 调用方**可以无条件反复调用**返回值
 *
 * 幂等门在这里，不在调用方 —— 「配置变没变」只应该有一个判据。启动一次、每次
 * `autoroute.set` 一次，多余的调用是零副作用的。
 *
 * ## 语义
 *
 * - **内容没变**（`autoRouteConfigFacts` 相同）且已注册过 → 立即返回，**一次
 *   `replace` 都不发**（`replace` 会发 `llm/adapters-updated`，无谓的通知会让
 *   订阅者白重算目录）。
 * - **首次**：即使总开关关着也要注册（否则打开开关时没有 handle 可 replace），
 *   注册后按开关调整路由集。
 * - **开关**落在**路由集**上：关着 = `replace([])`（零路由，provider 从 DSH 的
 *   `listProviders()` 与模型目录里一并消失），开着 = `replace([auto-route])`。
 *   `replace([])` 是宿主契约明确允许的形态（「空数组合法，与空的首次注册不同」）。
 * - **内容变了**（含只改 `entries`）→ `applyConfig` 重建运行时（队列归位）。
 *
 * ## 失败处置：抛出去，由调用方决定
 *
 * 本函数**不吞异常**。两个调用点各自处置：启动链记日志（功能本次不可用），RPC 的
 * `autoroute.set` 侧也记日志（配置已写入，运行时下一轮自愈）。在这里吞掉会让
 * 「为什么没生效」失去唯一的可观测点。
 *
 * @returns 幂等的刷新函数（可反复调用）。
 */
export declare function createAutoRouteRegistration(ctx: Context, config: () => AutoRouteConfig): () => void;
/** 文件通道只做诊断：任何路径/目录/轮转/追加错误都不能影响路由。 */
export declare function writeAutoRouteDemotionLog(ctx: Context, details: string): void;
/** 仅供单测等待 fire-and-forget 文件写入收口；生产路径绝不调用。 */
export declare function flushAutoRouteDemotionLogWrites(): Promise<void>;
/**
 * 在 `agent/request` 瀑布流上兜底校验打到聚合模型的 `reasoningEffort`。
 *
 * ## 为什么需要它（宿主在**到达适配器之前**就校验）
 *
 * 聚合模型现在按当前队首目标声明 `reasoning.efforts`（见
 * {@link AutoRouteAdapter.resolveModel}），而宿主的 `resolveCallWithInfo` 会对请求档位
 * 做硬校验。监听器必须以**同一份当前能力**为准：仍合法的用户选择不能被抹掉，失配的
 * 历史残留或过期值才需要止损剥除：
 *
 * ```text
 * reasoning === undefined && requested !== undefined → UNSUPPORTED_REASONING_EFFORT
 * ```
 *
 * 实测（`dsh-llm@0.1.2-rc.1`，真实 `LlmRuntime`）它发生在适配器 `stream()` **之前**
 * —— 那条路径上 `adapter.stream()` 的调用数是 0。真实 agent 路径更早：
 * `agent-loop/agent.ts` 的 `llm.prepareCall()` 内部就抛，而其 catch 只放行
 * `NO_ADAPTER`，其余 rethrow ⇒ **整轮直接死**。
 *
 * ## 谁会带着档位打过来
 *
 * 一部分请求来自升级前用过自动路由、并在会话侧显式选过档位的历史会话：档位被持久化在
 * `model/selection` 或 request header 的 `config.reasoningEffort` 上，恢复时由
 * `agent.ts` 的 `persistedReasoningEffort` 还原。也可能是当前聚合能力中仍合法的选择，
 * 因此不能再按 provider 直接无条件删除；只对当前 `resolveModelInfo` 仍不接受的值止损。
 *
 * ## 为什么挂在这里，而不是适配器 `stream()` 入口
 *
 * 适配器入口的**无条件剥键**不能替代这里的宿主校验前处理：档位校验在
 * `resolveCallWithInfo`（`dsh-llm/lib/index.js`），发生在适配器真正 dispatch 之前；
 * `agent/request` 是唯一能在校验前修正会话配置的挂点。真实 `AutoRouteAdapter.stream()`
 * 仍会在已经进入适配器的请求上做当前目标能力预检，但那是另一条更晚的转发保护，不能
 * 修复宿主校验前的会话残留，也不能替代直接调适配器所依赖的 `forwardOptions` 兼容语义。
 *
 * 直接调适配器的场景（测试、未来的外部调用方）不经过这里，且依赖 `forwardOptions`
 * 在条目缺省档位时保留调用方值。这里不能猜测或反向改写直调路径，其边界仍是
 * `agent/request`。
 *
 * ## 作用域：根级监听器可达，但仍显式带 `{ global: true }`
 *
 * `dsh-scope` 的 `scopeTarget` 让**无 scope 标签的监听器全局放行**（本插件的根级 ctx
 * 无标签），故不带 `global` 实测也收得到。仍然显式写，是因为 cordis 的派发过滤是
 * `hook.global || !filter || filter.call(thisArg, hook.ctx)`（`cordis/lib/index.js:263`）——
 * `global` 是短路项、零成本；而「插件恰好挂在根上」一旦变化（本插件被装进某个 scope），
 * 不带 `global` 的监听器会被静默过滤掉，兜底无声消失，症状却是「历史会话又整轮报错」。
 *
 * ## 覆盖面边界（刻意接受）
 *
 * 它只覆盖 agent 会话路径。`llm.resolveCallConfig` 的直调路径（面板选择、子代理预检等）
 * 是直接方法调用、无事件可挂，仍由宿主按当前聚合能力自行校验；其他插件对
 * `ctx.llm.stream()` 的直调同样绕开这里。直调绕过 agent/request 是本切片的非目标边界，
 * 不猜测私有 API，也不新增反向 RPC。
 *
 * ## 处置：合法保留；明确失配时 warn 一次 + 剥键，未知时保留
 *
 * 能力查询成功且当前 `efforts` 缺失、为空或不包含请求值时，才确认失配并删除该键；
 * 能力查询失败只能说明暂时无法判断，守卫只 warn 并保留用户选择。warn **按定义去重**
 * （同一 provider/model 只报一次），避免历史残留在每一步刷满日志。
 *
 * @param ctx - 宿主上下文（注册 `agent/request` 监听器）。
 * @returns 注销函数。
 */
export declare function installAutoRouteEffortGuard(ctx: Context): () => void;
//# sourceMappingURL=auto-route-adapter.d.ts.map