import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.js";

export interface Received {
  body: Buffer;
  headers: IncomingMessage["headers"];
}

export type Handler = (req: Received, res: ServerResponse) => void;

/** A local stand-in for the app's /api/inbound/email. */
export async function mockWebhook(handler: Handler) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const entry = { headers: req.headers, body: Buffer.concat(chunks) };
    received.push(entry);
    handler(entry, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/inbound/email`,
    received,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const SECRET = "test-secret-0123456789abcdef0123456789";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    secret: SECRET,
    webhookUrl: "http://127.0.0.1:9/unused",
    domains: ["in.takumo.test"],
    hostname: "mx.takumo.test",
    maxMessageBytes: 25 * 1024 * 1024,
    port: 0,
    host: "127.0.0.1",
    healthPort: 0,
    healthHost: "127.0.0.1",
    ...overrides,
    limits: {
      maxConnections: 100,
      maxConnectionsPerIp: 10,
      connectionsPerIpPerMinute: 1000,
      messagesPerIpPerMinute: 1000,
      socketTimeoutMs: 10_000,
      webhookTimeoutMs: 5000,
      ...overrides.limits,
    },
  };
}

/** No DNS in tests: every lookup is "not found". */
export function noDns(): Promise<never> {
  const error = new Error("not found") as Error & { code: string };
  error.code = "ENOTFOUND";
  return Promise.reject(error);
}
