import { defineConfig } from 'tsdown';

// src/server/**.ts → dist/server/main.js:单文件 ESM,不压缩不混淆(spec §5.1)。
// 保持可读能让用户自行核查「这工具到底跑了哪些 git 命令」,与 §4.1 只读承诺的
// 可审计性一致;单文件则减少模块解析次数,对冷启动门禁只有正向作用。
export default defineConfig({
  entry: ['src/server/main.ts'],
  outDir: 'dist/server',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: false,
  dts: false,
  sourcemap: false,
  clean: true,
  // platform: 'node' 下 tsdown 默认输出 .mjs;这里固定为 dist/server/main.js
  // ——package.json 已声明 type: module,.js 即 ESM,且 bin/difftab.js 里那条
  // 动态 import 的路径是手写的、不参与构建,产物名必须与它逐字对上(spec §5.1)
  fixedExtension: false,
  hash: false,
});
