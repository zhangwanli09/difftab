// 进行中的多步操作(rebase / merge / cherry-pick / revert / am / bisect,spec §5.3)。
//
// **这件事在 `git status --porcelain=v2` 里一行都没有**,唯一判据是 git 目录下的状态
// 文件 —— git 自己的 `wt-status.c` 也正是这么判的。因此本文件是 server/git 里唯一
// 不起子进程的模块:多一次 git 既落在每次 `/api/state` 上,又要往 §5.10 的只读白名单
// 里添一条,而读文件存在性一个字节都不写。

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchState } from '../shared/protocol.ts';

export type RepoOperation = NonNullable<BranchState['operation']>;

/**
 * 判据表,**按序取第一个命中**(spec §5.3)。
 *
 * 两处顺序不是随手排的:
 *
 * - **rebase 排在 merge 之前**。rebase 冲突停下时 git 目录里同时躺着 `rebase-merge/`
 *   与 `MERGE_MSG` / `AUTO_MERGE`(已实测,§10),而用户处在的是 rebase —— 反过来
 *   排会把它标成「合并中」,页面上看不出任何异样,只是说错了用户在干什么。
 *   `MERGE_HEAD` 本身在那种情形下不出现,所以这一条更像是给后来者的防线
 * - **`rebase-apply/rebasing` 排在 `rebase-apply` 之前**。`git am` 与 `git rebase --apply`
 *   共用 `rebase-apply/` 这一个目录,里面有没有 `rebasing` 是区分两者的唯一办法;
 *   合并成一个标注等于对着一个正在 `git am` 的用户说他在 rebase
 */
const PROBES: readonly { readonly path: string; readonly operation: RepoOperation }[] = [
  { path: 'rebase-merge', operation: 'rebase' },
  // `/` 直接写在字面量里:`path.join` 在 win32 上会把它归一成 `\`,而拆成数组只为了
  // 七条里的这一条能有两段,代价是每条都得读一次「这是不是路径片段」
  { path: 'rebase-apply/rebasing', operation: 'rebase' },
  { path: 'rebase-apply', operation: 'am' },
  { path: 'MERGE_HEAD', operation: 'merge' },
  { path: 'CHERRY_PICK_HEAD', operation: 'cherry-pick' },
  { path: 'REVERT_HEAD', operation: 'revert' },
  { path: 'BISECT_LOG', operation: 'bisect' },
];

/** 存在与否,不区分文件还是目录 —— 上表里两种都有,而判据只是「在不在」。 */
function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * 当前进行中的多步操作;没有则 `undefined`。
 *
 * **传进来的必须是 `git rev-parse --git-dir` 的返回值,不能自己拼 `<root>/.git`**
 * (§5.3):linked worktree 下 `.git` 是个文件、真正的 git 目录在
 * `<主仓库>/.git/worktrees/<名>`,submodule 在 `<父仓库>/.git/modules/<路径>`
 * (均已实测,§10)。拼出来的路径在那两种仓库里永远读不到 —— 于是永远标不出操作,
 * 而它不报错。`RepoInfo.gitDir` 已经是这个值,调用方照传即可。
 *
 * 七个探针**并发发**再按上表定序:顺序判据只有一处(上面那张表),而不是散落在
 * 一串 `await` 的先后里 —— 后者调换两行就静默换了语义。每个探针直接产出**答案还是
 * undefined**,于是取第一个命中就是一次普通的 `find`,不必再拿下标去另一个数组里
 * 对号入座 —— 那种写法会让「顺序对不对」多出一个不在表里的依赖。
 */
export async function readOperation(gitDir: string): Promise<RepoOperation | undefined> {
  const hits = await Promise.all(
    PROBES.map(async (probe) =>
      (await exists(join(gitDir, probe.path))) ? probe.operation : undefined,
    ),
  );
  return hits.find((operation) => operation !== undefined);
}
