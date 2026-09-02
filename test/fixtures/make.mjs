#!/usr/bin/env node
// 测试仓库生成脚本。
//
// 零依赖纯 JS，可由 `node test/fixtures/make.mjs [目标目录]` 直接执行：它要在没有 pnpm、没有
// node_modules 的 CI matrix 机器上跑。对测试仓库执行的 git init / add / commit 属「开发流程的
// git」，不受零写操作约束。
//
// 选取标准是**决定解析器结构，不是边界修补**：这些样本分别决定 `-z` 与 `core.quotePath=false`
// 是否真的生效、解析循环是有状态还是无状态平铺、`# branch.ab` 缺失的降级路径、diff 基准的接口
// 形状、「已跟踪走 git diff / 未跟踪读磁盘」那次分流，以及 diff 边界与 git 异常状态两批。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 生成期的 git 环境。身份走环境变量而不是 `git config`，不必在每个仓库里重复写一遍；
 * `GIT_CONFIG_NOSYSTEM` + 不存在的 `GIT_CONFIG_GLOBAL` 让生成结果不受这台机器的全局配置影响——
 * 某人开了 `diff.renames=false`，fixture 就会在他机器上长得不一样，而断言是逐字的。
 */
function fixtureEnv(destDir) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(destDir, 'no-such-gitconfig'),
    GIT_AUTHOR_NAME: 'difftab Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'difftab Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  };
}

/** 含双引号的文件名在 Windows 上**非法**，照写会让整个生成流程在 Windows 档炸掉。 */
const WINDOWS = process.platform === 'win32';

/**
 * 未跟踪符号链接的目标内容。链接**故意指向仓库外**，而 diff 里绝不该出现这一行——
 * 出现即意味着读磁盘那条路又跟随了链接（见 deletions 仓库的注释）。
 */
export const OUTSIDE_SECRET = 'SHOULD-NEVER-APPEAR-IN-ANY-DIFF';

/**
 * 路径转义那条验收项的样本：非 ASCII、空格、引号各来一个。最后那个**通配符文件名**不是凑数：
 * `git diff -- <路径>` 的路径默认按 wildmatch 解释，于是它会匹配到 `docs/starlight.md` 上——
 * 页面在 A 的标题下显示 B 的补丁。`*` 与双引号一样在 Windows 上非法，只在 POSIX 上放。
 */
export const TRICKY_PATHS = [
  'docs/需求 文档.md',
  'docs/ドキュメント.md',
  'docs/🚀 rocket.md',
  "docs/it's fine.md",
  ...(WINDOWS ? [] : ['docs/she "said".md', 'docs/star*.md']),
];

/** 全部仓库名。既是 `only` 的校验表，也是「没生成的仓库」那几个报错 getter 的清单。 */
export const ALL_REPOS = [
  'unicodePaths',
  'renames',
  'staged',
  'deletions',
  'noUpstream',
  'upstreamTracking',
  'empty',
  'manyFiles',
  'diffEdges',
  'detachedHead',
  'mergeConflict',
  'rebaseInProgress',
  'linkedWorktree',
  'submodule',
  'bare',
  'sha256Empty',
];

/**
 * 二进制内容。**判据是 NUL 字节**：已跟踪那一侧由 git 自己认（numstat 输出 `-\t-`），未跟踪那一
 * 侧由我们自己探。前面那八个字节是 PNG 魔数，只为让 fixture 一眼看得出想扮演什么。
 */
function binaryBytes(seed) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x01, 0x02, 0x00]),
    Buffer.from(seed, 'utf8'),
    Buffer.from([0x00]),
  ]);
}

/**
 * 两个阈值各自的超标量。**唯一事实来源是 `src/server/git/diff.ts`，这里只是「远超」**——断言压
 * 在 `kind` / `reason` 上，不压在数字上；阈值调大到超过这两个值时集成用例会**变红**而不是变绿。
 */
const OVER_SIZE_BYTES = 6 * 1024 * 1024;
const OVER_LINE_COUNT = 60_000;

/**
 * 生成测试仓库。`only` 给出需要哪几个（省略即全部）。加它是因为整套 16 个仓库要跑一百多次 git、
 * 约 1.5s，其中 `manyFiles` 一个就占五分之一，而**没有任何一个冒烟文件打开它**——冒烟文件各在
 * 自己的进程里建一次，这笔开销在 CI 的 9 档矩阵上要逐档重付。
 */
export function makeFixtures(destDir, only) {
  const dest = resolve(destDir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const env = fixtureEnv(dest);

  for (const name of only ?? []) {
    if (!ALL_REPOS.includes(name)) throw new Error(`未知的 fixture 仓库：${name}`);
  }
  const wanted = (name) => only === undefined || only.includes(name);

  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const write = (cwd, relPath, content) => {
    const file = join(cwd, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  /**
   * `count` 行文本，**带尾部换行**。少了它 git 会在补丁末尾多一条 `\ No newline at end of file`，
   * 而 renames 仓库是量相似度的——多出来的这一行会把 `R` 后面那个百分比顶掉一档。
   */
  const lines = (count, render) =>
    `${Array.from({ length: count }, (_, i) => render(i)).join('\n')}\n`;

  // `extra` 给 `--bare` / `--object-format=sha256` 这类只有个别仓库要的 init 参数
  const init = (name, ...extra) => {
    const cwd = join(dest, name);
    mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '--quiet', '--initial-branch=main', ...extra);
    // 换行归一化关掉：开着的话 Windows 上 checkout 把 LF 换成 CRLF，断言全部错位
    git(cwd, 'config', 'core.autocrlf', 'false');
    return cwd;
  };

  const commit = (cwd, message) => {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', message);
  };

  /**
   * 制造冲突的那几条命令(`merge` / `rebase` / `cherry-pick`)**必然以 1 退出**——冲突就是要的结
   * 果。但「咽掉退出码」到此为止：每个用它的地方紧接着都要 `expectPath` 一条痕迹，少了那一步，
   * git 换个行为时仓库会安静地停在**没有冲突**的状态上。
   */
  const gitMayFail = (cwd, ...args) => {
    try {
      git(cwd, ...args);
    } catch {
      // 见上
    }
  };

  /** 上一条的正面断言：那个状态文件真的留下了。 */
  const expectPath = (cwd, segments, why) => {
    if (existsSync(join(cwd, ...segments))) return;
    throw new Error(`fixture ${cwd} 缺少 ${segments.join('/')}——${why}`);
  };

  /**
   * 一条会冲突的分叉，merge 与 rebase 两个「进行中」的 fixture 都从这里长出来——两处各写一遍的
   * 话，改动其中一处会让两者停在不同的冲突形态上。
   */
  const diverge = (cwd) => {
    write(cwd, 'conflict.txt', 'base\n');
    write(cwd, 'kept.txt', 'no conflict here\n');
    commit(cwd, 'base');
    git(cwd, 'checkout', '--quiet', '-b', 'side');
    write(cwd, 'conflict.txt', 'side\n');
    commit(cwd, 'side changes the line');
    git(cwd, 'checkout', '--quiet', 'main');
    write(cwd, 'conflict.txt', 'main\n');
    commit(cwd, 'main changes the same line');
  };

  const repos = {};

  // 1. 路径含非 ASCII / 空格 / 引号——验 `-z` 与 `core.quotePath=false` 是否真的都生效
  if (wanted('unicodePaths')) {
    const cwd = init('unicode-paths');
    for (const path of TRICKY_PATHS) write(cwd, path, 'one\ntwo\nthree\n');
    // `docs/star*.md` 的**陪衬**：通配符要匹配到别人身上得先有个别人，而且它必须**同样已跟踪且已
    // 改动**。内容里那句话是判据：它出现在 `star*.md` 的补丁里，就说明路径被当成了模式
    if (!WINDOWS) write(cwd, 'docs/starlight.md', 'plain\n');
    commit(cwd, 'add files with tricky paths');
    for (const path of TRICKY_PATHS) write(cwd, path, 'one\ntwo modified\nthree\n');
    if (!WINDOWS) write(cwd, 'docs/starlight.md', 'MATCHED-BY-WILDCARD-NOT-BY-NAME\n');
    write(cwd, 'docs/未跟踪 文件.md', 'brand new\n');
    // 整个目录都未跟踪——这是 `-uall` 唯一能被证伪的形态：少了它 git 把它折叠成一行
    // `? 未跟踪目录/`。上面那个未跟踪文件在已跟踪的 `docs/` 里，折不折叠都长一样，证不了这条
    write(cwd, '未跟踪目录/a.md', 'nested one\n');
    write(cwd, '未跟踪目录/sub/b.md', 'nested two\n');
    repos.unicodePaths = cwd;
  }

  // 2. 重命名——验解析循环是有状态的：`2 ` 记录占**两个** NUL 段。同时给一个落在相似度阈值之下
  //    的例子，git 把它报成 D + A 而不是 R，前端的「重命名」标注不该在那里出现
  if (wanted('renames')) {
    const cwd = init('renames');
    write(
      cwd,
      'src/kept.txt',
      lines(20, (i) => `line ${i}`),
    );
    write(
      cwd,
      'src/rewritten.txt',
      lines(20, (i) => `old ${i}`),
    );
    write(
      cwd,
      'src/unpaired-a.txt',
      lines(20, (i) => `keep ${i}`),
    );
    commit(cwd, 'add files to rename');

    // 高相似度：git mv + 一行小改 → R9x
    git(cwd, 'mv', 'src/kept.txt', 'src/kept-renamed.txt');
    write(
      cwd,
      'src/kept-renamed.txt',
      lines(20, (i) => (i === 3 ? 'line three, edited' : `line ${i}`)),
    );
    // 低相似度：改名 + 内容全部重写，**且一并 add**。必须 add 才落在阈值之下——status 的重命名检
    // 测比的是 HEAD → index，重写留在工作区时 index 里躺着的仍是一次 100% 纯改名
    git(cwd, 'mv', 'src/rewritten.txt', 'src/rewritten-renamed.txt');
    write(
      cwd,
      'src/rewritten-renamed.txt',
      lines(20, (i) => `completely different content ${i}`),
    );
    git(cwd, 'add', '-A', 'src/rewritten-renamed.txt');

    // **status 说是重命名、`git diff -M` 却配不上对**的那一档：`git mv` 之后把内容全部重写、**留
    // 在工作区不 add**，于是 status 照报 `R100`（条目带 oldPath），而 `diff -M` 把它拆成「删旧」+
    // 「增新」两条 numstat 记录。行数刻意超过 50,000：按下标取记录的写法会拿到旧文件那条几十行的
    // 删除，行数闸放行，一份 6 万行的补丁照旧发给浏览器
    git(cwd, 'mv', 'src/unpaired-a.txt', 'src/unpaired-z.txt');
    write(
      cwd,
      'src/unpaired-z.txt',
      lines(OVER_LINE_COUNT, (i) => `nothing alike ${i}`),
    );
    repos.renames = cwd;
  }

  // 3. 已暂存改动——验双状态位，也正是 diff 基准取 `git diff HEAD` 而不是 `git diff` 的理由
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

  // 3b. 删除 + 未跟踪符号链接——决定「已跟踪 / 未跟踪」那次分流的判据本身
  if (wanted('deletions')) {
    const cwd = init('deletions');
    write(cwd, 'staged-deleted.txt', 'gone from the index\n');
    write(cwd, 'worktree-deleted.txt', 'gone from the worktree\n');
    write(cwd, 'kept.txt', 'still here\n');
    commit(cwd, 'add files to delete');

    // 已暂存的删除：`git rm` 把路径从 **index** 里摘掉了，`git ls-files` 对它输出为空，而 status
    // 仍报 `1 D.`——只认 index 的分流判据会把它当成未跟踪去读磁盘，以「文件不存在」告终
    git(cwd, 'rm', '--quiet', 'staged-deleted.txt'); // X=D Y=.
    // 未暂存的删除：index 里还在，`ls-files` 看得到——上一条的对照面
    rmSync(join(cwd, 'worktree-deleted.txt')); // X=. Y=D

    // 未跟踪的符号链接：`git status -uall` 报 `? <链接>`，git 给的是 mode 120000、正文是**链接目
    // 标字符串本身**。目标故意落在仓库外：读磁盘那条路一旦用回 stat,OUTSIDE_SECRET 就会进补丁
    if (!WINDOWS) {
      // Windows 上建符号链接需要开发者模式或管理员权限，不能作为 fixture 的前提
      const outside = join(dest, 'outside-secret.txt');
      writeFileSync(outside, `${OUTSIDE_SECRET}\n`);
      symlinkSync(outside, join(cwd, 'link-to-outside'));
    }
    repos.deletions = cwd;
  }

  // 4. 无上游的新建分支——**不输出 `# branch.ab` 行**，此时必须展示「无上游」而不是 0/0
  if (wanted('noUpstream')) {
    const cwd = init('no-upstream');
    write(cwd, 'readme.txt', 'hello\n');
    commit(cwd, 'initial');
    git(cwd, 'checkout', '--quiet', '-b', 'feature/no-upstream');
    write(cwd, 'readme.txt', 'hello there\n');
    repos.noUpstream = cwd;
  }

  // 4b. 有上游、且 ahead/behind 都非零——上一项的对照面。没有它，「解析 `# branch.ab`」这条路径
  //     一次都走不到，而那时 upstream 恒为 null 的实现看起来一样绿
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

  // 5. 空仓库——HEAD 不存在、`git diff HEAD` 直接 fatal，基准须降级为空树哈希。**放一个已 add
  //    的文件**：否则全是未跟踪，空树基准那条路径一次都走不到
  if (wanted('empty')) {
    const cwd = init('empty');
    write(cwd, 'staged-before-first-commit.txt', 'no commits yet\n');
    git(cwd, 'add', 'staged-before-first-commit.txt');
    write(cwd, 'untracked.txt', 'also here\n');
    repos.empty = cwd;
  }

  // 6. 300+ 文件变更——验懒加载（agent 单次改 300+ 文件是常态）
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

  // 7. diff 边界：新增 / 二进制 / 超大 / 超多行——这一批决定的是**取 diff 之前那道判定**
  if (wanted('diffEdges')) {
    const cwd = init('diff-edges');
    // 三者都要有「改前」的一面，否则它们只是新增文件，已跟踪那条判定路径一次都走不到
    write(cwd, 'assets/icon.bin', binaryBytes('v1'));
    write(cwd, 'huge.txt', 'small for now\n');
    write(cwd, 'wide.txt', 'small for now\n');
    // **大文件 + 小改动**：6MB 出头但只改一行。按「文件多大」拒绝的写法会把它一并挡掉，而它的补
    // 丁只有几 KB——这是「卡补丁字节数而不是文件字节数」唯一能被证伪的形态
    const bulkyLine = 'x'.repeat(1023);
    write(
      cwd,
      'bulky.txt',
      lines(6 * 1024, (i) => (i === 3000 ? `${i}: before` : bulkyLine)),
    );
    commit(cwd, 'add a binary, two small files and one bulky file');

    write(
      cwd,
      'bulky.txt',
      lines(6 * 1024, (i) => (i === 3000 ? `${i}: after` : bulkyLine)),
    );

    // 已跟踪的二进制变更——git 自己（含 .gitattributes）的判定，numstat 输出 `-\t-`
    write(cwd, 'assets/icon.bin', binaryBytes('v2 with different length'));

    // **两个阈值刻意各自只被一个文件触发，互为对照**：huge.txt 是「一行 6MB」，行数阈值挡不住
    // 它；wide.txt 是「60,000 行短文本」约 700KB，体积阈值挡不住它，而前端只拿到体积时会显示「文
    // 件过大(0 MB)」
    write(cwd, 'huge.txt', `${'x'.repeat(OVER_SIZE_BYTES)}\n`);
    write(
      cwd,
      'wide.txt',
      lines(OVER_LINE_COUNT, (i) => `line ${i}`),
    );

    // 未跟踪的对照面：同样两类，走的却是另一条判定路径（NUL 探测 + lstat 体积）
    write(cwd, 'untracked.bin', binaryBytes('never committed'));
    write(cwd, 'untracked-huge.txt', `${'y'.repeat(OVER_SIZE_BYTES)}\n`);

    // 已暂存的新增文件(X=A)：走的是 git diff，与未跟踪的新文件（手工构造）是两条代码路径
    write(cwd, 'added-staged.txt', 'brand new line one\nbrand new line two\n');
    git(cwd, 'add', 'added-staged.txt');
    repos.diffEdges = cwd;
  }

  // 8. git 异常状态。这一批要证的不是「解析对不对」也不是「拦不拦得住」，而是**这些仓库形态下工
  //    具还能不能正常工作**，以及分支状态那一栏说的是不是实话

  // 8a. detached HEAD——`# branch.head` 给的是字面量 `(detached)`，原样画出去等于凭空多一个分支
  if (wanted('detachedHead')) {
    const cwd = init('detached-head');
    write(cwd, 'a.txt', 'one\n');
    commit(cwd, 'first');
    write(cwd, 'a.txt', 'two\n');
    commit(cwd, 'second');
    git(cwd, 'checkout', '--quiet', '--detach', 'HEAD~1');
    // 留下改动：没有它这个仓库在列表那一侧是空的，而「分支状态之外一切照常」是本项的另一半
    write(cwd, 'a.txt', 'edited while detached\n');
    write(cwd, 'untracked-while-detached.txt', 'brand new\n');
    repos.detachedHead = cwd;
  }

  // 8b. merge 进行中（冲突停下）——`MERGE_HEAD` + 一条 `u UU` 记录。冲突条目是**三个分组谓词唯一
  //     无法从 XY 读出来的东西**：两位都不是 `.`，不单独成组就会同时落进两组
  if (wanted('mergeConflict')) {
    const cwd = init('merge-conflict');
    diverge(cwd);
    gitMayFail(cwd, 'merge', 'side');
    expectPath(cwd, ['.git', 'MERGE_HEAD'], 'git merge 没有停在冲突上，这个 fixture 就是空的');
    repos.mergeConflict = cwd;
  }

  // 8c. rebase 进行中（冲突停下）——`rebase-merge/`，**同时**还有 merge 留下的 `MERGE_MSG` /
  //     `AUTO_MERGE`，这正是判据表要「rebase 先判」的理由；此时 status 报的也是 `(detached)`
  if (wanted('rebaseInProgress')) {
    const cwd = init('rebase-in-progress');
    diverge(cwd);
    gitMayFail(cwd, 'rebase', 'side');
    expectPath(cwd, ['.git', 'rebase-merge'], 'git rebase 没有停在冲突上，这个 fixture 就是空的');
    repos.rebaseInProgress = cwd;
  }

  // 8d. linked worktree——`.git` 是**文件**不是目录，真正的 git 目录在
  //     `<主仓库>/.git/worktrees/<名>`；按 `<root>/.git` 拼路径的写法在这里永远读不到，且不报错
  if (wanted('linkedWorktree')) {
    const main = init('worktree-main');
    write(main, 'shared.txt', 'v1\n');
    commit(main, 'initial');
    const cwd = join(dest, 'worktree-linked');
    git(main, 'worktree', 'add', '--quiet', '-b', 'wt', cwd);
    write(cwd, 'shared.txt', 'changed in the linked worktree\n');
    write(cwd, 'only-here.txt', 'brand new\n');
    repos.linkedWorktree = cwd;
  }

  // 8e. submodule——同上的另一种形态：git 目录在 `<父仓库>/.git/modules/<路径>`。
  //     返回的是**子模块自己的工作区**（用户在里面敲命令的那个目录）
  if (wanted('submodule')) {
    const child = init('submodule-child');
    write(child, 'child.txt', 'c1\n');
    commit(child, 'child initial');

    const parent = init('submodule-parent');
    write(parent, 'parent.txt', 'p1\n');
    commit(parent, 'parent initial');
    // 本地路径的 submodule 自 git 2.38(CVE-2022-39253)起默认被拒，生成期显式放开一次
    const url = '../submodule-child';
    git(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      url,
      'vendor/child',
    );
    commit(parent, 'add the submodule');

    const cwd = join(parent, 'vendor', 'child');
    write(cwd, 'child.txt', 'changed inside the submodule\n');
    write(cwd, 'untracked-in-submodule.txt', 'brand new\n');
    repos.submodule = cwd;
  }

  // 8f. bare 仓库——`rev-parse --show-toplevel` 直接以 128 退出，要的是一句话拒绝，不是崩溃
  if (wanted('bare')) {
    repos.bare = init('bare.git', '--bare');
  }

  // 8g. SHA-256 的空仓库——空树哈希那个常量的实测来源。同样放一个已 add 的文件
  if (wanted('sha256Empty')) {
    const cwd = init('sha256-empty', '--object-format=sha256');
    write(cwd, 'staged-before-first-commit.txt', 'no commits yet, and sha-256 at that\n');
    git(cwd, 'add', 'staged-before-first-commit.txt');
    repos.sha256Empty = cwd;
  }

  // 没生成的仓库不能是 undefined：调用方会拿着它去 spawn,cwd 变成进程当前目录，
  // 报出来的错与真正的原因（「你没把这个仓库列进 only」）八竿子打不着
  for (const name of ALL_REPOS) {
    if (name in repos) continue;
    Object.defineProperty(repos, name, {
      get() {
        throw new Error(`fixture 仓库 ${name} 没有生成——把它加进 makeFixtures 的 only 参数`);
      },
    });
  }

  return repos;
}

// 直接执行时写进默认目录（已在 .gitignore 里）。用 pathToFileURL / fileURLToPath 而不是手拼
// `file://`:Windows 上盘符路径两头都对不上，而这个脚本在 matrix 的 Windows 档要跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? fileURLToPath(new URL('./repos/', import.meta.url));
  const repos = makeFixtures(target);
  for (const [name, path] of Object.entries(repos)) console.log(`${name.padEnd(18)} ${path}`);
}
