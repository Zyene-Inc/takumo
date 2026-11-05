// @vitest-environment node
// Morning brief, approve-from-email and alerts against a real database
// (docs/PRODUCT-PLAN.md Phase 4): an email link works once, only for a role
// that may do it; unsubscribing sticks; a brief goes once a day; alerts stay
// quiet about what was already true and send at most one an hour. Runs only
// with TEST_DATABASE_URL (a disposable database with the migrations applied).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = "test-email-link-secret-0123456789abcdef";

const roles = new Map<string, string>();
const send = vi.fn(async (_email: unknown) => ({
  data: { id: "x" },
  error: null,
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../env", () => ({
  env: { EMAIL_LINK_SECRET: SECRET, NEXT_PUBLIC_APP_URL: "https://app.test" },
}));
vi.mock("@repo/email", () => ({ resend: { emails: { send } } }));
vi.mock("@repo/email/keys", () => ({
  keys: () => ({ RESEND_FROM: "brief@takumo.test" }),
}));
vi.mock("@repo/auth/server", () => ({
  withAuth: async () => ({ user: null }),
  getWorkOS: () => ({
    userManagement: {
      listOrganizationMemberships: async ({ userId }: { userId: string }) => ({
        data: roles.has(userId) ? [{ role: { slug: roles.get(userId) } }] : [],
      }),
    },
  }),
  listShopMembers: async (orgId: string) =>
    orgId.startsWith("org_notify_")
      ? [...roles].map(([userId, role]) => ({
          id: userId,
          userId,
          role,
          email: `${userId}@shop.test`,
          name: "Sam Planner",
        }))
      : [],
}));

type Db = typeof import("@repo/database");

describe.skipIf(!TEST_DATABASE_URL)(
  "brief, email links, alerts (database)",
  () => {
    const orgId = `org_notify_${randomUUID().slice(0, 8)}`;
    let database: Db["database"];
    let links: typeof import("../lib/brief/links");
    let act: typeof import("../lib/brief/act");
    let unsub: typeof import("../lib/brief/unsubscribe");
    let briefs: typeof import("../lib/brief/run");
    let alerts: typeof import("../lib/alerts/run");
    // Tuesday 06:30 in Chicago.
    const NOW = new Date("2026-11-10T12:30:00Z");
    let factNo = 0;

    const fact = () => {
      factNo += 1;
      return database.fact.create({
        data: {
          orgId,
          number: factNo,
          subjectType: "shop",
          subjectId: orgId,
          subjectLabel: "Shop",
          attribute: "note",
          value: "Deburr everything by hand",
          source: "note",
        },
      });
    };

    const approveLink = (factId: string, userId: string, now = NOW) =>
      links.signLink(
        SECRET,
        links.actionPayload(
          orgId,
          userId,
          { kind: "fact", factId, decision: "approve" },
          now
        )
      );

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      links = await import("../lib/brief/links");
      act = await import("../lib/brief/act");
      unsub = await import("../lib/brief/unsubscribe");
      briefs = await import("../lib/brief/run");
      alerts = await import("../lib/alerts/run");
      await database.org.create({ data: { id: orgId, name: "Notify test" } });
      roles.set("user_planner", "planner");
      roles.set("user_estimator", "estimator");
    });
    afterAll(async () => {
      await database.org.deleteMany({ where: { id: orgId } });
      await database.$disconnect();
    });

    test("an approve link works once", async () => {
      const f = await fact();
      const token = approveLink(f.id, "user_planner");
      const first = await act.performAction(token, null, NOW);
      expect(first).toEqual({ ok: true, message: "F-1 approved." });
      const saved = await database.fact.findUniqueOrThrow({
        where: { id: f.id },
      });
      expect(saved.status).toBe("approved");
      expect(saved.reviewedBy).toBe("user_planner");
      expect(await act.performAction(token, null, NOW)).toEqual({
        ok: false,
        error: "This link was already used.",
      });
      // The confirmation page says so too.
      expect((await act.checkActionLink(token, NOW)).ok).toBe(false);
    });

    test("the same role checks as the app; a refusal doesn't use the link", async () => {
      const f = await fact();
      const token = approveLink(f.id, "user_estimator");
      const refused = await act.performAction(token, null, NOW);
      expect(refused.ok).toBe(false);
      expect(await database.emailLinkUse.count({ where: { orgId } })).toBe(1);
      roles.set("user_estimator", "admin");
      expect((await act.performAction(token, null, NOW)).ok).toBe(true);
      roles.set("user_estimator", "estimator");
    });

    test("an expired link or someone who left does nothing", async () => {
      const f = await fact();
      const old = approveLink(
        f.id,
        "user_planner",
        new Date("2026-11-01T00:00:00Z")
      );
      expect(await act.performAction(old, null, NOW)).toMatchObject({
        ok: false,
      });
      const gone = approveLink(f.id, "user_gone");
      expect(await act.performAction(gone, null, NOW)).toEqual({
        ok: false,
        error: "You're no longer in this shop.",
      });
      const still = await database.fact.findUniqueOrThrow({
        where: { id: f.id },
      });
      expect(still.status).toBe("pending");
    });

    test("unsubscribe: one section, then everything", async () => {
      const payload = (s: string) =>
        ({ t: "unsub", o: orgId, u: "user_x", s, e: 2e9 }) as const;
      await unsub.applyUnsubscribe(payload("facts"));
      await unsub.applyUnsubscribe(payload("alert:down"));
      let prefs = await database.notifyPrefs.findUniqueOrThrow({
        where: { orgId_userId: { orgId, userId: "user_x" } },
      });
      expect(prefs).toMatchObject({
        briefOn: true,
        briefOff: ["facts"],
        alertsOff: ["down"],
      });
      await unsub.applyUnsubscribe(payload("all"));
      prefs = await database.notifyPrefs.findUniqueOrThrow({
        where: { orgId_userId: { orgId, userId: "user_x" } },
      });
      expect(prefs.briefOn).toBe(false);
      expect(prefs.alertsOff.sort()).toEqual([
        "down",
        "late",
        "material",
        "rfq",
      ]);
    });

    test("the brief goes once a day, with what the role needs", async () => {
      send.mockClear();
      const first = await briefs.runBriefs(NOW);
      // The planner has facts to approve; the estimator has no quotes waiting.
      expect(first.sent).toBe(1);
      expect(first.empty).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      const email = send.mock.calls[0]?.[0] as {
        to: string[];
        subject: string;
        html: string;
        text: string;
        headers: Record<string, string>;
      };
      expect(email.to).toEqual(["user_planner@shop.test"]);
      expect(email.subject).toBe("Morning brief, Tue Nov 10: facts to approve");
      expect(email.html).toContain("Approve");
      expect(email.html).toContain("https://app.test/email/act?t=");
      expect(email.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click"
      );
      const again = await briefs.runBriefs(
        new Date(NOW.getTime() + 15 * 60_000)
      );
      expect(again.sent).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    });

    test("alerts: quiet about what was true, then one an hour", async () => {
      const [haas] = await Promise.all([
        database.workCenter.create({ data: { orgId, name: "HAAS" } }),
        database.workCenter.create({ data: { orgId, name: "MAZAK" } }),
      ]);
      await database.calendarDay.create({
        data: {
          orgId,
          workCenterId: haas.id,
          date: new Date("2026-11-11T00:00:00Z"),
          availableHours: 0,
          reason: "spindle",
        },
      });
      send.mockClear();
      const first = await alerts.runAlerts(NOW);
      expect(first.found).toBeGreaterThanOrEqual(1);
      expect(send).not.toHaveBeenCalled();

      // A machine goes down after alerts started: the planner hears.
      await database.calendarDay.create({
        data: {
          orgId,
          workCenterId: haas.id,
          date: new Date("2026-11-12T00:00:00Z"),
          availableHours: 0,
          reason: "spindle",
        },
      });
      const t2 = new Date(NOW.getTime() + 15 * 60_000);
      await alerts.runAlerts(t2);
      expect(send).toHaveBeenCalledTimes(1);
      const email = send.mock.calls[0]?.[0] as {
        to: string[];
        subject: string;
        text: string;
      };
      expect(email.to).toEqual(["user_planner@shop.test"]);
      expect(email.subject).toBe("Takumo: A machine is marked down");
      expect(email.text).toContain("HAAS is down Thu Nov 12 (spindle).");

      // Another one within the hour waits, then comes on its own.
      await database.calendarDay.create({
        data: {
          orgId,
          workCenterId: haas.id,
          date: new Date("2026-11-13T00:00:00Z"),
          availableHours: 0,
        },
      });
      await alerts.runAlerts(new Date(t2.getTime() + 15 * 60_000));
      expect(send).toHaveBeenCalledTimes(1);
      await alerts.runAlerts(new Date(t2.getTime() + 61 * 60_000));
      expect(send).toHaveBeenCalledTimes(2);
      const next = send.mock.calls[1]?.[0] as { text: string };
      expect(next.text).toContain("HAAS is down Fri Nov 13.");
      expect(next.text).not.toContain("Thu Nov 12");
    });
  }
);
