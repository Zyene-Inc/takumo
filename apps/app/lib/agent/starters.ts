// Example questions for Ask Takumo's start screen, written with the shop's own
// part numbers, orders and machines so people see what they can ask about
// their shop. Pure so it can be tested; the Ask page loads the rows.

export const STARTER_TOPICS = [
  "capacity",
  "quotes",
  "schedule",
  "machines",
  "setup",
] as const;
export type StarterTopic = (typeof STARTER_TOPICS)[number];

export const STARTER_LABEL: Record<StarterTopic, string> = {
  capacity: "Can we take it?",
  quotes: "Quotes",
  schedule: "Schedule",
  machines: "Machines",
  setup: "Setup & quality",
};

export type Starters = Record<StarterTopic, string[]>;

export interface StarterRows {
  /** Customers with the most orders first. */
  customers: string[];
  documents: string[];
  /** The most expensive machines first: the ones planners watch. */
  machines: string[];
  /** Open orders, soonest due first. */
  orders: { orderNo: string; partNo: string; qty: number }[];
  /** Parts with the most orders first. */
  parts: string[];
  quotes: string[];
  /** ISO date, the user's today. */
  today: string;
}

const PER_TOPIC = 4;

/** "Dec 1", three weeks out: a realistic "by" date for a capacity question. */
const byDate = (today: string) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 21);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
};

/** Titles worth quoting back; "02_20251204 - scan.pdf" isn't one. */
const READABLE_TITLE = /^[^_]{3,40}$/;

/** Each entry is used only when the data it names exists. */
const pick = (candidates: (string | false | undefined)[]) =>
  candidates.filter((c): c is string => Boolean(c)).slice(0, PER_TOPIC);

export const buildStarters = (rows: StarterRows): Starters => {
  const [part, part2] = rows.parts;
  const [order, order2] = rows.orders;
  const [machine, machine2] = rows.machines;
  const [customer] = rows.customers;
  const [quote] = rows.quotes;
  const doc = rows.documents.find((d) => READABLE_TITLE.test(d));
  const by = byDate(rows.today);

  return {
    capacity: pick([
      order && `Can we take another ${order.qty} × ${order.partNo} by ${by}?`,
      !order && part && `Can we take 100 × ${part} by ${by}?`,
      order && `Can we pull ${order.orderNo} in by a week?`,
      machine && `What if ${machine} goes down for two days?`,
      "What if we add a Saturday shift next week?",
      "Can we take 100 more of our busiest part this month?",
      "How much spare capacity do we have next week?",
      "Which orders could we ship early?",
    ]),
    quotes: pick([
      part && `What should we quote for 250 × ${part}?`,
      "What's our quote win rate by customer?",
      customer && `Show open quotes for ${customer}`,
      quote && `How did ${quote} compare with what the job really cost?`,
      "Which quotes are still waiting on an answer?",
      "Which customers do we win most often?",
      "How close were our quotes to what jobs really cost?",
    ]),
    schedule: pick([
      "Which orders are late or at risk right now?",
      order && `When will ${order.orderNo} finish?`,
      "What's due this week?",
      order2 && `What's holding up ${order2.orderNo}?`,
      "Which machine is the bottleneck over the next two weeks?",
      "What starts on the floor tomorrow?",
    ]),
    machines: pick([
      machine && `How loaded is ${machine} over the next two weeks?`,
      "Which machine is the bottleneck over the next two weeks?",
      machine2 && `What runs on ${machine2} this week?`,
      machine && `Are setups on ${machine} taking longer than planned?`,
      "Which machines are down or on holiday soon?",
      "Where are setups running longer than planned?",
      "How busy is each machine this week?",
    ]),
    setup: pick([
      part && `How do we set up ${part}?`,
      part2 && `What notes do we have on ${part2}?`,
      doc && `What does "${doc}" say?`,
      "Which parts take longest to set up?",
      "Where are we scrapping the most parts?",
      "Which operations run slower than planned?",
      "What should a new operator know about our busiest part?",
    ]),
  };
};
