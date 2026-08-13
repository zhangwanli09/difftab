// 冒烟测试的公共工具。纯 JS、只用标准库 —— matrix 档完全不装依赖(spec §5.11)。
//
// 文件名不以 `.test.js` 结尾:`node --test "test/smoke/*.test.js"` 不会把它当用例,
// CI 里那条「数一遍冒烟文件」的检查也不会把它算进去。

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const BIN = resolve(REPO_ROOT, 'bin', 'gitglance.js');

/**
 * 一次性的懒初始化,**替代 `node:test` 的顶层 `before()`**。
 *
 * Node 22.0.0 —— 也就是本项目运行时下限、matrix 专门有一档跑它 —— 的 test runner
 * **不等顶层异步 `before()` 完成就开跑该文件的用例**(已在本机 22.0.0 复现:依赖
 * 共享 server 的用例全部在 1ms 内以 `undefined` 失败,而自己起进程的用例照常通过;
 * 24 / 26 上正常)。`after()` 同样会提早触发,清理撞上还在写的文件报 ENOTEMPTY。
 *
 * 所以不用钩子:把准备工作包成一个记忆化的 Promise,每个用例开头 `await` 它。
 * 语义完全等价,却不依赖 runner 的钩子时序——在哪个 Node 上都对。
 */
export function once(factory) {
  let pending;
  return () => (pending ??= factory());
}

/**
 * 进程真正退出时清理临时目录。
 *
 * 同样是绕开 `after()`:`process.on('exit')` 由 Node 自己保证时机,且必须是同步
 * 操作 —— rmSync 正合适。
 *
 * **`maxRetries` 不是保险起见,是 Windows 上的必需品**(2026-08-09 实测,CI 的
 * windows × Node 22.0.x 档):Windows 不允许删除一个仍是某进程当前工作目录的
 * 文件夹,而被测进程正是以 fixture 仓库为 cwd 起来的。上面那个处理器的
 * `child.kill()` 只是发出终止请求,返回时系统尚未回收进程,紧接着的 rmSync 就撞上
 * `EBUSY: resource busy or locked, rmdir …\repos\unicode-paths`。
 * rimraf 的重试是同步的(`Atomics.wait`),在退出钩子里可用。
 *
 * 重试用尽后**只警告不抛**:此时全部断言都已跑完,删不掉一个临时目录是收尾的
 * 事故而不是产品缺陷,让它把一整档 CI 变红只会淹掉真正的失败。目录在 `os.tmpdir()`
 * 下,系统自己会回收。
 */
export function cleanupOnExit(getDir) {
  process.on('exit', () => {
    const dir = getDir();
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (cause) {
      process.stderr.write(`# 清理临时目录失败(不影响断言结果):${cause.message}\n`);
    }
  });
}

/**
 * 还活着的被测进程。
 *
 * 不再有 `after()` 来收尾(见 `once()`),所以在这里兜底:退出时统一 kill,
 * 否则 runner 会被子进程的 stdio 句柄吊住,表现为「测试全过但命令不返回」。
 * 本文件先于各测试文件被 import,这个处理器因此也先注册、先执行 —— 排在
 * `cleanupOnExit` 删目录之前。
 */
const alive = new Set();
process.on('exit', () => {
  for (const child of alive) child.kill();
});

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
    alive.add(child);
    child.on('close', () => alive.delete(child));

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
      // 被测进程不再吊住 runner 的事件循环:用例跑完 → 循环空 → 进程退出 →
      // 上面那个 'exit' 处理器统一 kill。不 unref 的话,任何一个没被显式 stop 的
      // server 都会让 `node --test` 跑完全部用例后**永远不返回**(已实测)。
      // stop() 里会 ref 回来,否则 kill 之后等 'close' 时循环可能已经空了
      child.unref();
      child.stdout.unref();
      child.stderr.unref();
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
            child.ref();
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
 * 跑一遍产品的**完整流程**:起进程 → `/api/state` → 给列表里每个文件取一次 diff → 退出。
 *
 * 放在 helpers 而不是各测试文件里,是因为 §5.10 两层门禁的全部价值都建立在「流程真的
 * 走到了被保护的那段代码」上。两份各自维护的流程定义意味着 S4a 新增的分支
 * (binary / too-large / 重命名双路径)接进其中一份、另一份静默漏掉,而两边都不会红。
 *
 * diff 请求由 `/api/state` 的返回**推导**而不是手写清单:重命名条目自带 `oldPath`,
 * 手写时漏传它就会走进「退化成全新增文件」那条分支(spec §5.2),读起来却像覆盖到了。
 *
 * 逐个串行发,不 `Promise.all`:每个请求在后端都是一次 git 子进程,而这个流程会被指到
 * 320 文件的仓库上。并发只会把它变成 320 个同时在跑的 git。
 */
export async function runFullFlow(cwd, { env } = {}) {
  const server = await startGitglance({ cwd, ...(env ? { env } : {}) });
  try {
    const state = await authedGet(server.port, server.token, '/api/state');
    const files = JSON.parse(state.body).files ?? [];
    const diffs = [];
    for (const file of files) {
      const query = new URLSearchParams({ path: file.path });
      if (file.oldPath) query.set('oldPath', file.oldPath);
      diffs.push(await authedGet(server.port, server.token, `/api/diff?${query}`));
    }
    return { cwd, state, files, diffs, stderr: server.stderr };
  } finally {
    await server.stop();
  }
}

/** 带上会话 cookie 的请求。cookie 头的构造见 `cookieHeader`。 */
export function authedGet(port, token, path, headers = {}, method = 'GET') {
  return httpGet(port, path, { Cookie: cookieHeader(port, token), ...headers }, method);
}

/**
 * 会话 cookie 的头部值。**cookie 名的字面量在整个 test/smoke/ 里只此一处**。
 *
 * 冒烟跑的是 `dist/` 产物、不能 import `src/server/http/security.ts` 的 `cookieName`,
 * 所以这份重复是无法避免的边界;但边界应当只有一道 —— 各用例自己拼(SSE 那两处
 * 尤其容易顺手拼一份),格式一改就要满文件找,而漏掉的那处只会以 403 出现。
 */
export function cookieHeader(port, token) {
  return `gitglance_token_${port}=${token}`;
}

/**
 * 等被测进程自己退出,返回退出码。
 *
 * **`ref()` 是必需的,而这件事只有本文件知道**:上面 ready 之后把子进程与它的 stdio
 * 都 unref 掉了(否则 `node --test` 跑完全部用例也不返回)。不 ref 回来的话,事件
 * 循环会先空掉、runner 直接结束,而这条 await 永远没有结果 —— 一个没有错误消息的
 * 失败。所以它跟 `stop()` 一样住在 unref 的旁边,而不是在用例文件里各写一份。
 */
export function waitForExit(server, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const { child } = server;
    child.ref();
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      rejectPromise(new Error(`等自动退出超时(${timeoutMs}ms)。stdout: ${server.stdout}`));
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}
