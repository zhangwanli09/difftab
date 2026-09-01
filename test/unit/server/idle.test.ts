// 空闲退出的计时器。
//
// 这里钉的两类错都不报错:**退早了**(用户开着页面,进程自己没了)与**退不掉**
// (关完标签留一个后台常驻进程)。45 秒的用例没人会跑第二次,所以用假时钟。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createIdleWatchdog,
  IDLE_ENV,
  IDLE_EXIT_MS,
  IdleConfigError,
  resolveIdleMs,
} from '../../../src/server/http/idle.ts';

describe('resolveIdleMs', () => {
  test('默认是 45 秒', () => {
    expect(resolveIdleMs({})).toBe(IDLE_EXIT_MS);
    expect(IDLE_EXIT_MS).toBe(45_000);
  });

  test('内部环境变量能覆盖', () => {
    expect(resolveIdleMs({ [IDLE_ENV]: '800' })).toBe(800);
  });

  test('取值不合法即抛,不退回默认的 45s', () => {
    // 退回默认的话,手滑写错的那次照样启动成功、照样跑出一个看着合理的行为,于是「我验过空闲退出
    // 了」建立在一次根本没生效的强制指定上 —— 而症状是那条用例等满 45 秒后超时,读起来像产品坏了
    for (const raw of ['abc', '0', '-5', 'NaN', '1e999x']) {
      expect(() => resolveIdleMs({ [IDLE_ENV]: raw }), raw).toThrow(IdleConfigError);
    }
  });
});

describe('createIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 默认「没有客户端」,用例自己改 `clients`。 */
  function setup(idleMs = 1000) {
    const state = { clients: 0, idled: 0 };
    const watchdog = createIdleWatchdog({
      idleMs,
      hasClients: () => state.clients > 0,
      onIdle: () => {
        state.idled += 1;
      },
    });
    return { state, watchdog };
  }

  test('没有客户端时,宽限期走满就喊一声', () => {
    const { state, watchdog } = setup();
    watchdog.touch();

    vi.advanceTimersByTime(999);
    expect(state.idled).toBe(0); // 还差 1ms —— 不许提前
    vi.advanceTimersByTime(1);
    expect(state.idled).toBe(1);
  });

  test('有客户端时压根不计时', () => {
    const { state, watchdog } = setup();
    state.clients = 1;
    watchdog.touch();

    vi.advanceTimersByTime(10_000);
    expect(state.idled).toBe(0);
  });

  test('多标签:关掉其中一个不退出,全部关掉才开始计时', () => {
    const { state, watchdog } = setup();
    state.clients = 2;
    watchdog.touch();

    state.clients = 1; // 关掉一个标签
    watchdog.touch();
    vi.advanceTimersByTime(10_000);
    expect(state.idled).toBe(0);

    state.clients = 0; // 关掉最后一个
    watchdog.touch();
    vi.advanceTimersByTime(1000);
    expect(state.idled).toBe(1);
  });

  test('每次 touch 都重新起一个完整的宽限期', () => {
    const { state, watchdog } = setup();
    watchdog.touch();
    vi.advanceTimersByTime(900);
    watchdog.touch(); // 来了个请求 —— 页面活着,只是 SSE 那条被中间层回收了
    vi.advanceTimersByTime(900);
    expect(state.idled).toBe(0);

    vi.advanceTimersByTime(100);
    expect(state.idled).toBe(1);
  });

  test('到点那一刻已经有客户端了就不退 —— 排队与执行之间隔着一整圈事件循环', () => {
    // 回归点:只在起计时那一刻问一次 hasClients() 的写法,会在「宽限期最后一拍
    // 接进一个 SSE 连接」时把用户正开着的页面连进程一起带走。而这一步只值一行 if
    const { state, watchdog } = setup();
    watchdog.touch();
    state.clients = 1; // 连上了,但没人 touch(比如通道的 onChange 那条线断了)
    vi.advanceTimersByTime(5000);
    expect(state.idled).toBe(0);
  });

  test('stop() 之后既不触发已排的,也不再起新的', () => {
    const { state, watchdog } = setup();
    watchdog.touch();
    watchdog.stop();

    watchdog.touch();
    vi.advanceTimersByTime(10_000);
    expect(state.idled).toBe(0);
  });

  test('只喊一声就完了 —— 之后不再自己续期', () => {
    // 调用方拿到这一声就去 close + exit 了;这里还留着循环定时器的话,关服务路上会再喊一次
    const { state, watchdog } = setup();
    watchdog.touch();
    vi.advanceTimersByTime(10_000);
    expect(state.idled).toBe(1);
  });
});
