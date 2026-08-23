// SSE 订阅(src/web/state/events.ts)的单测(spec §5.8)。
//
// 用替身而不是 happy-dom 自带的 EventSource:要断言的东西全在**连接的开关时机**上
// (什么时候新建、什么时候不新建),而真 EventSource 要真起一条 HTTP 连接才有
// readyState 可看。替身还让「永久关闭」这个状态可以被直接摆出来 —— 它在真实浏览器里
// 只在服务端回了非 2xx 或错 Content-Type 时才出现。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RepoState } from '../../../src/server/shared/protocol';
import { connectEvents, MAX_RETRIES, RECONNECT_MS, STALE_MS } from '../../../src/web/state/events';
import { diffState, loadError, repoState } from '../../../src/web/state/store';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** 建过的每一条连接都记在这里,顺序即建立顺序。 */
const sources: FakeEventSource[] = [];

class FakeEventSource {
  readyState = OPEN;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  readonly url: string;

  // 参数属性(`constructor(readonly url)`)在 erasableSyntaxOnly 下不可用 ——
  // 那是本项目「TS 只做类型擦除」这条(§5.11)的直接后果,不是风格选择
  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }

  addEventListener(name: string, fn: (event: Event) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }

  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }

  emit(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn(new Event(name));
  }

  /** 服务端回了非 2xx / 错的 Content-Type:浏览器就此**永久**放弃这条连接。 */
  die() {
    this.readyState = CLOSED;
    this.emit('error');
  }
}

const state: RepoState = {
  repoName: 'demo',
  branch: { head: 'main', detached: false, upstream: null },
  files: [],
  watch: { mode: 'native', tier: 'A' },
};

/** 记下每个被请求的 URL。refresh() 会打 /api/state。 */
function stubFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(state), { status: 200 });
    }),
  );
  return calls;
}

const latest = () => sources[sources.length - 1] as FakeEventSource;

/**
 * 订阅并登记好取消函数。
 *
 * **不能靠用例末尾那句 `dispose()`**:一条断言挂掉,后面的取消就不会执行,于是
 * 那条 `visibilitychange` 监听器活到了下一个用例里 —— 下一个用例随之以「多了一次
 * 重取」失败,而它自己一点毛病没有。第一次写这份文件时就是这么连倒了三条。
 */
const disposers: (() => void)[] = [];
function connect(): () => void {
  const dispose = connectEvents();
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers.length = 0;
  vi.useRealTimers();
});

beforeEach(() => {
  sources.length = 0;
  repoState.value = null;
  diffState.value = null;
  loadError.value = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('connectEvents', () => {
  test('挂载即连上 /api/events,且不带任何 token', async () => {
    // token 在生产下是 HttpOnly cookie、dev 下由代理注入,前端完全不接触它 ——
    // 它一旦落到 JS 能读的地方,HttpOnly 就白设了(§5.9)
    stubFetch();
    connect();

    expect(sources).toHaveLength(1);
    expect(latest().url).toBe('/api/events');
  });

  test('收到 change 就重取一次状态', async () => {
    const calls = stubFetch();
    connect();

    latest().emit('change');
    // 等的是**状态真的换上了**,而不是请求发出去了 —— 后者在正文解析之前就成立,
    // 于是这条断言会以「repoState 还是 null」失败,而产品一点毛病没有
    await vi.waitFor(() => expect(repoState.value).toEqual(state));
    expect(calls).toEqual(['/api/state']);
  });

  test('连接一直活着时,切回标签页既不重连也不补取', async () => {
    // 重连:每次都是一条新的 HTTP 连接,而 §5.8 的空闲退出以连接数为判据 ——
    // 白白开关一轮等于让后端在「有人」和「没人」之间抖一下。
    // 补取:连接活着就说明期间每个 change 都推到过了,而它取的可能是一份数 MB 的
    // diff —— 切标签又正是这个工具最频繁的动作
    const calls = stubFetch();
    connect();

    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    expect(sources).toHaveLength(1);
  });

  test('连接已经死了时,切回标签页会重连', async () => {
    // 系统休眠唤醒、Chrome 丢弃后台标签之后,这条连接可能已经死了而 error 事件
    // 永远不会来。页面于是停在休眠前的那一屏,看上去只是「没有变更」
    stubFetch();
    connect();
    const first = latest();
    first.readyState = CLOSED;

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sources).toHaveLength(2);
    // 新连接照样收得到事件 —— 监听器要挂在新的那条上,不是还挂在死掉的那条
    const calls = stubFetch();
    latest().emit('change');
    await vi.waitFor(() => expect(calls).toEqual(['/api/state']));
  });

  test('连接看着还开着、但两拍心跳都没来 —— 切回标签页照样换一条', async () => {
    // 休眠唤醒、网络切换之后留下的半开 TCP:readyState 一直是 OPEN,error 永远不来。
    // 只按 readyState 判的话这条连接会一直挂着,页面从此收不到任何变更而毫无异样
    vi.useFakeTimers();
    const calls = stubFetch();
    connect();
    const first = latest();

    await vi.advanceTimersByTimeAsync(STALE_MS + 1000);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(first.readyState).toBe(CLOSED); // 是我们亲手掐掉的
    expect(sources).toHaveLength(2);
    // 断过的这段里发生的变更没人推给我们,补取那一下**只在这条分支上**不能省
    await vi.waitFor(() => expect(calls).toEqual(['/api/state']));
  });

  test('心跳来过就不算死 —— 一直静默才算', async () => {
    // 反过来的那一半:没有它,上一条用「切回标签页永远重连」也能通过
    vi.useFakeTimers();
    stubFetch();
    connect();

    await vi.advanceTimersByTimeAsync(STALE_MS - 1000);
    latest().emit('heartbeat');
    await vi.advanceTimersByTimeAsync(STALE_MS - 1000);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sources).toHaveLength(1);
  });

  test('自己重连有上限,切回标签页重新武装', async () => {
    // 端口是内核随机分配的,换端口重启的后端旧标签页永远敲不到 —— 不封顶就是
    // 一个早该关掉的标签页每 3 秒敲一次,敲到浏览器关掉为止
    vi.useFakeTimers();
    stubFetch();
    connect();

    for (let i = 0; i <= MAX_RETRIES; i += 1) {
      latest().die();
      await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    }
    expect(sources).toHaveLength(1 + MAX_RETRIES);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sources).toHaveLength(2 + MAX_RETRIES);
  });

  test('标签页被隐藏时什么都不做', async () => {
    const calls = stubFetch();
    connect();
    // 直接改属性描述符,不用 spyOn:hidden 是原型上的 getter,而这条断言的成败
    // 不该取决于替身库能不能翻到原型链上去
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    expect(sources).toHaveLength(1);

    Reflect.deleteProperty(document, 'hidden');
  });

  test('连接被永久关闭后自己重连 —— 浏览器这时候不会再管', async () => {
    // readyState 回到 CONNECTING 的那种断开由浏览器自己重试;CLOSED 是「服务端回了
    // 非 2xx」,浏览器就此放弃。不自己兜住的话页面从此一动不动,而且看上去完全正常
    vi.useFakeTimers();
    stubFetch();
    connect();

    latest().die();
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    expect(sources).toHaveLength(2);
    expect(latest().readyState).toBe(OPEN);
  });

  test('只是在重连中(CONNECTING)时不插手', async () => {
    // 浏览器已经在自己重试了,我们再开一条就是两条连接
    vi.useFakeTimers();
    stubFetch();
    connect();

    latest().readyState = CONNECTING;
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 2);
    expect(sources).toHaveLength(1);
  });

  test('取消订阅之后既不重连也不再收事件', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const dispose = connect();
    const first = latest();

    dispose();
    expect(first.closed).toBe(true);

    first.die();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 2);
    expect(sources).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});
