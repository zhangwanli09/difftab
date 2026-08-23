// 前端入口(spec §5.4)。挂载 + 拉第一份状态 + 订阅变更 + 把标题接上,别的都不做。

import { render } from 'preact';

import { App } from './components/App';
import { connectEvents } from './state/events';
import { loadState } from './state/store';
import { syncDocumentTitle } from './state/title';
import './styles/app.css';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
  // 挂载之后再发请求:首屏先出骨架,数据到了 signals 自己会把列表补上。
  // §6 的「浏览器侧首屏 ≤1s」口径也是渲染,不是数据齐备
  void loadState();
  // 订阅不等首份状态回来:两者互不依赖,而串起来只会让第一次变更晚一个来回。
  // 这里不留取消订阅的句柄 —— 整页只挂载一次,页面关掉即结束(§5.8 的空闲退出
  // 正是以这条连接断开为判据)
  connectEvents();
  // 标题跟着 `repoState` 走(§5.4)。同样不留取消订阅的句柄,理由同上;
  // 放在 `loadState()` 之后也无所谓 —— effect 首次订阅时立刻跑一次,而那一刻
  // `repoState` 还是 null,标题就停在 index.html 里那个兜底值上
  syncDocumentTitle();
}
