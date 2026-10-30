"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { retryNote } from "./actions";

export const RetryNote = ({ id }: { id: string }) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      className="justify-self-start"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await retryNote(id);
          router.refresh();
        })
      }
      size="sm"
      variant="outline"
    >
      {pending && <Spinner />} Read it again
    </Button>
  );
};
