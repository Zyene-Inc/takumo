"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertTriangleIcon, HelpCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { tightestTolerance } from "@/lib/quotes/drawing-check";
import type { DrawingReading, DrawingValue } from "@/lib/quotes/types";
import { mergeRfqLines, splitRfqLine } from "../drawing-actions";
import { useReviewFocus } from "./review-focus";

export interface OtherLine {
  id: string;
  label: string;
}

const where = (v: { sheet: number | null }) =>
  v.sheet ? ` (sheet ${v.sheet})` : "";

const PICK =
  "rounded text-left underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A value read from the drawing, marked when it was hard to read. Click it
 * to see where on the drawing it was read (F2.6-R2).
 */
const Read = ({
  v,
  label,
  lineId,
}: {
  label: string;
  lineId: string;
  v: DrawingValue<unknown> | null | undefined;
}) => {
  const { show } = useReviewFocus();
  if (!v) {
    return null;
  }
  return (
    <button
      className={PICK}
      onClick={() =>
        show({
          lineId,
          sheet: v.sheet,
          box: v.box,
          label: `${label}: ${v.text}`,
        })
      }
      title={`As printed on sheet ${v.sheet}: ${v.text}. Click to see it on the drawing.`}
      type="button"
    >
      {v.text}
      {v.confidence !== "high" && (
        <Badge className="ml-1.5" variant="outline">
          {v.confidence === "low" ? "unclear" : "check"}
        </Badge>
      )}
    </button>
  );
};

/** What Takumo read from the line's drawing, what to check, what to ask. */
export const DrawingSummary = ({
  drawing,
  editable,
  lineId,
  otherLines,
  rfqId,
}: {
  drawing: DrawingReading;
  editable: boolean;
  lineId: string;
  otherLines: OtherLine[];
  rfqId: string;
}) => {
  const router = useRouter();
  const { show } = useReviewFocus();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mergeWith, setMergeWith] = useState("");
  const tight = tightestTolerance(drawing);
  const rows: [string, DrawingValue<unknown> | null | undefined][] = [
    ["Part", drawing.titleBlock.partNo ?? drawing.titleBlock.drawingNo],
    ["Rev", drawing.titleBlock.rev],
    ["Material", drawing.material],
    ["Size", drawing.envelope],
    ["Tightest tolerance", tight],
  ];
  const run = (action: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await action();
      if (r.ok) {
        router.refresh();
      } else {
        setError(r.error ?? "That didn't work.");
      }
    });

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">From the drawing</p>
        <span className="text-muted-foreground text-xs">
          {drawing.fileName}
          {drawing.sheets > 1 ? ` · ${drawing.sheets} sheets` : ""}
          {drawing.units
            ? ` · ${drawing.units === "mm" ? "metric (mm)" : "inches"}`
            : ""}
        </span>
      </div>
      {drawing.sheets > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          {rows
            .filter(([, v]) => v)
            .map(([label, v]) => (
              <div className="flex gap-1.5" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>
                  <Read label={label} lineId={lineId} v={v} />
                </dd>
              </div>
            ))}
          {drawing.finishes.length > 0 && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Finish</dt>
              <dd className="flex flex-wrap gap-x-2">
                {drawing.finishes.map((f) => (
                  <Read
                    key={`${f.sheet}-${f.text}`}
                    label="Finish"
                    lineId={lineId}
                    v={f}
                  />
                ))}
              </dd>
            </div>
          )}
          {drawing.features.length > 0 && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Features</dt>
              <dd className="flex flex-wrap gap-x-2">
                {drawing.features.map((f) => (
                  <Read
                    key={`${f.sheet}-${f.kind}-${f.text}`}
                    label="Feature"
                    lineId={lineId}
                    v={{
                      ...f,
                      text: `${f.count > 1 ? `${f.count}× ` : ""}${f.text}`,
                    }}
                  />
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      {drawing.flags.length > 0 && (
        <div className="grid gap-1">
          <p className="font-medium text-xs uppercase tracking-wide">
            Check this
          </p>
          {drawing.flags.map((f) => (
            <button
              className={`flex gap-2 text-amber-700 dark:text-amber-400 ${PICK} no-underline`}
              key={`${f.kind}-${f.message}`}
              onClick={() =>
                show({ lineId, sheet: f.sheet, box: f.box, label: f.message })
              }
              type="button"
            >
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {f.message}
                <span className="text-muted-foreground">{where(f)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {drawing.questions.length > 0 && (
        <div className="grid gap-1">
          <p className="font-medium text-xs uppercase tracking-wide">
            Ask the customer
          </p>
          {drawing.questions.map((q) => (
            <div className="flex gap-2" key={q}>
              <HelpCircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              {q}
            </div>
          ))}
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={pending}
            onClick={() => run(() => splitRfqLine(rfqId, lineId))}
            size="sm"
            variant="outline"
          >
            Split into two lines
          </Button>
          {otherLines.length > 0 && (
            <>
              <select
                aria-label="Line to merge into this one"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                disabled={pending}
                onChange={(e) => setMergeWith(e.target.value)}
                value={mergeWith}
              >
                <option value="">Merge another line into this one…</option>
                {otherLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <Button
                disabled={pending || !mergeWith}
                onClick={() =>
                  run(() => mergeRfqLines(rfqId, lineId, mergeWith))
                }
                size="sm"
                variant="outline"
              >
                Merge
              </Button>
            </>
          )}
          {error && <span className="text-destructive">{error}</span>}
        </div>
      )}
    </div>
  );
};
