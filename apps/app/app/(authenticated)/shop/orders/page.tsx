import { database, forOrg, type OrderStatus } from "@repo/database";
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
import { PencilIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { erpFeeds } from "@/lib/erp/feeds";
import { Header } from "../../components/header";
import { DeleteButton } from "../components/delete-button";
import { ErpFeedNote } from "../components/erp-feed-note";
import {
  EmptyState,
  ErpBadge,
  FilterNote,
  formValue,
  isoDate,
  money,
  textFilter,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";

export const metadata: Metadata = { title: "Orders · Takumo" };

const VIEWS: { key: string; label: string; statuses: OrderStatus[] }[] = [
  {
    key: "active",
    label: "Open & in progress",
    statuses: ["open", "in_progress"],
  },
  { key: "done", label: "Done", statuses: ["done"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

const OrdersPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  // Data the ERP sends is added there, not typed in here.
  const feeds = await erpFeeds(orgId);
  const erpFed = "orders" in feeds || "jobs" in feeds;
  const { view: viewKey, q: rawQ } = await searchParams;
  const view = VIEWS.find((v) => v.key === viewKey) ?? VIEWS[0];
  // A search (e.g. from an Ask Takumo citation) looks across every status.
  const q = textFilter(rawQ);
  const db = forOrg(database, orgId);
  const [orders, parts, customers] = await Promise.all([
    db.order.findMany({
      where: q
        ? {
            OR: [
              { orderNo: { contains: q, mode: "insensitive" } },
              { part: { partNo: { contains: q, mode: "insensitive" } } },
              { customer: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : { status: { in: view.statuses } },
      orderBy: [{ dueDate: "asc" }, { orderNo: "asc" }],
      include: {
        part: {
          select: {
            id: true,
            partNo: true,
            _count: { select: { routings: true } },
          },
        },
        customer: { select: { name: true } },
      },
    }),
    db.part.findMany({ orderBy: { partNo: "asc" }, select: { partNo: true } }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  const options = {
    partNo: [...new Set(parts.map((p) => p.partNo))],
    customer: customers.map((c) => c.name),
  };
  const today = new Date(new Date().toISOString().slice(0, 10));

  return (
    <>
      <Header page="Orders" pages={["Shop"]}>
        <div className="px-4">
          {erpFed ? (
            <ErpFeedNote at={feeds.orders ?? feeds.jobs} />
          ) : (
            <RecordDialog
              canEdit={canEditShop}
              entity="orders"
              initial={{ status: "open" }}
              options={options}
              title="Add an order"
              trigger={
                <Button size="sm">
                  <PlusIcon /> Add order
                </Button>
              }
            />
          )}
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {q && <FilterNote href="/shop/orders" q={q} />}
        <nav className="flex gap-2">
          {VIEWS.map((v) => (
            <Button
              asChild
              key={v.key}
              size="sm"
              variant={v.key === view.key ? "secondary" : "ghost"}
            >
              <Link href={`/shop/orders?view=${v.key}`}>{v.label}</Link>
            </Button>
          ))}
        </nav>
        {orders.length === 0 ? (
          <EmptyState>
            No orders here.{" "}
            <Link className="underline" href="/onboarding?type=orders">
              Upload your open orders
            </Link>{" "}
            from your ERP or tracker.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const late =
                    o.dueDate < today &&
                    (o.status === "open" || o.status === "in_progress");
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {o.orderNo}
                          <ErpBadge syncedAt={o.syncedAt} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link
                            className="hover:underline"
                            href={`/shop/parts/${o.part.id}`}
                          >
                            {o.part.partNo}
                          </Link>
                          {o.part._count.routings === 0 && (
                            <Badge variant="outline">No routing</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{o.customer?.name ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {o.qty.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {isoDate(o.dueDate)}
                          {late && <Badge variant="destructive">Late</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {money(o.price)}
                      </TableCell>
                      <TableCell>{o.status.replace("_", " ")}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <RecordDialog
                            canEdit={canEditShop && !o.syncedAt}
                            entity="orders"
                            initial={{
                              orderNo: o.orderNo,
                              partNo: o.part.partNo,
                              qty: String(o.qty),
                              dueDate: isoDate(o.dueDate),
                              customer: formValue(o.customer?.name),
                              price: formValue(o.price),
                              priority: String(o.priority),
                              status: o.status,
                            }}
                            locked={["orderNo"]}
                            options={options}
                            title={`Edit ${o.orderNo}`}
                            trigger={
                              <Button
                                aria-label={`Edit ${o.orderNo}`}
                                size="icon"
                                variant="ghost"
                              >
                                <PencilIcon />
                              </Button>
                            }
                          />
                          <DeleteButton
                            canEdit={canEditShop && !o.syncedAt}
                            entity="orders"
                            id={o.id}
                            name={o.orderNo}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
};

export default OrdersPage;
