"use client";

// The app shell:
//
//   ┌──────────────────────────────────────────────────────┐
//   │  [logo]  >  [shop]  >  [section]          [plan  ⌘K] │  AppHeader
//   ├──────────┬───────────────────────────────────────────┤
//   │          │ ╭─── content ──────────────────────────╮  │
//   │  AppNav  │ │                                      │  │
//   │          │ │                                      │  │
//   └──────────┴───────────────────────────────────────────┘
//
// Adapted from Warmbly's AppShell and SkyChrome
// (https://github.com/warmbly/warmbly, Apache-2.0), modified for Takumo.
// The header and sidebar share one calm chrome layer; the white content
// panel sits bottom-right with a rounded corner where it meets it.

import type { UserOrganization } from "@repo/auth/server";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { AppHeader } from "./app-header";
import { AppNav } from "./app-nav";
import { type Pulse, sectionsFor } from "./nav";
import type { PlanBadge } from "./plan-pill";
import type { UserMenuUser } from "./user-menu";

const CLOUDS = [
  {
    top: "-80px",
    left: "-60px",
    width: "520px",
    height: "240px",
    background: "rgba(255,255,255,0.95)",
    borderRadius: "50% 50% 18% 18%",
    filter: "blur(60px)",
    opacity: 0.7,
  },
  {
    top: "10%",
    right: "8%",
    width: "380px",
    height: "180px",
    background: "rgba(255,255,255,0.85)",
    borderRadius: "50% 50% 18% 18%",
    filter: "blur(70px)",
    opacity: 0.55,
  },
  {
    top: "32%",
    left: "26%",
    width: "300px",
    height: "140px",
    background: "rgba(255,255,255,0.9)",
    borderRadius: "50% 50% 22% 22%",
    filter: "blur(70px)",
    opacity: 0.45,
  },
] as const;

/** The off-white backdrop behind header and sidebar, with faint clouds. */
const Chrome = () => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden">
    <div className="absolute inset-0 bg-[#f5f6f8]" />
    {CLOUDS.map((style) => (
      <div className="absolute" key={style.top} style={style} />
    ))}
  </div>
);

export const AppShell = ({
  banner,
  children,
  currentOrganizationId,
  libraryEnabled,
  organizations,
  plan,
  pulse,
  user,
}: {
  banner?: ReactNode;
  children: ReactNode;
  currentOrganizationId: string;
  libraryEnabled: boolean;
  organizations: UserOrganization[];
  plan: PlanBadge;
  pulse: Pulse;
  user: UserMenuUser;
}) => {
  const sections = sectionsFor(libraryEnabled);
  // The mobile drawer; on md and up the sidebar is a static column.
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer on every navigation
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <div className="fixed inset-0 flex flex-col">
      <Chrome />
      <div className="relative z-10 flex h-full flex-col">
        {banner}
        <AppHeader
          currentOrganizationId={currentOrganizationId}
          onMenu={() => setNavOpen(true)}
          organizations={organizations}
          plan={plan}
          sections={sections}
        />
        <div className="flex min-h-0 flex-1">
          <AppNav
            onClose={() => setNavOpen(false)}
            open={navOpen}
            pulse={pulse}
            sections={sections}
            user={user}
          />
          {/* The white work surface; the inner corner softens on md and up,
              where the sidebar sits beside it. */}
          <main className="min-w-0 flex-1 overflow-hidden border-slate-200/70 border-t bg-white md:rounded-tl-2xl md:border-l">
            <div className="flex h-full flex-col overflow-auto">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
};
