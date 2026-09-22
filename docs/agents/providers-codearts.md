# CodeArts 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 codearts 时查阅。

## 请求签名/鉴权

`codearts`：华为云 `SDK-HMAC-SHA256` 签名方案

## 积分领取（每日签到）

- **CodeArts** —— `src/codearts-credits.ts`（四步签名：账户类型 `statistics/plugin`（**裸对象**）→ `/v1/ops/delivery?channel=IDE` → `/v1/ops/claim` →（`id != null` 时）`/v1/ops/confirm`）。⚠️ 三坑：`campaignId` **是数字**、可领积分字段 **`benefitAmount`**（不是 `amount`）、不可领取时 `status` 是 **`null`**；幂等**只有活动列表预检**（`status` ∈ {CLAIMED,CONFIRMED,CONSUMED}，**无幂等键无业务码**）；只领 `type === 'USER_LOGIN'`。⚠️ `Agent-Type` / `X-Language` **签名后追加**（进 canonical request 会 401 `APIG.0301`）；`refresh_token` 一次性轮换、**只读不刷新**。

## 积分余额

- **CodeArts**：余额与账户类型检测是**同一个** `GET /snap-manager/v1/statistics/plugin` 响应（**裸对象**）；取 `metrics[]` 里 `usageTotalPackageCredit.package_credit_remain`，**不累加**明细（另三项是构成明细，相加即重复计算）。非积分账户回「**Token 计费账户，无积分余额**」而**非**「查询失败」—— 账户类型差异不是故障，故走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因；积分账户但无 credit metric 时回「未返回积分数据」，**不显示成 0**（0 会让用户以为积分已用光）。

## 上下文窗口

Codearts `contextWindow` 声明（远端优先、静态表兜底）见 `docs/agents/codearts-context-window.md`