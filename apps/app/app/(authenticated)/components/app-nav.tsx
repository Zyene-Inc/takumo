"use client";

// The sidebar. Adapted from Warmbly's AppNav
// (https://github.com/warmbly/warmbly, components/layout/AppNav.tsx,
// Apache-2.0), modified for Takumo: Takumo's sections and pages, a live panel
// with the shop's queue instead of mailbox telemetry, and no icon rail yet.

import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon, SettingsIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import {
  activeUrl,
  type NavItem,
  type NavSection,
  type Pulse,
  TOP_ITEMS,
} from "./nav";
import { UserMenu, type UserMenuUser } from "./user-menu";

const ROW =
  "group relative mx-3 flex h-7 w-[calc(100%-1.5rem)] items-center gap-2.5 rounded-md px-[9px] text-[12.5px] transition-colors";

const FOLDED_KEY = "takumo:nav-folded";

const NavRow = ({
  item,
  active,
  pulse,
}: {
  item: NavItem;
  active: boolean;
  pulse: Pulse;
}) => {
  const count = item.count?.(pulse) ?? 0;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        ROW,
        active
          ? "bg-slate-200/70 font-medium text-slate-900"
          : "text-slate-600 hover:bg-slate-200/40 hover:text-slate-900"
      )}
      href={item.url}
    >
      <item.icon
        className={cn(
          "size-3.5 shrink-0 transition-colors",
          active
            ? "text-slate-700"
            : "text-slate-400 group-hover:text-slate-600"
        )}
        strokeWidth={active ? 2 : 1.6}
      />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {count > 0 && (
        <span className="ml-auto font-mono text-[10.5px] text-slate-400 tabular-nums">
          {count > 999 ? "999+" : count}
        </span>
      )}
    </Link>
  );
};

const Section = ({
  section,
  active,
  pulse,
  folded,
  onToggle,
}: {
  section: NavSection;
  active: string | undefined;
  pulse: Pulse;
  folded: boolean;
  onToggle: () => void;
}) => {
  // Folded, a section keeps only the row you are on.
  const shown = folded
    ? section.items.filter((item) => item.url === active)
    : section.items;
  return (
    <div className="mt-4 border-slate-200/50 border-t pt-4">
      <button
        aria-expanded={!folded}
        className="group/section mx-3 mb-1 flex h-6 w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-md px-[9px] font-medium text-[10px] text-slate-400 uppercase tracking-[0.14em] transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        onClick={onToggle}
        type="button"
      >
        <span>{section.label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-[transform,opacity] duration-200",
            folded
              ? "-rotate-90 opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover/section:opacity-100"
          )}
          strokeWidth={2}
        />
      </button>
      <div className="space-y-px">
        {shown.map((item) => (
          <NavRow
            active={item.url === active}
            item={item}
            key={item.url}
            pulse={pulse}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * The live panel at the top of the sidebar: the shop's queue at a glance.
 * Each line links to the page where that work gets done.
 */
const LivePanel = ({ pulse }: { pulse: Pulse }) => {
  const waiting = pulse.rfqsToQuote + pulse.drafts + pulse.newSenders;
  const lines = [
    { label: "Drafts", value: pulse.drafts, unit: "ready", href: "/quotes" },
    {
      label: "New senders",
      value: pulse.newSenders,
      unit: "to triage",
      href: "/quotes?tab=new",
    },
    {
      label: "Customer POs",
      value: pulse.posToEnter,
      unit: "to enter",
      href: "/orders/incoming",
    },
  ];
  return (
    <div className="mx-2 mt-2 mb-3 rounded-md border border-slate-200/70 bg-white/80 px-2.5 pt-2 pb-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-medium text-[10px] text-slate-500 uppercase tracking-[0.14em]">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Live
        </span>
        <Link
          className="text-[10.5px] text-sky-600 hover:text-sky-700"
          href="/quotes"
        >
          RFQ inbox
        </Link>
      </div>
      <Link className="mt-1.5 flex items-baseline gap-1.5" href="/quotes">
        <span className="font-semibold text-[19px] text-slate-900 tabular-nums leading-none">
          {waiting}
        </span>
        <span className="text-[10.5px] text-slate-500">
          RFQs waiting on you
        </span>
      </Link>
      <div className="mt-1.5 space-y-0.5">
        {lines.map((line) => (
          <Link
            className="flex items-center justify-between text-[10.5px] hover:text-slate-900"
            href={line.href}
            key={line.label}
          >
            <span className="text-slate-400">{line.label}</span>
            <span
              className={cn(
                "tabular-nums",
                line.value > 0 ? "text-sky-600" : "text-slate-400"
              )}
            >
              {line.value} {line.unit}
            </span>
          </Link>
        ))}
      </div>
      <div
        aria-hidden
        className="mt-2 h-px bg-[repeating-linear-gradient(90deg,#e2e8f0_0_10px,transparent_10px_14px)]"
      />
    </div>
  );
};

export const AppNav = ({
  open,
  onClose,
  sections,
  pulse,
  user,
}: {
  open: boolean;
  onClose: () => void;
  sections: NavSection[];
  pulse: Pulse;
  user: UserMenuUser;
}) => {
  const pathname = usePathname();
  const active = activeUrl(pathname, [
    ...TOP_ITEMS,
    ...sections.flatMap((s) => s.items),
  ]);
  const settingsActive =
    pathname === "/settings" || pathname.startsWith("/settings/");

  // Which sections are folded, remembered in this browser.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setFolded(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}"));
    } catch {
      // Storage blocked or malformed: everything starts open.
    }
  }, []);
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
      } catch {
        // Not remembered; it still folds for this visit.
      }
      return next;
    });

  return (
    <>
      {/* Mobile-only scrim. Tapping it closes the drawer. */}
      <div
        aria-hidden
        className={cn(
          "fixed inset-0 z-40 bg-slate-900/40 transition-opacity duration-300 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col bg-white text-slate-900 shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
          "md:static md:z-auto md:translate-x-0 md:bg-transparent md:shadow-none"
        )}
      >
        {/* Mobile drawer header; on desktop the brand sits in the header. */}
        <div className="flex h-14 items-center justify-between border-slate-200/70 border-b px-3 md:hidden">
          <Link href="/" onClick={onClose}>
            <Logo className="flex items-center gap-2.5" />
          </Link>
          <button
            aria-label="Close menu"
            className="-mr-1 flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            onClick={onClose}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <LivePanel pulse={pulse} />

        <nav className="flex-1 overflow-y-auto overflow-x-hidden pb-3">
          <div className="space-y-px">
            {TOP_ITEMS.map((item) => (
              <NavRow
                active={item.url === active}
                item={item}
                key={item.url}
                pulse={pulse}
              />
            ))}
          </div>
          {sections.map((section) => (
            <Section
              active={active}
              folded={Boolean(folded[section.id])}
              key={section.id}
              onToggle={() => toggle(section.id)}
              pulse={pulse}
              section={section}
            />
          ))}
        </nav>

        <div className="shrink-0 border-slate-200/60 border-t py-1">
          <NavRow
            active={settingsActive}
            item={{
              title: "Settings",
              url: "/settings/team",
              icon: SettingsIcon,
            }}
            pulse={pulse}
          />
        </div>
        <div className="shrink-0 border-slate-200/60 border-t">
          <UserMenu user={user} />
        </div>
      </aside>
    </>
  );
};
