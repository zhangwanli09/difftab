// **主门禁**:跑一遍完整流程,断言产品只执行了只读白名单里的 git 子命令。
//
// 记录手段是 git 自带的 `GIT_TRACE=<绝对路径>`(实测依据):
// 它把每一次 git 调用连同完整参数追加进日志文件,三端同一套写法。原方案「PATH 上放
// 一个 fake git wrapper」在 Windows 上落不了地 —— Node ≥ 20.12 起不带 `shell` 就
// 拒绝 spawn `.cmd` / `.bat`,而把 node.exe 复制成 git.exe 时 node 自己会先把 argv
// 吃掉一截(`-c` 被当成 `--check`,下一个参数还被 path.resolve 改写),记到的
// 「完整子命令」是错的。两条都已实测,证据在。
//
// GIT_TRACE 比 PATH 劫持还多覆盖一层:git **内部**再起的子进程(自动 gc 之类)
// 同样会被记下来,而那正是「写进 .git/ 但不改变 status 输出」的典型 ——
// 排除「前后 git status 比对」时说的就是它。
//
// 4.1 的「零写操作」是产品核心承诺,本文件是它在开发期唯一的自动化护栏。

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import { cleanupOnExit, once, parseTrace, REPO_ROOT, runFullFlow } from './helpers.js';

/**
 * 只读白名单。
 *
 * 加一条就要问一次「它真的不写仓库吗」—— 这张表的价值全在它短。
 * `version` 是 `git --version` 在 trace 里的形态(实测)。
 */
const READ_ONLY = new Set(['version', 'rev-parse', 'status', 'diff', 'ls-files']);

/** 本文件用得到的 fixture。生成全部 16 个要 1.5s 上下,其中一半这里根本不打开。 */
const NEEDED = ['unicodePaths', 'renames', 'deletions', 'empty', 'diffEdges', 'rebaseInProgress'];

let workdir;
let tracePath;
cleanupOnExit(() => workdir);

/**
 * 跑完整流程并把 trace 日志读回来。**不用 `before()`** —— 理由见 helpers.js 的
 * `once()`:下限档 Node 22.0.0 的 runner 不等它。
 */
const trace = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'difftab-readonly-'));
  // fixture 生成本身是「开发流程的 git」,大量写操作 —— 必须在 GIT_TRACE 之外完成,
  // 否则它们会混进日志,门禁要么假红、要么被迫放宽白名单(那才是真正危险的)
  const repos = makeFixtures(join(workdir, 'repos'), NEEDED);
  tracePath = join(workdir, 'git-trace.log');

  // 六个仓库覆盖的是**六段不同的代码**,不是六份同样的流程:
  // 已跟踪 / 未跟踪 diff、重命名的双路径调用、已暂存删除那条 `--numstat` 兜底、
  // 空仓库的空树基准,二进制 / 超大那两条**不取补丁就返回**的路径,以及 S4b 的
  // 「仓库停在半路」—— 那一条尤其要跑到:一个正在 rebase 的仓库最容易诱使实现
  // 去问一句 `git rebase --show-current-patch` 之类,而那不在白名单里。
  // 少跑一个,白名单就有一段 git 调用没被看过。
  // 每个仓库单独起一次进程:仓库路径是启动参数,不能中途换
  for (const name of NEEDED) {
    // GIT_TRACE 只接受**绝对路径**;给相对路径 git 会警告并退回 stderr
    await runFullFlow(repos[name], { env: { GIT_TRACE: tracePath } });
  }

  return parseTrace(readFileSync(tracePath, 'utf8'));
});

test('劫持真的生效 —— 日志里确实记到了东西', async () => {
  // 这条不是凑数的。GIT_TRACE 没生效(路径不是绝对的、env 没传下去、
  // 产品换了个不经封装层的方式调 git)时,下面那条白名单断言会对着一个**空数组**
  // 通过 —— 而假绿的只读门禁比没有门禁更糟
  const commands = await trace();
  assert.ok(commands.length >= 8, `只记到 ${commands.length} 条 git 调用,劫持多半没生效`);

  const seen = new Set(commands.map((c) => c.subcommand));
  for (const expected of ['status', 'diff', 'rev-parse', 'ls-files']) {
    assert.ok(seen.has(expected), `完整流程里没看到 git ${expected} —— 流程没跑到位`);
  }
});

test('只出现只读白名单里的子命令', async () => {
  const commands = await trace();
  const violations = commands.filter((c) => !READ_ONLY.has(c.subcommand));
  assert.deepEqual(
    violations.map((c) => c.argv.join(' ')),
    [],
    '产品执行了白名单之外的 git 子命令 —— 4.1 的零写操作承诺被破坏',
  );
});

test('diff 调用一律带上 -c core.quotePath=false 之外的只读形态,且不含 -M 之外的写标志', async () => {
  const commands = await trace();
  const diffs = commands.filter((c) => c.subcommand === 'diff');
  assert.ok(diffs.length > 0);
  for (const diff of diffs) {
    // `git diff` 有几个会写文件的模式,一个都不该出现
    for (const forbidden of ['--output', '--ext-diff', '--no-index']) {
      assert.ok(
        !diff.argv.includes(forbidden),
        `git diff 用了 ${forbidden}:${diff.argv.join(' ')}`,
      );
    }
  }
});

test('status 的参数逐字固定 —— 降级轮询将来要复用同一条', async () => {
  const commands = await trace();
  for (const cmd of commands.filter((c) => c.subcommand === 'status')) {
    assert.deepEqual(cmd.argv, ['status', '--porcelain=v2', '--branch', '-uall', '-z']);
  }
});

test('产品代码里只有两处 child_process:git 封装层与拉起浏览器', () => {
  // 「唯一非 git 子进程豁免」那一半。fake wrapper 也好 GIT_TRACE 也好,
  // 都劫持不到非 git 的子进程,只能静态断言。
  //
  // 这条与 biome 的 noRestrictedImports 互补而非重复:lint 只看 import 说明符,
  // 换个拿到 child_process 的方式(createRequire、process.binding)就绕过去了,
  // 这里扫的是源码字面量。
  const allowed = [
    join('src', 'server', 'cli', 'browser.ts'),
    join('src', 'server', 'git', 'run.ts'),
  ];

  const using = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      const relative = full.slice(resolve(REPO_ROOT).length + 1);
      // 这里**不再**挖空模板字符串。挖空是 S0 spike 的遗留:当时 src/web 下有一份
      // 样例 diff 常量,正文里原样躺着 `import … from 'node:child_process'`,不挖空
      // 会在一个纯展示用的字符串上误报。S2a 删掉那个 spike 之后,挖空只剩坏处 ——
      // 它会先把**每个** src 文件的每段模板字符串清空再扫,于是写在模板字符串里的
      // 真调用(`require('node:child_process')`)对这道门禁彻底隐形。
      // S2b 若再引入代码形状的常量,宁可把那个常量挪出 src/,不要把门禁改钝
      const source = readFileSync(full, 'utf8');
      const uses =
        /from\s*['"]node:child_process['"]/.test(source) ||
        /require\(\s*['"](node:)?child_process['"]\s*\)/.test(source) ||
        /import\(\s*['"](node:)?child_process['"]\s*\)/.test(source);
      if (uses) using.push(relative);
    }
  };
  walk(join(REPO_ROOT, 'src'));

  // 断言的是**相等**而不是「没有多余的」:只查多的那一半时,两个文件双双改名
  // 会让白名单静默变成一张空表,门禁从此对着 0 个文件通过
  assert.deepEqual(
    using.sort(),
    allowed,
    'src/ 下 child_process 的出现位置变了 —— 架构边界不变式 1/2 要求先改文档再改代码',
  );
});
