-- Security hotfix: Ask Takumo's SQL (query_data) could read other shops' rows
-- through error messages.
--
-- The ask.* views filtered only their main table by shop. The tables they
-- join (Part, Customer, Material, WorkCenter, Order) were not filtered, and
-- the views were plain views, so Postgres could run a condition from the
-- reader's query on every shop's rows of a joined table before the join
-- dropped them. A condition that fails on a value (a cast, a regclass lookup,
-- a division by zero) then put that value, or a yes/no about it, in the
-- error. Example: select part_no from routings where work_center::int > 0.
--
-- Now:
-- 1. Every view is a security barrier: the reader's conditions only ever see
--    rows the view has already produced for the signed shop.
-- 2. Every joined table is filtered by the same shop, so a row that points at
--    another shop's row (nothing in the schema forbids one) shows nothing of it.
-- 3. The reader's sessions don't publish their query text in pg_stat_activity,
--    where other shops' sessions (same login) could read it.
--
-- Same columns, same names and order: safe with the app before and after the
-- hotfix. CREATE OR REPLACE keeps the reader's grants; they're repeated below.
-- Any later migration that redefines an ask view must keep
-- "with (security_barrier = true)" (CREATE OR REPLACE VIEW without it drops
-- the option); packages/database/__tests__/reader-isolation.db.test.ts and
-- the app's switch (reader.ts) check it.

create or replace view ask.work_centers with (security_barrier = true) as
  select name, type, "hourlyRate"::float8 as hourly_rate, efficiency,
         (shifts ->> 'hoursPerDay')::float8 as hours_per_day
  from "WorkCenter" where "orgId" = (select ask_private.org_id());

create or replace view ask.customers with (security_barrier = true) as
  select name, "paymentTermDays" as payment_term_days
  from "Customer" where "orgId" = (select ask_private.org_id());

create or replace view ask.materials with (security_barrier = true) as
  select name, spec, "unitCost"::float8 as unit_cost, unit, "leadTimeDays" as lead_time_days
  from "Material" where "orgId" = (select ask_private.org_id());

create or replace view ask.parts with (security_barrier = true) as
  select p."partNo" as part_no, p.rev, p.description, c.name as customer, m.name as material
  from "Part" p
  left join "Customer" c on c.id = p."customerId" and c."orgId" = p."orgId"
  left join "Material" m on m.id = p."materialId" and m."orgId" = p."orgId"
  where p."orgId" = (select ask_private.org_id());

create or replace view ask.routings with (security_barrier = true) as
  select p."partNo" as part_no, p.rev, r.seq, w.name as work_center,
         r."setupMin" as setup_min, r."runMinPerUnit" as run_min_per_unit,
         array(select a.name from "WorkCenter" a
               where a.id = any(r."altWorkCenterIds") and a."orgId" = r."orgId"
               order by a.name)
           as alt_work_centers
  from "Routing" r
  join "Part" p on p.id = r."partId" and p."orgId" = r."orgId"
  join "WorkCenter" w on w.id = r."workCenterId" and w."orgId" = r."orgId"
  where r."orgId" = (select ask_private.org_id());

create or replace view ask.orders with (security_barrier = true) as
  select o."orderNo" as order_no, p."partNo" as part_no, p.rev, c.name as customer,
         o.qty, o."dueDate" as due_date, o.price::float8 as price, o.priority,
         o.status::text as status, o."createdAt"::date as created_on
  from "Order" o
  join "Part" p on p.id = o."partId" and p."orgId" = o."orgId"
  left join "Customer" c on c.id = o."customerId" and c."orgId" = o."orgId"
  where o."orgId" = (select ask_private.org_id());

create or replace view ask.quotes with (security_barrier = true) as
  select q."quoteNo" as quote_no, c.name as customer, p."partNo" as part_no, q.qty,
         q.price::float8 as price, q."leadTimeDays" as lead_time_days,
         q."estCost"::float8 as est_cost, q."actualCost"::float8 as actual_cost,
         q.status::text as status, q."quotedAt"::date as quoted_on
  from "Quote" q
  left join "Part" p on p.id = q."partId" and p."orgId" = q."orgId"
  left join "Customer" c on c.id = q."customerId" and c."orgId" = q."orgId"
  where q."orgId" = (select ask_private.org_id());

create or replace view ask.jobs with (security_barrier = true) as
  select o."orderNo" as order_no, j."routingSeq" as seq, w.name as work_center,
         j."plannedStart" as planned_start, j."plannedEnd" as planned_end,
         j."actualStart" as actual_start, j."actualEnd" as actual_end,
         j."actualSetupMin" as actual_setup_min, j."actualRunMin" as actual_run_min,
         j."qtyGood" as qty_good, j."qtyScrap" as qty_scrap, j.pinned,
         j."plannedSetupMin" as planned_setup_min,
         j."plannedRunMinPerUnit" as planned_run_min_per_unit
  from "Job" j
  join "Order" o on o.id = j."orderId" and o."orgId" = j."orgId"
  left join "WorkCenter" w on w.id = j."workCenterId" and w."orgId" = j."orgId"
  where j."orgId" = (select ask_private.org_id());

create or replace view ask.calendar with (security_barrier = true) as
  select w.name as work_center, d.date, d."availableHours" as available_hours, d.reason
  from "CalendarDay" d
  join "WorkCenter" w on w.id = d."workCenterId" and w."orgId" = d."orgId"
  where d."orgId" = (select ask_private.org_id());

create or replace view ask.facts with (security_barrier = true) as
  select 'F-' || f.number as fact_no, f."subjectType" as subject_type,
         f."subjectLabel" as subject, f.attribute,
         f.value #>> '{}' as value, f."previousValue" #>> '{}' as previous_value,
         f.status::text as status, f.source, f.evidence,
         f."createdAt"::date as stated_on, f."reviewedAt"::date as reviewed_on,
         f."validTo"::date as valid_to
  from "Fact" f
  where f."orgId" = (select ask_private.org_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    grant usage on schema ask to takumo_reader;
    grant select on all tables in schema ask to takumo_reader;
  end if;
end $$;

-- Every shop's queries run as the one takumo_reader login, and a session can
-- read the query text of its own login's other sessions in pg_stat_activity.
-- track_activities can only be changed by a superuser (or a role granted SET
-- on it); where the migration's role can't, it says so and carries on, and
-- the setting must be applied by hand (docs/DEPLOY.md, step 1.3).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    alter role takumo_reader set track_activities = off;
  end if;
exception when insufficient_privilege then
  raise warning 'takumo_reader: could not turn off track_activities; apply it by hand (docs/DEPLOY.md, step 1.3)';
end $$;
