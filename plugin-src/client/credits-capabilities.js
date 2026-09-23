/**
 * 各 provider 的积分能力矩阵 —— Account Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧积分端点按 provider 分派到**四套互不相同的协议**（见
 * `src/account-hub-rpc.ts`）：Buddy 系经 `productById()` 取产品配置，
 * 而 LobsterAI / Trae CN / CodeArts 与 Qoder 两区各自提前分支。**未知**
 * provider 仍会落到 `bad-request`，因此客户端必须
 * 在发请求之前按本表门控 —— 历史缺陷正是「对不支持的 provider 无条件发请求」：
 * 早期 CodeArts 两项能力皆无（当时它确实没有实现），客户端却在面板挂载时对所有
 * provider 调用 `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[account-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 * ⚠️ CodeArts 后来已接入真实实现（`src/codearts-credits.ts`，华为云
 * SDK-HMAC-SHA256 签名），故其能力由全假变为全真 —— **门控机制本身不变**，
 * 仍是防止「对不支持的 provider 发必然失败的请求」的那道闸。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy-cn' || provider === 'buddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider        | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-----------------|---------------------|------------------------------|
 * | `codearts`      | ✓ 华为云签名         | ✓ 华为云签名（四步）          |
 * | `buddy-cn`      | ✓                   | ✓ Buddy CN 有签到接口         |
 * | `buddy`         | ✓                   | ✗ 国际版后端无签到接口        |
 * | `lobsterai`     | ✓                   | ✓ `client-activities` 三步流程 |
 * | `trae-cn`       | ✓ 通用池（IDE 路径能花的） | ✓ `checkin_credits` 两步 + 设备头 |
 * | `qoder`         | ✓ 与 CreditBalance 同构 | ✓ 两区同协议（服务端下发为准） |
 * | `qoder-cn`      | ✓ 与 CreditBalance 同构（CN 两池容缺） | ✓ `sash/api/v1/me/campaigns` 领取 |
 *
 * - `balance`：Buddy 系走 `POST /v2/billing/meter/get-user-resource`，该端点
 *   在 Buddy CN 与 Buddy（国际版）**通用**（仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 走 `GET /api/user/profile-summary`；Trae CN 走
 *   `POST /trae/api/v2/pay/web_user_ent_usage`，并按 `available_endpoint`
 *   取池（见下）；CodeArts 走 `GET /snap-manager/v1/statistics/plugin`
 *   （与账户类型检测**同一响应**，见 `src/codearts-credits.ts`）。
 * - `dailyCheckin`：Buddy 系是 `checkin-activity-status` + `daily-checkin`，
 *   **仅 Buddy CN（中国版）**有；Buddy（国际版）内核里只有 `get-dosage-notify`
 *   （用量通知），没有签到接口，故其面板不渲染「一键领取积分」。LobsterAI 是
 *   `client-activities` 三步流程（`src/lobsterai-credits.ts`）；Trae CN 是
 *   `checkin_credits/status` → `claim` 两步（`src/trae-cn-credits.ts`，claim 必须
 *   带设备四件套）；CodeArts 是 `/v1/ops/delivery` → `/v1/ops/claim`
 *   →（`id !== null` 时）`/v1/ops/confirm` 四步（`src/codearts-credits.ts`）；
 *   Qoder CN 是 `sash/api/v1/me/campaigns` → `…/{campaignId}/claim` 两步
 *   （`src/qoder-credits.ts`）。
 * - Qoder 两区（`qoder` / `qoder-cn`）`dailyCheckin` **都为 `true`**，
 *   协议共用（宿主按传入 `product` 现算 host，见 `src/qoder-credits.ts`）：
 *
 *   1. `qoder`（**国际版**）—— **`true`**：端点
 *      `GET {openapiBase}/sash/api/v1/me/campaigns` 已于 **2026-09-23 真机探测
 *      HTTP 200**、响应与 CN 逐字节同构。旧定性「国际版无此活动」不成立 ——
 *      两区同协议。⚠️ 2026-09-24 真机定案：该端点**必须带
 *      `Cosy-ClientType: 10`**（缺头 ⇒ 空列表假象），判读为三态
 *      （`CLAIMED` ⇒ 已领、`CLAIMABLE` ⇒ 未签、**带头仍空** ⇒ `undetermined`），
 *      详见 `docs/agents/providers-qoder.md`。
 *
 *   2. `qoder-cn`（**国内版**）—— **`true`**：端点已由 keylog 解密抓包解出并
 *      真机验收（2026-09-21），宿主侧 `credits.status` / `credits.claimAll`
 *      的 `qoder-cn` 分支同步接线。
 *
 *   两个 region 的 `balance` 都是 true，都**不能**从它推断签到也能做 ——
 *   两个能力彼此独立。在面板上的表现是：两个 Qoder 面板都**渲染**积分行、
 *   「刷新积分」与「一键领取积分」。
 *
 * `trae-cn` 的 `balance` 走 `POST /trae/api/v2/pay/web_user_ent_usage`，响应里的
 * 礼包按 `available_endpoint` 分池，而面板只显示**本 provider 实际能花的那个池**
 * （宿主按 provider 选池，见 `src/account-hub-rpc.ts` 的 `credits.balances` 分支）：
 * Trae CN 面板 = 通用池。显示的是**单数字**，界面上不出现「通用」「Work」字样，
 * 资源包列表同样只含本池的包。
 * 分池前那套「双池超集 + `workTotal` 两段渲染」已删除（同一处显示两池时，
 * 永远有一段是那个面板花不掉的）。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 */

/** 单个 provider 的积分能力。 */
export const CREDITS_CAPABILITIES = Object.freeze({
  // CodeArts（华为云）：余额与签到**两项都有**，走 `SDK-HMAC-SHA256` 签名协议
  // （`src/codearts-credits.ts`，与另外三套协议都不共用）。
  // ⚠️ 这里曾经是**全 false**，理由是「华为云账号体系没有腾讯计费接口」——
  // 那个结论**已被上游真机验证推翻**：华为云侧有独立的「每日签到得积分」活动，
  // 端点挂在 `snap-access` 网关（与本仓已在用的 `SNAP_MODEL_BUILTIN_URL` 同域），
  // 用现有凭据的 AK/SK 签名即可访问，无需任何新登录流程。
  // 「没有腾讯计费接口」本身没错，但**不能据此推断没有积分能力**。
  codearts: Object.freeze({ balance: true, dailyCheckin: true }),
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
  // Qoder：登录形态是**浏览器设备流**（PAT 粘贴曾并存，已按用户要求移除），
  // 但它同样落进**账号池**，故余额行、「刷新积分」等既有通用路径一并适用。
  //
  // `balance: true` —— 步骤 4 的 `src/qoder-credits.ts` 提供的余额与
  //   `CreditBalance` **逐字段同构**（`total` / `packages` / `expiredTotal`），
  //   于是 `CreditBalanceRow` 直接复用，客户端**不需要任何 provider 分支**，
  //   宿主侧也不做选池（Qoder 只有一个池）。
  // `dailyCheckin: true` —— **两区同协议**（宿主按传入 `product` 现算 host，
  //   见 `src/qoder-credits.ts`）。国际版端点 `GET {openapiBase}/sash/api/v1/me/campaigns`
  //   已于 **2026-09-23 真机探测 HTTP 200**、响应与 CN 逐字节同构 —— 旧定性
  //   「国际版无此活动」已推翻，国际版活动以**服务端下发为准**。
  //   ⚠️ 2026-09-24 真机定案：该端点**必须带 `Cosy-ClientType: 10`**
  //   （缺头 ⇒ 空列表假象，不是服务端事实），判读为三态（`CLAIMED` ⇒ 已领、
  //   `CLAIMABLE` ⇒ 未签、**带头仍空** ⇒ `undetermined`）。
  //   ⚠️ 它与 `buddy`（`dailyCheckin:false`）**不同**：Buddy 国际版**后端没有
  //   签到接口**，是矩阵里唯一 `dailyCheckin` 为 false 的条目 —— 不要因为
  //   `balance` 是 true 就顺手把 Buddy 也写成 true。单测有断言钉死六条签到面板。
  qoder: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder **CN（国内版）**：与国际版**同协议双 region**（另一组 host + 另一组
  // 出站身份值），登录形态同样是 PAT 粘贴。
  //
  // `balance: true` —— `src/qoder-credits.ts` 是**同一份实现**（按传入的
  //   `product` 现算 host），返回结构与 `CreditBalance` 逐字段同构；
  //   CN 侧实测只有**两个池**（`userQuota` + `addOnQuota`，无 `orgResourcePackage`），
  //   而解析器本就是**三池容缺**（缺席按 0），故 CN 两池天然兼容、客户端零分支。
  //   ⚠️ 与 Trae CN 那条**不同**：Qoder 两 region 是**各自的池**，
  //   不存在「选哪个池显示」的问题，宿主侧也没有选池分支。
  //
  // `dailyCheckin: true` —— 与国际版**同为 true**（见上）。端点在 CN 侧经 keylog
  //   解密抓包解出并真机验收（2026-09-21）：
  //   `GET /sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`（body 空串）。
  //   ⚠️ 它挂在 **`/sash/`** 前缀下、**不是** `/api/`，也**不走 wasm 签名路径** ——
  //   早期只按 `/api/` 前缀搜端点，因此误判「Qoder 无签到」（那时这里的值是
  //   `false`，理由是「端点未知」）。宿主侧 `credits.status` / `credits.claimAll`
  //   / `checkin.perform` 对**两区均已接线**、按 region 分派（`src/account-hub-rpc.ts`
  //   经 `qoderRegionFor`），国际版端点 2026-09-23 真机验证 200 同构。
  'qoder-cn': Object.freeze({ balance: true, dailyCheckin: true }),
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
 * 为 false 时面板不渲染该按钮。当前矩阵里**只有 Buddy 国际版**是 `false`
 *（后端无签到接口）；Qoder 两区都是 `true`，见上。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}
