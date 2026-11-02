import { Badge } from "@repo/design-system/components/ui/badge";
import Link from "next/link";

export const money = (value: { toString(): string } | null) =>
  value === null
    ? "—"
    : Number(value.toString()).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

export const minutes = (value: number) =>
  value >= 60 && value % 60 === 0
    ? `${value / 60} h`
    : `${Number(value.toFixed(2))} min`;

export const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// Where a value came from: an uploaded file, a person, or a Takumo default.
export const ProvenanceBadge = ({
  provenance,
}: {
  provenance: "data" | "stated" | "assumed";
}) => {
  if (provenance === "assumed") {
    return <Badge variant="outline">Needs review</Badge>;
  }
  return provenance === "stated" ? (
    <Badge variant="secondary">Edited</Badge>
  ) : null;
};

/** Records the shop's ERP report keeps up to date: edited there, not here. */
export const ErpBadge = ({ syncedAt }: { syncedAt: Date | null }) =>
  syncedAt ? (
    <Badge
      title={`From your ERP, last synced ${syncedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Change it in your ERP; the next report brings it here.`}
      variant="outline"
    >
      ERP
    </Badge>
  ) : null;

// Form values are strings; empty means "not set".
export const formValue = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? "" : value.toString();

export const EmptyState = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground text-sm">
    {children}
  </div>
);

/** ?q= from a link (e.g. an Ask Takumo citation): a trimmed search term. */
export const textFilter = (q?: string) => q?.trim().slice(0, 100) || null;

export const FilterNote = ({ q, href }: { q: string; href: string }) => (
  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
    Showing matches for <span className="font-medium">“{q}”</span>
    <Link className="ml-auto underline" href={href}>
      Show all
    </Link>
  </div>
);
