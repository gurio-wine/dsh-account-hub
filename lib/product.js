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
const WORKBUDDY_UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2';
const WORKBUDDY_UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2';
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
 * （glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5、hunyuan-* 等），
 * 列进选择器只会让用户选中后报错，故一律不收录。
 *
 * ⚠️ **`kimi-k2.8-preview` 曾被上一条理由误伤**：旧注释把它列为
 * 「service info not found」而排除，但 2026-09 实测它**可正常调用且能看图**
 * （纯红图问答答出「红色」），远端两端点也都在下发 —— 故已按上游 39c66ac 补录。
 * 「不在白名单」与「实测不可用」是两件事，别再据前者推断后者。
 *
 * ⚠️ `contextWindow` 是**最大档**兜底（2026-09-21 口径）：真机单变量实测
 * `glm-5.3` 在 prompt 320K / 500K / 900K / 1.0M token **全部正常服务**，1.2M 才
 * 报 `code:11115` ⇒ `defaultLength`(300K) 是 UI 默认值而非硬限，真实窗口 = 最大档
 * = `supportedLengths` 最大档 = `maxInputTokens`。故本表按最大档写；真机下发过档位
 * 对的条目（含 `minimax-m3`，其档位表最大档是 **512K**）取 `min(maxInputTokens,
 * 档位表最大档)`。未下发档位对的条目（`hy3` / `glm-5.1` / `kimi-k2.6` 等）本就是
 * 单档模型，`maxInputTokens` 即服务窗口，保持原值。档位数据会漂移，本表是快照
 * 而非契约；远端可用时以远端为准（见 `BuddyAdapter.reconcileWithFallback`）。
 *
 * ⚠️ `maxOutputTokens` 同样来自 2026-09-19 真机实测（`maxOutputTokens` 字段）。
 * 2026-09-21 移植上游 39c66ac 时补录了 `deepseek-v4-flash`(50k) 与
 * `kimi-k2.8-preview`(64k) 两条 —— 它们原先不在本表，导致远端已在正常下发的模型
 * 被 `reconcileWithFallback` 丢弃。补录时按上游逐 id 抄值（本仓无法重跑该实测）。
 */
const BUDDY_CN_FALLBACK_MODELS = [
    {
        id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
        reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
        reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        // maxOutputTokens 实测（2026-09-19）：scoped 端点 128000、/v3/config 131072。
        // 取 **128000**（两端点的较小者）：它是服务端真正接受的额度；131072 只是
        // /v3/config 的声明值。远端可用时仍以远端下发值为准，本字段只在远端缺失时补位。
        id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        // 2026-09 补录（移植上游 39c66ac）：远端 /v3/config 与 scoped 端点均返回该模型，
        // 且实测能看图（纯红图问答答出「红色」）。它不在 craft/cli agent 白名单里，但可
        // 正常调用，也是适配器 DEFAULT_MODEL 的取值。
        //
        // 档位沿用适配器静态表 REASONING_EFFORTS 的既有取值 [low,high,max]（该表有实测
        // 依据：三档会显著改变返回的 reasoning_content 长度）。⚠️ 上游 /v3/config 声明的
        // 是 [low,high,xhigh]，与本表不一致；实测服务端对 low/medium/high/xhigh/max 一律
        // 返回 200（不报非法参数），无法据此判定哪一组才真实生效，故不擅自改动既有行为，
        // 仅记录该分歧待后续验证。
        id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 50_000,
    },
    {
        id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000,
    },
    {
        id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        // supportsImages 为 true 有实测依据：纯红图问答答出「红色」。
        // ⚠️ scoped 端点（/console/enterprises/personal/models）对它返回
        // supportsImages=false，与 /v3/config、IDE 缓存、wb2api 清单三处矛盾；
        // 实测以「能看到图」为准，故保留 true。只有 scoped 端点先命中时才会被它的
        // false 覆盖 —— 那正是 `BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES` 兜住的个案。
        id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 48_000,
    },
    {
        id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 64_000,
    },
    {
        id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 32_000,
    },
    {
        id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 32_000,
    },
    {
        id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 32_000,
    },
    // ⚠️ 512K 不是笔误：官方档位表最大档就是 512K（[300K, 512K]），档位表是刻意上限。
    {
        id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, supportsImages: true, reasoningEfforts: ['medium'],
        maxOutputTokens: 64_000,
    },
];
export const BUDDY_CN = {
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
};
/**
 * Buddy（腾讯 WorkBuddy 国际版 / WorkBuddy AI）的内置模型目录。
 *
 * 数据来源：IDE 的本地缓存 `~/.workbuddy-ai/local_storage/*.info`
 * （`WorkbuddyAuthProductCoordinator` 写入的 ProductManager 合并结果），
 * 即 IDE 模型选择器实际展示的清单与元数据。
 *
 * 顺序即 IDE 的展示顺序（`cli` agent 白名单顺序），不要随意重排。
 *
 * ⚠️ `contextWindow` 是**最大档**兜底（2026-09-21 口径，理由见 CN 表头的实测记载）：
 * 远端对「1M 但默认档更小」的模型成对下发 `contextWindow`，但单变量实测证明
 * `defaultLength` **不是硬限**（320K–1.0M token 全部正常服务，1.2M 才报 `11115`）
 * ⇒ 真实窗口 = 最大档。故三项下发过档位对的条目（`hy4-preview-f` /
 * `deepseek-v4.1-flash` / `gpt-6-astra`，档位表最大档均 1M）按最大档写 1M；
 * ⚠️ **其余 8 个 1M 条目**（`gpt-5.6-sol` / `-terra` / `-luna`、`gpt-5.5`、
 * `gemini-3.5-flash`、`glm-5.3`、`glm-5.2`、`kimi-k3`）**不带 `contextWindow`
 * 字段**，是**单档模型** —— `maxInputTokens` 就是服务窗口，砍它等于谎报容量。
 * 非 1M 条目（`gpt-5.4` 272K、`kimi-k2.6` 256K 等）同样不动。
 *
 * ⚠️ `maxOutputTokens` 来自 2026-09-19 对国际版 `/v3/config` 的真机实测，**逐 id
 * 填值**；2026-09-21 移植上游 39c66ac 时补录 `hy4-preview` / `deepseek-v4.1-flash-sg`
 * / `kimi-k2.8-preview` 三条（同样按上游逐 id 抄值）。`gpt-5.3-codex` **刻意留空**
 * （上游同样没填，不为凑齐而编造数值）。
 */
const BUDDY_FALLBACK_MODELS = [
    { id: 'default-model', name: 'Auto', contextWindow: 176_000, supportsImages: true, maxOutputTokens: 24_000 },
    { id: 'fast-model', name: 'Fast', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
    { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
    { id: 'primary-model', name: 'Primary', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['high'], maxOutputTokens: 72_000 },
    { id: 'deep-model', name: 'Deep', contextWindow: 176_000, supportsImages: true, maxOutputTokens: 24_000 },
    {
        id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        // 2026-09 补录（移植上游 39c66ac）：/v3/config 的 cli agent 白名单里有它，但兜底表
        // 原先漏了，于是被 `reconcileWithFallback` 丢弃、模型选择器里看不到。实测能看图。
        id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    {
        id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
        reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000,
    },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000 },
    {
        // 2026-09 补录（移植上游 39c66ac）：新加坡区的同代模型（-sg 后缀），远端下发且实测能看图。
        id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000,
    },
    {
        id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 72_000,
    },
    // ⚠️ 刻意不带 maxOutputTokens：上游实测同样未给出该模型的值，不编造（缺失即交回网关默认）。
    { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['medium'] },
    { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 65_536 },
    {
        id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 48_000,
    },
    {
        id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 48_000,
    },
    { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
    {
        // 2026-09 补录（移植上游 39c66ac）：远端 /v3/config 的 cli agent 白名单里有它，
        // 兜底表原先漏了 ⇒ 被 `reconcileWithFallback` 丢弃、选择器里看不到。
        id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000,
    },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
];
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
export const BUDDY = {
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
};
/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export const ALL_PRODUCTS = [BUDDY_CN, BUDDY];
/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function productById(id) {
    return ALL_PRODUCTS.find((product) => product.id === id);
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
export function resolveUserAgent(product, model) {
    for (const rule of product.userAgentByModelFamily ?? []) {
        if (model.startsWith(rule.match))
            return rule.ua;
    }
    return product.userAgent;
}
//# sourceMappingURL=product.js.map