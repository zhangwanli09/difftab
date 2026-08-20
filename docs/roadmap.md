# difftab — 实施阶段与开源规划(§7 / §8)

> 本文承载需求文档的 §7 与 §8,章节号沿用拆分前的编号,未重排。
> 文中形如 `5.7` 的引用指 [`design.md`](design.md) 的对应小节;索引见 [`docs/README.md`](README.md)。

## 7. 实施阶段

按下表顺序推进,每个阶段完成后对照 `acceptance.md` §6 中标记为本阶段的验收项自查。阶段划分的依据是依赖关系与验证时机,不是工作量。

**排期的一条总原则:门禁不得晚于它所保护的代码,方案前提不得晚于依赖该前提的实现。** `workflow.md` §9 的开发方式决定了这条原则比通常更重要——阶段边界既是工期划分,也是"哪条路此刻最短"的塑造手段,把校验或门禁排在后面,等于在前面的阶段里为绕过它留出最短路径。

| 阶段 | 内容 | 注意事项 |
|---|---|---|
| **S0** | 工具链脚手架:`package.json`(含 `engines` / `files` / scripts / `packageManager`)、`pnpm-lock.yaml`、`pnpm-workspace.yaml`(承载 `allowBuilds` 等全部 pnpm 设置)、`.gitignore`、**`bin/difftab.js`(手写定稿,见 5.1)**、Vite + tsdown 配置、两份 tsconfig、Biome、lefthook、冷启动测量脚本;**按 5.0 建立目录骨架与依赖方向断言规则**;CI 两层作业骨架,且 **matrix 层的三平台 × Node 22/24/26 即刻拉起**(初期跑占位冒烟即可) | 三项前提验证须在本阶段收口,见下方「S0 的三项前提验证」。matrix 提前拉起是为了让 Windows / Linux 回归从第一天起持续存在,而不是堆到 S5 一次性暴露。`bin/difftab.js` 放在 S0 是因为它不参与构建、内容不依赖后续阶段,而 `acceptance.md` §6 "未被构建管线触碰"这条验收项要成立,它必须在构建管线建立的同一阶段就已存在 |
| **S1** | CLI 脚手架 + HTTP server(**按 5.9 最终形态实现,含三道校验**)+ **注册表文件写入(port + token,`0o600` + `O_EXCL`)** + git shell 封装(status/diff)+ **5.12 协议类型随 server 一同定型** + **测试数据第一批** + **5.10 主门禁入 CI** | server 一建立即是最终形态,5.11 的 dev proxy 三道改写同期落地。**注册表的"写入"必须在本阶段**,否则 dev proxy 无 token 来源(见 5.11);"探活复用"与"空闲退出"留 S3c。**先做前端再补校验的顺序,会把"临时加环境变量放宽后端"变成本阶段内的最短路径,而那是 `decisions.md` §10 明令禁止的做法** |
| **S2a** | 前端骨架(Preact 挂载 + signals state)+ `/api/state` 接线 + 变更列表组件(三类文件,按 path keyed)+ 让列表可读的最小样式;**5.10 第二层(只读 `.git` 冒烟)在此建立并入 matrix 作业**;冒烟套件补齐到跑构建产物 | 只读第二层保护的是 **S1 已落地**的 git 封装层(`GIT_OPTIONAL_LOCKS=0`),按本节总原则它本就该排在 S2 开头而非末尾。样式只做"能看清列表"这一档,主题留 S2c |
| **S2b** | `/api/diff` 接线 + 深导入 `diff2html-ui-base` + hljs 22 语言与 `plaintext` 注册 + `draw()` 置于 Preact 的 ref/effect + 按文件懒加载联动 + 300+ 文件的性能验证;`app.css` 按 5.6 的顺序引入渲染所需 CSS(hljs 双主题 + `diff2html.min.css`,unlayered) | 高亮要出颜色就必须先有 hljs 主题 CSS,故 CSS 的 `@import` 骨架归本阶段、主题 token 归 S2c。5.5 那三条"静默出错"约束(`draw()` 后不得补调 `highlightCode()`、`plaintext` 必须注册、别名不是模块)全部落在本阶段。**入场时先确认体积门禁不再空转**:S2a 删掉 S0 spike 后没有任何入口 import `diff/`,产物 JS 从 196 KB 掉到 23.5 KB,两条 JS 预算因此暂时对着一个不含 diff2html / hljs 的产物通过;S0 那三项前提验证所量的东西要到本阶段接回渲染路径才重新被产物覆盖 |
| **S2c** | Tailwind `@theme` 承载 VS Code token + `vscode-theme.css` 覆写 `--d2h-*` + 深浅两套主题 | 收口时实测并回填 5.5 的产物体积表;观感类验收项要压在 S2b 真实渲染出的 DOM 上才验得了,故排在其后 |
| **S3a** | 分支状态展示(只读) | — |
| **S3b1** | SSE 通道:端点 + 15s 心跳 + 前端 `EventSource` + `visibilitychange` 重连 + `.git` 目录级**非递归** watch + debounce + `WatchState` 接真实取值 | **首个交付物是"三档强制指定的内部环境变量"**——没有它,S3b2 所有档位的验收项在单机上都无从自查 |
| **S3b2** | 工作区监听:A 档 `ignore` 逐段函数 / B 档回调最前面过滤 / C 档 1.5s 轮询 + 通用轮询兜底 + UI 降级标注(5.7) | 轮询必须复用 5.7 写明的那条逐字相同的 status 命令。本阶段的六条验收项均带 `/S5`,单机只能验到能验的那半,余下留 S5 真机 |
| **S3c** | 进程生命周期:启动时读注册表并对已记录端口做 **HTTP 探活**、命中则复用已有实例;空闲 45 秒退出 + 退出时清理注册表(5.8) | 注册表文件的**写入**已在 S1(见该行);本阶段补的是**消费**它的那一半 |
| **S4a** | Diff 边界情况:未跟踪文件/新文件/删除/重命名标注/二进制/超大文件 + `DiffPayload` 的 `binary` / `too-large` 分支填充与前端渲染 + **测试数据第二批中 diff 相关的部分** | 重命名标注要靠 5.2 的双路径调用;未跟踪那条路的 `lstat` 与仓库边界校验在 S1 已落地,本阶段是把它接到前端 |
| **S4b** | git 异常状态:空仓库、detached HEAD、rebase 进行中、linked worktree、bare + `BranchState.operation` 填充与前端降级标注 + **测试数据第二批余下部分** | 5.3 的 SHA-256 空树常量在本阶段实测回填 |
| **S5** | Windows / Linux 跨平台验证 + 安全**加固自查**(端口选择、token 熵、CSP 实测生效、错误信息不泄漏绝对路径) | 安全**实现**已在 S1,本阶段只做渗透式复核(已完成,见 `decisions.md` §10)。跨平台那半按 `acceptance.md` §6 开头的**「真机」口径**做:能写成断言的进 CI 的 windows / ubuntu runner,剩下的只有"浏览器真的弹出来"与肉眼观感两类。原先那句"CI 跑通不等于可用"针对的是**当时的** CI 覆盖面(只跑冒烟,监听、配额、全局安装一条都没断言),不是"CI 的机器不算真机" |
| **S6** | 开源准备(见 §8) | — |

**全部子阶段(S2a → S2b → S2c、S3a → S3b1 → S3b2 → S3c、S4a → S4b)按序逐个收口,不得并行推进**。S3 那三件事的理由是互相独立、合并推进时任一处的故障会被另外两处的噪声掩盖;其余子阶段的理由见下条。

**S2 / S3b / S4 为什么拆成子阶段**——依据是 `workflow.md` §9 的开发方式,不是工作量:

- **原 S2 一个阶段挂了 12 条验收项**(S3b 8 条、S4 5 条,而 S3a 只有 1 条、S3c 3 条),且同时压着四件性质不同的事:前端从零、diff2html 渲染、样式层叠、两道门禁收口。按 `workflow.md` §9 的开发方式,一个阶段基本对应一个会话,而这样的阶段跑不完一个会话——S1 的实际形态已经印证:单次提交 3126 行 / 31 文件,之后仍跟了两个修复提交
- **真正的代价不是"做不完",是上下文被压缩后失去的东西**。`CLAUDE.md` 每轮无条件重载,所以红线**条目**能活下来;但 `decisions.md` §10 的失效机制与实测证据活不下来。而 S2 要踩的几条恰恰全是"违反后不报错、只是静默出错":`draw()` 后重复调 `highlightCode()`、漏注册 `plaintext`、CSS 进 `@layer`、用 Tailwind 工具类压 `--d2h-*`——**这四条测试和 CI 都不会红**,压缩后既无从自查、也无门禁兜底
- 因此拆分的切口选在**"读哪几节 spec"发生跃迁的地方**:S2a 读 5.0/5.4/5.12/5.10,S2b 读 5.5/5.2,S2c 读 5.6/5.5 体积表——三者几乎不重叠,单会话的 spec 读入从整篇 47k tok 降到 20k 上下。`CLAUDE.md` 里那张「做哪个阶段 → 本会话必读哪几节」的表当时就是这条切口的落地形式(该表已随文档拆分删去,切口备查于 `docs/journal.md`)
- S0 / S1(已收口)与 S3a / S3c / S5 / S6 验收项少、读入面窄,不拆

**S0 的三项前提验证**——每一项都是某个方案能否成立的前提而非既定事实,任一项不通过都在 S0 内改方案,不带进后续阶段。**三项一律在 pnpm 的严格 node_modules 布局下执行**(见 5.11):在 npm 扁平布局下通过、换到严格布局才 resolve 失败,是这类 spike 最典型的假绿。

1. `@import "tailwindcss"` 在 Tailwind v4 构建期展开后,后续 `@import` 的内容确实保持 unlayered(5.6)。不通过则改用不引 preflight + 自写最小 reset 的备选方案
2. 深导入 `diff2html/lib-esm/ui/js/diff2html-ui-base.js` 能被 Rolldown 正确 tree-shake、hljs 实例可注入、`highlightCode()` 实际出颜色(5.5)。不通过则 S2b 的整条渲染路径需重做,必须在编码开始前暴露
3. 22 个语言模块 + diff2html + hogan + jsdiff + preact 打包后的明文 / gzip 体积实测,对照 5.5 的预算。**超预算即在 S0 砍语言清单**——5.5 已写明"第一刀砍语言清单",那一刀应当落在 S2b 编码之前,而不是之后

**门禁与测试数据的建立时机**:

- **5.10 主门禁(`GIT_TRACE` 白名单断言)在 S1 与 git 封装层同阶段建立**。封装层只有一处子进程调用,断言成本极低;而它是 4.1 "零写操作"承诺在开发期唯一的自动化护栏,晚一个阶段就多一个阶段没有护栏
- **5.10 第二层(`.git` 不被写入的冒烟)在 S2a 建立并入 matrix 作业**——它保护的是 S1 就已落地的 git 封装层(`GIT_OPTIONAL_LOCKS=0`),按本节总原则不该拖到 S2 末尾。需一并明确 **Windows 上 A 半改用只读 ACL 或显式跳过**——`chmod -R a-w` 在 Windows 无等价语义,照搬会让 matrix 的 Windows 档假绿;而 A 半即便在 POSIX 上也只覆盖"会报错的写",B 半的逐字节比对才是漏设 `GIT_OPTIONAL_LOCKS=0` 唯一看得见的地方(见 5.10)
- **测试数据分两批**。生成脚本对测试仓库执行 `git init` 等写操作,属开发流程的 git,不受 4.1 约束(作用域见 `CLAUDE.md` 第 1 节):
  - **第一批(S1)——决定解析器结构,不是边界修补**:路径含非 ASCII 字符/空格/引号的文件、重命名(含相似度识别阈值边界)、已暂存改动(执行过 `git add`)、无上游的新建分支、空仓库(`git init` 后无提交)。这五项分别决定 5.2 的 `-z` 与 `core.quotePath=false` 是否真的生效、解析循环是有状态还是无状态平铺、`# branch.ab` 缺失的降级路径、以及 5.3 的 diff 基准该做成怎样的接口形状——S4 才引入等于 S1 先按 HEAD 写死再返工。另需一个 300+ 文件变更的仓库,S2b 验收懒加载时即需就位
  - **另需一个整目录未跟踪的样本**(2026-08-09 补):这是 `-uall` **唯一能被证伪**的形态。上面那批未跟踪文件都落在已被跟踪的目录里,折不折叠长得一样;只有当整个目录都未跟踪时,缺 `-uall` 才会把它折成一行 `? dir/`(已实测),而那正是 5.2 那条红线要防的东西——agent 新建一整个目录是最常见的形态之一,折叠后列表里只剩一个点不开的目录条目
  - **删除与未跟踪符号链接从第二批上调到第一批**(2026-08-08 修订,起因见下)。判据始终是"是否决定结构",而这两项都决定 5.2 里**取 diff 前那次分流**——即"已跟踪走 `git diff`,未跟踪读磁盘"这个二选一本身:
    - **已暂存的删除**(`git rm` 之后):路径已从 index 里摘掉,`git ls-files` 输出为空(已实测),但 status 照报 `1 D.`、基准侧也还在。用 `ls-files` 当分流判据会把它误判成未跟踪、进而去读一个不存在的文件。"已跟踪"的正确定义是 **HEAD ∪ index**,不是 index——这是判据的定义问题,不是边界修补
    - **未跟踪的符号链接**:`git status -uall` 把它报成 `? <链接>`(已实测),于是它进变更列表、点得到。读磁盘那条路必须用 `lstat` 而非 `stat`,否则 5.2 的仓库边界校验形同虚设——校验的是链接自身的路径,读到的却是链接目标,一个指向仓库外的链接就能让接口把仓库外的文件内容当作新增文件返回。fixture 里的链接**故意指向仓库外一个内容已知的文件**,断言补丁里不含该内容
  - **第二批——边界与异常**,按子阶段分两次就位:**S4a** 要新增文件、二进制文件变更、超过 5MB 的大文件;**S4b** 要 detached HEAD、rebase 进行中、linked worktree、bare 仓库,以及 5.3 的 SHA-256 空树常量所需的 `git init --object-format=sha256` 仓库

两批均逐项对照 `acceptance.md` §6 验收标准验证。

## 8. 开源规划

- **License**:MIT。运行时依赖 diff2html 为 MIT、highlight.js 为 BSD-3-Clause,均兼容
- **仓库/包名**:`difftab`(**2026-08-20 由 `gitglance` 改定**——npm 的重名校验把包名小写化并去掉 `-` `_` `.` 后再与已有包比对,`gitglance` 归一后与他人已占用的 `git-glance` v1.0.1 完全相同,`GET /gitglance` 虽然一直返回 404,发布时仍会被 registry 以 "too similar to existing package" 拒绝;此前 2026-07-28 与 2026-08-19 两次复核只查了精确名,故一直判成"仅影响搜索时的混淆",判据与四个归一变体的核验见 `decisions.md` §10。GitHub 仓库名随之改为 `zhangwanli09/difftab`)
- **需要补的东西**(S6 已落地,括号里是去处):README(`README.md` 英文 + `README.zh-CN.md` 中文,两份互链;**译文不是自动生成的,改一份要手动改另一份**)、LICENSE 文件(S0 即有)、清理硬编码的个人路径/凭据(全仓扫过,只有 `registry.ts` 注释里一个 Windows 路径示例)、Issue/PR 规范(`.github/ISSUE_TEMPLATE/` 两个表单 + `.github/PULL_REQUEST_TEMPLATE.md` + `CONTRIBUTING.md`)、semver + GitHub Releases(`RELEASING.md`)
- **README 的语言与界面的语言是两件事,S6 把它们对齐了**:`docs/` 与代码注释写给维护者,中文;而产品表面(CLI 的 `--help` / 退出提示 / 版本守卫报错)从 S1 起就是英文,界面文案却是中文——这不是"还没翻",是同一个表面上的一处不一致。S6 把界面文案改成英文(约 30 条,判据与术语表见 `design.md` §5.4,并配了一条「前端产物 CJK 计数为 0」的冒烟门禁),中文读者由 `README.zh-CN.md` 承接;语言切换归 `spec.md` §4.2 首版不做
- **不建 `CHANGELOG.md`**:GitHub Releases 的 notes 就是变更日志。两处写同一份清单,等于多一个会忘的地方——而首版发布频率低,自动生成也不划算
- **发布产物约定**:`package.json` 的 `files` 字段白名单为 `bin/`、`dist/`、README(含 `README.<lang>.md` 译文)、LICENSE;`prepublishOnly` 执行完整构建;发布前用 `pnpm pack --dry-run --json` 核对产物内容,确认不含 `src/`、配置文件与测试(验收见 `acceptance.md` §6)。前端依赖(diff2html / highlight.js / preact)在构建期即被打进 `dist/web/app.js`,后端只用 Node 标准库,因此 **`dependencies` 为空**——用户 `npm i -g` 时零传递依赖安装,应在 README 中说明。**注意 `files` 不是一份完整的白名单**:npm / pnpm 无条件把根目录下所有 `README*` 打进 tarball(2026-08-19 实测,见 `decisions.md` §10),门禁查的是 pack 的实际输出而不是 `files` 字段,所以这类偏差抓得到
- **发布目标与发布分支各要一条显式设置,两条都实测过(见 `decisions.md` §10)**:`package.json` 的 `publishConfig.registry` 钉住 `registry.npmjs.org`——开发机的全局 `~/.npmrc` 可能指向镜像源,不钉住就会发错地方,而 `pnpm publish` 打印的 `📦 name@version → <registry>` 那一行就是判据(**判据比前提耐用**:本机 2026-08-19 时指向 npmmirror、2026-08-20 发布时已改指 npmjs,而那一行照旧管用);`pnpm-workspace.yaml` 的 `publishBranch: main`——pnpm 自己的默认值是 `master`。前者是 npm 的 manifest 字段、不受"pnpm 设置只写 `pnpm-workspace.yaml`"约束,后者是 pnpm 设置、必须写在那里
- **`pnpm publish` 与 `npm publish` 的差异**(均已实测,见 `decisions.md` §10):pnpm 默认会做 git 检查(工作区必须干净、分支需匹配),这层检查有价值、**不要用 `--no-git-checks` 关掉**;`prepublishOnly` **确实会被执行**,上一条不会落空。另注意 pnpm 打包时默认做 **manifest obfuscation**——会从发布出去的 `package.json` 里剥掉 `packageManager` 字段与 publish 生命周期脚本。这对本项目是想要的(用户侧不该看到我们的开发期工具链),**不要用 `--skip-manifest-obfuscation` 关掉**,但核对产物时要知道打出来的 `package.json` 本就与仓库里的不同,别误判为产物不干净
- **版本号约定**:首个 npm 发布版本为 **0.1.0**(**2026-08-20 已发布**,过程见 `journal.md` 顶部一节)。在 0.x 阶段保留破坏性调整的余地(尤其是 CLI 参数与端口/token 行为),待 `acceptance.md` §6 验收标准**全部**通过、且三端真机验证完毕后再发 **1.0.0**。不要为了"看起来正式"直接从 1.0.0 起步——本工具的核心承诺是只读与零副作用,1.0.0 应当是这些承诺被 5.10 两层验证覆盖之后的结果,而不是起点
- **平台支持**:正式支持 macOS / Windows / Linux 三端,均需测试保证可用。用 GitHub Actions 三端 runner 跑测试,并在每个平台上做人工验证。CI 版本矩阵 **Node 22 / 24 / 26** × 三平台(22 这档同时覆盖 5.7 的 B 档与 C 档);`package.json` 的 `engines.node` 声明为 `>=22.0.0`

