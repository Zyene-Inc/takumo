"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  type ColumnMapping,
  ENTITY_KEYS,
  type EntityKey,
  parseRows,
  suggestMapping,
  type TimeUnit,
} from "@repo/ingest";
import { UploadIcon } from "lucide-react";
import { useMemo, useRef, useState, useTransition } from "react";
import { type ImportResult, importSheet, suggestColumns } from "./actions";
import { ImportMapping } from "./import-mapping";
import { FileBar, ImportDone, mappingChecks } from "./import-parts";
import { ACCEPTED_FILES, readWorkbook, type Sheet } from "./read-file";

const NONE = "__none__";

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

  const { missing, notAllowed, skippedRows } = mappingChecks(
    mapping,
    preview,
    allowedEntities
  );

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
    return (
      <ImportDone
        entity={mapping.entity}
        fileName={fileName}
        onAgain={reset}
        result={result}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {!sheet && (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a drop zone; the file input inside it is the keyboard-accessible control.
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
            Excel (.xlsx or .xls) or CSV: an ERP export or your own tracker
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
        <FileBar
          fileName={fileName}
          onPick={(index) => {
            setSheetIndex(index);
            suggestFor(fileName, sheets[index]);
          }}
          onReset={reset}
          sheet={sheet}
          sheetIndex={sheetIndex}
          sheets={sheets}
        />
      )}

      {sheet && !mapping && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner /> Takumo is reading the columns…
        </div>
      )}

      {sheet && mapping && (
        <ImportMapping
          allowedEntities={allowedEntities}
          fileName={fileName}
          importing={importing}
          mapping={mapping}
          missing={missing}
          notAllowed={notAllowed}
          preview={preview}
          runImport={runImport}
          setColumn={setColumn}
          setTimeUnit={setTimeUnit}
          sheet={sheet}
          skippedRows={skippedRows}
          suggestFor={suggestFor}
          suggesting={suggesting}
        />
      )}
    </div>
  );
};
