// Quote Copilot types shared by the server and the browser. No server code.

import type {
  OutsideProcess,
  QuoteOperation,
  QuoteResponse,
} from "@repo/engine-client/types";

/** Files an RFQ can arrive as (the upload input's accept list). */
export const RFQ_TYPES = [".pdf", ".docx", ".eml", ".txt", ".md"] as const;
export const MAX_RFQ_BYTES = 10 * 1024 * 1024;
/** Quantity breaks per line the copilot prices. */
export const MAX_QTY_BREAKS = 6;

export const RFQ_STATUSES = [
  "reading",
  "review",
  "drafted",
  "quoted",
  "won",
  "lost",
  "declined",
  "failed",
] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export const STATUS_LABEL: Record<RfqStatus, string> = {
  reading: "Reading",
  review: "To review",
  drafted: "Draft ready",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
  declined: "Declined",
  failed: "Couldn't read",
};

export const rfqLabel = (number: number) =>
  `RFQ-${String(number).padStart(4, "0")}`;

/** What the estimate for a line was built from, for display. */
export interface DraftInputs {
  customer: string | null;
  material: string | null;
  materialLeadTimeDays: number | null;
  /** True when the part isn't in the shop yet (routing estimated). */
  newPart: boolean;
  outside: OutsideProcess[];
  partNo: string;
  qtys: number[];
  requestedDate: string | null;
  routing: QuoteOperation[];
  targetMargin: number | null;
  today: string;
  usagePerPart: number | null;
}

/** RfqLine.draft */
export interface LineDraft {
  estimatedAt: string;
  inputs: DraftInputs;
  response: QuoteResponse;
  /** Why the operations look the way they do (new parts). */
  routingNotes: string[];
}

/** RfqLine.final: what the estimator approved. */
export interface LineFinal {
  breaks: { leadTimeDays: number; qty: number; unitPrice: number }[];
  /** The order created when the customer accepted. */
  orderNo?: string;
}

/** Quote.breaks */
export interface QuotedBreak {
  /** The draft's cost for this quantity (the quote's estimated cost). */
  cost: number | null;
  draftLeadTimeDays: number | null;
  draftUnitPrice: number | null;
  leadTimeDays: number;
  price: number;
  qty: number;
  unitPrice: number;
}
