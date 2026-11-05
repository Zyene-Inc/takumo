import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { verifyLink } from "@/lib/brief/links";
import { linkSecret } from "@/lib/brief/urls";

// A link in a brief or an alert: counted (that's how we know briefs are
// read, F4.1 acceptance; no open pixels), then on to the app screen.
export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const secret = linkSecret();
  const v = secret
    ? verifyLink(secret, url.searchParams.get("t"), new Date())
    : null;
  if (!(v?.ok && v.payload.t === "go")) {
    return NextResponse.redirect(new URL("/", url));
  }
  const { o: orgId, u: userId, s: section, p: path } = v.payload;
  await database.briefClick
    .create({ data: { orgId, userId, section } })
    .catch((error: unknown) =>
      log.warn("Brief click not recorded", { error: String(error) })
    );
  return NextResponse.redirect(new URL(path, url));
};
