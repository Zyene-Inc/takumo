import { readFileSync } from "node:fs";
import { join } from "node:path";

// The seed files contain no quoted commas, so a simple split is enough.
const readCsv = (dir: string, file: string): Record<string, string>[] => {
  const [header, ...rows] = readFileSync(join(dir, file), "utf8")
    .trim()
    .split("\n");
  const columns = header.split(",");
  return rows.map((row) => {
    const values = row.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? ""]));
  });
};

/** Every CSV of the demo shop, by table. */
export const readSeed = (dir: string) => ({
  workCenters: readCsv(dir, "work_centers.csv"),
  customers: readCsv(dir, "customers.csv"),
  materials: readCsv(dir, "materials.csv"),
  parts: readCsv(dir, "parts.csv"),
  routings: readCsv(dir, "routings.csv"),
  orders: readCsv(dir, "orders.csv"),
  quotes: readCsv(dir, "quotes.csv"),
  jobs: readCsv(dir, "jobs.csv"),
});
