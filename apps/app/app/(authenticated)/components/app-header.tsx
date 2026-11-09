"use client";

// The top bar: [logo] > [shop] > [section] > [page]   [plan · search].
// Adapted from Warmbly's AppHeader (https://github.com/warmbly/warmbly,
// components/layout/AppHeader.tsx, Apache-2.0), modified for Takumo.

import type { UserOrganization } from "@repo/auth/server";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronRightIcon, MenuIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { crumbsFor, type NavSection } from "./nav";
import { type PlanBadge, PlanPill } from "./plan-pill";
import { Search } from "./search";
import { ShopSwitcher } from "./shop-switcher";

export const AppHeader = ({
  onMenu,
  sections,
  currentOrganizationId,
  organizations,
  plan,
}: {
  onMenu: () => void;
  sections: NavSection[];
  currentOrganizationId: string;
  organizations: UserOrganization[];
  plan: PlanBadge;
}) => {
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname, sections);

  return (
    <div className="flex h-14 shrink-0 items-center">
      <button
        aria-label="Open menu"
        className="ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-slate-200/60 hover:text-slate-900 md:hidden"
        onClick={onMenu}
        type="button"
      >
        <MenuIcon className="size-5" />
      </button>
      {/* Logo zone: as wide as the sidebar, so the breadcrumb lines up with
          the content panel below. */}
      <Link
        className="group flex h-full shrink-0 items-center pr-3 pl-2 md:w-64 md:px-5"
        href="/"
      >
        <Logo className="flex items-center gap-2.5 text-slate-900 transition-colors duration-150 group-hover:text-slate-700 [&>span:last-child]:hidden md:[&>span:last-child]:inline" />
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 md:pr-4">
        <div className="min-w-0 max-w-32 md:shrink-0 lg:max-w-48">
          <ShopSwitcher
            currentOrganizationId={currentOrganizationId}
            organizations={organizations}
          />
        </div>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
          <ol className="flex min-w-0 items-center gap-2">
            {crumbs.map(({ label, href }, index) => {
              const current = index === crumbs.length - 1;
              return (
                <li className="flex min-w-0 items-center gap-2" key={href}>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-slate-300"
                  />
                  {current ? (
                    <span
                      aria-current="page"
                      className="truncate font-medium text-[13px] text-slate-900"
                      title={label}
                    >
                      {label}
                    </span>
                  ) : (
                    <Link
                      className={cn(
                        "truncate text-[13px] text-slate-500 transition-colors hover:text-slate-900"
                      )}
                      href={href}
                      title={label}
                    >
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 sm:gap-2 sm:px-4">
        <div className="hidden items-center gap-2 sm:flex">
          <PlanPill badge={plan} />
          <div className="hidden h-4 w-px bg-slate-200/80 lg:block" />
        </div>
        <Search />
      </div>
    </div>
  );
};
