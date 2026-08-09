// 前端状态(spec §5.4)。signals 而非 useState:SSE 刷新要在**不丢失当前选中文件
// 与滚动位置**的前提下更新列表,状态必须活在组件树之外(§5.4 / §5.7)。
//
// 本文件是 §5.0 不变式 4 的落脚点之一:**前端不内联任何 git 知识**。
// 「这一侧算不算有改动」的判据在 `shared/protocol.ts`(`hasStagedChange` 等)——
// 那三个谓词看着像 `!== '.'` 的同义反复,其实不是,`?` 与 `U` 都不能按字面读。
// 本文件只负责把它们组织成三组;「重命名」同理看 `oldPath` 而不比对路径。

import { signal } from '@preact/signals';
import {
  type ErrorPayload,
  type FileEntry,
  hasStagedChange,
  hasUnstagedChange,
  isUntracked,
  type RepoState,
} from '../../server/shared/protocol';

/** `GET /api/state` 的结果。null 表示还没拿到第一份。 */
export const repoState = signal<RepoState | null>(null);

/** 取不到状态时展示给用户的一句话。后端已保证不含绝对路径(§5.12)。 */
export const loadError = signal<string | null>(null);

/**
 * 当前选中的文件路径。
 *
 * 存 path 而不是 `FileEntry` 对象:列表刷新后条目是新对象,存对象等于每次刷新
 * 都丢选中。path 是 §5.12 里 `/api/diff` 的键,天然是这个身份(§5.4)。
 */
export const selectedPath = signal<string | null>(null);

export type ChangeGroupId = 'staged' | 'unstaged' | 'untracked';

export interface ChangeGroup {
  id: ChangeGroupId;
  title: string;
  files: FileEntry[];
}

/**
 * 三个分组(spec §6「变更文件列表……已暂存、未暂存、未跟踪三类文件均正确展示」)。
 *
 * **同一个文件可以同时出现在「已暂存」和「未暂存」里**,这不是 bug:porcelain 的
 * XY 是两位独立状态位,`git add` 之后再改一次就是 `X=M Y=M`(fixture 里的 c.txt)。
 * 强行归一到一个桶,等于在前端替用户丢掉一半信息 —— 而「agent 执行过 git add 后
 * 已暂存的改动仍能展示不遗漏」正是 §6 点名的验收项。
 *
 * 顺序沿用后端给的顺序(git 自己按路径排好的),不在前端再排一次:多一份排序意见
 * 就多一处与 `git status` 不一致的可能,而验收标准是「与 git status 结果一致」。
 */
export function groupFiles(files: readonly FileEntry[]): ChangeGroup[] {
  return [
    { id: 'staged', title: '已暂存', files: files.filter(hasStagedChange) },
    { id: 'unstaged', title: '未暂存', files: files.filter(hasUnstagedChange) },
    // -uall 保证这里是文件粒度,不会是折叠后的 `dir/`(§5.2)
    { id: 'untracked', title: '未跟踪', files: files.filter(isUntracked) },
  ];
}

/** 从任意失败里取一句可展示的话。永远返回非空字符串,免得 UI 出现空白的错误条。 */
function toMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '未知错误';
}

/**
 * 失败响应的正文 → 一句话。
 *
 * **不能直接 `res.json()`**:错误正文未必是 JSON。`pnpm dev` 下后端没起来时,
 * Vite 代理回的是纯文本 500,`json()` 会先抛 SyntaxError,于是错误条上显示的是
 * 「Unexpected token 'E'…」而不是「后端连不上」—— 真正的原因被解析错误盖掉了。
 */
function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as Partial<ErrorPayload>;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 不是 JSON —— 这条路径本身就是上面说的那种情况
  }
  return `请求失败(HTTP ${status})`;
}

/**
 * 已发出的最新一次请求的序号。
 *
 * S3b1 起 SSE 的每个 `change` 事件都会调一次 `loadState()`,而 agent 跑动期间事件
 * 密集:两次请求重叠时先发的**可能后到**,旧快照就会盖掉新快照,列表停在过期
 * 状态直到下一次事件 —— 不报错,只是显示的东西不对。判据放在这里而不是留给调用方,
 * 是因为调用方没有理由知道这件事。
 */
let latestRequest = 0;

/**
 * 拉一次 `/api/state`。
 *
 * 不带任何鉴权参数:token 在生产下由启动 URL 的 302 换成了 HttpOnly cookie、在
 * `vite dev` 下由代理注入(§5.9 / §5.11),两条路径浏览器都会自动带上。前端因此
 * 完全不接触 token —— 它一旦落到 JS 能读的地方,HttpOnly 就白设了。
 */
export async function loadState(): Promise<void> {
  const ticket = ++latestRequest;
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(messageFrom(text, res.status));
    const state = JSON.parse(text) as RepoState;
    if (ticket !== latestRequest) return;
    repoState.value = state;
    loadError.value = null;
  } catch (cause) {
    if (ticket !== latestRequest) return;
    loadError.value = toMessage(cause);
  }
}
