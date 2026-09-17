<h1 align="center">
  <img src="assets/mark.svg" width="40" align="top" alt="">
  difftab
</h1>

<p align="center"><strong>一个浏览器标签页，看懂 AI 编码 Agent 改了哪些代码。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/difftab"><img src="https://img.shields.io/npm/v/difftab" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/difftab" alt="node"></a>
  <a href="#安全"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/difftab" alt="license"></a>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#用法">用法</a> ·
  <a href="#为什么做-difftab">为什么</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="README.md">English</a>
</p>

一个只读、零依赖的本地工作区查看器：diff、文件树、分支状态，在 agent 继续写的过程中自动刷新。关掉标签页，它就退出。

## 为什么做 difftab

你在终端里跑 Claude Code、Codex、OpenCode 之类的 agent。它做完一件事，你想看看它到底改了什么。agent 自带的 diff 在终端里刷过去，那不是读一份三百行补丁的地方——于是你打开 VS Code，或者手边为此留着的随便哪个 IDE，什么都不编辑，只是看看 diff、瞄一眼目录树、确认下分支，然后关掉。

difftab 就是编辑器里的这一半，去掉编辑器。一条命令、一个标签页，只装你真正会看的那三样。它只读 git，所以配哪个 agent、哪种语言、哪个仓库都一样——如果你现在写代码只靠 agent，它让你可以把 IDE 卸掉。

## 特性

- **像编辑器那样看 diff**——已暂存、未暂存、未跟踪、冲突一目了然，并排展示，带语法高亮。
- **整个仓库，而不只是改动过的那些**——浏览文件树，点开任一文件即可查看。
- **信得过的分支状态**——ahead/behind、无上游、游离 HEAD、进行到一半的 rebase 或 merge。
- **agent 边写边看**——文件一变，标签页自己刷新。
- **绝不写你的仓库**——只发只读的 git 命令，由 CI 门禁保证，不是靠承诺。细节见[安全](#安全)。
- **不用养着**——瞬间启动，零依赖，关掉标签页就退出。

## 安装

要求 **Node.js 22 或更高**，macOS / Windows / Linux 三端均支持，没有其他依赖。

```bash
npm i -g difftab
```

也可以不装直接试：

```bash
npx difftab
```

## 用法

在任意 git 仓库目录下执行：

```bash
cd /path/to/your/repo
difftab
```

浏览器标签页随即打开，展示当前的 diff。让它在 agent 旁边开着：文件一变标签页就刷新，关掉它进程自己退出。在同一个仓库里再敲一次 `difftab`，会复用已在跑的实例，不会起第二个。

| 选项 | 作用 |
|---|---|
| `--no-open` | 只打印 URL，不拉起浏览器 |
| `-v`, `--version` | 打印版本号并退出 |
| `-h`, `--help` | 打印帮助并退出 |

没有任何东西需要配置：不用选端口，没有配置文件。

## 工作原理

`difftab` 只运行 `git status` 与 `git diff HEAD` 那一类只读 git 命令，由一个只绑 `127.0.0.1` 的本地服务把结果交给页面。页面点到哪个补丁才加载哪个，文件一变就刷新；最后一个标签页关掉 45 秒后进程自行退出。

## 安全

只读、只在本机，除了你自己的电脑不需要信任任何东西。

**全程零写操作。** difftab 只发只读的 git 命令——不 stage、不 commit、不 discard、不 pull / push、不建分支、不 stash。两道门禁在每次改动上守着：一道是覆盖每一次 git 调用的 `GIT_TRACE` 命令白名单，另一道是 `.git` 前后逐字节比对。`dist/server/main.js` 不压缩不混淆发布，可以手工审计。

**全程不外传。** 服务只绑 `127.0.0.1`；difftab 发出的唯一一个 HTTP 请求是打到 localhost 上的，用来确认这个仓库是不是已经有实例在跑。无遥测、无账号、无云端。

**本地页面也是锁死的。** 每次会话生成一个随机 token，先经 URL 交给浏览器，随后落进 `HttpOnly; SameSite=Strict` 的 cookie，并把 URL 上的 query 重定向掉。每个请求都校验 `Host` 头与 `Origin`——`Host` 那道才是 DNS rebinding 的正面防御，光靠 token 挡不住；页面跑在 `default-src 'none'` 的 CSP 之下，被嵌 iframe、`<base>` 改写相对 URL 与表单外发也一并挡掉。后端没有任何开发用的后门：不存在放宽这几道校验的环境变量。

## 常见问题

**能配我用的 agent 吗？**——能，只要它往 git 工作区里写文件。difftab 从不与 agent 打交道，它只读 git。Claude Code、Codex、OpenCode、Aider、拿着 vim 的人，都一样。

**能在里面 stage、commit 或 discard 吗？**——不能，将来也不会加。这是产品的核心承诺，见[明确不做](#明确不做)。

**界面上写着「Polling」，是出问题了吗？**——没有。这个仓库没在用原生文件监听（Linux 上较旧的 Node、网络盘、Docker 卷，或 inotify 配额耗尽），所以 difftab 改成每 1.5 秒查一次 `git status`。一切照常刷新，只是可能慢一两秒。

## 明确不做

difftab 刻意只是个查看器。长期不做：任何仓库写操作、代码编辑、账号与云同步、多用户评审流程。当前版本不做：提交历史、分支列表、blame。完整清单与理由见 [CONTRIBUTING.md](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable)。

## 参与开发

```bash
pnpm install --frozen-lockfile
pnpm build                       # 前端 Vite + 后端 tsdown
node bin/difftab.js              # 在任意 git 仓库目录下跑起来
```

其余在 [CONTRIBUTING.md](CONTRIBUTING.md)：dev server 怎么起、门禁清单，以及那几条「坏了不报错」的地方；需求与设计的唯一事实来源是 [`docs/`](docs/README.md)。

## License

[MIT](LICENSE)
