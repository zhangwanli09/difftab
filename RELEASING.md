# Releasing difftab

Releases are cut by [release-please](https://github.com/googleapis/release-please) and
published from CI by [`.github/workflows/release.yml`](.github/workflows/release.yml).
Don't bump the version, edit `CHANGELOG.md`, tag, or publish by hand.

## How a release happens

1. Every push to `main` makes release-please open or update a release PR. It bumps
   `package.json` and `.release-please-manifest.json` and writes the `CHANGELOG.md` entry
   from the Conventional Commit subjects that landed since the last release. Since `main`
   takes squash merges only, those subjects are the PR titles — write them for users.
2. Merge the release PR when you want to ship. That push tags `vX.Y.Z` and creates the
   GitHub Release.
3. The same workflow then re-runs the whole `ci.yml` on the release commit (`gates`), and
   only if every job is green, `npm publish`es it with npm trusted publishing (OIDC — no
   token, no OTP).

The release PR is opened with `GITHUB_TOKEN`, so its `pull_request` runs wait for
approval: they show up as "action required" and the PR has no checks until then. **Before
merging the release PR, approve those runs** ("Approve and run workflows" on the PR, or
re-run the waiting CI and PR title runs from the Actions tab) and wait for the two
required checks. Do this right before merging: every PR that lands on `main` afterwards
makes release-please update the release PR, and the runs on the new commit wait for
approval again. The re-run before publishing is still not redundant: a `pull_request` run
tests the PR merged into `main` as `main` was when the run started, while the tag lands on
the squash commit created at merge time, and the two differ if `main` moved in between.

## Versioning

Semver, driven by commit types. While in 0.x (`bump-minor-pre-major`):

- `fix`, `perf`, … → patch
- `feat` → minor
- breaking (`!` or a `BREAKING CHANGE:` footer) → minor

To force a specific number, put `Release-As: 0.7.0` in the body of a commit on `main`.

**1.0.0 is a conclusion, not a starting point**: it waits until every gate in
[`docs/gates.md`](docs/gates.md) passes and all three platforms have been verified on real
machines.

## One-time setup

- npmjs.com → `difftab` → Settings → Trusted Publisher: GitHub Actions, repository
  `zhangwanli09/difftab`, workflow `release.yml`.
- GitHub → Settings → Actions → General: enable "Allow GitHub Actions to create and approve
  pull requests", or release-please cannot open its PR.
- GitHub → Settings → General → Pull Requests: squash merges only, with the default commit
  message set to "Pull request title and commit details" (`squash_merge_commit_title =
  PR_TITLE`), so the subject on `main` is always the PR title.
- GitHub → Settings → Rules → "Protect main": require the status checks `all gates passed`
  and `Conventional Commits title` (source: GitHub Actions). The first aggregates every job
  in `ci.yml`; the second comes from `pr-title.yml`.

## When something fails

- **`gates` or `publish` failed** after the release PR merged: the tag and GitHub Release
  already exist, and later pushes will not retry. Fix the cause (a flaky runner, the npm
  trusted publisher setting), then `gh run rerun <run-id> --failed` — the re-run builds the
  same release commit. If the release commit itself is broken, ship a fix; the next release
  supersedes it.
- **The registry lags**: right after publishing, `npm view difftab` may still show the
  previous version for a couple of minutes. Do not republish.

## After publishing

- [ ] `npm view difftab version` shows the new version.
- [ ] In some other git repository, `npx difftab@<version> --no-open` prints a URL and exits
      on its own once idle. **Never run this inside this repo**: npm sees the local
      `package.json` is itself `difftab` and runs your working tree instead of the registry
      package.
