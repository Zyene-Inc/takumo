import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { customerReply } from "@/lib/quotes/document";
import { rfqFilesOf } from "@/lib/quotes/files";
import { intakeNoteOf } from "@/lib/quotes/intake";
import { quoteSettings } from "@/lib/quotes/settings";
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
  const [rfq, machines, materials, customers, org, files, intake, settings] =
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
      quoteSettings(orgId),
    ]);
  if (!rfq) {
    notFound();
  }
  // What the customer gets: the same text as the draft in the mailbox.
  const reply = customerReply(
    rfq,
    org?.name ?? "Our shop",
    settings,
    rfq.reply?.quoteNos ?? null
  );

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
        files={files.map((f) => ({
          id: f.id,
          name: f.name,
          mediaType: f.mediaType,
          pages: f.pages,
        }))}
        machines={machines.map((m) => m.name)}
        materials={materials.map((m) => m.name)}
        reply={reply ? { subject: reply.subject, body: reply.text } : null}
        rfq={rfq}
      />
    </>
  );
};

export default RfqPage;
