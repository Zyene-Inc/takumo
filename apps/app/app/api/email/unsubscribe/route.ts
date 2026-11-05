import { applyUnsubscribe, checkUnsubscribe } from "@/lib/brief/unsubscribe";

// One-click unsubscribe from a mail app (List-Unsubscribe-Post, RFC 8058):
// a POST with the signed token in the URL.
export const POST = async (request: Request) => {
  const token = new URL(request.url).searchParams.get("t");
  const checked = checkUnsubscribe(token, new Date());
  if (!checked.ok) {
    return new Response("Invalid link", { status: 400 });
  }
  await applyUnsubscribe(checked.payload);
  return new Response("Unsubscribed", { status: 200 });
};
