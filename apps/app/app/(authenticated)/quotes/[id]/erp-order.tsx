"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { erpEntryText } from "@/lib/quotes/erp-entry";
import type { ErpOrderEntry } from "@/lib/quotes/types";

/**
 * A won quote, laid out for the ERP: Takumo doesn't make the order itself
 * when the ERP sends the shop's orders; its next report brings it back.
 */
export const ErpOrder = ({
  entry,
  orderNo,
}: {
  entry: ErpOrderEntry;
  /** Set once the ERP's report brought the order back. */
  orderNo: string | null;
}) => {
  const [copied, setCopied] = useState(false);
  const text = erpEntryText(entry);
  return (
    <div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
      <p className="font-medium">
        {orderNo
          ? `In your ERP as order ${orderNo}.`
          : "Won. Enter this order in your ERP:"}
      </p>
      {!orderNo && (
        <>
          <pre className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-sans text-sm">
            {text}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              size="sm"
              variant="outline"
            >
              {copied ? <CheckIcon /> : <CopyIcon />} Copy
            </Button>
            <span className="text-muted-foreground text-xs">
              It shows up in Takumo with your ERP's next orders report.
            </span>
          </div>
        </>
      )}
    </div>
  );
};
