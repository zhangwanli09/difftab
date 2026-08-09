// 前端入口(spec §5.4)。挂载 + 拉第一份状态,别的都不做。
//
// TODO(S3b1):`EventSource` 订阅 /api/events,收到 change 就再 loadState() 一次。

import { render } from 'preact';

import { App } from './components/App';
import { loadState } from './state/store';
import './styles/app.css';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
  // 挂载之后再发请求:首屏先出骨架,数据到了 signals 自己会把列表补上。
  // §6 的「浏览器侧首屏 ≤1s」口径也是渲染,不是数据齐备
  void loadState();
}
