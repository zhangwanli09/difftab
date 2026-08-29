# difftab

[![npm](https://img.shields.io/npm/v/difftab)](https://www.npmjs.com/package/difftab)
[![node](https://img.shields.io/node/v/difftab)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#全程零写操作)
[![license](https://img.shields.io/npm/l/difftab)](LICENSE)

**一个标签页，看懂 AI 编码 Agent 改了哪些代码。**

在仓库目录敲一条命令，本地网页随即打开，只读展示当前工作区的 diff 与分支状态（就是 `git status` 与 `git diff HEAD` 的内容），并在 agent 继续写的过程中自动刷新；关掉标签页，进程自行退出。

[English](README.md)

## 快速开始

```bash
cd /path/to/your/repo
npx difftab
```

也可以装一次——`npm i -g difftab`——之后直接敲 `difftab`。

要求 **Node.js 22 或更高**，macOS / Windows / Linux 三端均支持，零依赖。

- `--no-open`——只打印 URL，不拉起浏览器
- `-v`, `--version`——打印版本号并退出
- `-h`, `--help`——打印帮助并退出

在同一个仓库里再敲一次，会复用已在跑的实例。

## 能看到什么

- **变更列表**——已暂存、未暂存、未跟踪、冲突四组，未跟踪的目录展开到文件粒度。
- **按文件懒加载的 diff**——点开某个文件才取它的补丁，渲染用 [diff2html](https://diff2html.xyz/) + highlight.js，配色仿 VS Code，面板窄到放不下两列时自动切成逐行。
- **分支状态**——当前分支、ahead/behind 计数、无上游、游离 HEAD，以及进行中的 rebase /
  merge / cherry-pick / revert / bisect / `git am`。
- **自动刷新**——文件监听经 SSE 推到前端；递归监听会耗尽 inotify 配额的场合改用轮询，并在界面上标注。
- **自己退出**——最后一个标签页关掉 45 秒后自动退。

空仓库、停在中途的 rebase、linked worktree、submodule、二进制与超过 5MB 的文件、重命名，以及带空格、引号、中日韩文字或 emoji 的路径，都是被显式处理的。

difftab 刻意只是个查看器：不编辑、不看历史、不做 blame、不承载评审流程（完整的不做清单见 [CONTRIBUTING.md](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable)）。

## 全程零写操作

不是「尽量」：difftab 只发只读的 git 命令——不 stage、不 commit、不 discard、不 pull / push、不建分支、不 stash。两道门禁在每次改动上守着：一道是覆盖每一次 git 调用的 `GIT_TRACE` 命令白名单，另一道是 `.git` 前后逐字节比对。后端也支持手工审计：`dist/server/main.js` 不压缩不混淆发布。

## 全程留在本机

服务只绑 `127.0.0.1`，端口由内核随机分配，且没有任何东西离开这台机器：difftab 发出的唯一一个 HTTP 请求是打到 localhost 上的，用来确认这个仓库是不是已经有实例在跑。无遥测、无账号、无云端。

每次会话生成一个随机 token，先经 URL 交给浏览器，随后落进 `HttpOnly; SameSite=Strict` 的 cookie，并把 URL 上的 query 重定向掉。每个请求都校验 `Host` 头与 `Origin`——`Host` 那道才是 DNS rebinding 的正面防御，光靠 token 挡不住；页面跑在 `default-src 'none'` 的 CSP 之下，被嵌 iframe、`<base>` 改写相对 URL 与表单外发也一并挡掉。后端没有任何开发用的后门：不存在放宽这几道校验的环境变量。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm build                       # 前端 Vite + 后端 tsdown
node bin/difftab.js              # 在任意 git 仓库目录下跑起来
```

其余在 [CONTRIBUTING.md](CONTRIBUTING.md)：dev server 怎么起、门禁清单，以及那几条「坏了不报错」的地方；需求与设计的唯一事实来源是 [`docs/`](docs/README.md)。

## License

[MIT](LICENSE)
