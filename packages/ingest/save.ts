import "server-only";

import type { PrismaClient } from "@repo/database";
import type { EntityKey } from "./entities";
import { saveParts, saveRoutings } from "./savers/catalog";
import type { Context, Counter, SaveResult, Values } from "./savers/common";
import { saveCustomers, saveMaterials, saveWorkCenters } from "./savers/named";
import { saveOperations } from "./savers/operations";
import { saveOperators } from "./savers/operators";
import { saveJobs, saveOrders, saveQuotes } from "./savers/orders";
import { savePurchaseOrders, saveStock } from "./savers/stock";
import type { ParsedRecord } from "./transform";

export { planNamed } from "./savers/named";

const SAVERS: Record<
  EntityKey,
  (ctx: Context, records: ParsedRecord[], c: Counter) => Promise<void>
> = {
  workCenters: saveWorkCenters,
  customers: saveCustomers,
  materials: saveMaterials,
  parts: saveParts,
  routings: saveRoutings,
  orders: saveOrders,
  quotes: saveQuotes,
  jobs: saveJobs,
  stock: saveStock,
  purchaseOrders: savePurchaseOrders,
  operators: saveOperators,
  operations: saveOperations,
};

// The ERP id when there is one, else the name.
const named = (v: Values) =>
  v.erpId
    ? `id:${String(v.erpId).toLowerCase()}`
    : `name:${String(v.name).toLowerCase()}`;

// Keeps the last row when a file lists the same record twice.
const dedupe = (entity: EntityKey, records: readonly ParsedRecord[]) => {
  const keyOf: Record<EntityKey, (v: Values) => string> = {
    workCenters: named,
    customers: named,
    materials: named,
    parts: (v) => `${v.partNo}|${v.rev ?? "A"}`,
    routings: (v) =>
      `${String(v.partNo).toLowerCase()}|${String(v.rev ?? "").toLowerCase()}|${v.seq}`,
    orders: (v) => String(v.orderNo),
    quotes: (v) => String(v.quoteNo),
    jobs: (v) => `${v.orderNo}|${v.seq}`,
    stock: (v) =>
      `${String(v.material).toLowerCase()}|${String(v.location ?? "").toLowerCase()}`,
    purchaseOrders: (v) => `${v.poNo}|${v.lineNo ?? 1}`,
    // The employee id when there is one: two people can share a name.
    operators: (v) =>
      v.employeeId
        ? `id:${String(v.employeeId).toLowerCase()}`
        : `name:${String(v.name).toLowerCase()}`,
    operations: (v) => `${v.orderNo}|${v.seq}`,
  };
  const byKey = new Map<string, ParsedRecord>();
  for (const record of records) {
    byKey.set(keyOf[entity](record.values), record);
  }
  return {
    unique: [...byKey.values()],
    duplicates: records.length - byKey.size,
  };
};

/**
 * Writes parsed records for one org. Re-importing the same file updates rows
 * in place (matched by name, part number + revision, order number…).
 */
export const saveRecords = async (
  db: PrismaClient,
  orgId: string,
  entity: EntityKey,
  records: readonly ParsedRecord[],
  {
    sourceId = null,
    provenance = "data",
    syncedAt = null,
  }: {
    sourceId?: string | null;
    provenance?: "data" | "stated";
    /** The rows come from the shop's ERP (stamped on each record). */
    syncedAt?: Date | null;
  } = {}
): Promise<SaveResult> => {
  const ctx: Context = { db, orgId, sourceId, provenance, syncedAt, notes: [] };
  const counter: Counter = { created: 0, updated: 0, skipped: 0 };
  const { unique, duplicates } = dedupe(entity, records);
  if (duplicates > 0) {
    ctx.notes.push(
      `${duplicates} duplicate row${duplicates === 1 ? "" : "s"} in the file: the last one was used`
    );
  }
  await SAVERS[entity](ctx, unique, counter);
  return {
    ...counter,
    skipped: counter.skipped + duplicates,
    notes: ctx.notes,
  };
};
