import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { type IngestEvent, ingestDocument } from "@/lib/knowledge/ingest";
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "@/lib/knowledge/types";

// Long scans are read a few pages at a time.
export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Upload one document. The response is newline-delimited JSON: a "step"
 * event as each stage finishes, then "done" (or "error"), so the page can
 * show the work as it happens.
 */
export const POST = async (request: Request) => {
  const access = await authorize("knowledge:write");
  if (!access.ok) {
    return problem(403, access.error);
  }
  const { userId } = await auth();
  const locked = await featureProblem(access.orgId, "knowledge");
  if (locked) {
    return problem(402, locked);
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return problem(400, "Choose a file.");
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return problem(400, "Files can be up to 20 MB.");
  }
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return problem(400, `Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: IngestEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await ingestDocument(
          access.orgId,
          userId ?? null,
          { name: file.name, bytes },
          emit
        );
      } catch (error) {
        log.warn("Document upload failed", { error: String(error) });
        emit({
          type: "error",
          // Our own messages are written for people; others can name the
          // AI provider, so they get a plain one.
          error:
            error instanceof Error && error.message.startsWith("No text found")
              ? error.message
              : "Couldn't read that file. Try again, or upload it as a PDF.",
        });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
