# Codearts 上下文窗口（contextWindow）实现细节

本文件由 AGENTS.md 迁出，供实现/维护时查阅。

## Codearts 上下文窗口（`contextWindow`）声明 —— 远端优先，静态表兜底（2026-09-21 接线）

⚠️ **动机：未声明 `contextWindow` 会让宿主压缩管线逐 step 白跑。** 宿主的上下文压缩在 `context === undefined` 时对**每个 step** 抛 `TargetPressureConfigError`，被 catch 成 warning 后继续 —— 表现是「自动压缩**永久失效** + 每个 step 都白跑一次」。**这不是措辞问题，是功能缺失**：声明值决定压缩阈值（`0.8 × 窗口`）与压缩后的保留预算。

⚠️ **远端 `context_window` 已接线（远端优先 → 静态兜底）**：`parseModelInfo` 读远端下发的 `context_window`，`resolveModel()` 改为 `remoteModel?.contextWindow ?? CONTEXT_WINDOWS.get(model)`。两个端点都下发该字段，此前被整条丢弃。**取值判据**：只接受**正的有限 number**，0 / 负数 / `NaN` / 字符串一律视为未声明（抓包见到的恒是 JSON number，为未见的形态发明解析规则属于猜测）。**属性缺省**（不是 `undefined` 值）是刻意的：它同时承担「回退静态表」与「兼容旧磁盘缓存」两件事。**远端失败 / 字段缺失必须原样回退静态表**（同一个 `??`），**网络抖动不该改变声明值的来源** —— 有 4 个方向的单测钉死（远端优先 / 缺字段 / 抛错 / 空目录）。

⚠️ **远端 `max_tokens` 刻意不接线**：出站 body 的 `max_tokens` 现由 `options.maxTokens ?? 65536` 决定（参考实现实测 65536 可用、131072 反而触发空流）。**接远端值属于行为变更**，超出范围 —— 有一条单测钉死 `max_tokens` 不会漏进目录项。

⚠️ **静态表（`CONTEXT_WINDOWS`）语义已改为「远端优先，此表为兜底快照」**，本轮只补两项：**`GLM-5.1: 202752`**（IDE 内置 `KERNEL_MODELS` 硬证据，与 GLM-5.2 同口径）、**`glm-5.2-sft-harmony: 202752`**（**推断项**，按 GLM-5.2 同口径，**无独立旁证**）。⚠️ **`openpangu-2.0-flash` / `openpangu-2.0-pro` / `GLM-5` 刻意留空**：三方都没有窗口旁证。**宁可缺省也不编造** —— 声明错值会直接改写宿主的压缩时机。

⚠️ **id 匹配沿用既有归一语义，不发明模糊匹配**：远端下发带日期后缀的 `deepseek-v4-flash-0731`，`parseModelInfo` 已归一为 `deepseek-v4-flash`，故 `resolveModel()` 按**归一后的 id 直接比对**即可命中。反向也钉死了：拿带后缀的 id 去 `resolveModel` **不会**命中远端窗口（它不是可路由 id）。