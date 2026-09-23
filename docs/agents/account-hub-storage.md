# Account Hub 存储与通用机制 实现细节

本文件由 AGENTS.md 迁出，供实现/维护时查阅。

## 存储与通路

**存储与通路**：账号池持久层是 **`ctx.storage` 的 storage 域**（`dsh_account_hub` → `$DSH_HOME/storages/dsh_account_hub.json`，single 布局 + 一个 global 单例文档，四件套 `accounts` / `disabledModels` / `contextBudgets` / `schemaVersion`）。`contextBudget` / `writeContextBudget` 读写第四件；`writeAccounts` / `writeModels` / `writeBudgets` / `replaceAll` **四件套互带**、都汇入唯一写落点 `persist()`，后三者都**先 `ensureLoaded()`**（它们不过读路径，漏了就整体写空）。**降级矩阵** = storage 为主 → 旧 settings（`jet-hub` namespace，**历史兼容读取，勿改**）回退 → 纯内存兜底；`apply()` 里 `await pool.openStorage()` **必须早于改名迁移**（它内部重置载入标记，切换点不留数据分叉）。**一次性迁移**（`account-hub-migration.ts`）：storage 无账号数据且能读到旧来源时把 `jet-hub` 段原样搬入，来源优先级 `settings.yaml.imported` → `settings.yaml` → 旧 scope；只读来源 / 幂等 / 空表不落 / 失败不半途覆盖。⚠️ **storage 域名只接受 `^[a-z][a-z0-9_]*$`（连字符不合法）**，故是 `dsh_account_hub` 而非插件 id；⚠️ 域打开后**必须 `ctx.effect` 登记 `domain.close`**（facility 按域名单开）；⚠️ **不引 YAML 依赖**：`simple-yaml.ts` 只取目标一节，不支持的构造（锚点/别名/块标量）显式抛错。⚠️ `LlmRuntime.listModels` 会重建条目、丢掉额外字段，`ctx` 也没有「按 provider 取适配器」的入口 ⇒ 由 `register*Llm` **返回适配器实例**经上述参数注入；省略时 `model.list` 不带窗口字段、`setContextBudget` 一律拒绝（headless / 测试的既定降级）。⚠️ **回填行（被关闭的模型）与目录行必须带同一组窗口字段**。⚠️ 客户端 `ModelToggle` 根节点是 `div`、`label` 只包「名称 + 显示开关」，**档位 radio 必须在 label 之外**（放进去会连带翻转显示开关）。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 **storage 域** `dsh_account_hub` 里保存账号索引（旧 settings 的 `jet-hub` namespace 仅作回退路径，见「存储与通路」），凭据本体存于 `ctx.credentials`：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤；**适配器必须以 `this.product.id` 作为 provider 实参查询账号池**（写死 `'buddy-cn'` 会让 Buddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`；**数组顺序即候选优先级**（`reorderAccounts` / RPC `account.reorder`），勿加按限流重置时间重排候选的 sort
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