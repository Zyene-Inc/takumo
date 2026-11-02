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

if (env.VERCEL) {
  nextConfig = withSentry(nextConfig);
}

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

export default nextConfig;
