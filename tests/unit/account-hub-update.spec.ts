import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  appendAccountHubAllowBuild,
  applyAccountHubUpdate,
  checkAccountHubUpdate,
  extractAccountHubSha,
  writeAccountHubPin,
  type AccountHubUpdateDeps,
  type AccountHubUpdateExec,
} from '../../src/account-hub-update.js'

const PROFILE_ROOT = 'C:\\fake-profile'
const CURRENT_SHA = 'a'.repeat(40)
const LATEST_SHA = 'b'.repeat(40)
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

function makeResponse(sha = LATEST_SHA, message = '更新标题\n更多提交说明'): Response {
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
  latestTitle?: string
  exec?: AccountHubUpdateExec
} = {}): {
  deps: AccountHubUpdateDeps
  files: Map<string, string>
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  exec: ReturnType<typeof vi.fn<AccountHubUpdateExec>>
} {
  const latestSha = options.latestSha ?? LATEST_SHA
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
  const fetcher = vi.fn<typeof fetch>(async () => makeResponse(latestSha, options.latestTitle ?? '更新标题\n更多提交说明'))
  const defaultExec: AccountHubUpdateExec = async (_command, args) => {
    if (args[0] === 'add') files.set(LOCK_PATH, makeLockfile(latestSha))
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
      hasUpdate: true,
      latestTitle: '更新标题',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/master',
      expect.objectContaining({ headers: { accept: 'application/vnd.github+json' } }),
    )
  })

  it('lockfile dependencies 中没有目标包时拒绝检查且不请求 GitHub', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: [
        'importers:',
        '  .:',
        '    dependencies:',
        '      other-package:',
        '        version: 1.0.0',
        'packages:',
      ].join('\n'),
    })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow('找不到 dsh-account-hub')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('lockfile 中目标依赖的 tarball SHA 畸形时拒绝检查', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfile('f'.repeat(39)),
    })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow('无法提取 40 位 SHA')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('package.json pin 改写只替换目标值并保持其余格式', () => {
    const packageJson = makePackageJson()
    const updated = writeAccountHubPin(packageJson, LATEST_SHA)

    expect(updated).toBe(makePackageJson(`${ACCOUNT_HUB_PIN}#${LATEST_SHA}`))
    expect(updated).toContain(`"dsh-account-hub": "${ACCOUNT_HUB_PIN}#${LATEST_SHA}"`)
  })

  it('package.json pin 已是目标 SHA 时保持幂等', () => {
    const packageJson = makePackageJson(`${ACCOUNT_HUB_PIN}#${LATEST_SHA}`)

    expect(writeAccountHubPin(packageJson, LATEST_SHA)).toBe(packageJson)
  })

  it('package.json 缺少 pin 字段或 pin 形态异常时拒绝改写', () => {
    expect(() => writeAccountHubPin('{\n  "dependencies": {}\n}\n', LATEST_SHA)).toThrow(
      '找不到 dsh-account-hub pin 字段',
    )
    expect(() => writeAccountHubPin(makePackageJson('npm:dsh-account-hub@1.0.0'), LATEST_SHA)).toThrow(
      'pin 格式无效',
    )
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
    expect(files.get(PACKAGE_PATH)).toContain(`"dsh-account-hub": "${ACCOUNT_HUB_PIN}#${LATEST_SHA}"`)
    expect(deps.writeFile).toHaveBeenNthCalledWith(
      1,
      PACKAGE_PATH,
      expect.stringContaining(`"dsh-account-hub": "${ACCOUNT_HUB_PIN}#${LATEST_SHA}"`),
    )
    expect(deps.writeFile).toHaveBeenNthCalledWith(
      2,
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
    expect(fetcher).toHaveBeenCalledTimes(1)
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

  it('remove 成功但写 package.json pin 失败时不启动 add 并返回原始错误', async () => {
    const failure = new Error('package.json write failed')
    const { deps, exec } = makeDeps()
    deps.writeFile = vi.fn(async (path: string) => {
      if (path === PACKAGE_PATH) throw failure
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toBe(failure)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['remove', 'dsh-account-hub'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('remove 失败时不写 pin、不写 allowBuilds 且不启动 add', async () => {
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

  it('pnpm 失败时保留原错误、stdout 与 stderr', async () => {
    const failure = Object.assign(new Error('pnpm install failed'), {
      code: 1,
      stdout: 'pnpm stdout',
      stderr: 'pnpm stderr',
    })
    const { deps, exec } = makeDeps({ exec: async () => { throw failure } })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm install failed (code 1)\n\nstdout:\npnpm stdout\nstderr:\npnpm stderr',
    )
    expect(exec).toHaveBeenCalledTimes(1)
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
