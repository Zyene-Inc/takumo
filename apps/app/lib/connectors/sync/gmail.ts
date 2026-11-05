// Gmail sync: new RFQ mail since the last run.

import "server-only";
import { database } from "@repo/database";
import { budgetProblem } from "../../ai-usage";
import { listMessages, rawMessageAndThread, searchFor } from "../gmail";
import { gmailQuery, readRules } from "../rfq-rules";
import {
  accessToken,
  type ConnectionRow,
  DAY_MS,
  FIRST_LOOK_BACK_DAYS,
  type SyncResult,
} from "./connection";
import { intakeMessage, seenMessages, senderFilter } from "./intake";

/** New RFQ emails since the last check, each read into an RFQ once. */
export const syncGmail = async (
  orgId: string,
  connection: ConnectionRow
): Promise<SyncResult> => {
  const token = await accessToken(connection);
  const settings = (connection.settings as { query?: string } | null) ?? {};
  const rules = readRules(connection.settings);
  const allowed = await senderFilter(orgId, rules);
  const since =
    connection.lastSyncAt ??
    new Date(Date.now() - FIRST_LOOK_BACK_DAYS * DAY_MS);
  const started = new Date();
  const ids = await listMessages(
    fetch,
    token,
    searchFor(gmailQuery(settings.query, rules), since)
  );
  const seen = await seenMessages(orgId, ids);
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, notes: [] };
  let paused: string | null = null;
  // A message Gmail didn't hand over (a 429 or 5xx): the next check covers
  // it again, instead of moving past it for good.
  let unfetched = 0;
  // Oldest first, so RFQ numbers follow the order the mail arrived.
  for (const id of [...ids].reverse()) {
    if (seen.has(id)) {
      result.skipped += 1;
      continue;
    }
    // Reading an RFQ uses the AI: stop at the shop's monthly AI budget.
    paused = await budgetProblem(orgId);
    if (paused) {
      result.notes.push(paused);
      break;
    }
    let fetched: Awaited<ReturnType<typeof rawMessageAndThread>>;
    try {
      fetched = await rawMessageAndThread(fetch, token, id);
    } catch (error) {
      unfetched += 1;
      result.skipped += 1;
      result.notes.push(
        `Couldn't fetch message ${id} (will try again): ${error instanceof Error ? error.message : "error"}`
      );
      continue;
    }
    await intakeMessage(
      orgId,
      connection,
      "gmail",
      {
        id,
        bytes: fetched.bytes,
        threadId: fetched.threadId,
        allowed,
        label: `message ${id}`,
        mailbox: connection.account,
      },
      result
    );
  }
  if (paused || unfetched) {
    // The rest are read on a later check (once there's budget again, or
    // Gmail answers); messages already read are skipped by id.
    return result;
  }
  // Next time, only mail that arrived after this check started.
  await database.connection.update({
    where: { id: connection.id },
    data: { lastSyncAt: started },
  });
  return result;
};
