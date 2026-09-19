import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/jet-hub.js');
const loaderId = 'dsh-account-hub';

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
    const frame = /jet-hub\.js:(\d+):(\d+)/.exec(String(error?.stack ?? ''));
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
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

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
