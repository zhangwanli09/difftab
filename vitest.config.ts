import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { preactJsx } from './vite.config.ts';

// 单独一份配置,不复用 vite.config.ts —— 后者的 root 是 src/web(前端产物的根),
// 直接被 vitest 继承会让它只在前端目录里找测试。
// 单元/集成测试直接跑 TS 源码(spec §5.11 的 build 作业);
// 跑 dist/ 产物的冒烟测试是纯 JS + node:test,不经这里。
const root = fileURLToPath(new URL('.', import.meta.url));

// JSX 设置从 vite.config.ts 拿**同一份**,不在这里抄一遍字面量(理由见那边的
// preactJsx 注释)。**不能省掉**:vitest 不读 vite.config.ts,缺了它组件用例会去解析
// react/jsx-dev-runtime 而整个文件加载失败。

// 环境按目录分(spec §5.11「DOM 测试环境」):`src/web` 的渲染路径要真实 DOM 才断言
// 得了(§5.5 那几条静默约束),而后端用例不该被套上一层 DOM 全局 —— 那是把「前端拿不到
// 也不该拿到 Node API」那条边界反向捅一刀。
//
// 落地方式必须是 `projects`:`environmentMatchGlobs` 在 Vitest 4 已被移除。
// 每个 project 都显式写全 root / include,不指望它从外层继承。
//
// **这些 include 是被断言的对象**:`test/unit/server/test-layout.test.ts` 会 import
// 本文件、把下面每条 pattern 编成正则,再要求 `test/unit` 下每个用例文件都至少匹配
// 一条。没有它,放在 `test/unit/` 底下(或第三个子目录里)的用例既不报错也不会被跑,
// 而套件照常全绿。加 project / 改 include 不必同步任何清单,那条断言自己读这里。
export default defineConfig({
  root,
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root,
          include: ['test/unit/server/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        ...preactJsx,
        test: {
          name: 'web',
          root,
          include: ['test/unit/web/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
