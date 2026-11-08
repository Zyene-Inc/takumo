---
name: takumo-codebase
description: >-
  Maintain Takumo's monorepo structure, file placement, size limits, naming,
  and security rules before writing or editing code. Use when implementing a
  feature, fixing a bug, adding or moving files, refactoring, or changing
  apps, packages, services, tests, or docs in this repository.
---

# Takumo codebase

Follow this before writing code. `CONTRIBUTING.md` is the source of truth. If this skill and that file disagree, follow `CONTRIBUTING.md` and update this skill in the same change.

Do not restructure the repo. Place new code in the existing layout.

## Before you write

1. Name the one responsibility this change owns.
2. Put it in the location from the table below. Read [placement.md](placement.md) when the domain is unclear (`knowledge` vs `library`, quotes, connectors).
3. Open the file you would edit and check its length. If the edit would push a source file past **400 lines**, add a sibling module and keep the original as the entry that re-exports. Hard stop is **600** lines for source and **1,000** for tests (`pnpm check:size`).
4. Keep route files thin: load data, call `lib/`, render. Business logic goes in `apps/app/lib/<domain>/`.
5. Behavior changes need a test. Bugs need a test that fails before the fix.
6. When a feature ships or a pending item closes, update `docs/STATUS.md`.

## Where code goes

| Kind of code | Location |
|---|---|
| Pages, layouts, route handlers | `apps/app/app/…` (Next.js App Router). Thin. |
| Server actions | `actions.ts` beside the page (`"use server"`, async exports only). |
| Product business logic | `apps/app/lib/<domain>/`. One domain per folder, one responsibility per file. |
| UI building blocks | `packages/design-system`. Add with `pnpm dlx shadcn@latest add <name> -c packages/design-system` only when a page uses it. |
| Code used by more than one app | A package under `packages/` (`@repo/…`). |
| Scheduling and pricing maths | `services/engine` (Python). The app never computes schedules or prices. |
| Inbound SMTP | `services/mail`. |
| Webhooks and cron | `apps/api`. |
| Marketing site | `apps/web`. |
| Email template preview | `apps/email`. Templates that send live in `packages/email`. |
| Tests | `__tests__/` (`*.test.ts`). Database tests are `*.db.test.ts`. Engine tests are `services/engine/tests/`. |

Import packages by name (`@repo/database`, `@repo/ingest`). Never with a relative path into another package. A package lists every package it imports in its own `package.json`.

Do not add a new app, package, or service for a single feature. A new package is justified only when a second app needs the same code.

## Size

- **Hard (CI):** source ≤ 600 lines, tests ≤ 1,000 (`pnpm check:size`). Package imports stay inside the dependency list (`pnpm boundaries`): apps may import packages, packages do not import apps, and a relative import must not leave its package.
- **Soft (before you write):** new or edited application files stay near **400** lines. Functions stay near **50** lines; extract a named helper instead of nesting. No nested ternaries.
- **Exempt:** `vendor/`, `**/generated/**`, `*.d.ts`, `packages/design-system/components/ui/`, `packages/database/demo/data.ts`, `packages/database/prisma/migrations/`. Do not "fix" those for length.
- Split by responsibility into siblings named for what they hold (`pricing/material.ts`, `pricing/outside.ts`). Keep the old path only as a re-export when other modules already import it.

`quotes/` and `library/` are the largest domains. Extend them with a new file, not by growing a 500-line module.

## Naming and style

- Files and folders: `kebab-case.ts`. React components: `PascalCase`. Constants: `UPPER_SNAKE_CASE`.
- TypeScript: Biome via Ultracite (`pnpm check` / `pnpm fix`). `pnpm typecheck` must pass with no `any`.
- Python: Ruff (`uv run ruff check`, `uv run ruff format`) in `services/engine`.
- Export only what another module imports. Delete unused code.
- Comments say why, not what. One-line doc on an exported function when the name is not enough.

## Data and security

- Shop data queries go through `forOrg(database, orgId)`. Server-only modules start with `import "server-only"`.
- Migrations are additive (new columns nullable or with defaults). Every new table gets the same row-level-security policy as earlier migrations. Never edit a migration that has run. Production: `pnpm migrate:deploy`.
- New env vars go in the app's `env.ts`, `scripts/env-rules.mjs`, and `docs/DEPLOY.md`. Optional unless the app cannot start without them.
- Secrets stay in git-ignored env files. Never commit, log, or print them.
- ERP data is read-only in Takumo. Changes go to the "changes for your ERP" list.
- User-facing text is plain English and never names the AI model or provider.
- Tests never call paid APIs; mock them. Paid evals (`pnpm --filter app eval:*`) run only when the owner approves the cost.

## Do not

- Put business logic, pricing, or schedule maths in a page or in the Next.js app.
- Mix library access (folders, grants, lifecycle) into `lib/knowledge/`, or document understanding (extract, chunk, read) into `lib/library/`.
- Import another package with a relative path.
- Leave a file over the hard size limit, or push a cohesive module past ~400 without splitting.
- Skip `docs/STATUS.md` when a feature ships.
- Commit `.env`, credentials, or lockfile-unrelated generated junk.

## After you write

Run what the change touches:

- `pnpm check:size` after adding or growing source files.
- `pnpm check` and `pnpm typecheck` for TypeScript edits.
- `pnpm test` (or the package's tests). Database behavior: `*.db.test.ts`. Engine: `pnpm test:engine`.
- Ruff for Python edits under `services/engine`.
