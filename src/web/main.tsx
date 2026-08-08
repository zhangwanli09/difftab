import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

import { renderDiff } from './diff/render';
import { SAMPLE_PATCH } from './spike-sample';
import './styles/app.css';

// ---------------------------------------------------------------------------
// S0 spike 入口。
//
// 存在的理由是第 7 节的三项前提验证需要一个真实产物来量:
//   1. @import "tailwindcss" 展开后,后续 @import 的内容是否仍为 unlayered
//   2. 深导入 diff2html-ui-base 能否被 Rolldown 正确 tree-shake、hljs 能否注入、
//      highlightCode() 是否真的出颜色
//   3. 22 个语言模块 + diff2html + hogan + jsdiff + preact 的打包体积
//
// TODO(S2):整体替换为变更列表 + 分支状态 + 懒加载 diff 容器。
// ---------------------------------------------------------------------------

const selected = signal<string>('spike');

function DiffView({ patch }: { patch: string }) {
  const host = useRef<HTMLDivElement>(null);

  // draw() 内部是 innerHTML 赋值 + 命令式事件绑定,必须在 ref 就位之后跑,
  // 不与 vdom 争夺同一棵子树(spec §5.5)
  useEffect(() => {
    if (host.current) {
      renderDiff(host.current, patch);
    }
  }, [patch]);

  return <div ref={host} />;
}

function App() {
  return (
    <main>
      <h1>GitGlance · S0 spike</h1>
      <p>selected: {selected.value}</p>
      <DiffView patch={SAMPLE_PATCH} />
    </main>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
