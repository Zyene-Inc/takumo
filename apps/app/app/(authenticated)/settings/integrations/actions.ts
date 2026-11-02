"use server";

import { auth } from "@repo/auth/server";
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
import type { MailFolder } from "@/lib/connectors/outlook";
import {
  authorizeUrl as outlookAuthorizeUrl,
  pkceVerifier,
} from "@/lib/connectors/outlook";
import { authorizeUrl as quickBooksAuthorizeUrl } from "@/lib/connectors/quickbooks";
import {
  cleanTerm,
  MAX_EXTRA_TERMS,
  MAX_SENDERS,
  type PreviewMessage,
} from "@/lib/connectors/rfq-rules";
import {
  disconnect,
  outlookFolders,
  previewConnection,
  setGmailQuery,
  setOutlookFolder,
  setOutlookMailbox,
  setRfqRules,
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
  // Merged in, so the shop's RFQ rules stay.
  const saved = await setGmailQuery(
    access.orgId,
    parsed.data || DEFAULT_RFQ_QUERY
  );
  revalidatePath("/settings/integrations");
  return saved ? { ok: true } : { ok: false, error: "Gmail isn't connected." };
};

const LINES = /[\n,;]+/;
const SENDER = /^(@?[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/;

const Rules = z.object({
  provider: z.enum(["gmail", "outlook"]),
  extraTerms: z.string().max(1000),
  senders: z.string().max(5000),
  requireAttachments: z.boolean(),
  knownCustomersOnly: z.boolean(),
});

/** Which emails count as RFQs for this mailbox, on top of Takumo's rules. */
export const saveRfqRules = async (
  input: z.input<typeof Rules>
): Promise<Result> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  const parsed = Rules.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Those rules are too long." };
  }
  const { provider, requireAttachments, knownCustomersOnly } = parsed.data;
  const extraTerms = [
    ...new Set(parsed.data.extraTerms.split(LINES).map(cleanTerm)),
  ].filter(Boolean);
  if (extraTerms.length > MAX_EXTRA_TERMS) {
    return {
      ok: false,
      error: `Keep it to ${MAX_EXTRA_TERMS} extra subject words.`,
    };
  }
  const senders = [
    ...new Set(
      parsed.data.senders
        .split(LINES)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  const bad = senders.find((x) => !SENDER.test(x));
  if (bad) {
    return {
      ok: false,
      error: `"${bad}" isn't an email address or @domain.`,
    };
  }
  if (senders.length > MAX_SENDERS) {
    return { ok: false, error: `Keep it to ${MAX_SENDERS} senders.` };
  }
  const saved = await setRfqRules(access.orgId, provider, {
    extraTerms,
    senders,
    requireAttachments,
    knownCustomersOnly,
  });
  revalidatePath("/settings/integrations");
  return saved
    ? { ok: true }
    : { ok: false, error: `${PROVIDER_NAME[provider]} isn't connected.` };
};

/** The Outlook mailbox's folders, to choose where RFQs land. */
export const listOutlookFolders = async (): Promise<
  Result<{ folders: MailFolder[]; inboxId: string | null }>
> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  try {
    return { ok: true, ...(await outlookFolders(access.orgId)) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't read the folders.",
    };
  }
};

const Folder = z.union([
  z.null(),
  z.object({ id: z.string().min(1).max(500) }),
]);

/** Read RFQs from this Outlook folder (null: the Inbox). */
export const saveOutlookFolder = async (
  folder: z.input<typeof Folder>
): Promise<Result<{ summary: string }>> => {
  const access = await manager();
  if (!access.ok) {
    return access;
  }
  const parsed = Folder.safeParse(folder);
  if (!parsed.success) {
    return { ok: false, error: "Choose a folder." };
  }
  let chosen: MailFolder | null = null;
  if (parsed.data) {
    // Only a folder that's really in the mailbox, under its own name.
    const listed = await outlookFolders(access.orgId).catch(() => null);
    const id = parsed.data.id;
    chosen = listed?.folders.find((f) => f.id === id) ?? null;
    if (!chosen) {
      return { ok: false, error: "That folder isn't in the mailbox anymore." };
    }
    if (chosen.id === listed?.inboxId) {
      chosen = null;
    }
  }
  if (!(await setOutlookFolder(access.orgId, chosen))) {
    return { ok: false, error: "Outlook isn't connected." };
  }
  const r = await syncConnection(access.orgId, "outlook");
  revalidatePath("/settings/integrations");
  revalidatePath("/quotes");
  if (!r.ok) {
    return r;
  }
  return {
    ok: true,
    summary: chosen
      ? `Saved. Reading RFQs from ${chosen.name}.`
      : "Saved. Reading RFQs from the Inbox.",
  };
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
