"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { extendTrial } from "./actions";

export const ExtendTrial = ({ orgId }: { orgId: string }) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          await extendTrial(orgId, 30);
          router.refresh();
        })
      }
      size="sm"
      variant="ghost"
    >
      +30 days
    </Button>
  );
};
