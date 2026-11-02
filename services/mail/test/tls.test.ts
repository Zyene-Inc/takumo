import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { createMailServer } from "../src/server.js";
import { CertificateWatcher } from "../src/tls.js";
import { mockWebhook, noDns, testConfig } from "./helpers.js";

// Compiled tests run from dist-test/test; the fixtures stay in test/fixtures.
const fixtures = fileURLToPath(
  new URL("../../test/fixtures/", import.meta.url)
);
const fingerprint = (name: string) =>
  new X509Certificate(readFileSync(join(fixtures, `${name}.crt`)))
    .fingerprint256;

test("STARTTLS appears when the certificate files do, and follows renewals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takumo-mail-tls-"));
  const certFile = join(dir, "mx.crt");
  const keyFile = join(dir, "mx.key");
  const hook = await mockWebhook((_req, res) => {
    res.writeHead(202);
    res.end();
  });
  const mail = createMailServer(testConfig({ webhookUrl: hook.url }), {
    resolver: noDns,
  });
  const port = await mail.listen();
  const warnings: string[] = [];
  const watcher = new CertificateWatcher(
    certFile,
    keyFile,
    (pair) => mail.setCertificate(pair),
    (m) => warnings.push(m)
  );
  after(async () => {
    await mail.close();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Send a message over STARTTLS (nodemailer refuses to go on without it).
  const send = async () => {
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: false },
    });
    try {
      await transport.sendMail({
        envelope: {
          from: "a@shop.example",
          to: ["erp-abcd1234@in.takumo.test"],
        },
        raw: "Subject: t\r\n\r\nx\r\n",
      });
    } finally {
      transport.close();
    }
  };

  // The certificate the server presents after STARTTLS (sha256 fingerprint).
  const presented = async () => {
    const socket = connect(port, "127.0.0.1");
    socket.setEncoding("utf8");
    let buffer = "";
    const reply = () =>
      new Promise<string>((resolve) => {
        const check = () => {
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
    await reply();
    socket.write("EHLO client.test\r\n");
    assert.match(await reply(), /STARTTLS/);
    socket.write("STARTTLS\r\n");
    assert.match(await reply(), /^220/);
    const secure = tlsConnect({
      socket,
      rejectUnauthorized: false,
      servername: "mx.takumo.test",
    });
    await once(secure, "secureConnect");
    const fp = secure.getPeerX509Certificate()?.fingerprint256;
    secure.destroy();
    return fp;
  };

  // No files yet: no STARTTLS, so requireTLS fails.
  assert.equal(watcher.check(), false);
  assert.equal(warnings.length, 1);
  await assert.rejects(send());

  copyFileSync(join(fixtures, "test-a.crt"), certFile);
  copyFileSync(join(fixtures, "test-a.key"), keyFile);
  assert.equal(watcher.check(), true);
  assert.equal(
    new X509Certificate(watcher.current!.cert).fingerprint256,
    fingerprint("test-a")
  );
  assert.equal(await presented(), fingerprint("test-a"));
  await send();
  assert.equal(hook.received.length, 1);
  assert.equal(watcher.check(), false, "unchanged files are not reloaded");

  // A half-written renewal (new cert, old key) is refused and the old pair kept.
  copyFileSync(join(fixtures, "test-b.crt"), certFile);
  utimesSync(certFile, new Date(), new Date(Date.now() + 5000));
  assert.equal(watcher.check(), false);
  assert.equal(
    new X509Certificate(watcher.current!.cert).fingerprint256,
    fingerprint("test-a")
  );

  copyFileSync(join(fixtures, "test-b.key"), keyFile);
  utimesSync(keyFile, new Date(), new Date(Date.now() + 5000));
  assert.equal(watcher.check(), true);
  assert.equal(
    new X509Certificate(watcher.current!.cert).fingerprint256,
    fingerprint("test-b")
  );
  assert.equal(await presented(), fingerprint("test-b"));
  await send();
  assert.equal(hook.received.length, 2);
});
