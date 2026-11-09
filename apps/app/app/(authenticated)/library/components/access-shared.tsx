"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import type { ReactNode } from "react";
import type { Level } from "@/lib/library/access-view";

export type Target = { folderId: string } | { sourceId: string };
export type AiMode = "off" | "search" | "full";

export const AI_TEXT: Record<AiMode, { help: string; label: string }> = {
  off: {
    label: "AI processing off",
    help: "Nothing from these documents is sent to outside AI services. Their text is read here and found by the library's search; Ask Takumo doesn't use them, and scans aren't read.",
  },
  search: {
    label: "Ask can search",
    help: "Read and indexed here, with nothing sent while reading. When someone who may open them asks Takumo a question, short passages found by keywords may be sent to the AI service to answer it.",
  },
  full: {
    label: "Full AI",
    help: "Read with AI services: scans recognised, summaries, links to your records, facts for review and search by meaning. Ask Takumo uses them for people who may open them.",
  },
};

export const LEVELS: Level[] = [
  "Can view",
  "Can upload",
  "Can edit",
  "Can manage access",
];

export interface Outcome {
  error?: string;
  ok: boolean;
}

/** Shared by the dialog's sections: run a change, then show the result. */
export interface Change {
  pending: boolean;
  /** Reload who has access (after a change made through start). */
  reload: () => Promise<void>;
  /** Run a change; on success reload who has access. */
  run: (change: () => Promise<Outcome>) => void;
  setError: (error: string | null) => void;
  /** Run a change that may come back asking for confirmation. */
  start: (work: () => Promise<void>) => void;
}

/** "Are you sure" in the dialog, for changes that let more people in. */
export const Confirm = ({
  children,
  onConfirm,
  onCancel,
  pending,
  label,
}: {
  children: ReactNode;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) => (
  <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
    {children}
    <div className="flex flex-wrap gap-2">
      <Button disabled={pending} onClick={onConfirm} size="sm">
        {pending && <Spinner />} {label}
      </Button>
      <Button onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </div>
  </div>
);
