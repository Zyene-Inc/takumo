import { config, withAnalyzer } from "@repo/next-config";
import { withLogging, withSentry } from "@repo/observability/next-config";
import type { NextConfig } from "next";
import { env } from "@/env";

let nextConfig: NextConfig = withLogging(config);

// Shop spreadsheets are sent to the import server action as rows.
nextConfig = {
  ...nextConfig,
  experimental: {
    ...nextConfig.experimental,
    serverActions: {
      ...nextConfig.experimental?.serverActions,
      bodySizeLimit: "20mb",
    },
  },
};

// Ask Takumo's SQL allowlist (packages/database/sql-allow.ts) parses with
// libpg-query, which loads libpg-query.wasm from its own folder at run time:
// keep it out of the bundle and ship the file with every server route.
nextConfig = {
  ...nextConfig,
  serverExternalPackages: [
    ...(nextConfig.serverExternalPackages ?? []),
    "libpg-query",
  ],
  outputFileTracingIncludes: {
    ...nextConfig.outputFileTracingIncludes,
    "/**/*": ["./node_modules/libpg-query/wasm/libpg-query.wasm"],
  },
};

if (env.VERCEL) {
  nextConfig = withSentry(nextConfig);
}

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

export default nextConfig;
