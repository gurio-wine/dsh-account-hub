import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
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
const RELEASES_LATEST_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest'
const COMMIT_BY_REF_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/'
const COMMIT_COMPARE_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/compare/'
const COMMITS_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits'
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

function makeReleaseResponse(
  tag: string,
  name: string | undefined,
  body: string | undefined,
  status = 200,
): Response {
  const responseBody: { tag_name: string; name?: string; body?: string } = { tag_name: tag }
  if (name !== undefined) responseBody.name = name
  if (body !== undefined) responseBody.body = body
  return new Response(JSON.stringify(responseBody), {
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

function makeCommitListResponse(messages: string[]): Response {
  return new Response(JSON.stringify(messages.map((message) => ({ commit: { message } }))), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCompareResponse(messages: string[]): Response {
  return new Response(JSON.stringify({ commits: messages.map((message) => ({ commit: { message } })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeDeps(options: {
  lockfile?: string
  packageJson?: string
  workspace?: string
  latestSha?: string
  latestTagSha?: string
  headSha?: string
  currentSha?: string
  latestTag?: string
  releaseName?: string
  omitReleaseName?: boolean
  releaseBody?: string
  omitReleaseBody?: boolean
  headMessage?: string
  compareMessages?: string[]
  currentCompareMessages?: string[]
  recentMessages?: string[]
  releaseStatus?: number
  exec?: AccountHubUpdateExec
} = {}): {
  deps: AccountHubUpdateDeps
  files: Map<string, string>
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  exec: ReturnType<typeof vi.fn<AccountHubUpdateExec>>
} {
  const latestSha = options.latestSha ?? LATEST_SHA
  const latestTagSha = options.latestTagSha ?? latestSha
  const headSha = options.headSha ?? latestSha
  const currentSha = options.currentSha ?? CURRENT_SHA
  const latestTag = options.latestTag ?? LATEST_TAG
  const releaseName = options.omitReleaseName ? undefined : options.releaseName ?? '更新标题'
  const releaseBody = options.omitReleaseBody ? undefined : options.releaseBody ?? '稳定版本更新日志'
  const headMessage = options.headMessage ?? 'Beta 提交标题\n更多提交说明'
  const compareMessages = options.compareMessages ?? ['Beta 改动\n提交正文']
  const currentCompareMessages = options.currentCompareMessages ?? ['当前领先提交\n提交正文']
  const recentMessages = options.recentMessages ?? ['master HEAD 提交\n提交正文']
  const files = new Map<string, string>([
    [LOCK_PATH, options.lockfile ?? makeLockfile(currentSha)],
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
    const url = String(input)
    if (url === RELEASES_LATEST_URL) {
      return makeReleaseResponse(latestTag, releaseName, releaseBody, options.releaseStatus ?? 200)
    }
    if (url === `${COMMIT_BY_REF_URL_PREFIX}${encodeURIComponent(latestTag)}`) {
      return makeCommitResponse(latestTagSha, 'Release tag commit')
    }
    if (url === `${COMMIT_BY_REF_URL_PREFIX}master`) return makeCommitResponse(headSha, headMessage)
    if (url === `${COMMITS_URL}?per_page=20`) return makeCommitListResponse(recentMessages)
    if (url.startsWith(COMMIT_COMPARE_URL_PREFIX)) {
      const comparison = url.slice(COMMIT_COMPARE_URL_PREFIX.length).split('?', 1)[0]
      return comparison === `${latestTagSha}...${currentSha}`
        ? makeCompareResponse(currentCompareMessages)
        : makeCompareResponse(compareMessages)
    }
    throw new Error(`Unexpected GitHub API URL: ${url}`)
  })
  const defaultExec: AccountHubUpdateExec = async (_command, args) => {
    if (args[0] === 'add') {
      const pin = String(args[1])
      const addedSha = pin.split('#').at(-1) ?? latestSha
      files.set(LOCK_PATH, makeLockfile(addedSha))
      files.set(PACKAGE_PATH, makePackageJson(pin))
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

function makeUpdateRpcCaller(deps: AccountHubUpdateDeps) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx: Record<string, unknown> = {}
  ctx.connection = {
    fetch: {
      register: (options: { fetch: (request: Request) => Promise<Response> }) => {
        handler = options.fetch
      },
    },
  }
  ctx.inject = (_deps: string[], callback: (ctx: unknown) => void) => callback(ctx)
  ctx.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  ctx.get = () => undefined

  registerAccountHubRpc({
    ctx: ctx as never,
    pool: {} as never,
    codearts: {} as never,
    buddyCn: {} as never,
    buddy: {} as never,
    lobsterai: {} as never,
    traeCn: {} as never,
    qoder: {} as never,
    qoderCn: {} as never,
    updateDeps: deps,
  })
  if (handler === undefined) throw new Error('update RPC handler was not registered')

  return async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'update-rpc-1',
        method: 'account-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: Record<string, unknown>; error?: { message: string } }
    }
    return body.result
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
      currentVersion: CURRENT_SHA.slice(0, 8),
      latestVersion: LATEST_TAG,
      changelog: '稳定版本更新日志',
      currentChangelog: '',
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

  it('stable 无更新时显示 release tag 并复用 release body 作为当前与最新日志', async () => {
    const { deps } = makeDeps({
      lockfile: makeLockfile(LATEST_SHA),
      currentSha: LATEST_SHA,
      releaseBody: 'Release v0.2.0\n\n- 正式版本内容',
    })

    await expect(checkAccountHubUpdate(deps, 'stable')).resolves.toMatchObject({
      currentSha: LATEST_SHA,
      latestSha: LATEST_SHA,
      hasUpdate: false,
      currentVersion: LATEST_TAG,
      latestVersion: LATEST_TAG,
      changelog: 'Release v0.2.0\n\n- 正式版本内容',
      currentChangelog: 'Release v0.2.0\n\n- 正式版本内容',
    })
  })

  it('无 GitHub release 时给出清晰提示并停止第二跳', async () => {
    const { deps, fetcher } = makeDeps({ releaseStatus: 404 })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow(
      '尚无 GitHub release，无法检查更新（发首个 release 后可检查）',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('release 没有 name/body 时 title 回退 tag 且 changelog 为空', async () => {
    const { deps } = makeDeps({ omitReleaseName: true, omitReleaseBody: true })

    await expect(checkAccountHubUpdate(deps)).resolves.toMatchObject({
      latestTag: LATEST_TAG,
      latestTitle: LATEST_TAG,
      changelog: '',
      currentChangelog: '',
    })
  })

  it('beta 有更新时使用 master HEAD 并以 compare 提交标题生成 changelog', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
      compareMessages: ['新增功能\n详细说明', '修复问题\n详细说明'],
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      currentSha: CURRENT_SHA,
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: 'Beta 提交标题',
      currentVersion: `${LATEST_TAG}+${CURRENT_SHA.slice(0, 7)}`,
      latestVersion: `${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`,
      changelog: '- 新增功能\n- 修复问题',
      currentChangelog: '',
    })
    expect(fetcher).toHaveBeenCalledWith(
      `${COMMIT_COMPARE_URL_PREFIX}${CURRENT_SHA}...master?per_page=20`,
      expect.any(Object),
    )
  })

  it('beta currentSha 为空时从最近 20 条 commits 生成 changelog', async () => {
    const recentMessages = Array.from({ length: 22 }, (_, index) => `提交 ${index + 1}\n详细说明`)
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfileWithoutAccountHub(),
      currentSha: '',
      headSha: LATEST_SHA,
      recentMessages,
    })

    const result = await checkAccountHubUpdate(deps, 'beta')

    expect(result.currentVersion).toBe('')
    expect(result.latestVersion).toBe(`${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`)
    expect(result.changelog.split('\n')).toHaveLength(20)
    expect(result.changelog).toContain('- 提交 1')
    expect(result.changelog).toContain('- 提交 20')
    expect(result.changelog).not.toContain('提交 21')
    expect(result.currentChangelog).toBe('')
    expect(fetcher).toHaveBeenCalledWith(`${COMMITS_URL}?per_page=20`, expect.any(Object))
  })

  it('beta currentChangelog 仅列出 release tag 之后的当前版本提交', async () => {
    const { deps } = makeDeps({
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      latestTagSha: LATEST_SHA,
      headSha: LATEST_SHA,
      currentCompareMessages: ['当前领先提交\n提交正文'],
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      currentChangelog: '- 当前领先提交',
    })
  })

  it('beta 在没有 release 时以 beta 作为 tag 前缀继续检查 master', async () => {
    const { deps } = makeDeps({
      releaseStatus: 404,
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      latestTag: 'beta',
      latestVersion: `beta+${LATEST_SHA.slice(0, 7)}`,
      hasUpdate: true,
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
      currentVersion: '',
      latestVersion: LATEST_TAG,
      changelog: '稳定版本更新日志',
      currentChangelog: '',
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

  it('apply beta 通道按 master HEAD SHA 安装', async () => {
    const { deps, exec } = makeDeps({
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })

    await expect(applyAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
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

  it('update RPC 将 beta 透传给 check/apply，缺省和非法 channel 回退 stable', async () => {
    const { deps, exec } = makeDeps({
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })
    const call = makeUpdateRpcCaller(deps)

    const betaCheck = await call('update.check', { channel: 'beta' })
    expect(betaCheck.ok).toBe(true)
    expect(betaCheck.value).toMatchObject({
      latestSha: LATEST_SHA,
      latestVersion: `${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`,
    })

    const defaultCheck = await call('update.check', {})
    expect(defaultCheck.value).toMatchObject({
      latestSha: CURRENT_SHA,
      latestVersion: LATEST_TAG,
      hasUpdate: false,
    })

    const invalidCheck = await call('update.check', { channel: 'nightly' })
    expect(invalidCheck.value).toMatchObject({
      latestSha: CURRENT_SHA,
      latestVersion: LATEST_TAG,
      hasUpdate: false,
    })

    const betaApply = await call('update.apply', { channel: 'beta' })
    expect(betaApply.ok).toBe(true)
    expect(betaApply.value).toMatchObject({ currentSha: LATEST_SHA })
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
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
