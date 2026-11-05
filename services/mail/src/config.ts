// Configuration from the environment. Everything is checked at startup, so the
// receiver never runs half-configured (for example without a webhook secret).
import { hostname } from "node:os";
import type { ScanConfig } from "./scan.js";

export interface Limits {
  /** New connections per IP per minute (token bucket, burst = the same number). */
  connectionsPerIpPerMinute: number;
  /** Concurrent SMTP connections, all clients together. */
  maxConnections: number;
  /** Concurrent SMTP connections from one IP address. */
  maxConnectionsPerIp: number;
  /** Messages (MAIL FROM commands) per IP per minute (token bucket). */
  messagesPerIpPerMinute: number;
  /** Idle time before the server drops a connection. */
  socketTimeoutMs: number;
  /** How long the app has to answer the webhook. */
  webhookTimeoutMs: number;
}

export interface Config {
  domains: string[];
  healthHost: string;
  healthPort: number;
  host: string;
  hostname: string;
  limits: Limits;
  maxMessageBytes: number;
  port: number;
  /** clamd, when CLAMD_HOST is set; otherwise messages aren't scanned. */
  scan?: ScanConfig;
  secret: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  webhookUrl: string;
}

const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Env = Record<string, string | undefined>;

function intFrom(
  env: Env,
  name: string,
  fallback: number,
  errors: string[],
  min = 1
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${name} must be an integer >= ${min}`);
    return fallback;
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];

  const secret = env.INBOUND_EMAIL_SECRET ?? "";
  if (secret.length < 32) {
    errors.push(
      "INBOUND_EMAIL_SECRET is required and must be at least 32 characters"
    );
  }

  const webhookUrl = env.WEBHOOK_URL?.trim() ?? "";
  try {
    if (new URL(webhookUrl).protocol !== "https:") {
      errors.push("WEBHOOK_URL must be an https:// URL");
    }
  } catch {
    errors.push("WEBHOOK_URL is required (https://...)");
  }

  const domains = (env.MAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) {
    errors.push("MAIL_DOMAINS is required (comma-separated domains)");
  }
  for (const d of domains) {
    if (!DOMAIN.test(d)) {
      errors.push(`MAIL_DOMAINS: "${d}" is not a domain name`);
    }
  }

  const tlsCertFile = env.TLS_CERT_FILE?.trim() || undefined;
  const tlsKeyFile = env.TLS_KEY_FILE?.trim() || undefined;
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    errors.push("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");
  }

  const clamdHost = env.CLAMD_HOST?.trim() || undefined;
  const scan: ScanConfig | undefined = clamdHost
    ? {
        host: clamdHost,
        port: intFrom(env, "CLAMD_PORT", 3310, errors),
        timeoutMs: intFrom(env, "SCAN_TIMEOUT_MS", 30_000, errors),
      }
    : undefined;

  const config: Config = {
    scan,
    secret,
    webhookUrl,
    domains,
    hostname: env.MAIL_HOSTNAME?.trim() || hostname(),
    tlsCertFile,
    tlsKeyFile,
    maxMessageBytes: intFrom(
      env,
      "MAX_MESSAGE_BYTES",
      DEFAULT_MAX_MESSAGE_BYTES,
      errors
    ),
    port: intFrom(env, "PORT", 25, errors, 0),
    host: env.HOST?.trim() || "0.0.0.0",
    healthPort: intFrom(env, "HEALTH_PORT", 2526, errors, 0),
    healthHost: env.HEALTH_HOST?.trim() || "127.0.0.1",
    limits: {
      maxConnections: intFrom(env, "MAX_CONNECTIONS", 100, errors),
      maxConnectionsPerIp: intFrom(env, "MAX_CONNECTIONS_PER_IP", 10, errors),
      connectionsPerIpPerMinute: intFrom(
        env,
        "CONNECTIONS_PER_IP_PER_MINUTE",
        60,
        errors
      ),
      messagesPerIpPerMinute: intFrom(
        env,
        "MESSAGES_PER_IP_PER_MINUTE",
        30,
        errors
      ),
      socketTimeoutMs: intFrom(env, "SOCKET_TIMEOUT_MS", 60_000, errors),
      webhookTimeoutMs: intFrom(env, "WEBHOOK_TIMEOUT_MS", 60_000, errors),
    },
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }
  return config;
}
