import "server-only";

import { can } from "@repo/auth/permissions";
import { shopRole } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { accessTo, folderCapabilities, visibleSourceIds } from "./access";
import { serialized } from "./access-lock";
import { audit } from "./audit";
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

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

const record = (viewer: Viewer, detail: Record<string, string>) =>
  audit({
    orgId: viewer.orgId,
    actorId: viewer.userId,
    action: "department_change",
    detail,
  });

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
  const clean = cleanName(name);
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
  await record(viewer, { change: "create", department: department.id });
  return { ok: true, id: department.id };
};

/**
 * Rename a department. Its access doesn't change, but a misleading name on
 * one that opens confidential folders could fool whoever manages them, so
 * the same rule as changing its members applies.
 */
export const renameDepartment = async (
  viewer: Viewer,
  departmentId: string,
  name: string
): Promise<Result> => {
  const problem =
    (await allowed(viewer)) ??
    ((await findDepartment(viewer, departmentId)) ? null : NOT_THERE) ??
    (await reachProblem(viewer, departmentId));
  if (problem) {
    return { ok: false, error: problem };
  }
  const clean = cleanName(name);
  if (!clean || clean.length > MAX_NAME) {
    return {
      ok: false,
      error: "Give the department a name (up to 80 characters).",
    };
  }
  const db = forOrg(database, viewer.orgId);
  if (
    await db.department.findFirst({
      where: { name: clean, NOT: { id: departmentId } },
    })
  ) {
    return {
      ok: false,
      error: `There's already a department called ${clean}.`,
    };
  }
  await db.department.updateMany({
    where: { id: departmentId },
    data: { name: clean },
  });
  await record(viewer, { change: "rename", department: departmentId });
  return { ok: true };
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
  await record(viewer, { change: "delete", department: departmentId });
  return { ok: true };
};

/** Add an active member of the shop to a department. */
export const addDepartmentMember = serialized(
  async (
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
    await record(viewer, {
      change: "add_member",
      department: departmentId,
      user: userId,
    });
    return { ok: true };
  }
);

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
  await record(viewer, {
    change: "remove_member",
    department: departmentId,
    user: userId,
  });
  return { ok: true };
};

/**
 * People who are no longer in the shop (removed in WorkOS) lose their
 * department places and their own grants, so being invited back later
 * doesn't silently give back what they could open. Their access already
 * stopped with their membership (library.who needs a role); this tidies up.
 * Each person is checked with WorkOS on their own, never from a list that
 * could be cut short.
 */
export const pruneDepartedMembers = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [members, grants] = await Promise.all([
    db.departmentMember.findMany({
      distinct: ["userId"],
      select: { userId: true },
    }),
    db.accessGrant.findMany({
      where: { principalType: "user" },
      distinct: ["principalId"],
      select: { principalId: true },
    }),
  ]);
  const people = new Set([
    ...members.map((m) => m.userId),
    ...grants.map((g) => g.principalId),
  ]);
  let removed = 0;
  for (const userId of people) {
    if (await shopRole(userId, orgId)) {
      continue;
    }
    await database.$transaction([
      database.departmentMember.deleteMany({ where: { orgId, userId } }),
      database.accessGrant.deleteMany({
        where: { orgId, principalType: "user", principalId: userId },
      }),
    ]);
    removed += 1;
  }
  return { checked: people.size, removed };
};

export interface DepartmentView {
  /** What its grants reach, as folder and document names. */
  access: { name: string; confidential: boolean }[];
  id: string;
  members: string[];
  name: string;
}

/** The shop's departments with their members (user ids) and what they open. */
export const listDepartments = async (
  viewer: Viewer
): Promise<DepartmentView[]> => {
  const { orgId } = trustedViewer(viewer);
  const db = forOrg(database, orgId);
  const [departments, grants] = await Promise.all([
    db.department.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        members: { select: { userId: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    db.accessGrant.findMany({
      where: { principalType: "department" },
      select: {
        principalId: true,
        folderId: true,
        sourceId: true,
        folder: { select: { name: true, confidential: true } },
        source: { select: { name: true } },
      },
    }),
  ]);
  // Only names the viewer may see themselves (security audit L6): an admin
  // managing departments learns that one reaches somewhere they can't open,
  // not what it's called.
  const [folders, documents] = await Promise.all([
    folderCapabilities(viewer),
    visibleSourceIds(viewer).then((ids) => new Set(ids)),
  ]);
  const nameOf = (g: (typeof grants)[number]) => {
    if (g.folderId) {
      return has(folders.get(g.folderId) ?? 0, "view")
        ? (g.folder?.name ?? "")
        : "A folder you can't open";
    }
    return g.sourceId && documents.has(g.sourceId)
      ? (g.source?.name ?? "")
      : "A document you can't open";
  };
  return departments.map((d) => ({
    id: d.id,
    name: d.name,
    members: d.members.map((m) => m.userId),
    access: grants
      .filter((g) => g.principalId === d.id)
      .map((g) => ({
        name: nameOf(g),
        confidential: Boolean(g.folder?.confidential),
      })),
  }));
};
