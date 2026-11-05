# Takumo status: what's done and what's pending

Last updated 2026-11-04. The plan itself is [PRODUCT-PLAN.md](PRODUCT-PLAN.md); its §5 table has a one-line status per feature. This page gives the detail.

**In one line:** Phases 1, 2 and 3 are built and tested, Phase 3 including who runs each job (v2). Nothing has run on a real shop's data yet. That needs the inbound domain and design partners (Phase 0), which are owner actions. Phases 4–6 haven't started.

## Phases

| Phase | Status |
|---|---|
| 0. Design partners | Partly done. The kit, answer-key template and accuracy harness (`pnpm --filter app eval:partners`) are built. No shops are signed yet. |
| 1. Data comes in by itself | Built. Audited requirement by requirement on 2026-11-04 and fixed (see below). |
| 2. Quote in the email thread | Built. Audited the same way and fixed. |
| 3. Can we ship by Friday? | Built on 2026-11-04 (details below). |
| 4. Morning brief | Not started. |
| 5. Native ERP connectors | Not started. Reports by email (F1.3) cover every ERP until then. |
| 6. Knowledge in their channels | Not started. |

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

## Pending

**Owner actions (needed before real use)**
1. Buy the domain. Set the DNS (MX and A records for the mail server), open port 25 on the server, and set the inbound environment variables. Until then, the ERP report, RFQ and ask addresses can't receive mail.
2. Set up the email-sending service (`RESEND_*`). Without it, alerts and email answers are only logged.
3. Create the Microsoft Entra app (Outlook) and finish Google verification (Gmail drafts).
4. Rotate the WorkOS key.
5. Sign 2–3 design partners and collect their answer keys (Phase 0).
6. Approve the paid drawing-accuracy test (about $0.03 per drawing).
7. Stripe, later.

**Engineering, next**
1. Set up the mail server on the domain and test the whole email flow live (Gmail, Outlook and the ask address).
2. Tune the drawing checks (scans, per-machine tolerances) on real drawings from design partners.

**Not started:** Phase 4 (morning brief), Phase 5 (native ERP connectors), Phase 6 (WhatsApp, SMS and shared-folder knowledge), Teams.
