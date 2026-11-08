// Who may change what. Roles are WorkOS role slugs (see the WorkOS dashboard →
// Roles): admin, planner, estimator, operator, member. Everyone in a shop can
// read its data; these rules only gate writes (upload, add, edit, delete).

export type Permission =
  | "shop:write"
  | "quotes:write"
  | "knowledge:share"
  | "knowledge:write"
  | "knowledge:review"
  | "floor:write"
  | "billing:manage"
  | "connectors:manage"
  | "departments:manage";

const GRANTS: Readonly<Record<Permission, readonly string[]>> = {
  // Machines, parts, routings, orders, customers, materials.
  "shop:write": ["owner", "admin", "planner"],
  "quotes:write": ["owner", "admin", "estimator"],
  // Give Takumo knowledge: upload documents (SOPs, setup sheets, specs,
  // handbooks). Anyone in the company can, from the founder to the floor.
  "knowledge:share": [
    "owner",
    "admin",
    "planner",
    "estimator",
    "operator",
    "member",
  ],
  // Remove, replace or read again documents someone else gave.
  "knowledge:write": ["owner", "admin", "planner", "estimator"],
  // Approve or reject facts. An approved fact can change routings, rates and
  // costs, so supervisors only. Anyone in the shop can propose one.
  "knowledge:review": ["owner", "admin", "planner"],
  // Log what an operation actually took on the shop floor.
  "floor:write": ["owner", "admin", "planner", "operator"],
  // Plans and payment.
  "billing:manage": ["owner", "admin"],
  // Connect or disconnect QuickBooks and Gmail.
  "connectors:manage": ["owner", "admin"],
  // Create departments and choose who is in them. Departments that can open
  // confidential documents also need "manage" on those (lib/library).
  "departments:manage": ["owner", "admin"],
};

export const can = (role: string | null | undefined, permission: Permission) =>
  role ? GRANTS[permission].includes(role) : false;

/** Roles that hold a permission, for "ask your …" messages. */
export const rolesWith = (permission: Permission) =>
  GRANTS[permission].filter((r) => r !== "owner");
