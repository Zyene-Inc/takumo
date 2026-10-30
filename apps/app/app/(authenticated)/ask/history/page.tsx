import { auth } from "@repo/auth/server";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listConversations } from "@/lib/agent/conversations";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { DeleteConversation } from "../delete-conversation";

export const metadata: Metadata = { title: "History · Ask Takumo" };

const HistoryPage = async () => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    notFound();
  }
  const conversations = await listConversations(orgId, userId, 200);

  return (
    <>
      <Header page="History" pages={["Ask Takumo"]}>
        <div className="px-4">
          <Button asChild size="sm">
            <Link href="/ask">
              <PlusIcon /> New conversation
            </Link>
          </Button>
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="text-muted-foreground text-sm">
          Your conversations with Takumo. Only you can see them.
        </p>
        {conversations.length === 0 ? (
          <EmptyState>
            No conversations yet.{" "}
            <Link className="underline" href="/ask">
              Ask a question
            </Link>
            .
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {conversations.map((c) => (
              <li className="flex items-center gap-3 px-4 py-3" key={c.id}>
                <Link className="min-w-0 flex-1" href={`/ask?c=${c.id}`}>
                  <p className="truncate font-medium text-sm hover:underline">
                    {c.title}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {c.updatedAt.toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    · {c.messages} message{c.messages === 1 ? "" : "s"}
                  </p>
                </Link>
                <DeleteConversation id={c.id} title={c.title} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

export default HistoryPage;
