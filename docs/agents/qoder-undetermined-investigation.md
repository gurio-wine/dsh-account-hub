# Qoder 系「全部账号无法判定」真机调查（2026-09-24；设备身份补证 2026-09-25）

## 结论速览

用户报障「qoder + qoder-cn 全部账号显示无法判定」由**三个独立缺陷叠加**造成，
其中第一个缺陷包含按 region 分岔的两层缺头问题；前两个都在**查活动 / 判已领**链路上，
与用户「签到和检查签到的逻辑都有问题」的怀疑一致。**积分本身没有丢**（真机验证两个账号各 +100，落在 `addOnQuota` 池）。

| # | 根因 | 性质 | 影响面 |
|---|---|---|---|
| 1 | 活动列表请求缺 region 所需请求头：两区缺 `Cosy-ClientType`；**国际版还缺完整设备身份头** ⇒ 服务端回空列表 | **代码 bug** | 两区均受影响；国际版即使补 `Cosy-ClientType` 仍会发生 |
| 2 | 服务端明说 `CLAIMED` 时被判成 `undetermined` | **代码 bug** | 两区，**签到成功后必然发生** |
| 3 | 签到成功那一刻恰好落在 `CLAIMED` 分支 ⇒ 不写状态 ⇒ 下轮 sweep 重试又走 #2 | **#1+#2 的复合后果** | 死循环形态 |

⚠️ **「空活动列表 = 协议无法区分」这一 60f8127 的定案前提被真机推翻**：
空列表是**请求缺少 region 所需头集的产物**，不是服务端事实。CN 缺 `Cosy-ClientType: 10`
时回空；国际版除该头外还必须有完整设备身份头，缺任一层都回空。带完整头集时，官方真实响应中
空列表不再出现。

---

## 根因 1：活动列表请求缺 region 所需请求头（决定性）

### 证据：官方桌面端源码

`D:\Programs\Qoder\resources\app.asar` 里的 `campaignMainService`（压缩后变量名
`nK`，路径常量 `zJt = "/sash/api/v1/me/campaigns"`）对活动列表请求调
`createRequestHeaders` → `nativeCampaignRequestService.createAuthorizedHeaders`
→ `xJt`，后者组装的头**包含**：

```
Authorization / Cosy-ClientType / Cosy-Version / Cosy-MachineOS /
Cosy-MachineHostname / Cosy-MachineId / Cosy-MachineToken /
Cosy-MachineCode / Cosy-MachineType，UA 固定为 "Qoder"
```

其中 `Cosy-ClientType` 取自模块级常量
`yc = Object.freeze({ clientType: 10, businessProduct: "app", sessionType: "app" })`。
官方客户端还会按条件带 `Cosy-MachineOS` / `Cosy-MachineHostname` / `Cosy-MachineId`；
本次国际版探针锁定插件必须追加的集合是下表中的裸 `Qoder` UA、`Cosy-Version: 0.3.4`
与三项 `Cosy-Machine{Token,Type,Code}`，CN 不跟随这组设备头。

### 证据：官方桌面端自己打印的真实请求头

`~/AppData/Roaming/com.qodercn.app.stable/logs/*/main.log`（CN 官方桌面端）：

```
[Campaign] 活动状态请求发出 {"method":"GET","origin":"https://openapi.qoder.com.cn",
"path":"/sash/api/v1/me/campaigns","clientType":10,...
"requestHeaders":{"Accept":"application/json","Authorization":"[redacted]",
"Cosy-ClientType":"10","Cosy-Version":"0.3.4","Cosy-MachineOS":"<present>",
"Cosy-MachineHostname":"<present>","Cosy-MachineId":"<present>",
"Cosy-MachineToken":"[redacted]","Cosy-MachineCode":"<present>",
"Cosy-MachineType":"<present>","User-Agent":"Qoder"}}
```

### 证据：A/B 对照（同一账号、交错重放）

`tests/e2e/qoder-minimal-set-probe.mjs` 的 CN 对照，以及 2026-09-23 探针矩阵和
2026-09-25 两次国际版重放：

| 请求头 | qoder 国际版 | qoder-cn |
|---|---|---|
| 插件现状头（`src/qoder-product.ts` 的 `qoderJobTokenHeaders`：只有 `Authorization`/`Accept`/`Content-Type`/`User-Agent`） | `campaigns: []` | `campaigns: []` |
| **仅加 `Cosy-ClientType: 10`** | **仍为空列表（`claimable: false`）** | **2 条活动，含 `CLAIM_BENEFIT/CLAIMED`** |
| 再加完整国际版设备身份头（`UA=Qoder` / `Cosy-Version: 0.3.4` / `Cosy-MachineToken`/`Type`/`Code`） | **2 条活动，含 `CLAIM_BENEFIT/CLAIMED`** | 与上一行相同（CN 无额外增益） |

`tests/e2e/qoder-root-cause-crosscheck.mjs` 的交错重放与后续真机复测结论稳定：
插件现状头 `n=0`；CN 仅加 `Cosy-ClientType` 时 `n=2`；国际版仅加该头时
`n=0`，补齐完整设备身份头后 `n=2` —— **排除时间窗口 / 缓存解释**。

这补上了前一轮调查遗漏的第二层根因：国际版**缺设备身份头 → 服务端恒回空列表 →
三态判读找不到 `CLAIMABLE` / `CLAIMED` → `unknown` → claim/status 落入
`undetermined`**。只补 `Cosy-ClientType` 只能修 CN，不能替代国际版的
`runtime-info.exe` 设备身份来源。

### CN 的取值空间扫描（`qoder-clienttype-scan-probe.mjs`）

CN 活动端点的扫描结果：`1–7、9、11、12、20、100、0、-1、app、qodercli、空串` 全部回空列表；
**只有 `8` 与 `10` 返回非空**（`8` 只见 `VIEW_DETAILS`，`10` 见完整两条）。
`10` 正是官方 `yc.clientType`。

⚠️ 插件 CN 产品配置里已有的 `clientType: '5'`（`src/qoder-product.ts:1342`）
**实测无效** —— 那个值只用于 chat 请求体，与活动端点无关。

### 为什么 `parseQoderCampaigns` 不背这个锅

`parseQoderCampaigns`（`src/qoder-credits.ts:891-906`）对
`{"uid":…,"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}`
的解析是**正确**的：服务端确实回了空数组，代码如实解析成空数组。
问题在**请求没被服务端当成活动查询受理**：CN 缺 `Cosy-ClientType`，国际版还可能缺完整
设备身份头。于是响应的空列表进入三态判读后只能落在 `unknown` / `undetermined`，而不是
说明「今天没有活动」。
---

## 根因 2：服务端明说 `CLAIMED` 被判成 `undetermined`

### 代码位置

`src/qoder-credits.ts:1259-1271`：

```ts
const targets = claimableQoderCampaigns(parsed)   // 只留 CLAIMABLE
if (targets.length === 0) {
  return { kind: 'undetermined', message: '活动列表为空，无法判定…' }
}
```

`claimableQoderCampaigns`（`src/qoder-credits.ts:914-919`）只保留
`actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`。于是三种
**语义完全不同**的响应被压进同一个分支：

| 响应形态 | 应然判定 | 实判 | 裁决 |
|---|---|---|---|
| A. `campaigns: []` | `undetermined` | `undetermined` | ✅ 合理 |
| B. `[{CLAIM_BENEFIT, CLAIMED}]` | **`already-claimed`** | `undetermined` | ❌ **误判** |
| C. 只有 `[{VIEW_DETAILS, …}]` | `undetermined` | `undetermined` | ✅ 合理 |

### 真机复现

`tests/e2e/qoder-minimal-fix-e2e.mjs`（只补 `Cosy-ClientType: 10`，其余不改）：

```
qoder    修复后 status: dailyCredit=100 activityName="act-20260923-367"
         修复后 claim : {"kind":"undetermined", …}     ← 列表已非空，仍判 undetermined
qoder-cn 修复后 status: dailyCredit=100 activityName="act-20260923-076"
         修复后 claim : {"kind":"undetermined", …}
```

`tests/e2e/qoder-undetermined-misjudge-probe.mjs`（零网络桩）把四态钉死，
两区均报 `MISJUDGED`。

### 官方数据支持「B 应判已领」

`tests/e2e/qoder-desktop-campaign-timeline.json`（从官方 main.log 提取 47 条）：

- `CLAIM_BENEFIT` 的 `claimStatus` 只出现 `CLAIMABLE`(10) 与 `CLAIMED`(27)；
- 官方在 `claimable:false` 且列表含 `CLAIM_BENEFIT/CLAIMED` 时，
  语义就是「今天已领」（27 条这种形态，横跨 5 个账号）。

即 **`CLAIM_BENEFIT + CLAIMED` 是协议里唯一明确的「已领」证据**，
当前实现把它丢掉了。

### 后果（根因 3 的复合）

签到成功 → 活动变 `CLAIMED` → 下一次查询落到 `undetermined` →
宿主白名单（`src/account-hub-rpc.ts:1420`，只认 `claimed`/`already-claimed`）
**不写状态** → 下一轮 sweep 重试 → 又回 `undetermined` ——
用户看到的是**永久「无法判定」**，尽管积分早已到账。

---

## 附：积分去向（澄清一个易误判点）

真机 `--claim` 结果（`tests/e2e/qoder-minimal-headers-claim-probe.mjs`）：

```
CLAIM 200 {"grantId":"…","status":"CLAIMED","replayed":false,
           "benefit":{"kind":"CREDITS","amount":100,…},"claimedAt":"2026-09-23T18:01:31Z"}
```

积分**确实到账**，但落在 **`addOnQuota`（加量包）** 而不是 `userQuota`：

| 账号 | 领取前（插件口径三池合计） | 领取后 | 差值 |
|---|---|---|---|
| qoder 国际版 | 487（userQuota 287 + addOnQuota 200） | 587（287 + 300） | **+100** |
| qoder-cn Coria | 300（userQuota 300，**无 addOnQuota 池**） | 400（300 + **addOnQuota 100**） | **+100** |

⇒ **只看 `userQuota` 会误判成「没到账」**；插件口径 `qoderQuotaRemainingTotal`
（三池 `remaining` 之和，`src/qoder-credits.ts:712-714`）是**正确**的，
所以 2026-09-24 新增的「签到前后余额比对」在 qoder 上**不会**误报 `abnormal`。

✅ **到账时序已实测确认（无结算延迟）**：`qoder-minimal-headers-claim-probe.mjs`
在**同一次脚本执行内**「claim → 立刻查 quota」，两次都立刻看到 +100：

| 账号 | claim 前 | claim 后（立即） | 差 |
|---|---|---|---|
| qoder 国际版 | 487（addOnQuota 200） | 587（addOnQuota 300） | +100 |
| qoder-cn Coria | 300（addOnQuota 缺席） | 400（addOnQuota 100） | +100 |

⇒ qoder 两区的余额比对**前提成立**，无需像 `trae-cn` 那样登记豁免。

---

## 修复建议清单（历史记录；后续已全部落地）

### 必做

1. **按 region 补齐活动列表请求头**（根因 1）。两区都要有
   `Cosy-ClientType: 10`，且只作用于 `/sash/` 前缀端点 —— 不要污染 chat /
   quota 的既有头（出站协议值红线）。CN 到此为止；国际版还要追加
   `User-Agent: Qoder`、`Cosy-Version: 0.3.4` 与 `Cosy-Machine{Token,Type,Code}`。
   设备三值由官方桌面客户端 `runtime-info.exe` 运行时取得，失败时回到现状头集并走
   `undetermined` 兜底；不能把该身份猜测、拷贝、分发或落盘。不要复用现有
   `clientType: '5'`（它是 chat 请求体字段，对活动端点无效）。
2. **修 `claimQoderDailyCheckin` 的空目标分支**（根因 2）。
   在 `targets.length === 0` 之前，先判「是否存在 `CLAIM_BENEFIT` 且
   `claimStatus === 'CLAIMED'` 的条目」：有 ⇒ `already-claimed`；
   无 ⇒ 保持 `undetermined`。这能把「服务端明说已领」与「真不确定」分开，
   且**不会**重蹈 60f8127 之前「空列表即已签」的覆辙（空列表仍判 undetermined）。
3. **同步修 `fetchQoderCheckinStatus`**（`src/qoder-credits.ts:1100-1114`）：
   `todayCheckedIn` 当前**恒为 `false`**（注释明写「恒为 false」）。修 #2 后
   应改为「有 `CLAIM_BENEFIT/CLAIMED` 时为 true」，否则 UI 仍显示未签。

### 建议

4. 补 e2e 用例，把「CN 缺 `Cosy-ClientType` ⇒ 空列表」与「国际版仅有
   `Cosy-ClientType` 仍为空、补齐设备身份头后有活动」都钉住，防止将来有人简化请求头
   时静默复发。
5. 更新 `docs/agents/providers-qoder.md` 与 `src/qoder-credits.ts` 模块头：
   **「空列表 = 协议无法区分」的定案前提已被推翻**，且旧的「设备头全部非必需」
   只对 CN 成立；国际版必须运行时获取设备身份。
6. 重新评估 `src/checkin-schedule.ts` 里 qoder 两区的余额比对登记：
   口径正确（三池合计）且**到账无延迟**（已实测），故**保持参与比对**，
   无需登记豁免。仅需注意未来若改为只读 `userQuota` 会立刻失效。

### 取舍裁定（已落地）

- `Cosy-ClientType` 归为模块级常量 `QODER_CAMPAIGN_CLIENT_TYPE = 10`，两区同值，
  不复用 chat 请求体的 `clientType`。
- 设备身份是否启用归为 `QoderProduct.campaignDeviceIdentity`：仅国际版声明 `true`；
  CN 不声明，因此即便误传身份也不改变 CN 出站头集，且不会调用 `runtime-info.exe`。

---

## 修复落地（2026-09-24 至 2026-09-25）

本节记录上述清单的实际落地形态：2026-09-24 落地 `Cosy-ClientType` 与三态判读修复，
2026-09-25 补上国际版设备身份头的运行时获取与降级路径。**探测单正文（含结论与证据）
保持原样未改** —— 它是取证记录；本节只登记实现边界。

### 取舍裁定：取值做成**模块级常量**，不进 `QoderProduct`

`QODER_CAMPAIGN_CLIENT_TYPE = 10`（`src/qoder-product.ts`，与
`qoderJobTokenHeaders` 相邻）。理由：真机两区**同值**，做成产品字段只是
「将来可能要分叉」的预付成本；且它**不是出站身份标识**（不像 `userAgent` /
`clientType` 那样按 region 归因用量），做成常量不会让「region 差异走产品配置」
这条约定失真。若将来某区确需不同值，改法是把常量搬进字段（一处引用点）。

### 作用域：`qoderCampaignHeaders`（新函数），**不**改 `qoderJobTokenHeaders`

`qoderJobTokenHeaders` 被 quota / chat / userinfo / 目录**多条**链路共用，
「加 `Cosy-ClientType` 对它们的影响」从未验证 ⇒ 按出站协议值红线**一个字符都不动**。
新增 `qoderCampaignHeaders(jobToken, product, accept)` = 前者 + 该头，**只有
`src/qoder-credits.ts` 的 `sendQoderCheckinRequest`（`/sash/` 的 GET 与 POST
两条）**用它。

两道守卫用例把这条边界钉死：

- `tests/unit/qoder-checkin-credits.spec.ts`：「quota 请求**不带**该头」（纯函数层）；
### 国际版设备身份头（2026-09-25）

`QODER.campaignDeviceIdentity = true` 时，`sendQoderCheckinRequest` 在 401 重试循环外
调用 `getQoderMachineIdentity` 一次；同一次调用得到的身份同时用于活动列表 GET 与 claim POST。
来源是官方桌面客户端自带的 `runtime-info.exe`：异步 `execFile`，参数
`--account-stdin`，从 stdin 传入账号 JSON。三值按 `product.id` 只做进程内缓存，失败不缓存，
也不落盘；与 wasm 提取遵循同一纪律（不拷贝、不分发、不落盘）。取值形态只记诊断，
不作为拦截条件。

头集为 `Cosy-ClientType: 10`、`User-Agent: Qoder`、`Cosy-Version: 0.3.4`、
`Cosy-MachineToken`、`Cosy-MachineType`、`Cosy-MachineCode`。CN 不声明
`campaignDeviceIdentity`，不调用 exe，误传身份也不改变 CN 出站头集。国际版在非 Windows、
找不到 exe、调用失败、超时或输出畸形时回到现状头集，随后按既有三态逻辑进入
`undetermined` 抑制兜底。


`'claimable' | 'claimed' | 'unknown'`，由 claim 与 status **两路共用**：

- `claimQoderDailyCheckin`：`targets.length === 0` 时先看判读 —— `claimed` ⇒
  `already-claimed`（今天已领取）、否则维持 `undetermined`；
- `fetchQoderCheckinStatus`：`todayCheckedIn = (dayState === 'claimed')`
  —— **不再是恒 false**（缺陷 3 修掉），且 `unknown` 仍如实报未签。

顺序是**先 `claimable` 后 `claimed`**：多活动账号可能一条已领、另一条可领，
那时今天显然还没领完，必须去领。判据**必须同时看 `actionType`**：
`VIEW_DETAILS` 型活动的 `CLAIMED` 与积分签到无关（只按 `claimStatus` 判会把
「看了个详情页」写成「今天已签」—— 与 60f8127 之前「空列表即已签」同款的伪造签到）。

### 未改动的三处（清单里点名的「保持不动」）

1. **余额比对**：qoder 两区**参与**比对（三池合计口径正确、到账无延迟），
   `BALANCE_COMPARISON_EXEMPT_PROVIDERS` **未加** qoder；
2. `trae-cn` 等其它 provider 零改动；
3. `parseQoderCampaigns` 的解析层零改动（它本来就如实解析，锅在判读与请求头）。

### 措辞的连带更正

本模块与文档里所有「空列表 ⇒ undetermined / already-claimed」的措辞一律改为
「**补齐该 region 所需头集后仍空** ⇒ …」—— CN 缺 `Cosy-ClientType`、国际版缺设备身份
时的空列表都是**缺头假象**（已修），补齐对应头集后仍为空才是真判不了。这条限定语是
本次修复的**语义核心**，简写回去就等于把根因 1 又埋进注释。

---

## 证据文件清单

探针脚本（`tests/e2e/`，全部可复跑）：

| 脚本 | 作用 |
|---|---|
| `qoder-campaigns-probe.mjs` | 两区全账号活动列表原始响应 + 鉴权对照 |
| `qoder-desktop-log-extract.mjs` | 从官方 main.log 提取活动响应时间线（47 条） |
| `qoder-header-ab-probe.mjs` | 头组合 A/B（UA / Cosy-* / 官方全套） |
| `qoder-official-headers-probe.mjs` | 官方完整头 + 逐头消融矩阵 |
| `qoder-minimal-headers-claim-probe.mjs` | 最小头复现 + **真签**（`--claim`） |
| `qoder-claim-headers-probe.mjs` | claim 端点是否依赖该头（幂等探针） |
| `qoder-credit-accounting-probe.mjs` | 积分口径 / `outerProviders` 参数影响 |
| `qoder-all-pools-probe.mjs` | **全池**积分 dump（定位 addOnQuota 落点） |
| `qoder-clienttype-scan-probe.mjs` | `Cosy-ClientType` 取值空间扫描 |
| `qoder-minimal-set-probe.mjs` | 最小必需头集合测定 |
| `qoder-root-cause-crosscheck.mjs` | 交错重放 + 产品代码全链路（补头前后） |
| `qoder-undetermined-misjudge-probe.mjs` | 零网络四态裁决（根因 2） |
| `qoder-minimal-fix-e2e.mjs` | **最小修复**端到端验证（含宿主链路） |

对应 `*-evidence.json` 为原始响应留档（含完整响应头与正文）。

## 探针调查阶段的约束记录

- ✅ 探针调查阶段未改任何 `src/` 产品代码与单测（后续修复落地见上文）。
- ✅ 未调 chat 端点（不消耗模型积分）。
- ✅ 探针阶段只在请求头层做 A/B，未动源码常量。
- ✅ 签到为「领积分」操作，用户已明确授权；两个账号各 +100 真实到账。
