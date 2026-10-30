# Ask Takumo evals

Thirty golden questions about the demo shop (`seed/acme-precision`), in `golden.ts`. Phase 3
is done when all 30 are answered correctly with sources (docs/TAKUMO.md section 13).

An answer passes when:

- it contains the expected facts (computed from the seed data, or from the plan the eval builds);
- it used the right tool (and not a forbidden one, e.g. no capacity check before asking which part);
- it cites at least one source that a tool really returned, and no citation that none did;
- every line that states a number carries a citation (table rows, headings, list lead-ins,
  record names like SO-5003, and the agent's own offers or assumptions are exempt).

## Run

Needs the dev database with the demo shop loaded, the scheduling engine and an Anthropic key:

```bash
pnpm dev:engine            # in another terminal
pnpm --filter app eval
```

The eval uploads the demo documents (`seed/acme-precision/docs`), builds a plan from
`EVAL_TODAY` (default 2026-11-02), asks the 30 questions four at a time, then removes the plan
and capacity checks it created. Results: `evals/results/latest.json` (git-ignored), with every
answer, the tools it used and what it cited.

Set `EVAL_ORG_ID` to run against a different shop with the same data.
