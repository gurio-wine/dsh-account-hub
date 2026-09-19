# Qoder provider 接入调研（协议与可行性）

> 调研日期：**2026-09-20**（本机时区 +08:00）
> 性质：**只调研，不写代码**；**全程未对 Qoder 任何 API 端点发起请求**（含 chat / quota / 注册 / 登录）
> 一手信源：
> 1. **官方文档站** `docs.qoder.com`（国际）/ `docs.qoder.cn`（国内）—— 本机直取 **219 页**，落盘 `%TEMP%\qoder-docs\`
> 2. **QoderGateway**（bzym2，Python 逆向网关）—— clone 至 `%TEMP%\qoder-gateway-research`，源码全读
> 3. **cli2api**（caigee-cmd，Go 网关）—— 关键源码抓取至 `%TEMP%\qoder-cli2api`（**后文简称 CLI2API**）
> 4. Qoder 官方论坛（管理员原话）、GitHub API、LINUX DO 社区帖

---

## 0. 五条颠覆性结论（先读这个）

| # | 结论 | 证据 |
|---|---|---|
| **1** | **`lite` 模型档位已于 2026-09-18 14:00 (UTC+8) 退役**，headless/API 请求指定 Lite **直接失败** | `docs.qoder.com/release-notes/lite-model-tier-retirement-notice.md` |
| **2** | **QoderGateway 默认模型就是 `lite`**（`bridge.py:243`、`app.py:393`），**今天必然报错** | 源码 + 结论 1 |
| **3** | **官方 PAT 前缀是 `pt-`**，不是 `dt-`；`dt-` 是 device token（另一体系） | `docs.qoder.com/cloud-agents/api/authentication` L40：「PATs are prefixed with `pt-`」 |
| **4** | **CLI2API 证明了「接入 Qoder」有第二条、且更稳妥的架构路线：不自研 HTTP 逆向，而是把官方 `qodercli` 当子进程 worker 包装** | `cli2api/internal/providers/qoder/starter.go:126-184`（`QODERCLI_JS` + 每账号独立 `HOME`） |
| **5** | **但该路线的核心机制未公开**：CLI2API 并未自行发起 chat 请求，而是调用一个**私有 Node daemon 的隐藏本地端点** `/admin/chat`。**这个 daemon 不在仓库里** | `qoder/worker.go:169-185`（只看到 `endpoint.ChatCompletionsPath = "/v1/chat/completions"` 打向 worker URL） |

> 结论 1+2：**任何照抄 QoderGateway 的代码今天都不能跑**。
> 结论 4+5：**CLI2API 的架构对我们不可直接复制** —— 它依赖一个未开源的 daemon；我们若走 CLI 包装路线，必须自己做那层 daemon。

---

## A. 身份与登录面

### A1. 官方登录方式（一手，官方文档）

**Qoder 有官方 CLI，认证体系是官方且文档化的。**

- 交互式：终端 `qoder` → `/login`（别名 `/signin`），两种方式：
  1. `Login with Qoder Platform (Browser)` —— 开浏览器授权
  2. `Use Qoder Personal Access Token (QODER_PERSONAL_ACCESS_TOKEN)` —— 粘贴 PAT
- 无图形环境（CI / SSH / `BROWSER=www-browser` / Linux 无 `DISPLAY` 等）**CLI 自动跳过拉浏览器、直接打印登录 URL**
- 登录后 CLI **后台自动刷新令牌**；`/status` 查状态；`/logout` 登出（用环境变量认证时须先清变量）
- 证据：`docs.qoder.com/cli/authentication`（中英双版）

**PAT 官方签发入口**：

```
https://qoder.com/account/integrations     （国际版）
https://qoder.cn/account/integrations      （国内版）
```
登录 → `Account → Integrations` → 选有效期与权限 → 创建 → **立即复制（关闭后不再显示）**。官方建议本地脚本 / CI / 生产各建一个，便于单独轮换吊销。
证据：`cli/authentication`、`cli/sdk/authentication`

**PAT 前缀 = `pt-`**：
```bash
export QODER_PAT="pt-your-token-here"
```
证据：`docs.qoder.com/cloud-agents/api/authentication` L40

**官方 Agent SDK**（用户情报里没有）：

- TypeScript `@qoder-ai/qoder-agent-sdk`；Python `qoder-agent-sdk`（PyPI）
- 三种认证：**PAT**（代表 Qoder 用户）/ **Service Account**（代表组织工作负载）/ **本机 qodercli 登录态**（`qodercliAuth()`）
- 官方明示：**「SDK 不会自动刷新 PAT。PAT 失效后，应取得新 PAT 并创建新的 SDK 会话。」**（`sdk-auth.txt` L194、L542）

**Service Account 官方 token exchange**：
```
POST https://openapi.qoder.sh/api/v1/serviceToken/exchange
Authorization: Bearer <SA Key>
{"grant_type":"client_credentials","audience":"qoder","scope":"models.read chat.completions","ttl_seconds":3600}
→ {access_token: <SAT, JWT>, expires_in}
```
- `ttl_seconds` 上限 `43200`（12h）；SAT 过期**不能刷新**，要用 SA Key 重新换
- **scope 示例里出现 `models.read` / `chat.completions`** → 官方确有「聊天补全」能力域
- 证据：`sdk-auth.txt` L336-377；`en-cloud-agents-api-auth` L62-100

**官方 Cloud Agents API**（另一条正规 API 线）：
```bash
export QODER_OPENAPI_BASE_URL="https://openapi.qoder.sh"
export QODER_API_BASE_URL="https://api.qoder.com"
curl -s "$QODER_API_BASE_URL/api/v1/cloud/models" -H "Authorization: Bearer $QODER_ACCESS_TOKEN"
```
证据：`en-cloud-agents-api-auth` L23-24、L110-115

### A2. QoderGateway 的 SessionContext 是怎么建立的（老版 COSY 协议）

文件：`src/qoder2api/auth.py`

`create_session(personal_token)`（L179-193）三步：

1. **造机器身份** `new_machine()`（L53-58）：
   - `machine_id = str(uuid.uuid4())`
   - `machine_token = base64url((uuid4+uuid4)[:50])` 去尾 `=`
   - `machine_type = uuid4().hex[:18]`
   —— **全部本地随机生成，服务端不回传**（机器身份是客户端自造的）
2. **换 job token** `exchange_job_token()`（L146-176）：
   - `POST https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1`
   - body 双层：内层 `{personalToken, securityOauthToken:"", refreshToken:"", needRefresh:false, authInfo:{}}` → 塞进 `{"payload": <内层json字符串>, "encodeVersion":"1"}` → 整体 JSON → `encoding.encode()`（自定义 base64）
   - 头：`appcode: cosy`、`signature: sign(date)`、`cosy-version: 0.1.43`、`cosy-clienttype: 5`、`cosy-machineid/machinetoken/machinetype`、`login-version: v2`、`user-agent: Go-http-client/2.0`
   - 签名（`signature.py`）：`md5("cosy" + "&" + "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==" + "&" + <RFC1123 GMT date>)`
   - 编码（`encoding.py`）：base64 后**三段重排**（`[-split:] + [split:-split] + [:split]`）+ 自定义 64 字符表，pad `$`
3. **解析 identity**（L182-192）：

| 字段 | 来源 | 缺省 |
|---|---|---|
| `name` | `data["name"]` | `""` |
| `aid` / `uid` | `data["id"]` | `""` |
| `user_type` | `data["userType"]` | `"personal_standard"` |
| `security_oauth_token` | `data["securityOauthToken"]` | `""` |
| `refresh_token` | `data["refreshToken"]` | `""` |
| `yx_uid` / `organization_id` / `organization_name` | **硬编码空串** | `""` |

**「复用本机登录态」路径** `load_local_session()`（L196-232）：

- 读 `~/.qoder/.auth/id`（回退 `.auth/machine_id`）与 `~/.qoder/.auth/user`
- `.auth/user` 是 **AES-CBC 密文**：`key = machine_id[:16]`，**IV 也等于 key**，PKCS7，内容 base64
- 解密后是 identity JSON，字段名**两种风格都认**（`securityOauthToken` / `security_oauth_token`）
- 印证官方 CLI 把凭据弱加密存在 `~/.qoder/`（`QODER_CONFIG_DIR` 可改）

> ⚠️ **CLI2API 用的是同一套 `.auth/user` + `.auth/machine_id` 文件格式**（`qoder/home.go:28-51`），只是它由**官方 CLI 自己写**、CLI2API 只负责搬运。

老版额度接口 `fetch_user_status()`（L235-266）：`POST center.qoder.sh/algo/api/v3/user/status?Encode=1`，body `{userId, personalToken:"", ...}`，返回 `quota` / `isQuotaExceeded` / `plan` / `userTag` / `nextResetAt`。

### A3. refresh 流程的完整契约

文件：`src/qoder2api/tokens.py`

```
POST {OPENAPI}/api/v1/deviceToken/refresh     body {"refresh_token": "<drt-...>"}
POST {OPENAPI}/api/v1/jobToken/refresh        body {"refresh_token": "<jrt-...>"}
OPENAPI = https://openapi.qoder.sh
头：Content-Type: application/json / Accept: application/json / User-Agent: qoder/1.1.16
```
分发（L44-49）：`refresh_token` 以 `jrt-` 开头 → `jobToken/refresh`，否则 → `deviceToken/refresh`。
取值（L60-64）：`device_token` 优先、回退 `token`；同时读 `refresh_token`（**会回写 → 说明服务端轮换**）与 `expires_at`。

⚠️ **文档/代码冲突（去伪点）**：`docs/qoder-protocol-research.md` §8 写「用 `jobToken/refresh`」，但 `tokens.py` 对 `drt-` 打的是 `deviceToken/refresh`。**以代码为准**（该文档 §9 待办清单也已过时）。

⚠️ **轮换是否一次性 = 待真机校准（T11）**：回写新 rt 暗示轮换，但「旧 rt 是否立即失效」未验证。

后台线程每 **6 小时**全量刷新（`REFRESH_INTERVAL = 6*3600`，L20、L132-147）。

**deviceToken poll 响应结构**（`docs/qoder-protocol-research.md` §1）：
```json
{"id":"...","token":"dt-...","user_id":"...","code_challenge":"...","code_challenge_method":"S256",
 "nonce":"...","expires_at":"2026-09-05T11:16:15Z","refresh_token_id":"...",
 "refresh_token":"drt-...","created_at":"...","updated_at":"...",
 "expires_in":2591999994,"refresh_token_expires_in":31103999996,
 "refresh_token_expires_at":"2027-08-01T11:16:15Z"}
```
→ `dt-` 有效期 ≈30 天，`drt-` ≈360 天。

### A4. 我们插件的形态：有没有可用的 OAuth 授权页 URL？

**有 —— 是逆向出来的 PKCE device flow，CLI2API 也在用同样的东西。**

QoderGateway 完整实现（`registrar.py:224-253`）：
```python
verifier  = 随机 43~128 字符，字符集 ascii_letters + digits + "-._~"
challenge = base64url(sha256(verifier)).rstrip("=")
nonce     = uuid4()

# 授权页（浏览器打开）
https://qoder.com/device/selectAccounts
    ?challenge=<challenge>&challenge_method=S256
    &nonce=<nonce>&machine_id=<machineId>
    &client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb

# 轮询（1 秒一次）
GET https://openapi.qoder.sh/api/v1/deviceToken/poll
    ?nonce=<nonce>&verifier=<verifier>&challenge_method=S256
404 = 用户尚未授权（设计内等待，非错误）
200 = 授权完成，返回 A3 的凭据 JSON
```
- 备用 client_id：`e93fe488-5778-4c35-a6fc-0f54ed7b3139`
- 轮询上限 5 分钟（`vfI = 300000`）、间隔 1 秒（`cxn = 1000`）、网络错误重试 3 次（`HfI = 3`）
- 来源：反编译 `@qodercn-ai/qoderclicn@1.1.16`（`docs/qoder-protocol-research.md` §4、§6）

**CLI2API 侧佐证**：它把登录完全委托给官方 CLI（`/admin/login/device` 与 `/admin/login/pat`，`qoder/worker.go:211-224`），自己不实现 PKCE。**说明连专业网关也更信任官方 CLI 的登录路径。**

**两条现实路径**：

| | 路径 1：PAT 手动粘贴 | 路径 2：PKCE device flow |
|---|---|---|
| 官方支持 | ✅ 完全官方、有文档 | ❌ 逆向所得，未文档化 |
| 用户体验 | 手动生成再粘贴 | 点按钮 → 浏览器授权 → 自动完成 |
| 实现成本 | 极低 | 中（PKCE + 轮询 + 授权页交互） |
| 维护风险 | 低（PAT 是稳定公开契约） | 中高（`client_id` 是逆向常量） |
| 续期 | ❌ 官方明示不自动刷新 | ✅ `drt-` 可静默续期（≈360 天） |
| 合规观感 | 正当（官方就是给 CI/SDK 用的） | 灰色（模拟官方客户端登录） |

> **结论：阶段 1 用 PAT；device flow 留阶段 2，并接受「随时失效」。**

---

## B. chat 协议面

### B1. 新端点（现行唯一活路径）

```
POST https://api2-v2.qoder.sh/model/v1/chat/completions
```
来源：`bridge.py:19`、`docs/qoder-protocol-research.md` §2

**请求头**（`bridge.py:341-348`）：

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer <security_oauth_token>`（`dt-` device token） |
| `Content-Type` | `application/json` |
| `Accept` | `text/event-stream` |
| `User-Agent` | `qoder/1.1.16` |
| `X-Request-ID` | = body 的 `metadata.context.request_id` |
| `X-Session-ID` | = body 的 `metadata.context.session_id` |

**请求 body**（`build_qoder_body()`，`bridge.py:241-264`）：
```json
{
  "model": "<model>",
  "messages": [ ...原样透传... ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "metadata": { "context": {
      "request_id": "<uuid>", "request_set_id": "<uuid>",
      "session_id": "<uuid>", "task_id": "common", "client_type": "qodercli" } },
  "tools": [ ...有 tools 时原样透传... ]
}
```
- **`model` 取值 = 短 key**（参考项目用 `"lite"`；官方文档给 `auto`/`efficient`/`performance`/`ultimate` 与具体模型名）
- **`metadata.context.client_type: "qodercli"` 是出站身份标识** —— 与 buddy 的 `X-Product-Code` 同类，**不要改**
- body 是**标准 OpenAI 格式**，`messages` / `tools` **原样透传**

**响应 SSE**：标准 OpenAI `chat.completion.chunk`
- 解析在 `extract_delta()`（`bridge.py:278-307`）：先看顶层有没有 `choices`（新版），取 `choices[].delta.{role, content, tool_calls}`
- `stream_options.include_usage: true` → 流尾带 `raw_usage` 统计

**错误处理现状**（`qoder_stream_lines` L349-356）：**只对非 200 抛 `RuntimeError`**；**HTTP 200 + 流内 error 帧完全没处理**（`extract_delta` 遇到无 `choices`/`body` 的帧返回空 delta 被静默跳过）。

**认证失效重试**（§2）：401/403 时官方客户端会 `forceRefreshToken`（用 `drt-` 刷新）后重试一次。

### B2. CLI2API 的 chat 契约（旁证，且暴露了一个第三方端点）

⚠️ **必须先说清 CLI2API 的架构**：它**不直接打 `api2-v2`**。它启动一个**私有 Node daemon**（`config.DaemonPath`，环境变量注入 `QODERCLI_JS` 指向官方 CLI bundle），然后向 `http://127.0.0.1:<port>` 的 `endpoint.ChatCompletionsPath`（`/v1/chat/completions`）发请求：
- `worker.go:169-185` `NewChatRequest()`：`Content-Type: application/json` + `Authorization: Bearer <PROXY_API_KEY>` + `X-Qoder-Account: <accountID>` + `X-Request-Id`
- `starter.go:126-184`：每账号独立 `HOME`、`QODER_HOME` / `QODER_CONFIG_DIR`（或 `QODERCN_CONFIG_DIR`）、`QODER_SITE=global|cn`、`QODER_MAX_INFLIGHT`、`QODERCLI_JS`
- **该 daemon 的源码不在仓库里**（README 只说「Qoder 每个账号使用独立 Node 进程与 HOME」）

**但它的出站 payload 构造（`adapter.go:409-466`）是可直接抄的字段清单**：

```json
{
  "model", "messages", "stream",
  "max_tokens", "temperature", "top_p", "stop",
  "parallel_tool_calls", "response_format",
  "is_reasoning", "enable_thinking", "enable_reasoning",
  "thinking", "reasoning_effort", "reasoning_budget_tokens",
  "context_length", "max_input_tokens",
  "tools", "tool_choice"
}
```

**响应解析（`decodeChatOutcome`，L468-518）给出的字段名**：
- `usage`: `prompt_tokens` / `completion_tokens` / **`cache_read_tokens`** / **`cache_write_tokens`** / `source` / **`credits`**（float）
- `choices[0].message`: `content` / **`reasoning_content`** / `tool_calls`（`json.RawMessage`）
- 若 `finish_reason` 空但 `tool_calls` 非 null → 归一为 `tool_calls`

> **`usage.credits` 是 Qoder 特有字段**（OpenAI 没有），说明上游确实回传本次消耗的 Credit 数 —— 对我们的余额/计费展示很有价值。

### B3. 第三条端点线索（**低置信，必须验证**）

第三方网关 OmniRoute 的 issue #2558（`diegosouzapw/OmniRoute`，2026-05-22，已 closed）标题：
> **「fix(qoder): Personal Access Tokens (pt- prefix) fail to route to Qoder native API」**

其正文称：
- `pt-` PAT 被错误路由到 DashScope 兼容端点（`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`）→ 401 `invalid_api_key`
- 「Expected Behavior：Tokens starting with `pt-` should route to **`https://api.qoder.com/v1/chat/completions`** with standard Bearer auth」

⚠️ **我对这条持保留态度**：
- 该 issue **不是 Qoder 官方或 Qoder 逆向项目的报告**，而是另一个网关自己的 bug 报告
- 它没有给出实测证据，且 `api.qoder.com/v1/chat/completions` 在**官方文档全站 grep 中零出现**（我只在官方文档里找到 `api.qoder.com/api/v1/cloud/*` 与 `/api/v1/forward/*`）
- 但**它指出的方向与我的 T1 完全一致**：PAT 很可能走**另一个端点**，而不是 `api2-v2`

→ **列为 T1 的第一候选验证目标（与 `api2-v2` 并列 A/B）。**

### B4. 旧端点（已死，但域名仍活）

```
POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```
来源：`bridge.py:16`

**⚠️ 关键发现：这条路在参考项目里已是死代码。**
`bearer_headers()`（`auth.py:115-143`，构造 `Authorization: Bearer COSY.<payloadB64>.<md5sig>`）**全仓 grep 只有定义、零调用**；`bridge.py:12` 虽 import 了它，实际发送只走 `QODER_CHAT_URL_NEW`。→ **旧端点已无发送路径**。

旧 body 语义（`template_base()`，`bridge.py:39-88`）——将来若需兼容，这些是语义锚点：

| 字段 | 值 | 语义 |
|---|---|---|
| `chat_context.extra.modelConfig` | `{"is_reasoning": false, "key": "lite"}` | 模型配置 |
| `chat_context.extra.originalContent` | `{"type":"text","text":"hi"}` | 原始输入 |
| `chat_context.text` / `chatPrompt` | 同结构 | 当前输入 |
| `parameters.max_tokens` | `32768` | 输出上限 |
| `model_config` | `{key, display_name, model:"", format:"openai", is_vl, is_reasoning, api_key:"", url:"", source:"system", max_input_tokens:180000}` | 模型元信息 |
| `session_type` | `"qodercli"` | 会话类型 |
| `agent_id` / `task_id` | `"agent_common"` / `"common"` | agent 标识 |
| `business` | `{product:"cli", version:"0.1.43", type:"agent", id, name, begin_at, stage:"start"}` | 埋点 |
| `aliyun_user_type` | `"personal_standard"` | 账号类型 |
| `source` / `version` / `chat_task` | `1` / `"3"` / `"FREE_INPUT"` | 固定值 |

⚠️ **老 SSE 是「套娃」结构**：外层 `{"body": "<内层json字符串>"}`，真正 choices 在里面再 `json.loads` 一次（`extract_delta` L293-304）。

**旧域名现状（修正）**：官方文档**明确把 `api3.qoder.sh` 列为需放通域名**：
```bash
curl https://{hosts}/algo/api/v1/ping     # 返回 pong 表示连通
# hosts ∈ { api1.qoder.sh, api2.qoder.sh, api3.qoder.sh }
```
证据：IDE FAQ（`ide-common-issue-en` L23-29、L112-116）

→ **`api3` 域名本身仍活**（IDE 通道在用），但 `agent_chat_generation` 这条具体路径是否可用 = **待真机校准**。protocol-research §7.3 记录 2026-08-06 实测可用，已 6 周前。

### B5. 工具调用（function calling）—— 本方案头号功能未知数

**新端点**：
- `build_qoder_body` L262-263 **原样透传 `tools`** → 网关层支持 OpenAI 原生 tools 数组
- 响应解析走顶层 `delta.tool_calls`，`ToolCallAccumulator`（L314-335）按 `index` 累积、`arguments` 字符串拼接 —— 标准 OpenAI 流式工具调用累积法

**但 QoderGateway 里另有一整套「文本协议兜底」**：
```python
def parse_tool_calls_text(text):        # L170-186
    if not trimmed.startswith("Tool calls:"): return None
    # 解析 "Tool calls:\n```json\n[...]\n```"
```
- 出站（L201-203）：`tools_enabled=False` 时把 `tool_calls` **序列化进 content**
- 入站（L405-414）：流式时**先缓冲 content**，判断是否以 `Tool calls:` 开头，是则不当正文发、等流尾再解析
- 非流式（L448）：`fallback_tool_calls = parse_tool_calls_text(content)`

> 该兜底的存在**暗示**上游有时不返回结构化 `tool_calls`。但注意：**它只在 `tools_enabled=False` 的降级路径上启用** —— 也就是说这是**网关自己的兼容设计**，未必反映上游行为。

**CLI2API 的反证（更可信）**：它的工具转换层（`translate/tools.go`）**完全没有文本兜底**，只做结构化映射：
- `NormalizeOpenAITools()`（L125-183）：把 Codex/Desktop 的 `namespace` 包装展开成扁平 OpenAI function tools；丢弃 `mcp` / `web_search` / `web_search_preview` 这类托管壳；短名限定为 `namespace__name`；已限定的 `mcp__*` 保持不变
- `responseToolNames()`（L19-64）**显式保留工具真实声明**，理由是「both namespaces and tool names can contain underscores」，**不靠拆名字猜身份**
- 自定义/自由格式工具用 `__codex_custom__` 标记做**可逆转义**（L66-103）
- 且有大量专项测试：`translate/tools_test.go`（14KB）

> **推论**：CLI2API 敢做完整的双向工具映射、且**不需要文本兜底**，强烈说明 **Qoder 上游确实返回结构化 `tool_calls`**。
> **但 T2 仍是必须真机验证的第一关** —— 因为 CLI2API 的工具支持可能有一部分是它那个私有 daemon 贡献的。

**官方 SDK 的工具是 MCP 形态，不是 OpenAI function calling**：
- `docs.qoder.com/cli/sdk/tools`：「Custom tools: defined by SDK users and **exposed to the model as in-process MCP servers**」；全名 `mcp__<server>__<tool>`
- 输入 schema 是 MCP JSON Schema；`isError` / `is_error` 是 MCP `CallToolResult` 语义
- 权限用 `canUseTool` / `can_use_tool` + `allowedTools`

→ 结论：**官方 SDK 层面的工具 = MCP**，与 DSH 需要的 OpenAI `tools`/`tool_calls` 是两套东西；但**网关层的 `api2-v2` 端点接受 OpenAI tools**（两个第三方项目一致）。

### B6. 流内错误怎么表达（**CLI2API 给出了实证答案**）

CLI2API 有一整套流式错误处理（`internal/executor/error.go`）：
```go
// StreamIncompleteError is a mid-body stream that ended without [DONE].
func StreamIncompleteError() error {
    return newUnavailableStreamError("upstream_stream_incomplete", "stream ended before [DONE]", 502, nil)
}
// StreamReadError wraps a mid-body stream read failure.
func StreamReadError(err error) error { ... "upstream_stream_interrupted" ... }
```

**关键推断**：它把「流中途结束但没等到 `[DONE]`」当作**一等错误**来处理（`502` + `upstream_stream_incomplete`），说明**这是 Qoder 上真实发生的失败形态**。
→ 这与我们从 trae-cn 学到的教训**完全同构**：**失败发生在流内，HTTP 状态码是 200 或流已开始**。

社区旁证（V2EX 帖 `global.v2ex.co/t/1236779`，**注意是另一个项目 caigee 之外的 cli2api 讨论帖**）：有用户报 **Qoder 国际版自家模型会 `upstream stream ended before [DONE]`**，而第三方模型（GLM 等）正常 —— **疑似 Qoder 对自家高端模型有限制**，未获解答。

官方 SDK 侧的错误面（`sdk-errors.md` L13-27）也是三分类，且明示：
- 「**不要靠解析人类可读错误文本来取码**」（L55）
- process exit code 与 `error_code` **是两个命名空间，不可互比**（L26）
- 错误码见 E1

---

## C. 模型面

### C1. 官方模型表（一手，两套且不一致）

**档位（tier）** —— `cli-model.md` L15-20 / `ide-model-selector.md` L15-22：

| Tier | key | 说明 | Credit 倍率 |
|---|---|---|---|
| Smart Routing | `auto` | 智能路由，日常默认 | ~1.0x |
| Ultimate | `ultimate` | 专家级深度推理 | ~1.6x |
| Performance | `performance` | 高级推理 | ~1.1x |
| Efficient | `efficient` | 标准推理、高性价比 | ~~0.3x~~ **0.0x**（付费用户限时免费） |

**CLI 具体模型**（`cli-model.md` L45-54，10 项）：

| 模型 | 能力 | 倍率 |
|---|---|---|
| Qwen3.8-Max | 推理/视觉/思考开关/low·medium·xhigh/200K·400K·1M | 0.5x |
| Qwen3.7-Max | 视觉/思考开关/200K·400K·1M | 0.5x |
| Qwen3.7-Plus | 视觉/思考开关/200K·400K·1M | 0.1x |
| Kimi-K3 | 视觉/low·high·max/200K·400K·1M | 0.8x |
| Kimi-K2.7-Code | 视觉/256K/Fast 模式 | 0.3x |
| GLM-5.3 | 推理/视觉/low·high·max/200K·400K·1M | 0.6x |
| GLM-5.2 | 推理/视觉/思考开关/high·max/200K·400K·1M | 0.6x |
| DeepSeek-V4-Pro | 推理/视觉/思考开关/high·max/200K·400K·1M | 0.8x |
| DeepSeek-V4-Flash | 推理/视觉/思考开关/low·high·max/200K·400K·1M | 0.3x |
| MiniMax-M3 | 视觉/200K·400K·1M | 0.2x |

**IDE 表**（`ide-model-selector.md` L47-59，11 项）与之**不一致**：多 `Qwen3.8-Flash`(0.1x)、`GLM-5.3-Flash`(0.1x)、`Kimi-K2.8-Preview`(0.3x)、`DeepSeek-Flash`(0.2x)，少 `Kimi-K2.7-Code`。

> ⚠️ **两张官方表都不一致 → 模型池随产品线/账号浮动，绝不可硬编码单一表**（与我们 trae-cn「roster 会浮动」的教训一致）。

**国内版表**（`docs.qoder.cn/cli/model`）：默认页**只有 Auto 一种**（Global 版有 Ultimate/Performance 等）；前沿模型 9 项：Qwen3.8-Max / Qwen3.7-Max / Qwen3.7-Plus / Qwen3.6-Flash / DeepSeek-V4-Pro / DeepSeek-V4-Flash / GLM-5.2 / Kimi-K2.7-Code / MiniMax-M2.7。**国内版明示「一切以 `/model` 界面和 `qodercn --list-models` 实际输出为准」。**

**CLI2API 的模型字段映射**（`adapter.go:151-189`，可作我们 listModels 的字段蓝本）：
- `id`（public）/ **`mapped_key`** 或 `native_model`（上游真名）/ `display_name` / `credits` / `free` / `context_length` / `is_reasoning`
- 它硬编码 `Tools: true, Images: true`（**注意：这是它的默认假设，不是按模型探测**）
- `CatalogIDsFromInfos` 支持**三种 id 同时匹配**（public / native / display_name）—— 对「用户填哪个都能路由」很实用

**社区补充的模型短 key（CLI2API/QoderGateway 社区，非官方文档）**：
`lite` = qwen3-coder（默认，**已退役**）；`qmodel_38max` = Qwen3.8-Max；`kmodel_latest` = Kimi K3；`gm51model` = GLM5.2。
> ⚠️ 这些是论坛抓包所得，**与官方文档里的 tier 名（`auto`/`efficient`/`performance`/`ultimate`）是两套命名**。`model` 字段到底收哪一种 = **T4**。

**思考档位**（`cli-model.md` L90-100）：`low` / `medium` / `high` / `xhigh` / `max`
- CLI：`/effort high`、`/effort auto --session-only`、`/effort off`；启动参数 `--reasoning-effort`
- SDK：`parameters: { reasoningEffort: "high" }`（**camelCase**，`sdk-model-policy.md` L115-142）
- **CLI2API 的归一化表**（`providers/reasoning.go:5-34`，可直接抄）：
  `none`←(none/off/disabled)；`low`←(low/light/minimal)；`medium`←(medium/default)；`high`←(high)；`xhigh`←(xhigh/x-high/extra_high/extra-high/extrahigh)；`max`←(max)
- **CLI2API 出站字段名是 `reasoning_effort`**（`adapter.go:447-449`），另有 `reasoning_budget_tokens`、`thinking`、`enable_thinking`、`is_reasoning`
- 窗口：`/context-window 400000`、`--context-window 400000`；出站字段 `context_length` / `max_input_tokens`
- Fast 模式：`/fast on`（部分模型，如 Kimi-K2.7-Code）

### C2. 模型列表端点

**官方权威目录（Cloud Agents 线）**：
```
GET https://api.qoder.com/api/v1/cloud/models
Authorization: Bearer $QODER_ACCESS_TOKEN
```
响应（**一手，可直接作为 listModels 字段映射蓝本**）：
```json
{"data":[{
  "id":"ultimate","type":"model","display_name":"Ultimate","source":"system",
  "is_enabled":true,"is_new":false,"price_factor":1.6,
  "efforts":["low","medium","high","xhigh","max"],"default_effort":"high",
  "max_input_tokens":1000000,"default_context_window":200000,
  "available_context_windows":[200000,400000,1000000]
}],"has_more":false}
```
- 错误：401 `authentication_error`（PAT/SAT 无效或过期）/ 503 `api_error`（目录暂不可用）
- 只返回 enabled 模型；不含 provider/secret/description；catalog 按认证用户与 scene 解析（默认 scene = `assistant`）
- 证据：`ca-models-list.md` L9-93

**其他途径**：
- CLI：`qoder --list-models`（无界面输出当前账号可用模型）
- SDK：`q.getAvailableModels()` → `{value, displayName, isEnabled}`；`ModelInfo.context_config` / `ModelInfo.thinking_config`
- CLI2API：**自己不做模型推理，全部经 `/admin/models` 问它的 daemon**（`worker.go:99-127`），支持 `?refresh=1`
- **`api2-v2.qoder.sh/model/v1/models` 未在任何官方文档或参考项目中出现** → 存在性待校准（T5）

### C3. QoderGateway 硬编码的模型表 vs 官方

**参考项目其实没有模型表** —— 它只把请求里的 `model` 字符串**原样透传**，默认值 `"lite"`：
- `bridge.py:243`：`model = req.get("model") or "lite"`
- `bridge.py:48` / `66-77`：写死 `modelConfig.key="lite"`、`model_config.key="lite"`、`display_name="Lite"`、`max_input_tokens: 180000`
- `app.py:393`：`model = payload.get("model", "lite")`

→ **与官方现行模型表完全脱节，且默认值已被官方废弃。**

---

## D. 额度与签到面

### D1. quota/usage —— **CLI2API 给出了完整结构（T6 基本解决）**

`internal/providers/qoder/quota.go`（完整 68 行已读）：
```go
type workerQuota struct {
    UserQuota          *workerQuotaBlock `json:"userQuota"`
    AddOnQuota         *workerQuotaBlock `json:"addOnQuota"`
    OrgResourcePackage *workerQuotaBlock `json:"orgResourcePackage"`
    IsQuotaExceeded    bool              `json:"isQuotaExceeded"`
    FetchedAt          string            `json:"fetchedAt"`
}
type workerQuotaBlock struct {
    Total, Used, Remaining, Percentage float64
    Unit      string
    Available *bool
}
```

**三池语义**：`userQuota`（方案内 Credits）/ `addOnQuota`（购买或活动获得的加量包）/ `orgResourcePackage`（组织资源包）。

**耗尽判定逻辑（`snapshot()`，L26-67，非常值得抄）**：
```
Exceeded = isQuotaExceeded || userQuota.percentage >= 100
// 关键修正：主池耗尽但有加量包/资源包余额 → 视为未耗尽
if Exceeded && (addOnQuota.hasRemaining() || orgResourcePackage.hasRemaining()) {
    Exceeded = false
}
// hasRemaining(): Remaining > 0 && (Available == nil || *Available)
```
- `Unit` 缺省填 `"credits"`
- 另有 `HasAddOn` / `AddOnUsed` / `AddOnTotal` / `AddOnRemaining` / `AddOnAvailable` 等派生字段

> ⚠️ **注意责任边界**：上述字段是 **CLI2API 私有 daemon 的输出契约**（`/admin/quota` 返回 `{quota: {...}}`），**不是 Qoder 上游 `openapi.qoder.sh/api/v2/quota/usage` 的原始响应**。字段名与语义极可能同构（`userQuota` / `isQuotaExceeded` 与 QoderGateway `app.py:438` 的用法**完全一致** —— 这是两个独立项目的交叉印证，可信度高），但**逐字段仍需 T6 真机确认**。

**直连端点（QoderGateway 在用）**：
```
GET https://openapi.qoder.sh/api/v2/quota/usage
Authorization: Bearer <security_oauth_token>
Accept: application/json
User-Agent: qoder/1.1.16
```
证据：`tokens.py:18-28`（常量）、`tokens.py:103-107`（调用）；`app.py:438` 消费 `isQuotaExceeded` 与 `userQuota.remaining`

**老版（字段名已知）**：
```
POST https://center.qoder.sh/algo/api/v3/user/status?Encode=1
→ quota / isQuotaExceeded / plan / userTag / nextResetAt
```
证据：`auth.py:235-266` + `accounts.py:55-66`

**官方 usage 面板口径**（`cli-usage.md`）：Plan / Plan Expiration Date / **Plan Credits Used（已用/总量）** / **Add-on Credits Used** / Org Resource Package / Total Duration API / Total Duration Wall / Total Code Changes。80% 黄色警告、95% 红色。

**CLI2API 还解析了 `usage.credits`**（`adapter.go:477`）—— 每次请求的 Credit 消耗，可做精细计费展示。

### D2. 每日签到 —— **国际版没有；国内版有；且走官方 CLI**

**官方公告（`docs.qoder.com/events/100credits`，全文已读）**：
- 「**Claim 100 Credits Every Day**」：2026-09-18 10:00 (UTC+8) 起，Qoder **国际版个人用户**（Free/Pro Trial/Pro/Pro+/Ultra）每天可领 100 Credits
- **Teams / Enterprise 不可**
- 领取窗口：每天 10:00 开新窗口，次日 10:00 前关闭；每账号每窗口一次；**错过不补**
- **领取位置：只能在 Qoder 桌面 App**（Usage 面板 → 左下角礼物图标），**必须手动领**
- 奖励进 **Add-on Credits**，**有效期 30 天**，可累加；**先到期先扣**；同到期时间时 Plan 先于 Add-on

**CLI2API 的实现与作者自述（决定性）**：

| 事实 | 证据 |
|---|---|
| Qoder **被登记为支持签到的 provider**（`Checkin` 槽位） | `qoder/adapter.go:87-93` `Adapter{ID:"qoder", Login, Chat, Models, Checkin}` |
| 签到是**一等公民**：有调度（默认 `09:00`，每账号可覆盖、每 provider 可配默认） | `accounts/checkin.go:12` `DefaultCheckinTime = "09:00"`、`ResolveCheckinTime()`、`ValidateCheckinSettings()` |
| 签到结果三态：`success` / `already` / `skipped` | `providers/checkin.go:15-17` `Valid()` |
| **作者明说：「Qoder 国际版不显示签到，国内版活动关闭时只记录跳过；真实账号签到验收仍待完成」** | `README.md:72` |
| **作者明说：「Qoder 国内版、WorkBuddy、Trae 的适配代码已实现，真账号验收仍未完成」** | `README.md:27` |

> **结论（修正我此前的判断）**：
> - **Qoder 国际版：不做签到**。官方只在桌面 App 手动领，无公开 API —— 与 CLI2API 的行为一致（它的 README 明说国际版不显示签到）
> - **Qoder 国内版：签到存在**，但**连 CLI2API 自己都还没用真账号验收过**，且是「活动关闭时只记录跳过」
> - **对我们的建议：`dailyCheckin: false`**（国际版场景）。若将来做 `qoder-cn`，签到可以再评估 —— 但别做第一个吃螃蟹的人

### D3. 试用额度怎么发（**官方风控核心，必读**）

- 新用户**首次登录任一 Qoder 客户端**（IDE / CLI / JetBrains 插件）送 **一次性、免费、14 天 Pro 试用 + 300 Credits + Pro 全部专属功能**
- **要求最新版**；**不支持虚拟机**（not available on virtual machines）
- 试用到期 → 自动降级 Free，**未用完的试用 Credits 清零**
- 试用期内升级付费 → 剩余试用 Credits 转成 Credit Pack 保留原到期日
- 证据：`pricing.md` L21-29、`ide-common-issue-en` L196-200

**付费档位**（`pricing.md` L13-19）：

| Plan | 价格 | 额度 |
|---|---|---|
| Free | 免费 | 2 周 Pro 试用 + 有限补全/NES + BYOK |
| Pro | $20/mo | 2,000 Credits/月 |
| Pro+ | $60/mo | 6,000 Credits/月 |
| Ultra | $200/mo | 20,000 Credits/月 |

Credit Pack：$20 / 1,500 Credits，**有效期 1 个月、不退款、可叠加**。

### D4. 免费额度耗尽时的错误形态（换号依据）

**官方错误码（一手，`sdk-errors.md` L175-186）**：

| Code | 含义 | 官方建议动作 |
|---|---|---|
| `105` | 登录/access token 过期 | **换有效凭据 + 新建会话** |
| `110` | **每日用量达上限** | 等窗口重置或检查账号限额 |
| `113` | **用量配额耗尽** | 检查配额与套餐；**不要原样立即重试** |
| `114` | **免费试用账号上限** | 检查账号资格/升级 |
| `115` | **免费用户配额达上限** | 等配额续期或升级 |
| `116` | 团队管理员 Credits 耗尽 | 找管理员充值 |
| `117` | 团队成员 Credits 耗尽 | 找管理员分配 |
| `118` | **个人 Credits 耗尽** | 充值或换有额度的账号 |
| `119` | **所选模型的免费额度达上限** | 换模型 / 等续期（**逐模型维度**） |
| `122` | 计费组 Credits 上限 | 找计费管理员 |

**产品行为**：付费用户额度用尽后**自动切基础模型（basic models）**，基础模型有**每日上限**（`pricing.md` L47）。Lite 退役后**不再自动切 Lite**（`rn-lite-retire.md` L30、L40）。

> **`119` 是逐模型维度** —— 正好对应我们账号池「限流按模型记账」（`getAvailableAccount(model)` 的逐模型过滤）。

---

## E. 限流与错误分类

### E1. 官方错误码全表

**A. 认证与配额**：`105/110/113/114/115/116/117/118/119/122`（同 D4）

**B. 请求与策略**（`sdk-errors.md` L192-198）：

| Code | 含义 | 官方建议 |
|---|---|---|
| `406` | 敏感内容/模型拒绝 | 改请求，**不要原样重试** |
| `416` | 请求 range/形态不可满足 | 看 `errors` 修正 |
| `430` | 请求的能力不支持 | 升级 SDK/qodercli |
| `47902` | 达到最大 Agent 轮次 | 查循环/权限/工具失败 |
| `48716` | Hook 阻止执行 | 查 Hook 决策 |
| `80411` | **输入内容过长** | 缩减 prompt/附件/上下文 |
| `80412` | **图片/文档过多** | 减少媒体附件 |

**C. 服务与模型运行时**（L202-210）：

| Code | 含义 | 官方建议 |
|---|---|---|
| `500` | 请求或网络失败 | **有界指数退避重试** |
| `10408` | 请求超时 | **有界退避重试** |
| `10500` | 模型服务内部错误 | **稍后重试**，留 session ID |
| `10605` | 模型请求排队中 | qodercli 通常自己等+重试 |
| `100400/100401/100403` | 自定义模型（BYOK）错误/认证失败/不可用 | 检查第三方 provider |

**官方重试策略**（L87-91、L212 Warning）：
```js
if (message.error_code === 105) { /* 取新凭据 + 新建会话 */ }
else if ([500, 10408, 10500].includes(message.error_code)) { /* 有界指数退避重试 */ }
```
> 只重试已知瞬态错误。用最大尝试次数 + 指数退避 + 抖动。**认证、配额、策略、输入、配置类错误必须先改变再重试。**

**D. qodercli 进程退出码**（L247-257）：`0` 正常 / `1` 通用失败 / `41` 认证失败 / `42` 参数无效 / `44` 致命沙箱错误 / `52` 致命配置错误 / `53` 致命轮次限制 / `54` 致命工具执行错误 / `130` 取消。

### E2. CLI2API 的实战错误分类（**最有价值的可复用资产**）

`internal/executor/classify.go`（414 行，全读）—— 这是一个**已上生产、经真机打磨**的分类器：

**Kind 与策略矩阵**：

| Kind | HTTP | Failover | Cooldown | 说明 |
|---|---|---|---|---|
| `KindQuota` | 429 | **false** | **本地次日零点**（`NextLocalMidnightCooldown()`） | 额度耗尽：换号无用（所有号都耗尽），冷却到重置点 |
| `KindRateLimit` | 429 | **true** | `Retry-After` 提示，**最少 30s** | 限流：换号有用 |
| `KindAuth` | 401/403 | **true** | 默认 30s | 凭据失效 |
| `KindNotReady` | 503 | **true** | 默认 10s | 上游未就绪 |
| `KindInvalidRequest` | 400 | **false** | **0** | 请求内容问题：**换号不可能成功** |
| `KindModelNotAvailable` | 400（目录不可用时 503） | **true** | **0** | 账号健康，但陈旧目录可能要换号重试；**绝不冷却账号** |
| 默认 `KindUnavailable` | 原状态或 502 | **true** | 默认 15s | 其他 |

**Qoder 专有业务码**（`quotaLike()`，L362-371）—— **重要增量**：
```go
code == "insufficient_quota" || typ == "insufficient_quota" ||
code == "1005" || code == "4008" || code == "14018"
```
外加中文文案匹配：`"额度已用尽"` / `"额度用尽"` / `"购买加量包"` / `"exceeded your current quota"`

**其他匹配器**（L373-413）：
- `rateLike`：`too many requests` / `rate limit` / `rate-limit` / `response code=429` / `resource_exhausted` / `rate_limit_exceeded` / `account busy` / `in-flight`
- `authLike`：`null pointer` / `forbidden` / `duplicate request` / `unauthorized` / `401` / `403` / `credential` / `refresh token` / `access token`
- `notReadyLike`：`hot context not ready` / `auth manager not captured` / `not ready`
- `modelNotAvailableLike`：`model_not_available` / `is not available for this qoder account` / `model_catalog_unavailable` / `no accounts serve model`
- `promptLimitLike`：输入过长 → 强制归 `KindInvalidRequest`（**优先级高于其他判定**，L190-192）
- **冲突消解**：`KindAuth` + quotaLike → `KindQuota`；`KindRateLimit` + quotaLike → `KindQuota`（L193-198）

**Retry-After 解析（`classify.go:55-161`）**—— 极其完备，支持：
- HTTP 头（`Retry-After`）与 body 内提示
- body 键名：`retry_after` / `retryafter` / `quotaresetdelay` / `resets_in_seconds` / `resets_at` / `reset_at`（**大小写不敏感**）
- 值形态：Go duration 串 / 秒数 / **毫秒时间戳（1e12~1e14）** / **秒时间戳（1e9~1e11）** / HTTP 日期 / RFC3339
- 递归进嵌套对象/数组/JSON 字符串
- 上限 `maxRetryAfter = 10min`

**指数退避**（L28-53）：`backoffFloor=30s`、`backoffCeiling=6h`，按 `1<<level` 倍增

**错误体解析（`extractError`，L281-345）**：兼容 `error.message|msg|code|type|kind|data.*` 与顶层 `message|code|type|kind`，并**递归解析 `body` 字段（字符串或对象）** —— 正好对应 QoderGateway 那个「套娃」SSE 结构。

**特殊码**：`4011`（rateLimit 且无 Retry-After 时给 5 分钟冷却，`error.go:117-118`）

### E3. QoderGateway 的分类逻辑（对照）

`app.py:348-377`：
```python
def is_quota_error(exc):     # 429 / quota / rate limit / insufficient
def is_account_error(exc):   # 触发换号
    HTTPStatusError 401/403/429 → True
    httpx.HTTPError（连接/超时/读错误） → False   # 网络问题换号没用
    RuntimeError 消息含 http 401/403/429 / unauthorized / invalid token /
                  quota / rate limit / insufficient / personal token / credit → True
```
**值得借鉴的「二次确认」**（`app.py:433-446`）：遇到 quota 类错误时**先查一次真实限额再决定是否换号** —— 确认耗尽才换；查得到但未耗尽 → 不换；**查不到 → 保守不换**。

换号是**轮转**（`rotate_next_account`，`accounts.py:201-243`）：标记 `last_status='failed'` + `last_error` → 取下一个 enabled → 写 `active_uid`。重试次数 = `max(1, enabled 账号数)`（`app.py:400`）。

### E4. UA / 版本头 / machine_id 哪些必带

| 项 | `api2-v2` 新端点 | `api3` 旧端点 | device flow |
|---|---|---|---|
| `Authorization: Bearer <token>` | ✅ | ✅（`COSY.payload.sig`） | — |
| `User-Agent: qoder/1.1.16` | ✅ | ✅（`Go-http-client/2.0`） | — |
| `Content-Type: application/json` | ✅ | ✅ | — |
| `Accept: text/event-stream` | ✅ | ✅（含 `cache-control: no-cache`） | `application/json` |
| `X-Request-ID` / `X-Session-ID` | ✅ | — | — |
| `cosy-*` 全套（version/clienttype/date/key/user/machineid/machinetoken/machinetype/clientip/data-policy） | ❌ | ✅ 必带 | — |
| `login-version: v2` | ❌ | ✅ | — |
| `appcode` + `signature` | ❌ | ✅ | — |
| `machine_id` | ❌ **不用** | ✅ | ✅（授权 URL 里） |
| body 内 `client_type: "qodercli"` | ✅ | — | — |

⚠️ **`user-agent` 新旧不同**（`qoder/1.1.16` vs `Go-http-client/2.0`），**不要「顺手统一」**。
⚠️ **是否被服务端校验 = 待校准（T8/T9/T13）**。

### E5. 封号 / 风控面（决定性一手证据）

**① 官方论坛管理员原话**（`forum.qoder.com/t/b-a-b-pro-pro/5678`，本机已抓全文）：
> 「经核查，该问题是由于我们的**安全防护机制**所致。为防止 Pro 试用资格被滥用，系统规定**同一台设备仅限一个账号进行试用**。若某台设备已使用过试用账号，再次登录其他新申请的 Pro 试用账号时，会触发**风控保护**，导致新账号的试用资格失效。」

**② 官方 FAQ**（`ide-common-issue-en` L157-204）：
- 「If your account was **suspended** due to having **too many free trial accounts**, you can reactivate it…」
- 解封路径：Usage 页 → `Reactivate Account` → 确认政策告知。**⚠️「重新激活后，原有剩余额度会清零」**
- 「Our policy allows the free Pro Trial only on your **first account** to prevent abuse.」
- 「The Pro trial (including the 300 Credits trial allowance) is **limited to one time per user**. Any trial obtained by **registering multiple accounts will be revoked**.」
- 「**Using the Pro trial on virtual machines is not supported.**」
- 「the Pro Trial is limited to **one account per user**. Any additional trial accounts created will be **suspended**.」

**③ 官方定价页**（`pricing.md` L99）：
> 「This offer is limited to one account per user; any additional trial accounts created will be **frozen**.」（并要求最新版客户端、**不支持虚拟机**）

**④ 第三方归纳（三手，谨慎引用）**：掘金《Qoder账号被冻结？三步操作轻松解封》列冻结原因：免费试用超限 / 多账号频繁切换 / 操作超额（如批量生成 Repo Wiki）/ 风控误判。

**⑤ QoderGateway 仓库实测（GitHub API，2026-09-20）**：

| 指标 | 值 |
|---|---|
| stars | **95** |
| forks | **39** |
| **全部 issues（含 closed）** | **0**（API 返回 `[]`，已核实非限流） |
| **全部 PRs** | **0** |
| created | 2026-06-14 |
| **最后 push** | **2026-08-31**（3 周未动） |
| archived | False；License MIT；subscribers 0 |
| **提交总数** | **8**（6-14 首发 / 8-07 协议大改 / 8-31 注册机小修） |

**⑥ CLI2API 仓库实测（GitHub API，2026-09-20）**：

| 指标 | 值 |
|---|---|
| stars | **142** |
| forks | 16 |
| **最后 push** | **2026-09-19**（**昨天，非常活跃**） |
| created | 2026-08-21 |
| 语言 | **Go** |
| issues | 7 |
| 描述 | Self-hosted OpenAI-compatible API for Qoder CLI login, workbuddy, with SQLite multi-account routing |

**⑦ 社区反馈（LINUX DO 主帖 `linux.do/t/topic/2835337`，QoderGateway 作者 acmuhan 发，48 帖 / 1.6k 浏览）**：
- **无任何封号报告，无任何 429 报告**
- 最高频痛点：**「没有额度」**（「只有领取的 500 积分」「只能用 lite」）
- ⚠️ 最接近风控的一条（**未获解答**）：「目前 qoder 的反代都会出现**中途被禁止无法使用**，这个也会出现吗？」
- 作者自述：「注册出来啥也没送应该是因为 qoder 最近没有活动了，有活动的时候再注册才能薅到羊毛」「触发验证是正常行为」

**⑧ 关联项目**：
- `cubk1/qoder2api`（QoderGateway 的灵感来源）：stars **87**、最后 push **2026-05-14**（4 个月未动）
- `Yanu403/qoder-farm`：「Automated Qoder.com account registration + **PAT creation via Google OAuth**」stars 12、最后 push 2026-08-05

> **风险判断**：
> **没有任何公开的封号报告可引用**（QoderGateway issue 区为空、CLI2API 无相关 issue、社区帖多为推广）。
> 但**官方风控条款白纸黑字，且明确以「设备」为维度**。风险不在「用 API」，而在「多开试用账号 / 批量注册 / 虚拟机刷试用」。
> 注意 CLI2API 自己的免责声明（README L76-80）：「只连接你自己的账号，不提供账号、额度或官方 API 服务」「上游协议变化可能影响兼容性」。

---

## F. 接入建议

### F1. 用旧端点还是新端点？→ **必须用新端点**

`POST https://api2-v2.qoder.sh/model/v1/chat/completions`

理由：
1. **旧端点在参考项目里已是死代码**（`bearer_headers()` 零调用）
2. 官方 CLI/SDK 现行就是 Bearer 直连新端点
3. 旧端点要复刻 **COSY 全套**：RSA 加密 temp_key + AES-CBC 加密 identity + 自定义 base64（三段重排）+ md5 签名 + 十几个 cosy-\* 头 —— 成本极高且是明确旧代协议
4. 新端点**请求/响应都是 OpenAI 原生形态**，与我们现有适配器结构同构

⚠️ 端点选择 ≠ 模型选择：`lite` 退役在新端点**同样存在**。
⚠️ **但 T1 必须先在 `api2-v2` 与 `api.qoder.com/v1/chat/completions`（B3 线索）之间做 A/B。**

### F2. 凭据形态建议

**方案 A（阶段 1，推荐）：纯 PAT**
```ts
{ accessToken: "pt-...", refreshToken: null, machineId: null }
```
- PAT 由官方签发（`qoder.com/account/integrations`），可设有效期与 scopes、可吊销
- **官方明示不自动刷新** → 过期即需用户重新生成，UI 要明确提示
- 形态最简单、最合规、维护成本最低

**方案 B（阶段 2，体验优化）：device flow 六件套**
```ts
{ accessToken: "dt-...", refreshToken: "drt-...", machineId, userId, expiresAt, refreshTokenExpiresAt }
```
- 可用 `POST openapi.qoder.sh/api/v1/deviceToken/refresh` 静默续期（≈360 天）
- 但接受逆向 `client_id` 随时失效的风险

**方案 C（不推荐，仅记录）：CLI2API 式「搬运官方 CLI 凭据」**
- 读官方 CLI 写的 `~/.qoder/.auth/user`（AES-CBC）+ `~/.qoder/.auth/machine_id`，解密后存入我们自己的凭据库
- 优点：完全复用官方登录，不用碰 PKCE
- **缺点**：需要用户先装并登录官方 CLI；解密依赖本机 AES 实现（Node 原生 crypto 可做）；且**仍要自己做那层 daemon**

⚠️ **两条路径的 token 不同源，必须搞清楚**（T1 核心）：
- `pt-` PAT 与 `dt-` device token 是**两个体系**：protocol-research §7.4 实测「把 `dt-`/`drt-` 当 `personalToken` 提交 `jobToken` 兑换端点 → **401 `personal token is invalid`**」
- 但 `dt-` **在新端点上可直接用**（§7.2 实测 200）
- **PAT 能否直接打 `api2-v2` = 未验证（T1，头号阻塞项）**
- 中间桥：`POST https://openapi.qoder.sh/api/v1/jobToken/exchange`，body `{"personal_token": "<PAT>"}`（protocol-research §2）—— **很可能就是 PAT → job token 的兑换端点**

### F3. 模型表建议

- **骨架用官方 Cloud Agents 的 Model schema**（`id` / `display_name` / `price_factor` / `efforts` / `default_effort` / `max_input_tokens` / `default_context_window` / `available_context_windows`）—— 官方权威结构
- **静态兜底表**至少含四个 tier（`auto` / `efficient` / `performance` / `ultimate`）+ 官方 CLI 10 项具体模型
- **绝不含 `lite`**
- **优先接动态目录** `GET https://api.qoder.com/api/v1/cloud/models`（需 T5 校准：目录 `id` 是否与 chat 端点接受的值一致）
- **借鉴 CLI2API 的三 id 匹配**（public / native / display_name 都能路由），提升用户手填模型的容错
- 思考档位归一化直接抄 `providers/reasoning.go`；出站字段名 **T10 校准**

### F4. 最小可行接入方案

| 项 | 取值 |
|---|---|
| **provider id** | `qoder` |
| **服务名** | `qoderAuth` —— **机械派生 `${id}Auth` 即合法标识符，无需显式 `serviceName`** |
| **显示名** | Qoder |
| **登录方式** | **阶段 1：PAT 手动粘贴**（Hub 输入框 + 「验证」按钮；验证 = 打 `GET api.qoder.com/api/v1/cloud/models` 或 `GET openapi.qoder.sh/api/v2/quota/usage`）。**不做浏览器 PKCE**（留阶段 2） |
| **chat 端点** | `POST https://api2-v2.qoder.sh/model/v1/chat/completions`（T1 A/B 后定案） |
| **鉴权** | `Authorization: Bearer <token>` + `Accept: text/event-stream` + `Content-Type: application/json` + `User-Agent: qoder/1.1.16` + `X-Request-ID` + `X-Session-ID` |
| **凭据字段** | `{ accessToken, refreshToken?, machineId?, userId?, expiresAt? }`（阶段 1 仅 `accessToken`） |
| **模型表** | 4 tier + 官方 CLI 10 项（不含 lite）；优先动态目录 |
| **账号池 / 限流** | 复用 `src/account-pool.ts`；错误分类按 E2 矩阵 |
| **签到** | **不做**（国际版官方仅 App 内手动领；CLI2API 亦不显示） |
| **注册机 / 批量产号** | **绝对不做**（直接撞官方风控红线） |
| **旧 COSY 端点** | **不实现**（死路 + 成本极高） |

**面板能力矩阵建议**：
```js
qoder: { balance: true, dailyCheckin: false }
```
- `balance`: ✓ —— `GET openapi.qoder.sh/api/v2/quota/usage`，三池结构按 D1 解析
- `dailyCheckin`: ✗ —— 国际版无 API

### F5. 待真机校准清单（T1–T17）

> 纪律：**一次一个变量**；每项记录「请求/响应原文 + 结论 + 日期」，对齐 trae-cn 的取证习惯。

| # | 优先级 | 待验证问题 | 为什么重要 |
|---|---|---|---|
| **T1** | 🔴 阻塞 | **`pt-` PAT 能否直接 `Bearer` 打 chat？** A/B 三个候选：① `api2-v2.qoder.sh/model/v1/chat/completions` ② `api.qoder.com/v1/chat/completions`（OmniRoute 线索，B3）③ `openapi.qoder.sh/api/v1/jobToken/exchange`（`{"personal_token": PAT}`）换回来的是什么前缀、有效期多久？ | 决定凭据形态（F2），整个方案的起点 |
| **T2** | 🔴 阻塞 | **新端点是否真支持 OpenAI 原生 function calling？** 发 `tools` 后返回结构化 `delta.tool_calls`，还是把 `Tool calls:` 写进 `delta.content`？ | **决定本 provider 能否作为 DSH 的 agent provider** |
| **T3** | 🔴 阻塞 | **流内错误形态**：HTTP 200 + 流内 error 帧？字段名？还是「无 `[DONE]` 的静默断流」（CLI2API 专门处理了这个）？ | 换号逻辑接不住流内失败 = 从 trae-cn 学到的最大教训 |
| **T4** | 🟠 高 | `model` 字段确切取值域：tier 名（`performance`）、具体模型名（`Qwen3.8-Max`）、还是短 key（`qmodel_38max`）？大小写敏感？ | 直接决定 listModels 播报什么 |
| **T5** | 🟠 高 | `GET api.qoder.com/api/v1/cloud/models` 返回的 `id` 是否与 chat 端点接受值一致？`api2-v2.../models` 是否存在？ | 能否用官方目录做动态模型表 |
| **T6** | 🟠 高 | `GET openapi.qoder.sh/api/v2/quota/usage` 的**原始响应**是否就是 `{userQuota, addOnQuota, orgResourcePackage, isQuotaExceeded, fetchedAt}` + `{total, used, remaining, percentage, unit, available}`？（D1 的两个项目交叉印证需逐字段确认） | 积分余额行解析 |
| **T7** | 🟡 中 | PAT 的有效期上限与 scope 选项；过期后的错误形态（是否就是 `105`） | 凭据失效的 UX 文案 |
| **T8** | 🟡 中 | `User-Agent: qoder/1.1.16` 是否被校验？版本过低/过高会怎样？ | 会不会像 trae-cn 的 `x-ide-version-code` 那样是「选表键」 |
| **T9** | 🟡 中 | 新端点上 `machine_id` / `machine_token` / `machine_type` 是否完全不需要？ | 决定凭据要不要存机器身份 |
| **T10** | 🟡 中 | 思考档位出站字段名：`reasoning_effort`（CLI2API 用）vs 其他？`reasoning_budget_tokens`/`thinking`/`enable_thinking` 哪些真被接受？ | 思考档位接线 |
| **T11** | 🟡 中 | `refresh_token` 是否**一次性轮换**？旧 rt 在用新 rt 后是否立即失效？ | 并发续期的竞态安全 |
| **T12** | 🟡 中 | **Qoder 国内版签到**到底走什么端点？（CLI2API 实现了但**自己都没验收**，README 明说） | 若将来做 qoder-cn |
| **T13** | 🟢 低 | `metadata.context.client_type: "qodercli"` / `task_id: "common"` 是否被校验？ | 出站身份标识能否动 |
| **T14** | 🟢 低 | 免费/试用账号在 chat 端点上的实际可用模型集（是否被限制在 basic models） | 免费账号可用性预期 |
| **T15** | 🔴 阻塞（**若走 CLI 路线**） | **CLI2API 那个私有 Node daemon 到底是什么？** 它调用官方 `qodercli` 的哪个内部接口？（我们若走 CLI 包装路线必须自己实现） | 决定「直连 HTTP」还是「包装 CLI」两条架构路线 |
| **T16** | 🟡 中 | `usage.credits` 是否为 Qoder 上游原生字段（CLI2API 在解析它）？若是，可做精确计费 | 余额/计费展示 |
| **T17** | 🟢 低 | CLI2API 报的 `1005` / `4008` / `14018` 三个额度类业务码的准确语义 | 错误分类精确化 |

### F6. 风险与开放问题

1. **合规风险（最高）**
   Qoder 官方风控**以设备为维度**且条款明确（同设备仅一个试用账号；多开试用账号会被 suspend/freeze；**不支持虚拟机**）。我们插件的多账号池 + 参考项目的注册机形态**正对着这条红线**。
   **建议**：只支持**用户手动粘贴自己的 PAT**，**不内置任何注册 / 批量产号 / 试用薅取能力**；文档写明「仅限你自己的账号」。

2. **PAT 本身不违规**
   官方 PAT 就是给 CI/CD 与 SDK 用的正当凭据（有 scopes、有效期、可吊销），用它调 API **本身不违规**。违规的是「多开试用账号」与「虚拟机刷试用」。这个区分必须在文档里写清楚。

3. **`lite` 陷阱**
   任何从 QoderGateway 抄来的代码都带 `"lite"` 默认值，**今天必炸**。必须改成 `efficient` 或 `auto`。**最容易踩的坑。**

4. **工具调用未知（最大功能风险）**
   若 T2 结论是「不支持原生 tool_calls」，本 provider 对 DSH 的价值大幅下降（只能纯对话，不能做 agent）。
   **建议：先用真机把 T1 + T2 + T3 打掉，再决定是否投入完整实现。**

5. **两条架构路线的抉择（新）**
   - **路线 A：直连 HTTP**（QoderGateway 式）—— 轻，但完全依赖逆向情报，协议一变就死
   - **路线 B：包装官方 CLI**（CLI2API 式）—— 稳（协议由官方 CLI 吸收），但**重**（每账号一个 Node 进程 + 独立 HOME）、**而且要自己做 daemon（T15）**，且官方 CLI 需用户自行安装
   > 建议：**先做路线 A**（阶段 1，PAT + 直连），把 T1/T2/T3 打掉；若逆向面太脆，再评估路线 B。

6. **协议漂移频率高**
   - COSY 签名（老）→ Bearer 直连（新）：两个月内两代并存并完成迁移
   - Lite 档位 2026-09-18 退役
   - V2EX 有「Qoder 自家模型 `upstream stream ended before [DONE]`、第三方模型正常」的报告
   - **要按「随时会变」设计**：模型目录动态化、错误分类宽松、未知码直报

7. **参考项目对比与选型**
   | | QoderGateway | CLI2API |
   |---|---|---|
   | 语言 | Python | Go |
   | stars | 95 | **142** |
   | 最后更新 | 2026-08-31（3 周前） | **2026-09-19（昨天）** |
   | issues | **0** | 7 |
   | 协议来源 | 自研逆向（`api2-v2` 直连） | 包装官方 CLI（私有 daemon） |
   | 文档/代码一致性 | **文档 §9 已过时**（说「未实施」的其实已实现） | 较一致，但**核心 daemon 未开源** |
   | 可借鉴度 | 协议细节高、**默认值已废弃** | 架构与工程实践高、**但不可直接复制** |
   > **引用 QoderGateway 要看代码不看文档；引用 CLI2API 要看接口不看实现。**

8. **两个产品线不互通**
   国际版（`qoder.com` / `*.qoder.sh` / 文档 `docs.qoder.com`）与国内版（`qoder.cn` / `*.qoder.com.cn` / 文档 `docs.qoder.cn`）**账号与用量不互通**（`credits-zh` L127 明示）。
   要不要做 `qoder-cn` 是**独立决策**（类似 buddy-cn 形态）。国内版细节：CLI 命令 `qodercn`、npm 包 `@qodercn-ai/qoderclicn`、配置目录 `~/.qoder-cn`；**CLI2API 已统一抽象两个 region**（`qoder/home.go:76-95` 的 `RuntimeSpec`，`site: global|cn`，配置环境变量 `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR`）—— 这是很好的设计参考。

9. **官方文档中不存在 chat/completions 的公开文档**
   已全站 grep 219 页：官方**只**公开了 `openapi.qoder.sh`（鉴权/serviceToken）与 `api.qoder.com/api/v1/cloud/*`（Cloud Agents）、`/api/v1/forward/*`；**`api2-v2.qoder.sh/model/v1/chat/completions` 零文档**。
   → 本 provider 的 chat 层**必须依赖逆向情报**，这是不可消除的脆弱性。

10. **未解决的反常观察**
    - `api3.qoder.sh` 仍被官方列为需放通域名（说明域名活），但 `agent_chat_generation` 路径是否可用未知
    - QoderGateway 的 `parse_tool_calls_text` 文本兜底 vs CLI2API 无兜底的结构化映射 —— 两者矛盾，T2 才能定案
    - LINUX DO 那条「qoder 的反代都会中途被禁止无法使用」**至今无人回答**

---

## 附：证据落盘位置

| 内容 | 路径 |
|---|---|
| **官方文档站（219 页）** | `%TEMP%\qoder-docs\` |
| └ 全站索引 | `llms-com.txt` / `llms-cn.txt` / `_manifest.txt` / `_compact.txt` |
| └ Lite 退役公告 | `rn-lite-retire.md` |
| └ 模型表（CLI / IDE / CN） | `cli-model.md` / `ide-model-selector.md` / `cn-model.txt` |
| └ 错误码表 | `sdk-errors.md` |
| └ 模型目录 schema | `ca-models-list.md` |
| └ Cloud Agents 鉴权 | `en-cloud-agents-api-auth` |
| └ 定价 / Credits / 每日签到 | `pricing.md` / `credits.md` / `ev-100credits.md` |
| └ 官方论坛设备风控回复 | `forum-device-bind.txt` |
| └ 官方 FAQ 封禁条款 | `ide-common-issue-en` |
| └ SDK 全量参考 | `en-sdk-refs-typescript.txt`(182KB) / `en-sdk-refs-python.txt`(170KB) |
| **QoderGateway（全源码）** | `%TEMP%\qoder-gateway-research\` |
| └ 协议逆向文档（作者自著） | `docs\qoder-protocol-research.md` |
| └ 鉴权/签名/编码 | `src\qoder2api\auth.py` / `signature.py` / `encoding.py` |
| └ bridge / tokens / accounts / app / registrar | `src\qoder2api\*.py` |
| **CLI2API（关键源码）** | `%TEMP%\qoder-cli2api\` |
| └ 错误分类器（**最有价值**） | `internal__executor__classify.go` / `internal__executor__error.go` |
| └ chat payload 与响应字段 | `internal__providers__qoder__adapter.go` |
| └ 额度三池结构 | `internal__providers__qoder__quota.go` |
| └ 架构与启动（官方 CLI 包装） | `internal__providers__qoder__starter.go` / `worker.go` |
| └ 国际版/国内版抽象 | `internal__providers__qoder__home.go` |
| └ 工具调用转换 | `internal__translate__tools.go` |
| └ 思考档位归一化 | `internal__providers__reasoning.go` |
| └ 签到契约 | `internal__providers__checkin.go` / `internal__accounts__checkin.go` / `qoder/checkin.go` |
| └ README / 端点常量 | `README.md` / `internal__endpoint__routes.go` |
