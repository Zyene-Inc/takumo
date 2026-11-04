"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import type { CapacityResponse, Lever } from "@repo/engine-client/types";
import {
  CheckCircle2Icon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addDays, fmtDay, localToday } from "../gantt";
import {
  addToPlan,
  type CheckFormValues,
  checkOrder,
  recordVerdict,
} from "./actions";

export interface PartOption {
  id: string;
  label: string;
  /** Material cost per part we already know (material priced per each). */
  materialCost: number | null;
  /** Price per unit from the latest order or won quote, for a suggestion. */
  unitPrice: number | null;
}

const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

const leverCost = (extra: number | null) => {
  if (extra === null) {
    return "cost unknown";
  }
  return extra === 0 ? "no extra cost" : `+${money(extra)}`;
};

const LEVER_NAME: Record<Lever["kind"], string> = {
  overtime: "Overtime",
  alternate_machine: "Alternate machine",
  split_lot: "Split the lot",
};

export const CheckForm = ({
  parts,
  customers,
  canEdit,
  initialPartId,
  ordersFromErp = false,
}: {
  canEdit: boolean;
  customers: string[];
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
  } | null>(null);

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

const Answer = ({
  result,
  runId,
  orderNo,
  canEdit,
  ordersFromErp,
}: {
  canEdit: boolean;
  orderNo: string;
  ordersFromErp: boolean;
  result: CapacityResponse;
  runId: string;
}) => {
  const fit = result.new_order;
  const rush = result.rush;
  const cost = result.cost;

  return (
    <div className="grid gap-4">
      <div
        className={
          result.can_take
            ? "rounded-xl border border-primary/40 bg-primary/5 p-5"
            : "rounded-xl border border-destructive/40 bg-destructive/5 p-5"
        }
      >
        <div className="flex items-center gap-2">
          {result.can_take ? (
            <CheckCircle2Icon className="size-6 text-primary" />
          ) : (
            <XCircleIcon className="size-6 text-destructive" />
          )}
          <h2 className="font-semibold text-xl">
            {result.can_take ? "Yes, we can take it" : "Not without changes"}
          </h2>
          <Badge className="ml-auto" variant="outline">
            {orderNo}
          </Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed">{result.explanation}</p>
        {fit && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Due</dt>
              <dd className="font-medium">{fmtDay(fit.due_date)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Earliest, nobody moves</dt>
              <dd className="font-medium">
                {fmtDay(fit.completion_date)}
                {fit.days_late > 0 && (
                  <span className="text-destructive"> (+{fit.days_late}d)</span>
                )}
              </dd>
            </div>
            {rush && !result.can_take && (
              <div>
                <dt className="text-muted-foreground">If it goes first</dt>
                <dd className="font-medium">
                  {fmtDay(rush.completion_date)}
                  {rush.days_late > 0 && (
                    <span className="text-destructive">
                      {" "}
                      (+{rush.days_late}d)
                    </span>
                  )}
                </dd>
              </div>
            )}
            {cost?.margin_pct !== null && cost?.margin_pct !== undefined && (
              <div>
                <dt className="text-muted-foreground">Margin</dt>
                <dd className="font-medium">
                  {cost.margin_pct}% ({money(cost.margin)})
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {result.slipped.length > 0 && (
        <section className="rounded-xl border p-4">
          <h3 className="font-semibold">If it goes first, these slip</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">Days late now</TableHead>
                <TableHead className="text-right">Days late after</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...result.slipped]
                .sort(
                  (a, b) =>
                    b.days_late_after -
                    b.days_late_before -
                    (a.days_late_after - a.days_late_before)
                )
                .map((s) => (
                  <TableRow key={s.order_no}>
                    <TableCell className="font-medium">{s.order_no}</TableCell>
                    <TableCell className="text-right">
                      {s.days_late_before}
                    </TableCell>
                    <TableCell className="text-right text-destructive">
                      {s.days_late_after}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </section>
      )}

      {result.levers.length > 0 && (
        <section className="rounded-xl border p-4">
          <h3 className="font-semibold">Levers</h3>
          <p className="text-muted-foreground text-sm">
            Each one tried on its own, without slipping any other order.
            Cheapest on-time option first.
          </p>
          <ul className="mt-3 grid gap-2">
            {result.levers.map((lever) => (
              <li
                className="rounded-lg bg-muted/40 p-3 text-sm"
                key={lever.kind}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{LEVER_NAME[lever.kind]}</span>
                  {lever.on_time ? (
                    <Badge variant="secondary">Makes the date</Badge>
                  ) : (
                    <Badge variant="outline">Not enough on its own</Badge>
                  )}
                  {lever.completion_date && (
                    <span className="text-muted-foreground">
                      finishes {fmtDay(lever.completion_date)}
                    </span>
                  )}
                  <span className="ml-auto font-medium">
                    {leverCost(lever.extra_cost)}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {lever.description}
                </p>
                {lever.extra_cost !== null &&
                cost?.margin !== null &&
                cost?.margin !== undefined &&
                cost.price ? (
                  <p className="mt-1 text-muted-foreground">
                    Margin with this lever:{" "}
                    {(
                      ((cost.margin - lever.extra_cost) / cost.price) *
                      100
                    ).toFixed(1)}
                    %
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cost && (
        <section className="rounded-xl border p-4">
          <h3 className="font-semibold">Cost estimate</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-muted-foreground">Machine time</dt>
            <dd>{money(cost.machine)}</dd>
            <dt className="text-muted-foreground">Material</dt>
            <dd>{money(cost.material)}</dd>
            <dt className="text-muted-foreground">Total cost</dt>
            <dd className="font-medium">{money(cost.total)}</dd>
            <dt className="text-muted-foreground">Price</dt>
            <dd className="font-medium">{money(cost.price)}</dd>
          </dl>
          {cost.missing.length > 0 && (
            <p className="mt-2 text-muted-foreground text-xs">
              Missing for a full cost: {cost.missing.join(", ")}. Add them on
              the{" "}
              <Link className="underline" href="/shop/work-centers">
                machines
              </Link>{" "}
              or{" "}
              <Link className="underline" href="/shop/materials">
                materials
              </Link>{" "}
              pages, or enter a material cost above.
            </p>
          )}
          <p className="mt-2 text-muted-foreground text-xs">
            Machine time at each machine's hourly rate on the machines the plan
            uses. Overtime is costed at a 50% premium on the machine rate.
          </p>
        </section>
      )}

      <AddToPlan
        canEdit={canEdit}
        canRush={!result.can_take && rush?.days_late === 0}
        ordersFromErp={ordersFromErp}
        runId={runId}
      />

      {canEdit && <Verdict runId={runId} />}
    </div>
  );
};

/** Adding the checked order to the plan (or where to enter it instead). */
const AddToPlan = ({
  canEdit,
  canRush,
  ordersFromErp,
  runId,
}: {
  canEdit: boolean;
  canRush: boolean;
  ordersFromErp: boolean;
  runId: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = (rushed: boolean) =>
    start(async () => {
      setError(null);
      const response = await addToPlan({
        runId,
        rush: rushed,
        today: localToday(),
      });
      if (response.ok) {
        setAdded(response.orderNo);
        router.refresh();
      } else {
        setError(response.error);
      }
    });

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
      {added && (
        <p className="text-sm">
          Added {added} to the plan.{" "}
          <Link className="underline" href="/schedule">
            See it on the board
          </Link>
          .
        </p>
      )}
      {!added && canEdit && ordersFromErp && (
        <p className="text-muted-foreground text-sm">
          Your ERP sends your orders: enter this order there, and it's planned
          here after the next report.
        </p>
      )}
      {!added && canEdit && !ordersFromErp && (
        <>
          <Button disabled={pending} onClick={() => add(false)}>
            {pending && <Spinner />} Add to plan
          </Button>
          {canRush && (
            <Button
              disabled={pending}
              onClick={() => add(true)}
              variant="outline"
            >
              Add as rush (goes first)
            </Button>
          )}
          <span className="text-muted-foreground text-xs">
            Creates the order and re-plans the shop.
          </span>
        </>
      )}
      {!(added || canEdit) && (
        <p className="text-muted-foreground text-sm">
          Ask a planner to add this order to the plan.
        </p>
      )}
      {error && <p className="w-full text-destructive text-sm">{error}</p>}
    </section>
  );
};

const Verdict = ({ runId }: { runId: string }) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<"agree" | "disagree" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = (verdict: "agree" | "disagree") =>
    start(async () => {
      const response = await recordVerdict({ runId, verdict, note });
      if (response.ok) {
        setSaved(verdict);
        setError(null);
        router.refresh();
      } else {
        setError(response.error);
      }
    });

  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <div>
        <h3 className="font-semibold">Does this match your judgment?</h3>
        <p className="text-muted-foreground text-sm">
          Your answer is how we check Takumo against real planning decisions.
        </p>
      </div>
      <Textarea
        aria-label="What would you have said? (optional)"
        onChange={(e) => setNote(e.target.value)}
        placeholder="What would you have said? (optional)"
        rows={2}
        value={note}
      />
      <div className="flex items-center gap-2">
        <Button
          disabled={pending}
          onClick={() => save("agree")}
          size="sm"
          variant={saved === "agree" ? "default" : "outline"}
        >
          <ThumbsUpIcon /> Agree
        </Button>
        <Button
          disabled={pending}
          onClick={() => save("disagree")}
          size="sm"
          variant={saved === "disagree" ? "default" : "outline"}
        >
          <ThumbsDownIcon /> Disagree
        </Button>
        {saved && <span className="text-muted-foreground text-sm">Saved.</span>}
        {error && <span className="text-destructive text-sm">{error}</span>}
      </div>
    </section>
  );
};
