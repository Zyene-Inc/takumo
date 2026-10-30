import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { FileTextIcon, MessageSquareIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { Header } from "../components/header";
import { EmptyState } from "../shop/components/format";
import { DeleteDocument, UploadDocuments } from "./upload";

export const metadata: Metadata = { title: "Knowledge · Takumo" };

const KnowledgePage = async () => {
  const { orgId, canEditKnowledge } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const sources = await forOrg(database, orgId).source.findMany({
    where: { profile: "document" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      summary: true,
      createdAt: true,
      _count: { select: { chunks: true } },
    },
  });

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
        <p className="max-w-3xl text-muted-foreground text-sm">
          Documents Ask Takumo can search and cite: how jobs are set up, quality
          rules, customer requirements. Answers link to the page they came from.
        </p>
        {canEditKnowledge ? (
          <UploadDocuments />
        ) : (
          <p className="text-muted-foreground text-sm">
            Ask an admin, planner or estimator to add documents.
          </p>
        )}
        {sources.length === 0 ? (
          <EmptyState>No documents yet.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {sources.map((s) => (
              <li
                className="flex gap-3 rounded-xl border p-4"
                id={`source-${s.id}`}
                key={s.id}
              >
                <FileTextIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{s.name}</p>
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
                </div>
                {canEditKnowledge && <DeleteDocument id={s.id} name={s.name} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

export default KnowledgePage;
