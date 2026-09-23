# 积分（签到与余额）实现细节

本文件由 AGENTS.md 迁出，供实现/维护时查阅。

## 积分领取（每日签到）：五套共同约定

五套**协议完全不同**的实现，各自独立：

五套共同约定：`credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**（停用只影响账号池的自动选择与限流切换）；逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批；返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 五套协议共用；**领取流程自带多步预检的 provider 传 `precheckStatus: false`**（LobsterAI / Trae CN / CodeArts / Qoder CN —— 它们的 `claim` 内部已查过状态）。

**`ClaimOutcome` 的五个 kind 与「要不要重试」**（`src/credits.ts`，判别联合的语义边界）：

| kind | 含义 | 宿主写今日状态？ | 用户该做什么 |
|---|---|---|---|
| `claimed` | 本次领到 | **写** | 无 |
| `already-claimed` | 今天已领/已签（含 Trae CN `9095` 的设备级已签） | **写** | 无 |
| `inactive` | 活动层面未开启（持续状态，重试不会变） | 不写 | 无（明天再来） |
| `unavailable` | 服务端**此刻**暂不受理（名额/风控类拒绝，目前只有 Trae CN `9074`） | **不写** | **什么都不做**，等 4h sweep 自动重试 |
| `failed` | 需要用户行动的失败（凭据失效 / 设备头不对 / 网络异常） | 不写 | 去排查（重登 / 校准） |

⚠️ **写今日状态是白名单**（只认 `claimed` / `already-claimed`，`src/account-hub-rpc.ts` 的 `performCheckinOnTargets`）—— 新增 kind 时**默认不写**才是安全方向：一旦把 `unavailable` 写成「今天办过了」，4h sweep 的「今日未签」筛选当天就短路，一次**瞬时**拒绝变成**当天永久**失败。`unavailable` 与 `failed` **刻意不合并**：前者「不用管」，后者「要动手」，合并会让用户白折腾。新增产生者时还要顺带改聚合点（`claimQoderDailyCheckin` 把多活动收敛成一条 outcome，它目前只识别 `claimed` / `failed`）。

各 provider 的签到/余额端点与判据细节见对应 docs/agents/providers-*.md（buddy / lobsterai / trae-cn / qoder / codearts）。

## 积分余额（通用约定）

**积分余额（Credits Balance）** 覆盖**全部七个 provider**、五套端点（「查不到」与「余额为 0」严格区分），与签到是**彼此独立**的能力 —— 不要因为「Buddy 国际版没有签到」就推断也查不到余额：

- 累加后一律 `roundCredits` 规整两位小数；「余额为 0」与「查不到」严格区分（失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0）。RPC `credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮。

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断。**默认关闭**（未登记者视为两项全无 —— 新增 provider 忘登记时最坏是暂时看不到积分，而不是每次开面板都发一个必然失败的请求）；**门控在发请求之前**（`loadCredits` / `claimCredits` 内部各有一道守卫 —— 按钮不渲染只是 UI 便利，不是安全边界）。

**`dailyCheckin` 为 true 的有六个**：`buddy-cn`（中国版后端）、`lobsterai`（`client-activities` 三步）、`trae-cn`（`checkin_credits` 两步 + 设备头）、`codearts`（四步签名）、`qoder` 与 `qoder-cn`（两区同协议 `sash/…/campaigns` 两步）。**`balance` 七项全真**，含 `buddy`（唯一 `dailyCheckin:false` —— 国际版无签到接口）、`qoder`（三池之和 `userQuota` / `addOnQuota` / `orgResourcePackage`，后两池容缺）、`qoder-cn`（同一实现、CN 端点，实测两池）。⚠️ **Qoder 两区 `dailyCheckin` 均为 true，协议共用**（宿主按传入 `product` 现算 host，见 `src/qoder-credits.ts`）：国际版 `qoder` 的端点 `GET {openapiBase}/sash/api/v1/me/campaigns` 已于 **2026-09-23 真机探测 HTTP 200**、响应与 CN 逐字节同构 —— 旧定性「国际版无此活动」不成立；⚠️ 2026-09-24 真机定案：该端点**必须带 `Cosy-ClientType: 10`**（缺头 ⇒ 空列表假象），判读为三态（`CLAIMED` ⇒ 已领、`CLAIMABLE` ⇒ 未签、**带头仍空** ⇒ `undetermined`），详见 `docs/agents/providers-qoder.md`；`qoder-cn` 的端点已由 keylog 解密抓包解出并真机验收（2026-09-21）。**唯一 `dailyCheckin:false` 的是 `buddy`**（后端无签到接口，与 Qoder 无关）。`credits-capabilities.spec.ts` 断言钉死取值。

⚠️ **改名的语义翻转点**：矩阵里 `buddy` 这个键**换了主人**（新主人是国际版）；迁移由 `src/provider-rename-migration.ts` 搬运。改动矩阵后必须同步 `PROVIDERS`（断言锁死两者条目集合相等），⚠️ **匹配器必须写 `[a-z-]+` 而非 `[a-z]+`** —— 后者让带连字符的 id（`trae-cn`）在 `PROVIDERS` 里隐形，漏登记时断言反而是绿的。三个积分端点只对**未知** provider 回 `bad-request`；`codearts` 与 Qoder 两区都已接真实实现。⚠️ **宿主侧接线**：`credits.status` / `credits.claimAll` / `checkin.perform` 对 Qoder **两区均已接线**、按 region 分派（`src/account-hub-rpc.ts` 经 `qoderRegionFor` 各走各的配置与实例）；国际版端点 2026-09-23 真机验证 200 同构，`CLAIMABLE` 分支待活动刷新自然验证。