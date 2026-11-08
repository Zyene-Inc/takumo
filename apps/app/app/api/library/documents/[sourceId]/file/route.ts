import { fileLink, previewFile } from "@/lib/library/download";
import { resolveViewer } from "@/lib/library/viewer";

// Open (?download absent) or download (?download=1) a document's original
// file, current version or ?version=N. Answers with a redirect to a link
// that works for a minute, made only after the checks in fileLink.
//
// ?preview=1 is the preview inside the document's page: Takumo's pages can
// only embed what Takumo itself serves (they are cross-origin isolated), so
// the current version's file is sent from here, for small PDFs and images
// only (lib/library/download.ts).
const VERSION = /^[1-9]\d{0,5}$/;
const UNSAFE_NAME = /["\\\r\n]/g;

type SignedIn = NonNullable<Awaited<ReturnType<typeof resolveViewer>>>;

const preview = async (viewer: SignedIn, sourceId: string) => {
  const file = await previewFile(viewer, sourceId);
  if (!file.ok) {
    return Response.json({ error: file.error }, { status: file.status });
  }
  const name = file.name.replace(UNSAFE_NAME, "_");
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Content-Length": String(file.bytes.length),
      // Chrome won't show a PDF in a sandboxed page; its PDF viewer runs no
      // document scripts anyway. Images are sandboxed.
      ...(file.mimeType === "application/pdf"
        ? {}
        : { "Content-Security-Policy": "sandbox" }),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> }
) => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return Response.json(
      { error: "That document doesn't exist." },
      { status: 404 }
    );
  }
  const { sourceId } = await params;
  const query = new URL(request.url).searchParams;
  if (query.get("preview") === "1") {
    return preview(viewer, sourceId);
  }
  const version = query.get("version");
  if (version !== null && !VERSION.test(version)) {
    return Response.json({ error: "Which version?" }, { status: 400 });
  }
  const link = await fileLink(viewer, sourceId, {
    download: query.get("download") === "1",
    version: version === null ? undefined : Number(version),
  });
  if (!link.ok) {
    return Response.json({ error: link.error }, { status: link.status });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: link.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
};
