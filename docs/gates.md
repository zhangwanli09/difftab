# 门禁、测试数据与发布产物

> 「什么东西保证这个项目没坏」的清单。约束本身在 [`design/`](design/) 与 `CLAUDE.md` 第 5 节，本文只说**怎么验**。

## 两条口径

- **以 CI 绿为准，不以本机为准。** 本机绿而 CI 红是常态（实测：lefthook 的 postinstall 在 `CI` 置位时跳过写钩子，本机永远看不到这个）。
- **CI 的 `windows-latest` / `ubuntu-latest` runner 本身就是真机，断言得了的一律交给它们。** 凡能写成断言的（三档的监听与过滤行为、inotify 用量、压低配额后的降级、全局安装、版本守卫、`--git-dir` 在各平台回来的分隔符形态）一律进 matrix 或专用作业。**留在 CI 之外的只有两类**：(a) **浏览器真的弹出来**——runner 没有桌面会话，`open` / `start` / `xdg-open` 的**选择与 argv** 由 `browser.test.ts` 与只读单点断言覆盖，弹窗与否只能靠真机桌面；(b) 肉眼观感类（渲染、配色、截断行为、「延迟感知不明显」）。**这不是把标准放宽**：一条每次推送都重跑的断言强于一次人工确认，而这两类恰恰是断言写不出来的部分。

## 两条没有门禁的性能预算

两条都**没有断言**，归上面第二条口径里的肉眼 / 人工项。写在这里是为了让 `decisions.md` 那两处实测有个可指的结论，**不是重开一份逐条勾选的验收清单**。

- **首屏渲染 ≤ 1s。** 前提是浏览器进程已在运行；冷启动浏览器本身的 2–5s 与 `npx` 首次下载解包都不计入（后者在 README 里说明）。实测 `/api/state` 47ms、`first-contentful-paint` 56–72ms，见 `decisions.md`。
- **空闲资源：原生监听档接近零，降级轮询档 CPU < 1%。** 30s 采样实测 C 档 0.27%、A 档 0.03%、B 档 0.00%，RSS 三档均约 60 MB（Node 基线），见 `decisions.md`。这条同时是 `design/watch.md` 把安全轮询周期取 30s 而不是 1.5s 的约束来源。

冷启动 ≤ 300ms 与产物体积**不在这一节**——那两条各有门禁，见下表与 `design/diff-render.md` 的体积表。

## 门禁 → 它挡住哪条静默故障

| 门禁 | 挡住什么 | 在哪跑 |
|---|---|---|
| `pnpm lint`（`biome ci`） | 架构边界的 import 方向反了（`src/web` 反向 import `src/server`、`git`/`watch` 反向 import `http`/`cli`）——**只看 import 说明符，换个拿到 `child_process` 的方式就绕过去了** | build |
| `pnpm typecheck` | 用到 Node 24+ 才有的内置 API 或超出 ES2023 的语法，而下限档要到 CI 跑完才发现 | build |
| `pnpm test`（Vitest） | 解析器、三道校验、DOM 渲染路径的常规回归。`test-layout.test.ts` 另外钉住「用例目录放错就静默不跑」 | build |
| `pnpm test:smoke`（`node --test`，跑 `dist/`） | 产物层面的行为回归。**先 `pnpm build`**——它跑 `dist/`，产物比源码旧一轮时红的样子像「三道校验全坏了」 | matrix（三平台 × Node 22.0.x/24/26） |
| 只读**主门禁**（`readonly.test.js`） | 产品发出了白名单外的 git 子命令。**自带一条「确实记到了东西」的正面断言**——否则白名单会对着空数组通过 | matrix |
| 只读**第二层**（`readonly-git-dir.test.js`） | `.git` 被写了。A 半锁死 `.git` 抓会报错的写，B 半逐字节比对抓**不报错**的那种（漏设 `GIT_OPTIONAL_LOCKS=0` 只有 B 半看得见）。两半各自带一条正面探针 | matrix |
| 子进程单点断言 | git 子进程跑出了 `server/git`、或拉起浏览器跑出了 `server/cli`。**查的是相等而非「没有多余的」**——只查多出来的一半时，两处调用点双双改名会让白名单静默变成空表 | matrix |
| `pnpm size` | 产物体积超预算。**不进 matrix**：同一份 `dist/` 再跑 9 遍不增加覆盖，反而因各 Node 自带 zlib 不同而引入方差 | build |
| `pnpm bench:startup` | 冷启动超 300ms。口径是「监听成功并打印 URL」，首次 `git status` 交由第一个 HTTP 请求惰性执行、不计入——否则指标会随被测仓库规模漂移 | matrix |
| `pnpm check:css` | CSS 层叠的四类静默失效：块进了 `@layer`、hljs 排到了 diff2html 之后、`--d2h-*` 覆写排到了 diff2html 之前或漏了几个、产物里有无定义的 `var()`、深色 delta 里的 token 名写错 | build |
| `pnpm check:pack` | 发布产物混进了 `src/` / 配置 / 测试，或 `dependencies` 不再为空。**只查发布文件清单是查不出加依赖的**，所以它同时查 manifest 的三个依赖字段 | build |
| `pnpm check:bin` | `bin/difftab.js` 丢了可执行位（HEAD 与 index 两侧都查），或被构建管线碰过 | build |
| `pnpm check:global` | `npm i -g` 之后用 PATH 上那个名字跑不通，或全局目录下冒出了传递依赖。**要求全局尚未装着 difftab，否则脚本直接拒跑** | 专用作业（三平台） |
| `pnpm check:inotify` | Linux 上压低 `fs.inotify.max_user_watches` 至 ENOSPC 后没能降级。**不进冒烟套件**，非 Linux 直接 SKIP | 专用作业（ubuntu，需免密 sudo） |
| old-node-guard | 低于下限的 Node 上拿到的是 `SyntaxError` 而不是友好提示。**单列一档**，因为 build 与 matrix 都跑在 ≥22 上，解析期失败那条路径在那里永远测不到 | 专用作业（Node 20 × 三平台） |
| 冒烟文件计数 | `node --test` 一个用例都没匹配上时是 0 用例、exit 0——一次改名就能把「只读承诺的唯一自动化保护」变成一个什么都没跑的绿勾 | matrix |
| 后端产物 import 检查 | 后端引了标准库以外的模块（断言 `dist/server/main.js` 的 import 说明符全部以 `node:` 开头） | matrix |
| 前端产物 CJK 计数为 0 | 界面文案漏了中文。**后端那侧拦不到**（产物按约定保留注释），它的用户可见文案是 `sendError` 与各 `*Error` 的字面量，归 `test/unit/server/` | matrix |

## 测试数据（`pnpm fixtures`）

生成脚本对测试仓库执行 `git init` 等写操作，属**开发流程的 git**，不受只读承诺约束。脚本零依赖纯 JS，测试自己调 `makeFixtures()` 写临时目录、按需只生成用得到的几个。

**判据是「这个 fixture 决定不决定解析器的结构」，不是「它算不算边界情况」。** 下面这些各自钉住一个只能靠它证伪的形态：

| fixture | 它唯一能证伪的东西 |
|---|---|
| 路径含非 ASCII / 空格 / 引号 | `-z` 与 `core.quotePath=false` 有没有真的生效 |
| 重命名（含相似度阈值边界，一个 add 一个不 add） | 解析循环是有状态还是无状态平铺。**status 的重命名检测比的是 HEAD → index**：`git mv` 后重写内容但不 `git add`，git 仍报 `R100`，要拿到「阈值之下 → 拆成 `1 D.` + `1 A.`」必须一并入 index |
| 已暂存改动 | 双状态位；`git diff` 而非 `git diff HEAD` 会漏掉它 |
| **已暂存的删除**（`git rm` 之后） | 分流判据用 `ls-files` 会把它误判成未跟踪——「已跟踪」的定义是 **HEAD ∪ index** |
| **未跟踪的符号链接**（故意指向仓库外一个内容已知的文件） | 读磁盘那条路用 `stat` 而非 `lstat` 时，仓库边界校验形同虚设。断言补丁里不含链接目标的内容 |
| **整目录未跟踪** | `-uall` **唯一能被证伪**的形态。落在已跟踪目录里的未跟踪文件，折不折叠长得一样 |
| 无上游的新建分支 / 有上游且 ahead-behind 都非零 | `# branch.ab` 行缺失的降级路径，以及它的对照面 |
| 空仓库（`git init` 后无提交） | HEAD 不存在时 diff 基准的接口形状 |
| 300+ 文件变更 | 懒加载；一次性取全仓 diff 会在这里冻住主线程 |
| **配不上对的重命名**（`git mv` 后重写成 6 万行、不 add） | numstat 取 `[0]` 的掷硬币行为——实测拿到的是旧文件那条几十行的删除，于是行数闸放行 |
| **名字里带 `*` 的文件 + 一个会被它匹配到的邻居** | pathspec 默认是 wildmatch；缺 `GIT_LITERAL_PATHSPECS=1` 时页面在 A 的标题下显示 B 的补丁 |
| 新增 / 二进制 / >5MB / 超多行 | `DiffPayload` 四个分支各自的填充与渲染 |
| detached HEAD | `# branch.head` 是字面量 `(detached)`，前端不得把它当分支名画出去 |
| merge 停在冲突 / rebase 停在冲突 | 操作标注的判据表与**优先级**——rebase 停下时 `rebase-merge/` 与 merge 的痕迹**同时在** |
| linked worktree / submodule | `.git` 是文件不是目录；状态文件按 `rev-parse --git-dir` 找而不是拼 `<root>/.git` |
| bare 仓库 | `rev-parse --show-toplevel` 以 128 退出，要给一句话拒绝而不是崩溃 |
| SHA-256 空仓库 | 空树哈希那个常量的实测来源 |

**一条总原则：门禁不得晚于它所保护的代码，方案前提不得晚于依赖该前提的实现。** 把校验排在后面，等于在前面为绕过它留出最短路径。

## 发布产物约定

- **`files` 白名单**为 `bin/`、`dist/`、README（含 `README.<lang>.md` 译文）、LICENSE；`prepublishOnly` 执行完整构建。
- **注意 `files` 不是一份完整的白名单**：npm / pnpm 无条件把根目录下所有 `README*` 打进 tarball，与 `files` 无关。门禁查的是 pack 的实际输出而不是 `files` 字段，所以这类偏差抓得到。
- **`dependencies` 为空。** 前端依赖在构建期即被打进 `dist/web/app.js`，后端只用 Node 标准库——用户 `npm i -g` 时零传递依赖安装。
- **`publishConfig.registry` 钉住 `registry.npmjs.org`**：开发机的全局 `~/.npmrc` 可能指向镜像源，不钉住就会发错地方。判据是 `pnpm publish` 打印的 `📦 name@version → <registry>` 那一行。这是 npm 的 manifest 字段，不受「pnpm 设置只写 `pnpm-workspace.yaml`」约束。
- **`publishBranch: main` 写在 `pnpm-workspace.yaml`**——pnpm 自己的默认值是 `master`。
- **pnpm 打包时默认做 manifest obfuscation**，会从发布出去的 `package.json` 里剥掉 `packageManager` 字段与 publish 生命周期脚本。这对本项目是想要的（用户侧不该看到我们的开发期工具链），**不要用 `--skip-manifest-obfuscation` 关掉**，但核对产物时要知道打出来的 `package.json` 本就与仓库里的不同。
- **pnpm 默认会做 git 检查**（工作区必须干净、分支需匹配），这层检查有价值，**不要用 `--no-git-checks` 关掉**。
- **不建 `CHANGELOG.md`**：GitHub Releases 的 notes 就是变更日志。两处写同一份清单，等于多一个会忘的地方。
- **semver：0.x 保留破坏性余地**（尤其 CLI 参数与端口/token 行为）。**1.0.0 是结论不是起点**——本工具的核心承诺是只读与零副作用，1.0.0 应当是这些承诺被两层验证覆盖、且三端真机验过之后的结果。

发布的**步骤**照 [`../RELEASING.md`](../RELEASING.md) 走，不凭记忆敲。
