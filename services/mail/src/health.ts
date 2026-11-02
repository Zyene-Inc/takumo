import { createServer, type Server } from "node:http";

/** GET /health -> {"status":"ok"}; everything else 404. */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
}
