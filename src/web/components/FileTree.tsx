// 文件浏览器的目录树（侧栏 `Files` 那一档）。
//
// **按目录懒加载**：展开一个目录才去取它那一层，数据与缓存在 `state/tree.ts`。整棵树的形状
// 是「已经取回来的那几层」的并集，因此这里是一个按 `expandedDirs` 递归下去的组件，而不是
// 一份先拍平再画的清单。

import { useComputed } from '@preact/signals';
import {
  type FileEntry,
  isConflicted,
  type StatusCode,
  type TreeEntry,
} from '../../server/shared/protocol';
import { fileByPath, fileState, openFile } from '../state/store';
import { expandedDirs, ROOT, toggleDir, treeCache, treeErrors } from '../state/tree';
import { CODE_COLORS } from './ChangeList';

/** 每一层的缩进量（px）。用内联 style 按层级算——层数没有上界，而 Tailwind 只产出源码里出现过的类名。 */
const INDENT_PX = 12;

/** 一行（或一句占位文案）在第 `depth` 层的左内边距。**只此一份**，两处各写一遍会让占位与行错位。 */
const indent = (depth: number) => ({ paddingLeft: `${(depth + 1) * INDENT_PX}px` });

// 展开三角。图形取自 **Heroicons v2 的 24/outline**（`chevron-right`,MIT,Copyright
// Tailwind Labs），与 ThemeToggle 那三枚同一处来源、同样复制 path 数据而不装包。
// 展开时靠 `rotate-90` 转 90°，不另备一条向下的 path
const CHEVRON_PATH = 'm8.25 4.5 7.5 7.5-7.5 7.5';

/**
 * 这个路径在变更列表里对应的状态字母；没有改动就是 `null`。
 *
 * **冲突优先**：冲突条目两侧状态位都不是 `.`，挑哪一位都会说错一半，一律按 `U` 上色。判据走
 * `isConflicted()` 而不是自己读 `conflicted`——那个字段的含义归 `shared/protocol.ts`。其余先看工作区
 * 侧（Y），它是「文件现在长什么样」，正是树上这一行说的东西；Y 干净才退回暂存侧。
 */
function codeOf(entry: FileEntry | undefined): StatusCode | null {
  if (entry === undefined) return null;
  if (isConflicted(entry)) return 'U';
  if (entry.unstaged !== '.') return entry.unstaged;
  if (entry.staged !== '.') return entry.staged;
  return null;
}

// 与变更列表的 ROW_CLASS 同源（focus-visible 那两个类是键盘可达性的最低档，理由写在
// ChangeList.tsx 那份上）。这里多一个 `gap-1`：三角与名字之间比列表那两段更紧
const ROW_CLASS =
  'flex w-full items-center gap-1 py-0.5 pr-3 text-left text-sm focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';

function Row({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const isDir = entry.kind === 'directory';
  const expanded = useComputed(() => expandedDirs.value.has(entry.path));

  /**
   * 选中态包成 `computed` 再作为 prop 用，**不在组件体里读**——与变更列表那一行同一条实测过
   * 的取向：在组件体里读等于这一行订阅了它，换选中时整棵展开的树重新渲染，而其中绝大多数行
   * 产出的 vnode 与上一次逐字相同。
   */
  const rowClass = useComputed(() => {
    const selected = !isDir && fileState.value?.path === entry.path;
    // 被忽略的灰显（次要色 + 降透明度），与 VS Code 一致。选中时不灰——那一行此刻是主角
    const tone = selected
      ? 'bg-list-active-selection-background text-list-active-selection-foreground'
      : `hover:bg-list-hover-background ${entry.ignored ? 'text-description-foreground opacity-60' : ''}`;
    return `${ROW_CLASS} ${tone}`;
  });

  /**
   * 名字那一段的类。状态染色**只给文件**：一个目录底下可以同时躺着改过的和没改过的文件，
   * 给它挑一个字母就是替用户下结论；目录仍可能被忽略，那一档由上面的 tone 承担。
   *
   * 同样包成 `computed` 传下去，理由同 `rowClass`——它是每行各一份，只在这一行自己的状态字母
   * 变了时才产出新值，而 SSE 刷新每次都会换一份全新的 `files` 数组。查表走 `fileByPath`
   * 而不是在这里 `find`：那是每行一次线性扫描，乘上可见行数就是每个事件几万次比较。
   */
  const nameClass = useComputed(() => {
    if (isDir) return 'min-w-0 truncate';
    const code = codeOf(fileByPath.value.get(entry.path));
    return code === null ? 'min-w-0 truncate' : `min-w-0 truncate ${CODE_COLORS[code]}`;
  });

  // 这一行自己展开着没有。**读 `.value` 会让本行重渲染，但 computed 是记忆化的**：
  // 别处展开时它产出的是同一个布尔，这一行不会跟着重画
  const isExpanded = isDir && expanded.value;

  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? toggleDir(entry.path) : openFile(entry.path))}
        // 名字会被 320px 裁掉，而完整路径在树上找不回来——与变更列表同理挂在整行上，
        // 不挂在被裁的那一段上（它被裁到零宽时就没得可悬停了）
        title={entry.path}
        aria-expanded={isDir ? isExpanded : undefined}
        class={rowClass}
        style={indent(depth)}
      >
        {/* 文件那一侧画的是等宽占位而不是什么都不画：少了它，文件名会比同层的目录名往左挪
            一截，同一层看着像两层 */}
        {isDir ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class={`shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
          >
            <path d={CHEVRON_PATH} />
          </svg>
        ) : (
          <span class="w-3 shrink-0" />
        )}
        <span class={nameClass}>{entry.name}</span>
      </button>
      {isExpanded && <Level path={entry.path} depth={depth + 1} />}
    </li>
  );
}

/**
 * 一层。**取不到只在这一层里说一句**，不写进那条全局错误条：那条横幅说的是「变更列表取不
 * 到」，一个目录展不开不该让整个页面看起来坏掉。
 *
 * **手上已经有这一层时，出错就不画那句话**：`loadDir` 失败只写 `treeErrors`、不动
 * `treeCache`，而刷新途中的一次失败（后端重启、dev 代理抖一下）是常态。先看错误的写法会让一
 * 个已经画出来的目录连同它底下展开的一切，被一行红字换掉，直到下一个 `change` 恰好成功——
 * 陈旧的内容比消失的内容有用得多，而它下一拍就会被换新。
 */
function Level({ path, depth }: { path: string; depth: number }) {
  /**
   * **订阅这一层自己那份，不订阅整张表**：`loadDir` 每次都换掉整个 `treeCache`，直接读
   * `treeCache.value.get(path)` 会让一次刷新把所有展开着的层连同它们的行全部重画——正是
   * `Row` 里那些 computed 想避免的事，在外面又被抵消掉。
   */
  const entries = useComputed(() => treeCache.value.get(path)).value;
  const error = useComputed(() => treeErrors.value.get(path)).value;

  /**
   * 三种占位是同一行字，只是内容不同：还没取到（或没取到且有原因）、取回来是空的。
   *
   * **手上已经有这一层时，出错就不画那句话**：`loadDir` 失败只写 `treeErrors`、不动
   * `treeCache`，而刷新途中的一次失败（后端重启、dev 代理抖一下）是常态。先看错误的写法会让
   * 一个已经画出来的目录连同它底下展开的一切，被一行红字换掉，直到下一个 `change` 恰好成功
   * ——陈旧的内容比消失的内容有用得多，而它下一拍就会被换新。
   */
  const placeholder =
    entries === undefined ? (error ?? 'Loading…') : entries.length === 0 ? 'Empty' : null;
  if (entries === undefined || placeholder !== null) {
    return (
      <p class="py-0.5 pr-3 text-sm break-words text-description-foreground" style={indent(depth)}>
        {placeholder}
      </p>
    );
  }

  return (
    <ul>
      {entries.map((entry) => (
        <Row key={entry.path} entry={entry} depth={depth} />
      ))}
    </ul>
  );
}

/** 根那一层。取根不在这里发起——见 `App` 里那个 effect（切到这一档才取，冷启动预算上因此看不见它）。 */
export function FileTree() {
  return <Level path={ROOT} depth={0} />;
}
