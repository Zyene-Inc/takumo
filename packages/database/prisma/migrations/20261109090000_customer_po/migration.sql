-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerPo" TEXT;

-- CreateTable
CREATE TABLE "CustomerPo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "poNo" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "contact" TEXT,
    "sender" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reading',
    "error" TEXT,
    "lines" JSONB,
    "checks" JSONB,
    "extracted" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enteredAt" TIMESTAMP(3),
    "enteredBy" TEXT,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPoFile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPoFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerPo_orgId_status_idx" ON "CustomerPo"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPo_orgId_number_key" ON "CustomerPo"("orgId", "number");

-- CreateIndex
CREATE INDEX "CustomerPoFile_orgId_poId_idx" ON "CustomerPoFile"("orgId", "poId");

-- AddForeignKey
ALTER TABLE "CustomerPo" ADD CONSTRAINT "CustomerPo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPo" ADD CONSTRAINT "CustomerPo_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPoFile" ADD CONSTRAINT "CustomerPoFile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPoFile" ADD CONSTRAINT "CustomerPoFile_poId_fkey" FOREIGN KEY ("poId") REFERENCES "CustomerPo"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['CustomerPo', 'CustomerPoFile'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
