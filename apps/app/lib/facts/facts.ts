import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import {
  matchCustomer,
  matchMaterial,
  matchPart,
  normalizeName,
} from "../quotes/match";
import {
  attributeDef,
  changesModel,
  type FactValue,
  factLabel,
  formatValue,
  parseValue,
  type SubjectType,
} from "./attributes";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type FactSource =
  | "chat"
  | "voice"
  | "note"
  | "floor"
  | "recalibration"
  | "manual";

export interface Subject {
  id: string;
  label: string;
  type: SubjectType;
}

/** How people refer to a subject: a part number and op, a machine's name… */
export interface SubjectRef {
  name?: string | null;
  partNo?: string | null;
  rev?: string | null;
  seq?: number | null;
  /** For an operation named by its machine instead of its number. */
  workCenter?: string | null;
}

const NUMBER_RETRIES = 5;

const routingLabel = (r: {
  part: { partNo: string; rev: string };
  seq: number;
  workCenter: { name: string };
}) => `${r.part.partNo} rev ${r.part.rev} op ${r.seq} (${r.workCenter.name})`;

const ROUTING_SELECT = {
  id: true,
  seq: true,
  setupMin: true,
  runMinPerUnit: true,
  part: { select: { partNo: true, rev: true } },
  workCenter: { select: { name: true } },
} as const;

type Found = Result<{ subject: Subject }>;

const named = (
  type: SubjectType,
  found: { id: string; name: string } | null | undefined,
  error: string
): Found =>
  found
    ? { ok: true, subject: { type, id: found.id, label: found.name } }
    : { ok: false, error };

/** A machine, material or customer by name. */
const findNamed = async (
  orgId: string,
  type: "work_center" | "material" | "customer",
  ref: SubjectRef
): Promise<Found> => {
  const db = forOrg(database, orgId);
  const select = { id: true, name: true };
  if (type === "work_center") {
    const machines = await db.workCenter.findMany({ select });
    const want = normalizeName(ref.name ?? ref.workCenter ?? "");
    return named(
      type,
      machines.find((m) => normalizeName(m.name) === want),
      `No machine "${ref.name ?? ""}". The shop's machines: ${machines.map((m) => m.name).join(", ")}.`
    );
  }
  if (type === "material") {
    const materials = await db.material.findMany({ select });
    return named(
      type,
      matchMaterial(ref.name, materials),
      `No material like "${ref.name ?? ""}". Materials: ${materials.map((m) => m.name).join(", ")}.`
    );
  }
  const customers = await db.customer.findMany({ select });
  return named(
    type,
    matchCustomer(ref.name, customers),
    `No customer "${ref.name ?? ""}".`
  );
};

/** One operation of a part, by its number or the machine it runs on. */
const findOperation = async (
  orgId: string,
  part: { id: string; partNo: string },
  ref: SubjectRef
): Promise<Found> => {
  const ops = await forOrg(database, orgId).routing.findMany({
    where: { partId: part.id },
    orderBy: { seq: "asc" },
    select: ROUTING_SELECT,
  });
  const machine = normalizeName(ref.workCenter ?? "");
  const matches = ops.filter((op) =>
    ref.seq
      ? op.seq === ref.seq
      : machine !== "" && normalizeName(op.workCenter.name) === machine
  );
  if (matches.length !== 1) {
    const list =
      ops.map((op) => `op ${op.seq} on ${op.workCenter.name}`).join(", ") ||
      "It has no routing yet";
    return { ok: false, error: `Which operation of ${part.partNo}? ${list}.` };
  }
  return {
    ok: true,
    subject: {
      type: "routing",
      id: matches[0].id,
      label: routingLabel(matches[0]),
    },
  };
};

/** Find what a fact is about from the words people use. */
export const findSubject = async (
  orgId: string,
  type: SubjectType,
  ref: SubjectRef
): Promise<Found> => {
  if (type === "shop") {
    const org = await database.org.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    return {
      ok: true,
      subject: { type, id: orgId, label: org?.name ?? "The shop" },
    };
  }
  if (type === "work_center" || type === "material" || type === "customer") {
    return findNamed(orgId, type, ref);
  }
  const parts = await forOrg(database, orgId).part.findMany({
    select: { id: true, partNo: true, rev: true },
  });
  const { part, otherRev } = matchPart(ref.partNo ?? ref.name, ref.rev, parts);
  if (!part) {
    return {
      ok: false,
      error: otherRev
        ? `The shop has ${otherRev.partNo} rev ${otherRev.rev}, not rev ${ref.rev}.`
        : `No part "${ref.partNo ?? ref.name ?? ""}".`,
    };
  }
  return type === "part"
    ? {
        ok: true,
        subject: { type, id: part.id, label: `${part.partNo} rev ${part.rev}` },
      }
    : findOperation(orgId, part, ref);
};

const shiftHours = (shifts: unknown) => {
  const hours = Number(
    (shifts as { hoursPerDay?: unknown } | null)?.hoursPerDay
  );
  return Number.isFinite(hours) ? hours : null;
};

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** The value a model parameter has now (null for notes or unknown subjects). */
export const currentValue = async (
  orgId: string,
  type: string,
  id: string,
  attribute: string
): Promise<FactValue | null> => {
  const db = forOrg(database, orgId);
  if (type === "routing") {
    const r = await db.routing.findFirst({
      where: { id },
      select: ROUTING_SELECT,
    });
    if (!r) {
      return null;
    }
    return (
      (
        {
          setupMin: r.setupMin,
          runMinPerUnit: r.runMinPerUnit,
          workCenter: r.workCenter.name,
        } as Record<string, FactValue>
      )[attribute] ?? null
    );
  }
  if (type === "work_center") {
    const w = await db.workCenter.findFirst({ where: { id } });
    if (!w) {
      return null;
    }
    return (
      (
        {
          hourlyRate: num(w.hourlyRate),
          efficiency: w.efficiency,
          hoursPerDay: shiftHours(w.shifts),
        } as Record<string, FactValue | null>
      )[attribute] ?? null
    );
  }
  if (type === "material") {
    const m = await db.material.findFirst({ where: { id } });
    if (!m) {
      return null;
    }
    return (
      (
        { unitCost: num(m.unitCost), leadTimeDays: m.leadTimeDays } as Record<
          string,
          FactValue | null
        >
      )[attribute] ?? null
    );
  }
  if (type === "customer") {
    const c = await db.customer.findFirst({ where: { id } });
    return attribute === "paymentTermDays"
      ? (c?.paymentTermDays ?? null)
      : null;
  }
  return null;
};

export interface Proposal {
  attribute: string;
  evidence: string | null;
  noteId?: string | null;
  source: FactSource;
  statedBy: string | null;
  subject: Subject;
  value: unknown;
}

export type ProposeResult = Result<{
  /** An identical fact was already waiting for review. */
  existing: boolean;
  fact: { id: string; label: string; number: number };
}>;

/**
 * Record a fact as pending. Checks the value, skips a change that wouldn't
 * change anything, and reuses an identical pending fact.
 */
export const proposeFact = async (
  orgId: string,
  proposal: Proposal
): Promise<ProposeResult> => {
  const def = attributeDef(proposal.subject.type, proposal.attribute);
  if (!def) {
    return {
      ok: false,
      error: `A ${proposal.subject.type.replace("_", " ")} fact can't be about "${proposal.attribute}".`,
    };
  }
  const parsed = parseValue(def, proposal.value);
  if (!parsed.ok) {
    return parsed;
  }
  const db = forOrg(database, orgId);
  let value = parsed.value;
  if (def.kind === "machine") {
    const machines = await db.workCenter.findMany({ select: { name: true } });
    const found = machines.find(
      (m) => normalizeName(m.name) === normalizeName(String(value))
    );
    if (!found) {
      return { ok: false, error: `No machine "${value}".` };
    }
    value = found.name;
  }
  const previous = await currentValue(
    orgId,
    proposal.subject.type,
    proposal.subject.id,
    proposal.attribute
  );
  if (changesModel(proposal.attribute) && previous === value) {
    return {
      ok: false,
      error: `${proposal.subject.label} already has ${def.label.toLowerCase()} ${formatValue(def, value)}.`,
    };
  }
  const same = await db.fact.findFirst({
    where: {
      status: "pending",
      subjectType: proposal.subject.type,
      subjectId: proposal.subject.id,
      attribute: proposal.attribute,
      value: { equals: value },
    },
    select: { id: true, number: true },
  });
  if (same) {
    return {
      ok: true,
      existing: true,
      fact: { id: same.id, number: same.number, label: factLabel(same.number) },
    };
  }
  for (let attempt = 0; ; attempt += 1) {
    const last = await db.fact.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    try {
      const fact = await db.fact.create({
        data: {
          orgId,
          number: (last?.number ?? 0) + 1,
          subjectType: proposal.subject.type,
          subjectId: proposal.subject.id,
          subjectLabel: proposal.subject.label,
          attribute: proposal.attribute,
          value,
          previousValue: previous ?? Prisma.DbNull,
          source: proposal.source,
          statedBy: proposal.statedBy,
          evidence: proposal.evidence?.trim().slice(0, 2000) || null,
          noteId: proposal.noteId ?? null,
        },
        select: { id: true, number: true },
      });
      return {
        ok: true,
        existing: false,
        fact: {
          id: fact.id,
          number: fact.number,
          label: factLabel(fact.number),
        },
      };
    } catch (error) {
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!clash || attempt >= NUMBER_RETRIES) {
        throw error;
      }
    }
  }
};

type Tx = Prisma.TransactionClient;

/** Write an approved value to the record it's about. */
const applyValue = async (
  tx: Tx,
  orgId: string,
  fact: { subjectType: string; subjectId: string; attribute: string },
  value: FactValue
) => {
  const { subjectType: type, subjectId: id, attribute } = fact;
  const where = { id, orgId };
  if (type === "routing") {
    if (attribute === "workCenter") {
      const machine = await tx.workCenter.findFirst({
        where: { orgId, name: String(value) },
        select: { id: true },
      });
      if (!machine) {
        throw new Error(`No machine "${value}".`);
      }
      await tx.routing.updateMany({
        where,
        data: { workCenterId: machine.id, provenance: "stated", confidence: 1 },
      });
      return;
    }
    await tx.routing.updateMany({
      where,
      data: { [attribute]: Number(value), provenance: "stated", confidence: 1 },
    });
    return;
  }
  if (type === "work_center") {
    if (attribute === "hoursPerDay") {
      const wc = await tx.workCenter.findFirst({
        where,
        select: { shifts: true },
      });
      const shifts = (wc?.shifts as Record<string, unknown> | null) ?? {};
      await tx.workCenter.updateMany({
        where,
        data: {
          shifts: { ...shifts, hoursPerDay: Number(value) },
          provenance: "stated",
        },
      });
      return;
    }
    await tx.workCenter.updateMany({
      where,
      data: { [attribute]: Number(value), provenance: "stated" },
    });
    return;
  }
  if (type === "material") {
    await tx.material.updateMany({
      where,
      data: { [attribute]: Number(value), provenance: "stated" },
    });
    return;
  }
  if (type === "customer" && attribute === "paymentTermDays") {
    await tx.customer.updateMany({
      where,
      data: { paymentTermDays: Number(value) },
    });
  }
};

/**
 * Approve a pending fact (optionally with a corrected value). A model
 * parameter is written to its record; the fact it replaces is kept as
 * superseded, so the history stays.
 */
export const approveFact = async (
  orgId: string,
  factId: string,
  reviewer: string,
  options: { value?: unknown; note?: string | null } = {}
): Promise<Result<{ label: string }>> => {
  const db = forOrg(database, orgId);
  const fact = await db.fact.findFirst({ where: { id: factId } });
  if (!fact) {
    return { ok: false, error: "That fact no longer exists." };
  }
  if (fact.status !== "pending") {
    return {
      ok: false,
      error: `${factLabel(fact.number)} is already ${fact.status}.`,
    };
  }
  const def = attributeDef(fact.subjectType, fact.attribute);
  if (!def) {
    return { ok: false, error: "This fact's attribute isn't supported." };
  }
  let value = fact.value as FactValue;
  if (options.value !== undefined) {
    const parsed = parseValue(def, options.value);
    if (!parsed.ok) {
      return parsed;
    }
    value = parsed.value;
  }
  const previous = await currentValue(
    orgId,
    fact.subjectType,
    fact.subjectId,
    fact.attribute
  );
  const now = new Date();
  try {
    await database.$transaction(async (tx) => {
      const replaced = await tx.fact.findMany({
        where: {
          orgId,
          status: "approved",
          subjectType: fact.subjectType,
          subjectId: fact.subjectId,
          attribute: fact.attribute,
          validTo: null,
        },
        orderBy: { validFrom: "desc" },
        select: { id: true },
      });
      // A note adds to what's known; a parameter replaces the old value.
      if (changesModel(fact.attribute)) {
        await applyValue(tx, orgId, fact, value);
        if (replaced.length) {
          await tx.fact.updateMany({
            where: { id: { in: replaced.map((r) => r.id) } },
            data: { status: "superseded", validTo: now },
          });
        }
      }
      await tx.fact.update({
        where: { id: fact.id },
        data: {
          status: "approved",
          value,
          previousValue: previous ?? Prisma.DbNull,
          supersedesFactId: changesModel(fact.attribute)
            ? (replaced[0]?.id ?? null)
            : null,
          reviewedBy: reviewer,
          reviewedAt: now,
          reviewNote: options.note?.trim() || null,
          validFrom: now,
        },
      });
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't apply the fact.",
    };
  }
  return { ok: true, label: factLabel(fact.number) };
};

export const rejectFact = async (
  orgId: string,
  factId: string,
  reviewer: string,
  note: string | null
): Promise<Result<{ label: string }>> => {
  const db = forOrg(database, orgId);
  const fact = await db.fact.findFirst({ where: { id: factId } });
  if (!fact) {
    return { ok: false, error: "That fact no longer exists." };
  }
  if (fact.status !== "pending") {
    return {
      ok: false,
      error: `${factLabel(fact.number)} is already ${fact.status}.`,
    };
  }
  await db.fact.updateMany({
    where: { id: fact.id },
    data: {
      status: "rejected",
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    },
  });
  return { ok: true, label: factLabel(fact.number) };
};

/** Facts about one record, newest first (for get_record and record pages). */
export const factsAbout = (orgId: string, type: SubjectType, ids: string[]) =>
  forOrg(database, orgId).fact.findMany({
    where: {
      subjectType: type,
      subjectId: { in: ids },
      status: { in: ["approved", "pending"] },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      number: true,
      subjectLabel: true,
      attribute: true,
      value: true,
      previousValue: true,
      status: true,
      source: true,
      evidence: true,
      createdAt: true,
      reviewedAt: true,
    },
  });

/** Every subject a fact can be about, for pickers. */
export const subjectOptions = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [routings, machines, parts, materials, customers, org] =
    await Promise.all([
      db.routing.findMany({
        orderBy: [{ part: { partNo: "asc" } }, { seq: "asc" }],
        select: ROUTING_SELECT,
      }),
      db.workCenter.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      db.part.findMany({
        orderBy: [{ partNo: "asc" }, { rev: "asc" }],
        select: { id: true, partNo: true, rev: true },
      }),
      db.material.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      db.customer.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
    ]);
  const options: Record<SubjectType, { id: string; label: string }[]> = {
    routing: routings.map((r) => ({ id: r.id, label: routingLabel(r) })),
    work_center: machines.map((m) => ({ id: m.id, label: m.name })),
    part: parts.map((p) => ({ id: p.id, label: `${p.partNo} rev ${p.rev}` })),
    material: materials.map((m) => ({ id: m.id, label: m.name })),
    customer: customers.map((c) => ({ id: c.id, label: c.name })),
    shop: [{ id: orgId, label: org?.name ?? "The shop" }],
  };
  return options;
};

export const subjectById = async (
  orgId: string,
  type: SubjectType,
  id: string
): Promise<Subject | null> => {
  const options = await subjectOptions(orgId);
  const found = options[type]?.find((o) => o.id === id);
  return found ? { type, id, label: found.label } : null;
};
