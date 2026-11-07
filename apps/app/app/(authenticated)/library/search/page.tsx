import type { Metadata } from "next";
import { type MatchedBy, MIN_QUERY, searchLibrary } from "@/lib/library/search";
import { EmptyState } from "../../shop/components/format";
import { DocumentTable } from "../components/document-table";
import { LibraryShell } from "../components/shell";
import { Snippet } from "../components/snippet";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = { title: "Search · Company Knowledge" };

const FOUND_BY: Record<MatchedBy, string> = {
  name: "Matched by name",
  type: "Matched by document type",
  folder: "Matched by folder",
  text: "Matched in its text",
};

/**
 * Searching the library: names, types, folders and text, with Postgres only
 * (no AI). Separate from Ask Takumo, which answers questions.
 */
const SearchPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) => {
  const { q } = await searchParams;
  const query = (Array.isArray(q) ? q[0] : q)?.trim().slice(0, 200) ?? "";
  const { viewer, folders, choices } = await libraryFrame();
  const results = query ? await searchLibrary(viewer, query) : [];
  const reasons = new Map(results.map((r) => [r.document.id, r]));
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "Search" }]}
      description={
        query
          ? `${results.length} document${results.length === 1 ? "" : "s"} for “${query}”: by name, document type, folder and text.`
          : "Search document names, types, folders and the text of documents."
      }
      folders={folders}
      query={query}
      title="Search"
    >
      {query.length > 0 && query.length < MIN_QUERY && (
        <EmptyState>Type at least {MIN_QUERY} characters.</EmptyState>
      )}
      {query.length >= MIN_QUERY &&
        (results.length ? (
          <DocumentTable
            below={(row) => {
              const found = reasons.get(row.id);
              return found?.snippet ? (
                <Snippet text={found.snippet} />
              ) : (
                <span className="text-muted-foreground text-xs">
                  {found ? FOUND_BY[found.matchedBy] : ""}
                </span>
              );
            }}
            choices={choices}
            documents={results.map((r) => r.document)}
            showFolder
          />
        ) : (
          <EmptyState>
            Nothing matches “{query}”. Try other words, or ask Takumo a
            question.
          </EmptyState>
        ))}
    </LibraryShell>
  );
};

export default SearchPage;
