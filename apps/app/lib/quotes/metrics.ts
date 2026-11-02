// Quoting metrics per shop (docs/PRODUCT-PLAN.md F2.7-R2): how fast RFQs get
// a draft and a reply, how often the draft goes out with small edits, the
// win rate and the margin. Pure, so tested.

import { acceptance, type DraftedQuote } from "./numbers";

const HOUR_MS = 3_600_000;

export interface RfqTimes {
  draftedAt: Date | null;
  receivedAt: Date;
  sentAt: Date | null;
}

export interface QuoteFigures extends DraftedQuote {
  estCost: number | null;
  status: "open" | "won" | "lost";
}

export interface QuoteMetrics {
  /** Median hours from the RFQ arriving to the draft being ready. */
  hoursToDraft: number | null;
  /** Median hours from the RFQ arriving to the reply being sent. */
  hoursToSent: number | null;
  /** Average (price − cost) / price over quotes with both. */
  margin: number | null;
  marginQuotes: number;
  rfqsDrafted: number;
  rfqsSent: number;
  smallEdits: ReturnType<typeof acceptance>;
  win: { decided: number; rate: number | null; won: number };
}

export const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const hoursSince = (from: Date, to: Date | null) =>
  to && to.getTime() >= from.getTime()
    ? (to.getTime() - from.getTime()) / HOUR_MS
    : null;

export const quoteMetrics = (
  rfqs: RfqTimes[],
  quotes: QuoteFigures[]
): QuoteMetrics => {
  const toDraft = rfqs
    .map((r) => hoursSince(r.receivedAt, r.draftedAt))
    .filter((h): h is number => h !== null);
  const toSent = rfqs
    .map((r) => hoursSince(r.receivedAt, r.sentAt))
    .filter((h): h is number => h !== null);
  const decided = quotes.filter((q) => q.status !== "open");
  const won = decided.filter((q) => q.status === "won").length;
  const margins = quotes
    .filter((q) => q.price !== null && q.price > 0 && q.estCost !== null)
    .map(
      (q) => ((q.price as number) - (q.estCost as number)) / (q.price as number)
    );
  return {
    hoursToDraft: median(toDraft),
    hoursToSent: median(toSent),
    rfqsDrafted: toDraft.length,
    rfqsSent: toSent.length,
    smallEdits: acceptance(quotes),
    win: {
      won,
      decided: decided.length,
      rate: decided.length ? won / decided.length : null,
    },
    margin: margins.length
      ? margins.reduce((a, b) => a + b, 0) / margins.length
      : null,
    marginQuotes: margins.length,
  };
};

/** "45 min", "3.5 h", "2.1 days". */
export const formatHours = (hours: number | null) => {
  if (hours === null) {
    return "—";
  }
  if (hours < 1) {
    return `${Math.max(1, Math.round(hours * 60))} min`;
  }
  if (hours < 48) {
    return `${Math.round(hours * 10) / 10} h`;
  }
  return `${Math.round((hours / 24) * 10) / 10} days`;
};

export const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
