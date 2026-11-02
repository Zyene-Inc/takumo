import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { log } from "./log.js";
import { pingScanner } from "./scan.js";
import { createMailServer } from "./server.js";
import { CertificateWatcher } from "./tls.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

const mail = createMailServer(config);

let watcher: CertificateWatcher | undefined;
if (config.tlsCertFile && config.tlsKeyFile) {
  watcher = new CertificateWatcher(
    config.tlsCertFile,
    config.tlsKeyFile,
    (pair) => {
      mail.setCertificate(pair);
      log("tls_loaded", { certFile: config.tlsCertFile });
    },
    (message) => log("tls_warning", { message })
  );
  watcher.start();
}

const scan = config.scan;
if (!scan) {
  log("scan_off", {
    message: "CLAMD_HOST is not set: messages are not scanned for malware",
  });
}
const health = createHealthServer(async () => {
  if (!scan) {
    return "off";
  }
  return (await pingScanner(scan)) ? "ok" : "unreachable";
});
health.listen(config.healthPort, config.healthHost);

const port = await mail.listen();
log("started", {
  port,
  hostname: config.hostname,
  domains: config.domains,
  tls: Boolean(watcher?.current),
  maxMessageBytes: config.maxMessageBytes,
  scanner: scan ? `${scan.host}:${scan.port}` : "off",
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  log("stopping", { signal });
  watcher?.stop();
  health.close();
  mail.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
