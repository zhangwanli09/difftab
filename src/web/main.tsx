// 前端入口。接上主题 + 挂载 + 拉第一份状态 + 订阅变更 + 把标题接上,别的都不做。

import { render } from 'preact';

import { App } from './components/App';
import { connectEvents } from './state/events';
import { loadState } from './state/store';
import { syncDocumentTheme } from './state/theme';
import { syncDocumentTitle } from './state/title';
import './styles/app.css';

const root = document.getElementById('app');
if (root) {
  // **排在 render 之前**,让 <html> 上那个 data-theme 尽早落下去。首帧仍可能闪一下系统色:
  // CSP 是 `script-src 'self'`,页面里塞不了那段惯用的 pre-paint 内联脚本
  syncDocumentTheme();
  render(<App />, root);
  // 挂载之后再发请求:首屏先出骨架,数据到了 signals 自己会把列表补上
  void loadState();
  // 订阅不等首份状态回来:两者互不依赖,而串起来只会让第一次变更晚一个来回。这里不留取消订阅
  // 的句柄 —— 整页只挂载一次,页面关掉即结束(空闲退出正是以这条连接断开为判据)
  connectEvents();
  // 标题跟着 `repoState` 走。同样不留句柄;放在 `loadState()` 之后也无所谓 —— effect 首次订阅
  // 时立刻跑一次,而那一刻 `repoState` 还是 null,标题停在 index.html 里那个兜底值上
  syncDocumentTitle();
}
