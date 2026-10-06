import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  flushAutoRouteDemotionLogWrites,
  writeAutoRouteDemotionLog,
} from '../../src/auto-route-adapter.js'

const roots: string[] = []

function contextFor(home: string): Context {
  return { dshHomePath: () => home } as unknown as Context
}

function logPath(home: string): string {
  return join(home, 'logs', 'dsh-account-hub', 'auto-route-demotion.log')
}

afterEach(async () => {
  await flushAutoRouteDemotionLogWrites()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('自动路由静默降级文件日志', () => {
  it('异步追加带 UTC 时间戳与候选信息的一行', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-route-log-'))
    roots.push(home)

    writeAutoRouteDemotionLog(contextFor(home), '静默降级；候选 qoder-cn/gmodel；finish=error；code=UPSTREAM_REJECTED')
    await flushAutoRouteDemotionLogWrites()

    const text = await readFile(logPath(home), 'utf8')
    expect(text).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[auto-route\] 静默降级；候选 qoder-cn\/gmodel；finish=error；code=UPSTREAM_REJECTED\n$/,
    )
  })

  it('追加前超过 1 MiB 时覆盖旧备份并轮转为 .1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-route-log-'))
    roots.push(home)
    const path = logPath(home)
    await mkdir(join(home, 'logs', 'dsh-account-hub'), { recursive: true })
    await writeFile(path, 'x'.repeat(1024 * 1024 + 1), 'utf8')
    await writeFile(`${path}.1`, 'old backup', 'utf8')

    writeAutoRouteDemotionLog(contextFor(home), '静默降级；候选 qoder/gmodel')
    await flushAutoRouteDemotionLogWrites()

    expect(await readFile(`${path}.1`, 'utf8')).toBe('x'.repeat(1024 * 1024 + 1))
    expect(await readFile(path, 'utf8')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[auto-route\] 静默降级；候选 qoder\/gmodel\n$/,
    )
  })

  it('日志目录不可用时静默跳过且不抛错', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-route-log-'))
    roots.push(home)
    await writeFile(join(home, 'logs'), 'not a directory', 'utf8')

    expect(() => {
      writeAutoRouteDemotionLog(contextFor(home), '静默降级；候选 qoder-cn/gmodel')
    }).not.toThrow()
    await expect(flushAutoRouteDemotionLogWrites()).resolves.toBeUndefined()
    await expect(readFile(join(home, 'logs'), 'utf8')).resolves.toBe('not a directory')
  })
})
