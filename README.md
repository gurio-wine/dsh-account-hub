# dsh-account-hub

DeepSeek Harness 插件，提供「账号中心」面板和七个 LLM provider 路由：CodeArts、Buddy CN、Buddy、LobsterAI、Trae CN、Qoder 与 Qoder CN。可在面板中管理多账号、模型列表、账号切换与积分功能。

## 仓库来源

本仓库是独立维护的 GitHub 上游：[gurio-wine/dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub)。早期代码源自 Gitee 的 [iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)，现已独立演进。

## 安装

### 从 GitHub 安装（推荐）

先在对应 profile 的 `pnpm-workspace.yaml`（`~/.dsh/profiles/<name>/pnpm-workspace.yaml`）中允许安装脚本：

```yaml
allowBuilds:
  dsh-account-hub@git+https://github.com/gurio-wine/dsh-account-hub.git: true
```

然后安装：

```sh
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

Git 安装会自动构建插件，无需手动运行构建命令。

### 从源码目录安装（本地开发）

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

本地 `link:` 安装不会自动运行构建；每次修改源码后重新执行 `pnpm build:all`。

### 从旧包迁移

若安装的是 `dsh-codearts-auth`，先移除旧包，再安装新包，并将 `pnpm-workspace.yaml` 的 `allowBuilds` 项更新为上面的包名：

```sh
dsh plugin --profile <name> remove dsh-codearts-auth
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

账号、登录凭据和模型列表设置沿用原有存储，无需重新登录。

### provider 改名与数据迁移

旧 `buddy` 路由现为 `buddy-cn`，旧 `workbuddy` 现为 `buddy`。账号条目和凭据 ref 会自动迁移；迁移判据与冲突处理见[账号中心存储文档](docs/agents/account-hub-storage.md#provider-id-改名迁移)。

## 用法

在 DeepSeek Harness 的插件设置中打开「账号中心」面板。选择对应 provider 后可登录账号、启停或删除账号、调整账号顺序，并管理模型显示与积分功能。登录会先打开授权页，再在后台完成账号登记。

CodeArts 也提供命令入口：`/codearts-login` 登录、`/codearts-status` 查看状态、`/codearts-refresh` 手动续期。其他 provider 从账号中心面板登录。自动路由可在面板中配置候选模型与优先级；它作为一个虚拟 provider 出现在模型选择器中。

## 检查更新与一键更新

打开账号中心页面时会静默检查一次；也可点击页面右上角的 ⇩ 按钮（「检查更新」）。当前更新检查只读取 GitHub Release/Tag，不包含尚未发布的提交。

发现新版本时，提示行会提供「立即更新」按钮。点击后会自动更新 profile 的版本 pin 与 `allowBuilds` 白名单、执行安装并校验 lockfile；完整 pnpm 安装日志可展开查看。已是最新时，「账号中心」标题旁会显示常驻的「已是最新」标签，直到再次检查更新或出现新版本；检查失败则静默处理。

检查和下载需要能访问 `api.github.com` 与 `codeload.github.com`。更新成功后提示建议重启会话生效，因为插件运行时代码在会话启动时加载。

## 开发

```sh
pnpm build:all
pnpm typecheck
pnpm test
```

`pnpm test:e2e:*` 会运行按 provider 划分的线上用例，部分用例可能触发真实登录或积分操作；运行前请查看 [e2e 测试说明](tests/e2e/README.md)。

## 详细文档

- [Buddy 系 provider](docs/agents/providers-buddy.md)：登录、请求协议、模型能力与积分接口。
- [LobsterAI provider](docs/agents/providers-lobsterai.md)：登录续期、模型目录、思考档位与积分接口。
- [Trae CN provider](docs/agents/providers-trae-cn.md)：PKCE 登录、SOLO 通道、模型目录、上下文档位与签到。
- [Qoder provider](docs/agents/providers-qoder.md)：设备流、双 region、WASM 签名链、模型与积分接口。
- [Qoder 签到调查](docs/agents/qoder-undetermined-investigation.md)：账号签到状态无法判定问题的真机调查与结论。
- [CodeArts provider](docs/agents/providers-codearts.md)：OAuth、请求签名、续期与积分接口。
- [积分与签到](docs/agents/credits.md)：签到结果语义、积分余额和能力矩阵。
- [自动签到设计](docs/agents/auto-checkin-design.md)：状态存储、触发时机、sweep 与 RPC 设计。
- [账号中心存储与通用机制](docs/agents/account-hub-storage.md)：账号池、存储迁移、模型开关、账号选择和自动路由配置。
- [自动路由运行机制](docs/agents/auto-route-runtime.md)：请求转发、失败降级、注册生命周期和可见性。
- [CodeArts 上下文窗口](docs/agents/codearts-context-window.md)：远端窗口数据与静态兜底规则。
- [思考死循环止损](docs/agents/reasoning-loop-guard.md)：检测判据、各 provider 接线和止损行为。
- [行首泄漏清洗](docs/agents/course-leak-strip.md)：`课` / `course` 清洗判据与请求历史处理。
