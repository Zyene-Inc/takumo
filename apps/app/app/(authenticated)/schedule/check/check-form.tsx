"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
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
import type { CapacityResponse } from "@repo/engine-client/types";
import { ZapIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { addDays, localToday } from "../gantt";
import { type CheckFormValues, checkOrder } from "./actions";
import { Answer, money } from "./answer";

export interface PartOption {
  id: string;
  label: string;
  /** Material cost per part we already know (material priced per each). */
  materialCost: number | null;
  /** Price per unit from the latest order or won quote, for a suggestion. */
  unitPrice: number | null;
}

export const CheckForm = ({
  parts,
  customers,
  canEdit,
  initialPartId,
  initialAnswer = null,
  ordersFromErp = false,
}: {
  canEdit: boolean;
  customers: string[];
  /** A saved check opened from a link (e.g. Takumo's email answer). */
  initialAnswer?: {
    orderNo: string;
    result: CapacityResponse;
    runId: string;
  } | null;
  initialPartId?: string;
  /** The ERP sends orders: a new one is entered there, not added here. */
  ordersFromErp?: boolean;
  parts: PartOption[];
}) => {
  const [values, setValues] = useState({
    partId: initialPartId ?? "",
    qty: "",
    dueDate: "",
    customer: "",
    orderNo: "",
    price: "",
    materialCost: "",
  });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{
    runId: string;
    orderNo: string;
    result: CapacityResponse;
  } | null>(initialAnswer);

  const part = parts.find((p) => p.id === values.partId);
  const qty = Number(values.qty);
  const suggestedPrice =
    part?.unitPrice && qty > 0 ? Math.round(part.unitPrice * qty) : null;
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = () =>
    start(async () => {
      setError(null);
      setAnswer(null);
      const payload: CheckFormValues = {
        ...values,
        price: values.price || (suggestedPrice ? String(suggestedPrice) : ""),
        materialCost:
          values.materialCost ||
          (part?.materialCost !== null && part?.materialCost !== undefined
            ? String(part.materialCost)
            : ""),
        today: localToday(),
      };
      const response = await checkOrder(payload);
      if (response.ok) {
        setAnswer({
          runId: response.runId,
          orderNo: response.input.orderNo,
          result: response.result,
        });
      } else {
        setError(response.error);
      }
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <form
        className="grid content-start gap-4 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="check-part">
            Part<span className="text-destructive">*</span>
          </Label>
          <Select onValueChange={(v) => set("partId", v)} value={values.partId}>
            <SelectTrigger id="check-part">
              <SelectValue placeholder="Choose a part" />
            </SelectTrigger>
            <SelectContent>
              {parts.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="check-qty">
              Quantity<span className="text-destructive">*</span>
            </Label>
            <Input
              id="check-qty"
              inputMode="numeric"
              min={1}
              onChange={(e) => set("qty", e.target.value)}
              required
              step={1}
              type="number"
              value={values.qty}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="check-due">
              Due date<span className="text-destructive">*</span>
            </Label>
            <Input
              id="check-due"
              min={addDays(localToday(), 0)}
              onChange={(e) => set("dueDate", e.target.value)}
              required
              type="date"
              value={values.dueDate}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="check-customer">Customer</Label>
          <Input
            id="check-customer"
            list="check-customers"
            onChange={(e) => set("customer", e.target.value)}
            value={values.customer}
          />
          <datalist id="check-customers">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="check-price">Order price ($)</Label>
            <Input
              id="check-price"
              min={0}
              onChange={(e) => set("price", e.target.value)}
              placeholder={suggestedPrice ? String(suggestedPrice) : ""}
              step="any"
              type="number"
              value={values.price}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="check-material">Material per part ($)</Label>
            <Input
              id="check-material"
              min={0}
              onChange={(e) => set("materialCost", e.target.value)}
              placeholder={
                part?.materialCost !== null && part?.materialCost !== undefined
                  ? String(part.materialCost)
                  : ""
              }
              step="any"
              type="number"
              value={values.materialCost}
            />
          </div>
        </div>
        {suggestedPrice && !values.price && (
          <p className="text-muted-foreground text-xs">
            Price defaults to {money(suggestedPrice)}, from this part's last
            price per unit.
          </p>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="check-orderno">Order number</Label>
          <Input
            id="check-orderno"
            onChange={(e) => set("orderNo", e.target.value)}
            placeholder="Assigned automatically"
            value={values.orderNo}
          />
        </div>
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <ZapIcon />}
          {pending ? "Running the scheduler…" : "Check capacity"}
        </Button>
        {pending && (
          <p className="text-muted-foreground text-xs">
            Takumo plans the shop with and without this order, then tries
            overtime and a split lot. This takes a few seconds.
          </p>
        )}
      </form>

      <div className="min-w-0">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn't check this order</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {answer ? (
          <Answer
            canEdit={canEdit}
            orderNo={answer.orderNo}
            ordersFromErp={ordersFromErp}
            result={answer.result}
            runId={answer.runId}
          />
        ) : (
          !error && (
            <div className="flex h-full min-h-48 items-center justify-center rounded-xl border border-dashed p-8 text-center text-muted-foreground text-sm">
              Enter a part, quantity and due date. Takumo answers from your real
              machine load, calendar and routings.
            </div>
          )
        )}
      </div>
    </div>
  );
};
