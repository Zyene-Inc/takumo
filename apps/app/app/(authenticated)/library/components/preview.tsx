import { Button } from "@repo/design-system/components/ui/button";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { PREVIEW_MAX_BYTES, previewKind } from "@/lib/library/format";

const emptyMessage = (hasCurrent: boolean, failed: boolean) => {
  if (hasCurrent) {
    return "No text to show for this document.";
  }
  return failed
    ? "Takumo couldn't read this document, so there's nothing to show yet. Versions below says what went wrong."
    : "Takumo is still reading this document. Its preview appears when it's ready.";
};

/**
 * The document itself where the browser can show it (small PDFs and
 * images, sent by the file route after its checks), and the text Takumo
 * read from it otherwise, or when no original was kept. Larger files open
 * in a new tab (a link that works for a minute).
 */
export const Preview = ({
  current,
  failed,
  name,
  sourceId,
  text,
}: {
  current: {
    mimeType: string | null;
    originalKept: boolean;
    size: number | null;
  } | null;
  /** Its first version couldn't be read (there's no current one to show). */
  failed: boolean;
  name: string;
  sourceId: string;
  text: { content: string; truncated: boolean } | null;
}) => {
  const file = `/api/library/documents/${sourceId}/file`;
  const shown = `${file}?preview=1`;
  const kind = previewKind(current?.mimeType ?? null);
  const kept = Boolean(current?.originalKept);
  const fits = (current?.size ?? Number.POSITIVE_INFINITY) <= PREVIEW_MAX_BYTES;
  const embedded = kept && fits && kind !== "text";
  return (
    <section aria-label="Preview" className="grid content-start gap-3">
      {kept && (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={file} rel="noopener" target="_blank">
              <ExternalLinkIcon /> Open in a new tab
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`${file}?download=1`}>
              <DownloadIcon /> Download
            </a>
          </Button>
        </div>
      )}
      {embedded && kind === "pdf" && (
        <>
          {/* Phone browsers mostly can't show a PDF inside a page. */}
          <iframe
            className="hidden h-[70vh] w-full rounded-lg border bg-muted sm:block"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={shown}
            title={`Preview of ${name}`}
          />
          <p className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm sm:hidden">
            Open it in a new tab to read it on this screen.
          </p>
        </>
      )}
      {embedded && kind === "image" && (
        // biome-ignore lint/performance/noImgElement: a private file sent after the checks; next/image can't optimise it
        // biome-ignore lint/correctness/useImageSize: the image's size isn't known
        <img
          alt={`Preview of ${name}`}
          className="max-h-[70vh] w-auto rounded-lg border object-contain"
          referrerPolicy="no-referrer"
          src={shown}
        />
      )}
      {kept && !fits && kind !== "text" && (
        <p className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm">
          This file is too large to show here. Open it in a new tab to see it.
        </p>
      )}
      {!kept && current && (
        <p className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm">
          The original file wasn't kept: this document was added before Takumo
          kept original files. Below is the text Takumo read from it.
        </p>
      )}
      {!embedded &&
        (text ? (
          <div className="grid gap-1">
            <h2 className="font-medium text-sm">Text Takumo read</h2>
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 font-sans text-sm">
              {text.content}
            </pre>
            {text.truncated && (
              <p className="text-muted-foreground text-xs">
                Showing the beginning.
                {kept ? " Download the file to see all of it." : ""}
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            {emptyMessage(Boolean(current), failed)}
          </p>
        ))}
    </section>
  );
};
