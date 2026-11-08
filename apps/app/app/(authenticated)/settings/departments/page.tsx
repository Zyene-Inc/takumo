import { can } from "@repo/auth/permissions";
import { listShopMembers } from "@repo/auth/server";
import { database } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  listDepartments,
  pruneDepartedMembers,
} from "@/lib/library/departments";
import {
  confidentialEnabled,
  restrictedAccessReady,
} from "@/lib/library/stage";
import { resolveViewer } from "@/lib/library/viewer";
import { Header } from "../../components/header";
import { Departments } from "./departments";
import { TurnOnRestricted } from "./turn-on";

export const metadata: Metadata = { title: "Departments · Takumo" };

// Departments decide who can open restricted and confidential folders.
// Owners and admins see this page; what each may change is decided on the
// server (lib/library/departments.ts).
const DepartmentsPage = async () => {
  const viewer = await resolveViewer();
  if (!(viewer && can(viewer.role, "departments:manage"))) {
    notFound();
  }
  const { orgId } = viewer;
  const [enabled, org] = await Promise.all([
    confidentialEnabled(orgId),
    database.org.findUnique({
      where: { id: orgId },
      select: { libraryStage: true },
    }),
  ]);
  const canTurnOn =
    restrictedAccessReady() &&
    viewer.isOwner &&
    org?.libraryStage === "library";

  if (!enabled) {
    return (
      <>
        <Header page="Departments" pages={["Settings"]} />
        <div className="flex max-w-2xl flex-1 flex-col gap-3 p-4 pt-0">
          <p className="text-sm">
            Departments (Engineering, Human Resources, Finance…) decide who can
            open restricted and confidential folders in Company Knowledge.
          </p>
          <p className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm">
            Restricting access isn't available yet. Until it is, everyone in the
            shop can open everything in the library, and departments can't be
            set up.
          </p>
          {canTurnOn && <TurnOnRestricted />}
        </div>
      </>
    );
  }

  // Tidy up people who have left the shop before showing who's in what.
  await pruneDepartedMembers(orgId).catch(() => null);
  const [departments, members] = await Promise.all([
    listDepartments(viewer),
    listShopMembers(orgId).catch(() => []),
  ]);
  const people = members
    .map((m) => ({ userId: m.userId, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <Header page="Departments" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          A department opens the folders it's been given access to. People can
          be in several. Changes apply straight away. Departments that open a
          confidential folder can only be changed by someone who manages that
          folder.
        </p>
        <Departments departments={departments} people={people} />
      </div>
    </>
  );
};

export default DepartmentsPage;
