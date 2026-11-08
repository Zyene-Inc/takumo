"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { BotIcon, LockIcon, ShieldIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import type { AccessView } from "@/lib/library/access-view";
import { loadAccess } from "../access-actions";
import { GiveAccess, PeopleWithAccess } from "./access-people";
import { AiSetting, Confidential, Inheritance } from "./access-settings";
import { AI_TEXT, type Change, type Target } from "./access-shared";

export type { Target } from "./access-shared";

/** A short line on how an item's access works, for its header. */
export const AccessBadges = ({ view }: { view: AccessView }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {view.confidential && (
      <Badge variant="secondary">
        <ShieldIcon /> Confidential
      </Badge>
    )}
    {view.restricting && !view.inherits && !view.topLevel && (
      <Badge variant="secondary">
        <LockIcon /> Restricted
      </Badge>
    )}
    {view.aiMode !== "full" && (
      <Badge variant="outline">
        <BotIcon />{" "}
        {view.aiMode === "off" ? "AI processing disabled" : "AI: search only"}
      </Badge>
    )}
  </div>
);

/**
 * Who can open a folder or document, and (for people who manage it)
 * changing that: add a department or person, remove access, stop or resume
 * inheriting, the confidential flag and the AI setting (folders). Anything
 * that lets more people in is confirmed first. The server decides every
 * change again.
 */
export const AccessDialog = ({
  target,
  name,
  initial,
  trigger,
}: {
  initial: AccessView;
  name: string;
  target: Target;
  trigger?: ReactNode;
}) => {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reload = async () => {
    const next = await loadAccess(target);
    if (next) {
      setView(next);
    }
    router.refresh();
  };
  const change: Change = {
    pending,
    setError,
    reload,
    start: (work) => startTransition(work),
    run: (work) =>
      startTransition(async () => {
        const r = await work();
        if (r.ok) {
          setError(null);
          await reload();
        } else {
          setError(r.error ?? "That didn't work. Try again.");
        }
      }),
  };
  const folderId = "folderId" in target ? target.folderId : null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <UsersIcon /> Access
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Who can open {name}</DialogTitle>
          <DialogDescription>
            {view.restricting
              ? "Access is checked on every page, download and question to Takumo."
              : "Everyone in the shop can open what's in the library. Restricting access isn't available yet."}
          </DialogDescription>
        </DialogHeader>
        <AccessBadges view={view} />
        <section className="grid gap-1">
          <h3 className="font-medium text-sm">You can</h3>
          <p className="text-muted-foreground text-sm">
            {view.yours.join(", ")}.
          </p>
        </section>
        {view.restricting && <PeopleWithAccess change={change} view={view} />}
        {view.canManage && (
          <GiveAccess change={change} target={target} view={view} />
        )}
        {view.canManage && !view.topLevel && (
          <Inheritance change={change} target={target} view={view} />
        )}
        {folderId && view.canManage && view.isOwner && (
          <Confidential change={change} folderId={folderId} view={view} />
        )}
        {folderId && view.canManage && view.aiOwn && (
          <AiSetting
            change={change}
            folderId={folderId}
            inForce={view.aiMode}
            own={view.aiOwn}
          />
        )}
        {!folderId && (
          <p className="text-muted-foreground text-xs">
            {AI_TEXT[view.aiMode].help}
          </p>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
};
