<!--
Please read CONTRIBUTING.md first if you have not.

Two things worth knowing before you spend time here:
  · Requirements and design live in docs/ and are the single source of truth. A behaviour
    change lands there before it lands in code.
  · difftab never writes to the repository it is looking at. Pull requests adding a
    repository write operation are declined regardless of how they are gated.
-->

## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was wrong, or what could not be done before. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm build` then `pnpm test:smoke` passes (smoke runs against `dist/`, so a stale
      build fails in misleading ways)
- [ ] Behaviour changes are reflected in `docs/` first
- [ ] New tests live in `test/unit/server/` or `test/unit/web/` — anywhere else under
      `test/unit/` and they are silently never run
- [ ] Each new gate or assertion was made to fail once, on purpose, to prove it is wired up
