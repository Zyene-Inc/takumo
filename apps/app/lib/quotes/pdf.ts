// The quote a customer receives, as a PDF. No database: takes the numbers
// already approved, so it's tested on its own.

import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

export interface QuoteDocumentLine {
  breaks: {
    leadTimeDays: number;
    price: number;
    qty: number;
    unitPrice: number;
  }[];
  description: string | null;
  finish: string | null;
  material: string | null;
  partNo: string;
  quoteNo: string;
  rev: string | null;
}

export interface QuoteDocument {
  contact: string | null;
  customer: string;
  date: string;
  lines: QuoteDocumentLine[];
  notes: string[];
  paymentTerms: string | null;
  reference: string;
  requestedDate: string | null;
  shop: string;
}

const PAGE = { width: 612, height: 792 }; // US Letter, points
const MARGIN = 50;
const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);
const SPACES = /\s+/;

// Column x positions (left edges); numbers are right-aligned to the next edge.
const COLS = {
  item: MARGIN,
  part: MARGIN + 52,
  qty: 330,
  unit: 400,
  total: 480,
  lead: 562,
};

const money = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Standard PDF fonts only cover Latin-1; replace anything else. */
const safe = (font: PDFFont, text: string) =>
  [...text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return "?";
      }
    })
    .join("");

const wrap = (font: PDFFont, text: string, size: number, width: number) => {
  const lines: string[] = [];
  for (const paragraph of safe(font, text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(SPACES).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
};

export const renderQuotePdf = async (doc: QuoteDocument) => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Quotation ${doc.reference}`);
  pdf.setAuthor(doc.shop);
  pdf.setCreator("Takumo");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const text = (
    value: string,
    x: number,
    options: {
      size?: number;
      font?: PDFFont;
      color?: typeof INK;
      right?: boolean;
    } = {}
  ) => {
    const font = options.font ?? regular;
    const size = options.size ?? 9;
    const clean = safe(font, value);
    const width = font.widthOfTextAtSize(clean, size);
    page.drawText(clean, {
      x: options.right ? x - width : x,
      y,
      size,
      font,
      color: options.color ?? INK,
    });
  };
  const rule = () =>
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE.width - MARGIN, y },
      thickness: 0.6,
      color: RULE,
    });
  const tableHeader = () => {
    text("Item", COLS.item, { font: bold, size: 8, color: MUTED });
    text("Part / description", COLS.part, {
      font: bold,
      size: 8,
      color: MUTED,
    });
    text("Qty", COLS.unit - 12, {
      font: bold,
      size: 8,
      color: MUTED,
      right: true,
    });
    text("Unit price", COLS.total - 12, {
      font: bold,
      size: 8,
      color: MUTED,
      right: true,
    });
    text("Extended", COLS.lead - 52, {
      font: bold,
      size: 8,
      color: MUTED,
      right: true,
    });
    text("Lead time", COLS.lead, {
      font: bold,
      size: 8,
      color: MUTED,
      right: true,
    });
    y -= 6;
    rule();
    y -= 14;
  };
  const ensure = (space: number) => {
    if (y - space < MARGIN + 30) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
      tableHeader();
    }
  };

  // Heading
  text(doc.shop, MARGIN, { font: bold, size: 16 });
  text("QUOTATION", PAGE.width - MARGIN, { font: bold, size: 16, right: true });
  y -= 18;
  text(doc.reference, PAGE.width - MARGIN, {
    size: 10,
    color: MUTED,
    right: true,
  });
  y -= 30;

  const facts: [string, string | null][] = [
    ["Customer", doc.customer],
    ["Attention", doc.contact],
    ["Date", doc.date],
    ["Payment terms", doc.paymentTerms],
    ["Requested by", doc.requestedDate],
  ];
  for (const [label, value] of facts) {
    if (!value) {
      continue;
    }
    text(label, MARGIN, { size: 9, color: MUTED });
    text(value, MARGIN + 90, { size: 9 });
    y -= 14;
  }
  y -= 14;
  tableHeader();

  doc.lines.forEach((line, index) => {
    const title = `${line.partNo}${line.rev ? ` rev ${line.rev}` : ""}`;
    const details = [
      line.description,
      line.material ? `Material: ${line.material}` : null,
      line.finish ? `Finish: ${line.finish}` : null,
    ].filter((d): d is string => Boolean(d));
    const detailLines = details.flatMap((d) =>
      wrap(regular, d, 8, COLS.qty - COLS.part - 10)
    );
    const rows = Math.max(line.breaks.length, detailLines.length + 1);
    ensure(rows * 12 + 10);

    text(String(index + 1), COLS.item, { font: bold });
    const top = y;
    text(title, COLS.part, { font: bold });
    y -= 12;
    for (const d of detailLines) {
      text(d, COLS.part, { size: 8, color: MUTED });
      y -= 11;
    }
    const after = y;
    y = top;
    // Quote number under the item number.
    y -= 12;
    text(line.quoteNo, COLS.item, { size: 7, color: MUTED });
    y = top;
    for (const b of line.breaks) {
      text(b.qty.toLocaleString("en-US"), COLS.unit - 12, { right: true });
      text(money(b.unitPrice), COLS.total - 12, { right: true });
      text(money(b.price), COLS.lead - 52, { right: true });
      text(`${b.leadTimeDays} days`, COLS.lead, { right: true });
      y -= 12;
    }
    y = Math.min(y, after) - 6;
    rule();
    y -= 14;
  });

  if (doc.notes.length) {
    ensure(20 + doc.notes.length * 12);
    y -= 4;
    text("Notes", MARGIN, { font: bold, size: 9 });
    y -= 13;
    for (const note of doc.notes) {
      for (const l of wrap(regular, note, 8.5, PAGE.width - 2 * MARGIN)) {
        ensure(12);
        text(l, MARGIN, { size: 8.5, color: MUTED });
        y -= 11;
      }
    }
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    y = MARGIN - 10;
    text(
      `${doc.reference} · Lead times are calendar days from order.`,
      MARGIN,
      { size: 7, color: MUTED }
    );
    text(`Page ${i + 1} of ${pages.length}`, PAGE.width - MARGIN, {
      size: 7,
      color: MUTED,
      right: true,
    });
  });

  return pdf.save();
};
