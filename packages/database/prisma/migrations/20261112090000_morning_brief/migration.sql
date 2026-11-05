-- CreateTable
CREATE TABLE "NotifyPrefs" (
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "briefOn" BOOLEAN NOT NULL DEFAULT true,
    "briefTime" TEXT NOT NULL DEFAULT '06:30',
    "timeZone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "briefOff" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alertsOff" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastBriefOn" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotifyPrefs_pkey" PRIMARY KEY ("orgId","userId")
);

-- CreateTable
CREATE TABLE "EmailLinkUse" (
    "nonce" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLinkUse_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "BriefClick" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BriefClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertWatch" (
    "orgId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertWatch_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "quiet" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSent" (
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertSent_pkey" PRIMARY KEY ("orgId","userId","type")
);

-- CreateIndex
CREATE INDEX "EmailLinkUse_orgId_idx" ON "EmailLinkUse"("orgId");

-- CreateIndex
CREATE INDEX "BriefClick_orgId_clickedAt_idx" ON "BriefClick"("orgId", "clickedAt");

-- CreateIndex
CREATE INDEX "AlertEvent_orgId_createdAt_idx" ON "AlertEvent"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvent_orgId_type_key_key" ON "AlertEvent"("orgId", "type", "key");

-- AddForeignKey
ALTER TABLE "NotifyPrefs" ADD CONSTRAINT "NotifyPrefs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLinkUse" ADD CONSTRAINT "EmailLinkUse_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefClick" ADD CONSTRAINT "BriefClick_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertWatch" ADD CONSTRAINT "AlertWatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertSent" ADD CONSTRAINT "AlertSent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['NotifyPrefs', 'EmailLinkUse', 'BriefClick', 'AlertWatch', 'AlertEvent', 'AlertSent'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
