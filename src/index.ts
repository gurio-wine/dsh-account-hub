import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerTraeCnLlm } from './trae-cn-adapter.js'
import { fetchTraeCnWorkModels, registerTraeCnWorkLlm } from './trae-cn-work-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { TraeCnAuth } from './trae-cn-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { AccountPool } from './account-pool.js'
import { migrateProviderNames } from './provider-rename-migration.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { BUDDY_CN, BUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { TRAE_CN } from './trae-cn-product.js'
import { TRAE_CN_WORK } from './trae-cn-work-product.js'
import { QODER } from './qoder-product.js'
import { checkQoderQuotaExhausted } from './qoder-credits.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import type { QoderCredential } from './qoder-product.js'

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Account Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * Provider 配置 namespace 的 schema。
 *
 * `registerConfigurableProviders` 声明的 `settingsNs` 必须真实存在于
 * settings 服务中，否则模型设置页读到 undefined 的 namespace，
 * 在 `refFor → deriveKeyRef(provider)` 处会以
 * `provider.toUpperCase is not a function` 崩溃。
 * 两者都只需承接一个可选的 `providers` 映射，故共用同一宽松 schema。
 *
 * 注意：`settings.register()` 要求 schemastery schema —— `describe()` 会对每个
 * 注册项无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)`。
 * 传入裸函数（`(value) => ...`）会让 `describe()` 抛
 * `TypeError: registration.schema.toJSON is not a function`，进而使所有
 * 依赖 settings 的界面（模型设置页、主题、sidebar 的 settings.get/shell.get）
 * 全部失败。因此这里必须用 `Schema.object({...})` 构造。
 */
const providerSettingsSchema = Schema.object({
  providers: Schema.dict(Schema.any()).default({}),
})

/** 注册 provider 配置 namespace（已存在时忽略重复注册错误）。 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = ctx.get('settings') as
    | {
      register: (ns: string, schema: unknown) => unknown
      describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string }>
    }
    | undefined
  if (!settings || typeof settings.register !== 'function') {
    ctx.logger.warn('[codearts-auth] settings 服务不可用，provider namespace 未注册')
    return
  }
  for (const ns of namespaces) {
    try {
      settings.register(ns, providerSettingsSchema)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，
 * 只是收到图片时报 UNSUPPORTED_CONTENT。两个 Buddy 系产品（Buddy CN /
 * Buddy）共用同一后端与协议，图片能力相同，故共用本实现。
 */
function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) return undefined
    try {
      const stored = await attachments.readImage(attachment as never)
      return { data: stored.data, mediaType: stored.ref.mediaType }
    } catch {
      return undefined
    }
  }
}

/**
 * 账号池选号器：按目标模型挑选一个可用账号。
 *
 * 抽成独立函数是**必需的**，不是为了复用：`resolveCredential` 与 LobsterAI 的
 * `refresh` 回调都要「按模型挑一个账号」，而两者的挑号结果**必须一致**。
 * 若各写一份，resolve 在 A 对模型 M 限流时会挑到 B，而 refresh 用空
 * modelId 会挑回排序第一的 A —— 于是「刷新的是解析凭据时所用的那个账号」
 * 这条不变量（见 `lobsterai-wiring.spec.ts` 的 S1）被破坏：适配器拿到 B 的
 * 凭据却刷新了 A，B 的过期 token 始终不更新，用户看到的是「刚登录好却
 * 一直认证失败」，而日志里续期全绿。
 *
 * 两步策略（第二步是刻意的退化，不要「顺手」删掉）：
 * 1. 先按目标模型过滤，跳过仍在该模型冷却期内的账号；
 * 2. 全被过滤掉时退回不过滤的查询。原因见 {@link makeCredentialResolver}。
 *
 * @param pool - 账号池；未提供时返回 null（调用方自行回退单凭据）。
 * @param provider - provider id（`this.product.id`，不要写死字面量）。
 */
export function makeAccountPicker(
  pool: AccountPool | undefined,
  provider: string,
): (model?: string) => Promise<Awaited<ReturnType<AccountPool['getAvailableAccount']>>> {
  return async (model?: string) => {
    if (!pool) return null
    const target = model ?? ''
    const filtered = await pool.getAvailableAccount(provider, target)
    if (filtered) return filtered
    if (target.length === 0) return null
    // 退化：所有账号都在冷却期 → 取一个让调用方去实测（见 makeCredentialResolver）。
    return pool.getAvailableAccount(provider, '')
  }
}

/**
 * 构造 provider 的凭据解析函数（四个 provider 共用同一段接线）。
 *
 * **`model` 参数就是本函数存在的理由**：`getAvailableAccount` 的限流过滤是
 * **逐模型**的，`modelId` 传空串时按设计不过滤（见 `AccountPool` 的说明）。
 * 历史接线把空串写死在这里 —— 于是每次请求开头总是拿到「排序第一」的账号，
 * 即使它已被记了 24h 积分耗尽标记；失败后才靠适配器的换号循环逐个试。
 * 前几个账号都耗尽时，每次请求都要白跑 N 次完整往返（发请求 → 400 → 解析
 * → 记标记 → 换号）。
 *
 * 适配器的 `stream()` 在调用点就已经知道目标模型（`options.model`），把它
 * 透传下来即可让「跳过已知不可用账号」发生在**发请求之前**。
 *
 * 两条退化路径都是刻意的，不要「顺手」改掉：
 *
 * 1. **全部账号都在冷却期时退回不过滤的查询**（见 {@link makeAccountPicker}）。
 *    此时按模型过滤的结果是 `null`，直接返回 undefined 会让适配器把
 *    「所有账号都在冷却」误报成 `MISSING_CREDENTIAL`（「请先登录」）——而真实
 *    原因是限流/积分耗尽，用户看到的提示会完全指错方向。退回取一个账号、
 *    由适配器发一次请求，再走完换号循环抛 `QUOTA_EXCEEDED`，既保留既有错误
 *    语义，也只多花一次探测。这一层退化是必要的：限流标记只是**快照**，
 *    服务端常在重置时刻之前提前放行（见 `account-probe.ts` 的说明），凭标记
 *    直接拒绝会让用户被一个早已失效的标记挡住最长 24 小时。
 * 2. **`model` 缺省（`fetchModels` 拉模型目录）时仍不做限流过滤**。目录对
 *    所有模型一致，按某个模型的限流状态裁剪反而会凭空缺号。
 *
 * @param ctx - 宿主上下文（只用到 `credentials.resolve`）。
 * @param pool - 账号池；未提供时只用单凭据回退 ref。
 * @param provider - provider id（`this.product.id`，不要写死字面量）。
 * @param fallbackRef - 池中无账号时回退的单凭据 ref。
 */
export function makeCredentialResolver<T>(
  ctx: Context,
  pool: AccountPool | undefined,
  provider: string,
  fallbackRef: string,
): (model?: string) => Promise<T | undefined> {
  const pick = makeAccountPicker(pool, provider)
  return async (model?: string) => {
    const available = await pick(model)
    if (available) return available.credential as unknown as T
    // 回退到单凭据 ref（池为空 / 未配置账号池时）。
    const resolved = await ctx.credentials.resolve(credentialRef(fallbackRef))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as T
    } catch {
      return undefined
    }
  }
}

/** 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。 */
export function apply(ctx: Context): void {
  // provider 的 settingsNs 必须已注册，否则模型设置页会因未注册 namespace 崩溃。
  // 五个 namespace 分别对应：codearts 路由、Buddy CN（buddy-cn）路由、
  // Buddy（buddy）路由、LobsterAI（lobsterai）路由、Trae CN（trae-cn）路由
  // —— 后四者由 registerXxxLlm 以 `llm-${product.id}` 派生，漏注册会让模型设置页在
  // `refFor → deriveKeyRef(provider)` 处以
  // `provider.toUpperCase is not a function` 崩溃。
  // 注意 `llm-trae-cn` / `llm-buddy-cn` 里的连字符是**正确**的：namespace 是
  // 字符串键而非标识符，与 cordis 服务名（`traeCnAuth` / `buddyCnAuth`）
  // 走的是两套命名规则。
  // 第六个 namespace 是 Trae CN **Work**（`trae-cn-work`）—— 与 `trae-cn`
  // 是**两个 provider**（协议不同源、模型池不重合、扣不同积分池），
  // 但**共用同一批账号与凭据**（Work 无独立登录）。
  // 第七个是 Qoder（`qoder`）—— 第六条协议线，登录形态是 PAT 粘贴。
  registerProviderSettings(
    ctx,
    'llm-buddy-cn', 'llm-buddy', 'llm-codearts', 'llm-lobsterai', 'llm-trae-cn', 'llm-trae-cn-work', 'llm-qoder',
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  // 一次性数据迁移：把历史 provider 名（buddy = 中国版 / workbuddy = 国际版）、
  // 旧凭据 ref（BUDDY_* / WORKBUDDY_*）与旧 disabledModels 键搬到新命名
  // （buddy-cn / buddy）。**必须早于下面所有池查询** —— 池的每次读取都按
  // provider 过滤，带着旧 id 的账号在新体系里等同于不存在。
  //
  // ⚠️ **下面的域名清理必须挂在本 Promise 之后，不能与它并行**：
  // `pruneAccountsWithForeignDomain(BUDDY)` 按 `entry.provider === 'buddy'` 选账号，
  // 而迁移**之前**的 `buddy` 正是中国版（域名 copilot.tencent.com）。若两者
  // 并行，清理会把这批中国版账号判成「域名失配」并连凭据一起删掉 —— 迁移还
  // 没来得及给它们改成 `buddy-cn`。迁移自身是 fire-and-forget（内部自吞异常
  // 并打日志，绝不阻断启动），故这里用 `.then()` 串联而不是 `await`。
  void migrateProviderNames(pool, ctx).then(() => {
    // Buddy（国际版）provider 早年是中国版（copilot.tencent.com）实现，
    // 后来改造为国际版（www.workbuddy.ai）。期间登录的账号其 token.domain
    // 仍指向中国版端点，用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理。
    // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
    // 两个产品各清一次：中国版（buddy-cn）历史上也踩过同类坑（凭据里写着国际版域名），
    // 只清一边会漏掉另一半。
    for (const product of [BUDDY_CN, BUDDY]) {
      void pool.pruneAccountsWithForeignDomain(product).then((removed) => {
        if (removed.length > 0) {
          ctx.logger.info(
            `[jet-hub] 已清理 ${removed.length} 个 ${product.displayName} 域名失配账号，请重新登录：${removed.join(', ')}`,
          )
        }
      }).catch((error: unknown) => {
        ctx.logger.warn(`[jet-hub] 清理 ${product.displayName} 域名失配账号失败：${String(error)}`)
      })
    }
  })

  ctx.commands.register({
    name: 'codearts-login',
    description: '通过浏览器 OAuth 登录华为云 CodeArts',
    handler: async (): Promise<CommandResult> => {
      try {
        const result = await service.login()
        return {
          kind: 'success',
          text: `CodeArts 登录完成。凭据已存储于 ${String(result.ref)}；过期时间 ${new Date(result.expires).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-status',
    description: '显示 CodeArts 登录状态及刷新能力',
    handler: async (): Promise<CommandResult> => {
      const status = await service.status()
      return {
        kind: 'success',
        text: [
          `已配置: ${status.configured}`,
          ...status.source === undefined ? [] : [`来源: ${status.source}`],
          ...status.expiresAt === undefined ? [] : [`过期时间: ${new Date(status.expiresAt).toISOString()}`],
          `可刷新: ${status.refreshable}`,
          ...status.refreshError === undefined ? [] : [`刷新错误: ${status.refreshError}`],
        ].join('\n'),
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-refresh',
    description: '静默刷新 CodeArts 凭据',
    handler: async (): Promise<CommandResult> => {
      try {
        await service.refresh()
        const status = await service.status()
        return {
          kind: 'success',
          text: `CodeArts 凭据已刷新；过期时间 ${status.expiresAt === undefined ? '未知' : new Date(status.expiresAt).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    // 优先使用账号池获取可用账号（按目标模型过滤），回退到单凭据解析。
    resolveCredential: makeCredentialResolver<CodeArtsCredential>(
      ctx, pool, 'codearts', CODEARTS_CREDENTIAL_REF,
    ),
    refresh: () => service.refresh(),
    fetchRemoteModels: () => service.refreshModels(),
    accountPool: pool,
  })

  // ===== Buddy CN (腾讯 CodeBuddy 中国版) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Account Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。
  const buddyCn = new BuddyAuth(ctx)
  registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    // 池中账号按 `product.id` 归属；provider 实参必须与产品一致，否则查不到账号。
    resolveCredential: makeCredentialResolver<BuddyCredential>(
      ctx, pool, BUDDY_CN.id, BUDDY_CREDENTIAL_REF,
    ),
    refresh: () => buddyCn.refresh(),
    fetchRemoteModels: () => buddyCn.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: BUDDY_CN,
  })

  // ===== Buddy (腾讯 WorkBuddy 国际版) 服务 =====
  // 与 Buddy CN 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由产品配置的 serviceName 显式给出，故两个产品分别注册为
  // ctx.buddyCnAuth / ctx.buddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Account Hub 的 Buddy 面板。
  const buddy = new BuddyAuth(ctx, { product: BUDDY })
  registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY.defaultCredentialRef),
    // 只从 buddy 的账号池取账号，回退到 Buddy 自己的单凭据 ref，
    // 保证不会串用 Buddy CN 的凭据。
    resolveCredential: makeCredentialResolver<BuddyCredential>(
      ctx, pool, BUDDY.id, BUDDY.defaultCredentialRef,
    ),
    refresh: () => buddy.refresh(),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: BUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Account Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  // 与 resolveCredential 共用同一个选号器：两者必须挑到**同一个**账号，
  // 否则「刷新的是解析凭据时所用的那个账号」这条不变量会被打破
  // （详因见 makeAccountPicker 的说明）。
  const pickLobsteraiAccount = makeAccountPicker(pool, LOBSTERAI.id)
  registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
    // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: makeCredentialResolver<LobsteraiCredential>(
      ctx, pool, LOBSTERAI.id, LOBSTERAI.defaultCredentialRef,
    ),
    refresh: async (model?: string) => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Account Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      //
      // **必须用同一个 model 选号**：resolveCredential 已按目标模型过滤，
      // 若这里退回空 modelId，就会挑回排序第一的（可能正是对 M 限流的那个）
      // 账号，从而重新引入上面那段错配。
      const available = await pickLobsteraiAccount(model)
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== Trae CN (字节跳动 Trae 国内版) 服务 =====
  // 第五条协议线，与其余四者均不同源：loopback 回调直接携带 refreshToken
  // （无 authCode 交换）+ `ExchangeToken` 续期 + `Cloud-IDE-JWT` 鉴权
  // （见 src/trae-cn-oauth.ts）。
  //
  // 服务名**不是** `${product.id}Auth`：产品 id 为 `trae-cn`，机械派生会得到
  // 带连字符的 `trae-cnAuth`。服务名由产品配置的 serviceName 显式给出
  // `traeCnAuth`，与另外四个 provider 的命名风格保持一致。
  const traeCn = new TraeCnAuth(ctx)
  // 与 resolveCredential 共用同一个选号器：两者必须挑到**同一个**账号，
  // 否则「刷新的是解析凭据时所用的那个账号」这条不变量会被打破
  // （详因见 makeAccountPicker 的说明，回归测试在 lobsterai-wiring.spec.ts）。
  const pickTraeCnAccount = makeAccountPicker(pool, TRAE_CN.id)
  registerTraeCnLlm(ctx, {
    credentialRef: credentialRef(TRAE_CN.defaultCredentialRef),
    // 只从 Trae CN 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它四条线的凭据。
    // provider 实参用 TRAE_CN.id 而非字面量 'trae-cn'：写死字面量在改名/多产品
    // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: makeCredentialResolver<TraeCnCredential>(
      ctx, pool, TRAE_CN.id, TRAE_CN.defaultCredentialRef,
    ),
    refresh: async (model?: string) => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      // 为什么：resolveCredential（上面）优先从账号池取 `TRAE_CN_ACCOUNT_XXX`
      // 的凭据，而 `traeCn.refresh()` 读写的是 `TRAE_CN_ACCESS_TOKEN`。两者错配
      // 的后果是 —— 适配器检测到池凭据过期 → 调 refresh → 成功回写到**另一个**
      // ref → 再 resolve 仍取到那份未更新的过期凭据 → 带着过期 token 发请求 →
      // 401。用户看到「刚在 Account Hub 登录好，却一直认证失败」，而日志里续期
      // 全是成功的，极难排查。
      //
      // **必须用同一个 model 选号**：resolveCredential 已按目标模型过滤，若这里
      // 退回空 modelId，就会挑回排序第一的（可能正是对 M 限流的那个）账号，
      // 从而重新引入上面那段错配。
      const available = await pickTraeCnAccount(model)
      if (available) await traeCn.refreshAccountCredential(available.entry.credentialRef)
      else await traeCn.refresh()
    },
    accountPool: pool,
    product: TRAE_CN,
  })

  // ===== Trae CN Work (TraeWork 网页版) 服务 =====
  //
  // **复用上面那条 Trae CN 的全部账号基础设施**：同一个 `traeCn` auth 实例、
  // 同一个 `pickTraeCnAccount` 选号器、同一批 `TRAE_CN_ACCOUNT_*` 凭据。
  // Work **没有独立登录**（它的登录就是 Trae CN 的登录），故**不注册**独立
  // auth 服务、不新建选号器 —— 新建只会得到第二个指向同一份凭据的解析器，
  // 且两处选号可能挑到不同账号。
  //
  // ⚠️ **账号池查询一律传 `TRAE_CN_WORK.poolProviderId`（= `'trae-cn'`），
  // 不是 `TRAE_CN_WORK.id`（= `'trae-cn-work'`）**：
  // 账号条目的 `provider` 字段是 `trae-cn`，按 `trae-cn-work` 过滤一个都
  // 匹配不到 → 适配器每次拿 `MISSING_CREDENTIAL`（「请先登录」）而账号明明在
  // 列表里。这个接线是本插件唯一一处「provider id 与池键不同名」的地方，
  // 已在 AGENTS.md 单独登记。
  //
  // 反方向的错误同样静默：路由名若用池键，`trae-cn-work` 根本不会出现在
  // 模型选择器里。
  registerTraeCnWorkLlm(ctx, {
    credentialRef: credentialRef(TRAE_CN.defaultCredentialRef),
    // 与 IDE 路径**同一份凭据、同一个池键**（`trae-cn`）—— 两条路径是同一批
    // 账号的两种用法，不是两批账号。
    resolveCredential: makeCredentialResolver<TraeCnCredential>(
      ctx, pool, TRAE_CN_WORK.poolProviderId, TRAE_CN.defaultCredentialRef,
    ),
    refresh: async (model?: string) => {
      // 与 resolveCredential 用**同一个**选号器与同一个 model：否则会出现
      // 「解析到 B、却刷新了 A」，B 的过期 token 永不更新（历史 S1 缺陷）。
      const available = await pickTraeCnAccount(model)
      if (available) await traeCn.refreshAccountCredential(available.entry.credentialRef)
      else await traeCn.refresh()
    },
    // Work 的模型目录**真的可拉**（与 IDE 路径相反，见 parseTraeCnWorkModels）。
    // 用解析到的凭据拉：目录端点要鉴权，且不消耗积分。
    fetchRemoteModels: async () => {
      const credential = await makeCredentialResolver<TraeCnCredential>(
        ctx, pool, TRAE_CN_WORK.poolProviderId, TRAE_CN.defaultCredentialRef,
      )()
      if (credential === undefined || credential.access_token.length === 0) return []
      return fetchTraeCnWorkModels(credential)
    },
    accountPool: pool,
    product: TRAE_CN_WORK,
  })

  // ===== Qoder (PAT 粘贴式登录) 服务 =====
  //
  // 第六条协议线，与前五条**完全不同源**：没有浏览器 OAuth、没有本地回调
  // 服务器、没有两段式登录。登录入口是「用户粘贴一个 PAT」，验证是一次**即时**
  // exchange 请求（见 `src/qoder-auth.ts` 的模块头）。
  //
  // 服务名由产品 id **机械派生**为 `qoderAuth`：id `qoder` 无连字符，
  // `${product.id}Auth` 即合法的标识符风格，故 `QoderProduct` **刻意不声明**
  // `serviceName`。这与 `trae-cn` → `traeCnAuth` 的显式声明是**两条不同的
  // 判据**（那条是因为机械派生会得到 `trae-cnAuth`），不要为「形态统一」给
  // 无连字符的产品也加一个字段。
  const qoder = new QoderAuth(ctx)
  // 与 resolveCredential 共用同一个选号器：两者必须挑到**同一个**账号，
  // 否则「刷新的是解析凭据时所用的那个账号」这条不变量会被打破
  // （详因见 makeAccountPicker 的说明，回归测试在 lobsterai-wiring.spec.ts）。
  const pickQoderAccount = makeAccountPicker(pool, QODER.id)
  // 适配器与 quotaVerdict **共用同一个凭据解析器**：两处各写一份必然分叉
  // （理由同上）。
  const resolveQoderCredential = makeCredentialResolver<QoderCredential>(
    ctx, pool, QODER.id, QODER.defaultCredentialRef,
  )
  registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它六条线的凭据。
    // provider 实参用 QODER.id 而非字面量 'qoder'：写死字面量在改名/多产品
    // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: resolveQoderCredential,
    // 续期对 Qoder 就是**重打 exchange**（PAT 不变，随时可重打），不是
    // 「refresh_token 换新」——见 `src/qoder-auth.ts` 的 refresh 说明。
    refresh: async (model?: string) => {
      // 与 resolveCredential 用**同一个**选号器与同一个 model：否则会出现
      // 「解析到 B、却刷新了 A」，B 的过期 jt 永不更新（历史 S1 缺陷）。
      const available = await pickQoderAccount(model)
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef)
      else await qoder.refresh()
    },
    // job token 提供者：chat 与额度端点**只认 `jt-`**（PAT 直打 chat 恒 401、
    // 打额度端点回 401 `TOKEN_EXPIRE`），故必须注入。
    // ⚠️ 省略时适配器会抛 `MISSING_CREDENTIAL` —— 那会把「没接线」这个明确的
    // 配置错误伪装成「凭据失效」，让排查方向整个跑偏（见
    // `QoderAdapterOptions.getJobToken` 的说明）。
    getJobToken: (pat: string) => qoder.getJobToken(pat),
    invalidateJobToken: (pat: string) => { qoder.invalidateJobToken(pat) },
    // **402 的额度二次判别**：402 在本 provider 上有语义污染（quota=0 的账号上
    // 无效模型名也回同一个 402 `code:116`），故「换号可救」必须由额度端点确证，
    // 这是 402 通向「换号」的**唯一**一道门。
    //
    // 回调签名只带分类结果、不带凭据（该接口由步骤 2 定型），故这里在**被调用的
    // 此刻**按同一条凭据解析路径取凭据 —— 与适配器 `stream()` 开头那次解析同源
    // （都不传 model：此刻失败账号尚未写冷却标记，逐模型过滤反而会挑到另一个
    // 账号，查到的额度就不是刚失败那个账号的）。
    //
    // 凭据取不到、或额度端点查不到时一律返回 `undefined` ⇒ 分类器保守判
    // 「不换号」（`applyQoderQuotaVerdict` 的既定语义）。宁可直报，也不因为
    // 一个模型名错误把 N 个账号的额度一起烧掉。
    quotaVerdict: async () => {
      const credential = await resolveQoderCredential()
      if (credential === undefined || credential.access_token.length === 0) return undefined
      return checkQoderQuotaExhausted(credential, qoder, {
        onDebug: (message) => ctx.logger?.info?.(message),
      })
    },
    accountPool: pool,
    product: QODER,
  })

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  async function refreshAllCredentials(): Promise<void> {
    try {
      await service.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await buddyCn.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await buddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await lobsterai.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await traeCn.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await qoder.refreshAll(pool)
    } catch { /* 静默 */ }
  }

  // 启动时如果有任何可续期账号，安排定期续期
  pool.listAllAccounts().then(accounts => {
    const hasRefreshable = accounts.some(a => a.refreshable && a.enabled)
    if (hasRefreshable) {
      const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
      ctx.effect(() => () => {
        clearInterval(refreshTimer)
        service.stop()
        buddyCn.stop()
        buddy.stop()
        lobsterai.stop()
        traeCn.stop()
        qoder.stop()
      }, 'jet-hub: multi-account refresh scheduler')
    }
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddyCn.stop()
    buddy.stop()
    lobsterai.stop()
    traeCn.stop()
    qoder.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== Account Hub RPC 注册 =====
  registerJetHubRpc(ctx, pool, service, buddyCn, buddy, lobsterai, traeCn, qoder)
  ctx.provide('accountPool', pool)
}
