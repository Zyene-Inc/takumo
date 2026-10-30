-- Tribal knowledge and calibration (Phase 5): numbered facts with their
-- review trail, voice and typed notes, planned times on jobs (to measure the
-- model's error), RLS on Note, and facts for Ask Takumo's query_data.

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "loggedBy" TEXT,
ADD COLUMN     "plannedRunMinPerUnit" DOUBLE PRECISION,
ADD COLUMN     "plannedSetupMin" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Fact" ADD COLUMN     "noteId" TEXT,
ADD COLUMN     "number" INTEGER,
ADD COLUMN     "previousValue" JSONB,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "subjectLabel" TEXT;

-- Number and label any facts that already exist, then require both.
UPDATE "Fact" f SET "number" = n.number, "subjectLabel" = coalesce(f."subjectLabel", f."subjectType")
FROM (
  SELECT id, row_number() OVER (PARTITION BY "orgId" ORDER BY "createdAt", id) AS number
  FROM "Fact"
) n
WHERE f.id = n.id;
ALTER TABLE "Fact" ALTER COLUMN "number" SET NOT NULL,
ALTER COLUMN "subjectLabel" SET NOT NULL;

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION,
    "jobId" TEXT,
    "createdBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reading',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Note_orgId_createdAt_idx" ON "Note"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_orgId_actualEnd_idx" ON "Job"("orgId", "actualEnd");

-- CreateIndex
CREATE INDEX "Fact_orgId_status_idx" ON "Fact"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Fact_orgId_number_key" ON "Fact"("orgId", "number");

-- AddForeignKey
ALTER TABLE "Fact" ADD CONSTRAINT "Fact_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security backstop, as for the other tenant tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated')
      then 'authenticated'
    else 'public'
  end;
begin
  alter table "Note" enable row level security;
  drop policy if exists org_isolation on "Note";
  execute format(
    'create policy org_isolation on "Note" for all to %s
       using ("orgId" = public.current_org_id())
       with check ("orgId" = public.current_org_id())',
    grantee
  );
end $$;

-- Facts for query_data (see 20261031120000_ask_takumo).
create or replace view ask.facts as
  select 'F-' || f.number as fact_no, f."subjectType" as subject_type,
         f."subjectLabel" as subject, f.attribute,
         f.value #>> '{}' as value, f."previousValue" #>> '{}' as previous_value,
         f.status::text as status, f.source, f.evidence,
         f."createdAt"::date as stated_on, f."reviewedAt"::date as reviewed_on,
         f."validTo"::date as valid_to
  from "Fact" f
  where f."orgId" = (select ask_private.org_id());

-- Planned times on jobs, for comparing the model with what happened.
create or replace view ask.jobs as
  select o."orderNo" as order_no, j."routingSeq" as seq, w.name as work_center,
         j."plannedStart" as planned_start, j."plannedEnd" as planned_end,
         j."actualStart" as actual_start, j."actualEnd" as actual_end,
         j."actualSetupMin" as actual_setup_min, j."actualRunMin" as actual_run_min,
         j."qtyGood" as qty_good, j."qtyScrap" as qty_scrap, j.pinned,
         j."plannedSetupMin" as planned_setup_min,
         j."plannedRunMinPerUnit" as planned_run_min_per_unit
  from "Job" j
  join "Order" o on o.id = j."orderId"
  left join "WorkCenter" w on w.id = j."workCenterId"
  where j."orgId" = (select ask_private.org_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    grant select on ask.facts to takumo_reader;
    grant select on ask.jobs to takumo_reader;
  end if;
end $$;
