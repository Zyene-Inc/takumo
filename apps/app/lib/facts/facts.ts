import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { track } from "../analytics";
import { normalizeName } from "../quotes/match";
import {
  attributeDef,
  changesModel,
  factLabel,
  formatValue,
  parseValue,
  type SubjectType,
} from "./attributes";
import {
  currentValue,
  type FactSource,
  NUMBER_RETRIES,
  type Result,
  ROUTING_SELECT,
  routingLabel,
  type Subject,
} from "./subjects";

export { approveFact, rejectFact } from "./review";
export type { FactSource } from "./subjects";
export { currentValue, findSubject } from "./subjects";

interface Proposal {
  attribute: string;
  evidence: string | null;
  noteId?: string | null;
  source: FactSource;
  statedBy: string | null;
  subject: Subject;
  value: unknown;
}

type ProposeResult = Result<{
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
      track("fact_proposed", {
        orgId,
        userId: proposal.statedBy,
        properties: { source: proposal.source, attribute: proposal.attribute },
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
