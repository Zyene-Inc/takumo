# Takumo status: what's done and what's pending

Last updated 2026-11-04. The plan itself is [PRODUCT-PLAN.md](PRODUCT-PLAN.md); its §5 table has a one-line status per feature. This page gives the detail.

**In one line:** Phases 1, 2 and 3 are built and tested. Nothing has run on a real shop's data yet. That needs the inbound domain and design partners (Phase 0), which are owner actions. Phases 4–6 haven't started.

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
- This is the plan's v1 "capacity per qualification". v2 would assign named operators to individual jobs.
- A "no" names the real reason, for example "HAAS-VF2 has people for 0 of its 8 hours on Thu Nov 12: no one qualified on it is in 07:00–15:00", plus the material sentence.
- Two new options to make the date:
  - another qualified operator;
  - expediting the material.
- Overtime now covers the people as well as the machines. Options that don't change the date aren't shown.
- Performance: a 50-machine, 300-job shop with 40 operators answers in about 6.5 seconds, under the 10-second limit.
- The engine had a crash on any order with a material date after another order. It was fixed here.

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
- 69 engine tests, including 22 new staffing tests and a random-shop check that no machine runs without people and nothing starts before its material.
- 384 app tests, including the material rules, email formatting, and an end-to-end test that runs the app's real request mapping against the real engine.
- 34 import tests, including a roster and bill-of-materials import against a real database.

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
2. One database change that needs a decision:
   - ERP ids on every record, so renames don't create duplicates (operators already have one);
   - a default margin per shop, so new shops get drafts;
   - open operations from the ERP's open-jobs report.
3. Smaller gaps found in the audit:
   - a one-click re-map link when an ERP renames a column;
   - skipping a report that arrives twice the same day;
   - a downloadable "changes for your ERP" file;
   - "(updated)" on re-drafted Gmail replies;
   - scanned-drawing and per-machine tolerance checks, to tune on real drawings.
4. Phase 3 v2: assign named operators to jobs. Do it when partners ask; v1 limits capacity per qualification.
5. Fix the developer-only email preview tool.

**Not started:** Phase 4 (morning brief), Phase 5 (native ERP connectors), Phase 6 (WhatsApp, SMS and shared-folder knowledge), Teams.
