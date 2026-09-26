# LobsterAI 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 `lobsterai` 时查阅。

## 项目概述（不同源说明）

`lobsterai` 与 **Buddy 系完全不同源**（登录方式、请求头、续期载荷、签到流程、版本号来源都不同），实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 其中 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 对 LobsterAI 全部无意义。上游接入背景见 `docs/lobsterai-integration-plan.md`。

## 登录与续期机制

Account Hub 登录走两段式：`prepareLogin` 在本地启动回调并先返回 `loginUrl`，浏览器授权完成后后台写入凭据。**LobsterAI 登录是 provider 级互斥的**（`prepareLobsteraiLogin`）—— 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`，不新建也不复用；`account.delete` 会 cancel 对应会话以释放端口。单账号 ref 为 `LOBSTERAI_ACCESS_TOKEN`，账号池 ref 为 `LOBSTERAI_ACCOUNT_<UUID_SHORT>`；凭据 JSON 除 `access_token` / `refresh_token` / `expires_at` 外，还必须保留续期所需的 `uuid` / `first_keyfrom` / `latest_keyfrom`。

续期请求使用 `POST /api/auth/refresh`，请求体还需上述三个身份字段；客户端版本 `clientVersion` 动态获取并缓存 12 小时，失败回退 `product.fallbackClientVersion`。登录 portal 与 `apiBase` 是两个不同域名，均由产品配置提供。

## 请求签名/鉴权

原文照搬 AGENTS.md「LLM Provider 约定」中专属 LobsterAI 行项。

- `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**

## 模型目录与思考档位

模型目录优先读取远端 `GET /api/models/available`（响应 `data` 直接是数组），失败时回退产品配置中的内置目录。目录请求必须带 `X-LobsterAI-Client-Capabilities`，否则上游会按能力过滤模型。`clientVersion` 运行时拉取并缓存 12 小时，失败回退 `fallbackClientVersion`。

远端 `thinkingConfig.options[].level` 是思考档位的来源，请求字段为 `reasoning_effort`。只透传远端声明值，不补造档位；`off` 在部分模型上会返回 HTTP 500，因此不发送。`lobsterai_options` 能力协商与 reasoning effort 是两套协议字段。

## 积分领取（每日签到）

原文照搬 AGENTS.md「积分领取」中 LobsterAI 段。

- **LobsterAI** —— `src/lobsterai-credits.ts`（三步）：槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`。幂等是**客户端**保证的：`idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`。`clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`；`platform=win32` 等是客户端形态伪装，非 Windows 也照发。

## 积分余额

原文照搬 AGENTS.md「积分余额」中 LobsterAI 段。

- **LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`；**不要**用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分）。

## X-Domain 例外

原文照搬 AGENTS.md「X-Domain 必须跟随产品，而非凭据」中专属 LobsterAI 段。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。