import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { poCsv } from "@/lib/orders/erp";
import { type PoLine, poLabel } from "@/lib/orders/types";

/** The PO's lines as a CSV, to import or paste into the ERP. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { orgId } = await auth();
  if (!orgId) {
    return new Response("Not found", { status: 404 });
  }
  const { id } = await params;
  const po = await forOrg(database, orgId).customerPo.findFirst({
    where: { id },
    select: {
      number: true,
      poNo: true,
      customerName: true,
      lines: true,
      extracted: true,
    },
  });
  if (!po) {
    return new Response("Not found", { status: 404 });
  }
  const header = (
    po.extracted as {
      header?: { shipTo?: string | null; terms?: string | null };
    } | null
  )?.header;
  const csv = poCsv({
    customer: po.customerName,
    poNo: po.poNo,
    shipTo: header?.shipTo ?? null,
    terms: header?.terms ?? null,
    lines: (po.lines as PoLine[] | null) ?? [],
  });
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${poLabel(po.number)}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
