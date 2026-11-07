"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { purgedMessage } from "@/lib/library/format";
import type { DocumentRow } from "@/lib/library/rows";
import {
  deleteDocument,
  purgeDocument,
  restoreDocument,
} from "../../knowledge/actions";
import { moveDocument } from "../actions";
import { Confirm } from "./confirm";
import { type FolderChoice, MoveDialog } from "./move-dialog";

type Dialog = "move" | "trash" | "purge" | null;

/** A document's actions: open, download, move, Trash, restore, delete for good. */
export const DocumentMenu = ({
  choices,
  document: d,
}: {
  choices: FolderChoice[];
  document: DocumentRow;
}) => {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  const trashed = d.deletedAt !== null;

  const run = (
    work: () => Promise<{ ok: boolean; error?: string } & object>,
    success: (result: object) => string
  ) =>
    start(async () => {
      const result = await work();
      if (result.ok) {
        toast.success(success(result));
        router.refresh();
      } else {
        toast.error(result.error ?? "That didn't work. Try again.");
      }
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${d.name}`}
            disabled={pending}
            ref={trigger}
            size="icon"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/library/d/${d.id}`}>Open</Link>
          </DropdownMenuItem>
          {!trashed && d.current?.originalKept && (
            <DropdownMenuItem asChild>
              <a href={`/api/library/documents/${d.id}/file?download=1`}>
                Download
              </a>
            </DropdownMenuItem>
          )}
          {!trashed && d.canEdit && (
            <DropdownMenuItem onSelect={() => setDialog("move")}>
              Move to…
            </DropdownMenuItem>
          )}
          {!trashed && d.canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setDialog("trash")}
                variant="destructive"
              >
                Move to Trash
              </DropdownMenuItem>
            </>
          )}
          {trashed && d.canDelete && (
            <DropdownMenuItem
              onSelect={() =>
                run(
                  () => restoreDocument(d.id),
                  (r) => `Restored as ${(r as { name: string }).name}.`
                )
              }
            >
              Restore
            </DropdownMenuItem>
          )}
          {trashed && d.canPurge && (
            <DropdownMenuItem
              onSelect={() => setDialog("purge")}
              variant="destructive"
            >
              Delete permanently…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <MoveDialog
        choices={choices}
        current={d.folder?.id ?? null}
        name={d.name}
        onMove={(target) => moveDocument(d.id, target)}
        onOpenChange={(open) => setDialog(open ? "move" : null)}
        open={dialog === "move"}
        returnFocus={trigger}
      />
      <Confirm
        action="Move to Trash"
        onConfirm={() =>
          run(
            () => deleteDocument(d.id),
            () => `${d.name} is in the Trash.`
          )
        }
        onOpenChange={(open) => setDialog(open ? "trash" : null)}
        open={dialog === "trash"}
        returnFocus={trigger}
        title={`Move ${d.name} to the Trash?`}
      >
        <p>
          It stops appearing in the library, in search and in Ask Takumo's
          document search. You can restore it from the Trash.
        </p>
        <p>
          Facts already proposed from it stay under Knowledge → Facts until
          they're reviewed.
        </p>
      </Confirm>
      <Confirm
        action="Delete permanently"
        danger
        onConfirm={() =>
          run(
            () => purgeDocument(d.id),
            (r) => purgedMessage(d.name, (r as { complete: boolean }).complete)
          )
        }
        onOpenChange={(open) => setDialog(open ? "purge" : null)}
        open={dialog === "purge"}
        returnFocus={trigger}
        title={`Delete ${d.name} permanently?`}
      >
        <p>
          This can't be undone. Every version, its text, the facts that came
          only from it and the saved answers that used it are removed.
        </p>
        <p>
          Approved facts keep their values (they may already be in your records)
          but lose the quote from this document.
        </p>
      </Confirm>
    </>
  );
};
