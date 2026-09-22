import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../../src/index.js'
import * as pluginEntry from '../../src/index.js'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { TraeCnAuth } from '../../src/trae-cn-auth.js'
import { QoderAuth } from '../../src/qoder-auth.js'
import { BUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
  runOAuthFlow: vi.fn(),
}))

// Buddy 登录会真实发起轮询网络请求：插件层测试只关心命令/路由注册，故 mock 整个流程。
// RefreshTokenExpiredError 必须保留真实实现：buddy-auth 的 RefreshScheduler
// onError 回调以 `error instanceof RefreshTokenExpiredError` 判定续期是否
// 彻底失效；mock 缺少该导出会让判定路径抛出 unhandled rejection。
vi.mock('../../src/buddy-oauth.js', async (importOriginal) => ({
  ...await importOriginal(),
  runBuddyLoginFlow: vi.fn(),
}))

const mockedRunLoginFlow = vi.mocked(runLoginFlow)
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)
const mockedRunBuddyLoginFlow = vi.mocked(runBuddyLoginFlow)

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

class FakeCommands {
  readonly definitions: CommandDefinition[] = []
  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

class FakeLlm {
  readonly providers: string[] = []
  readonly adapters: string[] = []
  /** `registerConfigurableProviders` 的入参明细，供目录项（displayName/settingsNs）断言使用。 */
  readonly configurableProviders: Array<{ provider: string; displayName?: string; settingsNs?: string }> = []
  /** `registerAdapter` 注册的路由名，供 provider 路由断言使用。 */
  readonly registeredProviders: string[] = []
  registerConfigurableProviders(
    entries: Array<{ provider: string; displayName?: string; settingsNs?: string }>,
  ): { replace: () => void } {
    for (const entry of entries) {
      this.providers.push(entry.provider)
      this.configurableProviders.push(entry)
    }
    return { replace: () => {} }
  }
  registerAdapter(providers: string[], _adapter: unknown): { replace: () => void } {
    this.adapters.push(...providers)
    this.registeredProviders.push(...providers)
    return { replace: () => {} }
  }
}

/**
 * settings 服务的替身。
 *
 * `registerProviderSettings` 会注册 provider 配置 namespace 并回读 `describe()`
 * 自检，因此替身必须同时实现 `register` 与 `describe`，否则自检日志会走
 * “describe 失败”分支，无法反映真实的 namespace 注册结果。
 */
class FakeSettings {
  readonly registeredNamespaces: string[] = []
  register(ns: string, _schema: unknown): void {
    if (!this.registeredNamespaces.includes(ns)) this.registeredNamespaces.push(ns)
  }
  describe(): Array<{ ns: string }> {
    return this.registeredNamespaces.map((ns) => ({ ns }))
  }
}

function makeContext(): { ctx: Context; commands: FakeCommands; llm: FakeLlm; settings: FakeSettings } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const commands = new FakeCommands()
  ctx.provide('commands', commands as never)
  const llm = new FakeLlm()
  ctx.provide('llm', llm as never)
  const settings = new FakeSettings()
  ctx.provide('settings', settings as never)
  return { ctx, commands, llm, settings }
}

/**
 * WorkBuddy 测试所用的 mock 上下文。
 *
 * 返回真实的 `Context`（`apply()` 需要它），替身通过 `ctx.provide` 注入，
 * 测试里可直接以 `ctx.llm` / `ctx.settings` 取回并断言。
 */
function createMockContext(): Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings } {
  return makeContext().ctx as Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('plugin entry', () => {
  it('registers the codeartsAuth service and the codearts-login command', () => {
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(commands.definitions.map((d) => d.name)).toContain('codearts-login')
  })

  it('command handler reports success with ref and expiry', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text?: string }).text).toContain('CODEARTS_ACCESS_TOKEN')
  })

  it('command handler reports a failure as an error result', async () => {
    mockedRunOAuthFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'CodeArts login timed out' })
  })

  it('registers the codearts LLM route and the status/refresh commands', () => {
    const { ctx, commands, llm } = makeContext()
    apply(ctx)
    expect(llm.providers).toContain('codearts')
    expect(llm.adapters).toContain('codearts')
    const names = commands.definitions.map((d) => d.name)
    expect(names).toContain('codearts-status')
    expect(names).toContain('codearts-refresh')
  })

  it('codearts-status reports refreshability', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const status = commands.definitions.find((d) => d.name === 'codearts-status')!
    const result = await status.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
  })

  it('stops the refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.codeartsAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

describe('buddy plugin entry', () => {
  it('registers the buddyCnAuth service without slash commands', () => {
    // 登录/状态/续期都在 Account Hub 设置页完成，命令式入口已移除。
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.buddyCnAuth).toBeInstanceOf(BuddyAuth)
    const names = commands.definitions.map((d) => d.name)
    expect(names).not.toContain('buddy-login')
    expect(names).not.toContain('buddy-status')
    expect(names).not.toContain('buddy-refresh')
  })

  it('registers the buddy LLM route', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    expect(llm.providers).toContain('buddy-cn')
    expect(llm.adapters).toContain('buddy-cn')
  })

  it('stops the buddy refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.buddyCnAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

describe('WorkBuddy provider 注册', () => {
  it('apply 时注册 buddy 与 workbuddy 两个 provider 路由', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const registered = ctx.llm.registeredProviders
    expect(registered).toContain('buddy-cn')
    expect(registered).toContain('buddy')
  })

  it('WorkBuddy 使用独立的凭据 ref', () => {
    expect(BUDDY.defaultCredentialRef).toBe('BUDDY_ACCESS_TOKEN')
  })

  it('注册 workbuddy 的可配置 provider 目录项', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const directory = ctx.llm.configurableProviders
    const entry = directory.find((item: { provider: string }) => item.provider === 'buddy')
    expect(entry).toMatchObject({ provider: 'buddy', displayName: BUDDY.displayName })
  })

  // 关键前置：registerBuddyLlm 为 WorkBuddy 产生 settingsNs = llm-buddy。
  // 该 namespace 未注册时，模型设置页会在 refFor → deriveKeyRef(provider)
  // 处以 `provider.toUpperCase is not a function` 崩溃。
  it('workbuddy 的 settingsNs 为 llm-buddy，且对应 settings namespace 已注册', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'buddy')
    expect(entry?.settingsNs).toBe('llm-buddy')
    expect(ctx.settings.registeredNamespaces).toContain('llm-buddy')
  })

  it('不注册任何 buddy/workbuddy 斜杠命令（入口在 Account Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['buddy-login', 'buddy-status', 'buddy-refresh', 'workbuddy-login', 'workbuddy-status']) {
      expect(names, removed).not.toContain(removed)
    }
    // codearts 的三个命令保留（CodeArts 没有 Account Hub 登录入口的替代品）。
    expect(names).toContain('codearts-login')
    expect(names).toContain('codearts-status')
    expect(names).toContain('codearts-refresh')
    // 命令名必须唯一，重复注册会让后注册的覆盖先注册的。
    expect(new Set(names).size).toBe(names.length)
  })

  // cordis 的 Service 构造时按名称注册，同名第二次注册会抛
  // `service "buddyCnAuth" has been registered`。两个产品必须各占一个服务名，
  // 否则 apply() 直接抛错、插件完全无法加载。
  it('同时暴露 buddyCnAuth 与 buddyAuth 两个独立实例，各读自己的凭据 ref', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.buddyCnAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyCnAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.buddyCnAuth.product.id).toBe('buddy-cn')
    expect(ctx.buddyAuth.product.id).toBe('buddy')
    expect(ctx.buddyCnAuth.credentialRefName).toBe('BUDDY_CN_ACCESS_TOKEN')
    expect(ctx.buddyAuth.credentialRefName).toBe('BUDDY_ACCESS_TOKEN')
  })

  it('buddyAuth 只读 WorkBuddy 自己的凭据 ref', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：WorkBuddy 必须报告未配置。
    await ctx.credentials.set('BUDDY_CN_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.buddyAuth.status()).configured).toBe(false)

    // 写入 WorkBuddy 自己的 ref 后变为已配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.buddyAuth.status()).configured).toBe(true)
  })

  it('buddyCnAuth 与 buddyAuth 的凭据互相隔离', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写 CodeBuddy 的 ref：CodeBuddy 已配置、WorkBuddy 未配置。
    await ctx.credentials.set('BUDDY_CN_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.buddyCnAuth.status()).configured).toBe(true)
    expect((await ctx.buddyAuth.status()).configured).toBe(false)
  })

  it('dispose 时同时停止 Buddy 与 WorkBuddy 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const buddyStop = vi.spyOn(ctx.buddyCnAuth, 'stop')
    const workbuddyStop = vi.spyOn(ctx.buddyAuth, 'stop')
    await ctx.fiber.dispose()
    expect(buddyStop).toHaveBeenCalled()
    expect(workbuddyStop).toHaveBeenCalled()
  })

  /**
   * `connection` **不得**出现在插件级静态 `inject` 里。
   *
   * 该服务只由 Web bundle（dsh-client-connection）提供，headless / CLI profile
   * 中并不存在。静态 `inject` 会让本插件在那些 profile 里永久 pending，整个
   * profile 因此以
   * `plugin tree failed to load: 1 entry did not activate` 启动失败
   * —— chicheng-cron 的 skill/agent 任务正是跑在 `dsh --profile headless` 下，
   * 会全部 exit 1。
   *
   * 正确做法是 `registerAccountHubRpc` 内部用惰性注入（`ctx.inject(['connection'], …)`）
   * 挂载端点：Web 下正常注册，其余 profile 只是不注册 Account Hub 端点。
   *
   * 这条断言锁住的是「**能不能加载**」而非某个功能细节，所以即便日后有人为了
   * 让 UI 更"直接"而把 connection 加回静态 inject，也必须先看到这里失败。
   */
  it('静态 inject 不得包含 connection（否则 headless profile 启动失败）', () => {
    const { inject } = pluginEntry as { inject?: readonly string[] }
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).not.toContain('connection')
    // 必需服务仍须声明，避免修 connection 时顺手把别的服务误删。
    for (const required of ['credentials', 'commands', 'llm']) {
      expect(inject, required).toContain(required)
    }
  })
})

describe('LobsterAI provider 注册', () => {
  it('apply 时注册 lobsterai provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('lobsterai')
    expect(ctx.llm.adapters).toContain('lobsterai')
  })

  it('注册 lobsterai 的可配置 provider 目录项（含展示名）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'lobsterai')
    expect(entry).toMatchObject({ provider: 'lobsterai', displayName: LOBSTERAI.displayName })
  })

  // 与 workbuddy 同理：settingsNs 未注册时，模型设置页会在
  // refFor → deriveKeyRef(provider) 处以 `provider.toUpperCase is not a function` 崩溃。
  it('lobsterai 的 settingsNs 为 llm-lobsterai，且对应 settings namespace 已注册', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'lobsterai')
    expect(entry?.settingsNs).toBe('llm-lobsterai')
    expect(ctx.settings.registeredNamespaces).toContain('llm-lobsterai')
  })

  it('不注册任何 lobsterai 斜杠命令（入口在 Account Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['lobsterai-login', 'lobsterai-status', 'lobsterai-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('暴露 lobsteraiAuth 服务实例，服务名不与既有 provider 冲突', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.lobsteraiAuth).toBeInstanceOf(LobsteraiAuth)
    expect(ctx.lobsteraiAuth.name).toBe('lobsteraiAuth')
    expect(ctx.lobsteraiAuth.product.id).toBe('lobsterai')
    expect(ctx.lobsteraiAuth.credentialRefName).toBe('LOBSTERAI_ACCESS_TOKEN')
    // 四个 provider 的服务实例必须两两不同（同名二次注册会抛错）。
    expect(ctx.lobsteraiAuth).not.toBe(ctx.buddyCnAuth)
    expect(ctx.lobsteraiAuth).not.toBe(ctx.buddyAuth)
  })

  it('lobsteraiAuth 只读自己的凭据 ref（不串用腾讯系凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：LobsterAI 必须报告未配置。
    await ctx.credentials.set('BUDDY_CN_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(false)

    await ctx.credentials.set('LOBSTERAI_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(true)
  })

  it('dispose 时停止 LobsterAI 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.lobsteraiAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

describe('Trae CN provider 注册（认证服务 + 模型路由）', () => {
  it('暴露 traeCnAuth；服务名不是机械派生的 trae-cnAuth', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.traeCnAuth).toBeInstanceOf(TraeCnAuth)
    // provider id 带连字符（对齐用户叫法），但服务名必须是合法的标识符风格 ——
    // 这两个形态的**解耦**正是本用例锁住的东西。
    expect(ctx.traeCnAuth.name).toBe('traeCnAuth')
    expect((ctx as unknown as Record<string, unknown>)['trae-cnAuth']).toBeUndefined()
    expect(ctx.traeCnAuth.product.id).toBe('trae-cn')
    expect(ctx.traeCnAuth.credentialRefName).toBe('TRAE_CN_ACCESS_TOKEN')
  })

  it('与既有四个 provider 的服务实例两两不同（同名二次注册会抛错）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.traeCnAuth).not.toBe(ctx.buddyCnAuth)
    expect(ctx.traeCnAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.traeCnAuth).not.toBe(ctx.lobsteraiAuth)
    expect(ctx.traeCnAuth).not.toBe(ctx.codeartsAuth)
  })

  it('traeCnAuth 只读自己的凭据 ref（不串用其他 provider 凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 LobsterAI 的 ref：Trae CN 必须报告未配置。
    await ctx.credentials.set('LOBSTERAI_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeCnAuth.status()).configured).toBe(false)

    await ctx.credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeCnAuth.status()).configured).toBe(true)
  })

  it('**注册** LLM 路由与 `llm-trae-cn` settings namespace', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('trae-cn')
    // namespace 必须与 registerTraeCnLlm 声明的 settingsNs 一致：漏注册会让模型
    // 设置页在 `refFor → deriveKeyRef(provider)` 处以
    // `provider.toUpperCase is not a function` 崩溃。
    // 注意连字符在这里是**正确**的（namespace 是字符串键，不是标识符）。
    expect(ctx.settings.registeredNamespaces).toContain('llm-trae-cn')
    expect(ctx.traeCnAuth).toBeInstanceOf(TraeCnAuth)
  })

  it('不注册任何 trae-cn 斜杠命令（入口在 Account Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['trae-cn-login', 'trae-cn-status', 'trae-cn-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('dispose 时停止 Trae CN 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.traeCnAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

/**
 * Qoder 是本插件**唯一的非浏览器登录形态**（PAT 粘贴），因此它的注册接线
 * 有几处与另外六个 provider 刻意不同 —— 这一组把那些差异钉死。
 */
describe('Qoder provider 注册（认证服务 + 模型路由）', () => {
  it('apply 时注册 qoder provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('qoder')
    expect(ctx.llm.adapters).toContain('qoder')
  })

  it('注册 qoder 的可配置 provider 目录项（含展示名）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'qoder')
    expect(entry).toMatchObject({ provider: 'qoder', displayName: QODER.displayName })
  })

  // 与其余 provider 同理：settingsNs 未注册时，模型设置页会在
  // refFor → deriveKeyRef(provider) 处以 `provider.toUpperCase is not a function`
  // 崩溃。`qoder` 无连字符，namespace 是 `llm-qoder`。
  it('qoder 的 settingsNs 为 llm-qoder，且对应 settings namespace 已注册', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'qoder')
    expect(entry?.settingsNs).toBe('llm-qoder')
    expect(ctx.settings.registeredNamespaces).toContain('llm-qoder')
  })

  it('暴露 qoderAuth 服务实例：服务名由产品 id **机械派生**（无连字符，无需 serviceName）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.qoderAuth).toBeInstanceOf(QoderAuth)
    // 与 `trae-cn` → `traeCnAuth` 的**显式声明**是两条不同的判据：那条是因为
    // 机械派生会得到非标识符风格的 `trae-cnAuth`，而 `qoder` 无连字符，
    // `${id}Auth` 本身就是合法标识符 —— 故 `QoderProduct` 刻意没有
    // `serviceName` 字段。这条断言是「不要为形态统一给它补一个字段」的闸。
    expect(ctx.qoderAuth.name).toBe('qoderAuth')
    expect(ctx.qoderAuth.product.id).toBe('qoder')
    expect(ctx.qoderAuth.credentialRefName).toBe('QODER_PERSONAL_TOKEN')
    expect((ctx.qoderAuth as unknown as { product: { serviceName?: unknown } }).product.serviceName)
      .toBeUndefined()
  })

  it('与既有六个 provider 的服务实例两两不同（同名二次注册会抛错）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.qoderAuth).not.toBe(ctx.codeartsAuth)
    expect(ctx.qoderAuth).not.toBe(ctx.buddyCnAuth)
    expect(ctx.qoderAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.qoderAuth).not.toBe(ctx.lobsteraiAuth)
    expect(ctx.qoderAuth).not.toBe(ctx.traeCnAuth)
  })

  it('qoderAuth 只读自己的凭据 ref（不串用其他 provider 凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 Trae CN 的 ref：Qoder 必须报告未配置。
    await ctx.credentials.set('TRAE_CN_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.qoderAuth.status()).configured).toBe(false)

    // Qoder 的凭据是 `{ access_token: <PAT> }`（PAT 存进 access_token）。
    await ctx.credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'pt-abc123', refresh_token: 'jrt-1',
    }))
    expect((await ctx.qoderAuth.status()).configured).toBe(true)
  })

  it('不注册任何 qoder 斜杠命令（入口在 Account Hub 的 PAT 表单）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['qoder-login', 'qoder-status', 'qoder-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('dispose 时停止 Qoder 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.qoderAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

/**
 * Qoder **CN**（第二 region）的注册接线。
 *
 * 本组与上一组的判据**互为反例**，这是全组存在的理由：两个 region 同协议、
 * 同一份实现，差异只在「服务名显式与否」与「池键是不是同一个字符串」——
 * 这两条恰恰是最容易被「顺手统一」抹平的地方，而抹平之后**两个方向都不报错**。
 */
describe('Qoder CN provider 注册（第二 region）', () => {
  it('apply 时注册 qoder-cn provider 路由与适配器（与国际版并列，不是替换）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // **两个**路由必须同时存在：CN 是新增的第二个 provider，不是把国际版改掉。
    expect(ctx.llm.registeredProviders).toContain('qoder')
    expect(ctx.llm.registeredProviders).toContain('qoder-cn')
    expect(ctx.llm.adapters).toContain('qoder-cn')
  })

  it('注册 qoder-cn 的可配置 provider 目录项（含展示名与 settingsNs）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'qoder-cn')
    expect(entry).toMatchObject({ provider: 'qoder-cn', displayName: QODER_CN.displayName })
    expect(entry?.displayName).toBe('Qoder CN')
    expect(entry?.settingsNs).toBe('llm-qoder-cn')
  })

  it('`llm-qoder-cn` settings namespace 已注册（漏注册会让模型设置页崩溃）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // namespace 未注册时，模型设置页会在 `refFor → deriveKeyRef(provider)` 处以
    // `provider.toUpperCase is not a function` 崩溃 —— 与其余 provider 同因。
    // 注意这里的连字符是**正确**的：namespace 是字符串键，不是标识符。
    expect(ctx.settings.registeredNamespaces).toContain('llm-qoder-cn')
    // 国际版的 namespace 不受影响（两个 region 各有自己的配置页）。
    expect(ctx.settings.registeredNamespaces).toContain('llm-qoder')
  })

  /**
   * ⚠️ **本组最重要的一条**：`qoderCnAuth` 是**显式声明**的结果，不是机械派生。
   *
   * `qoder-cn` 带连字符，`${id}Auth` 派生出来的是 `qoder-cnAuth` —— 非标识符
   * 风格，`ctx['qoder-cnAuth']` 才能访问。产品配置因此显式给出
   * `serviceName: 'qoderCnAuth'`。
   *
   * 这与上一组 `qoder`（无连字符，**刻意不声明** serviceName）**互为反例**：
   * 那条判据是「派生结果合不合法」，不是「所有 provider 都得声明」。
   * 若哪天有人为了「形态统一」给国际版也补一个 `serviceName`，或把 CN 的删掉
   * 改成机械派生，两条断言会一起变红。
   */
  it('服务名 `qoderCnAuth` 是**产品配置显式声明**的，而非机械派生', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.qoderCnAuth).toBeInstanceOf(QoderAuth)
    expect(ctx.qoderCnAuth.name).toBe('qoderCnAuth')
    // 判据链：产品配置里有这个字段，且它**不等于**机械派生的结果。
    expect(QODER_CN.serviceName).toBe('qoderCnAuth')
    expect(`${QODER_CN.id}Auth`).toBe('qoder-cnAuth')
    expect(QODER_CN.serviceName).not.toBe(`${QODER_CN.id}Auth`)
    // 机械派生的那个名字**不应**存在于 ctx 上（注册走的是 serviceName）。
    expect((ctx as unknown as Record<string, unknown>)['qoder-cnAuth']).toBeUndefined()
    // 反面判据（同一断言里锁死，防「顺手统一」）：国际版无该字段。
    expect(QODER.serviceName).toBeUndefined()
  })

  it('与既有七个 provider 的服务实例两两不同（同名二次注册会抛错）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 两个 Qoder region 也是**两个不同实例** —— 它们各自持有 jt 缓存与失效标记，
    // 共用实例会让 CN 的 jt 被拿去打国际版端点（失败形态是假的「PAT 失效」）。
    for (const other of [
      ctx.qoderAuth, ctx.codeartsAuth, ctx.buddyCnAuth, ctx.buddyAuth, ctx.lobsteraiAuth, ctx.traeCnAuth,
    ]) {
      expect(ctx.qoderCnAuth, ctx.qoderCnAuth.name).not.toBe(other)
    }
  })

  it('qoderCnAuth 只读 CN 自己的凭据 ref（**不与国际版串**）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写国际版的 ref：CN 必须报告未配置 —— 两个 region 的 PAT 互不通用，
    // 串用会让一台机器上的国际版凭据被当成 CN 凭据发出去（必然 401）。
    await ctx.credentials.set('QODER_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'pt-intl', refresh_token: 'jrt-1',
    }))
    expect((await ctx.qoderAuth.status()).configured).toBe(true)
    expect((await ctx.qoderCnAuth.status()).configured).toBe(false)

    // 反过来：只写 CN 的 ref ⇒ 只有 CN 报告已配置。
    await ctx.credentials.unset('QODER_PERSONAL_TOKEN')
    await ctx.credentials.set('QODER_CN_PERSONAL_TOKEN', JSON.stringify({
      access_token: 'pt-cn', refresh_token: 'jrt-2',
    }))
    expect((await ctx.qoderCnAuth.status()).configured).toBe(true)
    expect((await ctx.qoderAuth.status()).configured).toBe(false)
  })

  it('两个 region 的产品配置与凭据 ref 都不同（否则就是同一个 provider）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.qoderCnAuth.product).toBe(QODER_CN)
    expect(ctx.qoderCnAuth.product.id).toBe(QODER_CN.id)
    expect(ctx.qoderCnAuth.credentialRefName).toBe('QODER_CN_PERSONAL_TOKEN')
    expect(ctx.qoderCnAuth.credentialRefName).not.toBe(ctx.qoderAuth.credentialRefName)
    // 两个 region 打的是两套 host：产品配置配错会让请求静默打到错 region。
    expect(ctx.qoderCnAuth.product.openapiBase).toBe('https://openapi.qoder.com.cn')
    expect(ctx.qoderCnAuth.product.openapiBase).not.toBe(ctx.qoderAuth.product.openapiBase)
  })

  it('不注册任何 qoder-cn 斜杠命令（入口在 Account Hub 的 PAT 表单）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['qoder-cn-login', 'qoder-cn-status', 'qoder-cn-refresh', 'qoderCn-login']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('dispose 时**两个 region 的**续期调度都被停掉', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const intlStop = vi.spyOn(ctx.qoderAuth, 'stop')
    const cnStop = vi.spyOn(ctx.qoderCnAuth, 'stop')
    await ctx.fiber.dispose()
    // 漏掉 CN 这一处不会报错，只是 CN 的调度器在插件卸载后仍然存活。
    expect(intlStop).toHaveBeenCalled()
    expect(cnStop).toHaveBeenCalled()
  })
})
