import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

import { readHostExportNames } from './host-ui-primitives.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/account-hub.js');
const loaderId = 'dsh-account-hub';

/**
 * 被校验的隐式 baseline 模块。
 *
 * 只校验它，不校验 `react`：react 的导出面由上游稳定版本锁定，而 ui-primitives 是
 * 宿主随 DSH 版本一起演进的**内部包**，其改名/删除是插件侧唯一会静默漂移的接口面。
 */
const UI_PRIMITIVES_SPECIFIER = '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 惰性 stub：任意属性访问都返回同款 stub，可读、可写、可调用、可构造。
 * 用于补齐 document / navigator 一类顶层可能触碰的浏览器全局 —— 只为让
 * 「好产物能通过」，不做完整运行时仿真。
 */
const lazyStub = (label) => new Proxy(function smokeStub() {}, {
  get(target, key) {
    // then 必须返回 undefined：否则 stub 会被当成 thenable，await 它永不结算
    if (key === 'then') return undefined;
    if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf') return () => label;
    return lazyStub(label);
  },
  apply: () => lazyStub(label),
  construct: () => lazyStub(label),
});

/**
 * 成员校验闸门：插件从 ui-primitives 具名导入的每个成员，宿主的导出面里必须真实存在。
 *
 * ## 为什么必须有这道闸
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 在 esbuild 里是 `external`（理由见下方 build
 * 调用），而 external 意味着 **esbuild 不解析它的导出**：`import { IconX } from '…'`
 * 只被改写成 `require('…').IconX`，名字对不对无从得知。三道既有闸门全都不看这个面：
 *
 * - esbuild 只打包、不校验语义；
 * - `tsconfig.json` 的 include 只有 `src/`，看不见 `plugin-src/`；
 * - 产物冒烟只跑**顶层求值**，而图标是在渲染期才被 `React.createElement` 取用的。
 *
 * 于是宿主 commit `4937343a5e`（"unify the client visual language"）把整套图标 API
 * 改名（`IconApiOutline14` → `IconApiOutlineRegular` 等）后，插件照旧 import 旧名：
 * 构建全绿、冒烟全绿，用户打开设置页才 `React.createElement(undefined)` 抛
 * "Element type is invalid" —— 账号中心面板整片白屏。
 *
 * ## 名单从哪来
 *
 * 从构建机器上的宿主 checkout 现算（`host-ui-primitives.mjs`），**不手工维护**：
 * 手工名单正是本次事故的成因。宿主 checkout 不存在时（别人的机器 / CI）只 warn
 * 并跳过 —— 校验闸门绝不能让「没有宿主的环境」构建失败。
 *
 * @param inputs esbuild metafile 的 inputs（被打进产物的全部源文件，键为相对路径）。
 * @returns 无返回值；校验不通过时 `process.exit(1)`。
 */
function verifyUiPrimitivesExports(inputs) {
  const host = readHostExportNames();
  if (host === null) {
    console.warn('⚠ 跳过 ui-primitives 成员校验：未找到宿主 checkout（可用 DSH_UI_PRIMITIVES_DIR 指定）。');
    return;
  }

  const known = new Set(host.names);
  const missing = [];
  const seen = new Set();
  let checked = 0;

  // 只扫**本插件自己的源码**（plugin-src/ 下），第三方依赖不属校验范围。
  // metafile 的键用正斜杠、且相对 absWorkingDir；Windows 的 resolve() 给反斜杠，
  // 故两边都先归一成正斜杠再比较 —— 否则 StartsWith 静默失配、闸门空转仍报绿。
  const scope = `${resolve(packageRoot, 'plugin-src').replace(/\\/g, '/')}/`;
  for (const key of Object.keys(inputs)) {
    const file = isAbsolute(key) ? key : resolve(packageRoot, key);
    if (!file.replace(/\\/g, '/').startsWith(scope)) continue;
    if (!existsSync(file) || !/\.[cm]?js$/.test(file)) continue;

    const text = readFileSync(file, 'utf8');
    // 具名导入：import { A, B as C } from '<specifier>'
    const pattern = new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${UI_PRIMITIVES_SPECIFIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
      'g',
    );
    for (const match of text.matchAll(pattern)) {
      for (const raw of match[1].split(',')) {
        const spec = raw.trim().replace(/^type\s+/, '');
        if (spec === '') continue;
        // `A as B` 取**被导入的原始名** A：产物访问的是宿主上的 A
        const imported = spec.split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
        if (seen.has(imported)) continue;
        seen.add(imported);
        checked += 1;
        if (!known.has(imported)) missing.push({ name: imported, file: key });
      }
    }
  }

  if (missing.length > 0) {
    console.error('\n✗ ui-primitives 成员校验失败：以下名字在宿主导出面里不存在。');
    for (const item of missing) console.error(`  - ${item.name}  （来自 ${item.file}）`);
    console.error(`\n  宿主：${host.dir}`);
    console.error(`  名单来源：${host.origin}（共 ${host.names.length} 个导出）`);
    console.error('  典型成因：宿主重命名了图标/控件 API，而插件源码仍引用旧名。');
    console.error('  产物未写入 lib/：lib/ 保留上一次构建的可用版本，避免「构建即部署」把页面打崩。');
    process.exit(1);
  }

  console.log(`✓ ui-primitives 成员校验通过（${checked} 个具名导入，宿主 ${host.names.length} 个导出，名单来源 ${host.origin}）`);
}

/**
 * 产物冒烟闸门：像浏览器加载器那样真的把 bundle 跑一遍顶层求值。
 *
 * 为什么必须有这道闸：plugin-src/ 不在 tsconfig.json 的 include（只有 src/）内，
 * vitest 只跑 tests/unit/**，esbuild 只打包不校验语义 —— 三道既有闸门都看不见
 * 客户端源码。7031db1 在 CSS 模板字符串内部的块注释里写了一对反引号，提前闭合
 * 模板，后面的 CSS 变成游离表达式，产物顶层直接 ReferenceError 而构建全绿，
 * 用户启动 DSH 才崩，只能手动回退。
 *
 * 模板字符串的求值发生在模块工厂被调用的那一刻，所以这里必须真的调用 factory，
 * 而不是只检查产物能否被解析。
 *
 * 用 node:vm 而非 new Function：沙箱隔离，stub 不进真实 globalThis，异常路径
 * 也不需要恢复被改写的全局；两者都能炸出模板求值类错误。
 */
function smokeTestBundleTopLevel(code, filename) {
  let loaded = null;
  const loaderHost = {
    __ModuleLoader__: {
      load(mod) {
        loaded = mod;
      },
    },
  };
  const windowStub = new Proxy(loaderHost, {
    get: (target, key) => (Reflect.has(target, key) ? Reflect.get(target, key) : lazyStub('window')),
  });

  const context = createContext({
    window: windowStub,
    document: lazyStub('document'),
    navigator: lazyStub('navigator'),
    location: lazyStub('location'),
    self: windowStub,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    // 冒烟阶段不允许任何网络行为；顶层若真的发请求，应当炸出来
    fetch: () => Promise.reject(new Error('smoke gate: network disabled')),
  });

  try {
    runInContext(code, context, { filename, displayErrors: true });

    if (!loaded) throw new Error('产物没有调用 window.__ModuleLoader__.load —— loader 包裹层被破坏了');
    if (loaded.id !== loaderId) throw new Error(`产物注册的插件 id 是 ${JSON.stringify(loaded.id)}，期望 ${JSON.stringify(loaderId)}`);
    if (typeof loaded.factory !== 'function') throw new Error('产物注册的 factory 不是函数');

    // 这一步才是真正的闸门：模块工厂一被调用，产物顶层的常量（模板字符串等）立即求值
    loaded.factory(() => lazyStub('require'));
  } catch (error) {
    const lines = code.split('\n');
    const frame = /account-hub\.js:(\d+):(\d+)/.exec(String(error?.stack ?? ''));
    console.error('\n✗ 客户端产物冒烟失败：bundle 顶层求值抛错。');
    console.error(`  ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
    if (frame) {
      const line = Number(frame[1]);
      console.error(`  产物位置：${outputPath}:${line}:${frame[2]}`);
      for (let i = Math.max(1, line - 1); i <= Math.min(lines.length, line + 1); i++) {
        console.error(`  ${String(i).padStart(5)} | ${lines[i - 1]}`);
      }
    }
    console.error('  提示：模板字符串（如 CSS 全文）里混入反引号会提前闭合模板，使后续代码');
    console.error('        变成游离表达式 —— 这类错误 esbuild 打包与 tsc 类型检查都看不见。');
    console.error('  产物未写入 lib/：lib/ 保留上一次构建的可用版本，避免「构建即部署」把页面打崩。');
    process.exit(1);
  }
}

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 默认 charset 为 'ascii'，会把所有中文转义成 \uXXXX：产物可读性差，
  // 且使「用 includes 校验产物文案」的做法天然失效。改用 utf8 后产物保留原文，
  // 加载器按 utf8 读取 bundle（dsh-client-modules 用 "utf8" 解码），故安全。
  charset: 'utf8',
  // ui-primitives 是宿主的**隐式 baseline**（`packages/client/web/src/platform.ts`
  // 的 PLATFORM_MODULES 把 `@deepseek-ai/dsh-client-ui-primitives` 注入了共享
  // 模块表），故必须 external：打进产物会得到**第二份** React 与一份
  // 无法处理的 .module.css 引用（esbuild 不认 CSS Module，直接把 import 留在
  // 产物里，加载器 require 一个 .css 路径必然炸）。
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  // 固定工作目录：metafile 的 inputs 键以它为基准，闸门 A 才能稳定还原源文件路径
  absWorkingDir: packageRoot,
  // 闸门 A 靠 inputs 定位「哪些源文件被打进了产物」，再逐文件核对具名导入
  metafile: true,
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

// 闸门 A：产物出来即核对成员 —— 名字漂移在构建期炸，不留给用户白屏
verifyUiPrimitivesExports(result.metafile.inputs);

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;

// 先冒烟再落盘：坏产物不写进 lib/，否则「构建即部署」会让用户下一次启动直接崩
smokeTestBundleTopLevel(wrapped, outputPath);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
console.log('✓ 产物冒烟通过（bundle 顶层求值无异常）');
