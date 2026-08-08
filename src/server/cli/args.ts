// 参数解析(spec §5.1)。`util.parseArgs` 在 Node 22 上可用,不需要第三方库。

import { parseArgs } from 'node:util';

export interface CliOptions {
  version: boolean;
  help: boolean;
  /** `--no-open`:只打印 URL,不拉起浏览器。 */
  noOpen: boolean;
}

export class CliUsageError extends Error {}

export const HELP_TEXT = `gitglance — glance at what changed in this repository (read-only)

Usage:
  gitglance [options]

Options:
  --no-open      print the URL instead of opening a browser
  -v, --version  print the version and exit
  -h, --help     print this help and exit

gitglance never writes to your repository.
`;

export function parseCliArgs(argv: readonly string[]): CliOptions {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        'no-open': { type: 'boolean' },
      },
      // 严格解析 + 不收位置参数:目录由 cwd 决定(「在仓库目录下敲一条命令」),
      // 多一个可选的路径参数就多一条要在 §5.2 前置检查里覆盖的入口
      strict: true,
      allowPositionals: false,
    });
    return {
      version: values.version === true,
      help: values.help === true,
      noOpen: values['no-open'] === true,
    };
  } catch (cause) {
    throw new CliUsageError(cause instanceof Error ? cause.message : String(cause));
  }
}
