# Takumo product plan: the assistant inside the inbox, on top of the ERP

| | |
|---|---|
| Status | Draft for review |
| Owner | Product (Ashish) |
| Last updated | 2026-11-02 |
| Supersedes | Nothing; changes priorities in [TAKUMO.md](TAKUMO.md) from Phase 7 onward |
| Audience | Everyone building Takumo |

---

## 1. Why we are changing direction

### 1.1 The problem with what we have
Takumo today is a web app a shop has to open every day: Schedule, Shop, Quotes, Knowledge, Brain. Job shops already live in three places: their **ERP**, their **email** and the **phone**. A tool that needs its own daily visit, and its own copy of data the ERP already has, gets a good demo and then goes unused.

### 1.2 What discovery told us
| Question | Answer from shops |
|---|---|
| Which ERP? | Epicor (Kinetic), SAP, Oracle NetSuite, JobBOSS², ProShop |
| Where do RFQs arrive? | Email (Outlook or Gmail), customer portals, website contact forms, phone calls, EDI |
| How is a quote made? | Customer sends RFQ → sales receives it → estimator checks the drawings → works out material, labor and machine time → prepares the quotation → sends the price |
| How is "can we ship by Friday?" answered? | They check machine availability, worker availability, material availability and the current job schedule, then decide |

### 1.3 The new shape
**Takumo is an AI estimator and planner that works inside the shop's email, on top of its ERP.**

- The ERP stays the system of record. Takumo reads from it and never asks anyone to type the same data twice.
- Work comes to people where they already are: a drafted quote in the RFQ's email thread, an answer to "can we ship by Friday?" by reply, a short morning email.
- People only review and approve. Nothing goes to a customer without a person sending it.
- The web app becomes the back office: setup, review screens, settings.

### 1.4 What success looks like in 90 days
- 3 design-partner shops using Takumo every week, mostly through email.
- Draft quotes ready within 5 minutes of the RFQ arriving.
- 70% of drafts sent with only small edits (price within 5%, lead time within 2 days).
- Planners agree with 8 of 10 "can we ship by X?" answers.
- 3 paying shops.

---

## 2. Product principles
Every feature below follows these. A feature that breaks one is not done.

1. **No double entry.** If the ERP has it, Takumo reads it. Takumo only owns what the ERP doesn't have: facts, knowledge, documents, drafts.
2. **The ERP is the source of truth.** Values synced from the ERP are read-only in Takumo and show where they came from ("from Epicor, synced 06:02").
3. **A person approves anything that leaves the building or changes a number.** Takumo drafts; people send. Facts change records only after a supervisor approves them.
4. **Meet people where they work.** Email first, then Teams/WhatsApp. A web page is a link inside the email, not the starting point.
5. **Show the evidence.** Every number carries its source: the ERP record, the drawing area, the past quote, the document line.
6. **Never guess silently.** Ambiguous names, unreadable drawing values and missing data are flagged and asked about, not filled in.
7. **Never name the AI model or provider** in anything a user sees.
8. **Cost is visible and capped.** Every AI call is recorded per shop (`AiUsage`) and counts toward `AI_MONTHLY_BUDGET_USD`.

---

## 3. Who we build for

| Persona | Job to be done | Where they work today | What Takumo gives them |
|---|---|---|---|
| **Estimator** | Turn RFQs into accurate quotes fast | Outlook/Gmail, drawings (PDF), ERP, Excel | A draft quote waiting in the RFQ's email thread, with the drawing read and the price explained |
| **Sales / customer service** | Answer customers quickly: price, lead time, "can you ship by X?" | Email, phone | Same-day answers with evidence |
| **Planner / scheduler** | Keep orders on time; decide what slips | ERP schedule, whiteboard, Excel | A trustworthy yes/no with the reason, and what would slip |
| **Owner / GM** | Win profitable work; protect margins; don't depend on one person | Email, ERP reports | A morning brief; margins shown on every quote |
| **Shop-floor lead / quality** | Keep setups right; capture what experienced machinists know | Paper, the floor | Voice notes and documents become reviewed facts |

---

## 4. What we keep from today's build

| Existing piece | Where | Reused in |
|---|---|---|
| RFQ reading (email, PDF, Word, .eml) into lines | `apps/app/lib/quotes/extract.ts`, `intake.ts`, `email.ts` | F2.1 |
| Matching customers, parts, materials | `apps/app/lib/quotes/match.ts`, `apps/app/lib/knowledge/resolve.ts` | F1.3, F2.1, F2.2 |
| Routing proposal for new parts | `apps/app/lib/quotes/propose.ts` | F2.3 |
| Cost model, comparables, quote estimate | `services/engine/app/quote/*`, `apps/app/lib/quotes/estimate.ts` | F2.4 |
| Quote approval, PDF, reply text, outcome tracking | `apps/app/lib/quotes/approve.ts`, `pdf.ts`, `reply.ts`, `numbers.ts` | F2.5, F2.6, F2.7 |
| CP-SAT scheduler and capacity check | `services/engine/app/scheduler/*`, `apps/app/lib/schedule/check.ts` | F3.3, F3.4 |
| Spreadsheet import with AI column mapping | `packages/ingest` | F1.3 |
| Connections (OAuth, encrypted tokens, hourly sync) | `apps/app/lib/connectors/*`, model `Connection` | F1.1, F1.2, F5.x |
| Document pipeline (scans, photos, linking, facts) | `apps/app/lib/knowledge/*` | F2.2, F6.2 |
| Facts with evidence and supervisor approval | `apps/app/lib/facts/*` | F3.1, F6.1 |
| Voice transcription with shop vocabulary | `apps/app/lib/facts/transcribe.ts` | F6.1 |
| Per-shop AI cost tracking and cap | `apps/app/lib/ai-usage.ts` | All |
| Ask Takumo (agent with tools) | `apps/app/lib/agent/*` | F3.4, F4.x |

---

## 5. Roadmap at a glance

| Phase | Feature | ID | Priority | Effort (eng-weeks) |
|---|---|---|---|---|
| 0. Design partners | Design-partner program and answer keys | F0.1 | P0 | 0.5 |
| | Quote and feasibility evaluation harness | F0.2 | P0 | 1 |
| 1. Data comes in by itself | Outlook (Microsoft 365) connection | F1.1 | P0 | 1.5 |
| | Gmail: drafting permission and verification | F1.2 | P0 | 0.5 (+ Google review time) |
| | ERP report inbox | F1.3 | P0 | 2 |
| | ERP-owned fields are read-only, with provenance | F1.4 | P0 | 0.5 |
| | Stock and purchase orders | F1.5 | P1 | 1 |
| | Sync health and alerts | F1.6 | P1 | 0.5 |
| 2. Quote in the thread | RFQ intake from every channel | F2.1 | P0 | 1 |
| | Drawing reading | F2.2 | P0 | 2.5 |
| | Operations from the drawing | F2.3 | P0 | 1 |
| | Pricing with ERP costs | F2.4 | P0 | 1 |
| | Draft reply in the email thread | F2.5 | P0 | 1 |
| | One-screen quote review | F2.6 | P0 | 1 |
| | Quote outcomes and metrics | F2.7 | P1 | 0.5 |
| 3. Can we ship by Friday? | Operators, shifts and skills | F3.1 | P0 | 1 |
| | Material availability | F3.2 | P0 | 1 |
| | Engine: labor and material constraints | F3.3 | P0 | 2 |
| | Answer by email | F3.4 | P0 | 1 |
| 4. Morning brief | Daily brief by role | F4.1 | P1 | 1 |
| | Approve from email | F4.2 | P1 | 1 |
| | Alerts | F4.3 | P2 | 1 |
| 5. Native ERP connectors | Epicor Kinetic | F5.1 | P1 (on first Epicor customer) | 3 |
| | Oracle NetSuite | F5.2 | P1 (on first NetSuite customer) | 3 |
| | JobBOSS² | F5.3 | P2 | 3 |
| | ProShop | F5.4 | P2 | 3 |
| | SAP | F5.5 | P3 | 4+ |
| | Quote write-back to the ERP | F5.6 | P2 | 1 per ERP |
| 6. Knowledge in their channels | WhatsApp / SMS voice notes | F6.1 | P2 | 1.5 |
| | Document drop by email or shared folder | F6.2 | P2 | 1 |

Priorities: **P0** is needed for design partners, **P1** for paying shops, **P2** once usage is proven, **P3** later.

---

## 6. Feature specifications

Each feature has the same sections: problem, user story, requirements, data, edge cases, acceptance criteria and pointers. Requirements are numbered so tickets can reference them (e.g. "F2.2-R4").

---

### Phase 0: Design partners

#### F0.1 Design-partner program and answer keys
**Problem.** We can't tell whether a quote or a delivery answer is good without real shops' real answers.

**User story.** As the product owner, I want 3–5 shops sharing real RFQs, drawings, quotes and ERP exports, so we build against reality and measure accuracy.

**Requirements**
- R1. Sign 3–5 shops covering at least two of: Epicor, NetSuite, JobBOSS², ProShop. Paper: a short pilot agreement (data use, confidentiality, free during pilot, feedback calls every 2 weeks).
- R2. From each shop collect, under NDA, kept in an answer-key folder that git ignores (`apps/app/evals/partners/<shop>/`, on an encrypted disk) and in the shop's own Takumo organization:
  - ERP report exports: open jobs/work orders, parts with routings, customers, materials, stock on hand, open purchase orders, employees/operators.
  - **10 RFQs** with drawings and the **quote actually sent** (price per quantity, lead time). This is the quote answer key.
  - **5 "can we ship by X?" cases** with the answer given and what actually happened. This is the feasibility answer key.
  - Their email system (Outlook or Gmail) and who quotes.
- R3. Record each shop's baseline: average time to quote, quotes per week, win rate, on-time delivery %.

**Acceptance.** Answer keys for at least 3 shops are loaded into Takumo; baselines recorded.

**Kit.** Outreach email, agreement checklist, kickoff agenda, data request and answer-key guide: [design-partners/README.md](design-partners/README.md).

#### F0.2 Evaluation harness
**Problem.** Every change to drawing reading, pricing or scheduling can make results better or worse; we need to know which before shipping.

**Requirements**
- R1. `pnpm --filter app eval:partners` runs each answer-key RFQ through the real quote pipeline (intake, reading, pricing as of the day it arrived) and reports per line: lines found; revision, quantities, material and finish read; draft price vs sent price (% diff); draft lead time vs sent (days). Drawing fields are added when F2.2 ships.
- R2. The same command runs each delivery question through the capacity check and reports agree/disagree with the planner, days off vs the planner's date and vs the actual ship date; cases older than 3 days are marked historical.
- R3. Results saved as JSON with date and git commit (`apps/app/evals/results/partners-<shop>-<time>.json`), so runs can be compared.
- R4. Evals cost money: without `EVAL_CONFIRM=yes` it only checks the answer keys (free) and prints what a run would cost. Never run in CI automatically.
- R5. Answer keys are one Excel workbook per shop (`docs/design-partners/answer-key-template.xlsx`); every problem is reported with its sheet and row. The run removes the RFQs and checks it made from the shop's organization.

**Acceptance.** One command produces the accuracy table for all design partners.

---

### Phase 1: Data comes in by itself

#### F1.1 Outlook (Microsoft 365) connection
**Problem.** Most manufacturers use Outlook. Takumo only connects to Gmail.

**User story.** As an estimator, I connect my Outlook mailbox (or a shared RFQ mailbox) once, and RFQs show up in Takumo without forwarding anything.

**Requirements**
- R1. A new provider `outlook` in `apps/app/lib/connectors/config.ts` (`PROVIDERS`), with the same lifecycle as Gmail: connect, sync, disconnect, error state.
- R2. OAuth 2.0 via the Microsoft identity platform (multi-tenant app registration). Delegated scopes: `offline_access`, `User.Read`, `Mail.ReadWrite` (needed to create draft replies; F2.5). For a shared mailbox, also `Mail.ReadWrite.Shared`.
- R3. Tokens are stored encrypted in `Connection.accessToken`/`refreshToken` (existing `crypto.ts`, AES-256-GCM) and refreshed before expiry.
- R4. Read new mail with Microsoft Graph delta queries on the chosen folder (`/me/mailFolders/{id}/messages/delta`, or `/users/{shared}/...`). Store the delta link in `Connection.settings`. Run on the existing hourly connectors cron, and add Graph change notifications (webhooks) for near-real-time arrival when a shop opts in.
- R5. RFQ detection uses the same rules as Gmail (subject keywords, attachments with drawings, sender is a known customer), configurable per shop in `Connection.settings.rfqRules`.
- R6. Each detected message goes through existing `intakeRfq` with `source: "email"` and `sourceId` = Graph message id; the conversation id is kept for threading (F2.5).
- R7. Settings page (`/settings/integrations`): connect button, mailbox shown, folder picker, "test with the last 20 emails" preview (shows which would be RFQs, imports nothing).
- R8. If the shop's Entra tenant blocks user consent, show the admin-consent URL with plain instructions for their IT person.

**Edge cases.** Shared mailbox without permission → clear error naming the mailbox. Token revoked → status `error`, email to the shop admin (F1.6). The same RFQ arriving twice (reply chain) → de-duplicate by conversation id + attachment hash.

**Acceptance.** On a design partner's Outlook, a new RFQ email becomes an RFQ in Takumo within 2 minutes (webhooks) or 1 hour (cron), attachments included, with no duplicates over a week.

**Owner actions.** Register the app in Microsoft Entra, complete publisher verification, add the redirect URI. See §9.

#### F1.2 Gmail: drafting permission and verification
**Problem.** The Gmail connection is read-only (`gmail.readonly`), so Takumo can't put a draft reply in the thread. Production use outside our own domain needs Google's verification.

**Requirements**
- R1. Add scope `https://www.googleapis.com/auth/gmail.compose` (create drafts). Existing connections ask the user to reconnect once; the settings page explains why.
- R2. Drafts are created with `users.drafts.create`, with `threadId` set and `In-Reply-To`/`References` headers from the RFQ message, so they appear inside the RFQ's thread (F2.5).
- R3. Start Google OAuth app verification now. `gmail.readonly` and `gmail.compose` are restricted scopes, which require a security assessment (CASA) before public use. Until approved, design partners are added as test users (100-user limit).

**Acceptance.** A draft created by Takumo appears in the original Gmail thread; verification submitted.

#### F1.3 ERP report inbox
**Problem.** Native ERP APIs are gated per vendor and per customer (see F5). Every ERP on our list can email a saved report on a schedule.

**User story.** As a shop admin, I set my ERP to email four reports every night to my Takumo address, and Takumo stays up to date without anyone typing.

**Requirements**
- R1. Each shop gets an inbound address `erp-<shortcode>@in.takumo.ai` (shown on `/settings/integrations`, copy button). The short code is random and can be rotated.
- R2. An inbound email provider posts received mail to `POST /api/inbound/email` (provider to be chosen: Postmark Inbound, SendGrid Inbound Parse, Amazon SES or Resend Inbound). The webhook is verified with the provider's signature; unsigned requests are rejected.
- R3. Only accept mail from sender addresses the shop has allow-listed, plus SPF/DKIM pass.
- R4. Attachments `.csv`, `.xlsx`, `.xls` are imported with the existing `packages/ingest` pipeline. The first time a report arrives, the admin confirms the column mapping (existing import wizard). The mapping is saved per report (keyed by filename pattern + header row), so later reports import with no person involved.
- R5. Supported report types, mapped to models:

  | Report | Model | Key |
  |---|---|---|
  | Open jobs / work orders | `Order`, `Job` | order number + operation |
  | Parts and routings | `Part`, `Routing` | part number + rev + op |
  | Customers | `Customer` | name or ERP id |
  | Materials | `Material` | name or ERP id |
  | Stock on hand | `StockLevel` (F1.5) | material + location |
  | Open purchase orders | `PurchaseOrderLine` (F1.5) | PO number + line |
  | Employees / operators | `Operator` (F3.1) | employee id |
  | Machines / work centers | `WorkCenter` | name |

- R6. Import is an upsert: new rows created, changed rows updated, rows missing from a **full** report marked inactive (never deleted; history stays). Report type is "full" or "changes only" per mapping.
- R7. Each import writes a sync record: report, rows created/updated/inactivated/rejected, rejected rows with reasons. Shown on the integrations page.
- R8. A reply email with errors goes to the admin if a report can't be read (wrong columns, empty file).
- R9. Records imported this way carry `provenance = data` and a new `erpSource` value (e.g. "epicor-report"), used by F1.4.

**Edge cases.** The ERP renames a column → mapping fails → admin emailed with a one-click re-map link. Duplicate report the same day → the second is a no-op if the file hash matches. Report over 20 MB → rejected with a message.

**Acceptance.** For a design partner, a week of nightly reports keeps parts, routings, open jobs and customers current with zero manual imports.

#### F1.4 ERP-owned fields are read-only, with provenance
**Requirements**
- R1. Add `externalId String?` and `syncedAt DateTime?` to `Order`, `Job`, `Part`, `Routing`, `Customer`, `Material`, `WorkCenter`, `Operator`; add `@@unique([orgId, externalId])` where the ERP has stable ids.
- R2. In the Shop editors, fields of ERP-synced records are disabled, with a label "From <ERP>, synced <time>". A planner can still pin jobs on the schedule (Takumo-owned).
- R3. Facts that would change an ERP-owned field (setup time, run time, rate) are still proposed and approved in Takumo. On approval they are applied in Takumo's model and listed on a "Changes to make in your ERP" export (and written back automatically once F5.6 exists).

**Acceptance.** No ERP-synced value can be edited by hand in Takumo; every such value shows its source and sync time.

#### F1.5 Stock and purchase orders
**Problem.** "Can we ship by Friday?" depends on material. Takumo has `Material.leadTimeDays` but no stock and no open purchase orders.

**Data (new models)**
```prisma
model StockLevel {
  id         String   @id @default(uuid())
  orgId      String
  materialId String
  location   String?  // warehouse / bin, as the ERP names it
  qtyOnHand  Float
  qtyAllocated Float  @default(0)
  unit       String   // matches Material.unit
  asOf       DateTime
  externalId String?
  @@unique([orgId, materialId, location])
}

model PurchaseOrderLine {
  id         String   @id @default(uuid())
  orgId      String
  poNo       String
  lineNo     Int
  materialId String?
  supplier   String?
  qtyOrdered Float
  qtyReceived Float   @default(0)
  unit       String
  dueDate    DateTime @db.Date
  status     String   // open | partial | received | cancelled
  externalId String?
  @@unique([orgId, poNo, lineNo])
}
```
Plus `Part.materialQtyPerUnit Float?` and `Part.materialUnit String?` (how much stock one part uses), filled from the ERP's bill of materials or from approved facts.

**Requirements**
- R1. Imported by F1.3 (and F5.x later). RLS policies like every other tenant table.
- R2. Shown read-only on the material's page: on hand, allocated, incoming by date.

**Acceptance.** For a design partner, stock and open POs match the ERP's own screens on spot checks of 10 materials.

#### F1.6 Sync health and alerts
**Requirements**
- R1. Each connection and each report shows: last success, last error, rows changed.
- R2. If a nightly report hasn't arrived by 10:00 shop time, or a mailbox connection errors, email the shop admin once a day until fixed.
- R3. `/admin` (staff) lists shops with failing syncs.

**Acceptance.** Breaking a partner's report (rename a column) produces an admin email within a day.

---

### Phase 2: Quote in the email thread (the wedge)

#### F2.1 RFQ intake from every channel
**Requirements**
- R1. **Email (Outlook, Gmail):** F1.1/F1.2 → existing `intakeRfq`.
- R2. **Customer portals:** the estimator forwards the portal's notification or downloads the RFQ package and drops it on `/quotes` or emails it to `rfq-<shortcode>@in.takumo.ai` (same inbound pipeline as F1.3, different address). Zip files are unpacked; PDFs, images, STEP/IGES are kept (3D files stored for reference only in v1).
- R3. **Website contact forms:** documented setup to send form submissions to the RFQ address.
- R4. **Phone calls:** "New RFQ from a call" on `/quotes` with the existing Dictate button; the transcript becomes the RFQ body.
- R5. **EDI:** out of scope for v1; listed in §12.
- R6. Every RFQ records its channel (`Rfq.source`: email | portal | form | phone | upload | paste) for metrics.
- R7. De-duplication: same sender + same attachments within 7 days → link to the existing RFQ instead of creating a new one.

**Acceptance.** RFQs from all four v1 channels appear in the RFQ inbox with their attachments and channel.

#### F2.2 Drawing reading
**Problem.** The estimator's slowest step is reading the drawing. Takumo today reads only the RFQ's text and guesses operations from similar parts.

**User story.** As an estimator, when an RFQ arrives with a drawing, Takumo has already read the title block, material, size, features and critical tolerances, and shows me where on the drawing each came from.

**Requirements**
- R1. For each RFQ attachment that is a drawing (PDF or image; detected by title block/dimension layout), run a drawing reader (vision model on each sheet, using the page-image path from `lib/knowledge/read.ts`).
- R2. Extract, as structured output:

  | Group | Fields |
  |---|---|
  | Title block | part number, revision, title, drawing number, scale, sheet n of m, units (in/mm), general tolerance block, drawn/approved dates |
  | Material | material callout as written (e.g. "AL 6061-T6 PER AMS-QQ-A-250/11"), normalized grade, condition, spec |
  | Finish & treatment | anodize type/class/color, plating, heat treat, passivation, paint; with spec numbers |
  | Size | overall envelope (L × W × H or Ø × L), and the suggested stock size and form (bar, plate, tube) |
  | Features | holes (count, size, thru/blind), threads (spec, depth, count), pockets, slots, bores, chamfers/radii, knurls, keyways |
  | Tolerances | the tightest dimensional tolerances; any GD&T frames (symbol, value, datums); surface finish (Ra) |
  | Notes | numbered drawing notes verbatim; customer spec references (AS9100, ITAR, FAI, CoC, material certs) |
  | Quantity | quantities, if on the drawing |

- R3. Every value has: `confidence` (high/medium/low), the `sheet` and a bounding box (`[ymin, xmin, ymax, xmax]`, 0–1000) where it was read, and the text as printed.
- R4. Values are matched to the shop's records (material → `Material`, part → `Part`, customer spec → known customer requirements) with the existing resolver; unmatched values are listed, not guessed.
- R5. **Requirements check:** compare the drawing against what the shop can do and flag:
  - material the shop has never bought
  - finish or process the shop outsources (from approved facts or a shop setting)
  - tolerance tighter than the shop's stated capability per machine type (shop setting, default ±0.0005 in)
  - envelope larger than any machine's work envelope (F3.1-R6)
  - certifications required that the shop hasn't marked as held

  Each flag is shown to the estimator as "check this", with the drawing area.
- R6. Results are saved on the RFQ line (`RfqLine.tolerances`, `finish`, `materialText`, plus a new `RfqLine.drawing Json` holding the full extraction and boxes).
- R7. Low-confidence or conflicting values (title block rev ≠ RFQ email rev) are listed as questions for the customer in the draft reply (F2.5).
- R8. Drawings with several parts: one RFQ line per part number found; the estimator can merge or split.

**Edge cases.** Scanned, rotated or handwritten drawings → read with lower confidence and flagged. Metric drawing for an inch shop → units shown clearly, never converted silently. 3D-only RFQ (no drawing) → "No drawing: ask the customer for a PDF drawing" question.

**Acceptance.** On the answer-key drawings (F0.1): material, revision and finish read correctly on at least 90%; the tightest tolerance found on at least 80%; zero silently wrong values (every miss is either correct or flagged low-confidence).

**Pointers.** `lib/knowledge/read.ts` (page images to the vision model), `lib/knowledge/resolve.ts` (matching), `lib/quotes/extract.ts` (RFQ lines).

#### F2.3 Operations from the drawing
**Requirements**
- R1. If the part exists in the ERP with a routing, use that routing (and approved facts) as is.
- R2. Otherwise propose a routing from (a) the drawing's features and envelope, (b) the most similar past parts (existing `proposeRouting`), (c) the shop's machines and their types. Each operation: machine (with alternates), setup minutes, run minutes per part, and the reason ("3 threaded holes and a pocket → mill op on HAAS-VF2, like P-2001").
- R3. Outside processes (anodize, heat treat, plating) become outside operations with the shop's usual supplier lead time and cost (from purchase history, or asked).
- R4. Every proposed time shows its basis: similar part, approved fact, or a default (default values are flagged).

**Acceptance.** For answer-key RFQs with a new part, the proposed total machine time is within 25% of the estimator's on 7 of 10.

#### F2.4 Pricing with ERP costs
**Requirements**
- R1. Material cost: stock size from F2.2 × material price from the latest purchase-order prices (F1.5) or `Material.unitCost`, plus the shop's material markup; shows which PO price was used and its date.
- R2. Labor and machine cost: proposed times × `WorkCenter.hourlyRate` (ERP-synced) or the shop's labor rate; setup spread over the quantity.
- R3. Outside processing cost from R3 of F2.3.
- R4. Margin: the customer's usual margin from past quotes (existing engine), with the range; the owner can set floors per customer.
- R5. Price breaks per requested quantity; lead time from the capacity check (existing) including material arrival (F3.2).
- R6. The price explanation lists every component with its source, in the review screen and (optionally) in the draft.

**Acceptance.** For answer-key RFQs, draft unit price within 5% of the sent price on 7 of 10 lines (after F2.2–F2.3).

**Pointers.** `services/engine/app/quote/cost_model.py`, `estimate.py`; `apps/app/lib/quotes/estimate.ts`.

#### F2.5 Draft reply in the email thread
**User story.** As an estimator, I open the RFQ email in Outlook and find Takumo's draft reply already in the thread, with prices, lead times and any questions. I edit and press Send.

**Requirements**
- R1. When an RFQ's estimate is ready, create a **draft** reply in the original thread:
  - Outlook: Graph `createReply` on the RFQ message, then update the draft body.
  - Gmail: `users.drafts.create` with `threadId` and reply headers (F1.2).
- R2. Draft content (from the shop's template; existing `reply.ts` text as the default):
  - greeting by the sender's first name
  - per line: part number, rev, quantity breaks, unit price, extended price, lead time
  - assumptions (material, finish, tolerance notes)
  - questions for the customer (F2.2-R7)
  - quote validity (shop setting, default 30 days) and the shop's signature
  - quote PDF attached (existing `pdf.ts`), numbered with the shop's quote numbering
- R3. A private note is **not** put in the draft. The estimator's view of the reasoning is in the review link, which is added to a separate internal notification, never in the customer-facing draft.
- R4. Takumo never sends. If the estimator deletes the draft, nothing happens. If the RFQ is re-estimated, the draft is replaced only if the estimator hasn't edited it (body hash check); otherwise a new draft is added with "(updated)".
- R5. The RFQ status in Takumo becomes `drafted`; when Takumo sees the reply sent from the mailbox (sync), status becomes `quoted` and the sent prices are captured for F2.7 (compared with the draft).
- R6. A notification email/Teams message to the estimator: "Draft ready for RFQ-0123 from Cobalt Medical — 3 lines, 2 questions. Review: <link>".

**Edge cases.** RFQ from a portal or phone (no thread) → the draft is a new email to the contact if known, else a downloadable PDF only. Several estimators share a mailbox → draft created in the shared mailbox.

**Acceptance.** For a design partner, drafts appear in the right Outlook thread within 5 minutes of arrival for 9 of 10 RFQs; sent prices are captured automatically.

#### F2.6 One-screen quote review
**Requirements**
- R1. `/quotes/<rfq>` redesigned as one screen: drawing viewer on the left with highlighted areas (from F2.2 boxes), price build-up on the right (material, operations, outside, margin), questions and flags at the top.
- R2. Click any value to see its source (drawing area, PO, past quote, fact).
- R3. Edit any value; the price recalculates; "Update draft" rewrites the email draft (F2.5-R4).
- R4. Opened from the link in the notification; works on a laptop screen and is readable on a phone.

**Acceptance.** An estimator can check and adjust a 3-line RFQ in under 5 minutes in usability tests with two partners.

#### F2.7 Quote outcomes and metrics
**Requirements**
- R1. Capture sent price/lead time (F2.5-R5), and won/lost from: the ERP (an order for that part and customer within 60 days) or a one-click "won/lost" in the review screen or the morning brief.
- R2. Metrics per shop, shown on `/quotes` and `/admin`: time from RFQ arrival to draft, time to sent, % sent with small edits (existing `acceptedWithSmallEdits`), win rate, average margin.

**Acceptance.** Metrics show for each design partner with no manual entry beyond won/lost clicks.

---

### Phase 3: "Can we ship by Friday?"

#### F3.1 Operators, shifts and skills
**Problem.** Machines don't run without people. The `Operator` model exists (`name`, `skills`, `hourlyRate`) but the engine ignores it.

**Requirements**
- R1. Extend `Operator`: `externalId`, `active`, `shift` (same shape as `WorkCenter.shifts`), `workCenterIds String[]` (machines they can run), `canRunUnattended Boolean` (for lights-out / multi-machine).
- R2. Imported from the ERP employee report (F1.3) where available; otherwise a simple editable table on `/shop/operators`.
- R3. Time off: operator calendar exceptions (vacation, sick), like `CalendarDay` for machines; imported or entered.
- R4. Per work center: `operatorsPerMachine Float` (default 1; 0.5 means one person runs two machines).
- R5. Validation: a machine with no qualified operator on a shift is shown as unavailable on that shift, and flagged on the schedule.
- R6. Work envelope per machine (`WorkCenter.envelope Json`: max X/Y/Z or max diameter/length) for F2.2-R5.

**Acceptance.** For a design partner, the roster matches who actually runs which machines (checked with the shop lead).

#### F3.2 Material availability
**Requirements**
- R1. For each order, compute the **material-ready date**: if `qtyOnHand − qtyAllocated` covers `qty × Part.materialQtyPerUnit`, today; else the due date of the earliest open PO line that covers the shortfall; else today + `Material.leadTimeDays` (flagged "not ordered yet").
- R2. Allocation: open orders consume stock in due-date order, so two orders don't both count the same bar.
- R3. The material-ready date becomes the order's `release_date` sent to the engine (field already exists in `services/engine/app/models.py`).
- R4. Shown on the order and in every feasibility answer: "Material: 12 ft of 2 in 6061 on hand" or "arrives Thu Nov 12 on PO-4471".

**Acceptance.** On spot checks with a partner, material-ready dates match what their buyer would say for 9 of 10 orders.

#### F3.3 Engine: labor and material constraints
**Requirements**
- R1. `ScheduleRequest` gets `operators: [{ id, shift windows, work_centers, unattended }]` and `operators_per_machine` per work center.
- R2. CP-SAT model: an operation on a machine needs a qualified operator for its setup (always) and its run (unless the machine is marked unattended for runs). v1 models operator **capacity per qualification group** as a cumulative constraint per shift; v2 assigns named operators.
- R3. `release_date` from F3.2 bounds each order's first operation.
- R4. The capacity check (`/capacity`) explains a "no" in terms people use: "HAAS-VF2 is free Thursday, but no one qualified on it is on second shift", "material arrives Friday 10:00".
- R5. Levers extended: overtime for a named operator group, another qualified operator, expedite material (enter a new date), alternate machine.
- R6. Performance: a 50-machine, 300-open-job shop solves within the existing time limit (10 s default, `time_limit_s`).
- R7. Engine tests: random-shop validity tests extended to check no operation runs without a qualified operator and none starts before material-ready.

**Acceptance.** All existing engine tests pass; new tests pass; feasibility answer key (F0.2) agreement ≥ 8/10.

**Pointers.** `services/engine/app/models.py`, `scheduler/cpsat_model.py`, `scheduler/capacity.py`; `apps/app/lib/schedule/request.ts`, `check.ts`.

#### F3.4 Answer by email
**User story.** As sales, I forward a customer's "can you do 300 by Friday?" to `ask-<shortcode>@in.takumo.ai` (or ask in the Teams app later) and get a reply in minutes.

**Requirements**
- R1. Inbound address `ask-<shortcode>@in.takumo.ai`; only mail from the shop's members' addresses is accepted.
- R2. Takumo answers in the same thread, from Ask Takumo with the capacity tools, with:
  - **Yes/No and the earliest date** without moving other orders
  - **Why:** machine, operators, material, each with its source
  - **If it goes first:** which orders slip and by how much
  - **Ways to make it:** overtime, alternate machine, expedite material, with cost
  - a link to add it to the plan (Takumo plan only; nothing is written to the ERP in v1)
- R3. If the part or quantity is unclear, Takumo replies with one question instead of guessing.
- R4. Response within 3 minutes; every answer logged as a conversation in Ask Takumo history.
- R5. Microsoft Teams bot with the same behavior: P2, after email proves out.

**Acceptance.** Partners use it at least weekly; planner agrees with ≥ 8 of 10 answers.

---

### Phase 4: Morning brief

#### F4.1 Daily brief by role
**Requirements**
- R1. One email per person at a time they choose (default 06:30 local), weekdays.
- R2. Content by role (planner, estimator, owner, supervisor), only sections with something in them:
  - **Late / at risk:** orders projected late, with the cause (machine, operator, material) and the best lever
  - **Today's bottleneck** machine and its load
  - **Quotes waiting:** drafts not sent for more than 24 h; RFQs older than 2 days with no draft
  - **Facts to approve:** count and the top 3, with approve buttons (F4.2)
  - **Material short this week**
  - **Sync problems** (admin only)
- R3. Every line links to the right screen; the email reads well on a phone.
- R4. Unsubscribe per section and entirely; never sent when empty.

**Acceptance.** Partners open the brief 3+ days a week (tracked by link clicks, not open pixels).

#### F4.2 Approve from email
**Requirements**
- R1. Approve / reject buttons for facts, and "mark won/lost" for quotes, as signed single-use links (HMAC, 72-hour expiry, bound to the user).
- R2. The link opens a confirmation page showing what will change and asks the user to confirm; one click more. No state changes on a GET request alone.
- R3. Role checks are the same as in the app (`knowledge:review`, `quotes:write`).

**Acceptance.** A supervisor can approve a fact from their phone in two taps.

#### F4.3 Alerts
**Requirements**
- R1. Real-time (within 15 minutes of the data changing) email or Teams message for: a new order that makes another order late; a machine marked down; material PO pushed past an order's start; an RFQ from a top-10 customer.
- R2. Each alert type can be turned off per person; at most one alert per hour per type, batched.

**Acceptance.** Alerts fire correctly in a replay of a week of a partner's data, with no more than 3 per person per day on average.

---

### Phase 5: Native ERP connectors
Built when a paying customer runs that ERP. Each replaces the nightly report (F1.3) for that shop with near-real-time sync. Each connector:

- uses a dedicated, least-privilege integration user created by the shop's ERP admin
- reads the same entities as F1.3-R5, mapped to the same models, with `externalId`
- syncs changes every 15 minutes (or via the ERP's events where offered)
- shows health as in F1.6
- is read-only until F5.6

| ID | ERP | Access (as researched 2026-11) | Notes |
|---|---|---|---|
| F5.1 | **Epicor Kinetic** | REST/OData v4 per customer instance; API key + user, or OAuth via Epicor IdP | Most open. Key tables: Job Head, Job Operations, Part, Customer, PO. Instance URL differs per customer |
| F5.2 | **Oracle NetSuite** | SuiteTalk REST + SuiteQL; token-based auth or OAuth 2.0 | Manufacturing objects depend on the shop's NetSuite edition (Work Orders, Routings with Advanced Manufacturing) |
| F5.3 | **JobBOSS²** | API exists but gated: the shop enables an Integration Engine API user; client id/secret, OAuth token | Confirm access terms with ECI; on-prem vs cloud deployments differ |
| F5.4 | **ProShop** | Reported GraphQL API for customers only (unverified); no self-serve | Confirm with Adion Systems via the first ProShop customer |
| F5.5 | **SAP** (Business One / S/4HANA) | Service Layer (B1) / OData (S/4) | Larger plants; later |

#### F5.6 Quote write-back
**Requirements**
- R1. When an estimator approves a quote in Takumo, create it as a quote/estimate in the ERP (where the API allows), with a link back.
- R2. Approved facts that change ERP-owned values produce a change request in the ERP where supported, otherwise stay on the "changes to make in your ERP" list (F1.4-R3).
- R3. Every write is logged with the user who approved it; failures are retried and reported.

**Acceptance.** For the first native-connector customer, approved quotes appear in the ERP without re-typing.

---

### Phase 6: Knowledge in their channels

#### F6.1 WhatsApp / SMS voice notes
**Requirements**
- R1. A shop number (Twilio, or WhatsApp Business via a provider). Operators register their phone once (code sent by SMS).
- R2. A voice note or text sent to the number goes through the existing note pipeline (`saveNote`): transcribed with the shop's vocabulary, facts proposed for review with the speaker's words.
- R3. Takumo replies with a short confirmation ("Got it: 2 facts for your supervisor to review").
- R4. Unregistered numbers get no reply and nothing is stored.

**Acceptance.** Operators at a partner shop send at least 5 notes a week in the pilot month.

#### F6.2 Document drop by email or shared folder
**Requirements**
- R1. Documents emailed to `docs-<shortcode>@in.takumo.ai` from members go through the document pipeline (`ingestDocument`), with the result emailed back (linked records, facts proposed).
- R2. Optional: a SharePoint/OneDrive or Google Drive folder watched for new files (P3).

**Acceptance.** A setup sheet emailed in appears on the Knowledge page, linked to its part, with facts proposed.

---

## 7. Paused or reduced
- New web dashboards and Brain page polish: paused.
- Manual data-entry screens for anything an ERP provides: become read-only for synced shops (F1.4).
- QuickBooks connector: kept for very small shops; no new work.
- Calibration page: kept; its corrections reach people through the morning brief (F4.1).

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| **Tenancy** | Every new table has `orgId`, is accessed through `forOrg()`, and has an RLS policy (as in `20261105090000_audit_fixes`) |
| **Secrets** | OAuth tokens and API keys encrypted with `CONNECTOR_ENCRYPTION_KEY` (AES-256-GCM, existing `crypto.ts`); never logged |
| **Inbound email** | Provider signature verified; sender allow-list; SPF/DKIM pass; attachments scanned for type and size; zip bombs rejected |
| **Customer-facing output** | Takumo creates drafts only; nothing is sent to a customer automatically |
| **AI** | Every call recorded in `AiUsage` with its feature; counts toward `AI_MONTHLY_BUDGET_USD`; model and provider names never shown to users |
| **Evidence** | Every number shown to a user can be traced to its source (record, document area, PO, past quote, fact) |
| **Latency** | RFQ email → draft in thread: p90 under 5 minutes. "Can we ship" reply: p90 under 3 minutes. Web pages: p75 under 2 s |
| **Reliability** | Inbound and sync jobs are idempotent (message id / file hash); retried with backoff; failures visible (F1.6) |
| **Data retention** | Raw inbound emails and attachments kept 90 days, extracted data for the life of the account; deleting a shop deletes everything (existing cascade) |
| **Audit** | Who approved each fact, quote and write-back, and when |
| **Accessibility** | Review screens keyboard-usable; emails readable without images |

---

## 9. Owner actions and external dependencies

| # | Item | Needed for | Lead time | Owner |
|---|---|---|---|---|
| 1 | Sign 3–5 design-partner shops; collect data (F0.1) | Everything | 1–3 weeks | Ashish |
| 2 | Microsoft Entra app registration (multi-tenant), publisher verification | F1.1 | 1–2 weeks | Ashish |
| 3 | Google OAuth verification for `gmail.readonly` + `gmail.compose`, including CASA security assessment | F1.2 for shops outside our domain | 4–8 weeks; start now | Ashish |
| 4 | Domain for the app (e.g. `app.takumo.ai`) and inbound mail domain (`in.takumo.ai`) with MX records | F1.3, F2.1, F3.4 | Days | Ashish |
| 5 | Choose the inbound email provider (Postmark / SendGrid / SES / Resend) and create the account | F1.3 | Days | Ashish |
| 6 | Roll the WorkOS webhook secret (exposed earlier) | Security | Minutes | Ashish |
| 7 | Replace the Vertex service-account key that was pasted in chat; budget alert on the Google Cloud project | Security, cost | Minutes | Ashish |
| 8 | WorkOS production environment, Supabase Pro, Vercel secrets as "Secret" type | Paying customers | Days | Ashish |
| 9 | Twilio / WhatsApp Business account | F6.1 | 1–2 weeks (WhatsApp approval) | Ashish |
| 10 | ERP API access per customer (integration user) | F5.x | Per customer | Customer's ERP admin |

---

## 10. Metrics

| Metric | Definition | Target (90 days) | Source |
|---|---|---|---|
| Time to draft | RFQ received → draft in thread | p90 < 5 min | F2.5 timestamps |
| Time to quote | RFQ received → reply sent | Down 50% vs baseline | F2.7 |
| Draft accuracy | Sent with small edits (price ±5%, lead time ±2 days) | ≥ 70% | `acceptedWithSmallEdits` |
| Win rate | Quotes won / quoted | Up vs baseline | F2.7 |
| Feasibility accuracy | Planner agrees with "can we ship" answer | ≥ 8/10 | F0.2, F3.4 feedback |
| Promise kept | Orders shipped by the date Takumo said | ≥ 90% | ERP shipments vs answers |
| Weekly engagement | Days per week a shop acts on Takumo (draft sent, answer used, fact approved, brief link clicked) | ≥ 3 | Events |
| Manual entry | Records typed into Takumo that the ERP has | 0 | Audit |
| Paying shops | Active subscriptions | 3 | Stripe |
| AI cost per shop | Monthly AI spend | < 10% of plan price | `AiUsage` |

---

## 11. Timeline (one engineer plus AI pair-programming)

| Weeks | Work | Milestone |
|---|---|---|
| 1 | F0.1, F0.2, owner actions 2–7 started | Answer keys loaded |
| 1–3 | F1.1, F1.2, F1.3, F1.4 | Partner data flows in nightly; RFQs arrive from Outlook |
| 3–4 | F1.5, F1.6, F2.1 | Stock and POs in; all RFQ channels |
| 4–7 | F2.2, F2.3, F2.4, F2.5, F2.6, F2.7 | **Drafts in the thread for partners (the wedge)** |
| 6–9 | F3.1, F3.2, F3.3, F3.4 | "Can we ship" answered by email with operators and material |
| 8–10 | F4.1, F4.2 | Morning brief live |
| 10+ | F5.x on demand, F4.3, F6.x | First native ERP connector with the first paying customer |

---

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Google restricted-scope verification takes long or fails | Gmail drafts blocked for outside shops | Start now; Outlook first (most manufacturers); test-user mode for partners meanwhile |
| Shop IT blocks third-party mail apps | No Outlook connection | Admin-consent flow with a one-page security note; fallback: forward RFQs to `rfq-…@in.takumo.ai` and copy the reply from the review screen |
| ERP report formats vary per shop | Imports break | Saved mappings per report; re-map in one click; sync alerts |
| Drawing reading misses critical tolerances | Wrong prices | Confidence + "check this" flags; never silent; answer-key accuracy gate before rollout |
| Labor model too simple for some shops | Wrong "can we ship" | v1 group capacity, v2 named operators; collect disagreements from planners |
| AI cost per shop too high | Margin | Cheapest model per step; per-shop cap; cost shown in evals before shipping |
| Customer data sent to an AI provider | Trust, ITAR | Paid enterprise tier (no training on data); state data handling in the pilot agreement; ITAR shops: an opt-out of AI drawing reading until a compliant setup exists |
| Partners don't change habits even in email | Low engagement | Weekly check-ins; measure engagement (§10); kill or change features that aren't used |

---

## 13. Open questions
1. Which ERP and email system does the first design partner use? (Decides F1.1 vs F1.2 order and the first F5 connector.)
2. Are any partners ITAR-registered? (Affects F2.2 and data handling.)
3. Do partners want quotes in their own PDF template from day one?
4. Teams vs WhatsApp for shop-floor messages: which do partners actually use?
5. EDI: do any partners receive RFQs or orders by EDI often enough to matter in the first 6 months?
6. Pricing: does the Pro plan stay $1,499 with Quote Copilot as the wedge, or is quoting priced per RFQ?
