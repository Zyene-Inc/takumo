import "server-only";

import { listShopMembers } from "@repo/auth/server";
import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { log } from "@repo/observability/log";
import { env } from "@/env";

/**
 * Email a shop's owners and admins about something they need to fix (a report
 * that can't be read, a mailbox that disconnected). Plain text, one link.
 * Without an email service configured it's only logged: the integrations
 * page shows the same problems.
 */
export const notifyAdmins = async (
  orgId: string,
  subject: string,
  lines: string[],
  path = "/settings/integrations"
) => {
  const from = emailKeys().RESEND_FROM;
  if (!(resend && from)) {
    log.info("Admin notice not emailed (no email service)", { orgId, subject });
    return false;
  }
  try {
    const admins = (await listShopMembers(orgId))
      .filter((m) => ["owner", "admin"].includes(m.role) && m.email)
      .map((m) => m.email);
    if (admins.length === 0) {
      return false;
    }
    await resend.emails.send({
      from,
      to: admins,
      subject: `Takumo: ${subject}`,
      text: [...lines, "", `${env.NEXT_PUBLIC_APP_URL}${path}`].join("\n"),
    });
    return true;
  } catch (error) {
    log.warn("Admin notice failed", { orgId, error: String(error) });
    return false;
  }
};

/**
 * Email the person a notice is for: the first of `userIds` who is still a
 * member, else the shop's owners and admins. Internal only (it may link into
 * Takumo); never used for anything a customer sees.
 */
export const notifyMember = async (
  orgId: string,
  userIds: (string | null | undefined)[],
  subject: string,
  lines: string[],
  path: string
) => {
  const from = emailKeys().RESEND_FROM;
  if (!(resend && from)) {
    log.info("Notice not emailed (no email service)", { orgId, subject });
    return false;
  }
  try {
    const members = await listShopMembers(orgId);
    const person = userIds
      .filter((id): id is string => Boolean(id))
      .map((id) => members.find((m) => m.userId === id && m.email))
      .find(Boolean);
    const to = person
      ? [person.email]
      : members
          .filter((m) => ["owner", "admin"].includes(m.role) && m.email)
          .map((m) => m.email);
    if (to.length === 0) {
      return false;
    }
    await resend.emails.send({
      from,
      to,
      subject: `Takumo: ${subject}`,
      text: [...lines, `${env.NEXT_PUBLIC_APP_URL}${path}`].join("\n"),
    });
    return true;
  } catch (error) {
    log.warn("Notice failed", { orgId, error: String(error) });
    return false;
  }
};
