# Where a change belongs

Use this when the table in `SKILL.md` is not enough. One responsibility per file.

## Product domains (`apps/app/lib/`)

| Folder | Owns | Does not own |
|---|---|---|
| `quotes/` | Quote draft, pricing inputs, drawings, approval | Schedule solve, ERP sync |
| `library/` | Document storage, folders, grants, access, lifecycle, provenance | Parsing a PDF into facts |
| `knowledge/` | Read, chunk, extract, and understand documents; brain and facts pipeline | Who may see a file, folder moves |
| `agent/` | Ask Takumo: conversations, tools, records the agent may use | Direct ERP writes |
| `schedule/` | Ask the engine, shape a plan or capacity check for the UI | CP-SAT model (that is `services/engine`) |
| `erp/` | ERP report intake on the app side | Spreadsheet column matching (`packages/ingest`) |
| `connectors/` | Gmail, Outlook, and other connectors | Generic auth (`packages/auth`) |
| `inbound/` | Mail and channel intake into the product | The SMTP server (`services/mail`) |
| `orders/`, `facts/`, `brief/`, `alerts/`, `phone/`, `floor/`, `export/` | That domain only | Cross-cutting UI |

Root files in `lib/` (`access.ts`, `billing.ts`, `onboarding.ts`, `cron.ts`, …) stay small. A second concern becomes a folder.

## Apps and packages

| Path | Owns |
|---|---|
| `apps/app` | The product UI and its domain logic |
| `apps/api` | Stripe, WorkOS webhooks, cron HTTP entry |
| `apps/web` | Marketing site |
| `apps/email` | Template preview only |
| `packages/database` | Prisma schema, migrations, `forOrg()`, demo seed |
| `packages/ingest` | Spreadsheet and ERP report import |
| `packages/ai` | Model access for the agent, extraction, transcription |
| `packages/engine-client` | Typed client for `services/engine` |
| `packages/email` | Templates and sending |
| `packages/auth`, `payments`, `analytics`, `observability`, `security`, `seo`, `rate-limit` | That concern, shared |
| `packages/design-system` | shadcn/ui components, providers, styles |
| `packages/next-config`, `typescript-config` | Shared tooling config |
| `services/engine` | FastAPI + OR-Tools: scheduling, capacity, quote estimates |
| `services/mail` | Inbound SMTP that forwards verified mail to the app |
| `seed/acme-precision` | Demo shop data for seed and tests |
| `scripts/` | Env, file-size, and deploy checks |
| `vendor/` | Vendored third-party code (SheetJS). Do not edit for style. |
| `docs/` | Product and deploy docs. Feature status lives in `docs/STATUS.md`. |

## Tests

| Change | Test |
|---|---|
| Pure logic | `apps/app/__tests__/<topic>.test.ts` or the package's `__tests__/` |
| Queries, RLS, tenant isolation | `*.db.test.ts` against Postgres |
| Engine maths | `services/engine/tests/test_*.py` |
| Paid model quality | `apps/app/evals/` — do not run unless the owner approves cost |

## Routes

Authenticated product UI lives under `apps/app/app/(authenticated)/<area>/`. Match the URL area to the `lib/` domain (`/library` → `lib/library`, `/quotes` → `lib/quotes`). A page file loads and renders; it does not own the rules.
