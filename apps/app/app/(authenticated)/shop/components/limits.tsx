"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PercentIcon, RulerIcon } from "lucide-react";
import { saveMachineLimits, saveMarginFloor } from "../limits-actions";
import { LimitsDialog } from "./limits-dialog";

const text = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : String(n);

export interface Envelope {
  diameter?: number;
  length?: number;
  x?: number;
  y?: number;
  z?: number;
}

/** Envelope and tolerance: Takumo's own, so editable on ERP machines too. */
export const MachineLimits = ({
  id,
  name,
  envelope,
  toleranceIn,
}: {
  envelope: Envelope | null;
  id: string;
  name: string;
  toleranceIn: number | null;
}) => (
  <LimitsDialog
    description="The largest part it takes and the tightest tolerance it holds, in inches. Drawings that don't fit any machine are flagged. Give X/Y/Z travel for a mill, or diameter and length for a lathe."
    fields={[
      { key: "x", label: "X travel" },
      { key: "y", label: "Y travel" },
      { key: "z", label: "Z travel" },
      { key: "diameter", label: "Max diameter" },
      { key: "length", label: "Max length" },
      { key: "toleranceIn", label: "Tolerance (± in)", hint: "e.g. 0.0005" },
    ]}
    initial={{
      x: text(envelope?.x),
      y: text(envelope?.y),
      z: text(envelope?.z),
      diameter: text(envelope?.diameter),
      length: text(envelope?.length),
      toleranceIn: text(toleranceIn),
    }}
    onSave={(v) =>
      saveMachineLimits({
        id,
        x: v.x,
        y: v.y,
        z: v.z,
        diameter: v.diameter,
        length: v.length,
        toleranceIn: v.toleranceIn,
      })
    }
    title={`${name}: size and tolerance`}
    trigger={
      <Button
        aria-label={`Size and tolerance for ${name}`}
        size="icon"
        title="Size and tolerance"
        variant="ghost"
      >
        <RulerIcon />
      </Button>
    }
  />
);

/** The lowest margin the owner accepts for this customer. */
export const MarginFloor = ({
  id,
  name,
  floor,
}: {
  floor: number | null;
  id: string;
  name: string;
}) => (
  <LimitsDialog
    description="Takumo never suggests a price below this margin for this customer. Leave empty for no floor."
    fields={[{ key: "floorPct", label: "Margin floor (%)", hint: "e.g. 25" }]}
    initial={{
      floorPct: floor === null ? "" : String(Math.round(floor * 1000) / 10),
    }}
    onSave={(v) => saveMarginFloor({ id, floorPct: v.floorPct })}
    title={`${name}: margin floor`}
    trigger={
      <Button
        aria-label={`Margin floor for ${name}`}
        size="icon"
        title="Margin floor"
        variant="ghost"
      >
        <PercentIcon />
      </Button>
    }
  />
);
