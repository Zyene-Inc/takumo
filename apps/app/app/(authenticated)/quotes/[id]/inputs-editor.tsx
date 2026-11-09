"use client";

// Editing the estimate's inputs: operations, material and outside processes.

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import type {
  OperationSource,
  OutsideProcess,
  QuoteOperation,
} from "@repo/engine-client/types";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LineView } from "@/lib/quotes/view";
import { localToday } from "../../schedule/gantt";
import { type LineInputs, reestimateLine } from "../actions";
import { Fold } from "./line-card-parts";
import { OperationRows } from "./operation-rows";

export interface OpRow {
  alt: string[];
  key: number;
  note: string | null;
  run: string;
  seq: string;
  setup: string;
  source: OperationSource;
  workCenter: string;
}

export interface OutsideRow {
  description: string;
  key: number;
  lot: string;
  unit: string;
}

export let rowKey = 0;

export const nextKey = () => {
  rowKey += 1;
  return rowKey;
};

export const optional = (value: string) =>
  value.trim() === "" ? null : Number(value);

export const InputsEditor = ({
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
        <OperationRows
          editable={editable}
          editOp={editOp}
          machines={machines}
          ops={ops}
          setOps={setOps}
          setOpsChanged={setOpsChanged}
        />

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
