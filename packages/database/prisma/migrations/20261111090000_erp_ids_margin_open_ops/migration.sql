-- AlterTable
ALTER TABLE "WorkCenter" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "qtyDone" INTEGER;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "defaultMargin" DOUBLE PRECISION;

-- CreateIndex
CREATE UNIQUE INDEX "WorkCenter_orgId_externalId_key" ON "WorkCenter"("orgId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_externalId_key" ON "Customer"("orgId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_orgId_externalId_key" ON "Material"("orgId", "externalId");
