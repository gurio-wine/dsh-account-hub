# 项目指令：dsh-account-hub

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 子代理路由（2026-09-19 更新）

- **派发子代理一律不指定 provider / model / reasoning effort**：宿主已装插件自动选择（按 `~/.dsh` 的路由配置与可用性现算），本体手动指定会与该机制竞争并导致路由漂移。提示词里也不要写「用某模型」这类字样。
- 历史路由记录（`buddy` / `deepseek-v4.1-flash` / `max` 等）已作废，仅当自动选择插件失效、派发报「无可用供应商/模型」时才回退人工核实 `list_subagent_models` 并临时指定。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-account-hub`），提供华为云 Codearts 浏览器登录与凭据管理功能。插件还附带 `buddy-cn`（**Buddy CN**，腾讯 CodeBuddy 中国版）、`buddy`（**Buddy**，腾讯 WorkBuddy **国际版** / WorkBuddy AI）与 `lobsterai`（**LobsterAI**，有道）三个 LLM provider 路由，以及 `trae-cn` / `trae-cn-work`（字节跳动 **Trae 国内版**及其 TraeWork 路径）与 `qoder` / `qoder-cn`（**Qoder** 的**国际版与国内版两个 region**，PAT 粘贴式登录 —— 本插件唯一的非浏览器登录形态）。

> **命名（2026-09-18 改名后）**：显示名与 provider id 一律按**产品品牌**，不再用历史代号。
> `buddy-cn` / `buddy` 是**新**命名；旧命名 `buddy`（中国版）/ `workbuddy`（国际版）
> 已作废，仅在下文的历史叙述、迁移映射与**出站协议值**里出现。改名详情与数据迁移见
> README 的「provider 改名与数据迁移」。

`buddy-cn` 与 `buddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与上述两者**完全不同源**：登录方式、请求头、续期载荷、签到流程、版本号来源都不一样，因此实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 那里面 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 等字段对 LobsterAI 全部无意义。详见 README 的「LobsterAI provider」章节与 `docs/lobsterai-integration-plan.md`。

`trae-cn`（字节跳动 **Trae 国内版**）同样完全不同源，独立一套 `src/trae-cn*.ts`。**登录协议已用真机校准（2026-09-17）**：本地回调 + **PKCE(S256)**，回调投递 `authCodeInfo`（双重编码 JSON）→ `POST /trae/api/v3/oauth/ExchangeToken`（body 五字段 `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}`）；续期走**另一个**端点 `POST /cloudide/api/v3/trae/oauth/ExchangeToken`（body 四字段），鉴权用 `Cloud-IDE-JWT`。**登录 URL 的 `client_id` 是 snake_case**（写成 `clientID` 会让授权页停在「认证中」，是曾经的报障根因），且必须带 `auth_type=local` / `login_channel=native_ide` / `login_version=1` 与 PKCE 参数。**产品配置 + 认证 + 模型路由（`src/trae-cn-adapter.ts`）+ 签到与积分余额（`src/trae-cn-credits.ts`）均已实现**。三个关键事实决定了它的适配器与其它 provider 结构不同：**SSE 是具名事件流**（`event:output`，不是 OpenAI 的 `data:{choices}`）、**业务失败发生在 HTTP 200 的 `event:error` 帧里**（故换号循环必须接住流内失败，错误分类按业务码而非状态码，见 `src/trae-cn-errors.ts`）、**签到必须带设备头**（见「积分领取」）。**T5 / T6 / T7 均已真机校准**（2026-09-18）：T6 的真实病因是 **host** 而非路径（`/api/ide/*` 不在 `api.trae.cn`，在 IDE 网关 `TRAE_CN_IDE_API_BASE`；旧路径 `/api/ide/v1/chat` 本来就在对的 host 上，且必须带齐 `x-app-id` / **纯数字** `x-ide-version-code` 等全套网关头；⚠️ 该「纯数字」的取值后来按 SOLO 代际改为**日期式**，见下一段）；T7 余额端点**无 code 信封**、礼包在根层 `user_entitlement_pack_list`、额度嵌在 `entitlement_base_info...quota.credits_limit` 减 `usage.credits_amount`。⚠️ **T9 已于 2026-09-20 第三次修正**：原结论「签到**不校验设备号形态**（只认设备头是否存在）」**观测成立但推论错了** —— 不校验**形态** ≠ 不校验**设备**；服务端按 `x-device-id` 认设备，这正是 9074 的真根因（详见「积分领取」）。

⚠️ **chat 端点已迁移到 SOLO 通道（2026-09-19，五轮真机取证定案）**：`TRAE_CN_CHAT_PATH = '/api/agent/v3/llm_utils_chat'`（host 不变）。旧 `/api/ide/v1/chat` 是**旧 aiserver 通道**，`llm_raw_chat` 场景只认 5 项旧池，我方请求恒回 `3003 all models failed`（历史零成功）；真实客户端的新池聊天走 `harness.dll` 原生链路，第三方无法复刻，而 SOLO 通道**已用我方凭据实测走通**。**决定成败的是端点 + body 的 `config_name` / `function` 两字段**（头集合差异已排除）：body 必须带 `config_name`（= `model`）与 `function`（**模型来源 function**，`glm-5.3` 只在 `solo_work_remote`，写死 `solo_work_lite` 必 `4001`），消息 `content` 必须是 `[{type:'text',text}]`、`role:"developer"` 归一为 `system`、assistant 的 `tool_calls[].function` **出站改名 `function_call`**、`tools[].function.parameters` **字符串化**。**思考字段名维持 `reasoning_effort_level` 不盲改**（`reasoning_effort` 是 SOLO 代际写法、未 A/B 验证）。错误分类新增 **`3003` 归可重试（退避，不换号）**，`4023` / `4001` 直报；流内 `event:error` **必须直报业务码**，绝不转成优雅关闭（否则 DSH 报「Stream ended without finish_reason」，真因丢失）。

⚠️ **`x-ide-version-code` 是 SOLO 网关的「选表键」（2026-09-19 二次取证，4001 的第二个根因）**：SOLO 网关按该头**决定上游返回哪张模型配置表**，发旧 IDE 通道的 `107` 选出的是**空表** → **任何模型**恒回 `4001 param is invalid`（`bedd149` 的「版本头维持现状」假设是错的）。实机验证过的成功组合：`x-ide-version-code: 20260820` + `x-ide-version: 0.1.61` + `User-Agent: Trae/0.1.61`。**值域必须是 8 位日期式 `YYYYMMDD`**（目录端点值扫描：`20260801` 起表非空；`20260919` 快照 41 项、`20260920` 复测 **40 项** —— roster 会浮动，**不要当常量**）；**只认 `x-ide-version-code`**，`x-app-version-code` 与选表无关（已隔离验证）但同发同代际以免自相矛盾。⚠️ **两组版本码同名不同物、不可合并**：`TRAE_CN_IDE_VERSION_CODE`（`107`）/ `TRAE_CN_IDE_GATEWAY_VERSION`（`1.107.1`）属 **IDE 网关代际**（保留备查、防「顺手统一」），`TRAE_CN_SOLO_VERSION_CODE`（`20260820`）/ `TRAE_CN_SOLO_IDE_VERSION`（`0.1.61`）属 **SOLO 代际**，四个常量在 `src/trae-cn-product.ts`；SOLO 通道 UA 也随之改为 `Trae/0.1.61`（原取签到线 `TRAE_CN_APP_VERSION` 属「顺手复用」）。**签到链路 `traeCnCreditsHeaders` 的版本头不动**（另一条协议线，`x-app-version: 3.3.102` 已独立校准；⚠️ 2026-09-20 该构造器的**头集**已按官方 claim 对齐、`x-device-id` 已换源，但**版本号常量不属于那次改动**）。

**模型目录 = 动态 `POST /api/ide/v1/get_detail_param` + 静态 11 项回退**（2026-09-19 起，推翻此前「刻意走静态表、不接远端」的记载 —— 那条结论对 `model_list` / `batch_get_detail_param` 成立，但**试错了端点**）：CN 区对 `["solo_work_remote", "solo_work_lite"]` **各拉一次取并集（remote 优先）**，解析 `config_info_list[].config_name` / `display_config.display_name` / `model_detail_list[0].prompt_max_tokens`（回退 `context_window_tokens.dev`）与 `.max_tokens`；**四道过滤网**（2026-09-20 扩至四道，全部在 `mergeTraeCnDirectory` 的同一循环里）：① **内部 agent 项**（点名 `summary` / `file_search_agent` / `explore_sub_agent_v2` / `browser_use_subagent` / `computer_use_subagent` + 形态含 `agent`/`subagent`）；② **账号私有 BYOK 项**（`isCustomTraeCnModel`：主判据 `usage === 'custom_model'` + 兜底 id 前缀 `custom_model_`，14 项，实测两条判据双向差集为空；⚠️ 陷阱字段 `config_source` 恒 1、`display_config.is_custom_model` 恒 false 都不可用；`Array.isArray(custom_models)` 会漏 `custom_model_placeholder`）；③ **客户端自隐项**（`entry.invisible === true`，8 项；⚠️ **三态**，`undefined` **必须保留** —— 40 项里 14 项缺该字段，其中含 `qwen3.8-max` / `qwen-3.7-plus` 两个正常项；`kimi-k2.7-code` / `kimi-k2.6` 是 `invisible:false` 的**正常项必须保留**）；④ **remote 成功时剔除 lite 独有项**；**不接 remote 骨架合并**（会引入 join 不到的不可调项）；**多模态标记与思考档位由静态表按 id 补齐**（目录两个都不提供，只补不增，见下条）；12h TTL 缓存、**失败不写缓存**；整体失败回退 `TRAE_CN_FALLBACK_MODELS`（**11 项**，全部映射 `solo_work_remote`）。**过滤后规模：40 − 5（内部）− 14（custom）− 8（invisible）= 13 项**（⚠️ 内部是 **5** 项，`computer_use_subagent` 属 lite 独有、在第 ④ 条已出局，易漏算）。**该表已从真机 16 项剔除 5 项 SOLO 不可调 id** —— `glm-5.3-flash` / `deepseek-v4.1-flash` / `kimi-k2.8-preview` / `qwen3.8-flash` / `Doubao-Seed-Code`（实测不在 SOLO roster：`20260919` 快照 41 项 / `20260920` 复测 **40 项**，**roster 会浮动、不要当常量**）；理由：IDE 通道已废弃、本 provider 只走 SOLO，留着它们只会产出必然 `4001` 的选项（`Doubao-Seed-Code` 的剔除只针对本 provider，它在 `trae-cn-work` 里是默认模型）。**表外模型的 `4001` 追加可读提示**「该模型已不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选」（判定与 `function` 路由同源；其它码不加）。实现集中在 `src/trae-cn-models.ts`（目录解析/合并/拉取 + 静态表 + `traeCnSoloHeaders`，chat 与目录共用同一份网关头）。

**思考档位已接线**：静态表 11 项里 **8 项**声明 `reasoning`（档位取自真机 vscdb 的 `reasoning_effort_config`，**`chat_v3` 那套、不是 `solo_agent`** ——两者默认档不同），id 逐字符照抄 `light`/`high`/`extra_high`，**下发字段名是 `reasoning_effort_level`**（`reasoning_effort` 是字节内网账号那套，已由官方 bundle + `ai_agent.dll` 三方互证；真机 A/B 因账号回 4008 配额而无法区分字段名，「档位是否真生效」仍未验证）。⚠️ **档位来源已变更（2026-09-20，用户报障根因）**：**SOLO 目录端点不提供档位** —— 实测 39/40 项里带 `reasoning_effort_config` 的 9/10 项**全是 `{support_thinking:false}` 空壳**（无 `options`/`default_level`），其余连字段都没有，故 `parseTraeCnDirectory` 在 SOLO 目录上**永远读不出档位**；动态目录取代静态表后「思考程度」选择器**整行消失**。**修法**：`applyTraeCnStaticMetadata`（原 `applyTraeCnStaticModalities`，2026-09-20 改名并扩权）在按 id 补多模态之外**同源按 id 补档位**。⚠️ **判据是 `entry.reasoningEfforts === undefined` 时才补，绝不能看目录的 `support_thinking`** —— 目录恒 `false`，照多模态那种「目录已表态就不覆盖」的写法写就**永远补不上**（多模态判据确实是 `supportsImages === undefined`，两者**刻意不同**）；上游将来真发 `support_thinking:true` + 非空 `options` 时，解析器会把档位读进条目，该判据自动让位给目录值。补齐的 **8 项**：`Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo` / `glm-5.3` / `glm-5.2` / `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` / `kimi-k3`(def **extra_high**) / `qwen3.8-max`；动态目录独有的 `kimi-k2.7-code` / `kimi-k2.6` **不在静态表** → 不补（保持不声明）。⚠️ 顺带修正：静态表 `minimax-m3` 的多模态由 `true` 改 `false`（SOLO 目录实测 `display_config.multimodal:false`，remote/lite 分别是 false/true、remote 优先取 false），使两条路径同口径 —— 现存 11 项里多模态项由 7 项变 **6 项**（其余 10 项静态值与目录实测逐项一致，只改这一项）。

⚠️ **「客户端模型池（IDE 代际）」≠「SOLO 网关配置表」**（理解「少模型」报障的关键区分）：客户端能显示的模型受**本地 vscdb 缓存**影响（旧 `chat_v3` 16 项，独有 `Doubao-Seed-Code` / `glm-5.3-flash` / `deepseek-v4.1-flash` / `kimi-k2.8-preview` / `qwen3.8-flash`），而**请求只认 SOLO 表**（网关按 `config_name` 在它自己那张表里找配置，找不到即 `4001`，与客户端 UI 显示什么无关）。**SOLO 表才是本 provider 的权威可用集**，故 5 项剔除已二次确认**非误伤**；反向也成立 —— `kimi-k2.7-code` / `kimi-k2.6` 只在 SOLO 表、不在旧客户端池，是**正常可调项必须保留**。

Account Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**由 Buddy CN、LobsterAI 与 Trae CN 三个面板提供** —— Buddy（国际版）后端没有签到接口，Codearts 是华为云账号体系不参与，Trae CN Work **与 Trae CN 是同一批账号**故签到只在后者提供；Qoder 与 Qoder CN **都不提供**（国际版无此活动、CN **疑似有但端点未知**，见能力矩阵表）。Trae CN 的签到与余额**前后端及宿主接线均已就绪**（`src/trae-cn-credits.ts` + 客户端能力矩阵 + `jet-hub-rpc.ts` 三处分支与 `traeCn` 实例传参）。T5 / T7 已真机校准；**T9 已于 2026-09-20 第三次修正**（原「不校验设备号形态」的推论被单变量 A/B 推翻，真根因是设备身份）。见「积分能力必须在请求前判定」与 README 的「Trae CN provider」章节。**八个 provider 都有 Account Hub 面板**（Trae CN Work 那条见下节，Qoder 与 Qoder CN 那两条见 README 的「Qoder provider」）。

### Qoder CN（`qoder-cn`）—— 第二 region 的两条要点

`qoder-cn`（显示名 **Qoder CN**）与 `qoder`（国际版）**同协议双 region**：exchange / quota / models 三个端点的错误信封逐字节同构、PAT 前缀同为 `pt-`、目录字段同构，故**代码只有一份**（`src/qoder*.ts` 按传入的 `product` 现算），差异全部收敛在 `src/qoder-product.ts` 的两份 `QoderProduct` 配置里。

⚠️ **两区是两套账号、两套 Credits、两套令牌 —— 与 `trae-cn` / `trae-cn-work` 那对方向相反**：

| 维度 | `qoder` / `qoder-cn`（两个 region） | `trae-cn` / `trae-cn-work`（两条路径） |
|---|---|---|
| 账号 | **各自独立**（凭据 ref 前缀 `QODER_ACCOUNT_*` vs `QODER_CN_ACCOUNT_*`） | **同一批**（都是 `TRAE_CN_ACCOUNT_*`） |
| 令牌 | **互不承认**（拿错 host 打 = 「凭据失效」的假象） | 同一份凭据 |
| `poolProviderFor()` | **恒等**（`qoder-cn` → `qoder-cn`） | **必须映射**（`trae-cn-work` → `trae-cn`） |
| 积分 | 各查各的额度端点（**没有**选池映射） | 同一端点、按面板选池（`traeCnPoolFor()`） |

⚠️ **照抄 Work 的写法把 `qoder-cn` 映射到 `qoder` 是静默故障**：CN 面板会列出国际版账号、用 CN 凭据打国际版 host —— 端点仍回 `ok: true`，只是账号对不上 / 报「凭据失效」。`tests/unit/qoder-hub-panel.spec.ts` 与 `qoder-cn-rpc-dispatch.spec.ts` 从两个方向钉死。

**CN 三个基址**：`openapi.qoder.com.cn`（✅ 实测 200）、`api.qoder.com.cn`（✅ 实测 200）、**`gateway.qoder.com.cn`（chat，🔴 源码定案、探测时整机 503）**。第三条取自官方 CN CLI 的选区常量，**阿里云侧未就绪**；实现照常按此值构造、错误直报，恢复后无需改代码。**逃生阀** `QODER_MODEL_SERVER_HOST` 可覆盖 chat 的 host（⚠️ **只影响 chat**，exchange / 目录两条控制面不受影响；路径与查询串一律丢弃；显式 scheme 优先；**请求时读取**，进程起来后再设也生效），作用于两个 region。⚠️ **绝不因为「测不通」就把它改成国际版 host** —— 那会把「上游暂时不可用」伪装成「凭据失效」。

**CN 的两项出站身份标识**（⚠️ **均源码值、未实测**）：`client_type: "5"`（国际版是 `qodercli`，取自 CN CLI 的 `kg()` 默认值）与 **Cosy 头**（`Cosy-ClientType` / `Cosy-Version`，**仅 CN 发**）。⚠️ `Cosy-MachineOS` / `Cosy-MachineHostname` **刻意不实现**（官方条件性发送，本插件**不猜机器身份** —— 缺头比错头安全）。

### Trae CN Work（`trae-cn-work`）—— 第二条 Trae CN 路径

`trae-cn-work`（显示名 **Trae CN Work**）走 **TraeWork（`work.trae.cn`）网页 RPC**，消耗 **Work 专属积分池**（`available_endpoint=1`）。它与 `trae-cn`（IDE 路径）是**两个 provider**，因为：

- **扣的池不同**：IDE 路径只扣通用池，本 provider 只扣 Work 池。通用池耗尽而 Work 池有额度时，两条路径的可用性**互相独立**；
- **模型池完全不重合**：IDE 是动态 `get_detail_param` 目录（回退 11 项 `chat_v3` 静态表），Work 是 **14 项 `solo_agent_remote` 代际**（只有 `Doubao-Seed-Code` 同名且窗口不同 —— 该 id 已从 IDE 侧静态表剔除，只在 Work 侧保留），合并目录会产生无法路由的条目。

⚠️ **唯一的非常规接线（改错会静默失效，两个方向都不报错）**：

| 用途 | 取值 |
|---|---|
| 注册到 `ctx.llm` 的路由名 / settingsNs / 模型黑名单 | `trae-cn-work` |
| **账号池查询**（`getAvailableAccount` / `findAccountIdByCredential` / `updateModelRateLimit`） | **`trae-cn`** |

Work **没有独立登录**：账号、凭据（`TRAE_CN_ACCOUNT_*`）、限流切换全部复用 `trae-cn`，故**不注册独立 auth 服务**。池查询若传 `trae-cn-work`，账号条目的 `provider` 字段（`trae-cn`）一个都匹配不到 → 适配器每次都抛 `MISSING_CREDENTIAL`（「请先登录」）而账号明明在列表里；路由名若传 `trae-cn`，本 provider 根本不会出现在模型选择器里。该值由 `TraeCnWorkProduct.poolProviderId` 显式承载（与 `id` 并列命名，防「顺手统一」）。

**协议要点**（全部真机实测；目录与思考档于 2026-09-19 重新取证，详见 README 的「Trae CN Work provider」）：

- **三段式有状态会话**：`POST chat_sessions` → `POST …/messages` → `GET …/events`（SSE），**每轮 `finally` 里 DELETE**（会话会拉起云端沙箱并出现在用户 TraeWork 列表里）。删除覆盖**整次尝试**而不只是成功路径 —— 建会话成功而发消息/订阅失败时同样要删，否则会话全部泄漏；
- **`query` 是 JSON 字符串**，元素形态 `{type:"text",data:{content}}`（是 **`data.content`**，不是 IDE 的 `text_content`）；`agent_type` / `agent_id` / `model_selection_strategy` / `origin` 是出站身份标识，一字符不能动；
- **`plan_item` 是累计快照不是增量**（`thought` / `reasoning_content` 每帧都是「到目前为止的全文」）。直接当增量拼接会让文本重复，必须按 `plan_item.id` 差分只发后缀；
- **正文有两条通道**，两条都要认：`plan_item.thought`（流式）与 `plan_item.tool_call_info.params.summary`（`name === "finish"`，真机第 2 轮 `thought` 全程为空）。合流时去重，否则同一段文字发两次；
- **`model_config` 的 `model_name` 带 `__dev` 后缀**（请求发的是无后缀的），比对静态表前必须归一；
- **模型目录远端可用**（`GET /api/remote/v1/models`，与 IDE 路径相反）：响应是 `{data:{list:[{function,models:[…]}]}}` **按 agent 分组**的结构，倍率在 `features` 这个 **JSON 字符串**里二次解析；
- ⚠️ **目录必须带 `?functions=solo_agent_remote&show_custom_model=true`（`TRAE_CN_WORK_MODELS_QUERY`），且解析只取本 agent 那组**：`function` 分组**由 query 决定**，裸打端点回的是 **`solo_coder` 组（另一个池）**。这是「选择器模型比网页版少」的已修复根因 —— 两个池只有 `Doubao-Seed-Code` 一个同名 id，拿错组会同时「少列本池 13 项」+「列出 11 项路由不到的条目」。多组且无本组时返回空目录（回退静态表），**刻意不拼接**三组（网页版一次要三组是因为它有三种会话形态，本适配器只发一种）；
- **错误分类以 HTTP 状态码为主**：Work 码表**未标定**（真机两轮全绿、一帧错误未遇），未知业务码**一律直报并带原文**，不猜动作；`fail` 不映射 `CONTEXT_WINDOW_EXCEEDED`（会误触发 DSH 的上下文压缩，真实改写用户会话）；
- **思考档已接线**：`solo_agent_remote` 组 **9/14 项**声明 `reasoning`（档位逐字符照抄真机 `light`/`high`/`extra_high`，默认档取 `default_level`；`glm-5.2` 只有 `high`/`extra_high`），其余 5 项不声明。⚠️ **下发落点是 `custom_model` 对象内部的 `reasoning_effort_level`，与 IDE 路径（顶层字段）不同** —— 字段名同名、落点不同，**不要「统一」掉**（真机 A/B：不带 131 reasoning tokens、`light` 档 13/17、错名字段 28）。未指定档位时**整个 `custom_model` 都不发**；
- **2 项账号私有自定义模型只在远端出现**（`deepseek-chat` / `deepseek-reasoner`，`config_source:3`，三方 key 存服务端），**不进静态表**（静态表要能被所有账号共用）。真机实测其三方 key 已失效（SSE `code:4028`）。

**Account Hub 有本 provider 的面板**（`PROVIDERS` 第六条，排在 `trae-cn` 之后；能力矩阵登记 `balance: true, dailyCheckin: false`）。它与 Trae CN 面板是**同一批账号的两个视图**：

| 项 | Trae CN Work 面板 |
|---|---|
| 账号列表 | **与 Trae CN 完全相同**（同批 `TRAE_CN_ACCOUNT_*`、同一套限流切换） |
| 积分行 / 「刷新积分」 | ✓ **只显示 Work 池**的单个数字与 Work 池资源包（同一端点、同一批账号） |
| 「一键领取积分」 | ✗ **刻意不渲染** —— 签到留在 Trae CN 面板 |
| 「+ 新建账号」 | ✗ **刻意不渲染** —— 改为一常驻提示行（`PROVIDERS` 条目的可选字段 `loginHint`） |
| 卡片操作（刷新 / 删除 / 启停 / 重测 / 重置） | ✓ 照常（按 accountId / credentialRef 操作，与面板 id 无关） |
| 「显示列表」 | ✓ 作用于 **`trae-cn-work` 键**（两池模型不重合，黑名单必须分开） |

**面板 id → 账号池键的映射收敛在 `src/jet-hub-rpc.ts` 的 `poolProviderFor()` 一处**（客户端不做映射，发的就是面板 id）。它取代了积分三端点原先硬编码的 `req.provider === TRAE_CN.id`，取值引用 `TraeCnWorkProduct.poolProviderId` 而**不是**再抄一份 `'trae-cn'` 字面量。应用点六处：`account.list` / `account.retestAll` / `account.resetAll` / `credits.status` / `credits.claimAll` / `credits.balances`。

⚠️ **`credits.balances` 上还挂着第二个、方向相反的映射 `traeCnPoolFor()`**（同文件）：它按**面板 id** 决定**显示哪个积分池**（`trae-cn` → 通用池 0、`trae-cn-work` → Work 池 1），是 `fetchTraeCnCreditBalance` 的第三个实参。两个映射答的是**两个不同的问题**，不可互相顶替、更不可合并：

| 问题 | 函数 | `trae-cn` | `trae-cn-work` |
|---|---|---|---|
| 查谁的账号 / 打哪个端点 | `poolProviderFor()` | `trae-cn` | `trae-cn`（映射过去） |
| **显示哪个积分池** | `traeCnPoolFor()` | 通用池（0） | Work 池（1） |

用池键（映射后的 `provider`）选池 → 两个面板都显示通用池，Work 面板的数字永远不是它能花的钱；用面板 id 查账号 → 面板空白。**两个方向都不报错**。

⚠️ **刻意不映射的两个入口**，改错都是静默的：

- **`account.create`**：映射会让面板多出的二次点击给同一份凭据建出**第二个** `trae-cn-<shortId>` 占位账号。该入口对 `trae-cn-work` 保持 `unknown provider` 拒绝。
- **`model.list` / `model.setDisabled`**：黑名单按 provider id 存，映射过去会把 Work 的开关写进 IDE 路径的黑名单（`TraeCnWorkAdapter.listModels` 读的正是 `trae-cn-work` 键）。

`tests/unit/trae-cn-work-hub-panel.spec.ts` 用真实 RPC 分派锁死上述全部语义；`credits-capabilities.spec.ts` 的「集合相等」断言已从五条同步到六条，并新增「`loginHint` 只允许出现在 Work 条目上」。

- **包名**：`dsh-account-hub`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` 编译宿主侧 + `esbuild` 打包客户端）
- **语言**：TypeScript
- **许可**：MIT

## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证
  git 安装时两侧产物齐全。`build:client` 末尾含产物顶层求值冒烟（stub require），
  模板字符串求值类错误构建即炸 —— `plugin-src/` 不在 typecheck/test 视野内，
  这道闸是客户端 bundle 的唯一语义防线，勿删。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy-cn`、`test:e2e:buddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致

## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Account Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |

## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyCnAuth`、`buddyAuth`、`lobsteraiAuth`、`traeCnAuth`、`qoderAuth`、`qoderCnAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程（**`qoderAuth` / `qoderCnAuth` 例外**：Qoder 两个 region 都没有浏览器登录，`login({ pat })` 只是 `loginWithPat` 的别名，缺 `pat` 时如实抛「请粘贴 PAT」而不是开一个不存在的流程）
- `status()` — 查询凭据状态（configured、source、expiresAt、refreshable）
- `refresh()` — 手动静默续期凭据
- `logout()` — 清除凭据并停止续期定时器

另有按凭据 ref 续期**指定账号**的 `refreshAccountCredential(refName)` —— 供 Account Hub 账号卡片的「刷新」按钮使用。**不要**用 `refresh()` 去刷账号池里的账号：它读写的是该 provider 的**默认单凭据 ref**（如 Buddy 的 `BUDDY_ACCESS_TOKEN`），而账号卡片对应的是 `BUDDY_ACCOUNT_XXX`，会刷到另一个凭据上。

服务名默认由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyCnAuth`（Buddy CN）与 `buddyAuth`（Buddy），`LobsteraiAuth` 注册为 `lobsteraiAuth`，互不覆盖。**两个 buddy 系产品都显式声明 `serviceName`**（`BuddyProduct` 的必填字段）：`buddy-cn` 机械派生会得到非标识符风格的 `buddy-cnAuth`，与 `trae-cn` 是同一先例 —— 该 provider 的服务名由产品配置显式给出 `traeCnAuth`（见「LLM Provider 约定」）。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。

### 登录必须两段式：RPC 立即返回 loginUrl（2026-09 更新）

`account.create` **不得**在 RPC 里等待用户完成浏览器登录。原实现（`buddy` 系已改，`lobsterai` 本次跟上）在 RPC 内 `await login(...)`，浏览器登录最长 10 分钟，等它返回时**用户手势早已过期**——客户端拿到 URL 再开窗会被弹窗拦截，客户端兜底逻辑于是自行开窗，把 DSH 页面顶掉。

正确形态（`src/jet-hub-rpc.ts` 的 `account.create`，两个 provider 一致）：

1. **第一段（同步返回）**：先拿到 `loginUrl`（buddy 系 `fetchAuthState`、lobsterai 的 `prepareLogin`），`pool.addAccount` 写入**占位条目**（`refreshable: false`、无 `expiresAt`），然后立即 `return { ok: true, value: { accountId, loginUrl } }`；
2. **宿主 opener 置空**（`openBrowser: () => {}`）——打开动作归客户端，宿主再开一次会变成两个标签页；
3. **第二段（后台）**：后台 Promise 完成登录后写凭据、`pool.updateAccount` 补全 `nickname`/`expiresAt`/`refreshable`；失败则 `pool.removeAccount` 移除占位，避免留下无凭据的幽灵账号。

配套约束：

- `login.poll` **按 credentialRef 判断「凭据是否可解析」**，与 provider 无关 —— 占位条目 + 后台写凭据即可让客户端轮询生效，不需要为新 provider 改轮询逻辑；
- **占位账号字段是 pending 形态**：`expiresAt` / `refreshable` / `nickname` 都依赖 exchange 结果，凭据落盘后由第二段补全；时序上必须**先写凭据、再补全账号**（反过来会让轮询在凭据就绪前报成功）；
- **LobsterAI 登录是 provider 级互斥的**（`src/lobsterai-oauth.ts` 的 `prepareLobsteraiLogin`）：已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`，不新建监听也不复用旧会话。理由：复用会让一份凭据被多个占位 accountId 共享，账号池出现重复候选；静默新建则每次点击堆积一个 loopback 端口直到 10 分钟超时。`account.delete` 会 cancel 对应会话以释放端口（`jet-hub-rpc.ts` 的待登录登记表）。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy-cn'` 会让 Buddy 永远匹配不到账号 —— 旧命名下两者恰好对调，这个坑更隐蔽）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`
- **凭据必须在发请求前按目标模型挑选**：`resolveCredential` / `refresh` 都接受可选的 `model` 参数，适配器的 `stream()` 必须把 `options.model` 传下去（`src/index.ts` 的 `makeCredentialResolver` / `makeAccountPicker` 是**各 provider 共用的唯一接线** —— 这两个函数按 provider 实参现算取号，新增 provider 一律走它们，不要再写一份）。`getAvailableAccount` 的限流过滤是**逐模型**的，传空串时按设计不过滤 —— 传空串会让每次请求都先白跑一遍已限额/积分耗尽的账号。**仅 `fetchModels` 拉模型目录**（目录对所有模型一致）与「全部账号都在冷却期」的退化路径用空串，两者都刻意保留，不要改成「一并过滤」

## 模型黑名单（Account Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ 'buddy-cn': { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- 改名迁移会搬运 `disabledModels` 的 provider 键（`buddy`→`buddy-cn`、`workbuddy`→`buddy`），属**对调式搬运**，有测试钉死，详见 `src/provider-rename-migration.ts`
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络
- E2E 测试按 provider 分为独立脚本（`pnpm test:e2e:*`），**均带闸门且默认跳过**；哪些会消耗模型积分见 `tests/e2e/README.md`
- 测试文件按约定放在 `tests/unit/` 与 `tests/e2e/` 目录

## LLM Provider 约定

- **provider 名称**：`codearts` / `buddy-cn` / `buddy` / `lobsterai` / `trae-cn` / `trae-cn-work` / `qoder` / `qoder-cn`
- **provider id 与 cordis 服务名是两件事**，不要机械派生。默认规则是
  `${product.id}Auth`，但**带连字符的 id 都要显式声明 `serviceName`**：
  `trae-cn` → `traeCnAuth`，`buddy-cn` → `buddyCnAuth`（`BuddyProduct` 已有
  必填字段 `serviceName`）。`trae-cn` 的 id 是对齐用户与生态叫法的刻意选择；
  `buddy-cn` 同理，且它的机械派生会得到非标识符风格的 `buddy-cnAuth`。
  新增 provider 时：id 可以带连字符，服务名必须是合法的 JS 标识符风格。
  ⚠️ **`qoder` 是反面判据**：它**无连字符**，机械派生的 `qoderAuth` 本身就是合法
  的标识符风格，故 `QoderProduct` **刻意不声明 `serviceName`** —— 那条「都要显式
  声明」只适用于**机械派生结果不合法**的 id，不是「所有 provider 都得声明」。
  ⚠️ **`qoder-cn` 又是正面判据**：同一个 `QoderProduct` 类型、同一份实现，只因
  id **带连字符**（机械派生得到非标识符风格的 `qoder-cnAuth`）就**必须**显式声明
  `serviceName: 'qoderCnAuth'` —— 两个 region 恰好落在判据的两侧，**不要**
  为了「形态统一」把两行写成一样。`src/plugin.spec.ts` 已钉死
  `ctx['qoder-cnAuth']` 为 `undefined`、`ctx.qoderCnAuth` 才是那个实例。
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

**Buddy CN** —— `src/credits.ts`（Buddy 国际版后端无签到接口）：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`（「今天已签到」），判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖

**LobsterAI** —— `src/lobsterai-credits.ts`（三步，见 `lobsterai2api/sigin.py`）：

- 槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`
- 幂等是**客户端**保证的：请求带 `idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`
- `clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`
- `platform=win32` 等参数是**客户端形态伪装**，非 Windows 上也照发

**Trae CN** —— `src/trae-cn-credits.ts`（两步 + 设备头）：

- 状态 `POST /trae/api/v2/ug/checkin_credits/status` → 未领则 `POST /trae/api/v2/ug/checkin_credits/claim`，两者 body 均为 `{"req_source":1}`
- **幂等判据用 `checked_in`（账号级当日）**；`did_checked_in` 是**设备级**语义（换设备仍 false），**不要用**
- **claim 必须带设备头**：`x-device-id`（**取自凭据的 `checkin_device_id`**，即**登录时生成并上报的 16 位号**）+ `x-device-type: windows` + `x-os-version` + `x-app-version: 3.3.102`；缺了回 `code:9004`。⚠️ **T9 第三次修正（2026-09-20）**：T9 原结论「status / claim **都不校验设备号形态**」**观测成立但推论错了** —— 不校验**形态** ≠ 不校验**设备**；服务端按 `x-device-id` 做**设备维度**记账，**只认登录时注册的那台设备**。**仍然成立**的一条：不要拿 `machine_id` 折算一个假的 16 位号顶上；`9004` 只可能意味着「服务端不认可我们构造的设备身份」
- ⚠️ **`x-os-version` 是运行时取值，不是常量**（2026-09-19 身份保真修复）：真机客户端发 `os.version()` 的返回值（本机 `Windows 10 Home`，**市场营销名**），本插件改为运行时 `node:os` 的 `os.version()`（`traeCnOsVersion()`），不再硬编码 `Windows 10.0.22631`（构建号）。`x-app-version` 同步 `3.3.100` → `3.3.102`。**这不是 `9074` 的解药** —— 定案的根因是**设备身份**，不是版本号形态
- ⚠️ **`9074` 定性第三次修正（2026-09-20，前两次均作废）**：① 「瞬时频次软限流」作废（三日 452 次报错、**8 秒退避重放仍 9074**）；② 「活动级当日容量/名额限制或账号侧风控」**也作废**（官方客户端同期签成功）。**现行定性：设备身份** —— 服务端按 `x-device-id` 记设备维度签到状态，我们发的 `BoundDeviceID` **不被活动系统认可**。决定性单变量证据（status 端点 A/B）：全套头不变、**仅**把 `x-device-id` 换成官方 16 位号 → `did_checked_in` 由 `false` 翻转为 `true`；其余头差异（多发的 `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token`）已证明**不影响**结果。**修复**：登录时那个 16 位号落盘进凭据新字段 `checkin_device_id`，签到头改用它（`traeCnCheckinDeviceId`）；**旧凭据**该号随机生成、服务端不回传，**无法恢复**，需**重新登录**（降级路径发 `BoundDeviceID`，**不伪造**）。⚠️ **待验证假设**：claim 级验证需等**次日名额重置**；若仍 9074，后续路径是「读 Trae 客户端 AHA 设备号」（跨产品耦合，**需用户拍板**）
- **claim 段有界重试（2026-09-20）**：`TRAE_CN_CLAIM_RETRY_CODES = [9074, 4007, 3004]`（**同时**要求命中共享的 `TRAE_CN_BACKOFF_CODES`，见 `isTraeCnClaimRetryable`），按 `TRAE_CN_CLAIM_RETRY_DELAYS_MS = [1000, 3000]` 退避 **2 次**（累计 4s），耗尽后按**最后一次**的 code/message/logid 返回。**status（读）段一次都不重试**；**`9004` / `1001` 绝不重试**（确定性失败）。`3003` 虽在共享退避表里但属 **chat 通道**的基础设施码，**刻意不在**签到清单内。`9074` **不记冷却徽章**（`recordsTraeCnCooldown(9074) === false`：设备身份与模型无关、等多久都不会自愈，记徽章是虚假信息）。⚠️ 第三次定性**不推翻**这段重试（成本只有 4 秒）
- **「设备号」在本项目里是两个位置，不要混**：**登录 URL 的 `device_id`**（`generateTraeCnDeviceId`）**必须 16 位纯十进制**，**且它就是设备身份**（落盘为 `checkin_device_id`，签到头用它）；**凭据的 `device_id`** 是 exchange 返回的 `BoundDeviceID`（服务端绑定标识，**活动系统不认**）。早先把它说成「只参与登录握手、与签到头无关」是**错的**，也正是 9074 的根因
- **签到侧与 chat 侧的头集已分开**（2026-09-20，防「顺手统一」）：`traeCnCreditsHeaders` **自建** 6 个头（`Content-Type` + `Authorization: Cloud-IDE-JWT` + 设备四头），**删掉了官方不发的 `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token`**；`x-device-brand` **刻意不发**（官方条件性发 `device_model`，本插件不猜硬件型号，也不发空串冒充）。而 `traeCnAccessHeaders` 仍带 `Accept` 与两个等值 token 头，**chat（SOLO，`traeCnSoloHeaders`）继续用它、一行未动** —— 两者不可合并
- **失败时透传服务端 logid**：claim / status 失败若响应头带 `x-tt-logid`，透传到 `outcome.logid`（`src/credits.ts` 的 `ClaimOutcome` 失败分支，**可选**字段），前端失败行追加 ` · logid <值>`。Buddy 系与 LobsterAI **未透传**（无已知等价响应头，不发明字段名）
- `Origin` / `Referer` **签到侧已删除**（2026-09-20 对齐官方 claim 头集；官方 `bb()` / `mixAuthorization` / `fb()` 三处拼出的头里都没有它们）。原实现按「编译期常量 `product.portalBase`，不从凭据推断」构造 —— 那条**约定本身仍成立**（凡发 portal 归属头都取编译期常量），只是签到头里已不再发这两个头
- 无 auth 时是 **HTTP 200 + `code:1001` + `enable:false`**（不是 401）—— 判定**以 body `code` 为准**；`1001` 统一译为「凭据已失效，请重新登录」

三套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 三套协议共用
- **领取流程自带多步预检的 provider 传 `precheckStatus: false`**（LobsterAI 与 Trae CN）：它们的 `claim` 内部已经查过状态，外部再查一次纯属重复请求

**积分余额（Credits Balance）** 覆盖六个 provider、四套端点，语义一致（「查不到」与「余额为 0」严格区分），与签到是彼此独立的能力 —— 不要因为「国际版没有签到」就推断也查不到余额（Buddy 系两个产品通用同一端点）：

- **Buddy 系（buddy-cn / buddy 通用，仅 baseURL 随 `product.endpoint` 切换）**：端点 `POST /v2/billing/meter/get-user-resource`，body `{}`
  - 响应**双层嵌套**：`data.Response.Data.Accounts[]`（签到是单层 `data`，此处最易解析错）
  - 余额取各包的 **`CycleCapacityRemain`（本周期口径）** 相加，**不是** `CapacityRemainPrecise` / `CapacityRemain`（终身口径）—— 现行实现在 `src/credits.ts` 的 `parseCreditPackage()`；精确值经 `readPreciseNumber()` 优先读带 `Precise` 后缀的字符串版
  - **不用**截断过的 `TotalDosage`
  - 包名回退链：`PackageName` → `SubProductName` → `PackageCode`
- **LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`；**不要**用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分，实测某账号 profile-summary 有 5297.72 而 quota 只有 300）
- **Trae CN**：`POST /trae/api/v2/pay/web_user_ent_usage`，body `{"require_usage":true}`
  - 礼包按 **`available_endpoint` 分池**：`0`=通用积分、`1`=Work 积分
  - **展示口径 = 按 provider 分池，一个面板一个池**：宿主按**面板 id** 选池（`src/jet-hub-rpc.ts` 的 `traeCnPoolFor()`），`fetchTraeCnCreditBalance(credential, product, pool)` 的第三个实参就是它，返回的 `total` / `packages` / `expiredTotal` **只含那一个池**（另一个池的礼包被过滤掉）。**Trae CN 面板 → 通用池（0）**、**Trae CN Work 面板 → Work 池（1）**，两边都是**单数字**，界面上不出现「通用」「Work」字样。语义锚点：**面板显示的数字 = 该 provider 实际能花的池**。⚠️ **选池必须用 `req.provider` 而不是 `poolProviderFor()` 映射后的账号池键** —— 后者把两个面板都映射到 `trae-cn`，拿它选池会让两个面板显示同一个池（不报错，但 Work 面板的数字不是它能花的钱）；两个映射方向相反、缺一不可，见上文「Trae CN Work」一节的对照表
  - **Work 积分的准确口径**：Work 专属积分**只在 TraeWork（`work.trae.cn` 网页版 / 桌面版）能花**；TraeCode / IDE 对话（即本插件走的路径）**只消耗通用积分**；在 TraeWork 中两类积分按**到期时间先后**扣，Work 专属**仅在到期时间相同时**优先；**2026-09 起签到发的是通用积分**
  - `TraeCnCreditBalance` 与共用的 `CreditBalance` **逐字段同构**（`type TraeCnCreditBalance = CreditBalance`），故收集器与卡片直接复用、无需任何 provider 分支。⚠️ **曾经的超集字段 `pools` / `workTotal` 与 `[Work 积分]` 包名前缀已随分池一并删除**（`traeCnPoolName()` 也删了 —— 分池后池名没有任何消费者）；前端那套「通用 X / Work Y」两段渲染同步删除，`CreditBalanceRow` 不做任何池判断，由 `tests/unit/jet-hub-credit-balance-row.spec.ts` 的整树深比较守住（含「喂进旧的双池字段也不多渲染一段」）。改前端后须 `pnpm build:all` 重建 bundle
  - **不要**用 `ug/activity/info` 的活动口径（写 200 work 实到 150 通用，口径陷阱）
  - 包名回退链：`name` → `package_name` → `gift_name` → …（`BALANCE_NAME_FIELDS`）；包名**原样透出**（分池后同一个列表里只有本池的包，曾经的 `[Work 积分]` 前缀已删除）
  - ✅ **T7 已按真机校准（2026-09-18）**：该端点响应**没有 `code` 信封**（顶层是 `is_credits_billing` / `usage_summary` / `user_entitlement_pack_list`），沿用 code 信封会让余额**恒失败**；礼包数组在**根层** `user_entitlement_pack_list`，额度嵌在 `entitlement_base_info.product_extra.package_extra.quota.credits_limit`（回退 `entitlement_base_info.quota`）减 `usage.credits_amount`（可为 `{}`，按 0 计），`available_endpoint` 也在 `entitlement_base_info` 里。候选表 + 指纹扫描 + 三级回退**全部保留作兜底**，但主路径是嵌套口径
  - ⚠️ **T8 仍待校准**：领取响应里「本次获得积分」的字段名（`TRAE_CN_CLAIM_CREDIT_FIELDS`），未命中时按 0 计并输出只含键名的调试行
- 累加后一律 `roundCredits` 规整两位小数（多包浮点噪声会放大成 655.67000031）
- 「余额为 0」与「查不到」严格区分：失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0
- RPC：`credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮
- **CodeArts 不支持**（华为云账号体系，无腾讯计费接口）：`productById('codearts')` 为 `undefined`，三个积分端点都会回 `bad-request: unsupported provider: codearts`
- Buddy 系该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），静态搜索找不到，靠真实凭据实测发现


## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断：

| provider | `balance` | `dailyCheckin` |
|---|---|---|
| `codearts` | ✗ | ✗ |
| `buddy-cn` | ✓ | ✓ |
| `buddy` | ✓ | ✗（国际版后端无签到接口） |
| `lobsterai` | ✓ | ✓（`client-activities` 三步流程） |
| `trae-cn` | ✓ 通用池（IDE 路径能花的，见下） | ✓（`checkin_credits` 两步 + 设备头） |
| `trae-cn-work` | ✓ Work 池（TraeWork 能花的；同一批账号、同一个查询实现，只是**显示另一个池**） | ✗（签到留在 Trae CN 面板，避免同账号重复领取） |
| `qoder` | ✓ 三池之和（`userQuota` / `addOnQuota` / `orgResourcePackage`，后两池容缺） | ✗（**有这项权益但没有公开接口**：官方每日 100 Credits 只能在 Qoder 桌面 App 手动领 —— 与 `buddy` 的「后端压根没有该接口」不是同一种情况） |
| `qoder-cn` | ✓ 同一份实现、CN 的端点（CN 实测**两池**：`userQuota` + `addOnQuota`；解析器三池容缺，天然兼容） | ✗ ⚠️ **疑似有签到，但端点未知**（CLI2API 的 `RegionDescriptor` 只在 cn 挂 Checkin；未验收）——`false` 的理由是「**端点未知、未验证**」，**不是**「没有权益」，将来拿到端点后翻 `true` |

> ⚠️ **Qoder 两个 region 的 `dailyCheckin` 都是 `false`，但理由互不相同、不可合并叙述**：
> `qoder` 是**活动不存在**（国际版实测不显示签到），`qoder-cn` 是**端点未知**（待办）。
> 合并成一句「Qoder 没有签到」会把后者的待办性质抹掉，而两者将来会分叉（CN 可能翻 true）。
> `tests/unit/credits-capabilities.spec.ts` 有断言同时钉死取值与这两段注释的存在。

> ⚠️ **改名的语义翻转点就在这里**：矩阵里 `buddy` 这个键**换了主人** ——
> 旧 `buddy`（中国版，✓✓）让位给 `buddy-cn`，旧 `workbuddy`（国际版，✓✗）
> 改名成 `buddy`。迁移由 `src/provider-rename-migration.ts` 搬运，测试
> （`tests/unit/credits-capabilities.spec.ts`）已把「旧 `workbuddy` 必须彻底消失」
> 与「`[a-z-]+` 匹配器」两件事钉死。

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **`trae-cn` 已登记**：全部就绪（`src/trae-cn-credits.ts` + `jet-hub-rpc.ts` 分发与三处宿主分支 + 客户端能力矩阵与 `PROVIDERS` 条目），面板显示积分行与两个积分按钮，可新建账号（`47f253f` 补齐接线）
- **`trae-cn` 与 `trae-cn-work` 的 `balance` 各显示自己那个池**：宿主按面板 id 选池（`traeCnPoolFor()`），Trae CN 面板显示通用池（IDE 对话实际扣的）、Trae CN Work 面板显示 Work 池（TraeWork 能花的）。两边都是**单数字**，`CreditBalanceRow` 不做任何池判断（输入与其余 provider 逐字段同构），**没有「合并两池」这个概念了** —— 同一处不会再同时出现两个池的数字
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，CodeArts 面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等。**该断言的匹配器必须写成 `[a-z-]+` 而不是 `[a-z]+`** —— 后者会让带连字符的 id（`trae-cn`）在 `PROVIDERS` 里隐形，漏登记时断言反而是绿的

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期国际版那条路由名叫 `workbuddy` 时曾指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。
