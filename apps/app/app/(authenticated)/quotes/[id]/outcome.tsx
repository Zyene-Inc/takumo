"use client";

// Marking a sent quote won or lost.

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LineView } from "@/lib/quotes/view";
import { localToday } from "../../schedule/gantt";
import { recordLineOutcome } from "../actions";
import { ErpOrder } from "./erp-order";
import { usd, quoteHref, OUTCOME_VARIANT } from "./line-card-parts";

export const Outcome = ({
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
