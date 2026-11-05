import type { Metadata } from "next";
import Link from "next/link";
import {
  type ActionView,
  checkActionLink,
  describeAction,
} from "@/lib/brief/act";
import { EmailShell } from "../shell";
import { ConfirmForm } from "./confirm-form";

export const metadata: Metadata = { title: "Confirm · Takumo" };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const FactConfirm = ({
  view,
  token,
}: {
  token: string;
  view: Extract<ActionView, { kind: "fact" }>;
}) => {
  const approve = view.decision === "approve";
  return (
    <EmailShell title={approve ? "Approve this fact?" : "Reject this fact?"}>
      <p className="rounded-lg border p-4">{view.text}</p>
      <p className="text-muted-foreground text-sm">
        {approve
          ? "Approving changes this value in Takumo from now on (plans and quotes use it)."
          : "Rejecting keeps the current value. The fact stays in the history."}
      </p>
      <ConfirmForm
        label={approve ? "Approve" : "Reject"}
        qtys={null}
        token={token}
      />
    </EmailShell>
  );
};

const QuoteConfirm = ({
  view,
  token,
}: {
  token: string;
  view: Extract<ActionView, { kind: "quote" }>;
}) => {
  const won = view.decision === "won";
  const quote = `${view.quoteNo}${view.customer ? ` for ${view.customer}` : ""}`;
  return (
    <EmailShell title={`${view.quoteNo}: ${won ? "won" : "lost"}?`}>
      <p>
        {won
          ? `Mark ${quote} as won. The order goes on your order list (or the list to enter in your ERP).`
          : `Mark ${quote} as lost. It counts in your win rate.`}
      </p>
      <ConfirmForm
        label={won ? "Mark won" : "Mark lost"}
        qtys={
          won
            ? view.breaks.map((b) => ({
                qty: b.qty,
                label: `${b.qty.toLocaleString("en-US")} pcs at ${money(b.unitPrice)} (${money(b.price)})`,
              }))
            : null
        }
        token={token}
      />
    </EmailShell>
  );
};

// What an approve / reject / won / lost button in an email will do. Opening
// it changes nothing (mail apps and scanners open links); the button does.
const ActPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) => {
  const { t = "" } = await searchParams;
  const checked = await checkActionLink(t, new Date());
  const described = checked.ok
    ? await describeAction(checked.payload)
    : checked;
  if (!described.ok) {
    return (
      <EmailShell title="Nothing to do">
        <p>{described.error}</p>
        <Link className="text-sm underline" href="/">
          Open Takumo
        </Link>
      </EmailShell>
    );
  }
  return described.view.kind === "fact" ? (
    <FactConfirm token={t} view={described.view} />
  ) : (
    <QuoteConfirm token={t} view={described.view} />
  );
};

export default ActPage;
