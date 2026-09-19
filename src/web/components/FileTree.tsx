// 文件浏览器的目录树（侧栏 `Files` 那一档）。
//
// **按目录懒加载**：展开一个目录才去取它那一层，数据与缓存在 `state/tree.ts`。整棵树的形状
// 是「已经取回来的那几层」的并集，因此这里是一个按 `expandedDirs` 递归下去的组件，而不是
// 一份先拍平再画的清单。

import { untracked, useComputed, useSignalEffect } from '@preact/signals';
import { useRef } from 'preact/hooks';
import type { TreeEntry } from '../../server/shared/protocol';
import { activeEditorPath, editorKey, pinEditor } from '../state/editors';
import { type ChangeCode, codeByPath, openFile } from '../state/store';
import { expandedDirs, ROOT, revealPath, toggleDir, treeCache, treeErrors } from '../state/tree';
import { CODE_COLORS, STATUS_SLOT, StatusBadge } from './ChangeList';
// 行的骨架与行首三样都与变更列表的树视图共用一份：各写一份不报错，只是切一次 tab 行高或缩进跳一
// 截、或者一棵树里文件名比同层的目录名往左挪一截
import {
  ChevronPlaceholder,
  CopyPathButton,
  ExpandChevron,
  indent,
  ROW_BASE,
  TreeRow,
} from './tree-row';

/**
 * 目录行行尾的圆点：只说「底下有事」，**不印字母**——一个目录底下可以同时躺着改过的和没改过的
 * 文件，挑一个字母就是替用户下结论。外壳与 `StatusBadge` 同一个 `STATUS_SLOT`，两种行的记号才落
 * 在同一列；圆点用 `bg-current` 取外壳的文字色，颜色于是与那张 `CODE_COLORS` 只写一处。
 */
function DirBadge({ code }: { code: ChangeCode }) {
  return (
    <span
      role="img"
      aria-label="Contains changes"
      title="Contains changes"
      class={`${STATUS_SLOT} flex items-center justify-center ${CODE_COLORS[code]}`}
    >
      <span class="size-1.5 rounded-full bg-current" />
    </span>
  );
}

// 骨架之上只补对齐（为什么按居中，写在 `ROW_BASE` 上）：这里每一行都是 SVG 加一段文字
const ROW_CLASS = `${ROW_BASE} items-center`;

function Row({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const isDir = entry.kind === 'directory';
  const expanded = useComputed(() => expandedDirs.value.has(entry.path));

  /**
   * 选中态包成 `computed` 再作为 prop 用，**不在组件体里读**——与变更列表那一行同一条实测过
   * 的取向：在组件体里读等于这一行订阅了它，换选中时整棵展开的树重新渲染，而其中绝大多数行
   * 产出的 vnode 与上一次逐字相同。
   */
  const rowClass = useComputed(() => {
    const selected = !isDir && activeEditorPath.value === entry.path;
    // 被忽略的灰显（次要色 + 降透明度），与 VS Code 一致。选中时不灰——那一行此刻是主角。
    // 悬停底色不在这里，它画在 `TreeRow` 的 group div 上
    const tone = selected
      ? 'bg-list-active-selection-background text-list-active-selection-foreground'
      : entry.ignored
        ? 'text-description-foreground opacity-60'
        : '';
    return `${ROW_CLASS} ${tone}`;
  });

  /**
   * 这一行的状态码，文件与目录同查 `codeByPath`（目录那一格已经把后代归并进去了）；没改动是
   * `null`。被忽略那一档由上面的 tone 承担，与这里无关。
   *
   * 包成 `computed` 再读 `.value`：它是每行各一份，只在这一行自己的状态码变了时才产出新值，
   * 别的行变了这一行不跟着重画——而 SSE 刷新每次都会换一份全新的 `files` 数组。名字的类与
   * 行尾那枚记号都从这一个值派生，不再各包一层。
   */
  const code = useComputed(() => codeByPath.value.get(entry.path) ?? null).value;
  const nameClass = code === null ? 'min-w-0 truncate' : `min-w-0 truncate ${CODE_COLORS[code]}`;

  // 这一行自己展开着没有。**读 `.value` 会让本行重渲染，但 computed 是记忆化的**：
  // 别处展开时它产出的是同一个布尔，这一行不会跟着重画
  const isExpanded = isDir && expanded.value;

  /**
   * 活动 tab 是自己时滚进视野（与编辑器 tab 自己滚进标签栏同一条），判据直接用 `activeEditorPath`，
   * 不另设一个「待滚动」的信号。**是 signal effect 而不是 `useEffect([selected])`**：后者要在组件体
   * 里读选中态，正是上面 `rowClass` 刻意避开的整树重渲染；这里每行一份，只做一次相等比较、不引起渲
   * 染。effect 首次跑在挂载时——父层还在 `Loading…` 时这一行还没挂上，数据回来挂上那一跑才滚，
   * 展开那侧因此不必等请求；代价是收起再展开含这一行的目录时它会再滚一次，而 `nearest` 让已经看得
   * 见的一个像素都不动。
   */
  const button = useRef<HTMLButtonElement>(null);
  useSignalEffect(() => {
    if (activeEditorPath.value === entry.path) button.current?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <TreeRow
      buttonRef={button}
      onClick={() => (isDir ? toggleDir(entry.path) : openFile(entry.path))}
      // 单击预览、双击固定（目录行没有 tab 可固定）：双击到来时前两个 click 已经把 tab 开好
      // 并各取过一趟，这一下只幂等地置 pinned、不再取第三趟
      onDblClick={isDir ? undefined : () => pinEditor(editorKey('file', entry.path))}
      // 名字会被 320px 裁掉，而完整路径在树上找不回来——与变更列表同理挂在整行上，
      // 不挂在被裁的那一段上（它被裁到零宽时就没得可悬停了）
      title={entry.path}
      aria-expanded={isDir ? isExpanded : undefined}
      class={rowClass}
      style={indent(depth)}
      // 行尾的状态记号：文件印字母（与变更列表同一枚组件，切 tab 时落在同一列），目录印圆点
      badge={code !== null && (isDir ? <DirBadge code={code} /> : <StatusBadge code={code} />)}
      // 只有 `Copy path`；`Open file` 这里不画——点行开的本来就是全文
      actions={<CopyPathButton path={entry.path} />}
      sublevel={isExpanded && <Level path={entry.path} depth={depth + 1} />}
    >
      {isDir ? <ExpandChevron expanded={isExpanded} /> : <ChevronPlaceholder />}
      <span class={nameClass}>{entry.name}</span>
    </TreeRow>
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
      <p class="pr-3 break-words text-description-foreground" style={indent(depth)}>
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

/**
 * 根那一层。取根不在这里发起——见 `App` 里那个 effect（切到这一档才取，冷启动预算上因此看不见它）。
 *
 * **树跟着活动 tab 展开并定位**（照 VS Code 的 `explorer.autoReveal`），effect 挂在这里而不是
 * `main.tsx` 那种全局的：树只在 `Files` 档挂载，「只在树可见时 reveal、切到这一档那一刻补一次」两条
 * 于是不必另判 `activeTab`，`tree.ts` 也不必反向 import `store.ts`。
 *
 * **只订阅 `activeEditorPath`，展开那一步包在 `untracked` 里**：`revealPath` 读的是 `expandedDirs`，
 * 让它进依赖集等于用户每手动收起一个目录 effect 就重跑一次、把刚收起的又展开回去——不报错，只是
 * 「收不起来」。依赖集在 effect 这里声明，被调的函数不必各自记得 `peek()`。
 */
export function FileTree() {
  useSignalEffect(() => {
    const path = activeEditorPath.value;
    if (path !== null) untracked(() => revealPath(path));
  });
  return <Level path={ROOT} depth={0} />;
}
