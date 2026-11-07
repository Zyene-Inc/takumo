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
} from "@repo/design-system/components/ui/alert-dialog";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import type { ReactNode, RefObject } from "react";

/** Closing a dialog opened from a menu: focus goes back to the menu's button. */
export const returnFocusTo =
  (ref?: RefObject<HTMLElement | null>) => (event: Event) => {
    if (ref?.current?.isConnected) {
      event.preventDefault();
      ref.current.focus();
    }
  };

/** Ask before doing something that changes or removes a document. */
export const Confirm = ({
  action,
  children,
  danger = false,
  onConfirm,
  onOpenChange,
  open,
  returnFocus,
  title,
}: {
  action: string;
  children: ReactNode;
  danger?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  title: string;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent onCloseAutoFocus={returnFocusTo(returnFocus)}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="grid gap-2">{children}</div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          className={
            danger ? buttonVariants({ variant: "destructive" }) : undefined
          }
          onClick={onConfirm}
        >
          {action}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
