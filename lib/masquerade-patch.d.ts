/**
 * Account Hub **客户端伪装补丁引擎**：对本机已安装的 `@deepseek-ai/dsh-llm-pi-ai`
 * 产物做一处极小、可自动维持、无配置时自动还原的文本补丁。
 *
 * 设计与全部实证见 `docs/agents/client-masquerade-design.md`（下称「设计稿」）。
 * 本模块只实现设计稿 §3（补丁设计）、§9.3（还原）与 §13 的拍板结论。
 *
 * ## 它补的是哪一段够不着的路
 *
 * 外部聚合网关（如 4router.net）的 `channel:codex_only` 渠道只服务「看起来像官方
 * Codex 客户端」的请求，判据是**出站身份**而非密钥。本插件的自动路由候选已经能覆写
 * `User-Agent` 与 `Originator`（`src/account-hub-user-agent.ts` /
 * `src/account-hub-originator.ts`），但那两个通道走的是**真实适配器自己的 `send()`**；
 * 在 `dsh-llm-pi-ai` 这条路上，`User-Agent` 被框架归属头**静默吃掉**（见下），
 * 于是必须改宿主适配器产物本身。
 *
 * ## 为什么必须打补丁（设计稿 §3.2）
 *
 * `dsh-llm-pi-ai/lib/index.js` 的 `requestHeaders(headers)` 先算出归属头
 * `attributionHeaders()`（实测 `{ 'user-agent': 'deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)' }`），
 * 把与归属头键名（大小写不敏感）冲突的 profile 项**过滤掉**，再把归属头铺在**最后**
 * —— 归属头赢。所以往 profile 里写 `user-agent` 是无效的：这是本设计必须存在补丁的
 * **唯一**原因（`originator` / `x-codex-window-id` 不在归属头键名集合里，本来就能透传）。
 *
 * ## 补丁形态：两段，同一文件（设计稿 §3.3）
 *
 * | 段 | 内容 |
 * |---|---|
 * | 段 1 | 调用点**包一层**：`headers: requestHeaders(profile.headers)` ⇒ `headers: <注入函数>(requestHeaders(profile.headers), options)` |
 * | 段 2 | 函数定义**追加到文件末尾**，用 marker + fence 围起来 |
 *
 * 段 1 选「包一层」而不是「后面加一行赋值」：`headers:` 是对象字面量的属性，后面没有
 * 语句边界可插赋值；包一层是**单行、单表达式**的最小改写，且 `requestHeaders(...)`
 * 的原调用**原样保留** ⇒ 基线头仍由原函数算出，与第三方 masquerade 的 UA 补丁
 * **天然叠加**（它的返回值喂给我们的函数）。
 *
 * 段 2 选「文件末尾追加」：模块顶层是语句边界、函数声明**提升**（调用点在前也合法）；
 * 追加**不需要锚点匹配**，少一处可能漂移的匹配点；还原 = 从末尾裁掉围栏块，判定简单。
 *
 * ## 锚点纪律（设计稿 §3.5，红线）
 *
 * **精确字面量匹配**；不匹配 ⇒ `throw`；**永远不做 `trim` / 正则 / 模糊匹配**。
 * 理由：模糊匹配在版本漂移时会「匹配到一个看起来差不多的位置」并写入 —— 那是最坏
 * 结果（文件被改坏且没人知道）。宁可功能不可用，也不产生半截补丁（G7）。
 *
 * ## 默认路径**零变化**
 *
 * 没有任何条目配置伪装头时本模块把文件还原成**逐字节等于打补丁前**的原厂形态；
 * 而注入函数在三字段全缺席时**原对象原样返回（同一引用）** ⇒ 出站请求逐字节一致。
 * 这是 AGENTS.md「出站协议值不随 provider id / 显示名变化」红线的延伸（G2 / G5）。
 *
 * @module dsh-account-hub/masquerade-patch
 */
/** 目标包名（设计稿 §3.1）。 */
export declare const MASQUERADE_TARGET_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";
/** 目标包入口（`package.json` 的 `"main"`）。 */
export declare const MASQUERADE_TARGET_ENTRY = "lib/index.js";
/** 注入函数名（设计稿 §2.1 架构图钉死的名字）。 */
export declare const MASQUERADE_INJECTED_FUNCTION = "__dshAccountHubApplyMasquerade";
/** 伪装头的头名（设计稿 §3.4 / §4.3）。 */
export declare const MASQUERADE_WINDOW_HEADER = "x-codex-window-id";
/**
 * 补丁块起始 marker 行（**逐字精确匹配**，幂等判据与还原配对都靠它）。
 *
 * 含 `dsh-account-hub` 是刻意的：第三方 `shabhui/dsh-client-masquerade` 也在同一文件
 * 里打补丁，两家的 marker 必须一眼可分（设计稿 §7.1 / §7.4）。
 */
export declare const MASQUERADE_PATCH_MARKER = "// >>> dsh-account-hub masquerade patch >>>";
/** 低频定时维持的间隔：5 分钟（设计稿 §3.8 触发点 ④ / §13 分叉 j）。 */
export declare const MASQUERADE_MAINTAIN_INTERVAL_MS: number;
/** 目标解析所需的两个来源（都可缺省，缺省即该候选不参与）。 */
export interface MasqueradeTargetLookup {
    /**
     * dsh home 路径解析器（宿主 `ctx.dshHomePath`）。
     *
     * 用它拼出**共享层**候选：`<dsh home>/profiles/node_modules/<包>/lib/index.js`。
     */
    dshHomePath?: (...segments: string[]) => string;
    /**
     * profile 根目录（`src/index.ts` 用既有 `resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')` 推出）。
     *
     * 用它拼出**profile 层**候选：`<profileRoot>/node_modules/<包>/lib/index.js`。
     * 该层在部分机器上并不存在（本机实测：profile 层只有 `dsh-account-hub` 自己），
     * 故它必须能与共享层**各自独立**命中，全缺 ⇒ `undefined`（设计稿 §3.5 第一行）。
     */
    profileRoot?: string;
}
/** 解析出的补丁目标。 */
export interface MasqueradePatchTarget {
    /** 目标文件绝对路径。 */
    file: string;
    /** 目标包版本（`package.json` 读不到则 `undefined` = 未知版本）。 */
    version?: string;
}
/**
 * 解析本机 `@deepseek-ai/dsh-llm-pi-ai` 的 `lib/index.js` 路径（设计稿 §3.1）。
 *
 * 两个候选依次 `existsSync`，先命中先用：
 *
 * 1. 共享层 `<dsh home>/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`；
 * 2. profile 层 `<profileRoot>/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`。
 *
 * **全缺 ⇒ 返回 `undefined`，不是错误**：说明该 profile 没装外部 provider 适配器，
 * 功能整体静默不可用（面板下拉置灰 + 提示），由调用方决定文案（设计稿 §3.5）。
 *
 * 刻意**不用 `require.resolve`**：本模块是插件自身的产物，`require.resolve` 会相对
 * 插件自己的安装位置解析，得到的是插件的依赖树而不是**运行中 profile** 的安装位置。
 *
 * ⚠️ v1 **不解析 `@earendil-works/pi-ai`**：本设计不写 pi-ai，它的路径只服务于
 * 「与第三方 masquerade 的共存检查」，不属本模块职责（设计稿 §3.1 第二张表）。
 */
export declare function resolvePatchedTarget(lookup?: MasqueradeTargetLookup): MasqueradePatchTarget | undefined;
/** `applyPatch()` 的结果。 */
export interface MasqueradeApplyResult {
    /** `patched` = 本次写入成功；`alreadyPatched` = 已在场且判据链全过，未重写。 */
    status: 'patched' | 'alreadyPatched';
    /** 目标文件绝对路径。 */
    target: string;
    /** 目标包当前版本（读不到则 `undefined`）。 */
    targetVersion?: string;
}
/**
 * 打补丁（设计稿 §3.3 + §3.6 + §9.2）。
 *
 * 判据链**顺序**（顺序本身是判据的一部分）：
 *
 * 1. 读文件 —— 文件不存在 ⇒ `readFileSync` 抛 `ENOENT`（**不是**静默创建，P10）；
 * 2. marker 在场 ⇒ 先按 §9.3 走一遍还原校验（fence 配对 + 注入字面量唯一命中）：
 *    - 记账版本 === 当前版本 ⇒ `alreadyPatched`，**不重写**（幂等，P4）；
 *    - 记账版本缺失或不同 ⇒ 视为未知/漂移版本，用还原后的原厂内容重新走第 3 步
 *      （设计稿 §9.2「版本号不同 ⇒ 先按新版本重新校验锚点」）；
 * 3. 原调用点字面量**必须唯一命中**（0 或 >1 ⇒ 抛错、不写，P2 / P3）；
 * 4. 末尾必须已有换行（否则追加会与最后一行粘连、还原无法逐字节复原）⇒ 否则抛错、不写；
 * 5. 临时文件 + `rename` 原子写回（`writeDetached`，P7 / P8 / P9）。
 *
 * 任何一步不过都**不写文件**，且原文件保持逐字节不变 —— 宁可功能不可用，也不产生
 * 半截补丁（G7 / R3）。
 */
export declare function applyPatch(target: string): MasqueradeApplyResult;
/** `revertPatch()` 的结果。 */
export interface MasqueradeRevertResult {
    /** `reverted` = 本次写回原厂形态；`alreadyStock` = 本就是原厂形态，未写。 */
    status: 'reverted' | 'alreadyStock';
    /** 目标文件绝对路径。 */
    target: string;
}
/**
 * 还原（设计稿 §9.3 四步）。
 *
 * 1. 读文件、找 fence 起止 —— **不配对 ⇒ 抛错、不写**（半截补丁是坏文件，P6）；
 * 2. 裁掉 fence 块（含 marker 行与版本记账行）；
 * 3. 把段 1 的调用点字面量改回原厂形态 —— **注入后的字面量找不到 ⇒ 抛错、不写**
 *    （可能被别的工具改过，P12）；
 * 4. 临时文件 + `rename` 写回。
 *
 * **幂等**：文件本就是原厂形态（marker 不在场）⇒ `alreadyStock`，一个字节都不写。
 *
 * **还原后逐字节等于打补丁前**：这条由单测钉住（P5）。
 *
 * 触发条件只有一条（设计稿 §9.3 / §13 分叉 f）：**没有任何条目配置伪装头**。
 * 不提供任何手动还原入口，UI 上也没有按钮。
 */
export declare function revertPatch(target: string): MasqueradeRevertResult;
/** `inspectPatch()` 的结果（面板徽标数据源）。 */
export interface MasqueradePatchInspection {
    /** 目标文件绝对路径。 */
    target: string;
    /** 原厂形态（marker 不在场）。 */
    stock: boolean;
    /** 两段补丁都在场、fence 配对、且调用点未被第三方改动。 */
    patched: boolean;
    /** 文件内出现补丁 marker 字符串（**未必**配对 —— 配对与否看 `patched` 与 `reason`）。 */
    markerPresent: boolean;
    /** 打补丁时记录的版本（读不到 = 未知版本）。 */
    recordedVersion?: string;
    /** 目标包当前版本。 */
    targetVersion?: string;
    /** `patched === false` 且 `markerPresent === true` 时的中文原因。 */
    reason?: string;
}
/**
 * 只读巡检（设计稿 §5.3 `masquerade.status` 的数据源）。
 *
 * **尽力而为、永不抛错**（与 `autoroute.model-info` 同款契约）：面板把异常显示成
 * 「加载失败」会误导用户 —— 状态查不出来和功能坏掉是两回事，故这里把判据链的失败
 * 收敛成 `reason` 文本。
 *
 * 注意「本方补丁在场」与「依赖的对方补丁在场」是两个**独立**状态（风险 R5）：
 * 本函数只回答前者，第三方 masquerade 的在场检测不在本模块职责内（§13 分叉 e
 * 明确不做任何第三方检测/引导）。
 */
export declare function inspectPatch(target: string): MasqueradePatchInspection;
/**
 * 「是否有任何条目配置了伪装头」——维持循环与还原的**同一个判据**（设计稿 §3.8 / §9.3）。
 *
 * 结构性读取：`config.models[].entries[].masquerade`。判定为「配了」需要
 * `masquerade` 是非空对象**且** `windowId` 是非空字符串 —— 与注入函数「会真的写出
 * `x-codex-window-id`」的条件逐字对齐，避免「打了补丁却一个头都不发」的空转。
 * （读路径的 `sanitizeAutoRouteConfig` 已经会丢掉脏值，这里是第二道自足防线。）
 */
export declare function masqueradeConfigured(config: unknown): boolean;
/** 维持循环结果状态。 */
export type MasqueradeMaintenanceStatus = 
/** 目标包不存在 ⇒ 功能静默不可用（不是错误）。 */
'unavailable'
/** 未配置伪装且文件本就是原厂形态 ⇒ 无事可做。 */
 | 'idle'
/** 未配置伪装且本次自动还原成功（G5）。 */
 | 'reverted'
/** 配置了伪装且本次写入成功。 */
 | 'patched'
/** 配置了伪装且补丁已在场，判据链全过。 */
 | 'alreadyPatched'
/** 判据链不过 ⇒ **未写**（R3），`reason` 给出中文原因。 */
 | 'failed';
/** 一次维持的结果。 */
export interface MasqueradeMaintenanceResult {
    status: MasqueradeMaintenanceStatus;
    /** 目标文件绝对路径（`unavailable` 时缺省）。 */
    target?: string;
    /** 目标包当前版本（读不到则 `undefined`）。 */
    targetVersion?: string;
    /** 中文原因（`failed` 时必有）。 */
    reason?: string;
}
/** 维持循环的依赖面（最小面，便于单测注入假对象）。 */
export interface MasqueradeMaintenanceDeps {
    /** 宿主 `ctx.dshHomePath`。 */
    dshHomePath?: (...segments: string[]) => string;
    /** profile 根目录。 */
    profileRoot?: string;
    /** 读当前自动路由配置（`pool.autoRouteConfig()`）。 */
    readAutoRouteConfig: () => unknown;
    /** 日志（缺省静默）。 */
    logger?: MasqueradeLogger;
    /**
     * fiber 生命周期挂钩（`ctx.effect`）。
     *
     * 缺省 = **不装定时器**（单测只跑单次维持，不引入真实定时器）。
     */
    effect?: (setup: () => () => void, label: string) => void;
    /** 定时器间隔（毫秒）；缺省 {@link MASQUERADE_MAINTAIN_INTERVAL_MS}。 */
    intervalMs?: number;
}
/** 日志最小面（`ctx.logger` 结构兼容）。 */
export interface MasqueradeLogger {
    warn(message: string): void;
}
/**
 * **单次**维持（设计稿 §3.8 判据链）—— 启动 / 面板打开 / 保存配置三处都调它。
 *
 * 判据链每次**完整重走**，绝不因为「上次打过」就跳过校验（R3 的缓解措施）：
 *
 * ```
 * 有无任何条目配伪装头？
 *   ├─ 无 ⇒ 若补丁在场则执行 §9.3 还原四步（G5）；否则 idle
 *   └─ 有 ⇒ 完整判据链（marker → fence 配对 → 锚点唯一命中 → 写入）
 * ```
 *
 * 任一判据不过 ⇒ **报错、不写**，返回 `failed` + 中文原因（面板红色徽标 / 日志 warn）。
 * 「维持」不等于「盲目重写」。
 */
export declare function runMasqueradeMaintenance(deps: MasqueradeMaintenanceDeps): MasqueradeMaintenanceResult;
/**
 * 装维持循环（设计稿 §3.8 触发点 ① 与 ④ / §13 分叉 j）。
 *
 * - **立刻跑一次**（插件启动检查点；调用方须保证此时 `pool.openStorage()` 已完成，
 *   否则读到的开关状态可能是错的 —— 既有教训见 `docs/agents/auto-route-runtime.md` §5）；
 * - 装了 `effect` 时再挂一个 **5 分钟**定时器覆盖 S1/S3 这类「用户不在面板上」的静默
 *   失效，并用 `ctx.effect` 管生命周期（fiber 销毁即 `clearInterval`，与既有
 *   「自动签到」「余额缓存」两个定时器同款）；`unref()` 避免拖住进程退出。
 *
 * 触发点 ②（面板打开）与 ③（保存配置）由调用方直接调
 * {@link runMasqueradeMaintenance}，本函数不重复装钩子。
 */
export declare function maintainPatches(deps: MasqueradeMaintenanceDeps): void;
//# sourceMappingURL=masquerade-patch.d.ts.map