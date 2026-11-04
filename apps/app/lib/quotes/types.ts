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
  // Screening (mailbox RFQs): waiting for a person, nothing read yet.
  "new_sender",
  "filtered",
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
  new_sender: "New sender",
  filtered: "Filtered",
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
  /** Where every number came from, one per quantity (F2.4-R6). */
  buildUp?: PriceBuildUp[];
  estimatedAt: string;
  inputs: DraftInputs;
  response: QuoteResponse;
  /** Why the operations look the way they do (new parts). */
  routingNotes: string[];
}

/** Where one number in a price came from. F2.3-R4, F2.4-R6 */
export interface CostSource {
  /** ISO date the number is from (a PO's date, a fact's approval). */
  date?: string;
  kind:
    | "po"
    | "material"
    | "routing"
    | "erp"
    | "actuals"
    | "fact"
    | "similar_part"
    | "default"
    | "estimator"
    | "rate"
    | "setting"
    | "supplier"
    | "history"
    | "stock"
    | "lead_time"
    | "floor";
  /** Plain words, e.g. "PO 4512, Mar 3" or "Shop labor rate". */
  label: string;
  /** A record to link to, e.g. a part number or quote number. */
  ref?: string;
}

/** One operation in a price, with the basis of its times and rate. */
export interface BuildUpOperation {
  alternates: string[];
  /** Where the times came from. A default is an estimate with nothing behind it. */
  basis: CostSource;
  cost: number | null;
  /** Shop-floor hours for the whole quantity (after efficiency). */
  hours: number | null;
  isDefault: boolean;
  rate: number | null;
  rateSource: CostSource;
  reason: string | null;
  runMinPerUnit: number;
  seq: number;
  setupMin: number;
  /** Setup minutes carried by each part at this quantity. */
  setupPerPart: number;
  workCenter: string;
}

/** An outside process (anodize, heat treat…) in a price. F2.3-R3 */
export interface BuildUpOutside {
  /** No price or lead time known: ask the supplier. */
  askSupplier: boolean;
  cost: number | null;
  leadTimeDays: number | null;
  process: string;
  source: CostSource;
  supplier: string | null;
}

/** A price for one quantity, every component with its source. F2.4-R6 */
export interface PriceBuildUp {
  cost: number | null;
  lead: {
    /** What the engine's schedule gave (material wait included). */
    leadTimeDays: number | null;
    /** Days before the material is in the shop for this quantity. */
    materialWaitDays: number | null;
    materialSource: CostSource;
    /** Added for outside processes after machining. */
    outsideDays: number;
  };
  leadTimeDays: number | null;
  margin: {
    /** The customer's floor, when the owner set one. */
    floor: number | null;
    high: number | null;
    low: number | null;
    pct: number | null;
    /** The floor lifted the price above the suggested margin. */
    raisedByFloor: boolean;
    source: CostSource;
    target: number | null;
  };
  material: {
    basis: string;
    cost: number | null;
    markup: number | null;
    perPart: number | null;
    source: CostSource;
    /** Stock size and form per part, from the drawing. */
    stock: string | null;
    unit: string | null;
    unitPrice: number | null;
    usagePerPart: number | null;
  };
  operations: BuildUpOperation[];
  outside: BuildUpOutside[];
  price: number | null;
  qty: number;
  unitCost: number | null;
  unitPrice: number | null;
}

/** RfqLine.final: what the estimator approved. */
export interface LineFinal {
  breaks: { leadTimeDays: number; qty: number; unitPrice: number }[];
  /**
   * When the shop's ERP sends its orders, Takumo doesn't make the order:
   * this is what to enter in the ERP, and its report brings it back.
   */
  erpOrder?: ErpOrderEntry;
  /** The order created when the customer accepted. */
  orderNo?: string;
}

/** A won quote laid out for entering in the ERP (LineFinal.erpOrder). */
export interface ErpOrderEntry {
  customer: string | null;
  description: string | null;
  dueDate: string;
  partNo: string;
  qty: number;
  quoteNo: string;
  rev: string | null;
  unitPrice: number;
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

// ---------------------------------------------------------------------------
// Phase 2 (docs/PRODUCT-PLAN.md F2.x): shared shapes. Each feature owns the
// code that fills them; the review screen reads them.
// ---------------------------------------------------------------------------

/** Where an RFQ came from (Rfq.source), for the inbox and metrics. F2.1-R6 */
export const RFQ_SOURCES = [
  "email",
  "portal",
  "form",
  "phone",
  "upload",
  "paste",
] as const;
export type RfqSource = (typeof RFQ_SOURCES)[number];

export const SOURCE_LABEL: Record<RfqSource, string> = {
  email: "Email",
  portal: "Customer portal",
  form: "Website form",
  phone: "Phone call",
  upload: "Upload",
  paste: "Pasted",
};

/** RfqFile.kind */
export const RFQ_FILE_KINDS = [
  "drawing",
  "model",
  "document",
  "image",
  "other",
] as const;
export type RfqFileKind = (typeof RFQ_FILE_KINDS)[number];

export type Confidence = "high" | "medium" | "low";

/** Where on a sheet a value was read: [ymin, xmin, ymax, xmax], 0–1000. */
export type Box = [number, number, number, number];

/** One value read from a drawing, with where it came from. F2.2-R3 */
export interface DrawingValue<T = string> {
  /** Sheet number, from 1. */
  box: Box | null;
  confidence: Confidence;
  sheet: number;
  /** The text as printed. */
  text: string;
  /** The value, cleaned up (e.g. a number, a normalized grade). */
  value: T;
}

export type FinishKind =
  | "anodize"
  | "plating"
  | "heat_treat"
  | "passivation"
  | "paint"
  | "other";

export type FeatureKind =
  | "hole"
  | "thread"
  | "pocket"
  | "slot"
  | "bore"
  | "chamfer"
  | "radius"
  | "knurl"
  | "keyway"
  | "other";

export type RequirementKind =
  | "certification"
  | "fai"
  | "coc"
  | "material_cert"
  | "itar"
  | "spec"
  | "other";

/** A "check this" for the estimator, pointing at the drawing. F2.2-R5/R7 */
export interface DrawingFlag {
  box: Box | null;
  kind:
    | "new_material"
    | "outsourced"
    | "tolerance"
    | "envelope"
    | "certification"
    | "low_confidence"
    | "conflict"
    | "units"
    | "scanned"
    | "no_drawing";
  message: string;
  sheet: number | null;
}

/** RfqLine.drawing: everything read from the line's drawing. F2.2-R2/R6 */
export interface DrawingReading {
  envelope: DrawingValue<{
    diameter?: number;
    h?: number;
    l?: number;
    length?: number;
    w?: number;
  }> | null;
  features: (DrawingValue & {
    count: number;
    detail: string | null;
    kind: FeatureKind;
  })[];
  fileId: string;
  fileName: string;
  finishes: (DrawingValue & { kind: FinishKind; spec: string | null })[];
  flags: DrawingFlag[];
  material:
    | (DrawingValue & {
        condition: string | null;
        grade: string | null;
        spec: string | null;
      })
    | null;
  /** Numbered drawing notes, verbatim. */
  notes: DrawingValue[];
  quantities: DrawingValue<number>[];
  /** Questions for the customer, written for the draft reply. F2.2-R7 */
  questions: string[];
  readAt: string;
  requirements: (DrawingValue & { kind: RequirementKind })[];
  /** Read from an image (a scan, a photo) rather than a PDF's own text. */
  scanned?: boolean;
  sheets: number;
  stock: {
    form: "bar" | "plate" | "tube" | "sheet" | "other";
    size: string;
  } | null;
  titleBlock: {
    approvedDate?: DrawingValue;
    drawingNo?: DrawingValue;
    drawnDate?: DrawingValue;
    generalTolerance?: DrawingValue;
    partNo?: DrawingValue;
    rev?: DrawingValue;
    scale?: DrawingValue;
    sheet?: DrawingValue;
    title?: DrawingValue;
  };
  tolerances: (DrawingValue & {
    datums: string[];
    kind: "dimension" | "gdt" | "surface";
    symbol: string | null;
    /** ± inches for dimensions, Ra µin for surface, zone for GD&T. */
    tolerance: number | null;
  })[];
  units: "in" | "mm" | null;
}

/** An outside process the shop buys (ShopSettings.outsideProcesses). */
export interface OutsideSupplier {
  costPerPart: number | null;
  leadTimeDays: number | null;
  lotCharge: number | null;
  process: string;
  supplier: string | null;
}

/** How a shop quotes, with defaults filled in (lib/quotes/settings.ts). */
export interface QuoteSettings {
  certifications: string[];
  laborRate: number;
  materialMarkup: number;
  outsideProcesses: OutsideSupplier[];
  quoteValidityDays: number;
  replyIntro: string | null;
  signature: string | null;
  /** Tightest tolerance the shop holds without a flag, inches. */
  toleranceIn: number;
}

/** A price read back from the reply the estimator sent. F2.5-R5 */
export interface SentPrice {
  leadTimeDays: number | null;
  partNo: string;
  qty: number;
  unitPrice: number;
}

/**
 * Rfq.reply: the draft reply Takumo left in the mailbox (F2.5). Takumo never
 * sends it; the estimator edits and sends it from their mail app.
 */
export interface RfqReply {
  /** The text Takumo wrote, normalized: unchanged in the mailbox = unedited. */
  bodyHash: string;
  bodyText: string;
  createdAt: string;
  /** Gmail draft id, or the Outlook draft message id. */
  draftId: string | null;
  /** Whether the draft sits in the RFQ's own thread. */
  inThread: boolean;
  mailbox: string | null;
  /** The Gmail draft's message id. */
  messageId: string | null;
  /** Why there's no mailbox draft (PDF only), or the last problem. */
  note: string | null;
  /** No mailbox draft: the estimator downloads the quote PDF instead. */
  pdfOnly: boolean;
  provider: "gmail" | "outlook" | "none";
  /** Quote numbers given to each line (by line id) for the draft and PDF. */
  quoteNos: Record<string, string>;
  /** Drafts replaced because the RFQ was estimated again. */
  replaced: number;
  sent: { at: string; messageId: string; prices: SentPrice[] } | null;
  subject: string;
  /** Gmail thread id or Outlook conversation id of the draft. */
  threadId: string | null;
  to: string | null;
  updatedAt: string;
}
