// 单个文件的 diff 视图(spec §5.5 / §5.12 的 `DiffPayload`)。
//
// **这是 vdom 与 diff2html 的交界**:列表由 Preact 管,单文件 diff 容器由
// `Diff2HtmlUI` 管(§5.5)。`draw()` 内部是 `innerHTML` 赋值加命令式事件绑定,
// 因此容器必须满足两条:
//   1. 渲染发生在 Preact 提交 DOM **之后** —— 靠 effect,不在渲染期直接摸 DOM;
//   2. 那个容器在 vdom 里**永远没有子节点**,否则两边会对着同一棵子树各改各的,
//      Preact 下一次 diff 时按自己记得的空子树去比对真实的一大棵 DOM。
//
// 四个 `kind` 全部在这里分支。S4a 起两条路都会填 binary / too-large:未跟踪那条靠
// NUL 探测与文件体积,已跟踪那条靠 `--numstat` 与 `lstat`(§5.2)—— 前端不区分来源,
// 它拿到的就是同一个判别联合(§5.0 不变式 4)。

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { DiffPayload } from '../../server/shared/protocol';
import { renderDiff } from '../diff/render';
import { diffState, type RenameInfo } from '../state/store';

/** 提示行的统一外观 —— 空态、加载中、错误、二进制、超大文件共用。 */
function Notice({ children }: { children: ComponentChildren }) {
  return <p class="p-4 text-sm text-description-foreground">{children}</p>;
}

/**
 * 把一段 unified diff 交给 diff2html 渲染。
 *
 * **同一个文件拿到新补丁**(S3b1 的 SSE 刷新)时容器留在原地,靠 `[patch]` 依赖重跑本
 * effect,`draw()` 自己覆盖 `innerHTML`。这条路径要成立,`loadDiff` 就不能在同一个文件
 * 重新取时回退到 loading 态(见 store.ts):一回退,子树先卸载再重挂,滚动位置随之丢失。
 *
 * 换文件那一路走的是卸载重挂(`key` 由调用方按 path 给),Preact 会把这个 div 连同
 * 底下 diff2html 的 DOM 一起摘掉 —— 不需要自己再清一次 `innerHTML`,那只是把一棵
 * 马上要被丢弃的大子树先拆一遍。
 */
function Patch({ patch }: { patch: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (host.current) renderDiff(host.current, patch);
  }, [patch]);

  // 刻意没有子节点:里面的一切都归 diff2html(见文件头)
  return <div ref={host} />;
}

/**
 * 体积的可读写法。
 *
 * **不能一律按 MB 取整**:`reason: 'lines'` 那一路的文件可能只有几百 KB(§5.12),
 * 按 MB 取整会显示「0 MB」。
 */
function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 拒绝预览的原因(§5.12 的 `reason`)。
 *
 * 两个触发口的文案必须不同:行数那一路的体积可能只有几百 KB,单说「文件过大」会
 * 让用户对着一个不大的数字发愣。**具体阈值(5MB / 50,000 行)刻意不写在这里** ——
 * 它属 server/git 那一侧的判据,复述一遍就是第二份事实来源(§5.0 不变式 4)。
 */
function tooLargeNotice(payload: Extract<DiffPayload, { kind: 'too-large' }>): string {
  // 体积可能压根取不到:已被删除的文件在工作区已经没有了,后端给的是 0(§5.12)。
  // 那时不能照着 formatSize 报一个「1 KB」—— 编一个数出来比不说更糟。
  // 两个 reason 都会遇上这件事,所以判据只写一次
  const size = payload.size > 0 ? formatSize(payload.size) : null;
  if (payload.reason === 'lines') {
    return size ? `文件行数过多,不预览(共 ${size})。` : '文件行数过多,不预览。';
  }
  return size ? `文件过大(${size}),不预览。` : '文件过大,不预览。';
}

/**
 * 重命名标注(§6:「点开后标注为重命名,展示 rename from/to 与相似度」)。
 *
 * 补丁正文里的 `rename from/to` 由 diff2html 画在文件头上(旧名 → 新名),但那是
 * 英文的 `RENAMED` 标签、且**不含相似度** —— 相似度来自 status 的 `R<score>`,
 * 是我们自己带下来的。两者不重复:这一行说的是「这个条目是什么」,补丁头说的是
 * 「这份补丁是什么」,而 binary / too-large 那几路压根没有补丁头。
 */
function RenameNotice({ rename }: { rename: RenameInfo }) {
  return (
    <p class="border-b border-panel-border px-4 py-1 text-xs text-description-foreground">
      重命名自 <span class="font-mono break-all">{rename.oldPath}</span>
      {rename.score !== null && `(相似度 ${rename.score}%)`}
    </p>
  );
}

function Payload({ payload }: { payload: DiffPayload }) {
  switch (payload.kind) {
    case 'text':
    case 'untracked-text':
      return <Patch patch={payload.patch} />;
    case 'binary':
      return <Notice>二进制文件,不做内容比对。</Notice>;
    case 'too-large':
      return <Notice>{tooLargeNotice(payload)}</Notice>;
  }
}

export function DiffView() {
  // `diffState` 一个来源说清「选了谁」与「取到没有」:`selectedPath` 由它派生,
  // 两者不可能错位,组件因此不需要一条防错位的分支(见 store.ts)
  const state = diffState.value;
  if (state === null) return <Notice>从左侧选一个文件。</Notice>;

  return (
    <div>
      <h2 class="border-b border-panel-border bg-title-bar-background px-4 py-2 font-mono text-sm break-all">
        {state.path}
      </h2>
      {/* 三个状态下都标注:标注属于「选了哪个条目」,与补丁取到没有无关 */}
      {state.rename && <RenameNotice rename={state.rename} />}
      {state.status === 'loading' && <Notice>读取中…</Notice>}
      {state.status === 'error' && <Notice>取不到这个文件的 diff:{state.message}</Notice>}
      {/* key 让换文件走卸载重挂,两次 draw() 因此不可能落在同一个元素上 */}
      {state.status === 'ready' && <Payload key={state.path} payload={state.payload} />}
    </div>
  );
}
