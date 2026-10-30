-- Phase 3: Ask Takumo.
--
-- 1. Chat history: messages keep their full parts (text, tool calls, artifacts).
-- 2. Keyword search over document chunks (vector search uses the HNSW index).
-- 3. The agent's query_data tool runs SQL as its own login, takumo_reader,
--    which can SELECT the views in schema "ask" and nothing else; it is
--    read-only with a statement timeout. Each view shows one shop's rows: the
--    shop id comes from a setting that must carry an HMAC signature made with
--    a secret only the app's role can read, so a query that rewrites the
--    setting gets no rows. (The password is set per environment, outside
--    migrations: see docs/DEPLOY.md.)

alter table "Conversation" add column if not exists "updatedAt" timestamp(3) not null default current_timestamp;
alter table "Message" add column if not exists "parts" jsonb;
create index if not exists "Message_conversationId_createdAt_idx" on "Message" ("conversationId", "createdAt");
create index if not exists "Conversation_orgId_userId_updatedAt_idx" on "Conversation" ("orgId", "userId", "updatedAt");

create index if not exists doc_chunk_search_idx
  on "DocChunk" using gin (to_tsvector('english', content));

create extension if not exists pgcrypto;

-- Signing secret and the check, both out of the reader's reach.
create schema if not exists ask_private;
revoke all on schema ask_private from public;

create table if not exists ask_private.secret (
  id boolean primary key default true check (id),
  value text not null
);
insert into ask_private.secret (value)
  select encode(gen_random_bytes(32), 'hex')
  where not exists (select 1 from ask_private.secret);
revoke all on ask_private.secret from public;

-- The shop this transaction may see, or null if the signature doesn't match.
create or replace function ask_private.org_id() returns text
  language plpgsql stable security definer
  set search_path = pg_catalog, public, extensions
as $$
declare
  org text := nullif(current_setting('takumo.org_id', true), '');
  sig text := nullif(current_setting('takumo.org_sig', true), '');
begin
  if org is null or sig is null then
    return null;
  end if;
  if encode(hmac(org, (select value from ask_private.secret), 'sha256'), 'hex') = sig then
    return org;
  end if;
  return null;
end $$;
revoke all on function ask_private.org_id() from public;

create schema if not exists ask;

create or replace view ask.work_centers as
  select name, type, "hourlyRate"::float8 as hourly_rate, efficiency,
         (shifts ->> 'hoursPerDay')::float8 as hours_per_day
  from "WorkCenter" where "orgId" = (select ask_private.org_id());

create or replace view ask.customers as
  select name, "paymentTermDays" as payment_term_days
  from "Customer" where "orgId" = (select ask_private.org_id());

create or replace view ask.materials as
  select name, spec, "unitCost"::float8 as unit_cost, unit, "leadTimeDays" as lead_time_days
  from "Material" where "orgId" = (select ask_private.org_id());

create or replace view ask.parts as
  select p."partNo" as part_no, p.rev, p.description, c.name as customer, m.name as material
  from "Part" p
  left join "Customer" c on c.id = p."customerId"
  left join "Material" m on m.id = p."materialId"
  where p."orgId" = (select ask_private.org_id());

create or replace view ask.routings as
  select p."partNo" as part_no, p.rev, r.seq, w.name as work_center,
         r."setupMin" as setup_min, r."runMinPerUnit" as run_min_per_unit,
         array(select a.name from "WorkCenter" a where a.id = any(r."altWorkCenterIds") order by a.name)
           as alt_work_centers
  from "Routing" r
  join "Part" p on p.id = r."partId"
  join "WorkCenter" w on w.id = r."workCenterId"
  where r."orgId" = (select ask_private.org_id());

create or replace view ask.orders as
  select o."orderNo" as order_no, p."partNo" as part_no, p.rev, c.name as customer,
         o.qty, o."dueDate" as due_date, o.price::float8 as price, o.priority,
         o.status::text as status, o."createdAt"::date as created_on
  from "Order" o
  join "Part" p on p.id = o."partId"
  left join "Customer" c on c.id = o."customerId"
  where o."orgId" = (select ask_private.org_id());

create or replace view ask.quotes as
  select q."quoteNo" as quote_no, c.name as customer, p."partNo" as part_no, q.qty,
         q.price::float8 as price, q."leadTimeDays" as lead_time_days,
         q."estCost"::float8 as est_cost, q."actualCost"::float8 as actual_cost,
         q.status::text as status, q."quotedAt"::date as quoted_on
  from "Quote" q
  left join "Part" p on p.id = q."partId"
  left join "Customer" c on c.id = q."customerId"
  where q."orgId" = (select ask_private.org_id());

create or replace view ask.jobs as
  select o."orderNo" as order_no, j."routingSeq" as seq, w.name as work_center,
         j."plannedStart" as planned_start, j."plannedEnd" as planned_end,
         j."actualStart" as actual_start, j."actualEnd" as actual_end,
         j."actualSetupMin" as actual_setup_min, j."actualRunMin" as actual_run_min,
         j."qtyGood" as qty_good, j."qtyScrap" as qty_scrap, j.pinned
  from "Job" j
  join "Order" o on o.id = j."orderId"
  left join "WorkCenter" w on w.id = j."workCenterId"
  where j."orgId" = (select ask_private.org_id());

create or replace view ask.calendar as
  select w.name as work_center, d.date, d."availableHours" as available_hours, d.reason
  from "CalendarDay" d
  join "WorkCenter" w on w.id = d."workCenterId"
  where d."orgId" = (select ask_private.org_id());

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    create role takumo_reader login noinherit;
  end if;
end $$;

alter role takumo_reader set default_transaction_read_only = on;
alter role takumo_reader set statement_timeout = '5s';
alter role takumo_reader set search_path = ask;
alter role takumo_reader connection limit 20;

grant usage on schema ask to takumo_reader;
grant select on all tables in schema ask to takumo_reader;
grant usage on schema ask_private to takumo_reader;
grant execute on function ask_private.org_id() to takumo_reader;
