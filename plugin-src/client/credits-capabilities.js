/**
 * 各 provider 的积分能力矩阵 —— Account Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧两个积分端点（`credits.balances` / `credits.claimAll`）都以
 * `productById(provider)` 解析产品配置（见 `src/jet-hub-rpc.ts`），而
 * **CodeArts 不属于 Buddy 系产品**，解析结果为 `undefined`，端点必定回
 * `bad-request: unsupported provider: codearts`。客户端早期在面板挂载时对所有
 * provider 无条件调用 `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[jet-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 这不是偶发故障，而是「请求了后端明确不支持的能力」这一设计缺陷的必然结果。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy-cn' || provider === 'buddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider        | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-----------------|---------------------|------------------------------|
 * | `codearts`      | ✗ 华为云账号体系     | ✗                            |
 * | `buddy-cn`      | ✓                   | ✓ Buddy CN 有签到接口         |
 * | `buddy`         | ✓                   | ✗ 国际版后端无签到接口        |
 * | `lobsterai`     | ✓                   | ✓ `client-activities` 三步流程 |
 * | `trae-cn`       | ✓ 通用池（IDE 路径能花的） | ✓ `checkin_credits` 两步 + 设备头 |
 * | `trae-cn-work`  | ✓ Work 池（TraeWork 能花的） | ✗ 签到留在 Trae CN 面板       |
 * | `qoder`         | ✓ 与 CreditBalance 同构 | ✗ 每日 100 Credits 只能桌面 App 手动领 |
 *
 * - `balance`：Buddy 系走 `POST /v2/billing/meter/get-user-resource`，该端点
 *   在 Buddy CN 与 Buddy（国际版）**通用**（仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 走 `GET /api/user/profile-summary`；Trae CN 走
 *   `POST /trae/api/v2/pay/web_user_ent_usage`，并按 `available_endpoint`
 *   **分池显示**（见下）；`trae-cn-work` 是同一个端点的**同一个实现**（同批账号、
 *   同一份凭据），差别只在**显示哪个池** —— 账号池键由宿主侧的 `poolProviderId`
 *   映射承载、显示池由 `traeCnPoolFor()` 承载，客户端不为此写第二套逻辑。
 * - `dailyCheckin`：Buddy 系是 `checkin-activity-status` + `daily-checkin`，
 *   **仅 Buddy CN（中国版）**有；Buddy（国际版）内核里只有 `get-dosage-notify`
 *   （用量通知），没有签到接口，故其面板不渲染「一键领取积分」。LobsterAI 是
 *   `client-activities` 三步流程（`src/lobsterai-credits.ts`）；Trae CN 是
 *   `checkin_credits/status` → `claim` 两步（`src/trae-cn-credits.ts`，claim 必须
 *   带设备四件套），故两者都支持。Qoder **不支持**（见下）。
 * - `trae-cn-work` 的 `dailyCheckin` 是 **false**（尽管它属于 Trae CN 账号体系）：
 *   签到是**账号级、当日一次**的操作，与走哪条路径无关。两个面板都放签到按钮
 *   必然是同一个账号两处重复领取 —— 第二次点击只会得到「今天已签到」，
 *   这在用户看来就是按钮坏了。故签到**只留在 Trae CN 面板**。
 * - ⚠️ `qoder` 的 `dailyCheckin` 是 **false**，且**与 Buddy（国际版）同形但
 *   原因完全不同**，不要因为「看着像」就顺手改对称：
 *   - `buddy` 是**后端根本没有接口**（内核里只有 `get-dosage-notify`）；
 *   - `qoder` 是**有这项权益但没有公开接口** —— 官方的每日 100 Credits 只能在
 *     **Qoder 桌面 App 里手动领取**，服务端未暴露可编程的签到端点。本插件也不
 *     打算用任何「模拟桌面客户端」的手段去领（那既不可靠也超出本插件的边界）。
 *   尤其**不能**因为它的 `balance` 是 true 就推断签到也能做 —— 正如不能用
 *   Buddy（国际版）没有签到反推它查不到余额一样，两个能力彼此独立。
 *   在面板上的表现是：Qoder 面板**渲染**积分行与「刷新积分」、**不渲染**
 *   「一键领取积分」。
 *
 * `trae-cn` 的 `balance` 走 `POST /trae/api/v2/pay/web_user_ent_usage`，响应里的
 * 礼包按 `available_endpoint` 分池，而**每个面板只显示自己那条路径能花的池**
 * （宿主按面板 id 选池，见 `src/jet-hub-rpc.ts` 的 `traeCnPoolFor()`）：
 * Trae CN 面板 = 通用池、Trae CN Work 面板 = Work 池。两边都是**单数字**，
 * 界面上不出现「通用」「Work」字样，资源包列表同样只含本池的包。
 * 分池前那套「双池超集 + `workTotal` 两段渲染」已删除（同一处显示两池时，
 * 永远有一段是那个面板花不掉的）。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 */

/** 单个 provider 的积分能力。 */
export const CREDITS_CAPABILITIES = Object.freeze({
  codearts: Object.freeze({ balance: false, dailyCheckin: false }),
  // ⚠️ 下面两行是**对调式搬运**，不要照键名机械对应：
  // 签到能力**跟产品走、不跟键名走** —— 有签到接口的是中国版，而中国版改名后
  // 占用了 `buddy-cn` 这个键；国际版拿走了 `buddy` 键，它**没有**签到接口。
  // 换句话说：`dailyCheckin` 的真值在改名前后都属于同一个产品（原 `buddy` 中国版
  // → 现 `buddy-cn`），只是因为国际版搬进了 `buddy` 这个名字，才看起来「翻了」。
  // 反着搬（照旧键名把 true 留给 `buddy`）会把签到按钮挂到国际版面板上，
  // 每次点击都必然失败。`tests/unit/credits-capabilities.spec.ts` 有断言钉死。
  'buddy-cn': Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: false }),
  // LobsterAI：余额走 profile-summary，签到走 client-activities 三步流程，两项都支持。
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Trae CN：余额走 web_user_ent_usage（**只显示通用池** —— IDE 对话扣的就是它），
  // 签到走 checkin_credits 两步流程（claim 带设备四件套），两项都支持。
  // 键名是 `trae-cn`（带连字符，与 `PROVIDERS` 的 id 及后端 provider 实参一致）。
  'trae-cn': Object.freeze({ balance: true, dailyCheckin: true }),
  // Trae CN **Work**（TraeWork 网页协议）。同一个产品、同一个账号体系、
  // 同一个余额端点（同一个 `fetchTraeCnCreditBalance`）—— 但**显示 Work 池**
  // （TraeWork 能花的那笔），故面板上的数字与 Trae CN 面板不同、且都是各自
  // 实际能花的钱。**不支持签到**：签到是账号级当日一次的操作，两个面板都放
  // 按钮必然重复领取。
  // 宿主侧两条接线各管一件事：`credits.balances` 的**账号池键**映射到 trae-cn
  // （`poolProviderFor()`）、**显示池**映射到 Work（`traeCnPoolFor()`），都在
  // `src/jet-hub-rpc.ts`；客户端不为此写第二套逻辑。
  'trae-cn-work': Object.freeze({ balance: true, dailyCheckin: false }),
  // Qoder：登录形态是 **PAT 粘贴**（其余六个 provider 全是浏览器登录），
  // 但它同样落进**账号池**，故余额行、「刷新积分」等既有通用路径一并适用。
  //
  // `balance: true` —— 步骤 4 的 `src/qoder-credits.ts` 提供的余额与
  //   `CreditBalance` **逐字段同构**（`total` / `packages` / `expiredTotal`），
  //   于是 `CreditBalanceRow` 直接复用，客户端**不需要任何 provider 分支**，
  //   宿主侧也不走 `traeCnPoolFor()` 那类选池映射（Qoder 只有一个池）。
  // `dailyCheckin: false` —— **刻意不做签到**：官方的每日 100 Credits 只能在
  //   Qoder **桌面 App 里手动领取**，没有公开 API（Qoder 的接入范围止于
  //   目录 / chat / 额度，见 docs/qoder-integration-plan.md）。
  //   ⚠️ 它与 `buddy` 在本矩阵里**同形（true/false）但原因完全不同**：
  //   前者是「后端无此接口」，后者是「有权益但只在桌面 App 手动领」。
  //   将来若有人照着 `buddy` 那一行「顺手改对称」，或者因为 `balance` 是 true
  //   就顺手把 `dailyCheckin` 也写成 true，Qoder 面板就会多出一个**每次点击
  //   都必然失败**的按钮（没有任何端点可打）。单测有断言钉死这两项。
  qoder: Object.freeze({ balance: true, dailyCheckin: false }),
});

/**
 * 该 provider 是否能查询积分余额。
 *
 * 为 false 时调用方**不得**发起 `credits.balances`，也不应渲染账号卡片的
 * 「积分」行与面板的「刷新积分」按钮 —— 否则卡片会永远停在「查询失败」。
 */
export function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}

/**
 * 该 provider 是否能执行每日签到领取（一键领取积分）。
 *
 * 为 false 时面板不渲染该按钮（CodeArts 无此能力；Buddy 国际版后端无接口）。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}
