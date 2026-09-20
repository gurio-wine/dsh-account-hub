# Qoder Provider 接入实现计划

> 状态：**已实现**（2026-09-21）。六步全部落地，各自的提交：
> 步骤 1 `fc7a5a7`（产品配置 + 认证）、步骤 2 `33b9bf4`（适配器 + 错误分类）、
> 步骤 3 `e729783`（模型目录）、步骤 4 `dd8402c`（额度余额）、
> 步骤 5 `0a4deda`（Account Hub 面板 + PAT 表单）、**步骤 6 = 本次提交**
> （宿主接线 + 测试 + 文档收尾；该提交的 hash 无法写进它自己携带的文件里，
> 故此处只记「本次提交」，前五步的 hash 照实列出）。
> ⚠️ **真机验收（PAT 实测聊天 / 额度）尚未进行** —— 见 §3 风险登记。
> 调研依据：`docs/qoder-integration-research.md` + T1/T2/T3 三轮真机实测（PAT 由用户提供，报告内脱敏）。
> 本文是**实现任务清单**；协议证据与决策依据见调研文档，本文只记「怎么做」。

## 0. 协议定案摘要（实现必须遵守的事实）

| 项 | 定案 |
|---|---|
| provider id | `qoder`（无连字符，服务名机械派生 `qoderAuth` 合法，无需显式声明） |
| 登录形态 | **PAT 粘贴**（不走浏览器 OAuth）。PAT 签发页 `qoder.com/account/integrations`，前缀 `pt-`，官方明示不自动刷新 |
| 凭据结构 | **PAT（长期存储）+ jt-（运行时换取缓存，24h）+ jrt-（可选持久化，48h）** |
| 换令牌端点 | `POST https://openapi.qoder.sh/api/v1/jobToken/exchange`，body `{"personal_token":"<PAT>"}`（⚠️ 键名必须 snake_case，camelCase 回 400） |
| chat 端点 | `POST https://api2-v2.qoder.sh/model/v1/chat/completions`，`Authorization: Bearer jt-…`（PAT 直打必 401，令牌形态类拒绝；`api.qoder.com/v1` 已否证） |
| chat body | 标准 OpenAI 格式，messages/tools 原样透传；带 `"metadata":{"context":{"client_type":"qodercli"}}`；UA `qoder/1.1.16` |
| 模型目录端点 | `GET https://api.qoder.com/api/v1/cloud/models` + `Bearer <PAT>`（⚠️ 目录只认 PAT，quota 只认 jt-，两处凭据不同源） |
| 额度端点 | `GET https://openapi.qoder.sh/api/v2/quota/usage` + `Bearer jt-…` |
| 响应形态 | 标准 OpenAI；`model` 字段回显传入值，真实模型在 `raw_usage.model`；`usage` 无 credits 字段 |
| 签到 | **不做**（`dailyCheckin: false`）。官方每日 100 Credits 只能桌面 App 手动领，无公开 API |
| 能力矩阵 | `balance: true, dailyCheckin: false` |
| jt 刷新 | `POST openapi.qoder.sh/api/v1/jobToken/refresh` body `{"refresh_token":"jrt-…"}`（CLI2API 情报，未实测；exchange 随时可重打，主路径靠重换取） |

### 流式与错误分类事实（T3 实测矩阵）

- **两类错误，边界 = 网关层 vs 上游模型层**：网关错（401/402/400）一律 **pre-stream**（HTTP 非 200 + `application/json`，流里一个字没有）；上游 body 错（坏 role、空 messages）是 **200 + 流内 error 帧**
- **两类都绝不出 `[DONE]`** → `[DONE]` 是唯一成功收尾判据；没等到 `[DONE]` 的流不许当优雅结束
- **`stream:true` 会把 400 变成 200 流内错误**（同一坏 body 非流式 400、流式 200）→ 流式路径必须实现流内错误解析，不能只看状态码
- 流内 error 帧带 `event: error` 行 + `data:` 行，规范 SSE 累积器可干净处理（勘误 v2：不需要无前缀兜底）
- 错误体 schema 三处不一致：402 `code` 是**数字** `116` 且文本在 `error` 字段；401 **无 code**（`{"error":"unauthorized"}`）；400 `provider_error` 是包装码，真码在字符串化的 `details` 里；同一错误可能发 2 遍（两个不同 chatcmpl id，只取首帧）
- 401 两种可区分：`TOKEN_INVALID`/`invalid apikey`（类型错）vs `TOKEN_EXPIRE`/`token is not active`（真失效）
- 402 语义污染：quota=0 时无效模型名也回 402 `code:116`（网关先扣费检查）→ **402 不得硬编码为「换号可救」**；配合额度查询结果二次判别
- **成功流 usage 帧裸 LF 注入**（真实缺陷，7 次成功流 5 次中招）：大 usage 帧中段被插入一个 0x0A；恢复规则（3/3 验证）：data 行与紧随的下一行（非空、非 `data:` 开头）**无分隔符直接拼接**（`L1+L2` OK，`L1+"\n"+L2` FAIL）

### 工具调用事实（T2 实测）

- 标准结构化 `tool_calls`（非流式 `message.tool_calls`、流式 `delta.tool_calls` 增量分片），arguments 为 JSON 字符串 → **协议层无障碍**
- ⚠️ forced `tool_choice` 时 `finish_reason` 是 `"stop"` 而非 `"tool_calls"`（auto 才是）→ 聚合逻辑看 delta 本身，不靠 finish_reason

### 模型目录事实（T1 实测，17 项快照）

- `id` 是短 key（`qmodel_38max` / `qfmodel` / `gmodel` / `dmodel` / `mmodel`…），**不是 tier 名**（`auto`/`efficient` 作为 model 值回 402）
- 全表返回 + `is_enabled` 标记（本账号仅 2 项 true）→ 过滤策略：**目录请求成功时只播报 `is_enabled` 项**；`lite` 不在官方目录但实测可用（免费遗留路径）→ 作为静态兜底项保留
- `efforts`（`low/medium/high/xhigh/max`）+ `default_effort` 是权威思考档位来源；`display_name` 直接可用
- roster 浮动（与官方 CLI 表/国内版表都不同）→ **绝不硬编码全表**，只做小静态兜底
- `default_context_window` 有 272000 这种非整值 → 不当常量

## 1. 任务拆分（单步派发，每步确认后派下一步）

照 trae-cn 成熟模式，每步一个子代理、交付一个模块 + 单测：

| 步 | 交付物 | 核心文件 | 要点 |
|---|---|---|---|
| 1 | 产品配置 + 认证 | `src/qoder-product.ts`、`src/qoder-auth.ts` | PAT 粘贴式登录；exchange 换 jt + 内存/凭据缓存（24h 提前 1h 刷新）；`refresh()` = 重打 exchange；logout 清 jt 缓存 |
| 2 | LLM 适配器 | `src/qoder-adapter.ts`、`src/qoder-errors.ts` | OpenAI 同构透传 + 流式解析器（[DONE] 判据、流内 error、usage LF 兜底、tool_calls 聚合）+ 错误分类表 |
| 3 | 模型目录 | `src/qoder-models.ts` | 动态目录（PAT 直连）+ 静态兜底（含 lite）+ efforts 档位接线 |
| 4 | 额度余额 | `src/qoder-credits.ts` | 三池容缺解析（userQuota 必有；addOnQuota/orgResourcePackage 可选；主池尽但包有余=未耗尽）；`roundCredits` |
| 5 | Hub 面板 | `plugin-src/client/jet-hub.js`、`credits-capabilities.js` | PROVIDERS 第七条 + 能力矩阵 `balance:true, dailyCheckin:false` + **PAT 粘贴表单**（新形态，替代浏览器登录按钮） |
| 6 | 测试接线 + 收尾 | `src/index.ts`、`tests/unit/*`、`README.md` | `ctx.llm.registerProvider` 注册、`makeCredentialResolver`/`makeAccountPicker` 接线、单测全绿、`pnpm build:all`、README 章节 |

## 2. 关键设计决策

1. **PAT 粘贴是新登录形态**：现有六 provider 全是浏览器 OAuth。`account.create` 对 qoder 改为接收 PAT 文本（RPC 载荷加 `pat` 字段），同步完成 exchange 验证 + 账号落池（无两段式——PAT 验证是即时请求，不是 10 分钟浏览器等待，`login.poll` 按凭据可解析判定天然兼容）
2. **jt 生命周期归适配器管**：凭据里只存 PAT（+可选 jrt）；jt 是运行时缓存，exchange 失败按 401 类处理（PAT 失效→提示重新粘贴）
3. **错误分类表**（T3 矩阵直接翻译）：
   - `402 + code:116` → 额度类，先查 quota 二次判别（未超额则当模型路由错处理，直报），超额 → 换号
   - `401 {"error":"unauthorized"}`（chat）→ jt 过期：静默重换 exchange 一次再试；仍 401 → 凭据失效
   - quota 端点 401 `TOKEN_EXPIRE` vs `TOKEN_INVALID` → 分别映射「jt 过期（重换）」与「PAT 类型错（重新粘贴）」
   - 流内 error 帧 → 直报业务码（`invalid_parameter_error` / `invalid_model_error` / `provider_error`+二次解 details），不转优雅关闭
   - 无 `[DONE]` 结束 → 报「Stream ended without [DONE]」，不静默成功
4. **目录只播 `is_enabled` 项**（拉取成功时）；失败回退静态表（目录 17 项里选静态兜底：`qmodel_38max`/`qfmodel` + `lite`，roster 浮动只影响动态部分）
5. **多账号池**：多 PAT = 多账号，`QODER_ACCOUNT_*` 凭据 ref；换号逻辑复用 AccountPool（402 额度类才换）
6. **思考档位**：目录 `efforts` 透传（DSH reasoning effort → OpenAI 风格 `reasoning_effort` 字段下发——T1/T2 未验证该字段是否生效，首版**透传不拦截**，真机验收再定；与 trae-cn 的「未验证不盲改」同则）

## 3. 风险登记

- 模型名错误真码被 402 遮蔽（需 quota>0 账号复测，不阻塞）
- 429/上游 5xx/上下文超限形态未知（未知码直报原则兜底）
- `reasoning_effort` 字段是否生效未验证（透传策略）
- jt refresh 端点未实测（主路径 exchange 重打已够用）
- ⚠️ **`quotaVerdict` 在多账号下查的是「当前解析到的那个账号」**（步骤 6 接线已知边界）：
  该注入口由步骤 2 定型为 `(classification) => Promise<QoderQuotaVerdict | undefined>` ——
  **回调拿不到「刚才是哪个账号失败的」**。故接线按「适配器被调用时的当前凭据」实现：
  回调内部走与 `stream()` 开头**同一条**凭据解析路径取凭据（都不传 model）。
  单账号下完全正确；多账号下，若首个账号因额度耗尽失败、适配器换到第二个账号后
  再次收到 402，第二次判别查的仍是**第一个**账号的额度。**影响面仅限
  「是否把第二次 402 判成额度耗尽」**：请求本身、换号循环、冷却标记与错误文案
  都按分类结果走，不因这一点而错。修法是让回调带凭据（需改
  `src/qoder-adapter.ts` 的注入口签名），留待真机验收时按实际表现决定。
- ⚠️ **真机验收未做**：本步只保证类型、单测、构建与产物冒烟全绿；PAT 实测聊天
  与额度查询由用户自行在 DSH 里加 PAT 验证（`reasoning_effort` 是否生效亦在其中）。
