import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { QoderAuth } from './qoder-auth.js';
import { AccountPool } from './account-pool.js';
import type { LlmSettingsAddress, ProviderId } from './types.js';
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
        qoderCnAuth: QoderAuth;
    }
}
export declare const name = "codearts-auth";
export declare const inject: string[];
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
export declare const Config: Schema;
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
    providers?: Record<string, unknown>;
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
export type SettingsContract = 'legacy' | 'projection' | 'absent';
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
export declare function detectSettingsContract(ctx: Context): SettingsContract;
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
export declare function resolveSettingsEntryId(ctx: Context): string;
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
export declare function makeSettingsAddressResolver(contract: SettingsContract, entryId: string): (provider: ProviderId) => LlmSettingsAddress;
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
export declare function makeReadImage(ctx: Context): (attachment: unknown) => Promise<{
    data: Uint8Array;
    mediaType: string;
}>;
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
export declare function makeAccountPicker(pool: AccountPool | undefined, provider: string): (model?: string, turnIdentity?: unknown) => Promise<Awaited<ReturnType<AccountPool['getAvailableAccount']>>>;
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
export declare function makeCredentialResolver<T>(ctx: Context, pool: AccountPool | undefined, provider: string, fallbackRef: string): (model?: string, turnIdentity?: unknown) => Promise<T | undefined>;
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
export declare function makeAccountRefresher(pool: AccountPool | undefined, provider: string, service: {
    refresh: () => Promise<void>;
    refreshAccountCredential: (refName: string) => Promise<void>;
}): (model?: string, turnIdentity?: unknown) => Promise<void>;
/**
 * 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。
 *
 * @param ctx - 插件上下文。
 * @param config - 宿主按 {@link Config} 校验后的插件配置。本插件**不读**它
 *   （凭据一律由账号池解析），参数存在的意义是让 cordis 把本 entry 认成
 *   「有 Config 的插件」—— 0.1.7 的 settings 投影正是按 `runtime.Config` 取
 *   schema 的（见 {@link Config}）。省略时不报错（与宿主第一方同款可选形参）。
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map