# LobsterAI 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 `lobsterai` 时查阅。

## 项目概述（不同源说明）

`lobsterai` 与 **Buddy 系完全不同源**（登录方式、请求头、续期载荷、签到流程、版本号来源都不同），实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 其中 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 对 LobsterAI 全部无意义。详见 README「LobsterAI provider」与 `docs/lobsterai-integration-plan.md`。

## 登录与续期机制

LobsterAI 登录/续期机制与其它 provider 不同（见 README.md），主要通过 `ctx.credentials` 统一管理生命周期。两段式登录（`src/account-hub-rpc.ts`）：第一段 `prepareLogin` 取 `loginUrl`，写占位条目；第二段后台完成登录。**LobsterAI 登录是 provider 级互斥的**（`prepareLobsteraiLogin`）—— 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`，不新建也不复用（复用会让一份凭据被多个占位 accountId 共享，静默新建则每次点击堆积一个 loopback 端口直到 10 分钟超时）；`account.delete` 会 cancel 对应会话以释放端口。

## 请求签名/鉴权

原文照搬 AGENTS.md「LLM Provider 约定」中专属 LobsterAI 行项。

- `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**

## 积分领取（每日签到）

原文照搬 AGENTS.md「积分领取」中 LobsterAI 段。

- **LobsterAI** —— `src/lobsterai-credits.ts`（三步）：槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`。幂等是**客户端**保证的：`idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`。`clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`；`platform=win32` 等是客户端形态伪装，非 Windows 也照发。

## 积分余额

原文照搬 AGENTS.md「积分余额」中 LobsterAI 段。

- **LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`；**不要**用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分）。

## X-Domain 例外

原文照搬 AGENTS.md「X-Domain 必须跟随产品，而非凭据」中专属 LobsterAI 段。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。