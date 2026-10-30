# 工具链与发布

> 收录规则与实测环境见 [`README.md`](README.md)。

- **CI 拆成 build / matrix 两层，是因为工具链的 Node 要求高于产品运行时下限 22.0.0**（npm registry 实测）：`tsdown` 的 engines 为 `^22.18.0 || >=24.11.0`、`vite` 为 `^20.19.0 || >=22.12.0`。
- **Vitest 4 在 Node ≥ 25 上装不上 happy-dom 的 `localStorage`**（Node 26.13.0 / Vitest 4.1.10 实测，并核对 4.1.12 与 5.0.5 的产物源码）：Node 25 起 `globalThis.localStorage` 是一个不可枚举的 getter，没给 `--localstorage-file` 时返回 `undefined` 并打一条 ExperimentalWarning。Vitest 4 的 `getWindowKeys` 对「`k in global` 为真」的键只放行它内置 KEYS 清单里的，而清单里没有 `localStorage`，于是全局上留着的是 Node 那个 `undefined`：`sidebar.test.tsx` 与 `theme.test.ts` 共 18 条以 `Cannot read properties of undefined (reading 'clear')` 失败。4 线最新的 4.1.12 未修；5.0 把 `localStorage` 加进清单，并改为保存描述符而不是取值，以免触发 Node 那个 getter 的警告。**CI 当时是绿的**：build 作业还钉在 Node 24，只有装了 26 LTS 的本机红。
- **两条与打包有关的入口形态**（npm registry 实测）：`highlight.js` 的 `exports` 把 `./lib/core`、`./lib/languages/*` 映射到 ESM（`es/`），`./styles/*` 亦已导出；`@profoundlogic/hogan` 只有 CJS 入口（`main`，无 `module` / `exports`），需打包器的 CJS 互操作。
- **冷启动与首屏都在预算的十几分之一**：node 启动 + `http.listen` + 一次 `git status --porcelain=v2 --branch -uall -z` 全程约 **30ms 墙钟**，对 300ms 预算充裕；浏览器侧 `/api/state` 在 **47ms** 返回，`first-contentful-paint` **56–72ms**（三次刷新）。
- **npm 的重名判据是归一化后的名字，不是精确名**：npm 把包名小写化并去掉 `-` `_` `.` 再与已有包比对，因此 `GET /<名字>` 返回 404 **查不出重名**——原定的 `gitglance` 正是这样与他人已占用的 `git-glance` 归一同名，会在发布那一刻被 registry 以 “too similar to existing package” 拒绝。去掉 `git` 前缀同时避开了 Git 商标政策对「以 git 开头命名软件」的建议。
- **`bin/difftab.js` 的可执行位只能钉在仓库记的 mode 上**（macOS 实测）：在**本仓库目录里**跑 `npx difftab` 时，npm exec 认出 cwd 的 `package.json` 自己就叫 `difftab`、带同名 `bin`，于是不去 registry 取包而是建一条 `file:<仓库路径>` 依赖，npm 的 `bin-links` / `fixBin` 随即把 bin 目标 `chmod 0755`——**被改的就是工作区里那个真文件**。而 registry 上的 tarball 里恒为 `-rwxr-xr-x`（pnpm pack 把 bin 归一），CI 每次全新 checkout 也不保留本地 chmod：**三条已有路径对这件事全部免疫**。另：`git ls-files -s` 对未跟踪路径是 exit 0 + 空 stdout，故「拿不到记录一律 FAIL」。
- **按 pnpm 11 而非 10 落地，因为 11 的破坏性变更恰好全部打在配置面上**（就 pnpm 11 实测 + 官方迁移文档复核）：
  - **配置面**：`onlyBuiltDependencies` 与 `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile` / `ignoreDepScripts` 一并合并为单一的 **`allowBuilds`** map（`{ 包名: true | false }`）；配置不再读 `package.json` 的 `pnpm` 字段、也不再把 `.npmrc` 当通用设置文件（只留 registry 与鉴权），一律走 `pnpm-workspace.yaml`，原 kebab-case 键改 camelCase。**写错位置不报错、无 deprecation 警告，只是设置静默不生效**。
  - **因此每条设置都要一次正面对照**：当年的 `publishBranch: main` 是这么验的——它直接过检查并打印 `📦 name@version → <registry>`，改成 `release` 后同一条命令停在分支确认上，**即那个 camelCase 键确实被读到了**。没有对照时「没报错」与「设置生效了」长得一模一样。
  - **`pnpm publish` 不再委托 npm CLI**（`login` / `view` 等同理），于是它**不认 npm 的登录态**，而那时的报错完全不像认证问题：`npm whoami` 有回应、`~/.npmrc` 里有 `_authToken`，`pnpm publish` 仍回 `[E404] 404 Not Found - PUT …`——**npm 对「不允许的写」在包还不存在时回 404 而不是 403**。判据是 `pnpm whoami`；补 `pnpm login` 之后错误换成 `ERR_PNPM_OTP_NON_INTERACTIVE`，那条才说实话。它另自带 git 检查、照常执行 `prepublishOnly`，2FA 为 `auth-and-writes` 时无法非交互跑。
  - **manifest obfuscation 的实测范围比想象的窄**：剥掉的只有 `packageManager` 与 `prepublishOnly` 两项，其余 `scripts` 与整份 `devDependencies` 原样发布。现在改由 `npm publish` 发，这两项会随包发出——无害，用户侧不读它们。
- **升到 pnpm 12 时，`ignored-builds` 判据和 `pnpm/action-setup@v6` 都得换**（pnpm 12.16.1 与 11.20.0 在全新 clone 上对照实测，macOS 27 / Node 26.13.0，2026 年 10 月）：
  - **零忽略时两版答得不一样**：11.20.0 往 `node_modules/.modules.yaml` 写 `"ignoredBuilds": []`，`pnpm ignored-builds` 答 `None`；12.16.1 干脆不写这个键，命令答 `Cannot identify as no node_modules found`——`node_modules` 明明在。删掉 `allowBuilds` 里的 lefthook 一项时，两版都正确列出 `lefthook`，所以只有正常情况下才是假红。
  - **漏列时 install 本身就失败**：上面那个删掉 lefthook 的对照里，11.20.0 与 12.16.1 都以 exit 1 结束（`Ignored build scripts: lefthook@…`），有没有 `CI` 都一样。原因是 `strictDepBuilds` 默认 `true`；「漏列时安装照常成功」是更早版本的行为。
  - **写错位置的设置只管住了一半**：`pnpm-workspace.yaml` 里拼错的键（`strictDepBuild`）exit 1，报 `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` 并给出拼写建议；`package.json` 的 `pnpm` 字段与 `.npmrc` 里的 `strict-dep-builds=false` 照样 exit 0，没有任何提示。
  - **`pnpm/action-setup` 的浮动标签 `v6` 与 `v6.0.10` 解析到同一个 commit**（GitHub API 实测），而 pnpm 12 的支持是 v6.1.0 才加的（pnpm/action-setup#288）；标签没跟上的问题在 #289，提出时尚未关闭。**它的 README 写明只支持到 pnpm 12**，后继是 `pnpm/setup`（只装 pnpm 11+ 的原生二进制，可顺带装 Node、默认自己跑 `pnpm install`）——升 pnpm 13 之前要先换掉它。
  - **Corepack 0.36.0 能跑 pnpm 12**（`corepack pnpm@12.16.1 --version` 下载 darwin-arm64 原生二进制后答 `12.16.1`）：给 Corepack 补 pnpm 12 支持的 nodejs/corepack#887 是关掉没合的，pnpm 那侧自己做了兼容。不用 Corepack 的理由仍只是它不再随 Node 分发。
- **发布由 release-please + npm trusted publishing 承担**（`.github/workflows/release.yml`）：合并 release PR 即打 tag、建 Release、写 `CHANGELOG.md`，再复跑整份 `ci.yml` 后经 OIDC 发布，无 token、无 OTP。**复跑不能省**：release PR 由 `GITHUB_TOKEN` 创建，GitHub 不为它触发 `pull_request` workflow，那份 PR 上一个检查都没有；不复跑时三平台冒烟对要发出去的 commit 一次都没跑过。用 `npm publish` 是因为 trusted publishing 走 npm CLI（≥ 11.5.1），而 pnpm 不委托 npm、拿不到这层鉴权。

## 被排除的做法

| 做法 | 排除原因 |
|---|---|
| 用 tarball 里的 bin mode（`check:pack` / `check:global` 那两道）来保证可执行位 | pnpm pack 无条件把 bin 归一成 0755，查它等于查一个恒真命题；真正会丢的是**仓库自己记的 mode**，而它不经过 tarball。**只查 index 同样不够**：`--chmod=+x` 只写暂存区，而 fresh clone 与 CI 拿的都是 HEAD——只查 index 的版本恰好在它唯一要保护的地方（开发者本机）最弱 |
| 本机手工 `pnpm publish` 发版 | 要 pnpm 单独登录、2FA 的 OTP 只能交互输入、本机全局 registry 可能是镜像源、本地 main 与 squash 后的远端分叉——每一项都是手工流程本身带来的，而发出去的 commit 是否跑过三平台冒烟只能靠人记得去查 |
| 依赖 Node 原生 type stripping 直接运行 `.ts` 产品代码 | 会把运行时下限从 22.0.0 顶到 22.18，且每次启动都要付一次转换开销，挤占 300ms 冷启动预算 |
| pnpm 开 `shamefullyHoist: true` 或 `nodeLinker: hoisted` | 用扁平化掩盖 phantom dependency：本机构建通过，换到别人机器、CI 或改依赖版本后才 resolve 失败。深导入 diff2html 内部模块的方案更需要这层校验 |
| 手工把 `"dependencies": {}` 加回 `package.json` | `pnpm add` 会把空对象当空值规范化掉，而 `check:pack` 的判据是 `Object.keys(manifest[field] ?? {})`——**字段缺失与空对象在门禁眼里完全等价**，加回来一个字节的保护力度也不多。换来的是一行没有任何门禁看着、下一次装依赖时又被静默删掉的装饰，以及「承诺写在明面上」的错觉。「后端只用标准库」由 `check:pack`（查发布 manifest 的三个依赖字段）与冒烟（查 `dist/server/main.js` 的 import 说明符）两侧承载，不靠那行字面量 |
| 官网经 GitHub Actions 构建、再用 Vercel CLI 上传产物 | 仓库要存一个长期有效的 `VERCEL_TOKEN` 及两个项目 ID，PR 上也没有 preview 链接；Git 集成不需要任何密钥 |
