# Design-partner kit

Phase 0 of the [product plan](../PRODUCT-PLAN.md) (F0.1, F0.2): sign 3–5 job shops, collect their
real RFQs, quotes and delivery questions, and measure Takumo against what their people actually
did. Everything a partner shares is customer data: it never goes into git.

Contents:
1. [Who to recruit](#1-who-to-recruit)
2. [Outreach email](#2-outreach-email)
3. [Pilot agreement: what it must cover](#3-pilot-agreement-what-it-must-cover)
4. [Kickoff call](#4-kickoff-call-45-minutes)
5. [Data request](#5-data-request)
6. [The answer key](#6-the-answer-key)
7. [Running the evaluation](#7-running-the-evaluation)
8. [Pilot rhythm](#8-pilot-rhythm)

---

## 1. Who to recruit
| | Ideal partner |
|---|---|
| Shop | CNC machining, fabrication or sheet metal job shop, 10–150 people |
| Quoting | 10+ RFQs a week, one or two estimators, quotes take 30+ minutes each |
| ERP | Epicor Kinetic, JobBOSS², ProShop, NetSuite or SAP Business One (aim for at least two different ERPs across partners) |
| Email | Outlook / Microsoft 365 or Gmail / Google Workspace |
| People | An owner or GM who sponsors it, plus the estimator and planner who'll use it |
| Pain | Slow quotes, lost bids, missed delivery promises, or knowledge stuck with one person |

Avoid for the first round: ITAR-registered shops (their drawings need a compliant setup we
don't have yet), and shops with no ERP at all.

---

## 2. Outreach email
> **Subject:** 15 minutes on how you quote?
>
> Hi {first name},
>
> I'm building Takumo, an assistant for job shops that drafts quotes inside your email (it reads
> the RFQ and the drawing, prices it from your own costs and past quotes, and leaves a draft reply
> in the thread for your estimator to check and send) and answers "can we ship by Friday?" from
> your actual schedule.
>
> It works on top of your ERP ({ERP}); nothing to retype, nothing new to log into every day.
>
> I'm looking for 3–5 shops to shape it with us: free during the pilot, and we measure it against
> quotes your estimator already sent, so you see real accuracy before relying on it.
>
> Would you have 15 minutes this week or next?
>
> {name}, Zyene

---

## 3. Pilot agreement: what it must cover
Have a lawyer turn this into the actual agreement; this list is what it needs to say, not legal
text.

- **Term:** 90 days, free; either side can end it with notice.
- **What the shop shares:** ERP report exports, past RFQs with drawings and the quotes sent, a few
  delivery questions with what happened, mailbox access for RFQs once connected.
- **Confidentiality:** both directions (NDA). Their data is used only to run and improve their own
  Takumo and to measure accuracy; never shown to other customers.
- **AI processing:** documents and emails are processed by our AI provider on a paid, enterprise
  tier that doesn't train on customer data. Name the subprocessors in an annex (Vercel, Supabase,
  Google Cloud, WorkOS, the inbound email provider).
- **Storage and deletion:** where data is kept; deleted within 30 days of the pilot ending if they
  don't continue.
- **No automatic sending:** Takumo only drafts; their people decide what's sent.
- **Feedback:** a 30-minute call every two weeks; permission to use anonymised results ("cut quote
  time by X%") with their approval.
- **After the pilot:** the price they'd pay if they continue (e.g. a design-partner discount).

---

## 4. Kickoff call (45 minutes)
With the owner, an estimator and a planner. Record the answers in the answer key's **Shop** sheet.

1. **Quoting today:** where do RFQs arrive (email, portals, forms, phone, EDI)? How many a week?
   Who quotes? Average minutes per quote? Win rate?
2. **Walk through one real quote** from RFQ to sent price: which screens, which spreadsheets,
   which past jobs they look at.
3. **Delivery promises:** how do they answer "can we ship by X?" today? How often are promises
   missed (on-time %)? What usually causes it: machine, people, material?
4. **ERP:** which ERP and version, cloud or on-premises? Who can create reports and scheduled
   exports? Is there an API or integration user?
5. **Email:** Outlook or Gmail? Personal mailboxes or a shared quotes@ mailbox? Can IT approve a
   connected app?
6. **What would make this a must-have** in 90 days?

---

## 5. Data request
Send this list after the call. Exports as Excel or CSV, whatever the ERP produces; column names
don't matter (Takumo maps them).

| # | Export | What it should contain |
|---|---|---|
| 1 | Machines / work centers | Name, type, hourly rate, shifts |
| 2 | Parts and routings | Part number, revision, operations: sequence, work center, setup time, run time per part |
| 3 | Customers | Name, payment terms |
| 4 | Materials | Name, spec, unit, unit cost, supplier lead time |
| 5 | Open jobs / work orders | Order number, part, quantity, due date, status, current operation |
| 6 | Stock on hand | Material, location, quantity on hand, quantity allocated |
| 7 | Open purchase orders | PO number, line, material, quantity, due date |
| 8 | Employees / operators | Name, shift, which machines they run |
| 9 | Past quotes (last 12 months) | Quote number, customer, part, quantity, price, lead time, won/lost |

Where to find exports, by ERP (check with the shop's ERP admin; menus vary by version):

| ERP | How exports are usually made |
|---|---|
| Epicor Kinetic | A BAQ (Business Activity Query) exported to Excel; BAQ Export Process can schedule it |
| JobBOSS² | Reports or list views exported to Excel |
| ProShop | Module list views exported to CSV/Excel |
| NetSuite | A Saved Search exported to CSV; can be scheduled by email |
| SAP Business One | A saved query exported to Excel |

Plus, for the answer key (section 6):
- **10 recent RFQs** exactly as received (the email saved as `.eml`, or PDF/Word) **with their
  drawings**, and the quote the estimator actually sent for each.
- **5 recent "can we ship by X?" questions**, with the answer given and what actually happened.

---

## 6. The answer key
One folder per shop, on your computer only (git ignores it):

```
apps/app/evals/partners/<shop>/        e.g. apps/app/evals/partners/acme/
  answer-key.xlsx                      a copy of answer-key-template.xlsx, filled in
  files/                               every file named in the Quotes sheet
    rfq-001.eml
    dwg-1234-01-C.pdf
```

Start from [answer-key-template.xlsx](answer-key-template.xlsx). It has three sheets.

**Shop:** one setting per row.

| Key | Value |
|---|---|
| `shop_name` | The shop's name |
| `org_id` | The shop's Takumo organization id (`org_…`), after they've signed up |
| `currency` | e.g. `USD` |
| `avg_minutes_per_quote`, `quotes_per_week`, `win_rate`, `on_time_rate` | Baselines from the kickoff call (`30%` or `0.3` both work) |

**Quotes:** one row per **price break** (a quote with 3 quantities is 3 rows with the same
`quote_id`).

| Column | Example | Notes |
|---|---|---|
| `quote_id` | `Q-001` | Groups rows into one RFQ |
| `rfq_files` | `rfq-001.eml; dwg-1234.pdf` | Files in `files/`, separated by `;`. The first is the RFQ itself |
| `received_date`, `sent_date` | `2026-10-01` | When the RFQ came in, when the quote went out |
| `customer` | `Cobalt Medical` | |
| `part_no`, `rev` | `1234-01`, `C` | As on the quote that was sent |
| `material`, `finish` | `6061-T6`, `Clear anodize Type II` | As the estimator understood them |
| `qty` | `100` | One quantity per row |
| `unit_price` | `18.40` | The price sent, per part |
| `lead_time_days` | `15` | Lead time sent, in days |
| `outcome` | `won` / `lost` / `pending` | |
| `estimator_minutes` | `75` | How long that quote took, if known |

**Feasibility:** one row per delivery question. Most useful when recorded **the day it's asked**
(older cases are marked "historical": the shop's schedule has changed since).

| Column | Example | Notes |
|---|---|---|
| `case_id` | `F-001` | |
| `asked_date` | `2026-10-20` | |
| `part_no`, `rev`, `qty` | `1234-01`, `C`, `300` | |
| `requested_date` | `2026-10-24` | What the customer asked for |
| `planner_answer` | `yes` / `no` | Could it be done by the requested date? |
| `planner_date` | `2026-10-29` | The date the planner promised |
| `actual_ship_date` | `2026-10-28` | When it really shipped (fill in later) |
| `notes` | `Lathe was down Tuesday` | Why, in the planner's words |

Keep the folder on an encrypted disk, share it only through the shop's own channels, and delete
it when the pilot ends (section 3).

---

## 7. Running the evaluation
Check the answer keys (free, no AI):
```bash
pnpm --filter app eval:partners
```
It lists every problem with its sheet and row (`Quotes row 5: unit_price must be above 0`), and
what a full run would cost.

Run it (costs money; about $0.08 per RFQ):
```bash
EVAL_CONFIRM=yes pnpm --filter app eval:partners
EVAL_CONFIRM=yes PARTNER=acme pnpm --filter app eval:partners   # one shop
```
Needs the shop's data in its Takumo organization (imported from the exports in section 5), the
scheduling engine, and the AI settings in `apps/app/.env.local`. Each RFQ goes through the same
reading and pricing as the app; the run removes the RFQs and checks it made.

Results print as a table and are saved to `apps/app/evals/results/partners-<shop>-<time>.json`
(git ignores them), with the git commit, so runs can be compared over time.

| Measure | Target (plan §10) |
|---|---|
| Lines found, revision and quantities read | 95%+ |
| Material and finish read | 90%+ |
| Price within 5% of what was sent | 70%+ |
| Lead time within 2 days of what was sent | 70%+ |
| Delivery answers agree with the planner | 8 of 10 |

Today Takumo reads the RFQ text but not the drawings themselves (that's F2.2), so expect
material and finish to be read only when the RFQ text states them.

---

## 8. Pilot rhythm
| When | What |
|---|---|
| Week 1 | Kickoff call, agreement signed, exports and answer key collected |
| Week 2 | Data imported into their Takumo organization; first evaluation run; review results with them |
| Every 2 weeks | 30-minute feedback call; evaluation re-run on new answer-key rows |
| Every day (once Phase 1–2 ship) | Their RFQs flow in; drafts appear in their mailbox |
| Day 90 | Results against their baseline; decide on continuing |
