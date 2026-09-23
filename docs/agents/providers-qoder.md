# Qoder 实现细节

本文件由 AGENTS.md 迁出，供实现/维护 Qoder 两区（`qoder` / `qoder-cn`）时查阅。

## 服务名约定

原文照搬 AGENTS.md「LLM Provider 约定」中专属 Qoder 行项（`qoder-cn` 的 `serviceName` 声明与 `qoder` 反面判据）。

- **provider id 与 cordis 服务名是两件事**，不要机械派生。默认规则是 `${product.id}Auth`，但**机械派生结果不合法（带连字符）的 id 必须显式声明 `serviceName`**：`qoder-cn` → `qoderCnAuth`（`BuddyProduct` 已有必填字段 `serviceName`）。⚠️ **`qoder` 是反面判据**：它**无连字符**，`qoderAuth` 本身就合法，故 `QoderProduct` **刻意不声明 `serviceName`** —— 那条规则不是「所有 provider 都得声明」，**不要为了「形态统一」把两行写成一样**。`src/plugin.spec.ts` 已钉死 `ctx['qoder-cnAuth']` 为 `undefined`、`ctx.qoderCnAuth` 才是那个实例。新增 provider 时：id 可以带连字符，服务名必须是合法的 JS 标识符风格。

## Qoder 设备流：两段式的第三种形态

原文照搬 AGENTS.md「Qoder 设备流：两段式的第三种形态」整节（含 `machine_id` 读写真实 home、PAT 判据「键是否存在」）。

Qoder 两区**两种登录形态并存**（`src/qoder-device-flow.ts`），由 `account.create` 载荷里**有没有 `pat` 键**分流：无 `pat` 键 → 浏览器设备流（两段式，秒回 `loginUrl` + 后台轮询）；`pat` 是 string（含 `''`）→ PAT 粘贴（即时 exchange，同步完成）。

⚠️ **判据是「键是否存在」而不是「值非空」**：`{ pat: '' }` 的语义是「用户提交了一个空 PAT」，必须回「PAT 格式不正确」，**不是**静默开一个授权页（用户会以为表单坏了）。故实现里是 `typeof req.pat === 'string'` / `options.pat !== undefined`。

**与既有两段式的三处差异**：① 互斥槽位按 provider 分键（`activeLoginSlots`），两区**各自独立**（不是同一批账号，一区的登录窗口不该挡住另一区），占位在**第一个 `await` 之前**同步写入 `'preparing'`；② **轮询可取消**（`AbortSignal`）—— 每秒一次的活跃循环不取消会持续到 5 分钟超时，而槽位不释放会让此后所有登录都被 `login-in-progress` 挡住；③ **失败即移除占位**，**超时也是终态**。

⚠️ **`machine_id` 读写用户真实 home**（`~/.qoder/.auth/machine_id` / `~/.qoder-cn/.auth/machine_id`），**与官方 CLI 同路径是刻意的**（混用时机器身份稳定，wasm 签名链才不失效）。**任何测试都必须注入 `homeDir`**，否则会污染用户环境；生产下 IO 失败退回内存态 UUID，**不抛错**。

⚠️ **设备流与 PAT 写同一种凭据形态**（`access_token` = 令牌或 PAT），故 `refresh` / 额度 / 目录三条下游链路一行未改。⚠️⚠️ **但设备流没有「换令牌」这一步**（真机 400 根因）：`dt-…` 本身就是可用 Bearer，交给 PAT 专用的 `jobToken/exchange` 恒回 400；分派与 poll 判据详见 README。

## Qoder 国际版（`qoder`）—— chat 250 的三条硬事实

原文照搬 AGENTS.md「Qoder 国际版（`qoder`）—— chat 250 的三条硬事实」整节。

⚠️ **`tools` 必须包裹成 OpenAI 标准形态（2026-09-21 真机报障根因）**：`buildQoderChatBody` 必须把 harness 的 `ToolSchema`（`{name,description,parameters}`）翻译成 `{type:'function',function:{…}}` 再发（`serializeQoderTools`）。**原样透传会让非 `lite` 模型恒回 HTTP 200 流内 `provider_error`**（用户可见包装码 + `INVALID_REQUEST`），details 原文 `'function' is a required property, expected an object - 'tools.0'`。⚠️ **`lite` 是唯一两种形态都不报错的模型**（上游宽松兼容路径）—— 这正是它逃过 T2 的原因（T2 发的是手写 OpenAI 形态）。包裹后 `qmodel`/`gmodel`/`dmodel`/`lite` 实测仍回标准结构化 `tool_calls`，其余六个 provider 也都是这么包的。

⚠️ **256 KiB 字节墙 + 240 KiB 本地闸门（2026-09-21 字节级矩阵取证）**：Qoder 国际版 chat 网关对请求体有**确定性**字节墙 —— body ≥ 262 144 B 恒回 HTTP 500 `{"error":"internal server error"}`，**无任何可判别的 code**（262 144 → 200、262 145 → 500，多次复测零抖动）。故 `QODER_MAX_REQUEST_BYTES = 245_760`（留 ~8.5% 余量），`QoderAdapter.stream()` 在 `buildQoderChatBody` 之后、fetch 之前量 `Buffer.byteLength(body,'utf8')`，**达阈值即不发请求**。⚠️ **映射成 `CONTEXT_WINDOW_EXCEEDED` 是刻意的**：「未知码不得瞎猜」管的是**上游语义未知**（猜就是编造），本地字节数是**我们自己算出的确定性事实**，而 DSH 的自动压缩补救**只认这一个码**。⚠️ 判据走**显式标志位** `classification.localByteGate`，**绝不靠文案关键词**（闸门文案是中文、正则是英文，靠关键词会静默失效）；**绝不能交给 HTTP 兜底** —— `500 → backoff` 会把确定性失败变成无限退避重试。**声明窗口 200_000 一律不改**：它决定压缩后的保留预算（16% × 200K ≈ 134 KiB，在墙内），决定不了压缩触发时机（0.8 × 200K ≈ 655 KiB，**永远在墙之后**）—— 闸门负责挡墙，声明值负责保留量。每次发送把 `bodyBytes` 经 `onDebug` 以 **debug 级**报出（⚠️ Cordis 默认导出阈值是 INFO，要看撞墙趋势需把 exporter level 提到 3）；闸门在 `qoder` / `qoder-cn` 共享的发送代码里，**对 CN 同样生效**（量的是签名**之前**的明文）。

⚠️ **`provider_error` 的真因在 `details`，且有多种形态**：`details.error.code`（T3 原形态）、**整段带 `data: ` 前缀的 SSE 帧原文**、只有 `details.error.message`/根层 `message`（无 code）、`details.error.code` 是业务文本（如 `"1210"`）。`parseQoderWrappedDetail` 必须**既认码也认文案**；**流内** `provider_error` 帧的真因同样只在 `details` 里 —— 故 `parseQoderStreamErrorPayload` 带出 `details`、适配器流内分支必须把它作为 `body` 传给分类器。

## Qoder wasm 签名链（两区共用）—— CN chat 复活的关键

原文照搬 AGENTS.md「Qoder wasm 签名链（两区共用）—— CN chat 复活的关键」整节。

⚠️ `/algo/api/v2/service/pro/sse/agent_chat_generation` 是签名路径，必须整包替换 URL + headers + body（`body` 是密文，`url` 由 wasm 拼好含 `?FetchKeys=…&Encode=1`，20 个 header 含 `Authorization: Bearer COSY.…` / `Cosy-Key` / `Cosy-MachineId` / `X-Model-Key` / `X-Model-Source`）。**只补签名头不换 body 必回 `101 Signature invalid`** —— CN chat 长期不可用的头号原因。⚠️ `endpoint` 参数是 **host 基址**（`https://gateway.qoder.com.cn`），不是完整 URL。

⚠️ **`uid` 必须是真实用户 id**：取自 `GET {openapiBase}/api/v1/userinfo`（Bearer `jt-`），回退序 `id → user_id → uid`。真机 A/B：空串 → `101`，真实 uid → 200 + SSE 真内容；`exchange` 响应**不含** userId。

⚠️ **`machineId` 由签名器自己走登录链取**（`readOrCreateQoderMachineId(product)`，即设备流落盘的**同一份文件**，真机核对 `Cosy-MachineId` == 磁盘内容）。**不要另写一份** —— 那份函数承载「已存在绝不覆盖 / 缺失则生成落盘 / 落盘失败退回内存态且不抛」三条契约，不同源会被上游以 `101`（与凭据失效同形）拒绝。⚠️ 取用必须在复用判据之前；测试里**必传** `machineIdOptions.homeDir`。⚠️ **`product` 绑定在签名器构造时**，同一实例被两个 region 交替使用会拿 CN 机器码签国际版请求 ⇒ 按 region 各建一个 `QoderWasmSigner`。

⚠️ **构造要跑两段**：先用五个业务字段（`uid` / `security_oauth_token` / `organization_id` / `organization_tags` / `data_policy_agreed`）调 `generate_runtime_auth_fields` 拿 `{encrypt_user_info, key}`，再并进 `userInfoJson` 才 `qodercontext_new`；缺它 wasm 抛 ``missing field `encrypt_user_info` ``。**PAT 路径同样要跑**。⚠️ **wasm 是内联 base64 而非独立文件**（单条字面量 398 144 字符 → 298 606 字节，内联在 worker runtime）：抠取**按前缀定位、不写死偏移**，前缀用 5 字符 `AGFzb` 而非 `AGFzbQ`（第 6 字符由第 5 字节高位决定，写死它等于假设「wasm 版本恒为 1」）。

**三级提取**（缓存是快路径，细节见 README）：① 本机已装 Qoder（`…/@qoder-ai/<包名>/dist/_worker/qoder-worker-runtime[.obf].mjs`，35 MB 上下）→ ② npm tarball → ③ 官方 CDN `…/qodercli-worker-runtime-win32-x64.tgz`。**每级提取后 SHA-256 校验，不匹配即当该级失败继续降级**（四来源同值 `6419471e…b43d`，298 606 B）。⚠️ 三个坑：国际版 npm `@qoder-ai/qoder-agent-sdk` **不含 worker**（由 ③ 兜住）；CN 包名是 `@qodercn-ai/qoderclicn`（**不是** `@qoder-ai/qoder-cn-agent-sdk`，后者 404）；CDN 平台 token 是 Go 风格 `win32-x64`（写 `windows-x64` 会 404）。**缓存** `~/.dsh/qoder-wasm/qoder_auth_wasm_bg.wasm`（原子替换），两区共用。**许可红线**：只做运行时提取，**不把 wasm 字节提交进仓库、不随插件包分发**。

**glue 是手写复刻的**（`src/qoder-wasm-glue.ts`）：官方那份内联在 35 MB worker 里，本插件不整体加载，故按取证的 31 个 import 语义重写。⚠️ **两个同名不同义的坑必须按完整名分派**：`__wbg_getRandomValues_*` / `__wbg_new_*` 各有变体（`new Uint8Array(len)` vs `new Map()`）。**未知 import 显式抛错**（塞空函数会让 wasm 深处以「签名算错」失败，难查得多）。

**真机验证**（细节见 README）：① CN 签名路径 ✅ 200 + SSE 真内容、无 `101`；② 国际版同路径 ⚠️ 签名通过、业务 400（host `api1.qoder.sh`，`api2-v2` 404 ⇒ 协议可达、**参数待校准**）；③ 国际版大 body 字节墙 ⏸ 未测；④ **CN 接入适配器后三档全通过 —— ④才是「CN chat 可用」的证据**，①②只证明签名算子有效。

⚠️ **签名路径的帧是双层信封，不是裸 OpenAI chunk**：每帧是 `data:{"headers":{…},"body":"<内层 JSON 字符串>","statusCodeValue":200,…}` —— 内层**再 `JSON.parse` 一次**才是标准 chunk；收尾 `"body":"[DONE]"`（**`[DONE]` 也被包着**）。只认裸帧会让每帧都落进「`choices` 不是数组 ⇒ 跳过」，表现为 `Stream ended without [DONE]`，而 HTTP 与签名全是好的。剥离判据 `unwrapQoderFrame`：**`statusCodeValue` 是数字 + `body` 是字符串，两个都在**才当信封（只认 `body` 会误伤国际版裸帧，有反向断言）。夹具 `tests/unit/fixtures/qoder-cn-signed-sse.sse.txt` 是逐字节真机副本。

⚠️ **接入方式**：`stream()` 在 `buildQoderChatBody` 后、字节闸后按 region 分流 —— CN 走签名路径，**国际版一行不动**（REST + jt，逐字节回归）。`QoderAdapterOptions.signing` 由 `src/index.ts` 注入 `QoderSigningProvider`（per-region 实例）。⚠️ **CN 未注入 `signing` 时直接抛错、绝不回退 REST**（回退得到上游 503，用户看到「网关故障」而非「插件没接线」，后者才是可修的配置错误）；**签名分支不做 401 重换重试**；**字节闸仍量明文**；**逃生阀对 CN 作用于 `hostBase`**，签名后的完整 URL **不再过**该函数。⚠️ **两个新错误形态进分类器**：`101` + `Signature invalid` → 直报 + 提示重新登录（码与文案**两件都对**才算）；`QoderWasmUnavailableError` → 直报 + 三级尝试原因。**未知码照旧直报不猜**。`uid` 取不到时 `contextFor` 抛错、一次都不签。

## Qoder CN（`qoder-cn`）—— 第二 region 的两条要点

原文照搬 AGENTS.md「Qoder CN（`qoder-cn`）—— 第二 region 的两条要点」整节（含 CN 三基址、错误分类按 region 分流、逃生阀、CN 三个出站身份标识）。

`qoder-cn`（显示名 **Qoder CN**）与 `qoder`（国际版）**同协议双 region**：exchange / quota / models 三个端点的错误信封逐字节同构、PAT 前缀同为 `pt-`、目录字段同构，故**代码只有一份**（`src/qoder*.ts` 按传入的 `product` 现算），差异全部收敛在 `src/qoder-product.ts` 的两份 `QoderProduct` 配置里。

⚠️ **两区是两套账号、两套 Credits、两套令牌 —— 各自独立，没有任何池映射**：账号**各自独立**（凭据 ref 前缀 `QODER_ACCOUNT_*` vs `QODER_CN_ACCOUNT_*`）、令牌**互不承认**（拿错 host 打 = 「凭据失效」的假象）、`poolProviderFor()` **恒等**、积分各查各的额度端点。⚠️ **不要照抄别的 provider 去造映射**：历史上有一个复用 `trae-cn` 账号的 TraeWork 路径 provider（已于 `47bd690` 随官方合并而移除），它的「同一批账号 + 必须映射」写法**只属于它**。

⚠️ **把 `qoder-cn` 映射到 `qoder` 是静默故障**：CN 面板会列出国际版账号、用 CN 凭据打国际版 host —— 端点仍回 `ok: true`，只是账号对不上 / 报「凭据失效」。`qoder-hub-panel.spec.ts` 与 `qoder-cn-rpc-dispatch.spec.ts` 从两个方向钉死。

**CN 三个基址**：`openapi.qoder.com.cn`（✅）、`api.qoder.com.cn`（✅）、**`gateway.qoder.com.cn`（chat，签名路径的 host）**。⚠️ **旧定性「阿里云侧未就绪 / PAT 结构性不可用」已被推翻**：① 「503 是路径级的」**仍成立**（`/model/v1/chat/completions` 在 CN 网关不存在，ALB 恒 503）；② 「PAT 给不出用户密钥」**错了** —— 签名四要素 PAT 路径全拿得到，空 uid 才回 `101`。**CN chat 现走 `/algo/…/agent_chat_generation` + wasm 签名**。**错误分类按 region 分流**：CN 的 chat 503 直报 `'fail'`（不退避、不换号、不记徽章、`INVALID_REQUEST`）—— ⚠️ **该分支保留不动**（逃生阀指向别处或将来误接回 REST 时的兜底），判据**显式列举 `=== QODER_CN.id`**（防第三个 region 被静默归入）；国际版 503 维持 `backoff` → `RATE_LIMIT`。**逃生阀** `QODER_MODEL_SERVER_HOST` 覆盖 chat 的 host（⚠️ **只影响 chat**；路径与查询串丢弃；**请求时读取**），作用于两区；对 CN 改的是**传给签名器的 hostBase**（签名后的 URL **不再过**该函数）。⚠️ **绝不因「打不通」就改成国际版 host** —— 那会把「路径不存在」伪装成「凭据失效」（实测 **CN 的 `jt-` 打国际版 chat 回 401**，用户会被引向反复重贴 PAT 的死路）。

**CN 的三个出站身份标识**：UA **`qoder/1.1.58`**（官方模板 `` `qoder/${版本}` ``，**与 region 无关**；此前的 `qodercn/1.1.58` 是把 npm 包名当产品名的**推断错值**）、`client_type: "5"`、**Cosy 头**。⚠️ **签名路径下这三者的实际出站者都是 wasm**；适配器 `send()` 里的 Cosy 追加代码**对 CN 已无可达路径**，属残留。⚠️ `Cosy-MachineOS` / `Cosy-MachineHostname` **刻意不实现**（**不猜机器身份**）。

## 账号卡片昵称与有效期

两区账号卡片曾经显示「昵称是一串 UUID」「有效期未知」，真因与修法如下（两区共用一份实现）。

**昵称**：登录链原先把 `credential.user_id`（UUIDv7）当昵称写进账号池，而真正的用户资料在 `GET {openapiBase}/api/v1/userinfo`（Bearer 用 `getJobToken(access_token)` —— **`dt-` 恒等零网络，`pt-` 先换 `jt-`**，两令牌族同一套代码）。⚠️ **该端点与签名链共用同一份解析**（`readQoderUserIdentity` 补出 `displayName` / `email` / `mobile`），**不要另写第二份** —— 两处分头解析同一个响应，字段名一变必然只改一处，表现为「签名好了但昵称还是 UUID」这种半失效。昵称取值优先级：`name` → `email` → **脱敏后**的 `security_mobile`（`189****3995`，对齐 buddy/lobsterai 卡片惯例）→ `user_id`（兜底，与改动前逐字一致）→ 账号 id。⚠️ **userinfo 取不到时绝不炸登录**（回落到 `user_id`）：资料只是显示用的字符串，把它升级成失败会让用户白走一遍授权页。脱敏是**展示层**职责（`maskQoderMobile`），解析层存原文。

**有效期**：设备流凭据带 `token_expires_at`（≈30 天）。⚠️ **只有设备令牌族能写 `expiresAt`** —— `qoderAccountExpiresAtMs` 对 PAT 恒 `undefined`，因为 PAT 凭据里的 `token_expires_at` 记的是 **`jt-`（运行时缓存）** 的 24h，不是 PAT 的有效期；写进卡片会让它在闲置一天后显示「已过期」而实际请求完全正常。`refreshable` 为真时客户端会自动追加「· 自动续期」。设备令牌**续期成功后必须回写 `expiresAt`**（`refreshAll`），否则卡片一直停在旧的到期日——`expiresAt` 是账号条目的独立字段，不随凭据自动同步。⚠️ 续期回写**只写 `expiresAt`、绝不碰 `nickname`**：用户可手动改名，而续期链每 30 分钟跑一趟。

**存量账号回填**：只修登录链不够（盘上条目的昵称**已经是** UUID、且从没写过 `expiresAt`）。`QoderAuth.backfillAccountProfiles(pool)` 做惰性回填，挂在**既有**的每 30 分钟批量续期链 + 插件启动时一次（`src/index.ts`），**不自造定时器**。判据收敛在 `needsQoderAccountProfileBackfill`，**幂等是唯一必须守住的性质**：昵称不是占位形、且（该凭据本来有可报告有效期时）有效期已记 ⇒ 一次网都不出。⚠️ 判据绝不能写成「昵称是 UUID **或** 缺 `expiresAt`」—— PAT 的 `expiresAt` 永远解析不出来，那会让每个 PAT 账号每 30 分钟白打一次 exchange + userinfo，**永不停止**。⚠️ userinfo 取不到时**整条跳过**（不写任何字段）：此时唯一写得出的昵称就是那个 UUID，写回去等于用一次白跑的网络把「待回填」标记擦掉，以后再也不修了。

## Qoder 积分领取与余额

原文照搬 AGENTS.md「积分领取」「积分能力必须在请求前判定」中专属 Qoder 段。

- **Qoder** —— `src/qoder-credits.ts`（两步，**两区同协议**，经传入 `product` 现算 host；**宿主侧 `credits.status` / `credits.claimAll` / `checkin.perform` 对两区均已接线、按 region 分派**）：`GET {openapiBase}/sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`（**body 空串**）。⚠️ 挂在 **`/sash/`** 而非 `/api/`、**不走 wasm 签名**（只需 Bearer jt）—— 只按 `/api/` 搜端点曾误判「Qoder 无签到」。⚠️ **必须带 `Cosy-ClientType: 10`**（2026-09-24 真机定案）：缺头时服务端**恒回空列表**（`campaigns: []` 是缺头的产物、不是服务端事实；官方 47 条响应里空列表出现 **0** 次）。取值是**模块级常量** `QODER_CAMPAIGN_CLIENT_TYPE = 10`，**两区同值**；作用域**只限 `/sash/` 的两个请求**（`qoderCampaignHeaders`），quota / chat / userinfo 仍走不带 Cosy 头的 `qoderJobTokenHeaders` —— 加头对它们的影响未验证，属出站协议值红线。⚠️ 它与 `QoderProduct.clientType`（CN 为 `'5'`，**chat 请求体**字段）是**两回事**：真机取值空间扫描里 `5` 对活动端点回空列表，只有 `8`/`10` 有效（`10` 为官方值）。消融证明其余 `Cosy-*`（MachineToken/Type/Code/Version/OS/Hostname）与 UA 改动**全部非必需**，故一律不发。⚠️ **幂等判据是响应体的 `replayed`，不是状态码**（重复领取同样回 200，但 `replayed:true`、无 `benefit`）⇒ 归一 `already-claimed`。⚠️ 只领 `CLAIM_BENEFIT` **且** `CLAIMABLE`（另有 `VIEW_DETAILS` 型）。⚠️ **三态判读只有一份**（`readQoderCampaignDayState`，claim 与 status 两路共用）：`CLAIM_BENEFIT + CLAIMED` ⇒ **今天已领**（`already-claimed`）、`CLAIMABLE` ⇒ 未签、**带头仍空**或仅 `VIEW_DETAILS` ⇒ `undetermined`（不写签到状态、下轮 sweep 重试）。`CheckinStatus.active` **恒 true**、`todayCheckedIn` 只在服务端明说 `CLAIMED` 时为 true。⚠️ **签到积分落 `addOnQuota`（加量包）而非 `userQuota`**：只看主池会误判「没到账」，插件口径三池合计（`qoderQuotaRemainingTotal`）才对；到账**无结算延迟**（同一次执行内 claim 后立即可见），故 qoder 两区**参与**签到前后余额比对、**不登记** `BALANCE_COMPARISON_EXEMPT_PROVIDERS`。

积分能力取值矩阵（credits-capabilities.js 为唯一真相源）与两区口径见 docs/agents/credits.md。Qoder 专属要点：**国际版 `qoder` 与 CN `qoder-cn` 的 `dailyCheckin` 均为 true、协议共用** —— 国际版端点 `GET {openapiBase}/sash/api/v1/me/campaigns` 已于 **2026-09-23 真机探测 HTTP 200**、响应与 CN 逐字节同构（旧定性「国际版无此活动」不成立），活动以服务端下发为准；qoder-cn 端点已由 keylog 真机验收（2026-09-21）。⚠️ **宿主侧**：`credits.status` / `credits.claimAll` / `checkin.perform` 对两区均已接线、按 region 分派（`src/account-hub-rpc.ts` 经 `qoderRegionFor`）。

**协议事实的探测留档**：`docs/agents/qoder-undetermined-investigation.md`（2026-09-24 真机调查，三根因定案 + 13 个探针脚本清单 + `*-evidence.json` 原始响应）。该文「修复建议清单」中的前三条（补头 / 判 `CLAIMED` / 同步修 `todayCheckedIn`）已全部落地，落地形态见该文末尾「修复落地」小节。

## 上游 76069ce 差异登记

上游提交 **`76069ce`（`fix(qoder):工具调用泄露xml`）** 与既有的 2026-09-21 真机定案**指向同一个问题**，但修复形态不同。本节登记该差异，**结论：语义等价，故不合并**。

### 上游所针对的问题

加密端点 `agent_chat_generation` 认**请求体顶层** `tools`，而上游早期实现把它**硬编码为 `[]`**（客户端源码 `tools: o?.tools ?? []`）。于是模型在 wire 上看不到任何函数 schema，只能用**正文里的 XML 文本臆造工具调用** —— 用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」。上游的修法是新增纯函数 `buildQoderTools()` 真正下发 tools，并把它接进 `QoderEncryptedInfer` / `buildQoderInferPayload()`（`src/qoder-wasm.ts`）。

### 本仓的解法（形态不同，同一根因已修复）

本仓**同样**解决了「模型拿不到 schema」这个根因，且落地早于上游（本仓 `699834f`，2026-09-20 提交 / 注释记的真机取证日为 2026-09-21；上游 `76069ce` 为 2026-09-23），但走的是另一条路：

- `src/qoder-adapter.ts` 的 `buildQoderChatBody` 经 **`serializeQoderTools`** 下发 **OpenAI 标准包裹**的 tools（`{type:'function',function:{name,description,parameters}}`），其 JSDoc 里带**真机对照表**（原样透传 → HTTP 200 流内 `provider_error` + `'function' is a required property, expected an object - 'tools.0'`；包裹后 → `[DONE]=true` 正常收尾；不下发 → 同样正常）；
- 同一请求体构造里 **`serializeQoderMessages` 已序列化 `tool_calls` 与 `tool_call_id`**（assistant 侧 `tool_calls`、`role:'tool'` 侧 `tool_call_id`），孤儿结果按 `resolveToolPairing` 剔除 —— 与上游 `QoderInferMessage` / `QoderInferToolCall` 的语义一致；
- 上游所改的 **`src/qoder-wasm.ts:buildQoderInferPayload` 在本仓不存在**：本仓 wasm 层是**纯提取/加载**（`extractQoderWasm` / `verifyQoderWasm` / 三级降级链 / 缓存），**请求体由适配器构造**（`buildQoderChatBody`，导出的纯函数）。本仓也没有 `QoderEncryptedInfer` 这个类 —— 签名由 `src/qoder-wasm-context.ts` 的 `QoderWasmSigner` 提供，`prepareInferRequest` 只做**整包替换**（URL + headers + 密文 body），不参与 payload 构造。

### 一处形态细节差异（实际等价）

上游 `buildQoderTools` 在 `description` 为空串 / `parameters` 为 `undefined` 时**该键不出现**（逐字对齐客户端 `$Hc(A)`）；本仓 `serializeQoderTools` 的 `description` / `parameters` **恒在**。`ToolSchema` 里这两个字段都是必填（`description: string`、`parameters: Record<string, unknown>`），故**实际出站形态一致**，差异只在「字段缺省」这一不可达分支上。

### 未引入的上游附带产物

上游同批带的两个**一次性验证脚本** `scripts/verify-blockend-override.ts` / `scripts/verify-course-leak-e2e.ts` **未引入本仓**（本仓无 `scripts/` 目录）。⚠️ 核实事实：这两个脚本在上游**任何 ref 里都不存在**（`git log --all --diff-filter=A --name-only` 搜不到），只在 AGENTS.md 正文与代码注释里被引用 —— 即它们本就是**被 gitignore 的本地脚本**，从未入库。

本仓由 `tests/unit` 覆盖同等语义，**合计 118 条运行时用例**：

| 文件 | 运行时用例 | 构成 |
|---|---|---|
| `tests/unit/reasoning-loop-adapter.spec.ts` | **52** | 14 个 `it()` 声明，其中 3 处参数化：五个适配器 × 5 条（25）、同帧 usage × 3 个 provider（3，qoder/trae-cn 走独立帧故单列）、消费侧泄漏 × 5（5）、序列化侧接线 × 3 条 × 5 个 builder（15），加 4 条非参数化 |
| `tests/unit/reasoning-loop-guard.spec.ts` | **27** | 阈值边界锁定 / 粒度无关性 / `resolveSliceChars` / 开关 / fixture |
| `tests/unit/course-leak-strip.spec.ts` | **39** | 行首必删 / 正常用法不动 / 幂等 / 历史侧 / 开关 / fixture |

其中「`block-end` 是权威覆盖」由「截断后是真前缀且严格短于已收增量之和」的断言钉死（只比长度不够 —— 未截断时块文本也只是**短了**），不需要端到端脚本。变异测试确有使用（`trae-cn-adapter.spec.ts` 有一条注释记录了变异验证），但**本仓没有 Stryker 一类变异测试配置**，故不宣称「变异测试覆盖」。