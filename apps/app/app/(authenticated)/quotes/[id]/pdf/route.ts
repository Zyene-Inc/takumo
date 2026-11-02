import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import { quoteDocument } from "@/lib/quotes/document";
import { renderQuotePdf } from "@/lib/quotes/pdf";
import { quoteSettings } from "@/lib/quotes/settings";
import { loadRfqView } from "@/lib/quotes/view";

/**
 * The quote as a PDF for the customer: the approved quotes, or before that
 * the draft reply's prices with the quote numbers the draft carries.
 */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { orgId } = await auth();
  if (!orgId) {
    return new Response("Not found", { status: 404 });
  }
  const { id } = await params;
  const [rfq, org, settings] = await Promise.all([
    loadRfqView(orgId, id),
    database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
    quoteSettings(orgId),
  ]);
  const reserved = rfq?.reply?.quoteNos ?? null;
  const doc = rfq
    ? quoteDocument(rfq, org?.name ?? "Our shop", {
        reserved,
        today: new Date().toISOString().slice(0, 10),
        validityDays: settings.quoteValidityDays,
      })
    : null;
  if (!doc || doc.lines.length === 0) {
    return new Response("This RFQ hasn't been drafted yet.", { status: 404 });
  }
  const bytes = await renderQuotePdf(doc);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Quote ${doc.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
};
