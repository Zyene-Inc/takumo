"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteConversation } from "./actions";

export const DeleteConversation = ({
  id,
  title,
  redirectTo,
}: {
  id: string;
  redirectTo?: string;
  title: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={`Delete "${title}"`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          // biome-ignore lint/suspicious/noAlert: a plain confirm is enough here
          if (!window.confirm(`Delete "${title}"? This can't be undone.`)) {
            return;
          }
          const result = await deleteConversation(id);
          if (result.ok && redirectTo) {
            router.push(redirectTo);
          }
          router.refresh();
        })
      }
      size="icon"
      variant="ghost"
    >
      {pending ? <Spinner /> : <Trash2Icon />}
    </Button>
  );
};
