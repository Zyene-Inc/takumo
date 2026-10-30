# Takumo

**Your shop's master craftsman, in AI form.** An AI operations brain for job shops
and contract manufacturers: it knows your shop, checks your capacity, and answers
*"can we take this job, by when, and at what margin?"* with the evidence behind every number.

Full product and build spec: [docs/TAKUMO.md](docs/TAKUMO.md).

Built on [next-forge](https://github.com/vercel/next-forge) (Turborepo) + a Python engine.

## Layout

```
apps/
  app/        Takumo product (Next.js, :3000): Ask, Quotes, Schedule, Shop, Knowledge
  web/        takumo.ai marketing site (:3001)
  api/        Webhooks (Stripe, WorkOS org/member sync), cron (:3002)
  email/      React Email templates (:3003)
  docs/       Mintlify help center (:3004)
  studio/     Prisma Studio (:3005)
packages/
  database/   Prisma on Supabase Postgres: factory schema, forOrg() tenant guard, seed
  engine-client/  Typed client for services/engine
  ai/         Claude models (agent/chat/extract) via the AI SDK
  auth/ design-system/ payments/ analytics/ observability/ security/ email/ …
services/
  engine/     Python FastAPI: CP-SAT scheduler + "can we take this order?" (:8000)
seed/acme-precision/   Demo shop CSVs used by db:seed and engine tests
evals/  jobs/  docs/
```

## Setup

**Accounts:** WorkOS (AuthKit; free up to 1M users), Supabase (enable the `vector` extension),
Anthropic, plus optionally Stripe, Resend, PostHog, Sentry, BetterStack, Arcjet.

**WorkOS dashboard** (dashboard.workos.com → your application):
- Authentication → enable AuthKit (email + password, Google, Microsoft as you like)
- Redirects → Redirect URI `http://localhost:3000/callback`,
  Initiate login URI `http://localhost:3000/sign-in`, Sign-out redirect `http://localhost:3001`
- API Keys → copy `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` into `apps/app/.env.local` and `apps/api/.env.local`;
  set `WORKOS_COOKIE_PASSWORD` in `apps/app/.env.local` (`openssl rand -base64 32`)
- Webhooks (optional locally) → `https://<api-host>/webhooks/auth` for `user.*`, `organization.*`,
  `organization_membership.*`; put the secret in `WORKOS_WEBHOOK_SECRET`

First sign-in lands on **Create your shop**, which creates the WorkOS organization; its `org_…` ID is your `SEED_ORG_ID`.

```bash
# 1. dependencies (pnpm 10; Node ≥ 20) and Python engine (uv)
pnpm install
cd services/engine && uv sync && cd ../..

# 2. env files: fill in keys
#    apps/app/.env.local, apps/web/.env.local, apps/api/.env.local, packages/database/.env
#    (copy from the .env.example next to each)

# 3. database on Supabase
pnpm migrate                      # creates tables from packages/database/prisma/schema.prisma
#    then run packages/database/prisma/sql/001_pgvector_rls.sql in the Supabase SQL editor
SEED_ORG_ID=org_xxx pnpm db:seed  # load the demo shop into your WorkOS organization

# 4. run
pnpm dev:engine                   # engine on :8000
pnpm dev                          # app :3000, web :3001, api :3002, …
```

## Status

- ✅ Monorepo trimmed for Takumo (no CMS, i18n, Liveblocks, Storybook)
- ✅ Factory schema (work centers, parts, routings, orders, jobs, quotes, RFQs, sources, facts, agent)
- ✅ Tenant isolation: `forOrg(database, orgId)` + Supabase RLS policies
- ✅ Engine: CP-SAT scheduler and capacity check, tested on the demo shop (`pnpm test:engine`)
- ✅ Phase 1: shop data import (`/onboarding`): CSV/XLSX upload, AI column mapping with an offline fallback, preview and row-level errors, re-import updates in place
- ✅ Shop editors (`/shop`): machines, parts and routings, orders; "needs review" for machines and materials Takumo had to create
- ⏳ Phase 2: "Can we take this order?" and the schedule board → see docs/TAKUMO.md section 13
