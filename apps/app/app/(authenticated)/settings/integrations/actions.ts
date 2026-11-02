"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import {
  credentials,
  encryptionKey,
  PROVIDER_NAME,
  PROVIDERS,
  type Provider,
} from "@/lib/connectors/config";
import { signState } from "@/lib/connectors/crypto";
import {
  DEFAULT_RFQ_QUERY,
  authorizeUrl as gmailAuthorizeUrl,
} from "@/lib/connectors/gmail";
import {
  authorizeUrl as outlookAuthorizeUrl,
  pkceVerifier,
} from "@/lib/connectors/outlook";
import { authorizeUrl as quickBooksAuthorizeUrl } from "@/lib/connectors/quickbooks";
import type { PreviewMessage } from "@/lib/connectors/rfq-rules";
import {
  disconnect,
  previewConnection,
  setOutlookMailbox,
  syncConnection,
} from "@/lib/connectors/sync";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const isProvider = (p: string): p is Provider =>
  (PROVIDERS as readonly string[]).includes(p);

const manager = async () => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "connectors");
  return locked ? { ok: false as const, error: locked } : access;
};

/** Where to send the person to allow access (QuickBooks, Google or Microsoft). */
export const connect = async (
  provider: string
): Promise<Result<{ url: string }>> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  if (!isProvider(provider)) {
    return { ok: false, error: "Unknown connector." };
  }
  const creds = credentials(provider);
  if (!creds) {
    return {
      ok: false,
      error: `${PROVIDER_NAME[provider]} isn't set up on this server yet.`,
    };
  }
  const { userId } = await auth();
  const state = signState(encryptionKey(), {
    orgId: access.orgId,
    userId: userId ?? "",
    provider,
  });
  const url = {
    quickbooks: () =>
      quickBooksAuthorizeUrl(creds.clientId, creds.redirectUri, state),
    gmail: () => gmailAuthorizeUrl(creds.clientId, creds.redirectUri, state),
    outlook: () =>
      outlookAuthorizeUrl(
        creds.clientId,
        creds.redirectUri,
        state,
        pkceVerifier(encryptionKey(), state)
      ),
  }[provider]();
  return { ok: true, url };
};

export const syncNow = async (
  provider: string
): Promise<Result<{ summary: string }>> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  if (!isProvider(provider)) {
    return { ok: false, error: "Unknown connector." };
  }
  const r = await syncConnection(access.orgId, provider);
  revalidatePath("/settings/integrations");
  revalidatePath("/quotes");
  if (!r.ok) {
    return r;
  }
  return {
    ok: true,
    summary: `${r.result.created} added, ${r.result.updated} updated${r.result.skipped ? `, ${r.result.skipped} skipped` : ""}.`,
  };
};

export const disconnectProvider = async (provider: string): Promise<Result> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  if (!isProvider(provider)) {
    return { ok: false, error: "Unknown connector." };
  }
  await disconnect(access.orgId, provider);
  revalidatePath("/settings/integrations");
  return { ok: true };
};

const Query = z.string().trim().max(500);

/** The Gmail search that picks out RFQs (blank = Takumo's default). */
export const saveGmailQuery = async (query: string): Promise<Result> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  const parsed = Query.safeParse(query);
  if (!parsed.success) {
    return { ok: false, error: "Keep the search under 500 characters." };
  }
  const updated = await forOrg(database, access.orgId).connection.updateMany({
    where: { provider: "gmail" },
    data: { settings: { query: parsed.data || DEFAULT_RFQ_QUERY } },
  });
  revalidatePath("/settings/integrations");
  return updated.count
    ? { ok: true }
    : { ok: false, error: "Gmail isn't connected." };
};

const Mailbox = z.union([z.literal(""), z.email().max(254)]);

/** Read RFQs from a shared mailbox (blank = the connected person's own). */
export const saveOutlookMailbox = async (
  address: string
): Promise<Result<{ summary: string }>> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  const parsed = Mailbox.safeParse(address.trim().toLowerCase());
  if (!parsed.success) {
    return { ok: false, error: "Enter the shared mailbox's email address." };
  }
  if (!(await setOutlookMailbox(access.orgId, parsed.data || null))) {
    return { ok: false, error: "Outlook isn't connected." };
  }
  // Check right away, so a mailbox the person can't open shows up now.
  const r = await syncConnection(access.orgId, "outlook");
  revalidatePath("/settings/integrations");
  revalidatePath("/quotes");
  if (!r.ok) {
    return r;
  }
  return {
    ok: true,
    summary: parsed.data
      ? `Saved. Reading RFQs from ${parsed.data}.`
      : "Saved. Reading RFQs from your own inbox.",
  };
};

/** The last 20 emails and which would count as RFQs; imports nothing. */
export const previewRfqs = async (
  provider: string
): Promise<Result<{ messages: PreviewMessage[] }>> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  if (provider !== "gmail" && provider !== "outlook") {
    return { ok: false, error: "Unknown connector." };
  }
  try {
    return {
      ok: true,
      messages: await previewConnection(access.orgId, provider),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't read the mailbox.",
    };
  }
};
