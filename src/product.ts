/**
 * Buddy 系产品配置。
 *
 * 这些产品同源：共用同一 CLI 内核、同一认证协议（cli-external-link）与同一套
 * ProductProvider 机制，差异全部收敛到这里，使多个 provider 共用一套实现。
 *
 * 实测依据（2026-09-14，逆向各产品 cli/product.json + 真实请求）：
 *
 * | 产品                    | endpoint                    | platform       | genieVersion |
 * |-------------------------|-----------------------------|----------------|--------------|
 * | Buddy CN（腾讯 CodeBuddy 中国版） | https://copilot.tencent.com | ide       | —            |
 * | Buddy（腾讯 WorkBuddy 国际版）    | https://www.workbuddy.ai    | workbuddy-ai | 5.5.2     |
 *
 * ## 命名（2026-09 统一）
 *
 * 显示名与 provider id 都按「产品品牌」而非「历史代号」命名：
 * 中国版 CodeBuddy → `buddy-cn`（导出常量 {@link BUDDY_CN}），
 * 国际版 WorkBuddy → `buddy`（导出常量 {@link BUDDY}）。
 *
 * ⚠️ **协议值不随命名变化**：`productCode` / `attributionName` / `userAgent` /
 * `platform` / `endpoint` / `apiDomain` 是出站身份标识（`X-Product-Code`、
 * `X-Product` / `X-IDE-Name` / `X-IDE-Type`、User-Agent、模型池归属），
 * 腾讯后台按它们归因用量。改显示名时**绝不能**跟着动这些字段 ——
 * 上表里 `buddy-cn` 的 productCode 仍是 `codebuddy`、attributionName 仍是
 * `CodeBuddy`；`buddy` 的仍是 `workbuddy` / `WorkBuddy`。
 *
 * 关于「模型列表为何不能共用」：两者的**路径与响应解析完全相同**
 * （`GET /v3/config` → `data.data.models` / `data.data.agents`），
 * 差异只来自 endpoint —— 不同区域的后端返回不同的模型池
 * （中国版含 glm/hy/deepseek 系，国际版含 claude/gpt/gemini/kimi 系）。
 * 因此 endpoint 必须随产品切换，不能被当成全局常量。
 *
 * 迁移关系（已完成的单一真相源）：
 * 本模块是产品差异取值的**唯一真相源**。历史上的重复字面量已消除 ——
 * `src/buddy.ts` / `src/buddy-auth.ts` / `src/buddy-adapter.ts` 中与产品差异
 * 相关的导出（API_ENDPOINT / PLATFORM / API_DOMAIN / BUDDY_USER_AGENT /
 * BUDDY_PRODUCT_CODE / BUDDY_CREDENTIAL_REF / CHAT_API_BASE）已改为从本模块的
 * BUDDY_CN 配置**派生**，只保留原有的导出签名以兼容既有导入方。
 *
 * 改名（`buddy`→`buddy-cn` / `workbuddy`→`buddy`）是一次**破坏性变更**：
 * 落在 `settings.yaml` 与 `.credentials.yaml` 里的旧 id、旧凭据 ref、
 * 旧 settingsNs 由 `src/provider-rename-migration.ts` 在启动时一次性承接。
 *
 * 依赖方向：`product.ts` 不 import 任何业务模块（见下方 import 列表为空的
 * 约束），只有业务模块单向 import 本模块，故不存在循环依赖；同理，新增产品
 * 差异取值时只在本模块声明，不要在 `buddy*.ts` 里再造字面量。
 */

/** 兜底模型目录中的一个条目（字段对齐远端 `/v3/config` 的 `data.models[]`）。 */
export interface BuddyFallbackModel {
  id: string
  name: string
  /**
   * 上下文窗口 —— **默认档**，即上游实际服务的那个窗口。
   *
   * ⚠️ 语义已从「照抄远端 `maxInputTokens`（最大档）」改为「**默认档**兜底」
   * （2026-09-20 真机快照）：远端对「1M 但默认档更小」的模型成对下发
   * `contextWindow: {defaultLength, supportedLengths}`，而我方 chat 请求体
   * **不带任何档位字段**，故上游按 `defaultLength` 服务；声明值跟着最大档写
   * 会让宿主的自动压缩阈值（0.8 × 窗口）永远追不上真实窗口。远端可用时本表
   * 不参与（远端优先），它只在凭据失效 / 拉取失败时顶替。
   *
   * 档位数据会漂移，本表是快照而非契约；拿不到档位的模型（远端无
   * `contextWindow` 字段，即单档模型）保持 `maxInputTokens`，因为那**就是**
   * 它的服务窗口。
   */
  contextWindow?: number
  /** 是否接受图片输入（对应远端 `supportsImages`）。 */
  supportsImages?: boolean
  /** 可选思考等级（对应远端 `reasoning.supportedEfforts`）。 */
  reasoningEfforts?: readonly string[]
  /** 默认思考等级（对应远端 `reasoning.defaultEffort`）。 */
  defaultReasoningEffort?: string
}

/** 一条「模型族 → User-Agent」覆盖规则。 */
export interface BuddyUserAgentRule {
  /** 模型 id 前缀；命中即采用本规则的 ua。 */
  match: string
  /** 命中后使用的 User-Agent。 */
  ua: string
}

/**
 * 国际版（Buddy）模型线 → UA 分档规则。
 *
 * 判据来自 IDE 客户端形态：国际版产品名是 `WorkBuddy AI`，其客户端出站 UA
 * 遵循官方三段式 `WorkBuddy/<ver> WorkBuddy AI/<ver> CLI/<ver>`。GPT / Gemini
 * 系仅在国际版池中提供，归入国际版形态；国内系模型（glm/hy/kimi/minimax）
 * 虽在国际版池中也可见，但仍沿用国内客户端形态（`WorkBuddy/<ver> WorkBuddy/...`），
 * 与 realm 无关。
 *
 * 常量名保留 `WORKBUDDY_*`：它描述的是**出站 UA 字符串的品牌字样**（协议值），
 * 不是 provider 名 —— provider 名已统一为 `buddy` / `buddy-cn`。
 */
const WORKBUDDY_UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const WORKBUDDY_UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/** 一个 Buddy 系产品的全部差异配置。 */
export interface BuddyProduct {
  /** provider 标识：注册到 ctx.llm 的路由名，也是账号列表的 provider 字段值 */
  id: 'buddy-cn' | 'buddy'
  /**
   * cordis 服务名（`ctx.<serviceName>`）。
   *
   * 为什么**显式给出**而不是机械派生 `${id}Auth`：`buddy-cn` 机械派生会得到
   * 非标识符风格的 `buddy-cnAuth`，与 `TraeCnProduct.serviceName` 是同一先例
   * （见 `src/trae-cn-product.ts` 与 AGENTS.md 的「LLM Provider 约定」）。
   */
  serviceName: string
  /** auth/state 的 platform 查询参数 */
  platform: string
  /**
   * API endpoint（含协议），所有 `/v2/plugin/*`、`/v3/config` 与 chat 请求
   * 都以此为基址。**这是不同区域产品之间最关键的差异**：模型池由它决定。
   */
  endpoint: string
  /**
   * 用于 `X-Domain` 请求头的域名（通常等于 endpoint 的主机名）。
   * 注意与 `endpoint` 分开：历史实现里该头传的是不带协议的域名。
   */
  apiDomain: string
  /** 设置页展示名 */
  displayName: string
  /** X-Product-Code 请求头值 */
  productCode: string
  /**
   * 默认 User-Agent（无按模型分档命中时使用）。
   *
   * 腾讯后台的「使用端」列按出站 UA 归因，故该值必须**含对应产品品牌字样**
   * （`WorkBuddy/...` 或 `CodeBuddyIDE/...`），否则账单显示为 `-`。
   */
  userAgent: string
  /**
   * 按模型族覆盖 User-Agent 的规则表（先命中先返回）。
   *
   * 为什么需要按模型分档：国际版与国内版共用同一后端协议，但模型池分属不同
   * 产品线 —— 实测同一账号下，走 `gpt-*` 系与走 `glm-*` 系时官方客户端形态
   * 并不一致，后台按 UA 归因的「使用端」也随之不同。仅用一个全局 UA 无法让
   * 两类模型都归因正确。
   *
   * 匹配规则：`match` 为模型 id 前缀（大小写敏感，与模型 id 一致）；
   * 空数组或未提供时全部回退到 {@link BuddyProduct.userAgent}。
   */
  userAgentByModelFamily?: readonly BuddyUserAgentRule[]
  /**
   * 归属头名（`X-IDE-Name` / `X-IDE-Type` / `X-Product` 三头共用同一取值）。
   *
   * 注意语义：`X-Product` 是**用量归属名**，不是部署类型 —— 历史实现把它发成
   * `SaaS`（部署类型语义）导致后台归因不到产品，故此处按产品名下发。
   */
  attributionName: string
  /** `X-IDE-Version` 头取值（客户端形态版本号） */
  clientVersion: string
  /** User-Agent 第三段 `CLI/<ver>` 的版本号 */
  cliVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退） */
  defaultCredentialRef: string
  /**
   * 远端模型列表不可用时的**兜底模型目录**。
   *
   * 为什么需要它：各产品的模型池只由服务端按认证上下文下发，而插件的
   * CLI token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能
   * 拿到 13 个别名，拿不到 GPT 系列）。此表是 IDE 自身也在用的机制 ——
   * IDE 的 `product.json` 内置静态模型表，远端配置只是覆盖层。
   *
   * 取值来自 IDE 的本地缓存（`~/.workbuddy-ai/local_storage/*.info`，
   * 由 `WorkbuddyAuthProductCoordinator` 写入），即 IDE 输入框实际使用的清单。
   */
  fallbackModels?: readonly BuddyFallbackModel[]
  /**
   * 登录 URL 是否需要追加 `version` 与 `loginSessionId`。
   * Buddy CN 不需要；Buddy（国际版）需要（对齐 workbuddy-desktop 认证配置）。
   */
  appendSessionParams: boolean
  /** 追加到登录 URL 的版本号（appendSessionParams 为 true 时使用） */
  pluginVersion?: string
}

/**
 * Buddy CN（腾讯 CodeBuddy 中国版），platform = ide。
 *
 * 本配置是产品差异取值的唯一真相源：`src/buddy.ts` / `src/buddy-auth.ts` /
 * `src/buddy-adapter.ts` 中同名的历史常量（PLATFORM / BUDDY_PRODUCT_CODE /
 * BUDDY_USER_AGENT / BUDDY_CREDENTIAL_REF / API_ENDPOINT / API_DOMAIN /
 * CHAT_API_BASE）均由此处派生，不再是独立字面量。
 */
/**
 * Buddy CN（中国版）的内置模型目录。
 *
 * 数据来源：`/v3/config` 的 `craft` agent 白名单，并**逐个用真实请求验证可用**
 * （`POST /v2/chat/completions`，stream 模式）。只收录实测返回可用的模型 ——
 * 远端 `data.models` 里另有一批 `code=11102 service info not found` 的条目
 * （glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5/k2.8-preview、hunyuan-* 等），
 * 列进选择器只会让用户选中后报错，故一律不收录。
 *
 * ⚠️ `contextWindow` 是**默认档**兜底（不是 `maxInputTokens`）：2026-09-20 真机
 * 快照显示本表里全部 1M 条目（hy4-preview / glm-5.3 / glm-5.3-flash / glm-5.2 /
 * kimi-k3-1 / deepseek-v4.1-flash / deepseek-v4-pro）远端下发的
 * `contextWindow.defaultLength` 都是 **300K**（`supportedLengths` = [300K, 1M]），
 * `minimax-m3` 是 300K（[300K, 512K]）。故本表按默认档写；未实测到档位的条目
 * （hy3 / hy3-x / glm-5.1 / glm-5v-turbo / kimi-k2.7 / kimi-k2.6）**保持原值不动**
 * —— 它们不是 1M 条目，没有「最大档 vs 默认档」之分。档位数据会漂移，本表是
 * 快照而非契约；远端可用时以远端为准（见 `BuddyAdapter.reconcileWithFallback`）。
 */
const BUDDY_CN_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  {
    id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 300_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 300_000, supportsImages: true, reasoningEfforts: ['medium'] },
]

export const BUDDY_CN: BuddyProduct = {
  id: 'buddy-cn',
  serviceName: 'buddyCnAuth',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  displayName: 'Buddy CN',
  // ⚠️ 协议值：X-Product-Code 仍为 'codebuddy'（腾讯后台按它归因，别跟着显示名改）。
  productCode: 'codebuddy',
  userAgent: 'CodeBuddyIDE/1.106.1',
  // 中国版只有一条产品线，无需按模型分档：全部模型沿用 IDE UA。
  userAgentByModelFamily: [],
  // ⚠️ 协议值：X-Product / X-IDE-Name / X-IDE-Type 仍为 'CodeBuddy'。
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  cliVersion: '2.137.1',
  defaultCredentialRef: 'BUDDY_CN_ACCESS_TOKEN',
  appendSessionParams: false,
  fallbackModels: BUDDY_CN_FALLBACK_MODELS,
}

/**
 * Buddy（腾讯 WorkBuddy 国际版 / WorkBuddy AI）的内置模型目录。
 *
 * 数据来源：IDE 的本地缓存 `~/.workbuddy-ai/local_storage/*.info`
 * （`WorkbuddyAuthProductCoordinator` 写入的 ProductManager 合并结果），
 * 即 IDE 模型选择器实际展示的清单与元数据。
 *
 * 顺序即 IDE 的展示顺序（`cli` agent 白名单顺序），不要随意重排。
 *
 * ⚠️ `contextWindow` 是**默认档**兜底（不是 `maxInputTokens`）：2026-09-20 真机
 * `/v3/config` 快照里 `hy4-preview-f` / `deepseek-v4.1-flash` 的
 * `contextWindow.defaultLength` 是 **300K**、`gpt-6-astra` 是 **400K**
 * （`hy4-preview` 是 200K，但它不在本表）。⚠️ **其余 8 个 1M 条目一律保持 1M**
 * （`gpt-5.6-sol` / `-terra` / `-luna`、`gpt-5.5`、`gemini-3.5-flash`、`glm-5.3`、
 * `glm-5.2`、`kimi-k3`）：真机确认它们**不带 `contextWindow` 字段**，即**单档
 * 模型** —— 没有「最大档 vs 默认档」之分，`maxInputTokens` 就是服务窗口，砍它
 * 等于谎报容量。非 1M 条目（`gpt-5.4` 272K、`kimi-k2.6` 256K 等）同样不动。
 */
const BUDDY_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, supportsImages: true },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, supportsImages: true },
  {
    id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 300_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high' },
  {
    id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 400_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'] },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
]

/**
 * Buddy（腾讯 WorkBuddy 国际版 / WorkBuddy AI），platform = workbuddy-ai。
 *
 * 逆向自 `C:\Users\Jet\AppData\Local\Programs\WorkBuddyAI`（5.5.2）的 cli/product.json：
 * - `applicationName` = "workbuddy-ai"
 * - `endpoint` = "https://www.workbuddy.ai"（**与中国版不同**，模型池随区域变化）
 * - `authentication.attributes.platform` = "workbuddy-ai"
 * - `prefixPath` = "/plugin"（与中国版相同）
 *
 * 该产品**没有**每日签到积分接口（内核中只有 `/v2/billing/meter/get-dosage-notify`），
 * 因此 Account Hub 不为其渲染「一键领取积分」按钮；积分领取在 Buddy CN 侧完成。
 *
 * ⚠️ provider id 已从 `workbuddy` 改为 `buddy`；`productCode` / `attributionName` /
 * `platform` / `endpoint` / UA 这些**出站协议值一个字符都没变**。
 */
export const BUDDY: BuddyProduct = {
  id: 'buddy',
  serviceName: 'buddyAuth',
  platform: 'workbuddy-ai',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  displayName: 'Buddy',
  // ⚠️ 协议值：X-Product-Code 仍为 'workbuddy'。
  productCode: 'workbuddy',
  // 默认档：国际版产品形态（无按模型命中时使用）。
  userAgent: WORKBUDDY_UA_INTL,
  userAgentByModelFamily: [
    // 国际版独有模型线（GPT / Gemini / Claude 系）→ 国际版形态。
    { match: 'gpt-', ua: WORKBUDDY_UA_INTL },
    { match: 'gemini-', ua: WORKBUDDY_UA_INTL },
    { match: 'claude-', ua: WORKBUDDY_UA_INTL },
    // 国内系模型（glm / hy / kimi / minimax）→ 国内客户端形态。
    { match: 'glm-', ua: WORKBUDDY_UA_CN },
    { match: 'hy', ua: WORKBUDDY_UA_CN },
    { match: 'kimi-', ua: WORKBUDDY_UA_CN },
    { match: 'minimax-', ua: WORKBUDDY_UA_CN },
  ],
  // ⚠️ 协议值：X-Product / X-IDE-Name / X-IDE-Type 仍为 'WorkBuddy'。
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  cliVersion: '5.5.2',
  defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
  appendSessionParams: true,
  pluginVersion: '5.5.2',
  fallbackModels: BUDDY_FALLBACK_MODELS,
}

/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export const ALL_PRODUCTS: readonly BuddyProduct[] = [BUDDY_CN, BUDDY]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function productById(id: string): BuddyProduct | undefined {
  return ALL_PRODUCTS.find((product) => product.id === id)
}
/**
 * 按模型 id 解析该产品应使用的 User-Agent（按模型族分档）。
 *
 * 命中规则：`userAgentByModelFamily` 中**先命中先返回**（`match` 为前缀）。
 * 未命中任何规则时回退到 `product.userAgent`。这条回退链保证新模型上线时
 * 仍有一个确定的、含产品品牌字样的 UA，不会退化成框架默认的 harness UA。
 *
 * @param product - 产品配置
 * @param model - 模型 id（如 `gpt-5.6-sol` / `glm-5.2`）
 */
export function resolveUserAgent(product: BuddyProduct, model: string): string {
  for (const rule of product.userAgentByModelFamily ?? []) {
    if (model.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}
