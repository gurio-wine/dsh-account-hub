/**
 * Qoder **设备身份**的运行时获取 —— 调用官方桌面客户端自带的 `runtime-info.exe`
 * 取出 `Cosy-MachineToken` / `Cosy-MachineType` / `Cosy-MachineCode` 三值。
 *
 * ## 为什么需要它（真机三次验证，2026-09-23 / 09-25）
 *
 * **国际版**（`openapi.qoder.sh`）的 `/sash/api/v1/me/campaigns` **只对带完整设备
 * 身份头的请求下发每日签到活动**（`claimable: true`）：只有 `Cosy-ClientType: 10`
 * 时服务端回空列表 —— 那正是「全部账号无法判定」的来路。**CN 不需要**
 * （`openapi.qoder.com.cn` 只需 `Cosy-ClientType: 10` 即满额，现状已够用），故接线
 * 层对 CN **一个 exe 都不调**（省一次 ~1.2 s，且避免改 CN 的出站头集）。
 *
 * ## 唯一已验证的来源：官方客户端的 `runtime-info.exe`
 *
 * 调用形态（与真机探针 `tests/e2e/qoder-minimal-headers-claim-probe.mjs` 逐字对齐，
 * 只把同步 `execFileSync` 换成**异步** `execFile` —— 插件里绝不能阻塞事件循环）：
 *
 * ```
 * execFile(exe, ['--account-stdin'], { input: '{"account":"<user_id>"}\n' })
 * stdout 第一行 → JSON.parse → { machineToken, machineType, machineCode, … }
 * ```
 *
 * 实测特性（三条，决定了本模块的缓存与容错设计）：
 *
 * 1. **三值是机器级的**（与 `account` 无关：无效 account 也返回相同值）⇒ 缓存按
 *    **product** 而非按账号，多账号签到不会各等 1.2 s；
 * 2. **跨会话漂移**（9/23 与 9/25 取值不同）但**服务端不校验新鲜度**（旧值重放仍
 *    `claimable: true`）⇒ 刻意**不落盘**，进程内缓存足够；
 * 3. 单次约 **1.2 s**，超时上限在探针里是 25 s，本模块沿用同值。
 *
 * ## 契约：**任何失败都返回 `undefined`，绝不抛**
 *
 * 非 Windows / 找不到 exe / 调用失败 / 超时 / 输出畸形 / 缺字段 —— 六种失败一律
 * 归成同一件事：**没有身份**。调用方据此降级为现状头集，签到自然落入既有的
 * `undetermined` 抑制兜底（不写签到状态、下轮 sweep 重试），**不新增错误路径**。
 *
 * ## 本模块**不 import fetch、不发任何网络请求**
 *
 * 与 `qoder-product.ts` 同一条纪律：它只做「探测路径 + 起一个子进程 + 解析 stdout」。
 * 出站头的**构造**在 `qoder-product.ts`（纯函数），**接线**在 `qoder-credits.ts`。
 */
import type { QoderMachineIdentity, QoderProduct } from './qoder-product.js';
/**
 * `runtime-info.exe` 的固定参数（真机探针同值）。
 *
 * 该参数让 exe 从 **stdin 读账号**（而不是从命令行读）—— 账号是 UUIDv7，放在
 * 命令行会进进程列表，且 Windows 命令行长度与转义都是无谓的风险。
 */
export declare const QODER_RUNTIME_INFO_ARGS: readonly string[];
/**
 * 单次调用的超时上限（毫秒）。
 *
 * ⚠️ **与真机探针同值（25 s）而不是压到实测耗时（~1.2 s）附近**：这个数是
 * **上限**而不是期望值，正常路径 1.2 s 就返回；把它压小只会让「客户端正在被
 * 杀毒软件扫描」这类慢启动机器白白降级。签到是低频操作，等得起。
 */
export declare const QODER_RUNTIME_INFO_TIMEOUT_MS = 25000;
/**
 * stdout 的收集上限（字节）。
 *
 * stdout 只有一行小 JSON（几百字节），1 MiB 已是数量级的余量；给一个上限是为了
 * 万一 exe 行为异常狂刷输出时，`execFile` 报错而不是把宿主内存吃光。
 */
export declare const QODER_RUNTIME_INFO_MAX_BUFFER_BYTES = 1048576;
/** `~/.qoder/.bin/` 下的版本目录前缀（hash 段随客户端版本变，故用通配）。 */
export declare const QODER_RUNTIME_INFO_GLOB_PREFIX = "umid-win32-x64-";
/** 文件系统注入面：只做「这个文件在不在」与「这个目录下有哪些子目录」两件事。 */
export interface QoderMachineIdentityFs {
    /** 路径存在且是**文件**。 */
    exists(path: string): Promise<boolean>;
    /** 列出目录下的**子目录名**（读不到一律当空列表，不抛）。 */
    listDirs(path: string): Promise<string[]>;
}
/** 子进程注入面：返回 stdout 原文；非零退出 / 超时 / 起不来一律由实现方 reject。 */
export type QoderMachineIdentityExec = (file: string, args: readonly string[], options: {
    input: string;
    timeoutMs: number;
}) => Promise<string>;
/**
 * 一个候选来源。
 *
 * 通配候选单独成一类（而不是把子目录名写死）：`~/.qoder/.bin/umid-win32-x64-<hash>/`
 * 里的 hash 段**随客户端版本变**，每一版都可能不同 —— 写死等于假设「客户端永不更新」。
 */
export type QoderRuntimeInfoCandidate = {
    kind: 'glob';
    dir: string;
} | {
    kind: 'file';
    path: string;
};
/**
 * 按**探测顺序**列出候选（纯函数，不碰文件系统）。
 *
 * 顺序即真机探针的顺序（第一个存在的胜出）：
 *
 * 1. `~/.qoder/.bin/umid-win32-x64-<hash>/runtime-info.exe`（用户级安装 / 自动更新后的
 *    实际路径 —— 真机就在这一档命中）；
 * 2. `D:\Programs\Qoder\resources\umid\runtime-info.exe`
 * 3. `C:\Program Files\Qoder\resources\umid\runtime-info.exe`
 * 4. `%LOCALAPPDATA%\Programs\Qoder\resources\umid\runtime-info.exe`
 *
 * ⚠️ **顺序不能改**：多版本共存时先命中用户级那一档，与官方客户端自己用的一致；
 * 把 Program Files 提前会让「装了新版但旧版还在」的机器取到旧 exe。
 */
export declare function qoderRuntimeInfoCandidates(product: QoderProduct, homeDir?: string, env?: Record<string, string | undefined>): QoderRuntimeInfoCandidate[];
/**
 * 解析 `runtime-info.exe` 的 stdout（**只取第一行**）。
 *
 * 取第一行是探针同款：exe 之后可能还打印别的诊断行，而 `JSON.parse` 整段 stdout
 * 必然失败。任何一步不成形（空输出 / 首行不是 JSON / 不是对象 / 三个字段有缺失或
 * 非法）一律 undefined —— 契约是「输出畸形 ⇒ 降级」，不是「尽力猜」。
 */
export declare function parseQoderMachineIdentity(stdout: string): QoderMachineIdentity | undefined;
/**
 * 取值形态是否与真机观测记录一致（**只用于诊断，绝不用于拦截**）。
 *
 * 真机三次验证的形态是：`machineToken` 88 字符且 `P1g` 开头、`machineType` /
 * `machineCode` 各 18 位 hex。
 *
 * ## ⚠️ 为什么明知形态却不拿它当闸门
 *
 * 那三个形态是**单个客户端版本的观测样本**，不是协议契约。把它写成硬闸门的后果
 * 是：Qoder 哪天换了 token 格式（换前缀、改长度），本插件**静默退回**「天天
 * `undetermined`、一分不领」——正是本模块要修的那个故障，而且这次连原因都看不出来。
 * 反过来，取值来自官方 exe 本身、**不是我们猜的**，发出去的风险远小于不发。
 * 故这里的取舍是：**照发 + 记一条诊断**（形态不符时提示核对客户端版本）。
 */
export declare function matchesObservedQoderMachineIdentityShape(identity: QoderMachineIdentity): boolean;
/** {@link getQoderMachineIdentity} 的选项（除 `onDebug` 外**全部为测试注入面**）。 */
export interface QoderMachineIdentityOptions {
    /** home 目录覆盖（测试用；默认 `os.homedir()`）。 */
    homeDir?: string;
    /** 环境变量覆盖（测试用 `%LOCALAPPDATA%`；默认 `process.env`）。 */
    env?: Record<string, string | undefined>;
    /** 平台覆盖（测试用；默认 `process.platform`）。非 `win32` 直接返回 undefined。 */
    platform?: string;
    /** 文件系统注入面（测试用）。 */
    fs?: QoderMachineIdentityFs;
    /** 子进程注入面（测试用）。 */
    exec?: QoderMachineIdentityExec;
    /** 超时覆盖（默认 {@link QODER_RUNTIME_INFO_TIMEOUT_MS}）。 */
    timeoutMs?: number;
    /** 缓存实例覆盖（测试用独立实例；默认模块级 Map）。 */
    cache?: Map<string, QoderMachineIdentity>;
    /** 脱敏调试出口（只输出原因，**不输出身份值**）。 */
    onDebug?: (message: string) => void;
}
/** 设备身份获取函数的形状（`qoder-credits.ts` 的注入面用）。 */
export type QoderMachineIdentityFetcher = (product: QoderProduct, accountUserId: string | undefined) => Promise<QoderMachineIdentity | undefined>;
/**
 * 取该 region 的设备身份；**任何失败返回 `undefined`，绝不抛**。
 *
 * 流程：平台闸（非 Windows 直接放弃）→ 缓存 → 路径探测 → `execFile` 调用 → 解析
 * → 写缓存。每一步的失败都只产生一条 `onDebug` 诊断行。
 *
 * @param product - 决定 home 隐藏目录名与安装目录名（`qoder` / `qoder-cn`）。
 * @param accountUserId - 凭据里的 `user_id`；**可以缺失**（三值与它无关，缺失时传空串
 *   —— 仍然要发 stdin，exe 的账号参数是必填形态）。
 * @param options - 注入面与超时。
 */
export declare function getQoderMachineIdentity(product: QoderProduct, accountUserId: string | undefined, options?: QoderMachineIdentityOptions): Promise<QoderMachineIdentity | undefined>;
//# sourceMappingURL=qoder-machine-identity.d.ts.map