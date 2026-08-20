# difftab 文档索引

**需求与设计的唯一事实来源是本目录**,不是代码,也不是 `docs/journal.md`。需求要变,先改这里的对应文件再改代码。

常驻上下文是仓库根的 [`CLAUDE.md`](../CLAUDE.md)(摘要 + 红线 + 路由表);本目录的文件**按需读取**,不必通读。

## 章节号 → 文件

章节号沿用拆分前的编号,**§ 号即稳定地址**。

| 章节 | 文件 | 承载什么 |
|---|---|---|
| §1–§4 | [`spec.md`](spec.md) | 背景与目标、目标用户与分发、功能范围、明确不做(Non-goals) |
| §5.0–§5.12 | [`design.md`](design.md) | 技术设计:模块边界、git 交互、监听、前端、样式、安全、构建 |
| §6 | [`acceptance.md`](acceptance.md) | 验收标准,逐条带 `[Sx]` 阶段标记 |
| §7、§8 | [`roadmap.md`](roadmap.md) | 实施阶段(S0–S6)、开源规划 |
| §9 | [`workflow.md`](workflow.md) | 开发方式:文档体系自身的规则、阶段收口判据 |
| §10 | [`decisions.md`](decisions.md) | 被排除的做法与关键决策依据——**实测证据与推导的唯一去处** |
| — | [`journal.md`](journal.md) | 已收口阶段的记录与踩坑。**是记录不是约束** |

## 怎么用

- **动手改代码前**:按 `CLAUDE.md` 第 4 节的路由表定位到 `design.md` 的对应小节,只读那一节。
- **想知道"为什么不那样做"**:去 `decisions.md` §10,规则在 `design.md`、证据在这里,两边不互相复述。
- **一个阶段收口时**:对照 `acceptance.md` §6 中本阶段的 `[Sx]` 项,并满足 `workflow.md` §9 的四条收口判据。

## 两条维护约定

- **§ 号是外部稳定地址,可以搬文件,不可以重新编号。** `spec §5.x` 这类引用散落在 `biome.json`、三份 tsconfig、`vite.config.ts`、`tsdown.config.ts`、`vitest.config.ts`、`lefthook.yml` 与冒烟测试里;重新编号不会报错,只会让它们静默指错。理由与完整清单见 `workflow.md` §9。
- **新增内容前先判断落哪个文件**,别就近塞;新增或移动文件时,同步更新上表与 `CLAUDE.md` 的路由表。
