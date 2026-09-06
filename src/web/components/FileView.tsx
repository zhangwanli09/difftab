// 单个文件的只读全文（`FilePayload`）。
//
// **这不是 diff**：每一行前面不挂 `+`、底色不是新增绿——「看项目整体面貌」正是要摆脱补丁
// 视角。因此它不走 diff2html，只用 hljs 高亮一次，行号另起一栏。
//
// 四个 `kind` 全部在这里分支，提示行与 DiffView 共用同一个 `Notice`。

import { useMemo } from 'preact/hooks';
import type { FilePayload } from '../../server/shared/protocol';
import { getHljs, languageOf } from '../diff/hljs';
import { fileState } from '../state/store';
import { Notice, PathHeader, tooLargeNotice } from './DiffView';

/**
 * 正文 + 行号。
 *
 * **行号是兄弟元素，不按行切高亮输出**：hljs 的 span 会跨行，切开要自己重开标签补齐——那正是
 * 红线在 diff2html 上明令禁止的事，换个地方做不会变得更容易。两个 `<pre>` 共用同一个
 * `leading-5`，对齐就成立；行号槽 `sticky left-0`，横向滚代码时它留在左边。
 *
 * **容器上不加 `hljs` 类**：`hljs-theme.css` 里那条 `.hljs { background: … }` 是 unlayered
 * 的，会压过 `bg-editor-background`，症状只是「文件视图底色跟页面其余部分对不上」。15 条
 * token 规则（`.hljs-keyword` 之类）是独立选择器，不挂容器类照样命中。
 */
function Content({ path, content }: { path: string; content: string }) {
  /**
   * 高亮一份 5MB 的正文不便宜，而每次重渲染（换主题、换选中）都会走到这里。**行号槽也在同
   * 一个 memo 里**：它同样要按 `\n` 切一遍整份正文，留在 memo 外的话 SSE 刷新时正文逐字节
   * 没变也照样重算一遍——而高亮那半正确地跳过了。
   */
  const { html, gutter } = useMemo(() => {
    const hljs = getHljs();
    // 末尾那个换行不算一行——否则每个正常结尾的文件都会多出一个空行号
    const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
    return {
      html: hljs.highlight(content, { language: languageOf(path) }).value,
      gutter: lines.map((_, index) => index + 1).join('\n'),
    };
  }, [path, content]);

  return (
    <div class="flex font-mono text-xs leading-5">
      {/* select-none：拖选正文时不该把行号一起选进剪贴板 */}
      <pre class="sticky left-0 shrink-0 bg-editor-background px-3 py-2 text-right text-description-foreground select-none">
        {gutter}
      </pre>
      {/* dangerouslySetInnerHTML 的内容来自 hljs——它自己转义了正文里的一切标记 */}
      <pre class="min-w-0 py-2 pr-4" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Payload({ path, payload }: { path: string; payload: FilePayload }) {
  switch (payload.kind) {
    case 'text':
      return <Content path={path} content={payload.content} />;
    case 'symlink':
      // 说的是「这是一个指向 X 的链接」而不是「这是 X 的内容」——我们刻意没有跟随它
      return (
        <Notice>
          Symbolic link to <span class="font-mono break-all">{payload.target}</span>
        </Notice>
      );
    case 'binary':
      return <Notice>Binary file — contents are not shown.</Notice>;
    case 'too-large':
      return <Notice>{tooLargeNotice(payload, 'show')}</Notice>;
  }
}

export function FileView() {
  const state = fileState.value;
  // 与 diff 那侧共用同一句：两个 tab 下指的都是左栏，而左栏此刻列的是什么用户自己看得见
  if (state === null) return <Notice>Select a file on the left.</Notice>;

  return (
    <div>
      <PathHeader path={state.path} />
      {state.status === 'loading' && <Notice>Loading…</Notice>}
      {state.status === 'error' && <Notice>Could not load this file: {state.message}</Notice>}
      {/* key 让换文件走卸载重挂，两份正文因此不可能落在同一棵子树上 */}
      {state.status === 'ready' && (
        <Payload key={state.path} path={state.path} payload={state.payload} />
      )}
    </div>
  );
}
