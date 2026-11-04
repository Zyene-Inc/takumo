import "server-only";

import { createHash } from "node:crypto";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import { budgetProblem } from "../ai-usage";
import { track } from "../analytics";
import { reportLink } from "../erp/link";
import { describeRenamed } from "../erp/renamed";
import { handleReportSheet, type SheetOutcome } from "../erp/reports";
import { isReport, readSheets } from "../erp/sheets";
import { notifyAdmins } from "../notify";
import { intakePo } from "../orders/intake";
import { parseEmail } from "../quotes/email";
import { intakeRfq } from "../quotes/intake";
import { readRfqFile } from "../quotes/read";
import { triageEmail } from "../quotes/triage";
import {
  authenticated,
  emailAddress,
  type InboundAuth,
  type InboundKind,
  newToken,
  parseAddress,
  senderAllowed,
} from "./verify";

/** A shop's addresses, made the first time they're needed. */
export const ensureAddresses = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const existing = await db.inboundAddress.findMany();
  for (const kind of ["erp", "rfq"] as const) {
    if (!existing.some((a) => a.kind === kind)) {
      existing.push(
        await db.inboundAddress.create({
          data: { orgId, kind, token: newToken() },
        })
      );
    }
  }
  return existing;
};

/** Why this sender can't use the address, or null when it can. */
const refusal = (
  allowed: string[],
  from: string | null,
  auth: InboundAuth,
  mailFrom: string
) => {
  if (allowed.length === 0) {
    return `Nobody is allowed to send to this address yet. Add ${from ?? "the sender"} under Settings → Integrations → Email & ERP reports.`;
  }
  if (!senderAllowed(from, allowed)) {
    return `${from ?? "This sender"} isn't on the allowed list for this address.`;
  }
  if (!authenticated(auth, from, mailFrom)) {
    return `Couldn't verify that the message really came from ${from} (SPF/DKIM).`;
  }
  return null;
};

export interface Accepted {
  kind: InboundKind;
  messageId: string;
  orgId: string;
}

export type ReceiveResult =
  | { ok: true; accepted: Accepted[]; duplicates: number }
  | { ok: false; status: number; error: string };

/**
 * Check a delivered message against each shop address it was sent to and
 * record it. The slow part (reading reports and RFQs) runs afterwards, so
 * the mail server gets its answer quickly.
 */
export const receiveMessage = async (input: {
  auth: InboundAuth;
  mailFrom: string;
  raw: Uint8Array;
  recipients: string[];
}): Promise<ReceiveResult> => {
  const domain = env.INBOUND_EMAIL_DOMAIN;
  if (!domain) {
    return { ok: false, status: 503, error: "Inbound email isn't set up." };
  }
  const wanted = input.recipients
    .map((r) => parseAddress(r, domain))
    .filter((a): a is { kind: InboundKind; token: string } => a !== null);
  // Looked up by token across shops: the token is the secret part.
  const addresses = wanted.length
    ? await database.inboundAddress.findMany({
        where: { token: { in: wanted.map((w) => w.token) } },
      })
    : [];
  const matched = addresses.filter((a) =>
    wanted.some((w) => w.token === a.token && w.kind === a.kind)
  );
  if (matched.length === 0) {
    return { ok: false, status: 404, error: "No such address." };
  }

  const email = parseEmail(new TextDecoder().decode(input.raw));
  const from = emailAddress(email.from) ?? emailAddress(input.auth.from);
  const sha256 = createHash("sha256").update(input.raw).digest("hex");
  const accepted: Accepted[] = [];
  const refused: string[] = [];
  let duplicates = 0;

  for (const address of matched) {
    const db = forOrg(database, address.orgId);
    const problem = refusal(
      address.allowedSenders,
      from,
      input.auth,
      input.mailFrom
    );
    const seen = await db.inboundMessage.findFirst({
      where: { sha256 },
      select: { id: true },
    });
    if (seen) {
      duplicates += 1;
      continue;
    }
    const message = await db.inboundMessage.create({
      data: {
        orgId: address.orgId,
        kind: address.kind,
        sha256,
        fromAddress: from,
        subject: email.subject?.slice(0, 300) ?? null,
        status: problem ? "rejected" : "received",
        detail: problem ? { error: problem } : undefined,
      },
    });
    if (problem) {
      refused.push(problem);
      continue;
    }
    accepted.push({
      orgId: address.orgId,
      kind: address.kind as InboundKind,
      messageId: message.id,
    });
  }
  if (accepted.length === 0 && duplicates === 0) {
    // Bounced to the sender, who can fix it or tell the shop.
    return { ok: false, status: 403, error: refused[0] ?? "Not accepted." };
  }
  return { ok: true, accepted, duplicates };
};

const finish = (
  orgId: string,
  messageId: string,
  status: string,
  detail: object
) =>
  forOrg(database, orgId).inboundMessage.updateMany({
    where: { id: messageId },
    data: { status, detail },
  });

const describe = (o: SheetOutcome) => {
  if (o.status === "imported") {
    const r = o.result;
    return `${o.report}: ${r.created} added, ${r.updated} updated, ${r.skipped} skipped${r.closed ? `, ${r.closed} closed` : ""}`;
  }
  if (o.status === "duplicate") {
    return `${o.report}: the same file as earlier, nothing new to import`;
  }
  if (o.status === "needs_mapping") {
    return o.replaces
      ? `${o.report}: ${o.replaces.report.name} with changed columns (${describeRenamed(o.replaces)}), waiting for a click to confirm`
      : `${o.report}: new report, waiting for its columns to be confirmed`;
  }
  if (o.status === "paused") {
    return `${o.report}: paused, not imported`;
  }
  return `${o.report}: ${o.error ?? "failed"}`;
};

type NeedsMapping = Extract<SheetOutcome, { status: "needs_mapping" }>;

/**
 * Tell the admins what to check: a renamed column gets its own email with a
 * link straight to the one-click confirm; new reports share one.
 */
const notifyMapping = async (orgId: string, outcomes: SheetOutcome[]) => {
  const waiting = outcomes.filter(
    (o): o is NeedsMapping => o.status === "needs_mapping"
  );
  for (const o of waiting.filter((x) => x.replaces)) {
    const r = o.replaces;
    if (!r) {
      continue;
    }
    await notifyAdmins(
      orgId,
      `your ERP changed the columns of ${r.report.name}`,
      [
        `${r.report.name} arrived with different columns: ${describeRenamed(r)}.`,
        r.complete
          ? "Takumo moved your column choices over. Open the link and press \"Use the same columns\" to import it; it imports by itself again after that."
          : "Takumo moved over what it could, but a required column is missing. Open the link and choose it.",
        "Until then, this report isn't imported.",
      ],
      reportLink(o.reportId)
    );
  }
  const fresh = waiting.filter((o) => !o.replaces);
  if (fresh.length) {
    await notifyAdmins(
      orgId,
      "a new ERP report needs a quick check",
      [
        `Takumo received ${fresh.map((o) => o.report).join(", ")} for the first time.`,
        "Check what its columns mean once, and it imports by itself every night after that.",
      ],
      reportLink(fresh.length === 1 ? fresh[0]?.reportId : undefined)
    );
  }
};

/** An ERP report email: import every spreadsheet attached. */
const processReport = async (
  orgId: string,
  messageId: string,
  raw: Uint8Array
) => {
  const email = parseEmail(new TextDecoder().decode(raw));
  const files = email.attachments.filter((a) => isReport(a.name));
  if (files.length === 0) {
    await finish(orgId, messageId, "rejected", {
      error: "No CSV or Excel file attached.",
    });
    await notifyAdmins(orgId, "an ERP report email had no spreadsheet", [
      `A message to your ERP report address ("${email.subject ?? "no subject"}") had no CSV or Excel attachment, so nothing was imported.`,
    ]);
    return;
  }
  const outcomes: SheetOutcome[] = [];
  for (const file of files) {
    try {
      for (const sheet of readSheets(file.name, file.bytes)) {
        outcomes.push(await handleReportSheet(orgId, sheet));
      }
    } catch (error) {
      log.warn("Reading an ERP report failed", { orgId, error: String(error) });
      outcomes.push({
        status: "failed",
        report: file.name,
        error: "The file couldn't be read as a spreadsheet.",
      });
    }
  }
  if (outcomes.length === 0) {
    // Only a header row, or empty sheets: the ERP sent nothing to import.
    outcomes.push(
      ...files.map((f) => ({
        status: "failed" as const,
        report: f.name,
        error: "The file had no rows. Check the ERP's saved report.",
      }))
    );
  }
  const needsMapping = outcomes.filter((o) => o.status === "needs_mapping");
  const failed = outcomes.filter(
    (o): o is Extract<SheetOutcome, { status: "failed" | "paused" }> =>
      o.status === "failed"
  );
  let status = "processed";
  if (failed.length) {
    status = "failed";
  } else if (needsMapping.length) {
    status = "needs_mapping";
  }
  await finish(orgId, messageId, status, { reports: outcomes.map(describe) });
  track("erp_report_received", {
    orgId,
    properties: { sheets: outcomes.length, status },
  });
  await notifyMapping(orgId, needsMapping);
  if (failed.length) {
    await notifyAdmins(
      orgId,
      "an ERP report couldn't be imported",
      failed.map(describe),
      reportLink(failed.length === 1 ? failed[0]?.reportId : undefined)
    );
  }
};

/** A forwarded RFQ: read it like one that arrived in a connected mailbox. */
const processRfq = async (
  orgId: string,
  messageId: string,
  raw: Uint8Array,
  sha256: string
) => {
  const paused = await budgetProblem(orgId);
  if (paused) {
    await finish(orgId, messageId, "failed", { error: paused });
    return;
  }
  const text = await readRfqFile("message.eml", raw);
  // Staff forward customer POs here too: those go to Incoming POs.
  const kind = await triageEmail(orgId, {
    from: text.sender,
    subject: text.subject,
    body: text.body,
  });
  if (kind?.kind === "po" && kind.confidence !== "low") {
    const po = await intakePo(orgId, null, text, {
      sourceId: `inbound:${sha256}`,
    });
    await finish(orgId, messageId, "processed", {
      po: po.number,
      ...(po.duplicate ? { poRepeat: true } : {}),
    });
    return;
  }
  const rfq = await intakeRfq(orgId, null, text, {
    sourceId: `inbound:${sha256}`,
  });
  if (rfq.duplicate) {
    // The same sender sent the same files this week: linked, not repeated.
    await finish(orgId, messageId, "processed", { duplicateOf: rfq.number });
    return;
  }
  await finish(orgId, messageId, "processed", {
    rfq: rfq.number,
    ...(rfq.skipped.length ? { skipped: rfq.skipped } : {}),
  });
  track("rfq_received", {
    orgId,
    properties: { source: "inbound_email", channel: text.source },
  });
};

/** The slow half of receiving a message; never throws. */
export const processMessage = async (accepted: Accepted, raw: Uint8Array) => {
  try {
    if (accepted.kind === "erp") {
      await processReport(accepted.orgId, accepted.messageId, raw);
    } else {
      const sha256 = createHash("sha256").update(raw).digest("hex");
      await processRfq(accepted.orgId, accepted.messageId, raw, sha256);
    }
  } catch (error) {
    log.error("Processing an inbound message failed", {
      orgId: accepted.orgId,
      kind: accepted.kind,
      error: String(error),
    });
    await finish(accepted.orgId, accepted.messageId, "failed", {
      error: "Takumo couldn't process this message. It's been logged.",
    });
  }
};
