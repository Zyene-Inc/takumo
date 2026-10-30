"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** A form's submit button that shows it's working (making a shop takes a few seconds). */
export const SubmitButton = ({
  children,
  pendingText,
  variant,
}: {
  children: ReactNode;
  pendingText: string;
  variant?: "default" | "outline";
}) => {
  const { pending } = useFormStatus();
  return (
    <Button disabled={pending} type="submit" variant={variant}>
      {pending ? (
        <>
          <Spinner /> {pendingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
};
