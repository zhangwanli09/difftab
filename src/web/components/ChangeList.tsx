// 变更文件列表(spec §5.4 / §6「变更列表与分支状态」)。
//
// 按 path keyed:SSE 刷新时列表会整份换掉,靠 key 让 Preact 只动真正变了的行,
// 选中态与滚动位置才留得住(§5.4 —— 这正是不自己写 reconcile 的理由)。

import { useComputed } from '@preact/signals';
import type { FileEntry, StatusCode } from '../../server/shared/protocol';
import { type ChangeGroup, groupFiles, selectedPath, selectFile } from '../state/store';

/**
 * 状态位的**展示文案**,与 §5.2 的解析无关 —— 徽章上印的是 git 自己的字母,
 * 这张表只作为 tooltip 把字母翻译一次。含义的唯一事实来源是 `StatusCode` 的
 * 类型注释(§5.0 不变式 4:前端不得出现第二份状态位实现)。
 */
const CODE_LABELS: Record<StatusCode, string> = {
  '.': '未改动',
  M: '修改',
  T: '类型变更',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '未合并',
  '?': '未跟踪',
};

/**
 * 路径拆成目录与文件名两段展示。
 *
 * 分隔符恒为 `/`(§5.12:路径「以 `/` 分隔」,由后端保证),因此这里不需要也
 * 不应该考虑平台差异 —— 那属于 git 知识,留在后端。
 */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function StatusBadge({ code }: { code: StatusCode }) {
  return (
    <span
      title={CODE_LABELS[code]}
      class="w-5 shrink-0 text-center font-mono text-xs text-neutral-500"
    >
      {code}
    </span>
  );
}

const ROW_CLASS = 'flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm';

function FileRow({ file, group }: { file: FileEntry; group: ChangeGroup['id'] }) {
  const { dir, name } = splitPath(file.path);
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
  const rowClass = useComputed(
    () =>
      `${ROW_CLASS} ${selectedPath.value === file.path ? 'bg-neutral-200' : 'hover:bg-neutral-100'}`,
  );
  return (
    <li>
      <button
        type="button"
        // 整个条目交回 store —— 取 diff 要带哪些参数(重命名的 oldPath)属 git 知识,
        // 不在组件里重写一遍(§5.0 不变式 4)
        onClick={() => selectFile(file)}
        class={rowClass}
      >
        {/* 每个分组只展示它自己那一侧的状态位 —— 「已暂存」看 X,其余看 Y */}
        <StatusBadge code={group === 'staged' ? file.staged : file.unstaged} />
        <span class="truncate">
          {dir && <span class="text-neutral-500">{dir}</span>}
          <span>{name}</span>
        </span>
        {/* 重命名的判据是 oldPath 存在,不是比对路径(§5.0 不变式 4)。
            点开后的 rename from/to 与相似度标注属 S4a,这里只把旧路径说清楚。 */}
        {file.oldPath && (
          <span class="truncate text-xs text-neutral-500">
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
      <h2 class="sticky top-0 bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
        {group.title}
        <span class="ml-1 text-neutral-400">{group.files.length}</span>
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
    return <p class="px-3 py-2 text-sm text-neutral-500">工作区干净,没有变更。</p>;
  }
  return (
    <div>
      {groupFiles(files).map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </div>
  );
}
