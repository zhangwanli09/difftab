# Releasing GitGlance

Maintainer checklist. Publishing is manual and deliberately so — the first versions are
infrequent, and `pnpm publish`'s git checks are worth more than the automation would save.

## Versioning

Semver. **0.x keeps room for breaking changes**, particularly to CLI flags and to port and
token behaviour. 1.0.0 is not a starting point but a conclusion: it waits until every
acceptance item in [`docs/acceptance.md`](docs/acceptance.md) §6 passes and all three
platforms have been verified on real machines. The core promise of this tool is being
read-only with zero side effects, and 1.0.0 should mean those promises are covered by the
two read-only gates — not that the package looks official.

GitHub Releases are the changelog. There is no `CHANGELOG.md`: a second place to write the
same list is a second place to forget.

## Before releasing

- [ ] The `ci` workflow is green on the release commit — **every job**, not just `build`.
      `gh run list --commit "$(git rev-parse HEAD)"` finds the run and
      `gh run view <run-id>` lists every job in it. The long tail is
      what matters here: the three-platform × Node 22/24/26 smoke matrix, `inotify-quota`,
      `global-install`, and `old-node-guard` are where cross-platform regressions surface,
      and `build` going green says nothing about any of them.
- [ ] Every acceptance item in `docs/acceptance.md` §6 marked for a shipped stage is
      checked, and the stage record is in `docs/journal.md`.
- [ ] `pnpm check:pack` — the tarball is `bin/`, `dist/`, both READMEs, LICENSE and
      `package.json`, and the three dependency fields are empty.
- [ ] `pnpm build && pnpm check:global` — packs, installs globally, runs the binary that
      landed on `PATH`, then uninstalls. Requires gitglance **not** to be globally
      installed already; the script refuses to run otherwise.
- [ ] Both READMEs describe what the version actually does. `README.zh-CN.md` is not
      auto-generated — it has to be updated by hand alongside `README.md`.

## Publishing

```bash
# 1. Bump the version. One commit, nothing else in it.
#    `npm version` also creates the tag; --no-git-tag-version leaves that to step 3.
npm version 0.1.0 --no-git-tag-version
git commit -am "chore(release): 0.1.0"

# 2. Push and let CI confirm the release commit itself is green.
git push origin main

# 3. Tag and push the tag.
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0

# 4. Publish. prepublishOnly runs the full build first.
pnpm publish
```

Then create the GitHub Release from the tag:

```bash
gh release create v0.1.0 --title "v0.1.0" --notes "…"
```

## Four things that will bite

- **Your global registry is probably not npmjs.** This machine's `~/.npmrc` points at
  `registry.npmmirror.com`, a read-only mirror. `publishConfig.registry` in
  `package.json` pins the publish target to `registry.npmjs.org` regardless — verified by
  dry run. If you ever see any other host in the `📦 name@version → …` line that
  `pnpm publish` prints, stop.
- **Do not pass `--no-git-checks`.** pnpm refuses to publish from a dirty tree, from the
  wrong branch, or when the branch is behind its remote. Those checks are the reason step
  2 comes before step 4. The publish branch is `main`, set as `publishBranch` in
  `pnpm-workspace.yaml` — pnpm's own default is still `master`.
- **Do not pass `--skip-manifest-obfuscation`.** pnpm strips `packageManager` and the
  publish lifecycle scripts from the manifest it uploads. That is wanted: users have no
  business seeing our toolchain. It also means the published `package.json` legitimately
  differs from the one in the repo — do not read that as a dirty artifact.
- **`prepublishOnly` does run** under pnpm (its own `--ignore-scripts` help text names
  `prepublishOnly` as one of the things that flag would skip). So `pnpm publish` builds
  before it packs; you do not have to build first, and a stale `dist/` cannot ship.

## After publishing

- [ ] `npm view gitglance` shows the new version, and `dist.tarball` is on npmjs.org.
- [ ] In a directory that is not this repo: `npm i -g gitglance && gitglance --version`,
      then check `npm ls -g --depth=0` shows no transitive dependencies under it.
- [ ] The GitHub Release exists and its notes match what actually changed.
