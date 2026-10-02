/**
 * 账号池的 **storage 域持久层**（`ctx.storage.domain`）。
 *
 * ## 为什么从 `ctx.settings` 搬到这里
 *
 * 0.1.6 的账号索引存在 settings namespace `jet-hub` 里（`~/.dsh/settings.yaml`）。
 * 0.1.7 把 `ctx.settings.register(ns, schema) → owner scope` 整套 seam **删除**了，
 * 换成「插件读自己 Config 的 volatile 字段 + 用 `ctx.configEditor.edit()` 写」——
 * 插件在新版下走优雅降级分支，于是**不抛错、静默全空**，用户看到「所有账号消失」。
 *
 * 更根本的是语义：账号列表是**动态数据**（会增删、含限流时间戳），塞进 profile 的
 * `cordis.patch.yml` 属于把「数据」写成「配置」。storage 域才是给动态数据的正规落点，
 * 且三件套（`dsh-storage` / `dsh-storage-json` root=`dshHomePath('storages')` /
 * `dsh-storage-domain`）在 0.1.6 与 0.1.7 的 base patch 里**逐字一致**，两版通吃。
 *
 * ## 布局选型：single 布局 + 一个 global 单例文档
 *
 * 账号池的数据量小（十几个账号）且**整体读写**（见 `AccountPool` 的五件套互带），
 * 用 `per-record` 表反而要把「一次原子的整体替换」拆成多次记录写入。故域声明里
 * **不声明任何表**，只用一个 global 单例文档承接五件套 —— 一次 `set` 就是一次整体落盘，
 * 落盘形态是 `$DSH_HOME/storages/<域>.json`。
 *
 * ## 域名为什么带下划线
 *
 * storage 后端在 `open` 时按 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 校验域名，
 * 不匹配直接以 `malformed-medium` 拒绝。插件 id 是 `dsh-account-hub`（带连字符），
 * 而**连字符不是合法域名字符**，故域名为 `dsh_account_hub` —— 两者刻意不是同一个字符串，
 * 不要为了「统一」把连字符塞进来。
 *
 * @module dsh-account-hub/account-hub-storage
 */
import { sanitizeConsumption, sanitizeConsumptionCursors } from './account-consumption.js';
import { sanitizeAutoRouteConfig } from './auto-route.js';
import { normalizeCheckinValue } from './checkin-schedule.js';
/**
 * storage 域名。**必须匹配 `UNIT_NAME_RE`**（见模块头「域名为什么带下划线」）。
 *
 * 落盘路径：`$DSH_HOME/storages/dsh_account_hub.json`。
 */
export const ACCOUNT_HUB_DOMAIN = 'dsh_account_hub';
/**
 * 域格式版本号。
 *
 * 与 {@link AccountHubDocument.schemaVersion} **不是一回事**，不要合并：
 * - 本常量是 storage 后端校验的**文件格式版本**，改结构时提升，后端按它拒绝旧文件；
 * - `schemaVersion` 是**业务数据版本**（provider 改名迁移的一次性闸门），存在文档内部。
 */
export const ACCOUNT_HUB_DOMAIN_VERSION = 1;
/**
 * 空文档。每次都返回新对象 —— 共享引用会被写入方就地改坏。
 *
 * ⚠️ `autoRoute` 经 {@link sanitizeAutoRouteConfig} 构造而不是直接引用
 * `DEFAULT_AUTO_ROUTE_CONFIG`：那个常量是**深冻结**的（防全局缺省被就地改写），
 * 而文档是「读 → 改 → 整体 replace」的可变载荷，把冻结对象塞进去会让下游
 * 的写入当场抛 `TypeError`。sanitize 每次都返回全新的可写副本。
 */
export function emptyAccountHubDocument() {
    return {
        accounts: [],
        disabledModels: {},
        contextBudgets: {},
        checkins: {},
        consumption: {},
        consumptionCursors: {},
        autoRoute: sanitizeAutoRouteConfig(undefined),
        schemaVersion: 0,
        providerAuditVersion: 0,
    };
}
/** 把任意外部值归一化为黑名单（同既有 `sanitizeDisabledModels` 的口径）。 */
function sanitizeDisabledModels(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const result = {};
    for (const [provider, value] of Object.entries(raw)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const perProvider = {};
        for (const [modelId, flag] of Object.entries(value)) {
            // 只把显式 true 视为「关闭」；false 既不隐藏也不写回，避免判定与磁盘内容分歧。
            if (flag === true)
                perProvider[modelId] = true;
        }
        if (Object.keys(perProvider).length > 0)
            result[provider] = perProvider;
    }
    return result;
}
/** 把任意外部值归一化为上下文预算（同既有 `sanitizeContextBudgets` 的口径）。 */
function sanitizeContextBudgets(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const result = {};
    for (const [provider, value] of Object.entries(raw)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            continue;
        const perProvider = {};
        for (const [modelId, budget] of Object.entries(value)) {
            if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0)
                perProvider[modelId] = budget;
        }
        if (Object.keys(perProvider).length > 0)
            result[provider] = perProvider;
    }
    return result;
}
/**
 * 把任意外部值归一化为签到表（同既有 `sanitizeDisabledModels` 的口径）。
 *
 * ## 双口径读入（旧 dayNumber 就地迁移）
 *
 * 值可能是两种口径：**旧**的本地纪元日数（几百到五位数）与**新**的下一次可签
 * 毫秒时间戳（十三位）。两者差约 7 个数量级，故按 `LEGACY_DAY_NUMBER_MAX`
 * 分流：小值按旧口径换算成新口径（见 `migrateLegacyCheckinDay`），大值原样保留。
 *
 * ⚠️ **provider 从键里解出来**（`provider:accountId`，按**第一个**冒号切）：
 * 换算要按该 provider 的重置钟点算，而钟点对 `qoder-cn` 与其余五家不同。
 * 键里没有冒号（外部手写的脏键）时按缺省钟点 0 处理 —— 不为了一个畸形键
 * 抛错，也不丢掉它（它仍是一个合法的 `provider:accountId` 之外的字符串，
 * 孤儿清理会按前缀规则处理）。
 *
 * ⚠️ **只在读盘这一层迁移**：返回的表是新口径，调用方（`AccountPool`）拿到后
 * 若发生写入，落盘的自然是新口径；若一直不写，下次启动重跑一次同样的迁移
 * —— 换算纯函数、幂等（新口径值不会再落入小值区间）。
 */
export function sanitizeCheckins(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return {};
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
        const normalized = normalizeCheckinValue(value, providerOfCheckinKey(key));
        // 脏值（字符串 / NaN / 小数 / 非法结构）一律丢弃，不抛错。
        if (normalized === undefined)
            continue;
        result[key] = normalized;
    }
    return result;
}
/**
 * 从 `checkins` 的键解出 provider（换算重置钟点用）。
 *
 * 按**第一个**冒号切：accountId 自身可能含冒号（外部手写的键），而 provider id
 * 的形态里没有冒号。无冒号时返回空串 —— `checkinResetHour('')` 落到缺省的 0。
 */
function providerOfCheckinKey(key) {
    const index = key.indexOf(':');
    return index <= 0 ? '' : key.slice(0, index);
}
/**
 * 把任意外部值归一化为 {@link AccountHubDocument}。
 *
 * 存储文件可能被手工编辑过，也可能残留旧格式，因此逐层校验：任何一层形状不符就
 * 丢弃那一层，**不抛错** —— 存储被外部改坏不该让整个账号管理功能不可用
 * （既有 settings 路径的 `sanitizeDisabledModels` 同一取舍）。
 * 旧文档（无 `checkins` / `consumption` / `consumptionCursors` / `autoRoute` /
 * `providerAuditVersion` 字段）读入时补空对象 / 默认配置 / 0。
 */
export function sanitizeAccountHubDocument(raw) {
    const empty = emptyAccountHubDocument();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return empty;
    const value = raw;
    const accounts = Array.isArray(value.accounts)
        ? value.accounts
        : empty.accounts;
    const version = value.schemaVersion;
    const auditVersion = value.providerAuditVersion;
    return {
        accounts,
        disabledModels: sanitizeDisabledModels(value.disabledModels),
        contextBudgets: sanitizeContextBudgets(value.contextBudgets),
        checkins: sanitizeCheckins(value.checkins),
        consumption: sanitizeConsumption(value.consumption),
        consumptionCursors: sanitizeConsumptionCursors(value.consumptionCursors),
        // 自动路由同理：老文档没有该字段 → 读成「默认关闭的空配置」，而不是 undefined
        // （undefined 会让适配器读取时当场抛，整条模型目录都播报不出来）。
        // 归一化复用唯一真相源，脏层逐条丢弃，永不抛错。
        autoRoute: sanitizeAutoRouteConfig(value.autoRoute),
        schemaVersion: typeof version === 'number' && Number.isFinite(version) ? version : 0,
        // 体检版本同理：老文档没有该字段 → 按 0 处理，即「体检尚未执行」
        // —— 这正是本次要修的那批脏数据的唯一入口。
        providerAuditVersion: typeof auditVersion === 'number' && Number.isFinite(auditVersion)
            ? auditVersion
            : 0,
    };
}
/** 文档的深拷贝（全是 JSON 值，结构化往返即可）。 */
function cloneDocument(doc) {
    return JSON.parse(JSON.stringify(doc));
}
/**
 * 域声明里 global 的 schema 形状。
 *
 * ⚠️ **刻意不引 zod**：本插件不是 DSH 本体，仓库里没有（也不该为这个功能引入）
 * zod 依赖。storage 域只用到 schema 的两件事 —— `safeParse(null)` 必须失败
 * （`defineDomain` 用它证明「null 哨兵不会与合法值混淆」），以及每次读取时 `parse()`。
 * 故这里提供一个**最小结构实现**：只拒绝 null（存储的「从未写过」哨兵），
 * 其余一律归一化 —— 与 {@link sanitizeAccountHubDocument} 同口径，脏数据不抛错。
 */
const accountHubGlobalSchema = {
    safeParse(value) {
        if (value === null || value === undefined)
            return { success: false };
        return { success: true, data: sanitizeAccountHubDocument(value) };
    },
    parse(value) {
        if (value === null || value === undefined) {
            throw new Error('account hub global is the never-written sentinel');
        }
        return sanitizeAccountHubDocument(value);
    },
    toJSON() {
        return { type: 'object' };
    },
};
/**
 * 打开账号池的 storage 域。
 *
 * **运行时探测、缺席即静默降级**：storage 服务不存在、形状不对、或 `open()` 抛错
 * （后端未注册 / 文件损坏 / 版本不符）时一律返回 `undefined` 并记一条 warn，
 * 交给调用方回退旧 settings 路径 —— 绝不抛错、绝不阻断插件启动。
 *
 * @param ctx - 宿主上下文（只用到 `storageDomain` 与 `logger`）。
 * @returns 已打开的 storage 句柄；不可用时 `undefined`。
 */
export async function openAccountHubStorage(ctx) {
    const facility = ctx.get('storageDomain');
    if (!facility || typeof facility.open !== 'function') {
        ctx.logger?.warn?.('[account-hub] storage 服务不可用，账号池回退旧 settings 路径');
        return undefined;
    }
    let domain;
    try {
        domain = await facility.open({
            name: ACCOUNT_HUB_DOMAIN,
            version: ACCOUNT_HUB_DOMAIN_VERSION,
            // single 布局 + 无表 + 一个 global：账号池是「一个文档整体读写」。
            global: { schema: accountHubGlobalSchema, initial: emptyAccountHubDocument() },
            tables: {},
        });
    }
    catch (error) {
        ctx.logger?.warn?.(`[account-hub] storage 域打开失败，账号池回退旧 settings 路径: ${String(error)}`);
        return undefined;
    }
    // ⚠️ **必须注册关闭 disposer**：domain facility 按域名做**单开**约束
    // （同名域第二次 `open` 直接以 `already-open` 拒绝）。不注册就等于把域名
    // 永久占住 —— 插件重载、或同进程内任何一次重新接管都会再也打不开这个域。
    // 这是 DSH 本体的既有约定（`ctx.effect(() => () => domain.close(), '<name>.domainClose')`
    // 见 workspace / session-projection-cache 两处），照它写。
    try {
        ;
        ctx.effect?.(() => () => domain.close?.(), 'accountHub.domainClose');
    }
    catch {
        // 登记失败（无 effect 服务 / fiber 非活跃）时退化为「不主动关闭」：
        // 域句柄仍可用，只是生命周期交给进程 —— 不能因为登记不上 disposer 就整个降级。
    }
    const read = () => sanitizeAccountHubDocument(domain.global.get());
    return {
        domain,
        read,
        async write(doc) {
            // 深拷贝后落盘：写入是异步的，调用方随后改自己的数组不该污染已提交的值。
            await domain.global.set(cloneDocument(doc));
        },
        hasAccounts() {
            return read().accounts.length > 0;
        },
    };
}
//# sourceMappingURL=account-hub-storage.js.map