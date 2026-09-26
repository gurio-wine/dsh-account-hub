/**
 * `account-hub-rpc.ts` **全部 `ok:false` 响应路径都必须带 `details`（record）** 的回归测试。
 *
 * ## 为什么这条必须单独钉死
 *
 * DSH 0.1.7-rc.1 的客户端解包（`@deepseek-ai/dsh-connection` 的
 * `parseConnectionResponse`）对失败响应是**严格校验**：
 *
 * ```ts
 * if (typeof error.code !== 'string' || typeof error.message !== 'string'
 *     || !isRecord(error.details)) {
 *   throw new TypeError('connection: invalid server-response failure')
 * }
 * ```
 *
 * `isRecord` = 对象、非 null、非数组。缺 `details` 时的表现**极具误导性**：
 * 客户端不是收到一条可展示的错误，而是抛 TypeError ⇒ 界面只能显示「未知故障」，
 * 而宿主侧的日志一切正常（handler 确实回了 `ok:false` 与可读 message）——
 * 排查者会往网络、往 handler 内部找，唯独想不到是**信封少了一个空对象**。
 *
 * 故 `reply()`（`src/account-hub-rpc.ts` 尾部）在 `ok === false` 时统一补
 * `details: {}`。本文件守的是两件事：
 *
 * 1. **漏斗唯一**（源码级）：`server-response` 信封在整个文件里只由 `reply()`
 *    构造，且 `reply()` 的补 `details` 是**无条件**的 —— 于是「有没有漏网」等价于
 *    「有没有绕过 reply() 的构造点」；
 * 2. **无绕过**（源码级 + 行为级）：文件里每一处 `{ok:false}` 字面量，要么位于
 *    `handleMethod` 内（其返回值在 fetch handler 里恰好经 `return reply(rpcId, result)`
 *    出网），要么本身就是 `reply(rpcId, …)` 的实参；再逐条**真的驱动 HTTP 处理器**
 *    触发这些分支，断言 `error.details` 是 record。
 *
 * ## 与既有 spec 的分工
 *
 * 既有的 `account-hub-rpc.spec.ts` / `account-hub-rpc-account-create.spec.ts` /
 * `account-consumption-rpc.spec.ts` / `auto-route-catalog.spec.ts` 各自断言的是
 * **某条分支的语义**（`code` 与 `message` 对不对）。本文件不重复那些语义，
 * 只横向扫「**每一条** `ok:false` 都带 `details`」这一条**跨分支不变式** ——
 * 新增分支时它当场变红，而语义用例不会有任何反应。
 *
 * ## 两个刻意不可达的构造点
 *
 * `account.create` 的 `region === undefined` 兜底（源码注释写明「不可达」）与
 * `credits.status` 的同类兜底都是**给将来新增 region 时显式接线用**的闸门，
 * 今天的取值域进不去。它们由上面的源码级断言覆盖（在 `handleMethod` 内 ⇒ 经
 * reach `reply()`），行为级用例不、也无法驱动它们 —— 这是如实记录，不是遗漏。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import { createContextTierRegistry } from '../../src/context-tiers.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 被测源文件（CRLF 归一化：Windows 上是 CRLF、CI 上是 LF）。 */
const SOURCE = readFileSync(resolve(here, '../../src/account-hub-rpc.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

/**
 * 全部 `{ok: false}` 字面量（含 `ok:false` 无空格形态）。
 *
 * 注意 `ok === false`（`reply()` 里的判别式）**不会**被本模式匹配 —— 它没有冒号，
 * 且它是「读」不是「构造」，不该计入构造点。
 */
function findOkFalseSites(source: string): Array<{ index: number; line: number }> {
  return [...source.matchAll(/\bok\s*:\s*false\b/g)].map((match) => ({
    index: match.index,
    // 1-based 行号，与编辑器/报错信息对齐。
    line: source.slice(0, match.index).split('\n').length,
  }))
}

// ── 源码级：漏斗唯一，且补 details 无条件 ────────────────────────────────────

describe('account-hub-rpc.ts —— 失败信封的唯一构造点', () => {
  it('`server-response` 信封在整个文件里只由 reply() 构造', () => {
    // 唯一一处 Response.json(...)，且它就是 reply() 的返回语句。
    expect(SOURCE.match(/Response\.json\(/g)).toHaveLength(1)
    // 信封类型字面量也唯一 —— 没有第二处能拼出 RPC 响应的形状。
    expect(SOURCE.match(/'server-response'/g)).toHaveLength(1)
    // 裸 Response 只有三个**传输层前置闸**（见下一个用例），绝无 JSON 信封。
    expect(SOURCE).not.toContain('new Response(JSON.stringify(')
  })

  it('reply() 对 ok===false 无条件补 details:{}', () => {
    const start = SOURCE.indexOf('function reply(')
    expect(start, '未找到 reply()').toBeGreaterThan(-1)
    // reply 是文件最后一个函数，直接取到尾即可（也顺带覆盖它的收尾括号）。
    const body = SOURCE.slice(start)
    expect(body).toContain("type: 'server-response'")
    // 判别式与补丁：`ok === false` ⇒ 展开原 error 并塞进 details:{}。
    expect(body).toContain('.ok === false')
    expect(body).toContain('details: {}')
    // 三元形态：命中补丁、未命中原样返回。改成 `if` 分支也合法，
    // 但这里锁的是「两条路都通向同一个信封」这一事实，故两个分支都要在场。
    expect(body).toMatch(/\?\s*\{[^]*?details: \{\}/)
    expect(body).toContain(': result')
    // 补丁只是**新增**字段，不得覆盖 handler 已填的 code / message。
    expect(body).toContain('...(result as Record<string, unknown>).error as Record<string, unknown>')
  })

  it('三个裸 Response 都是传输层前置闸：非 2xx、不带信封', () => {
    const guards = [...SOURCE.matchAll(/new Response\('([^']*)', \{ status: (\d+) \}\)/g)]
      .map(([, text, status]) => ({ text: text!, status: Number(status) }))
    expect(guards).toHaveLength(3)
    for (const guard of guards) {
      // 非 2xx 是**关键**：客户端 `call()` 先判 `response.ok` 并抛
      // `transport failure … HTTP <status>`，**根本不会**走到
      // `parseConnectionResponse`。故这三个响应无需（也不该）带 details。
      expect(guard.status).toBeGreaterThanOrEqual(400)
      expect(guard.text).not.toContain('server-response')
      expect(guard.text).not.toContain('ok')
    }
    expect(guards.map((g) => g.status).sort((a, b) => a - b)).toEqual([400, 405, 415])
  })

  it('每一处 {ok:false} 都进 reply()：在 handleMethod 内，或直接作为 reply() 实参', () => {
    const sites = findOkFalseSites(SOURCE)
    // 数量锁：新增/删除构造点必须显式改这里（否则「新增分支时变红」这条承诺失效）。
    expect(sites, `实际构造点行号：${sites.map((s) => s.line).join(', ')}`).toHaveLength(31)

    const dispatcherStart = SOURCE.indexOf('async function handleMethod(')
    const replyStart = SOURCE.indexOf('function reply(')
    expect(dispatcherStart, '未找到 handleMethod()').toBeGreaterThan(-1)
    expect(replyStart, '未找到 reply()').toBeGreaterThan(-1)
    // 顺序前提：分发器在前、reply 在后，故 [dispatcherStart, replyStart) 恰好是
    // handleMethod 的函数体区间（它内部不再声明嵌套函数 —— 下面的断言会确认）。
    expect(dispatcherStart).toBeLessThan(replyStart)

    const outside = sites.filter((site) => site.index < dispatcherStart || site.index > replyStart)
    // 落在分发器外 = 只允许 fetch handler 里那两处 `reply(rpcId, …)`（之一带换行）。
    //
    // ⚠️ 这里锁**行号**而不是只锁数量：数量相同但换了位置的构造点（例如把
    // `ok:false` 挪到信封层别处）必须让人显式改这一行才能通过。行号随上方任何
    // 改动漂移（最近的漂移来自 `undetermined` 抑制表的引入 —— 它在模块头加了
    // ~70 行，两处构造点整体下移同一个偏移量），改文件后照 `实际构造点行号`
    // 那条断言的提示同步即可。
    // 两处**同增同减**才是「纯位移」的特征：若只有一处变，说明构造点被搬到了
    // 别处，那正是本断言要逼人显式确认的情形，别顺手照抄新数字。
    expect(outside.map((site) => site.line)).toEqual([1877, 1889])
    for (const site of outside) {
      // 从该构造点往前找最近的 `return`，那一段必须已经打开了 `reply(rpcId, `。
      const returnAt = SOURCE.lastIndexOf('return ', site.index)
      expect(returnAt, `第 ${site.line} 行不在任何 return 里`).toBeGreaterThan(-1)
      expect(SOURCE.slice(returnAt, site.index), `第 ${site.line} 行绕过了 reply()`)
        .toContain('reply(rpcId,')
    }

    // 分发器内的构造点是**返回值**，在 fetch handler 里恰好经 `reply(rpcId, result)`
    // 出网 —— 断言这条唯一出口仍在（少了它，分发器内的一切都到不了客户端）。
    const handlerBody = SOURCE.slice(dispatcherStart, replyStart)
    expect(handlerBody).toContain('async function handleMethod(')
    expect(SOURCE).toContain('return reply(rpcId, result)')
    // 反向：分发器的返回值**不得**被别的构造点直接包成 Response。
    expect(handlerBody).not.toContain('new Response(')
    expect(handlerBody).not.toContain('Response.json(')
  })

  it('反向：fetch handler 只认 reply() 出网（没有第二条 server-response 通路）', () => {
    const handlerStart = SOURCE.indexOf('connection.fetch.register({')
    // ⚠️ 右边界取 `const checkinDeps`（register 调用之后的第一条语句），**不能**取
    // `handleMethod` —— 两者之间还夹着 `performCheckin`（它有自己的 return），
    // 用后者会把它的 return 一并算进来，断言就变成在数无关代码。
    const handlerEnd = SOURCE.indexOf('const checkinDeps')
    const dispatcherStart = SOURCE.indexOf('async function handleMethod(')
    expect(handlerStart).toBeGreaterThan(-1)
    expect(handlerEnd, '未找到 fetch handler 的右边界 const checkinDeps').toBeGreaterThan(handlerStart)
    expect(handlerEnd).toBeLessThan(dispatcherStart)
    const handlerBody = SOURCE.slice(handlerStart, handlerEnd)
    // handler 里三处 return 全是 Response：三个裸闸 + 三处 reply（成功 / 网关拒绝 / catch）。
    expect(handlerBody.match(/return reply\(rpcId,/g)).toHaveLength(3)
    expect(handlerBody.match(/return new Response\(/g)).toHaveLength(3)
    // 6 = 3 处 reply + 3 处裸闸，且**没有第三种 return 形态**（裸 return / 返回别的对象）。
    expect(handlerBody.match(/\breturn\b/g)).toHaveLength(6)
  })
})

// ── 行为级：逐分支驱动真实 HTTP 处理器 ──────────────────────────────────────

interface ErrorEnvelope {
  ok: false
  error: { code: string; message: string; details?: unknown }
}

/** record 判据与客户端 `isRecord` 逐字同源：对象、非 null、非数组。 */
function isRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type TierMap = ReadonlyMap<string, { contextWindow?: number; contextTiers?: readonly number[] }>

interface HarnessOptions {
  /** `ctx.get('llm')` 的返回值；`undefined` = llm 服务缺席。 */
  llm?: unknown
  /** 档位来源（交给真 `createContextTierRegistry`，不手搓对象）。 */
  tiers?: Record<string, { contextTiers(): Promise<TierMap> }>
  /** `account.create` 用到的 auth 替身；缺省时四个 provider 全部回 login-in-progress。 */
  codearts?: unknown
  lobsterai?: unknown
  traeCn?: unknown
  qoder?: unknown
  qoderCn?: unknown
}

/** `account.create` 的 provider 级互斥替身（只实现 `prepareLogin`）。 */
function loginInProgress(displayName: string) {
  return {
    prepareLogin: async () => ({
      ok: false as const,
      error: 'login-in-progress' as const,
      message: `已有 ${displayName} 登录进行中，请先完成或取消`,
    }),
  }
}

function makeHarness(options: HarnessOptions = {}) {
  let stored: Record<string, unknown> = {
    accounts: [],
    disabledModels: {},
    contextBudgets: {},
    checkins: {},
    consumption: {},
    consumptionCursors: {},
    autoRoute: { enabled: false, models: [] },
    schemaVersion: 3,
    providerAuditVersion: 0,
  }

  type Handler = (request: Request) => Promise<Response>
  let handler: Handler | undefined

  const credentials = {
    describe: async () => ({ configured: false, writable: true }),
    resolve: async () => undefined,
    set: async () => {},
    unset: async () => {},
  }

  const ctx = {
    get: (key: string) => {
      if (key === 'llm') return options.llm
      if (key === 'settings') {
        return {
          register: () => ({
            get: () => stored,
            replace: async (next: Record<string, unknown>) => { stored = next },
          }),
        }
      }
      if (key === 'connection') {
        return { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      }
      return undefined
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
  }

  const pool = new AccountPool(ctx as never)

  registerAccountHubRpc({
    ctx: ctx as never,
    pool,
    codearts: (options.codearts ?? loginInProgress('CodeArts')) as never,
    buddyCn: {} as never,
    buddy: {} as never,
    lobsterai: (options.lobsterai ?? loginInProgress('LobsterAI')) as never,
    traeCn: (options.traeCn ?? loginInProgress('Trae CN')) as never,
    qoder: (options.qoder ?? loginInProgress('Qoder')) as never,
    qoderCn: (options.qoderCn ?? loginInProgress('Qoder CN')) as never,
    contextTiers: options.tiers === undefined ? undefined : createContextTierRegistry(options.tiers) as never,
  })
  if (handler === undefined) throw new Error('account-hub 端点未注册')

  const send = (body: BodyInit, init: RequestInit = {}) => handler!(new Request(
    'http://127.0.0.1/api/account-hub',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init },
  ))

  /** 发一条规范 RPC 请求，返回**未解包**的 result（本文件要自己看 details）。 */
  const call = async (method: string, payload: unknown) => {
    const response = await send(JSON.stringify({
      type: 'client-request', rpcId: 'rpc-1', method: 'account-hub', payload: { method, payload },
    }))
    const body = await response.json() as { result: { ok: boolean; error?: { details?: unknown } } }
    return body.result
  }

  return { call, send, pool }
}

/**
 * 断言该 result 是**带 record details** 的失败响应。
 *
 * 先断言 `ok === false` 再断言 details：否则某条用例意外走了成功分支时，
 * `details` 断言会在 `undefined` 上「通过」（`undefined !== null && typeof …`
 * 为 false 时其实会失败 —— 但先锁 `ok` 能让失败信息直接指出「没覆盖到目标分支」）。
 */
function expectFailureWithDetails(result: unknown, label: string): ErrorEnvelope {
  const value = result as { ok?: unknown; error?: { details?: unknown } }
  expect(value.ok, `${label}：期望 ok=false，实际不是（本用例没覆盖到目标分支）`).toBe(false)
  const details = value.error?.details
  expect(
    isRecord(details),
    `${label}：error.details 必须是 record（客户端缺它会抛 `
    + `TypeError: connection: invalid server-response failure），实际 ${JSON.stringify(details)}`,
  ).toBe(true)
  return result as ErrorEnvelope
}

describe('account-hub-rpc —— 逐分支 ok:false 都带 details（行为级）', () => {
  /**
   * 每条用例都**必须**落到 `ok:false`（由 {@link expectFailureWithDetails} 锁死），
   * 且再核对 `code` / `message` 片段 —— 后者防止用例打偏到另一条同样是失败、
   * 却属于别的构造点的分支上（那样「覆盖」是假的）。
   */
  const CASES: Array<{
    label: string
    method: string
    payload: unknown
    code?: string
    message?: RegExp
    options?: HarnessOptions
  }> = [
    // ── account.create：未知 provider + 四个 provider 级互斥 ──
    {
      label: 'account.create 未知 provider',
      method: 'account.create', payload: { provider: 'mystery' },
      code: 'bad-request', message: /unknown provider: mystery/,
    },
    {
      label: 'account.create codearts 互斥',
      method: 'account.create', payload: { provider: 'codearts' },
      code: 'login-in-progress', message: /已有 CodeArts 登录进行中/,
    },
    {
      label: 'account.create lobsterai 互斥',
      method: 'account.create', payload: { provider: 'lobsterai' },
      code: 'login-in-progress', message: /已有 LobsterAI 登录进行中/,
    },
    {
      label: 'account.create trae-cn 互斥',
      method: 'account.create', payload: { provider: 'trae-cn' },
      code: 'login-in-progress', message: /已有 Trae CN 登录进行中/,
    },
    {
      label: 'account.create qoder 设备流互斥（region 解引用成对）',
      method: 'account.create', payload: { provider: 'qoder' },
      code: 'login-in-progress', message: /已有 Qoder 登录进行中/,
    },
    {
      label: 'account.create qoder-cn 设备流互斥',
      method: 'account.create', payload: { provider: 'qoder-cn' },
      code: 'login-in-progress', message: /已有 Qoder CN 登录进行中/,
    },

    // ── account.reorder：两处入参校验 + 集合不一致 ──
    {
      label: 'account.reorder provider 必填',
      method: 'account.reorder', payload: { provider: '', orderedIds: [] },
      code: 'bad-request', message: /provider 必填/,
    },
    {
      label: 'account.reorder orderedIds 必须是字符串数组',
      method: 'account.reorder', payload: { provider: 'buddy-cn', orderedIds: 'nope' },
      code: 'bad-request', message: /orderedIds 必须是字符串数组/,
    },
    {
      label: 'account.reorder 集合不一致（前端列表过期）',
      method: 'account.reorder', payload: { provider: 'buddy-cn', orderedIds: ['x'] },
      code: 'bad-request', message: /账号列表已变化/,
    },

    // ── 积分三端点：未知 provider ──
    {
      label: 'credits.status 未知 provider',
      method: 'credits.status', payload: { provider: 'mystery' },
      code: 'bad-request', message: /unsupported provider: mystery/,
    },
    {
      label: 'credits.claimAll 未知 provider',
      method: 'credits.claimAll', payload: { provider: 'mystery' },
      code: 'bad-request', message: /unsupported provider: mystery/,
    },
    {
      label: 'credits.balances 未知 provider',
      method: 'credits.balances', payload: { provider: 'mystery' },
      code: 'bad-request', message: /unsupported provider: mystery/,
    },

    // ── 自动签到：provider 必填 + 未知 provider ──
    {
      label: 'checkin.perform provider 必填',
      method: 'checkin.perform', payload: { provider: '' },
      code: 'bad-request', message: /provider 必填/,
    },
    {
      label: 'checkin.perform 未知 provider',
      method: 'checkin.perform', payload: { provider: 'mystery' },
      code: 'bad-request', message: /unsupported provider: mystery/,
    },

    // ── model.list：llm 缺席 / 目录查询抛错 ──
    {
      label: 'model.list llm 服务不可用',
      method: 'model.list', payload: { provider: 'buddy-cn' },
      code: 'bad-request', message: /llm 服务不可用/,
      options: { llm: undefined },
    },
    {
      label: 'model.list 读取模型列表失败',
      method: 'model.list', payload: { provider: 'buddy-cn' },
      code: 'bad-request', message: /读取模型列表失败：远端目录超时/,
      options: { llm: { listModels: async () => { throw new Error('远端目录超时') } } },
    },

    // ── 消耗配置：provider 必填 / 非法档位 ──
    {
      label: 'consumption.get provider 必填',
      method: 'consumption.get', payload: { provider: '' },
      code: 'bad-request', message: /provider 必填/,
    },
    {
      label: 'consumption.set provider 必填',
      method: 'consumption.set', payload: { provider: '' },
      code: 'bad-request', message: /provider 必填/,
    },
    {
      label: 'consumption.set 非法档位（回池那句带可选值的原文）',
      method: 'consumption.set', payload: { provider: 'buddy-cn', order: 'nope' },
      code: 'bad-request', message: /不支持的消耗顺序/,
    },

    // ── 自动路由：畸形顶层 + 非法配置 ──
    {
      label: 'autoroute.set 畸形顶层（挡住「静默成功」）',
      method: 'autoroute.set', payload: 42,
      code: 'bad-request', message: /自动路由配置必须是对象/,
    },
    {
      label: 'autoroute.set 非法配置（回池那句点名原文）',
      method: 'autoroute.set', payload: { models: [{ id: 'a', name: '甲', entries: [] }] },
      code: 'bad-request', message: /缺少模型条目/,
    },
    {
      label: 'autoroute.catalog llm 服务不可用',
      method: 'autoroute.catalog', payload: {},
      code: 'bad-request', message: /llm 服务不可用/,
      options: { llm: undefined },
    },

    // ── 模型开关与档位 ──
    {
      label: 'model.setDisabled 必填',
      method: 'model.setDisabled', payload: { provider: 'buddy-cn' },
      code: 'bad-request', message: /provider 与 modelId 必填/,
    },
    {
      label: 'model.setContextBudget 必填',
      method: 'model.setContextBudget', payload: { provider: 'buddy-cn' },
      code: 'bad-request', message: /provider 与 model 必填/,
    },
    {
      label: 'model.setContextBudget provider 无档位来源',
      method: 'model.setContextBudget', payload: { provider: 'lobsterai', model: 'm-1', window: 2 },
      code: 'bad-request', message: /provider 不支持上下文窗口档位: lobsterai/,
      options: { tiers: { 'buddy-cn': { contextTiers: async () => new Map() } } },
    },
    {
      label: 'model.setContextBudget 模型未声明窗口',
      method: 'model.setContextBudget', payload: { provider: 'buddy-cn', model: 'm-1', window: 2 },
      code: 'bad-request', message: /当前目录未声明上下文窗口/,
      options: { tiers: { 'buddy-cn': { contextTiers: async () => new Map() } } },
    },
    {
      label: 'model.setContextBudget 档位不在目录公布的可选值里',
      method: 'model.setContextBudget', payload: { provider: 'buddy-cn', model: 'm-1', window: 5_000 },
      code: 'bad-request', message: /可用档位为/,
      options: {
        tiers: {
          'buddy-cn': {
            contextTiers: async () => new Map([['m-1', { contextWindow: 1_000, contextTiers: [1_000, 2_000] }]]),
          },
        },
      },
    },

    // ── 兜底 ──
    {
      label: '未知 method',
      method: 'no.such.method', payload: {},
      code: 'bad-request', message: /unknown method: no\.such\.method/,
    },
  ]

  it.each(CASES)('$label', async ({ method, payload, code, message, options }) => {
    const harness = makeHarness(options)
    const result = await harness.call(method, payload)
    const failure = expectFailureWithDetails(result, method)
    if (code !== undefined) expect(failure.error.code).toBe(code)
    if (message !== undefined) expect(failure.error.message).toMatch(message)
  })

  it('用例表真的覆盖了每一条可达分支（防止表被清空后静默通过）', () => {
    // 行为级能驱动的构造点：全部 31 处减去 fetch 网关 1 处、catch 1 处、
    // 以及两处源码注释写明「不可达」的 region 兜底 = 27 条。这里只锁下界
    // （新增用例不必改），上界由上面的数量锁与源码级断言共同把住。
    expect(CASES.length).toBeGreaterThanOrEqual(27)
    const codes = new Set(CASES.map((c) => c.code))
    expect(codes.has('bad-request')).toBe(true)
    expect(codes.has('login-in-progress')).toBe(true)
  })
})

describe('account-hub-rpc —— 信封层两条失败路径（网关 + catch）', () => {
  it('畸形请求（非 client-request）回 gateway/bad-request，且带 details', async () => {
    const harness = makeHarness()
    const response = await harness.send(JSON.stringify({ type: 'not-a-request', rpcId: 'rpc-9' }))
    const body = await response.json() as { type: string; rpcId: string; result: unknown }
    // rpcId 回填：客户端靠它做请求关联，缺了会在 `rpcId mismatch` 上抛错。
    expect(body.type).toBe('server-response')
    expect(body.rpcId).toBe('rpc-9')
    const failure = expectFailureWithDetails(body.result, 'gateway')
    expect(failure.error.code).toBe('gateway/bad-request')
  })

  it('rpcId 非字符串时回填 invalid-request（仍带 details，不裸 500）', async () => {
    const harness = makeHarness()
    const response = await harness.send(JSON.stringify({ type: 'client-request', rpcId: 42 }))
    const body = await response.json() as { rpcId: string; result: unknown }
    expect(body.rpcId).toBe('invalid-request')
    expect(expectFailureWithDetails(body.result, 'gateway/rpcId').error.code).toBe('gateway/bad-request')
  })

  it('handler 抛错（account.update 未知账号）回 handler-failed，且带 details', async () => {
    const harness = makeHarness()
    const result = await harness.call('account.update', { accountId: 'nope', patch: {} })
    const failure = expectFailureWithDetails(result, 'handler-failed')
    // 这条是「客户端只看到未知故障」的历史成因：若 reply() 没补 details，
    // 客户端会把这条**可读**的 message 换成 TypeError。
    expect(failure.error.code).toBe('account-hub/handler-failed')
    expect(failure.error.message).toMatch(/Account nope not found/)
  })
})

describe('account-hub-rpc —— 三个传输层前置闸不带信封（非 2xx，客户端先抛 transport failure）', () => {
  it('非 POST → 405', async () => {
    const harness = makeHarness()
    const response = await harness.send(undefined, { method: 'GET' })
    expect(response.status).toBe(405)
    expect(await response.text()).toBe('method not allowed')
  })

  it('content-type 非 application/json → 415', async () => {
    const harness = makeHarness()
    const response = await harness.send('x', { headers: { 'content-type': 'text/plain' } })
    expect(response.status).toBe(415)
  })

  it('body 不是 JSON → 400', async () => {
    const harness = makeHarness()
    const response = await harness.send('{ not json')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('body is not JSON')
  })

  it('三者的响应体都不是 RPC 信封（客户端在 response.ok 处就抛了，走不到解包）', async () => {
    const harness = makeHarness()
    for (const [body, init] of [
      [undefined, { method: 'GET' }],
      ['x', { headers: { 'content-type': 'text/plain' } }],
      ['{ not json', {}],
    ] as Array<[BodyInit | undefined, RequestInit]>) {
      const response = await harness.send(body, init)
      expect(response.status).toBeGreaterThanOrEqual(400)
      // 不是 JSON ⇒ 连被误当信封解析的机会都没有。
      await expect(response.clone().json()).rejects.toThrow()
    }
  })
})
