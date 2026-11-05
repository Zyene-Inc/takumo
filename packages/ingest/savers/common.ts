// Shared helpers for saving imported rows: context, value readers, batching, lookups.

import "server-only";

import type { PrismaClient } from "@repo/database";
import type { Value } from "../transform";

export interface SaveResult {
  readonly created: number;
  // Things the user should know, e.g. machines we had to create from a routing.
  readonly notes: string[];
  readonly skipped: number;
  readonly updated: number;
}

export interface Context {
  readonly db: PrismaClient;
  readonly notes: string[];
  readonly orgId: string;
  // "data" for file imports, "stated" for values a person typed in.
  readonly provenance: "data" | "stated";
  readonly sourceId: string | null;
  // Set when the rows come from the shop's ERP: the records become read-only.
  readonly syncedAt: Date | null;
}

/** The ERP-sync stamp for a record's data, when the rows came from the ERP. */
export const synced = (ctx: Context) =>
  ctx.syncedAt ? { syncedAt: ctx.syncedAt } : {};

export type Values = Readonly<Record<string, Value>>;

export const str = (v: Value | undefined) => (typeof v === "string" ? v : null);

export const num = (v: Value | undefined) => (typeof v === "number" ? v : null);

export const list = (v: Value | undefined) => (Array.isArray(v) ? v : []);

// Only fields that were mapped and had a value overwrite existing data, so a
// partial re-upload never blanks out what the shop entered before.
export const defined = <T extends Record<string, unknown>>(data: T) =>
  Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== null && v !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], null> };

export const BATCH = 25;

// The highest efficiency written as a fraction (the engine allows up to 1.5).
export const MAX_EFFICIENCY = 1.5;

export const inBatches = async <T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>
) => {
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(fn));
  }
};

export const listNote = (what: string, names: Set<string>) => {
  if (names.size === 0) {
    return null;
  }
  const shown = [...names].slice(0, 5).join(", ");
  const more = names.size > 5 ? ` and ${names.size - 5} more` : "";
  return `${what}: ${shown}${more}`;
};

type LookupKind = "customer" | "material" | "workCenter";

/** Every row of a named kind, as id and name. */
const namedRows = (ctx: Context, kind: LookupKind) => {
  const args = {
    where: { orgId: ctx.orgId },
    select: { id: true, name: true },
  };
  if (kind === "customer") {
    return ctx.db.customer.findMany(args);
  }
  if (kind === "material") {
    return ctx.db.material.findMany(args);
  }
  return ctx.db.workCenter.findMany(args);
};

/** The row with this name, created when missing (materials and machines as assumed). */
const ensureNamed = (ctx: Context, kind: LookupKind, name: string) => {
  const { db, orgId } = ctx;
  const where = { orgId_name: { orgId, name } };
  if (kind === "customer") {
    return db.customer.upsert({
      where,
      create: { orgId, name },
      update: {},
    });
  }
  if (kind === "material") {
    return db.material.upsert({
      where,
      create: { orgId, name, provenance: "assumed" },
      update: {},
    });
  }
  return db.workCenter.upsert({
    where,
    create: { orgId, name, provenance: "assumed", sourceId: ctx.sourceId },
    update: {},
  });
};

// Name → id lookups that create missing rows on first use.
export const lookup = async (ctx: Context, kind: LookupKind) => {
  const rows = await namedRows(ctx, kind);
  const ids = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const created = new Set<string>();

  const get = async (name: string | null) => {
    if (!name) {
      return null;
    }
    const key = name.toLowerCase();
    const existing = ids.get(key);
    if (existing) {
      return existing;
    }
    const row = await ensureNamed(ctx, kind, name);
    ids.set(key, row.id);
    created.add(name);
    return row.id;
  };

  return { get, created };
};

// Part numbers referenced by orders, quotes and routings. Without a
// revision it matches any revision (the latest one wins); a new part number
// is created as rev A, or as the revision given.
export const partLookup = async (ctx: Context) => {
  const { db, orgId } = ctx;
  const rows = await db.part.findMany({
    where: { orgId },
    select: { id: true, partNo: true, rev: true },
    orderBy: { rev: "asc" },
  });
  const byNo = new Map(rows.map((r) => [r.partNo.toLowerCase(), r.id]));
  const byNoRev = new Map(
    rows.map((r) => [`${r.partNo.toLowerCase()}|${r.rev.toLowerCase()}`, r.id])
  );
  const created = new Set<string>();

  const get = async (partNo: string, rev?: string | null) => {
    const key = partNo.toLowerCase();
    const existing = rev
      ? byNoRev.get(`${key}|${rev.toLowerCase()}`)
      : byNo.get(key);
    if (existing) {
      return existing;
    }
    const newRev = rev ?? "A";
    const row = await db.part.upsert({
      where: { orgId_partNo_rev: { orgId, partNo, rev: newRev } },
      create: { orgId, partNo, rev: newRev },
      update: {},
    });
    byNo.set(key, row.id);
    byNoRev.set(`${key}|${newRev.toLowerCase()}`, row.id);
    created.add(rev ? `${partNo} rev ${rev}` : partNo);
    return row.id;
  };

  return { get, created };
};

export interface Counter {
  created: number;
  skipped: number;
  updated: number;
}

export const count = (counter: Counter, existed: boolean) => {
  if (existed) {
    counter.updated += 1;
  } else {
    counter.created += 1;
  }
};

/** "yes"/"no" from an enum cell; undefined when the column isn't mapped. */
export const yesNo = (value: Value | undefined) =>
  value === undefined ? undefined : str(value) === "yes";

/** A number above zero, else null (left unset). */
export const positive = (n: number | null) => (n !== null && n > 0 ? n : null);
