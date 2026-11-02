// Cleans what was read from a PO into the shapes Takumo keeps. Pure.

import type { PoHeader, PoLine } from "./types";

/** What the reader returns for one line, before cleaning. */
export interface RawPoLine {
  description?: string | null;
  dueDate?: string | null;
  extended?: number | null;
  partNo?: string | null;
  qty?: number | null;
  rev?: string | null;
  unitPrice?: number | null;
}

export interface RawPo {
  contact?: string | null;
  customerName?: string | null;
  lines: RawPoLine[];
  notes?: string | null;
  orderDate?: string | null;
  poNo?: string | null;
  shipTo?: string | null;
  terms?: string | null;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const MAX_TEXT = 500;
const MAX_LINES = 200;

/** Trimmed text, or null when empty. */
export const text = (value: string | null | undefined, max = MAX_TEXT) => {
  const t = (value ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** A positive finite number, or null. */
export const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

/** "2026-12-15" (or a longer ISO string) when it's a real calendar day. */
export const isoDay = (value: string | null | undefined) => {
  const m = (value ?? "").trim().match(ISO_DAY);
  if (!m) {
    return null;
  }
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
    ? `${y}-${mo}-${d}`
    : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whole pieces: a PO line's quantity is a count of parts. */
const pieces = (value: number | null | undefined) => {
  const n = positive(value);
  return n === null ? null : Math.round(n);
};

/** The header and lines, cleaned; lines with nothing useful are dropped. */
export const normalizePo = (
  raw: RawPo
): { header: PoHeader; lines: PoLine[] } => {
  const header: PoHeader = {
    poNo: text(raw.poNo, 80),
    customerName: text(raw.customerName, 200),
    contact: text(raw.contact, 200),
    orderDate: isoDay(raw.orderDate),
    shipTo: text(raw.shipTo),
    terms: text(raw.terms, 200),
    notes: text(raw.notes, 2000),
  };
  const lines: PoLine[] = [];
  for (const l of raw.lines.slice(0, MAX_LINES)) {
    const partNo = text(l.partNo, 80);
    const description = text(l.description);
    const qty = pieces(l.qty);
    if (!(partNo || description) || (qty === null && !partNo)) {
      continue;
    }
    let unitPrice = positive(l.unitPrice);
    let extended = positive(l.extended);
    if (unitPrice === null && extended !== null && qty) {
      unitPrice = round2(extended / qty);
    }
    if (extended === null && unitPrice !== null && qty) {
      extended = round2(unitPrice * qty);
    }
    lines.push({
      lineNo: lines.length + 1,
      partNo,
      rev: text(l.rev, 20),
      description,
      qty,
      unitPrice,
      extended,
      dueDate: isoDay(l.dueDate),
      partId: null,
      quote: null,
      checks: [],
    });
  }
  return { header, lines };
};
