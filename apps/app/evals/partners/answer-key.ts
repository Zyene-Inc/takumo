// A design partner's answer key (docs/PRODUCT-PLAN.md F0.1): real RFQs with
// the quote the estimator actually sent, and real "can we ship by X?"
// questions with the planner's answer. One Excel workbook per shop, filled in
// by people, so every cell is checked and every problem is reported with its
// sheet and row. Pure, so tested.

import { read, utils, type WorkBook, type WorkSheet, write } from "xlsx";
import { z } from "zod";

export const SHEETS = {
  shop: "Shop",
  quotes: "Quotes",
  feasibility: "Feasibility",
} as const;

/** Columns per sheet, in order, as the template has them. */
export const COLUMNS = {
  quotes: [
    "quote_id",
    "rfq_files",
    "received_date",
    "sent_date",
    "customer",
    "part_no",
    "rev",
    "material",
    "finish",
    "qty",
    "unit_price",
    "lead_time_days",
    "outcome",
    "estimator_minutes",
  ],
  feasibility: [
    "case_id",
    "asked_date",
    "part_no",
    "rev",
    "qty",
    "requested_date",
    "planner_answer",
    "planner_date",
    "actual_ship_date",
    "notes",
  ],
} as const;

/** Shop sheet: one setting per row (key in column A, value in column B). */
export const SHOP_KEYS = [
  "shop_name",
  "org_id",
  "currency",
  "avg_minutes_per_quote",
  "quotes_per_week",
  "win_rate",
  "on_time_rate",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPLIT_FILES = /[;\n,]+/;

const date = z.string().regex(ISO_DATE, "must be a date (YYYY-MM-DD)");
const optionalText = z.string().trim().min(1).nullable();

const quoteRow = z.object({
  quote_id: z.string().trim().min(1, "is required"),
  rfq_files: z
    .array(z.string().trim().min(1))
    .min(1, "needs at least one file"),
  received_date: date,
  sent_date: date.nullable(),
  customer: optionalText,
  part_no: z.string().trim().min(1, "is required"),
  rev: optionalText,
  material: optionalText,
  finish: optionalText,
  qty: z.number().int("must be a whole number").positive("must be above 0"),
  unit_price: z.number().positive("must be above 0"),
  lead_time_days: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["won", "lost", "pending"]).nullable(),
  estimator_minutes: z.number().positive().nullable(),
});

const feasibilityRow = z.object({
  case_id: z.string().trim().min(1, "is required"),
  asked_date: date,
  part_no: z.string().trim().min(1, "is required"),
  rev: optionalText,
  qty: z.number().int("must be a whole number").positive("must be above 0"),
  requested_date: date,
  planner_answer: z.enum(["yes", "no"], {
    error: 'must be "yes" or "no"',
  }),
  planner_date: date.nullable(),
  actual_ship_date: date.nullable(),
  notes: optionalText,
});

export interface QuoteBreak {
  leadTimeDays: number | null;
  qty: number;
  unitPrice: number;
}

/** One part on one RFQ, with the price breaks that were sent. */
export interface ExpectedLine {
  breaks: QuoteBreak[];
  finish: string | null;
  material: string | null;
  partNo: string;
  rev: string | null;
}

export interface QuoteCase {
  customer: string | null;
  estimatorMinutes: number | null;
  files: string[];
  id: string;
  lines: ExpectedLine[];
  outcome: "won" | "lost" | "pending" | null;
  receivedDate: string;
  sentDate: string | null;
}

export interface FeasibilityCase {
  actualShipDate: string | null;
  askedDate: string;
  id: string;
  notes: string | null;
  partNo: string;
  plannerAnswer: "yes" | "no";
  plannerDate: string | null;
  qty: number;
  requestedDate: string;
  rev: string | null;
}

export interface AnswerKey {
  baseline: {
    avgMinutesPerQuote: number | null;
    onTimeRate: number | null;
    quotesPerWeek: number | null;
    winRate: number | null;
  };
  currency: string;
  feasibility: FeasibilityCase[];
  orgId: string;
  quotes: QuoteCase[];
  shopName: string;
}

export interface Problem {
  message: string;
  row?: number;
  sheet: string;
}

type Cell = string | number | boolean | Date | null | undefined;

const text = (cell: Cell) => {
  if (cell === null || cell === undefined) {
    return null;
  }
  const s = String(cell).trim();
  return s ? s : null;
};

/** Excel dates arrive as Date objects (cellDates); typed text as strings. */
const isoDate = (cell: Cell) => {
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime())
      ? "invalid"
      : cell.toISOString().slice(0, 10);
  }
  return text(cell);
};

const num = (cell: Cell) => {
  if (typeof cell === "number") {
    return cell;
  }
  const s = text(cell)?.replace(/[$,%\s]/g, "");
  if (!s) {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** A rate typed as 0.3, 30 or "30%" → 0.3. */
const rate = (cell: Cell) => {
  const n = num(cell);
  if (n === null || Number.isNaN(n)) {
    return null;
  }
  return n > 1 ? n / 100 : n;
};

const lower = (cell: Cell) => text(cell)?.toLowerCase() ?? null;

const rowsOf = (sheet: WorkSheet) =>
  utils.sheet_to_json<Record<string, Cell>>(sheet, {
    defval: null,
    raw: true,
  });

/** Header cells as people type them ("Part No.", "part no") → part_no. */
const normalizeKeys = (row: Record<string, Cell>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, ""),
      v,
    ])
  );

const issues = (sheet: string, row: number, error: z.ZodError): Problem[] =>
  error.issues.map((i) => ({
    sheet,
    row,
    message: `${String(i.path[0] ?? "row")} ${i.message}`,
  }));

const readShop = (book: WorkBook, problems: Problem[]) => {
  const sheet = book.Sheets[SHEETS.shop];
  const values = new Map<string, Cell>();
  if (!sheet) {
    problems.push({ sheet: SHEETS.shop, message: "sheet is missing" });
    return values;
  }
  for (const row of utils.sheet_to_json<Cell[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
  })) {
    const key = lower(row[0])?.replace(/[^a-z0-9]+/g, "_");
    if (key) {
      values.set(key, row[1]);
    }
  }
  for (const key of ["shop_name", "org_id"]) {
    if (!text(values.get(key))) {
      problems.push({ sheet: SHEETS.shop, message: `${key} is required` });
    }
  }
  return values;
};

const readQuotes = (book: WorkBook, problems: Problem[]) => {
  const sheet = book.Sheets[SHEETS.quotes];
  if (!sheet) {
    problems.push({ sheet: SHEETS.quotes, message: "sheet is missing" });
    return [];
  }
  const byId = new Map<string, QuoteCase>();
  rowsOf(sheet).forEach((raw, i) => {
    const row = normalizeKeys(raw);
    if (Object.values(row).every((v) => text(v) === null)) {
      return;
    }
    const parsed = quoteRow.safeParse({
      quote_id: text(row.quote_id) ?? "",
      rfq_files: (text(row.rfq_files) ?? "")
        .split(SPLIT_FILES)
        .map((f) => f.trim())
        .filter(Boolean),
      received_date: isoDate(row.received_date) ?? "",
      sent_date: isoDate(row.sent_date),
      customer: text(row.customer),
      part_no: text(row.part_no) ?? "",
      rev: text(row.rev),
      material: text(row.material),
      finish: text(row.finish),
      qty: num(row.qty) ?? Number.NaN,
      unit_price: num(row.unit_price) ?? Number.NaN,
      lead_time_days: num(row.lead_time_days),
      outcome: lower(row.outcome),
      estimator_minutes: num(row.estimator_minutes),
    });
    // Row 1 is the header.
    if (!parsed.success) {
      problems.push(...issues(SHEETS.quotes, i + 2, parsed.error));
      return;
    }
    const r = parsed.data;
    const quote = byId.get(r.quote_id) ?? {
      id: r.quote_id,
      files: r.rfq_files,
      receivedDate: r.received_date,
      sentDate: r.sent_date,
      customer: r.customer,
      outcome: r.outcome,
      estimatorMinutes: r.estimator_minutes,
      lines: [],
    };
    const key = `${r.part_no.toUpperCase()}|${(r.rev ?? "").toUpperCase()}`;
    let line = quote.lines.find(
      (l) => `${l.partNo.toUpperCase()}|${(l.rev ?? "").toUpperCase()}` === key
    );
    if (!line) {
      line = {
        partNo: r.part_no,
        rev: r.rev,
        material: r.material,
        finish: r.finish,
        breaks: [],
      };
      quote.lines.push(line);
    }
    if (line.breaks.some((b) => b.qty === r.qty)) {
      problems.push({
        sheet: SHEETS.quotes,
        row: i + 2,
        message: `quantity ${r.qty} of ${r.part_no} is listed twice in ${r.quote_id}`,
      });
      return;
    }
    line.breaks.push({
      qty: r.qty,
      unitPrice: r.unit_price,
      leadTimeDays: r.lead_time_days,
    });
    byId.set(r.quote_id, quote);
  });
  return [...byId.values()];
};

const readFeasibility = (book: WorkBook, problems: Problem[]) => {
  const sheet = book.Sheets[SHEETS.feasibility];
  if (!sheet) {
    // Optional: a shop may share quotes first.
    return [];
  }
  const cases: FeasibilityCase[] = [];
  rowsOf(sheet).forEach((raw, i) => {
    const row = normalizeKeys(raw);
    if (Object.values(row).every((v) => text(v) === null)) {
      return;
    }
    const parsed = feasibilityRow.safeParse({
      case_id: text(row.case_id) ?? "",
      asked_date: isoDate(row.asked_date) ?? "",
      part_no: text(row.part_no) ?? "",
      rev: text(row.rev),
      qty: num(row.qty) ?? Number.NaN,
      requested_date: isoDate(row.requested_date) ?? "",
      planner_answer: lower(row.planner_answer) ?? "",
      planner_date: isoDate(row.planner_date),
      actual_ship_date: isoDate(row.actual_ship_date),
      notes: text(row.notes),
    });
    if (!parsed.success) {
      problems.push(...issues(SHEETS.feasibility, i + 2, parsed.error));
      return;
    }
    const r = parsed.data;
    cases.push({
      id: r.case_id,
      askedDate: r.asked_date,
      partNo: r.part_no,
      rev: r.rev,
      qty: r.qty,
      requestedDate: r.requested_date,
      plannerAnswer: r.planner_answer,
      plannerDate: r.planner_date,
      actualShipDate: r.actual_ship_date,
      notes: r.notes,
    });
  });
  return cases;
};

/**
 * Read an answer-key workbook. `files` lists the RFQ files present next to it,
 * so a quote naming a file that isn't there is reported.
 */
export const readAnswerKey = (
  bytes: Uint8Array,
  files: string[] = []
): { key: AnswerKey | null; problems: Problem[] } => {
  const problems: Problem[] = [];
  const book = read(bytes, { type: "array", cellDates: true });
  const shop = readShop(book, problems);
  const quotes = readQuotes(book, problems);
  const feasibility = readFeasibility(book, problems);
  const present = new Set(files.map((f) => f.toLowerCase()));
  for (const q of quotes) {
    for (const f of q.files) {
      if (files.length && !present.has(f.toLowerCase())) {
        problems.push({
          sheet: SHEETS.quotes,
          message: `${q.id}: file "${f}" isn't in the files folder`,
        });
      }
    }
  }
  if (quotes.length === 0 && feasibility.length === 0) {
    problems.push({
      sheet: SHEETS.quotes,
      message: "no quotes or feasibility cases",
    });
  }
  if (problems.length) {
    return { key: null, problems };
  }
  return {
    problems,
    key: {
      shopName: text(shop.get("shop_name")) as string,
      orgId: text(shop.get("org_id")) as string,
      currency: text(shop.get("currency")) ?? "USD",
      baseline: {
        avgMinutesPerQuote: num(shop.get("avg_minutes_per_quote")),
        quotesPerWeek: num(shop.get("quotes_per_week")),
        winRate: rate(shop.get("win_rate")),
        onTimeRate: rate(shop.get("on_time_rate")),
      },
      quotes,
      feasibility,
    },
  };
};

/** The blank template, with one example row per sheet. */
export const templateWorkbook = () => {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ["shop_name", "Example Precision"],
      ["org_id", "org_… (from Takumo: Settings → Team)"],
      ["currency", "USD"],
      ["avg_minutes_per_quote", 90],
      ["quotes_per_week", 25],
      ["win_rate", "30%"],
      ["on_time_rate", "85%"],
    ]),
    SHEETS.shop
  );
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      [...COLUMNS.quotes],
      [
        "Q-001",
        "rfq-001.eml; dwg-1234.pdf",
        "2026-10-01",
        "2026-10-03",
        "Cobalt Medical",
        "1234-01",
        "C",
        "6061-T6",
        "Clear anodize Type II",
        100,
        18.4,
        15,
        "won",
        75,
      ],
      [
        "Q-001",
        "rfq-001.eml; dwg-1234.pdf",
        "2026-10-01",
        "2026-10-03",
        "Cobalt Medical",
        "1234-01",
        "C",
        "6061-T6",
        "Clear anodize Type II",
        500,
        12.9,
        20,
        "won",
        75,
      ],
    ]),
    SHEETS.quotes
  );
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      [...COLUMNS.feasibility],
      [
        "F-001",
        "2026-10-20",
        "1234-01",
        "C",
        300,
        "2026-10-24",
        "no",
        "2026-10-29",
        "2026-10-28",
        "Lathe was down Tuesday",
      ],
    ]),
    SHEETS.feasibility
  );
  return write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
};
