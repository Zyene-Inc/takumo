import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { quotedLines, quoteReference } from "@/lib/quotes/document";
import { rfqFilesOf } from "@/lib/quotes/files";
import { intakeNoteOf } from "@/lib/quotes/intake";
import { replyEmail } from "@/lib/quotes/reply";
import { loadRfqView } from "@/lib/quotes/view";
import { Header } from "../../components/header";
import { RfqFiles } from "./rfq-files";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "RFQ · Takumo" };
// Drafting runs the scheduler for every line, and new parts ask Claude.
export const maxDuration = 300;

const RfqPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { orgId, canEditQuotes } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { id } = await params;
  const db = forOrg(database, orgId);
  const [rfq, machines, materials, customers, org, files, intake] =
    await Promise.all([
      loadRfqView(orgId, id),
      db.workCenter.findMany({
        orderBy: { name: "asc" },
        select: { name: true },
      }),
      db.material.findMany({
        orderBy: { name: "asc" },
        select: { name: true },
      }),
      db.customer.findMany({
        orderBy: { name: "asc" },
        select: { name: true },
      }),
      database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
      rfqFilesOf(orgId, id),
      db.rfq.findFirst({ where: { id }, select: { extracted: true } }),
    ]);
  if (!rfq) {
    notFound();
  }
  const quoted = quotedLines(rfq);
  const reply = quoted.length
    ? replyEmail({
        contact: rfq.contact,
        subject: rfq.subject,
        shop: org?.name ?? "",
        reference: quoteReference(quoted.map((l) => l.quoteNo)),
        lines: quoted,
      })
    : null;

  return (
    <>
      <Header page={rfq.label} pages={["Quotes", "RFQ inbox"]} />
      <RfqFiles
        files={files}
        rfqId={rfq.id}
        skipped={intakeNoteOf(intake?.extracted)?.skipped ?? []}
        source={rfq.source}
      />
      <Workspace
        canEdit={canEditQuotes}
        customers={customers.map((c) => c.name)}
        machines={machines.map((m) => m.name)}
        materials={materials.map((m) => m.name)}
        reply={reply}
        rfq={rfq}
      />
    </>
  );
};

export default RfqPage;
