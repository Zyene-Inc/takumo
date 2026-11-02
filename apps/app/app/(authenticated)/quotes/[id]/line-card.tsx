"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
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
import { cn } from "@repo/design-system/lib/utils";
import type {
  OperationSource,
  OutsideProcess,
  QuoteBreak,
  QuoteOperation,
} from "@repo/engine-client/types";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { buildUpRows } from "@/lib/quotes/review";
import type { LineFinal, PriceBuildUp, RfqStatus } from "@/lib/quotes/types";
import type { LineView } from "@/lib/quotes/view";
import { localToday } from "../../schedule/gantt";
import {
  deleteLine,
  type LineInputs,
  recordLineOutcome,
  reestimateLine,
  saveFinal,
  saveLine,
} from "../actions";
import { Confirm } from "./confirm";
import { DrawingSummary, type OtherLine } from "./drawing-summary";
import { DrawingViewer, type ViewerFile } from "./drawing-viewer";
import { ErpOrder } from "./erp-order";
import { lineAnchor } from "./review-focus";
import { SourceChip as CostSourceChip } from "./source-chip";
import type { WorkspaceOptions } from "./workspace";

const usd = (value: number | null | undefined, cents = true) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      });

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

const SOURCE_LABEL: Record<OperationSource, string> = {
  routing: "Shop routing",
  actuals: "Actual times",
  comparable: "Estimated",
  estimator: "Entered",
};

const quoteHref = (quoteNo: string) =>
  `/quotes/history?q=${encodeURIComponent(quoteNo)}`;

const OUTCOME_VARIANT: Record<string, "default" | "outline" | "secondary"> = {
  won: "default",
  lost: "outline",
  open: "secondary",
};

const sourceHref = (kind: string, name: string) => {
  const q = (value: string) => encodeURIComponent(value);
  switch (kind) {
    case "quote":
      return quoteHref(name);
    case "machine":
      return `/shop/work-centers?q=${q(name)}`;
    case "routing":
      return `/shop/parts?q=${q(name.split(" op ")[0])}`;
    case "material":
      return `/shop/materials?q=${q(name)}`;
    default:
      return null;
  }
};

/** "quote Q-9001" → a link; other sources as plain chips. */
const SourceChip = ({ id }: { id: string }) => {
  const [kind, ...rest] = id.split(" ");
  const name = rest.join(" ");
  const href = sourceHref(kind, name);
  const chip = (
    <span className="rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {id}
    </span>
  );
  return href ? (
    <Link className="hover:underline" href={href}>
      {chip}
    </Link>
  ) : (
    chip
  );
};

// ---------------------------------------------------------------------------
// Line spec (what the customer asked for)

export const LineSpecForm = ({
  rfqId,
  line,
  materials,
  onDone,
}: {
  line?: LineView;
  materials: string[];
  onDone: () => void;
  rfqId: string;
}) => {
  const router = useRouter();
  const [values, setValues] = useState({
    partNo: line?.partNo ?? "",
    rev: line?.rev ?? "",
    description: line?.description ?? "",
    materialText: line?.materialText ?? line?.material?.name ?? "",
    qtys: line?.qtys.join(", ") ?? "",
    tolerances: line?.tolerances ?? "",
    finish: line?.finish ?? "",
    notes: line?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const field = (
    key: keyof typeof values,
    label: string,
    extra: { placeholder?: string; list?: string; required?: boolean } = {}
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${line?.id ?? "new"}-${key}`}>
        {label}
        {extra.required && <span className="text-destructive">*</span>}
      </Label>
      <Input
        id={`${line?.id ?? "new"}-${key}`}
        list={extra.list}
        onChange={(e) => set(key, e.target.value)}
        placeholder={extra.placeholder}
        value={values[key]}
      />
    </div>
  );

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveLine(rfqId, line?.id ?? null, values);
          if (r.ok) {
            onDone();
            router.refresh();
          } else {
            setError(r.error);
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem_1fr]">
        {field("partNo", "Part number", { required: true })}
        {field("rev", "Rev")}
        {field("qtys", "Quantities", {
          placeholder: "50, 100, 250",
          required: true,
        })}
      </div>
      {field("description", "Description")}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("materialText", "Material", { list: "shop-materials" })}
        {field("finish", "Finish / outside processing")}
        {field("tolerances", "Tolerances")}
        {field("notes", "Notes")}
      </div>
      <datalist id="shop-materials">
        {materials.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {line?.draft && (
        <p className="text-muted-foreground text-xs">
          Changing the part, material, finish or quantities clears this line's
          draft.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending} size="sm" type="submit">
          {pending && <Spinner />} Save line
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
};

const MatchBadge = ({ line }: { line: LineView }) => {
  if (line.part) {
    return (
      <Link href={`/shop/parts/${line.part.id}`}>
        <Badge variant="secondary">In your shop</Badge>
      </Link>
    );
  }
  if (line.otherRev) {
    return (
      <Badge variant="outline">New revision · shop has {line.otherRev}</Badge>
    );
  }
  return <Badge variant="outline">New part</Badge>;
};

// ---------------------------------------------------------------------------
// Prices: the draft and what the estimator will send

interface PriceInput {
  leadTimeDays: string;
  unitPrice: string;
}

/** What a price input shows: the estimator's value, else the draft's. */
const inputValue = (sent: number | undefined, draft: number | null) => {
  if (sent !== undefined) {
    return String(sent);
  }
  return draft === null ? "" : String(draft);
};

const PriceRow = ({
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

const PriceTable = ({
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

const Notices = ({ line }: { line: LineView }) => {
  const r = line.draft?.response;
  if (!r) {
    return null;
  }
  return (
    <div className="grid gap-2">
      {r.missing.length > 0 && (
        <Alert variant="destructive">
          <XCircleIcon />
          <AlertDescription>
            Can't price this yet: {r.missing.join("; ")}. Fill it in under
            Operations and inputs.
          </AlertDescription>
        </Alert>
      )}
      {[...r.warnings, ...(line.draft?.routingNotes ?? [])].map((w) => (
        <div
          className="flex gap-2 text-amber-700 text-sm dark:text-amber-400"
          key={w}
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" /> {w}
        </div>
      ))}
      {r.checks.map((c) => (
        <div className="flex gap-2 text-muted-foreground text-sm" key={c}>
          <InfoIcon className="mt-0.5 size-4 shrink-0" /> {c}
        </div>
      ))}
    </div>
  );
};

const Fold = ({
  title,
  children,
  open = false,
}: {
  children: ReactNode;
  open?: boolean;
  title: string;
}) => (
  <Collapsible defaultOpen={open}>
    <CollapsibleTrigger className="group flex items-center gap-1 font-medium text-sm">
      <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
      {title}
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
  </Collapsible>
);

const minutes = (value: number) => `${Math.round(value * 100) / 100} min`;

/** Where each part of one quantity's price came from (F2.4-R6). */
const BuildUpSources = ({ b }: { b: PriceBuildUp }) => (
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

const CostBuild = ({ line }: { line: LineView }) => {
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

const Comparables = ({ line }: { line: LineView }) => {
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

interface OpRow {
  alt: string[];
  key: number;
  note: string | null;
  run: string;
  seq: string;
  setup: string;
  source: OperationSource;
  workCenter: string;
}

interface OutsideRow {
  description: string;
  key: number;
  lot: string;
  unit: string;
}

let rowKey = 0;
const nextKey = () => {
  rowKey += 1;
  return rowKey;
};

const optional = (value: string) =>
  value.trim() === "" ? null : Number(value);

const InputsEditor = ({
  line,
  rfqId,
  machines,
  editable,
}: {
  editable: boolean;
  line: LineView;
  machines: string[];
  rfqId: string;
}) => {
  const router = useRouter();
  const inputs = line.draft?.inputs;
  const toRows = (ops: QuoteOperation[]): OpRow[] =>
    ops.map((op) => ({
      key: nextKey(),
      seq: String(op.seq),
      workCenter: op.work_center,
      setup: String(op.setup_min),
      run: String(op.run_min_per_unit),
      source: op.source ?? "routing",
      note: op.note ?? null,
      alt: op.alt_work_centers ?? [],
    }));
  const [ops, setOps] = useState<OpRow[]>(() => toRows(inputs?.routing ?? []));
  const [opsChanged, setOpsChanged] = useState(false);
  const [outside, setOutside] = useState<OutsideRow[]>(() =>
    (line.outside ?? inputs?.outside ?? []).map((o: OutsideProcess) => ({
      key: nextKey(),
      description: o.description,
      lot:
        o.cost_per_lot === null || o.cost_per_lot === undefined
          ? ""
          : String(o.cost_per_lot),
      unit:
        o.cost_per_unit === null || o.cost_per_unit === undefined
          ? ""
          : String(o.cost_per_unit),
    }))
  );
  const [usage, setUsage] = useState(
    line.usagePerPart === null ? "" : String(line.usagePerPart)
  );
  const [materialCost, setMaterialCost] = useState(
    line.materialCost === null ? "" : String(line.materialCost)
  );
  const [margin, setMargin] = useState(
    line.targetMargin === null
      ? ""
      : String(Math.round(line.targetMargin * 1000) / 10)
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const editOp = (key: number, patch: Partial<OpRow>) => {
    setOpsChanged(true);
    setOps((rows) =>
      rows.map((r) =>
        r.key === key ? { ...r, ...patch, source: "estimator", note: null } : r
      )
    );
  };
  const unit = line.material?.unit;
  const pricedByStock =
    line.material && unit && unit !== "ea" && line.material.unitCost !== null;

  const submit = () =>
    start(async () => {
      setError(null);
      const routing: LineInputs["routing"] =
        opsChanged || line.routing
          ? ops.map((r) => ({
              seq: Number(r.seq),
              work_center: r.workCenter,
              setup_min: Number(r.setup),
              run_min_per_unit: Number(r.run),
              alt_work_centers: r.alt,
              source: r.source,
              note: r.note,
            }))
          : null;
      if (
        routing?.some(
          (op) =>
            !(op.seq > 0) ||
            Number.isNaN(op.setup_min) ||
            Number.isNaN(op.run_min_per_unit)
        )
      ) {
        setError(
          "Every operation needs a number, a machine, and setup and run minutes."
        );
        return;
      }
      const r = await reestimateLine(
        rfqId,
        line.id,
        {
          routing,
          outside: outside
            .filter((o) => o.description.trim())
            .map((o) => ({
              description: o.description.trim(),
              cost_per_lot: optional(o.lot),
              cost_per_unit: optional(o.unit),
            })),
          usagePerPart: optional(usage),
          materialCost: optional(materialCost),
          targetMargin: margin.trim() === "" ? null : Number(margin) / 100,
        },
        localToday()
      );
      if (r.ok) {
        setOpsChanged(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });

  return (
    <Fold
      open={Boolean(line.draft?.response.missing.length)}
      title="Operations and inputs"
    >
      <div className="grid gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Op</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead className="text-right">Setup min</TableHead>
                <TableHead className="text-right">Run min/ea</TableHead>
                <TableHead>From</TableHead>
                {editable && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ops.map((op) => (
                <TableRow key={op.key}>
                  <TableCell>
                    {editable ? (
                      <Input
                        aria-label="Operation number"
                        className="h-8 w-16"
                        onChange={(e) =>
                          editOp(op.key, { seq: e.target.value })
                        }
                        type="number"
                        value={op.seq}
                      />
                    ) : (
                      op.seq
                    )}
                  </TableCell>
                  <TableCell>
                    {editable ? (
                      <Select
                        onValueChange={(v) => editOp(op.key, { workCenter: v })}
                        value={op.workCenter}
                      >
                        <SelectTrigger
                          aria-label="Machine"
                          className="h-8 w-40"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {machines.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      op.workCenter
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable ? (
                      <Input
                        aria-label="Setup minutes"
                        className="ml-auto h-8 w-20 text-right"
                        min={0}
                        onChange={(e) =>
                          editOp(op.key, { setup: e.target.value })
                        }
                        step="any"
                        type="number"
                        value={op.setup}
                      />
                    ) : (
                      op.setup
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable ? (
                      <Input
                        aria-label="Run minutes per part"
                        className="ml-auto h-8 w-20 text-right"
                        min={0}
                        onChange={(e) =>
                          editOp(op.key, { run: e.target.value })
                        }
                        step="any"
                        type="number"
                        value={op.run}
                      />
                    ) : (
                      op.run
                    )}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <Badge
                      variant={
                        op.source === "comparable" ? "outline" : "secondary"
                      }
                    >
                      {SOURCE_LABEL[op.source]}
                    </Badge>
                    {op.note && (
                      <p className="mt-1 text-muted-foreground text-xs">
                        {op.note}
                      </p>
                    )}
                  </TableCell>
                  {editable && (
                    <TableCell>
                      <Button
                        aria-label="Remove operation"
                        onClick={() => {
                          setOpsChanged(true);
                          setOps((rows) =>
                            rows.filter((r) => r.key !== op.key)
                          );
                        }}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {editable && (
          <Button
            className="justify-self-start"
            onClick={() => {
              setOpsChanged(true);
              const last = Math.max(0, ...ops.map((o) => Number(o.seq) || 0));
              setOps((rows) => [
                ...rows,
                {
                  key: nextKey(),
                  seq: String(last + 10),
                  workCenter: machines[0] ?? "",
                  setup: "0",
                  run: "0",
                  source: "estimator",
                  note: null,
                  alt: [],
                },
              ]);
            }}
            size="sm"
            variant="outline"
          >
            <PlusIcon /> Add operation
          </Button>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          {pricedByStock && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${line.id}-usage`}>
                Stock per part ({unit})
              </Label>
              <Input
                disabled={!editable}
                id={`${line.id}-usage`}
                min={0}
                onChange={(e) => setUsage(e.target.value)}
                placeholder="From history"
                step="any"
                type="number"
                value={usage}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={`${line.id}-material`}>
              Material cost per part ($)
            </Label>
            <Input
              disabled={!editable}
              id={`${line.id}-material`}
              min={0}
              onChange={(e) => setMaterialCost(e.target.value)}
              placeholder={
                pricedByStock ? "Or from stock used" : "From history"
              }
              step="any"
              type="number"
              value={materialCost}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${line.id}-margin`}>Target margin (%)</Label>
            <Input
              disabled={!editable}
              id={`${line.id}-margin`}
              max={85}
              min={0}
              onChange={(e) => setMargin(e.target.value)}
              placeholder="From won quotes"
              step="any"
              type="number"
              value={margin}
            />
          </div>
        </div>

        <div className="grid gap-2">
          <p className="font-medium text-sm">Outside processing</p>
          {outside.length === 0 && (
            <p className="text-muted-foreground text-sm">None.</p>
          )}
          {outside.map((o) => (
            <div
              className="grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-2"
              key={o.key}
            >
              <Input
                aria-label="Outside process"
                disabled={!editable}
                onChange={(e) =>
                  setOutside((rows) =>
                    rows.map((r) =>
                      r.key === o.key
                        ? { ...r, description: e.target.value }
                        : r
                    )
                  )
                }
                value={o.description}
              />
              <Input
                aria-label="Cost per lot"
                disabled={!editable}
                min={0}
                onChange={(e) =>
                  setOutside((rows) =>
                    rows.map((r) =>
                      r.key === o.key ? { ...r, lot: e.target.value } : r
                    )
                  )
                }
                placeholder="$ per lot"
                step="any"
                type="number"
                value={o.lot}
              />
              <Input
                aria-label="Cost per part"
                disabled={!editable}
                min={0}
                onChange={(e) =>
                  setOutside((rows) =>
                    rows.map((r) =>
                      r.key === o.key ? { ...r, unit: e.target.value } : r
                    )
                  )
                }
                placeholder="$ per part"
                step="any"
                type="number"
                value={o.unit}
              />
              {editable && (
                <Button
                  aria-label="Remove outside process"
                  onClick={() =>
                    setOutside((rows) => rows.filter((r) => r.key !== o.key))
                  }
                  size="icon"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
          ))}
          {editable && (
            <Button
              className="justify-self-start"
              onClick={() =>
                setOutside((rows) => [
                  ...rows,
                  { key: nextKey(), description: "", lot: "", unit: "" },
                ])
              }
              size="sm"
              variant="outline"
            >
              <PlusIcon /> Add outside process
            </Button>
          )}
        </div>

        {editable && (
          <div className="flex items-center gap-2">
            <Button disabled={pending} onClick={submit} size="sm">
              {pending && <Spinner />} {pending ? "Estimating…" : "Re-estimate"}
            </Button>
            {error && <span className="text-destructive text-sm">{error}</span>}
          </div>
        )}
      </div>
    </Fold>
  );
};

// ---------------------------------------------------------------------------
// After approval: the customer's answer

const Outcome = ({
  line,
  rfqId,
  canEdit,
}: {
  canEdit: boolean;
  line: LineView;
  rfqId: string;
}) => {
  const router = useRouter();
  const quote = line.quote;
  const [qty, setQty] = useState(String(quote?.breaks[0]?.qty ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!quote) {
    return null;
  }
  const decide = (status: "won" | "lost") =>
    start(async () => {
      const r = await recordLineOutcome(
        rfqId,
        status === "won"
          ? { lineId: line.id, status, qty: Number(qty) }
          : { lineId: line.id, status },
        localToday()
      );
      if (r.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(r.error);
      }
    });

  return (
    <div className="grid gap-3 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Quoted as{" "}
          <Link
            className="font-medium hover:underline"
            href={quoteHref(quote.quoteNo)}
          >
            {quote.quoteNo}
          </Link>
        </span>
        <Badge variant={OUTCOME_VARIANT[quote.status] ?? "secondary"}>
          {quote.status === "open" ? "awaiting answer" : quote.status}
        </Badge>
        {line.orderNo && !line.erpOrder && (
          <span>
            · order{" "}
            <Link
              className="font-medium hover:underline"
              href={`/shop/orders?q=${encodeURIComponent(line.orderNo)}`}
            >
              {line.orderNo}
            </Link>{" "}
            created.{" "}
            <Link className="underline" href="/schedule">
              Re-plan the board
            </Link>{" "}
            to schedule it.
          </span>
        )}
      </div>
      {line.erpOrder && (
        <ErpOrder entry={line.erpOrder} orderNo={line.orderNo} />
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {quote.breaks.map((b) => (
          <span key={b.qty}>
            {b.qty.toLocaleString()} pcs · {usd(b.unitPrice)}/ea ·{" "}
            {b.leadTimeDays} d
          </span>
        ))}
      </div>
      {canEdit && quote.status === "open" && (
        <div className="flex flex-wrap items-center gap-2">
          {quote.breaks.length > 1 && (
            <Select onValueChange={setQty} value={qty}>
              <SelectTrigger aria-label="Quantity ordered" className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {quote.breaks.map((b) => (
                  <SelectItem key={b.qty} value={String(b.qty)}>
                    {b.qty.toLocaleString()} pcs
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button disabled={pending} onClick={() => decide("won")} size="sm">
            <CheckCircle2Icon /> Won: create order
          </Button>
          <Button
            disabled={pending}
            onClick={() => decide("lost")}
            size="sm"
            variant="outline"
          >
            <XCircleIcon /> Lost
          </Button>
          {pending && <Spinner />}
          {error && <span className="text-destructive text-sm">{error}</span>}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

export const LineCard = ({
  line,
  rfqId,
  status,
  editable,
  options,
  otherLines = [],
  requestedDate,
  drawingFile = null,
}: {
  /** The drawing this line was read from, shown beside its price (F2.6). */
  drawingFile?: ViewerFile | null;
  editable: boolean;
  line: LineView;
  options: WorkspaceOptions;
  /** The RFQ's other lines, to merge one into this one. */
  otherLines?: OtherLine[];
  requestedDate: string | null;
  rfqId: string;
  status: RfqStatus;
}) => {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, start] = useTransition();
  const draftable = options.canEdit && ["review", "drafted"].includes(status);
  const title = `${line.partNo ?? line.description ?? "Part"}${line.rev ? ` rev ${line.rev}` : ""}`;
  const spec: [string, string | null][] = [
    [
      "Qty",
      line.qtys.length
        ? line.qtys.map((q) => q.toLocaleString()).join(" / ")
        : null,
    ],
    ["Material", line.materialText ?? line.material?.name ?? null],
    ["Finish", line.finish],
    ["Tolerances", line.tolerances],
    ["Notes", line.notes],
  ];

  return (
    <section className="scroll-mt-4 rounded-xl border" id={lineAnchor(line.id)}>
      <Confirm
        action="Remove"
        description="Its draft goes too."
        onConfirm={() =>
          start(async () => {
            await deleteLine(rfqId, line.id);
            router.refresh();
          })
        }
        onOpenChange={setRemoving}
        open={removing}
        title={`Remove line ${line.lineNo}?`}
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 className="font-medium">
          <span className="text-muted-foreground">Line {line.lineNo} · </span>
          {title}
        </h2>
        <MatchBadge line={line} />
        {line.material &&
          line.materialText &&
          line.material.name !== line.materialText && (
            <Badge variant="secondary">Material: {line.material.name}</Badge>
          )}
        {editable && !editing && (
          <div className="ml-auto flex gap-1">
            <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
              <PencilIcon /> Edit
            </Button>
            <Button
              aria-label={`Remove line ${line.lineNo}`}
              disabled={pending}
              onClick={() => setRemoving(true)}
              size="icon"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      <div
        className={cn(
          "grid gap-4 p-4",
          drawingFile &&
            "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start"
        )}
      >
        {drawingFile && (
          <div className="lg:sticky lg:top-4">
            <DrawingViewer file={drawingFile} lineId={line.id} rfqId={rfqId} />
          </div>
        )}
        <div className="grid min-w-0 gap-4">
          {editing ? (
            <LineSpecForm
              line={line}
              materials={options.materials}
              onDone={() => setEditing(false)}
              rfqId={rfqId}
            />
          ) : (
            <>
              {line.description && (
                <p className="text-sm">{line.description}</p>
              )}
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                {spec
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div className="flex gap-1.5" key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            </>
          )}
          {line.drawing && !editing && (
            <DrawingSummary
              drawing={line.drawing}
              editable={editable && !line.quote}
              lineId={line.id}
              otherLines={otherLines}
              rfqId={rfqId}
            />
          )}
          {line.quote ? (
            <Outcome canEdit={options.canEdit} line={line} rfqId={rfqId} />
          ) : null}
          {line.draft ? (
            <>
              <PriceTable
                editable={draftable && !line.quote}
                key={`${line.draft.estimatedAt}-${JSON.stringify(line.final)}`}
                line={line}
                requestedDate={requestedDate}
                rfqId={rfqId}
              />
              <Notices line={line} />
              <Comparables line={line} />
              <CostBuild key={line.draft.estimatedAt} line={line} />
              <InputsEditor
                editable={draftable && !line.quote}
                key={`inputs-${line.draft.estimatedAt}`}
                line={line}
                machines={options.machines}
                rfqId={rfqId}
              />
            </>
          ) : (
            !editing && (
              <p className="text-muted-foreground text-sm">
                {line.part
                  ? "Not drafted yet."
                  : "Not drafted yet. Takumo will propose operations for this new part from the most similar parts you make."}
              </p>
            )
          )}
        </div>
      </div>
    </section>
  );
};
