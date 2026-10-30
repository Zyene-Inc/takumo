"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteRecord } from "../actions";

interface DeleteButtonProps {
  readonly entity: "workCenters" | "parts" | "routings" | "orders";
  readonly id: string;
  readonly name: string;
  // Where to go after deleting, e.g. back to the list from a detail page.
  readonly redirectTo?: string;
}

export const DeleteButton = ({
  entity,
  id,
  name,
  redirectTo,
}: DeleteButtonProps) => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [deleting, startDeleting] = useTransition();

  return (
    <AlertDialog onOpenChange={() => setError(null)}>
      <AlertDialogTrigger asChild>
        <Button aria-label={`Delete ${name}`} size="icon" variant="ghost">
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {error ?? "This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            onClick={(e) => {
              e.preventDefault();
              startDeleting(async () => {
                const result = await deleteRecord(entity, id);
                if (result.ok) {
                  if (redirectTo) {
                    router.push(redirectTo);
                  }
                  router.refresh();
                } else {
                  setError(result.errors.join(" "));
                }
              });
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
