/**
 * Qoder **wasm 签名链**（两个 region 共用一份实现）—— 定位与提取层。
 *
 * ## 为什么需要它
 *
 * Qoder 的 chat 真实通道（`/algo/api/v2/service/pro/sse/agent_chat_generation`）
 * 要求**签名**：官方客户端用一个 Rust→wasm 模块（`qoder_auth_wasm`）构造
 * `QoderContext`，由它算出出站 URL、20 个头（`Authorization: Bearer COSY.…`、
 * `Cosy-Key`、`Cosy-Date`…）与**加密后的请求体**。缺这一步，请求会被上游以
 * HTTP 200 + 流内 `{"code":"101","message":"Signature invalid"}` 拒绝 ——
 * 即 CN chat 长期不可用的结构性原因（见 AGENTS.md 的 Qoder 章节）。
 *
 * ## wasm 的来源与提取（三级优先级）
 *
 * | 级别 | 来源 | 说明 |
 * |---|---|---|
 * | ① | **本机已装 Qoder** | `…/resources/app.asar.unpacked/node_modules/@qoder-ai/<包名>/dist/_worker/qoder-worker-runtime[.obf].mjs` |
 * | ② | **官方 npm 包** | 国际版 `@qoder-ai/qoder-agent-sdk`；CN `@qodercn-ai/qoderclicn` |
 * | ③ | **官方 CDN** | `runtime-manifest.json` 的 `urlTemplate` / 内置的发布地址 |
 *
 * ### ①②③ 的实测形态（2026-09-21 取证，勿凭猜测改）
 *
 * wasm **不是独立文件**，而是以**单条 base64 字面量内联在 worker runtime 里**
 * （`$9s="AGFzbQ…"`，398 144 字符 → 298 606 字节）。故提取方式是
 * 「下载 worker runtime → 抠出 base64 → 解码 → 校验 SHA-256」。
 *
 * - **①**：两个 region 的 worker 都在本机（35 MB 上下），dev 版与正式版文件名
 *   分别是 `qoder-worker-runtime.mjs` / `qoder-worker-runtime.obf.mjs`。
 * - **② 国际版 npm 包不含 worker**（只有 99 个 `.d.ts` + `postinstall.cjs`，
 *   162 KB）—— 它靠 `runtime-manifest.json` 的 `urlTemplate` 在**安装期**下载。
 *   故国际版的 ② 实际落空、由 ③ 兜住（这不是缺陷，是官方分发形态）。
 * - **② CN npm 包含 worker**（`@qodercn-ai/qoderclicn`，31.8 MB，内含
 *   `bundle/qoder-worker-runtime.mjs`）—— 与 obf 版是同一构建的不同产物。
 * - **③**：`https://download.qoder.com/qodercli/releases/{版本}/qodercli-worker-runtime-win32-x64.tgz`
 *   （实测 200）。⚠️ 平台 token 是 **`win32-x64`**，不是 `windows-x64`（后者 404）。
 *
 * ### 为什么 wasm 可以跨 region / 跨版本复用
 *
 * 实测四个来源（本机国际版 1.1.57、本机 CN 1.1.57、CN npm 1.1.59、官方 CDN
 * 1.1.59）抠出的 wasm **SHA-256 完全相同**（{@link QODER_WASM_SHA256}）。
 * 故缓存以**这一个哈希**为判据，两区共用同一份字节。
 *
 * ## 许可与分发红线
 *
 * wasm 是 Qoder 的官方二进制。本插件**只做运行时提取**：不把 wasm 字节提交
 * 进仓库、不随插件包分发，只在运行期从「用户本机已装的东西」或「官方公开
 * 分发渠道」取一份并缓存到本机数据目录。仓库里只有提取与加载代码。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { QoderProduct } from './qoder-product.js'

// ── 常量（全部为实测值，见模块头） ──────────────────────────────────────────

/**
 * 官方 wasm 的 SHA-256（**小写十六进制，64 字符**）。
 *
 * 实测四个来源同值：本机国际版 1.1.57 / 本机 CN 1.1.57 / CN npm 1.1.59 /
 * 官方 CDN 1.1.59。它是缓存的命中判据，也是「抠出来的东西是不是它」的唯一
 * 权威判据 —— ⚠️ **不要改成只看长度或 base64 长度**：随机字节也能凑出长度。
 */
export const QODER_WASM_SHA256 = '6419471effa631519def7797d76d7ede38b9fcfa9a83c2148c8ef5d43355b43d'

/** wasm 字节数（298 606）。冗余校验，用于在算哈希前先廉价地排除明显不对的东西。 */
export const QODER_WASM_BYTES = 298_606

/**
 * worker runtime 里内联 base64 的字面量前缀。
 *
 * 抠取方式是「定位该前缀 → 向两侧扩展到引号边界」，**不写死偏移量**：实测
 * 四个来源的偏移各不相同（25371 / 25438 / 25442 / 25447），写死偏移会在换
 * 版本时静默抠到错位置。
 *
 * ⚠️ 用 **5 字符 `AGFzb`**（wasm 魔数 `\0asm` 的 base64 编码）而**不是**官方
 * 源码里那 6 字符的 `AGFzbQ`：第 6 个字符由**第 5 字节的高 4 位**决定，而
 * 官方产物第 5 字节是版本号首字节 `0x01`（⇒ `Q`）。写成 `AGFzbQ` 等于顺带
 * 假设「wasm 版本恒为 1」—— 上游哪天换版本号，抠取会**静默失败**
 * （表现为「未找到签名组件」，而不是一个可诊断的错）。5 字符前缀既仍是
 * 明确的 wasm 标志，又不带这个隐含假设。
 */
export const QODER_WASM_B64_PREFIX = 'AGFzb'

/** 单次网络请求超时（毫秒）。任务要求 60 秒。 */
export const QODER_WASM_FETCH_TIMEOUT_MS = 60_000

/** 官方 CDN 基址（国际版）。 */
export const QODER_WASM_CDN_BASE = 'https://download.qoder.com/qodercli/releases'

/**
 * worker runtime 的产物名模板（`{target}` 是**平台 token**）。
 *
 * ⚠️ 官方用的是 Go 风格 `win32-x64`；写 `windows-x64` 会 404（实测）。
 */
export const QODER_WASM_CDN_ARTIFACT = 'qodercli-worker-runtime-{target}.tgz'

/** 本插件在 `~/.dsh` 下的缓存子目录名。 */
export const QODER_WASM_CACHE_DIR = 'qoder-wasm'

/** npm 包名（两个 region 不同名，实测）。 */
export const QODER_WASM_NPM_PACKAGES: Readonly<Record<string, string>> = {
  qoder: '@qoder-ai/qoder-agent-sdk',
  'qoder-cn': '@qodercn-ai/qoderclicn',
}

/** npm registry 列表（按序尝试）。npmmirror 是 CN 镜像。 */
export const QODER_WASM_REGISTRIES: readonly string[] = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

/**
 * 本机安装目录候选（按序探测，取第一个存在的 wasm）。
 *
 * 覆盖三类落点：
 * 1. **实测过的绝对路径**（本机 `D:\Programs\Qoder` / `Qoder CN`）；
 * 2. **Electron 应用的常规位置**（`%LOCALAPPDATA%\Programs\`、`%PROGRAMFILES%`、
 *    `%PROGRAMFILES(X86)%`）—— 官方安装器默认落在这里，只是本机装到了 D 盘；
 * 3. **非 Windows 的少量常见位置**，让同一份代码在 mac / Linux 上也有机会命中
 *    （找不到就降级到 npm / CDN，不产生错误行为）。
 *
 * ⚠️ 这里**只列候选、不做存在性假设**：路径不存在就是这一级跳过，
 * 由日志记录「试过哪些」。
 */
export function qoderWasmLocalInstallDirs(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  const dirs: string[] = [
    // 实测落点
    'D:\\Programs\\Qoder',
    'D:\\Programs\\Qoder CN',
    'C:\\Programs\\Qoder',
    'C:\\Programs\\Qoder CN',
  ]
  const localAppData = env.LOCALAPPDATA
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
  const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)']
  for (const base of [localAppData ? join(localAppData, 'Programs') : undefined, programFiles, programFilesX86]) {
    if (base === undefined) continue
    dirs.push(join(base, 'Qoder'), join(base, 'Qoder CN'))
  }
  if (home.length > 0) {
    dirs.push(join(home, 'Applications', 'Qoder.app'), join(home, 'Applications', 'Qoder CN.app'))
    dirs.push(join(home, '.local', 'share', 'qoder'), join(home, '.local', 'share', 'qoder-cn'))
  }
  dirs.push('/Applications/Qoder.app', '/Applications/Qoder CN.app', '/opt/Qoder', '/opt/Qoder CN')
  return dirs
}

/** 默认的安装目录候选（读真实环境变量）。 */
export const QODER_WASM_LOCAL_INSTALL_DIRS: readonly string[] = qoderWasmLocalInstallDirs()

// ── 类型 ────────────────────────────────────────────────────────────────────

/** wasm 字节的来源（用于日志与故障定位）。 */
export type QoderWasmSource =
  | 'cache'
  | 'local-install'
  | 'npm-tarball'
  | 'cdn-tarball'

/** 提取结果。 */
export interface QoderWasmArtifact {
  /** wasm 字节本体。 */
  bytes: Uint8Array
  /** 来源。 */
  source: QoderWasmSource
  /** 来源的人类可读描述（路径 / URL），用于日志。 */
  detail: string
}

/** 提取过程的一步日志（不抛错，只为可观测性）。 */
export interface QoderWasmAttempt {
  /** 级别标识（`cache` / `local-install` / `npm-tarball` / `cdn-tarball`）。 */
  source: QoderWasmSource
  /** 人类可读描述。 */
  detail: string
  /** 是否成功。 */
  ok: boolean
  /** 失败原因（`ok: false` 时有值）。 */
  error?: string
}

/**
 * 提取选项（**全部可注入**，测试不发网络、不碰真实文件系统）。
 *
 * 之所以把 `fetch`/文件系统都做成注入面：本模块的正常路径要下载 30 MB 的
 * tarball，若测试只能打真实网络，CI 会既慢又不稳；而「降级顺序」恰恰是
 * 最需要被钉死的语义。
 */
export interface QoderWasmExtractOptions {
  /** 目标 region 的产品（决定 npm 包名）。 */
  product: QoderProduct
  /** `~/.dsh` 的 home 目录覆盖（默认 `os.homedir()`）。 */
  homeDir?: string
  /** 本机安装目录候选覆盖（测试用）。 */
  localDirs?: readonly string[]
  /** 现有缓存是否可用（默认读真实缓存文件）。 */
  readCache?: (path: string) => Promise<Uint8Array | undefined>
  /** 写缓存（默认写真实文件，原子替换）。 */
  writeCache?: (path: string, bytes: Uint8Array) => Promise<void>
  /** 读取本机目录里的 worker runtime 文本（默认 `fs.readFileSync`）。 */
  readLocalWorker?: (path: string) => string | undefined
  /** 拉取 URL 为字节（默认 `fetch`）。 */
  fetchBytes?: (url: string) => Promise<Uint8Array>
  /** 解 tarball 取出指定后缀成员（默认内置极简 tar 解析）。 */
  extractFromTarball?: (tarGz: Uint8Array, suffix: string) => Promise<Uint8Array | undefined>
}

/** 提取失败时的可读错误（中文，带全部尝试记录）。 */
export class QoderWasmUnavailableError extends Error {
  /** 每一步的尝试记录。 */
  readonly attempts: readonly QoderWasmAttempt[]

  constructor(attempts: readonly QoderWasmAttempt[]) {
    super(buildUnavailableMessage(attempts))
    this.name = 'QoderWasmUnavailableError'
    this.attempts = attempts
  }
}

/** 组装降级失败文案（导出以便单测逐字钉死，避免措辞漂移）。 */
export function buildUnavailableMessage(attempts: readonly QoderWasmAttempt[]): string {
  const reasons = attempts
    .filter((a) => !a.ok && a.error !== undefined)
    .map((a) => `${a.detail}：${a.error}`)
    .join('；')
  return (
    '未找到 Qoder 签名组件（wasm），已尝试本机安装与 npm 提取'
    + (reasons.length > 0 ? `。${reasons}` : '')
  )
}

// ── 纯函数（抠取与校验） ────────────────────────────────────────────────────

/** 计算 SHA-256（小写十六进制）。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 从 worker runtime 文本里抠出内联的 wasm 字节。
 *
 * 「定位 `AGFzbQ` → 向两侧扩展到引号/非 base64 边界」这条做法**不依赖偏移**，
 * 因此跨版本、跨 region、跨 obf/非 obf 产物都成立（实测四个来源的偏移各异）。
 *
 * 返回 `undefined` 表示这段文本里没有内联 wasm（例如国际版 npm 包的薄壳）。
 */
export function extractWasmFromWorkerText(text: string): Uint8Array | undefined {
  let from = 0
  for (;;) {
    const hit = text.indexOf(QODER_WASM_B64_PREFIX, from)
    if (hit === -1) return undefined
    let start = hit
    while (start > 0 && isBase64Char(text.charCodeAt(start - 1))) start -= 1
    let end = hit
    while (end < text.length && isBase64Char(text.charCodeAt(end))) end += 1
    const b64 = text.slice(start, end)
    // 只认「够大」的那一条：worker 里还有若干小 wasm（20 万 / 138 万字节），
    // 而签名组件是 298 606 字节 ⇒ base64 长约 398 144。
    if (b64.length >= 300_000) {
      const decoded = Buffer.from(b64, 'base64')
      if (decoded.length > 0 && decoded.subarray(0, 4).toString('hex') === '0061736d') {
        return new Uint8Array(decoded)
      }
    }
    from = end
  }
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b // +
    || code === 0x2f // /
    || code === 0x3d // =
  )
}

/**
 * 校验 wasm 字节是否为官方签名组件。
 *
 * 判据只有 SHA-256 一条（**不是长度**）—— 长度能挡住的只有手滑，挡不住
 * 「抠到了另一个小 wasm」这类真实错误。
 */
export function verifyQoderWasm(bytes: Uint8Array): { ok: true } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: 'wasm 字节为空' }
  const actual = sha256Hex(bytes)
  if (actual !== QODER_WASM_SHA256) {
    return {
      ok: false,
      reason: `SHA-256 不匹配（期望 ${QODER_WASM_SHA256}，实际 ${actual}，长度 ${bytes.length}）`,
    }
  }
  return { ok: true }
}

// ── 路径 ────────────────────────────────────────────────────────────────────

/** `~/.dsh` 下 wasm 缓存的绝对路径。 */
export function qoderWasmCachePath(homeDir: string = homedir()): string {
  return join(homeDir, '.dsh', QODER_WASM_CACHE_DIR, 'qoder_auth_wasm_bg.wasm')
}

// ── 默认注入面实现 ──────────────────────────────────────────────────────────

/** 默认的缓存读取（不存在 / 不可读一律返回 `undefined`）。 */
async function defaultReadCache(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
}

/** 默认的缓存写入：先写临时文件再原子替换，避免半截文件被下次读到。 */
async function defaultWriteCache(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, path)
}

/** 默认的本机 worker 文本读取。 */
function defaultReadLocalWorker(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 默认的 URL 拉取（带超时，返回字节）。 */
async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QODER_WASM_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 极简 tar.gz 成员提取：只服务「从官方 tarball 里取出 worker runtime」这一件事。
 *
 * 之所以不引第三方 tar 依赖：本插件对「不向全局安装 / 不新增重依赖」有约束，
 * 而这里只需要**顺序扫描 512 字节块头、按 `size` 跳过数据段**这一条规则
 * （ustar 格式）。gzip 解压交给 Node 内置 `zlib`。
 *
 * ⚠️ 只支持 ustar 的常规文件（typeflag `0` / `\0`）；官方产物就是这个形态。
 */
export async function extractFromTarGz(
  tarGz: Uint8Array,
  suffix: string,
): Promise<Uint8Array | undefined> {
  const { gunzipSync } = await import('node:zlib')
  const tar = gunzipSync(tarGz)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    // 全零块 = 归档结束。
    if (header.every((b) => b === 0)) break
    const name = readTarString(header, 0, 100)
    const sizeField = readTarString(header, 124, 12).trim()
    const size = sizeField.length > 0 ? parseInt(sizeField, 8) : 0
    const typeFlag = header[156]
    const dataStart = offset + 512
    if (Number.isNaN(size)) return undefined
    const isFile = typeFlag === 0 || typeFlag === 0x30
    if (isFile && name.endsWith(suffix)) {
      return new Uint8Array(tar.subarray(dataStart, dataStart + size))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

function readTarString(buf: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && buf[end] !== 0) end += 1
  return Buffer.from(buf.subarray(start, end)).toString('utf8')
}

/**
 * 从 npm registry 解析出指定包最新版的 tarball URL。
 *
 * 只读 `dist-tags.latest` + `versions[latest].dist.tarball` 两个字段 —— 不解析
 * 整个 packument（CN 包的 packument 有几十个版本，解析它纯属浪费）。
 */
export function parseNpmTarballUrl(packument: unknown): string | undefined {
  if (typeof packument !== 'object' || packument === null) return undefined
  const record = packument as Record<string, unknown>
  const distTags = record['dist-tags']
  if (typeof distTags !== 'object' || distTags === null) return undefined
  const latest = (distTags as Record<string, unknown>).latest
  if (typeof latest !== 'string' || latest.length === 0) return undefined
  const versions = record.versions
  if (typeof versions !== 'object' || versions === null) return undefined
  const version = (versions as Record<string, unknown>)[latest]
  if (typeof version !== 'object' || version === null) return undefined
  const dist = (version as Record<string, unknown>).dist
  if (typeof dist !== 'object' || dist === null) return undefined
  const tarball = (dist as Record<string, unknown>).tarball
  return typeof tarball === 'string' && tarball.length > 0 ? tarball : undefined
}

// ── 提取主流程 ──────────────────────────────────────────────────────────────

/**
 * 按三级优先级提取官方 wasm。
 *
 * 顺序是**缓存 → 本机安装 → npm → CDN**（缓存不是「第四级」，它是快路径：
 * 命中即返回，避免每次启动都去扫描 35 MB 的 worker 文本）。
 *
 * 任一级拿到字节都会先过 {@link verifyQoderWasm}：**哈希不过就当这一级失败**、
 * 继续降级，而不是把可疑字节用起来 —— 「校验不匹配就用」等于没有校验。
 *
 * 全部失败时抛 {@link QoderWasmUnavailableError}，错误里带每一级的尝试记录。
 */
export async function extractQoderWasm(
  options: QoderWasmExtractOptions,
): Promise<QoderWasmArtifact> {
  const { product } = options
  const homeDir = options.homeDir ?? homedir()
  const readCache = options.readCache ?? defaultReadCache
  const writeCache = options.writeCache ?? defaultWriteCache
  const readLocalWorker = options.readLocalWorker ?? defaultReadLocalWorker
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes
  const fromTarball = options.extractFromTarball ?? extractFromTarGz
  const attempts: QoderWasmAttempt[] = []

  const accept = (
    bytes: Uint8Array,
    source: QoderWasmSource,
    detail: string,
  ): QoderWasmArtifact => ({ bytes, source, detail })

  // ── 缓存 ──
  const cachePath = qoderWasmCachePath(homeDir)
  {
    let cached: Uint8Array | undefined
    try {
      cached = await readCache(cachePath)
    } catch (error) {
      cached = undefined
      attempts.push({
        source: 'cache',
        detail: cachePath,
        ok: false,
        error: describeError(error),
      })
    }
    if (cached !== undefined) {
      const verdict = verifyQoderWasm(cached)
      if (verdict.ok) return accept(cached, 'cache', cachePath)
      // 哈希不过：删掉不可用缓存不是本层职责（写缓存入口会覆盖它），
      // 但要**记下来**——否则「为什么每次都重新下载」无从排查。
      attempts.push({ source: 'cache', detail: cachePath, ok: false, error: verdict.reason })
    } else {
      attempts.push({ source: 'cache', detail: cachePath, ok: false, error: '缓存不存在' })
    }
  }

  const cacheAndReturn = async (
    bytes: Uint8Array,
    source: QoderWasmSource,
    detail: string,
  ): Promise<QoderWasmArtifact> => {
    attempts.push({ source, detail, ok: true })
    try {
      await writeCache(cachePath, bytes)
    } catch (error) {
      // 缓存写入失败**不影响本次使用**：字节已经在手，只是下次要重新提取。
      attempts.push({
        source: 'cache',
        detail: cachePath,
        ok: false,
        error: `写缓存失败：${describeError(error)}`,
      })
    }
    return accept(bytes, source, detail)
  }

  // ── ① 本机已装 Qoder ──
  const localDirs = options.localDirs ?? qoderWasmLocalInstallDirs()
  const packageNames = localPackageNames(product)
  for (const dir of localDirs) {
    for (const pkg of packageNames) {
      for (const entry of QODER_WASM_WORKER_ENTRIES) {
        const workerPath = join(dir, 'resources', 'app.asar.unpacked', 'node_modules', pkg, 'dist', '_worker', entry)
        const text = readLocalWorker(workerPath)
        if (text === undefined) continue
        const bytes = extractWasmFromWorkerText(text)
        if (bytes === undefined) {
          attempts.push({
            source: 'local-install',
            detail: workerPath,
            ok: false,
            error: 'worker 内未找到内联 wasm',
          })
          continue
        }
        const verdict = verifyQoderWasm(bytes)
        if (!verdict.ok) {
          attempts.push({ source: 'local-install', detail: workerPath, ok: false, error: verdict.reason })
          continue
        }
        return cacheAndReturn(bytes, 'local-install', workerPath)
      }
    }
  }
  attempts.push({
    source: 'local-install',
    detail: '本机 Qoder 安装目录',
    ok: false,
    error: '未找到可用的 worker runtime',
  })

  // ── ② npm tarball ──
  const npmPackage = QODER_WASM_NPM_PACKAGES[product.id]
  if (npmPackage !== undefined) {
    for (const registry of QODER_WASM_REGISTRIES) {
      const metaUrl = `${registry}/${npmPackage.replace('/', '%2F')}`
      try {
        const metaBytes = await fetchBytes(metaUrl)
        const packument: unknown = JSON.parse(Buffer.from(metaBytes).toString('utf8'))
        const tarballUrl = parseNpmTarballUrl(packument)
        if (tarballUrl === undefined) {
          attempts.push({
            source: 'npm-tarball',
            detail: metaUrl,
            ok: false,
            error: 'registry 响应里没有可用 tarball URL',
          })
          continue
        }
        const tarGz = await fetchBytes(tarballUrl)
        const worker = await fromTarball(tarGz, 'qoder-worker-runtime')
        if (worker === undefined) {
          // 国际版包就是这个形态：薄壳 + postinstall，worker 在安装期才下载。
          attempts.push({
            source: 'npm-tarball',
            detail: tarballUrl,
            ok: false,
            error: 'tarball 内没有 worker runtime（该包只在安装期下载它）',
          })
          continue
        }
        const text = Buffer.from(worker).toString('utf8')
        const bytes = extractWasmFromWorkerText(text)
        if (bytes === undefined) {
          attempts.push({
            source: 'npm-tarball',
            detail: tarballUrl,
            ok: false,
            error: 'worker 内未找到内联 wasm',
          })
          continue
        }
        const verdict = verifyQoderWasm(bytes)
        if (!verdict.ok) {
          attempts.push({ source: 'npm-tarball', detail: tarballUrl, ok: false, error: verdict.reason })
          continue
        }
        return cacheAndReturn(bytes, 'npm-tarball', tarballUrl)
      } catch (error) {
        attempts.push({ source: 'npm-tarball', detail: metaUrl, ok: false, error: describeError(error) })
      }
    }
  }

  // ── ③ 官方 CDN ──
  for (const version of QODER_WASM_CDN_VERSIONS) {
    const url = `${QODER_WASM_CDN_BASE}/${version}/${QODER_WASM_CDN_ARTIFACT.replace('{target}', QODER_WASM_CDN_TARGET)}`
    try {
      const tarGz = await fetchBytes(url)
      const worker = await fromTarball(tarGz, 'qoder-worker-runtime')
      if (worker === undefined) {
        attempts.push({ source: 'cdn-tarball', detail: url, ok: false, error: 'tarball 内没有 worker runtime' })
        continue
      }
      const text = Buffer.from(worker).toString('utf8')
      const bytes = extractWasmFromWorkerText(text)
      if (bytes === undefined) {
        attempts.push({ source: 'cdn-tarball', detail: url, ok: false, error: 'worker 内未找到内联 wasm' })
        continue
      }
      const verdict = verifyQoderWasm(bytes)
      if (!verdict.ok) {
        attempts.push({ source: 'cdn-tarball', detail: url, ok: false, error: verdict.reason })
        continue
      }
      return cacheAndReturn(bytes, 'cdn-tarball', url)
    } catch (error) {
      attempts.push({ source: 'cdn-tarball', detail: url, ok: false, error: describeError(error) })
    }
  }

  throw new QoderWasmUnavailableError(attempts)
}

/** worker runtime 的文件名候选（dev 与正式两个形态）。 */
export const QODER_WASM_WORKER_ENTRIES: readonly string[] = [
  'qoder-worker-runtime.obf.mjs',
  'qoder-worker-runtime.mjs',
]

/**
 * 本机目录里该 region 的包名候选。
 *
 * ⚠️ 国际版的包名在**本机目录里**是 `qoder-agent-sdk`，而 CN 是
 * `qoder-cn-agent-sdk` —— 与 npm 上的名字（{@link QODER_WASM_NPM_PACKAGES}）
 * **不是一个体系**：CN 的 npm 包叫 `@qodercn-ai/qoderclicn`。两者都试，
 * 因为「本机装的是哪个形态」不由我们决定。
 */
export function localPackageNames(product: QoderProduct): readonly string[] {
  return product.id === 'qoder-cn'
    ? ['@qoder-ai/qoder-cn-agent-sdk', '@qoder-ai/qoder-agent-sdk']
    : ['@qoder-ai/qoder-agent-sdk']
}

/**
 * CDN 版本候选。
 *
 * ⚠️ 刻意**不写死单一版本**：官方产物的版本随 CLI 发版漂移，而 wasm 的哈希
 * 跨版本稳定（实测 1.1.57 与 1.1.59 同值），所以「多试几个版本、哈希把关」
 * 比「猜一个版本」稳。列表来自 `runtime-manifest.json` 的实测值与兜底值。
 */
export const QODER_WASM_CDN_VERSIONS: readonly string[] = ['1.1.59', '1.1.57']

/** CDN 的平台 token（⚠️ Go 风格，不是 `windows-x64`）。 */
export const QODER_WASM_CDN_TARGET = 'win32-x64'

/** 把任意异常收敛成一行可读文案。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return `请求超时（${QODER_WASM_FETCH_TIMEOUT_MS}ms）`
    return error.message
  }
  return String(error)
}
