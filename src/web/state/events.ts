// SSE 订阅(`GET /api/events`)。
//
// 前端这一侧只做两件事:收到 `change` 就重取一次状态,以及**在标签重新激活时判断这条连接
// 还活着没有**。档位与降级判定全在后端 —— 心跳是唯一的例外,它在这里被当成「对端还在」的
// 证据用(见 `STALE_MS`),而那是给它定的用途本身。

import { HEARTBEAT_MS } from '../../server/shared/protocol';
import { refresh } from './store';

/** `EventSource.CLOSED`。写字面量是因为测试里的替身不必复刻这几个静态常量。 */
const CLOSED = 2;

/**
 * 浏览器自己重连不了时,我们隔多久再试一次。`EventSource` 对**传输层**的断开会自己重连,不
 * 需要我们插手;只有当服务端回了非 2xx 或错的 Content-Type 时它才会**永久**关闭 —— 后端抖
 * 一下回了条 5xx、dev 代理在后端重启途中回了条 500,都是这个形态。不自己兜住的话,页面从此
 * 一动不动,而且看上去完全正常。
 */
export const RECONNECT_MS = 3000;

/**
 * 自己重连的次数上限。「永久关闭」里能自愈的只有一种:后端或 dev 代理抖了一下。**换个端口
 * 重启的后端是治不好的** —— 端口由内核随机分配,旧标签页永远敲不到新实例;不封顶的话,一个
 * 早就该关掉的标签页会每 3 秒敲一次。封顶之后仍有一条复活路径:切回标签页时重新武装。
 */
export const MAX_RETRIES = 5;

/**
 * 静默多久就当这条连接已经死了(两拍心跳 + 5s 余量)。**这是心跳在前端的用途**:
 * `readyState` 还是 `OPEN` 完全不代表连接还活着 —— 系统休眠、网络切换之后留下的半开 TCP
 * 只有写一次才发现得了,而 `EventSource` 这一侧只读不写,于是 `error` 永远不来。
 *
 * **由后端那个周期算出来,不抄数字**:两边各写一个 15000,改周期时只改一边不报错、也没有
 * 用例会红,前端的死连接判定就此静默失准。
 */
export const STALE_MS = HEARTBEAT_MS * 2 + 5_000;

/**
 * 订阅后端事件。返回一个取消订阅的函数(给测试与将来可能的重挂用)。不带 token:它在生产下
 * 是 HttpOnly cookie、dev 下由代理注入,两条路径浏览器都会自动带上。
 */
export function connectEvents(): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let lastSeen = 0;
  let disposed = false;

  /** 返回值是「这次真的建了一条新连接吗」—— `onVisible` 据此决定要不要补取。 */
  const open = (): boolean => {
    if (disposed) return false;
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    // 已经连着(或正在连)就不动它:每次重连都是一条新的 HTTP 连接,而
    // 空闲退出以连接数为判据,反复开关等于让后端在「有人」和「没人」之间抖动
    if (source !== null && source.readyState !== CLOSED) return false;

    source?.close();
    const next = new EventSource('/api/events');
    source = next;
    lastSeen = Date.now();
    /**
     * 每条消息都是一次「对端还在」的证据,心跳也算。重试计数也在这里清:清在 `open()` 里的
     * 话上限永远不会到,因为每次重试都要经过 `open()`。
     */
    const seen = () => {
      lastSeen = Date.now();
      retries = 0;
    };
    next.addEventListener('open', seen);
    next.addEventListener('heartbeat', seen);
    next.addEventListener('change', () => {
      seen();
      void refresh();
    });
    next.addEventListener('error', () => {
      // 只有永久关闭才轮到我们:CONNECTING 说明浏览器已经在自己重试了
      if (next.readyState !== CLOSED || disposed || retry !== null) return;
      if (retries >= MAX_RETRIES) return;
      retries += 1;
      retry = setTimeout(open, RECONNECT_MS);
    });
    return true;
  };

  /**
   * 标签重新激活时主动重连并重取一次。系统休眠唤醒、Chrome 省内存丢弃后台标签之后,这条连接
   * 可能已经死了而 `error` 事件永远不会来,**而那种死法下 `readyState` 照样是 `OPEN`** ——
   * 所以不能只靠 `open()` 里那条「CLOSED 才重连」:先按静默时长判一次,已经不新鲜就亲手把它
   * 掐掉再重连。
   *
   * **补取只在真的重连了之后做**:连接从头到尾活着,就说明期间的每个 `change` 都已经推到过
   * 了,而心跳刚刚证明了这一点。这时再取一次纯属白取,它取的却可能是一份数 MB 的 diff ——
   * 而切标签正是这个工具最频繁的动作。
   */
  const onVisible = () => {
    if (document.hidden) return;
    if (source !== null && Date.now() - lastSeen > STALE_MS) {
      source.close();
      source = null;
    }
    // 上面那些重试已经放弃了的话,在这里重新武装:用户回来了,值得再试一轮
    retries = 0;
    if (open()) void refresh();
  };
  document.addEventListener('visibilitychange', onVisible);

  open();

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisible);
    if (retry !== null) clearTimeout(retry);
    source?.close();
    source = null;
  };
}
