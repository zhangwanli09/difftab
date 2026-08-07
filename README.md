# GitGlance

一眼看懂 AI 编码 Agent 改了哪些代码。

在仓库目录敲一条命令 → 拉起本地网页 → 只读展示当前工作区的 diff 与分支状态 →
关掉标签页后进程自动退出。**全程零写操作**,不需要对「工具会不会动我的仓库」有任何顾虑。

> 当前处于 S0(工具链脚手架)阶段,功能尚未实现。需求与设计的唯一事实来源是
> [`docs/spec.md`](docs/spec.md)。

## 安装

```bash
npm i -g gitglance     # 或 pnpm add -g gitglance
```

也可以不安装直接试用:`npx gitglance`(pnpm 用户为 `pnpm dlx gitglance`)。

要求 Node.js **22.0.0** 或更高版本。`dependencies` 为空,零传递依赖。

## 使用

```bash
cd /path/to/your/repo
gitglance
```

## 开发

包管理器为 pnpm,版本由 `package.json` 的 `packageManager` 字段固定。

```bash
pnpm install --frozen-lockfile
pnpm dev          # Vite dev server
pnpm build        # 前端 Vite + 后端 tsdown
pnpm typecheck    # tsc --noEmit,两份 tsconfig
pnpm lint         # biome check
pnpm test         # Vitest,跑 TS 源码
pnpm test:smoke   # node --test,跑 dist/ 产物
```

## License

MIT
