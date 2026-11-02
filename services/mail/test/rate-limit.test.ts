import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "../src/rate-limit.js";

test("allows a burst of `capacity`, then refuses until it refills", () => {
  let now = 0;
  const limiter = new RateLimiter(3, 60_000, () => now);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  // Other keys have their own bucket.
  assert.equal(limiter.take("b"), true);
  now += 20_000; // one token back (3 per minute)
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  now += 10 * 60_000; // never more than capacity
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
});

test("sweep drops refilled buckets only", () => {
  let now = 0;
  const limiter = new RateLimiter(2, 1000, () => now);
  limiter.take("a");
  limiter.take("b");
  limiter.take("b");
  now += 600; // a is full again (1 + 1.2), b is at 1.2
  limiter.sweep();
  assert.equal(limiter.size, 1);
});

test("the map is bounded", () => {
  const now = 0;
  const limiter = new RateLimiter(1, 1000, () => now, 10);
  for (let i = 0; i < 50; i++) {
    limiter.take(`ip${i}`);
  }
  assert.equal(limiter.size, 10);
  assert.equal(limiter.take("ip49"), false);
});
