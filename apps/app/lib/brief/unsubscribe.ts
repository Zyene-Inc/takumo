import "server-only";

import { database } from "@repo/database";
import { ALERT_TITLE, ALERT_TYPES, type AlertType } from "@/lib/alerts/detect";
import { SECTION_TITLE, SECTIONS, type SectionKey } from "./content";
import { type LinkPayload, verifyLink } from "./links";
import { linkSecret, NO_SECRET } from "./urls";

// Unsubscribe links (F4.1-R4): one brief section, one alert type, or every
// email. The page asks first; the change is a POST (the page's button, or a
// mail app's one-click unsubscribe).

type Unsub = Extract<LinkPayload, { t: "unsub" }>;

const isSection = (s: string): s is SectionKey =>
  (SECTIONS as readonly string[]).includes(s);
const alertOf = (s: string): AlertType | null => {
  const t = s.startsWith("alert:") ? s.slice(6) : "";
  return (ALERT_TYPES as readonly string[]).includes(t)
    ? (t as AlertType)
    : null;
};

/** What stopping means, in words. */
export const describeUnsubscribe = (what: string) => {
  if (what === "all") {
    return "the morning brief and all alerts";
  }
  if (isSection(what)) {
    return `"${SECTION_TITLE[what]}" in your morning brief`;
  }
  const alert = alertOf(what);
  return alert ? `alerts for "${ALERT_TITLE[alert]}"` : null;
};

export const checkUnsubscribe = (
  token: string | null | undefined,
  now: Date
): { ok: true; payload: Unsub } | { ok: false; error: string } => {
  const secret = linkSecret();
  if (!secret) {
    return { ok: false, error: NO_SECRET };
  }
  const v = verifyLink(secret, token, now);
  if (!(v.ok && v.payload.t === "unsub" && describeUnsubscribe(v.payload.s))) {
    return {
      ok: false,
      error:
        "This link isn't valid any more. Change your emails in the app under Settings → Notifications.",
    };
  }
  return { ok: true, payload: v.payload };
};

export const applyUnsubscribe = async (payload: Unsub) => {
  const { o: orgId, u: userId, s: what } = payload;
  const prefs = await database.notifyPrefs.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  const briefOff = new Set(prefs?.briefOff ?? []);
  const alertsOff = new Set(prefs?.alertsOff ?? []);
  let briefOn = prefs?.briefOn ?? true;
  if (what === "all") {
    briefOn = false;
    for (const t of ALERT_TYPES) {
      alertsOff.add(t);
    }
  } else if (isSection(what)) {
    briefOff.add(what);
  } else {
    const alert = alertOf(what);
    if (alert) {
      alertsOff.add(alert);
    }
  }
  const data = { briefOn, briefOff: [...briefOff], alertsOff: [...alertsOff] };
  await database.notifyPrefs.upsert({
    where: { orgId_userId: { orgId, userId } },
    create: { orgId, userId, ...data },
    update: data,
  });
};
