# Evals

Three suites run against the demo shop (`seed/acme-precision`) with the real model, database
and engine:

- **Ask Takumo** (`ask.eval.ts`): 33 golden questions in `golden.ts`. Phase 3 is done when its
  30 are answered correctly with sources; Phase 4 added two that ask
  for quote prices, checked against the engine's own estimate, and Phase 5 one about data the
  shop doesn't have.
- **Quote Copilot** (`quote.eval.ts`): eight RFQs in `rfqs/` (plain and HTML-only email, an
  email with the RFQ as a PDF attachment, a PDF, a Word file, a new customer and new part, a
  new revision, a vague request and a message that isn't an RFQ). Checks that each is read
  into the right customer, parts, revisions, quantities, materials, finish and dates; that a
  part the shop makes is priced from its routing and its own past quotes; that a new part's
  operations are estimated from similar parts with every time traceable; and that approving,
  the PDF and "won → order" work.
- **Tribal knowledge** (`knowledge.eval.ts`): seven floor notes (two with nothing worth keeping)
  must become exactly the right facts; a correction told to Ask Takumo waits for review;
  approving changes the routing and a newer fact supersedes it with history kept;
  recalibration finds exactly what the six weeks of job history say (the P-2001 lathe setup and
  the P-3001 brake run) and doesn't propose them twice; after the fix is approved, the next
  week's setup-time error drops (the Phase 5 done-when); Ask Takumo uses and cites an approved
  fact.

## Ask Takumo answers

An answer passes when:

- it contains the expected facts (computed from the seed data, or from the plan the eval builds);
- it used the right tool (and not a forbidden one, e.g. no capacity check before asking which part);
- it cites at least one source that a tool really returned, and no citation that none did;
- every line that states a number carries a citation (table rows, headings, list lead-ins,
  record names like SO-5003, and the agent's own offers or assumptions are exempt).

## Run

Needs the dev database with the demo shop loaded (`SEED_ORG_ID=… pnpm db:seed`, including the
job history), the scheduling engine and an Anthropic key:

```bash
pnpm dev:engine            # in another terminal
pnpm --filter app eval          # all three
pnpm --filter app eval:ask      # or one suite: eval:ask, eval:quote, eval:knowledge
```

Each run calls Claude and costs money (it prints what it spent). `EVAL_MODEL=sonnet` runs
Ask Takumo on Sonnet instead of Opus, for a cheaper check.

The eval uploads the demo documents (`seed/acme-precision/docs`), builds a plan from
`EVAL_TODAY` (default 2026-11-02), asks the questions four at a time, then removes the plan
and capacity checks it created. The quote eval then removes the RFQs, quotes, parts, customers
and orders it created. The three files run one after the other. Results: `evals/results/latest.json` (git-ignored), with every
answer, the tools it used and what it cited.

Set `EVAL_ORG_ID` to run against a different shop with the same data.
