// 状态文件按 `git rev-parse --git-dir` 找，而**那条路径在各平台上都拼得出来**(红线，跑的是
// dist/ 产物)。
//
// 为什么非要在冒烟里再来一遍：`test/unit/server/git-integration.test.ts` 已经有 linked worktree
// / submodule 两条用例，但 (a) 单测只在 CI 的 ubuntu 档跑，而这条红线说的正是**分隔符形态**；
// (b) 那两条对操作标注的断言是负面的——**负面断言分不清「找对了地方，那里没有状态文件」与「找
// 错了地方，所以什么都没找到」**，而后者恰是这条红线要防的失效。
//
// 所以这里改成**正面**断言：往 `--git-dir` 回来的那个目录里放一个真的状态文件，要求页面把它标
// 出来。两个 fixture 的 `<root>/.git` 都是**文件**不是目录，拼错的那份必然读不到。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import { authedGet, cleanupOnExit, once, startDifftab } from './helpers.js';

let workdir;
let repos;
cleanupOnExit(() => workdir);

/** 见 helpers.js 的 `once()`：下限档 Node 22.0.0 不等顶层 `before()`。 */
const setup = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'difftab-gitdir-'));
  repos = makeFixtures(join(workdir, 'repos'), ['linkedWorktree', 'submodule']);
});

/**
 * 用**测试自己的** git 问出真正的 git 目录。这是「开发流程的 git」，不受零写操作约束；更要紧的
 * 是它与被测代码**互相独立**——拿产品自己回的 `gitDir` 去布置现场，等于用被测对象证明被测对象。
 */
function realGitDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `rev-parse --git-dir 失败：${r.stderr}`);
  const out = r.stdout.trim();
  return isAbsolute(out) ? out : resolve(cwd, out);
}

/**
 * 在 `gitDir` 里放一个 `MERGE_HEAD`，断言页面把操作标成 merge。**直接写文件而不是真跑一次冲突合
 * 并**，是因为被测的判据本身就是「这个文件在不在」——这里要验的是**路径**，不是合并，真造一次
 * 冲突反而会把断言的失败原因摊薄成两种。
 */
async function expectMergeMarked(root, label) {
  const gitDir = realGitDir(root);

  /**
   * 判据可证伪的前提：`<root>/.git` 是文件，于是 `<root>/.git/MERGE_HEAD` 根本不可能存在——拼
   * 错路径的实现在这里必然拿不到 merge。这一条不成立的话，下面那条断言换成错误实现也照样绿。
   */
  assert.ok(
    statSync(join(root, '.git')).isFile(),
    `${label}：期望 <root>/.git 是文件（linked worktree / submodule 的形态）`,
  );
  assert.notEqual(gitDir, join(root, '.git'), `${label}:git 目录不该就是 <root>/.git`);

  writeFileSync(join(gitDir, 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);

  const server = await startDifftab({ cwd: root });
  try {
    const state = JSON.parse((await authedGet(server.port, server.token, '/api/state')).body);
    assert.equal(
      state.branch.operation,
      'merge',
      `${label}：状态文件在 ${gitDir}，但页面没标出进行中的操作——git 目录多半是按 <root>/.git 拼的`,
    );
  } finally {
    await server.stop();
  }
}

test('linked worktree：状态文件在主仓库的 worktrees/ 下，照样标得出来', async () => {
  await setup();
  await expectMergeMarked(repos.linkedWorktree, 'linked worktree');
});

test('submodule：状态文件在父仓库的 modules/ 下，照样标得出来', async () => {
  await setup();
  await expectMergeMarked(repos.submodule, 'submodule');
});
