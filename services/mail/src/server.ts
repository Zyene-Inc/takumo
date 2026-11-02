// The SMTP side: accepts mail for our recipient addresses only, keeps the raw
// message in memory (up to the size limit), authenticates it and hands it to
// the app's webhook. The SMTP reply depends on the app's answer, so the sender
// keeps the message (and retries) whenever the app hasn't taken it.
import type { AddressInfo } from "node:net";
import {
  SMTPServer,
  type SMTPServerOptions,
  type SMTPServerSession,
} from "smtp-server";
import { checkAuth, type DnsResolver } from "./auth.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { RateLimiter } from "./rate-limit.js";
import { scanMessage } from "./scan.js";
import { acceptRecipient, MAX_RECIPIENTS } from "./recipients.js";
import type { KeyPair } from "./tls.js";
import { deliver, type SmtpReply } from "./webhook.js";

/** Longest one SMTP session may last, however busy it looks. */
const MAX_SESSION_MS = 10 * 60_000;

export interface ServerDeps {
  now?: () => number;
  /** DNS resolver for SPF/DKIM/DMARC (tests use a fake one). */
  resolver?: DnsResolver;
}

export interface MailServer {
  close(): Promise<void>;
  listen(): Promise<number>;
  /** Installs (or replaces) the STARTTLS certificate. */
  setCertificate(pair: KeyPair): void;
  smtp: SMTPServer;
}

function smtpError(code: number, message: string): Error {
  const error = new Error(message) as Error & { responseCode: number };
  error.responseCode = code;
  return error;
}

/** "::ffff:203.0.113.5" -> "203.0.113.5" */
export function normalizeIp(address: string): string {
  return address.startsWith("::ffff:") && address.includes(".")
    ? address.slice(7)
    : address;
}

export function createMailServer(
  config: Config,
  deps: ServerDeps = {}
): MailServer {
  const { limits } = config;
  const connectionLimiter = new RateLimiter(
    limits.connectionsPerIpPerMinute,
    60_000,
    deps.now
  );
  const messageLimiter = new RateLimiter(
    limits.messagesPerIpPerMinute,
    60_000,
    deps.now
  );
  const openPerIp = new Map<string, number>();
  const counted = new Set<string>();
  let tlsReady = false;

  const sweep = setInterval(() => {
    connectionLimiter.sweep();
    messageLimiter.sweep();
  }, 5 * 60_000);
  sweep.unref();

  const options: SMTPServerOptions = {
    name: config.hostname,
    banner: "Takumo inbound mail",
    logger: false,
    // No AUTH: this is an inbound MX, it never relays. STARTTLS is switched on
    // per connection once a certificate is loaded (see onConnect).
    disabledCommands: ["AUTH", "STARTTLS"],
    hideENHANCEDSTATUSCODES: false,
    disableReverseLookup: true,
    size: config.maxMessageBytes,
    rejectOversized: true,
    maxRecipients: MAX_RECIPIENTS,
    maxClients: limits.maxConnections,
    socketTimeout: limits.socketTimeoutMs,
    closeTimeout: 10_000,

    onConnect(session, callback) {
      const ip = normalizeIp(session.remoteAddress);
      session.disabledCommands = tlsReady ? ["AUTH"] : ["AUTH", "STARTTLS"];
      if (!connectionLimiter.take(ip)) {
        log("connection_rejected", { ip, reason: "rate" });
        return callback(
          smtpError(
            421,
            "Too many connections from your address, try again later"
          )
        );
      }
      const open = openPerIp.get(ip) ?? 0;
      if (open >= limits.maxConnectionsPerIp) {
        log("connection_rejected", { ip, reason: "concurrency" });
        return callback(
          smtpError(421, "Too many open connections from your address")
        );
      }
      openPerIp.set(ip, open + 1);
      counted.add(session.id);
      callback();
    },

    onClose(session) {
      if (!counted.delete(session.id)) {
        return;
      }
      const ip = normalizeIp(session.remoteAddress);
      const open = (openPerIp.get(ip) ?? 1) - 1;
      if (open > 0) {
        openPerIp.set(ip, open);
      } else {
        openPerIp.delete(ip);
      }
    },

    onAuth(_auth, _session, callback) {
      callback(smtpError(502, "Authentication not available"));
    },

    onMailFrom(_address, session, callback) {
      const ip = normalizeIp(session.remoteAddress);
      if (!messageLimiter.take(ip)) {
        log("message_rejected", { ip, reason: "rate" });
        return callback(
          smtpError(450, "Too many messages from your address, try again later")
        );
      }
      callback();
    },

    onRcptTo(address, _session, callback) {
      if (!acceptRecipient(address.address, config.domains)) {
        return callback(smtpError(550, "No such recipient here"));
      }
      callback();
    },

    onData(stream, session, callback) {
      const started = Date.now();
      const chunks: Buffer[] = [];
      let size = 0;
      let oversized = false;
      stream.on("data", (chunk: Buffer) => {
        if (oversized) {
          return;
        }
        size += chunk.length;
        if (size > config.maxMessageBytes) {
          // Stop keeping it; the rest is read and dropped, the reply is 552.
          oversized = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (error) => callback(error));
      stream.on("end", () => {
        const ip = normalizeIp(session.remoteAddress);
        const mailFrom = session.envelope.mailFrom
          ? session.envelope.mailFrom.address
          : "";
        const recipients = session.envelope.rcptTo
          .map((r) => acceptRecipient(r.address, config.domains))
          .filter((r): r is string => r !== null);
        if (oversized || stream.sizeExceeded) {
          log("message", {
            ip,
            from: mailFrom,
            rcpts: recipients,
            size: stream.byteLength,
            result: 552,
            durationMs: Date.now() - started,
          });
          return callback(
            smtpError(552, "Message exceeds fixed maximum message size")
          );
        }
        handleMessage(
          Buffer.concat(chunks, size),
          session,
          ip,
          mailFrom,
          recipients,
          started
        )
          .then((reply) => {
            if (reply.code === 250) {
              callback(null, reply.message);
            } else {
              callback(smtpError(reply.code, reply.message));
            }
          })
          .catch(() =>
            callback(smtpError(451, "Local error, try again later"))
          );
      });
    },
  };

  async function handleMessage(
    raw: Buffer,
    session: SMTPServerSession,
    ip: string,
    mailFrom: string,
    recipients: string[],
    started: number
  ): Promise<{ code: SmtpReply["code"] | 554; message: string }> {
    const helo = session.hostNameAppearsAs || "";
    if (config.scan) {
      const scanned = await scanMessage(config.scan, raw);
      if (scanned.status !== "clean") {
        const infected = scanned.status === "infected";
        log("message", {
          ip,
          helo,
          from: mailFrom,
          rcpts: recipients,
          size: raw.length,
          // The signature name only, never the content.
          ...(infected
            ? { malware: scanned.signature }
            : { scanError: scanned.message }),
          result: infected ? 554 : 451,
          durationMs: Date.now() - started,
        });
        return infected
          ? { code: 554, message: "Message rejected: it contains malware" }
          : {
              code: 451,
              message: "Can't check the message right now, try again later",
            };
      }
    }
    const auth = await checkAuth({
      raw,
      ip,
      helo,
      mailFrom,
      mta: config.hostname,
      resolver: deps.resolver,
    });
    const reply = await deliver(
      {
        url: config.webhookUrl,
        secret: config.secret,
        timeoutMs: limits.webhookTimeoutMs,
        now: deps.now,
      },
      { raw, recipients, mailFrom, remoteIp: ip, auth }
    );
    log("message", {
      ip,
      helo,
      from: mailFrom,
      headerFrom: auth.from,
      rcpts: recipients,
      size: raw.length,
      tls: session.secure,
      auth: {
        spf: auth.spf,
        dkim: auth.dkim,
        dkimDomains: auth.dkimDomains,
        dmarc: auth.dmarc,
      },
      webhookStatus: reply.webhookStatus,
      result: reply.code,
      durationMs: Date.now() - started,
    });
    return reply;
  }

  const smtp = new SMTPServer(options);
  smtp.on("error", (error) => {
    log("smtp_error", { message: error.message });
  });
  // socketTimeout only catches idle sockets; a sender trickling one byte at a
  // time would hold a slot forever. Cap every session's total length.
  smtp.server.on("connection", (socket) => {
    const cap = setTimeout(() => {
      log("connection_closed", { reason: "max_session" });
      socket.destroy();
    }, MAX_SESSION_MS);
    cap.unref();
    socket.once("close", () => clearTimeout(cap));
  });

  return {
    smtp,
    setCertificate(pair) {
      smtp.updateSecureContext({ key: pair.key, cert: pair.cert });
      tlsReady = true;
    },
    listen() {
      return new Promise((resolve, reject) => {
        const server = smtp.server;
        server.once("error", reject);
        smtp.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      clearInterval(sweep);
      return new Promise((resolve) => smtp.close(() => resolve()));
    },
  };
}
