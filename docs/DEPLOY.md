# Deploying Takumo (test environment)

Three Vercel projects from this repo, one Supabase database, one WorkOS environment, and
the scheduling engine (`services/engine`) as a Docker web service.

| Vercel project | Root directory | Test URL (example) |
|---|---|---|
| `takumo-app` | `apps/app` | `https://takumo-app.vercel.app` |
| `takumo-api` | `apps/api` | `https://takumo-api.vercel.app` |
| `takumo-web` | `apps/web` | `https://takumo-web.vercel.app` |

## 1. Database

Use a separate Supabase project for anything customers touch; the dev project is fine for a test URL.

1. Supabase → Database → Extensions → enable **vector**.
2. From your machine, with that project's URLs in `packages/database/.env`:
   ```bash
   pnpm migrate:deploy
   ```
   This creates the tables, the shop foreign keys, the RLS policies and the vector index.

## 2. Vercel projects

For each row in the table: Vercel → Add New → Project → import `Zyene-Inc/takumo` → set the
root directory → Framework: Next.js (detected). Vercel builds the monorepo with pnpm and Turborepo.

Environment variables (Production and Preview). Values come from your local `.env.local` files
or the service dashboards; never commit them.

**takumo-app**
- `DATABASE_URL` (pooler, port 6543, `?pgbouncer=true`), `DIRECT_URL` (port 5432)
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (new value: `openssl rand -base64 32`)
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` = `https://<app-url>/callback`
- `NEXT_PUBLIC_APP_URL` = `https://<app-url>`, `NEXT_PUBLIC_WEB_URL` = `https://<web-url>`
- `ANTHROPIC_API_KEY` (AI column matching; optional, falls back to the offline matcher)
- `ENGINE_URL` = the engine's URL (step 4), `ENGINE_SECRET` = the same value as on the engine

**takumo-api**
- `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`
- `WORKOS_WEBHOOK_SECRET` (step 3)
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`

**takumo-web**
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`, `NEXT_PUBLIC_API_URL`

Everything else in the `.env.example` files (Stripe, Resend, BetterStack, Arcjet, PostHog,
flags) is optional until Phase 6; leave it unset.

## 3. WorkOS

In the WorkOS dashboard (staging environment for a test URL):

1. **Redirects** → add `https://<app-url>/callback`; set the sign-in endpoint to
   `https://<app-url>/sign-in` and the sign-out redirect to `https://<web-url>`.
2. **Webhooks** → add endpoint `https://<api-url>/webhooks/auth` with events
   `user.*`, `organization.*`, `organization_membership.*`. Copy the signing secret into
   `WORKOS_WEBHOOK_SECRET` on `takumo-api` and redeploy it.
3. **Roles** must include `admin`, `planner`, `estimator`, `operator`, `member`
   (see `packages/auth/permissions.ts` for what each may change).

## 4. Scheduling engine

The engine runs CP-SAT for the schedule board and "Can we take this order?". It's a plain
Docker web service; Render is the simplest host (Fly.io or Cloud Run work the same way).

1. Render → New → Web Service → `Zyene-Inc/takumo` → Runtime: **Docker**.
   Dockerfile path `services/engine/Dockerfile`, build context `.` (the repo root).
2. Instance: at least 2 CPUs and 2 GB (the solver uses several threads). Health check path `/health`.
3. Environment: `ENGINE_SECRET` = a new value (`openssl rand -hex 32`). Render sets `PORT`.
4. Put the service URL in `ENGINE_URL` and the same secret in `ENGINE_SECRET` on `takumo-app`,
   then redeploy it. Without `ENGINE_SECRET` the engine accepts any caller, so always set it.

Check: `curl https://<engine-url>/health` returns `{"status":"ok"}`.

## 5. Check

- Sign in on `https://<app-url>`, create a shop, upload `seed/samples/erp-open-orders.csv`.
- WorkOS → Webhooks → the endpoint shows successful deliveries; the new shop appears in the
  `Org` table.
- Schedule → Board → **Build the plan**; then Schedule → Can we take this order? returns an answer.
