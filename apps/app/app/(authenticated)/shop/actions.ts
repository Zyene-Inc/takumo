"use server";

import { database, forOrg, Prisma } from "@repo/database";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  parseRows,
} from "@repo/ingest";
import { saveRecords } from "@repo/ingest/save";
import { revalidatePath } from "next/cache";
import { authorize, permissionFor } from "@/lib/access";
import { erpFeeds, fedByErp } from "@/lib/erp/feeds";

export interface SaveRecordResult {
  readonly errors: string[];
  readonly ok: boolean;
}

// The edit forms use field keys as column names, and times in minutes.
const formMapping = (entity: EntityKey): ColumnMapping => {
  const fields = ENTITIES[entity].fields;
  return {
    entity,
    columns: Object.fromEntries(fields.map((f) => [f.key, f.key])),
    confidence: Object.fromEntries(fields.map((f) => [f.key, 1])),
    timeUnits: Object.fromEntries(
      fields.filter((f) => f.kind === "minutes").map((f) => [f.key, "minutes"])
    ),
    source: "heuristic",
  };
};

const exists = async (
  orgId: string,
  entity: EntityKey,
  v: Record<string, string>
) => {
  const db = forOrg(database, orgId);
  switch (entity) {
    case "workCenters":
      return (await db.workCenter.count({ where: { name: v.name } })) > 0;
    case "customers":
      return (await db.customer.count({ where: { name: v.name } })) > 0;
    case "materials":
      return (await db.material.count({ where: { name: v.name } })) > 0;
    case "parts":
      return (
        (await db.part.count({
          where: { partNo: v.partNo, rev: v.rev || "A" },
        })) > 0
      );
    case "routings":
      return (
        (await db.routing.count({
          where: {
            seq: Number(v.seq),
            // The same default rev the save uses, so an edit without a rev
            // can't match another revision's operation and slip past.
            part: { partNo: v.partNo, rev: v.rev || "A" },
          },
        })) > 0
      );
    case "orders":
      return (await db.order.count({ where: { orderNo: v.orderNo } })) > 0;
    case "quotes":
      return (await db.quote.count({ where: { quoteNo: v.quoteNo } })) > 0;
    default:
      return false;
  }
};

const ERP_OWNED =
  "This comes from your ERP, which keeps it up to date. Change it in your ERP; the next report brings the change here.";

/** When a record the form would change was last synced from the ERP. */
const syncedByIdentity = async (
  orgId: string,
  entity: EntityKey,
  v: Record<string, string>
) => {
  const db = forOrg(database, orgId);
  const select = { syncedAt: true } as const;
  switch (entity) {
    case "workCenters":
      return (
        await db.workCenter.findFirst({ where: { name: v.name }, select })
      )?.syncedAt;
    case "customers":
      return (await db.customer.findFirst({ where: { name: v.name }, select }))
        ?.syncedAt;
    case "materials":
      return (await db.material.findFirst({ where: { name: v.name }, select }))
        ?.syncedAt;
    case "parts":
      return (
        await db.part.findFirst({
          where: { partNo: v.partNo, rev: v.rev || "A" },
          select,
        })
      )?.syncedAt;
    case "routings":
      return (
        await db.routing.findFirst({
          where: {
            seq: Number(v.seq),
            part: { partNo: v.partNo, ...(v.rev ? { rev: v.rev } : {}) },
          },
          select,
        })
      )?.syncedAt;
    case "orders":
      return (
        await db.order.findFirst({ where: { orderNo: v.orderNo }, select })
      )?.syncedAt;
    default:
      return null;
  }
};

const syncedById = async (orgId: string, entity: EntityKey, id: string) => {
  const db = forOrg(database, orgId);
  const where = { id };
  const select = { syncedAt: true } as const;
  switch (entity) {
    case "workCenters":
      return (await db.workCenter.findFirst({ where, select }))?.syncedAt;
    case "customers":
      return (await db.customer.findFirst({ where, select }))?.syncedAt;
    case "materials":
      return (await db.material.findFirst({ where, select }))?.syncedAt;
    case "parts":
      return (await db.part.findFirst({ where, select }))?.syncedAt;
    case "routings":
      return (await db.routing.findFirst({ where, select }))?.syncedAt;
    case "orders":
      return (await db.order.findFirst({ where, select }))?.syncedAt;
    default:
      return null;
  }
};

const ERP_CREATES =
  "Your ERP sends these: add it in your ERP, and it shows up here after the next report.";

/**
 * Whether a new record of this kind is the ERP's to make: the ERP sends this
 * kind of data, or (an operation) the part's routing came from the ERP.
 */
const erpCreates = async (
  orgId: string,
  entity: EntityKey,
  v: Record<string, string>
) => {
  if (fedByErp(await erpFeeds(orgId), entity)) {
    return true;
  }
  if (entity !== "routings") {
    return false;
  }
  const synced = await forOrg(database, orgId).routing.findFirst({
    where: {
      syncedAt: { not: null },
      part: { partNo: v.partNo, rev: v.rev || "A" },
    },
    select: { id: true },
  });
  return synced !== null;
};

/**
 * Saves one record typed in by a person. Goes through the same parsing and
 * upsert code as file imports, marked as "stated" rather than "data".
 */
export const saveRecord = async (
  entity: EntityKey,
  values: Record<string, string>,
  mode: "create" | "update"
): Promise<SaveRecordResult> => {
  if (!(entity in ENTITIES)) {
    return { ok: false, errors: ["Unknown record type."] };
  }
  const access = await authorize(permissionFor(entity));
  if (!access.ok) {
    return { ok: false, errors: [access.error] };
  }
  const { orgId } = access;
  const { records, errors } = parseRows([values], formMapping(entity));
  if (records.length === 0 || errors.length > 0) {
    return {
      ok: false,
      errors: errors.map((e) => `${e.field}: ${e.message}`),
    };
  }
  // The ERP owns what it sends (docs/PRODUCT-PLAN.md F1.4).
  if (mode === "update" && (await syncedByIdentity(orgId, entity, values))) {
    return { ok: false, errors: [ERP_OWNED] };
  }
  if (mode === "create" && (await erpCreates(orgId, entity, values))) {
    return { ok: false, errors: [ERP_CREATES] };
  }
  if (mode === "create" && (await exists(orgId, entity, values))) {
    return {
      ok: false,
      errors: ["That already exists. Edit it from the list instead."],
    };
  }
  await saveRecords(database, orgId, entity, records, { provenance: "stated" });
  revalidatePath("/", "layout");
  return { ok: true, errors: [] };
};

const IN_USE: Partial<Record<EntityKey, string>> = {
  workCenters:
    "This machine is used in routings. Move those operations to another machine first.",
  parts: "This part has orders or quotes. Delete or change those first.",
  customers:
    "This customer has parts, orders or quotes. Change or delete those first.",
  materials: "Parts use this material. Change those parts first.",
};

// deleteMany is scoped to the org by forOrg; delete() by id would not be.
const deleteById = (
  db: ReturnType<typeof forOrg>,
  entity: EntityKey,
  id: string
) => {
  const where = { where: { id } };
  switch (entity) {
    case "workCenters":
      return db.workCenter.deleteMany(where);
    case "customers":
      return db.customer.deleteMany(where);
    case "materials":
      return db.material.deleteMany(where);
    case "parts":
      return db.part.deleteMany(where);
    case "routings":
      return db.routing.deleteMany(where);
    case "orders":
      return db.order.deleteMany(where);
    case "quotes":
      return db.quote.deleteMany(where);
    default:
      throw new Error("Unknown record type.");
  }
};

export const deleteRecord = async (
  entity: EntityKey,
  id: string
): Promise<SaveRecordResult> => {
  if (!(entity in ENTITIES)) {
    return { ok: false, errors: ["Unknown record type."] };
  }
  const access = await authorize(permissionFor(entity));
  if (!access.ok) {
    return { ok: false, errors: [access.error] };
  }
  const { orgId } = access;
  if (await syncedById(orgId, entity, id)) {
    return { ok: false, errors: [ERP_OWNED] };
  }
  try {
    const { count } = await deleteById(forOrg(database, orgId), entity, id);
    if (count === 0) {
      return { ok: false, errors: ["Not found."] };
    }
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003"
    ) {
      return {
        ok: false,
        errors: [IN_USE[entity] ?? "This record is in use."],
      };
    }
    throw e;
  }
  revalidatePath("/", "layout");
  return { ok: true, errors: [] };
};
