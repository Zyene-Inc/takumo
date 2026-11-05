// In-app help: short task guides, in Markdown. Keep them true to what the app
// does; update an article in the same change as the feature it describes.

interface HelpArticle {
  body: string;
  slug: string;
  summary: string;
  title: string;
}

export const ARTICLES: HelpArticle[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "From an empty shop to your first answer in about an hour.",
    body: `Takumo needs four things to be useful: your **machines**, your **parts with their routings**, your **open orders** and your **past quotes**. Everything else builds on them.

1. **Try the demo first (optional).** On the home page, *Try a demo shop first* creates a separate shop called *Acme Precision (demo)* with machines, orders, quotes and six weeks of job history. Nothing in it touches your real shop.
2. **Import your data.** *Set up your shop* takes the spreadsheets or ERP exports you already have. See [Importing your data](/help/importing).
3. **Build the schedule.** *Schedule → Board → Build the plan* plans every open order around your machines' hours and calendar.
4. **Ask a question.** *Ask Takumo*: "What's late?", "Which machine is the bottleneck next week?"
5. **Invite your team.** *Settings → Team*. Planners, estimators and operators each see what they need.

The checklist on the home page tracks these steps and shows the next one.`,
  },
  {
    slug: "importing",
    title: "Importing your data",
    summary: "Spreadsheets, CSVs and ERP exports: how Takumo reads them.",
    body: `Go to **Set up your shop** and upload an Excel (.xlsx, .xls), OpenDocument or CSV file. Takumo reads the headers, guesses which column is which, and shows you the mapping before anything is saved: fix any column it got wrong, then import.

**Import in this order**, because each sheet refers to the ones before it: machines, customers, materials, parts, routings, open orders, past quotes, job history.

- **Times:** say whether a column is in minutes or hours on the mapping screen; Takumo stores minutes.
- **Re-importing** the same file updates records in place (matched by name, part number and revision, order number…). A column you leave unmapped never blanks out what's already there.
- **Rows with problems** (a missing part number, a date it can't read) are listed with their row number and skipped; the rest still import.
- **Templates:** each sheet type has a downloadable template with the expected columns.
- **Job history** (actual setup and run times from your ERP or travelers) makes estimates better from day one: see [Calibration](/help/calibration).

You can export everything again at any time: *Settings → Billing → Download all data*. The files use the same columns, so they import straight back.`,
  },
  {
    slug: "schedule",
    title: 'The schedule and "Can we take this order?"',
    summary: "Planning the shop, pinning jobs, and checking a new order.",
    body: `**The board** (*Schedule → Board*) plans every open order operation by operation on your machines, respecting each machine's hours, holidays and downtime (*Schedule → Calendar*), and routing order. Late and tight orders are flagged.

- **Drag an operation** to another day or an alternate machine to *pin* it there; re-planning works around pins.
- **Re-plan** whenever orders or the calendar change; the board tells you when the plan is out of date.

**Can we take this order?** (*Schedule → Can we take this order?*): pick a part, a quantity and a due date. Takumo answers:

- the earliest it can finish **without moving any existing order**;
- when it would finish if it went first, and **which orders would slip**;
- the cheapest **lever** that makes the date: overtime, an alternate machine, or splitting the lot, with the extra cost;
- the cost and margin if you give a price.

Mark whether you agree with the answer; that's how we check Takumo against your planners' judgment.`,
  },
  {
    slug: "ask",
    title: "Asking Takumo",
    summary: "Questions across all your data, with a source for every number.",
    body: `**Ask Takumo** answers questions about your orders, machines, parts, quotes, schedule, documents and shop knowledge: "Which customers' margins dropped this quarter?", "Can we take 200 of P-1001 by Friday?", "How do we hold P-1001 on the HAAS?"

- **Every number has a source.** The small numbers link to the order, part, quote, query or document page it came from. If Takumo doesn't have the data, it says so instead of guessing.
- **Upload documents** (setup sheets, SOPs, quality manuals; PDF, Word or text) under *Knowledge → Sources* so Takumo can search them.
- **Tell it what you know.** "Setup on the OKUMA for P-2001 is really two hours" becomes a fact for a supervisor to review; see [Tribal knowledge](/help/knowledge).
- **History** keeps past conversations; open one to carry on.`,
  },
  {
    slug: "quotes",
    title: "Quoting with Quote Copilot",
    summary: "From an RFQ email to a priced, approved quote.",
    body: `Quote Copilot is on the **Pro** plan.

1. **New RFQ** (*Quotes → RFQ inbox*): paste the customer's email, or upload the RFQ (PDF, Word, a saved .eml with its attachments, or text). With Gmail connected, RFQs arrive on their own; see [Connectors](/help/connectors).
2. **Check what Takumo read:** customer, parts, revisions, quantities, material, finish and the date needed, matched to your records. Anything missing is listed as questions for the customer.
3. **Draft quote.** For every quantity Takumo works out the cost (machine time at each machine's rate, material and other costs from what similar jobs really cost), a price at your usual margin for that customer, and the earliest lead time that doesn't delay any open order. The comparable past quotes behind it are listed.
   - **A part you haven't made** gets operations estimated from your most similar parts; each time shows which part it came from. Edit them if needed and *Re-estimate*.
   - **Outside processing** (anodize, plating) is listed until you enter the vendor's price.
4. **Adjust prices or lead times**, then **Approve quote**. You get the quote PDF and a reply email to send.
5. **Won or lost:** record the answer on the RFQ. *Won* creates the order at the quantity the customer chose.

The inbox shows how often drafts go out with only small edits: the measure of whether Takumo prices like your estimators.`,
  },
  {
    slug: "knowledge",
    title: "Tribal knowledge: facts and voice notes",
    summary: "Capturing what your people know, with review and history.",
    body: `A **fact** is something your shop knows that the data doesn't say: a real setup time, the better machine for a part, why a part fails. Facts come from:

- **Ask Takumo**, when someone states a correction;
- **Voice notes** (*Knowledge → Voice notes*): record in the browser and Takumo transcribes and reads it, keeping the speaker's exact words as evidence; typed notes work the same way;
- **The shop floor**, as a note with a logged job;
- **Recalibration**, when finished jobs show a time is off (see [Calibration](/help/calibration));
- **By hand** (*Knowledge → Facts → Add a fact*).

**Nothing changes until a supervisor approves it** (planners, admins and owners) under *Knowledge → Facts*. Approving a number (a setup time, a machine's rate or efficiency, a material's cost or lead time) updates that record; the value it replaced is kept in the history. A *note* fact adds knowledge in words that Ask Takumo can find and cite.`,
  },
  {
    slug: "calibration",
    title: "Shop floor and calibration",
    summary: "Logging actual times so estimates get better every week.",
    body: `**Log jobs** on *Schedule → Shop floor*: when an operation finishes, enter the actual setup and run time and the good and scrapped parts. Re-planning then schedules only what's left, and an order closes when its last operation is done.

**Calibration** (*Knowledge → Calibration*) compares every finished job with the time the model gave it:

- **Setup and run-time error by week**, and whether it went down from the week before;
- **Routing vs actual** for every operation with recent jobs.

Every night Takumo **recalibrates**: when three or more recent jobs show an operation is well off its routing (15% and 5 minutes for setup, 10% for run time), it proposes the median actual time as a fact for review. Once approved, new plans and quotes use it, and the error should fall the following week.`,
  },
  {
    slug: "connectors",
    title: "QuickBooks and Gmail",
    summary: "Bringing in customers, past quotes and RFQ emails automatically.",
    body: `Connectors are on the **Pro** plan; an owner or admin connects them under *Settings → Integrations*. Both are **read only** and sync every hour.

**QuickBooks** brings in your customers with their payment terms, and your estimates from the last three years as past quotes (accepted = won, rejected = lost). An estimate is linked to a part only when a line names one of your part numbers, so items like "Setup charge" or "Freight" never become parts.

**Gmail** turns new emails that look like requests for quote into RFQs in *Quotes*, attachments included. Change the search under *Gmail search for RFQs* if your RFQs come in differently (for example \`label:rfq\`). A message is never read twice.

**Disconnect** at any time; Takumo revokes its access and forgets the tokens.`,
  },
  {
    slug: "billing",
    title: "Plans, billing and your data",
    summary: "Trial, plans, users, and exporting your data.",
    body: `New shops get a **30-day free trial** with everything in Pro.

| Plan | Price | Includes |
|---|---|---|
| Shop | $499/month | Ask Takumo, scheduling and capacity checks, tribal knowledge; 5 users |
| Pro | $1,499/month | Everything in Shop, plus Quote Copilot and connectors; unlimited users |
| Plant | Custom | Several sites, SSO, onboarding help |

- **Choose or change a plan** under *Settings → Billing* (owners and admins). Card, invoices and cancelling are under *Manage billing*.
- **When a trial or subscription ends,** your data stays: you can still see and edit everything, but Ask Takumo, Quote Copilot and the other AI features pause until you choose a plan. If a payment fails, everything keeps working for a week while you update the card.
- **Your data is yours.** *Download all data* exports everything as CSV files you can open in Excel or import again.`,
  },
];

export const article = (slug: string) =>
  ARTICLES.find((a) => a.slug === slug) ?? null;
