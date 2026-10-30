import { can } from "@repo/auth/permissions";
import { describe, expect, test } from "vitest";

describe("role permissions", () => {
  test("admins and planners change shop data", () => {
    expect(can("admin", "shop:write")).toBe(true);
    expect(can("planner", "shop:write")).toBe(true);
    expect(can("estimator", "shop:write")).toBe(false);
    expect(can("operator", "shop:write")).toBe(false);
    expect(can("member", "shop:write")).toBe(false);
  });

  test("admins and estimators change quotes", () => {
    expect(can("admin", "quotes:write")).toBe(true);
    expect(can("estimator", "quotes:write")).toBe(true);
    expect(can("planner", "quotes:write")).toBe(false);
    expect(can("operator", "quotes:write")).toBe(false);
  });

  test("planners and estimators add documents; operators and members don't", () => {
    expect(can("planner", "knowledge:write")).toBe(true);
    expect(can("estimator", "knowledge:write")).toBe(true);
    expect(can("admin", "knowledge:write")).toBe(true);
    expect(can("operator", "knowledge:write")).toBe(false);
    expect(can("member", "knowledge:write")).toBe(false);
  });

  test("supervisors approve facts; operators log floor times", () => {
    expect(can("planner", "knowledge:review")).toBe(true);
    expect(can("admin", "knowledge:review")).toBe(true);
    expect(can("estimator", "knowledge:review")).toBe(false);
    expect(can("operator", "knowledge:review")).toBe(false);
    expect(can("operator", "floor:write")).toBe(true);
    expect(can("planner", "floor:write")).toBe(true);
    expect(can("estimator", "floor:write")).toBe(false);
    expect(can("member", "floor:write")).toBe(false);
  });

  test("no role, no writes", () => {
    expect(can(null, "shop:write")).toBe(false);
    expect(can(undefined, "quotes:write")).toBe(false);
  });
});
