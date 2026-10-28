import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 官网的构建，与产品前端完全分开：根目录那份 vite.config.ts 会 import 后端模块、配 dev proxy，
// 这里只要 Tailwind。产物落在 Vite 默认的 site/dist/，由 .gitignore 的 `dist/` 挡在仓库外。
//
// 站点挂在域名根上，base 用 Vite 默认的 `/`。别再写回子路径：base 与实际挂载点不一致时
// 页面本身能打开、样式与脚本全部 404，而 `pnpm site:dev` 看不出来。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss()],
});
