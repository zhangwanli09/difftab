# Contributing to difftab

Thanks for taking a look. This is a small, opinionated tool; the sections below are the
things that are easy to get wrong here and hard to catch in review.

> Requirements and design live in [`docs/`](docs/README.md) and are currently written in
> Chinese. They are the single source of truth: **a requirement change lands in `docs/`
> before it lands in code.** [`CLAUDE.md`](CLAUDE.md) is the short version — a summary,
> a routing table, and the list of "violating this doesn't error, it just silently
> misbehaves" rules.

## Before you open a pull request

- **Read [`docs/spec.md`](docs/spec.md) §4 (Non-goals) first if you are adding a feature.**
  Some things are permanently out of scope, not merely unbuilt — see below.
- **Check the routing table in [`CLAUDE.md`](CLAUDE.md) §4** for which section of
  [`docs/design.md`](docs/design.md) covers the area you are touching, and read that
  section. Most of it exists because something silently broke once.
- Open an issue first for anything beyond a bug fix. It saves you writing code against a
  design decision that was already made and written down.

## The read-only promise is not negotiable

difftab never writes to the repository it is looking at: no stage/unstage, no commit,
no discard, no pull/push, no branch, no stash. A pull request that adds a repository write
operation will be declined regardless of how it is implemented or gated. Two CI gates
enforce this (a `GIT_TRACE` command allowlist and a byte-for-byte `.git` comparison), and
they are meant to be inconvenient.

To be clear about the scope: this constrains **what git commands the product's code runs**,
not what git commands you run while developing. Committing, branching and pushing in this
repository are completely normal.

Also permanently out of scope: editing code, accounts and cloud sync, and multi-user
collaboration (PR review, comments, approvals). A second list holds what is deliberately
out of the *first* version — that one moves as versions ship, so read it at the source:
[`docs/spec.md`](docs/spec.md) §4.2.

## Setting up

```bash
pnpm install --frozen-lockfile   # pnpm version is pinned by packageManager
pnpm build
```

Run it against any git repository:

```bash
node bin/difftab.js   # --no-open just prints the URL
```

For frontend work, the Vite dev server proxies to the backend and reads the port and
token from the instance registry, so the backend has to be running first — and has to be
restarted alongside it:

```bash
node bin/difftab.js --no-open   # terminal A
pnpm dev                        # terminal B
```

The backend exits 45 seconds after the last client disconnects. If that is too fast while
you are working, raise `DIFFTAB_IDLE_MS`.

## Gates

Everything below has to be green. CI is the arbiter, not your machine — the two disagree
more often than you would expect.

| | |
|---|---|
| `pnpm lint` | Biome. Also enforces the architecture boundaries (see below) |
| `pnpm typecheck` | `tsc --noEmit`, one config per side |
| `pnpm test` | Vitest, against the TS sources |
| `pnpm test:smoke` | `node --test`, against `dist/` — **run `pnpm build` first** |
| `pnpm size` | bundle size budget |
| `pnpm bench:startup` | cold start ≤ 300 ms |
| `pnpm check:css` | CSS cascade ordering |
| `pnpm check:pack` | published tarball contents |
| `pnpm check:bin` | `bin/difftab.js` is untouched by the build |

`pnpm test:smoke` runs against build output, so a stale `dist/` fails in ways that look
like three separate gates broke at once. Build first.

## Things that fail silently

The full list is [`CLAUDE.md`](CLAUDE.md) §5, with the evidence behind each one in
[`docs/decisions.md`](docs/decisions.md) §10. The four that bite most often:

- **Architecture boundaries.** git subprocesses may only appear in `server/git`; launching
  a browser only in `server/cli`; `src/web` must not import `src/server` (except
  `shared/`). Biome's `noRestrictedImports` catches the import direction — but it only
  reads import specifiers, so the rule still stands where lint cannot see it.
- **Test layout.** Vitest projects include specific paths: `test/unit/server/` (node) and
  `test/unit/web/` (happy-dom). A test file placed anywhere else under `test/unit/`
  **belongs to no project, is never run, and the suite stays green.**
- **CSS layering.** The highlight.js themes and `diff2html.min.css` must stay unlayered
  and in that order, and our `--d2h-*` overrides must come *after* diff2html. Getting the
  order wrong makes 23 overrides silently do nothing; the page just looks a bit off.
- **git invocation details.** `-z`, `core.quotePath=false`, `GIT_OPTIONAL_LOCKS=0` and
  `GIT_LITERAL_PATHSPECS=1` are set in the wrapper layer for reasons that each have a
  test. Removing one does not produce an error.

## Commits

English, [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <description>`, where type is one of `feat` / `fix` / `docs` /
`refactor` / `perf` / `test` / `build` / `ci` / `chore`, with `!` for breaking changes.

Imperative mood, subject ≤ 50 characters with no trailing period, body wrapped at 72 and
covering what and why rather than how. One commit does one thing — don't mix a refactor
into a feature change.

## Reporting bugs

Please include your OS, `node --version`, `git --version`, and the difftab version.
If it involves auto-refresh, say whether the page showed the "Polling" badge: the watcher
runs in one of three tiers picked from your Node version and platform, and they behave
differently by design.

## License

By contributing you agree that your contributions are licensed under the MIT License.
