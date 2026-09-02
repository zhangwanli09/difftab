// SSE 通道(`GET /api/events`)。
//
// 单独一个文件、且只依赖 `write` / `end` 两个方法，是为了让心跳能被**单测**钉住：心跳周期
// 15s，接在 ServerResponse 上就只能靠一个跑 15 秒的用例去验，而那种用例没人会跑第二次。
//
// 心跳本身不是给用户看的，是给中间层看的：浏览器、系统休眠、Vite 代理都可能在长时间静默后
// 回收一条看起来死掉的连接，而这条连接同时是空闲退出的判据——它被悄悄回收，进程就会在用户
// 还开着页面时以为没人了。**周期定在 `shared/protocol.ts`**：前端要按同一个数判连接死活。

import { HEARTBEAT_MS } from '../shared/protocol.ts';

/**
 * 通道只要求这么多——`ServerResponse` 满足它。不直接写 `ServerResponse` 类型是刻意的：
 * 通道不该有能力去改状态码、改头、或者把一条连接当成普通响应结束掉，那些都归调用方。
 */
export interface SseClient {
  write(chunk: string): unknown;
  end(): unknown;
}

/**
 * 一条 SSE 消息的线格式。`data` 一律是一行 JSON：多行正文要逐行加 `data: ` 前缀，而正文里
 * 一旦出现换行就会静默变成半条消息，`JSON.stringify` 保证不含裸换行。
 */
export function formatEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseChannel {
  add(client: SseClient): void;
  remove(client: SseClient): void;
  /** 当前连接数。空闲退出以它为判据。 */
  readonly size: number;
  send(name: string, data: unknown): void;
  close(): void;
}

export interface SseChannelOptions {
  heartbeatMs?: number;
  /**
   * 连接数可能变了就叫一声（`add` / `remove` 之后各一次）。**空闲计时挂在这里，而不是挂在
   * 端点上**：`size` 是空闲退出唯一的正面判据，而能改变它的只有这两个方法。让端点自己记得
   * 在断连那一侧重新武装计时器，等于把「关掉最后一个标签之后进程要退」寄存在人的记忆里——
   * 漏掉不报错，只是进程从此不退。
   */
  onChange?: () => void;
}

export function createSseChannel({
  heartbeatMs = HEARTBEAT_MS,
  onChange,
}: SseChannelOptions = {}): SseChannel {
  const clients = new Set<SseClient>();

  const send = (name: string, data: unknown) => {
    const chunk = formatEvent(name, data);
    for (const client of clients) {
      try {
        client.write(chunk);
      } catch {
        /**
         * **真正把死连接摘出去的不是这里**，是端点上的 `'close'` / `'error'` 监听器——
         * `ServerResponse.write()` 对已结束或已销毁的响应不会同步抛，失败是异步的。这层
         * catch 只保证一个客户端写炸了不会让这一轮广播半路夭折。
         */
        clients.delete(client);
      }
    }
  };

  const heartbeat = setInterval(() => send('heartbeat', {}), heartbeatMs);
  // 心跳绝不该是进程活着的理由：没有连接时它每 15s 空转一次，而空闲退出
  // 靠的是连接数，不是有没有定时器
  heartbeat.unref();

  return {
    add(client) {
      clients.add(client);
      onChange?.();
    },
    remove(client) {
      clients.delete(client);
      onChange?.();
    },
    get size() {
      return clients.size;
    },
    send,
    close() {
      clearInterval(heartbeat);
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // 同上
        }
      }
      clients.clear();
    },
  };
}
