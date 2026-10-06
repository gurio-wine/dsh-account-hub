/**
 * 多账号静默续期调度器。
 *
 * 调度器与账号池内容解耦：池为空只是等待首个账号入库的正常状态，
 * 不应阻止定时器武装。调度器还通过 `notifyAccountAdded()` 提供会话内
 * 的补武装路径，避免登录后错过主动续期。
 */

/** 调度器依赖，全部可注入以便行为测试。 */
export interface RefreshSchedulerOptions {
  /** 执行一轮账号续期。常规异常应由调用方逐 provider 吞掉。 */
  refresh: () => Promise<void>
  /** 续期周期（毫秒）。 */
  intervalMs: number
  /** 账号池是否为空，仅用于日志措辞，不参与武装判据。 */
  isPoolEmpty: () => Promise<boolean>
  /** 可选日志出口；缺省时静默。 */
  warn?: (message: string) => void
  info?: (message: string) => void
}

/**
 * 多账号续期调度器：无条件武装、启动立即续期、账号入库时补武装。
 */
export class MultiAccountRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly options: RefreshSchedulerOptions) {}

  /** 武装调度器：立即执行一轮，然后按周期执行。重复调用幂等。 */
  async start(): Promise<void> {
    if (this.timer !== undefined) return
    // 先武装，再执行首轮，避免首轮 await 期间收到入库通知而重复起表。
    this.timer = setInterval(() => void this.onTick(), this.options.intervalMs)
    const unrefable = this.timer as unknown as { unref?: () => void }
    unrefable.unref?.()
    this.options.info?.(
      `[account-hub] 多账号续期调度器已武装（每 ${Math.round(this.options.intervalMs / 60_000)} 分钟一轮）`,
    )
    await this.onTick({ initial: true })
  }

  /** 停止调度器；之后可再次 start()。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 是否已武装。 */
  isArmed(): boolean {
    return this.timer !== undefined
  }

  /** 账号入库通知：调度器未武装时补起定时器。 */
  notifyAccountAdded(): void {
    if (this.timer !== undefined) return
    this.options.info?.('[account-hub] 检测到账号入库而续期调度器未武装，正在补武装')
    void this.start().catch((error: unknown) => {
      this.options.warn?.(
        `[account-hub] 账号入库后补武装失败（后续仍可重试）：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /** 执行一轮续期；空池也保持定时器存活。 */
  private async onTick(context?: { initial: boolean }): Promise<void> {
    if (this.running) {
      this.options.warn?.('[account-hub] 上一轮续期尚未结束，跳过本轮')
      return
    }
    this.running = true
    try {
      const empty = await this.probeEmpty()
      if (empty) {
        this.options.info?.(
          context?.initial === true
            ? '[account-hub] 账号池为空：续期调度器已武装并等待首个账号入库（后续每 30 分钟复查）'
            : '[account-hub] 账号池仍为空，本轮无可续期账号（调度器保持武装）',
        )
      }
      await this.options.refresh()
    } catch (error) {
      this.options.warn?.(
        `[account-hub] 一轮续期失败（调度器保持武装，下轮重试）：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      this.running = false
    }
  }

  /** 探测空池；异常按非空处理并照常续期。 */
  private async probeEmpty(): Promise<boolean> {
    try {
      return await this.options.isPoolEmpty()
    } catch (error) {
      this.options.warn?.(
        `[account-hub] 读取账号池失败（本轮照常续期）：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }
}
