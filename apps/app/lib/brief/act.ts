import "server-only";

import { can, type Permission } from "@repo/auth/permissions";
import { getWorkOS, withAuth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { factLabel } from "@/lib/facts/attributes";
import { approveFact, rejectFact } from "@/lib/facts/facts";
import { recordOutcome } from "@/lib/quotes/approve";
import type { QuotedBreak } from "@/lib/quotes/types";
import { isoDay } from "@/lib/schedule/request";
import { type LinkAction, type LinkPayload, verifyLink } from "./links";
import { factText } from "./load";
import { linkSecret, NO_SECRET } from "./urls";

// Approve from email (docs/PRODUCT-PLAN.md F4.2): the link opens a page
// saying what will change (GET, changes nothing); confirming there POSTs and
// the change is made as the person the email went to, with the same role
// checks as the app, once.

const PERMISSION: Record<LinkAction["kind"], Permission> = {
  fact: "knowledge:review",
  quote: "quotes:write",
};

type Checked =
  | { ok: true; payload: Extract<LinkPayload, { t: "act" }> }
  | { ok: false; error: string };

/** The action link's payload when it's genuine, current and not used yet. */
export const checkActionLink = async (
  token: string | null | undefined,
  now: Date
): Promise<Checked> => {
  const secret = linkSecret();
  if (!secret) {
    return { ok: false, error: NO_SECRET };
  }
  const v = verifyLink(secret, token, now);
  if (!v.ok) {
    return {
      ok: false,
      error:
        v.reason === "expired"
          ? "This link has expired (they last 3 days). Open the app to do this."
          : "This link isn't valid. Open the app to do this.",
    };
  }
  if (v.payload.t !== "act") {
    return {
      ok: false,
      error: "This link isn't valid. Open the app to do this.",
    };
  }
  const used = await database.emailLinkUse.findUnique({
    where: { nonce: v.payload.n },
  });
  if (used) {
    return { ok: false, error: "This link was already used." };
  }
  return { ok: true, payload: v.payload };
};

/** The person's current role in the shop (null: no longer a member). */
const roleIn = async (orgId: string, userId: string) => {
  const memberships =
    await getWorkOS().userManagement.listOrganizationMemberships({
      userId,
      organizationId: orgId,
      statuses: ["active"],
    });
  return memberships.data[0]?.role.slug ?? null;
};

/** Someone else signed in on this browser: the link isn't theirs. */
const otherUserSignedIn = async (userId: string) => {
  try {
    const { user } = await withAuth();
    return Boolean(user && user.id !== userId);
  } catch {
    return false;
  }
};

export type ActionView =
  | {
      kind: "fact";
      decision: "approve" | "reject";
      text: string;
    }
  | {
      kind: "quote";
      decision: "won" | "lost";
      quoteNo: string;
      customer: string | null;
      breaks: { qty: number; price: number; unitPrice: number }[];
    };

/** What the confirmation page shows: what will change. */
export const describeAction = async (
  payload: Extract<LinkPayload, { t: "act" }>
): Promise<{ ok: true; view: ActionView } | { ok: false; error: string }> => {
  const db = forOrg(database, payload.o);
  const a = payload.a;
  if (a.kind === "fact") {
    const fact = await db.fact.findFirst({ where: { id: a.factId } });
    if (!fact) {
      return { ok: false, error: "That fact no longer exists." };
    }
    if (fact.status !== "pending") {
      return {
        ok: false,
        error: `${factLabel(fact.number)} is already ${fact.status}.`,
      };
    }
    return {
      ok: true,
      view: { kind: "fact", decision: a.decision, text: factText(fact) },
    };
  }
  const line = await db.rfqLine.findFirst({
    where: { id: a.lineId, rfqId: a.rfqId },
    select: {
      quote: { select: { quoteNo: true, status: true, breaks: true } },
      rfq: {
        select: { customerName: true, customer: { select: { name: true } } },
      },
    },
  });
  if (!line?.quote) {
    return { ok: false, error: "That quote no longer exists." };
  }
  if (line.quote.status !== "open") {
    return {
      ok: false,
      error: `${line.quote.quoteNo} is already ${line.quote.status}.`,
    };
  }
  const breaks = ((line.quote.breaks as QuotedBreak[] | null) ?? []).map(
    (b) => ({ qty: b.qty, price: b.price, unitPrice: b.unitPrice })
  );
  return {
    ok: true,
    view: {
      kind: "quote",
      decision: a.decision,
      quoteNo: line.quote.quoteNo,
      customer: line.rfq.customer?.name ?? line.rfq.customerName,
      breaks,
    },
  };
};

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: string }).code === "P2002";

type ActResult = { ok: true; message: string } | { ok: false; error: string };

/** Why this person can't do this now, or null when they can. */
const refusal = async (
  orgId: string,
  userId: string,
  a: LinkAction,
  qty: number | null
): Promise<string | null> => {
  if (await otherUserSignedIn(userId)) {
    return "This link was sent to someone else. Sign out first, or open it from your own email.";
  }
  const role = await roleIn(orgId, userId);
  if (!role) {
    return "You're no longer in this shop.";
  }
  if (!can(role, PERMISSION[a.kind])) {
    return a.kind === "fact"
      ? "Only owners, admins and planners can approve facts."
      : "Only owners, admins and estimators can change quotes.";
  }
  if (a.kind === "quote" && a.decision === "won" && !qty) {
    return "Pick the quantity they ordered.";
  }
  return null;
};

/** The change itself, as the person the link was sent to. */
const run = async (
  orgId: string,
  userId: string,
  a: LinkAction,
  qty: number | null,
  now: Date
): Promise<ActResult> => {
  if (a.kind === "fact") {
    const done =
      a.decision === "approve"
        ? await approveFact(orgId, a.factId, userId)
        : await rejectFact(orgId, a.factId, userId, null);
    return done.ok
      ? {
          ok: true,
          message: `${done.label} ${a.decision === "approve" ? "approved" : "rejected"}.`,
        }
      : done;
  }
  const done = await recordOutcome(
    orgId,
    a.rfqId,
    a.decision === "won"
      ? { lineId: a.lineId, status: "won", qty: qty as number }
      : { lineId: a.lineId, status: "lost" },
    isoDay(now)
  );
  if (!done.ok) {
    return done;
  }
  const order = done.orderNo
    ? `: order ${done.orderNo} is on the order list`
    : "";
  return {
    ok: true,
    message: a.decision === "won" ? `Marked won${order}.` : "Marked lost.",
  };
};

/**
 * Do what the link says, after the confirmation POST. `qty`: for "won", the
 * quantity the customer ordered.
 */
export const performAction = async (
  token: string | null | undefined,
  qty: number | null,
  now: Date
): Promise<ActResult> => {
  const checked = await checkActionLink(token, now);
  if (!checked.ok) {
    return checked;
  }
  const { o: orgId, u: userId, a, n: nonce } = checked.payload;
  const refused = await refusal(orgId, userId, a, qty);
  if (refused) {
    return { ok: false, error: refused };
  }
  // Claim the link first: a second click (or a second tab) does nothing.
  try {
    await database.emailLinkUse.create({
      data: { nonce, orgId, userId, action: `${a.kind}:${a.decision}` },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, error: "This link was already used." };
    }
    throw error;
  }
  // A change that didn't happen leaves the link usable.
  const release = () =>
    database.emailLinkUse.delete({ where: { nonce } }).catch(() => undefined);
  try {
    const done = await run(orgId, userId, a, qty, now);
    if (!done.ok) {
      await release();
    }
    return done;
  } catch (error) {
    await release();
    log.error("Email action failed", { orgId, error: String(error) });
    return {
      ok: false,
      error: "Something went wrong. Open the app to do this.",
    };
  }
};
