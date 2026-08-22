# difftab

[![npm](https://img.shields.io/npm/v/difftab)](https://www.npmjs.com/package/difftab)

**See what your AI coding agent changed — in one tab.**

Run one command in your repo. A local page opens with your working-tree diff and branch
status — what `git status` and `git diff HEAD` would show — read-only, refreshing itself
while the agent keeps writing. Close the tab and the process exits.

[中文文档](README.zh-CN.md)

## Install

```bash
npx difftab        # or install it once: npm i -g difftab
```

Requires **Node.js 22 or newer** on macOS, Windows or Linux. Zero dependencies.

## Usage

```bash
cd /path/to/your/repo
difftab
```

| Option | What it does |
|---|---|
| `--no-open` | print the URL instead of opening a browser |
| `-v`, `--version` | print the version and exit |
| `-h`, `--help` | print help and exit |

Running it again in the same repository reuses the running instance.

## What you get

- **Change list** — staged, unstaged, untracked and conflicting files in four groups, with
  untracked directories expanded to files.
- **Diffs, lazily** — click a file to load its patch, rendered by
  [diff2html](https://diff2html.xyz/) + highlight.js in a VS Code-like theme, side by side
  until the pane gets too narrow.
- **Branch status** — branch name, ahead/behind counts, "no upstream", detached HEAD, and
  an in-progress rebase / merge / cherry-pick / revert / bisect / `git am`.
- **Auto-refresh** — a file watcher pushes changes over SSE, falling back to polling where
  recursive watching would exhaust the inotify quota (and saying so in the UI).
- **Exits on its own** — 45 seconds after the last tab closes.

Empty repositories, interrupted rebases, linked worktrees, submodules, binary and >5 MB
files, renames, and paths with spaces, quotes, CJK or emoji are handled explicitly.
difftab is deliberately a viewer: no editing, history, blame or review workflow
([out-of-scope list](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable)).

## Never writes to your repository

Not a best-effort claim: difftab only ever runs read-only git commands — no stage, commit,
discard, pull, push, branch or stash. Two gates enforce it on every change: a `GIT_TRACE`
allowlist over every git invocation, and a byte-for-byte comparison of `.git` before and
after. And `dist/server/main.js` ships unminified, so you can audit it by hand.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build                       # frontend (Vite) + backend (tsdown)
node bin/difftab.js              # run it against any repository
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the dev-server setup, the gates, and the things
that fail silently rather than loudly; [`docs/`](docs/README.md) holds requirements and
design, the single source of truth.

## License

[MIT](LICENSE)
