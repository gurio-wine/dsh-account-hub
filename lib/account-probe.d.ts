/**
 * 限流标记重测（retest）与重置（reset）。
 *
 * 背景：账号卡片上的「限额重置」只是**一次 429 事件的快照**——它记录的是
 * 服务端当时给出的"预计恢复时间"，而不是该账号此刻的真实可用性。服务端
 * 常在重置时间到达前提前放行，于是出现「显示超额使用但发消息正常回复」。
 * 本模块让用户能主动验证并清理这些过期标记。
 *
 * 两个动作，语义严格区分：
 *
 * - **重测（retest）**：对每个带限流标记的模型**真实发一次最小对话请求**。
 *   只有请求正常完成才清除该模型的标记；仍被拒绝（限流）则保留标记，并把
 *   原因回传给 UI。这样标记始终反映"最近一次实测结果"。
 * - **重置（reset）**：不做任何网络请求，直接清除标记。用于用户已知额度
 *   已恢复、只想清掉显示的情况。
 *
 * 与 e2e 探针（tests/e2e/buddy-ratelimit-probe.e2e.spec.ts）的关系：两者都
 * 发真实请求判定限流，但 e2e 用于人工排查、本模块供设置页按钮调用。为避免
 * 逻辑漂移，这里直接复用**真实适配器**（BuddyAdapter / CodeArtsAdapter）走
 * 完整请求链路，而不是各自手写 HTTP。
 *
 * 两点关键设计：
 *
 * 1. **不传 accountPool 给适配器**。适配器只在拿到 accountPool 时才会切换
 *    账号、写限流标记；探测必须只针对**指定账号**、且不能产生副作用，否则
 *    "重测 A 账号"会顺带污染其他账号的标记。
 * 2. **停用账号也要能重测**。用户明确要求这一点，因此凭据解析走
 *    `resolveCredentialForAccount`（按 id，不检查 enabled），而非
 *    `getAvailableAccount`（自动选择，只认启用账号）。
 */
import type { BuddyCredential } from './buddy.js';
import type { LobsteraiCredential } from './lobsterai.js';
import type { CodeArtsCredential, ProbeAccountResult, ProbeModelResult, ProviderAccountEntry, RpcResetResponse, RpcRetestResponse } from './types.js';
/**
 * 重测/重置所需的最小账号池接口。
 *
 * 只声明实际用到的方法，使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface ProbePool {
    /** 按 id 查找账号（含已停用）。 */
    findAccount(id: string): ProviderAccountEntry | undefined;
    /** 列出某 provider 的全部账号（含已停用）。 */
    listAccountsByProvider(provider: string): ProviderAccountEntry[];
    /** 按 id 解析凭据（不检查 enabled）。 */
    resolveCredentialForAccount(id: string): Promise<CodeArtsCredential | BuddyCredential | LobsteraiCredential | undefined>;
    /** 清除限流标记；modelIds 省略时清除全部。返回清除条数。 */
    clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number>;
}
/** 探测依赖注入点（测试可覆盖）。 */
export interface ProbeDeps {
    /** 发起探测请求的函数；默认使用真实适配器。 */
    probe?: (entry: ProviderAccountEntry, modelId: string) => Promise<ProbeModelResult>;
    /** 单次探测超时；默认 {@link PROBE_TIMEOUT_MS}。 */
    timeoutMs?: number;
}
/**
 * 重测单个账号：对该账号每个带限流标记的模型发一次真实请求，
 * 正常返回的模型清除标记。
 */
export declare function retestAccount(pool: ProbePool, accountId: string, deps?: ProbeDeps): Promise<ProbeAccountResult>;
/**
 * 重测某 provider 下的**全部**账号（含已停用账号）。
 *
 * 顺序执行而非并发：探测会真实消耗模型额度，并发发起容易触发真正想验证的
 * 限流，反而得到假阳性。
 */
export declare function retestAllAccounts(pool: ProbePool, provider: string, deps?: ProbeDeps): Promise<RpcRetestResponse>;
/**
 * 重置单个账号：不测试，直接清除该账号的全部限流标记。
 * @returns 清除的标记条数与涉及的账号数（此处恒为 0 或 1）。
 */
export declare function resetAccount(pool: ProbePool, accountId: string): Promise<RpcResetResponse>;
/** 重置某 provider 下全部账号（含已停用账号）的限流标记。 */
export declare function resetAllAccounts(pool: ProbePool, provider: string): Promise<RpcResetResponse>;
//# sourceMappingURL=account-probe.d.ts.map