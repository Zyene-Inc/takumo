import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { ENTITIES, ENTITY_KEYS, type EntityKey } from "@repo/ingest";
import { CheckCircle2Icon, CircleIcon, DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import { getAccess, NO_ACCESS_MESSAGE, permissionFor } from "@/lib/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "../components/header";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Set up your shop · Takumo" };

// The order that avoids dangling references: machines before routings,
// parts before orders.
const STEPS: { entity: EntityKey; why: string }[] = [
  { entity: "workCenters", why: "What capacity you have" },
  { entity: "parts", why: "What you make" },
  { entity: "routings", why: "How each part is made, and how long it takes" },
  { entity: "orders", why: "What's due and when" },
  { entity: "quotes", why: "What you charged before, won and lost" },
];

const isEntity = (value: string | undefined): value is EntityKey =>
  ENTITY_KEYS.includes(value as EntityKey);

const OnboardingPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) => {
  const { orgId, canEditShop, canEditQuotes } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { type } = await searchParams;
  const allowed = ENTITY_KEYS.filter((entity) =>
    permissionFor(entity) === "quotes:write" ? canEditQuotes : canEditShop
  );
  const db = forOrg(database, orgId);

  const [workCenters, parts, routings, orders, quotes, sources] =
    await Promise.all([
      db.workCenter.count(),
      db.part.count(),
      db.routing.count(),
      db.order.count(),
      db.quote.count(),
      db.source.findMany({
        where: { type: "upload" },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);
  const counts: Partial<Record<EntityKey, number>> = {
    workCenters,
    parts,
    routings,
    orders,
    quotes,
  };

  return (
    <>
      <Header page="Set up your shop" pages={["Takumo"]} />
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0 lg:flex-row">
        <section className="flex-1 rounded-xl border p-6">
          <h1 className="font-semibold text-xl">Upload your shop data</h1>
          <p className="mt-1 mb-6 max-w-2xl text-muted-foreground text-sm">
            Upload the spreadsheets you already have. Takumo matches the
            columns, shows you what it found, and only saves after you confirm.
            Uploading a file again updates rows instead of duplicating them.
          </p>
          {allowed.length === 0 ? (
            <p className="rounded-xl bg-muted/50 p-6 text-muted-foreground text-sm">
              Your role can view this shop's data but not upload it.{" "}
              {NO_ACCESS_MESSAGE["shop:write"]}
            </p>
          ) : (
            <ImportWizard
              allowedEntities={allowed}
              initialEntity={
                isEntity(type) && allowed.includes(type)
                  ? type
                  : allowed.length === 1
                    ? allowed[0]
                    : undefined
              }
              key={type ?? "any"}
            />
          )}
        </section>

        <aside className="flex w-full flex-col gap-6 lg:w-80">
          <div className="rounded-xl bg-muted/50 p-5">
            <h2 className="mb-3 font-medium">Checklist</h2>
            <ol className="flex flex-col gap-3">
              {STEPS.map(({ entity, why }) => {
                const count = counts[entity] ?? 0;
                return (
                  <li className="flex gap-3" key={entity}>
                    {count > 0 ? (
                      <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-green-600" />
                    ) : (
                      <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex-1 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          className="font-medium hover:underline"
                          href={`/onboarding?type=${entity}`}
                        >
                          {ENTITIES[entity].label}
                        </Link>
                        {count > 0 && (
                          <Badge variant="secondary">{count}</Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground">{why}</div>
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-muted-foreground text-xs hover:underline"
                        download
                        href={`/onboarding/template/${entity}`}
                      >
                        <DownloadIcon className="size-3" /> Template
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {sources.length > 0 && (
            <div className="rounded-xl bg-muted/50 p-5">
              <h2 className="mb-3 font-medium">Recent uploads</h2>
              <ul className="flex flex-col gap-3 text-sm">
                {sources.map((source) => (
                  <li key={source.id}>
                    <div className="truncate font-medium">{source.name}</div>
                    <div className="text-muted-foreground text-xs">
                      {source.status === "failed" ? "Failed" : source.summary} ·{" "}
                      {source.createdAt.toLocaleDateString()}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </>
  );
};

export default OnboardingPage;
