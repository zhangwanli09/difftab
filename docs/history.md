# 记录：未完事项、真机验收与被推翻的结论

> **本文是记录，不是约束。** 约束在 `AGENTS.md`（红线与必读路由）、[`design/`](design/) 与 [`decisions/`](decisions/)（被排除的做法）；需求与设计见 [`README.md`](README.md) 的索引。已收口的 0→1 开发阶段记录不在这里，在 git history。**发布不逐版记录**：变更日志是 release-please 生成的 `CHANGELOG.md`，发版时新撞上的坑直接补进 [`../RELEASING.md`](../RELEASING.md)；0.1.0–0.5.3 的逐版日志已删，要查翻 git history。

## 未完事项

**两件都在 CI 之外，都不阻塞发布，都等首个真实 Linux 桌面**（口径见 [`gates.md`](gates.md) 的「真机」一节）：

1. **浏览器在 Linux 桌面上真的弹出来。** runner 没有桌面会话，`xdg-open` 的选择与 argv 已由单测与只读单点断言每次推送重跑，真机要补的是「argv 对了之后系统真的响应」这最后一跳。
2. **token 经命令行的窗口在 `xdg-open` 下有多宽**（机制见 [`design/server.md`](design/server.md) 的「已知边界」）。`xdg-open` 是脚本、`/proc/<pid>/cmdline` 默认全局可读，预计比 macOS 大。**刻意不进 CI**——headless 上 `xdg-open` 立刻失败退出，量出来的窗口比真实桌面上短得多，**是个会让人放心的假数**。

**Windows 那半已于 2026-08-22 在真机桌面上验过**，见下。

另有一件与平台无关、2026-09-11 在做变更列表的树视图时发现的：

3. **`localStorage` 里的偏好跨不了实例。** 后端 `listen(0)` 每次启动端口随机，而 `localStorage` 按 origin（含端口）隔离——`difftab:theme` 写着「跨会话保持」，实际只活到同一实例的刷新，换一次 `difftab` 启动就归零。**没有任何门禁看得见**（`theme.test.ts` 跑在同一个 happy-dom origin 里）。可选的修法各有代价：固定端口（与「随机端口 + token」的安全取向相抵，且单实例注册表按仓库分的正是端口）、把偏好搬到后端按用户存（后端要多一个写端点，而它此刻零写操作）、`sessionUrl` 带一段 hash 让页面自己去读父 origin（不存在这种机制）。**先记着不动**；主题之外的页面状态因此一律不进 `localStorage`。

## Windows 真机验收（2026-08-22）

在 Windows 真机桌面上，`cmd /c start ""` 确实把默认浏览器拉了起来；同一轮里顺带看了变更展示、改文件后的自动刷新、以及关掉标签页后进程按空闲自动退出，均正常。**全局安装 / `npx` / 本地构建产物三种形态各跑一遍**——这三条路走的是同一段拉起浏览器的代码，但装法不同（PATH 上的 shim、npx 的临时安装、直接 `node bin/difftab.js`），而 Windows 上 bin 靠的是 npm 生成的 `.cmd` / `.ps1` shim 而非 Unix 的可执行位，发布当天那条 `100644` 的坑在这里天然不成立。

**这条记录不留回归，这是它的性质决定的，不是遗漏**——弹窗与否 runner 断言不了，真机这一次补的只是最后一跳。

## 改名 gitglance → difftab（2026-08-20）

**一条被推翻的结论。** 文档从 2026-07-28 起记着「`gitglance` npm 未被占用」，两次复核都返回 404，而那个判据从头到尾是错的——重名要按归一化后的名字查（依据见 [`decisions/toolchain.md`](decisions/toolchain.md)）。它不会在任何门禁里响，只会在第一次 `npm publish` 那一刻响。产品行为零变化。

## 加页面内的明暗开关（2026-08-30）

**又一条被推翻的结论。** `design/style.md` 原先写着「首版不做页面内的明暗手动开关：那需要为 hljs 主题 CSS 在构建期加作用域前缀」——**理由本身没错，错在它把「给上游 CSS 加前缀」当成了唯一的实现路径**。把两份上游主题合成我们自己的一份、色值写成 `light-dark()`，同一个效果不需要任何构建期机器。由此沉淀的规则与代价（深色不许写回媒体查询、双值 token 不能套不透明度修饰符、hljs 色值抄进仓库后无自动化兜底）在 [`design/style.md`](design/style.md)，实测在 [`decisions/style.md`](decisions/style.md)。
