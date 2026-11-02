// Customer PO entry: shared shapes, no server code. A customer's purchase
// order is read, checked against what was quoted, and laid out ready to enter
// in the shop's ERP. Takumo never creates the order: the ERP's nightly orders
// report brings it back once someone has entered it.

export const PO_STATUSES = [
  "reading",
  "review",
  "entered",
  "rejected",
  "failed",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  reading: "Reading",
  review: "To enter",
  entered: "Entered in ERP",
  rejected: "Rejected",
  failed: "Couldn't read",
};

export const poLabel = (number: number) =>
  `PO-${String(number).padStart(4, "0")}`;

export type PoCheckKind =
  | "price_differs"
  | "qty_not_quoted"
  | "rev_differs"
  | "no_quote"
  | "unknown_part"
  | "due_before_lead_time"
  | "quote_expired"
  | "customer_unknown"
  | "missing_field"
  | "duplicate_po";

/** Something for the person entering the order to look at. */
export interface PoCheck {
  kind: PoCheckKind;
  /** Plain words, e.g. "$24.00 each; you quoted $22.50 (Q-1042)." */
  message: string;
  severity: "warn" | "info";
}

/** The quote a PO line answers. */
export interface QuoteMatch {
  leadTimeDays: number | null;
  /** The quoted quantity used for the comparison (nearest break). */
  qty: number;
  quoteId: string;
  quoteNo: string;
  rfqId: string | null;
  unitPrice: number;
}

/** One line of a customer's PO (CustomerPo.lines). */
export interface PoLine {
  checks: PoCheck[];
  description: string | null;
  /** ISO day the customer wants it, or null. */
  dueDate: string | null;
  extended: number | null;
  lineNo: number;
  partId: string | null;
  partNo: string | null;
  qty: number | null;
  quote: QuoteMatch | null;
  rev: string | null;
  unitPrice: number | null;
}

/** The PO's header as read (CustomerPo.extracted.header). */
export interface PoHeader {
  contact: string | null;
  customerName: string | null;
  notes: string | null;
  /** ISO day. */
  orderDate: string | null;
  poNo: string | null;
  shipTo: string | null;
  terms: string | null;
}
