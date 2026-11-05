"use client";

// The RFQ's details: customer, dates, channel and files.

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { CheckIcon, CopyIcon, PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import type { RfqView } from "@/lib/quotes/view";
import { updateRfq } from "../actions";

export const Section = ({
  title,
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) => (
  <section className="rounded-xl border">
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
      <h2 className="font-medium text-sm">{title}</h2>
      {action}
    </div>
    <div className="p-4">{children}</div>
  </section>
);

export const CopyButton = ({
  text,
  label,
}: {
  label: string;
  text: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      size="sm"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : label}
    </Button>
  );
};

export const RfqDetails = ({
  rfq,
  editable,
}: {
  editable: boolean;
  rfq: RfqView;
}) => {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({
    customerName: rfq.customerName ?? "",
    contact: rfq.contact ?? "",
    requestedDate: rfq.requestedDate ?? "",
    notes: rfq.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  if (editing) {
    return (
      <Section title="Request">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateRfq(rfq.id, values);
              if (r.ok) {
                setEditing(false);
                setError(null);
                router.refresh();
              } else {
                setError(r.error);
              }
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-customer">Customer</Label>
              <Input
                id="rfq-customer"
                list="rfq-customers"
                onChange={(e) => set("customerName", e.target.value)}
                value={values.customerName}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-contact">Contact</Label>
              <Input
                id="rfq-contact"
                onChange={(e) => set("contact", e.target.value)}
                value={values.contact}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-needed">Needed by</Label>
              <Input
                id="rfq-needed"
                onChange={(e) => set("requestedDate", e.target.value)}
                type="date"
                value={values.requestedDate}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rfq-notes">Requirements</Label>
            <Textarea
              id="rfq-notes"
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              value={values.notes}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending} size="sm" type="submit">
              {pending && <Spinner />} Save
            </Button>
            <Button
              onClick={() => setEditing(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </form>
      </Section>
    );
  }

  const facts: [string, ReactNode][] = [
    [
      "Customer",
      rfq.customerName ? (
        <span key="customer">
          {rfq.customerName}{" "}
          {!rfq.customerKnown && (
            <Badge className="ml-1" variant="outline">
              New customer
            </Badge>
          )}
        </span>
      ) : (
        <span className="text-destructive" key="customer">
          Not found: add it
        </span>
      ),
    ],
    ["Contact", rfq.contact ?? "—"],
    ["Needed by", rfq.requestedDate ?? "Not stated"],
    ["Payment terms", rfq.paymentTermDays ? `Net ${rfq.paymentTermDays}` : "—"],
  ];
  return (
    <Section
      action={
        editable && (
          <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
            <PencilIcon /> Edit
          </Button>
        )
      }
      title="Request"
    >
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div className="flex gap-2" key={label}>
            <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {rfq.notes && (
        <p className="mt-3 whitespace-pre-line text-sm">
          <span className="text-muted-foreground">Requirements: </span>
          {rfq.notes}
        </p>
      )}
    </Section>
  );
};
