// 三档共用的忽略判据。
//
// **必须是逐段匹配函数，不能是字符串模式**——两种字符串写法各有各的失效方式，而两种都是
// 静默的：
//
// - **`'node_modules'` 这类单段 basename 模式在 macOS / Windows 上形同虚设**：原生 watcher
//   拿**事件的相对路径**(`node_modules/.bin/foo`)去调匹配器，而 minimatch 的 `matchBase`
//   只在模式为单段时把整条路径换成 basename 再比——这里 basename 是 `foo`，匹配不上，
//   事件照常放行。B 档在回调里按 basename 过滤同样失效
// - **`'node_modules/**'` 这类含斜杠的模式两头落空**：含斜杠会让 `matchBase` 失效，既匹配
//   不到目录自身（白白进去一层），也匹配不到 monorepo 里的 `packages/*/node_modules`
//
// 逐段函数两头都覆盖，而且 `createIgnoreMatcher` 除字符串 / 正则外**直接接受 Function**
// （收下即用，不做包装），所以这是官方支持的用法而不是绕路。

/**
 * 路径任一段命中即忽略。`.git` 在集合里**与档位无关**：工作区那条递归 watch 绝不能进
 * `.git`（一次 gc 就是几万个条目），`.git` 侧另有目录级非递归 watch 盯着。
 */
const IGNORE_NAMES = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'build']);

/** 路径分隔符两种都切：Windows 的原生 watcher 给的是反斜杠分隔的相对路径。 */
const SEPARATOR = /[\\/]/;

/**
 * 大小写归一，对齐 `ignore` 内部的 `nocase: isWindows || isMacOS`。**不导出**：多一个入口
 * 就多一份会跟着漂的契约。Linux 上**原样返回**——那里的文件系统区分大小写，`Node_Modules`
 * 与 `node_modules` 是两个不同的目录，归一等于把一个用户真的想看的目录悄悄屏蔽掉。
 */
function caseFold(segment: string, platform: string): string {
  return platform === 'win32' || platform === 'darwin' ? segment.toLowerCase() : segment;
}

/**
 * 造一个绑定平台的匹配器。**平台可注入是为了让三端的归一行为都能在一台机器上验**。收到的
 * 是**相对被监听目录的路径**，不是绝对路径——传绝对路径进来也能工作，只是仓库自身若躺在
 * 某个叫 `build` 的目录下就会整片被忽略，所以调用方不该那么用。
 */
export function createIsIgnored(platform: string = process.platform): (path: string) => boolean {
  return (path: string) =>
    path.split(SEPARATOR).some((segment) => IGNORE_NAMES.has(caseFold(segment, platform)));
}

/** 当前平台的那一份。A 档传给 `ignore`、B 档在回调最前面调，是**同一个函数**。 */
export const isIgnored = createIsIgnored();
