import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { VIEWABLE } from "../../../../../quotes/[id]/rfq-files";

const UNSAFE_NAME = /["\\\r\n]/g;

/**
 * A file that came with a customer PO. Downloaded by default; PDFs and images
 * can be opened in the browser (?view=1), sandboxed except PDFs (Chrome won't
 * show a sandboxed PDF; its viewer runs no document scripts).
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
  const file = await forOrg(database, orgId).customerPoFile.findFirst({
    where: { id: fileId, poId: id },
    select: { name: true, mediaType: true, data: true },
  });
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  const data = new Uint8Array(file.data);
  const view =
    new URL(request.url).searchParams.get("view") === "1" &&
    VIEWABLE.includes(file.mediaType);
  const name = file.name.replace(UNSAFE_NAME, "_");
  return new Response(data, {
    headers: {
      "Content-Type": view ? file.mediaType : "application/octet-stream",
      "Content-Disposition": `${view ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Content-Length": String(data.length),
      ...(view && file.mediaType === "application/pdf"
        ? {}
        : { "Content-Security-Policy": "sandbox" }),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
