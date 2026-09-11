// 变更列表那一档的版式（列表 / 树），以及树那半的折叠态与建树。
//
// 与 `tree.ts` 是两份东西，不复用：那棵是 `Files` 档从 `ls-files` 取回来的目录树，默认收起、
// 键是仓库路径、`refreshTree` 按它的展开集合发请求；这棵是从 status 的路径**纯算**出来的，
// 没有任何请求要发，默认全展开。混进同一个集合，每折一个变更目录就多一趟 `ls-files`。

import { signal } from '@preact/signals';
import type { FileEntry } from '../../server/shared/protocol';
import type { ChangeGroupId } from './store';

/**
 * 侧栏 `Changes` 档此刻按哪种版式画。默认列表——工具存在的理由仍是「瞥一眼改了什么」，树是
 * 改动铺开到几十个目录时才用得上的第二种读法。
 *
 * **不进 `localStorage`**，判据不是「不值得记」而是**记了也存不住**：后端 `listen(0)` 端口
 * 随机，`localStorage` 按 origin（含端口）隔离，于是它只能活到同一实例的刷新，换一次
 * `difftab` 启动就归零。与 `activeTab` 同一形状。
 */
export type ChangeView = 'list' | 'tree';

export const changeView = signal<ChangeView>('list');

export function toggleChangeView(): void {
  changeView.value = changeView.value === 'list' ? 'tree' : 'list';
}

/**
 * 折起来的目录。**记 collapsed 而不是 expanded**：默认全展开，空集就是「全展开」，SSE 刷新新
 * 冒出来的目录不用登记就是展开的。记 expanded 时每个新目录都得在建树时补登记一次，漏了它就默
 * 认收起——页面上只是「刚改的那几个文件没显示出来」，而 agent 跑动期间新目录是常态。
 *
 * 键由 `collapseKey` 给：**带分组 id**，同一个目录可以同时出现在 Staged 与 Unstaged 两组（XY
 * 两位独立），两处是两棵子树，折其中一处不该连带折另一处。陈旧的键不清理：目录消失又出现时仍
 * 是收起的，清理要在每次 `files` 换新时扫一遍集合，而它换来的只是一个不常见场景下的默认档。
 */
export const collapsedChangeDirs = signal<ReadonlySet<string>>(new Set());

/** 键的形状只在本文件里：分组 id 是闭合的 union，`:` 不会歧义。外面只问「折了没有」。 */
const collapseKey = (group: ChangeGroupId, path: string): string => `${group}:${path}`;

/** 读 signal——放进 computed 里就订阅了它。 */
export const isChangeDirCollapsed = (group: ChangeGroupId, path: string): boolean =>
  collapsedChangeDirs.value.has(collapseKey(group, path));

export function toggleChangeDir(group: ChangeGroupId, path: string): void {
  const key = collapseKey(group, path);
  const next = new Set(collapsedChangeDirs.value);
  if (!next.delete(key)) next.add(key);
  collapsedChangeDirs.value = next;
}

export interface ChangeDirNode {
  kind: 'directory';
  /** 显示名。紧凑合并后是 `src/web/components` 这样连读的一段。 */
  name: string;
  /** 仓库相对路径，合并后取链尾——它同时是折叠键的后半段。 */
  path: string;
  children: readonly ChangeNode[];
}

export interface ChangeFileNode {
  kind: 'file';
  file: FileEntry;
}

export type ChangeNode = ChangeDirNode | ChangeFileNode;

/** 建树期间一个目录的可变形态：子目录按名字查，文件按出现顺序攒。节点在 `finish` 时一次建成。 */
interface Building {
  name: string;
  path: string;
  dirs: Map<string, Building>;
  files: ChangeFileNode[];
}

const building = (name: string, path: string): Building => ({
  name,
  path,
  dirs: new Map(),
  files: [],
});

/**
 * 每层**目录在前、文件在后**（照 `Files` 那档后端的「目录在前」），各自沿用 git 给的顺序不再排
 * 序——多一份排序意见就多一处与 `git status` 不一致的可能。
 */
function finish({ dirs, files }: Building): ChangeNode[] {
  const nodes: ChangeNode[] = [...dirs.values()].map((dir) =>
    compact({ kind: 'directory', name: dir.name, path: dir.path, children: finish(dir) }),
  );
  return nodes.concat(files);
}

/**
 * 紧凑合并（VS Code 的 compact folders）：一个目录**只有一个子节点且它是目录**时合并成一个节点，
 * 名字连读、`path` 取链尾。判据是 320px 侧栏里每一层缩进都是从文件名身上扣的，`src` → `web` →
 * `components` 三层各占一行只为放一个文件。有文件的目录不合并——那几个文件就在这一层，合并会
 * 让它们看起来属于更深的那层。子节点已经在 `finish` 里合并过，这里只需看一层。
 */
function compact(node: ChangeDirNode): ChangeDirNode {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  if (only === undefined || only.kind !== 'directory') return node;
  return { ...only, name: `${node.name}/${only.name}` };
}

/**
 * 从一组文件的路径纯算出一棵树。分隔符恒为 `/`（由后端保证），与 `splitForDisplay` 同一条前提。
 * 每个分组各建一棵：分组是 git 语义，树只是组内的排法。
 */
export function buildChangeTree(files: readonly FileEntry[]): ChangeNode[] {
  const root = building('', '');
  for (const file of files) {
    // 最后一段是文件名，不参与建目录；文件行画的名字仍由 `splitForDisplay` 从 `file.path` 里取
    const segments = file.path.split('/').slice(0, -1);
    let level = root;
    let path = '';
    for (const segment of segments) {
      path = path === '' ? segment : `${path}/${segment}`;
      let dir = level.dirs.get(segment);
      if (dir === undefined) {
        dir = building(segment, path);
        level.dirs.set(segment, dir);
      }
      level = dir;
    }
    level.files.push({ kind: 'file', file });
  }
  return finish(root);
}
