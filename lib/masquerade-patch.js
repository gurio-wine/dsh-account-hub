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
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
/** 目标包名（设计稿 §3.1）。 */
export const MASQUERADE_TARGET_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai';
/** 目标包入口（`package.json` 的 `"main"`）。 */
export const MASQUERADE_TARGET_ENTRY = 'lib/index.js';
/** 注入函数名（设计稿 §2.1 架构图钉死的名字）。 */
export const MASQUERADE_INJECTED_FUNCTION = '__dshAccountHubApplyMasquerade';
/** 伪装头的头名（设计稿 §3.4 / §4.3）。 */
export const MASQUERADE_WINDOW_HEADER = 'x-codex-window-id';
/**
 * 补丁块起始 marker 行（**逐字精确匹配**，幂等判据与还原配对都靠它）。
 *
 * 含 `dsh-account-hub` 是刻意的：第三方 `shabhui/dsh-client-masquerade` 也在同一文件
 * 里打补丁，两家的 marker 必须一眼可分（设计稿 §7.1 / §7.4）。
 */
export const MASQUERADE_PATCH_MARKER = '// >>> dsh-account-hub masquerade patch >>>';
/** 补丁块结束 marker 行。 */
const PATCH_MARKER_END = '// <<< dsh-account-hub masquerade patch <<<';
/** 补丁块起始 fence 行（还原时按它配对裁剪；不配对 ⇒ 抛错、不写）。 */
const PATCH_FENCE_START = '// --- dsh-account-hub masquerade fence start ---';
/** 补丁块结束 fence 行。 */
const PATCH_FENCE_END = '// --- dsh-account-hub masquerade fence end ---';
/**
 * 版本记账行前缀（设计稿 §9.2）。
 *
 * 该行缺失 ⇒ 视为「未知版本」⇒ 走「按新版本重新校验锚点」分支（见 P11）。
 */
const PATCH_VERSION_PREFIX = '// dsh-account-hub target-version: ';
/**
 * 段 1 的**原**调用点字面量（实测全文唯一命中：1 hit，5 前导 Tab，45 字节）。
 *
 * 逐字写死，不拼装 —— 拼接出来的字面量一旦差一个 Tab，锚点就永远零命中，而症状
 * 只是「功能不可用」，很难归因。
 */
const ANCHOR_ORIGINAL = '\t\t\t\t\theaders: requestHeaders(profile.headers)';
/** 段 1 的**注入后**调用点字面量（还原时按它判定「补丁在场且未被子三方改动」）。 */
const ANCHOR_INJECTED = `\t\t\t\t\theaders: ${MASQUERADE_INJECTED_FUNCTION}(requestHeaders(profile.headers), options)`;
/**
 * 补丁**残留**的哨兵串（任一在场即认为文件里有我们的东西）。
 *
 * 为什么不能只认 {@link MASQUERADE_PATCH_MARKER} 一行：半截补丁的典型形态恰恰是
 * 「起始 marker 那行被删了、其余还在」。若只认起始 marker，这种文件会被判成**原厂形态**
 * ⇒ 维持循环走 `alreadyStock`（静默放过一个坏文件），而重新打补丁时又会「往半截补丁上
 * 再叠一层」。四个围栏串 + 注入函数名全都算哨兵，才能把「有残留」与「无残留」分清。
 */
const PATCH_SENTINELS = [
    MASQUERADE_PATCH_MARKER,
    PATCH_MARKER_END,
    PATCH_FENCE_START,
    PATCH_FENCE_END,
    MASQUERADE_INJECTED_FUNCTION,
];
/** 文件里是否有本方补丁的任何残留（**不代表**补丁完整 —— 完整性由 `revertPatchContent` 判）。 */
function hasPatchResidue(content) {
    return PATCH_SENTINELS.some(sentinel => content.includes(sentinel));
}
/**
 * 注入函数的源码（**零 import、零外部依赖**，设计稿 §3.3 纪律）。
 *
 * 该文件是 rollup 产物，插入新 import 会破坏打包假设；函数体只用参数与标准库。
 *
 * 语义（设计稿 §3.4）：
 *
 * | 载体字段（结构性读取） | 动作 | 缺省行为 |
 * |---|---|---|
 * | `options.accountHubUserAgent` | 删掉所有 `user-agent` 异形键后写 `headers['User-Agent']` | 不动（保留归属头，或 masquerade 覆盖后的值） |
 * | `options.accountHubOriginator` | 删掉所有 `originator` 异形键后写 `headers['Originator']` | 不动（该头本就不存在） |
 * | `options.accountHubMasquerade` | 按枚举字段写 `x-codex-window-id` | 不动 |
 * | 三者**全部**缺席 | **原对象原样返回（同一引用）** | 出站逐字节一致 |
 *
 * 两条纪律写进代码里：
 *
 * - **不做「任意头」**：`accountHubMasquerade` 是命名枚举对象（`{ windowId }`），
 *   不是 `Record<string, string>`；
 * - **异形键清理必须做**：`User-Agent` 与 `user-agent` 同时存在会变成同一次请求里
 *   两个头，上游看到拼接值 —— 与 `applyAccountHubUserAgent` 的既有做法逐字对齐。
 *
 * **不 try/catch**：纯字符串拼接，抛错即代码缺陷，应暴露（设计稿 §3.4）。
 *
 * 校验只做**最小防御**（非空字符串即用）：合法性判据的唯一真相源在
 * `src/account-hub-user-agent.ts` / `src/account-hub-originator.ts`，而本函数是宿主侧
 * 的**裸函数**、无法 import 插件模块。分工与七个适配器 `send()` 的既有分工一致
 * —— 合法性由**写路径**（`assertValidAutoRouteConfig`）负责。
 */
const INJECTED_FUNCTION_SOURCE = `function ${MASQUERADE_INJECTED_FUNCTION}(headers, options) {
  const text = (value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const source = options !== null && typeof options === "object" ? options : {};
  const userAgent = text(source.accountHubUserAgent);
  const originator = text(source.accountHubOriginator);
  const masquerade = source.accountHubMasquerade;
  const windowId =
    masquerade !== null && typeof masquerade === "object" ? text(masquerade.windowId) : undefined;
  if (userAgent === undefined && originator === undefined && windowId === undefined) return headers;
  const result = { ...headers };
  const put = (name, value) => {
    const lower = name.toLowerCase();
    for (const key of Object.keys(result)) {
      if (key !== name && key.toLowerCase() === lower) delete result[key];
    }
    result[name] = value;
  };
  if (userAgent !== undefined) put("User-Agent", userAgent);
  if (originator !== undefined) put("Originator", originator);
  if (windowId !== undefined) put("${MASQUERADE_WINDOW_HEADER}", windowId);
  return result;
}
`;
/** 低频定时维持的间隔：5 分钟（设计稿 §3.8 触发点 ④ / §13 分叉 j）。 */
export const MASQUERADE_MAINTAIN_INTERVAL_MS = 5 * 60 * 1000;
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
export function resolvePatchedTarget(lookup = {}) {
    for (const file of candidateTargetFiles(lookup)) {
        if (existsSync(file))
            return { file, version: readTargetVersion(file) };
    }
    return undefined;
}
/** 两个候选路径（顺序即优先级；不可用的来源直接跳过）。 */
function candidateTargetFiles(lookup) {
    const files = [];
    if (lookup.dshHomePath !== undefined) {
        try {
            files.push(lookup.dshHomePath('profiles', 'node_modules', ...MASQUERADE_TARGET_PACKAGE.split('/'), ...MASQUERADE_TARGET_ENTRY.split('/')));
        }
        catch {
            // 宿主解析器抛错（配置非法等）不该让整个功能炸掉：该候选视为不存在。
        }
    }
    if (lookup.profileRoot !== undefined) {
        files.push(join(lookup.profileRoot, 'node_modules', ...MASQUERADE_TARGET_PACKAGE.split('/'), ...MASQUERADE_TARGET_ENTRY.split('/')));
    }
    return files;
}
/** 读目标包版本（`lib/index.js` 的同包 `package.json`）。读不到 ⇒ `undefined`。 */
function readTargetVersion(file) {
    try {
        const raw = readFileSync(join(dirname(file), '..', 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object')
            return undefined;
        const version = parsed.version;
        return typeof version === 'string' && version.length > 0 ? version : undefined;
    }
    catch {
        return undefined;
    }
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
export function applyPatch(target) {
    const targetVersion = readTargetVersion(target);
    const original = readFileSync(target, 'utf8');
    let content = original;
    if (hasPatchResidue(content)) {
        // 有残留就**必须**走一遍完整还原校验：残留可能是完整的补丁（正常幂等路径），也可能
        // 是「起始 marker 被删掉」的半截补丁 —— 后者在 revertPatchContent 里因 fence 不配对
        // 而抛错，于是本次维持**不写文件**并报错，而不是往半截补丁上再叠一层。
        const reverted = revertPatchContent(content);
        // 幂等只在「记账版本 === 当前版本」时成立；两者任一缺失 ⇒ 视为未知版本，走重新校验锚点
        // 的分支（设计稿 §9.2：marker 在场但版本记账缺失 ⇒ 按未知版本重新校验锚点，P11）。
        // 注意不能写成 `readRecordedVersion(content) === targetVersion`：两个 undefined 相等会
        // 让「版本读不出来」被误判成「版本一致」，从而跳过一次本该做的锚点校验。
        const recordedVersion = readRecordedVersion(content);
        if (recordedVersion !== undefined && targetVersion !== undefined && recordedVersion === targetVersion) {
            return { status: 'alreadyPatched', target, targetVersion };
        }
        content = reverted;
    }
    const patched = patchContent(content, targetVersion);
    writeDetached(target, patched, original);
    return { status: 'patched', target, targetVersion };
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
export function revertPatch(target) {
    const content = readFileSync(target, 'utf8');
    if (!hasPatchResidue(content)) {
        return { status: 'alreadyStock', target };
    }
    // 有残留就走还原校验：完整补丁 ⇒ 正常裁剪；半截补丁（起始 marker 被删等）⇒
    // `revertPatchContent` 因 fence 不配对抛错 ⇒ 本次**不写**并报错（P6）。
    writeDetached(target, revertPatchContent(content), content);
    return { status: 'reverted', target };
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
export function inspectPatch(target) {
    const targetVersion = readTargetVersion(target);
    let content;
    try {
        content = readFileSync(target, 'utf8');
    }
    catch (error) {
        return { target, stock: false, patched: false, markerPresent: false, targetVersion, reason: describe(error) };
    }
    // `markerPresent` 按设计稿语义只回答「起始 marker 行在不在」（面板据此区分
    // 「从没打过」与「打过但被改了」）；但**判定是否原厂**必须看全部残留哨兵：
    // 只删掉起始 marker 一行的半截补丁若被判成 `stock: true`，面板会显示绿色「未打补丁」，
    // 而维持循环也会走 `alreadyStock` 静默放过那个坏文件。
    const markerPresent = content.includes(MASQUERADE_PATCH_MARKER);
    if (!hasPatchResidue(content)) {
        return { target, stock: true, patched: false, markerPresent: false, targetVersion };
    }
    const recordedVersion = readRecordedVersion(content);
    try {
        revertPatchContent(content);
    }
    catch (error) {
        return { target, stock: false, patched: false, markerPresent, recordedVersion, targetVersion, reason: describe(error) };
    }
    return { target, stock: false, patched: true, markerPresent, recordedVersion, targetVersion };
}
/**
 * 「是否有任何条目配置了伪装头」——维持循环与还原的**同一个判据**（设计稿 §3.8 / §9.3）。
 *
 * 结构性读取：`config.models[].entries[].masquerade`。判定为「配了」需要
 * `masquerade` 是非空对象**且** `windowId` 是非空字符串 —— 与注入函数「会真的写出
 * `x-codex-window-id`」的条件逐字对齐，避免「打了补丁却一个头都不发」的空转。
 * （读路径的 `sanitizeAutoRouteConfig` 已经会丢掉脏值，这里是第二道自足防线。）
 */
export function masqueradeConfigured(config) {
    if (config === null || typeof config !== 'object')
        return false;
    const models = config.models;
    if (!Array.isArray(models))
        return false;
    for (const model of models) {
        if (model === null || typeof model !== 'object')
            continue;
        const entries = model.entries;
        if (!Array.isArray(entries))
            continue;
        for (const entry of entries) {
            if (entry === null || typeof entry !== 'object')
                continue;
            const masquerade = entry.masquerade;
            if (masquerade === null || typeof masquerade !== 'object')
                continue;
            const windowId = masquerade.windowId;
            if (typeof windowId === 'string' && windowId.trim().length > 0)
                return true;
        }
    }
    return false;
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
export function runMasqueradeMaintenance(deps) {
    const target = resolvePatchedTarget({ dshHomePath: deps.dshHomePath, profileRoot: deps.profileRoot });
    if (target === undefined)
        return { status: 'unavailable' };
    const configured = masqueradeConfigured(safeReadConfig(deps));
    try {
        if (!configured) {
            const result = revertPatch(target.file);
            return {
                status: result.status === 'reverted' ? 'reverted' : 'idle',
                target: target.file,
                targetVersion: target.version,
            };
        }
        const result = applyPatch(target.file);
        return { status: result.status, target: target.file, targetVersion: result.targetVersion };
    }
    catch (error) {
        const reason = describe(error);
        deps.logger?.warn(`[account-hub] 客户端伪装补丁维持失败（未写入文件）：${reason}`);
        return { status: 'failed', target: target.file, targetVersion: target.version, reason };
    }
}
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
export function maintainPatches(deps) {
    report(deps, runMasqueradeMaintenance(deps));
    if (deps.effect === undefined)
        return;
    const intervalMs = deps.intervalMs ?? MASQUERADE_MAINTAIN_INTERVAL_MS;
    if (intervalMs <= 0)
        return;
    const timer = setInterval(() => report(deps, runMasqueradeMaintenance(deps)), intervalMs);
    timer.unref?.();
    deps.effect(() => () => {
        clearInterval(timer);
    }, 'account-hub: client masquerade patch maintainer');
}
/** 把非成功状态播报到日志（成功路径静默，避免每 5 分钟刷一条噪音）。 */
function report(deps, result) {
    if (result.status === 'failed') {
        // 失败原因已在 runMasqueradeMaintenance 里报过一次，这里只兜底未带 reason 的形态。
        if (result.reason === undefined)
            deps.logger?.warn('[account-hub] 客户端伪装补丁维持失败（未写入文件）');
        return;
    }
    if (result.status === 'reverted') {
        deps.logger?.warn(`[account-hub] 已无候选配置伪装头，客户端伪装补丁已自动还原：${result.target ?? ''}`);
    }
}
/** 读配置失败不该让维持循环炸掉（降级到「没有配置」= 走还原分支，最保守）。 */
function safeReadConfig(deps) {
    try {
        return deps.readAutoRouteConfig();
    }
    catch (error) {
        deps.logger?.warn(`[account-hub] 读取自动路由配置失败，伪装补丁按「未配置」处置：${describe(error)}`);
        return undefined;
    }
}
/** 段 1 包一层 + 段 2 追加围栏块。 */
function patchContent(content, version) {
    const lines = content.split('\n');
    const hits = locateLines(lines, ANCHOR_ORIGINAL);
    if (hits.length === 0) {
        throw new Error(`目标文件版本不匹配：调用点锚点零命中（期望 1 处，实际 0 处）⇒ 未写入。` +
            `请升级 dsh-account-hub 到支持该版本的最新版（目标版本 ${version ?? '未知'}）`);
    }
    if (hits.length > 1) {
        throw new Error(`目标文件版本不匹配：调用点锚点多次命中（期望 1 处，实际 ${hits.length} 处）⇒ 未写入。` +
            `该行已不是唯一调用点，包一层会漏改其余位置（目标版本 ${version ?? '未知'}）`);
    }
    if (!content.endsWith('\n')) {
        throw new Error('目标文件末尾没有换行，形态与实测基线不符 ⇒ 未写入（追加会与最后一行粘连，还原无法逐字节复原）');
    }
    // 按**行号**改写，不用 `String.replace`：后者替换的是**首个子串**命中，若文件里存在
    // 一行「注释掉的旧调用点」而唯一整行命中在别处，就会改错行（§3.5 锚点纪律）。
    lines[hits[0]] = ANCHOR_INJECTED;
    return lines.join('\n') + renderInjectedBlock(version);
}
/** 段 2 的完整文本（marker 起 / 版本记账 / fence 起 / 函数 / fence 止 / marker 止）。 */
function renderInjectedBlock(version) {
    const versionLine = version === undefined ? '' : `${PATCH_VERSION_PREFIX}${version}\n`;
    return (`${MASQUERADE_PATCH_MARKER}\n` +
        versionLine +
        `${PATCH_FENCE_START}\n` +
        INJECTED_FUNCTION_SOURCE +
        `${PATCH_FENCE_END}\n` +
        `${PATCH_MARKER_END}\n`);
}
/**
 * 还原的**纯文本**部分（§9.3 前三步），不落盘 —— `applyPatch` 的版本漂移分支也要用。
 *
 * 校验顺序即失败顺序：fence 四行**各恰好一行**且顺序正确、块必须在文件**末尾**
 * （块后面还有内容 ⇒ 说明被别的工具动过，不敢裁）、**围栏块之前的正文**里注入字面量
 * 恰好一处、原字面量恰好零处。任一不过 ⇒ 抛错，调用方**不写文件**。
 *
 * ⚠️ 段 1 在围栏块**之前**（补丁块是追加到文件末尾的），所以还原必须「取前缀 → 改回
 * 原字面量 → 丢掉后缀」，而不是「在围栏块里找字面量」——后者会把整份正文切掉。
 */
function revertPatchContent(content) {
    const lines = content.split('\n');
    const locate = (literal) => {
        const found = [];
        for (let index = 0; index < lines.length; index += 1) {
            if (lines[index] === literal)
                found.push(index);
        }
        return found;
    };
    const markerStarts = locate(MASQUERADE_PATCH_MARKER);
    const markerEnds = locate(PATCH_MARKER_END);
    const fenceStarts = locate(PATCH_FENCE_START);
    const fenceEnds = locate(PATCH_FENCE_END);
    if (markerStarts.length !== 1 ||
        markerEnds.length !== 1 ||
        fenceStarts.length !== 1 ||
        fenceEnds.length !== 1) {
        throw new Error('补丁围栏不配对（marker / fence 行不是各恰好一行）⇒ 未写入。请先还原再重打：' +
            `marker 起 ${markerStarts.length} 处、fence 起 ${fenceStarts.length} 处、` +
            `fence 止 ${fenceEnds.length} 处、marker 止 ${markerEnds.length} 处`);
    }
    const [markerStart] = markerStarts;
    const [markerEnd] = markerEnds;
    const [fenceStart] = fenceStarts;
    const [fenceEnd] = fenceEnds;
    if (!(markerStart < fenceStart && fenceStart < fenceEnd && fenceEnd < markerEnd)) {
        throw new Error('补丁围栏顺序错乱（marker 起 → fence 起 → fence 止 → marker 止）⇒ 未写入');
    }
    // 文件以 `\n` 结尾 ⇒ `split('\n')` 的最后一格是空串，最后一行真实内容在 length - 2。
    if (markerEnd !== lines.length - 2) {
        throw new Error('补丁块不在文件末尾（其后方还有内容，可能被其它工具改动）⇒ 未写入');
    }
    // 段 1 的判据同样是**整行**匹配，不是子串：`ANCHOR_INJECTED + ' /* 改过 */'` 这类
    // 第三方改动含注入字面量为子串，子串判据会放行并用 `replace` 改掉那一行的一半，
    // 结果是「报告还原成功、文件却是第三种写法」。整行匹配让这种形态直接抛错。
    const injectedLines = locateLines(lines, ANCHOR_INJECTED).filter(index => index < markerStart);
    if (injectedLines.length !== 1) {
        throw new Error(`找不到注入后的调用点字面量（期望 1 处，实际 ${injectedLines.length} 处）⇒ 未写入。` +
            '该行可能已被其它工具改过，请手工核对该文件');
    }
    const originalLines = locateLines(lines, ANCHOR_ORIGINAL).filter(index => index < markerStart);
    if (originalLines.length !== 0) {
        throw new Error(`裁掉补丁块后仍存在原调用点字面量（${originalLines.length} 处）⇒ 未写入。` +
            '该文件处于半截补丁形态，请手工核对该文件');
    }
    // 只取到 marker 行首，围栏块（含 marker 行本身）整段丢弃；段 1 在 marker 之前。
    // 末尾补回 `\n`：原厂产物以换行结尾，`slice(0, markerStart)` 对应的正是「最后一行
    // 内容 + 换行」，漏掉它会让还原结果比打补丁前**少一个字节**（P5 的逐字节断言会红）。
    lines.length = markerStart;
    lines[injectedLines[0]] = ANCHOR_ORIGINAL;
    return `${lines.join('\n')}\n`;
}
/** 整行精确命中的行号列表（**不做** trim / 正则 —— 锚点纪律，设计稿 §3.5）。 */
function locateLines(lines, literal) {
    const found = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index] === literal)
            found.push(index);
    }
    return found;
}
/** 读出补丁块里记录的版本（设计稿 §9.2）；缺失或空串 ⇒ `undefined` = 未知版本。 */
function readRecordedVersion(content) {
    for (const line of content.split('\n')) {
        if (line.startsWith(PATCH_VERSION_PREFIX)) {
            const value = line.slice(PATCH_VERSION_PREFIX.length).trim();
            return value.length > 0 ? value : undefined;
        }
    }
    return undefined;
}
/**
 * 原子写回（设计稿 §3.6 五步）—— 临时文件 + `rename`，**不用** `writeFileSync(target)`。
 *
 * | 步骤 | 动作 | 为什么 |
 * |---|---|---|
 * | 0 | 重读目标文件，与本次读到的内容比对 | 与第三方伪装插件同时维持时（风险 R4）把静默丢改动变成可见失败 |
 * | 1 | 在**同目录**建临时文件 `<名>.dshcm-<uuid>.tmp` | 同目录才能保证 `rename` 是**同卷原子操作** |
 * | 2 | 打开标志 `'wx'`（独占创建） | 防止撞上残留临时文件而静默覆写 |
 * | 3 | 权限位**继承原文件** | 保持可执行位/只读位一致 |
 * | 4 | `renameSync(tmp, target)` | 原子替换；**顺带与 pnpm store 硬链接分离** |
 * | 5 | `finally` 删临时文件，容忍 ENOENT | 成功路径下临时文件已被 rename 走，删它必 ENOENT —— 正常路径 |
 *
 * 为什么必须这样（实测）：直接写会把**半截内容**暴露给正在运行的 DSH 进程；且如果
 * 目标是硬链接，直接写会**污染 pnpm store 里的原件**（实测 `writeFileSync` 会写穿，
 * `rename` 则分离副本、不动原件）。
 *
 * 权限位在第 4 步**之前**才继承（不是创建时）：Windows 上只读文件删不掉，若临时文件
 * 从一开始就带只读位，写失败时清理会留下残留（P8）。清理前先松掉只读位同理。
 */
function writeDetached(target, content, expected) {
    // 步骤 0：落盘前重读一次，与本次判据链所依据的内容比对。第三方伪装插件也在同一文件
    // 上做「读 → 改 → 临时文件 + rename」，两边同时维持时后写者会静默吃掉先写者的改动
    // （风险 R4）。这里把「静默丢改动」变成一次可见失败：宁可报错不写，也不覆盖别人的补丁。
    const current = readFileSync(target, 'utf8');
    if (current !== expected) {
        throw new Error('目标文件在本次读取后被其它进程改动过（疑似第三方伪装插件同时维持）⇒ 未写入，请稍后重试');
    }
    const temp = join(dirname(target), `${basename(target)}.dshcm-${randomUUID()}.tmp`);
    let mode;
    try {
        mode = statSync(target).mode & 0o777;
    }
    catch {
        mode = undefined;
    }
    try {
        const handle = openSync(temp, 'wx');
        try {
            writeFileSync(handle, content, 'utf8');
        }
        finally {
            closeSync(handle);
        }
        if (mode !== undefined)
            chmodSync(temp, mode);
        renameSync(temp, target);
    }
    finally {
        // 成功路径下临时文件已被 rename 走，删它必然 ENOENT —— 那是正常路径，不是错误。
        // 其余清理失败（杀软占用等）同样不覆盖正在抛出的原始错误：写入失败的原因更值得暴露。
        try {
            chmodSync(temp, 0o666);
        }
        catch {
            // 文件不存在（成功路径）或无权改 —— 交给 unlink 决定。
        }
        try {
            unlinkSync(temp);
        }
        catch {
            // 见上。
        }
    }
}
/** 把任意异常收敛成一句中文原因（`Error` 之外的抛出物也要有可读文本）。 */
function describe(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=masquerade-patch.js.map