/**
 * Buddy 系凭据的**产品归属判据** —— 登录链与账号体检迁移共用的唯一真相源。
 *
 * ## 为什么需要独立模块（而不是留在体检迁移里）
 *
 * 判据原先只存在于 `src/provider-audit-migration.ts`（一次性**事后**体检：把
 * 历史脏数据的标签改对）。但那套判据回答的问题**同样**是登录链在写凭据前必须
 * 问的：「这份凭据到底属于哪个产品？」
 *
 * 两处各写一份的直接后果是**判据漂移**：登录链放行了体检要重建的东西（或反之），
 * 用户会看到「刚登录的账号立刻被标成归属不符」。故判据**只在这里定义一次**，
 * 体检迁移与登录链（`src/buddy-oauth.ts` 的 `runBuddyLoginFlow`）都从这里取。
 *
 * ## 本模块只覆盖 buddy 系（刻意的范围限定）
 *
 * 判据要求「凭据自带、不可伪造的归属证据」。逐个体检其余 provider 的凭据结构：
 *
 * | provider | 凭据里的归属线索 | 能否判定 |
 * |---|---|---|
 * | `buddy` / `buddy-cn` | `access_token` 是 JWT，带 `iss` 签发方；另有 `domain` 快照 | ✅ 本模块 |
 * | `lobsterai` | `access_token` **不是** JWT（不透明串），无 domain / host 字段 | ❌ 无判据 |
 * | `trae-cn` | `access_token` 是 JWT，但其 `iss` 与本产品端点的对应关系**未经实测确认** | ❌ 判据不明 |
 * | `qoder` / `qoder-cn` | `access_token` 是 PAT（`pt-…` 不透明串）；两区虽 host 不同，**PAT 本体不携带 region 标记** | ❌ 无判据 |
 * | `codearts` | AK/SK 三元组，无任何域名/签发方字段 | ❌ 无判据 |
 *
 * 对它们**不猜**：拿不到确凿判据时强行校验只会制造误判（把正常登录判成错配，
 * 而错配的处置是拒绝登录）。将来某家补上了可判定据，在这里加一条并配测试即可。
 *
 * ## 判据两级（与体检迁移同一套，勿分叉）
 *
 * 1. **JWT 的 `iss` 声明（首选）** —— 签发方写死在令牌里，比 `domain` 可信
 *    （后者是登录时的快照，历史迁移漏改过它）。只做 base64url 解码、**不验签**
 *    （此处不涉及信任判定：令牌另有服务端校验，本判据只用于本地归类）；
 * 2. **`domain` 字段（回退）** —— 老令牌没有 `iss` 时按它判。
 *
 * 判据表 {@link PROVIDER_ISSUER_PATTERNS} **从产品配置派生**，不在这里另造字面量：
 * 中国版要同时认「登录站 `www.codebuddy.cn`」与「API 端点 `copilot.tencent.com`」
 * —— 它的登录站与 API 端点**不是同一个域**（见 `src/buddy.ts` 的 `WEBSITE_HOME`）。
 *
 * ⚠️ **`iss` 与 `domain` 矛盾时以 `iss` 为准**（有测试钉死）。
 *
 * @module dsh-account-hub/credential-ownership
 */

import { WEBSITE_HOME, jwtIssuer } from './buddy.js'
import { ALL_PRODUCTS, BUDDY_CN, productById, type BuddyProduct } from './product.js'

/** 一个产品的凭据归属判据（全部由 {@link BuddyProduct} 配置派生，无字面量）。 */
export interface ProviderIssuerPatterns {
  /** 目标产品 id。 */
  productId: string
  /** `iss` 声明里出现的品牌域名（小写），命中即判定归属该产品。 */
  issuerHosts: readonly string[]
  /** `domain` 字段可接受的取值（小写；同时接受其 `www.` 变体）。 */
  domains: readonly string[]
}

/**
 * 从宿主域名里取**品牌域**（末两段；两段式 TLD 如 `com.cn` 取末三段）。
 *
 * `www.workbuddy.ai` → `workbuddy.ai`；`copilot.tencent.com` → `tencent.com`；
 * `www.codebuddy.cn` → `codebuddy.cn`（`com.cn` 规则只命中 `xx.com.cn` 形态）。
 */
function brandDomain(host: string): string {
  const parts = host.split('.').filter((part) => part.length > 0)
  if (parts.length <= 2) return parts.join('.')
  const tail = parts.slice(-2).join('.')
  // 两级公共后缀（com.cn / net.cn / org.cn …）：品牌域要再往前取一段。
  return /^(com|net|org|gov|edu)\.cn$/.test(tail) ? parts.slice(-3).join('.') : tail
}

/** 从 endpoint（URL）与 apiDomain 里抽出候选宿主名。 */
function hostsOf(product: BuddyProduct): string[] {
  const hosts = new Set<string>()
  hosts.add(product.apiDomain.toLowerCase())
  try {
    hosts.add(new URL(product.endpoint).hostname.toLowerCase())
  } catch {
    // endpoint 不是合法 URL 时忽略（配置是常量，这里只为稳健）
  }
  return [...hosts]
}

/**
 * 该产品的**登录站**宿主名（JWT `iss` 真正指向的域）。
 *
 * ⚠️ 只有中国版是「登录站 ≠ API 端点」的形态（`copilot.tencent.com` ↔
 * `www.codebuddy.cn`，映射关系早就写在 `src/buddy.ts` 的 `WEBSITE_HOME` 上）。
 * 国际版的 `endpoint` 本身就是登录站，故这里返回空数组、由 {@link hostsOf} 覆盖。
 * 别把 `WEBSITE_HOME` 直接套到国际版头上 —— 那是中国版的站点。
 */
function websiteHostsOf(product: BuddyProduct): string[] {
  if (product.id !== BUDDY_CN.id) return []
  try {
    return [new URL(WEBSITE_HOME).hostname.toLowerCase()]
  } catch {
    return []
  }
}

/**
 * 全部产品（buddy 系）的判据表 —— **唯一真相源是 `src/product.ts`**（外加
 * `buddy.ts` 那一个「登录站 ≠ API 端点」的既有映射）。
 *
 * 品牌域由产品自己的宿主名派生：
 *
 * | 产品 | API 端点宿主（`endpoint` / `apiDomain`） | 登录站宿主（令牌 `iss`） |
 * |---|---|---|
 * | `buddy` | www.workbuddy.ai | www.workbuddy.ai（`endpoint` 本身就是登录站） |
 * | `buddy-cn` | copilot.tencent.com | www.codebuddy.cn（`buddy.ts` 的 `WEBSITE_HOME`） |
 *
 * ⚠️ **中国版必须两处都取**：它的登录站与 API 端点**不是同一个域**（这正与
 * 产品注释里那句「`copilot.tencent.com` → `www.codebuddy.cn` 映射」同源）。
 * 只按 `endpoint` 派生的话，真实中国版令牌的 `iss=…codebuddy.cn` 会**判不出来**，
 * 体检只好回退到 `domain` 并给每条正常账号都打一条「无 iss」警告 —— 判据的
 * 覆盖范围凭空少一半。
 */
export const PROVIDER_ISSUER_PATTERNS: readonly ProviderIssuerPatterns[] = ALL_PRODUCTS.map(
  (product) => {
    const hosts = hostsOf(product)
    // 中国版：登录站宿主（`iss` 真正指向的地方）也要算进品牌域。
    // 用 `WEBSITE_HOME` 而不是再写一份字面量 —— 未配置登录站的产品为空数组。
    const issuerHosts = [...new Set([
      ...hosts.map(brandDomain),
      ...websiteHostsOf(product).map(brandDomain),
    ])]
    return { productId: product.id, issuerHosts, domains: hosts }
  },
)

/** 取某产品的判据；未知 product id 返回 undefined。 */
export function issuerPatternsFor(productId: string): ProviderIssuerPatterns | undefined {
  return PROVIDER_ISSUER_PATTERNS.find((entry) => entry.productId === productId)
}

/** 宿主是否属于某个品牌域（相等或以 `.品牌域` 结尾）。 */
function hostMatchesBrand(host: string, brands: readonly string[]): boolean {
  return brands.some((brand) => host === brand || host.endsWith(`.${brand}`))
}

/** 从 `iss`（通常是 URL，也可能是裸域名）里取出宿主名；取不到返回空串。 */
function hostOfIssuer(issuer: string): string {
  const raw = issuer.trim().toLowerCase()
  if (raw.length === 0) return ''
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    // 不是 URL：按裸域名/路径形态尽力取第一段宿主。
    const host = raw.split('/')[0]
    return host.includes('.') ? host : ''
  }
}

/** `domain` 字段的候选形态（自身 + `www.` 变体），用于与产品域集合比对。 */
function domainCandidates(domain: string): string[] {
  const raw = domain.trim().toLowerCase()
  if (raw.length === 0) return []
  return raw.startsWith('www.') ? [raw, raw.slice(4)] : [raw, `www.${raw}`]
}

/**
 * 由 `iss` 判定凭据归属。
 *
 * @returns 命中的产品判据；无法判定时返回 undefined（调用方回退到 domain）。
 */
export function productByIssuer(issuer: string): ProviderIssuerPatterns | undefined {
  const host = hostOfIssuer(issuer)
  if (host.length === 0) return undefined
  return PROVIDER_ISSUER_PATTERNS.find((entry) => hostMatchesBrand(host, entry.issuerHosts))
}

/** 由 `domain` 字段判定凭据归属；无法判定时返回 undefined。 */
export function productByDomain(domain: string): ProviderIssuerPatterns | undefined {
  const candidates = domainCandidates(domain)
  if (candidates.length === 0) return undefined
  return PROVIDER_ISSUER_PATTERNS.find(
    (entry) => entry.domains.some((expected) => candidates.includes(expected)),
  )
}

/** 待判定的凭据片段（`BuddyCredential` 结构上满足它）。 */
export interface CredentialOwnershipInput {
  /** `access_token` 本体；`iss` 由它解码得到（首选判据的来源）。 */
  access_token?: string
  /**
   * 已解码的 `iss`（可选）。
   *
   * 仅在调用方已解出时用；**JWT 里的 `iss` 优先于它** —— 前者写死在令牌里，
   * 后者可能来自被漏改的历史快照。
   */
  issuer?: string
  /** 凭据记录的登录域（回退判据）。 */
  domain?: string
}

/** 一次归属判定的结论。 */
export interface CredentialOwnershipVerdict {
  /** 判定的真实归属产品 id。 */
  productId: string
  /** 判据来源：`iss` = JWT 签发方，`domain` = 凭据 domain 字段。 */
  judgedBy: 'iss' | 'domain'
}

/**
 * 判定一份凭据属于哪个产品（两级判据，见模块头）。
 *
 * @returns 判定结论；**两级都说不清时返回 undefined**（凭据缺失 / 无 `iss`、
 *          `domain` 不属于任何已知产品）。调用方必须自行决定 undefined 的语义
 *          —— 登录链选择**放行**（无证据不等于错配），体检迁移选择**不动手**。
 */
export function judgeCredentialOwnership(
  credential: CredentialOwnershipInput,
): CredentialOwnershipVerdict | undefined {
  const fromJwt = typeof credential.access_token === 'string' ? jwtIssuer(credential.access_token) : ''
  const issuer = fromJwt.length > 0 ? fromJwt : (credential.issuer ?? '')
  const byIssuer = productByIssuer(issuer)
  if (byIssuer !== undefined) return { productId: byIssuer.productId, judgedBy: 'iss' }
  const byDomain = productByDomain(credential.domain ?? '')
  if (byDomain !== undefined) return { productId: byDomain.productId, judgedBy: 'domain' }
  return undefined
}

/**
 * 登录返回的凭据**属于另一个产品**时抛出。
 *
 * 消息是**可直接展示给用户**的中文文案（客户端把 `login.poll` 的 `error`
 * 原样渲染进面板通知行）：说清「实际属于谁」与「该去哪儿登录」，用户才知道
 * 下一步该做什么。
 */
export class CredentialProductMismatchError extends Error {
  /** 本次登录的目标产品 id。 */
  readonly expectedProductId: string
  /** 凭据实际归属的产品 id。 */
  readonly actualProductId: string
  /** 判据来源（`iss` / `domain`），供日志与测试断言。 */
  readonly judgedBy: 'iss' | 'domain'

  constructor(options: {
    expectedProductId: string
    actualProductId: string
    judgedBy: 'iss' | 'domain'
    message: string
  }) {
    super(options.message)
    this.name = 'CredentialProductMismatchError'
    this.expectedProductId = options.expectedProductId
    this.actualProductId = options.actualProductId
    this.judgedBy = options.judgedBy
  }
}

/**
 * **登录链的归属闸门**：判定刚拿到的凭据是否确实属于本次登录的产品。
 *
 * 为什么放在 `runBuddyLoginFlow` 的返回处（而不是各调用方写凭据之前）：
 * 那是 buddy 系**唯一**的凭据产出点 —— `account.create` 的后台第二段与
 * `BuddyAuth.login` 都从这里取 `flow.access`。闸门设在这里，两条路都不可能
 * 绕过，也不需要各自复制一份判据。抛出发生在调用方 `ctx.credentials.set`
 * **之前**，故凭据不会被写进错产品的池；`account.create` 的后台 `.catch`
 * 已有「登记失败终态 + 移除占位条目」的既定处置，天然复用。
 *
 * ## undefined（判不了）为什么放行
 *
 * 这是**刻意的失败开放**，理由是风险不对称：
 * - 错配是「我们**确凿知道**它属于另一个产品」—— 此时拒写是对的，且报错文案
 *   能指向正确面板；
 * - 判不了是「凭据里既无 `iss`、`domain` 也不属于任何已知产品」—— 它不是证据，
 *   而是**证据缺失**（后端改了响应、老令牌、内网代理域……）。此处拒写会把
 *   **所有**这类正常登录一并打死，代价远大于它想防的问题。
 *
 * 于是闸门只做一件事：**拦住能被证明的错配**。判不了时保持与今天逐字节相同的
 * 行为 —— 不新增拒绝路径，也就不新增误伤。
 *
 * @param product - 本次登录的目标产品。
 * @param credential - 刚构建好的凭据。
 * @throws {CredentialProductMismatchError} 凭据被确凿判定属于另一个产品。
 */
export function assertCredentialOwnership(
  product: BuddyProduct,
  credential: CredentialOwnershipInput,
): CredentialOwnershipVerdict | undefined {
  const verdict = judgeCredentialOwnership(credential)
  if (verdict === undefined || verdict.productId === product.id) return verdict
  const actualName = productById(verdict.productId)?.displayName ?? verdict.productId
  throw new CredentialProductMismatchError({
    expectedProductId: product.id,
    actualProductId: verdict.productId,
    judgedBy: verdict.judgedBy,
    // 文案的三段各有用途，缺一段用户就得自己猜：
    //  1. 「属于另一个产品（X）」—— 说清**为什么被拒**（而不是笼统的「登录失败」）；
    //  2. 「未写入当前账号池」—— 打消「是不是写进去了但没显示」的疑虑；
    //  3. 「请在 X 面板登录」—— 给出**可执行的下一步**。
    //
    // ⚠️ 第 3 段点名的面板是**凭据真正的归属方**（`actualName`），不是当前面板：
    // 用户此刻正站在当前产品的面板上、浏览器会话也确实属于 X —— 真正能成功的
    // 操作就是「去 X 的面板加这个账号」。让他「回当前面板登录」是无效指令
    // （同样的会话状态会得到同样的结果）。
    message: `登录返回的凭据属于另一个产品「${actualName}」，`
      + `未写入「${product.displayName}」账号池；请在「${actualName}」面板登录`,
  })
}
