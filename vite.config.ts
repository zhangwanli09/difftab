import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type UserConfig } from 'vite';
import { readRegistry } from './src/server/cli/registry.ts';
// cookie 名与绑定地址从后端的单一来源拿,不在这里重写一份字面量:改了格式而这里
// 没跟上时,后端不会报错,只是 dev proxy 注入的 cookie 它不认,`pnpm dev` 静默失效
import { BIND_HOST, cookieName } from './src/server/http/security.ts';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

/**
 * Preact 的 JSX 设置。**具名导出是为了让 vitest.config.ts import 同一份**,而不是
 * 各抄一遍字面量:抄两份时漂移是静默的,而且方向最坏 —— 生产构建这侧改了
 * (换 importSource、加第三条 alias、runtime 改 classic),测试仍按旧设置转换,
 * 于是**测试跑的不是要发的那条流水线**,而套件全绿。与上面 BIND_HOST / cookieName
 * 从后端单一来源拿是同一条理由。
 *
 * JSX 走 Vite 8 的 Oxc 选项,不引 @preact/preset-vite(它会拖入 @babel/core)。
 * 代价是失去 prefresh 的组件状态保留 HMR,整页刷新对本项目够用(spec §5.11)。
 *
 * alias 是 Oxc 选项的补位,不是重复设置:dev 下 Vite 的依赖预扫描不吃 oxc.jsx,
 * 会按默认 importSource 去找 react/jsx-dev-runtime 并报 "could not be resolved"
 * (build 走 oxc.jsx 因此正常)。两条 alias 把这条路补上,dev / build 行为一致。
 */
export const preactJsx = {
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },
  resolve: {
    alias: {
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
    },
  },
} as const;

// 函数形态是为了拿到 `command`:`devProxy()` 会去读注册表,而它在 `vite build`
// 下毫无意义 —— 对象形态里那个展开在配置**加载时**就求值,于是 `pnpm build`
// (以及 CI 的 build 作业)会凭空打一条「先在另一个终端起后端」的警告。
export default defineConfig(({ command }) => ({
  root: webRoot,
  // 产物由 Node 服务在 / 下托管
  base: './',
  plugins: [tailwindcss()],

  ...preactJsx,

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
    // §5.9 的三道校验全部在代理层解决,**后端零 dev 分支**(spec §5.9 / §5.11):
    //   Host   —— changeOrigin 改写成后端的 127.0.0.1:<port>
    //   Origin —— configure 钩子里重写为后端自身 origin
    //   token  —— 从 os.tmpdir() 的注册表(§5.8)读出 port 与 token,注入 Cookie 头
    // 在后端加一个「dev 模式放宽校验」的环境变量是这里唯一被禁止的捷径:那等于
    // 把正面防御做成一个可被误开的开关(§10 明令禁止)。
    ...(command === 'serve' ? devProxy() : {}),
  },
}));

/**
 * 注册表是**运行中的后端**写的,所以先在另一个终端起后端,再 `pnpm dev`:
 *
 *   node bin/gitglance.js --no-open   # 或 pnpm build && node bin/gitglance.js
 *
 * 端口与 token 每次启动都变,后端重启后 dev server 也要重启 —— 配置只在加载时
 * 读一次。这个别扭是刻意的:它的替代品是让后端长期接受一个固定的 dev token。
 */
function devProxy(): UserConfig['server'] {
  // 注册表的键是 `git rev-parse --show-toplevel` 给出的工作区根,这里给的是 cwd ——
  // 同一个目录、字面量却未必相同(Windows 的分隔符、macOS 的 /var 符号链接),
  // 归一化在 registryPath 内部统一做,两侧因此对得上
  const backend = readRegistry(process.cwd());
  if (!backend) {
    console.warn(
      '[gitglance] 没找到运行中的后端(os.tmpdir() 下无注册表项),/api 代理未启用。\n' +
        '            先在另一个终端跑 `node bin/gitglance.js --no-open`,再重启 dev server。',
    );
    return {};
  }

  const target = `http://${BIND_HOST}:${backend.port}`;
  return {
    proxy: {
      '/api': {
        target,
        // Host 头改写为后端的 127.0.0.1:<port>
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Origin', target);
            proxyReq.setHeader('Cookie', `${cookieName(backend.port)}=${backend.token}`);
          });
        },
      },
    },
  };
}
