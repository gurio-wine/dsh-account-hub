# dsh-account-hub

deepseek-harness 插件：执行 CodeArts（华为云）登录流程，默认走新式 IAM OAuth
（portal `/authorize` 授权 → 本地 `/oauth/callback` 回调 → STS token 端点换取含
`refresh_token` 的凭据），到期前静默续期，无需再次打开浏览器；旧 ticket 流程保留
为显式回退（`flow: 'ticket'`）。插件还注册一个 `codearts` LLM provider 路由，使该
凭证可直接用于 CodeArts 后端模型调用。

此外插件内置另外**六**个 provider 路由：

- **buddy-cn（Buddy CN）** — 见 [Buddy CN provider](#buddy-cn-provider)；
  另支持「一键领取积分」（每日签到）。
- **buddy（Buddy）** — 见 [Buddy provider](#buddy-provider)。
- **lobsterai（LobsterAI）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。
- **trae-cn（Trae CN）** — 见
  [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)；
  后端已实现签到与积分余额（面板显示**通用积分池**），前端能力矩阵登记见该节说明。
- **qoder（Qoder）** — 见 [Qoder provider](#qoder-providerqoder)；
  登录形态是**浏览器设备流**（2026-09-21 起 PAT 粘贴形态已从 UI 移除）；
  不支持「一键领取积分」
  （该权益只能在 Qoder 桌面 App 里手动领取，服务端没有公开的签到端点）。
- **qoder-cn（Qoder CN）** — Qoder 的**国内版 region**（同协议、另一组 host，
  见 [Qoder provider](#qoder-providerqoder) 的「Qoder CN：第二个 region」）；
  登录形态与登录实现均与国际版共用，**账号池与 Credits 与国际版完全独立、令牌互不承认**；
  亦不支持「一键领取积分」（疑似有该权益，但**端点未知**，见能力矩阵说明）。

七个 provider 的 Account Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
是否出现在对话框的模型选择里（黑名单制，默认全部显示）——
见 [模型列表开关](#模型列表开关黑名单)。

## 仓库来源

本仓库是**独立维护**的 GitHub 仓库
（[gurio-wine/dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub)），
也是安装与升级的**唯一上游**。它的原始来源是 Gitee 上的
[iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)：
早期为镜像同步，现已脱离该仓库独立演进，功能与修复不再回传。谨向原始作者致谢。

本仓库并非 GitHub 意义上的 fork（不是从某个 GitHub 仓库 fork 出来的），两者是并行
的两个托管位置。本地检出若保留了 `upstream` 远端指向 Gitee，仅作为历史回溯通道，
**不要**把它当作升级来源，也不要把它的分支合并回来。

## 安装

该包尚未发布到 npm registry。提供两种安装方式：**git 仓库安装**（推荐，自动拉取
并构建）和**源码目录安装**（本地开发联调）。

### 方式一：从 git 仓库安装（推荐）

先在 profile 的 `pnpm-workspace.yaml` 中放行该包的 build 脚本
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-account-hub@git+https://github.com/gurio-wine/dsh-account-hub.git: true
```

再用 `dsh plugin add` 从 GitHub 拉取并安装：

```sh
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

`add` 以 `git+https` 方式安装，pnpm 会运行 `prepare` 脚本自动构建 `lib/`，无需
手动 `pnpm build`。每次升级时重新 `add` 即可拉取最新版本并重建。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再用 `dsh plugin install` 将本地检出安装为 pnpm `link:`
依赖（指向本目录）：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`，否则 dsh 启动时
> 报 `ERR_MODULE_NOT_FOUND: ... dsh-account-hub/lib/index.js`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 从 dsh-codearts-auth 迁移

本插件原名 `dsh-codearts-auth`，设置页品牌为旧名，现统一更名为
`dsh-account-hub`（设置页显示 "Account Hub"）。**只有品牌层改名**，代码标识符与
存储键一律未动，因此迁移不丢数据。

已安装旧包的用户按两步走：

```sh
dsh plugin --profile <name> remove dsh-codearts-auth
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

别忘了同步 profile 的 `pnpm-workspace.yaml`：`allowBuilds` 里旧包的整行替换为新包名
（即上面「方式一」那段）。GitHub 对旧地址有自动重定向，但仍建议直接写新地址。

> **账号与模型开关不会丢。** 账号索引与 `disabledModels` 模型开关存在 settings 的
> `jet-hub` 命名空间里，凭据存在 `ctx.credentials` 中（ref 如
> `CODEARTS_ACCESS_TOKEN` / `BUDDY_CN_ACCOUNT_XXX`）。这些**都是代码标识符，改名时刻意
> 保持原样** —— 变的只有包名与界面文案，所以重装后账号池、登录状态与显示列表设置
> 直接续用，无需重新登录。
>
> 上面这条说的是**包名**改名（`dsh-codearts-auth` → `dsh-account-hub`）。
> 2026-09-18 的 **provider** 改名是另一回事，它是一次**破坏性变更**，落在持久化
> 数据上，因此插件启动时**自动迁移**（见「provider 改名与数据迁移」一节）。

### provider 改名与数据迁移（2026-09-18）

**这是与上面那节性质完全不同的一次改名**：上面只动包名与界面文案，标识符一律
不变；而这次动的是 **provider 的 id 与显示名**，落在 `settings.yaml` 与
`.credentials.yaml` 里，属于**破坏性变更**。改名后的对应关系：

| 新显示名 | 新 id | 原显示名 | 原 id |
|---|---|---|---|
| **Buddy CN** | `buddy-cn` | CodeBuddy (腾讯) | `buddy` |
| **Buddy** | `buddy` | WorkBuddy (国际版) | `workbuddy` |
| **Codearts** | `codearts` | CodeArts (华为云) | 不变 |
| **LobsterAI** | `lobsterai` | LobsterAI (有道) | 不变 |
| **Trae CN** | `trae-cn` | Trae CN (字节跳动) | 不变 |

**两个腾讯系产品的 id 互换**，所以升级时数据必须跟着搬。插件启动时自动执行
一次性迁移（`src/provider-rename-migration.ts`），覆盖三处持久化数据：

- 账号条目的 `provider` / `credentialRef` / `id`（`settings.yaml` 的 `jet-hub` 命名空间）；
- `disabledModels` 模型开关的 provider 键；
- 凭据 ref 名（`.credentials.yaml`）：`BUDDY_*` → `BUDDY_CN_*`，
  `WORKBUDDY_*` → `BUDDY_*`。

迁移完成后写入 `schemaVersion: 1`，再次启动即整体跳过，**幂等可重入**。中途若
出现凭据冲突（目标 ref 已存在且值不同）或写入失败，该条账号**整体保留原样**并
记 `error` 日志，不会留下「账号指向新 ref、凭据还在旧 ref」的半迁移状态。

> **从旧版本升级后若发现账号不见了，重启一次即可。** 迁移是异步
> （fire-and-forget）执行的，不阻断插件启动；某一轮没跑完或遇到只读凭据源时，
> 数据保持原状，下次启动重试。
>
> **旧会话的模型路由需要手动重选一次。** 会话里记住的 provider 名是**历史字面量**
> —— 迁移只搬账号池与凭据，不会改写已存盘的会话记录。升级后若某个旧会话仍指向
> 旧 provider 名（如旧 `workbuddy`，语义已翻转为 `buddy-cn`/`buddy`），
> 在该会话里**重新选择一次模型**即可恢复。
>
> **出站协议值一律未改**（这是刻意的）：`X-Product-Code` 仍为
> `codebuddy` / `workbuddy`，`platform` 仍为 `ide` / `workbuddy-ai`，
> User-Agent 品牌字样与两个域名（`copilot.tencent.com` / `www.workbuddy.ai`）
> 全部照旧。腾讯后台按这些值归因用量，跟着显示名改会让账单归属错乱 ——
> **改名只发生在插件自己的 id / 显示名 / 服务名 / 设置命名空间 / 默认凭据 ref 上**。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

- `/codearts-login` — 在浏览器中打开华为云 portal 授权页；授权后，插件经本地
  `/oauth/callback` 回调收取 `code`，并由 STS token 端点换取含 `refresh_token` 的
  AK/SK/SecurityToken 凭据。该命令是**阻塞式**的（等到用户在浏览器完成授权）；
  Account Hub 设置页走的是两段式非阻塞路径（见下）。
- `/codearts-status` — 显示 `configured`、`source`、`expiresAt`、
  `refreshable` 以及最新的 `refreshError`。
- `/codearts-refresh` — 手动静默续期凭据（refresh_token 换取；无 refresh_token 时提示重新登录）。
- 编程式调用：`ctx.codeartsAuth.login()`、`ctx.codeartsAuth.status()`、
  `ctx.codeartsAuth.refresh()`、`ctx.codeartsAuth.logout()`。

### 登录是两段式非阻塞的（2026-09 起）

Account Hub 的 **Codearts 面板**点「+ 新建账号」时，RPC **不再**在请求内等待浏览器
登录。原实现（`account.create` 里 `await codearts.login(...)`）最长阻塞 180 秒，
等它返回时触发点击的**用户手势早已过期** —— 客户端拿到 `loginUrl` 再开窗会被
浏览器弹窗拦截，客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉。现在的形态与
CodeBuddy 系（现 Buddy 系）、LobsterAI 完全一致（见 [AGENTS.md](AGENTS.md) 的「登录必须两段式」）：

1. **第一段（同步返回）**：`CodeArtsAuth.prepareLogin()` → `prepareCodeartsLogin()`
   起本地回调服务器（端口 ≥10000）、生成 PKCE/DPoP，返回 `{port, loginUrl,
   awaitCredential, cancel}`；`pool.addAccount` 写入**占位条目**
   （`refreshable: false`、无 `expiresAt`），随后立即 `return {ok: true, value:
   {accountId, loginUrl}}`。**流程内不打开浏览器** —— 打开动作归客户端，
   宿主再开一次会变成两个标签页。
2. **第二段（后台）**：后台 `awaitCredential()` 完成后由
   `CodeArtsAuth.persistLoginResult()` 写凭据并补全占位账号
   （`expiresAt` / `refreshable`）；失败则 `pool.removeAccount` 移除占位，
   避免留下无凭据的幽灵账号。
3. **轮询结算**：客户端每秒调 `login.poll`，宿主按 `accountId` 回
   `{done, error?}`。**失败是终态**：第二段失败时先登记失败原因、再删占位
   （`jet-hub-rpc.ts` 的 `loginFailures` 表），poll 回 `{done:true, error}`
   并**读到即清**；成功仍是 `{done:true, success:true}`，未完成是
   `{done:false}`。三者严格区分 —— 否则「失败」会退化成「永远未完成」，
   客户端白等 5 分钟且窗口不收（用户报障的残留标签页）。
   `login.poll` 还会**预检 `credentialRef` 合法性**（`isCredentialRefName`，
   与 `credentialRef()` 同一个 `REF_PATTERN`），非法时回
   `{done:true, error:'invalid-credential-ref'}` 而不是让 `credentialRef()`
   抛 TypeError 被包成 `handler-failed`（客户端会把它当网络抖动吞掉）。
   客户端三条终态路径（成功 / 失败 / 5 分钟超时）共用同一个收尾动作
   （`finishPolling`：停表 + 收窗 + 刷新账号列表）。

配套约束：

- **provider 级互斥**：同一时间只允许一个进行中的 Codearts 登录会话，重复点击返回
  `{ok:false, error:'login-in-progress'}`（判别联合，**不抛异常** —— 抛异常会被 RPC
  统一包装成 `jet-hub/handler-failed`，客户端就拿不到可判别的错误码）。
  不复用旧会话（会让一份凭据被多个占位 accountId 共享），也不静默新建
  （每次点击都会堆一个 loopback 端口到 180 秒超时）。互斥采用**同步占位**
  （`'preparing'` 槽位）：判空与 listen 之间隔着 `generateDpopKeyPair()` 等 await，
  若只在 listen 成功后才登记，并发连发会全部通过判空、各起一个监听；
  listen 失败会**归还槽位**，否则此后所有登录都会被永久挡住。
- **`account.delete` 会 cancel 对应会话**（`jet-hub-rpc.ts` 的
  `pendingCodeartsLogins` 登记表）：否则旧会话会一直占着回调端口到超时，
  用户删掉占位账号后重新登录会一直拿到 `login-in-progress`。
- `login()` 保留为**阻塞式便捷封装**（`prepare` + `awaitCredential` 的串联），
  供 `/codearts-login` 命令与 e2e 探针等同步调用方使用，行为不变。
- 端口 ≥10000、180 秒等待预算、PKCE（`code_challenge_method=SHA-256`）、
  成功/失败 307 重定向到 portal 结果页、旧 `secret` 回退轮询全部保留原语义。

## LLM provider

插件在 `ctx.llm` 上注册了一个 `codearts` provider 路由（OpenAI 兼容端点
`https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`）。每个模型请求都使用
存储的 AK/SK/SecurityToken 按华为 `SDK-HMAC-SHA256` 方案签名，并附带
`Chat-Id`/`Session-Id` 请求头。默认广告的模型为 GLM-5.2、GLM-5.1、
GLM-5、GLM-5.3 Flash（`glm-5.3-flash`，1M 上下文）、盘古
openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
以及 DeepSeek V4 deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费
Tokens 福利）。
登录后在 dsh Models 页面选择该 provider 即可。

> 注 1：CodeArts Agent IDE 模型列表显示的 flash ID 为 `deepseek-v4-flash-0731`
> （带日期后缀），但后端实际注册的可用 ID 是 `deepseek-v4-flash`（无后缀）。
> 用 `deepseek-v4-flash-0731` 调用会返回 `InferHub.002002009.404 The model is
> not registered`，因此本插件只注册无后缀的 `deepseek-v4-flash`。
>
> 注 2：`glm-5.3-flash`（GLM-5.3 Flash，2026-08 加入，1M 上下文）是 benefit
> （免费额度）模型：其 chat 请求必须携带 `maas_type: benefit` 请求头且该头
> 参与 `SDK-HMAC-SHA256` 签名，否则后端返回 `InferHub.002002009.404 The model
> is not registered`。适配器已自动处理，无需手动配置。
> （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）

凭据来自默认的新式 IAM OAuth 流程（含 `refresh_token`）。请求发起时会解析最新
凭据，若已过期则先静默续期，再用新 AK/SK/SecurityToken 签名，无需重新打开浏览器。

除 `codearts` 外，插件另注册**六**个独立路由：`buddy-cn`（见
[Buddy CN provider](#buddy-cn-provider)）与 `buddy`（见
[Buddy provider](#buddy-provider)）两个 buddy 系路由、`lobsterai`
（见 [LobsterAI provider](#lobsterai-provider)）、`trae-cn`
（见 [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)）、
`qoder` 与 `qoder-cn`（Qoder 的**两个 region**，见
[Qoder provider](#qoder-providerqoder)）。
七者互不覆盖，可同时使用。

> ℹ️ **曾经的第八个路由（TraeWork 网页协议那条路径）已于 `47bd690` 整体移除**：
> 官方把 Work 侧模型合并进通用通道，`trae-cn` 一条通道即可覆盖（真机实拉动态目录
> 14 项，含原 Work 独有的 `kimi-k2.7-code` / `kimi-k2.6` 与新增 `step-5-preview`）。
> `disabledModels` 里可能残留该 provider 的旧键，**无人读取、无害**（按指示不迁移也不清理）。
>
> ⚠️ `qoder-cn` 与 `qoder` 是**两个 region 的两套账号**：令牌互不承认、
> 账号池与 Credits 各自独立
> （见 [Qoder CN：第二个 region](#qoder-cn第二个-region)）。

## 凭证

- Ref：`CODEARTS_ACCESS_TOKEN`（POSIX 标识符格式的凭证 ref）。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。
- `status()` 报告 `configured`、`source`、`expiresAt`、`refreshable` 和
  `refreshError`。

## 续期（refresh）

- 默认登录流程为**新式 IAM OAuth**（PKCE + DPoP）：portal `/authorize` 授权 → 本地
  `/oauth/callback` 回调收取 `code` → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
  换取含 `refresh_token` 的凭据。
- 凭据在过期前 1 小时静默续期（`getFirstRefreshTime` 语义：距过期 ≤1h 立即刷，
  否则 `now+1h` 叠加随机秒偏移），全程无浏览器、无人工操作。
- 刷新失败后 10 分钟重试（异常网络 1 分钟）；`refresh_token` 失效后停止续期并提示
  重新登录（原因会体现在 `status().refreshError` 中）。
- 旧 ticket 流程保留为显式回退：`/codearts-login` 默认走 OAuth；编程式调用
  `ctx.codeartsAuth.login({ flow: 'ticket' })`。ticket 凭据没有 `refresh_token`，
  其续期仍意味着重新运行浏览器登录流程。
- 手动续期：`/codearts-refresh` 或 `ctx.codeartsAuth.refresh()`。
- 续期定时器是 unref 的，在 `logout()` 和插件卸载时停止。
- 运行时依赖新增 `jose`（用于 DPoP JWS 签发，与 CodeArts Agent 插件实现一致）。

## 开发

- `pnpm test` — 单元测试（快速，无网络）。
- `pnpm test:e2e` — 针对华为线上端点的真实登录流程；需要在打开的浏览器中由人工
  点击授权按钮（续期为静默刷新，无需再次点击）。
- `pnpm typecheck`、`pnpm build:all`。

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`（生成 `.js`、`.d.ts` 和 source
  map）。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（Account Hub 设置页的客户端 bundle，由 `exports["./client"]`
  引用）。它**不在** `tsc` 的编译范围内，必须单独构建。
- `pnpm build:all` — 依次执行上面两步（`build` + `build:client`），是完整的构建。
- `pnpm typecheck` — 只做类型检查（`tsc --noEmit`），不产出文件，可在构建前快速
  验证。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。只执行 `pnpm build`
会漏掉客户端 bundle，dsh 启动时会因 `exports["./client"]` 指向的文件不存在而
加载失败（Account Hub 设置页不显示），请改用 `pnpm build:all`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 安装到 profile 之前先构建

详见「安装」小节。`dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:`
依赖运行 `prepare` 脚本，因此必须先 `pnpm build:all` 生成 `lib/`（含客户端
bundle）。

## 工作原理

默认登录流程（新式 IAM OAuth，PKCE + DPoP）：

1. 生成 PKCE 配对与 DPoP ES256 密钥对，并启动本地 `127.0.0.1` 回调服务器
   （端口 ≥10000）。
2. 构造 portal `/authorize` URL 并打开华为云授权页面（两段式下这一步由客户端
   在用户手势内完成）。
3. 授权后浏览器回调本地 `/oauth/callback`，携带授权码 `code`。
4. 向 STS token 端点（`sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）用
   `code` 换取含 `refresh_token` 的凭据 JSON，并存储到 `CODEARTS_ACCESS_TOKEN` 下。
5. 凭据到期前静默续期（见「续期（refresh）」），无需再次打开浏览器。

上述 1–2 步在代码中即 `prepareCodeartsLogin()`（第一段），4–5 步的落盘即
`persistLoginResult()`（第二段）；阻塞式 `runOAuthFlow()` / `login()` 只是
「第一段 → 打开浏览器 → 第二段」的串联。

旧 ticket 流程保留为显式回退（编程式调用 `ctx.codeartsAuth.login({ flow: 'ticket' })`）：
生成 `ticket_id`，打开 `devcloud.cn-north-4.huaweicloud.com/doer/redirect` 认证页，
回调后轮询 snap-manager ticket 端点（120 × 1 秒）获取临时凭证；此类凭据没有
`refresh_token`，其续期仍意味着重新运行浏览器登录流程。

## Buddy CN provider

独立路由 `buddy-cn`（**Buddy CN**，原 CodeBuddy 中国版；OpenAI 兼容端点
`https://copilot.tencent.com/v2/chat/completions`），Bearer `access_token` 鉴权。
cordis 服务名是显式指定的 `ctx.buddyCnAuth` —— 带连字符的 id 机械派生会得到
非标识符风格的 `buddy-cnAuth`，与 `trae-cn` 是同一先例。

登录采用 external-link-v2 轮询式（与 CodeArts 的本地回调服务器不同，Buddy CN
不起本地端口，而是轮询后端 API）：

1. `POST /v2/plugin/auth/state?platform=ide` → 取得 `state` 与 `authUrl`。
2. 打开浏览器到 `https://www.codebuddy.cn/login/?platform=ide&state=...`。
3. 轮询 `GET /v2/plugin/auth/token?state=...`（1 秒间隔、5 分钟超时）→ 令牌；
   错误码 `11217` 表示 token 未就绪，继续轮询。
4. 轮询 `GET /v2/plugin/login/account?state=...` → 账户信息；错误码 `12151`
   表示账户信息未就绪，继续轮询。
5. 续期：`POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 头提交
   refresh_token。

- **登录入口：Account Hub 设置页的 Buddy CN 面板**（支持多账号与账号池自动切换）。
  已不再注册斜杠命令 —— 设置面板已覆盖登录、状态查看与续期，命令式入口冗余。
- 编程式调用：`ctx.buddyCnAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 模型列表：以内置的产品目录为准（`src/product.ts` 的 `fallbackModels`），
  远端 `GET /v3/config` 可用时优先采用其元数据。
- **上下文窗口声明值取「最大档」**：`min(maxInputTokens, contextWindow.supportedLengths`
  最大档`)`，远端缺字段时才用 `fallbackModels` 的静态兜底（同为**最大档**口径）。
  ⚠️ 上游成对下发的 `contextWindow: {defaultLength, supportedLengths}` 里，
  **`defaultLength` 是官方客户端的 UI 默认档、不是服务端硬限** —— 2026-09-21 钳制二分
  实测（`buddy-cn` / `glm-5.3`，同一请求只改 token 数）：320,307 / 500,507 / 900,910 /
  1,000,970 token **全部 HTTP 200**，1.2M 才回 400 `code:11115`。故按最大档声明
  （≈1M）；本插件**不发送任何档位字段**（出站请求体一个字节都不变），但 Account Hub
  的「显示列表」里**可以选择更小的档位**（`supportedLengths` 的那些值，见
  [上下文窗口档位选择](#上下文窗口档位选择)）。
  详见 [AGENTS.md](AGENTS.md) 的「Buddy 系 —— 上下文窗口取值口径」。
- 请求头：除 `Authorization: Bearer` 外，还需 `X-Domain`、`X-Product`、
  `X-Product-Code` 以及伪装为 `CodeBuddyIDE/1.106.1` 的 `User-Agent`。
- 凭据 ref：单账号 `BUDDY_CN_ACCESS_TOKEN`，多账号 `BUDDY_CN_ACCOUNT_<UUID_SHORT>`；
  值为含 `access_token` / `refresh_token` / `expires_at` 的 JSON 字符串。

> **流式工具调用 id 稳定性**：Buddy CN 仅首个工具调用分片携带真实 id
> （`chatcmpl-tool-xxx`），后续参数分片只有 `index`。适配器按 index 缓存并沿用
> 真实 id（缺失时回退 `call_{index}`），保证同一工具的所有分片 id 一致——否则
> 跨轮次（每轮都从 `call_0` 重新编号）会把 `tool/result` 配对到错误的历史条目。

## Buddy provider

独立路由 `buddy`（**Buddy**，原 WorkBuddy 国际版 / WorkBuddy AI），与
[Buddy CN provider](#buddy-cn-provider) **同源**：共用同一 CLI 内核与同一认证协议
（cli-external-link 轮询式），Bearer `access_token` 鉴权。差异收敛在
`src/product.ts` 的产品配置里：

| 项 | Buddy CN（中国版） | Buddy（国际版） |
|---|---|---|
| `endpoint` | `https://copilot.tencent.com` | **`https://www.workbuddy.ai`** |
| `platform` | `ide` | **`workbuddy-ai`** |
| 登录 URL 附加参数 | 无 | **`version` / `loginSessionId`** |
| `pluginVersion` | — | `5.5.2` |

**协议值不随 id 改名**：本路由的 id 已从 `workbuddy` 改为 `buddy`，但它出站的
`X-Product-Code` **仍是 `workbuddy`**、`X-Product` / `X-IDE-Name` / `X-IDE-Type`
**仍是 `WorkBuddy`**、`platform` 仍是 `workbuddy-ai` —— 腾讯后台按这些值归因用量。

**模型列表不能与 Buddy CN 共用**：两者的路径与响应解析完全相同
（`GET /v3/config` → `data.data.models` / `data.data.agents`），差异只来自
`endpoint` —— 不同区域的后端返回不同模型池（中国版含 glm / hy / deepseek 系，
国际版含 claude / gpt / gemini / kimi 系）。因此 `endpoint` 必须随产品切换，
不能被当成全局常量。

登录流程与 Buddy CN 一致（`auth/state` → 浏览器授权 → 轮询 `auth/token` →
轮询 `login/account`），仅身份标识与端点按上表区分。`X-Domain` 随 `apiDomain`
切换为 `www.workbuddy.ai`。

**没有每日签到积分**：国际版后端不提供**签到**接口（内核中只有
`/v2/billing/meter/get-dosage-notify` 用量通知），因此 Account Hub 的 Buddy
面板**不显示「一键领取积分」按钮**；签到领取在 Buddy CN 面板完成。

> **但积分余额（Credits Balance）可以查。** 签到与余额是两项独立能力：国际版
> 确实没有签到，但**有**积分余额查询接口，见下节。不要因为"没有签到"就推断
> 也查不到余额。

- **登录入口：Account Hub 设置页的 Buddy 面板**（支持多账号与账号池自动切换）。
  同样不注册斜杠命令。
- 编程式调用：`ctx.buddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 凭据 ref：
  - 单账号：`BUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
    `expires_at` 的 JSON 字符串（与 `BUDDY_CN_ACCESS_TOKEN` 同构）。
  - 多账号：`BUDDY_ACCOUNT_<UUID_SHORT>`，由 Account Hub 设置页「+ 新建账号」
    登录时自动生成并登记到账号池；每条账号记录带 `provider: 'buddy'`，
    与 Buddy CN 的 `BUDDY_CN_ACCOUNT_*` 相互隔离，不会串用凭据或限流标记。
  - ⚠️ 迁移期注意：`BUDDY_ACCOUNT_*` 这个前缀**历史上属于中国版**。升级时由
    `src/provider-rename-migration.ts` 按「中国版先让位、国际版后搬入」的两趟
    顺序腾空并复用，见「provider 改名与数据迁移」一节。
- **从中国版升级**：本插件**更早**的版本曾把当时名为 `workbuddy` 的这条路由指向
  中国版端点（`copilot.tencent.com`；该路由现名 `buddy`）。启动时会自动清理凭据
  `domain` 与当前 `apiDomain` 不符的旧账号（这类凭据在新端点必然失败），
  清理结果记入日志，请在 Account Hub 重新登录。
- 续期：与 Buddy CN 共用同一套机制，插件启动后每 30 分钟对可续期账号静默刷新
  （`refresh_token` 经 `X-Refresh-Token` 头提交），无需重新打开浏览器。
- 请求头、模型列表拉取与流式工具调用 id 处理均与 Buddy CN 一致，详见上一节。
- **上下文窗口同为「最大档」口径**，但 ⚠️ **国际版没有实测证据**（账号余额不足，
  无法做钳制二分），是按同协议形态推定的；CN 侧有 `glm-5.3` 的单变量实测。风险论证：
  万一真实窗口低于声明值，撞 `11115` 会被映射成 `CONTEXT_WINDOW_EXCEEDED`，
  由宿主自动压缩重试兜底；反之按默认档声明会**每次 240K 就丢历史**。国际版
  **8 个「1M 且远端不下发 `contextWindow` 字段」**的模型是单档模型，
  其 `maxInputTokens` 即服务窗口，静态兜底表按 **1M** 保留、不砍。
  远端目录可用时，**带档位对**（`contextWindow.supportedLengths`）的模型与 CN 同款
  可在「显示列表」里选档，见
  [上下文窗口档位选择](#上下文窗口档位选择)。

### 与 Account Hub 设置页的关系

Account Hub（设置页）的账号面板按 provider 分组展示，Buddy 是其中一栏：

- 面板提供账号列表、新建账号（浏览器登录入池）、启用/停用、删除，以及「重测 /
  重测所有 / 重置 / 重置所有」限流标记操作，行为与 Buddy CN 面板一致，但
  只操作 `provider: 'buddy'` 的账号。
- 账号卡片展示 credentialRef、有效期（含「自动续期」标记）、限流状态与**积分
  余额**（见下节）。「一键领取积分」按钮**仅 Buddy CN 面板提供**，结果来自
  RPC 端点 `credits.claimAll`（实现见 `src/jet-hub-rpc.ts`，签到客户端见
  `src/credits.ts`）。
- 后端另实现了 `credits.status`（查询某 provider 下全部启用账号的签到状态），
  但**前端尚无消费者**：`plugin-src/client/jet-hub.js` 只调用 `credits.claimAll`，
  `credits.status` 目前仅供外部脚本或直接 RPC 调用使用。
- 对应 LLM provider 的设置命名空间为 `llm-buddy`（Buddy CN 是 `llm-buddy-cn`，
  两者由 `llm-${product.id}` 派生）。

### 模型列表开关（黑名单）

Account Hub 面板标题栏的「**显示列表**」按钮展开该 provider 的**全部模型**，每个模型
后面带一个开关，**默认打开**。关闭后该模型不再出现在对话框的模型选择列表里。

采用**黑名单制**：只有被显式关闭的模型会被隐藏，未记录的模型（含服务端后续新增的
模型）一律默认显示。这与白名单制的关键差别在于——新模型上线时无需任何配置就会
自动出现在选择器里，不会被静默挡在门外。

- 开关状态持久化在 `jet-hub` settings 命名空间的 `disabledModels` 字段
  （形如 `{ 'buddy-cn': { 'glm-5.2': true } }`），与账号池同处一个 namespace。
- 模型列表来自 `ctx.llm.listModels()`，**即对话框模型选择器读取的同一份目录**
  （会话控制器的 `buildModelCatalog`），因此设置页展示的模型与实际可选集合始终
  一致，不会出现「设置里有、选择器里没有」的错位。
- 过滤发生在适配器的 `listModels`（`src/llm-adapter.ts` / `src/buddy-adapter.ts` /
  `src/lobsterai-adapter.ts`），
  每次调用都直接读账号池的黑名单，因此**改开关后下一轮模型目录刷新即生效**，
  无需重启或重建适配器。
- **只影响目录播报，不改变路由能力**：被关闭的模型仍可被 `resolveModel` 解析、
  仍能正常收发请求。这是 DSH 对 `listModels` 的约定（目录是建议性的，缺省不构成
  请求拒绝）。好处是已有会话若正用着某个被关闭的模型，不会被强制中断。
- 开关按 provider 隔离，Codearts / Buddy CN / Buddy / LobsterAI / Trae CN /
  Qoder / Qoder CN **七份黑名单互不影响**。改名迁移会把这七份的 provider 键
  一并搬到新命名，见「provider 改名与数据迁移」。
- 相关 RPC 端点：`model.list`（列出模型并回填 `disabled`）、`model.setDisabled`
  （打开/关闭单个模型），实现见 `src/jet-hub-rpc.ts`。

#### 显示列表的回填机制与过滤

「显示列表」弹窗的模型集合**不只是**适配器播报的那份目录，而是
`llm.listModels()` **并上**黑名单里的历史键 —— 由 `model.list` 端点完成（见
`src/jet-hub-rpc.ts`）。这套「并集回填」有两个方向都必须正确：

**为什么要回填。** 适配器的 `listModels` 会实时剔除黑名单命中的模型，因此
`llm.listModels()` 的结果里**没有**被关闭的模型。若设置页直接用它渲染，被关掉的
模型会连同它的开关一起消失，用户**再也无法重新打开**（只能手工编辑
`settings.yaml`）。所以端点把「黑名单里为 `true`、却已不在目录中」的 id 补回列表
并标记为 `disabled`；对话框模型选择器读的仍是过滤后的 `llm.listModels()`，
**可见性行为完全不变**。回填是必要的：模型临时下线但黑名单仍留记录时，
用户仍应能重新打开它。

**垃圾键为什么不回填。** 回填的候选是**黑名单的键名**，而黑名单是历史累积的 ——
在目录过滤规则上线**之前**，列表里还列着账号私有 BYOK（`custom_model_*`）、
客户端自隐项（`is_invisible_to_user:true`）与内部 agent 项，用户当时关掉它们，
键就永久落进了 `disabledModels`。实测（2026-09-20）：目录 13 项 **∪** 黑名单 30 个
历史键 = 弹窗 **43 行**，其中 14 个 `custom_model_*` —— 而目录侧这 13 项里
custom / invisible 各为 0，两边自相矛盾。更麻烦的是副作用：这些键已在黑名单里，
用户点开关只会在**同一批键上**增删，列表永远清不掉这批僵尸行。

故回填侧先过一道**与目录同源**的垃圾判定（`isTraeCnJunkModelId`，
`src/trae-cn-models.ts`）：`custom_model_` 前缀、内部 agent 项（点名 + 形态）、
实测的 8 项 invisible 点名清单。判定按 **id 形态**，只服务 `trae-cn` 这一个 provider
（已移除的 TraeWork 路径与它同属一个 Trae 账号体系、僵尸键长得一样，故判定对两者都成立）。
**其它 provider 不套这道过滤**：Buddy 系 / LobsterAI / Codearts 的黑名单语义没变，
套上只会让一个恰好长成 `xxx_agent` 的真实模型无法被重新打开。

**顺手清尸。** `model.list` 还会把命中垃圾判定的键从黑名单里**真正剔除**并写回
settings（逐个走 `AccountPool.setModelDisabled(id, false)`，即「读 → 改 → 整体
replace」，因此账号列表与数据版本号一并携带，不会被写坏）。这样僵尸键不会永远
留在配置文件里 —— 只过滤不清理的话，每次开面板都要再判一遍，且用户换回旧版本
插件时它们会重新冒出来。清理**一次性**：清完之后黑名单里无垃圾键，后续刷新
设置页**零写入**（有测试钉死这一点）。**正常**被关闭的模型哪怕暂时不在目录里也
**一律保留**，只删被垃圾判定点名的键。

**回填行与目录行在窗口档位上等同（2026-09-21 修复）。** 回填行除 `disabled: true`
与 `name = id`（拿不到原始展示名）外，**与目录行带同一组窗口字段**（`contextWindow` /
`maxContextWindow` / `contextTiers` / `contextBudget`）。判据只有一条：**档位数据来自
适配器目录（`contextTiers`），与用户的显示开关无关** —— 关掉一个模型只是让它从对话框
选择器里消失，它在目录里的档位一字未变；而 `model.setContextBudget` 的校验读的
也正是那份目录，所以关闭状态下改档本就该生效。早前只在 `models.map(...)` 那一支加
窗口字段，回填行（恰恰就是被关闭的那些）一条都不带 ⇒ 用户报障「**为什么只有开启后
才能选上下文**」：关掉模型想顺手改档时，档位列整个消失。**两个方向都不报错**，
只能靠断言钉死 —— 见 `tests/unit/jet-hub-rpc.spec.ts` 的「被关闭的模型（回填行）
照样带窗口档位」与「关闭状态下设置档位照常生效」两条。

相关常量与判据集中在 `src/trae-cn-models.ts`
（`TRAE_CN_INVISIBLE_MODEL_IDS` / `isTraeCnJunkModelId`），测试见
`tests/unit/jet-hub-rpc.spec.ts` 的「黑名单并集：垃圾键不回填」与
`tests/unit/trae-cn-adapter.spec.ts` 的「垃圾 id 判定」两组。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**支持范围**覆盖六个 provider、四套端点，语义一致（⚠️ **Qoder 系的国际版与国内版
是两个 provider、两条 host，但用的是同一套查询实现**，故端点数不变）：

- **Buddy 系（`buddy-cn` / `buddy` 通用，仅 baseURL 随 `product.endpoint`
  切换）**：

  ```
  POST /v2/billing/meter/get-user-resource    body {}
  ```

- **LobsterAI**：

  ```
  GET /api/user/profile-summary    → data.totalCreditsRemaining
  ```

  不要用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分，实测某账号
  `profile-summary` 有 5297.72 而 `quota` 只有 300）。

- **Trae CN**：

  ```
  POST /trae/api/v2/pay/web_user_ent_usage    body {"require_usage":true}
  ```

  响应里的礼包按 `available_endpoint` **分池**（0=通用积分、1=Work 积分），
  而**Trae CN 面板只显示通用池**（本插件走的 IDE 对话消耗的就是它，
  也就是该 provider 实际能花的钱；Work 池只有 TraeWork 网页/桌面版能花，本插件已无那条路径）
  —— 显示的是**单数字**，界面上不出现「通用」「Work」字样，资源包列表也
  只含本池的包。选池在 `src/jet-hub-rpc.ts` 的 `credits.balances` trae-cn 分支里
  **内联 `TRAE_CN_POOL_UNIVERSAL`**（历史上有过一层「面板 → 显示池」的映射函数，
  已随 TraeWork 路径一并删除；`TRAE_CN_POOL_WORK` 常量本身仍保留）。
  **不要**用 `ug/activity/info` 的活动口径：实测它写「200 work 积分」而实际到账
  150 通用积分，是口径陷阱。详见 [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)
  的「签到与积分余额」。

- **Qoder**：

  ```
  GET https://openapi.qoder.sh/api/v2/quota/usage    → 三池 remaining 之和
  ```

  ⚠️ **只认 `jt-`**（job token）：拿 PAT 直接打这个端点回 401 `TOKEN_EXPIRE`，
  故查询前由 `QoderAuth` 负责换取并缓存 jt（详见
  [Qoder provider](#qoder-providerqoder) 的「端点」与「额度余额」）。

  响应是**三池**结构：`userQuota`（必有）、`addOnQuota`、`orgResourcePackage`
  （后两池**本账号缺席**，解析**容缺**）。**每个池只有一个 `remaining` 数字，
  响应里没有包名字段** —— 资源包名取**池类型**，中文名分别为「主额度」/
  「加量包」/「资源包」。余额 = 三池 `remaining` 之和（缺席按 0、负数 clamp、
  两位小数规整）。**主池耗尽 ≠ 额度耗尽**：只要加量包或资源包里还有余额，
  这个账号就还能用。`expiredTotal` 恒为 0（quota 端点只在账号级给一个
  `expiresAt`，池本身没有失效字段）。

  ⚠️ **两个 region 各查各的端点**：`qoder` 打 `openapi.qoder.sh`、`qoder-cn` 打
  **`openapi.qoder.com.cn`**，走的是同一条解析路径（`fetchQoderCreditBalance`
  按传入的 `product` 现算 host）。**CN 侧实测只有两池**（`userQuota` +
  `addOnQuota`，`orgResourcePackage` 键整个不存在）—— 三池解析器**天然兼容**
  （缺席按 0），故 CN 面板零分支、零特判。两区的余额**互不相通**（各自账号、
  各自额度），不存在「合并显示」这回事。

「余额为 0」与「查不到」严格区分：失败时 `balance` 为 `null` 并带 `error`，
卡片显示原因而非 0。**这一条在 Qoder 上尤其要紧**：额度端点 401 靠
`TOKEN_EXPIRE` / `TOKEN_INVALID` 文案分型（分别对应「重换 jt」与「重新粘贴
PAT」），而「三池全为 0」是一个**成功的查询结果**（`total: 0`），不是失败。

> **Trae CN 的前端已登记。** 三个积分端点的 provider 分发在
> `src/trae-cn-credits.ts` + `src/jet-hub-rpc.ts`，客户端一侧两件事都已落地：
> 1. `plugin-src/client/credits-capabilities.js` 登记了 `trae-cn`（`balance` ✓、
>    `dailyCheckin` ✓），`PROVIDERS` 同步加入该 tab —— 面板因此显示「积分」行、
>    「刷新积分」与「一键领取积分」按钮；
> 2. `CreditBalanceRow` 只渲染**一个数字**加本池的资源包明细。它不做任何池判断
>    —— 「显示哪个池」的决定全在宿主侧，组件的输入与其余 provider 逐字段同构，
>    由 `tests/unit/jet-hub-credit-balance-row.spec.ts` 用整树深比较守住（含
>    「喂进旧的双池字段也不多渲染一段」）。
>
> ✅ 宿主侧接线已完成（`47f253f`）：`account.create` / `account.refresh` /
> `account-probe.ts` 三处的 `trae-cn` 分支与 `registerJetHubRpc` 的 `traeCn`
> 实例均已就位，Trae CN 面板可以新建账号、刷新凭据与重测限流标记。

**CodeArts 不支持**：它是华为云账号体系，没有上述任何一条计费接口。因此 CodeArts
面板**不显示「积分」行，也不显示「刷新积分」按钮**，且不会发起
`credits.balances` 请求。这一点由 `plugin-src/client/credits-capabilities.js`
的能力矩阵在**请求前**判定，而非等后端返回错误再吞掉。

> 历史缺陷：早期客户端在面板挂载时对所有 provider 无条件调用
> `credits.balances`，于是每次打开 CodeArts 面板都会在控制台报
> `unsupported provider: codearts`，并把每个账号卡片的「积分」渲染成
> 「查询失败」。修法是不发起该请求——后端 `productById()` 的拒绝是正确的
> 契约行为，不该被当作运行时故障展示。

**查询与「显示哪个池」是两件事，别把面板 id 当池键用**：`credits.balances` 里
账号查询走 `poolProviderFor()`（今天恒等），**显示池**则在 trae-cn 分支里内联
`TRAE_CN_POOL_UNIVERSAL` 传给 `fetchTraeCnCreditBalance` 的第三个实参。历史上这两个
方向各有一个映射函数（查账号一个、选显示池一个），后者已随 TraeWork 路径一并删除；
今天恒等只是「恰好等价」，**不要依赖这个巧合**去合并两件事 —— 拿池键去查账号会让面板
一片空白。

### 一键领取积分（每日签到）

**当前由 Buddy CN、LobsterAI 与 Trae CN 三个面板提供**该按钮。签到在本插件里
共有**三套互不相通的实现**（Buddy CN / LobsterAI / Trae CN，协议、端点、幂等
判据全不同，各自独立成文件）；三者的客户端能力登记均已落地，故三个面板都显示
该按钮。Codearts 是华为云账号体系不参与；Buddy（国际版）后端没有签到接口，
故其面板不显示；**Qoder 的每日
100 Credits 只能在 Qoder 桌面 App 里手动领取** —— 官方没有公开的签到端点，
故其面板也不显示该按钮。详见「积分余额」一节末尾的说明。

在 Account Hub 对应面板标题栏点击「**一键领取积分**」，插件会对该面板下
**全部账号**顺序执行每日签到领取：

> **含已停用账号。** 停用只影响账号池的自动选择与限流切换，不改变账号本身
> 是否已签到——用户点「一键领取」时期望所有账号都尝试一遍。

**Buddy CN（两步）**：

1. 先查签到活动状态（`POST /v2/billing/meter/checkin-activity-status`）；
2. 活动未开启或今日已签到则跳过领取请求，只报告状态；
3. 否则调用领取端点（`POST /v2/billing/meter/daily-checkin`）领取当日积分。

**LobsterAI（三步，见 `src/lobsterai-credits.ts`）**：

1. 查活动槽位（`GET /api/client-activities/slot`，带固定的
   `placement` / `containerApiVersion` / `platform` 参数）；
2. 查活动上下文（`GET /api/client-activities/{code}/context`），
   读 `claimedToday` 与 `actions` 决定是否可领；
3. 领取（`POST /api/client-activities/{code}/actions/check_in`，
   请求带客户端幂等键 `idempotencyKey`）。

> LobsterAI 的 `clientVersion` 是签到**必填**参数，由插件动态拉取
> （`api-overmind.youdao.com` 的更新接口，缓存 12 小时）；
> 拉取失败时回退内置兜底版本并在日志告警 —— 比参考实现的
> 「取不到就完全放弃签到」更宽容。

**Trae CN（两步 + 设备头，见 `src/trae-cn-credits.ts`）**：

1. 先查签到状态（`POST /trae/api/v2/ug/checkin_credits/status`，body
   `{"req_source":1}`）；
2. `checked_in` 为真则跳过领取（幂等短路），服务端显式 `enable:false`
   则报 `inactive`；
3. 否则调领取端点（`POST …/checkin_credits/claim`，同样 body
   `{"req_source":1}`）；命中可重试码时**退避重试**（见下）。

> **Trae 的签到必须带设备头**（与腾讯系、LobsterAI 都不同）：`x-device-id`
> 取自凭据里的 `checkin_device_id`（= **登录时生成并上报的 16 位设备号**），
> 另带 `x-device-type: windows` / `x-os-version` / `x-app-version`。claim 严格校验，
> 缺了直接回 `code:9004`。
>
> ⚠️ **T9 第三次修正（2026-09-20）**：T9 原结论「status / claim **都不校验设备号
> 形态**」（16 位十进制号 / `BoundDeviceID` / 空串全回 `code:0`）**观测成立但
> 推论错了** —— 不校验**形态** ≠ 不校验**设备**。服务端按 `x-device-id` 做
> **设备维度**签到记账，**认不认这台设备是真校验**。这就是 `9074` 的真根因，
> 详见下方「`9074` 的定性」小节。
>
> 幂等判据是 **`checked_in`（账号级当日）**，**不是** `did_checked_in`
> ——后者是设备级语义，换台设备仍为 false，拿它判幂等会对已领账号重复发请求。
> 无 auth 时服务端返回的是 **HTTP 200 + `code:1001` + `enable:false`**
> （不是 401），故判定一律**以 body `code` 为准**。
>
> ⚠️ **`x-os-version` 是运行时取值，不是常量**（2026-09-19 身份保真修复）：
> 反混淆真机客户端 `out/main.js` 的 claim 调用链后确认它发的是 **`os.version()`**
> 的返回值（本机 `Windows 10 Home`，带品牌名的市场营销名），而本插件原先硬编码
> `Windows 10.0.22631`（构建号）——**同一个插件对同一台机器报了两种操作系统身份**
> （登录 URL 的 `x_os_version` 一直是 `Windows 10 Home`）。现已改为运行时
> `node:os` 的 `os.version()`，两者形态统一。`x-app-version` 同步升到 `3.3.102`
> （原 `3.3.100` 落后两个补丁号）。

#### `9074` 的定性（2026-09-20 **第三次**修正）与头集对齐

**前两次定性均已作废**：

| 次序 | 定性 | 作废依据 |
|---|---|---|
| 第 1 次 | 瞬时频次软限流 | 三日取证：同账号 09-17/18/19 报错 **15 / 187 / 250 次**、**8 秒退避重放仍 `9074`** |
| 第 2 次 | 活动级当日容量/名额限制或账号侧风控 | 官方客户端**同期签成功**（同一活动、同一端点）；单变量 A/B 定位到真变量 |
| **第 3 次（现行）** | **设备身份**：服务端按 `x-device-id` 记设备维度签到状态，我们发的 `BoundDeviceID` **不被活动系统认可** | 决定性单变量隔离证据（见下） |

**决定性证据**（status 端点 A/B，2026-09-20）：我们**全套头不变** + **仅**把
`x-device-id` 换成官方客户端的 16 位号 → `did_checked_in` 由 `false` **翻转**为
`true`。其余头差异（我们多发的 `Accept` / `Origin` / `Referer` /
`X-Ide-Token` / `X-Cloudide-Token`）已证明**不影响**结果。

**根因结构**：官方登录 URL 的 `device_id` 与 claim 的 `x-device-id` 是**同一个
稳定 AHA 号**；本插件此前两者**不同源** —— 登录用现场随机号（用完即丢），
claim 却发 exchange 返回的 `BoundDeviceID`（14 位字母数字），构成
「与登录不匹配且每次登录都漂移的设备身份」。

**修复**：登录时那个 16 位号现在落盘进凭据的新字段 `checkin_device_id`，
签到头改用它（`traeCnCheckinDeviceId`）。

| 项 | 值 |
|---|---|
| 新字段 | `TraeCnCredential.checkin_device_id`（登录时生成、原样上报的那个 16 位号） |
| 签到头来源 | `traeCnCheckinDeviceId(credential)`：优先 `checkin_device_id`，缺失时**如实降级**为 `device_id`（`BoundDeviceID`） |
| **旧凭据** | 该号**从未被保存**、生成器是**随机**的（非机器特征派生）、服务端**也不回传**（exchange 只给 `BoundDeviceID`）→ **无法恢复**。这类凭据需**重新登录一次**才能修复签到（降级路径不伪造设备号，见下） |
| 明确不做 | 不拿 `machine_id` 折算假号、不读 Trae 客户端 `storage.json`（跨产品耦合，需用户拍板） |

> ⚠️ **待验证假设**：本次修复是「按证据最优假设落地 + 次日自然验证」——
> 定案当天官方已签到成功（幂等挡路），**claim 级**验证需等次日名额重置。
> 若明日仍 `9074`，后续路径是「读 Trae 客户端 AHA 设备号」（跨产品耦合，
> 需用户拍板），而不是再改形态。

**头集与官方逐头对齐**（bundle 反混淆，`out/main.js` @1696645 附近）：

```js
bb(){ const e={"Content-Type":"application/json"}; …; return e }   // 基础头
cb(e){ return { headers: this.mixAuthorization(this.bb(), e) } }   // + Authorization
fb(e){ e["x-device-id"] = this.S.guaranteedDeviceId;               // + 设备头
       i?.device_model && (e["x-device-brand"]=i.device_model), … }
```

官方全集 = **`Content-Type` + `Authorization: Cloud-IDE-JWT` + 设备头**，
**没有** `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token`。
本插件此前多发这 5 个，现已**删除**（单变量 A/B 已证明它们不影响结果，故这是
「对齐官方形态」而非「修复」）。

`x-device-brand` **刻意不发**：官方是**条件性**发（`device_model` 非空才发），
本插件拿不到硬件型号 —— 按既有约定不猜硬件型号，如实不发，而不是发空串冒充。

⚠️ **签到侧删除不影响 chat**：`traeCnAccessHeaders`（带 `Accept` 与两个多余
token 头）是 **chat（SOLO）与签到共用**的构造器；本次签到侧改为**自建**那三个头，
chat 侧（`traeCnSoloHeaders`）**继续用它，一行未动**。

**claim 段做有界退避重试**（第三次定性**不推翻**它：设备维度「当日已签」与
「名额释放」的边界在客户端不可见，保留的成本只有 4 秒）：

| 项 | 值 |
|---|---|
| 可重试码 | `9074` `4007` `3004`（`TRAE_CN_CLAIM_RETRY_CODES`） |
| 退避节奏 | 1s → 3s，**共 2 次**重试，累计等待 4s（`TRAE_CN_CLAIM_RETRY_DELAYS_MS`） |
| 重试范围 | **只有 claim（写）段**；status（读）段一次都不重试 |
| 失败返回 | 按**最后一次**尝试的 code / message / logid |
| **绝不重试** | `9004`（设备身份）、`1001`（凭据失效）—— 确定性失败 |
| 判据来源 | 复用 `src/trae-cn-errors.ts` 的 `TRAE_CN_BACKOFF_CODES`（两处定义必漂移，故共用一张表） |

`3003`（`MODEL_FAIL`）虽然在共享退避表里，但它是 **chat 通道**的基础设施码，
签到端点没有对应观测，**刻意不放进** `TRAE_CN_CLAIM_RETRY_CODES`。

`9074` **不记冷却徽章**（`recordsTraeCnCooldown(9074) === false`）：徽章语义是
「这个模型限流 N 分钟，等一会儿自动解除」，而设备身份**与模型无关、等多久都不会
自愈**（要么重新登录登记设备身份，要么走后续路径），记徽章是虚假信息。

`9074` 的用户文案因此指向**可执行动作**（`src/trae-cn-credits.ts` 的
`describeFailureCode`；前端 `formatClaimFailureLine` 仍会在末尾统一追加
`（code 9074）`，故本函数**不**重复写 code）：

> 当前参与用户太多，请稍后再试（服务端按 x-device-id 记设备维度签到状态；
> 若本账号是旧版凭据登录的，请重新登录一次以登记设备身份）

完成后按钮下方给出结果摘要（如「3 个账号领取成功（+300 积分），1 个今日已领取」）。
**有账号失败时，摘要行下面逐个失败账号各列一行**
「`<昵称或账号 id>`：`<服务端 message>`（code `<code>`）」—— 摘要里的
「1 个失败」只说有几个，服务端原文才说明**为什么**（风控限流 / 凭据失效 /
活动结束的处置完全不同）。`message` 为空时回退固定文案「领取失败」，
`code` 缺失时显示「未知」；成功、已领、活动未开启都不产生明细行。

**失败行末尾还会追加 `· logid <值>`**（当服务端给了时）——见下方
「失败诊断的 logid 透传」。

领取按账号隔离：单个账号凭据缺失、损坏或请求失败不会中断整批，只计入失败数。
完整结构化结果（`results[].outcome`）仍保留在 RPC 响应里，需要时也可查看日志。

几点实现约定：

- 领取是**顺序执行**的，避免并发触发风控；账号较多时需要等待片刻。
- **Buddy CN** 重复领取是幂等的：服务端返回 HTTP 400 + `code 10001`（「今天已签到，
  请明天再来」），插件把它识别为 `already-claimed` 而非失败。
- **LobsterAI** 的幂等由**客户端**保证：请求带 `idempotencyKey`，且领取前先读
  `context` 的 `claimedToday` 与 `actions`；重复领取会被识别为 `already-claimed`。
- Buddy CN 的状态查询用 `checkin-activity-status` 而非 `checkin-status`；后者返回
  占位数据（`active:false`、`checkin_dates:null`），会让人误判为活动未开启。
- Buddy CN 的请求**不需要** `X-Device-Token`（图灵盾）——已实测验证。
- LobsterAI 的签到**不需要签名**，只用 `Authorization: Bearer`；也**不发**腾讯系的
  `X-Domain` / `X-Product` / `X-Product-Code` 头。
- Trae CN 的签到**按官方头集只发 6 个头**：`Content-Type` +
  `Authorization: Cloud-IDE-JWT` + 设备头（`x-device-id` / `x-device-type` /
  `x-os-version` / `x-app-version`）；**不发** `Accept` / `Origin` / `Referer` /
  两个等值 token 头（官方 claim 没有），也**不发**任何腾讯系或 LobsterAI 归属头。

### 失败诊断的 logid 透传

失败时界面能给出「服务端原文 + 业务码」还不够：这两样只说「失败了、为什么」，
**说不出「这一次请求在服务端到底发生了什么」**。字节系网关为此在响应头返回
`x-tt-logid`（真机样本 `20260919142909176141A5DE791F4FE75E`），它是向服务端
追查单次请求的**唯一线索** —— 用户报障时给出这一串，服务端才查得到当时现场。

三段链路（缺一段这串就到不了用户眼前）：

| 段 | 位置 | 落点 |
|---|---|---|
| 1. 类型 | `src/credits.ts` | `ClaimOutcome` 失败分支新增**可选**字段 `logid?: string` |
| 2. 宿主 | `src/trae-cn-credits.ts` | `postJson` 读响应头 `x-tt-logid`（大小写不敏感、trim、空白视为没有），失败路径一路带到 `outcome.logid` |
| 3. 前端 | `plugin-src/client/jet-hub.js` | `formatClaimFailureLine` 在 logid 非空时追加 ` · logid <值>` |

几个刻意的取舍：

- **字段可选**：`ClaimOutcome` 是**三套协议共用**的判别联合，`logid` 必须可选，
  否则 Buddy 系与 LobsterAI 的 outcome 构造点全部要改（且它们根本没有这个值）。
- **只在失败分支**：成功路径不带该字段（没有追查需求）。
- **没有值就不带字段**，而不是 `logid: ''` —— 前端判「非空才追加」时两种都要挡住，
  但字段缺失能让「宿主压根没读到」与「读到了空串」在调试时区分开。
- **传输层失败（fetch 抛错）没有响应，因此没有 logid**：这是**如实缺失**，
  不是漏读 —— 请求根本没到服务端，也就没有服务端日志可查。
- **Buddy 系与 LobsterAI 未透传**：两条线的 `postJson` / `requestJson` 里
  `response` 对象虽然在手，但**没有任何已知的等价 logid 响应头**（未经真机确认）。
  按「不发明字段名」的既有约定**保持不动**；将来真机发现等价头再补。

想单独验证领取闭环（会真实改动账号当日签到状态）可运行
`pnpm test:e2e:buddy-claim` 或 `pnpm test:e2e:lobsterai-claim`，
说明见 `tests/e2e/README.md`。

## LobsterAI provider（有道龙虾）

独立路由 `lobsterai`（有道 **LobsterAI**），OpenAI 兼容端点
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，
Bearer `access_token` 鉴权。

该 provider 与腾讯系**协议完全不同**，因此实现是独立一套
（`src/lobsterai*.ts`），只共用架构模式（产品配置驱动、账号池、限流切换、
模型黑名单）。关键差异：

| 项 | Buddy 系（Buddy CN / Buddy） | LobsterAI |
|---|---|---|
| 登录方式 | 轮询后端 API（无本地服务器） | **本地回调服务器**收 `authCode` 后换 token |
| 登录/API 域名 | 同一个 `endpoint` | **两个域名**（portal 与 apiBase） |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` | 仅 `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` |
| 续期请求体 | 只带 `refreshToken`（走 `X-Refresh-Token` 头） | 还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid` |
| `clientVersion` | 编译期常量 | **运行时从第三方接口动态拉取** |
| 每日签到 | 两步（状态 + 领取） | **三步**（slot + context + check_in） |
| 图片输入 | 支持 | **不支持**（`inputModalities` 仅 `text`） |
| 思考等级 | 支持（按模型声明档位） | 支持（8/27 项声明档位，下发 `reasoning_effort`） |

- **登录入口：Account Hub 设置页的 LobsterAI 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.lobsteraiAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()` / `resolveClientVersion()`。
- **登录是两段式非阻塞的**（2026-09 起）：Account Hub 点「+ 新建账号」时，
  RPC 只做 `prepareLogin()`（起本地回调服务器）并**立即返回 `loginUrl`**，
  由客户端在同一用户手势内开窗；登录在后台完成后才写凭据并补全账号字段。
  `login()` 保留为阻塞式便捷封装（会等到用户在浏览器完成，最长 10 分钟），
  供 e2e 探针等同步调用方使用。同一时间只允许一个进行中的登录会话，
  重复点击会拿到 `login-in-progress`。
- 凭据 ref：
  - 单账号：`LOBSTERAI_ACCESS_TOKEN`；
  - 多账号：`LOBSTERAI_ACCOUNT_<UUID_SHORT>`，由 Account Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` 外，
  还持久化 `uuid` / `first_keyfrom` / `latest_keyfrom` 三个**身份字段** ——
  它们是续期请求体的必填项，丢失会导致静默续期失败、只能重新登录。
- 模型列表：远端 `GET /api/models/available` 优先（它是权威来源），
  失败时回退 `src/lobsterai-product.ts` 的 **27 个内置模型**（2026-09-19 真机照抄）。
  ⚠️ **响应形状是「统一信封 + `data` 直接为数组」**（`{code:0,msg,data:[…]}`），
  不是 `data.data` —— 早期实现按 `data.data` 取值，而信封校验又拒绝数组，
  于是**恒返回空数组**、永远回退内置表，这正是「选择器模型比产品少」的根因。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  **终态判定比参考实现更精确**：只有 HTTP 401/403 或业务码 40100/40101
  才判为 `refresh_token` 失效；网络抖动走可重试路径，不会误让用户重新登录。

### 思考档位（reasoning effort）：**已接线**（2026-09-19 真机取证）

- **档位来源**：远端模型目录的 `thinkingConfig.options[].level`（权威），
  逐字符照抄为 `reasoningEfforts`。真机 27 项中 **8 项**带 `thinkingConfig`
  （`deepseek-flash` / `deepseek-v4-pro` / `glm-5.3` 系 3 项 /
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / `glm-5.2`），
  档位均为 `high` / `max`；其余 19 项**不声明**（DSH 选择器里该行不渲染）。
- **下发字段名 `reasoning_effort`**，三条独立互证：
  1. **服务端行为**：只改该字段取值 —— `bogus-xyz` 与 `off` 返回 HTTP 500、
     `none` 返回 200 且无思考内容、`high`/`max` 返回 200 且带 `reasoning_content`。
     若服务端不解析该字段，未知取值不可能 500。
  2. **产品自身实现**：桌面端 `app.asar` 内 openclaw 的 `openai-completions`
     传输层在 `supportsReasoningEffort` 时写 `params.reasoning_effort`。
  3. `requestCapabilities: ['lobsterai-options-v1']` 对应的 `lobsterai_options`(v1)
     是**另一套**能力协商，不承载档位。
- ⚠️ **`off` 档被刻意剔除**：真机 `options` 里确有 `off`，但
  `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
  发 `reasoning_effort:"off"` 会 **HTTP 500**（3/3 复现），而 `glm-5.x` 返回 200
  —— 同一档位跨模型行为不一致。等价关闭语义是 `none`（实测 200 且零思考），
  但真机 `options` 里没有 `none`，故**不自行发明档位**。
- **不替上游补档**：不带该字段时服务端照样返回 `reasoning_content`
  （默认档由服务端决定），故**不**照搬 buddy 的「deepseek 系必须补档」逻辑。
- **上下文窗口**用真机 `contextWindow`（14 项 1,000,000 / 2 项 262,144 /
  2 项 256,000），真机为 `null` 的 9 项**不声明**（不编造）。

> **已知待实测项**（见 `docs/lobsterai-integration-plan.md` §7.2）：
> 图片输入与 `prompt_cache_key`。这些在实现里取了**保守默认**（不发送），
> 不会因未知而失败。
> ⚠️ 思考档的**「档位是否真的改变思考量」尚未做统计显著实验**：单次对比
> （`high`/`max` 的 `reasoning_content` 字符数）被采样噪声淹没
> （同档 3 次重复的离散度大于档位间差异），故只声明「字段被服务端真实消费」，
> 不声明「档位单调提升思考量」。

## Trae CN provider（字节跳动 Trae 国内版）

独立路由 `trae-cn`，上游 API 基址 `https://api.trae.cn`（登录 / 续期 / 签到 /
余额），**IDE 网关** `https://trae-api-cn.mchost.guru`（`/api/ide/*`，即对话），
登录门户 `https://www.trae.cn`。

该 provider 与既有各条线**均不同源**，因此实现是独立一套 `src/trae-cn*.ts`，
只共用架构模式（产品配置驱动、账号池、限流切换、模型黑名单）。

| 项 | 腾讯系 | LobsterAI | **Trae CN** |
|---|---|---|---|
| 登录 | 轮询后端 API | 本地回调收 `authCode` → exchange | **本地回调 + PKCE(S256)，回调投递 `authCodeInfo`** |
| 换 token | 轮询结果自带 | `authCode` 换 access+refresh | **`POST /trae/api/v3/oauth/ExchangeToken`（body 五字段）** |
| 续期 | `X-Refresh-Token` 头 | `POST /api/auth/refresh` | **`POST /cloudide/api/v3/trae/oauth/ExchangeToken`（body 四字段）** |
| 鉴权 | `Bearer` + 归属头 | `Bearer` | **`Cloud-IDE-JWT`**（另带两个等值 token 头） |

> ✅ **登录协议已用真机校准（2026-09-17）**。三条独立证据一致：官方 `main.js`
> 源码只读提取（`buildLoginUrl` / `gDe` / `exchangeTokenByAuthCode` /
> `_buildDeviceInfo`）、本机**成功**登录日志
> `%APPDATA%\Trae CN\logs\20260917T045023\main.log:136/139/140/141`（登录 URL /
> 回调载荷 / exchange 请求体 / 响应体，四段逐字）、与授权页 chunk 的行为解剖。
> 此前「回调 query 直接携带 refreshToken、无 authCode 交换」的假设**已被整体证伪**：
> 真机走 PKCE。那套假设曾让登录**静默失败**（页面停在「认证中」），根因见下。

### 登录机制（两段式 + PKCE）

第一段起本地 loopback 服务器（随机端口），构造登录 URL（**22 个参数，逐项对齐
真机** main.log:136）：

```
https://www.trae.cn/authorization?login_version=1&auth_from=trae&login_channel=native_ide
  &plugin_version=2.3.83560&auth_type=local&client_id=ono9krqynydwx5&redirect=0
  &login_trace_id={uuid}&auth_callback_url=http://127.0.0.1:{port}/authorize
  &machine_id={64hex}&device_id={16位十进制}&x_device_id=…&x_machine_id=…
  &x_device_brand=&x_device_type=windows&x_os_version=Windows%2010%20Home&x_env=
  &x_app_version=3.3.100&x_app_type=stable
  &code_challenge={43字符}&code_challenge_method=S256&channel_name=common
```

**三个曾经写错的点，每一个都能单独让登录静默失败**（页面既不报错也不回调，
只在首屏显示「认证中」——从外部看完全像网络问题）：

1. **`client_id` 是 snake_case**。授权页只读 `client_id`，读不到就停在「认证中」
   （这就是用户报障的根因）。`src/trae-cn-product.ts` 的注释曾把这条写反
   （「URL 用 `clientID`」），现已显式写死两个方向防回归。
2. **缺流程标记** `auth_type=local` / `login_channel=native_ide` /
   `login_version=1`：授权页认不出本地回调模式。
3. **缺 PKCE**（`code_challenge` + `code_challenge_method=S256`）：授权页
   不会走 AuthCode 分支，我们也就拿不到 `authCodeInfo`。
   方法名是 **`S256`**，不是 CodeArts 那套 `SHA-256`。

`machine_id` 是 **64 位 hex**（生成随机即可，服务端不校验其真实性）；
`device_id` 是 **16 位纯十进制**。
> ⚠️ 这里说的 `device_id` 是**登录 URL 的那个**（`generateTraeCnDeviceId`），
> 形态要求来自**登录握手**。它与签到头的 `x-device-id`（凭据里的
> `BoundDeviceID`，服务端**不校验形态**）是**两个位置** —— 详见「Trae CN provider」
> 章节的「设备号在本项目里是两个位置」。
> 早先把「形态不符」的后果记成「会触发 9074 风控」是**归因错误**：`9074` 的
> 成因与设备号形态无关（定性见「积分领取」章节的 `9074` 小节）。
`login_trace_id` 是本次登录的 UUID，回调把它原样带回，是「这次回调属于这次登录」的
现成凭证。

第二段：用户在浏览器完成授权后，登录页回调本地服务器，投递
**`authCodeInfo` + `userInfo` 两个双重编码的 JSON 字符串**（URL query 里再套一层
JSON），随后立即调交换端点换取 access token：

```
POST https://api.trae.cn/trae/api/v3/oauth/ExchangeToken
body {ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}   ← 五字段
```

⚠️ **交换端点有两套**，都在服务端并存，混用必 404：
登录用 `trae/api/v3/oauth/ExchangeToken`（鉴权靠 `AuthCode` + PKCE verifier，
body **不含** `ClientSecret` / `DeviceProof`）；续期用
`cloudide/api/v3/trae/oauth/ExchangeToken`（body 四字段，含 `ClientSecret`）。
真实响应是 `Result` 信封：

```json
{"ResponseMetadata":{…},
 "Result":{"BoundDeviceID":"wl2k1e2endpp32","DeviceBindStatus":"BOUND",
           "RefreshToken":"…","Token":"…","TokenExpireAt":1790801493459}}
```

`DeviceInfo` 是**真机 12 字段**（`DeviceID` / `MachineID` / `PlatformCode`
/ `DeviceType` / `DeviceName` / `DeviceModel` / `ClientVersion`
/ `DevicePublicKey` / `DeviceBrand` / `DeviceCPU` / `OSInfo` / `OSVersion`）。
本插件能如实提供的只有前四项与 `ClientVersion`/`OSInfo`/`OSVersion`；
`DeviceBrand`/`DeviceCPU`/`DeviceModel` **留空**（不猜硬件型号）。
`DevicePublicKey` 为 EC P-256 SPKI PEM，**每次登录现场生成**（官方 `vDe()`
同款）——曾因「该路径不发 DeviceProof」留空串，2026-09-18 真机实测 exchange
回 400 `10101 无效参数`，服务端至少校验其非空合法。
`DeviceName` 取主机名（真机取 `net.exe user` 的 Full Name）。

**回调分层**（畸形请求不得终结登录）：

| 请求 | 响应 | 对会话的影响 |
|---|---|---|
| 带 `authCodeInfo` / `refreshToken` 且交换成功 | **307 回跳授权页结果页**（`redirect=1`） | 结算（成功） |
| 带 `authCodeInfo` / `refreshToken` 但交换失败 | 500 纯文本 | 结算（交换失败） |
| `OPTIONS` 预检 | 204 + CORS 头 | 无 |
| 路径不符 | 404 + CORS 头 | 无 |
| 无载荷 / 畸形 | 400（不回显请求内容） | **无** —— 会话继续等真回调 |

早先实现把「解析不出凭据」当成登录失败（reject + 关端口），实测一次 500 探测
就终结了整个会话（端口关闭、占位账号被删），用户之后即使真的完成授权也无处回调。
现在只有「成功」「交换失败」「超时」「cancel」四种情况终结会话。

**成功回调是 307 回跳，不是静态 HTML**（对齐官方 `updateLocalCredential`）：
回调页停在 `127.0.0.1:{port}` 上自身无法离开（HTML 里没有 `window.close()`）。
弹窗被拦截、用户走面板内 `<a target="_blank">` 手动链接时客户端**没有窗口引用**，
`closeLoginWindow()` 够不到那张标签页 —— 307 回跳是唯一能把它送回
`www.trae.cn`（授权页渲染「登录成功」结果页）的机制。回跳目标是**同一条授权页
URL、只把 `redirect` 换成 `1`**（官方 `getLoginUrl(…, 1, …)` →
`buildLoginUrl` 里 `redirect=${r||0}` → `writeHead(307,{Location:a})` 逐字同构，
从本机 `%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\main.js` 提取）。
**失败路径维持 500 纯文本**：官方失败分支会带 errorCode/errorMsg 回跳，而本插件
的错误码体系与官方不通用，回跳一个渲染形态无法保证的页面比明确的 500 更难查。

回调服务器**带 CORS 头**（`Access-Control-Allow-Origin: *` 与 OPTIONS 处理）：
官方实现里回调是整页跳转、同源策略不介入，但我们的登录页由客户端开窗，
一旦回调走 `fetch`/预检路径，缺 CORS 头会让浏览器**静默丢弃响应**
（表现为「登录页显示成功、宿主一直在等」）。

**兼容分支**：授权页是双模的 —— URL 不带 `code_challenge` 时它靠浏览器 Cookie
会话自己调 `GetRefreshToken`，回调投递 `refreshToken`。本实现**主发 PKCE**
（与桌面客户端同款、不依赖「浏览器里已登录 trae.cn」这个额外前置），回调侧
**两条都收**并把走了哪条写进日志。走兼容分支时没有 exchange 响应、也就没有
`BoundDeviceID`，凭据的 `device_id` **如实留空** —— 绝不拿 `machine_id` 折算
一个假的 16 位号顶上（伪造设备身份比缺字段更坏，缺字段至少能被发现）。

`prepareLogin()` 立即返回 `loginUrl`，由客户端在同一用户手势内开窗；
`login()` 保留为阻塞式便捷封装。

### 凭据（五件套，按账号整体配对）

| 字段 | 说明 |
|---|---|
| `refresh_token` | 刷新令牌（续期端点的 `RefreshToken`） |
| `user_id` | 用户 ID（续期端点的 `UserID`，**必填**，续期缺它只能重新登录；来源是回调 `userInfo.UserID`） |
| `client_id` | OAuth 客户端 ID（`ono9krqynydwx5`） |
| `device_id` | **登录 exchange 返回的 `BoundDeviceID`**（真机 `wl2k1e2endpp32`，14 位字母数字）—— 服务端绑定标识，**不是**签到用的设备号 |
| `checkin_device_id` | **登录时生成并上报的 16 位设备号**（= 登录 URL 的 `device_id`）—— **签到头 `x-device-id` 的来源**，活动系统认的设备身份。旧凭据缺失时签到侧如实降级为 `device_id`，需重新登录才能修复 |
| `machine_id` | 机器号（64 位 hex；登录 URL 用） |

- 单账号 ref：`TRAE_CN_ACCESS_TOKEN`；多账号：`TRAE_CN_ACCOUNT_<SUFFIX>`；
- access token 用法：`Authorization: Cloud-IDE-JWT <access>`（**chat 侧**另带
  `X-Ide-Token` 与 `X-Cloudide-Token` 两个同值头；**签到侧按官方头集只发
  `Authorization`**）；
- 过期时间取 exchange 响应的 `TokenExpireAt`（服务端权威），缺失时回退 token 的 JWT `exp`；
- 续期：`POST /cloudide/api/v3/trae/oauth/ExchangeToken`，
  body `{ClientID, ClientSecret, RefreshToken, UserID}` —— `ClientSecret`
  实测为占位串 `"-"`，服务端不校验。
- 终态判定：HTTP 401/403 或响应缺 access token 才判 `refresh_token` 失效；
  网络抖动 / 5xx / 429 走可重试路径。

### 服务名与 provider 名的解耦

provider id 是 `trae-cn`（带连字符，对齐用户与生态叫法），但 cordis 服务名
**不是**机械派生的 `trae-cnAuth`，而是显式指定的 `ctx.traeCnAuth`
（见 `src/trae-cn-product.ts` 的 `serviceName`）。理由是带连字符的属性名
无法用点号语法访问，且与另外六个 provider 的命名风格不一致。

> ✅ **T5（回调 URL 形态）已用真机日志校准**（2026-09-17 main.log:136/139），
> 不再是候选表：参数名、编码形态、回调载荷结构（`authCodeInfo` / `userInfo`）
> 全部逐字确认。⚠️ `device_id` 的来源**分两路**（2026-09-20 修正）：
> 凭据的 `device_id` 来自 exchange 响应的 `BoundDeviceID`（服务端绑定标识），
> 而**签到头**用的是 `checkin_device_id`（登录 URL 那个 16 位号）。
> 旧的 `machine-id-fallback` 降级路径与 `aha` 来源标记已**删除**。
>
> ⚠️ **T9 第三次修正（2026-09-20）**：T9 原结论「status / claim **都不校验设备号
> 形态**」（16 位十进制号 / `BoundDeviceID` / 空串返回逐字节相同）**观测成立但
> 推论错了** —— 不校验**形态** ≠ 不校验**设备**。服务端按 `x-device-id` 做
> **设备维度**记账，**认不认这台设备是真校验**；这正是 `9074` 的真根因
> （见「积分领取」章节）。故签到头改用**登录时注册的 16 位号**
> （`checkin_device_id`），旧凭据如实降级为 `BoundDeviceID` 并需重新登录修复。
> **仍然成立**的一条：不要拿 `machine_id` 折算一个假的 16 位号顶上
> （伪造设备身份比缺字段更坏）。`code:9004` 因此意味着「服务端不认可我们构造的
> 设备**身份**」。

### 模型路由（LLM 适配器）

路由名 `trae-cn`，适配器 `TraeCnAdapter`（`src/trae-cn-adapter.ts`），
随插件启动注册到 `ctx.llm`，同时注册 `llm-trae-cn` settings namespace ——
后者**必须**存在，否则模型设置页会在 `refFor → deriveKeyRef(provider)` 处崩溃。
注意该 namespace 里的连字符是**正确**的：namespace 是字符串键而非 JS 标识符，
与 cordis 服务名（`traeCnAuth`）走的是两套命名规则。

**端点**：`POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`
（**SOLO 通道**，2026-09-19 迁移，见下），请求头
`Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` +
**网关全套头**（见下），`Accept: text/event-stream`；请求体是
`{messages, model, config_name, function, stream: true, tools?, reasoning_effort_level?}`，
**不发**任何腾讯系或 LobsterAI 归属头。

> ✅ **2026-09-19 端点迁移：`/api/ide/v1/chat` → `/api/agent/v3/llm_utils_chat`。**
>
> **病根（五轮真机取证定案）**：旧 `/api/ide/v1/chat` 是**旧 aiserver 通道**，
> 它的 `llm_raw_chat` 场景只认 **5 项旧池**，我方请求（`glm-5.3` 等新池模型）
> **恒回 `event:error {code:3003, "all models failed"}`**，历史零成功。
> 真实客户端的新池聊天走的是
> 「AhaRpc → ai-agent 子进程 → `harness.dll` → 原生出网」五段链路，
> 第三方无法复刻。
>
> **解法**：SOLO 通道 `/api/agent/v3/llm_utils_chat` **已用我方凭据实测走通**
> —— `glm-5.2` 流式正常、`glm-5.3` + tools 结构化调用全绿（HTTP 200 SSE）。
> host **不变**（仍是 `trae-api-cn.mchost.guru`），凭据不变，头集合差异已排除
> （网关对多余头宽容）。**决定成败的是端点 + body 的 `config_name` / `function`
> 两字段**。
>
> T6 那次「路径本来就对，错的是 host」的结论对**旧通道**仍然成立，但它解释不了
> 新池拿不到模型这件事 —— 两者是**两个不同层的问题**：T6 是 host 拼错，
> 本次是**端点选错了通道**。旧路径与候选表 `TRAE_CN_CHAT_PATH_CANDIDATES`
> 已**整体删除**（留着会让人以为 `/api/ide/v1/*` 仍是可选路径，它们对新池全部无效）。

**请求体的 SOLO 形态**（`buildTraeCnSoloBody`，逐字段实测）：

| 字段 | 说明 |
|---|---|
| `model` / `config_name` | **两个字段都要给，且恒等**（网关按 `config_name` 选配置） |
| `function` | **模型来源 function**：CN 区为 `solo_work_remote`（40 项）/ `solo_work_lite` |
| `messages[].content` | **`[{type:'text',text}]` 数组**（不是裸字符串） |
| `role:"developer"` | **归一为 `"system"`**（上游不认 developer） |
| assistant `tool_calls[].function` | **出站改名 `function_call`**（无 er；⚠️ **入站也是 `function_call`**，与出站同源 —— 早前记的「入站仍是 `function`」是错的，正是工具调用被丢弃的认知成因，见下「SSE 帧」） |
| `tools[].function.parameters` | **JSON 字符串**（传对象会 `4001 parameter type does not match binding data`） |
| `reasoning_effort_level` | **维持不变**（见下「思考档位」的说明） |

⚠️ **`function` 必须逐模型记住来源**：`glm-5.3` **只在 `solo_work_remote` 集里**，
写死 `solo_work_lite` 必回 `4001 param is invalid`（真机实测）。静态回退表的
11 项**全部**映射到 `solo_work_remote`（实测确认都在 remote 集内）；动态目录的
条目**自带**来源 function。

### ⚠️ `x-ide-version-code` 是 SOLO 网关的「选表键」（4001 的另一个根因）

**SOLO 网关按 `x-ide-version-code` 决定上游返回哪张模型配置表**。发旧 IDE 通道的
`107` 时，网关选出的是一张**空表** —— 后果不是「某个模型不可用」，而是**任何模型**
都回 `4001 param is invalid`。这是端点迁移后 chat 全败的**第二个根因**（第一个是
端点选错通道，见上），`bedd149` 当时假设「版本头维持现状即可」**是错的**。

实机验证过的**成功组合**（chat 端点，`glm-5.3-flash` 流式正常）：

```
x-ide-version-code: 20260820      ← SOLO 代际；**必须是 8 位日期式 YYYYMMDD**
x-ide-version:      0.1.61        ← SOLO 代际（不是 1.107.1）
User-Agent:         Trae/0.1.61   ← 与上面两个头同代际
```

- **值域**（目录端点值扫描）：只有 **8 位日期式**才命中非空配置表；`20260801` 起
  表已满，取证当日（`20260919`）为 41 项、二次取证（`20260920`）为 **40 项**
  （**remote 39 / lite 40 / 交集 39**，lite 独有一项 `computer_use_subagent`）；
  ⚠️ 前序记载的「41 项」是**单次快照**，`20260920` 复测为 40 项 —— roster 会随
  上游增删浮动，**不要把它当常量**（代码里也没有任何地方依赖该数字）；
- **只认 `x-ide-version-code`**：`x-app-version-code` 与选表**无关**（已隔离验证），
  但本实现让它与前者**同代际**，免得两个版本头自相矛盾；
- **两组版本码同名不同物，不可合并**（`src/trae-cn-product.ts` 里是**四个**独立
  常量）：`TRAE_CN_IDE_VERSION_CODE`（`107`）/ `TRAE_CN_IDE_GATEWAY_VERSION`
  （`1.107.1`）属 **IDE 网关代际**，`TRAE_CN_SOLO_VERSION_CODE`（`20260820`）/
  `TRAE_CN_SOLO_IDE_VERSION`（`0.1.61`）属 **SOLO 代际**。它们占同一个请求头，
  但**值域与语义都不同** —— 「顺手统一」就会把 chat 打回恒 `4001`；
- 历史旁证：第三方实现（traework2api 的 `constants.ts`）早有注释记着同一现象
  （「version-code 决定上游返回哪张模型配置表……拿 `20260716` 直接调 `glm-5.3`
  会 4001」）；
- ⚠️ **签到链路不适用**：`traeCnCreditsHeaders`（签到）的版本头**不动** ——
  它属另一条协议线，`x-app-version: 3.3.102` 已独立校准。

**网关必须带齐的请求头**（`request-traffic-type` / UA / 追踪头是 SOLO 通道的实测值）：

```
x-app-id:            6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
x-ide-version-code:  20260820       ← SOLO 代际；选表键，发 107 会选出空表 → 4001
x-app-version-code:  20260820       ← 与选表无关（已隔离验证），同发只为不自相矛盾
x-ide-version:       0.1.61         ← SOLO 代际（旧 IDE 代际是 1.107.1）
x-ide-version-type:  stable
request-traffic-type: prod           ← SOLO 通道实测值（旧 IDE 通道是 normal）
x-plugin-channel:    icube-ai        ← SOLO 通道新增
x-request-id / x-trae-request-id: <同一个 UUID>
x-custom-trace-id:   <requestId 去横线后前 32 字符>
x-flow-traceparent:  04-<traceId>-<traceId 前 16>-01
x-uid:               <凭据的 user_id>
x-device-id:         <凭据的 device_id>   ← 与签到头同源
x-device-type:       windows
x-os-version:        <本机 os.version()，与签到头同源>
User-Agent:          Trae/0.1.61          ← SOLO 代际（旧通道是 TraeClient/TTNet）
```

追踪四头**同源**：`x-request-id` 是一个 UUID，`x-custom-trace-id` 是它去横线后的
前 32 字符，`x-flow-traceparent` 是 W3C 形态。生成一次、三处复用 —— 每处各生成
一个会让上游的调用链对不上；而**每次请求都必须是新的 id**（复用会把多次调用混成
一条链）。

注意登录 URL 的 `x_app_version`（`3.3.100`）与这些网关头**同名不同物、形态要求
还不同**：一个进 URL/请求体，一个进网关头。IDE 代际的两个常量
（`107` / `1.107.1`）**保留在源码里**，是为了让「107 从哪来」有据可查，并防止
后来者把两个代际「顺手统一」。`src/trae-cn-product.ts` 里现在是**四个**独立常量。

**SSE 不是 OpenAI 协议**。上游返回**具名事件**流，帧解析在 `src/trae-cn-sse.ts`
（SOLO 通道的帧格式与旧通道**逐字一致**，故解析器一字未改）：

```
event:metadata      data:{"conversation_id":…}      ← 忽略（`meta` 亦识别）
event:timing_cost   data:{provider_model_name:…}    ← 忽略
event:output        data:{"response":"片段"}         ← 正文增量
event:output        data:{"response":"","tool_calls":[…]}  ← **工具调用也走这一帧**（见下）
event:token_usage   data:{prompt_tokens,…}          ← usage
event:done          data:{…}                        ← 流结束
event:error         data:{"code":4008,"message":…}  ← 失败（HTTP 仍为 200）
```

事件名同样取自本机客户端字符串池：Rust 侧
`…/adapter/llm/event.rs` 有一份权威事件类型清单，每个变体都带一条
`Failed to deserialize <name> event` 诊断串（实测提取到 22 条）。

⚠️ **工具调用**：上游**不**发独立的 `event:tool_call` 帧，而是把它内嵌在
`event:output` 的 `tool_calls` 数组里（2026-09-21 真机帧定案）：
`{"index":0,"id":"call_…","type":"function","function_call":{"name":"glob","arguments":""}}`，
后续增量片 `id` / `name` 为空串、只有 `arguments` 增长（OpenAI 式累积，空串不覆盖）。
⚠️ 字段名 `function_call`（无 er）与**出站改名同源** —— 早前本条记的「入站帧里仍是
`function`，故解析侧不需要任何改动」**是错的**：`tool_calls` 起初根本没被读取，
工具调用被整块丢弃，trae-cn 因此**从未成功调用过一次工具**（343 个历史会话 0/10）。
详见 `AGENTS.md` 的对应 ⚠️ 条目。

**错误分类按业务码，不按 HTTP 状态码**（`src/trae-cn-errors.ts`，纯函数）：

| 动作 | 业务码 | 说明 |
|---|---|---|
| **换号** | `4008` `4021` `5003` `977`（限流）、`4200`–`4203`（额度）、`1001` `1002` `4010` `4014`（账号失效）、`4011` `4013` `4015`（风控） | 对齐官方 `isSecurityError` 语义：账号失效与风控同样换号 |
| **退避不换号** | `4007` `3004`（软限流）、**`9074`（签到：设备身份）**、**`3003`（MODEL_FAIL，基础设施类）**、`4000005` `4050`–`4052`（排队） | 排队与基础设施故障都是**全局**状态，换号只会把同一个问题再问一遍并多烧一个账号的额度；`9074` 见「积分领取」章节的定性小节（前两次定性「瞬时频次软限流」「活动级当日名额」**均已作废**） |
| **直接报错** | `4001`（参数）、`4006`（超长）、**`4022`（上下文窗口溢出）**、`4023`（模型不存在） | 确定性失败，换号与退避都是浪费往返 |
| **直报（带原始码）** | 其它未知码 | 保守默认：未知码可能是终态（积分耗尽的真实码 T3 尚未实测到），直报能让真机第一次遇到就把码暴露在文案里，一步校准 |

`3003`（`MODEL_FAIL`，`all models failed`）是**端点迁移取证时补入**的：它正是旧
IDE 通道对我方新池请求的恒定回复。归**可重试**（退避）而非直报，是因为它明确是
基础设施/容量类的瞬时失败，退避后可能就好了；同时它**不换号**（与具体账号无关），
也**不记冷却徽章**（不是账号级的模型限流）。

非 200 的 HTTP 失败（网络层/网关）走兜底：`401`/`403` → 换号，`429`/`408`/`5xx` → 退避，
其余直报。`4006` 与 `4022` 都映射为 `CONTEXT_WINDOW_EXCEEDED`（触发 DSH 上下文自动压缩），
换号与退避都映射为可重试的 `RATE_LIMIT`。

> ⚠️ **`4022` = 真·上下文窗口溢出（2026-09-21 单变量定案）**：prompt token ≈ **1 000 000** 时
> 上游回 HTTP 200 + 流内 `event:error` 帧 `{"code":4022,"message":"We're sorry, your prompt tokens
> have exceeded the maximum limit."}`。**精确钳制**：`998 161` token 成功 / `1 002 248` token 失败
> （同一个请求只改 token 数，降下来即成功），**与字节量、账号全都无关**。排除性证据：
> `4 KB → 1.5 MB` 十一档字节矩阵**全部 200 正常收尾** ⇒ **不存在字节墙**。修复前它不在任何码表里，
> 落「未知码」默认路径 → `INVALID_REQUEST`（致命、不触发压缩），1M token 长会话从此彻底不可用；
> 现在 `TRAE_CN_CONTEXT_OVERFLOW_CODES = [4006, 4022]` 与 4006 同路。⚠️ 这与「未知业务码一律直报
> 不猜动作」**不冲突**：`4022` 不是未知码（阈值、排除项、同请求对照三件证据齐备），该原则本身一字未改。
> 文案只给 `4022` 追加中文说明（`4006` 是既成行为，刻意不动）。

> ⚠️ **`4008` 的实测语义是「通用积分池耗尽」，不是频率限流（2026-09-21 单变量定案）**：
> 余额端点确认某账号**通用池 `remain=0`** 后，它**连 4 KB 小请求都回 `4008`**（190 ms 即回、
> 20 分钟不自愈）；同刻健康账号（`remain 2334.95`）8 个连续请求全成功 ⇒ 与频率、字节、并发无关。
> **动作与徽章一律不变**（它继续留在换号表里 —— 换号依然正确），新增的
> `TRAE_CN_CREDITS_EXHAUSTED_CODES = [4008]` **只服务终报文案**：全部账号试完后追加一句
> 「全部账号的 Trae CN 通用积分均已耗尽…这不是频率限流，稍后重试不会自愈」。⚠️ 主语由换号循环的
> **退出原因**决定：`pool-exhausted`（池里再没有可试的）才说「全部账号」，`rotate-cap`
> （换号次数达上限就停了）只说「已尝试的账号」并声明池中可能还有未试的，没有池/非换号类失败
> **不追加**。（`semantics` 参数与 `'exhaustion-unverified'` 那套措辞已随 TraeWork 路径
> provider 一并删除 —— 今天只有 `trae-cn` 一个消费者。）

> ⚠️ **绝不允许把流内错误转成优雅关闭**：`event:error` / `code >= 4000` 必须把
> 业务码**直报**给 DSH。转成优雅关闭会让 DSH 报「Stream ended without
> finish_reason」，真因永远丢失（`dsh-connect-trae` 的教训）。

**结构上与 LobsterAI 的根本差异**：Trae 的业务失败发生在 **HTTP 200 的
`event:error` 帧**里，所以换号循环必须能接住**流内**失败 —— LobsterAI 的错误
全在 `!response.ok` 分支，流一旦开始就没有换号的余地。换号上限同 LobsterAI
（3 个账号，含首次）。若流已经开始产出正文才报错，则**不再换号**（换号会让用户
看到「半截回答 + 完整回答」两段内容，比直接报错更糟），改为直报。

**模型目录 = 动态 `get_detail_param`（权威）+ 静态 11 项回退**（2026-09-19 起）。

| 项 | 值 |
|---|---|
| 端点 | `POST /api/ide/v1/get_detail_param`（同一网关，与 chat **同源凭据与头**） |
| body | `{function, config_names:null, need_prompt:false, current_config_info:null, poly_prompt:true, mode_type:null, agent_type:null}` |
| function | CN 区**两个都拉**：`solo_work_remote`（优先）与 `solo_work_lite`，取并集 |
| 解析 | `config_info_list[].config_name` / `display_config.display_name` / **`context_window_tokens.dev`**（回退 `model_detail_list[0].prompt_max_tokens`）与 `.max_tokens`。⚠️ 两个窗口字段上游给的是**不同的数**（真机 `glm-5.3` 是 200000 / 168000），取 **dev** 是为了与官方客户端显示的 200K 对齐。⚠️ `context_window_tokens.max` **已对可调模型停发**，档位改由 agent 池目录提供（见下第 8 条） |
| 缓存 | 12h TTL（参照 LobsterAI 的 `clientVersion` 缓存先例）；**失败不写缓存**，下次调用重试 |
| 回退 | 目录整体不可用 → 现行 11 项静态表（`TRAE_CN_FALLBACK_MODELS`） |

> ✅ **推翻 2026-09-18 的「远端不可接」结论**：那条结论**是对的，但试错了端点** ——
> `model_list` 只回 6 项旧池、`batch_get_detail_param` 只回 4 个 seed 配置。
> 真正可用的是 `get_detail_param`，且**必须按 `function` 分别拉取后取并集**：
> roster 被 Trae 摊在多个 SOLO function 下（`glm-5.3` 只在 `solo_work_remote`）。

**目录过滤规则**（`src/trae-cn-models.ts` 的 `mergeTraeCnDirectory`，**四道网**）：

1. **remote 优先**：同名 id 以先到的 function 为准（顺序即优先级）；
2. **remote 成功时剔除 lite 独有项** —— 实测「用户可调的项要么两个 function
   都在集、要么 remote 独有」，故**只在 lite 出现**的项就是内部 agent 项；
3. **内部项过滤两道网**：点名（`summary` / `file_search_agent` /
   `explore_sub_agent_v2` / `browser_use_subagent` / `computer_use_subagent`）
   + 形态（id 里含 `agent` / `subagent`）。现存 11 项**一个都不命中**该形态，
   故不会误杀用户可调的模型；
4. **账号私有 BYOK 项过滤**（`isCustomTraeCnModel`）：14 项 `custom_model_*`
   是**某个账号私有的三方来源**（`custom_models:["deepseek//deepseek-chat"]` 这种，
   key 存在该账号服务端），列进选择器只会让别的账号选中即失败，且用户无法从名字
   看出它是私有的。判据 = **主判据 `usage === 'custom_model'`** + **兜底 id 前缀
   `custom_model_`**（实测两条判据在真实 roster 上**双向差集为空**，零误伤零漏过）。
   ⚠️ **两个陷阱字段不可用作判据**：`config_source` 恒为 `1`、
   `display_config.is_custom_model` **恒为 `false`**（连 `custom_model_gemini` 也是
   false）；`Array.isArray(custom_models)` 会**漏掉 `custom_model_placeholder`**
   （它的 `custom_models` 是 `null`），故只作兜底不作主判据；
5. **客户端自隐项过滤**（`invisible === true`）：8 项 `is_invisible_to_user:true`
   —— 客户端自己隐藏它们。其中 `seed-code-pro-0430` / `Doubao-Seed-2.0-Code` 的
   展示名分别是 **`Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo`**（**旧代际重名
   别名**，不剔会与真身重名出现在选择器里，用户无从分辨），`sagitta` / `aquila`
   的展示名是 **`"-"`**。⚠️ **三态语义，不能写成 `!entry.invisible`**：`true` 才剔，
   **`undefined` 必须保留**（实测 40 项里 `true` 12 项、`false` 14 项、**缺该字段
   14 项**，其中 `qwen3.8-max` / `qwen-3.7-plus` 是**正常项**）。反向陷阱：
   `kimi-k2.7-code` / `kimi-k2.6` 是 `is_invisible_to_user:false` 的**正常项，
   必须保留**；
6. **刻意不接 remote 骨架合并**：把远端独有项也列出来会引入 `join` 不到的不可调项
   （如旧表里的 `Doubao-Seed-Code`），选中即路由失败；
7. **多模态标记与思考档位由静态表补齐**（目录端点两个都不提供，见下）：只对
   **静态表已有的 id** 补值、**不新增条目**。不补的话，同一模型在「目录成功」与
   「目录失败」两条路径下会报出不同模态、且档位**整行消失**，是自相矛盾；
8. **档位（dev/Max）来自 agent 池目录**（2026-09-21 换轨）：`GET https://solo.trae.cn/api/remote/v1/models?functions=solo_agent_remote`
   的 `max_mode` + `context_window_tokens.max`。⚠️ IDE 目录端点**已对可调模型停发
   max**（只剩 `custom_model_*` BYOK 项带，而那些项在第 4 条就出局）⇒ 档位列原本
   在真机上**没有数据可渲染**。规则同样是**只补不增**：只给本目录**已有**的条目补
   `maxContextWindow`，agent 组独有的 id（如 `Doubao-Seed-Code`）**一律忽略**；
   该端点失败/超时/无本组 ⇒ 本次刷新**没有档位**，目录本身照常返回。
   细节见下文「上下文窗口档位选择」。

> **过滤后的规模（2026-09-20 取证，真实 roster 逐项核对）**：
> `40（并集）− 5（内部）− 14（custom）− 8（invisible）= 13 项`。
> ⚠️ 内部项是 **5** 项而非 4：`computer_use_subagent` 是 **lite 独有**项，在第 2 条
> 规则里就已出局，容易被漏算。
> 动态目录的 13 项与静态回退表（11 项）的差集**只有两项**：
> `kimi-k2.7-code` / `kimi-k2.6`（它们不在旧 IDE 通道的 16 项里，只在 SOLO roster）。

### ⚠️ 「客户端模型池（IDE 代际）」≠「SOLO 网关配置表」

**这是理解本 provider「少模型」报障的关键区分**，两个池的成员**不重合**，而本
provider **只走 SOLO**：

| | 客户端模型池（IDE 代际） | **SOLO 网关配置表（本 provider 的权威可用集）** |
|---|---|---|
| 来源 | Trae 客户端本地 `vscdb` 缓存 / 客户端 UI | `get_detail_param` 按 `x-ide-version-code` 选出的表 |
| 规模 | 旧 `chat_v3` 16 项 | 40 项（`20260920`） |
| 能否路由 | **取决于客户端本地缓存**，与网关无关 | **能** —— 本 provider 的请求只认它 |
| 典型独有项 | `Doubao-Seed-Code` / `glm-5.3-flash` / `deepseek-v4.1-flash` / `kimi-k2.8-preview` / `qwen3.8-flash` | `kimi-k2.7-code` / `kimi-k2.6`（客户端池里没有） |

要点：

- **客户端能显示的模型受本地缓存影响**（缓存是客户端上次拉取/登录时的快照，可能
  滞后或超前于服务端），**不能**把它当作「服务端有什么」的证据；
- **SOLO 表才是本 provider 的权威可用集**：请求发到 SOLO 网关，网关按
  `config_name` 在**它自己那张表**里找配置，找不到即 `4001 param is invalid` ——
  与客户端 UI 上显示什么**无关**；
- 故 **5 项剔除（`glm-5.3-flash` 等）已二次确认非误伤**：它们在 SOLO 表里确实
  不存在，留着只会产出必然 `4001` 的死选项（详见下「静态回退表」的说明）；
- 反向也成立：`kimi-k2.7-code` / `kimi-k2.6` 只在 SOLO 表里、不在旧客户端池里
  —— 它们是**正常可调项**（`is_invisible_to_user:false`），**必须保留**。

**静态回退表（11 项）**：

> ⚠️ **为什么是 11 项而不是真机目录的 16 项**（2026-09-19 二次取证）：
> 原表 16 项录自**旧 IDE 通道**的 `chat_v3` 目录；chat 迁到 **SOLO 通道**后，
> 该通道 roster（`20260919` 快照 41 项 / `20260920` 复测 **40 项**）里
> **没有**下面这 5 项，故它们**调不了**：
>
> | 剔除的 id | 展示名 |
> |---|---|
> | `Doubao-Seed-Code` | `Seed-Code` |
> | `glm-5.3-flash` | `GLM-5.3-Flash` |
> | `deepseek-v4.1-flash` | `DeepSeek-V4.1-Flash` |
> | `kimi-k2.8-preview` | `Kimi-K2.8-Preview` |
> | `qwen3.8-flash` | `Qwen3.8-Flash` |
>
> 理由不是「表要精简」，而是**本 provider 只走 SOLO 通道**（IDE 通道已由五轮真机
> 取证定案废弃）。回退表里留着 SOLO 调不了的 id，唯一效果是**在模型选择器里产出
> 必然 `4001` 的选项** —— 用户选中即失败，且失败原因（选表键/代际不匹配）与模型
> 本身无关，极难自行诊断。动态目录成功时本来也不会列出它们，故剔除后两条路径的
> 目录**首次一致**。
>
> 注意 `Doubao-Seed-Code` 的剔除**只针对本 provider**：它在 TraeWork 那条路径
> （`solo_agent_remote` 代际，已随官方合并移除）里曾是**默认模型**，
> 两张表互不影响。

| id | 展示名 | 多模态 | max_tokens | 上下文（dev/max） |
|---|---|---|---|---|
| `Doubao-Seed-Evolving` | `Seed-Evolving` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Pro` | `Seed-2.1-Pro-0915` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Turbo` | `Seed-2.1-Turbo` | ✓ | 32000 | 262144 |
| `glm-5.3` | `GLM-5.3` | ✗ | 64000 | 119040/1048576 |
| `glm-5.2` | `GLM-5.2` | ✗ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Flash-Official` | `DeepSeek-V4-Flash 正式版` | ✗ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Pro-Official` | `DeepSeek-V4-Pro 正式版` | ✗ | 64000 | 119040/1048576 |
| `kimi-k3` | `Kimi-K3` | ✓ | 64000 | 204800/1048576 |
| `minimax-m3` | `MiniMax-M3` | ✗ | 64000 | 119040/1048576 |
| `qwen3.8-max` | `Qwen3.8-Max` | ✓ | 64000 | 204800/1048576 |
| `qwen-3.7-plus` | `Qwen3.7-Plus` | ✓ | 64000 | 204800/1048576 |

来源：真机 `chat_v3` 模型目录（2026-09-18），由 Trae 客户端 **vscdb 缓存**与
**160 处日志事件**互证；id / 展示名 / 多模态标记 / max_tokens / 窗口**逐字符**照抄。
id 形态极不规则（`qwen-3.7-plus` 带连字符、`minimax-m3` 全小写）——**任何规整化
都会让请求打到不存在的模型上**，故原样保留。

⚠️ **表里的 `dev/max` 两列都是 2026-09-18 的快照，且都已漂移**（2026-09-21 复测）：
动态目录现在给 `glm-5.3` 的 `context_window_tokens.dev` 是 **200000**（`prompt_max_tokens`
是 **168000**，**已不作为生效档**，只作回退值），而 **max 列上游已对可调模型停发**
（只剩 `custom_model_*` BYOK 项带，那些项会被过滤网剔除）。本表**刻意不跟着改**：它只在
动态目录整体失败时顶替，目录成功时这些值根本不参与，而「跟着上游改静态表」是一条没有
终点的路 —— 这里登记漂移事实，比维护一份永远滞后的副本诚实。**Max 档的实时来源**已改为
agent 池目录，见下文「上下文窗口档位选择」。

⚠️ **`minimax-m3` 的多模态标记已由 `✓` 修正为 `✗`（2026-09-20）**：原值照抄的是
**旧 IDE 通道** `chat_v3` 缓存，而 SOLO 目录端点实测 `display_config.multimodal:false`
（remote / lite 两条 function 上分别是 `false` / `true`，合并规则取 **remote 优先**
→ `false`）。不改的话，同一模型在「目录成功」路径判纯文本、在「目录失败」路径判
多模态 —— 正是静态补齐要消灭的那种自相矛盾。**其余 10 项静态值与目录实测逐项一致**
（二次核对），只改这一项，故现存 11 项里多模态项由 7 项变为 **6 项**。

⚠️ 该表现在是**回退表**（不再是唯一目录），但它仍是**唯一**记录「多模态标记」与
**「思考档位」**的地方：目录端点两个字段都不提供（前者本就没有，后者的
`reasoning_effort_config` 恒为空壳），故动态目录生效时由 `applyTraeCnStaticMetadata`
按 id 把两者一起补回来（只补不增，见上「目录过滤规则」第 7 条）。

- 上下文窗口取 **dev 档**（如 `262144/1048576` → 262144）：它是客户端默认实际
  使用的窗口。max 档（多数 1048576）是理论上限，按它声明会让 DSH 的上下文压缩
  迟迟不触发；动态目录同口径取 **`context_window_tokens.dev`**（回退
  `prompt_max_tokens`）—— 上游这两个字段给的是不同的数（真机 `glm-5.3` 是
  200000 / 168000），取 dev 才与**官方客户端显示的 200K** 对齐，消除「同模型两个数」
  的困惑。取哪个**只影响宿主的压缩触发点**（阈值 `0.8 × 窗口`），不影响上游服务：
  4022 直测已证明两者都不是硬限（498K token 的请求正常服务，真墙在网关级约 1M）。
  ⚠️ 静态表**一律不带 Max 档** ⇒ 静态路径下没有档位 UI（这是设计）；2026-09-21 起
  Max 档由 agent 池目录**实时**提供，见下文「上下文窗口」小节；
- `inputModalities` **按模型给**：多模态项（原 16 项里 12 项、**现存 11 项里 6 项**
  —— 被剔除的 5 项恰好全是多模态项，另 1 项是上面的 `minimax-m3` 修正）输出
  `['text','image']`，其余 `['text']`。
  `listModels` 与 `resolveModel` 读的是同一个 `supportsImages` 字段，两处口径强制
  同源（不一致会让选择器与请求路径自相矛盾）；
- `maxTokens` **只记录不 materialize**：DSH 的 `defaultMaxTokens` 会在调用方未给
  上限时自动填进请求体，而本仓库另外六个 provider 一个都没设该字段 ——
  由适配器替用户决定输出上限是行为变更，不在本次范围内。
- **消耗倍率不再解析**：旧实现会从 `display_contact_config.consumption_rate.data.rate`
  读出倍率但不展示（DSH 的 `LlmModelInfo` 没有放自定义元数据的位置，塞进
  `description` 会污染选择器文案）。新的目录解析器**不读它** —— 读出来没有任何
  落点，留着只会让人以为它被用上了。

**思考档位（reasoning effort）已接线**：静态表 11 项里 **8 项**声明档位，另 3 项
（`minimax-m3` / `qwen-3.7-plus` / `Doubao-Seed-Evolving`）刻意不声明（被剔除的 5 项
恰好全都有档位）。

> ⚠️ **档位来源已变更（2026-09-20，用户报障的根因）**：**SOLO 目录端点不提供档位**。
> 取证实测：`get_detail_param` 的 39/40 项里，带 `reasoning_effort_config` 的
> 9/10 项**全是 `{support_thinking:false}` 空壳**（没有 `options` / `default_level`），
> 其余项连该字段都没有 —— 即 `parseTraeCnDirectory` 在 SOLO 目录上**永远读不出档位**。
> 动态目录取代静态表后，「思考程度」选择器**整行消失**（`resolveModel().reasoning`
> 是唯一数据源）。
>
> **修法**：`applyTraeCnStaticMetadata`（原 `applyTraeCnStaticModalities`）在按 id
> 补多模态之外，**同源按 id 补 `reasoningEfforts` / `defaultReasoningEffort`**。
> 判据是 **`entry.reasoningEfforts === undefined` 时才补** ——
> ⚠️ **绝不能看目录的 `support_thinking`**：目录恒为 `false`，照「目录已表态就不覆盖」
> 的写法写就**永远补不上**（多模态那边确实是这个语义，两者判据**刻意不同**）。
> 动态条目永远不可能自带档位，故该判据等价于「按 id 补」；上游将来真发出
> `support_thinking:true` + 非空 `options` 时，解析器会把档位读进条目，这条判据
> 随即自动让位给目录值。
>
> 补齐的 **8 项**：`Doubao-Seed-2.1-Pro`(light/high,def high)、
> `Doubao-Seed-2.1-Turbo`(light/high,def high)、`glm-5.3`(light/high/extra_high,def high)、
> `glm-5.2`(high/extra_high,def high)、`DeepSeek-V4-Flash-Official`、
> `DeepSeek-V4-Pro-Official`、`kimi-k3`(def **extra_high**)、`qwen3.8-max`。
> `kimi-k2.7-code` / `kimi-k2.6`（动态目录独有）**不在静态表** → 不补，保持不声明。
> `fallbackTraeCnCatalog()` 自带的档位不受影响（它本就来自静态表）。

- 档位数据来自真机 **vscdb 缓存**（`User/globalStorage/state.vscdb` 的
  `reasoning_effort_config{support_thinking, options, default_level}`，
  2026-09-18 只读提取；2026-09-20 对 vscdb 逐字符复核，8 项静态值**准确**）。
  两套模型池各有一份：**`chat_v3`（IDE 对话，即本插件
  走的路径）** 与 `solo_agent`（SOLO）——本插件取 **`chat_v3`** 那套。两者档位
  集合相同，但默认档不同（如 `glm-5.3` 在 chat_v3 是 `high`、solo_agent 是
  `extra_high`），**不可混用**；
- 档位 id **逐字符照抄**（`light` / `high` / `extra_high`，**不是** buddy 系的
  `low`/`max`/`xhigh`）。DSH 的 `ReasoningEffortId` 是 branded string、
  **不校验取值**，改写会让请求里的档位与上游对不上。展示名对齐 Trae 客户端中文
  文案（轻 / 高 / 极高）并附英文原词；
- 默认档照抄真机 `default_level`：多数为 `high`，**`kimi-k3` 是 `extra_high`**
  （同族的 `kimi-k2.8-preview` 也已随 5 项 SOLO 不可调 id 剔除）；
- 不声明 `reasoning` 的模型在 DSH 模型选择器里显示「当前模型未提供推理等级」
  ——那是**唯一**数据源（`resolveModel().reasoning`），不声明时该行根本不渲染。

**下发字段名是 `reasoning_effort_level`，不是 `reasoning_effort`**（2026-09-18 定案）。
官方客户端的 `ai-modules-chat` bundle 里，`resolveReasoningEffortRequestField`
默认产出 `reasoning_effort_level`，只有**字节内网账号**（`scope===BYTEDANCE`）
才走 `reasoning_effort`；本插件用的是普通国内账号，故取前者。`ai_agent.dll` 的
serde 字段块里两者**并列存在**，印证这是「两套账号体系各用一个」而非猜测。

> ⚠️ **端点迁移后仍然不改这个字段名**（2026-09-19 的决定，刻意为之）：
> SOLO 通道的第三方可用实现下发的是 `reasoning_effort`，但那是 **SOLO 代际**的
> 写法，**未做 A/B 验证**。在拿到「同一请求两种字段名哪个真生效」的对比证据之前
> 不盲改 —— 那是把一条有证据的结论换成一条没有证据的猜测。值域
> `light` / `high` / `extra_high` 同样不变。

> ⚠️ **已知未验证项**：上游是否**真的按档位改变思考**尚未做对比实验。真机
> A/B **无法**用「是否报错」区分两个字段名 —— 测试账号在带与不带档位时都回
> `code:4008`（配额），字段校验阶段被 4008 掩盖（该账号在
> `pay/web_user_ent_usage` 上仍显示通用池 2650 积分，故 4008 不是「余额为 0」，
> 但也不是可用来判定字段名的信号）。字段名本身由上述静态证据三方互证定案；
> 「档位是否生效」需一次能跑通的对话来对比 `reasoning_content` 长度。

> ℹ️ **远端目录项的档位（已作废的期待，保留作对照）**：原实现写的是
> 「`get_detail_param` 的条目若带 `reasoning_effort_config`
> （`support_thinking:true` + 非空 `options`），同样会被声明；**没有该字段就不声明**
> —— 不编造档位」。前半句的**解析**仍然正确（`parseTraeCnDirectory` 照旧按该判据读，
> `default_level` 不在 `options` 内时只丢默认档、保留档位列表），
> **但后半句是缺陷**：SOLO 目录**根本不发** `options`（9/10 项是
> `{support_thinking:false}` 空壳），照此就得到「一项档位都没有」。
> 正确语义是**按 id 从静态表补**（见上「档位来源已变更」）。

**旧「为何不接远端模型目录」的实测表仍然有效，但它只说明那三个端点不可用**
（2026-09-18 三端点实测结论）：

| 端点 | 实测结果 |
|---|---|
| `model_list`（`{"type":"chat"}` + 完整网关头） | 只回 **6 项旧池**（Doubao-1.5 代） |
| `batch_get_detail_param` | 只回 **4 个 seed 配置** |
| 其余约 200 种形状组合 | 18 项新池**一个都不出现** |

**`get_detail_param` 不在那张表里，它是可用的**（见上「模型目录」小节）。
旧实现据此写下的「`fetchRemoteModels` 刻意不接线、静态表即正解」**已作废**；
旧的容忍式解析器 `parseTraeCnModels`（从 `data`/`models`/`model_list` 等候选键里
猜数组）与它配套的 `TraeCnRemoteModel` 类型**已整体删除** —— 现在只读实测路径
`config_info_list`，不做信封猜测：上游真改版时，一个**空目录**（回退静态表，
用户仍能用）比「猜对形状但读错字段」的半成品更容易诊断。

4 个旧死 id 的下落：`qwen3.7-max` **已下线**；`deepseek-v4-flash` /
`doubao-seed-2-1-pro` / `MiniMax-M3` 是拼写或大小写错误的**近似形态**
（真机分别是 `deepseek-v4.1-flash` / `Doubao-Seed-2.1-Pro` / `minimax-m3`；其中
`deepseek-v4.1-flash` 已随 SOLO 不可调 id 一并剔除）。
真机目录里**没有** `deepseek//deepseek-chat` 与 `deepseek//deepseek-reasoner`
—— 那是账号自定义的 BYOK 条目，不属云端目录，已排除。

**表外模型的 `4001` 有可读提示**（`src/trae-cn-adapter.ts` 的 `withOffCatalogHint`）：
`4001 param is invalid` 在本 provider 上有**两个完全不同的成因**，而上游文案一模
一样 —— 一是**模型不在可用目录里**（用户手输的 id、或历史会话里被剔除的旧 id，
如 `glm-5.3-flash`），解法是**重选模型**；二是**请求形态问题**（参数类型/body
字段），解法是改代码。不区分的话，用户只会以为插件坏了。故在 `4001` 且
**模型不在当前目录**（判定与 `function` 路由同源，同一个 `catalogEntries()`）时，
错误文案追加一句「（该模型已不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选）」。
其它错误码**不加**：`4023`（模型不存在）上游自带语义、文案已够清楚。

**与其它 provider 一致的约定**：`stream()` 把 `options.model` 传给
`resolveCredential` 与 `refresh`（硬约定，见「账号池与多账号」）；
`listModels()` 实时读 `pool.disabledModelsFor('trae-cn')` 应用黑名单；
**声明** reasoning 档位（现存 8/11 项，真机 vscdb；下发字段 `reasoning_effort_level`，
仅透传调用方显式传的值、不主动补档 —— 补档由 DSH 按 `defaultEffort` 完成）。
目录拉取本身**不传 model**（目录对所有模型一致，不做逐模型限流过滤）。

> ⚠️ **图片输入有意不一致**：目录照实报 `['text','image']`（那是**模型**的能力），
> 而 `stream()` 仍对图片块抛 `UNSUPPORTED_CONTENT`（那是**本适配器**的能力 ——
> `serializeTraeCnMessages` 只展平文本块，没有把 image 块编码成上游要的形态）。
> 正常调用到不了那道抛错：DSH 会按 `inputModalities` 在路由层把图片投影成文本
> 占位（`projectImagesForTextModel`）；抛错是防「绕过路由层直接调 `stream()`」
> 的最后一道防线。两处**不要「顺手」改成一致**。

### 上下文窗口档位选择

> 2026-09-21：本机制从「只服务 Trae CN」**推广到全部有档位数据的供应商**（见下面的
> 「适用范围」）。用户视角不变，仍是同一个单选列，只是现在 buddy / qoder 面板也有。

⚠️ **适用范围（推广后）**：只有**目录里公布了多个窗口**的 provider 才有这一列 ——
Trae CN（`dev` / `Max` 两档）、Buddy CN 与 Buddy（`contextWindow.supportedLengths`）、
Qoder 与 Qoder CN（`available_context_windows`，真机 `[200000, 400000, 1000000]`）。
host 侧由 `src/context-tiers.ts` 的 `ContextTierRegistry` **按 provider id 分派**，
`src/index.ts` 只登记这五个键；**LobsterAI / Codearts 刻意不登记** ——
它们（以及已移除的 TraeWork 路径）的目录只有一个窗口、没有可选项，而「无数据不显示、
绝不编造」是铁律：给一个切过去毫无效果的选项比没有控件更糟。

客户端的单选列是**数据驱动**的：`model.list` 带出 `contextTiers` 数组（升序去重、
**≥2 档才带**）就画几个 radio（非默认档按容量命名成 `400K` / `1M`，命中
`maxContextWindow` 的那个仍叫「Max」）；只有两字段的旧形态画「默认 / Max」两个。

**档位语义各家不同**，唯一的共同点是「能选的档位**精确等于**目录公布的那些数」：

| provider | 目录字段 | 默认档 | 其余档位 |
|---|---|---|---|
| Trae CN | `context_window_tokens.{dev,max}` | dev | Max（更大） |
| Qoder 系 | `available_context_windows` | **最小**档 | 升档选项 |
| Buddy 系 | `contextWindow.supportedLengths` | **最大**档 | 降档选项 |

Trae CN 的模型目录对**部分**模型公布两档上下文窗口（`dev` / `max`）。默认只声明 `dev` 档 ——
声明值决定宿主**何时自动压缩上下文**（阈值 `0.8 × 窗口`）与压缩后的保留量，
所以在 dev 档较小（如 200K）时，长会话会比实际需要更早被压缩。

⚠️ **档位数据的来源在 2026-09-21 换过一次轨**（用户视角不变，仍是下面那个单选列）：

| | 来源 | 现状 |
|---|---|---|
| 旧 | IDE 目录 `POST /api/ide/v1/get_detail_param` 的 `context_window_tokens.max` | **已停发**：实测现在只有 `custom_model_*` BYOK 项带 max，而那些项会被过滤网剔除 ⇒ 档位列在真机上没有数据 |
| 新 | agent 池目录 `GET https://solo.trae.cn/api/remote/v1/models?functions=solo_agent_remote` 的 `max_mode` + `context_window_tokens.max` | **现行数据源**（同一批 Trae 账号、同一个模型族的另一个池视图） |

合并规则三条：**只补不增**（只给 IDE 目录里**已有**的条目补 Max 档；agent 组独有的 id
如 `Doubao-Seed-Code` **一律忽略** —— 加进选择器就是一个必然 `4001` 的选项）；
**只在 Max 严格大于该模型实际生效的 dev 档时才收**（生效档 = `context_window_tokens.dev`，
回退 `prompt_max_tokens`）；**档位拉取失败只是没有档位**（等于本次改动之前的行为），
**绝不拖垮目录本身**。

⚠️ **README 早前记的数已漂移**：`glm-5.3: 119040/1048576` 是 2026-09-18 的快照；
2026-09-21 复测同一模型的 `context_window_tokens.dev` 是 **200000**（生效档）、
`prompt_max_tokens` 是 **168000**（回退值，**不再作为生效档**），而 agent 组公布的
Max 是 **1000000**。Trae 的 roster 与这些数字**都会漂**，不要当常量用（静态回退表
刻意不跟着改，见下）。

**在哪选**：Account Hub → 该 provider 面板 → 点「显示列表」。有多个窗口可选的那些模型行
右侧会多出一组单选（每个档位一个 radio，默认档标「默认」）。以 **Trae CN** 为例：

| 选项 | 声明的窗口 |
|---|---|
| **默认档** | 该模型目录的 dev 档（如 `glm-5.3` 是 200000），默认 |
| **Max 档** | agent 组公布的最大档（如 `glm-5.3` 是 1M） |

Buddy / Qoder 面板同款，只是档位值来自各自的目录（Qoder 的默认档是最小档、
Buddy 的默认档是最大档 —— 见上面的语义表）。

⚠️ **档位列与「显示开关」无关（2026-09-21 修复）**：被**关闭**的模型照样带完整的
档位字段（`contextWindow` / `maxContextWindow` / `contextTiers` / 当前预算），
档位 radio 照常渲染、照常可改。早前 `model.list` 只在未被过滤的那批模型上加窗口字段，
而关闭的模型是**由回填侧补回列表**的（见
[显示列表的回填机制与过滤](#显示列表的回填机制与过滤)），那条路径不带窗口字段 ⇒
用户看到「**只有开启后才能选上下文**」，关掉模型想顺手改档时档位列整个消失。根因是
**同一份档位数据被两条渲染路径区别对待**，而档位来自适配器目录、本就与显示开关无关。

**只有一个窗口可选的模型不显示这一列**：LobsterAI / Codearts（目录里没有窗口之外的第二档），
以及 Trae CN agent 组里 `max_mode:false` 的那几项（真机为 `Doubao-Seed-2.1-Turbo` /
`kimi-k2.7-code` / `kimi-k2.6`）。

**标签写法**：档位值按 **1000 进制**缩写（`200K` / `1M`），精确 token 数放在 `title`
里。1000 进制不是为了好看 —— 它是**厂商口径**（OpenAI / Anthropic / 字节的模型卡与
Trae 客户端自己的 `168K` 都这么写），用 1024 进制缩写反而会和用户手边别处的数字对不上。
早前那版规则是「能被 1024 整除才缩写，否则原样输出」，于是真机目录里 168000 这类
「既非 1024 整数倍、又是厂商口径整数」的值在界面上变成一串裸数字，既难扫视、又和客户端
显示的数字看起来像两个不同的东西。默认档与 Max 档带名字（`默认 200K` / `Max 1M`），
多档 provider 的中间档直接用容量当名字（`400K`），不重复渲染成 `400K 400K`。

**效果**：切换只改变「我们向对话宿主声明的窗口大小」，**发给上游的请求内容一个字节都不变**
（各 provider 的 chat 请求体里本来就没有档位字段，有逐字节比对用例钉死）。选更大的档后压缩
阈值按它计算，长会话不再被过早压缩；上游仍按请求的真实长度服务，**它自己的硬限不会因为我们
声明得更大而放宽**。

**三条要知道的边界**：

- **只能选目录公布的档位**。界面上的每个值都是目录给的；任何其它数字（包括手改
  `settings.yaml`）都不会生效 —— RPC 校验时精确比对目录档位列表，适配器读取时会**再判一次**
  是否命中，不命中就**静默退回默认档**。这是刻意的：编造的窗口会直接改写宿主的压缩时机。
- **目录浮动后旧选择自动失效**。Trae 的模型 roster 与档位会变（实测过 41 → 40 项的浮动）。
  模型下线、档位改值、或某一版目录不再公布某个窗口时，之前存的档位**自动退回默认档**，
  不会报错、也不会拿旧数字继续声明。
- **目录拉取失败时没有档位可选**。档位与目录**共用同一次刷新**（12h TTL）：目录整体落空时
  适配器回退静态回退表，而静态表**刻意不带档位** —— 没有目录就没有 roster 依据，把「某个池
  公布的 1M」摊派上去就是编造。等目录恢复档位就回来了。

### 签到与积分余额

实现是独立一套 `src/trae-cn-credits.ts`（协议与 Buddy 系、LobsterAI 都不同），
三个 RPC 端点在同一处按 provider 分发（`src/jet-hub-rpc.ts`）。

**端点与请求体**（host `https://api.trae.cn`，鉴权 `Cloud-IDE-JWT`）：

| 用途 | 端点 | body |
|---|---|---|
| 签到状态 | `POST /trae/api/v2/ug/checkin_credits/status` | `{"req_source":1}` |
| 签到领取 | `POST /trae/api/v2/ug/checkin_credits/claim` | `{"req_source":1}` |
| 积分余额 | `POST /trae/api/v2/pay/web_user_ent_usage` | `{"require_usage":true}` |

**请求头**（官方 claim 头集，**逐头对齐**，2026-09-20）：

```
Content-Type:  application/json
Authorization: Cloud-IDE-JWT <access_token>
x-device-id:   <凭据里的 checkin_device_id（= 登录时生成并上报的 16 位设备号）>
x-device-type: windows
x-os-version:  <本机 os.version() 的运行时取值，如 Windows 10 Home>
x-app-version: 3.3.102
```

**官方不发的 5 个头已删除**：`Accept` / `Origin` / `Referer` /
`X-Ide-Token` / `X-Cloudide-Token`（依据：官方 `bb()` 只给 `Content-Type`，
`mixAuthorization` 只加 `Authorization`，`fb()` 只加设备头）。
`x-device-brand` **刻意不发**（官方条件性发，本插件不猜硬件型号）。
⚠️ **chat 侧不受影响**：`traeCnAccessHeaders` 是 chat 与签到共用的构造器，
本次签到侧改为自建头，chat 的 `traeCnSoloHeaders` 一行未动。

- 设备头是 **claim 的硬要求**，缺失时服务端回 `code:9004`。
  `x-device-id` 取自凭据的 **`checkin_device_id`**（登录时生成并上报的 16 位号）——
  **不是**登录 exchange 返回的 `BoundDeviceID`。
  ⚠️ **T9 第三次修正（2026-09-20）**：T9 原结论「设备**号形态**不被校验」观测
  成立但**推论错了** —— 不校验**形态** ≠ 不校验**设备**；服务端按 `x-device-id`
  做设备维度记账，**只认登录时注册的那台设备**。这就是 `9074` 的真根因。
  旧凭据（本字段引入前）该号**无法恢复**，签到侧**如实降级**为
  `BoundDeviceID`（不伪造），**重新登录一次即可修复**。
- ⚠️ **`x-os-version` 是运行时值**（2026-09-19）：真机客户端发 `os.version()`
  的返回值（带品牌名的市场营销名），故本插件同样在运行时取 `node:os` 的
  `os.version()`，不再硬编码构建号。`x-app-version` 同步升到 `3.3.102`。
- `req_source:1` 照抄**唯一次实测成功**的组合。✅ **T1 已校准**：带与不带服务端返回
  **逐字节相同**，它不是 9004 的成因；保留它只因为成本是零。

#### 「设备号」在本项目里是**两个位置**（2026-09-20 修正）

「设备号」一词曾被同时用在这两个字段上。**修正后**的边界如下 —— 关键变化是
**签到头不再用第二个**：

| 位置 | 取值 | 用途 |
|---|---|---|
| **登录 URL 的 `device_id`**（`generateTraeCnDeviceId`） | 登录时现场生成的 **16 位纯十进制** | 登录握手形态要求 **且是设备身份**（落盘为 `checkin_device_id`） |
| **exchange 返回的 `BoundDeviceID`**（凭据的 `device_id`） | 14 位字母数字（如 `wl2k1e2endpp32`） | 服务端绑定标识；**活动系统不认它** |

本文档前面「`device_id` 是 16 位纯十进制」讲的是**登录 URL 那个**。

**两次归因错误的更正记录**：

1. 早先把「形态不符」的后果记成「会触发 9074 风控」—— **错**，`9074` 与**形态**
   无关；
2. 接着把 9074 定性为「活动级当日名额/账号风控」—— **也错**（官方同期签成功）。
   真根因是**设备身份**：我们把登录注册的设备号丢了，改发了一个活动系统不认的值。

#### 与真机的差异（2026-09-20 修正后）

| 项 | 真机 | 本实现 | 处置 |
|---|---|---|---|
| `x-device-id` | `guaranteedDeviceId`（AHA 16 位号，与登录 URL 同源） | **登录时注册的 16 位号**（旧凭据降级为 `BoundDeviceID`） | **已修**（9074 真根因） |
| `x-device-brand` | 条件性发（`device_model` 非空才发） | **不发** | 刻意（不猜硬件型号，不发空串冒充） |
| `Accept` / `Origin` / `Referer` / `X-Ide-Token` / `X-Cloudide-Token` | **官方都不发** | 原多发 → **已删** | **已删**（对齐官方头集） |
| `x-os-version` / `x-app-version` | `os.version()` / `3.3.102` | 同 | 已对齐（2026-09-19） |

⚠️ **旧的「身份保真」修复不是 `9074` 的解药**：定案的根因是**设备身份**
（`x-device-id`），不是版本号形态。改 `x-os-version` / `x-app-version` 是为了让
出站身份与真实客户端一致，消除「服务端按身份归因时看到的是一个不存在的客户端
形态」这类隐患。

**签到领取在 claim 段有有界重试**（2026-09-20）：命中 `9074` / `4007` / `3004`
时按 1s → 3s 退避重试 2 次（累计 4s），status（读）段**不重试**，`9004` /
`1001` **绝不重试**；重试耗尽后按**最后一次**的 code / message / logid 返回。
详见「积分领取」章节。

**幂等判据是 `checked_in`（账号级当日）**，`did_checked_in` 是**设备级**语义
（换设备仍为 false），**不要用**。领取流程自身先查状态、已领则短路，
故 RPC 分发处传 `precheckStatus: false`（对齐 LobsterAI 的多步流程）。

**失败时透传服务端 logid**：claim / status 失败若响应头带 `x-tt-logid`，它会被
带到 `outcome.logid` 并在 Account Hub 的失败行末尾显示 ` · logid <值>` ——
这是向服务端追查单次请求的唯一线索。三段链路与取舍见前面的
「失败诊断的 logid 透传」。

**余额按 `available_endpoint` 分池，面板只显示通用池**：

| 面板 | `available_endpoint` | 谁在花这个池 |
|---|---|---|
| Trae CN（本插件唯一的 Trae 面板） | `0`（通用积分） | **IDE 对话**（本插件主路径） |
| —（已无面板展示） | `1`（Work 积分） | **TraeWork**（`work.trae.cn` 网页版 / 桌面版） |

**语义锚点：面板显示的数字 = 该 provider 实际能花的池**。两个池**互不通用**，
各自只有一条路径能花掉它 —— Trae CN 面板因此只显示通用池那一个数字与那批资源包，
界面上不出现「通用」「Work」字样。

**Work 积分的准确口径**（取代早先「chat 只扣通用池」的简写）：

- **Work 专属积分只在 TraeWork 里能花**（`work.trae.cn` 网页版 / 桌面版）——
  本插件的 TraeWork 路径 provider 已于 `47bd690` 随官方合并移除，
  故这部分积分**不在任何面板展示**；
- **TraeCode / IDE 对话只消耗通用积分** —— 也就是本插件走的那条路径；
- 在 TraeWork 中两类积分按**到期时间先后**扣，Work 专属**仅在到期时间相同时**优先；
- **2026-09 起签到发的是通用积分**（不是 Work 专属）。

选池在 `credits.balances` 的 trae-cn 分支里**内联 `TRAE_CN_POOL_UNIVERSAL`**，
作为 `fetchTraeCnCreditBalance` 的第三个参数；返回的 `total` 与 `packages`
**只含那一个池**（另一个池的礼包被过滤掉，`expiredTotal` 也按本池汇总）。
`TraeCnCreditBalance` 因此与共用的 `CreditBalance` **逐字段同构**，
`collectCreditBalances` 直接复用。

> ⚠️ **选池与「查谁的账号」是两件事，不可合并**。账号查询走 `poolProviderFor()`，
> 选池走上面那个内联常量：`poolProviderFor()` 只是把面板 id 翻成账号池键的**收敛点**
> （今天恒等）。历史上面板 id 曾被它映射到 `trae-cn`（那是一个复用同批账号的
> TraeWork 路径 provider 的需求，该 provider 已移除），拿映射后的键去选池会让面板
> 显示另一个池的余额 —— 不报错，只是数字不是它能花的钱。

> ✅ **前端只渲染一个数字**：`CreditBalanceRow` 不做任何池判断（它的输入与其余
> provider 逐字段同构）。历史上那套「双池超集 + `workTotal` 两段渲染」已随分池
> 一并删除 —— 同一处显示两个池时，永远有一段是那个面板花不掉的；合并的前提
> 消失后，「绝不把两池相加」这条提醒也就不再有对象。
> `tests/unit/jet-hub-credit-balance-row.spec.ts` 用整树深比较守住，含「喂进旧的
> 双池字段也不多渲染一段」。改动前端后必须 `pnpm build:all` 重建客户端 bundle。

**判定一律以 body `code` 为准，不看 HTTP 状态**（对齐 Buddy 系既有约定）：
无 auth 时服务端返回的是 **HTTP 200 + `code:1001` + `enable:false`**，按状态码判
会把它当成成功。`code:1001` 在两个端点上的文案统一为「凭据已失效，请重新登录」。

> ✅ **T7 已按真机校准（2026-09-18）**：该端点响应**没有 `code` 信封** ——
> 顶层是 `{"is_credits_billing":…,"usage_summary":{…},"user_entitlement_pack_list":[…]}`
> （沿用 code 信封会让余额**恒失败**，与「余额为 0」无关）。礼包数组在**根层**
> `user_entitlement_pack_list`；额度嵌在
> `entitlement_base_info.product_extra.package_extra.quota.credits_limit`
> （回退 `entitlement_base_info.quota`），**余额 = `credits_limit` −
> `usage.credits_amount`**（`usage` 可为 `{}`，按「该包未产生用量」计 0）；
> `available_endpoint` 也在 `entitlement_base_info` 里（不在条目顶层）。
> 候选表（`TRAE_CN_BALANCE_ARRAY_KEYS` / `_REMAIN_FIELDS`）、指纹扫描与三级回退链
> **全部保留作兜底**，但主路径是上述嵌套口径。真机样例：endpoint=0 包
> limit 2000 / consumed 2000 → 通用池 **0**；endpoint=1 包 limit 2000 /
> `usage:{}` → Work 池 **2000**。
>
> ⚠️ **T8 仍待校准**：领取响应里「本次获得积分」的字段名
> （`TRAE_CN_CLAIM_CREDIT_FIELDS`），未命中时按 0 计并输出一行**只含字段名、
> 不含值**的日志。status / claim 的其它逻辑真机全通，未动。
>
> 两处的调试出口是 `TraeCnCreditsOptions.onDebug`，在 RPC 分发处接到
> `ctx.logger.info`（**看宿主日志，面板上看不到**），输出一律只有键名与结构判定。

## Qoder provider（Qoder）

> ⚠️ **本章覆盖两个 provider**：`qoder`（国际版）与 `qoder-cn`（国内版，见下面的
> 「Qoder CN：第二个 region」小节）。标题保留 `Qoder` 是为了不改变本页既有锚点
> （正文里多处 `#qoder-providerqoder` 链接指向它）。

**两个独立路由**：`qoder`（**Qoder**，国际版）与 `qoder-cn`（**Qoder CN**，国内版）。
两者是**同一份协议的两个 region**，实现是独立一套 `src/qoder*.ts`
（`qoder-product.ts` / `qoder-auth.ts` / `qoder-adapter.ts` / `qoder-errors.ts` /
`qoder-models.ts` / `qoder-credits.ts`），只共用架构模式（产品配置驱动、账号池、
限流切换、模型黑名单）。**代码只有一份**，region 差异全部收敛在
`src/qoder-product.ts` 的两份 `QoderProduct` 配置里（见下节），故下文除专门标注
CN 的地方外，两个 region 行为一致。

⚠️ **四个端点散在三个不同的 host** 上（`openapi.qoder.sh` 承载其中两个），
这是它最容易被写错的地方。**CN 是另一组三个 host**，一套都不能混用 ——
拿国际版 host 打 CN 凭据得到的是「凭据失效」的**假象**。

该 provider 与既有各条线**均不同源**，其中两项是本插件里的头一份：

- **浏览器设备流登录**（官方 CLI / 桌面端同款，两段式 RPC + 轮询）。CN 沿用同一套
  实现（**同一套流程、零分叉**，只有域名与 `machine_id` 目录不同）。
  > ⚠️ **PAT 粘贴形态已于 2026-09-21 从 UI 移除**（用户要求「不要 pat 登录，
  > 只要浏览器登录」）：客户端不再有 PAT 表单与形态选择器。**库层与协议层保留** ——
  > `src/qoder-auth.ts` 的 `loginWithPat`、`src/jet-hub-rpc.ts` 对
  > `account.create` 载荷里 `pat` 的分派一行未动，服务 headless / 测试 / 未来形态。
- **凭据只有一件长效物**（令牌），PAT 路径换来的 job token 是**进程内运行时
  缓存**、**不落盘**；设备流路径连 job token 都不需要（`dt-` 直接当 Bearer）。

| 项 | 腾讯系（Buddy CN / Buddy） | LobsterAI | Trae CN | **Qoder / Qoder CN** |
|---|---|---|---|---|
| 登录 | 轮询后端 API | 本地回调收 `authCode` | 本地回调 + PKCE(S256) | **设备流（PKCE + 轮询）** |
| 长期凭据 | access + refresh | access + refresh + 身份字段 | 五件套 | **两件**（设备流 `token` + `refresh_token`） |
| 鉴权 | `Bearer` + 归属头 | `Bearer` | `Cloud-IDE-JWT` | **`Bearer`（但分令牌族：设备令牌直接用，PAT 先换 `jt-`）** |
| 续期 | `X-Refresh-Token` 头 | `POST /api/auth/refresh` | exchange（body 四字段） | **按令牌族分派**：PAT 重打 exchange、设备令牌打 `deviceToken/refresh` |
| 签到 | Buddy CN 有、国际版无 | 三步 | 两步 + 设备头 | **不做**（国际版无此活动；CN **疑似有但端点未知**） |

### 登录：浏览器设备流

「+ 新建账号」直接开一个登录窗口（**没有**形态选择器）：

| 形态 | 用户做什么 | 宿主做什么 |
|---|---|---|
| **浏览器登录** | 在新标签页的官方授权页上选账号并确认 | 两段式：`loginUrl` 秒回 → 轮询拿到令牌（**无换令牌步骤**）→ 补全占位账号 |

> **PAT 粘贴形态已移除**（2026-09-21）。宿主仍接受 `{ provider, pat }` 载荷
> （协议层分派），但**客户端不再发出**它，故上面这张表只剩一行。

#### 设备流协议（三步，全部照抄官方 CLI 取证）

1. **PKCE**：`verifier` 64 字符随机（48 字节 base64url）、
   `challenge = base64url(sha256(verifier))`、`challenge_method: "S256"`；
   `nonce = randomUUID()`；
2. **登录 URL**：`{authBaseUrl}/device/selectAccounts?challenge&challenge_method
   &nonce&machine_id&client_id` —— ⚠️ **CN 的 `redirect_uri` 是 null，不带该参数**；
3. **轮询**：`GET {openapiBase}/api/v1/deviceToken/poll?nonce&verifier
   &challenge_method&machine_id`，**404 → 1 秒后重试**、总超时 **5 分钟**；
   成功判据照抄官方 `nec()`：**`token` 是非空 string**（`refresh_token` 不作要求）。

> ⚠️⚠️ **轮询返回的就是令牌本体，设备流没有「换令牌」这一步**
> （2026-09-21 真机 400 报障的根因）：官方 `Veo()` 把 poll 的 `token`（`dt-…`）
> 直接写进 `security_oauth_token` / `access_token`，**全程不调
> `exchangePersonalToken`**。`/api/v1/jobToken/exchange` 是 **PAT 专用**端点
> （body `personal_token`），拿 `dt-` 打它恒回 **HTTP 400
> `{"errorCode":"BadRequest"}`** —— 那正是「浏览器授权成功、却卡在换令牌」的来路。
>
> 两代令牌的分工（**两个体系，不可互换**）：
>
> | 令牌族 | 前缀 | 来源 | 换 job token？ | 续期端点 |
> |---|---|---|---|---|
> | PAT | `pt-` | 用户在 Integrations 页签发 | ✅ 打 `jobToken/exchange` | 重打 `jobToken/exchange` |
> | 设备令牌 | `dt-` | 浏览器设备流 poll | ❌ **它本身就是可用 Bearer** | `deviceToken/refresh` |
>
> 官方用显式的 `refreshStrategy` 分派（`'pat'` / `'device-token'`），本插件同构：
> `QoderAuth.getJobToken()` 对 `dt-` **原样返回**（零网络），
> `refreshCredential()` 对 `dt-` 走 `deviceToken/refresh`。

| 常量 | 取值 | 说明 |
|---|---|---|
| `client_id` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | **两区同一个**（官方就是一个 CLI 应用覆盖两区） |
| `authBaseUrl`（国际版 / CN） | `https://qoder.com` / `https://qoder.cn` | ⚠️ **授权页在主站**，不是 openapi host |
| `openApiBaseUrl`（国际版 / CN） | `https://openapi.qoder.sh` / `https://openapi.qoder.com.cn` | 轮询打这里 |

⚠️ **桌面端另有一套 `client_id`（`732aef47-…`），刻意不用** —— 本插件复刻的是
**CLI** 设备流。混用会让设备流以「应用未授权」类形态失败，而登录 URL 表面上完全
正常（只差一个 query 参数的值），故单测从两个方向钉死。

#### `machine_id`：与官方 CLI 同路径同格式

每个产品持久化一个 UUID（36 字符文本）：

| region | 落盘路径 |
|---|---|
| 国际版 | `~/.qoder/.auth/machine_id` |
| CN | `~/.qoder-cn/.auth/machine_id` |

⚠️ **与官方 CLI 共用同一个文件是刻意的**：用户混用官方 CLI 时两边读同一个机器
身份，wasm 签名链才不会因机器码漂移失效。已存在则读用（绝不覆盖），不存在则生成
并落盘（目录递归创建）；**读取 / 落盘失败时退回内存态 UUID 继续用** —— 磁盘不可写
是环境问题，不是「用户没资格登录」。

#### 登录互斥与取消

- **provider 级互斥**：同一 region 已有未结算会话时返回
  `{ok:false, error:'login-in-progress'}`（不新建、不复用）。两区**各自独立** ——
  一区的登录窗口不挡另一区（两区是两批账号、两套令牌）；
- **`account.delete` 会取消**：删掉占位账号即终止轮询并释放互斥槽位。不取消的
  后果比另外几个 provider 更重 —— 它不占端口，却**每 1 秒轮询一次**，且槽位不
  释放会让用户此后所有登录都被 `login-in-progress` 挡住。

### 登录与凭据：浏览器设备流

> ⚠️ **PAT 粘贴形态已从 UI 移除（2026-09-21）**，本节保留 PAT 的协议事实供排障与
> 将来参考；当前面板上**没有**「粘贴 PAT」入口。库层能力与宿主协议分派仍在
> （见上文「PAT 粘贴形态已于 2026-09-21 从 UI 移除」）。

- **长效令牌**：设备流 poll 返回的 `token`（`dt-…`；PAT 形态则是 `pt-` 前缀的
  PAT，官方明示**不自动刷新**：吊销前一直有效，失效只能重签）。
- **Account Hub 的「+ 新建账号」走浏览器登录**：手势内开空窗 → 导航到授权页 →
  轮询补齐账号。PAT 表单（曾经的 `type=password` 内联输入框）已删除。
- 凭据 ref：单账号 `QODER_PERSONAL_TOKEN`；多账号
  `QODER_ACCOUNT_<SHORTID>`，由「+ 新建账号」生成。
- 凭据结构（JSON 字符串，字段一律 snake_case）：

  | 字段 | 含义 |
  |---|---|
  | `access_token` | **长效令牌本体** —— 设备流的 `dt-…`（PAT 形态下是 `pt-…`）；设备令牌**直接**当 chat / 额度的 `Bearer`，PAT 则要先换 `jt-` |
  | `refresh_token` | 设备流的 `drt-…`（或 PAT 形态的 `jrt-…`）；设备令牌族用它打 `deviceToken/refresh` 续期 |
  | `token_expires_at` | 令牌过期时刻（设备流是 `dt-` 的 ≈30 天，PAT 形态是 `jt-` 的 24h）—— 调度武装用 |
  | `user_id` / `user_type` | 身份字段，有则带 |

  ⚠️ **两种登录形态写同一种凭据形态**不是图省事：`AccountPool.findAccountIdByCredential`
  对非 codearts 的 provider 统一取 `access_token` 作身份标识，换字段会让限流记账
  **静默**失配。（PAT 形态虽已从 UI 移除，这条契约仍被 headless 路径依赖。）

- **三段令牌，三种生命周期**：长效令牌（设备流 `dt-…` ≈30 天；PAT **不刷新**）／
  `refresh_token`（`drt-…` ≈360 天，或 PAT 形态的 `jrt-…` 48h）／`jt-` 24h。
  ⚠️ **只有 PAT 路径才有 `jt-`**：设备令牌自己就是 Bearer，不经 `jt-`。
  `jt-` 是**进程内运行时缓存**、**按令牌分键**，进程重启即冷 —— 冷启动会多打
  一次 exchange，这是设计如此，不是故障。剩余有效期不足 1 小时时主动重换。
  设备令牌族走 `deviceToken/refresh`，同样只在剩余不足 1 小时（或缺失过期
  声明）时才打，避免每 30 分钟的批量续期做无用功。

> **`status().expiresAt` 对 Qoder 恒不返回**（账号条目也不写 `expiresAt`）：
> 令牌的过期时间口径两代不同，而账号卡片的口径只能有一个 —— 填错会让卡片在
> 闲置后显示「已过期」，而实际上下次请求会按需重换、一切正常。
> 宁可少显示一行，也不报一个假的过期。

### 端点：同一件事分散在三个 host，凭据还分红

| 用途 | 端点 | 凭据 |
|---|---|---|
| 换 job token（**仅 PAT**） | `POST https://openapi.qoder.sh/api/v1/jobToken/exchange`，body `{"personal_token":"<PAT>"}` | 无（匿名头） |
| 设备令牌续期 | `POST https://openapi.qoder.sh/api/v1/deviceToken/refresh`，body `{"refresh_token":"<drt-…>","machine_id":…}` | 无（匿名头） |
| chat | `POST https://api2-v2.qoder.sh/model/v1/chat/completions` | `Bearer jt-…`（PAT）或 `Bearer dt-…`（设备流） |
| 模型目录 | `GET https://api.qoder.com/api/v1/cloud/models` | **`Bearer <PAT>`** |
| 额度 | `GET https://openapi.qoder.sh/api/v2/quota/usage` | **`Bearer jt-…`**（PAT）或 `Bearer dt-…`（设备流） |

⚠️ **两条最易错的地方**（都在实测里踩过）：

1. **exchange 的 body 键名必须 snake_case `personal_token`** —— 写成 camelCase
   `personalToken` 实测回 400 `{"errorCode":"BadRequest",…}`；
2. **目录只认 PAT、chat 与额度只认 `jt-`** —— PAT 直打 chat **恒 401**
   （`{"error":"unauthorized"}`，且伪造的同长度 PAT 返回逐字节相同的响应，
   说明这是「令牌形态类」拒绝），PAT 打额度端点回 401 `TOKEN_EXPIRE`。
   **四个端点不同源**，不要图省事统一成一个凭据。

`POST /api/v1/jobToken/refresh`（用 `jrt-` 换新 `jt-`）只登记常量、**未实现也未实测**
—— 续期主路径就是重打 exchange。

### chat 与流式：标准 OpenAI 协议，但收尾判据只有一条

**chat 是标准 OpenAI 协议**：`messages` **原样透传，没有任何出站改名**
（与 Trae CN 的 SOLO 通道刻意相反）。两点必须保留：带
`metadata.context.client_type: "qodercli"`（**出站身份标识，一字符不能动**）、
UA `qoder/1.1.16`；`stream` **恒为 true**。

⚠️ **`tools` 必须包裹成 OpenAI 标准形态，不能原样透传**（2026-09-21 真机报障纠正）：
harness 的 `ToolSchema` 是 `{name, description, parameters}`，而本端点要的是
`{type:'function', function:{…}}`。**原样透传会让非 `lite` 模型恒回 HTTP 200 流内
`provider_error`**，用户看到的就是：

```
本轮运行失败 Qoder 上游返回包装码 provider_error（未能从 details 中二次解析出真码）：Error in upstream response
INVALID_REQUEST
```

`details` 里上游把话说明白了：`'function' is a required property, expected an object -
'tools.0'`（`qmodel`）、`Invalid request: unknown tool type: , currently only function and
plugin are supported`（`kmodel`）、`tools[0].type: unknown variant ..., expected function`
（`dmodel`）。**`lite` 是唯一两种形态都不报错的模型**（走上游宽松兼容路径），所以这个
缺陷只在非 `lite` 模型上暴露 —— 当年 T2 漏检正是因为它发的是**手写的 OpenAI 形态**，
而不是 `GenerateOptions.tools` 的形态。包裹后功能未受损：`qmodel` / `gmodel` / `dmodel` /
`lite` 实测仍回标准结构化 `tool_calls`。

**三条流式硬事实**（T3 实测矩阵）：

1. **`[DONE]` 是唯一成功收尾判据**。两类错误（网关层 pre-stream 错、HTTP 200 的
   流内 error 帧）**都不出 `[DONE]`** —— 因此「没等到 `[DONE]` 的流」**绝不静默
   当优雅结束**，而是报 `TRANSPORT`。静默当成功等于把失败伪装成空回复。
2. **`stream:true` 会把 400 变成 200 + 流内 error 帧**：同一个坏 body，非流式回
   400、流式回 200。故流式路径**必须解析流内错误**，只看状态码会漏掉全部
   上游 body 类错误。
3. **成功流的 usage 帧会被注入一个裸 LF**（真实缺陷，7 次成功流中 **5 次**中招）：
   大 usage 帧的 JSON 中段被凭空插入一个 `0x0A`。恢复规则是「`data:` 行与紧随的
   下一段**无分隔符直接拼接**」—— `JSON.parse(L1 + L2)` 通过，而
   `JSON.parse(L1 + "\n" + L2)` 失败（那个 LF 不属于原文）。

**工具调用**：标准结构化 `tool_calls`（非流式 `message.tool_calls`、流式
`delta.tool_calls` 增量分片），arguments 是 JSON 字符串 —— **协议层无障碍**
（⚠️ 前提是 `tools` 已按上面的标准形态包裹；未包裹时上游直接拒绝整个请求）。
⚠️ 但 forced `tool_choice` 时 `finish_reason` 是 **`"stop"` 而不是 `"tool_calls"`**
（auto 才是），故聚合逻辑**只看 delta 本身，不看 `finish_reason`**。

### 错误分类：402 是候选不是结论，401 先当令牌过期

| 上游表现 | 分类与动作 |
|---|---|
| `402` + `code:116` | **额度类候选**（`quotaCandidate`），动作仍是直报 —— 必须由额度端点**二次判别**后才允许换号 |
| chat `401 {"error":"unauthorized"}`（**无业务码**） | 先当「`jt-` 过期」：**静默重换一次 exchange 再试**；仍 401 才判 PAT 失效 |
| 额度端点 `401 TOKEN_EXPIRE` / `TOKEN_INVALID` | 分别映射「重换 `jt-`」与「重新粘贴 PAT」（靠文案分型） |
| 流内 error 帧 | **直报业务码**：`invalid_parameter_error` / `invalid_model_error` / `provider_error`（**包装码**，真因在 `details` 里，需二次解析） |
| 未收到 `[DONE]` | 报 `TRANSPORT`，**不静默成功** |

⚠️ **`provider_error` 的 `details` 有四种实测形态**（2026-09-21 真机），解析器
（`parseQoderWrappedDetail`）**既认码也认文案**，否则多数形态会退化成
「未能从 details 中二次解析出真码」这个把真因藏起来的说法：

| `details` 形态 | 解析结果 |
|---|---|
| `{"error":{…,"code":"invalid_parameter_error"},"id":"…"}`（T3 原形态） | 真码 |
| `data: {"error":{…}}`（**整段带 `data: ` 前缀的 SSE 帧原文**，末尾还带换行） | 真码（剥壳后） |
| `{"error":{"message":"…","type":"invalid_request_error"}}`（**无 code**） | 只有上游文案 |
| `{"error":{"code":"1210","message":"API 调用参数有误，请检查文档。"}}` | 真码 + 上游文案 |

⚠️ **流内** `provider_error` 帧的真因同样只在 `details` 里（外层 `message` 恒是无信息量的
`"Error in upstream response"` / `"All models failed"`），故 `parseQoderStreamErrorPayload`
带出 `details`、适配器流内分支把它作为 `body` 交给分类器 —— 这两处此前都缺，
是「真因被藏」的次要成因。

⚠️ **`402 + code:116` 在本 provider 上有语义污染**：quota=0 的账号上，**无效模型名
也回同一个 402 `code:116`**（网关先做扣费检查）。故它**只是候选**，绝不硬编码成
「换号可救」—— 未确证一律直报。401 没有 `code` 字段、402 的 `code` 是**数字**
`116` 而 400/流内的 `code` 是**字符串**，分类器两种都收。

### 模型目录与思考档

- **动态目录**：`GET /api/v1/cloud/models`（PAT 直连）+ 静态兜底。
- ⚠️ **目录返回全表 + `is_enabled` 标记**：T1 快照 17 项里**仅 2 项**
  `is_enabled:true`（`qmodel_38max` / `qfmodel`）。故**拉取成功时只播报
  `is_enabled === true` 的项**（只认严格 `true`，字段缺失不保留）。
- **`lite` 不在官方目录，但实测可用**（免费遗留路径）—— 所以**只在目录失败、
  回退静态表时才出现**。这条不对称是**刻意的**：动态目录拿到了就绝不把静态项
  并进去（并进去等于伪造「官方认可 lite」）。
- **12h TTL 缓存，失败不写缓存**（也不清掉已有缓存）。
- ⚠️ **目录的 `id` 是短 key**（`qmodel_38max` / `qfmodel` / `gmodel` / `dmodel` /
  `mmodel`…），**不是 tier 名** —— `auto` / `efficient` 当 model 值发会回 402。
- **目录 roster 会浮动**（与官方 CLI 表、国内版表都不同），**绝不硬编码全表**：
  静态兜底只保留「目录失败时最可能仍然可用」的 **3 项**。
- **`efforts` + `default_effort` 是思考档位的权威来源**（T1 实测值域
  `low` / `medium` / `high` / `xhigh` / `max`），档位 id **逐字符照抄**；
  `default_effort` 只在落在 `efforts` 列表内时才声明。

⚠️ **思考档位的下发字段是 `reasoning_effort`，属「透传不拦截」策略**：DSH 给了就
下发，适配器**不补档也不改档**（不带时整个字段不发）。**该字段是否真生效尚未
验证**（计划 §3 风险登记，真机验收另做）—— 这与 Trae CN / LobsterAI 那两处
**性质不同**：那两处是已取证的「字段被服务端真实消费」，此处只能说「已把目录值
透传到请求体」，**不能说档位已生效**。

⚠️ **模态恒为纯文本**：适配器 `inputModalities` **只声明 `['text']`**，
**故意不按**目录的 `is_vl:true` 声明。理由：模型支持图片 ≠ 本适配器的 chat 路径
能送达（`serializeQoderMessages` 只搬运文本块）。把 `is_vl` 报成「支持图片」会让
DSH 把图片路由过来、然后在序列化时静默丢掉。

`maxTokens` 只记录不 materialize（与 Trae CN 同则）；目录的
`default_context_window` 有 `272000` 这类非整值，**不当常量**。

**上下文窗口档位**：目录的 `available_context_windows`（真机 `[200000, 400000, 1000000]`）
归一后记进 `contextTiers`（升序去重、**≥2 档才记**），Account Hub 的「显示列表」据此
渲染单选列 —— **默认档是最小档**（`default_context_window`），其余可升档。两个 region
各读各的目录（静态兜底表不带档位表，故目录失败时该列不渲染）。机制与红线见
[上下文窗口档位选择](#上下文窗口档位选择)。

### 额度余额与能力矩阵

**端点**：`GET https://openapi.qoder.sh/api/v2/quota/usage`（`Bearer jt-…`）。

- **三池结构，后两池可缺席**：`userQuota`（必有）、`addOnQuota`、
  `orgResourcePackage`（后两池**本账号缺席**，解析**容缺**）；
- **余额 = 三池 `remaining` 之和**（缺席按 0、负数 clamp 到 0、两位小数规整）；
- ⚠️ **主池耗尽 ≠ 额度耗尽**：只要加量包或资源包里还有余额，这个账号就还能用 ——
  这是换号判据的语义前提；
- **包名取池类型**（响应里**没有**包名字段）：中文名「主额度」/「加量包」/「资源包」；
- **「查不到」与「余额为 0」严格区分**：失败返回 `null` + `error`（卡片显示原因），
  三池确实全空是一个**成功的查询**（`total: 0`）；
- `expiredTotal` 恒为 0，且这是有依据的：quota 端点只在**账号级**给一个
  `expiresAt`，**池本身没有失效字段** —— 拿账号级时间戳当池失效判据会在哨兵值上
  产出**假的**「另有 N 已失效」，把一个满额账号显示成 0 分。

**能力矩阵**：`balance: true`、`dailyCheckin: false`。

⚠️ **签到刻意不做，且理由与 Buddy（国际版）不是同一种**：

⚠️ **签到刻意不做，且两个 region 的理由不是同一种**（这一条与 `credits-capabilities.js`
的矩阵注释同源，改一处必须改另一处）：

- **Qoder（国际版）**：**活动不存在** —— CLI2API 实测国际版不显示签到；官方的
  每日 **100 Credits** 只能在 **Qoder 桌面 App 里手动领取**，服务端没有暴露可编程
  的签到端点。本插件也不打算用任何「模拟桌面客户端」的手段去领
  （既不可靠，也超出本插件的边界）；
- **Qoder CN（国内版）**：**疑似有这项权益，但端点未知** —— CLI2API 的
  `RegionDescriptor` **只在 cn 一侧挂了 Checkin**。故矩阵里的 `false` 是
  「**端点未知、未验证**」，**不是**「没有权益」、更不是「与国际版一样不存在该活动」。
  **拿到端点后要把它翻成 `true`**（届时宿主侧还要补 `credits.status` /
  `credits.claimAll` 的 `qoder-cn` 分支）。

故 Qoder CN 面板**渲染**积分行与「刷新积分」、**不渲染**「一键领取积分」。

### Qoder CN：第二个 region

`qoder-cn`（显示名 **Qoder CN**）是 Qoder 的**国内版**，与 `qoder`（国际版）
**同协议、双 region**：真机探测确证 exchange / quota / models 三个端点的**错误信封
逐字节同构**、PAT 前缀同为 `pt-`、目录字段同构。故**代码只有一份**，差异全部收敛在
`src/qoder-product.ts` 的两份配置里。

⚠️ **两区是两套账号、两套 Credits、两套令牌**：

- **令牌互不承认**：拿国际版 host 打 CN 凭据（或反之）得到的是「凭据失效」的
  **假象** —— 看起来像「我的 PAT 不对」，实际是打错了 region；
- **账号池独立**：凭据 ref 前缀 `QODER_CN_ACCOUNT_*`（国际版是 `QODER_ACCOUNT_*`），
  账号条目 `provider` 为 `qoder-cn`。两个面板**互相看不到对方的账号**，
  且 `poolProviderFor('qoder-cn')` 是**恒等映射** —— 该函数今天对每个 provider 都恒等，
  **没有任何 provider 共用别人的账号**，不要凭想象给 qoder-cn 造一条映射；
- **PAT 与设备流授权页都不通用**：CN 面板的签发链接指向 `qoder.cn`，浏览器登录
  也打在 `qoder.cn` 的授权页上 —— 不是国际版那一页/那一站。设备流两区共用同一个
  `client_id`（官方就是一个 CLI 应用覆盖两区），但 `machine_id` **各存各的**
  （`~/.qoder-cn` vs `~/.qoder`）。

**CN 的三个基址**（与国际版逐个不同，且**不带 `-v2` 段**，不要按同形替换去猜）：

| 用途 | CN 端点 | 状态 |
|---|---|---|
| 换 job token / 额度 | `openapi.qoder.com.cn` | ✅ 真机实测 200 |
| 模型目录 | `api.qoder.com.cn` | ✅ 真机实测 200 |
| chat | `gateway.qoder.com.cn` | 🔴 host 是官方源码值，但**该路径不存在** —— chat 对本插件的凭据形态**结构性不可用**（见下） |

⚠️ **CN 的 chat 不是「上游未就绪」，而是路径不存在 —— 不会恢复，也不需要等**。

二次取证定案（2026-09-21，真机矩阵 + 用户机器上官方 Qoder CN IDE 0.3.4 的
`qodercli.log` 佐证）：

1. **503 是路径级的**：`/model/v1/chat/completions` 在 CN 的 `gateway.qoder.com.cn`
   上**不存在**。ALB 对「该路径 × 任意方法 × 任意头」恒 503——无 `Authorization`、
   垃圾 `jt-`、空 Bearer 四种组合返回的 alb 错误页**逐字节相同**；而**同 host** 的
   `/api/v2/config/getDataPolicy` 返回**应用层** 401/400（证明路径活着）。
   故与凭据、请求头、网络出口**全都无关**，**不会自行恢复**。
2. **官方客户端的 chat 走另一条路径**：`/algo/api/v2/service/pro/sse/agent_chat_generation`
   （`qodercli.log` 实录 POST 该路径 200）。
3. **那条通道有 WASM 签名门槛**：官方请求由 `qoder_auth_wasm` 的
   `prepareInferRequest` 生成，构造需要 `machineId` + `cosyVersion` +
   `userInfoJson` 里的用户密钥。用有效 `jt-` 直接打会得到 200 + SSE，
   但**帧内**是 `{"code":"101","message":"Signature invalid"}`。

> ⚠️ **2026-09-21 接线后推翻：上面第 3 条的结论「两种登录形态都给不出用户密钥
> ⇒ 永远过不去」是错的**，本插件的 PAT 与设备流凭据**都拿得到**签名四要素：
> `machineId` 走登录链落盘的同一份文件、`security_oauth_token` 就是 PAT 换来的
> `jt-`、`uid` 取自 `GET {openapiBase}/api/v1/userinfo`。真机 A/B（只改 `uid`
> 一处）：**空 uid → `101`；真实 uid → HTTP 200 + SSE 真内容**。
> 故 CN 的 chat **不是**结构性不可用，而是缺一次接线 —— 现已接上
> （见「Qoder wasm 签名链」；三档真机请求 105 B / 4 KB / 40 KB 全部走通）。
> **第 1、2 条仍然成立**：`/model/v1/chat/completions` 在 CN 网关确实不存在
> （路径级 503，不会恢复），CN 也**不会再**打那条路径。

⇒ host 常量**保留**（逃生阀与未来协议变化仍用它），错误分类**按 region 分流**：
CN 的 chat 503 **直报、不退避、不换号**（退避重试一个不可能成功的请求纯属误导）
—— ⚠️ **该分支现在是兜底**：CN 的正路是签名路径，只有逃生阀把 CN 指到别处、
或将来有人把它误接回 REST 才会走到这里；国际版的 503 维持「网关瞬时故障 →
退避重试同一账号」不变。

> **绝不要因为「打不通」就把它改成国际版 host**：实测 **CN 的 `jt-` 打国际版
> chat 会回 401**（两区令牌互不承认），于是「路径不存在」会被**伪装成
> 「凭据失效」**，把用户引向反复重贴 PAT 的死路。
>
> **控制面不受影响**：CN 的目录（14 项）与额度两条线**都实测 200**，
> 换令牌（exchange）也正常 —— 只有 chat 这一条对 PAT 走不通。

### Qoder 签名链（wasm）—— 上面第 3 条的结论已被推翻（2026-09-21 真机实证）

⚠️ **上面「两种登录形态都给不出用户密钥 ⇒ 永远过不去」不成立，保留原文以存档推理过程。**
真机实测（CN PAT 凭据）：**`POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation`
→ HTTP 200，SSE 出真内容** `{"choices":[{"delta":{"content":"pong","role":"assistant"}…}],"model":"auto"}`，
`101 Signature invalid` 不再出现。

**密钥不是「给不出」，而是由 wasm 自己派生**：先用**五个业务字段**
（`uid` / `security_oauth_token` / `organization_id` / `organization_tags` / `data_policy_agreed`）
调 `generate_runtime_auth_fields` 拿 `{encrypt_user_info, key}`，**再并进** `userInfoJson` 才能构造上下文
（漏了 wasm 直接抛 ``Invalid user info: missing field `encrypt_user_info` ``）。这正是官方
`regenerateRuntimeFields()` 的做法，PAT 路径同样要跑。

**真正的门槛是 `uid` 必须是真实用户 id**（真机单变量 A/B，同一请求只改这一处）：

| `uid` | 结果 |
|---|---|
| 空串 | `{"code":"101","message":"Signature invalid"}` |
| 真实 id | **HTTP 200 + SSE 真内容** |

`uid` 取自 `GET {openapiBase}/api/v1/userinfo`（Bearer `jt-`，官方 `fetchOpenApiUserInfo` 的端点），
字段回退序 `id → user_id → uid`。⚠️ `exchange` 响应**不含** userId。

**实现**（两区共用一份，`src/qoder-wasm*.ts`）：

- **wasm 来源**：运行时三级提取（本机已装 Qoder → npm → 官方 CDN），每级提取后 SHA-256 校验
  （`6419471e…`，298 606 B，**四个来源同值**），缓存到 `~/.dsh/qoder-wasm/`。
  ⚠️ **wasm 字节不提交进仓库、不随插件包分发**，`src/` 里只有提取/加载代码。
- **调用形态**：`prepareInferRequest(host基址, body, modelKey, modelSource)` 返回
  **`{url, headers, body, free}` —— 三者必须整包替换**。返回的 `body` 是**密文**；
  只补签名头不换 body 必回 `101`。
  ⚠️ 第一个参数是 **host 基址**（`https://gateway.qoder.com.cn`），**不是完整 URL**（传完整 URL 会得到路径重复两遍的 URL）。
- **`machineId` 走登录链落盘的那一份**（设备流写的同一个文件），调用方不必传。
- **glue 是手写复刻的**：官方那份内联在 35 MB worker runtime 里，本插件不整体加载它。

⚠️ **签名路径的帧是双层信封，不是裸 OpenAI chunk（实测推翻）**：真机每帧是
`data:{"headers":{…},"body":"<内层 JSON 字符串>","statusCodeValue":200,"statusCode":"OK"}`
—— 内层**再 `JSON.parse` 一次**才是标准 chunk；收尾是 `"body":"[DONE]"`
（⚠️ **`[DONE]` 也被包着**，不是裸哨兵）。剥离判据见 `unwrapQoderFrame`：
**`statusCodeValue` 是数字 + `body` 是字符串，两个都在**才当信封 —— 只认 `body`
会误伤国际版的裸帧（有反向断言钉死）。真机夹具
`tests/unit/fixtures/qoder-cn-signed-sse.sse.txt` 是逐字节副本（内容只有 `pong`，无凭据）。

⚠️ **接线范围**：只有 `qoder-cn` 的 chat 走签名路径；**国际版一行未动**（REST + `jt-`，
有逐字节回归用例）。`QoderAdapterOptions.signing` 由 `src/index.ts` 注入
`QoderSigningProvider`（**per-region 实例** —— 签名器把 `product` 绑在构造时，
共用一个实例会让 CN 的机器码去签国际版的请求）。
⚠️ **CN 未注入 `signing` 时直接抛错、绝不回退 REST**：回退只会得到上游 503，
用户看到的是「网关故障」而不是「插件没接线」，后者才是可修的配置错误。

**国际版同路径**：签名**有效**（无 `101`），但其 host **不是 `api2-v2.qoder.sh`**（该 host 404）
而是 **`api1.qoder.sh`**（实测 200）；即便签名通过，body 形态仍回业务
`400 flow nodes found for router agent_router` ⇒ **协议可达、参数待校准**，
国际版大上下文的字节墙问题因此**尚未验证**。本次未把国际版接上签名路径。

**逃生阀**：`QODER_MODEL_SERVER_HOST` 环境变量可覆盖 chat 的 host（含显式 scheme），
用于指向自建网关或本地抓包调试：

```powershell
# 只覆盖 host（scheme 缺省时按 https 处理）
$env:QODER_MODEL_SERVER_HOST = 'gateway.qoder.com.cn'
# 也可以写全 scheme（自建反代 / 本地抓包调试）
$env:QODER_MODEL_SERVER_HOST = 'http://127.0.0.1:8080'
```

⚠️ **对 CN 而言它改的是传给签名器的 host 基址**（`prepareInferRequest` 的第一参），
而**不是**签名结果里那个完整 URL（后者含 `?FetchKeys=…` 查询串，事后「修正」会改坏它）。
它**不会**让 CN 的 chat 变回走 REST —— CN 的正路就是签名路径。真正有用的场景是
**自建带签名的反代 / 本地抓包调试**。

三条语义（与官方 CN CLI 一致，本插件不发明新开关）：

- ⚠️ **只影响 chat**：`openapiBase`（exchange / 额度）与 `modelsBase`（目录）
  **不受影响** —— 把另外两条控制面一并改掉会让「只换 chat 出口」的用法直接失效，
  且失败形态是「凭据失效」，极难诊断；
- **路径与查询串一律丢弃**，只有主机生效 —— ⚠️ 对**国际版**而言路径恒为
  `/model/v1/chat/completions`；对 **CN** 而言它只改「传给签名器的 host 基址」，
  路径与查询串由 wasm 在签名结果里给全（含 `?FetchKeys=…`），**不**再过这个函数；
- **显式 scheme 优先**：裸主机名沿用原基址的 `https`，但写了 `http://` 就按 http 发
  （指向本地代理时不会被悄悄升级成 https 而得到一个 TLS 失败）；
- **请求时读取**（不是启动时定型），进程起来后再设也生效；
- 该变量作用于**两个 region**（它是「本机怎么连上游」的运行期开关，不是 region 配置）；
  不设它时一律走 `product.chatBase`。

**CN 的三项出站身份标识**：

- **UA** = `qoder/1.1.58`（⚠️ 官方源码模板 `` `qoder/${版本}` ``，**与 region 无关**）
  —— 版本号取自官方 CN CLI。⚠️ 曾经写成 `qodercn/1.1.58`：那是把 **npm 包名**
  `@qodercn-ai/qoderclicn` 当成了产品名而推断出的**错值**，已按官方源码校正；
- `client_type: "5"` —— chat 请求体 `metadata.context.client_type`，取自官方 CN CLI
  的 `kg()` 默认值 `process.env.CLIENT_TYPE ?? "5"`（国际版是 `qodercli`）；
- **Cosy 头**（`Cosy-ClientType` = `clientType`、`Cosy-Version` = `1.1.58`）——
  ⚠️ `Cosy-MachineOS` / `Cosy-MachineHostname` **刻意不实现**：官方对这两个头是
  **条件性**发送，本插件**不猜机器身份** —— 缺头比错头安全（错头会被后台当真记进设备维度）。

⚠️ **签名路径下这三者的实际出站者是 wasm，不是本插件**：`prepareInferRequest` 返回的
20 个头里就含 `Cosy-ClientType` / `Cosy-Version` / `X-Model-Key` / `X-Model-Source`，
适配器不再自己拼 CN 的头。⚠️ 这不等于「三者的值已被验收」—— 真机走通证明的是
**wasm 那套值可用**；本插件 `send()` 里那段 Cosy 追加代码**对 CN 已无可达路径**，
现属残留（留着防「将来接回 REST 时出站身份静默变化」，`client_type` 仍在请求体里、照发）。
它们与 `Cosy-Version` 一样属「按官方源码照抄、无法单独 A/B」的一类 ——
若被证伪，只改 `src/qoder-product.ts` 一处。

**CN 目录是 14 项快照**（国际版是 17 项、且只有 2 项 `is_enabled`）：

- **全部 `is_enabled:true`** —— 故 CN 的「只播报 `is_enabled` 项」规则实际不过滤掉
  任何一项，但**规则本身不动**（两个 region 共用同一个解析器）；
- **全为短别名 id**（`qmodel_38max` / `qfmodel` / …），与国际版同一套 id 体系；
- **无 `lite`** —— `lite` 是国际版的免费遗留路径，CN 目录里没有它。

### Account Hub 里的 Qoder 面板

`PROVIDERS` 含 **Qoder** 与 **Qoder CN** 两栏（Qoder CN 紧随 Qoder 之后），
能力矩阵两行都是 `balance ✓ / dailyCheckin ✗`：

| 项 | Qoder 面板 | Qoder CN 面板 |
|---|---|---|
| 账号列表 | ✓ 自己的账号（`QODER_*`） | ✓ 自己的账号（`QODER_CN_*`），**与国际版互不可见** |
| 「+ 新建账号」 | ✓ **浏览器设备流**（登录弹窗 + 轮询） | ✓ 同一套实现，只是授权页指向 `qoder.cn` |
| 积分行 / 「刷新积分」 | ✓ 三池之和的**单数字**与资源包明细 | ✓ 同口径（CN 实测两池，容缺解析天然兼容） |
| 「一键领取积分」 | ✗ 无公开 API | ✗ **端点未知**（见上，拿到端点后翻 true） |
| 卡片操作（刷新 / 删除 / 启停 / 重测 / 重置） | ✓ 「刷新」= **重打一次 exchange** | ✓ 同上，打的是 **CN 的** exchange |
| 「显示列表」（模型开关） | ✓ 作用于 **`qoder` 这个键** | ✓ 作用于 **`qoder-cn` 这个键**（两区模型池不同，黑名单必须分开） |

**三处积分端点里只有 `credits.balances` 有 qoder 系分支**：`credits.status` 与
`credits.claimAll` 对 **`qoder` 与 `qoder-cn` 两个 region 都**如实回
`unsupported provider: qoder` / `unsupported provider: qoder-cn` —— 这是
**正确的契约**（两个 region 确实都没有签到流程），不是缺陷。客户端靠能力矩阵在
**发请求之前**就不发这两个请求，与 CodeArts 的既有约定同源。
（⚠️ CN 将来拿到签到端点时，这两条**结构性拒绝**就是要动的地方。）

> **账号昵称不是「真实用户名回填」。** 账号条目的 `nickname` 取凭据里的
> `user_id`，取不到就回退到 accountId —— 本步**没有**做任何「把昵称换成真实
> 用户信息」的事，不要照此期待。PAT 的过期时间本地无从得知，故账号条目
> **不写 `expiresAt`**、`status().expiresAt` **恒不返回** —— 宁可少显示一行，
> 也不报一个假的过期。

### 服务名：机械派生，刻意不声明

`qoder` **无连字符**，`${product.id}Auth` 即 `qoderAuth`，本身就是一个合法的
JS 标识符风格属性名 —— 故 `QoderProduct` **刻意不声明 `serviceName`**。

这与 `trae-cn` → `traeCnAuth`（`src/trae-cn-product.ts` 显式给出）、
`buddy-cn` → `buddyCnAuth`（`BuddyProduct` 的必填字段）是**两条不同的判据**：
那两处是因为**带连字符的机械派生结果不是合法标识符风格**才必须显式声明，
Qoder 恰恰相反 —— 它**没有**需要绕开的东西。给 Qoder 补一个 `serviceName`
不会有任何好处，只会让人以为「所有 provider 都得声明」。

⚠️ **同一份配置类型里，两个 region 落在判据的两侧**：`qoder-cn` **带连字符**，
`${id}Auth` 派生出的 `qoder-cnAuth` 不是合法标识符风格 ⇒ 它**必须**显式声明
`serviceName: 'qoderCnAuth'`（`QODER_CN` 已声明）。所以「`QoderProduct` 不声明
`serviceName`」这句话**只对国际版成立**，不要顺手给两个 region 写成一样 ——
漏声明会让宿主试图挂载 `ctx['qoder-cnAuth']`，而服务名根本对不上。

