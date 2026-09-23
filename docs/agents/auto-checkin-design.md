# 自动签到（Auto Check-in）设计方案

本次为**只读调查 + 设计文档**，不改任何代码。本文定稿各落定点与分叉，供实现阶段照做。
能力范围：`buddy-cn` / `lobsterai` / `trae-cn` / `codearts` / `qoder-cn`（有 `dailyCheckin`）；`qoder` 国际版接入由并行任务定，**本文只留占位，不接线**。

## 1. 状态存储：storage 域第五字段

- **新字段名**：`checkins`。
- **键格式**：`${provider}:${accountId}`（如 `trae-cn:trae-cn-a1b2`）。provider + accountId 全局唯一（accountId 已含 provider 前缀，但显式带 provider 让键自解释、且孤儿清理时可按 provider 前缀批量删）。
- **值格式**：**精确到日的本地时间戳**，采用**纪元日数** `dayNumber = floor(localDateAsEpochDay)`，即「本地时区当天的本地纪元日数」，`number` 类型。选纪元日数而非 `'YYYY-MM-DD'` 字符串的理由：
  1. 数值可与[[今日 dayNumber]]直接做**整数相等**比对，无需字符串解析/时区口径函数；
  2. 存储体积/JSON 天然紧凑；3. 边缘情形（时区切换、夏令时）只在**计算今日 dayNumber** 一处收敛，存的值本身不依赖「今天」。
  读写工具函数放 `src/account-pool.ts`（宿主唯一读源）：私有 `todayDayNumber()`（`new Date()` → 本地年月日 → epoch day，lib 实现为 `Date.UTC(y,m,d)/86400000`）、`checkinDay(provider, accountId)` / `writeCheckinDay(provider, accountId, day)`（见第 2/3 节）。⚠️ 值口径是**本地日期**：换算基准用本地时区的年月日，不要用 `getUTCDay`，也不要用时间戳毫秒数（跨日就失效）。

### 四件套 → 五件套（具体改动点清单）
- `src/account-hub-storage.ts`：`AccountHubDocument` 加 `checkins: Record<string, number>`；`emptyAccountHubDocument()` 补 `checkins: {}`；`sanitizeAccountHubDocument()` 归一化 `checkins`（逐键校验 `typeof === 'number' && Number.isFinite`，丢脏键，不抛错——与 `sanitizeDisabledModels` 同口径）；`AccountHubStorage.write(doc)` 不变（整体替换，自动带上第五字段）。`ACCOUNT_HUB_DOMAIN_VERSION`（文件格式版本）**保持 1 不 bump**——storage 后端不校验字段集合，新增字段不破坏既有文件；`schemaVersion`（业务数据版本）**bump 到 2**，理由见下面「孤儿清理」。
- `src/account-pool.ts`：
  - `AccountHubDocumentLike` 加 `checkins: Record<string, number>`；`persist()` 的 storage 分支与 settings 分支都写入 `checkins`。
  - `ensureLoaded()`：storage 分支读 `doc.checkins`；settings 回退分支读 `value.checkins` 并 `sanitizeCheckins()` 归一化。
  - `writeAccounts` / `writeModels` / `writeBudgets` / `replaceAll`：四处 `persist({...})` 全部补 `checkins: this.checkinCache`。`checkinCache` 进程内权威副本，字段语义与 `budgetCache` 完全同构。
  - `replaceAll` 新增第 4 个可选参数 `checkins?: Record<string, number>`（缺省取 `this.checkinCache`，与 `contextBudgets` 的处理一致）。
  - 新增 `writeCheckinDay(provider, accountId, day)`：`读 → 改单键 → 整体 replace`，先 `ensureLoaded()`（防 `loaded` 未置位时整表写空，同 `setModelDisabled` 陷阱）。
- `ACCOUNT_HUB_SCHEMA_VERSION` bump 到 `2` 且写入一条一次性迁移（`src/provider-rename-migration.ts` 同文件夹新增或并入）：把 `checkins` 字段加入文档（旧文件迁移后不存在该字段 → 空表；无需改数据）。⚠️ 只迁移「字段」，不迁移匹配 provider/账号（checkin 状态无改名历史）。

### 孤儿清理策略
- **账号删除时**（`AccountPool.removeAccount`）：同 `clearModelRateLimits` 模式，删除 `checkins` 中 `provider:${id}` 精确键（用条目自己的 `provider`），**随 `removeAccount` 内的一次 `writeAccounts` 整体 replace 顺带清**，不额外写盘。provider 变更（改名迁移）不复用孤儿。
- **残留兜底**：设置页打开某 provider 面板时，`credits.checkinStatus`（见第 3 节）读到该 provider 的账号集合，宿主把 `checkins` 里 **provider 前缀匹配但 accountId 不在当前账号列表** 的孤儿一并删除（一次性清理，避免久不删账号的 tab 残留）。该清理只在有账号数据时跑，无账号跳过。

## 2. 检测逻辑（宿主统一入口）

每个 provider 的**单个账号**触发判定，核心为 `src/account-pool.ts` 新增 `async checkInIfDue(provider, account)`，返回该账号本次处置结果（供 sweep 与 RPC 复用）：

```
day = checkinDay(provider, account.id)
today = todayDayNumber()
if (day === today) return { outcome: 'already-checked-in' }        // 相等直接判已签
try:
  result = provider-specific claim（复用现有 claim 流程，见第 5 节）
  if result.kind == 'claimed' || result.kind == 'already-claimed':
    await writeCheckinDay(provider, account.id, today)             // 成功或服务端已领 → 写今日
    return { outcome: 'checked-in', result }
  else (inactive / unavailable / failed):
    return { outcome: result.kind, result }                        // 失败/暂不可签都不写，下次触发再试
catch (network/凭据异常):
  return { outcome: 'failed', message }                            // 失败不写
```

**判定规则落地**：`claimed`（签到成功）与 `already-claimed`（服务端 already-claimed）都写今日时间戳；`inactive`（活动未开）、`unavailable`（服务端此刻暂不受理 —— Trae CN 的 `9074`，名额/风控类拒绝）与 `failed`（含网络失败、凭据损坏）**一律不写** → 下次进入/定时触发重试。宿主侧不主动维护「今日已自动跑过」标志，幂等性由「服务端 already-claimed 也写今日」保证。

> ⚠️ **`unavailable` 的「不写」是硬要求，不是顺带**（2026-09-23 随该 kind 加入时钉死）：写状态的判据是**白名单**（只认 `claimed` / `already-claimed`），故它天然不命中。一旦写成黑名单（或错误地把它并入「已处理」），4h sweep 的「今日未签」筛选当天就会短路跳过该账号 —— 一次**瞬时**的服务端拒绝被固化成**当天永久**失败。用例见 `tests/unit/checkin-rpc.spec.ts` 的「unavailable 不写今日签到状态」组。

## 3. RPC 契约（`src/account-hub-rpc.ts`）

沿用既有 `collectCreditsStatus` / `collectClaimResults` 的逐账号编排，**不改 registerAccountHubRpc 的既有 11 个实参含义**；新增三个 case，全部在 `handleMethod` 的 switch 内加分支即可：
- **`credits.checkinStatus`**（读全量状态，供面板挂载渲染）— `RpcCheckinStatusRequest = { provider }`；`RpcCheckinStatusResponse = { accounts: [{ accountId, nickname, checkinDay, checkedInToday }] }`，`checkedInToday = checkinDay === today`。宿主读进程内 `checkins`，**不发网络请求**。仅对 `supportsDailyCheckin` 的 provider 有效；未知/无签到能力 provider 返回空表（客户端还保留能力门控，见第 8 节）。
- **`checkin.perform`**（**单账号**签到，替代/配合单片按钮）— `RpcCheckinPerformRequest = { provider, accountId }`；`RpcCheckinPerformResponse = { provider, nextReset, results[], summary, busy? }`（现行契约见 `src/account-hub-rpc.ts`；本文写作时的 `{ outcome, checkedInToday }` 形态已被「与 `credits.claimAll` 同构」的响应取代）。内部调 `checkInIfDue`；**accountId 为空串时**退化为「该 provider 全量 sweep」（供头部"一键签到"与定时器复用同一入口）。`busy: true` = 被共享互斥挡下、**零 claim**，见第 9 节。
- **`checkin.sweep`**（执行一次全量 sweep，宿主自触发/手动）— `{ }`（无入参），内部遍历全部 provider。响应 `{ summary }`（复用 `RpcCreditsClaimSummary` 结构 + 每 provider 计数可选）。

现有 `credits.claimAll` **保留不动**（provider 级全账号手动领取仍是独立能力）；单账号按钮**不改造 claimAll**，新增 `checkin.perform` 携带 accountId 更贴合现有 `collectClaimResults` 的「逐账号 try」结构，避免给 claimAll 塞一个会破坏「全账号+含停用」语义的可选参数。

**registerAccountHubRpc 接线**：`handleMethod` 内新增分支直接复用闭包里的 `ctx` / `pool` / 各 auth 实例（`codearts` / `buddyCn` / `buddy` / `lobsterai` / `traeCn` / `qoder` / `qoderCn` 已在 `registerAccountHubEndpoints` 的形参里）。第 10 实参 `contextTiers`、第 11 `modelAdapters` **不动**。新逻辑纯属 handler 内部 + `checkInIfDue`，不需要新增 registerAccountHubRpc 形参。

## 4. 宿主触发（同步 + 定时器）

`src/index.ts` 的 `apply()` 内（现有 `pool.listAllAccounts().then(...)` 续期块的**同一层级**，保证在 `void pool.openStorage()` 之后，见下面「执行前先 load」）：
- **进入 Hub 由客户端触发**（见第 7 节），宿主不监听页面。宿主只做：
- **启动 dsh 触发**：在 `apply()` 末尾、`registerAccountHubRpc` 之后追加：
  ```ts
  const runSweep = () => sweepAllCheckins(pool, ctx)   // 见第 5 节
  // 启动后首次：等 storage 就绪。openStorage 是异步的，宿主必须保证在它 return 之后才 sweep
  void pool.openStorage().then(() => queueMicrotask(runSweep))
  ```
  ⚠️ **顺序约束**：sweep 的「读 `checkins`/写今日」依赖 storage 已打开（`openStorage` 内部 reset 载入标记），而 `apply()` 是同步签名、`openStorage()` 是 `.then()` 串链的（既有代码同款）。故启动 sweep 必须挂在那个 Promise 之后，**绝不能在 `pool.openStorage()` resolve 前跑**，否则会读到旧 settings/内存快照、写入落错通路（既有 openStorage 注释已警告同款分叉）。
- **每 4 小时定时器**：
  ```ts
  const AUTO_CHECKIN_INTERVAL_MS = 4 * 60 * 60 * 1000
  const checkinTimer = setInterval(() => void runSweep(), AUTO_CHECKIN_INTERVAL_MS)
  checkinTimer.unref?.()
  ctx.effect(() => () => clearInterval(checkinTimer), 'account-hub: auto check-in scheduler')
  ```
  取消登记进 `ctx.effect`（插件停用/重载时清定时器；与既有 `account-hub: multi-account refresh scheduler` 同款）。

## 5. sweep 执行序（`checkInIfDue` 编排复用 claim 流程）

新增 `async function sweepAllCheckins(pool, ctx)`，遍历顺序：**按 provider 逐个**（固定序：codearts → buddy-cn → lobsterai → trae-cn → qoder-cn，qoder 跳过），每 provider **按账号数组顺序**（即池的候选优先级顺序）逐账号 `await checkInIfDue`。**复用现有 claim 流程**：直接复用 `collectClaimResults` 式的 deps 注入（`resolveCreditsDeps` + 各 provider 的 claim/fetcher），或更省事地——让 `checkInIfDue` 内部调用与 `credits.claimAll` 分支完全相同的 claim（Buddy 系 `claimDailyCheckin`、CodeArts `claimCodeArtsDailyCheckin`、LobsterAI `claimLobsteraiDailyCheckin`、Trae `claimTraeCnDailyCheckin`、Qoder CN `claimQoderDailyCheckin`），以 `precheckStatus` 与既有分支一致（多步预检的传 false）。LobsterAI 需要 `resolveClientVersion()`，CodeArts 用 `claimCodeArtsDailyCheckin(credential)`，与 claimAll 分支**逐字相同**，只是把「全账号数组」换成「单账号或单 provider 数组」。

## 6. 能力真相源共用（宿主侧怎么知道哪些 provider 可签到）

`credits-capabilities.js` 是**客户端文件**（esbuild 进 bundle），宿主 TS 无法 import。**结论：不迁移真相源，宿主保持一份独立常量 + 单测锁一致**。理由：
- 迁移真相源意味着改 `src/` 里建一份镜像又要维持双份同步，违背「单真相源」初衷；宿主抽 `credits.ts` 的 provider 分派本就要按 provider 写死 claim 分支（协议不同无法靠一张布尔表驱动），额外一张 bool 表收益为零。
- **方案**：在 `src/credits.ts`（或新建 `src/checkin-eligible.ts`）导出 `const CHECKIN_ELIGIBLE_PROVIDERS: ReadonlySet<string>`（五条），sweep 只遍历它；`tests/unit/credits-capabilities.spec.ts` 补一条断言：宿主集合与客户端 `supportsDailyCheckin` 为 true 的集合**相等**，且包含恰好这五个（qoder 不在内）。这样两处漂移会被测试当场抓红，而能力语义仍各自清晰。

## 7. 客户端触发（挂载点）

`plugin-src/client/account-hub.js` 的 **`ProviderPanel`**（函数作用域，`loadAccounts` 所在层级，构造 `state` 之后 `useEffect` 之前）：
```ts
// 挂载/provider 变化时：拉取本 provider 签到状态（轻量，读内存不联网）
if (supportsCredits) void rpcCall('credits.checkinStatus', { provider })
```
放在 `React.useEffect(() => { void loadAccounts(); ... }, [provider])` **内部的同一 effect**、`loadAccounts` 之后（可用 `accountsRef` 避免并发读到空数组，与 `loadCredits` 同款）。签到状态存本地 hook `checkinsByAccount: Record<accountId, { day, checkedInToday }>`。`ClaimNotice` 摘要流已在 `claimCredits` 处理，自动签到的状态回传改走 `checkinsByAccount`。**头部「一键签到」按钮 = 现有 `claimCredits` 的 `credits.claimAll` 路径保留下，但改文案/色为「一键签到」（见第 9 节）**，或改调 `checkin.perform`（无 accountId）。**单片「签到」按钮 = 新增 `onCheckin(account.id)`，调 `checkin.perform { provider, accountId }`，成功后 `setCheckinsByAccount` 对该账号置今日**。

> ⚠️ **就绪判据是「已结算」而不是「列表非空」**（2026-09-24 修复）：自动补签的触发依赖只有两个**完成信号** —— `checkinStatusLoaded`（状态已落地）与 `accountsLoaded`（`loadAccounts` 已结算，**成败都置真**）。不能把「账号就绪」编码成「`accounts` 数组的引用变化」：列表结算为**空数组**或**读取失败**时那个引用再也不会变，本次挂载的自动补签就被静默吞掉（界面正常、签到一声不响地没发生）。本地列表为空**不构成**跳过理由 —— `checkin.perform` 不带 accountId 时目标集合由**宿主**按自己的账号池决定。客户端不掌握列表时也不得用 `[].every()`（恒真）判「已全部签过」。

## 8. UI 规格

- **单片按钮**（`AccountCard` 的 `dim-ah-accountActions` 行，`重测/重置/停用/删除` 同排，放在最前）：仅 `supportsCredits` 时渲染。文案状态机：`checkedInToday ? '已签' : (checkingThisAccount ? '签到中…' : '签到')`；`disabled` = `busy || checkedInToday || checkingThisAccount`。**禁用态数据来源**：`checkedInToday` 由 `credits.checkinStatus` 带回（读内存），单签成功后再由 `checkin.perform` 的响应更新本地 `checkinsByAccount`。
- **头部按钮**（`dim-ah-headerActions` 现有「一键领取积分」位）：文案 `claiming ? '签到中…' : allCheckedIn ? '全部已签' : '一键签到'`；`disabled` = `claiming || accounts.length === 0 || allCheckedIn`。`allCheckedIn = accounts.length > 0 && accounts.every(a => checkinsByAccount[a.id]?.checkedInToday)`，由 `credits.checkinStatus` 数据派生。**背景绿色**：见下。
- **绿色样式（已废止，2026-09-25 控件迁移）**：曾用 `data-kind="success"` + 自绘绿色（`#22c55e`）。控件迁移后按钮一律是 ui-primitives 的 `Button`，而它只有 `primary` / `ghost` / `outline` / `toolbar` 四种变体 —— 给插件造一个私有 `success` 变体等于在插件里重开一套配色，正是迁移要消除的东西。故：
  - **头部「一键签到」用 `variant: 'primary'`**，成功 / 进行中 / 已全签三态由**文案**表达（`'签到中…' / '全部已签' / '一键签到'`），颜色交给设计体系；
  - **单片「签到」用 `variant: 'outline'`**，状态语义由文案与 `disabled` 承载；
  - 状态类信息（如「已启用 / 已停用」）改用 `Tag`（tone）与 `StateDot`（state）表达，而不是给按钮换颜色。

  回归护栏：`credits-capabilities.spec.ts` 断言源码里**不再有** `'data-kind': 'success'`，且样式表里不再有十六进制色值。

## 9. 边界语义

- **失败不写状态**：`checkInIfDue` 对 `inactive`/`failed` 一律不写今日（第 2 节），下次触发重试。
- **停用账号是否参与**：**建议参与**（与现有 `credits.claimAll`/`credits.status`「含已停用」约定一致——停用只影响账号池自动选号，不影响签到）。理由：用户停用只是不想它被自动选中发请求，签到是白拿积分、且手动「一键领取」本就含停用，自动签到与它对齐最不意外。⚠️ **留「待拍板」**：若希望停用不自动签（省请求），改为 `checkInIfDue` 对 `!account.enabled` 直接返回 `skipped` 且不写状态即可，改动一行。
- **无账号 provider 跳过**：`dailyCheckin` 为 false 的 provider 根本不遍历；某 provider 无账号（`listAccounts` 空）时直接跳该 provider。
- **并发防重**：4h 定时器、启动 sweep 与页面触发（`checkin.perform` / `checkin.sweep`）可能同时跑。**方案：宿主模块级互斥信号量** `checkinBusy`（原名 `sweepRunning`，2026-09-24 扩为**共享**锁），入口 `if (checkinBusy) return`（已跑则本趟跳过，不排队不重入）。**不做跨实例分布式锁**（单宿主单进程语义足够）。
- ⚠️ **面板单发与 sweep 必须共享同一把锁**（2026-09-24 修复，原设计的缺口）：`checkin.perform` 与 sweep 签的是**同一批账号**（不带 accountId 时目标集就是该 provider 的全部账号），而旧实现里互斥只覆盖 sweep 内部 —— 两路可以对同一账号**各发一次 claim**。原设计认为「几乎不可能被两路真正走到 claim；即便竞态，后到者拿到 already-claimed 也写今日，结果一致」，这个推理**对 trae-cn 不成立**：它的 9074 处置会**各自换签到设备号并各自落盘**（`claimTraeCnWithDeviceRotation` → `persistRotatedDeviceId`），后写覆盖先写 ⇒ 盘上留的可能是**另一路**用的号（下一轮又从旧号起步白撞一次 9074），或者「这一发成功了、盘上却是另一个号」。故被挡方的语义按路分开：
  - sweep 被挡 → `{ running: false, providers: [] }`（既有形态）；
  - 面板单发被挡 → `RpcCheckinPerformResponse.busy = true` + 空 `results`/`summary`、**零 claim**（客户端据此区分「被挡」与「跑了但没账号可签」；自动补签静默、手动按钮提示「已有签到正在进行」）。
  另有一条**顺序约束**：取锁必须在第一个 `await` 之前（`if (checkinBusy) return …; checkinBusy = true` 之间隔着 `pool.listAccounts` 的话，两个同 tick 的调用会双双看到「空闲」）。

## 10. 测试计划

宿主侧（`tests/unit/`，Vitest，纯 mock 无网络）：
1. `today-day`：`todayDayNumber()` 的本地口径与跨日翻转（固定 fake Date）；
2. `check-ins-map`：`sanitizeCheckins` 脏值丢弃、`emptyAccountHubDocument` 带第五字段；
3. `checkInIfDue-dispatch`：day===today 短路不调 claim；day!==today → 调 claim；`claimed` 与 `already-claimed` 都写今日；`inactive`/`failed`/网络异常不写（注入 mock claim/凭据解析）；
4. `sweep-order`：仅遍历 `CHECKIN_ELIGIBLE_PROVIDERS`、无账号跳过、含停用、互斥信号量防重入（并发两路 only 跑一次）；
5. `rpc-case`：`credits.checkinStatus` / `checkin.perform` / `checkin.sweep` 请求/响应形态（复用既有 `collect*` 测试的注入手法）；
6. 能力一致断言（第 6 节）：宿主集合 === 客户端 `supportsDailyCheckin` 真集合，且恰为五条（qoder 不在）。
客户端 `plugin-src/` 不在 typecheck/test 视野（vitest 只跑 `tests/unit/**`，`plugin-src` 不在 tsconfig include，react 不在依赖）——**客户端只能靠 `build:client` 顶层求值冒烟**（`plugin-src/client/build.mjs` 的 stub 闸门，现有 `pnpm build:all` 已含）+ 既有 `credits-capabilities.spec.ts` 的**源码级正则断言织补**（新增断言守「单片按钮存在且走 `supportsDailyCheckin` 门控」「`checkinStatus` RPC 字符串存在」「成功 data-kind」），写明这是**唯一语义防线**。

## 11. 留给本体拍板的分叉清单

1. **值格式**：纪元日数（推荐，本文采纳）vs `'YYYY-MM-DD'` 字符串。
2. **schemaVersion**：bump 到 2（推荐）——是否值得动（影响不大）。
3. **停用账号是否自动签**：参与（推荐，对齐 claimAll）vs 跳过（省请求）。
4. **头部「一键签到」**：复用 `credits.claimAll` 只改文案/色（改动最小）vs 改调 `checkin.perform`（无 accountId，复用携带状态的返回）。建议复用 claimAll + 事后刷新状态。
5. **qoder 国际版**：是否接入（并行任务定，本文仅留 `CHECKIN_ELIGIBLE_PROVIDERS` 占位）。
6. **孤儿清理时机**：仅账号删除时 vs 删除 + 面板打开时兜底（推荐后者）。