# GitGlance

**See at a glance what your AI coding agent changed.**

One command in your repo → a local web page opens → the working tree diff and branch
status, read-only → close the tab and the process exits on its own.

[中文文档](README.zh-CN.md)

GitGlance is built for the moment right after an agent finishes (or while it is still
running): you want to *glance* at the changes, not open a review session. It shows the
same thing `git status` and `git diff HEAD` would, rendered as side-by-side diffs with
syntax highlighting, and it refreshes itself as the agent keeps writing.

## Never writes to your repository

This is the product's core promise, not a best-effort claim. GitGlance never stages,
commits, discards, pulls, pushes, branches or stashes — it only ever runs read-only git
commands. Two independent gates enforce it on every CI run, on all three platforms:

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

## Install

```bash
npm i -g gitglance      # or: pnpm add -g gitglance
```

Or try it without installing: `npx gitglance` (pnpm users: `pnpm dlx gitglance`). Note
that the first `npx` run has to download and unpack the package, which takes a few
seconds — subsequent runs are served from the cache.

Requires **Node.js 22.0.0 or newer**. `dependencies` is empty: the backend uses only the
Node standard library, and the frontend is bundled at build time, so a global install
pulls in zero transitive packages.

## Usage

```bash
cd /path/to/your/repo
gitglance
```

| Option | |
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
  theme, light and dark following your system appearance.
- **Branch status** — current branch and ahead/behind counts, "no upstream" when there is
  none, and a label for detached HEAD or an in-progress rebase / merge / cherry-pick /
  revert / bisect / `git am`.
- **Auto-refresh** — a file watcher pushes changes over SSE, so the page keeps up while
  an agent is still writing. Where recursive watching would be a bad neighbour (Linux on
  Node < 24.14.0, where Node's recursive `fs.watch` registers one inotify watch per file
  and can exhaust the machine-wide quota), GitGlance polls instead and says so in the UI.
- **Exits on its own** — 45 seconds after the last tab closes. Multiple tabs, page
  reloads, sleep/wake and backgrounded tabs do not trigger it.

Edge cases are handled explicitly rather than left to fail: empty repositories (no
commits yet), detached HEAD, an interrupted rebase, linked worktrees, submodules, binary
files, files over 5 MB, renames (annotated with the old path and similarity), deleted
files, and paths containing spaces, quotes, CJK characters or emoji.

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
history. Responses carry a strict CSP (`default-src 'none'`, with `frame-ancestors`,
`base-uri` and `form-action` each set to `'none'`, since those do not fall back to
`default-src`), plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Static assets are served from an in-memory allowlist, never by joining a request path onto
a directory. There is no environment variable or code branch that relaxes any of this.

**Known limitation:** launching your browser means passing the URL on a command line, and
argv is readable by other users on the same machine. The window is on the order of tens of
milliseconds and requires an attacker already logged in as another local user, polling in
a tight loop. Closing it properly requires a single-use exchange code, which conflicts
with how a second `gitglance` invocation reuses a running instance; that trade-off is
revisited after 0.1.0.

## Platform support

macOS, Windows and Linux are all supported and all tested. CI runs the full smoke suite
across three platforms × Node 22 / 24 / 26, plus dedicated jobs for global installation,
the Node version guard, and degrading to polling when the inotify quota is exhausted.

Two things CI cannot cover, both waiting on a first real user:

- **The browser actually popping up on a Windows or Linux desktop.** CI runners have no
  desktop session, so the *choice* of `open` / `cmd /c start ""` / `xdg-open` and its argv
  are asserted, but not the window appearing.
- **How wide the argv window above is under `xdg-open`.** Measuring it headless produces a
  reassuring but meaningless number, so it is deliberately not measured in CI.

Other known limitations: browsers cap concurrent connections per origin at six, one of
which the SSE stream holds, so a seventh tab will hang — irrelevant at the one-or-two tabs
this tool is used at. And when the watcher has degraded to polling, editing an *untracked*
file's contents does not refresh the page, because an untracked entry is a single line in
`git status` that does not change when its content does.

## Development

```bash
pnpm install --frozen-lockfile   # pnpm version is pinned by the packageManager field
pnpm build                       # frontend (Vite) + backend (tsdown)
node bin/gitglance.js            # run it against any repository
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: the dev-server setup, the full list of
gates, and the handful of things in this codebase that fail silently rather than loudly.
Requirements and design live in [`docs/`](docs/README.md) and are the single source of
truth — they change before the code does.

## License

MIT
