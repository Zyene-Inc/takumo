import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import {
  credentials,
  encryptionKey,
  PROVIDERS,
  type Provider,
} from "@/lib/connectors/config";
import { verifyState } from "@/lib/connectors/crypto";
import {
  DEFAULT_RFQ_QUERY,
  exchangeCode as exchangeGmailCode,
  GMAIL_SCOPE,
  mailbox,
} from "@/lib/connectors/gmail";
import {
  canReadMail,
  exchangeCode as exchangeOutlookCode,
  needsAdminConsent,
  OutlookConsentError,
  mailbox as outlookMailbox,
  pkceVerifier,
} from "@/lib/connectors/outlook";
import {
  companyName,
  exchangeCode as exchangeQuickBooksCode,
  type QbEnvironment,
} from "@/lib/connectors/quickbooks";
import {
  connectOutlook,
  saveConnection,
  syncConnection,
} from "@/lib/connectors/sync";

// The first sync can read a mailbox's worth of RFQs.
export const maxDuration = 300;

const back = (params: Record<string, string>) =>
  NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/settings/integrations?${new URLSearchParams(params)}`
  );

// The tenant blocks people from approving apps: the settings page shows the
// link and steps for the shop's IT person.
const adminNeeded = () =>
  back({
    error:
      "Your organization's Microsoft 365 settings need an administrator to approve Takumo before anyone can connect Outlook.",
    adminConsent: "outlook",
  });

const NO_MAIL_ACCESS =
  "Takumo needs permission to read mail to find RFQs. Try again and allow it.";

/** The person (or their organization) didn't allow access. */
const refused = (provider: Provider, url: URL) => {
  if (provider !== "outlook") {
    return back({ error: "Access wasn't granted, so nothing was connected." });
  }
  if (
    needsAdminConsent(
      url.searchParams.get("error"),
      url.searchParams.get("error_description")
    )
  ) {
    return adminNeeded();
  }
  // Declining and "ask your admin" screens can look alike: offer both.
  return back({
    error:
      "Access wasn't granted, so nothing was connected. If Microsoft said an administrator has to approve Takumo, send your IT person the link below.",
    adminConsent: "outlook",
  });
};

interface Callback {
  code: string;
  creds: NonNullable<ReturnType<typeof credentials>>;
  orgId: string;
  url: URL;
  userId: string;
}

/** Each provider's code exchange and save; a response when it can't finish. */
const CONNECT: Record<Provider, (c: Callback) => Promise<Response | null>> = {
  quickbooks: async ({ code, creds, orgId, url, userId }) => {
    const realmId = url.searchParams.get("realmId");
    if (!realmId) {
      return back({
        error: "QuickBooks didn't say which company to connect.",
      });
    }
    const tokens = await exchangeQuickBooksCode(fetch, creds, code);
    const name = await companyName(
      fetch,
      creds.environment as QbEnvironment,
      realmId,
      tokens.access_token
    );
    await saveConnection(orgId, "quickbooks", {
      account: realmId,
      accountLabel: name,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      createdBy: userId,
    });
    return null;
  },
  gmail: async ({ code, creds, orgId, userId }) => {
    const tokens = await exchangeGmailCode(fetch, creds, code);
    if (!tokens.scope?.includes(GMAIL_SCOPE)) {
      return back({ error: NO_MAIL_ACCESS });
    }
    const email = await mailbox(fetch, tokens.access_token);
    await saveConnection(orgId, "gmail", {
      account: email,
      accountLabel: email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      createdBy: userId,
      settings: { query: DEFAULT_RFQ_QUERY },
    });
    return null;
  },
  outlook: async ({ code, creds, orgId, url, userId }) => {
    const tokens = await exchangeOutlookCode(
      fetch,
      creds,
      code,
      pkceVerifier(encryptionKey(), url.searchParams.get("state") ?? "")
    );
    if (!canReadMail(tokens.scope)) {
      return back({ error: NO_MAIL_ACCESS });
    }
    const email = await outlookMailbox(fetch, tokens.access_token);
    await connectOutlook(orgId, userId, email, tokens);
    return null;
  },
};

/** Where QuickBooks, Google and Microsoft send the person back after they allow access. */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) => {
  const { provider: raw } = await params;
  if (!(PROVIDERS as readonly string[]).includes(raw)) {
    return new Response("Not found", { status: 404 });
  }
  const provider = raw as Provider;
  const url = new URL(request.url);
  const creds = credentials(provider);
  const { orgId, userId } = await auth();
  const state = verifyState(
    encryptionKey(),
    url.searchParams.get("state") ?? ""
  );
  // Only the person who started connecting, in the same shop, can finish.
  if (
    !(
      creds &&
      orgId &&
      userId &&
      state &&
      state.orgId === orgId &&
      state.userId === userId &&
      state.provider === provider
    )
  ) {
    return back({
      error:
        "That sign-in link expired or belongs to someone else. Try connecting again.",
    });
  }
  if (url.searchParams.get("error")) {
    return refused(provider, url);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return back({
      error: "The provider didn't send a sign-in code. Try again.",
    });
  }
  const locked = await featureProblem(orgId, "connectors");
  if (locked) {
    return back({ error: locked });
  }
  try {
    const problem = await CONNECT[provider]({
      code,
      creds,
      orgId,
      url,
      userId,
    });
    if (problem) {
      return problem;
    }
  } catch (failure) {
    if (failure instanceof OutlookConsentError) {
      return adminNeeded();
    }
    log.warn("Connecting failed", { orgId, provider, error: String(failure) });
    return back({ error: "Connecting failed. Try again in a minute." });
  }
  track("connector_connected", { orgId, userId, properties: { provider } });
  // First sync after the response, so the person isn't left waiting.
  after(() => syncConnection(orgId, provider));
  return back({ connected: provider });
};
