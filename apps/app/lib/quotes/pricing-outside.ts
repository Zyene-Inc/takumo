// Outside processes from the shop's suppliers (F2.3-R3).

import type { OutsideProcess } from "@repo/engine-client/types";
import type {
  BuildUpOutside,
  CostSource,
  DrawingReading,
  OutsideSupplier,
} from "./types";

export const PROCESS_WORDS: Record<string, RegExp> = {
  anodize: /anodi[sz]/i,
  plating: /plat|zinc|nickel|chrom|cadmium|tin\b|electroless/i,
  heat_treat:
    /heat ?treat|harden|temper|anneal|stress ?relie|\bht\b|nitrid|carburiz/i,
  passivation: /passivat/i,
  paint: /paint|powder ?coat|e-?coat/i,
};

export const kindOf = (text: string) =>
  Object.entries(PROCESS_WORDS).find(([, re]) => re.test(text))?.[0] ?? null;

/** The shop's supplier for a process, matched by name or by kind. */
export const supplierFor = (
  description: string,
  suppliers: OutsideSupplier[]
): OutsideSupplier | null => {
  const text = description.toLowerCase();
  const direct = suppliers.find(
    (s) => s.process.trim() && text.includes(s.process.trim().toLowerCase())
  );
  if (direct) {
    return direct;
  }
  const kind = kindOf(description);
  return kind
    ? (suppliers.find((s) => kindOf(s.process) === kind) ?? null)
    : null;
};

export const outsideSource = (
  priced: boolean,
  saved: boolean,
  supplier: OutsideSupplier | null
): CostSource => {
  if (!priced) {
    return { kind: "default", label: "No price yet: ask your supplier" };
  }
  if (saved) {
    return { kind: "estimator", label: "Entered by the estimator" };
  }
  return {
    kind: "supplier",
    label: supplier?.supplier
      ? `${supplier.supplier} (Settings → Quoting)`
      : "Shop's outside-process price (Settings → Quoting)",
  };
};

/** One description per finish on the drawing, else the line's finish text. */
export const finishDescriptions = (
  finishes: DrawingReading["finishes"],
  lineFinish: string | null
) => {
  if (finishes.length) {
    return finishes.map((f) =>
      f.spec && !f.value.includes(f.spec) ? `${f.value} per ${f.spec}` : f.value
    );
  }
  return lineFinish ? [lineFinish] : [];
};

/** Finish families, each with the word stems that name its station. */
export const FINISH_STATIONS: [RegExp, RegExp][] = [
  [/anodi[sz]/i, /anodi[sz]/i],
  [/passivat/i, /passivat/i],
  [/heat.?treat|harden|temper|anneal/i, /heat.?treat|furnace|harden/i],
  [/black oxide/i, /black oxide/i],
  [/chem.?film|alodine|chromate|iridite/i, /chem.?film|alodine|chromate/i],
  [/powder.?coat/i, /powder/i],
  [/paint/i, /paint/i],
  // "Plating line", never "Plate saw".
  [/plating|plated|zinc|nickel|chrome/i, /plating|plater/i],
];

/**
 * Whether the shop does this finish itself: one of its work centers is a
 * station for it ("Passivation tank", type "Anodize line"). Pure, so tested.
 */
export const doneInHouse = (finish: string, stations: string[]) => {
  const family = FINISH_STATIONS.find(([named]) => named.test(finish));
  return Boolean(family && stations.some((s) => family[1].test(s)));
};

export interface OutsidePlan {
  meta: BuildUpOutside[];
  outside: OutsideProcess[];
}

/**
 * Outside operations for a line: the estimator's when saved; else one per
 * finish on the drawing (or the line's finish text) the shop doesn't do
 * itself, priced from the shop's suppliers. A process with no known price is
 * kept, to ask the supplier (leaving it out would under-quote).
 */
export const outsideProcesses = (input: {
  drawingFinishes: DrawingReading["finishes"];
  lineFinish: string | null;
  saved: OutsideProcess[] | null;
  /** The shop's work centers (names and types): finishes done in house. */
  stations?: string[];
  suppliers: OutsideSupplier[];
}): OutsidePlan => {
  const describe = (p: OutsideProcess): BuildUpOutside => {
    const s = supplierFor(p.description, input.suppliers);
    const priced = p.cost_per_lot != null || p.cost_per_unit != null;
    return {
      process: p.description,
      supplier: s?.supplier ?? null,
      cost: null,
      leadTimeDays: s?.leadTimeDays ?? null,
      askSupplier: !priced,
      source: outsideSource(priced, Boolean(input.saved), s),
    };
  };
  if (input.saved) {
    return { outside: input.saved, meta: input.saved.map(describe) };
  }
  const descriptions = finishDescriptions(
    input.drawingFinishes,
    input.lineFinish
  );
  const outside = descriptions
    .filter((d) => d.trim() && !doneInHouse(d, input.stations ?? []))
    .map((description): OutsideProcess => {
      const s = supplierFor(description, input.suppliers);
      return {
        description,
        cost_per_unit: s?.costPerPart ?? null,
        cost_per_lot: s?.lotCharge ?? null,
      };
    });
  return { outside, meta: outside.map(describe) };
};

/** Days outside processes add after machining: they run one after another. */
export const outsideDays = (meta: BuildUpOutside[]) =>
  meta.reduce((sum, m) => sum + (m.leadTimeDays ?? 0), 0);

// ---------------------------------------------------------------------------
// Where an operation's times came from (F2.3-R4)
