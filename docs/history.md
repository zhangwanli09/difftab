# 记录：未完事项、发布日志与真机验收

> **本文是记录，不是约束。** 约束在 `CLAUDE.md` 第 5 节（红线）与 [`decisions.md`](decisions.md)（被排除的做法）；需求与设计见 [`README.md`](README.md) 的索引。已收口的 0→1 开发阶段记录不在这里，在 git history。

## 未完事项

**两件都在 CI 之外，都不阻塞发布，都等首个真实 Linux 桌面**（口径见 [`gates.md`](gates.md) 的「真机」一节）：

1. **浏览器在 Linux 桌面上真的弹出来。** runner 没有桌面会话，`xdg-open` 的选择与 argv 已由单测与只读单点断言每次推送重跑，真机要补的是「argv 对了之后系统真的响应」这最后一跳。
2. **token 经命令行的窗口在 `xdg-open` 下有多宽**（机制见 [`design/server.md`](design/server.md) 的「已知边界」）。`xdg-open` 是脚本、`/proc/<pid>/cmdline` 默认全局可读，预计比 macOS 大。**刻意不进 CI**——headless 上 `xdg-open` 立刻失败退出，量出来的窗口比真实桌面上短得多，**是个会让人放心的假数**。

**Windows 那半已于 2026-08-22 在真机桌面上验过**，见下。

## 发布日志

### 0.1.1（2026-08-23）

- **发布前清单里有一条会被上一次发布的验收步骤堵住**：`pnpm check:global` 要求全局尚未装 difftab，而「发布之后」那节让你 `npm i -g difftab` 验收完就一直留在那儿。隔一版再发时它于是直接拒跑——这是它设计对了的地方（拒绝信息比一次假绿有用得多），但两节之间的这层因果原先没写下来，已补进 `RELEASING.md`。处理是先 `npm rm -g difftab` 再跑，发布后按清单重新装回。
- 这次的 `fix(bin)` **不改变任何已安装用户看到的东西**——它修的是仓库本体的入库 mode，受益者是 clone 了本仓库、又在仓库目录里跑过 `npx difftab` 的人。Release notes 把它列进 Fixed 是照实说，别读成「0.1.0 的包坏了」。
- 「registry 上那份按空闲自行退出」这条验收用 `DIFFTAB_IDLE_MS` 把 45 秒压到 5 秒——走的是同一条退出路径，只是不必等满。

### 0.1.0（2026-08-20）

首个版本发到 npm，GitHub Release 建在 tag `v0.1.0`。发布前 CI 在该提交上 18 个作业全绿。四件咬人的事：

- **pnpm 的登录态，而它的报错完全不像认证问题。** `npm login` 已登录、`npm whoami` 有回应、`~/.npmrc` 里有 token，`pnpm publish` 仍回 `[E404] 404 Not Found - PUT …/difftab`——**npm 对「不允许的写」在包还不存在时回 404 而不是 403**，于是错误长得像「包找不到」，而包名确实还没被占，两件事叠在一起足以把人往「名字有问题」上带。**判据是 `pnpm whoami`：pnpm 不认 npm CLI 的登录态，要单独 `pnpm login`。** 认证补上之后错误立刻换成 `ERR_PNPM_OTP_NON_INTERACTIVE`——那条才说实话，也反过来确认了 404 的病因。
- **2FA 决定了这一步没法非交互跑。** 账号的 `two-factor auth` 是 `auth-and-writes`，每次发布都要一个六位 OTP，必须在真终端里跑或 `--otp=<code>` 传进去，码约 30 秒过期。
- **manifest obfuscation 的范围比想象的窄。** pnpm 剥掉的只有 `packageManager` 与 `prepublishOnly`，其余 14 条 `scripts` 与 `devDependencies` 原样发布。
- **`bin/difftab.js` 一直以 `100644` 入库**，病根在仓库里而不在发布产物里。症状分两幕，中间隔着一次「顺手把变更 discard 掉」：在本仓库目录里跑 `npx difftab`，冒出一个**内容零差异**的 `bin/difftab.js` 变更；discard 之后再跑得到 `Permission denied`。原因是 npx 压根没去 registry 取包——cwd 的 `package.json` 自己就叫 `difftab` 且带同名 `bin`，npm exec 装了一条指回工作区的 `file:` 链接，它的 `fixBin` 把 bin 目标 chmod 0755，改的就是仓库本体。**registry 上那份是好的**，所以没为它单独发版。**三道门禁齐刷刷看不见它**：`check:bin` 当时比的是内容字节而 mode 不是内容，`check:pack` / `check:global` 查的是已被 pnpm 归一成 0755 的 tarball，CI 每次全新 checkout 也不保留本地 chmod——**一件只在开发者本机可见、且在 CI 上永远绿的事**。

  补法是 `git update-index --chmod=+x` 入库 + 一条钉 mode 的断言。**这条断言的第一版只查 index，是 `/code-review` 抓出来的**：`--chmod=+x` 只写暂存区，而别人 clone 到的是 HEAD，于是「chmod 过、看见 PASS、那次改动却始终没进提交」的本机会假绿，而 CI 上 index 恒等于 HEAD——**只查 index 的门禁恰好在它唯一要保护的地方最弱**。改成两侧都查。另外那半「拿不到记录一律 FAIL」也单独验了：`git ls-files -s` 对未跟踪路径是 exit 0 + 空 stdout，不把空输出判死，这条断言就会对着空字符串静默通过。
- 顺带记一条已经过期、但判据没过期的事实：开发机的 `~/.npmrc` 当时指向镜像源，后来改指 npmjs。**`publishConfig.registry` 无论 `~/.npmrc` 怎么写都钉死目标，而判据（pnpm 自己打印的 `📦 name@version → <registry>` 那一行）照旧管用**——这正是把「看那一行」写成发布步骤而不是写成一句叮嘱的价值：前提过期了，步骤还在。

## Windows 真机验收（2026-08-22）

在 Windows 真机桌面上，`cmd /c start ""` 确实把默认浏览器拉了起来；同一轮里顺带看了变更展示、改文件后的自动刷新、以及关掉标签页后进程按空闲自动退出，均正常。**全局安装 / `npx` / 本地构建产物三种形态各跑一遍**——这三条路走的是同一段拉起浏览器的代码，但装法不同（PATH 上的 shim、npx 的临时安装、直接 `node bin/difftab.js`），而 Windows 上 bin 靠的是 npm 生成的 `.cmd` / `.ps1` shim 而非 Unix 的可执行位，发布当天那条 `100644` 的坑在这里天然不成立。

**这条记录不留回归，这是它的性质决定的，不是遗漏**——弹窗与否 runner 断言不了，真机这一次补的只是最后一跳。

## 改名 gitglance → difftab（2026-08-20）

**不是重构，是一条被推翻的结论。** 文档从 2026-07-28 起记着「`gitglance` npm 未被占用」，两次复核也确实都返回 404——但**查的是精确名**。npm 的重名校验先把包名小写化、去掉 `-` `_` `.` 再与已有包比对，`gitglance` 归一后与他人已发布的 `git-glance` v1.0.1（同域）完全相同，发布时会被 registry 以 “too similar to existing package” 拒掉。**这个错误不会在任何门禁里响，只会在第一次 `npm publish` 那一刻响**，而那时改名的成本比事先高得多。

新名 `difftab` 连同 `diff-tab` / `diff_tab` / `diff.tab` 四个归一变体逐个核过均为 404。去掉 `git` 前缀同时避开了 Git 商标政策的建议与 npm 上极拥挤的 `git*` 命名空间。改名面 242 处 / 62 个文件，其中只有三类不是机械替换：两条结论本身要重写、围绕旧名写的英文双关文案（换名后是病句）、以及 `README.zh-CN.md`（**它不是自动生成的**，只改英文那份不会有任何门禁变红）。产品行为零变化。
