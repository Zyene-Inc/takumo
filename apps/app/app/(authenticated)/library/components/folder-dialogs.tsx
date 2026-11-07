"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { FolderPlusIcon, MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  createFolder,
  deleteFolder,
  moveFolder,
  renameFolder,
} from "../actions";
import { Confirm, returnFocusTo } from "./confirm";
import { type FolderChoice, MoveDialog } from "./move-dialog";

const MAX_NAME = 120;

/** Ask for a folder name (new folder, or renaming one). */
const NameDialog = ({
  action,
  initial = "",
  onOpenChange,
  onSave,
  open,
  returnFocus,
  title,
  trigger,
}: {
  action: string;
  initial?: string;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => Promise<{ ok: boolean; error?: string }>;
  open: boolean;
  /** Where focus goes when it closes, when not opened by `trigger`. */
  returnFocus?: RefObject<HTMLElement | null>;
  title: string;
  /** The button that opens it (focus returns there when it closes). */
  trigger?: ReactNode;
}) => {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      const result = await onSave(name);
      if (result.ok) {
        setError(null);
        onOpenChange(false);
      } else {
        setError(result.error ?? "That didn't work. Try again.");
      }
    });
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          setName(initial);
          setError(null);
        }
        onOpenChange(next);
      }}
      open={open}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent onCloseAutoFocus={returnFocusTo(returnFocus)}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Everyone in the company can see what's in it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              aria-describedby={error ? "folder-name-error" : undefined}
              aria-invalid={Boolean(error)}
              autoFocus
              id="folder-name"
              maxLength={MAX_NAME}
              onChange={(e) => setName(e.target.value)}
              value={name}
            />
            {error && (
              <p
                className="text-destructive text-sm"
                id="folder-name-error"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={pending || !name.trim()} type="submit">
              {pending && <Spinner />} {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** "New folder" here (a subfolder, or a top-level folder). */
export const NewFolderButton = ({ parentId }: { parentId: string | null }) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <NameDialog
      action="Create"
      onOpenChange={setOpen}
      onSave={async (name) => {
        const result = await createFolder(parentId, name);
        if (result.ok) {
          toast.success(`Created ${name.trim()}.`);
          router.push(`/library/f/${result.id}`);
        }
        return result;
      }}
      open={open}
      title="New folder"
      trigger={
        <Button size="sm" variant="outline">
          <FolderPlusIcon /> New folder
        </Button>
      }
    />
  );
};

type Open = "rename" | "move" | "delete" | null;

/** A folder's actions: rename, move, delete (only when it's empty). */
export const FolderMenu = ({
  choices,
  folder,
  onDeletedHref,
}: {
  choices: FolderChoice[];
  folder: { id: string; name: string; parentId: string | null };
  /** Where to go after deleting it (when looking at it). */
  onDeletedHref?: string;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for folder ${folder.name}`}
            disabled={pending}
            ref={trigger}
            size="icon"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen("rename")}>
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("move")}>
            Move to…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setOpen("delete")}
            variant="destructive"
          >
            Delete folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        action="Rename"
        initial={folder.name}
        onOpenChange={(next) => setOpen(next ? "rename" : null)}
        onSave={async (name) => {
          const result = await renameFolder(folder.id, name);
          if (result.ok) {
            toast.success(`Renamed to ${name.trim()}.`);
            router.refresh();
          }
          return result;
        }}
        open={open === "rename"}
        returnFocus={trigger}
        title={`Rename ${folder.name}`}
      />
      <MoveDialog
        choices={choices}
        current={folder.parentId}
        movingFolderId={folder.id}
        name={folder.name}
        onMove={(target) => moveFolder(folder.id, target)}
        onOpenChange={(next) => setOpen(next ? "move" : null)}
        open={open === "move"}
        returnFocus={trigger}
      />
      <Confirm
        action="Delete folder"
        danger
        onConfirm={() =>
          start(async () => {
            const result = await deleteFolder(folder.id);
            if (result.ok) {
              toast.success(`Deleted ${folder.name}.`);
              if (onDeletedHref) {
                router.push(onDeletedHref);
              } else {
                router.refresh();
              }
            } else {
              toast.error(result.error);
            }
          })
        }
        onOpenChange={(next) => setOpen(next ? "delete" : null)}
        open={open === "delete"}
        returnFocus={trigger}
        title={`Delete ${folder.name}?`}
      >
        <p>Only empty folders can be deleted.</p>
      </Confirm>
    </>
  );
};
