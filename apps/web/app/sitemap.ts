import type { MetadataRoute } from "next";
import { env } from "@/env";

const protocol = env.VERCEL_PROJECT_PRODUCTION_URL?.startsWith("https")
  ? "https"
  : "http";
const url = new URL(`${protocol}://${env.VERCEL_PROJECT_PRODUCTION_URL}`);

const sitemap = (): MetadataRoute.Sitemap => [
  {
    url: new URL("/", url).href,
    lastModified: new Date(),
  },
  {
    url: new URL("/pricing", url).href,
    lastModified: new Date(),
  },
];

export default sitemap;
