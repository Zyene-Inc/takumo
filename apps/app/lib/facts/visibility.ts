import "server-only";

import { can } from "@repo/auth/permissions";
import { database, type Prisma } from "@repo/database";
import { documentCapabilities } from "../library/access";
import { factAccess } from "../library/ai-access";
import { audit } from "../library/audit";
import { has } from "../library/capabilities";
import { systemViewer, trustedViewer, type Viewer } from "../library/viewer";
import { factLabel } from "./attributes";
import type { Result } from "./subjects";

// Who may see a fact (library.fact_access), and publishing one to the whole
// company. A fact read from documents is seen only by people who may use
// every one of them; approving it doesn't change that. Publishing makes it
// company knowledge on purpose: it needs the owner, or a reviewer who
// manages every document it came from, and it is audited. Quotes from
// restricted documents stay hidden after publishing.

export const NO_FACT = "That fact no longer exists.";

/** The fact, when the viewer may see it; null otherwise (never "forbidden"). */
export const visibleFact = async (viewer: Viewer, factId: string) => {
  const { orgId } = trustedViewer(viewer);
  const access = await factAccess(viewer);
  if (!access.has(factId)) {
    return null;
  }
  return database.fact.findFirst({ where: { id: factId, orgId } });
};

/** Whether everyone in the shop may see this fact now. */
export const companyVisible = async (orgId: string, factId: string) =>
  (await factAccess(systemViewer(orgId))).has(factId);

/**
 * Why the viewer may not publish this fact, or null. The owner may; anyone
 * else needs knowledge:review and manage on every document it came from. A
 * fact whose documents can't be listed (unknown or deleted) only the owner
 * may publish.
 */
export const publishProblem = async (
  viewer: Viewer,
  fact: { id: string; provenance: string }
): Promise<string | null> => {
  const { isOwner, isSystem, role, orgId } = trustedViewer(viewer);
  if (isOwner) {
    return null;
  }
  const refusal =
    "Only the shop's owner, or a reviewer who manages every document this fact came from, can publish it to the company.";
  if (isSystem || !can(role, "knowledge:review")) {
    return refusal;
  }
  if (fact.provenance !== "documents") {
    return fact.provenance === "none" ? null : refusal;
  }
  const [sources, caps] = await Promise.all([
    database.factSource.findMany({
      where: { orgId, factId: fact.id },
      select: { sourceId: true },
    }),
    documentCapabilities(viewer),
  ]);
  const managesAll =
    sources.length > 0 &&
    sources.every((s) => has(caps.get(s.sourceId) ?? 0, "manage"));
  return managesAll ? null : refusal;
};

/** Mark a fact published, inside the caller's transaction, and audit it. */
export const markPublished = async (
  tx: Prisma.TransactionClient,
  viewer: Viewer,
  fact: { id: string; number: number },
  how: "publish" | "approve_and_publish"
) => {
  const { orgId, userId } = trustedViewer(viewer);
  await tx.fact.updateMany({
    where: { id: fact.id, orgId, publishedAt: null },
    data: { publishedAt: new Date(), publishedBy: userId ?? "takumo" },
  });
  await audit(
    {
      orgId,
      actorId: userId,
      action: "fact_publish",
      detail: { fact: factLabel(fact.number), how },
    },
    tx
  );
};

/** Publish a fact the viewer may see to the whole company (audited). */
export const publishFact = async (
  viewer: Viewer,
  factId: string
): Promise<Result<{ label: string }>> => {
  const fact = await visibleFact(viewer, factId);
  if (!fact) {
    return { ok: false, error: NO_FACT };
  }
  const label = factLabel(fact.number);
  if (fact.publishedAt) {
    return { ok: true, label };
  }
  const problem = await publishProblem(viewer, fact);
  if (problem) {
    return { ok: false, error: problem };
  }
  await database.$transaction((tx) =>
    markPublished(tx, viewer, fact, "publish")
  );
  return { ok: true, label };
};
