import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../database/generated/client";
import type { EntityKey } from "../entities";
import { suggestMapping } from "../match";
import { saveRecords } from "../save";
import { parseRows, type SheetRow } from "../transform";

// Point at a disposable database (CI) or a dev database: every test run works
// in its own throwaway org and deletes it afterwards.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const connect = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL ?? "" }),
  });

export const createTestOrg = async (db: PrismaClient, label = "test") => {
  const id = `org_${label}_${randomUUID().slice(0, 8)}`;
  await db.org.create({ data: { id, name: `Takumo ${label} ${id}` } });
  return id;
};

const SEED_DIR = join(import.meta.dirname, "../../../seed/acme-precision");

// The seed files have no quoted commas.
export const readSeed = (file: string) => {
  const [header, ...lines] = readFileSync(join(SEED_DIR, file), "utf8")
    .trim()
    .split("\n");
  const headers = header.split(",");
  const rows: SheetRow[] = lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
  return { headers, rows };
};

/** The import pipeline end to end: match headers, parse, save. */
export const importRows = async (
  db: PrismaClient,
  orgId: string,
  entity: EntityKey,
  headers: readonly string[],
  rows: readonly SheetRow[],
  provenance: "data" | "stated" = "data"
) => {
  const mapping = suggestMapping(entity, headers);
  const parsed = parseRows(rows, mapping);
  const result = await saveRecords(db, orgId, entity, parsed.records, {
    provenance,
  });
  return { ...result, errors: parsed.errors };
};
