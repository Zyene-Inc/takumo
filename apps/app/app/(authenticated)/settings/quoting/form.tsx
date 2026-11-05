"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { saveQuoteSettings } from "./actions";
import { splitList } from "./schema";

export interface SupplierRow {
  costPerPart: string;
  key: number;
  leadTimeDays: string;
  lotCharge: string;
  process: string;
  supplier: string;
}

export interface QuotingView {
  certifications: string;
  defaultMarginPct: string;
  laborRate: string;
  materialMarkupPct: string;
  quoteValidityDays: string;
  replyIntro: string;
  signature: string;
  suppliers: SupplierRow[];
  toleranceIn: string;
}

const optionalNumber = (value: string) => {
  const v = value.trim().replace(/[$,%]/g, "");
  if (!v) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

const Field = ({
  id,
  label,
  hint,
  children,
}: {
  children: ReactNode;
  hint?: string;
  id: string;
  label: string;
}) => (
  <div className="grid gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
  </div>
);

let nextKey = 1000;

/** The shop's quoting settings. Read-only for people who can't change them. */
export const QuotingForm = ({
  initial,
  canEdit,
}: {
  canEdit: boolean;
  initial: QuotingView;
}) => {
  const [v, setV] = useState(initial);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  const disabled = !canEdit || pending;
  const set = (key: keyof QuotingView) => (value: string) =>
    setV({ ...v, [key]: value });
  const setRow = (key: number, field: keyof SupplierRow, value: string) =>
    setV({
      ...v,
      suppliers: v.suppliers.map((r) =>
        r.key === key ? { ...r, [field]: value } : r
      ),
    });

  const save = () => {
    const numbers = {
      quoteValidityDays: optionalNumber(v.quoteValidityDays),
      materialMarkupPct: optionalNumber(v.materialMarkupPct),
      laborRate: optionalNumber(v.laborRate),
      defaultMarginPct: optionalNumber(v.defaultMarginPct),
      toleranceIn: optionalNumber(v.toleranceIn),
    };
    const bad = Object.entries(numbers).find(
      ([, n]) => n === null || Number.isNaN(n)
    );
    if (bad) {
      setMessage({ error: true, text: "Fill in every number at the top." });
      return;
    }
    const suppliers = v.suppliers
      .filter((r) => r.process.trim())
      .map((r) => ({
        process: r.process.trim(),
        supplier: r.supplier.trim() || null,
        leadTimeDays: optionalNumber(r.leadTimeDays),
        costPerPart: optionalNumber(r.costPerPart),
        lotCharge: optionalNumber(r.lotCharge),
      }));
    if (
      suppliers.some((s) =>
        [s.leadTimeDays, s.costPerPart, s.lotCharge].some((n) =>
          Number.isNaN(n)
        )
      )
    ) {
      setMessage({
        error: true,
        text: "Outside processes: lead time and prices must be numbers.",
      });
      return;
    }
    start(async () => {
      const r = await saveQuoteSettings({
        quoteValidityDays: Math.round(numbers.quoteValidityDays as number),
        materialMarkupPct: numbers.materialMarkupPct as number,
        laborRate: numbers.laborRate as number,
        defaultMarginPct: numbers.defaultMarginPct as number,
        toleranceIn: numbers.toleranceIn as number,
        certifications: splitList(v.certifications),
        outsideProcesses: suppliers.map((s) => ({
          ...s,
          leadTimeDays:
            s.leadTimeDays === null ? null : Math.round(s.leadTimeDays),
        })),
        signature: v.signature.trim() || null,
        replyIntro: v.replyIntro.trim() || null,
      });
      setMessage(
        r.ok
          ? { error: false, text: "Saved. New estimates use these settings." }
          : { error: true, text: r.error }
      );
    });
  };

  return (
    <div className="grid max-w-4xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Pricing</CardTitle>
          <CardDescription>
            Used when Takumo prices an RFQ. Machines with their own hourly rate
            use that instead of the labor rate.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            hint="Added to what the material costs you."
            id="markup"
            label="Material markup (%)"
          >
            <Input
              disabled={disabled}
              id="markup"
              inputMode="decimal"
              onChange={(e) => set("materialMarkupPct")(e.target.value)}
              value={v.materialMarkupPct}
            />
          </Field>
          <Field
            hint="For machines without an hourly rate."
            id="rate"
            label="Shop labor rate ($/hour)"
          >
            <Input
              disabled={disabled}
              id="rate"
              inputMode="decimal"
              onChange={(e) => set("laborRate")(e.target.value)}
              value={v.laborRate}
            />
          </Field>
          <Field
            hint="Used until you have won quotes with known costs; after that, drafts use the margins you actually win at."
            id="margin"
            label="Default margin (%)"
          >
            <Input
              disabled={disabled}
              id="margin"
              inputMode="decimal"
              onChange={(e) => set("defaultMarginPct")(e.target.value)}
              value={v.defaultMarginPct}
            />
          </Field>
          <Field
            hint="Tighter tolerances on a drawing are flagged for a check."
            id="tolerance"
            label="Tightest tolerance you hold (± inches)"
          >
            <Input
              disabled={disabled}
              id="tolerance"
              inputMode="decimal"
              onChange={(e) => set("toleranceIn")(e.target.value)}
              value={v.toleranceIn}
            />
          </Field>
          <Field id="validity" label="Quotes are valid for (days)">
            <Input
              disabled={disabled}
              id="validity"
              inputMode="numeric"
              onChange={(e) => set("quoteValidityDays")(e.target.value)}
              value={v.quoteValidityDays}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field
              hint="One per line or separated by commas, e.g. AS9100, ISO 9001, ITAR. Drawings asking for others are flagged."
              id="certs"
              label="Certifications you hold"
            >
              <Textarea
                disabled={disabled}
                id="certs"
                onChange={(e) => set("certifications")(e.target.value)}
                rows={2}
                value={v.certifications}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outside processes</CardTitle>
          <CardDescription>
            What you send out (anodize, heat treat, plating…), who does it, how
            long it takes and what it costs. Finishes on a drawing are priced
            from here; anything not listed is flagged to ask your supplier.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {v.suppliers.length > 0 && (
            <div className="hidden grid-cols-[1.4fr_1.2fr_0.7fr_0.8fr_0.8fr_auto] gap-2 text-muted-foreground text-xs sm:grid">
              <span>Process</span>
              <span>Supplier</span>
              <span>Lead days</span>
              <span>$ per part</span>
              <span>$ per lot</span>
              <span className="w-9" />
            </div>
          )}
          {v.suppliers.map((r) => (
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_1.2fr_0.7fr_0.8fr_0.8fr_auto]"
              key={r.key}
            >
              <Input
                aria-label="Process"
                disabled={disabled}
                onChange={(e) => setRow(r.key, "process", e.target.value)}
                placeholder="Anodize type II"
                value={r.process}
              />
              <Input
                aria-label="Supplier"
                disabled={disabled}
                onChange={(e) => setRow(r.key, "supplier", e.target.value)}
                placeholder="Supplier"
                value={r.supplier}
              />
              <Input
                aria-label="Lead time in days"
                disabled={disabled}
                inputMode="numeric"
                onChange={(e) => setRow(r.key, "leadTimeDays", e.target.value)}
                placeholder="Days"
                value={r.leadTimeDays}
              />
              <Input
                aria-label="Cost per part"
                disabled={disabled}
                inputMode="decimal"
                onChange={(e) => setRow(r.key, "costPerPart", e.target.value)}
                placeholder="$/part"
                value={r.costPerPart}
              />
              <Input
                aria-label="Lot charge"
                disabled={disabled}
                inputMode="decimal"
                onChange={(e) => setRow(r.key, "lotCharge", e.target.value)}
                placeholder="$/lot"
                value={r.lotCharge}
              />
              <Button
                aria-label={`Remove ${r.process || "process"}`}
                disabled={disabled}
                onClick={() =>
                  setV({
                    ...v,
                    suppliers: v.suppliers.filter((x) => x.key !== r.key),
                  })
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {canEdit && (
            <div>
              <Button
                disabled={disabled}
                onClick={() => {
                  nextKey += 1;
                  setV({
                    ...v,
                    suppliers: [
                      ...v.suppliers,
                      {
                        key: nextKey,
                        process: "",
                        supplier: "",
                        leadTimeDays: "",
                        costPerPart: "",
                        lotCharge: "",
                      },
                    ],
                  });
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon /> Add process
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reply email</CardTitle>
          <CardDescription>
            How the draft reply to the customer opens and is signed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field
            hint="Leave empty for: Thanks for the opportunity to quote."
            id="intro"
            label="Opening line"
          >
            <Textarea
              disabled={disabled}
              id="intro"
              onChange={(e) => set("replyIntro")(e.target.value)}
              rows={2}
              value={v.replyIntro}
            />
          </Field>
          <Field id="signature" label="Signature">
            <Textarea
              disabled={disabled}
              id="signature"
              onChange={(e) => set("signature")(e.target.value)}
              placeholder={
                "Jane Smith\nEstimating, Acme Machining\n(555) 123-4567"
              }
              rows={4}
              value={v.signature}
            />
          </Field>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex items-center gap-3">
          <Button disabled={pending} onClick={save} type="button">
            {pending && <Spinner />} Save
          </Button>
          {message && (
            <span
              className={
                message.error
                  ? "text-destructive text-sm"
                  : "text-muted-foreground text-sm"
              }
            >
              {message.text}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
