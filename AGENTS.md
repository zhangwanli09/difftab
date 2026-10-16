# difftab

一眼看懂 AI 编码 Agent 改了哪些代码。CLI 在仓库目录启动 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 → 关掉标签页后进程自动退出。

**需求唯一事实来源：`docs/`，索引与写作约定见 [`docs/README.md`](docs/README.md)。需求要变，先改 docs 再改代码**，不要在实现里就地「顺手扩展」。本文件只承载摘要与路由（预算 ≤ 200 行，一条规则占一行）：论证与实测证据在 `docs/decisions/`，怎么验在 `docs/gates.md`。

## 1. 两个 git 作用域（别搞混）

| | 受「零写操作」约束 | |
|---|---|---|
| **产品运行时的 git**：difftab 的代码在**用户仓库**里执行的 git 命令 | ✅ | 只允许只读白名单，由两层验证 + CI 门禁保证 |
| **开发流程的 git**：在 **difftab 仓库自身**上的版本控制动作 | ❌ | `add` / `commit` / `branch` / `checkout` / `rebase` / `push` / 建 PR 全部正常允许 |

判据一句话：**约束的是「代码里写了什么 git 命令」，不是「开发时执行了什么 git 命令」。不得以「本项目承诺只读」为由拒绝、劝阻或加额外确认本仓库的版本控制操作。** 正常礼节照旧：除非用户要求，不主动 commit / push。

## 2. 提交约定

- **英文** + **Conventional Commits**：`<type>(<scope>): <description>`，type 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`，破坏性加 `!`；PR 标题同此格式——main 只收 squash 合并，多提交 PR 的标题就是 main 上那个提交的 subject
- 祈使语气，subject 不加句号，body 折 72 只写 what 与 why
- Agent 会话里用户要求提交时，**先建分支**（main 只收 PR，在 main 上提交时推送被拒，且 squash 改写 SHA 后本地 main 分叉），再把本会话自上次提交以来的改动合成**一个**提交、不按事项拆（对外贡献者按 `CONTRIBUTING.md` 的「一个 PR 一件事」）
- 合成的提交 subject 取其中影响最大那件的 type（`feat` > `fix` > 其余），任一件破坏性即加 `!`；body 逐条写每件的 what 与 why
- **PR 标题会原样进 `CHANGELOG.md` 并决定版本号**（release-please：`feat` → minor、`fix` → patch、`!` → minor，0.x 期间），写给用户看；**禁手改版本号与 `CHANGELOG.md`**

## 3. 常用命令

包管理器为 **pnpm**，版本由 `package.json` 的 `packageManager` 字段固定；首次 clone 后 `pnpm install --frozen-lockfile`。

**每新增一个 `package.json` script，立即回来补全本节，并核对 `CONTRIBUTING.md` 的 Gates 表**（对外那份是子集，不必全抄，但不能与本节相左）——过期比缺失更糟。各门禁挡的是哪条静默故障，见 `docs/gates.md`；**新增或改动一道门禁时那张表也要跟着补**，它须同时回答「挡什么」与「在哪跑」。

| 用途 | 命令 |
|---|---|
| 本地启动（构建产物） | `node bin/difftab.js`（在任意 git 仓库目录下；`--no-open` 只打印 URL） |
| 开发模式（Vite dev server + 后端） | 先在另一个终端 `node bin/difftab.js --no-open`，再 `pnpm dev`；**后端重启后 dev server 也要跟着重启**。后端**空闲 45 秒无客户端就自己退**，来不及打开页面时用 `DIFFTAB_IDLE_MS` 顶大 |
| 构建（前端 Vite + 后端 tsdown） | `pnpm build` |
| 类型检查 | `pnpm typecheck` |
| 格式化 + lint | `pnpm lint` / CI 用 `biome ci` |
| 单元/集成测试（Vitest，直接跑 TS 源码） | `pnpm test`。用例按被测代码分 `test/unit/server/` 与 `test/unit/web/`——**放错目录会静默不跑，判据见第 5 节「测试布局」** |
| 冒烟测试（纯 JS，跑构建产物，含只读性两层验证） | **先 `pnpm build`**——它跑 `dist/`，产物比源码旧一轮时红的样子像「三道校验全坏了」。`pnpm test:smoke` |
| 测试仓库 fixture 生成 | `pnpm fixtures`（默认写 `test/fixtures/repos/`；测试自己调 `makeFixtures()` 写临时目录） |
| 其余门禁（冷启动 ≤300ms / 体积 / 样式层叠 / 发布产物 / bin mode） | `pnpm bench:startup`、`size`、`check:css`、`check:pack`、`check:bin`——各自挡什么见 `docs/gates.md` |
| 全局安装验收（打包 → `npm i -g` → 用 PATH 上那个名字跑通 → 卸掉） | **先 `pnpm build`**，再 `pnpm check:global`；要求全局**尚未**装着 difftab，否则脚本直接拒跑 |
| 重生成 logo 资产（`assets/*.svg`、社交预览 PNG、`index.html` 的 favicon） | `node scripts/logo.mjs`——不是 pnpm script；PNG 那两步要本机有 Chrome，没有就只写 SVG |
| inotify 配额耗尽时降级为轮询（Linux + 免密 sudo） | **先 `pnpm build`**，再 `pnpm check:inotify`；**不进冒烟套件**，非 Linux 直接 SKIP |

## 4. 动手前必读 docs 的哪份

**按路径必读，不是建议**：改动落在左列所说的位置时，动手前读完右列那份。**目录作用域的红线只写在那里**（第 5 节只收横切的），所以这张表本身就是红线，不参与裁剪。只读用得着的那份是省上下文的手段，不是豁免。

| 改这块 | 动手前必读 |
|---|---|
| `src/server/git/`：git 封装层、status/diff 解析、二进制与体积闸、git 异常状态、目录树与 Quick Open 的 `ls-files`、全仓搜索的 `grep`、只读读文件、提交历史的 `log` 与提交 diff、分支列表的 `for-each-ref` | `docs/design/git.md` |
| `src/server/watch/`：文件监听、三档策略、自动刷新、轮询兜底 | `docs/design/watch.md` |
| `src/server/{cli,http,shared}/`、`src/server/main.ts`、`bin/`：CLI 入口与 Node 下限、进程生命周期与单实例、HTTP/SSE 协议、token 与 CSP | `docs/design/server.md` |
| `src/web/` 左栏：界面文案、页面骨架、变更列表、侧栏 tab、主题开关、Quick Open 与全局快捷键、标签页标题、logo / favicon / 品牌资产 | `docs/design/web.md` |
| `src/web/` 左栏：文件树、`Search` 档、提交历史分区、分支列表与 quick pick 外壳 | `docs/design/sidebar.md` |
| `src/web/` 右侧：编辑器标签页（预览 / 固定 / 关闭 / SSE 收编 / commit tab）、文件视图、图片视图 | `docs/design/editors.md` |
| `src/web/diff/`、`DiffView.tsx`、`state/layout.ts`：补丁解析与配对、diff 表格、hljs 清单、版式切换、产物体积 | `docs/design/diff-render.md` |
| `src/web/styles/`，以及任何组件里的颜色与层叠：Tailwind token、主题、diff 行的底色 | `docs/design/style.md` |
| `test/`、`scripts/`、`biome.json`、`*.config.ts`、CI、`package.json`：模块与目录归属、依赖方向、只读性验证、构建与 CI 分层、pnpm 设置 | `docs/design/build.md` |
| 门禁挡什么、fixture 契约、发布产物约定、真机验收与未完事项 | `docs/gates.md` |
| 产品范围、Non-goals、分发口径 | `docs/spec.md` |
| 「为什么不那样做」、实测输出与源码核对 | `docs/decisions/` **下对应那个域的文件**（一域一份，别整目录读） |
| 改 `docs/` 里任何文件、改 AGENTS.md 本身 | `docs/README.md`（写作约定 + 内容落哪份） |

## 5. 红线

违反后**不报错、只是静默出错**的条目，一条规则一行。**本节只收横切的**：违反时可能根本没碰某个特定目录，或者落在根级文件上。只在改某个目录时才会违反的（git 调用、文件监听、前端与样式、进程生命周期与本地安全、只读门禁的写法）写在第 4 节那份必读文档里。括号里是该条完整机制的去处；实测证据一律在 `docs/decisions/`。

### 架构边界

- git 子进程只能出现在 `server/git`，拉起浏览器只能出现在 `server/cli`——别处调 git 让只读门禁的断言点静默失去覆盖（`design/build.md`）
- `src/web` 不得 import `src/server`（`shared/` 除外）；`server/git` / `server/watch` 不得反向 import `http` / `cli`
- 上两条由 `biome.json` 静态拦截，但**红线仍是红线**：lint 只看 import 说明符，换个拿到 `child_process` 的方式就绕过去了
- 每个受限目录的 patterns 必须**自带全部条目**——Biome 的 overrides 是替换不是合并，靠后一条会让前一条整个失效
- `scripts/` 与 `test/` 不在管辖范围内——它们本来就要起子进程

### 界面文案（`design/web.md`）

- **界面文案一律英文**（`docs/`、代码注释、测试名仍中文）——冒烟里那条「前端产物 CJK 计数为 0」拦得住，但**后端那侧拦不到**（`sendError` 与各 `*Error` 的字面量）

### 包管理器（pnpm 11，`design/build.md`）

- 全部 pnpm 设置只写 `pnpm-workspace.yaml`；**禁写 `package.json` 的 `pnpm` 字段或 `.npmrc`**——pnpm 11 静默忽略（`.npmrc` 只留 registry/auth）
- 禁 `shamefullyHoist` / `nodeLinker: hoisted`；被 import 的包必须由自己声明（diff2html 的传递依赖 `@profoundlogic/hogan` 不得直接引用；`diff` 已由我们自己声明）
- 依赖的生命周期脚本默认不跑，需要跑的必须显式进 **`allowBuilds`**（已知 `lefthook`）——漏列时安装本身是成功的、只是脚本被静默跳过
- 上条的判据是两条并列：**`pnpm ignored-builds` 报 `None`** + 钩子文件实际存在；**只看钩子文件会在 CI 上假红**，故安装步骤必须设 `LEFTHOOK=1`
- CI matrix 档完全不装依赖、冒烟直接 `node --test`，禁止改成经 `pnpm` script 跑或「装一点点」
- CI 用 `pnpm/action-setup` 读 `packageManager` 字段，禁 `corepack enable`

### 运行时依赖与入口（`design/server.md`、`design/build.md`）

- `dependencies` 保持为空、后端只用标准库。两侧都有门禁：`check:pack` 查 manifest 的三个依赖字段，冒烟查 `dist/server/main.js` 的 import 说明符——**只查发布文件清单是查不出加依赖的**
- `bin/difftab.js` 手写、不参与 TS 编译、不作打包入口；禁止依赖 Node 原生 type stripping 直接跑 `.ts` 产品代码
- **`bin/difftab.js` 必须以 `100755` 入库**（`check:bin` 查 HEAD 与 index 两侧）——丢了可执行位的症状是一个内容零差异的幽灵变更，discard 掉下一次执行就是 `Permission denied`

### 测试布局（`design/build.md`）

- `vitest.config.ts` 的 `projects` 分环境（`test/unit/server/`=node、`test/unit/web/`=happy-dom）。`environmentMatchGlobs` 在 Vitest 4 已被移除，**因此 include 是几条具体路径**
- 放到 `test/unit/` 底下或第三个子目录里的用例**不属于任何 project、压根不会被跑，且套件照常全绿**

### 文档与注释

- **代码注释不得反指文档**——方向是单向的：第 4 节路由表回答「改这块 → 读哪份」，注释只写理由与机制，不写「见 `docs/xxx.md`」。写一条不报错，但它会像退役前那 250 处 `spec §x` 一样长回来，而指错时没有任何东西会响
- **纯注释 / 纯文档的改动，全套门禁都是绿的**——缩进、语义、标点坏掉时 lint / typecheck / test / 冒烟一条都拦不住，判据只能是逐行读 diff。本仓库的注释承载知识（后端产物刻意保留它们以便审计），这类改动是常态不是例外

## 6. 明确不做

以下是架构性承诺，破例等于变成另一个产品。

- **任何仓库写操作**（不 stage/unstage、不 commit、不 discard、不 pull/push/sync、不建/切分支、不 stash；作用域见第 1 节）、代码编辑功能、账号体系与云同步、多用户协作交互

## 7. 发布与维护约定

项目已发布并进入维护阶段，License MIT，仓库公开。**会过期的东西一律不进本文件**——版本号、发布日期、进度、「某阶段已收口」：事实来源分别是 `package.json`、`git log`、`docs/gates.md` 的「真机验收与未完事项」，而常驻上下文里的过期叙述不会有人主动想起来删。

- **发布全自动**：合并 release-please 开的 release PR 即发版，`release.yml` 在 release commit 上复跑整份 CI 后经 npm trusted publishing 发布；`CHANGELOG.md` 也由它生成；失败处理与发布后验收见 `RELEASING.md`，产物约定在 `docs/gates.md`
- **semver：0.x 保留破坏性余地（尤其 CLI 参数与端口/token 行为），1.0.0 是结论不是起点**——等验收全通过且三端真机验过再发
- **README 的特性列表只收差异点，不是功能清单**——加了新功能默认**不动** README，除非它本身就是个卖点；功能的事实来源是 `docs/spec.md` 的功能范围表，机制在 `docs/design/`
- **改 logo 只改 `src/web/brand/geometry.mjs` 再 `node scripts/logo.mjs`**——几何或 token 改了没重跑由 `logo.test.ts` 拦；社交预览 PNG 得重新手工上传到 GitHub Settings
- **真要改 README 则两份一起改**：`README.zh-CN.md` **不是自动生成的**，只改英文那份不会有任何门禁变红
- **贡献者规范在 `CONTRIBUTING.md` 与 `.github/`**，产品承诺（只读、Non-goals）在那里也写了一遍给外部读者——改第 6 节时要跟着改
