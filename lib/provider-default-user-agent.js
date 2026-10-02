/**
 * 「某个 provider/model **当前会发出的** User-Agent」—— 面板 UA 覆写输入框
 * 「默认值」那一栏的取值来源（RPC `autoroute.model-info` 的 `defaultUserAgent`）。
 *
 * ## 为什么必须**现算**而不是抄一份常量表
 *
 * 本插件七个 provider 的 UA 各有出处，且 buddy 系还按**模型族**分档（见
 * {@link resolveUserAgent}：国际版按 `gpt-` / `glm-` 等前缀切国内外客户端形态）。
 * 抄一份「provider → UA」的字面量表放在这里，等于把那些判据复制一遍：哪天
 * `product.userAgent` 或模型族规则变了，面板显示的「默认值」就与实际出站头不一致
 * —— 而用户正是照着这个值决定要不要覆写的（显示错了比不显示更糟）。
 *
 * 故本模块**逐个 provider 引用真实的那个来源**（产品配置 / 适配器的解析函数 /
 * 框架归属头），一个 UA 字面量都不抄。
 *
 * ## 无法判定的 provider 返回 `undefined`（不编造）
 *
 * 非本插件的 provider（DSH 内置、其它插件的适配器）我们看不到它的 `send()`，
 * 无从知道它是否覆写了框架归属头。返回一个「框架 UA」看着更友好，但那正是
 * `defaultEffort` 那条判据的反面教材（见 `src/account-hub-rpc.ts` 的说明：
 * 编造一个值会让编辑器把「不知道」显示成「就是这个」）。故 `undefined` =
 * 缺席 = 编辑器不显示默认值。
 *
 * @module dsh-account-hub/provider-default-user-agent
 */
import { userAgent } from '@deepseek-ai/dsh-llm';
import { PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js';
import { LOBSTERAI } from './lobsterai-product.js';
import { BUDDY, BUDDY_CN, resolveUserAgent } from './product.js';
import { QODER, QODER_CN } from './qoder-product.js';
import { TRAE_CN_SOLO_USER_AGENT } from './trae-cn-models.js';
import { TRAE_CN } from './trae-cn-product.js';
/**
 * 现算某个 `provider` / `model` 组合的**默认** User-Agent（该适配器不配覆写时会发的值）。
 *
 * 逐 provider 的出处（**每一条都以实际代码为准**，改适配器时这里必须跟着改）：
 *
 * | provider | 取值 | 出处 |
 * |---|---|---|
 * | `codearts` | 框架归属头 `deepseek-harness/<版本> (+<url>)` | `src/llm-adapter.ts` 的 `new Headers(attributionHeaders())` |
 * | `buddy-cn` | `CodeBuddyIDE/1.106.1` | `BUDDY_CN.userAgent`（无模型族规则，全模型同值） |
 * | `buddy` | 按模型族分档 | `resolveUserAgent(BUDDY, model)`：`gpt-` / `gemini-` / `claude-` → 国际版，`glm-` / `hy` / `kimi-` / `minimax-` → 国内形态 |
 * | `lobsterai` | `LobsterAI/0.1.0` | `LOBSTERAI.userAgent`（`lobsteraiChatHeaders` 用它） |
 * | `trae-cn` | `Trae/0.1.61` | `TRAE_CN_SOLO_USER_AGENT`（SOLO 通道版本，与 IDE 代际的 `TraeClient/TTNet` 无关） |
 * | `qoder` | `qoder/1.1.16` | `QODER.userAgent` |
 * | `qoder-cn` | `qoder/1.1.58` | `QODER_CN.userAgent` |
 *
 * ⚠️ **qoder 两区（尤其 CN）的实际出站值以签名链为准**：CN 的 chat 走 wasm
 * 签名链，出站头由 wasm 在内部整包给出（`src/qoder-adapter.ts` 的 `sign()` /
 * `src/qoder-wasm-context.ts`），TS 层拿不到那份头。这里返回的是**产品配置里的
 * UA 常量**（wasm 的 `cosyVersion` / 客户端形态同源），面板显示的默认值可能与
 * 实际出站值不完全一致 —— 覆写对 CN 也因此**不生效**（见 `qoder-adapter.ts`
 * 走 wasm 分支处的告警）。
 *
 * @param provider - DSH provider id（本插件的七个之一，或任意其它 provider）。
 * @param model - 该 provider 下的模型 id（**buddy 系按它分档**，其余 provider
 *                与它无关）。
 * @returns 该组合的默认 UA；非本插件的 provider 返回 `undefined`（无法判定，不编造）。
 */
export function providerDefaultUserAgent(provider, model) {
    // codearts 的 UA **就是框架归属头**（它没有自己的 UA 覆写），故取 `userAgent()`
    // —— 与 `attributionHeaders()['user-agent']` 是同一个值、同一个来源（`dsh-llm`），
    // 比从 Record 里按下标取少一处类型断言。
    if (provider === CODEARTS_PROVIDER)
        return userAgent();
    // buddy 两区共用同一个适配器类，差异全在产品配置（含模型族 UA 规则表）。
    if (provider === BUDDY_CN.id)
        return resolveUserAgent(BUDDY_CN, model);
    if (provider === BUDDY.id)
        return resolveUserAgent(BUDDY, model);
    if (provider === LOBSTERAI.id)
        return LOBSTERAI.userAgent;
    if (provider === TRAE_CN.id)
        return TRAE_CN_SOLO_USER_AGENT;
    if (provider === QODER.id)
        return QODER.userAgent;
    if (provider === QODER_CN.id)
        return QODER_CN.userAgent;
    // DSH 内置 / 其它插件的 provider：看不到它的 send()，无从判定 ⇒ 不编造。
    return undefined;
}
//# sourceMappingURL=provider-default-user-agent.js.map