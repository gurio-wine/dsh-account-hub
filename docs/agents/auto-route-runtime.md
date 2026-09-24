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
| `reasoningEffort` | 条目**配了**就用条目的；**没配**则**不写该键**（不写 ≠ 写 `undefined`：后者会覆盖掉调用方给的值） | 自动模型 = provider + model + effort 的**打包**语义；档位唯一归属条目 |
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
`INVALID_MODEL_INFO`，整轮对话起不来）；能力里**只合并 `context` / `defaultMaxTokens`
等不随档位争议的字段**，一律从**队首条目**的目标派生。

### 聚合模型**不声明 `reasoning`**（档位唯一归属条目）

即使队首目标有档位表，聚合模型也把 `reasoning` 整个丢掉（键都不留）⇒ **DSH 会话侧
没有档位下拉**。档位的唯一归属是**面板里的条目**（`entry.effort`）：条目配了就在转发时
注入（见 §2），没配就落目标模型自己的默认档。想要同一 provider/model 的不同档位，就在
面板里建**多个自动模型**（一个条目一个档位）。

会话侧那条下拉站不住的三个理由（用户定案）：

1. **条目配了档位时它会被无视** —— 转发以条目为准，下拉选了也不生效。
2. **没配时它只对队首有意义** —— 档位表来自队首目标，而队首会随降级漂移；用户在
   `p-a` 的档位表上选的档，转发给 `p-b` 时未必存在。
3. **档位失配会引发链式降级** —— 宿主在**到达本适配器之前**就按聚合模型声明的 efforts
   校验（`resolveCallWithInfo`），选的档不在声明里就直接 `UNSUPPORTED_REASONING_EFFORT`，
   整轮对话起不来。

旧实现把目标的 `reasoning` 合并进来、并把 `entry.effort`（落在目标表里时）作为
`defaultEffort` 透出 —— 那正是「会话侧可选档位」的来源，已整体移除。

### 宿主校验与物化：两处实测结论（改动依据）

`dsh-llm@0.1.2-rc.1` 实测（真实 `LlmRuntime`，非读文档推断）：

| 场景 | 宿主行为 |
|---|---|
| 聚合模型**无** `reasoning` 声明 + 请求**不带** `reasoningEffort` | 正常放行；`resolveCallWithInfo` **不物化**任何档位，转发请求里**没有该键** ⇒ 内层按**目标自己的声明**补目标默认档 |
| 聚合模型**无** `reasoning` 声明 + 请求**带** `reasoningEffort` | 宿主在 `resolveCallWithInfo` 抛 `UNSUPPORTED_REASONING_EFFORT`（`reasoning === undefined && requested !== undefined`）——**发生在适配器 `stream()` 之前**（实测 `adapter.stream` 调用数 0） |

由此得出一条关键结论：**「在聚合适配器 `stream()` 入口剥掉 `reasoningEffort`」是死代码**
（真实会话路径上根本走不到那里）。真实 agent 路径更早：`agent-loop/agent.ts` 的
`llm.prepareCall()` 内部就抛，而其 catch 只放行 `NO_ADAPTER`，其余 rethrow ⇒ 整轮直接死。

三条宿主路径的实测（真实 `LlmRuntime`，记录 `adapter.stream()` 的调用次数）：

| 路径 | 结果 | `adapter.stream()` 调用数 |
|---|---|---|
| `llm.resolveCallConfig` 带档位 | 抛 `UNSUPPORTED_REASONING_EFFORT` | **0** |
| `ctx.llm.stream` 带档位 | 终止 chunk `finish:error:UNSUPPORTED_REASONING_EFFORT` | **0** |
| `llm.prepareCall` 带档位 | 抛 `UNSUPPORTED_REASONING_EFFORT` | **0** |

调用数全为 0 是因为校验（`resolveCallWithInfo`，`dsh-llm/lib/index.js:1561-1586`）发生在
适配器被调用**之前**（`prepareCall` 在 `:1599` 校验、`:1621` 才把 `adapterCall.stream`
接上）。故入口剥键**永远执行不到**。

而且它不只是无用、**还有害**：直接调适配器的场景（本仓的转发语义用例、未来的外部
调用方）依赖「条目没配档位时**不写**该键 ⇒ 调用方带来的值原样透传」。入口剥键会把那个
值静默清掉 —— 实测把该剥键加进 `stream()` 会让 `tests/unit/auto-route-adapter.spec.ts`
的转发语义用例变红。该设计已被证伪并**刻意不实现**，由一条反面判据用例钉住。

可能带档位打过来的真实来源（升级前用过自动路由并显式选过档位的历史会话）：档位被
持久化在 `model/selection` 或 request header 的 `config.reasoningEffort` 上，恢复时由
`agent.ts` 还原。这条路径**经过 `agent/request` 瀑布流**，故兜底挂在那里（见下）。

### 兜底：`agent/request` 上剥掉档位（宽容处理）

命中 `provider === AUTO_ROUTE_PROVIDER_ID && reasoningEffort !== undefined` 时
`logger.warn` 一次并**剥掉该键**再放行，让这一轮照常按条目档位转发，而不是整轮报错。

为什么挂在 `agent/request` 而不是适配器：该瀑布流在 `prepareRequest` 里**早于
`prepareCall`**（`agent-loop/agent.ts:531` 派发 vs `:542` 校验），是唯一能改变
「校验前配置」的可挂点。作用域上它对本插件的根级监听器可达（`dsh-scope` 的
`scopeTarget`：**无 scope 标签的监听器全局放行**）。监听器仍**显式**带
`{ global: true }` —— cordis 的派发过滤是 `hook.global || !filter || filter.call(...)`
（`cordis/lib/index.js:263`），`global` 是短路项、零成本；写显式是为了不把「插件恰好
挂在根上」变成一条**静默失效**的隐式前提（若将来本插件被装进某个 scope，不带 `global`
的监听器会被过滤掉，兜底无声消失，而症状是「历史会话又整轮报错了」，极难归因）。

⚠️ **覆盖面边界**：它只覆盖 agent 会话路径。`llm.resolveCallConfig` 的两条直调路径
（面板 `session.selectModel`、子代理 `preflightChildLlmRoute`）是直接方法调用、无事件可挂，
仍会以 `UNSUPPORTED_REASONING_EFFORT` 报错（面板侧表现为 `session/model-unavailable`）。
这是刻意接受的：那两条是**显式选了档位**的动作，报错比静默丢弃用户的选择更诚实。

**还有一条同类的无兜底路径**：其他插件对 `ctx.llm.stream()` 的直调（如
`session-title-llm`、`compaction-basic` 的摘要调用）同样绕开 `agent/request`，若它们
带上档位打到聚合模型也会报错。它们目前都不带档位（各自用自己的配置），故不构成实际
故障面；这里记下来是因为**新增一个带档位的直调方**就会踩到它，而入口剥键并不存在、
也救不了（上表已证）。

### 技术取舍：为什么是 `agent/request`，不是 `llm/stream`

给未来的维护者，只列技术事实（两者都已实测）：

| 可挂点 | 相对档位校验的时机 | 对 agent 会话路径 |
|---|---|---|
| `llm/stream`（瀑布流） | **晚于**校验 —— 它在 `streamWithRegistration` 里派发（`dsh-llm/lib/index.js:1739`），只有 `prepareCall` 成功后才到得了 | **死代码**：校验先抛，`adapter.stream` 调用数 0 |
| `agent/request`（瀑布流） | **早于**校验 —— `agent.ts:531` 派发，`:542` 才 `prepareCall` | 唯一能在校验前改写配置的可挂点 |

档位校验的位置是 `prepareCall → resolveCallWithInfo`（`dsh-llm/lib/index.js:1599 →
`:1561-1586`）。`llm/stream` 的派发点在 `:1739`，而 `prepareCall` 在 `:1599` 就已经把
配置校验完并冻结（`:1600`）—— 挂 `llm/stream` 永远晚于抛点。故守卫只能挂
`agent/request`。

（本仓依赖的 `dsh-llm` 是**已安装**的，上述行号与行为均可端到端复跑；
`dsh-agent` 未安装，`agent/request` 的类型与派发点取自 DSH 主仓库源码
`packages/core/agent/src/runtime-types.ts:337` 与 `packages/core/agent-loop/src/agent.ts:531`。）

### 剥键形态：删除（偏好，不是正确性要求）

实现用解构**删除**该键。实测「键在但值为 `undefined`」在本链路上**同样跑得通** ——
宿主各处判据都是 `=== void 0`（`resolveCallWithInfo` 的 `requested !== void 0`、
`prepareCall` 的 `config.reasoningEffort === void 0`），两种形态等效。选删除是因为
语义更诚实（「这一轮压根没有档位这回事」，而非「有一个空的档位」），且与宿主自己的
写法一致（`agent-loop/agent.ts:66` 的 `requestProposal` 同样是 `delete`）。

⚠️ 别把它写成「置 `undefined` 会坏」：那是**未经验证的过度断言**，一条对照用例
（`tests/unit/auto-route-adapter.spec.ts`）专门钉住这一点。

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

`tests/unit/auto-route-adapter.spec.ts`（76 例）。**mock 的边界**：`ctx.llm` 用真实
`LlmRuntime` ＋ 一个记录型目标适配器 —— 只有这样才能钉住「重入 `ctx.llm.stream()` 真的
会重新走适配器选择与能力解析」；用替身 mock 掉 `ctx.llm.stream` 等于把被测的那一层也换掉。
同理聚合模型「不声明档位」由真实运行时的 `resolveCallConfig` 校验（无声明即不物化），
兜底则走真实的 `ctx.waterfall('agent/request')` 链路（不是直接调处理函数），并照
`agent.ts` 的真实序列（瀑布流 → `prepareCall` → `preparedCall.stream`）断言整轮存活。
内层失败**以 finish chunk 注入**（不是 throw），照 throw 写会测到一条线上不存在的路径。

覆盖面：转发改写（条目 effort 优先 / 缺省不写该键）、消息 `source.provider` 重写
（仅 assistant+model、其余原样引用、冻结请求不崩）、首 chunk 前失败静默降级、已透传后
失败透传 + demote、`usage`/`block-start` 也算已透传、aborted 不降级、满一圈中文错只出现
一次、无终止 chunk 的两种处置、跨请求持续降级、配置变更重建归位、listModels 门控、
resolveModel 能力合并（含「**不声明** reasoning」的三条反向断言）、会话侧残留档位兜底
（剥键 + warn 去重 + 两条对偶面 + 不改冻结入参 + 注销真的生效 + **整轮存活** +
**入口不剥键的反面判据** + **剥键形态的对照面**）、注册生命周期
（facts 不变不 replace / 开关切换 / 休眠真的摘掉路由）、门控（含「只影响 DSH 目录路径」
的对偶断言）、重试策略。

**变异检验**（改动会被测试抓住，不是「写了测试」就算）：去掉消息重写 → 2 红；
`emitted` 退化为「已出字」→ 1 红；aborted 也 demote → 2 红；`listModels` 不套开关 → 1 红；
`applyConfig` 幂等门失效 → 1 红；把目标的 `reasoning` 重新合并进聚合模型 → **4 红**；
兜底改成「只 warn 不剥键」→ **3 红**；在 `stream()` 入口加剥键 → **2 红**（转发语义 +
反面判据）；降级改用 `break` + 标志位（标志位写漏）→ 8 红。
