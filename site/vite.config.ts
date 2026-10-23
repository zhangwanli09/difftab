import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 官网的构建，与产品前端完全分开：根目录那份 vite.config.ts 会 import 后端模块、配 dev proxy，
// 这里只要 Tailwind。产物落在 Vite 默认的 site/dist/，由 .gitignore 的 `dist/` 挡在仓库外。
//
// base 是 GitHub Pages 项目站的子路径。写错时页面本身能打开、样式与脚本全部 404——
// 本地 `pnpm site:dev` 看不出来，`vite preview` 才看得见。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/difftab/',
  plugins: [tailwindcss()],
});
