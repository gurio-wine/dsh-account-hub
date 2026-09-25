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

import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { QoderMachineIdentity, QoderProduct } from './qoder-product.js'

// ── 调用参数常量 ──

/**
 * `runtime-info.exe` 的固定参数（真机探针同值）。
 *
 * 该参数让 exe 从 **stdin 读账号**（而不是从命令行读）—— 账号是 UUIDv7，放在
 * 命令行会进进程列表，且 Windows 命令行长度与转义都是无谓的风险。
 */
export const QODER_RUNTIME_INFO_ARGS: readonly string[] = ['--account-stdin']

/**
 * 单次调用的超时上限（毫秒）。
 *
 * ⚠️ **与真机探针同值（25 s）而不是压到实测耗时（~1.2 s）附近**：这个数是
 * **上限**而不是期望值，正常路径 1.2 s 就返回；把它压小只会让「客户端正在被
 * 杀毒软件扫描」这类慢启动机器白白降级。签到是低频操作，等得起。
 */
export const QODER_RUNTIME_INFO_TIMEOUT_MS = 25_000

/**
 * stdout 的收集上限（字节）。
 *
 * stdout 只有一行小 JSON（几百字节），1 MiB 已是数量级的余量；给一个上限是为了
 * 万一 exe 行为异常狂刷输出时，`execFile` 报错而不是把宿主内存吃光。
 */
export const QODER_RUNTIME_INFO_MAX_BUFFER_BYTES = 1_048_576

/** `~/.qoder/.bin/` 下的版本目录前缀（hash 段随客户端版本变，故用通配）。 */
export const QODER_RUNTIME_INFO_GLOB_PREFIX = 'umid-win32-x64-'

/** 安装目录里 `runtime-info.exe` 的相对尾巴（`D:\Programs\Qoder\resources\umid\…`）。 */
const QODER_DESKTOP_RESOURCES_TAIL: readonly string[] = ['resources', 'umid', 'runtime-info.exe']

/**
 * 桌面客户端安装目录名（按 region）。
 *
 * ⚠️ 它与 {@link QoderProduct.machineIdDir}（`~/.qoder` / `~/.qoder-cn`）**是两件事**：
 * 前者是**安装目录**名（真机实测 `Qoder` / `Qoder CN`），后者是 home 下的隐藏目录名。
 * 两者都不能按「同形替换」从对方推出来，故各留一份。
 */
const QODER_DESKTOP_PROGRAM_DIRS: Readonly<Record<QoderProduct['id'], string>> = {
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
}

/** 三个候选安装根的「父目录」（按真机探针的探测顺序）。 */
const QODER_DESKTOP_INSTALL_PARENTS: readonly string[] = [
  'D:\\Programs',
  'C:\\Program Files',
]

// ── 注入面（全部为测试而设；生产走下面的默认实现） ──

/** 文件系统注入面：只做「这个文件在不在」与「这个目录下有哪些子目录」两件事。 */
export interface QoderMachineIdentityFs {
  /** 路径存在且是**文件**。 */
  exists(path: string): Promise<boolean>
  /** 列出目录下的**子目录名**（读不到一律当空列表，不抛）。 */
  listDirs(path: string): Promise<string[]>
}

/** 子进程注入面：返回 stdout 原文；非零退出 / 超时 / 起不来一律由实现方 reject。 */
export type QoderMachineIdentityExec = (
  file: string,
  args: readonly string[],
  options: { input: string; timeoutMs: number },
) => Promise<string>

/** 生产用 IO：`stat` 判存在、`readdir` 列目录 —— **失败即 falsy，不抛**。 */
const defaultFs: QoderMachineIdentityFs = {
  async exists(path) {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },
  async listDirs(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      // 排序：目录枚举顺序在不同文件系统 / 客户端版本下不保证稳定，而
      // 「第一个存在的候选胜出」这条规则必须是确定性的（否则同一台机器两次
      // 运行可能取到不同版本的 exe）。
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch {
      return []
    }
  },
}

/**
 * 生产用子进程实现 —— **异步** `execFile`。
 *
 * ⚠️ 与探针的 `execFileSync` **刻意不同**：插件跑在宿主的事件循环里，同步调用会
 * 把整个 harness 卡住 1.2 s（乃至超时的 25 s）。异步版还要自己做探针不需要的
 * 一件事：**把输入写进 stdin 并关闭**（异步 `execFile` 没有 `input` 选项，
 * 那是 `execFileSync` 才有的）。
 */
const defaultExec: QoderMachineIdentityExec = (file, args, options) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: QODER_RUNTIME_INFO_MAX_BUFFER_BYTES,
        // 不弹控制台窗口（Windows 下每次签到闪一个黑框是不可接受的）。
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
    // stdin 默认为 pipe；写不进去（进程已退出等）不额外处理 —— 那种情况下
    // 回调里必然带着 error 回来，走同一条降级路径。
    child.stdin?.end(options.input)
  })

// ── 候选路径 ──

/**
 * 一个候选来源。
 *
 * 通配候选单独成一类（而不是把子目录名写死）：`~/.qoder/.bin/umid-win32-x64-<hash>/`
 * 里的 hash 段**随客户端版本变**，每一版都可能不同 —— 写死等于假设「客户端永不更新」。
 */
export type QoderRuntimeInfoCandidate =
  | { kind: 'glob'; dir: string }
  | { kind: 'file'; path: string }

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
export function qoderRuntimeInfoCandidates(
  product: QoderProduct,
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): QoderRuntimeInfoCandidate[] {
  const programDir = QODER_DESKTOP_PROGRAM_DIRS[product.id]
  const candidates: QoderRuntimeInfoCandidate[] = [
    { kind: 'glob', dir: join(homeDir, product.machineIdDir, '.bin') },
  ]
  for (const parent of QODER_DESKTOP_INSTALL_PARENTS) {
    candidates.push({ kind: 'file', path: join(parent, programDir, ...QODER_DESKTOP_RESOURCES_TAIL) })
  }
  const localAppData = env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData.trim().length > 0) {
    candidates.push({
      kind: 'file',
      path: join(localAppData, 'Programs', programDir, ...QODER_DESKTOP_RESOURCES_TAIL),
    })
  }
  return candidates
}

/**
 * 按序探测候选，返回第一个存在的 exe 绝对路径；一个都没有时 undefined。
 *
 * ⚠️ **本函数绝不抛**（模块契约的第一条防线）：`fs` 是**注入面**，它的实现方可以是
 * 测试替身、也可以是将来换上的另一种 IO —— 而 `exists` / `listDirs` 是文件系统调用，
 * 天然会抛（EACCES / EPERM / EIO）。契约「任何失败返回 undefined」若只在
 * {@link defaultFs} 里兑现，就**依赖「谁被注入进来」**：换一个不吞错的替身，
 * 异常就会一路穿到签到链路（那里的契约是「不新增错误路径」）。
 * 故两道 IO 各包一层 try/catch，与实现无关。
 */
async function findQoderRuntimeInfoExe(
  product: QoderProduct,
  options: { fs: QoderMachineIdentityFs; homeDir?: string; env?: Record<string, string | undefined> },
): Promise<string | undefined> {
  /** 把一次可能抛错的探测压成「读不到」——与 {@link defaultFs} 同向。 */
  const probe = async (operation: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await operation()
    } catch {
      return false
    }
  }

  for (const candidate of qoderRuntimeInfoCandidates(product, options.homeDir, options.env)) {
    if (candidate.kind === 'file') {
      if (await probe(() => options.fs.exists(candidate.path))) return candidate.path
      continue
    }
    // 通配档：列出该目录下的全部版本目录，逐个试。
    //
    // ⚠️ **排序写在这里，而不是只写在 `defaultFs.listDirs` 里**：目录枚举顺序在
    // 不同文件系统 / 客户端版本下不保证稳定，而「第一个存在的候选胜出」必须是
    // **确定性**的（否则同一台机器两次运行可能取到不同版本的 exe）。把排序留在
    // 默认实现里，就等于让这条性质**依赖「谁被注入进来」** —— 单测注入一个不排序
    // 的替身时立刻破功（本文件的用例正是这么抓住它的）。故在消费点再排一次，
    // 与注入面无关。
    let versionDirs: string[]
    try {
      versionDirs = [...await options.fs.listDirs(candidate.dir)].sort()
    } catch {
      continue
    }
    for (const entry of versionDirs) {
      if (!entry.startsWith(QODER_RUNTIME_INFO_GLOB_PREFIX)) continue
      const path = join(candidate.dir, entry, 'runtime-info.exe')
      if (await probe(() => options.fs.exists(path))) return path
    }
  }
  return undefined
}

// ── 解析 ──

/**
 * HTTP 头值的长度上限（字符）。
 *
 * 三个实测值最长 88 字符；给 512 是数量级余量 —— 它防的是「exe 返回一整篇日志」
 * 这类畸形输出被原样塞进请求头，而不是在给正常值设卡。
 */
const QODER_IDENTITY_VALUE_MAX_LENGTH = 512

/**
 * 读一个**能安全放进 HTTP 头**的值。
 *
 * 判据只有三条：非空、无控制字符（`\x20-\x7E` 之外的字节会让 `Headers` 构造抛错，
 * 而本模块的契约是「绝不抛」）、长度有限。**刻意不校验观测到的具体形态**
 * （88 字符 `P1g…` / 18 位 hex）—— 见 {@link matchesObservedQoderMachineIdentityShape}。
 */
function readIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > QODER_IDENTITY_VALUE_MAX_LENGTH) return undefined
  return /^[\x20-\x7E]+$/.test(trimmed) ? trimmed : undefined
}

/**
 * 解析 `runtime-info.exe` 的 stdout（**只取第一行**）。
 *
 * 取第一行是探针同款：exe 之后可能还打印别的诊断行，而 `JSON.parse` 整段 stdout
 * 必然失败。任何一步不成形（空输出 / 首行不是 JSON / 不是对象 / 三个字段有缺失或
 * 非法）一律 undefined —— 契约是「输出畸形 ⇒ 降级」，不是「尽力猜」。
 */
export function parseQoderMachineIdentity(stdout: string): QoderMachineIdentity | undefined {
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const machineToken = readIdentityValue(record.machineToken)
  const machineType = readIdentityValue(record.machineType)
  const machineCode = readIdentityValue(record.machineCode)
  if (machineToken === undefined || machineType === undefined || machineCode === undefined) {
    return undefined
  }
  return { machineToken, machineType, machineCode }
}

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
export function matchesObservedQoderMachineIdentityShape(identity: QoderMachineIdentity): boolean {
  return /^P1g[\x21-\x7E]{85}$/.test(identity.machineToken)
    && /^[0-9a-fA-F]{18}$/.test(identity.machineType)
    && /^[0-9a-fA-F]{18}$/.test(identity.machineCode)
}

/** 把任意抛出物压成一行可读文本（只进调试出口）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

// ── 缓存 ──

/**
 * 进程内身份缓存（**按 product.id**，不是按账号）。
 *
 * 键按 product 的理由是真机事实：三值与 `account` 无关（同一台机器上换谁问都是
 * 同一组值）。于是 `credits.claimAll` 顺序处理 N 个账号时只付一次 1.2 s。
 *
 * ⚠️ **失败不缓存**：exe 一时不可用（客户端正在更新、被杀软拦下）不该让整个进程
 * 生命周期都失去设备身份 —— 下一次签到重试即可。⚠️ **不落盘**：值跨会话漂移、
 * 且服务端不校验新鲜度，落盘只会引入「陈旧文件 + 多一份清理责任」。
 */
const qoderMachineIdentityCache = new Map<string, QoderMachineIdentity>()

// ── 主入口 ──

/** {@link getQoderMachineIdentity} 的选项（除 `onDebug` 外**全部为测试注入面**）。 */
export interface QoderMachineIdentityOptions {
  /** home 目录覆盖（测试用；默认 `os.homedir()`）。 */
  homeDir?: string
  /** 环境变量覆盖（测试用 `%LOCALAPPDATA%`；默认 `process.env`）。 */
  env?: Record<string, string | undefined>
  /** 平台覆盖（测试用；默认 `process.platform`）。非 `win32` 直接返回 undefined。 */
  platform?: string
  /** 文件系统注入面（测试用）。 */
  fs?: QoderMachineIdentityFs
  /** 子进程注入面（测试用）。 */
  exec?: QoderMachineIdentityExec
  /** 超时覆盖（默认 {@link QODER_RUNTIME_INFO_TIMEOUT_MS}）。 */
  timeoutMs?: number
  /** 缓存实例覆盖（测试用独立实例；默认模块级 Map）。 */
  cache?: Map<string, QoderMachineIdentity>
  /** 脱敏调试出口（只输出原因，**不输出身份值**）。 */
  onDebug?: (message: string) => void
}

/** 设备身份获取函数的形状（`qoder-credits.ts` 的注入面用）。 */
export type QoderMachineIdentityFetcher = (
  product: QoderProduct,
  accountUserId: string | undefined,
) => Promise<QoderMachineIdentity | undefined>

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
export async function getQoderMachineIdentity(
  product: QoderProduct,
  accountUserId: string | undefined,
  options: QoderMachineIdentityOptions = {},
): Promise<QoderMachineIdentity | undefined> {
  // ⚠️ **region 闸在平台闸之前**：CN 不需要设备身份（真机三次验证），故一个 exe
  // 都不调、连「有没有装客户端」都不必探测 —— 省一次 ~1.2 s 子进程。判据与
  // `qoderCampaignHeaders` **共用同一个产品字段**（`campaignDeviceIdentity`），
  // 两处各写一份 region 判据必然漂移。
  if (product.campaignDeviceIdentity !== true) {
    options.onDebug?.(
      `[qoder] 设备身份：${product.displayName} 的签到链路不需要设备头，跳过 runtime-info.exe`,
    )
    return undefined
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    options.onDebug?.('[qoder] 设备身份：非 Windows 平台无 runtime-info.exe，降级为现状头集')
    return undefined
  }

  const cache = options.cache ?? qoderMachineIdentityCache
  const cached = cache.get(product.id)
  if (cached !== undefined) return cached

  const fs = options.fs ?? defaultFs
  const run = options.exec ?? defaultExec

  const exe = await findQoderRuntimeInfoExe(product, {
    fs,
    ...options.homeDir === undefined ? {} : { homeDir: options.homeDir },
    ...options.env === undefined ? {} : { env: options.env },
  })
  if (exe === undefined) {
    options.onDebug?.(
      `[qoder] 设备身份：未找到 Qoder（${product.displayName}）的 runtime-info.exe，降级为现状头集`,
    )
    return undefined
  }

  let stdout: string
  try {
    stdout = await run(exe, QODER_RUNTIME_INFO_ARGS, {
      input: `${JSON.stringify({ account: accountUserId ?? '' })}\n`,
      timeoutMs: options.timeoutMs ?? QODER_RUNTIME_INFO_TIMEOUT_MS,
    })
  } catch (error) {
    options.onDebug?.(`[qoder] 设备身份：runtime-info.exe 调用失败，降级为现状头集（${describeError(error)}）`)
    return undefined
  }

  const identity = parseQoderMachineIdentity(stdout)
  if (identity === undefined) {
    options.onDebug?.('[qoder] 设备身份：runtime-info.exe 输出畸形，降级为现状头集')
    return undefined
  }

  if (!matchesObservedQoderMachineIdentityShape(identity)) {
    options.onDebug?.(
      '[qoder] 设备身份：取值形态与真机观测记录不一致（**仍照发** —— exe 是权威来源）；'
      + '若签到持续无效请核对 Qoder 客户端版本',
    )
  }
  cache.set(product.id, identity)
  return identity
}
