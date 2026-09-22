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

/**
 * 一个模型在**当前生效目录**里的上下文窗口档位。
 *
 * 形状刻意与既有 `TraeCnContextTier`（`{contextWindow?, maxContextWindow?}`）
 * 保持结构兼容，故 Trae CN 的既有实现与测试无需改动即可并入通用路径。
 */
export interface ContextTier {
  /**
   * **生效的默认档**（未设置预算时向宿主声明的窗口）。
   *
   * 各 provider 的取值口径不同且**均不受本模块影响**：Trae CN 取
   * `context_window_tokens.dev ?? prompt_max_tokens`；Qoder 取
   * `default_context_window ?? available_context_windows[0]`；Buddy 取
   * `min(maxInputTokens, supportedLengths 最大档)`（`6f977dc` 定案）。
   */
  contextWindow?: number
  /**
   * **Max 档**：仅当它严格大于 {@link contextWindow} 时才由解析侧写入。
   *
   * Trae CN 专用形态（它的目录把两档分成两个字段）。其余 provider 用
   * {@link contextTiers} 表达完整档位表。
   */
  maxContextWindow?: number
  /**
   * **完整的可选档位表**（含默认档；顺序无关，本模块会排序去重）。
   *
   * Qoder / Buddy 用这个字段承载目录公布的多档。缺失 = 该模型**没有档位可选**
   * （单档模型），UI 据此不渲染档位列 —— 与「宁缺毋编」同一原则。
   */
  contextTiers?: readonly number[]
}

/** 档位来源：把 `maxContextWindow` 与 `contextTiers` 两个形态摊平成一个候选集。 */
function collectCandidates(tier: ContextTier): number[] {
  const candidates: number[] = []
  if (isPositiveWindow(tier.contextWindow)) candidates.push(tier.contextWindow)
  if (isPositiveWindow(tier.maxContextWindow)) candidates.push(tier.maxContextWindow)
  if (Array.isArray(tier.contextTiers)) {
    for (const value of tier.contextTiers) {
      if (isPositiveWindow(value)) candidates.push(value)
    }
  }
  return candidates
}

/** 正有限数才是窗口（0 / 负数 / NaN / Infinity / 非 number 一概不是）。 */
function isPositiveWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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
export function availableContextTiers(tier: ContextTier | undefined): number[] {
  if (tier === undefined) return []
  const candidates = collectCandidates(tier)
  if (candidates.length === 0) return []
  // `sort` 默认按字符串比较会把 [300000, 1048576] 排成 [1048576, 300000]，
  // 必须显式给数值比较器。
  return [...new Set(candidates)].sort((a, b) => a - b)
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
export function effectiveContextWindow(
  fallback: number | undefined,
  tiers: readonly number[],
  budget: number | undefined,
): number | undefined {
  if (fallback === undefined) return undefined
  if (budget === undefined || budget === fallback) return fallback
  return tiers.includes(budget) ? budget : fallback
}

/**
 * 逐模型**上下文窗口档位**的来源（由各 provider 的适配器实例实现）。
 *
 * ## 为什么由调用方注入，而不是 RPC 自己去捞
 *
 * 目录的持有者是**适配器实例**（它带 TTL 缓存、远端优先、失败回退静态表）。
 * `ctx.llm.listModels()` 帮不上忙：`LlmRuntime.listModels` 会把适配器返回的条目
 * **重建**成 `{provider, id, name, description?, inputModalities?}`，任何额外字段
 * 都在那一层被丢掉，所以窗口档位不可能搭它的车。而 `ctx` 上也没有「按 provider
 * 取适配器」的入口。最省事、也最不可能撒谎的做法，就是让组装方（`src/index.ts`）
 * 把 `register*Llm` 返回的实例直接交过来。
 *
 * 结构类型而非 import 适配器类：RPC 层只消费这一个方法。
 */
export interface ContextTierSource {
  /** 当前生效目录的逐模型档位（模型 id → 档位）。 */
  contextTiers(): Promise<ReadonlyMap<string, ContextTier>>
  /**
   * 按模型 id 查**当前生效目录**里的展示名（可选能力）。
   *
   * 为 Account Hub「显示列表」的黑名单并集回填行服务：被适配器过滤掉的模型
   * `ctx.llm.listModels` 拿不到原始展示名，此前回填行写死 `name = id`（症状一）。
   * 有这个能力时回填行带**人话名字**；查不到（目录没拉到 / 未知 id）返回
   * `undefined`，RPC 层回退为 id —— 与既有行为一致，宁缺毋编。
   *
   * ⚠️ **同步、纯内存查询**：调用它的 RPC 必然已先跑过一次目录拉取
   * （`llm.listModels`），实现方不得在此再次触发网络。
   */
  displayName?(modelId: string): string | undefined
  /**
   * 当前目录来源（可选能力）：`remote` = 远端目录成功过（含 TTL 内的历史成功），
   * `fallback` = 当前播报的是静态兜底表。
   *
   * 只有「远端目录可能整体不可达」的 provider 需要实现（现为 Qoder 两区）；
   * 未实现时 RPC 响应不带 `catalogSource`，客户端不渲染来源提示行。
   */
  catalogSource?(): 'remote' | 'fallback'
}

/**
 * **按 provider 分派**的档位来源注册表。
 *
 * 这是档位机制从「只服务 Trae CN」推广到全部供应商的关键一步：RPC 层不再对
 * provider 名字写特判，而是问注册表「这个 provider 有没有档位来源」。没有来源
 * = 该 provider 不参与档位机制（`model.list` 不带窗口字段、
 * `model.setContextBudget` 一律拒绝）—— 这正是 headless / 测试场景的既定降级。
 *
 * ⚠️ **注册表按 provider id 分键，与 `contextBudgets` 的存储分键同构**：
 * 各 provider 有各自的目录，档位不可互相顶替（写错键会让 A 的档位出现在 B
 * 的面板上，且不报错）。
 */
export interface ContextTierRegistry {
  /** 该 provider 的档位来源；未注册返回 `undefined`（不是抛错）。 */
  sourceFor(provider: string): ContextTierSource | undefined
}

/**
 * 由「provider id → 适配器」的普通对象构造注册表。
 *
 * 值为 `undefined` 的键**直接丢弃**：组装点常常要按条件传适配器（例如某个
 * provider 未接线），让调用方写 `...(x === undefined ? {} : {p: x})` 只会在每个
 * 调用点重复一遍同样的判断。
 */
export function createContextTierRegistry(
  sources: Readonly<Record<string, ContextTierSource | undefined>>,
): ContextTierRegistry {
  const table = new Map<string, ContextTierSource>()
  for (const [provider, source] of Object.entries(sources)) {
    if (source !== undefined) table.set(provider, source)
  }
  return {
    sourceFor: (provider: string) => table.get(provider),
  }
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
export function describeContextTiers(tiers: readonly number[], fallback: number | undefined): string {
  if (fallback === undefined) return '（目录未声明）'
  if (tiers.length <= 1) return `${fallback}（默认）`
  return tiers.map((value) => (value === fallback ? `${value}（默认）` : String(value))).join(' / ')
}
