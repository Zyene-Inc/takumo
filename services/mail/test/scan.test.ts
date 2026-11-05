import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import nodemailer from "nodemailer";
import { loadConfig } from "../src/config.js";
import { createHealthServer } from "../src/health.js";
import { parseReply, pingScanner, scanMessage } from "../src/scan.js";
import { createMailServer } from "../src/server.js";
import { mockWebhook, noDns, testConfig } from "./helpers.js";

// The EICAR antivirus test string, built from parts so this file itself is
// never mistaken for malware. Real clamd flags it as "Eicar-Test-Signature".
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");

type Behaviour = "clean" | "eicar" | "error" | "silent";

interface FakeClamd {
  close: () => Promise<void>;
  port: number;
  /** The bytes each INSTREAM carried, reassembled from the chunks. */
  streams: Buffer[];
}

/** Decode an INSTREAM body: 4-byte big-endian lengths, 0 ends it. */
function decodeStream(data: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let at = 0;
  while (at + 4 <= data.length) {
    const size = data.readUInt32BE(at);
    at += 4;
    if (size === 0) {
      return Buffer.concat(parts);
    }
    if (at + size > data.length) {
      return null;
    }
    parts.push(data.subarray(at, at + size));
    at += size;
  }
  return null;
}

/** A stand-in for clamd: answers PING and INSTREAM like the real one. */
async function fakeClamd(behaviour: Behaviour): Promise<FakeClamd> {
  const streams: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.subarray(0, 6).toString() === "zPING\0") {
        socket.end("PONG\0");
        return;
      }
      const command = "zINSTREAM\0";
      if (buffer.subarray(0, command.length).toString() !== command) {
        return;
      }
      const body = decodeStream(buffer.subarray(command.length));
      if (!body) {
        return; // wait for the rest
      }
      streams.push(body);
      if (behaviour === "silent") {
        return; // never answers: the client must time out
      }
      if (behaviour === "error") {
        socket.end("INSTREAM size limit exceeded. ERROR\0");
        return;
      }
      const infected =
        behaviour === "eicar" && body.toString("latin1").includes(EICAR);
      socket.end(
        infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    streams,
    close: () => {
      for (const s of sockets) {
        s.destroy();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const scanConfig = (port: number, timeoutMs = 2000) => ({
  host: "127.0.0.1",
  port,
  timeoutMs,
});

test("parseReply reads clamd's answers", () => {
  assert.deepEqual(parseReply("stream: OK\0"), { status: "clean" });
  assert.deepEqual(parseReply("stream: Win.Trojan.X-1 FOUND\0"), {
    status: "infected",
    signature: "Win.Trojan.X-1",
  });
  assert.equal(
    parseReply("INSTREAM size limit exceeded. ERROR").status,
    "error"
  );
  assert.equal(parseReply("").status, "error");
});

test("clean message: streamed in chunks, byte for byte", async () => {
  const clamd = await fakeClamd("clean");
  after(() => clamd.close());
  // Bigger than one 64 KB chunk, so the chunking is exercised.
  const raw = Buffer.alloc(200 * 1024, "a");
  const result = await scanMessage(scanConfig(clamd.port), raw);
  assert.deepEqual(result, { status: "clean" });
  assert.ok(clamd.streams[0]?.equals(raw));
});

test("infected message: the signature name comes back", async () => {
  const clamd = await fakeClamd("eicar");
  after(() => clamd.close());
  const result = await scanMessage(
    scanConfig(clamd.port),
    Buffer.from(`Subject: hi\r\n\r\n${EICAR}\r\n`)
  );
  assert.deepEqual(result, {
    status: "infected",
    signature: "Eicar-Test-Signature",
  });
});

test("an error reply, a timeout and no scanner are all errors", async () => {
  const failing = await fakeClamd("error");
  const silent = await fakeClamd("silent");
  after(() => Promise.all([failing.close(), silent.close()]));
  const raw = Buffer.from("x");
  assert.equal(
    (await scanMessage(scanConfig(failing.port), raw)).status,
    "error"
  );
  const timedOut = await scanMessage(scanConfig(silent.port, 200), raw);
  assert.equal(timedOut.status, "error");
  assert.match(
    timedOut.status === "error" ? timedOut.message : "",
    /timed out/
  );
  // Nothing listens on port 9 (discard) on loopback in CI.
  assert.equal((await scanMessage(scanConfig(9), raw)).status, "error");
});

test("ping: up and down", async () => {
  const clamd = await fakeClamd("clean");
  after(() => clamd.close());
  assert.equal(await pingScanner(scanConfig(clamd.port)), true);
  assert.equal(await pingScanner(scanConfig(9, 300)), false);
});

test("config: scanning is off without CLAMD_HOST, on with it", () => {
  const base = {
    INBOUND_EMAIL_SECRET: "s".repeat(40),
    WEBHOOK_URL: "https://app.example/api/inbound/email",
    MAIL_DOMAINS: "in.takumo.test",
  };
  assert.equal(loadConfig(base).scan, undefined);
  assert.deepEqual(loadConfig({ ...base, CLAMD_HOST: "clamd" }).scan, {
    host: "clamd",
    port: 3310,
    timeoutMs: 30_000,
  });
  assert.throws(() =>
    loadConfig({ ...base, CLAMD_HOST: "clamd", CLAMD_PORT: "x" })
  );
});

/** SMTP end to end against a fake clamd. */
async function startMail(behaviour: Behaviour | "down") {
  const hook = await mockWebhook((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const clamd = behaviour === "down" ? null : await fakeClamd(behaviour);
  const mail = createMailServer(
    testConfig({
      webhookUrl: hook.url,
      scan: scanConfig(clamd?.port ?? 9, 500),
    }),
    { resolver: noDns }
  );
  const port = await mail.listen();
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
  });
  const stop = async () => {
    transport.close();
    await mail.close();
    await hook.close();
    await clamd?.close();
  };
  return { hook, transport, stop };
}

const message = (body: string) => ({
  envelope: { from: "a@shop.example", to: ["rfq-abcd1234@in.takumo.test"] },
  raw: `From: a@shop.example\r\nTo: rfq-abcd1234@in.takumo.test\r\nSubject: RFQ\r\n\r\n${body}\r\n`,
});

test("SMTP: clean mail reaches the app", async () => {
  const { hook, transport, stop } = await startMail("clean");
  after(stop);
  const info = await transport.sendMail(message("Please quote 10 pcs."));
  assert.match(info.response, /^250 /);
  assert.equal(hook.received.length, 1);
});

test("SMTP: malware is refused with 554 and never reaches the app", async () => {
  const { hook, transport, stop } = await startMail("eicar");
  after(stop);
  await assert.rejects(
    transport.sendMail(message(EICAR)),
    (error: { responseCode?: number; response?: string }) => {
      assert.equal(error.responseCode, 554);
      assert.match(String(error.response), /malware/);
      return true;
    }
  );
  assert.equal(hook.received.length, 0);
});

test("SMTP: scanner down -> 451, so the sender retries later", async () => {
  const { hook, transport, stop } = await startMail("down");
  after(stop);
  await assert.rejects(
    transport.sendMail(message("Please quote.")),
    (error: { responseCode?: number }) => error.responseCode === 451
  );
  assert.equal(hook.received.length, 0);
});

test("health reports the scanner", async () => {
  const states = ["ok", "unreachable"] as const;
  for (const state of states) {
    const health = createHealthServer(() => Promise.resolve(state));
    health.listen(0, "127.0.0.1");
    await once(health, "listening");
    const { port } = health.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, state === "ok" ? 200 : 503);
    assert.equal(((await res.json()) as { scanner: string }).scanner, state);
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }
});
