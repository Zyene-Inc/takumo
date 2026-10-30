import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEMO } from "../demo/data";
import { readSeed } from "../demo/read";
import { DEMO_TODAY, demoShiftDays } from "../demo/seed";

describe("demo shop data", () => {
  test("matches seed/acme-precision (run generate-demo after editing the seed)", () => {
    const seed = readSeed(join(import.meta.dirname, "../../../seed/acme-precision"));
    const { docs: _docs, ...bundled } = DEMO;
    expect(JSON.parse(JSON.stringify(bundled))).toEqual(seed);
    expect(Object.keys(DEMO.docs).sort()).toEqual(["Quality manual.md", "Setup notes.md"]);
  });

  test("dates move so the demo's today is the real today", () => {
    expect(demoShiftDays(DEMO_TODAY)).toBe(0);
    expect(demoShiftDays("2026-11-09")).toBe(7);
    expect(demoShiftDays("2026-10-30")).toBe(-3);
  });
});
