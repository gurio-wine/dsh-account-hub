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
    refresh: () => Promise<void>;
    /** 续期周期（毫秒）。 */
    intervalMs: number;
    /** 账号池是否为空，仅用于日志措辞，不参与武装判据。 */
    isPoolEmpty: () => Promise<boolean>;
    /** 可选日志出口；缺省时静默。 */
    warn?: (message: string) => void;
    info?: (message: string) => void;
}
/**
 * 多账号续期调度器：无条件武装、启动立即续期、账号入库时补武装。
 */
export declare class MultiAccountRefreshScheduler {
    private readonly options;
    private timer;
    private running;
    constructor(options: RefreshSchedulerOptions);
    /** 武装调度器：立即执行一轮，然后按周期执行。重复调用幂等。 */
    start(): Promise<void>;
    /** 停止调度器；之后可再次 start()。 */
    stop(): void;
    /** 是否已武装。 */
    isArmed(): boolean;
    /** 账号入库通知：调度器未武装时补起定时器。 */
    notifyAccountAdded(): void;
    /** 执行一轮续期；空池也保持定时器存活。 */
    private onTick;
    /** 探测空池；异常按非空处理并照常续期。 */
    private probeEmpty;
}
//# sourceMappingURL=refresh-scheduler.d.ts.map