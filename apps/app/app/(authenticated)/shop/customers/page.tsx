import { database, forOrg } from "@repo/database";
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
import { Header } from "../../components/header";
import { DeleteButton } from "../components/delete-button";
import {
  EmptyState,
  ErpBadge,
  FilterNote,
  formValue,
  textFilter,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";

export const metadata: Metadata = { title: "Customers · Takumo" };

const CustomersPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const q = textFilter((await searchParams).q);
  const customers = await forOrg(database, orgId).customer.findMany({
    where: q ? { name: { contains: q, mode: "insensitive" } } : {},
    orderBy: { name: "asc" },
    include: {
      _count: { select: { parts: true, orders: true, quotes: true } },
    },
  });

  return (
    <>
      <Header page="Customers" pages={["Shop"]}>
        <div className="px-4">
          <RecordDialog
            canEdit={canEditShop}
            entity="customers"
            title="Add a customer"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add customer
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {q && <FilterNote href="/shop/customers" q={q} />}
        {customers.length === 0 ? (
          <EmptyState>
            No customers yet. They're added automatically when you{" "}
            <Link className="underline" href="/onboarding?type=orders">
              upload orders
            </Link>{" "}
            or quotes.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Payment terms</TableHead>
                  <TableHead className="text-right">Parts</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Quotes</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {c.name}
                        <ErpBadge syncedAt={c.syncedAt} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {c.paymentTermDays === null
                        ? "—"
                        : `Net ${c.paymentTermDays}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {c._count.parts}
                    </TableCell>
                    <TableCell className="text-right">
                      {c._count.orders}
                    </TableCell>
                    <TableCell className="text-right">
                      {c._count.quotes}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <RecordDialog
                          canEdit={canEditShop && !c.syncedAt}
                          entity="customers"
                          initial={{
                            name: c.name,
                            paymentTermDays: formValue(c.paymentTermDays),
                          }}
                          locked={["name"]}
                          title={`Edit ${c.name}`}
                          trigger={
                            <Button
                              aria-label={`Edit ${c.name}`}
                              size="icon"
                              variant="ghost"
                            >
                              <PencilIcon />
                            </Button>
                          }
                        />
                        <DeleteButton
                          canEdit={canEditShop && !c.syncedAt}
                          entity="customers"
                          id={c.id}
                          name={c.name}
                        />
                      </div>
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

export default CustomersPage;
