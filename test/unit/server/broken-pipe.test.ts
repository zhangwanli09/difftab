// 读端先走了(`difftab --no-open | head -1`)时 stdout / stderr 上的 `'error'` 咽哪些码。
//
// 冒烟里 `| head -1` 那条只造得出 EPIPE：macOS 上的另外两种拼法是 unix socket 的竞态，
// 只在 CI 上偶发。所以哪几个码算「对端已经不在了」只能在这里钉住——否则码被拼错或删掉时
// 全套门禁照常全绿，症状只是某一天 macOS 档又红一次。

import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { ignoreBrokenPipe } from '../../../src/server/main.ts';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });
}

function guarded(): PassThrough {
  const stream = new PassThrough();
  ignoreBrokenPipe(stream);
  return stream;
}

test.each(['EPIPE', 'ECONNRESET', 'ENOTCONN'])('%s 是读端走了，咽掉不崩', (code) => {
  expect(() => guarded().emit('error', errnoError(code))).not.toThrow();
});

// 没有 code 的那条也要在：`cause.code ?? ''` 那一步写错时它会被当成白名单里的码咽掉
test.each([errnoError('EACCES'), new Error('boom')])(
  '别的错误照旧抛——那是真出事了，不该借这条路一起被吞掉：%s',
  (cause) => {
    expect(() => guarded().emit('error', cause)).toThrow(cause);
  },
);
