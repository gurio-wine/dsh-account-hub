/**
 * 行首 `course` / `课` 泄漏 token 清洗（Course Leak Strip）。
 *
 * ## 它解决的真实缺陷
 *
 * `deepseek-v4.1-flash` 的输出与思考中，**经常一行开头带一个中文「课」
 * 或英文「course」**，会污染提示词。
 *
 * ## 实测形态（上游全库核实：295 会话 / 307 万行）
 *
 * | 事实 | 数据 |
 * |---|---|
 * | `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
 * | `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
 * | 位置分布 | 行首 **2347**、行中仅 28（后者全是排查期间的会话文字） |
 * | 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |
 *
 * 100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
 * 被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源 —— 都是 "course"
 * 的字面义）。「`课查` / `课修`」则是**泄漏 + 模型循环**两个问题叠加：泄漏
 * token 后面直接跟模型正文/循环短句（`课查。` 895 次、`课跑。` 308、
 * `课修。` 307…）。这也解释了为何量极大 —— 模型一旦进入循环，每轮迭代都带
 * 一个泄漏前缀。
 *
 * ## 两处落点，缺一不可
 *
 * 1. **消费侧（新输出）**：各适配器 `block-end` 处调 {@link stripCourseLeakIfEnabled}
 *    —— 清洗已组装的块。放这里而非流式增量，是因为判据需要「行首」上下文，
 *    而增量里 `course` 可能**跨 chunk 到达**（`cou` + `rse`），流式层无法判定。
 * 2. **序列化侧（存量自愈）**：{@link stripCourseLeakFromHistoryContent} 在各
 *    `serializeMessages` 里清洗**已持久化**的历史。
 *
 * 本模块**零依赖**（不 import 任何其它模块），便于直接单测。
 */

/**
 * 清洗**行首**的 `course` / `课` 泄漏 token。
 *
 * ## 为什么判据是「行首一律删」，而不是白名单
 *
 * 泄漏就是**单个 `课` 字**，后面接任意正文 —— 故「`课` + 某字」永远可能是
 * 「泄漏 + 正文」的偶然组合，**任何白名单都会被绕过**。实测反证：
 *
 * | 曾以为要保护的词 | 数据真相 |
 * |---|---|
 * | `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
 * | `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
 * | `课程`(23) | **全在中部**，且全是分析此现象的会话文字，非模型输出 |
 *
 * 故判据为：
 *
 * ```
 * 行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
 *   且后接 ∈ {空格, \t, \n, \r, 块尾}          → 删掉 `course`
 * 行首（同上）的 `课`                            → 删掉 `课`
 * ```
 *
 * `course` 要求后接空白（**不接字母**）是为保守：避免误删 `courseware` 这类
 * 真实英文词。实测行首 `course` 后接非空白的出现 **0 次**，故不影响覆盖率。
 *
 * 实测效果：命中 **2346** 处、行首未命中 **0** 处；中部 28 处（真正的正常用法
 * `研讨课` / `重要的一课` / `of course` / `recourse`）**完全不受影响**。
 *
 * ⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
 * 这样的句子开头，会变成「程设计已完成。」。实测 **0/2346**，但原理上非零 ——
 * 因为泄漏后接的正文可能偶然拼成正常词。可用 `DSH_COURSE_LEAK_STRIP=0` 关闭。
 *
 * ⚠️ **不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删。实测数据里
 * 泄漏都出现在自然语言段落、围栏内无此形态，故接受该简化。
 *
 * @param text - 待清洗文本（reasoning 块或 text 块）。
 * @returns 清洗后的文本；无泄漏时**原样返回同一字符串**。
 */
export function stripCourseLeak(text: string): string {
  if (text.length === 0) return text
  // 快速短路：绝大多数文本不含目标词，避免无谓的逐行处理。
  if (!text.includes('course') && !text.includes('课')) return text

  const lines = text.split('\n')
  let changed = false
  const cleaned = lines.map((line) => {
    // 行首 = 允许前置空白后的第一个字符（实测泄漏无缩进，但为稳妥仍处理）。
    const match = /^([ \t]*)(course|课)(.*)$/.exec(line)
    if (match === null) return line
    const [, indent, word, rest] = match
    if (word === 'course') {
      // 保守：只有后接空白/制表/回车/行尾才认为是泄漏（不接字母，避免 courseware 等）。
      // `\r` 必须算：CRLF 行尾时它留在本行末尾（已按 `\n` 分行）。
      const first = rest[0]
      if (!(rest.length === 0 || first === ' ' || first === '\t' || first === '\r')) return line
      // 连同其后一个空格一起删，避免留下行首空格。
      const trimmed = rest.startsWith(' ') ? rest.slice(1) : rest
      changed = true
      return indent + trimmed
    }
    // `课`：行首一律删（实测行首 `课` 100% 是泄漏）。
    const trimmed = rest.startsWith(' ') ? rest.slice(1) : rest
    changed = true
    return indent + trimmed
  })
  return changed ? cleaned.join('\n') : text
}

/**
 * 解析 `DSH_COURSE_LEAK_STRIP`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与本地 `isTruthyFlag`
 * 一类「默认关」的解析语义相反（对齐 `resolveHideWithoutAccountFlag`
 * —— `src/account-pool.ts` 末尾那个模块私有的「默认开」解析），故单列一个
 * **导出**函数，**不要混用**。
 *
 * ⚠️ 提供开关是因为判据有**已知边界**：若模型真的以「课程设计…」开头，
 * 「课」会被误删。实测 0/2346，但原理上非零。
 */
export function resolveCourseLeakStripFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/** 行首泄漏清洗是否启用（读环境变量）。 */
export function isCourseLeakStripEnabled(): boolean {
  return resolveCourseLeakStripFlag(process.env.DSH_COURSE_LEAK_STRIP)
}

/**
 * 按开关决定是否清洗；**供适配器的 `block-end` 收尾处调用**。
 *
 * 清洗放在**组装后**（而非流式增量）有两个理由：
 * 1. 判据需要「行首」这个上下文，而增量里 `course` 可能跨 chunk 到达
 *    （`cou` + `rse`），流式层无法判定；
 * 2. 只改 `block-end` 的 `block.text` 不必引入缓冲，不影响首 token 延迟。
 *
 * 实测 `BlockAssembler` 的 `block-end` 是**权威覆盖**：即便前面已 yield 了
 * 未清洗的流式增量，这里改文本即可生效（与死循环截断同一机制）。
 */
export function stripCourseLeakIfEnabled(text: string): string {
  return isCourseLeakStripEnabled() ? stripCourseLeak(text) : text
}

/**
 * 清洗**历史消息**里已持久化的行首泄漏；**供各适配器的序列化前调用**。
 *
 * ## 为什么还需要这一层（`block-end` 清洗不够）
 *
 * `block-end` 清洗只管**本次新生成**的文本。但泄漏早在本次修复之前就已
 * **持久化进会话历史**（实测全库 2771 行），此后每轮请求都会把这段脏历史
 * 原样重放给模型 —— 正是用户报障的「污染提示词」。
 *
 * 故必须在**发给模型之前**再清一道，让**存量坏会话自愈**、无需用户重开会话。
 * 这与本地「名称为空的 tool_call」那次的思路一致（消费侧修源头 + 序列化侧
 * 治存量，见 `resolveToolPairing`）。
 *
 * ## 只清 assistant，不碰 user / system / tool 结果
 *
 * ⚠️ **判据只对模型自己的输出成立**（泄漏 token 由模型产生）。
 * 用户消息是**人的输入** —— 里面出现的「课」/「course」可能是用户真的在
 * 讨论这个词。清洗用户输入会**篡改用户的话**，绝不可为。
 *
 * 故：
 * - `role === 'assistant'` 的 `text` / `reasoning` 块 → 清洗；
 * - `tool-call` 的 `arguments` → **不清洗**（是 JSON，改了会破坏解析）；
 * - 其余角色的所有内容 → **不清洗**。
 *
 * @param role - 消息角色。
 * @param content - 该消息的 content 数组（harness 原生块形态）。
 * @returns 清洗后的 content 数组；无改动时返回**原数组**（保持引用相等）；
 *   无改动的块也保持**同一引用**，只替换真正改动的块。
 */
export function stripCourseLeakFromHistoryContent(
  role: string,
  content: readonly unknown[],
): readonly unknown[] {
  if (role !== 'assistant') return content
  if (!isCourseLeakStripEnabled()) return content
  let changed = false
  const cleaned = content.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw
    const block = raw as { type?: unknown; text?: unknown }
    // 只动 text / reasoning 两种纯文本块。
    if (block.type !== 'text' && block.type !== 'reasoning') return raw
    if (typeof block.text !== 'string' || block.text.length === 0) return raw
    const stripped = stripCourseLeak(block.text)
    if (stripped === block.text) return raw
    changed = true
    return { ...block, text: stripped }
  })
  return changed ? cleaned : content
}
