import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { quoteSettings } from "@/lib/quotes/settings";
import { Header } from "../../components/header";
import { QuotingForm, type QuotingView } from "./form";

export const metadata: Metadata = { title: "Quoting · Takumo" };

const text = (value: number | string | null | undefined) =>
  value === null || value === undefined ? "" : String(value);

const QuotingSettingsPage = async () => {
  const { orgId, canManageBilling } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const s = await quoteSettings(orgId);
  const initial: QuotingView = {
    quoteValidityDays: text(s.quoteValidityDays),
    materialMarkupPct: text(Math.round(s.materialMarkup * 10_000) / 100),
    laborRate: text(s.laborRate),
    defaultMarginPct: text(Math.round(s.defaultMargin * 10_000) / 100),
    toleranceIn: text(s.toleranceIn),
    certifications: s.certifications.join("\n"),
    signature: s.signature ?? "",
    replyIntro: s.replyIntro ?? "",
    suppliers: s.outsideProcesses.map((p, i) => ({
      key: i,
      process: p.process,
      supplier: p.supplier ?? "",
      leadTimeDays: text(p.leadTimeDays),
      costPerPart: text(p.costPerPart),
      lotCharge: text(p.lotCharge),
    })),
  };
  return (
    <>
      <Header page="Quoting" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          How your shop prices work. Takumo uses these when it prices an RFQ,
          and shows which number came from here.
          {!canManageBilling &&
            " Only the shop's owner or an admin can change them."}
        </p>
        <QuotingForm canEdit={canManageBilling} initial={initial} />
      </div>
    </>
  );
};

export default QuotingSettingsPage;
