import { Skeleton } from "@repo/design-system/components/ui/skeleton";

const LibraryLoading = () => (
  <div aria-busy="true" className="grid gap-4 p-4">
    <span className="sr-only">Loading…</span>
    <Skeleton className="h-8 w-64" />
    <div className="grid gap-3 sm:grid-cols-3">
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
    <Skeleton className="h-64" />
  </div>
);

export default LibraryLoading;
