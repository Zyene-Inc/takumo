// Where Microsoft sends a shop's IT person after the admin-consent page. They
// may not have a Takumo account, so this is public and only says what
// happened; the approval itself is already recorded at Microsoft.

const page = (title: string, text: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) => {
  const { provider } = await params;
  if (provider !== "outlook") {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  if (
    url.searchParams.get("admin_consent")?.toLowerCase() === "true" &&
    !url.searchParams.get("error")
  ) {
    return page(
      "Takumo is approved",
      "Thank you. People in your organization can now connect Outlook in Takumo (Settings → Integrations). You can close this page."
    );
  }
  return page(
    "Takumo wasn't approved",
    "The approval didn't finish, so nothing changed. Approving apps needs a Microsoft Entra administrator, such as a Global Administrator. Try the link again, or approve Takumo under Entra admin center → Enterprise applications.",
    400
  );
};
