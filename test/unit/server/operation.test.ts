// 进行中的多步操作的判据表(`readOperation`)。
//
// 与 git-integration.test.ts 的分工:那边钉的是「git 真的会留下这些痕迹」(merge 与
// rebase 两个 fixture 是真跑出来的冲突),这边钉的是**判据表本身** —— 优先级,以及
// `git am` 与 `git rebase --apply` 共用同一个 `rebase-apply/` 目录时靠什么区分。
// 后者若要跑真的 `git am`,得先造一封邮件格式的补丁,而它要证的东西只是
// 「里面有没有 `rebasing` 这个文件」。
//
// 造的是空文件与空目录:判据只有「在不在」,内容一个字节都不读。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readOperation } from '../../../src/server/git/operation.ts';

let gitDir: string;

beforeEach(() => {
  gitDir = mkdtempSync(join(tmpdir(), 'difftab-gitdir-'));
});

afterEach(() => {
  rmSync(gitDir, { recursive: true, force: true });
});

/** 造一个状态文件(`a/b` 形式给的是目录里的文件)。 */
function touch(relative: string): void {
  const segments = relative.split('/');
  const name = segments.pop() as string;
  const dir = join(gitDir, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '');
}

function mkdir(relative: string): void {
  mkdirSync(join(gitDir, relative), { recursive: true });
}

describe('readOperation', () => {
  test('干净的 git 目录 → undefined,而不是某个默认值', async () => {
    // 反面证据:恒返回一个操作的实现会让下面每一条都绿,而页面上是每个仓库都挂着一个标签
    await expect(readOperation(gitDir)).resolves.toBeUndefined();
  });

  test('git 目录根本不存在时也只是 undefined,不抛', async () => {
    // `/api/state` 每次都会走这里。一个 ENOENT 抛上去就是整份状态取不到,
    // 而页面上显示的是「取不到变更列表」—— 与真正的原因毫无相似之处
    await expect(readOperation(join(gitDir, 'no-such-dir'))).resolves.toBeUndefined();
  });

  test.each([
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ])('%s → %s', async (file, operation) => {
    touch(file);
    await expect(readOperation(gitDir)).resolves.toBe(operation);
  });

  test('rebase-merge/ 目录 → rebase', async () => {
    mkdir('rebase-merge');
    await expect(readOperation(gitDir)).resolves.toBe('rebase');
  });

  test('rebase-apply/ 里有 rebasing → rebase,没有 → am', async () => {
    // 两者共用同一个目录,`rebasing` 是唯一的区分。合并成一个标注等于对着一个
    // 正在 `git am` 的用户说他在变基
    touch('rebase-apply/rebasing');
    await expect(readOperation(gitDir)).resolves.toBe('rebase');

    rmSync(join(gitDir, 'rebase-apply', 'rebasing'));
    await expect(readOperation(gitDir)).resolves.toBe('am');
  });

  test('rebase 的痕迹与 merge 的痕迹同时在时,报的是 rebase', async () => {
    // 这不是假想的组合:rebase 冲突停下时 git 目录里就是同时躺着 `rebase-merge/` 与 merge 的那几个
    // 文件。判据表按序取第一个命中,调换两行不会报错 —— 只会把用户正在做的事说错
    mkdir('rebase-merge');
    touch('MERGE_HEAD');
    await expect(readOperation(gitDir)).resolves.toBe('rebase');
  });

  test('cherry-pick 排在 revert 之前是稳定的 —— 两者的痕迹独立,不会互相顶掉', async () => {
    // 把「两个判据各自独立」钉住,免得将来有人把它们合并成一个 `SEQUENCER` 判据
    touch('REVERT_HEAD');
    await expect(readOperation(gitDir)).resolves.toBe('revert');
    touch('CHERRY_PICK_HEAD');
    await expect(readOperation(gitDir)).resolves.toBe('cherry-pick');
  });
});
