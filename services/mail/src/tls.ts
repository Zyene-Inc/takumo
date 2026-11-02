// STARTTLS certificate from files that Caddy obtains and renews. The files are
// polled; when they change (or first appear) the new pair is validated and
// handed to the SMTP server without a restart.
import { readFileSync, statSync } from "node:fs";
import { createSecureContext } from "node:tls";

export interface KeyPair {
  cert: Buffer;
  key: Buffer;
}

export class CertificateWatcher {
  private signature = "";
  private timer: NodeJS.Timeout | undefined;
  private readonly certFile: string;
  private readonly keyFile: string;
  private readonly onChange: (pair: KeyPair) => void;
  private readonly onError: (message: string) => void;
  current: KeyPair | null = null;

  constructor(
    certFile: string,
    keyFile: string,
    onChange: (pair: KeyPair) => void,
    onError: (message: string) => void = () => undefined
  ) {
    this.certFile = certFile;
    this.keyFile = keyFile;
    this.onChange = onChange;
    this.onError = onError;
  }

  /** Loads the pair if it changed since the last call; true when it did. */
  check(): boolean {
    let signature: string;
    try {
      const cert = statSync(this.certFile);
      const key = statSync(this.keyFile);
      signature = `${cert.mtimeMs}:${cert.size}:${key.mtimeMs}:${key.size}`;
    } catch {
      if (this.signature !== "missing") {
        this.signature = "missing";
        this.onError(
          `TLS files not readable yet: ${this.certFile}, ${this.keyFile}`
        );
      }
      return false;
    }
    if (signature === this.signature) {
      return false;
    }
    try {
      const pair = {
        cert: readFileSync(this.certFile),
        key: readFileSync(this.keyFile),
      };
      // Throws when the key doesn't match the certificate (eg. half-renewed).
      createSecureContext(pair);
      this.signature = signature;
      this.current = pair;
      this.onChange(pair);
      return true;
    } catch (error) {
      this.onError(
        `TLS files could not be loaded: ${(error as Error).message}`
      );
      return false;
    }
  }

  start(intervalMs = 60_000): void {
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
