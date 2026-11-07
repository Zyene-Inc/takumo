"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { type RefObject, useState, useTransition } from "react";
import { returnFocusTo } from "./confirm";

export interface FolderChoice {
  id: string;
  label: string;
  /** Folder ids from the top down to this one. */
  path: string[];
}

const TOP = "__top__";

/**
 * Choose where a document or folder goes. Folders can't go inside
 * themselves, so a folder's own subtree isn't offered.
 */
export const MoveDialog = ({
  choices,
  current,
  movingFolderId,
  name,
  onMove,
  onOpenChange,
  open,
  returnFocus,
}: {
  choices: FolderChoice[];
  /** Where it is now (null: the top level). */
  current: string | null;
  movingFolderId?: string;
  name: string;
  onMove: (target: string | null) => Promise<{ ok: boolean; error?: string }>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
}) => {
  const router = useRouter();
  const [target, setTarget] = useState<string>(current ?? TOP);
  const [pending, start] = useTransition();
  const offered = choices.filter(
    (c) => !(movingFolderId && c.path.includes(movingFolderId))
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent onCloseAutoFocus={returnFocusTo(returnFocus)}>
        <DialogHeader>
          <DialogTitle>Move {name}</DialogTitle>
          <DialogDescription>
            Everyone in the company can still see it after it moves.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="move-target">Move to</Label>
          <Select onValueChange={setTarget} value={target}>
            <SelectTrigger className="w-full" id="move-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOP}>Top level (no folder)</SelectItem>
              {offered.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={pending || target === (current ?? TOP)}
            onClick={() =>
              start(async () => {
                const result = await onMove(target === TOP ? null : target);
                if (result.ok) {
                  toast.success(`Moved ${name}.`);
                  onOpenChange(false);
                  router.refresh();
                } else {
                  toast.error(result.error ?? "That didn't work. Try again.");
                }
              })
            }
          >
            {pending && <Spinner />} Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
