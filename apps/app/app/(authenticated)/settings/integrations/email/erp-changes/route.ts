import { auth } from "@repo/auth/server";
import { changesForErp } from "@/lib/erp/changes";
import { changesCsv, changesFileName } from "@/lib/erp/changes-csv";

/** Approved changes to ERP records, as a CSV to work through in the ERP. */
export const GET = async () => {
  const { orgId } = await auth();
  if (!orgId) {
    return new Response("Not found", { status: 404 });
  }
  const csv = changesCsv(await changesForErp(orgId));
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${changesFileName(new Date())}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
