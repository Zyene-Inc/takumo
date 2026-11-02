import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { after, test } from "node:test";
import nodemailer from "nodemailer";
import type { Config } from "../src/config.js";
import { createHealthServer } from "../src/health.js";
import { createMailServer } from "../src/server.js";
import { sign } from "../src/signature.js";
import {
  type Handler,
  mockWebhook,
  noDns,
  SECRET,
  testConfig,
} from "./helpers.js";

// CRLF line endings, a line starting with a dot (dot-stuffed on the wire),
// 8-bit bytes and trailing whitespace: all must reach the webhook unchanged.
const RAW = Buffer.concat([
  Buffer.from(
    "From: Shop ERP <Reports@Shop.Example>\r\n" +
      "To: erp-abcd1234@in.takumo.test\r\n" +
      "Subject: Nightly open jobs\r\n" +
      "Message-ID: <1@shop.example>\r\n" +
      "Date: Mon, 02 Nov 2026 03:00:00 +0000\r\n" +
      "MIME-Version: 1.0\r\n" +
      "Content-Type: text/plain; charset=iso-8859-1\r\n" +
      "Content-Transfer-Encoding: 8bit\r\n" +
      "\r\n" +
      "Job,Qty  \r\n" +
      ".hidden line\r\n" +
      "..two dots\r\n"
  ),
  Buffer.from([0xe9, 0x0d, 0x0a]),
]);

async function startServer(handler: Handler, overrides: Partial<Config> = {}) {
  const hook = await mockWebhook(handler);
  const mail = createMailServer(
    testConfig({ webhookUrl: hook.url, ...overrides }),
    {
      resolver: noDns,
    }
  );
  const port = await mail.listen();
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    name: "client.shop.example",
  });
  const stop = async () => {
    transport.close();
    await mail.close();
    await hook.close();
  };
  return { hook, port, transport, stop };
}

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

test("end to end: raw bytes and a valid signature reach the webhook", async () => {
  const { hook, transport, stop } = await startServer(ok);
  after(stop);

  const info = await transport.sendMail({
    envelope: {
      from: "bounces@shop.example",
      to: [
        "ERP-ABCD1234@in.takumo.test",
        "postmaster@in.takumo.test",
        "rfq-zz99yy88xx@IN.takumo.test",
      ],
    },
    raw: RAW,
  });
  assert.match(info.response, /^250 /);
  assert.deepEqual(info.rejected, ["postmaster@in.takumo.test"]);

  assert.equal(hook.received.length, 1);
  const { headers, body } = hook.received[0]!;
  assert.ok(body.equals(RAW), "body differs from the message sent");
  assert.equal(headers["content-type"], "message/rfc822");
  assert.equal(
    headers["x-takumo-recipients"],
    "erp-abcd1234@in.takumo.test,rfq-zz99yy88xx@in.takumo.test"
  );
  assert.equal(headers["x-takumo-mail-from"], "bounces@shop.example");
  assert.equal(headers["x-takumo-remote-ip"], "127.0.0.1");

  const timestamp = String(headers["x-takumo-timestamp"]);
  assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 60);
  const expected = sign(
    SECRET,
    {
      timestamp,
      recipients: String(headers["x-takumo-recipients"]),
      mailFrom: String(headers["x-takumo-mail-from"]),
    },
    body
  );
  assert.equal(headers["x-takumo-signature"], expected);
  assert.match(expected, /^[0-9a-f]{64}$/);

  const auth = JSON.parse(String(headers["x-takumo-auth"]));
  assert.deepEqual(Object.keys(auth), [
    "spf",
    "dkim",
    "dkimDomains",
    "dmarc",
    "from",
  ]);
  assert.equal(auth.dkim, "none");
  assert.deepEqual(auth.dkimDomains, []);
  assert.equal(auth.from.toLowerCase(), "reports@shop.example");
  assert.ok(["none", "temperror"].includes(auth.spf), auth.spf);
});

test("unknown recipients only: 550 5.1.1 and no webhook call", async () => {
  const { hook, transport, stop } = await startServer(ok);
  after(stop);
  await assert.rejects(
    transport.sendMail({
      envelope: { from: "a@shop.example", to: ["erp-abcd1234@other.test"] },
      raw: RAW,
    }),
    (error: { responseCode?: number; response?: string }) => {
      assert.equal(error.responseCode, 550);
      assert.match(String(error.response), /5\.1\.1/);
      return true;
    }
  );
  assert.equal(hook.received.length, 0);
});

test("webhook 4xx -> 550 with the app's error text", async () => {
  const { transport, stop } = await startServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"Unknown inbox address"}');
  });
  after(stop);
  await assert.rejects(
    transport.sendMail({
      envelope: { from: "a@shop.example", to: ["erp-abcd1234@in.takumo.test"] },
      raw: RAW,
    }),
    (error: { responseCode?: number; response?: string }) => {
      assert.equal(error.responseCode, 550);
      assert.match(String(error.response), /Unknown inbox address/);
      return true;
    }
  );
});

test("webhook 5xx -> 451 (sender retries)", async () => {
  const { transport, stop } = await startServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  after(stop);
  await assert.rejects(
    transport.sendMail({
      envelope: { from: "", to: ["docs-abcd1234@in.takumo.test"] },
      raw: RAW,
    }),
    (error: { responseCode?: number }) => error.responseCode === 451
  );
});

test("size limit: 552 and the webhook is not called", async () => {
  const { hook, transport, stop } = await startServer(ok, {
    maxMessageBytes: 2048,
  });
  after(stop);
  const big = Buffer.concat([
    RAW,
    Buffer.from(`${"x".repeat(76)}\r\n`.repeat(100)),
  ]);
  await assert.rejects(
    transport.sendMail({
      envelope: { from: "a@shop.example", to: ["ask-abcd1234@in.takumo.test"] },
      raw: big,
    }),
    (error: { responseCode?: number }) => error.responseCode === 552
  );
  assert.equal(hook.received.length, 0);
});

/** A minimal SMTP conversation over a raw socket. */
async function converse(port: number, lines: string[]): Promise<string[]> {
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  const replies: string[] = [];
  let buffer = "";
  const next = () =>
    new Promise<string>((resolve) => {
      const check = () => {
        // A complete reply ends with a line "NNN text" (space after the code).
        const match = buffer.match(/^(?:\d{3}-.*\r\n)*\d{3} .*\r\n/);
        if (match) {
          buffer = buffer.slice(match[0].length);
          socket.off("data", onData);
          resolve(match[0]);
        }
      };
      const onData = (chunk: string) => {
        buffer += chunk;
        check();
      };
      socket.on("data", onData);
      check();
    });
  replies.push(await next()); // greeting
  for (const line of lines) {
    socket.write(`${line}\r\n`);
    replies.push(await next());
  }
  socket.end();
  return replies;
}

test("SIZE limit is enforced while streaming, even if the client didn't declare it", async () => {
  const { hook, port, stop } = await startServer(ok, { maxMessageBytes: 1024 });
  after(stop);
  const body = `Subject: big\r\n\r\n${"y".repeat(78)}\r\n`.repeat(40);
  const replies = await converse(port, [
    "EHLO client.test",
    "MAIL FROM:<a@shop.example>",
    "RCPT TO:<erp-abcd1234@in.takumo.test>",
    "DATA",
    `${body}.`,
  ]);
  assert.match(replies[4]!, /^354/);
  assert.match(replies[5]!, /^552/);
  assert.equal(hook.received.length, 0);
});

test("no AUTH (not advertised, rejected) and no relaying", async () => {
  const { port, stop } = await startServer(ok);
  after(stop);
  const replies = await converse(port, [
    "EHLO client.test",
    "AUTH PLAIN AGZvbwBiYXI=",
    "MAIL FROM:<a@shop.example>",
    "RCPT TO:<someone@gmail.com>",
  ]);
  assert.doesNotMatch(replies[1]!, /AUTH/);
  assert.doesNotMatch(replies[1]!, /STARTTLS/); // no certificate configured
  assert.match(replies[1]!, /SIZE 26214400/);
  assert.match(replies[2]!, /^5\d\d/);
  assert.match(replies[3]!, /^250/);
  assert.match(replies[4]!, /^550 5\.1\.1/);
});

test("more than 20 recipients: the rest get 452", async () => {
  const { port, stop } = await startServer(ok);
  after(stop);
  const rcpts = Array.from(
    { length: 21 },
    (_, i) => `RCPT TO:<erp-abcd12${String(i).padStart(2, "0")}@in.takumo.test>`
  );
  const replies = await converse(port, [
    "EHLO client.test",
    "MAIL FROM:<a@shop.example>",
    ...rcpts,
  ]);
  assert.match(replies[22]!, /^250/);
  assert.match(replies[23]!, /^452/);
});

test("per-IP message rate limit -> 450", async () => {
  const { port, stop } = await startServer(ok, {
    limits: { ...testConfig().limits, messagesPerIpPerMinute: 1 },
  });
  after(stop);
  const replies = await converse(port, [
    "EHLO client.test",
    "MAIL FROM:<a@shop.example>",
    "RSET",
    "MAIL FROM:<a@shop.example>",
  ]);
  assert.match(replies[2]!, /^250/);
  assert.match(replies[4]!, /^450/);
});

test("per-IP connection rate limit -> 421 on connect", async () => {
  const { port, stop } = await startServer(ok, {
    limits: { ...testConfig().limits, connectionsPerIpPerMinute: 1 },
  });
  after(stop);
  assert.match((await converse(port, ["QUIT"]))[0]!, /^220/);
  assert.match((await converse(port, []))[0]!, /^421/);
});

test("health endpoint", async () => {
  const health = createHealthServer();
  health.listen(0, "127.0.0.1");
  await once(health, "listening");
  after(() => health.close());
  const { port } = health.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", scanner: "off" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
});
