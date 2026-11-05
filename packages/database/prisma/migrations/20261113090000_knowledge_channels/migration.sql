-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "senderName" TEXT;

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "operatorId" TEXT,
    "codeHash" TEXT,
    "codeSentAt" TIMESTAMP(3),
    "codeExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phoneId" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "noteId" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhoneNumber_phone_idx" ON "PhoneNumber"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_orgId_phone_key" ON "PhoneNumber"("orgId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneMessage_sid_key" ON "PhoneMessage"("sid");

-- CreateIndex
CREATE INDEX "PhoneMessage_orgId_receivedAt_idx" ON "PhoneMessage"("orgId", "receivedAt");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneMessage" ADD CONSTRAINT "PhoneMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneMessage" ADD CONSTRAINT "PhoneMessage_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['PhoneNumber', 'PhoneMessage'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
