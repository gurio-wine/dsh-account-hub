/**
 * Account Hub 的 **Qoder 面板**回归测试（两区：`qoder` / `qoder-cn`）。
 *
 * ## 本文件当前守什么
 *
 * ⚠️ **PAT 粘贴式登录形态已于 2026-09-21 按用户要求整体移除**（原话：「我说
 * 不要pat登录，只要浏览器登录了」），故原先围绕 PAT 的四组测试
 * （`providerPatLogin` / `createAccountWithPat` / `normalizePatInput` /
 * `PatLoginForm`）连同 `QODER_PAT_URL` 的跨侧副本断言一并删除 ——
 * 那些实现已不在客户端源码里，留着只会全部变红。
 *
 * 现在守的是**与登录形态无关**的那些契约：
 *
 * 1. **面板 id 就是账号池键**（A 组）：Qoder 是**恒等映射**。改错的失效形态是
 *    CN 面板列出国际版账号、用 CN 凭据打国际版 host —— 端点仍回 `ok: true`，
 *    只是账号对不上。
 * 2. **凭据 ref 前缀**（`QODER_ACCOUNT_*` / `QODER_CN_ACCOUNT_*`），且必须被真实的
 *    `credentialRef()` 接受。ref 一旦非法，凭据**从未落盘**，账号池里会留下
 *    一个永远没有凭据的幽灵条目。
 * 3. **能力矩阵驱动、客户端不特判 provider**：积分行为全部经
 *    `credits-capabilities.js`，面板里不得出现 `provider === 'qoder'` 这类散落
 *    比较（散落条件的失效形态是「按钮还在，点了报 unknown provider」）。
 * 4. **两区共用同一份实现**：客户端没有 CN 专属分支。
 *
 * 登录 UI 本身（渲染 / 点击 / 开窗）由 `tests/unit/qoder-hub-blank-screen.spec.ts`
 * 用真实渲染 + 派发点击守住；这里只做源码级断言，因为 `ProviderPanel` 用了
 * hooks 而 react 不在本仓库依赖里（见 `account-hub-credit-balance-row.spec.ts` 文件头）。
 *
 * ## 为什么 Qoder 不需要 `poolProviderFor` 映射
 *
 * `poolProviderFor` 今天是**恒等**的（它曾服务过一个「面板 id ≠ 池键」的共用账号
 * provider，那条路径已整体移除）。它仍是**收敛点**：客户端一律只发面板 id。
 * Qoder 的断言因此是「映射函数对 qoder **原样返回**」——
 * 一旦将来有人把某个 region 接进共享账号池，这些断言会立刻变红。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  accountCredentialRefName,
  poolProviderFor,
  registerAccountHubRpc,
} from '../../src/account-hub-rpc.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 客户端 bundle 的源码（未打包的 plugin-src 版本），归一化 CRLF。 */
function readClientSourceNormalized(): string {
  return readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 去掉**整行**注释后的正文。
 *
 * 有几条断言查的是「正文里不得出现某段代码」，而文件里保留了大量叙述历史缺陷
 * 的注释（本仓库的注释风格本就如此）—— 不剥注释会把「注释里解释过这件事」
 * 误判成「代码里又写了一遍」。
 */
function codeLinesOf(source: string): string {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 真实 RPC 分派：面板 id 就是池键，qoder 不需要任何映射
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 ctx / pool 替身并注册端点，返回一个 `call(method, payload)`。
 *
 * 驱动 `registerAccountHubRpc` 注册出来的**真实 HTTP 处理器**，而不是断言源码里
 * 出现过某个字符串 —— 前者能证明「分派真的走对了」，后者只能证明「提到过」。
 */
function makeHarness(
  accounts: ProviderAccountEntry[],
  overrides: {
    /** 注入的档位来源（第 10 参注册表只含它；缺省 = 未注册，与旧形态一致）。 */
    tierSource?: unknown
    /** `ctx.llm.listModels` 替身返回的目录（缺省为旧的硬编码一项）。 */
    models?: Array<{ id: string; name: string }>
    /** 黑名单替身返回的表（缺省空表）。 */
    disabledModels?: Record<string, boolean>
  } = {},
) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  /** `account.list` 实际拿去查池的 provider。 */
  const listAccountsCalls: string[] = []
  /** `model.list` 透传给 `ctx.llm` 的 provider。 */
  const listModelsCalls: string[] = []
  /** 黑名单**读取**用的 provider 键。 */
  const listDisabledCalls: string[] = []
  const setModelDisabledCalls: Array<{ provider: string; modelId: string; disabled: boolean }> = []

  const ctx: Record<string, unknown> = {
    connection: {
      fetch: {
        register: (config: { fetch: (request: Request) => Promise<Response> }) => {
          handler = config.fetch
        },
      },
    },
    // 生产代码用**惰性注入**（`ctx.inject(['connection'], …)`）挂载端点；
    // 替身必须复刻这一机制，否则 registerAccountHubRpc 会直接抛
    // `ctx.inject is not a function`。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    // `model.list` 走 `ctx.get('llm')`，返回适配器播报的目录。
    get: (name: string) => name === 'llm'
      ? {
          listModels: async (provider: string) => {
            listModelsCalls.push(provider)
            return overrides.models ?? [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }]
          },
        }
      : undefined,
  }

  const pool = {
    listAccounts: async (provider: string) => {
      listAccountsCalls.push(provider)
      return accounts.filter((a) => a.provider === provider)
    },
    // 返回一个**总是为空**的黑名单：`model.list` 会把「在黑名单里却不在这份
    // 目录里」的模型补回列表，替身若造假键，目录里就会凭空多出一项。
    // （需要回填行的用例经 `overrides.disabledModels` 提供真键。）
    listDisabledModels: (provider: string) => {
      listDisabledCalls.push(provider)
      return overrides.disabledModels ?? {}
    },
    setModelDisabled: async (provider: string, modelId: string, disabled: boolean) => {
      setModelDisabledCalls.push({ provider, modelId, disabled })
    },
  }

  registerAccountHubRpc(
    ctx as never,
    pool as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // qoder / qoderCn：本文件只断 `account.list` / `model.*` / `poolProviderFor`
    // 的分派（不建号、不查余额），两条 Qoder 分支都不会被进入。
    {} as never,
    {} as never,
    // 档位来源注册表（第 10 参，可选）：注入时按 provider 恒返回同一个来源 ——
    // 生产形态是「provider id → 适配器」，这里只需要「有没有被问到」。
    ...(overrides.tierSource === undefined
      ? []
      : [{ sourceFor: () => overrides.tierSource }]),
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  return {
    listAccountsCalls,
    listModelsCalls,
    listDisabledCalls,
    setModelDisabledCalls,
    call: async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://127.0.0.1/api/account-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'r1',
          method: 'account-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    },
  }
}

/**
 * 一个 Qoder 账号条目。
 *
 * `provider` 参数化而不是写死 `'qoder'`：Qoder 与国际版是**两套互相隔离的
 * 账号池**（CN 凭据 ref 前缀是 `QODER_CN_ACCOUNT`），本文件要用同一构造器造出
 * 两边的条目，才能断言「一个面板看不到另一个面板的账号」。
 */
function qoderEntry(id: string, enabled = true, provider: 'qoder' | 'qoder-cn' = 'qoder'): ProviderAccountEntry {
  return {
    id,
    provider,
    nickname: id,
    enabled,
    credentialRef: `${provider === 'qoder' ? 'QODER' : 'QODER_CN'}_ACCOUNT_${id.toUpperCase()}`,
    createdAt: 1,
    refreshable: true,
  }
}

describe('poolProviderFor：qoder 恒等映射', () => {
  it('qoder 原样返回', () => {
    // Qoder 的面板 id、账号池键、凭据 ref 前缀、模型黑名单键**全是同一个字符串**。
    // 这条断言看似废话，它的价值在于：一旦将来有人把 Qoder 接进某个共享账号池，
    // 必须同时改这里与宿主的分派，而那时这条会立刻变红提醒他确认。
    expect(poolProviderFor('qoder')).toBe('qoder')
    expect(poolProviderFor(QODER.id)).toBe('qoder')
  })

  it('qoder-cn 同样原样返回（两个 region 是**各自的**账号池，不做任何映射）', () => {
    // Qoder CN 有**自己的凭据体系**（`QODER_CN_ACCOUNT_*`）
    // 与**自己的额度**（两区互不承认令牌）。
    // 若有人照抄「共享账号池」的写法把 `qoder-cn` 映射到 `qoder`：CN 面板会列出
    // 国际版账号、打国际版的 host 用 CN 凭据 —— 得到的是「凭据失效」的假象，
    // 而且**不报任何错**。这条断言就是那个陷阱的哨兵。
    expect(poolProviderFor('qoder-cn')).toBe('qoder-cn')
    expect(poolProviderFor(QODER_CN.id)).toBe('qoder-cn')
    // 反向映射也不存在：`qoder` 不得被送去 CN。
    expect(poolProviderFor('qoder')).not.toBe('qoder-cn')
  })

  it('其余 provider（含未登记的）一律原样返回 —— 映射今天是恒等的', () => {
    // 这是「恒等」这件事的直接锚点：若有人把 poolProviderFor 改成对某个 provider
    // 做了映射（历史上有过一例共用账号的 provider），这条会红。
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'mystery']) {
      expect(poolProviderFor(provider), provider).toBe(provider)
    }
  })
})

describe('Qoder 面板的 RPC 分派（qoder 一路原样透传）', () => {
  it('account.list 按 `qoder` 查池，账号条目拿得到', async () => {
    const h = makeHarness([qoderEntry('qoder-1'), qoderEntry('qoder-2', false)])
    const result = await h.call('account.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as { accounts: ProviderAccountEntry[] }
    expect(value.accounts.map((a) => a.id)).toEqual(['qoder-1', 'qoder-2'])
    // 池确实按 `qoder` 查的 —— 若哪天有人给它加了映射，账号会一个都查不到，
    // 而端点的 ok 仍是 true（面板只是「尚未配置账号」）。
    expect(h.listAccountsCalls).toEqual(['qoder'])
  })

  it('model.list 把 `qoder` 原样透传给 ctx.llm（黑名单键就是这个 id）', async () => {
    const h = makeHarness([qoderEntry('qoder-1')])
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    // 适配器由 `registerQoderLlm` 按 `qoder` 注册；映射到别处会列出别的
    // provider 的目录，与 Qoder 实际可选的模型完全对不上。
    expect(h.listModelsCalls).toEqual(['qoder'])
    // 黑名单也按同一个键读：模型与开关必须同源，否则开关会「点了没反应」。
    expect(h.listDisabledCalls).toEqual(['qoder'])
    const value = result.value as { models: Array<{ id: string; disabled: boolean }> }
    expect(value.models).toEqual([{ id: 'qwen3-coder', name: 'Qwen3 Coder', disabled: false }])
  })

  it('model.setDisabled 写入 `qoder` 键', async () => {
    const h = makeHarness([qoderEntry('qoder-1')])
    const result = await h.call('model.setDisabled', {
      provider: 'qoder', modelId: 'qwen3-coder', disabled: true,
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.setModelDisabledCalls).toEqual([
      { provider: 'qoder', modelId: 'qwen3-coder', disabled: true },
    ])
  })
})

describe('Qoder CN 面板的 RPC 分派（qoder-cn 一路原样透传，**不**落到国际版）', () => {
  it('account.list 按 `qoder-cn` 查池：**只**列出 CN 账号，国际版的一个都不出现', async () => {
    // 两区是两套账号池。若有人把 `qoder-cn` 映射到 `qoder`（照抄 Work 的写法），
    // 这条会在「列出的账号」与「查池实参」两处同时失败 —— 且端点仍回 ok:true。
    const h = makeHarness([
      qoderEntry('qoder-1'),
      qoderEntry('intl-only', true, 'qoder'),
      qoderEntry('cn-1', true, 'qoder-cn'),
      qoderEntry('cn-2', false, 'qoder-cn'),
    ])
    const result = await h.call('account.list', { provider: 'qoder-cn' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as { accounts: ProviderAccountEntry[] }
    expect(value.accounts.map((a) => a.id)).toEqual(['cn-1', 'cn-2'])
    expect(h.listAccountsCalls).toEqual(['qoder-cn'])
  })

  it('反过来：`qoder` 面板列不到 CN 账号（两个方向都隔离）', async () => {
    // 只钉一个方向不够 —— 「两池独立」是**双向**断言，单向的绿可能是过滤写反
    // 却恰好也对（例如两边都返回全表时）。
    const h = makeHarness([
      qoderEntry('intl-1'),
      qoderEntry('cn-1', true, 'qoder-cn'),
    ])
    const result = await h.call('account.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    expect((result.value as { accounts: ProviderAccountEntry[] }).accounts.map((a) => a.id))
      .toEqual(['intl-1'])
    expect(h.listAccountsCalls).toEqual(['qoder'])
  })

  it('model.list 把 `qoder-cn` 原样透传给 ctx.llm，黑名单也读同一个键', async () => {
    // 两个 region 的模型目录**不同源**（CN 是 14 项、全 is_enabled），
    // 透传成 `qoder` 会列出国际版的目录，与实际可调的模型完全对不上。
    const h = makeHarness([qoderEntry('cn-1', true, 'qoder-cn')])
    const result = await h.call('model.list', { provider: 'qoder-cn' })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.listModelsCalls).toEqual(['qoder-cn'])
    expect(h.listDisabledCalls).toEqual(['qoder-cn'])
  })

  it('model.setDisabled 写入 `qoder-cn` 键（不写进国际版的黑名单）', async () => {
    // 黑名单按 provider id 存：映射过去会把 CN 的开关写进国际版，两个面板的
    // 显示列表互相串味，而**两边都不报错**。
    const h = makeHarness([qoderEntry('cn-1', true, 'qoder-cn')])
    const result = await h.call('model.setDisabled', {
      provider: 'qoder-cn', modelId: 'qmodel_38max', disabled: true,
    })
    expect(result.ok, result.error?.message).toBe(true)
    expect(h.setModelDisabledCalls).toEqual([
      { provider: 'qoder-cn', modelId: 'qmodel_38max', disabled: true },
    ])
  })
})

describe('Qoder 的账号凭据 ref 前缀', () => {
  it('accountCredentialRefName 产出 QODER_ACCOUNT_xxx，且被真实的 credentialRef() 接受', () => {
    const name = accountCredentialRefName('qoder', 'A1B2C3D4')
    expect(name).toBe('QODER_ACCOUNT_A1B2C3D4')
    // 不抛 TypeError 才是关键：ref 一旦非法，凭据**从未落盘**，账号池里会留下
    // 一个永远没有凭据的幽灵条目（见 src/account-hub-rpc.ts 的后果链说明）。
    // Qoder 无连字符，归一化前后逐字符相同，故既有形态无需迁移。
    expect(() => credentialRef(name)).not.toThrow()
  })

  it('qoder-cn 的 ref 前缀是 QODER_CN_ACCOUNT —— 连字符被归一化成下划线', () => {
    // ⚠️ 这里是**带连字符**的 id：`accountCredentialRefName` 会做
    // `toUpperCase().replace(/-/g, '_')`，得到 `QODER_CN_ACCOUNT_xxx`。
    // 若归一化规则变了（比如保留连字符），ref 会变成 `QODER-CN_ACCOUNT_xxx` ——
    // **非法 ref ⇒ 凭据落不了盘**，而账号池里照样多出条目（幽灵账号）。
    // 更要紧的是它必须与 `QODER_CN.accountCredentialRefPrefix` 逐字符一致：
    // 两处漂移的后果是「凭据写到一个名字、读的时候找另一个名字」。
    const name = accountCredentialRefName('qoder-cn', 'A1B2C3D4')
    expect(name).toBe('QODER_CN_ACCOUNT_A1B2C3D4')
    expect(() => credentialRef(name)).not.toThrow()
    expect(name).toBe(`${QODER_CN.accountCredentialRefPrefix}_A1B2C3D4`)
    expect(QODER_CN.accountCredentialRefPrefix).toBe('QODER_CN_ACCOUNT')
    // 两区前缀**不得**互为前缀关系（`QODER_ACCOUNT` 不是 `QODER_CN_ACCOUNT` 的
    // 前缀，但拼错一个字符就会撞上，故直接钉死两者不相等）。
    expect(QODER_CN.accountCredentialRefPrefix).not.toBe(QODER.accountCredentialRefPrefix)
  })

  it('与宿主 src/qoder-product.ts 的 accountCredentialRefPrefix 逐字符一致', () => {
    // 两处漂移的后果是「凭据写到一个名字、读的时候找另一个名字」——
    // 账号建得出来，但下一次请求就报「请先登录」。
    expect(accountCredentialRefName('qoder', 'A1B2C3D4'))
      .toBe(`${QODER.accountCredentialRefPrefix}_A1B2C3D4`)
    expect(QODER.accountCredentialRefPrefix).toBe('QODER_ACCOUNT')
  })
})

describe('能力矩阵驱动的积分行为在客户端不被 qoder 特判', () => {
  const normalized = readClientSourceNormalized()

  it('两处门控都取自能力矩阵函数，源码里没有第二份 provider 白名单', () => {
    // 能力矩阵是唯一真相源（见 plugin-src/client/credits-capabilities.js）。
    // Qoder 的 `dailyCheckin` 是 false（每日 100 Credits 只能在桌面 App 手动领），
    // 故面板不会渲染签到按钮 —— 那是矩阵的事，不是面板里再写一条 if。
    expect(normalized).toContain('const canLoadCredits = supportsCreditBalance(provider);')
    expect(normalized).toContain('const supportsCredits = supportsDailyCheckin(provider);')
    // 签到按钮按矩阵渲染。
    expect(normalized).toMatch(/supportsCredits\n\s*\? React\.createElement\('button'/)
  })

  it('两个 Qoder region 走**同一条**能力矩阵路径（CN 不新增任何客户端分支）', () => {
    // Qoder CN 的面板与 Qoder 面板在客户端唯一的差别就是 `provider` 的取值 ——
    // 积分行、积分按钮、登录入口全部由矩阵驱动。
    // 故这里断言：文件里 provider 取值的来源只有面板 prop，没有 CN 专属逻辑。
    expect(normalized).not.toMatch(/qoder-cn['"]\s*\)/);  // 不存在 isCn(provider) 之类的调用
    // 两区的**显示池**也不同源（各查各的额度端点），但那是宿主的事：
    // 客户端不选池、不传 pool 参数（选池是宿主 `credits.balances` 分支的职责，
    // 客户端从不实现映射 —— 见 client 侧 `account.list` 那条断言）。
    // 先剥整行注释：文件里叙述选池这件事的**注释**是合理的，
    // 判据是**调用**而不是子串。
    const code = codeLinesOf(normalized)
    expect(code).not.toMatch(/qoderRegionFor\s*\(/);
  })

  it('credits.claimAll 与 credits.balances 的调用点邻域里没有 qoder 字面量', () => {
    // 这两条是「能力矩阵驱动、而非 provider 特判」的可执行形式：只要有人在
    // 调用点旁边加一句 `provider === 'qoder' ? … : …`，这条立刻红。
    //
    // 同样先剥整行注释：窗口取的是**调用点邻域**，紧邻的文档注释里提一句 qoder
    // （解释「Qoder 没有签到能力」是合理叙述）不该被判成违规。
    const code = codeLinesOf(normalized)
    for (const call of ["rpcCall('credits.claimAll'", "rpcCall('credits.balances'"]) {
      const at = code.indexOf(call)
      expect(at, call).toBeGreaterThan(-1)
      const around = code.slice(Math.max(0, at - 400), at + 400)
      expect(around, call).not.toContain('qoder')
    }
  })
})

describe('qoder 不作为比较表达式出现（判据是表达式，不是子串）', () => {
  const code = codeLinesOf(readClientSourceNormalized())

  it('正文里没有任何 === / !== 的 qoder 字面量比较', () => {
    // ⚠️ 判据必须是**比较表达式**而不是 `'qoder'` 这个子串：`PROVIDERS` 条目
    // （`id: 'qoder'`）与 `QODER_ICON` 里**本来就应该**出现它 —— 查子串会把
    // 这两处全部误判成违规，于是这条断言只能被删掉，也就什么都守不住了。
    //
    // （PAT 形态移除前这里还列了 `PAT_LOGIN_PROVIDERS` 的键与 `QODER_PAT_URL`，
    //   两处都已随实现删除。）
    const COMPARISONS: ReadonlyArray<RegExp> = [
      /===\s*'qoder'/, /!==\s*'qoder'/, /===\s*"qoder"/, /!==\s*"qoder"/,
      /'qoder'\s*===/, /'qoder'\s*!==/, /"qoder"\s*===/, /"qoder"\s*!==/,
    ]
    for (const pattern of COMPARISONS) {
      expect(code, String(pattern)).not.toMatch(pattern)
    }
  })

  it('反过来，qoder 子串确实出现在条目与图标常量里（所以判据只能是表达式）', () => {
    expect(code).toContain("id: 'qoder'")
    expect(code).toContain('const QODER_ICON = ')
    expect(code).toMatch(/qoder/)
  })

  it('`qoder-cn` 也不作为比较表达式出现（它是**另一个** id，不是 `qoder` 的别名）', () => {
    // ⚠️ 判据同样是**表达式**而不是子串：`id: 'qoder-cn'` 与 `logoClass: 'qoder-cn'`
    // 里都**本该**出现它。
    // 面板里一旦出现 `provider === 'qoder-cn'` 这类散落比较，将来漏改一处就是
    // 「按钮还在，点了报 unknown provider」。
    const COMPARISONS: ReadonlyArray<RegExp> = [
      /===\s*'qoder-cn'/, /!==\s*'qoder-cn'/, /===\s*"qoder-cn"/, /!==\s*"qoder-cn"/,
      /'qoder-cn'\s*===/, /'qoder-cn'\s*!==/, /"qoder-cn"\s*===/, /"qoder-cn"\s*!==/,
    ]
    for (const pattern of COMPARISONS) {
      expect(code, String(pattern)).not.toMatch(pattern)
    }
    // 反面锚点：子串确实在（否则上面那组在条目被删掉时也是绿的）。
    expect(code).toContain("id: 'qoder-cn'")
    expect(code).toContain("logoClass: 'qoder-cn'")
    // ⚠️ 两区的 `icon` **刻意复用同一个 `QODER_ICON`**（同一品牌）：这条钉死
    // 「复用的是同一个常量，而不是又内联了一份新图标」。
    expect(code).toMatch(/id: 'qoder-cn', label: 'Qoder CN', icon: QODER_ICON/)
  })
})

// ── model.list 的回填行显示名与目录来源（B1 / C3，2026-09-21） ────────────────

describe('model.list：黑名单回填行的显示名与 catalogSource', () => {
  /** 一个最小的档位来源替身（RPC 层只消费这三个方法的形状）。 */
  function makeTierSource(overrides: {
    displayName?: (id: string) => string | undefined
    catalogSource?: () => 'remote' | 'fallback'
  } = {}) {
    return {
      contextTiers: async () => new Map(),
      ...overrides.displayName === undefined ? {} : { displayName: overrides.displayName },
      ...overrides.catalogSource === undefined ? {} : { catalogSource: overrides.catalogSource },
    }
  }

  it('回填行用 tierSource.displayName 查名，查到就不再写死 name=id', async () => {
    const h = makeHarness([qoderEntry('qoder-1')], {
      // 目录只播报一项；黑名单里有两个不在目录的键 → 都要回填。
      models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }],
      disabledModels: { qmodel_38max: true, mystery_model: true },
      tierSource: makeTierSource({
        displayName: (id) => (id === 'qmodel_38max' ? 'Qwen3.8-Max' : undefined),
        catalogSource: () => 'fallback',
      }),
    })
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }
    const backfilled = value.models.filter((m) => m.disabled)
    expect(backfilled).toContainEqual({
      id: 'qmodel_38max', name: 'Qwen3.8-Max', disabled: true,
    })
    // 查不到名字（未知 id）→ 仍回退 id（与既有行为一致，宁缺毋编）。
    expect(backfilled).toContainEqual({
      id: 'mystery_model', name: 'mystery_model', disabled: true,
    })
  })

  it('tierSource 实现了 catalogSource 时，响应带出该字段（fallback）', async () => {
    const h = makeHarness([qoderEntry('qoder-1')], {
      tierSource: makeTierSource({ catalogSource: () => 'fallback' }),
    })
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    expect((result.value as { catalogSource?: string }).catalogSource).toBe('fallback')
  })

  it('tierSource 实现 catalogSource 为 remote 时同样带出（远端成功过）', async () => {
    const h = makeHarness([qoderEntry('qoder-1')], {
      tierSource: makeTierSource({ catalogSource: () => 'remote' }),
    })
    const result = await h.call('model.list', { provider: 'qoder' })
    expect((result.value as { catalogSource?: string }).catalogSource).toBe('remote')
  })

  it('未注入 tierSource 时响应不带 catalogSource（其余 provider 不渲染提示行）', async () => {
    const h = makeHarness([qoderEntry('qoder-1')])
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    expect((result.value as { catalogSource?: string }).catalogSource).toBeUndefined()
  })

  it('旧形态 tierSource（只有 contextTiers，无可选方法）不炸、不带字段、回填回退 id', async () => {
    const h = makeHarness([qoderEntry('qoder-1')], {
      models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }],
      disabledModels: { off_catalog: true },
      // 向后兼容：既有适配器实现（buddy / trae 系）没有这两个可选方法。
      tierSource: { contextTiers: async () => new Map() },
    })
    const result = await h.call('model.list', { provider: 'qoder' })
    expect(result.ok, result.error?.message).toBe(true)
    const value = result.value as {
      catalogSource?: string
      models: Array<{ id: string; name: string }>
    }
    expect(value.catalogSource).toBeUndefined()
    expect(value.models).toContainEqual({ id: 'off_catalog', name: 'off_catalog', disabled: true })
  })
})
