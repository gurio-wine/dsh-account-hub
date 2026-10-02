/**
 * 极简 YAML 子集解析器 —— **只服务一次性迁移**。
 *
 * ## 为什么自己写而不引依赖
 *
 * 仓库当前**零 YAML 依赖**（`package.json` 里没有 `yaml` / `js-yaml`），而任务约束
 * 是「不得引入新运行时依赖」。完整的 YAML 1.2 实现（含锚点、别名、多文档、标签）
 * 为一个「读一个 section」的需求引入几百 KB 依赖也不合适。
 *
 * 因此这里实现的是**目标子集**，且只解析**一个顶层键下的内容**：调用方
 * {@link parseSimpleYamlSection} 先按顶层键切出范围，范围**之外**的所有行
 * （其他 section、可能含块标量等本解析器不支持的构造）连碰都不碰 —— 这也是
 * 为什么不做「整文件解析后再取一节」：那会被无关 section 的复杂构造拖垮。
 *
 * ## 支持的构造（按真实 `~/.dsh/settings.yaml` 的落盘形态确定）
 *
 * - 块映射（`key: value`，缩进决定层级）与块序列（`- item`）
 * - 嵌套映射 / 序列，任意深度
 * - flow 映射与 flow 序列（`{ a: 1 }` / `[a, b]`），**允许跨多行**
 * - 标量：双引号（含转义）、单引号（`''` 表示一个单引号）、整数 / 小数、`true` /
 *   `false`、`null` / `~` / 空值、其余按原样字符串
 * - 注释：`#` 前是行首或空白才算注释（`189****3995` 里的 `#` 前是 `*`，不是注释）
 *
 * ## 明确不支持（遇到即抛错，**不静默当成别的意思**）
 *
 * 锚点 `&` / 别名 `*` / 标签 `!!` / 多文档 `---` / 块标量 `|` `>` / 合并键 `<<`。
 * 抛错而不是猜：迁移面对的是用户唯一的账号数据，静默解析成空会让账号「凭空消失」，
 * 而报错只是让迁移这一轮跳过（来源文件一个字都不动，下次启动可重试）。
 *
 * @module dsh-account-hub/simple-yaml
 */
/** YAML 子集能产出的值。 */
export type YamlValue = string | number | boolean | null | YamlValue[] | {
    [key: string]: YamlValue;
};
/**
 * 取出**一个顶层键**下的内容并解析成值。
 *
 * 范围之外的行（其他 section）原样跳过、不做任何解析 —— 这是刻意的：
 * 真实 `settings.yaml` 里别的 section 含块标量等本解析器不支持的构造，
 * 整文件解析会被无关内容拖垮。
 *
 * @param text - YAML 文本。
 * @param topLevelKey - 目标顶层键（只匹配**行首无缩进**的那个）。
 * @returns 该键下的值；文档里没有这个键时 `undefined`。
 */
export declare function parseSimpleYamlSection(text: string, topLevelKey: string): YamlValue | undefined;
//# sourceMappingURL=simple-yaml.d.ts.map