import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import {
  attributeDef,
  changesModel,
  factLabel,
  formatValue,
  parseFactLabel,
} from "@/lib/facts/attributes";
import { currentValue, subjectOptions } from "@/lib/facts/facts";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { AddFact } from "./add-fact";
import { FactCard, type FactView } from "./fact-card";

export const metadata: Metadata = { title: "Facts · Takumo" };

const TABS = [
  { key: "pending", label: "To review", statuses: ["pending"] },
  { key: "approved", label: "In force", statuses: ["approved"] },
  { key: "history", label: "History", statuses: ["superseded", "rejected"] },
] as const;

const emptyText = (only: boolean, tab: string) => {
  if (only) {
    return "No such fact.";
  }
  return tab === "pending"
    ? "Nothing to review. Tell Ask Takumo a correction, record a voice note, or log jobs on the shop floor: what Takumo learns shows up here."
    : "No facts here yet.";
};

const FactsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; f?: string }>;
}) => {
  const { orgId, canReviewFacts } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { tab: tabKey, f } = await searchParams;
  const only = f ? parseFactLabel(f) : null;
  const db = forOrg(database, orgId);
  const counts = await db.fact.groupBy({ by: ["status"], _count: true });
  const countOf = (statuses: readonly string[]) =>
    counts
      .filter((c) => statuses.includes(c.status))
      .reduce((sum, c) => sum + c._count, 0);
  const tab =
    TABS.find((t) => t.key === tabKey) ??
    (countOf(["pending"]) ? TABS[0] : TABS[1]);
  const [facts, options] = await Promise.all([
    db.fact.findMany({
      where: only ? { number: only } : { status: { in: [...tab.statuses] } },
      orderBy: { createdAt: tab.key === "pending" ? "asc" : "desc" },
      take: 200,
      include: { note: { select: { kind: true, text: true } } },
    }),
    subjectOptions(orgId),
  ]);

  const views: FactView[] = await Promise.all(
    facts.map(async (fact) => {
      const def = attributeDef(fact.subjectType, fact.attribute);
      const now =
        fact.status === "pending" && changesModel(fact.attribute)
          ? await currentValue(
              orgId,
              fact.subjectType,
              fact.subjectId,
              fact.attribute
            )
          : null;
      return {
        id: fact.id,
        label: factLabel(fact.number),
        status: fact.status,
        subjectType: fact.subjectType,
        subject: fact.subjectLabel,
        attribute: def?.label ?? fact.attribute,
        isNote: !changesModel(fact.attribute),
        numeric: def?.kind === "number",
        value: formatValue(def, fact.value),
        rawValue:
          def?.percent && typeof fact.value === "number"
            ? String(Math.round(fact.value * 100))
            : String(fact.value ?? ""),
        unit: def?.percent ? "%" : (def?.unit ?? null),
        current: now === null ? null : formatValue(def, now),
        previous:
          fact.previousValue === null
            ? null
            : formatValue(def, fact.previousValue),
        source: fact.source,
        byTakumo: fact.statedBy === null,
        evidence: fact.evidence,
        note: fact.note ? { kind: fact.note.kind, text: fact.note.text } : null,
        createdAt: fact.createdAt.toISOString(),
        reviewedAt: fact.reviewedAt?.toISOString() ?? null,
        reviewNote: fact.reviewNote,
      };
    })
  );

  return (
    <>
      <Header page="Facts" pages={["Knowledge"]}>
        <div className="flex gap-2 px-4">
          <AddFact options={options} />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          What your people know, kept with its history. Corrections from Ask
          Takumo, voice notes and the shop floor, and Takumo's own recalibration
          from finished jobs, wait here until a supervisor approves them. An
          approved number changes the routing, rate or cost it's about; the
          value it replaced stays in the history.
        </p>
        <nav className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <Button
              asChild
              key={t.key}
              size="sm"
              variant={!only && t.key === tab.key ? "secondary" : "ghost"}
            >
              <Link href={`/knowledge/facts?tab=${t.key}`}>
                {t.label} ({countOf(t.statuses)})
              </Link>
            </Button>
          ))}
        </nav>
        {!canReviewFacts && tab.key === "pending" && views.length > 0 && (
          <p className="text-muted-foreground text-sm">
            A planner or admin approves these. You can add facts; they'll show
            up here.
          </p>
        )}
        {views.length === 0 ? (
          <EmptyState>{emptyText(only !== null, tab.key)}</EmptyState>
        ) : (
          <div className="grid gap-3">
            {views.map((fact) => (
              <FactCard canReview={canReviewFacts} fact={fact} key={fact.id} />
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default FactsPage;
