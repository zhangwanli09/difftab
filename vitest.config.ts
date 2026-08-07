import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 单独一份配置,不复用 vite.config.ts —— 后者的 root 是 src/web(前端产物的根),
// 直接被 vitest 继承会让它只在前端目录里找测试。
// 单元/集成测试直接跑 TS 源码(spec §5.11 的 build 作业);
// 跑 dist/ 产物的冒烟测试是纯 JS + node:test,不经这里。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
