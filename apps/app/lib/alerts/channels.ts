import "server-only";

import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { log } from "@repo/observability/log";

// Where alerts go. Email today; Teams (F4.3-R1) plugs in as another channel
// with the same shape, chosen per person once it exists.

export interface AlertMessage {
  /** One line each, with the screen it opens. */
  lines: { href: string; text: string }[];
  subject: string;
  /** Stop this type of alert: a confirmation page and a one-click POST. */
  unsubscribe: { oneClick: string | null; page: string };
}

export interface AlertTarget {
  email: string;
  userId: string;
}

export interface AlertChannel {
  readonly name: string;
  /** Whether it can send at all (configured). */
  ready: () => boolean;
  send: (to: AlertTarget, message: AlertMessage) => Promise<boolean>;
}

export const emailChannel: AlertChannel = {
  name: "email",
  ready: () => Boolean(resend && emailKeys().RESEND_FROM),
  send: async (to, message) => {
    const from = emailKeys().RESEND_FROM;
    if (!(resend && from && to.email)) {
      log.info("Alert not emailed (no email service)", {
        subject: message.subject,
      });
      return false;
    }
    try {
      await resend.emails.send({
        from,
        to: [to.email],
        subject: `Takumo: ${message.subject}`,
        text: [
          ...message.lines.flatMap((l) => [l.text, l.href, ""]),
          `Stop these alerts: ${message.unsubscribe.page}`,
        ].join("\n"),
        headers: message.unsubscribe.oneClick
          ? {
              "List-Unsubscribe": `<${message.unsubscribe.oneClick}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : undefined,
      });
      return true;
    } catch (error) {
      log.warn("Alert not sent", { error: String(error) });
      return false;
    }
  },
};
