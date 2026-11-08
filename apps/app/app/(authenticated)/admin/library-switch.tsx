"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLibrary } from "./actions";

/** Turn a shop's Company Knowledge Library on or off (staff only). */
export const LibrarySwitch = ({
  orgId,
  stage,
}: {
  orgId: string;
  stage: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (stage === "confidential") {
    return (
      <span className="text-muted-foreground text-xs">Library: restricted</span>
    );
  }
  const on = stage === "library";
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await setLibrary(orgId, !on);
          if (!result.ok) {
            toast.error(result.error);
          }
          router.refresh();
        })
      }
      size="sm"
      title={
        on
          ? "Turn the Library off for this shop"
          : "Turn the Library on for this shop"
      }
      variant="ghost"
    >
      Library: {on ? "on" : "off"}
    </Button>
  );
};
