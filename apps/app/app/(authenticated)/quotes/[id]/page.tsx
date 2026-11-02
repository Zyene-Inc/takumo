import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { customerReply } from "@/lib/quotes/document";
import { rfqFilesOf } from "@/lib/quotes/files";
import { intakeNoteOf } from "@/lib/quotes/intake";
import { type ScreenNote, screenNoteOf } from "@/lib/quotes/screening";
import { quoteSettings } from "@/lib/quotes/settings";
import { loadRfqView } from "@/lib/quotes/view";
import { Header } from "../../components/header";
import { ScreenButtons } from "../screen-buttons";
import { RfqFiles } from "./rfq-files";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "RFQ · Takumo" };
// Drafting runs the scheduler for every line, and new parts ask Claude.
export const maxDuration = 300;

/** Screening held this email back: why, and the person's choices. */
const WaitingBanner = ({
  rfqId,
  filtered,
  note,
  canEdit,
}: {
  canEdit: boolean;
  filtered: boolean;
  note: ScreenNote | null;
  rfqId: string;
}) => (
  <div className="mx-4 mb-4 grid gap-2 rounded-xl border border-dashed p-4">
    <p className="font-medium">
      {filtered
        ? "Takumo left this email alone: it doesn't look like an RFQ."
        : "This looks like an RFQ from someone new."}
    </p>
    {note?.summary && <p className="text-sm">{note.summary}</p>}
    {note?.reason && (
      <p className="text-muted-foreground text-sm">{note.reason}</p>
    )}
    <p className="text-muted-foreground text-sm">
      Nothing has been read or priced yet. Quote it and Takumo reads it, prices
      it and drafts the reply, and knows this sender next time.
    </p>
    {canEdit && <ScreenButtons filtered={filtered} rfqId={rfqId} />}
  </div>
);

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
      {(rfq.status === "new_sender" || rfq.status === "filtered") && (
        <WaitingBanner
          canEdit={canEditQuotes}
          filtered={rfq.status === "filtered"}
          note={screenNoteOf(intake?.extracted)}
          rfqId={rfq.id}
        />
      )}
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
