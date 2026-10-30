import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "./components/header";

const title = "Takumo";
const description = "Your shop's operations brain.";

export const metadata: Metadata = {
  title,
  description,
};

const App = async () => {
  const { orgId } = await auth();

  if (!orgId) {
    notFound();
  }

  const db = forOrg(database, orgId);

  const [workCenters, parts, openOrders, openQuotes] = await Promise.all([
    db.workCenter.count(),
    db.part.count(),
    db.order.count({ where: { status: "open" } }),
    db.quote.count({ where: { status: "open" } }),
  ]);

  const stats = [
    { label: "Work centers", value: workCenters },
    { label: "Parts", value: parts },
    { label: "Open orders", value: openOrders },
    { label: "Open quotes", value: openQuotes },
  ];

  return (
    <>
      <Header page="Overview" pages={["Shop"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="grid auto-rows-min gap-4 md:grid-cols-4">
          {stats.map((stat) => (
            <div className="rounded-xl bg-muted/50 p-6" key={stat.label}>
              <p className="text-muted-foreground text-sm">{stat.label}</p>
              <p className="font-semibold text-3xl">{stat.value}</p>
            </div>
          ))}
        </div>
        <div className="flex min-h-[50vh] flex-1 items-center justify-center rounded-xl bg-muted/50 p-6 text-muted-foreground md:min-h-min">
          Ask Takumo: "Can we take 500 × P-1001 by next Friday?"
        </div>
      </div>
    </>
  );
};

export default App;
