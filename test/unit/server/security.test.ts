// 三道校验的单测。每条断言对应 spec 里一句「必须」。

import { describe, expect, test } from 'vitest';
import {
  composeToken,
  cookieName,
  createSecret,
  isHostAllowed,
  isOriginAllowed,
  readCookieToken,
  SECURITY_HEADERS,
  tokenCookie,
  tokensMatch,
} from '../../../src/server/http/security.ts';

const PORT = 51234;

describe('第 1 道:Host', () => {
  test('只认 127.0.0.1 / localhost 加本次会话的端口', () => {
    expect(isHostAllowed(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isHostAllowed(`localhost:${PORT}`, PORT)).toBe(true);
  });

  test('rebinding 的攻击页面发出的 Host 是它自己的域名 —— 拒', () => {
    expect(isHostAllowed(`evil.example:${PORT}`, PORT)).toBe(false);
    // 端口不对同样拒:Host 头不带端口时,浏览器指的是 80
    expect(isHostAllowed('127.0.0.1', PORT)).toBe(false);
    expect(isHostAllowed(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isHostAllowed(undefined, PORT)).toBe(false);
    // 子串不算:`127.0.0.1:5123` 是 `127.0.0.1:51234` 的前缀
    expect(isHostAllowed(`127.0.0.1:${PORT}.evil.example`, PORT)).toBe(false);
  });
});

describe('第 2 道:Origin', () => {
  test('空 Origin 放行 —— 同源导航与同源 GET fetch 本来就不带它', () => {
    expect(isOriginAllowed(undefined, PORT)).toBe(true);
    expect(isOriginAllowed('', PORT)).toBe(true);
  });

  test('非空且不等于自身则拒,`null` 也算非空', () => {
    expect(isOriginAllowed(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isOriginAllowed(`http://localhost:${PORT}`, PORT)).toBe(true);
    expect(isOriginAllowed('null', PORT)).toBe(false);
    expect(isOriginAllowed('http://evil.example', PORT)).toBe(false);
    expect(isOriginAllowed(`https://127.0.0.1:${PORT}`, PORT)).toBe(false);
  });
});

describe('第 3 道:token', () => {
  test('token 里绑着端口 —— 泄漏给本机其他 localhost 服务后无法在别处复用', () => {
    const token = composeToken(PORT, createSecret());
    expect(token.startsWith(`${PORT}.`)).toBe(true);
  });

  test('两次生成的 secret 不同', () => {
    expect(createSecret()).not.toBe(createSecret());
  });

  test('cookie 名带端口 —— cookie 的作用域是 host,不隔离端口', () => {
    expect(cookieName(PORT)).not.toBe(cookieName(PORT + 1));
  });

  test('从 Cookie 头里挑出本会话那一条,不被同名前缀或别的服务干扰', () => {
    const header = `other=1; ${cookieName(PORT + 1)}=wrong; ${cookieName(PORT)}=right; x=2`;
    expect(readCookieToken(header, PORT)).toBe('right');
    expect(readCookieToken(undefined, PORT)).toBe(null);
    expect(readCookieToken('nope', PORT)).toBe(null);
  });

  test('比较是定长的,长度不同直接判否', () => {
    const token = composeToken(PORT, createSecret());
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(`${token}x`, token)).toBe(false);
    expect(tokensMatch('', token)).toBe(false);
    expect(tokensMatch(null, token)).toBe(false);
  });

  test('cookie 是 HttpOnly + SameSite=Strict,且不带 Secure', () => {
    const value = tokenCookie(PORT, composeToken(PORT, 'secret'));
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Strict');
    // 加了 Secure,http://127.0.0.1 上的 cookie 会直接不生效
    expect(value).not.toContain('Secure');
  });
});

test('CSP 的三个不回退指令都显式写了', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
  // frame-ancestors / base-uri / form-action 均**不回退到 default-src**,不显式写就等于没设
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("default-src 'none'");
  // 产物是独立的 .js / .css、页面无内联脚本,才有条件不开 unsafe-inline
  expect(csp).not.toContain('unsafe-inline');
  expect(SECURITY_HEADERS['Cache-Control']).toBe('no-store');
  expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
});
