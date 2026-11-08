import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import { MessageSquareIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildBrain } from "@/lib/knowledge/brain";
import { usableSourceIds, visibleFactIds } from "@/lib/library/ai-access";
import { resolveViewer } from "@/lib/library/viewer";
import { Header } from "../../components/header";
import { BrainView } from "./view";

export const metadata: Metadata = { title: "Brain · Takumo" };

// Recent activity only, so a busy shop's map stays readable and fast.
const RECENT = 200;

const BrainPage = async () => {
  const viewer = await resolveViewer();
  if (!viewer) {
    notFound();
  }
  const { orgId } = viewer;
  const db = forOrg(database, orgId);
  // Only documents and facts this person may use: documents whose AI
  // setting is "full" (the Brain is made by reading them), not in the Trash.
  const [usable, factIds] = await Promise.all([
    usableSourceIds(viewer, "full").then((ids) => [...ids]),
    visibleFactIds(viewer),
  ]);
  const [
    org,
    customers,
    materials,
    workCenters,
    parts,
    routings,
    bom,
    orders,
    quotes,
    rfqs,
    facts,
    sources,
    cards,
  ] = await Promise.all([
    database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
    db.customer.findMany({ select: { id: true, name: true } }),
    db.material.findMany({ select: { id: true, name: true, spec: true } }),
    db.workCenter.findMany({ select: { id: true, name: true, type: true } }),
    db.part.findMany({
      select: {
        id: true,
        partNo: true,
        rev: true,
        description: true,
        customerId: true,
        materialId: true,
      },
    }),
    db.routing.findMany({
      select: { id: true, partId: true, seq: true, workCenterId: true },
    }),
    db.bomLine.findMany({
      select: { parentPartId: true, childPartId: true },
    }),
    db.order.findMany({
      orderBy: { dueDate: "desc" },
      take: RECENT,
      where: { status: { not: "cancelled" } },
      select: {
        id: true,
        orderNo: true,
        customerId: true,
        partId: true,
        status: true,
      },
    }),
    db.quote.findMany({
      orderBy: { quotedAt: "desc" },
      take: RECENT,
      select: {
        id: true,
        quoteNo: true,
        customerId: true,
        partId: true,
        rfqId: true,
        status: true,
      },
    }),
    db.rfq.findMany({
      orderBy: { receivedAt: "desc" },
      take: RECENT,
      select: {
        id: true,
        number: true,
        subject: true,
        customerName: true,
        customerId: true,
      },
    }),
    db.fact.findMany({
      orderBy: { number: "desc" },
      take: RECENT,
      where: { id: { in: factIds }, status: "approved" },
      select: {
        id: true,
        number: true,
        subjectType: true,
        subjectId: true,
        subjectLabel: true,
        attribute: true,
        value: true,
      },
    }),
    // Documents in the Trash, and versions still being read, aren't shown.
    db.source.findMany({
      where: { id: { in: usable }, profile: "document", deletedAt: null },
      select: { id: true, name: true, summary: true },
    }),
    // Each read document's card lists the records it's about.
    db.docChunk.findMany({
      where: {
        sourceId: { in: usable },
        meta: { path: ["kind"], equals: "card" },
        source: { deletedAt: null },
        version: { currentOf: { isNot: null } },
      },
      select: { sourceId: true, meta: true },
    }),
  ]);
  const links = new Map(
    cards.map((c) => [
      c.sourceId,
      ((c.meta as { links?: { ref: string }[] } | null)?.links ?? []).map(
        (l) => l.ref
      ),
    ])
  );

  const documents = sources.map((d) => ({ ...d, links: links.get(d.id) }));
  const brain = buildBrain({
    shopName: org?.name ?? "Your shop",
    customers,
    materials,
    workCenters,
    parts,
    routings,
    bom,
    orders,
    quotes,
    rfqs,
    facts,
    documents,
  });

  const stats = [
    { label: "Records", value: brain.nodes.length },
    { label: "Connections", value: brain.links.length },
    { label: "Facts", value: facts.length },
    { label: "Documents", value: documents.length },
  ];

  return (
    <>
      <Header page="Brain" pages={["Knowledge"]}>
        <div className="px-4">
          <Button asChild size="sm" variant="outline">
            <Link href="/ask">
              <MessageSquareIcon /> Ask Takumo
            </Link>
          </Button>
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <p className="max-w-2xl text-muted-foreground text-sm">
            Everything Takumo knows about your shop and how it connects:
            customers, parts, machines, orders, quotes, approved facts and
            documents. Click any node to see its connections and open it.
          </p>
          <dl className="flex gap-6">
            {stats.map((s) => (
              <div key={s.label}>
                <dt className="text-muted-foreground text-xs">{s.label}</dt>
                <dd className="font-semibold text-2xl tabular-nums">
                  {s.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <BrainView brain={brain} />
      </div>
    </>
  );
};

export default BrainPage;
