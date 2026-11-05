# Takumo

An AI operations layer for job shops and contract manufacturers. It sits between the shop's people
and its ERP: it reads ERP reports, RFQs and shop knowledge, drafts quotes inside the email thread,
answers "can we ship by Friday?" against real capacity, and sends each person a morning brief.
It never replaces the ERP and never asks anyone to retype ERP data.

| Document | What it covers |
|---|---|
| [docs/PRODUCT-PLAN.md](docs/PRODUCT-PLAN.md) | What we are building, phase by phase, with requirements |
| [docs/STATUS.md](docs/STATUS.md) | What is built, what is live, what is pending |
| [docs/MARKET.md](docs/MARKET.md) | The problem, customers, competitors and pricing |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Every service, environment variable and deploy step |
| [docs/LAUNCH.md](docs/LAUNCH.md) | Go-live checklist for design partners |
| [docs/RFQ-CHANNELS.md](docs/RFQ-CHANNELS.md) | How RFQs reach Takumo |
| [docs/design-partners/](docs/design-partners/README.md) | Design-partner kit and answer keys |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How the code is organized and the rules every change follows |

## Repository layout

```
apps/
  app/            The product (Next.js, :3000)
  api/            Webhooks (Stripe, WorkOS) and cron jobs (:3002)
  web/            Marketing site (:3001)
  email/          Email template preview (:3003)
packages/
  database/       Prisma schema, migrations, forOrg() tenant guard, demo seed
  ingest/         Spreadsheet and ERP report import: column matching, parsing, saving
  ai/             Model access for the agent, extraction and transcription
  engine-client/  Typed client for services/engine
  email/          Email templates and sending
  auth/ design-system/ payments/ analytics/ observability/ security/ seo/ rate-limit/
  next-config/ typescript-config/
services/
  engine/         Python (FastAPI + OR-Tools CP-SAT): scheduling, capacity checks, quote estimates (:8000)
  mail/           Inbound mail server (SMTP) that forwards verified mail to the app
seed/acme-precision/  Demo shop data used by the seed and the tests
scripts/          Environment, file-size and deploy scripts
vendor/           Vendored third-party code (SheetJS)
```

## Getting started

Requirements: Node 22, pnpm 10, Python 3.12 with [uv](https://docs.astral.sh/uv/), Docker (for database tests).

```bash
pnpm install
(cd services/engine && uv sync)

# Environment: copy each .env.example to .env.local (apps/app, apps/api, apps/web) and
# packages/database/.env, then fill in the keys. docs/DEPLOY.md lists every variable.

pnpm migrate:deploy                 # apply migrations (enable the `vector` extension first)
SEED_ORG_ID=org_xxx pnpm db:seed    # load the demo shop into your WorkOS organization

pnpm dev:engine                     # engine on :8000
pnpm dev                            # app :3000, web :3001, api :3002, email :3003
```

First sign-in lands on **Create your shop**, which creates the WorkOS organization; its `org_…`
id is your `SEED_ORG_ID`. WorkOS, Supabase and the other accounts are set up as in
[docs/DEPLOY.md](docs/DEPLOY.md).

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Unit tests for every package |
| `pnpm test:engine` | Engine tests (Python) |
| `pnpm check` / `pnpm fix` | Lint and format check / auto-fix |
| `pnpm check:size` | Fail on source files over the size limit |
| `pnpm migrate` | Create a migration after editing `schema.prisma` |
| `pnpm check:env <app> <file> --production` | Check an environment file before a deploy |

CI runs all of these, plus the database tests on a fresh Postgres, on every pull request.
Merging to `main` deploys the three Vercel projects.
