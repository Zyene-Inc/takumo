import { Input } from "@repo/design-system/components/ui/input";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageTopbar } from "@/components/page";
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
    <PageTopbar
      className="mb-4"
      eyebrow="Company Knowledge"
      eyebrowAs="span"
      subtitle={
        crumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="flex min-w-0 items-center gap-1.5">
              {crumbs.map((crumb, index) => (
                <li
                  className="flex min-w-0 items-center gap-1.5"
                  key={crumb.href ?? `here:${crumb.label}`}
                >
                  {index > 0 && (
                    <ChevronRightIcon className="size-3 shrink-0 text-slate-300" />
                  )}
                  {crumb.href && index < crumbs.length - 1 ? (
                    <Link
                      className="max-w-48 truncate hover:text-slate-900"
                      href={crumb.href}
                      title={crumb.label}
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      aria-current="page"
                      className="max-w-48 truncate text-slate-900"
                      title={crumb.label}
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )
      }
    >
      <form
        action="/library/search"
        aria-label="Search documents"
        className="relative hidden w-64 sm:block"
      >
        <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-slate-400" />
        <Input
          aria-label="Search documents"
          className="h-7 pl-8 text-[12.5px]"
          defaultValue={query}
          name="q"
          placeholder="Search documents"
          type="search"
        />
      </form>
    </PageTopbar>
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
