// 变更文件列表。
//
// 按 path keyed:SSE 刷新时列表会整份换掉，靠 key 让 Preact 只动真正变了的行，
// 选中态与滚动位置才留得住（——这正是不自己写 reconcile 的理由）。
//
// 两种版式（平铺列表 / 目录树）共用同一个 `FileRow`：分组是 git 语义，两种版式都保留组头，树
// 只是组内的排法。版式与树的折叠态在 `state/change-tree.ts`。

import { useComputed } from '@preact/signals';
import { FileInput } from 'lucide-preact';
import { useMemo } from 'preact/hooks';
import {
  type FileEntry,
  isAbsentFromWorktree,
  type StatusCode,
} from '../../server/shared/protocol';
import {
  buildChangeTree,
  type ChangeDirNode,
  type ChangeNode,
  changeView,
  isChangeDirCollapsed,
  toggleChangeDir,
} from '../state/change-tree';
import { activeEditorPath, editorKey, pinEditor } from '../state/editors';
import {
  type ChangeGroup,
  type ChangeGroupId,
  groupFiles,
  openFile,
  selectFile,
} from '../state/store';
import { SidebarPlaceholder } from './EmptyState';
import { IconButton } from './IconButton';
import {
  ChevronPlaceholder,
  CopyPathButton,
  ExpandChevron,
  indent,
  ROW_BASE,
  TreeRow,
} from './tree-row';

/**
 * 状态位的**展示文案**，与解析无关——徽章上印的是 git 自己的字母，这张表只作为 tooltip 把
 * 字母翻译一次。含义的唯一事实来源是 `StatusCode` 的类型注释。
 */
const CODE_LABELS: Record<StatusCode, string> = {
  '.': 'Unmodified',
  M: 'Modified',
  T: 'Type changed',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '?': 'Untracked',
};

/**
 * 路径拆成目录与文件名两段展示。分隔符恒为 `/`（由后端保证），因此这里不需要也不应该考虑平台
 * 差异——那属于 git 知识。**目录段不含尾部斜杠**（它排在文件名之后、单独成一段），于是
 * `dir + name` 拼不回 `path`——名字里的 ForDisplay 就是这个意思。**导出给标签栏共用**：tab 上的
 * 名字与目录要与这一行是同一种拆法，各写一份时漂开的症状是同一个文件在两处显示成两个名字。
 */
export function splitForDisplay(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * 状态位的**颜色**，同样只是展示。取的是 VS Code `gitDecoration.*` 那套 token，让徽章的颜色
 * 语义与用户在编辑器里看到的一致。深浅两套取值在 token 层翻，这里不出现 `dark:` 变体。
 *
 * **导出给文件树共用，不复制一份**：同一个文件在两处必须是同一个颜色，而两份表漂开之后
 * 页面上只是「树里那个 M 跟列表里那个 M 不一样绿」。
 */
export const CODE_COLORS: Record<StatusCode, string> = {
  '.': 'text-description-foreground',
  M: 'text-git-modified',
  T: 'text-git-modified',
  A: 'text-git-added',
  D: 'text-git-deleted',
  R: 'text-git-modified',
  C: 'text-git-added',
  U: 'text-git-conflicting',
  '?': 'text-git-untracked',
};

/**
 * 行尾状态记号的外壳：`ml-auto` 靠右，侧栏右端于是有一列定宽记号（对应 VS Code 的 decoration
 * 位置），行首没有东西挡在文件名前面。`shrink-0` 不能省——前面的截断盒收缩时它得原样留着，否则
 * 长路径行上先被挤掉的就是它。
 *
 * **三枚记号（字母、冲突两位、`Files` 那档目录行的圆点）共用这一个常量**：各写一份时不一致不报错，
 * 只是某一组或某一档那一列横着挪一截。
 *
 * 外壳还负责 `opacity-75`：颜色 token 与 VS Code `gitDecoration.*` 逐字相同，但 VS Code 行尾那枚
 * decoration 字母（`.monaco-icon-label::after`）是 0.75 不透明度、比染色的文件名淡一档，画成满色
 * 时记号看着比编辑器里重。**是 `opacity` 不是 token 的 `/75` 修饰符**：双值 token 经 `color-mix()`
 * 会让整条声明作废。圆点是 `bg-current`，跟着外壳一起淡，不必各写。
 */
export const STATUS_SLOT = 'ml-auto w-5 shrink-0 opacity-75';
const LETTER_CLASS = `${STATUS_SLOT} text-center font-mono text-xs`;

/**
 * **导出给 `Files` 那档的文件行共用**：两处切换时同一个文件的字母得落在同一个位置、同一个颜色，
 * 各画一枚时改其中一处不报错，只是切一次 tab 那一列横着跳一截。
 */
export function StatusBadge({ code }: { code: StatusCode }) {
  return (
    <span title={CODE_LABELS[code]} class={`${LETTER_CLASS} ${CODE_COLORS[code]}`}>
      {code}
    </span>
  );
}

/**
 * 冲突条目的徽章：**XY 两位一起印**。一位不够：`DD`（双方都删）与 `UU`（双方都改）只印一位时
 * 长得一模一样，而它们是用户要采取的两种完全不同的动作。这里刻意**不**把七种组合各翻一句话
 *——那是 porcelain 的记录语义，前端一旦写下来就成了第二份 git 知识。
 *
 * 颜色取 `CODE_COLORS.U` 而不是再写一遍那个 token：两处各写一份时，调冲突色只改一处的话，同
 * 一个页面上冲突组与别处的 `U` 会是两个颜色。
 */
function ConflictBadge({ staged, unstaged }: Pick<FileEntry, 'staged' | 'unstaged'>) {
  return (
    <span title="Unmerged (conflicted)" class={`${LETTER_CLASS} ${CODE_COLORS.U}`}>
      {staged}
      {unstaged}
    </span>
  );
}

// 行的骨架是 `tree-row.tsx` 那份 `ROW_BASE`，与 `Files` 那档同一份；对齐方式为什么不在骨架里、
// 文件行为什么按基线而目录行按居中，都写在它上面。左内边距两种行都由 `indent()` 给，不在类名里
const ROW_CLASS = `${ROW_BASE} items-baseline`;
const DIR_ROW_CLASS = `${ROW_BASE} items-center`;

/**
 * 一个文件那一行。`treeDepth` 有值即树视图里的一行：按层级缩进、行首多一个与目录行的展开三角
 * 等宽的占位（少了它文件名比同层的目录名往左挪一截，同一层看着像两层）、**不再画目录段**——
 * 祖先节点已经把目录说了。其余（选中态、重命名标注、行尾的状态位、整行 `title`）两种版式一字不差。
 */
function FileRow({
  file,
  group,
  treeDepth,
}: {
  file: FileEntry;
  group: ChangeGroupId;
  treeDepth?: number;
}) {
  const { dir, name } = splitForDisplay(file.path);
  const inTree = treeDepth !== undefined;
  // 工作区里已不存在的文件不给 `Open file`：它唯一能打开的是一条错误。判据是 git 知识，在协议层。
  // `Copy path` 照给——`git checkout -- <path>` 正要这条路径
  const canOpen = !isAbsentFromWorktree(file);
  /**
   * 选中态包成 `computed` 再作为 prop 传下去，**不在组件体里读 `activeEditorPath.value`**：在组件
   * 体里读等于这一行订阅了它，换选中时 320 行全部重新渲染，其中 318 行产出的 vnode 与上一次逐
   * 字相同。作为 prop 传时 signals 把更新直接绑到 DOM 属性上，只写两个 class。
   *
   * **实测（本机 320 文件仓库，点击到高亮移动）**：组件体里读 0.8ms 中位 / 1.5ms p90，换成本
   * 写法后 0.2ms / 0.5ms。绝对值都不大——记在这里是因为这条路径每个 SSE 事件都要走一遍。
   *
   * 基础类只写一次，只在选中时追加**差量**（悬停底色不在这里——它画在 `TreeRow` 的 group div 上）。
   */
  const rowClass = useComputed(
    () =>
      `${ROW_CLASS} ${
        activeEditorPath.value === file.path
          ? 'bg-list-active-selection-background text-list-active-selection-foreground'
          : ''
      }`,
  );
  return (
    <TreeRow
      // 整个条目交回 store——取 diff 要带哪些参数（重命名的 oldPath）属 git 知识，不在组件
      // 里重写一遍。单击预览、双击固定：双击到来时前两个 click 已经把 tab 开好并各取过一趟，
      // 这一下只幂等地置 pinned、不再取第三趟
      onClick={() => selectFile(file)}
      onDblClick={() => pinEditor(editorKey('diff', file.path))}
      // 目录段被裁掉是**设计中的常态**（见下），完整路径于是在列表里找不回来了——
      // 挂在整行上补一份。不放在目录那个 span 上：它被裁到零宽时就没得可悬停了
      title={file.path}
      class={rowClass}
      // 平铺列表也走 `indent()`，取第 0 层：左内边距于是三种视图只此一个来源
      style={indent(treeDepth ?? 0)}
      // 状态位靠右（`ml-auto`）：前面两个 `min-w-0 truncate` 收缩时它 `shrink-0` 不动。每个分组只
      // 展示它自己那一侧的状态位——「已暂存」看 X，其余看 Y；冲突条目两侧都不是 `.`，挑哪一位都会
      // 丢掉另一半。**「印两位」的判据是条目自己的 `conflicted`，不是它落在哪一组**：按分组判的话，
      // 这一行画得对不对就取决于 `groupFiles` 与这里是否一致，而那个一致性没有任何东西在管
      badge={
        file.conflicted ? (
          <ConflictBadge staged={file.staged} unstaged={file.unstaged} />
        ) : (
          <StatusBadge code={group === 'staged' ? file.staged : file.unstaged} />
        )
      }
      // 行内动作，位置照 VS Code Source Control 的 inline action。`Copy path` 在左、`Open file` 留在
      // 紧贴状态位的位置。`Open file` 的图标是 `FileInput`（文件 + 一支进入文件的箭头），Lucide 里
      // 最贴近 codicon `go-to-file` 的一枚——它是一个「跳过去」的动作，不用 file tab 那枚 `FileCode`：
      // 那是种类标识，画在动作按钮上读不出「点了会发生什么」。点它开的是**固定**的 file tab（VS Code
      // `git.openFile` 是 `preview: false`——一个明确的「我要这个文件」的动作不该被下一次单击顶掉），
      // 不切侧栏档位
      actions={[
        <CopyPathButton key="copy" path={file.path} />,
        canOpen && (
          <IconButton
            key="open"
            icon={FileInput}
            label="Open file"
            onClick={() => openFile(file.path, { pinned: true })}
          />
        ),
      ]}
    >
      {inTree && <ChevronPlaceholder />}
      {/* 文件名在前、目录在后。侧栏定宽 320px，而 `truncate` 的省略号在**右**端——目录排在
          后面时，放不下先没的就是目录、文件名留到最后；改回「目录前缀 + 文件名」的老写法则
          反过来先吃掉文件名，而它才是认出这一行的东西。
          **两段必须同住这一个 truncate span**：拆成两个平级的 flex 子项会静默毁掉基线对齐，
          还得靠 flex-basis 去调谁先被裁、连带把下面那段重命名标注推到侧栏最右。
          `min-w-0` 不能省：flex 子项的 min-width 默认 auto，不给它时 overflow:hidden 收不住 */}
      <span class="min-w-0 truncate">
        {name}
        {dir && !inTree && <span class="ml-2 text-xs text-description-foreground">{dir}</span>}
      </span>
      {/* 重命名的判据是 oldPath 存在，不是比对路径。这里只把旧路径说清楚，
          点开后的 rename from/to 与相似度标注在 DiffView 那侧 */}
      {file.oldPath && (
        <span class="min-w-0 truncate text-xs text-description-foreground">
          ← {file.oldPath}
          {file.renameScore !== undefined && ` (${file.renameScore}%)`}
        </span>
      )}
    </TreeRow>
  );
}

/**
 * 树视图里的一个目录行。形状与 `Files` 那档同款：缩进 + 12px 的展开三角（展开时 `rotate-90`）
 * + 名字。**只改折叠集合，不动选中态与右侧**——折的是左栏在列什么，不是用户此刻在读什么。
 */
function DirRow({
  node,
  group,
  depth,
}: {
  node: ChangeDirNode;
  group: ChangeGroupId;
  depth: number;
}) {
  // 与 `FileRow` 的选中态同一条理由包成 computed：别的目录折起来时这一行产出的是同一个布尔，
  // 不跟着重画
  const expanded = useComputed(() => !isChangeDirCollapsed(group, node.path)).value;
  return (
    <TreeRow
      onClick={() => toggleChangeDir(group, node.path)}
      // 合并后的名字会被 320px 裁掉，完整路径在树上找不回来——与文件行同理挂在整行上
      title={node.path}
      aria-expanded={expanded}
      class={DIR_ROW_CLASS}
      style={indent(depth)}
      // 目录只有 `Copy path`（合并节点复制链尾那个 `path`）：目录没有 diff 也没有全文可开
      actions={<CopyPathButton path={node.path} />}
      sublevel={expanded && <TreeLevel nodes={node.children} group={group} depth={depth + 1} />}
    >
      <ExpandChevron expanded={expanded} />
      <span class="min-w-0 truncate">{node.name}</span>
    </TreeRow>
  );
}

function TreeLevel({
  nodes,
  group,
  depth,
}: {
  nodes: readonly ChangeNode[];
  group: ChangeGroupId;
  depth: number;
}) {
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === 'directory' ? (
          <DirRow key={node.path} node={node} group={group} depth={depth} />
        ) : (
          <FileRow key={node.file.path} file={node.file} group={group} treeDepth={depth} />
        ),
      )}
    </ul>
  );
}

/**
 * 树视图下的一组。树由路径**纯算**出来，只在这一组的 `files` 换新时重建，折叠与选中都不碰它。
 * **是 `useMemo` 不是 `useComputed`**：`files` 是 prop 不是 signal，computed 只跟踪 signal，
 * 换一份 `files` 它不会重算——页面上就是 SSE 刷新后树停在旧的那份，而列表版式照常在动。
 */
function GroupTree({ group }: { group: ChangeGroup }) {
  const nodes = useMemo(() => buildChangeTree(group.files), [group.files]);
  return <TreeLevel nodes={nodes} group={group.id} depth={0} />;
}

function Group({ group }: { group: ChangeGroup }) {
  if (group.files.length === 0) return null;
  return (
    <section>
      {/* 与文件行同高（24px）、不给纵向内边距。`/6` 不能省：`text-xs` 会把从 `<nav>` 继承来的
          line-height 一并重设，漏了它这一行就缩成 16px */}
      <h2 class="sticky top-0 bg-side-bar-section-header-background px-3 text-xs/6 font-medium text-description-foreground">
        {group.title}
        <span class="ml-1">{group.files.length}</span>
      </h2>
      {/* 组头两种版式都留着：分组是 git 语义（XY 两位独立，同一个文件可同时在两组），树只是
          组内的排法 */}
      {changeView.value === 'tree' ? (
        <GroupTree group={group} />
      ) : (
        <ul>
          {group.files.map((file) => (
            <FileRow key={file.path} file={file} group={group.id} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ChangeList({ files }: { files: readonly FileEntry[] }) {
  // 分组只在 `files` 换新时重算：`groupFiles` 每次都回四份新数组，直接在渲染体里调的话
  // `GroupTree` 那个按 `group.files` 记忆的树在每次切 tab / 换 pane 时都白建一遍
  const groups = useMemo(() => groupFiles(files), [files]);
  if (files.length === 0) {
    return <SidebarPlaceholder>No changes</SidebarPlaceholder>;
  }
  return (
    <div>
      {groups.map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </div>
  );
}
