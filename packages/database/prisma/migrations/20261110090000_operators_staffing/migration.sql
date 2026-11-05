
-- AlterTable
ALTER TABLE "WorkCenter" ADD COLUMN     "operatorsPerMachine" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "unattendedRuns" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "canRunUnattended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "shifts" JSONB,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "workCenterIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "OperatorDay" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,

    CONSTRAINT "OperatorDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatorDay_orgId_idx" ON "OperatorDay"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorDay_operatorId_date_key" ON "OperatorDay"("operatorId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_orgId_externalId_key" ON "Operator"("orgId", "externalId");

-- AddForeignKey
ALTER TABLE "OperatorDay" ADD CONSTRAINT "OperatorDay_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorDay" ADD CONSTRAINT "OperatorDay_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['OperatorDay'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
