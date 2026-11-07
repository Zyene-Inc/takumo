"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { DocumentState } from "@/lib/library/rows";

const LABEL: Record<DocumentState, string> = {
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

const VARIANT: Record<
  DocumentState,
  "default" | "secondary" | "outline" | "destructive"
> = {
  uploading: "outline",
  queued: "outline",
  processing: "secondary",
  ready: "default",
  failed: "destructive",
};

/** A document's real processing state; never a made-up percentage. */
export const StatusBadge = ({
  newVersion = false,
  state,
}: {
  newVersion?: boolean;
  state: DocumentState;
}) => {
  const busy =
    state === "uploading" || state === "queued" || state === "processing";
  return (
    <Badge
      title={
        newVersion
          ? "About a new version. The current version stays in use until it's ready."
          : undefined
      }
      variant={VARIANT[state]}
    >
      {busy && <Spinner className="size-3" />}
      {newVersion ? `New version: ${LABEL[state].toLowerCase()}` : LABEL[state]}
    </Badge>
  );
};

const EVERY_MS = 5000;

/**
 * While any document on the page is still being read, check again every few
 * seconds, so the list shows the server's progress even after the upload
 * window was closed.
 */
export const RefreshWhileBusy = ({ busy }: { busy: boolean }) => {
  const router = useRouter();
  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setInterval(() => router.refresh(), EVERY_MS);
    return () => clearInterval(timer);
  }, [busy, router]);
  return null;
};
