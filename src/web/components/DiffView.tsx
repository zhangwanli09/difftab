// 单个文件的 diff 视图(spec §5.5 / §5.12 的 `DiffPayload`)。
//
// **这是 vdom 与 diff2html 的交界**:列表由 Preact 管,单文件 diff 容器由
// `Diff2HtmlUI` 管(§5.5)。`draw()` 内部是 `innerHTML` 赋值加命令式事件绑定,
// 因此容器必须满足两条:
//   1. 渲染发生在 Preact 提交 DOM **之后** —— 靠 effect,不在渲染期直接摸 DOM;
//   2. 那个容器在 vdom 里**永远没有子节点**,否则两边会对着同一棵子树各改各的,
//      Preact 下一次 diff 时按自己记得的空子树去比对真实的一大棵 DOM。
//
// 四个 `kind` 全部在这里分支。binary / too-large 的**填充逻辑**要到 S4a 才落地
// (后端现在还不返回它们),但渲染分支现在就得有 —— 按单一形状写死,等于把 S4a
// 变成一次回头改渲染的返工(§5.12「字段定型时机」)。

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { DiffPayload } from '../../server/shared/protocol';
import { renderDiff } from '../diff/render';
import { diffState } from '../state/store';

/** 提示行的统一外观 —— 空态、加载中、错误、二进制、超大文件共用。 */
function Notice({ children }: { children: ComponentChildren }) {
  return <p class="p-4 text-sm text-neutral-500">{children}</p>;
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
 * **不能一律按 MB 取整**:`too-large` 有两个触发口(§5.2),体积超 5MB 是一个,
 * 行数超 50,000 是另一个 —— 后者的文件可能只有几百 KB,按 MB 取整会显示
 * 「文件过大(0 MB)」,自相矛盾且把真正的原因(行太多)盖掉了。
 *
 * TODO(S4a):`DiffPayload` 现在只带体积、不带触发原因,所以这里最多做到「数字不
 * 荒谬」。要把「行数太多」说出来得先改 §5.12 的协议类型,那属 S4a 填充这两个分支
 * 的时候一并定。
 */
function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Payload({ payload }: { payload: DiffPayload }) {
  switch (payload.kind) {
    case 'text':
    case 'untracked-text':
      return <Patch patch={payload.patch} />;
    // TODO(S4a):后端填充这两个分支时一并核对文案与 §6 的「仅提示变更不做内容 diff」
    case 'binary':
      return <Notice>二进制文件,不做内容比对。</Notice>;
    case 'too-large':
      return <Notice>文件过大({formatSize(payload.size)}),不预览。</Notice>;
  }
}

export function DiffView() {
  // `diffState` 一个来源说清「选了谁」与「取到没有」:`selectedPath` 由它派生,
  // 两者不可能错位,组件因此不需要一条防错位的分支(见 store.ts)
  const state = diffState.value;
  if (state === null) return <Notice>从左侧选一个文件。</Notice>;

  return (
    <div>
      <h2 class="border-b border-neutral-200 px-4 py-2 font-mono text-sm break-all">
        {state.path}
      </h2>
      {state.status === 'loading' && <Notice>读取中…</Notice>}
      {state.status === 'error' && <Notice>取不到这个文件的 diff:{state.message}</Notice>}
      {/* key 让换文件走卸载重挂,两次 draw() 因此不可能落在同一个元素上 */}
      {state.status === 'ready' && <Payload key={state.path} payload={state.payload} />}
    </div>
  );
}
