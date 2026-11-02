import { defaults, type Options } from "@nosecone/next";

export { createMiddleware as securityMiddleware } from "@nosecone/next";

// Nosecone security headers configuration
// https://docs.arcjet.com/nosecone/quick-start
export const noseconeOptions: Options = {
  ...defaults,
  // Content Security Policy (CSP) is off here: the pages that need one (file
  // downloads) set their own.
  contentSecurityPolicy: false,
};
