window.__ModuleLoader__.load({
  id: "dsh-account-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-src/client/index.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);

// plugin-src/management-rpc.mjs
function callManagementRpc(connection, channel, method, payload, signal) {
  return connection.rpc.call("/api", channel.replace(/^\//, ""), { method, payload }, signal);
}
function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || "Account Hub API 请求失败");
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

// plugin-src/client/account-hub-styles.js
var STYLES = `
/* 页面撑满宿主 settings.section 的 .options：height（不是 min-height）给出
   确定高度，右栏才有可滚动的边界。 */
.dim-ah-page { display: flex; flex-direction: column; height: 100%; color: var(--dsw-alias-label-primary); }
.dim-ah-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
/* header 右侧操作组：通道下拉 + 更新按钮挤在同一组里，靠 gap 分隔 ——
   更新按钮保持最右原位（v0.3.1 布局修复，不随新增控件漂移）。 */
.dim-ah-headerActions { display: flex; align-items: center; gap: 8px; flex: none; }
.dim-ah-brand { display: flex; flex-direction: column; }
.dim-ah-brandTitleRow { display: flex; align-items: center; gap: 8px; }
/* 品牌名是外链（仓库地址）：不加下划线以保持标题观感，颜色沿用链接
   语义 token，hover 用宿主的快速过渡 —— 可点性靠 hover 变色传达。 */
.dim-ah-brandNameLink { font-size: var(--dsw-font-base-strong-16-font-size); line-height: var(--dsw-font-base-strong-16-line-height); font-weight: var(--dsw-font-base-strong-16-font-weight); color: var(--dsw-alias-label-primary); text-decoration: none; }
.dim-ah-brandNameLink:hover { color: var(--dsw-alias-link); transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
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
   恒为 200px，不随右栏内容收缩（光有 width 挡不住 flex-shrink）。
   scrollbar-gutter: stable 让滚动条占位恒定：内容增多时滚动条出现/消失
   不会引起本栏内容区宽度跳变（真机报障：内容多时滚动条突然出现挤布局）。 */
.dim-ah-rail { flex: none; width: 200px; border-right: 1px solid var(--dsw-alias-border-l2); padding: 8px; overflow-y: auto; scrollbar-gutter: stable; display: grid; align-content: start; gap: 8px; }

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
   scrollbar-gutter: stable 与隐藏并存：滚动条隐藏时占位恒为 0、天然稳定；
   留这条是与其他三个滚动容器口径统一，将来若撤隐藏、占位也不会闪跳。
   滚动条只是被隐藏，滚动能力原样保留（滚轮 / 键盘 / 触控板照常）。
   两条路径都要写，且不是重复：scrollbar-width 是 Firefox 的口径，
   ::-webkit-scrollbar 是 Chromium / Electron（DSH 桌面端）的口径。
   ⚠️ 反过来也成立：Chromium 里一旦声明 scrollbar-width: none，本元素上的
   ::-webkit-scrollbar* 规则会被整体丢弃 —— 这里不要紧（我们要的就是隐藏），
   但**别**在这条规则上再加 hover 之类的伪元素定制。 */
.dim-ah-panel { flex: 1; padding: 24px; overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: none; }
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
/* ── 下拉锚点胶囊（本文件唯一一处控件外观） ──
   全插件三处下拉共用这一枚锚点：头部的「更新通道」，面板顶部的「消耗顺序 /
   切换粒度」，候选行里的「供应商 / 模型 / 思考程度」。ui-primitives 没有
   Select / DropdownMenu 导出，宿主的设置页同样是「Menu 原语 + 自建胶囊按钮」——
   以下几何与配色**逐字**沿用宿主 LanguageRow.module.css 的 .selector
   （PreferenceRow.module.css 里那份逐字相同，是同一枚控件的第二次出现）。
   宽度不写死：头部那枚按「正式 / Beta」文案自适应，另两处由各自的栅格列拉伸
   （见 .dim-ah-consumptionGroup 与 .dim-ah-arEntryRow 的后代规则）。 */
.dim-ah-selectAnchor { display: inline-flex; align-items: center; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
/* hover 与禁用两态：宿主 .selector 的两处用例都可点，故它两条都没有。
   这里补上，取值照同包 Button.module.css —— .button:disabled 的
   （cursor: not-allowed + opacity: 0.4）与 .ghost/.outline 的 :not(:disabled)
   守卫，保证与同页其它按钮的禁用观感一致，且禁用时不会误亮。 */
.dim-ah-selectAnchor:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ah-selectAnchor:disabled { cursor: not-allowed; opacity: 0.4; }
/* chevron 不参与压缩：窄列下该省略的是文案，图标不能跟着变形。 */
.dim-ah-selectAnchorChevron { flex: none; }
/* 未签到与登录入口采用白底黑字的 outline 外观。 */
.dim-ah-iconBtn-light { background: white; color: black; }
.dim-ah-iconGlyph { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
.dim-ah-iconGlyph[data-loading="true"] { animation: dim-ah-icon-spin 1s linear infinite; }
@keyframes dim-ah-icon-spin { to { transform: rotate(360deg); } }
/* 状态文案变化时固定文本操作按钮的最小宽度。 */
.dim-ah-btn-stable { min-width: max-content; }

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

/* 版本号文本（header 品牌行内，替换原「已是最新」Tag）：一个文本位承载全部
   更新状态，色档与 .dim-ah-probeNotice 的 data-tone 域同源 —— warn = 有更新，
   ok = 更新完成，error = 失败原文，idle/muted = 常态版本号 / 过程态。 */
.dim-ah-versionText { flex: none; max-width: 240px; overflow: hidden; padding: 2px 6px; border: none; border-radius: 6px; background: transparent; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-font-height, var(--dsw-font-xxs-12-font-size)); font-weight: var(--dsw-font-xxs-strong-12-font-weight); color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-versionText:hover { color: var(--dsw-alias-link); }
.dim-ah-versionText[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dim-ah-versionText[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dim-ah-versionText[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dim-ah-versionText[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
/* 有更新态的白底黑字「更新」按钮（用户拍板，替换原 ⇩ 图标按钮形态）。 */
.dim-ah-updateBtn { min-width: max-content; }
/* 更新日志：等宽 + 限高滚动。服务端给的是 pnpm 安装输出汇总，可能上百行，
   不设上限会把下面的两栏布局顶出视口（与 .dim-ah-modal 的 max-height 同一考虑）。
   scrollbar-gutter: stable：日志跨过限高时滚动条占位恒定，不挤压文本宽度。 */
.dim-ah-updateLog { max-height: 180px; margin: 6px 0 0; padding: 8px 10px; overflow: auto; scrollbar-gutter: stable; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); white-space: pre-wrap; word-break: break-all; }

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
   会让弹窗高于视口、底部的刷新按钮被顶出屏幕（连滚动都到不了）。
   className 由 Modal 挂在 dialog 节点上（与宿主 .dialog 同一个元素，见
   Modal.tsx 的 clsx(css.dialog, className)），故这两条直接覆盖宿主的 380px 默认。
   注入顺序是**运行期**（installAccountHubStyles 往 head 末尾 append），晚于宿主
   构建期的样式表，同特异性下后者胜出 —— 这正是这条能生效的前提。
   max-height 取 min(640px, calc(100vh - 48px))：小视口按视口留 24px 边距，
   大视口封顶 640px，超出的部分由 .dim-ah-modalBody 自己滚。 */
.dim-ah-modal { width: min(560px, 100%); max-height: min(640px, calc(100vh - 48px)); }
/* ⚠️ 标题行与正文都由本插件**自绘**（见 ModelListPanel 的 headless 分支），
   因为宿主 Modal 的 title 只收字符串、也没有标题栏插槽。代价是宿主那两层
   内边距随 headless 一起消失，必须在这里补齐，否则标题与列表会紧贴卡片圆角：
   - 头部对齐宿主 .header 的 22px 14px 12px 24px；
   - 正文对齐宿主 .body 的左右 24px（上下由 .dialog 的 20px gap 承担）。 */
.dim-ah-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 14px 12px 24px; }
/* 标题 + 当前 Provider 名同排：标题不缩，Provider 名过长时自己省略。 */
.dim-ah-modalTitleRow { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
/* 字号行高逐字对齐宿主 .title（16px / 24px / 500）。 */
.dim-ah-modalTitle { flex: none; margin: 0; font-size: var(--dsw-font-base-strong-16-font-size); line-height: var(--dsw-font-base-strong-16-line-height); font-weight: var(--dsw-font-base-strong-16-font-weight); color: var(--dsw-alias-label-primary); }
/* Provider 名是「当前在给哪个 provider 配模型」的唯一线索，必须一眼可见：
   14px 二级灰（此前是 12px 三级灰，实机上淡到看不出有字，被当成没渲染）。 */
.dim-ah-modalSubtitle { min-width: 0; overflow: hidden; font-size: var(--dsw-font-s-14-font-size); line-height: var(--dsw-font-s-14-line-height); font-weight: var(--dsw-font-s-14-font-weight); color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧刷新 / 关闭按钮组 */
.dim-ah-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-ah-modalHint { flex: none; margin: 0; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-tertiary); }
.dim-ah-modal .dim-ah-probeNotice { flex: none; margin: 10px 0 0; }
/* 列表区独立滚动：头部固定，模型多时只滚中间。
   这条 class 是 ModelListPanel 自绘正文容器的类名（headless 下不再走 Modal 的
   contentClassName）—— 正文的左右内边距与滚动都靠它。 */
.dim-ah-modalBody { flex: 1 1 auto; min-height: 0; padding: 0 24px; overflow-y: auto; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 4px; }
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
/* 锚点填满分组；文字与 chevron 分列两端。宽度由分组决定，不跟随选中项文案变化。
   ⚠️ 这条是 .dim-ah-selectAnchor 的**后代**规则，必须排在那条基础规则之后：
   spec 用 styles.indexOf('.dim-ah-selectAnchor {') 定位基础规则，而后代写法里
   含有同一个子串，顺序颠倒会让它切到错误的那一段。 */
.dim-ah-consumptionGroup .dim-ah-selectAnchor { box-sizing: border-box; width: 100%; min-width: 0; justify-content: space-between; white-space: nowrap; }
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
   标题与操作控件、卡片列表、卡片内的候选行。 */

/* 面板头部：标题与总开关同排，开关紧随标题。 */
.dim-ah-arHead { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dim-ah-arTitle { margin: 0; font-size: var(--dsw-font-m-18-font-size); line-height: var(--dsw-font-m-18-line-height); font-weight: var(--dsw-font-m-18-font-weight); color: var(--dsw-alias-label-primary); }
.dim-ah-arDirtyTag { font-size: var(--dsw-font-xxxs-11-font-size); line-height: var(--dsw-font-xxxs-11-line-height); }

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

/* 卡片头：有拖拽柄时为拖拽柄 + 名称按钮 + 折叠按钮 + 删除按钮；名称列优先压缩。
   无拖拽柄时去掉首列；列数必须与 DOM 子节点一一对应，名称列吃满剩余宽度。 */
.dim-ah-arCardHead { display: grid; grid-template-columns: 16px minmax(0, 1fr) max-content max-content; align-items: center; gap: 8px; }
.dim-ah-arCardHead[data-drag-enabled="false"] { grid-template-columns: minmax(0, 1fr) max-content max-content; }
/* 自动模型名称是纯文本按钮：默认不画边框与底色，长名称在名称列内省略。
   min-width: 0 与卡头的 minmax(0, 1fr) 配套，保证名称不会把折叠 / 删除按钮挤出卡片。
   悬停提示由 withHoverTitle 负责，按钮本身只保留可点击的文本观感。 */
.dim-ah-arNameButton { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 4px 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--dsw-font-xs-13-font-size); line-height: var(--dsw-font-xs-13-line-height); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-ah-arNameButton:hover:not(:disabled) { background: transparent; color: var(--dsw-alias-label-primary); }
.dim-ah-arNameButton:disabled { cursor: not-allowed; opacity: .4; }
.dim-ah-arNameButton:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }

/* 折叠按钮：28px 方形与卡头其它小型操作对齐，图标颜色与状态都走 token。 */
.dim-ah-arFoldButton { box-sizing: border-box; flex: none; width: 28px; min-width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dim-ah-arFoldButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dim-ah-arFoldButton:disabled { cursor: not-allowed; opacity: .4; }
.dim-ah-arFoldButton:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dim-ah-arFoldButton > * { transform: rotate(-90deg); transition: transform var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-arFoldButton[data-open="1"] > * { transform: rotate(0deg); }
@media (prefers-reduced-motion: reduce) {
  .dim-ah-arFoldButton > * { transition: none; }
}

/* 名称编辑弹窗的输入框优先占用剩余空间；弹窗输入类名落在 ui-primitives
   Input 的外层 wrapper 上，必须保留 border-box / width / min-width 三项，避免真机
   窄窗口下内容盒额外膨胀后与相邻操作重叠。 */
.dim-ah-arNameInput { box-sizing: border-box; width: 100%; min-width: 0; }

/* 候选列表（卡片内），间距按 12/8/4 节奏收敛。 */
.dim-ah-arEntries { display: grid; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
/* 一条候选：拖拽柄 + 一行可点击文本 + 按删除钮内容自适应的末列。
   三个下拉已搬进候选编辑弹窗（见 .dim-ah-arEditor），行上只剩「这条候选长什么样」
   与两个行级动作（拖拽、删除），故文本列吃满剩余宽度。 */
.dim-ah-arEntryRow { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr) max-content; align-items: center; gap: 8px; padding: 4px; border-radius: 8px; transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out), opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.dim-ah-arEntryRow[data-drag-enabled="false"] { grid-template-columns: minmax(0, 1fr) max-content; }
.dim-ah-arEntryRow:hover { background: var(--dsw-alias-bg-layer-2); }
.dim-ah-arEntryRow[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
.dim-ah-arEntryRow[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -4px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dim-ah-arEntryRow[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -4px; height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
/* 行上的候选描述：一枚无边框文本按钮，点开候选编辑弹窗（三个下拉在里面）。
   外观基本清掉（无边框 / 无背景 / 字体族仍走继承），只留 hover 的交互底色 ——
   取值照同包 Button.module.css 的 ghost 外观，与 .dim-ah-selectAnchor 的 hover
   是同一条 token。overflow + ellipsis 是必须的：模型名动辄几十字符，栅格列宽
   由 minmax(0, 1fr) 定死，不裁就会画到删除按钮上。
   ⚠️ 字号**不**继承：面板正文档是 14px，用户真机反馈候选行偏大，故降到 13px 一档
   （--dsw-font-xs-13-*，正是 s-14 之下、xxs-12 之上的那一级）。
   font: inherit 必须保留 —— button 元素默认**不**继承字体，删掉它按钮会掉回
   浏览器默认字体族；故写法是「先整体 inherit，再用 font-size / line-height 两个
   长写各覆盖一档」，顺序不能颠倒。
   ⚠️ 本文件整体是一段模板字面量，注释里**不得出现反引号**（会截断字符串）。 */
.dim-ah-arEntryText { box-sizing: border-box; min-width: 0; max-width: 100%; padding: 4px 8px; border: none; border-radius: 6px; background: transparent; font: inherit; font-size: var(--dsw-font-xs-13-font-size); line-height: var(--dsw-font-xs-13-line-height); color: var(--dsw-alias-label-primary); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-ah-arEntryText:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ah-arEntryText:disabled { cursor: not-allowed; opacity: 0.4; }
/* 还没选全时那行字是**引导语**（「选择供应商」/「选择模型」）而不是配置值，
   退到三级灰，与已配好的「模型(档位)-供应商」区分开。 */
.dim-ah-arEntryText[data-placeholder="true"] { color: var(--dsw-alias-label-tertiary); }

/* 候选编辑弹窗正文：三行「标签 + 下拉」加一行 User-Agent 覆写，
   标签列按文案自适应、控件吃满剩余。 */
.dim-ah-arEditor { display: grid; gap: 12px; }
.dim-ah-arEditorRow { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 12px; }
.dim-ah-arEditorLabel { font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); color: var(--dsw-alias-label-secondary); }
/* 弹窗里的锚点铺满整列，选项文字变化不会改变列宽。
   overflow: hidden 是必须的：栅格列宽由 minmax(0, 1fr) 定死，而胶囊的文案可以
   比列还长（模型名动辄几十字符），不裁就会画到相邻列上。
   ⚠️ 与 .dim-ah-consumptionGroup 那条同因：后代规则必须排在
   .dim-ah-selectAnchor 基础规则之后（见该处的说明）。 */
.dim-ah-arEditorRow .dim-ah-selectAnchor { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; justify-content: space-between; overflow: hidden; white-space: nowrap; }

/* User-Agent 覆写行：label + 输入框 + 重置按钮排成一条 flex 行，与上面三行共用
   同一条 12px 节奏。label 复用 .dim-ah-arEditorLabel（同一档字号与色阶）。
   ⚠️ 这一行是**高级配置**，不进候选行摘要文本（见 .dim-ah-arEntryText）。 */
.dim-ah-arEditorUaRow { display: flex; align-items: center; gap: 12px; }
/* 输入框的 className 落在 ui-primitives 那个 wrapper span 上（同 .dim-ah-arNameInput）。
   那一层自带 8px 水平内边距 + 0.5px 描边，而宿主全站没有通盘 box-sizing 重置：
   不显式声明 border-box，flex 项的内容盒就会宽出 17px，把右邻的重置按钮挤出弹窗。
   min-width: 0 保证超长 UA 文本被裁在输入框里，而不是把整行顶开。 */
.dim-ah-arEditorUaInput { box-sizing: border-box; flex: 1 1 auto; width: 100%; min-width: 0; }

/* Originator 覆写行：与上面的 UA 行**同构**（label + 输入框 + 重置按钮一条 flex 行、
   同一条 12px 节奏、label 复用 .dim-ah-arEditorLabel），故两条规则逐字对齐。
   ⚠️ 仍然另起两个类名而不是复用 UA 那两个：两条通道是**彼此独立**的字段，共用一个
   类名会让「只想调其中一行」的后续改动被迫同时改到另一行（例如某天 UA 行要加
   monospace 字体，Originator 行不该被牵连）。同名复用省下的两行 CSS 抵不上这份耦合。
   ⚠️ 语义差异（本行 placeholder 是固定一句「默认不发此头」而非现算的默认值）属于文案，
   与盒模型无关，故布局不需要跟着不同。
   ⚠️ 与 UA 行一样是**高级配置**，不进候选行摘要文本（见 .dim-ah-arEntryText）。 */
.dim-ah-arEditorOriginatorRow { display: flex; align-items: center; gap: 12px; }
/* 与 .dim-ah-arEditorUaInput 同因：className 落在 ui-primitives 的 wrapper span 上，
   宿主全站没有通盘 box-sizing 重置，不显式声明 border-box 内容盒就会宽出 17px、
   把右邻的重置按钮挤出弹窗；min-width: 0 保证超长值被裁在输入框里。 */
.dim-ah-arEditorOriginatorInput { box-sizing: border-box; flex: 1 1 auto; width: 100%; min-width: 0; }

/* 「客户端伪装」预设行：label + 下拉胶囊 + 行内徽标一条 flex 行，与上面两行共用
   同一条 12px 节奏，label 复用 .dim-ah-arEditorLabel。
   ⚠️ 它排在 UA / Originator **之后**：本行是那两格（外加一枚不可见的 windowId）的
   一键填充宏，是「身份伪装」这一组的收口，不是与它们并列的第三个独立字段。
   ⚠️ 本行没有输入框，故不需要 .dim-ah-arEditorMasqueradeInput 那条（设计文档
   5.5 节把「输入框若有」列为条件项）；但下拉锚点仍需要一条后代规则，见下。
   ⚠️ 本行是**高级配置**，不进候选行摘要文本（见 .dim-ah-arEntryText）。 */
.dim-ah-arEditorMasqueradeRow { display: flex; align-items: center; gap: 12px; }
/* 锚点在本行里**吃满剩余宽度**（与上面三行「胶囊铺满栅格列」同观感）。
   不是为了好看：胶囊宽度若随文案自适应，「Codex 客户端」与「自定义」两档宽度不同，
   切换预设时右邻徽标会跟着左右跳。让锚点吸走剩余空间，徽标就钉在行尾不动。
   ⚠️ 与 .dim-ah-arEditorRow 那条同因（见该处说明）：后代规则必须排在
   .dim-ah-selectAnchor 基础规则之后；且这里用 flex 而不是 width: 100%，
   因为本行是 flex 行而不是栅格行 —— 写 width: 100% 会把徽标挤出弹窗。
   ⚠️ 锚点基础规则没有 box-sizing，宿主全站也没有通盘重置：不显式声明 border-box，
   它自带的 0 14px 内边距会加在宽度之外，同样把徽标挤出去。 */
.dim-ah-arEditorMasqueradeRow .dim-ah-selectAnchor { box-sizing: border-box; flex: 1 1 auto; min-width: 0; max-width: 100%; justify-content: space-between; overflow: hidden; white-space: nowrap; }
/* 徽标不参与压缩：窄弹窗下该被裁的是锚点里的预设名，徽标是这条信息里唯一
   不可从别处推出的结论（补丁到底打上没有），不能跟着变形或被截成半个词。
   外观全部来自 ui-primitives 的 Tag，这里只钉住不被挤。 */
.dim-ah-arEditorMasqueradeBadge { flex: none; white-space: nowrap; }

/* 自动模型定义列表尾部的全宽添加块，与宿主 addBlock 的 12px 间距一致。 */
.dim-ah-arAddDefinition { display: flex; margin-top: 12px; }
/* 候选列表尾部的全宽添加行，与宿主 addBlock 的 12px 间距一致。 */
.dim-ah-arAddEntry { display: flex; width: 100%; margin-top: 4px; }
/* 自动路由两个添加入口复刻宿主「添加模型提供商」按钮的视觉。 */
.dim-ah-arAddButton {
  box-sizing: border-box;
  height: 44px;
  min-width: 180px;
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  border: .5px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dim-ah-arAddButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ah-arAddButton:disabled { opacity: .4; cursor: default; }
.dim-ah-arAddButton:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline: none;
}

/* 「自动路由」导航项的图标容器：与 .dim-ah-providerIcon 同形（尺寸 / 圆角 /
   投影都来自那一条），这里只换**背景色**。
   ⚠️ 它不是品牌标识 —— 品牌色豁免只覆盖七个第三方产品的官方图标，自动路由是本
   插件自己的功能入口，故配色必须走 token（与 providerIcon 的 white 字面量不同）。
   --dsw-alias-state-business-primary 的语义是「业务 / 功能分类」，正是这里要表达的
   「这是本插件自己的功能，不是某个第三方 provider」；图标本身用 currentColor，
   故同一条规则里把前景色一起设成反色。 */
.dim-ah-providerIcon.ar { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverted); }
`;
var injected = false;
function installAccountHubStyles() {
  if (injected) return () => {
  };
  injected = true;
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
    injected = false;
  };
}

// plugin-src/client/account-hub.js
var React = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// plugin-src/client/credits-capabilities.js
var CREDITS_CAPABILITIES = Object.freeze({
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
  "buddy-cn": Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: false }),
  // LobsterAI：余额走 profile-summary，签到走 client-activities 三步流程，两项都支持。
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Trae CN：余额走 web_user_ent_usage（**只显示通用池** —— IDE 对话扣的就是它），
  // 签到走 checkin_credits 两步流程（claim 带设备四件套），两项都支持。
  // 键名是 `trae-cn`（带连字符，与 `PROVIDERS` 的 id 及后端 provider 实参一致）。
  "trae-cn": Object.freeze({ balance: true, dailyCheckin: true }),
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
  "qoder-cn": Object.freeze({ balance: true, dailyCheckin: true })
});
function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}
function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}

// plugin-src/client/account-order.js
function orderAfterDrop(ids, sourceId, targetId, position = "before") {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  const targetIndex = next.indexOf(targetId);
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  return next;
}
function dropPositionFromPointer(clientY, rect) {
  if (!rect || !rect.height) return "before";
  return clientY > rect.top + rect.height / 2 ? "after" : "before";
}

// plugin-src/client/account-hub.js
var ACCOUNT_HUB_RPC_CHANNEL = "/account-hub";
var CODEARTS_ICON = "data:image/png;base64,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";
var BUDDY_CN_ICON = "data:image/png;base64,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";
var BUDDY_ICON = "data:image/png;base64,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";
var LOBSTERAI_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjZTg1MDNhIi8+PHBhdGggZD0iTTEyIDUuNWMtMi40IDAtNC4yIDEuNi00LjIgNHY1LjJjMCAyLjMgMS44IDMuOCA0LjIgMy44czQuMi0xLjUgNC4yLTMuOFY5LjVjMC0yLjQtMS44LTQtNC4yLTR6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAuMyIgY3k9IjEwLjIiIHI9IjEiIGZpbGw9IiNlODUwM2EiLz48Y2lyY2xlIGN4PSIxMy43IiBjeT0iMTAuMiIgcj0iMSIgZmlsbD0iI2U4NTAzYSIvPjxwYXRoIGQ9Ik04LjQgNy4yIDYuMiA0LjltOS40IDIuMyAyLjItMi4zTTkuOSAxOC41bC0xLjQgMm02LjYtMiAxLjQgMiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+PC9zdmc+";
var TRAE_CN_ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMy42OTIiIGZpbGw9IiMxQTFCMUQiLz48cGF0aCBkPSJNMTMuMjM1IDUuODI5VjQuMzMySDIuNzU4djUuOTg3aDEuNDk2djEuNDk2aDguOTgxVjUuODI4Wm0tMS40OTcgNC40OUg0LjI1NFY1LjgzaDcuNDg0djQuNDlaIiBmaWxsPSIjMzJGMDhDIi8+PHBhdGggZD0iTTYuOTM3IDYuOTkzIDUuODggOC4wNTEgNi45MzcgOS4xMSA3Ljk5NSA4LjA1IDYuOTM3IDYuOTkzWk05LjkzMSA2Ljk5MiA4Ljg3MyA4LjA1IDkuOTMxIDkuMTEgMTAuOTkgOC4wNSA5LjkzIDYuOTkyWiIgZmlsbD0iIzMyRjA4QyIvPjwvc3ZnPg==";
var QODER_ICON = "data:image/png;base64,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";
var PROVIDERS = Object.freeze([
  { id: "codearts", label: "Codearts", icon: CODEARTS_ICON, logoClass: "codearts" },
  { id: "buddy-cn", label: "Buddy CN", icon: BUDDY_CN_ICON, logoClass: "buddy-cn" },
  { id: "buddy", label: "Buddy", icon: BUDDY_ICON, logoClass: "buddy" },
  { id: "lobsterai", label: "LobsterAI", icon: LOBSTERAI_ICON, logoClass: "lobsterai" },
  // 顺序 = 后端注册顺序（src/index.ts 里 Trae CN 服务在 LobsterAI 之后建立），
  // 也是能力矩阵里的登记顺序。
  //
  // 显示名一律用产品自身的叫法、**不带公司注记**（曾经是「CodeBuddy (腾讯)」
  // 「WorkBuddy (国际版)」「LobsterAI (有道)」「Trae CN (字节跳动)」）。
  // 图标常量名同样跟着产品走：`BUDDY_CN_ICON` 是中国版那份，`BUDDY_ICON` 是
  // 国际版那份（两者在改名时**没有**换过图标本体，只换了常量名与归属）。
  // `TRAE_CN_ICON` 归 `trae-cn`（TraeWork 曾是同一产品的第二条路径，官方已把
  // 该通道并入通用通道，那条 provider 已整体移除）。
  { id: "trae-cn", label: "Trae CN", icon: TRAE_CN_ICON, logoClass: "trae-cn" },
  // Qoder：登录形态是**全新的** —— 浏览器设备流。
  //
  // 字段严格只有 id / label / icon / logoClass 四项：该条目的形态被
  // credits-capabilities.spec.ts 的 FULL 匹配器逐字锁死。
  { id: "qoder", label: "Qoder", icon: QODER_ICON, logoClass: "qoder" },
  // Qoder **CN（国内版）**：与国际版**同协议双 region**（另一组 host、另一套
  // 出站身份值），登录形态同为浏览器设备流。
  //
  // ⚠️ **图标刻意复用 `QODER_ICON`**（不是新造一份）：两个 region 是**同一个
  //   品牌**，官方 `qoder.cn` 首页的 `rel="icon"` 指向的正是**同一张** alicdn
  //   PNG（与 qoder.com 逐字节同源），靠 `label` 与 `logoClass` 区分面板即可。
  //   （`qoder.cn` 另有一张内联 `favIcon.svg`，但 73 KB，远超内联预算，故不取。）
  { id: "qoder-cn", label: "Qoder CN", icon: QODER_ICON, logoClass: "qoder-cn" }
]);
var LOGIN_WINDOW_NAME = "dsh-account-hub-login";
var LOGIN_WINDOW_FEATURES = "width=800,height=600,resizable=yes,scrollbars=yes";
function ProviderLogo({ provider }) {
  const p = PROVIDERS.find((p2) => p2.id === provider);
  if (!p) return null;
  return React.createElement(
    "span",
    { className: `dim-ah-providerIcon ${p.logoClass}` },
    React.createElement("img", { src: p.icon, alt: "", width: 20, height: 20 })
  );
}
function withHoverTitle(node, text) {
  if (node === null || node === void 0) return node;
  if (typeof text !== "string" || text.length === 0) return node;
  const anchor = typeof node.type === "string" ? node : React.createElement("span", { className: "dim-ah-tipWrap" }, node);
  return React.createElement(import_dsh_client_ui_primitives.Tooltip, { label: text }, anchor);
}
function formatTime(ts) {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts);
  const now = Date.now();
  if (ts < now) return "已过期";
  const diff = ts - now;
  if (diff < 36e5) return `${Math.round(diff / 6e4)} 分钟后`;
  if (diff < 864e5) return `${Math.round(diff / 36e5)} 小时后`;
  return d.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatCredits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function formatPackageLine(pkg) {
  const remaining = formatCredits(pkg.remaining) ?? "?";
  const total = formatCredits(pkg.total) ?? "?";
  const parts = [`${pkg.active ? "" : "[已失效] "}${pkg.name || "未命名"}: ${remaining} / ${total}`];
  if (!pkg.active && pkg.expiredTime) parts.push(`失效于 ${pkg.expiredTime}`);
  else if (pkg.cycleEndTime) parts.push(`本周期至 ${pkg.cycleEndTime}`);
  return parts.join(" · ");
}
var CLAIM_FAILURE_FALLBACK = "领取失败";
var CLAIM_UNAVAILABLE_FALLBACK = "服务端此刻暂不可签";
function formatClaimUnavailableLine(result) {
  return formatClaimFailureLine(result, CLAIM_UNAVAILABLE_FALLBACK);
}
function formatClaimFailureLine(result, fallback = CLAIM_FAILURE_FALLBACK) {
  const outcome = result?.outcome ?? {};
  const label = result?.nickname || result?.accountId || "未知账号";
  const raw = typeof outcome.message === "string" ? outcome.message.trim() : "";
  const message = raw !== "" ? raw : fallback;
  const code = typeof outcome.code === "number" && Number.isFinite(outcome.code) ? String(outcome.code) : "未知";
  const base = `${label}：${message}（code ${code}）`;
  const logid = typeof outcome.logid === "string" ? outcome.logid.trim() : "";
  return logid !== "" ? `${base} · logid ${logid}` : base;
}
function claimFailureLines(res) {
  const results = res?.results;
  if (!Array.isArray(results)) return [];
  return results.filter((item) => item?.outcome?.kind === "failed").map((item) => formatClaimFailureLine(item));
}
function claimUnavailableLines(res) {
  const results = res?.results;
  if (!Array.isArray(results)) return [];
  return results.filter((item) => item?.outcome?.kind === "unavailable").map(formatClaimUnavailableLine);
}
var CLAIM_ABNORMAL_FALLBACK = "签到响应成功但积分未增加";
function formatBalanceNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
function formatClaimAbnormalLine(result) {
  const outcome = result?.outcome ?? {};
  const label = result?.nickname || result?.accountId || "未知账号";
  const raw = typeof outcome.message === "string" ? outcome.message.trim() : "";
  const message = raw !== "" ? raw : CLAIM_ABNORMAL_FALLBACK;
  const before = formatBalanceNumber(outcome.balanceBefore);
  const after = formatBalanceNumber(outcome.balanceAfter);
  const numbers = before !== null && after !== null ? `（签到前 ${before} → 签到后 ${after}）` : "";
  return `${label}：${message}${numbers}`;
}
function claimAbnormalLines(res) {
  const results = res?.results;
  if (!Array.isArray(results)) return [];
  return results.filter((item) => item?.outcome?.kind === "abnormal").map(formatClaimAbnormalLine);
}
var CLAIM_UNDETERMINED_FALLBACK = "无法判定今天是否已领取";
function formatClaimUndeterminedLine(result) {
  const outcome = result?.outcome ?? {};
  const label = result?.nickname || result?.accountId || "未知账号";
  const raw = typeof outcome.message === "string" ? outcome.message.trim() : "";
  return `${label}：${raw !== "" ? raw : CLAIM_UNDETERMINED_FALLBACK}`;
}
function claimUndeterminedLines(res) {
  const results = res?.results;
  if (!Array.isArray(results)) return [];
  return results.filter((item) => item?.outcome?.kind === "undetermined").map(formatClaimUndeterminedLine);
}
var CHECKIN_BUSY_NOTICE = { tone: "warn", text: "已有签到正在进行，请稍候", details: [] };
function buildClaimNotice(res) {
  const summary = res.summary;
  const parts = [];
  if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功（+${summary.totalCredit} 积分）`);
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领取`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
  const unavailableCount = summary.unavailable ?? 0;
  if (unavailableCount > 0) parts.push(`${unavailableCount} 个暂不可签`);
  const abnormalCount = summary.abnormal ?? 0;
  if (abnormalCount > 0) parts.push(`${abnormalCount} 个签到异常`);
  const undeterminedCount = summary.undetermined ?? 0;
  if (undeterminedCount > 0) parts.push(`${undeterminedCount} 个无法判定`);
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
  return {
    tone: summary.failed > 0 ? "warn" : "ok",
    text: parts.length > 0 ? parts.join("，") : "没有可领取的账号",
    // 成功 / 已领 / 活动未开启都不产生明细行，故那些路径的渲染逐元素不变。
    details: claimFailureLines(res),
    // 暂不可签同样**不并入** details：它不是失败，混进去会让用户去排查。
    unavailableDetails: claimUnavailableLines(res),
    // 签到异常独立成段，理由见函数头。
    abnormalDetails: claimAbnormalLines(res),
    // 无法判定独立成段（2026-09-24）：它既不是失败也不是已领。
    undeterminedDetails: claimUndeterminedLines(res)
  };
}
function ClaimNotice({ tone, text, details, unavailableDetails, abnormalDetails, undeterminedDetails }) {
  return React.createElement(
    "div",
    {
      className: "dim-ah-probeNotice",
      "data-tone": tone,
      role: tone === "error" ? "alert" : "status"
    },
    React.createElement("div", null, text),
    // 每个失败账号一行：账号名 + 服务端 message + code。文案已由
    // formatClaimFailureLine 兜底（message 缺失时给固定文案），这里只判有无。
    (details?.length ?? 0) > 0 ? React.createElement(
      "ul",
      { className: "dim-ah-probeDetails" },
      details.map((line, i) => React.createElement("li", { key: i }, line))
    ) : null,
    // 「暂不可签」单独一段，**不复用**失败明细那个列表：它与失败是两种东西，
    // 混在一个 <ul> 里用户会一并当成待处理的问题。
    (unavailableDetails?.length ?? 0) > 0 ? React.createElement(
      "ul",
      {
        className: "dim-ah-probeDetails",
        "data-kind": "unavailable"
      },
      unavailableDetails.map((line, i) => React.createElement("li", { key: i }, line))
    ) : null,
    // 「签到异常」同样独立成段（2026-09-24）。它比暂不可签更需要被看见：它描述的
    // 是「响应说成功但账没动」，是本插件唯一会主动质疑服务端结论的一档。
    (abnormalDetails?.length ?? 0) > 0 ? React.createElement(
      "ul",
      {
        className: "dim-ah-probeDetails",
        "data-kind": "abnormal"
      },
      abnormalDetails.map((line, i) => React.createElement("li", { key: i }, line))
    ) : null,
    // 「无法判定」独立成段（2026-09-24）：它既不是失败也不是「已领」。并入已领会
    // 让用户看到一句不成立的「今天已领取」—— 那正是「qoder 假签到」的界面形态。
    (undeterminedDetails?.length ?? 0) > 0 ? React.createElement(
      "ul",
      {
        className: "dim-ah-probeDetails",
        "data-kind": "undetermined"
      },
      undeterminedDetails.map((line, i) => React.createElement("li", { key: i }, line))
    ) : null
  );
}
function CreditBalanceRow({ balance, error, loading }) {
  if (loading) {
    return React.createElement(
      "div",
      { className: "dim-ah-metaRow" },
      React.createElement("dt", null, "积分"),
      React.createElement("dd", { "data-tone": "muted" }, "读取中…")
    );
  }
  if (error || !balance) {
    return React.createElement(
      "div",
      { className: "dim-ah-metaRow" },
      React.createElement("dt", null, "积分"),
      withHoverTitle(
        React.createElement("dd", { "data-tone": "warn" }, error || "查询失败"),
        error || "查询失败"
      )
    );
  }
  const total = formatCredits(balance.total) ?? "0";
  const detail = (balance.packages || []).map(formatPackageLine).join("\n");
  const all = balance.packages || [];
  const activeCount = all.filter((p) => p.active).length;
  return React.createElement(
    "div",
    { className: "dim-ah-metaRow" },
    React.createElement("dt", null, "积分"),
    withHoverTitle(React.createElement(
      "dd",
      { className: "dim-ah-creditValue" },
      React.createElement("strong", { className: "dim-ah-creditTotal" }, total),
      all.length > 1 ? React.createElement(
        "span",
        { className: "dim-ah-creditPackages" },
        `${activeCount}/${all.length} 个资源包有效`
      ) : null,
      // 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
      balance.expiredTotal > 0 ? React.createElement(
        "span",
        { className: "dim-ah-creditExpired" },
        `另有 ${formatCredits(balance.expiredTotal)} 已失效`
      ) : null
    ), detail)
  );
}
function AccountCard({ account, index, order, onToggle, onDelete, busy, credits, creditsLoading, showCredits, showCheckin, checkedIn, checkingThisAccount, onCheckin, drag }) {
  const rateLimits = account.modelRateLimits ? Object.entries(account.modelRateLimits).filter(([, v]) => v > Date.now()) : [];
  const expired = typeof account.expiresAt === "number" && account.expiresAt > 0 && account.expiresAt <= Date.now();
  const dragProps = drag || {};
  return React.createElement(
    "div",
    {
      className: "dim-ah-accountCard",
      "data-enabled": account.enabled,
      // 正在被拖动的卡片：半透明（样式表按 data-dragging 上 opacity）
      "data-dragging": dragProps.isDragging ? "true" : void 0,
      // 插入位置指示：before 画在卡片上方、after 画在下方 —— 必须与实际落点
      // 一致，否则用户按指示拖放却得到相反的结果。
      "data-dropBefore": dragProps.isDropTarget && dragProps.dropPosition !== "after" ? "true" : void 0,
      "data-dropAfter": dragProps.isDropTarget && dragProps.dropPosition === "after" ? "true" : void 0,
      // 整卡可拖：抓取柄之外也能拖，手感更好；卡片内的按钮点击不受影响
      // （HTML5 拖拽需要按住移动，普通 click 不进拖拽路径）。
      draggable: dragProps.enabled ? "true" : void 0,
      onDragStart: dragProps.onDragStart,
      onDragEnd: dragProps.onDragEnd,
      onDragOver: dragProps.onDragOver,
      onDrop: dragProps.onDrop
    },
    React.createElement(
      "div",
      { className: "dim-ah-accountTop" },
      // 抓取柄：拖拽时提供明确的抓取区域，顺序仍由拖拽落点决定。
      dragProps.enabled ? React.createElement("span", {
        className: "dim-ah-dragHandle",
        "aria-hidden": "true"
      }, "⠿") : null,
      // 状态点：绿=已启用、灰=已停用（`StateDot` 的 done / idle 两档）。
      // 迁移前是一个自绘的 8px 圆点 + `title`；现在两者都来自设计体系，
      // 提示文案原样保留。
      withHoverTitle(React.createElement(import_dsh_client_ui_primitives.StateDot, {
        state: account.enabled ? "done" : "idle"
      }), account.enabled ? "已启用" : "已停用"),
      React.createElement(
        "span",
        { className: "dim-ah-accountName" },
        account.nickname || account.id
      ),
      React.createElement(import_dsh_client_ui_primitives.Tag, {
        tone: account.enabled ? "success" : "neutral"
      }, account.enabled ? "已启用" : "已停用")
    ),
    React.createElement(
      "dl",
      { className: "dim-ah-accountMeta" },
      React.createElement(
        "div",
        { className: "dim-ah-metaRow" },
        React.createElement("dt", null, "凭据"),
        React.createElement("dd", null, React.createElement("code", null, account.credentialRef))
      ),
      React.createElement(
        "div",
        { className: "dim-ah-metaRow" },
        React.createElement("dt", null, "有效期"),
        React.createElement(
          "dd",
          { "data-tone": expired ? "warn" : void 0 },
          account.expiresAt ? `${formatTime(account.expiresAt) || "未知"}${account.refreshable ? " · 自动续期" : ""}` : "未知"
        )
      ),
      // 不支持积分余额的 provider（CodeArts）不渲染该行：留着它只能显示
      // 「查询失败」，而失败原因是「这个 provider 根本没有此接口」——
      // 与其展示一条无法修复的错误，不如不展示。
      showCredits ? React.createElement(CreditBalanceRow, {
        balance: credits?.balance ?? null,
        error: credits?.error,
        loading: creditsLoading
      }) : null
    ),
    rateLimits.length > 0 ? React.createElement(
      "div",
      { className: "dim-ah-rateLimits" },
      React.createElement("span", { className: "dim-ah-rateLimitsLabel" }, "限额重置"),
      rateLimits.map(([modelId, resetAt]) => withHoverTitle(React.createElement(import_dsh_client_ui_primitives.Tag, {
        key: modelId,
        tone: "warning",
        className: "dim-ah-ttlBadge"
      }, `${modelId} · ${formatTime(resetAt)}`), `模型 ${modelId}`))
    ) : null,
    React.createElement(
      "div",
      { className: "dim-ah-accountActions" },
      showCheckin ? React.createElement(import_dsh_client_ui_primitives.Button, {
        variant: "outline",
        size: "sm",
        className: `dim-ah-iconBtn${checkedIn || checkingThisAccount ? "" : " dim-ah-iconBtn-light"}`,
        "aria-label": checkedIn ? "已签到" : checkingThisAccount ? "签到中" : "签到",
        // `busy` 是面板级忙碌 —— 由调用方传入，`ProviderPanel` 已把它算成
        // `claiming`（签到进行中）。限流标记那对供应商级按钮删除后，面板级忙碌
        // 只剩签到这一个来源，`probeBusy` 随之消失。
        // ⚠️ 此前它**不含**签到本身：一键签到或自动补签在跑时，单片按钮看起来
        // 可点、点下去却被 `claimingRef` 静默挡掉 —— 「点了没反应」的缺陷形态。
        // `checkingThisAccount` 是本账号自己的签到中态（本卡片局部），
        // 与面板级 `claiming` 是两个维度，两个都要判。
        disabled: busy || checkedIn || checkingThisAccount,
        onClick: () => onCheckin(account.id)
      }, "✉") : null,
      React.createElement(import_dsh_client_ui_primitives.Button, {
        variant: "outline",
        size: "sm",
        onClick: () => onToggle(account.id, !account.enabled)
      }, account.enabled ? "停用" : "启用"),
      React.createElement(import_dsh_client_ui_primitives.Button, {
        variant: "outline",
        size: "sm",
        className: "dim-ah-btn-danger",
        onClick: () => onDelete(account.id)
      }, "删除")
    )
  );
}
function formatCapacity(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1e6) {
    const millions = Math.round(value / 1e5) / 10;
    return `${millions}M`;
  }
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}
function tierOptionsOf(model) {
  const dev = model.contextWindow;
  if (typeof dev !== "number" || !Number.isFinite(dev) || dev <= 0) return null;
  const declared = Array.isArray(model.contextTiers) ? model.contextTiers : [];
  const valid = declared.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  const tiers = [.../* @__PURE__ */ new Set([...valid, dev])].sort((a, b) => a - b);
  if (tiers.length >= 2) return tiers;
  const max = model.maxContextWindow;
  if (typeof max === "number" && Number.isFinite(max) && max > dev) return [dev, max];
  return null;
}
function tierLabelOf(window2, dev, max) {
  if (window2 === dev) return "默认";
  if (typeof max === "number" && window2 === max) return "Max";
  return formatCapacity(window2);
}
function ModelTierPicker({ model, busy, onSelect }) {
  const dev = model.contextWindow;
  const tiers = tierOptionsOf(model);
  if (tiers === null) return null;
  const budget = model.contextBudget;
  const selected = typeof budget === "number" && budget !== dev && tiers.includes(budget) ? budget : dev;
  const name2 = model.name || model.id;
  const option = (window2) => {
    const label = tierLabelOf(window2, dev, model.maxContextWindow);
    const capacity = formatCapacity(window2);
    const text = label === capacity ? capacity : `${label} ${capacity}`;
    return React.createElement(import_dsh_client_ui_primitives.Pill, {
      key: `dim-ah-tier-${model.id}-${window2}`,
      active: selected === window2,
      disabled: busy,
      role: "radio",
      "aria-checked": selected === window2,
      onClick: () => onSelect(model.id, window2),
      className: "dim-ah-tierOption"
    }, withHoverTitle(React.createElement("span", null, text), `${label}档 · ${window2} token`));
  };
  return React.createElement("div", {
    className: "dim-ah-modelTier",
    role: "radiogroup",
    "aria-label": `${name2} 上下文窗口档位`
  }, ...tiers.map(option));
}
function ModelToggle({ model, busy, onToggle, tierBusy, onSelectTier }) {
  const name2 = model.name || model.id;
  return React.createElement(
    "div",
    {
      className: "dim-ah-modelRow",
      "data-disabled": model.disabled ? "true" : "false"
    },
    // 左侧「名字 + id」与右侧开关分列：迁移前它们被包在同一个 `<label>` 里
    // （用隐式关联把点击热区并起来），而隐式 label 会让**同层**的档位控件也被
    // 连带激活。`Switch` 自带 `aria-label` 可读名，不再需要 label 关联，
    // 故这里用普通 div —— 点击热区回到开关本体，档位不会再被误触。
    React.createElement(
      "div",
      { className: "dim-ah-modelMain" },
      withHoverTitle(React.createElement(
        "span",
        { className: "dim-ah-modelInfo" },
        React.createElement("strong", { className: "dim-ah-modelName" }, name2),
        React.createElement("code", { className: "dim-ah-modelId" }, model.id)
      ), model.id),
      React.createElement(import_dsh_client_ui_primitives.Switch, {
        checked: !model.disabled,
        disabled: busy,
        label: `${name2} 是否在模型选择中显示`,
        onChange: () => onToggle(model.id, !model.disabled)
      })
    ),
    React.createElement(ModelTierPicker, {
      model,
      busy: tierBusy,
      onSelect: onSelectTier
    })
  );
}
function ModelListPanel({ provider, rpcCall, onClose }) {
  const [models, setModels] = React.useState(null);
  const [phase, setPhase] = React.useState("loading");
  const [error, setError] = React.useState(null);
  const [toggleError, setToggleError] = React.useState(null);
  const [catalogSource, setCatalogSource] = React.useState(null);
  const [busyIds, setBusyIds] = React.useState(() => /* @__PURE__ */ new Set());
  const [tierBusyIds, setTierBusyIds] = React.useState(() => /* @__PURE__ */ new Set());
  const mounted = React.useRef(true);
  const load = React.useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await rpcCall("model.list", { provider });
      if (!mounted.current) return;
      setModels(res.models || []);
      setCatalogSource(res?.catalogSource || null);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || "无法读取模型列表");
      setPhase("error");
    }
  }, [provider, rpcCall]);
  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  const toggleModel = async (modelId, disabled) => {
    setBusyIds((prev) => new Set(prev).add(modelId));
    setToggleError(null);
    try {
      await rpcCall("model.setDisabled", { provider, modelId, disabled });
      if (!mounted.current) return;
      setModels((prev) => (prev || []).map((m) => m.id === modelId ? { ...m, disabled } : m));
    } catch (caught) {
      console.error("[account-hub] toggle model failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || "切换模型显示状态失败");
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };
  const all = models || [];
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || provider;
  const selectTier = async (modelId, window2) => {
    setTierBusyIds((prev) => new Set(prev).add(modelId));
    setToggleError(null);
    try {
      const res = await rpcCall("model.setContextBudget", { provider, model: modelId, window: window2 });
      if (!mounted.current) return;
      setModels((prev) => (prev || []).map((m) => m.id === modelId ? { ...m, contextBudget: res?.contextBudget } : m));
    } catch (caught) {
      console.error("[account-hub] set context budget failed:", caught);
      if (!mounted.current) return;
      setToggleError(caught?.message || "设置上下文窗口档位失败");
    } finally {
      if (mounted.current) {
        setTierBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };
  const tierHint = all.some((m) => tierOptionsOf(m) !== null) ? "上下文窗口档位只切换向对话宿主声明的窗口（影响自动压缩时机），不改变发给上游的请求内容。" : null;
  return React.createElement(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: "模型列表",
      headless: true,
      className: "dim-ah-modal"
    },
    React.createElement(
      "div",
      { className: "dim-ah-modalHead" },
      React.createElement(
        "div",
        { className: "dim-ah-modalTitleRow" },
        React.createElement("h2", { className: "dim-ah-modalTitle" }, "模型列表"),
        React.createElement("span", { className: "dim-ah-modalSubtitle" }, providerLabel)
      ),
      React.createElement(
        "div",
        { className: "dim-ah-modelPanelActions" },
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "outline",
          size: "sm",
          className: "dim-ah-iconBtn",
          "aria-label": "刷新模型列表",
          disabled: phase === "loading",
          onClick: () => void load()
        }, React.createElement("span", {
          className: "dim-ah-iconGlyph",
          "data-loading": phase === "loading" ? "true" : void 0,
          "aria-hidden": "true"
        }, "⟳")),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "ghost",
          size: "sm",
          className: "dim-ah-iconBtn",
          "aria-label": "关闭模型列表",
          onClick: onClose
        }, React.createElement("span", {
          className: "dim-ah-iconGlyph",
          "aria-hidden": "true"
        }, "✕"))
      )
    ),
    // 正文（说明行 / 失败提示 / 列表）整块进滚动容器。headless 下宿主**不再**渲染
    // 它自己的 `.body`，而那块原本承担着两件事：内容左右内边距（`padding: 0 24px`）
    // 与「超出卡片上限后自己滚」。两件事都必须由 `.dim-ah-modalBody` 接管 ——
    // 少了内边距，列表会紧贴卡片圆角；少了滚动，超过 `.dim-ah-modal` 的 max-height
    // 的部分既看不见也滚不到。
    React.createElement(
      "div",
      { className: "dim-ah-modalBody" },
      tierHint ? React.createElement("p", { className: "dim-ah-modalHint" }, tierHint) : null,
      toggleError ? React.createElement("div", {
        className: "dim-ah-probeNotice",
        "data-tone": "error",
        role: "alert"
      }, React.createElement("div", null, toggleError)) : null,
      phase === "error" ? React.createElement(
        "div",
        { className: "dim-ah-empty" },
        React.createElement("p", null, error),
        React.createElement(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", className: "dim-ah-btn-stable", onClick: () => void load() }, "重新读取")
      ) : phase === "loading" ? React.createElement("div", { className: "dim-ah-empty" }, "正在读取模型列表…") : all.length === 0 ? React.createElement(
        "div",
        { className: "dim-ah-empty" },
        React.createElement("p", null, "该 Provider 当前没有可用的模型。")
      ) : React.createElement(
        "div",
        { className: "dim-ah-modelList" },
        all.map((model) => React.createElement(ModelToggle, {
          key: model.id,
          model,
          busy: busyIds.has(model.id),
          onToggle: (id, disabled) => void toggleModel(id, disabled),
          tierBusy: tierBusyIds.has(model.id),
          onSelectTier: (id, window2) => void selectTier(id, window2)
        }))
      )
    )
  );
}
var CONSUMPTION_ORDER_OPTIONS = [
  { value: "sequential", label: "顺序", hint: "总是用排序里的第一个可用账号" },
  { value: "round-robin", label: "遍历", hint: "每次请求轮转下一个账号，用完一轮再从头开始（默认）" },
  { value: "highest-balance", label: "最高优先", hint: "每次请求用积分余额最高的账号；余额未知时按顺序" }
];
var CONSUMPTION_SWITCH_OPTIONS = [
  { value: "per-request", label: "按请求", hint: "每一次请求都重新选号" },
  { value: "per-turn", label: "按轮次", hint: "一轮对话内固定用同一个账号，下一轮才换（默认，上下文更连贯）" }
];
var CONSUMPTION_DEFAULTS = { order: "round-robin", switch: "per-turn" };
function ConsumptionSelect({ name: name2, label, options, value, busy, onSelect }) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((option) => option.value === value);
  const items = options.map((option) => ({
    id: option.value,
    // 每档自己的说明仍挂在菜单项上，展开列表时逐档可见。
    label: withHoverTitle(React.createElement("span", null, option.label), option.hint)
  }));
  return React.createElement(
    "div",
    { className: "dim-ah-consumptionGroup", "data-name": name2 },
    React.createElement(import_dsh_client_ui_primitives.Menu, {
      open,
      // 锚点是**宿主设置页同款的胶囊按钮**：ui-primitives 没有 Select /
      // DropdownMenu 导出，宿主自己也这么拼（LanguageRow / PreferenceRow 的
      // 「Menu 原语 + 自建胶囊」），几何与配色见 .dim-ah-selectAnchor。
      anchor: React.createElement(
        "button",
        {
          type: "button",
          className: "dim-ah-selectAnchor",
          "aria-label": label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: busy,
          onClick: () => setOpen((prev) => !prev)
        },
        current ? current.label : value,
        React.createElement(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: "dim-ah-selectAnchorChevron" })
      ),
      items,
      // 「弹层宽度 = 按钮宽度」：宿主 Menu 的列表默认是内容宽（min-width: 144px），
      // 与锚点无关，故必须给列表一个类名把它钉到 100%（见样式表）。
      listClassName: "dim-ah-consumptionMenu",
      selectedId: value,
      onSelect: (id) => {
        setOpen(false);
        onSelect(id);
      },
      onClose: () => setOpen(false),
      align: "start"
    })
  );
}
function ConsumptionSelectors({ value, busy, onChange }) {
  const order = value?.order || CONSUMPTION_DEFAULTS.order;
  const switchMode = value?.switch || CONSUMPTION_DEFAULTS.switch;
  return React.createElement(
    "div",
    { className: "dim-ah-consumption" },
    React.createElement(ConsumptionSelect, {
      name: "order",
      label: "消耗顺序",
      options: CONSUMPTION_ORDER_OPTIONS,
      value: order,
      busy,
      onSelect: (next) => onChange({ order: next })
    }),
    React.createElement(ConsumptionSelect, {
      name: "switch",
      label: "切换粒度",
      options: CONSUMPTION_SWITCH_OPTIONS,
      value: switchMode,
      busy,
      onSelect: (next) => onChange({ switch: next })
    })
  );
}
function ProviderPanel({ provider, rpcCall }) {
  const [accounts, setAccounts] = React.useState([]);
  const [phase, setPhase] = React.useState("loading");
  const [error, setError] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [probeNotice, setProbeNotice] = React.useState(null);
  const [credits, setCredits] = React.useState({});
  const [creditsLoading, setCreditsLoading] = React.useState(false);
  const [checkinsByAccount, setCheckinsByAccount] = React.useState({});
  const [checkinStatusLoaded, setCheckinStatusLoaded] = React.useState(false);
  const [accountsLoaded, setAccountsLoaded] = React.useState(false);
  const [manualLogin, setManualLogin] = React.useState(null);
  const mounted = React.useRef(true);
  const accountsRef = React.useRef([]);
  const claimingRef = React.useRef(false);
  const autoCheckinRanRef = React.useRef(false);
  const [consumption, setConsumption] = React.useState(CONSUMPTION_DEFAULTS);
  const [consumptionBusy, setConsumptionBusy] = React.useState(false);
  const [draggingId, setDraggingId] = React.useState(null);
  const [dropTargetId, setDropTargetId] = React.useState(null);
  const [dropPosition, setDropPosition] = React.useState("before");
  const [reordering, setReordering] = React.useState(false);
  const [reorderError, setReorderError] = React.useState(null);
  const [pendingDelete, setPendingDelete] = React.useState(null);
  const [deleteAcknowledged, setDeleteAcknowledged] = React.useState(false);
  const loadAccounts = React.useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await rpcCall("account.list", { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
      setAccountsLoaded(true);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || "无法读取账号列表");
      setPhase("error");
      setAccountsLoaded(true);
    }
  }, [provider, rpcCall]);
  const canLoadCredits = supportsCreditBalance(provider);
  const supportsCredits = supportsDailyCheckin(provider);
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label || provider;
  const loadCredits = React.useCallback(async () => {
    if (!canLoadCredits) return;
    setCreditsLoading(true);
    try {
      const res = await rpcCall("credits.balances", { provider });
      if (!mounted.current) return;
      const next = {};
      for (const item of res.accounts || []) {
        next[item.accountId] = { balance: item.balance, error: item.error };
      }
      setCredits(next);
    } catch (caught) {
      console.error("[account-hub] load credits failed:", caught);
      if (!mounted.current) return;
      const snapshot = accountsRef.current;
      setCredits((prev) => {
        const next = { ...prev };
        for (const account of snapshot) {
          next[account.id] = { balance: null, error: caught?.message || "积分查询失败" };
        }
        return next;
      });
    } finally {
      if (mounted.current) setCreditsLoading(false);
    }
  }, [provider, rpcCall, canLoadCredits]);
  const loadCheckinStatus = React.useCallback(async () => {
    if (!supportsCredits) return;
    try {
      const res = await rpcCall("credits.checkinStatus", { provider });
      if (!mounted.current) return;
      if (accountsRef.current.length > 0 || res.checkedIn) {
        const next = {};
        for (const account of accountsRef.current) {
          next[account.id] = {
            checkedInToday: Boolean(res.checkedIn?.[account.id]),
            // 宿主侧的**旁路抑制态**（`undetermined` 后的窗口内退避，见
            // `src/account-hub-rpc.ts` 的 `undeterminedSuppressUntil`）。
            // ⚠️ 它与 `checkedInToday` 是**正交**的两件事，合并任何一个方向都会
            // 制造缺陷：并进 `checkedInToday` ⇒ 被抑制的账号显示「已签」+ 按钮
            // 禁用，而它**可能一分没领**（正是「假签到」的界面形态）；不带上它
            // ⇒ 下面的自动补签会把「未签」当成「该补一发」并再发一次，宿主刚堵住
            // 的空转循环从客户端这条路原样复活。
            // 旧宿主不返回该字段 ⇒ `undefined` ⇒ `Boolean(undefined) === false`
            // ⇒ 行为退回改动前（多发一发幂等查询），不会读错任何东西。
            suppressed: Boolean(res.suppressed?.[account.id])
          };
        }
        setCheckinsByAccount(next);
      }
      if (mounted.current) setCheckinStatusLoaded(true);
    } catch (caught) {
      console.warn("[account-hub] load checkin status failed:", caught);
    }
  }, [provider, rpcCall, supportsCredits]);
  const loadConsumption = React.useCallback(async () => {
    try {
      const res = await rpcCall("consumption.get", { provider });
      if (!mounted.current) return;
      setConsumption({
        order: res?.consumption?.order || CONSUMPTION_DEFAULTS.order,
        switch: res?.consumption?.switch || CONSUMPTION_DEFAULTS.switch
      });
    } catch (caught) {
      console.warn("[account-hub] load consumption setting failed:", caught);
    }
  }, [provider, rpcCall]);
  const updateConsumption = async (patch) => {
    setConsumptionBusy(true);
    try {
      const res = await rpcCall("consumption.set", { provider, ...patch });
      if (!mounted.current) return;
      setConsumption({
        order: res?.consumption?.order || CONSUMPTION_DEFAULTS.order,
        switch: res?.consumption?.switch || CONSUMPTION_DEFAULTS.switch
      });
    } catch (caught) {
      console.error("[account-hub] update consumption setting failed:", caught);
    } finally {
      if (mounted.current) setConsumptionBusy(false);
    }
  };
  const commitOrder = async (orderedIds) => {
    const snapshot = accountsRef.current;
    const unchanged = snapshot.length === orderedIds.length && snapshot.every((account, index) => account.id === orderedIds[index]);
    if (unchanged) return;
    const byId = new Map(snapshot.map((account) => [account.id, account]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    if (next.length !== snapshot.length) return;
    accountsRef.current = next;
    setAccounts(next);
    setReordering(true);
    setReorderError(null);
    try {
      await rpcCall("account.reorder", { provider, orderedIds });
    } catch (caught) {
      console.error("[account-hub] reorder failed:", caught);
      if (!mounted.current) return;
      accountsRef.current = snapshot;
      setAccounts(snapshot);
      setReorderError(caught?.message || "顺序保存失败");
    } finally {
      if (mounted.current) setReordering(false);
    }
  };
  const computeDropOrder = (sourceId, targetId, position) => orderAfterDrop(accountsRef.current.map((account) => account.id), sourceId, targetId, position);
  const dragPropsFor = (account, index) => {
    if (accounts.length < 2) return { enabled: false };
    return {
      enabled: true,
      order: index,
      isDragging: draggingId === account.id,
      // 目标高亮只在「确实拖着一张别的卡片」时出现 —— 否则鼠标划过每张卡片
      // 都会亮插入线（dragover 之外的悬停不该有落点提示）。
      isDropTarget: dropTargetId === account.id && draggingId !== null && draggingId !== account.id,
      dropPosition,
      onDragStart: (event) => {
        setDraggingId(account.id);
        setReorderError(null);
        try {
          event.dataTransfer.setData("text/plain", account.id);
        } catch {
        }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropTargetId(null);
      },
      onDragOver: (event) => {
        if (draggingId === null || draggingId === account.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (dropTargetId !== account.id) setDropTargetId(account.id);
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const position = dropPositionFromPointer(event.clientY, rect);
        if (position !== dropPosition) setDropPosition(position);
      },
      onDrop: (event) => {
        event.preventDefault();
        const sourceId = draggingId;
        setDraggingId(null);
        setDropTargetId(null);
        if (sourceId === null || sourceId === account.id) return;
        const next = computeDropOrder(sourceId, account.id, dropPosition);
        if (next !== null) void commitOrder(next);
      }
    };
  };
  React.useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    void loadConsumption();
    if (canLoadCredits) void loadCredits();
    void loadCheckinStatus();
    return () => {
      mounted.current = false;
    };
  }, [provider]);
  React.useEffect(() => {
    if (checkinStatusLoaded && accountsLoaded) void autoCheckinOnEntry();
  }, [checkinStatusLoaded, accountsLoaded]);
  const [claiming, setClaiming] = React.useState(false);
  const [claimNotice, setClaimNotice] = React.useState(null);
  const [showModels, setShowModels] = React.useState(false);
  const claimCredits = async () => {
    if (!supportsCredits) return;
    if (claimingRef.current) return;
    claimingRef.current = true;
    setClaiming(true);
    setClaimNotice(null);
    try {
      const res = await rpcCall("checkin.perform", { provider });
      if (res?.busy) {
        if (mounted.current) setClaimNotice(CHECKIN_BUSY_NOTICE);
        return;
      }
      const notice = buildClaimNotice(res);
      if (!mounted.current) return;
      setClaimNotice(notice);
      await loadAccounts();
      await loadCredits();
      await loadCheckinStatus();
    } catch (caught) {
      console.error("[account-hub] claim credits failed:", caught);
      if (!mounted.current) return;
      setClaimNotice({ tone: "error", text: caught?.message || "领取积分失败" });
    } finally {
      claimingRef.current = false;
      if (mounted.current) setClaiming(false);
    }
  };
  const allCheckedIn = supportsCredits && accounts.length > 0 && accounts.every((a) => checkinsByAccount[a.id]?.checkedInToday === true);
  const autoCheckinOnEntry = async () => {
    if (!supportsCredits) return;
    if (autoCheckinRanRef.current) return;
    if (!accountsLoaded) return;
    if (accounts.length > 0 && accounts.every((a) => {
      const state = checkinsByAccount[a.id];
      return state?.checkedInToday === true || state?.suppressed === true;
    })) return;
    autoCheckinRanRef.current = true;
    if (claimingRef.current) return;
    claimingRef.current = true;
    if (mounted.current) setClaiming(true);
    try {
      const res = await rpcCall("checkin.perform", { provider });
      if (res?.busy) {
        console.warn("[account-hub] auto checkin skipped: another check-in is already running");
      }
    } catch (caught) {
      console.error("[account-hub] auto checkin failed:", caught);
    } finally {
      claimingRef.current = false;
      if (!mounted.current) return;
      setClaiming(false);
      try {
        await loadCheckinStatus();
      } catch {
      }
    }
  };
  const checkinAccount = async (accountId) => {
    if (!supportsCredits) return;
    if (claimingRef.current) {
      setClaimNotice(CHECKIN_BUSY_NOTICE);
      return;
    }
    claimingRef.current = true;
    setCheckinsByAccount((prev) => ({ ...prev, [accountId]: { checkedInToday: false, checking: true } }));
    try {
      const res = await rpcCall("checkin.perform", { provider, accountId });
      if (!mounted.current) return;
      if (res?.busy) {
        setCheckinsByAccount((prev) => ({ ...prev, [accountId]: { checkedInToday: false, checking: false } }));
        setClaimNotice(CHECKIN_BUSY_NOTICE);
        return;
      }
      const outcome = res?.results?.[0]?.outcome;
      const done = outcome?.kind === "claimed" || outcome?.kind === "already-claimed";
      setCheckinsByAccount((prev) => ({ ...prev, [accountId]: { checkedInToday: done, checking: false } }));
      if (outcome !== void 0 && res?.summary !== void 0) setClaimNotice(buildClaimNotice(res));
      if (canLoadCredits) void loadCredits();
    } catch (caught) {
      console.error("[account-hub] checkin failed:", caught);
      if (!mounted.current) return;
      setCheckinsByAccount((prev) => ({ ...prev, [accountId]: { checkedInToday: false, checking: false } }));
      setClaimNotice({ tone: "error", text: caught?.message || "签到失败", details: [] });
    } finally {
      claimingRef.current = false;
    }
  };
  const createAccount = async () => {
    setCreating(true);
    setManualLogin(null);
    const loginWindow = window.open("", LOGIN_WINDOW_NAME, LOGIN_WINDOW_FEATURES);
    console.log("[account-hub] account.create request, provider =", provider, "/ popup =", loginWindow);
    const closeLoginWindow = () => {
      try {
        if (loginWindow && !loginWindow.closed) loginWindow.close();
      } catch {
      }
    };
    try {
      const res = await rpcCall("account.create", { provider });
      console.log("[account-hub] account.create response =", res);
      const accountId = res?.accountId;
      const loginUrl = res?.loginUrl;
      if (!accountId) {
        closeLoginWindow();
        setError("后端返回的账号信息不完整（缺少 accountId）。");
        setPhase("error");
        return;
      }
      if (!loginUrl) {
        closeLoginWindow();
        setError("后端未返回登录地址（loginUrl 为空）。");
        setPhase("error");
        return;
      }
      if (loginWindow && !loginWindow.closed) {
        loginWindow.location.replace(loginUrl);
        console.log("[account-hub] login window navigated to", loginUrl);
      } else {
        setManualLogin({ url: loginUrl });
      }
      let pollSettled = false;
      const finishPolling = async () => {
        if (pollSettled) return;
        pollSettled = true;
        clearInterval(pollTimer);
        closeLoginWindow();
        await loadAccounts();
      };
      const pollTimer = setInterval(async () => {
        try {
          const pollRes = await rpcCall("login.poll", { accountId, provider });
          if (!pollRes.done) return;
          if (pollRes.error) {
            console.warn("[account-hub] login failed:", pollRes.error);
            if (mounted.current) {
              setProbeNotice({ tone: "error", text: `登录失败：${pollRes.error}`, details: [] });
            }
          }
          await finishPolling();
        } catch {
        }
      }, 1e3);
      setTimeout(() => {
        void finishPolling();
      }, 3e5);
    } catch (caught) {
      console.error("[account-hub] create account failed:", caught);
      closeLoginWindow();
      if (caught?.code === "login-in-progress") {
        setError(caught.message || "已有登录进行中");
      } else {
        setError("登录失败：" + (caught?.message || "未知错误"));
      }
      setPhase("error");
    } finally {
      setCreating(false);
    }
  };
  const toggleAccount = async (accountId, enabled) => {
    try {
      await rpcCall("account.update", { accountId, patch: { enabled } });
      await loadAccounts();
    } catch (caught) {
      console.error("[account-hub] toggle failed:", caught);
    }
  };
  const deleteAccount = async (accountId) => {
    setPendingDelete(accountId);
  };
  const confirmDeleteAccount = async () => {
    const accountId = pendingDelete;
    setPendingDelete(null);
    setDeleteAcknowledged(false);
    if (accountId === null) return;
    try {
      await rpcCall("account.delete", { accountId });
      await loadAccounts();
    } catch (caught) {
      console.error("[account-hub] delete failed:", caught);
    }
  };
  return React.createElement(
    "section",
    { "aria-label": "账号管理" },
    React.createElement(
      "div",
      { className: "dim-ah-panelHead" },
      React.createElement(
        "div",
        { className: "dim-ah-panelTitleRow" },
        React.createElement("h2", { className: "dim-ah-panelTitle" }, "账号管理"),
        React.createElement(
          "div",
          { className: "dim-ah-panelTitleActions" },
          React.createElement(import_dsh_client_ui_primitives.Button, {
            variant: "outline",
            size: "sm",
            className: "dim-ah-iconBtn",
            "aria-label": "模型列表",
            onClick: () => setShowModels(true)
          }, React.createElement("span", { "aria-hidden": "true" }, "☰")),
          canLoadCredits ? React.createElement(import_dsh_client_ui_primitives.Button, {
            variant: "outline",
            size: "sm",
            className: "dim-ah-iconBtn",
            "aria-label": "刷新积分",
            disabled: creditsLoading,
            onClick: () => void loadCredits()
          }, React.createElement("span", {
            className: "dim-ah-iconGlyph",
            "data-loading": creditsLoading ? "true" : void 0,
            "aria-hidden": "true"
          }, "⟳")) : null,
          supportsCredits ? React.createElement(import_dsh_client_ui_primitives.Button, {
            variant: "outline",
            size: "sm",
            className: `dim-ah-iconBtn${claiming || allCheckedIn ? "" : " dim-ah-iconBtn-light"}`,
            "aria-label": claiming ? "一键签到进行中" : allCheckedIn ? "全部已签" : "一键签到",
            disabled: claiming || accounts.length === 0 || allCheckedIn,
            onClick: () => void claimCredits()
          }, React.createElement("span", { "aria-hidden": "true" }, "✉")) : null,
          React.createElement(import_dsh_client_ui_primitives.Button, {
            variant: "outline",
            size: "sm",
            className: "dim-ah-iconBtn dim-ah-iconBtn-light",
            "aria-label": "登录账号",
            onClick: () => void createAccount(),
            disabled: creating
          }, React.createElement("span", { "aria-hidden": "true" }, "＋"))
        )
      )
    ),
    probeNotice ? React.createElement(
      "div",
      {
        className: "dim-ah-probeNotice",
        "data-tone": probeNotice.tone,
        role: "status"
      },
      React.createElement("div", null, probeNotice.text),
      probeNotice.details.length > 0 ? React.createElement(
        "ul",
        { className: "dim-ah-probeDetails" },
        probeNotice.details.map((d, i) => React.createElement("li", { key: i }, d))
      ) : null
    ) : null,
    claimNotice ? React.createElement(ClaimNotice, {
      tone: claimNotice.tone,
      text: claimNotice.text,
      details: claimNotice.details,
      // 暂不可签明细（`unavailable`）：旧通知对象没有该字段时为 undefined，
      // ClaimNotice 按「无」渲染 —— 既有路径的树逐元素不变。
      unavailableDetails: claimNotice.unavailableDetails,
      // 签到异常明细（`abnormal`，2026-09-24）：同上，缺失即按「无」渲染。
      abnormalDetails: claimNotice.abnormalDetails,
      // 无法判定明细（`undetermined`，2026-09-24）：同上。
      undeterminedDetails: claimNotice.undeterminedDetails
    }) : null,
    // 弹窗被拦截时的兜底入口。刻意**不做成按钮 + window.open(url)**：
    // 那需要在 onClick 里再开窗，而此刻用户手势是新鲜的、本可以成功 —— 但
    // 用手势内空窗的方案已经试过一次并失败了（拦截器策略），再失败一次用户
    // 就彻底没有入口。原生 <a href> 由浏览器自己处理导航，不受脚本开窗策略影响。
    manualLogin ? React.createElement(
      "div",
      { className: "dim-ah-manualLogin", role: "status" },
      React.createElement("p", null, "登录窗口被浏览器拦截了。请点击下面的链接在浏览器中完成登录："),
      React.createElement("a", {
        href: manualLogin.url,
        target: "_blank",
        rel: "noreferrer noopener"
      }, "打开登录页面")
    ) : null,
    // ── 消耗顺序 / 切换粒度 ──
    //
    // 位置：**账号卡片列表之前**（需求明确要求「面板顶部」）。两个选择器并排、
    // 各占一半宽，由样式表的 flex 决定；这里不需要任何宽度计算 —— 本节点与下面
    // 的账号区同处一个容器，宽度天然与卡片一致。
    //
    // 与账号列表的加载态无关：即使还没读到账号（loading / error / 空态），
    // 选择器也必须渲染出来（它是 provider 级配置，不依赖任何账号存在）。
    React.createElement(ConsumptionSelectors, {
      value: consumption,
      busy: consumptionBusy,
      onChange: (patch) => void updateConsumption(patch)
    }),
    phase === "loading" ? React.createElement("div", { className: "dim-ah-empty" }, "正在读取账号列表…") : phase === "error" ? React.createElement(
      "div",
      { className: "dim-ah-empty", role: "alert" },
      React.createElement("p", null, error),
      React.createElement(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", className: "dim-ah-btn-stable", onClick: loadAccounts }, "重新读取")
    ) : accounts.length === 0 ? React.createElement(
      "div",
      { className: "dim-ah-empty" },
      React.createElement("p", null, "尚未配置账号"),
      // 每个 provider（含 Qoder 两区）都是**在本面板浏览器登录**：
      // PAT 形态移除后文案只剩这一种，不再按登录形态分支。
      React.createElement("p", null, '点击"登录账号"进行浏览器登录。')
    ) : React.createElement(
      "div",
      null,
      // 排序提示整段已按用户要求删除；排序信息由卡片序号与拖拽手柄的位置表达。
      reorderError ? React.createElement("div", {
        className: "dim-ah-probeNotice",
        "data-tone": "warn",
        role: "alert"
      }, React.createElement("div", null, `顺序保存失败：${reorderError}`)) : null,
      accounts.map((account, index) => React.createElement(AccountCard, {
        key: account.id,
        account,
        index,
        // 面板级忙碌**含签到本身**（`claiming`）：一键签到或自动补签在跑时
        // 单片按钮必须 disabled，否则用户点下去只会被 `claimingRef` 挡掉
        // —— 那正是「点了没反应」的缺陷形态。`claiming` 是 state（可渲染），
        // `claimingRef` 是它的实时镜像（给闭包里的自动补签读）。
        busy: claiming,
        credits: credits[account.id],
        creditsLoading: creditsLoading && credits[account.id] === void 0,
        showCredits: canLoadCredits,
        showCheckin: supportsCredits,
        checkedIn: checkinsByAccount[account.id]?.checkedInToday === true,
        checkingThisAccount: checkinsByAccount[account.id]?.checking === true,
        onCheckin: (id) => void checkinAccount(id),
        onToggle: toggleAccount,
        onDelete: deleteAccount,
        // 提交在途时关掉拖拽，避免两次提交互相覆盖。
        drag: reordering ? { enabled: false } : dragPropsFor(account, index)
      }))
    ),
    // 模型列表以 modal 渲染：它是覆盖层，放在账号区之后只是组件树的书写顺序，
    // 实际由 `Modal` 原语 portal 到 body、浮在整个面板之上，不挤占账号池的版面。
    showModels ? React.createElement(ModelListPanel, {
      provider,
      rpcCall,
      onClose: () => setShowModels(false)
    }) : null,
    // 删除账号的确认弹窗（取代原生 `confirm()`）。它同样由 `RiskConfirmation`
    // portal 到 body，故渲染位置只影响组件树的书写顺序。
    //
    // ⚠️ 弹窗**不阻塞** `deleteAccount` 的调用：它现在只把待确认状态置位就返回，
    // 真正的 RPC 由弹窗的确认回调触发。
    pendingDelete !== null ? React.createElement(import_dsh_client_ui_primitives.RiskConfirmation, {
      open: true,
      title: "删除账号",
      description: "确认删除此账号？关联的凭据也将被清除。",
      acknowledgeLabel: "我了解关联的凭据也会被清除",
      cancelLabel: "取消",
      closeLabel: "取消删除",
      confirmLabel: "删除",
      acknowledged: deleteAcknowledged,
      onAcknowledgedChange: setDeleteAcknowledged,
      onCancel: () => {
        setPendingDelete(null);
        setDeleteAcknowledged(false);
      },
      onConfirm: () => void confirmDeleteAccount()
    }) : null
  );
}
var AUTO_ROUTE_TAB_ID = "auto-route";
var AUTO_ROUTE_LABEL = "自动路由";
var AUTO_ROUTE_SWITCH_HELP = "开启后「自动路由」出现在 DSH 模型列表，其它 provider 从列表隐藏";
var AUTO_ROUTE_EFFORT_NONE_HELP = "该模型无思考档位";
var AUTO_ROUTE_EFFORT_LOADING_HELP = "正在加载思考档位…";
var AUTO_ROUTE_PROVIDER_FIRST_HELP = "先选供应商，再选它下面的模型";
var AUTO_ROUTE_MODEL_FIRST_HELP = "先选模型，再选它的思考档位";
var AUTO_ROUTE_DEFAULT_EFFORT = "";
var AUTO_ROUTE_DEFAULT_EFFORT_LABEL = "默认";
var AUTO_ROUTE_UA_UNKNOWN_PLACEHOLDER = "该供应商无已知默认 UA";
var AUTO_ROUTE_ORIGINATOR_PLACEHOLDER = "默认不发此头";
var AUTO_ROUTE_MASQUERADE_OFF = "";
var AUTO_ROUTE_MASQUERADE_CODEX = "codex";
var AUTO_ROUTE_MASQUERADE_CUSTOM = "custom";
var AUTO_ROUTE_MASQUERADE_OFF_LABEL = "关闭";
var AUTO_ROUTE_MASQUERADE_CODEX_LABEL = "Codex 客户端";
var AUTO_ROUTE_MASQUERADE_CUSTOM_LABEL = "自定义";
var AUTO_ROUTE_CODEX_UA = "codex_exec/0.153.4 (Windows 10.0.26200; x86_64) dumb (codex_exec; 0.153.4)";
var AUTO_ROUTE_CODEX_ORIGINATOR = "codex_exec";
var AUTO_ROUTE_MASQUERADE_PLACEHOLDER = "默认关闭（不伪装）";
var AUTO_ROUTE_MASQUERADE_READY = "出站伪装已就绪";
function autoRouteMasqueradePresetOf(entry) {
  const userAgent = typeof entry?.userAgent === "string" ? entry.userAgent : "";
  const originator = typeof entry?.originator === "string" ? entry.originator : "";
  const windowId = typeof entry?.masquerade?.windowId === "string" ? entry.masquerade.windowId : "";
  if (userAgent === AUTO_ROUTE_CODEX_UA && originator === AUTO_ROUTE_CODEX_ORIGINATOR && windowId !== "") {
    return AUTO_ROUTE_MASQUERADE_CODEX;
  }
  if (userAgent === "" && originator === "" && windowId === "") return AUTO_ROUTE_MASQUERADE_OFF;
  return AUTO_ROUTE_MASQUERADE_CUSTOM;
}
function newAutoRouteMasqueradeWindowId() {
  const webCrypto = typeof crypto !== "undefined" ? crypto : void 0;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const random = Math.floor(Math.random() * 16);
    const value = ch === "x" ? random : random & 3 | 8;
    return value.toString(16);
  });
}
function autoRouteMasqueradeBadgeOf(status) {
  if (!status || typeof status !== "object") return null;
  if (status.available !== true) return null;
  return { tone: "success", text: AUTO_ROUTE_MASQUERADE_READY };
}
var autoRouteIdSeed = 0;
function newAutoRouteDefinitionId() {
  autoRouteIdSeed += 1;
  return `auto-${Date.now().toString(36)}-${autoRouteIdSeed}`;
}
function nextAutoRouteDefinitionName(definitions) {
  const used = new Set((definitions || []).map((definition) => definition.name));
  let index = (definitions || []).length + 1;
  while (used.has(`自动模型 ${index}`)) index += 1;
  return `自动模型 ${index}`;
}
function autoRouteEffortKey(provider, model) {
  return `${provider}\0${model}`;
}
function AutoRouteSelect({ label, options, value, busy, disabled, fallback, tooltip, onSelect }) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((option) => option.id === value);
  const items = options.map((option) => ({
    id: option.id,
    label: option.label,
    disabled: option.disabled === true
  }));
  return withHoverTitle(React.createElement(import_dsh_client_ui_primitives.Menu, {
    open,
    // 锚点与其它两处下拉共用宿主同款胶囊（见 ConsumptionSelect 处的说明）；
    // 宽度由 .dim-ah-arEntryRow 的后代规则钉满栅格列。
    anchor: React.createElement(
      "button",
      {
        type: "button",
        className: "dim-ah-selectAnchor",
        // 可读名只来自这里（界面上三档下拉的可见文案只有当前值）。
        "aria-label": label,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        disabled: busy || disabled === true,
        onClick: () => setOpen((prev) => !prev)
      },
      current ? current.label : value || fallback,
      React.createElement(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: "dim-ah-selectAnchorChevron" })
    ),
    items,
    // 空串（「默认」/未选）不进 selectedId：`Menu` 的 undefined 才是「没有选中项」。
    selectedId: value || void 0,
    onSelect: (id) => {
      setOpen(false);
      onSelect(id);
    },
    onClose: () => setOpen(false),
    align: "start",
    /**
     * ⚠️ **必须 portal**：候选编辑弹窗的正文容器带 `overflow-y: auto`，内联渲染的
     * 弹层一旦越出正文盒就被裁掉（用户真机反馈：「下拉菜单被弹窗边界截断」）。
     * `portal: true` 让 `Menu` 把列表挂到 `document.body` 并改用 fixed 定位
     * （`Menu.module.css` 的 `.portal` 以 z-index 1100 压在弹窗遮罩的 1000 之上，
     * 正是为「弹窗内的锚点」准备的），从而彻底脱离弹窗的裁剪上下文。
     * 宿主设置页四处下拉全是这个写法（见 PreferenceRow 的 `portal`）。
     * `align: 'start'` 保留：portal 下对齐由定位数学读同一个 prop 决定，两者不冲突。
     */
    portal: true
  }), tooltip);
}
function AutoRouteEntryRow({
  entry,
  index,
  catalog,
  busy,
  drag,
  onNeedEffort,
  onRemove,
  onEdit
}) {
  const providerGroup = catalog.find((group) => group.id === entry.provider);
  const providerLabel = PROVIDERS.find((p) => p.id === entry.provider)?.label || (providerGroup ? providerGroup.name : entry.provider);
  const description = entry.provider === "" ? "选择供应商" : entry.model === "" ? "选择模型" : `${entry.model}${entry.effort ? `(${entry.effort})` : ""}-${providerLabel}`;
  const placeholder = entry.provider === "" || entry.model === "";
  React.useEffect(() => {
    onNeedEffort(entry.provider, entry.model);
  }, [entry.provider, entry.model]);
  return React.createElement(
    "div",
    {
      className: "dim-ah-arEntryRow",
      "data-ar-entry": index,
      "data-dragging": drag.isDragging ? "true" : void 0,
      "data-dropBefore": drag.isDropTarget && drag.dropPosition !== "after" ? "true" : void 0,
      "data-dropAfter": drag.isDropTarget && drag.dropPosition === "after" ? "true" : void 0,
      "data-drag-enabled": drag.enabled ? "true" : "false",
      draggable: drag.enabled ? "true" : void 0,
      onDragStart: drag.onDragStart,
      onDragEnd: drag.onDragEnd,
      onDragOver: drag.onDragOver,
      onDrop: drag.onDrop
    },
    drag.enabled ? React.createElement("span", {
      className: "dim-ah-dragHandle",
      "aria-hidden": "true"
    }, "⠿") : null,
    React.createElement("button", {
      type: "button",
      className: "dim-ah-arEntryText",
      "data-placeholder": placeholder ? "true" : void 0,
      "aria-label": `编辑候选 ${index + 1}：${description}`,
      disabled: busy,
      onClick: () => onEdit(index)
    }, description),
    React.createElement(import_dsh_client_ui_primitives.Button, {
      variant: "outline",
      size: "sm",
      className: "dim-ah-btn-danger",
      disabled: busy,
      onClick: () => onRemove(index)
    }, "删除")
  );
}
function AutoRouteEntryEditor({
  entry,
  index,
  catalog,
  effortInfo,
  busy,
  masqueradeStatus,
  onSelectField,
  onClose
}) {
  const providerGroup = catalog.find((group) => group.id === entry.provider);
  const providerOptions = catalog.map((group) => ({ id: group.id, label: group.name }));
  const modelOptions = (providerGroup ? providerGroup.models : []).map((model) => ({ id: model.id, label: model.name }));
  const efforts = effortInfo && Array.isArray(effortInfo.efforts) ? effortInfo.efforts : [];
  const effortLoading = effortInfo !== void 0 && effortInfo.loading === true;
  const noEfforts = effortInfo !== void 0 && !effortLoading && efforts.length === 0;
  const defaultEffortHint = effortInfo && typeof effortInfo.defaultEffort === "string" ? `不指定档位，用该模型的默认档（${effortInfo.defaultEffort}）` : "不指定档位，用该模型的默认档";
  const effortOptions = [{
    id: AUTO_ROUTE_DEFAULT_EFFORT,
    label: withHoverTitle(React.createElement("span", null, AUTO_ROUTE_DEFAULT_EFFORT_LABEL), defaultEffortHint)
  }].concat(efforts.map((effort) => ({ id: effort, label: effort })));
  const effortTooltip = noEfforts ? AUTO_ROUTE_EFFORT_NONE_HELP : effortLoading ? AUTO_ROUTE_EFFORT_LOADING_HELP : entry.model ? void 0 : AUTO_ROUTE_MODEL_FIRST_HELP;
  const userAgent = typeof entry.userAgent === "string" ? entry.userAgent : "";
  const defaultUserAgent = effortInfo && typeof effortInfo.defaultUserAgent === "string" ? effortInfo.defaultUserAgent : "";
  const uaPlaceholder = defaultUserAgent !== "" ? defaultUserAgent : AUTO_ROUTE_UA_UNKNOWN_PLACEHOLDER;
  const originator = typeof entry.originator === "string" ? entry.originator : "";
  const masqueradePreset = autoRouteMasqueradePresetOf(entry);
  const masqueradeBadge = autoRouteMasqueradeBadgeOf(masqueradeStatus);
  const masqueradeOptions = [
    { id: AUTO_ROUTE_MASQUERADE_OFF, label: AUTO_ROUTE_MASQUERADE_OFF_LABEL },
    { id: AUTO_ROUTE_MASQUERADE_CODEX, label: AUTO_ROUTE_MASQUERADE_CODEX_LABEL },
    { id: AUTO_ROUTE_MASQUERADE_CUSTOM, label: AUTO_ROUTE_MASQUERADE_CUSTOM_LABEL }
  ];
  const fieldRow = (label, select) => React.createElement(
    "div",
    { className: "dim-ah-arEditorRow" },
    React.createElement("span", { className: "dim-ah-arEditorLabel" }, label),
    select
  );
  return React.createElement(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: "编辑候选",
      closeLabel: "关闭编辑候选",
      className: "dim-ah-modal"
    },
    React.createElement(
      "div",
      { className: "dim-ah-arEditor" },
      fieldRow("供应商", React.createElement(AutoRouteSelect, {
        label: "候选供应商",
        options: providerOptions,
        value: entry.provider,
        busy,
        fallback: "选择供应商",
        onSelect: (id) => onSelectField("provider", id)
      })),
      fieldRow("模型", React.createElement(AutoRouteSelect, {
        label: "候选模型",
        options: modelOptions,
        value: entry.model,
        busy,
        disabled: entry.provider === "",
        fallback: "选择模型",
        tooltip: entry.provider === "" ? AUTO_ROUTE_PROVIDER_FIRST_HELP : void 0,
        onSelect: (id) => onSelectField("model", id)
      })),
      fieldRow("思考程度", React.createElement(AutoRouteSelect, {
        label: "思考程度",
        options: effortOptions,
        value: entry.effort === void 0 ? AUTO_ROUTE_DEFAULT_EFFORT : entry.effort,
        busy,
        disabled: entry.model === "" || noEfforts || effortLoading,
        fallback: AUTO_ROUTE_DEFAULT_EFFORT_LABEL,
        tooltip: effortTooltip,
        onSelect: (id) => onSelectField("effort", id)
      })),
      // 第四行：User-Agent 覆写（label + 单行输入 + 重置按钮，布局见 .dim-ah-arEditorUaRow）。
      React.createElement(
        "div",
        { className: "dim-ah-arEditorUaRow" },
        React.createElement("span", { className: "dim-ah-arEditorLabel" }, "User-Agent"),
        React.createElement(import_dsh_client_ui_primitives.Input, {
          className: "dim-ah-arEditorUaInput",
          value: userAgent,
          // 可读名走 aria-label：placeholder 是给眼睛看的默认值，不能拿它当名称
          // （它随 provider 变化，读屏用户听到的会是「一个 UA 字符串」而不是字段名）。
          "aria-label": "User-Agent",
          placeholder: uaPlaceholder,
          // 空串 = 回默认（setEntryField 把键摘掉），故「清空输入框」与「点重置」同义。
          onChange: (event) => onSelectField("userAgent", event?.target?.value ?? "")
        }),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "ghost",
          size: "sm",
          className: "dim-ah-iconBtn",
          "aria-label": "重置 User-Agent",
          // 未覆写时无处可重置（值已经是默认）：禁用，而不是点了没反应。
          disabled: busy || userAgent === "",
          onClick: () => onSelectField("userAgent", "")
        }, "⟲")
      ),
      // 第五行：Originator 覆写（结构逐字对齐上面的 UA 行，布局见 .dim-ah-arEditorOriginatorRow）。
      // ⚠️ 唯一实质差异在 placeholder：它是**固定一句**「默认不发此头」，不读 effortInfo ——
      // 这个头在七家上游协议里都不存在，没有默认值可显示（见 AUTO_ROUTE_ORIGINATOR_PLACEHOLDER）。
      React.createElement(
        "div",
        { className: "dim-ah-arEditorOriginatorRow" },
        React.createElement("span", { className: "dim-ah-arEditorLabel" }, "Originator"),
        React.createElement(import_dsh_client_ui_primitives.Input, {
          className: "dim-ah-arEditorOriginatorInput",
          value: originator,
          // 可读名走 aria-label（与 UA 行同因：placeholder 是提示，不能拿它当字段名）。
          "aria-label": "Originator",
          placeholder: AUTO_ROUTE_ORIGINATOR_PLACEHOLDER,
          // 空串 = 清字段（setEntryField 把键摘掉）= 回默认不发，故「清空输入框」与「点重置」同义。
          onChange: (event) => onSelectField("originator", event?.target?.value ?? "")
        }),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "ghost",
          size: "sm",
          className: "dim-ah-iconBtn",
          "aria-label": "重置 Originator",
          // 未覆写时无处可重置（本来就不发这个头）：禁用，而不是点了没反应。
          disabled: busy || originator === "",
          onClick: () => onSelectField("originator", "")
        }, "⟲")
      ),
      /**
       * 第六行：客户端伪装（**本组三行的总控**，故排在 UA / Originator 之后）。
       *
       * 本行是「一键填官方真值」的**宏**，不是独立存储字段：下拉当前态由 UA / Originator
       * / windowId 三样实际值现算（见 {@link autoRouteMasqueradePresetOf}），预设名永不
       * 落盘。选「Codex 客户端」只是把官方 UA 与 originator 填进上面两格 + 生成一枚
       * windowId；两格填完仍**可编辑**（不锁只读、无回退按钮），用户一改就靠推导自动
       * 切回「自定义」。
       *
       * ⚠️ windowId **在界面上完全不可见**（没有输入框、没有按钮、没有提示）：它是
       * 「同一个会话窗口」的标识，暴露出来只会诱导用户手改成一个上游没见过的值。它由
       * `setEntryField` 在选预设时生成 / 复用并直接写进条目。
       *
       * ⚠️ 徽标是**旁路信息**（来自 `masquerade.status`），未就绪或查询失败时整块不渲染
       * ——查不到出站通道状态绝不该让编辑弹窗看起来像出错了。
       */
      React.createElement(
        "div",
        { className: "dim-ah-arEditorMasqueradeRow" },
        React.createElement("span", { className: "dim-ah-arEditorLabel" }, "客户端伪装"),
        React.createElement(AutoRouteSelect, {
          label: "客户端伪装",
          options: masqueradeOptions,
          value: masqueradePreset,
          busy,
          // 当前态恒是三者之一，fallback 只是「选项集意外不匹配」时的兜底文案。
          fallback: AUTO_ROUTE_MASQUERADE_PLACEHOLDER,
          onSelect: (id) => onSelectField("masqueradePreset", id)
        }),
        masqueradeBadge === null ? null : React.createElement(import_dsh_client_ui_primitives.Tag, {
          // tone 取 primitives 的既有词表（success / neutral / warning），与
          // `data-tone` 那套（ok / warn / error / muted）是两套东西，不要混用。
          tone: masqueradeBadge.tone,
          className: "dim-ah-arEditorMasqueradeBadge"
        }, masqueradeBadge.text)
      )
    )
  );
}
function AutoRoutePanel({ rpcCall }) {
  const [phase, setPhase] = React.useState("loading");
  const [loadError, setLoadError] = React.useState(null);
  const [enabled, setEnabled] = React.useState(false);
  const [switchBusy, setSwitchBusy] = React.useState(false);
  const [draft, setDraft] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const [catalog, setCatalog] = React.useState([]);
  const [catalogError, setCatalogError] = React.useState(null);
  const [efforts, setEfforts] = React.useState({});
  const [masqueradeStatus, setMasqueradeStatus] = React.useState(null);
  const [pendingDelete, setPendingDelete] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [editingName, setEditingName] = React.useState(null);
  const [expandedDefIds, setExpandedDefIds] = React.useState(() => /* @__PURE__ */ new Set());
  const [drag, setDrag] = React.useState(null);
  const mounted = React.useRef(true);
  const draftRef = React.useRef([]);
  const saveQueueRef = React.useRef({ tail: Promise.resolve(), pending: 0 });
  const effortsRef = React.useRef({});
  const loadConfig = React.useCallback(async () => {
    setPhase("loading");
    setLoadError(null);
    try {
      const res = await rpcCall("autoroute.get", {});
      if (!mounted.current) return;
      setEnabled(res?.enabled === true);
      setDraft(Array.isArray(res?.models) ? res.models : []);
      setPhase("ready");
    } catch (caught) {
      if (!mounted.current) return;
      setLoadError(caught?.message || "无法读取自动路由配置");
      setPhase("error");
    }
  }, [rpcCall]);
  const loadCatalog = React.useCallback(async () => {
    setCatalogError(null);
    try {
      const res = await rpcCall("autoroute.catalog", {});
      if (!mounted.current) return;
      setCatalog(Array.isArray(res?.providers) ? res.providers : []);
    } catch (caught) {
      console.warn("[account-hub] load auto-route catalog failed:", caught);
      if (!mounted.current) return;
      setCatalogError(caught?.message || "无法读取模型目录");
    }
  }, [rpcCall]);
  const loadMasqueradeStatus = React.useCallback(async () => {
    try {
      const res = await rpcCall("masquerade.status", {});
      if (!mounted.current) return;
      setMasqueradeStatus(res ?? null);
    } catch (caught) {
      console.warn("[account-hub] load masquerade status failed:", caught);
    }
  }, [rpcCall]);
  const requestEfforts = React.useCallback((provider, model) => {
    if (typeof provider !== "string" || provider.length === 0) return;
    if (typeof model !== "string" || model.length === 0) return;
    const key = autoRouteEffortKey(provider, model);
    if (Object.prototype.hasOwnProperty.call(effortsRef.current, key)) return;
    effortsRef.current[key] = { loading: true, efforts: [] };
    setEfforts({ ...effortsRef.current });
    rpcCall("autoroute.model-info", { provider, model }).then((res) => {
      if (!mounted.current) return;
      const info = { loading: false, efforts: Array.isArray(res?.efforts) ? res.efforts : [] };
      if (typeof res?.defaultEffort === "string") info.defaultEffort = res.defaultEffort;
      if (typeof res?.defaultUserAgent === "string" && res.defaultUserAgent !== "") {
        info.defaultUserAgent = res.defaultUserAgent;
      }
      effortsRef.current[key] = info;
      setEfforts({ ...effortsRef.current });
    }).catch((caught) => {
      console.warn("[account-hub] load auto-route model info failed:", caught);
      if (!mounted.current) return;
      effortsRef.current[key] = { loading: false, efforts: [] };
      setEfforts({ ...effortsRef.current });
    });
  }, [rpcCall]);
  React.useEffect(() => {
    mounted.current = true;
    void loadConfig();
    void loadCatalog();
    void loadMasqueradeStatus();
    return () => {
      mounted.current = false;
    };
  }, []);
  const toggleEnabled = async (next) => {
    setSwitchBusy(true);
    setSaveError(null);
    try {
      const res = await rpcCall("autoroute.set", { enabled: next });
      if (!mounted.current) return;
      setEnabled(res?.enabled === true);
    } catch (caught) {
      console.error("[account-hub] update auto-route enabled failed:", caught);
      if (!mounted.current) return;
      setSaveError(caught?.message || "切换自动路由开关失败");
    } finally {
      if (mounted.current) setSwitchBusy(false);
    }
  };
  const saveModels = (nextDraft) => {
    const submittable = Array.isArray(nextDraft) && nextDraft.length >= 0 && nextDraft.every((def) => def && typeof def.name === "string" && Array.isArray(def.entries) && def.entries.length > 0 && def.entries.every((entry) => entry && typeof entry.provider === "string" && entry.provider !== "" && typeof entry.model === "string" && entry.model !== ""));
    if (!submittable) return;
    const queue = saveQueueRef.current;
    queue.pending += 1;
    if (queue.pending === 1) setSaving(true);
    setSaveError(null);
    const saveOne = async () => {
      try {
        const res = await rpcCall("autoroute.set", { models: nextDraft });
        if (!mounted.current) return;
        const current = draftRef.current;
        if (JSON.stringify(current) === JSON.stringify(nextDraft)) {
          setDraft(Array.isArray(res?.models) ? res.models : nextDraft);
        }
      } catch (caught) {
        console.error("[account-hub] save auto-route models failed:", caught);
        if (!mounted.current) return;
        setSaveError(caught?.message || "保存失败");
      } finally {
        queue.pending -= 1;
        if (mounted.current && queue.pending === 0) setSaving(false);
      }
    };
    queue.tail = queue.tail.then(saveOne, saveOne).catch(() => {
    });
  };
  const editDraft = (updater) => {
    const next = typeof updater === "function" ? updater(draft) : updater;
    draftRef.current = next;
    setDraft(next);
    setSaveError(null);
    void saveModels(next);
  };
  const addDefinition = () => {
    editDraft((prev) => [...prev, {
      id: newAutoRouteDefinitionId(),
      name: nextAutoRouteDefinitionName(prev),
      // entries 为空是**允许的草稿态**：保存时会被服务端拒并给出点名错误，
      // 前端刻意不拦（用户需要先加卡片、再逐条加候选）。
      entries: []
    }]);
  };
  const renameDefinition = (defId, name2) => {
    editDraft((prev) => prev.map((def) => def.id === defId ? { ...def, name: name2 } : def));
  };
  const removeDefinition = (defId) => {
    editDraft((prev) => prev.filter((def) => def.id !== defId));
    setExpandedDefIds((prev) => {
      if (!prev.has(defId)) return prev;
      const next = new Set(prev);
      next.delete(defId);
      return next;
    });
    if (editingName?.defId === defId) setEditingName(null);
  };
  const toggleDefinition = (defId) => setExpandedDefIds((prev) => {
    const next = new Set(prev);
    if (next.has(defId)) next.delete(defId);
    else next.add(defId);
    return next;
  });
  const addEntry = (defId) => {
    editDraft((prev) => prev.map((def) => def.id === defId ? { ...def, entries: [...def.entries, { provider: "", model: "" }] } : def));
  };
  const removeEntry = (defId, index) => {
    editDraft((prev) => prev.map((def) => def.id === defId ? { ...def, entries: def.entries.filter((_, i) => i !== index) } : def));
  };
  const setEntryField = (defId, index, field, value) => {
    let masqueradeWindowId = "";
    if (field === "masqueradePreset" && value === AUTO_ROUTE_MASQUERADE_CODEX) {
      const def = draft.find((item) => item.id === defId);
      const current = def ? def.entries[index] : void 0;
      const existing = current && typeof current.masquerade?.windowId === "string" ? current.masquerade.windowId : "";
      masqueradeWindowId = existing !== "" ? existing : newAutoRouteMasqueradeWindowId();
    }
    editDraft((prev) => prev.map((def) => {
      if (def.id !== defId) return def;
      return {
        ...def,
        entries: def.entries.map((entry, i) => {
          if (i !== index) return entry;
          if (field === "masqueradePreset") {
            if (value === AUTO_ROUTE_MASQUERADE_OFF) {
              const cleared = { ...entry };
              delete cleared.userAgent;
              delete cleared.originator;
              delete cleared.masquerade;
              return cleared;
            }
            if (value === AUTO_ROUTE_MASQUERADE_CUSTOM) return entry;
            return {
              ...entry,
              userAgent: AUTO_ROUTE_CODEX_UA,
              originator: AUTO_ROUTE_CODEX_ORIGINATOR,
              masquerade: { windowId: masqueradeWindowId }
            };
          }
          if (field === "provider") return { provider: value, model: "" };
          if (field === "model") return { provider: entry.provider, model: value };
          if (field === "userAgent") {
            if (value !== "") return { ...entry, userAgent: value };
            const withoutUa = { ...entry };
            delete withoutUa.userAgent;
            return withoutUa;
          }
          if (field === "originator") {
            if (value !== "") return { ...entry, originator: value };
            const withoutOriginator = { ...entry };
            delete withoutOriginator.originator;
            return withoutOriginator;
          }
          if (value === AUTO_ROUTE_DEFAULT_EFFORT) {
            const withoutEffort = { ...entry };
            delete withoutEffort.effort;
            return withoutEffort;
          }
          return { ...entry, effort: value };
        })
      };
    }));
  };
  const applyDefinitionOrder = (orderedIds) => {
    const byId = new Map(draft.map((def) => [def.id, def]));
    const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    if (next.length !== draft.length) return;
    editDraft(() => next);
  };
  const applyEntryOrder = (defId, orderedIndexes) => {
    editDraft((prev) => prev.map((def) => {
      if (def.id !== defId) return def;
      const next = orderedIndexes.map((position) => def.entries[Number(position)]).filter(Boolean);
      if (next.length !== def.entries.length) return def;
      return { ...def, entries: next };
    }));
  };
  const dragPropsFor = (kind, defId, key, count) => {
    if (count < 2) return { enabled: false };
    const active = drag !== null && drag.kind === kind && drag.defId === defId;
    return {
      enabled: true,
      isDragging: active && drag.sourceKey === key,
      isDropTarget: active && drag.targetKey === key && drag.sourceKey !== key,
      dropPosition: drag === null ? "before" : drag.position,
      onDragStart: (event) => {
        if (kind === "entry") event.stopPropagation?.();
        setDrag({ kind, defId, sourceKey: key, targetKey: null, position: "before" });
        try {
          event.dataTransfer.setData("text/plain", String(key));
        } catch {
        }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: (event) => {
        if (kind === "entry") event.stopPropagation?.();
        setDrag(null);
      },
      onDragOver: (event) => {
        if (kind === "entry") event.stopPropagation?.();
        if (drag === null || drag.kind !== kind || drag.defId !== defId) return;
        if (drag.sourceKey === key) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        if (drag.targetKey !== key) setDrag({ ...drag, targetKey: key });
        const rect = event.currentTarget?.getBoundingClientRect?.();
        const position = dropPositionFromPointer(event.clientY, rect);
        if (position !== drag.position) setDrag({ ...drag, targetKey: key, position });
      },
      onDrop: (event) => {
        if (kind === "entry") event.stopPropagation?.();
        event.preventDefault();
        if (drag === null || drag.kind !== kind || drag.defId !== defId) return;
        const sourceKey = drag.sourceKey;
        const position = drag.position;
        setDrag(null);
        if (sourceKey === key) return;
        if (kind === "def") {
          const next2 = orderAfterDrop(draft.map((def2) => def2.id), sourceKey, key, position);
          if (next2 !== null) applyDefinitionOrder(next2);
          return;
        }
        const def = draft.find((item) => item.id === defId);
        if (def === void 0) return;
        const next = orderAfterDrop(def.entries.map((_, i) => String(i)), sourceKey, key, position);
        if (next !== null) applyEntryOrder(defId, next);
      }
    };
  };
  const renderDefinition = (def) => {
    const cardDrag = dragPropsFor("def", null, def.id, draft.length);
    const isOpen = expandedDefIds.has(def.id);
    const nameLabel = def.name === "" ? "（未命名）" : def.name;
    return React.createElement(
      "div",
      {
        key: def.id,
        className: "dim-ah-arCard",
        "data-ar-def": def.id,
        "data-dragging": cardDrag.isDragging ? "true" : void 0,
        "data-dropBefore": cardDrag.isDropTarget && cardDrag.dropPosition !== "after" ? "true" : void 0,
        "data-dropAfter": cardDrag.isDropTarget && cardDrag.dropPosition === "after" ? "true" : void 0,
        draggable: cardDrag.enabled ? "true" : void 0,
        "data-drag-enabled": cardDrag.enabled ? "true" : "false",
        onDragStart: cardDrag.onDragStart,
        onDragEnd: cardDrag.onDragEnd,
        onDragOver: cardDrag.onDragOver,
        onDrop: cardDrag.onDrop
      },
      React.createElement(
        "div",
        { className: "dim-ah-arCardHead", "data-drag-enabled": cardDrag.enabled ? "true" : "false" },
        cardDrag.enabled ? React.createElement("span", {
          className: "dim-ah-dragHandle",
          "aria-hidden": "true"
        }, "⠿") : null,
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "ghost",
          size: "sm",
          className: "dim-ah-arNameButton",
          "aria-label": `编辑自动模型名称：${nameLabel}`,
          disabled: saving,
          onClick: () => setEditingName({ defId: def.id })
        }, nameLabel),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "ghost",
          size: "sm",
          className: "dim-ah-arFoldButton",
          "aria-expanded": isOpen,
          "aria-label": isOpen ? "折叠候选模型列表" : "展开候选模型列表",
          "data-open": isOpen ? "1" : "0",
          onClick: () => toggleDefinition(def.id)
        }, React.createElement(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: 14 })),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "outline",
          size: "sm",
          className: "dim-ah-btn-danger",
          disabled: saving,
          onClick: () => setPendingDelete(def.id)
        }, "删除")
      ),
      isOpen ? React.createElement(
        "div",
        { className: "dim-ah-arEntries" },
        def.entries.map((entry, entryIndex) => React.createElement(AutoRouteEntryRow, {
          key: entryIndex,
          entry,
          index: entryIndex,
          catalog,
          busy: saving,
          drag: dragPropsFor("entry", def.id, String(entryIndex), def.entries.length),
          // 档位拉取留在行上（见 AutoRouteEntryRow 的说明）；三个下拉的挂载点是弹窗。
          onNeedEffort: requestEfforts,
          onEdit: (rowIndex) => setEditing({ defId: def.id, index: rowIndex }),
          onRemove: (rowIndex) => removeEntry(def.id, rowIndex)
        })),
        React.createElement(
          "div",
          { className: "dim-ah-arAddEntry" },
          React.createElement(
            import_dsh_client_ui_primitives.Button,
            {
              variant: "outline",
              className: "dim-ah-arAddButton",
              disabled: saving,
              onClick: () => addEntry(def.id)
            },
            React.createElement(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }),
            "添加候选模型"
          )
        )
      ) : null
    );
  };
  const pendingDefinition = pendingDelete === null ? null : draft.find((def) => def.id === pendingDelete) || null;
  const editingEntry = editing === null ? null : (() => {
    const def = draft.find((item) => item.id === editing.defId);
    const entry = def ? def.entries[editing.index] : void 0;
    return entry === void 0 ? null : { defId: editing.defId, index: editing.index, entry };
  })();
  const editingDefinition = editingName === null ? null : draft.find((def) => def.id === editingName.defId) || null;
  return React.createElement(
    "section",
    { className: "dim-ah-arPage", "aria-label": "自动路由配置" },
    React.createElement(
      "div",
      { className: "dim-ah-arHead" },
      React.createElement("h2", { className: "dim-ah-arTitle" }, "自动路由"),
      withHoverTitle(React.createElement(import_dsh_client_ui_primitives.Switch, {
        checked: enabled,
        // 空列表时禁用：打开开关会把七个 provider 从 DSH 模型列表里隐藏，而自动路由
        // 自己又没有模型可暴露 ⇒ 一个分组都不剩。开关仍可点（宿主会照常接受）但结果
        // 是用户看不懂的空列表，故在源头挡住；开关提示统一保留指定的简短说明。
        disabled: switchBusy || draft.length === 0,
        label: "启用自动路由",
        onChange: (next) => void toggleEnabled(next)
      }), AUTO_ROUTE_SWITCH_HELP)
    ),
    loadError !== null ? React.createElement(
      "div",
      { className: "dim-ah-arError", role: "alert" },
      React.createElement("span", null, loadError),
      React.createElement(import_dsh_client_ui_primitives.Button, {
        variant: "outline",
        size: "sm",
        className: "dim-ah-btn-stable",
        onClick: () => void loadConfig()
      }, "重新读取")
    ) : null,
    // 保存失败的服务端消息：点名到具体定义与字段，故整行原样显示。
    saveError !== null ? React.createElement("div", { className: "dim-ah-arError", role: "alert" }, saveError) : null,
    // 目录拉取失败：编辑器的三个下拉会全空，必须说清原因并给一条恢复路径。
    catalogError !== null ? React.createElement(
      "div",
      { className: "dim-ah-arError", role: "alert" },
      React.createElement("span", null, catalogError),
      React.createElement(import_dsh_client_ui_primitives.Button, {
        variant: "outline",
        size: "sm",
        className: "dim-ah-btn-stable",
        onClick: () => void loadCatalog()
      }, "重试")
    ) : null,
    phase === "loading" ? React.createElement("div", { className: "dim-ah-arEmpty" }, "正在读取自动路由配置…") : draft.length === 0 ? React.createElement(
      "div",
      { className: "dim-ah-arEmpty" },
      React.createElement("p", null, "尚未配置自动模型"),
      React.createElement("p", null, "自动模型是一个暴露给 DSH 的模型名，背后是一串按顺序降级的候选。")
    ) : React.createElement("div", { className: "dim-ah-arList" }, draft.map(renderDefinition)),
    phase === "loading" ? null : React.createElement(
      "div",
      { className: "dim-ah-arAddDefinition" },
      React.createElement(
        import_dsh_client_ui_primitives.Button,
        {
          variant: "outline",
          className: "dim-ah-arAddButton",
          onClick: addDefinition
        },
        React.createElement(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }),
        "添加自动模型"
      )
    ),
    // 删除定义的确认弹窗（单条定义属轻量破坏，二键确认即可，不用勾选闸）。
    pendingDefinition !== null ? React.createElement(import_dsh_client_ui_primitives.Modal, {
      open: true,
      onClose: () => setPendingDelete(null),
      title: "删除自动模型",
      closeLabel: "取消删除",
      description: `确认删除自动模型『${pendingDefinition.name}』？它的 ${pendingDefinition.entries.length} 条候选将一并移除。`,
      footer: [
        React.createElement(import_dsh_client_ui_primitives.Button, {
          key: "cancel",
          variant: "outline",
          onClick: () => setPendingDelete(null)
        }, "取消"),
        React.createElement(import_dsh_client_ui_primitives.Button, {
          key: "confirm",
          variant: "primary",
          className: "dim-ah-btn-stable",
          onClick: () => {
            setPendingDelete(null);
            removeDefinition(pendingDefinition.id);
          }
        }, "删除")
      ]
    }) : null,
    // 自动模型名称编辑弹窗：与候选编辑弹窗独立，修改即保存，关闭即完成。
    editingDefinition !== null ? React.createElement(
      import_dsh_client_ui_primitives.Modal,
      {
        open: true,
        onClose: () => setEditingName(null),
        title: "重命名自动模型",
        closeLabel: "关闭重命名自动模型",
        className: "dim-ah-modal"
      },
      React.createElement(import_dsh_client_ui_primitives.Input, {
        className: "dim-ah-arNameInput",
        value: editingDefinition.name,
        "aria-label": "自动模型名称",
        onChange: (event) => renameDefinition(editingDefinition.id, event?.target?.value ?? "")
      })
    ) : null,
    // 候选编辑弹窗：全面板只挂一份，编辑目标由 `editing` 指定（`{ defId, index }`）。
    // 目标被删掉 / 草稿被宿主返回值覆盖到没有这一条时静默不渲染 —— 与
    // `pendingDefinition` 同一条取舍，绝不对着不存在的条目渲染控件。
    editingEntry !== null ? React.createElement(AutoRouteEntryEditor, {
      entry: editingEntry.entry,
      index: editingEntry.index,
      catalog,
      effortInfo: editingEntry.entry.provider !== "" && editingEntry.entry.model !== "" ? efforts[autoRouteEffortKey(editingEntry.entry.provider, editingEntry.entry.model)] : void 0,
      busy: saving,
      onSelectField: (field, value) => setEntryField(editingEntry.defId, editingEntry.index, field, value),
      onClose: () => setEditing(null)
    }) : null
  );
}
var updateStore = {
  state: { phase: "idle", progressDetail: "" },
  listeners: /* @__PURE__ */ new Set(),
  get() {
    return this.state;
  },
  set(next) {
    this.state = typeof next === "function" ? { ...next(this.state) } : { ...next };
    for (const listener of this.listeners) listener(this.state);
  }
};
var UPDATE_CHANNEL_STORAGE_KEY = "dim-ah-update-channel";
function loadStoredUpdateChannel() {
  try {
    const raw = globalThis.localStorage?.getItem(UPDATE_CHANNEL_STORAGE_KEY);
    return raw === "beta" || raw === "stable" ? raw : "stable";
  } catch {
    return "stable";
  }
}
function storeUpdateChannel(ch) {
  try {
    globalThis.localStorage?.setItem(UPDATE_CHANNEL_STORAGE_KEY, ch);
  } catch {
  }
}
var currentUpdateChannel = loadStoredUpdateChannel();
function ChannelSelect({ channel, busy, onSelect }) {
  const [open, setOpen] = React.useState(false);
  const current = channel === "beta" ? "Beta" : "正式";
  return React.createElement(import_dsh_client_ui_primitives.Menu, {
    open,
    anchor: React.createElement(
      "button",
      {
        type: "button",
        className: "dim-ah-selectAnchor",
        "aria-label": "更新通道",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        disabled: busy,
        onClick: () => setOpen((prev) => !prev)
      },
      current,
      React.createElement(import_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: "dim-ah-selectAnchorChevron" })
    ),
    items: [
      { id: "stable", label: "正式" },
      { id: "beta", label: "Beta" }
    ],
    selectedId: channel,
    onSelect: (id) => {
      setOpen(false);
      onSelect(id);
    },
    onClose: () => setOpen(false),
    align: "end"
  });
}
function versionLogOf(update) {
  if (update.phase === "available" || update.phase === "applied") return update.changelog || "";
  if (update.phase === "latest") return update.currentChangelog || "";
  return "";
}
function UpdateStatusText({ update, onToggle }) {
  let text = null;
  let tone = "idle";
  if (update.phase === "available") {
    text = `有更新 ${update.latestVersion}`;
    tone = "warn";
  } else if (update.phase === "applying") {
    text = update.progressDetail || "更新中…";
    tone = "muted";
  } else if (update.phase === "applied") {
    text = `已更新到 ${update.currentVersion || update.latestVersion}，重启后生效`;
    tone = "ok";
  } else if (update.phase === "failed") {
    text = `更新失败：${update.error}`;
    tone = "error";
  } else if (update.phase === "latest") {
    text = update.currentVersion || "未安装";
    tone = update.currentVersion ? "idle" : "muted";
  } else if (update.phase === "checking") {
    text = "检查中…";
    tone = "muted";
  }
  if (text === null) return null;
  return React.createElement("button", {
    type: "button",
    className: "dim-ah-versionText",
    "data-tone": tone,
    onClick: onToggle
  }, text);
}
function AccountHubPage({ rpcCall }) {
  const [selected, setSelected] = React.useState(PROVIDERS[0].id);
  const [version, setVersion] = React.useState(0);
  const [update, setUpdateState] = React.useState(updateStore.get());
  React.useEffect(() => {
    const listener = (next) => setUpdateState(next);
    updateStore.listeners.add(listener);
    setUpdateState(updateStore.get());
    return () => {
      updateStore.listeners.delete(listener);
    };
  }, []);
  const [channel, setChannelState] = React.useState(currentUpdateChannel);
  const [logModalOpen, setLogModalOpen] = React.useState(false);
  const [providersOpen, setProvidersOpen] = React.useState(true);
  const selectProvider = (id) => {
    setSelected(id);
    setVersion((v) => v + 1);
  };
  const checkUpdate = async (chArg) => {
    const ch = chArg === "beta" || chArg === "stable" ? chArg : currentUpdateChannel;
    updateStore.set({ phase: "checking", channel: ch });
    let res;
    try {
      res = await rpcCall("update.check", { channel: ch });
    } catch (caught) {
      console.warn("[account-hub] update check failed:", caught);
      updateStore.set({ phase: "idle", channel: ch });
      return;
    }
    if (res?.hasUpdate === true) {
      updateStore.set({
        phase: "available",
        channel: ch,
        latestTitle: res.latestTitle,
        latestSha: res.latestSha,
        latestTag: res?.latestTag,
        latestVersion: res?.latestVersion,
        currentSha: res.currentSha,
        currentVersion: res?.currentVersion,
        changelog: typeof res?.changelog === "string" ? res.changelog : ""
      });
      return;
    }
    updateStore.set({
      phase: "latest",
      channel: ch,
      currentSha: res?.currentSha,
      currentVersion: res?.currentVersion,
      currentChangelog: typeof res?.currentChangelog === "string" ? res.currentChangelog : ""
    });
  };
  const applyUpdate = async () => {
    const applyChannel = updateStore.get().channel || currentUpdateChannel;
    const applyPayload = { channel: applyChannel };
    const latestSha = updateStore.get().latestSha;
    if (latestSha) {
      applyPayload.targetSha = latestSha;
    }
    updateStore.set((prev) => ({ ...prev, phase: "applying", progressDetail: "" }));
    let polling = true;
    let progressTimer;
    const readProgress = async () => {
      try {
        const status = await rpcCall("update.status", {});
        if (!polling) return;
        updateStore.set((prev) => ({
          ...prev,
          progressDetail: typeof status?.detail === "string" ? status.detail : ""
        }));
      } catch (caught) {
        console.warn("[account-hub] update status failed:", caught);
      }
    };
    const applyPromise = rpcCall("update.apply", applyPayload);
    void readProgress();
    progressTimer = setInterval(() => {
      void readProgress();
    }, 800);
    try {
      const res = await applyPromise;
      updateStore.set((prev) => ({
        ...prev,
        phase: "applied",
        progressDetail: "",
        previousSha: res?.previousSha,
        currentSha: res?.currentSha,
        currentVersion: res?.currentVersion || prev.latestVersion
      }));
    } catch (caught) {
      updateStore.set((prev) => ({
        ...prev,
        phase: "failed",
        progressDetail: "",
        error: caught?.message || "更新失败"
      }));
    } finally {
      polling = false;
      clearInterval(progressTimer);
    }
  };
  React.useEffect(() => {
    const boot = updateStore.get().phase;
    if (boot === "applying") {
      void (async () => {
        try {
          const status = await rpcCall("update.status", {});
          const live = status?.phase;
          if (live === "removing" || live === "installing" || live === "verifying" || live === "applying") return;
          const outcome = status?.result;
          if (outcome?.ok === true) {
            updateStore.set((prev) => ({
              ...prev,
              phase: "applied",
              progressDetail: "",
              currentSha: outcome.currentSha || prev.currentSha,
              currentVersion: prev.currentVersion || prev.latestVersion
            }));
          } else {
            updateStore.set((prev) => ({
              ...prev,
              phase: "failed",
              progressDetail: "",
              error: outcome?.error || "上次更新未完成（页面已刷新），请重新更新"
            }));
          }
        } catch {
          updateStore.set((prev) => ({
            ...prev,
            phase: "failed",
            progressDetail: "",
            error: "上次更新未完成（页面已刷新），请重新更新"
          }));
        }
      })();
      return;
    }
    if (boot === "idle") void checkUpdate();
  }, []);
  return React.createElement(
    "section",
    { className: "dim-ah-page", "aria-label": "账号中心" },
    React.createElement(
      "header",
      { className: "dim-ah-header" },
      React.createElement(
        "div",
        { className: "dim-ah-brand" },
        React.createElement(
          "div",
          { className: "dim-ah-brandTitleRow" },
          // 品牌名整体点击跳仓库：外包 a 而不是在 strong 上挂 onClick ——
          // 语义（新开标签页、中键/右键菜单、状态栏地址预览）只有真链接能给。
          // 颜色沿品牌主色不变，hover 加下划线提示可点，不新造视觉范式。
          React.createElement(
            "a",
            {
              className: "dim-ah-brandNameLink",
              href: "https://github.com/gurio-wine/dsh-account-hub",
              target: "_blank",
              rel: "noopener noreferrer"
            },
            React.createElement("strong", { className: "dim-ah-brandName" }, "账号中心")
          ),
          // 版本号文本（用户拍板替换原「已是最新」Tag）：常态显示当前版本号，
          // 有更新变黄「有更新 vX」，更新过程（更新中/已更新到/更新失败）也在这。
          // 点击不再就地展开日志，而是弹出「更新日志」弹窗（用户拍板）—— 弹窗
          // 定义在页面根部，见 logModalOpen。
          React.createElement(UpdateStatusText, {
            update,
            onToggle: () => setLogModalOpen((prev) => !prev)
          })
        ),
        React.createElement("p", { className: "dim-ah-brandDesc" }, "Provider 凭据管理与多账号支持")
      ),
      // header 右侧操作组（v0.3.1 布局修复）：header 是 space-between 双栏，
      // 右栏整体包一层 flex 容器 —— 更新按钮保持 v0.3.0 之前的原位（最右端），
      // 通道下拉紧挨其左（用户拍板「切换按钮应该挨在更新按钮左边」）。
      // 若把两个控件平级塞进 header，space-between 会把通道下拉甩到正中间
      // （v0.3.0 真机反馈的「更新按钮跑到左边中间去了」就是这个原因）。
      React.createElement(
        "div",
        { className: "dim-ah-headerActions" },
        // 更新通道下拉（用户拍板）：正式 = GitHub release，Beta = master 提交；
        // 切换即立刻按新通道检查一次 —— 通道是「下一跳查什么」的谓词，选完就看效果。
        // checking/applying 期间禁切：通道切换即触发新检查，与进行中的动作并发会
        // 让两次响应交错回灌同一状态机（版本文本闪跳、apply 装错通道的版本）。
        React.createElement(ChannelSelect, {
          channel,
          busy: update.phase === "checking" || update.phase === "applying",
          onSelect: (id) => {
            if (id === channel) return;
            currentUpdateChannel = id;
            storeUpdateChannel(id);
            setChannelState(id);
            setLogModalOpen(false);
            void checkUpdate(id);
          }
        }),
        // 「检查更新 / 更新」按钮（用户拍板的双态）：常态是 outline 图标按钮 ⇩
        // （aria-label「检查更新」）；有更新时原地变为白底黑字的 primary 文字按钮
        // 「更新」（aria-label 同步换），点击即安装 —— 入口不挪位，视线不用重新找。
        // 更新中 / 检查中两态都禁用：更新中防重复触发，检查中防检查与安装并发交错。
        update.phase === "available" || update.phase === "applying" ? React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "primary",
          size: "sm",
          className: "dim-ah-updateBtn",
          "aria-label": "更新",
          disabled: update.phase === "applying",
          onClick: () => {
            setLogModalOpen(false);
            void applyUpdate();
          }
        }, "更新") : React.createElement(import_dsh_client_ui_primitives.Button, {
          variant: "outline",
          size: "sm",
          className: "dim-ah-iconBtn",
          "aria-label": "检查更新",
          disabled: update.phase === "checking",
          onClick: () => void checkUpdate()
        }, React.createElement("span", { "aria-hidden": "true" }, "⇩"))
      )
    ),
    React.createElement(
      "div",
      { className: "dim-ah-layout" },
      React.createElement(
        "nav",
        { className: "dim-ah-rail", role: "tablist", "aria-label": "Provider 导航" },
        // 组标题走 ui-primitives 的 DisclosureRow：`expandOnRowClick` 让整行成为
        // 折叠目标，它同时给出 `aria-expanded`（无障碍要的那一条）。
        React.createElement(
          import_dsh_client_ui_primitives.DisclosureRow,
          {
            icon: React.createElement(import_dsh_client_ui_primitives.IconApiOutlineRegular),
            title: "供应商",
            open: providersOpen,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => setProvidersOpen((prev) => !prev)
          },
          // 折叠时 DisclosureRow 不渲染 children ⇒ 七个 tab 整体不在树里。
          React.createElement(
            "div",
            { className: "dim-ah-providerGroup" },
            PROVIDERS.map((p) => React.createElement(
              "button",
              {
                key: p.id,
                type: "button",
                role: "tab",
                className: "dim-ah-provider",
                "aria-selected": p.id === selected,
                onClick: () => selectProvider(p.id)
              },
              React.createElement(ProviderLogo, { provider: p.id }),
              React.createElement(
                "span",
                null,
                React.createElement("strong", null, p.label)
              )
            ))
          )
        ),
        // 「自动路由」入口：**在折叠组之外**、组下方。
        //
        // 刻意不放进 `DisclosureRow` 的 children 里：那个组的语义是「供应商」，
        // 折叠它应当只收起七个 provider tab。把自动路由塞进去会让「折叠供应商」
        // 顺手藏掉一个与供应商无关的入口 —— 它编辑的是全局配置，不属于任何 provider。
        React.createElement(
          "button",
          {
            type: "button",
            role: "tab",
            className: "dim-ah-provider",
            "aria-selected": selected === AUTO_ROUTE_TAB_ID,
            onClick: () => selectProvider(AUTO_ROUTE_TAB_ID)
          },
          // 图标容器与 provider 同形（.dim-ah-providerIcon），配色走 `ar` 类：
          // 它不是品牌标识，故**不吃**品牌色豁免，颜色来自 token
          // （--dsw-alias-state-business-primary，语义 = 「本插件自己的功能」而非
          // 某个第三方产品的品牌色）。
          React.createElement(
            "span",
            { className: "dim-ah-providerIcon ar" },
            React.createElement(import_dsh_client_ui_primitives.IconBranchOutlineRegular, { size: 20 })
          ),
          // 与七个 provider 项**逐字同形**（裸 span + strong），不额外加一层标签类
          // （曾经的 `.dim-ah-providerLabel`，已删）：那个类名是单数，多一个类就是八个
          // 导航项里唯一的异类，而两处的文本截断行为应当一致。
          React.createElement(
            "span",
            null,
            React.createElement("strong", null, AUTO_ROUTE_LABEL)
          )
        )
      ),
      React.createElement(
        "main",
        {
          className: "dim-ah-panel",
          role: "tabpanel"
        },
        // 与 provider 面板**同一套切换语义**：只有被选中的那一个挂载，
        // 且 key 带 version ⇒ 每次点选都重挂载（自动路由面板据此重新拉配置，
        // 不必自己实现「切回来要刷新」）。
        selected === AUTO_ROUTE_TAB_ID ? React.createElement(AutoRoutePanel, { key: AUTO_ROUTE_TAB_ID + "-" + version, rpcCall }) : PROVIDERS.map((p) => p.id === selected ? React.createElement(ProviderPanel, {
          key: p.id + "-" + version,
          provider: p.id,
          rpcCall
        }) : null)
      )
    ),
    // 更新日志弹窗（用户拍板「弹窗显示，不要就地显示」）：挂在页面根部，
    // 点版本文本开关，换通道 / 点更新时主动关掉。title 带版本号 —— 弹窗脱离了
    // 版本文本的上下文，不带版本号用户不知道日志属于哪一版。
    logModalOpen ? React.createElement(
      import_dsh_client_ui_primitives.Modal,
      {
        open: true,
        onClose: () => setLogModalOpen(false),
        title: `更新日志${update.phase === "latest" ? `（${update.currentVersion || "当前版本"}）` : update.latestVersion ? `（${update.latestVersion}）` : ""}`,
        closeLabel: "关闭更新日志",
        description: versionLogOf(update) === "" ? "暂无日志" : null
      },
      versionLogOf(update) !== "" ? React.createElement("pre", { className: "dim-ah-updateLog" }, versionLogOf(update)) : null
    ) : null
  );
}

// plugin-src/client/index.js
var name = "account-hub-client";
var inject = ["slots", "connection"];
function apply(ctx) {
  ctx.effect(() => installAccountHubStyles(), "account-hub: install styles");
  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, ACCOUNT_HUB_RPC_CHANNEL, endpoint, payload, signal);
    return unwrapRpcResult(raw);
  };
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "account-hub",
    order: 50,
    label: () => "账号中心",
    inject: () => ({ rpcCall })
  }, AccountHubPage));
}

    return module.exports;
  }
});
