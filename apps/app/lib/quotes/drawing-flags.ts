// The checks a drawing goes through: material, finish, tolerances, envelope, certifications, conflicts.

import {
  fits,
  machineEnvelope,
  partSize,
  plusMinusInches,
  type Rect,
  type Round,
  tightestTolerance,
} from "./drawing-measure";
import { normalizePartNo } from "./match";
import { doneInHouse } from "./pricing";
import type {
  DrawingFlag,
  DrawingReading,
  DrawingValue,
  OutsideSupplier,
} from "./types";

export interface CheckContext {
  /** Certifications the shop holds (QuoteSettings.certifications). */
  certifications: string[];
  /** The RFQ line the drawing was matched to, as the customer wrote it. */
  line: {
    finish: string | null;
    materialText: string | null;
    partNo: string | null;
    rev: string | null;
  } | null;
  machines: { envelope: unknown; name: string; toleranceIn: number | null }[];
  /** The material matched a Material the shop has (or has bought). */
  materialKnown: boolean;
  outsideProcesses: Pick<OutsideSupplier, "process" | "supplier">[];
  /** QuoteSettings.toleranceIn */
  shopToleranceIn: number;
}

export const NOT_ALNUM = /[^a-z0-9]+/g;

export const GRADE = /\b[a-z]?\d{3,4}\b/g;

export const WORD = /[a-z0-9]+/g;

export const squash = (s: string) => s.toLowerCase().replace(NOT_ALNUM, "");

/**
 * Two ways of writing the same thing ("6061-T6 AL" vs "AL 6061-T6 PER AMS…"):
 * one contains the other, or the grades agree and most words are shared.
 */
export const sameText = (a: string, b: string) => {
  const x = squash(a);
  const y = squash(b);
  if (!(x && y)) {
    return true;
  }
  if (x.includes(y) || y.includes(x)) {
    return true;
  }
  const ga = new Set(a.toLowerCase().match(GRADE) ?? []);
  const gb = new Set(b.toLowerCase().match(GRADE) ?? []);
  if (ga.size && gb.size) {
    return [...ga].some((g) => gb.has(g));
  }
  const wa = new Set(a.toLowerCase().match(WORD) ?? []);
  const wb = new Set(b.toLowerCase().match(WORD) ?? []);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.6;
};

export const REV_WORD = /^rev(ision)?/;

export const AS9100 = /^(as9100)[a-z]*$/;

export const ISO = /^(iso\d{4,5}).*$/;

export const IATF = /^(iatf16949).*$/;

export const sameRev = (a: string, b: string) =>
  squash(a).replace(REV_WORD, "") === squash(b).replace(REV_WORD, "");

export const at = (v: DrawingValue<unknown> | null | undefined) =>
  v ? { sheet: v.sheet, box: v.box } : { sheet: null, box: null };

export const inches = (n: number) =>
  `±${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })} in`;

export const FINISH_WORDS: Record<string, string[]> = {
  anodize: ["anodize", "anodizing", "anodise", "anod"],
  plating: ["plate", "plating", "zinc", "nickel", "chrome", "cadmium"],
  heat_treat: ["heat", "harden", "temper", "nitride", "carburize"],
  passivation: ["passivate", "passivation"],
  paint: ["paint", "powder", "coat", "primer"],
};

/** The outside supplier for a finish, if the shop has one for it. */
export const supplierFor = (
  finish: DrawingReading["finishes"][number],
  suppliers: CheckContext["outsideProcesses"]
) => {
  const text = `${finish.text} ${finish.spec ?? ""}`.toLowerCase();
  const kindWords = FINISH_WORDS[finish.kind] ?? [];
  return (
    suppliers.find((s) => {
      const process = s.process.toLowerCase();
      const words = process.match(WORD) ?? [];
      return (
        words.some((w) => w.length > 3 && text.includes(w)) ||
        kindWords.some((w) => process.includes(w))
      );
    }) ?? null
  );
};

export const CERT_NAME =
  /\b(as\s?9100\w*|iso\s?9001|iso\s?13485|nadcap|itar|iatf\s?16949|ear)\b/i;

export const CERT_NAMES = new RegExp(CERT_NAME.source, "gi");

/** "AS9100D", "AS9100 Rev D", "ISO 9001:2015" → "as9100", "iso9001". */
export const certKey = (s: string) =>
  squash(s.match(CERT_NAME)?.[0] ?? s)
    .replace(AS9100, "$1")
    .replace(ISO, "$1")
    .replace(IATF, "$1");

export const label = (reading: DrawingReading) =>
  reading.titleBlock.partNo?.value ??
  reading.titleBlock.drawingNo?.value ??
  "this part";

export const KEY_VALUES = (r: DrawingReading) =>
  [
    ["part number", r.titleBlock.partNo],
    ["revision", r.titleBlock.rev],
    ["material", r.material],
    ...r.finishes.map((f) => ["finish", f] as const),
    ["overall size", r.envelope],
  ] as const;

export interface Found {
  flags: DrawingFlag[];
  questions: string[];
}

export const flagAt = (
  kind: DrawingFlag["kind"],
  message: string,
  where: DrawingValue<unknown> | null | undefined = null
): DrawingFlag => ({ kind, message, ...at(where) });

export const materialFlags = (r: DrawingReading, ctx: CheckContext) =>
  r.material && !ctx.materialKnown
    ? [
        flagAt(
          "new_material",
          `${r.material.text}: not a material you've bought before. Check its price and lead time.`,
          r.material
        ),
      ]
    : [];

export const finishFlags = (r: DrawingReading, ctx: CheckContext) =>
  r.finishes
    // Done at one of the shop's own stations: nothing to check.
    .filter(
      (finish) =>
        !doneInHouse(
          finish.text,
          ctx.machines.map((m) => m.name)
        )
    )
    .map((finish) => {
      const supplier = supplierFor(finish, ctx.outsideProcesses);
      return flagAt(
        "outsourced",
        supplier
          ? `${finish.text}: you send this out${supplier.supplier ? ` (${supplier.supplier})` : ""}. Add its cost and lead time.`
          : `${finish.text}: is this done in house? If it goes out, add the supplier under Settings → Quoting.`,
        finish
      );
    });

/** What a machine holds: its own figure, else the shop's. */
export const holds = (
  m: CheckContext["machines"][number],
  shopToleranceIn: number
) =>
  typeof m.toleranceIn === "number" && m.toleranceIn > 0
    ? m.toleranceIn
    : shopToleranceIn;

/**
 * F2.2-R5, per machine: the tightest tolerance needs a machine that holds it
 * and that the part fits on. A machine with no size given might fit.
 */
export const toleranceFlags = (r: DrawingReading, ctx: CheckContext) => {
  const tight = tightestTolerance(r);
  const tightIn = tight ? plusMinusInches(tight, r.units) : null;
  if (!tight || tightIn === null) {
    return [];
  }
  const within = (t: number) => tightIn >= t - 1e-12;
  if (ctx.machines.length === 0) {
    return within(ctx.shopToleranceIn)
      ? []
      : [
          flagAt(
            "tolerance",
            `${tight.text}: tighter than the ${inches(ctx.shopToleranceIn)} you hold.`,
            tight
          ),
        ];
  }
  const rated = ctx.machines.map((m) => ({
    ...m,
    holds: holds(m, ctx.shopToleranceIn),
  }));
  const holders = rated.filter((m) => within(m.holds));
  if (holders.length === 0) {
    const best = rated.reduce((a, b) => (b.holds < a.holds ? b : a));
    return [
      flagAt(
        "tolerance",
        `${tight.text}: tighter than any of your machines holds (best: ${inches(best.holds)} on ${best.name}).`,
        tight
      ),
    ];
  }
  const size = partSize(r);
  const roomy = holders.filter((m) => {
    const envelope = machineEnvelope(m.envelope);
    return !(size && envelope) || fits(size, envelope);
  });
  if (roomy.length === 0) {
    const names = holders.map((m) => m.name).join(", ");
    return [
      flagAt(
        "tolerance",
        `${tight.text}: only ${names} ${holders.length === 1 ? "holds" : "hold"} this, and the part is larger than ${holders.length === 1 ? "it" : "them"}.`,
        tight
      ),
    ];
  }
  return [];
};

/**
 * A drawing read from a scan or a photo: the numbers came from an image.
 * The tightest tolerance sets the price and who can make it, so if it was
 * hard to read, ask.
 */
export const scanChecks = (r: DrawingReading): Found => {
  const found: Found = { flags: [], questions: [] };
  const tight = tightestTolerance(r);
  if (r.scanned) {
    found.flags.push(
      flagAt(
        "scanned",
        "Scanned drawing: read from an image, not the PDF's text. Check the tolerances, sizes and material against the drawing."
      )
    );
  }
  if (tight && tight.confidence === "low") {
    found.flags.push(
      flagAt(
        "low_confidence",
        `The tightest tolerance was hard to read ("${tight.text}"). Check it on the drawing.`,
        tight
      )
    );
    found.questions.push(
      `For ${label(r)}, please confirm the tightest tolerance: we read it as "${tight.text}".`
    );
  }
  return found;
};

export const envelopeFlags = (r: DrawingReading, ctx: CheckContext) => {
  const size = partSize(r);
  const envelopes = ctx.machines
    .map((m) => machineEnvelope(m.envelope))
    .filter((e): e is Rect | Round => e !== null);
  return size && envelopes.length && !envelopes.some((e) => fits(size, e))
    ? [
        flagAt(
          "envelope",
          `${r.envelope?.text ?? "Overall size"}: larger than any machine you've given a size for.`,
          r.envelope
        ),
      ]
    : [];
};

export const certificationFlags = (r: DrawingReading, ctx: CheckContext) => {
  const held = new Set(ctx.certifications.map(certKey));
  const seen = new Set<string>();
  const flags: DrawingFlag[] = [];
  for (const req of r.requirements) {
    if (!(req.kind === "certification" || req.kind === "itar")) {
      continue;
    }
    const names = req.text.match(CERT_NAMES) ?? [
      req.kind === "itar" ? "ITAR" : req.text,
    ];
    for (const n of names) {
      const key = certKey(n);
      if (!(held.has(key) || seen.has(key))) {
        seen.add(key);
        flags.push(
          flagAt(
            "certification",
            `Requires ${n.toUpperCase()}: not marked as held under Settings → Quoting.`,
            req
          )
        );
      }
    }
  }
  return flags;
};

export const confidenceChecks = (r: DrawingReading): Found => {
  const name = label(r);
  const found: Found = { flags: [], questions: [] };
  for (const [what, v] of KEY_VALUES(r)) {
    if (v?.confidence !== "low") {
      continue;
    }
    found.flags.push(
      flagAt(
        "low_confidence",
        `The ${what} was hard to read ("${v.text}"). Check it on the drawing.`,
        v
      )
    );
    if (what !== "part number" && what !== "overall size") {
      found.questions.push(
        `For ${name}, please confirm the ${what}: we read it as "${v.text}".`
      );
    }
  }
  return found;
};

/** Where the drawing and the RFQ line disagree. */
export const conflictChecks = (r: DrawingReading, ctx: CheckContext): Found => {
  const found: Found = { flags: [], questions: [] };
  const line = ctx.line;
  if (!line) {
    return found;
  }
  const name = label(r);
  const differ = (
    where: DrawingValue<unknown> | null | undefined,
    message: string,
    question: string | null
  ) => {
    found.flags.push(flagAt("conflict", message, where));
    if (question) {
      found.questions.push(question);
    }
  };
  const rev = r.titleBlock.rev;
  if (line.rev && rev && !sameRev(line.rev, rev.value)) {
    differ(
      rev,
      `The drawing is rev ${rev.value}, the RFQ says rev ${line.rev}.`,
      `The drawing for ${name} shows revision ${rev.value}, but the request says revision ${line.rev}. Which revision should we quote?`
    );
  }
  if (
    line.materialText &&
    r.material &&
    !sameText(line.materialText, r.material.text)
  ) {
    differ(
      r.material,
      `The drawing calls for ${r.material.text}, the RFQ says ${line.materialText}.`,
      `For ${name}, the drawing calls for ${r.material.text} but the request says ${line.materialText}. Which material should we quote?`
    );
  }
  const finish = line.finish;
  if (
    finish &&
    r.finishes.length &&
    !r.finishes.some((f) => sameText(finish, f.text))
  ) {
    const drawn = r.finishes.map((f) => f.text).join("; ");
    differ(
      r.finishes[0],
      `The drawing's finish is ${drawn}, the RFQ says ${finish}.`,
      `For ${name}, the drawing specifies ${drawn} but the request says ${finish}. Which finish should we quote?`
    );
  }
  const drawnNo = r.titleBlock.partNo?.value;
  const lineNo = line.partNo ? normalizePartNo(line.partNo) : null;
  if (
    lineNo &&
    drawnNo &&
    lineNo !== normalizePartNo(drawnNo) &&
    lineNo !== normalizePartNo(r.titleBlock.drawingNo?.value ?? "")
  ) {
    differ(
      r.titleBlock.partNo,
      `The drawing's part number is ${drawnNo}, the RFQ line says ${line.partNo}.`,
      null
    );
  }
  return found;
};
