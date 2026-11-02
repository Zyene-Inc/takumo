import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deliver, mapResponse, sanitizeReason } from "../src/webhook.js";
import { mockWebhook, SECRET } from "./helpers.js";

const delivery = {
  raw: Buffer.from("Subject: x\r\n\r\nbody\r\n"),
  recipients: ["erp-abcd1234@in.takumo.test"],
  mailFrom: "a@b.example",
  remoteIp: "198.51.100.1",
  auth: {
    spf: "none",
    dkim: "none" as const,
    dkimDomains: [],
    dmarc: "none" as const,
    from: "",
  },
};

test("mapResponse: 2xx -> 250", () => {
  for (const status of [200, 201, 202, 204]) {
    assert.equal(mapResponse(status, "").code, 250);
  }
});

test("mapResponse: 4xx -> 550 with the JSON error text, else a generic message", () => {
  assert.deepEqual(mapResponse(404, '{"error":"Unknown address"}'), {
    code: 550,
    message: "Unknown address",
    webhookStatus: 404,
  });
  const generic = mapResponse(403, "<html>nope</html>");
  assert.equal(generic.code, 550);
  assert.equal(generic.message, "Message rejected by recipient system");
  assert.equal(
    mapResponse(422, '{"error":""}').message,
    "Message rejected by recipient system"
  );
  assert.equal(
    mapResponse(422, '{"error":42}').message,
    "Message rejected by recipient system"
  );
});

test("mapResponse: 5xx and other statuses -> 451", () => {
  for (const status of [500, 502, 503, 504, 301, 100]) {
    assert.equal(
      mapResponse(status, '{"error":"x"}').code,
      451,
      String(status)
    );
  }
});

test("error text is made safe for an SMTP line", () => {
  assert.equal(
    sanitizeReason("bad\r\n250 OK\tinjected"),
    "bad 250 OK injected"
  );
  assert.equal(sanitizeReason("x".repeat(500)).length, 200);
  assert.equal(sanitizeReason("Café ✓ ok"), "Caf ok");
});

const statuses = [204, 404, 503];
const hook = await mockWebhook((req, res) => {
  const status = Number(req.headers["x-test-status"] ?? statuses.shift());
  if (status === 0) {
    return; // never answer
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(status === 404 ? '{"error":"Unknown inbox address"}' : "{}");
});
after(() => hook.close());

test("deliver: 2xx, 4xx and 5xx answers from a real HTTP server", async () => {
  const options = { url: hook.url, secret: SECRET, timeoutMs: 5000 };
  assert.deepEqual(await deliver(options, delivery), {
    code: 250,
    message: "OK: message accepted",
    webhookStatus: 204,
  });
  assert.deepEqual(await deliver(options, delivery), {
    code: 550,
    message: "Unknown inbox address",
    webhookStatus: 404,
  });
  const failed = await deliver(options, delivery);
  assert.equal(failed.code, 451);
  assert.equal(failed.webhookStatus, 503);
});

test("deliver: no answer within the timeout -> 451", async () => {
  statuses.push(0);
  const started = Date.now();
  const reply = await deliver(
    { url: hook.url, secret: SECRET, timeoutMs: 300 },
    delivery
  );
  assert.equal(reply.code, 451);
  assert.equal(reply.webhookStatus, "timeout");
  assert.ok(Date.now() - started < 3000);
});

test("deliver: connection refused -> 451", async () => {
  const reply = await deliver(
    { url: "http://127.0.0.1:9/x", secret: SECRET, timeoutMs: 2000 },
    delivery
  );
  assert.equal(reply.code, 451);
  assert.equal(reply.webhookStatus, "network-error");
});
