import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  // 产物由 Node 服务在 / 下托管
  base: './',
  plugins: [tailwindcss()],

  // JSX 走 Vite 8 的 Oxc 选项,不引 @preact/preset-vite(它会拖入 @babel/core)。
  // 代价是失去 prefresh 的组件状态保留 HMR,整页刷新对本项目够用(spec §5.11)。
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },

  // alias 是 Oxc 选项的补位,不是重复设置:dev 下 Vite 的依赖预扫描不吃 oxc.jsx,
  // 会按默认 importSource 去找 react/jsx-dev-runtime 并报 "could not be resolved"
  // (build 走 oxc.jsx 因此正常)。两条 alias 把这条路补上,dev / build 行为一致。
  resolve: {
    alias: {
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
    },
  },

  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    // 单份 CSS,便于 §5.6 的层叠顺序在产物里可验证、也便于体积门禁计量
    cssCodeSplit: false,
    // 服务端对所有响应发 Cache-Control: no-store,内容哈希没有意义;
    // 且 §5.9 要求静态资源按内存清单白名单式映射,文件名必须固定
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'app.css' : '[name][extname]',
      },
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    // TODO(S1): 三道校验(Host / Origin / token)全部在此处的 proxy configure 钩子里解决,
    // 后端零 dev 分支(spec §5.9 / §5.11)。注册表文件由 S1 的 server 写入后才有 token 可读。
  },
});
