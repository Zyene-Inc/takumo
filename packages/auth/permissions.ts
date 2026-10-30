// Who may change what. Roles are WorkOS role slugs (see the WorkOS dashboard →
// Roles): admin, planner, estimator, operator, member. Everyone in a shop can
// read its data; these rules only gate writes (upload, add, edit, delete).

export type Permission =
  | "shop:write"
  | "quotes:write"
  | "knowledge:write"
  | "knowledge:review"
  | "floor:write";

const GRANTS: Readonly<Record<Permission, readonly string[]>> = {
  // Machines, parts, routings, orders, customers, materials.
  "shop:write": ["owner", "admin", "planner"],
  "quotes:write": ["owner", "admin", "estimator"],
  // Upload and remove documents (SOPs, setup sheets, specs) for Ask Takumo.
  "knowledge:write": ["owner", "admin", "planner", "estimator"],
  // Approve or reject facts. An approved fact can change routings, rates and
  // costs, so supervisors only. Anyone in the shop can propose one.
  "knowledge:review": ["owner", "admin", "planner"],
  // Log what an operation actually took on the shop floor.
  "floor:write": ["owner", "admin", "planner", "operator"],
};

export const can = (role: string | null | undefined, permission: Permission) =>
  role ? GRANTS[permission].includes(role) : false;

/** Roles that hold a permission, for "ask your …" messages. */
export const rolesWith = (permission: Permission) =>
  GRANTS[permission].filter((r) => r !== "owner");
