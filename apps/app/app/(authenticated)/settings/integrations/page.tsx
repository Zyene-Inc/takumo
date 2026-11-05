import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { getBilling } from "@/lib/billing";
import { adminConsentRedirectUri, credentials } from "@/lib/connectors/config";
import { canDraft } from "@/lib/connectors/gmail";
import { adminConsentUrl } from "@/lib/connectors/outlook";
import { readRules } from "@/lib/connectors/rfq-rules";
import { Header } from "../../components/header";
import { ConnectorCard, type ConnectorView } from "./connector-card";

export const metadata: Metadata = { title: "Integrations · Takumo" };

const IntegrationsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{
    adminConsent?: string;
    connected?: string;
    error?: string;
  }>;
}) => {
  const { orgId, canManageConnectors } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { adminConsent, connected, error } = await searchParams;
  const [connections, { entitlements }] = await Promise.all([
    forOrg(database, orgId).connection.findMany({
      select: {
        provider: true,
        status: true,
        accountLabel: true,
        account: true,
        lastSyncAt: true,
        lastError: true,
        lastResult: true,
        scope: true,
        settings: true,
      },
    }),
    getBilling(orgId),
  ]);
  const view = (
    provider: ConnectorView["provider"],
    name: string,
    description: string
  ): ConnectorView => {
    const c = connections.find((x) => x.provider === provider);
    const settings = (c?.settings ?? null) as {
      folderName?: string | null;
      query?: string;
      sharedMailbox?: string | null;
      subscription?: object | null;
    } | null;
    return {
      provider,
      name,
      description,
      configured: credentials(provider) !== null,
      status: c?.status ?? null,
      account: c ? (c.accountLabel ?? c.account) : null,
      lastSyncAt: c?.lastSyncAt?.toISOString() ?? null,
      lastError: c?.lastError ?? null,
      lastNotes: (
        (c?.lastResult as { notes?: string[] } | null)?.notes ?? []
      ).slice(0, 6),
      query: settings?.query ?? null,
      sharedMailbox: settings?.sharedMailbox ?? null,
      folderName: settings?.folderName ?? null,
      rules: readRules(c?.settings),
      instant: Boolean(settings?.subscription),
      // Connected before Takumo asked to write drafts: reconnect once.
      needsDraftAccess:
        provider === "gmail" && c?.status === "connected" && !canDraft(c.scope),
    };
  };
  const outlookCreds = credentials("outlook");
  const consentUrl =
    adminConsent === "outlook" && outlookCreds
      ? adminConsentUrl(outlookCreds.clientId, adminConsentRedirectUri())
      : null;
  const locked = !entitlements.features.has("connectors");

  return (
    <>
      <Header page="Integrations" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {connected && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 text-sm dark:bg-emerald-950 dark:text-emerald-200">
            Connected. The first sync is running; refresh in a minute to see
            what came in.
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {error}
          </p>
        )}
        {consentUrl && (
          <div className="grid gap-2 rounded-lg border px-3 py-3 text-sm">
            <p className="font-medium">
              Ask your IT person to approve Takumo for Outlook
            </p>
            <p className="text-muted-foreground">
              Your company's Microsoft 365 only lets an administrator approve
              new apps. Send this link to whoever manages Microsoft 365 for you.
              They sign in as an administrator (for example a Global
              Administrator), review the permissions (sign in and read your
              profile, read and write mail including shared mailboxes you can
              open, keep access when you're away) and click Accept. Takumo reads
              RFQ emails and can leave reply drafts; it never sends email. Once
              they've approved, come back here and connect Outlook again.
            </p>
            <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {consentUrl}
            </p>
          </div>
        )}
        {locked && (
          <p className="text-muted-foreground text-sm">
            Connectors are on the Pro plan. See Settings → Billing.
          </p>
        )}
        <Link
          className="flex flex-col gap-1 rounded-xl border p-4 transition-colors hover:bg-muted/50"
          href="/settings/integrations/email"
        >
          <span className="font-medium">Email &amp; ERP reports →</span>
          <span className="text-muted-foreground text-sm">
            Your shop's addresses for nightly ERP reports (Epicor, JobBOSS²,
            ProShop, NetSuite, SAP: any ERP that can email a CSV or Excel
            report), for RFQs from portals and forms, for questions and for
            documents.
          </span>
        </Link>
        <Link
          className="flex flex-col gap-1 rounded-xl border p-4 transition-colors hover:bg-muted/50"
          href="/settings/integrations/phone"
        >
          <span className="font-medium">Notes by text →</span>
          <span className="text-muted-foreground text-sm">
            Operators send voice notes and texts from their phone (SMS or
            WhatsApp); Takumo reads them for facts and texts back what it
            found.
          </span>
        </Link>
        <div className="grid gap-4 lg:grid-cols-2">
          <ConnectorCard
            c={view(
              "quickbooks",
              "QuickBooks",
              "Customers with their payment terms, and estimates from the last three years as past quotes (won, lost or open), so pricing and win rates use your real history. Read only; synced every hour."
            )}
            canManage={canManageConnectors && !locked}
          />
          <ConnectorCard
            c={view(
              "gmail",
              "Gmail",
              "Your RFQ inbox: new emails that look like requests for quote (attachments included) become RFQs in Quotes, read and ready to draft. Checked every hour. Takumo can leave reply drafts in the RFQ's thread for you to send; it never sends email itself."
            )}
            canManage={canManageConnectors && !locked}
          />
          <ConnectorCard
            c={view(
              "outlook",
              "Outlook",
              "Your Microsoft 365 RFQ inbox, or a shared RFQ mailbox: new emails that look like requests for quote (attachments included) become RFQs in Quotes within a couple of minutes. Takumo can leave reply drafts for you to send; it never sends email itself."
            )}
            canManage={canManageConnectors && !locked}
          />
        </div>
        {!canManageConnectors && (
          <p className="text-muted-foreground text-sm">
            Only the shop's owner or an admin can connect outside systems.
          </p>
        )}
      </div>
    </>
  );
};

export default IntegrationsPage;
