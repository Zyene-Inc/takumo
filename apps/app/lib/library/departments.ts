import "server-only";

import { can } from "@repo/auth/permissions";
import { shopRole } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { accessTo } from "./access";
import { has } from "./capabilities";
import { confidentialEnabled, NOT_YET } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Departments (Engineering, HR, Finance…) are kept in Takumo's database,
// keyed by WorkOS user ID: WorkOS gives each member one role, and a person
// may be in several departments.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const MAX_NAME = 80;
const NOT_THERE = "That department isn't there any more.";

/** The viewer may manage departments at all, or why not. */
const allowed = async (viewer: Viewer): Promise<string | null> => {
  const { isSystem, role } = trustedViewer(viewer);
  if (isSystem || !can(role, "departments:manage")) {
    return "Only the shop's owner or an admin can change departments.";
  }
  if (!(await confidentialEnabled(viewer.orgId))) {
    return NOT_YET;
  }
  return null;
};

/**
 * Changing who is in a department changes who can open everything it has
 * been given. Inside confidential folders admins have no automatic access,
 * so they may only change a department there if they manage those folders
 * themselves: otherwise an admin could add themselves to HR.
 */
const reachProblem = async (viewer: Viewer, departmentId: string) => {
  const grants = await forOrg(database, viewer.orgId).accessGrant.findMany({
    where: { principalType: "department", principalId: departmentId },
    select: { folderId: true, sourceId: true },
  });
  for (const grant of grants) {
    const access = await accessTo(
      viewer,
      grant.folderId
        ? { folderId: grant.folderId }
        : { sourceId: grant.sourceId ?? "" }
    );
    if (access?.confidential && !has(access.capabilities, "manage")) {
      return "This department can open confidential documents, so only someone who manages them can change it.";
    }
  }
  return null;
};

const findDepartment = (viewer: Viewer, departmentId: string) =>
  forOrg(database, viewer.orgId).department.findFirst({
    where: { id: departmentId },
    select: { id: true },
  });

export const createDepartment = async (
  viewer: Viewer,
  name: string
): Promise<Result<{ id: string }>> => {
  const problem = await allowed(viewer);
  if (problem) {
    return { ok: false, error: problem };
  }
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > MAX_NAME) {
    return {
      ok: false,
      error: "Give the department a name (up to 80 characters).",
    };
  }
  const db = forOrg(database, viewer.orgId);
  if (await db.department.findFirst({ where: { name: clean } })) {
    return {
      ok: false,
      error: `There's already a department called ${clean}.`,
    };
  }
  const department = await db.department.create({
    data: { orgId: viewer.orgId, name: clean, createdBy: viewer.userId },
    select: { id: true },
  });
  return { ok: true, id: department.id };
};

/** Delete a department; its grants go with it (a database trigger). */
export const deleteDepartment = async (
  viewer: Viewer,
  departmentId: string
): Promise<Result> => {
  const problem =
    (await allowed(viewer)) ??
    ((await findDepartment(viewer, departmentId)) ? null : NOT_THERE) ??
    (await reachProblem(viewer, departmentId));
  if (problem) {
    return { ok: false, error: problem };
  }
  await forOrg(database, viewer.orgId).department.deleteMany({
    where: { id: departmentId },
  });
  return { ok: true };
};

/** Add an active member of the shop to a department. */
export const addDepartmentMember = async (
  viewer: Viewer,
  departmentId: string,
  userId: string
): Promise<Result> => {
  const problem =
    (await allowed(viewer)) ??
    ((await findDepartment(viewer, departmentId)) ? null : NOT_THERE) ??
    ((await shopRole(userId, viewer.orgId))
      ? null
      : "They need to be in the shop before joining a department.") ??
    (await reachProblem(viewer, departmentId));
  if (problem) {
    return { ok: false, error: problem };
  }
  await forOrg(database, viewer.orgId).departmentMember.createMany({
    data: [
      { orgId: viewer.orgId, departmentId, userId, addedBy: viewer.userId },
    ],
    skipDuplicates: true,
  });
  return { ok: true };
};

export const removeDepartmentMember = async (
  viewer: Viewer,
  departmentId: string,
  userId: string
): Promise<Result> => {
  const problem =
    (await allowed(viewer)) ??
    ((await findDepartment(viewer, departmentId)) ? null : NOT_THERE) ??
    (await reachProblem(viewer, departmentId));
  if (problem) {
    return { ok: false, error: problem };
  }
  await forOrg(database, viewer.orgId).departmentMember.deleteMany({
    where: { departmentId, userId },
  });
  return { ok: true };
};
