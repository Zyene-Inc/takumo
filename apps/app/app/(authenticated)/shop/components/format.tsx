import { Badge } from "@repo/design-system/components/ui/badge";

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
}) =>
  provenance === "assumed" ? (
    <Badge variant="outline">Needs review</Badge>
  ) : provenance === "stated" ? (
    <Badge variant="secondary">Edited</Badge>
  ) : null;

// Form values are strings; empty means "not set".
export const formValue = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? "" : value.toString();

export const EmptyState = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground text-sm">
    {children}
  </div>
);
