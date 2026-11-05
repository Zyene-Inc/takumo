// Checks a customer's PO against what the shop quoted, so whoever enters it
// in the ERP sees every difference first. Pure.

import { matchCustomer, matchPart, normalizePartNo } from "../quotes/match";
import { type KnownCustomer, recognise } from "../quotes/screen";
import type { PoCheck, PoHeader, PoLine, QuoteMatch } from "./types";

const DAY_MS = 86_400_000;
/** Prices within this share of the quote count as the same. */
const PRICE_TOLERANCE = 0.005;

export interface CustomerRow extends KnownCustomer {
  name: string;
}

export interface QuoteRow {
  breaks: { leadTimeDays: number; qty: number; unitPrice: number }[];
  customerId: string | null;
  id: string;
  leadTimeDays: number | null;
  part: { partNo: string; rev: string } | null;
  price: number | null;
  qty: number;
  quotedAt: Date;
  quoteNo: string;
  rfqId: string | null;
  status: string;
}

interface CheckInput {
  customers: CustomerRow[];
  header: PoHeader;
  lines: PoLine[];
  parts: { id: string; partNo: string; rev: string }[];
  quotes: QuoteRow[];
  sender: string | null;
  /** ISO day. */
  today: string;
  /** How long a quote's prices hold (QuoteSettings.quoteValidityDays). */
  validityDays: number;
}

interface CheckResult {
  checks: PoCheck[];
  customerId: string | null;
  lines: PoLine[];
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** The customer: by the sender's address or domain first, then by name. */
const findCustomer = (
  sender: string | null,
  name: string | null,
  customers: CustomerRow[]
) =>
  recognise(sender, { customers, senders: [], shopDomain: null }).customerId ??
  matchCustomer(name, customers)?.id ??
  null;

/** The quoted quantities as breaks (an old quote may have none stored). */
const breaksOf = (q: QuoteRow) => {
  if (q.breaks.length) {
    return q.breaks;
  }
  if (q.price === null || q.qty <= 0) {
    return [];
  }
  return [
    {
      qty: q.qty,
      unitPrice: Math.round((q.price / q.qty) * 100) / 100,
      leadTimeDays: q.leadTimeDays ?? 0,
    },
  ];
};

/** The break for this quantity, or the nearest one (ties: the larger). */
export const nearestBreak = <T extends { qty: number }>(
  breaks: T[],
  qty: number
) =>
  [...breaks].sort(
    (a, b) => Math.abs(a.qty - qty) - Math.abs(b.qty - qty) || b.qty - a.qty
  )[0] ?? null;

const sameRev = (a: string | null, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * The customer's latest open or won quote for this part: same revision if
 * there is one, else any revision (flagged).
 */
export const findQuote = (
  line: Pick<PoLine, "partNo" | "rev">,
  customerId: string | null,
  quotes: QuoteRow[]
) => {
  if (!(customerId && line.partNo)) {
    return null;
  }
  const want = normalizePartNo(line.partNo);
  const forPart = quotes
    .filter(
      (q) =>
        q.customerId === customerId &&
        (q.status === "open" || q.status === "won") &&
        q.part &&
        normalizePartNo(q.part.partNo) === want
    )
    .sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime());
  return (
    forPart.find((q) => !line.rev || sameRev(line.rev, q.part?.rev)) ??
    forPart[0] ??
    null
  );
};

const warn = (kind: PoCheck["kind"], message: string): PoCheck => ({
  kind,
  message,
  severity: "warn",
});
const info = (kind: PoCheck["kind"], message: string): PoCheck => ({
  kind,
  message,
  severity: "info",
});

/** Price, quantity, lead time and validity against the matched quote. */
const quoteChecks = (
  line: PoLine,
  quote: QuoteRow,
  input: CheckInput
): { checks: PoCheck[]; match: QuoteMatch | null } => {
  const checks: PoCheck[] = [];
  if (line.rev && quote.part && !sameRev(line.rev, quote.part.rev)) {
    checks.push(
      warn(
        "rev_differs",
        `The PO is for rev ${line.rev}; ${quote.quoteNo} quoted rev ${quote.part.rev}.`
      )
    );
  }
  const age = Math.floor(
    (Date.parse(`${input.today}T00:00:00Z`) - quote.quotedAt.getTime()) / DAY_MS
  );
  if (age > input.validityDays) {
    checks.push(
      warn(
        "quote_expired",
        `${quote.quoteNo} is ${age} days old; its prices held for ${input.validityDays} days.`
      )
    );
  }
  const breaks = breaksOf(quote);
  const chosen = line.qty ? nearestBreak(breaks, line.qty) : null;
  if (!chosen) {
    return { checks, match: null };
  }
  if (line.qty && chosen.qty !== line.qty) {
    checks.push(
      warn(
        "qty_not_quoted",
        `You quoted ${breaks.map((b) => b.qty.toLocaleString("en-US")).join(" and ")} pcs; the PO is for ${line.qty.toLocaleString("en-US")}. Nearest: ${chosen.qty.toLocaleString("en-US")} at ${money(chosen.unitPrice)} each.`
      )
    );
  }
  if (
    line.unitPrice !== null &&
    Math.abs(line.unitPrice - chosen.unitPrice) >
      chosen.unitPrice * PRICE_TOLERANCE
  ) {
    checks.push(
      warn(
        "price_differs",
        `${money(line.unitPrice)} each on the PO; you quoted ${money(chosen.unitPrice)} (${quote.quoteNo}).`
      )
    );
  }
  if (line.dueDate && chosen.leadTimeDays > 0) {
    const earliest = addDays(input.today, chosen.leadTimeDays);
    if (line.dueDate < earliest) {
      checks.push(
        warn(
          "due_before_lead_time",
          `Due ${day(line.dueDate)}; you quoted ${chosen.leadTimeDays} days, so ${day(earliest)} at the earliest from today.`
        )
      );
    }
  }
  return {
    checks,
    match: {
      quoteId: quote.id,
      quoteNo: quote.quoteNo,
      rfqId: quote.rfqId,
      qty: chosen.qty,
      unitPrice: chosen.unitPrice,
      leadTimeDays: chosen.leadTimeDays,
    },
  };
};

/** Every check on a PO, with each line matched to its part and quote. */
export const checkPo = (input: CheckInput): CheckResult => {
  const customerId = findCustomer(
    input.sender,
    input.header.customerName,
    input.customers
  );
  const checks: PoCheck[] = [];
  if (!customerId) {
    checks.push(
      warn(
        "customer_unknown",
        `Takumo couldn't match ${input.header.customerName ?? input.sender ?? "the customer"} to one of your customers.`
      )
    );
  }
  if (!input.header.poNo) {
    checks.push(warn("missing_field", "No PO number found on it."));
  }
  const lines = input.lines.map((line) => {
    const lineChecks: PoCheck[] = [];
    if (!line.partNo) {
      lineChecks.push(warn("missing_field", "No part number on this line."));
    }
    if (line.qty === null) {
      lineChecks.push(warn("missing_field", "No quantity on this line."));
    }
    if (!line.dueDate) {
      lineChecks.push(info("missing_field", "No due date on this line."));
    }
    const { part, otherRev } = matchPart(line.partNo, line.rev, input.parts);
    if (line.partNo && !part && !otherRev) {
      lineChecks.push(
        warn("unknown_part", `${line.partNo} isn't one of your parts yet.`)
      );
    }
    const quote = findQuote(line, customerId, input.quotes);
    if (!quote) {
      if (line.partNo && customerId) {
        lineChecks.push(
          warn(
            "no_quote",
            `No open quote to this customer for ${line.partNo}: check the price before entering it.`
          )
        );
      }
      return {
        ...line,
        partId: part?.id ?? otherRev?.id ?? null,
        checks: lineChecks,
      };
    }
    const q = quoteChecks(line, quote, input);
    return {
      ...line,
      partId: part?.id ?? otherRev?.id ?? null,
      quote: q.match,
      checks: [...lineChecks, ...q.checks],
    };
  });
  return { customerId, checks, lines };
};

/**
 * Quotes the PO clearly accepts: each line matched to an open quote of the
 * same revision, every matched quote used by one line only. Anything less
 * certain is left for a person.
 */
export const acceptedQuotes = (lines: PoLine[]) => {
  const ids = lines.map((l) => l.quote?.quoteId).filter(Boolean);
  if (ids.length !== new Set(ids).size) {
    return [];
  }
  return lines.filter(
    (l): l is PoLine & { qty: number; quote: QuoteMatch } =>
      l.quote !== null &&
      l.qty !== null &&
      !l.checks.some((c) => c.kind === "rev_differs")
  );
};
