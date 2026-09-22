# e2e 测试说明（重要：部分用例会消耗真实积分）

本目录下的用例会访问**真实线上后端**。请务必按下表理解每个文件的行为，
不要用「一把梭跑整个目录」的方式运行。

> **命名约定（2026-09-18 provider 改名后）**：`buddy-cn-*` = **中国版**
> （Buddy CN，`copilot.tencent.com`，provider id `buddy-cn`，账号 ref `BUDDY_CN_ACCOUNT_*`）；
> `buddy-*` = **国际版**（Buddy / WorkBuddy AI，`www.workbuddy.ai`，provider id `buddy`，
> 账号 ref `BUDDY_ACCOUNT_*`）。**协议字符串（`X-Product-Code: codebuddy` / `workbuddy`、
> `platform: workbuddy-ai`、UA、域名）不随 provider id 改名**，仍是原字面量。

> ⚠️ **凭据 ref 前缀在升级时会被自动搬迁**（这是改名的一部分，不是可选项）：
> 旧 `BUDDY_*`（当年属于中国版）→ `BUDDY_CN_*`，旧 `WORKBUDDY_*`（国际版）→ `BUDDY_*`。
> 也就是说 **`BUDDY_ACCOUNT_*` 这个前缀在改名前后指的是两个不同的产品**。
> 跑本目录的探针前若刚升级过插件，先启动一次宿主让迁移跑完
> （`src/provider-rename-migration.ts`，幂等可重入），否则探针可能读到尚未搬迁的
> 旧 ref 而报「账号为空」。详见 README 的「provider 改名与数据迁移」。

## ⚠️ 会消耗模型积分（发真实 chat/completions 请求）

| 文件 | 闸门 | 说明 |
|------|------|------|
| `buddy-cn-models.e2e.spec.ts` | `DSH_BUDDY_CN_E2E=1` + `DSH_BUDDY_CN_E2E_CONFIRM=yes` | 用适配器拉取 Buddy CN 模型并逐个发一次对话 |
| `buddy-cn-cache-probe.e2e.spec.ts` | `DSH_BUDDY_CN_E2E=1` + `DSH_BUDDY_CN_E2E_CONFIRM=yes` | 直连 `/v2/chat/completions`，发 3 组前缀做缓存对比 |
| `buddy-cn-pool-probe.e2e.spec.ts` | `DSH_BUDDY_CN_POOL_E2E=1` + `DSH_BUDDY_CN_POOL_E2E_CONFIRM=yes` | 用账号池凭据走完整 LLM 链路（取 `provider: buddy-cn` 的账号） |
| `buddy-cn-ratelimit-probe.e2e.spec.ts` | `DSH_BUDDY_CN_RATELIMIT_E2E=1` + `DSH_BUDDY_CN_RATELIMIT_E2E_CONFIRM=yes` | 对记录「限额重置」的账号实发一次请求，**判定是否真限流** |

> LobsterAI **没有**发 chat 请求的 e2e —— 它的对话链路可在 Account Hub 里人工验证
> （选一个模型发一句话即可），单独写探针的边际价值低于维护成本。
> 认证与签到已有只读探针（见下表）。

## 不消耗模型积分

| 文件 | 闸门 | 说明 |
|------|------|------|
| `v4-models.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash / pro（**每日 1000 万免费 Tokens**） |
| `v4-large-write.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash 大文件写入（同上，免费额度） |
| `login.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | 只走 CodeArts 浏览器登录与凭据换取 |
| `buddy-cn-login-probe.e2e.spec.ts` | `DSH_BUDDY_CN_PROBE=1` | 只打印 Buddy CN 登录流程原始响应，不发模型请求 |
| `buddy-claim-probe.e2e.spec.ts` | `DSH_BUDDY_CLAIM_E2E=1` + `DSH_BUDDY_CLAIM_E2E_CONFIRM=yes` | **国际版 Buddy** 真实领取积分（不改模型额度，但会改动账号当日签到状态） |
| `lobsterai-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` | **只读**：凭据结构、客户端版本号动态解析、签到槽位/上下文、积分余额。**不签到、不发模型请求** |
| `lobsterai-claim-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` + `DSH_LOBSTERAI_CLAIM_E2E_CONFIRM=yes` | 真实签到（会改动当日签到状态；**不消耗模型积分**，且重复运行幂等） |
| `pool-record-check.e2e.spec.ts` | `DSH_ACCOUNT_HUB_POOL_CHECK=1` | 账号池限流记录闭环（会写真实 settings.yaml），按 `buddy-cn` 反查账号 |

> CodeArts deepseek-v4 系列使用华为云免费福利额度（每日 1000 万免费 Tokens），
> 不产生额外费用，因此 `DSH_CODEARTS_E2E=1` 不需要确认变量。
> glm-5.3-flash 等其他 benefit 模型不在本测试集内。如有添加务必标注消耗情况。

## 运行方式

**永远显式指定文件**，不要运行整个目录：

```bash
# 只做认证（安全）
pnpm test:e2e:login

# Buddy CN 登录流程原始响应探针（安全，不发模型请求）
pnpm test:e2e:buddy-cn-probe

# ⚠️ 会消耗 Buddy CN（中国版）积分
pnpm test:e2e:buddy-cn

# ⚠️ 判定「限额重置」徽章是否属实（默认测 deepseek-v4.1-flash）
pnpm test:e2e:buddy-cn-ratelimit

# ⚠️ 会消耗 CodeArts 积分
pnpm test:e2e:codearts

# ⚠️ 国际版 Buddy 会真实领取积分（改动当日签到状态）
pnpm test:e2e:buddy-claim

# 安全：LobsterAI 只读探针（凭据/版本号/签到槽位/余额，不签到）
pnpm test:e2e:lobsterai

# ⚠️ 会真实签到（改动当日签到状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:lobsterai-claim
```

## 限流真实性判定

`buddy-cn-ratelimit-probe.e2e.spec.ts` 回答一个运维问题：Account Hub 账号卡片显示
「限额重置」时，**该账号此刻到底还受不受限**。

徽章只比较 `modelRateLimits[model] > Date.now()`，是**历史事件的快照**，
不代表此刻的真实可用性。用例把两件事分开测，以定位差异来源：

- **A. 直连** `/v2/chat/completions`（绕过适配器与账号池）→ 服务端的真实答复；
- **B. 适配器链路** → 插件实际会发生什么。

判定：A 返回 200 且有正文即**未真限流**（徽章记录已失效）；A 返回
429/6004 且含「频率限制」即**确实受限**。可设 `DSH_BUDDY_CN_MODEL` 换被测模型。

本地记录的重置时间取自信道错误体里的「将在 … UTC+8 重置」。服务端在重置
时间到达前提前放行是常见的，因此**徽章显示超额使用、实际仍能正常回复**
并不矛盾。

## 设置页的「重测 / 重置」

同一套判定也提供在设置页（Account Hub）上，无需跑 e2e：

| 按钮 | 行为 | 是否发请求 |
|------|------|-----------|
| **重测**（每个账号） | 对该账号每个限流标记的模型实发一条最小消息，正常返回才清除该标记 | 是（消耗额度） |
| **重测所有**（面板标题） | 对全部账号（**含已停用**）执行上述重测，顺序逐个执行 | 是（消耗额度） |
| **重置**（每个账号） | 直接清除该账号的全部限流标记 | 否 |
| **重置所有**（面板标题） | 直接清除全部账号（含已停用）的限流标记 | 否 |

实现见 `src/account-probe.ts`，RPC 端点为
`account.retest` / `account.retestAll` / `account.reset` / `account.resetAll`。
探测复用真实适配器（BuddyAdapter / CodeArtsAdapter）走完整请求链路，且
**不传 accountPool**——避免「重测 A 账号」顺带污染其他账号的标记。

## 单元测试

`pnpm test`（默认）只跑 `tests/unit/**`，**全部使用桩函数，不发起任何网络请求**，
可以放心频繁运行。

## 为什么默认全部 skip

e2e 用例在未设置闸门时通过 `describe.skip` 整体跳过，报告里显示为
`skipped`，不会产生任何网络调用。这样做是为了防止：

- CI 或其他开发者误跑而消耗配额；
- CodeBuddy 的 14 天免费试用期结束后（2026-09-10 止）在付费账号上产生真实费用。
