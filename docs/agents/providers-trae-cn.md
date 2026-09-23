# Trae CN 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 `trae-cn` 时查阅。

## 服务名约定

原文照搬 AGENTS.md「LLM Provider 约定」中专属 Trae CN 行项。

- **provider id 与 cordis 服务名是两件事**，不要机械派生。默认规则是 `${product.id}Auth`，但**机械派生结果不合法（带连字符）的 id 必须显式声明 `serviceName`**：`trae-cn` → `traeCnAuth`（`BuddyProduct` 已有必填字段 `serviceName`）。新增 provider 时：id 可以带连字符，服务名必须是合法的 JS 标识符风格。

请求签名/鉴权：`trae-cn`：`Cloud-IDE-JWT <access>` + 同值的 `X-Ide-Token` / `X-Cloudide-Token`（无签名、无归属头）。

## 项目概述（登录 / 通道 / 结构级事实）

原文照搬 AGENTS.md「项目概述」中专属 Trae CN 段。

`trae-cn` 同样完全不同源（独立 `src/trae-cn*.ts`）。**登录**：本地回调 + PKCE(S256)，回调投递 `authCodeInfo`（双重编码 JSON）→ `POST /trae/api/v3/oauth/ExchangeToken`（body 五字段 `{ClientID,AuthCode,CodeVerifier,DeviceInfo,IDEVersion}`）；续期走 `POST /cloudide/api/v3/trae/oauth/ExchangeToken`（四字段），鉴权 `Cloud-IDE-JWT`。⚠️ 登录 URL 的 `client_id` **必须 snake_case**（`clientID` 会让授权页停在「认证中」，曾是报障根因），且必带 `auth_type=local` / `login_channel=native_ide` / `login_version=1` + PKCE 参数。三条结构级事实：SSE 是具名事件流（`event:output`）；业务失败在 HTTP 200 的 `event:error` 帧里（换号循环必须接住流内失败，按业务码而非状态码分类，见 `src/trae-cn-errors.ts`）；签到必须带设备头。⚠️ `/api/ide/*` 在 IDE 网关 `TRAE_CN_IDE_API_BASE`、不在 `api.trae.cn`（真因是 host 非路径），必须带齐 `x-app-id` / `x-ide-version-code` 等全套网关头。

⚠️ **chat 走 SOLO 通道**：`TRAE_CN_CHAT_PATH = '/api/agent/v3/llm_utils_chat'`（host 不变）。旧 `/api/ide/v1/chat` 是 aiserver 通道（只认 5 项旧池，恒回 `3003`、历史零成功），**不要再接回去**。**成败在端点 + body 的 `config_name` / `function`**：`config_name` = `model`，`function` = **模型来源**（`glm-5.3` 只在 `solo_work_remote`，写死 `solo_work_lite` 必 `4001`）；`content` 必须是 `[{type:'text',text}]`、`role:"developer"` 归一为 `system`、assistant 的 `tool_calls[].function` **出站改名 `function_call`**、`tools[].function.parameters` **字符串化**；思考字段名维持 `reasoning_effort_level` 不盲改。分类：`3003` 可重试（退避、不换号），`4023` / `4001` 直报；流内 `event:error` **必须直报业务码**（转成优雅关闭会让 DSH 报「Stream ended without finish_reason」，真因丢失）。

⚠️ **`4022` = 真·上下文窗口溢出，与 `4006` 同路映射 `CONTEXT_WINDOW_EXCEEDED`**：prompt token ≈ 1 000 000 时上游回 HTTP 200 + 流内 `event:error`（钳制二分 998 161 成功 / 1 002 248 失败；4 KB→1.5 MB 十一档全 200 ⇒ **无字节墙**）。修复前落「未知码」→ `INVALID_REQUEST`（致命、不触发压缩）；现在 `TRAE_CN_FATAL_CODES` 收 `4022`、`TRAE_CN_CONTEXT_OVERFLOW_CODES = [4006, 4022]` 供 `traeCnErrorCodeForAction` 映射 —— 那是**宿主唯一的补救路径**（DSH 自动压缩 + 重试），功能性必需。⚠️ 不违反「未知码直报不猜」：`4022` 已由阈值、排除项、同请求对照三件证据定案。⚠️ 中文说明只给 `4022`（`traeCnContextOverflowHint`），`4006` 文案刻意不动。

⚠️ **`4008` 实测是「通用积分池耗尽」，不是频率限流**：某账号通用池 `remain=0` 后连 4 KB 请求都回 `4008`（190 ms 即回、20 分钟不自愈），同刻健康账号 8 连全成功 ⇒ 与频率、字节量、并发无关。**动作与徽章不变**（仍留在 `TRAE_CN_RATE_LIMIT_CODES`，换号与冷却徽章都对），新增 `TRAE_CN_CREDITS_EXHAUSTED_CODES = [4008]` **只服务终报文案**（`traeCnCreditsExhaustedHint`，上游原文不改）。⚠️ **`scope` 必填**（`semantics` 已随 Work 路径整体删除）：由换号循环在退出点判定 —— `'pool-exhausted'` →「全部账号」、`'rotate-cap'` →「已尝试的账号」、`undefined`（无池 / 非换号失败 / 已产出正文后降级）→ **不追加**（此时谈账号是编造）。池名走实参；限流冷却措辞不同，`rotate-cap` + 冷却返回空串。

⚠️ **`x-ide-version-code` 是 SOLO 网关的「选表键」（4001 第二个根因）**：网关按该头决定上游返回哪张模型表，发旧 IDE 通道的 `107` 选出**空表** → 任何模型恒回 `4001`。成功组合 `20260820` + `x-ide-version: 0.1.61` + `User-Agent: Trae/0.1.61`；值域必须是 8 位日期式 `YYYYMMDD`（`20260801` 起表非空，**roster 会浮动、别当常量**），**只认这个头**。⚠️ **两组版本码同名不同物、不可合并**：`TRAE_CN_IDE_VERSION_CODE`(`107`) / `TRAE_CN_IDE_GATEWAY_VERSION`(`1.107.1`) 属 IDE 网关代际，`TRAE_CN_SOLO_VERSION_CODE`(`20260820`) / `TRAE_CN_SOLO_IDE_VERSION`(`0.1.61`) 属 SOLO 代际，四常量都在 `src/trae-cn-product.ts`（防「顺手统一」）；签到链路 `traeCnCreditsHeaders` 的版本头不动。

## 工具调用：内嵌在 `event:output` 帧里的 `function_call`

原文照搬 AGENTS.md「工具调用内嵌在 `event:output` 帧里，字段名是 `function_call`」段及其后续累积语义 / 收尾判据。

⚠️ **工具调用内嵌在 `event:output` 帧里，字段名是 `function_call`（2026-09-21 真机帧定案，修复「trae-cn 从未成功调用过一次工具」）**：上游**不**用独立的 `event:tool_call` 帧，而是挂在 `event:output` 的 data 里 —— `data:{"response":"","tool_calls":[{"index":0,"id":"call_…","type":"function","function_call":{"name":"glob","arguments":"",…}}]}`，后续增量片 `id`/`name` 为空串、`arguments` 是增量，收尾 `event:done`。

**缺陷本体**：`consumeTraeCnStream` 的 output 分支原先**只读** `response` / `reasoning_content`，`tool_calls` **从未被读取** ⇒ 工具调用整块丢弃 ⇒ 该步无 text 也无 tool-call 块 ⇒ `outcome.produced` 假 ⇒ 走 `{kind:'stop'}` ⇒ **回合终止且零报错**（343 会话扫描 **0/10** 成功调用过工具）。

⚠️ **字段名是 `function_call`（无 er），不要「修正」成 `function`** —— 与出站改名约定**同源**。⚠️ 此前文档写的「入站帧里仍是 `function`，解析侧不需要改动」**是错的**（那正是本缺陷的认知成因）；`function` 键**仍保留**，但只服务 OpenAI 式嵌套形态（`{tool_call:{function:{…}}}`）。

**累积语义（OpenAI 式）**：首片带 `id` + `name`（`arguments` 可能为空串）；后续片 `id` / `name` 为**空串** ⇒ **空串不覆盖已记录值**（防 `unknown tool ""`）。**同帧内多个调用**按各自的 **`index`** 分块（漏发 `index` 时回退到**数组位置**而非 0 —— 写死 0 会让并行调用并进第一个调用的参数串）；**`response` 与 `tool_calls` 同帧共存时两者都产出**。**空数组 / `null` / 非数组 / 单项缺 `function_call` 一律不产出块**（缺项**跳过**而非伪造 `unknown tool ""`）。

**收尾判据**：`finish` 只看「该步有没有**产出块**」（`outcome.produced` + `hasToolCalls`），**不是**「有没有 text」—— 只有工具调用、零正文时同样是 `{kind:'tool-calls'}`，不得判成 `EMPTY_RESPONSE`。既有独立 `event:tool_call` 帧的**分支保留不动**，两种形态共用同一个 `parseTraeCnToolCall` 入口与同一条累积路径（`accumulateTraeCnToolCall`），**不得复制第二份解析逻辑**。**出站零变更**：`buildTraeCnSoloBody` 一行未动（有逐字节测试钉死）。夹具 `tests/unit/fixtures/trae-cn-output-tool-calls-*.sse.txt`。

## 模型目录 = 动态端点 + 静态回退 + 五道过滤网

原文照搬 AGENTS.md「模型目录 = 动态 `POST /api/ide/v1/get_detail_param` + 静态 11 项回退」段。

**模型目录 = 动态 `POST /api/ide/v1/get_detail_param` + 静态 11 项回退**（`src/trae-cn-models.ts`）：对 `["solo_work_remote","solo_work_lite"]` 各拉一次取并集（remote 优先），解析 `config_info_list[].config_name` / `display_config.display_name` / `context_window_tokens.dev`（回退 `model_detail_list[0].prompt_max_tokens`）与 `.max_tokens`（⚠️ **dev 优先**：真机 `glm-5.3` 两字段 200000 / 168000，取哪个只影响宿主压缩触发点，都不是硬限）。**五道过滤网**（同在 `mergeTraeCnDirectory` 一个循环里）：① 内部 agent 项（`summary` / `file_search_agent` / `explore_sub_agent_v2` / `browser_use_subagent` / `computer_use_subagent` + 形态含 `agent`/`subagent`）；② 账号私有 BYOK 项（`isCustomTraeCnModel`：`usage === 'custom_model'` + 兜底 id 前缀 `custom_model_`，14 项；⚠️ `config_source` 恒 1、`display_config.is_custom_model` 恒 false 都不可用；`Array.isArray(custom_models)` 会漏 `custom_model_placeholder`）；③ 客户端自隐项（`entry.invisible === true`，8 项；⚠️ **三态**，`undefined` **必须保留** —— 40 项里 14 项缺该字段，含 `qwen3.8-max` / `qwen-3.7-plus` 两个正常项；`invisible:false` 的 `kimi-k2.7-code` / `kimi-k2.6` 也必须保留）；④ **官方停用开关**（`entry.configSwitch === false`，即上游 `config_switch`；⚠️ 上游 `trae.ts` 的硬性过滤之一，本模块曾**整条漏接**；⚠️ **三态、方向与 invisible 相反** —— 只有严格 `false` 才剔，`true` 与 `undefined` **都必须保留**，写成 `!entry.configSwitch` 会把整个目录清空；该次取证的 roster 上零命中，是防将来下架用）；⑤ remote 成功时剔除 lite 独有项。**多模态、思考档位、档位三件事都只补不增**；12h TTL 缓存、**失败不写缓存**；整体失败回退 `TRAE_CN_FALLBACK_MODELS`（11 项，全映射 `solo_work_remote`）。**规模：40 − 5（内部）− 14（custom）− 8（invisible）= 13 项**（⚠️ 内部是 **5** 项 —— `computer_use_subagent` 属 lite 独有、第 ④ 条已出局，易漏算）。**静态表已剔除 5 项 SOLO 不可调 id**（`glm-5.3-flash` / `deepseek-v4.1-flash` / `kimi-k2.8-preview` / `qwen3.8-flash` / `Doubao-Seed-Code`）；表外模型的 `4001` 追加提示「该模型已不在 Trae CN 可用目录中，请在 Hub 的模型列表里重选」。

## 档位数据源（solo_agent_remote 组）

原文照搬 AGENTS.md「档位数据源」段。

**档位数据源**：SOLO 目录已对可调模型停发 max ⇒ 改用 `GET https://solo.trae.cn/api/remote/v1/models?functions=solo_agent_remote`，响应按 `{data:{list:[{function,models:[…]}]}}` 分组，**只取 `function === "solo_agent_remote"` 那组**（**绝不跨组拼接** —— 档位缺失只是回到现状，跨池取值却是把别的池的档位灌进 IDE 目录）。模型 id 在 `name`（不是 `display_name`）；判据 = `max_mode === true`（`max_mode:false` 的三项 max 恰好是 `0`）+ `context_window_tokens.max`。请求头只有 5 个（`traeCnAccessHeaders`），**刻意不带 SOLO 网关头**。`applyTraeCnAgentTiers`：只补**现有**条目的 `maxContextWindow`，命中 `max_mode` 且 `max > entry.contextWindow` 才写，`contextWindow === undefined` 跳过，**绝不新增条目**（agent 组独有的 `Doubao-Seed-Code` 加进来必然 `4001`）；失败静默降级（目录照常返回、不写缓存、目录整体落空时短路）。⚠️ 档位表与 roster 都会漂；agent 组的 `reasoning_effort_config` **刻意不接**。

## 思考档位接线

原文照搬 AGENTS.md「思考档位已接线」段。

**思考档位已接线**：静态表 11 项里 8 项声明 `reasoning`（取自真机 vscdb 的 `reasoning_effort_config`，**`chat_v3` 那套、不是 `solo_agent`**），id 逐字符照抄 `light`/`high`/`extra_high`，**下发字段名是 `reasoning_effort_level`**（`reasoning_effort` 是字节内网账号那套，已由官方 bundle + `ai_agent.dll` 三方互证；真机 A/B 因账号回 4008 无法区分字段名，「档位是否真生效」仍未验证）。⚠️ **SOLO 目录端点不提供档位**（用户报障根因）：带 `reasoning_effort_config` 的项**全是 `{support_thinking:false}` 空壳** ⇒ `parseTraeCnDirectory` 在 SOLO 目录上永远读不出档位。**修法**：`applyTraeCnStaticMetadata` 在按 id 补多模态之外**同源按 id 补档位**。⚠️ **判据是 `entry.reasoningEfforts === undefined` 时才补，绝不能看目录的 `support_thinking`**（目录恒 `false`，照多模态那种「已表态就不覆盖」的写法永远补不上；多模态判据确实是 `supportsImages === undefined`，两者**刻意不同**）。补齐 8 项：`Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo` / `glm-5.3` / `glm-5.2` / `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` / `kimi-k3`(def `extra_high`) / `qwen3.8-max`；动态目录独有的 `kimi-k2.7-code` / `kimi-k2.6` **不在静态表** → 不补。

## 档位：红线与判据

原文照搬 AGENTS.md「红线与判据」段。

**红线与判据**：机制是**纯声明值切换，出站请求体一个字段都不动** —— 变的只有 `resolveModel().context.contextWindow`（宿主压缩阈值 `0.8×窗口` + 压缩后保留预算），有逐字节比对两次请求体的用例钉死。三条判据缺一不可：① 写入只有一个落点 —— `max` 严格大于**实际生效的默认档**才写（`max<=dev` / `0` / 缺失都不收）；② RPC `model.setContextBudget` 只接受**精确等于**该模型当前目录条目的某个档位（省略 / 等于默认档 = 清除预算），错误信息必须带实际可用档位值；③ 读取时 `effectiveContextWindow` 再判一次。⚠️ **编造值静默退回默认档是设计**。⚠️ **静态回退表 11 项一律不带 `maxContextWindow`**，故静态路径下模型自动无档位 UI。

## 档位来源与注册表

档位通用机制与注册表（createContextTierRegistry / 第 10 实参注入）见 docs/agents/account-hub-storage.md。

## 积分领取（每日签到）

原文照搬 AGENTS.md「积分领取」及「积分能力必须在请求前判定」中专属 Trae CN 段。

- **Trae CN** —— `src/trae-cn-credits.ts`（两步 + 设备头）：状态 `POST /trae/api/v2/ug/checkin_credits/status` → 未领则 `…/claim`，body 均为 `{"req_source":1}`。**幂等判据用 `checked_in`（账号级当日）**；`did_checked_in` 是**设备级**语义（换设备仍 false），**不要用它判幂等**。**claim 必须带设备头**：`x-device-id`（**取自凭据的 `checkin_device_id`**，即登录时生成并上报的 16 位号）+ `x-device-type: windows` + `x-os-version` + `x-app-version: 3.3.102`，缺了回 `code:9004`。⚠️ `x-os-version` 是运行时取值（运行时取 `os.version()`），用 `node:os` 的 `os.version()`（`traeCnOsVersion()`）—— **这不是 `9074` 的解药**（`9074` 根本不是设备问题，见下条）。
  - ⚠️ **`9074` = 设备号被服务端拉黑**（**2026-09-23 第五次定性，现行**；旧定性「频次软限流」「活动级名额」「设备身份」「名额/风控」**均已作废**）：服务端把「在**未产出奖励**的 claim 中出现过的设备号」拉黑。真机**单变量矩阵**（claim）：账号级已签 → `code:0`（**任意设备号**都成功）；账号未签 + 设备已签 → `code:9095`；两者都未签 + 设备号**干净** → `code:0`（**首次 claim 即成功**）；两者都未签 + 设备号**被拉黑** → `code:9074`。第 5 次定性的证据是**同账号同 token、11 秒间隔的对照**：换全新 16 位号首次 claim 直接 `code:0`，换回旧号立刻又是 9074（独立复现）。⚠️ 第 3 次定性「设备身份」与第 4 次「名额/风控」都被这一行推翻 —— 服务端**确实在认设备**，但判据是「这个号有没有在黑名单里」，**不是**「它是不是登录时那个」。已被矩阵**排除**的候选（不要再回头查）：传输头 / 会话 / `req_source` / UA 都不是条件。官方客户端用**机器级稳定 AHA 号**；部分账号的 `checkin_device_id` 是 exchange 绑定的稳定号（重登不换号），故重登治不了它 —— 这正是「河童重登无效」之谜。
  - **9074 的处置 = 换新设备号重试一次**（用户 **2026-09-23 拍板**，见下方「拍板记录」）：`rotateTraeCnCheckinDeviceId()` 用**登录时同一个生成器**（`generateTraeCnDeviceId`）生成全新 16 位号，立刻重发一次 claim（`TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT = 1`，**硬编码不循环**）。**两种结果都把新号写回凭据**（`checkin_device_id` 持久化 + `device_id_source = 'rotated-after-9074'`）⇒ 下一轮 sweep 用干净号起步。重试**成功** → `claimed`；重试**仍 9074** → `unavailable`（**不写** checkins ⇒ 宿主 4h sweep 下轮仍试，届时用的是新号）。⚠️ 它**不走** `TRAE_CN_CLAIM_RETRY_CODES`（那张表是「等几秒再问同一个请求」的退避，退避再久也不会让被拉黑的号可用）。
  - **四档处置**（claim 失败码分流）：`9095` → 归一 `already-claimed`（今天这份已到手，写今日状态）；`9074` → **先换号重试一次**，结果**按重试自己的码**再分流；其余（`1001` / `9004` / …）→ `failed`。用户文案：9074 为「**暂不可签，稍后自动重试**」（只在**换号后仍是 9074** 时出现），**旧文案「请重新登录登记设备身份」已删除**（重登治不了 9074）。
  - **「设备号」是两个位置，不要混**：**登录 URL 的 `device_id`**（`generateTraeCnDeviceId`）**必须 16 位纯十进制**、落盘为 `checkin_device_id` 并作为签到头；**凭据的 `device_id`** 是 exchange 返回的 `BoundDeviceID`（chat 侧头集用它，**两条协议线刻意分道**）。⚠️ 换号路径**只改 `checkin_device_id` 与 `device_id_source` 两个字段**，`device_id` 与其余字段逐字段原样保留；登录 / 续期 / 兼容分支仍一律写 `'exchange-bound-device-id'`。
  - **claim 段请求内重试**：`TRAE_CN_CLAIM_RETRY_CODES = [4007, 3004]`（**同时**命中共享的 `TRAE_CN_BACKOFF_CODES`），按 `[1000, 3000]` 退避 2 次，耗尽后按**最后一次**的 code/message/logid 返回。⚠️ **`9074` 已于 2026-09-23 移出本表**（它的重试是**换号那一次**，不是退避），但**仍在 chat 侧共享表 `TRAE_CN_BACKOFF_CODES` 里** —— 收窄签到**只动那张窄表**，不要顺手改共享表。**status（读）段不重试**；`9004` / `1001` / `9095` **绝不重试**；`3003` 属 chat 码、**刻意不在**清单内；`9074` **不记冷却徽章**。**头集与 chat 已分开**（防「顺手统一」）：`traeCnCreditsHeaders` 自建 6 个头（删掉官方不发的 `Accept` / `Origin` / `Referer` / 两个 token 头；`x-device-brand` **刻意不发**），`traeCnAccessHeaders` 供 chat **一行未动**。
  - **凭据写回的唯一机制**：`TraeCnCreditsOptions.persistCredential(credential)` 出口 → `CreditsEndpointDeps.persistCredential(refName, credential)`（`collectClaimResults` 按当前 `entry.credentialRef` 闭包出 `refName`）→ `ctx.credentials.set(credentialRef(refName), serializeTraeCnCredential(…))`。**只在 claim 真的因 9074 换过号时调用**（首发成功 / 非 9074 失败都不调）。写回失败**只记 onDebug、不炸签到主流程**（它只决定下一轮起点）。`.credentials.yaml` 的落盘由 `ctx.credentials` 承接，不绕开它。三条入口（单账号 `checkin.perform` / 一键 `credits.claimAll` / 4h `checkin.sweep`）**共用 `runCreditsClaim` 的同一分支**，故一处接线全覆盖，无旁路。⚠️ **换号写回是「整份凭据覆盖写」，两路并发必然互相盖掉**：故宿主侧 `checkin.perform` 与 sweep 共享同一把互斥（`checkinBusy`，被挡方拿 `busy: true`、**零 claim**），见 `docs/agents/auto-checkin-design.md` §9。
  - **失败透传服务端 logid**：claim / status 失败若响应头带 `x-tt-logid` → `outcome.logid`（`unavailable` 也带），前端追加 ` · logid <值>`（Buddy 系与 LobsterAI **未透传**）。无 auth 时是 **HTTP 200 + `code:1001` + `enable:false`**（不是 401）—— 判定**以 body `code` 为准**，`1001` 译为「凭据已失效，请重新登录」。

### `9074` 换号重试：用户拍板记录（2026-09-23）

真机单变量矩阵定案当天由用户拍板采用本方案，**并明确约定**：明天实测若无效，
**revert 本 commit**。故实现刻意做成**内聚、单点、易 revert**：

| 落点 | 内容 |
|---|---|
| `src/trae-cn-credits.ts` | `rotateTraeCnCheckinDeviceId` / `TRAE_CN_ROTATE_DEVICE_RETRY_LIMIT` / `claimTraeCnWithDeviceRotation` / `persistRotatedDeviceId` + `claimTraeCnDailyCheckin` 里那一个 `if` 分支 |
| `src/trae-cn-product.ts` | `TraeCnDeviceIdSource` 多一个取值 `'rotated-after-9074'` + 常量 `TRAE_CN_DEVICE_SOURCE_ROTATED` |
| `src/account-hub-rpc.ts` | `CreditsEndpointDeps.persistCredential` + trae-cn 分支的两行接线 |
| `tests/unit/trae-cn-credits.spec.ts` | 「9074 换设备号重试一次」整组用例 |
| `tests/unit/trae-cn-credits-rpc.spec.ts` | 两条 RPC 级用例（含写回断言） |

**revert 时要一起还原**（否则留下悬空行为）：`claimTraeCnDailyCheckin` 的 9074 分支
退回「直接归 `unavailable`」、`checkin-rpc.spec.ts` 里那两条 claim **次数**断言
（2 → 1、3 → 2）与 `trae-cn-credits-rpc.spec.ts` 里的旧断言。出站协议值**零变更**
（`req_source` / 头集 / 端点全部未动），只有 `x-device-id` 的**取值**在换号路径上
不同 —— 那正是本改动的全部内容。

## 积分余额

原文照搬 AGENTS.md「积分余额」「积分能力必须在请求前判定」中专属 Trae CN 段。

- **Trae CN**：`POST /trae/api/v2/pay/web_user_ent_usage`，body `{"require_usage":true}`。
  - 礼包按 `available_endpoint` 分池：`0`=通用积分、`1`=Work 积分。**Trae CN 面板只显示通用池**：宿主在 `credits.balances` 的 trae-cn 分支**内联 `TRAE_CN_POOL_UNIVERSAL`** 作为 `fetchTraeCnCreditBalance(credential, product, pool)` 的第三个实参，返回的 `total` / `packages` / `expiredTotal` 只含那一个池。语义锚点：**面板显示的数字 = 该 provider 实际能花的池**。⚠️ **选池与账号池映射是两件事**：`poolProviderFor()` 只把面板 id 翻成池键，拿它去选池是错的（历史上曾被映射到同一键，今天恒等因而表现为「恰好正确」—— 不要依赖这个巧合）。
  - Work 积分只在 TraeWork（`work.trae.cn`）能花；TraeCode / IDE 对话（本插件走的路径）只消耗通用积分；TraeWork 中两类按**到期时间先后**扣，Work 专属**仅在到期时间相同时**优先；2026-09 起签到发的是通用积分。⚠️ 本插件已无 TraeWork 路径，故 Work 积分**不在任何面板展示**。
  - `TraeCnCreditBalance` 与共用的 `CreditBalance` 逐字段同构，收集器与卡片直接复用。⚠️ 曾经的超集字段 `pools` / `workTotal` 与 `[Work 积分]` 包名前缀**已随分池删除**；`CreditBalanceRow` 不做任何池判断。改前端后须 `pnpm build:all` 重建 bundle。**不要**用 `ug/activity/info` 的活动口径（写 200 work 实到 150 通用，口径陷阱）；包名回退链 `BALANCE_NAME_FIELDS`，包名原样透出。
  - ✅ **T7 / T8 均已按真机定案**：① 余额端点**没有 `code` 信封**（顶层 `is_credits_billing` / `usage_summary` / `user_entitlement_pack_list`），沿用 code 信封会让余额**恒失败**；礼包数组在**根层**，额度 = `entitlement_base_info.product_extra.package_extra.quota.credits_limit`（回退 `entitlement_base_info.quota`）− `usage.credits_amount`（可为 `{}`，按 0 计），候选表 + 指纹扫描 + 三级回退**保留作兜底**。② `claim` 的完整响应就是 `{"code":0,"message":"success"}`、**无积分字段** ⇒ 旧候选表 `TRAE_CN_CLAIM_CREDIT_FIELDS` 注定落空（表现为「领取成功 **+0** 积分」）；积分数只在 **status 的 `credits`**（真机 150，与「签到奖励」包 `credits_limit:150` 吻合），故 `code===0` 后**补查一次 status**（复用 `fetchTraeCnCheckinStatus`，候选表与 `readClaimedCredit` **已整体删除**）；**补查失败不改变 `claimed` 语义**（credit 落 0 + onDebug 记原因）、**不重试**。

## TraeWork 路径移除记录

原文照搬 AGENTS.md「TraeWork 路径 provider（已于 `47bd690` 移除）」整节。

该 provider 已整体删除（官方把 Work 侧模型合并进通用通道，`trae-cn` 一条通道即可覆盖 —— 真机动态目录 14 项已含原 Work 独有的 `kimi-k2.7-code` / `kimi-k2.6`）。它的整节协议要点、Account Hub 面板与池映射随之作废，**不要再按已删代码去描述它**；Work 专属积分池（`available_endpoint=1`）在服务端仍在，但只有 TraeWork 网页/桌面版能花（见「积分余额」）。

**面板 id → 账号池键的收敛点仍是 `src/account-hub-rpc.ts` 的 `poolProviderFor()`**（客户端不做映射，发的就是面板 id）：移除 Work 后它是**恒等函数**，但**刻意保留** —— 六个入口（`account.list` / `account.retestAll` / `account.resetAll` / `credits.status` / `credits.claimAll` / `credits.balances`）仍经它把「面板 id」翻成「池键」，将来若再出现复用别人账号的 provider，加一行即可，不必把 if 撒进六处调用点。

hub 映射入口与选池规则见 docs/agents/account-hub-storage.md。