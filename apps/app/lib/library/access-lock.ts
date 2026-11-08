import "server-only";

import { database, type Prisma } from "@repo/database";
import { trustedViewer, type Viewer } from "./viewer";

// Changes to who may see what (grants, inheritance, confidential folders,
// department members, moves) run one at a time per shop. Each checks the
// changer's access after taking the lock, so it sees every change committed
// before it: an admin whose "manage" was just removed can't still grant, and
// two changes can't each pass a check the other invalidates (security audit,
// check-then-write races).

export const ACCESS_LOCK_SQL =
  "select pg_advisory_xact_lock(hashtextextended('library-access:' || $1, 0))";

/** Take the shop's access lock inside a transaction that's already open. */
export const lockAccess = (tx: Prisma.TransactionClient, orgId: string) =>
  tx.$executeRawUnsafe(ACCESS_LOCK_SQL, orgId);

/** Run `work` while holding the shop's access lock (released when it ends). */
export const serializeAccess = <T>(orgId: string, work: () => Promise<T>) =>
  database.$transaction(
    async (tx) => {
      await lockAccess(tx, orgId);
      return work();
    },
    { maxWait: 10_000, timeout: 30_000 }
  );

/** `fn`, run under its viewer's shop access lock (the viewer comes first). */
export const serialized =
  <A extends [Viewer, ...unknown[]], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    serializeAccess(trustedViewer(args[0]).orgId, () => fn(...args));
