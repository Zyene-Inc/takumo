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
import { authorizeUrl as quickBooksAuthorizeUrl } from "@/lib/connectors/quickbooks";
import { disconnect, syncConnection } from "@/lib/connectors/sync";

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

/** Where to send the person to allow access (QuickBooks or Google). */
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
  const url =
    provider === "quickbooks"
      ? quickBooksAuthorizeUrl(creds.clientId, creds.redirectUri, state)
      : gmailAuthorizeUrl(creds.clientId, creds.redirectUri, state);
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
