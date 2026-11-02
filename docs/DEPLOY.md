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
3. Give Ask Takumo's read-only login a password (once per database). In the Supabase SQL
   editor, with a new value from `openssl rand -hex 24`:
   ```sql
   alter role takumo_reader password '<new password>';
   ```
   Its connection string is the app's pooled `DATABASE_URL` with the user changed to
   `takumo_reader.<project-ref>` and that password. It can only read the `ask.*` views, one
   shop at a time, read-only, with a 5-second statement timeout.

## 2. Vercel projects

For each row in the table: Vercel → Add New → Project → import `Zyene-Inc/takumo` → set the
root directory → Framework: Next.js (detected). Vercel builds the monorepo with pnpm and Turborepo;
installing generates the Prisma client (`postinstall` in `packages/database`).

**takumo-app needs Vercel Pro.** Its connector sync runs hourly (`apps/app/vercel.json`), and the
Hobby plan only allows daily cron jobs, so the deploy fails there.

Environment variables (Production and Preview). Values come from your local `.env.local` files
or the service dashboards; never commit them.

**takumo-app**
- `DATABASE_URL` (Supabase pooler, port 6543). `DIRECT_URL` (port 5432) is only for running
  migrations from your machine (step 1); the app doesn't need it
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (new value: `openssl rand -base64 32`)
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` = `https://<app-url>/callback`
- `NEXT_PUBLIC_APP_URL` = `https://<app-url>`, `NEXT_PUBLIC_WEB_URL` = `https://<web-url>`
- `ANTHROPIC_API_KEY` (Ask Takumo and AI column matching; column matching falls back to the offline matcher without it)
- `ASK_DATABASE_URL` (step 1.3): the reader's connection string; without it Ask Takumo can't query data
- `OPENAI_API_KEY` (optional): vector search over documents, and transcribing uploaded voice-note
  recordings; keyword search and recording in the browser work without it
- Or Gemini on Vertex AI for every AI feature instead of the two keys above:
  `GOOGLE_GENAI_USE_VERTEXAI` = `true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` = `global`,
  `GOOGLE_SERVICE_ACCOUNT_JSON` = the contents of a service account key with the Vertex AI User
  role (Google Cloud → IAM → Service accounts → Keys → Add key → JSON). Removing
  `GOOGLE_GENAI_USE_VERTEXAI` switches back to Claude
- `ENGINE_URL` = the engine's URL (step 4), `ENGINE_SECRET` = the same value as on the engine
- `CRON_SECRET` = a new value (`openssl rand -hex 32`): Vercel sends it to the nightly
  recalibration (`/api/cron/recalibrate`, 07:00 UTC, in `apps/app/vercel.json`); without it the
  route refuses every call and recalibration runs only from Knowledge → Calibration. The same
  secret protects the hourly connector sync (`/api/cron/connectors`).
- `STRIPE_SECRET_KEY` (step 5): billing; without it the Billing page can't take payment
- `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (step 6): product analytics
- `CONNECTOR_ENCRYPTION_KEY` = a new value (`openssl rand -base64 32`; keep it: losing it means
  every shop reconnects): encrypts QuickBooks, Gmail and Outlook tokens
- `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT` (`sandbox` or
  `production`) (step 7)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (step 8)
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (step 9)
- `ADMIN_USER_IDS`: WorkOS user ids (comma separated) of Takumo staff who can open `/admin`
- `AI_MONTHLY_BUDGET_USD` (optional): Claude spend cap per shop per calendar month; when a shop
  reaches it, Ask Takumo, quote drafting and note reading pause until the 1st. `/admin` shows each
  shop's spend.

Check a project's variables before going live (names only, never values):
from the repo root, `vercel link` to the project, `vercel env pull apps/app/.env.production`, then
`pnpm check:env app apps/app/.env.production --production` (`api` or `web` for the other
projects), then delete the file.

`NEXT_PUBLIC_WORKOS_REDIRECT_URI` is built into the app, so preview deployments send sign-in back
to the production URL. Test sign-in on the production (or staging) domain.

**takumo-api**
- `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`
- `WORKOS_WEBHOOK_SECRET` (step 3)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (step 5)
- `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (step 6)
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`

**takumo-web**
- `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WEB_URL`

Everything else in the `.env.example` files (Resend, BetterStack, Arcjet, flags) is optional;
leave it unset.

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

The engine runs CP-SAT for the schedule board, "Can we take this order?" and quote lead times
(`/quote`). It's a plain
Docker web service. Production runs it on an Oracle Cloud Always Free ARM VM ($0); Render is the
simplest paid host (Fly.io or Cloud Run work the same way).

**Oracle Cloud VM (production)**

1. Compute → Create instance: shape `VM.Standard.A1.Flex` (2 OCPU, 12 GB, Always Free), image
   Ubuntu 24.04, a new VCN with a public subnet, and your SSH public key. If Oracle says "Out of
   capacity", try the other availability domains; a Pay As You Go account (still $0 within the
   free limits) gets capacity far more easily and isn't reclaimed when idle.
2. Instance → Networking → VNIC → IP administration → Edit → **Ephemeral public IP**.
3. VCN → Security → Default Security List → Add Ingress Rules: source `0.0.0.0/0`, TCP, ports
   `80,443`.
4. On the VM: install `docker.io`, `docker-compose-v2` and Caddy, and open 80/443 in iptables.
   Oracle's Ubuntu image ends INPUT with a REJECT rule, so insert them above it, then save:
   `sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 443 -j ACCEPT`, the same for 80,
   `sudo netfilter-persistent save`.
5. On the VM, create the secret (it stays there; copy it for `takumo-app`):
   `sudo mkdir -p /etc/takumo && echo "ENGINE_SECRET=$(openssl rand -hex 32)" | sudo tee /etc/takumo/engine.env >/dev/null && sudo chmod 600 /etc/takumo/engine.env`
6. From your machine: `ENGINE_HOST=ubuntu@<ip> ENGINE_DOMAIN=<ip with dashes>.sslip.io scripts/deploy-engine.sh`.
   It copies the engine, builds it, starts it behind Caddy (HTTPS from Let's Encrypt) and checks
   `/health`. Run it again to deploy a new version. Without the secret the engine won't start.

**Render (alternative)**

1. Render → New → Web Service → `Zyene-Inc/takumo` → Runtime: **Docker**.
   Dockerfile path `services/engine/Dockerfile`, build context `.` (the repo root).
2. Instance: at least 2 CPUs and 2 GB (the solver uses several threads). Health check path `/health`.
3. Environment: `ENGINE_SECRET` = a new value (`openssl rand -hex 32`). Render sets `PORT`.
4. Put the service URL in `ENGINE_URL` and the same secret in `ENGINE_SECRET` on `takumo-app`,
   then redeploy it. On Render the engine refuses every call until `ENGINE_SECRET` is set.

Check: `curl https://<engine-url>/health` returns `{"status":"ok"}`.

### Inbound email (services/mail)

The ERP report inbox (`erp-<token>@…`, F1.3) and RFQ forwarding (`rfq-<token>@…`, F2.1) use our
own MX: `services/mail`, an SMTP receiver on the same Oracle VM that checks SPF/DKIM/DMARC and
posts each message to `takumo-app`'s `/api/inbound/email` with an HMAC signature
(`INBOUND_EMAIL_SECRET`, the same value on the VM and on `takumo-app`). It needs an MX record, TCP
25 open in the OCI security list, and `/etc/takumo/mail.env` on the VM; then
`MAIL_HOST=ubuntu@<ip> scripts/deploy-mail.sh`. Everything (webhook contract, env vars, DNS,
testing with swaks) is in [services/mail/README.md](../services/mail/README.md).

Both deploy scripts keep one Caddy site per file in `/etc/caddy/sites/*.caddy`, imported by
`/etc/caddy/Caddyfile`, so the engine's site and the mail host's certificate coexist.

## 5. Stripe (billing)

Plans: Shop $499/month (5 users), Pro $1,499/month (Quote Copilot, connectors, unlimited users),
Plant (custom, set by hand). New shops get a 30-day trial with everything in Pro. See
`packages/payments/plans.ts`.

1. Test mode first. Create the products and prices (found again by lookup key, so the app needs
   no price IDs):
   `STRIPE_SECRET_KEY=sk_test_… pnpm --filter @repo/payments setup-stripe`
2. Stripe → Settings → Billing → Customer portal: turn on switching between the two prices,
   cancelling, and updating the card.
3. Stripe → Developers → Webhooks → Add endpoint: `https://<api-url>/webhooks/payments`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET` on `takumo-api`.
4. Set `STRIPE_SECRET_KEY` on `takumo-app` and `takumo-api`; redeploy both.
5. Check: Settings → Billing → Choose Pro → pay with `4242 4242 4242 4242` → back on the page the
   plan shows Pro / Active (the webhook updates it within seconds).
6. Going live: repeat 1–4 with the live key and a live webhook.

Design partners (free for 90 days): an admin opens `/admin` and clicks **+30 days** on the shop's
trial as needed. A Plant customer: set `plan = 'plant'` on the shop's `Org` row.

## 6. PostHog (analytics)

Create a PostHog project; put its key (`phc_…`) and host (`https://us.i.posthog.com`) in
`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` on `takumo-app` and `takumo-api`. People
are identified by WorkOS user id and grouped by shop (group type `company`). Server events
(`apps/app/lib/analytics.ts`): `question_answered`, `quote_drafted`, `quote_approved`,
`rfq_received`, `capacity_checked`, `plan_built`, `fact_proposed`, `fact_reviewed`, `note_saved`,
`job_logged`, `data_imported`, `connector_connected`, `connector_synced`, `checkout_started`,
`demo_shop_created`, plus `subscription_started` / `_updated` / `_canceled` and `payment_failed`
from the Stripe webhook. The north star (docs/TAKUMO.md section 14) is `question_answered` +
`quote_approved` per shop per week; `/admin` shows it from the database too.

## 7. QuickBooks connector

1. developer.intuit.com → create an app (QuickBooks Online and Payments) → scope
   **Accounting** → Redirect URI `https://<app-url>/api/connectors/quickbooks/callback`.
2. Sandbox keys go in `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` with
   `QUICKBOOKS_ENVIRONMENT=sandbox`; test against a sandbox company.
3. Production keys need Intuit's app review (their questionnaire and assessment); then set the
   production keys and `QUICKBOOKS_ENVIRONMENT=production`.

What it reads: customers (with payment terms) and estimates from the last three years, as past
quotes. Read only. Synced on connect and hourly.

## 8. Gmail connector (RFQ inbox)

1. Google Cloud console → a project → enable the **Gmail API** → OAuth consent screen (external)
   → scopes `gmail.readonly`, `gmail.compose` and `email` → Credentials → OAuth client (web) with redirect URI
   `https://<app-url>/api/connectors/gmail/callback`. Put the client id and secret in
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. `gmail.readonly` and `gmail.compose` are **restricted scopes**: until Google verifies the app
   (including an annual third-party security assessment, CASA), only test users you list on the
   consent screen (up to 100) can connect. Add design-partner mailboxes as test users while
   verification runs, and start verification early (it takes weeks).
3. `gmail.compose` lets Takumo create reply drafts in the RFQ's thread (never send). Shops that
   connected before it was added see "Reconnect Gmail to let Takumo prepare reply drafts" on
   Settings → Integrations; reading RFQs keeps working until they do.

What it reads: new messages matching the shop's search (default: subjects like "RFQ", "request
for quote") since the last check; each becomes an RFQ in Quotes, attachments included. Read only.
Checked on connect and hourly; a message is never read twice.

## 9. Outlook (Microsoft 365) connector

One app registration serves every shop (multi-tenant). In the
[Microsoft Entra admin center](https://entra.microsoft.com), signed in to Zyene's own tenant:

1. **App registrations → New registration.** Name `Takumo`. Supported account types: **Accounts in
   any organizational directory (Any Microsoft Entra ID tenant – Multitenant)** (no personal
   Microsoft accounts: they have no shared mailboxes or tenant admins). Redirect URI: platform
   **Web**, `https://<app-url>/api/connectors/outlook/callback`. Register.
2. **Authentication → Web → Add URI:** `https://<app-url>/api/connectors/outlook/admin-consent`
   (where a shop's IT person lands after approving Takumo for their organization). Leave implicit
   grant off.
3. **API permissions → Add a permission → Microsoft Graph → Delegated permissions:**
   `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.ReadWrite.Shared`. Don't add application
   permissions and don't click "Grant admin consent" (that only affects Zyene's tenant). None of
   these need an admin by default; tenants that block user consent get the admin-consent link
   (below). `Mail.ReadWrite` is for leaving reply drafts later; Takumo never sends mail.
4. **Certificates & secrets → Client secrets → New client secret.** Expiry: 12 months or less
   (Microsoft's maximum is 24 months). Copy the **Value** right away (it's shown once) into
   `MICROSOFT_CLIENT_SECRET`; the **Application (client) ID** from Overview goes in
   `MICROSOFT_CLIENT_ID`. Put a reminder in the calendar a month before the secret expires: when it
   does, every shop's Outlook stops syncing until a new secret is deployed.
5. **Branding & properties:** set the publisher domain to a verified custom domain (not
   `*.onmicrosoft.com`), add the logo, home page, terms and privacy URLs.
6. **Publisher verification** (Branding & properties → Publisher verification → add the Partner One
   ID of Zyene's Microsoft AI Cloud Partner Program account). Needs a verified partner global
   account whose email domain matches the publisher domain, and an Application Administrator or
   Cloud Application Administrator signed in with MFA. Without it, many tenants won't let people
   approve the app themselves and the consent screen shows "unverified".

Environment: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` on takumo-app, plus the existing
`CONNECTOR_ENCRYPTION_KEY` and `NEXT_PUBLIC_APP_URL` (must be the public `https://` URL: Microsoft
posts new-mail notifications to `https://<app-url>/api/connectors/outlook/notify`, a public route
that checks each notification's secret). Without HTTPS (local development) Outlook still works,
checked hourly only.

How it works: the shop connects on Settings → Integrations (signing in with the account that owns
the RFQ mailbox). Takumo reads new Inbox mail with Microsoft Graph delta queries; emails whose
subject looks like an RFQ (same words as Gmail) become RFQs, attachments included, de-duplicated
by message id. A Graph subscription notifies Takumo of new mail within a minute or two; it lasts
under 7 days and the hourly cron (`/api/cron/connectors`) renews it when under a day is left, or
recreates it. A shop can instead read a **shared mailbox** (e.g. `rfq@shop.com`) the connected
person has Full Access to; Microsoft doesn't send notifications for shared mailboxes with delegated
access, so those are checked hourly. Disconnecting deletes the subscription and forgets the tokens.

When a shop's tenant blocks user consent, connecting shows a link
(`https://login.microsoftonline.com/organizations/v2.0/adminconsent?...`) with instructions to send
to their IT person; once an admin approves, the shop connects normally.

## 10. Check

See `docs/LAUNCH.md` for the full go-live runbook. Quick checks:

- Sign in on `https://<app-url>`, create a shop, upload `seed/samples/erp-open-orders.csv`.
- WorkOS → Webhooks → the endpoint shows successful deliveries; the new shop appears in the
  `Org` table.
- Schedule → Board → **Build the plan**; then Schedule → Can we take this order? returns an answer.
- Knowledge → upload a PDF; Ask Takumo answers a question about it and about your orders, with
  numbered sources.
- Quotes → New RFQ → paste an RFQ email → **Draft quote** shows prices, lead times and
  comparable quotes; **Approve quote**, then **Quote PDF** opens the quote.
- Knowledge → Voice notes → record or type "setup on <machine> for <part> is really 2 hours" →
  a fact shows under Knowledge → Facts; approving it changes the routing.
- Vercel → takumo-app → Settings → Cron Jobs lists `/api/cron/recalibrate` and
  `/api/cron/connectors`.
