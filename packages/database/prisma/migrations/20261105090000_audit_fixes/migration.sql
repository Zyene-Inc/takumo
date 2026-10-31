-- When a subscription went past due: the payment grace runs from here, not
-- from the period end (Stripe has already moved that to the unpaid period).
ALTER TABLE "Org" ADD COLUMN "pastDueSince" TIMESTAMP(3);

-- Shops (plan and billing state) and Ask Takumo's messages: row-level
-- security on with no policy, so nothing that connects as Supabase's API
-- roles can read or change them. The app's own connection (the table owner)
-- is unaffected.
alter table "Org" enable row level security;
alter table "Message" enable row level security;
