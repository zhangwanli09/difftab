// 变更文件列表。
//
// 按 path keyed:SSE 刷新时列表会整份换掉，靠 key 让 Preact 只动真正变了的行，
// 选中态与滚动位置才留得住（——这正是不自己写 reconcile 的理由）。
//
// 两种版式（平铺列表 / 目录树）共用同一个 `FileRow`：分组是 git 语义，两种版式都保留组头，树
// 只是组内的排法。版式与树的折叠态在 `state/change-tree.ts`。

import { useComputed } from '@preact/signals';
import { useMemo } from 'preact/hooks';
import type { FileEntry, StatusCode } from '../../server/shared/protocol';
import {
  buildChangeTree,
  type ChangeDirNode,
  type ChangeNode,
  changeView,
  isChangeDirCollapsed,
  toggleChangeDir,
} from '../state/change-tree';
import {
  type ChangeGroup,
  type ChangeGroupId,
  groupFiles,
  selectedPath,
  selectFile,
} from '../state/store';
import { ChevronPlaceholder, ExpandChevron, indent } from './tree-row';

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
 * `dir + name` 拼不回 `path`——名字里的 ForDisplay 就是这个意思。
 */
function splitForDisplay(path: string): { dir: string; name: string } {
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

function StatusBadge({ code }: { code: StatusCode }) {
  return (
    <span
      title={CODE_LABELS[code]}
      class={`w-5 shrink-0 text-center font-mono text-xs ${CODE_COLORS[code]}`}
    >
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
 * 一个页面上冲突组与别处的 `U` 会是两个颜色。宽度与居中沿用 `StatusBadge` 的
 * `w-5 text-center`，否则冲突组的文件名会比别的组横着挪一截。
 */
function ConflictBadge({ staged, unstaged }: Pick<FileEntry, 'staged' | 'unstaged'>) {
  return (
    <span
      title="Unmerged (conflicted)"
      class={`w-5 shrink-0 text-center font-mono text-xs ${CODE_COLORS.U}`}
    >
      {staged}
      {unstaged}
    </span>
  );
}

// focus-visible 那两个类是键盘可达性的最低档：列表项是 <button>，而 preflight 清掉了
// UA 默认焦点环。用 focus-border token 画，深浅都跟着翻。手型光标不在这里——那是所有按钮
// 共有的一件事，`styles/app.css` 里有一条 base 层规则统一给
//
// 对齐方式不在这一串里：文件行是「状态位 + 文件名」两段文字，按基线排；目录行是一枚 SVG 加一段
// 文字，替换元素的基线是它的底边，按基线排三角会整个浮在文字上方，得 `items-center`。两行各补
// 自己那一个，其余（内边距、焦点环）只此一份
const ROW_BASE =
  'flex w-full gap-2 px-3 py-1 text-left text-sm focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';
const ROW_CLASS = `${ROW_BASE} items-baseline`;

/**
 * 一个文件那一行。`treeDepth` 有值即树视图里的一行：按层级缩进、行首多一个与目录行的展开三角
 * 等宽的占位（少了它文件名比同层的目录名往左挪一截，同一层看着像两层）、**不再画目录段**——
 * 祖先节点已经把目录说了。其余（状态位、选中态、重命名标注、整行 `title`）两种版式一字不差。
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
  /**
   * 选中态包成 `computed` 再作为 prop 传下去，**不在组件体里读 `selectedPath.value`**：在组件
   * 体里读等于这一行订阅了它，换选中时 320 行全部重新渲染，其中 318 行产出的 vnode 与上一次逐
   * 字相同。作为 prop 传时 signals 把更新直接绑到 DOM 属性上，只写两个 class。
   *
   * **实测（本机 320 文件仓库，点击到高亮移动）**：组件体里读 0.8ms 中位 / 1.5ms p90，换成本
   * 写法后 0.2ms / 0.5ms。绝对值都不大——记在这里是因为这条路径每个 SSE 事件都要走一遍。
   *
   * 基础类只写一次，三元里只放选中/未选中的**差量**：两个分支各拼一遍 ROW_CLASS 的话，以后
   * 「选中行也加个 X」要改两处，而 diff 上也看不出到底哪个分支变了。
   */
  const rowClass = useComputed(
    () =>
      `${ROW_CLASS} ${
        selectedPath.value === file.path
          ? 'bg-list-active-selection-background text-list-active-selection-foreground'
          : 'hover:bg-list-hover-background'
      }`,
  );
  return (
    <li>
      <button
        type="button"
        // 整个条目交回 store——取 diff 要带哪些参数（重命名的 oldPath）属 git 知识，不在组件
        // 里重写一遍
        onClick={() => selectFile(file)}
        // 目录段被裁掉是**设计中的常态**（见下），完整路径于是在列表里找不回来了——
        // 挂在整行上补一份。不放在目录那个 span 上：它被裁到零宽时就没得可悬停了
        title={file.path}
        class={rowClass}
        style={inTree ? indent(treeDepth) : undefined}
      >
        {inTree && <ChevronPlaceholder />}
        {/* 每个分组只展示它自己那一侧的状态位——「已暂存」看 X，其余看 Y；冲突条目两侧都不
            是 `.`，挑哪一位都会丢掉另一半。**「印两位」的判据是条目自己的 `conflicted`，不是它
            落在哪一组**：按分组判的话，这一行画得对不对就取决于 `groupFiles` 与这里是否一致，
            而那个一致性没有任何东西在管 */}
        {file.conflicted ? (
          <ConflictBadge staged={file.staged} unstaged={file.unstaged} />
        ) : (
          <StatusBadge code={group === 'staged' ? file.staged : file.unstaged} />
        )}
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
      </button>
    </li>
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
    <li>
      <button
        type="button"
        onClick={() => toggleChangeDir(group, node.path)}
        // 合并后的名字会被 320px 裁掉，完整路径在树上找不回来——与文件行同理挂在整行上
        title={node.path}
        aria-expanded={expanded}
        class={`${ROW_BASE} items-center hover:bg-list-hover-background`}
        style={indent(depth)}
      >
        <ExpandChevron expanded={expanded} />
        <span class="min-w-0 truncate">{node.name}</span>
      </button>
      {expanded && <TreeLevel nodes={node.children} group={group} depth={depth + 1} />}
    </li>
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
      <h2 class="sticky top-0 bg-side-bar-section-header-background px-3 py-1 text-xs font-medium text-description-foreground">
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
    return (
      <p class="px-3 py-2 text-sm text-description-foreground">Working tree clean — no changes.</p>
    );
  }
  return (
    <div>
      {groups.map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </div>
  );
}
