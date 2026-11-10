"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  ClockIcon,
  FileInputIcon,
  FolderIcon,
  FolderLockIcon,
  FoldersIcon,
  ReceiptTextIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import type { FolderCard } from "@/lib/library/browse";

interface Item {
  href: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

const VIEWS: Item[] = [
  { href: "/library", label: "All files", icon: FoldersIcon },
  { href: "/library/mine", label: "My uploads", icon: UserIcon },
  { href: "/library/recent", label: "Recent", icon: ClockIcon },
];

const RECORDS: Item[] = [
  { href: "/library/rfqs", label: "RFQs", icon: FileInputIcon },
  { href: "/library/orders", label: "Purchase orders", icon: ReceiptTextIcon },
];

const TRASH: Item = {
  href: "/library/trash",
  label: "Trash",
  icon: Trash2Icon,
};

const NavLink = ({ item, active }: { active: boolean; item: Item }) => (
  <li className="shrink-0">
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-muted font-medium" : "text-muted-foreground"
      )}
      href={item.href}
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  </li>
);

/** The library's own navigation: views, top-level folders, RFQs and POs, Trash. */
export const LibraryNav = ({ folders }: { folders: FolderCard[] }) => {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/library" ? path === href : path.startsWith(href);
  const folderItems: Item[] = folders.map((f) => ({
    href: `/library/f/${f.id}`,
    label: f.name,
    icon: f.kind === "personal" ? FolderLockIcon : FolderIcon,
  }));
  const groups: [string, Item[]][] = [
    ["Views", VIEWS],
    ["Folders", folderItems],
    ["Records", RECORDS],
  ];
  return (
    <nav aria-label="Company Knowledge" className="xl:w-52 xl:shrink-0">
      {/* A row that scrolls on small screens, a column beside the page on large ones. */}
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-1 xl:mx-0 xl:flex-col xl:overflow-visible xl:px-0">
        {groups.map(([label, items]) =>
          items.length ? (
            <div className="shrink-0" key={label}>
              <p className="mb-1 hidden px-2 font-medium text-muted-foreground text-xs xl:block">
                {label}
              </p>
              <ul className="flex gap-1 xl:flex-col">
                {items.map((item) => (
                  <NavLink
                    active={isActive(item.href)}
                    item={item}
                    key={item.href}
                  />
                ))}
              </ul>
            </div>
          ) : null
        )}
        <ul className="flex shrink-0 gap-1 xl:mt-2 xl:flex-col xl:border-t xl:pt-2">
          <NavLink active={isActive(TRASH.href)} item={TRASH} />
        </ul>
      </div>
    </nav>
  );
};
