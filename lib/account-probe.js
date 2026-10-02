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
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { BuddyAdapter } from './buddy-adapter.js';
import { LobsteraiAdapter } from './lobsterai-adapter.js';
import { CodeArtsAdapter, isRateLimited } from './llm-adapter.js';
import { productById } from './product.js';
import { lobsteraiProductById } from './lobsterai-product.js';
import { TraeCnAdapter } from './trae-cn-adapter.js';
import { traeCnProductById } from './trae-cn-product.js';
/** 探测请求的提示语（与 e2e 探针保持一致，最大化可比性）。 */
const PROBE_PROMPT = '只回答两个字：收到';
/**
 * 单次探测的超时（毫秒）。
 *
 * CodeArts 适配器在排队时会以 10 秒间隔重试 chat 请求、最长 30 分钟
 * （QUEUE_MAX_ATTEMPTS）。设置页按钮显然不能等那么久，因此这里用
 * AbortSignal 给每次探测设硬上限：超时即判定"未能确认恢复"，保留标记。
 * 宁可保守留标记，也不要因为等太久让 UI 卡死。
 */
const PROBE_TIMEOUT_MS = 120_000;
/**
 * 判断一次探测失败是否**属于限流**。
 *
 * 区分限流与其他失败（鉴权过期、网络中断）很重要：只有限流才算
 * "标记仍然有效"，其他失败说明"无法确认"，两种都应该保留标记，
 * 但回传给用户的文案不同。
 */
function isRateLimitFailure(error) {
    if (error instanceof LlmError) {
        // buddy/codearts 用字面量 'QUOTA_EXCEEDED'，harness 常量 QUOTA_EXCEEDED_CODE
        // 是 'QUOTA'——两者都认，避免因词汇差异把限流误判成"未知错误"。
        if (error.code === 'RATE_LIMIT' || error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA')
            return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return isRateLimited(message);
}
/** 用真实适配器对指定账号的指定模型发一次最小请求。 */
async function probeWithAdapter(entry, credential, modelId, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const ref = credentialRef(entry.credentialRef);
    // 刻意不传 accountPool / 显式关掉 fetchRemoteModels：
    // - 不传 accountPool → 只测这一个账号，且探测本身不写限流标记；
    // - `fetchRemoteModels: async () => []` → 避免为一次探测额外拉取远端模型目录
    //   （Trae CN 的适配器**内置**了目录拉取，不显式关掉就会多发两个 HTTP 请求）。
    //   关掉后 `function` 路由回退静态表口径（`solo_work_remote`），探测仍成立。
    //
    // refresh 设为 no-op：探测不应触发全局续期流程（那会影响其他账号与
    // 其他并发会话），凭据真的过期就让它以 AUTH 失败并如实上报。
    //
    // **三个产品线各自选适配器**，顺序不能颠倒也不能只判前两个：
    // - Buddy 系（buddy-cn / buddy）→ BuddyAdapter，按各自 product 发请求；
    // - LobsterAI → LobsteraiAdapter（自己的端点与头族）；
    // - 其余（codearts）→ CodeArtsAdapter（华为云 HMAC 签名）。
    //
    // 历史上这里只判断 `provider === 'buddy'`，导致国际版（当年叫 workbuddy）落入 else 分支、
    // 用华为云 HMAC 签名去发 Buddy 凭据而必然失败（见下方 productById 的
    // 原注释）；现在 lobsterai 若不加分支会重蹈覆辙 —— 它的协议与两者都不同，
    // 用 CodeArtsAdapter 会以完全错误的签名与端点发请求。
    const buddyProduct = productById(entry.provider);
    const lobsteraiProduct = lobsteraiProductById(entry.provider);
    const traeCnProduct = traeCnProductById(entry.provider);
    let adapter;
    if (buddyProduct !== undefined) {
        adapter = new BuddyAdapter({
            credentialRef: ref,
            resolveCredential: async () => credential,
            refresh: async () => { },
            product: buddyProduct,
        });
    }
    else if (lobsteraiProduct !== undefined) {
        adapter = new LobsteraiAdapter({
            credentialRef: ref,
            resolveCredential: async () => credential,
            refresh: async () => { },
            product: lobsteraiProduct,
        });
    }
    else if (traeCnProduct !== undefined) {
        adapter = new TraeCnAdapter({
            credentialRef: ref,
            resolveCredential: async () => credential,
            refresh: async () => { },
            // 探测只发一次 chat：不要顺带拉目录（见上方说明）。
            fetchRemoteModels: async () => [],
            product: traeCnProduct,
        });
    }
    else {
        adapter = new CodeArtsAdapter({
            credentialRef: ref,
            resolveCredential: async () => credential,
            refresh: async () => { },
        });
    }
    try {
        for await (const _chunk of adapter.stream({
            provider: entry.provider,
            model: modelId,
            messages: [createUserMessage({
                    content: [{ type: 'text', text: PROBE_PROMPT }],
                    source: { kind: 'user' },
                })],
            signal,
        })) {
            // 消费整个流即可：能正常结束就说明服务端接受并完成了这次请求
            //（未被限流）。即使正文为空（少数模型只回 finish）也不算限流。
        }
        return { modelId, ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isRateLimitFailure(error)) {
            return { modelId, ok: false, message: `仍受限：${message}` };
        }
        return { modelId, ok: false, message: `无法确认：${message}` };
    }
}
/** 默认探测实现：解析该账号凭据后用真实适配器发请求。 */
function makeDefaultProbe(pool, timeoutMs) {
    return async (entry, modelId) => {
        const credential = await pool.resolveCredentialForAccount(entry.id);
        if (credential === undefined) {
            return { modelId, ok: false, message: '无法确认：凭据不可用' };
        }
        return probeWithAdapter(entry, credential, modelId, timeoutMs);
    };
}
/**
 * 重测单个账号：对该账号每个带限流标记的模型发一次真实请求，
 * 正常返回的模型清除标记。
 */
export async function retestAccount(pool, accountId, deps = {}) {
    const entry = pool.findAccount(accountId);
    if (entry === undefined) {
        return { accountId, tested: 0, cleared: [], stillLimited: [], error: `账号 ${accountId} 不存在` };
    }
    const modelIds = Object.keys(entry.modelRateLimits ?? {});
    const result = {
        accountId,
        nickname: entry.nickname,
        tested: modelIds.length,
        cleared: [],
        stillLimited: [],
    };
    if (modelIds.length === 0)
        return result;
    const probe = deps.probe ?? makeDefaultProbe(pool, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    for (const modelId of modelIds) {
        const outcome = await probe(entry, modelId);
        if (outcome.ok)
            result.cleared.push(modelId);
        else
            result.stillLimited.push(outcome);
    }
    // 只有实测通过的模型才清除标记；仍受限/无法确认的一律保留。
    if (result.cleared.length > 0) {
        await pool.clearModelRateLimits(accountId, result.cleared);
    }
    return result;
}
/**
 * 重测某 provider 下的**全部**账号（含已停用账号）。
 *
 * 顺序执行而非并发：探测会真实消耗模型额度，并发发起容易触发真正想验证的
 * 限流，反而得到假阳性。
 */
export async function retestAllAccounts(pool, provider, deps = {}) {
    const entries = pool.listAccountsByProvider(provider);
    const accounts = [];
    for (const entry of entries) {
        accounts.push(await retestAccount(pool, entry.id, deps));
    }
    return {
        accounts,
        clearedCount: accounts.reduce((sum, a) => sum + a.cleared.length, 0),
    };
}
/**
 * 重置单个账号：不测试，直接清除该账号的全部限流标记。
 * @returns 清除的标记条数与涉及的账号数（此处恒为 0 或 1）。
 */
export async function resetAccount(pool, accountId) {
    const cleared = await pool.clearModelRateLimits(accountId);
    return { clearedCount: cleared, accountCount: cleared > 0 ? 1 : 0 };
}
/** 重置某 provider 下全部账号（含已停用账号）的限流标记。 */
export async function resetAllAccounts(pool, provider) {
    const entries = pool.listAccountsByProvider(provider);
    let clearedCount = 0;
    let accountCount = 0;
    for (const entry of entries) {
        const cleared = await pool.clearModelRateLimits(entry.id);
        if (cleared > 0) {
            clearedCount += cleared;
            accountCount++;
        }
    }
    return { clearedCount, accountCount };
}
//# sourceMappingURL=account-probe.js.map