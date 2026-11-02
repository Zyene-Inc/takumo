# Takumo inbound mail (`services/mail`)

The MX for our inbound domain (e.g. `in.takumo.ai`). Shops' ERPs email nightly reports to
`erp-<token>@<domain>` (F1.3) and estimators forward RFQs to `rfq-<token>@<domain>` (F2.1). This
service receives that mail over SMTP, checks SPF/DKIM/DMARC, and hands each message to the
Takumo app over a signed HTTPS webhook. The app validates the token and processes the message.

It keeps nothing on disk: a message is held in memory only while the SMTP session is open, and the
reply to the sending server depends on the app's answer. When the app doesn't take the message
the sender keeps it and retries (451), so mail is never accepted and then lost.

Node 22 + TypeScript, [`smtp-server`](https://nodemailer.com/extras/smtp-server/) (Nodemailer)
for SMTP and [`mailauth`](https://github.com/postalsys/mailauth) for SPF/DKIM/DMARC. It is a
standalone npm package (its own `package-lock.json`), outside the pnpm workspace, so the root
`pnpm install`, Turborepo and the Vercel builds don't see it.

## What it accepts

- `RCPT TO` only for local parts matching `^(erp|rfq|docs|ask)-[a-z0-9]{8,32}$` at one of
  `MAIL_DOMAINS` (case-insensitive). Anything else: `550 5.1.1`. No relaying.
- At most 20 recipients per message (the rest get `452`).
- No `AUTH` (not advertised; attempts are refused). `STARTTLS` once a certificate is loaded.
- Messages up to `MAX_MESSAGE_BYTES` (default 25 MB), counted while streaming: `552` above it.
- Per-IP limits: new connections per minute (`421`), messages per minute (`450`), open
  connections; plus a global connection cap and idle timeouts.

One JSON line per message on stdout (time, ip, helo, envelope from, header From, recipients, size,
TLS, auth results, webhook status, SMTP result, duration). Bodies and the secret are never logged.

## Webhook contract

`POST ${WEBHOOK_URL}` (e.g. `https://takumo-app.vercel.app/api/inbound/email`). The body is the raw
message exactly as received (RFC 5322 / MIME bytes, after SMTP dot-unstuffing). Headers:

| Header | Value |
|---|---|
| `Content-Type` | `message/rfc822` |
| `X-Takumo-Timestamp` | unix seconds |
| `X-Takumo-Recipients` | comma-separated envelope recipients, lowercased, only those accepted for our domains |
| `X-Takumo-Mail-From` | envelope MAIL FROM (empty for bounces) |
| `X-Takumo-Remote-Ip` | the connecting client's IP |
| `X-Takumo-Auth` | compact JSON: `{"spf":"pass\|fail\|softfail\|neutral\|none\|temperror\|permerror","dkim":"pass\|fail\|none","dkimDomains":["example.com"],"dmarc":"pass\|fail\|none","from":"<address in the From header>"}` |
| `X-Takumo-Signature` | lowercase hex HMAC-SHA256, key `INBOUND_EMAIL_SECRET`, over the bytes of `${timestamp}.${recipients}.${mailFrom}.` followed immediately by the raw body |

Verifying on the app side (Node):

```ts
const expected = createHmac("sha256", process.env.INBOUND_EMAIL_SECRET!)
  .update(`${timestamp}.${recipients}.${mailFrom}.`)
  .update(rawBody) // Buffer, not a decoded string
  .digest("hex");
// timingSafeEqual(expected, signature), and reject timestamps older than a few minutes.
```

Test vector (also in `test/signature.test.ts`): secret `test-secret-0123456789abcdef0123456789`,
timestamp `1793577600`, recipients `erp-abcd1234@in.takumo.ai,rfq-zz99yy88xx@in.takumo.ai`,
mail from `reports@shop.example`, body
`From: reports@shop.example\r\nSubject: Nightly\r\n\r\nhello\r\n` →
`8af88ee0dff44d0f5d57747d6f5972bc7f142d0ec8ed7afdf0ee81845875a76d`.

How the auth summary is reduced: `dkim` is `pass` when any signature verifies (`dkimDomains`
lists their `d=` domains), `fail` when there are signatures but none passes, `none` without
signatures. `dmarc` is `pass` or `fail` as evaluated; `temperror`, `permerror` and "not
evaluable" (no or several From domains) are reported as `none`. `from` is the first address in the
From header (as written, not lowercased).

Response handling:

| App answers | SMTP reply to the sender |
|---|---|
| 2xx | `250` (accepted) |
| 4xx | `550` with the response's JSON `error` text if present, else a generic message (permanent; the sender bounces it) |
| 5xx, 3xx, network error, or nothing within 60 s | `451` (temporary; the sender retries) |

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `INBOUND_EMAIL_SECRET` | yes | | HMAC key, at least 32 characters (`openssl rand -hex 32`). The same value goes on `takumo-app`. |
| `WEBHOOK_URL` | yes | | `https://<app-url>/api/inbound/email` (must be https) |
| `MAIL_DOMAINS` | yes | | Comma-separated domains we accept mail for, e.g. `in.takumo.ai` |
| `MAIL_HOSTNAME` | yes in compose | `os.hostname()` | Name in the banner/EHLO, and the MX host Caddy gets a certificate for, e.g. `mx.in.takumo.ai` |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | no | | PEM files; STARTTLS is offered once they load. Polled every minute and reloaded when they change (Caddy renews them). The deploy script sets these. |
| `MAX_MESSAGE_BYTES` | no | `26214400` (25 MB) | Size limit |
| `PORT` | no | `25` | SMTP port (the container listens on 2525; compose maps host 25 to it) |
| `HEALTH_PORT`, `HEALTH_HOST` | no | `2526`, `127.0.0.1` | `GET /health` → `{"status":"ok"}` |
| `MAX_CONNECTIONS` | no | `100` | Concurrent connections, all clients |
| `MAX_CONNECTIONS_PER_IP` | no | `10` | Concurrent connections per IP |
| `CONNECTIONS_PER_IP_PER_MINUTE` | no | `60` | New connections per IP per minute |
| `MESSAGES_PER_IP_PER_MINUTE` | no | `30` | Messages per IP per minute |
| `SOCKET_TIMEOUT_MS` | no | `60000` | Idle time before a client is dropped |
| `WEBHOOK_TIMEOUT_MS` | no | `60000` | Time the app has to answer |

The service refuses to start when a required value is missing or invalid; compose refuses too.

## Deploying (Oracle Cloud VM, next to the engine)

It runs on the same VM as the engine (docs/DEPLOY.md step 4), in Docker, with Caddy obtaining the
MX host's certificate.

1. **DNS** (at the provider for the inbound domain), with `in.takumo.ai` as the example:
   - `mx.in.takumo.ai` `A` → the VM's public IP
   - `in.takumo.ai` `MX 10 mx.in.takumo.ai.`

   The MX target must be a name with an A record (not a CNAME, not an IP). No SPF/DKIM records are
   needed for receiving.
2. **OCI security list**: Networking → Virtual cloud networks → the VCN → Security → Default
   Security List → Add Ingress Rules: source CIDR `0.0.0.0/0`, IP protocol TCP, destination port
   `25`. (Ports 80/443 are already open for Caddy, which it also needs to get the certificate.)
   Oracle only blocks *outbound* port 25 by default; inbound is fine once this rule exists.
3. **Secrets on the VM** (once):
   ```bash
   sudo mkdir -p /etc/takumo && sudo tee /etc/takumo/mail.env >/dev/null <<EOF
   INBOUND_EMAIL_SECRET=$(openssl rand -hex 32)
   WEBHOOK_URL=https://<app-url>/api/inbound/email
   MAIL_DOMAINS=in.takumo.ai
   MAIL_HOSTNAME=mx.in.takumo.ai
   EOF
   sudo chmod 600 /etc/takumo/mail.env
   ```
   Copy `INBOUND_EMAIL_SECRET` to `takumo-app` on Vercel.
4. **Deploy** from your machine:
   ```bash
   MAIL_HOST=ubuntu@<ip> scripts/deploy-mail.sh   # MAIL_SSH_KEY defaults to ~/.ssh/takumo_oracle
   ```
   It copies `services/mail` to `/opt/takumo`, writes `/etc/caddy/sites/mail.caddy` for
   `MAIL_HOSTNAME` (the main Caddyfile imports `/etc/caddy/sites/*.caddy`; the engine has
   `engine.caddy`), opens TCP 25 in iptables above the INPUT chain's final REJECT rule and saves it
   with `netfilter-persistent`, waits for Caddy's certificate, writes
   `/etc/takumo/mail-runtime.env` (the caddy user's uid/gid and the certificate paths), runs
   `docker compose up -d --build`, and checks `http://127.0.0.1:2526/health` on the VM. Run it
   again to deploy a new version.

   The container runs as the caddy user (never root, all capabilities dropped, read-only
   filesystem) so it can read Caddy's private key, which Caddy keeps mode 0600. Caddy's
   certificate directory is mounted read-only at `/certs`.

Logs: `sudo docker logs -f takumo-mail-mail-1` on the VM (or `docker compose logs` in
`/opt/takumo/services/mail/deploy`).

## Testing

Unit and end-to-end tests (starts the server on a random port, sends with nodemailer to a local
mock webhook, checks the bytes and the signature; also STARTTLS and certificate reload):

```bash
cd services/mail && npm ci && npm test
```

Against the deployed server with [swaks](https://github.com/jetmore/swaks):

```bash
swaks --server mx.in.takumo.ai --port 25 \
  --from reports@your-shop.example --to erp-<token>@in.takumo.ai \
  --tls --header "Subject: swaks test" --attach @open-jobs.csv
# Expect "250 ..." when the app accepted it, "550 ..." for an unknown token.
swaks --server mx.in.takumo.ai --to nobody@in.takumo.ai --quit-after RCPT   # 550 5.1.1
```

Many home and cloud networks block outbound port 25; run swaks from a server that can send mail,
or send a real email from Gmail/Outlook to the address. Or a small Node script:

```js
// node send.mjs (from services/mail, after npm ci)
import nodemailer from "nodemailer";
const t = nodemailer.createTransport({ host: "mx.in.takumo.ai", port: 25, secure: false });
console.log(await t.sendMail({
  from: "reports@your-shop.example",
  to: "erp-<token>@in.takumo.ai",
  subject: "Nightly report",
  text: "See attached.",
  attachments: [{ filename: "open-jobs.csv", content: "Job,Qty\n1001,5\n" }],
}));
```

Note that a test sent from a host not listed in the sender domain's SPF record arrives with
`spf=fail`/`softfail`, which the app may reject (F1.3 R3).
