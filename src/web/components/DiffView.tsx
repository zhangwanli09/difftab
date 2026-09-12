// 单个文件的 diff 视图(`DiffPayload`)。
//
// **这是 vdom 与 diff2html 的交界**：列表由 Preact 管，单文件 diff 容器由 `Diff2HtmlUI` 管。
// `draw()` 内部是 `innerHTML` 赋值加命令式事件绑定，因此容器必须满足两条：
//   1. 渲染发生在 Preact 提交 DOM **之后**——靠 effect，不在渲染期直接摸 DOM；
//   2. 那个容器在 vdom 里**永远没有子节点**，否则两边会对着同一棵子树各改各的，Preact 下一次
//      diff 时会按自己记得的空子树去比对真实的一大棵 DOM。
//
// 四个 `kind` 全部在这里分支：前端不区分 binary / too-large 来自哪条路，它拿到的就是同一个
// 判别联合。

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { DiffPayload } from '../../server/shared/protocol';
import { renderDiff } from '../diff/render';
import { diffOutputFormat } from '../state/layout';
import { diffStates, type RenameInfo } from '../state/store';

/**
 * 提示行的统一外观——加载中、错误、二进制、超大文件共用。**导出给文件视图共用**：
 * 两边说的都是「这里没有正文可看」，各写一份的症状是同一类提示在两个面板里内边距不一样。
 * 栏里一个 tab 都没有那一路不走它（`App` 画 `PanelEmptyState`）：那是面板空着，不是某个文件
 * 出了状况。
 */
export function Notice({ children }: { children: ComponentChildren }) {
  return <p class="p-4 text-sm text-description-foreground">{children}</p>;
}

/**
 * 把一段 unified diff 交给 diff2html 渲染。
 *
 * **同一个文件拿到新补丁**（SSE 刷新）时容器留在原地，靠 `[patch]` 依赖重跑本 effect，
 * `draw()` 自己覆盖 `innerHTML`。这条路径要成立，`loadDiff` 就不能在同一个文件重新取时回退到
 * loading 态：一回退，子树先卸载再重挂，滚动位置随之丢失。换文件那一路走的是卸载重挂（`key`
 * 由调用方按 path 给），不需要自己再清一次 `innerHTML`。
 *
 * **版式也是重画的理由，必须进依赖数组**：`draw()` 是命令式的，格式变了不重跑就永远停在旧版
 * 式上——不报错，只是拖窗口时视图纹丝不动。在 body 里读这个 signal 是安全的：本组件刻意没有
 * 子节点，重渲染只是复用同一个空 div，两次 `draw()` 因此落在同一个元素上。
 */
function Patch({ path, patch }: { path: string; patch: string }) {
  const host = useRef<HTMLDivElement>(null);
  const format = diffOutputFormat.value;

  // path 只用来判语言（`languageOf`），换文件那一路本来就靠 key 卸载重挂——依赖仍要写全，
  // 少一个就是「依赖数组与实参对不上」，而那种漏在别的路径上就是静默停在旧值
  useEffect(() => {
    if (host.current) renderDiff(host.current, path, patch, format);
  }, [path, patch, format]);

  // 刻意没有子节点：里面的一切都归 diff2html。**`relative` 不是排版需要，是 diff2html 行号列
  // 的包含块**——它把行号做成 `position: absolute`，而包含块在滚动容器之外的绝对定位盒不随容
  // 器内容滚动，少了这个类，右侧一滚整列行号就原地钉死、与代码行错开，页面不报任何错
  return <div ref={host} class="relative" />;
}

/**
 * 体积的可读写法。**不能一律按 MB 取整**：`reason: 'lines'` 那一路的文件可能只有几百 KB，按
 * MB 取整会显示「0 MB」。**导出给文件视图共用**——两份拷贝在第一次提交时就已经漂开过一次
 * （那边漏掉了下面 `size > 0` 那道）。
 */
export function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 拒绝预览的原因(`reason`)。两个触发口的文案必须不同：行数那一路的体积可能只有几百 KB，单说
 * 「文件过大」会让用户对着一个不大的数字发愣。**具体阈值（5MB / 50,000 行）刻意不写在这里**
 *——它属 server/git 那一侧的判据，复述一遍就是第二份事实来源。
 *
 * `verb` 是两个面板唯一的差别：diff 那侧说的是「不预览这份补丁」，文件视图说的是「不显示
 * 这份正文」。**其余（含 `size > 0` 那道）必须共用**——各写一份时漂开的正是那一道。
 */
export function tooLargeNotice(
  payload: Extract<DiffPayload, { kind: 'too-large' }>,
  verb: 'preview' | 'show',
): string {
  // 体积可能压根取不到：已被删除的文件在工作区已经没有了，后端给的是 0。那时不能照着
  // formatSize 报一个「1 KB」——编一个数出来比不说更糟。两个 reason 都会遇上，判据只写一次
  const size = payload.size > 0 ? formatSize(payload.size) : null;
  if (payload.reason === 'lines') {
    return size ? `Too many lines to ${verb} (${size} in total).` : `Too many lines to ${verb}.`;
  }
  return size ? `File too large to ${verb} (${size}).` : `File too large to ${verb}.`;
}

/**
 * 重命名标注。补丁正文里的 `rename from/to` 由 diff2html 画在文件头上（旧名 → 新名），但那是
 * `RENAMED` 标签、且**不含相似度**——相似度来自 status 的 `R<score>`，是我们自己带下来的。
 * 两者不重复：这一行说的是「这个条目是什么」，补丁头说的是「这份补丁是什么」，而 binary /
 * too-large 那几路压根没有补丁头。
 */
function RenameNotice({ rename }: { rename: RenameInfo }) {
  return (
    <p class="border-b border-panel-border px-4 py-1 text-xs text-description-foreground">
      Renamed from <span class="font-mono break-all">{rename.oldPath}</span>
      {rename.score !== null && ` (${rename.score}% similar)`}
    </p>
  );
}

/**
 * 面板里唯一滚的那一层。**两个视图共用**，理由与 `Notice` 一字不差——它是 `App` 那个
 * `<section>`（一列 flex：标签栏 `shrink-0` 占第一行，这一层 `min-h-0 flex-1 overflow-auto`）
 * 的直接子项，类名必须逐字相同：各写一份时漂开的症状是「其中一个面板底下那半屏不跟着滚」，
 * 不报错。滚动区里放什么由调用方给：diff 那侧是补丁与提示行，文件视图那侧还要多一层按内容
 * 撑宽的盒子。
 *
 * 面板的 chrome 只有 `EditorTabs` 那一条，它排在滚动区域之外，因此这里既不需要 `sticky top-0`
 * 也不需要 `z-10`——从前两者是一对：diff2html 的行号列是 `position: absolute`、`Patch` 的宿主
 * div 又带着 `relative`，两者都排在横杠之后，而定位元素之间 z-index 为 auto 时按 DOM 顺序绘
 * 制，于是粘住的横杠会被滚上来的代码整条盖住；现在那些盒子被滚动容器的 `overflow` 裁掉，压根
 * 够不着标签栏。
 */
export function Panel({ children }: { children: ComponentChildren }) {
  return <div class="min-h-0 flex-1 overflow-auto">{children}</div>;
}

function Payload({ path, payload }: { path: string; payload: DiffPayload }) {
  switch (payload.kind) {
    case 'text':
    case 'untracked-text':
      return <Patch path={path} patch={payload.patch} />;
    case 'binary':
      return <Notice>Binary file — contents are not compared.</Notice>;
    case 'too-large':
      return <Notice>{tooLargeNotice(payload, 'preview')}</Notice>;
  }
}

/**
 * 活动 diff tab 的视图。`path` 由 `App` 从活动 tab 给，本组件按它读缓存。**在渲染体里读 map，
 * 不用 `useComputed` 包一层**：`useComputed` 只在 signal 依赖变了时重算，`path` prop 换了而
 * map 没写时它停在上一个 tab 的正文上——页面上就是「切了 tab 标题变了正文没变」。本组件只是
 * 一个订阅者，每次 map 写入重渲染一次，代价可以忽略。
 */
export function DiffView({ path }: { path: string }) {
  // 缓存里没有这一项就按加载中画：`openEditor` 与写 loading 在同一个同步 tick 里，产品里到不了，
  // 兜底只为让组件对每个状态都有答案
  const state = diffStates.value.get(path) ?? { status: 'loading', rename: null };

  return (
    <Panel>
      {/* 三个状态下都标注：标注属于「选了哪个条目」，与补丁取到没有无关。它跟着补丁一起滚
          ——这一行说的是这份补丁的来历，不是「我在看哪个文件」，后者由标签栏答 */}
      {state.rename && <RenameNotice rename={state.rename} />}
      {state.status === 'loading' && <Notice>Loading…</Notice>}
      {state.status === 'error' && (
        <Notice>Could not load the diff for this file: {state.message}</Notice>
      )}
      {/* 换文件走的是卸载重挂——`App` 按 tab 键给本组件 `key`，本组件挂着期间 `path` 不会变，
          两次 draw() 因此不可能落在同一个元素上 */}
      {state.status === 'ready' && <Payload path={path} payload={state.payload} />}
    </Panel>
  );
}
