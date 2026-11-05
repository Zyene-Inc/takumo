"use client";

// Pieces of the import wizard: the chosen file, match status, checks and the done view.

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  type Cell,
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  missingRequired,
  type parseRows,
} from "@repo/ingest";
import { FileSpreadsheetIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import type { ImportResult } from "./actions";
import type { Sheet } from "./read-file";

export const SHOP_LINKS: Partial<Record<EntityKey, string>> = {
  workCenters: "/shop/work-centers",
  parts: "/shop/parts",
  routings: "/shop/parts",
  orders: "/shop/orders",
};

export const show = (cell: Cell) => {
  if (cell === null || cell === undefined) {
    return "";
  }
  if (cell instanceof Date) {
    return cell.toISOString().slice(0, 10);
  }
  return String(cell);
};

export const showValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value === null ? "" : String(value);
};

/** What an import did, with the next steps. */
export const ImportDone = ({
  entity,
  fileName,
  onAgain,
  result,
}: {
  entity: EntityKey;
  fileName: string;
  onAgain: () => void;
  result: ImportResult;
}) => {
  const link = SHOP_LINKS[entity];
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <FileSpreadsheetIcon />
        <AlertTitle>
          Imported {ENTITIES[entity].label.toLowerCase()} from {fileName}
        </AlertTitle>
        <AlertDescription>
          {result.created} added · {result.updated} updated
          {result.skipped > 0 ? ` · ${result.skipped} skipped` : ""}
        </AlertDescription>
      </Alert>
      {result.notes.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground text-sm">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button onClick={onAgain}>Upload another file</Button>
        {link && (
          <Button asChild variant="outline">
            <Link href={link}>Review what was imported</Link>
          </Button>
        )}
      </div>
    </div>
  );
};

/** Required fields not mapped, a sheet type this role can't import, rows to skip. */
export const mappingChecks = (
  mapping: ColumnMapping | null,
  preview: ReturnType<typeof parseRows> | null,
  allowed: readonly EntityKey[]
) => ({
  missing: mapping ? missingRequired(mapping) : [],
  notAllowed: mapping ? !allowed.includes(mapping.entity) : false,
  skippedRows: preview
    ? new Set(
        preview.errors.filter((e) => e.severity === "error").map((e) => e.row)
      ).size
    : 0,
});

/** The chosen file: its size, which sheet to read, and a way to start over. */
export const FileBar = ({
  fileName,
  onPick,
  onReset,
  sheet,
  sheetIndex,
  sheets,
}: {
  fileName: string;
  onPick: (index: number) => void;
  onReset: () => void;
  sheet: Sheet;
  sheetIndex: number;
  sheets: Sheet[];
}) => (
  <div className="flex flex-wrap items-center gap-3">
    <FileSpreadsheetIcon className="size-5 text-muted-foreground" />
    <span className="font-medium">{fileName}</span>
    <span className="text-muted-foreground text-sm">
      {sheet.rows.length.toLocaleString()} rows · {sheet.headers.length} columns
    </span>
    {sheets.length > 1 && (
      <Select
        onValueChange={(value) => onPick(Number(value))}
        value={String(sheetIndex)}
      >
        <SelectTrigger className="w-48" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sheets.map((s, i) => (
            <SelectItem key={s.name} value={String(i)}>
              Sheet: {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )}
    <Button onClick={onReset} size="sm" variant="ghost">
      Choose a different file
    </Button>
  </div>
);

/** Whether the columns are still being matched, or were matched by Takumo. */
export const MatchStatus = ({
  source,
  suggesting,
}: {
  source: ColumnMapping["source"];
  suggesting: boolean;
}) => {
  if (suggesting) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner /> Matching columns…
      </span>
    );
  }
  return source === "ai" ? (
    <Badge variant="secondary">
      <SparklesIcon /> Matched by Takumo AI
    </Badge>
  ) : null;
};
