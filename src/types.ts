import type { DpopPrivateJwk } from './oauth.js'
// 各产品配置的 id 常量（全部 `import type`：只为 `typeof` 取类型，运行期完全擦除，
// 不引入任何实际依赖，也不构成运行期循环）。
import type { PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js'
import type { BUDDY, BUDDY_CN } from './product.js'
import type { LOBSTERAI } from './lobsterai-product.js'
import type { TRAE_CN } from './trae-cn-product.js'
import type { QODER, QODER_CN } from './qoder-product.js'

/**
 * 本插件七个 LLM provider 的 id 联合（**共享类型层的唯一真相源**）。
 *
 * ## 为什么是「并集」而不是逐值推导
 *
 * 七个 id 分散在四份产品配置里，且声明形态**不一致**：
 *
 * | 来源 | 声明 | `typeof X.id` |
 * |---|---|---|
 * | `CODEARTS_PROVIDER`（`src/llm-adapter.ts`） | `const PROVIDER = 'codearts'` | `'codearts'`（窄） |
 * | `LOBSTERAI.id` / `TRAE_CN.id` | 各自接口里写死单个字面量 | 窄 |
 * | `BUDDY_CN.id` / `BUDDY.id` | `BuddyProduct.id: 'buddy-cn' \| 'buddy'` | **宽联合** |
 * | `QODER.id` / `QODER_CN.id` | `QoderProduct.id: 'qoder' \| 'qoder-cn'` | **宽联合** |
 *
 * ⚠️ **后两组是宽联合**：`typeof QODER.id` 单独取出来是 `'qoder' | 'qoder-cn'`
 * （国际版与国内版互相不可区分），`typeof BUDDY_CN.id` 同理。故**不能**把本类型
 * 简化成「某个配置的 id 类型」—— 那会丢掉 region 区分或漏掉其它产品线。七路并集
 * 里宽联合各自贡献两个成员、重复项自动合并，最终恰好收敛为下面这七个。
 *
 * ## 用途：两套 provider 分键映射的**组装点**保护
 *
 * Account Hub 有两套按 provider id 分键的映射（档位注册表与模型目录适配器），
 * 此前都是 `Record<string, …>`：**键拼错不报错**，只表现为该 provider 静默退化
 * （模型列表不显示档位 / 关闭项退回裸 id）。改用 `Partial<Record<ProviderId, …>>`
 * 后，组装点（`src/index.ts`）的对象字面量会被 excess property check 拦下。
 *
 * ⚠️ **两道限制是刻意的**：
 * - `Partial` 允许子集 —— 档位注册表本来就只登记有档位数据源的 provider
 *   （5/7），**漏登记不报错**，由 `registerAccountHubRpc` 入口的运行时 warn 兜底；
 * - 仅对**对象字面量**生效 —— 先赋给 `Record<string, …>` 变量再传进来就绕过了
 *   （故 `src/index.ts` 的映射注解必须与本类型同步收窄）。
 */
export type ProviderId =
  | typeof CODEARTS_PROVIDER
  | typeof BUDDY_CN.id
  | typeof BUDDY.id
  | typeof LOBSTERAI.id
  | typeof TRAE_CN.id
  | typeof QODER.id
  | typeof QODER_CN.id

/**
 * 一个可配置 provider 目录项的 settings 地址（namespace + 分槽路径）。
 *
 * ## 为什么是一个「值对象」而不是两个独立字段
 *
 * namespace 与 path **必须成对**：0.1.6 的地址是 `{ ns: 'llm-<id>', path: [] }`
 * （整节就是该 provider 的 profile），0.1.7 的是
 * `{ ns: <entry id>, path: ['providers', <id>] }`（整节是插件的 `providers` 字典、
 * 每个 provider 占一个槽）。两者只有配对出现才自洽 —— 拆成两个可选字段就允许
 * 「新 namespace + 老空 path」这种半迁移状态被静默接受，而它的表现是模型设置页
 * 读到 undefined 的 profile（**不报错**，只是配置项凭空消失）。
 *
 * ## 谁算、谁用
 *
 * `src/index.ts` 在 `apply()` 里**探测一次**（见 `detectSettingsContract`），
 * 把结果按 provider 现算成地址，经各 `registerXxxLlm` 的 `settingsAddress` 选项
 * 传入。适配器自己**不做探测**、也不认识契约版本 —— 它只把地址原样交给
 * `ctx.llm.registerConfigurableProviders`，从而保持可单测（单测直接给地址或省略）。
 */
export interface LlmSettingsAddress {
  /** settings namespace：0.1.6 是 `llm-<provider>`，0.1.7 是 profile entry id。 */
  settingsNs: string
  /** 从该 namespace 的节根到**本 provider 的 profile 对象**的路径。 */
  settingsPath: readonly string[]
}

/** snap-manager ticket 端点响应的传输格式。 */
export interface CodeArtsCredentialResponse {
  credential?: {
    access?: string
    secret?: string
    securitytoken?: string
    securityToken?: string
    expires_at?: string
    expiresAt?: string
  }
  result?: {
    accessKeyId?: string
    secretAccessKey?: string
    securityToken?: string
    expiration?: string
    expiresAt?: string
  }
  domain_id?: string
  user_id?: string
  user_name?: string
  error_code?: string
  error_msg?: string
}

/**
 * ========================================
 * ProviderAccountEntry 与多账号相关类型
 * ========================================
 */

/** 每个模型的重置时间信息 */
export interface RateLimitInfo {
  /** 模型 ID（如 'deepseek-v4-flash'） */
  modelId: string
  /** 重置时间戳（毫秒）；0 或缺失 = 不在重置期 */
  resetAtMs: number
}

/** 账号索引条目（存于 ctx.settings，非 credentials） */
export interface ProviderAccountEntry {
  /** 账号唯一标识：{provider}-{shortid}（如 'codearts-a1b2c3d4'） */
  id: string
  /** provider 名称：'codearts' | 'buddy-cn' | 'buddy' | 'lobsterai' | 'trae-cn' */
  provider: string
  /** 用户可读昵称 */
  nickname: string
  /** 是否启用（停用不参与自动切换） */
  enabled: boolean
  /** 对应的 credential ref 名称：{PROVIDER}_ACCOUNT_{UUID_SHORT}（如 'CODEARTS_ACCOUNT_A1B2C3D4'） */
  credentialRef: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 凭据过期时间（毫秒时间戳），用于展示 */
  expiresAt?: number
  /** 是否可静默续期 */
  refreshable: boolean
  /** 每个模型的重置时间，key=模型ID（毫秒时间戳） */
  modelRateLimits?: Record<string, number>
}

/** 账号详细状态（返回给 Client 展示） */
export interface ProviderAccountStatus extends ProviderAccountEntry {
  /** 最近刷新错误 */
  refreshError?: string
  /** 来源（env/file 等） */
  source?: string
}

/** Account Hub 在 ctx.settings 中的 schema */
export interface AccountHubConfig {
  accounts: ProviderAccountEntry[]
  /**
   * 模型黑名单：provider id → 模型 id → true。
   *
   * **黑名单制**：只有键存在且为 true 的模型被隐藏，未记录的模型默认打开。
   */
  disabledModels?: Record<string, Record<string, boolean>>
}

/** RPC 端点请求/响应类型 */
export interface RpcListAccountsRequest {
  provider: string
}
export interface RpcListAccountsResponse {
  accounts: ProviderAccountStatus[]
}

export interface RpcCreateAccountRequest {
  provider: string
  /**
   * PAT 粘贴式登录（**只有 Qoder**）携带的个人访问令牌。
   *
   * 其余六个 provider 全是浏览器登录（两段式：宿主回 `loginUrl`、客户端开窗、
   * 再轮询 `login.poll`），本字段缺席。Qoder 没有浏览器登录流程 ——
   * 用户去官方 Integrations 页面签发 PAT 后粘贴回来，宿主当场打一次 exchange
   * 验证并落凭据，**没有第二段**（不存在「等用户操作 10 分钟」的手势窗口）。
   *
   * ⚠️ 该字段是**凭据本体**：任何日志/错误信息都不得回显它（见
   * `src/qoder-auth.ts` 的 `loginWithPat`）。
   */
  pat?: string
}
export interface RpcCreateAccountResponse {
  accountId: string
  loginUrl: string
}

export interface RpcPollLoginRequest {
  accountId: string
  provider: string
}
export interface RpcPollLoginResponse {
  done: boolean
  success?: boolean
  error?: string
}

export interface RpcUpdateAccountRequest {
  accountId: string
  patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled'>>
}

export interface RpcDeleteAccountRequest {
  accountId: string
}

/**
 * RPC: 重排某 provider 的账号顺序（Account Hub 拖拽排序）。
 *
 * 传该 provider **全部**账号 id 的目标顺序；服务端据此重写数组顺序，
 * 该顺序即自动选号/限流换号的候选优先级（见 `AccountPool.reorderAccounts`）。
 *
 * ⚠️ 必须是一个**排列**：少了 / 多了 / 重复的 id 都会被拒绝（不静默容忍）。
 */
export interface RpcReorderAccountsRequest {
  provider: string
  /** 该 provider 全部账号 id，按目标顺序排列。 */
  orderedIds: string[]
}

export interface RpcRefreshAccountRequest {
  accountId: string
}
export interface RpcRefreshAccountResponse {
  success: boolean
  error?: string
}

/**
 * ========================================
 * 限流标记重测 / 重置
 * ========================================
 */

/** 单个模型的探测结果。 */
export interface ProbeModelResult {
  modelId: string
  ok: boolean
  /** 失败时的可读原因（限流文案 / HTTP 状态等）。 */
  message?: string
}

/** 单个账号的重测结果。 */
export interface ProbeAccountResult {
  accountId: string
  nickname?: string
  /** 探测的模型数；0 表示该账号没有限流标记，无需重测。 */
  tested: number
  /** 确认恢复正常、标记已清除的模型。 */
  cleared: string[]
  /** 仍受限的模型。 */
  stillLimited: ProbeModelResult[]
  /** 探测过程中的异常（凭据不可用、网络失败等）。 */
  error?: string
}

/** 重测单个账号（使用该账号自己的凭据发送探测消息）。 */
export interface RpcRetestAccountRequest {
  accountId: string
}
/** 重测该 provider 下的全部账号（**包含已停用账号**）。 */
export interface RpcRetestAllRequest {
  provider: string
}
/** 重测结果（单账号与全部共用同一响应结构）。 */
export interface RpcRetestResponse {
  accounts: ProbeAccountResult[]
  /** 汇总：清除的限流标记总数。 */
  clearedCount: number
}

/** 重置单个账号的限流标记（不测试，直接清除）。 */
export interface RpcResetAccountRequest {
  accountId: string
}
/** 重置该 provider 下全部账号的限流标记（**包含已停用账号**）。 */
export interface RpcResetAllRequest {
  provider: string
}
/** 重置结果。 */
export interface RpcResetResponse {
  /** 清除的限流标记总数。 */
  clearedCount: number
  /** 实际被清除了标记的账号数。 */
  accountCount: number
}

/**
 * ========================================
 * 每日签到（积分领取）
 * ========================================
 */

/** RPC: 查询签到状态请求 */
export interface RpcCreditsStatusRequest {
  provider: string
}
/** 单个账号的签到状态 */
export interface RpcCreditsAccountStatus {
  accountId: string
  nickname: string
  /** 状态查询失败（网络错误/凭据损坏）时为 null */
  status: import('./credits.js').CheckinStatus | null
}
/** RPC: 查询签到状态响应 */
export interface RpcCreditsStatusResponse {
  accounts: RpcCreditsAccountStatus[]
}

/** RPC: 一键领取积分请求 */
export interface RpcCreditsClaimAllRequest {
  provider: string
}
/** 单个账号的领取结果 */
export interface RpcCreditsClaimAccountResult {
  accountId: string
  nickname: string
  outcome: import('./credits.js').ClaimOutcome
}
/** 领取汇总 */
export interface RpcCreditsClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  /**
   * 服务端此刻暂不受理的账号数（`ClaimOutcome` 的 `unavailable`，目前只有
   * Trae CN 的 `9074`）。
   *
   * **刻意独立计数而不并入 `failed`**：两者对用户的含义相反 —— `failed` 是
   * 「你需要做点什么」（重新登录 / 校准设备头），`unavailable` 是「什么都不用做，
   * 4 小时后的自动 sweep 会重试」。并进 `failed` 会让界面报出一个不需要行动的
   * 「失败」，用户只会白折腾一轮。
   */
  unavailable: number
  /**
   * **签到异常**的账号数（`ClaimOutcome` 的 `abnormal`：服务端响应成功，但签到前后
   * 余额没有变多）。
   *
   * **独立计数而不并入 `claimed`，也不并入 `failed`**：
   * - 并进 `claimed` 就是本次改动要修的那个缺陷 —— 界面报「领取成功 +0」而用户
   *   永远查不出为什么（余额数字与「成功」二字互相矛盾）；
   * - 并进 `failed` 会让用户去排查凭据/设备，而这三种东西都是好的（服务端回了
   *   code:0）；它的正确动作与 `unavailable` 同款：**什么都不做，等自动重试**。
   */
  abnormal: number
  /**
   * **无法判定**的账号数（`ClaimOutcome` 的 `undetermined`：Qoder 系空活动列表）。
   *
   * 既不能并进 `already-claimed`（那会**伪造一次签到** —— 宿主据此写状态、整个
   * 周期不再重试，而该账号可能一分没领），也不能并进 `failed`（没有失败可报、
   * 用户无事可做）。独立计数 + **不写状态** ⇒ 下一轮 sweep 自动重试。
   */
  undetermined: number
  failed: number
}
/** RPC: 一键领取积分响应 */
export interface RpcCreditsClaimAllResponse {
  results: RpcCreditsClaimAccountResult[]
  summary: RpcCreditsClaimSummary
}

/**
 * ========================================
 * 积分余额（Credits Balance）
 * ========================================
 */

/** RPC: 查询某 provider 下全部账号的积分余额请求 */
export interface RpcCreditsBalancesRequest {
  provider: string
}

/**
 * 单个账号的积分余额。
 *
 * 与签到状态的设计取舍不同：余额**带回每个包的明细**而不只是总数 ——
 * 用户看到「347.87」时通常还想知道它由哪些包构成、各自何时到期（实测一个
 * 账号常同时有「Bonus Pack」与「Free Plan Subscription」两个周期不同的包）。
 * 明细只有几项，一次带回比让前端再发一次请求更划算。
 */
export interface RpcCreditsBalanceAccount {
  accountId: string
  nickname: string
  /** 余额查询失败（网络/凭据/响应异常）时为 null —— 与「余额为 0」严格区分。 */
  balance: import('./credits.js').CreditBalance | null
  /** 查询失败的原因，供 UI 提示（成功时为 undefined）。 */
  error?: string
}

/** RPC: 查询积分余额响应 */
export interface RpcCreditsBalancesResponse {
  accounts: RpcCreditsBalanceAccount[]
}

/**
 * ========================================
 * 模型列表可见性（黑名单开关）
 * ========================================
 */

/** RPC: 列出某 provider 的模型请求 */
export interface RpcModelListRequest {
  provider: string
}

/**
 * 单个模型在设置页的展示条目。
 *
 * `disabled` 由服务端按黑名单回填，`name` 是适配器播报的展示名 ——
 * 两者都取自**权威来源**（适配器的 listModels），而不是前端自己再拼一份
 * 模型清单，否则远端模型池变化时设置页与对话框会显示两套不同的列表。
 */
export interface RpcModelListEntry {
  id: string
  name: string
  /** true = 已关闭（不出现在对话框的模型选择里）。 */
  disabled: boolean
  /**
   * 该模型**目录公布的默认窗口**（token 数；未设置预算时向宿主声明的值）。
   *
   * 只有**有档位数据的 provider** 会带（Trae CN 的 `context_window_tokens.dev`、
   * Qoder 的 `default_context_window`、Buddy 的 `min(maxInputTokens, 档位表最大档)`）。
   * 其余 provider（CodeArts / LobsterAI…）的适配器不产出窗口元数据。
   * 缺省 = 无窗口信息，UI 不渲染档位列。
   */
  contextWindow?: number
  /**
   * 该模型**目录公布的 Max 档**（token 数）。
   *
   * ⚠️ **Trae CN 两档形态专有**：它的目录把两档分成 `dev` / `max` 两个字段，故
   * 这里也只带两个字段。其余 provider 用 {@link contextTiers} 承载整张表。
   * 只在**严格大于 {@link contextWindow}** 时出现（判据在目录解析侧）。
   */
  maxContextWindow?: number
  /**
   * 该模型**可选的全部上下文窗口档位**（升序去重，**只在两个及以上档位时**出现）。
   *
   * 这是「档位选择器推广到全部供应商」后客户端的**主数据源**：每项渲染一个 radio，
   * 档数不限（Qoder 真机 `[200000, 400000, 1000000]` 三档、Buddy 两档）。
   * 默认档必在列表内（Host 侧归一化时并入），客户端据此标「默认」。
   *
   * 缺省 = 无档位可选（单档模型 / 目录未达）—— UI 不渲染档位列。
   */
  contextTiers?: number[]
  /**
   * 当前**已存储的预算值**（`undefined` = 用默认档）。
   *
   * 规格只点明了上面几个窗口字段，这个字段是为 UI 补的：档位单选需要知道
   * 「现在选中的是哪一个」，否则每次打开面板都只能显示成默认档。
   * 它要么等于 {@link contextWindow}（默认档）要么等于 {@link contextTiers} 里的
   * 某个非默认档，不会出现别的值 —— 写入侧（`model.setContextBudget`）就是这么校验的。
   */
  contextBudget?: number
}

/** RPC: 列出某 provider 的模型响应 */
export interface RpcModelListResponse {
  models: RpcModelListEntry[]
  /**
   * 目录来源（C3，只有 Qoder 两区会带）：`remote` = 远端目录成功过（含 TTL 内
   * 的历史成功），`fallback` = 当前播报的是**静态兜底表**（远端不可达）。
   *
   * 缺省 = 该 provider 的适配器未实现此能力（其余 provider 不区分来源，
   * 客户端对缺省不渲染任何提示行）。
   */
  catalogSource?: 'remote' | 'fallback'
}

/** RPC: 打开/关闭某个模型请求 */
export interface RpcModelSetDisabledRequest {
  provider: string
  modelId: string
  disabled: boolean
}

/** RPC: 打开/关闭某个模型响应（回传写入后的完整黑名单，便于前端校验） */
export interface RpcModelSetDisabledResponse {
  provider: string
  disabledModels: Record<string, boolean>
}

/**
 * RPC: 设置某个模型的上下文窗口档位请求。
 *
 * `window` 必须是**该模型目录公布的档位之一**（任意档，不限于两档）。省略
 * （或等于默认档）= **恢复默认档**（清除预算），而不是「设成默认档」—— 两者在
 * 存储上刻意区分（见 `AccountPool.writeContextBudget`）。
 */
export interface RpcModelSetContextBudgetRequest {
  provider: string
  model: string
  window?: number
}

/** RPC: 设置上下文窗口档位响应（回传写入后的预算值，`undefined` = 已恢复默认档）。 */
export interface RpcModelSetContextBudgetResponse {
  provider: string
  model: string
  /** 当前存储的预算值；JSON 里缺省即「已恢复默认档」。 */
  contextBudget?: number
}

/**
 * ========================================
 * 自动路由（配置面）
 * ========================================
 *
 * 纯逻辑与全部判据的唯一真相源是 `src/auto-route.ts`（含 `AutoRouteConfig` /
 * `AutoRouteDefinition` / 默认值与校验函数）。这里**重导出**那两个类型而不是另写
 * 一份同形接口：两份定义一旦漂移，RPC 的落盘形态与适配器读取的形态就会静默错位。
 */

/** 自动路由配置与自动模型定义（见 `src/auto-route.ts`）。 */
export type { AutoRouteConfig, AutoRouteDefinition, AutoRouteEntry } from './auto-route.js'

/**
 * RPC: `autoroute.get` 请求。
 *
 * **无字段**：自动路由是全局配置（不属于任何 provider），故没有 `provider` 参数
 * —— 不要为「形态统一」照抄 consumption.get 的 `{ provider }`，那会让客户端
 * 以为配置是按 provider 分的。
 */
export type RpcAutoRouteGetRequest = Record<string, never>

/** RPC: `autoroute.get` 响应（永远是完整的权威配置，不会是 undefined）。 */
export interface RpcAutoRouteGetResponse {
  enabled: boolean
  models: import('./auto-route.js').AutoRouteDefinition[]
}

/**
 * RPC: `autoroute.set` 请求（**部分更新**）。
 *
 * 两个字段都可选：界面上的总开关与自动模型列表彼此独立，各自只发自己那一个。
 *
 * ⚠️ `models` 是**整组替换**语义（不是逐条合并）：定义有序、`entries` 的顺序
 * 就是候选优先级，逐条合并无法表达「删除一条」与「挪到队首」。客户端提交的是
 * 完整的目标列表。
 */
export interface RpcAutoRouteSetRequest {
  enabled?: boolean
  models?: import('./auto-route.js').AutoRouteDefinition[]
}

/** RPC: `autoroute.set` 响应（回传写入后的**权威**配置，供客户端对齐界面状态）。 */
export interface RpcAutoRouteSetResponse {
  enabled: boolean
  models: import('./auto-route.js').AutoRouteDefinition[]
}

/**
 * RPC: `autoroute.catalog` 请求。
 *
 * **无字段**：与 `autoroute.get` 同款 —— 目录是**全部已注册 provider** 的聚合，
 * 不属于任何单个 provider，故没有 `provider` 参数（编辑器一次拉全量，再本地筛选）。
 */
export type RpcAutoRouteCatalogRequest = Record<string, never>

/**
 * 目录里的一个模型条目。
 *
 * ⚠️ 刻意**只带 `{ id, name }`**：宿主 `LlmModelInfo` 还有 `provider` /
 * `description` / `inputModalities`，编辑器一个都用不到；照抄出去等于把宿主的
 * 字段名变成客户端的隐性契约，宿主加字段时这里会静默跟着变。
 */
export interface RpcAutoRouteCatalogModel {
  id: string
  name: string
}

/** 目录里的一个供应商（含它当前播报的全部模型）。 */
export interface RpcAutoRouteCatalogProvider {
  id: string
  name: string
  /** 该 provider 的模型列表；目录拉取失败时为**空数组**（不是省略字段）。 */
  models: RpcAutoRouteCatalogModel[]
}

/**
 * RPC: `autoroute.catalog` 响应（供应商 × 模型两级目录）。
 *
 * ⚠️ **不含 `auto-route` 自身**：把虚拟 provider 列进它自己的候选，用户就能配出
 * 「自动路由委派给自动路由」的无限递归（与 `AutoRouteEntry.provider` 的排除判据
 * 同源，见 `src/auto-route.ts` 的 `AUTO_ROUTE_PROVIDER_ID`）。
 */
export interface RpcAutoRouteCatalogResponse {
  providers: RpcAutoRouteCatalogProvider[]
}

/**
 * RPC: `autoroute.model-info` 请求（单个 provider/model 的档位查询）。
 *
 * 档位**不随目录一起返回**：档位要逐个模型问适配器（`resolveModelInfo`），
 * 全量拉取会把一次面板打开变成几十次适配器查询，故编辑器按需（选中某模型时）拉。
 */
export interface RpcAutoRouteModelInfoRequest {
  provider: string
  model: string
}

/**
 * RPC: `autoroute.model-info` 响应。
 *
 * 两个字段都可选且**可以同时缺席**：该模型没有档位（如 CodeArts 全系没有
 * `reasoning` 元数据）时返回 `{}` —— 这是**正常结果**而不是错误，编辑器据此
 * 显示「该模型无档位可选」。
 */
export interface RpcAutoRouteModelInfoResponse {
  /** 可选档位 id（适配器偏好顺序）。 */
  efforts?: string[]
  /** 适配器配置的默认档；缺席 = 用 provider 自己的默认。 */
  defaultEffort?: string
}

/** 存储在 CODEARTS_ACCESS_TOKEN 下的归一化临时凭据。 */
export interface CodeArtsCredential {
  access_key_id: string
  secret_access_key: string
  security_token: string
  expires_at: string
  domain_id?: string
  user_id?: string
  user_name?: string
  /** 刷新令牌（新式 IAM OAuth 流程签发；缺失表示旧 ticket 凭据，不可静默刷新）。 */
  refresh_token?: string
  /** PKCE 验证器，刷新换取时与 refresh_token 一起提交。 */
  code_verifier?: string
  /** DPoP ES256 私钥 JWK（随凭据持久化，刷新换取时签发 DPoP JWS）。 */
  dpop_private_key_jwk?: DpopPrivateJwk
  /** 模型速率限制/重置时间（框架层附加的运行时元数据，刷新凭据时需保留）。 */
  model_rate_limits?: Record<string, unknown>
}

/** 一次登录流程的结果：已存储的凭据值及其过期时间。 */
export interface LoginFlowResult {
  /** 原始令牌（token/fingerprint 分支）或 JSON.stringify(CodeArtsCredential)（轮询分支）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
}

/** runLoginFlow 和 startCallbackServer 接受的选项。 */
export interface LoginFlowOptions {
  /** pollForCredential 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: (url: string) => void | Promise<void>
  /** 轮询尝试次数上限；默认为 120。 */
  maxAttempts?: number
  /** 登录流程选择：'oauth'（默认）或 'ticket'（旧流程回退）。 */
  flow?: 'oauth' | 'ticket'
}

/**
 * Buddy CN 凭据，存储在 BUDDY_CN_ACCESS_TOKEN 下。
 * 定义与解析工具放在 buddy.ts（与 Buddy 协议常量同处一处）。
 */
export type { BuddyCredential } from './buddy.js'
