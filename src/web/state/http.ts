// 取 JSON 端点的那一份公共实现。
//
// **独立成文件不是为了整洁，是为了不出现第二份**：下面那条「错误正文先当文本读」的规矩一旦
// 被拷成两份，其中一份被「顺手简化」成 `res.json()` 时，只有那个端点会退回显示
// 「Unexpected token 'E'…」，而它照样是绿的。四个端点（state / diff / tree / file）共用这一份。

import type { ErrorPayload } from '../../server/shared/protocol';

/** 从任意失败里取一句可展示的话。永远返回非空字符串，免得 UI 出现空白的错误条。 */
export function toMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'Unknown error';
}

/**
 * 失败响应的正文 → 一句话。**不能直接 `res.json()`**：错误正文未必是 JSON。`pnpm dev` 下后
 * 端没起来时，Vite 代理回的是纯文本 500,`json()` 会先抛 SyntaxError，于是错误条上显示的是
 * 「Unexpected token 'E'…」而不是「后端连不上」——真正的原因被解析错误盖掉了。
 */
function messageFrom(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as Partial<ErrorPayload>;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 不是 JSON——这条路径本身就是上面说的那种情况
  }
  return `Request failed (HTTP ${status}).`;
}

/**
 * 取一个 JSON 端点，失败即抛一句可展示的话。
 *
 * 成功那一路仍走 `res.json()`：「未必是 JSON」只对错误正文成立，而 diff 与文件正文可以到
 * 5MB，先 `text()` 再 `JSON.parse()` 等于把它在内存里存两份。竞态判据**不在这里**。
 */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(messageFrom(await res.text(), res.status));
  return (await res.json()) as T;
}

/**
 * 「后发的说了算」这条竞态判据的**唯一**实现。
 *
 * 四个加载器都要它：两次请求重叠时先发的可能后到，旧快照会盖掉新快照——列表停在过期状态、
 * 右侧在 A 的标题下画着 B 的内容、树上那一层一直停在旧目录。**这类回归不报错**，所以判据各写
 * 一遍的代价不是重复，而是「其中一份漏了 `catch` 那一半」这种没有任何东西会红的漂移。
 *
 * `key` 让同一份计数器服务多个独立资源（目录树按目录各算各的）；不传就是单一资源。
 */
export interface Tickets {
  /** 领一张票，并记成这个 key 上最新的一张。 */
  claim(key?: string): number;
  /** 这张票还是不是最新的。不是就说明后面还有一次请求，手上这份结果已经过期。 */
  isCurrent(ticket: number, key?: string): boolean;
  /** 这个 key 上有没有在途的请求。只有需要「同一层不重复取」的调用方用得上。 */
  pending(key?: string): boolean;
  /** 收尾。**只摘自己那张票**：已经被后一次顶掉时，摘掉的会是别人的。 */
  release(ticket: number, key?: string): void;
}

export function latestWins(): Tickets {
  const latest = new Map<string, number>();
  let sequence = 0;
  return {
    claim(key = '') {
      sequence += 1;
      latest.set(key, sequence);
      return sequence;
    },
    isCurrent: (ticket, key = '') => latest.get(key) === ticket,
    pending: (key = '') => latest.has(key),
    release(ticket, key = '') {
      if (latest.get(key) === ticket) latest.delete(key);
    },
  };
}
