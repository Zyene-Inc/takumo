import { createServer, type Server } from "node:http";

/** What the health check reports about malware scanning. */
type ScannerStatus = () => Promise<"off" | "ok" | "unreachable">;

/**
 * GET /health -> {"status":"ok","scanner":"ok|off|unreachable"}; 503 when the
 * scanner is configured but down (mail is then deferred, not lost). Everything
 * else 404.
 */
export function createHealthServer(
  scanner: ScannerStatus = () => Promise.resolve("off")
): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      scanner()
        .catch(() => "unreachable" as const)
        .then((state) => {
          const down = state === "unreachable";
          res.writeHead(down ? 503 : 200, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({ status: down ? "degraded" : "ok", scanner: state })
          );
        });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
}
