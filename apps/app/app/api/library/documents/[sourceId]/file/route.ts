import { fileLink } from "@/lib/library/download";
import { resolveViewer } from "@/lib/library/viewer";

// Open (?download absent) or download (?download=1) a document's original
// file, current version or ?version=N. Answers with a redirect to a link
// that works for a minute, made only after the checks in fileLink.
const VERSION = /^[1-9]\d{0,5}$/;

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
