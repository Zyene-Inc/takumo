import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Input } from "@repo/design-system/components/ui/input";
import { Separator } from "@repo/design-system/components/ui/separator";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { FolderCard } from "@/lib/library/browse";
import { LibraryNav } from "./nav";

export interface Crumb {
  href?: string;
  label: string;
}

/**
 * Every Company Knowledge page: the header (breadcrumbs that link back, the
 * search box), the library's own navigation, and the page's content.
 */
export const LibraryShell = ({
  actions,
  children,
  crumbs,
  description,
  folders,
  query = "",
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  crumbs: Crumb[];
  description?: ReactNode;
  folders: FolderCard[];
  query?: string;
  title: string;
}) => (
  <>
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator className="mr-2 h-4" orientation="vertical" />
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <Fragment key={crumb.href ?? `here:${crumb.label}`}>
                {index > 0 && <BreadcrumbSeparator />}
                {/* The item is a flex box: the text itself truncates. */}
                <BreadcrumbItem className="min-w-0 max-w-48">
                  {crumb.href && index < crumbs.length - 1 ? (
                    <BreadcrumbLink asChild>
                      <Link
                        className="truncate"
                        href={crumb.href}
                        title={crumb.label}
                      >
                        {crumb.label}
                      </Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate" title={crumb.label}>
                      {crumb.label}
                    </BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <form
        action="/library/search"
        aria-label="Search documents"
        className="relative hidden w-72 sm:block"
      >
        <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="Search documents"
          className="pl-8"
          defaultValue={query}
          name="q"
          placeholder="Search documents"
          type="search"
        />
      </form>
    </header>
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0 xl:flex-row xl:gap-6">
      <LibraryNav folders={folders} />
      {/* The app shell already provides the page's <main>. */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-xl">{title}</h1>
            {description && (
              <p className="mt-1 max-w-3xl text-muted-foreground text-sm">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
        {/* The search box, on small screens. */}
        <form
          action="/library/search"
          aria-label="Search documents"
          className="sm:hidden"
        >
          <Input
            aria-label="Search documents"
            defaultValue={query}
            name="q"
            placeholder="Search documents"
            type="search"
          />
        </form>
        {children}
      </div>
    </div>
  </>
);
