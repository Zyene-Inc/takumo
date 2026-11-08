# Takumo status: what's done and what's pending

Last updated 2026-11-04. The plan itself is [PRODUCT-PLAN.md](PRODUCT-PLAN.md); its §5 table has a one-line status per feature. This page gives the detail.

**In one line:** Phases 1, 2, 3, 4 and 6 are built and tested; Phase 3 includes who runs each job (v2). All of it is live (2026-11-05, every migration applied). Nothing has run on a real shop's data yet. That needs the inbound domain, a Twilio number and design partners (Phase 0), which are owner actions. Phase 5 (native ERP connectors) is built per ERP when a paying shop uses it.

## Phases

| Phase | Status |
|---|---|
| 0. Design partners | Partly done. The kit, answer-key template and accuracy harness (`pnpm --filter app eval:partners`) are built. No shops are signed yet. |
| 1. Data comes in by itself | Built. Audited requirement by requirement on 2026-11-04 and fixed (see below). |
| 2. Quote in the email thread | Built. Audited the same way and fixed. |
| 3. Can we ship by Friday? | Built on 2026-11-04 (details below). |
| 4. Morning brief | Built on 2026-11-05 (details below). Sends once the email service (`RESEND_*`) is set; buttons need `EMAIL_LINK_SECRET`. |
| 5. Native ERP connectors | Not started. Reports by email (F1.3) cover every ERP until then. |
| 6. Knowledge in their channels | Built on 2026-11-05 (details below), not yet live: texts and voice notes need a Twilio number, documents by email need the inbound domain. The watched shared folder (F6.2-R2, P3) is left for later. |

## Phase 3: what was built

**F3.1 Operators, shifts and skills**
- Each operator has an employee ID, an active flag, a shift ("Mon-Fri 15:30–24:00"), the machines they can run, a "can leave machines running" flag, and time off.
- Operators can come from the ERP's employee report. The import matches people by employee ID, so two people with the same name stay apart. It reads shifts like "3:30 PM" and days like "Mon-Fri".
- Without a report, they're entered on Shop → Operators.
- Each machine also has "people per machine" (0.5 means one person runs two machines) and "runs unattended once set up".
- The Operators page shows who can run each machine and warns about machines nobody is listed for.
- The schedule board has a People note for days when a machine has fewer qualified people than hours.

**F3.2 Material availability**
- Every open order gets a material-ready date:
  - from stock first, with orders taking it in due-date order;
  - otherwise from the open PO line that covers the shortfall;
  - otherwise from today plus the material's lead time, flagged "not ordered yet".
- Stock the ERP set aside goes to existing orders first. A new order in a delivery check only gets what's left.
- The date becomes the order's release date in the plan, and the reason is written in words ("arrives Thu Nov 12 on PO-4471").
- The Orders page shows it in a Material column, and every delivery answer includes it.
- The material per part comes from the ERP's bill of materials (the "Qty Per" and "UOM" columns), or is entered on the part.

**F3.3 Engine: people and material**
- Before planning, each day's operator hours are shared out over the machines each person is qualified on. The split follows how much work each machine has, and only counts hours when the person's shift overlaps the machine's.
- A machine is planned only for hours someone is there. Nobody is ever double-booked.
- Hours are counted on the clock: a person's minute is booked once, so two people on the same two hours of a one-person machine give it two hours, not four, and one person can't cover two full-person machines at the same time. A machine needing two people runs only while two are in.
- A machine nobody qualified is ever in (or ever free) for keeps its own hours, with a notice saying so, instead of making the plan impossible.
- A "no" names the real reason, for example "HAAS-VF2 has people for 0 of its 8 hours on Thu Nov 12: no one qualified on it is in 07:00–15:00", plus the material sentence.
- Two new options to make the date:
  - another qualified operator;
  - expediting the material.
- Overtime now covers the people as well as the machines. Options that don't change the date aren't shown.
- Performance: a 50-machine, 300-job shop with 40 operators answers in about 6.5 seconds, under the 10-second limit.
- The engine had a crash on any order with a material date after another order. It was fixed here.

**F3.3 v2: who runs each job**
- Every plan names who runs each operation, and when, at real shift times: "Sam 07:00–15:00, Ana 15:00–19:00". A job longer than a shift is handed over; a machine at half a person lets one person run two; a lights-out machine only needs someone for the setup.
- The names come from the same clock-time staffing the plan uses, so they always add up: nobody is in two places, everyone is on shift and qualified.
- Shop → Schedule → Shop floor shows **Who's on what** for today (or the next working day): each person's stretches, machine and job. The planned operations list has a Who column, and the schedule board shows who on each operation's hover.
- Planning is as fast as before: a 50-machine, 300-job shop with 40 people is named in well under a second.

**F3.4 Answer by email**
- Each shop gets an `ask-<code>@` address. Only the shop's own members can use it, sending from the address they sign in with, verified by SPF/DKIM.
- Takumo answers in the same thread in this order:
  - **Answer:** yes or no, and the earliest date;
  - **Why:** machines, people and material;
  - **If it goes first:** who slips;
  - **Ways to make it:** the options above.
- The reply includes a link that opens the saved check with "Add to plan" (Takumo's plan only; nothing is written to the ERP).
- If the part, quantity or date is unclear, Takumo replies with one question instead of guessing.
- Every answer is kept in Ask Takumo history.

**Tests**
- 85 engine tests, including the staffing tests, 12 tests for who runs each job, and random-shop checks that nobody is double-booked, everyone is on shift and qualified, and nothing starts before its material.
- 387 app tests, including the material rules, email formatting, who's-on-what, and an end-to-end test that runs the app's real request mapping against the real engine (including the names).
- 34 import tests, including a roster and bill-of-materials import against a real database.

## Phase 4: what was built (2026-11-05)

- **Morning brief (F4.1).** One email per person on weekdays at the time and time zone they
  choose (default 06:30, America/Chicago), from `/api/cron/notify` every 15 minutes.
  - Sections by role: owners and admins get all; planners get late or at risk, the bottleneck,
    facts and material; estimators get quotes; operators get none.
  - Late or at risk: from the latest saved plan, with the cause (material, people or machine) and
    the best lever (expedite, another qualified person, an alternate machine, or overtime).
  - Quotes waiting: drafts not sent after 24 h, RFQs 2 days old with no draft, and quotes sent
    7+ days ago with no answer (with Won / Lost buttons).
  - Facts to approve: the count and the oldest 3, with Approve / Reject buttons.
  - Material short this week, and sync problems (admins and owners only).
  - Only sections with something in them; nothing is sent when every section is empty.
  - Unsubscribe from each section or everything (a confirmation page, plus one-click unsubscribe
    for mail apps). Settings → Notifications sets the time, the zone and the sections.
  - Link clicks are counted (`BriefClick`); there are no open pixels.
- **Approve from email (F4.2).** Signed links (HMAC, `EMAIL_LINK_SECRET`) that expire after
  72 hours, are bound to the person, and work once (`EmailLinkUse`).
  - Opening a link shows what will change; only the confirm button changes anything (a POST).
  - The same role checks as the app: `knowledge:review` for facts, `quotes:write` for quotes.
  - A link someone else opens while signed in is refused.
- **Alerts (F4.3).** Every 15 minutes, for:
  - a new order that makes another order late (two short what-if plans, only when new orders
    arrived);
  - a machine marked down in the next 2 weeks (not shop-wide holidays);
  - material now arriving after an order's planned start;
  - an RFQ from a top-10 customer (by ordered value over the last year).

  Each is found once (`AlertEvent`). A shop's first check records what's already true without
  alerting. Each type can be turned off per person, and at most one email per type per hour
  goes out, batched. Alerts go by email only; Teams can be added later as another channel
  (`lib/alerts/channels.ts`).
- **Migration** `20261112090000_morning_brief`: six new tables with row-level security; no
  existing table changes.
- **Not yet checked:**
  - nothing has been sent to a real inbox (no email service is set up yet);
  - the 15-minute cron needs a Vercel plan that allows crons more often than daily (the hourly
    connector cron already needs that);
  - the "new order makes another late" alert is tested on its own logic, not end to end with
    the engine.

## Database change (2026-11-05, migration `20261111090000_erp_ids_margin_open_ops`)

- **ERP ids.** Machines, customers and materials take the ERP's own id (an "ERP id" column, e.g. "Cust ID"). A record renamed in the ERP is renamed here instead of becoming a second one; a record first typed in learns its id from the next report. A rename onto a name another record already has is left alone and reported. Parts and orders are already keyed by the ERP's part and order numbers; operators already had employee ids.
- **Default margin.** Settings → Quoting has a default margin (25% until changed). Drafts use it only while the shop has no won quotes with known costs, and the price build-up says so; the estimator's margin on a line still wins.
- **Open operations.** A new report type, "Open operations" (order, operation, status, parts through or parts left). Steps closed in the ERP, or left off a listed order, aren't planned; a step with parts already through plans no setup and only the parts left. Orders with progress become "in progress".

## Audit gaps closed (2026-11-04, live)

- **The ERP renames a column.** A report that arrives with new columns but mostly matches one you confirmed is recognised. Your column choices move over, the admin is emailed what changed with a link straight to it, and **Use the same columns** imports it and retires the old report. The daily check says "your ERP changed its columns", not "stopped arriving".
- **A report sent twice.** The same file again within 20 hours of its import is skipped.
- **Changes for your ERP as a file.** "Download as a spreadsheet" lists each approved change to an ERP record: the record, the field, the value in the ERP now, what to change it to, and why.
- **Updated Gmail drafts.** Gmail keeps a draft in the customer's thread only with the thread's exact subject, so it can't say "(updated)". Takumo now says where the new draft is (the second, newer one in the thread) instead of claiming it's marked. Outlook and new emails keep "(updated)".
- **Drawing checks.** The tightest tolerance needs a machine that holds it and that the part fits on; the flag names the closest machine, or the one that holds it but is too small. A scanned or photographed drawing is flagged so the numbers get checked, and a hard-to-read tightest tolerance is asked about in the reply.
- **Developer email preview** builds and runs again.

## Fixed in the Phase 1 and 2 audit (2026-11-04)

- **ERP reports.**
  - Large reports are no longer cut off and then wrongly closed or zeroed.
  - Two reports of the same kind no longer zero each other.
  - A report that can't be read, or is empty, now alerts the admin.
  - Orders that reappear in a report reopen.
- **Mailboxes.**
  - A failed Gmail or Outlook download is retried instead of lost.
  - Revoked consent, and mailboxes failing for a day, now trigger the daily alert.
- **ERP data stays the ERP's.** Spreadsheet uploads, new records, operations added to ERP routings, floor time logs and "Add to plan" are all refused, on the server too, when the ERP sends that data.
- **Quotes.**
  - A "got it, quote to follow" email no longer counts as the sent quote.
  - Drafts never go to a colleague or to a portal's no-reply address.
  - Material from metric drawings and stock written without a length is priced correctly.
  - Finishes the shop does in-house aren't priced as outside work.
  - The estimator is told when an RFQ can't be priced.
- **Email.**
  - The virus scanner runs on the server's ARM chip.
  - Bounces give the real reason.
  - Mail is retried, not lost, if the mail server and the app ever stop sharing the same key.
  - Resent or forwarded text-only RFQs are linked to the first one.

## Phase 6: what was built

- **Notes by text (F6.1).**
  - One shop number (Twilio) for every shop; a message is routed by the sender's phone.
  - Settings → Integrations → Notes by text: anyone registers their own phone, an owner or admin registers anyone's (an operator on the roster, someone on Takumo, or a name). Takumo texts a 6-digit code (10 minutes, 5 tries, one resend a minute); typing it in confirms the phone. A phone can be confirmed for one shop only.
  - `/api/twilio` checks Twilio's signature, ignores unregistered phones without a reply or a stored row, and reads each message once (by Twilio's message id).
  - A voice note is transcribed with the shop's part and machine names, then goes through the same reading as a note left in the app (`saveNote`). Voice notes shows it as "By text" or "WhatsApp" with the sender's name.
  - The sender gets "Got it: 2 facts for your supervisor to review (F-12, F-13)", or what went wrong. Photos get pointed at the documents address.
- **Documents by email (F6.2-R1).**
  - Each shop gets a `docs-…@` address next to the ERP, RFQ and ask addresses. Only the shop's own people can use it, verified like the ask address.
  - Up to 10 attachments per email (PDF, Word, text, photos; signature images skipped) go through the same reading as an upload (`ingestDocument`). Someone who can't replace documents can't overwrite one with the same name, as on the Knowledge page.
  - The reply, in the same thread, lists for each document what it was identified as, what it was linked to and the facts proposed, plus anything left out and why.
- **Not built:** a watched SharePoint, OneDrive or Google Drive folder (F6.2-R2, P3).
- **Migration** `20261113090000_knowledge_channels`: `PhoneNumber` and `PhoneMessage` tables (with row-level security) and `Note.channel`, `Note.senderName`.
- **Tests:** Twilio signature, phone numbers, codes and replies; the docs address and its reply; on a database, registering and confirming a phone, unknown and unconfirmed numbers ignored, one shop per phone, retries read once, and a member's emailed document read and answered while an outsider is bounced.

## Company Knowledge Hub (in development, not live)

Branches `feat/knowledge-hub-*`. Built so far: ownership, folders, departments and access checks (phase 1); original files in private storage, versions, recoverable processing, provenance, Trash and permanent delete (phase 2); the Company Knowledge library at `/library` (phase 3), shown only to shops whose `libraryStage` is `library` (Takumo staff switch it on per shop in `/admin`); access-aware AI memory (phase 4, below). Restricted and confidential documents stay off in code (`CONFIDENTIAL_READY = false` in `apps/app/lib/library/stage.ts`) until the release gate below is passed.

**Phase 4 (secure memory), built and tested locally only**
- Every AI path reads as the person asking (`lib/library/ai-access.ts`, SQL `library.ai_source_ids` and `library.fact_access`, migration `20261116090000_knowledge_hub_secure_memory`): Ask's document search (keyword and vector, filtered inside the query), `get_record`'s facts, `propose_fact`, starter questions, the Brain, the facts pages, the home page count, exports and email Ask. The SQL reader (`query_data`) sees only facts everyone may see, and quotes from documents only when every one of them is company-wide.
- Fact visibility: published to the company on purpose (audited), typed or spoken (no document), or read from documents and seen only by people who may use every one of them (live, viewable, AI "full"). Facts of unknown origin are company-wide only while the shop restricts nothing; once it does, the owner sees them until someone publishes them. Approving a restricted fact doesn't publish it; a restricted number that would change a record must be published at the same time, by the owner or a reviewer who manages all its documents.
- Fixed: facts from documents in the Trash. A trashed document's facts leave Ask, `get_record`, the SQL reader, fact review, the brief and the Brain, for the owner too, until it's restored. Facts published to the company (including every number approved into a record from now on) stay, without the trashed document's quotes. Permanently deleting one of several documents leaves the fact owner-only ("source_deleted") until it's published again: it never becomes more visible.
- Conversation history: answers that drew on a document the person can't use now (restricted, moved, in the Trash, AI turned off) are hidden from the screen and from the model, and come back if access does. Answers saved before sources were recorded are hidden once the shop restricts documents, except from the owner. An answer whose documents went out of reach while it was written is saved hidden.
- Folder AI settings (off, search, full), most restrictive on the path: off and search send nothing while reading (no recognising of scans, understanding, context, vectors or facts); search lets Ask use keyword passages. Lowering a setting removes vectors, context sentences, cards, summaries and unreviewed facts in the same transaction, and runs already going can't write them back (row lock and re-check).
- Moves and restores never widen access (owner needed to leave a confidential folder; otherwise the item keeps a copy of its access); a folder with documents in the Trash can't be deleted once access can be restricted. Departments page (`/settings/departments`), access dialog on folders and documents, confidential and AI settings, the owner's one-way "turn on restricted access" (creates HR, Finance, Receipts and Contracts with AI off). Drop boxes never reveal a hidden document's name.

**Release blockers**
1. The staging checks for phases 2 to 4: the private bucket and its signed links (Open in a new tab, Download), pooled-connection transactions, the library sweep cron, the in-page previews (PDFs and images up to 4 MB are sent by Takumo itself, `/api/library/documents/[id]/file?preview=1`; larger ones open in a new tab; docs/DEPLOY.md), and the new SQL functions and `ask.facts` view against Supabase with the `takumo_reader` login.
2. Before `CONFIDENTIAL_READY` may be switched on (gate G3): an independent security review of phase 4, the penetration checklist (guessed ids, direct server-action calls, grant escalation, moves, admin self-promotion), an AI evaluation with restricted documents and prompt-injection attempts on the real model, and the staging tests above.

**Known limits (phase 4)**
- What was already streamed or emailed can't be taken back when access changes mid-answer; it's only not saved or reused. Text already sent to an AI service when a folder's AI setting is lowered can't be recalled; nothing more is sent and nothing it returns is kept.
- A person removed in WorkOS loses access at once (their role is gone); their department places are removed by the WorkOS webhook (apps/api) and, as a backstop, daily (erp-health cron) and when the departments page opens.
- A fact whose source document is permanently deleted stays owner-only until published; documents outside any folder keep company-wide reading (as before folders).
- RFQ and PO folders stay company-wide, the same as the Quotes and Orders pages.

**Known from browser QA (local, mocked Storage and AI)**
- Several uploads at once: past the per-shop limit the rest are queued for the library sweep, which reads about 3 per run. With the 5-minute cron, 40 queued documents take over an hour; the library shows them as Queued meanwhile.
- If the server stops while reading a document, it shows as Processing until its lease (5 min) runs out and the next sweep resumes it, so up to about 10 minutes.

## Pending

**Owner actions (needed before real use)**
1. Buy the domain. Set the DNS (MX and A records for the mail server), open port 25 on the server, and set the inbound environment variables. Until then, the ERP report, RFQ and ask addresses can't receive mail.
2. Set up the email-sending service (`RESEND_*`). Without it, alerts and email answers are only logged.
3. Create the Microsoft Entra app (Outlook) and finish Google verification (Gmail drafts).
4. Rotate the WorkOS key.
5. Sign 2–3 design partners and collect their answer keys (Phase 0).
6. Approve the paid drawing-accuracy test (about $0.03 per drawing).
7. For notes by text: a Twilio number (A2P 10DLC registration in the US) and, for WhatsApp, a WhatsApp Business sender (docs/DEPLOY.md section 9b).
8. Stripe, later.

**Engineering, next**
1. Set up the mail server on the domain and test the whole email flow live (Gmail, Outlook and the ask address).
2. Tune the drawing checks (scans, per-machine tolerances) on real drawings from design partners.

**Not started:** Phase 5 (native ERP connectors, built per ERP when a paying shop uses it), the watched shared folder (F6.2-R2), Teams.
