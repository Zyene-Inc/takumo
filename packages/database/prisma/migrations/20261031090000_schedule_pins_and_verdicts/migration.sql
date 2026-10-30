-- Phase 2: operations pinned on the schedule board, and planner verdicts on
-- "Can we take this order?" answers.

-- One planned job per order operation (the board's plan of record).
DELETE FROM "Job" a
USING "Job" b
WHERE a."orderId" = b."orderId"
  AND a."routingSeq" = b."routingSeq"
  AND a."id" > b."id";

ALTER TABLE "Job" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Job_orderId_routingSeq_key" ON "Job"("orderId", "routingSeq");

ALTER TABLE "ScheduleRun" ADD COLUMN "verdict" TEXT,
ADD COLUMN "verdictNote" TEXT,
ADD COLUMN "verdictBy" TEXT;

DROP INDEX IF EXISTS "ScheduleRun_orgId_idx";
CREATE INDEX "ScheduleRun_orgId_objective_createdAt_idx" ON "ScheduleRun"("orgId", "objective", "createdAt");
