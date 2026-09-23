# Account Hub 存储与通用机制 实现细节

本文件由 AGENTS.md 迁出，供实现/维护时查阅。

## 存储与通路

**存储与通路**：账号池持久层是 **`ctx.storage` 的 storage 域**（`dsh_account_hub` → `$DSH_HOME/storages/dsh_account_hub.json`，single 布局 + 一个 global 单例文档，八件套 `accounts` / `disabledModels` / `contextBudgets` / `checkins` / `consumption` / `consumptionCursors` / `schemaVersion` / `providerAuditVersion`，末三件见「账号消耗顺序与切换粒度」与「provider 体检迁移」两节）。`contextBudget` / `writeContextBudget` 读写第四件；`writeAccounts` / `writeModels` / `writeBudgets` / `writeCheckins` / `writeConsumption` / `writeConsumptionCursor` / `replaceAll` **八件套互带**、都汇入唯一写落点 `persist()`，且都**先 `ensureLoaded()`**（它们不过读路径，漏了就整体写空）。**降级矩阵** = storage 为主 → 旧 settings（`jet-hub` namespace，**历史兼容读取，勿改**）回退 → 纯内存兜底；`apply()` 里 `await pool.openStorage()` **必须早于改名迁移**（它内部重置载入标记，切换点不留数据分叉）。**一次性迁移**（`account-hub-migration.ts`）：storage 无账号数据且能读到旧来源时把 `jet-hub` 段原样搬入，来源优先级 `settings.yaml.imported` → `settings.yaml` → 旧 scope；只读来源 / 幂等 / 空表不落 / 失败不半途覆盖。⚠️ **provider 改名迁移（`provider-rename-migration.ts`）不是「只搬账号与黑名单」**：它的 `replaceAll` 必须携带全部八件套，否则一次改名就会把用户配好的消耗顺序与轮转进度一并清零（有测试断言键集合）。⚠️ **storage 域名只接受 `^[a-z][a-z0-9_]*$`（连字符不合法）**，故是 `dsh_account_hub` 而非插件 id；⚠️ 域打开后**必须 `ctx.effect` 登记 `domain.close`**（facility 按域名单开）；⚠️ **不引 YAML 依赖**：`simple-yaml.ts` 只取目标一节，不支持的构造（锚点/别名/块标量）显式抛错。⚠️ `LlmRuntime.listModels` 会重建条目、丢掉额外字段，`ctx` 也没有「按 provider 取适配器」的入口 ⇒ 由 `register*Llm` **返回适配器实例**经上述参数注入；省略时 `model.list` 不带窗口字段、`setContextBudget` 一律拒绝（headless / 测试的既定降级）。⚠️ **回填行（被关闭的模型）与目录行必须带同一组窗口字段**。⚠️ 客户端 `ModelToggle` 根节点是 `div`、`label` 只包「名称 + 显示开关」，**档位 radio 必须在 label 之外**（放进去会连带翻转显示开关）。

⚠️ **`openStorage()` 返回被缓存的同一个 Promise，可安全重入**：早期实现只用布尔闸门（`if (storageOpened) return this.storage !== undefined`），于是**首次打开仍在途**时第二次调用会以 `false` **提前 resolve** —— 挂在它 `.then()` 上的启动逻辑（改名迁移、Qoder 资料回填、自动签到 sweep、续期调度判据）全都在 storage 真正接管**之前**跑，读到旧 settings/内存快照。**任何「读池前必须等 storage」的启动逻辑都必须挂在这个 Promise 上**，不要改回布尔闸门；也不要在 `apply()` 的**同步**执行期直接读池（那时 storage 一定还没接管）。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 **storage 域** `dsh_account_hub` 里保存账号索引（旧 settings 的 `jet-hub` namespace 仅作回退路径，见「存储与通路」），凭据本体存于 `ctx.credentials`：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤；**适配器必须以 `this.product.id` 作为 provider 实参查询账号池**（写死 `'buddy-cn'` 会让 Buddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的**下一个账号**自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`；**数组顺序即候选优先级**（`reorderAccounts` / RPC `account.reorder`），勿加按限流重置时间重排候选的 sort。**客户端拖拽排序已接线**（`plugin-src/client/account-order.js` 出落点、`account-hub.js` 的 `ProviderPanel.commitOrder` 发 RPC）：本地乐观更新 → 发 RPC → 失败回滚并提示；`orderedIds` 必须是该 provider 全部 id 的排列，否则本端点回 `bad-request`（那条错误正是客户端回滚路径的触发源）。顺序与「消耗顺序」档位是**两个维度**：档位决定在这个顺序上怎么取号（取第一个 / 轮转 / 按余额优先），拖拽决定顺序本身
- **凭据必须在发请求前按目标模型挑选**：`resolveCredential` / `refresh` 都接受可选 `model` 参数，适配器的 `stream()` 必须把 `options.model` 传下去（`src/index.ts` 的 `makeCredentialResolver` / `makeAccountPicker` 是**各 provider 共用的唯一接线**，新增 provider 一律走它们，不要再写一份）。`getAvailableAccount` 的限流过滤是**逐模型**的，传空串时按设计不过滤 —— 传空串会让每次请求都先白跑一遍已限额/积分耗尽的账号。**仅 `fetchModels` 拉模型目录**（目录对所有模型一致）与「全部账号都在冷却期」的退化路径用空串，两者都刻意保留，不要改成「一并过滤」

## 模型黑名单（Account Hub「模型列表」开关）

`disabledModels` 字段保存被关闭的模型（旧 `jet-hub` 仅作回退读取）：

- **黑名单制**：键为 `true` 才隐藏，未记录默认打开（新模型自动可见）；过滤点在适配器 `listModels`，每次实时读 `pool.disabledModelsFor(provider)`
- **只影响播报、不影响路由**（DSH 约定：目录仅供参考）：被关闭的模型仍可 `resolveModel` / 正常收发；**无「凭据可解析」账号时 `listModels` 返回 `[]`**（隐藏整个分组；判据不看条目 / `enabled`；判定不可用则放行；开关 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 默认开；CodeArts 额外认单凭据 ref）
- `writeAccounts` / `writeModels` 是**整体 replace**，必须互带对方字段；改名迁移**对调式搬运** `disabledModels` 的 provider 键（`buddy`→`buddy-cn`、`workbuddy`→`buddy`），有测试（`src/provider-rename-migration.ts`）
- 设置页目录走适配器 `listAllModels()`（不套黑名单 / 门控，`registerAccountHubRpc` **第 11 实参**，第 10 是 `contextTiers`）；`CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`；RPC `model.list` / `model.setDisabled`，前端 `plugin-src/client/account-hub.js` 的 `ModelListPanel`

## 登录必须两段式：RPC 立即返回 loginUrl

`account.create` **不得**在 RPC 里等待用户完成浏览器登录：浏览器登录最长 10 分钟，等它返回时用户手势早已过期 —— 客户端拿到 URL 再开窗会被弹窗拦截，兜底逻辑于是自行开窗，把 DSH 页面顶掉。正确形态（`src/account-hub-rpc.ts`）：

1. **第一段（同步返回）**：先拿到 `loginUrl`（buddy 系 `fetchAuthState`、lobsterai 的 `prepareLogin`），`pool.addAccount` 写入**占位条目**（`refreshable: false`、无 `expiresAt`），立即 `return { ok: true, value: { accountId, loginUrl } }`；
2. **宿主 opener 置空**（`openBrowser: () => {}`）—— 打开动作归客户端，宿主再开一次会变成两个标签页；
3. **第二段（后台）**：登录完成后写凭据、`pool.updateAccount` 补全 `nickname`/`expiresAt`/`refreshable`；失败则 `pool.removeAccount` 移除占位，避免留下无凭据的幽灵账号。

配套约束：`login.poll` 按 credentialRef 判断「凭据是否可解析」，与 provider 无关；**占位账号字段是 pending 形态**，时序上必须**先写凭据、再补全账号**（反过来会让轮询在凭据就绪前报成功）；**LobsterAI 登录是 provider 级互斥的**（`prepareLobsteraiLogin`）—— 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`，不新建也不复用（复用会让一份凭据被多个占位 accountId 共享，静默新建则每次点击堆积一个 loopback 端口直到 10 分钟超时）；`account.delete` 会 cancel 对应会话以释放端口。

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值，跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。

## 上下文窗口档位：来源与注册表

**档位来源与注册表**：`src/context-tiers.ts` 是档位通用机制（`availableContextTiers` / `effectiveContextWindow` / `createContextTierRegistry`），`src/index.ts` 用 `createContextTierRegistry({ [TRAE_CN.id]: …, [BUDDY_CN.id]: …, [BUDDY.id]: …, [QODER.id]: …, [QODER_CN.id]: … })` 作为 `registerAccountHubRpc` 的**第 10 个实参**注入（键取 `*.id`，别写字面量）。**只有 buddy 系（`supportedLengths`）与 qoder 两区（`available_context_windows`）有档位数据源**，trae-cn 的档位数据源见 docs/agents/providers-trae-cn.md；**lobsterai 没有档位源 ⇒ 不显示档位 UI**（不是遗漏）。

## poolProviderFor 与刻意不经过映射的入口

⚠️ **「选显示哪个积分池」不走 `poolProviderFor()`**：`traeCnPoolFor()` 已随 Work 路径删除，trae-cn 面板显示哪个池见 docs/agents/providers-trae-cn.md「积分余额」一节。账号映射与选池**不可合并** —— 用池键查账号会让面板空白；`TRAE_CN_POOL_WORK` / `TraeCnPoolId` **仍保留**（服务上游 `available_endpoint` 分池字段与礼包归类，非 provider 专属）。

⚠️ **刻意不经过映射的两个入口**：**`account.create`**（它按 provider 解析产品配置决定「登录怎么做」，映射会给同一份凭据建出第二个占位账号，等于把一个账号建两遍）；**`model.list` / `model.setDisabled`**（黑名单按 provider id 存，映射会把一个 provider 的开关写进另一个的黑名单）。`credits-capabilities.spec.ts` 的「集合相等」断言已同步到七条，并断言**没有条目声明 `loginHint`**（每个面板都自带「登录账号」入口）。

## 账号消耗顺序与切换粒度

**两个 per-provider 选择器**（Account Hub 每个 provider 面板顶部、账号卡片列表之前，并排两个原生 `<select>`、各占一半宽）。唯一真相源是 `src/account-consumption.ts`（纯逻辑、无 ctx/IO），它同时承载取值域、默认值、候选重排与两个有界状态。

| 选择器 | 档位 | 语义 |
|---|---|---|
| 消耗顺序 | `sequential` | 永远取当前排序第一个可用账号 |
| | `round-robin`（默认） | 每次请求按账号顺序轮转下一个（a→b→c→a） |
| | `highest-balance` | 每次请求取可用账号里积分余额最高的；**余额未知/过期时降级回顺序** |
| 切换粒度 | `per-request` | 每次请求都按消耗顺序重新选号 |
| | `per-turn`（默认） | 一轮对话内锁定同一账号，新轮次才重选（用户拍板的保守档：上下文连贯，也避免部分后端按会话绑定凭据） |

⚠️ **默认档从 `sequential` 翻成 `round-robin`（用户拍板）**：存量用户没动过配置的会从「固定第一个账号」变为「逐请求轮转」。**不提升 `ACCOUNT_HUB_SCHEMA_VERSION`、不做数据迁移** —— 版本号表达的是**字段集合**而非取值语义，而这次只动了 `DEFAULT_CONSUMPTION` 的取值：旧文档里没有 `consumption` 条目，读出来即新默认值；显式写着 `sequential` 的旧条目现在是一份**真实配置**（`sanitizeConsumption` 的「等于默认值不留」判等用的是 `DEFAULT_CONSUMPTION` 本身，剔除的键自动跟着翻转，没有第二份需要同步的名单）。

**存储七件套**：`AccountHubDocument` 新增 `consumption`（`provider → { order, switch }`）与 `consumptionCursors`（`provider → 下一个该用的 accountId`）。它们与既有五件套是**同一份文档**，故必须逐点串进 `emptyAccountHubDocument()` / `sanitizeAccountHubDocument()` / `persist()` 两条分支 / `writeAccounts` / `writeModels` / `writeBudgets` / `writeCheckins` / `writeConsumption` / `writeConsumptionCursor` / `replaceAll` / `ensureLoaded()` 两分支 —— **漏一处就被静默清空**。`ACCOUNT_HUB_SCHEMA_VERSION` bump 到 **3**（此后因第八字段 `providerAuditVersion` 再 bump 到 **5**，见下节）；⚠️ `ACCOUNT_HUB_DOMAIN_VERSION`（文件格式版本）**保持 1**：storage 后端不校验字段集合，加字段不破坏既有文件。

**等于默认值的条目不留**（读入与写入两侧同口径，复用同一个 `sanitizeConsumption`）：否则「用户从没配过」与「配成了默认值」在存储文件里长得一样。非法档位在 `AccountPool.writeConsumption` **抛错拒绝**（RPC 把它原文回给客户端，那句里带着可选值）。

**选号落点**：`AccountPool.getAvailableAccount(provider, modelId, excludeAccountIds?, pick?)` 新增第四个**可选**参数。⚠️ **不传 `pick` 时行为与改动前逐字段相同**（恒取第一个可用账号）—— `buddy-auth` / `lobsterai-auth` 的 `fetchModels`（拉目录）与四个适配器的**换号重试循环**都靠这条不被影响。适配器路径传 `pick`，由宿主 `makeAccountPicker` 把 `options.signal` 经模块级 `TurnKeyTracker` 换算成轮次键。

⚠️ **轮次 = `options.signal` 的身份**，不是 `sessionId`：DSH 的 `GenerateOptions` 里**没有任何 turn 级字段**，而 `sessionId` 是**会话级、跨轮稳定**（`packages/core/agent-loop/src/agent.ts` 的 `buildRequest` 恒传 `this.session.id`），拿它当轮次键会让「按轮次」退化成「按会话」（一个会话永远只用一个账号）。真正「同轮恒定、跨轮必变」的只有 signal：agent-loop 每开一个 turn 换一次 `AbortController`（`turn()` 末尾 `phase.abort = new AbortController()`），同轮内多个 step 共用一个。因此 `TurnKeyTracker` 用 WeakMap 按**对象身份**发号（不阻止 GC）。⚠️ 适配器的**每一处** `resolveCredential` / `refresh` 都必须带这个实参：漏传任何一处，那条路径就绕过轮次锁、按顺序挑回第一个账号（续期路径上表现为刷新了别的账号的凭据 —— S1 缺陷换个触发条件复现）。`tests/unit/account-consumption-rpc.spec.ts` 有静态断言钉死。

**两个有界状态**（都在池内、**都不落盘**）：
- **余额缓存**（`BalanceCache`，TTL **5h**）：宿主侧维持，启动后刷一次 + 每 4h 刷一次（`src/index.ts`，与签到 sweep 同款 `setInterval` + `unref` + `ctx.effect` 形态，时序必须挂在 `openStorage()` 之后）。⚠️ **刷新间隔必须严格小于 TTL**（现为 4h < 5h，留 1h 余量）：过期判据是 `now - fetchedAt >= TTL`，两者相等时刷新只要晚一拍（定时器抖动 / 单次查询失败）就会出现整段缓存空窗 —— 那段时间「最高优先」档静默降级回顺序档。⚠️ **只刷配置了 `highest-balance` 的 provider**（刷新是逐账号一次网络请求，为没开那一档的白打请求没有意义），过滤收在 `refreshConsumptionBalances` 内部（唯一实现）。余额是秒级可变的远端事实，故**不落盘**：过期即降级回顺序，代价只是一次保守选号。
- **轮次锁**（`TurnAccountLock`，LRU 上限 100）：按会话累积而 DSH 不暴露「会话已结束」信号，不设上限就是确定的泄漏。`get` 命中时刷新最近使用次序（否则长会话每轮都被淘汰，粒度档形同虚设）；锁里的账号必须**仍在本次候选里**才算命中，因此「锁住的账号刚被停用/限流」自然走重新选号 —— 锁自愈不需要任何额外失效判定。

**余额与选号共用同一条收集实现**（`collectProviderBalances`，模块级）：RPC `credits.balances` 与宿主余额刷新都调它 —— 各写一份分派必然漂移，而漂移的形态很隐蔽：面板显示的数字与选号用的数字来自两套口径。

**「最高优先」档的余额缓存必须有三条填充路径，缺一就静默失效**（`highest-balance` 分支本身没写错，失效永远发生在「缓存从未被填充」上）：

1. **启动 + 每 4h 定时刷新**（`refreshConsumptionBalances`，只刷**当时**已配成该档的 provider）；
2. **`consumption.set` 切档补刷**：写入后若该 provider 的**权威配置**是 `highest-balance`，fire-and-forget 触发一次**白名单只含该 provider** 的刷新（自吞异常，不让网络故障把一次已落盘的配置写入报成失败）。⚠️ 判据读 `pool.consumptionSetting()` 而**不是 `req.order`** —— 界面是部分更新，只改粒度时请求里根本没有 `order` 字段。少了这条，用户中途切档就是「配了最高优先却一直用第一个账号」。
3. **`credits.balances` 顺手回写**：面板打开 / 点「刷新积分」查到的余额经 `recordCollectedBalances`（**与定时刷新共用的唯一写入口径**）写进缓存，只记 `balance !== null` 的（把「查不到」当 0 会让那个账号自锁）。这条同时兑现了上面那句「面板与选号同一口径」的承诺；对非该档的 provider 无行为差异（缓存只是被写，只有该档会读）。

**RPC**：`consumption.get` / `consumption.set`（**部分更新**，只改传进来的字段）。⚠️ 与 `model.list` / `model.setDisabled` 同一取舍：这两个配置按 **provider id** 存，**刻意不经过 `poolProviderFor()`**。写入后**不重建任何东西**：选号每次都实时读池里的配置，下一次请求即生效。客户端 `ConsumptionSelectors`（`plugin-src/client/account-hub.js`）是**受控组件 + 不做乐观更新**（与 `ModelToggle` / `ModelTierPicker` 同款），形态是**两个原生 `<select>`**（用户要求的形态；radio 组已整体替换）：值经 `value=` 受控（不在 option 上挂 `selected`）、`disabled` 绑 `busy`。⚠️ 客户端 `CONSUMPTION_DEFAULTS` 必须与宿主 `DEFAULT_CONSUMPTION` 逐字一致（`order: 'round-robin'`）—— 它是 `consumption.get` 失败时的兜底显示值，写错会让「读不到配置」看起来像「用户选了另一档」。版面：两个块 `flex: 1 1 0` + `min-width: 0` 等分容器（总宽 = 卡片宽）、容器**不换行**（需求是「同一排」）。

⚠️ **界面上刻意没有可见的设置名与解释文案，也没有外框**（用户明确要求「就两个下拉」）：可读名只在 `aria-label`（读屏），设置名 + 用途 + **每一档的含义**合并在 select 的 `title` 悬停提示里（`consumptionTooltip()`，首行「设置名：用途」、其后每档一行），option 各自再带自己的 `title`。删掉可见标签时**这两个属性一个都不能省** —— 否则「删了标签」等于「删了说明」。下拉与账号卡片之间**不再有任何提示段落**（原 `dim-ah-orderHint` 排序提示已删；「顺序即选号优先级」这条信息仍由卡片拖拽柄的 `title` 承载）。

## provider 体检迁移（`provider-audit-migration.ts`）

**修的脏数据**：账号条目的 `provider` 标签与它凭据的**真实归属**不符 —— 现场案例是
`BUDDY_CN_ACCOUNT_5C80F1BE` 里躺着 `iss=https://www.workbuddy.ai/auth/realms/copilot`、
`domain=www.workbuddy.ai` 的**国际版**一年期令牌，条目却写着 `provider: 'buddy-cn'`。

**成因（两处历史缺陷，都已关闭）**：`pruneAccountsWithForeignDomain` 早期**直接删号**；
`removeAccount` 早期顺序是「先 unset 凭据 → 再写账号列表」，两步间中断留下**孤儿凭据**
（ref 在、条目没了），下一次同前缀登录复用该 ref ⇒ 新凭据写进旧 ref、条目仍是旧标签。
现在的顺序是「**先写条目、后尽力 unset**」，中断最坏只留孤儿凭据（无害）。

**为什么它能活很久（闸门教训，别再犯）**：当年的体检闸门写成
`pool.schemaVersion >= ACCOUNT_HUB_SCHEMA_VERSION` —— 与**改名迁移共用同一个数字**，
而该常量在改名迁移落地当天就是 1 ⇒ 体检**永远 short-circuit**。现在体检用**自己的**
`providerAuditVersion`（`PROVIDER_AUDIT_VERSION = 1`，默认 0）：**字段集合版本与体检版本
各司其职，不许合并**。

**判据（两级，都不猜）**：首选 JWT 的 `iss`（`src/buddy.ts` 的 `jwtIssuer`，只 base64url
解码不验签）；无 `iss` 时回退凭据的 `domain` 字段并 `warn` 一条。期望域由
`src/product.ts` 的产品配置**派生**（`PROVIDER_ISSUER_PATTERNS`：品牌域 = `apiDomain` /
`endpoint` 的末两段，`buddy` → `workbuddy.ai`、`buddy-cn` → `tencent.com`（真实中国版
`iss` 是 `…codebuddy.cn`，两者同表成立）），迁移模块里不造字面量。两级都说不清
（凭据缺失 / JSON 损坏 / 签发方既非 buddy 也非 buddy-cn）⇒ **原样保留**。

**动作（重建而非改标签）**：`provider` → 目标 id、`id` → `<目标 id>-<新短 id>`、
`credentialRef` → `<目标前缀>_ACCOUNT_<新短 id 大写>`，凭据**读旧写新**、
**绝不 `unset` 旧 ref**（那是有效登录态，只是标签错了）。关联键一起搬：`checkins` 的
`${provider}:${accountId}` 键、`consumptionCursors` 的值（值就是 accountId）。
`disabledModels` / `contextBudgets` **不搬**（键是 provider id，属面板配置不属账号）；
`loginFailures` 是宿主内存表，不落盘。目标 ref 已存在且值不同 ⇒ 冲突，整条跳过并
`error`，绝不覆盖。id / ref **每次新生成**是刻意的：中断重跑不会撞上自己上次留下的
半成品（代价只是一份无害孤儿凭据），也让「把版本号手工改回 0」重跑绝对安全。

**接线顺序（`src/index.ts` 的 `apply()`）**：`openStorage()` → 改名迁移 → **体检** →
域名审计。三者都是 fire-and-forget 且内部自吞异常；体检的 `replaceAll` 是**一次原子写**
（账号 + 黑名单 + 版本号 + 签到 + 游标 + 体检版本）。`replaceAll` 的实参顺序：
`accounts, disabledModels, schemaVersion, checkins?, consumptionCursors?, providerAuditVersion?`。