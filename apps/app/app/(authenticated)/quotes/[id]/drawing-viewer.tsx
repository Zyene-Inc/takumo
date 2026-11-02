"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { boxStyle } from "@/lib/quotes/review";
import { useReviewFocus } from "./review-focus";

export interface ViewerFile {
  id: string;
  mediaType: string;
  name: string;
  pages: number | null;
}

const ZOOMS = [1, 1.5, 2, 3];

let workerReady = false;
/** pdf.js with its worker from our own bundle (no outside scripts). */
const loadPdfJs = async () => {
  const pdfjs = await import("pdfjs-dist");
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(
      new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
      { type: "module" }
    );
    workerReady = true;
  }
  return pdfjs;
};

/** One sheet of a PDF drawn on a canvas, sized to its box. */
const PdfSheet = ({
  doc,
  sheet,
  width,
}: {
  doc: PDFDocumentProxy;
  sheet: number;
  width: number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    doc.getPage(sheet).then((page) => {
      const target = canvas.current;
      if (cancelled || !target || width <= 0) {
        return;
      }
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: width / base.width });
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      const context = target.getContext("2d");
      if (!context) {
        return;
      }
      const render = page.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      task = render;
      render.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, sheet, width]);
  return <canvas className="block" ref={canvas} />;
};

/**
 * The line's drawing with the picked value highlighted (F2.6-R1/R2). PDFs
 * are drawn with pdf.js so the highlight sits exactly on the sheet.
 */
export const DrawingViewer = ({
  file,
  lineId,
  rfqId,
}: {
  file: ViewerFile;
  lineId: string;
  rfqId: string;
}) => {
  const { focus } = useReviewFocus();
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(1);
  const [zoom, setZoom] = useState(0);
  const url = `/quotes/${rfqId}/files/${file.id}`;
  const isPdf = file.mediaType === "application/pdf";
  const sheets = doc?.numPages ?? file.pages ?? 1;
  const mine = focus && focus.lineId === lineId ? focus : null;
  const highlight = mine && (mine.sheet ?? 1) === sheet ? mine : null;
  const style = boxStyle(highlight?.box);

  useEffect(() => {
    const el = frame.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setFrameWidth(Math.floor(entry?.contentRect.width ?? 0))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isPdf) {
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const pdfjs = await loadPdfJs();
        loaded = await pdfjs.getDocument({ data, isEvalSupported: false })
          .promise;
        if (!cancelled) {
          setDoc(loaded);
        }
      } catch {
        if (!cancelled) {
          setError("The drawing couldn't be shown here. Download it instead.");
        }
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [isPdf, url]);

  // Jump to the sheet of whatever was picked.
  useEffect(() => {
    if (mine?.sheet && mine.sheet >= 1) {
      setSheet(mine.sheet);
    }
  }, [mine]);

  const width = Math.max(0, frameWidth * (ZOOMS[zoom] ?? 1));

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {file.name}
        </span>
        {sheets > 1 && (
          <>
            <Button
              aria-label="Previous sheet"
              disabled={sheet <= 1}
              onClick={() => setSheet(sheet - 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <span className="tabular-nums">
              Sheet {sheet} of {sheets}
            </span>
            <Button
              aria-label="Next sheet"
              disabled={sheet >= sheets}
              onClick={() => setSheet(sheet + 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </>
        )}
        <Button
          aria-label="Zoom out"
          disabled={zoom === 0}
          onClick={() => setZoom(zoom - 1)}
          size="icon"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <Button
          onClick={() => setZoom(0)}
          size="sm"
          title="Fit the sheet to the width"
          variant="ghost"
        >
          {zoom === 0 ? "Fit" : `${(ZOOMS[zoom] ?? 1) * 100}%`}
        </Button>
        <Button
          aria-label="Zoom in"
          disabled={zoom === ZOOMS.length - 1}
          onClick={() => setZoom(zoom + 1)}
          size="icon"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
        <Button asChild size="icon" variant="ghost">
          <a
            aria-label="Open the drawing in a new tab"
            href={`${url}?view=1`}
            rel="noopener"
            target="_blank"
          >
            <ExternalLinkIcon />
          </a>
        </Button>
      </div>
      <div
        className="max-h-[75vh] overflow-auto rounded-lg border bg-white"
        ref={frame}
      >
        <div className="relative w-fit">
          {isPdf && doc && <PdfSheet doc={doc} sheet={sheet} width={width} />}
          {isPdf && !doc && !error && (
            <div className="flex h-64 items-center justify-center text-muted-foreground text-sm">
              <Spinner /> Loading the drawing…
            </div>
          )}
          {!isPdf && (
            // biome-ignore lint/performance/noImgElement: a private file, not an optimizable asset
            // biome-ignore lint/correctness/useImageSize: sized by its container
            <img
              alt={file.name}
              className="block h-auto"
              src={`${url}?view=1`}
              style={{ width: width || "100%" }}
            />
          )}
          {style && (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-sm bg-amber-400/20 ring-2 ring-amber-500"
              style={style}
            />
          )}
        </div>
        {error && <p className="p-4 text-muted-foreground text-sm">{error}</p>}
      </div>
      {mine && (
        <p className="text-muted-foreground text-xs">
          {style
            ? `Highlighted: ${mine.label}`
            : `${mine.label}: no exact spot was recorded for it${mine.sheet ? ` (sheet ${mine.sheet})` : ""}.`}
        </p>
      )}
    </div>
  );
};
