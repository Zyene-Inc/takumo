# Takumo: Build Spec v0.1

> **Takumo** (from *Takumi* 匠, Japanese for "master craftsman")
> **One line:** An AI operations brain for job shops and contract manufacturers. It knows your shop, checks your capacity, and tells you **"can we take this job, by when, and at what margin?"** with the evidence behind every number.

Company: **Zyene** · Product: **Takumo** · Domain: **takumo.ai**

---

## 1. The problem

Small and mid-sized manufacturers (20–300 people, $5M–$100M revenue) run on:
- **Tribal knowledge:** real setup times, which machine runs which job best, and why a part fails all live in 2–3 veterans' heads. When they retire or leave, the knowledge is gone.
- **Spreadsheets and old ERPs** (JobBOSS, E2, ProShop, QuickBooks). The data is there, but nobody can ask it questions.
- **Slow, risky quoting:** an estimator takes 1–3 days per RFQ, guesses the lead time, and doesn't know whether the shop has capacity. That leads to lost jobs, missed dates and thin margins.
- **Planning by gut feel:** "Can we squeeze this 4,000-unit order in by the 30th?" is answered by walking the floor and asking around.

**The result:** lost RFQs, late deliveries, margin leaking from setup time and overtime, and a business that depends on a few people.

## 2. Who it's for (ideal customer)

| | |
|---|---|
| Primary | Job shops and contract manufacturers (CNC machining, sheet metal, fabrication, injection molding) in the US, with 20–300 employees |
| Buyer | Owner, GM or VP of Operations |
| Daily users | Estimator, production planner or scheduler, shop floor lead |
| Not now | Defense primes needing ITAR, process plants, companies with 1,000+ employees (ProDex and Cognite serve these) |

## 3. Why we win (positioning)

| | Corello | ProDex | Paperless Parts / Forgepoint | **Takumo** |
|---|---|---|---|---|
| Knowledge brain (docs + tribal) | ✅ shallow | ✅ | ❌ | ✅ **facts that keep their history** |
| Real calculation (scheduling, capacity) | ❌ | ✅ | ❌ | ✅ |
| Quote with **capacity-aware lead time + margin** | ❌ (no price) | ❌ | Partial (no capacity check) | ✅ **core feature** |
| Model recalibrates from actual job data | ❌ | ❌ | ❌ | ✅ |
| Self-serve, value in under a day, priced for small shops | ✅ | ❌ (enterprise) | ✅ | ✅ |

**The rule that makes it trustworthy:** *The AI never produces numbers.* Claude turns the question into model operations, the **engines** (scheduler, simulation, SQL) compute the answer, and Claude explains it **with sources**. Every value is tagged `data`, `stated` or `assumed`.

## 4. What we're building (MVP scope)

### Core features (v1)
1. **Shop Setup (onboarding)**: upload spreadsheets, ERP exports and PDFs. Takumo maps them to the factory schema (machines, parts, routings, orders, quotes) and asks the user to confirm anything unclear.
2. **"Can we take this order?"**: enter part, quantity and due date. Takumo runs the scheduler against current load and returns: yes or no, earliest date, which orders slip, the cheapest lever (overtime, alternate machine, split lot), and the margin impact.
3. **Quote Copilot**: send in an RFQ (email or PDF). It extracts part, quantity, material, tolerances and finish, finds comparable past jobs, estimates cycle and setup time, and gives a **suggested price and lead time** with the comparable jobs as evidence. A person approves it.
4. **Schedule Board**: Gantt view by machine, with drag to re-sequence and automatic conflict and late-order flags.
5. **Ask Takumo (chat)**: questions across all data ("Which customers' margins dropped this quarter?"). Every answer has citations.
6. **Tribal Knowledge Capture**: corrections in chat plus operator voice notes become **facts** (e.g. "Machine 4 setup for 316 stainless is 90 min, not 45"). Facts can supersede older facts and update model parameters after review.

### Not in v1
Live machine data (MTConnect/OPC UA), multi-plant, ITAR, a full simulation UI, mobile app, integrations beyond CSV/QuickBooks/Gmail.

## 5. How the app works (user flows)

```
Day 0 (onboarding, about 1 hour)
  Sign up → create shop → upload: machines.xlsx, routings.xlsx, open_orders.xlsx, past_quotes.xlsx
  → Takumo maps columns → user confirms → model built → "Your shop is loaded: 12 machines, 340 parts, 58 open orders"

Daily
  RFQ email arrives → Quote Copilot drafts quote (price + lead time + evidence) → estimator edits/approves → PDF/email
  Planner asks "Can we take 4,000 × P-1424 by Nov 30?" → scheduler runs → answer + levers → "Add to plan"
  Operator: "setup on HAAS-2 for this part is really 2 hrs" → fact captured → supervisor approves → model updated

Weekly
  Bottleneck report (machine utilization, late-risk orders, quote win rate, margin by customer)
```

## 6. System architecture

Built on **[next-forge](https://github.com/vercel/next-forge)** (Vercel's MIT-licensed Turborepo template) plus a separate Python engine.

```
┌──────────── next-forge monorepo on Vercel ────────────────────────────────────────────┐
│  apps/app  (product UI): Onboarding · Ask · Quote Copilot · Schedule · Knowledge      │
│            Server Actions → Agent orchestrator (Claude, tool use, streaming)          │
│  apps/web  (takumo.ai marketing) · apps/api (webhooks, cron) · apps/email            │
│  Auth: WorkOS AuthKit (hosted sign-in, organizations, roles, SSO-ready)               │
└───────────────┬────────────────────────┬───────────────────────────┬──────────────────┘
                │                        │                           │
        Supabase (Postgres)       services/engine (Python)     Background jobs
        • Prisma + org scoping    FastAPI on Render/Fly        (Inngest / Trigger.dev)
        • Factory schema          • /schedule  (OR-Tools CP-SAT)  • file ingest & parse
        • pgvector (doc chunks)   • /capacity  (feasibility)      • RFQ email polling
        • Storage (files)         • /quote     (cost model)       • nightly recalibration
        • facts + provenance      • /simulate  (SimPy, v2)        • reports
                │
        Connectors: CSV/XLSX · QuickBooks (OAuth) · Gmail/Outlook (RFQ inbox) · later: JobBOSS/E2/ProShop
```

## 7. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Starter / monorepo | **next-forge** (Turborepo, pnpm) | Auth, payments, email, analytics, observability and security already wired up |
| Web app | **Next.js (App Router) + TypeScript** (`apps/app`, `apps/web`, `apps/api`) | Fast to build; server actions; streaming |
| UI | next-forge `design-system` (**Tailwind + shadcn/ui**), **TanStack Table**, Gantt with **frappe-gantt** or a custom SVG component | Polished, quick |
| Auth | **WorkOS AuthKit**: hosted sign-in, organizations, roles; enterprise SSO/SCIM when a customer asks | Free up to 1M users; same provider OpenAI, Anthropic and Cursor reportedly use |
| DB / Storage | **Supabase** Postgres 16 + **pgvector** + Storage (replaces next-forge's default Neon) | Vector search and file storage in one place |
| ORM / migrations | **Prisma** (next-forge default), with raw SQL migrations for pgvector and RLS | Don't fight the template |
| Security | **Arcjet** (bot protection, rate limits; included in next-forge) | Protects the API and agent endpoints |
| Engines | **Python 3.12 + FastAPI**: **Google OR-Tools (CP-SAT)** scheduling, **HiGHS** planning, **SimPy** simulation (v2), **polars/pandas** | Best open-source optimization tools |
| Document parsing | **Docling** (PDF/DOCX tables), **openpyxl**, Claude vision for drawings | Reliable table extraction |
| LLM | **Claude** via Anthropic API: `claude-opus-5-5` (agent, hard reasoning), `claude-sonnet-5-5` (most chat), `claude-haiku-5-5` (bulk extraction, column mapping) | Strong tool use; Corello and others already validated it |
| Embeddings | Voyage AI (`voyage-3` family) or OpenAI `text-embedding-3-small` → pgvector | Cheap, good |
| Jobs / queues | **Inngest** (or Trigger.dev) | Retries, cron, long jobs |
| Email | **Resend + React Email** (`apps/email`), Gmail/MS Graph API (RFQ inbox) | |
| Observability | **Sentry** (errors), **BetterStack** (logs, uptime), **PostHog** (product analytics, session replay); all included in next-forge | |
| Hosting | **Vercel** (web), **Render or Fly.io** (Python engine), Supabase cloud | Cheap at start |
| Payments | **Stripe** (subscriptions) | |

## 8. Data model (core tables)

Defined in `packages/database/prisma/schema.prisma`. All tables include `id`, `orgId` (= WorkOS organization ID), `createdAt`, `updatedAt`, and where it matters `sourceId`, `provenance` (`data|stated|assumed`), `confidence`.

```
-- Orgs and memberships live in WorkOS; mirrored locally on shop creation and by
-- the WorkOS webhook → apps/api (roles: owner|admin|planner|estimator|operator)
orgs(workos_org_id, name, plan, stripe_customer_id), members(workos_user_id, org_id, role)

-- Shop model
work_centers(name, type, hourly_rate, shifts_json, efficiency)          -- machines/cells
calendars(work_center_id, date, available_hours, reason)                -- downtime, holidays
operators(name, skills[], hourly_rate)
materials(name, spec, unit_cost, lead_time_days)
parts(part_no, rev, customer_id, material_id, description)
routings(part_id, seq, work_center_id, setup_min, run_min_per_unit, alt_work_center_ids[])
bom_lines(parent_part_id, child_part_id, qty)

-- Demand & history
customers(name, terms, payment_behavior)
orders(customer_id, part_id, qty, due_date, status, price)
jobs(order_id, status, planned_start, planned_end, actual_start, actual_end, actual_setup_min, actual_run_min, scrap_qty)
quotes(customer_id, part_id, qty, price, lead_time_days, status: open|won|lost, est_cost, actual_cost)
rfqs(source: email|upload, raw_file_id, extracted_json, status)

-- Knowledge
sources(name, type, file_path, status, profile)                         -- every upload/connection
doc_chunks(source_id, content, embedding vector(1024), page, meta)
facts(subject_type, subject_id, attribute, value, stated_by, status: pending|approved|superseded,
      supersedes_fact_id, valid_from, valid_to, evidence)

-- Agent
conversations, messages(role, content, tool_calls_json, citations_json)
schedule_runs(input_json, output_json, objective, solver_status, created_by)
```

## 9. The AI agent (Takumo)

**Pattern:** Claude with **typed tools**. It plans, calls tools, then writes the answer with citations. It never makes up numbers.

| Tool | What it does |
|---|---|
| `query_data(sql)` | Read-only SQL on whitelisted views, scoped to the org |
| `search_docs(query, filters)` | Hybrid vector + keyword search over chunks |
| `get_entity(type, id)` / `neighbors(...)` | Pull a part, customer or machine with its links |
| `check_capacity(part, qty, due_date)` | → engine `/capacity`: feasible?, earliest date, slips |
| `run_schedule(scenario)` | → engine `/schedule`: CP-SAT plan + KPIs |
| `estimate_quote(rfq_id or spec)` | → engine `/quote`: comparables + cost build-up + suggested price |
| `propose_fact(subject, attr, value, evidence)` | Records tribal knowledge as **pending** |
| `create_artifact(type: table/chart/report/email)` | Structured output for the UI |

**System prompt rules:** cite every number (`[job #4471]`, `[routing P-1424 op 30]`); say "I don't have data for X" instead of guessing; show assumptions; ask a clarifying question when an input is ambiguous.

## 10. Engines (Python service)

- **Scheduler (CP-SAT):** a job-shop model with interval variables per operation, `NoOverlap` per work center, precedence by routing sequence, calendars as unavailable intervals, optional alternate machines, and due-date penalties. Objective: minimize weighted lateness, then makespan, then overtime. Time limit 10–30 s.
- **Capacity check:** insert the new order into the current plan, re-solve, and diff the result: on time?, which orders slip and by how many days, cheapest lever (overtime hours, alternate machine, split lot).
- **Quote model:** `cost = material + Σ(setup/qty + run) × rate + outside processing + overhead%`. Parameters are calibrated from **actual** job history, with nearest-neighbor comparables (material, qty band, process, tolerance). Output is a price range at a target margin, each part showing its evidence.
- **Recalibration (nightly):** compare planned and actual setup and run times per routing and work center → propose parameter updates as facts.
- **Simulation (v2):** SimPy for what-ifs with variability (scrap, breakdowns).

## 11. Repo structure (monorepo)

Created by `npx next-forge@latest init`, then trimmed and extended. **(new)** marks what we add; **(remove)** marks what we delete on day 1.

```
takumo/                               # next-forge Turborepo (pnpm)
├── apps/
│   ├── app/                          # ⭐ Takumo product (Next.js, port 3000)
│   │   ├── app/(authenticated)/
│   │   │   ├── onboarding/           # (new) upload + column-mapping wizard
│   │   │   ├── ask/                  # (new) chat with citations
│   │   │   ├── quotes/               # (new) RFQ inbox + Quote Copilot
│   │   │   ├── schedule/             # (new) Gantt board
│   │   │   ├── knowledge/            # (new) sources, facts review queue
│   │   │   ├── shop/                 # (new) machines, parts, routings editors
│   │   │   └── settings/             # org, members (WorkOS), integrations, billing
│   │   ├── app/sign-in, sign-up, callback/  # WorkOS AuthKit routes
│   │   ├── app/create-shop/          # first run: create or choose a shop
│   │   ├── app/api/agent/route.ts    # (new) streaming Claude tool loop
│   │   ├── app/api/ingest/route.ts   # (new) upload → engine ingest
│   │   └── lib/agent/                # (new) tools.ts, prompts.ts, citations.ts
│   ├── web/                          # takumo.ai marketing site (port 3001)
│   ├── api/                          # webhooks: Stripe, WorkOS org sync, Gmail; cron
│   ├── email/                        # React Email templates (invite, quote, alerts)
│   ├── docs/                         # Mintlify help center (keep for later)
│   ├── storybook/                    # (remove for now)
│   └── studio/                       # Prisma Studio (keep)
├── packages/
│   ├── auth/                         # WorkOS AuthKit: auth(), proxy, org helpers
│   ├── database/                     # Prisma → point at Supabase Postgres
│   │   ├── prisma/schema.prisma      # factory schema from section 8
│   │   └── migrations-sql/           # (new) pgvector, RLS, read-only views
│   ├── design-system/                # shadcn/ui (keep)
│   ├── payments/                     # Stripe (keep)
│   ├── analytics/                    # PostHog (keep; drop GA if not needed)
│   ├── observability/                # Sentry + BetterStack (keep)
│   ├── security/                     # Arcjet (keep)
│   ├── email/                        # Resend (keep)
│   ├── storage/                      # → switch to Supabase Storage
│   ├── ai/                           # → Anthropic (Claude) provider
│   ├── cms/                          # BaseHub (remove; use markdown)
│   ├── collaboration/                # Liveblocks (remove)
│   ├── internationalization/         # (remove for now)
│   ├── factory-schema/               # (new) shared zod types: Part, Routing, WorkCenter…
│   └── engine-client/                # (new) typed client for services/engine
├── services/
│   └── engine/                       # (new) Python FastAPI (uv), deployed on Render/Fly
│       ├── app/main.py
│       ├── app/scheduler/            # cpsat_model.py, capacity.py
│       ├── app/quote/                # cost_model.py, comparables.py
│       ├── app/ingest/               # parse_xlsx.py, parse_pdf.py (docling)
│       ├── app/calibrate/
│       └── tests/
├── jobs/                             # (new) Inngest functions
├── seed/                             # (new) demo shop "Acme Precision" CSVs
├── evals/                            # (new) golden Q&A per design partner
└── docs/TAKUMO.md                    # this file + ADRs
```

## 12. Security and multi-tenancy
- **Tenant isolation, layer 1 (app):** every Prisma query goes through a client extension that **requires and injects `orgId`** from the WorkOS session (`auth().orgId`). An unscoped query throws.
- **Layer 2 (database):** connect WorkOS to Supabase as a third-party auth provider, so **RLS** policies (`org_id = auth.jwt()->>'org_id'`) protect anything reached through the Supabase client (Storage, Realtime, `query_data`).
- The engine service is only called server-side, with a service key and an org-scoped payload.
- Connector credentials are encrypted with an app-side key (pgsodium/Vault) and never sent to the client.
- **Prompts and tool definitions live only on the server** (Corello's mistake was shipping them to the browser).
- `query_data` runs as a read-only role, over whitelisted views, with a row limit and a timeout.
- Audit log of agent tool calls. Aim for SOC 2 in year 1 (Vanta/Drata).

## 13. Roadmap

| Phase | Weeks | Deliverables | Done when |
|---|---|---|---|
| **0. Foundations** | 1–2 | `next-forge init`, trim unused packages, Prisma → Supabase, factory schema + RLS, WorkOS auth + org webhook sync, demo seed shop, engine skeleton, CI | Log in, create an org and see the demo shop |
| **1. Shop model + ingest** | 3–5 | XLSX/CSV upload, AI column mapping + confirmation, editors for machines/parts/routings/orders | A real shop's data loaded in under 1 hour |
| **2. Capacity + schedule** | 6–8 | CP-SAT scheduler, "Can we take this order?", Gantt board | Answers match the planner's own judgment on 10 real cases |
| **3. Ask Takumo** | 9–10 | Agent tool loop, citations, doc search, artifacts | 30 of 30 golden questions answered correctly with sources |
| **4. Quote Copilot** | 11–13 | RFQ parse (PDF/email), comparables, cost model, approve → PDF | Estimator accepts the draft with small edits 70%+ of the time |
| **5. Tribal knowledge + calibration** | 14–16 | Facts, review queue, voice notes, nightly recalibration | Model error on setup time drops week over week |
| **6. Paid launch** | 17–20 | Stripe, onboarding polish, QuickBooks + Gmail connectors, PostHog | 3 paying shops |

## 14. Design partners and metrics
- Recruit **3–5 local job shops** (state manufacturing extension programs, NTMA chapters, LinkedIn). Free for 90 days in exchange for data, weekly feedback, and a case study.
- **North-star metric:** weekly questions answered or quotes drafted per shop.
- Track: time-to-quote (target 2 days → 2 hours), quote win rate, on-time delivery %, schedule accuracy (planned vs actual), retention.
- `evals/`: 30–50 golden questions per shop, run on every release.

## 15. Pricing (start)
| Plan | Price | For |
|---|---|---|
| Shop | **$499/mo** | 1 site, 5 users, ask + capacity + schedule |
| Pro | **$1,499/mo** | + Quote Copilot, connectors, unlimited users |
| Plant | Custom | Multi-site, SSO, onboarding service |

## 16. Team (first hires)
1. **Founder/CEO** (you): product, sales, design partners
2. **Operations-research / industrial engineer**: scheduling, quote model (critical)
3. **Full-stack engineer**: Next.js + Supabase + agent
4. Advisor: an experienced job-shop owner or estimator

## 17. Main risks and how we handle them
| Risk | Mitigation |
|---|---|
| Messy data | A column-mapping wizard plus "assumed" tags; useful with partial data |
| Trust in AI numbers | Engines compute, Claude explains, every number cited |
| Long sales cycles | Self-serve trial with a demo shop; sell through associations |
| Competitors (Forgepoint, Paperless Parts) | Our edge is capacity-aware quoting plus knowledge that keeps its history, not quoting alone |

## 18. Funding path
- **Now:** NSF SBIR Project Pitch (Phase I up to ~$305K, no equity) · angels (shop owners, former Paperless Parts/Xometry people)
- **After design partners:** YC / a16z speedrun · pre-seed $250K–$750K
- **After paying shops:** seed $2–5M (Eclipse, Primary, Ironspring)

## 19. Brand checklist (do today)
- [ ] Buy **takumo.ai** (confirm price at Cloudflare, Porkbun or Namecheap)
- [ ] LinkedIn company page `/takumoai` · GitHub org `takumoai` · X `@takumo_ai` or `@gettakumo`
- [ ] Later: US trademark **TAKUMO** in classes 9 and 42 (~$350 per class)

## 20. Day-1 commands

**Accounts first:** WorkOS (AuthKit), Supabase (enable the `vector` extension), Stripe, Resend, PostHog, Sentry, BetterStack, Arcjet, Anthropic. Install the **Stripe CLI** and **Mintlify CLI** (next-forge requires them).

```bash
# 1. scaffold (choose: name "takumo", package manager "pnpm")
npx next-forge@latest init
cd takumo

# 2. trim what we don't need yet
rm -rf apps/storybook packages/collaboration packages/internationalization packages/cms
#    → then remove their imports and env vars (follow the build errors)

# 3. database → Supabase
#    set DATABASE_URL (pooled) + DIRECT_URL in packages/database/.env
#    write the section 8 models in packages/database/prisma/schema.prisma
pnpm migrate

# 4. env vars: copy .env.example → .env.local in apps/app, apps/web, apps/api and fill keys
pnpm dev        # app on :3000, web on :3001

# 5. Python engine
mkdir -p services/engine && cd services/engine
uv init && uv add fastapi uvicorn ortools highspy simpy polars openpyxl docling anthropic
uv run uvicorn app.main:app --reload --port 8000
```

**First milestone:** load the demo shop → ask *"Can we take 500 × P-1001 by next Friday?"* → get a correct answer from CP-SAT with cited inputs.
