import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  appendAccountHubAllowBuild,
  applyAccountHubUpdate,
  checkAccountHubUpdate,
  extractAccountHubSha,
  type AccountHubUpdateDeps,
  type AccountHubUpdateExec,
} from '../../src/account-hub-update.js'

const PROFILE_ROOT = 'C:\\fake-profile'
const CURRENT_SHA = 'a'.repeat(40)
const LATEST_SHA = 'b'.repeat(40)
const LATEST_TAG = 'v0.2.0'
const ACCOUNT_HUB_PIN = 'github:gurio-wine/dsh-account-hub'
const LOCK_PATH = join(PROFILE_ROOT, 'pnpm-lock.yaml')
const PACKAGE_PATH = join(PROFILE_ROOT, 'package.json')
const WORKSPACE_PATH = join(PROFILE_ROOT, 'pnpm-workspace.yaml')

function makeLockfile(sha: string): string {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      dsh-account-hub:',
    '        specifier: https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/' + sha,
    '        version: https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/' + sha,
    'packages:',
    '',
  ].join('\n')
}

function makeLockfileWithoutAccountHub(): string {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      other-package:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    'packages:',
    '',
  ].join('\n')
}

function makePackageJson(pin = ACCOUNT_HUB_PIN): string {
  return [
    '{',
    '  "name": "fake-profile",',
    '  "dependencies": {',
    `    "dsh-account-hub": "${pin}",`,
    '    "other-package": "1.0.0"',
    '  },',
    '  "scripts": {',
    '    "start": "dsh"',
    '  }',
    '}',
    '',
  ].join('\n')
}

function makeReleaseResponse(tag: string, name: string | undefined, status = 200): Response {
  const body: { tag_name: string; name?: string } = { tag_name: tag }
  if (name !== undefined) body.name = name
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCommitResponse(sha: string, message = '提交说明'): Response {
  return new Response(JSON.stringify({ sha, commit: { message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeDeps(options: {
  lockfile?: string
  packageJson?: string
  workspace?: string
  latestSha?: string
  latestTag?: string
  releaseName?: string
  omitReleaseName?: boolean
  releaseStatus?: number
  exec?: AccountHubUpdateExec
} = {}): {
  deps: AccountHubUpdateDeps
  files: Map<string, string>
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  exec: ReturnType<typeof vi.fn<AccountHubUpdateExec>>
} {
  const latestSha = options.latestSha ?? LATEST_SHA
  const latestTag = options.latestTag ?? LATEST_TAG
  const releaseName = options.omitReleaseName ? undefined : options.releaseName ?? '更新标题'
  const files = new Map<string, string>([
    [LOCK_PATH, options.lockfile ?? makeLockfile(CURRENT_SHA)],
    [PACKAGE_PATH, options.packageJson ?? makePackageJson()],
    [WORKSPACE_PATH, options.workspace ?? 'allowBuilds:\n  esbuild: true\n'],
  ])
  const readFile = vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  const writeFile = vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input) === 'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest') {
      return makeReleaseResponse(latestTag, releaseName, options.releaseStatus ?? 200)
    }
    return makeCommitResponse(latestSha)
  })
  const defaultExec: AccountHubUpdateExec = async (_command, args) => {
    if (args[0] === 'add') {
      files.set(LOCK_PATH, makeLockfile(latestSha))
      files.set(PACKAGE_PATH, makePackageJson(`${ACCOUNT_HUB_PIN}#${latestSha}`))
    }
    return args[0] === 'remove'
      ? { stdout: '卸载完成\n', stderr: '' }
      : { stdout: '安装完成\n', stderr: '' }
  }
  const exec = vi.fn<AccountHubUpdateExec>(options.exec ?? defaultExec)
  return {
    deps: { profileRoot: PROFILE_ROOT, readFile, writeFile, fetcher, exec },
    files,
    fetcher,
    exec,
  }
}

describe('Account Hub 更新 RPC 逻辑', () => {
  it('从 dependencies 中 dsh-account-hub 的 tarball URL 提取完整 SHA 并返回客户端字段', async () => {
    const { deps, fetcher } = makeDeps()
    const result = await checkAccountHubUpdate(deps)

    expect(extractAccountHubSha(makeLockfile(CURRENT_SHA))).toBe(CURRENT_SHA)
    expect(result).toEqual({
      currentSha: CURRENT_SHA,
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: '更新标题',
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest',
      expect.objectContaining({ headers: { accept: 'application/vnd.github+json' } }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/${LATEST_TAG}`,
      expect.objectContaining({ headers: { accept: 'application/vnd.github+json' } }),
    )
  })

  it('无 GitHub release 时给出清晰提示并停止第二跳', async () => {
    const { deps, fetcher } = makeDeps({ releaseStatus: 404 })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow(
      '尚无 GitHub release，无法检查更新（发首个 release 后可检查）',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('release 没有 name 时将 latestTitle 回退为 tag 名', async () => {
    const { deps } = makeDeps({ omitReleaseName: true })

    await expect(checkAccountHubUpdate(deps)).resolves.toMatchObject({
      latestTag: LATEST_TAG,
      latestTitle: LATEST_TAG,
    })
  })

  it('lockfile 没有目标依赖时报告半卸载状态并提示有更新', async () => {
    const lockfile = makeLockfileWithoutAccountHub()
    const { deps } = makeDeps({ lockfile })

    await expect(checkAccountHubUpdate(deps)).resolves.toEqual({
      currentSha: '',
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: '更新标题',
    })
    expect(() => extractAccountHubSha(lockfile)).toThrow(
      'pnpm-lock.yaml dependencies 段中找不到 dsh-account-hub',
    )
  })

  it('lockfile 中目标依赖的 tarball SHA 畸形时拒绝检查', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfile('f'.repeat(39)),
    })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow('无法提取 40 位 SHA')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allowBuilds 追加 tarball 条目且重复调用幂等', () => {
    const workspace = 'allowBuilds:\n  esbuild: true\n'
    const once = appendAccountHubAllowBuild(workspace, LATEST_SHA)
    const twice = appendAccountHubAllowBuild(once, LATEST_SHA)
    const key = `dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`

    expect(once).toContain(`  ${key}`)
    expect(twice).toBe(once)
    expect(once.split(key)).toHaveLength(2)
  })

  it('apply 在成功安装后确认 lockfile 已切换，并返回完整安装日志', async () => {
    const { deps, files, exec, fetcher } = makeDeps()
    const result = await applyAccountHubUpdate(deps)

    expect(result).toEqual({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
      log: 'stdout:\n卸载完成\n\nstdout:\n安装完成\n',
    })
    expect(files.get(WORKSPACE_PATH)).toContain(`dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`)
    expect(deps.writeFile).toHaveBeenCalledTimes(1)
    expect(deps.writeFile).toHaveBeenCalledWith(
      WORKSPACE_PATH,
      expect.stringContaining(`dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`),
    )
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['remove', 'dsh-account-hub'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('package.json 缺少依赖字段时跳过 remove 直接 add', async () => {
    const { deps, exec } = makeDeps({ packageJson: '{\n  "name": "fake-profile",\n  "private": true\n}\n' })

    await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('lockfile 没有依赖条目时 previousSha 为空并仍完成安装', async () => {
    const { deps, exec } = makeDeps({ lockfile: makeLockfileWithoutAccountHub() })

    await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
      previousSha: '',
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['remove', 'dsh-account-hub'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('apply 已是最新版本时不改 workspace、不启动 pnpm', async () => {
    const { deps, files, exec } = makeDeps({ latestSha: CURRENT_SHA })
    const workspaceBefore = files.get(WORKSPACE_PATH)

    await expect(applyAccountHubUpdate(deps)).resolves.toEqual({
      previousSha: CURRENT_SHA,
      currentSha: CURRENT_SHA,
      log: '',
    })
    expect(files.get(WORKSPACE_PATH)).toBe(workspaceBefore)
    expect(exec).not.toHaveBeenCalled()
  })

  it('remove 失败时不改 workspace 且不启动 add', async () => {
    const failure = Object.assign(new Error('pnpm remove failed'), {
      code: 1,
      stdout: 'remove stdout',
      stderr: 'remove stderr',
    })
    const { deps, files, exec } = makeDeps({ exec: async () => { throw failure } })
    const packageBefore = files.get(PACKAGE_PATH)
    const workspaceBefore = files.get(WORKSPACE_PATH)

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm remove failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr',
    )
    expect(files.get(PACKAGE_PATH)).toBe(packageBefore)
    expect(files.get(WORKSPACE_PATH)).toBe(workspaceBefore)
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('add 失败时保留原始错误并附 remove 与 add 日志', async () => {
    const failure = Object.assign(new Error('pnpm add failed'), {
      code: 1,
      stdout: 'add stdout',
      stderr: 'add stderr',
    })
    const { deps, exec } = makeDeps({
      exec: async (_command, args) => {
        if (args[0] === 'remove') return { stdout: 'remove stdout', stderr: 'remove stderr' }
        throw failure
      },
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm add failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr\nstdout:\nadd stdout\nstderr:\nadd stderr',
    )
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('pnpm 成功但 lockfile SHA 未变化时失败并附完整日志', async () => {
    const { deps } = makeDeps({
      exec: async () => ({ stdout: 'pnpm stdout', stderr: 'pnpm stderr' }),
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      `更新后 lockfile 未切换到最新版本（期望 ${LATEST_SHA}，实际 ${CURRENT_SHA}）\n\nstdout:\npnpm stdout\nstderr:\npnpm stderr\nstdout:\npnpm stdout\nstderr:\npnpm stderr`,
    )
  })

  it('pnpm 超时时保留超时信息与已捕获的完整日志', async () => {
    const timeout = Object.assign(new Error('Command timed out'), {
      code: 'ETIMEDOUT',
      stdout: 'timeout stdout',
      stderr: 'timeout stderr',
    })
    const { deps } = makeDeps({ exec: async () => { throw timeout } })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'Command timed out (code ETIMEDOUT)\n\nstdout:\ntimeout stdout\nstderr:\ntimeout stderr',
    )
  })
})
