import type { PoStatus } from "@/lib/orders/types";

export const PO_STATUS_VARIANT: Record<
  PoStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  reading: "outline",
  review: "default",
  entered: "secondary",
  rejected: "outline",
  failed: "destructive",
};
