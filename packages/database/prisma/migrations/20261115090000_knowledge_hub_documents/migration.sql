-- Company Knowledge Hub, phase 2: documents with versions, original files,
-- recoverable processing, where facts and answers came from, Trash and
-- permanent delete, and an audit log. Adds tables and columns only; existing
-- documents keep their ids, text and vectors and become version 1 of
-- themselves ("original not kept"). No behaviour changes for a shop until it
-- uploads, deletes or downloads.
--
-- Note: `prisma migrate diff` also proposes dropping doc_chunk_embedding_idx
-- (created by hand in tenant_rls, unknown to the schema). It is kept: that
-- line was removed from this migration on purpose.
-- AlterTable
ALTER TABLE "DocChunk" ADD COLUMN     "ordinal" INTEGER,
ADD COLUMN     "versionId" TEXT;

-- AlterTable
ALTER TABLE "Fact" ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'legacy';

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "currentVersionId" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "uploadedBy" TEXT,
ADD COLUMN     "versionSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "originalKept" BOOLEAN NOT NULL DEFAULT false,
    "mimeType" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "uploadedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "stage" TEXT NOT NULL DEFAULT 'read',
    "checkpoint" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT,
    "pageCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "orgId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "page" INTEGER,
    "text" TEXT NOT NULL,
    "recognized" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("versionId","position")
);

-- CreateTable
CREATE TABLE "FactSource" (
    "orgId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "versionId" TEXT,
    "quote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactSource_pkey" PRIMARY KEY ("factId","sourceId")
);

-- CreateTable
CREATE TABLE "MessageSource" (
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "versionId" TEXT,
    "direct" BOOLEAN NOT NULL,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageSource_pkey" PRIMARY KEY ("messageId","sourceId")
);

-- CreateTable
CREATE TABLE "DocumentAuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "sourceId" TEXT,
    "versionId" TEXT,
    "folderId" TEXT,
    "subjectName" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageDeletion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT,
    "keys" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_orgId_sourceId_idx" ON "DocumentVersion"("orgId", "sourceId");

-- CreateIndex
CREATE INDEX "DocumentVersion_orgId_sha256_idx" ON "DocumentVersion"("orgId", "sha256");

-- CreateIndex
CREATE INDEX "DocumentVersion_status_nextAttemptAt_idx" ON "DocumentVersion"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_sourceId_number_key" ON "DocumentVersion"("sourceId", "number");

-- CreateIndex
CREATE INDEX "DocumentPage_orgId_idx" ON "DocumentPage"("orgId");

-- CreateIndex
CREATE INDEX "FactSource_orgId_sourceId_idx" ON "FactSource"("orgId", "sourceId");

-- CreateIndex
CREATE INDEX "MessageSource_orgId_sourceId_idx" ON "MessageSource"("orgId", "sourceId");

-- CreateIndex
CREATE INDEX "MessageSource_orgId_conversationId_idx" ON "MessageSource"("orgId", "conversationId");

-- CreateIndex
CREATE INDEX "DocumentAuditLog_orgId_sourceId_createdAt_idx" ON "DocumentAuditLog"("orgId", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentAuditLog_orgId_createdAt_idx" ON "DocumentAuditLog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "StorageDeletion_nextAttemptAt_idx" ON "StorageDeletion"("nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocChunk_versionId_ordinal_key" ON "DocChunk"("versionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Source_currentVersionId_key" ON "Source"("currentVersionId");

-- CreateIndex
CREATE INDEX "Source_orgId_deletedAt_idx" ON "Source"("orgId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocChunk" ADD CONSTRAINT "DocChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_factId_fkey" FOREIGN KEY ("factId") REFERENCES "Fact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactSource" ADD CONSTRAINT "FactSource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageSource" ADD CONSTRAINT "MessageSource_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageSource" ADD CONSTRAINT "MessageSource_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAuditLog" ADD CONSTRAINT "DocumentAuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageDeletion" ADD CONSTRAINT "StorageDeletion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Values the app writes, checked by the database too.
-- ---------------------------------------------------------------------------
alter table "DocumentVersion"
  add constraint "DocumentVersion_number_check" check (number >= 1),
  add constraint "DocumentVersion_status_check"
    check (status in ('uploading', 'queued', 'processing', 'ready', 'failed', 'superseded')),
  add constraint "DocumentVersion_stage_check"
    check (stage in ('read', 'understand', 'chunk', 'embed', 'activate', 'facts', 'done')),
  -- A stored original always sits under its own shop's and document's prefix
  -- (a version read again from the same file shares that file's key).
  add constraint "DocumentVersion_storage_key_check"
    check ("storageKey" is null
      or (starts_with("storageKey", 'org/' || "orgId" || '/src/' || "sourceId" || '/')
          and position('..' in "storageKey") = 0));
alter table "Fact" add constraint "Fact_provenance_check"
  check (provenance in ('documents', 'none', 'unknown', 'source_deleted'));
alter table "Message" add constraint "Message_provenance_check"
  check (provenance in ('recorded', 'partial', 'legacy', 'removed'));
alter table "MessageSource" add constraint "MessageSource_via_check"
  check (via in ('document', 'fact', 'inherited'));

-- ---------------------------------------------------------------------------
-- Rows that point at each other belong to the same shop (and a version, its
-- passages and the document's current version to the same document).
-- ---------------------------------------------------------------------------
create or replace function library.document_rows_check() returns trigger
language plpgsql set search_path = public as $$
declare
  other_org text;
  other_source text;
begin
  if tg_table_name = 'DocumentVersion' then
    select "orgId" into other_org from "Source" where id = new."sourceId";
    if other_org is distinct from new."orgId" then
      raise exception 'A version must be in its document''s shop';
    end if;
  elsif tg_table_name = 'DocumentPage' then
    select "orgId" into other_org from "DocumentVersion" where id = new."versionId";
    if other_org is distinct from new."orgId" then
      raise exception 'A page must be in its version''s shop';
    end if;
  elsif tg_table_name = 'DocChunk' then
    if new."versionId" is not null then
      select "orgId", "sourceId" into other_org, other_source
      from "DocumentVersion" where id = new."versionId";
      if other_org is distinct from new."orgId" or other_source is distinct from new."sourceId" then
        raise exception 'A passage must belong to a version of its own document';
      end if;
    end if;
  elsif tg_table_name = 'Source' then
    if new."currentVersionId" is not null then
      select "orgId", "sourceId" into other_org, other_source
      from "DocumentVersion" where id = new."currentVersionId";
      if other_org is distinct from new."orgId" or other_source is distinct from new.id then
        raise exception 'A document''s current version must be one of its own';
      end if;
    end if;
  elsif tg_table_name = 'FactSource' then
    select "orgId" into other_org from "Fact" where id = new."factId";
    if other_org is distinct from new."orgId" then
      raise exception 'A fact''s source must be in the fact''s shop';
    end if;
    select "orgId" into other_org from "Source" where id = new."sourceId";
    if other_org is distinct from new."orgId" then
      raise exception 'A fact''s source must be a document of the same shop';
    end if;
  elsif tg_table_name = 'MessageSource' then
    select c."orgId" into other_org
    from "Message" m join "Conversation" c on c.id = m."conversationId"
    where m.id = new."messageId" and c.id = new."conversationId";
    if other_org is distinct from new."orgId" then
      raise exception 'A message''s source must be in the conversation''s shop';
    end if;
  end if;
  return new;
end $$;

create trigger document_version_rows
  before insert or update of "orgId", "sourceId" on "DocumentVersion"
  for each row execute function library.document_rows_check();
create trigger document_page_rows
  before insert or update of "orgId", "versionId" on "DocumentPage"
  for each row execute function library.document_rows_check();
create trigger doc_chunk_rows
  before insert or update of "orgId", "sourceId", "versionId" on "DocChunk"
  for each row execute function library.document_rows_check();
create trigger source_current_version
  before insert or update of "orgId", "currentVersionId" on "Source"
  for each row execute function library.document_rows_check();
create trigger fact_source_rows
  before insert or update on "FactSource"
  for each row execute function library.document_rows_check();
create trigger message_source_rows
  before insert or update on "MessageSource"
  for each row execute function library.document_rows_check();

revoke execute on all functions in schema library from public;

-- ---------------------------------------------------------------------------
-- Existing documents become version 1 of themselves.
-- ---------------------------------------------------------------------------

-- Two documents with the same name in the same place could only come from
-- uploads that raced before the replace lock: the later ones are renamed
-- "Name (2)", "Name (3)"… (their ids and text don't change), so names can be
-- unique from here on.
with ranked as (
  select id, name,
         row_number() over (
           partition by "orgId", coalesce("folderId", ''), name
           order by "createdAt", id
         ) as n
  from "Source"
  where type = 'upload' and profile = 'document'
)
update "Source" s
set name = left(r.name, 150) || ' (' || r.n || ')'
from ranked r
where r.id = s.id and r.n > 1;

-- No original file was kept for them, and who uploaded them was never
-- recorded: both stay unknown rather than guessed.
insert into "DocumentVersion" (
  id, "orgId", "sourceId", number, name, "originalKept", status, stage,
  "createdAt", "updatedAt", "activatedAt"
)
select gen_random_uuid()::text, s."orgId", s.id, 1, s.name, false,
       case when s.status = 'failed' then 'failed' else 'ready' end, 'done',
       s."createdAt", s."createdAt", s."createdAt"
from "Source" s
where s.type = 'upload' and s.profile = 'document'
  and not exists (select 1 from "DocumentVersion" v where v."sourceId" = s.id);

update "Source" s
set "currentVersionId" = v.id, "versionSeq" = greatest(s."versionSeq", 1)
from "DocumentVersion" v
where v."sourceId" = s.id and v.number = 1 and s."currentVersionId" is null;

update "Source" set "updatedAt" = "createdAt";

-- Their passages (vectors untouched) belong to that version; the card first.
with ordered as (
  select c.id, s."currentVersionId" as version_id,
         row_number() over (
           partition by c."sourceId"
           order by (c.meta ->> 'kind' = 'card') desc nulls last, c.page nulls first, c.id
         ) - 1 as ordinal
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  where c."versionId" is null and s."currentVersionId" is not null
)
update "DocChunk" c
set "versionId" = o.version_id, ordinal = o.ordinal
from ordered o
where o.id = c.id;

-- One live document per name in each place (the Trash doesn't count).
create unique index "Source_document_name_key"
  on "Source" ("orgId", coalesce("folderId", ''), name)
  where type = 'upload' and profile = 'document' and "deletedAt" is null;

-- ---------------------------------------------------------------------------
-- Tenant data: same row-level security backstop as the other tables.
-- ---------------------------------------------------------------------------
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array[
    'DocumentVersion', 'DocumentPage', 'FactSource', 'MessageSource',
    'DocumentAuditLog', 'StorageDeletion'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
