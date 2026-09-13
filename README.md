<p align="center">
  <img src="assets/mark.svg" width="96" alt="">
</p>
<h1 align="center">difftab</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/difftab"><img src="https://img.shields.io/npm/v/difftab" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/difftab" alt="node"></a>
  <a href="#never-writes-to-your-repository"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/difftab" alt="license"></a>
</p>

**See what your AI coding agent changed — in one tab.**

Run one command in your repo. A local page opens with your working-tree diff and branch
status — what `git status` and `git diff HEAD` would show — read-only, refreshing itself
while the agent keeps writing. Close the tab and the process exits.

[中文文档](README.zh-CN.md)

## Quick start

```bash
cd /path/to/your/repo
npx difftab
```

Or install it once — `npm i -g difftab` — and just run `difftab`.

Requires **Node.js 22 or newer** on macOS, Windows or Linux. Zero dependencies.

- `--no-open` — print the URL instead of opening a browser
- `-v`, `--version` — print the version and exit
- `-h`, `--help` — print help and exit

Running it again in the same repository reuses the running instance.

## What you get

- **Change list** — staged, unstaged, untracked and conflicting files in four groups, with
  untracked directories expanded to files.
- **Diffs, lazily** — click a file to load its patch, rendered by
  [diff2html](https://diff2html.xyz/) + highlight.js in a VS Code-like theme, side by side
  until the pane gets too narrow.
- **File tree** — a second sidebar tab browses the whole repository rather than only what
  changed: tracked, untracked and ignored files (the ignored ones dimmed), loaded one
  directory at a time. Click any file to read it, highlighted by the same theme.
- **Branch status** — branch name, ahead/behind counts, "no upstream", detached HEAD, and
  an in-progress rebase / merge / cherry-pick / revert / bisect / `git am`.
- **Auto-refresh** — a file watcher pushes changes over SSE, falling back to polling where
  recursive watching would exhaust the inotify quota (and saying so in the UI).
- **Exits on its own** — 45 seconds after the last tab closes.
- **Cheap to run** — about 40 ms from launch to a listening server, well inside the 300 ms
  budget CI enforces on every commit across nine Node × OS combinations; the JS bundle is
  72 KB gzipped.

Empty repositories, interrupted rebases, linked worktrees, submodules, binary and >5 MB
files, renames, and paths with spaces, quotes, CJK or emoji are handled explicitly.

difftab is deliberately a viewer: no editing, history, blame or review workflow
([out-of-scope list](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable)).

## Never writes to your repository

Not a best-effort claim: difftab only ever runs read-only git commands — no stage, commit,
discard, pull, push, branch or stash. Two gates enforce it on every change: a `GIT_TRACE`
allowlist over every git invocation, and a byte-for-byte comparison of `.git` before and
after. And `dist/server/main.js` ships unminified, so you can audit it by hand.

## Nothing leaves your machine

The server binds `127.0.0.1` on a port the kernel picks, and the only HTTP request difftab
makes is to localhost, to see whether an instance is already running for this repository.
No telemetry, no account, no cloud.

Each session gets a random token, handed to the browser once through the URL and then kept
in an `HttpOnly; SameSite=Strict` cookie while the URL is redirected clean. Every request
is checked against the `Host` header — the actual defense against DNS rebinding, rather
than the token alone — and against `Origin`, and the page runs under a `default-src 'none'`
CSP that also blocks framing, `<base>` rewriting and form submission. There is no
development escape hatch: no environment variable relaxes any of those checks.

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
