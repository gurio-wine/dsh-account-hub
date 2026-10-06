import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8')
const codeOnly = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const indexSource = codeOnly(read('src/index.ts'))

describe('续期调度器启动接线（issue IKJOZB）', () => {
  it('index.ts 使用 MultiAccountRefreshScheduler，不再自行按池内容挂 setInterval', () => {
    expect(indexSource).toContain('new MultiAccountRefreshScheduler(')
    expect(indexSource).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*void refreshAllCredentials/)
    expect(indexSource).toMatch(/refreshScheduler\.start\(\)/)
  })

  it('武装路径不依赖 refreshable / enabled，空池只作为 isPoolEmpty 日志探针', () => {
    const start = indexSource.indexOf('new MultiAccountRefreshScheduler(')
    const end = indexSource.indexOf('refreshScheduler.start()', start)
    const wiring = indexSource.slice(start, end)
    expect(wiring).not.toMatch(/refreshable|enabled/)
    expect(wiring).toContain('isPoolEmpty')
    expect(wiring).not.toMatch(/if\s*\(\s*accounts\.length\s*===\s*0\s*\)/)
  })

  it('账号入库通知接到调度器，并在销毁时取消订阅', () => {
    expect(indexSource).toMatch(/pool\.onAccountAdded\(/)
    expect(indexSource).toMatch(/refreshScheduler\.notifyAccountAdded\(\)/)
    expect(indexSource).toContain('unsubscribeAccountAdded?.()')
  })

  it('start() 失败有兜底，避免未处理 rejection 炸启动', () => {
    const start = indexSource.indexOf('refreshScheduler.start()')
    expect(start).toBeGreaterThan(-1)
    expect(indexSource.slice(start, start + 500)).toContain('.catch(')
  })

  it('停止清理只保留本仓七个认证服务', () => {
    const start = indexSource.indexOf('ctx.effect(() => () =>', indexSource.indexOf('refreshScheduler'))
    const end = indexSource.indexOf('}, \'account-hub: multi-account refresh scheduler\')', start)
    const cleanup = indexSource.slice(start, end)
    for (const service of ['service', 'buddyCn', 'buddy', 'lobsterai', 'traeCn', 'qoder', 'qoderCn']) {
      expect(cleanup).toContain(`${service}.stop()`)
    }
    for (const removed of ['cline', 'loomy', 'zcode', 'zcodeAdapter']) {
      expect(cleanup).not.toContain(`${removed}.stop()`)
    }
  })
})
