// 冒烟测试的公共工具。纯 JS、只用标准库——matrix 档完全不装依赖。
//
// 文件名不以 `.test.js` 结尾：`test/smoke/*.test.js` 展开不到它，于是既不会被
// node --test 当成用例，也不进 CI 里那条按文件名点名的检查。

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const BIN = resolve(REPO_ROOT, 'bin', 'difftab.js');

/**
 * 一次性的懒初始化，**替代 `node:test` 的顶层 `before()`**。
 *
 * Node 22.0.0——也就是本项目运行时下限、matrix 专门有一档跑它——的 test runner **不等顶层异
 * 步 `before()` 完成就开跑该文件的用例**（已在本机复现：依赖共享 server 的用例全部在 1ms 内以
 * `undefined` 失败；24 / 26 上正常），`after()` 同样会提早触发，清理撞上还在写的文件报
 * ENOTEMPTY。所以不用钩子：把准备工作包成一个记忆化的 Promise，每个用例开头 `await` 它。
 */
export function once(factory) {
  let pending;
  return () => (pending ??= factory());
}

/**
 * 进程真正退出时清理临时目录。同样是绕开 `after()`：`process.on('exit')` 由 Node 自己保证时机，
 * 且必须是**同步**操作——`removeDir` 里那个 rmSync 正合适。
 */
export function cleanupOnExit(getDir) {
  process.on('exit', () => {
    const dir = getDir();
    if (dir) removeDir(dir);
  });
}

/**
 * 还活着的被测进程。不再有 `after()` 来收尾，所以在这里兜底：退出时统一 kill，否则 runner 会被
 * 子进程的 stdio 句柄吊住，表现为「测试全过但命令不返回」。本文件先于各测试文件被 import，这个
 * 处理器因此也先注册、先执行——排在 `cleanupOnExit` 删目录之前。
 */
const alive = new Set();
process.on('exit', () => {
  for (const child of alive) child.kill();
});

/**
 * 拉起 CLI 并等到它打印出 URL。ready 的判据与 scripts/bench-startup.mjs 一致：**stdout 的第一行
 * 是且只是 URL**。
 *
 * `command` / `shell` 可覆盖，默认是 `node bin/difftab.js`。**加这两个参数是为了让全局安装那条
 * 门禁也走同一份 ready 判据**——它要起的是 PATH 上那个名字（Windows 上隔着一个 `.cmd` shim，
 * 只能经 shell 起），除此之外它需要的东西与这里逐字相同。各写一份的结果是「第一行是 URL」这个
 * 判据有了第三个定义，而三处失败起来长得完全不一样。
 */
export function startDifftab({
  cwd,
  env = {},
  timeoutMs = 20_000,
  command = process.execPath,
  args = [BIN],
  shell = false,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      env: {
        ...process.env,
        // 拉起浏览器在测试里必须可关，否则每跑一次就弹一次
        DIFFTAB_NO_OPEN: '1',
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
      // 被测进程不再吊住 runner 的事件循环：用例跑完 → 循环空 → 进程退出 → 上面那个 'exit' 处理
      // 器统一 kill。不 unref 的话，任何一个没被显式 stop 的 server 都会让 `node --test` 跑完全部
      // 用例后**永远不返回**。stop() 里会 ref 回来，否则 kill 之后等 'close' 时循环可能已经空了
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
 * 在 `cwd` 里拉起 CLI 并**期待它拒绝启动**（前置检查失败：不是仓库、bare、git 太老）。
 *
 * 「一句话友好报错、不是 Node 异常栈」这条契约有两个断言点，两处各写一遍的结果已经出现过：一处
 * 用 `includes('    at ')`、另一处用正则，弱的那一份不会有任何东西提醒你它弱。只回 stderr：调用
 * 方要断言的只有那句话，而「退出码 1 / stdout 为空 / 不带栈」三条在这里一次断完。
 */
export function expectStartupRefusal(assert, cwd) {
  const r = spawnSync(process.execPath, [BIN], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DIFFTAB_NO_OPEN: '1' },
  });

  assert.equal(r.status, 1, `期望以 1 退出；stdout: ${r.stdout} stderr: ${r.stderr}`);
  // 拒绝了就不该打出 URL 把用户往浏览器里带
  assert.equal(r.stdout, '');
  // 「不崩溃」这条只有反面断言看得住：一屏 Node 栈同样含着那句 message
  assert.doesNotMatch(r.stderr, /^\s+at /m, `报错里带了栈：\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Error:/, `报错里带了异常类名：\n${r.stderr}`);
  return r.stderr;
}

/** 睡一会儿。三个冒烟文件与一个门禁脚本都要它，别再各写一份。 */
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 轮询等到 `predicate()` 为真；超时即抛。判据压在**墙钟**上而不是「累加睡了多少毫秒」：后者在负
 * 载高的 runner 上会连本带利地欠着走，于是名义 10 秒的等待可能只等了 6 秒——而那台机器恰恰是
 * 最需要多等一会儿的那台。
 */
export async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`等 ${what} 超时(${timeoutMs}ms)`);
}

/**
 * 尽力删掉临时目录，删不掉只警告。
 *
 * **`maxRetries` 不是保险起见，是 Windows 上的必需品**：Windows 不允许删除一个仍是某进程当前工
 * 作目录的文件夹，而被测进程正是以 fixture 仓库为 cwd 起来的——`child.kill()` 只是发出终止请
 * 求，返回时系统尚未回收进程，紧接着的 rmSync 就撞上 `EBUSY`。rimraf 的重试是同步的，在退出钩
 * 子里也可用。
 *
 * 重试用尽后**只警告不抛**，两个调用场景都需要这条：退出钩子里此时断言都跑完了，让它把一整档
 * CI 变红只会淹掉真正的失败；门禁脚本则是在 `finally` 里删，从那儿抛出去会顶掉正在报的那条真
 * 失败。目录都在 `os.tmpdir()` 下，系统自己会回收。
 */
export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (cause) {
    process.stderr.write(`# 清理临时目录失败（不影响断言结果）：${cause.message}\n`);
  }
}

/**
 * 开一条 SSE 连接。**整个 test/smoke/ 里只此一处**，理由与下面 `cookieHeader` 那条完全相同：请
 * 求字面量（`Host` 头、cookie、`/api/events` 路径）与流的两个判据（`: connected` 这行握手、
 * `event: change` 这个事件名）都是与服务端的契约，各写一份的结果是改了服务端之后**只有一份变
 * 红**，另几份安静地数出 0 个事件——而 0 在调用方那里往往读作「过滤生效了」，是假绿不是假红。
 *
 * 一个原语覆盖四种用法：`connected` 等握手、`count` 数事件、`body` 看原文、`close()` 收工。
 */
export function openEvents(port, token, { timeoutMs = 15_000 } = {}) {
  let body = '';
  let req;
  const connected = new Promise((resolvePromise, rejectPromise) => {
    req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { Host: `127.0.0.1:${port}`, Cookie: cookieHeader(port, token) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          rejectPromise(new Error(`SSE 返回 ${res.statusCode}`));
          return;
        }
        const timer = setTimeout(() => {
          req.destroy();
          rejectPromise(new Error('等 SSE 连上超时'));
        }, timeoutMs);
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // 服务端一连上就写一行 `: connected` 注释顶出响应头，不必等第一个事件。**必须等「连上」
          // 而不是等「请求发出去」**：空闲计时是服务端收到连接时才解除的，抢在那之前数的是一段连
          // 接还不存在的时间
          if (body.includes(': connected')) {
            clearTimeout(timer);
            resolvePromise({ status: res.statusCode, headers: res.headers });
          }
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
  return {
    connected,
    get body() {
      return body;
    },
    get count() {
      return (body.match(/^event: change$/gm) ?? []).length;
    },
    close() {
      req.destroy();
    },
  };
}

/**
 * 直接用 node:http 发请求，不用 fetch——三道校验里有两道是**请求头**，
 * 而 undici 把 `Host` 之类列为禁止改写的头，拿它测不了要测的东西。
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
 * 从 GIT_TRACE 日志里抽出每一次被执行的 git 命令（主门禁用）。放在这里而不是测试文件里，是因为
 * 测试文件不该有 export（biome 的 `noExportsInTest` 挡的是「测试文件顺手变成工具模块」）。
 */
export function parseTrace(log) {
  const commands = [];
  for (const line of log.split('\n')) {
    // `trace: built-in: git status --porcelain=v2 ...`（内建子命令）
    // `trace: exec: git-foo ...` / `trace: run_command: ...`（外部命令与内部再起的进程）
    const m = /\btrace: (built-in|exec|run_command|alias expansion): (.+)$/.exec(line);
    if (!m) continue;
    let tokens = m[2].trim().split(/\s+/);
    // 去掉开头的 `git` / `git-foo` 前缀，留下子命令与参数
    if (tokens[0] === 'git') tokens = tokens.slice(1);
    else if (tokens[0]?.startsWith('git-')) tokens = [tokens[0].slice(4), ...tokens.slice(1)];
    if (tokens.length > 0) commands.push({ kind: m[1], subcommand: tokens[0], argv: tokens });
  }
  return commands;
}

/**
 * 跑一遍产品的**完整流程**：起进程 → `/api/state` → 给列表里每个文件取一次 diff → 退出。
 *
 * 放在 helpers 而不是各测试文件里，是因为两层门禁的全部价值都建立在「流程真的走到了被保护的那
 * 段代码」上——两份各自维护的流程定义意味着新增的分支（binary / too-large / 重命名双路径）接
 * 进其中一份、另一份静默漏掉，而两边都不会红。
 *
 * diff 请求由 `/api/state` 的返回**推导**而不是手写清单：重命名条目自带 `oldPath`，手写时漏传
 * 它就会走进「退化成全新增文件」那条分支，读起来却像覆盖到了。逐个串行发，不 `Promise.all`：每
 * 个请求在后端都是一次 git 子进程，而这个流程会被指到 320 文件的仓库上。
 */
export async function runFullFlow(cwd, { env } = {}) {
  const server = await startDifftab({ cwd, ...(env ? { env } : {}) });
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
 * 会话 cookie 的头部值。**cookie 名的字面量在整个 test/smoke/ 里只此一处**：冒烟跑的是 `dist/`
 * 产物、不能 import `security.ts` 的 `cookieName`，所以这份重复是无法避免的边界；但边界应当只有
 * 一道——各用例自己拼时格式一改就要满文件找，而漏掉的那处只会以 403 出现。
 */
export function cookieHeader(port, token) {
  return `difftab_token_${port}=${token}`;
}

/**
 * 等被测进程自己退出，返回退出码。
 *
 * **`ref()` 是必需的，而这件事只有本文件知道**：上面 ready 之后把子进程与它的 stdio 都 unref 掉
 * 了。不 ref 回来的话，事件循环会先空掉、runner 直接结束，而这条 await 永远没有结果——一个没
 * 有错误消息的失败。所以它跟 `stop()` 一样住在 unref 的旁边。
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
