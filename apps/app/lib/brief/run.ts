import "server-only";

import { listShopMembers, type ShopMember } from "@repo/auth/server";
import { database } from "@repo/database";
import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { renderBriefEmail } from "@repo/email/templates/brief";
import { log } from "@repo/observability/log";
import { shortDay } from "../schedule/material";
import {
  assembleBrief,
  type BriefSection,
  briefSubject,
  type SectionKey,
  type ShopBrief,
  sectionsFor,
} from "./content";
import { loadShopBrief } from "./load";
import { type BriefTiming, briefDue, DEFAULT_TIMING } from "./timing";
import { linkMaker } from "./urls";

// The morning brief run (every 15 minutes, from /api/cron/notify): for each
// person whose brief time has come, the sections their role gets, with
// something in them; nothing when every section is empty (F4.1-R4).

/**
 * Claims today's brief for one person, so two overlapping runs never send it
 * twice. True when this run should send it.
 */
const claim = async (orgId: string, userId: string, date: string) => {
  const updated = await database.notifyPrefs.updateMany({
    where: {
      orgId,
      userId,
      OR: [{ lastBriefOn: null }, { lastBriefOn: { not: date } }],
    },
    data: { lastBriefOn: date },
  });
  if (updated.count === 1) {
    return true;
  }
  try {
    await database.notifyPrefs.create({
      data: { orgId, userId, lastBriefOn: date },
    });
    return true;
  } catch {
    // The row exists (already claimed today) or was just made by another run.
    return false;
  }
};

const buildEmail = async (
  member: ShopMember,
  orgId: string,
  sections: BriefSection[],
  day: string,
  now: Date
) => {
  const links = linkMaker({ orgId, userId: member.userId }, now);
  const props = {
    heading: `Good morning${member.name && !member.name.includes("@") ? `, ${member.name.split(" ")[0]}` : ""}. Here's ${shortDay(day)}.`,
    preview: sections
      .map((s) => s.summary ?? s.title)
      .join(" · ")
      .slice(0, 140),
    settingsHref: links.settings(),
    stopAllHref: links.unsubscribe("all"),
    sections: sections.map((s) => ({
      title: s.title,
      summary: s.summary,
      unsubscribeHref: links.unsubscribe(s.key),
      lines: s.lines.map((l) => ({
        text: l.text,
        href: links.go(s.key, l.path),
        buttons: (l.buttons ?? []).flatMap((b) => {
          const href = links.act(b.action);
          return href ? [{ label: b.label, href }] : [];
        }),
      })),
    })),
  };
  const { html, text } = await renderBriefEmail(props);
  const oneClick = links.oneClick("all");
  return {
    html,
    text,
    headers: oneClick
      ? {
          "List-Unsubscribe": `<${oneClick}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : undefined,
  };
};

interface BriefRun {
  checked: number;
  empty: number;
  failed: number;
  sent: number;
}

type Prefs = Awaited<ReturnType<typeof database.notifyPrefs.findMany>>[number];

interface Due {
  date: string;
  keys: SectionKey[];
  member: ShopMember;
  off: string[];
}

/** People in the shop whose brief is due now and who get any section. */
const dueMembers = (
  orgId: string,
  members: ShopMember[],
  prefsOf: Map<string, Prefs>,
  now: Date
): Due[] =>
  members.flatMap((m) => {
    const p = prefsOf.get(`${orgId}|${m.userId}`);
    const timing: BriefTiming = p ?? DEFAULT_TIMING;
    const when = briefDue(timing, now);
    const off = p?.briefOff ?? [];
    const keys = sectionsFor(m.role).filter((k) => !off.includes(k));
    return when.due && m.email && keys.length
      ? [{ member: m, date: when.date, keys, off }]
      : [];
  });

/** One person's brief: claimed, assembled, sent (or nothing when empty). */
const sendOne = async (
  orgId: string,
  d: Due,
  data: ShopBrief,
  from: string,
  now: Date,
  result: BriefRun
) => {
  result.checked += 1;
  if (!(await claim(orgId, d.member.userId, d.date))) {
    return;
  }
  const sections = assembleBrief(d.member.role, d.off, data);
  if (sections.length === 0) {
    result.empty += 1;
    return;
  }
  try {
    const email = await buildEmail(d.member, orgId, sections, d.date, now);
    await resend?.emails.send({
      from,
      to: [d.member.email],
      subject: briefSubject(sections, d.date),
      html: email.html,
      text: email.text,
      headers: email.headers,
    });
    result.sent += 1;
  } catch (error) {
    result.failed += 1;
    log.warn("Brief not sent", { orgId, error: String(error) });
  }
};

/** Every brief due in one shop. */
const briefShop = async (
  orgId: string,
  prefsOf: Map<string, Prefs>,
  from: string,
  now: Date,
  result: BriefRun
) => {
  let members: ShopMember[];
  try {
    members = await listShopMembers(orgId);
  } catch (error) {
    log.warn("Brief: couldn't list members", { orgId, error: String(error) });
    return;
  }
  const due = dueMembers(orgId, members, prefsOf, now);
  if (due.length === 0) {
    return;
  }
  let data: ShopBrief;
  try {
    // The shop's day as its first due person sees it.
    data = await loadShopBrief(
      orgId,
      due[0].date,
      now,
      new Set<SectionKey>(due.flatMap((d) => d.keys))
    );
  } catch (error) {
    log.error("Brief: couldn't load the shop", { orgId, error: String(error) });
    result.failed += due.length;
    return;
  }
  for (const d of due) {
    await sendOne(orgId, d, data, from, now, result);
  }
};

/** Send every brief that's due at `now`. */
export const runBriefs = async (now: Date): Promise<BriefRun> => {
  const result: BriefRun = { checked: 0, sent: 0, empty: 0, failed: 0 };
  const from = emailKeys().RESEND_FROM;
  if (!(resend && from)) {
    log.info("Morning briefs not sent (no email service)");
    return result;
  }
  const [orgs, prefs] = await Promise.all([
    database.org.findMany({ select: { id: true } }),
    database.notifyPrefs.findMany(),
  ]);
  const prefsOf = new Map(prefs.map((p) => [`${p.orgId}|${p.userId}`, p]));
  // Someone with no settings yet gets the default time.
  const defaultDue = briefDue(DEFAULT_TIMING, now).due;
  for (const org of orgs) {
    const anyDue =
      defaultDue ||
      prefs.some((p) => p.orgId === org.id && briefDue(p, now).due);
    if (anyDue) {
      await briefShop(org.id, prefsOf, from, now, result);
    }
  }
  return result;
};
