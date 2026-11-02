import { auth } from "@repo/auth/server";
import { rfqFileBytes } from "@/lib/quotes/files";
import { VIEWABLE } from "../../rfq-files";

const UNSAFE_NAME = /["\\\r\n]/g;

/**
 * One file that came with an RFQ. Downloaded by default; PDFs and images can
 * be opened in the browser (?view=1), sandboxed so nothing in them runs.
 */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) => {
  const { orgId } = await auth();
  if (!orgId) {
    return new Response("Not found", { status: 404 });
  }
  const { id, fileId } = await params;
  const file = await rfqFileBytes(orgId, fileId);
  if (!file || file.rfqId !== id) {
    return new Response("Not found", { status: 404 });
  }
  const view =
    new URL(request.url).searchParams.get("view") === "1" &&
    VIEWABLE.includes(file.mediaType);
  const name = file.name.replace(UNSAFE_NAME, "_");
  return new Response(file.data, {
    headers: {
      "Content-Type": view ? file.mediaType : "application/octet-stream",
      "Content-Disposition": `${view ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Content-Length": String(file.data.length),
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
