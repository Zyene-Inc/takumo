import { snippetRuns } from "@/lib/knowledge/chunk";

/** A passage with the words that matched in bold. */
export const Snippet = ({ text }: { text: string }) => (
  <p className="line-clamp-3 max-w-md text-muted-foreground text-xs">
    {snippetRuns(text).map((run) =>
      run.match ? (
        <mark
          className="bg-transparent font-semibold text-foreground"
          key={run.start}
        >
          {run.text}
        </mark>
      ) : (
        <span key={run.start}>{run.text}</span>
      )
    )}
  </p>
);
