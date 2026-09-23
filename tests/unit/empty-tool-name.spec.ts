/**
 * 「名称为空的 tool_call 跨 provider 传染会话报废」的**序列化侧**回归
 * （真实缺陷，2026-09-23 用户报障）。
 *
 * ## 现象
 *
 * 用户在会话里给腾讯系端点（workbuddy / deepseek-v4.1-flash）发任务，**每次**都报：
 *
 * ```json
 * {"code":11133,"msg":"the request parameters were rejected by the model provider",
 *  "extError":{"code":"model_param_invalid","param":"","StatusCode":400}}
 * ```
 *
 * 文案只说「请求参数不符合当前模型要求」，**不指出是哪个字段** —— 极易误判成
 * 「模型不支持图片」。逐项排除后确认与图片无关，真凶是会话历史里一条：
 *
 * ```json
 * {"type":"tool-call","id":"call_25e9…","name":"","arguments":"{}"}
 * ```
 *
 * 实测最小复现（wire 上的 `function.name` → 上游结果）：
 *
 * | `function.name` | 结果 |
 * |---|---|
 * | `"read"` | 200 |
 * | `"unknown_tool"`（不存在的工具名） | 200 ← **只校验非空，不校验存在性** |
 * | `""` / `null` / 缺失 | **400 code 11133** |
 *
 * ## 为什么本文件测「序列化」而不是「消费」
 *
 * 坏块**已经**在用户会话历史里了，harness 不会自愈 —— 唯一能让存量会话恢复的
 * 就是**发请求前把它剔除**。这正是本文件锁定的行为：拿真实历史过一次**真实的
 * 适配器序列化函数**，断言空名块消失、且同批的合法调用**不被连累**。
 *
 * ⚠️ 线上真实形态是「**一个无名 call + 一个合法 pwsh** 并存」。若修法图省事整批
 * 丢弃，用户会白白损失一次有效工具调用 —— 故反向断言与正向同等重要。
 *
 * ## 落点为什么在 `resolveToolPairing` 一处
 *
 * 五个 provider 的序列化入口**全部**只按它返回的 `keepCallIds` 过滤工具调用
 * （`buddy-adapter` / `llm-adapter` / `lobsterai-adapter` / `qoder-adapter` /
 * `trae-cn-sse`，已逐个核对），所以边界放在那个共享函数里就**一次覆盖全部五条线**；
 * 分散到各适配器改 5 处 `String(block.name)` 会留下漏改与漂移的空间。
 * 本文件用**两个导出可测的真实序列化函数**（qoder / trae-cn）对该落点做端到端验证。
 */
import { describe, expect, it } from 'vitest'
import { serializeQoderMessages } from '../../src/qoder-adapter.js'
import { serializeTraeCnMessages } from '../../src/trae-cn-sse.js'

/** 线上实测的坏块形态：**完全没有 name** 的 tool-call，与一个合法的 pwsh 同批。 */
const REPLAY_HISTORY = [
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', id: 'call_bad', name: '', arguments: '{}' },
      { type: 'tool-call', id: 'call_good', name: 'pwsh', arguments: '{"command":"ls"}' },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId: 'call_bad', content: [{ type: 'text', text: 'unknown tool ""' }] },
      { type: 'tool-result', toolCallId: 'call_good', content: [{ type: 'text', text: 'a.ts' }] },
    ],
  },
] as const

/** 只含坏块的会话（验证「坏块单独出现时也不落 wire」）。 */
const REPLAY_ONLY_BAD = [
  {
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call_bad', name: '', arguments: '{}' }],
  },
  {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call_bad', content: [{ type: 'text', text: 'x' }] }],
  },
] as const

/** 从 wire 消息里取出 assistant 的 tool_calls 名字与 role:'tool' 的 id。 */
function extract(wire: Array<Record<string, unknown>>): { names: string[]; toolIds: string[] } {
  const assistant = wire.find((message) => message.role === 'assistant')
  const calls = (assistant?.tool_calls ?? []) as Array<{ function?: { name?: string } }>
  return {
    names: calls.map((call) => String(call.function?.name)),
    toolIds: wire
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.tool_call_id)),
  }
}

/**
 * 两个**已导出**的真实序列化入口。
 *
 * 另三条线（buddy / codearts / lobsterai）的 `serializeMessages` 是模块私有，
 * 无法直接单测；它们的覆盖来自「同一份 `resolveToolPairing` + 同一句
 * `keepCallIds` 过滤」这一结构事实（落点唯一性说明见文件头）。
 */
const SERIALIZERS: ReadonlyArray<[string, (messages: never) => Array<Record<string, unknown>>]> = [
  ['qoder', serializeQoderMessages as unknown as (messages: never) => Array<Record<string, unknown>>],
  ['trae-cn', serializeTraeCnMessages as unknown as (messages: never) => Array<Record<string, unknown>>],
]

describe.each(SERIALIZERS)('%s 序列化：重放存量会话时剔除空名 tool_call', (_label, serialize) => {
  it('空名块被剔除，且**不连累**同批的合法 pwsh 调用', () => {
    // 这是本修复的核心价值：已坏掉的会话**无需重开**即可恢复 ——
    // 用户下次发消息时坏块不再被重放，400 消失。
    const { names, toolIds } = extract(serialize(REPLAY_HISTORY as never))

    // ① 空名块必须消失（它就是 400 code 11133 的成因）。
    expect(names).not.toContain('')
    // ② 合法调用必须保留 —— 整批丢弃会让用户白丢一次有效工具调用。
    expect(names).toContain('pwsh')
    // ③ 配对必须自洽：剔掉 tool_call 后，它对应的 role:'tool' 结果也必须一起走，
    //    否则留下孤儿结果同样会被上游 400。
    expect(toolIds).toContain('call_good')
    expect(toolIds).not.toContain('call_bad')
  })

  it('整段历史只有坏块时，wire 上不出现任何 tool_calls / role:tool', () => {
    const wire = serialize(REPLAY_ONLY_BAD as never)
    const assistant = wire.find((message) => message.role === 'assistant')
    // 关键：不能留下一个空的 `tool_calls: []` 数组（部分网关会因此报参数错）。
    expect(assistant?.tool_calls).toBeUndefined()
    expect(wire.some((message) => message.role === 'tool')).toBe(false)
  })

  it('正常调用不受影响（修复是只删不加的）', () => {
    const healthy = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_ok', name: 'read', arguments: '{"file_path":"a.ts"}' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_ok', content: [{ type: 'text', text: 'ok' }] }],
      },
    ] as const
    const { names, toolIds } = extract(serialize(healthy as never))
    expect(names).toEqual(['read'])
    expect(toolIds).toEqual(['call_ok'])
  })
})
