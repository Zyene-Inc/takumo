"use server";

import { revalidatePath } from "next/cache";
import type { Target } from "@/lib/library/access";
import {
  type AccessView,
  accessView,
  LEVEL_PRESET,
  type Level,
} from "@/lib/library/access-view";
import { setFolderAiMode } from "@/lib/library/ai-settings";
import {
  setConfidential,
  setInheritance,
} from "@/lib/library/grant-inheritance";
import {
  type ChainGrant,
  grantAccess,
  type Principal,
  revokeAccess,
} from "@/lib/library/grants";
import { libraryEnabled } from "@/lib/library/stage";
import { resolveViewer, type Viewer } from "@/lib/library/viewer";

// Changing who may open a folder or document, and its AI setting. Who is
// asking comes from the server's session only; every change is decided by
// lib/library (grants.ts, ai-settings.ts) on the server, never by what the
// page shows. Ids are checked for shape here and for existence there.

type Result = { ok: true } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

const NOT_FOUND = { ok: false, error: "That isn't there any more." } as const;

const targetOf = (raw: unknown): Target | null => {
  const t = raw as { folderId?: unknown; sourceId?: unknown } | null;
  if (isId(t?.folderId) && t?.sourceId === undefined) {
    return { folderId: t.folderId };
  }
  if (isId(t?.sourceId) && t?.folderId === undefined) {
    return { sourceId: t.sourceId };
  }
  return null;
};

const libraryViewer = async (): Promise<Viewer | null> => {
  const viewer = await resolveViewer();
  return viewer && (await libraryEnabled(viewer.orgId)) ? viewer : null;
};

const done = <T>(result: T) => {
  revalidatePath("/library", "layout");
  return result;
};

/** Who can open it, for the access dialog (null when the viewer can't see it). */
export const loadAccess = async (raw: unknown): Promise<AccessView | null> => {
  const viewer = await libraryViewer();
  const target = targetOf(raw);
  return viewer && target ? accessView(viewer, target) : null;
};

const principalOf = (raw: unknown): Principal | null => {
  const p = raw as { type?: unknown; id?: unknown } | null;
  if (p?.type === "everyone") {
    return { type: "everyone" };
  }
  if (
    (p?.type === "department" || p?.type === "user" || p?.type === "role") &&
    typeof p.id === "string" &&
    p.id.length > 0 &&
    p.id.length <= 100
  ) {
    return { type: p.type, id: p.id };
  }
  return null;
};

export const addAccess = async (
  rawTarget: unknown,
  rawPrincipal: unknown,
  level: unknown
): Promise<Result> => {
  const viewer = await libraryViewer();
  const target = targetOf(rawTarget);
  const principal = principalOf(rawPrincipal);
  if (!(viewer && target)) {
    return NOT_FOUND;
  }
  if (!principal) {
    return { ok: false, error: "Choose who gets access." };
  }
  const capabilities = LEVEL_PRESET[level as Level];
  if (!capabilities) {
    return { ok: false, error: "Choose what they may do." };
  }
  return done(await grantAccess(viewer, target, principal, capabilities));
};

export const removeAccess = async (grantId: unknown): Promise<Result> => {
  const viewer = await libraryViewer();
  if (!(viewer && isId(grantId))) {
    return NOT_FOUND;
  }
  return done(await revokeAccess(viewer, grantId));
};

export type InheritOutcome =
  | Result
  /** Resuming would give these people access: ask, then confirm. */
  | { ok: false; error: string; gains: string[] };

const gainLabels = (view: AccessView | null, gains: ChainGrant[]) => {
  const departments = new Map(view?.departments.map((d) => [d.id, d.name]));
  const people = new Map(view?.people.map((p) => [p.userId, p.name]));
  return gains.map((g) => {
    if (g.principal_type === "everyone") {
      return "Everyone in the shop";
    }
    if (g.principal_type === "department") {
      return departments.get(g.principal_id) ?? "A department";
    }
    if (g.principal_type === "user") {
      return people.get(g.principal_id) ?? "Former member";
    }
    return `Everyone with the ${g.principal_id} role`;
  });
};

export const changeInheritance = async (
  rawTarget: unknown,
  inherit: unknown,
  confirmed: unknown
): Promise<InheritOutcome> => {
  const viewer = await libraryViewer();
  const target = targetOf(rawTarget);
  if (!(viewer && target && typeof inherit === "boolean")) {
    return NOT_FOUND;
  }
  const result = await setInheritance(viewer, target, inherit, {
    confirmed: confirmed === true,
  });
  if (!result.ok && "confirm" in result) {
    return {
      ok: false,
      error: result.error,
      gains: gainLabels(await accessView(viewer, target), result.confirm),
    };
  }
  return done(result);
};

export const changeConfidential = async (
  folderId: unknown,
  confidential: unknown
): Promise<Result> => {
  const viewer = await libraryViewer();
  if (!(viewer && isId(folderId) && typeof confidential === "boolean")) {
    return NOT_FOUND;
  }
  return done(await setConfidential(viewer, folderId, confidential));
};

export type AiOutcome = Result | { ok: false; error: string; confirm: true };

export const changeAiMode = async (
  folderId: unknown,
  mode: unknown,
  confirmed: unknown
): Promise<AiOutcome> => {
  const viewer = await libraryViewer();
  if (!(viewer && isId(folderId) && typeof mode === "string")) {
    return NOT_FOUND;
  }
  return done(
    await setFolderAiMode(viewer, folderId, mode, {
      confirmed: confirmed === true,
    })
  );
};
