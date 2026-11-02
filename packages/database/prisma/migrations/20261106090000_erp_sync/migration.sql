-- Phase 1: ERP reports and RFQs by email, stock and purchase orders,
-- and when the ERP last updated each record (docs/PRODUCT-PLAN.md F1.3–F1.5).

-- AlterTable
ALTER TABLE "WorkCenter" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "materialQtyPerUnit" DOUBLE PRECISION,
ADD COLUMN     "materialUnit" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Routing" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InboundAddress" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "allowedSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "InboundAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fromAddress" TEXT,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "detail" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErpReport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headerKey" TEXT NOT NULL,
    "headers" TEXT[],
    "entity" TEXT NOT NULL,
    "mapping" JSONB,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'needs_mapping',
    "pending" JSONB,
    "lastReceivedAt" TIMESTAMP(3),
    "lastImportAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "lastAlertAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "qtyOnHand" DOUBLE PRECISION NOT NULL,
    "qtyAllocated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "poNo" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL DEFAULT 1,
    "materialId" TEXT,
    "supplier" TEXT,
    "qtyOrdered" DOUBLE PRECISION NOT NULL,
    "qtyReceived" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundAddress_token_key" ON "InboundAddress"("token");

-- CreateIndex
CREATE UNIQUE INDEX "InboundAddress_orgId_kind_key" ON "InboundAddress"("orgId", "kind");

-- CreateIndex
CREATE INDEX "InboundMessage_orgId_receivedAt_idx" ON "InboundMessage"("orgId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_orgId_sha256_key" ON "InboundMessage"("orgId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ErpReport_orgId_headerKey_key" ON "ErpReport"("orgId", "headerKey");

-- CreateIndex
CREATE INDEX "StockLevel_orgId_idx" ON "StockLevel"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_orgId_materialId_location_key" ON "StockLevel"("orgId", "materialId", "location");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_orgId_dueDate_idx" ON "PurchaseOrderLine"("orgId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_orgId_poNo_lineNo_key" ON "PurchaseOrderLine"("orgId", "poNo", "lineNo");

-- AddForeignKey
ALTER TABLE "InboundAddress" ADD CONSTRAINT "InboundAddress_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErpReport" ADD CONSTRAINT "ErpReport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['InboundAddress', 'InboundMessage', 'ErpReport', 'StockLevel', 'PurchaseOrderLine'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
