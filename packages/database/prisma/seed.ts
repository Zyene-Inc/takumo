// Loads the demo shop in seed/acme-precision into one org.
// Usage: SEED_ORG_ID=org_xxx pnpm db:seed   (your WorkOS organization ID, org_…)
// After changing the seed files, run `pnpm --filter @repo/database generate-demo`.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { seedDemoShop } from "../demo/seed";
import { PrismaClient } from "../generated/client";

const orgId = process.env.SEED_ORG_ID;
if (!orgId) {
  throw new Error("Set SEED_ORG_ID to your WorkOS organization ID");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

const main = async () => {
  await prisma.org.upsert({
    where: { id: orgId },
    create: { id: orgId, name: "Acme Precision" },
    update: {},
  });
  await seedDemoShop(prisma, orgId);
  console.log(`Seeded Acme Precision into org ${orgId}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
