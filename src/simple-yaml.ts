/**
 * 极简 YAML 子集解析器 —— **只服务一次性迁移**。
 *
 * ## 为什么自己写而不引依赖
 *
 * 仓库当前**零 YAML 依赖**（`package.json` 里没有 `yaml` / `js-yaml`），而任务约束
 * 是「不得引入新运行时依赖」。完整的 YAML 1.2 实现（含锚点、别名、多文档、标签）
 * 为一个「读一个 section」的需求引入几百 KB 依赖也不合适。
 *
 * 因此这里实现的是**目标子集**，且只解析**一个顶层键下的内容**：调用方
 * {@link parseSimpleYamlSection} 先按顶层键切出范围，范围**之外**的所有行
 * （其他 section、可能含块标量等本解析器不支持的构造）连碰都不碰 —— 这也是
 * 为什么不做「整文件解析后再取一节」：那会被无关 section 的复杂构造拖垮。
 *
 * ## 支持的构造（按真实 `~/.dsh/settings.yaml` 的落盘形态确定）
 *
 * - 块映射（`key: value`，缩进决定层级）与块序列（`- item`）
 * - 嵌套映射 / 序列，任意深度
 * - flow 映射与 flow 序列（`{ a: 1 }` / `[a, b]`），**允许跨多行**
 * - 标量：双引号（含转义）、单引号（`''` 表示一个单引号）、整数 / 小数、`true` /
 *   `false`、`null` / `~` / 空值、其余按原样字符串
 * - 注释：`#` 前是行首或空白才算注释（`189****3995` 里的 `#` 前是 `*`，不是注释）
 *
 * ## 明确不支持（遇到即抛错，**不静默当成别的意思**）
 *
 * 锚点 `&` / 别名 `*` / 标签 `!!` / 多文档 `---` / 块标量 `|` `>` / 合并键 `<<`。
 * 抛错而不是猜：迁移面对的是用户唯一的账号数据，静默解析成空会让账号「凭空消失」，
 * 而报错只是让迁移这一轮跳过（来源文件一个字都不动，下次启动可重试）。
 *
 * @module dsh-account-hub/simple-yaml
 */

/** YAML 子集能产出的值。 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

/** 一行逻辑行：物理行去掉注释、合并跨行 flow 之后的结果。 */
interface LogicalLine {
  indent: number
  content: string
  lineNo: number
}

/** 块映射的键判据。`[^:]+` 让 `glm-5.3:` / `trae-cn:` 这类含点与连字符的键正常匹配。 */
const KEY_RE = /^([^:]+):(\s|$)/

/** YAML 的整数 / 小数形态（够用即可，不做 1_000 分隔符与八进制）。 */
const INT_RE = /^[-+]?\d+$/
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/

/**
 * 去掉行尾注释。
 *
 * 判据是 YAML 的规矩：`#` 必须在**行首或空白之后**才算注释起点，且不能在引号内。
 * 少了这条，`nickname: 189****3995` 会被从第一个 `*` 处截断成 `189`。
 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
      continue
    }
    if (quote === "'") {
      // YAML 单引号内 `''` 是一个字面单引号。
      if (ch === "'") {
        if (line[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** 前导空白宽度（YAML 禁止 tab 缩进，出现即抛错）。 */
function indentOf(line: string, lineNo: number): number {
  const match = /^[ \t]*/.exec(line)!
  if (match[0].includes('\t')) {
    throw new Error(`第 ${lineNo} 行：YAML 不允许用 tab 缩进`)
  }
  return match[0].length
}

/**
 * 判断累积文本是否需要继续吞行：只有**出现了未闭合的 flow 括号**才继续。
 *
 * 刻意不把「引号未闭合」也算进去 —— 块标量（`key: |`）后跟的任意行会被误吞，
 * 而块标量在目标 section 之外，不该影响这里。
 */
function hasOpenFlow(text: string): boolean {
  let braces = 0
  let brackets = 0
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  return braces > 0 || brackets > 0
}

/**
 * 本子集刻意不支持的构造；遇到即抛错（见模块头「明确不支持」）。
 *
 * 判据写成「指示符出现在**值的起始**位置」而不是「行里含这个字符」：
 * `nickname: 189****3995` 里的星号是普通字符，真实数据里就有。
 */
const UNSUPPORTED_VALUE_RULES: ReadonlyArray<{ re: RegExp; what: string }> = [
  // 块标量：值就是 `|` / `>-` / `|2` 这类指示符
  { re: /^[|>][-+]?\d*$/, what: '块标量（| 或 >）' },
  // 锚点与别名：值以 `&name` / `*name` 起始
  { re: /^[&*]\S/, what: '锚点或别名（& / *）' },
  // 显式标签：值以 `!` 起始
  { re: /^!/, what: '显式标签（!）' },
]

/** 键位上不支持的构造：合并键。 */
const UNSUPPORTED_KEY_RE = /^<<$/

/** 物理行 → 逻辑行（去注释、去尾空白、合并跨行 flow、丢弃空行）。 */
function toLogicalLines(rawLines: readonly string[], baseLineNo: number): LogicalLine[] {
  const out: LogicalLine[] = []
  let pending = ''
  let pendingIndent = 0
  let pendingLineNo = baseLineNo
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = baseLineNo + i
    const stripped = stripComment(rawLines[i]).replace(/\s+$/, '')
    if (pending === '') {
      if (stripped.trim() === '') continue
      pendingIndent = indentOf(stripped, lineNo)
      pendingLineNo = lineNo
      pending = stripped.trim()
    } else {
      pending += ` ${stripped.trim()}`
    }
    if (!hasOpenFlow(pending)) {
      out.push({ indent: pendingIndent, content: pending, lineNo: pendingLineNo })
      pending = ''
    }
  }
  if (pending !== '') {
    throw new Error(`第 ${pendingLineNo} 行：flow 集合没有闭合`)
  }
  return out
}

/** 解析一个标量。 */
function parseScalar(text: string, lineNo: number): YamlValue {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new Error(`第 ${lineNo} 行：双引号字符串没有闭合`)
    }
    try {
      return JSON.parse(trimmed) as string
    } catch {
      throw new Error(`第 ${lineNo} 行：双引号字符串转义非法`)
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`第 ${lineNo} 行：单引号字符串没有闭合`)
    }
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (INT_RE.test(trimmed)) return Number.parseInt(trimmed, 10)
  if (FLOAT_RE.test(trimmed)) return Number.parseFloat(trimmed)
  return trimmed
}

/** flow 值的解析游标。 */
interface FlowCursor {
  text: string
  pos: number
  lineNo: number
}

function skipFlowSpace(cursor: FlowCursor): void {
  while (cursor.pos < cursor.text.length && /\s/.test(cursor.text[cursor.pos])) cursor.pos++
}

/** 解析一个 flow 值（映射 / 序列 / 标量），游标停在分隔符上。 */
function parseFlowValue(cursor: FlowCursor): YamlValue {
  skipFlowSpace(cursor)
  const ch = cursor.text[cursor.pos]
  if (ch === '{') return parseFlowMapping(cursor)
  if (ch === '[') return parseFlowSequence(cursor)
  // 标量：读到 `,` `}` `]` 或末尾。引号内的分隔符不参与切分。
  const start = cursor.pos
  let quote: '"' | "'" | null = null
  while (cursor.pos < cursor.text.length) {
    const c = cursor.text[cursor.pos]
    if (quote === '"') {
      if (c === '\\') cursor.pos++
      else if (c === '"') quote = null
    } else if (quote === "'") {
      if (c === "'") quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ',' || c === '}' || c === ']') {
      break
    }
    cursor.pos++
  }
  return parseScalar(cursor.text.slice(start, cursor.pos), cursor.lineNo)
}

/**
 * 解析 flow 映射的**键**：扫描到不在引号内的 `:`、`,`、`}` 为止。
 *
 * ⚠️ 不能复用 {@link parseFlowValue}：那条路径的标量扫描只在 `,` `}` `]` 停，
 * 于是 `buddy-cn: { glm-5.2: true` 会被整个吞成一个「键」，随后在缺 `:` 处报错。
 * 键与值的终止符集合**刻意不同**，这是 flow 解析里最容易写错的一处。
 */
function parseFlowKey(cursor: FlowCursor): string {
  skipFlowSpace(cursor)
  const start = cursor.pos
  let quote: '"' | "'" | null = null
  while (cursor.pos < cursor.text.length) {
    const ch = cursor.text[cursor.pos]
    if (quote === '"') {
      if (ch === '\\') cursor.pos++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ':' || ch === ',' || ch === '}') {
      break
    }
    cursor.pos++
  }
  const raw = cursor.text.slice(start, cursor.pos).trim()
  if (raw === '') throw new Error(`第 ${cursor.lineNo} 行：flow 映射缺少键`)
  return String(parseScalar(raw, cursor.lineNo))
}

function parseFlowMapping(cursor: FlowCursor): Record<string, YamlValue> {
  cursor.pos++ // 吃掉 '{'
  const result: Record<string, YamlValue> = {}
  for (;;) {
    skipFlowSpace(cursor)
    if (cursor.text[cursor.pos] === '}') {
      cursor.pos++
      return result
    }
    if (cursor.pos >= cursor.text.length) {
      throw new Error(`第 ${cursor.lineNo} 行：flow 映射没有闭合`)
    }
    const key = parseFlowKey(cursor)
    skipFlowSpace(cursor)
    if (cursor.text[cursor.pos] !== ':') {
      throw new Error(`第 ${cursor.lineNo} 行：flow 映射的键 ${key} 缺少 ':'`)
    }
    cursor.pos++
    result[key] = parseFlowValue(cursor)
    skipFlowSpace(cursor)
    if (cursor.text[cursor.pos] === ',') cursor.pos++
  }
}

function parseFlowSequence(cursor: FlowCursor): YamlValue[] {
  cursor.pos++ // 吃掉 '['
  const result: YamlValue[] = []
  for (;;) {
    skipFlowSpace(cursor)
    if (cursor.text[cursor.pos] === ']') {
      cursor.pos++
      return result
    }
    if (cursor.pos >= cursor.text.length) {
      throw new Error(`第 ${cursor.lineNo} 行：flow 序列没有闭合`)
    }
    result.push(parseFlowValue(cursor))
    skipFlowSpace(cursor)
    if (cursor.text[cursor.pos] === ',') cursor.pos++
  }
}

/** 解析一个「值文本」：flow 集合走 flow，其余走标量。 */
function parseValueText(text: string, lineNo: number): YamlValue {
  const trimmed = text.trim()
  for (const rule of UNSUPPORTED_VALUE_RULES) {
    if (rule.re.test(trimmed)) {
      throw new Error(`第 ${lineNo} 行：暂不支持${rule.what} —— ${trimmed}`)
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const cursor: FlowCursor = { text: trimmed, pos: 0, lineNo }
    const value = parseFlowValue(cursor)
    skipFlowSpace(cursor)
    if (cursor.pos !== trimmed.length) {
      throw new Error(`第 ${lineNo} 行：flow 集合后有意外内容`)
    }
    return value
  }
  return parseScalar(trimmed, lineNo)
}

/** 块序列：连续同缩进的 `- ` 行。 */
function parseSequence(lines: LogicalLine[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent !== indent) break
    if (line.content !== '-' && !line.content.startsWith('- ')) break
    const afterDash = line.content.slice(1)
    const trimmed = afterDash.trimStart()
    // 内容的列位置 = 短横线列 + 1 + 被 trim 掉的空白数。
    const contentIndent = line.indent + 1 + (afterDash.length - trimmed.length)
    if (trimmed === '') {
      // `-` 单独一行：值在下一行更深的缩进里。
      i++
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent)
        items.push(value)
        i = next
      } else {
        items.push(null)
      }
      continue
    }
    if (KEY_RE.test(trimmed)) {
      // 序列项是块映射：就地把它改写成缩进更深的逻辑行，交给 parseBlock 续读
      // 同一元素的其余键（它们与首个键同缩进）。
      lines[i] = { indent: contentIndent, content: trimmed, lineNo: line.lineNo }
      const [value, next] = parseBlock(lines, i, contentIndent)
      items.push(value)
      i = next
      continue
    }
    items.push(parseValueText(trimmed, line.lineNo))
    i++
  }
  return [items, i]
}

/** 按当前缩进解析一个块（映射或序列）。 */
function parseBlock(lines: LogicalLine[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start]
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(lines, start, indent)
  }
  if (first.content.startsWith('{') || first.content.startsWith('[')) {
    return [parseValueText(first.content, first.lineNo), start + 1]
  }
  const result: Record<string, YamlValue> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(`第 ${line.lineNo} 行：缩进层级意外加深（期望 ${indent}，实为 ${line.indent}）`)
    }
    const match = KEY_RE.exec(line.content)
    if (match === null) {
      throw new Error(`第 ${line.lineNo} 行：不是合法的 '键: 值' 形式 —— ${line.content}`)
    }
    const rawKey = match[1].trim()
    if (UNSUPPORTED_KEY_RE.test(rawKey)) {
      throw new Error(`第 ${line.lineNo} 行：暂不支持合并键（<<）`)
    }
    const key = String(parseScalar(rawKey, line.lineNo))
    const rest = line.content.slice(match[0].length)
    i++
    if (rest.trim() === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseBlock(lines, i, lines[i].indent)
        result[key] = value
        i = next
      } else {
        result[key] = null
      }
      continue
    }
    result[key] = parseValueText(rest, line.lineNo)
  }
  return [result, i]
}

/** 顶层键的行首匹配（`^\S` 且以 `:` 结尾或 `: ` 开始）。 */
const TOP_LEVEL_RE = /^([^\s#][^:]*):(\s|$)/

/**
 * 取出**一个顶层键**下的内容并解析成值。
 *
 * 范围之外的行（其他 section）原样跳过、不做任何解析 —— 这是刻意的：
 * 真实 `settings.yaml` 里别的 section 含块标量等本解析器不支持的构造，
 * 整文件解析会被无关内容拖垮。
 *
 * @param text - YAML 文本。
 * @param topLevelKey - 目标顶层键（只匹配**行首无缩进**的那个）。
 * @returns 该键下的值；文档里没有这个键时 `undefined`。
 */
export function parseSimpleYamlSection(text: string, topLevelKey: string): YamlValue | undefined {
  const lines = text.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.startsWith('#')) continue
    if (indentOf(line, i + 1) !== 0) continue
    // 多文档分隔符：本子集只认单文档，遇到即在**目标节范围内**报错。
    if (/^---\s*$/.test(line) && start !== -1) {
      throw new Error(`第 ${i + 1} 行：暂不支持多文档分隔符（---）`)
    }
    const match = TOP_LEVEL_RE.exec(line)
    if (start === -1) {
      if (match !== null && match[1].trim() === topLevelKey) start = i + 1
      continue
    }
    end = i
    break
  }
  if (start === -1) return undefined
  const sectionLines = lines.slice(start, end)
  const logical = toLogicalLines(sectionLines, start + 1)
  if (logical.length === 0) return null
  const [value, consumed] = parseBlock(logical, 0, logical[0].indent)
  if (consumed !== logical.length) {
    throw new Error(`第 ${logical[consumed].lineNo} 行：无法解析的剩余内容`)
  }
  return value
}
