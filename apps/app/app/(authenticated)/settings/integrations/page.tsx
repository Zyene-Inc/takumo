import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { getBilling } from "@/lib/billing";
import { credentials } from "@/lib/connectors/config";
import { Header } from "../../components/header";
import { ConnectorCard, type ConnectorView } from "./connector-card";

export const metadata: Metadata = { title: "Integrations · Takumo" };

const IntegrationsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) => {
  const { orgId, canManageConnectors } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { connected, error } = await searchParams;
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
        settings: true,
      },
    }),
    getBilling(orgId),
  ]);
  const view = (
    provider: "quickbooks" | "gmail",
    name: string,
    description: string
  ): ConnectorView => {
    const c = connections.find((x) => x.provider === provider);
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
      query: (c?.settings as { query?: string } | null)?.query ?? null,
    };
  };
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
        {locked && (
          <p className="text-muted-foreground text-sm">
            Connectors are on the Pro plan. See Settings → Billing.
          </p>
        )}
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
              "Your RFQ inbox: new emails that look like requests for quote (attachments included) become RFQs in Quotes, read and ready to draft. Read only; checked every hour."
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
