import { execFile as nodeExecFile } from 'node:child_process'
import { readFile as nodeReadFile, writeFile as nodeWriteFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { PROVIDER as CODEARTS_PROVIDER, registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerTraeCnLlm } from './trae-cn-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { TraeCnAuth } from './trae-cn-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { AccountPool } from './account-pool.js'
import { createAutoRouteRegistration, installAutoRouteEffortGuard } from './auto-route-adapter.js'
import { TurnKeyTracker } from './account-consumption.js'
import { createContextTierRegistry } from './context-tiers.js'
import { migrateProviderNames } from './provider-rename-migration.js'
import { auditProviderAssignments } from './provider-audit-migration.js'
import {
  registerAccountHubRpc,
  performCheckinSweep,
  refreshConsumptionBalances,
  type ModelCatalogSource,
  type ProviderBalancesDeps,
} from './account-hub-rpc.js'
import {
  ACCOUNT_HUB_UPDATE_TIMEOUT_MS,
  type AccountHubUpdateDeps,
  type AccountHubUpdateExec,
  type AccountHubUpdateProcessOutput,
} from './account-hub-update.js'
import { BUDDY_CN, BUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { TRAE_CN } from './trae-cn-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { checkQoderQuotaExhausted } from './qoder-credits.js'
import { QoderSigningProvider, qoderDirectorySigningSource } from './qoder-signing.js'
import { extractQoderWasm } from './qoder-wasm.js'
import { instantiateQoderWasm } from './qoder-wasm-glue.js'
import type { CodeArtsCredential, BuddyCredential, LlmSettingsAddress, ProviderId } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import type { QoderCredential } from './qoder-product.js'

/**
 * 第二个 Qoder region（CN）在 cordis 上的服务名声明。
 *
 * ## 为什么这条 `declare module` 落在这里，而不是 `src/qoder-auth.ts`
 *
 * `QoderAuth` 自己的 `declare module`（在 `src/qoder-auth.ts`）只声明**默认
 * 产品**（国际版）的服务名 `qoderAuth` —— 那是该类的固有属性。而
 * `qoderCnAuth` 是**宿主接线**引入的第二个实例：同一个 `QoderAuth` 类在这里被
 * 实例化两次，服务名由传入的 `QODER_CN.serviceName` 决定。把它声明在
 * `qoder-auth.ts` 里会让那个文件同时描述「类」与「本插件注册了几个实例」两件事，
 * 而后者是 `index.ts` 的职责（与 `buddyAuth` 的声明落在 `buddy-auth.ts` 不同：
 * 那里两个实例都是该类自身的产品配置所描述的形态，且 `BuddyProduct.serviceName`
 * 是**必填**字段，两个服务名都属类的固有属性）。
 *
 * ## 声明的是**显式 serviceName 的产物**，不是机械派生
 *
 * `qoder-cn` 带连字符，`${id}Auth` 机械派生得到 `qoder-cnAuth`（非标识符风格）。
 * 产品配置显式给出 `qoderCnAuth` —— 这正是 `QoderProduct.serviceName` 那条
 * 判据的**正面用例**（无连字符的 `qoder` 不声明该字段，是反面用例）。
 *
 * cordis 的 `Service` 按名称注册，同名第二次注册会抛
 * `service "..." has been registered`，故两个 region 各占一个服务名；
 * 且两个实例**必须分开**：jt 运行时缓存、在途 exchange 去重与失效标记都是
 * 实例字段，合用一个会让 CN 账号拿到国际版换来的 jt（失败形态是假的
 * 「PAT 已失效」）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Qoder **CN（国内版）** 的认证服务实例（第二 region）。 */
    qoderCnAuth: QoderAuth
  }
}

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Account Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/** 根据已编译入口的位置创建 profile 更新依赖。 */
function createAccountHubUpdateDeps(moduleUrl: string): AccountHubUpdateDeps {
  const profileRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..')
  return {
    profileRoot,
    readFile: (path) => nodeReadFile(path, 'utf8'),
    writeFile: async (path, content) => {
      await nodeWriteFile(path, content, 'utf8')
    },
    fetcher: (input, init) => globalThis.fetch(input, init),
    exec: runAccountHubUpdate,
  }
}

/** pnpm 安装使用异步 execFile，超时与输出都由宿主执行器统一处理。 */
const runAccountHubUpdate: AccountHubUpdateExec = (command, args, options) =>
  new Promise<AccountHubUpdateProcessOutput>((resolvePromise, rejectPromise) => {
    nodeExecFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: 'utf8',
        timeout: Math.min(options.timeoutMs, ACCOUNT_HUB_UPDATE_TIMEOUT_MS),
        // 更新耗时最多 120 秒，完整保留 stdout/stderr，供错误响应和成功日志使用。
        maxBuffer: Infinity,
        windowsHide: true,
        // Windows 的 pnpm 通常通过 pnpm.cmd 暴露；execFile 需经系统 shell 启动脚本。
        shell: process.platform === 'win32',
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        }
        if (error !== null) {
          Object.assign(error, output)
          rejectPromise(error)
          return
        }
        resolvePromise(output)
      },
    )
  })

/**
 * 把 schema 节点标记为 volatile（宿主 settings 的「进 describe() + 可热改」判据）。
 *
 * ## 为什么不用 `.volatile()`
 *
 * 宿主第一方（`llm-pi-ai` / `llm-deepseek`）写的是 `z.dict(profile).default({}).volatile()`，
 * 那是 schemastery **3.18.4** 才引入的模式方法。本插件的 devDependency 解析到
 * **3.18.2**，该版本没有这个方法（调用即 `TypeError: ... .volatile is not a function`），
 * 而 `package.json` 不在本次改动范围内。
 *
 * 宿主真正读的是 `schema.meta.volatile`（`packages/settings/settings/src/schema.ts`
 * 的 `volatileForm` / `isVolatilePath` / `plainSchema`），故直接写 meta 键在
 * 3.18.2 与 3.18.4 上语义完全一致。唯一的差别是 3.18.4 的 volatile 模式还会把
 * **解析结果**包成 Volatile 访问器（`.get()`）—— 本插件**不读** provider profile
 * （配置由设置页直接写 entry config，凭据一律走账号池），不需要那个访问器。
 *
 * 用 `Reflect` 而不是 `.extra('volatile', true)`：本地 3.18.2 的
 * `Schemastery.Meta` 接口里没有 `volatile` 键，`.extra()` 的泛型约束会把
 * 合法调用判成类型错误（写成 `as never` 才能过），而 meta 是运行期的普通对象，
 * 直接写键既无类型谎报、也与 `.extra()` 的实现逐字等价（它内部就是
 * `schema.meta = { ...schema.meta, [key]: value }`）。
 *
 * @param schema - 待标记的 schema 节点（原地标记并原样返回，便于内联）。
 * @returns 同一个 schema 实例。
 */
function markVolatile<T extends object>(schema: T): T {
  const meta = Reflect.get(schema, 'meta') as Record<string, unknown> | undefined
  if (meta !== undefined) Reflect.set(meta, 'volatile', true)
  return schema
}

/**
 * 插件配置 schema —— **0.1.7 settings 契约的接线本体**。
 *
 * ## 为什么「导出一份 Config」就能修好 namespace 注册不上
 *
 * DSH 0.1.7 把 settings 服务里 `register(ns, schema) → owner scope` 整套 seam
 * **删除**了（不是改签名），namespace 语义改为「**profile entry id 的 Config
 * 投影**」：宿主 `describe()` 遍历 `configEditor.configuration()`，对每个 entry
 * 取 `entry.fiber.runtime.Config`，只有 `volatileForm(schema)` 返回非 undefined
 * （即 schema 上**至少有一个 volatile 字段**）的 entry 才会进 descriptors，而
 * descriptors 里的 `ns` 就是 **entry id**（`cordis.patch.yml` 里的 `codearts-auth`）。
 *
 * 于是「模型设置页要的 namespace 存在」这件事在 0.1.7 下**完全由这份 Config
 * 决定**：没有 volatile 字段 ⇒ entry 不进 describe() ⇒ namespace 不存在 ⇒
 * 模型设置页读到 undefined 的 profile，在 `refFor → deriveKeyRef(provider)` 处以
 * `provider.toUpperCase is not a function` 崩溃。这正是 7 个 provider namespace
 * 在 0.1.7 上永远注册不上的根因。
 *
 * ## 形态与语义等价性
 *
 * 与宿主第一方逐字对齐：`providers` 是一个 dict，**每个 provider 占一个槽**，
 * 目录项的 `settingsPath` 因此是 `['providers', <provider id>]`（见
 * {@link makeSettingsAddressResolver}）。
 *
 * 值 schema 仍是宽松的 `Schema.dict(Schema.any())`，与 0.1.6 时代那 7 份
 * per-namespace schema（各自 `{ providers: dict(any) }`）语义等价 —— 两者都只是
 * 「承接一个可选的 providers 映射」的占位：本插件从不读 provider profile，
 * 它解析凭据一律走账号池。差别只在**承载粒度**：老契约是 7 个 namespace 各一份，
 * 新契约是 1 个 namespace 下 7 个槽。
 *
 * 注意：schema 必须是真正的 schemastery schema，不能是裸函数 —— 宿主会对每个
 * 进 describe() 的表单无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)`，
 * 裸函数会让 `describe()` 抛 `TypeError: schema.toJSON is not a function`，
 * 进而使所有依赖 settings 的界面（模型设置页、主题、sidebar）全部失败。
 */
export const Config: Schema = Schema.object({
  providers: markVolatile(Schema.dict(Schema.any()).default({})),
})

/**
 * `Config` 的**输出类型**（与上面的 schema 同名，类型位与值位各占一处）。
 *
 * 与宿主第一方同款形态（`llm-pi-ai` 的 `export interface Config` 与
 * `export const Config` 并存）：`apply(ctx, config)` 的形参要能写出类型，而
 * schema 常量本身是值。两处同名不冲突 —— TypeScript 的类型空间与值空间分开。
 *
 * 只有一个可选的 `providers` 字典，是因为本插件**从不读 provider profile**：
 * 凭据一律由账号池解析。这个字段存在的唯一理由是让宿主 settings 有一个
 * **volatile** 的字段可以投影（见 {@link Config} 的说明）—— 设置页把用户填的
 * 值写进 entry config 的 `providers.<id>` 槽，模型设置页按目录项的
 * `settingsPath` 读回。
 */
export interface Config {
  /** provider id → 该 provider 的 profile（内容由设置页写入，本插件不解析）。 */
  providers?: Record<string, unknown>
}

/**
 * settings 服务的**结构化契约视图**。
 *
 * 刻意不用 `import type {} from '@deepseek-ai/dsh-settings'`（宿主第一方的写法）：
 * 那要求把该包加进 devDependencies，而 `package.json` 不在本次改动范围内；且
 * 本插件要同时面对 0.1.6 / 0.1.7 **两套不兼容**的 settings 契约，用一个版本的
 * 类型描述两者本身就是错的。这里只声明「两版并集」里被真正用到的成员，
 * 全部可选，由 {@link detectSettingsContract} 在运行期判别实际形态。
 */
interface SettingsServiceLike {
  /** 0.1.6 契约：注册一个 namespace，返回 owner scope。 */
  register?: (ns: string, schema: unknown) => unknown
  /** 两版都有：回读已生效的 namespace 快照。 */
  describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string }>
  /** 0.1.7 新增：登记本插件实例的设置页呈现策略（`auto: false` 关闭自动生成页）。 */
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => unknown
}

/** `ctx.get('settings')` 的窄化读取（服务缺失时返回 undefined）。 */
function settingsServiceOf(ctx: Context): SettingsServiceLike | undefined {
  return ctx.get('settings') as SettingsServiceLike | undefined
}

/**
 * 本插件面对的 settings 契约版本（**运行期探测的唯一结果**）。
 *
 * - `legacy` —— 0.1.6：`settings.register(ns, schema)` 存在，namespace 要自己注册；
 * - `projection` —— 0.1.7：注册方法已被删除，namespace 是 entry id 的 Config 投影；
 * - `absent` —— settings 服务根本不在（headless / 未装载该服务）。
 *
 * ⚠️ **三者必须区分开**：`absent` 与 `projection` 都会让 `typeof register` 不是
 * 函数，但处置完全相反 —— 前者无计可施（只能提示），后者是正常路径（什么都不用
 * 注册）。早期代码把两者混成一句「settings 服务不可用」，于是 0.1.7 上那句
 * 「服务不可用」把排查方向整个引偏（服务好端端在，只是方法没了）。
 */
export type SettingsContract = 'legacy' | 'projection' | 'absent'

/**
 * 探测当前 profile 的 settings 契约（**只在 `apply()` 里调一次**）。
 *
 * 判据只有一条：`register` 是不是函数。这正是 0.1.7 删除的那个方法，也是两版
 * 唯一互斥的特征；不去嗅探 0.1.7 才有的 `configure`/`update`，因为那会让
 * 「服务在但两个特征都没有」的未知中间态落进错误分支。
 *
 * @param ctx - 插件上下文。
 * @returns 契约版本；settings 服务缺失时为 `absent`。
 */
export function detectSettingsContract(ctx: Context): SettingsContract {
  const settings = settingsServiceOf(ctx)
  if (settings === undefined || settings === null) return 'absent'
  return typeof settings.register === 'function' ? 'legacy' : 'projection'
}

/**
 * 解析**本插件实例的 profile entry id**（0.1.7 下它**就是** namespace）。
 *
 * `ctx.fiber.entry` 由 `@deepseek-ai/cordis-plugin-loader` 增强而来，本插件的
 * 依赖树里没有那个包（它的类型在 `node_modules/@deepseek-ai/cordis` 里查不到），
 * 故这里用一次结构化窄化读取，而不是 `import type {} from '@deepseek-ai/cordis-plugin-loader'`。
 *
 * 回退值是模块级 `name`（`'codearts-auth'`）—— 与 `cordis.patch.yml` 里那行
 * `id: codearts-auth` 同源，因此即使在没有 loader 的测试上下文里也得到同一个 id。
 *
 * @param ctx - 插件上下文。
 * @returns 非空 entry id。
 */
export function resolveSettingsEntryId(ctx: Context): string {
  const entry = (ctx.fiber as unknown as { entry?: { options?: { id?: unknown } } }).entry
  const id = entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : name
}

/**
 * 逐 provider 的 settings 地址解析器。
 *
 * ## 为什么地址必须「按契约现算」而不是写死
 *
 * 两版契约的地址形态**成对不同**，不能各改一半：
 *
 * | 契约 | `settingsNs` | `settingsPath` |
 * |---|---|---|
 * | 0.1.6 `legacy` | `llm-<provider>`（7 个独立 namespace） | `[]`（整节就是该 provider 的 profile） |
 * | 0.1.7 `projection` | entry id（**七个 provider 共用**） | `['providers', <provider>]`（整节是插件的 providers 字典） |
 *
 * 配错一半的形态（如新 namespace + 老空 path）**不会报错**，只会让模型设置页
 * 读到 undefined 的 profile —— 配置项凭空消失，是最难查的那类故障。故这里
 * 由一份解析器统一产出成对的地址，适配器侧只负责原样转交。
 *
 * `legacy` 分支同时覆盖 `absent`：settings 服务不在时地址无人消费，
 * 但保持 0.1.6 形态可让「服务后到」的场景（可选注入）行为一致。
 *
 * @param contract - 探测到的契约版本。
 * @param entryId - 0.1.7 下的 namespace（即 profile entry id）。
 * @returns 传 `provider id` 得到该 provider 的成对地址。
 */
export function makeSettingsAddressResolver(
  contract: SettingsContract,
  entryId: string,
): (provider: ProviderId) => LlmSettingsAddress {
  return (provider: ProviderId): LlmSettingsAddress => contract === 'projection'
    ? { settingsNs: entryId, settingsPath: ['providers', provider] }
    : { settingsNs: `llm-${provider}`, settingsPath: [] }
}

/**
 * 关闭 settings 的**自动生成页**（0.1.7 才有的呈现策略）。
 *
 * 本插件有自己的 Account Hub 面板，宿主的自动生成页只会把同一份 provider 字典
 * 再渲染一遍（重复入口 + 与面板语义不符的表单），故关掉它。`auto: false` 只影响
 * **自动生成页**，不影响模型设置页：那两处走的是 `listConfigurableProviders()` +
 * `settingsNs`/`settingsPath`，与这里的呈现策略无关（宿主第一方的 `llm-pi-ai` /
 * `llm-deepseek` 同样在 `auto: false` 下被模型设置页正常列出）。
 *
 * ⚠️ **三条防御，缺一都会在旧契约或测试环境里炸**：
 * 1. `configure` 不存在就整体跳过 —— 0.1.6 的 settings 没有这个方法；
 * 2. 用 `ctx.inject(['settings'], ...)` 惰性注入而不是直接调用 —— settings 缺失
 *    时子 fiber 静静 pending，不影响本插件加载；
 * 3. `configure` 包在 try/catch 里 —— 同一个 fiber 重复配置会抛
 *    `Settings presentation is already configured`，那只是重复登记，不该让
 *    插件报错。
 *
 * @param ctx - 插件上下文（owner 取 `ctx.fiber`，即本插件实例）。
 */
function installSettingsPresentation(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    const settings = settingsServiceOf(child)
    if (settings === undefined || typeof settings.configure !== 'function') return
    child.effect(() => {
      try {
        return settings.configure?.({ auto: false }, ctx.fiber) as () => void
      } catch (error) {
        child.logger?.debug?.(
          `[codearts-auth] settings 自动生成页策略登记失败（不影响功能）: ${String(error)}`,
        )
        return () => {}
      }
    }, 'codearts-auth: settings presentation')
  })
}

/**
 * 在本插件 fiber 进入 **ACTIVE** 之后执行一次回调。
 *
 * ## 为什么必须等（不是防御性编程，是实测出来的硬约束）
 *
 * 宿主 settings 的 `describe()` 会**跳过** `entry.fiber.state !== ACTIVE` 的
 * entry（`packages/settings/settings/src/index.ts:306-307`），而 `apply()` 执行
 * 期间本 fiber 还是 **LOADING** —— 实测 `ctx.fiber.state`：apply 内 `LOADING`、
 * 微任务里仍 `LOADING`、宏任务起 `ACTIVE`（状态写入发生在 emit 之前，而
 * LOADING→ACTIVE 的迁移在 apply 返回之后）。
 *
 * 所以在 apply() 里**同步**回读 `describe()` 必然看不到自己的 entry —— 那不是
 * 「投影失败」，只是还没激活。早期实现正是如此，会让每一次 0.1.7 启动都误报
 * 一条「未出现在 describe() 中」。
 *
 * 反过来，单测直接在 root context 上 `apply(ctx)` 时 fiber **已经** ACTIVE
 * （root fiber 不经历加载迁移），此时立即执行才是对的。故两种情况都覆盖：
 * 已 ACTIVE 就同步跑，否则挂到 `internal/status` 上等状态迁移。
 *
 * @param ctx - 插件上下文。
 * @param run - 进入 ACTIVE 后执行一次的回调。
 */
function whenFiberActive(ctx: Context, run: () => void): void {
  /** cordis 的 `FiberState.ACTIVE`（const enum 无法运行期引用，故取字面量）。 */
  const ACTIVE = 2
  const stateOf = (value: unknown): number | undefined => (value as { state?: number } | undefined)?.state
  if (stateOf(ctx.fiber) === ACTIVE) {
    run()
    return
  }
  let done = false
  ctx.on('internal/status', (fiber: unknown) => {
    if (done || fiber !== ctx.fiber || stateOf(fiber) !== ACTIVE) return
    done = true
    run()
  })
}

/**
 * 让 provider 配置 namespace 在**当前契约**下真实存在。
 *
 * 两条路各自完整、互不掺杂（见 {@link SettingsContract}）：
 *
 * - `legacy`（0.1.6）：沿用 `settings.register(ns, providerSettingsSchema)` 注册
 *   7 个独立 namespace，并回读 `describe()` 自检 —— 一字未改地保留原逻辑；
 * - `projection`（0.1.7）：**没有可注册的东西**，namespace 由 {@link Config} 的
 *   volatile 字段投影而来，故只在 fiber 激活后做一次回读自检（entry id 必须出现
 *   在 describe() 中，否则模型设置页会崩）；
 * - `absent`：只提示一次，不抛错（headless profile 的既定降级）。
 *
 * ⚠️ 措辞是本函数的一半职责：`absent` 与 `projection` 的症状（register 不是函数）
 * 相同但含义相反，混为一句「settings 服务不可用」会把排查引偏 —— 这条历史教训
 * 写在 {@link SettingsContract} 上。
 *
 * @param ctx - 插件上下文。
 * @param contract - 探测到的契约版本。
 * @param entryId - 0.1.7 下的 namespace（即 profile entry id）。
 * @param namespaces - 0.1.6 下要注册的 7 个 namespace。
 */
function registerProviderSettings(
  ctx: Context,
  contract: SettingsContract,
  entryId: string,
  namespaces: readonly string[],
): void {
  const settings = settingsServiceOf(ctx)
  if (contract === 'absent') {
    ctx.logger.warn(
      '[codearts-auth] settings 服务不存在（当前 profile 未装载 @deepseek-ai/dsh-settings）：'
      + 'provider 配置 namespace 既无法注册（0.1.6 契约）也无法投影（0.1.7 契约），'
      + '模型设置页不会列出本插件的 provider 配置。账号池、登录与模型路由均不受影响。',
    )
    return
  }
  if (contract === 'projection') {
    // 0.1.7：namespace = profile entry id，由 Config 的 volatile 字段投影而来，
    // 此处**没有可注册的东西**。唯一能做也该做的是回读确认它真的出现了 ——
    // 没出现就是模型设置页要崩的前兆，必须报出来而不是静默。
    //
    // ⚠️ **自检必须等本 fiber 进入 ACTIVE**（见 {@link whenFiberActive}）：宿主
    // `describe()` 跳过非 ACTIVE 的 entry，而 `apply()` 期间本 fiber 还是
    // LOADING —— 同步回读必然看不到自己，从而每次启动都误报一条「未出现在
    // describe() 中」。那不是投影失败，只是还没激活。
    //
    // 注意：describe() 会遍历全部 entry 并调用各自 schema 的 toJSON()/redactSecrets()，
    // 任一 entry 的 schema 不合规都会让整条调用抛错，故这里必须把异常打出来。
    whenFiberActive(ctx, () => {
      try {
        const descriptors = settingsServiceOf(ctx)?.describe?.({ redactSecrets: true })
        if (descriptors === undefined) return
        const projected = descriptors.map(v => v.ns)
        if (!projected.includes(entryId)) {
          ctx.logger.warn(
            `[codearts-auth] settings namespace "${entryId}"（0.1.7：profile entry id 的 Config 投影）`
            + `未出现在 describe() 中，模型设置页会因未注册 namespace 崩溃；`
            + `已投影的 namespace: ${projected.join(', ') || '(空)'}`,
          )
          return
        }
        ctx.logger.info(`[codearts-auth] settings namespace 投影就绪: ${entryId}`)
      } catch (error) {
        ctx.logger.error(
          `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
          + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        )
      }
    })
    return
  }
  // ---- 0.1.6 契约：注册 7 个独立 namespace（逻辑与迁移前逐字一致）----
  for (const ns of namespaces) {
    try {
      settings?.register?.(ns, providerSettingsSchema())
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings?.describe?.({ redactSecrets: true }) ?? []
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
 * 0.1.6 契约下每个 namespace 各自的 provider 配置 schema。
 *
 * 每次调用返回**新实例**（8 个 namespace 各持一份，避免共享同一个 schema 对象
 * 在宿主 `plainSchema`/`redactSecrets` 侧被就地改写时互相串味）。
 *
 * 之所以要 `Schema.object({...})` 而不能是裸函数：`describe()` 会对每个注册项
 * 无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)` —— 传入
 * `(value) => ...` 会让 `describe()` 抛
 * `TypeError: registration.schema.toJSON is not a function`，进而使所有依赖
 * settings 的界面（模型设置页、主题、sidebar 的 settings.get/shell.get）全部失败。
 *
 * @returns `{ providers: dict(any) }` 的宽松占位 schema。
 */
function providerSettingsSchema(): unknown {
  return Schema.object({
    providers: Schema.dict(Schema.any()).default({}),
  })
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，
 * 只是收到图片时报 UNSUPPORTED_CONTENT。两个 Buddy 系产品（Buddy CN /
 * Buddy）共用同一后端与协议，图片能力相同，故共用本实现。
 *
 * ⚠️ **失败必须抛错**：早期实现对「附件服务缺失」与「单图读取失败」一律
 * `return undefined`，适配器据此 `continue` 丢掉整张图 —— 线上请求静默
 * 退化成纯文本，用户只看到模型答「我没看到图片」，拿不到任何原因。
 * 故返回类型不含 `undefined`，异常分工是：桥接层**不包装**（保留原始
 * cause），适配器层负责包成带 attachmentId 的 `UNSUPPORTED_CONTENT`。
 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 进程级的**轮次标识 → 轮次键**换算器。
 *
 * 模块级单例，**必须**是单例：`makeCredentialResolver` 与 `makeAccountRefresher`
 * 各自调用一次 `makeAccountPicker`，若各持一个换算器，同一个 `signal` 会在两处
 * 得到不同的键 —— 于是「续期刷新的就是解析凭据时用的那个账号」这条不变量
 * （见 {@link makeAccountRefresher}）在「按轮次」档下被破坏，而且没有任何报错。
 */
const turnKeys = new TurnKeyTracker()

/**
 * 账号池选号器：按目标模型挑选一个可用账号。
 *
 * 抽成独立函数是**必需的**，不是为了复用：`resolveCredential` 与 LobsterAI 的
 * `refresh` 回调都要「按模型挑一个账号」，而两者的挑号结果**必须一致**。
 * 若各写一份，resolve 在 A 对模型 M 限流时会挑到 B，而 refresh 用空
 * modelId 会挑回数组顺序最前的 A —— 于是「刷新的是解析凭据时所用的那个账号」
 * 这条不变量（见 `lobsterai-wiring.spec.ts` 的 S1）被破坏：适配器拿到 B 的
 * 凭据却刷新了 A，B 的过期 token 始终不更新，用户看到的是「刚登录好却
 * 一直认证失败」，而日志里续期全绿。
 *
 * 两步策略（第二步是刻意的退化，不要「顺手」删掉）：
 * 1. 先按目标模型过滤，跳过仍在该模型冷却期内的账号；
 * 2. 全被过滤掉时退回不过滤的查询。原因见 {@link makeCredentialResolver}。
 *
 * ## `turnIdentity`：消耗顺序 / 切换粒度的第二个可选实参
 *
 * 适配器把 `options.signal` 原样传进来（它是**唯一**的轮次标识 —— DSH 的
 * `GenerateOptions` 里没有 turn 级字段，`sessionId` 是会话级、跨轮稳定，详见
 * `src/account-consumption.ts` 的 `TurnKeyTracker`）。池据此按该 provider 配置的
 * 档位选号，并在「按轮次」粒度下锁住同一轮的账号。
 *
 * ⚠️ **不传第二个实参时行为与改动前逐字相同**（恒取第一个可用账号）——
 * 拉模型目录、探测等非请求路径必须走这一条。
 *
 * @param pool - 账号池；未提供时返回 null（调用方自行回退单凭据）。
 * @param provider - provider id（`this.product.id`，不要写死字面量）。
 */
export function makeAccountPicker(
  pool: AccountPool | undefined,
  provider: string,
): (model?: string, turnIdentity?: unknown) => Promise<Awaited<ReturnType<AccountPool['getAvailableAccount']>>> {
  return async (model?: string, turnIdentity?: unknown) => {
    if (!pool) return null
    const target = model ?? ''
    // ⚠️ `turnIdentity === undefined`（调用方没传第二个实参）与「传了但换算不出键」
    // 是两种语义，不要合并：
    // - `undefined` = **完全按历史行为选号**，不看配置（拉目录 / 探测路径）；
    // - 换算出空串 = 按配置选号、但不锁轮次（等价「按请求」）。
    const pick = turnIdentity === undefined ? undefined : { turnKey: turnKeys.keyFor(turnIdentity) }
    const filtered = await pool.getAvailableAccount(provider, target, undefined, pick)
    if (filtered) return filtered
    if (target.length === 0) return null
    // 退化：所有账号都在冷却期 → 取一个让调用方去实测（见 makeCredentialResolver）。
    return pool.getAvailableAccount(provider, '', undefined, pick)
  }
}

/**
 * 构造 provider 的凭据解析函数（四个 provider 共用同一段接线）。
 *
 * **`model` 参数就是本函数存在的理由**：`getAvailableAccount` 的限流过滤是
 * **逐模型**的，`modelId` 传空串时按设计不过滤（见 `AccountPool` 的说明）。
 * 历史接线把空串写死在这里 —— 于是每次请求开头总是拿到「数组顺序最前」的账号，
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
 * ⚠️ **`turnIdentity` 必须与 `model` 一起原样透传**（第二个参数位）：它是
 * 「切换粒度 = 按轮次」锁定账号的依据（见 `makeAccountPicker` 与
 * `src/account-consumption.ts`）。适配器传了 `options.signal` 而 resolver 在这里
 * 丢掉它，会让「同轮锁同一账号」静默失效 —— 用户看到的是「配了按轮次，但每步
 * 都换号」，而且没有任何报错。
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
): (model?: string, turnIdentity?: unknown) => Promise<T | undefined> {
  const pick = makeAccountPicker(pool, provider)
  return async (model?: string, turnIdentity?: unknown) => {
    const available = await pick(model, turnIdentity)
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

/**
 * 构造 provider 的**续期回调**，与 {@link makeCredentialResolver} 配对使用。
 *
 * ## 为什么必须与 resolver 配对
 *
 * `resolveCredential` 优先从账号池取 `<PROVIDER>_ACCOUNT_XXX` 的凭据，而各 auth
 * 服务的 `refresh()` 读写的是该 provider 的**默认单凭据 ref**（如
 * `CODEARTS_ACCESS_TOKEN`）。两处错配的后果链（与 `lobsterai-wiring.spec.ts`
 * 记录的 S1、以及 `src/account-hub-rpc.ts` 的 `account.refresh` 同一缺陷）：
 * 适配器检测到池凭据过期 → 调 refresh → 刷的是**另一个** ref（池内账号用户那里
 * 甚至不存在该 ref，直接抛「未配置凭据，请先登录」）→ 再 resolve 仍取到那份
 * 未更新的过期凭据 → 带着过期凭据发请求。用户看到「刚在 Account Hub 登录好，
 * 却一直认证失败 / 让我重新登录」，而日志里续期全绿，极难排查。
 *
 * 与 `account.refresh` RPC 的区别：RPC 那边**已经有** `accountId`（账号卡片的
 * 目标账号是明确的），故直接按 `entry.credentialRef` 续期；而适配器回调只有
 * **目标模型**这一个线索，必须走与 resolver **完全相同**的选号路径
 * （同一个 `makeAccountPicker`、同一个 `model` 实参）才能保证挑到同一个账号。
 *
 * ## 两条刻意的退化（不要「顺手」删掉）
 *
 * 1. **池内无候选时回退 `refresh()`**：这是单凭据用户（`/codearts-login` 等旧
 *    入口）的正常通路 —— 他们根本不在池里，只有默认 ref。若在这里抛错，
 *    等于把「没配账号池」误报成故障。
 * 2. **`model` 必须原样透传给选号器**：退回空 modelId 会挑回数组顺序最前的
 *    账号（可能正是对该模型限流的那个），从而重新引入错配（见
 *    {@link makeAccountPicker} 的说明）。
 *
 * @param pool - 账号池；省略/未提供时只用默认单凭据 `refresh()`。
 * @param provider - provider id（`this.product.id`，不要写死字面量）。
 * @param service - 必须同时提供 `refresh()` 与 `refreshAccountCredential(ref)`。
 */
export function makeAccountRefresher(
  pool: AccountPool | undefined,
  provider: string,
  service: {
    refresh: () => Promise<void>
    refreshAccountCredential: (refName: string) => Promise<void>
  },
): (model?: string, turnIdentity?: unknown) => Promise<void> {
  const pick = makeAccountPicker(pool, provider)
  return async (model?: string, turnIdentity?: unknown) => {
    // ⚠️ `turnIdentity` 与 `model` 必须**用同一组实参**调同一个 pick（这里与
    // `makeCredentialResolver` 是同一个 `makeAccountPicker`、同一个**
    // 模块级**换算器）。丢掉它会让「按轮次」档在续期路径上挑到另一个账号，
    // 从而刷新错凭据 —— 正是本函数存在理由所针对的那条错配，只是触发条件
    // 换成了粒度档。
    const available = await pick(model, turnIdentity)
    if (available) {
      await service.refreshAccountCredential(available.entry.credentialRef)
      return
    }
    await service.refresh()
  }
}

/**
 * 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。
 *
 * @param ctx - 插件上下文。
 * @param config - 宿主按 {@link Config} 校验后的插件配置。本插件**不读**它
 *   （凭据一律由账号池解析），参数存在的意义是让 cordis 把本 entry 认成
 *   「有 Config 的插件」—— 0.1.7 的 settings 投影正是按 `runtime.Config` 取
 *   schema 的（见 {@link Config}）。省略时不报错（与宿主第一方同款可选形参）。
 */
export function apply(ctx: Context, config?: Config): void {
  void config
  // ===== settings 契约探测（**全流程只做这一次**）=====
  //
  // 0.1.6 与 0.1.7 的 settings 契约不兼容：老版要 `register(ns, schema)` 逐个注册
  // namespace，新版把这套 seam 删了、namespace 改为「profile entry id 的 Config
  // 投影」。探测结果同时决定两件事：
  // ① namespace 怎么来（见 registerProviderSettings）；② 每个 provider 目录项的
  // settings 地址形态（见 makeSettingsAddressResolver）—— 二者必须同源，否则会
  // 出现「namespace 是新的、path 是老的」这种半迁移态，且**不报错**，只让模型
  // 设置页读到 undefined 的 profile（配置项凭空消失）。
  const contract = detectSettingsContract(ctx)
  const entryId = resolveSettingsEntryId(ctx)
  // 逐 provider 的成对地址（namespace + 分槽路径）。7 处 registerXxxLlm 各自取自己
  // 那一份传进 `settingsAddress` 选项 —— 适配器不做探测、不认识契约版本，只原样
  // 转交给 `registerConfigurableProviders`。
  const settingsAddressFor = makeSettingsAddressResolver(contract, entryId)
  // 0.1.7 专属：关掉宿主 settings 的自动生成页（本插件有自己的 Account Hub 面板）。
  // 0.1.6 下 `configure` 不存在，函数内部整体跳过。
  installSettingsPresentation(ctx)

  // provider 的 settingsNs 必须真实存在，否则模型设置页会因未注册 namespace 崩溃。
  // 七条路由分别是：codearts、Buddy CN（buddy-cn）、Buddy（buddy）、
  // LobsterAI（lobsterai）、Trae CN（trae-cn）、Qoder 两区（qoder / qoder-cn）。
  // 0.1.6 下这七个 namespace 由下面的调用逐个注册；0.1.7 下它们合并为**一个**
  // namespace（本插件的 entry id，见 `Config`）。
  // ⚠️ 无论哪一版，namespace 都必须与各 registerXxxLlm 交给
  // `registerConfigurableProviders` 的 `settingsNs` 一致 —— 不一致时模型设置页在
  // `refFor → deriveKeyRef(provider)` 处以
  // `provider.toUpperCase is not a function` 崩溃。
  // 注意 `llm-trae-cn` / `llm-buddy-cn` 里的连字符是**正确**的：0.1.6 的 namespace
  // 是字符串键而非标识符，与 cordis 服务名（`traeCnAuth` / `buddyCnAuth`）
  // 走的是两套命名规则。
  // Qoder 与 Qoder **CN**（`qoder-cn`）是**同协议双 region**，
  // 但两区的账号、用量、PAT **互不相通**，故是**两个独立 provider**
  // （详见 `src/qoder-product.ts` 的模块头）。
  registerProviderSettings(
    ctx,
    contract,
    entryId,
    ['llm-buddy-cn', 'llm-buddy', 'llm-codearts', 'llm-lobsterai', 'llm-trae-cn',
      'llm-qoder', 'llm-qoder-cn'],
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  // 持久层接管：打开 storage 域，并在 storage 为空时把旧 settings 位置
  // （settings.yaml.imported → settings.yaml → 旧 scope）的数据一次性搬进来。
  //
  // ⚠️ **必须早于下面的改名迁移**，且顺序不可颠倒。改名迁移会「读池 → 改 id / 凭据
  // ref → 整体写回」，若它先跑：① 它读到的是旧路径的数据、写回的也是旧路径；
  // 随后 storage 迁移虽然拿到了数据，但版本号已被改名迁移推进，语义就乱了；
  // ② 更糟的是 `migrateProviderNames` 内部只在版本号 <1 时动手，两次迁移谁先谁后
  // 会决定「搬到 storage 的是改名前的还是改名后的账号」。
  //
  // 本函数是同步签名（宿主按同步 apply 调用），故这里用 `.then()` 串起来：
  // 池的读路径在 storage 接管前走旧路（可用），接管后再切到 storage ——
  // `openStorage()` 内部会重置载入标记，切换点不会留下两套数据分叉。
  void pool.openStorage().then(() => {
    // 一次性数据迁移：把历史 provider 名（buddy = 中国版 / workbuddy = 国际版）、
    // 旧凭据 ref（BUDDY_* / WORKBUDDY_*）与旧 disabledModels 键搬到新命名
    // （buddy-cn / buddy）。**必须早于下面所有池查询** —— 池的每次读取都按
    // provider 过滤，带着旧 id 的账号在新体系里等同于不存在。
    //
    // ⚠️ **下面的域名审计必须挂在本 Promise 之后，不能与它并行**：
    // `pruneAccountsWithForeignDomain(BUDDY)` 按 `entry.provider === 'buddy'` 选账号，
    // 而迁移**之前**的 `buddy` 正是中国版（域名 copilot.tencent.com）。若两者
    // 并行，审计会把这批中国版账号判成「域名失配」——虽已改为只告警不删除，
    // 但会打出误导性警告。迁移自身是 fire-and-forget（内部自吞异常
    // 并打日志，绝不阻断启动），故这里用 `.then()` 串联而不是 `await`。
    void migrateProviderNames(pool, ctx).then(() => {
      // 一次性**体检迁移**：逐条把凭据内容（JWT 的 `iss` 声明，回退 domain）与
      // 条目上的 provider 标签对一遍，不一致就重建为目标 provider 的条目
      // （新 id / 新 ref、凭据读旧写新、**绝不 unset 旧凭据**）。历史事故是
      // 「国际版凭据挂在 BUDDY_CN_ACCOUNT_* 前缀下、条目写着 buddy-cn」，
      // 成因见 `src/provider-audit-migration.ts` 的模块头。
      //
      // ⚠️ **必须挂在改名迁移之后**：两条迁移都按 `entry.provider` 选账号，而
      // `buddy` 这个 id 在改名迁移前后指两个不同产品。顺序反了（或并行）时，
      // 体检会拿旧标签去比对凭据签发方，把刚改对名的账号又重建回旧标签。
      // 它有自己的版本闸门（`providerAuditVersion`），与 schemaVersion 无关。
      //
      // 下面的域名审计挂在体检**之后**：体检把标签修对之后，审计的
      // 「domain ≠ 产品 apiDomain」才不会对刚修好的条目误报。
      void auditProviderAssignments(pool, ctx).then(() => {
        // Buddy（国际版）provider 早年是中国版（copilot.tencent.com）实现，
        // 后来改造为国际版（www.workbuddy.ai）。期间登录的账号其 token.domain
        // 仍指向中国版端点，用新 endpoint 发请求必然失败且会一直续期失败。
        // 判据是「凭据 domain ≠ 产品 apiDomain」，只圈定真正失配的条目。
        // ⚠️ **只告警、不删除**：失配条目的凭据可能依然有效（国际版账号凭据里
        // 写着中国版时代遗留的 domain），连凭据一起删除会把不可恢复的数据销毁。
        // 此处仅记录警告，交由用户自行处理。两个产品各审计一次：中国版
        // （buddy-cn）历史上也踩过同类坑，只审一边会漏掉另一半。
        for (const product of [BUDDY_CN, BUDDY]) {
          // 单条账号的告警由函数内部逐条打出，这里只兜住意外异常。
          void pool.pruneAccountsWithForeignDomain(product).catch((error: unknown) => {
            ctx.logger.warn(`[account-hub] 审计 ${product.displayName} 域名失配账号失败：${String(error)}`)
          })
        }
      })
    })
  }).catch((error: unknown) => {
    // openStorage 自身已把可预期的失败吞掉并降级；这里只兜住意外异常，
    // 绝不让持久层的问题阻断插件加载。
    ctx.logger.warn(`[account-hub] storage 接管失败，账号池以当前通路继续：${String(error)}`)
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
  // 适配器实例要交给 RPC 层：Account Hub 的「显示列表」用它拿**不套用户黑名单、
  // 也不套目录门控**的完整目录（`listAllModels`），被关闭的模型才有正确的展示名。
  const codeartsAdapter = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    // 优先使用账号池获取可用账号（按目标模型过滤），回退到单凭据解析。
    resolveCredential: makeCredentialResolver<CodeArtsCredential>(
      ctx, pool, 'codearts', CODEARTS_CREDENTIAL_REF,
    ),
    refresh: makeAccountRefresher(pool, CODEARTS_PROVIDER, service),
    fetchRemoteModels: () => service.refreshModels(),
    accountPool: pool,
    // settings 地址**按探测到的契约现算**（0.1.6：`llm-codearts` + `[]`；
    // 0.1.7：entry id + `['providers', 'codearts']`）。适配器不做探测、
    // 也不认识契约版本，只把成对地址原样转交（见 `LlmSettingsAddress`）。
    settingsAddress: settingsAddressFor(CODEARTS_PROVIDER),
  })

  // ===== Buddy CN (腾讯 CodeBuddy 中国版) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Account Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。
  const buddyCn = new BuddyAuth(ctx)
  // 适配器实例要交给 RPC 层（理由见 `src/context-tiers.ts` 的 `ContextTierSource`）：
  // Buddy 的目录公布 `contextWindow.supportedLengths` 整张档位表，而那是**远端
  // 目录持有者**独有的数据。两个产品各一个实例，键不同、档位互不顶替。
  const buddyCnAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    // 池中账号按 `product.id` 归属；provider 实参必须与产品一致，否则查不到账号。
    resolveCredential: makeCredentialResolver<BuddyCredential>(
      ctx, pool, BUDDY_CN.id, BUDDY_CREDENTIAL_REF,
    ),
    refresh: makeAccountRefresher(pool, BUDDY_CN.id, buddyCn),
    fetchRemoteModels: () => buddyCn.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: BUDDY_CN,
    settingsAddress: settingsAddressFor(BUDDY_CN.id),
  })

  // ===== Buddy (腾讯 WorkBuddy 国际版) 服务 =====
  // 与 Buddy CN 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由产品配置的 serviceName 显式给出，故两个产品分别注册为
  // ctx.buddyCnAuth / ctx.buddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Account Hub 的 Buddy 面板。
  const buddy = new BuddyAuth(ctx, { product: BUDDY })
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY.defaultCredentialRef),
    // 只从 buddy 的账号池取账号，回退到 Buddy 自己的单凭据 ref，
    // 保证不会串用 Buddy CN 的凭据。
    resolveCredential: makeCredentialResolver<BuddyCredential>(
      ctx, pool, BUDDY.id, BUDDY.defaultCredentialRef,
    ),
    refresh: makeAccountRefresher(pool, BUDDY.id, buddy),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: BUDDY,
    settingsAddress: settingsAddressFor(BUDDY.id),
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Account Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  // 适配器实例要交给 RPC 层：Account Hub 的「显示列表」用它拿**不套用户黑名单、
  // 也不套目录门控**的完整目录（`listAllModels`），被关闭的模型才有正确的展示名。
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
    // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
    // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: makeCredentialResolver<LobsteraiCredential>(
      ctx, pool, LOBSTERAI.id, LOBSTERAI.defaultCredentialRef,
    ),
    // 接线理由（为什么必须刷解析时所用的那个账号）与回归测试见
    // makeAccountRefresher / lobsterai-wiring.spec.ts。
    // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
    // `RefreshToken(acct)`（而非某个全局单例）。
    refresh: makeAccountRefresher(pool, LOBSTERAI.id, lobsterai),
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    accountPool: pool,
    product: LOBSTERAI,
    // settings 地址按契约现算（0.1.6：`llm-lobsterai` + `[]`；
    // 0.1.7：entry id + `['providers', 'lobsterai']`）。
    settingsAddress: settingsAddressFor(LOBSTERAI.id),
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
  // 适配器实例要交给 RPC 层：Account Hub 的「显示列表」需要逐模型的窗口档位
  // （dev / Max），而那是**目录持有者**独有的数据 —— `ctx.llm.listModels()` 会把
  // 适配器返回的额外字段丢掉，ctx 上也没有「按 provider 取适配器」的入口。
  const traeCnAdapter = registerTraeCnLlm(ctx, {
    credentialRef: credentialRef(TRAE_CN.defaultCredentialRef),
    // 只从 Trae CN 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它四条线的凭据。
    // provider 实参用 TRAE_CN.id 而非字面量 'trae-cn'：写死字面量在改名/多产品
    // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: makeCredentialResolver<TraeCnCredential>(
      ctx, pool, TRAE_CN.id, TRAE_CN.defaultCredentialRef,
    ),
    // 接线理由（为什么必须刷解析时所用的那个账号）与回归测试见
    // makeAccountRefresher / lobsterai-wiring.spec.ts。
    refresh: makeAccountRefresher(pool, TRAE_CN.id, traeCn),
    accountPool: pool,
    readImage: makeReadImage(ctx),
    product: TRAE_CN,
    // settings 地址按契约现算（0.1.6：`llm-trae-cn` + `[]`；
    // 0.1.7：entry id + `['providers', 'trae-cn']`）。
    settingsAddress: settingsAddressFor(TRAE_CN.id),
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
  // 适配器与 quotaVerdict **共用同一个凭据解析器**：两处各写一份必然分叉
  // （理由同上）。
  const resolveQoderCredential = makeCredentialResolver<QoderCredential>(
    ctx, pool, QODER.id, QODER.defaultCredentialRef,
  )
  // 适配器实例要交给 RPC 层：Account Hub 的「显示列表」需要逐模型的窗口档位
  // （`contextWindow` / `contextTiers`），而那是**目录持有者**独有的数据 ——
  // `ctx.llm.listModels()` 会把适配器返回的额外字段丢掉，ctx 上也没有「按 provider
  // 取适配器」的入口（见 `src/context-tiers.ts` 的 `ContextTierSource`）。
  // **目录签名来源**（设备流目录链）：wasm 懒加载形态与 chat 签名一致 ——
  // 提取要扫 35 MB 的 worker 文本或下载 30 MB 的 tarball，放在插件启动期会拖慢
  // 启动。⚠️ **只在目录路径使用**：国际版 chat 走 REST（一行不动），
  // `QoderAdapterOptions.signing` **刻意不传**；`directorySigning` 只被
  // `ensureCatalog → fetchQoderDirectory` 的 `dt-` 分派消费。
  // wasm 失败时目录侧静默回退静态表（经 onDebug 报 debug 级原因），不炸面板。
  const qoderSigning = new QoderSigningProvider({
    product: QODER,
    loadGlue: async () => {
      const artifact = await extractQoderWasm({ product: QODER })
      ctx.logger?.debug?.(`[qoder] wasm 来源 ${artifact.source}：${artifact.detail}`)
      return instantiateQoderWasm(artifact.bytes)
    },
  })
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
    // 保证不会串用其它六条线的凭据。
    // provider 实参用 QODER.id 而非字面量 'qoder'：写死字面量在改名/多产品
    // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: resolveQoderCredential,
    // 续期对 Qoder 就是**重打 exchange**（PAT 不变，随时可重打），不是
    // 「refresh_token 换新」——见 `src/qoder-auth.ts` 的 refresh 说明。
    // 接线理由（为什么必须刷解析时所用的那个账号）与回归测试见
    // makeAccountRefresher / lobsterai-wiring.spec.ts。
    refresh: makeAccountRefresher(pool, QODER.id, qoder),
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
    // settings 地址按契约现算（0.1.6：`llm-qoder` + `[]`；
    // 0.1.7：entry id + `['providers', 'qoder']`）。两个 region 各取自己那份 ——
    // 0.1.7 下它们共用同一个 namespace（entry id）但**分槽不同**，这正是
    // `settingsPath` 存在的理由。
    settingsAddress: settingsAddressFor(QODER.id),
    // 设备流目录链（dt- → wasm 签名目录）：本 region 专用实例。⚠️ chat 的
    // `signing` 位**刻意留空**（国际版 chat 是 REST，一行不动）。
    directorySigning: qoderDirectorySigningSource(qoderSigning),
    // 每次发送报出请求体字节数（**debug 级**）：Qoder 国际版有一条 256 KiB 的
    // 字节墙，闸门在 240 KiB（见 `src/qoder-errors.ts` 的
    // `QODER_MAX_REQUEST_BYTES`）。报字节数是让「贴着墙」这件事在**用户报障
    // 之前**就可观测。
    //
    // ⚠️ 走 `debug` 而不是 `info`：这是一条每次请求都发的常规观测，不该在默认
    // 级别刷屏。⚠️ 但要知道 Cordis 的默认导出阈值是 **INFO**，故 debug 行默认
    // **不显示** —— 需要它时把 exporter 的 level 提到 3（本仓库其它 provider 的
    // `onDebug` 接的是 `info`，那是「偶发的一次性诊断」，与本条的高频性质不同）。
    onDebug: (message) => ctx.logger?.debug?.(message),
  })

  // ===== Qoder CN (国内版) 服务 =====
  //
  // **与国际版同协议、双 region**：exchange / quota / models 三个端点的错误信封
  // 逐字节同构，故**不新写任何实现** —— 适配器与 auth 都是同一份代码按传入的
  // `product` 现算（见 `src/qoder-product.ts` 的模块头）。本段只是把**第二个
  // region** 接上宿主：另一个服务名、另一条路由、另一个池键。
  //
  // ## 为什么是**两个 provider** 而不是一个 provider 的两个 region 开关
  //
  // 两个 region 的**账号、用量、PAT 互不相通**（实测 CN 的 `jt-` 打国际版端点
  // 回 401，Credits 完全不互通）。若合成一个 provider，账号池里两区的凭据会
  // 混在同一组候选里，适配器换号时会把 CN 的 PAT 拿去打国际版端点 ——
  // 得到的是「凭据失效」的假象，且**不报任何配置错误**。
  //
  // ⚠️ **两个 region 的池查询一律传各自的 id，不做任何映射**：
  // Qoder CN 与国际版是**两批账号**，池查询一律传
  // `QODER_CN.id`（`'qoder-cn'`），**不做任何 poolProviderId 映射**。
  // 账号条目的 `provider` 字段 = `'qoder-cn'`，凭据 ref 前缀
  // `QODER_CN_ACCOUNT_*`（连字符转下划线的机制已有，见
  // `src/account-hub-rpc.ts` 的 `accountCredentialRefName`）。
  //
  // 服务名由产品配置显式给出 `qoderCnAuth`：id 带连字符，机械派生的
  // `qoder-cnAuth` 不是合法标识符风格 —— 这正是 `QoderProduct.serviceName`
  // 那条判据的**正面用例**（国际版 `qoder` 不声明该字段，是反面用例）。
  // 构造时 `QoderAuth` 自动读取 `product.serviceName`，本段**不另写派生**。
  const qoderCn = new QoderAuth(ctx, { product: QODER_CN })
  // 适配器与 quotaVerdict **共用同一个凭据解析器**：两处各写一份必然分叉
  // （理由同上）。
  const resolveQoderCnCredential = makeCredentialResolver<QoderCredential>(
    ctx, pool, QODER_CN.id, QODER_CN.defaultCredentialRef,
  )
  // **签名来源**：CN 的 chat 只有 wasm 签名路径可用（REST 路径在 CN 网关不存在，
  // 实测 ALB 按路径级恒 503），故必须注入。
  //
  // ⚠️ **只在 CN 段建实例**：签名器把 `product` 绑在构造时，两区共用一个实例会
  // 拿 CN 的机器码去签国际版的请求（上游回 `101 Signature invalid`，与「凭据
  // 失效」同形，极难排查）。国际版根本不走签名路径，也就不需要这个实例。
  //
  // **wasm 是懒加载**（`loadGlue` 在第一次真正要签名时才调）：提取要扫 35 MB 的
  // worker 文本或下载 30 MB 的 tarball，放在插件启动期会让启动平白变慢。
  // 提取失败原样抛出 `QoderWasmUnavailableError`，由适配器转成可读的直报错误
  // （带三级尝试原因）—— 这里**不吞**，否则用户只会看到一句「请求失败」。
  const qoderCnSigning = new QoderSigningProvider({
    product: QODER_CN,
    loadGlue: async () => {
      const artifact = await extractQoderWasm({ product: QODER_CN })
      ctx.logger?.debug?.(`[qoder-cn] wasm 来源 ${artifact.source}：${artifact.detail}`)
      return instantiateQoderWasm(artifact.bytes)
    },
  })
  // 与国际版同因：目录持有者才能回答「这个模型有哪些窗口档位」。
  // ⚠️ **必须是 CN 自己的实例** —— 两个 region 的目录是两套（CN 静态表不含
  // `lite`、目录项也不同），把国际版的实例注册到 `qoder-cn` 键上会让 CN 面板
  // 显示国际版的档位。
  const qoderCnAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    // 只从 Qoder CN 自己的账号池取账号，回退到自己的单凭据 ref
    // （`QODER_CN_PERSONAL_TOKEN`）—— 保证不会串用国际版的凭据。
    // provider 实参用 QODER_CN.id 而非字面量：写死字面量在改名场景下会静默
    // 查不到账号（本插件在 workbuddy 上踩过同类坑）。
    resolveCredential: resolveQoderCnCredential,
    // 续期同样是**重打 exchange**，打的却是 CN 自己的 openapi 基址
    // （`product.openapiBase`，A 段已让 exchange 走产品配置）。
    // 接线理由（为什么必须刷解析时所用的那个账号）与回归测试见
    // makeAccountRefresher / lobsterai-wiring.spec.ts。
    refresh: makeAccountRefresher(pool, QODER_CN.id, qoderCn),
    // job token 提供者：**必须是 CN 的 auth 实例** —— jt 缓存按实例持有，
    // 用国际版实例换来的 jt 打 CN 端点只会得到一次 401。
    getJobToken: (pat: string) => qoderCn.getJobToken(pat),
    invalidateJobToken: (pat: string) => { qoderCn.invalidateJobToken(pat) },
    // **402 的额度二次判别**：与国际版同因（402 在本 provider 上有语义污染 ——
    // quota=0 的账号上无效模型名也回同一个 402 `code:116`），故「换号可救」
    // 必须由**CN 的**额度端点确证。查不到一律返回 undefined ⇒ 保守判「不换号」。
    quotaVerdict: async () => {
      const credential = await resolveQoderCnCredential()
      if (credential === undefined || credential.access_token.length === 0) return undefined
      return checkQoderQuotaExhausted(credential, qoderCn, {
        onDebug: (message) => ctx.logger?.info?.(message),
      })
    },
    accountPool: pool,
    product: QODER_CN,
    // settings 地址按契约现算（0.1.6：`llm-qoder-cn` + `[]`；
    // 0.1.7：entry id + `['providers', 'qoder-cn']`）。两区各占一个槽，
    // 不能共用国际版那一份。
    settingsAddress: settingsAddressFor(QODER_CN.id),
    // 签名来源（本 region 专用实例，见上方的构造点）。
    signing: qoderCnSigning,
    // 设备流目录链：CN 的目录 host 与 chat 签名是**同一个** gateway（
    // `resolveQoderDirectoryEndpoint` 复用 `product.chatBase`）。共用同一个
    // provider 实例（uid 缓存/签名器复用判据都在实例内按凭据分键）。
    directorySigning: qoderDirectorySigningSource(qoderCnSigning),
    // 与上面 QODER 段**同源同口径**（同一个回调、同一级 debug）：两个 region 共用
    // 同一份发送代码，观测也必须共用同一处语义 —— 只给国际版接会让 CN 的
    // bodyBytes 静默消失。
    onDebug: (message) => ctx.logger?.debug?.(message),
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
    try {
      // CN 与 国际版是**两个独立的 provider**（两区账号不互通），故各刷各的：
      // 漏掉这一行不会报错，只是 CN 账号永远等不到主动续期。
      await qoderCn.refreshAll(pool)
    } catch { /* 静默 */ }
    // Qoder **存量账号资料回填**（昵称 / 有效期）：
    //
    // 只修登录链不够 —— 盘上已有的条目昵称**已经是 UUID 了**，且从没写过
    // expiresAt，这两项都不会因为「以后新登录的账号是对的」而自愈。
    //
    // ⚠️ **挂在既有批量链上，不自造定时器**（插件已有一个每 30 分钟的续期
    // 定时器，再加一个只会多一处 dispose 清理点与一类并发时序）。
    // 判据幂等：昵称不是占位形、有效期已记 ⇒ 一次网都不出（见
    // `needsQoderAccountProfileBackfill`）。两个 region 各调各的实例。
    try {
      await qoder.backfillAccountProfiles(pool)
    } catch { /* 静默 */ }
    try {
      await qoderCn.backfillAccountProfiles(pool)
    } catch { /* 静默 */ }
  }

  // 启动时如果有任何可续期账号，安排定期续期。
  //
  // ⚠️ 判据只看 `refreshable`，**不看 `enabled`**：停用只影响账号池的**自动选号**，
  // 与「凭据是否需要保持新鲜」无关。早期这里写成 `a.refreshable && a.enabled`，
  // 于是**全部账号都被停用**时续期定时器根本不注册 —— 整个多账号续期静默失效，
  // 所有 refresh_token 一路放到过期，用户重新启用后只能重新登录（真实缺陷）。
  //
  // ⚠️⚠️ **判据必须在 storage 就绪之后才算**（本单修复的主因）：`apply()` 是同步
  // 签名，而 `pool.openStorage()` 是异步的。历史接线在 apply 的**同步执行期**就
  // 对 `pool.listAllAccounts()` 求值，此时 storage 尚未接管，读到的只有 settings
  // 回退路径（或空表）—— `hasRefreshable` 恒为 false，**30 分钟续期定时器从未
  // 注册过**。故这里照抄下方自动签到的 `void pool.openStorage().then(...)` 模式，
  // 把「判据 + 注册」整体移进 then 链。
  //
  // ⚠️ **storage 就绪后要立即补跑一次 `refreshAllCredentials()`**：定时器的第一次
  // 触发要等满 30 分钟，而登录后长时间不关机的用户在此期间若凭据先过期，就会带着
  // 过期凭据发请求。立即补跑消除这 30 分钟空窗（与下方 Qoder 资料回填同因）。
  // 补跑同样先过判据：没有可续期账号时一次网都不出。
  void pool.openStorage().then(() => {
    const hasRefreshable = pool.listAllAccountsSnapshot().some(a => a.refreshable)
    if (!hasRefreshable) return
    // 立即补跑：失败只记日志，**绝不炸启动**（下面各服务的 refreshAll 内部已自吞
    // 单账号异常，这里只兜住意外抛出）。
    void refreshAllCredentials().catch((error: unknown) => {
      ctx.logger.warn(`[account-hub] 启动续期失败（不影响后续定时续期）：${String(error)}`)
    })
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
      qoderCn.stop()
    }, 'account-hub: multi-account refresh scheduler')
  }).catch((error: unknown) => {
    // 判据读取本身失败（异常 storage 形状等）：记日志并放弃注册定时器，
    // 绝不让它冒泡成 apply 的异常。
    ctx.logger.warn(`[account-hub] 续期调度注册失败，本次不做定时续期：${String(error)}`)
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddyCn.stop()
    buddy.stop()
    lobsterai.stop()
    traeCn.stop()
    qoder.stop()
    qoderCn.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== Qoder 存量账号资料回填（启动时一次） =====
  //
  // 上面的批量链每 30 分钟跑一趟已会回填，但**插件启动后要等 30 分钟**才轮到
  // 第一次 —— 用户装上新版、打开设置页，看到的仍是 UUID 昵称与「未知」有效期，
  // 会以为没修好。故这里在 storage 就绪后立刻跑一次。
  //
  // ⚠️ **必须等 `openStorage()`**：账号池在此之前只有内存降级副本（读不到
  // settings 里那几条真实账号），跑一次等于什么都没做，且**不会**自动重试
  // （判据是「条目里有什么」，空表 ⇒ 无待办 ⇒ 直接结束）。
  // fire-and-forget：不 await、不阻塞 apply 返回（与自动签到启动 sweep 同款）。
  void pool.openStorage().then(async () => {
    try {
      await qoder.backfillAccountProfiles(pool)
    } catch { /* 静默 */ }
    try {
      await qoderCn.backfillAccountProfiles(pool)
    } catch { /* 静默 */ }
  })

  // ===== 自动路由（聚合 provider）=====
  //
  // 聚合适配器与「配置面」的分工：配置（哪些自动模型、候选顺序）由用户在 Account Hub
  // 面板里改、落在池的 `autoRoute` 字段；本段负责把它接上 DSH 的模型目录与请求转发。
  //
  // 生命周期（注册 / 按开关休眠唤醒 / 运行时归位 / 内容幂等门）整段在
  // `createAutoRouteRegistration` 里，本段只做两件事：给出「读当前配置」这个来源，
  // 以及把它挂上启动链与 RPC 通知。
  //
  // ## 注册是**按需**的（与另外七个 register*Llm 的关键差别）
  //
  // 另外七个在 `apply()` 里一次性注册且永不撤销。自动路由不行：它默认**关着**，而
  // 一个注册着的 provider 即使 `listModels` 返回 `[]`，仍会出现在
  // `listProviders()` 里 —— 于是「关掉自动路由」并不能让它从 provider 列表里消失。
  // 故按开关**休眠/唤醒**（关着 = 零路由），细节见 `createAutoRouteRegistration`。
  //
  // ## 为什么配置来源是 `() => pool.autoRouteConfig()`
  //
  // 适配器的 `listModels` / `resolveModel` 每次现读，不做缓存 —— 用户改了自动模型，
  // 下一轮目录刷新就该看到，不存在「忘了重建」的窗口。运行时（降级队列）不能现读
  // （它有状态），故由刷新函数按**内容指纹**决定何时重建。
  const ensureAutoRouteRegistration = createAutoRouteRegistration(ctx, () => pool.autoRouteConfig())
  // 兜底：剥掉打到聚合模型的会话侧档位（详见 `installAutoRouteEffortGuard` 的说明）。
  // 挂在这里而不是适配器里，是因为宿主的档位校验发生在**适配器之前**（实测
  // `adapter.stream()` 根本不会被调用），`agent/request` 是唯一能改变校验前配置的
  // 可挂点。它**不依赖总开关**：注册一次即可，命中判据自带 provider 过滤。
  installAutoRouteEffortGuard(ctx)
  // 启动链：`openStorage()` 完成后调用（在那之前读到的是旧 settings 快照或空表，
  // 据此注册会把开关状态判错）。异步注册合法（`ctx.effect` 只要求 fiber 活着）。
  void pool.openStorage().then(() => {
    try {
      ensureAutoRouteRegistration()
    } catch (error: unknown) {
      ctx.logger.warn(`[account-hub] 自动路由注册失败（该功能本次不可用）：${String(error)}`)
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[account-hub] 自动路由启动注册未能等到 storage 就绪：${String(error)}`)
  })

  // ===== Account Hub RPC 注册 =====
  // 传参形态是**单一 options 对象**（见 `AccountHubRpcOptions`）：字段名与顺序无关，
  // 新增 provider 时只加字段、不再动签名（此前的 12 个位置实参每加一个 provider
  // 都要改签名与全部转发点）。其后的两个可选字段都是**按 provider 分派**的注册表：
  // - `contextTiers` 是窗口档位表（见 `ContextTierRegistry`），省略时 `model.list`
  //   不带窗口字段、`model.setContextBudget` 一律拒绝；
  // - `modelAdapters` 是适配器映射（见 `ModelCatalogSource`），省略时「显示列表」
  //   退化为「`listModels` 结果 + 黑名单裸 id 回填」的历史行为。
  // 两者都是 headless / 测试场景的既定降级。
  //
  // ## 键 = provider id（**不是**面板 id、不是池键）
  //
  // 与 `contextBudgets` 的存储分键同构。故：
  // - CodeArts / LobsterAI **刻意不在档位表里**：它们的目录根本没有窗口元数据，
  //   「无数据不显示」是铁律，不是漏接线。
  //
  // 用 `*.id` 而不是字面量：写死字面量在改名 / 多产品场景下会静默不匹配
  // （本插件在 workbuddy 改名上踩过同类坑）。
  //
  // ⚠️ 两个映射的键现由 `ProviderId` 联合（`src/types.ts`）约束，**键拼错在此处
  // 由 excess property check 直接报错**（`createContextTierRegistry` 的形参也已
  // 同步收窄）。注意只防「拼错」不防「漏登记」—— `Partial` 允许子集，漏登记由
  // `registerAccountHubRpc` 入口的运行时 warn 兜底。
  const contextTierRegistry = createContextTierRegistry({
    [TRAE_CN.id]: traeCnAdapter,
    [BUDDY_CN.id]: buddyCnAdapter,
    [BUDDY.id]: buddyAdapter,
    [QODER.id]: qoderAdapter,
    [QODER_CN.id]: qoderCnAdapter,
  })
  // provider → 适配器实例：Account Hub「显示列表」需要 `listAllModels()`
  // —— **不套用户黑名单、也不套目录门控**的完整目录（带最终展示名）。
  //
  // ⚠️ 与上面的档位注册表**不是同一件事，两处都要登记**：档位表只服务有窗口
  // 元数据的五个 provider（CodeArts / LobsterAI 刻意不在其中），而「显示列表」
  // 七个 provider **一个都不能少** —— 缺一个，那一个的关闭项就会退回裸 id，
  // 用户看到「关掉的模型没有倍率 / 没有人话名字」。
  //
  // ⚠️ 为什么必须由这里注入：DSH 的 `ctx.llm` 只保证 `listModels`（且会把条目
  // **重建**成 `{provider,id,name,description?,inputModalities?}`），自定义方法在
  // 那一层被丢掉，ctx 上也没有「按 provider 取适配器」的入口（与档位注册表同一
  // 制约，见 `src/account-hub-rpc.ts` 的 `ModelCatalogSource`）。
  //
  // 键取 `*.id` / 常量，别写字面量（理由同上）。
  // ⚠️ 注解必须是 `Partial<Record<ProviderId, …>>`（**不能**写宽成
  // `Record<string, …>`）：宽注解会让下面这个对象字面量在赋值处就被接受，
  // 拼错的键再也拿不到 excess property check —— 类型保护在传参前就失效了。
  const modelAdapters: Partial<Record<ProviderId, ModelCatalogSource>> = {
    [CODEARTS_PROVIDER]: codeartsAdapter,
    [BUDDY_CN.id]: buddyCnAdapter,
    [BUDDY.id]: buddyAdapter,
    [LOBSTERAI.id]: lobsteraiAdapter,
    [TRAE_CN.id]: traeCnAdapter,
    [QODER.id]: qoderAdapter,
    [QODER_CN.id]: qoderCnAdapter,
  }
  registerAccountHubRpc({
    ctx,
    pool,
    codearts: service,
    buddyCn,
    buddy,
    lobsterai,
    traeCn,
    qoder,
    qoderCn,
    contextTiers: contextTierRegistry,
    modelAdapters,
    // `autoroute.set` 成功后的配置变更通知 —— 让聚合适配器的降级队列与用户刚改的
    // 候选顺序归位（内容幂等，重复调用无副作用）。
    onAutoRouteChanged: ensureAutoRouteRegistration,
    updateDeps: createAccountHubUpdateDeps(import.meta.url),
  })
  ctx.provide('accountPool', pool)

  // ===== 自动签到 · 宿主触发层 =====
  // 进入 Hub 由客户端触发（见 auto-checkin-design.md §7，宿主不监听页面）。宿主只做
  // **启动 sweep** 与 **每 4 小时定时 sweep** 两件事，共同收口到模块级的
  // `performCheckinSweep`（RPC `checkin.sweep` case 与定时器共用同一入口；内部
  // `checkinBusy` 模块级互斥保证定时器、启动 sweep 与页面触发（`checkin.perform`）
  // 三路互不并发 —— 设计文档 §9）。
  const AUTO_CHECKIN_INTERVAL_MS = 4 * 60 * 60 * 1000
  const runAutoCheckinSweep = () => performCheckinSweep({ ctx, pool, lobsterai, qoder, qoderCn })

  // 启动后首次：等 storage 就绪。`openStorage` 是异步的、且幂等（重入直接返回已
  // resolve 的 Promise），sweep 的「读 checkins / 写今日」必须在它 return 之后才跑，
  // 否则会读到旧 settings/内存快照、写入落错通路 —— 顺序约束见设计文档 §4。
  // fire-and-forget：不 await、不阻塞 apply 返回；openStorage 内部已自吞异常并降级。
  void pool.openStorage().then(() => queueMicrotask(runAutoCheckinSweep))

  // 每 4 小时定时 sweep。`unref` 与 `ctx.effect` 登记清理与既有「多账号续期调度」
  // 同款形态（见上方 refreshAllCredentials 的定时器）；插件停用/重载时清掉定时器。
  const checkinTimer = setInterval(() => void runAutoCheckinSweep(), AUTO_CHECKIN_INTERVAL_MS)
  checkinTimer.unref?.()
  ctx.effect(() => () => {
    clearInterval(checkinTimer)
  }, 'account-hub: auto check-in scheduler')

  // ===== 消耗顺序 · 余额缓存刷新层 =====
  //
  // 「最高优先」档要在**请求热路径**上按余额排序，而余额查询是纯拉取、只活在 UI 里
  // （见 `src/account-consumption.ts` 的 `BalanceCache`）。故宿主侧维持一份内存缓存：
  // 启动后刷一次 + 每 4 小时刷一次，与签到 sweep 同节奏、同款定时器形态。
  //
  // ⚠️ **只刷配置了「最高优先」档的 provider**：刷新是逐账号一次网络请求，
  // 为没开那一档的 provider 白打请求纯属浪费与风控风险。过滤收在
  // `refreshConsumptionBalances` 内部（唯一实现），这里不重复判一次 ——
  // 两处判据迟早会漂移。
  //
  // 时序：必须在 `openStorage()` 之后（那之前读到的 `consumption` 是旧 settings
  // 快照或空表 ⇒ 一个 provider 都筛不出来，缓存永远是空的）。与签到 sweep 同一条
  // 约束，故同样挂在那个 Promise 上。
  const balanceDeps: ProviderBalancesDeps = { ctx, pool, qoder, qoderCn }
  // ⚠️ **间隔必须 < `BALANCE_CACHE_TTL_MS`（5h），留 1h 余量**：过期判据是
  // `now - fetchedAt >= TTL`，两者相等时刷新只要晚一拍（定时器抖动 / 单次查询失败）
  // 就会出现整段缓存空窗 —— 那段时间「最高优先」档静默降级回顺序档。
  const REFRESH_BALANCES_INTERVAL_MS = 4 * 60 * 60 * 1000
  const runBalanceRefresh = (): void => {
    // fire-and-forget：`refreshConsumptionBalances` 内部逐 provider 自吞异常，
    // 这里只兜住意外抛出，绝不让它冒泡成 unhandledRejection。
    void refreshConsumptionBalances(balanceDeps).catch((error: unknown) => {
      ctx.logger.warn(`[account-hub] 余额缓存刷新异常（最高优先档本次降级回顺序）：${String(error)}`)
    })
  }
  void pool.openStorage().then(() => queueMicrotask(runBalanceRefresh))
  const balanceTimer = setInterval(runBalanceRefresh, REFRESH_BALANCES_INTERVAL_MS)
  balanceTimer.unref?.()
  ctx.effect(() => () => {
    clearInterval(balanceTimer)
  }, 'account-hub: consumption balance cache scheduler')
}
