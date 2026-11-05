import "server-only";

import { env } from "@/env";
import { actionPayload, LINK_TTL_S, type LinkAction, signLink } from "./links";

// Links in briefs and alerts. With EMAIL_LINK_SECRET set they're signed:
// tracked clicks, approve buttons and unsubscribe links. Without it, every
// link opens the app screen (sign-in needed) and there are no email buttons.

export const linkSecret = () => env.EMAIL_LINK_SECRET ?? null;

export const NO_SECRET =
  "Email buttons aren't set up for this Takumo yet (EMAIL_LINK_SECRET is missing). Open the app to do this.";

const app = (path: string) => `${env.NEXT_PUBLIC_APP_URL}${path}`;

const expires = (now: Date) => Math.floor(now.getTime() / 1000) + LINK_TTL_S;

interface Recipient {
  orgId: string;
  userId: string;
}

export const linkMaker = (to: Recipient, now: Date) => {
  const secret = linkSecret();
  return {
    signed: secret !== null,
    /** A tracked link to an app screen (counts as reading the brief). */
    go: (section: string, path: string) =>
      secret
        ? app(
            `/email/l?t=${signLink(secret, { t: "go", o: to.orgId, u: to.userId, s: section, p: path, e: expires(now) })}`
          )
        : app(path),
    /** An approve / reject / won / lost button (null when links aren't signed). */
    act: (action: LinkAction) =>
      secret
        ? app(
            `/email/act?t=${signLink(secret, actionPayload(to.orgId, to.userId, action, now))}`
          )
        : null,
    /** Stop a section, an alert type ("alert:late"), or everything ("all"). */
    unsubscribe: (what: string) =>
      secret
        ? app(
            `/email/unsubscribe?t=${signLink(secret, { t: "unsub", o: to.orgId, u: to.userId, s: what, e: expires(now) })}`
          )
        : app("/settings/notifications"),
    /** For the List-Unsubscribe header: a one-click POST (RFC 8058). */
    oneClick: (what: string) =>
      secret
        ? app(
            `/api/email/unsubscribe?t=${signLink(secret, { t: "unsub", o: to.orgId, u: to.userId, s: what, e: expires(now) })}`
          )
        : null,
    settings: () => app("/settings/notifications"),
  };
};
