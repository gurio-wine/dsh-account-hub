import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import {
  flushAutoRouteDemotionLogWrites,
  registerAutoRouteLlm,
  writeAutoRouteDemotionLog,
} from '../../src/auto-route-adapter.js'
import type { AutoRouteConfig } from '../../src/auto-route.js'

const roots: string[] = []

class ScriptedTargetAdapter extends LlmAdapter {
  constructor(private readonly chunks: readonly StreamChunk[]) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: `目标 ${provider}` }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: 'a', name: '目标 a' }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: `目标 ${model}`,
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8192,
    }
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.chunks
  }
}

function contextFor(home: string): CordisContext {
  return { dshHomePath: () => home } as unknown as CordisContext
}

async function runThroughAutoRoute(home: string, chunks: readonly StreamChunk[]): Promise<StreamChunk[]> {
  const ctx = new Context()
  ;(ctx as unknown as { dshHomePath: () => string }).dshHomePath = () => home
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['p-a'], new ScriptedTargetAdapter(chunks))
  const config = (): AutoRouteConfig => ({
    enabled: true,
    models: [{ id: 'm1', name: '自动一号', entries: [{ provider: 'p-a', model: 'a' }] }],
  })
  const { adapter } = registerAutoRouteLlm(ctx, { ctx, config })
  const output: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'auto-route',
    model: 'm1',
    messages: [],
  })) output.push(chunk)
  await flushAutoRouteDemotionLogWrites()
  return output
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

  it('已透传后收到 error finish 时记录降级及错误码，并原样透传失败', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-route-log-'))
    roots.push(home)

    const chunks = await runThroughAutoRoute(home, [
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_REJECTED', message: '上游拒绝' } } },
    ])

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UPSTREAM_REJECTED', message: '上游拒绝' } },
    })
    const text = await readFile(logPath(home), 'utf8')
    expect(text).toContain('已透传后失败降级；emitted=true')
    expect(text).toContain('finish=error；code=UPSTREAM_REJECTED；message=上游拒绝')
  })

  it('已透传后上游未发 finish 时记录 incomplete 分支并输出 AUTO_ROUTE_INCOMPLETE', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-route-log-'))
    roots.push(home)

    const chunks = await runThroughAutoRoute(home, [
      { type: 'text-delta', index: 0, text: 'partial' },
    ])

    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTO_ROUTE_INCOMPLETE' } },
    })
    const text = await readFile(logPath(home), 'utf8')
    expect(text).toContain('已透传后流提前结束；emitted=true')
    expect(text).toContain('finish=error；code=AUTO_ROUTE_INCOMPLETE；message=')
  })
})
