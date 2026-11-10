import "server-only";

import { can } from "@repo/auth/permissions";
import { listShopMembers } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import { track } from "../analytics";
import { featureProblem } from "../billing";
import { DocumentExistsError, documentNamed } from "../knowledge/documents";
import { ingestDocument } from "../knowledge/ingest";
import { publicFolderId } from "../library/folders";
import { authorizeDocument, authorizeFolder } from "../library/guard";
import { DocumentProblem } from "../library/problems";
import { libraryEnabled } from "../library/stage";
import { viewerForMember } from "../library/viewer";
import { parseEmail } from "../quotes/email";
import { replySubject, threadHeaders } from "./ask-email";
import { type DocOutcome, docsReply, pickDocuments } from "./docs-email";

// Documents emailed to the shop's docs-…@ address (F6.2-R1): someone in the
// shop sends a setup sheet, SOP or spec; each attachment goes through the
// same reading as an upload on the Knowledge page, and Takumo replies with
// what it linked and the facts it proposed.

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

const send = async (
  to: string,
  subject: string,
  text: string,
  headers: Record<string, string>
) => {
  const from = emailKeys().RESEND_FROM;
  if (!(resend && from)) {
    return false;
  }
  await resend.emails.send({ from, to, subject, text, headers });
  return true;
};

const EXISTS =
  "there's already a document with this name. Rename the file and send it again.";

const failureText = (error: unknown) => {
  if (error instanceof DocumentExistsError) {
    return EXISTS;
  }
  if (error instanceof DocumentProblem) {
    return error.message;
  }
  return error instanceof Error && error.message.startsWith("No text found")
    ? "no text found in it."
    : "Takumo couldn't read it just now. Upload it on the Knowledge page instead.";
};

/** Where an emailed document goes: Public, if the sender may add to it. */
const emailFolder = async (orgId: string, userId: string) => {
  if (!(await libraryEnabled(orgId))) {
    return null;
  }
  const folderId = await publicFolderId(orgId);
  const viewer = folderId ? await viewerForMember(orgId, userId) : null;
  return folderId &&
    viewer &&
    (await authorizeFolder(viewer, folderId, "upload")).ok
    ? folderId
    : null;
};

/** Read one document; never throws. */
const readOne = async (
  orgId: string,
  userId: string,
  file: { name: string; bytes: Uint8Array }
): Promise<DocOutcome> => {
  // Like an upload: an email never replaces a document. Checked again when
  // the document is created, in case one arrived in the meantime. A
  // document the sender can't see is never revealed: theirs is stored as
  // "Name (2)" instead.
  // Into Public, like an upload with no folder chosen, when the sender may
  // add documents there; outside any folder while the library is off.
  const folderId = await emailFolder(orgId, userId);
  const existing = await documentNamed(orgId, file.name, folderId);
  let hidden = false;
  if (existing) {
    const viewer = await viewerForMember(orgId, userId);
    const visible = viewer
      ? (await authorizeDocument(viewer, existing.id, "view")).ok
      : false;
    if (visible) {
      return { ok: false, name: file.name, error: EXISTS };
    }
    hidden = true;
  }
  const steps: string[] = [];
  let done: Extract<DocOutcome, { ok: true }> | null = null;
  try {
    await ingestDocument(
      orgId,
      userId,
      file,
      (event) => {
        if (event.type === "step") {
          steps.push(event.text);
        } else if (event.type === "done") {
          done = {
            ok: true,
            name: event.name,
            facts: event.facts,
            linked: event.linked,
            passages: event.passages,
            steps,
          };
        }
      },
      { via: "email", folderId, hidden }
    );
  } catch (error) {
    log.warn("Reading an emailed document failed", {
      orgId,
      error: String(error),
    });
    return { ok: false, name: file.name, error: failureText(error) };
  }
  return (
    done ?? {
      ok: false,
      name: file.name,
      error: "Takumo couldn't read it just now.",
    }
  );
};

/** Read every document in one email to the docs address; never throws. */
export const processDocs = async (
  orgId: string,
  messageId: string,
  raw: Uint8Array
) => {
  const email = parseEmail(new TextDecoder().decode(raw));
  // Who sent it, as checked when it arrived (receiveMessage: the From header
  // as sent, its domain authenticated), never re-read from the decoded
  // header (security audit M3).
  const sender =
    (
      await database.inboundMessage.findFirst({
        where: { id: messageId, orgId },
        select: { fromAddress: true },
      })
    )?.fromAddress ?? null;
  const subject = replySubject(email.subject);
  const headers = threadHeaders(email.headers);
  try {
    const member = (await listShopMembers(orgId)).find(
      (m) => m.email?.toLowerCase() === sender
    );
    if (!(member && sender && can(member.role, "knowledge:share"))) {
      await finish(orgId, messageId, "rejected", {
        error: "Only people in the shop can send documents.",
      });
      return;
    }
    const blocked = await featureProblem(orgId, "knowledge");
    if (blocked) {
      await send(sender, subject, blocked, headers);
      await finish(orgId, messageId, "failed", { error: blocked });
      return;
    }
    const { read, left } = pickDocuments(email.attachments);
    const outcomes: DocOutcome[] = [];
    for (const file of read) {
      // The uploader is the shop member the sender's address belongs to.
      outcomes.push(await readOne(orgId, member.userId, file));
    }
    const emailed = await send(
      sender,
      subject,
      docsReply({
        outcomes,
        left,
        knowledgeUrl: `${env.NEXT_PUBLIC_APP_URL}/knowledge`,
        factsUrl: `${env.NEXT_PUBLIC_APP_URL}/knowledge/facts`,
      }),
      headers
    );
    const failed = outcomes.filter((o) => !o.ok).length;
    const status =
      outcomes.length > 0 && failed < outcomes.length ? "processed" : "failed";
    await finish(orgId, messageId, status, {
      documents: outcomes.map((o) =>
        o.ok
          ? `${o.name}: ${o.facts.length} fact${o.facts.length === 1 ? "" : "s"} proposed`
          : `${o.name}: ${o.error}`
      ),
      ...(left.length ? { skipped: left } : {}),
      ...(outcomes.length === 0 ? { error: "No document attached." } : {}),
      emailed,
    });
    track("document_emailed", {
      orgId,
      userId: member.userId,
      properties: {
        documents: outcomes.length,
        failed,
        facts: outcomes.reduce((n, o) => n + (o.ok ? o.facts.length : 0), 0),
      },
    });
  } catch (error) {
    log.error("Processing emailed documents failed", {
      orgId,
      error: String(error),
    });
    await finish(orgId, messageId, "failed", {
      error: "Takumo couldn't read these documents. It's been logged.",
    });
    if (sender) {
      await send(
        sender,
        subject,
        "Takumo couldn't read your documents just now. Try again in a few minutes, or upload them on the Knowledge page.",
        headers
      ).catch(() => undefined);
    }
  }
};
