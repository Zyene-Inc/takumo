import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { sign } from "../src/signature.js";
import { buildHeaders } from "../src/webhook.js";

const secret = "test-secret-0123456789abcdef0123456789";
const body = Buffer.from(
  "From: reports@shop.example\r\nSubject: Nightly\r\n\r\nhello\r\n"
);
const fields = {
  timestamp: "1793577600",
  recipients: "erp-abcd1234@in.takumo.ai,rfq-zz99yy88xx@in.takumo.ai",
  mailFrom: "reports@shop.example",
};
// Computed independently with:
// printf '<timestamp>.<recipients>.<mailFrom>.<body>' | openssl dgst -sha256 -hmac '<secret>'
const VECTOR =
  "8af88ee0dff44d0f5d57747d6f5972bc7f142d0ec8ed7afdf0ee81845875a76d";

test("signature matches the fixed test vector", () => {
  assert.equal(sign(secret, fields, body), VECTOR);
});

test("signature covers the raw bytes (non-UTF-8 body)", () => {
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a]);
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from("1.a.b."), binary]))
    .digest("hex");
  assert.equal(
    sign(secret, { timestamp: "1", recipients: "a", mailFrom: "b" }, binary),
    expected
  );
});

test("empty MAIL FROM (bounce) still signs as '<ts>.<rcpts>..<body>'", () => {
  const expected = createHmac("sha256", secret).update("1.r..x").digest("hex");
  assert.equal(
    sign(
      secret,
      { timestamp: "1", recipients: "r", mailFrom: "" },
      Buffer.from("x")
    ),
    expected
  );
});

test("webhook headers carry the contract fields", () => {
  const headers = buildHeaders(
    secret,
    {
      raw: body,
      recipients: fields.recipients.split(","),
      mailFrom: fields.mailFrom,
      remoteIp: "203.0.113.7",
      auth: {
        spf: "pass",
        dkim: "pass",
        dkimDomains: ["shop.example"],
        dmarc: "pass",
        from: "reports@shop.example",
      },
    },
    () => 1_793_577_600_123
  );
  assert.deepEqual(headers, {
    "Content-Type": "message/rfc822",
    "X-Takumo-Timestamp": "1793577600",
    "X-Takumo-Recipients": fields.recipients,
    "X-Takumo-Mail-From": "reports@shop.example",
    "X-Takumo-Remote-Ip": "203.0.113.7",
    "X-Takumo-Auth":
      '{"spf":"pass","dkim":"pass","dkimDomains":["shop.example"],"dmarc":"pass","from":"reports@shop.example"}',
    "X-Takumo-Signature": VECTOR,
  });
});
