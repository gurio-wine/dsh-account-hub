# 项目指令：dsh-account-hub

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 子代理路由

- **派发子代理一律不指定 provider / model / reasoning effort**：宿主已装插件自动选择（按 `~/.dsh` 的路由配置与可用性现算），本体手动指定会与该机制竞争并导致路由漂移。提示词里也不要写「用某模型」这类字样。
- 仅当自动选择插件失效、派发报「无可用供应商/模型」时才回退人工核实 `list_subagent_models` 并临时指定。

## 项目概述

本项目是 DeepSeek Harness 的插件 `dsh-account-hub`，提供华为云 CodeArts 浏览器登录与凭据管理，附带七个 LLM provider 路由：`codearts` / `buddy-cn`（腾讯 CodeBuddy 中国版）/ `buddy`（WorkBuddy 国际版）/ `lobsterai`（有道）/ `trae-cn`（字节 Trae 国内版）/ `qoder` 与 `qoder-cn`（Qoder 国际版/国内版两 region）。

- **同源关系**：`buddy-cn` 与 `buddy` 同源（差异收敛于 `src/product.ts` 的 `BuddyProduct`）；`lobsterai`、`trae-cn` 完全不同源、各自独立实现；`qoder` 两区同协议双 region、代码只有一份（差异在 `QoderProduct`）。
- **命名**：显示名与 provider id 一律按产品品牌，旧命名 `buddy`/`workbuddy` 已作废（迁移见 README「provider 改名与数据迁移」）。
- **TraeWork**：该路径 provider 已整体移除，`trae-cn` 一条通道即可覆盖。
- Account Hub 设置页（`plugin-src/client/account-hub.js`）提供多账号管理、限流自动切换与积分入口；七个 provider 都有面板。
- 各 provider 协议细节见 `docs/agents/providers-*.md`。

## 技术栈与约束

- **Node.js** `^22.19.0 || >=24.0.0`；**依赖管理** pnpm workspace（作为 DSH 插件安装）；**代码风格**与 `@deepseek-ai/dsh` 主仓库保持一致。
- **构建**：宿主侧 TypeScript `tsc` → `lib/`；客户端 bundle `esbuild`（`plugin-src/client/build.mjs`）→ `lib/client/account-hub.js`。两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证 git 安装时两侧产物齐全。⚠️ **`build:client` 末尾含产物顶层求值冒烟（stub require）** —— 模板字符串求值类错误构建即炸，而 `plugin-src/` 不在 typecheck/test 视野内，**这道闸是客户端 bundle 的唯一语义防线，勿删**。
- **测试**：Vitest。`pnpm test` 为单元测试（快速、无网络、全部 mock）；`pnpm test:e2e:*` 按 provider 分列（如 `test:e2e:codearts` / `buddy-cn` / `buddy-claim`），**均有闸门、默认全部跳过**，哪些会消耗模型积分见 `tests/e2e/README.md`。测试文件按约定放 `tests/unit/` 与 `tests/e2e/`。

## 项目结构

`src/` 宿主 TS；`plugin-src/client/` 客户端源码（esbuild）；`lib/` 编译产物（gitignore）；`tests/unit/` 单测；`cordis.patch.yml` bundle 补丁；`tsconfig.json` / `vitest.config.ts` 配置。

## DSH 插件契约

- 插件注入 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务；凭据存储用 `ctx.credentials`，ref 遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 用 `ctx.llm.registerProvider()` 注册；命令用 `ctx.commands.register()`；插件配置用 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

所有 `ctx.xxxAuth` 服务（`codeartsAuth` / `buddyCnAuth` / `buddyAuth` / `lobsteraiAuth` / `traeCnAuth` / `qoderAuth` / `qoderCnAuth`）遵循统一接口 `login(options?)` / `status()` / `refresh()` / `logout()`；qoder 两区 login 有两种形态（无参浏览器设备流 / `{ pat }` PAT 粘贴），两条路写同一种凭据形态。

- 服务名默认由产品 id 派生（`${product.id}Auth`）；带连字符的 id 必须显式声明 `serviceName`（见「LLM Provider 约定」）。
- `refreshAccountCredential(refName)` 供账号卡片「刷新」按钮；**不要**用 `refresh()` 刷池内账号（它读写该 provider 的默认单凭据 ref，会刷错凭据）。
- 登录必须两段式：`account.create` 同步返回 `loginUrl`、打开动作归客户端、后台第二段补全或移除占位 —— 细节见 `docs/agents/account-hub-storage.md`；Qoder 设备流的专属差异见 `docs/agents/providers-qoder.md`。
- 各 provider 登录/续期机制差异见 README.md 与 `docs/agents/providers-*.md`。

## 账号池与模型列表（概览）

- 账号池持久层在 storage 域 `dsh_account_hub`（降级矩阵：storage → 旧 settings 回退 → 内存），凭据本体存 `ctx.credentials`；数组顺序即候选优先级；限流后自动换号。细节见 `docs/agents/account-hub-storage.md`。
- `disabledModels` 黑名单制：只影响播报、不影响路由；无可用账号时 `listModels` 返回 `[]` 隐藏整个分组。细节见 `docs/agents/account-hub-storage.md`。
- 上下文窗口档位（context tiers）：注册表经 `registerAccountHubRpc` 第 10 实参注入；buddy 系与 qoder 两区有远端档位数据源，trae-cn 走 agent 组目录，lobsterai 无档位源。细节见 `docs/agents/account-hub-storage.md` 与各 providers-*.md。

## LLM Provider 约定

- **provider 名称**：`codearts` / `buddy-cn` / `buddy` / `lobsterai` / `trae-cn` / `qoder` / `qoder-cn`；端点 OpenAI 兼容；provider 在 `ctx.llm` 上注册，配置在 profile 中可选。
- **服务名规则**：默认 `${product.id}Auth`，但 id 带连字符时机械派生不合法、必须显式声明 `serviceName`（`traeCnAuth` / `buddyCnAuth` / `qoderCnAuth`）；`qoder` 无连字符、`qoderAuth` 本身合法，是**刻意不声明**的反面判据，不要为形态统一把两行写成一样。
- **请求签名/鉴权概览**：`codearts` 华为云 `SDK-HMAC-SHA256`；`buddy-cn`/`buddy` Bearer + `X-Product-Code`；`lobsterai` Bearer + `X-LobsterAI-Client-*`（无签名）；`trae-cn` `Cloud-IDE-JWT` + 同值 `X-Ide-Token`/`X-Cloudide-Token`。
- **适配器**：`buddy-cn` 与 `buddy` 共用 `BuddyAdapter`（差异全由 `BuddyProduct` 配置驱动，新增同源产品只需加配置并注册实例）；`lobsterai` 用独立 `LobsteraiAdapter`（`LobsteraiProduct` 与 `BuddyProduct` 平行而非继承）。
- **红线**：**出站协议值不随 provider id / 显示名变化**（`productCode` / `attributionName` / `platform` / `endpoint` / UA 等出站身份标识，改名时一个字符都不能动），细节见 `docs/agents/providers-buddy.md`。

## 积分（签到与余额）（概览）

- 五套**协议完全不同**的实现、各自独立；每日签到由 `buddy-cn` / `lobsterai` / `trae-cn` / `codearts` / `qoder` / `qoder-cn` 六个面板提供（Qoder 两区同协议、共用一份实现，故实现仍是五套）；积分余额覆盖全部七个 provider，与签到彼此独立。
- 能力判定唯一真相源：`plugin-src/client/credits-capabilities.js`（两项能力彼此独立、默认关闭、门控在发请求之前）。
- Qoder 国际版签到需要设备身份头，来源是官方客户端 `runtime-info.exe` 的运行时调用；CN 不需要，细节见 `docs/agents/providers-qoder.md`。
- 跨 provider 共同约定与能力矩阵见 `docs/agents/credits.md`；各 provider 签到/余额端点与判据见对应 `docs/agents/providers-*.md`。

## CodeArts 上下文窗口（概览）

远端 `context_window` 优先、静态表 `CONTEXT_WINDOWS` 兜底，细节见 `docs/agents/codearts-context-window.md`。

## 常见开发任务

新增功能：`src/`（客户端 UI 改 `plugin-src/client/`）实现 → 补单测 → `pnpm build:all` → `pnpm test` → 更新文档；调试用 `pnpm typecheck`。单测覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络。

## 详细文档

- `docs/agents/providers-buddy.md` — Buddy 系协议细节（上下文窗口口径 / max_tokens / 出站协议值 / 签到 / 余额）
- `docs/agents/providers-lobsterai.md` — LobsterAI 协议细节（登录互斥 / 签名 / 签到三步 / 余额端点）
- `docs/agents/providers-trae-cn.md` — Trae CN 协议细节（SOLO 通道 / 错误码 / 工具调用帧 / 目录五道过滤 / 档位 / 签到与余额）
- `docs/agents/providers-qoder.md` — Qoder 两区协议细节（设备流 / 字节闸 / wasm 签名链 / CN region / 签到）
- `docs/agents/qoder-undetermined-investigation.md` — Qoder 系「全部账号无法判定」真机调查（三缺陷叠加 / 缺 `Cosy-ClientType` / 国际版缺设备身份头 / `CLAIMED` 误判 / 积分去向）
- `docs/agents/providers-codearts.md` — CodeArts 协议细节（SDK-HMAC-SHA256 签名 / 签到四步 / 余额）
- `docs/agents/credits.md` — 积分领域（五套共同约定 / 能力判定矩阵）
- `docs/agents/auto-checkin-design.md` — 自动签到设计方案（状态存储 / sweep 编排 / RPC 契约 / 触发时机 / 共享互斥）
- `docs/agents/account-hub-storage.md` — 账号池存储 / 两段式登录 / 模型黑名单 / 档位注册表 / 映射入口
- `docs/agents/auto-route-runtime.md` — 自动路由运行面（聚合适配器 / 转发与降级 / 注册生命周期 / 隐藏门控 / 重试处置）
- `docs/agents/codearts-context-window.md` — CodeArts 上下文窗口接线
- `docs/agents/reasoning-loop-guard.md` — 思考死循环止损（判据与阈值 / 五适配器接线 / 止损动作 / 开关 / 调参约束）
- `docs/agents/course-leak-strip.md` — 行首 `课` / `course` 泄漏清洗（判据 / 两处落点 / 非幂等接线 / 开关）