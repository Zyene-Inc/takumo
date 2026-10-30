import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import { getAccess } from "@/lib/access";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "../../components/header";
import { EmptyState } from "../components/format";
import { RecordDialog } from "../components/record-dialog";

export const metadata: Metadata = { title: "Parts & routings · Takumo" };

const PartsPage = async () => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const [parts, customers, materials] = await Promise.all([
    db.part.findMany({
      orderBy: [{ partNo: "asc" }, { rev: "asc" }],
      include: {
        customer: { select: { name: true } },
        material: { select: { name: true } },
        _count: { select: { routings: true, orders: true } },
      },
    }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    db.material.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);

  return (
    <>
      <Header page="Parts & routings" pages={["Shop"]}>
        <div className="px-4">
          <RecordDialog
            canEdit={canEditShop}
            entity="parts"
            options={{
              customer: customers.map((c) => c.name),
              material: materials.map((m) => m.name),
            }}
            title="Add a part"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add part
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {parts.length === 0 ? (
          <EmptyState>
            No parts yet.{" "}
            <Link className="underline" href="/onboarding?type=parts">
              Upload a parts list
            </Link>
            , or upload routings and Takumo will create the parts.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Part number</TableHead>
                  <TableHead>Rev</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead className="text-right">Operations</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <Link
                        className="hover:underline"
                        href={`/shop/parts/${p.id}`}
                      >
                        {p.partNo}
                      </Link>
                    </TableCell>
                    <TableCell>{p.rev}</TableCell>
                    <TableCell className="max-w-64 truncate">
                      {p.description ?? "—"}
                    </TableCell>
                    <TableCell>{p.customer?.name ?? "—"}</TableCell>
                    <TableCell>{p.material?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {p._count.routings === 0 ? (
                        <Badge variant="outline">No routing</Badge>
                      ) : (
                        p._count.routings
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {p._count.orders}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
};

export default PartsPage;
