// @vitest-environment node
// Notes by text against a real database (F6.1): a phone is registered and
// confirmed with the code texted to it; only confirmed phones are listened
// to; an unknown number leaves nothing behind; Twilio's retries are read
// once; a note gets a reply counting its facts. Runs only with
// TEST_DATABASE_URL (a disposable database with the migrations applied).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sent: { to: string; channel: string; body: string }[] = [];
vi.mock("../lib/phone/client", () => ({
  phoneConfigured: () => true,
  sendText: (m: { to: string; channel: string; body: string }) => {
    sent.push(m);
    return Promise.resolve(true);
  },
  fetchMedia: async () => new Uint8Array([1, 2, 3]),
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));
vi.mock("../lib/facts/transcribe", () => ({
  shopVocabulary: async () => [],
  transcribeAudio: async () => ({
    text: "setup on the haas for P-1 is two hours",
    durationSec: 7,
  }),
}));
// No AI in tests: the note is saved as the real pipeline would, with one fact.
const saveNote = vi.fn();
vi.mock("../lib/facts/notes", () => ({
  saveNote: (...args: unknown[]) => saveNote(...args),
}));

type Register = typeof import("../lib/phone/register");
type Inbound = typeof import("../lib/phone/inbound");
type Db = typeof import("@repo/database");

const CODE = /^(\d{6})/;
const SIX_DIGITS = /^\d{6}$/;
const lastCode = () => sent.at(-1)?.body.match(CODE)?.[1] ?? "";

describe.skipIf(!TEST_DATABASE_URL)("notes by text (database)", () => {
  const orgId = `org_phone_${randomUUID().slice(0, 8)}`;
  const otherOrg = `org_phone_${randomUUID().slice(0, 8)}`;
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  let database: Db["database"];
  let reg: Register;
  let inbound: Inbound;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ database } = await import("@repo/database"));
    reg = await import("../lib/phone/register");
    inbound = await import("../lib/phone/inbound");
    await database.org.createMany({
      data: [
        { id: orgId, name: "Phone test" },
        { id: otherOrg, name: "Other shop" },
      ],
    });
    saveNote.mockImplementation(
      async (org: string, _user: string, note: { text: string }) => {
        const n = await database.note.create({
          data: { orgId: org, kind: "voice", text: note.text, status: "done" },
        });
        return { noteId: n.id, proposed: ["F-1"], skipped: [] };
      }
    );
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { in: [orgId, otherOrg] } },
    });
  });

  const message = (
    sid: string,
    extra: Partial<Record<string, unknown>> = {}
  ) => ({
    sid,
    body: "",
    media: { url: "https://api.twilio.com/m/1", contentType: "audio/ogg" },
    hasOtherMedia: false,
    ...extra,
  });

  test("an unknown number is ignored and nothing is stored", async () => {
    const before = await database.phoneMessage.count();
    expect(
      await inbound.receivePhoneMessage(
        { phone: "+15559990000", channel: "sms" },
        message(`SM-unknown-${randomUUID()}`)
      )
    ).toBeNull();
    expect(await database.phoneMessage.count()).toBe(before);
    expect(sent).toHaveLength(0);
  });

  let id = "";

  test("registering texts a code; a wrong code doesn't confirm", async () => {
    const r = await reg.registerPhone(orgId, {
      phone,
      name: "Sam",
      addedBy: "user_admin",
    });
    expect(r.ok).toBe(true);
    id = r.ok ? r.id : "";
    expect(sent.at(-1)).toMatchObject({ to: phone, channel: "sms" });
    expect(lastCode()).toMatch(SIX_DIGITS);
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    expect((await reg.confirmPhone(orgId, id, wrong)).ok).toBe(false);
    const row = await database.phoneNumber.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(1);
    expect(row.verifiedAt).toBeNull();
    expect(row.codeHash).not.toContain(lastCode());
  });

  test("an unconfirmed phone isn't listened to", async () => {
    expect(
      await inbound.receivePhoneMessage(
        { phone, channel: "sms" },
        message(`SM-early-${randomUUID()}`)
      )
    ).toBeNull();
  });

  test("a second code within a minute is refused", async () => {
    const again = await reg.sendCode(orgId, id);
    expect(again).toMatchObject({ ok: false });
  });

  test("the right code confirms it", async () => {
    const code = lastCode();
    expect(await reg.confirmPhone(orgId, id, code)).toEqual({ ok: true });
    const row = await database.phoneNumber.findUniqueOrThrow({ where: { id } });
    expect(row.verifiedAt).not.toBeNull();
    expect(row.codeHash).toBeNull();
  });

  test("another shop can't confirm the same phone", async () => {
    const r = await reg.registerPhone(otherOrg, {
      phone,
      name: "Sam elsewhere",
      addedBy: "user_other",
    });
    expect(r.ok).toBe(true);
    const otherId = r.ok ? r.id : "";
    const result = await reg.confirmPhone(otherOrg, otherId, lastCode());
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("another shop"),
    });
  });

  test("a voice note becomes a note and gets a reply; a retry is read once", async () => {
    const sid = `MM-${randomUUID()}`;
    const accepted = await inbound.receivePhoneMessage(
      { phone, channel: "whatsapp" },
      message(sid)
    );
    expect(accepted).toMatchObject({ orgId, channel: "whatsapp" });
    expect(
      await inbound.receivePhoneMessage(
        { phone, channel: "whatsapp" },
        message(sid)
      )
    ).toBeNull();
    if (!accepted) {
      return;
    }
    await inbound.processPhoneMessage(accepted, message(sid));
    expect(saveNote).toHaveBeenCalledWith(
      orgId,
      `phone:${id}`,
      expect.objectContaining({
        kind: "voice",
        source: "voice",
        channel: "whatsapp",
        senderName: "Sam",
        text: "setup on the haas for P-1 is two hours",
      })
    );
    expect(sent.at(-1)).toEqual({
      to: phone,
      channel: "whatsapp",
      body: "Got it: 1 fact for your supervisor to review (F-1).",
    });
    const row = await database.phoneMessage.findUniqueOrThrow({
      where: { sid },
    });
    expect(row.status).toBe("processed");
    expect(row.noteId).not.toBeNull();
  });

  test("a photo alone gets pointed at the documents address", async () => {
    const sid = `MM-${randomUUID()}`;
    const photo = message(sid, { media: null, hasOtherMedia: true });
    const accepted = await inbound.receivePhoneMessage(
      { phone, channel: "sms" },
      photo
    );
    expect(accepted).not.toBeNull();
    if (accepted) {
      await inbound.processPhoneMessage(accepted, photo);
    }
    expect(sent.at(-1)?.body).toContain("documents address");
  });
});
