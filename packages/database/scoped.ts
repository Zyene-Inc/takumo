import type { PrismaClient } from "./generated/client";

// Models that are not tenant-owned (or are scoped through a parent).
const UNSCOPED_MODELS = new Set(["Org", "Message"]);

const READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

/**
 * Returns a Prisma client that injects `orgId` into every query on
 * tenant-owned models. Use this in app code instead of `database` directly:
 *
 *   const db = forOrg(database, orgId);
 *   await db.order.findMany({ where: { status: "open" } });
 *
 * Single-row ops by unique key (findUnique, update, delete) are not
 * rewritten; check `row.orgId === orgId` after reading.
 */
export const forOrg = (client: PrismaClient, orgId: string) => {
  if (!orgId) {
    throw new Error("forOrg: orgId is required");
  }

  return client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (UNSCOPED_MODELS.has(model)) {
            return query(args);
          }

          const scopedArgs = (args ?? {}) as Record<string, unknown>;

          if (READ_OPS.has(operation)) {
            scopedArgs.where = { ...(scopedArgs.where as object), orgId };
          }

          if (CREATE_OPS.has(operation)) {
            const data = scopedArgs.data;
            scopedArgs.data = Array.isArray(data)
              ? data.map((row) => ({ ...row, orgId }))
              : { ...(data as object), orgId };
          }

          return query(scopedArgs as typeof args);
        },
      },
    },
  });
};
