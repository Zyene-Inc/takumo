"use client";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  type Cell,
  type ColumnMapping,
  ENTITIES,
  ENTITY_KEYS,
  type EntityKey,
  missingRequired,
  parseRows,
  suggestMapping,
  type TimeUnit,
} from "@repo/ingest";
import { FileSpreadsheetIcon, SparklesIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { type ImportResult, importSheet, suggestColumns } from "./actions";
import { ACCEPTED_FILES, readWorkbook, type Sheet } from "./read-file";

const NONE = "__none__";
const PREVIEW_ROWS = 5;

const SHOP_LINKS: Partial<Record<EntityKey, string>> = {
  workCenters: "/shop/work-centers",
  parts: "/shop/parts",
  routings: "/shop/parts",
  orders: "/shop/orders",
};

const show = (cell: Cell) => {
  if (cell === null || cell === undefined) {
    return "";
  }
  if (cell instanceof Date) {
    return cell.toISOString().slice(0, 10);
  }
  return String(cell);
};

const showValue = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : value === null ? "" : String(value);

export const ImportWizard = ({
  initialEntity,
  allowedEntities = ENTITY_KEYS,
}: {
  initialEntity?: EntityKey;
  // Sheet types this user's role may import.
  allowedEntities?: readonly EntityKey[];
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [suggesting, startSuggesting] = useTransition();
  const [importing, startImporting] = useTransition();

  const sheet = sheets[sheetIndex];

  const onFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setError(null);
    setResult(null);
    setMapping(null);
    try {
      const read = await readWorkbook(file);
      if (read.length === 0) {
        setError("That file has no rows to import.");
        return;
      }
      setFileName(file.name);
      setSheets(read);
      setSheetIndex(0);
      suggestFor(file.name, read[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };

  // Shows an instant offline guess (when the sheet type is known), then the
  // AI's suggestion replaces it. The file name is passed explicitly because
  // state set in onFile isn't visible yet.
  const suggestFor = (name: string, target: Sheet, entity?: EntityKey) => {
    const offline = suggestMapping(
      entity ?? initialEntity ?? "workCenters",
      target.headers
    );
    setMapping(entity || initialEntity ? offline : null);
    startSuggesting(async () => {
      try {
        setMapping(
          await suggestColumns({
            fileName: name,
            sheetName: target.name,
            headers: target.headers,
            sampleRows: target.rows.slice(0, 8),
            entity: entity ?? initialEntity,
          })
        );
      } catch {
        setMapping(offline);
      }
    });
  };

  const preview = useMemo(
    () =>
      sheet && mapping ? parseRows(sheet.rows, mapping, sheet.firstRow) : null,
    [sheet, mapping]
  );

  const missing = mapping ? missingRequired(mapping) : [];
  const notAllowed = mapping
    ? !allowedEntities.includes(mapping.entity)
    : false;
  const skippedRows = preview
    ? new Set(
        preview.errors.filter((e) => e.severity === "error").map((e) => e.row)
      ).size
    : 0;

  const setColumn = (field: string, column: string) => {
    if (!mapping) {
      return;
    }
    setMapping({
      ...mapping,
      columns: { ...mapping.columns, [field]: column === NONE ? null : column },
      confidence: { ...mapping.confidence, [field]: 1 },
    });
  };

  const setTimeUnit = (field: string, unit: TimeUnit) => {
    if (mapping) {
      setMapping({
        ...mapping,
        timeUnits: { ...mapping.timeUnits, [field]: unit },
      });
    }
  };

  const reset = () => {
    setSheets([]);
    setMapping(null);
    setResult(null);
    setError(null);
    setFileName("");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const runImport = () => {
    if (!(sheet && mapping)) {
      return;
    }
    startImporting(async () => {
      const outcome = await importSheet({
        fileName,
        sheetName: sheet.name,
        mapping,
        rows: sheet.rows,
        firstRow: sheet.firstRow,
      });
      if (outcome.ok) {
        setResult(outcome);
      } else {
        setError(outcome.message ?? "Import failed.");
      }
    });
  };

  if (result && mapping) {
    const link = SHOP_LINKS[mapping.entity];
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <FileSpreadsheetIcon />
          <AlertTitle>
            Imported {ENTITIES[mapping.entity].label.toLowerCase()} from{" "}
            {fileName}
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
          <Button onClick={reset}>Upload another file</Button>
          {link && (
            <Button asChild variant="outline">
              <Link href={link}>Review what was imported</Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {!sheet && (
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center hover:bg-muted/50"
          htmlFor="shop-file"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files[0]);
          }}
        >
          <UploadIcon className="size-6 text-muted-foreground" />
          <span className="font-medium">
            Drop a spreadsheet here, or click to choose
          </span>
          <span className="text-muted-foreground text-sm">
            Excel (.xlsx) or CSV: an ERP export or your own tracker
          </span>
          <input
            accept={ACCEPTED_FILES}
            className="sr-only"
            id="shop-file"
            onChange={(e) => onFile(e.target.files?.[0])}
            ref={inputRef}
            type="file"
          />
        </label>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't import</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {sheet && (
        <div className="flex flex-wrap items-center gap-3">
          <FileSpreadsheetIcon className="size-5 text-muted-foreground" />
          <span className="font-medium">{fileName}</span>
          <span className="text-muted-foreground text-sm">
            {sheet.rows.length.toLocaleString()} rows · {sheet.headers.length}{" "}
            columns
          </span>
          {sheets.length > 1 && (
            <Select
              onValueChange={(value) => {
                const index = Number(value);
                setSheetIndex(index);
                suggestFor(fileName, sheets[index]);
              }}
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
          <Button onClick={reset} size="sm" variant="ghost">
            Choose a different file
          </Button>
        </div>
      )}

      {sheet && !mapping && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner /> Takumo is reading the columns…
        </div>
      )}

      {sheet && mapping && (
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
            {suggesting ? (
              <span className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner /> Matching columns…
              </span>
            ) : (
              mapping.source === "ai" && (
                <Badge variant="secondary">
                  <SparklesIcon /> Matched by Takumo AI
                </Badge>
              )
            )}
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
                    ? show(
                        sheet.rows.find((r) => show(r[column]) !== "")?.[column]
                      )
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
                            onValueChange={(value) =>
                              setColumn(field.key, value)
                            }
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
                        className={
                          e.severity === "error" ? "text-destructive" : ""
                        }
                      >
                        Row {e.row}
                      </span>{" "}
                      · {e.field}: {e.message}
                      {e.severity === "warning"
                        ? " (left blank)"
                        : " (row skipped)"}
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
                Your role can't import{" "}
                {ENTITIES[mapping.entity].label.toLowerCase()}. Pick another
                sheet type, or ask an admin.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
};
