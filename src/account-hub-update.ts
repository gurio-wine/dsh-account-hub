/** Account Hub 插件的检查更新与安装逻辑。 */

import { join } from 'node:path'
import type { RpcUpdateApplyResponse, RpcUpdateCheckResponse } from './types.js'

const GITHUB_COMMIT_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/master'
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
 * 使用行级缩进配合正则读取目标依赖块，避免误取其它包或其它 YAML 区段中的 SHA。
 */
export function extractAccountHubSha(lockfile: string): string {
  const lines = lockfile.split(/\r?\n/)
  let sawDependencies = false
  let sawPackage = false

  for (let sectionIndex = 0; sectionIndex < lines.length; sectionIndex += 1) {
    const sectionMatch = lines[sectionIndex].match(/^([ \t]*)dependencies:\s*(?:#.*)?$/)
    if (sectionMatch === null) continue
    sawDependencies = true

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
      sawPackage = true

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

  if (!sawDependencies) {
    throw new Error('pnpm-lock.yaml 格式无效：找不到 dependencies 段')
  }
  if (!sawPackage) {
    throw new Error('pnpm-lock.yaml dependencies 段中找不到 dsh-account-hub')
  }
  throw new Error('pnpm-lock.yaml 中 dsh-account-hub 的 tarball URL 格式无效，无法提取 40 位 SHA')
}

/** 查询 GitHub master 最新提交；检查与安装共用该查询和校验逻辑。 */
async function fetchLatestCommit(deps: AccountHubUpdateDeps): Promise<{ sha: string; title: string }> {
  try {
    const response = await deps.fetcher(GITHUB_COMMIT_URL, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`GitHub API 返回 HTTP ${response.status}`)

    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) throw new Error('GitHub API 响应不是对象')
    const commit = body as { sha?: unknown; commit?: { message?: unknown } }
    if (typeof commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
      throw new Error('GitHub API 响应缺少有效的 40 位 SHA')
    }
    if (typeof commit.commit?.message !== 'string') {
      throw new Error('GitHub API 响应缺少提交说明')
    }
    return {
      sha: commit.sha.toLowerCase(),
      title: commit.commit.message.split(/\r?\n/, 1)[0],
    }
  } catch (error) {
    throw new Error(`无法获取最新版本：${errorMessage(error)}`)
  }
}

/** 查询当前安装 SHA 与 GitHub master，并返回客户端面板使用的字段。 */
export async function checkAccountHubUpdate(deps: AccountHubUpdateDeps): Promise<RpcUpdateCheckResponse> {
  const lockfile = await deps.readFile(join(deps.profileRoot, 'pnpm-lock.yaml'))
  const currentSha = extractAccountHubSha(lockfile)
  const latest = await fetchLatestCommit(deps)
  return {
    currentSha,
    latestSha: latest.sha,
    hasUpdate: currentSha !== latest.sha,
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
 * 把 profile package.json 中的 dsh-account-hub GitHub pin 改成目标 SHA。
 * 只替换字段值，保留其余字节、键顺序、缩进和换行，避免破坏 profile 启动文件；目标值相同则原样返回。
 */
export function writeAccountHubPin(packageJsonContent: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('待写入版本不是有效的 40 位 SHA')
  const normalizedSha = sha.toLowerCase()
  const targetPin = `${ACCOUNT_HUB_GITHUB_PIN}#${normalizedSha}`
  const pinMatch = packageJsonContent.match(/("dsh-account-hub"\s*:\s*")([^"]*)"/)
  if (pinMatch === null || pinMatch.index === undefined) {
    throw new Error('package.json 中找不到 dsh-account-hub pin 字段')
  }

  const currentPin = pinMatch[2]
  if (currentPin === targetPin) return packageJsonContent
  if (!new RegExp(`^${ACCOUNT_HUB_GITHUB_PIN}(?:#[0-9a-f]{40})?$`, 'i').test(currentPin)) {
    throw new Error(`package.json 中 dsh-account-hub pin 格式无效：${currentPin}`)
  }

  const valueStart = pinMatch.index + pinMatch[1].length
  const valueEnd = valueStart + currentPin.length
  return `${packageJsonContent.slice(0, valueStart)}${targetPin}${packageJsonContent.slice(valueEnd)}`
}

/**
 * 应用最新更新。先取最新 SHA；无需更新时短路，否则执行 pnpm 并验证 lockfile 已切到目标 SHA。
 */
export async function applyAccountHubUpdate(deps: AccountHubUpdateDeps): Promise<RpcUpdateApplyResponse> {
  const latest = await fetchLatestCommit(deps)
  const lockPath = join(deps.profileRoot, 'pnpm-lock.yaml')
  const previousSha = extractAccountHubSha(await deps.readFile(lockPath))
  if (latest.sha === previousSha) return { previousSha, currentSha: previousSha, log: '' }

  const packagePath = join(deps.profileRoot, 'package.json')
  const workspacePath = join(deps.profileRoot, 'pnpm-workspace.yaml')
  const execOptions = {
    cwd: deps.profileRoot,
    timeoutMs: ACCOUNT_HUB_UPDATE_TIMEOUT_MS,
  }

  let removeOutput: AccountHubUpdateProcessOutput
  try {
    removeOutput = await deps.exec('pnpm', ['remove', 'dsh-account-hub'], execOptions)
  } catch (error) {
    throwWithLog(error, formatInstallLog(processOutputFromError(error)))
  }
  const removeLog = formatInstallLog(removeOutput)

  const packageJson = await deps.readFile(packagePath)
  const updatedPackageJson = writeAccountHubPin(packageJson, latest.sha)
  if (updatedPackageJson !== packageJson) await deps.writeFile(packagePath, updatedPackageJson)

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
