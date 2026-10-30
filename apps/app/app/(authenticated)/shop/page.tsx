import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import { UploadIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "../components/header";

export const metadata: Metadata = { title: "Shop · Takumo" };

const ShopPage = async () => {
  const { orgId } = await auth();
  if (!orgId) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const today = new Date(new Date().toISOString().slice(0, 10));

  const [
    machines,
    assumedMachines,
    parts,
    partsWithoutRouting,
    openOrders,
    lateOrders,
    customers,
    materials,
    assumedMaterials,
  ] = await Promise.all([
    db.workCenter.count(),
    db.workCenter.findMany({
      where: { provenance: "assumed" },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    db.part.count(),
    db.part.findMany({
      where: { routings: { none: {} } },
      select: { id: true, partNo: true, rev: true },
      orderBy: { partNo: "asc" },
      take: 20,
    }),
    db.order.count({ where: { status: { in: ["open", "in_progress"] } } }),
    db.order.count({
      where: {
        status: { in: ["open", "in_progress"] },
        dueDate: { lt: today },
      },
    }),
    db.customer.count(),
    db.material.count(),
    db.material.findMany({
      where: { provenance: "assumed" },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const cards = [
    { label: "Machines", value: machines, href: "/shop/work-centers" },
    { label: "Parts", value: parts, href: "/shop/parts" },
    {
      label: "Open orders",
      value: openOrders,
      href: "/shop/orders",
      note: lateOrders > 0 ? `${lateOrders} late` : undefined,
    },
    {
      label: "Customers · materials",
      value: `${customers} · ${materials}`,
      href: "/onboarding",
    },
  ];

  const reviews = [
    assumedMachines.length > 0 && {
      title: `${assumedMachines.length} machine${assumedMachines.length === 1 ? "" : "s"} added from routings`,
      detail: `${assumedMachines.map((m) => m.name).join(", ")}: set their rate, efficiency and hours per day.`,
      href: "/shop/work-centers",
    },
    partsWithoutRouting.length > 0 && {
      title: `${partsWithoutRouting.length}${partsWithoutRouting.length === 20 ? "+" : ""} part${partsWithoutRouting.length === 1 ? "" : "s"} without a routing`,
      detail: `Takumo can't schedule or quote these yet: ${partsWithoutRouting
        .slice(0, 6)
        .map((p) => p.partNo)
        .join(", ")}${partsWithoutRouting.length > 6 ? "…" : ""}`,
      href: `/shop/parts/${partsWithoutRouting[0]?.id}`,
    },
    assumedMaterials.length > 0 && {
      title: `${assumedMaterials.length} material${assumedMaterials.length === 1 ? "" : "s"} without cost or spec`,
      detail: `${assumedMaterials
        .map((m) => m.name)
        .slice(0, 6)
        .join(", ")}: upload a materials list to fill these in.`,
      href: "/onboarding?type=materials",
    },
  ].filter((r): r is { title: string; detail: string; href: string } =>
    Boolean(r)
  );

  return (
    <>
      <Header page="Overview" pages={["Shop"]}>
        <div className="px-4">
          <Button asChild size="sm" variant="outline">
            <Link href="/onboarding">
              <UploadIcon /> Upload data
            </Link>
          </Button>
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        <div className="grid auto-rows-min gap-4 md:grid-cols-4">
          {cards.map((card) => (
            <Link
              className="rounded-xl bg-muted/50 p-6 hover:bg-muted"
              href={card.href}
              key={card.label}
            >
              <p className="text-muted-foreground text-sm">{card.label}</p>
              <p className="font-semibold text-3xl">{card.value}</p>
              {card.note && (
                <p className="mt-1 text-destructive text-sm">{card.note}</p>
              )}
            </Link>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Needs your review</h2>
          {reviews.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing to review. Every machine has settings and every part has a
              routing.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {reviews.map((review) => (
                <li key={review.title}>
                  <Link
                    className="block rounded-xl border p-4 hover:bg-muted/50"
                    href={review.href}
                  >
                    <p className="font-medium">{review.title}</p>
                    <p className="text-muted-foreground text-sm">
                      {review.detail}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
};

export default ShopPage;
