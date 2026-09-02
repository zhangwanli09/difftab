// 三道校验与安全响应头。纯函数，便于单测逐条钉住。
//
// **后端零 dev 分支**：本文件不得出现任何放宽这三道校验的环境变量或分支。Vite dev server
// 与后端不同源，会同时撞上 Host、Origin、token 三道门——解法一律放在 dev server 的代理层
// （改写 Host / Origin、注入 token cookie）。在这里开口子等于把正面防御做成可被误开的开关。

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 服务只绑这个地址。Host 白名单里的两个名字都指向它。 */
export const BIND_HOST = '127.0.0.1';

const ALLOWED_HOSTNAMES = ['127.0.0.1', 'localhost'];

/**
 * cookie 名带上端口。cookie 的作用域是 host 而非 origin，**不隔离端口**：同机另一个监听
 * `127.0.0.1:<其他端口>` 的服务同样会收到我们的 cookie，反过来它设的同名 cookie 也会盖掉
 * 我们的。名字里带端口，两个 difftab 实例（不同仓库、不同端口）才能在同一个浏览器里共存。
 */
export function cookieName(port: number): string {
  return `difftab_token_${port}`;
}

/** 会话 token 的秘密部分。进程生命周期内持续有效，以支持页面刷新与多标签。 */
export function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * token 形如 `<port>.<secret>`。端口写进 token 本身，是为了让服务端校验时**一并绑定本次
 * 会话的端口**——cookie 会泄漏给本机其他 localhost 服务，带上端口后它在别处无法复用。
 */
export function composeToken(port: number, secret: string): string {
  return `${port}.${secret}`;
}

/**
 * 打印给用户、也拿去拉起浏览器的那个 URL。**只此一处**：探活复用命中时，是**另一个进程**
 * 按注册表里的 port + token 重新拼出同一个 URL。两处各拼一遍的话，哪天 token 的落地方式变
 * 了（换 query 名、换编码），复用那条路会拼出一个 403 的链接——而它平时不走。
 */
export function sessionUrl(port: number, token: string): string {
  return `http://${BIND_HOST}:${port}/?token=${encodeURIComponent(token)}`;
}

/**
 * 第 1 道：**校验 `Host` 头**。这才是 DNS rebinding 的正面防御——token 挡不住
 * 同源判定本身，rebinding 的攻击页面把自己的域名重绑到 127.0.0.1 后，浏览器
 * 认为它与本服务同源，而它发出的请求 `Host` 是攻击者的域名。
 */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return ALLOWED_HOSTNAMES.some((name) => host === `${name}:${port}`);
}

/**
 * 第 2 道：**校验 `Origin`**。非空且不等于自身则拒；空是正常的（同源的导航与 GET fetch 本
 * 就不带 Origin）。`null`（沙箱化 iframe、跨源重定向）是非空值，按不匹配处理——那正是要挡
 * 的东西。
 */
export function isOriginAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  return ALLOWED_HOSTNAMES.some((name) => origin === `http://${name}:${port}`);
}

/** 从 `Cookie` 头里取出本会话的 token。 */
export function readCookieToken(header: string | undefined, port: number): string | null {
  if (!header) return null;
  const wanted = cookieName(port);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === wanted) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 定长比较。长度不同直接判否——长度本身不是秘密。 */
export function tokensMatch(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 第 3 道之外的公共响应头。CSP 的后三个指令**不回退到 `default-src`**，不显式写就等于没设：
 * `'none'` 一并挡掉被 iframe 嵌套、`<base>` 改写相对 URL 与表单外发。不开 `'unsafe-inline'`
 * 是构建链路顺带解锁的——产物是独立的 .js / .css、页面无内联脚本，才有条件不开。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

/**
 * 把 token 落成 cookie 的 Set-Cookie 值。`HttpOnly; SameSite=Strict` + 随后 302 掉 query，
 * 避免 token 长期滞留在浏览器历史、地址栏和日志中。不设 `Secure`——那会让
 * http://127.0.0.1 上的 cookie 直接不生效。
 */
export function tokenCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}
