// Malware scanning with ClamAV's clamd, over its INSTREAM protocol: the
// message goes in length-prefixed chunks, clamd answers one line. No
// dependency: it's a few lines of TCP.
import { connect } from "node:net";

export interface ScanConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export type ScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "error"; message: string };

/** clamd's default StreamMaxLength is 25 MB; chunks well under that. */
const CHUNK_BYTES = 64 * 1024;
const FOUND = /^stream: (.+) FOUND$/;

/** One clamd reply line, e.g. "stream: OK" or "stream: Eicar-Signature FOUND". */
export function parseReply(reply: string): ScanResult {
  const line = reply.replace(/\0/g, "").trim();
  if (line === "stream: OK") {
    return { status: "clean" };
  }
  const found = FOUND.exec(line);
  if (found) {
    return { status: "infected", signature: found[1] ?? "unknown" };
  }
  return { status: "error", message: line || "empty reply" };
}

/** Send one command and read until clamd closes the connection. */
function talk(
  config: ScanConfig,
  write: (send: (data: Buffer) => void) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, reply?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(reply ?? "");
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`scanner timed out after ${config.timeoutMs} ms`)),
      config.timeoutMs
    );
    socket.on("connect", () => write((data) => socket.write(data)));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () =>
      finish(null, Buffer.concat(chunks).toString("utf8"))
    );
    socket.on("error", (error) => finish(error));
  });
}

/** Scan a whole message. Never throws: problems come back as "error". */
export async function scanMessage(
  config: ScanConfig,
  raw: Buffer
): Promise<ScanResult> {
  try {
    const reply = await talk(config, (send) => {
      send(Buffer.from("zINSTREAM\0"));
      for (let at = 0; at < raw.length; at += CHUNK_BYTES) {
        const chunk = raw.subarray(at, Math.min(raw.length, at + CHUNK_BYTES));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        send(size);
        send(chunk);
      }
      send(Buffer.alloc(4)); // zero length: end of stream
    });
    return parseReply(reply);
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
}

/** Is clamd up? (PING -> PONG) */
export async function pingScanner(config: ScanConfig): Promise<boolean> {
  try {
    const reply = await talk(config, (send) => send(Buffer.from("zPING\0")));
    return reply.replace(/\0/g, "").trim() === "PONG";
  } catch {
    return false;
  }
}
