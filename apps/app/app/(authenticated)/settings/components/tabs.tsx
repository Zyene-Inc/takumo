"use client";

import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS } from "../../components/nav";

/** The settings pages, as a tab strip (Warmbly's section bar style). */
export const SettingsTabs = () => {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings"
      className="flex h-10 shrink-0 items-end gap-5 overflow-x-auto border-slate-200 border-b px-5"
    >
      {SETTINGS_TABS.map((tab) => {
        const active =
          pathname === tab.url || pathname.startsWith(`${tab.url}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-full shrink-0 items-center text-[12.5px] transition-colors",
              active
                ? "font-medium text-slate-900"
                : "text-slate-500 hover:text-slate-900"
            )}
            href={tab.url}
            key={tab.url}
          >
            {tab.title}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-0.5 bg-sky-600"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
};
