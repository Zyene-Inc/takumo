"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { CheckIcon, CopyIcon, RotateCwIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { rotateAddress, saveSenders } from "./actions";

export interface AddressView {
  address: string | null;
  allowedSenders: string[];
  description: string;
  /** How to point portals, website forms and the like at this address. */
  help?: string[];
  kind: "erp" | "rfq" | "ask" | "docs";
  title: string;
}

// biome-ignore lint/suspicious/noAlert: a plain confirm is enough here
const confirmRotate = (message: string) => window.confirm(message);

/** One of the shop's inbound addresses: copy it, choose who may send to it. */
export const AddressCard = ({
  view,
  canManage,
}: {
  view: AddressView;
  canManage: boolean;
}) => {
  const [text, setText] = useState(view.allowedSenders.join("\n"));
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const copy = async () => {
    if (view.address) {
      await navigator.clipboard.writeText(view.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{view.title}</CardTitle>
        <CardDescription>{view.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {view.address ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {view.address}
            </code>
            <Button
              aria-label="Copy address"
              onClick={copy}
              size="icon"
              type="button"
              variant="outline"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Inbound email isn't set up on this Takumo yet.
          </p>
        )}
        {view.help && view.help.length > 0 && (
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground text-xs">
            {view.help.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        )}
        <div className="grid gap-2">
          {view.kind === "ask" || view.kind === "docs" ? (
            <p className="text-muted-foreground text-xs">
              Only people in your shop can use it: mail from the address they
              sign in to Takumo with, verified as really theirs. Anyone else is
              bounced.
            </p>
          ) : (
            <>
              <label
                className="font-medium text-sm"
                htmlFor={`senders-${view.kind}`}
              >
                Who may send to it
              </label>
              <Textarea
                disabled={!canManage || pending}
                id={`senders-${view.kind}`}
                onChange={(e) => setText(e.target.value)}
                placeholder={"reports@yourshop.com\n@yourshop.com"}
                rows={3}
                value={text}
              />
              <p className="text-muted-foreground text-xs">
                One per line: an address, or @domain for anyone at that domain.
                Mail from anyone else, or that can't be verified as really
                theirs, is bounced.
              </p>
            </>
          )}
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className={
                  view.kind === "ask" || view.kind === "docs"
                    ? "hidden"
                    : undefined
                }
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await saveSenders({ kind: view.kind, text });
                    setMessage(
                      r.ok
                        ? { error: false, text: "Saved." }
                        : { error: true, text: r.error }
                    );
                  })
                }
                size="sm"
                type="button"
              >
                {pending && <Spinner />} Save
              </Button>
              <Button
                disabled={pending || !view.address}
                onClick={() =>
                  confirmRotate(
                    "Make a new address? The current one stops working at once, so update your ERP or forwarding rule straight after."
                  ) &&
                  start(async () => {
                    const r = await rotateAddress(view.kind);
                    setMessage(
                      r.ok
                        ? { error: false, text: "New address made." }
                        : { error: true, text: r.error }
                    );
                  })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                <RotateCwIcon /> New address
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
      </CardContent>
    </Card>
  );
};
