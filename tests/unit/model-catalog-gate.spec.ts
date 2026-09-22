/**
 * 目录门控：**没有已登录账号就不显示该 provider 的模型**（`providerCatalogVisible`），
 * 以及与之配套的设置页全量目录（`listAllModels`）。
 *
 * ## 需求
 *
 * 「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对大多数用户
 * 来说模型选择选项卡臃肿的问题能改善很多。」
 *
 * ## 机制与两条必须遵守的约束
 *
 * DSH 的 `buildModelCatalog` 显式做了 `.filter(group => group.models.length > 0)`，
 * 所以适配器 `listModels` 返回 `[]` 就能让整个 provider 分组从模型选择器消失。
 * ① **必须返回空数组，绝不抛错**（抛错会被归入 catalog 的 `failures`，界面上反而
 * 多出一条 provider 报错）；② **不影响路由**（`routableProviders` 由
 * `listProviders()` 单独生成，被隐藏的模型仍可 `resolveModel`）。
 *
 * 本文件锁死三块语义：
 * 1. **判据是「凭据可解析」** —— `logout()` 只清凭据、保留账号条目；停用
 *    （`enabled:false`）不算未登录；
 * 2. **保守放行三种情形**（无账号池 / 替身未实现该方法 / 读凭据抛异常）；
 * 3. **门控只作用于对话框目录**：设置页走 `listAllModels()`，无账号时**反而更
 *    需要它**（此时 `listModels` 一个模型都不给）。
 *
 * ⚠️ 本仓特有的第四块：**CodeArts 的单凭据路径**（上游已移除、本仓仍活跃 ——
 * `/codearts-login` 把凭据写进固定的 `CODEARTS_ACCESS_TOKEN`）。判据必须覆盖
 * 「账号池」与「单凭据 ref」两条路径，否则纯单凭据用户的 codearts 模型会全部
 * 消失。其余六个 provider **刻意不传** extra ref（它们的 `Auth.login()` 在本仓
 * 没有调用者），本文件用一条对偶用例把这条边界也钉住。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool, providerCatalogVisible } from '../../src/account-pool.js'
import { accountCredentialRefName, registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import { CodeArtsAdapter, PROVIDER as CODEARTS_PROVIDER } from '../../src/llm-adapter.js'
import { CODEARTS_CREDENTIAL_REF } from '../../src/service.js'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import type { BuddyProduct } from '../../src/product.js'
import { BUDDY, BUDDY_CN } from '../../src/product.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TraeCnAdapter } from '../../src/trae-cn-adapter.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import type { QoderProduct } from '../../src/qoder-product.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 门控只看 `listModels` / `listAllModels` 两个方法（结构化类型）。 */
interface CatalogAdapter {
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  listAllModels(): readonly { id: string; name: string }[]
}

/**
 * 内存替身上下文：`settings`（账号索引）+ `credentials`（凭据本体）。
 *
 * 形状与 `credential-model-filter.spec.ts` 的 `createPoolContext` 同源 —— 门控读的
 * 就是这两处，必须用**真实 `AccountPool`** 才能覆盖「凭据可解析」这条判据本身，
 * 而不是在替身上断言替身。
 */
function createPoolContext() {
  const credentials = new Map<string, string>()
  let stored: { accounts?: ProviderAccountEntry[] } = { accounts: [] }
  const settings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => stored,
      replace: async (value: { accounts?: ProviderAccountEntry[] }) => { stored = value },
    }),
    describe: () => [{ ns: 'dsh_account_hub', value: stored }],
  }
  const refKey = (ref: unknown): string => (typeof ref === 'string' ? ref : String(ref))
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => (key === 'settings' ? settings : undefined),
    credentials: {
      describe: async (ref: unknown) => {
        const key = refKey(ref)
        return { configured: credentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: unknown) => {
        const value = credentials.get(refKey(ref))
        return value === undefined ? undefined : { value, source: 'test' as const }
      },
      set: async (ref: unknown, value: string) => { credentials.set(refKey(ref), value) },
      unset: async (ref: unknown) => { credentials.delete(refKey(ref)) },
    },
  }
  return { ctx, credentials }
}

/** 构造账号条目（`credentialRef` 按生产规矩由 provider + id 归一化）。 */
function makeAccount(id: string, provider: string, enabled = true): ProviderAccountEntry {
  return {
    id,
    provider,
    nickname: id,
    enabled,
    credentialRef: accountCredentialRefName(provider, id),
    createdAt: 1,
    expiresAt: Date.now() + 3_600_000,
    refreshable: true,
  }
}

/**
 * 建一个真实 `AccountPool`。
 *
 * `loggedIn: false` 表示「有条目但凭据不可解析」—— 这正是 `logout()` 之后的状态
 * （它只清凭据、保留条目），是门控最容易写错的那条语义。
 */
async function makePool(spec: {
  provider: string
  id?: string
  loggedIn: boolean
  enabled?: boolean
  /** 不写任何账号条目（用于纯单凭据 / 空池场景）。 */
  withoutEntry?: boolean
}) {
  const { ctx, credentials } = createPoolContext()
  const pool = new AccountPool(ctx as never)
  const entry = makeAccount(spec.id ?? 'a1', spec.provider, spec.enabled ?? true)
  if (spec.withoutEntry !== true) await pool.addAccount(entry)
  if (spec.loggedIn) {
    // 门控只问「JSON 能否解析成对象」，不看字段是否够用（够不够用是解析器的事）。
    credentials.set(entry.credentialRef, JSON.stringify({ access_token: 'AT', access_key_id: 'AK' }))
  }
  return { pool, credentials, entry }
}

/** 记录调用次数的 fetch 替身：用于钉死「门控命中时一次网络都不发」。 */
function makeFetchSpy() {
  const calls: string[] = []
  const fetcher = vi.fn(async (url: unknown) => {
    calls.push(String(url))
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/**
 * 七个 provider 的适配器工厂。
 *
 * ⚠️ 每个适配器的 `resolveCredential` 一律返回 `undefined`：门控**不问适配器自己
 * 的解析器**，它只问账号池（这正是「适配器能取到凭据」与「用户已登录」被混为一谈
 * 时的防线 —— 若门控被改成调 `resolveCredential`，本文件全部用例都会因为适配器
 * 侧返回 undefined 而变红）。
 */
const ADAPTERS: ReadonlyArray<{
  label: string
  provider: string
  make: (pool: AccountPool | undefined, fetchImpl: typeof fetch) => CatalogAdapter
}> = [
  {
    label: 'codearts',
    provider: CODEARTS_PROVIDER,
    make: (pool, fetchImpl) => new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl,
      // 空数组 = 目录不可用 → 回退静态表（零网络的确定性路径）。
      fetchRemoteModels: async () => [],
      ...pool === undefined ? {} : { accountPool: pool },
    }),
  },
  {
    label: 'buddy-cn',
    provider: BUDDY_CN.id,
    make: (pool, fetchImpl) => buddyAdapter(BUDDY_CN, pool, fetchImpl),
  },
  {
    label: 'buddy',
    provider: BUDDY.id,
    make: (pool, fetchImpl) => buddyAdapter(BUDDY, pool, fetchImpl),
  },
  {
    label: 'lobsterai',
    provider: LOBSTERAI.id,
    make: (pool, fetchImpl) => new LobsteraiAdapter({
      credentialRef: credentialRef('LOBSTERAI_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl,
      fetchRemoteModels: async () => [],
      resolveClientVersion: async () => '0.0.0',
      product: LOBSTERAI,
      ...pool === undefined ? {} : { accountPool: pool },
    }),
  },
  {
    label: 'trae-cn',
    provider: TRAE_CN.id,
    make: (pool, fetchImpl) => new TraeCnAdapter({
      credentialRef: credentialRef(TRAE_CN.defaultCredentialRef),
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchImpl,
      fetchRemoteModels: async () => [],
      product: TRAE_CN,
      ...pool === undefined ? {} : { accountPool: pool },
    }),
  },
  {
    label: 'qoder',
    provider: QODER.id,
    make: (pool, fetchImpl) => qoderAdapter(QODER, pool, fetchImpl),
  },
  {
    label: 'qoder-cn',
    provider: QODER_CN.id,
    make: (pool, fetchImpl) => qoderAdapter(QODER_CN, pool, fetchImpl),
  },
]

function buddyAdapter(product: BuddyProduct, pool: AccountPool | undefined, fetchImpl: typeof fetch) {
  return new BuddyAdapter({
    credentialRef: credentialRef(product.defaultCredentialRef),
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchImpl,
    fetchRemoteModels: async () => [],
    product,
    ...pool === undefined ? {} : { accountPool: pool },
  })
}

function qoderAdapter(product: QoderProduct, pool: AccountPool | undefined, fetchImpl: typeof fetch) {
  return new QoderAdapter({
    credentialRef: credentialRef(product.defaultCredentialRef),
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchImpl,
    fetchRemoteModels: async () => [],
    product,
    ...pool === undefined ? {} : { accountPool: pool },
  })
}

// ── 1. 门控本体 ──

describe('providerCatalogVisible：保守放行与能力检测', () => {
  const realPool = () => new AccountPool(createPoolContext().ctx as never)

  it('门控生效且账号池判定为「未登录」时返回 false', async () => {
    const pool = { hasLoggedInAccount: async () => false }
    expect(await providerCatalogVisible(pool as never, 'buddy-cn')).toBe(false)
  })

  it('accountPool 缺失（headless / CLI / 单测）→ 放行', async () => {
    expect(await providerCatalogVisible(undefined, 'buddy-cn')).toBe(true)
  })

  it('替身未实现 hasLoggedInAccount（能力检测）→ 放行', async () => {
    // 大量既有单测的账号池替身只 mock 了 disabledModelsFor 等少量方法。
    const stub = { disabledModelsFor: () => new Set<string>() }
    expect(await providerCatalogVisible(stub as never, 'buddy-cn')).toBe(true)
  })

  it('强转的假池（签名谎言）→ 放行，绝不抛错', async () => {
    expect(await providerCatalogVisible('lying' as never, 'buddy-cn')).toBe(true)
  })

  it('读凭据抛异常（存储损坏等）→ 放行', async () => {
    const pool = {
      hasLoggedInAccount: async () => { throw new Error('storage corrupted') },
    }
    expect(await providerCatalogVisible(pool as never, 'codearts')).toBe(true)
  })

  it('extraCredentialRefs 原样透传给账号池（CodeArts 单凭据路径）', async () => {
    const seen: Array<readonly string[] | undefined> = []
    const pool = {
      hasLoggedInAccount: async (_provider: string, refs?: readonly string[]) => {
        seen.push(refs)
        return false
      },
    }
    await providerCatalogVisible(pool as never, CODEARTS_PROVIDER, [CODEARTS_CREDENTIAL_REF])

    expect(seen).toEqual([[CODEARTS_CREDENTIAL_REF]])
  })

  it('真实账号池：无账号条目 → 隐藏；凭据不可解析 → 仍隐藏', async () => {
    const empty = await makePool({ provider: BUDDY_CN.id, loggedIn: false, withoutEntry: true })
    expect(await providerCatalogVisible(empty.pool, BUDDY_CN.id)).toBe(false)

    // logout() 只 unset 凭据、保留账号条目 —— 这是门控最容易写成「有条目就算登录」的
    // 那条语义，一旦写错，用户登出后模型仍然显示，门控形同虚设。
    const loggedOut = await makePool({ provider: BUDDY_CN.id, loggedIn: false })
    expect(await providerCatalogVisible(loggedOut.pool, BUDDY_CN.id)).toBe(false)

    const loggedIn = await makePool({ provider: BUDDY_CN.id, loggedIn: true })
    expect(await providerCatalogVisible(loggedIn.pool, BUDDY_CN.id)).toBe(true)
    // 未触碰的真实池也应是这个结果（防止上面的池被复用导致假绿）。
    expect(await providerCatalogVisible(realPool(), BUDDY_CN.id)).toBe(false)
  })
})

describe('AccountPool.hasLoggedInAccount：判据是「凭据可解析」', () => {
  it('有可解析凭据 → true', async () => {
    const { pool } = await makePool({ provider: QODER.id, loggedIn: true })
    expect(await pool.hasLoggedInAccount(QODER.id)).toBe(true)
  })

  it('有条目但凭据已被清掉 → false（logout 语义）', async () => {
    const { pool, credentials, entry } = await makePool({ provider: QODER.id, loggedIn: true })
    credentials.delete(entry.credentialRef)
    expect(await pool.hasLoggedInAccount(QODER.id)).toBe(false)
  })

  it('**不看 enabled**：账号被停用但凭据可解析 → true', async () => {
    // 停用只影响「自动选号」，与「是否已登录」无关（与续期调度器「只看
    // refreshable」同一条既有约定）。若这里过滤 enabled，把所有账号停用的用户
    // 会发现整个 provider 的模型凭空消失。
    const { pool } = await makePool({ provider: QODER.id, loggedIn: true, enabled: false })
    expect(await pool.hasLoggedInAccount(QODER.id)).toBe(true)
  })

  it('只认本 provider 的账号（跨 provider 不串）', async () => {
    const { pool } = await makePool({ provider: QODER.id, loggedIn: true })
    expect(await pool.hasLoggedInAccount(QODER_CN.id)).toBe(false)
  })

  it('extraCredentialRefs：池里一个账号都没有，但单凭据可解析 → true', async () => {
    const { pool, credentials } = await makePool({
      provider: CODEARTS_PROVIDER, loggedIn: false, withoutEntry: true,
    })
    credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({ access_key_id: 'AK' }))

    expect(await pool.hasLoggedInAccount(CODEARTS_PROVIDER)).toBe(false)
    expect(await pool.hasLoggedInAccount(CODEARTS_PROVIDER, [CODEARTS_CREDENTIAL_REF])).toBe(true)
  })
})

// ── 2. 七个 provider 的 listModels 门控 ──

describe('目录门控：七个 provider 的 listModels', () => {
  for (const entry of ADAPTERS) {
    it(`${entry.label}：无已登录账号 → 返回 []（且绝不抛错）`, async () => {
      const { pool } = await makePool({ provider: entry.provider, loggedIn: false })
      const { fetcher, calls } = makeFetchSpy()

      await expect(entry.make(pool, fetcher).listModels(entry.provider)).resolves.toEqual([])
      // 门控在 `ensureRemoteModels()` / `ensureCatalog()` **之前**：无账号时连远端
      // 目录都不必拉，一次网络都不该发。
      expect(calls).toEqual([])
    })

    it(`${entry.label}：有可解析凭据 → 照常播报目录`, async () => {
      const { pool } = await makePool({ provider: entry.provider, loggedIn: true })
      const { fetcher } = makeFetchSpy()

      const models = await entry.make(pool, fetcher).listModels(entry.provider)
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((model) => model.id.length > 0)).toBe(true)
    })

    it(`${entry.label}：accountPool 缺失 → 保守放行（照常播报）`, async () => {
      const { fetcher } = makeFetchSpy()
      const models = await entry.make(undefined, fetcher).listModels(entry.provider)
      expect(models.length).toBeGreaterThan(0)
    })
  }

  it('buddy-cn 与 buddy 各按自己的 product.id 独立判定', async () => {
    // 两个产品共用同一个适配器类、各自一个实例，账号池按 provider 字段归属 ——
    // ⚠️ 门控读的是**适配器自己的 `product.id`**（不是 `listModels` 的入参 provider）：
    // 真实接线里一个实例只注册给一个 provider，两者必然一致；这里用同一份池喂两个
    // 实例，锁住「一区登录不让另一区的模型冒出来」（反之亦然）。
    const cn = ADAPTERS.find((entry) => entry.label === 'buddy-cn')!
    const intl = ADAPTERS.find((entry) => entry.label === 'buddy')!
    const { fetcher } = makeFetchSpy()
    const cnOnly = await makePool({ provider: BUDDY_CN.id, loggedIn: true })
    expect((await cn.make(cnOnly.pool, fetcher).listModels(BUDDY_CN.id)).length).toBeGreaterThan(0)
    expect(await intl.make(cnOnly.pool, fetcher).listModels(BUDDY.id)).toEqual([])

    const intlOnly = await makePool({ provider: BUDDY.id, loggedIn: true })
    expect((await intl.make(intlOnly.pool, fetcher).listModels(BUDDY.id)).length).toBeGreaterThan(0)
    expect(await cn.make(intlOnly.pool, fetcher).listModels(BUDDY_CN.id)).toEqual([])
  })

  it('qoder 与 qoder-cn 两个 region 各自独立判定', async () => {
    const intl = ADAPTERS.find((entry) => entry.label === 'qoder')!
    const cn = ADAPTERS.find((entry) => entry.label === 'qoder-cn')!
    const { fetcher } = makeFetchSpy()
    const cnOnly = await makePool({ provider: QODER_CN.id, loggedIn: true })
    expect((await cn.make(cnOnly.pool, fetcher).listModels(QODER_CN.id)).length).toBeGreaterThan(0)
    expect(await intl.make(cnOnly.pool, fetcher).listModels(QODER.id)).toEqual([])

    const intlOnly = await makePool({ provider: QODER.id, loggedIn: true })
    expect((await intl.make(intlOnly.pool, fetcher).listModels(QODER.id)).length).toBeGreaterThan(0)
    expect(await cn.make(intlOnly.pool, fetcher).listModels(QODER_CN.id)).toEqual([])
  })

  it('CodeArts 单凭据路径：池里没有账号，但固定 ref 可解析 → 不隐藏', async () => {
    // 本仓特有（上游已移除单凭据模式）：`/codearts-login` 把凭据写进固定的
    // `CODEARTS_ACCESS_TOKEN`，且适配器的 makeCredentialResolver 仍在池空时回退读它。
    // 门控若只看账号池，纯单凭据用户的 codearts 模型会全部消失。
    const { pool, credentials } = await makePool({
      provider: CODEARTS_PROVIDER, loggedIn: false, withoutEntry: true,
    })
    credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({ access_key_id: 'AK', secret_access_key: 'SK' }))
    const { fetcher } = makeFetchSpy()

    const models = await ADAPTERS[0].make(pool, fetcher).listModels(CODEARTS_PROVIDER)
    expect(models.length).toBeGreaterThan(0)
  })

  it('其余 provider **不认**单凭据 ref（刻意不传 extra refs 的对偶面）', async () => {
    // 它们的 `Auth.login()` 在本仓没有任何调用者（Account Hub 一律走两段式直接写
    // `*_ACCOUNT_XXX`），所以把默认 ref 计入判据就是死代码 —— 这里钉死「不认」。
    const buddyCn = ADAPTERS.find((entry) => entry.label === 'buddy-cn')!
    const { pool, credentials } = await makePool({
      provider: BUDDY_CN.id, loggedIn: false, withoutEntry: true,
    })
    credentials.set(BUDDY_CN.defaultCredentialRef, JSON.stringify({ access_token: 'AT' }))
    const { fetcher } = makeFetchSpy()

    expect(await buddyCn.make(pool, fetcher).listModels(BUDDY_CN.id)).toEqual([])
  })
})

// ── 3. 开关 DSH_HIDE_MODELS_WITHOUT_ACCOUNT ──

describe('开关 DSH_HIDE_MODELS_WITHOUT_ACCOUNT（**默认开启**）', () => {
  const original = process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT

  beforeEach(() => { delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT })
  afterEach(() => {
    if (original === undefined) delete process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT
    else process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = original
  })

  it('未设置 → 默认开启（无账号即隐藏）', async () => {
    const traeCn = ADAPTERS.find((entry) => entry.label === 'trae-cn')!
    const { pool } = await makePool({ provider: TRAE_CN.id, loggedIn: false })
    const { fetcher } = makeFetchSpy()

    expect(await traeCn.make(pool, fetcher).listModels(TRAE_CN.id)).toEqual([])
  })

  for (const value of ['0', 'false', 'no', 'off', 'FALSE', ' off ']) {
    it(`显式假值 "${value}" → 关闭门控（无账号也照常播报）`, async () => {
      process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = value
      const traeCn = ADAPTERS.find((entry) => entry.label === 'trae-cn')!
      const { pool } = await makePool({ provider: TRAE_CN.id, loggedIn: false })
      const { fetcher } = makeFetchSpy()

      const models = await traeCn.make(pool, fetcher).listModels(TRAE_CN.id)
      expect(models.length).toBeGreaterThan(0)
    })
  }

  for (const value of ['1', 'true', 'yes', 'on', '']) {
    it(`"${value}" 不是假值 → 门控仍然生效`, async () => {
      process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = value
      const traeCn = ADAPTERS.find((entry) => entry.label === 'trae-cn')!
      const { pool } = await makePool({ provider: TRAE_CN.id, loggedIn: false })
      const { fetcher } = makeFetchSpy()

      expect(await traeCn.make(pool, fetcher).listModels(TRAE_CN.id)).toEqual([])
    })
  }
})

// ── 4. listAllModels：设置页目录不受门控影响 ──

describe('listAllModels：不套黑名单、也不套门控', () => {
  for (const entry of ADAPTERS) {
    it(`${entry.label}：无已登录账号时 listAllModels 仍返回非空目录`, async () => {
      const { pool } = await makePool({ provider: entry.provider, loggedIn: false })
      const { fetcher } = makeFetchSpy()
      const adapter = entry.make(pool, fetcher)

      // ⚠️ 这一条与「listModels 返回 []」是同一个适配器上的两个方向：门控只作用于
      // 对话框目录。设置页必须始终能看到全部模型 —— 否则用户连「这个 provider 有
      // 哪些模型」都看不到，更无法打开它们。
      expect(adapter.listAllModels().length).toBeGreaterThan(0)
      expect(await adapter.listModels(entry.provider)).toEqual([])
    })
  }

  it('黑名单只影响 listModels，不影响 listAllModels（关闭的模型仍可被重新打开）', async () => {
    const { pool } = await makePool({ provider: BUDDY_CN.id, loggedIn: true })
    const { fetcher } = makeFetchSpy()
    const adapter = ADAPTERS.find((entry) => entry.label === 'buddy-cn')!.make(pool, fetcher) as BuddyAdapter
    const all = adapter.listAllModels()
    const victim = all[0].id

    await pool.setModelDisabled(BUDDY_CN.id, victim, true)

    const listed = await adapter.listModels(BUDDY_CN.id)
    expect(listed.some((model) => model.id === victim)).toBe(false)
    expect(adapter.listAllModels().some((model) => model.id === victim)).toBe(true)
  })
})

// ── 5. model.list 端点：设置页在门控生效时仍列出全部模型 ──

/**
 * Account Hub「显示列表」端点的最小 harness。
 *
 * `llmModels` 复刻 `ctx.llm.listModels` 的返回（门控生效时就是 `[]`）；
 * `allModels` 复刻适配器实例的 `listAllModels()`。第 11 个实参省略即「未接线」，
 * 此时端点必须退化到历史行为（`listModels` 结果 + 黑名单裸 id 回填）。
 */
function registerModelList(options: {
  llmModels: Array<{ id: string; name: string }>
  allModels?: Array<{ id: string; name: string }>
  disabledModels?: Record<string, Record<string, boolean>>
  withAdapterRegistry?: boolean
}) {
  type Handler = (request: Request) => Promise<Response>
  let stored: Record<string, unknown> = {
    accounts: [],
    ...options.disabledModels === undefined ? {} : { disabledModels: options.disabledModels },
  }
  let handler: Handler | undefined

  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      describe: async () => ({ configured: false, writable: true }),
      resolve: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
  } as never)

  const ctx = {
    get: (key: string) => {
      if (key === 'connection') {
        return { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      }
      if (key === 'llm') return { listModels: async () => options.llmModels }
      return undefined
    },
    // `connection` 由生产代码以惰性注入挂载（静态声明会让 headless profile 永久
    // pending）。替身必须复刻这一机制，否则 registerAccountHubRpc 直接抛错。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
  }

  const modelAdapters = options.withAdapterRegistry === true && options.allModels !== undefined
    ? { 'buddy-cn': { listAllModels: () => options.allModels! } }
    : undefined

  registerAccountHubRpc(
    ctx as never, pool, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    undefined,
    modelAdapters,
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'account-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: { models?: Array<{ id: string; name: string; disabled: boolean }> }; error?: { message: string } }
    }
    return body.result
  }

  return { call }
}

describe('model.list 端点：设置页目录走 listAllModels', () => {
  it('门控生效（listModels 返回 []）时，设置页仍列出全部模型', async () => {
    // 这是「门控 + 设置页」的交叉点，也是本次移植的核心收益：无已登录账号时对话框
    // 里整个 provider 分组消失（需求本身），但「显示列表」必须照常列出模型开关 ——
    // 否则用户连模型名单都看不到。
    const { call } = registerModelList({
      llmModels: [],
      allModels: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'hy3', name: 'Hy3' }],
      withAdapterRegistry: true,
    })

    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.ok).toBe(true)
    expect(result.value?.models?.map((model) => model.id)).toEqual(['glm-5.2', 'hy3'])
  })

  it('关闭的模型带**真实展示名**（不再退化成裸 id）', async () => {
    const { call } = registerModelList({
      // 复刻真实适配器：黑名单命中的模型不在 listModels 结果里。
      llmModels: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      allModels: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'hy3', name: 'Hy3 · x0.13' }],
      disabledModels: { 'buddy-cn': { hy3: true } },
      withAdapterRegistry: true,
    })

    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.value?.models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2', disabled: false },
      // ⚠️ 名字来自全量目录，而不是回填时的裸 id —— 历史缺陷的回归点。
      { id: 'hy3', name: 'Hy3 · x0.13', disabled: true },
    ])
  })

  it('未接线（省略适配器映射）时退化为历史行为：黑名单裸 id 回填', async () => {
    const { call } = registerModelList({
      llmModels: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      disabledModels: { 'buddy-cn': { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.value?.models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2', disabled: false },
      { id: 'hy3', name: 'hy3', disabled: true },
    ])
  })

  it('未接线 + 门控生效 → 列表为空（这正是接线要解决的问题）', async () => {
    const { call } = registerModelList({ llmModels: [] })

    const result = await call('model.list', { provider: 'buddy-cn' })

    expect(result.ok).toBe(true)
    expect(result.value?.models).toEqual([])
  })
})
