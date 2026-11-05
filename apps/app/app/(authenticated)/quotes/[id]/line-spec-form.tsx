"use client";

// Editing a line's part, quantities, material and notes.

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LineView } from "@/lib/quotes/view";
import { saveLine } from "../actions";

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
