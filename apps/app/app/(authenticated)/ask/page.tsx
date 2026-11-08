import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { HistoryIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  findConversation,
  listConversations,
  loadMessages,
} from "@/lib/agent/conversations";
import { redactHistory } from "@/lib/agent/redact";
import { buildStarters } from "@/lib/agent/starters";
import { canTranscribe } from "@/lib/facts/transcribe";
import { usableSourceIds } from "@/lib/library/ai-access";
import { resolveViewer, type Viewer } from "@/lib/library/viewer";
import { Header } from "../components/header";
import { Chat } from "./chat";

export const metadata: Metadata = { title: "Ask Takumo · Takumo" };

// Example questions for the start screen, using the shop's own records and
// only documents this person may ask about.
const loadStarters = async (viewer: Viewer) => {
  const { orgId } = viewer;
  const db = forOrg(database, orgId);
  const usable = [...(await usableSourceIds(viewer, "search"))];
  const [parts, orders, machines, customers, quotes, documents] =
    await Promise.all([
      db.part.findMany({
        orderBy: { orders: { _count: "desc" } },
        take: 2,
        select: { partNo: true },
      }),
      db.order.findMany({
        where: { status: { in: ["open", "in_progress"] } },
        orderBy: { dueDate: "asc" },
        take: 2,
        select: {
          orderNo: true,
          qty: true,
          part: { select: { partNo: true } },
        },
      }),
      db.workCenter.findMany({
        orderBy: [
          { hourlyRate: { sort: "desc", nulls: "last" } },
          { routings: { _count: "desc" } },
        ],
        take: 2,
        select: { name: true },
      }),
      db.customer.findMany({
        orderBy: { orders: { _count: "desc" } },
        take: 1,
        select: { name: true },
      }),
      db.quote.findMany({
        orderBy: { quotedAt: "desc" },
        take: 1,
        select: { quoteNo: true },
      }),
      db.source.findMany({
        where: {
          id: { in: usable },
          profile: "document",
          deletedAt: null,
          currentVersionId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { name: true },
      }),
    ]);
  return buildStarters({
    today: new Date().toISOString().slice(0, 10),
    parts: parts.map((p) => p.partNo),
    orders: orders.map((o) => ({
      orderNo: o.orderNo,
      qty: o.qty,
      partNo: o.part.partNo,
    })),
    machines: machines.map((m) => m.name),
    customers: customers.map((c) => c.name),
    quotes: quotes.map((q) => q.quoteNo),
    documents: documents.map((d) => d.name),
  });
};

const AskPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string }>;
}) => {
  const viewer = await resolveViewer();
  if (!viewer?.userId) {
    notFound();
  }
  const { orgId, userId } = viewer;
  const { c, q } = await searchParams;
  const conversation = c ? await findConversation(orgId, userId, c) : null;
  if (c && !conversation) {
    notFound();
  }
  const [messages, recent, starters] = await Promise.all([
    conversation
      ? loadMessages(conversation.id).then((m) =>
          redactHistory(viewer, conversation.id, m)
        )
      : Promise.resolve([]),
    listConversations(orgId, userId, 15),
    conversation || q ? Promise.resolve(null) : loadStarters(viewer),
  ]);
  const id = conversation?.id ?? crypto.randomUUID();

  return (
    <>
      <Header
        page={conversation?.title ?? "New conversation"}
        pages={["Ask Takumo"]}
      >
        <div className="flex items-center gap-2 px-4">
          <Button asChild size="sm" variant="ghost">
            <Link href="/ask/history">
              <HistoryIcon /> History
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/ask">
              <PlusIcon /> New
            </Link>
          </Button>
        </div>
      </Header>
      <div className="flex h-[calc(100svh-4rem)] min-h-0 md:h-[calc(100svh-5rem)]">
        {recent.length > 0 && (
          <nav
            aria-label="Recent conversations"
            className="hidden w-56 shrink-0 overflow-y-auto border-r px-2 py-2 lg:block"
          >
            <p className="px-2 pb-1 font-medium text-muted-foreground text-xs">
              Recent
            </p>
            {recent.map((r) => (
              <Link
                className={cn(
                  "block truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                  r.id === conversation?.id && "bg-muted font-medium"
                )}
                href={`/ask?c=${r.id}`}
                key={r.id}
                title={r.title}
              >
                {r.title}
              </Link>
            ))}
          </nav>
        )}
        <Chat
          canDictate={canTranscribe()}
          id={id}
          initialMessages={messages}
          initialQuestion={conversation ? undefined : q?.slice(0, 4000)}
          isNew={!conversation}
          key={id}
          starters={starters}
        />
      </div>
    </>
  );
};

export default AskPage;
