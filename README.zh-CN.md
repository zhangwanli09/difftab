# difftab

[![npm](https://img.shields.io/npm/v/difftab)](https://www.npmjs.com/package/difftab)

**一个标签页,看懂 AI 编码 Agent 改了哪些代码。**

在仓库目录敲一条命令。本地网页随即打开,只读展示当前工作区的 diff 与分支状态。
关掉标签页,进程自行退出。

[English](README.md)

difftab 面向的是 agent 刚跑完(或者还在跑)的那一刻:你想「瞥一眼」改了什么,而不是
开一场代码评审。它展示的就是 `git status` 与 `git diff HEAD` 的内容,以语法高亮的 diff
呈现——窗口够宽时并排,不够宽时逐行——并在 agent 继续写的过程中自动刷新。它对你的仓库**全程零写
操作**——这是核心承诺,由两道 CI 门禁守着,详见[下文](#全程零写操作)。

## 安装

不用装,在任意仓库目录里直接跑:

```bash
npx difftab        # pnpm 用户:pnpm dlx difftab
```

首次要下载解包,多花几秒,之后走缓存。

如果你每次 agent 跑完都要看一眼,那就装一次——`npx` 光是决定该跑哪个版本,就比 difftab
自己启动还花时间:

```bash
npm i -g difftab   # 或:pnpm add -g difftab
```

要求 **Node.js 22.0.0 或更高**。`dependencies` 为空:后端只用 Node 标准库,前端在构建期
就打进产物,所以全局安装是零传递依赖的。

## 使用

```bash
cd /path/to/your/repo
difftab            # 或:npx difftab
```

| 参数 | 作用 |
|---|---|
| `--no-open` | 只打印 URL,不拉起浏览器 |
| `-v`, `--version` | 打印版本号并退出 |
| `-h`, `--help` | 打印帮助并退出 |

在同一个仓库里再敲一次,会复用已在跑的实例,而不是起第二个进程。

## 能看到什么

- **变更列表** —— 已暂存、未暂存、未跟踪三组,冲突文件自成一组并印出 XY 两位状态。未跟踪
  的目录展开到文件粒度,而不是折叠成一行 `dir/`。
- **按文件懒加载的 diff** —— 点开某个文件才取它的补丁,任何时候都不会去取整仓 diff。渲染
  用 [diff2html](https://diff2html.xyz/) + highlight.js,配色仿 VS Code,深浅两套跟随系统
  外观。diff 面板窄到放不下两列时自动切成逐行视图,够宽再切回并排。
- **分支状态** —— 当前分支与 ahead/behind 计数,无上游时明说「无上游」;游离 HEAD 与进行
  中的 rebase / merge / cherry-pick / revert / bisect / `git am` 各出一个标注。
- **自动刷新** —— 文件监听经 SSE 推到前端,agent 边改你边看。在递归监听会耗尽整机
  inotify 配额的场合(Linux + Node < 24.14.0),改用轮询,并在界面上标注出来;轮询期间改
  一个**未跟踪**文件的内容不会刷新页面(未跟踪条目在 `git status` 里只有一行,内容变了它
  一个字节都不变)。
- **自己退出** —— 最后一个标签页关掉 45 秒后自动退。多标签、刷新页面、系统休眠唤醒、浏览
  器丢弃后台标签都不会误触发。

边界情况是被显式处理的,而不是留着崩:空仓库(还没有提交)、游离 HEAD、停在中途的 rebase、
linked worktree、submodule、二进制文件、超过 5MB 的文件、重命名(标注完整旧路径与相似度)、
删除的文件,以及路径里带空格、引号、中日韩文字或 emoji 的文件。

difftab 刻意只是个查看器:不编辑代码、不看历史、不做 blame、不承载评审流程。完整的不做
清单在 [CONTRIBUTING.md](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable) 与
[`docs/spec.md`](docs/spec.md) §4。

## 全程零写操作

不是「尽量」。difftab 不 stage、不 commit、不 discard、不 pull / push、不建分支、
不 stash——它只发只读的 git 命令。这条由两道互相独立的门禁在每次 CI、三个平台上守着:

1. **命令白名单。** 整条流程跑在 `GIT_TRACE` 之下,产品发出的每一次 git 调用——包括 git
   自己内部再起的子进程(比如一次意外触发的 `gc`)——都被断言只能是 `status` / `diff` /
   `rev-parse` / `ls-files` / `version`。另配一条「确实记到了东西」的正面断言,白名单不会
   对着一个空数组通过。
2. **`.git` 逐字节不变。** 同一条流程跑两遍:一遍对着只读的 `.git`,一遍对着可写的
   `.git` 并在前后各拍一次快照(每个文件的 size、mtime、内容摘要)比对。另有一组正面对照
   证明这份快照真的抓得住变化。

后端也支持手工审计:`dist/server/main.js` **不压缩不混淆**发布,就是为了让你自己读一遍它
到底跑了哪些 git 命令。

## 本地安全

服务绑定 `127.0.0.1`,随机端口 + 会话级 token。每一个请求——包括 SSE 与静态资源——都要先
过三道校验,**排在其余一切判定之前**:

- **`Host`** 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`。挡住 DNS rebinding 的是这一
  道,不是 token。
- **`Origin`** 非空时必须是服务自身。所有响应不带任何 CORS 头。
- **token** 与本次会话的端口绑定——cookie 的作用域是 host 而非 origin,不隔离端口,绑上
  端口后即使 token 漏给了同机另一个 localhost 服务,也没法在别处复用。

token 只在 URL 里出现一次,首访即置换成 `HttpOnly; SameSite=Strict` cookie 并 302 掉
query,不会长期滞留在浏览器历史里。响应带严格 CSP(`default-src 'none'`,外加不回退到它的
`frame-ancestors` / `base-uri` / `form-action`),以及 `Cache-Control: no-store` 与
`X-Content-Type-Options: nosniff`。静态资源按内存里的白名单映射,绝不用请求路径去拼目录。
**后端不存在任何放宽上述校验的环境变量或分支。**

## 平台支持

macOS / Windows / Linux 三端均支持、均有测试。CI 在三平台 × Node 22 / 24 / 26 上跑完整冒烟
套件,另有全局安装、Node 版本守卫、inotify 配额耗尽降级三个专用作业。CI 覆盖不到的部分在
下面的[已知边界](#已知边界)。

## 已知边界

- **token 要经过一次命令行。** argv 对同机其他用户可读,所以拉起浏览器时有一个几十毫秒的
  窗口——而它要求攻击者已经以另一个本机用户身份在紧循环轮询。真正关掉它与「再敲一次命令
  复用已有实例」相冲突,留到 0.1.0 之后再看。这个窗口在 `xdg-open` 下有多宽**刻意不在 CI
  里量**:headless 上量出来的数字会让人放心,但没有意义。
- **浏览器在 Windows / Linux 桌面上真的弹出来,CI 覆盖不到。** runner 没有桌面会话,所以
  `open` / `cmd /c start ""` / `xdg-open` 的**选择与 argv** 有断言,窗口本身没有。这两条
  都等首个真实用户。

## 开发

```bash
pnpm install --frozen-lockfile   # pnpm 版本由 packageManager 字段固定
pnpm build                       # 前端 Vite + 后端 tsdown
node bin/difftab.js              # 在任意 git 仓库目录下跑起来
```

其余在 [CONTRIBUTING.md](CONTRIBUTING.md):dev server 怎么起、完整的门禁清单,以及这个仓库
里那几条「坏了不报错」的地方。需求与设计的唯一事实来源是 [`docs/`](docs/README.md)——需求要
变,先改 docs 再改代码。

## License

[MIT](LICENSE)
