// Operations for the part being quoted.
// - A part the shop makes: its routing, with times replaced by what jobs
//   actually took once there are enough of them.
// - A new part: proposed by Claude from the most similar parts the shop
//   makes. Every time is a comparable part's time × a stated factor, so an
//   estimator can see where each number came from and change it.

import type { Operation, QuoteOperation } from "@repo/engine-client/types";
import { normalizePartNo } from "./match";

/** Jobs needed before their actual times replace the routing's. */
export const MIN_ACTUAL_JOBS = 2;
/** How far a factor may scale a comparable part's time. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export interface ActualJob {
  actualRunMin: number | null;
  actualSetupMin: number | null;
  qty: number;
  routingSeq: number;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/** The routing, with each operation's times from finished jobs where there are enough. */
export const withActuals = (
  routing: Operation[],
  jobs: ActualJob[]
): QuoteOperation[] =>
  routing.map((op) => {
    const done = jobs.filter(
      (j) =>
        j.routingSeq === op.seq &&
        j.qty > 0 &&
        j.actualRunMin !== null &&
        j.actualSetupMin !== null
    );
    if (done.length < MIN_ACTUAL_JOBS) {
      return { ...op, source: "routing" };
    }
    const setup = round(median(done.map((j) => j.actualSetupMin ?? 0)), 1);
    const run = round(median(done.map((j) => (j.actualRunMin ?? 0) / j.qty)));
    return {
      ...op,
      setup_min: setup,
      run_min_per_unit: run,
      source: "actuals",
      note: `median of ${done.length} jobs; routing says ${op.setup_min} min + ${op.run_min_per_unit} min/ea`,
    };
  });

export interface CandidatePart {
  customer: string | null;
  description: string | null;
  id: string;
  material: string | null;
  partNo: string;
  rev: string;
  routing: Operation[];
}

const WORDS = /[a-z]{3,}/g;
const STOP = new Set(["the", "and", "for", "with", "per", "pcs", "part"]);

const words = (text: string | null) =>
  new Set((text?.toLowerCase().match(WORDS) ?? []).filter((w) => !STOP.has(w)));

/** Shop parts most like the one on the RFQ, best first. */
export const similarParts = (
  line: {
    description: string | null;
    materialName: string | null;
    partNo: string | null;
  },
  customer: string | null,
  parts: CandidatePart[],
  limit = 6
): CandidatePart[] => {
  const wanted = words(line.description);
  const scored = parts
    .filter((p) => p.routing.length > 0)
    .map((part) => {
      let score = 0;
      if (
        line.partNo &&
        normalizePartNo(part.partNo) === normalizePartNo(line.partNo)
      ) {
        score += 10; // another revision of the same part
      }
      if (line.materialName && part.material === line.materialName) {
        score += 3;
      }
      const shared = [...words(part.description)].filter((w) =>
        wanted.has(w)
      ).length;
      score += shared * 2;
      if (customer && part.customer === customer) {
        score += 1;
      }
      return { part, score };
    })
    .sort(
      (a, b) => b.score - a.score || a.part.partNo.localeCompare(b.part.partNo)
    );
  return scored.slice(0, limit).map((s) => s.part);
};

/** One operation as the model proposes it. */
export interface ProposedOp {
  basisPartNo: string | null;
  basisSeq: number | null;
  reason: string;
  runMinPerUnit: number | null;
  runScale: number | null;
  setupMin: number | null;
  setupScale: number | null;
  workCenter: string;
}

const clampScale = (value: number | null) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, value ?? 1));

/**
 * Turn the model's proposal into operations. Times come from the comparable
 * operation it names × its factor; an operation with no comparable keeps the
 * model's own estimate, marked so. Unknown machines are dropped.
 */
export const applyProposal = (
  proposed: ProposedOp[],
  candidates: CandidatePart[],
  machines: string[]
): { ops: QuoteOperation[]; dropped: string[] } => {
  const ops: QuoteOperation[] = [];
  const dropped: string[] = [];
  for (const p of proposed) {
    if (!machines.includes(p.workCenter)) {
      dropped.push(`${p.workCenter} isn't one of the shop's machines`);
      continue;
    }
    const basis = candidates
      .find((c) => c.partNo === p.basisPartNo)
      ?.routing.find((r) => r.seq === p.basisSeq);
    const seq = (ops.length + 1) * 10;
    if (basis) {
      const setupScale = clampScale(p.setupScale);
      const runScale = clampScale(p.runScale);
      ops.push({
        seq,
        work_center: p.workCenter,
        setup_min: round(basis.setup_min * setupScale, 1),
        run_min_per_unit: round(basis.run_min_per_unit * runScale),
        source: "comparable",
        note: `${p.basisPartNo} op ${p.basisSeq} (${basis.setup_min} min + ${basis.run_min_per_unit} min/ea)${
          setupScale !== 1 || runScale !== 1
            ? ` × ${setupScale} setup, × ${runScale} run`
            : ""
        }: ${p.reason}`,
      });
    } else if (p.setupMin !== null && p.runMinPerUnit !== null) {
      ops.push({
        seq,
        work_center: p.workCenter,
        setup_min: round(Math.max(0, p.setupMin), 1),
        run_min_per_unit: round(Math.max(0, p.runMinPerUnit)),
        source: "comparable",
        note: `no similar operation in the shop, Takumo's estimate: ${p.reason}`,
      });
    } else {
      dropped.push(`${p.workCenter}: no times given`);
    }
  }
  return { ops, dropped };
};
