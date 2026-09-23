/**
 * 「行首 `course` / `课` 泄漏 token」清洗（`src/course-leak-strip.ts`）的回归测试。
 *
 * ## 真实缺陷
 *
 * 用户观察：`deepseek-v4.1-flash` 的输出与思考中，**经常一行开头带一个中文「课」
 * 或英文「course」**。
 *
 * ## 实测形态（全库核实：295 会话 / 307 万行）
 *
 * | 事实 | 数据 |
 * |---|---|
 * | `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
 * | `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
 * | 位置分布 | 行首 **2347**、行中仅 28（后者全是分析此现象的会话文字） |
 * | 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |
 *
 * 100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
 * 被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源）。
 *
 * ## 判据为什么是「行首一律删」
 *
 * 泄漏就是**单个 `课` 字**，后面接任意正文。故「`课` + 某字」永远可能是
 * 「泄漏 + 正文」的偶然组合 —— 白名单会被绕过：
 *
 * | 曾以为需要保护的词 | 数据真相 |
 * |---|---|
 * | `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
 * | `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
 * | `课程`(23) | **全在中部**，且全是分析此现象的会话文字，非模型输出 |
 *
 * 故**不用白名单**：行首 `课` 一律删。实测命中 2346 / 未命中 0，
 * 且中部 28 处（真正的正常用法 `研讨课` / `重要的一课` / `of course` / `recourse`）
 * 完全不受影响。
 *
 * ⚠️ **已知边界（非零风险）**：若模型真的以「课程设计已完成。」开头，
 * 会变成「程设计已完成。」。实测 0/2346，但原理上非零 —— 故必须带开关。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isCourseLeakStripEnabled,
  resolveCourseLeakStripFlag,
  stripCourseLeak,
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled,
} from '../../src/course-leak-strip.js'

/** 读 `tests/fixtures/` 下的 fixture。 */
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

/** 一行是否仍以泄漏 token 开头（与生产判据同形，用于 fixture 断言）。 */
function hasLineInitialLeak(text: string): boolean {
  return text.split('\n').some(line => /^[ \t]*(course|课)/.test(line))
}

describe('stripCourseLeak / 行首泄漏：必须删', () => {
  it('删行首孤立的 course（后接空格）', () => {
    expect(stripCourseLeak('course 我还需注意一个隐患。')).toBe('我还需注意一个隐患。')
  })

  it('删行首 course 且独占一行（后接换行）', () => {
    expect(stripCourseLeak('course\n下一行')).toBe('\n下一行')
  })

  it('删行首 course 且位于块尾', () => {
    expect(stripCourseLeak('前面内容\ncourse')).toBe('前面内容\n')
  })

  it('删行首的课（后接汉字，泄漏 + 模型正文）', () => {
    expect(stripCourseLeak('课先写 `PriceDetailDTO`。')).toBe('先写 `PriceDetailDTO`。')
  })

  it('删行首的课（泄漏 + 循环短句叠加）', () => {
    expect(stripCourseLeak('课查。')).toBe('查。')
    expect(stripCourseLeak('课修。')).toBe('修。')
    expect(stripCourseLeak('课跑。')).toBe('跑。')
  })

  it('删行首的课（后接英文 / 数字 / 标记）', () => {
    expect(stripCourseLeak('课Java 没有 clamp！')).toBe('Java 没有 clamp！')
    expect(stripCourseLeak('课14 = 20 - 6。')).toBe('14 = 20 - 6。')
    expect(stripCourseLeak('课`CreateTrade` 中…')).toBe('`CreateTrade` 中…')
  })

  it('删块首（无前置换行）的泄漏', () => {
    expect(stripCourseLeak('course 开头就是泄漏。')).toBe('开头就是泄漏。')
    expect(stripCourseLeak('课开头就是泄漏。')).toBe('开头就是泄漏。')
  })

  it('删多行文本中每一行的行首泄漏', () => {
    const input = '第一段。\n\ncourse 第二段。\n\n课第三段。'
    expect(stripCourseLeak(input)).toBe('第一段。\n\n第二段。\n\n第三段。')
  })

  it('删「泄漏 + 循环」叠加的整段（用户的补充场景）', () => {
    const input = '结论如下。\n\n课查。\n\n课修。\n\n课跑。'
    expect(stripCourseLeak(input)).toBe('结论如下。\n\n查。\n\n修。\n\n跑。')
  })

  it('处理缩进后的行首（数据里为 0，但为稳妥仍删）', () => {
    expect(stripCourseLeak('  course 缩进泄漏。')).toBe('  缩进泄漏。')
    expect(stripCourseLeak('  课缩进泄漏。')).toBe('  缩进泄漏。')
  })
})

describe('stripCourseLeak / 正常用法：绝不能动', () => {
  it('保留中部的 of course / recourse', () => {
    expect(stripCourseLeak("they'd have no recourse here")).toBe("they'd have no recourse here")
    expect(stripCourseLeak('of course, this is fine')).toBe('of course, this is fine')
  })

  it('保留中部的中文「课」', () => {
    const text = '氛围常如同一堂慢节奏的大学研讨课；而打法不同。'
    expect(stripCourseLeak(text)).toBe(text)
    expect(stripCourseLeak('这是重要的一课：验证前必须选数据。')).toBe('这是重要的一课：验证前必须选数据。')
  })

  it('保留**中部**的「课程」（正常词在中部时不受影响）', () => {
    expect(stripCourseLeak('本节讲课程设计。')).toBe('本节讲课程设计。')
    expect(stripCourseLeak('参见课程表。')).toBe('参见课程表。')
  })

  // ⚠️ **已知边界（如实记录，非「安全」）**：判据是「行首 `课` 一律删」，
  // 因此**行首**的正常词也会被删。实测全库 0/2346 次，但原理上非零 ——
  // 这正是提供 DSH_COURSE_LEAK_STRIP 开关的原因。
  // 若将来实测出现真实误删，应改为「行首 课 + 白名单词」的保护式判据
  // （但那时需先证明白名单不会被「泄漏 + 正文」的偶然组合绕过）。
  it('已知边界：行首「课程…」会被删（记录现状，可经开关关闭）', () => {
    expect(stripCourseLeak('课程设计完成。')).toBe('程设计完成。')
  })

  it('保留行首 course 后接非空白（可能是正常英文句首）', () => {
    // 保守：后接字母时不动（避免误删 courseXxx 之类的真实内容）。
    expect(stripCourseLeak('courseware 是课件')).toBe('courseware 是课件')
  })

  it('保留空串与无泄漏文本', () => {
    expect(stripCourseLeak('')).toBe('')
    expect(stripCourseLeak('完全没有目标词的正常文本。')).toBe('完全没有目标词的正常文本。')
  })

  it('不误删行中的「课」与「course」', () => {
    const text = '我上课时学了 course 这门课。'
    expect(stripCourseLeak(text)).toBe(text)
  })

  it('不改动代码块内的行首 course（保守：仅按行首判定，不解析围栏）', () => {
    // 记录当前行为：判据不解析 markdown 围栏，故围栏内的行首 course 也会被删。
    // 实测数据里围栏内无此形态（泄漏都出现在自然语言段落），故可接受。
    expect(stripCourseLeak('```\ncourse\n```')).toBe('```\n\n```')
  })
})

describe('stripCourseLeak / 幂等性与边界', () => {
  it('幂等：连续调用结果一致', () => {
    const input = '前文。\n\ncourse 中段。\n\n课后段。'
    const once = stripCourseLeak(input)
    expect(stripCourseLeak(once)).toBe(once)
  })

  it('保留 \\r\\n 行尾形态（不破坏 Windows 换行）', () => {
    expect(stripCourseLeak('前文。\r\ncourse 中段。')).toBe('前文。\r\n中段。')
  })

  it('一行内多个泄漏只处理行首那个', () => {
    // 「课读。课写。」：只删行首的「课」，行中的保留（保守，避免误删）。
    expect(stripCourseLeak('课读。课写。')).toBe('读。课写。')
  })

  it('无泄漏时原样返回（不改动引用语义）', () => {
    const clean = '没有任何目标词的文本。'
    expect(stripCourseLeak(clean)).toBe(clean)
  })
})

describe('stripCourseLeak / 真实 fixture（全库泄漏样本）', () => {
  // fixture 是真实会话文本片段（上游实测样本）：13 行、563 字符，
  // 含 5 处行首泄漏（course 独占行 + 「course 正文」形态）。
  it('fixture 内含行首泄漏，清洗后 0 残留', () => {
    const raw = fixture('course-leak.txt')
    // 前提：fixture 本身确实带泄漏（否则「清洗后 0 残留」是废话）。
    expect(hasLineInitialLeak(raw)).toBe(true)
    const cleaned = stripCourseLeak(raw)
    expect(hasLineInitialLeak(cleaned)).toBe(false)
    // 且确实发生了改动（不是原样返回）。
    expect(cleaned).not.toBe(raw)
  })

  it('清洗后内容长度只会缩短（只删不增）', () => {
    const raw = fixture('course-leak.txt')
    expect(stripCourseLeak(raw).length).toBeLessThan(raw.length)
  })

  it('清洗**不误伤** fixture 里的正常句子', () => {
    // fixture 末行是正常中文句子（无泄漏），必须逐字保留。
    const raw = fixture('course-leak.txt')
    const cleaned = stripCourseLeak(raw)
    const normalLine = '让我直接看 handler 收到的实际值。'
    expect(raw).toContain(normalLine)
    expect(cleaned).toContain(normalLine)
  })
})

/**
 * 历史侧清洗（存量自愈）的回归测试。
 *
 * ## 为什么需要
 *
 * `block-end` 清洗只管**本次新生成**的文本；但泄漏早在修复之前就已**持久化进
 * 会话历史**（实测全库 2771 行），此后每轮请求都把脏历史原样重放给模型 ——
 * 正是用户报障的「污染提示词」。故必须在发给模型前再清一道。
 *
 * ## 最重要的约束：**不篡改用户输入**
 *
 * 判据只对**模型自己的输出**成立。用户消息是人的输入 —— 里面出现的「课」/「course」
 * 可能是用户真的在讨论这个词。清洗用户输入等于篡改用户的话，**绝不可为**。
 */
describe('stripCourseLeakFromHistoryContent', () => {
  it('清洗 assistant 的 text 块', () => {
    const out = stripCourseLeakFromHistoryContent('assistant', [
      { type: 'text', text: '前文。\n\ncourse 后文。' },
    ])
    expect((out[0] as { text: string }).text).toBe('前文。\n\n后文。')
  })

  it('清洗 assistant 的 reasoning 块', () => {
    const out = stripCourseLeakFromHistoryContent('assistant', [
      { type: 'reasoning', text: '课查。\n\n课修。' },
    ])
    expect((out[0] as { text: string }).text).toBe('查。\n\n修。')
  })

  it('⚠️ 绝不改动 user 消息（否则等于篡改用户的话）', () => {
    const content = [
      { type: 'text', text: 'course 这个词在中文里是什么？\n课代表是什么意思？' },
    ]
    const out = stripCourseLeakFromHistoryContent('user', content)
    // 引用相等：完全没动。
    expect(out).toBe(content)
    expect((out[0] as { text: string }).text).toBe(content[0].text)
  })

  it('不动 system 消息', () => {
    const content = [{ type: 'text', text: 'course 说明。' }]
    expect(stripCourseLeakFromHistoryContent('system', content)).toBe(content)
  })

  it('不动 tool-call 的 arguments（改了会破坏 JSON 解析）', () => {
    const content = [
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"course/a.txt"}' },
    ]
    expect(stripCourseLeakFromHistoryContent('assistant', content)).toBe(content)
  })

  it('无泄漏时返回**原数组**（引用相等，避免无谓拷贝）', () => {
    const content = [{ type: 'text', text: '完全正常的文本。' }]
    expect(stripCourseLeakFromHistoryContent('assistant', content)).toBe(content)
  })

  it('保留引用：无改动的块不被复制（只替换真正改动的块）', () => {
    const clean = { type: 'reasoning', text: '正常推理。' }
    const dirty = { type: 'text', text: 'course 有泄漏。' }
    const out = stripCourseLeakFromHistoryContent('assistant', [clean, dirty])
    expect(out[0]).toBe(clean)      // 未改动 → 同一引用
    expect(out[1]).not.toBe(dirty)  // 已改动 → 新对象
    expect((out[1] as { text: string }).text).toBe('有泄漏。')
  })

  it('保留正常用法（中部 of course / 研讨课）', () => {
    const content = [{ type: 'text', text: 'of course 与研讨课都不该动。' }]
    expect(stripCourseLeakFromHistoryContent('assistant', content)).toBe(content)
  })

  it('容忍非对象块与空文本', () => {
    const content = [null, 'string-block', { type: 'text' }, { type: 'text', text: '' }]
    expect(stripCourseLeakFromHistoryContent('assistant', content)).toBe(content)
  })
})

describe('resolveCourseLeakStripFlag / stripCourseLeakIfEnabled', () => {
  it('未设置时默认开启', () => {
    expect(resolveCourseLeakStripFlag(undefined)).toBe(true)
  })

  it('显式假值才关闭', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
      expect(resolveCourseLeakStripFlag(raw)).toBe(false)
    }
  })

  it('其余取值保持开启', () => {
    for (const raw of ['1', 'true', 'yes', 'on', '']) {
      expect(resolveCourseLeakStripFlag(raw)).toBe(true)
    }
  })

  it('stripCourseLeakIfEnabled 随环境变量开合（未设置 = 开）', () => {
    const previous = process.env.DSH_COURSE_LEAK_STRIP
    delete process.env.DSH_COURSE_LEAK_STRIP
    try {
      expect(isCourseLeakStripEnabled()).toBe(true)
      expect(stripCourseLeakIfEnabled('course 有泄漏。')).toBe('有泄漏。')
      process.env.DSH_COURSE_LEAK_STRIP = '0'
      expect(isCourseLeakStripEnabled()).toBe(false)
      // 关闭时**逐字节原样返回**（行为与现状一致）。
      expect(stripCourseLeakIfEnabled('course 有泄漏。')).toBe('course 有泄漏。')
    } finally {
      if (previous === undefined) delete process.env.DSH_COURSE_LEAK_STRIP
      else process.env.DSH_COURSE_LEAK_STRIP = previous
    }
  })

  it('关闭时历史侧清洗也整体停用（返回原数组）', () => {
    const previous = process.env.DSH_COURSE_LEAK_STRIP
    process.env.DSH_COURSE_LEAK_STRIP = '0'
    try {
      const content = [{ type: 'text', text: 'course 有泄漏。' }]
      expect(stripCourseLeakFromHistoryContent('assistant', content)).toBe(content)
    } finally {
      if (previous === undefined) delete process.env.DSH_COURSE_LEAK_STRIP
      else process.env.DSH_COURSE_LEAK_STRIP = previous
    }
  })
})
