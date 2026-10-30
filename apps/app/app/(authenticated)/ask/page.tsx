import { auth } from "@repo/auth/server";
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
import { Header } from "../components/header";
import { Chat } from "./chat";

export const metadata: Metadata = { title: "Ask Takumo · Takumo" };

const AskPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string }>;
}) => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    notFound();
  }
  const { c, q } = await searchParams;
  const conversation = c ? await findConversation(orgId, userId, c) : null;
  if (c && !conversation) {
    notFound();
  }
  const [messages, recent] = await Promise.all([
    conversation ? loadMessages(conversation.id) : Promise.resolve([]),
    listConversations(orgId, userId, 15),
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
          id={id}
          initialMessages={messages}
          initialQuestion={conversation ? undefined : q?.slice(0, 4000)}
          isNew={!conversation}
          key={id}
        />
      </div>
    </>
  );
};

export default AskPage;
