// Prisma client without the server-only app singleton. Tests that open a
// throwaway database import this instead of reaching into generated/.
export { PrismaClient } from "./generated/client";
