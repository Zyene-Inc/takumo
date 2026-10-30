import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { PLAN } from "./schedule/plan";

export interface SetupStep {
  done: boolean;
  href: string;
  key: string;
  label: string;
  why: string;
}

/** Getting a shop running, in order. Each step is done when its data exists. */
export const setupSteps = async (orgId: string): Promise<SetupStep[]> => {
  const db = forOrg(database, orgId);
  const [
    machines,
    routings,
    orders,
    plans,
    questions,
    drafts,
    logged,
    members,
    connections,
    org,
  ] = await Promise.all([
    db.workCenter.count(),
    db.routing.count(),
    db.order.count({ where: { status: { in: ["open", "in_progress"] } } }),
    db.scheduleRun.count({ where: { objective: PLAN } }),
    db.conversation.count(),
    db.rfqLine.count({ where: { draft: { not: Prisma.DbNull } } }),
    db.job.count({ where: { loggedBy: { not: null } } }),
    db.member.count(),
    db.connection.count({ where: { status: "connected" } }),
    database.org.findUnique({ where: { id: orgId }, select: { plan: true } }),
  ]);
  return [
    {
      key: "shop",
      label: "Add your machines, parts and routings",
      why: "Upload the spreadsheets or ERP exports you already have.",
      href: "/onboarding",
      done: machines > 0 && routings > 0,
    },
    {
      key: "orders",
      label: "Add your open orders",
      why: 'So Takumo can plan the shop and answer "can we take it?"',
      href: "/onboarding?type=orders",
      done: orders > 0,
    },
    {
      key: "plan",
      label: "Build the schedule",
      why: "One click: a plan for every open order around your calendar.",
      href: "/schedule",
      done: plans > 0,
    },
    {
      key: "ask",
      label: "Ask Takumo a question",
      why: '"What\'s late?", "Can we take 200 of P-1001 by Friday?"',
      href: "/ask",
      done: questions > 0,
    },
    {
      key: "quote",
      label: "Draft a quote from an RFQ",
      why: "Paste an RFQ email: price, lead time and the evidence.",
      href: "/quotes",
      done: drafts > 0,
    },
    {
      key: "floor",
      label: "Log a finished job on the shop floor",
      why: "Actual times make every estimate better.",
      href: "/schedule/floor",
      done: logged > 0,
    },
    {
      key: "team",
      label: "Invite your team",
      why: "Planners, estimators and operators each see what they need.",
      href: "/settings/team",
      done: members > 1,
    },
    {
      key: "connect",
      label: "Connect QuickBooks or Gmail",
      why: "Past quotes from QuickBooks; RFQs straight from your inbox.",
      href: "/settings/integrations",
      done: connections > 0,
    },
    {
      key: "plan-choice",
      label: "Choose a plan",
      why: "Keep everything going after the trial.",
      href: "/settings/billing",
      done: Boolean(org && org.plan !== "trial"),
    },
  ];
};
