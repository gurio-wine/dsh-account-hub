# CodeArts 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 codearts 时查阅。

## 请求签名/鉴权

`codearts`：华为云 `SDK-HMAC-SHA256` 签名方案

### benefit（免费额度）模型与 `maas_type` 头

部分模型是 **benefit（免费额度）模型**：chat 请求必须携带 `maas_type: benefit`
请求头，且该头**参与** `SDK-HMAC-SHA256` 签名（进 canonical request 与
`SignedHeaders`），否则后端返回 `InferHub.002002009.404 The model is not
registered`。已知：`glm-5.3-flash`、`deepseek-v4.1-flash`。

⚠️ **判定必须动态**（`src/models.ts` 的 `isCodeArtsBenefitModel`）：内存缓存 →
磁盘缓存 `~/.cache/deveco/codearts_benefit_models.json` → 静态兜底
`CODEARTS_BENEFIT_FALLBACK`。权威来源是 `opengw gateway/config` 的
`result.models`。**不要**再在 `src/llm-adapter.ts` 里硬编码集合 —— 那会让后端
每新增一个 benefit 模型就要改一次代码（历史缺陷：集合只有 `glm-5.3-flash`，
于是 `deepseek-v4.1-flash` 调用失败）。

⚠️ **只把「未被 `normalizeModelId` 改写」的 id 记入 benefit 集**：gateway 下发的是
`deepseek-v4-flash-0731`（**benefit**），归一化后落到无后缀 `deepseek-v4-flash`
（**非 benefit**）—— 二者是后端上两个不同的模型、benefit 属性相反。连带标记会让
无后缀模型多带该头，反而报 `unsupported model`。

⚠️ 本仓库 `src/models.ts` 的缓存读写**必须用顶层静态导入的 `node:fs`**：本包是 ESM
（`"type": "module"`），`require('node:fs')` 恒抛 `ReferenceError` 并被 catch 吞掉，
表现为「磁盘缓存永远写不进也读不回」。

## 续期（refresh）与账号池接线

- 单凭据用户：`CodeArtsAuth.refresh()` 读写 `CODEARTS_ACCESS_TOKEN`；
  `scheduleRefresh()` **只**为该默认 ref 武装调度器（调用点仅在本类内）。
- 池内账号（`CODEARTS_ACCOUNT_*`）：由宿主 `refreshAll(pool)` 批量续期覆盖 ——
  30 分钟一轮，**storage 就绪后立即补跑一轮**（判据只看 `refreshable`，不看 `enabled`）。
  ⚠️ 该定时器的判据必须在 `pool.openStorage()` 的 `then` 链里算：`apply()` 是同步
  签名，在同步期读池会读到 settings 回退路径/空表，导致定时器**从未注册过**。
- 适配器的 `refresh` 回调**必须与 `resolveCredential` 挑同一个账号**：用
  `makeAccountRefresher(pool, providerId, service)`（`src/index.ts`）。
  错配的后果是池内账号用户走到续期就抛「未配置凭据，请先登录」。
- `refresh_token` 是**一次性轮换**的：并发续期时后到的那条会收到
  `STS5.1806 the refresh token has been used`。该错误**不是终态**（`RefreshTokenReusedError`），
  正确处置是**重读存储拿到新令牌再试一次**（判据：重读到的 `refresh_token` 与本次不同）。
  千万不要把它归入 `RefreshTokenExpiredError` —— 那会要求用户重新登录，而存储里
  其实躺着一份可用凭据。

## 积分领取（每日签到）

- **CodeArts** —— `src/codearts-credits.ts`（四步签名：账户类型 `statistics/plugin`（**裸对象**）→ `/v1/ops/delivery?channel=IDE` → `/v1/ops/claim` →（`id != null` 时）`/v1/ops/confirm`）。⚠️ 三坑：`campaignId` **是数字**、可领积分字段 **`benefitAmount`**（不是 `amount`）、不可领取时 `status` 是 **`null`**；幂等**只有活动列表预检**（`status` ∈ {CLAIMED,CONFIRMED,CONSUMED}，**无幂等键无业务码**）；只领 `type === 'USER_LOGIN'`。⚠️ `Agent-Type` / `X-Language` **签名后追加**（进 canonical request 会 401 `APIG.0301`）；`refresh_token` 一次性轮换、**只读不刷新**。

## 积分余额

- **CodeArts**：余额与账户类型检测是**同一个** `GET /snap-manager/v1/statistics/plugin` 响应（**裸对象**）；取 `metrics[]` 里 `usageTotalPackageCredit.package_credit_remain`，**不累加**明细（另三项是构成明细，相加即重复计算）。非积分账户回「**Token 计费账户，无积分余额**」而**非**「查询失败」—— 账户类型差异不是故障，故走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因；积分账户但无 credit metric 时回「未返回积分数据」，**不显示成 0**（0 会让用户以为积分已用光）。

## 上下文窗口

Codearts `contextWindow` 声明（远端优先、静态表兜底）见 `docs/agents/codearts-context-window.md`