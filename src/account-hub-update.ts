/** Account Hub 插件的检查更新与安装逻辑。 */

import { join } from 'node:path'
import type { RpcUpdateApplyResponse, RpcUpdateCheckResponse } from './types.js'

const RELEASES_LATEST_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest'
const COMMIT_BY_TAG_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/'
const TARBALL_URL_PREFIX = 'https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/'
const ACCOUNT_HUB_GITHUB_PIN = 'github:gurio-wine/dsh-account-hub'
export const ACCOUNT_HUB_UPDATE_TIMEOUT_MS = 120_000

export interface AccountHubUpdateProcessOutput {
  stdout: string
  stderr: string
}

export interface AccountHubUpdateExecOptions {
  cwd: string
  timeoutMs: number
}

export type AccountHubUpdateExec = (
  command: string,
  args: readonly string[],
  options: AccountHubUpdateExecOptions,
) => Promise<AccountHubUpdateProcessOutput>

/** 检查与应用更新所需的外部依赖；单测通过此接口替换路径、文件、网络和子进程。 */
export interface AccountHubUpdateDeps {
  profileRoot: string
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  fetcher: typeof fetch
  exec: AccountHubUpdateExec
}

/**
 * 从 pnpm-lock.yaml 的 dependencies 下定位 dsh-account-hub tarball，并提取完整 commit SHA。
 * 对外保持既有严格行为；半卸载状态的检查与应用使用内部 nullable 查找器。
 */
export function extractAccountHubSha(lockfile: string): string {
  const sha = findAccountHubSha(lockfile)
  if (sha !== null) return sha
  if (!/^[ \t]*dependencies:\s*(?:#.*)?$/m.test(lockfile)) {
    throw new Error('pnpm-lock.yaml 格式无效：找不到 dependencies 段')
  }
  throw new Error('pnpm-lock.yaml dependencies 段中找不到 dsh-account-hub')
}

/** 找不到目标依赖时返回 null；目标条目存在但格式错误仍抛出原有错误。 */
function findAccountHubSha(lockfile: string): string | null {
  const lines = lockfile.split(/\r?\n/)

  for (let sectionIndex = 0; sectionIndex < lines.length; sectionIndex += 1) {
    const sectionMatch = lines[sectionIndex].match(/^([ \t]*)dependencies:\s*(?:#.*)?$/)
    if (sectionMatch === null) continue

    const sectionIndent = sectionMatch[1].length
    let sectionEnd = sectionIndex + 1
    while (sectionEnd < lines.length) {
      const line = lines[sectionEnd]
      if (line.trim() === '') {
        sectionEnd += 1
        continue
      }
      if (leadingWhitespaceLength(line) <= sectionIndent) break
      sectionEnd += 1
    }

    for (let packageIndex = sectionIndex + 1; packageIndex < sectionEnd; packageIndex += 1) {
      const packageMatch = lines[packageIndex].match(/^([ \t]*)dsh-account-hub:\s*(.*)$/)
      if (packageMatch === null || packageMatch[1].length <= sectionIndent) continue

      const packageIndent = packageMatch[1].length
      let packageEnd = packageIndex + 1
      while (packageEnd < sectionEnd) {
        const line = lines[packageEnd]
        if (line.trim() !== '' && leadingWhitespaceLength(line) <= packageIndent) break
        packageEnd += 1
      }
      const packageBlock = [packageMatch[2], ...lines.slice(packageIndex + 1, packageEnd)].join('\n')
      const shaMatch = packageBlock.match(
        /https:\/\/codeload\.github\.com\/gurio-wine\/dsh-account-hub\/tar\.gz\/([0-9a-f]{40})(?=$|[\s"'#?&])/i,
      )
      if (shaMatch === null) {
        throw new Error('pnpm-lock.yaml 中 dsh-account-hub 的 tarball URL 格式无效，无法提取 40 位 SHA')
      }
      return shaMatch[1].toLowerCase()
    }

    sectionIndex = sectionEnd - 1
  }

  return null
}

/** 查询 GitHub 最新 release，并通过 commits/{tag} 解析其 commit SHA。 */
async function fetchLatestRelease(
  deps: AccountHubUpdateDeps,
): Promise<{ sha: string; tag: string; title: string }> {
  try {
    const releaseResponse = await deps.fetcher(RELEASES_LATEST_URL, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!releaseResponse.ok) {
      if (releaseResponse.status === 404) {
        throw new Error('尚无 GitHub release，无法检查更新（发首个 release 后可检查）')
      }
      throw new Error(`GitHub Releases API 返回 HTTP ${releaseResponse.status}`)
    }

    const releaseBody: unknown = await releaseResponse.json()
    if (typeof releaseBody !== 'object' || releaseBody === null) {
      throw new Error('GitHub Releases API 响应不是对象')
    }
    const release = releaseBody as { tag_name?: unknown; name?: unknown }
    if (typeof release.tag_name !== 'string' || release.tag_name.trim().length === 0) {
      throw new Error('GitHub Release 响应缺少有效的 tag_name')
    }
    const tag = release.tag_name
    const title = typeof release.name === 'string' && release.name.length > 0
      ? release.name
      : tag

    // 使用 commits/{tag} 直接取得 commit 本体；git/ref/tags/{tag} 对 annotated tag 会返回 tag 对象 SHA。
    const commitResponse = await deps.fetcher(`${COMMIT_BY_TAG_URL_PREFIX}${encodeURIComponent(tag)}`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!commitResponse.ok) {
      throw new Error(`GitHub commits API 返回 HTTP ${commitResponse.status}（tag ${tag}）`)
    }

    const commitBody: unknown = await commitResponse.json()
    if (typeof commitBody !== 'object' || commitBody === null) {
      throw new Error('GitHub commits API 响应不是对象')
    }
    const commit = commitBody as { sha?: unknown }
    if (typeof commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
      throw new Error('GitHub commits API 响应缺少有效的 40 位 SHA')
    }
    return { sha: commit.sha.toLowerCase(), tag, title }
  } catch (error) {
    throw new Error(`无法获取最新版本：${errorMessage(error)}`)
  }
}

/** 查询当前安装 SHA 与 GitHub master，并返回客户端面板使用的字段。 */
export async function checkAccountHubUpdate(deps: AccountHubUpdateDeps): Promise<RpcUpdateCheckResponse> {
  const lockfile = await deps.readFile(join(deps.profileRoot, 'pnpm-lock.yaml'))
  const currentSha = findAccountHubSha(lockfile) ?? ''
  const latest = await fetchLatestRelease(deps)
  return {
    currentSha,
    latestSha: latest.sha,
    latestTag: latest.tag,
    hasUpdate: currentSha === '' || currentSha !== latest.sha,
    latestTitle: latest.title,
  }
}

/**
 * 在 profile 根的 allowBuilds 下添加指定 tarball 的构建许可；同一条目重复调用不改文件。
 */
export function appendAccountHubAllowBuild(dependenciesFile: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('待安装版本不是有效的 40 位 SHA')
  const normalizedSha = sha.toLowerCase()
  const tarballUrl = `${TARBALL_URL_PREFIX}${normalizedSha}`
  const key = `dsh-account-hub@${tarballUrl}`
  const newline = dependenciesFile.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = /\r?\n$/.test(dependenciesFile)
  const lines = dependenciesFile.split(/\r?\n/)
  if (endsWithNewline) lines.pop()

  const sectionIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^([ \t]*)allowBuilds:\s*(?:#.*)?$/.test(lines[index])) sectionIndices.push(index)
  }
  if (sectionIndices.length > 1) throw new Error('pnpm-workspace.yaml 中存在多个 allowBuilds 段')

  const sectionIndex = sectionIndices[0]
  if (sectionIndex !== undefined) {
    const sectionIndent = leadingWhitespaceLength(lines[sectionIndex])
    let sectionEnd = sectionIndex + 1
    while (sectionEnd < lines.length) {
      const line = lines[sectionEnd]
      if (line.trim() !== '' && leadingWhitespaceLength(line) <= sectionIndent) break
      sectionEnd += 1
    }

    const entryPrefix = `${key}:`
    for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
      const line = lines[index]
      const trimmed = line.trimStart()
      if (!trimmed.startsWith(entryPrefix)) continue
      const value = trimmed.slice(entryPrefix.length).trim()
      if (/^true(?:\s+#.*)?$/.test(value)) return dependenciesFile
      if (/^false(?:\s+#.*)?$/.test(value)) {
        const comment = value.match(/\s+#.*$/)?.[0] ?? ''
        lines[index] = `${line.slice(0, line.length - trimmed.length)}${entryPrefix} true${comment}`
        return joinLines(lines, newline, endsWithNewline)
      }
    }

    const childIndent = lines
      .slice(sectionIndex + 1, sectionEnd)
      .find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    const indent = childIndent === undefined
      ? ' '.repeat(sectionIndent + 2)
      : ' '.repeat(leadingWhitespaceLength(childIndent))
    lines.splice(sectionEnd, 0, `${indent}${key}: true`)
    return joinLines(lines, newline, endsWithNewline)
  }

  const content = joinLines(lines, newline, endsWithNewline)
  const separator = content.length > 0 && !content.endsWith(newline) ? newline : ''
  const appended = `${content}${separator}allowBuilds:${newline}  ${key}: true`
  return `${appended}${endsWithNewline ? newline : ''}`
}

/**
 * 应用最新更新。先取最新 SHA；无需更新时短路，否则执行 pnpm 并验证 lockfile 已切到目标 SHA。
 */
export async function applyAccountHubUpdate(deps: AccountHubUpdateDeps): Promise<RpcUpdateApplyResponse> {
  const latest = await fetchLatestRelease(deps)
  const lockPath = join(deps.profileRoot, 'pnpm-lock.yaml')
  const previousSha = findAccountHubSha(await deps.readFile(lockPath)) ?? ''
  if (previousSha !== '' && latest.sha === previousSha) return { previousSha, currentSha: previousSha, log: '' }

  const packagePath = join(deps.profileRoot, 'package.json')
  const workspacePath = join(deps.profileRoot, 'pnpm-workspace.yaml')
  const packageJson = await deps.readFile(packagePath)
  const hasAccountHubDependency = /"dsh-account-hub"\s*:/.test(packageJson)
  const execOptions = {
    cwd: deps.profileRoot,
    timeoutMs: ACCOUNT_HUB_UPDATE_TIMEOUT_MS,
  }

  let removeLog = ''
  if (hasAccountHubDependency) {
    let removeOutput: AccountHubUpdateProcessOutput
    try {
      removeOutput = await deps.exec('pnpm', ['remove', 'dsh-account-hub'], execOptions)
    } catch (error) {
      throwWithLog(error, formatInstallLog(processOutputFromError(error)))
    }
    removeLog = formatInstallLog(removeOutput)
  }

  // pnpm remove 会删除 package.json 中的依赖字段，pnpm add 本身会写入带 SHA 的 pin；
  // 手工再写 pin 不仅冗余，还会在 remove 之后因字段不存在而必然失败。
  const workspace = await deps.readFile(workspacePath)
  const updatedWorkspace = appendAccountHubAllowBuild(workspace, latest.sha)
  if (updatedWorkspace !== workspace) await deps.writeFile(workspacePath, updatedWorkspace)

  let addOutput: AccountHubUpdateProcessOutput
  try {
    addOutput = await deps.exec(
      'pnpm',
      ['add', `${ACCOUNT_HUB_GITHUB_PIN}#${latest.sha}`, '--config.minimum-release-age=0'],
      execOptions,
    )
  } catch (error) {
    throwWithLog(error, joinInstallLogs(removeLog, formatInstallLog(processOutputFromError(error))))
  }
  const log = joinInstallLogs(removeLog, formatInstallLog(addOutput))

  let currentSha: string
  try {
    currentSha = extractAccountHubSha(await deps.readFile(lockPath))
  } catch (error) {
    throwWithLog(error, log)
  }
  if (currentSha !== latest.sha) {
    throwWithLog(
      new Error(`更新后 lockfile 未切换到最新版本（期望 ${latest.sha}，实际 ${currentSha}）`),
      log,
    )
  }
  return { previousSha, currentSha, log }
}

function leadingWhitespaceLength(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

function joinLines(lines: string[], newline: string, endsWithNewline: boolean): string {
  return `${lines.join(newline)}${endsWithNewline ? newline : ''}`
}

function joinInstallLogs(...logs: string[]): string {
  return logs.filter((log) => log.length > 0).join('\n')
}

function formatInstallLog(output: AccountHubUpdateProcessOutput): string {
  const sections: string[] = []
  if (output.stdout.length > 0) sections.push(`stdout:\n${output.stdout}`)
  if (output.stderr.length > 0) sections.push(`stderr:\n${output.stderr}`)
  return sections.join('\n')
}

function processOutputFromError(error: unknown): AccountHubUpdateProcessOutput {
  if (typeof error !== 'object' || error === null) return { stdout: '', stderr: '' }
  const output = error as { stdout?: unknown; stderr?: unknown }
  return {
    stdout: typeof output.stdout === 'string' ? output.stdout : '',
    stderr: typeof output.stderr === 'string' ? output.stderr : '',
  }
}

function throwWithLog(error: unknown, log: string): never {
  const message = errorMessage(error)
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined
  const original = typeof code === 'string' || typeof code === 'number'
    ? `${message} (code ${code})`
    : message
  throw new Error(log.length > 0 ? `${original}\n\n${log}` : original)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
