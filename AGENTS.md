# 项目指令：dsh-account-hub

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 子代理路由（2026-09-19 更新）

- **派发子代理一律不指定 provider / model / reasoning effort**：宿主已装插件自动选择（按 `~/.dsh` 的路由配置与可用性现算），本体手动指定会与该机制竞争并导致路由漂移。提示词里也不要写「用某模型」这类字样。
- 仅当自动选择插件失效、派发报「无可用供应商/模型」时才回退人工核实 `list_subagent_models` 并临时指定。

## 项目概述

本项目是 DeepSeek Harness 的插件 `dsh-account-hub`，提供华为云 Codearts 浏览器登录与凭据管理，并附带七个 LLM provider 路由：`buddy-cn`（**Buddy CN**，腾讯 CodeBuddy 中国版）、`buddy`（**Buddy**，腾讯 WorkBuddy **国际版**）、`lobsterai`（**LobsterAI**，有道）、`trae-cn`（字节跳动 **Trae 国内版**）、`qoder` / `qoder-cn`（**Qoder** 国际版与国内版**两个 region**）。

> **命名（2026-09-18 改名后）**：显示名与 provider id 一律按**产品品牌**，旧命名 `buddy`（中国版）/ `workbuddy`（国际版）已作废，仅出现在历史叙述、迁移映射与**出站协议值**里。迁移见 README「provider 改名与数据迁移」。

> **TraeWork 路径 provider 已于 `47bd690` 整体移除**：官方把 Work 侧模型合并进通用通道，`trae-cn` 一条通道即可覆盖（真机实拉动态目录 14 项，含原 Work 独有的 `kimi-k2.7-code` / `kimi-k2.6` 与新增 `step-5-preview`）。provider 由八个减为七个。`disabledModels` 里可能残留该 provider 的旧键，**无人读取、无害**（按指示不迁移也不清理）。

`buddy-cn` 与 `buddy` 同源：共用同一 CLI 内核与认证协议，差异全部收敛在 `src/product.ts` 的 `BuddyProduct` 配置。关键差异是 **`endpoint`**（中国版 `copilot.tencent.com` / 国际版 `www.workbuddy.ai`，返回不同模型池，**不可当全局常量**）与 `platform`（`ide` / `workbuddy-ai`），国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与两者**完全不同源**（登录方式、请求头、续期载荷、签到流程、版本号来源都不同），实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 其中 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 对 LobsterAI 全部无意义。详见 README「LobsterAI provider」与 `docs/lobsterai-integration-plan.md`。

`trae-cn` 同样完全不同源（独立 `src/trae-cn*.ts`）。**登录**：本地回调 + PKCE(S256)，回调投递 `authCodeInfo`（双重编码 JSON）→ `POST /trae/api/v3/oauth/ExchangeToken`（body 五字段 `{ClientID,AuthCode,CodeVerifier,DeviceInfo,IDEVersion}`）；续期走 `POST /cloudide/api/v3/trae/oauth/ExchangeToken`（四字段），鉴权 `Cloud-IDE-JWT`。⚠️ 登录 URL 的 `client_id` **必须 snake_case**（`clientID` 会让授权页停在「认证中」，曾是报障根因），且必带 `auth_type=local` / `login_channel=native_ide` / `login_version=1` + PKCE 参数。三条结构级事实：SSE 是具名事件流（`event:output`）；业务失败在 HTTP 200 的 `event:error` 帧里（换号循环必须接住流内失败，按业务码而非状态码分类，见 `src/trae-cn-errors.ts`）；签到必须带设备头。⚠️ `/api/ide/*` 在 IDE 网关 `TRAE_CN_IDE_API_BASE`、不在 `api.trae.cn`（真因是 host 非路径），必须带齐 `x-app-id` / `x-ide-version-code` 等全套网关头。

⚠️ **chat 走 SOLO 通道**：`TRAE_CN_CHAT_PATH = '/api/agent/v3/llm_utils_chat'`（host 不变）。旧 `/api/ide/v1/chat` 是 aiserver 通道（只认 5 项旧池，恒回 `3003`、历史零成功），**不要再接回去**。**成败在端点 + body 的 `config_name` / `function`**：`config_name` = `model`，`function` = **模型来源**（`glm-5.3` 只在 `solo_work_remote`，写死 `solo_work_lite` 必 `4001`）；`content` 必须是 `[{type:'text',text}]`、`role:"developer"` 归一为 `system`、assistant 的 `tool_calls[].function` **出站改名 `function_call`**、`tools[].function.parameters` **字符串化**；思考字段名维持 `reasoning_effort_level` 不盲改。分类：`3003` 可重试（退避、不换号），`4023` / `4001` 直报；流内 `event:error` **必须直报业务码**（转成优雅关闭会让 DSH 报「Stream ended without finish_reason」，真因丢失）。

⚠️ **`4022` = 真·上下文窗口溢出，与 `4006` 同路映射 `CONTEXT_WINDOW_EXCEEDED`**：prompt token ≈ 1 000 000 时上游回 HTTP 200 + 流内 `event:error`（钳制二分 998 161 成功 / 1 002 248 失败；4 KB→1.5 MB 十一档全 200 ⇒ **无字节墙**）。修复前落「未知码」→ `INVALID_REQUEST`（致命、不触发压缩）；现在 `TRAE_CN_FATAL_CODES` 收 `4022`、`TRAE_CN_CONTEXT_OVERFLOW_CODES = [4006, 4022]` 供 `traeCnErrorCodeForAction` 映射 —— 那是**宿主唯一的补救路径**（DSH 自动压缩 + 重试），功能性必需。⚠️ 不违反「未知码直报不猜」：`4022` 已由阈值、排除项、同请求对照三件证据定案。⚠️ 中文说明只给 `4022`（`traeCnContextOverflowHint`），`4006` 文案刻意不动。

⚠️ **`4008` 实测是「通用积分池耗尽」，不是频率限流**：某账号通用池 `remain=0` 后连 4 KB 请求都回 `4008`（190 ms 即回、20 分钟不自愈），同刻健康账号 8 连请求全成功 ⇒ 与频率、字节量、并发无关。**动作与徽章不变**：仍留在 `TRAE_CN_RATE_LIMIT_CODES`（换号正确、冷却徽章正确），新增 `TRAE_CN_CREDITS_EXHAUSTED_CODES = [4008]` **只服务终报文案**（`traeCnCreditsExhaustedHint`，上游原文不改）。⚠️ **`scope` 必填**（`semantics` 参数已随 Work 路径移除而整体删除）：`scope` 由换号循环在退出点判定 —— `'pool-exhausted'` →「全部账号」、`'rotate-cap'` →「已尝试的账号」、`undefined`（无池 / 非换号失败 / 已产出正文后降级）→ **不追加**（此时谈账号是编造）。池名走实参。限流冷却措辞不同；`rotate-cap` + 冷却返回空串。

⚠️ **`x-ide-version-code` 是 SOLO 网关的「选表键」（4001 第二个根因）**：网关按该头决定上游返回哪张模型表，发旧 IDE 通道的 `107` 选出**空表** → 任何模型恒回 `4001`。成功组合 `20260820` + `x-ide-version: 0.1.61` + `User-Agent: Trae/0.1.61`；值域必须是 8 位日期式 `YYYYMMDD`（`20260801` 起表非空，**roster 会浮动、别当常量**），**只认这个头**。⚠️ **两组版本码同名不同物、不可合并**：`TRAE_CN_IDE_VERSION_CODE`(`107`) / `TRAE_CN_IDE_GATEWAY_VERSION`(`1.107.1`) 属 IDE 网关代际，`TRAE_CN_SOLO_VERSION_CODE`(`20260820`) / `TRAE_CN_SOLO_IDE_VERSION`(`0.1.61`) 属 SOLO 代际，四常量都在 `src/trae-cn-product.ts`（防「顺手统一」）；签到链路 `traeCnCreditsHeaders` 的版本头不动。

⚠️ **工具调用内嵌在 `event:output` 帧里，字段名是 `function_call`（2026-09-21 真机帧定案，修复「trae-cn 从未成功调用过一次工具」）**：上游**不**用独立的 `event:tool_call` 帧，而是挂在 `event:output` 的 data 里 —— `data:{"response":"","tool_calls":[{"index":0,"id":"call_…","type":"function","function_call":{"name":"glob","arguments":"",…}}]}`，后续增量片 `id`/`name` 为空串、`arguments` 是增量，收尾 `event:done`。

**缺陷本体**：`consumeTraeCnStream` 的 output 分支原先**只读** `response` / `reasoning_content`，`tool_calls` **从未被读取** ⇒ 工具调用被整块丢弃 ⇒ 该步既无 text 也无 tool-call 块 ⇒ `outcome.produced` 为假 ⇒ 适配器走 `{kind:'stop'}` ⇒ **回合终止且零报错**（343 个历史会话扫描 **0/10** 成功调用过工具，即该能力**从未工作过一次**）。

⚠️ **字段名是 `function_call`（无 er），不要「修正」成 `function`** —— 与出站改名约定**同源**，入站就按同名读回。⚠️ **此前文档写的「入站帧里仍是 `function`，故解析侧不需要任何改动」是错的** —— 那正是这个缺陷的认知成因。`function` 这个键**仍保留**在读取链上，但只服务 OpenAI 式嵌套形态（`{tool_call:{function:{…}}}`）。

**累积语义（OpenAI 式）**：首片带 `id` + `name`（`arguments` 可能是空串）；后续片 `id` / `name` 为**空串** ⇒ **空串不覆盖已记录值**（防 `unknown tool ""`）。**同帧内多个调用**按各自的 **`index`** 分块（漏发 `index` 时回退到它在数组中的**位置**而不是 0 —— 写死 0 会让并行调用悄悄并进第一个调用的参数串）；**`response` 与 `tool_calls` 同帧共存时两者都产出**。**空数组 / `null` / 非数组 / 单项缺 `function_call` 一律不产出块**（缺项**跳过**而不是伪造 `unknown tool ""`）。

**收尾判据**：`finish` 只看「该步有没有**产出块**」（`outcome.produced` + `hasToolCalls`），**不是**「有没有 text」—— 只有工具调用、零正文时同样是 `{kind:'tool-calls'}`，不得判成 `EMPTY_RESPONSE`。既有独立 `event:tool_call` 帧的**分支保留不动**，两种形态共用同一个 `parseTraeCnToolCall` 入口与同一条累积路径（`accumulateTraeCnToolCall`），**不得复制第二份解析逻辑**。**出站零变更**：`buildTraeCnSoloBody` 一行未动（有逐字节测试钉死）。夹具 `tests/unit/fixtures/trae-cn-output-tool-calls-*.sse.txt`。

**模型目录 = 动态 `POST /api/ide/v1/get_detail_param` + 静态 11 项回退**（`src/trae-cn-models.ts`）：对 `["solo_work_remote","solo_work_lite"]` 各拉一次取并集（remote 优先），解析 `config_info_list[].config_name` / `display_config.display_name` / `context_window_tokens.dev`（回退 `model_detail_list[0].prompt_max_tokens`）与 `.max_tokens`（⚠️ **dev 优先**：真机 `glm-5.3` 两字段 200000 / 168000，取哪个只影响宿主压缩触发点，都不是硬限）。**四道过滤网**（同在 `mergeTraeCnDirectory` 一个循环里）：① 内部 agent 项（`summary` / `file_search_agent` / `explore_sub_agent_v2` / `browser_use_subagent` / `computer_use_subagent` + 形态含 `agent`/`subagent`）；② 账号私有 BYOK 项（`isCustomTraeCnModel`：`usage === 'custom_model'` + 兜底 id 前缀 `custom_model_`，14 项；⚠️ `config_source` 恒 1、`display_config.is_custom_model` 恒 false 都不可用；`Array.isArray(custom_models)` 会漏 `custom_model_placeholder`）；③ 客户端自隐项（`entry.invisible === true`，8 项；⚠️ **三态**，`undefined` **必须保留** —— 40 项里 14 项缺该字段，含 `qwen3.8-max` / `qwen-3.7-plus` 两个正常项；`invisible:false` 的 `kimi-k2.7-code` / `kimi-k2.6` 也必须保留）；④ remote 成功时剔除 lite 独有项。**多模态、思考档位、档位三件事都只补不增**；12h TTL 缓存、**失败不写缓存**；整体失败回退 `TRAE_CN_FALLBACK_MODELS`（11 项，全映射 `solo_work_remote`）。**规模：40 − 5（内部）− 14（custom）− 8（invisible）= 13 项**（⚠️ 内部是 **5** 项 —— `computer_use_subagent` 属 lite 独有、第 ④ 条已出局，易漏算）。**静态表已剔除 5 项 SOLO 不可调 id**（`glm-5.3-flash` / `deepseek-v4.1-flash` / `kimi-k2.8-preview` / `qwen3.8-flash` / `Doubao-Seed-Code`）；表外模型的 `4001` 追加提示「该模型已不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选」。

**档位数据源**：SOLO 目录已对可调模型停发 max ⇒ 改用 `GET https://solo.trae.cn/api/remote/v1/models?functions=solo_agent_remote`，响应按 `{data:{list:[{function,models:[…]}]}}` 分组，**只取 `function === "solo_agent_remote"` 那组**（**绝不跨组拼接** —— 档位缺失只是回到现状，跨池取值却是把别的池的档位灌进 IDE 目录）。模型 id 在 `name`（不是 `display_name`）；判据 = `max_mode === true`（`max_mode:false` 的三项 max 恰好是 `0`）+ `context_window_tokens.max`。请求头只有 5 个（`traeCnAccessHeaders`），**刻意不带 SOLO 网关头**。`applyTraeCnAgentTiers`：只补**现有**条目的 `maxContextWindow`，命中 `max_mode` 且 `max > entry.contextWindow` 才写，`contextWindow === undefined` 跳过，**绝不新增条目**（agent 组独有的 `Doubao-Seed-Code` 加进来必然 `4001`）；失败静默降级（目录照常返回、不写缓存、目录整体落空时短路不再打档位端点）。⚠️ 档位表与 roster 都会漂；agent 组的 `reasoning_effort_config` **刻意不接**。

**思考档位已接线**：静态表 11 项里 8 项声明 `reasoning`（取自真机 vscdb 的 `reasoning_effort_config`，**`chat_v3` 那套、不是 `solo_agent`**），id 逐字符照抄 `light`/`high`/`extra_high`，**下发字段名是 `reasoning_effort_level`**（`reasoning_effort` 是字节内网账号那套，已由官方 bundle + `ai_agent.dll` 三方互证；真机 A/B 因账号回 4008 而无法区分字段名，「档位是否真生效」仍未验证）。⚠️ **SOLO 目录端点不提供档位**（用户报障根因）：带 `reasoning_effort_config` 的项**全是 `{support_thinking:false}` 空壳**，故 `parseTraeCnDirectory` 在 SOLO 目录上永远读不出档位。**修法**：`applyTraeCnStaticMetadata` 在按 id 补多模态之外**同源按 id 补档位**。⚠️ **判据是 `entry.reasoningEfforts === undefined` 时才补，绝不能看目录的 `support_thinking`** —— 目录恒 `false`，照多模态那种「目录已表态就不覆盖」的写法写就永远补不上（多模态判据确实是 `supportsImages === undefined`，两者**刻意不同**）。补齐的 8 项：`Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo` / `glm-5.3` / `glm-5.2` / `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` / `kimi-k3`(def `extra_high`) / `qwen3.8-max`；动态目录独有的 `kimi-k2.7-code` / `kimi-k2.6` **不在静态表** → 不补。

**红线与判据**：机制是**纯声明值切换，出站请求体一个字段都不动** —— 变的只有 `resolveModel().context.contextWindow`（宿主压缩阈值 `0.8×窗口` + 压缩后保留预算），有逐字节比对两次请求体的用例钉死。三条判据缺一不可：① 写入只有一个落点 —— `max` 严格大于**实际生效的默认档**才写（`max<=dev` / `0` / 缺失都不收）；② RPC `model.setContextBudget` 只接受**精确等于**该模型当前目录条目的某个档位（省略 / 等于默认档 = 清除预算），错误信息必须带实际可用档位值；③ 读取时 `effectiveContextWindow` 再判一次。⚠️ **编造值静默退回默认档是设计**。⚠️ **静态回退表 11 项一律不带 `maxContextWindow`**，故静态路径下模型自动无档位 UI。

**档位来源与注册表**：`src/context-tiers.ts` 是档位通用机制（`availableContextTiers` / `effectiveContextWindow` / `createContextTierRegistry`），`src/index.ts` 用 `createContextTierRegistry({ [TRAE_CN.id]: …, [BUDDY_CN.id]: …, [BUDDY.id]: …, [QODER.id]: …, [QODER_CN.id]: … })` 作为 `registerJetHubRpc` 的**第 10 个实参**注入（键取 `*.id`，别写字面量）。**只有 buddy 系（`supportedLengths`）与 qoder 两区（`available_context_windows`）有档位数据源**，trae-cn 走上面那套；**lobsterai 没有档位源 ⇒ 不显示档位 UI**（不是遗漏）。

**存储与通路**：账号池持久层是 **`ctx.storage` 的 storage 域**（`dsh_account_hub` → `$DSH_HOME/storages/dsh_account_hub.json`，single 布局 + 一个 global 单例文档，四件套 `accounts` / `disabledModels` / `contextBudgets` / `schemaVersion`）。`contextBudget` / `writeContextBudget` 读写第四件；`writeAccounts` / `writeModels` / `writeBudgets` / `replaceAll` **四件套互带**、都汇入唯一写落点 `persist()`，后三者都**先 `ensureLoaded()`**（它们不过读路径，漏了就整体写空账号 / 黑名单 / 版本号）。**降级矩阵** = storage 为主 → 旧 settings（`jet-hub` namespace，**历史兼容读取，勿改**）回退 → 纯内存兜底；`apply()` 里 `await pool.openStorage()` **必须早于改名迁移**（它内部重置载入标记，切换点不留数据分叉）。**一次性迁移**（`account-hub-migration.ts`）：storage 无账号数据且能读到旧来源时把 `jet-hub` 段原样搬入，来源优先级 `settings.yaml.imported` → `settings.yaml` → 旧 scope；只读来源 / 幂等 / 空表不落 / 失败不半途覆盖。⚠️ **storage 域名只接受 `^[a-z][a-z0-9_]*$`（连字符不合法）**，故是 `dsh_account_hub` 而非插件 id；⚠️ 域打开后**必须 `ctx.effect` 登记 `domain.close`**（facility 按域名单开，不登记就永久占住）；⚠️ **不引 YAML 依赖**：`simple-yaml.ts` 只取目标一节，不支持的构造（锚点/别名/块标量）显式抛错。⚠️ `LlmRuntime.listModels` 会重建条目、丢掉额外字段，`ctx` 也没有「按 provider 取适配器」的入口 ⇒ 由 `register*Llm` **返回适配器实例**经上述参数注入；省略时 `model.list` 不带窗口字段、`setContextBudget` 一律拒绝（headless / 测试的既定降级）。⚠️ **回填行（被关闭的模型）与目录行必须带同一组窗口字段**。⚠️ 客户端 `ModelToggle` 根节点是 `div`、`label` 只包「名称 + 显示开关」，**档位 radio 必须在 label 之外**（放进去会连带翻转显示开关）。

### Buddy 系（`buddy-cn` / `buddy`）—— 上下文窗口取值口径（2026-09-21 真机定案）

⚠️ **声明值取「最大档」≈1M** = `min(maxInputTokens, supportedLengths 最大档)`，**不是 `defaultLength`**。⚠️ **不要按 `defaultLength` 取值（09-20 的旧结论已被单变量实测推翻）。** 钳制二分（`buddy-cn`/`glm-5.3`）：320,307 / 500,507 / 900,910 / 1,000,970 token 全 200，1.2M 才回 400 `{"code":11115,"msg":"prompt is too long: …","extError":{"code":"400001",…}}` ⇒ `defaultLength`(300K) 非硬限、只是纯 UI 默认值，真实窗口 ≈1M（官方客户端的档位选择器**不发任何出站字段**，只驱动它自己的压缩触发点）。

⚠️ **取值链**（`parseModelMeta`）：a = `maxInputTokens`、b = `supportedLengths` 最大正整数 —— ① 都有取 `min(a,b)`（档位表是上游刻意公布的上限，更小时听它的：`minimax-m3` `[300K,512K]` ⇒ **512K**）；② 只有其一取那个；③ 都无才回退 `defaultLength`，再无**不声明**。⚠️ `supportedLengths` **只此一处最小解析**（只取最大正整数，不存整档列表、不做 UI、不出站）。⚠️ **出站请求体一个字段都不动（红线）**：只改 `resolveModel().context.contextWindow`（压缩阈值 `0.8×窗口` + 保留预算 16%），有逐字节比对请求体的用例钉死。

⚠️ **静态兜底表（`fallbackModels`）同步回「最大档兜底」**（仅远端不可用时顶替）：CN 的 1M 系 → `1_000_000`、`minimax-m3` → **`512_000`**（不是 1M、也不是 09-20 的 300K）；国际版 3 项档位对条目 → `1_000_000`。⚠️ 国际版 **8 个「1M 且无 `contextWindow` 字段」的是单档模型**，砍它等于谎报容量。⚠️ 改表必须逐条自查 diff：`product.spec.ts` 按**集合相等**两侧钉死（CN 1M 恰 7 项 + `minimax-m3` 留 512K；国际版 1M = 无档位对 8 + 有档位对 3）。

⚠️ **证据强度分层（不要拉平）**：CN 有 `glm-5.3` 单变量实测；**国际版无实测**（余额不足）按同协议形态推定 —— 真实窗口万一低于声明 max，撞 `11115` → 映射 `CONTEXT_WINDOW_EXCEEDED` → 宿主压缩重试（保留预算 1M→160K 仍在真实窗口内）；若声明默认档则**每次 240K 就丢历史**。⚠️ **端点漂移自动消解**：企业端点与 `/v3/config` 统一取最大档后给同一个数，不必写分支。

⚠️ **安全网（不改分类器）**：1.2M 报文被**现有**分类器命中 `CONTEXT_WINDOW_EXCEEDED`（`httpErrorCode` 靠**完整 body**）。⚠️ 承重点是 `displayMsg.en` 那句英文措辞：新报文 `extError.code` 是纯数字、`msg` 无 `for this model` 后缀，结构化正则都认不出，**摘掉 `displayMsg` 即落回 `INVALID_REQUEST`（不触发压缩）**。判据复用宿主 `isContextWindowExceededError`、**不自建关键词表**（同 lobsterai / qoder 先例）；`buddy-adapter.spec.ts` 有钉死用例。

Account Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」（每日签到）**由 Buddy CN、LobsterAI 与 Trae CN 三个面板提供** —— Buddy（国际版）后端没有签到接口，Codearts 是华为云账号体系不参与，Qoder 与 Qoder CN 都不提供（详见下文「积分能力」）。**七个 provider 都有 Account Hub 面板**（Qoder 两区见 README）。

### Qoder 国际版（`qoder`）—— chat 250 的三条硬事实

⚠️ **`tools` 必须包裹成 OpenAI 标准形态（2026-09-21 真机报障根因）**：`buildQoderChatBody` 必须把 harness 的 `ToolSchema`（`{name,description,parameters}`）翻译成 `{type:'function',function:{…}}` 再发（`serializeQoderTools`）。**原样透传会让非 `lite` 模型恒回 HTTP 200 流内 `provider_error`**（用户可见包装码 + harness 码 `INVALID_REQUEST`），details 原文 `'function' is a required property, expected an object - 'tools.0'`。⚠️ **`lite` 是唯一两种形态都不报错的模型**（走上游宽松兼容路径）—— 这正是它逃过 T2 的原因（T2 发的是手写 OpenAI 形态，不是 `GenerateOptions.tools` 的形态）。包裹后 `qmodel`/`gmodel`/`dmodel`/`lite` 实测仍回标准结构化 `tool_calls`，其余六个 provider 也都是这么包的（Qoder 曾是唯一例外）。

⚠️ **256 KiB 字节墙 + 240 KiB 本地闸门（2026-09-21 字节级矩阵取证）**：Qoder 国际版 chat 网关对请求体有**确定性**字节墙 —— body ≥ 262 144 B 恒回 HTTP 500 `{"error":"internal server error"}`，**无任何可判别的 code**（262 144 → 200、262 145 → 500，多次复测零抖动）。故 `QODER_MAX_REQUEST_BYTES = 245_760`（留 ~8.5% 余量），`QoderAdapter.stream()` 在 `buildQoderChatBody` 之后、fetch 之前量 `Buffer.byteLength(body,'utf8')`，**达阈值即不发请求**。⚠️ **映射成 `CONTEXT_WINDOW_EXCEEDED` 是刻意的**：「未知码不得瞎猜」管的是**上游语义未知**（猜就是编造），本地字节数是**我们自己算出的确定性事实**，而 DSH 的自动压缩补救**只认这一个码**。⚠️ 判据走**显式标志位** `classification.localByteGate`，**绝不靠文案关键词**（闸门文案是中文、正则是英文，靠关键词会静默失效）；**绝不能交给 HTTP 兜底** —— `500 → backoff` 会把确定性失败变成无限退避重试。**声明窗口 200_000 一律不改**：它决定压缩后的保留预算（16% × 200K ≈ 134 KiB，在墙内），决定不了压缩触发时机（0.8 × 200K ≈ 655 KiB，**永远在墙之后**）—— 闸门负责挡墙，声明值负责保留量。每次发送把 `bodyBytes` 经 `onDebug` 以 **debug 级**报出（⚠️ Cordis 默认导出阈值是 INFO，要看撞墙趋势需把 exporter level 提到 3）；闸门在 `qoder` / `qoder-cn` 共享的发送代码里，**对 CN 同样生效**（量的是签名**之前**的明文）。

⚠️ **`provider_error` 的真因在 `details`，且有多种形态**：`details.error.code`（T3 原形态）、**整段带 `data: ` 前缀的 SSE 帧原文**、只有 `details.error.message`/根层 `message`（无 code）、`details.error.code` 是业务文本（如 `"1210"`）。`parseQoderWrappedDetail` 必须**既认码也认文案**；**流内** `provider_error` 帧的真因同样只在 `details` 里 —— 故 `parseQoderStreamErrorPayload` 带出 `details`、适配器流内分支必须把它作为 `body` 传给分类器。

### Qoder wasm 签名链（两区共用）—— CN chat 复活的关键

⚠️ `/algo/api/v2/service/pro/sse/agent_chat_generation` 是签名路径，必须整包替换 URL + headers + body（`body` 是密文，`url` 由 wasm 拼好含 `?FetchKeys=…&Encode=1`，20 个 header 含 `Authorization: Bearer COSY.…` / `Cosy-Key` / `Cosy-MachineId` / `X-Model-Key` / `X-Model-Source`）。**只补签名头不换 body 必回 `101 Signature invalid`** —— CN chat 长期不可用的头号原因。⚠️ `endpoint` 参数是 **host 基址**（`https://gateway.qoder.com.cn`），不是完整 URL。

⚠️ **`uid` 必须是真实用户 id**：取自 `GET {openapiBase}/api/v1/userinfo`（Bearer `jt-`），回退序 `id → user_id → uid`。真机 A/B：空串 → `101`，真实 uid → 200 + SSE 真内容；`exchange` 响应**不含** userId。

⚠️ **`machineId` 由签名器自己走登录链取**（`readOrCreateQoderMachineId(product)`，即设备流落盘的**同一份文件**，真机核对 `Cosy-MachineId` == 磁盘内容）。**不要另写一份** —— 那份函数承载「已存在绝不覆盖 / 缺失则生成落盘 / 落盘失败退回内存态且不抛」三条契约，不同源会被上游以 `101`（与凭据失效同形）拒绝。⚠️ 取用必须在复用判据之前；测试里**必传** `machineIdOptions.homeDir`。⚠️ **`product` 绑定在签名器构造时**，同一实例被两个 region 交替使用会拿 CN 机器码签国际版请求 ⇒ 按 region 各建一个 `QoderWasmSigner`。

⚠️ **构造要跑两段**：先用五个业务字段（`uid` / `security_oauth_token` / `organization_id` / `organization_tags` / `data_policy_agreed`）调 `generate_runtime_auth_fields` 拿 `{encrypt_user_info, key}`，再并进 `userInfoJson` 才 `qodercontext_new`；缺它 wasm 抛 ``missing field `encrypt_user_info` ``。**PAT 路径同样要跑**。⚠️ **wasm 是内联 base64 而非独立文件**（单条字面量 398 144 字符 → 298 606 字节，内联在 worker runtime）：抠取**按前缀定位、不写死偏移**，前缀用 5 字符 `AGFzb` 而非 `AGFzbQ`（第 6 字符由第 5 字节高位决定，写死它等于假设「wasm 版本恒为 1」）。

**三级提取**（缓存是快路径）：① 本机已装 Qoder（`…/app.asar.unpacked/node_modules/@qoder-ai/<包名>/dist/_worker/qoder-worker-runtime[.obf].mjs`，两区 worker 都在、35 MB 上下）→ ② npm tarball → ③ 官方 CDN `https://download.qoder.com/qodercli/releases/{版本}/qodercli-worker-runtime-win32-x64.tgz`。**每级提取后 SHA-256 校验，不匹配即当该级失败继续降级**（四来源同值 `6419471e…b43d`，298 606 B）；全败抛「未找到 Qoder 签名组件（wasm）…」+ 各级原因。⚠️ 三个坑：国际版 npm `@qoder-ai/qoder-agent-sdk`（1.0.47）**不含 worker**（由 ③ 兜住）；CN npm 包名是 `@qodercn-ai/qoderclicn`（**不是** `@qoder-ai/qoder-cn-agent-sdk`，后者 404）；CDN 平台 token 是 Go 风格 `win32-x64`（写 `windows-x64` 会 404）。**缓存** `~/.dsh/qoder-wasm/qoder_auth_wasm_bg.wasm`（原子替换），两区共用同一份字节。**许可红线**：只做运行时提取，**不把 wasm 字节提交进仓库、不随插件包分发**。

**glue 是手写复刻的**（`src/qoder-wasm-glue.ts`）：官方那份内联在 35 MB worker 里，本插件不整体加载，故按取证的 31 个 import 语义重新实现。⚠️ **两个同名不同义的坑必须按完整名分派**：`__wbg_getRandomValues_*` 有两个、`__wbg_new_*` 两个变体（`new Uint8Array(len)` vs `new Map()`）。**未知 import 显式抛错**（塞空函数会让 wasm 深处以「签名算错」失败，比立即报错难查得多）。

**真机验证**：① CN 签名路径 ✅ 200 + SSE 真内容、无 `101`；② 国际版同路径 ⚠️ 签名通过、业务 400（host 是 `api1.qoder.sh`，`api2-v2.qoder.sh` 404 ⇒ 协议可达、**参数待校准**）；③ 国际版大 body 字节墙 ⏸ 未测；④ CN 接入适配器后 ✅ 105 B / ≈4 KB / ≈40 KB 三档全通过 —— **④才是「CN chat 真正可用」的证据**，①②只证明签名算子能出有效签名。

⚠️ **签名路径的帧是双层信封，不是裸 OpenAI chunk**：每帧是 `data:{"headers":{…},"body":"<内层 JSON 字符串>","statusCodeValue":200,…}` —— 内层**再 `JSON.parse` 一次**才是标准 chunk；收尾 `"body":"[DONE]"`（**`[DONE]` 也被包着**）。只认裸帧会让每帧都落进「`choices` 不是数组 ⇒ 跳过」，表现为 `Stream ended without [DONE]`，而 HTTP 与签名全是好的。剥离判据 `unwrapQoderFrame`：**`statusCodeValue` 是数字 + `body` 是字符串，两个都在**才当信封（只认 `body` 会误伤国际版裸帧，有反向断言）。夹具 `tests/unit/fixtures/qoder-cn-signed-sse.sse.txt` 是逐字节真机副本。

⚠️ **接入方式**：`stream()` 在 `buildQoderChatBody` 后、字节闸后按 region 分流 —— CN 走签名路径，**国际版一行不动**（REST + jt，逐字节回归）。`QoderAdapterOptions.signing` 由 `src/index.ts` 注入 `QoderSigningProvider`（per-region 实例）。⚠️ **CN 未注入 `signing` 时直接抛错、绝不回退 REST**（回退得到上游 503，用户看到「网关故障」而非「插件没接线」，后者才是可修的配置错误）；**签名分支不做 401 重换重试**；**字节闸仍量明文**；**逃生阀对 CN 作用于 `hostBase`**，签名后的完整 URL **不再过**该函数。⚠️ **两个新错误形态进分类器**：`101` + `Signature invalid` → 直报 + 提示重新登录（码与文案**两件都对**才算）；`QoderWasmUnavailableError` → 直报 + 三级尝试原因。**未知码照旧直报不猜**。`uid` 取不到时 `contextFor` 抛错、一次都不签。

### Qoder CN（`qoder-cn`）—— 第二 region 的两条要点

`qoder-cn`（显示名 **Qoder CN**）与 `qoder`（国际版）**同协议双 region**：exchange / quota / models 三个端点的错误信封逐字节同构、PAT 前缀同为 `pt-`、目录字段同构，故**代码只有一份**（`src/qoder*.ts` 按传入的 `product` 现算），差异全部收敛在 `src/qoder-product.ts` 的两份 `QoderProduct` 配置里。

⚠️ **两区是两套账号、两套 Credits、两套令牌 —— 各自独立，没有任何池映射**：账号**各自独立**（凭据 ref 前缀 `QODER_ACCOUNT_*` vs `QODER_CN_ACCOUNT_*`）、令牌**互不承认**（拿错 host 打 = 「凭据失效」的假象）、`poolProviderFor()` **恒等**、积分各查各的额度端点。⚠️ **不要照抄别的 provider 去造映射**：历史上有一个复用 `trae-cn` 账号的 TraeWork 路径 provider（已于 `47bd690` 随官方合并而移除），它的「同一批账号 + 必须映射」写法**只属于它**。

⚠️ **把 `qoder-cn` 映射到 `qoder` 是静默故障**：CN 面板会列出国际版账号、用 CN 凭据打国际版 host —— 端点仍回 `ok: true`，只是账号对不上 / 报「凭据失效」。（成因是历史上那段「复用宿主 provider 账号」的写法已不存在，任何新映射都必须另有依据。）`qoder-hub-panel.spec.ts` 与 `qoder-cn-rpc-dispatch.spec.ts` 从两个方向钉死。

**CN 三个基址**：`openapi.qoder.com.cn`（✅）、`api.qoder.com.cn`（✅）、**`gateway.qoder.com.cn`（chat，签名路径的 host）**。⚠️ **旧定性「阿里云侧未就绪 / PAT 结构性不可用」被真机推翻两半**：① 「503 是路径级的」**仍成立**（`/model/v1/chat/completions` 在 CN 网关确实不存在，ALB 对该路径恒 503）；② 但「PAT 给不出用户密钥」**错了** —— 签名四要素 PAT 路径全拿得到，空 uid 才回 `101`。**CN chat 现在走 `/algo/…/agent_chat_generation` + wasm 签名**，不再打那条 REST 路径。**错误分类按 region 分流**：CN 的 chat 503 直报 `'fail'`（不退避、不换号、不记徽章、harness 码 `INVALID_REQUEST`）—— ⚠️ **该分支保留不动**（逃生阀把 CN 指到别处、或将来误接回 REST 时的兜底），region 判据**显式列举 `=== QODER_CN.id`**（防第三个 region 被静默归入）；国际版 503 维持 `backoff` → `RATE_LIMIT` 不变。**逃生阀** `QODER_MODEL_SERVER_HOST` 覆盖 chat 的 host（⚠️ **只影响 chat**；路径与查询串一律丢弃；**请求时读取**），作用于两区；对 CN 改的是**传给签名器的 hostBase**（签名后的完整 URL **不再过**该函数）。⚠️ **绝不因「打不通」就改成国际版 host** —— 那会把「路径不存在」伪装成「凭据失效」（实测 **CN 的 `jt-` 打国际版 chat 回 401**，用户会被引向反复重贴 PAT 的死路）。

**CN 的三个出站身份标识**：UA **`qoder/1.1.58`**（官方模板 `` `qoder/${版本}` ``、**与 region 无关**；此前的 `qodercn/1.1.58` 是把 npm 包名当产品名的**推断错值**）、`client_type: "5"`、**Cosy 头**。⚠️ **签名路径下这三个的实际出站者都是 wasm**；适配器 `send()` 里那段 Cosy 追加代码**对 CN 已无可达路径**，属残留（防「将来接回 REST 时出站身份静默变化」）。⚠️ `Cosy-MachineOS` / `Cosy-MachineHostname` **刻意不实现**（**不猜机器身份** —— 缺头比错头安全）。

### TraeWork 路径 provider（已于 `47bd690` 移除）

该 provider 已整体删除：官方把 Work 侧模型合并进通用通道，`trae-cn` 一条通道即可覆盖（真机动态目录 14 项已含原 Work 独有的 `kimi-k2.7-code` / `kimi-k2.6`）。它的整节协议要点、Account Hub 面板与池映射随之作废，**不要再按已删代码去描述它**。Work 专属积分池（`available_endpoint=1`）在服务端仍在，但只有 TraeWork 网页/桌面版能花 —— 与本插件无关，故**不在任何面板展示**。

**移除它留下两条结构性事实仍然成立**，见下两段。

**面板 id → 账号池键的收敛点仍是 `src/jet-hub-rpc.ts` 的 `poolProviderFor()`**（客户端不做映射，发的就是面板 id）：移除 Work 后它是**恒等函数**，但**刻意保留** —— 六个入口（`account.list` / `account.retestAll` / `account.resetAll` / `credits.status` / `credits.claimAll` / `credits.balances`）仍经它把「面板 id」翻成「池键」，将来若再出现复用别人账号的 provider，加一行即可，不必把 if 撒进六处调用点。

⚠️ **「选显示哪个积分池」是另一件事，不走 `poolProviderFor()`**：`traeCnPoolFor()` 已随 Work 路径删除，`credits.balances` 的 trae-cn 分支**内联 `TRAE_CN_POOL_UNIVERSAL`** 作为 `fetchTraeCnCreditBalance` 的第三个实参（Trae CN 面板显示的就是它实际能花的池）。账号映射与选池**不可合并**：用池键查账号会让面板空白；`TRAE_CN_POOL_WORK` 与 `TraeCnPoolId` **仍保留**（服务上游 `available_endpoint` 分池字段与礼包归类，非 provider 专属）。

⚠️ **刻意不经过映射的两个入口**：**`account.create`**（它按 provider 解析产品配置决定「登录怎么做」，对未知 provider 一律回 `unknown provider` —— 映射会给同一份凭据建出第二个占位账号，等于把一个账号建两遍）；**`model.list` / `model.setDisabled`**（黑名单按 provider id 存，映射会把一个 provider 的开关写进另一个的黑名单）。`credits-capabilities.spec.ts` 的「集合相等」断言已同步到七条，并断言**没有条目声明 `loginHint`**（每个面板都自带「+ 新建账号」入口）。

- **包名** `dsh-account-hub`；**入口** `lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）；**构建** `pnpm build:all`（`tsc` + `esbuild`）；**语言** TypeScript；**许可** MIT

## 技术栈与约束

- **Node.js** `^22.19.0 || >=24.0.0`；**依赖管理** pnpm workspace（作为 DSH 插件安装）；**代码风格**与 `@deepseek-ai/dsh` 主仓库保持一致。
- **构建**：宿主侧 TypeScript `tsc` → `lib/`；客户端 bundle `esbuild`（`plugin-src/client/build.mjs`）→ `lib/client/jet-hub.js`。两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证 git 安装时两侧产物齐全。⚠️ **`build:client` 末尾含产物顶层求值冒烟（stub require）** —— 模板字符串求值类错误构建即炸，而 `plugin-src/` 不在 typecheck/test 视野内，**这道闸是客户端 bundle 的唯一语义防线，勿删**。
- **测试**：Vitest。`pnpm test` 为单元测试（快速、无网络、全部 mock）；`pnpm test:e2e:*` 按 provider 分列（如 `test:e2e:codearts` / `buddy-cn` / `buddy-claim`），**均有闸门、默认全部跳过**，哪些会消耗模型积分见 `tests/e2e/README.md`。测试文件按约定放 `tests/unit/` 与 `tests/e2e/`。

## 项目结构

`src/` 宿主侧 TS 源码；`plugin-src/client/` Account Hub 客户端源码（esbuild 打包）；`lib/` 编译产物（已 gitignore，含 `lib/client/jet-hub.js`）；`tests/unit/` 单元测试；`cordis.patch.yml` DSH bundle 补丁；`tsconfig.json` / `vitest.config.ts` 配置。

## DSH 插件契约

- 插件注入 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务；凭据存储用 `ctx.credentials`，ref 遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 用 `ctx.llm.registerProvider()` 注册；命令用 `ctx.commands.register()`；插件配置用 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyCnAuth`、`buddyAuth`、`lobsteraiAuth`、`traeCnAuth`、`qoderAuth`、`qoderCnAuth`）遵循统一接口：`login(options?)`（⚠️ `qoderAuth` / `qoderCnAuth` 有两种形态：无参走**浏览器设备流**（两段式），`{ pat }` 走 PAT 粘贴（即时 exchange）—— 两条路写**同一种凭据形态**，故下游 `refresh` / 额度 / 目录一行未改）、`status()`（configured、source、expiresAt、refreshable）、`refresh()`（手动静默续期）、`logout()`（清除凭据并停续期定时器）。

另有按凭据 ref 续期指定账号的 `refreshAccountCredential(refName)` —— 供账号卡片的「刷新」按钮。⚠️ **不要**用 `refresh()` 去刷账号池里的账号：它读写的是该 provider 的**默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），而账号卡片对应 `BUDDY_ACCOUNT_XXX`，会刷到另一个凭据上。服务名默认由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 分别注册为 `buddyCnAuth` / `buddyAuth`，`LobsteraiAuth` 为 `lobsteraiAuth`，互不覆盖；带连字符的 id 必须显式声明 `serviceName`（见「LLM Provider 约定」）。各 provider 登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理生命周期。

### 登录必须两段式：RPC 立即返回 loginUrl

`account.create` **不得**在 RPC 里等待用户完成浏览器登录：浏览器登录最长 10 分钟，等它返回时用户手势早已过期 —— 客户端拿到 URL 再开窗会被弹窗拦截，兜底逻辑于是自行开窗，把 DSH 页面顶掉。正确形态（`src/jet-hub-rpc.ts`）：

1. **第一段（同步返回）**：先拿到 `loginUrl`（buddy 系 `fetchAuthState`、lobsterai 的 `prepareLogin`），`pool.addAccount` 写入**占位条目**（`refreshable: false`、无 `expiresAt`），立即 `return { ok: true, value: { accountId, loginUrl } }`；
2. **宿主 opener 置空**（`openBrowser: () => {}`）—— 打开动作归客户端，宿主再开一次会变成两个标签页；
3. **第二段（后台）**：登录完成后写凭据、`pool.updateAccount` 补全 `nickname`/`expiresAt`/`refreshable`；失败则 `pool.removeAccount` 移除占位，避免留下无凭据的幽灵账号。

配套约束：`login.poll` 按 credentialRef 判断「凭据是否可解析」，与 provider 无关；**占位账号字段是 pending 形态**，时序上必须**先写凭据、再补全账号**（反过来会让轮询在凭据就绪前报成功）；**LobsterAI 登录是 provider 级互斥的**（`prepareLobsteraiLogin`）—— 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`，不新建也不复用（复用会让一份凭据被多个占位 accountId 共享，静默新建则每次点击堆积一个 loopback 端口直到 10 分钟超时）；`account.delete` 会 cancel 对应会话以释放端口。

### Qoder 设备流：两段式的第三种形态

Qoder 两区**两种登录形态并存**（`src/qoder-device-flow.ts`），由 `account.create` 载荷里**有没有 `pat` 键**分流：无 `pat` 键 → 浏览器设备流（两段式，秒回 `loginUrl` + 后台轮询）；`pat` 是 string（含 `''`）→ PAT 粘贴（即时 exchange，同步完成）。

⚠️ **判据是「键是否存在」而不是「值非空」**：`{ pat: '' }` 的语义是「用户提交了一个空 PAT」，必须回「PAT 格式不正确」，**不是**静默开一个授权页（用户会以为表单坏了）。故实现里是 `typeof req.pat === 'string'` / `options.pat !== undefined`。

**与既有两段式的三处差异**：① 互斥槽位按 provider 分键（`activeLoginSlots`），两区**各自独立**（它们不是同一批账号，一区的登录窗口不该挡住另一区），占位在**第一个 `await` 之前**同步写入 `'preparing'`；② **轮询可取消**（`AbortSignal`）—— Qoder 轮询是**每秒一次**的活跃循环，不取消会持续到 5 分钟超时，而槽位不释放会让用户此后所有登录都被 `login-in-progress` 挡住；③ **失败即移除占位**，且**超时也是终态**（不是可重试的瞬时故障）。

⚠️ **`machine_id` 读写用户真实 home**（`~/.qoder/.auth/machine_id` / `~/.qoder-cn/.auth/machine_id`），**与官方 CLI 同路径是刻意的**（混用时机器身份稳定，wasm 签名链才不失效）。**任何测试都必须注入 `homeDir`**，否则会污染用户环境；生产下 IO 失败退回内存态 UUID，**不抛错**。

⚠️ **设备流与 PAT 写同一种凭据形态**（`access_token` = 令牌或 PAT），故 `refresh` / 额度 / 目录三条下游链路一行未改。⚠️⚠️ **但设备流没有「换令牌」这一步**（真机 400 根因）：`dt-…` 本身就是可用 Bearer，交给 PAT 专用的 `jobToken/exchange` 恒回 400；分派与 poll 判据详见 README。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 **storage 域** `dsh_account_hub` 里保存账号索引（旧 settings 的 `jet-hub` namespace 仅作回退路径，见「存储与通路」），凭据本体存于 `ctx.credentials`：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤；**适配器必须以 `this.product.id` 作为 provider 实参查询账号池**（写死 `'buddy-cn'` 会让 Buddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`
- **凭据必须在发请求前按目标模型挑选**：`resolveCredential` / `refresh` 都接受可选 `model` 参数，适配器的 `stream()` 必须把 `options.model` 传下去（`src/index.ts` 的 `makeCredentialResolver` / `makeAccountPicker` 是**各 provider 共用的唯一接线**，新增 provider 一律走它们，不要再写一份）。`getAvailableAccount` 的限流过滤是**逐模型**的，传空串时按设计不过滤 —— 传空串会让每次请求都先白跑一遍已限额/积分耗尽的账号。**仅 `fetchModels` 拉模型目录**（目录对所有模型一致）与「全部账号都在冷却期」的退化路径用空串，两者都刻意保留，不要改成「一并过滤」

## 模型黑名单（Account Hub「显示列表」开关）

同一存储文档的 `disabledModels` 字段保存「被关闭的模型」（旧 settings 的 `jet-hub` namespace 是回退路径），形如 `{ 'buddy-cn': { 'glm-5.2': true } }`：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）；过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）；改名迁移会搬运 `disabledModels` 的 provider 键（`buddy`→`buddy-cn`、`workbuddy`→`buddy`），属**对调式搬运**，有测试钉死（`src/provider-rename-migration.ts`）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

## Codearts 上下文窗口（`contextWindow`）声明 —— 远端优先，静态表兜底（2026-09-21 接线）

⚠️ **动机：未声明 `contextWindow` 会让宿主压缩管线逐 step 白跑。** 宿主的上下文压缩在 `context === undefined` 时对**每个 step** 抛 `TargetPressureConfigError`，被 catch 成 warning 后继续 —— 表现是「自动压缩**永久失效** + 每个 step 都白跑一次」。**这不是措辞问题，是功能缺失**：声明值决定压缩阈值（`0.8 × 窗口`）与压缩后的保留预算。

⚠️ **远端 `context_window` 已接线（远端优先 → 静态兜底）**：`parseModelInfo` 读远端下发的 `context_window`，`resolveModel()` 改为 `remoteModel?.contextWindow ?? CONTEXT_WINDOWS.get(model)`。两个端点都下发该字段，此前被整条丢弃。**取值判据**：只接受**正的有限 number**，0 / 负数 / `NaN` / 字符串一律视为未声明（抓包见到的恒是 JSON number，为未见的形态发明解析规则属于猜测）。**属性缺省**（不是 `undefined` 值）是刻意的：它同时承担「回退静态表」与「兼容旧磁盘缓存」两件事。**远端失败 / 字段缺失必须原样回退静态表**（同一个 `??`），**网络抖动不该改变声明值的来源** —— 有 4 个方向的单测钉死（远端优先 / 缺字段 / 抛错 / 空目录）。

⚠️ **远端 `max_tokens` 刻意不接线**：出站 body 的 `max_tokens` 现由 `options.maxTokens ?? 65536` 决定（参考实现实测 65536 可用、131072 反而触发空流）。**接远端值属于行为变更**，超出范围 —— 有一条单测钉死 `max_tokens` 不会漏进目录项。

⚠️ **静态表（`CONTEXT_WINDOWS`）语义已改为「远端优先，此表为兜底快照」**，本轮只补两项：**`GLM-5.1: 202752`**（IDE 内置 `KERNEL_MODELS` 硬证据，与 GLM-5.2 同口径）、**`glm-5.2-sft-harmony: 202752`**（**推断项**，按 GLM-5.2 同口径，**无独立旁证**）。⚠️ **`openpangu-2.0-flash` / `openpangu-2.0-pro` / `GLM-5` 刻意留空**：三方都没有窗口旁证。**宁可缺省也不编造** —— 声明错值会直接改写宿主的压缩时机。

⚠️ **id 匹配沿用既有归一语义，不发明模糊匹配**：远端下发带日期后缀的 `deepseek-v4-flash-0731`，`parseModelInfo` 已归一为 `deepseek-v4-flash`，故 `resolveModel()` 按**归一后的 id 直接比对**即可命中。反向也钉死了：拿带后缀的 id 去 `resolveModel` **不会**命中远端窗口（它不是可路由 id）。

## 常见开发任务

新增功能：在 `src/`（客户端 UI 改 `plugin-src/client/`）实现 → 补单元测试 → `pnpm build:all`（host + client 两侧）→ `pnpm test` → 更新文档。调试用 `pnpm typecheck` 快速验证类型；构建报错先查 `lib/` 是否存在与 `tsconfig.json` 的 include/exclude。单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络。

## LLM Provider 约定

- **provider 名称**：`codearts` / `buddy-cn` / `buddy` / `lobsterai` / `trae-cn` / `qoder` / `qoder-cn`
- **provider id 与 cordis 服务名是两件事**，不要机械派生。默认规则是 `${product.id}Auth`，但**机械派生结果不合法（带连字符）的 id 必须显式声明 `serviceName`**：`trae-cn` → `traeCnAuth`、`buddy-cn` → `buddyCnAuth`、`qoder-cn` → `qoderCnAuth`（`BuddyProduct` 已有必填字段 `serviceName`）。⚠️ **`qoder` 是反面判据**：它**无连字符**，`qoderAuth` 本身就合法，故 `QoderProduct` **刻意不声明 `serviceName`** —— 那条规则不是「所有 provider 都得声明」，**不要为了「形态统一」把两行写成一样**。`src/plugin.spec.ts` 已钉死 `ctx['qoder-cnAuth']` 为 `undefined`、`ctx.qoderCnAuth` 才是那个实例。新增 provider 时：id 可以带连字符，服务名必须是合法的 JS 标识符风格。
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy-cn` / `buddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `trae-cn`：`Cloud-IDE-JWT <access>` + 同值的 `X-Ide-Token` / `X-Cloudide-Token`（无签名、无归属头）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy-cn` 与 `buddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**

> ⚠️ **出站协议值不随 provider id / 显示名变化。** `productCode`（`X-Product-Code`
> 仍是 `codebuddy` / `workbuddy`）、`attributionName`（`X-Product` / `X-IDE-Name`
> 仍是 `CodeBuddy` / `WorkBuddy`）、`platform`、`endpoint`、`apiDomain`、UA
> 都是**出站身份标识**，腾讯后台按它们归因用量 —— 改名时一个字符都不能动
> （`src/product.ts` 已在各处用 `⚠️ 协议值` 注释标出）。

## 积分领取（每日签到）

三套**协议完全不同**的实现，各自独立：

- **Buddy CN** —— `src/credits.ts`（Buddy 国际版后端无签到接口）：状态 `POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位）→ 领取 `POST /v2/billing/meter/daily-checkin`。幂等：重复领取回 HTTP 400 + `code:10001`，判定**以响应体 code 为准**。**不需要** `X-Device-Token`（图灵盾）—— 实测服务端未强制校验。
- **LobsterAI** —— `src/lobsterai-credits.ts`（三步）：槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`。幂等是**客户端**保证的：`idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`。`clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`；`platform=win32` 等是客户端形态伪装，非 Windows 也照发。
- **Trae CN** —— `src/trae-cn-credits.ts`（两步 + 设备头）：状态 `POST /trae/api/v2/ug/checkin_credits/status` → 未领则 `…/claim`，body 均为 `{"req_source":1}`。**幂等判据用 `checked_in`（账号级当日）**；`did_checked_in` 是**设备级**语义（换设备仍 false），**不要用**。**claim 必须带设备头**：`x-device-id`（**取自凭据的 `checkin_device_id`**，即登录时生成并上报的 16 位号）+ `x-device-type: windows` + `x-os-version` + `x-app-version: 3.3.102`，缺了回 `code:9004`。⚠️ `x-os-version` 是运行时取值（运行时取 `os.version()`），用 `node:os` 的 `os.version()`（`traeCnOsVersion()`）—— **这不是 `9074` 的解药**。
  - ⚠️ **`9074` = 设备身份**（旧定性已作废）：服务端按 `x-device-id` 记设备维度签到状态，`BoundDeviceID` **不被活动系统认可**。决定性单变量证据（status 端点 A/B）：全套头不变、仅把 `x-device-id` 换成官方 16 位号 → `did_checked_in` 由 `false` 翻转为 `true`。**修复**：登录时那个 16 位号落盘进凭据字段 `checkin_device_id`；**旧凭据**该号随机生成、服务端不回传、**无法恢复**，需**重新登录**（降级发 `BoundDeviceID`，**不伪造**）。
  - **claim 段有界重试**：`TRAE_CN_CLAIM_RETRY_CODES = [9074, 4007, 3004]`（**同时**要求命中共享的 `TRAE_CN_BACKOFF_CODES`），按 `[1000, 3000]` 退避 2 次，耗尽后按**最后一次**的 code/message/logid 返回。**status（读）段一次都不重试**；`9004` / `1001` **绝不重试**；`3003` 属 chat 通道码，**刻意不在**签到清单内；`9074` **不记冷却徽章**（等多久都不会自愈）。
  - **「设备号」是两个位置，不要混**：**登录 URL 的 `device_id`**（`generateTraeCnDeviceId`）**必须 16 位纯十进制**、**且它就是设备身份**（落盘为 `checkin_device_id`）；**凭据的 `device_id`** 是 exchange 返回的 `BoundDeviceID`（**活动系统不认**）。
  - **签到侧与 chat 侧头集已分开**（防「顺手统一」）：`traeCnCreditsHeaders` 自建 6 个头，删掉了官方不发的 `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token`；`x-device-brand` **刻意不发**（不猜硬件型号）。`traeCnAccessHeaders` 仍带 `Accept` 与两个等值 token 头，**chat 继续用它、一行未动**。
  - **失败时透传服务端 logid**：claim / status 失败若响应头带 `x-tt-logid`，透传到 `outcome.logid`，前端失败行追加 ` · logid <值>`。Buddy 系与 LobsterAI **未透传**（不发明字段名）。无 auth 时是 **HTTP 200 + `code:1001` + `enable:false`**（不是 401）—— 判定**以 body `code` 为准**；`1001` 译为「凭据已失效，请重新登录」。

三套共同约定：`credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**（停用只影响账号池的自动选择与限流切换）；逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批；返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 三套协议共用；**领取流程自带多步预检的 provider 传 `precheckStatus: false`**（LobsterAI 与 Trae CN —— 它们的 `claim` 内部已查过状态）。

**积分余额（Credits Balance）** 覆盖六个 provider、四套端点（「查不到」与「余额为 0」严格区分），与签到是**彼此独立**的能力 —— 不要因为「国际版没有签到」就推断也查不到余额：

- **Buddy 系**（两产品通用，仅 baseURL 随 `product.endpoint` 切换）：`POST /v2/billing/meter/get-user-resource`，body `{}`。⚠️ 响应**双层嵌套** `data.Response.Data.Accounts[]`（签到是单层 `data`，最易解析错）；余额取各包的 `CycleCapacityRemain`（本周期口径）相加，**不是** `CapacityRemainPrecise` / `CapacityRemain`（终身口径）；精确值经 `readPreciseNumber()` 优先读带 `Precise` 后缀的字符串版；**不用**截断过的 `TotalDosage`；包名回退 `PackageName` → `SubProductName` → `PackageCode`。该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），靠真实凭据实测发现。
- **LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`；**不要**用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分）。
- **Trae CN**：`POST /trae/api/v2/pay/web_user_ent_usage`，body `{"require_usage":true}`。
  - 礼包按 `available_endpoint` 分池：`0`=通用积分、`1`=Work 积分。**Trae CN 面板只显示通用池**：宿主在 `credits.balances` 的 trae-cn 分支**内联 `TRAE_CN_POOL_UNIVERSAL`** 作为 `fetchTraeCnCreditBalance(credential, product, pool)` 的第三个实参，返回的 `total` / `packages` / `expiredTotal` 只含那一个池。语义锚点：**面板显示的数字 = 该 provider 实际能花的池**。⚠️ **选池与账号池映射是两件事**：`poolProviderFor()` 只把面板 id 翻成池键，拿它去选池是错的（历史上曾被映射到同一键，今天恒等因而表现为「恰好正确」—— 不要依赖这个巧合）。
  - Work 积分只在 TraeWork（`work.trae.cn`）能花；TraeCode / IDE 对话（本插件走的路径）只消耗通用积分；TraeWork 中两类按**到期时间先后**扣，Work 专属**仅在到期时间相同时**优先；2026-09 起签到发的是通用积分。⚠️ 本插件已无 TraeWork 路径，故 Work 积分**不在任何面板展示**。
  - `TraeCnCreditBalance` 与共用的 `CreditBalance` 逐字段同构，收集器与卡片直接复用。⚠️ 曾经的超集字段 `pools` / `workTotal` 与 `[Work 积分]` 包名前缀**已随分池删除**；`CreditBalanceRow` 不做任何池判断。改前端后须 `pnpm build:all` 重建 bundle。**不要**用 `ug/activity/info` 的活动口径（写 200 work 实到 150 通用，口径陷阱）；包名回退链 `BALANCE_NAME_FIELDS`，包名原样透出。
  - ✅ **T7 已按真机校准**：该端点响应**没有 `code` 信封**（顶层是 `is_credits_billing` / `usage_summary` / `user_entitlement_pack_list`），沿用 code 信封会让余额**恒失败**；礼包数组在**根层**，额度嵌在 `entitlement_base_info.product_extra.package_extra.quota.credits_limit`（回退 `entitlement_base_info.quota`）减 `usage.credits_amount`（可为 `{}`，按 0 计）。候选表 + 指纹扫描 + 三级回退**保留作兜底**，主路径是嵌套口径。⚠️ **T8 仍待校准**：领取响应里「本次获得积分」的字段名（`TRAE_CN_CLAIM_CREDIT_FIELDS`），未命中时按 0 计。
- 累加后一律 `roundCredits` 规整两位小数；「余额为 0」与「查不到」严格区分（失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0）。RPC `credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮。
- **CodeArts 不支持**（华为云账号体系）：`productById('codearts')` 为 `undefined`，三个积分端点都会回 `bad-request: unsupported provider: codearts`。

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断。**默认关闭**（未登记者视为两项全无 —— 新增 provider 忘登记时最坏是暂时看不到积分，而不是每次开面板都发一个必然失败的请求）；**门控在发请求之前**（`loadCredits` / `claimCredits` 内部各有一道守卫 —— 按钮不渲染只是 UI 便利，不是安全边界）。

**`dailyCheckin` 为 true 的只有三个**：`buddy-cn`（中国版后端）、`lobsterai`（`client-activities` 三步）、`trae-cn`（`checkin_credits` 两步 + 设备头）。**`balance` 为 true 的是除 `codearts` 外的六个**，含 `buddy`（国际版无签到接口）、`qoder`（三池之和 `userQuota` / `addOnQuota` / `orgResourcePackage`，后两池容缺）、`qoder-cn`（同一实现、CN 端点，实测两池）。⚠️ **Qoder 两区 `dailyCheckin` 都是 `false` 但理由不同、不可合并叙述**：`qoder` 是**活动不存在**（每日 100 Credits 只能在桌面 App 手动领 —— 与 `buddy` 的「后端压根没有该接口」不是一回事），`qoder-cn` 是**端点未知**（待办，拿到端点后翻 `true`）；`credits-capabilities.spec.ts` 断言钉死取值。

⚠️ **改名的语义翻转点**：矩阵里 `buddy` 这个键**换了主人**（新主人是国际版）；迁移由 `src/provider-rename-migration.ts` 搬运。改动矩阵后必须同步 `PROVIDERS`（断言锁死两者条目集合相等），⚠️ **匹配器必须写 `[a-z-]+` 而非 `[a-z]+`** —— 后者让带连字符的 id（`trae-cn`）在 `PROVIDERS` 里隐形，漏登记时断言反而是绿的。CodeArts 面板报 `unsupported provider: codearts` 是后端 `productById()` 的正确契约，不是运行时故障。

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值，跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。
