import { listUserOrganizations, withAuth } from "@repo/auth/server";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { secure } from "@repo/security";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { env } from "@/env";
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

  const organizations = await listUserOrganizations(user.id);

  return (
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
        {children}
      </GlobalSidebar>
    </SidebarProvider>
  );
};

export default AppLayout;
