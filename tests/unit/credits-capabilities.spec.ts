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
 * 1. 能力矩阵本身正确（尤其 CodeArts 两项全假、Buddy 国际版余额真/签到假）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 两项能力全为 false（华为云账号体系无腾讯计费接口）', () => {
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: false, dailyCheckin: false })
    expect(supportsCreditBalance('codearts')).toBe(false)
    expect(supportsDailyCheckin('codearts')).toBe(false)
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

  it('Qoder 支持余额但**不支持**签到（100 Credits 只能桌面 App 手动领）', () => {
    // `balance`：步骤 4 的 src/qoder-credits.ts 提供的余额与 `CreditBalance`
    // 逐字段同构，CreditBalanceRow 直接复用，客户端不需要任何 provider 分支。
    //
    // `dailyCheckin` 刻意是 false：官方的每日 100 Credits 只能在 Qoder
    // **桌面 App 里手动领取**，没有公开 API。
    //
    // ⚠️ 它与 `buddy` 在本矩阵里**同形（true/false）但原因完全不同**：
    //   - `buddy` 是「后端根本没有这个接口」；
    //   - `qoder` 是「有这项权益，但只在桌面 App 里手动领」。
    // 两者只是恰好落成同一组布尔值，**不是**可以互相推导的同一种情况 ——
    // 将来谁看见这两行「长得一样」想合并、或想「顺手改对称」，这条断言就会红。
    // 同样不能因为 `balance` 是 true 就顺手把 `dailyCheckin` 也写成 true：
    // 那会给面板加一个**每次点击都必然失败**的按钮（没有任何端点可打）。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: false })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(false)
  })

  it('Qoder CN 支持余额，签到为 false —— 但那是「**端点未知**」而不是「没有权益」', () => {
    // `balance`：CN 与国际版**同协议双 region**，走的是**同一个**
    // `fetchQoderCreditBalance`（按传入的 product 现算 host）。CN 侧实测只有
    // 两个池（userQuota + addOnQuota），而解析器本就是**三池容缺**（缺席按 0），
    // 故 CN 天然兼容、客户端零分支。
    expect(CREDITS_CAPABILITIES['qoder-cn']).toEqual({ balance: true, dailyCheckin: false })
    expect(supportsCreditBalance('qoder-cn')).toBe(true)
    expect(supportsDailyCheckin('qoder-cn')).toBe(false)
  })

  it('⚠️ Qoder 两个 region 的 dailyCheckin 都是 false，但**理由互不相同**，不得合并叙述', () => {
    // 这条断言守的是**代码注释里那两句理由**，而不是布尔值本身（上面的用例
    // 已经钉过取值）。原因：这两个 false 极易被后来者「统一」成一句
    // 「Qoder 没有签到」—— 而其中一句是**待办**，合并之后待办就消失了。
    //
    //   - `qoder`（国际版）：CLI2API 实测**国际版不显示签到**，活动不存在；
    //   - `qoder-cn`（国内版）：CLI2API 的 RegionDescriptor **只在 cn 挂
    //     Checkin** —— 疑似有签到，但**端点未知、未验收**，拿到端点后要翻 true。
    //
    // 故这里以**注释正文**为判据（与 qoder 那条同类手法）：
    // 若谁把 CN 那段的「端点未知」改写成「没有这项权益」，这条立刻红。
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/credits-capabilities.js'),
      'utf8',
    )
    // 两段理由必须各自成句、且都在文件里。
    expect(source).toContain('疑似有签到，但端点未知')
    expect(source).toContain('将来拿到端点后把它翻成 `true`')
    // 国际版那句也必须还在（不然「分开写」就退化成「只写 CN 一句」）。
    expect(source).toContain('CLI2API 实测**国际版不显示签到**')
    // 反面锚点：CN 那一段**不得**出现「没有这项权益」的定性。
    const cnCommentStart = source.indexOf('// Qoder **CN（国内版）**')
    const cnEntryStart = source.indexOf("'qoder-cn': Object.freeze(")
    expect(cnCommentStart, '找不到 Qoder CN 的注释段').toBeGreaterThan(-1)
    expect(cnEntryStart).toBeGreaterThan(cnCommentStart)
    const cnSection = source.slice(cnCommentStart, cnEntryStart)
    expect(cnSection).not.toContain('没有这项权益')
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

  it('没有条目声明 loginHint（每个面板都自带「+ 新建账号」入口）', () => {
    // `loginHint` 曾用于「本面板没有登录入口、去隔壁面板登录」的共用账号
    // provider（TraeWork 路线，官方已把该通道并入通用通道，那条 provider 已
    // 整体移除）。字段本身留在匹配器里是因为**加回来是好设计**：新增共用账号的
    // provider 时，缺省就是「有入口」，最坏结果是多一个本来就能用的按钮。
    //
    // 这条断言守的是**当前形态**：七个面板全部走浏览器设备流登录，
    // 谁都不该声明 loginHint —— 声明了会让 `canCreateAccount` 变 false、
    // 「+ 新建账号」整块消失，而**不报任何错**，只是一个没有入口的死面板。
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

  it('「+ 新建账号」无条件渲染，不按 provider 写分支', () => {
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

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 600)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
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
