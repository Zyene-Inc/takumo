import "server-only";

import { listShopMembers } from "@repo/auth/server";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { requireCapability, type Target } from "./access";
import {
  type AiMode,
  documentAiMode,
  folderAiModes,
  isAiMode,
} from "./ai-mode";
import { has, onlyUpload, PRESETS } from "./capabilities";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Who can open a folder or document, in words for people who run a shop
// floor rather than a database: "Can view", "Can edit", never bit numbers.
// Read for one viewer, who must be able to view the item; only people who
// manage it see the controls (the server checks again on every change).

export type Level =
  | "Can manage access"
  | "Can edit"
  | "Can upload"
  | "Can view"
  | "Can upload only";

/** The plainest label for what a set of capabilities allows. */
export const levelOf = (capabilities: number): Level | null => {
  if (has(capabilities, "manage")) {
    return "Can manage access";
  }
  if (has(capabilities, "edit") || has(capabilities, "delete")) {
    return "Can edit";
  }
  if (has(capabilities, "view")) {
    return has(capabilities, "upload") ? "Can upload" : "Can view";
  }
  return has(capabilities, "upload") ? "Can upload only" : null;
};

/** The presets people choose from, by label. */
export const LEVEL_PRESET: Record<Level, number> = {
  "Can view": PRESETS.viewer,
  "Can upload": PRESETS.contributor,
  "Can edit": PRESETS.editor,
  "Can manage access": PRESETS.manager,
  "Can upload only": PRESETS.dropBox,
};

/** What a viewer may do, one short phrase each. */
export const yourAccess = (capabilities: number) =>
  (
    [
      ["view", "View"],
      ["download", "Download"],
      ["upload", "Upload"],
      ["edit", "Edit, move and rename"],
      ["delete", "Move to the Trash"],
      ["manage", "Manage who has access"],
    ] as const
  )
    .filter(([bit]) => has(capabilities, bit))
    .map(([, label]) => label);

export interface AccessEntry {
  /** The grant, when it can be removed here. */
  grantId: string | null;
  /** Where it comes from when inherited ("SOPs"); null: set here. */
  inheritedFrom: string | null;
  kind: "owner" | "admins" | "everyone" | "role" | "department" | "user";
  level: Level;
  /** Department members' names. */
  members?: string[];
  who: string;
}

export interface AccessView {
  /** The setting in force (the most restrictive on the path). */
  aiMode: AiMode;
  /** Folders: their own setting; documents: null. */
  aiOwn: AiMode | null;
  canManage: boolean;
  confidential: boolean;
  /** Folders: this folder itself is marked confidential. */
  confidentialHere: boolean;
  departments: { id: string; name: string }[];
  entries: AccessEntry[];
  inherits: boolean;
  isOwner: boolean;
  people: { name: string; userId: string }[];
  /** Restricted access is on for the shop (otherwise everything is company-wide). */
  restricting: boolean;
  /** At the top level (inherits nothing). */
  topLevel: boolean;
  yours: string[];
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owners",
  admin: "Admins",
  planner: "Planners",
  estimator: "Estimators",
  operator: "Operators",
  member: "Members",
};

const names = async (orgId: string) => {
  try {
    return await listShopMembers(orgId);
  } catch (error) {
    log.warn("Couldn't list shop members for access", { error: String(error) });
    return [];
  }
};

interface Grant {
  capabilities: number;
  id: string;
  principalId: string;
  principalType: string;
}

/** The folders whose grants reach `folderId` (ids, nearest last), up to where inheritance stops. */
const chainOf = async (orgId: string, folderId: string | null) => {
  if (!folderId) {
    return [];
  }
  const folder = await database.folder.findFirst({
    where: { id: folderId, orgId },
    select: { path: true },
  });
  const chain = await database.folder.findMany({
    where: { orgId, id: { in: folder?.path ?? [] } },
    select: { id: true, name: true, depth: true, inheritAccess: true },
    orderBy: { depth: "asc" },
  });
  const root = Math.max(
    1,
    ...chain.filter((f) => !f.inheritAccess).map((f) => f.depth)
  );
  return chain.filter((f) => f.depth >= root);
};

interface Names {
  departments: Map<
    string,
    { members: { userId: string }[]; name: string; id: string }
  >;
  people: Map<string, string>;
}

const PRINCIPAL_LABEL: Record<string, (id: string, names: Names) => string> = {
  everyone: () => "Everyone in the shop",
  role: (id) => ROLE_LABEL[id] ?? id,
  department: (id, names) =>
    names.departments.get(id)?.name ?? "A deleted department",
  user: (id, names) => names.people.get(id) ?? "Former member",
};

/** One grant as a line in the list, or null when it allows nothing here. */
const describe = (
  g: Grant,
  {
    confidential,
    canManage,
    inheritedFrom,
    names,
  }: {
    canManage: boolean;
    confidential: boolean;
    inheritedFrom: string | null;
    names: Names;
  }
): AccessEntry | null => {
  // In a confidential folder, everyone and whole roles may only upload.
  const wholeGroup =
    g.principalType === "everyone" || g.principalType === "role";
  const level = levelOf(
    confidential && wholeGroup ? onlyUpload(g.capabilities) : g.capabilities
  );
  if (!level) {
    return null;
  }
  const label = PRINCIPAL_LABEL[g.principalType] ?? PRINCIPAL_LABEL.user;
  const department =
    g.principalType === "department"
      ? names.departments.get(g.principalId)
      : undefined;
  return {
    grantId: inheritedFrom === null && canManage ? g.id : null,
    inheritedFrom,
    kind: g.principalType as AccessEntry["kind"],
    level,
    who: label(g.principalId, names),
    ...(department
      ? {
          members: department.members.map(
            (m) => names.people.get(m.userId) ?? "Former member"
          ),
        }
      : {}),
  };
};

const IMPLICIT = {
  owner: {
    grantId: null,
    inheritedFrom: null,
    kind: "owner",
    level: "Can manage access",
    who: "The shop's owner",
  },
  admins: {
    grantId: null,
    inheritedFrom: null,
    kind: "admins",
    level: "Can manage access",
    who: "Admins",
  },
  library: {
    grantId: null,
    inheritedFrom: "the library",
    kind: "everyone",
    level: "Can view",
    who: "Everyone in the shop",
  },
} as const satisfies Record<string, AccessEntry>;

interface Item {
  aiOwn: AiMode | null;
  confidentialHere: boolean;
  inherits: boolean;
  parent: string | null;
}

const itemOf = async (orgId: string, target: Target): Promise<Item | null> => {
  if ("folderId" in target) {
    const folder = await database.folder.findFirst({
      where: { id: target.folderId, orgId },
      select: {
        parentId: true,
        inheritAccess: true,
        confidential: true,
        aiMode: true,
      },
    });
    return folder
      ? {
          parent: folder.parentId,
          inherits: folder.inheritAccess,
          confidentialHere: folder.confidential,
          aiOwn: isAiMode(folder.aiMode) ? folder.aiMode : "off",
        }
      : null;
  }
  const source = await database.source.findFirst({
    where: { id: target.sourceId, orgId },
    select: { folderId: true, inheritAccess: true },
  });
  return source
    ? {
        parent: source.folderId,
        inherits: source.inheritAccess,
        confidentialHere: false,
        aiOwn: null,
      }
    : null;
};

const GRANT_SELECT = {
  id: true,
  principalType: true,
  principalId: true,
  capabilities: true,
  folderId: true,
} as const;

const aiModeOf = async (orgId: string, target: Target): Promise<AiMode> =>
  "folderId" in target
    ? ((await folderAiModes(orgId)).get(target.folderId) ?? "off")
    : documentAiMode(orgId, target.sourceId);

/** Who can open a folder or document, for someone who can view it; null otherwise. */
export const accessView = async (
  viewer: Viewer,
  target: Target
): Promise<AccessView | null> => {
  const { orgId, isOwner } = trustedViewer(viewer);
  const check = await requireCapability(viewer, target, "view");
  const item = check.ok ? await itemOf(orgId, target) : null;
  if (!(check.ok && item)) {
    return null;
  }
  const mine = check.access;
  const [restricting, members, departments, own, chain, aiMode] =
    await Promise.all([
      confidentialEnabled(orgId),
      names(orgId),
      database.department.findMany({
        where: { orgId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, members: { select: { userId: true } } },
      }),
      database.accessGrant.findMany({
        where: { orgId, ...target },
        select: GRANT_SELECT,
      }),
      item.inherits ? chainOf(orgId, item.parent) : Promise.resolve([]),
      aiModeOf(orgId, target),
    ]);
  const inherited = chain.length
    ? await database.accessGrant.findMany({
        where: { orgId, folderId: { in: chain.map((f) => f.id) } },
        select: GRANT_SELECT,
      })
    : [];
  const folderName = new Map(chain.map((f) => [f.id, f.name]));
  const context = {
    confidential: mine.confidential,
    canManage: restricting && has(mine.capabilities, "manage"),
    names: {
      people: new Map(members.map((m) => [m.userId, m.name])),
      departments: new Map(departments.map((d) => [d.id, d])),
    },
  };
  const entries: AccessEntry[] = [
    IMPLICIT.owner,
    ...(mine.confidential ? [] : [IMPLICIT.admins]),
    ...own.map((g) => describe(g, { ...context, inheritedFrom: null })),
    ...inherited.map((g) =>
      describe(g, {
        ...context,
        inheritedFrom: folderName.get(g.folderId ?? "") ?? "a folder above",
      })
    ),
    // A document outside any folder has always been readable by everyone.
    ...("sourceId" in target && !item.parent && item.inherits
      ? [IMPLICIT.library]
      : []),
  ].filter((e): e is AccessEntry => e !== null);
  return {
    restricting,
    canManage: context.canManage,
    isOwner,
    confidential: mine.confidential,
    confidentialHere: item.confidentialHere,
    inherits: item.inherits,
    topLevel: !item.parent,
    aiOwn: item.aiOwn,
    aiMode,
    yours: yourAccess(mine.capabilities),
    entries,
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    people: members
      .map((m) => ({ userId: m.userId, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};
