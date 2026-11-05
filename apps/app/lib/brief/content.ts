// The morning brief's content (docs/PRODUCT-PLAN.md F4.1): which sections a
// role gets, and the lines in each. Only sections with something in them;
// a brief with no sections isn't sent. Pure, so tested.

import { shortDay } from "../schedule/material";
import type { LinkAction } from "./links";
import type { Bottleneck, LateOrder, MaterialShort } from "./plan-view";

export const SECTIONS = [
  "late",
  "bottleneck",
  "quotes",
  "facts",
  "material",
  "sync",
] as const;
export type SectionKey = (typeof SECTIONS)[number];

export const SECTION_TITLE: Record<SectionKey, string> = {
  late: "Late or at risk",
  bottleneck: "Today's bottleneck",
  quotes: "Quotes waiting",
  facts: "Facts to approve",
  material: "Material short this week",
  sync: "Sync problems",
};

/** What each section is, for the settings page. */
export const SECTION_HINT: Record<SectionKey, string> = {
  late: "Orders the plan finishes late or on the due date, with the cause and what would help most.",
  bottleneck: "The busiest machine today and how full it is.",
  quotes:
    "Drafts not sent after a day, RFQs two days old with no draft, and quotes sent with no answer yet.",
  facts: "What people told Takumo that needs a supervisor's yes or no.",
  material: "Orders starting this week whose material isn't here yet.",
  sync: "ERP reports that stopped arriving and mailboxes that disconnected.",
};

/**
 * Sections by role. Owners and admins get everything; planners (the
 * supervisors) the floor; estimators the quotes. Operators get no brief.
 */
export const sectionsFor = (role: string | null): SectionKey[] => {
  switch (role) {
    case "owner":
    case "admin":
      return [...SECTIONS];
    case "planner":
      return ["late", "bottleneck", "facts", "material"];
    case "estimator":
      return ["quotes"];
    default:
      return [];
  }
};

interface BriefButton {
  action: LinkAction;
  label: string;
}

export interface BriefLine {
  buttons?: BriefButton[];
  /** The screen it opens. */
  path: string;
  text: string;
}

export interface BriefSection {
  key: SectionKey;
  lines: BriefLine[];
  /** A line under the title, e.g. "5 waiting; the oldest 3 below". */
  summary?: string;
  title: string;
}

export interface WaitingDraft {
  customer: string | null;
  hours: number;
  label: string;
  rfqId: string;
}

export interface WaitingRfq {
  customer: string | null;
  days: number;
  label: string;
  rfqId: string;
}

export interface UnansweredQuote {
  customer: string | null;
  days: number;
  lineId: string;
  quoteNo: string;
  rfqId: string;
}

export interface PendingFact {
  id: string;
  text: string;
}

/** Everything a shop's briefs are made from, loaded once per shop. */
export interface ShopBrief {
  atRisk: LateOrder[];
  bottleneck: Bottleneck | null;
  drafts: WaitingDraft[];
  facts: { count: number; top: PendingFact[] };
  late: LateOrder[];
  material: MaterialShort[];
  noDraft: WaitingRfq[];
  /** When the plan the brief reads was made (null: no plan yet). */
  planDay: string | null;
  sync: string[];
  unanswered: UnansweredQuote[];
}

const BULLET = /^•\s*/;

/** The most lines a section shows; the rest are a link away. */
const MAX_LINES = 5;
const TOP_FACTS = 3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const from = (customer: string | null) => (customer ? ` (${customer})` : "");

const lateLine = (o: LateOrder): BriefLine => ({
  text:
    o.daysLate > 0
      ? `${o.orderNo}${from(o.customer)}: ${plural(o.daysLate, "day")} late, due ${shortDay(o.due)}. ${o.causeText}. Best lever: ${o.lever}.`
      : `${o.orderNo}${from(o.customer)}: at risk, finishes ${shortDay(o.completion)} for ${shortDay(o.due)}. ${o.causeText}. Best lever: ${o.lever}.`,
  path: "/schedule/bottlenecks",
});

const more = (shown: number, total: number) =>
  total > shown ? ` The first ${shown} below.` : "";

const build: Record<SectionKey, (d: ShopBrief) => BriefSection | null> = {
  late: (d) => {
    const rows = [...d.late, ...d.atRisk];
    if (rows.length === 0) {
      return null;
    }
    const counts = [
      d.late.length ? `${plural(d.late.length, "order")} late` : null,
      d.atRisk.length ? `${d.atRisk.length} at risk` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      key: "late",
      title: SECTION_TITLE.late,
      summary: `${counts}${d.planDay ? `, from the plan made ${shortDay(d.planDay)}` : ""}.${more(MAX_LINES, rows.length)}`,
      lines: rows.slice(0, MAX_LINES).map(lateLine),
    };
  },
  bottleneck: (d) => {
    const b = d.bottleneck;
    if (!b) {
      return null;
    }
    const pct = Math.round((b.loadMinutes / b.capacityMinutes) * 100);
    const h = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;
    return {
      key: "bottleneck",
      title: SECTION_TITLE.bottleneck,
      lines: [
        {
          text: `${b.machine}: ${h(b.loadMinutes)} booked of ${h(b.capacityMinutes)} (${pct}%).`,
          path: "/schedule/bottlenecks",
        },
      ],
    };
  },
  quotes: (d) => {
    const lines: BriefLine[] = [
      ...d.drafts.map((q) => ({
        text: `${q.label}${from(q.customer)}: draft ready ${plural(q.hours, "hour")} ago, not sent.`,
        path: `/quotes/${q.rfqId}`,
      })),
      ...d.noDraft.map((q) => ({
        text: `${q.label}${from(q.customer)}: ${plural(q.days, "day")} old, no draft yet.`,
        path: `/quotes/${q.rfqId}`,
      })),
      ...d.unanswered.map((q) => ({
        text: `${q.quoteNo}${from(q.customer)}: sent ${plural(q.days, "day")} ago, no answer yet.`,
        path: `/quotes/${q.rfqId}`,
        buttons: [
          {
            label: "Won",
            action: {
              kind: "quote",
              rfqId: q.rfqId,
              lineId: q.lineId,
              decision: "won",
            },
          },
          {
            label: "Lost",
            action: {
              kind: "quote",
              rfqId: q.rfqId,
              lineId: q.lineId,
              decision: "lost",
            },
          },
        ] satisfies BriefButton[],
      })),
    ];
    if (lines.length === 0) {
      return null;
    }
    return {
      key: "quotes",
      title: SECTION_TITLE.quotes,
      summary: `${plural(lines.length, "quote")} need you.${more(MAX_LINES, lines.length)}`,
      lines: lines.slice(0, MAX_LINES),
    };
  },
  facts: (d) => {
    if (d.facts.count === 0) {
      return null;
    }
    return {
      key: "facts",
      title: SECTION_TITLE.facts,
      summary: `${plural(d.facts.count, "fact")} waiting.${more(Math.min(TOP_FACTS, d.facts.top.length), d.facts.count)}`,
      lines: d.facts.top.slice(0, TOP_FACTS).map((f) => ({
        text: f.text,
        path: "/knowledge/facts",
        buttons: [
          {
            label: "Approve",
            action: { kind: "fact", factId: f.id, decision: "approve" },
          },
          {
            label: "Reject",
            action: { kind: "fact", factId: f.id, decision: "reject" },
          },
        ],
      })),
    };
  },
  material: (d) => {
    if (d.material.length === 0) {
      return null;
    }
    return {
      key: "material",
      title: SECTION_TITLE.material,
      summary: more(MAX_LINES, d.material.length).trim() || undefined,
      lines: d.material.slice(0, MAX_LINES).map((m) => ({
        text: `${m.orderNo} starts ${shortDay(m.starts)}: ${m.note}.`,
        path: "/shop/orders",
      })),
    };
  },
  sync: (d) => {
    if (d.sync.length === 0) {
      return null;
    }
    return {
      key: "sync",
      title: SECTION_TITLE.sync,
      lines: d.sync.map((text) => ({
        text: text.replace(BULLET, ""),
        path: "/settings/integrations",
      })),
    };
  },
};

/**
 * One person's brief: the sections their role gets, minus the ones they
 * turned off, with something in them. Empty: send nothing.
 */
export const assembleBrief = (
  role: string | null,
  off: readonly string[],
  data: ShopBrief
): BriefSection[] =>
  sectionsFor(role)
    .filter((key) => !off.includes(key))
    .map((key) => build[key](data))
    .filter((s): s is BriefSection => s !== null && s.lines.length > 0);

/** The email subject: what needs them most, in a few words. */
export const briefSubject = (sections: BriefSection[], day: string) => {
  const parts = sections.map((s) => {
    switch (s.key) {
      case "late":
        return "orders at risk";
      case "quotes":
        return "quotes waiting";
      case "facts":
        return "facts to approve";
      case "material":
        return "material short";
      case "sync":
        return "sync problems";
      default:
        return null;
    }
  });
  const named = parts.filter(Boolean).slice(0, 3).join(", ");
  return `Morning brief, ${shortDay(day)}${named ? `: ${named}` : ""}`;
};
