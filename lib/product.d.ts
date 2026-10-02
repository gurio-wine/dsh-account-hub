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
    id: string;
    name: string;
    /**
     * 上下文窗口 —— **最大档**，即上游真实可服务的那一档（≈1M）。
     *
     * ⚠️ 语义已按 **2026-09-21 钳制二分实测**修正为「最大档兜底」：09-20 曾改成
     * 「默认档兜底」并推断「上游按 `defaultLength` 服务」，该推断**已被单变量实测
     * 推翻** —— `buddy-cn` 的 `glm-5.3` 在 prompt 320,307 / 500,507 / 900,910 /
     * 1,000,970 token 全部 HTTP 200 正常服务，1.2M 才回 `code:11115`
     *（`prompt is too long`）⇒ `defaultLength`（300K）是**纯 UI 默认值、不是硬限**。
     *
     * 口径：带档位对的条目 = `min(maxInputTokens, 档位表最大档)`，无档位对的条目 =
     * `maxInputTokens`。照默认档写会让宿主 0.8 × 300K = 240K 就压缩、白丢历史。
     * 远端可用时本表不参与（远端优先），它只在凭据失效 / 拉取失败时顶替。
     * 档位数据会漂移，本表是快照而非契约。
     */
    contextWindow?: number;
    /**
     * 单次请求输出上限（对应远端 `maxOutputTokens`）。
     *
     * 远端可达时以远端为准；本字段只在远端不可用或未覆盖该模型时补位。
     *
     * ⚠️ **必须下发**，不是仅供展示的元数据：适配器把它写进请求体的 `max_tokens`
     * 并声明为 `resolveModel().defaultMaxTokens`。不填的模型退回**网关默认 32000**，
     * 长回答与大文件写入会在 32000 处被截断成 `finish_reason:'length'`
     * （`turn/end` 报 `max-tokens`）。取值来自 2026-09-19 真机实测。
     */
    maxOutputTokens?: number;
    /** 是否接受图片输入（对应远端 `supportsImages`）。 */
    supportsImages?: boolean;
    /** 可选思考等级（对应远端 `reasoning.supportedEfforts`）。 */
    reasoningEfforts?: readonly string[];
    /** 默认思考等级（对应远端 `reasoning.defaultEffort`）。 */
    defaultReasoningEffort?: string;
}
/** 一条「模型族 → User-Agent」覆盖规则。 */
export interface BuddyUserAgentRule {
    /** 模型 id 前缀；命中即采用本规则的 ua。 */
    match: string;
    /** 命中后使用的 User-Agent。 */
    ua: string;
}
/** 一个 Buddy 系产品的全部差异配置。 */
export interface BuddyProduct {
    /** provider 标识：注册到 ctx.llm 的路由名，也是账号列表的 provider 字段值 */
    id: 'buddy-cn' | 'buddy';
    /**
     * cordis 服务名（`ctx.<serviceName>`）。
     *
     * 为什么**显式给出**而不是机械派生 `${id}Auth`：`buddy-cn` 机械派生会得到
     * 非标识符风格的 `buddy-cnAuth`，与 `TraeCnProduct.serviceName` 是同一先例
     * （见 `src/trae-cn-product.ts` 与 AGENTS.md 的「LLM Provider 约定」）。
     */
    serviceName: string;
    /** auth/state 的 platform 查询参数 */
    platform: string;
    /**
     * API endpoint（含协议），所有 `/v2/plugin/*`、`/v3/config` 与 chat 请求
     * 都以此为基址。**这是不同区域产品之间最关键的差异**：模型池由它决定。
     */
    endpoint: string;
    /**
     * 用于 `X-Domain` 请求头的域名（通常等于 endpoint 的主机名）。
     * 注意与 `endpoint` 分开：历史实现里该头传的是不带协议的域名。
     */
    apiDomain: string;
    /** 设置页展示名 */
    displayName: string;
    /** X-Product-Code 请求头值 */
    productCode: string;
    /**
     * 默认 User-Agent（无按模型分档命中时使用）。
     *
     * 腾讯后台的「使用端」列按出站 UA 归因，故该值必须**含对应产品品牌字样**
     * （`WorkBuddy/...` 或 `CodeBuddyIDE/...`），否则账单显示为 `-`。
     */
    userAgent: string;
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
    userAgentByModelFamily?: readonly BuddyUserAgentRule[];
    /**
     * 归属头名（`X-IDE-Name` / `X-IDE-Type` / `X-Product` 三头共用同一取值）。
     *
     * 注意语义：`X-Product` 是**用量归属名**，不是部署类型 —— 历史实现把它发成
     * `SaaS`（部署类型语义）导致后台归因不到产品，故此处按产品名下发。
     */
    attributionName: string;
    /** `X-IDE-Version` 头取值（客户端形态版本号） */
    clientVersion: string;
    /** User-Agent 第三段 `CLI/<ver>` 的版本号 */
    cliVersion: string;
    /** 默认凭据 ref（无账号池时的单凭据回退） */
    defaultCredentialRef: string;
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
    fallbackModels?: readonly BuddyFallbackModel[];
    /**
     * 登录 URL 是否需要追加 `version` 与 `loginSessionId`。
     * Buddy CN 不需要；Buddy（国际版）需要（对齐 workbuddy-desktop 认证配置）。
     */
    appendSessionParams: boolean;
    /** 追加到登录 URL 的版本号（appendSessionParams 为 true 时使用） */
    pluginVersion?: string;
}
export declare const BUDDY_CN: BuddyProduct;
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
export declare const BUDDY: BuddyProduct;
/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export declare const ALL_PRODUCTS: readonly BuddyProduct[];
/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export declare function productById(id: string): BuddyProduct | undefined;
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
export declare function resolveUserAgent(product: BuddyProduct, model: string): string;
//# sourceMappingURL=product.d.ts.map