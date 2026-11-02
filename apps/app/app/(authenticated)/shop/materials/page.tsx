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
  ProvenanceBadge,
  textFilter,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";

export const metadata: Metadata = { title: "Materials · Takumo" };

const unitCost = (cost: { toString(): string } | null, unit: string) =>
  cost === null
    ? "—"
    : `${Number(cost.toString()).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })} / ${unit}`;

const MaterialsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const q = textFilter((await searchParams).q);
  const materials = await forOrg(database, orgId).material.findMany({
    where: q ? { name: { contains: q, mode: "insensitive" } } : {},
    orderBy: { name: "asc" },
    include: { _count: { select: { parts: true } } },
  });

  return (
    <>
      <Header page="Materials" pages={["Shop"]}>
        <div className="px-4">
          <RecordDialog
            canEdit={canEditShop}
            entity="materials"
            title="Add a material"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add material
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {q && <FilterNote href="/shop/materials" q={q} />}
        {materials.length === 0 ? (
          <EmptyState>
            No materials yet.{" "}
            <Link className="underline" href="/onboarding?type=materials">
              Upload a materials list
            </Link>{" "}
            or add them one by one.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Spec</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Lead time</TableHead>
                  <TableHead className="text-right">Parts</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {materials.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {m.name}
                        <ProvenanceBadge provenance={m.provenance} />
                        <ErpBadge syncedAt={m.syncedAt} />
                      </div>
                    </TableCell>
                    <TableCell>{m.spec ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {unitCost(m.unitCost, m.unit)}
                    </TableCell>
                    <TableCell className="text-right">
                      {m.leadTimeDays === null ? "—" : `${m.leadTimeDays} days`}
                    </TableCell>
                    <TableCell className="text-right">
                      {m._count.parts}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <RecordDialog
                          canEdit={canEditShop && !m.syncedAt}
                          entity="materials"
                          initial={{
                            name: m.name,
                            spec: formValue(m.spec),
                            unitCost: formValue(m.unitCost),
                            unit: m.unit,
                            leadTimeDays: formValue(m.leadTimeDays),
                          }}
                          locked={["name"]}
                          title={`Edit ${m.name}`}
                          trigger={
                            <Button
                              aria-label={`Edit ${m.name}`}
                              size="icon"
                              variant="ghost"
                            >
                              <PencilIcon />
                            </Button>
                          }
                        />
                        <DeleteButton
                          canEdit={canEditShop && !m.syncedAt}
                          entity="materials"
                          id={m.id}
                          name={m.name}
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

export default MaterialsPage;
