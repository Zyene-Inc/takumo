import type { RfqStatus } from "@/lib/quotes/types";

export const STATUS_VARIANT: Record<
  RfqStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  reading: "outline",
  review: "secondary",
  drafted: "default",
  quoted: "secondary",
  won: "default",
  lost: "outline",
  declined: "outline",
  failed: "destructive",
};
