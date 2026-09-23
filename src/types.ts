import type { DpopPrivateJwk } from './oauth.js'

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
