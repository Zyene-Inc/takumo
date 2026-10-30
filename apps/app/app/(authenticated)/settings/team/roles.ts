// Roles a new member can be invited as (WorkOS role slugs). Shared with the browser.
export const INVITE_ROLES = [
  "admin",
  "planner",
  "estimator",
  "operator",
  "member",
] as const;

export const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including billing",
  admin: "Everything, including billing and connectors",
  planner: "Shop data, the schedule, approving facts",
  estimator: "Quotes and documents",
  operator: "Shop-floor logs and notes",
  member: "Read only",
};
