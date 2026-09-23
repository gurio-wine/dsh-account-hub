/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的**测试替身**（7 个客户端 spec 共用）。
 *
 * ## 为什么需要它
 *
 * `plugin-src/client/account-hub.js` 现在从 ui-primitives 导入全部交互控件
 * （Button / Switch / Pill / Tag / StateDot / Menu / Modal / Tooltip /
 * RiskConfirmation）。既有客户端 spec 的做法是：把 `account-hub.js` 转成 CJS
 * 写进临时目录、用 `createRequire` 加载 —— 临时目录里**没有** ui-primitives
 * （它也不在本仓库的依赖里，是宿主经模块表注入的隐式 baseline），
 * 不补一个替身文件就会以 `Cannot find module` 整体加载失败：
 * 那不是「某个用例红」，而是**所有用例一起失效**（白屏闸门直接不再守护任何东西）。
 *
 * ## 替身必须保留什么
 *
 * 只保留**语义与可断言性**，不复制外观：
 *
 * | 替身 | 渲染成 | 为什么这样 |
 * |---|---|---|
 * | `Button` / `Pill` / `Switch` | 宿主 `<button>` | spec 用 `findButtonByText` 按 `type === 'button'` 找按钮并点它；换成 div 会让「点击必须有反应」那类断言全部失效 |
 * | `Tag` / `StateDot` | 宿主 `<span>` + `data-tone` / `data-state` | 语义档位是可断言的事实 |
 * | `Menu` | 锚点 + （`open` 时）`role="menuitem"` 行 | 行的**内容**在 `items` 里，收起时也能断言；点击走 `onSelect(id)` |
 * | `Modal` / `RiskConfirmation` | `open` 才渲染的 `role="dialog"` 子树 | 与真件同一条「关着就不在树里」的语义 |
 * | `Tooltip` | **透明代理**：原节点 + `data-tooltip` | 结构一个节点都不增（`dd` 仍是网格的直接子元素），但悬停文案在树里可断言 —— 迁移动机之一就是「文案不许丢」 |
 *
 * ## 导入改写是**按源码现算**的，不是写死的
 *
 * 旧写法（`[/^import …$/m, "const { A, B } = require(…)" ]`）在源码改了导入名单后
 * 会静默失配：正则命中、替身却少一个导出，于是那个控件在渲染时是 `undefined`。
 * 这里改为从源码里**读出实际导入的名字**再生成 require，并逐个核对替身是否导出
 * 该名字 —— 名单一变就当场抛错，而不是等到某个 provider 的面板白屏。
 */

const SPECIFIER = '@deepseek-ai/dsh-client-ui-primitives'

/** 替身文件名（写进临时目录后，由改写后的 require 引用）。 */
export const UI_PRIMITIVES_MODULE = 'ui-primitives-stub.js'

/** 替身源码（CommonJS；`require('react')` 解析到 spec 自己写的 react 占位）。 */
const STUB_SOURCE = `'use strict';
var React = require('react');

/** 展开 children 数组，使产物形态与真件（JSX 的多个 child）一致。 */
function host(tag, attrs, children) {
  var kids = Array.isArray(children) ? children : [children];
  return React.createElement.apply(null, [tag, attrs].concat(kids));
}

exports.Button = function Button(props) {
  return host('button', {
    type: 'button',
    className: props.className,
    disabled: props.disabled,
    onClick: props.onClick,
    'aria-label': props['aria-label'],
    'aria-haspopup': props['aria-haspopup'],
    'aria-expanded': props['aria-expanded'],
    'data-variant': props.variant,
    'data-size': props.size,
  }, props.children);
};

exports.Pill = function Pill(props) {
  return host('button', {
    type: 'button',
    role: props.role,
    'aria-checked': props['aria-checked'],
    className: props.className,
    disabled: props.disabled,
    onClick: props.onClick,
    'data-active': props.active === true ? 'true' : 'false',
  }, props.children);
};

exports.Switch = function Switch(props) {
  return host('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.checked === true,
    'aria-label': props.label,
    disabled: props.disabled,
    onClick: function () { props.onChange(!props.checked); },
  }, null);
};

exports.Tag = function Tag(props) {
  return host('span', { className: props.className, 'data-tone': props.tone }, props.children);
};

exports.StateDot = function StateDot(props) {
  return host('span', { className: props.className, 'data-state': props.state }, null);
};

exports.Menu = function Menu(props) {
  var children = [props.anchor];
  if (props.open) {
    var rows = (props.items || []).map(function (item) {
      return host('button', {
        type: 'button',
        role: 'menuitem',
        key: item.id,
        /**
         * \`disabled\` **必须透传**：真件 \`Menu.tsx\` 的菜单行是
         * \`<button disabled={entry.disabled}>\`（真件的键盘导航也只认
         * \`button:not(:disabled)\`）。替身漏了它，「不可选的菜单项确实是禁用的」
         * 这条断言就永远拿不到事实 —— 而它正是「模型无思考档位时档位下拉里那一项
         * 不该能被选中」的唯一可断言形态。
         */
        disabled: item.disabled,
        onClick: function () { props.onSelect(item.id); },
      }, item.label);
    });
    children.push(host('div', { role: 'menu' }, rows));
  }
  var node = host('span', { className: 'ui-menu' }, children);
  /**
   * 把 Menu 自己的 props 挂在返回节点上（非 DOM 字段，只给测试用）。
   *
   * 真件是**组件**：\`items\` / \`selectedId\` / \`onSelect\` 只存在于展开**前**的
   * 元素 props 上，展开成宿主节点后就没了 —— 而 spec 里的树是展开过的。
   * 没有这个字段，测试就只能靠「菜单项的可见文本」间接验证取值与选中态，
   * 而「每档的 id 必须与宿主联合类型逐字一致」这类断言恰恰要读 id 本身。
   */
  node.menuProps = props;
  return node;
};

/**
 * 弹窗替身：**保留真件的文本结构**（标题 / 说明 / 正文 / 页脚），去掉外观。
 *
 * 真件在 \`open === false\` 时返回 null —— 替身必须同款：「关着就不在树里」这条
 * 语义正是 spec 要断言的东西（例如「取消删除后弹窗消失」）。
 *
 * \`title\` 渲染成 \`h2\`、\`description\` 渲染成 \`p\`：这两段文案是**确认动作的
 * 唯一说明来源**（「确认删除自动模型『快速』？」——用户据此知道自己正在删什么），
 * 只把它们放进 props 而不渲染，spec 就断言不到「确认文案点名了哪个对象」。
 * \`aria-label\` 仍挂在 \`role="dialog"\` 的卡片上（与真件一致）。
 *
 * 关闭按钮渲染成**无文本**的 \`button\` + \`aria-label\`（真件就是一枚图标按钮）：
 * 给它文本会让「树里的按钮文案集合」多出一个「取消删除」，与页脚里的「取消」/「删除」
 * 撞车，按文案找按钮的断言就会拿到错的节点。
 */
exports.Modal = function Modal(props) {
  if (!props.open) return null;
  var inner = [];
  if (props.headless !== true) {
    inner.push(host('div', { className: 'ui-modal-header' }, [
      host('h2', { className: 'ui-modal-title' }, props.title),
      host('button', { type: 'button', 'aria-label': props.closeLabel }, null),
    ]));
    if (props.description !== undefined && props.description !== '') {
      inner.push(host('p', { className: 'ui-modal-description' }, props.description));
    }
    if (props.children !== undefined) inner.push(host('div', { className: 'ui-modal-body' }, props.children));
  } else {
    inner.push(props.children);
  }
  var children = [host('div', {
    className: props.className,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': props.title,
  }, inner)];
  if (props.footer !== undefined) children.push(host('div', { className: 'ui-modal-footer' }, props.footer));
  return host('div', { className: 'ui-modal-root' }, children);
};

exports.RiskConfirmation = function RiskConfirmation(props) {
  if (!props.open) return null;
  return host('div', { className: 'ui-risk', role: 'dialog', 'aria-label': props.title }, [
    host('p', null, props.description),
    host('button', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': props.acknowledged === true,
      onClick: function () { props.onAcknowledgedChange(!props.acknowledged); },
    }, props.acknowledgeLabel),
    host('button', {
      type: 'button',
      disabled: props.disabled === true || !props.acknowledged,
      onClick: props.onConfirm,
    }, props.confirmLabel),
    host('button', { type: 'button', onClick: props.onCancel }, props.cancelLabel),
  ]);
};

/**
 * 透明代理：节点类型与子节点原样，只把 \`label\` 投影成 \`data-tooltip\`。
 * 不新增包裹节点 —— 否则 \`dd\` 会被塞进一层 span，网格布局与既有结构断言一起变。
 */
exports.Tooltip = function Tooltip(props) {
  var child = props.children;
  if (child === null || typeof child !== 'object') return child;
  return {
    type: child.type,
    props: Object.assign({}, child.props, { 'data-tooltip': props.label }),
    children: child.children,
  };
};

/** Button 的 icon 槽：替身不渲染它（纯装饰），但导出名必须存在。 */
exports.IconChevronDownOutline14 = function IconChevronDownOutline14() { return null; };

/** 供应商折叠组的组标题图标：同 IconChevronDownOutline14，纯装饰不渲染。 */
exports.IconApiOutline14 = function IconApiOutline14() { return null; };

/** 「自动路由」导航项图标：同 IconChevronDownOutline14，纯装饰不渲染。 */
exports.IconBranchOutline16 = function IconBranchOutline16() { return null; };

/**
 * 文本输入框替身：宿主 \`<input>\` 直接暴露 \`value\` / \`onChange\`。
 *
 * 真件是「外层 span + 内层 input」，替身**必须保留内层 input**：
 * 自动模型名是受控输入，spec 要按 \`value\` 读当前草稿值、按 \`onChange\` 派发
 * 编辑事件。渲染成 div 或把 value 挂到外层 span 上，这两件事都做不了
 * —— 那会让「改名只改草稿、不写服务端」这条断言失去可断言的事实。
 *
 * 替身**不**复刻真件的外层包裹 span：spec 按 \`el.type === 'input'\` 定位，
 * 多一层包裹只会让「树里没有原生控件」那类既有断言多一个噪声节点。
 */
exports.Input = function Input(props) {
  return host('input', {
    type: 'text',
    className: props.className,
    value: props.value,
    placeholder: props.placeholder,
    disabled: props.disabled,
    'aria-label': props['aria-label'],
    onChange: props.onChange,
  }, null);
};

/**
 * 折叠行替身：只保留**可断言的结构**，不复制真件的 24px 外观。
 *
 * 真件在 \`open === false\` 时**不渲染 children\`（\`{open && children}\`），
 * 替身必须同款 —— 「折叠时七个 tab 不在树里」这条语义正是 spec 要断言的东西；
 * 换成 display 隐藏就断言不到了。
 *
 * \`expandOnRowClick\` 时真件把**整行**变成 \`role="button"\` + \`aria-expanded\`，
 * 否则退化成行内一枚只有图标的小按钮。替身两种形态都保留，因为调用点选的是
 * 前者（整行可点）——「组标题是 role=button 的 DisclosureRow」这条 spec 断言
 * 依赖它。真件的 \`className\` 系列（\`className\` / \`rowClassName\` / …）替身
 * 原样投影，spec 才能按类名定位组标题。
 */
exports.DisclosureRow = function DisclosureRow(props) {
  var rowExpands = props.expandable === true && props.expandOnRowClick === true;
  var attrs = {
    className: props.className,
    'data-open': props.open === true ? 'true' : undefined,
    'data-disclosure-row': true,
    'data-expandable': rowExpands ? 'true' : undefined,
    role: rowExpands ? 'button' : undefined,
    tabIndex: rowExpands ? 0 : undefined,
    'aria-expanded': rowExpands ? props.open === true : undefined,
    onClick: rowExpands ? props.onToggle : undefined,
  };
  var children = [host('span', { className: props.titleClassName }, props.title)];
  if (props.expandable === true && !rowExpands) {
    children.push(host('button', {
      type: 'button',
      className: props.leadingClassName,
      'aria-expanded': props.open === true,
      onClick: props.onToggle,
    }, props.icon));
  }
  if (props.open === true) children.push(props.children);
  return host('div', attrs, children);
};
`

/** 替身导出的控件名（用于核对源码导入名单）。 */
const EXPORTED = [...STUB_SOURCE.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]!)

/**
 * 把 `account-hub.js` 里对 ui-primitives 的 import 改写成对替身的 require。
 *
 * @param source 客户端源码全文。
 * @returns 改写后的全文；导入语句缺失或替身缺导出时抛错（见文件头）。
 */
export function rewriteUiPrimitivesImport(source: string): string {
  const pattern = new RegExp(`^import \\{([\\s\\S]*?)\\} from '${SPECIFIER}';$`, 'm')
  const match = pattern.exec(source)
  if (match === null) {
    throw new Error(`account-hub.js 不再从 ${SPECIFIER} 导入控件：测试替身的改写规则失效`)
  }
  const names = match[1]!.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  if (names.length === 0) throw new Error(`account-hub.js 从 ${SPECIFIER} 导入的名字为空`)
  const missing = names.filter((name) => !EXPORTED.includes(name))
  if (missing.length > 0) {
    throw new Error(
      `tests/unit/fixtures/ui-primitives-stub.ts 缺少这些控件替身：${missing.join(', ')}`
      + '（新增控件时必须同步补替身，否则它在测试里是 undefined）',
    )
  }
  return source.replace(pattern, `const { ${names.join(', ')} } = require('./${UI_PRIMITIVES_MODULE}');`)
}

/**
 * 把替身写进临时目录（与 `credits-capabilities.js` / `account-order.js` 同款做法）。
 *
 * @param dir 该 spec 为本次加载新建的临时目录。
 * @param write 注入的写文件函数（各 spec 已从 node:fs 导入，避免本文件再引一次）。
 */
export function writeUiPrimitivesStub(dir: string, write: (path: string, data: string) => void): void {
  write(`${dir}/${UI_PRIMITIVES_MODULE}`, STUB_SOURCE)
}
