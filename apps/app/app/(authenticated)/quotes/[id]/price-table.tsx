"use client";

// The price per quantity break, with the estimator's edits.

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import type { QuoteBreak } from "@repo/engine-client/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LineFinal } from "@/lib/quotes/types";
import type { LineView } from "@/lib/quotes/view";
import { saveFinal } from "../actions";
import { pct, usd } from "./line-card-parts";

export interface PriceInput {
  leadTimeDays: string;
  unitPrice: string;
}

/** What a price input shows: the estimator's value, else the draft's. */
export const inputValue = (sent: number | undefined, draft: number | null) => {
  if (sent !== undefined) {
    return String(sent);
  }
  return draft === null ? "" : String(draft);
};

export const PriceRow = ({
  b,
  v,
  editable,
  requestedDate,
  onChange,
}: {
  b: QuoteBreak;
  editable: boolean;
  onChange: (patch: Partial<PriceInput>) => void;
  requestedDate: string | null;
  v: PriceInput;
}) => {
  const unit = Number(v.unitPrice);
  const total = unit > 0 ? unit * b.qty : null;
  const margin = total && b.cost !== null ? (total - b.cost) / total : null;
  const changed =
    b.unit_price !== null && unit > 0 && Math.abs(unit - b.unit_price) >= 0.005;
  return (
    <TableRow>
      <TableCell className="text-right font-medium">
        {b.qty.toLocaleString()}
      </TableCell>
      <TableCell className="text-right">{usd(b.unit_cost)}</TableCell>
      <TableCell className="text-right">
        {usd(b.unit_price)}
        {b.price_low !== null &&
          b.price_high !== null &&
          b.price_low !== b.price_high && (
            <p className="text-muted-foreground text-xs">
              {usd(b.price_low / b.qty)}–{usd(b.price_high / b.qty)}
            </p>
          )}
      </TableCell>
      <TableCell className="text-right">
        {editable ? (
          <Input
            aria-label={`Unit price for ${b.qty}`}
            className={cn(
              "ml-auto h-8 w-24 text-right",
              changed && "border-amber-500"
            )}
            inputMode="decimal"
            min={0}
            onChange={(e) => onChange({ unitPrice: e.target.value })}
            step="0.01"
            type="number"
            value={v.unitPrice}
          />
        ) : (
          usd(unit || null)
        )}
      </TableCell>
      <TableCell className="text-right">{usd(total)}</TableCell>
      <TableCell
        className={cn(
          "text-right",
          margin !== null && margin < 0.1 && "text-destructive"
        )}
      >
        {pct(margin)}
      </TableCell>
      <TableCell className="text-right">
        {b.lead_time_days === null ? "—" : `${b.lead_time_days} d`}
        {b.meets_requested !== null && requestedDate && (
          <p
            className={cn(
              "text-xs",
              b.meets_requested ? "text-emerald-600" : "text-destructive"
            )}
          >
            {b.meets_requested ? "meets" : "misses"} {requestedDate.slice(5)}
          </p>
        )}
      </TableCell>
      <TableCell className="text-right">
        {editable ? (
          <Input
            aria-label={`Lead time in days for ${b.qty}`}
            className="ml-auto h-8 w-20 text-right"
            inputMode="numeric"
            min={0}
            onChange={(e) => onChange({ leadTimeDays: e.target.value })}
            step={1}
            type="number"
            value={v.leadTimeDays}
          />
        ) : (
          `${v.leadTimeDays || "—"} d`
        )}
      </TableCell>
    </TableRow>
  );
};

export const PriceTable = ({
  line,
  rfqId,
  editable,
  requestedDate,
}: {
  editable: boolean;
  line: LineView;
  requestedDate: string | null;
  rfqId: string;
}) => {
  const router = useRouter();
  const draft = line.draft;
  const breaks = draft?.response.breaks ?? [];
  const initial = () =>
    Object.fromEntries(
      breaks.map((b) => {
        const sent = line.sendFinal?.breaks.find((s) => s.qty === b.qty);
        return [
          b.qty,
          {
            unitPrice: inputValue(sent?.unitPrice, b.unit_price),
            leadTimeDays: inputValue(sent?.leadTimeDays, b.lead_time_days),
          },
        ];
      })
    );
  const [values, setValues] =
    useState<Record<number, { leadTimeDays: string; unitPrice: string }>>(
      initial
    );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const sentValues = initial();
  const dirty = breaks.some(
    (b) =>
      values[b.qty]?.unitPrice !== sentValues[b.qty]?.unitPrice ||
      values[b.qty]?.leadTimeDays !== sentValues[b.qty]?.leadTimeDays
  );
  const edited = Boolean(line.final);

  const save = (final: LineFinal) =>
    start(async () => {
      const r = await saveFinal(rfqId, line.id, final);
      if (r.ok) {
        setError(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        router.refresh();
      } else {
        setError(r.error);
      }
    });

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Cost / ea</TableHead>
              <TableHead className="text-right">Suggested / ea</TableHead>
              <TableHead className="text-right">Quote / ea</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead className="text-right">Lead time</TableHead>
              <TableHead className="text-right">Quote lead time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {breaks.map((b) => {
              const v = values[b.qty] ?? { unitPrice: "", leadTimeDays: "" };
              return (
                <PriceRow
                  b={b}
                  editable={editable}
                  key={b.qty}
                  onChange={(patch) =>
                    setValues((all) => ({
                      ...all,
                      [b.qty]: { ...v, ...patch },
                    }))
                  }
                  requestedDate={requestedDate}
                  v={v}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={pending || !dirty}
            onClick={() =>
              save({
                breaks: breaks.map((b) => ({
                  qty: b.qty,
                  unitPrice: Number(values[b.qty]?.unitPrice),
                  leadTimeDays: Number(values[b.qty]?.leadTimeDays),
                })),
              })
            }
            size="sm"
            variant={dirty ? "default" : "outline"}
          >
            {pending && <Spinner />} {saved ? "Saved" : "Save prices"}
          </Button>
          {(edited || dirty) && breaks.every((b) => b.unit_price !== null) && (
            <Button
              disabled={pending}
              onClick={() => {
                const reset = Object.fromEntries(
                  breaks.map((b) => [
                    b.qty,
                    {
                      unitPrice: String(b.unit_price),
                      leadTimeDays: String(b.lead_time_days ?? ""),
                    },
                  ])
                );
                setValues(reset);
                save({
                  breaks: breaks.map((b) => ({
                    qty: b.qty,
                    unitPrice: b.unit_price ?? 0,
                    leadTimeDays: b.lead_time_days ?? 0,
                  })),
                });
              }}
              size="sm"
              variant="ghost"
            >
              Use Takumo's draft
            </Button>
          )}
          {edited && !dirty && (
            <span className="text-muted-foreground text-xs">
              Edited from the draft
            </span>
          )}
          {error && <span className="text-destructive text-sm">{error}</span>}
        </div>
      )}
    </div>
  );
};
