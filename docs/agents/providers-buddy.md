# Buddy 系 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 Buddy 系（`buddy-cn` / `buddy`）时查阅。

## 项目概述（同源说明）

`buddy-cn` 与 `buddy` 同源：共用同一 CLI 内核与认证协议，差异全部收敛在 `src/product.ts` 的 `BuddyProduct` 配置。关键差异是 **`endpoint`**（中国版 `copilot.tencent.com` / 国际版 `www.workbuddy.ai`，返回不同模型池，**不可当全局常量**）与 `platform`（`ide` / `workbuddy-ai`），国际版登录 URL 还追加 `version` / `loginSessionId`。

## 上下文窗口取值口径

原文照搬 AGENTS.md「Buddy 系（`buddy-cn` / `buddy`）—— 上下文窗口取值口径（2026-09-21 真机定案）」整节。

### Buddy 系（`buddy-cn` / `buddy`）—— 上下文窗口取值口径（2026-09-21 真机定案）

⚠️ **声明值取「最大档」≈1M** = `min(maxInputTokens, supportedLengths 最大档)`，**不是 `defaultLength`**。⚠️ **不要按 `defaultLength` 取值（09-20 的旧结论已被单变量实测推翻）。** 钳制二分（`buddy-cn`/`glm-5.3`）：320,307 / 500,507 / 900,910 / 1,000,970 token 全 200，1.2M 才回 400 `{"code":11115,"msg":"prompt is too long: …","extError":{"code":"400001",…}}` ⇒ `defaultLength`(300K) 非硬限、只是纯 UI 默认值，真实窗口 ≈1M（官方客户端的档位选择器**不发任何出站字段**，只驱动它自己的压缩触发点）。

⚠️ **取值链**（`parseModelMeta`）：a = `maxInputTokens`、b = `supportedLengths` 最大正整数 —— ① 都有取 `min(a,b)`（档位表是上游刻意公布的上限，更小时听它的：`minimax-m3` `[300K,512K]` ⇒ **512K**）；② 只有其一取那个；③ 都无才回退 `defaultLength`，再无**不声明**。⚠️ `supportedLengths` **只此一处最小解析**（只取最大正整数，不存整档列表、不做 UI、不出站）。⚠️ **出站请求体一个字段都不动（红线，专属于本档位机制）**：档位只改 `resolveModel().context.contextWindow`（压缩阈值 `0.8×窗口` + 保留预算 16%），有逐字节比对请求体的用例钉死。⚠️ **该红线只管档位，不覆盖「输出上限」**（`max_tokens` 是正交关注点，见下方「单次输出上限」小节；三种档位下它恒定，逐字节用例仍绿）。

⚠️ **静态兜底表（`fallbackModels`）同步回「最大档兜底」**（仅远端不可用时顶替）：CN 的 1M 系 → `1_000_000`、`minimax-m3` → **`512_000`**（不是 1M、也不是 09-20 的 300K）；国际版 3 项档位对条目 → `1_000_000`。⚠️ 国际版 **8 个「1M 且无 `contextWindow` 字段」的是单档模型**，砍它等于谎报容量。⚠️ 改表必须逐条自查 diff：`product.spec.ts` 按**集合相等**两侧钉死（CN 1M 恰 7 项 + `minimax-m3` 留 512K；国际版 1M = 无档位对 8 + 有档位对 3）。

⚠️ **证据强度分层（不要拉平）**：CN 有 `glm-5.3` 单变量实测；**国际版无实测**（余额不足）按同协议形态推定 —— 真实窗口万一低于声明 max，撞 `11115` → 映射 `CONTEXT_WINDOW_EXCEEDED` → 宿主压缩重试（保留预算 1M→160K 仍在真实窗口内）；若声明默认档则**每次 240K 就丢历史**。⚠️ **端点漂移自动消解**：企业端点与 `/v3/config` 统一取最大档后给同一个数，不必写分支。

⚠️ **安全网（不改分类器）**：1.2M 报文被**现有**分类器命中 `CONTEXT_WINDOW_EXCEEDED`（`httpErrorCode` 靠**完整 body**）。⚠️ 承重点是 `displayMsg.en` 那句英文措辞：新报文 `extError.code` 是纯数字、`msg` 无 `for this model` 后缀，结构化正则都认不出，**摘掉 `displayMsg` 即落回 `INVALID_REQUEST`（不触发压缩）**。判据复用宿主 `isContextWindowExceededError`、**不自建关键词表**（同 lobsterai / qoder 先例）；`buddy-adapter.spec.ts` 有钉死用例。

## 单次输出上限

原文照搬 AGENTS.md「Buddy 系 —— 单次输出上限（`max_tokens`，2026-09-21 移植 `0611485`）」整节。

#### Buddy 系 —— 单次输出上限（`max_tokens`，2026-09-21 移植 `0611485`）

⚠️ **远端 `maxOutputTokens` 是必须消费的权威字段，不是仅供参考的元数据。** 铁证：真机 **20 次 `turn/end max-tokens`**，buddy 系 **651 次请求零 `maxTokens`**（对照组 xiaomi / deepseek-official 全带）。根因是适配器早期**只把它当 `isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关默认 **32000**（远端对 `deepseek-v4.1-flash` 实为 **128000**）。

⚠️ **两个落点缺一不可**：① `resolveModel()` 声明 `defaultMaxTokens`（DSH 只在调用方未显式给值时兜底）；② `stream()` 写进请求体 `max_tokens`。**取值链**：`options.maxTokens` → 远端 → 产品兜底表（`productFallbackMeta`，**与 supportsImages / reasoningEfforts 同源**，**不是** `productFallbackContextWindows`）；三者皆无则**不发该字段**，不编造。

⚠️ **远端是外部输入，必须过 `positiveMaxTokens`**（只放行安全正整数）：DSH 对 `defaultMaxTokens` 有**硬校验**，非安全整数或 ≤0 抛 `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**。`parseModelMeta` 侧同样只收正的有限数。

⚠️ **`reconcileWithFallback` 必须透传 `maxOutputTokens`**：该函数**重建条目对象**，漏字段 = 删能力（`contextTiers` 已写过同款警告），会让两个落点**同时**退回 32000。

⚠️ **兜底表逐 id 填值、不整表照搬上游**（本仓没有上游的 `deepseek-v4-flash` / `kimi-k2.8-preview` / `deepseek-v4.1-flash-sg`）；`gpt-5.3-codex` **刻意留空**。各端点值不一致 ⇒ 与 `maxInputTokens` 同策略：**采信实际命中的端点，不跨端点取大**，兜底表取较小者 `128_000`。`product.spec.ts` 逐 id 钉死 + 「除 `gpt-5.3-codex` 外全填」反向防线。

⚠️ **`auto` / `default` 两个内部别名都要过滤**（`parseModelsFromConfig` 的两条 push 路径 + trial banner 路径）：企业端点实测会同时下发这两个自动选择占位。

## 出站协议值

原文照搬 AGENTS.md「LLM Provider 约定」中专属 Buddy 系的「出站协议值不随 provider id / 显示名变化」块。

> ⚠️ **出站协议值不随 provider id / 显示名变化。** `productCode`（`X-Product-Code`
> 仍是 `codebuddy` / `workbuddy`）、`attributionName`（`X-Product` / `X-IDE-Name`
> 仍是 `CodeBuddy` / `WorkBuddy`）、`platform`、`endpoint`、`apiDomain`、UA
> 都是**出站身份标识**，腾讯后台按它们归因用量 —— 改名时一个字符都不能动
> （`src/product.ts` 已在各处用 `⚠️ 协议值` 注释标出）。

## 请求签名与适配器

原文照搬 AGENTS.md「LLM Provider 约定」与「项目概述」中专属 Buddy 系的行项。

- 请求签名/鉴权方式：`buddy-cn` / `buddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
- `buddy-cn` 与 `buddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例

## 登录、凭据与模型目录

Buddy CN 与 Buddy 共用 `auth/state` → 浏览器授权 → 轮询 `auth/token` → 轮询 `login/account` 的 external-link-v2 流程，不启动本地回调服务器。先 `POST /v2/plugin/auth/state?platform=<platform>` 获取 `state` 与 `authUrl`；轮询 token 时业务码 `11217` 表示尚未就绪，账户接口 `/v2/plugin/login/account` 的 `12151` 表示账户信息尚未就绪。续期使用 `POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 提交刷新令牌。

- Buddy CN 使用 `platform=ide`、`copilot.tencent.com`；Buddy 使用 `platform=workbuddy-ai`、`www.workbuddy.ai`，登录 URL 还带 `version` 与 `loginSessionId`。协议身份头 `X-Product-Code` / `X-Product` 等按产品配置发送，provider id 改名不能改这些值。
- 单账号凭据 ref 分别为 `BUDDY_CN_ACCESS_TOKEN` / `BUDDY_ACCESS_TOKEN`；账号池 ref 为 `BUDDY_CN_ACCOUNT_<UUID_SHORT>` / `BUDDY_ACCOUNT_<UUID_SHORT>`。凭据 JSON 含 `access_token`、`refresh_token` 与 `expires_at`。
- 模型目录由 `GET /v3/config` 提供，读取 `data.data.models` / `data.data.agents`；Buddy CN 有内置目录兜底。两个 region 使用各自 endpoint，不能共用模型池。

## 积分领取（每日签到）

原文照搬 AGENTS.md「积分领取」中 Buddy CN 段。

- **Buddy CN** —— `src/credits.ts`（Buddy 国际版后端无签到接口）：状态 `POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位）→ 领取 `POST /v2/billing/meter/daily-checkin`。幂等：重复领取回 HTTP 400 + `code:10001`，判定**以响应体 code 为准**。**不需要** `X-Device-Token`（图灵盾）—— 实测服务端未强制校验。

## 积分余额

原文照搬 AGENTS.md「积分余额」中 Buddy 系段。

- **Buddy 系**（两产品通用，仅 baseURL 随 `product.endpoint` 切换）：`POST /v2/billing/meter/get-user-resource`，body `{}`。⚠️ 响应**双层嵌套** `data.Response.Data.Accounts[]`（签到是单层 `data`，最易解析错）；余额取各包的 `CycleCapacityRemain`（本周期口径）相加，**不是** `CapacityRemainPrecise` / `CapacityRemain`（终身口径）；精确值经 `readPreciseNumber()` 优先读带 `Precise` 后缀的字符串版；**不用**截断过的 `TotalDosage`；包名回退 `PackageName` → `SubProductName` → `PackageCode`。该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），靠真实凭据实测发现。