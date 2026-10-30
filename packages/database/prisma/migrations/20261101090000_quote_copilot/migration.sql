-- Quote Copilot (Phase 4): RFQs read into lines, drafts kept beside what was
-- quoted, and row-level security on the new table.

-- DropIndex
DROP INDEX "Rfq_orgId_idx";

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "breaks" JSONB,
ADD COLUMN     "draftLeadTimeDays" INTEGER,
ADD COLUMN     "draftPrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Rfq" ADD COLUMN     "body" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "contact" TEXT,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "number" INTEGER,
ADD COLUMN     "requestedDate" DATE,
ADD COLUMN     "sender" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "status" SET DEFAULT 'reading';

-- Number any RFQs that already exist, then require a number.
UPDATE "Rfq" r SET "number" = n.number
FROM (
  SELECT id, row_number() OVER (PARTITION BY "orgId" ORDER BY "receivedAt", id) AS number
  FROM "Rfq"
) n
WHERE r.id = n.id;
ALTER TABLE "Rfq" ALTER COLUMN "number" SET NOT NULL,
ALTER COLUMN "body" DROP DEFAULT;

-- CreateTable
CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "partNo" TEXT,
    "rev" TEXT,
    "description" TEXT,
    "materialText" TEXT,
    "qtys" INTEGER[],
    "tolerances" TEXT,
    "finish" TEXT,
    "notes" TEXT,
    "partId" TEXT,
    "materialId" TEXT,
    "routing" JSONB,
    "outside" JSONB,
    "usagePerPart" DOUBLE PRECISION,
    "materialCost" DOUBLE PRECISION,
    "targetMargin" DOUBLE PRECISION,
    "draft" JSONB,
    "final" JSONB,
    "quoteId" TEXT,

    CONSTRAINT "RfqLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RfqLine_quoteId_key" ON "RfqLine"("quoteId");

-- CreateIndex
CREATE INDEX "RfqLine_orgId_idx" ON "RfqLine"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "RfqLine_rfqId_lineNo_key" ON "RfqLine"("rfqId", "lineNo");

-- CreateIndex
CREATE INDEX "Quote_rfqId_idx" ON "Quote"("rfqId");

-- CreateIndex
CREATE INDEX "Rfq_orgId_status_idx" ON "Rfq"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_orgId_number_key" ON "Rfq"("orgId", "number");

-- AddForeignKey
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level security backstop, as for the other tenant tables (see
-- 20261030120100_tenant_rls).
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated')
      then 'authenticated'
    else 'public'
  end;
begin
  alter table "RfqLine" enable row level security;
  drop policy if exists org_isolation on "RfqLine";
  execute format(
    'create policy org_isolation on "RfqLine" for all to %s
       using ("orgId" = public.current_org_id())
       with check ("orgId" = public.current_org_id())',
    grantee
  );
end $$;
