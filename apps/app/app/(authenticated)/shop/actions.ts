"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg, Prisma } from "@repo/database";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  parseRows,
} from "@repo/ingest";
import { saveRecords } from "@repo/ingest/save";
import { revalidatePath } from "next/cache";

export interface SaveRecordResult {
  readonly errors: string[];
  readonly ok: boolean;
}

const requireOrg = async () => {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error("Choose a shop first.");
  }
  return orgId;
};

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
            part: { partNo: v.partNo, ...(v.rev ? { rev: v.rev } : {}) },
          },
        })) > 0
      );
    case "orders":
      return (await db.order.count({ where: { orderNo: v.orderNo } })) > 0;
    default:
      return false;
  }
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
  const orgId = await requireOrg();
  if (!(entity in ENTITIES)) {
    return { ok: false, errors: ["Unknown record type."] };
  }
  const { records, errors } = parseRows([values], formMapping(entity));
  if (records.length === 0 || errors.length > 0) {
    return {
      ok: false,
      errors: errors.map((e) => `${e.field}: ${e.message}`),
    };
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
};

export const deleteRecord = async (
  entity: "workCenters" | "parts" | "routings" | "orders",
  id: string
): Promise<SaveRecordResult> => {
  const orgId = await requireOrg();
  const db = forOrg(database, orgId);
  try {
    // deleteMany is scoped to the org by forOrg; delete() by id would not be.
    const where = { where: { id } };
    const { count } =
      entity === "workCenters"
        ? await db.workCenter.deleteMany(where)
        : entity === "parts"
          ? await db.part.deleteMany(where)
          : entity === "routings"
            ? await db.routing.deleteMany(where)
            : await db.order.deleteMany(where);
    if (count === 0) {
      return { ok: false, errors: ["Not found."] };
    }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return {
        ok: false,
        errors: [IN_USE[entity] ?? "This record is in use."],
      };
    }
    throw error;
  }
  revalidatePath("/", "layout");
  return { ok: true, errors: [] };
};
