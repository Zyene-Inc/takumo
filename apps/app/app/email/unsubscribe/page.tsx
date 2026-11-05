import type { Metadata } from "next";
import Link from "next/link";
import { checkUnsubscribe, describeUnsubscribe } from "@/lib/brief/unsubscribe";
import { EmailShell } from "../shell";
import { UnsubscribeForm } from "./form";

export const metadata: Metadata = { title: "Unsubscribe · Takumo" };

const UnsubscribePage = async ({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) => {
  const { t } = await searchParams;
  const checked = checkUnsubscribe(t, new Date());
  if (!checked.ok) {
    return (
      <EmailShell title="Unsubscribe">
        <p>{checked.error}</p>
        <Link className="text-sm underline" href="/settings/notifications">
          Open the settings
        </Link>
      </EmailShell>
    );
  }
  return (
    <EmailShell title="Unsubscribe">
      <p>Stop {describeUnsubscribe(checked.payload.s)}?</p>
      <UnsubscribeForm token={t ?? ""} />
    </EmailShell>
  );
};

export default UnsubscribePage;
