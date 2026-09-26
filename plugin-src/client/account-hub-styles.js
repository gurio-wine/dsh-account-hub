/**
 * Account Hub 设置页面样式。
 *
 * ## 两条硬约束（本次迁移的目标）
 *
 * 1. **交互控件一律来自 `@deepseek-ai/dsh-client-ui-primitives`**，本文件不再为
 *    任何控件提供外观 —— 按钮 / 开关 / 单选 / 下拉 / 弹窗 / 悬停提示 / 徽标 /
 *    状态点的样式都在那个包里，且其类名是构建期 hash 过的（拿不到、也不该拿）。
 *    本文件里剩下的每一条规则都只服务**布局**（DSH 没有对应原语的那些结构：
 *    侧栏、卡片、拖拽插入线、等分双列、网格）。
 * 2. **颜色 / 字体一律走 DSH design token**，不再有十六进制字面量。token 名单
 *    取自宿主 `packages/client/ui-theme/src/styles/design-platform.css`（亮色
 *    `body` 与暗色 `body[data-ds-dark-theme]` 两套定义）与 `base.css`。
 *
 * ## 两处曾经是死 token（已修）
 *
 * - `--dsw-alias-border-default` **不存在** → `--dsw-alias-border-l2`；
 * - `--dsw-font-mono` **不存在** → `--ds-font-family-code`。
 *
 * 死 token 的写法是 `var(--死名, #fff)`：浏览器取 fallback，看起来「没问题」，
 * 但**主题切换时它永远不跟着变** —— 暗色主题下留一块白底就是这么来的。
 * 本次把所有 `var(..., #xxx)` 形式的 fallback 一并去掉：token 不存在就该
 * 露出空值（可被立刻发现），而不是悄悄退回一个写死的颜色。
 *
 * ## 两类颜色豁免
 *
 * - 七条 `.dim-ah-providerIcon.*` 的白底与 Qoder CN 的内描边**保持原样**，理由：
 *   那是**品牌识别**（每个 provider 的图标要在白底上显示清晰），不属于主题体系，
 *   也不该随亮/暗主题变化。
 * - `.dim-ah-iconBtn-light` 使用白底黑字，是清单明确要求的未签到与登录图标外观。
 *
 * 其余颜色 / 字体一律走 DSH design token，不使用十六进制字面量。
 *
 * ⚠️ 本文件整体是一个 JS 模板字符串：注释里绝不能出现反引号（会提前闭合模板）。
 */

const STYLES = `
/* 页面撑满宿主 settings.section 的 .options：height（不是 min-height）给出
   确定高度，右栏才有可滚动的边界。 */
.dim-ah-page { display: flex; flex-direction: column; height: 100%; color: var(--dsw-alias-label-primary); }
.dim-ah-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dim-ah-brand { display: flex; flex-direction: column; }
.dim-ah-brandName { font-size: var(--dsw-font-base-strong-16-font-size); line-height: var(--dsw-font-base-strong-16-line-height); font-weight: var(--dsw-font-base-strong-16-font-weight); color: var(--dsw-alias-label-primary); }
.dim-ah-brandDesc { font-size: var(--dsw-font-xs-13-font-size); line-height: var(--dsw-font-xs-13-line-height); color: var(--dsw-alias-label-secondary); margin: 2px 0 0; }

/* 布局：对齐 dsh-im 的两栏。
   ⚠️ overflow:hidden 不是装饰，它是**左栏等宽的前提**：本行让面板成为
   BFC / 滚动容器，.dim-ah-panel 的 min-width:auto 才会解析为 0 而不是
   min-content。去掉它时面板内容（账号卡片那一长串）会把 width:200px 且
   flex-shrink 默认 1 的左栏挤窄 —— 实测 rail 实宽 217→200、按钮 200→183，
   而面板内容随 provider 不同，表现就是「切换供应商时所有按钮宽度都变」。 */
.dim-ah-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail
   flex:none 与上面那条 overflow:hidden 是同一件事的两道保险：左栏宽度
   恒为 200px，不随右栏内容收缩（光有 width 挡不住 flex-shrink）。 */
.dim-ah-rail { flex: none; width: 200px; border-right: 1px solid var(--dsw-alias-border-l2); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel
   box-sizing 与栅格都是**等宽的组成部分**：左栏 200px 固定后，按钮宽度还要
   不随「选中态 / 文本长度」变化。栅格首列恒 30px，第二列 minmax(0,1fr) 吃掉
   剩余宽度，文字在第二列里收敛（min-width: 0 + strong 的省略号）——
   长名（LobsterAI）不再把按钮撑宽。
   ⚠️ 这是**导航项**不是普通按钮，故不用 ui-primitives 的 Button（那个的胶囊
   几何与内边距是给操作按钮定的），而是自建结构 + token 配色。 */
.dim-ah-provider { box-sizing: border-box; width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv1); font: inherit; text-align: left; cursor: pointer; transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out), background var(--ds-transition-duration-fast) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-provider:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); box-shadow: var(--dsw-shadow-lv2); }
.dim-ah-provider[aria-selected="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover-accent); box-shadow: var(--dsw-shadow-lv2); }
.dim-ah-provider:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l4), var(--dsw-shadow-lv2); }

/* 图标容器：align dsh-im .dim-logo */
.dim-ah-providerIcon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: var(--dsw-shadow-lv1); overflow: hidden; }
.dim-ah-providerIcon img { display: block; width: 20px; height: 20px; border-radius: 2px; }
/* ── 品牌色豁免：以下七条的字面色值**刻意不换 token** ──
   白底是图标本身的可读性要求（多张官方图标是深色/彩色不透明位图），
   属于品牌识别而非主题语义，不该随亮暗主题变化。 */
.dim-ah-providerIcon.codearts { background: white; }
.dim-ah-providerIcon.buddy-cn { background: white; }
.dim-ah-providerIcon.buddy { background: white; }
.dim-ah-providerIcon.lobsterai { background: white; }
/* Trae CN 的品牌标识自带深色圆角底（#1A1B1D），自带底色的图标不该再靠容器配色，
   故与其余图标一致保持 white：容器只负责留白与投影，深色方块居中显示。 */
.dim-ah-providerIcon.trae-cn { background: white; }
/* Qoder 的官方图标是 412x412 的彩色 PNG（自带不透明底色），与 buddy 系那几条
   base64 PNG 同类，故容器配色一致。类名同样必须存在：见上面那条集合相等断言。 */
.dim-ah-providerIcon.qoder { background: white; }
/* Qoder CN 与 Qoder **共用同一个图标本体**（同一品牌的两个 region，官方
   qoder.cn 的 rel="icon" 指向的就是同一张 alicdn PNG）。容器配色与 .qoder
   一致，只多一道极淡的品牌色内描边作为**两区区分**：两个面板的图标完全一样时
   会让人以为点错了标签页。类名必须单独存在（logoClass 与条目的集合相等断言
   守着），缺了它只是少了白底与描边，肉眼几乎看不出来。 */
.dim-ah-providerIcon.qoder-cn { background: white; box-shadow: var(--dsw-shadow-lv1), inset 0 0 0 1px var(--dsw-alias-border-l4); }

/* 供应商折叠组的**组内**容器（组标题本身是 ui-primitives 的 DisclosureRow，
   它的箭头 / 行高 / 文字色都在那个包里，本文件一条都不重复声明 —— 这里只做
   两件布局的事：把七个导航项缩进到组标题之下，以及维持原有的 8px 行距
   （rail 自己的 gap 只作用于「组标题 / 组容器」这两个直接子项之间）。
   下方留给「自动路由」入口的位置见 account-hub.js 里的占位注释。 */
.dim-ah-providerGroup { display: grid; align-content: start; gap: 8px; padding-left: 6px; }

/* 右侧面板：自身滚动，但**不显示滚动条**。
   滚动条只是被隐藏，滚动能力原样保留（滚轮 / 键盘 / 触控板照常）。
   两条路径都要写，且不是重复：scrollbar-width 是 Firefox 的口径，
   ::-webkit-scrollbar 是 Chromium / Electron（DSH 桌面端）的口径。
   ⚠️ 反过来也成立：Chromium 里一旦声明 scrollbar-width: none，本元素上的
   ::-webkit-scrollbar* 规则会被整体丢弃 —— 这里不要紧（我们要的就是隐藏），
   但**别**在这条规则上再加 hover 之类的伪元素定制。 */
.dim-ah-panel { flex: 1; padding: 24px; overflow-y: auto; scrollbar-width: none; }
.dim-ah-panel::-webkit-scrollbar { display: none; }
.dim-ah-empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px; color: var(--dsw-alias-label-tertiary); }
.dim-ah-empty p { margin: 8px 0; font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); }

/* 账号卡片
   position: relative 是拖拽插入线的定位基准（见下方 data-dropBefore/After 的
   ::before / ::after），opacity 进 transition 让「拿起」的淡出有过渡。 */
.dim-ah-accountCard { position: relative; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv1); transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out), opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-accountCard:hover { border-color: var(--dsw-alias-border-l3); box-shadow: var(--dsw-shadow-lv2); }
.dim-ah-accountCard[data-enabled="false"] { opacity: 0.62; }

/* 拖拽排序 */
/* 抓取柄：独立的小区域，避免与卡片内的按钮/文本选择冲突 */
.dim-ah-dragHandle { flex: none; width: 16px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: grab; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12-font-size); line-height: 1; letter-spacing: -1px; user-select: none; border-radius: 4px; }
.dim-ah-dragHandle:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.dim-ah-dragHandle:active { cursor: grabbing; }
/* 正在被拖动的卡片：淡出以表明它已被「拿起」 */
.dim-ah-accountCard[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
/* 拖拽悬停的落点：插入线。上方=插到该卡片之前，下方=之后 —— 必须与
   dropPositionFromPointer 的判定同向，否则用户按线拖放却落在相反位置。 */
.dim-ah-accountCard[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dim-ah-accountCard[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
/* 序号徽标：让当前优先级一目了然（顺序即选号优先级） */
.dim-ah-accountOrder { flex: none; min-width: 18px; padding: 0 5px; border-radius: 6px; font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); font-weight: var(--dsw-font-xxxs-strong-11-font-weight); text-align: center; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-ah-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-ah-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); font-weight: var(--dsw-font-s-strong-14-font-weight); color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }

/* 元信息：键值对齐的网格 */
.dim-ah-accountMeta { display: grid; gap: 3px; margin: 8px 0 0; }
.dim-ah-metaRow { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-ah-metaRow dt { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-tertiary); }
.dim-ah-metaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
.dim-ah-metaRow dd[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
/* 积分未取到时的弱化提示。与 warn 区分：这不是异常，只是还没有数据 */
.dim-ah-metaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
.dim-ah-metaRow code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: var(--dsw-font-xxxs-11-font-size); }

/* 账号卡片上的积分余额。
   覆盖 metaRow 的 overflow:hidden / nowrap —— 这里要的是横向排列的
   数值 + 次要说明，而 dd 默认样式是为单行截断文本准备的。 */
.dim-ah-metaRow dd.dim-ah-creditValue { display: flex; flex-direction: row; align-items: baseline; gap: 6px; overflow: visible; }
.dim-ah-creditTotal { font-size: var(--dsw-font-xs-13-font-size); font-weight: var(--dsw-font-xs-strong-13-font-weight); color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.dim-ah-creditPackages { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary); }
/* 已失效额度：弱化的警示色提示，与主数值的强调色明确区分 */
.dim-ah-creditExpired { font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-state-warn-primary); }

/* 限额重置徽章行 */
.dim-ah-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-ah-rateLimitsLabel { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-tertiary); }

/* 操作按钮：横向一行，右对齐。按钮外观归 ui-primitives 的 Button，
   这里只负责排布。 */
.dim-ah-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); }

/* 「删除」是破坏性操作：Button 没有 danger 变体（给它造一个私有变体就等于
   在插件里重开一套配色），故用 token 把**语义色**加到 outline 按钮上 ——
   颜色本身仍来自设计体系。 */
.dim-ah-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dim-ah-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }

/* 限额重置徽章：Tag 负责胶囊与配色，这里只调字号行高与强调字重。 */
.dim-ah-ttlBadge { font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); }

/* 图标按钮统一为 28px 方形，**高度对齐宿主 size="sm" 文本按钮**（28px）：
   标题行里图标按钮与文字按钮同排，若两者高度不同就会一行两种基线。宽度取同值
   以保持正方形。按钮本体仍由 ui-primitives 提供。 */
.dim-ah-iconBtn { box-sizing: border-box; flex: none; width: 28px; min-width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
/* 未签到与登录入口采用白底黑字的 outline 外观。 */
.dim-ah-iconBtn-light { background: white; color: black; }
.dim-ah-iconGlyph { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
.dim-ah-iconGlyph[data-loading="true"] { animation: dim-ah-icon-spin 1s linear infinite; }
@keyframes dim-ah-icon-spin { to { transform: rotate(360deg); } }
/* 状态文案变化时固定文本操作按钮的最小宽度。 */
.dim-ah-btn-stable { min-width: 112px; }

/* 标题行放置全部图标操作（模型列表 / 刷新积分 / 一键签到 / 登录账号）。
   面板上已无任何文字操作按钮，故标题行之下不再有操作区。 */
.dim-ah-panelHead { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 16px; }
.dim-ah-panelTitleRow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; width: 100%; }
.dim-ah-panelTitle { margin: 0; font-size: var(--dsw-font-m-18-font-size); line-height: var(--dsw-font-m-18-line-height); font-weight: var(--dsw-font-m-18-font-weight); color: var(--dsw-alias-label-primary); }
.dim-ah-panelTitleActions { display: flex; flex: none; align-items: center; gap: 8px; }

/* 面板级通知行：登录失败、顺序保存失败、领取结果共用同一种外观。 */
.dim-ah-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-secondary); }
.dim-ah-probeNotice[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); color: var(--dsw-alias-state-success-primary); }
.dim-ah-probeNotice[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dim-ah-probeNotice[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); }
.dim-ah-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-ah-probeDetails li { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); }

/* 页面级更新提示行（检查更新 / 一键更新）：提示行本体沿用 .dim-ah-probeNotice，
   这一层只补它与 .dim-ah-header 对齐的内边距 —— 它挂在 header 与两栏布局之间，
   横跨整页（更新的是插件自身，不属于任何 provider）。 */
.dim-ah-updateBar { padding: 12px 24px 0; }
/* 更新日志：等宽 + 限高滚动。服务端给的是 pnpm 安装输出汇总，可能上百行，
   不设上限会把下面的两栏布局顶出视口（与 .dim-ah-modal 的 max-height 同一考虑）。 */
.dim-ah-updateLog { max-height: 180px; margin: 6px 0 0; padding: 8px 10px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); white-space: pre-wrap; word-break: break-all; }

/* 弹窗被拦截时的手动登录链接。
   这里**不是**装饰性链接，而是唯一的登录入口，因此必须一眼可见、可点、
   并且在窄面板里也能换行（登录 URL 很长）。 */
.dim-ah-manualLogin { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-state-warn-primary); }
.dim-ah-manualLogin a { color: var(--dsw-alias-link); font-weight: var(--dsw-font-xxs-strong-12-font-weight); word-break: break-all; text-decoration: underline; }
.dim-ah-manualLogin p { margin: 0 0 6px; }

/* ── 模型列表弹窗（「模型列表」） ──
   壳（遮罩 / 居中卡片 / 圆角 / 阴影 / 关闭按钮 / Escape）全部归 ui-primitives
   的 Modal，这里只剩内容排布：头部行、说明行、可滚动的列表区。

   ⚠️ **这一条不是布局装饰，是弹窗的可用性上限**：宿主 Modal 的 dialog 默认
   width 是 min(380px, 100%) 且**没有 max-height**。模型列表动辄上百条，靠内容撑高
   会让弹窗高于视口、底部的「刷新 / 完成」被顶出屏幕（连滚动都到不了）。
   className 由 Modal 挂在 dialog 节点上（与宿主 .dialog 同一个元素，见
   Modal.tsx 的 clsx(css.dialog, className)），故这两条直接覆盖宿主的 380px 默认。
   注入顺序是**运行期**（installAccountHubStyles 往 head 末尾 append），晚于宿主
   构建期的样式表，同特异性下后者胜出 —— 这正是这条能生效的前提。
   max-height 取 min(640px, calc(100vh - 48px))：小视口按视口留 24px 边距，
   大视口封顶 640px，超出的部分由 .dim-ah-modalBody 自己滚。 */
.dim-ah-modal { width: min(560px, 100%); max-height: min(640px, calc(100vh - 48px)); }
.dim-ah-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-ah-modalTitle { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); font-weight: var(--dsw-font-s-strong-14-font-weight); color: var(--dsw-alias-label-primary); }
.dim-ah-modalSubtitle { overflow: hidden; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); font-weight: var(--dsw-font-xxs-12-font-weight); color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧按钮组与标题里的计数徽标 */
.dim-ah-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-ah-modelPanelCount { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); font-weight: var(--dsw-font-xxs-12-font-weight); color: var(--dsw-alias-label-tertiary); }
.dim-ah-modalHint { flex: none; margin: 10px 0 0; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-tertiary); }
.dim-ah-modal .dim-ah-probeNotice { flex: none; margin: 10px 0 0; }
/* 列表区独立滚动：头部与说明固定，模型多时只滚中间。
   这条 class 同时作为 Modal 的 contentClassName 传下去（见 ModelListPanel）。 */
.dim-ah-modalBody { flex: 1 1 auto; min-height: 0; margin-top: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.dim-ah-modalBody .dim-ah-empty { padding: 24px; }

/* 每行一个模型：左侧名称 + id，右侧开关（多档 provider 再多一列窗口档位） */
.dim-ah-modelList { display: grid; gap: 2px; }
.dim-ah-modelRow { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-radius: 8px; transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-modelRow:hover { background: var(--dsw-alias-bg-layer-2); }
/* 行根节点是 div，左侧「名字 + 开关」自成一组、档位胶囊在右侧独立成组：
   档位控件绝不能落进包住开关的 label 里（隐式关联会让一次点击改两件事）。 */
.dim-ah-modelMain { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; }
/* 已关闭的模型整体降透明度：一眼能看出哪些被隐藏了 */
.dim-ah-modelRow[data-disabled="true"] .dim-ah-modelInfo { opacity: 0.5; }
.dim-ah-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.dim-ah-modelName { min-width: 0; overflow: hidden; font-size: var(--dsw-font-xs-13-font-size); line-height: var(--dsw-font-xs-13-line-height); font-weight: var(--dsw-font-xs-strong-13-font-weight); color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }
.dim-ah-modelId { flex: none; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: var(--dsw-font-xxxs-11-font-size); color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }

/* 上下文窗口档位：每档一个可选中胶囊（Pill），档数由数据决定
   （Trae CN 两档、Buddy 两档、Qoder 三档），故允许换行 —— 挤在一行会把模型名
   压成省略号，而档位本身是低频操作。胶囊外观归 Pill，这里只负责排布。 */
.dim-ah-modelTier { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dim-ah-tierOption { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); white-space: nowrap; }

/* 消耗顺序 / 切换粒度：两个下拉**各占容器一半**，两者宽度之和恒等于这一排的宽度。
   分组用 flex: 1 1 0 平分（basis 取 0 才是严格等宽：若留 auto，较长的那份文案
   会把两份拉成不同宽度）；min-width: 0 让窄面板下继续压缩而不是撑破右栏。 */
.dim-ah-consumption { display: flex; gap: 8px; margin-bottom: 12px; }
/* 分组本身是 grid 容器：唯一的子节点（Menu 的 .root 是 inline-flex）会被拉伸到
   整列宽，故锚点宽度 = 分组宽度，不需要给 .root 再加类名。 */
.dim-ah-consumptionGroup { flex: 1 1 0; min-width: 0; display: grid; }
/* 锚点填满分组；文字与 chevron 分列两端。宽度由分组决定，不跟随选中项文案变化。 */
.dim-ah-consumptionSelect { box-sizing: border-box; width: 100%; min-width: 0; justify-content: space-between; white-space: nowrap; }
/* 展开的选项列表与锚点同宽（「弹层宽度 = 按钮宽度」）：Menu 的列表是 .root 内的
   绝对定位子节点，而 .root 已被拉到分组宽度，故 100% 即按钮宽度。
   面板没有用 portal（portal 会把列表挂到 body 上、失去这个包含块），
   这一条必须在场，否则列表退回宿主 .list 的 min-width: 144px 内容宽。
   宿主 .list 的 min-width 同为单类选择器，靠注入顺序（运行期 append 到 head
   末尾）在同特异性下胜出 —— 与 .dim-ah-modal 覆盖宿主 dialog 宽度同一机制。 */
.dim-ah-consumptionMenu { width: 100%; min-width: 0; }

/* 悬停提示的宿主锚点：包住非 forwardRef 的组件，使 Tooltip 能拿到真实 DOM 节点。
   inline-flex 不改变父级 flex/grid 的参与关系，也不给行内元素引入额外行高。 */
.dim-ah-tipWrap { display: inline-flex; align-items: center; min-width: 0; }

/* ── 自动路由面板（左侧「自动路由」tab 的右侧内容） ──
   与 provider 面板**同处 .dim-ah-panel 容器**，故这里只需要面板内部的行排布：
   头部、总开关行、卡片列表、卡片内的候选行、保存行。 */

/* 面板头部：标题 + 「未保存」标记同一行。 */
.dim-ah-arHead { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dim-ah-arTitle { margin: 0; font-size: var(--dsw-font-m-18-font-size); line-height: var(--dsw-font-m-18-line-height); font-weight: var(--dsw-font-m-18-font-weight); color: var(--dsw-alias-label-primary); }
.dim-ah-arDirtyTag { font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); }

/* 总开关行：Switch 外观归 ui-primitives，这里只把开关与标签排成一行。
   开关**不**包在 label 里（点标签也会翻开关），故标签是独立的 span：
   Switch 的可读名由它自己的 aria-label 提供，不依赖这个可见标签。 */
.dim-ah-arSwitchRow { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dim-ah-arSwitchLabel { font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); color: var(--dsw-alias-label-primary); }

/* 面板内的错误行（读取失败 / 保存被服务端拒绝）。
   红色走 token：错误不是品牌识别，故不使用任何品牌色豁免。 */
.dim-ah-arError { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-state-error-primary); }

/* 空态与加载态：与 .dim-ah-empty 同款排布，但**不是**同一块版面
   （那个 class 服务于账号区，自动路由有自己的引导文案）。 */
.dim-ah-arEmpty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px; color: var(--dsw-alias-label-tertiary); }
.dim-ah-arEmpty p { margin: 6px 0; font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); }

/* 定义卡片列表。position: relative 是拖拽插入线的定位基准。 */
.dim-ah-arList { display: grid; gap: 12px; }
.dim-ah-arCard { position: relative; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; padding: 12px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv1); transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out), box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out), opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-arCard:hover { border-color: var(--dsw-alias-border-l3); box-shadow: var(--dsw-shadow-lv2); }
/* 正在被拖动的卡片：淡出以表明它已被「拿起」（与账号卡片同款反馈）。 */
.dim-ah-arCard[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
/* 插入线：上方 = 插到该卡片之前，下方 = 之后 —— 必须与 dropPositionFromPointer
   的判定同向，否则用户按线拖放却落在相反位置。 */
.dim-ah-arCard[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dim-ah-arCard[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }

/* 卡片头：拖拽柄 + 序号 + 名称输入 + 条目数 + 删除；输入框优先压缩。 */
.dim-ah-arCardHead { display: grid; grid-template-columns: 16px max-content minmax(0, 1fr) max-content 112px; align-items: center; gap: 8px; }
.dim-ah-arCardHead[data-drag-enabled="false"] { grid-template-columns: max-content minmax(0, 1fr) max-content 112px; }
/* 序号徽标：与账号卡片的 .dim-ah-accountOrder 同义（顺序即降级顺序），
   但这里显示的是**定义**序号，故另起一个类名而不是复用。 */
.dim-ah-arOrder { min-width: 18px; padding: 0 5px; border-radius: 6px; font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); font-weight: var(--dsw-font-xxxs-strong-11-font-weight); text-align: center; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
/* 名称输入优先占用剩余空间；条目数与删除按钮维持自身宽度。 */
.dim-ah-arNameInput { width: 100%; min-width: 0; }
.dim-ah-arEntryCount { white-space: nowrap; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-tertiary); }

/* 候选列表（卡片内），间距按 12/8/4 节奏收敛。 */
.dim-ah-arEntries { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
/* 一条候选：拖拽柄 + 三个等宽下拉 + 固定宽度删除列。 */
.dim-ah-arEntryRow { position: relative; display: grid; grid-template-columns: 16px repeat(3, minmax(0, 1fr)) 112px; align-items: center; gap: 8px; padding: 4px; border-radius: 8px; transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out), opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-arEntryRow[data-drag-enabled="false"] { grid-template-columns: repeat(3, minmax(0, 1fr)) 112px; }
.dim-ah-arEntryRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dim-ah-arEntryRow[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
.dim-ah-arEntryRow[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -4px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dim-ah-arEntryRow[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -4px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
/* 每格填满固定 grid 列，选项文字变化不会改变列宽。 */
.dim-ah-arEntryMenu { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; justify-content: space-between; overflow: hidden; white-space: nowrap; }

/* 「添加模型」入口所在行。 */
.dim-ah-arAddEntry { display: flex; align-items: center; gap: 8px; }

/* 面板底部的保存行：添加与保存固定同行，保存右对齐。 */
.dim-ah-arSaveRow { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dim-ah-arSaveRow > :last-child { margin-left: auto; }

/* 「自动路由」导航项的图标容器：与 .dim-ah-providerIcon 同形（尺寸 / 圆角 /
   投影都来自那一条），这里只换**背景色**。
   ⚠️ 它不是品牌标识 —— 品牌色豁免只覆盖七个第三方产品的官方图标，自动路由是本
   插件自己的功能入口，故配色必须走 token（与 providerIcon 的 white 字面量不同）。
   --dsw-alias-state-business-primary 的语义是「业务 / 功能分类」，正是这里要表达的
   「这是本插件自己的功能，不是某个第三方 provider」；图标本身用 currentColor，
   故同一条规则里把前景色一起设成反色。 */
.dim-ah-providerIcon.ar { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverted); }
`

let injected = false
export function installAccountHubStyles() {
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
