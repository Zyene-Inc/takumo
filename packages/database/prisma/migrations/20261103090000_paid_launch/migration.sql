-- Paid launch (Phase 6): billing state on the shop (Stripe), and connections
-- to outside systems (QuickBooks, Gmail) with encrypted tokens.

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "account" TEXT NOT NULL,
    "accountLabel" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "settings" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connection_orgId_provider_key" ON "Connection"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Org_stripeSubscriptionId_key" ON "Org"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Shops already on the free trial get 30 days from when they were created.
UPDATE "Org" SET "trialEndsAt" = "createdAt" + interval '30 days'
WHERE plan = 'trial' AND "trialEndsAt" IS NULL;

-- Connector tokens: row-level security on with no policy, so nothing that
-- connects as Supabase's API roles can read them. The app's own connection
-- (the table owner) is unaffected.
alter table "Connection" enable row level security;
