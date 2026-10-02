/** Account Hub 插件的检查更新与安装逻辑。 */
import type { RpcUpdateApplyResponse, RpcUpdateCheckResponse, RpcUpdateChannel, RpcUpdateLeftoverReport } from './types.js';
type AccountHubUpdateProgress = (phase: 'removing' | 'installing' | 'verifying', detail: string) => void;
export declare const ACCOUNT_HUB_UPDATE_TIMEOUT_MS = 120000;
export interface AccountHubUpdateProcessOutput {
    stdout: string;
    stderr: string;
}
export interface AccountHubUpdateExecOptions {
    cwd: string;
    timeoutMs: number;
    /** 子进程输出块的实时回调，供进度明细消费。 */
    onOutput?: (text: string) => void;
}
export type AccountHubUpdateExec = (command: string, args: readonly string[], options: AccountHubUpdateExecOptions) => Promise<AccountHubUpdateProcessOutput>;
/** 检查与应用更新所需的外部依赖；单测通过此接口替换路径、文件、网络和子进程。 */
export interface AccountHubUpdateDeps {
    profileRoot: string;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    /** 可选目录枚举；缺失时残留诊断安全降级为空报告。 */
    listDir?: (path: string) => Promise<string[]>;
    fetcher: typeof fetch;
    exec: AccountHubUpdateExec;
}
/**
 * 从 pnpm-lock.yaml 的 dependencies 下定位 dsh-account-hub tarball，并提取完整 commit SHA。
 * 对外保持既有严格行为；半卸载状态的检查与应用使用内部 nullable 查找器。
 */
export declare function extractAccountHubSha(lockfile: string): string;
/** 查询当前安装 SHA 与所选更新轨道，并返回完整版本显示与日志字段。 */
export declare function checkAccountHubUpdate(deps: AccountHubUpdateDeps, channel?: RpcUpdateChannel): Promise<RpcUpdateCheckResponse>;
/**
 * 只读发现更新链中断后留下的目录；任何诊断失败都降级为空报告，不阻断更新主链路。
 * pnpm store 路径依赖 pnpm 配置，当前不猜测其位置，因此刻意跳过 store 扫描。
 */
export declare function detectAccountHubUpdateLeftovers(deps: AccountHubUpdateDeps): Promise<RpcUpdateLeftoverReport>;
/**
 * 在 profile 根的 allowBuilds 下添加指定 tarball 的构建许可；同一条目重复调用不改文件。
 */
export declare function appendAccountHubAllowBuild(dependenciesFile: string, sha: string): string;
/** 删除 Account Hub allowBuilds 段中除指定 SHA 外的旧 tarball 条目。 */
export declare function removeStaleAllowBuildEntries(workspaceFile: string, keepSha: string): string;
/**
 * 读最近一笔 apply 的结果快照（无则 null）。RPC `update.status` 用它把
 * 「更新后页面刷新」的状态找回来，而不是永远停在 applying。
 */
export declare function lastAccountHubApplyResult(): {
    ok: boolean;
    previousSha: string;
    currentSha: string;
    error?: string;
} | null;
/**
 * 复位模块级互斥/进度/最近结果（仅供单测隔离用例间共享状态）。
 * 运行时没有任何调用方：更新链路自身从不复位 —— 锁由 apply 的 finally
 * 释放，最近结果由下一笔 apply 覆写。
 */
export declare function resetAccountHubUpdateState(): void;
/**
 * 测试隔离钩子：把模块级互斥位与结果快照拨回初始态。
 *
 * 单测里「apply 进行中」用例会把模块状态打到非 idle，后续用例的
 * 「初始 status 应为 idle」断言会被残留污染 —— 仅测试文件在收尾时调用，
 * 产品代码零调用（不参与任何运行期行为）。
 */
export declare function resetAccountHubUpdateStateForTest(): void;
export declare function applyAccountHubUpdate(deps: AccountHubUpdateDeps, channel?: RpcUpdateChannel, onProgress?: AccountHubUpdateProgress, targetSha?: string): Promise<RpcUpdateApplyResponse>;
export {};
//# sourceMappingURL=account-hub-update.d.ts.map