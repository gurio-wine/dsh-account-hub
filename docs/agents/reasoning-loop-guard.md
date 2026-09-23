# 思考死循环止损（Reasoning Loop Guard）实现细节

本文件由 AGENTS.md 迁出，供实现/维护时查阅。判据本体在 `src/reasoning-loop-guard.ts`，**零依赖纯函数模块**。

## 它解决的真实缺陷

`workbuddy/deepseek-v4.1-flash` 报「已达到输出 token 上限，回答被截断」。排查确认**不是**参数沿用上一个模型（DSH 的 `prepareCall` → `resolveCallWithInfo` 按**当前**模型解析 `maxTokens`；报障会话 turn 1 未做任何切换就爆额度），而是模型思考陷入病态重复：

```
Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
```

`reasoning_tokens` **计入** `completion_tokens` ⇒ 思考停不下来 = 正文零产出，最终 `reasoningTokens == outputTokens == 128000`、`finish_reason: length`。

## 判据（阈值以源码为准）

命中条件**两条同时成立**，作用于**尾部窗口**：

1. 窗口（`windowChars`，默认 **3000** 字符）内**非空行**数 ≥ `minLines`（默认 **40**）；
2. 去重行比例 = `Set(lines).size / lines.length` **严格小于** `maxDistinctLineRatio`（默认 **0.35**）。

连续满足上述条件的状态须**持续** ≥ `minLoopChars`（默认 **2000** 字符）才确认；中途恢复正常即清零 `runStart` / `runChars`，使「循环 → 正常 → 再循环」只认后一段。

「持续体量」这一层**不可省**：实测 seq=401 在 14848/15795（94%）处被判局部循环，但它随即**自愈并产出了工具调用** —— 其持续体量仅 1024，被 2000 正确排除；三个真死循环的持续体量是 435,968 ~ 509,184。正常样本窗口去重率最低 **0.149**、死循环 **0.017~0.031**（约 5 倍余量，实测零误报）。

判据选型（正常 109 条 / 死循环 6 条真实样本）：n-gram 重复占比 0/109 误报、命中 2/3；**窗口去重行比例 + 持续体量 0/109 误报、命中 3/3（采用）**；尾部行周期 0/109 误报、命中 1/3。

⚠️ **只应喂 `reasoning` 增量**：正文里的重复（代码块、列表、表格）是**正常输出**，喂进来会误伤。这是**调用方契约**，不是判据的性质 —— 判据对重复本身是敏感的（单测以「400 行重复代码喂进去必触发」作反向对照）。

## 为什么单列一个模块

判据是**纯函数**，与 SSE 解析、HTTP 形态、provider 协议全部无关 —— 放进适配器会被五份拷贝散开，也没有纯函数断言；且五个适配器（codearts / buddy / lobsterai / qoder / trae-cn）共用**同一份**判据，调参只改一处。模块**零依赖**（不 import 任何其它模块），便于直接单测。

上游把判定与清洗一并塞在 `src/sse.ts`（该次提交 +375 行）；本仓拆出独立模块，`src/sse.ts` 只保留其原有职责。

## 接线事实（本仓无共享收口，逐个适配器接线）

⚠️ 本仓**没有**上游那种共享的 OpenAI 兼容层（无 `openai-compat.ts`），故五处读取循环结构各不相同（`for (;;)` / `while`、变量名各异），**漏接任何一处都等于漏一条路径**。当前共 **8 个** `observe` 调用点：

| 适配器 | 出口 |
|---|---|
| `src/buddy-adapter.ts` | `delta.reasoning_content` → 1 处 |
| `src/llm-adapter.ts`（codearts） | **2 处**：`emitDsmlFeed` 的 `reasoning` 聚合参数（出口 ①）、`delta.reasoning_content` → `dsmlReasoningExtractor` → `thinking`（出口 ②） |
| `src/lobsterai-adapter.ts` | reasoning 增量 → 1 处 |
| `src/qoder-adapter.ts` | 流式 `thoughtPiece` → 1 处；非流式 `consumeQoderJson` → 1 处 |
| `src/trae-cn-sse.ts` | 独立 `thought` 事件（出口 ①）、`output` 事件内嵌思考（出口 ②） |

**命中后的止损动作**（各适配器 `consumeSse` / 读取循环里的「★ 止损」块）：

1. **丢弃后续 reasoning 增量** —— 用 `if (!loopDetected)` 守卫分支体，**不用 `continue`**（它会连带跳过**同帧内**位于思考分支之后的 `usage` 记账与 `tool_calls` 解析，导致 token 统计静默丢失）；
2. **`reader.cancel().catch(() => {})` + `break`** —— 只跳过发射却把流读到底，上游照烧额度（实测上游 200 帧被读 200 帧；守卫在 ~2304 字符即命中，即 **99.5%** 额度仍被消耗）。`.catch` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把「正常止损」变成一次失败。⚠️ `break` 必须放在**内层行循环之后、外层读取循环末尾**，这样同 chunk 已到达的 `usage` / `[DONE]` 仍被处理；
3. **绝不 abort `options.signal`** —— 那是调用方信号，abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`（有专门单测钉死它保持未 abort）；
4. **收尾发截断后的 block** —— `block-end` 是**权威覆盖**：即便前面已 yield 了全部重复 delta，这里发 `text.slice(0, cutAt)` 即可，无需撤回；
5. **`finish` 报 `max-tokens`** —— **优先级最高**（高于 `tool_calls`）：循环中生成的工具调用参数不可信，且若无可用调用，落到 `stop` 会让任务静默中断。

⚠️ codearts 的 **visible 回退必须用截断后的 `reasoningText`**（不能用 `reasoningBlock.text`）：命中时正文恰好为空且无工具调用，用原文会把病态循环全文复制进正文块并持久化，下次重放又要重新吃一遍。

### qoder / trae-cn 的 finish 旁路（本仓自有）

这两个 provider 的 `finish` 由**调用方**发出（流消费函数只做「帧 → 块」翻译），而命中后流是被我们**主动 abort** 的 ⇒ `done` 恒为 false，直接按「流被截断」处理会错报 `TRANSPORT`。故 `StreamOutcome` 增加 `thoughtLoopDetected` 字段旁路传出，调用方据此**优先**报 `max-tokens`：

- qoder 的成功收尾分支要**同时**排除该标志两处：`!outcome.done && outcome.thoughtLoopDetected !== true`（否则错报 TRANSPORT）、`!outcome.produced && outcome.thoughtLoopDetected !== true`（否则错报 `EMPTY_RESPONSE` —— 命中的是**首个**超长 delta 时 `produced` 可能仍为 false）；
- trae-cn 的成功收尾判据放宽为 `outcome.produced || outcome.thoughtLoopDetected === true`，同一目的。

### qoder 非流式路径

`consumeQoderJson`（`Content-Type: application/json` 的整包响应）同样接死循环守卫，但只做**截断 + 清洗**：正文一次到达、上游早已生成完毕，**无流可 abort，止损无意义**。命中后同样经 `thoughtLoopDetected` 上报，`finish` 报 `max-tokens`（与流式路径一致）。

## 开关

`DSH_REASONING_LOOP_GUARD`，**默认开启**，只有显式假值（`0` / `false` / `no` / `off`，大小写与首尾空白不敏感）才关闭。

解析单列在**导出**函数 `resolveReasoningLoopGuardFlag`，与本地 `isTruthyFlag` 一类「默认关」的语义**相反**（对齐 `src/account-pool.ts` 的 `resolveHideWithoutAccountFlag`），**不要混用**。

## 调参约束（改阈值前必须核验）

`sliceChars`（内部切片大小，默认 64）使**触发结论**与调用方粒度无关 —— 旧实现 `runChars += delta.length` 直接采用调用方边界，单个 delta 大于 `minLoopChars` 时一次观察即满足阈值、`runStart` 落在该 delta 开头 → `cutAt = 0` → **把回答截成空**，且会误伤「早期自愈」负样本。真实流式帧极小（实测 1379 万帧：p99=10、max=95 字符），但 codearts 适配器是**累积后一次性调用** ⇒ 真实可达，必须兜住。

- `resolveSliceChars`：非有限值（`NaN` / `Infinity`）回退 64，并钳到 **≥1**。必须钳下限 —— `offset += 0` 会让切片循环永不推进 = **同步死循环、进程挂死**，且同步阻塞下 vitest 的 `testTimeout`（事件循环 timer）根本不触发，表现为整个测试进程永久挂住且零诊断；`NaN` 也必须兜，否则 `offset < delta.length` 恒为 false → 判据**静默失效**（fail-open）。
- **`cutAt > 0` 在默认参数下必然成立**：进入 looping 至少需 40 个非空行，而 `n` 个非空行至少占 `2n−1` 字符，代入得**至少 79 字符**；任一片长度恒 ≤ 64 < 79 ⇒ 首片结束时不可能已满足 40 行 ⇒ `runStart ≥ 1`。⚠️ 若**调大 `sliceChars`** 使单片可容纳 ≥79 字符，或**下调 `minLines`**，首片即可能直接命中、`cutAt = 0` 截空复现（实测：`sliceChars` 32 → `cutAt=64`、64 → 64 安全；**128 → 0**、256 → 0）。
- `cutAt` **数值精度**受切片大小限制（调用方粒度小于切片大小时更精确：实测粒度 3 → 1614、10 → 1610、≥64 → 1600；`sliceChars` 256 → 1536、64 → 1600），触发时机也会随 delta 边界略有推迟。**结论不变，只是数值精度变**。

## 测试覆盖

- `tests/unit/reasoning-loop-guard.spec.ts`（27 条）—— 阈值边界的**精确**锁定（40 行上下格翻转、0.350 恰不触发因判据是严格小于、2000 字符闭区间临界）、粒度无关性（3~65536 六档）、`cutAt` 永不为 0、`resolveSliceChars` 归一化、开关语义、fixture 回归（死循环必触发 / 正常零触发 / 早期自愈不触发 / 触发后幂等）。阈值用例用**合成文本**而非 fixture：fixture 只能证明「会触发」，证明不了「阈值到底在哪」。
- `tests/unit/reasoning-loop-adapter.spec.ts`（52 条，参数化覆盖**五个**适配器）—— 截断生效且保留真前缀、`finish` 报 `max-tokens`、真实帧计数证明上游被提前停止（200 → 远小于一半）、正常与自愈样本零变化、开关关闭时逐字节不变、同帧 `usage` / `tool_calls` 不被连带跳过、调用方 `signal` 保持未 abort。
- fixture：`tests/fixtures/reasoning-loop.txt` / `reasoning-normal.txt` / `reasoning-self-heal.txt`，均为真实会话文本。

⚠️ `sliceChars` 的**接线**刻意用 `NaN` 而非 `0` / 负数来测：后者在钳制被回退时是同步挂死（无诊断），前者只是判据静默失效（可诊断的断言失败）。

移植自上游 `ab184d5`，但模块拆分、qoder/trae-cn 的 finish 旁路、`cutAt > 0` 的论证与调参约束、以及适配器侧的同帧保护均**为本仓自有**。实现细节以**读源码**为准。
