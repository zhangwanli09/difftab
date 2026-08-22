# difftab

[![npm](https://img.shields.io/npm/v/difftab)](https://www.npmjs.com/package/difftab)

**See what your AI coding agent changed — in one tab.**

Run one command in your repo. A local page opens with your working-tree diff and
branch status — read-only. Close the tab and the process exits on its own.

[中文文档](README.zh-CN.md)

difftab is built for the moment right after an agent finishes (or while it is still
running): you want a quick look at the changes, not a review session. It shows the
same thing `git status` and `git diff HEAD` would, rendered as syntax-highlighted
diffs — side by side when the window is wide enough, line by line when it is not —
and it refreshes itself as the agent keeps writing. It never writes
to your repository — the core promise, enforced by two CI gates and
[described below](#never-writes-to-your-repository).

## Install

Nothing to install — run it in any repository:

```bash
npx difftab        # pnpm users: pnpm dlx difftab
```

The first run spends a few seconds downloading and unpacking the package; later runs come
from the cache.

If you reach for it after every agent run, install it once instead — an `npx` run spends
more time resolving which version to fetch than difftab spends starting up:

```bash
npm i -g difftab   # or: pnpm add -g difftab
```

Requires **Node.js 22.0.0 or newer**. `dependencies` is empty: the backend uses only the
Node standard library, and the frontend is bundled at build time, so a global install
pulls in zero transitive packages.

## Usage

```bash
cd /path/to/your/repo
difftab            # or: npx difftab
```

| Option | What it does |
|---|---|
| `--no-open` | print the URL instead of opening a browser |
| `-v`, `--version` | print the version and exit |
| `-h`, `--help` | print help and exit |

Running it again in the same repository reuses the running instance instead of starting a
second process.

## What you get

- **Change list** — staged, unstaged and untracked files in three groups, plus conflicts
  in their own group with both status letters. Untracked directories are expanded to
  individual files rather than collapsed into a single `dir/` entry.
- **Diffs, lazily** — click a file to load its patch; nothing fetches the whole-repo diff.
  Rendered with [diff2html](https://diff2html.xyz/) and highlight.js in a VS Code-like
  theme, light and dark following your system appearance. The diff pane switches to a
  line-by-line view on its own once it gets too narrow for two columns.
- **Branch status** — current branch and ahead/behind counts, "no upstream" when there is
  none, and a label for detached HEAD or an in-progress rebase / merge / cherry-pick /
  revert / bisect / `git am`.
- **Auto-refresh** — a file watcher pushes changes over SSE, so the page keeps up while
  an agent is still writing. Where recursive watching would exhaust the machine-wide
  inotify quota (Linux on Node < 24.14.0), it polls instead and says so in the UI; while
  polling, editing an *untracked* file's contents does not refresh the page (an untracked
  entry is a single line in `git status` that does not change when its content does).
- **Exits on its own** — 45 seconds after the last tab closes. Multiple tabs, page
  reloads, sleep/wake and backgrounded tabs do not trigger it.

Edge cases are handled explicitly rather than left to fail: empty repositories (no
commits yet), detached HEAD, an interrupted rebase, linked worktrees, submodules, binary
files, files over 5 MB, renames (annotated with the old path and similarity), deleted
files, and paths containing spaces, quotes, CJK characters or emoji.

difftab is deliberately a viewer: no editing, no history, no blame, no review workflow.
The full out-of-scope list is in
[CONTRIBUTING.md](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable) and
[`docs/spec.md`](docs/spec.md) §4.

## Never writes to your repository

Not a best-effort claim. difftab never stages, commits, discards, pulls, pushes,
branches or stashes — it only ever runs read-only git commands. Two independent gates
enforce that on every CI run, on all three platforms:

1. **Command allowlist.** The whole flow runs under `GIT_TRACE`, and every git
   invocation the product makes — including subprocesses git spawns internally, such as
   an accidental `gc` — is asserted to be one of `status` / `diff` / `rev-parse` /
   `ls-files` / `version`. A positive assertion checks the trace is not empty, so the
   allowlist can never pass against nothing.
2. **`.git` is byte-for-byte unchanged.** The flow runs once against a read-only `.git`,
   and once against a writable one with a before/after snapshot of every file (size,
   mtime, content digest). A control run proves the snapshot would have caught a change.

The backend is also auditable by hand: `dist/server/main.js` ships unminified precisely
so you can read which git commands it runs.

## Local security

The server binds `127.0.0.1` on a random port with a session token, and every request —
including SSE and static assets — passes three checks *before* anything else is decided:

- **`Host`** must be `127.0.0.1:<port>` or `localhost:<port>`. This, not the token, is the
  real defence against DNS rebinding.
- **`Origin`**, when present, must be the server's own. No CORS headers are ever sent.
- **Token**, bound to this session's port, so a token that leaks to another localhost
  service (cookies are scoped by host, not by port) cannot be replayed there.

The token arrives in the URL once and is immediately swapped for an `HttpOnly;
SameSite=Strict` cookie with a 302 that strips the query, so it does not linger in browser
history. Responses carry a strict CSP (`default-src 'none'`, plus `frame-ancestors` /
`base-uri` / `form-action`, which do not fall back to it), `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Static assets are served from an in-memory allowlist,
never by joining a request path onto a directory. There is no environment variable or code
branch that relaxes any of this.

## Platform support

macOS, Windows and Linux are all supported and all tested. CI runs the full smoke suite
across three platforms × Node 22 / 24 / 26, plus dedicated jobs for global installation,
the Node version guard, and degrading to polling when the inotify quota is exhausted.
What CI cannot cover is in [Known limitations](#known-limitations), below.

## Known limitations

- **The token is passed on a command line.** argv is readable by other users on the same
  machine, so launching the browser opens a window of tens of milliseconds — one that
  requires an attacker already logged in locally, polling in a tight loop. Closing it
  properly conflicts with reusing a running instance, so it is revisited after 0.1.0. How
  wide it is under `xdg-open` is deliberately *not* measured in CI: a headless number
  would be reassuring and meaningless.
- **The browser actually appearing on a Windows or Linux desktop is not covered by CI.**
  Runners have no desktop session, so the *choice* of `open` / `cmd /c start ""` /
  `xdg-open` and its argv are asserted, but not the window. Both of these wait on a first
  real user.

## Development

```bash
pnpm install --frozen-lockfile   # pnpm version is pinned by the packageManager field
pnpm build                       # frontend (Vite) + backend (tsdown)
node bin/difftab.js              # run it against any repository
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: the dev-server setup, the full list of
gates, and the handful of things in this codebase that fail silently rather than loudly.
Requirements and design live in [`docs/`](docs/README.md) and are the single source of
truth — they change before the code does.

## License

[MIT](LICENSE)
