import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import { quoteDocument } from "@/lib/quotes/document";
import { renderQuotePdf } from "@/lib/quotes/pdf";
import { loadRfqView } from "@/lib/quotes/view";

/** The approved quote as a PDF for the customer. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { orgId } = await auth();
  if (!orgId) {
    return new Response("Not found", { status: 404 });
  }
  const { id } = await params;
  const [rfq, org] = await Promise.all([
    loadRfqView(orgId, id),
    database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  if (!rfq || rfq.lines.every((l) => !l.quote)) {
    return new Response("This RFQ hasn't been quoted yet.", { status: 404 });
  }
  const doc = quoteDocument(rfq, org?.name ?? "Our shop");
  const bytes = await renderQuotePdf(doc);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Quote ${doc.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
};
