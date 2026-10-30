import path from "node:path";
import { defineConfig } from "vitest/config";

// Ask Takumo evals: real model, real database (the demo shop), real engine.
// Run with `pnpm --filter app eval` (see evals/README.md).
export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["evals/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // The model is rate-limited; a few questions at a time.
    maxConcurrency: 4,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(import.meta.dirname, "evals/server-only.ts"),
      "@": path.resolve(import.meta.dirname, "./"),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
    },
  },
});
