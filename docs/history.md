# 记录：未完事项、发布日志与真机验收

> **本文是记录，不是约束。** 约束在 `CLAUDE.md` 第 5 节（红线）与 [`decisions.md`](decisions.md)（被排除的做法）；需求与设计见 [`README.md`](README.md) 的索引。已收口的 0→1 开发阶段记录不在这里，在 git history。

## 未完事项

**两件都在 CI 之外，都不阻塞发布，都等首个真实 Linux 桌面**（口径见 [`gates.md`](gates.md) 的「真机」一节）：

1. **浏览器在 Linux 桌面上真的弹出来。** runner 没有桌面会话，`xdg-open` 的选择与 argv 已由单测与只读单点断言每次推送重跑，真机要补的是「argv 对了之后系统真的响应」这最后一跳。
2. **token 经命令行的窗口在 `xdg-open` 下有多宽**（机制见 [`design/server.md`](design/server.md) 的「已知边界」）。`xdg-open` 是脚本、`/proc/<pid>/cmdline` 默认全局可读，预计比 macOS 大。**刻意不进 CI**——headless 上 `xdg-open` 立刻失败退出，量出来的窗口比真实桌面上短得多，**是个会让人放心的假数**。

**Windows 那半已于 2026-08-22 在真机桌面上验过**，见下。

另有一件与平台无关、2026-09-11 在做变更列表的树视图时发现的：

3. **`localStorage` 里的偏好跨不了实例。** 后端 `listen(0)` 每次启动端口随机，而 `localStorage` 按 origin（含端口）隔离——`difftab:theme` 写着「跨会话保持」，实际只活到同一实例的刷新，换一次 `difftab` 启动就归零。**没有任何门禁看得见**（`theme.test.ts` 跑在同一个 happy-dom origin 里）。可选的修法各有代价：固定端口（与「随机端口 + token」的安全取向相抵，且单实例注册表按仓库分的正是端口）、把偏好搬到后端按用户存（后端要多一个写端点，而它此刻零写操作）、`sessionUrl` 带一段 hash 让页面自己去读父 origin（不存在这种机制）。**先记着不动**；新加的变更列表版式开关正因为这条不进 `localStorage`。

## 发布日志

### 0.2.2（2026-09-09）

- **README 那条靠人读的检查第二次真的拦下了东西**：正文写着 gzip 71KB，本版 `pnpm size` 实测 72.0KB。`size` 只管 120KB 上限、`bench:startup` 只管 300ms 上限，README 正文里那两个**具体**数字两道门禁都不查。0.2.0 立下这条时它拦的是 68→71，0.2.1 那次跑出绿（数字当时仍准）——**这类检查有没有用，同样只有隔版之后才验得出来**。顺带一条会骗人一程的线索：同一次构建里 `vite build` 打印的 gzip 是 74.32KB，而 `size` 报 72.0KB（两者压缩级别不同）；README 从头到尾用的是 `size` 那份口径，抄错哪一份都不会有任何门禁响。
- **发布分支上第一次真的带了两个提交，`--rebase` 把它们保住了**：0.2.1 记着「若照 0.2.0 的写法把 README 提交也放进发布分支，squash 会把两个提交静默融成一个」，这一版正是那个场景（README 数字修正 + 版本号）。合并前先照 0.2.1 补进 `RELEASING.md` 的那条查了 `Protect main` 的 `allowed_merge_methods`，现在是 `["squash", "rebase"]`，第 2 步于是照原样走通，合并后两个提交仍是两个。**那条清单条目真正的价值是把「该查哪儿」前置到了合并之前**——等被拒时才查，代价是发布当场重想一遍。
- **「先建分支再提交」第三次走通**：本地 `main` 上一个提交都没有，`gh pr merge --delete-branch` 顺手把它快进到合并后的提交，两侧 tree 哈希相同，tag 打在远端那一份上。
- **对 registry 那份多做了一次针对性核对，因为这一版唯一的用户可见改动在渲染层**：冒烟与单测跑的都是 CI 构建出的 `dist/`，证明不了「`npm i -g` 装出来那份真的带上了新的语言表」。判据是全局安装目录下 `dist/web/app.js` 里那个装着 vue / svelte / astro 的 Set。**这里的搜法本身会骗人一程**：产物 minify 之后字符串用的是反引号，按 `"vue"` 搜回 0 命中，看着像这个功能压根没打进包；去掉引号才搜得到。
- **发布后四条验收一次过**：`npm view` 回 0.2.2 且 `dist.tarball` 在 npmjs 上、全局装完底下没有传递依赖、在一个新建的临时仓库里 `npx difftab@0.2.2 --no-open` 打印 URL 并按 `DIFFTAB_IDLE_MS` 自行退出、Release 建在 tag `v0.2.2` 上。

### 0.2.1（2026-09-09）

- **收进 patch 号，判据与 0.1.3 那次逐字相同**：两条 feat（折叠全部、路径栏钉在面板顶端）连同其余改动全落在界面层，不新增端点、不碰 CLI 参数与只读承诺，`dependencies` 依旧为空。0.2.0 拿到 minor 的理由是 `/api/tree` 与 `/api/file` 两个新端点，这一版没有对应的东西。
- **`gh pr merge --rebase` 当场被拒，而仓库设置是条假线索**：报的是 `GraphQL: Rebase merges are not allowed on this repository. (mergePullRequest)`，可 `gh api repos/<owner>/difftab` 里 `allow_merge_commit` / `allow_squash_merge` / `allow_rebase_merge` 三个全是 `true`——真正卡住的是 `Protect main` 这条 ruleset 的 `allowed_merge_methods`，它只列了 `squash`，而 0.2.0 发布时还没有这条 ruleset（那次的 rebase 合并确实走通了，本文上一节记着它重写 committer 引出的分叉）。**这条报得很响，不属于静默故障**，但它把 `RELEASING.md` 从 0.2.0 起写着的第 2 步当场推翻了。**这一版是用 squash 合的**，随后 ruleset 把 `rebase` 加了回去（现在是 `["squash", "rebase"]`），第 2 步因此仍写 `--rebase`；留在清单里的是「rebase 被拒时该去查哪儿」——仓库设置那三个字段回 `true` 是条会骗人一程的线索。
- **这一版用 squash 合掉没有任何损失，但那是运气**：发布分支上只有版本号一个提交，squash 与 rebase 的结果一模一样。真正的后果落在第 1 步而不是第 2 步——squash 会把分支上的所有提交融成一个，若照 0.2.0 的写法把 README 提交也放进发布分支，两个提交会静默融成一个，而「一个提交一件事」正是发布提交好读的全部原因。**这条即使 rebase 已经恢复也仍成立**，因为下次再被关掉时症状与判据完全一样，已连同「查 ruleset 而不是仓库设置」一起补进 `RELEASING.md` 的「会咬人的事」，那节从八条变成九条。合并命令本身另有一处：不给 `--subject` 时 gh 会把 ` (#20)` 缀在 subject 后面。
- **「先建分支再提交」第一次照 0.2.0 补的新写法走了一遍，分叉那条整条没有发生**：`gh pr merge --delete-branch` 顺手把本地 `main` 快进到了合并后的提交，`git pull --ff-only` 无事可做，两侧 tree 哈希相同，tag 打在远端那一份上。**判据是本地 `main` 上一个提交都没有**，与合并方式是 rebase 还是 squash 无关——两种都重写 SHA。
- **README 那两个自由文本里的实测数字这次仍然准**（约 40ms、gzip 71KB，本版实测冷启动中位 42.9ms、`app.js` gzip 71.4KB），所以两份 README 一个字没动。0.2.0 因为这两个数字过期立下的那条人读检查，这一版是它第一次跑出绿。
- **发布后四条验收一次过**：`npm view` 回 0.2.1、全局装完 `npm ls -g --depth=1 difftab` 底下没有传递依赖、在一个新建的临时仓库里 `npx difftab@0.2.1 --no-open` 打印 URL 并按 `DIFFTAB_IDLE_MS` 自行退出、Release 建在 tag `v0.2.1` 上。

### 0.2.0（2026-09-06）

- **第一次发 minor，判据是这一版越过了「改动全落在界面版式」那条线**：文件浏览器是 `spec.md` 里一个完整的 P1 功能，带 `/api/tree`、`/api/file` 两个新端点，而 0.1.2 与 0.1.3 收进 patch 的理由恰恰是「不新增接口、只改版式」。CLI 参数、只读承诺与空 `dependencies` 一处没动，所以是 minor 不是 major——0.x 下把 major 留给会推翻只读承诺或改掉 CLI 形状的那类改动。
- **`git push origin main` 当场被拒：main 在 0.1.3 之后加上了 pull request 规则**，`RELEASING.md` 的第 2 步整条不再成立。**这条报得很响**（`remote rejected … Changes must be made through a pull request`），不属于静默故障，但它把发布从两条命令变成「建分支 → 开 PR → 等 CI → 合并 → 同步 main」五步；清单不改的话下一版还要在发布当场重新想一遍。已改成走 PR，并指定 rebase 合并——squash 会把 README 那个提交与版本号那个提交融成一个，而「一个提交一件事」正是发布提交好读的全部原因。
- **本地 main 与 origin 分叉，`git pull --ff-only` 回 `fatal: Not possible to fast-forward`，而根因是提交先落在了 main 上**：这一版是先在 main 上提交、再建分支开 PR，rebase 合并把那两个提交的 committer 重写了一遍，SHA 全变，于是本地 main 上留着两个「同内容、不同 SHA」的提交。**症状长得像刚推上去的两个提交丢了**，判据则是 tree 哈希——`git rev-parse HEAD^{tree}` 与 `git rev-parse origin/main^{tree}` 相同即内容一致，此时 `reset --hard origin/main` 是安全的，tag 要打在远端那一份上、不是本地那份将被丢弃的。**先建分支再提交就整条不会发生**（紧随其后的那个文档 PR 即如此，`pull --ff-only` 直接快进），新步骤因此把建分支放在 `npm version` 之前，这条同时进了 `RELEASING.md` 的「会咬人的事」——那节因此从七条变成八条。
- **README 里两个实测数字过期了，而没有任何门禁看得见**：正文写着冷启动约 30ms、bundle gzip 68KB，这一版实测是 42.8ms 与 71KB。`bench:startup` 只管 300ms 上限、`size` 只管体积上限，README 正文里那两个**具体**数字是自由文本，两道门禁都不查。发布前清单里「两份 README 描述这一版实际做了什么」是唯一拦得住它的一条，而它靠人读。
- **全局安装那条隔版因果第三次照清单走通**（先 `npm rm -g difftab` 再 `pnpm check:global`），发布后四条验收一次过。额外加了一步：对 registry 上那份直接打了 `/api/tree` 与 `/api/file`。文件浏览器是第一次进包，而冒烟只证明它在 CI 构建出的 `dist/` 上活着。

### 0.1.3（2026-08-30）

- **两条 feat 收进 patch 号，判据是改动全落在界面层**：页面内的明暗开关与并排视图的横向滚动同步都不碰 CLI 参数、HTTP 接口与只读承诺，`dependencies` 依旧为空。0.x 下把 minor 留给会让人重新读一遍 `--help` 的那类改动，这一版不是。
- **`gh run list --commit` 按 `head_sha` 精确匹配，短 SHA 一律回空数组**：run 其实已经在跑，`git log` 上抄来的那七位却查不到任何东西，而空数组与「工作流压根没触发」长得一模一样、两者都不报错。清单里原本写的是 `--commit "$(git rev-parse HEAD)"`，本来就对；这一版是照着它临时改敲了短 SHA 才踩上，一度被误读成推送后的索引延迟。判据是同一刻用全 SHA 查得到、用短 SHA 查不到，已把「别把那个 `rev-parse` 换成短 SHA」补进 [`../RELEASING.md`](../RELEASING.md) 的同一条。
- **除此之外没撞新坑**：`npm rm -g difftab` → `pnpm check:global` 那条隔版因果第二次照清单走通，发布后四条验收（`npm view`、全局安装无传递依赖、在别的仓库里 `npx`、Release 页）一次过。**这一版唯一的新机制不记在这里**——页面内明暗开关是一条被推翻的结论，记在下面的「加页面内的明暗开关」一节。

### 0.1.2（2026-08-27）

- **第一次照着清单从头走到尾、没有撞上新坑的发布。** 上一版补进 `RELEASING.md` 的那条当场生效：`pnpm check:global` 依旧被上一次发布留下的全局安装堵着，但因为清单里写着先 `npm rm -g difftab`，它从「一次要现场排查的拒跑」变成了照做的一步。**清单条目有没有用，只有在隔了一版之后才验得出来。**
- **面向用户的改动全在界面版式**——顶栏并入侧边栏并显示仓库名、upstream 计数改按 VS Code 版式、去掉补丁外框与间距，加一条「文件消失时清空 diff 面板」的修复；CLI 参数、HTTP 接口与只读承诺一处没动。**这一版提交数的大头是 `docs/` 的结构重整，对用户完全不可见**，版本号不反映它也不该反映它。

### 0.1.1（2026-08-23）

- **发布前清单里有一条会被上一次发布的验收步骤堵住**：`pnpm check:global` 要求全局尚未装 difftab，而「发布之后」那节让你 `npm i -g difftab` 验收完就一直留在那儿。隔一版再发时它于是直接拒跑——这是它设计对了的地方（拒绝信息比一次假绿有用得多），但两节之间的这层因果原先没写下来，已补进 `RELEASING.md`。处理是先 `npm rm -g difftab` 再跑，发布后按清单重新装回。
- 这次的 `fix(bin)` **不改变任何已安装用户看到的东西**——它修的是仓库本体的入库 mode，受益者是 clone 了本仓库、又在仓库目录里跑过 `npx difftab` 的人。Release notes 把它列进 Fixed 是照实说，别读成「0.1.0 的包坏了」。
- 「registry 上那份按空闲自行退出」这条验收用 `DIFFTAB_IDLE_MS` 把 45 秒压到 5 秒——走的是同一条退出路径，只是不必等满。

### 0.1.0（2026-08-20）

首个版本发到 npm，GitHub Release 建在 tag `v0.1.0`。发布前 CI 在该提交上 18 个作业全绿。**四件咬人的事，判据与实测数据都在 [`decisions.md`](decisions.md)、发布时照着做的那份在 [`../RELEASING.md`](../RELEASING.md)，这里只记当天是怎么撞上的**：

- **pnpm 的登录态**堵住了第一次 publish 尝试。npm CLI 那侧一切正常，pnpm 却回一个长得像「包找不到」的 404，而包名当时确实还没被占——两件事叠在一起，足以把人往「名字有问题」上带一程。
- **2FA 是 `auth-and-writes`**，于是这一步从一开始就不可能非交互跑，只能在真终端里敲那六位码。
- **manifest obfuscation 的范围比想象的窄**，核对产物时才量清楚被剥掉的到底是哪两项。
- **`bin/difftab.js` 一直以 `100644` 入库**，而病根在仓库里、不在发布产物里：在本仓库目录里跑 `npx difftab` 冒出一个**内容零差异**的变更，discard 掉之后再跑就是 `Permission denied`。**registry 上那份是好的**，所以没为它单独发版。补法是 `git update-index --chmod=+x` 入库加一条钉 mode 的断言，而**那条断言的第一版只查 index，是 `/code-review` 抓出来的**——它恰好在自己唯一要保护的地方（开发者本机）最弱。

## Windows 真机验收（2026-08-22）

在 Windows 真机桌面上，`cmd /c start ""` 确实把默认浏览器拉了起来；同一轮里顺带看了变更展示、改文件后的自动刷新、以及关掉标签页后进程按空闲自动退出，均正常。**全局安装 / `npx` / 本地构建产物三种形态各跑一遍**——这三条路走的是同一段拉起浏览器的代码，但装法不同（PATH 上的 shim、npx 的临时安装、直接 `node bin/difftab.js`），而 Windows 上 bin 靠的是 npm 生成的 `.cmd` / `.ps1` shim 而非 Unix 的可执行位，发布当天那条 `100644` 的坑在这里天然不成立。

**这条记录不留回归，这是它的性质决定的，不是遗漏**——弹窗与否 runner 断言不了，真机这一次补的只是最后一跳。

## 改名 gitglance → difftab（2026-08-20）

**不是重构，是一条被推翻的结论。** 文档从 2026-07-28 起记着「`gitglance` npm 未被占用」，两次复核也确实都返回 404，而那个判据从头到尾是错的——重名要按归一化后的名字查，依据见 [`decisions.md`](decisions.md)。**它不会在任何门禁里响，只会在第一次 `npm publish` 那一刻响**，而那时改名的成本比事先高得多。

改名面 242 处 / 62 个文件，其中只有三类不是机械替换：两条结论本身要重写、围绕旧名写的英文双关文案（换名后是病句）、以及 `README.zh-CN.md`（**它不是自动生成的**，只改英文那份不会有任何门禁变红）。产品行为零变化。

## 加页面内的明暗开关（2026-08-30）

**又一条被推翻的结论。** `design/style.md` 原先写着「首版不做页面内的明暗手动开关：那需要为 hljs 主题 CSS 在构建期加作用域前缀，与『轻量优先』的取向不符」——**理由本身没错，错在它把「给上游 CSS 加前缀」当成了唯一的实现路径**。把那两份主题合成我们自己的一份、色值写成 `light-dark()`，同一个效果不需要任何构建期机器（CSS 体积净增 922 B，预算里还剩 9.7 KB）。这条不会在任何门禁里响，只会在有人真想要这个开关的那天响。

- **真正被替换掉的是深色的表达方式**，不是加了个按钮：`@media (prefers-color-scheme: dark)` 里那份 19 条的 delta 整块没了，深浅合进 `@theme` 的单条 `light-dark()`。旧写法在有手动档之后必然双写，而双写的两份漏一处不报错。
- **`check:css` 的两条断言跟着反转**：原先查「深色媒体条件里声明的 token 在浅色侧都得有」，现在查「任何 `--color-*` / `--hljs-*` 都不许声明在深色媒体条件里」。**门禁改的是同一处静默故障的新形状，不是放松**。
- **实现期唯一的意外来自 Lightning CSS**：它把 `light-dark()` 降级成 space-toggle 变量对，产物里搜不到那个函数名——好消息是它**逐选择器**跟踪 `color-scheme`，`[data-theme]` 那两条照样被翻译，手动档在老浏览器上也成立；坏消息是双值 token 从此不能套不透明度修饰符。两件都记在 [`decisions.md`](decisions.md) 的「样式层叠」。
- **hljs 那 15 个 token 的色值是抄进仓库的**，此后不随 highlight.js 升级。门禁只证明「都走了 `var()`」，色值抄没抄对只能靠人逐条对——这是这次改动里唯一没有自动化兜底的地方。
