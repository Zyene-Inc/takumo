"use client";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  type parseRows,
  type TimeUnit,
} from "@repo/ingest";
import { MatchStatus, show, showValue } from "./import-parts";
import type { Sheet } from "./read-file";

const NONE = "__none__";
const PREVIEW_ROWS = 5;

export const ImportMapping = ({
  allowedEntities,
  importing,
  mapping,
  missing,
  notAllowed,
  preview,
  runImport,
  setColumn,
  setTimeUnit,
  sheet,
  skippedRows,
  suggesting,
  suggestFor,
  fileName,
}: {
  allowedEntities: readonly EntityKey[];
  fileName: string;
  importing: boolean;
  mapping: ColumnMapping;
  missing: string[];
  notAllowed: boolean;
  preview: ReturnType<typeof parseRows> | null;
  runImport: () => void;
  setColumn: (field: string, column: string) => void;
  setTimeUnit: (field: string, unit: TimeUnit) => void;
  sheet: Sheet;
  skippedRows: number;
  suggestFor: (name: string, target: Sheet, entity?: EntityKey) => void;
  suggesting: boolean;
}) => (
  <>
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm">This sheet contains</span>
      <Select
        onValueChange={(value) =>
          suggestFor(fileName, sheet, value as EntityKey)
        }
        value={mapping.entity}
      >
        <SelectTrigger className="w-60">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowedEntities.map((key) => (
            <SelectItem key={key} value={key}>
              {ENTITIES[key].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <MatchStatus source={mapping.source} suggesting={suggesting} />
    </div>

    {mapping.notes && mapping.notes.length > 0 && (
      <ul className="list-disc pl-5 text-muted-foreground text-sm">
        {mapping.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    )}

    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-56">Takumo field</TableHead>
            <TableHead className="w-72">Column in your file</TableHead>
            <TableHead>First value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ENTITIES[mapping.entity].fields.map((field) => {
            const column = mapping.columns[field.key];
            const confidence = mapping.confidence[field.key] ?? 0;
            const firstValue = column
              ? show(sheet.rows.find((r) => show(r[column]) !== "")?.[column])
              : "";
            return (
              <TableRow key={field.key}>
                <TableCell>
                  <div className="font-medium">
                    {field.label}
                    {field.required && (
                      <span className="text-destructive"> *</span>
                    )}
                  </div>
                  {field.hint && (
                    <div className="text-muted-foreground text-xs">
                      {field.hint}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Select
                      onValueChange={(value) => setColumn(field.key, value)}
                      value={column ?? NONE}
                    >
                      <SelectTrigger className="w-56" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>
                          — Not in this file —
                        </SelectItem>
                        {sheet.headers.map((header) => (
                          <SelectItem key={header} value={header}>
                            {header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {column && confidence < 0.8 && (
                      <Badge variant="outline">Check</Badge>
                    )}
                  </div>
                  {field.kind === "minutes" && column && (
                    <Select
                      onValueChange={(value) =>
                        setTimeUnit(field.key, value as TimeUnit)
                      }
                      value={mapping.timeUnits[field.key] ?? "minutes"}
                    >
                      <SelectTrigger className="mt-2 w-56" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">
                          Values are in minutes
                        </SelectItem>
                        <SelectItem value="hours">
                          Values are in hours
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
                <TableCell className="max-w-64 truncate text-muted-foreground">
                  {firstValue}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>

    {preview && (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          <span className="font-medium">
            {preview.records.length.toLocaleString()} rows ready to import
          </span>
          {skippedRows > 0 && (
            <span className="text-destructive">
              {" "}
              · {skippedRows} will be skipped
            </span>
          )}
          {preview.blankRows > 0 && (
            <span className="text-muted-foreground">
              {" "}
              · {preview.blankRows} empty rows ignored
            </span>
          )}
        </p>

        {preview.errors.length > 0 && (
          <div className="max-h-48 overflow-auto rounded-lg bg-muted/50 p-3 text-sm">
            {preview.errors.slice(0, 50).map((e) => (
              <div key={`${e.row}-${e.field}`}>
                <span
                  className={e.severity === "error" ? "text-destructive" : ""}
                >
                  Row {e.row}
                </span>{" "}
                · {e.field}: {e.message}
                {e.severity === "warning" ? " (left blank)" : " (row skipped)"}
              </div>
            ))}
            {preview.errors.length > 50 && (
              <div className="text-muted-foreground">
                …and {preview.errors.length - 50} more
              </div>
            )}
          </div>
        )}

        {preview.records.length > 0 && (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  {ENTITIES[mapping.entity].fields
                    .filter((f) => mapping.columns[f.key])
                    .map((f) => (
                      <TableHead key={f.key}>{f.label}</TableHead>
                    ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.records.slice(0, PREVIEW_ROWS).map((record) => (
                  <TableRow key={record.row}>
                    {ENTITIES[mapping.entity].fields
                      .filter((f) => mapping.columns[f.key])
                      .map((f) => (
                        <TableCell key={f.key}>
                          {showValue(record.values[f.key])}
                        </TableCell>
                      ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    )}

    <div className="flex items-center gap-3">
      <Button
        disabled={
          importing ||
          suggesting ||
          missing.length > 0 ||
          notAllowed ||
          !preview ||
          preview.records.length === 0
        }
        onClick={runImport}
      >
        {importing && <Spinner />}
        Import {preview?.records.length.toLocaleString() ?? 0}{" "}
        {ENTITIES[mapping.entity].label.toLowerCase()}
      </Button>
      {missing.length > 0 && (
        <span className="text-destructive text-sm">
          Choose a column for: {missing.join(", ")}
        </span>
      )}
      {notAllowed && (
        <span className="text-destructive text-sm">
          Your role can't import {ENTITIES[mapping.entity].label.toLowerCase()}.
          Pick another sheet type, or ask an admin.
        </span>
      )}
    </div>
  </>
);
