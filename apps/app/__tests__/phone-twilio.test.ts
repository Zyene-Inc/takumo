// @vitest-environment node
// Notes by text (F6.1): Twilio's signature, phone numbers, the parts of a
// message, confirmation codes and the reply. Pure, no network.
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  CODE_TTL_MS,
  checkCode,
  displayPhone,
  hashCode,
  MAX_CODE_ATTEMPTS,
  newCode,
  normalizePhone,
  readInbound,
  replyText,
  senderOf,
  twilioSignature,
  verifyTwilioSignature,
} from "../lib/phone/twilio";

const TOKEN = "12345678901234567890123456789012";
const URL = "https://app.example.com/api/twilio";
const SIX_DIGITS = /^\d{6}$/;

describe("Twilio signature", () => {
  // Twilio's documented example: URL + params sorted by name, HMAC-SHA1.
  test("matches the documented algorithm", () => {
    const params: [string, string][] = [
      ["To", "+15550001111"],
      ["From", "+15552223333"],
      ["Body", "setup on the haas is 2 hours"],
      ["MessageSid", "SM1"],
    ];
    const expected = createHmac("sha1", TOKEN)
      .update(
        `${URL}Bodysetup on the haas is 2 hoursFrom+15552223333MessageSidSM1To+15550001111`
      )
      .digest("base64");
    expect(twilioSignature(TOKEN, URL, params)).toBe(expected);
  });

  test("verifies a good signature and refuses others", () => {
    const params: [string, string][] = [
      ["From", "+15552223333"],
      ["Body", "hi"],
    ];
    const signature = twilioSignature(TOKEN, URL, params);
    expect(
      verifyTwilioSignature({ authToken: TOKEN, url: URL, params, signature })
    ).toBe(true);
    // Another body, another URL, another token, or no signature at all.
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL,
        params: [
          ["From", "+15552223333"],
          ["Body", "hi!"],
        ],
        signature,
      })
    ).toBe(false);
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: `${URL}?x=1`,
        params,
        signature,
      })
    ).toBe(false);
    expect(
      verifyTwilioSignature({
        authToken: `${TOKEN}x`,
        url: URL,
        params,
        signature,
      })
    ).toBe(false);
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL,
        params,
        signature: null,
      })
    ).toBe(false);
  });
});

describe("phone numbers", () => {
  test("normalises to E.164", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("0044 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("whatsapp:+15551234567")).toBe("+15551234567");
  });

  test("refuses what can't be a number", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("+0123456789")).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
  });

  test("shows US numbers readably", () => {
    expect(displayPhone("+15551234567")).toBe("+1 555-123-4567");
    expect(displayPhone("+447700900123")).toBe("+447700900123");
  });

  test("tells SMS from WhatsApp", () => {
    expect(senderOf("+15551234567")).toEqual({
      phone: "+15551234567",
      channel: "sms",
    });
    expect(senderOf("whatsapp:+15551234567")).toEqual({
      phone: "+15551234567",
      channel: "whatsapp",
    });
    expect(senderOf(null)).toBeNull();
  });
});

describe("inbound message", () => {
  test("a voice note: the first audio file", () => {
    const m = readInbound(
      new Map([
        ["MessageSid", "MM1"],
        ["Body", ""],
        ["NumMedia", "2"],
        ["MediaUrl0", "https://api.twilio.com/m/0"],
        ["MediaContentType0", "image/jpeg"],
        ["MediaUrl1", "https://api.twilio.com/m/1"],
        ["MediaContentType1", "audio/ogg"],
      ])
    );
    expect(m).toEqual({
      sid: "MM1",
      body: "",
      media: { url: "https://api.twilio.com/m/1", contentType: "audio/ogg" },
      hasOtherMedia: true,
    });
  });

  test("a text, and nothing without a message id", () => {
    expect(
      readInbound(
        new Map([
          ["MessageSid", "SM2"],
          ["Body", " op 20 ok "],
        ])
      )
    ).toEqual({
      sid: "SM2",
      body: "op 20 ok",
      media: null,
      hasOtherMedia: false,
    });
    expect(readInbound(new Map([["Body", "hi"]]))).toBeNull();
  });
});

describe("confirmation codes", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const entry = (code: string, over = {}) => ({
    id: "p1",
    codeHash: hashCode("p1", code),
    codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    ...over,
  });

  test("six digits", () => {
    for (let i = 0; i < 20; i++) {
      expect(newCode()).toMatch(SIX_DIGITS);
    }
  });

  test("the right code, in time, confirms", () => {
    expect(checkCode(entry("123456"), "123456", now)).toEqual({ ok: true });
    expect(checkCode(entry("123456"), " 123456 ", now)).toEqual({ ok: true });
  });

  test("a wrong, expired or spent code doesn't", () => {
    expect(checkCode(entry("123456"), "654321", now).ok).toBe(false);
    expect(
      checkCode(
        entry("123456", { codeExpiresAt: new Date(now.getTime() - 1) }),
        "123456",
        now
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(
      checkCode(entry("123456", { attempts: MAX_CODE_ATTEMPTS }), "123456", now)
    ).toMatchObject({ ok: false, spent: true });
    expect(checkCode({ ...entry("1"), codeHash: null }, "123456", now).ok).toBe(
      false
    );
  });

  test("the code is bound to its registration", () => {
    expect(checkCode({ ...entry("123456"), id: "p2" }, "123456", now).ok).toBe(
      false
    );
  });
});

describe("reply", () => {
  test("counts the facts for review", () => {
    expect(replyText({ failed: false, proposed: ["F-12", "F-13"] })).toBe(
      "Got it: 2 facts for your supervisor to review (F-12, F-13)."
    );
    expect(replyText({ failed: false, proposed: ["F-1"] })).toContain(
      "1 fact for"
    );
  });

  test("says when there was nothing, or it couldn't be read", () => {
    expect(replyText({ failed: false, proposed: [] })).toContain(
      "Saved as a note"
    );
    expect(replyText({ failed: true, proposed: [] })).toContain(
      "couldn't read it"
    );
  });
});
