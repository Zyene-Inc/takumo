import { listUserOrganizations, withAuth } from "@repo/auth/server";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { showBetaFeature } from "@repo/feature-flags";
import { secure } from "@repo/security";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { env } from "@/env";
import { NotificationsProvider } from "./components/notifications-provider";
import { GlobalSidebar } from "./components/sidebar";

interface AppLayoutProperties {
  readonly children: ReactNode;
}

const AppLayout = async ({ children }: AppLayoutProperties) => {
  if (env.ARCJET_KEY) {
    await secure(["CATEGORY:PREVIEW"]);
  }

  const { user, organizationId } = await withAuth({ ensureSignedIn: true });

  // Every page in the app works inside one shop (WorkOS organization).
  if (!organizationId) {
    redirect("/create-shop");
  }

  const [organizations, betaFeature] = await Promise.all([
    listUserOrganizations(user.id),
    showBetaFeature(),
  ]);

  return (
    <NotificationsProvider userId={user.id}>
      <SidebarProvider>
        <GlobalSidebar
          currentOrganizationId={organizationId}
          organizations={organizations}
          user={{
            name:
              [user.firstName, user.lastName].filter(Boolean).join(" ") ||
              user.email,
            email: user.email,
            imageUrl: user.profilePictureUrl,
          }}
        >
          {betaFeature && (
            <div className="m-4 rounded-full bg-blue-500 p-1.5 text-center text-sm text-white">
              Beta feature now available
            </div>
          )}
          {children}
        </GlobalSidebar>
      </SidebarProvider>
    </NotificationsProvider>
  );
};

export default AppLayout;
