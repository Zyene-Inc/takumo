// Creates Takumo's products and monthly prices in Stripe, found again by
// their lookup keys, so the app never needs price IDs. Safe to run twice.
//
//   STRIPE_SECRET_KEY=sk_test_… pnpm --filter @repo/payments setup-stripe
//
// Run it once with the test key and once with the live key.
import Stripe from "stripe";
import { PLANS, SELF_SERVE } from "../plans";

const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith("sk_")) {
  throw new Error("Set STRIPE_SECRET_KEY (sk_test_… or sk_live_…).");
}
const stripe = new Stripe(key);

const main = async () => {
  for (const planKey of SELF_SERVE) {
    const plan = PLANS[planKey];
    if (!(plan.lookupKey && plan.price)) {
      continue;
    }
    const existing = await stripe.prices.list({
      lookup_keys: [plan.lookupKey],
      limit: 1,
    });
    if (existing.data[0]) {
      console.log(
        `${plan.name}: price ${existing.data[0].id} already exists (${plan.lookupKey}).`
      );
      continue;
    }
    const product = await stripe.products.create({
      name: `Takumo ${plan.name}`,
      description: plan.summary,
      metadata: { plan: plan.key },
    });
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: plan.price * 100,
      recurring: { interval: "month" },
      lookup_key: plan.lookupKey,
      metadata: { plan: plan.key },
    });
    console.log(
      `${plan.name}: created ${product.id} with price ${price.id} (${plan.lookupKey}).`
    );
  }
  console.log(
    "Next: Stripe → Settings → Billing → Customer portal: allow switching between these two prices and cancelling."
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
