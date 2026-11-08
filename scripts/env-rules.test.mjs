import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkService, SERVICES } from "./env-rules.mjs";

// Lives next to env-rules so the app package does not import out of itself.
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
    assert.deepEqual(
      problems.filter((p) => p.level === "required"),
      []
    );
    assert.equal(
      problems.every((p) => p.level === "recommended"),
      true
    );
  });

  test("missing and malformed values are named, never shown", () => {
    const problems = checkService(
      SERVICES.api,
      {
        ...complete,
        STRIPE_SECRET_KEY: "sk_test_abc",
        STRIPE_WEBHOOK_SECRET: "nope",
        DATABASE_URL: "",
      },
      { production: true }
    );
    const required = problems.filter((p) => p.level === "required");
    assert.deepEqual(
      required.map((p) => `${p.name}: ${p.problem}`),
      [
        "DATABASE_URL: not set",
        "STRIPE_SECRET_KEY: is not a live Stripe key",
        "STRIPE_WEBHOOK_SECRET: doesn't look like a webhook secret",
      ]
    );
    assert.equal(JSON.stringify(problems).includes("sk_test_abc"), false);
  });

  test("test keys are fine outside production; the connector key must be 32 bytes", () => {
    const local = checkService(SERVICES.api, {
      ...complete,
      STRIPE_SECRET_KEY: "sk_test_x",
    });
    assert.equal(
      local.some((p) => p.name === "STRIPE_SECRET_KEY"),
      false
    );
    const key = checkService(SERVICES.app, {
      CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
    });
    assert.match(
      key.find((p) => p.name === "CONNECTOR_ENCRYPTION_KEY")?.problem ?? "",
      /32 bytes/
    );
  });

  test("Gemini on Vertex replaces the Anthropic and OpenAI keys", () => {
    const names = (env) => checkService(SERVICES.app, env).map((p) => p.name);
    assert.equal(names({}).includes("ANTHROPIC_API_KEY"), true);
    assert.equal(names({}).includes("GOOGLE_SERVICE_ACCOUNT_JSON"), false);
    const vertex = names({ GOOGLE_GENAI_USE_VERTEXAI: "true" });
    assert.equal(vertex.includes("ANTHROPIC_API_KEY"), false);
    assert.equal(vertex.includes("OPENAI_API_KEY"), false);
    assert.equal(vertex.includes("GOOGLE_CLOUD_PROJECT"), true);
    assert.equal(vertex.includes("GOOGLE_SERVICE_ACCOUNT_JSON"), true);
    const bad = checkService(SERVICES.app, {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    });
    assert.equal(
      (
        bad.find((p) => p.name === "GOOGLE_SERVICE_ACCOUNT_JSON")?.problem ?? ""
      ).includes("client_email"),
      true
    );
  });
});
