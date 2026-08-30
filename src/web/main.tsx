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
  // **排在 render 之前**,让 <html> 上那个 data-theme 尽早落下去。首帧仍可能闪一下
  // 系统色:CSP 是 `script-src 'self'`,页面里塞不了那段惯用的 pre-paint 内联脚本 ——
  // 代价只落在显式选过档、且选的与系统相反的人身上,闪的是一帧底色
  syncDocumentTheme();
  render(<App />, root);
  // 挂载之后再发请求:首屏先出骨架,数据到了 signals 自己会把列表补上。
  // 「浏览器侧首屏 ≤1s」口径也是渲染,不是数据齐备
  void loadState();
  // 订阅不等首份状态回来:两者互不依赖,而串起来只会让第一次变更晚一个来回。
  // 这里不留取消订阅的句柄 —— 整页只挂载一次,页面关掉即结束(空闲退出
  // 正是以这条连接断开为判据)
  connectEvents();
  // 标题跟着 `repoState` 走。同样不留取消订阅的句柄,理由同上;
  // 放在 `loadState()` 之后也无所谓 —— effect 首次订阅时立刻跑一次,而那一刻
  // `repoState` 还是 null,标题就停在 index.html 里那个兜底值上
  syncDocumentTitle();
}
