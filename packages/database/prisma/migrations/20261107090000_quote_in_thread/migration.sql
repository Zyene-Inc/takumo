-- AlterTable
ALTER TABLE "WorkCenter" ADD COLUMN     "envelope" JSONB,
ADD COLUMN     "toleranceIn" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "marginFloor" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Rfq" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "draftedAt" TIMESTAMP(3),
ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "reply" JSONB,
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RfqLine" ADD COLUMN     "drawing" JSONB,
ADD COLUMN     "fileId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "orderedAt" DATE,
ADD COLUMN     "unitPrice" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "RfqFile" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "pages" INTEGER,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadPart" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "fileIndex" INTEGER NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "orgId" TEXT NOT NULL,
    "quoteValidityDays" INTEGER,
    "materialMarkup" DOUBLE PRECISION,
    "laborRate" DOUBLE PRECISION,
    "toleranceIn" DOUBLE PRECISION,
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outsideProcesses" JSONB,
    "signature" TEXT,
    "replyIntro" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE INDEX "RfqFile_orgId_rfqId_idx" ON "RfqFile"("orgId", "rfqId");

-- CreateIndex
CREATE INDEX "RfqFile_orgId_sha256_idx" ON "RfqFile"("orgId", "sha256");

-- CreateIndex
CREATE INDEX "UploadPart_createdAt_idx" ON "UploadPart"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadPart_orgId_uploadId_fileIndex_partIndex_key" ON "UploadPart"("orgId", "uploadId", "fileIndex", "partIndex");

-- AddForeignKey
ALTER TABLE "RfqFile" ADD CONSTRAINT "RfqFile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqFile" ADD CONSTRAINT "RfqFile_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['RfqFile', 'ShopSettings', 'UploadPart'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
