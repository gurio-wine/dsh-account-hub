/**
 * 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的**导出面现算**。
 *
 * ## 为什么需要它
 *
 * 客户端 bundle 把该模块声明为 `external`（它是宿主经 `PLATFORM_MODULES` 注入的
 * 隐式 baseline，理由见 `build.mjs` 的注释）。代价是：**没有任何一道既有闸门知道
 * 「插件 import 的名字在宿主里是否还存在」** ——
 *
 * - esbuild 不解析 external 模块的导出，只把 import 改写成属性访问；
 * - `tsconfig.json` 的 include 只有 `src/`，看不见 `plugin-src/`；
 * - vitest 只跑 `tests/unit/**`，而那里的替身是手工硬编码的名单。
 *
 * 宿主 commit `4937343a5e`（"unify the client visual language"）把整套图标 API 改名
 * （`IconApiOutline14` → `IconApiOutlineRegular`、`IconBranchOutline16` →
 * `IconBranchOutlineRegular`、`IconChevronDownOutline14` →
 * `IconChevronDownOutlineRegular`），插件侧照旧 import 旧名：产物能构建、能冒烟
 * （顶层求值不碰图标），直到用户打开设置页才 `React.createElement(undefined)`
 * 抛 "Element type is invalid" —— 整个账号中心面板白屏。
 *
 * 本模块是**构建期闸门**（`build.mjs`）与**测试替身闸门**
 * （`tests/unit/fixtures/ui-primitives-stub.ts`）共用的唯一真相源读取器：从构建机器
 * 上的宿主 checkout 读出真实导出名单，两边都拿它核对，杜绝同类漂移再次静默通过。
 *
 * ## 宿主不在时**不抛错**
 *
 * 宿主是同级的另一个 checkout（默认 `../deepseek-harness/packages/client/ui-primitives`，
 * 可用 `DSH_UI_PRIMITIVES_DIR` 覆盖），在别人的机器 / CI 上未必存在。故这里找不到
 * 就返回 `null`，由两个调用方各自决定降级行为（构建期 warn 后跳过校验，测试期回退
 * 到替身自己的最小手工名单）。**校验闸门绝不能让「没有宿主 checkout 的环境」构建失败。**
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件仓库根目录（本文件位于 `<root>/plugin-src/client/`）。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 宿主包在仓库内的相对路径。 */
const HOST_PACKAGE_PATH = ['packages', 'client', 'ui-primitives']

/**
 * 宿主 ui-primitives 包的候选目录，按优先级排列。
 *
 * @returns 绝对路径数组。
 */
function candidateDirectories() {
  const candidates = []
  const fromEnvironment = process.env.DSH_UI_PRIMITIVES_DIR
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    candidates.push(resolve(fromEnvironment.trim()))
  }
  // 同一台机器上两个仓库通常并排 checkout；`deepseek-harness` 是宿主仓库名。
  candidates.push(resolve(packageRoot, '..', 'deepseek-harness', ...HOST_PACKAGE_PATH))
  return candidates
}

/**
 * 从宿主**构建产物** `lib/index.js` 读取导出名单。
 *
 * 产物优于源码：tsdown 打平后只剩一条扁平的 `export { … }`，且类型导出已被擦除，
 * 拿到的正是**运行时真实存在的导出面**（源码读法拿不到 `export * from './icons/index.tsx'`
 * 展开出来的三百多个图标名）。
 *
 * @param file `lib/index.js` 绝对路径。
 * @returns 导出名数组；文件不可读时返回 null。
 */
function readExportNamesFromBundle(file) {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const names = new Set()
  // 取全部 `export { … }` 块（打包产物通常只有末尾一条；取并集对「名字是否存在」更稳）
  for (const block of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of block[1].split(',')) {
      // `type X` 是类型导出（产物里一般已擦除），去掉前缀后仍需存在才算值导出
      const spec = raw.trim().replace(/^type\s+/, '')
      if (spec === '') continue
      // `A as B` 取对外暴露的 B
      const parts = spec.split(/\s+as\s+/)
      const exported = (parts[1] ?? parts[0]).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported)
    }
  }
  return names.size > 0 ? [...names].sort() : null
}

/**
 * 从宿主**源码**读取导出名单（产物不存在时的回退）。
 *
 * 支持 `export const/let/var/function/class/enum`、`export { A, B as C }`（含 `from`）
 * 与 `export * from './x.ts'` 的递归展开。`export type { … }` / `export interface` /
 * `export type X =` 一律不收 —— 它们是类型导出，运行时并不存在，收进来只会让闸门更松。
 *
 * @param file 模块文件绝对路径。
 * @param seen 已访问文件集合（防 `export *` 环）。
 * @returns 导出名数组。
 */
function readExportNamesFromSource(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  const names = new Set()

  // export * from './x.ts' —— 递归展开（icons 桶就是靠这一条暴露三百多个图标名）
  for (const match of text.matchAll(/^export\s+\*\s+from\s+'([^']+)'/gm)) {
    const target = resolve(dirname(file), match[1])
    for (const name of readExportNamesFromSource(target, seen)) names.add(name)
  }

  // export { A, B as C } [from './x.ts'] —— 只看名字，不回源目标文件
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of match[1].split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '')
      if (spec === '') continue
      const parts = spec.split(/\s+as\s+/)
      const exported = (parts[1] ?? parts[0]).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported)
    }
  }

  // export const/let/var/function/class/enum X
  for (const match of text.matchAll(
    /^export\s+(?:declare\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1])
  }

  return [...names]
}

/**
 * 定位宿主 ui-primitives 包并读出它的导出名单。
 *
 * @returns `{ dir, origin, names }`；宿主 checkout 不存在或读不出导出名单时返回 null。
 *   `origin` 是名单来源（`lib/index.js` 或 `src/index.ts`），供调用方写进提示信息。
 */
export function readHostExportNames() {
  for (const dir of candidateDirectories()) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue

    const bundle = resolve(dir, 'lib/index.js')
    const fromBundle = readExportNamesFromBundle(bundle)
    if (fromBundle !== null) return { dir, origin: 'lib/index.js', names: fromBundle }

    const source = resolve(dir, 'src/index.ts')
    const fromSource = readExportNamesFromSource(source)
    if (fromSource.length > 0) return { dir, origin: 'src/index.ts', names: fromSource.sort() }
  }
  return null
}
