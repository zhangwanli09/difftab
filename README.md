<h1 align="center">
  <img src="assets/mark.svg" width="40" align="top" alt="">
  difftab
</h1>

<p align="center"><strong>See what your AI coding agent changed — in one browser tab.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/difftab"><img src="https://img.shields.io/npm/v/difftab" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/difftab" alt="node"></a>
  <a href="#security"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/difftab" alt="license"></a>
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#why-difftab">Why</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.zh-CN.md">中文文档</a>
</p>

A read-only, zero-dependency local viewer for your git working tree: the diff, the file
tree and the branch status, refreshing itself while the agent keeps writing. Close the tab
and it exits.

## Why difftab

You run Claude Code, Codex, OpenCode or another agent from a terminal. It finishes a task,
and you want to see what it actually did. The agent's own diff scrolls past in the
terminal, which is not the place to read a 300-line patch — so you open VS Code, or
whatever IDE you keep around for this, not to edit anything, just to read the diff, glance
at the tree, check the branch, and close it again.

difftab is that half of the editor without the editor. One command, one tab, and only the
three things you actually looked at. It only reads git, so it works with any agent, any
language and any repository — and if the agent is all you write code with now, it lets you
uninstall the IDE.

## Features

- **The diff, the way an editor shows it** — staged, unstaged, untracked and conflicting
  changes, side by side with syntax highlighting.
- **The whole repository, not only what changed** — browse the file tree and open any file.
- **Branch status you can trust** — ahead/behind, no upstream, detached HEAD, a rebase or
  merge still in progress.
- **Live while the agent writes** — the tab refreshes on its own as files change.
- **Never writes to your repository** — read-only git only, enforced by CI gates rather
  than by promise. Details under [Security](#security).
- **Nothing to keep running** — starts instantly, zero dependencies, exits when you close
  the tab.

## Installation

Requires **Node.js 22 or newer** on macOS, Windows or Linux. No other dependencies.

```bash
npm i -g difftab
```

Or try it without installing:

```bash
npx difftab
```

## Usage

Run it inside any git repository:

```bash
cd /path/to/your/repo
difftab
```

A browser tab opens with the current diff. Keep it open next to the agent: the tab
refreshes as files change, and when you close it the process exits on its own. Running
`difftab` again in the same repository reuses the running instance instead of starting a
second one.

| Option | What it does |
|---|---|
| `--no-open` | Print the URL instead of opening a browser |
| `-v`, `--version` | Print the version and exit |
| `-h`, `--help` | Print help and exit |

There is nothing to configure: no port to pick, no config file.

## How it works

`difftab` runs the same read-only git commands `git status` and `git diff HEAD` would, and
serves the result from a local server on `127.0.0.1`. The page loads a patch when you click
it and refreshes as files change; 45 seconds after the last tab closes, the process exits.

## Security

Read-only, local-only, nothing to trust but your own machine.

**It never writes to your repository.** difftab only ever runs read-only git commands — no
stage, commit, discard, pull, push, branch or stash. Two gates enforce this on every
change: a `GIT_TRACE` allowlist over every git invocation, and a byte-for-byte comparison
of `.git` before and after. `dist/server/main.js` ships unminified, so you can audit it by
hand.

**Nothing leaves your machine.** The server binds `127.0.0.1`; the only HTTP request
difftab makes is to localhost, to see whether an instance is already running for this
repository. No telemetry, no account, no cloud.

**The local page is locked down.** Each session gets a random token, handed to the browser
once through the URL and then kept in an `HttpOnly; SameSite=Strict` cookie while the URL
is redirected clean. Every request is checked against the `Host` header — the actual
defense against DNS rebinding, rather than the token alone — and against `Origin`, and the
page runs under a `default-src 'none'` CSP that also blocks framing, `<base>` rewriting and
form submission. There is no development escape hatch: no environment variable relaxes any
of those checks.

## FAQ

**Does it work with my agent?** — Yes. difftab never talks to the agent — it only reads
git — so anything that writes files into a git working tree looks the same to it: Claude
Code, Codex, OpenCode, Aider, a human with vim.

**Can I stage, commit or discard from it?** — No, and it never will be. Read-only is the
product's core promise, not a missing feature; see [Non-goals](#non-goals).

**The UI says "Polling" — is something wrong?** — No. It means difftab could not use native
file watching here: Node older than 24.14 on Linux, a repository on a network drive or a
Docker volume, or an exhausted inotify quota. It runs `git status` every 1.5 seconds
instead, so everything still refreshes; it may just land a second or two later.

## Non-goals

difftab is deliberately a viewer. Permanently out of scope: any repository write operation,
code editing, accounts and cloud sync, and multi-user review workflows. Out of the current
version: commit history, branch lists, blame. The full list, and the reasoning, is in
[CONTRIBUTING.md](CONTRIBUTING.md#the-read-only-promise-is-not-negotiable).

## Contributing

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
