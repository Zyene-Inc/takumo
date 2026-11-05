// Machines, customers and materials: matched by ERP id, else by name.

import "server-only";

import type { PrismaClient } from "@repo/database";
import { companyDomains, emailsIn } from "../contacts";
import type { ParsedRecord } from "../transform";
import {
  type Context,
  type Counter,
  count,
  defined,
  inBatches,
  listNote,
  MAX_EFFICIENCY,
  num,
  positive,
  str,
  synced,
  type Values,
  yesNo,
} from "./common";

// Machines, customers and materials are named records. A row is matched by
// the ERP's id when it has one, so a rename in the ERP renames the record
// here instead of adding a second one; else by name (any case).
export type NamedKind = "workCenter" | "customer" | "material";

export interface NamedRow {
  externalId: string | null;
  id: string;
  name: string;
}

// The Prisma calls the three models share, typed loosely so one function
// serves all three.
export interface NamedDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: {
    where: { orgId: string };
    select: Record<string, true>;
  }): Promise<(NamedRow & Record<string, unknown>)[]>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<unknown>;
}

export const delegate = (db: PrismaClient, kind: NamedKind) =>
  db[kind] as unknown as NamedDelegate;

/** What to do with each row: create it, or update a record (maybe renamed). */
export const planNamed = (
  existing: readonly NamedRow[],
  rows: readonly { externalId: string | null; name: string }[]
) => {
  const index = new NamedIndex(existing);
  const plans = rows.map(
    ({ name, externalId }) =>
      index.planKnown(name, externalId) ??
      index.planByName(name, externalId) ??
      index.planNew(name, externalId)
  );
  return { plans, renamed: index.renamed, clashes: index.clashes };
};

interface NamedPlan {
  data: Record<string, string>;
  id: string | null;
}

/** The records so far, by ERP id and by name, updated as rows are planned. */
class NamedIndex {
  readonly byExternal = new Map<string, NamedRow>();
  readonly byName = new Map<string, NamedRow>();
  readonly renamed: string[] = [];
  readonly clashes: string[] = [];

  constructor(existing: readonly NamedRow[]) {
    for (const r of existing) {
      if (r.externalId) {
        this.byExternal.set(r.externalId, r);
      }
      this.byName.set(r.name.toLowerCase(), r);
    }
  }

  /** A row whose ERP id is known: the same record, renamed when its name changed. */
  planKnown(name: string, externalId: string | null): NamedPlan | null {
    const known = externalId ? this.byExternal.get(externalId) : undefined;
    if (!known) {
      return null;
    }
    if (known.name === name) {
      return { id: known.id, data: {} };
    }
    const other = this.byName.get(name.toLowerCase());
    if (other && other.id !== known.id) {
      // Another record already has the new name: keep both as they are.
      this.clashes.push(`${known.name} → ${name}`);
      return { id: known.id, data: {} };
    }
    this.renamed.push(`${known.name} → ${name}`);
    this.byName.delete(known.name.toLowerCase());
    const moved = { ...known, name };
    this.byName.set(name.toLowerCase(), moved);
    this.byExternal.set(known.externalId as string, moved);
    return { id: known.id, data: { name } };
  }

  /** A row matched by name; learns the ERP id the first time a report gives one. */
  planByName(name: string, externalId: string | null): NamedPlan | null {
    const named = this.byName.get(name.toLowerCase());
    if (!named) {
      return null;
    }
    const learn =
      externalId && !named.externalId && !this.byExternal.has(externalId);
    if (!learn) {
      return { id: named.id, data: {} };
    }
    const withId = { ...named, externalId };
    this.byExternal.set(externalId, withId);
    this.byName.set(name.toLowerCase(), withId);
    return { id: named.id, data: { externalId } };
  }

  /** A new record, with its ERP id unless another record already has it. */
  planNew(name: string, externalId: string | null): NamedPlan {
    const fresh = {
      id: "",
      name,
      externalId:
        externalId && !this.byExternal.has(externalId) ? externalId : null,
    };
    this.byName.set(name.toLowerCase(), fresh);
    if (fresh.externalId) {
      this.byExternal.set(fresh.externalId, fresh);
    }
    return {
      id: null,
      data: {
        name,
        ...(fresh.externalId ? { externalId: fresh.externalId } : {}),
      },
    };
  }
}

const NAMED_LABEL: Record<NamedKind, string> = {
  workCenter: "Machines",
  customer: "Customers",
  material: "Materials",
};

export const saveNamed = async (
  ctx: Context,
  kind: NamedKind,
  records: ParsedRecord[],
  c: Counter,
  fields: (
    v: Values,
    current: Record<string, unknown> | undefined
  ) => Record<string, unknown>,
  extraSelect: Record<string, true> = {}
) => {
  const { db, orgId } = ctx;
  const model = delegate(db, kind);
  const existing = await model.findMany({
    where: { orgId },
    select: { id: true, name: true, externalId: true, ...extraSelect },
  });
  const byId = new Map(existing.map((r) => [r.id, r]));
  const { plans, renamed, clashes } = planNamed(
    existing,
    records.map(({ values: v }) => ({
      name: str(v.name) as string,
      externalId: str(v.erpId),
    }))
  );
  const writes = records.map((record, i) => ({
    v: record.values,
    plan: plans[i] as (typeof plans)[number],
  }));
  // Renames first, one at a time, so a name that moves frees up before
  // another row takes it.
  const renames = writes.filter((w) => w.plan.id && "name" in w.plan.data);
  const rest = writes.filter((w) => !renames.includes(w));
  const write = async ({ v, plan }: (typeof writes)[number]) => {
    const current = plan.id ? byId.get(plan.id) : undefined;
    const data = { ...fields(v, current), ...synced(ctx) };
    if (plan.id) {
      await model.update({
        where: { id: plan.id },
        data: { ...data, ...plan.data },
      });
    } else {
      await model.create({ data: { orgId, ...data, ...plan.data } });
    }
    count(c, Boolean(plan.id));
  };
  for (const w of renames) {
    await write(w);
  }
  await inBatches(rest, write);
  const label = NAMED_LABEL[kind];
  const notes = [
    listNote(`${label} renamed in your ERP (updated here)`, new Set(renamed)),
    listNote(
      `${label} renamed in your ERP to a name another one already has (left as they were; merge or rename one)`,
      new Set(clashes)
    ),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

export const saveWorkCenters = (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) =>
  saveNamed(
    ctx,
    "workCenter",
    records,
    c,
    (v, current) => {
      let efficiency = num(v.efficiency);
      // "90" means 90%; 1.2 is already a fraction (120%, a fast machine).
      if (efficiency !== null && efficiency > MAX_EFFICIENCY) {
        efficiency /= 100;
      }
      const hoursPerDay = num(v.hoursPerDay);
      const shifts = (current?.shifts as Record<string, unknown> | null) ?? {};
      return {
        ...defined({
          type: str(v.type),
          hourlyRate: num(v.hourlyRate),
          efficiency,
          operatorsPerMachine: positive(num(v.operatorsPerMachine)),
          unattendedRuns: yesNo(v.unattendedRuns),
          // Keep the working days already set; only the hours come from the file.
          shifts: hoursPerDay === null ? null : { ...shifts, hoursPerDay },
        }),
        provenance: ctx.provenance,
        ...(current ? {} : { sourceId: ctx.sourceId }),
      };
    },
    { shifts: true }
  );

export const saveCustomers = (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) =>
  saveNamed(ctx, "customer", records, c, (v) => {
    const emails = emailsIn(str(v.emails));
    const domains = companyDomains(emails, str(v.website));
    return defined({
      paymentTermDays: num(v.paymentTermDays),
      // Only when the report has them: an empty cell never clears them.
      emails: emails.length ? emails : undefined,
      domains: domains.length ? domains : undefined,
    });
  });

export const saveMaterials = (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) =>
  saveNamed(ctx, "material", records, c, (v) => ({
    ...defined({
      spec: str(v.spec),
      unitCost: num(v.unitCost),
      unit: str(v.unit),
      leadTimeDays: num(v.leadTimeDays),
    }),
    provenance: ctx.provenance,
  }));
