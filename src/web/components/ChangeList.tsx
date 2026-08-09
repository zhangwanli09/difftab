// 变更文件列表(spec §5.4 / §6「变更列表与分支状态」)。
//
// 按 path keyed:SSE 刷新时列表会整份换掉,靠 key 让 Preact 只动真正变了的行,
// 选中态与滚动位置才留得住(§5.4 —— 这正是不自己写 reconcile 的理由)。

import type { FileEntry, StatusCode } from '../../server/shared/protocol';
import { type ChangeGroup, groupFiles, selectedPath } from '../state/store';

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

function FileRow({ file, group }: { file: FileEntry; group: ChangeGroup['id'] }) {
  const { dir, name } = splitPath(file.path);
  const active = selectedPath.value === file.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          selectedPath.value = file.path;
        }}
        class={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm ${
          active ? 'bg-neutral-200' : 'hover:bg-neutral-100'
        }`}
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
