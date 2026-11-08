import { auth, listUserOrganizations, withAuth } from "@repo/auth/server";
import { database } from "@repo/database";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { secure } from "@repo/security";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { env } from "@/env";
import { BillingBanner } from "./components/billing-banner";
import { Identify } from "./components/identify";
import { GlobalSidebar } from "./components/sidebar";

interface AppLayoutProperties {
  readonly children: ReactNode;
}

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

  const [organizations, shop] = await Promise.all([
    listUserOrganizations(user.id),
    database.org.findUnique({
      where: { id: organizationId },
      select: { name: true, plan: true, libraryStage: true },
    }),
  ]);
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;

  return (
    <SidebarProvider>
      <GlobalSidebar
        currentOrganizationId={organizationId}
        libraryEnabled={Boolean(shop && shop.libraryStage !== "off")}
        organizations={organizations}
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
        <BillingBanner orgId={organizationId} />
        {children}
      </GlobalSidebar>
    </SidebarProvider>
  );
};

export default AppLayout;
