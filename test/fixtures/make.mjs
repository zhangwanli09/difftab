#!/usr/bin/env node
// 测试仓库生成脚本 —— **第一批(S1)**(spec §7 末段)。
//
// 零依赖纯 JS,可由 `node test/fixtures/make.mjs [目标目录]` 直接执行:它要在没有
// pnpm、没有 node_modules 的 CI matrix 机器上跑,`pnpm fixtures` 只是别名(§5.11)。
//
// 本脚本对测试仓库执行的 git init / add / commit 属「开发流程的 git」,不受 §4.1
// 零写操作约束(作用域见 CLAUDE.md 第 1 节)。
//
// 第一批的选取标准是**决定解析器结构,不是边界修补**:这几项分别决定 §5.2 的 `-z`
// 与 `core.quotePath=false` 是否真的生效、解析循环是有状态还是无状态平铺、
// `# branch.ab` 缺失的降级路径、以及 §5.3 的 diff 基准该做成怎样的接口形状。
// 删除与未跟踪符号链接按同一判据从第二批上调进来 —— 它们决定的是「已跟踪走
// git diff / 未跟踪读磁盘」那次分流本身(spec §7 末段有修订记录)。
// 第二批(S4)是新增/二进制/超大文件/detached HEAD/rebase/worktree/bare。

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 生成期的 git 环境。
 *
 * 身份走环境变量而不是 `git config`,这样不必在每个仓库里重复写一遍;
 * `GIT_CONFIG_NOSYSTEM` + 指向一个不存在的 `GIT_CONFIG_GLOBAL`,是为了让生成结果
 * 不受跑测试这台机器的全局配置影响 —— 某人全局开了 `diff.renames=false` 或
 * `core.quotePath` 的变体,fixture 就会在他机器上长得不一样,而测试断言是逐字的。
 */
function fixtureEnv(destDir) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(destDir, 'no-such-gitconfig'),
    GIT_AUTHOR_NAME: 'GitGlance Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'GitGlance Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  };
}

/**
 * 含双引号的文件名在 Windows 上是**非法的**(`"` 属保留字符),照写会让整个
 * 生成流程在 Windows 档炸掉。单引号、空格、非 ASCII 三端都合法,留着。
 */
const WINDOWS = process.platform === 'win32';

/**
 * 未跟踪符号链接的目标内容。链接**故意指向仓库外**,而 diff 里绝不该出现这一行 ——
 * 出现即意味着读磁盘那条路又跟随了链接(见 deletions 仓库的注释)。
 */
export const OUTSIDE_SECRET = 'SHOULD-NEVER-APPEAR-IN-ANY-DIFF';

/** 路径转义那条验收项的样本:非 ASCII、空格、引号各来一个(§6)。 */
export const TRICKY_PATHS = [
  'docs/需求 文档.md',
  'docs/ドキュメント.md',
  'docs/🚀 rocket.md',
  "docs/it's fine.md",
  ...(WINDOWS ? [] : ['docs/she "said".md']),
];

/**
 * 全部仓库名。既是 `only` 的校验表,也是「没生成的仓库」那几个报错 getter 的清单。
 */
export const ALL_REPOS = [
  'unicodePaths',
  'renames',
  'staged',
  'deletions',
  'noUpstream',
  'upstreamTracking',
  'empty',
  'manyFiles',
];

/**
 * 生成测试仓库。`only` 给出需要哪几个(省略即全部)。
 *
 * 加 `only` 是因为整套要跑 30 多次 git、约 600ms,其中 `manyFiles` 一个就占三分之一
 * (640 次写 + 对 320 个路径 `git add -A`),而**没有任何一个冒烟文件打开它**。
 * 三个冒烟文件各在自己的进程里建一次(`node --test` 一文件一进程,memo 共享不了),
 * 这笔开销在 CI 的 9 档矩阵上要付 27 次,Windows 上 git 起进程还要慢上数倍。
 */
export function makeFixtures(destDir, only) {
  const dest = resolve(destDir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const env = fixtureEnv(dest);

  for (const name of only ?? []) {
    if (!ALL_REPOS.includes(name)) throw new Error(`未知的 fixture 仓库:${name}`);
  }
  const wanted = (name) => only === undefined || only.includes(name);

  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const write = (cwd, relPath, content) => {
    const file = join(cwd, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const init = (name) => {
    const cwd = join(dest, name);
    mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '--quiet', '--initial-branch=main');
    // 换行归一化关掉:开着的话 Windows 上 checkout 会把 LF 换成 CRLF,
    // 于是「刚 clone 出来就有一堆 M」,断言全部错位
    git(cwd, 'config', 'core.autocrlf', 'false');
    return cwd;
  };

  const commit = (cwd, message) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', message);
  };

  const repos = {};

  // 1. 路径含非 ASCII / 空格 / 引号 —— 验 §5.2 的 `-z`(列表)与
  //    `core.quotePath=false`(补丁正文头部行)是否真的都生效
  if (wanted('unicodePaths')) {
    const cwd = init('unicode-paths');
    for (const path of TRICKY_PATHS) write(cwd, path, 'one\ntwo\nthree\n');
    commit(cwd, 'add files with tricky paths');
    for (const path of TRICKY_PATHS) write(cwd, path, 'one\ntwo modified\nthree\n');
    write(cwd, 'docs/未跟踪 文件.md', 'brand new\n');
    // 整个目录都未跟踪 —— 这是 `-uall` 唯一能被证伪的形态:少了它,git 把它折叠成
    // 一行 `? 未跟踪目录/`,列表里只剩一个点不开的目录条目(§5.2 / §6)。
    // 上面那个未跟踪文件在 `docs/` 里,而 `docs/` 已被跟踪,折不折叠都长一样,
    // 证不了这条
    write(cwd, '未跟踪目录/a.md', 'nested one\n');
    write(cwd, '未跟踪目录/sub/b.md', 'nested two\n');
    repos.unicodePaths = cwd;
  }

  // 2. 重命名 —— 验解析循环是有状态的:`2 ` 记录占**两个** NUL 段。
  //    同时给出一个改动过大、落在相似度阈值(默认 50%)之下的例子,
  //    git 会把它报成 D + A 而不是 R,前端的「重命名」标注不该在那里出现
  if (wanted('renames')) {
    const cwd = init('renames');
    write(cwd, 'src/kept.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
    write(
      cwd,
      'src/rewritten.txt',
      Array.from({ length: 20 }, (_, i) => `old ${i}`).join('\n') + '\n',
    );
    commit(cwd, 'add files to rename');

    // 高相似度:git mv + 一行小改 → R9x
    git(cwd, 'mv', 'src/kept.txt', 'src/kept-renamed.txt');
    write(
      cwd,
      'src/kept-renamed.txt',
      Array.from({ length: 20 }, (_, i) => (i === 3 ? 'line three, edited' : `line ${i}`)).join(
        '\n',
      ) + '\n',
    );
    // 低相似度:改名 + 内容全部重写,**且一并 add**。
    // 必须 add 才落在阈值之下:status 的重命名检测比的是 HEAD → index,`git mv` 之后
    // 若把重写留在工作区,index 里躺着的仍是一次 100% 纯改名,git 照样报 `2 R100`
    // (只是 Y 位变成 M)。不 add 就得不到「阈值之下 → 拆成删除 + 新增」这个对照面
    git(cwd, 'mv', 'src/rewritten.txt', 'src/rewritten-renamed.txt');
    write(
      cwd,
      'src/rewritten-renamed.txt',
      Array.from({ length: 20 }, (_, i) => `completely different content ${i}`).join('\n') + '\n',
    );
    git(cwd, 'add', '-A', 'src/rewritten-renamed.txt');
    repos.renames = cwd;
  }

  // 3. 已暂存改动 —— 验双状态位。agent 执行过 `git add` 后,已暂存的改动仍要能
  //    展示不遗漏,这正是 diff 基准取 `git diff HEAD` 而不是 `git diff` 的理由
  if (wanted('staged')) {
    const cwd = init('staged');
    write(cwd, 'a.txt', 'a1\n');
    write(cwd, 'b.txt', 'b1\n');
    write(cwd, 'c.txt', 'c1\n');
    commit(cwd, 'add three files');

    write(cwd, 'a.txt', 'a1 staged\n');
    git(cwd, 'add', 'a.txt'); // X=M Y=.
    write(cwd, 'b.txt', 'b1 unstaged\n'); // X=. Y=M
    write(cwd, 'c.txt', 'c1 staged\n');
    git(cwd, 'add', 'c.txt');
    write(cwd, 'c.txt', 'c1 staged then changed again\n'); // X=M Y=M
    write(cwd, 'd.txt', 'brand new, staged\n');
    git(cwd, 'add', 'd.txt'); // X=A Y=.
    repos.staged = cwd;
  }

  // 3b. 删除 + 未跟踪符号链接 —— 决定「已跟踪 / 未跟踪」那次分流的判据本身(§7 末段)
  if (wanted('deletions')) {
    const cwd = init('deletions');
    write(cwd, 'staged-deleted.txt', 'gone from the index\n');
    write(cwd, 'worktree-deleted.txt', 'gone from the worktree\n');
    write(cwd, 'kept.txt', 'still here\n');
    commit(cwd, 'add files to delete');

    // 已暂存的删除:`git rm` 把路径从 **index** 里摘掉了,于是 `git ls-files` 对它
    // 输出为空(已实测),而 status 仍报 `1 D.`、`git diff HEAD` 仍给得出完整补丁。
    // 只认 index 的分流判据会在这里把它当成未跟踪文件去读磁盘,以「文件不存在」告终
    git(cwd, 'rm', '--quiet', 'staged-deleted.txt'); // X=D Y=.
    // 未暂存的删除:index 里还在,`ls-files` 看得到 —— 上一条的对照面
    rmSync(join(cwd, 'worktree-deleted.txt')); // X=. Y=D

    // 未跟踪的符号链接。`git status -uall` 把它报成 `? <链接>`,所以它进变更列表、
    // 用户点得到;git 给的是 mode 120000、正文是**链接目标字符串本身**。
    // 目标故意落在仓库外且内容已知:读磁盘那条路一旦用回 stat(跟随链接),
    // OUTSIDE_SECRET 就会出现在补丁里,断言当即报红
    if (!WINDOWS) {
      // Windows 上建符号链接需要开发者模式或管理员权限,不能作为 fixture 的前提
      const outside = join(dest, 'outside-secret.txt');
      writeFileSync(outside, `${OUTSIDE_SECRET}\n`);
      symlinkSync(outside, join(cwd, 'link-to-outside'));
    }
    repos.deletions = cwd;
  }

  // 4. 无上游的新建分支 —— **不输出 `# branch.ab` 行**(已实测)。
  //    此时必须展示「无上游」而不是 0/0,更不能因取不到字段而崩溃
  if (wanted('noUpstream')) {
    const cwd = init('no-upstream');
    write(cwd, 'readme.txt', 'hello\n');
    commit(cwd, 'initial');
    git(cwd, 'checkout', '--quiet', '-b', 'feature/no-upstream');
    write(cwd, 'readme.txt', 'hello there\n');
    repos.noUpstream = cwd;
  }

  // 4b. 有上游、且 ahead/behind 都非零 —— 上一项的对照面。
  //     没有它,「解析 `# branch.ab`」这条路径在整个 fixture 集里一次都走不到,
  //     而那时 upstream 恒为 null 的实现看起来一样绿
  if (wanted('upstreamTracking')) {
    const origin = init('upstream-origin');
    write(origin, 'shared.txt', 'v1\n');
    commit(origin, 'initial');

    const cwd = join(dest, 'upstream-tracking');
    git(dest, 'clone', '--quiet', origin, cwd);
    git(cwd, 'config', 'core.autocrlf', 'false');
    write(cwd, 'local.txt', 'local work\n');
    commit(cwd, 'local commit 1');
    write(cwd, 'local.txt', 'local work, more\n');
    commit(cwd, 'local commit 2'); // ahead 2

    write(origin, 'shared.txt', 'v2\n');
    commit(origin, 'upstream moved'); // behind 1
    git(cwd, 'fetch', '--quiet', 'origin');
    write(cwd, 'local.txt', 'uncommitted tweak\n');
    repos.upstreamTracking = cwd;
  }

  // 5. 空仓库(`git init` 后无提交)—— HEAD 不存在,`git diff HEAD` 直接 fatal,
  //    diff 基准须降级为空树哈希(§5.3)。**放一个已 add 的文件**:否则全是未跟踪,
  //    空树基准那条路径一次都走不到,而它正是本项要证的东西
  if (wanted('empty')) {
    const cwd = init('empty');
    write(cwd, 'staged-before-first-commit.txt', 'no commits yet\n');
    git(cwd, 'add', 'staged-before-first-commit.txt');
    write(cwd, 'untracked.txt', 'also here\n');
    repos.empty = cwd;
  }

  // 6. 300+ 文件变更 —— S2 验收懒加载时即需就位(agent 单次改 300+ 文件是常态)
  if (wanted('manyFiles')) {
    const cwd = init('many-files');
    for (let i = 0; i < 320; i += 1) {
      write(cwd, `pkg/mod${String(i).padStart(3, '0')}.ts`, `export const value${i} = ${i};\n`);
    }
    commit(cwd, 'add 320 files');
    for (let i = 0; i < 320; i += 1) {
      write(cwd, `pkg/mod${String(i).padStart(3, '0')}.ts`, `export const value${i} = ${i + 1};\n`);
    }
    repos.manyFiles = cwd;
  }

  // 没生成的仓库不能是 undefined:调用方会拿着它去 spawn,cwd 变成进程当前目录,
  // 报出来的错与真正的原因(「你没把这个仓库列进 only」)八竿子打不着
  for (const name of ALL_REPOS) {
    if (name in repos) continue;
    Object.defineProperty(repos, name, {
      get() {
        throw new Error(`fixture 仓库 ${name} 没有生成 —— 把它加进 makeFixtures 的 only 参数`);
      },
    });
  }

  return repos;
}

// 直接执行时写进默认目录(已在 .gitignore 里)。
// 用 pathToFileURL / fileURLToPath 而不是手拼 `file://` 与取 `.pathname` ——
// Windows 上盘符路径两头都对不上,而这个脚本在 matrix 的 Windows 档要跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? fileURLToPath(new URL('./repos/', import.meta.url));
  const repos = makeFixtures(target);
  for (const [name, path] of Object.entries(repos)) console.log(`${name.padEnd(18)} ${path}`);
}
