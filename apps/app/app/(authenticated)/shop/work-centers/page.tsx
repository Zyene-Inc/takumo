import { auth } from "@repo/auth/server";
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
import { Header } from "../../components/header";
import { DeleteButton } from "../components/delete-button";
import {
  EmptyState,
  formValue,
  money,
  ProvenanceBadge,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";

export const metadata: Metadata = { title: "Work centers · Takumo" };

const hoursPerDay = (shifts: unknown) =>
  shifts && typeof shifts === "object" && "hoursPerDay" in shifts
    ? Number((shifts as { hoursPerDay: unknown }).hoursPerDay)
    : null;

const WorkCentersPage = async () => {
  const { orgId } = await auth();
  if (!orgId) {
    notFound();
  }
  const machines = await forOrg(database, orgId).workCenter.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { routings: true } } },
  });

  return (
    <>
      <Header page="Work centers" pages={["Shop"]}>
        <div className="px-4">
          <RecordDialog
            entity="workCenters"
            title="Add a machine"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add machine
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {machines.length === 0 ? (
          <EmptyState>
            No machines yet.{" "}
            <Link className="underline" href="/onboarding?type=workCenters">
              Upload a machine list
            </Link>{" "}
            or add them one by one.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Rate / hour</TableHead>
                  <TableHead className="text-right">Efficiency</TableHead>
                  <TableHead className="text-right">Hours / day</TableHead>
                  <TableHead className="text-right">Operations</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map((m) => {
                  const hours = hoursPerDay(m.shifts);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {m.name}
                          <ProvenanceBadge provenance={m.provenance} />
                        </div>
                      </TableCell>
                      <TableCell>{m.type ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {money(m.hourlyRate)}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(m.efficiency * 100)}%
                      </TableCell>
                      <TableCell className="text-right">
                        {hours ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {m._count.routings}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <RecordDialog
                            entity="workCenters"
                            initial={{
                              name: m.name,
                              type: formValue(m.type),
                              hourlyRate: formValue(m.hourlyRate),
                              efficiency: formValue(m.efficiency),
                              hoursPerDay: formValue(hours),
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
                            entity="workCenters"
                            id={m.id}
                            name={m.name}
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

export default WorkCentersPage;
