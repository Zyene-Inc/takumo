import { readdirSync } from "node:fs";
import path from "node:path";
import { costUsd, PRICES } from "@repo/ai/lib/pricing";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { checkService, SERVICES } from "../../../scripts/env-rules.mjs";
import { entityCsv, plainCsv, zipFiles } from "../lib/export/csv";
import { ARTICLES } from "../lib/help/articles";

describe("AI cost", () => {
  test("uncached, cache reads, cache writes and output are priced separately", () => {
    // 1M of each on Opus 5.5: $4 + $0.20 + $5 + $20.
    const usage = {
      inputTokens: 3_000_000,
      inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      outputTokens: 1_000_000,
    };
    expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(29.2, 6);
  });

  test("without a breakdown, all input is priced as uncached", () => {
    expect(costUsd("claude-haiku-5-5", { inputTokens: 2_000_000, outputTokens: 0 })).toBeCloseTo(0.2, 6);
    expect(
      costUsd("gemini-3.5-flash-lite", {
        inputTokens: 1_000_000,
        inputTokenDetails: { cacheReadTokens: 500_000 },
        outputTokens: 1_000_000,
      })
    ).toBeCloseTo(0.15 + 0.015 + 2.5, 6);
  });

  test("caching makes a 10-step answer far cheaper", () => {
    // 10 steps re-sending a growing 20k-token prefix, 500 tokens out each.
    const steps = Array.from({ length: 10 }, (_, i) => 20_000 + i * 2000);
    const uncached = steps.reduce((sum, t) => sum + (costUsd("claude-opus-5-5", { inputTokens: t, outputTokens: 500 }) ?? 0), 0);
    const cached = steps.reduce((sum, t, i) => {
      const read = i === 0 ? 0 : steps[i - 1];
      return (
        sum +
        (costUsd("claude-opus-5-5", {
          inputTokens: t,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: read, cacheWriteTokens: t - read },
          outputTokens: 500,
        }) ?? 0)
      );
    }, 0);
    expect(cached).toBeLessThan(uncached * 0.45);
  });

  test("an unknown model isn't priced; dated ids match their model", () => {
    expect(costUsd("gpt-5", { inputTokens: 1 })).toBeNull();
    expect(costUsd("claude-sonnet-5-5-20261001", { inputTokens: 1_000_000 })).toBeCloseTo(2, 6);
    expect(Object.keys(PRICES)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
  });
});

describe("launch settings check", () => {
  const complete = {
    DATABASE_URL: "postgres://x",
    WORKOS_API_KEY: "sk_live_x",
    WORKOS_CLIENT_ID: "client_x",
    WORKOS_WEBHOOK_SECRET: "secret",
    STRIPE_SECRET_KEY: "sk_live_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    NEXT_PUBLIC_APP_URL: "https://app.takumo.ai",
    NEXT_PUBLIC_WEB_URL: "https://takumo.ai",
  };

  test("a complete production API environment passes; optional ones are only noted", () => {
    const problems = checkService(SERVICES.api, complete, { production: true });
    expect(problems.filter((p) => p.level === "required")).toEqual([]);
    expect(problems.every((p) => p.level === "recommended")).toBe(true);
  });

  test("missing and malformed values are named, never shown", () => {
    const problems = checkService(
      SERVICES.api,
      { ...complete, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "nope", DATABASE_URL: "" },
      { production: true }
    );
    const required = problems.filter((p) => p.level === "required");
    expect(required.map((p) => `${p.name}: ${p.problem}`)).toEqual([
      "DATABASE_URL: not set",
      "STRIPE_SECRET_KEY: is not a live Stripe key",
      "STRIPE_WEBHOOK_SECRET: doesn't look like a webhook secret",
    ]);
    expect(JSON.stringify(problems)).not.toContain("sk_test_abc");
  });

  test("test keys are fine outside production; the connector key must be 32 bytes", () => {
    const local = checkService(SERVICES.api, { ...complete, STRIPE_SECRET_KEY: "sk_test_x" });
    expect(local.some((p) => p.name === "STRIPE_SECRET_KEY")).toBe(false);
    const key = checkService(SERVICES.app, { CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") });
    expect(key.find((p) => p.name === "CONNECTOR_ENCRYPTION_KEY")?.problem).toMatch(/32 bytes/);
  });

  test("Gemini on Vertex replaces the Anthropic and OpenAI keys", () => {
    const names = (env: Record<string, string>) =>
      checkService(SERVICES.app, env).map((p) => p.name);
    expect(names({})).toContain("ANTHROPIC_API_KEY");
    expect(names({})).not.toContain("GOOGLE_SERVICE_ACCOUNT_JSON");
    const vertex = names({ GOOGLE_GENAI_USE_VERTEXAI: "true" });
    expect(vertex).not.toContain("ANTHROPIC_API_KEY");
    expect(vertex).not.toContain("OPENAI_API_KEY");
    expect(vertex).toEqual(expect.arrayContaining(["GOOGLE_CLOUD_PROJECT", "GOOGLE_SERVICE_ACCOUNT_JSON"]));
    const bad = checkService(SERVICES.app, { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_SERVICE_ACCOUNT_JSON: "{}" });
    expect(bad.find((p) => p.name === "GOOGLE_SERVICE_ACCOUNT_JSON")?.problem).toContain("client_email");
  });
});

describe("data export", () => {
  test("files use the import templates' headers, quoted where needed", () => {
    const csv = entityCsv("routings", [
      { partNo: "P-1001", rev: "B", seq: 10, workCenter: "HAAS-VF2", setupMin: 45, runMinPerUnit: 6, altWorkCenters: "HAAS-VF4" },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Part number,Revision,Operation number,Machine / work center,Setup time,Run time per part,Alternate machines",
      "P-1001,B,10,HAAS-VF2,45,6,HAAS-VF4",
    ]);
    expect(plainCsv(["text"], [{ text: 'Says "hi", then leaves' }])).toBe('text\r\n"Says ""hi"", then leaves"');
  });

  test("the zip holds every file", () => {
    const zip = zipFiles({ "a.csv": "x,y", "README.txt": "hello" });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["README.txt", "a.csv"]);
    expect(strFromU8(files["a.csv"])).toBe("x,y");
  });
});

describe("help articles", () => {
  const appRoutes = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const segment = entry.name.startsWith("(") ? "" : `/${entry.name}`;
      appRoutes.add(`${prefix}${segment}` || "/");
      walk(path.join(dir, entry.name), `${prefix}${segment}`);
    }
  };
  walk(path.join(import.meta.dirname, "../app"), "");

  test("slugs are unique and every article has a body", () => {
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length);
    for (const a of ARTICLES) {
      expect(a.body.length).toBeGreaterThan(200);
    }
  });

  test("links point to real help articles", () => {
    const links = ARTICLES.flatMap((a) => [...a.body.matchAll(/\]\((\/[^)]+)\)/g)].map((m) => m[1]));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const slug = link.replace("/help/", "");
      expect(ARTICLES.some((a) => a.slug === slug), link).toBe(true);
    }
    expect(appRoutes.has("/help/[slug]")).toBe(true);
  });
});
