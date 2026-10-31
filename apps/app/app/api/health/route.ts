import { database } from "@repo/database";
import { keys as engineKeys } from "@repo/engine-client/keys";

// Uptime checks (BetterStack or similar): up or down for each dependency,
// never error details. 503 when the database is down; the engine and the
// Ask reader only make the status "degraded".
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3000;

const timed = async (check: () => Promise<unknown>) => {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
};

export const GET = async () => {
  const { ENGINE_URL } = engineKeys();
  const [db, engine, reader] = await Promise.all([
    timed(() => database.$queryRaw`select 1`),
    timed(async () => {
      if (!ENGINE_URL) {
        throw new Error("no engine");
      }
      const r = await fetch(new URL("/health", ENGINE_URL), {
        cache: "no-store",
      });
      if (!r.ok) {
        throw new Error("engine down");
      }
    }),
    timed(() =>
      process.env.ASK_DATABASE_URL ? Promise.resolve() : Promise.reject()
    ),
  ]);
  let status = "down";
  if (db) {
    status = engine && reader ? "ok" : "degraded";
  }
  return Response.json(
    {
      status,
      checks: { database: db, engine, ask_reader_configured: reader },
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
};
