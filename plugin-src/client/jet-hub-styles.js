/**
 * Account Hub 设置页面样式 —— 对齐 dsh-im 设计。
 */

const STYLES = `
.dim-jh-page { display: flex; flex-direction: column; height: 100%; }
.dim-jh-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-jh-brand { display: flex; flex-direction: column; }
.dim-jh-brandName { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-jh-brandDesc { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 2px 0 0; }

/* 布局：对齐 dsh-im 的两栏 */
.dim-jh-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail */
.dim-jh-rail { width: 200px; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel */
.dim-jh-provider { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dim-jh-provider:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); background: color-mix(in srgb, #1677ff 2%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-provider[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 12%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dim-jh-provider:focus-visible { outline: none; border-color: color-mix(in srgb, #1677ff 72%, var(--dsw-alias-border-l2, #dfe1e5)); box-shadow: 0 0 0 1px color-mix(in srgb, #1677ff 24%, transparent) inset, 0 3px 12px rgb(51 112 255 / 7%); }

/* 图标容器：align dsh-im .dim-logo */
.dim-jh-providerIcon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); overflow: hidden; }
.dim-jh-providerIcon img { display: block; width: 20px; height: 20px; border-radius: 2px; }
.dim-jh-providerIcon.codearts { background: white; }
.dim-jh-providerIcon.buddy-cn { background: white; }
.dim-jh-providerIcon.buddy { background: white; }
.dim-jh-providerIcon.lobsterai { background: white; }
/* Trae CN 的品牌标识自带深色圆角底（#1A1B1D），自带底色的图标不该再靠容器配色，
   故与其余图标一致保持 white：容器只负责留白与投影，深色方块居中显示。 */
.dim-jh-providerIcon.trae-cn { background: white; }
/* Trae CN Work 与 Trae CN 用**同一个**图标本体（同一产品的两条路径），容器配色
   自然也一致 —— 但类名必须单独存在：logoClass 与条目逐字对齐由
   tests/unit/credits-capabilities.spec.ts 的集合相等断言守住，缺了它面板图标
   就只是少了白底，肉眼几乎看不出来。
   ⚠️ 本文件整体是一段模板字面量，注释里**不能出现反引号**（会提前结束字符串，
   esbuild 直接在构建期报 "Expected ; but found …"）。 */
.dim-jh-providerIcon.trae-cn-work { background: white; }
/* Qoder 的官方图标是 412x412 的彩色 PNG（自带不透明底色），与 buddy 系那几条
   base64 PNG 同类，故容器配色一致。类名同样必须存在：见上面那条集合相等断言。 */
.dim-jh-providerIcon.qoder { background: white; }
/* Qoder CN 与 Qoder **共用同一个图标本体**（同一品牌的两个 region，官方
   qoder.cn 的 rel="icon" 指向的就是同一张 alicdn PNG）—— 与 trae-cn-work
   别名 trae-cn 同一处理。容器配色与 .qoder 一致，只多一道极淡的品牌色内描边
   作为**两区区分**：两个面板的图标完全一样时会让人以为点错了标签页。
   类名必须单独存在（logoClass 与条目的集合相等断言守着），缺了它只是少了
   白底与描边，肉眼几乎看不出来。 */
.dim-jh-providerIcon.qoder-cn { background: white; box-shadow: 0 1px 3px rgb(31 35 41 / 7%), 0 0 0 1px color-mix(in srgb, #1677ff 26%, transparent) inset; }

/* provider 文案：align dsh-im .dim-channelCopy */
.dim-jh-providerLabel { min-width: 0; display: grid; }
.dim-jh-providerLabel strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }

/* 右侧面板 */
.dim-jh-panel { flex: 1; padding: 24px; overflow-y: auto; }
.dim-jh-empty { text-align: center; padding: 40px; color: var(--dsw-alias-label-tertiary, #888); }
.dim-jh-empty p { margin: 8px 0; font-size: 14px; }

/* 账号卡片 */
.dim-jh-accountCard { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease; }
.dim-jh-accountCard:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-accountCard[data-enabled="false"] { opacity: 0.62; }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-jh-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-jh-accountStatus { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dim-jh-accountStatus[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dim-jh-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dim-jh-accountTag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dim-jh-accountTag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }

/* 元信息：键值对齐的网格 */
.dim-jh-accountMeta { display: grid; gap: 3px; margin: 8px 0 0; }
.dim-jh-metaRow { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-jh-metaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-metaRow dd[data-tone="warn"] { color: #e37400; }
/* 积分未取到时的弱化提示。与 warn 区分：这不是异常，只是还没有数据 */
.dim-jh-metaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

/* 账号卡片上的积分余额。
   覆盖 metaRow 的 overflow:hidden / nowrap —— 这里要的是横向排列的
   数值 + 次要说明，而 dd 默认样式是为单行截断文本准备的。 */
.dim-jh-metaRow dd.dim-jh-creditValue { display: flex; flex-direction: row; align-items: baseline; gap: 6px; overflow: visible; }
.dim-jh-creditTotal { font-size: 13px; font-weight: 600; color: #1677ff; font-variant-numeric: tabular-nums; }
/* 曾经有一个 .dim-jh-creditWork（Work 池的弱化色数字），随「通用 X / Work Y」
   两段式渲染一起删除：分池后每个面板只显示自己那一个池，同一处不会再出现
   两个池的数字，也就没有「哪个数字该弱化」的问题。 */
.dim-jh-creditPackages { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 已失效额度：弱化的橙色提示，与主数值的蓝色明确区分 */
.dim-jh-creditExpired { font-size: 11px; color: #b45309; }

/* 限额重置徽章行 */
.dim-jh-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-jh-rateLimitsLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 操作按钮：横向一行，右对齐 */
.dim-jh-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

/* 按钮：align dsh-im .dim-deliveryButton */
.dim-jh-btn { font-size: 12px; line-height: 18px; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; transition: border-color .15s ease, background .15s ease, color .15s ease; }
.dim-jh-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-jh-btn[data-kind="primary"] { background: #1677ff; color: #fff; border-color: #1677ff; }
.dim-jh-btn[data-kind="primary"]:hover:not(:disabled) { background: #0f5fce; border-color: #0f5fce; color: #fff; }
.dim-jh-btn[data-kind="danger"] { color: #d93025; border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-jh-btn[data-kind="danger"]:hover:not(:disabled) { color: #b3261e; border-color: #d93025; background: rgb(217 48 37 / 6%); }
.dim-jh-btn:disabled { opacity: 0.5; cursor: default; }

/* 限流 TTL 徽章 */
.dim-jh-ttlBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgb(227 116 0 / 10%); color: #b45309; font-size: 11px; line-height: 17px; font-weight: 500; }

/* 面板标题区：标题独占一行，操作按钮另起一行。
   此前用单行 space-between 把标题与 5 个按钮挤在一起，面板一窄就溢出被裁掉。 */
.dim-jh-panelHead { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 16px; }
.dim-jh-panelTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }

/* 面板标题下方的操作按钮组（显示列表 / 刷新积分 / 一键领取积分 / 重测所有 / 重置所有 / 新建账号）。
   允许换行：按钮数量随 provider 变化（Buddy CN 有「一键领取积分」，其他没有），
   固定单行在窄面板下必然放不下。 */
.dim-jh-headerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }

/* 共用账号的 provider（Trae CN Work）没有「+ 新建账号」，改为这行常驻说明。
   用中性信息色而不是警示色：这不是错误状态，只是「登录入口在隔壁面板」。 */
.dim-jh-loginHint { margin: 0 0 12px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }

/* 上一次「重测 / 重置」的结果提示 */
.dim-jh-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-jh-probeNotice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dim-jh-probeNotice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dim-jh-probeNotice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }
.dim-jh-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-jh-probeDetails li { font-size: 12px; line-height: 18px; }

/* 弹窗被拦截时的手动登录链接。
   这里**不是**装饰性链接，而是唯一的登录入口，因此必须一眼可见、可点、
   并且在窄面板里也能换行（登录 URL 很长）。 */
.dim-jh-manualLogin { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); font-size: 12px; line-height: 18px; color: #b45309; }
.dim-jh-manualLogin a { color: #1677ff; font-weight: 600; word-break: break-all; text-decoration: underline; }
.dim-jh-manualLogin p { margin: 0 0 6px; }

/* 登录弹窗 */
.dim-jh-loginOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dim-jh-loginDialog { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
.dim-jh-loginDialog h3 { margin: 0 0 8px; font-size: 16px; }
.dim-jh-loginDialog p { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 0 0 16px; }
.dim-jh-loginActions { display: flex; gap: 8px; justify-content: flex-end; }

/* ── 模型列表弹窗（「显示列表」） ── */
/* 复用登录弹窗的遮罩模式：fixed 覆盖全屏，z-index 高于设置页内容。
   3000 高于 .dim-jh-loginOverlay 的 1000，保证两个弹窗同时存在时模型列表在上。 */
.dim-jh-modalOverlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.32); }
.dim-jh-modal { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(640px, calc(100vh - 48px)); padding: 20px 22px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
.dim-jh-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-jh-modalTitle { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-modalSubtitle { overflow: hidden; font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧按钮组与标题里的计数徽标 */
.dim-jh-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-jh-modelPanelCount { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-modalHint { flex: none; margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-modal .dim-jh-probeNotice { flex: none; margin: 10px 0 0; }
/* 列表区独立滚动：头部与说明固定，模型多时只滚中间 */
.dim-jh-modalBody { flex: 1 1 auto; min-height: 0; margin-top: 10px; overflow-y: auto; }
.dim-jh-modalBody .dim-jh-empty { padding: 24px; }

/* 每行一个模型：左侧名称 + id，右侧开关（Trae CN 再多一列窗口档位） */
.dim-jh-modelList { display: grid; gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-radius: 8px; transition: background .15s ease; }
.dim-jh-modelRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
/* ⚠️ 行根节点是 div，label 只包住「名称 + 开关」那一半：档位 radio 必须
   在 label 之外，否则点档位会连带激活 label 的隐式控件（那个显示开关）。
   ⚠️ 本文件整体是一个 JS 模板字符串：注释里绝不能出现反引号（会提前闭合模板）。 */
.dim-jh-modelMain { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; cursor: pointer; }
/* 已关闭的模型整体降透明度：一眼能看出哪些被隐藏了 */
.dim-jh-modelRow[data-disabled="true"] .dim-jh-modelInfo { opacity: 0.5; }
.dim-jh-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.dim-jh-modelName { min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-modelId { flex: none; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }

/* 开关：基于 checkbox 绘制，保持原生语义（可聚焦、可键盘操作、可读屏） */
.dim-jh-switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); cursor: pointer; transition: background .18s ease; }
.dim-jh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(31 35 41 / 20%); transition: transform .18s ease; }
.dim-jh-switch:checked { background: #1677ff; }
.dim-jh-switch:checked::after { transform: translateX(14px); }
.dim-jh-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
.dim-jh-switch:disabled { opacity: 0.5; cursor: default; }

/* 上下文窗口档位（Trae CN）：两个原生 radio + 文案，标签即点击热区 */
.dim-jh-modelTier { flex: none; display: flex; align-items: center; gap: 10px; }
.dim-jh-tierOption { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #4e5969); white-space: nowrap; cursor: pointer; }
.dim-jh-tierOption input { margin: 0; accent-color: #1677ff; cursor: pointer; }
.dim-jh-tierOption input:disabled { cursor: default; }
.dim-jh-tierOption input:disabled + span { opacity: 0.5; }
`

let injected = false
export function installJetHubStyles() {
  if (injected) return () => {}
  injected = true
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => {
    style.remove()
    injected = false
  }
}
