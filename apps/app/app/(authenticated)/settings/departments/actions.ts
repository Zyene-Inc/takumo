"use server";

import { revalidatePath } from "next/cache";
import {
  addDepartmentMember,
  createDepartment,
  deleteDepartment,
  removeDepartmentMember,
  renameDepartment,
} from "@/lib/library/departments";
import { turnOnRestrictedAccess } from "@/lib/library/restricted";
import { resolveViewer } from "@/lib/library/viewer";

// Department changes. Who is asking comes from the server's session only;
// lib/library/departments.ts decides what they may change (an admin can't
// change a department that opens confidential folders they don't manage).

type Result = { ok: true } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const isId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

const SIGN_IN = { ok: false, error: "Sign in again." } as const;

const run = async (
  change: (
    viewer: NonNullable<Awaited<ReturnType<typeof resolveViewer>>>
  ) => Promise<Result | ({ ok: true } & object)>
): Promise<Result> => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return SIGN_IN;
  }
  const result = await change(viewer);
  revalidatePath("/settings/departments");
  revalidatePath("/library", "layout");
  return result.ok ? { ok: true } : result;
};

export const addDepartment = async (name: unknown) =>
  await run((viewer) =>
    typeof name === "string"
      ? createDepartment(viewer, name)
      : Promise.resolve({ ok: false, error: "Give the department a name." })
  );

export const renameDept = async (departmentId: unknown, name: unknown) =>
  await run((viewer) =>
    isId(departmentId) && typeof name === "string"
      ? renameDepartment(viewer, departmentId, name)
      : Promise.resolve({
          ok: false,
          error: "That department isn't there any more.",
        })
  );

export const removeDepartment = async (departmentId: unknown) =>
  await run((viewer) =>
    isId(departmentId)
      ? deleteDepartment(viewer, departmentId)
      : Promise.resolve({
          ok: false,
          error: "That department isn't there any more.",
        })
  );

export const addMember = async (departmentId: unknown, userId: unknown) =>
  await run((viewer) =>
    isId(departmentId) && isId(userId)
      ? addDepartmentMember(viewer, departmentId, userId)
      : Promise.resolve({ ok: false, error: "Choose someone in the shop." })
  );

export const removeMember = async (departmentId: unknown, userId: unknown) =>
  await run((viewer) =>
    isId(departmentId) && isId(userId)
      ? removeDepartmentMember(viewer, departmentId, userId)
      : Promise.resolve({
          ok: false,
          error: "That person isn't in it any more.",
        })
  );

/** The owner turns on restricted access (one way; refused until it's ready). */
export const turnOnRestricted = async () => await run(turnOnRestrictedAccess);
