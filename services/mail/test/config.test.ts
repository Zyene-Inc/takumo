import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const base = {
  INBOUND_EMAIL_SECRET: "s".repeat(32),
  WEBHOOK_URL: "https://takumo-app.vercel.app/api/inbound/email",
  MAIL_DOMAINS: "In.Takumo.ai, mail.example.com",
};

test("loads with defaults", () => {
  const config = loadConfig(base);
  assert.deepEqual(config.domains, ["in.takumo.ai", "mail.example.com"]);
  assert.equal(config.maxMessageBytes, 25 * 1024 * 1024);
  assert.equal(config.port, 25);
  assert.equal(config.healthHost, "127.0.0.1");
  assert.equal(config.healthPort, 2526);
  assert.equal(config.tlsCertFile, undefined);
});

test("refuses missing or weak settings", () => {
  assert.throws(
    () => loadConfig({ ...base, INBOUND_EMAIL_SECRET: "short" }),
    /INBOUND_EMAIL_SECRET/
  );
  assert.throws(
    () => loadConfig({ ...base, WEBHOOK_URL: "http://insecure.example/x" }),
    /https/
  );
  assert.throws(
    () => loadConfig({ ...base, WEBHOOK_URL: undefined }),
    /WEBHOOK_URL/
  );
  assert.throws(
    () => loadConfig({ ...base, MAIL_DOMAINS: " , " }),
    /MAIL_DOMAINS/
  );
  assert.throws(
    () => loadConfig({ ...base, TLS_CERT_FILE: "/x.crt" }),
    /TLS_KEY_FILE/
  );
  assert.throws(
    () => loadConfig({ ...base, MAX_MESSAGE_BYTES: "lots" }),
    /MAX_MESSAGE_BYTES/
  );
});
