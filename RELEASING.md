# Releasing difftab

Maintainer checklist. Publishing is manual and deliberately so — the first versions are
infrequent, and `pnpm publish`'s git checks are worth more than the automation would save.

## Versioning

Semver. **0.x keeps room for breaking changes**, particularly to CLI flags and to port and
token behaviour. 1.0.0 is not a starting point but a conclusion: it waits until every
gate in [`docs/gates.md`](docs/gates.md) passes and all three platforms have been
verified on real machines. The core promise of this tool is being
read-only with zero side effects, and 1.0.0 should mean those promises are covered by the
two read-only gates — not that the package looks official.

GitHub Releases are the changelog. There is no `CHANGELOG.md`: a second place to write the
same list is a second place to forget.

## Before releasing

- [ ] The `ci` workflow is green on the release commit — **every job**, not just `build`.
      `gh run list --commit "$(git rev-parse HEAD)"` finds the run and `gh run view
      <run-id>` lists every job in it. The long tail is what matters here: the
      three-platform × Node 22/24/26 smoke matrix, `inotify-quota`, `global-install`, and
      `old-node-guard` are where cross-platform regressions surface, and `build` going
      green says nothing about any of them.
      **`--commit` matches `head_sha` exactly, so keep the `$(git rev-parse HEAD)`** — hand
      it the short SHA you read off `git log` and it answers `[]` while the run is going,
      which looks exactly like "CI did not trigger". `gh run watch <run-id> --exit-status`
      then blocks until the run lands.
- [ ] Every gate in `docs/gates.md` is green, and anything left unverified is written
      down in `docs/history.md` under the open items.
- [ ] `pnpm check:pack` — the tarball is `bin/`, `dist/`, both READMEs, LICENSE and
      `package.json`, and the three dependency fields are empty.
- [ ] `pnpm build && pnpm check:global` — packs, installs globally, runs the binary that
      landed on `PATH`, then uninstalls. Requires difftab **not** to be globally
      installed already; the script refuses to run otherwise — and the after-publish
      check below leaves one behind, so `npm rm -g difftab` first if you ran it last
      release.
- [ ] Both READMEs describe what the version actually does. `README.zh-CN.md` is not
      auto-generated — it has to be updated by hand alongside `README.md`.

## Publishing

```bash
# 1. Bump the version on a branch — main takes pull requests only, so a direct push
#    is rejected with "Changes must be made through a pull request".
#    One commit, nothing else in it; `npm version` would also create the tag, and
#    --no-git-tag-version leaves that to step 4.
git checkout -b release/0.1.0
npm version 0.1.0 --no-git-tag-version
git commit -am "chore(release): 0.1.0"

# 2. Open the PR, let CI go green on it, and merge. --rebase keeps a README commit
#    and the version bump as two commits; squash would fuse them.
git push -u origin release/0.1.0
gh pr create --base main --title "chore(release): 0.1.0" --body "…"
gh pr merge --rebase --delete-branch

# 3. Sync main. Branching before committing (step 1) leaves nothing on your local main,
#    so this fast-forwards — `gh pr merge --delete-branch` has usually done it already.
git checkout main && git pull --ff-only origin main

# 4. Let CI confirm the merged release commit itself is green, then tag and push the tag.
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0

# 5. Publish. prepublishOnly runs the full build first, and pnpm stops to ask for a
#    2FA one-time password — so run this in a real terminal, or pass --otp=<code>.
pnpm publish
```

Then create the GitHub Release from the tag:

```bash
gh release create v0.1.0 --title "v0.1.0" --notes "…"
```

## Nine things that will bite

- **`pnpm` needs its own login; `npm login` does not carry over.** Being logged in with
  the npm CLI (`npm whoami` answers, `~/.npmrc` holds a token) is not enough — the first
  publish attempt of 0.1.0 failed under exactly those conditions. **The symptom looks
  nothing like an auth problem**: the registry answers `[E404] 404 Not Found - PUT
  https://registry.npmjs.org/difftab`, because npm returns 404 rather than 403 for a write
  it will not allow on a package that does not exist yet. Run `pnpm whoami`, and
  `pnpm login` if it does not answer. Once pnpm is authenticated the error changes to
  `ERR_PNPM_OTP_NON_INTERACTIVE`, which is the honest one.
- **Publishing needs a 2FA one-time password, so it cannot run non-interactively.** The
  account has two-factor auth set to `auth-and-writes` (`npm profile get` prints it), so
  `pnpm publish` prompts for a six-digit code. Run it in a real terminal, or pass
  `--otp=<code>`; a code lives about 30 seconds, and a retry after it expires is free.
- **Your global registry may not be npmjs.** `publishConfig.registry` in `package.json`
  pins the publish target to `registry.npmjs.org` regardless of what `~/.npmrc` says —
  verified by dry run. If you ever see any other host in the
  `📦 name@version → …` line that `pnpm publish` prints, stop.
- **Commit on the release branch, never on `main` first.** Merging through a PR rewrites
  history either way — squash builds one new commit, and a rebase merge rewrites the
  committer on every commit it replays — so what lands on the remote has different SHAs
  from what you pushed. That is invisible as long as your local `main` holds none of those
  commits — which is why step 1 branches before it commits. Commit on `main` and branch
  afterwards (0.2.0 did) and `main` diverges: `git pull --ff-only` answers `fatal: Not
  possible to fast-forward, aborting.`, which reads like the work was lost. It was not.
  The criterion is the **tree** hash, not the commit hash — `git rev-parse HEAD^{tree}`
  and `git rev-parse origin/main^{tree}` print the same thing when the content is
  identical, and only then is `git reset --hard origin/main` safe. Tag the commit that is
  on the remote, never the local one you are about to discard.
- **If `--rebase` is rejected, the repository settings are a red herring — read the
  ruleset.** 0.2.1 hit `GraphQL: Rebase merges are not allowed on this repository.
  (mergePullRequest)` while `gh api repos/<owner>/difftab` reported all three merge
  methods as `true`: the restriction lives in the `Protect main` ruleset's
  `allowed_merge_methods`, which listed `squash` alone. `gh api
  repos/<owner>/difftab/rulesets/<id> --jq '.rules[] | select(.type=="pull_request")'`
  prints it. Rebase is back in that list, so step 2 stands as written; **if it is ever
  taken out again, the consequence lands on step 1, not step 2** — squash fuses
  everything on the branch into one commit, so the release branch would have to carry
  the version bump and nothing else, with a README update going in its own earlier PR.
- **Do not pass `--no-git-checks`.** pnpm refuses to publish from a dirty tree, from the
  wrong branch, or when the branch is behind its remote. Those checks are the reason steps
  2 and 3 come before step 5. The publish branch is `main`, set as `publishBranch` in
  `pnpm-workspace.yaml` — pnpm's own default is still `master`.
- **Do not pass `--skip-manifest-obfuscation`.** pnpm strips `packageManager` and the
  publish lifecycle scripts (`prepublishOnly`) from the manifest it uploads, and leaves
  the rest of `scripts` alone. That is wanted: users have no business seeing our
  toolchain. It also means the published `package.json` legitimately differs from the one
  in the repo — do not read that as a dirty artifact.
- **`prepublishOnly` does run** under pnpm (its own `--ignore-scripts` help text names
  `prepublishOnly` as one of the things that flag would skip). So `pnpm publish` builds
  before it packs; you do not have to build first, and a stale `dist/` cannot ship.
- **Never smoke-test the published package with `npx difftab` inside this repo.** npm exec
  sees that the local `package.json` is itself `difftab` with a matching `bin`, so it never
  reaches the registry: it installs a `file:` link back to your working tree under
  `~/.npm/_npx/<hash>/` and runs *your* `dist/`. So a green run there proves nothing about
  what you just published. It also mutates the repo — npm's `fixBin` chmods the link target,
  which is the real file in your tree, to 0755. That is harmless now that `bin/difftab.js`
  is committed as 100755 (`check:bin` pins it, see `docs/decisions.md`), but on 0.1.0 it
  produced a content-free mode-only diff in `git status`; discarding that diff removed the
  exec bit and the next run died with `sh: …/.bin/difftab: Permission denied`. Verify from a
  directory that is not this repo — the same rule the `npm i -g` check below already follows.

## After publishing

- [ ] `npm view difftab` shows the new version, and `dist.tarball` is on npmjs.org.
- [ ] In a directory that is not this repo: `npm i -g difftab && difftab --version`,
      then check `npm ls -g --depth=0` shows no transitive dependencies under it.
- [ ] In some other git repository (again: not this one) `npx difftab@<version> --no-open`
      prints a URL and exits on its own once idle. Run from this repo it would silently
      test your working tree instead — see the last of the seven above.
- [ ] The GitHub Release exists and its notes match what actually changed.
