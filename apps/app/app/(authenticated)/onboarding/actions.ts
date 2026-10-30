"use server";

import { database, forOrg } from "@repo/database";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  missingRequired,
  parseRows,
  type RowError,
  type SheetRow,
} from "@repo/ingest";
import { suggestMappingWithAi } from "@repo/ingest/ai-mapping";
import { saveRecords } from "@repo/ingest/save";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { authorize, permissionFor } from "@/lib/access";

// Enough for real shops; bigger files should be split by year or status.
const MAX_ROWS = 20_000;

export const suggestColumns = async (input: {
  fileName: string;
  sheetName?: string;
  headers: string[];
  sampleRows: SheetRow[];
  entity?: EntityKey;
}): Promise<ColumnMapping> => {
  // Without a chosen sheet type, any upload permission is enough to look.
  const access = input.entity
    ? await authorize(permissionFor(input.entity))
    : await authorize("shop:write").then((a) =>
        a.ok ? a : authorize("quotes:write")
      );
  if (!access.ok) {
    throw new Error(access.error);
  }
  return suggestMappingWithAi({
    fileName: input.fileName,
    sheetName: input.sheetName,
    headers: input.headers,
    rows: input.sampleRows,
    entity: input.entity,
  });
};

export interface ImportResult {
  readonly created: number;
  readonly errors: RowError[];
  readonly message?: string;
  readonly notes: string[];
  readonly ok: boolean;
  readonly skipped: number;
  readonly updated: number;
}

const failed = (message: string): ImportResult => ({
  ok: false,
  message,
  created: 0,
  updated: 0,
  skipped: 0,
  notes: [],
  errors: [],
});

export const importSheet = async (input: {
  fileName: string;
  sheetName?: string;
  mapping: ColumnMapping;
  rows: SheetRow[];
  firstRow?: number;
}): Promise<ImportResult> => {
  const { mapping } = input;
  if (!(mapping.entity in ENTITIES)) {
    return failed("Unknown data type.");
  }
  const access = await authorize(permissionFor(mapping.entity));
  if (!access.ok) {
    return failed(access.error);
  }
  const { orgId } = access;
  const missing = missingRequired(mapping);
  if (missing.length > 0) {
    return failed(`Choose a column for: ${missing.join(", ")}.`);
  }
  if (input.rows.length > MAX_ROWS) {
    return failed(
      `This sheet has ${input.rows.length.toLocaleString()} rows. Split it into files of ${MAX_ROWS.toLocaleString()} rows or fewer.`
    );
  }

  // Parse again on the server: the browser preview is only a preview.
  const { records, errors } = parseRows(input.rows, mapping, input.firstRow);
  const rowsWithErrors = new Set(
    errors.filter((e) => e.severity === "error").map((e) => e.row)
  ).size;

  const db = forOrg(database, orgId);
  const name =
    input.sheetName && input.sheetName !== input.fileName
      ? `${input.fileName} › ${input.sheetName}`
      : input.fileName;
  const source = await db.source.create({
    data: {
      orgId,
      name,
      type: "upload",
      profile: mapping.entity,
      status: "parsing",
    },
  });

  try {
    const result = await saveRecords(database, orgId, mapping.entity, records, {
      sourceId: source.id,
    });
    const label = ENTITIES[mapping.entity].label.toLowerCase();
    await db.source.updateMany({
      where: { id: source.id },
      data: {
        status: "ready",
        summary: `${label}: ${result.created} added, ${result.updated} updated, ${rowsWithErrors} rows skipped`,
      },
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped + rowsWithErrors,
      notes: result.notes,
      errors: errors.slice(0, 200),
    };
  } catch (error) {
    log.error("Import failed", { error, entity: mapping.entity, orgId });
    await db.source.updateMany({
      where: { id: source.id },
      data: { status: "failed", summary: String(error).slice(0, 500) },
    });
    return failed(
      "Something went wrong while saving. Some rows may already be in. Uploading the same file again is safe: rows are matched, not duplicated."
    );
  }
};
