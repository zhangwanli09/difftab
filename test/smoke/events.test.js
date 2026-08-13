// SSE 通道与档位环境变量,**跑的是 dist/ 产物**(spec §5.7 / §5.8 / §5.12)。
//
// 与 test/unit/server/{sse,watch}.test.ts 的分工:那边钉通道与 watcher 各自的行为,
// 这边钉「它们真的被接在了一起,而且在三个平台上都成立」—— 一条 `git checkout -b`
// 能不能变成浏览器收得到的一个 `change` 事件。两侧全绿而中间没接上,是完全可能的:
// 端点忘了 add 进通道、watcher 忘了起、`.git` 的路径在 Windows 上对不上,都不报错。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeFixtures } from '../fixtures/make.mjs';
import { authedGet, cleanupOnExit, cookieHeader, once, startGitglance } from './helpers.js';

/** 档位强制指定用的内部环境变量(spec §5.7)。 */
const TIER_ENV = 'GITGLANCE_WATCH_TIER';

let workdir;
let repos;
cleanupOnExit(() => workdir);

/** 见 helpers.js 的 `once()`:下限档 Node 22.0.0 不等顶层 `before()`。 */
const setup = once(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'gitglance-events-'));
  // unicodePaths 是唯一带**整个未跟踪目录**的 fixture —— 轮询那条用例要的就是它
  repos = makeFixtures(join(workdir, 'repos'), ['staged', 'unicodePaths']);
});

/**
 * 开一条 SSE 连接,把收到的字节喂给 `onChunk`,直到它返回 true 或超时。
 *
 * 不用 fetch:三道校验里有两道是请求头,而 undici 不让改 `Host`(同 helpers.js)。
 */
function openEvents(port, token, { onChunk, timeoutMs = 15_000 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { Host: `127.0.0.1:${port}`, Cookie: cookieHeader(port, token) },
      },
      (res) => {
        let body = '';
        const timer = setTimeout(() => {
          req.destroy();
          rejectPromise(new Error(`等 SSE 超时。已收到:${JSON.stringify(body)}`));
        }, timeoutMs);
        const settle = () => {
          clearTimeout(timer);
          req.destroy();
          resolvePromise({ status: res.statusCode, headers: res.headers, body });
        };
        if (res.statusCode !== 200) {
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', settle);
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (onChunk(body)) settle();
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

test('SSE 端点同样过三道校验 —— 没有例外', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged });
  try {
    // 无 cookie:第 3 道
    const anonymous = await new Promise((done, fail) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/api/events' }, (res) =>
        done(res.statusCode),
      );
      req.on('error', fail);
      req.end();
    });
    assert.equal(anonymous, 403);
  } finally {
    await server.stop();
  }
});

test('连上就拿到 text/event-stream,且响应头与别的端点一样严', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged });
  try {
    const res = await openEvents(server.port, server.token, {
      // 服务端一连上就写一行注释顶出响应头,不必等第一个事件
      onChunk: (body) => body.includes(': connected'),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    // 长连接不能带 Content-Length,否则浏览器会在读满之后就把流当结束了
    assert.equal(res.headers['content-length'], undefined);
    for (const header of Object.keys(res.headers)) {
      assert.ok(!header.toLowerCase().startsWith('access-control-'), `出现了 CORS 头 ${header}`);
    }
  } finally {
    await server.stop();
  }
});

test('仓库里 git 写操作之后,SSE 推出一个 change 事件', async () => {
  await setup();
  const server = await startGitglance({ cwd: repos.staged });
  try {
    const received = openEvents(server.port, server.token, {
      onChunk: (body) => body.includes('event: change'),
    });

    // 等连接建立再动手:watcher 是在第一个订阅者到达时才起的(懒起,见 server.ts),
    // 抢在它前面写的话事件根本没人在听 —— 而这条用例会以「超时」失败,读起来
    // 像监听坏了
    await new Promise((done) => setTimeout(done, 300));
    /**
     * **对 fixture 仓库的 git 写操作属「开发流程的 git」**(CLAUDE.md 第 1 节):
     * 受「零写操作」约束的是产品代码,不是测试。这里要的就是一次真实的 `.git` 写入,
     * 而 `git checkout -b` 写的正是 HEAD —— §5.7 点名要盯住的那个文件。
     */
    const branch = spawnSync('git', ['checkout', '-b', 'gitglance-probe'], {
      cwd: repos.staged,
      encoding: 'utf8',
    });
    assert.equal(branch.status, 0, `fixture 上切分支失败:${branch.stderr}`);

    const res = await received;
    assert.match(res.body, /event: change/);
    // 事件正文是一行 JSON:多行正文会被 SSE 劈成两条消息
    assert.match(res.body, /event: change\ndata: \{.*\}\n/);
  } finally {
    await server.stop();
  }
});

test(`${TIER_ENV} 能把三档逐个强制指定出来`, async () => {
  await setup();
  // S3b2 的六条档位验收项全压在这个变量上:一台机器只有一个 Node 版本、一个平台,
  // 而三档正是按这两者分的。三档必须给出**三份不同的** watch 取值,
  // 否则「我逐档验过了」建立在一次根本没生效的强制指定上
  const seen = [];
  for (const tier of ['A', 'B', 'C']) {
    const server = await startGitglance({ cwd: repos.staged, env: { [TIER_ENV]: tier } });
    try {
      const state = await authedGet(server.port, server.token, '/api/state');
      seen.push(JSON.parse(state.body).watch);
    } finally {
      await server.stop();
    }
  }
  assert.deepEqual(seen, [
    { mode: 'native', tier: 'A' },
    { mode: 'native', tier: 'B' },
    // C 档的工作区通路一开始就是轮询 —— 它与 A/B 的区别必须体现在 mode 上,
    // 否则前端的降级标注(S3b2)拿不到判据
    { mode: 'polling', tier: 'C' },
  ]);
});

test(`${TIER_ENV}=C:工作区改动经轮询推出 change,且已存在的未跟踪目录里也算数`, async () => {
  await setup();
  /**
   * C 档(Node < 24.14 × Linux)**不建任何递归 watch**,工作区改动只能靠 1.5s 轮询
   * 发现(§5.7)。这条用例同时钉住两件会静默出错的事:
   *
   * 1. 轮询这条通路真的接上了 —— 断了的话页面只是「不刷新」,不报任何错
   * 2. 轮询用的是**逐字复用**的主查询。写入落在一个**已存在的**未跟踪目录里:
   *    漏掉 `-uall` 时 git 把它折叠成一行 `? 未跟踪目录/`,新增文件根本不改变
   *    status 输出,轮询判定「无变化」—— 而那正是 agent 边跑边生成文件的形态
   */
  const server = await startGitglance({ cwd: repos.unicodePaths, env: { [TIER_ENV]: 'C' } });
  let probe;
  try {
    const received = openEvents(server.port, server.token, {
      onChunk: (body) => body.includes('event: change'),
    });

    /**
     * 反复写,而不是写一次然后等。
     *
     * 监听是懒起的(第一个订阅者到达时),而轮询的**首拍只建立基线**:抢在基线
     * 之前写的那一份会被算进基线里,于是「没变化」是对的,用例却以超时失败、
     * 读起来像轮询坏了。每拍换一个新文件名,则无论基线落在哪一刻,下一拍都必然
     * 不同 —— 与「等一个够长的固定毫秒数」相比,它不依赖任何一台机器的快慢
     */
    let n = 0;
    probe = setInterval(() => {
      n += 1;
      writeFileSync(join(repos.unicodePaths, '未跟踪目录', `poll-probe-${n}.md`), `probe ${n}\n`);
    }, 400);

    const res = await received;
    assert.match(res.body, /event: change/);
  } finally {
    clearInterval(probe);
    await server.stop();
  }
});

test(`${TIER_ENV} 写错时是一句话报错,不是 Node 异常栈`, async () => {
  await setup();
  await assert.rejects(
    () => startGitglance({ cwd: repos.staged, env: { [TIER_ENV]: 'D' }, timeoutMs: 10_000 }),
    (cause) => {
      // 悄悄退回自动判定的话,这里会**启动成功** —— 于是这条用例正是那条禁令的门禁
      assert.match(cause.message, /must be one of A, B, C/);
      assert.doesNotMatch(cause.message, /at \w+ \(/, 'stderr 里出现了 Node 异常栈');
      return true;
    },
  );
});
