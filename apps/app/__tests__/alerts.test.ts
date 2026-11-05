// Signed email links (F4.2) and alerts (F4.3): finding what changed, and
// sending at most one email per type an hour, batched.
import { describe, expect, test } from "vitest";
import {
  alertTypesFor,
  lateByNewOrders,
  machineDown,
  materialLate,
  topCustomerRfqs,
  topCustomers,
} from "../lib/alerts/detect";
import {
  ALERT_EVERY_MS,
  deliveries,
  type StoredEvent,
} from "../lib/alerts/throttle";
import {
  ACTION_TTL_S,
  actionPayload,
  signLink,
  verifyLink,
} from "../lib/brief/links";

const SECRET = "a-test-secret-that-is-long-enough-1234";
const NOW = new Date("2026-11-10T12:00:00Z");

describe("signed links", () => {
  const payload = actionPayload(
    "org_1",
    "user_1",
    { kind: "fact", factId: "f1", decision: "approve" },
    NOW,
    "nonce-1"
  );

  test("a link verifies, bound to its shop, person and action", () => {
    const v = verifyLink(SECRET, signLink(SECRET, payload), NOW);
    expect(v).toEqual({ ok: true, payload });
    expect(v.ok && v.payload.t === "act" && v.payload.u).toBe("user_1");
  });

  test("expires after 72 hours", () => {
    const token = signLink(SECRET, payload);
    const justBefore = new Date(NOW.getTime() + (ACTION_TTL_S - 60) * 1000);
    const after = new Date(NOW.getTime() + (ACTION_TTL_S + 1) * 1000);
    expect(verifyLink(SECRET, token, justBefore).ok).toBe(true);
    expect(verifyLink(SECRET, token, after)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a changed payload or another secret fails", () => {
    const token = signLink(SECRET, payload);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, u: "user_2" })
    ).toString("base64url");
    expect(verifyLink(SECRET, `${forged}.${sig}`, NOW).ok).toBe(false);
    expect(
      verifyLink("another-secret-also-long-enough-12345", token, NOW).ok
    ).toBe(false);
    expect(verifyLink(SECRET, "", NOW).ok).toBe(false);
    expect(verifyLink(SECRET, "abc", NOW).ok).toBe(false);
    expect(verifyLink(SECRET, `${token}.x`, NOW).ok).toBe(false);
  });

  test("each action link has its own nonce (used once)", () => {
    const a = actionPayload(
      "o",
      "u",
      { kind: "quote", rfqId: "r", lineId: "l", decision: "won" },
      NOW
    );
    const b = actionPayload(
      "o",
      "u",
      { kind: "quote", rfqId: "r", lineId: "l", decision: "won" },
      NOW
    );
    expect(a.t === "act" && b.t === "act" && a.n !== b.n).toBe(true);
  });

  test("tracked links only go to app paths", () => {
    const go = (p: string) =>
      verifyLink(
        SECRET,
        signLink(SECRET, { t: "go", o: "o", u: "u", s: "late", p, e: 2e9 }),
        NOW
      ).ok;
    expect(go("/schedule")).toBe(true);
    expect(go("https://evil.example")).toBe(false);
    expect(go("//evil.example")).toBe(false);
  });

  test("a well-signed payload of the wrong shape fails", () => {
    const token = signLink(SECRET, {
      t: "act",
      o: "o",
      u: "u",
      n: "n",
      e: 2e9,
      a: { kind: "fact", factId: "f", decision: "delete" },
    } as never);
    expect(verifyLink(SECRET, token, NOW).ok).toBe(false);
  });
});

describe("alert detection", () => {
  test("machine down: future zero-hour days, not shop holidays", () => {
    const rows = [
      {
        workCenterId: "w1",
        machine: "HAAS",
        date: "2026-11-10",
        hours: 0,
        reason: "breakdown",
      },
      {
        workCenterId: "w2",
        machine: "MAZAK",
        date: "2026-11-12",
        hours: 0,
        reason: "Holiday",
      },
      // Every machine off that day: the shop is closed.
      {
        workCenterId: "w1",
        machine: "HAAS",
        date: "2026-11-26",
        hours: 0,
        reason: null,
      },
      {
        workCenterId: "w2",
        machine: "MAZAK",
        date: "2026-11-26",
        hours: 0,
        reason: null,
      },
      {
        workCenterId: "w2",
        machine: "MAZAK",
        date: "2026-11-11",
        hours: 4,
        reason: null,
      },
      {
        workCenterId: "w2",
        machine: "MAZAK",
        date: "2026-12-30",
        hours: 0,
        reason: null,
      },
    ];
    expect(machineDown(rows, 2, "2026-11-10")).toEqual([
      {
        type: "down",
        key: "w1:2026-11-10",
        message: "HAAS is down today (breakdown).",
        path: "/schedule/calendar",
      },
    ]);
  });

  test("material later than an order's planned start", () => {
    const m = (date: string | null, notOrdered = false) => ({
      date,
      note: "on PO-55",
      notOrdered,
      unknown: false,
    });
    const found = materialLate(
      [
        { orderNo: "SO-1", start: "2026-11-11" },
        { orderNo: "SO-2", start: "2026-11-11" },
        { orderNo: "SO-3", start: "2026-11-11" },
      ],
      new Map([
        ["SO-1", m("2026-11-13")],
        ["SO-2", m("2026-11-11")],
        ["SO-3", m("2026-11-20", true)],
      ])
    );
    expect(found.map((f) => f.key)).toEqual(["SO-1:2026-11-13"]);
    expect(found[0].message).toContain("after its planned start Wed Nov 11");
  });

  test("top-10 customers by what they ordered; their RFQs alert", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      customerId: `c${i}`,
      amount: (i + 1) * 100,
    }));
    const top = topCustomers([...rows, { customerId: null, amount: 1e6 }]);
    expect(top.size).toBe(10);
    expect(top.has("c0")).toBe(false);
    expect(top.has("c11")).toBe(true);
    expect(
      topCustomerRfqs(
        [
          { id: "r1", label: "RFQ-0001", customer: "Big", customerId: "c11" },
          { id: "r2", label: "RFQ-0002", customer: "Small", customerId: "c0" },
        ],
        top
      )
    ).toEqual([
      {
        type: "rfq",
        key: "r1",
        message: "RFQ-0001 from Big, one of your top 10 customers.",
        path: "/quotes/r1",
      },
    ]);
  });

  test("a new order that pushes another late", () => {
    const r = (order_no: string, days_late: number) => ({
      order_no,
      days_late,
      due_date: "2026-11-12",
      completion_date: "2026-11-12",
    });
    const found = lateByNewOrders(
      [r("SO-1", 0), r("SO-2", 1), r("SO-3", 2)],
      [r("SO-1", 2), r("SO-2", 1), r("SO-3", 3), r("SO-9", 4)],
      ["SO-9"]
    );
    expect(found.map((f) => f.message)).toEqual([
      "New order SO-9 makes SO-1 2 days late (it was on time), due Thu Nov 12.",
      "New order SO-9 makes SO-3 3 days late (it was 2 days late), due Thu Nov 12.",
    ]);
  });

  test("who gets which alerts", () => {
    expect(alertTypesFor("planner")).toEqual(["late", "down", "material"]);
    expect(alertTypesFor("estimator")).toEqual(["rfq"]);
    expect(alertTypesFor("admin")).toHaveLength(4);
    expect(alertTypesFor("operator")).toEqual([]);
  });
});

describe("alert throttling", () => {
  const ev = (
    id: string,
    type: string,
    minutesAgo: number,
    quiet = false
  ): StoredEvent => ({
    id,
    type,
    quiet,
    message: id,
    path: "/",
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  });
  const planner = { userId: "u1", role: "planner", off: [] as string[] };

  test("everything new comes together in one email per type", () => {
    const out = deliveries(
      [ev("a", "down", 30), ev("b", "down", 5), ev("c", "late", 1)],
      [planner],
      new Map(),
      NOW
    );
    expect(out.map((d) => [d.type, d.events.map((e) => e.id)])).toEqual([
      ["late", ["c"]],
      ["down", ["a", "b"]],
    ]);
  });

  test("at most one an hour per type; the next one picks up what waited", () => {
    const lastSent = new Date(NOW.getTime() - 20 * 60_000);
    const sent = new Map([["u1|down", lastSent]]);
    const events = [ev("a", "down", 5), ev("b", "down", 15)];
    expect(deliveries(events, [planner], sent, NOW)).toEqual([]);
    const later = new Date(lastSent.getTime() + ALERT_EVERY_MS);
    const out = deliveries(events, [planner], sent, later);
    expect(out[0].events.map((e) => e.id)).toEqual(["b", "a"]);
  });

  test("never what was sent before, nor what was already true", () => {
    const sent = new Map([["u1|down", new Date(NOW.getTime() - 90 * 60_000)]]);
    const out = deliveries(
      [
        ev("old", "down", 120),
        ev("seed", "down", 10, true),
        ev("new", "down", 5),
      ],
      [planner],
      sent,
      NOW
    );
    expect(out[0].events.map((e) => e.id)).toEqual(["new"]);
  });

  test("off switches and roles", () => {
    const events = [ev("a", "down", 5), ev("b", "rfq", 5)];
    expect(
      deliveries(events, [{ ...planner, off: ["down"] }], new Map(), NOW)
    ).toEqual([]);
    expect(
      deliveries(
        events,
        [{ userId: "u2", role: "estimator", off: [] }],
        new Map(),
        NOW
      ).map((d) => d.type)
    ).toEqual(["rfq"]);
  });

  test("a first alert covers only the last day", () => {
    const out = deliveries(
      [ev("old", "down", 25 * 60), ev("new", "down", 60)],
      [planner],
      new Map(),
      NOW
    );
    expect(out[0].events.map((e) => e.id)).toEqual(["new"]);
  });
});
