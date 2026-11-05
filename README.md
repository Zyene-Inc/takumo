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
  studio/     Prisma Studio (:3005)
packages/
  database/   Prisma on Supabase Postgres: factory schema, forOrg() tenant guard, seed
  engine-client/  Typed client for services/engine
  ai/         Claude models (agent/chat/extract) via the AI SDK
  auth/ design-system/ payments/ analytics/ observability/ security/ email/ …
services/
  engine/     Python FastAPI: CP-SAT scheduler + "can we take this order?" (:8000)
seed/acme-precision/   Demo shop CSVs used by db:seed and engine tests
docs/
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
#    first enable the vector extension: Supabase → Database → Extensions → vector
pnpm migrate:deploy               # tables, foreign keys, RLS policies and the vector index
SEED_ORG_ID=org_xxx pnpm db:seed  # load the demo shop into your WorkOS organization

# 4. run
pnpm dev:engine                   # engine on :8000
pnpm dev                          # app :3000, web :3001, api :3002, …
```

## Status

- ✅ Monorepo trimmed for Takumo (no CMS, i18n, Liveblocks, Storybook)
- ✅ Factory schema (work centers, parts, routings, orders, jobs, quotes, RFQs, sources, facts, agent)
- ✅ Tenant isolation: `forOrg(database, orgId)` + Supabase RLS policies
- ✅ Engine: CP-SAT scheduler, capacity check and quote estimate (`pnpm test:engine`, including random-shop plan validity checks); Docker image in `services/engine/Dockerfile`
- ✅ Phase 1: shop data import (`/onboarding`): Excel (.xlsx, .xls), OpenDocument and CSV upload, AI column mapping with an offline fallback, preview and row-level errors, re-import updates in place
- ✅ Shop editors (`/shop`, `/quotes/history`): machines, parts and routings, orders, customers, materials, past quotes; "needs review" for records Takumo had to create
- ✅ Roles: admins and planners change shop data, admins and estimators change quotes; members and operators can view
- ✅ Tests: unit tests, plus database tests for imports (`pnpm --filter @repo/ingest test:db` with `TEST_DATABASE_URL`) that CI runs on a fresh Postgres
- ✅ Phase 2: schedule board (`/schedule`): CP-SAT plan with shifts, efficiency, holidays and downtime (`/schedule/calendar`), drag an operation to pin it and re-plan around it, late and tight flags; "Can we take this order?" (`/schedule/check`): earliest date without moving anyone, who slips if it goes first, overtime / split-lot / alternate-machine levers with cost and margin, "Add to plan", and planner agree/disagree to track the 10-case goal; bottlenecks (`/schedule/bottlenecks`)
- ⏳ Phase 2 sign-off: a planner judges 10 real cases on `/schedule/check` → see docs/TAKUMO.md section 13
- ✅ Phase 3: Ask Takumo (`/ask`): Claude agent with tools for read-only SQL over shop data, document search, record lookups, the plan, capacity checks and what-if scenarios; numbered citations to every source; tables and charts; saved conversations (`/ask/history`); documents (`/knowledge`: PDF, Word, text). Golden questions: 30/30 at Phase 3, 33 now (`pnpm --filter app eval`, see `apps/app/evals/README.md`)
- ✅ Phase 4: Quote Copilot (`/quotes`): paste an RFQ email or upload it (PDF, Word, .eml with attachments, text); Claude reads it into lines matched to your customers, parts and materials, with questions for anything missing; the engine prices each quantity (machine time at each rate, material and other costs calibrated from what past jobs actually cost, the customer's usual margin with a range) and gives the earliest lead time that doesn't delay any open order, with the comparable past quotes as evidence; new parts get operations estimated from similar parts; the estimator edits and approves; quote PDF and reply email; won → order. Ask Takumo prices parts too (`estimate_quote`). Tracks how often drafts go out with small edits (the 70% goal)
- ⏳ Phase 4 sign-off: estimators send Takumo's draft with small edits (price within 5%, lead time within 2 days) on 70%+ of real RFQs, shown on the RFQ inbox
- ✅ Phase 5: tribal knowledge and calibration. Facts with history (`/knowledge/facts`): corrections told to Ask Takumo (`propose_fact`), voice and typed notes (`/knowledge/notes`, transcribed in the browser; Claude turns them into facts with the speaker's words as evidence), the shop floor and Takumo's own recalibration wait for a supervisor; approving a number changes the routing, rate or cost and supersedes the old fact, keeping the history; Ask Takumo uses and cites approved knowledge. Shop floor (`/schedule/floor`): operators log actual setup and run times, re-planning schedules only what's left; job history import (ERP actuals). Calibration (`/knowledge/calibration`): weekly setup and run-time error of planned vs actual, week-over-week trend, routing vs actual per operation; nightly recalibration proposes corrections (Vercel cron) and on demand
- ⏳ Phase 5 sign-off: setup-time error drops week over week on a real shop's floor logs, shown on the Calibration page
- ✅ Phase 6: paid launch. Billing with Stripe (Shop $499, Pro $1,499, Plant custom; 30-day trial with everything; Checkout, customer portal, webhook keeps each shop's plan; Quote Copilot and connectors on Pro; 5 users on Shop; a banner when the trial ends or a payment fails; `/settings/billing`, `/settings/team` with invitations). Onboarding: "Get Takumo running" checklist on the home page, and a one-click demo shop (separate from the real one, dates moved to today). Connectors (`/settings/integrations`): QuickBooks (customers and terms, estimates as past quotes) and Gmail (RFQ inbox: new RFQ emails become RFQs), OAuth with encrypted tokens, hourly sync. PostHog: people and shops identified, product events for the north star. `/admin` for Takumo staff: paying shops vs the goal of 3, MRR, weekly usage per shop, trial extensions for design partners
- ⏳ Phase 6 sign-off: 3 paying shops (shown on `/admin`)
- ✅ Phase 7: launch readiness. Claude cost controls: prompt caching on Ask Takumo's multi-step answers, every Claude call's tokens and cost recorded per shop (`/admin`), an optional monthly cap per shop (`AI_MONTHLY_BUDGET_USD`), cheaper and per-suite evals (`EVAL_MODEL=sonnet`, `pnpm --filter app eval:ask|eval:quote|eval:knowledge`, each run prints its cost). Launch checks: `pnpm check:env <app|api> <file> --production` and `/api/health` for uptime monitoring. Data export (Settings → Billing → Download all data; CSVs that import straight back). In-app help (`/help`). Pricing page on the marketing site. Go-live runbook: `docs/LAUNCH.md`
- ⏳ Phase 7 sign-off: design partners live on production (`docs/LAUNCH.md`)
