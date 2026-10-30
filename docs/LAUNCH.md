# Going live

The runbook for putting Takumo in front of design partners. `docs/DEPLOY.md` has the details of
each service; this is the order and the checks. Tick each box.

## 1. Two weeks ahead: things that take time

- [ ] **Google verification** for the Gmail connector (restricted scope `gmail.readonly`):
      submit the OAuth consent screen for verification; it includes a third-party security
      assessment and can take weeks. Meanwhile add each design partner's RFQ mailbox as a test
      user (up to 100).
- [ ] **Intuit app review** for production QuickBooks keys (questionnaire and assessment).
      Until then, design partners can upload past quotes as a spreadsheet instead.
- [ ] **Stripe account activation** (business details, bank account) so live payments work.
- [ ] **Terms of service and privacy policy**, written or reviewed by a lawyer (they must cover
      the data shops upload, the AI processing by Anthropic, connectors, and data export and
      deletion). Takumo doesn't ship placeholder legal text. Publish both on the marketing site
      and link them from sign-up.

## 2. Production services

- [ ] **Database** (Supabase, production project): `pnpm migrate:deploy` with the production
      `DIRECT_URL`; set the `takumo_reader` password and `ASK_DATABASE_URL` (DEPLOY.md 1.3).
      Turn on **point-in-time recovery** (Supabase → Database → Backups) and check that a daily
      backup exists.
- [ ] **Engine** (Render): deploy the latest `main`; `curl https://<engine-url>/health` returns ok.
- [ ] **Vercel**: `takumo-app`, `takumo-api`, `takumo-web` on `main`, with production domains
      (`app.`, `api.`, the marketing site).
- [ ] **Environment**: pull each project's production variables (`vercel env pull`) and run
      `pnpm check:env app .env.production --production` (and `api`). Every required setting
      must pass; delete the pulled file afterwards.
- [ ] **Anthropic**: a production API key in its own workspace, a **monthly spend limit** in the
      Console (Settings → Limits), and `AI_MONTHLY_BUDGET_USD` on `takumo-app` as the per-shop
      cap. Watch *Claude spend this month* on `/admin` for the first weeks.
- [ ] **Stripe live**: `STRIPE_SECRET_KEY=sk_live_… pnpm --filter @repo/payments setup-stripe`,
      the customer portal, and the live webhook (DEPLOY.md 6).
- [ ] **WorkOS production** environment: redirect URIs, the webhook to `takumo-api`, and the
      roles admin, planner, estimator, operator, member.
- [ ] **Monitoring**: Sentry (`NEXT_PUBLIC_SENTRY_DSN`) with an alert on new issues; an uptime
      check (BetterStack) on `https://<app-url>/api/health` (503 when the database is down;
      "degraded" when the engine is) and on the engine's `/health`.
- [ ] **Crons**: Vercel → takumo-app → Cron Jobs lists `/api/cron/recalibrate` (nightly) and
      `/api/cron/connectors` (hourly). Hourly crons need a Vercel Pro plan.

## 3. Smoke test on production (30 minutes)

- [ ] Sign up, create a shop, see the 30-day trial on Settings → Billing.
- [ ] Create a demo shop; build the plan; ask "What's late?" and get an answer with sources.
- [ ] Paste a sample RFQ, draft, approve, open the quote PDF.
- [ ] Record a voice note; approve the fact; see it on the routing.
- [ ] Log a job on the shop floor; Calibration shows it.
- [ ] Settings → Billing → Choose Pro with a real card, then refund it in Stripe; the plan
      shows Pro / Active within seconds.
- [ ] Connect QuickBooks (sandbox company) and Gmail (a test mailbox); both sync.
- [ ] Download all data; the zip opens and the CSVs import into a fresh shop.
- [ ] `/admin` shows the shop, its usage and its Claude spend.

## 4. Each design partner

- [ ] Create their shop with them on a call (or send the sign-up link), then find it on
      `/admin`.
- [ ] Give the 90-day design-partner trial: `/admin` → **+30 days** twice (on top of the
      30-day trial).
- [ ] Import their machines, routings, open orders and past quotes together (Phase 1's goal:
      under an hour).
- [ ] Agree on the sign-off cases: 10 capacity checks (Phase 2), the next real RFQs (Phase 4),
      four weeks of floor logs (Phase 5).
- [ ] Weekly check-in using `/admin`: questions asked, RFQs, quotes sent, Claude spend.

## Known and accepted

- `deepmerge` 4.3.1 (low severity, prototype pollution; Dependabot alert): no fixed release
  exists. It's used only by the email renderer (`html-to-text`) and the linter, never on input a
  customer controls. Recheck when a release appears.
- Gmail is limited to listed test users until Google's verification completes.
