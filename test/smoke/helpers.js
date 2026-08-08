// 冒烟测试的公共工具。纯 JS、只用标准库 —— matrix 档完全不装依赖(spec §5.11)。
//
// 文件名不以 `.test.js` 结尾:`node --test "test/smoke/*.test.js"` 不会把它当用例,
// CI 里那条「数一遍冒烟文件」的检查也不会把它算进去。

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const BIN = resolve(REPO_ROOT, 'bin', 'gitglance.js');

/**
 * 拉起 CLI 并等到它打印出 URL。
 *
 * ready 的判据与 scripts/bench-startup.mjs 一致:**stdout 的第一行是且只是 URL**。
 */
export function startGitglance({ cwd, env = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BIN], {
      cwd,
      env: {
        ...process.env,
        // 拉起浏览器在测试里必须可关,否则每跑一次就弹一次(spec §5.10)
        GITGLANCE_NO_OPEN: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error(`启动超时。\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /^(http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))$/m.exec(stdout);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        child,
        url: match[1],
        port: Number(match[2]),
        token: decodeURIComponent(match[3]),
        get stdout() {
          return stdout;
        },
        get stderr() {
          return stderr;
        },
        stop: () =>
          new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once('close', () => done());
            child.kill();
          }),
      });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(`进程以 ${code} 退出而未打印 URL。\nstdout: ${stdout}\nstderr: ${stderr}`),
      );
    });
    child.on('error', rejectPromise);
  });
}

/**
 * 直接用 node:http 发请求,不用 fetch —— 三道校验里有两道是**请求头**,
 * 而 undici 把 `Host` 之类列为禁止改写的头,拿它测不了要测的东西。
 */
export function httpGet(port, path, headers = {}, method = 'GET') {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

/**
 * 从 GIT_TRACE 日志里抽出每一次被执行的 git 命令(spec §5.10 的主门禁用)。
 *
 * 放在这里而不是测试文件里,是因为测试文件不该有 export(biome 的
 * `noExportsInTest`)—— 那条规则挡的是「测试文件顺手变成工具模块」。
 */
export function parseTrace(log) {
  const commands = [];
  for (const line of log.split('\n')) {
    // `trace: built-in: git status --porcelain=v2 ...`(内建子命令)
    // `trace: exec: git-foo ...` / `trace: run_command: ...`(外部命令与内部再起的进程)
    const m = /\btrace: (built-in|exec|run_command|alias expansion): (.+)$/.exec(line);
    if (!m) continue;
    let tokens = m[2].trim().split(/\s+/);
    // 去掉开头的 `git` / `git-foo` 前缀,留下子命令与参数
    if (tokens[0] === 'git') tokens = tokens.slice(1);
    else if (tokens[0]?.startsWith('git-')) tokens = [tokens[0].slice(4), ...tokens.slice(1)];
    if (tokens.length > 0) commands.push({ kind: m[1], subcommand: tokens[0], argv: tokens });
  }
  return commands;
}

/**
 * 带上会话 cookie 的请求。
 *
 * cookie 名的字面量只在这里出现一次。冒烟测试跑的是 `dist/` 产物、不能 import TS
 * 源码,所以这份重复是无法避免的边界;但它在整个 `test/smoke/` 里只该有一处 ——
 * 各用例自己拼 cookie 头的话,格式一改就要满文件找。
 */
export function authedGet(port, token, path, headers = {}, method = 'GET') {
  return httpGet(port, path, { Cookie: `gitglance_token_${port}=${token}`, ...headers }, method);
}
