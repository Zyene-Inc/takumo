"use client";

// Where the price came from: cost build-up, sources and comparable quotes.

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";
import { useState } from "react";
import { buildUpRows } from "@/lib/quotes/review";
import type { PriceBuildUp } from "@/lib/quotes/types";
import type { LineView } from "@/lib/quotes/view";
import { SourceChip as CostSourceChip } from "./source-chip";
import {
  usd,
  pct,
  quoteHref,
  OUTCOME_VARIANT,
  SourceChip,
  Fold,
  minutes,
} from "./line-card-parts";

/** Where each part of one quantity's price came from (F2.4-R6). */
export const BuildUpSources = ({ b }: { b: PriceBuildUp }) => (
  <div className="grid gap-2 rounded-lg border p-3 text-xs">
    <p className="font-medium text-sm">
      Per part at {b.qty.toLocaleString()} pcs
    </p>
    <dl className="grid gap-0.5 text-sm">
      {buildUpRows(b).map((row) => (
        <div
          className={cn(
            "flex justify-between gap-4",
            (row.key === "cost" || row.key === "price") &&
              "border-t pt-0.5 font-medium"
          )}
          key={row.key}
        >
          <dt
            className={
              row.isDefault ? "text-amber-700 dark:text-amber-400" : ""
            }
          >
            {row.label}
            {row.isDefault ? " (includes a default)" : ""}
          </dt>
          <dd className="tabular-nums">{usd(row.amount)}</dd>
        </div>
      ))}
    </dl>
    <p className="pt-1 font-medium text-sm">Where the numbers come from</p>
    <p className="text-muted-foreground">Click a source to see it.</p>
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Material</span>
        <span>
          {b.material.perPart === null
            ? "—"
            : `${usd(b.material.perPart)}/part`}
          {b.material.stock ? ` · ${b.material.stock}` : ""}
          {b.material.markup ? ` · incl. ${pct(b.material.markup)} markup` : ""}
        </span>
        <CostSourceChip source={b.material.source} />
      </div>
      {b.operations.map((op) => (
        <div className="flex flex-wrap items-center gap-1.5" key={op.seq}>
          <span className="text-muted-foreground">
            Op {op.seq} · {op.workCenter}
          </span>
          <span>
            {minutes(op.setupMin)} setup ({minutes(op.setupPerPart)}/part) +{" "}
            {minutes(op.runMinPerUnit)}/part
            {op.rate === null ? "" : ` at ${usd(op.rate)}/h`}
          </span>
          <CostSourceChip source={op.basis} />
          <CostSourceChip source={op.rateSource} />
          {op.alternates.length > 0 && (
            <span className="text-muted-foreground">
              or {op.alternates.join(", ")}
            </span>
          )}
        </div>
      ))}
      {b.outside.map((o) => (
        <div className="flex flex-wrap items-center gap-1.5" key={o.process}>
          <span className="text-muted-foreground">Outside</span>
          <span>
            {o.process}
            {o.supplier ? ` · ${o.supplier}` : ""}
            {o.leadTimeDays === null ? "" : ` · ${o.leadTimeDays} days`}
          </span>
          <CostSourceChip source={o.source} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Margin</span>
        <span>
          {pct(b.margin.pct)}
          {b.margin.low !== null && b.margin.high !== null
            ? ` (usual ${pct(b.margin.low)}–${pct(b.margin.high)})`
            : ""}
          {b.margin.floor === null ? "" : ` · floor ${pct(b.margin.floor)}`}
        </span>
        {b.margin.raisedByFloor && <CostSourceChip source={b.margin.source} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Lead time</span>
        <span>
          {b.leadTimeDays === null ? "—" : `${b.leadTimeDays} days`}
          {b.lead.outsideDays > 0
            ? ` (incl. ${b.lead.outsideDays} days outside)`
            : ""}
        </span>
        <CostSourceChip source={b.lead.materialSource} />
      </div>
    </div>
  </div>
);

export const CostBuild = ({ line }: { line: LineView }) => {
  const r = line.draft?.response;
  const [qty, setQty] = useState(r?.breaks[0]?.qty ?? 0);
  if (!r) {
    return null;
  }
  const row = r.breaks.find((b) => b.qty === qty) ?? r.breaks[0];
  return (
    <Fold open title="How the price is built">
      <div className="grid gap-3">
        {r.breaks.length > 1 && (
          <div className="flex gap-1">
            {r.breaks.map((b) => (
              <Button
                key={b.qty}
                onClick={() => setQty(b.qty)}
                size="sm"
                variant={b.qty === row.qty ? "secondary" : "ghost"}
              >
                {b.qty.toLocaleString()} pcs
              </Button>
            ))}
          </div>
        )}
        <div className="divide-y rounded-lg border text-sm">
          {row.lines.map((l) => (
            <div
              className="grid gap-1 px-3 py-2 sm:grid-cols-[1fr_auto]"
              key={l.label}
            >
              <div className="min-w-0">
                <p className="font-medium">{l.label}</p>
                <p className="text-muted-foreground text-xs">{l.basis}</p>
                {l.sources.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {l.sources.map((s) => (
                      <SourceChip id={s} key={s} />
                    ))}
                  </div>
                )}
              </div>
              <p className="text-right tabular-nums">{usd(l.amount)}</p>
            </div>
          ))}
          <div className="flex justify-between px-3 py-2 font-medium">
            <span>Cost for {row.qty.toLocaleString()} pcs</span>
            <span className="tabular-nums">{usd(row.cost)}</span>
          </div>
          <div className="px-3 py-2">
            <div className="flex justify-between font-medium">
              <span>Suggested price at {pct(r.margin.target)} margin</span>
              <span className="tabular-nums">{usd(row.price)}</span>
            </div>
            <p className="text-muted-foreground text-xs">{r.margin.basis}</p>
            {r.margin.sources.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r.margin.sources.map((s) => (
                  <SourceChip id={s} key={s} />
                ))}
              </div>
            )}
          </div>
        </div>
        {(() => {
          const b = line.draft?.buildUp?.find((x) => x.qty === row.qty);
          return b ? <BuildUpSources b={b} /> : null;
        })()}
        {r.lead_time_note && (
          <p className="text-muted-foreground text-xs">{r.lead_time_note}</p>
        )}
      </div>
    </Fold>
  );
};

export const Comparables = ({ line }: { line: LineView }) => {
  const comps = line.draft?.response.comparables ?? [];
  return (
    <Fold open title={`Comparable past quotes (${comps.length})`}>
      {comps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No past quotes are close to this one. The price rests on the cost
          build-up alone.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quote</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">$/ea</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Why it's similar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comps.map((c) => (
                <TableRow key={c.quote_no}>
                  <TableCell className="font-medium">
                    <Link
                      className="hover:underline"
                      href={quoteHref(c.quote_no)}
                    >
                      {c.quote_no}
                    </Link>
                    <p className="font-normal text-muted-foreground text-xs">
                      {c.quoted_at}
                    </p>
                  </TableCell>
                  <TableCell>{c.part_no ?? "—"}</TableCell>
                  <TableCell className="max-w-36 truncate">
                    {c.customer ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.qty.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {usd(c.unit_price)}
                  </TableCell>
                  <TableCell className="text-right">
                    {pct(c.margin_pct)}
                    {c.margin_basis && (
                      <p className="text-muted-foreground text-xs">
                        {c.margin_basis}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={OUTCOME_VARIANT[c.status] ?? "secondary"}>
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {c.reasons.join(", ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Fold>
  );
};

// ---------------------------------------------------------------------------
// Operations and estimator inputs
