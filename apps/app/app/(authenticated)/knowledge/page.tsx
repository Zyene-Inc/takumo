import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { FileTextIcon, MessageSquareIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { DOC_TYPE_LABEL } from "@/lib/knowledge/understand";
import { libraryEnabled } from "@/lib/library/stage";
import { Header } from "../components/header";
import { EmptyState } from "../shop/components/format";
import { DeleteDocument, ReadAgain, UploadDocuments } from "./upload";

export const metadata: Metadata = { title: "Knowledge · Takumo" };

interface CardMeta {
  docType?: keyof typeof DOC_TYPE_LABEL;
  links?: { label: string }[];
  revision?: string | null;
}

const understood = (card: CardMeta | undefined) => {
  if (!card?.docType) {
    return null;
  }
  const type = DOC_TYPE_LABEL[card.docType] ?? "document";
  const kind = type.charAt(0).toUpperCase() + type.slice(1);
  const links = card.links ?? [];
  return {
    kind: card.revision ? `${kind}, rev ${card.revision}` : kind,
    links: links.length
      ? `About ${links
          .slice(0, 5)
          .map((l) => l.label)
          .join(
            ", "
          )}${links.length > 5 ? ` and ${links.length - 5} more` : ""}`
      : null,
  };
};

const KnowledgePage = async () => {
  const { orgId, canEditKnowledge, canShareKnowledge } = await getAccess();
  if (!orgId) {
    notFound();
  }
  // Documents in the Trash aren't listed.
  const sources = await forOrg(database, orgId).source.findMany({
    where: { profile: "document", deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      summary: true,
      createdAt: true,
      currentVersionId: true,
      _count: { select: { chunks: true } },
    },
  });
  const current = new Set(sources.map((s) => s.currentVersionId));
  // What Takumo understood about each document (its current version), when
  // it has read it.
  const cards = new Map(
    (
      await forOrg(database, orgId).docChunk.findMany({
        where: {
          meta: { path: ["kind"], equals: "card" },
          source: { deletedAt: null },
        },
        select: { sourceId: true, versionId: true, meta: true },
      })
    )
      .filter((c) => current.has(c.versionId))
      .map((c) => [c.sourceId, c.meta as CardMeta])
  );

  return (
    <>
      <Header page="Sources" pages={["Knowledge"]}>
        <div className="px-4">
          <Button asChild size="sm" variant="outline">
            <Link href="/ask">
              <MessageSquareIcon /> Ask Takumo
            </Link>
          </Button>
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        {(await libraryEnabled(orgId)) && (
          <p className="max-w-3xl rounded-lg border bg-muted/40 p-3 text-sm">
            Your company's documents now live in{" "}
            <Link className="font-medium underline" href="/library">
              Company Knowledge
            </Link>
            , with folders, versions and the original files.
          </p>
        )}
        <p className="max-w-3xl text-muted-foreground text-sm">
          Documents Ask Takumo can search and cite: how jobs are set up, quality
          rules, customer requirements, company policies. Anyone in the company
          can add what they know. Answers link to the page they came from.
        </p>
        {canShareKnowledge && <UploadDocuments />}
        {sources.length === 0 ? (
          <EmptyState>No documents yet.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {sources.map((s) => {
              const card = understood(cards.get(s.id));
              return (
                <li
                  className="flex flex-wrap gap-3 rounded-xl border p-4"
                  id={`source-${s.id}`}
                  key={s.id}
                >
                  <FileTextIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{s.name}</p>
                      {card && <Badge>{card.kind}</Badge>}
                      <Badge variant="secondary">
                        {s._count.chunks} passage
                        {s._count.chunks === 1 ? "" : "s"}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        added{" "}
                        {s.createdAt.toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    {s.summary && (
                      <p className="mt-1 line-clamp-2 text-muted-foreground text-sm">
                        {s.summary}
                      </p>
                    )}
                    {card?.links && (
                      <p className="mt-1 text-xs">{card.links}</p>
                    )}
                    {canEditKnowledge && !card && (
                      <p className="mt-1 text-muted-foreground text-xs">
                        Added before Takumo read documents in full: read it
                        again to link it to your records and propose its facts.
                      </p>
                    )}
                  </div>
                  {canEditKnowledge && (
                    // The steps log wraps onto its own line under the row.
                    <>
                      <ReadAgain id={s.id} name={s.name} />
                      <DeleteDocument id={s.id} name={s.name} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
};

export default KnowledgePage;
