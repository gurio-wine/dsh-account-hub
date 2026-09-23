# 自动路由 · 运行面（聚合适配器 / 注册 / 门控 / 转发降级）

**配置面**（存储字段 `autoRoute` + 池读写 + RPC `autoroute.get` / `autoroute.set`）见
`docs/agents/account-hub-storage.md` 的「自动路由（配置面）」。**本节只讲运行面**：
DSH 怎么看到这些自动模型、一次请求怎么被转发出去、失败怎么降级、开关怎么影响可见性。

**落点**：`src/auto-route-adapter.ts`（新文件，全部运行面逻辑）+
`src/auto-route.ts`（纯逻辑层的四处扩展）+ `src/account-pool.ts` 的
`providerCatalogVisible`（隐藏门控）+ `src/index.ts` 的 `apply()`（启动链与 RPC 通知接线）+
`src/account-hub-rpc.ts` 的第 12 个可选实参。

---

## 1. 一个虚拟 provider，不是「第八个真实 provider」

自动路由在 `ctx.llm` 上注册为 provider **`auto-route`**（id 取自纯逻辑层的
`AUTO_ROUTE_PROVIDER_ID`，**不写字面量**），其模型列表 = 用户定义的自动模型。
它**自己没有任何凭据**：凭据属于被转发的那些真实 provider。

**刻意不登记进「可配置 provider 目录」**（其余七个 `register*Llm` 都会登记）。
登记进去的具体代价：设置页多出一行「自动路由」＋一个永远用不上的
`AUTO_ROUTE_API_KEY` 输入框，还要一个真实存在的 `settingsNs`（不存在就是
`deriveKeyRef` 那条 `provider.toUpperCase is not a function` 崩溃路径）。
它的配置面是 Account Hub 面板，不是模型设置页。

**跨 provider 转发的唯一通路**是适配器 `stream()` 内带目标 provider 重入
`ctx.llm.stream()`（`ctx` 上没有「按 provider 取适配器实例」的入口）——
宿主据此重新走一遍适配器选择、能力解析与请求装配。官方认可，有测试钉死。

---

## 2. 转发语义（逐条对应实现）

| 字段 | 取值 | 为什么 |
|---|---|---|
| `provider` / `model` | 队首条目的目标 | 自动模型就是一条有序候选列表 |
| `reasoningEffort` | 条目**配了**就用条目的；**没配**则**不写该键**（`...options` 已带着用户实时选择的那一档） | 自动模型 = provider + model + effort 的**打包**语义；写一个 `undefined` 会覆盖掉调用方给的值 |
| `messages` | `rewriteMessagesForTarget(options.messages, entry.provider)` | 见 §3（不重写 = 思考模式工具轮 400） |

**请求对象与其 `messages` 数组都是深冻结的**（宿主 `agent.ts`），故重写必须
`map` 出新数组、浅拷贝出新消息对象，**绝不原地改**。新对象**不再深冻结**：
深冻结要遍历整条历史的全部内容块，长会话下是每轮请求一次的纯开销，而这条路径上
没有任何人会写它们（下游适配器只读）。

### `rewriteMessagesForTarget`（纯函数，在 `src/auto-route.ts`）

只碰 `role === 'assistant' && source?.kind === 'model'` 的消息并改写
`source.provider`；**其余消息原样引用**（同一个对象，不是拷贝）—— 工具结果、用户消息、
system 消息上的任何字段都不属于本模块的职责。

**为什么必须做**（宿主 `LlmRuntime.forAdapter` 的判据）：外层请求的 provider 是
`auto-route`，于是助手消息的 `source.provider` 也是它，而那份消息上的 `replayState`
却是**真实 provider 的适配器**产出的。内层重入时宿主做「历史消息归属检查」：只有当
`source.provider` 所属适配器 === 本次目标适配器时才保留 `replayState`，否则**整条摘掉**
（宿主等价测试：`service.spec.ts` 的 "strips replay state ... different adapter instance"）。
摘掉 replayState 的后果不是「降级成普通历史」那么轻：思考模式下的工具调用轮依赖
provider 侧签名（Anthropic 的 `thinkingSignature` / DeepSeek Messages 的
`reasoning.signature`），签名一丢，下一轮请求会被上游以 400 拒绝。把
`source.provider` 改写成目标 provider，归属检查就命中「同一个适配器」，replayState 得以保留。

---

## 3. 降级引擎（适配器是唯一调用方）

`demoteAutoRouteHead` / `autoRouteHead` / `autoRouteEntryCount` 全部来自纯逻辑层；
**适配器不重新实现任何判据**，只在单次请求内累计 `demotions`（引擎本身不计数 ——
「一次请求最多试 N 次」的口径只写在调用方一处）。

内层失败**以 `finish` chunk 到达，不是 throw**：宿主的 `adapterStream` 把「建立阶段抛错」
与「迭代阶段抛错」**都**规范化为一个终止 chunk（`finish{reason:{kind:'error'|'aborted'}}`）。
故降级判据读的是 chunk —— 照 throw 写会让转发路径上的失败**一条都降级不了**。

### 四条处置（按 `finish.reason.kind` 与 `emitted` 分派）

| 情形 | 处置 |
|---|---|
| `stop` / `tool-calls` / `max-tokens` | 原样透传、结束 |
| `aborted`（用户取消） | 原样透传、结束，**绝不降级**（换 provider 继续跑等于无视取消） |
| `error` 且**未透传过任何 chunk** | **静默吞掉这个 finish** → `demoteAutoRouteHead` → 试下一个候选（DSH 完全无感） |
| `error` 且**已透传过 chunk** | `demoteAutoRouteHead` → **透传该 finish** → 交给 loop 的官方重试 |

后两条都先 demote，故「跨请求持续降级」对两条路径同时成立：下一次请求（含官方重试的
新一轮）从**新队首**开始。成功**不升位**、不探活、不主动恢复（懒恢复）。

### ⚠️ `emitted` 的判据是「已透传过任何非终止 chunk」，**比「已出字」更严**

这一条由**宿主流语法**决定，不是措辞偏好：一旦把内层的 `block-start` / 文本增量 /
`usage` 透传给外层，就不能再静默换条目重来 —— 新条目会从 `block-start(0)` 重新开始，
外层装配器会看到「重复的 block-start index 0」；`usage` 同理（宿主 `llm-invariant`
明确禁止一条流里出现两次 usage）。

### ⚠️ 内层流没有终止 chunk 就结束

违反适配器契约（宿主 `llm-invariant` 会先报出来），但适配器仍自己造一个终止状态，
**绝不让外层流静静地结束**：

- **未透传过**任何 chunk → 静默换下一个候选；
- **已透传过** → 补一个 `error` finish（`AUTO_ROUTE_INCOMPLETE`），把控制权交给 loop
  既有的失败路径。若就这么结束，外层装配器会把「无终止 chunk」当成一次**正常完成**，
  用户拿到的是一个没有解释的空白回答。

### 满一圈

`demotions >= autoRouteEntryCount(...)` 时抛
`LlmError(autoRouteExhaustedMessage(name), AUTO_ROUTE_EXHAUSTED_CODE)` →
用户看到中文「自动模型『{name}』全部条目不可用」，**只出现一次**。

---

## 4. 官方重试：实测结论与处置

**实测（本仓依赖 `dsh-llm@0.1.2-rc.1`，探针脚本 + 单测各验一次）**：
宿主默认策略是
`{mode:'normal', maxRetries:5, retryableCodes:[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]}`。
本功能四个自有码 **`AUTO_ROUTE_EXHAUSTED`** / **`AUTO_ROUTE_UNKNOWN_MODEL`** /
**`AUTO_ROUTE_ENTRY_UNRESOLVED`** / `AUTO_ROUTE_INCOMPLETE` **都不在其中** ⇒ 官方重试
**不会**把「一轮全失败」放大成五轮。

**但仍然显式声明策略**（`AutoRouteAdapter.providerRetryPolicy` 返回模块级
`resolveRetryPolicy({ mode:'normal', retryableCodes:[…那五个…] })`）：
默认值恰好合适是**别人的缺省值**，而「全部不可用最多一次到达用户」是本功能的语义要求，
不能建立在这个巧合上。镜像那五个码而不是 `maxRetries: 0`，是因为**透传**上来的失败
（已出 chunk 后失败）刻意留给官方重试：已产出的内容不可回退，但让 loop 在**新一轮**
请求上从新队首继续，用户只看到一条正常重试。

**透明说明（用户可见行为）**：已出字后失败 → 用户会看到 DSH 官方的一次重试
（新一轮请求、从新队首开始），**不是**静默换 provider 重来。这是刻意的：
已产出的内容不可回退，硬换会让同一条流里出现两段开头。

---

## 5. 注册生命周期（`createAutoRouteRegistration`）

**为什么这段生命周期是本模块的导出、而不是 `src/index.ts` 里的一段闭包**：它有三条
容易写错且写错后完全静默的判据（内容幂等门、空路由集休眠、首次注册与唤醒的分工）。
放在 `apply()` 的闭包里意味着只有一条巨型接线路径能覆盖它，单测无从下手 ——
而这三条恰好是「关掉开关后 provider 仍在列表里」「改了候选顺序运行时不动」的唯一发生地。

- **按需注册**：其余七个 `register*Llm` 在 `apply()` 里一次性注册且永不撤销。自动路由
  不行 —— 一个注册着的 provider 即使 `listModels` 返回 `[]`，仍会出现在
  `listProviders()` 里。故按开关**休眠/唤醒**：关着 = `handle.replace([])`
  （零路由，provider 从 `listProviders()` 与模型目录里一并消失），
  开着 = `replace([AUTO_ROUTE_PROVIDER_ID])`。`replace([])` 是宿主契约明确允许的形态
  （「空数组合法，与空的首次注册不同」），且切换是一个同步段。
- **首次即使关着也要注册**：否则打开开关时没有 handle 可 replace。
- **幂等门看整份配置的内容**（`autoRouteConfigFacts`，纯逻辑层导出，与
  `AutoRouteAdapter.applyConfig` 内部那道门**同源**）。三种漏法各有一个具体症状：
  只看 `enabled` 或只看定义 id 集合 ⇒ 改候选顺序/加删条目后运行时不动（新候选永远
  轮不到、删掉的还在用）；看对象引用 ⇒ `autoRouteConfig()` 每次返回深拷贝、引用恒不
  相等，于是每次读都重建，**降级进度被无声清空**（第一个失败后下一轮又从它开始，
  无限循环打同一个失败 provider）。
- **`replace` 只在开关状态真的变了时才发**：它会发 `llm/adapters-updated`，每次改候选
  都白发一次会让订阅者白重算一遍模型目录。
- **失败处置**：本函数**不吞异常**，两个调用点各自处置 —— 启动链记日志（功能本次不可用），
  `autoroute.set` 侧也记日志（配置已写入，运行时下一轮自愈）。
- **调用时机**：`pool.openStorage()` 完成后（在那之前读到的是旧 settings 快照或空表，
  据此注册会把开关状态判错）。异步注册合法（`ctx.effect` 只要求 fiber 活着）。

---

## 6. 隐藏门控（`providerCatalogVisible`）

门控共两条判据，**方向相反**，且 ⓪ 排在前面（顺序本身是判据的一部分）：

### ⓪ 反向门控：自动路由**开着** → 本插件七个直连 provider 从 DSH 目录隐藏

这是「以后走自动路由」的语义落地：用户打开总开关，就是在说「我不要再从下拉里挑
那七个直连 provider 了」，故它们**一并消失**（`src/account-pool.ts:2014` 一带）。

- **位置：在环境变量短路之前**。`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 管的是
  「没有已登录账号就隐藏」，而本判据管的是「用户在面板上的显式选择」—— 两者
  **互不影响**：把全局账号门控临时关掉（为了看全目录）不该连带取消自动路由的隐藏，
  否则会出现「开着自动路由却仍看到七个 provider」，与面板上的开关状态自相矛盾。
  放在短路之后就会被 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 一并豁免。
  （自动路由**自己**那条可见性判据仍留在短路之后：那是既有语义，不改。）
- **自我豁免用 `!== AUTO_ROUTE_PROVIDER_ID`**（反向保护）。绝不写成「除自己外全部
  隐藏」之后又忘了自己 —— 那会让开启后**一个分组都不剩**，比不隐藏更糟。用 `===`
  对契约常量判定，不用「id 里含 auto」这类模糊匹配（同 §6 下一条的理由）。
- **池缺失 / 读配置抛错 → 保守放行**：宁可多显示一组（用户能自己看到开关状态），
  也不要让七个 provider 的模型凭空消失且无从排查（与下面各条同款）。
- **只影响 DSH 目录拉取路径**（各适配器 `listModels` → `buildModelCatalog`）。
  面板内的 `model.list` RPC 走的是适配器实例的 `listAllModels()`，**不经过本门控** ——
  这正是「开启自动路由后仍能在面板里编辑候选」的落地处：`autoroute.catalog` 的数据源
  是**混合的**（本插件七个走 `listAllModels()`，DSH 内置与其它插件回落
  `ctx.llm.listModels()`），若照旧逐个 `await llm.listModels(id)`，用户一开总开关
  七个 provider 全部返回 `[]`，「加候选」这个动作直接死掉。

### 自可见性：`auto-route` 按自己的开关可见

`auto-route` 是虚拟 provider、没有任何账号，故「已登录」判据对它不成立。门控里加了
一条**前置判据**：`provider === AUTO_ROUTE_PROVIDER_ID` 时按
`accountPool.autoRouteConfig().enabled` 返回（**与账号判据是「或」的关系，且必须** ——
照抄账号判据会恒返回 false，于是**开着开关也永远看不到**）。

- 用 `=== AUTO_ROUTE_PROVIDER_ID` 判定，**不用**「id 里含 auto」这类模糊匹配：
  虚拟 provider 的 id 是契约常量，模糊匹配会在将来出现同名前缀的真实 provider 时静默误判。
- 账号池缺失（headless / CLI / 单测）或读配置抛异常 → **保守放行**（与既有各条同款）。
- **只影响 DSH 目录拉取路径**（各适配器 `listModels` → `buildModelCatalog`）。
  面板内的 `model.list` RPC 走的是适配器实例的 `listAllModels()`，账号管理与签到余额
  更是完全不经过这里 —— 用户要求「关掉开关后依旧可编辑」，故这些路径一行都不动。

---

## 7. `resolveModel` 的能力合并

身份三元组必须换成本路由的（宿主 `normalizeModelInfo` 硬校验
`resolved.provider === 路由名` 且 `resolved.id === 请求的模型名`，不符即抛
`INVALID_MODEL_INFO`，整轮对话起不来）；能力（`context` / `defaultMaxTokens` /
`reasoning`）从**队首条目**的目标派生。

两处刻意的**不编造**：

1. **目标没有 `reasoning` 就不声明它** —— 凭空造一个空档位表会让宿主抛
   `INVALID_MODEL_REASONING`（空 efforts 非法）。
2. **`entry.effort` 不在目标档位表里时，不把它塞进 `defaultEffort`**，而是**退回目标
   自己的默认档**（不是留空）。塞进去会让宿主的 `normalizeModelInfo` 以「未知
   defaultEffort」抛错，模型变成「目录里点一下就报错」；留空则会让宿主的
   `resolveCallWithInfo` 不再补档，deepseek 系「不带档位 = 不思考」的行为会因为用户
   配了一个无效档位而静默改变。落不进档位表时由**运行时降级兜底**：请求真的打到那个
   条目时，内层以 `UNSUPPORTED_REASONING_EFFORT` 失败，适配器据此静默换下一个候选。

`listModels` 只给 `{provider, id, name}`：`LlmModelInfo` 本来就没有能力字段，多塞会在
宿主 `listModels` 那一层被静默丢掉（它只重建四个字段）。

### 两种「解析不了」的错误码**刻意分列**

`resolveModel` 有两个失败点，故障面与用户动作都不同，故各有各的码：

| 码 | 故障 | 用户动作 |
|---|---|---|
| `AUTO_ROUTE_UNKNOWN_MODEL` | DSH 请求的**模型名**在池配置里找不到定义（目录比池旧） | 刷新 DSH 的模型目录后重选 |
| `AUTO_ROUTE_ENTRY_UNRESOLVED` | 定义在，但**队首条目的目标** `resolveModelInfo` 抛错（provider 未注册 / 模型不存在） | 去面板改候选：换 provider / 换模型 / 检查该 provider 是否已装并登录 |

旧实现把后者也报成前者，用户照着「请刷新模型目录重选」去修一个「provider 没装」的
问题 —— 排查方向被直接带偏。条目解析失败那条**保留内层错误原文**（消息里带上，
并挂 `cause`），用户据此分辨「provider 没装」与「模型下架」。

---

## 8. 配置变更通知（RPC 第 12 个可选实参）

`registerAccountHubRpc(…, onAutoRouteChanged?)`：`autoroute.set` 成功后
**fire-and-forget、自吞异常**地调用它。配置已经写成功了，这条通知只是让运行时不落后于
配置 —— 它的失败绝不能让用户看到「保存失败」（那会促使他再点一次保存，而配置其实早就对了）。
`src/index.ts` 传 `ensureAutoRouteRegistration`。省略时（headless / 测试）配置照常写入，
只是运行时不在本进程内。

---

## 9. 测试与验证

`tests/unit/auto-route-adapter.spec.ts`（65 例）。**mock 的边界**：`ctx.llm` 用真实
`LlmRuntime` ＋ 一个记录型目标适配器 —— 只有这样才能钉住「重入 `ctx.llm.stream()` 真的
会重新走适配器选择与能力解析」；用替身 mock 掉 `ctx.llm.stream` 等于把被测的那一层也换掉。
同理 `resolveModelInfo` 的能力合并由真实运行时校验。内层失败**以 finish chunk 注入**
（不是 throw），照 throw 写会测到一条线上不存在的路径。

覆盖面：转发改写（条目 effort 优先 / 缺省落到目标默认档）、消息 `source.provider` 重写
（仅 assistant+model、其余原样引用、冻结请求不崩）、首 chunk 前失败静默降级、已透传后
失败透传 + demote、`usage`/`block-start` 也算已透传、aborted 不降级、满一圈中文错只出现
一次、无终止 chunk 的两种处置、跨请求持续降级、配置变更重建归位、listModels 门控、
resolveModel 能力合并、注册生命周期（facts 不变不 replace / 开关切换 / 休眠真的摘掉路由）、
门控（含「只影响 DSH 目录路径」的对偶断言）、重试策略。

**变异检验**（改动会被测试抓住，不是「写了测试」就算）：去掉消息重写 → 2 红；
`emitted` 退化为「已出字」→ 1 红；aborted 也 demote → 2 红；`listModels` 不套开关 → 1 红；
`applyConfig` 幂等门失效 → 1 红；`defaultEffort` 不做档位校验 → 1 红；降级改用
`break` + 标志位（标志位写漏）→ 8 红。
