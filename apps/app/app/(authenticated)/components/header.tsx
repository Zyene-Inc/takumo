import type { ReactNode } from "react";
import { PageTopbar } from "@/components/page";

interface HeaderProps {
  children?: ReactNode;
  page: string;
  /** Parent pages; the app header's breadcrumb shows where you are now. */
  pages?: string[];
  /** A line of context beside the page name. */
  subtitle?: ReactNode;
}

/**
 * The bar at the top of a page: its name as a small eyebrow, optional
 * context, and the page's actions on the right (Warmbly's page topbar).
 * The gap below suits pages whose body pads itself.
 */
export const Header = ({ page, subtitle, children }: HeaderProps) => (
  <PageTopbar className="mb-4" eyebrow={page} subtitle={subtitle}>
    {/* Actions sit flush (the bar pads itself), compact, and the page's main
        action is the solid sky button. */}
    <div className="flex items-center gap-1.5 [&>*:not([data-slot=button])]:px-0 [&_[data-slot=button][data-variant=default]]:bg-sky-600 [&_[data-slot=button][data-variant=default]]:hover:bg-sky-700 [&_[data-slot=button]]:h-7 [&_[data-slot=button]]:text-[12px]">
      {children}
    </div>
  </PageTopbar>
);
