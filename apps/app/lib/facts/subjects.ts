// What a fact is about (a machine, part, operation, material…) and its current value.

import "server-only";

import { database, forOrg } from "@repo/database";
import {
  matchCustomer,
  matchMaterial,
  matchPart,
  normalizeName,
} from "../quotes/match";
import type { FactValue, SubjectType } from "./attributes";

export type Result<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type FactSource =
  | "chat"
  | "voice"
  | "note"
  | "floor"
  | "recalibration"
  | "document"
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

export const NUMBER_RETRIES = 5;

export const routingLabel = (r: {
  part: { partNo: string; rev: string };
  seq: number;
  workCenter: { name: string };
}) => `${r.part.partNo} rev ${r.part.rev} op ${r.seq} (${r.workCenter.name})`;

export const ROUTING_SELECT = {
  id: true,
  seq: true,
  setupMin: true,
  runMinPerUnit: true,
  part: { select: { partNo: true, rev: true } },
  workCenter: { select: { name: true } },
} as const;

export type Found = Result<{ subject: Subject }>;

export const named = (
  type: SubjectType,
  found: { id: string; name: string } | null | undefined,
  error: string
): Found =>
  found
    ? { ok: true, subject: { type, id: found.id, label: found.name } }
    : { ok: false, error };

/** A machine, material or customer by name. */
export const findNamed = async (
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
export const findOperation = async (
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

export const shiftHours = (shifts: unknown) => {
  const hours = Number(
    (shifts as { hoursPerDay?: unknown } | null)?.hoursPerDay
  );
  return Number.isFinite(hours) ? hours : null;
};

export const num = (value: { toString(): string } | null) =>
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
