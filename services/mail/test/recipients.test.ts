import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptRecipient } from "../src/recipients.js";

const domains = ["in.takumo.ai", "mail.example.com"];

test("accepts the four prefixes with an 8-32 character token", () => {
  for (const prefix of ["erp", "rfq", "docs", "ask"]) {
    assert.equal(
      acceptRecipient(`${prefix}-abcd1234@in.takumo.ai`, domains),
      `${prefix}-abcd1234@in.takumo.ai`
    );
  }
  assert.equal(
    acceptRecipient(`erp-${"a".repeat(32)}@mail.example.com`, domains),
    `erp-${"a".repeat(32)}@mail.example.com`
  );
});

test("is case-insensitive and returns the lowercased address", () => {
  assert.equal(
    acceptRecipient("ERP-AbCd1234@IN.Takumo.AI", domains),
    "erp-abcd1234@in.takumo.ai"
  );
});

test("rejects other local parts, tokens and domains", () => {
  const bad = [
    "erp-abc1234@in.takumo.ai", // 7 chars
    `erp-${"a".repeat(33)}@in.takumo.ai`, // 33 chars
    "erp-abcd_1234@in.takumo.ai",
    "erp-abcd1234+x@in.takumo.ai",
    "sales-abcd1234@in.takumo.ai",
    "erpabcd1234@in.takumo.ai",
    "postmaster@in.takumo.ai",
    "erp-abcd1234@takumo.ai",
    "erp-abcd1234@in.takumo.ai.evil.com",
    "erp-abcd1234@other.com",
    "erp-abcd1234",
    "@in.takumo.ai",
    "",
  ];
  for (const address of bad) {
    assert.equal(acceptRecipient(address, domains), null, address);
  }
});
