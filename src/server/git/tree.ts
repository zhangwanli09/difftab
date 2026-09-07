// 文件浏览器的目录树。
//
// **按目录懒加载，一次只回一层的直接子项**——与「禁止一次性取全仓 diff」同一条取向，
// 而且更严重：`node_modules` 会让一份全量树的 JSON 比整仓 diff 还大，且每次 SSE 刷新
// 都要重发一遍。

import { readdir } from 'node:fs/promises';
import type { TreeEntry, TreePayload } from '../shared/protocol.ts';
import { GitError, runGitStrict } from './run.ts';
import { resolveInRepo, WorktreeError } from './worktree.ts';

/**
 * 未跟踪那两条调用共用的尾巴。四个参数每一个都在挡一件具体的事：
 *
 * - `-z`：路径原样输出、按 NUL 切分（与其余所有列表类调用同一条约束）；
 * - **`--directory` 与 `--no-empty-directory` 必须同时带**。`--others` 默认展开到文件粒度，
 *   于是一个装着 30,000 个文件的 `node_modules` 就是 30,000 条路径——**git 照常 exit 0**，
 *   症状只是这一层慢得离谱、内存里凭空多出几 MB 字符串，没有任何东西会报错。带上之后整个
 *   目录折叠成一条 `node_modules/`，正是树上要画的那一条；`--no-empty-directory` 顺带滤掉
 *   折叠后为空的那些；
 * - `--exclude-standard`：读 `.gitignore` / `.git/info/exclude` / 全局 exclude。**它对
 *   `--ignored` 那条是强制的**——单独出现时 git 直接 fatal（`needs some exclude pattern`）。
 */
const OTHERS_ARGS = ['-z', '--exclude-standard', '--directory', '--no-empty-directory'] as const;

/**
 * 已跟踪的那一条**带 `--stage`**，为的是拿到 mode。
 *
 * 判据是 **`160000` 即 gitlink（submodule）**：它在普通输出里就是一条不带尾斜杠的路径，与
 * 一个文件长得一模一样——照文件画出来的话，树上那一行没有展开箭头，点下去还会以「不是普通
 * 文件」告终，而 difftab 明确支持在含 submodule 的仓库里跑。
 *
 * **`--stage` 与 `--others` 不能合成一条**：加上它之后 git 把未跟踪那部分整个丢掉（已实测），
 * 所以这里是三条调用而不是两条。三条并发发出，墙上时间仍是一条的量级。
 */
const CACHED_ARGS = ['ls-files', '-z', '--stage', '--cached'] as const;

/**
 * gitlink 的 mode，`--stage` 记录（`<mode> <object> <stage>\t<path>`）的开头。git 自己对
 * submodule 的编码，不是我们的约定。按 `indexOf('\t')` 切、不上正则：这一段每个已跟踪文件
 * 各跑一次，而要的只是「\t 后面那截」与「开头六个字符」。
 */
const GITLINK_MODE = '160000';

/**
 * 一层的直接子项。
 *
 * 收敛判据是**「相对本层的第一段」**：`src/web/main.tsx` 相对 `src` 的第一段是 `web`，
 * 后面还跟着 `/`，所以 `web` 是目录；`--directory` 折叠出来的 `node_modules/` 以 `/` 结尾，
 * 同样是目录。去重后目录在前、各自按名字排序（照 VS Code 的排法）。
 *
 * `dir` 为空串即仓库根，此时不带 `--`：`ls-files` 不带 pathspec 就是整仓。
 */
export async function readTree(root: string, dir: string): Promise<TreePayload> {
  /**
   * 两道边界一次过完，**并且拿走归一化后的那份路径**。`follow: true` 是因为兜底那条要
   * `readdir` 它，而 `readdir` 本来就跟随最后一段；`allowRoot` 是因为目录树的第一层就是根。
   *
   * 归一化那半同样不是顺手：`dir/`、`./dir`、`dir//x` 都会被 `resolve()` 归成同一份，而下面
   * 整个收敛逻辑靠 `prefix` 做前缀匹配——先前只取绝对路径、把归一结果扔掉，于是不得不在外面
   * 补一条 `endsWith('/')` 的特判，而那一族拼法是拦不完的。
   */
  const { abs, path } = await resolveInRepo(root, dir, { follow: true, allowRoot: true });

  // `--` 后面那一段仍受封装层的 GIT_LITERAL_PATHSPECS=1 约束，而字面量 pathspec 保留
  // 前导目录匹配：`-- src` 照样匹配 src/ 底下的一切
  const scope = path === '' ? [] : ['--', path];
  /**
   * **两条 `--others` 照旧按本层完整路径问，只有 git 自己失败了才退到第一段重问一次。**
   *
   * 要它是因为深处那一层会**直接 fatal**（`internal error - directory entry not superset of
   * prefix`，exit 128）：git 拿全部 pathspec 的公共前导目录当前缀（`a/b/c` 截到最后一个 `/`，
   * 得 `a/b/`），而 `--ignored` 那条报的是**排除规则命中的那一层**（`.gitignore` 里的
   * `vendor/`）、与 pathspec 有多深无关——吐目录条目之前那道断言要求前缀不比条目长。于是
   * **被忽略的那一片里深度 ≥ 3 的那一层必炸，深度 ≤ 2 恒安全**（前缀最长就是 `a/`，正好等于
   * 最短的那条记录）。`-C` 进那个目录、pathspec 带尾斜杠都绕不过；第一段不含 `/`，前缀因此
   * 恒为空，断言永远成立。页面上炸出来的样子是那一层写着一行 `git ls-files … failed (exit)`。
   *
   * **但第一段只能当兜底，不能当默认**——放宽 pathspec 会静默改掉另外两件事的答案：
   *
   * - **被忽略的那一片嵌在一个未跟踪目录里时，放宽之后 `--ignored` 那条一条都不回**（实测：
   *   `u/` 整个未跟踪、`u/ig/` 被忽略，问 `-- u/ig` 回 `u/ig/`，问 `-- u` 回空）。那一层于是
   *   继承「不灰显」，页面上只是它不再灰了；
   * - **`?path=<未跟踪目录里的一个文件>` 会从 400 变成 500**：窄 pathspec 下 git 吐的是这个
   *   文件自己（下面据此判 `selfKind === 'file'`），放宽之后它被折叠进 `a/`，于是没人认出这是
   *   坏请求，兜底拿一个普通文件去 `readdir`，以 `ENOTDIR` 收场。
   *
   * 所以退让只发生在 git 已经答不出东西的那一刻，代价范围也就限死在「本来是个 500」的那一层。
   * 重问一次拿到的是折叠记录，之后走的是下面读一层磁盘的兜底——折叠层以下 git 本就答不出内容。
   *
   * 判据用「非零退出」而不是去比对那句 fatal 的字面量：这两条调用是只读列举，非零退出没有第二
   * 种解释，而按消息匹配要赌它逐字不变。重问那次再失败就把**原来那个**错误抛出去。
   */
  const firstSlash = path.indexOf('/');
  const runOthers = (args: readonly string[]) =>
    runGitStrict([...args, ...scope], root).catch((cause: unknown) => {
      // 根那一层与只有一段的那一层退无可退：第一段就是本层自己。`missing`（git 不在 PATH）
      // 与 `overflow`（stdout 超限）也不该重问——前者重问一样没有 git，后者放宽只会更大
      if (!(cause instanceof GitError) || cause.kind !== 'exit' || firstSlash === -1) throw cause;
      return runGitStrict([...args, '--', path.slice(0, firstSlash)], root).catch(() => {
        throw cause;
      });
    });
  const [cached, others, ignoredOut] = await Promise.all([
    runGitStrict([...CACHED_ARGS, ...scope], root),
    runOthers(['ls-files', ...OTHERS_ARGS, '--others']),
    runOthers(['ls-files', ...OTHERS_ARGS, '--others', '--ignored']),
  ]);

  const prefix = path === '' ? '' : `${path}/`;
  /**
   * 这一层落在一片被折叠的区域里（`null` 即没有），以及那一片是哪一档。
   *
   * `--directory` 是它该有的行为——`vendor/` 与 `node_modules/` 正是靠它才没有变成三万条
   * 路径——但代价是 git 从此再也答不出那里面有什么。而且**它折叠在最高那一层**：问
   * `dist/server` 回来的仍是 `dist/`（已实测；三种 pathspec 写法与 `-C` 进去都一样）。
   *
   * **判据因此是「回来的这条是本层自己**或**它的某个祖先」，不是「正好等于本层」**：只认
   * 相等时，`dist/` 这条既不等于 `dist/server/`、又过不了下面那道 `startsWith(prefix)`，
   * 于是这一层两手空空地返回——页面上就是一个展开后写着 Empty 的目录，而里面明明有东西。
   */
  let collapsedAs: boolean | null = null;
  // 同一个名字可能被多条调用同时提到（一个目录里既有可见文件又有被忽略的文件），
  // **先到先得**：只要有一条可见的，这个目录就不该灰显
  const byName = new Map<string, TreeEntry>();

  /** 一条路径 → 这一层里的那个条目。`isDir` 由调用方按各自的格式判出来后传进来。 */
  const add = (path: string, isIgnored: boolean, gitlink = false) => {
    if (!path.startsWith(prefix)) return;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === '' || byName.has(name)) return;
    byName.set(name, {
      name,
      path: `${prefix}${name}`,
      // 有后续 `/` 说明它在更深处；没有则看是不是 gitlink（submodule 在这里是唯一
      // 一个「没有尾斜杠、却确实是目录」的形态）
      kind: slash === -1 && !gitlink ? 'file' : 'directory',
      ignored: isIgnored,
    });
  };

  /**
   * git 提到了**本层自己**这条路径（而不是它底下的东西），说的是哪一种。两种都要：
   * `gitlink` 是下面那条兜底的第二个正面判据；`file` 说明**问错了**——有人把一个文件当目录
   * 展开，那是坏请求，不是一个空目录。
   */
  let selfKind: 'file' | 'gitlink' | null = null;

  for (const segment of cached.split('\0')) {
    const tab = segment.indexOf('\t');
    if (tab === -1) continue;
    const entryPath = segment.slice(tab + 1);
    const gitlink = segment.startsWith(GITLINK_MODE);
    if (entryPath === path) {
      selfKind = gitlink ? 'gitlink' : 'file';
      continue;
    }
    add(entryPath, false, gitlink);
  }

  const collectOthers = (output: string, isIgnored: boolean) => {
    for (const line of output.split('\0')) {
      if (line === '') continue;
      // 折叠出来的条目一律以 `/` 结尾；它是本层的祖先（或本层自己）时，说的就是
      // 「这一整片我折叠了」，而不是「这一层里有个叫这个的东西」
      if (line.endsWith('/') && prefix.startsWith(line)) {
        collapsedAs = isIgnored;
        continue;
      }
      // 未跟踪那两条里，本层自己只会以「不带尾斜杠」的形态出现，那就是一个文件
      if (line === path) {
        selfKind ??= 'file';
        continue;
      }
      add(line, isIgnored);
    }
  };
  collectOthers(others, false);
  collectOthers(ignoredOut, true);

  /**
   * **git 答不出这一层时读一次磁盘**，只读一层。两种形态都会走到这里，而**两种手上都有正面
   * 证据**——判据因此是那两条，不是「一条子项都没有」：
   *
   * - `--directory` 把这一片折叠了（`node_modules/` 里面、`dist/server` 之类）；
   * - 这是一个 **submodule**，父仓库的 `ls-files` 对它只有一条 gitlink 记录（`selfKind`）。
   *
   * 写成「空就兜底」时它是个 catch-all：`?path=<一个文件>` 与 `?path=<不存在的路径>` 同样
   * 落进来，`readdir` 抛 `ENOTDIR` / `ENOENT` 被咽掉，页面上是一个「展开后是空的目录」——
   * 而它们本该是 400 / 404。**为了不吞掉 `EACCES` 而加的那道 code 过滤，本身就是在给一个过宽
   * 的开关打补丁**；判据换成正面证据之后，那道过滤连同它一起没了。
   *
   * 这里读磁盘不需要任何 git 知识，这正是它成立的理由：两条证据都说明整棵子树同属一档，于是
   * 每个子项的 `ignored` 直接继承（submodule 那一路继承「不灰显」）。`withFileTypes` 的
   * dirent 不跟随符号链接（`isDirectory()` 对指向目录的链接为 false），而 `dir` 自己那一段
   * 已经由上面那道 `follow: true` 的边界验过。
   */
  // 把一个文件当目录展开是坏请求。**必须在兜底之前判**：不然它会掉进 `readdir`，以
  // `ENOTDIR` 收场，而那时唯一诚实的答案已经丢了
  if (selfKind === 'file') throw new WorktreeError('invalid-path', 'not a directory');

  if (byName.size === 0 && (collapsedAs !== null || selfKind === 'gitlink')) {
    const inherited = collapsedAs ?? false;
    for (const child of await readdir(abs, { withFileTypes: true })) {
      // **`.git` 要自己滤掉**：git 的输出里它从来不出现，而这条兜底会在一个刚 `git init`、
      // 什么都没有的仓库根上生效——那时树的第一行就会是 `.git`。名字判据不限层级：
      // submodule 与 linked worktree 底下那个 `.git` 是文件，同样不该画出来
      if (child.name === '.git') continue;
      byName.set(child.name, {
        name: child.name,
        path: `${prefix}${child.name}`,
        kind: child.isDirectory() ? 'directory' : 'file',
        ignored: inherited,
      });
    }
  }

  const entries = [...byName.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  /**
   * **回的是完整 payload，`path` 用归一后的那份。** http 那层因此只负责发，与 `/api/diff`、
   * `/api/file` 一致；先前由 http 拿客户端原样传来的 query 去拼，既不对称，也让「归一化」
   * 这件事没有 owner。
   */
  return { path, entries };
}
