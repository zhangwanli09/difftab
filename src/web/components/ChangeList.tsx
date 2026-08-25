// 变更文件列表。
//
// 按 path keyed:SSE 刷新时列表会整份换掉,靠 key 让 Preact 只动真正变了的行,
// 选中态与滚动位置才留得住(—— 这正是不自己写 reconcile 的理由)。

import { useComputed } from '@preact/signals';
import type { FileEntry, StatusCode } from '../../server/shared/protocol';
import { type ChangeGroup, groupFiles, selectedPath, selectFile } from '../state/store';

/**
 * 状态位的**展示文案**,与解析无关 —— 徽章上印的是 git 自己的字母,
 * 这张表只作为 tooltip 把字母翻译一次。含义的唯一事实来源是 `StatusCode` 的
 * 类型注释(架构边界不变式 4:前端不得出现第二份状态位实现)。
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
 * 路径拆成目录与文件名两段展示。
 *
 * 分隔符恒为 `/`(路径「以 `/` 分隔」,由后端保证),因此这里不需要也
 * 不应该考虑平台差异 —— 那属于 git 知识,留在后端。
 *
 * **目录段不含尾部斜杠**(它排在文件名之后、单独成一段),于是 `dir + name`
 * 拼不回 `path` —— 名字里的 ForDisplay 就是这个意思,别拿它当通用的路径工具。
 */
function splitForDisplay(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * 状态位的**颜色**,同样只是展示(与 `CODE_LABELS` 一对)。
 *
 * 取的是 VS Code `gitDecoration.*` 那套 token,让徽章的颜色语义与用户在编辑器里
 * 看到的一致。深浅两套取值在 token 层翻,这里不出现 `dark:` 变体。
 */
const CODE_COLORS: Record<StatusCode, string> = {
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
 * 冲突条目的徽章:**XY 两位一起印**。
 *
 * 一位不够:`DD`(双方都删)与 `UU`(双方都改)只印一位时长得一模一样,而它们是
 * 用户要采取的两种完全不同的动作。这里刻意**不**把七种组合各翻一句话 —— 那是
 * porcelain 的记录语义,前端一旦写下来就成了第二份 git 知识(架构边界不变式 4);
 * 字母是 git 自己的表述,原样印出来既不会说错,也与 `git status` 一致。
 *
 * 颜色取 `CODE_COLORS.U` 而不是再写一遍那个 token:两处各写一份时,调冲突色只改
 * 一处的话,同一个页面上冲突组与别处的 `U` 会是两个颜色。宽度与居中沿用
 * `StatusBadge` 的 `w-5 text-center`(两个等宽小字正好放得下),否则冲突组的文件名
 * 会比别的组横着挪一截。
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

// focus-visible 那两个类是键盘可达性的最低档:列表项是 <button>,而 preflight 清掉了
// UA 默认焦点环。用 focus-border token 画,深浅都跟着翻
const ROW_CLASS =
  'flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus-border';

function FileRow({ file, group }: { file: FileEntry; group: ChangeGroup['id'] }) {
  const { dir, name } = splitForDisplay(file.path);
  /**
   * 选中态包成 `computed` 再作为 prop 传下去,**不在组件体里读 `selectedPath.value`**。
   *
   * 在组件体里读等于这一行订阅了它:换选中时 320 行全部重新渲染,其中 318 行产出的
   * vnode 与上一次逐字相同。作为 prop 传时 signals 把更新直接绑到 DOM 属性上,只写
   * 两个 class、组件一个都不重渲。
   *
   * **实测(本机 320 文件仓库,点击到高亮移动)**:组件体里读 0.8ms 中位 / 1.5ms p90,
   * 换成本写法后 0.2ms / 0.5ms。绝对值都不大 —— 记在这里是因为行内容还会长
   * (S4a 的重命名标注),而这条路径 S3b1 起每个 SSE 事件都要走一遍。
   */
  // 基础类只写一次,三元里只放选中/未选中的**差量** —— 两个分支各拼一遍 ROW_CLASS 的话,
  // 以后"选中行也加个 X"要改两处,而 diff 上也看不出到底哪个分支变了
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
        // 整个条目交回 store —— 取 diff 要带哪些参数(重命名的 oldPath)属 git 知识,
        // 不在组件里重写一遍(架构边界不变式 4)
        onClick={() => selectFile(file)}
        // 目录段被裁掉是**设计中的常态**(见下),完整路径于是在列表里找不回来了 ——
        // 挂在整行上补一份。不放在目录那个 span 上:它被裁到零宽时就没得可悬停了
        title={file.path}
        class={rowClass}
      >
        {/* 每个分组只展示它自己那一侧的状态位 —— 「已暂存」看 X,其余看 Y;
            冲突条目两侧都不是 `.`,挑哪一位都会丢掉另一半。
            **「印两位」的判据是条目自己的 `conflicted`,不是它落在哪一组**:
            按分组判的话,这一行画得对不对就取决于 `groupFiles` 与这里是否一致,
            而那个一致性没有任何东西在管 */}
        {file.conflicted ? (
          <ConflictBadge staged={file.staged} unstaged={file.unstaged} />
        ) : (
          <StatusBadge code={group === 'staged' ? file.staged : file.unstaged} />
        )}
        {/* 文件名在前、目录在后。侧栏定宽 320px,而 `truncate` 的省略号在**右**端 ——
            目录排在后面时,放不下先没的就是目录、文件名留到最后,这正是要的取舍;
            改回「目录前缀 + 文件名」的老写法则反过来先吃掉文件名,而它才是认出这一行的东西。
            **两段必须同住这一个 truncate span**:拆成两个平级的 flex 子项会静默毁掉基线对齐,
            还得靠 flex-basis 去调谁先被裁、连带把下面那段重命名标注推到侧栏最右
            (`change-list.test.tsx` 里「同住一个 truncate span」那条钉着树的形状)。
            `min-w-0` 不能省:flex 子项的 min-width 默认 auto,不给它时 overflow:hidden 收不住 */}
        <span class="min-w-0 truncate">
          {name}
          {dir && <span class="ml-2 text-xs text-description-foreground">{dir}</span>}
        </span>
        {/* 重命名的判据是 oldPath 存在,不是比对路径(架构边界不变式 4)。
            点开后的 rename from/to 与相似度标注属 S4a,这里只把旧路径说清楚。 */}
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

function Group({ group }: { group: ChangeGroup }) {
  if (group.files.length === 0) return null;
  return (
    <section>
      <h2 class="sticky top-0 bg-side-bar-section-header-background px-3 py-1 text-xs font-medium text-description-foreground">
        {group.title}
        <span class="ml-1">{group.files.length}</span>
      </h2>
      <ul>
        {group.files.map((file) => (
          <FileRow key={file.path} file={file} group={group.id} />
        ))}
      </ul>
    </section>
  );
}

export function ChangeList({ files }: { files: readonly FileEntry[] }) {
  if (files.length === 0) {
    return (
      <p class="px-3 py-2 text-sm text-description-foreground">Working tree clean — no changes.</p>
    );
  }
  return (
    <div>
      {groupFiles(files).map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </div>
  );
}
