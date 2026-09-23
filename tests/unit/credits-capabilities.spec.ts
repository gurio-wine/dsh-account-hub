import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  CREDITS_CAPABILITIES,
  supportsCreditBalance,
  supportsDailyCheckin,
} from '../../plugin-src/client/credits-capabilities.js'

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Account Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [account-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而该端点以 `productById()` 判能力，CodeArts 根本不是
 * BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（CodeArts 两项现在都真、Buddy 国际版余额真/签到假）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 *
 * ⚠️ CodeArts 后来已接入真实实现（`src/codearts-credits.ts`），其能力由全假
 * 变为全真；**门控机制本身不变**，仍是防止「对不支持的 provider 发必然失败的
 * 请求」的那道闸。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 余额与签到都支持（华为云 SDK-HMAC-SHA256 签名协议）', () => {
    // ⚠️ 这两项**曾经是全 false**，理由是「华为云账号体系没有腾讯计费接口」——
    // 那个结论已被上游真机验证推翻：华为云侧有独立的「每日签到得积分」活动，
    // 端点挂在 `snap-access` 网关（与本仓已在用的 `SNAP_MODEL_BUILTIN_URL` 同域），
    // 用现有凭据的 AK/SK 签名即可访问。见 `src/codearts-credits.ts`。
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('codearts')).toBe(true)
    expect(supportsDailyCheckin('codearts')).toBe(true)
  })

  it('Buddy CN 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy-cn')).toBe(true)
    expect(supportsDailyCheckin('buddy-cn')).toBe(true)
  })

  it('Buddy（国际版）支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(false)
  })

  it('签到能力跟产品走、不跟键名走（buddy-cn 为 true，buddy 为 false）', () => {
    // ⚠️ 这条是改名时最容易改错的地方，故单独钉死。
    //
    // 改名是**对调式**的：中国版的 id 从 `buddy` 变成 `buddy-cn`，国际版的 id 从
    // `workbuddy` 变成 `buddy`。于是能力矩阵里 `buddy` 这个键**换了主人**。
    // 「有签到接口」是**中国版**的属性（国际版内核里只有 `get-dosage-notify`），
    // 所以 `dailyCheckin: true` 必须跟着中国版搬到 `buddy-cn`，绝不能照旧键名
    // 留在 `buddy` 上 —— 那会把「一键领取积分」按钮挂到国际版面板，每次点击都
    // 必然失败，而中国版反而没了按钮。
    expect(CREDITS_CAPABILITIES['buddy-cn']?.dailyCheckin).toBe(true)
    expect(CREDITS_CAPABILITIES.buddy?.dailyCheckin).toBe(false)
    // 余额是两产品共有能力（同一端点、仅 baseURL 随 endpoint 切换），一并锁死，
    // 免得上面那条被「顺手改对称」时把余额也改坏。
    expect(CREDITS_CAPABILITIES['buddy-cn']?.balance).toBe(true)
    expect(CREDITS_CAPABILITIES.buddy?.balance).toBe(true)
  })

  it('LobsterAI 余额与签到都支持（两套端点彼此独立）', () => {
    // 余额走 GET /api/user/profile-summary，签到走 client-activities 三步流程，
    // 与 Buddy 系协议完全不同源，但两项能力都具备。
    expect(CREDITS_CAPABILITIES.lobsterai).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('lobsterai')).toBe(true)
    expect(supportsDailyCheckin('lobsterai')).toBe(true)
  })

  it('Trae CN 余额与签到都支持（键名带连字符，与后端 provider 实参一致）', () => {
    // 余额走 POST /trae/api/v2/pay/web_user_ent_usage（双池），签到走
    // checkin_credits 两步流程。两项都支持，故面板要渲染积分行与两个按钮。
    //
    // 这条断言同时锁死**键名形态**：`trae-cn` 带连字符，写成 `traeCn` / `trae_cn`
    // 都会让 supportsCreditBalance('trae-cn') 落到「默认关闭」分支 —— 面板静默
    // 不显示积分，而且不报任何错，是最难发现的一类回归。
    expect(CREDITS_CAPABILITIES['trae-cn']).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('trae-cn')).toBe(true)
    expect(supportsDailyCheckin('trae-cn')).toBe(true)
  })

  it('Qoder 余额与签到都支持（两区同协议，国际版活动以服务端下发为准）', () => {
    // `balance`：步骤 4 的 src/qoder-credits.ts 提供的余额与 `CreditBalance`
    // 逐字段同构，CreditBalanceRow 直接复用，客户端不需要任何 provider 分支。
    //
    // `dailyCheckin` 是 true：现有六条签到面板（buddy-cn / lobsterai / trae-cn /
    // codearts / qoder / qoder-cn）。国际版端点 `sash/api/v1/me/campaigns`
    // 已于 2026-09-23 真机探测 HTTP 200、响应与 CN 逐字节同构 —— 旧定性
    // 「国际版无此活动」已推翻；活动以服务端下发为准、空列表归 already-claimed。
    //
    // ⚠️ 它与 `buddy`（`dailyCheckin:false`）**不同**：Buddy 国际版后端没有
    // 签到接口，是矩阵里唯一签到为 false 的条目。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('Qoder CN 余额与签到都支持（签到端点已解出并真机验收）', () => {
    // `balance`：CN 与国际版**同协议双 region**，走的是**同一个**
    // `fetchQoderCreditBalance`（按传入的 product 现算 host）。CN 侧实测只有
    // 两个池（userQuota + addOnQuota），而解析器本就是**三池容缺**（缺席按 0），
    // 故 CN 天然兼容、客户端零分支。
    //
    // `dailyCheckin` **曾经是 false，理由写在注释里的是「端点未知」** ——
    // 那个待办现已关闭：端点由 keylog 解密抓包解出并真机验收（2026-09-21），
    // 实现见 `src/qoder-credits.ts`，宿主分支见 `src/account-hub-rpc.ts`。
    // ⚠️ 国际版 `qoder` 同为 true（2026-09-23 真机探测 200 同构），见上一条用例。
    expect(CREDITS_CAPABILITIES['qoder-cn']).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder-cn')).toBe(true)
    expect(supportsDailyCheckin('qoder-cn')).toBe(true)
  })

  it('qoder-cn 与国际版 qoder 的签到理由必须分开读（真机探测日期不丢）', () => {
    // 这条守的是**「两个 region 的签到口径要分开写」**这件事，而不是某个
    // 布尔值（取值已由上面两条用例钉过）。历史上国际版定性为「活动不存在」、
    // CN 定性为「端点未知」待办，极易被后来者「统一」成一句。
    //
    // 现在两区 `dailyCheckin` 均为 true：国际版端点已真机探测（2026-09-23）
    // HTTP 200、响应与 CN 逐字节同构，旧定性「国际版无活动」已推翻。但两区
    // 依据不同（国际版=真机探测同构 / CN=keylog 解密抓包验收），探测日期与
    // 「以服务端下发为准」的口径必须保留在注释里。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/credits-capabilities.js'),
      'utf8',
    )
    // 国际版那段的真机探测依据与日期必须在。
    expect(source).toContain('2026-09-23 真机探测 HTTP 200')
    expect(source).toContain('国际版活动以**服务端下发为准**')
    // CN 那句理由必须保留（「已解出并真机验收」），且**不得**再留「端点未知」的待办定性。
    expect(source).toContain('端点已由 keylog 解密抓包解出并')
    expect(source).not.toContain('端点至今未知、未验收')
    expect(source).not.toContain('将来拿到端点后把它翻成 `true`')
    // 反面锚点：旧定性「每日 100 Credits 只能在桌面 App 手动领」「活动不存在」
    // 不得再作为**能力定性**出现（那意味着真机探测的结论没落地）。历史叙述
    // 「旧定性…已推翻」是可接受的（见文件头），故这里只查旧文案整句。
    expect(source).not.toContain('官方没有公开该端点')
    expect(source).not.toContain('每日 100 Credits 只能在桌面')
    // 取值本身要在**同一处**被钉住：两区都为真。
    expect(supportsDailyCheckin('qoder-cn')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('能力矩阵的键与 PROVIDERS 的 id 逐字对齐（含连字符 provider）', () => {
    // 集合相等那条断言用 PROVIDER_ENTRY_PATTERN 抓 id，而它的字符类必须是
    // `[a-z-]+`：只认小写字母的话，带连字符的 id 抓不到，于是**漏登记时那条
    // 断言依然是绿的**（集合两边都不含它）。这里直接锁死匹配器覆盖带连字符的 id，
    // 免得将来有人「图省事」把连字符从字符类里去掉。
    const ids = [...readClientSource().matchAll(PROVIDER_ENTRY_PATTERN)].map((m) => m[1]!)
    expect(ids).toContain('trae-cn')
    expect(ids).toContain('lobsterai')
    // 改名后的两组 id：中国版是 `buddy-cn`（带连字符），国际版是 `buddy`。
    // 旧的 `workbuddy` 必须彻底消失 —— 它在新体系里既不是 id 也不是 provider 实参，
    // 留在 PROVIDERS 里会让面板渲染出一个后端永远不认的标签页。
    expect(ids).toContain('buddy-cn')
    expect(ids).toContain('buddy')
    // Qoder 无连字符，与后端 `QODER.id` 逐字一致。
    expect(ids).toContain('qoder')
    // Qoder CN 是第二个 region，id **带连字符**（`qoder-cn`），写成 `qoderCn` /
    // `qoder_cn` 都会让能力矩阵查不到它 —— 面板静默不显示积分，且不报任何错。
    expect(ids).toContain('qoder-cn')
    expect(ids).not.toContain('workbuddy')
    expect(ids).toHaveLength(7)
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    //
    // `workbuddy` 一并列在这里：它**曾经是**合法 id，现在是历史名 —— 把它留在
    // 表里做「兼容」等于给一个后端已经不认的 provider 发积分请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__', 'workbuddy']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
    }
  })

  it('能力矩阵覆盖 PROVIDERS 中的每一个 provider', () => {
    // 客户端 PROVIDERS 列表与能力表必须同步：漏登记的 provider 会静默失去
    // 积分能力（默认关闭），而多登记的条目则是死配置。
    const source = readClientSource()
    const providerIds = [...source.matchAll(PROVIDER_ENTRY_PATTERN)].map((m) => m[1]!)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })
})

describe('客户端 PROVIDERS 列表（新命名）', () => {
  const source = readClientSource()

  /**
   * `PROVIDERS` 的**七条**最终形态。
   *
   * 顺序即面板标签页顺序，也是后端注册顺序；`label` 是面板标题与按钮文案里的
   * 显示名，`logoClass` 必须与 `account-hub-styles.js` 的
   * `.dim-ah-providerIcon.<class>` 逐字对齐（下面一条断言守这件事）。
   */
  const EXPECTED = [
    { id: 'codearts', label: 'Codearts', logoClass: 'codearts' },
    { id: 'buddy-cn', label: 'Buddy CN', logoClass: 'buddy-cn' },
    { id: 'buddy', label: 'Buddy', logoClass: 'buddy' },
    { id: 'lobsterai', label: 'LobsterAI', logoClass: 'lobsterai' },
    { id: 'trae-cn', label: 'Trae CN', logoClass: 'trae-cn' },
    // Qoder 排在 Trae CN 之后。它与上面五条的差别只在**产品自身**
    // （另一套 host / 另一套凭据体系），登录形态同为浏览器设备流 ——
    // PAT 粘贴曾在 2015b03 起并存，已于 2026-09-21 按用户要求移除。
    { id: 'qoder', label: 'Qoder', logoClass: 'qoder' },
    // Qoder CN 紧跟在 Qoder 之后（= PROVIDERS 的书写顺序）：同一个形态的
    // 第二个 region。`label` 是 `Qoder CN` —— 显示名只留产品名、不带公司注记
    // （下面「显示名不带公司注记」那条断言同样管着它）。
    { id: 'qoder-cn', label: 'Qoder CN', logoClass: 'qoder-cn' },
  ] as const

  it('七条 provider 的 id / label / logoClass 与定稿一致', () => {
    const entries = [...source.matchAll(PROVIDER_FULL_ENTRY_PATTERN)].map((m) => ({
      id: m[1]!, label: m[2]!, logoClass: m[4]!,
    }))
    expect(entries).toEqual(EXPECTED)
  })

  it('没有条目声明 loginHint（每个面板都自带「登录账号」入口）', () => {
    // `loginHint` 曾用于「本面板没有登录入口、去隔壁面板登录」的共用账号
    // provider（TraeWork 路线，官方已把该通道并入通用通道，那条 provider 已
    // 整体移除）。字段本身留在匹配器里是因为**加回来是好设计**：新增共用账号的
    // provider 时，缺省就是「有入口」，最坏结果是多一个本来就能用的按钮。
    //
    // 这条断言守的是**当前形态**：七个面板全部走浏览器设备流登录，
    // 谁都不该声明 loginHint —— 声明了会让 `canCreateAccount` 变 false、
    // 「登录账号」整块消失，而**不报任何错**，只是一个没有入口的死面板。
    const entries = [...source.matchAll(PROVIDER_FULL_ENTRY_PATTERN)]
    // 先钉死匹配器本身抓全了七条：漏抓的条目 `entry[5]` 恒为 undefined，
    // 会让下面那条断言在条目整个消失时反而是绿的。
    expect(entries).toHaveLength(EXPECTED.length)
    for (const entry of entries) {
      expect(entry[5], entry[1]).toBeUndefined()
    }
    const providerEntryOf = (id: string) =>
      [...source.matchAll(PROVIDER_FULL_ENTRY_PATTERN)].find((m) => m[1] === id)
    expect(providerEntryOf('qoder')?.[5]).toBeUndefined()
  })

  it('显示名不带公司注记', () => {
    // 用户明确要求：显示名只留产品名，不要「（腾讯）」「（有道）」「（字节跳动）」
    // 「（华为云）」这类注记。注释里叙述历史命名是允许的，故只查条目本身。
    for (const entry of [...source.matchAll(PROVIDER_FULL_ENTRY_PATTERN)]) {
      expect(entry[2], entry[1]).not.toMatch(/[（(]/)
    }
  })

  it('图标常量名跟着产品走：BUDDY_CN_ICON 是中国版、BUDDY_ICON 是国际版', () => {
    // 改名时图标本体不动，只换常量名与归属。这条断言钉死「哪个常量挂在哪个条目上」，
    // 免得将来有人看见两个名字相似就顺手对调，导致中国版面板显示国际版图标。
    const entries = new Map(
      [...source.matchAll(PROVIDER_FULL_ENTRY_PATTERN)].map((m) => [m[1]!, m[3]!]),
    )
    expect(entries.size).toBe(EXPECTED.length)
    expect(entries.get('buddy-cn')).toBe('BUDDY_CN_ICON')
    expect(entries.get('buddy')).toBe('BUDDY_ICON')
    // 两个 Trae CN 条目各自引用自己的常量这一约束已随第二条 Trae 路径移除；
    // 这里只钉死 IDE 路径自己那条。
    expect(entries.get('trae-cn')).toBe('TRAE_CN_ICON')
    // Qoder 的图标是**官方原图**（qoder.com 首页 rel=icon 指向的 412x412 PNG，
    // 原样 base64 内联），不是 SVG，也不与任何既有常量共用。
    expect(entries.get('qoder')).toBe('QODER_ICON')
    // ⚠️ Qoder CN **刻意复用** `QODER_ICON`（不是新常量）：两个 region 是同一个
    // 品牌，官方 `qoder.cn` 首页的 rel=icon 指向的正是**同一张** alicdn PNG。
    // 故两处都只能是 `QODER_ICON` —— 若谁给 CN 引入第二个图标常量，第二句会红，
    // 提醒他确认「是不是拿到了真正不同的官方标识」。
    expect(entries.get('qoder-cn')).toBe('QODER_ICON')
    // 旧常量名不得残留（它们现在指向不存在的符号，客户端会直接崩）。
    expect(source).not.toContain('CODEBUDDY_ICON')
    expect(source).not.toContain('WORKBUDDY_ICON')
  })

  it('logoClass 与 account-hub-styles.js 的图标容器类逐字对齐', () => {
    // 类名对不上不会报错：图标只是**没有白底**，肉眼几乎看不出来，
    // 是那种「改完看着正常、实际已经坏了」的隐性缺陷。
    const styles = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/account-hub-styles.js'),
      'utf8',
    )
    const styled = new Set(
      [...styles.matchAll(/\.dim-ah-providerIcon\.([a-z-]+)\s*\{/g)].map((m) => m[1]!),
    )
    for (const { logoClass } of EXPECTED) {
      expect(styled, `account-hub-styles.js 缺少 .dim-ah-providerIcon.${logoClass}`).toContain(logoClass)
    }
    // 反向：样式表里不该留下没有条目引用的死类（`workbuddy` 就是改名后的残留）。
    expect([...styled].sort()).toEqual(EXPECTED.map((e) => e.logoClass).sort())
  })
})

/**
 * 面板结构：登录入口与积分按钮。
 *
 * 这里只断言**面板的渲染条件**，不渲染组件 —— 本仓库把 react 排除在依赖之外
 * （`account-hub-credit-balance-row.spec.ts` 的文件头有完整说明）。金额/双池那类
 * 「分支输出差异」已经由那个文件用整树深比较守住，本组只管辖「谁渲染、谁不渲染」。
 */
describe('Account Hub 面板的结构（源码级回归）', () => {
  const source = readClientSource()

  it('「登录账号」无条件渲染，不按 provider 写分支', () => {
    // 每个面板都有自己的登录入口（浏览器设备流），故按钮**不该**挂在任何
    // provider 条件上：曾经那套「共用账号的 provider 不渲染按钮、改渲染提示行」
    // 的分支已随 TraeWork 路线 provider 一起移除。
    // 判据：面板代码里不得残留 `canCreateAccount` / `loginHint` 这类判定。
    const start = source.indexOf('const all = models || [];')
    expect(start).toBeGreaterThan(-1)
    const panel = source.slice(start)
    expect(panel).not.toContain('canCreateAccount')
    expect(panel).not.toContain('loginHint')
    expect(source).not.toMatch(/function providerLoginHint\(provider\)/)
  })

  it('积分能力仍然只在宿主判定的两处消费，面板不新增 provider 字面量分支', () => {
    // 能力矩阵是唯一真相源（见 credits-capabilities.js 的文件头）。
    // 积分行与「刷新积分」按钮都走 `canLoadCredits`，不为任何 provider 另写路径。
    expect(source).toContain('supportsCreditBalance(provider)')
    expect(source).toContain('showCredits: canLoadCredits')
    // 签到按钮仍按能力渲染。
    expect(source).toContain('supportsDailyCheckin(provider)')
    expect(source).toContain('if (!supportsCredits) return;')
  })

  it('账号列表请求发的是**面板 id**，映射不在客户端做', () => {
    // 映射收敛在宿主 `poolProviderFor()`。客户端若也映射一次，宿主那几个按池
    // 过滤的分支就必须跟着改，同一件事写两遍且可能分叉。
    expect(source).toContain("rpcCall('account.list', { provider })")
    expect(source).not.toContain("rpcCall('account.list', { provider: 'trae-cn' })")
  })
})

/**
 * Hub 面板 UI 调整包（六项）的源码级回归。
 *
 * `plugin-src/` 不在 typecheck 视野、react 不在依赖里，故这一组和上面几组一样，
 * 用**源码级断言**钉死可被正则确认的事实。样式三条尤其重要：`.dim-ah-page`
 * 的 height / `.dim-ah-layout` 的 overflow / `.dim-ah-panel` 的 overflow-y
 * 是**同一个机制的三条**，只改其中一条就会退化成「面板内没有滚动」或
 * 「左栏按钮宽度随供应商漂移」（两者都真机报障过）。
 */
describe('Hub 面板 UI 调整包（源码级回归）', () => {
  const source = readClientSource()
  const styles = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/account-hub-styles.js'),
    'utf8',
  )

  /** 取某条选择器的声明块（首个匹配）。 */
  const ruleOf = (selector: string): string => {
    const at = styles.indexOf(selector + ' {')
    expect(at, `account-hub-styles.js 里找不到规则 ${selector}`).toBeGreaterThan(-1)
    return styles.slice(at, styles.indexOf('}', at))
  }

  it('① 面板内滚动被保留，但滚动条视觉被隐藏（Firefox 与 Chromium 两条口径都写）', () => {
    // 滚动能力：面板自身仍可滚（此前那笔提交把它删掉了，本轮恢复）。
    expect(ruleOf('.dim-ah-panel')).toContain('overflow-y: auto')
    // 隐藏视觉：Firefox 走 scrollbar-width，Chromium / Electron 走伪元素。
    expect(ruleOf('.dim-ah-panel')).toContain('scrollbar-width: none')
    expect(styles).toContain('.dim-ah-panel::-webkit-scrollbar { display: none; }')
    // 右栏要滚得动，需要确定高度的父链：page 撑满、layout 裁掉溢出。
    expect(ruleOf('.dim-ah-page')).toContain('height: 100%')
    expect(ruleOf('.dim-ah-layout')).toContain('overflow: hidden')
  })

  it('② 供应商导航按钮恒等宽：左栏不被右栏内容挤压', () => {
    // 根因（真机实测）：`.dim-ah-layout` 去掉 overflow:hidden 后，`.dim-ah-panel`
    // 的 min-width:auto 解析为 min-content，右栏内容一宽就把 width:200px 且
    // flex-shrink 默认 1 的左栏挤窄 —— 实测 rail 217→200、按钮 200→183，
    // 而右栏内容随 provider 不同，表现就是「切换供应商时按钮宽度都变」。
    expect(ruleOf('.dim-ah-layout')).toContain('overflow: hidden')
    // 第二道保险：左栏自己不许收缩（光有 width 挡不住 flex-shrink）。
    expect(ruleOf('.dim-ah-rail')).toContain('flex: none')
    // 第三道：按钮的宽度计算方式固定，长名 / 选中态都撑不宽它。
    expect(ruleOf('.dim-ah-provider')).toContain('box-sizing: border-box')
  })

  it('③ 单账号「重测 / 重置」按钮已从账号卡片移除，且不留死 handler', () => {
    const cardStart = source.indexOf('function AccountCard(')
    expect(cardStart).toBeGreaterThan(-1)
    const card = source.slice(cardStart, cardStart + 4000)
    // 卡片上不再有这两个按钮，也不再接这两个 prop。
    expect(card).not.toContain("'重测'")
    expect(card).not.toContain("'重置'")
    expect(card).not.toContain('onRetest')
    expect(card).not.toContain('onReset')
    // 面板侧不再传这两个 prop（传了就是死代码，没人消费）。
    expect(source).not.toContain('onRetest:')
    expect(source).not.toContain('onReset:')
    // 单账号 help 常量随之删除，两个 all 版本的保留。
    expect(source).not.toMatch(/^const RETEST_HELP/m)
    expect(source).not.toMatch(/^const RESET_HELP/m)
    expect(source).toContain('RETEST_ALL_HELP')
    expect(source).toContain('RESET_ALL_HELP')
  })

  it('③（反面）宿主侧的单账号 RPC 与供应商级「清除限额」能力一律保留', () => {
    // ⚠️ 删的是 **UI 入口**，不是能力：`account.retest` / `account.reset` 两个
    // 端点是库层能力（headless / 测试 / 将来形态都可用），宿主一行未动。
    // 本用例读宿主源码，防止将来有人「顺手把没人用的端点删掉」。
    const host = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/account-hub-rpc.ts'),
      'utf8',
    )
    for (const endpoint of ["case 'account.retest'", "case 'account.reset'", "case 'account.retestAll'", "case 'account.resetAll'"]) {
      expect(host, `宿主缺少端点 ${endpoint}`).toContain(endpoint)
    }
    // 供应商级「清除限额」仍走 resetAll。
    expect(source).toContain("rpcCall('account.resetAll', { provider })")
    expect(source).toContain("rpcCall('account.retestAll', { provider })")
  })

  it('④ 供应商级按钮文案为「清除限额」（功能仍走 account.resetAll）', () => {
    expect(source).toContain("}, '清除限额')")
    // 旧文案不得残留（它现在既不对应功能，也会让用户以为在重置整个面板）。
    expect(source).not.toContain("'重置所有'")
  })

  it('⑤ 文案改为「模型列表」与「登录账号」', () => {
    expect(source).toContain("}, '模型列表')")
    expect(source).toContain("creating ? '正在登录…' : '登录账号'")
    // 空列表的引导文案与错误前缀同步（否则会指向一个不存在的按钮名）。
    expect(source).toContain("'点击\"登录账号\"进行浏览器登录。'")
    expect(source).toContain("setError('登录失败：'")
    // 旧文案不得残留在**代码**里。只查非注释行：文件里保留了叙述历史改名的
    // 注释（「旧文案『+ 新建账号』」），注释提及旧名是合理且有益的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain("'显示列表'")
    expect(codeLines).not.toContain('+ 新建账号')
    expect(codeLines).not.toContain('新建账号失败：')
  })

  it('⑥ 标题与设置页导航项都改为「账号中心」', () => {
    // 页面标题。
    expect(source).toContain("}, '账号中心')")
    // 设置页 section 的 label（宿主 settings 侧边导航显示的就是它）。
    const entry = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/index.js'),
      'utf8',
    )
    expect(entry).toContain("label: () => '账号中心'")
    expect(entry).not.toContain("'Account Hub'")
  })
})

/**
 * `PROVIDERS` 条目的匹配器。
 *
 * `[a-z-]+` 而不是 `[a-z]+`：provider id 允许带连字符（`trae-cn` / `qoder-cn`
 * 都是），而只认小写字母的正则会让**带连字符的条目在 `PROVIDERS` 里隐形** ——
 * 匹配不进 `providerIds`，于是「集合相等」这条断言在漏登记时反而是绿的。
 */
const PROVIDER_ENTRY_PATTERN = /\{\s*id:\s*'([a-z-]+)',\s*label:/g

/** 同上，但连 `label` / `icon` / `logoClass`（及可选的 `loginHint`）一起抓，供显示名与类名的断言使用。 */
const PROVIDER_FULL_ENTRY_PATTERN =
  /\{\s*id:\s*'([a-z-]+)',\s*label:\s*'([^']*)',\s*icon:\s*([A-Z0-9_]+),\s*logoClass:\s*'([a-z-]+)'(?:,\s*loginHint:\s*'([^']*)')?,?\s*\}/g

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（不支持的 provider 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits（头部「一键签到」）在发起 checkin.perform 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 600)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('checkin.perform', { provider })")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex, '头部「一键签到」应改走 checkin.perform').toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    expect(normalized).toMatch(/canLoadCredits\s*\n\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用
    const cardStart = normalized.indexOf('function AccountCard(')
    const cardBody = normalized.slice(cardStart, cardStart + 4000)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })
})

/**
 * 自动签到客户端 UI（源码级回归）。
 *
 * `plugin-src/` 不在 typecheck/test 视野（react 不在依赖、vitest 只扫
 * `tests/unit/**`），客户端的唯一语义防线是 `build:client` 顶层求值冒烟 +
 * 这里的**源码级正则断言**。故本组守的是「单片签到按钮存在且走 `supportsCredits`
 * 门控」「`checkinStatus` RPC 字符串存在」「成功 `data-kind="success"`」「头部
 * 文案改名」这些可被正则钉死的事实。
 */
describe('自动签到客户端 UI（源码级回归）', () => {
  const normalized = readClientSource().replace(/\r\n/g, '\n')

  it('单片「签到」按钮存在，且只按 supportsCredits 门控渲染（与既有积分按钮同源）', () => {
    // AccountCard 收到 showCheckin / onCheckin 两个新 prop。
    expect(normalized).toContain('showCheckin: supportsCredits')
    expect(normalized).toContain('onCheckin: (id) => void checkinAccount(id)')
    // 按钮元素按门控渲染（showCheckin ? 渲染 : null）。
    expect(normalized).toMatch(/showCheckin\s*\n?\s*\? React\.createElement\('button'/)
    // 按钮要带绿色成功形态与三态文案机。
    expect(normalized).toContain("'data-kind': 'success'")
    expect(normalized).toContain('checkedIn ? \'已签\' : checkingThisAccount ? \'签到中…\' : \'签到\'')
    // disabled 三态：busy（面板忙碌）|| 已签 || 正在签到。
    expect(normalized).toContain('disabled: busy || checkedIn || checkingThisAccount')
  })

  it('`checkin.perform` 单账号签到已接线，且失败不回写「已签」', () => {
    expect(normalized).toContain("rpcCall('checkin.perform', { provider, accountId })")
    // 守卫：只在支持签到时才动作。
    expect(normalized).toContain('if (!supportsCredits) return;')
    // 响应同构后 outcome 是完整对象，判定按 .kind：claimed 与 already-claimed
    // 都算已签；inactive/failed 不算。
    expect(normalized).toContain("outcome?.kind === 'claimed' || outcome?.kind === 'already-claimed'")
    // 成功带起余额刷新，与 claimCredits 同款。
    expect(normalized).toContain('if (canLoadCredits) void loadCredits();')
  })

  it('挂载时经 `credits.checkinStatus` 拉取今日签到状态（进入 Hub 即检测）', () => {
    expect(normalized).toContain("rpcCall('credits.checkinStatus', { provider })")
    // 只在支持签到的 provider 上拉。
    expect(normalized).toContain('if (!supportsCredits) return;')
    // 用 accountsRef 防并发读到空数组（设计文档点名的坑）。
    expect(normalized).toContain('accountsRef.current.length > 0')
    // 结果落地为 `accountId → { checkedInToday }`。
    expect(normalized).toContain('{ checkedInToday: Boolean(res.checkedIn?.[account.id]) }')
  })

  it('进入 Hub 时自动补签：挂载后只要存在未签账号就自动调一次 `checkin.perform`', () => {
    // 自动补签走全量 `checkin.perform({ provider })`（不带 accountId，覆盖全部账号）。
    expect(normalized).toContain("rpcCall('checkin.perform', { provider })")
    // 自动补签只在本面板挂载时触发一次：由**两个完成信号**（签到状态已落地 +
    // 账号列表已结算）门控的 effect 驱动，且用 autoCheckinRanRef 幂等防 StrictMode
    // 双执行与重渲染重复触发。
    expect(normalized).toContain('autoCheckinRanRef.current')
    expect(normalized).toContain('setCheckinStatusLoaded(true)')
    // ⚠️ 触发依赖必须只有这两个完成信号，**不含 `accounts`**：把「账号就绪」编码成
    // 「某个数组的引用变化」时，列表结算为「空」或「读取失败」的挂载周期里那个引用
    // 再也不会变，补签被静默吞掉（2026-09-24 修复的缺陷形态）。
    expect(normalized).toContain('if (checkinStatusLoaded && accountsLoaded) void autoCheckinOnEntry();')
    expect(normalized).toContain('}, [checkinStatusLoaded, accountsLoaded]);')
    expect(normalized).toContain('autoCheckinRanRef.current = true;')
  })

  it('自动补签就绪判据是「账号列表已结算」而不是「列表非空」（空/失败都必须照发）', () => {
    // 未结算：不置 ran、不发请求（等 accountsLoaded 置真后的那次 effect 补判）。
    expect(normalized).toContain('if (!accountsLoaded) return;')
    // 判据**不得**退回「引用非空」——那正是本次修掉的静默断流（列表读空或读失败
    // 时该判据永远为假，且不会再有下一次状态更新来救它）。
    expect(normalized).not.toContain('if (accounts.length === 0) return;')
    // 结算信号两个分支都要置真：读到空列表、以及读取失败。
    const loadAccountsStart = normalized.indexOf('const loadAccounts = React.useCallback')
    expect(loadAccountsStart).toBeGreaterThan(-1)
    const loadAccountsBody = normalized.slice(loadAccountsStart, loadAccountsStart + 1400)
    expect(loadAccountsBody.match(/setAccountsLoaded\(true\);/g) ?? []).toHaveLength(2)
  })

  it('自动补签跳过条件：已全部签到 / 已有签到在跑都不发请求（空列表不得被误判为已全签）', () => {
    // 已全部签过：不发请求。⚠️ `accounts.length > 0` 这一半是必需的 ——
    // `[].every()` 恒为 true，只留 every 会把「本地没有可判对象」误判成
    // 「已全部签过」，缺陷只换个位置复发（静默不发）。
    expect(normalized)
      .toContain('if (accounts.length > 0 && accounts.every(a => checkinsByAccount[a.id]?.checkedInToday === true)) return;')
    // 尚未真正发过判定/补签前不置 ran（保证账号就绪后能再进来补判一次）。
    expect(normalized).toContain('autoCheckinRanRef.current = true;')
    // 与手动签到（一键/单片）共用 claimingRef 互斥，避免并发各发一次。
    expect(normalized).toContain('if (claimingRef.current) return;')
  })

  it('自动补签失败静默：不弹打断性通知，仅刷新签到状态', () => {
    // 自动补签自己的 catch 只 console.error，不 setClaimNotice。
    const start = normalized.indexOf('const autoCheckinOnEntry')
    expect(start).toBeGreaterThan(-1)
    // 窗口要覆盖整个函数体（含本文件风格的长注释）—— 取到下一个顶层 const 为止，
    // 不用固定字符数：注释一长，固定窗口会把被断言的语句挤出视野（假失败）。
    const nextTopLevel = normalized.indexOf('\n  const checkinAccount = async', start)
    expect(nextTopLevel).toBeGreaterThan(start)
    const body = normalized.slice(start, nextTopLevel)
    expect(body).toContain('console.error(\'[account-hub] auto checkin failed:\', caught);')
    // 成功/失败后都重拉一次签到状态，让按钮态反映真实结果。
    expect(body).toContain('await loadCheckinStatus();')
    // 不弹 claimNotice（打断性通知）—— body 里不该出现 setClaimNotice，
    // 也不该出现那条「已有签到正在进行」提示（那是用户主动点击才该看到的）。
    expect(body).not.toContain('setClaimNotice')
    expect(body).not.toContain('CHECKIN_BUSY_NOTICE')
    // 宿主回 busy（另一路签到在跑）时**不能装作跑了**：留一行可区分的日志。
    expect(body).toContain('another check-in is already running')
    // 自动补签与手动 claimCredits 共用 claimingRef：手动一键也走该 ref 互斥。
    expect(normalized).toContain('claimingRef.current = true;')
  })

  it('头部按钮文案改为「一键签到」，全签显示「全部已签」并禁用', () => {
    expect(normalized).not.toContain(": '一键领取积分'")
    expect(normalized).toContain(": '一键签到')")
    // 三态文案机。
    expect(normalized).toContain("'签到中…' : allCheckedIn ? '全部已签' : '一键签到'")
    // 全签时禁用。
    expect(normalized).toContain('disabled: claiming || accounts.length === 0 || allCheckedIn')
    // allCheckedIn 派生：列表非空且每账号 checkedInToday 全 true。
    expect(normalized).toContain('accounts.every(a => checkinsByAccount[a.id]?.checkedInToday === true)')
    // 头部成功按钮复用绿色形态。
    expect(normalized).toContain("'data-kind': 'success'")
  })

  it('styles 提供 success（绿色）按钮形态，复用仓库既有成功绿而非新造色值', () => {
    const styles = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/account-hub-styles.js'),
      'utf8',
    )
    expect(styles).toMatch(/\.dim-ah-btn\[data-kind="success"\]\s*\{[^}]*#22c55e/)
    expect(styles).toContain('.dim-ah-btn[data-kind="success"]:hover:not(:disabled)')
    // 禁用态继承通用 :disabled，不与 success 冲突。
    expect(styles).toContain('.dim-ah-btn:disabled')
  })
})

/**
 * 单账号签到的反馈与 `unavailable` 接线（源码级回归，2026-09-23）。
 *
 * ## 三个真实缺陷（用户报障）
 *
 * 1. **点了没反应**：`checkinAccount` 在 `claimingRef` 被自动补签占用时**静默
 *    `return`**，用户点「签到」毫无反馈；
 * 2. **成败全无声**：该函数此前只把 `outcome.kind` 用来更新状态，四种 outcome
 *    一个字符都不弹给用户 —— 与「一键签到」（会弹 `claimNotice`）行为不一致；
 * 3. **按钮可点但无效**：单片按钮的 `disabled` 不含 `claiming`，一键签到在跑时
 *    按钮看起来能点、点下去被 ref 挡掉。
 *
 * ## 以及一个新接线
 *
 * `9074` 的定性改为「服务端名额/风控类拒绝」后归 **`unavailable`**：前端要能
 * 显示「暂不可签，稍后自动重试」，而不是把它报成失败（那会让用户去排查凭据/设备，
 * 而正确动作是等宿主 4h 的 sweep 自动重试）。
 *
 * `plugin-src/` 不在 typecheck/test 视野（react 不在依赖），故这里用**源码级
 * 正则断言**钉死接线；纯函数的渲染行为由 `account-hub-claim-notice.spec.ts` 的
 * 整树深比较覆盖（那份能真的调用组件）。
 */
describe('单账号签到反馈与 unavailable 接线（源码级回归）', () => {
  const normalized = readClientSource().replace(/\r\n/g, '\n')

  /** 取 `checkinAccount` 的函数体切片（到下一个顶层 const 为止）。 */
  function checkinAccountBody(): string {
    const start = normalized.indexOf('const checkinAccount = async')
    expect(start, 'checkinAccount 未找到').toBeGreaterThan(-1)
    const end = normalized.indexOf('const createAccount = async', start)
    expect(end, 'checkinAccount 的结束边界未找到').toBeGreaterThan(start)
    return normalized.slice(start, end)
  }

  it('① 四种 outcome 都交给 buildClaimNotice（不再是「只更新状态、不弹通知」）', () => {
    const body = checkinAccountBody()
    // 核心接线：响应直接喂给既有的通知构造器（`checkin.perform` 与
    // `credits.claimAll` 响应同构，故不需要另写一套摘要逻辑）。
    expect(body).toContain('setClaimNotice(buildClaimNotice(res))')
    // 状态判定仍只认 claimed / already-claimed（unavailable 与 failed 不写已签）。
    expect(body).toContain("outcome?.kind === 'claimed' || outcome?.kind === 'already-claimed'")
  })

  it('② claimingRef 被占用时不再静默 return（那正是「点了没反应」）', () => {
    const body = checkinAccountBody()
    // 守卫仍在（并发保护不能删），但分支里必须给用户一句话。
    expect(body).toContain('if (claimingRef.current) {')
    const guardIndex = body.indexOf('if (claimingRef.current) {')
    const noticeIndex = body.indexOf('setClaimNotice(', guardIndex)
    expect(noticeIndex, 'claimingRef 占用分支缺少用户可见反馈').toBeGreaterThan(guardIndex)
    // 反向护栏：不得回到「守卫后直接裸 return」的旧形态。
    expect(body).not.toContain('if (claimingRef.current) return;')
  })

  it('③ rpcCall 抛错时也弹通知（此前只有 console.error，页面无声）', () => {
    const body = checkinAccountBody()
    expect(body).toContain("console.error('[account-hub] checkin failed:', caught);")
    const catchIndex = body.indexOf("console.error('[account-hub] checkin failed:', caught);")
    expect(body.indexOf('setClaimNotice(', catchIndex)).toBeGreaterThan(catchIndex)
    expect(body).toContain("tone: 'error'")
  })

  it('④ 单片按钮的 disabled 含面板级签到忙碌（claiming 折进 busy 传入）', () => {
    // 账号卡片渲染处：`busy` 不再只是 probeBusy。
    expect(normalized).toContain('busy: probeBusy || claiming')
    // AccountCard 自身仍按 busy || 已签 || 本账号签到中 三态禁用。
    expect(normalized).toContain('disabled: busy || checkedIn || checkingThisAccount')
  })

  it('⑤ unavailable 明细接线：收集、回退文案、独立成段、传给 ClaimNotice', () => {
    // 收集函数存在，且只认 unavailable（与 failed 分开）。
    expect(normalized).toContain("item?.outcome?.kind === 'unavailable'")
    expect(normalized).toContain('function claimUnavailableLines(res)');
    // 回退文案**不是**「领取失败」（这一档不是失败）。
    expect(normalized).toContain("const CLAIM_UNAVAILABLE_FALLBACK = '服务端此刻暂不可签'")
    // 摘要行：`?? 0` 兜底旧宿主响应（否则旧宿主会渲染出「NaN 个暂不可签」）。
    expect(normalized).toContain('summary.unavailable ?? 0')
    expect(normalized).toContain('个暂不可签')
    // 独立成段渲染（不与失败明细共用一个列表）。
    expect(normalized).toContain("'data-kind': 'unavailable'")
    // 调用点把该字段透给 ClaimNotice。
    expect(normalized).toContain('unavailableDetails: claimNotice.unavailableDetails')
  })

  it('⑥ `Array.map` 不得直接传 formatClaimFailureLine 引用（下标会被当成回退文案）', () => {
    // 这是本次改动**真实踩到**的坑：新加的第二个形参（回退文案）与
    // `Array.map` 的第二个实参（下标）撞位，首行回退文案会变成 `0`。
    //
    // 只查「非注释行」：源码注释里保留了叙述该缺陷的写法，注释提及不算违规
    // （与上方 `CREDITS_PROVIDERS` 那条同款处理）。
    const codeLines = normalized
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('.map(formatClaimFailureLine)')
    expect(codeLines).toContain('.map((item) => formatClaimFailureLine(item))')
  })
})
