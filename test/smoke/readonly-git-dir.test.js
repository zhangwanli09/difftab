// **第二层**：证明产品跑完一遍完整流程后，`.git` 里一个字节都没变。
//
// 与第一层（readonly.test.js 的 GIT_TRACE 白名单）互补而非重复：白名单只看「执行了哪些子命
// 令」，而 `git status` 默认会把刷新过的 stat 缓存写回 `.git/index`——那是一次货真价实的写操
// 作，子命令却仍然叫 `status`，白名单看不见；「前后 git status 比对」同样看不见（输出根本不变）。
//
// 本层由**两半**组成，缺一不可——只写 `chmod -R a-w .git` 一句是不成立的：
//
//   A. **只读 `.git` 跑通**：锁死 `.git` 再跑完整流程，凡是**会报错**的写尝试(创建对象、写
//      lock 文件、意外触发 gc)当场暴露。
//   B. **`.git` 逐字节不变**：A 挡不住的那一类在这里暴露——git 把 index 回写当作 best-effort，
//      `.git` 只读时它**静默跳过，exit 0、stderr 全空**，于是漏掉 `GIT_OPTIONAL_LOCKS=0` 时 A
//      照样全绿。B 在**可写**的 `.git` 上跑，前后各拍一次快照做逐字节比对。
//
//   B 自带一条**正面对照**：同一个仓库上直接跑一条不带 `GIT_OPTIONAL_LOCKS=0` 的 `git status`，
//   断言 `.git` 这次**确实变了**——没有它，B 会在「仓库本来就不会触发 index 回写」时对着一个恒
//   为真的断言通过。
//
// Windows:`chmod` 挡不住写入（Node 在 Windows 上只映射只读属性，对目录无效），A 半改用
// `icacls` 的拒绝 ACL；拿不到 ACL 时**显式跳过并打印原因**，不静默通过。B 半三端一律照跑。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import { cleanupOnExit, once, runFullFlow } from './helpers.js';

const WINDOWS = process.platform === 'win32';
/** Everyone。用 SID 而不是名字——本地化的 Windows 上「Everyone」是另一个词。 */
const EVERYONE = '*S-1-1-0';

/** 本文件用得到的 fixture。生成全部 16 个要 1.5s 上下，其中一半这里根本不打开。 */
const NEEDED = ['unicodePaths', 'empty', 'staged'];

/** 已经锁过的 `.git`，退出前必须逐个解锁，否则临时目录删不掉。 */
const locked = new Set();

/** 后序遍历：先访问子项、最后访问 `dir` 自己——收紧权限时顺序反了就改不动子项。 */
function walkFiles(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // 符号链接不跟进也不 chmod：那会作用到目标上，而目标可能在 .git 之外
    if (entry.isDirectory()) walkFiles(full, visit);
    else if (!entry.isSymbolicLink()) visit(full, false);
  }
  visit(dir, true);
}

function icacls(...args) {
  return spawnSync('icacls', args, { encoding: 'utf8' }).status === 0;
}

/**
 * 让 `.git` 整棵不可写。**不返回成败**：命令退出码不是判据——icacls 可以 exit 0 而 ACL 不生
 * 效，chmod 对 root 恒成功却挡不住任何写。唯一的判据是下面 `writesAreBlocked` 那个探针。
 */
function denyWrites(gitDir) {
  locked.add(gitDir);
  if (WINDOWS) {
    // /inheritance:d 先把继承来的 ACE 落成显式的，否则 deny 会被继承的 allow 盖过
    icacls(gitDir, '/inheritance:d', '/T', '/C', '/Q');
    icacls(gitDir, '/deny', `${EVERYONE}:(OI)(CI)(W)`, '/T', '/C', '/Q');
    return;
  }
  walkFiles(gitDir, (path, isDir) => chmodSync(path, isDir ? 0o555 : 0o444));
}

function restoreWrites(gitDir) {
  locked.delete(gitDir);
  if (WINDOWS) {
    icacls(gitDir, '/remove:d', EVERYONE, '/T', '/C', '/Q');
    return;
  }
  // 后序同样可行：改文件 mode 要的是属主身份而非父目录写权限，而 0o555 仍带 x，遍历读得下去
  walkFiles(gitDir, (path, isDir) => chmodSync(path, isDir ? 0o755 : 0o644));
}

/**
 * **正面验证**：锁真的锁上了。少了这一条，A 半就靠「chmod 一定生效」这个假设活着——而 root 用
 * 户、某些容器挂载、Windows 上的 chmod 全都不生效，那时用例照常变绿却什么都没验证。
 */
function writesAreBlocked(gitDir) {
  const probe = join(gitDir, 'difftab-write-probe');
  try {
    writeFileSync(probe, 'x');
  } catch {
    return true;
  }
  unlinkSync(probe);
  return false;
}

/**
 * `.git` 里每个文件的 mtime + 内容摘要。递归交给 `readdirSync` 自己做——这里只要「每个文件」。
 * 不记 size:sha256 相同时 size 不可能不同，记了只是把两个信号摆成三个。
 */
function snapshotGitDir(gitDir) {
  const out = new Map();
  for (const entry of readdirSync(gitDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const sha = createHash('sha256').update(readFileSync(full)).digest('hex');
    out.set(relative(gitDir, full), `${lstatSync(full).mtimeMs}:${sha}`);
  }
  return out;
}

function changedEntries(before, after) {
  const changed = [];
  for (const [path, value] of after) {
    if (before.get(path) !== value) changed.push(before.has(path) ? path : `${path} （新增）`);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(`${path} （删除）`);
  return changed.sort();
}

let workdir;
// 注册顺序即执行顺序：解锁必须排在 cleanupOnExit 的 rmSync 之前，否则不可写的 .git 会让临时目录
// 删不掉
process.on('exit', () => {
  for (const gitDir of [...locked]) {
    try {
      restoreWrites(gitDir);
    } catch {
      // 尽力而为——在这里抛只会盖掉真正的失败原因
    }
  }
});
cleanupOnExit(() => workdir);

/**
 * fixture 只建一次，两半共用。**不用 `before()`**：下限档 Node 22.0.0 的 runner 不等它就开跑用
 * 例（理由与复现见 helpers.js 的 `once()`）。
 */
const fixtures = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'difftab-ro-gitdir-'));
  return makeFixtures(join(workdir, 'repos'), NEEDED);
});

/** A 半：锁死 `.git` 跑完整流程。 */
const lockedRun = once(async () => {
  const repos = await fixtures();
  // 两个仓库覆盖两段不同的代码：unicodePaths 走「已跟踪取 git diff + 未跟踪读磁盘」，empty 走
  // 「HEAD 不存在 → 空树基准」——后者尤其该锁着跑一遍，探测失败时最顺手的补救多半要写 .git
  const cwds = [repos.unicodePaths, repos.empty];
  for (const cwd of cwds) denyWrites(join(cwd, '.git'));

  if (!cwds.every((cwd) => writesAreBlocked(join(cwd, '.git')))) {
    return {
      skip: WINDOWS ? 'icacls 未能施加拒绝写入的 ACL' : 'chmod 未能挡住写入（以 root 跑？）',
    };
  }

  const results = [];
  for (const cwd of cwds) results.push(await runFullFlow(cwd));

  // 锁在整个流程期间是否始终有效。放在解锁**之前**再探一次：被测进程若中途把权限
  // 改了回去（或哪天 denyWrites 变成 no-op），别的断言会全绿，只有这次复探会红
  const stillBlocked = cwds.every((cwd) => writesAreBlocked(join(cwd, '.git')));
  for (const cwd of cwds) restoreWrites(join(cwd, '.git'));
  return { results, stillBlocked };
});

/**
 * B 半：**可写**的 `.git` 上前后拍快照。先把两个「内容与 index 一致、只是 stat 过期」的文件的
 * mtime 改到很久以前——这正是 git 会去刷新 stat 缓存并回写 index 的场景。不制造它的话，`.git`
 * 本来就不会变，断言恒为真（下面那条正面对照就是用来证明它不恒为真的）。
 */
const snapshotRun = once(async () => {
  const repos = await fixtures();
  const cwd = repos.staged;
  const gitDir = join(cwd, '.git');
  // a.txt / d.txt 都是 `git add` 过的，工作区内容与 index 一致
  const stale = new Date('2020-01-01T00:00:00Z');
  for (const name of ['a.txt', 'd.txt']) utimesSync(join(cwd, name), stale, stale);

  const before = snapshotGitDir(gitDir);
  const result = await runFullFlow(cwd);
  const afterProduct = snapshotGitDir(gitDir);

  // 正面对照：同一个仓库、同一条 status 命令，但**不设** GIT_OPTIONAL_LOCKS=0。它必须把 .git 改掉
  //——否则说明这个仓库根本不会触发 index 回写，上面那条「产品没改动 .git」就是一句空话
  spawnSync('git', ['status', '--porcelain=v2', '--branch', '-uall', '-z'], {
    cwd,
    encoding: 'utf8',
    // 显式写成 1（git 的默认值）而不是继承环境：开发者机器上恰好导出了
    // GIT_OPTIONAL_LOCKS=0 时，对照组会一起噤声，红的原因就与产品无关了
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' },
  });
  const afterControl = snapshotGitDir(gitDir);

  return {
    result,
    byProduct: changedEntries(before, afterProduct),
    byControl: changedEntries(afterProduct, afterControl),
  };
});

/**
 * A 半锁不上时怎么办：Windows 允许**显式**跳过（跳过会印在 node --test 的输出里），
 * 其余平台一律红——那说明这一半什么都没覆盖到。
 */
function ensureCovered(t, skip) {
  if (!skip) return true;
  if (!WINDOWS) {
    throw new Error(`${skip}——只读 .git 这一半没有覆盖到任何东西`);
  }
  t.skip(skip);
  return false;
}

test('A · 只读 .git 下，变更列表与每个文件的 diff 都照常返回', async (t) => {
  const { skip, results } = await lockedRun();
  if (!ensureCovered(t, skip)) return;

  for (const { cwd, state, diffs } of results) {
    assert.equal(state.status, 200, `${cwd} 的 /api/state 返回了 ${state.status}:${state.body}`);
    assert.ok(JSON.parse(state.body).files.length > 0, `${cwd} 的变更列表是空的——流程没跑到位`);
    assert.ok(diffs.length > 0, `${cwd}：一个 diff 都没取，流程没跑到位`);
    for (const res of diffs) {
      assert.equal(res.status, 200, `只读 .git 下 /api/diff 返回了 ${res.status}:${res.body}`);
      // 200 但正文是个错误壳子的情况在这里拦住
      assert.equal(typeof JSON.parse(res.body).kind, 'string');
    }
  }
});

test('A · 锁在整个流程期间始终有效', async (t) => {
  const { skip, stillBlocked } = await lockedRun();
  if (!ensureCovered(t, skip)) return;
  assert.ok(stillBlocked, '流程跑完后 .git 又可写了——这一半的覆盖在中途失效了');
});

test('A · 报错里不出现 index.lock / 权限失败', async (t) => {
  const { skip, results } = await lockedRun();
  if (!ensureCovered(t, skip)) return;

  // 会**报错**的那类写尝试（创建对象、写 lock 文件）在这里被指名；静默跳过的那类交给 B 半
  for (const { cwd, stderr, state, diffs } of results) {
    const text = [stderr, state.body, ...diffs.map((d) => d.body)].join('\n');
    assert.doesNotMatch(
      text,
      /index\.lock|Permission denied|Operation not permitted|Read-only file system/i,
      `${cwd}:git 试图写 .git`,
    );
  }
});

test('B · 完整流程跑完，.git 逐字节未变', async () => {
  const { result, byProduct } = await snapshotRun();
  assert.equal(result.state.status, 200, `/api/state 返回了 ${result.state.status}`);
  assert.ok(result.diffs.length > 0, '一个 diff 都没取，流程没跑到位');
  assert.deepEqual(
    byProduct,
    [],
    '产品跑完之后 .git 变了——检查 server/git/run.ts 的 GIT_OPTIONAL_LOCKS=0。' +
      '这类写入不会让任何 git 命令失败，也不改变 status 输出，只有逐字节比对看得见',
  );
});

test('B · 正面对照：不设 GIT_OPTIONAL_LOCKS 的同一条 status 确实改了 .git', async () => {
  const { byControl } = await snapshotRun();
  // 这条红了不代表产品有问题，而是**上一条失去了意义**：仓库没能触发 index 回写，
  // 于是「产品没改 .git」是一句对谁都成立的空话——与主门禁那条「确实记到了东西」同理
  assert.notDeepEqual(
    byControl,
    [],
    '对照组也没改动 .git——这个 fixture 触发不了 index 回写，上一条断言因此是空的',
  );
});
