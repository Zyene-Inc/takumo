import { auth, listUserOrganizations, withAuth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { secure } from "@repo/security";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { env } from "@/env";
import { getBilling } from "@/lib/billing";
import { AppShell } from "./components/app-shell";
import { BillingBanner } from "./components/billing-banner";
import { Identify } from "./components/identify";
import type { Pulse } from "./components/nav";
import type { PlanBadge } from "./components/plan-pill";

interface AppLayoutProperties {
  readonly children: ReactNode;
}

const PAID_TONES: Record<string, PlanBadge["tone"]> = {
  plant: "ink",
  pro: "sky",
};

/** The header's plan badge, from the shop's billing state. */
const planBadge = (
  e: Awaited<ReturnType<typeof getBilling>>["entitlements"]
): PlanBadge => {
  switch (e.state) {
    case "trial":
      return { label: `Trial · ${e.trialDaysLeft}d`, tone: "sky" };
    case "expired":
      return { label: "Trial ended", tone: "red" };
    case "past_due":
      return { label: "Past due", tone: "red" };
    case "canceled":
      return { label: "Canceled", tone: "slate" };
    default:
      return {
        label: e.plan.name,
        tone: PAID_TONES[e.plan.key] ?? "slate",
      };
  }
};

/** What's waiting in the shop's queue, for the sidebar. */
const loadPulse = async (orgId: string): Promise<Pulse> => {
  const db = forOrg(database, orgId);
  const [rfqs, posToEnter] = await Promise.all([
    db.rfq.groupBy({
      by: ["status"],
      where: { status: { in: ["review", "failed", "drafted", "new_sender"] } },
      _count: true,
    }),
    db.customerPo.count({ where: { status: "review" } }),
  ]);
  const count = (...statuses: string[]) =>
    rfqs
      .filter((r) => statuses.includes(r.status))
      .reduce((sum, r) => sum + r._count, 0);
  return {
    rfqsToQuote: count("review", "failed"),
    drafts: count("drafted"),
    newSenders: count("new_sender"),
    posToEnter,
  };
};

const AppLayout = async ({ children }: AppLayoutProperties) => {
  if (env.ARCJET_KEY) {
    await secure(["CATEGORY:PREVIEW"]);
  }

  const { user } = await withAuth({ ensureSignedIn: true });
  // The shop from auth(), not the session: only while still a member of it.
  const { orgId: organizationId } = await auth();

  // Every page in the app works inside one shop (WorkOS organization).
  if (!organizationId) {
    redirect("/create-shop");
  }

  const [organizations, shop, billing, pulse] = await Promise.all([
    listUserOrganizations(user.id),
    database.org.findUnique({
      where: { id: organizationId },
      select: { name: true, plan: true, libraryStage: true },
    }),
    getBilling(organizationId),
    loadPulse(organizationId),
  ]);
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;

  return (
    <AppShell
      banner={<BillingBanner orgId={organizationId} />}
      currentOrganizationId={organizationId}
      libraryEnabled={Boolean(shop && shop.libraryStage !== "off")}
      organizations={organizations}
      plan={planBadge(billing.entitlements)}
      pulse={pulse}
      user={{
        name,
        email: user.email,
        imageUrl: user.profilePictureUrl,
      }}
    >
      <Identify
        shop={{
          id: organizationId,
          name: shop?.name ?? "",
          plan: shop?.plan ?? "trial",
        }}
        user={{ id: user.id, email: user.email, name }}
      />
      {children}
    </AppShell>
  );
};

export default AppLayout;
