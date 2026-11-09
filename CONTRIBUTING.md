# Contributing to Takumo

How the code is organized and the rules every change follows. CI enforces the ones marked
**(CI)**; reviewers check the rest. Agents follow the same rules via
`.cursor/skills/takumo-codebase/SKILL.md` before writing code.

## Where code goes

| Kind of code | Location |
|---|---|
| Pages, layouts, route handlers | `apps/app/app/…` (Next.js App Router). Keep them thin: load data, call `lib/`, render. |
| Server actions | `actions.ts` next to the page that uses them (`"use server"`, async exports only). |
| Business logic | `apps/app/lib/<domain>/` (`quotes`, `schedule`, `erp`, `inbound`, `facts`, `brief`, `alerts`, `phone`, …). One domain per folder, one responsibility per file. |
| UI building blocks | `packages/design-system` (shadcn/ui). Add a component only when a page uses it: `pnpm dlx shadcn@latest add <name> -c packages/design-system`. |
| Shared code used by more than one app | A package under `packages/`. |
| Scheduling and pricing maths | `services/engine` (Python). The app never computes schedules or prices itself. |
| Tests | `__tests__/` in each package (`*.test.ts`); database tests are `*.db.test.ts`; engine tests in `services/engine/tests/`. |

Import from a package by path (`@repo/ingest`, `@repo/database`), never with a relative path
into another package. A package lists every package it imports in its own `package.json`.

## File and function size

- **(CI)** Source files: at most **600 lines**. Test files: at most **1,000 lines**
  (`pnpm check:size`). Generated code, vendored code, shadcn components, migrations and the demo
  data are exempt. Review a file that passes **400** before adding to it: split by responsibility
  first.
- **(CI)** A package imports another package only through its name, and only if that
  package is listed in its own `package.json` (`pnpm boundaries`). Apps may import
  packages. Packages do not import apps. Nothing imports a file outside its package.
- When a file grows past the limit, split it by responsibility into sibling modules named for
  what they contain (for example `pricing/material.ts`, `pricing/outside.ts`), keeping the
  original path as the entry point that re-exports.
- **(CI)** Functions stay below the linter's cognitive-complexity limit; extract a named helper
  instead of nesting conditions. No nested ternaries.

## Style

- **(CI)** TypeScript: Biome via Ultracite (`pnpm check`, `pnpm fix`). Test files relax a few
  rules (inline regexes, non-null assertions); see `biome.jsonc`.
- **(CI)** Python: Ruff lint and format (`uv run ruff check`, `uv run ruff format`), configured
  in `services/engine/pyproject.toml`.
- **(CI)** Types: `pnpm typecheck` passes with no errors and no `any`.
- Only export what another module imports. Delete code that nothing uses.
- Comments say why, not what. Every exported function has a one-line doc comment when its name
  doesn't say everything.
- Files and folders: `kebab-case.ts`; React components `PascalCase`; constants `UPPER_SNAKE_CASE`.

## Data and security rules

- Every database query for shop data goes through `forOrg(database, orgId)` so it is scoped to
  one shop. Server-only modules start with `import "server-only"`.
- Migrations are additive (new columns nullable or with defaults) and every new table gets the
  row-level-security policy used by the earlier migrations. Never edit a migration that has run.
  Production migrations are applied by the owner with `pnpm migrate:deploy`.
- New environment variables go in the app's `env.ts`, `scripts/env-rules.mjs` and
  `docs/DEPLOY.md`, and are optional unless the app cannot start without them.
- Secrets live only in git-ignored env files. Never commit, log or print them.
- Data from the ERP is read-only in Takumo; changes go to the "changes for your ERP" list.
- User-facing text is plain English and never names the AI model or provider.

## Tests

- Every change to behaviour comes with a test. Bugs get a test that fails before the fix.
- **(CI)** Unit tests (`pnpm test`), engine tests (`pnpm test:engine`), mail server tests and the
  database tests on a fresh Postgres with every migration applied.
- Tests never call paid APIs; mock them. Paid evaluations (`pnpm --filter app eval:*`) run only
  when the owner approves the cost.

## Branches, commits and pull requests

- Branch from `main`; one topic per branch.
- Commit messages: a short imperative summary line, a blank line, then what changed and why.
- Open a pull request; it merges (squash) once every CI check passes. Merging to `main` deploys.
- Update `docs/STATUS.md` when a feature ships or a pending item closes.
