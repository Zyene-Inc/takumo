import { database } from "@repo/database";

export const GET = async () => {
  await database.$queryRaw`SELECT 1`;

  return new Response("OK", { status: 200 });
};
