"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { ENTITIES, ENTITY_KEYS, type EntityKey } from "@repo/ingest";
import { useState, useTransition } from "react";
import {
  confirmMapping,
  forgetReport,
  setReportStatus,
  suggestForEntity,
} from "./actions";

export interface ReportView {
  columns: Record<string, string | null>;
  entity: EntityKey;
  headers: string[];
  id: string;
  lastImportAt: string | null;
  lastReceivedAt: string | null;
  lastSummary: string | null;
  mode: "full" | "changes";
  name: string;
  /** The confirmed report this is, with columns the ERP renamed. */
  replaces: { changes: string; complete: boolean; name: string } | null;
  /** First rows of the waiting file, by header, to show example values. */
  sample: Record<string, string>[];
  status: "needs_mapping" | "active" | "paused";
  timeUnits: Record<string, "minutes" | "hours">;
  waitingRows: number;
}

const STATUS: Record<
  ReportView["status"],
  { label: string; tone: "default" | "secondary" | "destructive" }
> = {
  needs_mapping: { label: "Needs a check", tone: "destructive" },
  active: { label: "Imports nightly", tone: "default" },
  paused: { label: "Paused", tone: "secondary" },
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";

const SELECT =
  "h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50";

// biome-ignore lint/suspicious/noAlert: a plain confirm is enough here
const confirmForget = (message: string) => window.confirm(message);

/** Confirm a report's columns; what to tell the admin, and whether it failed. */
const confirmAndSay = async (
  input: Parameters<typeof confirmMapping>[0]
): Promise<[string, boolean]> => {
  const r = await confirmMapping(input);
  if (!r.ok) {
    return [r.error, true];
  }
  const res = r.result;
  return [
    res
      ? `Imported: ${res.created} added, ${res.updated} updated, ${res.skipped} skipped${res.closed ? `, ${res.closed} closed` : ""}. Later reports import by themselves.`
      : "Saved. The next report imports by itself.",
    false,
  ];
};

/**
 * The ERP renamed some columns of a report the shop already confirmed:
 * what changed, and one click to keep importing it.
 */
const RenamedNote = ({
  report,
  onDone,
}: {
  report: ReportView;
  onDone: (text: string, error: boolean) => void;
}) => {
  const [pending, start] = useTransition();
  const replaces = report.replaces;
  if (!replaces) {
    return null;
  }
  return (
    <div className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p>
        <span className="font-medium">
          This is {replaces.name} with changed columns:
        </span>{" "}
        {replaces.changes}.
      </p>
      {replaces.complete ? (
        <div>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                onDone(
                  ...(await confirmAndSay({
                    reportId: report.id,
                    mode: report.mode,
                    mapping: {
                      entity: report.entity,
                      columns: report.columns,
                      timeUnits: report.timeUnits,
                    },
                    replace: true,
                  }))
                );
              })
            }
            size="sm"
            type="button"
          >
            {pending && <Spinner />}
            Use the same columns
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          A required column is missing: choose it below.
        </p>
      )}
    </div>
  );
};

/** Which column feeds each field, with an example value from the report. */
const MappingEditor = ({
  report,
  onDone,
}: {
  report: ReportView;
  onDone: (text: string, error: boolean) => void;
}) => {
  const [entity, setEntity] = useState<EntityKey>(report.entity);
  const [columns, setColumns] = useState(report.columns);
  const [timeUnits, setTimeUnits] = useState(report.timeUnits);
  const [mode, setMode] = useState(report.mode);
  const [replace, setReplace] = useState(Boolean(report.replaces));
  const [pending, start] = useTransition();
  const fields = ENTITIES[entity].fields;
  const example = (header: string | null) =>
    header ? (report.sample.find((r) => r[header])?.[header] ?? "") : "";

  return (
    <div className="grid gap-4 rounded-lg border bg-muted/20 p-4">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">This report contains</span>
        <select
          className={SELECT}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value as EntityKey;
            setEntity(next);
            start(async () => {
              const r = await suggestForEntity(report.id, next);
              if (r.ok) {
                setColumns({ ...r.mapping.columns });
                setTimeUnits({ ...r.mapping.timeUnits });
              }
            });
          }}
          value={entity}
        >
          {ENTITY_KEYS.map((key) => (
            <option key={key} value={key}>
              {ENTITIES[key].label}
            </option>
          ))}
        </select>
      </label>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground text-xs">
            <tr>
              <th className="py-1 pr-3 font-medium">Takumo field</th>
              <th className="py-1 pr-3 font-medium">Column in your report</th>
              <th className="py-1 font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr className="border-t" key={field.key}>
                <td className="py-2 pr-3 align-top">
                  {field.label}
                  {field.required && (
                    <span className="text-destructive"> *</span>
                  )}
                </td>
                <td className="py-2 pr-3 align-top">
                  <div className="flex gap-2">
                    <select
                      className={SELECT}
                      disabled={pending}
                      onChange={(e) =>
                        setColumns({
                          ...columns,
                          [field.key]: e.target.value || null,
                        })
                      }
                      value={columns[field.key] ?? ""}
                    >
                      <option value="">— not in this report</option>
                      {report.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {field.kind === "minutes" && columns[field.key] && (
                      <select
                        aria-label={`${field.label} units`}
                        className={`${SELECT} w-28`}
                        disabled={pending}
                        onChange={(e) =>
                          setTimeUnits({
                            ...timeUnits,
                            [field.key]: e.target.value as "minutes" | "hours",
                          })
                        }
                        value={timeUnits[field.key] ?? "minutes"}
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </select>
                    )}
                  </div>
                </td>
                <td className="max-w-48 truncate py-2 align-top text-muted-foreground">
                  {example(columns[field.key] ?? null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="grid gap-2 text-sm">
        <legend className="mb-1 font-medium">Each report lists</legend>
        <label className="flex items-start gap-2">
          <input
            checked={mode === "full"}
            className="mt-1"
            onChange={() => setMode("full")}
            type="radio"
          />
          <span>
            <span className="font-medium">Everything that's open.</span>{" "}
            <span className="text-muted-foreground">
              Orders, purchase orders or stock it no longer lists are closed in
              Takumo (done, received, or zero).
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            checked={mode === "changes"}
            className="mt-1"
            onChange={() => setMode("changes")}
            type="radio"
          />
          <span>
            <span className="font-medium">Only what changed.</span>{" "}
            <span className="text-muted-foreground">
              Nothing is closed when a row is missing.
            </span>
          </span>
        </label>
      </fieldset>

      {report.replaces && (
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={replace}
            className="mt-1"
            onChange={(e) => setReplace(e.target.checked)}
            type="checkbox"
          />
          <span>
            <span className="font-medium">
              This replaces {report.replaces.name}.
            </span>{" "}
            <span className="text-muted-foreground">
              The old one stops being expected; what it imported stays.
            </span>
          </span>
        </label>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              onDone(
                ...(await confirmAndSay({
                  reportId: report.id,
                  mode,
                  mapping: { entity, columns, timeUnits },
                  replace,
                }))
              );
            })
          }
          type="button"
        >
          {pending && <Spinner />}
          {report.waitingRows
            ? `Confirm and import ${report.waitingRows.toLocaleString()} rows`
            : "Save"}
        </Button>
      </div>
    </div>
  );
};

/** One recurring ERP report: what it holds, how it last went, its columns. */
export const ReportRow = ({
  report,
  canManage,
  focused = false,
}: {
  report: ReportView;
  canManage: boolean;
  /** Opened from an email about this report: show its columns. */
  focused?: boolean;
}) => {
  // A renamed report's one click is enough; the columns are there if needed.
  const [open, setOpen] = useState(
    focused || (report.status === "needs_mapping" && !report.replaces?.complete)
  );
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  const status = STATUS[report.status];

  return (
    <li
      className={`grid scroll-mt-4 gap-3 rounded-xl border p-4${focused ? "ring-2 ring-primary/40" : ""}`}
      id={`report-${report.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{report.name}</p>
        <Badge variant={status.tone}>{status.label}</Badge>
        <Badge variant="outline">{ENTITIES[report.entity].label}</Badge>
        {report.status !== "needs_mapping" && (
          <span className="text-muted-foreground text-xs">
            {report.mode === "full" ? "Lists everything open" : "Only changes"}
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        Last received {when(report.lastReceivedAt)} · last imported{" "}
        {when(report.lastImportAt)}
        {report.lastSummary ? ` · ${report.lastSummary}` : ""}
      </p>
      {canManage && !message && (
        <RenamedNote
          onDone={(text, error) => setMessage({ text, error })}
          report={report}
        />
      )}
      {message && (
        <p className={message.error ? "text-destructive text-sm" : "text-sm"}>
          {message.text}
        </p>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setOpen(!open)}
            size="sm"
            type="button"
            variant={report.status === "needs_mapping" ? "default" : "outline"}
          >
            {report.status === "needs_mapping"
              ? "Check columns"
              : "Edit columns"}
          </Button>
          {report.status !== "needs_mapping" && (
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await setReportStatus(
                    report.id,
                    report.status === "paused" ? "active" : "paused"
                  );
                  if (!r.ok) {
                    setMessage({ error: true, text: r.error });
                  }
                })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              {report.status === "paused" ? "Resume" : "Pause"}
            </Button>
          )}
          <Button
            disabled={pending}
            onClick={() =>
              confirmForget(
                `Forget "${report.name}"? Records it already imported stay; the next time it arrives it'll need checking again.`
              ) &&
              start(async () => {
                await forgetReport(report.id);
              })
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            Forget
          </Button>
        </div>
      )}
      {open && canManage && (
        <MappingEditor
          onDone={(text, error) => {
            setMessage({ text, error });
            if (!error) {
              setOpen(false);
            }
          }}
          report={report}
        />
      )}
    </li>
  );
};
