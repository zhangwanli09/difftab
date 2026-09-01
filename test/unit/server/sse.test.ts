// SSE 通道(src/server/http/sse.ts)的单测。
//
// 心跳周期是 15s —— 用真时钟验它的用例没人会跑第二次,所以这里用假时钟推。
// 通道单独成文件、只依赖 `write` / `end` 两个方法,正是为了让这件事做得到。

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSseChannel, formatEvent } from '../../../src/server/http/sse.ts';
import { HEARTBEAT_MS } from '../../../src/server/shared/protocol.ts';

/** 记下写进来的每一块。`ServerResponse` 在通道眼里就是这么两个方法。 */
function fakeClient() {
  const chunks: string[] = [];
  return {
    chunks,
    ended: false,
    write(chunk: string) {
      chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
    /** 收到的事件名,按顺序。 */
    get events() {
      return chunks.map((c) => /^event: (\w+)$/m.exec(c)?.[1]);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatEvent', () => {
  test('事件名 + 一行 JSON + 空行收尾', () => {
    expect(formatEvent('change', {})).toBe('event: change\ndata: {}\n\n');
  });

  test('正文里的换行不会把一条消息劈成两条', () => {
    // SSE 的多行正文要逐行加 `data: ` 前缀。正文里一旦出现裸换行(将来带上文件名
    // 之类),后半截就成了一条没有 `data:` 前缀的野消息 —— 前端只会静默少收东西
    const chunk = formatEvent('change', { path: 'a\nb' });
    expect(chunk.split('\n').filter((line: string) => line !== '')).toHaveLength(2);
    expect(chunk.endsWith('\n\n')).toBe(true);
  });
});

describe('createSseChannel', () => {
  test('send 广播给所有连接,size 跟着增减', () => {
    const channel = createSseChannel();
    const a = fakeClient();
    const b = fakeClient();
    channel.add(a);
    channel.add(b);
    expect(channel.size).toBe(2);

    channel.send('change', {});
    expect(a.chunks).toEqual(['event: change\ndata: {}\n\n']);
    expect(b.chunks).toEqual(['event: change\ndata: {}\n\n']);

    channel.remove(a);
    channel.send('change', {});
    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(2);
    expect(channel.size).toBe(1);
    channel.close();
  });

  test('心跳每 15s 一发', async () => {
    // 心跳是给中间层看的:浏览器、系统休眠、dev 下的 Vite 代理都可能把一条长时间
    // 静默的连接当死的回收,而这条连接同时是空闲退出的判据
    vi.useFakeTimers();
    const channel = createSseChannel();
    const client = fakeClient();
    channel.add(client);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(client.chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.events).toEqual(['heartbeat']);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(client.events).toEqual(['heartbeat', 'heartbeat', 'heartbeat']);

    channel.close();
  });

  test('close() 收尾之后心跳也停了', async () => {
    vi.useFakeTimers();
    const channel = createSseChannel();
    const client = fakeClient();
    channel.add(client);

    channel.close();
    expect(client.ended).toBe(true);
    expect(channel.size).toBe(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(client.chunks).toHaveLength(0);
  });

  test('一条连接写失败不影响其余连接', () => {
    // 对端已经走了而 'close' 还没派发到的那个窗口。整条广播被一个异常打断的话,排在后面的标签页
    // 就静默收不到这次变更
    const channel = createSseChannel();
    const dead = {
      write() {
        throw new Error('write after end');
      },
      end() {},
    };
    const alive = fakeClient();
    channel.add(dead);
    channel.add(alive);

    channel.send('change', {});
    expect(alive.events).toEqual(['change']);
    // 写失败的那条被摘掉了,不会每次广播都再抛一次
    expect(channel.size).toBe(1);
    channel.close();
  });
});
