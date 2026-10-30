// Golden questions for Ask Takumo on the demo shop (seed/acme-precision).
// Phase 3 is done when all 30 are answered correctly with sources.
// Expected values are computed from the seed CSVs; questions about the plan
// derive their answer from the plan the eval builds.

import type { ScheduleResponse } from "@repo/engine-client/types";

export interface EvalContext {
  plan: ScheduleResponse;
}

export interface Golden {
  /** Every pattern must appear in the answer (case-insensitive). */
  expect: (RegExp | string)[] | ((ctx: EvalContext) => (RegExp | string)[]);
  /** None of these may appear in the answer (e.g. an invented figure). */
  forbid?: RegExp[];
  /** None of these tools may be used. */
  forbidTools?: string[];
  /** It answers without any citation (e.g. a clarifying question). */
  noCitations?: boolean;
  q: string;
  /** At least one of these tools must be used. */
  tools?: string[];
}

const busiest = (plan: ScheduleResponse, start: string, days: number) => {
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const totals = new Map<string, { used: number; cap: number }>();
  for (const d of plan.load) {
    if (d.date < end) {
      const t = totals.get(d.work_center) ?? { used: 0, cap: 0 };
      t.used += d.load_minutes;
      t.cap += d.capacity_minutes;
      totals.set(d.work_center, t);
    }
  }
  return [...totals.entries()].sort(
    (a, b) => b[1].used / b[1].cap - a[1].used / a[1].cap
  )[0][0];
};

const NO_DATA =
  /(can't|cannot|don't|do not|doesn't|does not|no|none|isn't|aren't|wasn't|haven't|hasn't)\b[^.]{0,80}\b(have|record|recorded|track|tracked|data|logged|captured|reported|calculate|give)/;
const INVENTED_RATE =
  /scrap rate (is|was|of|at) (about |around )?\d|\d+(\.\d+)?\s?% scrap/;

const NONE_LATE = /\b(no|none|not any|all (6|six)[^.]*on time|on time)\b/;

export const EVAL_TODAY = process.env.EVAL_TODAY ?? "2026-11-02";

export const GOLDEN: Golden[] = [
  // Orders
  {
    q: "How many open orders do we have, and what are they worth in total?",
    expect: [/\b6\b/, "57,750"],
    tools: ["query_data"],
  },
  {
    q: "Which open order is worth the most?",
    expect: ["SO-5005", "15,200"],
    tools: ["query_data", "get_record"],
  },
  { q: "Which order is due first?", expect: ["SO-5003", /Nov(ember)? 11/] },
  {
    q: "Show me open order value by customer.",
    expect: ["Bluefin", "28,400", "18,000", "11,350"],
    tools: ["query_data"],
  },
  {
    q: "Tell me about order SO-5004.",
    expect: ["P-1002", "120", /Nov(ember)? 25/, "Northwind"],
    tools: ["get_record", "query_data"],
  },

  // Quotes
  {
    q: "What's our overall quote win rate?",
    expect: [/71(\.\d+)?\s?%/],
    tools: ["query_data"],
  },
  {
    q: "What's our quote win rate by customer?",
    expect: [/6[67](\.\d+)?\s?%/, /50(\.0)?\s?%/, /100(\.0)?\s?%/],
    tools: ["query_data"],
  },
  {
    q: "Which won quote had the lowest margin, using actual cost?",
    expect: ["Q-9006", /17(\.\d+)?\s?%/],
    tools: ["query_data"],
  },
  {
    q: "Which won quote ran furthest over its estimated cost?",
    expect: ["Q-9003", "900"],
    tools: ["query_data"],
  },
  {
    q: "How much revenue have we won from quotes so far?",
    expect: ["38,700"],
    tools: ["query_data"],
  },
  {
    q: "What quotes are still open?",
    expect: ["Q-9008", "17,000"],
    tools: ["query_data"],
  },

  // Machines, parts, routings, materials, customers
  {
    q: "Which machine has the highest hourly rate?",
    expect: ["OKUMA-LB3000", "110"],
  },
  {
    q: "Which parts go through DEBURR-1?",
    expect: ["P-1001", "P-1002", "P-2002", "P-3001", "P-3002"],
  },
  {
    q: "What's the routing for P-2001?",
    expect: ["OKUMA-LB3000", "HAAS-VF2", "90", "12"],
    tools: ["get_record", "query_data"],
  },
  {
    q: "How many machine hours does order SO-5002 need in total?",
    expect: [/18(\.\d+)?\s?(h|hours)|1,?090/],
    tools: ["query_data", "get_record"],
  },
  {
    q: "How many hours of open-order work are routed to the OKUMA-LB3000?",
    expect: [/28(\.\d+)?\s?(h|hours)|1,?685/],
    tools: ["query_data"],
  },
  {
    q: "Which material has the longest lead time?",
    expect: ["SS316", /\b7\b/],
    tools: ["query_data", "get_record"],
  },
  {
    q: "Which parts are made from AL6061-T6 bar?",
    expect: ["P-1001", "P-1002"],
  },
  { q: "What are Bluefin Marine's payment terms?", expect: [/45/] },

  // Schedule
  {
    q: "Are any orders late in the current plan?",
    tools: ["get_schedule"],
    expect: ({ plan }) => {
      const late = plan.orders.filter((o) => o.days_late > 0);
      return late.length === 0 ? [NONE_LATE] : late.map((o) => o.order_no);
    },
  },
  {
    q: "Which machine is the bottleneck over the next two weeks?",
    tools: ["get_schedule"],
    expect: ({ plan }) => [busiest(plan, EVAL_TODAY, 14)],
  },

  // Capacity and scenarios
  {
    q: "Can we take 50 × P-1001 by November 27?",
    expect: [/\byes\b|can take|we can/],
    tools: ["check_capacity"],
  },
  {
    q: "Can we take 400 × P-2001 by November 6?",
    expect: [/\bno\b|\bnot\b|can't|cannot|won't/],
    tools: ["check_capacity"],
  },
  {
    q: "What happens to our orders if the OKUMA-LB3000 is down from November 3 to November 6?",
    expect: [/SO-5002|SO-5005/],
    tools: ["run_scenario"],
  },

  // Documents
  {
    q: "What coolant concentration do we run for P-2001 on the OKUMA?",
    expect: [/8\s?%/],
    tools: ["search_documents"],
  },
  {
    q: "How do we hold P-1001 on the HAAS-VF2?",
    expect: ["soft jaws"],
    tools: ["search_documents"],
  },
  {
    q: "How often do we inspect parts during a production run?",
    expect: [/25(th)?/],
    tools: ["search_documents"],
  },
  {
    q: "What paperwork does Cobalt Medical need with each shipment?",
    expect: [
      /certificate of conformance|C of C|CoC/,
      /material cert|mill test/,
    ],
    tools: ["search_documents"],
  },

  // Honesty and clarifying questions
  {
    q: "What's our scrap rate on the HAAS-VF2?",
    // Honest about the missing data, and never invents a rate.
    expect: [NO_DATA],
    forbid: [INVENTED_RATE],
  },
  {
    q: "Can we take 100 parts by Friday?",
    noCitations: true,
    forbidTools: ["check_capacity"],
    expect: [/which part|what part|part number/, /\?/],
  },
];
