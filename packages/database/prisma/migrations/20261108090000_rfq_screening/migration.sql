-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "emails" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "blockedSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "knownSenders" TEXT[] DEFAULT ARRAY[]::TEXT[];

